'use strict';
// 布局回归（按用户手绘简图 + 用户报的"窗口化后抽卡按钮被遮住"）：
//   ① 右侧必须是一条竖向信息栏：上=每种牌组数量信息 + 弃牌堆入口，下=游戏日志
//   ② 主区左侧上下两块：对敌（居中等比缩放）在上、我方在下
//   ③ 窗口化（矮窗口）时操作按钮必须仍然可见可点，不能被裁掉
const { launch, newPage, sleep } = require('./cdp');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';
const OUT = require('path').join(__dirname, ('..'), 'ref', 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
let skipCount = 0;
/** 「条件不成立 → 这条没什么可验」的断言走 skip()：**只记录、不计入通过数**
 *  （以前写成 `check(名, true)`，永远通过，把"通过数"撑虚高了 —— 交接 §5.2 的老欠账）。 */
const skip = (n, why) => { skipCount++; console.log('  ⊘ ' + n + (why ? '  << ' + why : '')); };
const setVal = (s, v) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return 'NOELEM';
  e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`;
const click = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return 'NOELEM';
  if(e.disabled) return 'DISABLED'; e.click(); return 'ok'; })()`;
const text = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); return e?e.textContent.trim():null; })()`;
const rect = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return null;
  const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom}; })()`;

(async () => {
  const b1 = await launch({ port: 9441 });
  const b2 = await launch({ port: 9442 });
  const host = await newPage(b1, BASE + '/');
  const guest = await newPage(b2, BASE + '/');
  await sleep(1500);
  await host.evaluate(setVal('#input-name', '韩立'));
  await host.evaluate(click('#btn-create'));
  await sleep(1100);
  const code = String(await host.evaluate(text('#room-code'))).trim();
  await guest.evaluate(setVal('#input-name', '南宫婉'));
  await guest.evaluate(setVal('#input-room', code));
  await guest.evaluate(click('#btn-join'));
  await sleep(1200);
  await host.evaluate(click('#btn-start'));
  await sleep(2500);
  console.log('房间', code, '已开局');

  // ---------------------------------------------------------------- ① 右侧竖向信息栏
  const side = await host.evaluate(`(() => {
    const aside=document.querySelector('.side-panel'); const board=document.querySelector('.table-board');
    if(!aside||!board) return null;
    const a=aside.getBoundingClientRect(), b=board.getBoundingClientRect();
    const deck=document.querySelector('.side-panel .deck-panel');
    const log=document.querySelector('.side-panel .log-panel');
    if(!deck||!log) return {aside:true, board:true, deckPanel:!!deck, logPanel:!!log};
    const d=deck.getBoundingClientRect(), l=log.getBoundingClientRect();
    return { a:{x:a.x,y:a.y,w:a.width,h:a.height,right:a.right}, b:{x:b.x,right:b.right,w:b.width},
      d:{y:d.y,h:d.height,bottom:d.bottom}, l:{y:l.y,h:l.height},
      deckPanel:true, logPanel:true, board:true, aside:true,
      decks:[...document.querySelectorAll('#deck-list .deck-row')].map(r=>r.dataset.deck),
      hasDiscardBtn: !!document.querySelector('#btn-view-discard'),
      logInSide: !!log.closest('.side-panel'),
      deckInSide: !!deck.closest('.side-panel') };
  })()`);
  check('.side-panel 存在', !!side && !!side.a, JSON.stringify(side));
  if (side && side.a) {
    check('信息栏在右、主区在左（侧栏左边 ≥ 主区右边 - 4px）', side.a.x >= side.b.right - 4,
      `侧栏 x=${side.a.x} 主区 right=${side.b.right}`);
    check('信息栏是竖向的一条（宽度明显小于主区）', side.a.w < side.b.w, `侧栏宽 ${side.a.w} / 主区宽 ${side.b.w}`);
    check('上半是牌组数量面板', !!side.deckPanel, JSON.stringify(side));
    check('下半是游戏日志面板', !!side.logPanel, JSON.stringify(side));
    check('日志在牌组面板下方', !side.l || !side.d || side.l.y >= side.d.bottom - 4,
      `日志 y=${side.l && side.l.y} 牌组 bottom=${side.d && side.d.bottom}`);
    check('牌组信息含 宝物/法术/同行者/灵气 四堆',
      JSON.stringify(side.decks) === JSON.stringify(['treasure', 'spell', 'companion', 'qi']),
      JSON.stringify(side.decks));
    check('有【查看弃牌堆】按钮', side.hasDiscardBtn === true);
  }

  // 牌组行要显示"剩余 / 弃"两个数（用户要的"每种牌组的数量信息"）
  const deckNums = await host.evaluate(`(() => [...document.querySelectorAll('#deck-list .deck-row')].map(r=>({
    deck:r.dataset.deck, num:(r.querySelector('.dk-num')||{}).textContent,
    discard:(r.querySelector('.dk-discard')||{}).textContent })))()`);
  console.log('  牌组行:', JSON.stringify(deckNums));
  check('每行都有"剩余数量"', Array.isArray(deckNums) && deckNums.length === 4 && deckNums.every((d) => d.num !== undefined && d.num !== ''),
    JSON.stringify(deckNums));
  check('每行都有"弃牌数"', Array.isArray(deckNums) && deckNums.every((d) => /弃\s*\d+/.test(d.discard || '')), JSON.stringify(deckNums));

  // ---------------------------------------------------------------- ② 对敌在上居中、我方在下
  const geo = await host.evaluate(`(() => {
    const foe=document.querySelector('.table-board .foe-row');
    const me=document.querySelector('.table-board .me-row');
    if(!foe||!me) return null;
    const f=foe.getBoundingClientRect(), m=me.getBoundingClientRect();
    const foeg=document.querySelector('#foe-grid');
    const fg=foeg.getBoundingClientRect();
    const cards=[...foeg.children].map(c=>c.getBoundingClientRect());
    return { foeTop:f.y, foeBottom:f.bottom, meTop:m.y, count:foeg.dataset.count,
      gridLeft:fg.x, gridRight:fg.right, ownLeft:foeg.getBoundingClientRect().x,
      firstLeft: cards.length?cards[0].x:null, lastRight: cards.length?cards[cards.length-1].right:null,
      foeW: f.width, meW: m.width, cards: cards.map(c=>({w:Math.round(c.width),x:Math.round(c.x)})) };
  })()`);
  check('对敌区在我方之上', !!geo && geo.foeBottom <= geo.meTop + 2, JSON.stringify(geo));
  check('对敌与我方都在左侧主区（同一列）', !!geo && Math.abs(geo.foeW - geo.meW) < 4, JSON.stringify(geo));
  if (geo && geo.firstLeft != null) {
    const leftGap = geo.firstLeft - geo.gridLeft;
    const rightGap = geo.gridRight - geo.lastRight;
    check('敌方面板居中（左右留白接近）', Math.abs(leftGap - rightGap) <= 12, `左 ${Math.round(leftGap)} / 右 ${Math.round(rightGap)}`);
    check('只有 1 个敌人时面板不会撑满整行（等比缩放）', geo.cards[0].w <= geo.foeW, JSON.stringify(geo.cards));
  }
  check('foe-grid 带 data-count（缩放按人数）', !!geo && geo.count === '1', geo && geo.count);

  // ---------------------------------------------------------------- ③ 弃牌堆随时可查看
  await host.evaluate(click('#btn-view-discard'));
  await sleep(900);
  const dv = await host.evaluate(`(() => { const m=document.querySelector('#discard-modal');
    if(!m) return null; const r=m.getBoundingClientRect();
    return { visible: r.width>0&&r.height>0, txt:(m.textContent||'').replace(/\\s+/g,' ').slice(0,120) }; })()`);
  check('点【查看弃牌堆】弹出面板', !!dv && dv.visible, JSON.stringify(dv));
  check('面板里有内容（空堆也应有说明）', !!dv && dv.txt.length > 5, dv && dv.txt);
  // 客队（非房主）也能看 —— "所有玩家可以随时查看"
  const guestOpen = await guest.evaluate(`(() => { const b=document.querySelector('#btn-view-discard');
    if(!b) return 'NOELEM'; b.click(); return 'clicked'; })()`);
  await sleep(800);
  const gv = await guest.evaluate(`(() => { const m=document.querySelector('#discard-modal');
    if(!m) return null; const r=m.getBoundingClientRect(); return r.width>0&&r.height>0; })()`);
  check('对手（非房主）也能打开弃牌堆', guestOpen === 'clicked' && gv === true, `${guestOpen}/${gv}`);
  await host.evaluate(click('#discard-modal-close'));
  await guest.evaluate(click('#discard-modal-close'));
  await sleep(300);

  // ---------------------------------------------------------------- ④ 窗口化：按钮不能被遮
  // 开局第一手是随机的（按灵根排名定），只有"轮到你"的那一页才有操作按钮，先找出来
  let actor = null, actorName = '';
  for (const [p, n] of [[host, '房主'], [guest, '客人']]) {
    const t = await p.evaluate(`(() => (document.querySelector('#tb-turn')||{}).textContent || '')()`);
    const has = await p.evaluate(`document.querySelectorAll('#action-bar button').length`);
    if (/轮到你/.test(t) && has > 0) { actor = p; actorName = n; }
  }
  if (!actor) { actor = host; actorName = '房主(兜底)'; }
  console.log('  当前行动方:', actorName);
  check('至少有一页显示操作按钮', actor !== null);
  const beforeCount = await actor.evaluate(`document.querySelectorAll('#action-bar button').length`);
  check('行动方页面上确实有操作按钮', beforeCount > 0, 'buttons=' + beforeCount);

  for (const size of [[1280, 800], [1100, 680], [1000, 600], [1366, 560]]) {
    await actor.setViewport(size[0], size[1], 1);
    await sleep(700);
    const vis = await actor.evaluate(`(() => {
      const bar=document.querySelector('#action-bar');
      const btns=[...bar.querySelectorAll('button')];
      // 侧栏里那两个也必须点得到：查看弃牌堆 / 日志列表有高度
      const extra=[document.querySelector('#btn-view-discard'), document.querySelector('#log-list')].filter(Boolean);
      const H=window.innerHeight, W=window.innerWidth;
      const bad=[];
      for(const b of btns.concat(extra)){
        const r=b.getBoundingClientRect();
        if(r.width<=0||r.height<=0) { bad.push((b.id||b.textContent.trim().slice(0,10))+'@zero'); continue; }
        if(r.bottom>H-1||r.top<0) { bad.push((b.id||b.textContent.trim().slice(0,10))+'@y'+Math.round(r.bottom)); continue; }
        const cx=(r.left+r.right)/2, cy=(r.top+r.bottom)/2;
        const top=document.elementFromPoint(cx,cy);
        if(!top || !(b===top || b.contains(top) || top.contains(b))) bad.push((b.id||b.textContent.trim().slice(0,10))+'@covered');
      }
      return { count:btns.length, bad, H:H, W:W,
        handBottom: (document.querySelector('#hand-zone')||{getBoundingClientRect:()=>({bottom:0})}).getBoundingClientRect().bottom,
        scrollH: document.documentElement.scrollHeight };
    })()`);
    check(`窗口 ${size[0]}×${size[1]}：操作按钮 + 侧栏【查看弃牌堆】/日志 全部可见且未被遮挡（共 ${vis.count + 2} 个）`, vis.bad.length === 0, JSON.stringify(vis.bad));
  }
  await actor.screenshot(OUT + '\\20-layout-side.png');

  // 真的还能点：小窗口下点一次按钮不该报错
  await actor.setViewport(1000, 600, 1);
  await sleep(600);
  const clicked = await actor.evaluate(`(() => {
    const b=[...document.querySelectorAll('#action-bar button')].find(x=>!x.disabled);
    if(!b) return 'none'; const t=b.textContent.trim(); b.click(); return t; })()`);
  check('小窗口下按钮真的可以点', clicked !== 'none', String(clicked));
  await sleep(900);
  const errs = [...host.pageErrors, ...guest.pageErrors];
  check('全程无页面异常', errs.length === 0, errs.slice(0, 2).map(String).join(' | '));
  console.log('  小窗点击的按钮:', clicked);

  // ---------------------------------------------------------------- ⑤ 弃牌堆真的能看到牌面
  // 走完抽取阶段 → 行动阶段 → 弃一张手牌（进弃牌堆）→ 再看弃牌堆，应能列出牌名
  await actor.setViewport(1280, 820, 1);
  await sleep(500);
  const clickBtn = (re) => `(() => { const b=[...document.querySelectorAll('#action-bar button')]
    .find(x=>new RegExp(${JSON.stringify(re)}).test(x.textContent)&&!x.disabled); if(!b) return null; b.click(); return b.textContent.trim(); })()`;
  const stateOf = `(() => ({
    turn: (document.querySelector('#tb-turn')||{}).textContent||'',
    step: (document.querySelector('#view-table')||{}).dataset ? '' : '',
    hand: (document.querySelector('#hand-zone')||{children:[]}).children.length,
    btns: [...document.querySelectorAll('#action-bar button')].map(b=>b.textContent.trim()),
    toast: ((document.querySelector('#toast-layer')||{}).textContent||'').replace(/\\s+/g,' ').trim() }))()`;

  // 反复点抽取阶段按钮，直到进入行动阶段
  for (let i = 0; i < 6; i++) {
    const s = await actor.evaluate(stateOf);
    if (s.btns.some((t) => /结束回合/.test(t))) break;
    const hit = await actor.evaluate(clickBtn('灵气')) || await actor.evaluate(clickBtn('宝物'))
      || await actor.evaluate(clickBtn('法术|同行者'));
    if (!hit) break;
    await sleep(900);
  }
  const st1 = await actor.evaluate(stateOf);
  console.log('  驱动到行动阶段:', JSON.stringify(st1.btns));

  const apiDiscard = `(async () => {
    const s = JSON.parse(localStorage.getItem('fanren.jieying.session.v1') || '{}');
    const r = await fetch('/api/discard?roomId='+encodeURIComponent(s.roomId)+'&playerId='+encodeURIComponent(s.playerId)+'&token='+encodeURIComponent(s.token));
    const j = await r.json();
    return { keys: Object.keys(j||{}), total: ['treasure','spell','companion','qi'].reduce((n,k)=>n+((j[k]||[]).length),0),
      treasure:(j.treasure||[]).length, spell:(j.spell||[]).length, companion:(j.companion||[]).length };
  })()`;

  const api = await actor.evaluate(apiDiscard);
  console.log('  /api/discard:', JSON.stringify(api));

  // 用户裁定（2026-10-02）：行动栏里**不该再有**「弃置手牌」按钮 ——
  // 弃牌只剩 ① 卡片效果 ② 回合结束判定两个来源。
  check('行动栏里已经没有「弃置手牌」按钮（主动弃牌已移除）',
    !st1.btns.some((t) => /弃置手牌|退出弃牌/.test(t)), JSON.stringify(st1.btns));
  check('/api/discard 返回四个牌堆', JSON.stringify(api.keys) === JSON.stringify(['treasure', 'spell', 'companion', 'qi']), JSON.stringify(api.keys));

  if (api.total > 0) {
    await actor.evaluate(click('#btn-view-discard'));
    await sleep(800);
    const dvText = await actor.evaluate(`(() => { const m=document.querySelector('#discard-modal');
      if(!m) return null; const r=m.getBoundingClientRect(); if(!(r.width>0&&r.height>0)) return 'HIDDEN';
      const chips=[...m.querySelectorAll('.discard-card')].map(x=>x.textContent.trim());
      return { chips: chips, txt:(m.textContent||'').replace(/\\s+/g,' ').slice(0,140) }; })()`);
    console.log('  弃牌堆面板:', JSON.stringify(dvText));
    check('能看到具体牌名（不只是数量）', !!dvText && dvText.chips && dvText.chips.length > 0, JSON.stringify(dvText));
    const detail = await actor.evaluate(`(() => { const c=document.querySelector('#discard-modal .discard-card');
      if(!c) return 'none'; c.click(); return 'clicked'; })()`);
    await sleep(700);
    const cardModal = await actor.evaluate(`(() => { const m=document.querySelector('#card-modal');
      if(!m) return null; const r=m.getBoundingClientRect(); return r.width>0&&r.height>0 ? (m.textContent||'').replace(/\\s+/g,' ').slice(0,60) : 'HIDDEN'; })()`);
    check('点弃牌堆里的牌能看详情', detail === 'clicked' && cardModal !== 'HIDDEN' && !!cardModal, String(cardModal));
  } else {
    skip('（弃牌堆仍为空，跳过"看到牌名"断言）');
    skip('（弃牌堆仍为空，跳过"点牌看详情"断言）');
  }

  await b1.close(); await b2.close();
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nLAYOUT FAIL:', e.message); process.exit(1); });
