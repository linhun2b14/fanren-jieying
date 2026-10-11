'use strict';
// 第三批同行者/宝物效果回归：按实物卡文补的「获胜时 / 受伤时 / 放置时」效果。
const E = require('../server/engine');
const C = require('../server/cards');
const { effOf, effsOf, opOf, META } = require('./fixtures');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const comp = (n) => C.cards().companion.find((c) => c.name === n);

function setup(seed, myNames, foeNames) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = 4; B.realm = 4; A.mana = 6; B.mana = 6; A.hp = 6; B.hp = 4;
  A.hand = []; B.hand = []; A.equip = []; B.equip = []; A.spells = []; B.spells = []; A.companions = []; B.companions = [];
  A.qiCards = []; B.qiCards = [];
  let uid = 8000;
  for (const n of (myNames || [])) A.companions.push({ uid: ++uid, id: comp(n).id });
  for (const n of (foeNames || [])) B.companions.push({ uid: ++uid, id: comp(n).id });
  return { st: st, A: A, B: B };
}
const win = (st, A, B) => E.runOnWinEffects(st, {}, A, B);
const logText = (st) => st.log.map((l) => l.text).join(' | ');
const qi = (p) => p.qiCards.length;
/** 把灵气牌堆换成不会连锁的【稀薄灵气】—— 否则抽到【混杂灵气】会多抽，数字断言就漂了 */
function plainQiDeck(st) {
  const plain = C.cards().qi.find((c) => c.name === '稀薄灵气').id;
  st.decks.qi.draw = [];
  for (let i = 0; i < 60; i++) st.decks.qi.draw.push(plain);
}

console.log('[0] 卡池字段核对（按卡文，读 effects DSL）');
// 条件化之后不再有 combat_bonus_if_* 这类 kind —— 条件进了 if
// ⚠️ 时机比较**必须走归一化键**（`META.timingKey({when})` vs `META.timingKeys(e)`）：
//    2026-10-02 卡池从旧 `when` 迁到总线坐标，写死 `e.when === 'win'` 的断言会全部假红。
const effAt = (name, op, whenName) => effsOf(comp(name)).find((e) =>
  e.op === op && META.timingKeys(e).indexOf(META.timingKey({ when: whenName })) >= 0) || null;
const winOp = (name, op) => !!effAt(name, op, 'win');
const winVal = (name, op) => { const e = effAt(name, op, 'win'); return e ? (e.value || 1) : null; };
const placeOp = (name, op) => !!effAt(name, op, 'place');
const placeVal = (name, op) => { const e = effAt(name, op, 'place'); return e ? (e.value || 1) : null; };
check('火龙童子 获胜回 4 法力', winVal('火龙童子', 'mana') === 4, String(winVal('火龙童子', 'mana')));
// op 参数化合族（2026-10-05）：抽牌 = draw + deck，封锁 = block_draw + deck，旧 op 名只读旧备份
const winDrawQi = (name) => { const e = effAt(name, 'draw', 'win'); return !!e && e.deck === 'qi' ? (e.value || 1) : null; };
const placeDraw = (name, deck) => { const e = effAt(name, 'draw', 'place'); return !!e && e.deck === deck ? (e.value || 1) : null; };
check('宋玉 获胜回 1 法力 + 抽 1 灵气牌', winVal('宋玉', 'mana') === 1 && winDrawQi('宋玉') === 1);
check('噬金虫 获胜抽 1 灵气牌', winDrawQi('噬金虫') === 1);
check('王蝉 获胜抽 1 灵气牌', winDrawQi('王蝉') === 1);
check('韩立 获胜夺 1 张装备', winVal('韩立', 'steal_equip') === 1);
check('三目豹 获胜弃对方装备', winVal('三目豹', 'discard_enemy_equip') === 1);
check('血玉蜘蛛 放置时抽 3 张宝物牌', placeDraw('血玉蜘蛛', 'treasure') === 3, JSON.stringify(effOf(comp('血玉蜘蛛'), 'place')));
check('血玉蜘蛛 获胜回 2 法力', winVal('血玉蜘蛛', 'mana') === 2);
check('铁火蚁 放置时抽 1 灵气牌 且 absorb = 1', placeDraw('铁火蚁', 'qi') === 1 && comp('铁火蚁').absorb === 1);
check('离龟 放置时额外 1 次过关机会', placeOp('离龟', 'extra_seclusion') && placeVal('离龟', 'extra_seclusion') === 1);
check('慕沛灵 受伤回 1 法力（不是回血）', opOf(comp('慕沛灵'), 'hurt') === 'mana' && effOf(comp('慕沛灵'), 'hurt').value === 1,
  JSON.stringify(effsOf(comp('慕沛灵'))));
check('燕如嫣 受伤回 2 法力', opOf(comp('燕如嫣'), 'hurt') === 'mana' && effOf(comp('燕如嫣'), 'hurt').value === 2);
check('元瑶 濒危自救回 2 点并弃置自身',
  opOf(comp('元瑶'), 'lowHp') === 'low_hp_rescue' && effOf(comp('元瑶'), 'lowHp').value === 2 && effOf(comp('元瑶'), 'lowHp').discardSelf === true);
// 2026-10-04 按实物卡面改：≥4 血 → **骰子点数**+1（最高6）；≤3 血 → 战力+1。
check('蛮胡子 有两条对战效果（≥4 骰点 / ≤3 战力）',
  effsOf(comp('蛮胡子')).filter((e) => e.op === 'dice_bonus' && e.cap === 6 && e.if && e.if.hp && e.if.hp.gte === 4).length === 1 &&
  effsOf(comp('蛮胡子')).filter((e) => e.op === 'combat_bonus' && e.if && e.if.hp && e.if.hp.lte === 3).length === 1,
  JSON.stringify(effsOf(comp('蛮胡子'))));
check('寒蛟 与离龟同场时战力+1 变成了 if.companion 条件',
  effsOf(comp('寒蛟')).some((e) => e.op === 'combat_bonus' && e.if && e.if.companion === '离龟'),
  JSON.stringify(effsOf(comp('寒蛟'))));
check('寒蛟 获胜时封锁对方抽同行者/法术',
  (function () {
    const a = effAt('寒蛟', 'block_draw', 'win');
    const bs = effsOf(comp('寒蛟')).filter((e) => e.op === 'block_draw' && META.timingKeys(e).indexOf(META.timingKey({ when: 'win' })) >= 0);
    const decks = bs.map((e) => e.deck).sort().join('/');
    return decks === 'companion/spell' && bs.every((e) => (e.value || 1) === 1) && !!a;
  })(),
  JSON.stringify(effsOf(comp('寒蛟')).filter((e) => e.op === 'block_draw')));
check('花篮 改为取走全部装备', effOf(C.cards().treasure.find((c) => c.name === '花篮'), 'play').count === 'all');

console.log('\n[A] 获胜时回法力 / 抽灵气牌');
{
  const { st, A, B } = setup(7001, ['火龙童子'], []);
  A.mana = 2; const q0 = qi(A);
  win(st, A, B);
  check('火龙童子：获胜回 4 点法力（2 -> 6）', A.mana === 6, String(A.mana));

  const s2 = setup(7002, ['宋玉'], []);
  plainQiDeck(s2.st);
  s2.A.mana = 2; const q = qi(s2.A);
  win(s2.st, s2.A, s2.B);
  check('宋玉：获胜回 1 法力并抽 1 张灵气牌', s2.A.mana === 3 && qi(s2.A) === q + 1, `mana=${s2.A.mana} qi=${qi(s2.A)}->${q}`);

  const s3 = setup(7003, ['噬金虫', '王蝉'], []);
  const q3 = qi(s3.A);
  win(s3.st, s3.A, s3.B);
  // 【天地灵气】抽 2 张、【充裕灵气】抽 1 张，会连锁抽下去，所以只断言「至少 +2」
  check('噬金虫 + 王蝉：各抽 1 张灵气牌（连锁后 ≥ +2）', qi(s3.A) >= q3 + 2, `${q3} -> ${qi(s3.A)}`);
  check('战报出现两条获胜抽牌效果', (logText(s3.st).match(/噬金虫|王蝉/g) || []).length >= 2, '');
}

console.log('\n[B] 获胜时掠夺 / 弃置对方装备');
{
  const { st, A, B } = setup(7004, ['韩立'], []);
  const sword = C.cards().treasure.find((c) => c.type === 'equip');
  const sword2 = C.cards().treasure.filter((c) => c.type === 'equip')[1];
  B.equip = [{ uid: 9101, id: sword.id }, { uid: 9102, id: sword2.id }];
  const h0 = A.hand.length;
  win(st, A, B);
  check('韩立：从对方储物袋取走 1 张装备', A.hand.length === h0 + 1 && B.equip.length === 1, `A手牌 ${h0}->${A.hand.length}, B装备 ${B.equip.length}`);

  const s2 = setup(7005, ['三目豹'], []);
  s2.B.equip = [{ uid: 9201, id: sword.id }];
  win(s2.st, s2.A, s2.B);
  check('三目豹：指定对方 1 张装备放入弃牌堆', s2.B.equip.length === 0 && s2.A.hand.length === 0, `B装备=${s2.B.equip.length} A手牌=${s2.A.hand.length}`);

  // 花篮：取走全部
  const s3 = setup(7006, [], []);
  s3.B.equip = [{ uid: 9301, id: sword.id }, { uid: 9302, id: sword2.id }];
  s3.A.hand = [{ uid: 9400, id: C.cards().treasure.find((c) => c.name === '花篮').id }];
  s3.st.turn = 0; s3.st.step = 'action'; s3.st.turnFlags = { combat: false, promote: false };
  const r = E.act(s3.st, 'a', { type: 'play', uid: 9400, target: 'b' });
  check('花篮打出成功', r.ok, JSON.stringify(r));
  check('花篮：取走对方全部 2 张装备', s3.A.hand.length === 2 && s3.B.equip.length === 0, `A手牌=${s3.A.hand.length} B装备=${s3.B.equip.length}`);
}

console.log('\n[C] 放置时效果（抽宝物牌 / 抽灵气牌 / 额外过关）');
{
  // 血玉蜘蛛：抽 3 张宝物牌
  const { st, A } = setup(7007, [], []);
  A.hand = [{ uid: 9501, id: comp('血玉蜘蛛').id }];
  const h0 = A.hand.length;
  check('打出【血玉蜘蛛】成功', E.act(st, 'a', { type: 'play', uid: 9501 }).ok);
  check('放置时抽 3 张宝物牌（手牌 -1+3）', A.hand.length === h0 + 2, `${h0} -> ${A.hand.length}`);
  check('抽到的是宝物牌', A.hand.every((c) => C.cards().treasure.some((t) => t.id === c.id)), '');

  // 铁火蚁：抽 1 张灵气牌
  const s2 = setup(7008, [], []);
  plainQiDeck(s2.st);
  s2.A.hand = [{ uid: 9601, id: comp('铁火蚁').id }];
  const q0 = qi(s2.A);
  check('打出【铁火蚁】成功', E.act(s2.st, 'a', { type: 'play', uid: 9601 }).ok);
  check('放置时抽 1 张灵气牌', qi(s2.A) === q0 + 1, `${q0} -> ${qi(s2.A)}`);

  // 离龟：额外过关机会
  const s3 = setup(7009, [], []);
  s3.A.hand = [{ uid: 9701, id: comp('离龟').id }];
  check('打出【离龟】成功', E.act(s3.st, 'a', { type: 'play', uid: 9701 }).ok);
  check('seclusionMax 变成 2', s3.A.seclusionMax === 2, String(s3.A.seclusionMax));
  // 闭关会立刻结束本回合并换人，所以要手动把回合切回甲来模拟「下一次自己的回合」
  const backToA = () => { s3.st.turn = 0; s3.st.step = 'draw_qi'; s3.st.turnFlags = { combat: false, promote: false }; };
  backToA();
  check('第一次过关成功', E.act(s3.st, 'a', { type: 'seclusion' }).ok);
  backToA();
  check('第二次过关仍然成功（额外机会）', E.act(s3.st, 'a', { type: 'seclusion' }).ok);
  check('第二次后 seclusionUsed = 2', s3.A.seclusionUsed === 2, String(s3.A.seclusionUsed));
  backToA();
  const third = E.act(s3.st, 'a', { type: 'seclusion' });
  check('第三次过关被拒', !third.ok, JSON.stringify(third));
  check('拒绝理由说明次数已用完', /次数已用完/.test(third.error || ''), third.error);
}

console.log('\n[D] 受伤时回法力（慕沛灵/燕如嫣）/ 濒危自救（元瑶）');
{
  // 【慕沛灵】第 2 条 = 受伤回 1 点法力值（用户裁定，不是回血）
  const { st, A } = setup(7010, ['慕沛灵'], []);
  A.hp = 4; A.mana = 0;
  E.applyDamage(st, A, 2, 'test');
  check('慕沛灵：掉 2 血后回 1 点法力（0 -> 1）', A.mana === 1, String(A.mana));
  check('慕沛灵：掉 2 血就是掉 2 血，不回血（4 -> 2）', A.hp === 2, String(A.hp));
  check('战报写明受伤回法力', /受伤后恢复 1 点法力值/.test(logText(st)), '');

  // 对照：【燕如嫣】受伤回 2 点法力
  const s4 = setup(7017, ['燕如嫣'], []);
  s4.A.mana = 0; s4.A.hp = 5;
  E.applyDamage(s4.st, s4.A, 1, 'test');
  check('燕如嫣：掉 1 血后回 2 点法力（0 -> 2）', s4.A.mana === 2, String(s4.A.mana));

  // 元瑶：生命归零时自救
  const s2 = setup(7011, ['元瑶'], []);
  s2.A.hp = 3;
  E.applyDamage(s2.st, s2.A, 3, 'test');
  check('元瑶：生命归零时自救到 2 点', s2.A.hp === 2, String(s2.A.hp));
  check('元瑶：未出局', !s2.A.out, String(s2.A.out));
  check('元瑶：用后离场进弃牌堆', s2.A.companions.length === 0, String(s2.A.companions.length));
  // 自救效果只能用一次
  E.applyDamage(s2.st, s2.A, 2, 'test');
  check('元瑶用尽后再次归零即出局', s2.A.out === true, String(s2.A.out));

  // 对照：没有元瑶时直接出局
  const s3 = setup(7012, [], []);
  s3.A.hp = 2;
  E.applyDamage(s3.st, s3.A, 2, 'test');
  check('无元瑶时生命归零即出局', s3.A.out === true);
}

console.log('\n[E] 对战战力：寒蛟+离龟、蛮胡子的双段条件');
{
  const { st, A } = setup(7013, ['寒蛟', '离龟'], []);
  check('寒蛟与离龟同场 → 战力 +1', E.companionCombat(st, A, null).bonus === 1, JSON.stringify(E.companionCombat(st, A, null)));
  const s2 = setup(7014, ['寒蛟'], []);
  check('只有寒蛟、没有离龟 → 无加成', E.companionCombat(s2.st, s2.A, null).bonus === 0, JSON.stringify(E.companionCombat(s2.st, s2.A, null)));

  const s3 = setup(7015, ['蛮胡子'], []);
  s3.A.hp = 6;
  check('蛮胡子：生命 ≥4 时骰子点数 +1（按实物卡面）', (function () {
    const cb = E.companionCombat(s3.st, s3.A, s3.st.combat);
    return (cb.diceBonus || 0) === 1 && (cb.bonus || 0) === 0;
  })(), JSON.stringify(E.companionCombat(s3.st, s3.A, s3.st.combat)));
  check('蛮胡子：生命 ≤3 时战力 +1（第二条效果，按实物卡面）', (function () {
    s3.A.hp = 3;
    const cb = E.companionCombat(s3.st, s3.A, s3.st.combat);
    return (cb.bonus || 0) === 1 && (cb.diceBonus || 0) === 0;
  })(), JSON.stringify((function () { s3.A.hp = 3; return E.companionCombat(s3.st, s3.A, s3.st.combat); })()));
  check('蛮胡子：两条效果的 value 都是**数字**（字符串会算成 NaN）',
    effsOf(comp('蛮胡子')).every((e) => typeof e.value === 'number'),
    JSON.stringify(effsOf(comp('蛮胡子')).map((e) => e.value)));
}

console.log('\n[F] 封锁抽牌真的生效（寒蛟获胜后）');
{
  const { st, A, B } = setup(7016, ['寒蛟'], []);
  win(st, A, B);
  check('乙被封锁 1 回合法术牌', B.blockSpellDraw === 1, String(B.blockSpellDraw));
  check('乙被封锁 1 回合同行者牌', B.blockCompanionDraw === 1, String(B.blockCompanionDraw));
  // 让乙走到选牌阶段
  st.turn = 1; st.step = 'choose_draw'; st.turnFlags = { combat: false, promote: false };
  const rSpell = E.act(st, 'b', { type: 'choose_draw', deck: 'spell' });
  check('乙抽法术牌被拒', !rSpell.ok, JSON.stringify(rSpell));
  const rComp = E.act(st, 'b', { type: 'choose_draw', deck: 'companion' });
  check('乙抽同行者也已被拒', !rComp.ok, JSON.stringify(rComp));
  check('拒绝理由提到「封锁」', /封锁/.test(rSpell.error || ''), rSpell.error);
}

console.log('\n[G] 卡池里**每一张**同行者都必须能从手牌放下来');
{
  // 回归守卫：效果 DSL 重构时，【韩立】的 win 效果（steal_equip 需要目标）
  // 被误当成"打出时效果"，导致他根本放不到场上（报"需要先指定一位目标修士"）。
  // 同行者的 win/lose/turn 等窗口都是**场面自动触发**，不是出牌窗口。
  const bad = [];
  for (const def of C.cards().companion) {
    const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 7020 });
    E.beginGame(st);
    st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
    const A = st.players[0];
    A.realm = 4; A.mana = 12; A.hp = 6; A.qiCards = [];
    A.equip = []; A.spells = []; A.companions = [];
    A.hand = [{ uid: 1, id: def.id }];
    // 占 2 位的卡需要 2 个位子，结丹期以上已有 2 位，够
    const r = E.act(st, 'a', { type: 'play', uid: 1 });
    if (!r.ok) bad.push(def.name + ' → ' + r.error);
  }
  check(`全部 ${C.cards().companion.length} 张同行者都能从手牌放下`, bad.length === 0, bad.join(' | '));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
