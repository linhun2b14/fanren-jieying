'use strict';
/**
 * 对战优先权循环专测（2026-10-05 用户拍板「阶段主优先」）
 *
 * 模型：「先攻/后攻出牌阶段」（投骰前）——
 *   阶段主（投骰者）优先表态 → 对方响应 → 循环 → 双方连续不发动 → 逆序收势
 *   → 链非空**再问一轮** → 直到一轮谁都没发动，才推进到投骰。
 *   后攻出牌阶段同理，优先权给后攻（改的是铁律 2 在对战内的应用）。
 *
 * 守卫点：
 *   [A] 先攻出牌阶段先攻先被问（运行时名「先攻出牌阶段」）
 *   [B] 后攻出牌阶段后攻先被问（运行时名「后攻出牌阶段」）—— 本条是拍板的核心
 *   [C] 收势后链非空 → 重开一轮，还能继续发动
 *   [D] 场上牌防重复问（firedRollBoard 登记）——【乾蓝冰焰】效果2 没有 oncePerTurn，
 *       没有这道登记它会被重开的窗口反复问、反复扣费
 *   [E] 一轮谁都不发动 → 直接推进投骰，不再开窗
 */
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const T = (n) => C.cards().treasure.find((c) => c.name === n);

function setup(seed, opts) {
  const o = opts || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = 3; B.realm = 3; A.mana = 12; B.mana = 12; A.hp = 6; B.hp = 6;
  A.qiCards = []; B.qiCards = [];
  A.hand = (o.aHand || []).map((n, i) => ({ uid: 6100 + i, id: T(n).id }));
  B.hand = (o.bHand || []).map((n, i) => ({ uid: 6200 + i, id: T(n).id }));
  A.equip = (o.aEquip || []).map((n, i) => ({ uid: 6300 + i, id: T(n).id }));
  B.equip = []; A.spells = []; B.spells = []; A.companions = []; B.companions = [];
  // 发起对战（没人挂开战响应牌 → 直通到 stage 'pre'）
  const r = E.act(st, 'a', { type: 'combat', target: 'b' });
  if (!r.ok || !st.combat) throw new Error('造对战失败：' + JSON.stringify(r));
  return { st: st, A: A, B: B, c: st.combat };
}
const pdOf = (st, forId) => E.publicState(st, forId).pending;

console.log('[A] 先攻出牌阶段：先攻先被问');
{
  const { st, A, B, c } = setup(6001, { aHand: ['金光砖符'], bHand: ['寒冰珠'] });
  const r = E.act(st, 'a', { type: 'roll' });
  check('开出牌阶段窗口', r.ok && r.paused && !!st.pending, JSON.stringify(r));
  check('运行时名是「先攻出牌阶段」', pdOf(st, 'a') && pdOf(st, 'a').label === '先攻出牌阶段',
    JSON.stringify(pdOf(st, 'a') && pdOf(st, 'a').label));
  check('队首是先攻（阶段主优先）', st.pending.queue[0] === 'a', JSON.stringify(st.pending.queue));
  check('后攻也在队列里（寒冰珠=对方投骰前）', st.pending.queue.indexOf('b') >= 0, JSON.stringify(st.pending.queue));
  E.act(st, 'a', { type: 'respond_pass' });
  E.act(st, 'b', { type: 'respond_pass' });
  check('双方连续不发动 → 先攻投骰完成', !st.pending && typeof c.dice.a === 'number' && c.stage === 'roll_defender',
    JSON.stringify({ pending: !!st.pending, dice: c.dice, stage: c.stage }));
}

console.log('\n[B] 后攻出牌阶段：后攻先被问（拍板的核心）');
{
  // 先攻（甲）持【寒冰珠】= 对方投骰前；后攻（乙）持【金光砖符】= 我方投骰前。
  // 于是先攻那一投两边都够不上（甲的寒冰珠不对自己、乙的砖符只对我方）→ 直通；
  // 后攻那一投两边都有牌 → 开窗，队首必须是**后攻**（阶段主优先，不是回合玩家优先）。
  const { st, A, B, c } = setup(6002, { aHand: ['寒冰珠'], bHand: ['金光砖符'] });
  E.act(st, 'a', { type: 'roll' });
  check('先攻那一投双方都不够响应 → 直通投骰', !st.pending && c.stage === 'roll_defender',
    JSON.stringify({ pending: !!st.pending, stage: c.stage }));
  const r = E.act(st, 'b', { type: 'roll' });
  check('后攻出牌阶段开窗', r.ok && r.paused && !!st.pending, JSON.stringify(r));
  check('运行时名是「后攻出牌阶段」', pdOf(st, 'b') && pdOf(st, 'b').label === '后攻出牌阶段',
    JSON.stringify(pdOf(st, 'b') && pdOf(st, 'b').label));
  check('队首是后攻（阶段主优先，不是回合玩家优先）', st.pending.queue[0] === 'b', JSON.stringify(st.pending.queue));
  check('先攻也在队列里（寒冰珠=对方投骰前）', st.pending.queue.indexOf('a') >= 0, JSON.stringify(st.pending.queue));
  E.act(st, 'b', { type: 'respond_pass' });
  E.act(st, 'a', { type: 'respond_pass' });
  check('双方连续不发动 → 后攻投骰并结算（总战力已出）',
    !st.pending && typeof c.total.a === 'number' && typeof c.total.b === 'number',
    JSON.stringify({ pending: !!st.pending, total: c.total }));
}

console.log('\n[C] 收势后链非空 → 重开一轮，还能继续发动');
{
  const { st, A, B, c } = setup(6003, { aHand: ['金光砖符', '朱雀环'], bHand: [] });
  E.act(st, 'a', { type: 'roll' });
  const uid1 = A.hand[0].uid, uid2 = A.hand[1].uid;
  const rp = E.act(st, 'a', { type: 'respond_play', uid: uid1 });
  check('先攻打出【金光砖符】', rp.ok, JSON.stringify(rp));
  // 后攻无牌不在队列；先攻留在队首还能再出 —— 他选择放弃
  E.act(st, 'a', { type: 'respond_pass' });
  check('收势后**重开了一轮**（链非空）', !!st.pending && st.pending.event === 'roll' && st.pending.phase === 'before',
    JSON.stringify(st.pending && { ev: st.pending.event, ph: st.pending.phase }));
  check('重开的窗口还给出【朱雀环】候选', E.pendingCards(st, A).some((x) => x.uid === uid2),
    JSON.stringify(E.pendingCards(st, A)));
  E.act(st, 'a', { type: 'respond_pass' });
  check('这轮不发动 → 推进投骰（金光砖符已登记：放弃掷骰换固定战力）',
    !st.pending && typeof c.dice.a === 'number' && !!c.skipDice.a,
    JSON.stringify({ pending: !!st.pending, dice: c.dice.a, skip: c.skipDice }));
}

console.log('\n[D] 场上牌防重复问（乾蓝冰焰效果2没有 oncePerTurn，靠 firedRollBoard 登记）');
{
  const { st, A, B, c } = setup(6004, { aEquip: ['虚天鼎 乾蓝冰焰'], aHand: [], bHand: [] });
  const m0 = A.mana;
  E.act(st, 'a', { type: 'roll' });
  check('开窗给出【虚天鼎 乾蓝冰焰】候选（场上发动）',
    E.pendingCards(st, A).some((x) => x.name === '虚天鼎 乾蓝冰焰' && x.where === 'board'),
    JSON.stringify(E.pendingCards(st, A)));
  const rp = E.act(st, 'a', { type: 'respond_play', uid: A.equip[0].uid });
  check('发动乾蓝冰焰（花 1 法力，本场战力 +1）', rp.ok, JSON.stringify(rp));
  check('只扣了 1 点法力（没有被重开的窗口重复扣费）', A.mana === m0 - 1, `${m0} -> ${A.mana}`);
  check('战力加成只登记了一次（+1 不是 +2）', (c.bonus.a || 0) === 1, JSON.stringify(c.bonus));
  check('收势后**没有**为它重开窗口（登记生效 → 零响应直通投骰）',
    !st.pending && typeof c.dice.a === 'number',
    JSON.stringify({ pending: !!st.pending, dice: c.dice }));
}

console.log('\n[E] 一轮谁都不发动 → 直接推进，不再开窗');
{
  const { st, A, B, c } = setup(6005, { aHand: ['金光砖符'], bHand: [] });
  E.act(st, 'a', { type: 'roll' });
  check('开窗（先攻有牌）', !!st.pending, '');
  E.act(st, 'a', { type: 'respond_pass' });
  check('先攻放弃（链为空）→ 直接投骰不重开', !st.pending && typeof c.dice.a === 'number' && c.stage === 'roll_defender',
    JSON.stringify({ pending: !!st.pending, stage: c.stage }));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
