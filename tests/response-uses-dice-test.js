'use strict';
/**
 * 2026-10-05 用户裁定的四条（蓝图式编辑的地基）的回归：
 *
 *  [A] 「应对」——**只有带应对的卡/效果才能进【斗法】链**（能被破招）；
 *      并且只在**响应型窗口**（被指定为目标/对战可选发动/对方出牌/投骰前后/对战结算/受伤）上问，
 *      「阶段内可选型」窗口（探索替换、晋升减消耗…）不算破招、不问应对。
 *  [B] 「可用 N 次」——卡面"此【宝物牌】可使用2次"，用完不再摆出来问。
 *  [C] 「掷骰分支」——roll_branch：一个掷骰节点按点数分支，子效果支持 `"$face"` / `"$lostHp"` 占位符。
 *  [D] 「先攻判据」——`if:{attacker:true}`：本场对战是我主动发起的才成立。
 */
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const logText = (st) => st.log.map((l) => l.text).join(' | ');

const PLAIN_QI = C.cards().qi[0];

let UID = 9000;
function setup(seed, o) {
  o = o || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = o.aRealm == null ? 3 : o.aRealm;
  B.realm = o.bRealm == null ? 3 : o.bRealm;
  A.mana = 12; B.mana = 12; A.hp = o.aHp == null ? 6 : o.aHp; B.hp = 6;
  A.qiCards = []; B.qiCards = []; A.hand = []; B.hand = [];
  A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = []; A.puppets = []; B.puppets = [];
  st.decks.qi.draw = st.decks.qi.draw.map(() => PLAIN_QI.id);
  for (const nm of (o.aHand || [])) A.hand.push({ uid: ++UID, id: C.cards().treasure.concat(C.cards().spell).find((c) => c.name === nm).id });
  for (const nm of (o.bHand || [])) B.hand.push({ uid: ++UID, id: C.cards().treasure.concat(C.cards().spell).find((c) => c.name === nm).id });
  return { st: st, A: A, B: B };
}
/** 把窗口里所有表态人都放弃掉（清场） */
const flushAll = (st) => { let g = 0; while (st.pending && g++ < 30) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };

// ---------------------------------------------------------------- 注入测试卡
// 卡池是**进程级缓存**，测试可以直接 push（同 mechanisms-v6 的做法）；本文件是独立进程，不影响别人。
const T = (deck, card) => { C.cards()[deck].push(card); return card.id; };

// A 用：同形状两张，只有一张带应对
const NO_RESP = T('treasure', {
  id: 'test_no_response', name: '测试·无应对', type: 'consume', cost: 0, realm: 0, count: 1, cat: '消耗类法器',
  text: '（测试卡）被指定为对战目标时，让对方战力 -9。',
  effects: [{ op: 'combat_debuff', value: 9, event: 'combatDeclare', subject: 'foe' }],
});
const HAS_RESP = T('treasure', {
  id: 'test_has_response', name: '测试·带应对', type: 'consume', cost: 0, realm: 0, count: 1, cat: '消耗类法器', response: true,
  text: '（测试卡·应对）被指定为对战目标时，让对方战力 -9。',
  effects: [{ op: 'combat_debuff', value: 9, event: 'combatDeclare', subject: 'foe' }],
});
// A 用：卡级带应对、但这条效果用效果级 override 关掉
const OVERRIDE = T('treasure', {
  id: 'test_override', name: '测试·效果级关掉应对', type: 'consume', cost: 0, realm: 0, count: 1, cat: '消耗类法器', response: true,
  text: '（测试卡）应对牌里那条"不参与破招"的效果。',
  effects: [{ op: 'combat_debuff', value: 9, event: 'combatDeclare', subject: 'foe', response: false }],
});
// B 用：可用 2 次的场上牌（投骰前骰点 +1）+ 一张同形状的对照卡（可用 1 次、一直没用）
const USES2 = T('treasure', {
  id: 'test_uses2', name: '测试·可用2次', type: 'equip', cost: 0, realm: 0, count: 1, cat: '装备类法宝', response: true, uses: 2,
  text: '（测试卡）此【宝物牌】可使用2次，在对战中投掷骰子前使用，骰点 +1。',
  effects: [{ event: 'roll', phase: 'before', subject: 'self', op: 'dice_bonus', value: 1, cap: 6 }],
});
const USES_CTRL = T('treasure', {
  id: 'test_uses_ctrl', name: '测试·对照卡', type: 'equip', cost: 0, realm: 0, count: 1, cat: '装备类法宝', response: true, uses: 1,
  text: '（测试卡）对照用：同样在投骰前可使用，一直没用过。',
  effects: [{ event: 'roll', phase: 'before', subject: 'self', op: 'dice_bonus', value: 1, cap: 6 }],
});
// C 用：掷骰分支
const BRANCH = T('treasure', {
  id: 'test_branch', name: '测试·掷骰分支', type: 'consume', cost: 0, realm: 0, count: 1, cat: '消耗类符宝',
  text: '（测试卡）投 1 次骰子：5/6 回 2 血；1 点让对手受 $face 点伤害；其它回 1 法力。',
  effects: [{
    op: 'roll_branch', event: 'useCard', subject: 'self', phase: 'after',
    branches: [
      { faces: [5, 6], effects: [{ op: 'heal', value: 2 }] },
      { faces: [1], effects: [{ op: 'damage', value: '$face', target: 'foe' }] },
    ],
    else: [{ op: 'mana', value: 1 }],
  }],
});
// D 用：先攻才生效的常驻骰点 +1
const ATTACKER_ONLY = T('companion', {
  id: 'test_attacker_only', name: '测试·先攻才生效', type: 'companion', cost: null, realm: 0, count: 1, slots: 1, cat: '修士',
  text: '（测试卡）当你主动发起对战时，骰点 +1。',
  effects: [{ when: 'standing', op: 'dice_bonus', value: 1, cap: 6, if: { attacker: true } }],
});

// ================================================================ A 应对
console.log('[A] 「应对」：只有带应对的才能进【斗法】链');
{
  const { st, A, B } = setup(9101, { aRealm: 2, bRealm: 2 });
  B.hand = [{ uid: 7001, id: NO_RESP }, { uid: 7002, id: HAS_RESP }, { uid: 7003, id: OVERRIDE }];
  E.act(st, 'a', { type: 'combat', target: 'b' });
  const cands = E.pendingCards(st, B).map((c) => c.name);
  check('开战窗口开着、轮到被指定的乙', !!st.pending && st.pending.event === 'combatDeclare', JSON.stringify(st.pending && st.pending.event));
  check('带应对的牌被摆出来了', cands.some((n) => /测试·带应对/.test(n)), JSON.stringify(cands));
  check('不带应对的牌**没有**被摆出来', !cands.some((n) => /测试·无应对/.test(n)), JSON.stringify(cands));
  check('效果级 response:false 能在应对牌里关掉某一条', !cands.some((n) => /效果级关掉应对/.test(n)), JSON.stringify(cands));
  // 真打出来验证没坏：带应对的能进链并生效
  const uid = B.hand.find((h) => h.id === HAS_RESP).uid;
  const r = E.act(st, 'b', { type: 'respond_play', uid: uid });
  check('带应对的能破招打出并进【斗法】', r.ok && /破招打出【测试·带应对】/.test(logText(st)), JSON.stringify(r));
  check('收势后效果真生效（甲的档位被削）', !!(st.combat && st.combat.debuff && st.combat.debuff.a === 9),
    JSON.stringify(st.combat && st.combat.debuff));
}
{
  // 阶段内可选窗口不问应对：晋升·前 的【降尘丹】（数据里没有应对）
  const JC = C.cards().treasure.find((c) => c.name === '降尘丹');
  check('【降尘丹】数据里确实没有应对（它是阶段内可选窗口的牌）', JC.response !== true, String(JC.response));
  const { st, A } = setup(9102, { aRealm: 1 });
  A.qiCards = new Array(12).fill(0).map((_, i) => ({ uid: 8000 + i, id: PLAIN_QI.id }));
  A.hand = [{ uid: 7004, id: JC.id }];
  E.act(st, 'a', { type: 'promote' });
  check('晋升窗口照旧摆出【降尘丹】（应对只卡响应型窗口）',
    !!st.pending && E.pendingCards(st, A).some((c) => c.name === '降尘丹'), JSON.stringify(E.pendingCards(st, A).map((c) => c.name)));
}

// ================================================================ B 可用 N 次
console.log('\n[B] 「可用 N 次」：用完不再摆出来问');
{
  const { st, A } = setup(9103, { aRealm: 2 });
  A.equip = [{ uid: 7101, id: USES2 }, { uid: 7102, id: USES_CTRL }];
  // 「投骰前」窗口是**谁要投骰时**才开的（doRoll 里 fireTiming roll·before），所以每场对战开一次
  const round = () => {
    st.turnFlags.combat = false;
    E.act(st, 'a', { type: 'combat', target: 'b' });
    flushAll(st);
    return E.act(st, 'a', { type: 'roll' });
  };
  const done = () => { flushAll(st); E.act(st, 'b', { type: 'roll' }); flushAll(st); };
  const names = () => E.pendingCards(st, A).map((c) => c.name);

  const r0 = round();
  check('投骰前窗口开着', r0.ok && r0.paused && !!st.pending && st.pending.event === 'roll',
    JSON.stringify({ r: r0, pending: st.pending && st.pending.event }));
  check('第一次：可用2次的牌在候选里', names().some((n) => /测试·可用2次/.test(n)), JSON.stringify(names()));
  check('发动成功（用掉 1 次）', E.act(st, 'a', { type: 'respond_play', uid: 7101 }).ok, '');
  check('战报写明还剩 1 次', /还剩 1 次/.test(logText(st)), logText(st).slice(-120));
  done();

  const r1 = round();
  check('第二次：窗口照旧开（还剩 1 次）', r1.ok && r1.paused && names().some((n) => /测试·可用2次/.test(n)), JSON.stringify(names()));
  check('再发动一次（用掉第 2 次）', E.act(st, 'a', { type: 'respond_play', uid: 7101 }).ok, '');
  check('战报写明还剩 0 次', /还剩 0 次/.test(logText(st)), logText(st).slice(-120));
  done();

  const r2 = round();
  check('第三场：窗口照旧开（靠对照卡）', r2.ok && r2.paused, JSON.stringify(r2));
  check('对照卡（没用过）在候选里 —— 说明窗口不是空的', names().some((n) => /测试·对照卡/.test(n)), JSON.stringify(names()));
  check('用完的牌**不再**出现在候选里', !names().some((n) => /测试·可用2次/.test(n)), JSON.stringify(names()));
  done();
  check('对战照常能打完（没被次数卡死）', !st.combat, JSON.stringify(st.combat && st.combat.stage));
}

// ================================================================ C 掷骰分支
console.log('\n[C] 「掷骰分支」：按点数走不同支线（含 $face 占位符）');
{
  const mk = (seed, face) => {
    const s = setup(seed, { aRealm: 2, aHp: 4 });
    s.A.hand = [{ uid: 7201, id: BRANCH }];
    s.st.forcedDice = [face];                     // 引擎现成的骰点注入点
    return s;
  };
  const s6 = mk(9104, 6);
  E.act(s6.st, 'a', { type: 'play', uid: 7201 });
  check('掷出 6 → 走 5/6 支线：回 2 点血（4 → 6）', s6.A.hp === 6, String(s6.A.hp));
  check('战报写明掷出点数与命中支线', /掷出 6 点（5\/6）/.test(logText(s6.st)), logText(s6.st).slice(-100));

  const s1 = mk(9105, 1);
  E.act(s1.st, 'a', { type: 'play', uid: 7201 });
  check('掷出 1 → 走 1 点支线：对手受 $face＝1 点伤害', s1.B.hp === 5, String(s1.B.hp));

  const s3 = mk(9106, 3);
  s3.A.mana = 5;                                  // 别顶到法力上限（凡人 6 / 修士 12），否则 +1 看不出来
  const mana0 = s3.A.mana;
  E.act(s3.st, 'a', { type: 'play', uid: 7201 });
  check('掷出 3 → 走兜底支线 else：回 1 点法力', s3.A.mana === mana0 + 1, `${mana0} -> ${s3.A.mana}`);
}
{
  // ⭐ 用户 2026-10-05 二次裁定：「受伤也是时点，时点响应，**原效果最后生效**」——
  //    掷出 1 点的"双倍"是**同一次受伤**被 ×2（1×2 = 2 点），**不是**追加一次新伤害。
  //    用真卡【玄铁飞天盾】验证：只开一次受伤窗口、"受伤时"的其他效果只跑一遍。
  const SHIELD = C.cards().treasure.find((c) => c.name === '玄铁飞天盾');
  const YAN = C.cards().companion.find((c) => c.name === '燕如嫣');   // 受伤时回 2 点法力（auto）
  const mk = (seed, face) => {
    const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
    E.beginGame(st);
    for (const q of st.players) q.turnsTaken = 2;
    st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
    const A = st.players[0], B = st.players[1];
    A.realm = 2; B.realm = 2; A.hp = 6; A.mana = 6; B.hp = 6;
    A.hand = []; A.spells = []; A.qiCards = []; B.hand = []; B.equip = []; B.qiCards = [];
    A.equip = [{ uid: 7501, id: SHIELD.id }];
    A.companions = [{ uid: 7502, id: YAN.id }];
    st.forcedDice = [face];
    return { st: st, A: A, B: B, mana0: A.mana };
  };
  const hit = (s) => {
    E.applyDamage(s.st, s.A, 1, 'card', s.B.id);      // 一次 1 点伤害 → 开受伤窗口
    return E.act(s.st, 'a', { type: 'respond_play', uid: 7501 });
  };

  const s1 = mk(9107, 1);
  E.applyDamage(s1.st, s1.A, 1, 'card', s1.B.id);      // 一次 1 点伤害 → 开受伤窗口
  check('⭐ 窗口前置：响应之前伤害**还没落地**（生命值仍是 6）', s1.A.hp === 6, String(s1.A.hp));
  check('待落地的伤害挂在窗口的 ctx.pending 上（值 = 1）',
    !!(s1.st.pending && s1.st.pending.ctx.pending && s1.st.pending.ctx.pending.value === 1),
    JSON.stringify(s1.st.pending && s1.st.pending.ctx.pending));
  check('前端文案用它报"即将受到"（about.pending = true）',
    E.publicState(s1.st, 'a').pending.about.pending === true && E.publicState(s1.st, 'a').pending.about.damage === 1,
    JSON.stringify(E.publicState(s1.st, 'a').pending.about));
  check('受伤窗口开着、候选只有【玄铁飞天盾】', !!s1.st.pending && E.pendingCards(s1.st, s1.A).some((c) => c.name === '玄铁飞天盾'),
    JSON.stringify(s1.st.pending ? E.pendingCards(s1.st, s1.A).map((c) => c.name) : s1.st.pending));
  E.act(s1.st, 'a', { type: 'respond_play', uid: 7501 });
  check('掷 1：同一次受伤 ×2（6 - 1×2 = 4），不是"再挨一下"', s1.A.hp === 4, String(s1.A.hp));
  check('战报写明「使本次伤害 ×2」', /使本次伤害 ×2/.test(logText(s1.st)), logText(s1.st).slice(-140));
  check('收势后**没有**再开一个受伤窗口（不是新伤害）', !s1.st.pending, JSON.stringify(s1.st.pending && s1.st.pending.event));
  const yanFired = (logText(s1.st).match(/燕如嫣/g) || []).length;
  check('"受伤时"的其他效果只跑了一遍（燕如嫣只发动 1 次）', yanFired === 1, '发动次数=' + yanFired);
  check('法力账也对：受伤 +2、盾的发动费 -2（＝角标）', s1.A.mana === s1.mana0, `${s1.mana0} -> ${s1.A.mana}`);

  const s2 = mk(9108, 6);
  E.applyDamage(s2.st, s2.A, 1, 'card', s2.B.id);
  E.act(s2.st, 'a', { type: 'respond_play', uid: 7501 });
  check('掷 6：使本次伤害无效（生命值补回 6）', s2.A.hp === 6, String(s2.A.hp));
  check('战报写明「使本次伤害无效」', /使本次伤害无效/.test(logText(s2.st)), logText(s2.st).slice(-140));

  const s3 = mk(9109, 3);
  E.applyDamage(s3.st, s3.A, 1, 'card', s3.B.id);
  E.act(s3.st, 'a', { type: 'respond_play', uid: 7501 });
  check('掷 3：仍在 2/3/4 支线 = 照旧受伤（5 点）', s3.A.hp === 5, String(s3.A.hp));
}
{
  // `$lostHp` 占位符仍然可用（等额反伤那种卡：青冥针 / 刘靖）
  const REFLECT = T('treasure', {
    id: 'test_reflect_losthp', name: '测试·等额反伤', type: 'consume', cost: 0, realm: 0, count: 1, cat: '消耗类法器', response: true,
    text: '（测试卡）受伤时让对手受等额伤害。',
    effects: [{
      op: 'roll_branch', event: 'hurt', subject: 'self',
      branches: [{ faces: [1, 2, 3, 4, 5, 6], effects: [{ op: 'damage', value: '$lostHp', target: 'foe' }] }],
    }],
  });
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 9110 });
  E.beginGame(st);
  for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = 2; B.realm = 2; A.hp = 6; A.mana = 12; B.hp = 6; A.hand = []; A.spells = []; A.companions = []; A.qiCards = [];
  A.equip = [{ uid: 7601, id: REFLECT }]; B.hand = []; B.equip = []; B.qiCards = [];
  st.forcedDice = [6];
  E.applyDamage(st, A, 1, 'card', B.id);
  const r = E.act(st, 'a', { type: 'respond_play', uid: 7601 });
  check('$lostHp 占位符仍可用（等额反伤：乙掉 1 点）', r.ok && B.hp === 5, JSON.stringify({ r: r, hpB: B.hp }));
}

// ================================================================ D 先攻判据
console.log('\n[D] 「先攻」判据：if:{attacker:true}');
{
  check('matchConditions：先攻是我 → 成立',
    E.matchConditions({ attacker: true }, { self: { id: 'a' }, combat: { attacker: 'a', defender: 'b' } }) === true);
  check('matchConditions：先攻不是我 → 不成立',
    E.matchConditions({ attacker: true }, { self: { id: 'b' }, combat: { attacker: 'a', defender: 'b' } }) === false);
  check('matchConditions：没有对战 → 不成立',
    E.matchConditions({ attacker: true }, { self: { id: 'a' }, combat: null }) === false);

  const { st, A } = setup(9108, { aRealm: 2 });
  A.companions = [{ uid: 7401, id: ATTACKER_ONLY }];
  const asAttacker = E.companionCombat(st, A, { attacker: 'a', defender: 'b' });
  const asDefender = E.companionCombat(st, A, { attacker: 'b', defender: 'a' });
  check('甲先攻时：【测试·先攻才生效】骰点 +1 生效', asAttacker.diceBonus === 1, JSON.stringify(asAttacker));
  check('甲被指定（后攻）时：同一张牌不生效', asDefender.diceBonus === 0, JSON.stringify(asDefender));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
