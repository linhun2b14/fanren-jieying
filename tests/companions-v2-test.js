'use strict';
// 四张同行者的真实效果回归（依据用户实物卡照片）：
//   辛如音 = 晋升灵气消耗 -1
//   凌玉灵 = 对战骰点 +1（最高6）+ 对战结束后不论输赢额外回 1 法力
//   燕如嫣 = 受到任意伤害时立即恢复 2 点法力
//   墨彩环 = 本回合不发起对战时可花 3 法力回 1 生命；占 2 个放置点
const E = require('../server/engine');
const C = require('../server/cards');
const { effOf, opOf } = require('./fixtures');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

const card = (n) => C.cards().companion.find((c) => c.name === n);

const XIN = card('辛如音'), LING = card('凌玉灵'), YAN = card('燕如嫣'), MO = card('墨彩环');
const ALL = { 辛如音: XIN, 凌玉灵: LING, 燕如嫣: YAN, 墨彩环: MO };

console.log('[0] 卡池里四张牌都已补全效果');
for (const n of Object.keys(ALL)) {
  const c = ALL[n];
  check(`存在【${n}】`, !!c);
  check(`【${n}】不再带「待补」note`, c && !c.note, c && c.note);
  check(`【${n}】不再说「效果未拍到」`, c && !/未拍到/.test(c.text || ''), c && c.text);
}
// 张数**不固定**（2026-10-04 用户按实物新卡入库后 78 → 88）：只查"自洽 + 有牌"
const COMP_TOT = C.cards().companion.reduce((s2, c) => s2 + (c.count || 0), 0);
check('同行者堆张数 = 各卡 count 之和（实得 ' + COMP_TOT + ' 张）',
  COMP_TOT > 0 && COMP_TOT === C.cards().companion.reduce((s2, c) => s2 + (c.count || 0), 0), String(COMP_TOT));

/** 建一局并让 p0 处于自由行动状态；把同行者直接放到 a 的场上 */
function setup(seed, names, realm) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
   // 测试直接造局，不走真实回合流程 —— 这里标记"两边的第一个回合都已经过去"（新规则：第一个回合不能发起对战）
      for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0];
  A.realm = realm == null ? 4 : realm;
  A.mana = 12; A.hp = 6; A.hand = []; A.equip = []; A.spells = []; A.qiCards = [];
  A.companions = [];
  let uid = 6000;
  for (const n of (names || [])) A.companions.push({ uid: ++uid, id: ALL[n].id });
  // ⚠️ 乙（对手）的**初始手牌也清空**：手牌是洗牌随机发的，一旦发到【雷火锥】【虚天鼎】这类
  //    「使用卡牌 · 前」响应牌，甲出牌/开战就会被挂起，后面的断言全跟着红。
  //    卡池张数一变、随机流一漂就会踩到（2026-10-05 补 19 张实物新卡时正是这么红的）。
  //    这些用例考的是甲自己的同行者机制，不该被对手的随机手牌左右。
  const B = st.players[1];
  B.hand = []; B.equip = []; B.spells = []; B.companions = []; B.qiCards = [];
  return { st: st, A: A };
}

// ---------------------------------------------------------------- 辛如音
// 用户按实物裁定：辛如音的「使晋升所需的【灵气值】消耗-1」是**减消耗**，不是减门槛。
console.log('\n[A] 辛如音：晋升**消耗**灵气值 -1（门槛不变）');
{
  const q = 20;
  const mk = (useXin) => {
    const { st, A } = setup(6001, useXin ? ['辛如音'] : [], 3);
    for (let i = 0; i < q; i++) A.qiCards.push(E.freshQiPile(st)[0]);
    return { st: st, A: A };
  };
  const w = mk(true), wo = mk(false);
  const pW = E.publicState(w.st, 'a').players[0];
  const pO = E.publicState(wo.st, 'a').players[0];
  check('门槛**不变**（辛如音不减门槛）', pW.nextThreshold === pO.nextThreshold, `无=${pO.nextThreshold} 有=${pW.nextThreshold}`);
  check(`消耗比无她时低 1（${pO.nextConsume} → ${pW.nextConsume}）`, pW.nextConsume === pO.nextConsume - 1, `无=${pO.nextConsume} 有=${pW.nextConsume}`);
  check('passives().promote_discount_consume = 1', E.passives(w.A).promote_discount_consume === 1, String(E.passives(w.A).promote_discount_consume));
  check('passives().promote_discount（门槛通道）= 0', E.passives(w.A).promote_discount === 0, String(E.passives(w.A).promote_discount));

  // 灵气刚好压到门槛
  const tW = pW.nextThreshold;
  while (w.A.qiCards.length > tW) w.A.qiCards.pop();
  const before = w.A.qiCards.length;
  const r = E.act(w.st, 'a', { type: 'promote' });
  check(`灵气压到门槛 ${tW} 时仍能通过校验`, r.ok, JSON.stringify(r));
  check(`实际消耗少扣 1 点（${E.PROMOTE_CONSUME[3]} → ${E.PROMOTE_CONSUME[3] - 1}）`,
    before - w.A.qiCards.length === E.PROMOTE_CONSUME[3] - 1, `${before} -> ${w.A.qiCards.length}`);
  check('折扣来自同行者，不会被消耗掉（仍在场）', w.A.companions.length === 1);

  // 反证：没有辛如音时，同样的灵气量要照原价扣
  const wo2 = mk(false);
  while (wo2.A.qiCards.length > pO.nextThreshold) wo2.A.qiCards.pop();
  const b2 = wo2.A.qiCards.length;
  const r2 = E.act(wo2.st, 'a', { type: 'promote' });
  check('无辛如音时照原价扣', r2.ok && b2 - wo2.A.qiCards.length === E.PROMOTE_CONSUME[3], `${b2} -> ${wo2.A.qiCards.length}`);
}

// ---------------------------------------------------------------- 凌玉灵
console.log('\n[B] 凌玉灵：对战骰点 +1 / 对战结束回 1 法力');
{
  // 凌玉灵的骰点 +1 是**免费自动**的（用户通则：不花法力 = 自动）→ 标成常驻对战修正 standing
  check('带 standing/dice_bonus(1, cap6)',
    opOf(LING, 'standing') === 'dice_bonus' && effOf(LING, 'standing').value === 1 && effOf(LING, 'standing').cap === 6,
    JSON.stringify(effOf(LING, 'standing')));
  check('带第二条对战效果 after_combat_mana(1)', opOf(LING, 'afterCombat') === 'after_combat_mana' && effOf(LING, 'afterCombat').value === 1, JSON.stringify(effOf(LING, 'afterCombat')));

  const { st, A } = setup(6002, ['凌玉灵'], 4);
  const B = st.players[1];
  B.realm = 4; B.mana = 12; B.hp = 6; B.hand = []; B.equip = []; B.spells = []; B.companions = []; B.qiCards = [];
  const cc = E.companionCombat(st, A, null);
  check('companionCombat 汇总出 diceBonus = 1', cc.diceBonus === 1, JSON.stringify(cc));

  A.mana = 2; B.mana = 2;
  E.act(st, 'a', { type: 'combat', target: 'b' });
  E.act(st, 'a', { type: 'roll' });
  E.act(st, 'b', { type: 'roll' });
  check('对战后甲恢复 1 点法力（2 -> 3）', A.mana === 3, String(A.mana));
  check('对战后乙没有凌玉灵，法力不动（2 -> 2）', B.mana === 2, String(B.mana));
  check('战报写明「对战结束后恢复 1 点法力值」', st.log.some((l) => /对战结束后恢复 1 点法力值/.test(l.text)), '');

  // 没带凌玉灵时不回法力
  const s2 = setup(6003, [], 4);
  const B2 = s2.st.players[1];
  B2.realm = 4; B2.mana = 2; B2.hp = 6; B2.hand = []; B2.equip = []; B2.spells = []; B2.companions = []; B2.qiCards = [];
  s2.A.mana = 2;
  E.act(s2.st, 'a', { type: 'combat', target: 'b' });
  E.act(s2.st, 'a', { type: 'roll' });
  E.act(s2.st, 'b', { type: 'roll' });
  check('无凌玉灵时对战后不回法力（2 -> 2）', s2.A.mana === 2 && B2.mana === 2, `${s2.A.mana}/${B2.mana}`);
}

// ---------------------------------------------------------------- 燕如嫣
console.log('\n[C] 燕如嫣：受到任意伤害时立即恢复 2 点法力');
{
  check('带 onHurt = mana(2)', opOf(YAN, 'hurt') === 'mana' && effOf(YAN, 'hurt').value === 2, JSON.stringify(effOf(YAN, 'hurt')));

  const { st, A } = setup(6004, ['燕如嫣'], 4);
  A.mana = 3; A.hp = 6;
  E.applyDamage(st, A, 2, 'test');
  check('掉 2 点血', A.hp === 4, String(A.hp));
  check('同时恢复 2 点法力（3 -> 5）', A.mana === 5, String(A.mana));
  check('战报写明受伤回法力', st.log.some((l) => /燕如嫣/.test(l.text) && /法力/.test(l.text)), '');

  // 法力已满时不应溢出
  A.mana = E.manaCap(A);
  const cap = E.manaCap(A);
  E.applyDamage(st, A, 1, 'test');
  check('法力已满时不溢出上限', A.mana === cap, `${cap} -> ${A.mana}`);

  // 没有燕如嫣则只掉血
  const s2 = setup(6005, [], 4);
  s2.A.mana = 3;
  E.applyDamage(s2.st, s2.A, 2, 'test');
  check('无燕如嫣时掉血不回法力', s2.A.mana === 3 && s2.A.hp === 4, `mana=${s2.A.mana} hp=${s2.A.hp}`);
}

// ---------------------------------------------------------------- 墨彩环
console.log('\n[D] 墨彩环：不发起对战可花 3 法力回 1 生命 / 占 2 个放置点');
{
  check('占 2 个放置点', MO.slots === 2, String(MO.slots));
  // 用户判据：**消耗法力才能发动 = 主动询问**（不消耗 = 自动）→ 改成回合结束时点的可选发动
  const moTurn = (MO.effects || []).find((e) => e.op === 'turn_no_combat_heal');
  check('带 event:turnEnd / op:turn_no_combat_heal(3法力,1生命)',
    !!moTurn && moTurn.event === 'turnEnd' && moTurn.manaCost === 3 && (moTurn.heal || moTurn.value) === 1,
    JSON.stringify(moTurn));

  // 未发起对战 → 回合结束时会**问一句**，由玩家决定发动
  const { st, A } = setup(6006, ['墨彩环'], 4);
  A.mana = 5; A.hp = 4;
  st.step = 'action';
  const r = E.act(st, 'a', { type: 'end_turn' });
  check('回合结束时挂起询问', !!st.pending && st.pending.event === 'turnEnd',
    JSON.stringify(st.pending && st.pending.event));
  check('候选里有【墨彩环】', E.pendingCards(st, A).some((c) => c.name === '墨彩环'),
    JSON.stringify(E.pendingCards(st, A)));
  check('此时还没扣法力（等玩家决定）', A.mana === 5, String(A.mana));
  const rp = E.act(st, 'a', { type: 'respond_play', uid: A.companions[0].uid });
  check('发动【墨彩环】', rp.ok, JSON.stringify(rp));
  check('消耗 3 点法力（5 -> 2）', A.mana === 2, String(A.mana));
  check('恢复 1 点生命（4 -> 5）', A.hp === 5, String(A.hp));
  check('回合继续正常结束', r.ok, JSON.stringify(r));

  // 发起过对战 → 不结算
  const s2 = setup(6007, ['墨彩环'], 4);
  const B2 = s2.st.players[1];
  B2.realm = 4; B2.mana = 12; B2.hp = 6; B2.hand = []; B2.equip = []; B2.spells = []; B2.companions = []; B2.qiCards = [];
  s2.A.mana = 5; s2.A.hp = 4;
  E.act(s2.st, 'a', { type: 'combat', target: 'b' });
  E.act(s2.st, 'a', { type: 'roll' });
  E.act(s2.st, 'b', { type: 'roll' });
  const manaAfterCombat = s2.A.mana, hpAfterCombat = s2.A.hp;
  E.act(s2.st, 'a', { type: 'end_turn' });
  check('本回合发起过对战时墨彩环不结算', s2.A.mana === manaAfterCombat && s2.A.hp === hpAfterCombat,
    `mana ${manaAfterCombat}->${s2.A.mana}, hp ${hpAfterCombat}->${s2.A.hp}`);

  // 法力不足 3 点 → 不结算（也不该扣成负数）
  const s3 = setup(6008, ['墨彩环'], 4);
  s3.A.mana = 2; s3.A.hp = 4;
  E.act(s3.st, 'a', { type: 'end_turn' });
  check('法力不足 3 点时既不回血也不扣法力', s3.A.mana === 2 && s3.A.hp === 4, `mana=${s3.A.mana} hp=${s3.A.hp}`);

  // 生命已满 → 不该白扣法力
  const s4 = setup(6009, ['墨彩环'], 4);
  s4.A.mana = 5; s4.A.hp = E.HP_MAX;
  E.act(s4.st, 'a', { type: 'end_turn' });
  check('生命已满时不白扣 3 点法力', s4.A.mana === 5 && s4.A.hp === E.HP_MAX, `mana=${s4.A.mana} hp=${s4.A.hp}`);
}

// ---------------------------------------------------------------- 放置点
console.log('\n[E] 墨彩环的 2 个放置点会挤掉第二个同行者');
{
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 6010 });
  E.beginGame(st);
   // 测试直接造局，不走真实回合流程 —— 这里标记"两边的第一个回合都已经过去"（新规则：第一个回合不能发起对战）
      for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0];
  A.realm = 4; A.mana = 12; A.hp = 6; A.equip = []; A.spells = []; A.companions = []; A.qiCards = [];
  check('结丹期以上同行者位 = 2', E.companionSlots(A) === 2, String(E.companionSlots(A)));
  const other = C.cards().companion.find((c) => c.name !== '墨彩环' && (c.slots || 1) === 1);
  // 乙的随机手牌同样先清空（同 setup 里的理由：别让对手的响应牌把甲的出牌挂起）
  st.players[1].hand = []; st.players[1].equip = []; st.players[1].spells = [];
  st.players[1].companions = []; st.players[1].qiCards = [];
  A.hand = [{ uid: 6101, id: MO.id }, { uid: 6102, id: other.id }];
  check('打出墨彩环成功', E.act(st, 'a', { type: 'play', uid: 6101 }).ok);
  check('放置点已用 2（满）', E.companionUsedSlots(A) === 2, String(E.companionUsedSlots(A)));
  const r = E.act(st, 'a', { type: 'play', uid: 6102 });
  check(`位满后无法再放【${other.name}】`, !r.ok, JSON.stringify(r));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
