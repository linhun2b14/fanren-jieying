'use strict';
// 第四批实物卡回归：【青蛟旗】【风灵劲】【青火雷】+ 补全【玄骨】的法力折扣。
const E = require('../server/engine');
const C = require('../server/cards');
const M = require('../server/effect-meta');
const { effOf, opOf } = require('./fixtures');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
let skipCount = 0;
/** 「条件不成立 → 这条没什么可验」的断言走 skip()：**只记录、不计入通过数**
 *  （以前写成 `check(名, true)`，永远通过，把"通过数"撑虚高了 —— 交接 §5.2 的老欠账）。 */
const skip = (n, why) => { skipCount++; console.log('  ⊘ ' + n + (why ? '  << ' + why : '')); };
const T = (n) => C.cards().treasure.find((c) => c.name === n);
const S = (n) => C.cards().spell.find((c) => c.name === n);
const CP = (n) => C.cards().companion.find((c) => c.name === n);

const QJ = T('青蛟旗'), QH = T('青火雷'), FL = S('风灵劲');

console.log('[0] 三张新卡按实物卡文入库');
check('【青蛟旗】宝物/法器/消耗 2 法力/凡人+',
  QJ && QJ.cost === 2 && QJ.realm === 0 && QJ.cat === '法器', QJ && `${QJ.cost}/${QJ.realm}/${QJ.cat}`);
check('【青蛟旗】效果 = 指定一位修士受 1 点伤害', opOf(QJ, 'play') === 'damage' && effOf(QJ, 'play').value === 1, JSON.stringify(effOf(QJ, 'play')));
check('【青火雷】宝物/法宝/消耗 2 法力/筑基期+',
  QH && QH.cost === 2 && QH.realm === 2 && QH.cat === '法宝', QH && `${QH.cost}/${QH.realm}/${QH.cat}`);
check('【青火雷】效果 = 胜+2 / 败自伤1',
  opOf(QH, 'combatStart') === 'risky_win_damage' && effOf(QH, 'combatStart').winDamage === 2 && effOf(QH, 'combatStart').loseDamage === 1, JSON.stringify(effOf(QH, 'combatStart')));
check('【风灵劲】法术/消耗 2 法力/炼气期+',
  FL && FL.cost === 2 && FL.realm === 1 && FL.cat === '法术', FL && `${FL.cost}/${FL.realm}/${FL.cat}`);
check('【风灵劲】效果 = 打发起对战者 1 点，且要求有对战',
  FL.effects[0].op === 'damage' && FL.effects[0].target === 'attacker' && M.effectRequiresCombat(FL.effects[0]),
  JSON.stringify(FL.effects[0]));
check('三张卡都进了正确的牌堆（青蛟旗/青火雷在宝物堆，风灵劲在法术堆）', !!QJ && !!QH && !!FL);

console.log('\n[T] 牌堆张数**按数据算**（用户 2026-10-02 深夜："卡组总数不固定，按改的算"）');
// 不再写死 80/33/78/60·251 —— 加新卡、改张数时这里要跟着红就没法用了。
// 现在验的是**能不能自洽**：每张卡 count 是 ≥0 整数、每堆张数 = 各卡 count 之和（并打印实得值）。
const tot = (k) => C.cards()[k].reduce((s, c) => s + (c.count || 0), 0);
const BAD_COUNT = [];
for (const d of ['treasure', 'spell', 'companion', 'qi']) {
  for (const c of C.cards()[d]) {
    if (typeof c.count !== 'number' || c.count < 0 || Math.floor(c.count) !== c.count) BAD_COUNT.push(c.name + '=' + c.count);
  }
}
check('每张卡的张数都是 ≥0 的整数', BAD_COUNT.length === 0, BAD_COUNT.slice(0, 5).join('、'));
const TOT = { treasure: tot('treasure'), spell: tot('spell'), companion: tot('companion'), qi: tot('qi') };
const GRAND = TOT.treasure + TOT.spell + TOT.companion + TOT.qi;
console.log('   当前牌堆张数（官方基线 80/33/78/60·251）:', JSON.stringify(TOT), '合计 ' + GRAND);
check('四堆都有牌（没有空牌堆）', ['treasure', 'spell', 'companion', 'qi'].every((d) => C.cards()[d].length > 0));
check('合计 = 四堆之和（实得多少就报多少）',
  GRAND === Object.keys(TOT).reduce((s, k) => s + TOT[k], 0) && GRAND > 0, String(GRAND));

function setup(seed) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
   // 测试直接造局，不走真实回合流程 —— 这里标记"两边的第一个回合都已经过去"（新规则：第一个回合不能发起对战）
      for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = 4; B.realm = 0; A.mana = 12; B.mana = 12; A.hp = 6; B.hp = 6;
  A.hand = []; B.hand = []; A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = []; A.qiCards = []; B.qiCards = [];
  return { st: st, A: A, B: B };
}
const logText = (st) => st.log.map((l) => l.text).join(' | ');
/** 把开着的时点询问窗口全部放弃掉（清场用） */
function flushPending(st) {
  for (let g = 0; g < 10 && st.pending; g++) {
    const w = E.pendingActor(st);
    if (!w) break;
    E.act(st, w.id, { type: 'respond_pass' });
  }
}

console.log('\n[A] 青蛟旗：指定一位修士受 1 点伤害');
{
  const { st, A, B } = setup(8101);
  A.hand = [{ uid: 8101, id: QJ.id }];
  const r = E.act(st, 'a', { type: 'play', uid: 8101, target: 'b' });
  check('打出成功（指定乙）', r.ok, JSON.stringify(r));
  check('乙掉 1 点血（6 -> 5）', B.hp === 5, String(B.hp));
  check('甲自己没掉血', A.hp === 6, String(A.hp));
  check('消耗了 2 点法力（12 -> 10）', A.mana === 10, String(A.mana));
  check('牌进弃牌堆（不在手牌）', A.hand.length === 0);

  // 没有指定目标时应被拒
  const s2 = setup(8102);
  s2.A.hand = [{ uid: 8111, id: QJ.id }];
  const r2 = E.act(s2.st, 'a', { type: 'play', uid: 8111 });
  check('不指定目标时打不出', !r2.ok, JSON.stringify(r2));
}

console.log('\n[B] 风灵劲：让发起对战的人受 1 点伤害（在「对战宣告」打断窗口里响应）');
{
  // 没有对战时不能裸打（它是纯响应牌）
  const { st, A } = setup(8103);
  A.hand = [{ uid: 8201, id: FL.id }];
  const r = E.act(st, 'a', { type: 'play', uid: 8201 });
  check('没有进行中的对战时被拒', !r.ok, JSON.stringify(r));
  // 文案（2026-10-02 改名：响应 → 破招）
  check('拒绝理由说明它只能在对应时点破招使用', /只能在「.*」时点破招使用/.test(r.error || ''), r.error);
  check('被拒后牌还在手里', A.hand.length === 1);

  // 有对战：甲宣告 → 开「对战宣告」窗口 → 应战方乙响应打出风灵劲 → 攻方掉 1 点血
  const s2 = setup(8104);
  s2.B.realm = 3; s2.B.mana = 12;      // 只比甲低 1 个境界（禁止越两级发起对战）
  s2.A.hand = []; s2.B.hand = [{ uid: 8211, id: FL.id }];
  check('甲发起对战', E.act(s2.st, 'a', { type: 'combat', target: 'b' }).ok);
  check('开出了「对战宣告」打断窗口', !!s2.st.pending && s2.st.pending.event === 'combatDeclare',
    JSON.stringify(s2.st.pending && s2.st.pending.event));
  check('窗口里能打出【风灵劲】的候选是乙', E.pendingCards(s2.st, s2.B).some((c) => c.name === '风灵劲'),
    JSON.stringify(E.pendingCards(s2.st, s2.B)));
  const ah = s2.A.hp;
  const r2 = E.act(s2.st, 'b', { type: 'respond_play', uid: 8211 });
  check('应战方响应打出风灵劲成功', r2.ok, JSON.stringify(r2));
  check('发起对战的甲受到 1 点伤害（6 -> 5）', s2.A.hp === ah - 1, `${ah} -> ${s2.A.hp}`);
  check('战报写明「让发起对战的…受到 1 点伤害」', /让发起对战的.*受到 1 点伤害/.test(logText(s2.st)), '');
  check('打风灵劲的乙自己没掉血', s2.B.hp === 6, String(s2.B.hp));
  check('锁链结算完，窗口关闭、对战继续', !s2.st.pending && !!s2.st.combat, JSON.stringify(s2.st.pending));
}

console.log('\n[C] 青火雷：获胜则对方额外受 2 点，失败则自己额外受 1 点');
{
  check('青火雷被认作「对战类」卡（能在对战出牌阶段打出）', E.timingOf(QH) === 'combat', E.timingOf(QH));

  // ---- 胜：甲元婴 vs 乙结丹（只差 1 级，可发起），再人为给甲 +3 保证必赢 ----
  const { st, A, B } = setup(8105);
  B.realm = 3;
  A.hand = [{ uid: 8301, id: QH.id }];
  const rStart = E.act(st, 'a', { type: 'combat', target: 'b' });
  check('甲发起对战', rStart.ok, JSON.stringify(rStart));
  st.combat.bonus['a'] = 3;            // 保证甲赢
  // 对战中的出牌现在走时点询问（锁链）：青火雷是「对战出牌阶段」的牌 → 在"投骰·前"窗口里响应打出
  flushPending(st);
  E.act(st, 'a', { type: 'roll' });    // 这步会先开"投骰·前"窗口
  if (st.pending && st.pending.event === 'roll' && st.pending.phase === 'before') {
    skip('投骰前窗口挂着（等甲决定出不出青火雷）');
    check('候选里有【青火雷】', E.pendingCards(st, A).some((c) => c.name === '青火雷'),
      JSON.stringify(E.pendingCards(st, A)));
    check('甲在对战出牌阶段打出青火雷', E.act(st, 'a', { type: 'respond_play', uid: 8301 }).ok);
  } else {
    check('投骰前窗口挂着（等甲决定出不出青火雷）', false, JSON.stringify(st.pending && st.pending.event));
    check('候选里有【青火雷】', false, '');
    check('甲在对战出牌阶段打出青火雷', false, '');
  }
  flushPending(st);
  E.act(st, 'b', { type: 'roll' });
  flushPending(st);
  check('甲获胜', /甲 战胜 乙/.test(logText(st)), '');
  check('乙被打掉 1（战败）+ 2（青火雷）= 3 点（6 -> 3）', B.hp === 3, String(B.hp));
  check('甲自己没掉血', A.hp === 6, String(A.hp));
  check('战报出现「额外受到伤害」', /额外受到伤害/.test(logText(st)), '');

  // ---- 败：甲筑基 vs 乙元婴（差 2 级？不行）→ 甲结丹 vs 乙元婴，并人为给乙 +3 保证甲必败 ----
  const s2 = setup(8106);
  s2.A.realm = 3; s2.B.realm = 4;
  s2.A.hand = [{ uid: 8311, id: QH.id }];
  const rStart2 = E.act(s2.st, 'a', { type: 'combat', target: 'b' });
  check('甲发起对战', rStart2.ok, JSON.stringify(rStart2));
  // 保证乙赢：直接给对战的卡牌修正容器加成
  s2.st.combat.bonus['b'] = 3;
  flushPending(s2.st);
  E.act(s2.st, 'a', { type: 'roll' });      // 先开"投骰·前"窗口
  if (s2.st.pending && s2.st.pending.event === 'roll' && s2.st.pending.phase === 'before') {
    check('甲打出青火雷', E.act(s2.st, 'a', { type: 'respond_play', uid: 8311 }).ok);
  } else {
    check('甲打出青火雷', false, JSON.stringify(s2.st.pending && s2.st.pending.event));
  }
  flushPending(s2.st);
  E.act(s2.st, 'b', { type: 'roll' });
  flushPending(s2.st);
  check('乙获胜', /乙 战胜 甲/.test(logText(s2.st)), '');
  check('甲被打掉 1（战败）+ 1（青火雷反噬）= 2 点（6 -> 4）', s2.A.hp === 4, String(s2.A.hp));
  check('战报写明「反噬」', /反噬/.test(logText(s2.st)), '');
  check('乙没有额外掉血', s2.B.hp === 6, String(s2.B.hp));

  // ---- 平局时青火雷的胜/败分支都不该触发 ----
  const s3 = setup(8107);
  s3.A.realm = 2; s3.B.realm = 2;
  s3.A.hand = [{ uid: 8321, id: QH.id }];
  // ⚠️ 钉住骰点（`forcedDice` 按 FIFO 取用）：卡池一变大，种子决定的骰点就整体漂移，
  //    "同境界同基础同骰点 → 必平"这种断言必须靠注入，否则每次都假红（2026-10-05 踩到）。
  s3.st.forcedDice = [3, 3];
  E.act(s3.st, 'a', { type: 'combat', target: 'b' });
  s3.st.combat.dice['a'] = 3; s3.st.combat.dice['b'] = 3;   // 同境界同基础同骰点 → 必平
  flushPending(s3.st);
  E.act(s3.st, 'a', { type: 'roll' });
  if (s3.st.pending && s3.st.pending.event === 'roll' && s3.st.pending.phase === 'before') {
    E.act(s3.st, 'a', { type: 'respond_play', uid: 8321 });
  }
  flushPending(s3.st);
  E.act(s3.st, 'b', { type: 'roll' });
  flushPending(s3.st);
  // 双方都没「改变战力结果」的牌 → 平局窗口不开窗，直接以平局收场
  check('平局（双方各 2 点）→ 直接以平局收场', !s3.st.combat && /双方仍持平/.test(logText(s3.st)),
    JSON.stringify(s3.st.combat && s3.st.combat.stage));
  check('平局时双方都没掉血', s3.A.hp === 6 && s3.B.hp === 6, `${s3.A.hp}/${s3.B.hp}`);
  flushPending(s3.st);
}

console.log('\n[D] 玄骨：使用宝物牌/法术牌时法力消耗 -1（最低为 1）');
{
  const XG = CP('玄骨');
  check('【玄骨】cardCostDiscount = 1', XG && XG.cardCostDiscount === 1, XG && String(XG.cardCostDiscount));
  check('【玄骨】不再带未实装 note', XG && !XG.note, XG && XG.note);
  check('【玄骨】仍占 2 个放置位', XG && XG.slots === 2, XG && String(XG.slots));
  check('【玄骨】晋升折扣仍在', opOf(XG, 'promote') === 'promote_discount');

  const mk = (seed, withXG) => {
    const s = setup(seed);
    if (withXG) s.A.companions = [{ uid: 8400, id: XG.id }];
    return s;
  };

  // 2 费 → 1 费
  const s1 = mk(8108, true);
  check('cardCostDiscount(甲) = 1', E.cardCostDiscount(s1.A) === 1, String(E.cardCostDiscount(s1.A)));
  s1.A.mana = 12; s1.A.hand = [{ uid: 8401, id: QJ.id }];
  E.act(s1.st, 'a', { type: 'play', uid: 8401, target: 'b' });
  check('打出 2 费【青蛟旗】只花 1 点法力（12 -> 11）', s1.A.mana === 11, String(s1.A.mana));

  // 对照：没有玄骨时照常 2 费
  const s1b = mk(8109, false);
  s1b.A.mana = 12; s1b.A.hand = [{ uid: 8411, id: QJ.id }];
  E.act(s1b.st, 'a', { type: 'play', uid: 8411, target: 'b' });
  check('没有玄骨时照常花 2 点（12 -> 10）', s1b.A.mana === 10, String(s1b.A.mana));

  // 1 费 → 仍是最低 1 费
  const s2 = mk(8110, true);
  const DMY = T('大挪移令');
  s2.A.mana = 12; s2.A.hand = [{ uid: 8421, id: DMY.id }];
  E.act(s2.st, 'a', { type: 'play', uid: 8421 });
  check('打出 1 费【大挪移令】仍花 1 点（最低为 1，不会免费）', s2.A.mana === 11, String(s2.A.mana));

  // 0 费牌不受影响
  const s3 = mk(8111, true);
  const SLZ = T('娑罗珠');
  s3.A.mana = 12; s3.A.hand = [{ uid: 8431, id: SLZ.id }];
  E.act(s3.st, 'a', { type: 'play', uid: 8431 });
  check('打出 0 费【娑罗珠】法力不变（12 -> 12）', s3.A.mana === 12, String(s3.A.mana));

  // 高境界装备的「装备时消耗」也打折
  const s4 = mk(8112, true);
  const XTD = T('虚天鼎 乾蓝冰焰');
  const base = XTD.equipCost != null ? XTD.equipCost : XTD.cost;
  s4.A.mana = 12; s4.A.spells = []; s4.A.equip = [];
  s4.A.hand = [{ uid: 8441, id: XTD.id }];
  const r4 = E.act(s4.st, 'a', { type: 'play', uid: 8441 });
  check(`打出【虚天鼎 乾蓝冰焰】（装备费 ${base}）成功`, r4.ok, JSON.stringify(r4));
  check(`装备费 -1（12 -> ${12 - (base - 1)}）`, s4.A.mana === 12 - (base - 1), `${base} 费，实付 ${12 - s4.A.mana}`);
}

console.log('\n[E] 未实装清单持续缩短');
{
  const notes = C.cards().companion.filter((c) => c.note).map((c) => c.name);
  check('【玄骨】已从清单移除', !notes.includes('玄骨'), notes.join('、'));
  // 后续批次又实装了 银月/钟卫娘/温天仁，这里只断言"这几张已经不在清单里"，不写死总数，
  // 免得每实装一张就要改一次测试。
  for (const done of ['玄骨', '银月', '钟卫娘', '温天仁']) {
    check(`【${done}】已从清单移除`, !notes.includes(done), notes.join('、'));
  }
  console.log('     仍待实装: ' + (notes.join('、') || '（无）'));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
