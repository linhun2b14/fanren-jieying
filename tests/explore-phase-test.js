'use strict';
/**
 * 探索阶段 · 阶段事务模型专测（2026-10-05 用户设计）
 *
 * 模型：进阶段 → 该时点效果先入【斗法】（卡文带「可以」= 主动发动，必须问）→ 逆序收势
 *      → 有人发动过再问一轮（oncePerTurn 滤掉已发动的）→ 连续不发动才落基础行动「抽 2 宝物」。
 *
 * 三张样板卡：
 *   【御风诀】（法术区装备）/【掌天瓶】（储物袋）—— 增量型：额外抽 1 宝物
 *   【青易居士】（同行者）—— 替换型：基础行动改抽 1 宝物 + 1 法术
 *
 * 一并守卫 P0：御风诀/掌天瓶曾经是「数据写了 event 但引擎没人收集」的空效果。
 */
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const T = (n) => C.cards().treasure.find((c) => c.name === n);
const S = (n) => C.cards().spell.find((c) => c.name === n);
const CP = (n) => C.cards().companion.find((c) => c.name === n);

let UID = 7000;
function setup(seed, opts) {
  const o = opts || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = 'draw_treasure'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = 3; B.realm = 3; A.mana = 12; B.mana = 12; A.hp = 6; B.hp = 6;
  A.qiCards = []; B.qiCards = []; A.hand = []; B.hand = [];
  A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = [];
  for (const n of o.aEquip || []) A.equip.push({ uid: UID++, id: T(n).id });
  for (const n of o.aSpells || []) A.spells.push({ uid: UID++, id: S(n).id });
  for (const n of o.aComps || []) A.companions.push({ uid: UID++, id: CP(n).id });
  if (o.blockTreasure) A.blockTreasureDraw = o.blockTreasure;
  return { st: st, A: A, B: B };
}
const deckOfInst = (c) => C.cards().treasure.some((x) => x.id === c.id) ? 'treasure'
  : (C.cards().spell.some((x) => x.id === c.id) ? 'spell' : '?');
const uidOf = (A, name) => {
  for (const pool of [A.equip, A.spells, A.companions]) {
    const x = pool.find((i) => { const d = [].concat(C.cards().treasure, C.cards().spell, C.cards().companion).find((y) => y.id === i.id); return d && d.name === name; });
    if (x) return x.uid;
  }
  return null;
};

console.log('[A] 御风诀在场：探索先开窗，发动 → 2+1 = 3 张宝物牌');
{
  const { st, A } = setup(7001, { aSpells: ['御风诀'] });
  const r = E.act(st, 'a', { type: 'draw_treasure' });
  check('先开【斗法】窗而不是直接抽牌', r.ok && r.paused && !!st.pending, JSON.stringify(r));
  check('弹窗标题是「探索阶段」', E.publicState(st, 'a').pending && E.publicState(st, 'a').pending.label === '探索阶段',
    JSON.stringify(E.publicState(st, 'a').pending && E.publicState(st, 'a').pending.label));
  check('候选是【御风诀】（场上发动，0 法力）',
    E.pendingCards(st, A).some((c) => c.name === '御风诀' && c.where === 'board' && c.cost === 0),
    JSON.stringify(E.pendingCards(st, A)));
  const rp = E.act(st, 'a', { type: 'respond_play', uid: uidOf(A, '御风诀') });
  check('发动【御风诀】', rp.ok, JSON.stringify(rp));
  check('窗口已收（oncePerTurn：不会为同一张牌再问一轮）', !st.pending, '');
  check('共抽 3 张宝物牌（1 增量先收势 + 基础行动 2 张）',
    A.hand.length === 3 && A.hand.every((c) => deckOfInst(c) === 'treasure'),
    JSON.stringify(A.hand.map(deckOfInst)));
  check('进入抉择阶段', st.step === 'choose_draw', st.step);
}

console.log('\n[B] 御风诀在场但跳过：「可以」= 也可以不发动');
{
  const { st, A } = setup(7002, { aSpells: ['御风诀'] });
  E.act(st, 'a', { type: 'draw_treasure' });
  E.act(st, 'a', { type: 'respond_pass' });
  check('跳过 → 照抽 2 张宝物牌', A.hand.length === 2 && A.hand.every((c) => deckOfInst(c) === 'treasure'),
    JSON.stringify(A.hand.map(deckOfInst)));
  check('进入抉择阶段', st.step === 'choose_draw', st.step);
}

console.log('\n[C] 掌天瓶（储物袋）同样走窗口');
{
  const { st, A } = setup(7003, { aEquip: ['掌天瓶'] });
  E.act(st, 'a', { type: 'draw_treasure' });
  check('候选是【掌天瓶】', E.pendingCards(st, A).some((c) => c.name === '掌天瓶' && c.where === 'board'),
    JSON.stringify(E.pendingCards(st, A)));
  E.act(st, 'a', { type: 'respond_play', uid: uidOf(A, '掌天瓶') });
  check('发动后共 3 张宝物牌', A.hand.length === 3 && A.hand.every((c) => deckOfInst(c) === 'treasure'),
    JSON.stringify(A.hand.map(deckOfInst)));
}

console.log('\n[D] 御风诀 + 掌天瓶同时在场：收势后再问一轮，两个都能发动');
{
  const { st, A } = setup(7004, { aSpells: ['御风诀'], aEquip: ['掌天瓶'] });
  E.act(st, 'a', { type: 'draw_treasure' });
  E.act(st, 'a', { type: 'respond_play', uid: uidOf(A, '御风诀') });
  check('发动御风诀后**再开一轮**窗口（掌天瓶还没表态）', !!st.pending, '');
  check('第二轮候选是【掌天瓶】（御风诀已被 oncePerTurn 滤掉）',
    E.pendingCards(st, A).some((c) => c.name === '掌天瓶') && !E.pendingCards(st, A).some((c) => c.name === '御风诀'),
    JSON.stringify(E.pendingCards(st, A).map((c) => c.name)));
  E.act(st, 'a', { type: 'respond_play', uid: uidOf(A, '掌天瓶') });
  check('两个都发动 → 共 4 张宝物牌（1+1 增量 + 基础 2）',
    A.hand.length === 4 && A.hand.every((c) => deckOfInst(c) === 'treasure'),
    JSON.stringify(A.hand.map(deckOfInst)));
  check('窗口已收、进入抉择阶段', !st.pending && st.step === 'choose_draw', st.step);
}

console.log('\n[E] 御风诀 + 青易居士：增量与替换可叠加');
{
  const { st, A } = setup(7005, { aSpells: ['御风诀'], aComps: ['青易居士'] });
  E.act(st, 'a', { type: 'draw_treasure' });
  E.act(st, 'a', { type: 'respond_play', uid: uidOf(A, '御风诀') });
  E.act(st, 'a', { type: 'respond_play', uid: uidOf(A, '青易居士') });
  const dk = A.hand.map(deckOfInst);
  check('2 宝物（1 增量 + 基础改抽 1）+ 1 法术（替换）',
    dk.filter((d) => d === 'treasure').length === 2 && dk.filter((d) => d === 'spell').length === 1,
    JSON.stringify(dk));
  check('进入抉择阶段', st.step === 'choose_draw', st.step);
}

console.log('\n[F] 两张青易居士：同一窗口能连着发动（按 uid 记），放过一张收势后还会再问');
{
  const { st, A } = setup(7006, { aComps: ['青易居士', '青易居士'] });
  E.act(st, 'a', { type: 'draw_treasure' });
  E.act(st, 'a', { type: 'respond_play', uid: uidOf(A, '青易居士') });
  check('发动第一张后窗口**没关**（第二张是另一个 uid，本窗口就能接着表态）', !!st.pending, '');
  check('候选里仍是【青易居士】（第二张）', E.pendingCards(st, A).some((c) => c.name === '青易居士'),
    JSON.stringify(E.pendingCards(st, A).map((c) => c.name)));
  E.act(st, 'a', { type: 'respond_pass' });   // 这一轮不发动第二张
  check('收势后又问一轮（阶段模型：有人发动过就再问），第二张还在候选里',
    !!st.pending && E.pendingCards(st, A).some((c) => c.name === '青易居士'),
    JSON.stringify(E.pendingCards(st, A).map((c) => c.name)));
  E.act(st, 'a', { type: 'respond_pass' });   // 这轮也不发动 → 链为空 → 落基础行动
  const dk = A.hand.map(deckOfInst);
  check('只发动一张 → 1 宝物 + 1 法术',
    dk.filter((d) => d === 'treasure').length === 1 && dk.filter((d) => d === 'spell').length === 1,
    JSON.stringify(dk));

  // 两张都在同一窗口发动：替换登记是布尔幂等的，不会变成「0 宝物 + 2 法术」
  const s2 = setup(7008, { aComps: ['青易居士', '青易居士'] });
  E.act(s2.st, 'a', { type: 'draw_treasure' });
  E.act(s2.st, 'a', { type: 'respond_play', uid: uidOf(s2.A, '青易居士') });
  E.act(s2.st, 'a', { type: 'respond_play', uid: s2.A.companions[1].uid });
  const dk2 = s2.A.hand.map(deckOfInst);
  check('两张都发动 → 仍是 1 宝物 + 1 法术（替换幂等）',
    dk2.filter((d) => d === 'treasure').length === 1 && dk2.filter((d) => d === 'spell').length === 1,
    JSON.stringify(dk2));
}

console.log('\n[G] 封锁抽宝物牌：整个探索阶段跳过（不开窗、不落基础行动）');
{
  const { st, A } = setup(7007, { aSpells: ['御风诀'], blockTreasure: 1 });
  const r = E.act(st, 'a', { type: 'draw_treasure' });
  check('不开窗、不抽牌、直接进抉择阶段', r.ok && !st.pending && A.hand.length === 0 && st.step === 'choose_draw',
    JSON.stringify({ ok: r.ok, hand: A.hand.length, step: st.step }));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
