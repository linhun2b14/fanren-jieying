'use strict';
// 回合结束「手牌超上限」回归 —— 用户裁定：**超上限当然是自己挑弃哪些牌**。
// 所以回合结束不再自动替他弃（旧行为是从手牌末尾一路弃到上限，玩家没得选、还常常没注意到），
// 而是挂起一个"必须弃到上限"的状态，等他自己点手牌弃够，再把回合走完。
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const CP = (n) => C.cards().companion.find((c) => c.name === n);
const logText = (st) => st.log.map((l) => l.text).join(' | ');
const handOf = (pl, deck) => pl.hand.filter((c) => E.deckOf(c.id) === deck).length;
// 从卡池里现取（避免写死卡名后卡池改动把测试弄坏）
const TRE_IDS = C.cards().treasure.map((c) => c.id);
const SPE_IDS = C.cards().spell.map((c) => c.id);

function setup(seed, o) {
  o = o || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  st.players.forEach((q) => { q.turnsTaken = 2; });
  st.turn = 0; st.step = o.step || 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = 3; B.realm = 3; A.mana = 12; B.mana = 12; A.hp = 6; B.hp = 6;
  A.hand = []; B.hand = []; A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = []; A.puppets = []; B.puppets = [];
  return { st: st, A: A, B: B };
}
const give = (pl, ids, from, n) => { for (let i = 0; i < n; i++) pl.hand.push({ uid: from + i, id: ids[i % ids.length] }); };

// ================================================================ A 挂起而不是替他弃
console.log('[A] 超上限结束回合 → 挂起等他挑，不自动弃');
{
  const { st, A, B } = setup(9601);
  give(A, TRE_IDS, 100, 8);                       // 宝物 8 张（上限 6）
  const r = E.act(st, A.id, { type: 'end_turn' });
  check('end_turn 返回 forcedDiscard = 2', r.ok && r.forcedDiscard === 2, JSON.stringify(r));
  check('挂起了 forceDiscard', !!(st.forceDiscard && st.forceDiscard.playerId === A.id), JSON.stringify(st.forceDiscard));
  check('要弃 2 张', st.forceDiscard.need === 2, JSON.stringify(st.forceDiscard));
  check('按牌堆记着超了宝物 2 张', st.forceDiscard.over.treasure === 2, JSON.stringify(st.forceDiscard.over));
  check('**一张都没被自动弃**（还是 8 张）', handOf(A, 'treasure') === 8, String(handOf(A, 'treasure')));
  check('回合没有转交（还是甲的回合）', st.players[st.turn].id === A.id, st.players[st.turn].id);
  check('战报提示请自己弃置', /请弃置 2 张/.test(logText(st)), '');
  check('publicState 下发了 forceDiscard（前端据此切弃置模式）',
    !!(E.publicState(st, 'a').forceDiscard && E.publicState(st, 'a').forceDiscard.need === 2),
    JSON.stringify(E.publicState(st, 'a').forceDiscard));
}

// ================================================================ B 期间挡掉所有别的动作
console.log('\n[B] 弃够之前，别的动作一律被挡');
{
  const { st, A, B } = setup(9602);
  give(A, TRE_IDS, 100, 8);
  E.act(st, A.id, { type: 'end_turn' });
  for (const a of [{ type: 'draw_qi' }, { type: 'promote' }, { type: 'combat', target: 'b' },
    { type: 'end_turn' }, { type: 'dismiss', uid: 1 }]) {
    const rr = E.act(st, A.id, a);
    check(`  ${a.type} 被拒`, !rr.ok && /超出上限/.test(rr.error || ''), JSON.stringify(rr));
  }
  const rOther = E.act(st, B.id, { type: 'draw_qi' });
  check('对手也动不了', !rOther.ok, JSON.stringify(rOther));
  const rOtherDiscard = E.act(st, B.id, { type: 'discard', uid: 999 });
  check('对手不能替你弃牌', !rOtherDiscard.ok && /正在等/.test(rOtherDiscard.error || ''), JSON.stringify(rOtherDiscard));
}

// ================================================================ C 弃够就把回合走完
console.log('\n[C] 自己挑着弃够 → 回合正常结束');
{
  const { st, A, B } = setup(9603);
  give(A, TRE_IDS, 100, 8);
  const ids = TRE_IDS.slice(0, 8);
  A.hand = ids.map((id, i) => ({ uid: 100 + i, id: id }));   // 固定 uid 好挑
  E.act(st, A.id, { type: 'end_turn' });
  // 故意挑**中间**那两张弃（不是末尾），验证真的是玩家在选
  const pick = [A.hand[3].uid, A.hand[4].uid];
  const gone = [A.hand[3].id, A.hand[4].id];
  check('弃第 1 张', E.act(st, A.id, { type: 'discard', uid: pick[0] }).ok);
  check('还需弃 1 张', st.forceDiscard && st.forceDiscard.need === 1, JSON.stringify(st.forceDiscard));
  check('弃第 2 张', E.act(st, A.id, { type: 'discard', uid: pick[1] }).ok);
  check('forceDiscard 已清空', !st.forceDiscard, JSON.stringify(st.forceDiscard));
  check('手牌回到上限 6 张', handOf(A, 'treasure') === 6, String(handOf(A, 'treasure')));
  check('弃的正是我挑的那两张', gone.every((id) => (st.decks.treasure.discard || []).indexOf(id) >= 0),
    JSON.stringify(st.decks.treasure.discard));
  check('回合真的转交给乙了', st.players[st.turn].id === B.id, st.players[st.turn].id);
  check('战报写明已回到上限', /手牌已回到上限内/.test(logText(st)), '');
}

// ================================================================ D 按牌堆重算，不是简单 need--
console.log('\n[D] 弃"没超的那个牌堆"不算数（每弃一张重算）');
{
  const { st, A } = setup(9604);
  A.hand = [];
  TRE_IDS.slice(0, 8).forEach((id, i) => A.hand.push({ uid: 100 + i, id: id }));  // 宝物 8（超 2）
  SPE_IDS.slice(0, 1).forEach((id, i) => A.hand.push({ uid: 200 + i, id: id }));  // 法术 1（没超）
  E.act(st, A.id, { type: 'end_turn' });
  check('挂起时 need = 2', st.forceDiscard && st.forceDiscard.need === 2, JSON.stringify(st.forceDiscard));
  const spellUid = A.hand.find((c) => E.deckOf(c.id) === 'spell').uid;
  E.act(st, A.id, { type: 'discard', uid: spellUid });
  check('弃掉那张没超的法术牌后，need **仍是 2**（宝物那 2 张还超着）',
    st.forceDiscard && st.forceDiscard.need === 2, JSON.stringify(st.forceDiscard));
  check('宝物还是 8 张', handOf(A, 'treasure') === 8, String(handOf(A, 'treasure')));
}

// ================================================================ E 没超 → 行为完全不变
console.log('\n[E] 没超上限时，结束回合照旧（不挂起、不弹任何东西）');
{
  const { st, A, B } = setup(9605);
  give(A, TRE_IDS, 100, 6);
  const r = E.act(st, A.id, { type: 'end_turn' });
  check('直接结束，不返回 forcedDiscard', r.ok && !r.forcedDiscard, JSON.stringify(r));
  check('没有 forceDiscard', !st.forceDiscard, JSON.stringify(st.forceDiscard));
  check('回合转交', st.players[st.turn].id === B.id, st.players[st.turn].id);
}

// ================================================================ F 噬金虫的 +1 不该误伤
console.log('\n[F] 带【噬金虫】（上限 7）手里 7 张 → 不该触发');
{
  const { st, A, B } = setup(9606);
  A.companions = [{ uid: 900, id: CP('噬金虫').id }];
  give(A, TRE_IDS, 100, 7);
  const r = E.act(st, A.id, { type: 'end_turn' });
  check('不挂起（真上限是 7）', r.ok && !r.forcedDiscard, JSON.stringify(r));
  check('7 张原样留着', handOf(A, 'treasure') === 7, String(handOf(A, 'treasure')));
  check('回合转交', st.players[st.turn].id === B.id, st.players[st.turn].id);
}

// ================================================================ G 多牌堆一起超
console.log('\n[G] 宝物和同行者同时超 → 各按各的算，合计要弃够');
{
  const { st, A } = setup(9607);
  A.hand = [];
  TRE_IDS.slice(0, 7).forEach((id, i) => A.hand.push({ uid: 100 + i, id: id }));            // 宝物 7（超 1）
  C.cards().companion.slice(0, 3).forEach((c, i) => A.hand.push({ uid: 200 + i, id: c.id })); // 同行者 3（超 1）
  E.act(st, A.id, { type: 'end_turn' });
  check('need = 2（宝物 1 + 同行者 1）', st.forceDiscard && st.forceDiscard.need === 2, JSON.stringify(st.forceDiscard));
  check('over 分开记着', st.forceDiscard.over.treasure === 1 && st.forceDiscard.over.companion === 1,
    JSON.stringify(st.forceDiscard.over));
  const compUid = A.hand.find((c) => E.deckOf(c.id) === 'companion').uid;
  E.act(st, A.id, { type: 'discard', uid: compUid });
  check('弃 1 张同行者后 need = 1', st.forceDiscard && st.forceDiscard.need === 1, JSON.stringify(st.forceDiscard));
}

// ================================================================ H 兜底：真漏了还能收
console.log('\n[H] 兜底：真出现"没走强制流程"的超上限时，enforceHandLimits 照样收掉');
{
  const { st, A } = setup(9608);
  give(A, TRE_IDS, 100, 8);
  const dropped = E.enforceHandLimits(st, A);
  check('直接调兜底函数能弃 2 张', dropped === 2, String(dropped));
  check('手牌回到 6', handOf(A, 'treasure') === 6, String(handOf(A, 'treasure')));
}

// ================================================================ I 主动弃牌的阶段闸
// 用户裁定（2026-10-02）：**没有"主动弃置手牌"这个动作了** —— 弃牌只剩
// ① 卡片效果（如【噬金虫】离场收紧上限）② 回合结束时的那一次判定。
console.log('\n[I] 主动弃牌已移除：只有回合结束的强制弃牌期间才接受 discard');
{
  // ① 自己回合行动阶段也不能主动弃
  const s1 = setup(9609);
  s1.A.hand = [{ uid: 100, id: TRE_IDS[0] }];
  const r1 = E.act(s1.st, s1.A.id, { type: 'discard', uid: 100 });
  check('自己回合行动阶段调 discard 被拒（主动弃牌已移除）',
    !r1.ok && /回合结束时判定/.test(r1.error || ''), JSON.stringify(r1));
  check('被拒之后手牌没少', s1.A.hand.length === 1, String(s1.A.hand.length));

  // ② 别人回合更不行
  const s2 = setup(9610);
  s2.A.hand = [{ uid: 100, id: TRE_IDS[0] }];
  s2.st.turn = 1;
  const r2 = E.act(s2.st, s2.A.id, { type: 'discard', uid: 100 });
  check('别人回合调 discard 也被拒', !r2.ok && /回合结束时判定/.test(r2.error || ''), JSON.stringify(r2));

  // ③ 不存在的 uid 也拒
  const s3 = setup(9611);
  const r3 = E.act(s3.st, s3.A.id, { type: 'discard', uid: '999999' });
  check('不存在的 uid 被拒', !r3.ok, JSON.stringify(r3));

  // ④ 强制弃牌那条路照旧（唯一允许 discard 的场景）
  const s4 = setup(9612);
  give(s4.A, TRE_IDS, 100, 8);
  E.act(s4.st, s4.A.id, { type: 'end_turn' });
  check('强制弃牌期间能弃', E.act(s4.st, s4.A.id, { type: 'discard', uid: s4.A.hand[0].uid }).ok, '');

  // ⑤ uid 传字符串也要认（前端 dataset / JSON 都可能给字符串）
  const s5 = setup(9613);
  give(s5.A, TRE_IDS, 200, 8);
  E.act(s5.st, s5.A.id, { type: 'end_turn' });
  check('uid 传字符串也能弃（不会报"手里没有这张牌"）',
    E.act(s5.st, s5.A.id, { type: 'discard', uid: String(s5.A.hand[0].uid) }).ok, '');
}

// ================================================================ J 回合中途超上限**不弃牌**
// 用户质疑："如果我上个回合有 6 张满上限的宝物手牌，这回合又抽了两张、
// 再加上一些效果又抽几张，难道也要弃牌吗？这类游戏不就该回合结束后判定一次吗？"
// —— 对，就该这样。这一节把这个规则**钉死**：回合中途手牌爱超多少超多少，
// 只有 endTurn 那一次判定会收；中途绝不会有第二次判定。
console.log('\n[J] 回合中途超上限**不弃牌**（判定只有回合结束那一次）');
{
  const { st, A } = setup(9620);
  give(A, TRE_IDS, 100, 6);                        // 上回合留下的满上限 6 张
  check('开局 6 张（正好满上限）', handOf(A, 'treasure') === 6, String(handOf(A, 'treasure')));

  // 这回合继续抽：探索 2 张 + 效果再抽 2 张 —— 一共 10 张，远超上限
  const d0 = (st.decks.treasure.discard || []).length;
  A.hand.push({ uid: 200, id: TRE_IDS[0] });
  A.hand.push({ uid: 201, id: TRE_IDS[1] });
  A.hand.push({ uid: 202, id: TRE_IDS[2] });
  A.hand.push({ uid: 203, id: TRE_IDS[3] });
  check('回合中途抽到 10 张（超上限 4 张）', handOf(A, 'treasure') === 10, String(handOf(A, 'treasure')));

  // 中途做几个动作：都不该引发弃牌
  for (const a of [{ type: 'draw_qi' }, { type: 'promote' }]) {
    E.act(st, A.id, a);
    check(`  做「${a.type}」之后仍然 10 张、没有强制弃牌`,
      handOf(A, 'treasure') === 10 && !st.forceDiscard,
      `${handOf(A, 'treasure')} / forceDiscard=${JSON.stringify(st.forceDiscard)}`);
  }
  // 还能照常出牌（超上限不影响出牌）
  const playUid = A.hand.find((c) => E.deckOf(c.id) === 'treasure').uid;
  const rPlay = E.act(st, A.id, { type: 'play', uid: playUid });
  check('超上限期间照样能正常出牌（不被拦）', rPlay.ok || /目标|需要/.test(rPlay.error || ''), JSON.stringify(rPlay));
  check('中途一件都没进弃牌堆（除了刚打出的那张）',
    (st.decks.treasure.discard || []).length - d0 <= 1,
    `${d0} -> ${(st.decks.treasure.discard || []).length}`);
  check('中途没有挂起任何强制弃牌', !st.forceDiscard, JSON.stringify(st.forceDiscard));

  // **只有**结束回合那一次判定
  const before = handOf(A, 'treasure');
  const rEnd = E.act(st, A.id, { type: 'end_turn' });
  check('结束回合才第一次判定（且只是挂起等你自己挑）', rEnd.forcedDiscard > 0, JSON.stringify(rEnd));
  check('判定依据是"当时"的手牌（超多少就是多少）',
    st.forceDiscard && st.forceDiscard.need === before - 6, `${before} -> need=${st.forceDiscard && st.forceDiscard.need}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
