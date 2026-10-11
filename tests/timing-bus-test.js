'use strict';
// 时点总线（事件 + 主体 + 阶段）回归：
//   ① 元数据完整性 —— 每个 when 都要能映射到总线坐标；事件/阶段声明要自洽；卡池里的 when 都得认得出
//   ② 零响应直通 —— 没人在意时必须返回值不变、状态不动（这是"行为与旧版完全一致"的保证）
//   ③ 主体对称 —— 「对方投骰前」找的是对家，「我方投骰前」找的是自己
//   ④ 非时点（passive / activate）永远不该被当成时点响应者
const E = require('../server/engine');
const C = require('../server/cards');
const M = require('../server/effect-meta');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
let skipCount = 0;
/** 「条件不成立 → 这条没什么可验」的断言走 skip()：**只记录、不计入通过数**
 *  （以前写成 `check(名, true)`，永远通过，把"通过数"撑虚高了 —— 交接 §5.2 的老欠账）。 */
const skip = (n, why) => { skipCount++; console.log('  ⊘ ' + n + (why ? '  << ' + why : '')); };

// ---------------------------------------------------------------- ① 元数据完整性
console.log('[①] 时点总线元数据完整性');
{
  const whens = Object.keys(M.WHEN);
  const missing = whens.filter((w) => !(w in M.WHEN_TIMING));
  check(`每个 when 都有总线映射（共 ${whens.length} 个）`, missing.length === 0, missing.join('、'));

  const undef = Object.keys(M.WHEN_TIMING).filter((w) => whens.indexOf(w) < 0);
  check('WHEN_TIMING 里没有多余的 when', undef.length === 0, undef.join('、'));

  const badEvent = Object.entries(M.WHEN_TIMING)
    .filter(([, t]) => t.event && !M.EVENTS[t.event]).map(([w, t]) => `${w}→${t.event}`);
  check('每个映射指向的事件都存在', badEvent.length === 0, badEvent.join('、'));

  const badPhase = [];
  for (const [w, t] of Object.entries(M.WHEN_TIMING)) {
    if (!t.event || !t.phase) continue;
    if (M.EVENTS[t.event].phases.indexOf(t.phase) < 0) badPhase.push(`${w}→${t.event}.${t.phase}`);
  }
  check('用到的阶段都被该事件声明过', badPhase.length === 0, badPhase.join('、'));

  const badEv = Object.entries(M.EVENTS).filter(([, e]) => !e.label || !e.subject);
  check('每个事件都有 label 与 subject', badEv.length === 0, badEv.map(([k]) => k).join('、'));

  // 卡池里实际用到的 when 必须全部认得出（只写了 event 的纯响应牌没有 when，跳过）
  const used = new Set();
  for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
    for (const c of C.cards()[deck] || []) {
      for (const e of c.effects || []) if (e.when) used.add(e.when);
      for (const t of c.tiers || []) for (const e of t.effects || []) if (e.when) used.add(e.when);
    }
  }
  const unknown = [...used].filter((w) => !(w in M.WHEN_TIMING));
  check(`卡池里用到的 when 全部认得（${used.size} 种）`, unknown.length === 0, unknown.join('、'));

  // 非时点
  check('passive 映射到"无事件"', M.WHEN_TIMING.passive.event === null);
  check('activate 映射到"无事件"', M.WHEN_TIMING.activate.event === null);
  for (const c of C.cards().companion) {
    for (const e of c.effects || []) {
      if (e.when === 'passive' || e.when === 'activate') {
        check(`【${c.name}】的 ${e.when} 被判为非时点`, M.timingOfEffect(e).event === null);
      }
    }
  }

  // 抽牌类时点只给自己（用户裁定）
  for (const ev of ['drawQi', 'drawTreasure', 'drawSpell']) {
    check(`事件 ${ev} 标了 selfOnly（对手不能插）`, M.EVENTS[ev].selfOnly === true);
  }

  // 文案（2026-10-02 深夜改口径）：中文名不再现场拼「事件 · 主体 · 阶段」，
  // 而是按**用户给的阶段图**取名（见 effect-meta.js 的 TIMING_NAMES）
  check('「对方投骰前」叫「对战阶段 · 对方投骰前」',
    M.timingLabel(M.timingOfWhen('beforeFoeRoll')) === '对战阶段 · 对方投骰前',
    M.timingLabel(M.timingOfWhen('beforeFoeRoll')));
  check('「对战获胜时」叫「对战结算阶段 · 获胜」',
    M.timingLabel(M.timingOfWhen('win')) === '对战结算阶段 · 获胜',
    M.timingLabel(M.timingOfWhen('win')));
  check('出牌阶段（自己回合打出）叫「出牌阶段」',
    M.timingLabel(M.timingOfWhen('play')) === '出牌阶段', M.timingLabel(M.timingOfWhen('play')));
  // ⭐ 时点缩减（用户 2026-10-02 深夜二裁定）：重复的时点**合并成同一个名字**
  check('晋升·前 与 晋升·后 合并成「晋升阶段」（升阶段只有一个时点）',
    M.timingLabel(M.timingOfWhen('promote')) === '晋升阶段'
    && M.timingLabel({ event: 'promote', subject: 'self', phase: 'before' }) === '晋升阶段',
    M.timingLabel(M.timingOfWhen('promote')));
  check('【三合一】combatDeclare / combatOpt / chooseTarget 都叫「对战阶段」',
    ['combatDeclare', 'combatOpt', 'chooseTarget'].every((ev) =>
      M.timingLabel({ event: ev, subject: 'self', phase: null }) === '对战阶段'),
    ['combatDeclare', 'combatOpt', 'chooseTarget'].map((ev) => M.timingLabel({ event: ev, subject: 'self' })).join(' / '));
  check('「对方出牌阶段」（虚天鼎拦牌）归到对战出牌阶段那一行',
    M.timingLabel({ event: 'useCard', subject: 'foe', phase: 'before' }) === '对战阶段 · 对方出牌阶段'
    && M.timingStageOf({ event: 'useCard', subject: 'foe', phase: 'before' }) === '对战阶段',
    M.timingLabel({ event: 'useCard', subject: 'foe', phase: 'before' }));
  check('时点表 24 格 → 18 行（TIMING_GRID，一行可含多个钩子）',
    M.meta().timingGrid.length === 18, String(M.meta().timingGrid.length));
  check('「对方出牌阶段」与投骰前共用同一行（不再单独占一行）', (function () {
    const row = M.meta().timingGrid.find((g) => g.hooks.indexOf('useCard|foe|before') >= 0);
    return !!row && row.hooks.indexOf('roll|self|before') >= 0 && row.hooks.indexOf('roll|foe|before') >= 0 && /出牌阶段/.test(row.name);
  })());
  check('TIMING_GRID 里没有"钩子重复挂两行"的',
    (function () {
      const seen = new Set();
      for (const g of M.meta().timingGrid) for (const h of g.hooks) { if (seen.has(h)) return false; seen.add(h); }
      return true;
    })());
  // ⭐ 2026-10-05：用户拍板"不合并那 6 格（对战结束/受伤/濒危/装备/放置/投骰前后），只按三组收拢"
  check('阶段表分三组：主要阶段 / 次要阶段 / 独立时点', (function () {
    const gs = M.meta().timingGroups.map((g) => g.label).join('/');
    return gs === '主要阶段/次要阶段/独立时点';
  })(), JSON.stringify((M.meta().timingGroups || []).map((g) => g.label)));
  check('18 行每行都归了组，且三组行数 = 7 / 7 / 4', (function () {
    const grid = M.meta().timingGrid;
    const cnt = {};
    for (const r of grid) {
      if (!r.group) return false;
      cnt[r.group] = (cnt[r.group] || 0) + 1;
    }
    return cnt.main === 7 && cnt.sub === 7 && cnt.indep === 4 && Object.keys(cnt).length === 3;
  })(), JSON.stringify(M.meta().timingGrid.reduce((a, r) => { a[r.group] = (a[r.group] || 0) + 1; return a; }, {})));
  check('那 6 格**原样保留**（用户 2026-10-05 裁定：现池有卡在用，不合并）', (function () {
    const names = M.meta().timingGrid.map((g) => g.name);
    return ['对战结束', '受伤', '生命值濒危', '装备宝物牌', '放置同行者',
      '先攻出牌阶段 ／ 后攻出牌阶段', '先攻投掷骰子阶段 ／ 后攻投掷骰子阶段']
      .every((n) => names.indexOf(n) >= 0);
  })(), JSON.stringify(M.meta().timingGrid.map((g) => g.name)));
  check('stageGroups 覆盖 TIMING_NAMES 里出现的每一个"图上一格"', (function () {
    const g = M.meta().stageGroups;
    const stages = new Set(Object.keys(M.TIMING_NAMES).map((k) => M.TIMING_NAMES[k].stage));
    for (const s of stages) if (!g[s]) return false;
    return true;
  })(), JSON.stringify(M.meta().stageGroups));
  // ⚠️ **先攻 / 后攻只在运行时存在**：同一格（roll·我方·前）在先攻手里叫「先攻出牌阶段」、
  //    在后攻手里叫「后攻出牌阶段」—— 数据里分不出来，只有引擎知道谁先攻（见 timingLabelIn）
  check('运行时名字：先攻投骰前 = 先攻出牌阶段',
    M.timingLabelIn({ event: 'roll', subject: 'self', phase: 'before' }, { attacker: true }) === '先攻出牌阶段',
    M.timingLabelIn({ event: 'roll', subject: 'self', phase: 'before' }, { attacker: true }));
  check('运行时名字：后攻投骰前 = 后攻出牌阶段',
    M.timingLabelIn({ event: 'roll', subject: 'self', phase: 'before' }, { attacker: false }) === '后攻出牌阶段',
    M.timingLabelIn({ event: 'roll', subject: 'self', phase: 'before' }, { attacker: false }));
  check('运行时名字：先攻/后攻投骰后',
    M.timingLabelIn({ event: 'roll', phase: 'after' }, { attacker: true }) === '先攻投掷骰子阶段'
    && M.timingLabelIn({ event: 'roll', phase: 'after' }, { attacker: false }) === '后攻投掷骰子阶段');
  check('不知道谁是先攻时退回卡面中性名（对战阶段 · 我方投骰前）',
    M.timingLabelIn({ event: 'roll', subject: 'self', phase: 'before' }, {}) === '对战阶段 · 我方投骰前',
    M.timingLabelIn({ event: 'roll', subject: 'self', phase: 'before' }, {}));
  // 前端靠 /api/meta 的 timingNames 取名，别再自己拼
  check('/api/meta 下发了 timingNames 表（前端不自己拼中文）',
    !!M.meta().timingNames && Object.keys(M.meta().timingNames).length >= 20,
    String(Object.keys((M.meta() || {}).timingNames || {}).length));
  check('名字表按阶段图分组（stage 字段齐全）', (function () {
    const t = M.meta().timingNames;
    return ['开始阶段', '探索阶段', '抉择阶段', '出牌阶段', '结束阶段', '闭关阶段', '晋升阶段', '对战阶段', '独立']
      .every((s) => Object.keys(t).some((k) => t[k].stage === s));
  })());

  // 图上那些"新补的"时点必须真的在表里
  for (const ev of ['turnStart', 'manaRegen', 'drawQi', 'drawTreasure', 'drawSpell',
    'promote', 'useCard', 'combatDeclare', 'chooseTarget', 'roll',
    'combatResult', 'combatEnd', 'turnEnd', 'hurt', 'lowHp', 'seclusion']) {
    check(`总线里有事件 ${ev}`, !!M.EVENTS[ev]);
  }
  check('promote 声明了「前/后」', M.EVENTS.promote.phases.join('/') === 'before/after');
  check('useCard 声明了「前/后」', M.EVENTS.useCard.phases.join('/') === 'before/after');
}

// ---------------------------------------------------------------- 造局
function setup(seed) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
   // 测试直接造局，不走真实回合流程 —— 这里标记"两边的第一个回合都已经过去"（新规则：第一个回合不能发起对战）
      for (const q of st.players) q.turnsTaken = 2;
  const A = st.players[0], B = st.players[1];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  A.mana = 12; B.mana = 12;
  A.hand = []; B.hand = [];
  A.equip = []; B.equip = []; A.companions = []; B.companions = []; A.spells = []; B.spells = [];
  return { st: st, A: A, B: B };
}
const cardOf = (deck, name) => C.cards()[deck].find((c) => c.name === name);

// ---------------------------------------------------------------- ③c 开战窗口「三合一」
console.log('\n[③c] 开战只问一次：combatDeclare + combatOpt 合成「对战阶段」一个窗口');
{
  const { st, A, B } = setup(8010);
  // 甲（攻方）：场上【温天仁】（combatOpt = 可选发动） + 手里【阴魂丝】（combatDeclare，但主体规则要求"我是被指定者"）
  A.companions = [{ uid: 7001, id: cardOf('companion', '温天仁').id }];
  A.hand = [{ uid: 7002, id: cardOf('treasure', '阴魂丝').id }];
  // 乙（被指定为目标）：手里【风灵劲】（combatDeclare）
  B.hand = [{ uid: 7003, id: cardOf('spell', '风灵劲').id }];
  const r = E.act(st, A.id, { type: 'combat', target: B.id });
  check('开战挂起（只挂一个窗口）', r.ok && r.paused === true && !!st.pending, JSON.stringify(r));
  check('窗口事件 = 先手的 combatDeclare（合并窗口就是它）',
    st.pending && st.pending.event === 'combatDeclare', st.pending && st.pending.event);
  check('窗口的 specs 里同时带着 combatDeclare 与 combatOpt',
    !!(st.pending && st.pending.ctx && Array.isArray(st.pending.ctx.specs)
      && st.pending.ctx.specs.map((x) => x.event).join('+') === 'combatDeclare+combatOpt'),
    JSON.stringify(st.pending && st.pending.ctx && st.pending.ctx.specs));
  check('窗口名字就是「对战阶段」',
    E.publicState(st, A.id).pending.label === '对战阶段',
    E.publicState(st, A.id).pending && E.publicState(st, A.id).pending.label);
  // 轮到甲（回合玩家优先）：他能看到自己的【温天仁】（combatOpt），**看不到**需要"被指定为目标"的【阴魂丝】
  const mineA = E.pendingCards(st, A).map((x) => x.name);
  check('甲看得到【温天仁】（可选发动类）', mineA.indexOf('温天仁') >= 0, JSON.stringify(mineA));
  check('甲看不到需要"被指定为目标"的【阴魂丝】（主体规则不串台，否则攻方能自封）',
    mineA.indexOf('阴魂丝') < 0, JSON.stringify(mineA));
  // 放弃给乙 → 乙能看到【风灵劲】
  E.act(st, A.id, { type: 'respond_pass' });
  const mineB = E.pendingCards(st, B).map((x) => x.name);
  check('乙（被指定为目标的人）看得到【风灵劲】', mineB.indexOf('风灵劲') >= 0, JSON.stringify(mineB));
  // 清场：窗口结算后应**不再有第二个开战窗口**（旧版这里还会再问一次 combatOpt）
  let guard = 0;
  while (st.pending && guard++ < 10) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); }
  check('结算完不再补开第二个窗口（旧版 = 二次弹窗）', !st.pending, st.pending && st.pending.event);
  check('对战可以继续（stage=pre，等攻方掷骰）', !!st.combat && st.combat.stage === 'pre', st.combat && st.combat.stage);
}

// ---------------------------------------------------------------- ② 零响应直通
console.log('\n[②] 零响应直通：没人在意时不碰任何东西');
{
  const { st, A, B } = setup(8001);
  const before = JSON.stringify({ hp: A.hp, mana: A.mana, hand: A.hand.length, turn: st.turn, step: st.step });
  const r = E.fireTiming(st, 'turnEnd', null, { subjectId: A.id, subject: 'self' });
  check('返回 opened=false', r.opened === false, JSON.stringify(r));
  check('responders 为空', r.responders.length === 0);
  check('没有写 timingLog', !st.timingLog || st.timingLog.length === 0, JSON.stringify(st.timingLog));
  const after = JSON.stringify({ hp: A.hp, mana: A.mana, hand: A.hand.length, turn: st.turn, step: st.step });
  check('局面状态一点没动', before === after, `${before} vs ${after}`);
  check('对战区仍是空的', !st.combat);
  check('【乙】也没被碰到', B.hp === 6 && B.mana === 12);
}

// ---------------------------------------------------------------- ③ 主体对称（逐效果判主体）
console.log('\n[③] 主体是**逐效果**判的：卡主必须站对角色');
{
  const HANBING = cardOf('treasure', '寒冰珠');    // when: beforeFoeRoll → roll·对方·前（响应别人的投骰）
  // 「我方投骰前」用【青火雷】——它的 when 是 combatStart（对战出牌阶段 = 投骰前），主体是自己。
  // （【黑血刀】那种低境界装备的"投骰前"已经改成常驻修正 standing，由"对战启用费"询问决定用不用，
  //   不再走投骰窗口。）
  const QINGHUO = cardOf('treasure', '青火雷');
  const { st, A, B } = setup(8002);
  A.hand.push({ uid: 5001, id: HANBING.id });
  B.hand.push({ uid: 5002, id: QINGHUO.id });
  // 开一场对战：甲攻、乙守，谁都没投骰
  const r = E.act(st, A.id, { type: 'combat', target: B.id });
  check('对战开起来了（若开了打断窗口先放弃掉）', (function () {
    while (st.pending) { const who = E.pendingActor(st); E.act(st, who.id, { type: 'respond_pass' }); }
    return !!st.combat && st.combat.stage === 'pre';
  })(), JSON.stringify(r));
  const c = st.combat;

  // 场景一：「乙要投骰了」→ 主体=乙、对家=甲
  //   · 甲的【寒冰珠】声明 subject:'foe'（卡主必须是对家=甲）✓ 命中
  //   · 乙的【青火雷】声明 subject:'self'（卡主必须是主体=乙）✓ 也命中
  //   两个都该被找到 —— 它们响应的是同一件事（乙投骰），只是立场不同。
  const w = E.timingResponders(st, 'roll', 'before', { subjectId: B.id, counterId: A.id, combat: c });
  const names = w.map((x) => x.pl.id + x.def.name);
  check('「乙投骰前·对方立场」找到甲手里的【寒冰珠】', names.indexOf('a寒冰珠') >= 0, JSON.stringify(names));
  check('「乙投骰前·我方立场」找到乙手里的【青火雷】', names.indexOf('b青火雷') >= 0, JSON.stringify(names));
  skip('甲不是"主体"，所以甲手里的【青火雷】类（我方投骰前）不会被算进来（甲手里没有）');

  // 场景二：主体=乙、对家=甲，但把【青火雷】换到甲手里 —— 甲既不是主体也不该以"我方"身份响应
  A.hand.push({ uid: 5003, id: QINGHUO.id });
  const w2 = E.timingResponders(st, 'roll', 'before', { subjectId: B.id, counterId: A.id, combat: c });
  const qhOwners = w2.filter((x) => x.def.name === '青火雷').map((x) => x.pl.id);
  check('甲手里的【青火雷】不会以"我方投骰前"身份被算进来（甲不是主体）',
    qhOwners.indexOf('a') < 0, JSON.stringify(qhOwners));

  // 投骰之后「前」窗口关闭
  // 注意：`roll` 现在是打断事件 —— 点掷骰会先开「投骰·前」窗口，要把它放弃掉骰子才真的投出去
  while (st.pending) { const who = E.pendingActor(st); E.act(st, who.id, { type: 'respond_pass' }); }
  E.act(st, A.id, { type: 'roll' });
  while (st.pending) { const who = E.pendingActor(st); E.act(st, who.id, { type: 'respond_pass' }); }
  const afterRoll = E.timingResponders(st, 'roll', 'before',
    { subjectId: A.id, counterId: B.id, combat: st.combat });
  check('甲投骰后，甲手里那张「我方投骰前」不再算作响应者',
    !afterRoll.some((x) => x.def.name === '青火雷' && x.pl.id === 'a' && x.where === 'hand'),
    JSON.stringify(afterRoll.map((x) => x.pl.id + x.def.name)));
  void afterRoll;
}

// 「对方投骰前」有响应者时会留下记录（但**不改变结算流程**）
console.log('\n[③b] 有响应者 → opened=true 并留痕；流程照旧');
{
  const HANBING = cardOf('treasure', '寒冰珠');
  const { st, A, B } = setup(8005);
  A.hand.push({ uid: 5301, id: HANBING.id });
  E.act(st, A.id, { type: 'combat', target: B.id });
  // 开战本身可能已经开了窗口（combatDeclare/combatOpt）——先清掉，再单独验证 fireTiming 的留痕
  while (st.pending) { const who = E.pendingActor(st); E.act(st, who.id, { type: 'respond_pass' }); }
  st.timingLog = [];
  const opened = E.fireTiming(st, 'roll', 'before',
    { subjectId: B.id, counterId: A.id, combat: st.combat });
  check('opened=true（有人能响应）', opened.opened === true, JSON.stringify(opened));
  check('响应者是甲（持牌方）', opened.responders.every((x) => x.pl.id === 'a'), JSON.stringify(opened.responders.map((x) => x.pl.id)));
  // ⚠️ roll 现在是**打断事件**（会挂起等表态），所以走的是 pending 而不是 timingLog ——
  //    这里验证它确实挂起了，并且响应者是甲。
  check('挂起了投骰·前时点询问', !!st.pending && st.pending.event === 'roll' && st.pending.phase === 'before',
    JSON.stringify(st.pending && [st.pending.event, st.pending.phase]));
  check('候选里记着拿的是【寒冰珠】',
    E.pendingCards(st, A).some((c) => c.name === '寒冰珠'),
    JSON.stringify(E.pendingCards(st, A)));
  // 弹窗标题用**运行时**名字：这一格是"乙（防守方）要投骰"，甲是响应者 → 应显示「后攻出牌阶段」。
  // （数据里只有 `roll·对方·前` 这种卡主视角的坐标，分不出先攻/后攻 —— 只有引擎知道谁先攻）
  check('弹窗标题用运行时名（防守方投骰 → 后攻出牌阶段）',
    E.publicState(st, A.id).pending && E.publicState(st, A.id).pending.label === '后攻出牌阶段',
    JSON.stringify(E.publicState(st, A.id).pending && E.publicState(st, A.id).pending.label));
  // 文案（2026-10-02 改名）：这条留痕的标签现在是〔斗法〕
  check('战报里留了一行〔斗法〕', st.log.some((l) => l.text.indexOf('〔斗法〕') === 0), '');
  check('【寒冰珠】还在手里（没有替玩家自动打出去）', A.hand.some((c) => c.id === HANBING.id));
  while (st.pending) { const who = E.pendingActor(st); E.act(st, who.id, { type: 'respond_pass' }); }
}

// ---------------------------------------------------------------- ④ 非时点不该被当响应者
console.log('\n[④] passive / activate / 自动触发 永远不是时点响应者');
{
  const XIN = cardOf('companion', '辛如音');      // when: promote, op: promote_discount（常驻折扣）
  const QINGYI = cardOf('companion', '青易居士'); // op: explore_swap（探索时点 · 替换型，2026-10-05 阶段事务）
  const { st, A } = setup(8003);
  A.companions.push({ uid: 5101, id: XIN.id });
  A.companions.push({ uid: 5102, id: QINGYI.id });
  const r = E.timingResponders(st, 'promote', 'after', { subjectId: A.id, subject: 'self' });
  // 【辛如音】的折扣是**自动**结算的（promoteConsumeDiscount 直接读 passives()），
  // 不该被摆出来问一遍 —— 免费/触发型的场上效果一律不进锁链询问。
  check('【辛如音】的晋升折扣**不会**被当成时点询问（自动结算）',
    !r.some((x) => x.def.name === '辛如音'),
    JSON.stringify(r.map((x) => x.def.name)));
  // 【青易居士】现在挂在「探索阶段」时点（卡文带「可选择」= 主动发动进询问），
  // 但只该出现在探索时点 —— 晋升 / 回合开始这些不相干的时点不能有它。
  check('【青易居士】(explore_swap) 挂在探索时点、不出现在晋升/回合开始',
    !r.some((x) => x.def.name === '青易居士') &&
    E.timingResponders(st, 'turnStart', null, { subjectId: A.id, subject: 'self' }).every((x) => x.def.name !== '青易居士') &&
    E.timingResponders(st, 'drawTreasure', null, { subjectId: A.id, subject: 'self' }).some((x) => x.def.name === '青易居士'),
    JSON.stringify(E.timingResponders(st, 'drawTreasure', null, { subjectId: A.id, subject: 'self' }).map((x) => x.def.name)));
}

// ---------------------------------------------------------------- ⑤ 新增时点确实会被走到
console.log('\n[⑤] 新增的流程时点真的被流程走到了（看 timingFired 计数）');
{
  const { st, A, B } = setup(8004);
  // 走一整个回合：抽灵气 → 抽宝物 → 选择抽 → 结束回合
  st.step = 'draw_qi';
  check('抽灵气', E.act(st, A.id, { type: 'draw_qi' }).ok, '');
  check('抽宝物', E.act(st, A.id, { type: 'draw_treasure' }).ok, '');
  check('选择抽', E.act(st, A.id, { type: 'choose_draw', deck: 'spell' }).ok, '');
  E.act(st, A.id, { type: 'end_turn' });
  const f = st.timingFired || {};
  console.log('    timingFired = ' + JSON.stringify(f));
  check('灵气抽取时点被走到', f.drawQi >= 1, JSON.stringify(f));
  check('宝物抽取时点被走到', f.drawTreasure >= 1, JSON.stringify(f));
  check('法术/同行者抽取时点被走到', f.drawSpell >= 1, JSON.stringify(f));
  check('回合结束 时点被走到', f.turnEnd >= 1, JSON.stringify(f));
  check('回合开始 时点被走到（乙的回合开始了）', f.manaRegen >= 1, JSON.stringify(f));
  // 再走一场对战，看「对战宣告 / 选择目标」（乙的回合，直接跳到行动阶段）
  st.step = 'action';
  E.act(st, B.id, { type: 'combat', target: A.id });
  const f2 = st.timingFired || {};
  check('对战宣告 时点被走到', f2.combatDeclare >= 1, JSON.stringify(f2));
  check('战斗选择目标 时点被走到', f2.chooseTarget >= 1, JSON.stringify(f2));
  check('场上没挂这些时点的牌 → 一次都没开窗（= 行为与旧版一致）',
    !st.timingLog || st.timingLog.length === 0, JSON.stringify(st.timingLog || []));
}

// ---------------------------------------------------------------- ⑥ combatStart 瘦身（第 5 步）
console.log('\n[⑥] 常驻对战修正搬去 standing，不再占用 combatStart 这个时点');
{
  const STANDING = ['啼魂', '寒蛟', '六翼', '紫灵', '王蝉', '蛮胡子'];   // 用前缀，避开生僻字打错
  const namer = (n) => {
    for (const d of ['treasure', 'spell', 'companion', 'qi']) {
      const x = (C.cards()[d] || []).find((y) => y.name === n || y.name.indexOf(n) === 0);
      if (x) return x;
    }
    return null;
  };
  for (const n of STANDING) {
    const c = namer(n);
    if (!c) { check(`卡池里有【${n}】`, false); continue; }
    const stand = (c.effects || []).filter((e) => e.when === 'standing');
    // ⚠️ 「不再挂在 combatStart 上」这句要按**归一化时机键**判：卡池 2026-10-02 迁到总线坐标后，
    //    数据里已经没有 `when:'combatStart'` 这个字符串了（它 = `roll:before`）——
    //    继续比原字符串会变成"永远成立"的空断言。
    const cs = (c.effects || []).filter((e) => M.timingKeys(e).indexOf('roll:before') >= 0);
    check(`【${n}】的对战修正已标为 standing`, stand.length > 0, JSON.stringify(c.effects));
    check(`【${n}】不再占「投骰前」(roll:before) 这个时点`, cs.length === 0, JSON.stringify(cs));
  }
  check('standing 不被当成时点（映射到 event:null）', M.WHEN_TIMING.standing.event === null);
  check('standing 不是出牌窗口', !M.PLAY_WINDOWS.includes('standing'), M.PLAY_WINDOWS.join(','));
  check('COMBAT_BONUS_WHENS 里含 standing', M.COMBAT_BONUS_WHENS.indexOf('standing') >= 0, M.COMBAT_BONUS_WHENS.join(','));

  // 功能验证：常驻加成照样算得出来
  const { st, A } = setup(8006);
  const TIHUN = namer('啼魂'), ZILING = namer('紫灵'), MANHUZI = namer('蛮胡子');
  A.companions = [{ uid: 9001, id: TIHUN.id }, { uid: 9002, id: MANHUZI.id }];
  A.hp = 6;                                   // 蛮胡子：hp>=4 时 +1
  const cb = E.companionCombat(st, A, st.combat);
  // ⚠️ 2026-10-04 按实物卡面改：【蛮胡子】≥4 血那一条是「**骰子点数**+1」（不是战力+1）。
  //    所以常驻汇总变成 战力+1（啼魂）+ 骰点+1（蛮胡子）——合计仍是 +2，只是分在两个桶里。
  check('【啼魂】+【蛮胡子】的常驻加成合计仍是 +2（战力 1 + 骰点 1）',
    (cb.bonus || 0) + (cb.diceBonus || 0) === 2, JSON.stringify(cb));
  void ZILING;

  // 绿煌剑的 +0 噪音已删；2026-10-06 起它的 3 点费用**印在效果上**（不再有开战启用费）
  const LU = namer('绿煌剑');
  check('【绿煌剑】不再有 combat_bonus 噪音条目',
    !(LU.effects || []).some((e) => e.op === 'combat_bonus'), JSON.stringify(LU.effects));
  check('【绿煌剑】仍被认作对战相关（效果落在"获胜时"）',
    (LU.effects || []).some((e) => { const t = M.timingOfEffect(e); return t && t.event === 'combatResult'; }),
    JSON.stringify(LU.effects));
  check('【绿煌剑】不再有 `enable_equip_combat`（开战统一启用已废），费用改成效果级 manaCost',
    !(LU.effects || []).some((e) => e.op === 'enable_equip_combat')
    && (LU.effects || []).some((e) => (e.manaCost || 0) === (LU.cost || 0)),
    JSON.stringify(LU.effects));

  // 「投骰前」(roll:before) 的牌（同样按归一化键统计）
  // ⚠️ 2026-10-06 起**不再设张数上限**：那个上限是"清理噪音时点"那一轮的临时产物，
  //    而这一轮把 7 张装备从"开战统一启用（combatOpt + 之后常驻）"迁回**它们卡文自己的时点**
  //    （【黑血刀】【青竹蜂云剑】【辟邪剑雷】【金蚨子母刃】【七鬼珠】的卡文就是"投掷骰子前/出牌阶段使用"），
  //    名单本来就该变长。改成真不变量：**挂在「投骰前」的效果必须是时点窗口效果**
  //    —— 不是常驻(standing)/自动(auto)，那正是这一轮修的病。
  const still = [];
  const notWindow = [];
  for (const d of ['treasure', 'spell', 'companion', 'qi']) {
    for (const c of C.cards()[d] || []) {
      const effs = (c.effects || []).concat((c.tiers || []).reduce((a, t) => a.concat(t.effects || []), []));
      const hit = effs.filter((e) => M.timingKeys(e).indexOf('roll:before') >= 0);
      if (!hit.length) continue;
      still.push(c.name);
      for (const e of hit) if (e.when === 'standing' || e.auto === true) notWindow.push(c.name + '/' + e.op);
    }
  }
  check('挂在「投骰前」的效果都是**时点窗口**效果（不是常驻/自动 —— 那正是这轮修的病）',
    notWindow.length === 0, notWindow.join('、'));
  console.log('    仍挂在「投骰前」(roll:before): ' + still.join('、'));
}

// ---------------------------------------------------------------- ⑦ 客户端时点标签不会渲染 undefined
// 前端 app.js 的 timingText() 就是从 /api/meta 这张表取标签的：event → EVENTS[].label、
// when → WHEN[].label、engineDirect op → 专属文案，三条都落空才退到"特定时机"。
// 旧版【绿煌剑】这类只写 event 的卡会渲染成 "undefined"，所以这里对**全池每一条效果**验一遍。
console.log('\n[⑦] 每条效果都能解析出时点标签（客户端不会渲染 undefined）');
{
  const PHASE = { before: '前', after: '后', win: '获胜', tie: '平局', lose: '失败' };
  // 与 app.js timingText() 同构的解析（含 timingNames 查表层 —— 旧 replica 漏了它，
  // 「探索阶段」这类查表名会被拼成「宝物抽取 · 我方」，2026-10-05 逮到）
  function labelOf(e) {
    if (e.event) {
      const table = (M.meta ? M.meta().timingNames : M.TIMING_NAMES) || {};
      const ev0 = M.EVENTS[e.event];
      const sub = e.subject || (ev0 && ev0.subject === 'both' ? 'self' : '');
      const ph = e.phase || '';
      const keys = [e.event + '|' + sub + '|' + ph, e.event + '|' + sub, e.event + '|' + ph, e.event];
      for (const k of keys) { const hit = table[k]; if (hit && hit.name) return hit.name; }
      const ev = (M.meta ? M.meta().events : M.EVENTS) || {};
      const evx = ev[e.event] || M.EVENTS[e.event];
      if (!(evx && evx.label)) return null;
      let s = evx.label;
      if (e.subject === 'foe') s += ' · 对方';
      else if (e.subject === 'self' && evx.subject === 'both') s += ' · 我方';
      if (e.phase) s += ' · ' + (PHASE[e.phase] || e.phase);
      return s;
    }
    if (e.when) {
      const w = M.WHEN[e.when];
      return w && w.label ? w.label : null;
    }
    // （engineDirect 专属文案已废，2026-10-05：全池效果都带时点，上面 event/when 分支必中）
    return null;
  }
  const all = [];
  for (const d of ['treasure', 'spell', 'companion', 'qi']) {
    for (const c of C.cards()[d] || []) {
      for (const e of (c.effects || [])) all.push({ card: c.name, e: e });
      for (const t of (c.tiers || [])) for (const e of (t.effects || [])) all.push({ card: c.name + '（档位）', e: e });
    }
  }
  const bad = all.filter((x) => !labelOf(x.e));
  check(`全池 ${all.length} 条效果全部有中文时点标签`, bad.length === 0,
    bad.slice(0, 5).map((b) => `${b.card}:${b.e.op || b.e.when || b.e.event}`).join('、'));

  const wu = C.cards().treasure.find((c) => c.name === '绿煌剑');
  const winEff = (wu.effects || []).find((e) => M.timingOfEffect(e) && M.timingOfEffect(e).event === 'combatResult');
  check('【绿煌剑】获胜时效果标签可解析（旧版渲染 undefined 的那张）', !!winEff && !!labelOf(winEff),
    JSON.stringify(winEff));
  const qy = C.cards().companion.find((c) => c.name === '青易居士');
  const exEff = (qy.effects || []).find((e) => e.op === 'explore_swap');
  check('【青易居士】explore_swap 标签可解析（挂探索时点 → 探索阶段）', !!exEff && !!labelOf(exEff),
    JSON.stringify(qy.effects));
  check('【青易居士】标签文案点明"探索阶段"', /探索阶段/.test(String(labelOf(exEff))),
    String(labelOf(exEff)));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
