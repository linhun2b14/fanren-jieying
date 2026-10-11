'use strict';
// 验证对战覆盖层与结算动画 + 手机端渲染。
const { launch, newPage, sleep } = require('./cdp');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';
const OUT = require('path').join(__dirname, ('..'), 'ref', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const setVal = (sel, v) => `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'NOELEM';
  e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`;
const click = (sel) => `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'NOELEM';
  if(e.disabled) return 'DISABLED'; e.click(); return 'ok'; })()`;
const text = (sel) => `(() => { const e=document.querySelector(${JSON.stringify(sel)}); return e?e.textContent.trim():null; })()`;
const btns = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)} + ' button')].map(b=>({t:b.textContent.replace(/\\s+/g,' ').trim(), dis:b.disabled}))`;

/** 从回合开始一路点到行动阶段（现在是三段式手动抽取） */
async function toActionPhase(page) {
  for (let i = 0; i < 8; i++) {
    const btns = await page.evaluate(`[...document.querySelectorAll('#action-bar button')].map(b=>({t:b.textContent.replace(/\\s+/g,''),dis:b.disabled}))`);
    if (btns.some((b) => /发起对战/.test(b.t))) return btns;
    const pick = btns.find((b) => !b.dis && /炼化灵气|探索|法术牌|同行者/.test(b.t));
    if (!pick) return btns;
    await page.evaluate(`(() => { const b=[...document.querySelectorAll('#action-bar button')].find(x=>!x.disabled && /炼化灵气|探索|法术牌|同行者/.test(x.textContent.replace(/\\s+/g,''))); if(b) b.click(); })()`);
    await sleep(900);
  }
  return [];
}

/** 结束当前行动方的回合（先推进到行动阶段再点"结束回合"） */
async function passTurn(page) {
  await toActionPhase(page);
  await page.evaluate(`(() => { const b=[...document.querySelectorAll('#action-bar button')]
    .find(x=>!x.disabled && /结束回合/.test(x.textContent)); if(b) b.click(); })()`);
  await sleep(1200);
}

/**
 * 处理【斗法】弹窗（代码里叫"时点询问/打断窗口"）：轮到谁表态，谁就点「不破招·跳过」。
 * 打断层上线后，发起对战/出牌/挨打都可能弹出这个窗（取决于随机手牌里有没有
 * 低境界装备、【温天仁】【遮天钟】之类），不处理它的话面板会一直停在旧状态。
 * 返回这轮一共跳过了几次，便于日志观察。
 * ⚠️ 顺手核对**改名后的玩家可见文案**（2026-10-02：系统「斗法」/ 响应「破招」）——
 *    文案错了直接抛，避免改名只改了代码没改到 UI。
 */
async function flushPending(host, guest) {
  let n = 0;
  const empties = [];
  const noEff = [];
  const badNaming = [];
  for (let i = 0; i < 8; i++) {
    let acted = false;
    for (const p of [host, guest]) {
      const st = await p.evaluate(`(() => {
        const ov = document.querySelector('#pending-modal');
        if (!ov || ov.classList.contains('hidden')) return null;
        const b = document.querySelector('#btn-pending-pass');
        const list = document.querySelector('#pending-list');
        return { visible: true, canPass: !!(b && !b.disabled), sub: (document.querySelector('#pending-sub')||{}).textContent,
          title: (document.querySelector('#pending-title')||{}).textContent,
          passText: b ? b.textContent.replace(/\\s+/g,' ').trim() : null,
          listCount: list ? list.children.length : -1,
          effCount: list ? list.querySelectorAll('.to-eff').length : 0,
          listText: list ? list.textContent.replace(/\\s+/g,' ').trim().slice(0, 120) : '' };
      })()`);
      if (!st || !st.visible) continue;
      // 玩家可见文案：标题任何时候都写「斗法 · 破 招」；
      // 跳过按钮**只在轮到我时**才叫「不破招 · 跳过」（不是我的时候显示「等 待 中」）—— 2026-10-02 实测踩到。
      if (!/斗\s*法/.test(st.title || '') || !/破\s*招/.test(st.title || '')) badNaming.push('标题=' + st.title);
      if (st.canPass && !/不\s*破\s*招/.test(st.passText || '')) badNaming.push('跳过按钮=' + st.passText);
      // 轮到我表态，队列里必然至少有一条候选（引擎保证：窗口只开给"真的有牌可响应"的人）。
      // 一个子节点都没有 = 前端渲染中途抛异常了（曾因 cardById 未定义炸过一整版候选按钮）。
      if (st.canPass && st.listCount === 0) empties.push(st.listText || '(空)');
      // 每条候选都要带上卡文（.to-eff），否则等于让人"凭牌名猜效果"
      if (st.canPass && st.listCount > 0 && st.effCount === 0) noEff.push(st.listText || '(无卡文)');
      if (!st.canPass) continue;              // 不是我在表态
      await p.evaluate(click('#btn-pending-pass'));
      await sleep(700);
      acted = true; n++;
      break;
    }
    if (!acted) break;
  }
  if (badNaming.length) {
    throw new Error(`【斗法】弹窗文案不对（应写「斗法 · 破招」/「不破招 · 跳过」）：${badNaming[0]}`);
  }
  if (empties.length) {
    throw new Error(`斗法弹窗轮到表态时一个候选按钮都没渲染出来（候选区内容："${empties[0]}"）`);
  }
  if (noEff.length) {
    throw new Error(`斗法弹窗的候选牌没渲染卡文（.to-eff 缺失，候选区内容："${noEff[0]}"）`);
  }
  return n;
}

async function setup(portA, portB) {
  const b1 = await launch({ port: portA });
  const b2 = await launch({ port: portB });
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
  await sleep(1300);
  await host.evaluate(click('#btn-start'));
  await sleep(2200);
  return { b1, b2, host, guest, code };
}

/** 当前该行动的那个页面 */
async function actorPage(host, guest) {
  for (const p of [host, guest]) {
    const t = await p.evaluate(`(() => { const el=document.querySelector('#tb-turn'); return el?el.textContent:''; })()`);
    if (/轮到你/.test(t)) return { page: p, turnText: t };
  }
  return { page: null, turnText: '(都轮不到)' };
}

(async () => {
  const { b1, b2, host, guest, code } = await setup(9351, 9352);
  console.log('房间', code, '已开局');

  let a = await actorPage(host, guest);
  console.log('当前行动方:', a.turnText);
  let me = a.page;
  if (!me) throw new Error('找不到当前行动方');

  // 规则：每个人的第一个回合不能发起对战 —— 过回合直到"发起对战"按钮真的可用为止。
  // （原来是固定过 2 次，但浏览器时序不稳，偶尔会因为某次"结束回合"没点上而少过一轮；
  //   这里改成看结果：按钮可用就停，最多过 4 次。）
  let combatReady = false;
  for (let i = 0; i < 4 && !combatReady; i++) {
    const cur = await actorPage(host, guest);
    if (!cur.page) throw new Error('过回合时找不到当前行动方');
    const btnsNow = await toActionPhase(cur.page);
    combatReady = btnsNow.some((b) => /发起对战/.test(b.t) && !b.dis);
    console.log(`  过回合（${i + 1}）: ${cur.turnText} → 发起对战可用=${combatReady}`);
    if (combatReady) { me = cur.page; break; }
    await passTurn(cur.page);
  }
  if (!combatReady) throw new Error('过了 4 个回合，"发起对战"按钮仍不可用');
  a = await actorPage(host, guest);
  console.log('回到行动方:', a.turnText);
  me = me || a.page;
  if (!me) throw new Error('过完一回合后找不到当前行动方');

  // 抽牌阶段 → 进入行动阶段（三段式：先灵气、再宝物、再二选一）
  const drawBtns = await me.evaluate(btns('#action-bar'));
  console.log('抽取阶段按钮:', JSON.stringify(drawBtns));
  const actBtns = await toActionPhase(me);
  console.log('行动阶段按钮:', JSON.stringify(actBtns));

  // 找到"发起对战"
  const combatBtn = await me.evaluate(`(() => {
    const b=[...document.querySelectorAll('#action-bar button')].find(x=>/对战/.test(x.textContent) && !x.disabled);
    if(!b) return null; const t=b.textContent.trim(); b.click(); return t; })()`);
  console.log('点发起对战:', JSON.stringify(combatBtn));
  await sleep(900);

  const hint = await me.evaluate(text('#target-hint-text'));
  console.log('目标提示:', JSON.stringify(hint));

  // 选目标：P1 或 P2 面板上应出现可选目标
  const targetClicked = await me.evaluate(`(() => {
    const cands=[...document.querySelectorAll('#foe-grid *, #me-grid *')].filter(e=>{
      const r=e.getBoundingClientRect();
      return r.width>150 && r.height>100 && /韩立|南宫婉/.test(e.textContent) && getComputedStyle(e).cursor==='pointer';
    });
    if(cands.length){ cands[0].click(); return 'clicked ' + cands[0].textContent.slice(0,10); }
    const alt=[...document.querySelectorAll('[data-player-id],[data-target]')];
    if(alt.length){ alt[0].click(); return 'alt ' + alt.length; }
    return 'NO_TARGET_ELEM';
  })()`);
  console.log('选目标结果:', JSON.stringify(targetClicked));
  await sleep(1500);
  // 发起对战可能弹出「对战宣告 / 对战·可选发动」询问窗（取决于双方手里/场上有没有相关牌）——
  // 必须处理掉，否则对战面板会一直停在"战前"、没有掷骰按钮。
  const flushed1 = await flushPending(host, guest);
  if (flushed1) console.log(`  处理了 ${flushed1} 次【斗法】弹窗（不破招·跳过）`);
  await sleep(700);

  const overlay = await me.evaluate(`(() => { const e=document.querySelector('#combat-overlay');
    if(!e) return null; const r=e.getBoundingClientRect();
    return { visible: r.width>0 && r.height>0, title:(document.querySelector('#combat-title')||{}).textContent,
      sub:(document.querySelector('#combat-sub')||{}).textContent, rule:(document.querySelector('#combat-dice-rule')||{}).textContent,
      steps:(document.querySelector('#combat-steps')||{}).textContent }; })()`);
  console.log('对战覆盖层:', JSON.stringify(overlay));
  await me.screenshot(OUT + '\\07-combat-overlay.png');
  await other(host, guest, me).screenshot(OUT + '\\08-combat-other-side.png');

  const cBtns = await me.evaluate(btns('#combat-actions'));
  console.log('对战按钮:', JSON.stringify(cBtns));

  // 两段式掷骰：攻方先投（亮出点数），应战方后投
  const rollClick = (page) => page.evaluate(`(() => {
    const norm = s => (s||'').replace(/\\s+/g,'');
    const b=[...document.querySelectorAll('#combat-actions button')].find(x=>norm(x.textContent).includes('掷骰') && !x.disabled);
    if(!b) return null; b.click(); return b.textContent.trim(); })()`);
  const foe = other(host, guest, me);
  /** 读一方看到的对战标题（用来判断阶段真的推进了没有） */
  const combatTitle = (page) => page.evaluate(`(() => { const e=document.querySelector('#combat-title'); return e?e.textContent.trim():null; })()`);

  // 攻方掷骰。可能被"时点询问"挡住或偶发点击丢失 —— 所以**看结果重试**：
  // 目标是应战方那边看到「对战 · 待应战方掷骰」。
  let rolled = null;
  for (let i = 0; i < 4; i++) {
    rolled = await rollClick(me);
    if (rolled) console.log(`攻方点掷骰（第 ${i + 1} 次）:`, JSON.stringify(rolled));
    await sleep(900);
    const flushed2 = await flushPending(host, guest);
    if (flushed2) console.log(`  处理了 ${flushed2} 次【斗法】弹窗（不破招·跳过）`);
    await sleep(500);
    const tFoe = await combatTitle(foe);
    if (tFoe && /待应战方掷骰/.test(tFoe)) break;
    if (i === 3) {
      // 诊断：把两边的询问弹窗状态 + 服务端 pending 打出来
      for (const p of [host, guest]) {
        const m = await p.evaluate(`(() => {
          const ov = document.querySelector('#pending-modal');
          const b = document.querySelector('#btn-pending-pass');
          return { hidden: !ov || ov.classList.contains('hidden'),
            sub: (document.querySelector('#pending-sub')||{}).textContent,
            passDisabled: b ? b.disabled : null, passText: b ? b.textContent.trim() : null,
            toast: (document.querySelector('#toast')||{}).textContent }; })()`);
        console.log('    弹窗诊断: ' + JSON.stringify(m));
      }
      throw new Error(`攻方掷骰后应战方仍停在「${tFoe}」`);
    }
  }
  await me.screenshot(OUT + '\\09a-attacker-rolled.png');
  await foe.screenshot(OUT + '\\09b-awaiting-defender.png');

  // 应战方视角的中间态取证
  const mid = await foe.evaluate(`(() => ({
    title: (document.querySelector('#combat-title')||{}).textContent,
    dice: [...document.querySelectorAll('#combat-overlay .dice')].map(d => ({ t: d.textContent.trim(), cls: String(d.className) })),
    btns: [...document.querySelectorAll('#combat-actions button')].map(b => ({ t: b.textContent.replace(/\\s+/g,''), dis: b.disabled })),
  }))()`);
  console.log('应战方看到的中间态:', JSON.stringify(mid));
  if (!mid.btns.some((b) => !b.dis && /掷骰/.test(b.t))) throw new Error('应战方没拿到掷骰按钮');

  await sleep(900);
  const rolled2 = await rollClick(foe);
  console.log('应战方点掷骰:', JSON.stringify(rolled2));
  if (!rolled2) throw new Error('没找到应战方的掷骰按钮');
  await sleep(600);
  // 应战方这一投也可能先开「投骰前/后」的【斗法】窗（手里有牌时）——不处理的话骰子根本没投出去，
  // 后面的大字比分断言会变成"看运气"（上一轮全量就栽在这：窗口一开，combat_total 永远不来）。
  const flushed3 = await flushPending(host, guest);
  if (flushed3) console.log(`  处理了 ${flushed3} 次【斗法】弹窗（不破招·跳过）`);
  await foe.screenshot(OUT + '\\09c-defender-rolled.png');
  await sleep(2600);   // 等结算动画播完

  // ④ 大字比分（2026-10-05 结算可见性）：算式揭示完后 vs 区中央必须出现「N : N」。
  // 轮询覆盖动画时长（骰子 ~1.4s + 逐行算式 ~2.5s），比分没出现 = 这条改动白做了。
  // ⚠️ 轮询期间**每轮都再收一次【斗法】窗**：结算途中可能开出「受伤」这类窗口
  //    （第 3 轮受伤窗口前置后，它是"伤害落地前"开的），不收掉结算就停在那儿，
  //    大字比分永远不来 —— 这正是全量里偶挂"结算后大字比分没出现"、单跑又绿的那个抖动。
  let scoreTxt = '';
  for (let i = 0; i < 10; i++) {
    const flushed4 = await flushPending(host, guest);
    if (flushed4) console.log(`  结算期间又处理了 ${flushed4} 次【斗法】弹窗（不破招·跳过）`);
    scoreTxt = await me.evaluate(`(() => { const e=document.querySelector('#combat-score');
      if(!e || e.classList.contains('hidden')) return ''; return e.textContent.replace(/\\s+/g,''); })()`);
    if (/^\d+:\d+$/.test(scoreTxt)) break;
    await sleep(700);
  }
  if (!/^\d+:\d+$/.test(scoreTxt)) throw new Error('结算后大字比分没出现（#combat-score="' + scoreTxt + '"）');
  console.log('大字比分:', scoreTxt);

  const after = await me.evaluate(`(() => ({
    overlay:(()=>{const e=document.querySelector('#combat-overlay'); if(!e) return null; const r=e.getBoundingClientRect(); return r.width>0;})(),
    steps:(document.querySelector('#combat-steps')||{}).textContent,
    tiles:[...document.querySelectorAll('#combat-steps > *')].map(e=>e.textContent.replace(/\\s+/g,' ').trim()),
    log:[...document.querySelectorAll('#log-list > *')].map(e=>e.textContent.replace(/\\s+/g,' ').trim()).slice(-5),
  }))()`);
  console.log('结算后面板:', JSON.stringify(after.steps));
  console.log('结算明细:', JSON.stringify(after.tiles));
  console.log('战报尾部:'); after.log.forEach((l) => console.log('   · ' + l.slice(0, 120)));
  await me.screenshot(OUT + '\\10-combat-settled.png');

  // ---- 手机端 ----
  console.log('\n[手机端 390x844]');
  await me.setViewport(390, 844, true);
  await sleep(900);
  const mob = await me.evaluate(`(() => {
    const hz=document.querySelector('#hand-zone'); const r=hz?hz.getBoundingClientRect():null;
    return { bodyW: document.body.scrollWidth, winW: innerWidth,
      handVisible: r? (r.width>0 && r.height>0) : false,
      handScrollW: hz? hz.scrollWidth : null, handClientW: hz? hz.clientWidth : null,
      overflowX: document.documentElement.scrollWidth > innerWidth + 2,
      actionBtns: [...document.querySelectorAll('#action-bar button')].map(b=>b.textContent.trim()) }; })()`);
  console.log('手机布局:', JSON.stringify(mob));
  await me.screenshot(OUT + '\\11-mobile.png');

  console.log('\n页面异常(房主/客人):', host.pageErrors.length, guest.pageErrors.length);
  [...host.pageErrors, ...guest.pageErrors].slice(0, 5).forEach((e) => console.log('  ! ' + String(e).split('\n')[0]));
  const ce = [...host.consoleErrors, ...guest.consoleErrors].filter((x) => !x.includes('favicon'));
  console.log('控制台错误(非 favicon):', ce.length);
  ce.slice(0, 5).forEach((e) => console.log('  ! ' + e));
  // 页面异常 = 前端真的抛错了（曾因 cardById 未定义，把整版斗法候选按钮炸没）
  const allErr = [...host.pageErrors, ...guest.pageErrors];
  if (allErr.length) throw new Error(`全程出现 ${allErr.length} 次页面异常，首个：${String(allErr[0]).split('\n')[0]}`);

  console.log('\nUI COMBAT PASS');
  await b1.close(); await b2.close();
})().catch((e) => { console.error('\nUI COMBAT FAIL:', e.message); process.exit(1); });

function other(host, guest, me) { return me === host ? guest : host; }
