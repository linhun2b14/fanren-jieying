'use strict';
/**
 * 2026-10-05 实盘测试四项反馈的回归专测
 *
 *   [A] ①（真 bug）破招打出**手牌**后，同一人的**场上**效果不该被锁死 ——
 *       还原实盘：开战窗口里打出【乌龙夺】后，场上的【黑血刀】启用费必须还能被问。
 *   [B] ② 晋升「减消耗」牌在消耗为 0 时不问（【降尘丹】）；消耗 > 0 时才问；
 *       【降尘丹】卡文后半句「放入弃牌堆抽 1 灵气」在出牌阶段也能用（两个时点）。
 *   [C] ③ 装备付费只看卡文：带「装备时不消耗【法力值】」→ 装备免费、效果才计费；
 *       没写 → 装备时消耗、效果不再消耗（不再按境界分高低档）。
 *   [D] ④【掌天瓶】没有对战效果，不该出现在任何战斗窗口（多余的 enable_equip_combat 已删）。
 */
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const T = (n) => C.cards().treasure.find((c) => c.name === n);
const S = (n) => C.cards().spell.find((c) => c.name === n);
const PLAIN_QI = C.cards().qi[0];
/** 把开着的窗口全放弃掉（清场用） */
const flush = (st) => { let g = 0; while (st.pending && g++ < 20) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };

let UID = 5000;
function setup(seed, opts) {
  const o = opts || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = o.step || 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = o.aRealm == null ? 3 : o.aRealm; B.realm = 3;
  A.mana = 12; B.mana = 12; A.hp = 6; B.hp = 6;
  A.qiCards = []; B.qiCards = [];
  for (let i = 0; i < (o.aQi || 0); i++) A.qiCards.push({ uid: UID++, id: PLAIN_QI.id });
  A.hand = []; B.hand = []; A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = [];
  for (const n of o.aHandT || []) A.hand.push({ uid: UID++, id: T(n).id });
  for (const n of o.aHandS || []) A.hand.push({ uid: UID++, id: S(n).id });
  for (const n of o.aEquip || []) A.equip.push({ uid: UID++, id: T(n).id });
  for (const n of o.aSpells || []) A.spells.push({ uid: UID++, id: S(n).id });
  return { st: st, A: A, B: B };
}

console.log('[A] 破招打出手牌后，场上的牌仍能被问（手牌【朱雀环】→ 场上【黑血刀】场景还原）');
{
  // ⚠️ 2026-10-06：装备的效果改成"按卡文自己的时点发动"（【黑血刀】卡文 = 投掷骰子前），
  //    所以这一幕从"开战窗口"搬到了「我方投骰前」窗口 —— 守的东西没变：
  //    **同一个人打出一张手牌后，他场上的牌不能被误判成"这个人已经出过牌了"而锁死**。
  const { st, A } = setup(5001, { aHandT: ['朱雀环'], aEquip: ['黑血刀'] });
  const m0 = A.mana;
  E.act(st, 'a', { type: 'combat', target: 'b' });
  check('开战窗口不再为【黑血刀】开（它卡文是"投骰前"）', !st.pending, JSON.stringify(st.pending && st.pending.event));
  flush(st);
  E.act(st, 'a', { type: 'roll' });
  check('挂起在「我方投骰前」窗口', !!(st.pending && st.pending.event === 'roll' && st.pending.phase === 'before'),
    JSON.stringify(st.pending && [st.pending.event, st.pending.phase]));
  const mine0 = E.pendingCards(st, A).map((c) => c.name + ':' + c.where).sort().join(',');
  check('候选同时有【朱雀环】（手牌）与【黑血刀】（场上）', /朱雀环:hand/.test(mine0) && /黑血刀:board/.test(mine0), mine0);
  const rp1 = E.act(st, 'a', { type: 'respond_play', uid: A.hand[0].uid });
  check('破招打出【朱雀环】', rp1.ok, JSON.stringify(rp1));
  // 修复前：窗口立刻收掉、直接进投骰（按"人"记已出）；修复后：按 uid 记，场上的黑血刀还在
  check('窗口**没有**收掉（场上还有未发动的牌）', !!st.pending, '');
  check('【黑血刀】仍在候选里', E.pendingCards(st, A).some((c) => c.name === '黑血刀' && c.where === 'board'),
    JSON.stringify(E.pendingCards(st, A)));
  const rp2 = E.act(st, 'a', { type: 'respond_play', uid: A.equip[0].uid });
  check('接着发动【黑血刀】（付 2 点）', rp2.ok, JSON.stringify(rp2));
  check('窗口收掉、两笔费都对（朱雀环 1 + 黑血刀 2 = 3）', !st.pending && A.mana === m0 - 3,
    JSON.stringify({ pending: !!st.pending, mana: A.mana }));
  check('黑血刀的骰点 +2 记进了本场对战（combat.diceBonus = 2）',
    ((st.combat.diceBonus && st.combat.diceBonus[A.id]) || 0) === 2, JSON.stringify(st.combat.diceBonus));
}

console.log('\n[B] 晋升「减消耗」牌的询问时机 + 降尘丹两个时点');
{
  // B1：凡人 → 炼气（消耗 0）—— 不该问【降尘丹】
  const s1 = setup(5002, { aRealm: 0, aQi: 10, aHandT: ['降尘丹'] });
  const r1 = E.act(s1.st, 'a', { type: 'promote' });
  check('消耗为 0 的晋升**不开窗**（不问减消耗牌）', r1.ok && !s1.st.pending, JSON.stringify(r1));
  check('直接晋升炼气期', s1.A.realm === 1, String(s1.A.realm));

  // B2：炼气 → 筑基（消耗 2）—— 该问，且用掉后消耗 -1、抽 1 灵气
  const s2 = setup(5003, { aRealm: 1, aQi: 10, aHandT: ['降尘丹'] });
  // 灵气牌堆换成纯【稀薄灵气】——【充裕灵气】【混杂灵气】会连锁多抽，账算不准（交接文档坑 #3）
  s2.st.decks.qi.draw = s2.st.decks.qi.draw.map(() => PLAIN_QI.id);
  E.act(s2.st, 'a', { type: 'promote' });
  check('消耗 > 0 的晋升开窗', !!s2.st.pending, '');
  check('候选是【降尘丹】', E.pendingCards(s2.st, s2.A).some((c) => c.name === '降尘丹'),
    JSON.stringify(E.pendingCards(s2.st, s2.A)));
  E.act(s2.st, 'a', { type: 'respond_play', uid: s2.A.hand[0].uid });
  const qiAfter = E.qiOf(s2.A);
  check('用掉降尘丹：消耗 2-1=1（10 - 1 + 抽 1 = 10）', qiAfter === 10, String(qiAfter));
  check('晋升筑基期', s2.A.realm === 2, String(s2.A.realm));

  // B3：出牌阶段打出降尘丹 = 放入弃牌堆抽 1 灵气（卡文的第二个时点）
  const s3 = setup(5004, { aRealm: 3, aQi: 3, aHandT: ['降尘丹'] });
  // 同 B2：灵气牌堆换成纯【稀薄灵气】——【充裕灵气】会连锁多抽，抽到的张数就不止 1 了
  s3.st.decks.qi.draw = s3.st.decks.qi.draw.map(() => PLAIN_QI.id);
  const q3 = E.qiOf(s3.A);
  const r3 = E.act(s3.st, 'a', { type: 'play', uid: s3.A.hand[0].uid });
  check('出牌阶段打出【降尘丹】抽 1 张灵气牌', r3.ok && E.qiOf(s3.A) === q3 + 1,
    JSON.stringify({ r: r3, qi: E.qiOf(s3.A) }));
}

console.log('\n[C] 装备付费只看卡文（不再分高低境界）');
{
  // 带「装备时不消耗」→ 装备免费
  const s1 = setup(5005, { aHandT: ['黑血刀'] });
  E.act(s1.st, 'a', { type: 'play', uid: s1.A.hand[0].uid });
  check('【黑血刀】（带免费句）装备不扣法力', s1.A.mana === 12 && s1.A.equip.length === 1, String(s1.A.mana));

  // 没写免费句 + cost 3 → 装备扣 3
  const s2 = setup(5006, { aHandT: ['风雷翅'] });
  E.act(s2.st, 'a', { type: 'play', uid: s2.A.hand[0].uid });
  check('【风雷翅】（无免费句）装备扣 3 点', s2.A.mana === 9 && s2.A.equip.length === 1, String(s2.A.mana));

  // 没写免费句但 cost 0 → 装备不扣（装备消耗 0），效果免费生效
  const s3 = setup(5007, { aHandS: ['长春功'] });
  E.act(s3.st, 'a', { type: 'play', uid: s3.A.hand[0].uid });
  check('【长春功】（无免费句、角标 0）装备不扣法力', s3.A.mana === 12, String(s3.A.mana));

  // 没写免费句 → 装备时付过，对战中效果**不再消耗也不需启用费**（敛气术 flat_power 直接生效）
  const s4 = setup(5008, { aHandS: ['敛气术'] });
  E.act(s4.st, 'a', { type: 'play', uid: s4.A.hand[0].uid });
  check('【敛气术】装备扣 2 点', s4.A.mana === 10, String(s4.A.mana));
  E.act(s4.st, 'a', { type: 'combat', target: 'b' });
  E.act(s4.st, 'a', { type: 'roll' });   // 无响应直通 → 投骰时 activateCombatEquips 结算
  const fp = s4.st.combat && s4.st.combat.flatPower && s4.st.combat.flatPower.a;
  check('本场战力固定为 5（装备时付过，效果免费）', fp === 5, JSON.stringify(s4.st.combat && s4.st.combat.flatPower));
}

console.log('\n[D] 掌天瓶不出现在任何战斗窗口（多余启用费已删）');
{
  const { st, A } = setup(5009, { aEquip: ['掌天瓶'] });
  E.act(st, 'a', { type: 'combat', target: 'b' });
  check('开战窗口没开（掌天瓶没有对战效果）', !st.pending, JSON.stringify(st.pending && st.pending.event));
  E.act(st, 'a', { type: 'roll' });
  check('投骰前窗口也没开（直通投骰）', !st.pending && typeof st.combat.dice.a === 'number',
    JSON.stringify({ pending: !!st.pending, dice: st.combat.dice }));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
