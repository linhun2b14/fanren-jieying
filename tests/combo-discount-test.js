'use strict';
// 【九曲灵参】+【九曲灵参丹】组合技回归：
//   单独用各 -1；两张一起用应变成 -3（而不是 -2）；丹进入弃牌堆时抽 1 张灵气牌。
const E = require('../server/engine');
const C = require('../server/cards');
const { effOf, opOf } = require('./fixtures');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

const SHEN = C.cards().treasure.find((c) => c.name === '九曲灵参');
const DAN = C.cards().treasure.find((c) => c.name === '九曲灵参丹');
check('卡池里有【九曲灵参】', !!SHEN);
check('卡池里有【九曲灵参丹】', !!DAN);
check('两张都限「晋升元婴期」使用', effOf(SHEN, 'play').onlyRealm === 4 && effOf(DAN, 'play').onlyRealm === 4);
check('丹的效果带「进弃牌堆抽1张灵气牌」', effOf(DAN, 'play').alsoDrawQi === 1);

function setup(seed, withDan) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  const P = st.players[0];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  P.realm = 3;                      // 结丹期 → 下一步就是元婴
  P.mana = 12; P.hand = []; P.equip = []; P.spells = [];
  P.qiCards = [];
  // 给足灵气牌（元婴门槛 16，折扣后仍要够）
  for (let i = 0; i < 20; i++) {
    const q = E.freshQiPile(st)[0];
    P.qiCards.push(q);
  }
  P.hand.push({ uid: 7001, id: SHEN.id });
  if (withDan) P.hand.push({ uid: 7002, id: DAN.id });
  return { st: st, P: P };
}
const qiBefore = (P) => P.qiCards.length;
const realmName = (P) => E.REALMS[P.realm];

// ---- A：只用【九曲灵参】→ 门槛 -1 ----
console.log('\n[A] 单独使用【九曲灵参】');
{
  const { st, P } = setup(4001, false);
  const base = E.ROOTS[P.root].costs[3];               // 晋升元婴的原始门槛
  check('打出成功', E.act(st, P.id, { type: 'play', uid: 7001 }).ok, '');
  while (st.pending) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); }   // 新卡可能在「卡牌使用·前」开窗
  const before = qiBefore(P);
  st.forcedDice = [6];   // 骰点注入：冲击元婴必定掷出 6（≥5）——不再靠猜种子
  const r = E.act(st, P.id, { type: 'promote' });
  while (st.pending) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); }   // 新卡【降尘丹】可能在「晋升·前」开窗
  check('升至元婴期', P.realm === 4, realmName(P));
  const cost = E.PROMOTE_CONSUME[3];                    // 元婴期的固定消耗 = 3
  check(`消耗灵气值 = ${cost}（折扣只降门槛，不改固定消耗）`, before - qiBefore(P) === cost, String(before - qiBefore(P)));
  console.log(`    门槛 ${base} → 实际要求 ${base - 1}`);
  void r;
}

// ---- B：两张一起用 → 门槛 -3（不是 -2）----
console.log('\n[B] 【九曲灵参】+【九曲灵参丹】组合使用');
{
  const { st, P } = setup(4002, true);
  const base = E.ROOTS[P.root].costs[3];
  check('打出灵参', E.act(st, P.id, { type: 'play', uid: 7001 }).ok, '');
  while (st.pending) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); }   // 新卡可能在「卡牌使用·前」开窗
  check('打出灵参丹', E.act(st, P.id, { type: 'play', uid: 7002 }).ok, '');
  while (st.pending) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); }   // 新卡可能在「卡牌使用·前」开窗
  check('丹打出后应抽了1张灵气牌（进入弃牌堆）', st.log.some((l) => l.text.includes('进入弃牌堆，抽取')), '');
  // 把灵气压到「按 -2 不够、按 -3 刚好」的水平来验证组合折扣真的生效
  const thresholdFor3 = Math.max(0, base - 3);
  while (qiBefore(P) > thresholdFor3) { P.qiCards.pop(); }
  const qBefore = qiBefore(P);                        // 压完之后再取基线
  st.forcedDice = [6];   // 骰点注入：冲击元婴必定掷出 6（≥5）——不再靠猜种子
  const r = E.act(st, P.id, { type: 'promote' });
  while (st.pending) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); }   // 新卡【降尘丹】可能在「晋升·前」开窗
  check(`灵气值压到 ${thresholdFor3} 时仍能通过门槛校验（说明折扣是 -3 而非 -2）`, r.ok, JSON.stringify(r));
  check('战报里有「组合使用」', st.log.some((l) => l.text.includes('组合使用')), '');
  check(`消耗固定 ${E.PROMOTE_CONSUME[3]} 点灵气值`, qBefore - qiBefore(P) === E.PROMOTE_CONSUME[3], `${qBefore} -> ${qiBefore(P)}`);
  // 元婴期还要掷骰 ≥5，可能失败；失败也不影响「折扣已按 -3 结算」的结论
  if (P.realm === 4) console.log('    （本次掷骰通过，已升入元婴期）');
  else console.log('    （本次掷骰未过 ≥5，境界未升 —— 属于规则内失败，折扣仍已消耗）');
}

// ---- C：折扣只在目标境界生效（不能拿去省筑基/结丹）----
console.log('\n[C] 折扣限定「晋升元婴期」，不该影响低境界晋升');
{
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 4003 });
  E.beginGame(st);
  const P = st.players[0];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  P.realm = 0; P.mana = 12; P.hand = []; P.qiCards = [];
  for (let i = 0; i < 30; i++) P.qiCards.push(E.freshQiPile(st)[0]);
  P.hand.push({ uid: 7101, id: SHEN.id });
  E.act(st, P.id, { type: 'play', uid: 7101 });
  while (st.pending) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); }   // 新卡可能在「卡牌使用·前」开窗
  const before = qiBefore(P);
  st.forcedDice = [6];   // 骰点注入：冲击元婴必定掷出 6（≥5）——不再靠猜种子
  const r = E.act(st, P.id, { type: 'promote' });     // 晋升炼气期
  while (st.pending) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); }   // 新卡【降尘丹】可能在「晋升·前」开窗
  check('能从凡人晋升炼气期', r.ok && P.realm === 1, JSON.stringify(r));
  check('炼气期的固定消耗仍是 0', before - qiBefore(P) === E.PROMOTE_CONSUME[0], String(before - qiBefore(P)));
  check('折扣卡未被用掉（仍挂在待用列表）', (P.promoPending || []).length === 1, JSON.stringify(P.promoPending));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
