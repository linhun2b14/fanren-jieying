'use strict';
// 规则回归：**每个人的第一个回合不能发起对战**（各自先铺一回合场，第 2 个回合起解锁）。
// 注意是"每个人各自的第一个回合"，不是"游戏第一回合"——所以要逐人计数（pl.turnsTaken），
// 而且**被跳过的那一回合也算轮到过他**，否则被跳一次会让解锁往后多拖一轮。
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

function setup(seed, realmA, realmB) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  const A = st.players[0], B = st.players[1];
  A.realm = realmA === undefined ? 2 : realmA;
  B.realm = realmB === undefined ? 2 : realmB;
  A.mana = 12; B.mana = 12;
  A.hand = []; B.hand = []; A.equip = []; B.equip = [];
  A.companions = []; B.companions = []; A.spells = []; B.spells = [];
  return { st: st, A: A, B: B };
}
/** 把回合推进到指定玩家，并停在行动阶段（不依赖谁是先手） */
function toAction(st, pid) {
  let g = 0;
  while (st.players[st.turn].id !== pid && g++ < 10) {
    const cur = st.players[st.turn];
    if (st.combat) { st.combat = null; }
    st.turnFlags = { combat: false, promote: false };
    E.act(st, cur.id, { type: 'end_turn' });
  }
  st.step = 'action';
  st.turnFlags = { combat: false, promote: false };
}

console.log('[A] 第一个回合：不能发起对战');
{
  const { st, A, B } = setup(7101);
  // 谁是先手不重要：把回合定到甲，并确保这是甲的第一个回合
  A.turnsTaken = 1; B.turnsTaken = 0;
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const r = E.act(st, A.id, { type: 'combat', target: B.id });
  check('甲第一个回合发起对战被拒', !r.ok, JSON.stringify(r));
  check('拒绝理由说明是第一个回合', /第一个回合/.test(r.error || ''), r.error);
  check('没有建立对战', !st.combat);
  check('本回合的对战标记没被消耗', !st.turnFlags.combat);
  let ps = E.publicState(st, 'a');
  check('publicState 里 canCombat=false', ps.players.find((x) => x.id === 'a').canCombat === false);
  check('publicState 里 turnsTaken=1', ps.players.find((x) => x.id === 'a').turnsTaken === 1);
}

console.log('\n[B] 第二个回合：解锁');
{
  const { st, A, B } = setup(7102);
  A.turnsTaken = 2; B.turnsTaken = 2;
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const r = E.act(st, A.id, { type: 'combat', target: B.id });
  check('甲第二个回合能发起对战', r.ok && !!st.combat, JSON.stringify(r));
  check('publicState 里 canCombat=true', E.publicState(st, 'a').players.find((x) => x.id === 'a').canCombat === true);
}

console.log('\n[C] 是"各自"的第一个回合，不是"游戏第一回合"');
{
  const { st, A, B } = setup(7103);
  // 甲已经打过一轮（turnsTaken=2），乙还是第一个回合
  A.turnsTaken = 2; B.turnsTaken = 1;
  st.turn = 1; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const rb = E.act(st, B.id, { type: 'combat', target: A.id });
  check('轮次靠后的乙在自己的第一个回合同样不能打', !rb.ok && !st.combat, JSON.stringify(rb));
  // 换甲（第 2 回合）就能打
  st.turn = 0; st.turnFlags = { combat: false, promote: false };
  const ra = E.act(st, A.id, { type: 'combat', target: B.id });
  check('甲（第 2 个回合）能打', ra.ok && !!st.combat, JSON.stringify(ra));
}

console.log('\n[D] turnsTaken 随回合真实递增（走完整流程，不手工改）');
{
  const { st, A, B } = setup(7104);
  const first = st.players[st.turn];
  const other = first.id === 'a' ? B : A;
  check('先手的 turnsTaken=1（开局那一次已计入）', first.turnsTaken === 1, String(first.turnsTaken));
  check('后手的 turnsTaken=0', other.turnsTaken === 0, String(other.turnsTaken));
  E.act(st, first.id, { type: 'end_turn' });        // 先手 → 后手
  check('轮到后手，其 turnsTaken=1', other.turnsTaken === 1, String(other.turnsTaken));
  st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const r1 = E.act(st, other.id, { type: 'combat', target: first.id });
  check('后手第一个回合不能打', !r1.ok, JSON.stringify(r1));
  E.act(st, other.id, { type: 'end_turn' });        // 后手 → 先手（第 2 次）
  check('先手的 turnsTaken=2', first.turnsTaken === 2, String(first.turnsTaken));
  st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const r2 = E.act(st, first.id, { type: 'combat', target: other.id });
  check('先手第二个回合能打', r2.ok && !!st.combat, JSON.stringify(r2));
}

console.log('\n[E] 被跳过的那一回合也算"轮到过他"');
{
  const { st, A, B } = setup(7105);
  A.turnsTaken = 1; B.turnsTaken = 0;
  st.turn = 0;
  B.skip = 1;                                   // 模拟【寒黎珠】：乙的下一回合被跳过
  E.act(st, A.id, { type: 'end_turn' });        // 甲 → （乙被跳过）→ 甲
  check('乙的回合被跳过', st.players[st.turn].id === 'a', st.players[st.turn].id);
  check('乙的 turnsTaken 也涨到 1（跳过不等于没轮到）', B.turnsTaken === 1, String(B.turnsTaken));
  check('甲的 turnsTaken=2', A.turnsTaken === 2, String(A.turnsTaken));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
void C;
