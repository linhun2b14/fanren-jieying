'use strict';
// 弃牌堆查看器专项：
//   ① 每张牌**详细展示**（角标法力 / 牌名 / 牌堆·类型 / 境界或占位 / 完整卡文），而不是一个光秃秃的名字药丸
//   ② 同名牌合并成一条并用 ×N 标出张数（弃牌堆里【稀薄灵气】能有十几张）
//   ③ **只有一层滚动条**：窗口固定高度、正文自己滚（以前 .modal 和 .discard-body 各滚一层，很怪）
//   ④ 真实内容与 /api/cards 对得上
//
// ⚠️ "内容够多"必须由测试**自己保证**，不能看运气：早先只弃当前行动方的手牌，
//    丢 5 张会溢出、丢 4 张不会 —— 于是同一条断言一会儿过一会儿不过。
//    现在让**两个玩家都把手里所有的牌丢光**（弃置跟阶段/回合无关），内容稳定够撑出滚动条。
const { launch, newPage, sleep } = require('./cdp');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';
const OUT = require('path').join(__dirname, ('..'), 'ref', 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

const setVal = (s, v) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return 'NOELEM';
  e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`;
const click = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return 'NOELEM';
  if(e.disabled) return 'DISABLED'; e.click(); return 'ok'; })()`;
const text = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); return e?e.textContent.trim():null; })()`;
const clickBtn = (re) => `(() => { const b=[...document.querySelectorAll('#action-bar button')].find(x=>new RegExp(${JSON.stringify(re)}).test(x.textContent)&&!x.disabled);
  if(!b) return null; b.click(); return b.textContent.trim(); })()`;
const handCount = `document.querySelectorAll('#hand-zone .hand-card').length`;

/** 推进到行动阶段：炼化 → 探索 → 抉择 */
async function advanceToAction(p, tag) {
  for (const re of ['灵气', '宝物']) {
    const got = await p.evaluate(clickBtn(re));
    console.log(`    [${tag}] 点击「${re}」→`, JSON.stringify(got));
    await sleep(1000);
  }
  const picked = (await p.evaluate(clickBtn('同行者'))) || (await p.evaluate(clickBtn('法术')));
  console.log(`    [${tag}] 抉择 →`, JSON.stringify(picked));
  await sleep(1200);
}

/**
 * 结束当前回合。若弹出「手牌超上限」就把该弃的都弃掉（这是现在**唯一**的弃牌途径之一，
 * 另一个是卡片效果 —— 用户裁定已移除"主动弃置手牌"）。返回本次弃了几张。
 */
async function endTurnAndDiscard(p, tag) {
  await p.evaluate(clickBtn('结束回合'));
  await sleep(1200);
  let n = 0;
  // ⚠️ 必须用 .hand-card 计数/点击 —— 手牌空了以后 #hand-zone 里会放一个 .empty-hand 占位元素，
  //    用 `#hand-zone > *` 会一直点到那个占位符（踩过）。
  for (let i = 0; i < 12; i++) {
    const bt = await p.evaluate(barText);
    if (!/手牌超过上限/.test(bt)) break;
    await p.evaluate(`(() => { const c=document.querySelector('#hand-zone .hand-card'); if(c) c.click(); return 'ok'; })()`);
    await sleep(650);
    n++;
  }
  if (n) console.log(`    [${tag}] 回合结束判定 → 弃置 ${n} 张`);
  await sleep(700);
  return n;
}

const isTurn = (p) => p.evaluate(`/轮到你/.test(((document.querySelector('#tb-turn')||{}).textContent||''))`);
const barText = `(document.querySelector('#action-bar')||{}).textContent || ''`;

(async () => {
  const b1 = await launch({ port: 9431 });
  const b2 = await launch({ port: 9432 });
  const host = await newPage(b1, BASE + '/');
  const guest = await newPage(b2, BASE + '/');
  await sleep(1400);
  await host.evaluate(setVal('#input-name', '韩立'));
  await host.evaluate(click('#btn-create'));
  await sleep(1100);
  const code = String(await host.evaluate(text('#room-code'))).trim();
  await guest.evaluate(setVal('#input-name', '南宫婉'));
  await guest.evaluate(setVal('#input-room', code));
  await guest.evaluate(click('#btn-join'));
  await sleep(1200);
  await host.evaluate(click('#btn-start'));
  await sleep(2200);
  console.log('房间', code, '已开局');

  let me = null, other = null, tag = '';
  for (const [p, n] of [[host, '房主'], [guest, '客人']]) {
    const t = await p.evaluate(`(() => (document.querySelector('#tb-turn')||{}).textContent || '')()`);
    if (/轮到你/.test(t)) { me = p; tag = n; } else { other = p; }
  }
  if (!me) throw new Error('找不到当前行动方');
  console.log('当前行动方:', tag);

  // 用户裁定（2026-10-02）移除了"主动弃置手牌"，所以弃牌堆内容只能靠：
  //   ① 卡片效果  ② 回合结束的超上限判定
  // 这里走 ②：双方轮流"只抽不主动丢"，手牌每回合 +3，很快就超上限，回合结束判定会把牌打进弃牌堆。
  let d1 = 0, d2 = 0;
  for (let turn = 1; turn <= 12 && d1 + d2 < 10; turn++) {
    let p = null, tg = '';
    for (const [q, n] of [[host, '房主'], [guest, '客人']]) if (await isTurn(q)) { p = q; tg = n; }
    if (!p) break;
    await advanceToAction(p, tg);
    const got = await endTurnAndDiscard(p, tg);
    if (tg === '房主') d1 += got; else d2 += got;
  }
  console.log(`  累计通过"回合结束判定"打进弃牌堆 ${d1 + d2} 张`);
  check('回合结束判定确实往弃牌堆里打进了牌（新的唯一途径之一）', d1 + d2 >= 2, `${d1 + d2}`);

  // 打开弃牌堆
  await me.evaluate(click('#btn-view-discard'));
  await sleep(1200);

  const view = await me.evaluate(`(() => {
    const ov = document.querySelector('#discard-modal');
    const body = document.querySelector('#discard-body');
    const modal = ov ? ov.querySelector('.modal') : null;
    if (!ov || ov.classList.contains('hidden')) return { open: false };
    const cards = [...document.querySelectorAll('#discard-body .discard-card')].map(c => ({
      name: (c.querySelector('.dc-name')||{}).textContent || null,
      cost: (c.querySelector('.dc-cost')||{}).textContent || null,
      tag:  (c.querySelector('.dc-tag')||{}).textContent || null,
      sub:  (c.querySelector('.dc-sub')||{}).textContent || null,
      eff:  (c.querySelector('.dc-text')||{}).textContent || null,
      num:  (c.querySelector('.dc-num')||{}).textContent || null,
    }));
    const groups = [...document.querySelectorAll('#discard-body .discard-group h4')].map(h => h.textContent.replace(/\\s+/g,' ').trim());
    return {
      open: true, groups: groups, cards: cards,
      modalOverflow: modal ? getComputedStyle(modal).overflowY : null,
      bodyOverflow: body ? getComputedStyle(body).overflowY : null,
      bodyScrollH: body ? body.scrollHeight : 0,
      bodyClientH: body ? body.clientHeight : 0,
    };
  })()`);

  check('弃牌堆窗口能打开', view.open === true, JSON.stringify(view).slice(0, 160));

  if (view.open) {
    check('有牌时按牌堆分组显示', view.groups.length >= 1 && /牌堆弃牌/.test(view.groups.join(' ')), JSON.stringify(view.groups));
    check('弃牌堆里确实有牌', view.cards.length >= 2, JSON.stringify({ 丢了: d1 + d2, 渲染: view.cards.length }));

    const c0 = view.cards[0] || {};
    check('详细卡有牌名', !!c0.name && c0.name.length > 0, JSON.stringify(c0.name));
    check('详细卡有角标法力', !!c0.cost, JSON.stringify(c0.cost));
    check('详细卡有"牌堆 · 类型"标签', !!c0.tag && /·/.test(c0.tag), JSON.stringify(c0.tag));
    check('详细卡有境界/占位说明', !!c0.sub, JSON.stringify(c0.sub));
    check('详细卡有完整卡文（这才是"像手牌一样详细"）', !!c0.eff && c0.eff.length > 4, JSON.stringify(c0.eff).slice(0, 80));

    // 和 /api/cards 对账：渲染出来的卡文必须与卡池一致
    const pool = await me.evaluate(`(async () => {
      const r = await fetch('/api/cards'); const j = await r.json();
      const all = [].concat(j.treasure||[], j.spell||[], j.companion||[], j.qi||[]);
      const d = all.find(x => x.name === ${JSON.stringify(c0.name || '')});
      return d ? { text: d.text || '' } : null;
    })()`);
    check('渲染的卡文与 /api/cards 一致', !!pool && pool.text === c0.eff,
      JSON.stringify({ 池: pool && pool.text, 页: c0.eff }).slice(0, 200));

    // 同名牌合并：出现 ×N 就必须是"张数 ≥ 2"
    const nums = view.cards.map((c) => c.num).filter(Boolean);
    check('同名牌用 ×N 标张数（×N 里的 N 必须 ≥ 2）',
      nums.every((n) => /^×\d+$/.test(n) && Number(n.slice(1)) >= 2), JSON.stringify(nums));
    check('合并后条数不多于实际张数（合并确实在起作用）',
      view.cards.length <= d1 + d2, JSON.stringify({ 条数: view.cards.length, 张数: d1 + d2 }));

    // 只有一层滚动条
    check('窗口自身不再滚动（overflow-y: hidden）', view.modalOverflow === 'hidden', String(view.modalOverflow));
    check('正文才是唯一的滚动层（overflow-y: auto）', view.bodyOverflow === 'auto', String(view.bodyOverflow));

    // 手机视口：内容必须超出、滚动条必须能滚
    await me.setViewport(390, 844, true);
    await sleep(700);
    const mob = await me.evaluate(`(() => {
      const body = document.querySelector('#discard-body');
      const before = body.scrollTop;
      body.scrollTop = 9999;
      const after = body.scrollTop;
      const modal = document.querySelector('#discard-modal .modal');
      const r = modal.getBoundingClientRect();
      return { scrollH: body.scrollHeight, clientH: body.clientHeight, before: before, after: after,
        modalH: Math.round(r.height), winH: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth + 2 };
    })()`);
    console.log('  手机视口下:', JSON.stringify(mob));
    check('手机视口下内容超出窗口（所以需要滚动条）', mob.scrollH > mob.clientH, JSON.stringify(mob));
    check('滚动条真的能滚（scrollTop 变化）', mob.after > mob.before, JSON.stringify(mob));
    check('窗口高度不超过视口', mob.modalH <= mob.winH + 2, JSON.stringify(mob));
    check('不产生横向溢出', mob.overflowX === false, String(mob.overflowX));
    await me.screenshot(OUT + '\\ui-discard-mobile.png');

    await me.setViewport(1280, 900, true);
    await sleep(600);
    await me.screenshot(OUT + '\\ui-discard-desktop.png');
  }

  const errs = [...host.pageErrors, ...guest.pageErrors];
  console.log('\n页面异常:', errs.length);
  errs.slice(0, 3).forEach((e) => console.log('  ! ' + String(e).split('\n')[0]));
  check('全程无页面异常', errs.length === 0, errs.slice(0, 2).map(String).join(' | '));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await b1.close(); await b2.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nDISCARD UI FAIL:', e.message); process.exit(1); });
