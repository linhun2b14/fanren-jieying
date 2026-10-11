'use strict';
// 条件求值（`if`）单测 —— 重点是**套装 / 联动**这一族：
//   · companion: 'A' / ['A','B']（全在）/ companionAny（任一）
//   · onField / onFieldAny（自己场上：储物袋 + 法术区 + 同行者 + 傀儡，按牌名）
//   · playedThisTurn（本回合自己打出过某张牌，startTurn 清零）
// 为什么单独一套：这些条件很难从"整局动作"里精确制造，而它们决定"两张牌配合才生效"能否写出来。
// 用户 2026-10-02："有些牌和另一张牌一起打出有加成效果；同行者也有满足某两个在场有额外加成。"
const E = require('../server/engine');
const C = require('../server/cards');
const META = require('../server/effect-meta');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const byName = (n) => {
  for (const d of ['treasure', 'spell', 'companion', 'qi']) {
    const c = (C.cards()[d] || []).find((x) => x.name === n);
    if (c) return c;
  }
  return null;
};
const inst = (name, uid) => ({ uid: uid, id: byName(name).id });

/** 造一局：甲、乙，甲场上按 names 放同行者/装备 */
function setup(seed, companions, equips, spells, puppets) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  const A = st.players[0];
  A.companions = (companions || []).map((n, i) => inst(n, 100 + i));
  A.equip = (equips || []).map((n, i) => inst(n, 200 + i));
  A.spells = (spells || []).map((n, i) => inst(n, 300 + i));
  A.puppets = (puppets || []).map((n, i) => inst(n, 400 + i));
  return { st: st, A: A, B: st.players[1] };
}
/** 条件求值：直接调引擎的 matchConditions（本轮为测试导出的） */
const cond = (ifObj, A, st) => E.matchConditions(ifObj, { self: A, state: st });

console.log('[A] companion：单张 / 数组（全在）/ companionAny（任一）');
{
  const { st, A } = setup(9101, ['寒蛟', '离龟']);
  check('单张：场上有【离龟】→ 成立', cond({ companion: '离龟' }, A, st) === true);
  check('单张：场上有【铁火蚁】→ 不成立', cond({ companion: '铁火蚁' }, A, st) === false);
  check('数组：【寒蛟】+【离龟】都在 → 成立', cond({ companion: ['寒蛟', '离龟'] }, A, st) === true);
  check('数组：要【寒蛟】+【铁火蚁】（少一张）→ 不成立', cond({ companion: ['寒蛟', '铁火蚁'] }, A, st) === false);
  check('companionAny：任一在 → 成立', cond({ companionAny: ['铁火蚁', '离龟'] }, A, st) === true);
  check('companionAny：都不在 → 不成立', cond({ companionAny: ['铁火蚁', '李化元'] }, A, st) === false);

  const empty = setup(9102, []).A;
  const st2 = setup(9102, []).st;
  check('空场：单张不成立', cond({ companion: '离龟' }, empty, st2) === false);
  check('空场：空数组不成立（别把"没有条件"当成立）', cond({ companion: [] }, empty, st2) === false);
}

console.log('\n[B] onField / onFieldAny：自己场上有该牌（装备 + 法术区 + 同行者 + 傀儡）');
{
  const { st, A } = setup(9103, ['离龟'], ['绿煌剑'], ['青元剑诀'], ['傀儡蜥蜴']);
  check('储物袋里的【绿煌剑】算在场', cond({ onField: '绿煌剑' }, A, st) === true);
  check('法术区的【青元剑诀】算在场', cond({ onField: '青元剑诀' }, A, st) === true);
  check('同行者【离龟】算在场', cond({ onField: '离龟' }, A, st) === true);
  check('傀儡【傀儡蜥蜴】算在场', cond({ onField: '傀儡蜥蜴' }, A, st) === true);
  check('手里没有的牌不算在场', cond({ onField: '黑血刀' }, A, st) === false);
  check('数组：两张都在 → 成立', cond({ onField: ['绿煌剑', '青元剑诀'] }, A, st) === true);
  check('数组：缺一张 → 不成立', cond({ onField: ['绿煌剑', '黑血刀'] }, A, st) === false);
  check('onFieldAny：任一在 → 成立', cond({ onFieldAny: ['黑血刀', '离龟'] }, A, st) === true);
  check('onFieldAny：都不在 → 不成立', cond({ onFieldAny: ['黑血刀', '踏云靴'] }, A, st) === false);
}

console.log('\n[C] playedThisTurn：本回合打出过某张牌（"和另一张牌配合"）');
{
  const { st, A, B } = setup(9104, []);
  const PLENISH = byName('补气丹');
  check('还没打出过 → 不成立', cond({ playedThisTurn: '补气丹' }, A, st) === false);
  E.markPlayed(st, A, PLENISH);
  check('打出后 → 成立', cond({ playedThisTurn: '补气丹' }, A, st) === true);
  check('别的牌没打过 → 不成立', cond({ playedThisTurn: '回气丹' }, A, st) === false);
  check('数组：打出过其中任一张 → 成立', cond({ playedThisTurn: ['回气丹', '补气丹'] }, A, st) === true);
  check('别人的"本回合"互不干扰（乙没打过）', cond({ playedThisTurn: '补气丹' }, B, st) === false);
  // 新回合清零：乙结束回合 → 下一次 startTurn 该清空"本回合打出过"
  st.turn = 1; st.step = 'action';
  E.act(st, B.id, { type: 'end_turn' });
  check('新回合开始后清零（甲本回合还没打过牌）', cond({ playedThisTurn: '补气丹' }, A, st) === false,
    JSON.stringify(st.turnPlayed));
}

console.log('\n[D] 旧条件没被改坏 + 元数据登记');
{
  const { st, A } = setup(9105, ['寒蛟'], ['绿煌剑']);
  check('hasEquip 仍然好用', cond({ hasEquip: true }, A, st) === true);
  check('多条件 AND：hasEquip + companion 同时成立', cond({ hasEquip: true, companion: '寒蛟' }, A, st) === true);
  check('多条件 AND：一个不成立就整体不成立', cond({ hasEquip: true, companion: '铁火蚁' }, A, st) === false);
  const conds = META.meta().conditions;
  for (const k of ['companion', 'companionAny', 'onField', 'onFieldAny', 'playedThisTurn']) {
    check(`元数据登记了条件 ${k}`, !!conds[k], Object.keys(conds).join(','));
  }
  check('真卡池里的【寒蛟】"与【离龟】同场"用的是 companion 条件（单张写法继续有效）',
    (byName('寒蛟').effects || []).some((e) => e.if && e.if.companion === '离龟'));
  check('【陈巧倩】的"指定丹药效果翻倍"仍在（double_card_effect 是另一种套装写法）',
    (byName('陈巧倩').effects || []).some((e) => e.op === 'double_card_effect' && (e.names || []).length >= 2));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
