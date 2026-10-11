'use strict';
// v6 机制回归：针对用户报的三个问题各留一份守卫
//   ① 时点触发 bug（对方指定我为对战目标 / 平局窗口 / 投骰前后 / 任意回合）
//   ② 灵气额外抽牌的按牌计次（真正覆盖在 tests/qi-extra-test.js [E]，这里只做交叉确认）
//   ③ 这一轮新实装的卡：李化元 / 梅凝 / 青易居士 / 银月 / 钟卫娘 / 温天仁 / 虚天鼎
//   外加这轮新加的「获胜窗口 / 失败窗口」真实阶段
const E = require('../server/engine');
const C = require('../server/cards');
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
const logText = (st) => st.log.map((l) => l.text).join(' | ');

function setup(seed, opts) {
  const o = opts || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
   // 测试直接造局，不走真实回合流程 —— 这里标记"两边的第一个回合都已经过去"（新规则：第一个回合不能发起对战）
      for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = o.step || 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = o.aRealm == null ? 3 : o.aRealm;
  B.realm = o.bRealm == null ? 3 : o.bRealm;
  A.mana = 12; B.mana = 12; A.hp = o.aHp == null ? 6 : o.aHp; B.hp = o.bHp == null ? 6 : o.bHp;
  A.qiCards = []; B.qiCards = []; A.hand = []; B.hand = [];
  A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = (o.aComps || []).map((n) => ({ uid: 900 + n.length, id: CP(n).id }));
  B.companions = []; A.ignoreRealmIds = []; B.ignoreRealmIds = [];
  return { st: st, A: A, B: B };
}

console.log('[A] 时点触发：对方指定我为对战目标时，被指定方要能出牌（打断窗口）');
{
  const { st, A, B } = setup(9001, { aRealm: 2, bRealm: 2 });
  B.hand = [{ uid: 1, id: T('阴魂丝').id }];
  check('未开战时不能裸打【阴魂丝】（它是纯响应牌）', !E.act(st, 'b', { type: 'play', uid: 1 }).ok,
    JSON.stringify(E.act(st, 'b', { type: 'play', uid: 1 })));
  E.act(st, 'a', { type: 'combat', target: 'b' });
  check('甲发起对战后开出了「被指定为目标」打断窗口', !!st.pending && st.pending.event === 'combatDeclare',
    JSON.stringify(st.pending && st.pending.event));
  check('窗口里能打出【阴魂丝】的候选是乙', E.pendingCards(st, B).some((c) => c.name === '阴魂丝'),
    JSON.stringify(E.pendingCards(st, B)));
  const r = E.act(st, 'b', { type: 'respond_play', uid: 1 });
  check('乙响应打出【阴魂丝】', r.ok, JSON.stringify(r));
  check('效果生效：封锁甲使用消耗类宝物牌', /封锁|失效/.test(logText(st)), '');
  check('【阴魂丝】的数据时点 = 对战宣告 · 对方',
    (function () { const e = (T('阴魂丝').effects || [])[0]; return e.event === 'combatDeclare' && e.subject === 'foe'; })(),
    JSON.stringify((T('阴魂丝').effects || [])[0]));
}

console.log('\n[B] 时点触发：投骰前后 / 任意回合');
{
  // 颠倒五行阵 = 对方投骰后
  const { st, A, B } = setup(9002, { aRealm: 3, bRealm: 3 });
  A.hand = [{ uid: 2, id: S('颠倒五行阵').id }];
  E.act(st, 'a', { type: 'combat', target: 'b' });
  check('对方还没投骰时打不了【颠倒五行阵】', !E.act(st, 'a', { type: 'play', uid: 2 }).ok);
  E.act(st, 'a', { type: 'roll' });   // 攻方投完 → 对方(乙)仍未投，仍不满足"对方投骰后"
  check('攻方刚投完、应战方未投时仍打不了', !E.act(st, 'a', { type: 'play', uid: 2 }).ok);
  // 让乙投完（此时双方都投过 → 对甲来说"对方投骰后"成立，但这一投会直接结算，
  // 所以用状态断言代替点击断言）
  check('【颠倒五行阵】数据窗口是 afterFoeRoll', opOf(S('颠倒五行阵'), 'afterFoeRoll') === 'force_reroll_foe');

  // 遮天钟 = 任意回合（改为自己回合可打，不再锁死在对战里）
  const s2 = setup(9003, { aRealm: 2, bRealm: 2 });
  s2.A.hand = [{ uid: 3, id: T('遮天钟').id }];
  check('【遮天钟】在自己回合行动阶段可以打出', E.act(s2.st, 'a', { type: 'play', uid: 3 }).ok);
  check('【遮天钟】数据窗口是 play', opOf(T('遮天钟'), 'play') === 'damage_save_dice');
}

console.log('\n[C] 时点触发：平局窗口能打出【天星大阵】');
{
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 1 });
  E.beginGame(st);
   // 测试直接造局，不走真实回合流程 —— 这里标记"两边的第一个回合都已经过去"（新规则：第一个回合不能发起对战）
      for (const q of st.players) q.turnsTaken = 2;
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = 2; B.realm = 2; A.hp = 4; A.mana = 12; B.mana = 12; A.qiCards = []; B.qiCards = [];
  A.hand = [{ uid: 1, id: S('天星大阵').id }]; B.hand = [];
  A.equip = []; B.equip = []; A.spells = []; B.spells = []; A.companions = []; B.companions = [];
  E.act(st, 'a', { type: 'combat', target: 'b' });
  // 掷骰前后会开「投骰」询问窗口（有人有牌才开）——这里先全部放弃
  const flushWin = () => { for (let g = 0; g < 8 && st.pending; g++) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };
  flushWin();
  E.act(st, 'a', { type: 'roll' }); flushWin();
  E.act(st, 'b', { type: 'roll' });
  if (st.pending && st.pending.event === 'combatResult' && st.pending.phase === 'tie') {
    // 平局窗口现在是**锁链**：在时点询问里用 respond_play 出牌
    check('平局窗口挂着 combatResult 时点询问', st.combat && st.combat.stage === 'tie', '');
    check('待表态的是甲', E.pendingActor(st) && E.pendingActor(st).id === 'a', E.pendingActor(st) && E.pendingActor(st).id);
    check('候选里有【天星大阵】', E.pendingCards(st, A).some((c) => c.name === '天星大阵'),
      JSON.stringify(E.pendingCards(st, A)));
    const r = E.act(st, 'a', { type: 'respond_play', uid: 1 });
    check('平局窗口可以打出【天星大阵】', r.ok, JSON.stringify(r));
    check('恢复 1 点生命值（4 -> 5）', A.hp === 5, String(A.hp));
    flushWin();
  } else {
    console.log('    （本局没进平局，跳过）');
    skip('（本局没进平局，跳过）');
    skip('（本局没进平局，跳过）');
    skip('（本局没进平局，跳过）');
  }
  check('【天星大阵】数据窗口是 tie', opOf(S('天星大阵'), 'tie') === 'heal');
}

console.log('\n[D] 结果窗口：赢家可打「获胜时」的牌、输家可打「失败时」的牌');
{
  // 赢家：风云幡（抽 1 张灵气牌）
  const { st, A, B } = setup(9004, { aRealm: 4, bRealm: 3 });
  A.hand = [{ uid: 4, id: T('风云幡').id }];
  B.hand = [{ uid: 9, id: T('透明丝线').id }];       // 输家手里也有一张「失败时」的牌，用来观察锁链
  check('投骰前打【风云幡】被拒（卡文是"对战获胜时"）', !E.act(st, 'a', { type: 'play', uid: 4 }).ok);
  E.act(st, 'a', { type: 'combat', target: 'b' });
  st.combat.bonus['a'] = 5;   // 保证甲赢
  const early = E.act(st, 'a', { type: 'play', uid: 4 });
  check('战果未定时仍被拒', !early.ok, JSON.stringify(early));
  E.act(st, 'a', { type: 'roll' }); E.act(st, 'b', { type: 'roll' });
  // 结果窗口现在是**锁链**：开一个 combatResult 时点询问，赢家先表态、输家可响应
  check('进入结果窗口（stage=result + 挂着时点询问）',
    !!st.combat && st.combat.stage === 'result' && !!st.pending && st.pending.event === 'combatResult',
    st.combat && `${st.combat.stage}/${st.pending && st.pending.event}`);
  check('先由赢家表态', E.pendingActor(st) && E.pendingActor(st).id === 'a', E.pendingActor(st) && E.pendingActor(st).id);
  check('赢家的候选里有【风云幡】', E.pendingCards(st, A).some((c) => c.name === '风云幡'),
    JSON.stringify(E.pendingCards(st, A)));
  const q0 = A.qiCards.length;
  const r = E.act(st, 'a', { type: 'respond_play', uid: 4 });
  check('赢家在获胜窗口打出【风云幡】', r.ok, JSON.stringify(r));
  // 锁链：赢家出完牌后轮到输家响应（他手里有【透明丝线】）
  check('打出后轮到输家响应（锁链没关）', !!st.pending && E.pendingActor(st).id === 'b',
    JSON.stringify(st.pending && E.pendingActor(st) && E.pendingActor(st).id));
  check('输家的候选里有【透明丝线】', E.pendingCards(st, B).some((c) => c.name === '透明丝线'),
    JSON.stringify(E.pendingCards(st, B)));
  E.act(st, 'b', { type: 'respond_pass' });
  check('结算后抽到灵气牌', A.qiCards.length > q0, `${q0} -> ${A.qiCards.length}`);
  check('对战已结束', st.combat === null);
  const again = E.act(st, 'a', { type: 'play', uid: 4 });
  check('对战结束后不能再出牌', !again.ok, JSON.stringify(again));
}

console.log('\n[E] 结果窗口：输家打【踏云靴】免罚 / 【透明丝线】反伤');
{
  const { st, A, B } = setup(9005, { aRealm: 4, bRealm: 3 });
  B.hand = [{ uid: 5, id: T('踏云靴').id }];
  E.act(st, 'a', { type: 'combat', target: 'b' });
  st.combat.bonus['a'] = 5;
  E.act(st, 'a', { type: 'roll' }); E.act(st, 'b', { type: 'roll' });
  check('赢家没牌可打 → 不排进队列，直接轮到输家', E.pendingActor(st).id === 'b', E.pendingActor(st) && E.pendingActor(st).id);
  check('轮到输家（lose 角色）', E.pendingActor(st) && E.pendingActor(st).id === 'b',
    E.pendingActor(st) && E.pendingActor(st).id);
  check('输家的候选里有【踏云靴】', E.pendingCards(st, B).some((c) => c.name === '踏云靴'),
    JSON.stringify(E.pendingCards(st, B)));
  const hp0 = B.hp;
  const r = E.act(st, 'b', { type: 'respond_play', uid: 5 });
  check('输家打出【踏云靴】', r.ok, JSON.stringify(r));
  check('免掉战败惩罚（血量不变）', B.hp === hp0, `${hp0} -> ${B.hp}`);
  check('对战已结束', st.combat === null);

  // 透明丝线：反伤对方
  const s2 = setup(9006, { aRealm: 4, bRealm: 3 });
  s2.B.hand = [{ uid: 6, id: T('透明丝线').id }];
  E.act(s2.st, 'a', { type: 'combat', target: 'b' });
  s2.st.combat.bonus['a'] = 5;
  const ah0 = s2.A.hp;
  E.act(s2.st, 'a', { type: 'roll' }); E.act(s2.st, 'b', { type: 'roll' });
  E.act(s2.st, 'a', { type: 'respond_pass' });
  const r2 = E.act(s2.st, 'b', { type: 'respond_play', uid: 6 });
  check('输家打出【透明丝线】', r2.ok, JSON.stringify(r2));
  check('赢家被反伤 1 点', s2.A.hp === ah0 - 1, `${ah0} -> ${s2.A.hp}`);
}

console.log('\n[F] 主动技能：梅凝 / 青易居士');
{
  const { st, A } = setup(9007, { aRealm: 3, aHp: 4, aComps: ['梅凝'] });
  const acts = E.publicState(st, 'a').players[0].activatables;
  check('publicState 暴露了可发动的主动技能', !!acts && acts.some((a) => a.name === '梅凝'), JSON.stringify(acts));
  const uid = A.companions[0].uid;
  const r = E.act(st, 'a', { type: 'activate', uid: uid });
  check('发动【梅凝】的主动技能', r.ok, JSON.stringify(r));
  check('恢复 1 点生命值（4 -> 5）', A.hp === 5, String(A.hp));
  check('抽到 3 张宝物牌', A.hand.length === 3, String(A.hand.length));
  check('用后自身离场进弃牌堆', A.companions.length === 0, String(A.companions.length));

  // 青易居士（阶段事务模型，2026-10-05）：探索阶段先开【斗法】窗问「要不要改抽」（卡文带
  // 「可选择」= 主动发动必须问），收势时登记替换，基础行动「抽 2 宝物」最后才结算成
  // 1 宝物 + 1 法术；抉择阶段（法术/同行者二选一）不受影响。旧的 mode:'qingyi' 特殊按钮已废。
  const s2 = setup(9008, { aRealm: 3, step: 'draw_treasure', aComps: ['青易居士'] });
  const r2 = E.act(s2.st, 'a', { type: 'draw_treasure' });
  check('探索先开【斗法】窗（青易居士在场）', r2.ok && r2.paused && !!s2.st.pending, JSON.stringify(r2));
  check('窗口里给出【青易居士】候选（场上发动）',
    E.pendingCards(s2.st, s2.A).some((c) => c.name === '青易居士' && c.where === 'board'),
    JSON.stringify(E.pendingCards(s2.st, s2.A)));
  const rp = E.act(s2.st, 'a', { type: 'respond_play', uid: s2.A.companions[0].uid });
  check('在窗口里发动【青易居士】（收势登记 → 基础行动改抽）', rp.ok, JSON.stringify(rp));
  check('窗口已收（oncePerTurn 滤掉已发动 → 零响应直通基础行动）', !s2.st.pending, '');
  const dk = s2.A.hand.map((c) => C.cards().treasure.some((x) => x.id === c.id) ? 'treasure'
    : (C.cards().spell.some((x) => x.id === c.id) ? 'spell' : '?'));
  check('拿到 1 宝物 + 1 法术（没有任何弃牌）',
    s2.A.hand.length === 2 && dk.filter((d) => d === 'treasure').length === 1 && dk.filter((d) => d === 'spell').length === 1,
    JSON.stringify(dk));
  check('随后进入抉择阶段（不受影响）', s2.st.step === 'choose_draw', s2.st.step);
  const r2b = E.act(s2.st, 'a', { type: 'choose_draw', deck: 'spell' });
  check('抉择阶段照常抽取', r2b.ok, JSON.stringify(r2b));

  // 「可以」= 也可以不发动：跳过 → 基础行动照旧 2 张宝物牌
  const s2p = setup(9011, { aRealm: 3, step: 'draw_treasure', aComps: ['青易居士'] });
  E.act(s2p.st, 'a', { type: 'draw_treasure' });
  E.act(s2p.st, 'a', { type: 'respond_pass' });
  check('跳过不发动 → 照抽 2 张宝物牌并进抉择阶段',
    s2p.A.hand.length === 2 && s2p.st.step === 'choose_draw' && !s2p.st.pending,
    JSON.stringify({ hand: s2p.A.hand.length, step: s2p.st.step }));

  // 场上没有探索类牌 → 不开窗，直接落基础行动
  const s3 = setup(9010, { aRealm: 3, step: 'draw_treasure' });
  const r3 = E.act(s3.st, 'a', { type: 'draw_treasure' });
  check('没有探索类牌时不开窗、直接抽 2 张宝物牌', r3.ok && !s3.st.pending && s3.A.hand.length === 2,
    JSON.stringify({ ok: r3.ok, hand: s3.A.hand.length }));
  check('青易居士已不再是"主动技能"（activatables 里没有它）',
    !(E.publicState(s2.st, 'a').players[0].activatables || []).some((x) => x.name === '青易居士'));
}

console.log('\n[G] 李化元：拿出来【青元剑诀】并无视境界');
{
  const { st, A } = setup(9009, { aRealm: 0 });   // 凡人期
  A.hand = [{ uid: 8, id: CP('李化元').id }];
  check('凡人期可以招【李化元】（同行者无境界限制）', E.act(st, 'a', { type: 'play', uid: 8 }).ok);
  const got = A.hand[0];
  check('手牌里出现了【青元剑诀】', got && (C.cards().spell.find((x) => x.id === got.id) || {}).name === '青元剑诀',
    JSON.stringify(A.hand));
  check('记录为"无视境界"', (A.ignoreRealmIds || []).indexOf(got.id) >= 0, JSON.stringify(A.ignoreRealmIds));
  // 青元剑诀正常需要炼气期，凡人期靠李化元才能装
  const r = E.act(st, 'a', { type: 'play', uid: got.uid, tier: 0 });
  check('凡人期能装上无视境界的【青元剑诀】', r.ok, JSON.stringify(r));

  // 对照：没有李化元时凡人装不了
  const s2 = setup(9010, { aRealm: 0 });
  s2.A.hand = [{ uid: 9, id: S('青元剑诀').id }];
  check('（对照）没有李化元时凡人装不了【青元剑诀】', !E.act(s2.st, 'a', { type: 'play', uid: 9, tier: 0 }).ok);
}

console.log('\n[H] 银月：装备宝物牌时抽灵气 / 额外掷骰要求有装备');
{
  const { st, A } = setup(9011, { aRealm: 3, aComps: ['银月'] });
  A.hand = [{ uid: 10, id: T('青竹蜂云剑').id }];
  const q0 = A.qiCards.length;
  check('装备一件宝物牌', E.act(st, 'a', { type: 'play', uid: 10 }).ok);
  check('【银月】触发抽 1 张灵气牌', A.qiCards.length > q0, `${q0} -> ${A.qiCards.length}`);
  // hasEquip 条件：储物袋里没装备时不该给 reroll
  const s2 = setup(9012, { aRealm: 3, aComps: ['银月'] });
  E.act(s2.st, 'a', { type: 'combat', target: 'b' });
  const noEq = E.companionCombat(s2.st, s2.A, s2.st.combat);
  check('储物袋无装备时不给额外掷骰', noEq.rerollDice === undefined || noEq.rerollDice === 0,
    JSON.stringify(noEq));
  check('【银月】数据里带了 hasEquip 条件（免费自动 → 标成 standing）',
    JSON.stringify((effOf(CP('银月'), 'standing') || {}).if || {}) === JSON.stringify({ hasEquip: true }),
    JSON.stringify(effOf(CP('银月'), 'standing')));
}

console.log('\n[I] 钟卫娘：越级使用宝物牌掷骰 ≥3 免额外法力');
{
  // 用【红线遁光针】（炼气期消耗牌，窗口是"自己回合"），让凡人期去越级使用
  const card = T('红线遁光针');
  const baseCost = card.cost;   // 越级时应付 baseCost + 1
  let saved = 0, extra = 0;
  for (let seed = 9100; seed < 9140; seed++) {
    const { st, A } = setup(seed, { aRealm: 0, aComps: ['钟卫娘'] });
    A.mana = 12;
    A.hand = [{ uid: 11, id: card.id }];
    const before = A.mana;
    const r = E.act(st, 'a', { type: 'play', uid: 11, target: 'b' });
    if (!r.ok) continue;
    const paid = before - A.mana;
    if (paid === baseCost) saved++;
    else if (paid === baseCost + 1) extra++;
  }
  check('凡人期确实能越级使用【红线遁光针】', saved + extra > 0, `样本 ${saved + extra}`);
  check('有【钟卫娘】时出现过"掷骰免掉额外法力"的情况', saved > 0, `免掉 ${saved} 次 / 仍付费 ${extra} 次`);
  check('也确实出现过仍要付费的情况（是掷骰，不是必然免）', extra > 0, `免掉 ${saved} / 付费 ${extra}`);
  check('【钟卫娘】数据里有 overreach_dice_save',
    (CP('钟卫娘').effects || []).some((e) => e.op === 'overreach_dice_save'));

  // 对照：没有钟卫娘时必须付额外 1 点
  const s2 = setup(9150, { aRealm: 0 });
  s2.A.mana = 12;
  s2.A.hand = [{ uid: 12, id: card.id }];
  const b2 = s2.A.mana;
  check('（对照）没有钟卫娘时，越级必须多付 1 点', E.act(s2.st, 'a', { type: 'play', uid: 12, target: 'b' }).ok
    && b2 - s2.A.mana === baseCost + 1, String(b2 - s2.A.mana));
}

console.log('\n[J] 温天仁：对战效果要付 3 点法力；虚天鼎第二档付 1 点');
{
  // 用户判据：**消耗法力才能发动 = 主动询问**（不消耗 = 自动）。
  // 所以温天仁不再是"对战开始自动扣 3 点"，而是在「对战·可选发动」时点问一句，由玩家决定。
  const { st, A, B } = setup(9013, { aRealm: 3, bRealm: 3, aComps: ['温天仁'] });
  A.mana = 12;
  const rc = E.act(st, 'a', { type: 'combat', target: 'b' });
  check('发起对战后挂起，问要不要发动温天仁', rc.ok && rc.paused === true, JSON.stringify(rc));
  // 2026-10-02：开战窗口**三合一**（combatDeclare + combatOpt 一次问完），事件名仍是先手那个
  check('开战挂起的是合并窗口（对战阶段）', !!st.pending && st.pending.event === 'combatDeclare',
    JSON.stringify(st.pending && st.pending.event));
  check('候选里有【温天仁】', E.pendingCards(st, A).some((c) => c.name === '温天仁'),
    JSON.stringify(E.pendingCards(st, A)));
  check('此时**还没扣**法力（等玩家决定）', A.mana === 12, String(A.mana));
  const rp = E.act(st, 'a', { type: 'respond_play', uid: st.pending.queue.length ? A.companions[0].uid : 0 });
  check('发动【温天仁】', rp.ok, JSON.stringify(rp));
  check('发动后扣掉 3 点法力', A.mana === 9, String(A.mana));
  check('战报有扣费提示', /消耗 3 点法力值，发动【温天仁】/.test(logText(st)), '');
  check('对方战力 -1（按卡文是削对方，不是减自己）',
    !!(st.combat && st.combat.debuff && st.combat.debuff.b), JSON.stringify(st.combat && st.combat.debuff));

  // 法力不足时**根本不会问**（付不起就不该开出只能点放弃的空窗口）
  const s2 = setup(9014, { aRealm: 3, bRealm: 3, aComps: ['温天仁'] });
  s2.A.mana = 1;
  const rc2 = E.act(s2.st, 'a', { type: 'combat', target: 'b' });
  check('法力不足时不开窗口', rc2.ok && !rc2.paused && !s2.st.pending, JSON.stringify(rc2));
  check('法力也没被暗中扣掉（仍是 1 点）', s2.A.mana === 1, String(s2.A.mana));

  // 虚天鼎：用户 2026-10-02 重新裁定 —— 这张牌**总共只有"装备时 5 点"**这一笔费用（equipCost），
  // 没有"对战启用费"；两个效果各按卡文的时点发动：
  //   ① 对方发动【法术/宝物牌】时（useCard·前）无效该牌，不耗法力，**一回合一次**；
  //   ② 我方投骰前（roll·前）花 1 点法力，本场临时战力 +1。
  const X = T('虚天鼎 乾蓝冰焰');
  check('【虚天鼎】不再是"装备时选一档"（没有 tiers）', !X.tiers, JSON.stringify(X.tiers));
  check('【虚天鼎】没有对战启用费（enable_equip_combat 已删，只剩装备时 5 点）',
    !(X.effects || []).some((e) => e.op === 'enable_equip_combat'), JSON.stringify(X.effects));
  check('【虚天鼎】无效对方牌那档不耗法力、且标了一回合一次',
    (X.effects || []).some((e) => e.op === 'nullify_enemy_card' && !e.manaCost && e.oncePerTurn === true),
    JSON.stringify(X.effects));
  check('【虚天鼎】战力+1 那档是"投骰前 + 1 点法力"',
    (X.effects || []).some((e) => e.op === 'combat_bonus' && e.manaCost === 1 && e.event === 'roll' && e.phase === 'before'),
    JSON.stringify(X.effects));
}

console.log('\n[K] 陈巧倩：使用指定丹药时效果翻倍（机制已实装，缺的是那两张牌）');
{
  // 【补气丹】【回气丹】不在真实卡池里，所以注入一张合成丹来验证机制本身
  const PILL = { id: 'test_buqi_dan', name: '补气丹', type: 'consume', cost: 0, realm: 0, count: 1,
    text: '测试用：恢复 2 点生命值。', effect: { kind: 'heal', value: 2 } };
  C.cards().treasure.push(PILL);

  const mk = (seed, withCQQ) => {
    const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
    E.beginGame(st);
   // 测试直接造局，不走真实回合流程 —— 这里标记"两边的第一个回合都已经过去"（新规则：第一个回合不能发起对战）
      for (const q of st.players) q.turnsTaken = 2;
    st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
    const A = st.players[0];
    A.realm = 3; A.mana = 12; A.hp = 2; A.qiCards = []; A.hand = []; A.equip = []; A.spells = [];
    A.companions = withCQQ ? [{ uid: 1, id: CP('陈巧倩').id }] : [];
    A.hand = [{ uid: 2, id: PILL.id }];
    return { st: st, A: A };
  };

  const no = mk(9201, false);
  E.act(no.st, 'a', { type: 'play', uid: 2 });
  check('没有陈巧倩时，丹药按原值结算（2+2=4）', no.A.hp === 4, String(no.A.hp));

  const yes = mk(9202, true);
  E.act(yes.st, 'a', { type: 'play', uid: 2 });
  check('有陈巧倩时效果翻倍（2+2+2=6）', yes.A.hp === 6, String(yes.A.hp));
  check('用后陈巧倩离场进弃牌堆', yes.A.companions.length === 0, String(yes.A.companions.length));
  check('战报写明「翻倍结算」', /翻倍结算/.test(logText(yes.st)), '');

  check('【陈巧倩】数据里有 double_card_effect 机制',
    (CP('陈巧倩').effects || []).some((e) => e.op === 'double_card_effect'), JSON.stringify(CP('陈巧倩').effects));
  check('且名单里就是【补气丹】【回气丹】',
    JSON.stringify(effOf(CP('陈巧倩'), 'passive').names) === JSON.stringify(['补气丹', '回气丹']),
    JSON.stringify(effOf(CP('陈巧倩'), 'passive').names));
}

console.log('\n[L] 用户新给的三张卡数据：【补气丹】【回气丹】【风雷翅】');
{
  const BQ = T('补气丹'), HQ = T('回气丹'), FL = T('风雷翅');

  check('【补气丹】在池里，凡人+ / 0 费', !!BQ && BQ.realm === 0 && BQ.cost === 0, BQ && `${BQ.realm}/${BQ.cost}`);
  // 2026-10-05 用户在编辑器改文案：【补气丹】从"抽 1 张灵气牌"改成"恢复 1 点生命值"
  check('【补气丹】效果 = 恢复 1 点生命值', opOf(BQ, 'play') === 'heal' && effOf(BQ, 'play').value === 1,
    JSON.stringify(effOf(BQ, 'play')));
  check('【回气丹】在池里，凡人+ / 0 费', !!HQ && HQ.realm === 0 && HQ.cost === 0, HQ && `${HQ.realm}/${HQ.cost}`);
  check('【回气丹】效果 = 回复 2 点法力', opOf(HQ, 'play') === 'mana' && effOf(HQ, 'play').value === 2,
    JSON.stringify(effOf(HQ, 'play')));

  // 实测：回气丹真的回 2 点法力
  const { st, A } = setup(9301, { aRealm: 0 });
  A.mana = 2;
  A.hand = [{ uid: 21, id: HQ.id }];
  check('打出【回气丹】成功', E.act(st, 'a', { type: 'play', uid: 21 }).ok);
  check('法力 2 -> 4', A.mana === 4, String(A.mana));

  // 实测：补气丹真的回 1 点血（满血时会被夹住，所以先把血打低）
  const s2 = setup(9302, { aRealm: 0, aHp: 4 });
  s2.A.hand = [{ uid: 22, id: BQ.id }];
  const hp0 = s2.A.hp;
  check('打出【补气丹】成功', E.act(s2.st, 'a', { type: 'play', uid: 22 }).ok);
  check('生命值 +1（4 -> 5）', s2.A.hp === hp0 + 1, `${hp0} -> ${s2.A.hp}`);

  // 风雷翅：卡文与 cost 一致了
  check('【风雷翅】cost = 3', FL.cost === 3, String(FL.cost));
  check('【风雷翅】卡文写的是「装备时消耗3点」，与数据一致', /装备时消耗3点/.test(FL.text), FL.text);
  check('不再有「2点」的残留', !/装备时消耗2点/.test(FL.text));
}

console.log('\n[M] 【陈巧倩】配合真实【回气丹】：效果翻倍后离场');
{
  const HQ = T('回气丹');
  const mk = (seed, withCQQ) => {
    const s = setup(seed, { aRealm: 0, aComps: withCQQ ? ['陈巧倩'] : [] });
    s.A.mana = 2;
    s.A.hand = [{ uid: 31, id: HQ.id }];
    return s;
  };
  const no = mk(9401, false);
  E.act(no.st, 'a', { type: 'play', uid: 31 });
  check('没有陈巧倩时回气丹回 2 点（2 -> 4）', no.A.mana === 4, String(no.A.mana));

  const yes = mk(9402, true);
  E.act(yes.st, 'a', { type: 'play', uid: 31 });
  check('有陈巧倩时翻倍回 4 点（2 -> 6）', yes.A.mana === 6, String(yes.A.mana));
  check('用后陈巧倩离场', yes.A.companions.length === 0, String(yes.A.companions.length));
}

console.log('\n[N] 【傀儡蜥蜴】：独立傀儡位（不占储物袋）');
{
  const P = T('傀儡蜥蜴');
  const { st, A } = setup(9501, { aRealm: 3 });
  A.hand = [{ uid: 41, id: P.id }];
  const m0 = A.mana;
  check('打出【傀儡蜥蜴】成功', E.act(st, 'a', { type: 'play', uid: 41 }).ok);
  check('装备时不消耗法力', A.mana === m0, `${m0} -> ${A.mana}`);
  check('占的是独立傀儡位（puppets）', A.puppets.length === 1, JSON.stringify(A.puppets));
  check('不占储物袋格子', A.equip.length === 0, String(A.equip.length));
  check('数据里标了 equipSlot=puppet', P.equipSlot === 'puppet', P.equipSlot);
  check('publicState 暴露了 puppets', Array.isArray(E.publicState(st, 'a').players[0].puppets));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
