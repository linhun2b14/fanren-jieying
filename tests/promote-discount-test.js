'use strict';
// 晋升折扣两条通道的回归（用户实测发现的 bug）：
//   游戏里有两个独立的数 ——
//     门槛 = 灵根符上印的「需达到」，决定有没有资格晋升
//     消耗 = 晋升时真正扣掉的灵气值
//   卡文写「所需」的减门槛（九曲灵参/九曲灵参丹/玄骨/辛如音/六翼霜蜈）
//   卡文写「消耗」的减消耗（娑罗珠）
//   旧版把两者一起减到门槛上 → 娑罗珠「说减消耗其实没减」，玩家照原价付钱。
//   另外 nextThreshold 漏算一次性折扣、nextConsume 完全原价 → 界面不反映，且
//   前端「晋升」按钮拿 nextThreshold 当开关，会白白置灰。
const E = require('../server/engine');
const C = require('../server/cards');
const { effOf } = require('./fixtures');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

const SLZ = C.cards().treasure.find((c) => c.name === '娑罗珠');   // 减「消耗」
const JQ = C.cards().treasure.find((c) => c.name === '九曲灵参'); // 减「门槛」
const XG = C.cards().companion.find((c) => c.name === '玄骨');    // 减「门槛」（常驻）
const LY = C.cards().companion.find((c) => c.name === '六翼霜蚣'); // 减「消耗」（常驻）
const XRY = C.cards().companion.find((c) => c.name === '辛如音');  // 减「消耗」（常驻）
check('卡池里有【娑罗珠】', !!SLZ);
// 【娑罗珠】2026-10-02 起按卡文写成 `event:'promote'`（晋升·前 已接询问层），所以按 event 取
const effOfEvent = (card, ev) => ((card && card.effects) || []).find((e) => e.event === ev) || null;
check('【娑罗珠】标记为「减消耗」（卡文写法：晋升 · 前 时点）',
  (effOfEvent(SLZ, 'promote') || {}).on === 'consume', JSON.stringify(SLZ && SLZ.effects));
check('【九曲灵参】未标 «on»，默认「减门槛」', effOf(JQ, 'play').on === undefined);
check('【六翼霜蜈】标记为「减消耗」', effOf(LY, 'promote').on === 'consume');
check('【辛如音】标记为「减消耗」', effOf(XRY, 'promote').on === 'consume');
check('【玄骨】未标 «on»，默认「减门槛」', effOf(XG, 'promote').on === undefined);

/** 造一局：甲在指定境界、满灵气、手上拿着给定牌 */
function setup(seed, realm, handDefs) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  const P = st.players[0];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  P.realm = realm; P.mana = 12; P.hand = []; P.equip = []; P.spells = []; P.companions = [];
  P.qiCards = [];
  for (let i = 0; i < 40; i++) P.qiCards.push(E.freshQiPile(st)[0]);
  (handDefs || []).forEach((d, i) => P.hand.push({ uid: 8000 + i, id: d.id }));
  return { st: st, P: P };
}
const me = (st) => E.publicState(st, 'a').players.find((x) => x.id === 'a');
const qi = (P) => P.qiCards.length;
/** 把所有挂着的时点窗口逐一点"跳过"（链结算后流程才会继续） */
const flushAll = (st) => { let g = 0; while (st.pending && g++ < 20) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };

// ---- A：【娑罗珠】减的是「消耗」，不是「门槛」----
// ⭐ 2026-10-02：晋升 · 前 那一格**接上了询问层**（用户拍板），所以【娑罗珠】按卡文写成
//    `event:'promote'/self/before` —— 它的用法变成"发起晋升时，在窗口里打出"。
console.log('\n[A] 【娑罗珠】：晋升·前 在窗口里打出，减「消耗」不减「门槛」（炼气 → 筑基）');
{
  const { st, P } = setup(9101, 1, [SLZ]);
  const base = E.ROOTS[P.root].costs[1];              // 筑基门槛
  const consumeBase = E.PROMOTE_CONSUME[1];           // 筑基固定消耗 = 2
  const b = me(st);
  check('晋升前：门槛 = 灵根符原值', b.nextThreshold === base, `${b.nextThreshold} vs ${base}`);
  check('晋升前：消耗 = 固定值', b.nextConsume === consumeBase, `${b.nextConsume} vs ${consumeBase}`);
  check('卡文写法：效果挂在「晋升 · 前」时点（不是 when:play）',
    (SLZ.effects || []).some((e) => e.event === 'promote' && e.subject === 'self' && e.phase === 'before' && e.on === 'consume'),
    JSON.stringify(SLZ.effects));

  const r0 = E.act(st, P.id, { type: 'promote' });
  check('发起晋升会挂在「晋升 · 前」窗口（等玩家决定要不要用折扣牌）',
    r0.ok && r0.paused === true && !!(st.pending && st.pending.event === 'promote' && st.pending.phase === 'before'),
    JSON.stringify([r0, st.pending && `${st.pending.event}/${st.pending.phase}`]));
  const cands = E.pendingCards(st, P);
  check('窗口把【娑罗珠】摆出来了（0 费）',
    cands.some((c) => c.name === '娑罗珠' && c.cost === 0), JSON.stringify(cands));

  const uid = (cands.find((c) => c.name === '娑罗珠') || {}).uid;
  check('在窗口里打出【娑罗珠】', E.act(st, P.id, { type: 'respond_play', uid: uid }).ok, '');
  flushAll(st);

  check('晋升照常继续跑完（炼气 → 筑基，不需掷骰）', P.realm === 2, String(P.realm));
  check(`[Bug A] 实际只扣 ${consumeBase - 1} 点灵气值（旧版会扣 ${consumeBase}）`,
    qi(P) === 40 - (consumeBase - 1), `灵气牌 ${qi(P)}（起始 40）`);
  const line = st.log.map((l) => l.text).join(' | ');
  check('[Bug A] 战报里门槛**仍是原值**、消耗已打折',
    new RegExp('晋升筑基期需 ' + base + ' 点灵气值.+将消耗 ' + (consumeBase - 1) + ' 点').test(line),
    (line.match(/在【灵根符】上确认[^|]*/) || [''])[0]);
  check('折扣卡用掉了（待用列表清空）', (P.promoPending || []).length === 0, JSON.stringify(P.promoPending));
}

// ---- B：【九曲灵参】减的是「门槛」，消耗不变（不许回归）----
console.log('\n[B] 【九曲灵参】：结丹期 → 元婴期（门槛 16 左右，消耗固定 3）');
{
  const { st, P } = setup(9102, 3, [JQ]);
  const base = E.ROOTS[P.root].costs[3];
  const consumeBase = E.PROMOTE_CONSUME[3];           // 元婴固定消耗 = 3
  const b = me(st);
  check('打出前：门槛 = 灵根符原值', b.nextThreshold === base, `${b.nextThreshold} vs ${base}`);

  check('打出【九曲灵参】', E.act(st, P.id, { type: 'play', uid: 8000 }).ok, '');
  const a = me(st);
  check('门槛 -1（所需灵气值）', a.nextThreshold === base - 1, `${a.nextThreshold} vs ${base - 1}`);
  check('消耗**不变**', a.nextConsume === consumeBase, `${a.nextConsume} vs ${consumeBase}`);

  const before = qi(P);
  const r = E.act(st, P.id, { type: 'promote' });
  void r;                                             // 元婴要掷骰 ≥5，可能失败，但灵气照扣
  check(`实际扣 ${consumeBase} 点灵气（九曲灵参不减消耗）`, before - qi(P) === consumeBase, `${before} -> ${qi(P)}`);
}

// ---- C：同行者常驻折扣 ----
console.log('\n[C] 【玄骨】在场：门槛 -1，消耗不变');
{
  const { st, P } = setup(9103, 1, []);
  const base = E.ROOTS[P.root].costs[1];
  const consumeBase = E.PROMOTE_CONSUME[1];
  P.companions.push({ uid: 9001, id: XG.id });
  const a = me(st);
  check('门槛 -1', a.nextThreshold === base - 1, `${a.nextThreshold} vs ${base - 1}`);
  check('消耗不变', a.nextConsume === consumeBase, `${a.nextConsume} vs ${consumeBase}`);
}

// ---- C2：用户按实物裁定 ——【辛如音】【六翼霜蜈】减的是「消耗」，不减门槛 ----
console.log('\n[C2] 【辛如音】/【六翼霜蜈】在场：消耗 -1，门槛不变（用户按实物裁定）');
{
  const { st, P } = setup(9106, 1, []);
  const base = E.ROOTS[P.root].costs[1];
  const consumeBase = E.PROMOTE_CONSUME[1];
  P.companions.push({ uid: 9002, id: XRY.id });
  P.companions.push({ uid: 9003, id: LY.id });
  const a = me(st);
  check('门槛**不变**（这两张不减门槛）', a.nextThreshold === base, `${a.nextThreshold} vs ${base}`);
  check(`消耗 -2（两张各 -1）`, a.nextConsume === Math.max(0, consumeBase - 2), `${a.nextConsume} vs ${consumeBase - 2}`);
  const before = qi(P);
  const r = E.act(st, P.id, { type: 'promote' });
  check('晋升成功', r.ok && P.realm === 2, JSON.stringify(r));
  check(`实际扣 ${Math.max(0, consumeBase - 2)} 点灵气`, before - qi(P) === Math.max(0, consumeBase - 2), `${before} -> ${qi(P)}`);
}

// ---- C3：消耗被减到 0 也不能变负数 ----
console.log('\n[C3] 消耗折扣打到负数 → 夹到 0');
{
  const { st, P } = setup(9107, 3, [SLZ]);           // 结丹→元婴 消耗 3
  const consumeBase = E.PROMOTE_CONSUME[3];
  P.companions.push({ uid: 9004, id: XRY.id });      // 辛如音：常驻减消耗 1
  P.companions.push({ uid: 9005, id: LY.id });       // 六翼霜蜈：常驻减消耗 1
  const r = E.act(st, P.id, { type: 'promote' });
  check('挂在「晋升 · 前」窗口', r.ok && r.paused === true, JSON.stringify(r));
  const uid = (E.pendingCards(st, P).find((c) => c.name === '娑罗珠') || {}).uid;
  check('【娑罗珠】可打出', typeof uid === 'number', String(uid));
  E.act(st, P.id, { type: 'respond_play', uid: uid });   // 娑罗珠 -1 → 合计 -3
  flushAll(st);
  const line = st.log.map((l) => l.text).join(' | ');
  check(`消耗被夹到 0（${consumeBase} - 1(娑罗珠) - 1(辛如音) - 1(六翼霜蜈) 不会是负数）`,
    /将消耗 0 点/.test(line), (line.match(/在【灵根符】上确认[^|]*/) || [''])[0]);
  check('结算里没有负数消耗', !/将消耗 -\d/.test(line), '');
}

// ---- D：两条通道同时用，各自减各自的 ----
console.log('\n[D] 【九曲灵参】（行动阶段·减门槛）+【娑罗珠】（晋升窗口·减消耗）');
{
  const { st, P } = setup(9104, 3, [JQ, SLZ]);
  const base = E.ROOTS[P.root].costs[3];
  const consumeBase = E.PROMOTE_CONSUME[3];
  check('行动阶段先打出【九曲灵参】（减门槛）', E.act(st, P.id, { type: 'play', uid: 8000 }).ok, '');
  const a = me(st);
  check('门槛 -1（九曲灵参）', a.nextThreshold === base - 1, `${a.nextThreshold} vs ${base - 1}`);
  check('此时消耗未变（九曲灵参不动消耗）', a.nextConsume === consumeBase, `${a.nextConsume} vs ${consumeBase}`);

  const r = E.act(st, P.id, { type: 'promote' });
  check('晋升挂起并开出「晋升 · 前」窗口', r.ok && r.paused === true, JSON.stringify(r));
  const uid = (E.pendingCards(st, P).find((c) => c.name === '娑罗珠') || {}).uid;
  check('窗口里能打出【娑罗珠】', E.act(st, P.id, { type: 'respond_play', uid: uid }).ok, '');
  flushAll(st);

  const m = st.log.map((l) => l.text).join(' | ').match(/晋升元婴期需 (\d+) 点灵气值.+将消耗 (\d+) 点/);
  check('门槛 = 原值 -1（只由九曲灵参贡献）', !!m && Number(m[1]) === base - 1, m && m[0]);
  check(`消耗 = ${consumeBase} -1（只由娑罗珠贡献）`, !!m && Number(m[2]) === consumeBase - 1, m && m[0]);
}

// ---- E：门槛不够时仍然拦住（折扣没把校验搞漏）----
console.log('\n[E] 灵气低于门槛 → 拒绝晋升，且**不会先弹窗口**');
{
  const { st, P } = setup(9105, 1, [SLZ]);
  const base = E.ROOTS[P.root].costs[1];
  while (qi(P) > base - 1) P.qiCards.pop();           // 压到 base-1（娑罗珠不降门槛）
  const r = E.act(st, P.id, { type: 'promote' });
  check('被拒绝（灵气值不足）', !r.ok && /灵气值不足/.test(r.error || ''), JSON.stringify(r));
  check('没有开出「晋升 · 前」窗口（预检在窗口之前）', !st.pending, st.pending && st.pending.event);
  check('境界未变', P.realm === 1, String(P.realm));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
