'use strict';
// 「时点询问该不该开、该问谁」回归 —— 用户报的两个问题各留一份守卡：
//   ① 没有可发动的牌也会询问 → 窗口只该摆给**真的有牌可响应**的人
//      （免费/自动的场上效果根本不进询问，见 engine 的 boardAskable()）
//   ② 赢家在能付得起的情况下没被问【风云幡】【火弹术】→ 结果窗口被"链里新开的窗口"吞掉了
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const T = (n) => C.cards().treasure.find((c) => c.name === n);
const S = (n) => C.cards().spell.find((c) => c.name === n);
const CP = (n) => C.cards().companion.find((c) => c.name === n);
const cardName = (id) => ((T(null) || 0), (C.cards().treasure.concat(C.cards().spell, C.cards().companion).find((d) => d.id === id) || {}).name);
const logText = (st) => st.log.map((l) => l.text).join('\n');
const plainQi = (st) => {
  const plain = C.cards().qi.find((c) => c.name === '稀薄灵气').id;
  st.decks.qi.draw = [];
  for (let i = 0; i < 60; i++) st.decks.qi.draw.push(plain);
};
const flushAll = (st) => { let g = 0; while (st.pending && g++ < 20) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };
const flushRolls = (st) => { let g = 0; while (st.pending && g++ < 20 && /^roll/.test(st.pending.event)) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };

/** 造一局（清空双方手牌/场上，只留参数里指定的牌）。甲高一境 → 甲能向乙发起对战。 */
function setup(seed, o) {
  o = o || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  st.players.forEach((q) => { q.turnsTaken = 2; });
  const A = st.players[0], B = st.players[1];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  A.realm = o.aRealm == null ? 2 : o.aRealm;
  B.realm = o.bRealm == null ? 1 : o.bRealm;
  A.mana = o.aMana == null ? 12 : o.aMana;
  B.mana = o.bMana == null ? 12 : o.bMana;
  A.hp = 6; B.hp = 6;
  A.hand = []; B.hand = []; A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = []; A.puppets = []; B.puppets = [];
  plainQi(st);
  (o.aComps || []).forEach((n, i) => A.companions.push({ uid: 800 + i, id: CP(n).id }));
  (o.bComps || []).forEach((n, i) => B.companions.push({ uid: 820 + i, id: CP(n).id }));
  let u = 1000;
  (o.aEquip || []).forEach((n) => { A.equip.push({ uid: u++, id: (T(n) || S(n)).id }); });
  (o.bEquip || []).forEach((n) => { B.equip.push({ uid: u++, id: (T(n) || S(n)).id }); });
  (o.aHand || []).forEach((n) => { A.hand.push({ uid: u++, id: (T(n) || S(n) || CP(n)).id }); });
  (o.bHand || []).forEach((n) => { B.hand.push({ uid: u++, id: (T(n) || S(n) || CP(n)).id }); });
  return { st: st, A: A, B: B };
}

/** 打到战果已定（结果窗口开着或已结算） */
function toResult(st, A, B) {
  E.act(st, A.id, { type: 'combat', target: B.id });
  flushAll(st);
  E.act(st, A.id, { type: 'roll' });
  flushRolls(st);
  E.act(st, B.id, { type: 'roll' });
  flushRolls(st);
  return st.combat;
}

// ================================================================ A 没人有牌
console.log('[A] 谁都没有牌可响应 → 干脆不开窗');
{
  const { st, A, B } = setup(8801, {});
  toResult(st, A, B);
  check('对战已经结算完（combat 清空）', !st.combat, st.combat && st.combat.stage);
  check('没有留下任何待表态窗口', !st.pending, st.pending && st.pending.event);
  // ⚠️ 措辞跟着 2026-10-02 改名走（响应→破招）：**不跟着改就会变成"永远成立"的空断言**
  check('战报里没有「可以破招。请…」这种空窗口', !/可以破招。请/.test(logText(st)), '');
  check('战报里没有「正在等待…决定是否破招」的空窗口', !/决定是否破招/.test(logText(st)), '');
}

// ================================================================ B 赢家该被问
console.log('\n[B] 赢家手里有「对战获胜时使用」的牌 → 必须被问，且真能打出去');
{
  const { st, A, B } = setup(8802, { aHand: ['风云幡', '火弹术'] });
  // ⚠️ 骰点**注入**（state.forcedDice，见 engine.js 的 d6）：本用例要的是"甲赢下这一场"，
  //    不能靠种子碰运气 —— 牌池一加卡、随机流一漂就可能掷成平局，结果窗口根本不开（2026-10-05 踩到）。
  st.forcedDice = [6, 1];            // 先攻甲 6 点、应战乙 1 点 → 甲稳赢
  const c = toResult(st, A, B);
  check('战果已定、进入结果窗口', !!c && c.stage === 'result' && !!st.pending, c && c.stage);
  check('窗口事件 = combatResult', st.pending && st.pending.event === 'combatResult', st.pending && st.pending.event);
  check('赢家（甲）排在队首', st.pending && st.pending.queue[0] === A.id, st.pending && st.pending.queue.join(','));
  check('赢家是甲', c && c.winnerId === A.id, c && c.winnerId);
  const mine = st.pending ? E.pendingCards(st, A).map((x) => x.name) : [];
  check('【风云幡】被摆出来了', mine.indexOf('风云幡') >= 0, JSON.stringify(mine));
  check('【火弹术】被摆出来了', mine.indexOf('火弹术') >= 0, JSON.stringify(mine));

  const uid = A.hand.find((h) => cardName(h.id) === '风云幡').uid;
  const q0 = A.qiCards.length;
  const r = E.act(st, A.id, { type: 'respond_play', uid: uid });
  check('【风云幡】可以破招打出', r.ok, JSON.stringify(r));
  // 战报文案（2026-10-02 改名）：破招 → 入【斗法】；结算 → 收势
  check('战报说「入【斗法】」（后发先至，逆序收势）',
    /破招打出【风云幡】/.test(logText(st)) && /入【斗法】（后发先至，逆序收势）/.test(logText(st)), '');
  check('出牌后还能继续往上叠（队首仍是甲）', st.pending && st.pending.queue[0] === A.id,
    st.pending && st.pending.queue.join(','));
  check('剩下【火弹术】还在候选里',
    st.pending && E.pendingCards(st, A).some((x) => x.name === '火弹术'),
    st.pending ? JSON.stringify(E.pendingCards(st, A)) : '');
  // 所有人表态完，锁链才倒序结算 → 这时候才真的抽灵气牌
  E.act(st, A.id, { type: 'respond_pass' });
  check('【风云幡】结算后抽到 1 张灵气牌', A.qiCards.length === q0 + 1, `${q0} -> ${A.qiCards.length}`);
  check('窗口关闭、对战结算', !st.pending && !st.combat, JSON.stringify([st.pending && st.pending.event, !!st.combat]));
}

// ================================================================ C 没牌的一方
console.log('\n[C] 手里一张能打的牌都没有的一方 → 不该被弹窗（只能点"跳过"的那种）');
{
  // 输家有一张「对战失败时使用」的【踏云靴】，赢家一张都没有
  const { st, A, B } = setup(8803, { bHand: ['踏云靴'] });
  st.forcedDice = [6, 1];            // 同 [B]：骰点注入，甲稳赢（别靠种子碰运气）
  const c = toResult(st, A, B);
  check('窗口开着', !!st.pending, '');
  const winner = st.players.find((q) => q.id === c.winnerId);
  const loser = st.players.find((q) => q.id === c.loserId);
  check('赢家（没牌）没有被塞进队列', st.pending.queue.indexOf(winner.id) < 0, st.pending.queue.join(','));
  check('队列里只有输家', st.pending.queue.length === 1 && st.pending.queue[0] === loser.id, st.pending.queue.join(','));
  check('输家看到自己的【踏云靴】', E.pendingCards(st, loser).some((x) => x.name === '踏云靴'),
    JSON.stringify(E.pendingCards(st, loser)));
  check('赢家（非表态人）看不到候选', E.pendingCards(st, winner).length === 0, JSON.stringify(E.pendingCards(st, winner)));
}

// ================================================================ D 免费自动效果
console.log('\n[D] 免费 / 自动的场上效果 → 不进询问（否则白问，还能把效果跑第二遍）');
{
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 8810 });
  E.beginGame(st);
  const A = st.players[0];
  A.hand = [];                                  // 清空手牌，确保没有别的东西能响应
  A.companions = [{ uid: 900, id: CP('慕沛灵').id }];
  A.hp = 6; A.mana = 0;
  E.applyDamage(st, A, 1, 'test');
  check('【慕沛灵】受伤只回 1 点法力（0 -> 1）', A.mana === 1, String(A.mana));
  check('掉血就是掉血（6 -> 5），不回血', A.hp === 5, String(A.hp));
  check('不弹任何窗口', !st.pending, st.pending && st.pending.event);

  const st2 = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 8811 });
  E.beginGame(st2);
  const A2 = st2.players[0];
  A2.hand = [];
  A2.companions = [{ uid: 901, id: CP('燕如嫣').id }];
  A2.hp = 6; A2.mana = 0;
  E.applyDamage(st2, A2, 1, 'test');
  check('【燕如嫣】受伤回 2 点法力', A2.mana === 2, String(A2.mana));
  check('【燕如嫣】也不弹窗口', !st2.pending, st2.pending && st2.pending.event);

  // 但手里的【遮天钟】是付费主动牌 —— 受伤时必须问
  const s3 = setup(8812, { aHand: ['遮天钟'] });
  s3.A.hp = 6;
  E.applyDamage(s3.st, s3.A, 1, 'test');
  check('手里的【遮天钟】受伤时仍然会问', s3.st.pending && s3.st.pending.event === 'hurt',
    s3.st.pending && s3.st.pending.event);
  check('【遮天钟】被摆出来了', s3.st.pending && E.pendingCards(s3.st, s3.A).some((x) => x.name === '遮天钟'),
    s3.st.pending ? JSON.stringify(E.pendingCards(s3.st, s3.A)) : '');
}

// ================================================================ E 付费的场上效果
console.log('\n[E] 付费的场上效果（【温天仁】消耗 3 点法力）→ 仍然会问；付不起就静默跳过');
{
  const { st, A } = setup(8820, { aComps: ['温天仁'] });
  A.mana = 12;
  const r = E.act(st, A.id, { type: 'combat', target: st.players[1].id });
  check('发起对战后挂起在合并窗口（对战阶段）', r.ok && st.pending && st.pending.event === 'combatDeclare',
    JSON.stringify([r, st.pending && st.pending.event]));
  check('【温天仁】被摆给甲', st.pending && E.pendingCards(st, A).some((x) => x.name === '温天仁'),
    st.pending ? JSON.stringify(E.pendingCards(st, A)) : '');

  const s2 = setup(8821, { aComps: ['温天仁'], aMana: 2 });   // 只有 2 点，付不起 3 点
  E.act(s2.st, s2.A.id, { type: 'combat', target: s2.B.id });
  check('付不起 3 点时不开窗（静默跳过）', !s2.st.pending, s2.st.pending && s2.st.pending.event);
}

// ================================================================ F 免费但"使用"
console.log('\n[F] 【虚天鼎】不耗法力，但卡文写明"使用" → 仍然要问（分类看卡文，不看花费）');
{
  const { st, A, B } = setup(8830, { bRealm: 3 });
  st.turn = 1; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  B.hand = [{ uid: 4100, id: T('虚天鼎 乾蓝冰焰').id }];
  const eq = E.act(st, B.id, { type: 'play', uid: 4100, tier: 0 });
  check('乙在自己的回合装上【虚天鼎 乾蓝冰焰】', eq.ok && (B.equip.length + B.spells.length) === 1, JSON.stringify(eq));
  flushAll(st);
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  A.hand = [{ uid: 4000, id: T('补气丹').id }];
  const r = E.act(st, A.id, { type: 'play', uid: 4000 });
  // ⚠️ 2026-10-06 用户截图报的 bug：这一幕（**没有对战**、甲在行动阶段打一张牌）里，
  //    乙场上的【虚天鼎】/手里的【铜钱】被摆出来破招 —— 可它们的卡文明写"**在对战中使用**"。
  //    根因：`requiresCombat`（OPS 标记）只在 `playable()` 里拦过，**窗口候选这条漏了**（已修）。
  check('对战外打出【补气丹】不再挂起（"只在对战中用"的牌不该在对战外被问）',
    r.ok && r.paused !== true && !st.pending, JSON.stringify({ r: r, pending: st.pending && st.pending.event }));
  check('乙那边也没有这个窗口', !st.pending, JSON.stringify(st.pending && [st.pending.event, st.pending.phase]));
}

// ================================================================ G 队首放弃后，后手仍要被问
console.log('\n[G] 两个人都只有场上响应 → 先手放弃后，后手不能被跳过');
{
  const { st, A, B } = setup(8840, { aComps: ['温天仁'], bComps: ['温天仁'] });
  E.act(st, A.id, { type: 'combat', target: B.id });
  check('窗口开着、甲乙都在队列里',
    st.pending && st.pending.queue.indexOf(A.id) >= 0 && st.pending.queue.indexOf(B.id) >= 0,
    st.pending && st.pending.queue.join(','));
  E.act(st, A.id, { type: 'respond_pass' });      // 先手放弃
  check('后手（乙）仍然被问到', st.pending && E.pendingActor(st) && E.pendingActor(st).id === B.id,
    st.pending ? (E.pendingActor(st) || {}).id : '窗口已经关了');
  check('乙看到自己的【温天仁】', st.pending && E.pendingCards(st, B).some((x) => x.name === '温天仁'),
    st.pending ? JSON.stringify(E.pendingCards(st, B)) : '');
}

// ================================================================ H 链里新开的窗口
console.log('\n[H] 链结算途中新开的窗口，不能把后面的窗口吞掉');
{
  // 乙在「对战阶段」（开战三合一的窗口）打出【风灵劲】让甲受伤；甲手里有【遮天钟】
  // → **收势那一刻**会再开一个 hurt 窗口，随后流程必须继续。
  // 旧代码在链结束后立刻 resume，会把这个紧随其后的窗口静默吞掉（结果窗口【风云幡】【火弹术】就是这么丢的）。
  const { st, A, B } = setup(8850, { aComps: ['温天仁'], aHand: ['遮天钟'], bHand: ['风灵劲'] });
  E.act(st, A.id, { type: 'combat', target: B.id });
  check('第一步：开战窗口（对战阶段），乙能打【风灵劲】', st.pending && st.pending.event === 'combatDeclare',
    st.pending && st.pending.event);
  // 队列是"回合玩家优先" → 甲（本回合玩家/攻方）先表态；先让甲放弃，轮到乙
  for (let g = 0; g < 6 && st.pending && E.pendingActor(st) && E.pendingActor(st).id === A.id; g++) {
    E.act(st, A.id, { type: 'respond_pass' });
  }
  const uid = B.hand[0].uid;
  const rp = E.act(st, B.id, { type: 'respond_play', uid: uid });
  check('乙在开战窗口打出【风灵劲】', rp.ok === true, JSON.stringify(rp));
  check('打出去后窗口仍开着（轮到甲表态，链还没收势）', !!st.pending, st.pending && st.pending.event);
  // 依次放弃（本回合只有这一个开战窗口）→ 收势 → 风灵劲让甲受伤 → 途中开 hurt 窗口
  for (let g = 0; g < 10 && st.pending && st.pending.event === 'combatDeclare'; g++) {
    const w = E.pendingActor(st);
    if (!w) break;
    E.act(st, w.id, { type: 'respond_pass' });
  }
  check('收势途中又开了「受伤」窗口（没有被吞）', st.pending && st.pending.event === 'hurt',
    st.pending && st.pending.event);
  check('甲（受伤的人）看到自己的【遮天钟】',
    st.pending && E.pendingCards(st, A).some((x) => x.name === '遮天钟'),
    st.pending ? JSON.stringify(E.pendingCards(st, A)) : '');
  E.act(st, A.id, { type: 'respond_pass' });
  flushAll(st);
  check('窗口清完，对战可以继续掷骰', !st.pending && !!st.combat && st.combat.stage === 'pre',
    JSON.stringify([st.pending && st.pending.event, st.combat && st.combat.stage]));
}

// ================================================================ I 效果别跑两遍
console.log('\n[I] 免费效果不会被"响应"跑第二遍');
{
  const { st, A } = setup(8860, { aComps: ['慕沛灵'] });
  A.hp = 6; A.mana = 0;
  E.applyDamage(st, A, 2, 'test');
  check('掉 2 血后法力只有 1 点（没有翻倍）', A.mana === 1, String(A.mana));
  check('生命 6 -> 4（不回血）', A.hp === 4, String(A.hp));
  check('受伤时没有窗口要甲表态', !st.pending, st.pending && st.pending.event);
  check('战报里出现"受伤后恢复 1 点法力值"', /受伤后恢复 1 点法力值/.test(logText(st)), '');
}

// ================================================================ J 空队列窗口
console.log('\n[J] 队列被剪空时必须自己收尾 —— 否则整桌硬死锁');
{
  // 背景：窗口开着的时候，队列里的人可能**在链结算途中被打死**（多目标伤害牌）。
  // 那时 pendingActor 会把他剔出队列 → 队列空 → 谁都不是 amActor → 跳过按钮对所有人
  // disabled，而时点弹窗是全屏遮罩（.overlay position:fixed;inset:0）→ 谁都点不了任何东西。
  // 实测 360 局里约 3% 就是这么卡死的，而且看门狗当时也救不了（空队列直接返回 ok:false）。

  // ① 状态查询这条路（publicState 每次都调 pendingActor，所以这条最常走到）
  const { st, A } = setup(7370, { aHand: ['遮天钟'] });
  E.applyDamage(st, A, 1, 'test');
  check('受伤开出了 hurt 窗口，队列里是甲',
    !!(st.pending && st.pending.event === 'hurt' && st.pending.queue[0] === A.id),
    st.pending && JSON.stringify([st.pending.event, st.pending.queue]));
  A.out = true;                                   // 模拟链结算途中他被打死
  const actor = E.pendingActor(st);
  check('队列被剪空后 pendingActor 返回 null', actor === null, String(actor && actor.id));
  check('窗口被顺手收尾，不留空窗', st.pending === null,
    st.pending && JSON.stringify(st.pending.queue));

  // ② 看门狗这条路（60 秒超时）—— 必须绕开 pendingActor 直接调，否则先被 ① 收掉了
  const s2 = setup(7371, { aHand: ['遮天钟'] });
  E.applyDamage(s2.st, s2.A, 1, 'test');
  s2.A.out = true;
  const t = E.pendingTimeout(s2.st);
  check('看门狗把空队列窗口收掉了', s2.st.pending === null,
    s2.st.pending && JSON.stringify(s2.st.pending.queue));
  check('看门狗返回 settled（不是干瞪眼的 ok:false）', !!(t && t.settled === true), JSON.stringify(t));

  // ③ 对照：队列里还有活人时，看门狗照旧只把当前这个人按"放弃"处理，不关整个窗口
  const s3 = setup(7372, { aHand: ['遮天钟'] });
  E.applyDamage(s3.st, s3.A, 1, 'test');
  check('窗口开着且队列里是甲', !!(s3.st.pending && s3.st.pending.queue[0] === s3.A.id),
    s3.st.pending && JSON.stringify(s3.st.pending.queue));
  const t3 = E.pendingTimeout(s3.st);
  check('有人可表态时看门狗正常把他按放弃处理', !!(t3 && t3.ok), JSON.stringify(t3));
}

// ================================================================ K 手牌里的装备类牌
console.log('\n[K] 手牌里的装备类宝物牌/法术牌，不该进时点响应候选');
{
  // 规则：手里"打出"一张装备类 = 只是把它**【装备】**进程（低境界装备免费），**不发动任何效果**；
  // 它的效果只能在**场上**发动。以前 hand 循环不看 def.type，于是玩家会在时点弹窗里看到
  // 手里的【黑血刀】【虚天鼎】并点"手牌打出" —— 结果只是白装备一下，响应机会也白白用掉了。

  // ① 对战·可选发动：甲手里有【黑血刀】（装备类），场上挂着【温天仁】（付费发动，该问）
  const { st, A, B } = setup(7380, { aComps: ['温天仁'], aHand: ['黑血刀'] });
  E.act(st, A.id, { type: 'combat', target: B.id });
  check('窗口开着（场上的【温天仁】照旧要问）',
    !!(st.pending && st.pending.event === 'combatDeclare'), st.pending && st.pending.event);
  const mine = st.pending ? E.pendingCards(st, A).map((x) => x.name) : [];
  check('场上的【温天仁】被摆出来（场上发动，照问）', mine.indexOf('温天仁') >= 0, JSON.stringify(mine));
  check('手牌里的【黑血刀】没有被摆出来', mine.indexOf('黑血刀') < 0, JSON.stringify(mine));

  // ② 手牌【虚天鼎】开不出「卡牌使用 · 前」窗口；装到场上才开
  const s2 = setup(7381, { aHand: ['虚天鼎 乾蓝冰焰'], bHand: ['补气丹'], bRealm: 2 });
  s2.st.turn = 1; s2.st.step = 'action'; s2.st.turnFlags = { combat: false, promote: false };
  E.act(s2.st, s2.B.id, { type: 'play', uid: s2.B.hand[0].uid });
  check('① 手牌【虚天鼎】不会为它开窗（手牌装备不发动效果）', !s2.st.pending,
    s2.st.pending && s2.st.pending.event);

  const s3 = setup(7382, { aEquip: ['虚天鼎 乾蓝冰焰'], bHand: ['补气丹'], bRealm: 2 });
  s3.st.turn = 1; s3.st.step = 'action'; s3.st.turnFlags = { combat: false, promote: false };
  E.act(s3.st, s3.B.id, { type: 'play', uid: s3.B.hand[0].uid });
  // ⚠️ 2026-10-06 用户截图报的 bug：这一幕（**没有对战**、乙在行动阶段打一张牌）里，
  //    甲手里的【铜钱】被摆出来破招 —— 可它的卡文明写"**在对战中使用**"。
  //    根因：`requiresCombat`（OPS 标记）只在 `playable()` 里拦过，**窗口候选这条漏了**（已修）。
  check('② 对战外：装到场上也不再开这个窗（"只在対战中用"的牌不该在对战外被问）', !s3.st.pending,
    s3.st.pending && s3.st.pending.event);

  // ③ 用户报的那张【铜钱】：对战外打牌，它**不该**进候选
  const s4 = setup(7383, { bHand: ['铜钱'], aHand: ['青蛟旗'], bRealm: 2 });
  E.act(s4.st, s4.A.id, { type: 'play', uid: s4.A.hand[0].uid, target: 'b' });
  const cands4 = s4.st.pending ? E.pendingCards(s4.st, s4.B).map((x) => x.name) : [];
  check('③ 对战外打【青蛟旗】：【铜钱】不在候选里', cands4.indexOf('铜钱') < 0, JSON.stringify(cands4));

  // ④ 对照：**在对战里**该问还是要问 —— 对手把牌打进【斗法】链、那一环结算**之前**，
  //    【铜钱】有机会把它无效掉（这才是卡文"在对战中使用"的正确时点）
  const s5 = setup(7384, { bHand: ['铜钱'], aHand: ['朱雀环'], aRealm: 2, bRealm: 2 });
  E.act(s5.st, s5.A.id, { type: 'combat', target: s5.B.id });
  flushAll(s5.st);
  E.act(s5.st, s5.A.id, { type: 'roll' });                    // 开「投骰·前」窗口
  const rPlay = E.act(s5.st, s5.A.id, { type: 'respond_play', uid: s5.A.hand[0].uid });
  check('④ 甲在对战里把【朱雀环】打进【斗法】链', rPlay.ok, JSON.stringify(rPlay));
  // ⚠️ 这里**不能**用 flushAll 收势：窗口正是开给乙的，flush 会把乙这次机会"替他放弃"掉
  //    （原来这么写，④ 就永远看不到 pending，误判成"没开窗"）。
  const nulWin = s5.st.pending;
  check('④ 收势前给乙开了「对方出牌时」的窗口（这一环结算之前）',
    !!(nulWin && nulWin.event === 'useCard' && nulWin.phase === 'before'),
    JSON.stringify(nulWin && [nulWin.event, nulWin.phase]));
  const cands5 = nulWin ? E.pendingCards(s5.st, s5.B).map((x) => x.name) : [];
  check('④ 对战内：【铜钱】被摆出来（该问的还得问）', cands5.indexOf('铜钱') >= 0, JSON.stringify(cands5));
  const useNul = nulWin ? E.act(s5.st, s5.B.id, { type: 'respond_play', uid: s5.B.hand[0].uid }) : { ok: false };
  check('④ 乙用【铜钱】把它无效掉', useNul.ok, JSON.stringify(useNul));
  check('④ 战报写明被无效（且写的是【铜钱】、不是张冠李戴的【虚天鼎】）',
    /【铜钱】/.test(logText(s5.st)) && /【朱雀环】被无效/.test(logText(s5.st)),
    logText(s5.st).slice(-200));
  check('④ 那一环的效果**没有**结算（【朱雀环】的骰点加成没进本场对战）',
    !s5.st.combat || !s5.st.combat.bonus || !s5.st.combat.bonus[s5.A.id],
    JSON.stringify(s5.st.combat && s5.st.combat.bonus));
  // ⚠️ 这条链是"挂起 → 续跑"过的：**外面的流程必须照常继续**。
  //    以前续跑只把链跑完、没人收尾（finishPending 漏调）→ 对战永远停在投骰前，整场卡死。
  const rResume = E.act(s5.st, s5.B.id, { type: 'roll' });
  check('④ 收势后流程照常往下走（乙真的投了骰、对战照常打完，不是卡死在对战前）',
    rResume.ok === true && /【应战】乙 掷出/.test(logText(s5.st)),
    JSON.stringify([s5.st.combat && s5.st.combat.stage, rResume]));

  // ⑤ 「无效某类牌」还得看**对方打的是哪一类**：
  //    【铜钱】=消耗类/装备类宝物牌、【雷火锥】=法术牌、【虚天鼎】=两者皆可。
  //    甲手里两张都摆出来试：乙打进链的是**法术牌**→ 该问【雷火锥】，不该问【铜钱】。
  const s6 = setup(7385, { aHand: ['铜钱', '雷火锥'], bHand: ['颠倒五行阵'], aRealm: 2, bRealm: 2 });
  E.act(s6.st, s6.A.id, { type: 'combat', target: s6.B.id });
  flushAll(s6.st);
  E.act(s6.st, s6.A.id, { type: 'roll' });              // 甲投骰 → 甲这两张都不是投骰时点 → 直接开「投骰·后」
  const spellWin = s6.st.pending;
  check('⑤ 甲投完骰，窗口轮到乙（【颠倒五行阵】=对方投骰后）',
    !!(spellWin && E.pendingActor(s6.st) && E.pendingActor(s6.st).id === s6.B.id),
    JSON.stringify([spellWin && spellWin.event, spellWin && spellWin.phase, E.pendingActor(s6.st) && E.pendingActor(s6.st).name]));
  const rSpell = spellWin ? E.act(s6.st, s6.B.id, { type: 'respond_play', uid: s6.B.hand[0].uid }) : { ok: false };
  check('⑤ 乙把法术牌【颠倒五行阵】打进【斗法】链', rSpell.ok, JSON.stringify(rSpell));
  const cands6 = s6.st.pending ? E.pendingCards(s6.st, s6.A).map((x) => x.name) : [];
  check('⑤ 对法术牌：只摆【雷火锥】（【铜钱】管的是宝物牌，不该被问）',
    cands6.indexOf('雷火锥') >= 0 && cands6.indexOf('铜钱') < 0, JSON.stringify(cands6));
  const rcUid = s6.A.hand.find((x) => cardName(x.id) === '雷火锥');
  const useSpell = (s6.st.pending && rcUid)
    ? E.act(s6.st, s6.A.id, { type: 'respond_play', uid: rcUid.uid })
    : { ok: false };
  check('⑤ 甲用【雷火锥】把那张法术牌无效掉', useSpell.ok, JSON.stringify(useSpell));
  check('⑤ 战报写明法术牌被无效', /【雷火锥】/.test(logText(s6.st)) && /【颠倒五行阵】被无效/.test(logText(s6.st)),
    logText(s6.st).slice(-200));

  // ⑥ 对战外强行破招会被拒（不是只靠界面不显示）
  const badPlay = E.act(s4.st, s4.B.id, { type: 'respond_play', uid: s4.B.hand[0] && s4.B.hand[0].uid });
  check('⑥ 对战外强行破招会被拒（不是只靠界面不显示）',
    !s4.st.pending || badPlay.ok === false, JSON.stringify(badPlay));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
