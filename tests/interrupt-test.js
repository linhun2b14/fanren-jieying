'use strict';
// 打断层（第 4 步）回归 —— 三处打断点：受伤 / 使用卡牌 / 被指定为目标。
// 这一层让下面 5 张"时点做不出来"的牌真正可用：
//   【阴魂丝】被指定为对战目标时  【风灵劲】任意回合、有人发起对战时
//   【虚天鼎】对方打出牌的那一刻  【遮天钟】受到伤害时  【还阳术】致命伤害濒死时
const E = require('../server/engine');
const C = require('../server/cards');
const M = require('../server/effect-meta');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const T = (n) => C.cards().treasure.find((c) => c.name === n);
const S = (n) => C.cards().spell.find((c) => c.name === n);
const logText = (st) => st.log.map((l) => l.text).join('\n');
/** 把所有开着的窗口全部放弃掉（清场用） */
const flush = (st) => { let g = 0; while (st.pending && g++ < 20) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };
/** 把灵气牌堆换成不会连锁的【稀薄灵气】，让"抽牌数"可预测 */
const plainQi = (st) => {
  const plain = C.cards().qi.find((c) => c.name === '稀薄灵气').id;
  st.decks.qi.draw = [];
  for (let i = 0; i < 60; i++) st.decks.qi.draw.push(plain);
};

function setup(seed, hands) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
   // 测试直接造局，不走真实回合流程 —— 这里标记"两边的第一个回合都已经过去"（新规则：第一个回合不能发起对战）
      for (const q of st.players) q.turnsTaken = 2;
  const A = st.players[0], B = st.players[1];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  A.mana = 12; B.mana = 12;
  A.hand = []; B.hand = []; A.equip = []; B.equip = [];
  A.companions = []; B.companions = []; A.spells = []; B.spells = [];
  plainQi(st);
  if (hands && hands.a) hands.a.forEach((d, i) => A.hand.push({ uid: 4000 + i, id: d.id }));
  if (hands && hands.b) hands.b.forEach((d, i) => B.hand.push({ uid: 4100 + i, id: d.id }));
  return { st: st, A: A, B: B };
}

// ================================================================ A 被指定为目标
console.log('[A] 【阴魂丝】被指定为对战目标时（combatDeclare）');
{
  const { st, A, B } = setup(6001, { b: [T('阴魂丝')] });
  const r = E.act(st, A.id, { type: 'combat', target: B.id });
  check('发起对战后**挂起**（不是直接开打）', r.ok && r.paused === true, JSON.stringify(r));
  check('窗口事件 = combatDeclare', st.pending && st.pending.event === 'combatDeclare', JSON.stringify(st.pending && st.pending.event));
  check('待表态的是乙', E.pendingActor(st).id === 'b', E.pendingActor(st).id);
  check('候选牌列表里有【阴魂丝】', E.pendingCards(st, B).some((c) => c.name === '阴魂丝'), JSON.stringify(E.pendingCards(st, B)));
  check('甲（非表态人）此刻什么都不能做', !E.act(st, A.id, { type: 'end_turn' }).ok, '');
  const rp = E.act(st, B.id, { type: 'respond_play', uid: 4100 });
  check('乙响应打出【阴魂丝】', rp.ok, JSON.stringify(rp));
  check('窗口已关闭、对战继续', !st.pending && !!st.combat && st.combat.stage === 'pre', JSON.stringify(st.pending));
  check('效果生效：封锁甲使用消耗类宝物牌',
    !!(st.combat.blocked && st.combat.blocked.a && st.combat.blocked.a.length), JSON.stringify(st.combat.blocked));
  check('牌进了弃牌堆', !B.hand.length, String(B.hand.length));
  // 文案（2026-10-02 改名）：结算那行现在叫「收势：」
  check('战报有收势结算', /收势/.test(logText(st)), '');
}

// ================================================================ B 风灵劲
console.log('\n[B] 【风灵劲】任意回合、有人发起对战时（combatDeclare）');
{
  const { st, A, B } = setup(6002, { b: [S('风灵劲')] });
  const hp0 = A.hp;
  E.act(st, A.id, { type: 'combat', target: B.id });
  check('窗口开着', !!st.pending, '');
  const rp = E.act(st, B.id, { type: 'respond_play', uid: 4100 });
  check('乙响应打出【风灵劲】', rp.ok, JSON.stringify(rp));
  check(`发起对战的甲受到 1 点伤害（${hp0} → ${A.hp}）`, A.hp === hp0 - 1, `${hp0} -> ${A.hp}`);
  check('乙自己没掉血', B.hp === 6, String(B.hp));
}

// ================================================================ C 使用卡牌前
console.log('\n[C] 【虚天鼎】对方打出牌的那一刻（useCard.before）—— 只在对战里问');
{
  // ⚠️ 2026-10-06 用户截图报的 bug：乙装备着【虚天鼎】、甲在**行动阶段**（根本没有对战）打一张牌，
  //    乙那一刻被弹窗问"要不要把这张牌无效掉" —— 可卡文明写"**在对战中**出牌阶段使用"。
  //    根因：`requiresCombat`（OPS 标记）只在 `playable()` 里拦过，**窗口候选这条漏了**（已修）。
  const { st, A, B } = setup(6003, {});
  B.realm = 2; B.mana = 12;                      // 虚天鼎需要筑基期
  B.hand = [{ uid: 4100, id: T('虚天鼎 乾蓝冰焰').id }];
  st.turn = 1; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const eq = E.act(st, B.id, { type: 'play', uid: 4100, tier: 0 });
  check('乙在自己的回合装上【虚天鼎 乾蓝冰焰】（宝物类装备 → 进储物袋）', eq.ok && B.equip.length === 1, JSON.stringify(eq));
  flush(st);
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  A.hand = [{ uid: 4000, id: T('补气丹').id }];
  // 【补气丹】= 恢复 1 点生命值（2026-10-05 用户改文案，以前是抽 1 张灵气牌）。
  // 满血时回血会被夹住，所以先把血打低，用"血量 +1"证明那一次出牌真的走完了流程。
  A.hp = 4;
  const hp0 = A.hp;
  const r = E.act(st, A.id, { type: 'play', uid: 4000 });
  check('对战外打出【补气丹】：不再为【虚天鼎】挂起（"只在对战中用"的牌不该在对战外被问）',
    r.ok && r.paused !== true && !st.pending, JSON.stringify([r, st.pending && st.pending.event]));
  check('那张牌照常结算（回了 1 点血）', A.hp === hp0 + 1, `${hp0} -> ${A.hp}`);
}

// ================================================================ C2 对战里：无效链上那一环
console.log('\n[C2] 【虚天鼎】在场上时，能无效掉对方**打进【斗法】链**的那张牌');
{
  // 对战里出牌**走【斗法】链**（不是 doPlay），所以这一刻只能是"链上那一环结算之前"。
  const { st, A, B } = setup(6011, {});
  A.realm = 2; B.realm = 2;
  B.equip.push({ uid: 9900, id: T('虚天鼎 乾蓝冰焰').id });   // 已在场上（声明 useCard·before·foe）
  A.hand = [{ uid: 4000, id: T('朱雀环').id }];               // 投骰·前 发动（宝物牌）
  const rc = E.act(st, A.id, { type: 'combat', target: B.id });
  check('甲向乙发起对战', rc.ok, JSON.stringify(rc));
  flush(st);                                                  // 开战窗口：虚天鼎现在**不在这里问**
  E.act(st, A.id, { type: 'roll' });                          // 甲投骰 → 「先攻出牌阶段」
  const rPlay = E.act(st, A.id, { type: 'respond_play', uid: 4000 });
  check('甲把【朱雀环】打进【斗法】链', rPlay.ok, JSON.stringify(rPlay));
  check('收势前给乙开了「卡牌使用 · 前」窗口（这一环结算之前）',
    !!st.pending && st.pending.event === 'useCard' && st.pending.phase === 'before',
    JSON.stringify(st.pending && [st.pending.event, st.pending.phase]));
  check('候选里有场上的【虚天鼎 乾蓝冰焰】', E.pendingCards(st, B).some((c) => c.name === '虚天鼎 乾蓝冰焰'),
    JSON.stringify(E.pendingCards(st, B).map((c) => c.name)));
  const rNull = E.act(st, B.id, { type: 'respond_play', uid: 9900 });
  check('乙用场上的【虚天鼎】把那一环无效掉', rNull.ok, JSON.stringify(rNull));
  check('战报写明被无效', /【朱雀环】被无效/.test(logText(st)), logText(st).slice(-200));
  check('那一环没结算（【朱雀环】的骰点加成没进本场对战）',
    !st.combat.bonus || !st.combat.bonus[A.id], JSON.stringify(st.combat && st.combat.bonus));
  // ⚠️ 这一链是"挂起 → 续跑"过的：外面的流程必须照常继续（以前漏了收尾 → 整场卡死）
  //    （乙投完骰会**顺手**开一个「投骰·前」窗口问他的【乾蓝冰焰】+1 战力 —— 那是另一回事，
  //      所以这里只验"乙真的投出去了"，不要求窗口必须关着。）
  const rRoll = E.act(st, B.id, { type: 'roll' });
  check('收势后流程照常往下走（乙真的坐到了投骰位置，不是死锁）',
    rRoll.ok === true && !!st.combat, JSON.stringify(rRoll));
  flush(st);                       // 收掉乙自己那个「投骰·前」窗口 → 骰子才落地
  check('乙真的投出去了（骰点落地、对战继续）',
    /【应战】乙 掷出/.test(logText(st)), logText(st).slice(-160));
}

// ================================================================ D 受伤
console.log('\n[D] 【遮天钟】受到伤害时（hurt）—— 第 3 轮：窗口前置、伤害最后落地');
{
  const { st, A, B } = setup(6004, { b: [T('遮天钟')] });
  // 甲打【青蛟旗】让乙掉 1 点血（指定目标）
  A.hand = [{ uid: 4000, id: T('青蛟旗').id }];
  const hp0 = B.hp;
  st.forcedDice = [2];                       // 钉住骰点：2 不在 4/5/6 里 → 抵消失败，伤害照旧落地
  const r = E.act(st, A.id, { type: 'play', uid: 4000, target: 'b' });
  check('【青蛟旗】打出成功', r.ok, JSON.stringify(r));
  check(`窗口前置：伤害**还没落地**（乙仍是 ${hp0} 血）`, B.hp === hp0, `${hp0} -> ${B.hp}`);
  check('开出了受伤窗口', !!st.pending && st.pending.event === 'hurt', JSON.stringify(st.pending && st.pending.event));
  check('待表态的是受伤的乙', E.pendingActor(st).id === 'b', E.pendingActor(st) && E.pendingActor(st).id);
  check('候选里有【遮天钟】', E.pendingCards(st, B).some((c) => c.name === '遮天钟'), JSON.stringify(E.pendingCards(st, B)));
  const rp = E.act(st, B.id, { type: 'respond_play', uid: 4100 });
  check('乙响应打出【遮天钟】', rp.ok, JSON.stringify(rp));
  check('掷了骰（战报有 roll）', /掷出 \d 点/.test(logText(st)), '');
  check('窗口关闭', !st.pending, '');
  check('【遮天钟】已消耗', !B.hand.length, String(B.hand.length));
  check(`没能抵消 → **收势之后**伤害才落地（${hp0} → ${hp0 - 1}）`, B.hp === hp0 - 1, `${hp0} -> ${B.hp}`);
  check('战报写明未能抵消', /未能抵消/.test(logText(st)), '');
  console.log('    ' + st.log.filter((l) => /遮天钟|掷出|抵消/.test(l.text)).map((l) => l.text).slice(-3).join(' | '));
}

// ================================================================ E 还阳术（致命）
console.log('\n[E] 【还阳术】致命伤害濒死时（hurt + if.lethal）—— 窗口前置');
{
  const { st, A, B } = setup(6005, { b: [S('还阳术')] });
  A.hand = [{ uid: 4000, id: T('青蛟旗').id }];
  B.hp = 1;                                  // 一下打死
  const r = E.act(st, A.id, { type: 'play', uid: 4000, target: 'b' });
  check('【青蛟旗】打出成功', r.ok, JSON.stringify(r));
  check('窗口前置：伤害还没落地（乙仍是 1 血）', B.hp === 1, String(B.hp));
  check('乙**没有立即被淘汰**（判死被推到收势之后）', !B.out, String(B.out));
  check('开出了受伤窗口且标了致命', !!st.pending && st.pending.ctx.lethal === true,
    JSON.stringify(st.pending && st.pending.ctx.lethal));
  check('候选里有【还阳术】', E.pendingCards(st, B).some((c) => c.name === '还阳术'), JSON.stringify(E.pendingCards(st, B)));
  const rp = E.act(st, B.id, { type: 'respond_play', uid: 4100 });
  check('乙响应打出【还阳术】', rp.ok, JSON.stringify(rp));
  check('收势后伤害落地时走自救：生命值 = 2', B.hp === 2, String(B.hp));
  check('乙没出局', !B.out, '');
  check('对战没有因为有人死而结束', st.phase === 'playing', st.phase);
}
{
  // 同一个局面但**放弃**不响应 —— 窗口前置 ≠ 免死：收势后伤害落地、真的淘汰
  const { st, A, B } = setup(6005, { b: [S('还阳术')] });
  A.hand = [{ uid: 4000, id: T('青蛟旗').id }];
  B.hp = 1;
  E.act(st, A.id, { type: 'play', uid: 4000, target: 'b' });
  const rp = E.act(st, B.id, { type: 'respond_pass' });
  check('放弃响应（' + JSON.stringify(rp) + '）', rp.ok, JSON.stringify(rp));
  check('伤害落地（1 → 0）', B.hp === 0, String(B.hp));
  check('没人出手相救 → 乙被淘汰', B.out === true, String(B.out));
}

// ================================================================ E2 非致命时不给还阳术
console.log('\n[E2] 【还阳术】不该在非致命伤害时出现（靠 if.lethal 收窄）');
{
  const { st, A, B } = setup(6006, { b: [S('还阳术')] });
  A.hand = [{ uid: 4000, id: T('青蛟旗').id }];
  B.hp = 6;
  E.act(st, A.id, { type: 'play', uid: 4000, target: 'b' });
  check('乙掉 1 点血但没开窗口（除非有别的响应牌）', !st.pending, JSON.stringify(st.pending && st.pending.event));
  check('【还阳术】没能打出', !E.act(st, B.id, { type: 'play', uid: 4100 }).ok, '');
}

// ================================================================ F 锁链倒序
console.log('\n[F] 锁链：同一时点可连出多张，后进链的先结算（倒序）');
{
  // 两张都得是同一个时点（combatDeclare·对方）的牌：【风灵劲】【阴魂丝】
  const { st, A, B } = setup(6007, { b: [S('风灵劲'), T('阴魂丝')] });
  E.act(st, A.id, { type: 'combat', target: B.id });
  check('窗口开着', !!st.pending, '');
  const r1 = E.act(st, B.id, { type: 'respond_play', uid: 4100 });   // 风灵劲
  check('乙打出第 1 张【风灵劲】', r1.ok, JSON.stringify(r1));
  check('窗口没关（乙可以继续叠）', !!st.pending, JSON.stringify(st.pending && st.pending.event));
  check('还能再出第 2 张', E.pendingCards(st, B).some((c) => c.name === '阴魂丝'), JSON.stringify(E.pendingCards(st, B)));
  const r2 = E.act(st, B.id, { type: 'respond_play', uid: 4101 });   // 阴魂丝
  check('乙再打出第 2 张【阴魂丝】', r2.ok, JSON.stringify(r2));
  // 乙的牌出完了 → 没人再能响应 → 自动结算（不需要再点放弃）
  check('牌出完后窗口自动结算关闭', !st.pending, JSON.stringify(st.pending && st.pending.event));
  const order = st.log.filter((l) => /收势：【/.test(l.text)).map((l) => l.text);
  check('两张都结算过', order.length === 2, JSON.stringify(order));
  check('结算顺序是**倒序**（阴魂丝 在 风灵劲 之前）',
    order.length === 2 && order[0].indexOf('阴魂丝') >= 0, JSON.stringify(order));
}

// ================================================================ G 没人响应就不开窗
console.log('\n[G] 没人能响应 → 完全不开窗（零响应直通）');
{
  const { st, A, B } = setup(6008, {});
  const r = E.act(st, A.id, { type: 'combat', target: B.id });
  check('发起对战直接开打', r.ok && !r.paused && !!st.combat, JSON.stringify(r));
  check('没有 pending', !st.pending, '');
  // 换个没有对战、也没有响应者的场景：打伤害牌同样不挂起
  const s2 = setup(6012, {});
  s2.A.hand = [{ uid: 4000, id: T('青蛟旗').id }];
  const hp0 = s2.B.hp;
  const r2 = E.act(s2.st, s2.A.id, { type: 'play', uid: 4000, target: 'b' });
  check('打伤害牌也不挂起', r2.ok && !s2.st.pending, JSON.stringify(r2));
  check('伤害正常落地', s2.B.hp === hp0 - 1, `${hp0} -> ${s2.B.hp}`);
}

// ================================================================ H 超时兜底
console.log('\n[H] 窗口超时 → 当前表态人按放弃处理');
{
  const { st, A, B } = setup(6009, { b: [T('阴魂丝')] });
  E.act(st, A.id, { type: 'combat', target: B.id });
  check('窗口开着', !!st.pending, '');
  E.pendingTimeout(st);
  check('超时后窗口关闭、对战继续', !st.pending && !!st.combat, JSON.stringify(st.pending));
  check('【阴魂丝】没被打出（还在手里）', B.hand.length === 1, String(B.hand.length));
}

// ================================================================ I 淘汰延后：没人救就死
console.log('\n[I] 致命伤害但没人能救 → 正常淘汰（不拖回合）');
{
  const { st, A, B } = setup(6010, {});
  A.hand = [{ uid: 4000, id: T('青蛟旗').id }];
  B.hp = 1;
  E.act(st, A.id, { type: 'play', uid: 4000, target: 'b' });
  check('乙出局', B.out === true, String(B.out));
  check('没有留下 pending', !st.pending, '');
  check('游戏判定结束或至少不是"playing 卡住"', st.phase === 'over' || st.players.filter((x) => !x.out).length >= 1, st.phase);
}

// ================================================================ J 主动 / 被动 判据
console.log('\n[J] 判据：**消耗法力才能发动 = 主动询问；不消耗法力 = 自动**');
{
  const CP = (n) => C.cards().companion.find((c) => c.name === n);
  const wentian = CP('温天仁'), lingyu = CP('凌玉灵'), yinyue = CP('银月'), mocai = CP('墨彩环');
  const eff = (c, op) => (c.effects || []).find((e) => e.op === op);

  // —— 消耗法力的：改成 event 写法（= 由打断层询问），不再无条件自动
  const wt = eff(wentian, 'combat_debuff');
  check('【温天仁】改成 event 写法（主动询问）', !!wt && wt.event === 'combatOpt' && wt.manaCost === 3, JSON.stringify(wt));
  check('【温天仁】不再挂 when（否则会被自动收集）', !!wt && wt.when === undefined, JSON.stringify(wt));
  const mc = eff(mocai, 'turn_no_combat_heal');
  check('【墨彩环】改成 event 写法（主动询问）', !!mc && mc.event === 'turnEnd' && mc.manaCost === 3, JSON.stringify(mc));
  check('【墨彩环】带了 if.hp（生命已满就不问）', !!mc && !!mc.if && !!mc.if.hp, JSON.stringify(mc && mc.if));

  // —— 不消耗法力的：保持自动（由引擎汇总）
  check('【凌玉灵】不消耗法力 → 仍是自动（dice_bonus）',
    !!eff(lingyu, 'dice_bonus') && eff(lingyu, 'dice_bonus').manaCost === undefined,
    JSON.stringify(eff(lingyu, 'dice_bonus')));
  check('【银月】不消耗法力 → 仍是自动（reroll_dice）',
    !!eff(yinyue, 'reroll_dice') && eff(yinyue, 'reroll_dice').manaCost === undefined,
    JSON.stringify(eff(yinyue, 'reroll_dice')));

  // —— 行为验证：温天仁法力不足时不开窗（付不起就不该问）
  const { st, A, B } = setup(6013, {});
  A.companions = [{ uid: 9500, id: wentian.id }];
  A.realm = 2; B.realm = 2;
  A.mana = 2;                                     // 不够 3 点
  const r = E.act(st, A.id, { type: 'combat', target: B.id });
  check('温天仁法力不足 → 不挂起、不开窗', r.ok && !r.paused && !st.pending, JSON.stringify(r));
  check('法力没被暗中扣掉', A.mana === 2, String(A.mana));

  const s2 = setup(6014, {});
  s2.A.companions = [{ uid: 9501, id: wentian.id }];
  s2.A.realm = 2; s2.B.realm = 2; s2.A.mana = 12;
  const r2 = E.act(s2.st, s2.A.id, { type: 'combat', target: s2.B.id });
  check('温天仁法力够 → 开窗询问',
    r2.ok && r2.paused === true && !!s2.st.pending && s2.st.pending.event === 'combatDeclare', JSON.stringify(r2));
  const rp = E.act(s2.st, s2.A.id, { type: 'respond_play', uid: 9501 });
  check('发动温天仁', rp.ok, JSON.stringify(rp));
  check('只扣一次 3 点（不重复扣）', s2.A.mana === 9, String(s2.A.mana));
  check('按卡文是削**对方**战力（combat_debuff 挂在对手身上）',
    !!(s2.st.combat && s2.st.combat.debuff && s2.st.combat.debuff[s2.B.id] === 1),
    JSON.stringify(s2.st.combat && s2.st.combat.debuff));

  // —— 不消耗法力的仍然自动：凌玉灵在场时不会开窗
  const s3 = setup(6015, {});
  s3.A.companions = [{ uid: 9502, id: lingyu.id }];
  s3.A.realm = 2; s3.B.realm = 2; s3.A.mana = 12;
  const r3 = E.act(s3.st, s3.A.id, { type: 'combat', target: s3.B.id });
  check('凌玉灵（不消耗法力）不产生询问窗口', r3.ok && !r3.paused && !s3.st.pending, JSON.stringify(r3));
  const cc = E.companionCombat(s3.st, s3.A, s3.st.combat);
  check('凌玉灵的骰点 +1 仍然自动汇总出来', cc.diceBonus === 1, JSON.stringify(cc));

  // —— 通则推广到**装备**：付费的照样"付费即询问"，但**问在效果自己的时点**
  //    ⚠️ 2026-10-06 用户报「装备牌在场上的发动时机再检查一遍，如绿煌剑，战胜时发动的效果被移到
  //       对战开始时就触发时点」→ 把 7 张装备从"开战统一启用（enable_equip_combat + 常驻）"迁回
  //       卡文自己的时点，费用**印在效果上**（`规则文档.md` §7.4 / §7.47 的写法）。
  //    下面两条是全池不变量，替掉原来那两条"必须存在 combatOpt 启用费"的断言。
  const equips = [];
  for (const d of ['treasure', 'spell']) {
    for (const c of C.cards()[d] || []) if (c.type === 'equip') equips.push(c);
  }
  const effsOfCard = (c) => (c.effects || []).concat(...(c.tiers || []).map((t) => t.effects || []));
  const noEnable = equips.filter((c) => effsOfCard(c).some((e) => e.op === 'enable_equip_combat'));
  check('全池装备都没有 `enable_equip_combat` 了（开战统一启用已废）',
    noEnable.length === 0, noEnable.map((c) => c.name).join('、'));

  // ① 卡文带「装备时不消耗【法力值】」+ 角标>0 ⇒ 装备免费、**发动其效果才消耗** ⇒ 每条效果自带 manaCost = 角标
  const freeCls = equips.filter((c) => /装备时不消耗/.test(c.text || '') && (c.cost || 0) > 0);
  const missingFee = [];
  for (const c of freeCls) {
    for (const e of effsOfCard(c)) {
      const t = M.timingOfEffect(e);
      if (!t && e.when !== 'standing') continue;         // 非时点效果不管
      if ((e.manaCost || 0) !== c.cost) missingFee.push(c.name + '/' + e.op);
    }
  }
  check(`「装备免费、发动效果才消耗」的 ${freeCls.length} 张装备：每条效果的费用 = 角标（费用印在效果上）`,
    missingFee.length === 0, missingFee.join('、'));

  // ② 卡文**没写**免费句 ⇒ 装备时就把角标付掉了、效果不再消耗 ⇒ 效果上不该有对战费用
  //    （例外：卡文自己印了「消耗 N 点【法力值】」的，如【虚天鼎 乾蓝冰焰】【大庚剑阵】）
  const paidCls = equips.filter((c) => !/装备时不消耗/.test(c.text || ''));
  const wrongCharged = [];
  for (const c of paidCls) {
    if (/消耗\s*\d*\s*点?【法力值】/.test(c.text || '')) continue;
    for (const e of effsOfCard(c)) if ((e.manaCost || 0) > 0) wrongCharged.push(c.name + '/' + e.op);
  }
  check(`「装备时付过费」的 ${paidCls.length} 张装备：效果不再收费`,
    wrongCharged.length === 0, wrongCharged.join('、'));

  const XT = T('虚天鼎 乾蓝冰焰');
  check('【虚天鼎】确认没有启用费（只有装备时 5 点，效果各按卡文时点）',
    !(XT.effects || []).some((e) => e.op === 'enable_equip_combat') && XT.equipCost === 5,
    JSON.stringify({ equipCost: XT.equipCost, effects: XT.effects }));

  // 行为：付不起 → 不问（哪怕时点到了）
  const s4 = setup(6016, {});
  const LU = T('绿煌剑');
  s4.A.equip = [{ uid: 9600, id: LU.id }];
  s4.A.realm = 2; s4.B.realm = 2;
  s4.A.mana = 2;                                       // 绿煌剑要 3 点
  s4.st.forcedDice = [6, 1];                           // 甲赢 → 结果窗口那一刻才知道付不付得起
  const r4 = E.act(s4.st, s4.A.id, { type: 'combat', target: s4.B.id });
  check('开战时不为【绿煌剑】开窗（它的时点是"获胜时"，不是开战）',
    r4.ok && !r4.paused && !s4.st.pending, JSON.stringify(r4));
  flush(s4.st);
  E.act(s4.st, s4.A.id, { type: 'roll' }); flush(s4.st);
  E.act(s4.st, s4.B.id, { type: 'roll' });
  const poorCands = s4.st.pending ? E.pendingCards(s4.st, s4.A).map((c) => c.name) : [];
  check('打赢了也**不**摆出来（付不起 → 静默跳过）',
    !s4.st.pending || poorCands.indexOf('绿煌剑') < 0, JSON.stringify([s4.st.pending && s4.st.pending.event, poorCands]));
  flush(s4.st);
  check('付不起时法力不动', s4.A.mana === 2, String(s4.A.mana));

  // 行为：付得起 → 在「对战结果」窗口问；放弃则不扣费、效果不生效
  const s5 = setup(6017, {});
  s5.A.equip = [{ uid: 9601, id: LU.id }];
  s5.A.realm = 2; s5.B.realm = 2; s5.A.mana = 12;
  s5.st.forcedDice = [6, 1];
  const r5 = E.act(s5.st, s5.A.id, { type: 'combat', target: s5.B.id });
  check('开战时不问（同上）', r5.ok && !r5.paused && !s5.st.pending, JSON.stringify(r5));
  flush(s5.st);
  E.act(s5.st, s5.A.id, { type: 'roll' }); flush(s5.st);
  E.act(s5.st, s5.B.id, { type: 'roll' });
  check('打赢后挂起在「对战结果」窗口（这一环结算之前）',
    !!(s5.st.pending && s5.st.pending.event === 'combatResult'),
    JSON.stringify(s5.st.pending && s5.st.pending.event));
  check('候选里有【绿煌剑】（场上发动，3 点）',
    E.pendingCards(s5.st, s5.A).some((c) => c.name === '绿煌剑' && c.cost === 3),
    JSON.stringify(E.pendingCards(s5.st, s5.A).map((c) => c.name + '@' + c.cost)));
  E.act(s5.st, s5.A.id, { type: 'respond_pass' });
  check('放弃 → 不扣费', s5.A.mana === 12, String(s5.A.mana));
  check('放弃 → 战报里没有【绿煌剑】生效', !/【绿煌剑】/.test(s5.st.log.map((l) => l.text).join('\n')),
    s5.st.log.map((l) => l.text).slice(-3).join(' | '));
  flush(s5.st);

  // —— 替挡同样按通则：**付费的（傀儡蜥蜴 2 点）要问；免费的仍然自动**
  const puppet = T('傀儡蜥蜴');
  const pa = (puppet.effects || []).find((e) => e.op === 'puppet_absorb');
  check('【傀儡蜥蜴】加了"付费替伤"的响应效果',
    !!pa && pa.event === 'hurt' && pa.manaCost === 2 && !!pa.if && !!pa.if.puppet, JSON.stringify(pa));
  const FREE_ABSORB = ['寒蛟', '离龟', '啼魂', '铁火蚁', '南宫婉', '钟卫娘'];
  const autoStill = FREE_ABSORB.filter((n) => {
    const c = CP(n);
    return c && (c.effects || []).some((e) => e.event === 'hurt');
  });
  check('免费替挡的同行者**没有**被改成询问（仍然自动）', autoStill.length === 0, autoStill.join('、'));

  // 行为：有傀儡 + 付得起 → 问；付不起 → 不问
  const s6 = setup(6018, {});
  s6.A.puppets = [{ uid: 9700, id: puppet.id, name: '傀儡蜥蜴', left: 2, manaCost: 2 }];
  s6.A.mana = 12; s6.A.hp = 6;
  E.applyDamage(s6.st, s6.A, 2, 'test');
  check('有傀儡 → 挨打时开受伤窗口', !!s6.st.pending && s6.st.pending.event === 'hurt', '');
  check('候选里有【傀儡蜥蜴】（场上响应）',
    E.pendingCards(s6.st, s6.A).some((c) => c.name === '傀儡蜥蜴' && c.where === 'board'),
    JSON.stringify(E.pendingCards(s6.st, s6.A)));
  E.act(s6.st, s6.A.id, { type: 'respond_play', uid: 9700 });
  check('替伤后主人不掉血', s6.A.hp === 6 && s6.A.mana === 10, `hp=${s6.A.hp} mana=${s6.A.mana}`);
  check('替伤次数 -1', s6.A.puppets[0].left === 1, JSON.stringify(s6.A.puppets));

  const s7 = setup(6019, {});
  s7.A.puppets = [{ uid: 9701, id: puppet.id, name: '傀儡蜥蜴', left: 2, manaCost: 2 }];
  s7.A.mana = 1; s7.A.hp = 6;                       // 付不起 2 点
  E.applyDamage(s7.st, s7.A, 2, 'test');
  check('付不起替伤费 → 连窗口都不开', !s7.st.pending, JSON.stringify(s7.st.pending && s7.st.pending.event));
  check('付不起 → 伤害照落、次数不动', s7.A.hp === 4 && s7.A.puppets[0].left === 2,
    `hp=${s7.A.hp} left=${s7.A.puppets[0].left}`);
}

// ================================================================ K 结果窗口 = 锁链
console.log('\n[K] 结果窗口锁链：赢家先出牌，输家可响应，后进链的先结算');
{
  const FENGYUN = T('风云幡'), TOUYUN = T('透明丝线');
  // 甲（赢家）持【风云幡】、乙（输家）持【透明丝线】
  const { st, A, B } = setup(6020, {});
  A.hand = [{ uid: 4000, id: FENGYUN.id }];
  B.hand = [{ uid: 4100, id: TOUYUN.id }];
  A.realm = 4; B.realm = 3;
  const rc = E.act(st, A.id, { type: 'combat', target: B.id });
  // 开战可能先弹「对战宣告/可选发动」——全部放弃
  for (let g = 0; g < 6 && st.pending && st.pending.event !== 'combatResult'; g++) {
    const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' });
  }
  check('发起对战成功', rc.ok, JSON.stringify(rc));
  st.combat.bonus[A.id] = 5;                      // 保证甲赢
  E.act(st, A.id, { type: 'roll' }); E.act(st, B.id, { type: 'roll' });
  check('进入结果窗口且挂着 combatResult 时点',
    !!st.combat && st.combat.stage === 'result' && !!st.pending && st.pending.event === 'combatResult',
    JSON.stringify(st.pending && st.pending.event));
  check('赢家先表态', E.pendingActor(st).id === A.id, E.pendingActor(st) && E.pendingActor(st).id);
  check('赢家的候选只含「获胜时」的牌', E.pendingCards(st, A).every((c) => c.name === '风云幡'),
    JSON.stringify(E.pendingCards(st, A)));
  check('**输家此刻**的候选是空的（还没轮到他）', E.pendingCards(st, B).length === 0,
    JSON.stringify(E.pendingCards(st, B)));

  const qi0 = A.qiCards.length;
  const raid = A.hp;
  const r1 = E.act(st, A.id, { type: 'respond_play', uid: 4000 });
  check('赢家打出【风云幡】', r1.ok, JSON.stringify(r1));
  check('轮到输家响应', !!st.pending && E.pendingActor(st).id === B.id, JSON.stringify(st.pending && E.pendingActor(st).id));
  check('输家的候选是「失败时」的牌', E.pendingCards(st, B).some((c) => c.name === '透明丝线'),
    JSON.stringify(E.pendingCards(st, B)));
  const r2 = E.act(st, B.id, { type: 'respond_play', uid: 4100 });
  check('输家响应打出【透明丝线】', r2.ok, JSON.stringify(r2));

  const order = st.log.filter((l) => /收势：【/.test(l.text)).map((l) => l.text);
  check('两张都进了链并结算', order.length === 2, JSON.stringify(order));
  check('**倒序**结算（后进链的【透明丝线】先算）', order.length === 2 && order[0].indexOf('透明丝线') >= 0,
    JSON.stringify(order));
  check('结算完对战结束', st.combat === null, JSON.stringify(st.combat && st.combat.stage));
  check('赢家的【风云幡】抽到了灵气牌', A.qiCards.length > qi0, `${qi0} -> ${A.qiCards.length}`);
  check('输家的【透明丝线】反伤生效（赢家掉血）', A.hp === raid - 1, `${raid} -> ${A.hp}`);
  check('输家照常吃战败惩罚（败方境界较低：只扣 1 点生命值）', B.hp === 5, String(B.hp));
}

// ================================================================ L 没人出牌 → 结果窗口直接结算
console.log('\n[L] 双方都没「获胜/失败时」的牌 → 不开窗、直接结算');
{
  const { st, A, B } = setup(6021, {});
  A.hand = []; B.hand = [];
  A.realm = 4; B.realm = 3;
  E.act(st, A.id, { type: 'combat', target: B.id });
  for (let g = 0; g < 6 && st.pending; g++) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); }
  st.combat.bonus[A.id] = 5;
  E.act(st, A.id, { type: 'roll' }); E.act(st, B.id, { type: 'roll' });
  check('没有结果窗口（直接结算完）', st.combat === null, JSON.stringify(st.combat && st.combat.stage));
  check('败方照常吃惩罚（低一境界只扣血）', B.hp === 5, String(B.hp));
  check('没有残留 pending', !st.pending, '');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
