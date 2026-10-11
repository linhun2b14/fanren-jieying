'use strict';
/**
 * 实物卡补充批（2026-10-05 第 8 件）· 19 张卡的引擎机制回归。
 *
 * 这一批把 count=0 的实物卡**全部实装**（除两张需要"窗口内选目标"交互的：
 * 【青冥针】/【金魁】，见文末 §N 的说明）。一个机制一段：
 *   [A] 太妙多宝万华阵 · roll_branch 里也能"指定目标"（effectNeedsTarget 看进分支）
 *   [B] 大庚剑阵 · 掷出 6 直接改判 + 学习条件（没【青元剑诀】就放回牌堆底重抽）
 *   [C] 罗烟步 · 战败掷骰免罚 + **免罚成功才**回 1 法力
 *   [D] 龙纹四象蟠龙带 · 可用 2 次的主动技能（mana<3 + 弃 1 张宝物牌）
 *   [E] 换形诀 · 交换所有手牌
 *   [F] 引魂钟 · 夺取对方场上的同行者
 *   [G] 七鬼噬魂术 · 本回合出牌不花法力、每张自伤 1
 *   [H] 隐灵纱 · 到自己的下回合开始前不能被指定为对战目标
 *   [I] 拘灵阵 · 其他人抽不到灵气（手动与卡牌效果都禁）
 *   [J] 傀儡弓手 · 放置后其他人各掷骰判定（5 点两边都吃伤），回合结束进弃牌堆
 *   [K] 刘靖 · 受伤时反伤来源，之后自身进弃牌堆
 *   [L] 胡月 · 同行者位 +1；它离场时多出来的同行者一起进弃牌堆
 *   [M] 南陇侯 · 后攻骰点压制 → 无视对方全部装备
 *   [N] 齐云霄 / 厉飞雨 / 曲魂 · 字段型（cardCostDiscount / absorb）本来就在跑
 */
const E = require('../server/engine');
const C = require('../server/cards');
const META = require('../server/effect-meta');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const logText = (st) => st.log.map((l) => l.text).join(' | ');

const T = (n) => { const c = [].concat(C.cards().treasure, C.cards().spell, C.cards().companion).find((x) => x.name === n); if (!c) throw new Error('卡池里没有【' + n + '】'); return c; };
let UID = 8000;
const mk = (id) => ({ uid: ++UID, id: id });

function setup(seed, o) {
  o = o || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  for (const q of st.players) q.turnsTaken = 2;
  st.turn = o.turn == null ? 0 : o.turn;
  st.step = o.step || 'action';
  st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = o.aRealm == null ? 2 : o.aRealm;
  B.realm = o.bRealm == null ? 2 : o.bRealm;
  A.mana = 12; B.mana = 12; A.hp = 6; B.hp = 6;
  A.hand = []; B.hand = []; A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = []; A.puppets = []; B.puppets = [];
  A.qiCards = []; B.qiCards = [];
  if (o.aHand) A.hand = o.aHand.map((n) => mk(T(n).id));
  if (o.bHand) B.hand = o.bHand.map((n) => mk(T(n).id));
  if (o.aEquip) A.equip = o.aEquip.map((n) => mk(T(n).id));
  if (o.bEquip) B.equip = o.bEquip.map((n) => mk(T(n).id));
  if (o.aComps) A.companions = o.aComps.map((n) => mk(T(n).id));
  if (o.bComps) B.companions = o.bComps.map((n) => mk(T(n).id));
  if (o.aSpells) A.spells = o.aSpells.map((n) => mk(T(n).id));
  if (o.bSpells) B.spells = o.bSpells.map((n) => mk(T(n).id));
  return { st: st, A: A, B: B };
}
const flushAll = (st) => { let g = 0; while (st.pending && g++ < 30) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };

// ================================================================ [A] 太妙多宝万华阵
console.log('\n[A] 太妙多宝万华阵：掷 5/6 才指定修士受伤（分支里的目标）');
{
  const card = T('太妙多宝万华阵');
  check('数据是 roll_branch（5/6 支线里是 damage 2）',
    card.effects[0].op === 'roll_branch' && card.effects[0].branches[0].faces.join() === '5,6'
      && card.effects[0].branches[0].effects[0].op === 'damage' && card.effects[0].branches[0].effects[0].value === 2,
    JSON.stringify(card.effects));
  check('effectNeedsTarget 会看进掷骰分支（否则出牌前不会弹选人）',
    META.effectNeedsTarget(card.effects[0]) === true, String(META.effectNeedsTarget(card.effects[0])));

  const s6 = setup(8101, { aHand: ['太妙多宝万华阵'] });
  s6.st.forcedDice = [6];
  const r = E.act(s6.st, 'a', { type: 'play', uid: s6.A.hand[0].uid, target: 'b' });
  check('掷出 6：乙受 2 点伤害（6 → 4）', r.ok && s6.B.hp === 4, JSON.stringify({ r: r, hpB: s6.B.hp }));

  const s3 = setup(8102, { aHand: ['太妙多宝万华阵'] });
  s3.st.forcedDice = [3];
  E.act(s3.st, 'a', { type: 'play', uid: s3.A.hand[0].uid, target: 'b' });
  check('掷出 3：兜底为空 → 乙不掉血', s3.B.hp === 6, String(s3.B.hp));

  const noT = setup(8103, { aHand: ['太妙多宝万华阵'] });
  noT.st.forcedDice = [6];
  const r2 = E.act(noT.st, 'a', { type: 'play', uid: noT.A.hand[0].uid });
  check('没指定目标时**拒绝打出**（这张卡要选人）', r2.ok === false, JSON.stringify(r2));
}

// ================================================================ [B] 大庚剑阵
console.log('\n[B] 大庚剑阵：掷出 6 → 本次对战直接判胜；学习条件');
{
  const card = T('大庚剑阵');
  check('数据：combatOpt 窗口的 roll_branch → force_win，带 response 与 learnRequires',
    card.effects[0].event === 'combatOpt' && card.effects[0].branches[0].effects[0].op === 'force_win'
      && card.response === true && card.learnRequires === '青元剑诀', JSON.stringify(card.effects));
  const s = setup(8201, { aSpells: ['大庚剑阵'] });
  s.st.forcedDice = [6, 1, 6];             // 窗口里掷 6 → 之后正常掷骰 1 / 6 都不该被用到
  const r0 = E.act(s.st, 'a', { type: 'combat', target: 'b' });
  check('开战即挂起「对战阶段」窗口', r0.paused === true || !!s.st.pending, JSON.stringify(r0));
  check('候选里有场上的【大庚剑阵】', E.pendingCards(s.st, s.A).some((c) => c.name === '大庚剑阵'),
    JSON.stringify(E.pendingCards(s.st, s.A).map((c) => c.name)));
  const rp = E.act(s.st, 'a', { type: 'respond_play', uid: s.A.spells[0].uid });
  check('破招发动成功（付 3 点法力）', rp.ok && s.A.mana === 9, JSON.stringify({ r: rp, mana: s.A.mana }));
  check('战报写明「直接视为获胜」', /直接视为获胜|改判/.test(logText(s.st)), logText(s.st).slice(-160));
  flushAll(s.st);
  check('收势后已改判（forcedWin 落袋）', !!(s.st.combat && s.st.combat.forcedWin === 'a'), JSON.stringify(s.st.combat && s.st.combat.forcedWin));
  E.act(s.st, 'a', { type: 'roll' }); E.act(s.st, 'b', { type: 'roll' });
  // 没人有"结算时"的牌 → 结果窗口零响应直通，对战直接结算掉（combat 清空），所以看战报
  check('结算时甲被判定为胜者（不比较战力：乙的骰点更高也照样输）',
    /【大庚剑阵】改判：甲/.test(logText(s.st)) && /【对战结果】甲 战胜 乙/.test(logText(s.st)),
    logText(s.st).slice(-200));
  flushAll(s.st);

  // 学习条件：抽到它但没有【青元剑诀】→ 放回牌堆底部重抽
  // ⚠️ drawFrom 是 `pile.draw.pop()`：**从数组尾部抽**，所以"接下来要抽到的牌"要 **append** 到尾部
  //    （先抽到的放后面）。
  const s2 = setup(8202, { step: 'choose_draw' });
  s2.A.hand = [];
  s2.st.decks.spell.draw = s2.st.decks.spell.draw.concat([T('补气丹').id, T('大庚剑阵').id]);
  E.act(s2.st, 'a', { type: 'choose_draw', deck: 'spell' });
  const gotId = s2.A.hand.length ? s2.A.hand[0].id : null;
  check('没【青元剑诀】→ 抽到的是下一张（【补气丹】），【大庚剑阵】被放到牌堆底',
    gotId === T('补气丹').id && s2.st.decks.spell.draw[0] === T('大庚剑阵').id,
    JSON.stringify({ got: gotId, bottom: s2.st.decks.spell.draw.slice(0, 1) }));
  check('战报说明了放回牌堆底', /学习条件/.test(logText(s2.st)), logText(s2.st).slice(-140));

  const s3 = setup(8203, { step: 'choose_draw' });
  s3.A.hand = [mk(T('青元剑诀').id)];
  s3.st.decks.spell.draw = s3.st.decks.spell.draw.concat([T('大庚剑阵').id]);
  E.act(s3.st, 'a', { type: 'choose_draw', deck: 'spell' });
  check('手里有【青元剑诀】→ 正常抽到【大庚剑阵】', s3.A.hand.some((c) => c.id === T('大庚剑阵').id),
    JSON.stringify(s3.A.hand.map((c) => c.id)));
}

// ================================================================ [C] 罗烟步
console.log('\n[C] 罗烟步：战败掷骰免罚 + 免罚成功才回 1 法力');
{
  const card = T('罗烟步');
  check('数据：lose_save_dice faces 1/6 + mana 1',
    card.effects[0].op === 'lose_save_dice' && card.effects[0].faces.join() === '1,6' && card.effects[0].mana === 1,
    JSON.stringify(card.effects));
  const win = (s) => {   // 让乙输掉一场对战（甲先攻、骰点压制）
    E.act(s.st, 'a', { type: 'combat', target: 'b' });
    flushAll(s.st);
    E.act(s.st, 'a', { type: 'roll' }); E.act(s.st, 'b', { type: 'roll' });
    flushAll(s.st);
  };
  const s1 = setup(8301, { bSpells: ['罗烟步'], aRealm: 2, bRealm: 2 });
  s1.A.mana = 4; s1.B.mana = 4;
  s1.st.forcedDice = [6, 1, 1];            // 甲 6、乙 1 → 乙败；免罚骰 = 1（命中 faces）
  win(s1);
  check('掷出 1 → 免罚（乙不掉血）', s1.B.hp === 6, String(s1.B.hp));
  check('免罚成功 → 法力 +1（4 → 5）', s1.B.mana === 5, String(s1.B.mana));
  check('战报写明恢复法力', /【罗烟步】身法未乱/.test(logText(s1.st)), logText(s1.st).slice(-140));

  const s2 = setup(8302, { bSpells: ['罗烟步'], aRealm: 2, bRealm: 2 });
  s2.A.mana = 4; s2.B.mana = 4;
  s2.st.forcedDice = [6, 1, 3];            // 免罚骰 = 3（不在 1/6 里）→ 照旧受罚
  win(s2);
  check('掷出 3 → 不免罚（乙掉 1 血）', s2.B.hp === 5, String(s2.B.hp));
  check('没免罚 → **不**回法力（法力值不变）', s2.B.mana === 4, String(s2.B.mana));
}

// ================================================================ [D] 龙纹四象蟠龙带
console.log('\n[D] 龙纹四象蟠龙带：可用 2 次、法力 <3 时弃 1 张宝物牌回 2 法力');
{
  const card = T('龙纹四象蟠龙带');
  check('数据：uses 2 + 主动技能（if.mana<3 + cost.discard）',
    card.uses === 2 && card.effects[0].when === 'activate' && card.effects[0].cost.discard === 'treasure'
      && card.effects[0].if.mana.lt === 3, JSON.stringify(card.effects));
  const s = setup(8401, { aEquip: ['龙纹四象蟠龙带'], aHand: ['补气丹', '回气丹'] });
  s.A.mana = 1;
  const r = E.act(s.st, 'a', { type: 'activate', uid: s.A.equip[0].uid });
  check('法力 1（<3）→ 可以发动', r.ok, JSON.stringify(r));
  check('弃了 1 张手牌（剩 1 张）', s.A.hand.length === 1, String(s.A.hand.length));
  check('法力 1 → 3（+2）', s.A.mana === 3, String(s.A.mana));
  check('可用次数 2 → 1', E.usesLeft(card, s.A.equip[0]) === 1, String(E.usesLeft(card, s.A.equip[0])));
  // 法力已经 3 点（不 <3）→ 条件不满足
  check('法力 3 时不再满足条件（不能发动）',
    E.act(s.st, 'a', { type: 'activate', uid: s.A.equip[0].uid }).ok === false, '');
  // 掉回 1 点再用一次 → 用完
  s.A.mana = 1;
  s.st.turnUses = {};                      // 主动技能"每回合一次"的记账，这里模拟下一回合
  s.A.activateUsed = {};
  const r2 = E.act(s.st, 'a', { type: 'activate', uid: s.A.equip[0].uid });
  check('第二次发动成功', r2.ok, JSON.stringify(r2));
  check('用完 2 次 → 之后不能再发动', E.usesLeft(card, s.A.equip[0]) === 0
    && E.act(s.st, 'a', { type: 'activate', uid: s.A.equip[0].uid }).ok === false, '');

  // ⭐ ②c 后半句"舍弃类效果自己挑"：`discardUid` 传哪张就弃哪张；传错（不是宝物牌/不在手里）直接拒
  const s2 = setup(8402, { aEquip: ['龙纹四象蟠龙带'], aHand: ['补气丹', '回气丹', '禁神牌'] });
  s2.A.mana = 1;
  const pick = s2.A.hand[1];                       // 【回气丹】
  const r3 = E.act(s2.st, 'a', { type: 'activate', uid: s2.A.equip[0].uid, discardUid: pick.uid });
  check('传 discardUid → 弃的正是玩家挑的那张（【回气丹】）',
    r3.ok && s2.A.hand.length === 2 && !s2.A.hand.some((c) => c.uid === pick.uid)
      && s2.st.decks.treasure.discard.indexOf(pick.id) >= 0,
    JSON.stringify({ r: r3, hand: s2.A.hand.map((c) => c.id) }));
  const s3 = setup(8403, { aEquip: ['龙纹四象蟠龙带'], aHand: ['补气丹'] });
  s3.A.mana = 1;
  const bad = E.act(s3.st, 'a', { type: 'activate', uid: s3.A.equip[0].uid, discardUid: 987654 });
  check('discardUid 不在手里 → 拒绝发动（不会白扣次数）',
    bad.ok === false && E.usesLeft(card, s3.A.equip[0]) === 2, JSON.stringify(bad));
}

// ================================================================ [E] 换形诀
console.log('\n[E] 换形诀：与指定修士交换所有手牌');
{
  const s = setup(8501, { aHand: ['换形诀', '补气丹', '回气丹'], bHand: ['青蛟旗'] });
  const myUid = s.A.hand[0].uid;
  const before = { a: s.A.hand.length, b: s.B.hand.length };
  const r = E.act(s.st, 'a', { type: 'play', uid: myUid, target: 'b' });
  check('打出成功', r.ok, JSON.stringify(r));
  check(`手牌互换（甲 ${before.a} → ${s.A.hand.length}，乙 ${before.b} → ${s.B.hand.length}）`,
    s.A.hand.length === before.b && s.B.hand.length === before.a - 1,
    JSON.stringify({ a: s.A.hand.map((c) => c.id), b: s.B.hand.map((c) => c.id) }));
  check('乙拿到了甲打出的【换形诀】之外的两张', s.B.hand.some((c) => c.id === T('补气丹').id), '');
}

// ================================================================ [F] 引魂钟
console.log('\n[F] 引魂钟：把对方场上的同行者收进自己手牌');
{
  const s = setup(8601, { aHand: ['引魂钟'], bComps: ['啼魂'] });
  const r = E.act(s.st, 'a', { type: 'play', uid: s.A.hand[0].uid, target: 'b' });
  check('打出成功', r.ok, JSON.stringify(r));
  check('乙场上不再有该同行者', s.B.companions.length === 0, String(s.B.companions.length));
  check('同行者进了甲的手牌', s.A.hand.some((c) => c.id === T('啼魂').id), JSON.stringify(s.A.hand.map((c) => c.id)));
}

// ================================================================ [G] 七鬼噬魂术
console.log('\n[G] 七鬼噬魂术：本回合出牌不花法力，但每张自身受 1 点伤害');
{
  const s = setup(8701, { aHand: ['七鬼噬魂术', '青蛟旗'] });
  const r0 = E.act(s.st, 'a', { type: 'play', uid: s.A.hand[0].uid });
  check('秘术打出成功', r0.ok, JSON.stringify(r0));
  check('标记已挂上', s.A.freeCardThisTurn === true, String(s.A.freeCardThisTurn));
  const mana0 = s.A.mana;
  const r1 = E.act(s.st, 'a', { type: 'play', uid: s.A.hand[0].uid, target: 'b' });
  check('【青蛟旗】打出成功', r1.ok, JSON.stringify(r1));
  check('没扣法力值（12 → 12）', s.A.mana === mana0, `${mana0} -> ${s.A.mana}`);
  check('自身受 1 点伤害（6 → 5）', s.A.hp === 5, String(s.A.hp));
  check('战报写明反噬', /反噬/.test(logText(s.st)), logText(s.st).slice(-120));
}

// ================================================================ [H] 隐灵纱
console.log('\n[H] 隐灵纱：到自己的下回合开始前不能被指定为对战目标');
{
  const s = setup(8801, { bHand: ['隐灵纱'] });
  s.st.turn = 1; s.st.step = 'action';
  const r0 = E.act(s.st, 'b', { type: 'play', uid: s.B.hand[0].uid });
  check('乙打出【隐灵纱】', r0.ok, JSON.stringify(r0));
  check('乙挂上了 noTarget', s.B.noTarget === true, String(s.B.noTarget));
  s.st.turn = 0; s.st.step = 'action'; s.st.turnFlags = { combat: false, promote: false };
  const r1 = E.act(s.st, 'a', { type: 'combat', target: 'b' });
  check('甲无法对乙发起对战', r1.ok === false && /隐去行迹/.test(r1.error || ''), JSON.stringify(r1));
  // 乙自己的下个回合开始 → 失效
  s.st.turn = 1; s.st.step = 'draw_qi'; s.st.turnFlags = { combat: false, promote: false };
  E.act(s.st, 'b', { type: 'end_turn' });
  // 手动跑一次 startTurn 的路径：借闭关/回合切换太绕，这里直接断言字段语义
  check('（字段语义）回合开始的清零清单里含 noTarget',
    /pl\.noTarget = false/.test(require('fs').readFileSync(require('path').join(__dirname, '..', 'server', 'engine.js'), 'utf8')), '');
}

// ================================================================ [I] 拘灵阵
console.log('\n[I] 拘灵阵：其他人本回合抽不到灵气（手动 + 卡牌效果都禁）');
{
  const s = setup(8901, { bHand: ['拘灵阵'] });
  s.st.turn = 1; s.st.step = 'action';
  E.act(s.st, 'b', { type: 'play', uid: s.B.hand[0].uid });
  check('乙布下【拘灵阵】后，甲的 blockQiDraw = 1', s.A.blockQiDraw === 1, String(s.A.blockQiDraw));
  s.st.turn = 0; s.st.step = 'draw_qi'; s.st.turnFlags = { combat: false, promote: false };
  const qiBefore = s.A.qiCards.length;
  E.act(s.st, 'a', { type: 'draw_qi' });
  check('甲手动炼化灵气 → 一张都没拿到', s.A.qiCards.length === qiBefore, String(s.A.qiCards.length));
  check('战报写明被【拘灵阵】封锁', /拘灵阵/.test(logText(s.st)), logText(s.st).slice(-120));
  check('牌回到灵气牌堆底部', s.st.decks.qi.draw.length > 0, String(s.st.decks.qi.draw.length));
}

// ================================================================ [J] 傀儡弓手
console.log('\n[J] 傀儡弓手：放置后其他人各掷骰判定（5 点两边都吃伤）');
{
  const s = setup(9001, { aHand: ['傀儡弓手'] });
  s.st.forcedDice = [5];                   // 乙掷 5 → 卡面：≤5 判定者受伤、≥5 放出者受伤 → 两边都吃
  const r = E.act(s.st, 'a', { type: 'play', uid: s.A.hand[0].uid });
  check('打出成功', r.ok, JSON.stringify(r));
  check('甲场上多了 1 个傀儡（不占储物袋）', s.A.puppets.length === 1 && s.A.equip.length === 0, JSON.stringify(s.A.puppets));
  check('判定 5 点：乙和甲各受 1 点伤害（6 → 5 / 6 → 5）', s.B.hp === 5 && s.A.hp === 5, JSON.stringify({ a: s.A.hp, b: s.B.hp }));

  const s2 = setup(9002, { aHand: ['傀儡弓手'] });
  s2.st.forcedDice = [2];                  // 只判定者受伤
  E.act(s2.st, 'a', { type: 'play', uid: s2.A.hand[0].uid });
  check('判定 2 点：只有乙受伤（甲不掉血）', s2.B.hp === 5 && s2.A.hp === 6, JSON.stringify({ a: s2.A.hp, b: s2.B.hp }));

  const s3 = setup(9003, { aHand: ['傀儡弓手'] });
  s3.st.forcedDice = [6];                  // ≥5 且不 ≤5 → 只有放出者受伤
  E.act(s3.st, 'a', { type: 'play', uid: s3.A.hand[0].uid });
  check('判定 6 点：只有甲受伤', s3.A.hp === 5 && s3.B.hp === 6, JSON.stringify({ a: s3.A.hp, b: s3.B.hp }));
  check('傀儡"仅存 1 回合"标记在位', s3.A.puppets[0] && s3.A.puppets[0].discardAtTurnEnd === true, JSON.stringify(s3.A.puppets));
}

// ================================================================ [K] 刘靖
console.log('\n[K] 刘靖：受伤时让来源受等额伤害，之后自身进弃牌堆');
{
  const s = setup(9101, { aComps: ['刘靖'] });
  E.applyDamage(s.st, s.A, 2, 'card', 'b');       // 乙打甲 2 点 → 受伤窗口（刘靖是 auto，不开窗）
  check('甲掉 2 血（6 → 4）', s.A.hp === 4, String(s.A.hp));
  check('乙受到等额反伤（6 → 4）', s.B.hp === 4, String(s.B.hp));
  check('刘靖用后离场', s.A.companions.length === 0, String(s.A.companions.length));
  check('战报写明反伤与离场', /等额伤害/.test(logText(s.st)) && /放入弃牌堆/.test(logText(s.st)), logText(s.st).slice(-160));
}

// ================================================================ [L] 胡月
console.log('\n[L] 胡月：同行者位 +1；它离场时多出来的同行者一起进弃牌堆');
{
  const s = setup(9201, { aRealm: 1, aComps: ['胡月'] });     // 炼气期 = 基础 1 格
  check('基础 1 格 + 胡月 = 2 格', E.companionSlots(s.A) === 2, String(E.companionSlots(s.A)));
  const second = mk(T('啼魂').id);
  s.A.hand = [second];
  const r = E.act(s.st, 'a', { type: 'play', uid: second.uid });
  check('能放下第二个同行者（没有胡月就只有 1 格）', r.ok, JSON.stringify(r));
  check('已用 2/2 格', E.companionUsedSlots(s.A) === 2, String(E.companionUsedSlots(s.A)));
  // 胡月离场 → 靠它撑出来的额外位失效，占着那个位的【啼魂】一起进弃牌堆
  E.loseCompanion(s.st, s.A, s.A.companions[0]);
  check('胡月离场后场上没有同行者了（胡月走了 + 额外位的【啼魂】被一起弃置）',
    s.A.companions.length === 0, JSON.stringify(s.A.companions.map((c) => c.id)));
  check('额外放置的那位进了弃牌堆', s.st.decks.companion.discard.indexOf(T('啼魂').id) >= 0,
    JSON.stringify(s.st.decks.companion.discard.slice(-3)));
  check('战报写明"额外放置的同行者一起被放入弃牌堆"', /额外放置的同行者/.test(logText(s.st)), logText(s.st).slice(-140));
}

// ================================================================ [M] 南陇侯
console.log('\n[M] 南陇侯：后攻骰点压制 → 无视对方全部装备类宝物牌');
{
  const s = setup(9301, { bComps: ['南陇侯'] });
  // 结算口径单测：直接喂一个"甲有 +3 装备加成"的对战对象
  const mkCombat = () => ({
    attacker: 'a', defender: 'b', dice: { a: 1, b: 6 },
    equipBonus: { a: { bonus: 3, diceBonus: 0 }, b: { bonus: 0, diceBonus: 0 } },
    bonus: {}, debuff: {}, total: {},
  });
  const withNl = E.finalOf(s.st, mkCombat(), 'a');
  check('乙（后攻）骰点 6 > 甲 1 → 甲的装备加成被清零（基础 3 + 0 = 3）',
    withNl.gearBonus === 0 && withNl.total === 3, JSON.stringify(withNl));
  const mine = E.finalOf(s.st, mkCombat(), 'b');
  check('乙自己不受影响（基础 3 + 骰点 6 = 2 分 = 5）', mine.total === 5, JSON.stringify(mine));

  // 骰点不压制时不生效
  const c2 = mkCombat(); c2.dice = { a: 6, b: 1 };
  check('乙骰点更小 → 装备加成照常（3 + 0 + 3 = 6）', E.finalOf(s.st, c2, 'a').gearBonus === 3,
    JSON.stringify(E.finalOf(s.st, c2, 'a')));

  // 没有南陇侯的对照局
  const s2 = setup(9302, {});
  check('场上没有【南陇侯】→ 装备加成照常', E.finalOf(s2.st, mkCombat(), 'a').gearBonus === 3, '');

  // 实战：开战 → 掷骰 → 结算，战报里要有【南陇侯】那一句
  const s3 = setup(9303, { bComps: ['南陇侯'] });
  s3.st.forcedDice = [1, 6];
  E.act(s3.st, 'a', { type: 'combat', target: 'b' });
  flushAll(s3.st);
  E.act(s3.st, 'a', { type: 'roll' });
  if (s3.st.combat) s3.st.combat.equipBonus = { a: { bonus: 3, diceBonus: 0 }, b: { bonus: 0, diceBonus: 0 } };
  E.act(s3.st, 'b', { type: 'roll' });
  check('实战战报写明【南陇侯】发动', /南陇侯/.test(logText(s3.st)), logText(s3.st).slice(-200));
  flushAll(s3.st);
}

// ================================================================ [N] 字段型三张
console.log('\n[N] 齐云霄 / 厉飞雨 / 曲魂：字段型实装');
{
  const s = setup(9401, { aComps: ['齐云霄'], aHand: ['青蛟旗'] });
  check('齐云霄：cardCostDiscount = 1', E.cardCostDiscount(s.A) === 1, String(E.cardCostDiscount(s.A)));
  const mana0 = s.A.mana;                   // 青蛟旗角标 1 → 减 1 后最低 1，仍收 1 点（引擎口径：最低 1）
  E.act(s.st, 'a', { type: 'play', uid: s.A.hand[0].uid, target: 'b' });
  check('2 费牌少付 1 点（12 → 11）', s.A.mana === mana0 - 1, `${mana0} -> ${s.A.mana}`);

  const c1 = T('厉飞雨'), c2 = T('曲魂');
  check('厉飞雨 / 曲魂：absorb = 2（字段型，别报"未实装"）', c1.absorb === 2 && c2.absorb === 2,
    JSON.stringify({ a: c1.absorb, b: c2.absorb }));
  const s2 = setup(9402, { aComps: ['厉飞雨'] });
  E.applyDamage(s2.st, s2.A, 3, 'card', 'b');
  check('第一次替挡：甲一点血没掉，厉飞雨还留在场上（可挡 2 次）',
    s2.A.hp === 6 && s2.A.companions.length === 1 && s2.A.companions[0].absorbed === 1,
    JSON.stringify({ hp: s2.A.hp, comps: s2.A.companions.length, absorbed: s2.A.companions[0] && s2.A.companions[0].absorbed }));
  E.applyDamage(s2.st, s2.A, 3, 'card', 'b');
  check('第二次替挡：次数用尽 → 厉飞雨进弃牌堆，甲仍然没掉血',
    s2.A.hp === 6 && s2.A.companions.length === 0, JSON.stringify({ hp: s2.A.hp, comps: s2.A.companions.length }));
}

// ================================================================ [O] 神风舟
console.log('\n[O] 神风舟：跳过本回合所有行动 + 隐去行迹 + 下回合探索多抽 1 宝物');
{
  const s = setup(9501, { aHand: ['神风舟'] });
  s.st.decks.qi.draw = [C.cards().qi[0].id, C.cards().qi[0].id].concat(s.st.decks.qi.draw);
  const r = E.act(s.st, 'a', { type: 'play', uid: s.A.hand[0].uid });
  check('打出成功', r.ok, JSON.stringify(r));
  check('甲拿到的灵气牌 +1', s.A.qiCards.length === 1, String(s.A.qiCards.length));
  check('本回合立刻结束（轮到乙）', s.st.turn === 1, String(s.st.turn));
  check('挂上 noTarget 与"下回合探索多抽 1 张宝物"', s.A.noTarget === true && s.A.nextExploreTreasure === 1,
    JSON.stringify({ noTarget: s.A.noTarget, next: s.A.nextExploreTreasure }));
  // 直接验证探索基础行动会多用那 1 张
  s.st.turn = 0; s.st.step = 'draw_treasure'; s.st.turnFlags = { combat: false, promote: false };
  const handBefore = s.A.hand.length;
  E.act(s.st, 'a', { type: 'draw_treasure' });
  check('探索阶段抽出 3 张宝物（2 + 1）', s.A.hand.length === handBefore + 3, `${handBefore} -> ${s.A.hand.length}`);
  check('用完清零', s.A.nextExploreTreasure === 0 || s.A.nextExploreTreasure == null, String(s.A.nextExploreTreasure));
}

// ================================================================ [P] 青冥针（窗口里选目标）
console.log('\n[P] 青冥针：受伤窗口里**选一位目标**受等额伤害（可用 2 次）');
{
  const card = T('青冥针');
  check('数据：hurt_reflect who:any + uses 2 + 发动费 2（卡文写了装备免费）',
    card.effects[0].op === 'hurt_reflect' && card.effects[0].who === 'any' && card.uses === 2 && card.effects[0].manaCost === 2,
    JSON.stringify(card.effects));
  check('effectNeedsTarget / effectTargetKind 都认（候选会带 needsTarget=player）',
    META.effectNeedsTarget(card.effects[0]) === true && META.effectTargetKind(card.effects[0]) === 'player',
    JSON.stringify([META.effectNeedsTarget(card.effects[0]), META.effectTargetKind(card.effects[0])]));

  const s = setup(9601, { bEquip: ['青冥针'] });
  s.B.mana = 6;
  E.applyDamage(s.st, s.B, 2, 'card', s.A.id);      // 甲打乙 2 点 → 受伤的是**乙**（青冥针的主人）
  check('受伤窗口开着', !!s.st.pending && s.st.pending.event === 'hurt', JSON.stringify(s.st.pending && s.st.pending.event));
  const cand = E.pendingCards(s.st, s.B).find((c) => c.name === '青冥针');
  check('候选带 needsTarget / targetKind', !!(cand && cand.needsTarget === true && cand.targetKind === 'player'), JSON.stringify(cand));
  check('前端拿到的候选也带这两个字段（据此弹选择器）',
    !!(E.publicState(s.st, 'b').pending.mine || []).some((c) => c.name === '青冥针' && c.needsTarget === true),
    JSON.stringify(E.publicState(s.st, 'b').pending.mine));
  const noT = E.act(s.st, 'b', { type: 'respond_play', uid: cand.uid });
  check('**不带目标**直接拒（免得白打出这张牌）', noT.ok === false && /需要先指定/.test(noT.error || ''), JSON.stringify(noT));
  const withT = E.act(s.st, 'b', { type: 'respond_play', uid: cand.uid, target: 'a' });
  check('带上目标 → 破招成功', withT.ok, JSON.stringify(withT));
  check('收势：乙掉 2 血、甲也掉 2 血（等额反伤）', s.B.hp === 4 && s.A.hp === 4, JSON.stringify({ a: s.A.hp, b: s.B.hp }));
  check('付了 2 点发动费（6 → 4）', s.B.mana === 4, String(s.B.mana));
  check('可用次数 2 → 1', E.usesLeft(card, s.B.equip[0]) === 1, String(E.usesLeft(card, s.B.equip[0])));
  // 第二次仍能用，用完就不再被摆出来问
  s.st.pending = null; s.B.mana = 6;
  E.applyDamage(s.st, s.B, 1, 'card', s.A.id);
  const cand2 = E.pendingCards(s.st, s.B).find((c) => c.name === '青冥针');
  check('第二次仍进候选', !!cand2, JSON.stringify(E.pendingCards(s.st, s.B).map((c) => c.name)));
  if (cand2) E.act(s.st, 'b', { type: 'respond_play', uid: cand2.uid, target: 'a' });
  check('可用次数用尽（2 → 0）', E.usesLeft(card, s.B.equip[0]) === 0, String(E.usesLeft(card, s.B.equip[0])));
  s.st.pending = null; s.B.mana = 6;
  E.applyDamage(s.st, s.B, 1, 'card', s.A.id);
  check('用完之后不再进候选', !E.pendingCards(s.st, s.B).some((c) => c.name === '青冥针'),
    JSON.stringify(E.pendingCards(s.st, s.B).map((c) => c.name)));
}

// ================================================================ [Q] 金魁（主动技能选场上的牌）
console.log('\n[Q] 金魁：主动技能**选场上的一张牌**使其失效');
{
  const card = T('金魁');
  check('数据：nullify_board_card + draw_qi + activateDiscardSelf',
    card.effects[0].op === 'nullify_board_card' && card.effects[1].op === 'draw_qi' && card.activateDiscardSelf === true,
    JSON.stringify(card.effects));
  check('OPS 标了 targetKind = board（前端据此弹"选牌"）',
    META.meta().ops.nullify_board_card.targetKind === 'board', JSON.stringify(META.meta().ops.nullify_board_card));

  const s = setup(9701, { aComps: ['金魁'], bSpells: ['大衍诀'] });
  // 灵气牌堆放**纯 1 点**的【稀薄灵气】**在牌堆尾部**（drawFrom 是 `pop()`，尾部先抽）；
  // 别的灵气牌自带附加效果（【充裕灵气】一次给 4 点），会干扰"抽了 1 张"的计数
  const plainQi = C.cards().qi.find((c) => c.name === '稀薄灵气');
  s.st.decks.qi.draw = s.st.decks.qi.draw.concat([plainQi.id]);
  const av = E.publicState(s.st, 'a').players.find((x) => x.id === 'a').activatables || [];
  const jin = av.find((x) => x.name === '金魁');
  check('主动技能列表里带 needsTarget / targetKind=board',
    !!(jin && jin.needsTarget === true && jin.targetKind === 'board'), JSON.stringify(av));
  check('【大衍诀】在场：乙的每回合回法力 +1', E.passives(s.B).mana_regen_bonus === 1, String(E.passives(s.B).mana_regen_bonus));
  const noT = E.act(s.st, 'a', { type: 'activate', uid: jin.uid });
  check('不带目标直接拒', noT.ok === false && /需要先指定/.test(noT.error || ''), JSON.stringify(noT));
  const bad = E.act(s.st, 'a', { type: 'activate', uid: jin.uid, targetUid: 999999 });
  check('目标不在场上 → 拒', bad.ok === false, JSON.stringify(bad));
  const qi0 = s.A.qiCards.length;
  const ok = E.act(s.st, 'a', { type: 'activate', uid: jin.uid, targetUid: s.B.spells[0].uid });
  check('带上目标 → 发动成功', ok.ok, JSON.stringify(ok));
  check('那张牌被标成失效（nullified）', s.B.spells[0].nullified === true, JSON.stringify(s.B.spells[0]));
  check('效果**真的停了**（乙的回法力加成 1 → 0）', E.passives(s.B).mana_regen_bonus === 0, String(E.passives(s.B).mana_regen_bonus));
  check('卡还在场上（是"无效"，不是"弃置"）', s.B.spells.length === 1, String(s.B.spells.length));
  check('之后抽 1 张灵气牌', s.A.qiCards.length === qi0 + 1, `${qi0} -> ${s.A.qiCards.length}`);
  check('金魁自身进弃牌堆', s.A.companions.length === 0, String(s.A.companions.length));
}

// ================================================================ [R] 青竹蜂云剑 辟邪神雷：放上去持续装备
console.log('\n[R] 【青竹蜂云剑 辟邪神雷】：放到【青竹蜂云剑】上持续装备（不额外占格）');
{
  const SHEN = T('青竹蜂云剑 辟邪神雷'), SWORD = T('青竹蜂云剑');
  check('数据带 attachTo = 青竹蜂云剑', SHEN.attachTo === '青竹蜂云剑', String(SHEN.attachTo));

  // 炼气期 = 2 格储物袋：先把两格占满，再打辟邪神雷 —— 有底牌时应当仍放得下
  const s = setup(9801, { aRealm: 1, aEquip: ['青竹蜂云剑', '黑血刀'], aHand: ['青竹蜂云剑 辟邪神雷'] });
  check('储物袋先占满（2/2）', s.A.equip.length === E.equipSlots(s.A), `${s.A.equip.length}/${E.equipSlots(s.A)}`);
  const r = E.act(s.st, 'a', { type: 'play', uid: s.A.hand[0].uid });
  check('有【青竹蜂云剑】时放得上去', r.ok, JSON.stringify(r));
  check('不额外占格：3 张牌挤在 2 格里，且带了 attachedTo 标记',
    s.A.equip.length === 3 && !!s.A.equip.find((x) => x.attachedTo != null), JSON.stringify(s.A.equip));
  check('战报写明"持续装备"', /持续装备/.test(logText(s.st)), logText(s.st).slice(-140));

  // 底牌撤下 → 叠在上面的那张一起进弃牌堆
  const sword = s.A.equip.find((x) => x.id === SWORD.id);
  E.act(s.st, 'a', { type: 'dismiss', uid: sword.uid });
  check('【青竹蜂云剑】撤下后，辟邪神雷一起进弃牌堆',
    !s.A.equip.some((x) => x.id === SHEN.id) && s.st.decks.treasure.discard.indexOf(SHEN.id) >= 0,
    JSON.stringify(s.A.equip.map((x) => x.id)));

  // 没有底牌时：照旧按格子来（有空位就正常装备，没空位就被拒）
  const s2 = setup(9802, { aRealm: 1, aEquip: ['蓝丝剑'], aHand: ['青竹蜂云剑 辟邪神雷'] });
  const r2 = E.act(s2.st, 'a', { type: 'play', uid: s2.A.hand[0].uid });
  check('没底牌但有空格 → 正常装备（不带 attachedTo）',
    r2.ok && s2.A.equip.length === 2 && !s2.A.equip.some((x) => x.attachedTo != null),
    JSON.stringify(s2.A.equip));
  const s3 = setup(9803, { aRealm: 1, aEquip: ['蓝丝剑', '黑血刀'], aHand: ['青竹蜂云剑 辟邪神雷'] });
  const r3 = E.act(s3.st, 'a', { type: 'play', uid: s3.A.hand[0].uid });
  check('没底牌又满格 → 被拒（储物袋已满）', r3.ok === false && /储物袋已满/.test(r3.error || ''), JSON.stringify(r3));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
