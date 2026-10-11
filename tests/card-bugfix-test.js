'use strict';
// 实盘报的一批 bug 的回归守卫（用户和朋友玩完一盘后反馈）
//   ① 虚天鼎：两个效果都要能在场上选着用（不是装备时锁死一档），且 uid 传字符串也要认
//   ② 伪金丹（【血凝五行丹】）：视作结丹期，所有"比境界"的效果都得按生效境界算
//   ③ 平时弃手牌只在"自己回合的行动阶段"允许（对方回合点手牌不能丢牌）
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const T = (n) => C.cards().treasure.find((c) => c.name === n);
const S = (n) => C.cards().spell.find((c) => c.name === n);
const CP = (n) => C.cards().companion.find((c) => c.name === n);
const XT = T('虚天鼎 乾蓝冰焰');

function setup(seed, turn) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  st.players.forEach((q) => { q.turnsTaken = 2; });
  st.turn = (turn === undefined ? 0 : turn); st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = 3; B.realm = 3; A.mana = 20; B.mana = 20; A.hp = 6; B.hp = 6;
  A.hand = []; B.hand = []; A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = []; A.puppets = []; B.puppets = [];
  return { st: st, A: A, B: B };
}

// ================================================================ A 虚天鼎
console.log('[A] 【虚天鼎 乾蓝冰焰】：两个效果各按卡文的时点；装备只有一次性 5 费');
const flushPend = (st) => { let g = 0; while (st.pending && g++ < 20) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };
{
  check('没有 tiers（不再是"装备时锁死一档"）', !XT.tiers, JSON.stringify(XT.tiers));
  check('★ 没有 enable_equip_combat —— 用户裁定：这张牌总共就"装备时 5 点"这一笔费用',
    !(XT.effects || []).some((e) => e.op === 'enable_equip_combat'), JSON.stringify(XT.effects));
  check('装备时消耗 5 点法力（equipCost）', XT.equipCost === 5, String(XT.equipCost));
  const eNull = (XT.effects || []).find((e) => e.op === 'nullify_enemy_card') || {};
  const eBonus = (XT.effects || []).find((e) => e.op === 'combat_bonus') || {};
  check('效果1 = 对方发动【法术/宝物牌】时（useCard·前）响应，且不耗法力',
    eNull.event === 'useCard' && eNull.phase === 'before' && eNull.subject === 'foe' && !eNull.manaCost, JSON.stringify(eNull));
  check('效果1 标了 oncePerTurn（用户：不限一回合一次"有点赖"）', eNull.oncePerTurn === true, JSON.stringify(eNull));
  check('效果2 = 我方投骰前（roll·前）发动，花 1 点法力、本场战力 +1',
    eBonus.event === 'roll' && eBonus.phase === 'before' && eBonus.subject === 'self'
    && eBonus.manaCost === 1 && eBonus.value === 1, JSON.stringify(eBonus));

  // ---- 效果 1：无效对方打出的牌（不耗法力），且**一回合只许一次** ----
  // ⚠️ 时点必须是"**对战里**"：卡文明写"在对战中出牌阶段使用"；而对战里出牌走的是【斗法】链
  //    （不是 doPlay），所以这一刻 = "链上那一环结算之前"（2026-10-06 用户报的正是"对战外也摆出来问"）。
  const { st, A, B } = setup(9801, 0);
  A.realm = 3; B.realm = 3;
  A.equip = [{ uid: 7001, id: XT.id }];
  A.hand = [{ uid: 7002, id: T('雷火锥').id }];      // 只无效【法术牌】—— 用来证明"第二个窗口照开"
  const SW = S('颠倒五行阵');                        // 法术牌：对方投骰后可以打进链
  B.hand = [{ uid: 8001, id: SW.id }, { uid: 8002, id: SW.id }];
  E.act(st, A.id, { type: 'combat', target: B.id });
  flushPend(st);                                    // 开战窗口：虚天鼎现在**不在这里问**
  E.act(st, A.id, { type: 'roll' });                // 甲投骰 → 先问甲自己的【乾蓝冰焰】+1 战力
  E.act(st, A.id, { type: 'respond_pass' });        // 甲不用 → 骰子落地 → 「投骰·后」轮到有牌的乙
  const p1 = E.act(st, B.id, { type: 'respond_play', uid: 8001 });
  check('乙把牌打进【斗法】链', p1.ok, JSON.stringify(p1));
  const p2 = E.act(st, B.id, { type: 'respond_play', uid: 8002 });
  check('同一窗口里还能继续往上叠（后进链的先结算）', p2.ok, JSON.stringify(p2));
  E.act(st, B.id, { type: 'respond_pass' });        // 乙收手 → 逆序收势
  check('对方在对战里出牌时开出「卡牌使用 · 前」窗口',
    !!(st.pending && st.pending.event === 'useCard' && st.pending.phase === 'before'),
    JSON.stringify(st.pending && [st.pending.event, st.pending.phase]));
  check('场上已装备的【虚天鼎】被摆出来', E.pendingCards(st, A).some((x) => x.name.indexOf('虚天鼎') >= 0),
    JSON.stringify(E.pendingCards(st, A).map((x) => x.name)));
  const m0 = A.mana;
  const r = E.act(st, A.id, { type: 'respond_play', uid: 7001 });
  check('响应成功（数字 uid）', r.ok, JSON.stringify(r));
  check('这一档不耗法力', A.mana === m0, `${m0} -> ${A.mana}`);
  check('战报写明"本回合仅此一次"', /本回合仅此一次/.test(st.log.map((l) => l.text).join(' | ')), '');
  const meA = E.publicState(st, A.id).players.find((x) => x.id === 'a') || {};
  check('本回合记了账（publicState.turnUsedUids 里有这张牌的 uid；字符串，正好和前端 dataset 一致）',
    (meA.turnUsedUids || []).map(String).indexOf('7001') >= 0, JSON.stringify(meA.turnUsedUids));
  // 链上还剩一环（8001）→ 收势到它时**照常开窗**（甲手里有【雷火锥】），但【虚天鼎】本回合用过了，不再摆出来
  const cands2 = st.pending ? E.pendingCards(st, A).map((x) => x.name) : [];
  check('同一回合第二次**不再**摆出【虚天鼎】（一回合一次）',
    cands2.indexOf('雷火锥') >= 0 && !cands2.some((n) => n.indexOf('虚天鼎') >= 0),
    JSON.stringify([cands2, st.pending && st.pending.event]));
  flushPend(st);

  // uid 传字符串（前端 dataset / JSON 往返）—— 换一局，第一条效果不再受限
  const s2 = setup(9802, 0);
  s2.A.realm = 3; s2.B.realm = 3;
  s2.A.equip = [{ uid: 7001, id: XT.id }];
  s2.B.hand = [{ uid: 8001, id: S('颠倒五行阵').id }];
  E.act(s2.st, s2.A.id, { type: 'combat', target: s2.B.id });
  flushPend(s2.st);
  E.act(s2.st, s2.A.id, { type: 'roll' });
  E.act(s2.st, s2.A.id, { type: 'respond_pass' });   // 同上：先把甲自己的「投骰·前」窗口过掉
  E.act(s2.st, s2.B.id, { type: 'respond_play', uid: 8001 });
  const r2 = E.act(s2.st, s2.A.id, { type: 'respond_play', uid: '7001' });
  check('响应成功（**字符串** uid）—— 旧版这里报"你手里和场都没有这张牌"', r2.ok, JSON.stringify(r2));

  // ---- 效果 2：投骰前付 1 点法力 → 本场临时战力 +1 ----
  const s3 = setup(9803, 0);
  s3.A.equip = [{ uid: 7001, id: XT.id }];
  E.act(s3.st, s3.A.id, { type: 'combat', target: s3.B.id });
  flushPend(s3.st);                                   // 开战窗口：虚天鼎现在**不在这里问**了（没有启用费）
  const m3 = s3.A.mana;
  E.act(s3.st, s3.A.id, { type: 'roll' });            // 这一步先开「投骰 · 前」
  check('投骰前开出「投骰 · 前」窗口',
    !!(s3.st.pending && s3.st.pending.event === 'roll' && s3.st.pending.phase === 'before'),
    s3.st.pending && `${s3.st.pending.event}/${s3.st.pending.phase}`);
  check('【虚天鼎 乾蓝冰焰】被摆给甲', E.pendingCards(s3.st, s3.A).some((x) => x.name.indexOf('虚天鼎') >= 0),
    JSON.stringify(E.pendingCards(s3.st, s3.A)));
  const r4 = E.act(s3.st, s3.A.id, { type: 'respond_play', uid: 7001 });
  check('付 1 点法力发动成功', r4.ok, JSON.stringify(r4));
  E.act(s3.st, s3.A.id, { type: 'respond_pass' });     // 表态结束 → 链结算
  check('法力扣掉 1 点', s3.A.mana === m3 - 1, `${m3} -> ${s3.A.mana}`);
  check('★ 本场临时战力 +1（combat.bonus）', !!(s3.st.combat && s3.st.combat.bonus[s3.A.id] === 1),
    JSON.stringify(s3.st.combat && s3.st.combat.bonus));

  // ★ 不再白送：不发动就没有 +1
  //   （修复前【虚天鼎】这种 event 类数值加成会被 activateCombatEquips 当常驻自动算进去）
  const s5 = setup(9805, 0);
  s5.A.equip = [{ uid: 7001, id: XT.id }];
  E.act(s5.st, s5.A.id, { type: 'combat', target: s5.B.id });
  flushPend(s5.st);
  check('没发动就没有 +1（不再白送常驻加成）',
    !(s5.st.combat.bonus && s5.st.combat.bonus[s5.A.id]), JSON.stringify(s5.st.combat && s5.st.combat.bonus));
}

// ================================================================ B 伪金丹
console.log('\n[B] 【血凝五行丹】伪丹期：视作结丹期（所有比境界的地方都按生效境界）');
{
  const WC = CP('王蝉');   // 「对战境界高于你的修士时，战力+1」= if.enemyRealm.higher
  function mk(seed, pseudo) {
    const { st, A, B } = setup(seed, 0);
    A.realm = 2; B.realm = 3;                        // 甲筑基、乙结丹 → 乙比甲高
    A.companions = [{ uid: 1, id: WC.id }];
    if (pseudo) A.pseudoRealm = { realm: 3, turns: 2, penalty: 1 };
    const combat = { attacker: A.id, defender: B.id, dice: {}, total: {}, bonus: {}, debuff: {}, diceBonus: {},
      dicePenalty: {}, noPenalty: {}, flatPower: {}, blocked: {}, loseSave: {}, compPaid: {}, loseRetaliate: {},
      forceReroll: {}, skipDice: {}, winBonusDamage: {}, winStealTreasure: {}, winMana: {}, winDrawQi: {},
      selfLoseDamage: {}, equipBonus: null, equipEnabled: {} };
    return { st: st, A: A, B: B, combat: combat };
  }
  const a = mk(9805, false);
  check('不伪丹时 baseCombat = 境界+1 = 3', E.baseCombat(a.A) === 3, String(E.baseCombat(a.A)));
  check('不伪丹时【王蝉】触发 +1（对手结丹更高）', E.companionCombat(a.st, a.A, a.combat).bonus === 1,
    String(E.companionCombat(a.st, a.A, a.combat).bonus));

  const b = mk(9806, true);
  check('伪丹期 effRealm = 3（视作结丹，**不是**元婴）', E.effRealm(b.A) === 3, String(E.effRealm(b.A)));
  check('伪丹期 baseCombat = 4（和真结丹一致）', E.baseCombat(b.A) === 4, String(E.baseCombat(b.A)));
  check('伪丹期【王蝉】**不再**触发 +1（恩，同级不算"更高"）',
    E.companionCombat(b.st, b.A, b.combat).bonus === 0, String(E.companionCombat(b.st, b.A, b.combat).bonus));
  check('伪丹期结束后回到真实境界', (function () { b.A.pseudoRealm.turns = 0; return E.effRealm(b.A) === 2; })());
}

// ================================================================ C 法术区只有 1 格
// 用户裁定（2026-10-02）：法术区**只有 1 格，与境界无关**（旧写的"2 格、结丹 3 格"是错的）。
console.log('\n[C] 法术区只有 1 格（与境界无关）');
{
  for (const realm of [0, 1, 2, 3, 4]) {
    const { A } = setup(9810 + realm, 0);
    A.realm = realm;
    check(`境界 ${realm} 时 spellSlots = 1`, E.spellSlots(A) === 1, String(E.spellSlots(A)));
  }
  const { A } = setup(9815, 0);
  A.realm = 4;
  check('储物袋仍然随境界扩（炼气+ → 2 格），别一起改坏',
    E.equipSlots(Object.assign({}, A, { realm: 0 })) === 1 && E.equipSlots(A) === 2,
    `${E.equipSlots(Object.assign({}, A, { realm: 0 }))}/${E.equipSlots(A)}`);
  check('同行者位也仍然随境界扩（筑基+ → 2 格）',
    E.companionSlots(Object.assign({}, A, { realm: 1 })) === 1 && E.companionSlots(A) === 2,
    `${E.companionSlots(Object.assign({}, A, { realm: 1 }))}/${E.companionSlots(A)}`);
}

// ================================================================ D 暗抽打码
// 用户实盘报过："游戏日志能看到对手抽到的牌，变成明牌打了。"
console.log('\n[D] 战报里别人的"暗抽"要打码（灵气牌是公开的，例外）');
{
  const { st, A, B } = setup(9820, 0);
  st.step = 'draw_treasure';
  E.act(st, A.id, { type: 'draw_treasure' });       // 甲抽 2 张宝物牌进手
  const forA = E.publicState(st, 'a').log;
  const forB = E.publicState(st, 'b').log;
  const aDraws = forA.filter((l) => l.kind === 'draw' && l.payload && l.payload.player === 'a');
  const bSeesA = forB.filter((l) => l.kind === 'draw' && l.payload && l.payload.player === 'a');
  check('甲自己能看见自己抽的是什么', aDraws.length > 0 && aDraws.every((l) => !!l.payload.card),
    JSON.stringify(aDraws.map((l) => l.text)));
  check('乙看到的甲抽牌**没有牌名**（打码）',
    bSeesA.length > 0 && bSeesA.every((l) => !l.payload.card && l.payload.hidden === true),
    JSON.stringify(bSeesA.map((l) => l.text)));
  check('打码后的文案是"暗抽"', bSeesA.every((l) => /暗抽/.test(l.text)), JSON.stringify(bSeesA.map((l) => l.text)));
  const names = aDraws.map((l) => (l.payload.card || '')).filter(Boolean);
  check('乙的战报里不含甲抽到的牌名', names.every((id) => !JSON.stringify(forB).includes(id)),
    JSON.stringify(names));

  // 灵气牌例外：它是公开信息
  const { st: st2, A: A2 } = setup(9821, 0);
  st2.step = 'draw_qi';
  E.act(st2, A2.id, { type: 'draw_qi' });
  const qB = E.publicState(st2, 'b').log.filter((l) => l.kind === 'qi_gain' || (l.kind === 'draw' && l.payload && l.payload.deck === 'qi'));
  check('灵气牌抽取照旧公开（不被打码）', qB.length > 0 && qB.every((l) => !l.payload.hidden),
    JSON.stringify(qB.map((l) => l.text)));
}

// ================================================================ D2 时点日志里的手牌也要打码
// 用户 2026-10-02 报的同类泄漏："时点响应还是明牌" —— 抽牌/晋升这类**没接询问层**的时点，
// 引擎会记一行"有牌可响应：甲·【牌名】"，牌名可能来自**别人的手牌**。
console.log('\n[D2] 时点日志里别人的手牌候选要滤掉（场上的牌是公开的，照旧）');
{
  const { st, A, B } = setup(9825, 0);
  // 直接构造一条与 fireTiming 同形的日志（时点事件、两个候选：一个手牌、一个场上）
  st.log.push({
    kind: 'timing',
    text: '〔时点〕「晋升 · 前」有牌可响应：甲·【娑罗珠】、乙·【虚天鼎 乾蓝冰焰】。（该时点暂未接入询问层）',
    payload: {
      timing: 'promote', phase: 'before',
      responders: [
        { player: 'a', card: '娑罗珠', where: 'hand' },
        { player: 'b', card: '虚天鼎 乾蓝冰焰', where: 'board' },
      ],
    },
  });
  const forA = E.publicState(st, 'a').log.slice(-1)[0];
  const forB = E.publicState(st, 'b').log.slice(-1)[0];
  check('甲（本人）看得到自己的手牌候选', /娑罗珠/.test(forA.text), forA.text);
  check('乙看甲的手牌候选：整条里**没有娑罗珠**', !/娑罗珠/.test(forB.text), forB.text);
  check('场上那张（虚天鼎）照旧公开 —— 牌本来就摆在桌上', /虚天鼎/.test(forB.text), forB.text);
  check('打码后的 payload 也剔掉了那条（别让前端拿到）',
    (forB.payload.responders || []).every((r) => r.where !== 'hand' || r.player === 'b'),
    JSON.stringify(forB.payload.responders));

  // 只有别人的手牌候选时 → 整条不显示（连"他有牌能响应"都不露）
  const s2 = setup(9826, 0);
  s2.st.log.push({
    kind: 'timing',
    text: '〔时点〕「法术或同行者抽取」有牌可响应：乙·【遮天钟】。（该时点暂未接入询问层）',
    payload: {
      timing: 'drawSpell', phase: null,
      responders: [{ player: 'b', card: '遮天钟', where: 'hand' }],
    },
  });
  const aSees = E.publicState(s2.st, 'a').log;
  check('只剩对手手牌候选 → 甲的战报里连这条时点日志都没有',
    !aSees.some((l) => l.kind === 'timing' && l.payload && l.payload.timing === 'drawSpell'), JSON.stringify(aSees.map((l) => l.text)));
  check('乙自己仍然看得到（那是他自己的牌）',
    E.publicState(s2.st, 'b').log.some((l) => /遮天钟/.test(l.text || '')), '');
}

// ================================================================ E 受伤措辞要指明是谁受伤
// 用户实盘报过：对方扣血，我这边也显示"你受到1点伤害"。
console.log('\n[E] 「受伤」时点询问要带上"谁受伤了"，前端才能分开措辞');
{
  const { st, A, B } = setup(9830, 1);              // 乙的回合；让甲受伤开窗
  A.hand = [{ uid: 5001, id: T('遮天钟').id }];     // 遮天钟 = 受伤时点的响应牌
  E.applyDamage(st, A, 1, 'test');
  check('开出了 hurt 窗口且表态人是甲', !!(st.pending && st.pending.event === 'hurt'), st.pending && st.pending.event);
  const pA = E.publicState(st, 'a').pending;
  const pB = E.publicState(st, 'b').pending;
  check('甲的视图里 subjectId = 甲（自己受伤）', pA && pA.about.subjectId === A.id, JSON.stringify(pA && pA.about));
  check('乙的视图里 subjectId 也是甲 —— 前端据此说"【甲】受到"，不再说"你受到"',
    pB && pB.about.subjectId === A.id && pB.about.subjectName === A.name, JSON.stringify(pB && pB.about));
  check('乙自己不是受伤者（subjectId ≠ 乙）', pB && pB.about.subjectId !== B.id, String(pB && pB.about.subjectId));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
