'use strict';
/**
 * 编辑器用的「效果参数提示表」（**只服务于界面**）。
 *
 * 定位说明（很重要，别和 effect-meta.js 搞混）：
 *   · op 清单 / op 中文名 / 时点 / 触发条件 —— 唯一来源永远是 `server/effect-meta.js`，
 *     本文件**不重复定义**任何一个 op。
 *   · `OPS[op].params` 只有个别 op（promote_discount / promote_discount_once）声明了字段名，
 *     所以"选了 damage_target 只显示伤害点数"这件事需要一份界面侧的字段提示。
 *     这份提示表就是干这个的：op → 参数输入框。op 没有登记在这里时，
 *     app.js 会自动退回「按当前数据里出现的字段生成输入框」，不会丢字段。
 *
 * 三个原则：
 *   1. 表里没有的字段 **一定** 还能编辑（落在「其它字段」区，输入框类型按现值推断）；
 *   2. 时点/条件/比较符都从 effect-meta 生成，本文件不碰；
 *   3. `params` 字段若在 effect-meta 里声明了，以 effect-meta 为准（见 mergeHints）。
 *
 * 零依赖，服务端 require 后经 /api/meta 下发。
 */

/** 字段构造器：type ∈ int | num | bool | str | enum | intlist | strlist */
const P = (key, label, type, extra) => Object.assign({ key, label, type }, extra || {});

const DECK_OPTS = [
  { v: 'treasure', t: '宝物牌' },
  { v: 'spell', t: '法术牌' },
  { v: 'companion', t: '同行者' },
  { v: 'qi', t: '灵气牌' },
];

/** op → 参数输入框（顺序即界面顺序） */
const PARAM_HINTS = {
  // ---- 通用数值 ----
  qi: [P('value', '获得灵气值', 'int')],
  mana: [P('value', '恢复法力值', 'int')],
  qi_and_mana: [P('value', '灵气值', 'int'), P('mana', '法力值', 'int')],
  heal: [P('value', '恢复生命值', 'int')],

  // ---- 抽牌 ----
  // ⭐ 参数化合族（2026-10-05）：单堆用 deck+value；多堆混合写 treasure/spell/companion 张数
  draw: [P('deck', '从哪个牌堆', 'enum', { opts: DECK_OPTS }), P('value', '抽几张', 'int'),
    P('treasure', '抽宝物牌张数（多堆混合时用）', 'int'), P('spell', '抽法术牌张数（多堆混合时用）', 'int'),
    P('companion', '抽同行者张数（多堆混合时用）', 'int')],
  draw_mixed: [P('treasure', '抽宝物牌张数', 'int'), P('spell', '抽法术牌张数', 'int')],
  draw_treasure: [P('value', '抽宝物牌张数', 'int')],
  draw_qi: [P('value', '抽灵气牌张数', 'int')],
  on_promote_draw_qi: [P('value', '抽灵气牌张数', 'int'),
    P('extraIfAboveMortal', '非凡人期额外多抽', 'int')],
  win_draw_qi: [P('value', '抽灵气牌张数', 'int')],
  place_draw_qi: [P('value', '抽灵气牌张数', 'int')],
  explore_swap: [P('value', '张数（1 宝物 + 1 法术）', 'int'), P('note', '备注（给改数据的人看）', 'str')],

  // ---- 伤害 ----
  damage_target: [P('value', '伤害点数', 'int')],
  damage_multi: [P('value', '每个目标伤害点数', 'int'), P('max', '最多指定几人', 'int'),
    P('ignore_companion', '同行者/宝物不能替挡', 'bool')],
  damage_all_others: [P('value', '每人伤害点数', 'int')],
  damage_and_skip: [P('damage', '伤害点数', 'int'), P('skip', '跳过对方下回合数', 'int')],
  // ⭐ 参数化合族：给谁用 target 枚举，其余参数按模式需要填
  damage: [P('target', '给谁', 'enum', { opts: [
      { v: 'target', t: '指定一名修士（缺省）' },
      { v: 'multi', t: '指定一至两人' },
      { v: 'all_others', t: '其他修士全部' },
      { v: 'self', t: '自己' },
      { v: 'self_then_target', t: '先自伤再指定' },
      { v: 'attacker', t: '发起对战者（需在对战中）' },
      { v: 'loser', t: '对战输家（结算上下文）' }] }),
    P('value', '伤害点数', 'int'), P('max', '最多指定几人（multi）', 'int'),
    P('selfDamage', '先自伤点数（self_then_target）', 'int'), P('skip', '并跳过回合数', 'int'),
    P('ignore_companion', '同行者/宝物不能替挡', 'bool')],
  damage_attacker: [P('value', '让发起对战者受伤点数', 'int'), P('requiresCombat', '需要在对战中', 'bool')],
  self_damage_then_multi: [P('selfDamage', '自己先受伤点数', 'int'), P('value', '他人伤害点数', 'int'),
    P('max', '最多指定几人', 'int')],
  win_extra_damage: [P('value', '对方额外受伤点数', 'int')],
  risky_win_damage: [P('winDamage', '胜则对方追伤', 'int'), P('loseDamage', '败则自己受伤', 'int')],
  damage_higher_realm: [P('value', '伤害点数', 'int')],
  versus_realm_effect: [P('onWinDamage', '胜则追伤', 'int'), P('diceBonus', '高境界时骰点加成', 'int'),
    P('lowRealm', '低于此境界算「低」（0凡人1炼气2筑基3结丹4元婴）', 'int'),
    P('highRealm', '高于等于此境界算「高」', 'int')],

  // ---- 对战修正 ----
  dice_bonus: [P('value', '骰点加成', 'int'), P('cap', '骰点上限（最高 6）', 'int')],
  dice_penalty: [P('value', '压制对方骰点', 'int')],
  dice_skip_bonus: [P('value', '放弃掷骰换取的固定加成', 'int')],
  combat_bonus: [P('value', '战力加成', 'int')],
  combat_debuff: [P('value', '削减对手战力', 'int'), P('manaCost', '发动消耗法力', 'int')],
  flat_power: [P('value', '战力固定为', 'int')],
  reroll_dice: [P('value', '额外投掷几次', 'int')],
  enable_equip_combat: [P('manaCost', '对战启用费（法力）', 'int')],
  reroll: [P('scope', '重掷范围', 'enum', { opts: [{ v: 'promote', t: '晋升掷骰' }] })],
  force_reroll_foe: [],
  combat_bonus_win_mana: [P('value', '战力加成', 'int'), P('winMana', '获胜恢复法力', 'int')],
  after_combat_mana: [P('value', '恢复法力值', 'int')],

  // ---- 战败 / 平局保护 ----
  lose_immunity: [],
  lose_save_dice: [P('faces', '免罚骰面（可多选）', 'intlist', { min: 1, max: 6 })],
  lose_retaliate: [P('value', '反伤对方点数', 'int')],
  cancel_attack: [],

  // ---- 受伤保护 ----
  damage_save_dice: [P('faces', '抵消骰面', 'intlist', { min: 1, max: 6 }), P('reflect', '反弹骰面（单值）', 'int')],
  // ⭐ 通用掷骰分支（2026-10-05 用户要的蓝图节点）：branches / else 是**嵌套结构**（每条支线挂自己的子效果），
  //    这层平铺表单展不平 —— 在下面「其它字段 / 原始 JSON」区里写，可视化编辑留给蓝图那一轮。
  //      branches: [{ faces:[5,6], effects:[…] }, { faces:[1], effects:[…] }]
  //      else: [ … ]（没勾中的点数走这里）
  //    子效果的数字可以写占位符：`"$face"` = 本次点数、`"$lostHp"` = 本次受伤扣的血。
  //    掷骰分支的子效果**不写 when/event**（跟着父节点走）。
  roll_branch: [],
  damage_reduction: [P('value', '每次受伤减免', 'int')],
  // 「使本次伤害无效 / ×N」——受伤是时点：响应先结算、原效果最后生效，作用在**同一次受伤**上
  damage_cancel: [],
  damage_multiply: [P('value', '翻倍倍数（缺省 2）', 'int')],
  damage_shield: [P('value', '护盾点数', 'int')],
  self_revive: [P('value', '复活后生命值', 'int')],
  low_hp_rescue: [P('value', '恢复生命值', 'int'), P('discardSelf', '发动后自身进弃牌堆', 'bool')],

  // ---- 打断 / 封锁 ----
  nullify_enemy_card: [P('block', '无效哪类牌', 'str', { hint: '如：法术牌/宝物牌' })],
  block_enemy_card_kind: [P('block', '禁止对方使用的牌类', 'str', { hint: '如：消耗类宝物牌' })],
  block_draw: [P('deck', '封锁哪类抽取', 'enum', { opts: DECK_OPTS }), P('value', '封锁回合数', 'int')],
  block_spell_draw: [P('value', '封锁回合数', 'int')],
  block_companion_draw: [P('value', '封锁回合数', 'int')],
  block_treasure_draw: [P('value', '封锁回合数', 'int')],
  skip_turn: [P('value', '跳过回合数', 'int')],
  skip_turns: [P('value', '跳过回合数（整回合所有行为）', 'int')],
  curse_target: [P('blockTreasureDraw', '同时封锁抽宝物牌', 'bool'), P('blockCombat', '同时封锁发起对战', 'bool')],

  // ---- 掠夺 ----
  steal_equip: [P('all', '夺取全部装备', 'bool'), P('count', '夺取数量（可写 all 或数字）', 'str')],
  steal_card: [P('value', '夺取手牌张数', 'int'), P('count', '数量（可写 all 或数字）', 'str')],
  look_hand: [],
  discard_enemy_equip: [P('value', '弃置件数', 'int')],
  win_steal_treasure: [P('value', '抽取对方宝物牌张数', 'int')],

  // ---- 境界 / 晋升 ----
  promote_discount: [P('value', '灵气值 -', 'int'),
    P('on', '减哪个数', 'enum', { opts: [{ v: 'threshold', t: '门槛（灵根符上印的"需达到"）' }, { v: 'consume', t: '消耗（晋升时真正扣的）' }] })],
  promote_discount_once: [P('value', '灵气值 -', 'int'),
    P('on', '减哪个数', 'enum', { opts: [{ v: 'threshold', t: '门槛' }, { v: 'consume', t: '消耗' }] }),
    P('onlyRealm', '仅晋升到该境界时可用（0凡人1炼气2筑基3结丹4元婴）', 'int'),
    P('comboWith', '与这张牌同时使用才生效（牌名）', 'str'),
    P('comboValue', '合计折扣值（缺省=两张的 value 之和）', 'int'),
    P('alsoDrawQi', '进弃牌堆时额外抽灵气牌', 'int')],
  pseudo_realm: [P('realm', '视为哪个境界（3=结丹）', 'int'), P('turns', '持续回合数', 'int'),
    P('penalty', '结束惩罚', 'int')],

  // ---- 同行者 / 常驻 ----
  summon_puppet: [P('absorbs', '可替挡次数', 'int'), P('manaCost', '每次消耗法力', 'int')],
  puppet_absorb: [P('manaCost', '消耗法力', 'int')],
  extra_seclusion: [P('value', '额外过关机会', 'int')],
  hand_limit_bonus: [P('value', '手牌上限 +', 'int')],
  mana_regen_bonus: [P('value', '每回合额外恢复法力', 'int')],
  turn_no_combat_mana: [P('value', '没发起对战时恢复法力', 'int')],
  turn_no_combat_heal: [P('manaCost', '花多少法力', 'int'), P('heal', '恢复几点生命', 'int')],
  overreach_dice_save: [P('min', '掷骰达到几点即可免额外法力', 'int')],
  double_card_effect: [P('names', '哪些牌效果翻倍（牌名列表）', 'strlist')],

  // ---- 主动技能 ----
  grant_spell: [P('name', '给哪张牌（牌名）', 'str'),
    P('deck', '去哪取（牌堆）', 'enum', { opts: DECK_OPTS }),
    P('fallback', '取不到时兜底', 'bool')],
  self_discard: [],

  // ---- 触发型 ----
  after_consume_roll6: [],
  combat_bonus_if_hp_le: [P('value', '战力加成', 'int'), P('threshold', '生命 ≤（缺省 3）', 'int')],
  combat_bonus_if_hp_ge: [P('value', '战力加成', 'int'), P('threshold', '生命 ≥（缺省 4）', 'int')],
  combat_bonus_if_enemy_higher_realm: [P('value', '战力加成', 'int')],
  combat_bonus_if_companion: [P('value', '战力加成', 'int'), P('name', '需要的同行者牌名', 'str')],
};

/** 通用字段字典：op 没登记提示、或数据里有额外字段时，按这个给标签与类型 */
const FIELD_LABELS = {
  value: P('value', '数值', 'int'),
  count: P('count', '数量', 'str'),
  max: P('max', '最多几个', 'int'),
  cap: P('cap', '上限', 'int'),
  min: P('min', '最低值', 'int'),
  faces: P('faces', '骰子点数列表', 'intlist', { min: 1, max: 6 }),
  reflect: P('reflect', '反弹骰面', 'int'),
  selfDamage: P('selfDamage', '自己受伤', 'int'),
  damage: P('damage', '伤害点数', 'int'),
  skip: P('skip', '跳过回合数', 'int'),
  manaCost: P('manaCost', '消耗法力', 'int'),
  mana: P('mana', '法力值', 'int'),
  heal: P('heal', '恢复生命值', 'int'),
  on: P('on', '作用对象（门槛/消耗）', 'str'),
  onlyRealm: P('onlyRealm', '仅限该境界（数字）', 'int'),
  comboWith: P('comboWith', '配合的牌名', 'str'),
  comboValue: P('comboValue', '配合后的合计数值', 'int'),
  alsoDrawQi: P('alsoDrawQi', '额外抽灵气牌', 'int'),
  extraIfAboveMortal: P('extraIfAboveMortal', '非凡人期额外抽', 'int'),
  realm: P('realm', '境界（0凡人1炼气2筑基3结丹4元婴）', 'int'),
  turns: P('turns', '持续回合数', 'int'),
  penalty: P('penalty', '惩罚值', 'int'),
  deck: P('deck', '牌堆', 'str'),
  target: P('target', '作用目标', 'str'),
  companion: P('companion', '同行者张数', 'int'),
  name: P('name', '牌名 / 名称', 'str'),
  names: P('names', '牌名列表', 'strlist'),
  fallback: P('fallback', '取不到时兜底', 'bool'),
  note: P('note', '备注（只给人看，引擎不读）', 'str'),
  block: P('block', '封锁/无效的对象', 'str'),
  all: P('all', '是否作用于全部', 'bool'),
  scope: P('scope', '作用范围', 'str'),
  ignore_companion: P('ignore_companion', '同行者/宝物不可替挡', 'bool'),
  blockTreasureDraw: P('blockTreasureDraw', '封锁抽宝物牌', 'bool'),
  blockCombat: P('blockCombat', '封锁发起对战', 'bool'),
  winMana: P('winMana', '获胜恢复法力', 'int'),
  winDamage: P('winDamage', '胜则追伤', 'int'),
  loseDamage: P('loseDamage', '败则自伤', 'int'),
  absorbs: P('absorbs', '可替挡次数', 'int'),
  discardSelf: P('discardSelf', '发动后自身进弃牌堆', 'bool'),
  requiresCombat: P('requiresCombat', '需要在对战中', 'bool'),
  threshold: P('threshold', '阈值', 'int'),
  treasure: P('treasure', '宝物牌张数', 'int'),
  spell: P('spell', '法术牌张数', 'int'),
  // 「一回合一次」：同一张牌的这条效果每回合只能发动一次（2026-10-02 用户给【虚天鼎】定的）
  oncePerTurn: P('oncePerTurn', '一回合一次（本回合发动过就不再询问）', 'bool'),
};

/** 效果对象里由专门 UI 负责的键，不进「参数」区（进高级 JSON 区） */
const EFFECT_RESERVED = ['when', 'op', 'event', 'subject', 'phase', 'if'];

/** 卡级字段的中文标签（表单用） */
const CARD_FIELD_LABELS = {
  id: 'ID（唯一标识）',
  name: '牌名',
  type: '类型',
  cost: '角标法力',
  equipCost: '装备时消耗法力',
  realm: '适用境界',
  count: '张数（牌堆里放几张）',
  slots: '占位（同行者占几个放置位）',
  equipSlot: '装备位',
  cat: '品类（实物卡面分类）',
  absorb: '替挡次数（可替你承受任意 N 次伤害）',
  activateDiscardSelf: '主动发动后自身进弃牌堆',
  cardCostDiscount: '使用宝物/法术牌时法力 -（最低为 1）',
  text: '卡文（玩家看到的那段字）',
  note: '备注（只给人看）',
  effects: '效果列表',
  tiers: '多境界档位',
};

/**
 * 合并提示：effect-meta 里 OPS[op].params 声明的字段优先排在最前（唯一来源优先），
 * 其余提示字段按本表顺序跟在后面。
 */
function mergeHints(op, opsMeta) {
  const declared = (opsMeta && opsMeta[op] && Array.isArray(opsMeta[op].params)) ? opsMeta[op].params : [];
  const own = PARAM_HINTS[op] || [];
  const out = [];
  const seen = {};
  for (const k of declared) {
    if (seen[k]) continue;
    seen[k] = 1;
    out.push(FIELD_LABELS[k] || P(k, k, 'str'));
  }
  for (const p of own) {
    if (seen[p.key]) continue;
    seen[p.key] = 1;
    out.push(p);
  }
  return out;
}

module.exports = {
  PARAM_HINTS, FIELD_LABELS, EFFECT_RESERVED, CARD_FIELD_LABELS, DECK_OPTS,
  mergeHints,
  /** 给 /api/meta 用的快照：op → 参数提示（已与 effect-meta 的 params 合并） */
  hintsSnapshot(opsMeta) {
    const out = {};
    for (const op of Object.keys(opsMeta || {})) out[op] = mergeHints(op, opsMeta);
    return out;
  },
};
