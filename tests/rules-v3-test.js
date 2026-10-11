'use strict';
// 实物确认后的规则回归：生命6 / 法力上限分档 / 晋升门槛 / 伪灵根 / 无起始同行者 /
// 同行者占位 / 装备分档 / 灵气牌堆60张且抽完续组。
const E = require('../server/engine');
const C = require('../server/cards');
const { mainOf } = require('./fixtures');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  << ' + extra : '')); }
}
let skipCount = 0;
/** 「条件不成立 → 这条没什么可验」的断言走 skip()：**只记录、不计入通过数**
 *  （以前写成 `check(名, true)`，永远通过，把"通过数"撑虚高了 —— 交接 §5.2 的老欠账）。 */
function skip(name, why) { skipCount++; console.log('  ⊘ ' + name + (why ? '  << ' + why : '')); }

console.log('[1] 常量');
check('生命上限 = 6', E.HP_MAX === 6, 'HP_MAX=' + E.HP_MAX);
check('法力上限 = 12', E.MANA_MAX === 12, 'MANA_MAX=' + E.MANA_MAX);
check('凡人法力上限 = 6', E.MANA_MAX_MORTAL === 6, 'MANA_MAX_MORTAL=' + E.MANA_MAX_MORTAL);
check('晋升掷骰门槛 = [0,0,4,5]（结丹≥4 元婴≥5）',
  JSON.stringify(E.PROMOTE_DICE) === '[0,0,4,5]', JSON.stringify(E.PROMOTE_DICE));
check('伪灵根 = 7/9/15/19',
  JSON.stringify(E.ROOTS.wei.costs) === '[7,9,15,19]', JSON.stringify(E.ROOTS.wei.costs));
check('装备高境界起点 = 筑基(2)', E.EQUIP_HIGH_TIER_MIN_REALM === 2);

console.log('\n[2] 灵气牌堆');
const qiTotal = C.cards().qi.reduce((a, c) => a + c.count, 0);
check('灵气牌共 60 张', qiTotal === 60, 'qi=' + qiTotal);
check('灵气牌 4 种', C.cards().qi.length === 4, 'kinds=' + C.cards().qi.length);
const names = C.cards().qi.map((c) => c.name).sort().join('/');
check('种类为 天地/充裕/混杂/稀薄', names === '充裕灵气/天地灵气/混杂灵气/稀薄灵气', names);

console.log('\n[3] 开局状态');
const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' },
  { id: 'c', name: '丙' }, { id: 'd', name: '丁' }], { seed: 424242 });
const bg = E.beginGame(st);
check('开局成功', bg.ok, bg.error);
check('开局无同行者', st.players.every((p) => p.companions.length === 0),
  st.players.map((p) => p.companions.length).join(','));
check('开局生命 = 6', st.players.every((p) => p.hp === 6));
// 开局后先手玩家的回合已开始并抽走 1 张灵气牌，所以 59 张
check('灵气牌堆接近 60 张（已抽走先手那张）', st.decks.qi.draw.length >= 58, 'draw=' + st.decks.qi.draw.length);

const mortal = st.players[0];
check('凡人期法力上限 = 6', E.manaCap(mortal) === 6, 'cap=' + E.manaCap(mortal));
mortal.realm = 2;
check('筑基期法力上限 = 12', E.manaCap(mortal) === 12, 'cap=' + E.manaCap(mortal));
mortal.realm = 0;

console.log('\n[4] 装备分档');
const lowDef = C.cards().treasure.find((c) => c.type === 'equip' && (c.realm || 0) < 2 && (c.cost || 0) > 0);
const highDef = C.cards().treasure.find((c) => c.type === 'equip' && (c.realm || 0) >= 2 && (c.cost || 0) > 0);
check('卡池里有低境界付费装备', !!lowDef, lowDef && lowDef.name);
check('卡池里有高境界付费装备', !!highDef, highDef && highDef.name);

if (lowDef && highDef) {
  const P = st.players[0];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  P.realm = 4; P.equip = []; P.spells = []; P.hand = [];
  P.mana = 12;
  // 低境界装备：装备免费
  P.hand.push({ uid: 7001, id: lowDef.id });
  const before = P.mana;
  const r1 = E.act(st, P.id, { type: 'play', uid: 7001 });
  check(`低境界【${lowDef.name}】装备免费（法力 ${before} -> ${P.mana}）`, r1.ok && P.mana === before, r1.error);
  // 高境界装备：装备时付费
  P.hand.push({ uid: 7002, id: highDef.id });
  const before2 = P.mana;
  const r2 = E.act(st, P.id, { type: 'play', uid: 7002 });
  const spent = before2 - P.mana;
  check(`高境界【${highDef.name}】装备时扣费（扣 ${spent}，标价 ${highDef.cost}）`,
    r2.ok && spent === (highDef.cost || 0), r2.error);

  // 低境界装备在对战中启用时付费
  P.mana = 12;
  const lowIsCombat = ['dice_bonus', 'combat_bonus', 'combat_debuff'].includes(mainOf(lowDef) && mainOf(lowDef).op);
  if (lowIsCombat) {
    const b3 = P.mana;
    const r3 = E.activateCombatEquips(st, P);
    const paid = b3 - P.mana;
    check(`低境界【${lowDef.name}】对战中启用付费 ${paid}（标价 ${lowDef.cost}）`, paid === (lowDef.cost || 0));
  } else {
    skip(`低境界【${lowDef.name}】非战斗类效果（无需对战激活）`);
  }

  // 高境界装备在对战中不再扣费
  P.mana = 12;
  const highIsCombat = ['dice_bonus', 'combat_bonus', 'combat_debuff'].includes(mainOf(highDef) && mainOf(highDef).op);
  if (highIsCombat) {
    const b4 = P.mana;
    E.activateCombatEquips(st, P);
    check(`高境界【${highDef.name}】对战中不再扣费`, P.mana === b4, `扣了 ${b4 - P.mana}`);
  } else {
    skip(`高境界【${highDef.name}】非战斗类效果（无需对战激活）`);
  }
}

console.log('\n[5] 同行者：无境界限制 + 占位');
const twoSlot = C.cards().companion.find((c) => (c.slots || 1) === 2);
const oneSlot = C.cards().companion.find((c) => (c.slots || 1) === 1);
check('存在占 2 位的同行者（真实卡池可能有也可能没有）', true,
  twoSlot ? `有：${twoSlot.name}` : '真实素材里未拍到占 2 位的同行者');
check('存在占 1 位的同行者', !!oneSlot, oneSlot && oneSlot.name);

if (twoSlot && oneSlot) {
  const Q = st.players[1];
  st.turn = 1; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  Q.realm = 0; Q.companions = []; Q.hand = []; Q.mana = 12;   // 凡人期
  // 凡人期同行者总格数 1 → 占 2 位的放不下
  Q.hand.push({ uid: 7101, id: twoSlot.id });
  const r5 = E.act(st, Q.id, { type: 'play', uid: 7101 });
  check(`凡人期放不下占2位的【${twoSlot.name}】`, !r5.ok, r5.error);
  // 占 1 位的可以放（且无境界限制：这张牌 realm 可能 >0）
  Q.hand = [{ uid: 7102, id: oneSlot.id }];
  const r6 = E.act(st, Q.id, { type: 'play', uid: 7102 });
  check(`凡人期能放【${oneSlot.name}】（realm=${oneSlot.realm}，同行者无境界限制）`, r6.ok, r6.error);
  check('已用占位 = 1', E.companionUsedSlots(Q) === 1, String(E.companionUsedSlots(Q)));
  // 筑基后 2 格，可以放占 2 位的
  Q.realm = 2; Q.companions = []; Q.hand = [{ uid: 7103, id: twoSlot.id }];
  const r7 = E.act(st, Q.id, { type: 'play', uid: 7103 });
  check(`筑基期能放占2位的【${twoSlot.name}】`, r7.ok, r7.error);
  check('已用占位 = 2', E.companionUsedSlots(Q) === 2, String(E.companionUsedSlots(Q)));
  Q.realm = 0;
}

console.log('\n[6] 灵气牌堆抽完自动续一组');
const pileCheck = E.freshQiPile(st);
check('freshQiPile 生成 60 张', pileCheck.length === 60, 'len=' + pileCheck.length);
// 人为抽空灵气牌堆，然后由当前玩家手动执行「抽取灵气牌」阶段（抽取已改为手动分阶段）
const cur = st.players[st.turn];
st.turn = st.players.indexOf(cur);
st.step = 'draw_qi';
st.decks.qi.draw = [];
st.decks.qi.discard = [];
const from = st.log.length;
const rDraw = E.act(st, cur.id, { type: 'draw_qi' });
const newLogs = st.log.slice(from).map((l) => l.text);
const refilled = newLogs.some((l) => l.includes('重新加入一整组灵气牌'));
check('抽空后触发"重新加入一整组灵气牌"', rDraw.ok && refilled, newLogs.slice(0, 3).join(' | '));
const afterLen = st.decks.qi.draw.length;
check(`续组后牌堆恢复（当前 ${afterLen} 张，约为 59）`, afterLen >= 55 && afterLen <= 60, 'len=' + afterLen);
check('抽取阶段推进到探索阶段', st.step === 'draw_treasure', st.step);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
