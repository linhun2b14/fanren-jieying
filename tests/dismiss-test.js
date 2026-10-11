'use strict';
// 撤下机制（用户裁定 A 方案）回归守卫：
//   自己回合的**行动阶段**，可把自己场上的 同行者 / 储物袋装备 / 法术区装备 / 傀儡
//   **免费撤下**进弃牌堆腾格；不限次数、不可收回；放新牌仍按原规则。
// 之前这块只有实现没有测试 —— 本次补上，顺带锁住"撤下后被动效果立即失效"的联动。
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const T = (n) => C.cards().treasure.find((c) => c.name === n);
const S = (n) => C.cards().spell.find((c) => c.name === n);
const CP = (n) => C.cards().companion.find((c) => c.name === n);
const logText = (st) => st.log.map((l) => l.text).join(' | ');
const disc = (st, deck) => (st.decks[deck] && st.decks[deck].discard ? st.decks[deck].discard.length : 0);
const handOf = (pl, deck) => pl.hand.filter((c) => E.deckOf(c.id) === deck).length;
const flush = (st) => { let g = 0; while (st.pending && g++ < 20) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };

function setup(seed, opts) {
  const o = opts || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = o.step || 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = o.aRealm == null ? 3 : o.aRealm;
  B.realm = o.bRealm == null ? 3 : o.bRealm;
  A.mana = 12; B.mana = 12; A.hp = 6; B.hp = 6;
  A.qiCards = []; B.qiCards = []; A.hand = []; B.hand = [];
  A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = []; A.puppets = []; B.puppets = [];
  A.dismissed = []; B.dismissed = [];
  return { st: st, A: A, B: B };
}

// ================================================================ A 同行者
console.log('[A] 行动阶段撤下同行者');
{
  const { st, A } = setup(7301);
  A.companions = [{ uid: 101, id: CP('韩立').id }];
  const d0 = disc(st, 'companion');
  const r = E.act(st, A.id, { type: 'dismiss', uid: 101 });
  check('撤下成功', r.ok, JSON.stringify(r));
  check('同行者已离开场上', A.companions.length === 0, String(A.companions.length));
  check('进了同行者弃牌堆', disc(st, 'companion') === d0 + 1, `${d0} -> ${disc(st, 'companion')}`);
  check('战报写了「撤下」', /撤下/.test(logText(st)), '');
  const again = E.act(st, A.id, { type: 'dismiss', uid: 101 });
  check('不可收回：同一个 uid 再撤被拒', !again.ok, JSON.stringify(again));
}

// ================================================================ B 储物袋装备
console.log('\n[B] 行动阶段撤下储物袋装备');
{
  const { st, A } = setup(7302);
  A.equip = [{ uid: 201, id: T('风雷翅').id }];
  const d0 = disc(st, 'treasure');
  const r = E.act(st, A.id, { type: 'dismiss', uid: 201 });
  check('撤下成功', r.ok, JSON.stringify(r));
  check('储物袋空了', A.equip.length === 0, String(A.equip.length));
  check('进了宝物牌弃牌堆', disc(st, 'treasure') === d0 + 1, `${d0} -> ${disc(st, 'treasure')}`);
}

// ================================================================ C 法术区装备
console.log('\n[C] 行动阶段撤下法术区装备');
{
  const { st, A } = setup(7303);
  A.spells = [{ uid: 301, id: S('敛气术').id }];
  const d0 = disc(st, 'spell');
  const r = E.act(st, A.id, { type: 'dismiss', uid: 301 });
  check('撤下成功', r.ok, JSON.stringify(r));
  check('法术区空了', A.spells.length === 0, String(A.spells.length));
  check('进了法术牌弃牌堆（不是宝物堆）', disc(st, 'spell') === d0 + 1, `${d0} -> ${disc(st, 'spell')}`);
}

// ================================================================ D 傀儡
console.log('\n[D] 行动阶段撤下傀儡（【傀儡蜥蜴】）');
{
  const { st, A } = setup(7304);
  const pup = T('傀儡蜥蜴');
  A.puppets = [{ uid: 401, id: pup.id, name: pup.name }];
  const d0 = disc(st, 'treasure');
  const r = E.act(st, A.id, { type: 'dismiss', uid: 401 });
  check('撤下成功', r.ok, JSON.stringify(r));
  check('傀儡位空了', A.puppets.length === 0, String(A.puppets.length));
  check('傀儡进宝物牌弃牌堆', disc(st, 'treasure') === d0 + 1, `${d0} -> ${disc(st, 'treasure')}`);
}

// ================================================================ E 拒绝情形
console.log('\n[E] 被拒的四种情形');
{
  // ① 非行动阶段
  const s1 = setup(7305, { step: 'draw_treasure' });
  s1.A.companions = [{ uid: 501, id: CP('韩立').id }];
  const r1 = E.act(s1.st, s1.A.id, { type: 'dismiss', uid: 501 });
  check('探索阶段不能撤下', !r1.ok, JSON.stringify(r1));
  check('拒绝理由写明阶段', /行动阶段/.test(r1.error || ''), r1.error);

  // ② 对战中
  const s2 = setup(7306);
  s2.A.companions = [{ uid: 502, id: CP('韩立').id }];
  E.act(s2.st, s2.A.id, { type: 'combat', target: s2.B.id });
  flush(s2.st);
  check('对战确实开起来了', !!s2.st.combat, JSON.stringify(s2.st.combat && s2.st.combat.stage));
  const r2 = E.act(s2.st, s2.A.id, { type: 'dismiss', uid: 502 });
  check('对战结算中不能撤下', !r2.ok, JSON.stringify(r2));

  // ③ 不是自己的回合
  const s3 = setup(7307);
  s3.A.companions = [{ uid: 503, id: CP('韩立').id }];
  s3.st.turn = 1;
  const r3 = E.act(s3.st, s3.A.id, { type: 'dismiss', uid: 503 });
  check('别人回合不能撤下', !r3.ok, JSON.stringify(r3));
  check('拒绝理由写明回合', /自己的回合/.test(r3.error || ''), r3.error);

  // ④ 场上没有这张牌 / uid 不存在
  const s4 = setup(7308);
  const r4 = E.act(s4.st, s4.A.id, { type: 'dismiss', uid: 9999 });
  check('场上没这张牌就拒绝', !r4.ok, JSON.stringify(r4));

  // ⑤ 时点询问开着的时候，什么动作都不能做（act 的统一闸）
  const s5 = setup(7309);
  s5.A.companions = [{ uid: 504, id: CP('韩立').id }];
  s5.A.hand = [{ uid: 505, id: T('遮天钟').id }];
  E.applyDamage(s5.st, s5.A, 1, 'test');
  check('受伤开出了时点询问', !!(s5.st.pending && s5.st.pending.event === 'hurt'), s5.st.pending && s5.st.pending.event);
  const r5 = E.act(s5.st, s5.A.id, { type: 'dismiss', uid: 504 });
  check('询问期间不能撤下', !r5.ok, JSON.stringify(r5));
}

// ================================================================ F 手牌上限立即收回
console.log('\n[F] 撤下【噬金虫】→ 手牌上限立即收回，超出的宝物牌被弃');
{
  const { st, A } = setup(7310);
  A.companions = [{ uid: 601, id: CP('噬金虫').id }];
  const names = ['青蛟旗', '红线遁光针', '花篮', '寒冰珠', '天雷子', '金光砖符', '青火雷'];
  A.hand = names.map((n, i) => ({ uid: 700 + i, id: T(n).id }));
  check('开局手牌 7 张宝物牌', handOf(A, 'treasure') === 7, String(handOf(A, 'treasure')));
  check('带着【噬金虫】时上限是 7（6+1），一张都不用弃', handOf(A, 'treasure') === 7, String(handOf(A, 'treasure')));
  const d0 = disc(st, 'treasure');
  const r = E.act(st, A.id, { type: 'dismiss', uid: 601 });
  check('撤下成功', r.ok, JSON.stringify(r));
  check('上限立即收回 → 手里只剩 6 张', handOf(A, 'treasure') === 6, String(handOf(A, 'treasure')));
  check('多出的那张进了宝物牌弃牌堆', disc(st, 'treasure') === d0 + 1, `${d0} -> ${disc(st, 'treasure')}`);
  check('战报写明超上限弃置', /超过 6 张上限/.test(logText(st)), '');
}

// ================================================================ G 被动效果实时失效
console.log('\n[G] 撤下后被动效果立即失效（【凌玉灵】骰点 +1）');
{
  const { st, A } = setup(7311);
  A.companions = [{ uid: 801, id: CP('凌玉灵').id }];
  check('带着【凌玉灵】时骰点 +1', E.companionCombat(st, A, null).diceBonus === 1,
    JSON.stringify(E.companionCombat(st, A, null)));
  const r = E.act(st, A.id, { type: 'dismiss', uid: 801 });
  check('撤下成功', r.ok, JSON.stringify(r));
  check('撤下后骰点加成归零', E.companionCombat(st, A, null).diceBonus === 0,
    JSON.stringify(E.companionCombat(st, A, null)));
}

// ================================================================ H 不限次数
console.log('\n[H] 不限次数：一回合里可以把场上的牌一张张全撤光');
{
  const { st, A } = setup(7312);
  A.companions = [{ uid: 901, id: CP('韩立').id }, { uid: 902, id: CP('凌玉灵').id }];
  A.equip = [{ uid: 903, id: T('风雷翅').id }];
  A.spells = [{ uid: 904, id: S('长春功').id }];
  A.puppets = [{ uid: 905, id: T('傀儡蜥蜴').id, name: '傀儡蜥蜴' }];
  let ok = 0;
  for (const u of [901, 902, 903, 904, 905]) {
    const r = E.act(st, A.id, { type: 'dismiss', uid: u });
    if (r.ok) ok++;
  }
  check('5 张全部撤下成功（同行者×2 / 储物袋 / 法术区 / 傀儡）', ok === 5, String(ok));
  check('场上彻底清空', A.companions.length === 0 && A.equip.length === 0 && A.spells.length === 0 && A.puppets.length === 0,
    JSON.stringify([A.companions.length, A.equip.length, A.spells.length, A.puppets.length]));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
