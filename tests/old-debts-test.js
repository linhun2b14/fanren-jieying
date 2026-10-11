'use strict';
/**
 * 「老欠账」三条引擎修复的回归（2026-10-05 第 10 件，交接文档 §5.2）：
 *   [A] **行动 / 抽取阶段挂机**：以前只有对战与打断窗口有超时 → 行动阶段挂机 = 全桌永久卡死。
 *       现在 `E.autoIdleAction(state)` 给出"该自动做什么"，服务端看门狗到点代打（战报写明〔超时〕）。
 *   [B] **伪丹期（【血凝五行丹】）的收尾**：以前 `pseudoRealm.turns` 从来没人递减 → 伪丹期永久。
 *       现在按卡文在自己回合结束递减，归零时"没到结丹 → 回筑基 + 自伤 1 点"。
 *   [C] **两处缺闸**：① `doPromote` 没有"对战中禁止晋升"；② 闭关者不免疫 skip_turn / steal_card
 *       （卡文明写"闭关期间不受任何卡牌效果影响"）。
 */
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const logText = (st) => st.log.map((l) => l.text).join(' | ');
const T = (n) => { const c = [].concat(C.cards().treasure, C.cards().spell, C.cards().companion).find((x) => x.name === n); if (!c) throw new Error('卡池里没有【' + n + '】'); return c; };
let UID = 77000;
const mk = (id) => ({ uid: ++UID, id: id });

function setup(seed, o) {
  o = o || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = o.step || 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = o.aRealm == null ? 2 : o.aRealm;
  B.realm = o.bRealm == null ? 2 : o.bRealm;
  A.mana = 12; B.mana = 12; A.hp = 6; B.hp = 6;
  A.hand = []; B.hand = []; A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = []; A.puppets = []; B.puppets = []; A.qiCards = []; B.qiCards = [];
  // 灵气牌堆换成纯 1 点的【稀薄灵气】：别的灵气牌自带附加效果（【充裕灵气】一次给 4 点），
  // 会让"抽了 1 张灵气牌"这类计数断言假红 —— 而洗牌顺序会随卡池张数漂移（2026-10-06 实测踩到）。
  const plain = C.cards().qi.find((c) => c.name === '稀薄灵气').id;
  st.decks.qi.draw = [];
  for (let i = 0; i < 60; i++) st.decks.qi.draw.push(plain);
  if (o.aHand) A.hand = o.aHand.map((n) => mk(T(n).id));
  if (o.bHand) B.hand = o.bHand.map((n) => mk(T(n).id));
  return { st: st, A: A, B: B };
}

// ================================================================ [A] 行动阶段挂机兜底
console.log('\n[A] 行动 / 抽取阶段挂机：看门狗该自动做什么（autoIdleAction）');
{
  const s1 = setup(13101, { step: 'draw_qi' });
  const a1 = E.autoIdleAction(s1.st);
  check('抽取灵气阶段 → 自动抽 1 张【灵气牌】',
    !!(a1 && a1.pid === 'a' && a1.action.type === 'draw_qi'), JSON.stringify(a1));
  const qi0 = s1.A.qiCards.length;
  const r1 = E.act(s1.st, a1.pid, a1.action);
  check('代打之后阶段真的推进了（抽到灵气 + 进入探索阶段）',
    r1.ok && s1.A.qiCards.length === qi0 + 1 && s1.st.step === 'draw_treasure',
    JSON.stringify({ r: r1, qi: s1.A.qiCards.length, step: s1.st.step }));
  check('战报写明「〔超时〕…系统自动…」', /〔超时〕/.test(logText(s1.st)), logText(s1.st).slice(-120));

  const s2 = setup(13102, { step: 'draw_treasure' });
  const a2 = E.autoIdleAction(s2.st);
  check('探索阶段 → 自动抽宝物牌', !!(a2 && a2.action.type === 'draw_treasure'), JSON.stringify(a2));
  E.act(s2.st, a2.pid, a2.action);
  check('探索抽完进入抉择阶段', s2.st.step === 'choose_draw', s2.st.step);

  const s3 = setup(13103, { step: 'choose_draw' });
  const a3 = E.autoIdleAction(s3.st);
  check('抉择阶段 → 自动抽法术牌', !!(a3 && a3.action.type === 'choose_draw' && a3.action.deck === 'spell'), JSON.stringify(a3));
  E.act(s3.st, a3.pid, a3.action);
  check('抉择完进入行动阶段', s3.st.step === 'action', s3.st.step);

  const s4 = setup(13104);
  const a4 = E.autoIdleAction(s4.st);
  check('行动阶段 → 自动结束回合', !!(a4 && a4.action.type === 'end_turn'), JSON.stringify(a4));
  E.act(s4.st, a4.pid, a4.action);
  check('回合真的交给下一家了', s4.st.turn === 1, String(s4.st.turn));

  const s5 = setup(13105);
  s5.st.pending = { queue: ['a'], chain: [], passed: {}, event: 'hurt', ctx: {}, subjectId: 'a' };
  check('有【斗法】窗口时不代打（交给窗口自己的看门狗）', E.autoIdleAction(s5.st) === null, '');
  const s6 = setup(13106);
  s6.st.forceDiscard = { playerId: 'a', need: 2 };
  check('等玩家自己挑弃牌时不代打（超时不替他挑）', E.autoIdleAction(s6.st) === null, '');
}

// ================================================================ [B] 伪丹期收尾
console.log('\n[B] 伪丹期（【血凝五行丹】）：回合结束递减，归零时回筑基 + 自伤');
{
  const PILL = T('血凝五行丹');
  const s = setup(13201, { aRealm: 1, aHand: ['血凝五行丹'] });     // 筑基期吃丹
  const r = E.act(s.st, 'a', { type: 'play', uid: s.A.hand[0].uid });
  check('吃下【血凝五行丹】', r.ok, JSON.stringify(r));
  check('伪丹期记了 2 回合', !!(s.A.pseudoRealm && s.A.pseudoRealm.turns === 2), JSON.stringify(s.A.pseudoRealm));
  check('对外生效境界变成结丹期（effRealm = 3）', E.effRealm(s.A) === 3, String(E.effRealm(s.A)));
  check('战力也按结丹期算（基础 3 + 1 = 4）', E.baseCombat(s.A) === 4, String(E.baseCombat(s.A)));

  // 第一个自己的回合结束 → 还剩 1
  E.act(s.st, 'a', { type: 'end_turn' });
  check('第 1 个回合结束 → 剩 1 回合（以前永远不递减）',
    !!(s.A.pseudoRealm && s.A.pseudoRealm.turns === 1), JSON.stringify(s.A.pseudoRealm));
  check('还在伪丹期（effRealm 仍是 3）', E.effRealm(s.A) === 3, String(E.effRealm(s.A)));

  // 第二个自己的回合结束 → 归零：没到结丹 → 回筑基 + 自伤 1
  s.st.turn = 0; s.st.step = 'action'; s.st.turnFlags = { combat: false, promote: false };
  const hp0 = s.A.hp;
  E.act(s.st, 'a', { type: 'end_turn' });
  check('伪丹期结束（字段清空）', !s.A.pseudoRealm, JSON.stringify(s.A.pseudoRealm));
  check('没结成金丹 → 境界退回筑基期', s.A.realm === 1, String(s.A.realm));
  check('自身受到 1 点伤害', s.A.hp === hp0 - 1, `${hp0} -> ${s.A.hp}`);
  check('战报写明"未能结成金丹"', /未能结成金丹/.test(logText(s.st)), logText(s.st).slice(-160));

  // 真晋到结丹期再吃丹 → 归零时平稳结束、不掉血
  const s2 = setup(13202, { aRealm: 3, aHand: ['血凝五行丹'] });
  E.act(s2.st, 'a', { type: 'play', uid: s2.A.hand[0].uid });
  E.act(s2.st, 'a', { type: 'end_turn' });
  s2.st.turn = 0; s2.st.step = 'action'; s2.st.turnFlags = { combat: false, promote: false };
  const hp2 = s2.A.hp;
  E.act(s2.st, 'a', { type: 'end_turn' });
  check('已达成结丹期 → 伪丹期平稳结束、不掉血',
    !s2.A.pseudoRealm && s2.A.realm === 3 && s2.A.hp === hp2, `realm=${s2.A.realm} hp=${s2.A.hp}`);
}

// ================================================================ [C] 两处缺闸
console.log('\n[C] 缺闸：对战中禁止晋升 / 闭关者免疫跳过与夺牌');
{
  const s = setup(13301, { aRealm: 1 });
  s.A.qiCards = new Array(20).fill(0).map((_, i) => ({ uid: 90000 + i, id: C.cards().qi[0].id }));
  E.act(s.st, 'a', { type: 'combat', target: 'b' });
  check('对战窗口/对战进行中', !!(s.st.pending || s.st.combat), '');
  const r = E.act(s.st, 'a', { type: 'promote' });
  check('对战中晋升被拒', r.ok === false && /对战/.test(r.error || ''), JSON.stringify(r));

  // ① 伤害 + 跳过回合（【禁神牌】）打闭关者：伤害与跳过都该无效
  const s2 = setup(13302, { aHand: ['禁神牌'], aRealm: 2, bRealm: 2 });
  s2.B.inSeclusion = true;
  const hp0 = s2.B.hp;
  const r2 = E.act(s2.st, 'a', { type: 'play', uid: s2.A.hand[0].uid, target: 'b' });
  check('对闭关者打【禁神牌】：不掉血', r2.ok && s2.B.hp === hp0, `${hp0} -> ${s2.B.hp}`);
  check('也不被跳过回合（闭关者不受卡牌效果影响）', !s2.B.skip, String(s2.B.skip));
  check('战报写明"闭关，不受卡牌效果影响"', /闭关/.test(logText(s2.st)), logText(s2.st).slice(-160));

  // ② 纯"跳过 N 回合"的 op（【寒黎珠】）同样对闭关者无效
  const s3 = setup(13303, { aHand: ['寒黎珠'], aRealm: 2, bRealm: 2 });
  s3.B.inSeclusion = true;
  E.act(s3.st, 'a', { type: 'play', uid: s3.A.hand[0].uid, target: 'b' });
  check('【寒黎珠】对闭关者也不生效', !s3.B.skip, String(s3.B.skip));

  // ③ 夺取手牌（steal_card）：闭关者免疫 —— 池里现在没有这张牌，用一个测试卡直接验 op
  const TESTCARD = C.cards().treasure.push({
    id: 'test_steal_card', name: '测试·夺手牌', type: 'consume', cost: 0, realm: 0, count: 1, cat: '消耗类法器',
    text: '（测试卡）指定一位修士，夺取其 1 张手牌。',
    effects: [{ op: 'steal_card', event: 'useCard', subject: 'self', phase: 'after' }],
  });
  const s4 = setup(13304, { aRealm: 2 });
  s4.A.hand = [{ uid: 61000, id: 'test_steal_card' }];
  s4.B.inSeclusion = true;
  const bHand0 = s4.B.hand.length;
  E.act(s4.st, 'a', { type: 'play', uid: 61000, target: 'b' });
  check('对闭关者【夺手牌】：乙的手牌一张没少', s4.B.hand.length === bHand0, `${bHand0} -> ${s4.B.hand.length}`);
  check('战报写明闭关挡住夺牌', /闭关/.test(logText(s4.st)), logText(s4.st).slice(-140));
  void TESTCARD;
  // 对照：不闭关时正常夺走 1 张
  const s5 = setup(13305, { aRealm: 2 });
  s5.A.hand = [{ uid: 61001, id: 'test_steal_card' }];
  s5.B.hand = [{ uid: 61002, id: T('禁神牌').id }];     // 目标手里得有牌可夺
  const b5 = s5.B.hand.length;
  E.act(s5.st, 'a', { type: 'play', uid: 61001, target: 'b' });
  check('对照：目标没闭关时正常夺走 1 张', s5.B.hand.length === b5 - 1 && s5.A.hand.length === 1,
    JSON.stringify({ b: s5.B.hand.length, a: s5.A.hand.length }));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
