'use strict';
// 「每回合每种灵气牌各触发一次额外抽取」：
//   A. 回合阶段抽到天地灵气 → 触发
//   B. **用卡牌效果（施地符）抽到天地灵气 → 也必须触发** ← 用户报过的 bug 回归
//   C. 同回合第二次**同一种**灵气牌 → 被拦
//   D. 新回合重置
//   E. **同回合里充裕灵气(抽1)与天地灵气(抽2)必须各自触发** ← 用户报的 bug 回归
//      （旧实现两者共用一个布尔闸门，同回合只触发其中一个）
const E = require('../server/engine');
const C = require('../server/cards');
const { effOf } = require('./fixtures');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

const TIANDI = C.cards().qi.find((c) => c.name === '天地灵气');
const CHONGYU = C.cards().qi.find((c) => c.name === '充裕灵气');
const PLAIN = C.cards().qi.find((c) => c.name === '稀薄灵气');
// 真实卡池里没有「使用后直接获得灵气牌」的消耗卡，注入一张合成卡来覆盖「卡牌效果抽到天地灵气」这个场景
let SHIDI = C.cards().treasure.find((c) => effOf(c, 'play') && effOf(c, 'play').op === 'qi');
if (!SHIDI) {
  SHIDI = { id: 'test_shidi', name: '测试·施地符', type: 'consume', cost: 1, realm: 0, count: 1,
    text: '测试用：获得1点灵气值。', effect: { kind: 'qi', value: 1 } };
  C.cards().treasure.push(SHIDI);
}
if (!TIANDI || !CHONGYU || !PLAIN || !SHIDI) throw new Error('卡池缺少测试所需卡牌');
console.log(`天地灵气=${TIANDI.name} 充裕灵气=${CHONGYU.name} 稀薄灵气=${PLAIN.name} 施地符=${SHIDI.name}`);

/** 闸门现在是「按灵气牌 id 计次」的 map */
const fired = (st, card) => !!(st.extraQiUsed && st.extraQiUsed[card.id]);
const anyFired = (st) => !!(st.extraQiUsed && Object.keys(st.extraQiUsed).length);

function newGame(seed) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  return st;
}
/** 把当前玩家推进到「行动阶段」，期间用无效果的灵气牌顶掉回合抽取，保证 extraQiUsed 干净 */
function toActionPhase(st) {
  const pl = st.players[st.turn];
  st.decks.qi.draw.push(PLAIN.id);
  E.act(st, pl.id, { type: 'draw_qi' });
  E.act(st, pl.id, { type: 'draw_treasure' });
  E.act(st, pl.id, { type: 'choose_draw', deck: 'spell' });
  return pl;
}

// ---------------- A：回合阶段抽取触发 ----------------
console.log('\n[A] 回合阶段抽到天地灵气应触发额外抽取');
{
  const st = newGame(1001);
  const pl = st.players[st.turn];
  st.step = 'draw_qi';
  st.extraQiUsed = {};
  st.decks.qi.draw.push(TIANDI.id);
  const from = st.log.length;
  const r = E.act(st, pl.id, { type: 'draw_qi' });
  const logs = st.log.slice(from).map((l) => l.text);
  const did = logs.some((l) => l.includes('生效：额外抽取'));
  check('触发了额外抽取', r.ok && did, logs.join(' | ').slice(0, 120));
  check('天地灵气已计入本回合闸门', fired(st, TIANDI));
  check('阶段推进到探索', st.step === 'draw_treasure', st.step);
}

// ---------------- B：卡牌效果抽到天地灵气也必须触发（bug 回归） ----------------
console.log('\n[B] 用【施地符】抽到天地灵气也必须触发（用户报的 bug）');
{
  const st = newGame(1002);
  const pl = toActionPhase(st);
  check('进入行动阶段且本回合闸门是空的', st.step === 'action' && !anyFired(st),
    `step=${st.step} extraQiUsed=${JSON.stringify(st.extraQiUsed)}`);
  pl.mana = 12;
  pl.hand.push({ uid: 9001, id: SHIDI.id });
  st.decks.qi.draw.push(TIANDI.id);            // 施地符的效果会抽到这张
  const from = st.log.length;
  const r = E.act(st, pl.id, { type: 'play', uid: 9001 });
  const logs = st.log.slice(from).map((l) => l.text);
  console.log('  战报:');
  logs.forEach((l) => console.log('     · ' + l));
  check('施地符打出成功', r.ok, r.error);
  const did = logs.some((l) => l.includes('生效：额外抽取'));
  check('卡牌效果抽到的天地灵气也触发了额外抽取', did);
  check('灵气值增加 >= 2（天地灵气 + 额外 2 张）', E.qiOf(pl) >= 2, 'qi=' + E.qiOf(pl));
  check('天地灵气已计入本回合闸门', fired(st, TIANDI));
}

// ---------------- C：同回合第二次被拦 ----------------
console.log('\n[C] 同回合第二次天地灵气应被拦下');
{
  const st = newGame(1003);
  const pl = toActionPhase(st);
  pl.mana = 12;
  pl.hand.push({ uid: 9101, id: SHIDI.id }, { uid: 9102, id: SHIDI.id });
  st.decks.qi.draw.push(TIANDI.id);
  E.act(st, pl.id, { type: 'play', uid: 9101 });      // 第一次 → 触发
  st.decks.qi.draw.push(TIANDI.id);
  const from = st.log.length;
  E.act(st, pl.id, { type: 'play', uid: 9102 });      // 第二次 → 应被拦
  const logs = st.log.slice(from).map((l) => l.text);
  const blocked = logs.some((l) => l.includes('不再触发'));
  check('第二次被"每回合一次"拦下', blocked, logs.join(' | ').slice(0, 120));
}

// ---------------- D：新回合重置 ----------------
console.log('\n[D] 新回合应重置额外抽取闸门');
{
  const st = newGame(1004);
  const pl = toActionPhase(st);
  pl.mana = 12;
  pl.hand.push({ uid: 9201, id: SHIDI.id });
  st.decks.qi.draw.push(TIANDI.id);
  E.act(st, pl.id, { type: 'play', uid: 9201 });
  check('本回合天地灵气已计次', fired(st, TIANDI));
  E.act(st, pl.id, { type: 'end_turn' });
  const nx = st.players[st.turn];
  st.decks.qi.draw.push(PLAIN.id);
  E.act(st, nx.id, { type: 'draw_qi' });
  check('新回合开始后已重置', !anyFired(st), JSON.stringify(st.extraQiUsed));
}

// ---------------- E：充裕灵气 与 天地灵气 必须各自触发（用户报的 bug） ----------------
console.log('\n[E] 同回合内【充裕灵气】(抽1) 与【天地灵气】(抽2) 必须各自触发');
{
  const st = newGame(1005);
  const pl = toActionPhase(st);
  pl.mana = 12;
  pl.hand.push({ uid: 9301, id: SHIDI.id }, { uid: 9302, id: SHIDI.id });
  // 精确排牌堆：drawFrom 用 pop()（取末尾），所以要按"抽到的顺序"倒着放。
  // 计划抽出顺序：天地灵气 → 稀薄 → 稀薄（天地灵气的额外 2 张）→ 充裕灵气 → 稀薄（充裕灵气的额外 1 张）
  st.decks.qi.draw = [PLAIN.id, CHONGYU.id, PLAIN.id, PLAIN.id, TIANDI.id];

  const from1 = st.log.length;
  E.act(st, pl.id, { type: 'play', uid: 9301 });
  const logs1 = st.log.slice(from1).map((l) => l.text).join(' | ');
  check('【天地灵气】触发额外抽 2 张', /【天地灵气】生效：额外抽取 2 张灵气牌/.test(logs1), logs1.slice(0, 160));
  check('天地灵气这一轮没有顺手抽到充裕灵气（牌堆已精确排好）', !fired(st, CHONGYU), JSON.stringify(st.extraQiUsed));

  const from2 = st.log.length;
  E.act(st, pl.id, { type: 'play', uid: 9302 });
  const logs2 = st.log.slice(from2).map((l) => l.text).join(' | ');
  check('【充裕灵气】也触发了额外抽 1 张（不再被天地灵气占掉闸门）',
    /【充裕灵气】生效：额外抽取 1 张灵气牌/.test(logs2), logs2.slice(0, 160));
  check('两张牌各自计次', fired(st, TIANDI) && fired(st, CHONGYU), JSON.stringify(st.extraQiUsed));

  // 同一种再抽一次 → 该种被拦
  st.decks.qi.draw.push(TIANDI.id);
  const from3 = st.log.length;
  pl.hand.push({ uid: 9303, id: SHIDI.id });
  E.act(st, pl.id, { type: 'play', uid: 9303 });
  const logs3 = st.log.slice(from3).map((l) => l.text).join(' | ');
  check('同一种【天地灵气】再次出现被拦下', /【天地灵气】的额外抽取本回合不再触发/.test(logs3), logs3.slice(0, 160));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
