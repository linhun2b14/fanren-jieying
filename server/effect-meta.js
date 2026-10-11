'use strict';
/**
 * 卡牌效果元数据 —— 唯一来源（single source of truth）。
 *
 * 以前这些信息散在 4 个地方，靠人记得同步，漏一次就出 bug：
 *   ① engine.js 的 COMBAT_KINDS / TIE_KINDS / NEEDS_TARGET 三个 Set
 *   ② public/app.js 里 60 条 KIND_TXT 中文词典
 *   ③ engine.js resolveEffect 的 case 列表
 *   ④ docs/规则文档.md 的 kind 词表
 * 现在全部从本文件派生：引擎读它、前端经 /api/meta 读它、lint 工具读它、文档由它生成。
 *
 * 零依赖，前后端都能 require/内联。
 */

// ---------------------------------------------------------------- 时点总线（事件 + 主体 + 阶段）
//
// 用户给的模型：一回合是一条**流程主线**（回合开始 → 法力恢复 → 抽灵气/宝物/法术同行者 →
// 晋升 → 使用卡牌 → 宣布对战/被指定为目标 → 选目标 → 投骰 → 胜/平/负 → 回合结束），
// 外加两条**随时可能插进来的独立事件**（受伤、闭关）。
//
// 每个时点 = 事件 + 主体(我方/对方) + 阶段(前/后)。
//   例：「对方投骰前」= 事件`roll`、主体`foe`、阶段`before` —— 我作为旁观者响应
//       「被指定为对战目标」= 事件`combatDeclare`、主体`self`（我是受害者）
//
// 这一层是**权威表**：引擎靠它判断"此刻该不该开时点"，前端靠它出文案，工具靠它做完整性检查。
// 旧的 18 个 `when` 不删，通过 WHEN_TIMING 映射到总线（见下），所以卡牌数据不用改。
//
// subject 的取值：
//   'both' —— 事件对双方都可能发生（我方/对方各算一格）
//   'none' —— 事件本身不分主体（如"对战结果"：赢家看到 win、输家看到 lose，各自视角）
//
// interrupt 的取值：
//   true          —— 这个事件**所有**阶段都要开打断询问
//   ['before']    —— 只在列出的阶段开（`useCard` 只在前半开：那是"对方要出牌了，我要不要无效它"；
//                    后半「用完了」不该打断，否则每打一张牌都会停下来问一次）
//   缺省          —— 不开打断，只记录（零响应直通）
const EVENTS = {
  // ---- 主线：回合流程（一定有） ----
  turnStart:     { label: '回合开始',              subject: 'both', phases: [],                  order: 1 },
  manaRegen:     { label: '法力恢复',              subject: 'both', phases: [],                  order: 2 },
  drawQi:        { label: '灵气抽取',              subject: 'both', phases: [], selfOnly: true,  order: 3 },
  // 探索阶段接进询问层（2026-10-05 阶段事务模型：效果先收势、基础行动「抽 2 宝物」最后结算）。
  // 卡文带「可以」= 主动发动必须问（【御风诀】【掌天瓶】额外抽、【青易居士】改抽）。
  drawTreasure:  { label: '宝物抽取',              subject: 'both', phases: [], selfOnly: true,  order: 4, interrupt: true, window: 'optional' },
  drawSpell:     { label: '法术或同行者抽取',      subject: 'both', phases: [], selfOnly: true,  order: 5 },
  promote:       { label: '晋升',                  subject: 'both', phases: ['before', 'after'], order: 6, interrupt: ['before'], window: 'optional' },
  useCard:       { label: '卡牌使用',              subject: 'both', phases: ['before', 'after'], order: 7, interrupt: ['before'], window: 'response' },
  combatDeclare: { label: '对战宣告 / 被指定为目标', subject: 'both', phases: [],                 order: 8, interrupt: true, window: 'response' },
  chooseTarget:  { label: '战斗选择目标',          subject: 'both', phases: [],                  order: 9 },
  roll:          { label: '投骰',                  subject: 'both', phases: ['before', 'after'], order: 10, interrupt: ['before', 'after'], window: 'response' },
  combatPlay:    { label: '对战出牌阶段',          subject: 'both', phases: [],                  order: 11 },
  // 「对战出牌阶段」在总线上就是"投骰前"这一刻（谁都没投的时候）。
  // `combatStart` 现在映射到 roll·before，所以它能和 beforeMyRoll/beforeFoeRoll 进同一个窗口 ——
  // 这样投骰窗口可以做成一条链（原来 combatStart 单独占一个事件，两张牌永远碰不到面）。
  // 「对战中的**可选发动**」—— 与上面的"对战出牌阶段"分开：
  // 出牌阶段是玩家自己点手牌（`when:'combatStart'` 那些），这个是场上的牌问一句
  // "要不要花法力发动"（如【温天仁】"在对战中使用，消耗 3 点法力值"）。
  // 必须分开，否则两者会互相抢响应者：所有 combatStart 的手牌都会被当成"可选发动"的候选。
  combatOpt:     { label: '对战·可选发动',          subject: 'both', phases: [],                  order: 11, interrupt: true, window: 'response' },
  combatResult:  { label: '对战结果',              subject: 'none', phases: ['win', 'tie', 'lose'], order: 12, interrupt: true, window: 'response' },
  combatEnd:     { label: '对战结束',              subject: 'none', phases: [],                  order: 13 },
  turnEnd:       { label: '回合结束',              subject: 'both', phases: [],                  order: 14, interrupt: true, window: 'optional' },
  // ---- 独立事件（随时可能插入） ----
  hurt:          { label: '受伤',                  subject: 'both', phases: [],                  order: 20, interrupt: true, window: 'response' },
  lowHp:         { label: '生命值濒危',            subject: 'both', phases: [],                  order: 21, interrupt: true, window: 'optional' },
  seclusion:     { label: '闭关',                  subject: 'both', phases: [],                  order: 22, interrupt: true, window: 'optional' },
  equip:         { label: '装备宝物牌',            subject: 'both', phases: [],                  order: 23, interrupt: true, window: 'optional' },
  place:         { label: '放置同行者',            subject: 'both', phases: [],                  order: 24, interrupt: true, window: 'optional' },
};

/**
 * ⭐ 效果的**大类**（2026-10-05 用户拍板的三轴模型里的「轴 3」）：编辑器的蓝图视图按这个分组，
 *    普通表单视图也拿它当下拉里的分组标题。三轴的另外两轴是**轴 1 时机**（EVENTS/TIMING_GRID）与
 *    **轴 2 条件**（CONDITIONS）——「场上有X/已装备X/晋升时/受伤时」那些属于那两轴，**不是**效果大类。
 *
 * 用户给的 11 类：回合 / 手牌 / 生命 / 防御 / 法力 / 灵气 / 抽取 / 骰子 / 战力 / 封锁与无效 / 夺取·弃置对方的牌。
 * 我补 2 类（否则这几条效果没地方放）：「晋升」（减消耗/伪丹期/晋升抽牌）与「装备与场上」（启用费/获得法术牌/自身进弃牌堆/召唤傀儡）。
 * 没登记的 op 会落到「未分类」组里 —— 加了新 op 记得往这里补一行。
 */
const OP_GROUPS = [
  ['回合', ['skip_turn', 'skip_turns', 'turn_no_combat_mana', 'turn_no_combat_heal',
    'mana_regen_bonus', 'hand_limit_bonus', 'extra_seclusion']],
  ['手牌', ['steal_card', 'look_hand']],
  ['生命', ['heal', 'damage', 'damage_target', 'damage_multi', 'damage_all_others',
    'damage_and_skip', 'damage_attacker', 'self_damage_then_multi', 'damage_higher_realm']],
  ['防御', ['damage_reduction', 'damage_shield', 'damage_save_dice', 'self_revive', 'low_hp_rescue', 'puppet_absorb',
    'damage_cancel', 'damage_multiply']],
  ['法力', ['mana', 'overreach_dice_save', 'after_combat_mana', 'combat_bonus_win_mana']],
  ['灵气', ['qi', 'qi_and_mana']],
  ['晋升', ['promote_discount', 'promote_discount_once', 'pseudo_realm']],
  ['抽取', ['draw', 'draw_mixed', 'draw_treasure', 'draw_qi', 'on_promote_draw_qi',
    'win_draw_qi', 'place_draw_qi', 'explore_swap']],
  ['骰子', ['dice_bonus', 'dice_penalty', 'dice_skip_bonus', 'reroll', 'reroll_dice',
    'force_reroll_foe', 'after_consume_roll6', 'roll_branch']],
  ['战力', ['combat_bonus', 'combat_debuff', 'flat_power', 'cancel_attack', 'win_extra_damage',
    'risky_win_damage', 'lose_save_dice', 'lose_immunity', 'lose_retaliate', 'versus_realm_effect',
    'enable_equip_combat', 'combat_bonus_if_hp_le', 'combat_bonus_if_hp_ge',
    'combat_bonus_if_enemy_higher_realm', 'combat_bonus_if_companion']],
  ['封锁与无效', ['nullify_enemy_card', 'block_enemy_card_kind', 'block_draw',
    'block_spell_draw', 'block_companion_draw', 'block_treasure_draw', 'curse_target']],
  ['夺取·弃置对方的牌', ['steal_equip', 'discard_enemy_equip', 'win_steal_treasure']],
  ['装备与场上', ['grant_spell', 'self_discard', 'summon_puppet', 'double_card_effect']],
];
/** op → 大类（上面那张表反过来查；未登记的 op 归「未分类」） */
const OP_GROUP_NAMES = OP_GROUPS.map((g) => g[0]);
const OP_GROUP_OF = (function () {
  const m = {};
  for (const [name, list] of OP_GROUPS) for (const op of list) m[op] = name;
  return m;
})();

/**
 * 这个时点上的询问要不要「应对」（用户 2026-10-05 裁定：**只有带应对的卡/效果才能进【斗法】链**）。
 *
 * ⚠️ 关键：**只有「响应型」窗口要应对** —— 也就是"别人/环境引发的、我去破招"的那些：
 *     被指定为目标(combatDeclare)、对战可选发动(combatOpt)、对方出牌(useCard·前)、
 *     投骰前/后(roll)、对战结算(combatResult)、受伤(hurt)。
 *   「阶段内可选型」是**自己回合里的"可以"**（探索阶段替换、晋升减消耗、回合结束花法力回血、
 *     装备即结算、放置同行者、闭关、濒危自救）—— 那些不是破招，逼它们带应对会误伤
 *     【青易居士】【掌天瓶】【娑罗珠】【墨彩环】这类牌。所以那类窗口照旧不问应对。
 *   `auto: true`（自动收集）的效果本来就不进链，与应对无关。
 */
function needsResponse(event, phase) {
  const ev = EVENTS[event];
  if (!ev || !ev.interrupt) return false;
  const win = Array.isArray(ev.interrupt) ? ev.interrupt.indexOf(phase || null) >= 0 : true;
  if (!win) return false;
  return ev.window === 'response';
}

/** 旧的 `when` → 总线坐标。卡牌数据继续写 when，不用迁移。 */
const WHEN_TIMING = {
  turn:          { event: 'turnStart' },
  equip:         { event: 'equip' },
  place:         { event: 'place' },
  play:          { event: 'useCard',      phase: 'after' },
  combatStart:   { event: 'roll', subject: 'self', phase: 'before' },   // 「对战出牌阶段」= 投骰前
  beforeMyRoll:  { event: 'roll', subject: 'self', phase: 'before' },
  afterMyRoll:   { event: 'roll', subject: 'self', phase: 'after' },
  beforeFoeRoll: { event: 'roll', subject: 'foe',  phase: 'before' },
  afterFoeRoll:  { event: 'roll', subject: 'foe',  phase: 'after' },
  tie:           { event: 'combatResult', phase: 'tie' },
  win:           { event: 'combatResult', phase: 'win' },
  lose:          { event: 'combatResult', phase: 'lose' },
  afterCombat:   { event: 'combatEnd' },
  hurt:          { event: 'hurt' },
  lowHp:         { event: 'lowHp' },
  promote:       { event: 'promote',      phase: 'after' },
  passive:       { event: null },   // 非时点：常驻数值，只被 passives() 汇总
  standing:      { event: null },   // 非时点：常驻对战修正，由 companionCombat/activateCombatEquips 加总
  activate:      { event: null },   // 非时点：玩家点按钮发动
};

/** 该 when 的总线坐标（未知 when 返回 null）。主体缺省补 'self'（= 这张牌的主人）。 */
function timingOfWhen(when) {
  const t = WHEN_TIMING[when];
  if (!t || !t.event) return t || null;
  const ev = EVENTS[t.event];
  return {
    event: t.event,
    subject: t.subject || ((ev && ev.subject === 'both') ? 'self' : null),
    phase: t.phase || null,
  };
}
/** 阶段中文名 */
const PHASE_LABEL = { before: '前', after: '后', win: '获胜', tie: '平局', lose: '失败' };

// ---------------------------------------------------------------- ⭐ 阶段 / 时点中文名（唯一权威）
//
// 用户 2026-10-02 深夜给了**阶段设计图**，要求"时点按这个阶段插入、名字按新阶段命名"。
// 以前中文名是 `timingLabel()` 现场拼的（事件 · 主体 · 阶段），拼出来是引擎腔
// （「卡牌使用 · 我方 · 后」「投骰 · 我方 · 前」「对战结果 · 获胜」），跟阶段图对不上。
// 现在改成**每个坐标一个名字**：图上的格子叫什么，卡面/弹窗/文档/编辑器就叫什么。
//
// 阶段图（主要阶段 → 次要阶段）：
//   主要阶段：开始阶段 → 探索阶段 → 抉择阶段 → 出牌阶段 → 结束阶段
//   次要阶段：闭关阶段（①~③ 内可宣布）· 晋升阶段（④ 内一次）· 对战阶段（④ 内一次，6 个子阶段）
//   对战阶段 = 先攻选择目标阶段 → 先攻出牌阶段 → 先攻投掷骰子阶段 → 后攻出牌阶段
//              → 后攻投掷骰子阶段 → 对战结算阶段（后 5 格合称「对战时」）
//
// 键格式：`事件` / `事件|主体` / `事件|主体|阶段`（查表时从最具体到最粗依次回退）。
//
// ⚠️ **先攻 / 后攻只在"运行时"存在**：数据里的主体是**卡主视角**（我方 / 对方）——
//    同一个坐标（`roll`·我方·前）在**先攻**手里叫「先攻出牌阶段」、在**后攻**手里叫「后攻出牌阶段」。
//    所以：**卡面/编辑器**用中性名（对战阶段 · 我方投骰前），**斗法弹窗与战报**用运行时名（`timingLabelIn()`）。
const TIMING_NAMES = {
  // —— 主要阶段 ——
  turnStart:              { stage: '开始阶段', name: '开始阶段' },
  'manaRegen|self':       { stage: '开始阶段', name: '开始阶段 · 法力恢复' },
  'drawQi|self':          { stage: '开始阶段', name: '开始阶段 · 炼化灵气' },
  'drawTreasure|self':    { stage: '探索阶段', name: '探索阶段' },
  'drawSpell|self':       { stage: '抉择阶段', name: '抉择阶段' },
  // ⚠️「对方出牌时」原先单独占一行（还一度挂在④出牌阶段）—— 用户 2026-10-02 深夜三指出：
  //    **它就是"对战里的出牌阶段"**（谁在出牌阶段出牌，对家都能拦），不该自成一行；
  //    先攻/后攻本来就由"谁的回合发起的对战"决定。所以它并进 TIMING_GRID 的"出牌阶段"那一行，
  //    卡面上的中性名写成「对战阶段 · 对方出牌阶段」。
  'useCard|foe|before':   { stage: '对战阶段', name: '对战阶段 · 对方出牌阶段' },
  'useCard|self|after':   { stage: '出牌阶段', name: '出牌阶段' },
  'turnEnd|self':         { stage: '结束阶段', name: '结束阶段' },
  // —— 次要阶段：闭关 ——
  'seclusion|self':       { stage: '闭关阶段', name: '闭关阶段' },
  // —— 次要阶段：晋升（**前/后合并成一个时点**，用户 2026-10-02 深夜二裁定）——
  'promote|self|before':  { stage: '晋升阶段', name: '晋升阶段' },
  'promote|self|after':   { stage: '晋升阶段', name: '晋升阶段' },
  // —— 次要阶段：对战 ——
  // 【三合一】用户裁定：`combatDeclare`（被指定为目标）+ `combatOpt`（可选发动/付费启用）+ `chooseTarget`（先攻选择目标）
  //   其实是**同一个时点**（开战那一刻），玩家只该看到一个名字「对战阶段」；
  //   精确钩子留给编辑器/文档（编辑器下拉会显示 〔combatOpt · self〕 这类括号备注）。
  'combatDeclare|foe':    { stage: '对战阶段', name: '对战阶段' },
  'combatOpt|self':       { stage: '对战阶段', name: '对战阶段' },
  'chooseTarget|self':    { stage: '对战阶段', name: '对战阶段' },
  // 粗键兜底：主体写成哪个都还是"开战那一刻"这一个时点（查表从具体到粗依次回退）
  combatDeclare:          { stage: '对战阶段', name: '对战阶段' },
  combatOpt:              { stage: '对战阶段', name: '对战阶段' },
  chooseTarget:           { stage: '对战阶段', name: '对战阶段' },
  'roll|self|before':     { stage: '对战阶段', name: '对战阶段 · 我方投骰前' },
  'roll|self|after':      { stage: '对战阶段', name: '对战阶段 · 我方投骰后' },
  'roll|foe|before':      { stage: '对战阶段', name: '对战阶段 · 对方投骰前' },
  'roll|foe|after':       { stage: '对战阶段', name: '对战阶段 · 对方投骰后' },
  'combatResult|win':     { stage: '对战阶段', name: '对战结算阶段 · 获胜' },
  'combatResult|tie':     { stage: '对战阶段', name: '对战结算阶段 · 平局' },
  'combatResult|lose':    { stage: '对战阶段', name: '对战结算阶段 · 失败' },
  combatEnd:              { stage: '对战阶段', name: '对战结束' },
  // —— 独立时点（不占阶段，随时可能插进来）——
  'hurt|self':            { stage: '独立', name: '受伤' },
  'lowHp|self':           { stage: '独立', name: '生命值濒危' },
  'equip|self':           { stage: '独立', name: '装备宝物牌' },
  'place|self':           { stage: '独立', name: '放置同行者' },
};

/**
 * ⭐ **阶段表的三个分组**（用户 2026-10-05 拍板）。
 *
 * 那一轮讨论的是"再精简一次时点表"，列出的候选是合掉这 6 格：
 *   对战结束 / 受伤 / 濒危 / 装备 / 放置 / 投骰前·后。
 * **用户的决定：不合并** —— 这 6 格现池都有卡在用（【凌玉灵】/【遮天钟】【钟吾】【燕如嫣】【刘靖】【元瑶】/
 * 【还阳术】/【长春功】【玄阴诀】/【李化元】【铁火蚁】【血玉蜘蛛】【离龟】/【青火雷】【青元剑诀】【七鬼珠】），
 * 只在**显示层**按"主要阶段 / 次要阶段 / 独立时点"收拢成三组（文档 §2、编辑器时点下拉、报表都跟着分组）。
 * 所以：**18 行的物理行数不变、卡面文案不变、引擎坐标不变**，变的是"怎么看这张表"。
 */
const TIMING_GROUPS = [
  { id: 'main', label: '主要阶段', note: '当前回合玩家依次走完的一条直线：开始 → 探索 → 抉择 → 出牌 → 结束' },
  { id: 'sub', label: '次要阶段', note: '插在主要阶段里的：闭关（①~③ 内可宣布）· 晋升（④ 内一次）· 对战（④ 内一次，含 6 个子阶段）' },
  { id: 'indep', label: '独立时点', note: '不占阶段、随时可能插进来：受伤 · 生命值濒危 · 装备宝物牌 · 放置同行者' },
];

/** 图上那一格（`stage`）属于哪个分组 —— 编辑器/timingStageOf 都靠它归组 */
const STAGE_GROUP = {
  '开始阶段': 'main', '探索阶段': 'main', '抉择阶段': 'main', '出牌阶段': 'main', '结束阶段': 'main',
  '闭关阶段': 'sub', '晋升阶段': 'sub', '对战阶段': 'sub',
  '独立': 'indep',
};

/**
 * ⭐ **缩减后的时点总表**（用户 2026-10-02 深夜二："时点缩减，目前有重复时点"）。
 *
 * 一行 = **玩家看到的一个时点**（`name`），可以对应**多个引擎钩子**（`hooks`，键格式 `事件|主体|阶段`，
 * `*` 表示任意）。24 格 → **18 行**：
 *   · 【三合一】combatDeclare + combatOpt + chooseTarget → 一行「对战阶段」
 *   · 【并进对战出牌阶段】useCard·前（对方出牌时）→ 并入「先攻/后攻出牌阶段」那一行
 *     （用户 2026-10-02 深夜三："这不就是对战·子阶段出牌阶段嘛"）
 *   · 【前后合并】promote 前 + 后 → 一行「晋升阶段」
 *   · 【我方/对方合并】roll 的四格合并成两行（先攻/后攻是运行时视角，见 ROLL_RUNTIME）
 *
 * 2026-10-05：**再精简一次**只做到"按 TIMING_GROUPS 三组收拢"（用户拍板不合并那 6 格，见上面的注释）。
 *
 * 这张表同时驱动：`docs\时点规范.md` §2（`node tools\gen-timing-table.js` 生成表格行）、
 * `tools\list-timings.js`（对照报表）、编辑器的阶段分组（经 `/api/meta` 下发）。
 * ⚠️ 改这里 = 改玩家看到的东西，别在别处另写一份。
 */
const TIMING_GRID = [
  { group: 'main', stage: '① 开始阶段', name: '开始阶段', hooks: ['turnStart'], who: '当前玩家' },
  { group: 'main', stage: '① 开始阶段', name: '开始阶段 · 法力恢复', hooks: ['manaRegen|self'], who: '本人' },
  { group: 'main', stage: '① 开始阶段', name: '开始阶段 · 炼化灵气', hooks: ['drawQi|self'], who: '本人' },
  { group: 'main', stage: '② 探索阶段', name: '探索阶段', hooks: ['drawTreasure|self'], who: '本人' },
  { group: 'main', stage: '③ 抉择阶段', name: '抉择阶段', hooks: ['drawSpell|self'], who: '本人' },
  { group: 'main', stage: '④ 出牌阶段', name: '出牌阶段', hooks: ['useCard|self|after'], who: '全体（当前回合玩家优先）' },
  { group: 'main', stage: '⑤ 结束阶段', name: '结束阶段', hooks: ['turnEnd|self'], who: '当前玩家优先' },
  { group: 'sub', stage: '次要 · 闭关阶段', name: '闭关阶段', hooks: ['seclusion|self'], who: '本人' },
  { group: 'sub', stage: '次要 · 晋升阶段', name: '晋升阶段', hooks: ['promote|self|before', 'promote|self|after'], who: '当前玩家优先' },
  { group: 'sub', stage: '次要 · 对战阶段', name: '对战阶段', hooks: ['combatDeclare|foe', 'combatOpt|self', 'chooseTarget|self'], who: '双方 + 旁观' },
  { group: 'sub', stage: '对战 · 子阶段', name: '先攻出牌阶段 ／ 后攻出牌阶段', hooks: ['roll|self|before', 'roll|foe|before', 'useCard|foe|before'], who: '双方' },
  { group: 'sub', stage: '对战 · 子阶段', name: '先攻投掷骰子阶段 ／ 后攻投掷骰子阶段', hooks: ['roll|self|after', 'roll|foe|after'], who: '双方' },
  { group: 'sub', stage: '对战 · 结算', name: '对战结算阶段 · 获胜 ／ 平局 ／ 失败', hooks: ['combatResult|*'], who: '参与者' },
  { group: 'sub', stage: '对战 · 收尾', name: '对战结束', hooks: ['combatEnd'], who: '—' },
  { group: 'indep', stage: '独立', name: '受伤', hooks: ['hurt|self'], who: '受伤者优先' },
  { group: 'indep', stage: '独立', name: '生命值濒危', hooks: ['lowHp|self'], who: '本人' },
  { group: 'indep', stage: '独立', name: '装备宝物牌', hooks: ['equip|self'], who: '本人' },
  { group: 'indep', stage: '独立', name: '放置同行者', hooks: ['place|self'], who: '本人' },
];

/** 运行时（知道"投骰的人是不是先攻"）的对战子阶段名 —— 只有这两组需要先攻/后攻之分 */
const ROLL_RUNTIME = {
  before: { attacker: '先攻出牌阶段', defender: '后攻出牌阶段' },
  after: { attacker: '先攻投掷骰子阶段', defender: '后攻投掷骰子阶段' },
};

/** 坐标 → 表里的条目（从最具体到最粗回退）。非时点/查不到返回 null */
function timingMetaOf(t) {
  if (!t || !t.event) return null;
  const sub = t.subject || '';
  const ph = t.phase || '';
  const keys = [t.event + '|' + sub + '|' + ph, t.event + '|' + sub, t.event + '|' + ph, t.event];
  for (const k of keys) if (TIMING_NAMES[k]) return TIMING_NAMES[k];
  return null;
}
/** 坐标的中文名（卡面/编辑器用；查不到时退回旧的"事件 · 主体 · 阶段"拼法） */
function timingNameOf(t) {
  const m = timingMetaOf(t);
  if (m) return m.name;
  if (!t || !t.event) return '';
  const ev = EVENTS[t.event];
  const parts = [eventLabel(t.event)];
  if (ev && ev.subject === 'both' && t.subject) parts.push(t.subject === 'foe' ? '对方' : '我方');
  if (t.phase) parts.push(PHASE_LABEL[t.phase] || t.phase);
  return parts.join(' · ');
}
/** 坐标挂在阶段图的哪一格（主要阶段名 / 次要阶段名 / '独立'） */
function timingStageOf(t) {
  const m = timingMetaOf(t);
  return m ? m.stage : '';
}
/** `/api/meta` 下发给前端的名字表（前端不再自己拼中文） */
function timingNameTable() {
  const out = {};
  for (const k of Object.keys(TIMING_NAMES)) out[k] = TIMING_NAMES[k];
  return out;
}

/** 事件中文名 */
function eventLabel(e) { const x = EVENTS[e]; return (x && x.label) || e; }
/** 总线坐标 → 中文名（卡面用；如「对战结算阶段 · 获胜」）。见 TIMING_NAMES 的说明 */
function timingLabel(t) { return timingNameOf(t); }
/**
 * 总线坐标 → **运行时**中文名：投骰窗口按"这个人是不是先攻"说「先攻/后攻出牌阶段」。
 * ctx.attacker === true/false 表示"事件主体就是先攻 / 就是后攻"；不知道就退回卡面名。
 */
function timingLabelIn(t, ctx) {
  const isAtk = ctx && (ctx.attacker === true || ctx.attacker === false) ? ctx.attacker : null;
  if (t && t.event === 'roll' && isAtk !== null && ROLL_RUNTIME[t.phase]) {
    return isAtk ? ROLL_RUNTIME[t.phase].attacker : ROLL_RUNTIME[t.phase].defender;
  }
  return timingLabel(t);
}
/** 某张效果声明的总线坐标：优先认新写法 {event,subject,phase}，否则由 when 映射 */
function timingOfEffect(eff) {  if (!eff) return null;
  if (eff.event) {
    const ev = EVENTS[eff.event];
    return {
      event: eff.event,
      subject: eff.subject || ((ev && ev.subject === 'both') ? 'self' : null),
      phase: eff.phase || null,
    };
  }
  return timingOfWhen(eff.when);
}
/** 该事件是否"只给事件当事人自己"触发（抽牌类，对手不能插） */
function isSelfOnlyEvent(e) { return !!(EVENTS[e] && EVENTS[e].selfOnly); }

/**
 * 效果的**时机键** —— 全引擎比较时机只用它，不再直接比 `when` 字符串。
 *   · 写坐标的效果：`event` 或 `event:phase`
 *   · 写旧 when 的效果：先经 WHEN_TIMING 翻译再拼，**结果与坐标写法逐字相同**
 *   · 常驻/按钮类（standing / passive / activate）：不是时点，原样返回
 *
 * 为什么需要它：卡池数据正在从旧 `when` 迁移到总线坐标（`docs\时点规范.md` §5）。
 * 引擎里凡是"按时机筛选"的地方（`collectEffects()`、平局/打出型判定…）都走这里，
 * 两种写法才真正等价。2026-10-02 实测：不做这层归一化直接迁移数据，**14 套测试会挂**。
 */
function timingKey(eff) {
  if (!eff) return null;
  if (eff.event) return eff.phase ? eff.event + ':' + eff.phase : eff.event;
  if (eff.when) {
    const t = WHEN_TIMING[eff.when];
    if (t && t.event) return t.phase ? t.event + ':' + t.phase : t.event;
    return eff.when;                     // 常驻/按钮类：原样（它们本来就不是时点）
  }
  return null;
}

/** 把"要收集的时机名单"（旧 when / 总线事件名 / `event:phase` 都认）归一成同一套键 */
function wantKeys(list) {
  const arr = Array.isArray(list) ? list : [list];
  return arr.map((w) => {
    if (typeof w !== 'string') return w;
    if (w.indexOf(':') >= 0) return w;                 // 已经是 event:phase
    const t = WHEN_TIMING[w];
    if (t && t.event) return t.phase ? t.event + ':' + t.phase : t.event;
    return w;                                          // 总线事件名（hurt/equip/…）或常驻类
  });
}
/** 主轴顺序（用于文档/排序，越小越靠前；独立事件用 20+） */
function eventOrder(e) { const x = EVENTS[e]; return x && typeof x.order === 'number' ? x.order : 99; }

// ---------------------------------------------------------------- 触发时机
//
// 分三类：
//   window —— 出牌窗口：决定"这张牌什么时候能点"
//   auto   —— 自动触发：不用点，到点自己生效（装备/同行者常驻）
//   passive—— 常驻数值：只被汇总读取，从不"执行"
//
// win / lose 同时是 window 和 auto：
//   手里的消耗牌 → 是出牌窗口（风云幡、踏云靴）
//   场上的装备/同行者 → 自动触发（绿煌剑、风雷翅）
// 由卡牌类型决定，不在这里区分。

const WHEN = {
  play:          { kind: 'window', label: '自己回合内',           desc: '在自己的回合行动阶段使用' },
  place:         { kind: 'window', label: '放置时',               desc: '首次放置此同行者时' },

  combatStart:   { kind: 'window', label: '对战出牌阶段',          desc: '对战中双方都还没投掷骰子时' },
  beforeMyRoll:  { kind: 'window', label: '我方投骰前',            desc: '我方尚未投掷骰子' },
  afterMyRoll:   { kind: 'window', label: '我方投骰后',            desc: '我方已投掷骰子' },
  beforeFoeRoll: { kind: 'window', label: '对方投骰前',            desc: '对方尚未投掷骰子' },
  afterFoeRoll:  { kind: 'window', label: '对方投骰后',            desc: '对方已投掷骰子' },
  tie:           { kind: 'window', label: '对战平局时',            desc: '平局后双方各限一张改判窗口' },
  win:           { kind: 'window', label: '对战获胜时',            desc: '手里是出牌窗口；场上是自动触发' },
  lose:          { kind: 'window', label: '对战失败时',            desc: '手里是出牌窗口；场上是自动触发' },

  turn:          { kind: 'auto',    label: '自己回合开始',          desc: '自己回合开始时自动生效' },
  equip:         { kind: 'auto',    label: '装备宝物牌时',          desc: '自己把一件【装备类宝物牌】放进储物袋时触发（如【银月】）' },
  afterCombat:   { kind: 'auto',    label: '对战结束后',            desc: '整场对战结算完毕后自动生效' },
  hurt:          { kind: 'auto',    label: '受到伤害时',            desc: '本人实际掉血时自动生效' },
  lowHp:         { kind: 'auto',    label: '生命值濒危时',          desc: '生命值降到阈值以下时自动生效' },
  promote:       { kind: 'auto',    label: '晋升时',               desc: '晋升境界时生效' },

  passive:       { kind: 'passive', label: '常驻',                 desc: '常驻数值，由引擎汇总读取' },
  // 常驻的**对战数值修正**（「对战时，战力值+1」这类）。
  // 它不是"某个瞬间发生的事"，所以不该占时点 —— 引擎在对战开始时把身上所有 standing 效果加总一次。
  // 早期版本把它写成 combatStart，于是"对战出牌阶段"这个真时点被常驻加成塞满了（19 张里有 10 张是它）。
  standing:      { kind: 'passive', label: '常驻·对战修正',        desc: '只要你带着它，每次对战都生效；不占用时点' },
  // 主动技能：场面上的牌自带一个"主动使用"的能力，由玩家点出来
  // （【梅凝】「在自己的回合时使用，恢复1点生命并抽3张宝物牌，之后放入弃牌堆」）
  activate:      { kind: 'active',  label: '主动使用',             desc: '在自己的回合主动发动这张场上牌的能力' },
};

/** 对战内部的出牌窗口（不含 tie / win / lose 这些结算后窗口） */
const ROLL_WINDOWS = ['combatStart', 'beforeMyRoll', 'afterMyRoll', 'beforeFoeRoll', 'afterFoeRoll'];
/** 需要"有一场进行中的对战"才能进入的窗口 */
const COMBAT_WINDOWS = ROLL_WINDOWS.concat(['tie', 'win', 'lose']);
/** 对战加成要收集的 when：真对战窗口 + 常驻对战修正（【啼魂】【寒蛟】这类"对战时战力+1"） */
const COMBAT_BONUS_WHENS = COMBAT_WINDOWS.concat(['standing']);
/**
 * 上面那份名单的**归一化版**（总线键）。引擎里一律用这个 —— 见 `timingKey()`。
 * 映射来源就是 WHEN_TIMING，不手写：combatStart/beforeMyRoll/… → roll:before / roll:after；
 * tie/win/lose → combatResult:tie / :win / :lose；standing 保持原样（常驻不是时点）。
 */
const COMBAT_BONUS_KEYS = ['roll:before', 'roll:after',
  'combatResult:tie', 'combatResult:win', 'combatResult:lose', 'standing'];

/** 结算后才进入的窗口 */
const RESULT_WINDOWS = ['tie', 'win', 'lose'];
/** 可以在手里打出的窗口（其余 when 只用于场面上的自动触发/常驻） */
const PLAY_WINDOWS = ['play', 'place'].concat(COMBAT_WINDOWS);

// ---------------------------------------------------------------- 归一化的窗口判定
// ⚠️ 键表必须**定义在 PLAY_WINDOWS / COMBAT_WINDOWS 之后**（const 有暂时性死区，
//    提前引用会在 require 阶段直接抛 "Cannot access … before initialization"）。
/** 归一化后的"可打出窗口"键表（由 PLAY_WINDOWS 翻译而来，不手写） */
const PLAY_KEYS = Array.from(new Set(wantKeys(PLAY_WINDOWS)));
/** 对战窗口的归一化键表（combatStart/beforeMyRoll/… → roll:before/after；tie/win/lose → combatResult:*） */
const COMBAT_KEYS = Array.from(new Set(wantKeys(COMBAT_WINDOWS)));

/** 这条效果声明的**全部**时机键（一条效果可能同时写了 when 和 event —— 过渡期的双写法，
 *  如【遮天钟】`when:'play'` + `event:'hurt'`。迁移会把它们拆成两条，但这里要两种都能认）。 */
function timingKeys(eff) {
  const out = [];
  if (!eff) return out;
  if (eff.when) { const k = timingKey({ when: eff.when }); if (k && out.indexOf(k) < 0) out.push(k); }
  if (eff.event) { const k = eff.phase ? eff.event + ':' + eff.phase : eff.event; if (out.indexOf(k) < 0) out.push(k); }
  return out;
}

/** 这张效果能不能"从手里打出"（**认旧 when 与总线坐标两种写法**） */
function isPlayEffect(eff) { return timingKeys(eff).some((k) => PLAY_KEYS.indexOf(k) >= 0); }
/** 这张效果是不是"对战窗口"里的（同样认两种写法） */
function isCombatEffectByTiming(eff) { return timingKeys(eff).some((k) => COMBAT_KEYS.indexOf(k) >= 0); }

/**
 * 一个总线坐标等价的**旧 when 窗口名**（可能不止一个：`roll·我方·前` = `combatStart` 或 `beforeMyRoll`）。
 * 反向查 WHEN_TIMING 得到，不手写词典。没有等价旧名的坐标（受伤/晋升/使用卡牌/闭关…）返回空数组。
 *
 * 为什么要留着"旧窗口名"这一层：`satisfiedWindows()` 报的是**此刻真的还成立**的旧窗口名，
 * 而 `combatStart` 与 `beforeFoeRoll` **归一化后是同一个键**（都是 `roll:before`）——
 * 拿键去比会互相顶替（投骰之后"我方投骰前"会被"对方投骰前"顶成"还成立"），等于没判。见 `windowOk()`。
 */
function whensOfTimingKey(key, subject) {
  const out = [];
  for (const w of Object.keys(WHEN_TIMING)) {
    const t = WHEN_TIMING[w];
    if (!t || !t.event) continue;
    const ev = EVENTS[t.event];
    const subj = t.subject || ((ev && ev.subject === 'both') ? 'self' : null);
    if ((t.phase ? t.event + ':' + t.phase : t.event) !== key) continue;
    // 主体不同的旧名不能互相顶替：`combatStart`（我方投骰前）≠ `beforeFoeRoll`（对方投骰前）
    if (subj && subject && subj !== subject) continue;
    if (out.indexOf(w) < 0) out.push(w);
  }
  return out;
}

/**
 * 「当前对战窗口开没开」—— 老写法与总线坐标**同一套口径**。
 *
 * 背景：迁移前引擎拿 `e.when` 和 `satisfiedWindows()` 的旧窗口名逐字比；效果迁成坐标后 `e.when` 没了，
 * 那一道检查被整段跳过 → 「我方投骰前」的牌在投骰之后**还挂在响应者列表里**
 * （2026-10-02 数据迁移后 timing-bus-test 逮到）。这里把它补回来。
 *
 * 口径：
 *   · 效果**不是**对战窗口（受伤 / 晋升 / 使用卡牌 / 闭关 …）→ true：它们由 eligible() 自己判时点，
 *     本来就不受"对战窗口"约束（【还阳术】在战斗中受伤也要能响应）；
 *   · 是对战窗口 → 等价的旧窗口名里只要有一个"此刻成立"就 true。
 */
function windowOk(eff, openWins) {
  if (!openWins || !openWins.length) return true;
  const keys = timingKeys(eff);
  if (!keys.some((k) => COMBAT_KEYS.indexOf(k) >= 0)) return true;      // 不是对战窗口
  const t = timingOfEffect(eff) || {};
  for (const k of keys) {
    const names = whensOfTimingKey(k, t.subject);
    for (const n of names) if (openWins.indexOf(n) >= 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------- 效果 op
//
// needsTarget   —— 打出时必须先指定目标，否则效果会落空而牌被白白消耗
// requiresCombat—— 只能在对战过程中使用（没有对战时要拒掉）
// passive       —— 常驻数值类，由 passives() 汇总，不参与"执行"
// deprecated    —— 已被"条件化"取代，保留仅为读旧数据；compile-effects.js 会改写

const OPS = {
  // ---- 通用数值 ----
  qi:                 { label: '获得灵气值' },
  mana:               { label: '恢复法力值' },
  qi_and_mana:        { label: '获得灵气值与法力值' },
  heal:               { label: '恢复生命值' },

  // ---- 抽牌 ----
  // ⭐ 参数化合族（2026-10-05 用户拍板：迁移数据 + 旧 op 留 deprecated 兼容读旧备份）：
  //   抽哪个堆 = `deck`，抽几张 = `value`；多堆混合直接写 treasure/spell/companion 三个张数。
  //   根因：以前把"时点"焊进 op 名（win_draw_qi = draw + deck:qi + 时点 win —— 时点本来就在 event 里），
  //   每张新卡造一个新 op。新卡只许用 draw；旧 op 只用于读旧备份。
  draw:               { label: '抽牌', params: ['deck', 'value', 'treasure', 'spell', 'companion'] },
  draw_mixed:         { label: '抽宝物牌与法术牌', deprecated: '改用 draw + treasure/spell/companion 张数' },
  draw_treasure:      { label: '抽宝物牌', deprecated: '改用 draw + deck:treasure' },
  draw_qi:            { label: '抽灵气牌', deprecated: '改用 draw + deck:qi' },
  // 【长春功】专属：凡人期晋升一境 + 抽灵气，非凡人期改补抽 —— 不是纯抽牌，不合族
  on_promote_draw_qi: { label: '长春功：晋升或补抽灵气' },
  win_draw_qi:        { label: '对战获胜抽取灵气牌', deprecated: '改用 draw + deck:qi（时点写获胜）' },
  place_draw_qi:      { label: '放置时抽灵气牌', deprecated: '改用 draw + deck:qi（时点写放置）' },
  // 实物【青易居士】：探索阶段可选择把「抽 2 张宝物牌」换成「抽 1 张宝物牌 + 1 张法术牌」。
  // 2026-10-05 阶段事务模型：从 engineDirect（引擎直查的特殊按钮）改成挂在「探索阶段」时点的
  // 替换型效果 —— 收势时登记 phaseMods.exploreSwap，基础行动（栈底）最后读它改抽。
  explore_swap:       { label: '探索改抽（1 宝物 + 1 法术）' },

  // ---- 伤害 ----
  // ⭐ 参数化合族：给谁 = `target`（target 缺省=指定一名 / multi 一至两人 / all_others 其他全部 /
  //   self 自己 / self_then_target 先自伤再指定 / attacker 发起对战者 / loser 对战输家），
  //   伤害 = `value`；附加：max（multi 上限）、selfDamage（自伤点数）、skip（并跳过回合）、ignore_companion。
  damage:             { label: '造成伤害', params: ['target', 'value', 'max', 'selfDamage', 'skip', 'ignore_companion'] },
  damage_target:      { label: '指定目标受伤', needsTarget: true, deprecated: '改用 damage（target 缺省即指定一名）' },
  damage_multi:       { label: '指定一至两人受伤', deprecated: '改用 damage + target:multi' },
  damage_all_others:  { label: '其他修士各受伤害', deprecated: '改用 damage + target:all_others' },
  damage_and_skip:    { label: '指定目标受伤并跳过下回合', needsTarget: true, deprecated: '改用 damage + skip' },
  damage_attacker:    { label: '让发起对战者受伤', requiresCombat: true, deprecated: '改用 damage + target:attacker' },
  self_damage_then_multi: { label: '先自伤再指定他人受伤', deprecated: '改用 damage + target:self_then_target' },
  win_extra_damage:   { label: '对战获胜时对方额外受伤' },
  risky_win_damage:   { label: '胜则追伤／败则自伤', requiresCombat: true },
  damage_higher_realm:{ label: '指定境界更高的修士受伤', needsTarget: true, deprecated: '改用 damage_target + if.target.realmHigher' },
  versus_realm_effect:{ label: '按对方境界分支', tie: true, deprecated: '改用两条带 if.enemyRealm 的效果' },

  // ---- 对战修正 ----
  dice_bonus:         { label: '对战骰点加成' },
  dice_penalty:       { label: '压制对方骰点', tie: true },
  dice_skip_bonus:    { label: '放弃掷骰换固定战力+', tie: true },
  combat_bonus:       { label: '对战战力加成', tie: true },
  combat_debuff:      { label: '削减对手战力', tie: true },
  flat_power:         { label: '战力固定为指定值', tie: true },
  reroll_dice:        { label: '额外投掷一次取最大' },
  // 「支付对战启用费，本场启用这件装备」—— 低境界装备（凡人/炼气）的角标法力是**对战启用费**。
  // 判据：**需要付费的都要询问**（付不起就自动跳过、不问），所以它写成 `event:'combatOpt'`，
  // 由打断层在对战开始时问一句；不付则本场这件装备的对战效果不生效。
  enable_equip_combat: { label: '支付对战启用费（本场启用此装备）' },
  reroll:             { label: '掷骰可重掷', passive: true },
  force_reroll_foe:   { label: '强制对方重掷', needsTarget: false, tie: true },
  combat_bonus_win_mana: { label: '对战战力+，获胜回法力' },
  after_combat_mana:  { label: '对战结束后回法力' },

  // ---- 战败/平局保护 ----
  lose_immunity:      { label: '战败免罚' },
  lose_save_dice:     { label: '战败时掷骰免罚' },
  lose_retaliate:     { label: '战败时反伤对方' },
  cancel_attack:      { label: '取消本次对战', tie: true },
  // ⭐ 实物卡补充批：【大庚剑阵】"投掷1次骰子，若点数为6，将本次对战结果直接视为获胜"
  //   —— 与 `roll_branch` 搭配用（`{op:'roll_branch', branches:[{faces:[6], effects:[{op:'force_win'}]}]}`）
  force_win:          { label: '本次对战直接视为获胜' },

  // ---- 受伤保护 ----
  damage_save_dice:   { label: '受伤时掷骰抵消或反弹' },
  damage_reduction:   { label: '每次受伤减免', passive: true },
  damage_shield:      { label: '获得护体灵光', passive: true },
  // ⭐「受伤时点」的两个修正（2026-10-05 用户裁定：受伤是时点，响应先结算、原效果最后生效）：
  //   作用在**同一次受伤**上 —— 不开新的受伤窗口（否则"受伤时"的其他效果会跑两遍）。
  //   第 3 轮把受伤窗口**前置**之后，改的是"**待落地**的伤害"（`ctx.pending.value`），
  //   收势后照新值落地 —— 不再是"先把血补回来"那套事后补救。
  damage_cancel:      { label: '使本次伤害无效（待落地的伤害清零）' },
  damage_multiply:    { label: '使本次伤害 ×N（翻倍待落地的伤害）' },
  self_revive:        { label: '生命归零时自救' },
  low_hp_rescue:      { label: '生命濒危时恢复并离场' },
  // ⭐ 实物卡补充批：【刘靖】"当你受到任意伤害时，使对方受到等额伤害，之后此【同行者】放入【弃牌堆】"
  //   `who`：'source'（缺省，找伤害来源）/ 'any'（**要在窗口里选一位目标** —— 【青冥针】）。
  //   `who:'any'` 时这条效果进候选会带 `needsTarget`，前端先弹选人、再 `respond_play` 带上 `target`。
  hurt_reflect:       { label: '受伤时让伤害来源受等额伤害', params: ['who'] },
  // ⭐ 实物卡补充批：【金魁】"使场上任意 1 张【宝物牌】/【法术牌】无效" ——
  //   目标是**场上的一张牌**（不是玩家），要用 `targetUid`；
  //   `targetKind: 'board'` 让前端知道该弹"选牌"而不是"选人"。
  nullify_board_card: { label: '使场上任意一张宝物/法术牌无效', needsTarget: true, targetKind: 'board' },

  // ---- 打断 / 封锁 ----
  nullify_enemy_card: { label: '无效对方一张法术或宝物牌', requiresCombat: true },
  block_enemy_card_kind: { label: '禁止对方使用某类牌' },
  // ⭐ 参数化合族：封哪类 = `deck`（spell/companion/treasure），几回合 = `value`
  block_draw:         { label: '封锁抽取某类牌', params: ['deck', 'value'] },
  block_spell_draw:   { label: '封锁对方抽取法术牌', deprecated: '改用 block_draw + deck:spell' },
  block_companion_draw: { label: '封锁对方抽取同行者', deprecated: '改用 block_draw + deck:companion' },
  block_treasure_draw: { label: '封锁对方抽取宝物牌', deprecated: '改用 block_draw + deck:treasure' },
  skip_turn:          { label: '目标跳过下回合', needsTarget: true },
  skip_turns:         { label: '目标跳过下回合所有行为', needsTarget: true },
  curse_target:       { label: '诅咒生命值最低者' },
  // ⭐ 实物卡补充批（2026-10-05 第 8 件）：
  //   【拘灵阵】"下回合内，除你以外的所有修士无法抽取【灵气牌】，也不能使用任何卡牌效果抽取【灵气牌】"
  //   —— 与 block_draw 的区别：它是**封所有别人**（不是封目标一个人），且只封灵气这一种"点"。
  block_qi_draw:      { label: '其他人不能抽取灵气牌', params: ['value'] },
  //   【隐灵纱】【神风舟】"在你的下回合开始之前，你无法被指定为对战目标"
  cannot_be_targeted: { label: '到下回合开始前无法被指定为对战目标' },

  // ---- 掠夺 ----
  steal_equip:        { label: '夺取对方装备', needsTarget: true },
  steal_card:         { label: '夺取对方手牌', needsTarget: true },
  // ⭐ 实物卡补充批（2026-10-05 第 8 件）：【引魂钟】"将对方放置的任意1张【同行者】移除并加入自己手牌"
  steal_companion:    { label: '夺取对方场上的同行者', needsTarget: true },
  look_hand:          { label: '查看对方手牌' },
  discard_enemy_equip:{ label: '弃置对方装备' },
  win_steal_treasure: { label: '对战获胜抽取对方宝物牌' },
  // ⭐ 实物卡补充批：【换形诀】"指定任意一位修士和你交换所有手牌"
  swap_hand:          { label: '与指定修士交换所有手牌', needsTarget: true },
  // ⭐ 实物卡补充批：【七鬼噬魂术】"本回合使用任意1张宝物/法术牌时不消耗法力，但自身受 1 点伤害"
  free_card_this_turn:{ label: '本回合出牌不消耗法力（每张自身受伤害）', params: ['value'] },

  // ---- 境界 / 晋升 ----
  // 常驻晋升折扣（同行者在场即生效）。同样按 `on` 决定减哪个数：
  //   缺省 / 'threshold' —— 减「门槛」（灵根符上印的「需达到」）【玄骨】
  //   'consume'         —— 减「消耗」（晋升时真正扣掉的灵气值）【六翼霜蜈】【辛如音】
  promote_discount:   { label: '晋升所需灵气值-', passive: true, params: ['on'] },
  // 一次性晋升折扣。注意游戏里有两个不同的数，卡文用词决定减哪个：
  //   on 缺省 / 'threshold' —— 减「门槛」（灵根符上印的「需达到」）【九曲灵参】【九曲灵参丹】
  //   on: 'consume'        —— 减「消耗」（晋升时真正扣掉的灵气值）【娑罗珠】
  promote_discount_once: { label: '晋升折扣（一次性）', params: ['on'] },
  pseudo_realm:       { label: '进入伪丹期' },

  // ---- 同行者相关 ----
  summon_puppet:      { label: '召唤傀儡替伤' },
  // 「让傀儡替你挨这一下」—— 实物【傀儡蜥蜴】。需要付费（2 点法力）→ 主动询问，
  // 写在「受伤」时点（`event:'hurt'`，`if.puppet` 保证还有替伤次数时才问）。
  puppet_absorb:      { label: '由傀儡替你承受本次伤害' },
  extra_seclusion:    { label: '额外获得过关机会' },
  hand_limit_bonus:   { label: '手牌上限+', passive: true },
  // ⭐ 实物卡补充批（2026-10-05 第 8 件）：
  //   【胡月】"可放置【同行者】数量额外＋1"（它在场才有；它离场时多出来的同行者要一起进弃牌堆）
  companion_slot_bonus: { label: '可放置同行者数量+', passive: true },
  //   【傀儡弓手】"放置此【傀儡】后，除你以外的所有修士投掷骰子判定：≤5 判定者受 1 点伤害、≥5 你受 1 点伤害"
  puppet_judge_damage:{ label: '放置傀儡：其他人各掷骰判定受伤' },
  //   【南陇侯】"当你成为被对战目标时，若你的骰子点数大于对方，可无视对方所有【装备类宝物牌】"
  //   （常驻·对战修正：结算时把对方的**装备**加成整批清零，同行者加成不受影响）
  ignore_enemy_equips:{ label: '骰点压制时无视对方全部装备类宝物牌', passive: true },
  //   【神风舟】三条：跳过本回合所有行动、"到下回合开始前不能被指定为对战目标"、下回合探索额外抽 1 宝物
  void_turn_qi:       { label: '跳过本回合所有行动，改为只抽1张灵气牌' },
  explore_extra_treasure: { label: '下回合探索阶段额外抽宝物牌' },
  mana_regen_bonus:   { label: '每回合额外恢复法力', passive: true },
  turn_no_combat_mana:{ label: '不发起对战略回法力', passive: true },
  turn_no_combat_heal:{ label: '不发起对战可花法力回生命', passive: true },
  overreach_dice_save:{ label: '越级使用宝物牌时掷骰免额外法力', passive: true },
  // 实物【陈巧倩】：使用指定丹药时效果翻倍，之后自身进弃牌堆
  double_card_effect: { label: '使用指定牌时效果翻倍（之后自身离场）', passive: true },

  // ---- 主动技能 ----
  grant_spell:        { label: '获得指定法术牌（可无视境界）' },
  self_discard:       { label: '主动使用后自身进弃牌堆' },

  // ⭐ 通用「掷骰分支」节点（用户 2026-10-05 蓝图式编辑要的）：
  //   投 1 次骰子，按点数走不同支线，每条支线挂自己的子效果。
  //   `branches: [{faces:[5,6], effects:[…]}, {faces:[2,3,4], effects:[…]}, {faces:[1], effects:[…]}]`
  //   `else: [ … ]` = 兜底（没勾中的点数走这里）。
  //   子效果里的数字可以写占位符：`"$face"` = 本次掷出的点数、`"$lostHp"` = 本次受伤扣的血
  //   （受伤窗口用，如【玄铁飞天盾】"点数为1时受到双倍伤害"）。
  roll_branch:        { label: '掷骰判定：按点数分支', params: ['branches', 'else'] },

  // ---- 触发型 ----
  after_consume_roll6:{ label: '用消耗牌后掷出6触发伤害' },
  combat_bonus_if_hp_le:  { label: '生命偏低时战力+', deprecated: '改用 combat_bonus + if.hp.lte' },
  combat_bonus_if_hp_ge:  { label: '生命偏高时战力+', deprecated: '改用 combat_bonus + if.hp.gte' },
  combat_bonus_if_enemy_higher_realm: { label: '对方境界更高时战力+', deprecated: '改用 combat_bonus + if.enemyRealm.higher' },
  combat_bonus_if_companion: { label: '特定同行者在场时战力+', deprecated: '改用 combat_bonus + if.companion' },
};

// ---------------------------------------------------------------- 条件谓词
//
// `if` 里的键。多键之间是 AND。引擎的 matchConditions() 实现求值。
//
// 给 OPS 挂上「大类」（蓝图视图与表单视图的下拉分组都用它）
for (const op of Object.keys(OPS)) {
  const g = OP_GROUP_OF[op];
  if (g) OPS[op].group = g;
}

const CONDITIONS = {
  hp:         { label: '自己的生命值',   cmp: true, keys: ['lte', 'lt', 'gte', 'gt', 'eq'] },
  // ⭐ 实物卡补充批：【龙纹四象蟠龙带】"当【法力值】低于3点时，将任意1张宝物牌放入弃牌堆，恢复2点法力值"
  mana:       { label: '自己的法力值',   cmp: true, keys: ['lte', 'lt', 'gte', 'gt', 'eq'] },
  realm:      { label: '自己的境界',     cmp: true, keys: ['lte', 'lt', 'gte', 'gt', 'eq'] },
  enemyRealm: { label: '对战对手的境界', cmp: true, keys: ['lte', 'lt', 'gte', 'gt', 'eq', 'higher', 'lower'] },
  target:     { label: '被指定的目标',   cmp: true, keys: ['realmHigher', 'notSelf', 'lte', 'gte', 'eq', 'realm'] },
  // ⭐ 套装 / 联动（"和另一张牌配合""某两个同行者同场"）—— 见 docs\时点规范.md §7
  //   companion: '离龟'            单张同行者在场（旧写法，继续支持）
  //   companion: ['离龟','铁火蚁']  **这些同行者全都在场**
  //   companionAny: ['离龟','南宫婉'] 其中**任意一张**在场
  companion:  { label: '场上有该同行者', cmp: false, keys: ['全部在场（数组）'] },
  companionAny: { label: '场上有其中任意一位同行者', cmp: false },
  //   onField / onFieldAny：自己的**场上**（储物袋 + 法术区 + 同行者 + 傀儡）有没有这张牌（按牌名）
  onField:    { label: '自己场上有该牌（装备/法术区/同行者/傀儡）', cmp: false, keys: ['全部在场（数组）'] },
  onFieldAny: { label: '自己场上有其中任意一张', cmp: false },
  //   本回合自己打出过某张牌 → "和另一张牌配合"（引擎在 startTurn 清零）
  playedThisTurn: { label: '本回合自己打出过该牌', cmp: false },
  hasEquip:   { label: '储物袋中有装备类宝物牌', cmp: false },
  inCombat:   { label: '有进行中的对战', cmp: false },
  // 「本场对战的先攻／后攻方是我」—— 用户 2026-10-05 要求给发起对战的人一个标记，
  // 用来写"当你**主动发起**对战时…"这类效果（实物【凤帝】）。
  // 战斗面板与战报统一叫**先攻／后攻**。
  attacker:   { label: '先攻（本场对战是我发起的）', cmp: false },
  defender:   { label: '后攻（本场对战我被指定）',   cmp: false },
  turnFlag:   { label: '本回合标记',     cmp: false, keys: ['combat', 'promote'] },
  deck:       { label: '牌堆',           cmp: false },
  // 「这次伤害会把我打到 0 点或以下」—— 只有"受伤"打断窗口会给出这个上下文。
  // 实物【还阳术】「当你的生命值为 0 点时使用」就靠它把窗口收窄到真正濒死的那一次。
  lethal:     { label: '本次伤害致命',   cmp: false },
  // 「场上有可用的傀儡（还有替伤次数）」—— 实物【傀儡蜥蜴】靠它决定要不要摆出来问
  puppet:     { label: '场上有可用傀儡', cmp: false },
};

// ---------------------------------------------------------------- 派生工具

/**
 * 旧引擎里 `COMBAT_KINDS` 的成员。迁移旧数据时用它决定 `when`，
 * 保证 `timingOf()` 的判定结果**一字不变**（纯搬家、零行为差异）。
 * 语义上更精确的窗口由 tools/compile-effects.js 按卡文另行写入。
 */
const LEGACY_COMBAT_OPS = ['dice_bonus', 'combat_bonus', 'combat_debuff', 'cancel_attack', 'reroll_dice',
  'dice_penalty', 'dice_skip_bonus', 'versus_realm_effect', 'force_reroll_foe', 'lose_immunity',
  'lose_save_dice', 'lose_retaliate', 'damage_save_dice', 'win_steal_treasure', 'win_extra_damage',
  'win_draw_qi', 'combat_bonus_win_mana', 'nullify_enemy_card', 'risky_win_damage', 'damage_attacker'];

/** 条件型 op（`combat_bonus_if_*` 家族）：它们是"对战发生时"的效果，不属于出牌窗口 */
const CONDITIONAL_COMBAT_OPS = ['combat_bonus_if_hp_le', 'combat_bonus_if_hp_ge',
  'combat_bonus_if_enemy_higher_realm', 'combat_bonus_if_companion'];

/** 旧数据里这条效果（没写 when 时）该归到哪个窗口。
 *  先按 op 语义给出更精确的窗口（win_* / lose_* / 战后回法力 / 条件型对战效果），
 *  其余再按旧的 COMBAT_KINDS 归属 —— 保证 timingOf() 判定不变。 */
function defaultWhenFor(op) {
  if (op === 'after_combat_mana') return 'afterCombat';
  if (/^win_/.test(op)) return 'win';
  if (/^lose_/.test(op)) return 'lose';
  if (CONDITIONAL_COMBAT_OPS.indexOf(op) >= 0) return 'combatStart';
  return LEGACY_COMBAT_OPS.indexOf(op) >= 0 ? 'combatStart' : 'play';
}

/** 取第一个非空的等价写法 */
function attrOf(op, key) { const o = OPS[op]; return !!(o && o[key]); }

function opsWhere(pred) {
  const out = [];
  for (const k of Object.keys(OPS)) if (pred(OPS[k], k)) out.push(k);
  return out;
}

/** 需要指定目标的 op 集合（老代码里的 NEEDS_TARGET） */
function needsTargetOps() { return opsWhere((o) => o.needsTarget); }
/** 只能在对战中使用、没有对战就拒掉的 op 集合 */
function requiresCombatOps() { return opsWhere((o) => o.requiresCombat); }

/**
 * damage 的 target 模式（缺省推导）：
 *   显式写了 e.target 就用；**旧数据兼容**：没写 target 的裸 damage 落在对战结果时点 = 给输家
 *   （runOnWinEffects 的老语义，如旧版【绿煌剑】【敛气术】）；其余缺省 = 'target'（指定一名）。
 */
function damageMode(e) {
  if (!e) return 'target';
  if (e.target) return e.target;
  const t = timingOfEffect(e);
  if (t && t.event === 'combatResult') return 'loser';
  return 'target';
}

/**
 * ⭐ 这条**效果**（不只是 op）是否需要指定目标 / 需要对战 —— 参数化合族后按参数判：
 *   damage 的 target 缺省='target'（指定一名）；multi / self_then_target 也要指定；
 *   attacker 模式才需要对战。其余 op 照旧看 op 级标记。
 */
function effectNeedsTarget(e) {
  if (!e) return false;
  const o = OPS[e.op];
  if (o && o.needsTarget) return true;
  if (e.op === 'damage') {
    const m = damageMode(e);
    return m === 'target' || m === 'multi' || m === 'self_then_target';
  }
  // ⭐ 「受伤时让**任意一位**修士受等额伤害」（【青冥针】）：`who:'any'` 才需要在窗口里选人；
  //    缺省 / 'source'（【刘靖】）是自动找伤害来源，不该弹选人。
  if (e.op === 'hurt_reflect') return e.who === 'any' || e.select === true;
  // ⭐ 2026-10-05：**掷骰分支里的子效果也算** —— 实物【太妙多宝万华阵】"掷出 5/6 才指定一位修士受伤"，
  //    目标是在**出牌那一刻**选的（跟点数无关），所以前端必须在出牌前就弹出选人。
  //    不这么做的话，这条效果永远拿不到 `ctx.target`（`damage` 缺省模式 = 指定一名）。
  if (e.op === 'roll_branch') {
    const subs = [];
    for (const b of (e.branches || [])) subs.push(...((b && b.effects) || []));
    subs.push(...(e.else || []));
    return subs.some((s) => effectNeedsTarget(s));
  }
  return false;
}

/**
 * 这条效果要选的是**什么人**：
 *   'player' —— 一位修士（缺省；【换形诀】【引魂钟】【青冥针】…）
 *   'board'  —— **场上的一张牌**（【金魁】"使场上任意 1 张宝物/法术牌无效"）
 * 前端按它决定弹"选人"还是"选牌"，引擎按它校验 `target` / `targetUid`。
 */
function effectTargetKind(e) {
  if (!e) return null;
  const o = OPS[e.op];
  if (o && o.targetKind) return o.targetKind;
  if (e.op === 'roll_branch') {
    const subs = [];
    for (const b of (e.branches || [])) subs.push(...((b && b.effects) || []));
    subs.push(...(e.else || []));
    for (const s of subs) { const k = effectTargetKind(s); if (k) return k; }
  }
  return effectNeedsTarget(e) ? 'player' : null;
}
function effectRequiresCombat(e) {
  if (!e) return false;
  const o = OPS[e.op];
  if (o && o.requiresCombat) return true;
  if (e.op === 'damage' && damageMode(e) === 'attacker') return true;
  return false;
}
/** 常驻数值 op 集合（由 passives() 汇总） */
function passiveOps() { return opsWhere((o) => o.passive); }
/** 平局窗口可用的 op 集合 */
function tieOps() { return opsWhere((o) => o.tie); }

function opLabel(op) { const o = OPS[op]; return (o && o.label) || op; }
function whenLabel(w) { const x = WHEN[w]; return (x && x.label) || w; }

function isWindow(w) { return !!(WHEN[w] && WHEN[w].kind === 'window'); }
function isPlayWindow(w) { return PLAY_WINDOWS.indexOf(w) >= 0 || PLAY_KEYS.indexOf(w) >= 0; }
function isAutoTrigger(w) { return !!(WHEN[w] && WHEN[w].kind === 'auto'); }
function isCombatWindow(w) { return COMBAT_WINDOWS.indexOf(w) >= 0; }
function isRollWindow(w) { return ROLL_WINDOWS.indexOf(w) >= 0; }
function isResultWindow(w) { return RESULT_WINDOWS.indexOf(w) >= 0; }

/** 给 /api/meta 用的完整元数据快照（前端拿它生成标签，不再本地维护词典） */
function meta() {
  return {
    whens: WHEN,
    ops: OPS,
    // 效果大类（蓝图视图的分组与下拉分组标题；顺序就是编辑器里的顺序）
    opGroups: OP_GROUP_NAMES,
    conditions: CONDITIONS,
    playWindows: PLAY_WINDOWS,
    combatWindows: COMBAT_WINDOWS,
    resultWindows: RESULT_WINDOWS,
    rollWindows: ROLL_WINDOWS,
    needsTarget: needsTargetOps(),
    requiresCombat: requiresCombatOps(),
    passive: passiveOps(),
    tie: tieOps(),
    // 时点总线：事件表 + when→总线坐标映射，前端据此写"投骰 · 对方 · 前"这类文案
    events: EVENTS,
    whenTiming: WHEN_TIMING,
    // ⭐ 阶段/时点中文名表（用户给的阶段图）：前端与编辑器**不再自己拼中文**，直接查这张表
    timingNames: timingNameTable(),
    // ⭐ 缩减后的时点总表（一行 = 玩家看到的一个时点，可含多个引擎钩子）
    timingGrid: TIMING_GRID,
    // ⭐ 2026-10-05：阶段表的三个分组 + 图上一格属于哪个分组（文档/编辑器/报表都按它收拢）
    timingGroups: TIMING_GROUPS,
    stageGroups: STAGE_GROUP,
    rollRuntime: ROLL_RUNTIME,
  };
}

module.exports = {
  WHEN, OPS, CONDITIONS,
  PLAY_WINDOWS, COMBAT_WINDOWS, RESULT_WINDOWS, ROLL_WINDOWS, LEGACY_COMBAT_OPS, COMBAT_BONUS_WHENS,
  COMBAT_BONUS_KEYS, timingKey, timingKeys, wantKeys, isPlayEffect, PLAY_KEYS, COMBAT_KEYS, isCombatEffectByTiming,
  whensOfTimingKey, windowOk,
  EVENTS, WHEN_TIMING, timingOfWhen, timingOfEffect, timingLabel, eventLabel,
  timingNameOf, timingStageOf, timingNameTable, timingLabelIn, TIMING_NAMES, TIMING_GRID, ROLL_RUNTIME,
  TIMING_GROUPS, STAGE_GROUP,
  isSelfOnlyEvent, eventOrder,
  opsWhere, needsTargetOps, requiresCombatOps, passiveOps, tieOps, defaultWhenFor,
  effectNeedsTarget, effectRequiresCombat, damageMode, effectTargetKind,
  opLabel, whenLabel, attrOf,
  isWindow, isPlayWindow, isAutoTrigger, isCombatWindow, isRollWindow, isResultWindow,
  needsResponse,
  meta,
};
