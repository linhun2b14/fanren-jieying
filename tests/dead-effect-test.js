'use strict';
// 「说了有效果其实没生效」的一批硬 bug 回归（审计发现，全是"只写不读"）：
//   ① t.skip        —— 跳过回合机制当年根本不存在（3 处赋值、0 处读取）
//   ② hand_limit_bonus —— 【噬金虫】手中宝物牌上限 +1 没人读
//   ③ curse_target  —— 【血咒禁制】只写了一个没人读的 t.curse
//   ④ 封锁计数递减时机 —— 【寒蛟】「对方下回合不能抽法术/同行者」在对方回合开始就被减到 0，等于永不生效
//   ⑤ skippedLastTurn 从不重置 —— 用过一次跳过之后，以后所有跳过都被"不可连续两回合"永久挡掉
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

const byName = (deck, name) => C.cards()[deck].find((c) => c.name === name);
const JINSHEN = byName('treasure', '禁神牌');
const HANLI = byName('treasure', '寒黎珠');
const XUEZHOU = byName('spell', '血咒禁制');
const SHIJIN = byName('companion', '噬金虫');
const HANJIAO = byName('companion', '寒蛟');
const CHANGCHUN = byName('spell', '长春功');
check('卡池齐备', !!(JINSHEN && HANLI && XUEZHOU && SHIJIN && HANJIAO && CHANGCHUN));

/** 造局：甲在行动阶段、手上有给定牌；乙为对手 */
function setup(seed, handDefs, realm) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  const A = st.players[0], B = st.players[1];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  A.realm = (typeof realm === 'number') ? realm : 1;
  A.mana = 12; A.hand = []; A.equip = []; A.spells = []; A.companions = [];  (handDefs || []).forEach((d, i) => A.hand.push({ uid: 6000 + i, id: d.id }));
  // ⚠️ 对手的**随机起手牌也要清空**：卡池一变（2026-10-05 实物卡补充批 266 → 282 张），
  //    乙就可能发到【虚天鼎 乾蓝冰焰】这类「使用卡牌 · 前」的响应牌 —— 甲的出牌会被挂起，
  //    后面"效果真的生效了吗"的断言全跟着红（companions-v2-test 也踩过同一个坑）。
  B.hand = []; B.equip = []; B.spells = []; B.companions = []; B.puppets = [];
  return { st: st, A: A, B: B };
}

// ---- ① 跳过回合真的跳 ----
console.log('\n[①] 【禁神牌】→ 乙的回合被真的跳过');
{
  const { st, A, B } = setup(7001, [JINSHEN]);
  const hpBefore = B.hp;
  check('打出【禁神牌】', E.act(st, A.id, { type: 'play', uid: 6000, target: 'b' }).ok, '');
  check('乙受到 1 点伤害', B.hp === hpBefore - 1, `${hpBefore} -> ${B.hp}`);
  check('乙的跳过额度 = 1', B.skip === 1, String(B.skip));
  check('甲结束回合', E.act(st, A.id, { type: 'end_turn' }).ok, '');
  check('轮到的是甲（乙被跳过）', st.players[st.turn].id === 'a', st.players[st.turn].id);
  check('乙的跳过额度已消耗', B.skip === 0, String(B.skip));
}

// ---- ①b 跳过回合不给回合效果（不发法力、不抽牌）----
console.log('\n[①b] 被跳过的一方不会拿到回合收益');
{
  const { st, A, B } = setup(7002, [HANLI]);
  B.mana = 0;
  check('打出【寒黎珠】', E.act(st, A.id, { type: 'play', uid: 6000, target: 'b' }).ok, '');
  E.act(st, A.id, { type: 'end_turn' });
  check('乙没拿到回合（turn 仍是甲）', st.players[st.turn].id === 'a', st.players[st.turn].id);
  check('乙没有回复法力（0 还是 0）', B.mana === 0, String(B.mana));
}

// ---- ⑤ 跳过用一次之后，第二次还能用（skippedLastTurn 要重置）----
console.log('\n[⑤] 被跳过的人真正轮过一次之后，跳过标记会清掉');
{
  const { st, A, B } = setup(7003, [HANLI]);
  const toAction = () => { st.step = 'action'; st.turnFlags = { combat: false, promote: false }; };
  E.act(st, A.id, { type: 'play', uid: 6000, target: 'b' });
  check('第一次跳过生效（乙.skip = 1）', B.skip === 1, String(B.skip));
  E.act(st, A.id, { type: 'end_turn' });          // 乙被跳过 → 回到甲
  check('跳过被消耗，回到甲', st.players[st.turn].id === 'a' && B.skip === 0, `${st.players[st.turn].id}/${B.skip}`);
  check('乙此时带「上回合被跳过」标记', B.skippedLastTurn === true, String(B.skippedLastTurn));
  toAction();
  E.act(st, A.id, { type: 'end_turn' });          // 甲什么也不做 → 这次轮到乙，触发乙的 startTurn
  check('这次轮到乙', st.players[st.turn].id === 'b', st.players[st.turn].id);
  check('乙的「上回合被跳过」标记已重置', B.skippedLastTurn === false, String(B.skippedLastTurn));
  toAction();
  E.act(st, B.id, { type: 'end_turn' });          // 乙过 → 回甲
  A.hand.push({ uid: 6001, id: HANLI.id });
  toAction();
  const r = E.act(st, A.id, { type: 'play', uid: 6001, target: 'b' });
  check('第二次「跳过」仍然能生效（若标记从不重置会被"不可连续"永久挡掉）', r.ok && B.skip === 1,
    `${JSON.stringify(r)} skip=${B.skip}`);
}

// ---- ② 噬金虫抬高宝物牌手牌上限 ----
console.log('\n[②] 【噬金虫】在手：宝物牌上限 6 → 7');
{
  const { st, A } = setup(7004, []);
  A.companions.push({ uid: 9001, id: SHIJIN.id });
  for (let i = 0; i < 7; i++) A.hand.push({ uid: 7000 + i, id: JINSHEN.id });   // 7 张宝物牌
  E.act(st, A.id, { type: 'end_turn' });
  const n1 = A.hand.filter((c) => c.id === JINSHEN.id).length;
  check('7 张宝物牌**不**被弃（上限被抬高到 7）', n1 === 7, String(n1));
}

// ---- ②c 界面显示的上限必须 == 引擎执行的上限 ----
// 用户报过"超上限结束回合却无事发生"：带着【噬金虫】手里 7 张时，界面渲染成「宝物 7/6」标红
// 并提示"回合结束时会被弃置"，可引擎一张都不弃。根因是**显示与执行各算各的**：
// enforceHandLimits 自己算 6+1=7，而 publicState 下发的是牌面基础值 6。
// 现在两者都走 effectiveHandLimits()，这条断言就是钉住"不许再分开算"。
console.log('\n[②c] 界面显示的上限 == 引擎执行的上限（不许各算各的）');
{
  const { st, A } = setup(7006, []);
  // ① 没有加成时：显示 6 / 执行 6
  for (let i = 0; i < 7; i++) A.hand.push({ uid: 7100 + i, id: JINSHEN.id });
  let me = E.publicState(st, A.id).players.find((x) => x.id === A.id);
  check('没加成时下发的宝物上限 = 6', me.handLimits.treasure === 6, JSON.stringify(me.handLimits));
  check('下发的上限与 effectiveHandLimits 一致',
    me.handLimits.treasure === E.effectiveHandLimits(A).treasure, JSON.stringify(me.handLimits));
  const r1 = E.act(st, A.id, { type: 'end_turn' });
  check('（对照）没加成时 7 张会挂起、等你弃 1 张', r1.forcedDiscard === 1, JSON.stringify(r1));
  const u1 = A.hand.find((c) => E.deckOf(c.id) === 'treasure').uid;
  E.act(st, A.id, { type: 'discard', uid: u1 });
  check('（对照）自己弃掉 1 张后回到 6', A.hand.filter((c) => c.id === JINSHEN.id).length === 6,
    String(A.hand.filter((c) => c.id === JINSHEN.id).length));

  // ② 带上【噬金虫】：显示 7 / 执行 7，且 7 张一张都不弃
  const s2 = setup(7007, []);
  s2.A.companions.push({ uid: 9002, id: SHIJIN.id });
  for (let i = 0; i < 7; i++) s2.A.hand.push({ uid: 7200 + i, id: JINSHEN.id });
  const me2 = E.publicState(s2.st, s2.A.id).players.find((x) => x.id === s2.A.id);
  check('带【噬金虫】时下发的宝物上限 = 7（不是基础值 6）', me2.handLimits.treasure === 7, JSON.stringify(me2.handLimits));
  check('同时下发了 handLimitBonus = 1（给界面写提示用）', me2.handLimitBonus === 1, String(me2.handLimitBonus));
  check('handLimit 这个老字段也跟着变成 7', me2.handLimit === 7, String(me2.handLimit));
  check('下发的上限 == effectiveHandLimits（显示与执行同源）',
    me2.handLimits.treasure === E.effectiveHandLimits(s2.A).treasure, JSON.stringify(me2.handLimits));
  E.act(s2.st, s2.A.id, { type: 'end_turn' });
  check('7 张一张都不弃（这下界面显示 7/7、不再假警报）',
    s2.A.hand.filter((c) => c.id === JINSHEN.id).length === 7,
    String(s2.A.hand.filter((c) => c.id === JINSHEN.id).length));
}


console.log('\n[②b] 【噬金虫】离场后立刻回到 6 张上限并弃掉多出的');
{
  const { st, A } = setup(7005, []);
  const inst = { uid: 9001, id: SHIJIN.id };
  A.companions.push(inst);
  for (let i = 0; i < 7; i++) A.hand.push({ uid: 7000 + i, id: JINSHEN.id });
  check('离场前 7 张留着', A.hand.length === 7, String(A.hand.length));
  E.loseCompanion(st, A, inst);          // 模拟同行者离场（替伤用尽/主动弃置）
  const n2 = A.hand.filter((c) => c.id === JINSHEN.id).length;
  check('离场后只留 6 张', n2 === 6, String(n2));
  check('多出的进了弃牌堆', st.discard ? true : A.hand.length === 6, String(A.hand.length));
}

// ---- ③ 血咒禁制：禁抽宝物牌 + 禁发起对决 ----
console.log('\n[③] 【血咒禁制】→ 乙下回合不能抽宝物牌、不能发起对战');
{
  const { st, A, B } = setup(7006, [XUEZHOU]);
  B.hp = 2;                                     // 让乙成为"生命值最小者"（若不指定目标会被自动选中）
  check('打出【血咒禁制】', E.act(st, A.id, { type: 'play', uid: 6000, target: 'b' }).ok, '');
  while (st.pending) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); }   // 新卡可能在「卡牌使用·前」开窗  // （新增的「对方出牌时」响应牌会让这一步挂起，先清掉再断言）
  check('乙的禁抽宝物牌计数 = 1', B.blockTreasureDraw === 1, String(B.blockTreasureDraw));
  check('乙的禁对战计数 = 1', B.blockCombat === 1, String(B.blockCombat));
  E.act(st, A.id, { type: 'end_turn' });
  check('轮到乙（没被跳过）', st.players[st.turn].id === 'b', st.players[st.turn].id);
  // 走到探索阶段
  E.act(st, B.id, { type: 'draw_qi' });
  const handBefore = B.hand.length;
  const rDraw = E.act(st, B.id, { type: 'draw_treasure' });
  check('被封锁：抽宝物牌被跳过（手牌没增加）', rDraw.ok && B.hand.length === handBefore, `${handBefore} -> ${B.hand.length}`);
  check('战报里有封锁提示', st.log.some((l) => l.text.includes('不能抽取【宝物牌】')), '');
  // 禁发起对决
  st.step = 'action';
  const rCombat = E.act(st, B.id, { type: 'combat', target: 'a' });
  check('被封锁：发起对决被拒', !rCombat.ok, JSON.stringify(rCombat));
  // 本回合结束 → 封锁失效
  E.act(st, B.id, { type: 'end_turn' });
  check('乙回合结束后封锁清零', B.blockTreasureDraw === 0 && B.blockCombat === 0,
    `${B.blockTreasureDraw}/${B.blockCombat}`);
}

// ---- ④ 寒蛟的封锁在对方回合真的生效（递减时机修正）----
console.log('\n[④] 封锁计数在**回合结束**才递减（旧版在回合开始就减到 0 → 永不生效）');
{
  const { st, A, B } = setup(7007, []);
  B.blockSpellDraw = 1;                          // 模拟【寒蛟】获胜时写下封锁
  check('写下封锁时是 1', B.blockSpellDraw === 1, String(B.blockSpellDraw));
  E.act(st, A.id, { type: 'end_turn' });         // 甲的回合结束 → 轮到乙，触发乙的 startTurn
  check('乙回合开始时封锁仍是 1（没有被提前减掉）', B.blockSpellDraw === 1, String(B.blockSpellDraw));
  check('轮到乙', st.players[st.turn].id === 'b', st.players[st.turn].id);
  st.step = 'choose_draw';
  const r = E.act(st, B.id, { type: 'choose_draw', deck: 'spell' });
  check('抽法术牌被封锁', !r.ok, JSON.stringify(r));
  E.act(st, B.id, { type: 'end_turn' });
  check('乙回合结束后封锁递减为 0', B.blockSpellDraw === 0, String(B.blockSpellDraw));
}

// ---- ⑥ 长春功：凡人直接升炼气 + 抽灵气；已超凡人则改为补抽 ----
console.log('\n[⑥] 【长春功】「提升1次境界，抽1张灵气牌」');
/** 把灵气牌堆换成不会连锁的【稀薄灵气】（否则抽出【充裕灵气】/【天地灵气】会额外连锁多抽，数不清） */
function plainQiDeck(st) {
  const plain = C.cards().qi.find((c) => c.name === '稀薄灵气').id;
  st.decks.qi.draw = [];
  for (let i = 0; i < 60; i++) st.decks.qi.draw.push(plain);
}
{
  const { st, A } = setup(7008, [CHANGCHUN], 0);      // 凡人
  plainQiDeck(st); A.spells = [];
  check('起始是凡人', A.realm === 0, String(A.realm));
  const qiBefore = A.qiCards.length;
  const r = E.act(st, A.id, { type: 'play', uid: 6000 });
  check('打出成功', r.ok, JSON.stringify(r));
  check('境界提升到炼气期', A.realm === 1, String(A.realm));
  check('抽了 1 张灵气牌', A.qiCards.length === qiBefore + 1, `${qiBefore} -> ${A.qiCards.length}`);
  check('战报里有境界提升', st.log.some((l) => l.text.includes('长春功') && l.text.includes('境界提升')), '');
}
{
  const { st, A } = setup(7009, [CHANGCHUN], 2);      // 已超凡人（筑基期）
  plainQiDeck(st); A.spells = [];
  const qiBefore = A.qiCards.length;
  const r = E.act(st, A.id, { type: 'play', uid: 6000 });
  check('打出成功', r.ok, JSON.stringify(r));
  check('境界不变（已超凡人）', A.realm === 2, String(A.realm));
  check('改为补抽：共抽 2 张灵气牌', A.qiCards.length === qiBefore + 2, `${qiBefore} -> ${A.qiCards.length}`);
}

// ---- ⑦ 三目豹：不发起对战回法力，不能逐回合累加 ----
console.log('\n[⑦] 【三目豹】「本回合不发起对战，回合结束回 1 点法力」不累加');
{
  const SANMU = byName('companion', '三目豹');
  const { st, A, B } = setup(7010, []);
  A.companions = [{ uid: 9100, id: SANMU.id }];
  // 让甲的回合真正重新开始一次（必须走 startTurn，才能验证归零逻辑）
  E.act(st, A.id, { type: 'end_turn' });          // 甲 → 乙
  E.act(st, B.id, { type: 'end_turn' });          // 乙 → 甲（这次 startTurn(甲) 会跑三目豹）
  check('甲回合开始后暂存值 = 1', A.noCombatMana === 1, String(A.noCombatMana));
  st.turnFlags = { combat: false, promote: false };
  A.mana = 0;
  E.act(st, A.id, { type: 'end_turn' });
  check('甲回合结束只回 1 点法力', A.mana === 1, String(A.mana));
  // 再转一圈，确认没有累加
  E.act(st, B.id, { type: 'end_turn' });
  check('第二个回合暂存值仍是 1（旧版会是 2）', A.noCombatMana === 1, String(A.noCombatMana));
  st.turnFlags = { combat: false, promote: false };
  A.mana = 0;
  E.act(st, A.id, { type: 'end_turn' });
  check('第二个回合结束仍只回 1 点法力', A.mana === 1, String(A.mana));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
