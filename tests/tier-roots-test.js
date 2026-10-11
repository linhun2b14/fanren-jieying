'use strict';
// 2026-10-02 用户两项裁定的专项回归：
//   ① **多档位牌一律自动适配当前境界**（取消手选档）
//      —— 但【火弹术】那种"同境界二选一"不是境界档，自动挑会直接打死另一半，
//         所以它改成"在响应候选里展开成两项、由玩家点选"，锁链里也选得了。
//   ② **灵根符 8 张配比 = 天 1 / 双 1 / 三 3 / 伪 3**（2026-10-02 深夜第三版），抽走不放回
//      —— 同资质（尤其三/伪）出现多位是常态，"同资质掷骰争先手"因此是活代码。
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const S = (n) => C.cards().spell.find((c) => c.name === n);
const logText = (st) => st.log.map((l) => l.text).join(' | ');
const flushAll = (st) => { let g = 0; while (st.pending && g++ < 40) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };

const huo = S('火弹术');
const qy = S('青元剑诀');

// ================================================================ A 卡池形态
console.log('\n[A] 多档位的两种语义：境界档 vs 同境界二选一');
check('卡池里有【火弹术】', !!huo);
check('卡池里有【青元剑诀】', !!qy);
check('【火弹术】两档 realm 相同 → 判为"二选一"（isEitherOr）', huo && E.isEitherOr(huo) === true, huo && String(E.isEitherOr(huo)));
check('【青元剑诀】三档 realm 各不相同 → 判为"境界档"（不是二选一）', qy && E.isEitherOr(qy) === false, qy && String(E.isEitherOr(qy)));
check('tierSiblings(火弹术,0) = [0,1]', JSON.stringify(E.tierSiblings(huo, 0)) === '[0,1]', JSON.stringify(E.tierSiblings(huo, 0)));
check('tierSiblings(青元剑诀,1) 只有它自己', JSON.stringify(E.tierSiblings(qy, 1)) === '[1]', JSON.stringify(E.tierSiblings(qy, 1)));

console.log('\n[B] resolveTier：境界档忽略手选、同境界二选一尊重选择');
check('境界档：筑基(2) 请求第 1 档 → 仍自动取第 2 档(1)', E.resolveTier(qy, 2, 0) === 1, String(E.resolveTier(qy, 2, 0)));
check('境界档：结丹(3) 不传 tier → 自动取最高档(2)', E.resolveTier(qy, 3) === 2, String(E.resolveTier(qy, 3)));
check('境界档：凡人(0) 请求第 3 档 → 夹回第 1 档(0)（越级档不当真）', E.resolveTier(qy, 0, 2) === 0, String(E.resolveTier(qy, 0, 2)));
check('二选一：明确选第 2 项 → 就用第 2 项(1)', E.resolveTier(huo, 0, 1) === 1, String(E.resolveTier(huo, 0, 1)));
check('二选一：明确选第 1 项 → 就用第 1 项(0)', E.resolveTier(huo, 0, 0) === 0, String(E.resolveTier(huo, 0, 0)));
check('二选一：不传 → 有个确定的兜底档(1)，不会崩', E.resolveTier(huo, 0) === 1, String(E.resolveTier(huo, 0)));

// ================================================================ C 青元剑诀：境界档全自动
console.log('\n[C] 【青元剑诀】装上去就自动按境界生效（不再手选）');
{
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 7001 });
  E.beginGame(st);
  const P = st.players[0];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  P.hand = []; P.spells = []; P.mana = 12;

  P.realm = 0; P.hand = [{ uid: 1, id: qy.id }];
  const r0 = E.act(st, P.id, { type: 'play', uid: 1, tier: 0 });
  check('凡人装不上（最低档就要炼气）', r0.ok === false, JSON.stringify(r0));

  P.realm = 1; P.hand = [{ uid: 2, id: qy.id }];
  const r1 = E.act(st, P.id, { type: 'play', uid: 2, tier: 1 });   // 故意传越级档
  check('炼气能装上（请求里的越级档被忽略，不报错）', r1.ok === true, JSON.stringify(r1));
  check('自动落在炼气档(tier=0)', P.spells[0] && P.spells[0].tier === 0, JSON.stringify(P.spells[0]));
  check('该档效果 = dice_bonus', E.tierEffect(qy, P.spells[0]).kind === 'dice_bonus');

  P.realm = 3; P.spells = []; P.mana = 12; P.hand = [{ uid: 3, id: qy.id }];
  const r3 = E.act(st, P.id, { type: 'play', uid: 3, tier: 0 });   // 故意传最低档
  check('结丹能装上（写最低档也没用）', r3.ok === true, JSON.stringify(r3));
  check('自动升到结丹档(tier=2)', P.spells[0] && P.spells[0].tier === 2, JSON.stringify(P.spells[0]));
  const eff3 = E.tierEffect(qy, P.spells[0]);
  check('结丹档效果 = combat_bonus', eff3 && eff3.kind === 'combat_bonus', JSON.stringify(eff3));

  // 晋升后场上已装的那张要自动跟着上去（"自动适配当前境界"的另一半）
  P.realm = 2; P.spells = []; P.mana = 12; P.hand = [{ uid: 4, id: qy.id }];
  E.act(st, P.id, { type: 'play', uid: 4, tier: 0 });
  check('筑基装 → 筑基档(tier=1，重掷取大)', P.spells[0] && P.spells[0].tier === 1, JSON.stringify(P.spells[0]));
  P.realm = 3;
  E.syncEquipTiers(P);     // doPromote 内部就是调它
  check('晋升到结丹后，场上那张自动对齐到结丹档(tier=2)', P.spells[0] && P.spells[0].tier === 2, JSON.stringify(P.spells[0]));
}

// ================================================================ D 火弹术：二选一在锁链里都打得出
console.log('\n[D] 【火弹术】二选一：两个选项在"对战结果"链里都能选');
/** 打到"甲获胜、结果窗口开着、甲手里有火弹术"的局面。
 *  ⚠️ 骰点**注入**而不是靠种子：卡池一变大（2026-10-05 实物卡补充批 +14 张），
 *     所有靠种子决定的骰点都会漂移，seed=1"甲必胜"这种断言立刻就假红。 */
function toWinWindow(seed) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  const A = st.players[0], B = st.players[1];
  st.players.forEach((q) => { q.turnsTaken = 2; });      // 第一个回合不能发起对战
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  A.realm = 2; B.realm = 1; A.mana = 12; B.mana = 12; A.hp = 6; B.hp = 6;
  A.hand = [{ uid: 9101, id: huo.id }]; A.spells = []; A.equip = [];
  B.hand = []; B.spells = []; B.equip = []; B.puppets = [];
  C.cards().treasure.slice(0, 3).forEach((c, i) => B.hand.push({ uid: 9200 + i, id: c.id }));
  st.forcedDice = [6, 1];                                 // 甲 6 点、乙 1 点 → 甲必胜
  E.act(st, A.id, { type: 'combat', target: B.id });
  flushAll(st);
  E.act(st, A.id, { type: 'roll' });
  flushAll(st);
  E.act(st, B.id, { type: 'roll' });
  return { st: st, A: A, B: B };
}
// 基线：同样局面，甲**跳过**不打火弹术 → 乙只吃战败惩罚。下面两条伤害断言都以它为参照。
const HP_PASS = (function () {
  const g = toWinWindow(1);
  E.act(g.st, g.A.id, { type: 'respond_pass' });
  flushAll(g.st);
  return g.B.hp;
})();
console.log('   （基线）甲跳过时乙的血量 = ' + HP_PASS);
{
  const { st, A, B } = toWinWindow(1);
  check('甲确实赢了（结果窗口开着）', /甲 战胜 乙/.test(logText(st)) && st.combat && st.combat.stage === 'result',
    st.combat && st.combat.stage);
  check('窗口事件 = combatResult，且轮到甲表态', st.pending && st.pending.event === 'combatResult' && E.pendingActor(st).id === 'a',
    st.pending && st.pending.event);

  const cands = E.pendingCards(st, A);
  check('【火弹术】被展开成 2 条候选（不是 1 条）', cands.length === 2, JSON.stringify(cands));
  check('候选 1 = 抽宝物的那一项（tier=0）', cands[0] && cands[0].tier === 0 && /抽取2张【宝物牌】/.test(cands[0].option), JSON.stringify(cands[0]));
  check('候选 2 = 额外伤害那一项（tier=1）', cands[1] && cands[1].tier === 1 && /额外受到1点伤害/.test(cands[1].option), JSON.stringify(cands[1]));
  check('下发给前端的 mine 也带 tier/option', (E.publicState(st, 'a').pending.mine || []).length === 2
    && typeof E.publicState(st, 'a').pending.mine[1].tier === 'number',
    JSON.stringify(E.publicState(st, 'a').pending.mine));
  check('对手看不到甲的候选（隐私）', !(E.publicState(st, 'b').pending.mine), JSON.stringify(E.publicState(st, 'b').pending.mine));

  // ⭐ 选**选项 2**：乙额外受 1 点伤害
  const r = E.act(st, A.id, { type: 'respond_play', uid: 9101, tier: 1 });
  check('respond_play 带 tier=1 被接受（以前没有这个入参）', r.ok === true, JSON.stringify(r));
  check('战报写明选的是哪一项', /选：对战胜利时，让对方额外受到1点伤害/.test(logText(st)),
    logText(st).split(' | ').filter((t) => /火弹术/.test(t)).join(' /// '));
  flushAll(st);
  check(`选"额外伤害"后乙比跳过时正好多掉 1 点血（${HP_PASS} -> ${B.hp}）`, B.hp === HP_PASS - 1, `${HP_PASS} -> ${B.hp}`);
  check('对战正常结算完毕', st.combat === null, JSON.stringify(st.combat && st.combat.stage));
}
{
  // ⭐ 选**选项 1**：从乙手里抽 2 张宝物牌（且不会额外掉那 1 点血）
  const { st, A, B } = toWinWindow(1);
  const bBefore = B.hand.length;
  const r = E.act(st, A.id, { type: 'respond_play', uid: 9101, tier: 0 });
  check('respond_play 带 tier=0 被接受', r.ok === true, JSON.stringify(r));
  flushAll(st);
  check('甲从乙手里抽走 2 张宝物牌（选项 1 生效）', A.hand.length === 2 && B.hand.length === bBefore - 2,
    `A手牌=${A.hand.length}，B ${bBefore}->${B.hand.length}`);
  check('选项 1 不会额外掉血（与跳过时同血量）', B.hp === HP_PASS, `${HP_PASS} vs ${B.hp}`);

  // 兼容：不传 tier 的旧客户端照样能打（走兜底档），不会报错
  const g2 = toWinWindow(1);
  const r2 = E.act(g2.st, g2.A.id, { type: 'respond_play', uid: 9101 });
  check('旧客户端不传 tier 也不崩（走兜底档）', r2.ok === true, JSON.stringify(r2));
}

// ================================================================ E 灵根 8 张配比
console.log('\n[E] 灵根符 8 张配比（天 1 / 双 1 / 三 3 / 伪 3）');
check('ROOT_DECK 共 8 张', E.ROOT_DECK && E.ROOT_DECK.length === 8, E.ROOT_DECK && String(E.ROOT_DECK.length));
{
  const cnt = {};
  for (const k of E.ROOT_DECK || []) cnt[k] = (cnt[k] || 0) + 1;
  check('天灵根 1 张', cnt.tian === 1, String(cnt.tian));
  check('双灵根 1 张', cnt.shuang === 1, String(cnt.shuang));
  check('三灵根 3 张', cnt.san === 3, String(cnt.san));
  check('伪灵根 3 张', cnt.wei === 3, String(cnt.wei));
}
{
  // 200 局 4 人（每局从 8 张里抽 4 张，抽走不放回）
  const games = 200;
  const tally = { tian: 0, shuang: 0, san: 0, wei: 0 };
  let dupGames = 0, noTianGames = 0, initiativeRollGames = 0;
  for (let seed = 1; seed <= games; seed++) {
    const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }, { id: 'c', name: '丙' }, { id: 'd', name: '丁' }], { seed: seed });
    E.beginGame(st);
    const roots = st.players.map((q) => q.root);
    for (const r of roots) tally[r] = (tally[r] || 0) + 1;
    const uniq = new Set(roots);
    if (uniq.size < roots.length) dupGames++;            // 有人抽到同资质
    if (!uniq.has('tian')) noTianGames++;                // 天灵根一张没被抽到
    if (/争夺先手/.test(logText(st))) initiativeRollGames++;
  }
  console.log('   200 局分布:', JSON.stringify(tally), `| 同资质局=${dupGames} | 无天灵根局=${noTianGames} | 掷骰争先手局=${initiativeRollGames}`);
  const near = (v, want) => v >= want * 0.75 && v <= want * 1.25;
  check(`天灵根出现约 100 次（期望 100，实得 ${tally.tian}）`, near(tally.tian, 100), String(tally.tian));
  check(`双灵根出现约 100 次（期望 100，实得 ${tally.shuang}）`, near(tally.shuang, 100), String(tally.shuang));
  check(`三灵根出现约 300 次（期望 300，实得 ${tally.san}）`, near(tally.san, 300), String(tally.san));
  check(`伪灵根出现约 300 次（期望 300，实得 ${tally.wei}）`, near(tally.wei, 300), String(tally.wei));
  check('4 人局会出现"两人同资质"（旧实现绝不重样）', dupGames > games * 0.5, String(dupGames));
  check('4 人局有时一个人都抽不到天灵根（旧实现必定有人抽到）', noTianGames > games * 0.3, String(noTianGames));
  check('"同资质掷骰争先手"是真会走到的活代码', initiativeRollGames > 0, String(initiativeRollGames));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
