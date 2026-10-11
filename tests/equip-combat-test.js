'use strict';
// 装备（法宝/法术）在**场上**的发动时机回归 —— 2026-10-06 用户报：
//   「装备牌在场上的发动时机你再检查一遍，如绿煌剑，战胜时发动的效果被移到对战开始时就触发时点」
//
// 病根：有 7 张装备把「卡文写在某个时点发动」的效果做成了**开战时统一付费启用**（`enable_equip_combat`
// + 常驻生效），于是【绿煌剑】"在对战获胜时"的 3 点费被问在**开战**那一刻（赢不赢都得先付），
// 【黑血刀】"投掷骰子前"+2 也变成开战时付一次、之后常驻。
// 规则依据（用户自己的裁定，`规则文档.md` §7.4）：装备免费；**发动其效果时才消耗（费用印在效果上）**，
// 「到时点时会问」；§7.47【虚天鼎】就是这条规则的样板。
//
// 本套件守两件事：
//   ① 卡池不变量：**没有任何**开战启用费；「卡文带『装备时不消耗【法力值】』且角标>0」的装备，
//      它的每条对战效果都必须自带 `manaCost = 角标`（费用印在效果上）。
//   ② 行为：费用在**效果自己的时点**问、当场扣；【绿煌剑】只在获胜结算时问；
//      `dice_bonus` 改的是**骰点**（写进 combat.diceBonus），不是战力。
const E = require('../server/engine');
const C = require('../server/cards');
const M = require('../server/effect-meta');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const T = (n) => [].concat(C.cards().treasure, C.cards().spell).find((c) => c.name === n);
const logText = (st) => st.log.map((l) => l.text).join('\n');
const flush = (st) => { let g = 0; while (st.pending && g++ < 20) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };
const plainQi = (st) => {
  const plain = C.cards().qi.find((c) => c.name === '稀薄灵气').id;
  st.decks.qi.draw = [];
  for (let i = 0; i < 60; i++) st.decks.qi.draw.push(plain);
};
/** 造局：清空双方手牌/场上，甲、乙同境界（结丹）好开战 */
function setup(seed, o) {
  o = o || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  st.players.forEach((q) => { q.turnsTaken = 2; });
  const A = st.players[0], B = st.players[1];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  A.realm = o.realm == null ? 3 : o.realm; B.realm = A.realm;
  A.mana = o.mana == null ? 12 : o.mana; B.mana = 12;
  A.hp = 6; B.hp = 6;
  A.hand = []; B.hand = []; A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = []; A.puppets = []; B.puppets = [];
  plainQi(st);
  if (o.aEquip) o.aEquip.forEach((n, i) => A.equip.push({ uid: 7000 + i, id: T(n).id }));
  if (o.bEquip) o.bEquip.forEach((n, i) => B.equip.push({ uid: 7100 + i, id: T(n).id }));
  if (o.aHand) o.aHand.forEach((n, i) => A.hand.push({ uid: 7200 + i, id: T(n).id }));
  return { st: st, A: A, B: B };
}

// ================================================================ A 卡池不变量
console.log('[A] 卡池不变量：费用印在效果上，不再有"开战启用费"');
{
  const all = [].concat(C.cards().treasure || [], C.cards().spell || []).filter((d) => d.type === 'equip');
  const withFee = all.filter((d) => (d.effects || []).some((e) => e.op === 'enable_equip_combat'));
  check('全池没有任何 `enable_equip_combat`（开战统一启用已删干净）',
    withFee.length === 0, withFee.map((d) => d.name).join('、'));

  // 「卡文带『装备时不消耗【法力值】』+ 角标>0」= 装备免费、发动效果才消耗 ⇒ 每条效果自带 manaCost
  const bad = [];
  for (const d of all) {
    if (!/装备时不消耗/.test(d.text || '') || (d.cost || 0) <= 0) continue;
    const effs = (d.effects || []);
    for (const e of effs) {
      const t = M.timingOfEffect(e);
      if (!t && e.when !== 'standing') continue;                 // 非时点效果（如常驻修正）不管
      if ((e.manaCost || 0) !== (d.cost || 0)) bad.push(d.name + '/' + e.op + '=' + (e.manaCost == null ? '无' : e.manaCost));
    }
  }
  check('「装备免费、发动效果才消耗」的装备：每条效果的 manaCost = 角标',
    bad.length === 0, bad.join('、'));
  const named = ['绿煌剑', '黑血刀', '青竹蜂云剑', '青竹蜂云剑 辟邪神雷', '金蚨子母刃', '七鬼珠'];
  const feeOn = named.filter((n) => {
    const d = T(n);
    return (d.effects || []).some((e) => (e.manaCost || 0) === (d.cost || 0) && M.timingOfEffect(e));
  });
  check('6 张被点名的装备都把费用印在效果上了', feeOn.length === named.length,
    named.filter((n) => feeOn.indexOf(n) < 0).join('、'));
}

// ================================================================ B 【绿煌剑】只在"获胜结算"时问
console.log('\n[B] 【绿煌剑】：开战时**不**问，获胜结算时才问「花 3 点让对方额外受 1 点伤害吗」');
{
  const run = (seed, pay) => {
    const { st, A, B } = setup(seed, { aEquip: ['绿煌剑'] });
    st.forcedDice = [6, 1];                       // 甲 6、乙 1 → 甲赢
    E.act(st, A.id, { type: 'combat', target: B.id });
    const atStart = st.pending;                   // 开战那一刻的窗口（新规则：不该有）
    flush(st);
    E.act(st, A.id, { type: 'roll' });
    flush(st);
    E.act(st, B.id, { type: 'roll' });
    const resWin = st.pending;
    const cands = resWin ? E.pendingCards(st, A).map((c) => ({ name: c.name, cost: c.cost, where: c.where })) : [];
    const manaBefore = A.mana;
    let used = null;
    if (pay && resWin) used = E.act(st, A.id, { type: 'respond_play', uid: A.equip[0].uid });
    flush(st);
    return { st: st, A: A, B: B, atStart: atStart, resWin: resWin, cands: cands, used: used, manaBefore: manaBefore };
  };

  const win = run(9401, true);
  check('开战时**没有**为【绿煌剑】开窗（以前就是在这里问"启用费"）', !win.atStart,
    JSON.stringify(win.atStart && win.atStart.event));
  check('打赢后开出「对战结果」窗口（这一环结算之前给机会）',
    !!(win.resWin && win.resWin.event === 'combatResult'), JSON.stringify(win.resWin && win.resWin.event));
  check('候选里有【绿煌剑】，费用 3、来自场上（发动）',
    win.cands.some((c) => c.name === '绿煌剑' && c.cost === 3 && c.where === 'board'), JSON.stringify(win.cands));
  check('付费发动成功', !!(win.used && win.used.ok), JSON.stringify(win.used));
  check('当场扣了 3 点法力（12 → 9）', win.A.mana === win.manaBefore - 3, `${win.manaBefore} -> ${win.A.mana}`);
  check('战报写明【绿煌剑】的获胜效果生效', /【绿煌剑】/.test(logText(win.st)), logText(win.st).slice(-160));
  const winHp = win.B.hp;

  const skip = run(9402, false);
  check('（对照）不付费：窗口照开、候选照在', !!(skip.resWin && skip.cands.some((c) => c.name === '绿煌剑')),
    JSON.stringify([skip.resWin && skip.resWin.event, skip.cands]));
  check('不付费 → 一分法力都不扣', skip.A.mana === skip.manaBefore, `${skip.manaBefore} -> ${skip.A.mana}`);
  check('不付费 → 那 1 点额外伤害不落地（比付费少掉 1 血）', skip.B.hp === winHp + 1, `${winHp} vs ${skip.B.hp}`);
  check('不付费 → 战报里没有【绿煌剑】生效', !/【绿煌剑】/.test(logText(skip.st)), logText(skip.st).slice(-160));
  console.log('  付费后乙血量 = ' + winHp + '，不付费 = ' + skip.B.hp + '（差额就是【绿煌剑】那 1 点）');
}

// ================================================================ C 【黑血刀】在"投骰前"问，且改的是骰点
console.log('\n[C] 【黑血刀】：我方投骰前才问，付费后**骰点** +2（不是战力 +2）');
{
  const { st, A, B } = setup(9403, { aEquip: ['黑血刀'] });
  st.forcedDice = [2, 5];                        // 甲 2（+2 → 4）、乙 5
  E.act(st, A.id, { type: 'combat', target: B.id });
  check('开战时**不**问【黑血刀】', !st.pending, JSON.stringify(st.pending && st.pending.event));
  flush(st);
  E.act(st, A.id, { type: 'roll' });
  check('挂起在【斗法】窗口（先问要不要发动）',
    !!(st.pending && st.pending.event === 'roll' && st.pending.phase === 'before'),
    JSON.stringify(st.pending && [st.pending.event, st.pending.phase]));
  const cands = st.pending ? E.pendingCards(st, A).map((c) => ({ name: c.name, cost: c.cost })) : [];
  check('候选里有【黑血刀】，费用 2', cands.some((c) => c.name === '黑血刀' && c.cost === 2), JSON.stringify(cands));
  const m0 = A.mana;
  const r = E.act(st, A.id, { type: 'respond_play', uid: A.equip[0].uid });
  check('付费发动成功', r.ok, JSON.stringify(r));
  check('扣了 2 点法力', A.mana === m0 - 2, `${m0} -> ${A.mana}`);
  check('加成写进 **骰点**（combat.diceBonus = 2），不是战力 bonus',
    (st.combat.diceBonus[A.id] || 0) === 2 && !(st.combat.bonus[A.id] || 0),
    JSON.stringify({ diceBonus: st.combat.diceBonus, bonus: st.combat.bonus }));
  flush(st);
  E.act(st, B.id, { type: 'roll' });
  flush(st);
  // 对战一结算 `state.combat` 就清空了 —— 总战力从【结算】那条战报的 payload 里取
  const payload = (st.log.filter((l) => l.kind === 'combat_total' && l.payload && l.payload.a).pop() || {}).payload || {};
  const a = payload.a || {};
  console.log('  甲：基础 ' + a.base + ' + 骰点附加 ' + a.dice + ' = ' + a.total + '（骰 2 被 +2 成 4 点 → 查表附加 +1）');
  check('骰点 2 被 +2 成 4 → 查表附加 +1（战力 = 基础 +1）',
    a.dice === 1 && a.total === a.base + 1, JSON.stringify(a));
}

// ================================================================ D 无费的窗口效果也只改骰点（【蓝丝剑】）
console.log('\n[D] 【蓝丝剑】（0 费）：走时点窗口发动，同样改骰点而不是战力');
{
  const { st, A, B } = setup(9404, { aEquip: ['蓝丝剑'] });
  st.forcedDice = [6, 1];
  E.act(st, A.id, { type: 'combat', target: B.id });
  flush(st);
  E.act(st, A.id, { type: 'roll' });
  const cands = st.pending ? E.pendingCards(st, A).map((c) => ({ name: c.name, cost: c.cost })) : [];
  check('投骰前窗口里有【蓝丝剑】（0 费也照问 —— 卡文写「使用」）',
    cands.some((c) => c.name === '蓝丝剑' && c.cost === 0), JSON.stringify(cands));
  const r = E.act(st, A.id, { type: 'respond_play', uid: A.equip[0].uid });
  check('发动成功且不扣法力', r.ok && A.mana === 12, JSON.stringify([r, A.mana]));
  check('骰点 +1 写进 diceBonus（不是 bonus）',
    (st.combat.diceBonus[A.id] || 0) === 1 && !(st.combat.bonus[A.id] || 0),
    JSON.stringify({ diceBonus: st.combat.diceBonus, bonus: st.combat.bonus }));
}

// ================================================================ E "没写免费句"的装备：装备时付费、对战免费
console.log('\n[E] 卡文**没写**「装备时不消耗」的装备：装备时付角标，对战里不再问、不再扣');
{
  const { st, A, B } = setup(9405, {});
  const def = T('风雷翅');                       // 卡文（装备时消耗3点【法力值】)
  A.hand.push({ uid: 7300, id: def.id });
  const m0 = A.mana;
  const eq = E.act(st, A.id, { type: 'play', uid: 7300 });
  check(`【风雷翅】装备时付了角标 ${def.cost} 点`, eq.ok && A.mana === m0 - (def.cost || 0),
    `${m0} -> ${A.mana}`);
  const m1 = A.mana;
  st.forcedDice = [1, 6];                        // 甲 1、乙 6 → 甲败（触发风雷翅的失败免罚）
  E.act(st, A.id, { type: 'combat', target: B.id });
  check('开战时不为它开窗（对战免费）', !st.pending, JSON.stringify(st.pending && st.pending.event));
  flush(st);
  E.act(st, A.id, { type: 'roll' }); flush(st);
  E.act(st, B.id, { type: 'roll' });
  flush(st);
  check('对战过程中没有再扣它的费', A.mana === m1, `${m1} -> ${A.mana}`);
  check('失败时的免罚照样自动生效（卡文没写"可选择"，且不花法力）',
    /【风雷翅】|罗烟步|身法|免罚|不受本次对战失败的惩罚/.test(logText(st)), logText(st).slice(-200));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
