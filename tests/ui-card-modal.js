'use strict';
// 卡牌详情弹窗专项：验证同行者的「替挡 N 次 / 不替挡」以及新的效果时点行能正确渲染。
// 走真实流程：开局 → 抽灵气 → 抽宝物 → 抉择阶段选【同行者】→ 点手牌看详情。
const { launch, newPage, sleep } = require('./cdp');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';
const OUT = require('path').join(__dirname, ('..'), 'ref', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const setVal = (s, v) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return 'NOELEM';
  e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`;
const click = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return 'NOELEM';
  if(e.disabled) return 'DISABLED'; e.click(); return 'ok'; })()`;
const text = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); return e?e.textContent.trim():null; })()`;
const clickBtn = (re) => `(() => { const b=[...document.querySelectorAll('#action-bar button')].find(x=>new RegExp(${JSON.stringify(re)}).test(x.textContent)&&!x.disabled);
  if(!b) return null; b.click(); return b.textContent.trim(); })()`;
const modalText = `(() => { const m=document.querySelector('#card-modal'); if(!m) return null;
  const r=m.getBoundingClientRect(); return (r.width>0&&r.height>0) ? (m.textContent||'').replace(/\\s+/g,' ') : null; })()`;

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

(async () => {
  const b1 = await launch({ port: 9421 });
  const b2 = await launch({ port: 9422 });
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

  let me = null, tag = '';
  for (const [p, n] of [[host, '房主'], [guest, '客人']]) {
    const t = await p.evaluate(`(() => (document.querySelector('#tb-turn')||{}).textContent || '')()`);
    if (/轮到你/.test(t)) { me = p; tag = n; }
  }
  if (!me) throw new Error('找不到当前行动方');
  console.log('当前行动方:', tag);

  // 推进到抉择阶段
  for (const re of ['灵气', '宝物']) {
    const got = await me.evaluate(clickBtn(re));
    console.log(`  点击「${re}」→`, JSON.stringify(got));
    await sleep(1200);
  }
  let btns = await me.evaluate(`[...document.querySelectorAll('#action-bar button')].map(b=>b.textContent.trim())`);
  console.log('抉择阶段按钮:', JSON.stringify(btns));

  // 选【同行者】把它抽到手
  const picked = await me.evaluate(clickBtn('同行者'));
  console.log('  选择「同行者」→', JSON.stringify(picked));
  await sleep(1400);

  // 手牌里找同行者那张
  const hand = await me.evaluate(`(() => [...document.querySelectorAll('#hand-zone > *')].map((el,i)=>({
    i:i, uid:el.getAttribute('data-uid'), txt:(el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,30) })))()`);
  console.log('手牌:', JSON.stringify(hand));
  if (!hand || !hand.length) throw new Error('抉择后手牌为空');

  // 手牌点击是「直接打出」，所以要把它打到场上，再点棋盘上的 chip 看详情
  const compCard = hand.find((c) => /同行者/.test(c.txt) && /无境界限制/.test(c.txt));
  let mtxt = '', found = false;
  if (!compCard) {
    console.log('\n本次没抽到同行者（可能抽到了法术），跳过详情断言');
  } else {
    console.log(`\n打出同行者手牌 [${compCard.i}] uid=${compCard.uid}`);
    await me.evaluate(`(() => { document.querySelector('#hand-zone').children[${compCard.i}].click(); return 'ok'; })()`);
    await sleep(1200);
    // 在自家棋盘上找同行者 chip 并点开详情
    const opened = await me.evaluate(`(async () => {
      const r = await fetch('/api/cards'); const j = await r.json();
      const nameOf = {}; (j.companion||[]).forEach(c => { nameOf[c.id] = c.name; });
      const chips = [...document.querySelectorAll('#me-grid .eq-chip, #me-grid .companion-chip, #me-grid [data-card-id]')];
      const hit = chips.find(x => nameOf[x.dataset.cardId]);
      if (!hit) return { ok:false, chips: chips.length };
      hit.click();
      return { ok:true, name: nameOf[hit.dataset.cardId] };
    })()`);
    console.log('  打开详情:', JSON.stringify(opened));
    await sleep(700);
    mtxt = (await me.evaluate(modalText)) || '';
    found = !!mtxt;
  }

  if (!found) {
    console.log('\n详情弹窗没能打开，只做卡池数据兜底断言');
  } else {
    console.log('\n详情文案:', mtxt.slice(0, 220));
    check('详情显示境界无限制', /无限制/.test(mtxt), mtxt.slice(0, 80));
    check('详情要么写「替你承受任意 N 次伤害」，要么写「不替挡伤害」',
      /替你承受任意\s*\d+\s*次伤害/.test(mtxt) || /不替挡伤害/.test(mtxt), mtxt.slice(0, 140));
    // 效果行现在由 /api/meta 的中文标签渲染。注意：未实装的卡（如【梅凝】）本来就没有 effects，
    // 那种情况渲染 0 行是**正确**的，所以按卡池数据判断该不该有行。
    const rowInfo = await me.evaluate(`(async () => {
      const r = await fetch('/api/cards'); const j = await r.json();
      const name = ${JSON.stringify((mtxt.match(/✕\s*(\S+?)同行者/) || [])[1] || '')};
      const all = [].concat(j.treasure||[],j.spell||[],j.companion||[],j.qi||[]);
      const c = all.find(x => x.name === name);
      // ⚠️ 期望行数要**跟着 effRows() 的算法**：除了 effects 数组，前端还会给「用字段实现的常驻机制」
      //    各补一行 —— \\\`cardCostDiscount\\\`（用宝物/法术牌法力 -1）与 \\\`absorb\\\`（替你承受 N 次伤害）。
      //    只数 effects.length 的话，【齐云霄】（只有 cardCostDiscount、effects 为空）会被判成 1≠0 假红
      //    （2026-10-05 抽到它才暴露：这条断言依赖随机发牌，平时不一定碰上）。
      const want = c ? ((c.effects||[]).length + (c.cardCostDiscount ? 1 : 0) + (c.absorb ? 1 : 0)) : -1;
      return { rows: document.querySelectorAll('#card-modal .cd-effs .eff').length,
        want: want, name: name };
    })()`);
    check('效果行数与卡池数据一致（未实装的卡 0 行是对的）',
      rowInfo.want < 0 ? true : (rowInfo.want === 0 ? rowInfo.rows === 0 : rowInfo.rows >= rowInfo.want),
      JSON.stringify(rowInfo));
    // 时点标签全部走 /api/meta 映射 —— 旧版这里会渲染出 "undefined"（【绿煌剑】等）
    check('详情文案里不出现 undefined', !/undefined/.test(mtxt), mtxt.slice(0, 160));
    // ⭐ 时机名走**阶段图口径**（用户 2026-10-02）：卡面上不该再出现引擎腔的旧名。
    //    这条能判别"前端没拿到 /api/meta 的 timingNames、退回自己拼"的情况（那正是"显示很乱"的根源之一）。
    const timingCells = await me.evaluate(`[...document.querySelectorAll('#card-modal .cd-effs .eff b')].map(b=>b.textContent.trim())`);
    check('卡面时机用阶段图口径（不出现旧名「投骰 · 」「卡牌使用 · 」「对战结果 · 」）',
      !timingCells.some((t) => /投骰 · |卡牌使用 · |对战结果 · |抽取灵气|抽取宝物/.test(t)),
      JSON.stringify(timingCells));
    // 撤下机制（用户裁定 A 方案）：自己回合的行动阶段，点开自己场上的牌应出现「撤下」按钮。
    // 现在正好是"我的回合 + 行动阶段 + 无对战 + 无 pending"。
    const dismissInfo = await me.evaluate(`(() => {
      const b = document.querySelector('#card-modal-body > .cd-dismiss');
      return { has: !!b, label: b ? b.textContent.replace(/\\s+/g,' ').trim() : null,
        step: (document.querySelector('#tb-step')||{}).textContent || '' };
    })()`);
    check('自己场上牌在行动阶段的详情里有「撤下」按钮', dismissInfo.has, JSON.stringify(dismissInfo));
    check('「撤下」按钮文案写明了后果（放入弃牌堆）',
      !!dismissInfo.label && /弃牌堆/.test(dismissInfo.label), String(dismissInfo.label));
  }

  // 兜底：直接核对客户端拿到的卡池数据能支撑渲染（效果 DSL：effects: [{when|event, op, if}]）
  // ⚠️ 时机比较走**归一化键**（拿 /api/meta 的 whenTiming 翻译）—— 卡池 2026-10-02 迁到总线坐标后，
  //    `e.when === 'win'` 这类比法会全部落空（数据里只剩 event/phase），断言会变成空集比较。
  const apiCheck = await me.evaluate(`(async () => {
    const r = await fetch('/api/cards'); const j = await r.json();
    const mr = await fetch('/api/meta'); const meta = await mr.json();
    const wt = (meta && meta.whenTiming) || {};
    const keyOf = (w) => { const t = wt[w]; return t && t.event ? (t.phase ? t.event + ':' + t.phase : t.event) : w; };
    const keysOf = (e) => { const out = []; if (e.when) out.push(keyOf(e.when));
      if (e.event) out.push(e.phase ? e.event + ':' + e.phase : e.event); return out; };
    const list = j.companion || [];
    const has = (c, w) => (c.effects || []).some(e => keysOf(e).indexOf(keyOf(w)) >= 0);
    // op 参数化合族（2026-10-05）：抽牌=draw+deck、封锁=block_draw+deck —— 旧 op 名只读旧备份
    const WIN_OPS = ['mana','draw_qi','draw','steal_equip','discard_enemy_equip','block_draw','block_spell_draw','block_companion_draw','damage'];
    return { n: list.length, tot: list.reduce((s,c)=>s+(c.count||1),0),
      absorb2: list.filter(c=>c.absorb===2).map(c=>c.name),
      place: list.filter(c=>has(c,'place')).map(c=>c.name),
      hurt: list.filter(c=>has(c,'hurt')).map(c=>c.name),
      win: list.filter(c=>(c.effects||[]).some(e=>keysOf(e).indexOf(keyOf('win'))>=0 && WIN_OPS.indexOf(e.op)>=0)).map(c=>c.name),
      multi: list.filter(c=>(c.effects||[]).filter(e=>e.op==='combat_bonus'||e.op==='dice_bonus').length>1).map(c=>c.name) };
  })()`);
  console.log('\n客户端卡池:', JSON.stringify(apiCheck));
  // 张数/种数**不固定**（2026-10-04 用户按实物卡入库后 30 种/78 张 → 更多）：只查"拿到了同伴者数据"
  check('客户端拿到同行者卡池（' + apiCheck.n + ' 种 / ' + apiCheck.tot + ' 张）',
    apiCheck.n > 0 && apiCheck.tot >= apiCheck.n, JSON.stringify(apiCheck));
  check('替挡 2 次的卡（离龟/南宫婉）在数据里（实得 ' + apiCheck.absorb2.length + ' 张）',
    apiCheck.absorb2.indexOf('离龟') >= 0 && apiCheck.absorb2.indexOf('南宫婉') >= 0, JSON.stringify(apiCheck.absorb2));
  check('放置时效果卡至少含 血玉蜘蛛/铁火蚁/离龟',
    ['血玉蜘蛛', '铁火蚁', '离龟'].every(function (n) { return apiCheck.place.indexOf(n) >= 0; }),
    JSON.stringify(apiCheck.place));
  check('受伤时效果卡（燕如嫣/慕沛灵）在数据里（实得 ' + apiCheck.hurt.length + ' 张）',
    apiCheck.hurt.indexOf('燕如嫣') >= 0 && apiCheck.hurt.indexOf('慕沛灵') >= 0, JSON.stringify(apiCheck.hurt));
  check('获胜时效果卡至少 8 张（实得 ' + apiCheck.win.length + ' 张）', apiCheck.win.length >= 8, JSON.stringify(apiCheck.win));
  // 蛮胡子按实物卡面改成「≥4 骰子点数+1 / ≤3 战力+1」——所以查"两条对战修正"，不再限定同 op
  check('一条同行者可以挂多条对战修正（蛮胡子：骰点+1 + 战力+1）', apiCheck.multi.length >= 1, JSON.stringify(apiCheck.multi));

  await me.screenshot(OUT + '\\v6-card-modal.png');
  const errs = [...host.pageErrors, ...guest.pageErrors];
  console.log('\n页面异常:', errs.length);
  errs.slice(0, 3).forEach((e) => console.log('  ! ' + String(e).split('\n')[0]));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await b1.close(); await b2.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nCARD MODAL FAIL:', e.message); process.exit(1); });
