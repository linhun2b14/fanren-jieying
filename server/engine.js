'use strict';
// 《凡人修仙传：结婴之战》规则引擎（v2 · 对齐官方教学视频）
//
// 规则真相源：docs/规则文档.md，取自官方规则讲解视频逐句转写（ref/transcript.txt）。
// 与初版的关键差异（均为视频明确讲述，非推测）：
//   1. 对战骰点是**查表加成**，不是直接加战力：1点→+0，2~5点→+1，6点→+2
//   2. 晋升 = 灵根牌「灵气值门槛」+ 面板「消耗值」+ 掷骰门槛，两者同时成立
//   3. 不可向低于自己两个境界的修士发起对战
//   4. 败方若是高境界：-1生命 -2灵气 且被对方抽1张手牌；败方低境界：仅 -1生命（不扣灵气）
//   5. 每回合只恢复 1 点法力值
//   6. 灵气值 = 灵气区里灵气牌的**张数**；扣除灵气值 = 把灵气牌放回灵气牌堆底部
//   7. 有一局一次的「闭关」机制
//   8. 淘汰对手者可从对方剩余卡牌中任选 3 张加入手牌
//
// 纯状态机：所有函数只读写传入的 state，便于单测与回放。

const { cards, buildDecks, DECKS, normalizeCard } = require('./cards');
const META = require('./effect-meta');

const REALMS = ['凡人', '炼气期', '筑基期', '结丹期', '元婴期'];

// 灵根牌：数值 = 晋升到该境界所需**持有**的灵气值
const ROOTS = {
  tian:   { key: 'tian',   name: '天灵根', costs: [5, 8, 12, 16],  rank: 0 },
  shuang: { key: 'shuang', name: '双灵根', costs: [5, 8, 13, 17],  rank: 1 },
  san:    { key: 'san',    name: '三灵根', costs: [6, 9, 14, 18],  rank: 2 },
  wei:    { key: 'wei',    name: '伪灵根', costs: [7, 9, 15, 19],  rank: 3 },
};

// 面板「当前境界」下方标注的晋升条件（索引 = 目标境界 - 1）
const PROMOTE_CONSUME = [0, 2, 2, 3];   // 炼气期 / 筑基期 / 结丹期 / 元婴期
// 用户确认实物：结丹期掷骰 ≥4、元婴期掷骰 ≥5
// （视频旁白演示「筑基→结丹」时说 ≥4，与实物一致；先前从面板截图读出的 ≥3 是误读）
const PROMOTE_DICE = [0, 0, 4, 5];

const HAND_LIMITS = { treasure: 6, spell: 2, companion: 2 };  // 视频原话
const HP_MAX = 6;                       // 用户确认实物：满血 6
const MANA_MAX = 12;                    // 用户确认实物：法力最大值 12
const MANA_MAX_MORTAL = 6;              // 用户确认实物：凡人期法力上限只有 6
const MANA_REGEN = 1;                   // 视频原话「每回合开始都能恢复一点法力值」
const START_MANA = 1;
const OVERREACH_MANA = 1;               // 视频原话「额外多消耗一点法力值强行使用」

// 装备类法宝付费规则（2026-10-05 用户重新裁定，**取代旧的"按境界分高低档"**）：
//   卡文带「（装备时不消耗【法力值】）」→ 装备**不消耗**法力，发动其效果时才消耗（费用印在效果上）
//   没写这句话                     → 装备**时**消耗（equipCost 优先，否则角标法力），发动效果不再消耗
// EQUIP_HIGH_TIER_MIN_REALM 仅为旧测试/工具兼容保留导出，引擎内部不再使用。
const EQUIP_HIGH_TIER_MIN_REALM = 2;

/** 卡文是否写了「装备时不消耗【法力值】」——装备费的唯一判据（见上方裁定） */
function equipFreeByText(def) { return /装备时不消耗/.test((def && def.text) || ''); }

// 骰点 → 额外战力值（视频原话：1点不触发；2/3/4/5触发额外加1；6点为最高附加加2）
function diceToBonus(pip) { return pip >= 6 ? 2 : pip >= 2 ? 1 : 0; }

// 效果元数据全部从 server/effect-meta.js 派生 —— 唯一来源，不再手工维护 4 份副本。
//   NEEDS_TARGET   ：打出时必须先指定目标（漏登记 → 牌被白白消耗）
//   REQUIRES_COMBAT：只能在对战中使用（漏登记 → 效果落空）
//   TIE_KINDS      ：平局改判窗口可用的 op
//   PASSIVE_OPS    ：常驻数值 op（由 passives() 汇总）
//   COMBAT_KINDS   ：只作为**读不到 effects 时的兜底**（手写合成卡）；同样由元数据派生
const NEEDS_TARGET = new Set(META.needsTargetOps());
const REQUIRES_COMBAT = new Set(META.requiresCombatOps());
const TIE_KINDS = new Set(META.tieOps());
const PASSIVE_OPS = new Set(META.passiveOps());
const COMBAT_KINDS = new Set(META.LEGACY_COMBAT_OPS);

// ---------------------------------------------------------------- RNG

function nextRandom(state) {
  state.rngSeed = (state.rngSeed + 0x6d2b79f5) | 0;
  let t = state.rngSeed;
  t = Math.imul(t ^ (t >>> 15), 1 | t);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function d6(state) {
  // ⚠️ **测试注入点**：`state.forcedDice = [6, 1, ...]` 会按 FIFO 逐个取用（取完就回到真随机）。
  // 为什么要有它：牌池一改（加卡/改张数），**所有靠种子决定的骰点都会漂**，于是"晋升掷骰≥5"
  // 这类写死种子的断言会假红（本项目为此红过好几次，见 tests/combo-discount-test 的历史）。
  // 有了它，涉及骰点的用例可以写成确定性的，而不是去猜种子。
  if (state && Array.isArray(state.forcedDice) && state.forcedDice.length) {
    const v = state.forcedDice.shift();
    if (typeof v === 'number' && v >= 1 && v <= 6) return v;
  }
  return 1 + Math.floor(nextRandom(state) * 6);
}

// ---------------------------------------------------------------- 工具

let UID = 1;
function mk(uid, id) { return { uid: uid, id: id }; }
function cardDef(id) {
  for (const d of DECKS) {
    const c = cards()[d].find((x) => x.id === id);
    if (c) return c;
  }
  return null;
}
function deckOf(id) {
  for (const d of DECKS) if (cards()[d].some((x) => x.id === id)) return d;
  return null;
}
/** 这张牌"打出去时"的时机：'combat' = 对战出牌窗口内可用，'turn' = 自己回合行动阶段可用。
 *  看的是「打出时会立刻执行的效果」（playNowEffects），而不是场上的自动触发效果。 */
function timingOf(def) {
  if (!def) return 'turn';
  const now = playNowEffects(def);
  if (now.length) return now.some((e) => META.isCombatEffectByTiming(e)) ? 'combat' : 'turn';
  if (!def.effect) return 'turn';
  return COMBAT_KINDS.has(def.effect.kind) ? 'combat' : 'turn';
}
function p(state, id) { return state.players.find((x) => x.id === id); }
function log(state, kind, text, payload) {
  state.log.push({ seq: state.log.length + 1, kind: kind, text: text, payload: payload || null });
  if (state.log.length > 500) state.log.splice(0, state.log.length - 500);
}
function alive(state) { return state.players.filter((x) => !x.out); }

/**
 * 补齐对战对象里 v6 新增的各个容器。
 * 这样即使是对旧快照、手工构造的 combat 对象，效果结算也不会因为字段缺失而崩。
 */
function ensureCombat(c) {
  if (!c) return c;
  ['bonus', 'debuff', 'dice', 'diceBonus', 'total', 'dicePenalty', 'noPenalty', 'flatPower',
    'blocked', 'loseSave', 'loseRetaliate', 'forceReroll', 'skipDice', 'winBonusDamage',
    'winMana', 'winDrawQi', 'winStealTreasure', 'selfLoseDamage', 'resultUsed', 'compPaid',
    'tieUsed', 'tiePassed'].forEach((k) => { if (!c[k] || typeof c[k] !== 'object') c[k] = {}; });
  return c;
}
function deckLabel(d) {
  return { treasure: '宝物牌', spell: '法术牌', companion: '同行者', qi: '灵气牌' }[d] || d;
}

// ---------------------------------------------------------------- 派生数值

function allEquips(pl) { return pl.equip.concat(pl.spells); }
function manaCap(pl) { return pl.realm === 0 ? MANA_MAX_MORTAL : MANA_MAX; }
function isHighTierEquip(def) { return (def.realm || 0) >= EQUIP_HIGH_TIER_MIN_REALM; }
function isCombatEffect(kind) {
  return kind === 'dice_bonus' || kind === 'combat_bonus' || kind === 'combat_debuff'
    || kind === 'reroll_dice';}

/**
 * 出牌时机校验开关。
 *   **默认开启** —— 按 `when` 与当前窗口精确拦牌。
 *     这样卡文里的时机词才真正生效，也修掉了两个真 bug：
 *       · 【天星大阵】「在对战平局时使用」以前在平局窗口里打不出来
 *       · 【颠倒五行阵】「对方投掷骰子后」以前对方还没投就能打
 *   `FANREN_TIMING_ENFORCE=0` 可关回"宽松模式"（任何对战窗口都能打对战牌），用于出问题时的回滚排查。
 */
const TIMING_ENFORCE = process.env.FANREN_TIMING_ENFORCE !== '0';

/** 效果签名：判断两条效果是不是"同一条"（顶层与档位的冗余拷贝去重用） */
function effSig(e) {
  return [e.op, e.when || '', e.event || '', e.subject || '', e.value == null ? '' : e.value, e.deck || ''].join('|');
}

/**
 * 「一回合一次」的效果（数据里写 `oncePerTurn: true`）。
 *   —— 同一张牌的**同一条效果**在一个回合内只能发动一次（跨玩家回合都算；回合开始时重置）。
 * 用户 2026-10-02 给【虚天鼎】定的规矩：第一条效果"使对方任意 1 张法术/宝物牌无效"不这么限就"有点赖"。
 *
 * ⚠️ 这里有**三套**"每回合一次"，别混用：
 *   · `pl.equipTrigUsed[key]` —— 装备的**自动触发**（【银月】装备即抽灵气），按卡 id 记账；
 *   · `pl.activateUsed[uid]`   —— `when:'activate'` 的**主动技能按钮**，按 uid 记账（整张牌一次）；
 *   · `state.turnUses`（本条） —— **锁链里的时点响应**，按 `玩家 → uid → 效果签名` 记账，
 *     所以同一张牌的两条效果各算各的（【虚天鼎】只有第一条受限）。
 */
function usedThisTurn(state, pl, inst, e) {
  if (!e || !e.oncePerTurn) return false;
  const byCard = state.turnUses && state.turnUses[pl.id];
  const uid = inst && inst.uid;
  return !!(byCard && byCard[uid] && byCard[uid][effSig(e)]);
}
function markTurnUse(state, pl, inst, e) {
  if (!e || !e.oncePerTurn) return;
  const uid = inst && inst.uid;
  state.turnUses = state.turnUses || {};
  state.turnUses[pl.id] = state.turnUses[pl.id] || {};
  state.turnUses[pl.id][uid] = state.turnUses[pl.id][uid] || {};
  state.turnUses[pl.id][uid][effSig(e)] = true;
}

/**
 * 占位符替换（「掷骰分支」的子效果用）：把 `"$face"` / `"$lostHp"` 换成本次的实际数字。
 * 深拷贝后再改，**不动卡池里的原对象**（卡池是全局缓存的，写脏了会连带污染别的对局）。
 */
const PLACEHOLDER_RE = /^\$(face|lostHp)$/;
function fillPlaceholders(effect, vars) {
  if (!effect || typeof effect !== 'object') return effect;
  if (Array.isArray(effect)) return effect.map((x) => fillPlaceholders(x, vars));
  const out = {};
  for (const k of Object.keys(effect)) {
    const v = effect[k];
    if (typeof v === 'string' && PLACEHOLDER_RE.test(v)) {
      const name = v.slice(1);
      out[k] = typeof vars[name] === 'number' ? vars[name] : 0;
    } else if (v && typeof v === 'object') {
      out[k] = fillPlaceholders(v, vars);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * ⭐「应对」（2026-10-05 用户裁定）：**只有带应对的卡/效果才能进【斗法】链**（＝能被破招）。
 *   · 卡级字段 `card.response = true`（卡面印的"应对"），效果级 `effect.response` 可覆盖：
 *     `response:false` = 这条效果不参与破招（例如一张应对牌里那条"装备即生效"的效果）。
 *   · ⚠️ 只有**响应型窗口**才问应对（见 META.needsResponse）：被指定为目标 / 对战可选发动 /
 *     对方出牌 / 投骰前后 / 对战结算 / 受伤。阶段内可选窗口（探索替换、晋升减消耗…）不算破招。
 */
function hasResponse(def, e) {
  if (e && e.response !== undefined) return e.response === true;
  return !!(def && def.response === true);
}

/**
 * ⭐「可用 N 次」（卡面"此【宝物牌】可使用2次"）：`card.uses = N`，用掉几次记在**那张牌自己**身上
 * （`inst.uses_used`，跟着实例走 —— 同一张卡的两个副本各算各的）。
 *   用完 = 不能再被摆进候选 / 不能再主动发动（**卡留在场上**，由玩家自己决定要不要撤下）。
 */
function usesLeft(def, inst) {
  const max = def && def.uses;
  if (!max) return Infinity;
  return max - ((inst && inst.uses_used) || 0);
}
function markUse(pl, def, inst) {
  if (!def || !def.uses || !inst) return;
  inst.uses_used = (inst.uses_used || 0) + 1;
}

/**
 * 「本回合打出过哪些牌」——给 `if.playedThisTurn` 用（**套装/联动**的通用写法：
 * "和另一张牌配合"在规则上就是"本回合先后打出过这两张"）。
 * 每回合开始清零（`startTurn`），打出与破招打出两条路径都记（`doPlay` / `respondPlay`）。
 */
function markPlayed(state, pl, def) {
  if (!state || !pl || !def || !def.name) return;
  state.turnPlayed = state.turnPlayed || {};
  const list = state.turnPlayed[pl.id] = state.turnPlayed[pl.id] || [];
  list.push(def.name);
}

/**
 * 取一张卡「当前生效」的效果条目数组。
 *   有 `tiers`（多境界档位）时，实例上选定的那一档**取代**卡面同签名效果；
 *   但顶层 effects 里**任何档位都没有**的条目是全档共享的，要并入
 *   —— 否则【青元剑诀】写在顶层的「对战启用费」入口（enable_equip_combat）
 *   会被档位永远遮蔽：付费窗口问不到它，装备的对战效果整卡作废（E2 回归）。
 *   【火弹术】顶层那条是第 0 档的冗余拷贝（win_steal_treasure），按签名去重后不会双倍结算。
 *   无 tiers 时就是卡面的 `effects`。
 */
function effectsOf(def, inst) {
  if (!def) return [];
  // ⭐ 实物【金魁】"使场上任意 1 张【宝物牌】/【法术牌】无效" —— 被无效的那张牌**效果全停**
  //    （常驻加成、主动技能、时点响应、对战启用费都不再产生）。
  //    这里是"这张牌有什么效果"的**唯一入口**，一处拦住即可；卡还在场上，只是成了空壳
  //    （玩家仍可自己撤下它，见行动阶段的撤下动作）。
  if (inst && inst.nullified) return [];
  // 兜底：测试/手写的合成卡对象绕过了 cards.js 的加载器，这里懒归一化一次
  if (!Array.isArray(def.effects)) normalizeCard(def);
  if (def.tiers && def.tiers.length) {
    const i = Math.min(Math.max(0, (inst && inst.tier) || 0), def.tiers.length - 1);
    const t = def.tiers[i];
    if (t && !Array.isArray(t.effects) && t.effect) t.effects = [effectEntryLazy(t.effect)];
    const tierEffs = (t && t.effects) ? t.effects : [];
    const tierSigs = {};
    for (const tt of def.tiers) {
      if (tt && !Array.isArray(tt.effects) && tt.effect) tt.effects = [effectEntryLazy(tt.effect)];
      for (const e of (tt && tt.effects) || []) tierSigs[effSig(e)] = true;
    }
    const shared = (def.effects || []).filter((e) => !tierSigs[effSig(e)]);
    return shared.concat(tierEffs);
  }
  return def.effects || [];
}

/** 把一个 {kind, ...} 老效果对象转成 {op, when?, ...}（兜底用） */
function effectEntryLazy(src) {
  const e = Object.assign({}, src);
  if (!e.op) { e.op = e.kind; delete e.kind; }
  if (!e.when) e.when = META.defaultWhenFor(e.op);
  return e;
}

/** 这张卡"打出去"的那条效果（自己回合用 / 对战窗口用）。 */
function playEffectOf(def, inst) {
  const l = playNowEffects(def, inst);
  return l.length ? l[0] : null;
}

/**
 * 这次"从手牌打出"时会立刻执行的效果条目。
 *
 * 关键区别：`win` / `lose` / `turn` / `hurt` 这些窗口，**对消耗牌是出牌窗口**
 * （【风云幡】「在对战获胜时使用」就是手里打出去），**对同行者却是场面上的自动触发**
 * （【韩立】的「获胜时夺装备」不需要你打牌）。
 * 所以同行者一律返回空 —— 它的 `place` 效果由 doPlay 的同行者分支单独处理。
 *
 * 少了这一层，【韩立】从手牌招出来时会被它的 `win: steal_equip` 误判成
 * 「需要先指定一位目标修士」而根本放不下来。
 */
function playNowEffects(def, inst) {
  const all = effectsOf(def, inst);
  if (!def) return [];
  if (def.type === 'companion') return [];
  return all.filter((e) => META.isPlayEffect(e) && META.timingKey(e) !== 'place');
}

/** 这张卡所有"可打出"的效果条目（含 place），供 UI/工具枚举用 */
function playEffectsOf(def, inst) {
  const out = [];
  for (const e of effectsOf(def, inst)) if (META.isPlayEffect(e)) out.push(e);
  return out;
}

/**
 * 当前对战里"已经满足"的出牌窗口集合。
 *   双方都没投  → combatStart
 *   我还没投    → beforeMyRoll
 *   我已投      → afterMyRoll
 *   对方还没投  → beforeFoeRoll
 *   对方已投    → afterFoeRoll
 *   平局阶段    → tie
 * 出牌阶段（combatStart）一旦有人投了骰就不再成立 —— 卡文写「出牌阶段」的牌必须在那之前打。
 */
function satisfiedWindows(state, pl, c) {
  if (!c) return [];
  if (c.stage === 'tie') return ['tie'];
  if (c.stage === 'result') {
    // 结果窗口现在是锁链，按卡主角色给窗口（赢家→win、输家→lose）
    if (c.winnerId === pl.id) return ['win'];
    if (c.loserId === pl.id) return ['lose'];
    return [];
  }
  if (c.stage === 'done') return [];
  // 「谁投过骰」直接看 c.dice —— doRoll 每次都会写进去，手工构造的对战也一样，
  // 不需要额外维护一个 rolled 字段（早期版本读 c.rolled，但那字段从没被赋值过，
  // 导致 beforeMyRoll/afterFoeRoll 这些窗口判定全废）。
  const rolled = c.dice || {};
  const foeId = c.attacker === pl.id ? c.defender : c.attacker;
  const meRolled = !!(rolled[pl.id] || (c.rolled && c.rolled[pl.id]));
  const foeRolled = !!(rolled[foeId] || (c.rolled && c.rolled[foeId]));
  const out = [];
  if (!meRolled && !foeRolled) out.push('combatStart');
  out.push(meRolled ? 'afterMyRoll' : 'beforeMyRoll');
  out.push(foeRolled ? 'afterFoeRoll' : 'beforeFoeRoll');
  return out;
}

/** 比较谓词：want 可以是裸值，也可以是 {lte,lt,gte,gt,eq} */
function cmpOk(want, actual) {
  if (actual === null || actual === undefined) return false;
  if (want === null || want === undefined) return true;
  if (typeof want !== 'object') return actual === want;
  if (want.eq !== undefined && actual !== want.eq) return false;
  if (want.lte !== undefined && !(actual <= want.lte)) return false;
  if (want.lt !== undefined && !(actual < want.lt)) return false;
  if (want.gte !== undefined && !(actual >= want.gte)) return false;
  if (want.gt !== undefined && !(actual > want.gt)) return false;
  return true;
}

/**
 * 条件求值 —— 效果 DSL 的核心。
 * `if` 里多个键之间是 **AND**；`cond` 为空 → 恒真。
 * ctx: { self, foe, target, combat, state, deck, inst }
 *
 * 未知条件键一律**不通过**（fail-closed）：写错条件宁可不出效果，也不要"永远生效"。
 */
function matchConditions(cond, ctx) {
  if (!cond) return true;
  const keys = Object.keys(cond);
  if (!keys.length) return true;
  const c = ctx || {};
  const self = c.self || null;
  const foe = c.foe || null;
  const target = c.targetPl || null;
  const state = c.state || null;
  const combat = c.combat || (state && state.combat) || null;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i], want = cond[k];
    switch (k) {
      case 'hp':
        if (!self || !cmpOk(want, self.hp)) return false;
        break;
      // 「自己的法力值」—— 实物【龙纹四象蟠龙带】"当【法力值】低于3点时…"（主动技能的条件侧）
      case 'mana':
        if (!self || !cmpOk(want, self.mana)) return false;
        break;
      case 'realm':
        // 用**对外生效**的境界：伪丹期（【血凝五行丹】"视作结丹期"）不能只改战力
        if (!self || !cmpOk(want, effRealm(self))) return false;
        break;
      case 'enemyRealm': {
        if (!self || !foe) return false;
        const sr = effRealm(self), fr = effRealm(foe);
        if (want && typeof want === 'object') {
          if (want.higher && !(fr > sr)) return false;
          if (want.lower && !(fr < sr)) return false;
          const rest = Object.assign({}, want);
          delete rest.higher; delete rest.lower;
          if (!cmpOk(rest, fr)) return false;
        } else if (fr !== want) return false;
        break;
      }
      case 'target': {
        if (!self || !target) return false;
        if (want && typeof want === 'object') {
          if (want.notSelf && target.id === self.id) return false;
          if (want.realmHigher && !(effRealm(target) > effRealm(self))) return false;
          if (want.realm && !cmpOk(want.realm, effRealm(target))) return false;
          const rest = Object.assign({}, want);
          delete rest.notSelf; delete rest.realmHigher; delete rest.realm;
          if (!cmpOk(rest, effRealm(target))) return false;
        } else if (effRealm(target) !== want) return false;
        break;
      }
      case 'companion': {
        // 「场上有该同行者」——支持**数组**（这些全都在场）：套装判定，如"【寒蛟】与【离龟】同场"
        if (!self) return false;
        const wants = Array.isArray(want) ? want : [want];
        if (!wants.length) return false;
        if (!wants.every((n) => self.companions.some((y) => { const d = cardDef(y.id); return d && d.name === n; }))) return false;
        break;
      }
      // 「场上有其中任意一位同行者」
      case 'companionAny': {
        if (!self) return false;
        const wants = Array.isArray(want) ? want : [want];
        if (!wants.some((n) => self.companions.some((y) => { const d = cardDef(y.id); return d && d.name === n; }))) return false;
        break;
      }
      // 「自己场上有该牌」—— 储物袋 + 法术区 + 同行者 + 傀儡，按**牌名**比（套装通用写法）
      case 'onField':
      case 'onFieldAny': {
        if (!self) return false;
        const wants = Array.isArray(want) ? want : [want];
        const names = [];
        for (const arr of [self.equip || [], self.spells || [], self.companions || [], self.puppets || []]) {
          for (const x of arr) { const d = cardDef(x.id); if (d && d.name) names.push(d.name); }
        }
        const ok = (want === undefined || want === null || wants.length === 0) ? names.length > 0
          : (k === 'onFieldAny' ? wants.some((n) => names.indexOf(n) >= 0) : wants.every((n) => names.indexOf(n) >= 0));
        if (!ok) return false;
        break;
      }
      // 「本回合自己打出过该牌」—— "和另一张牌配合"的通用写法（startTurn 清零，见 markPlayed）
      case 'playedThisTurn': {
        if (!self) return false;
        const played = ((state && state.turnPlayed) || {})[self.id] || [];
        const wants = Array.isArray(want) ? want : [want];
        if (!wants.some((n) => played.indexOf(n) >= 0)) return false;
        break;
      }
      case 'hasEquip':
        if (!self || !!(self.equip && self.equip.length) !== !!want) return false;
        break;
      case 'inCombat':
        if (!!combat !== !!want) return false;
        break;
      // 「先攻／后攻是我」—— 用户 2026-10-05 要求的"发起对战的标记"，
      // 用来写"当你**主动发起**对战时…"这类效果（实物【凤帝】）。没有进行中的对战就永远不成立。
      case 'attacker':
        if (want === false) { if (combat && self && combat.attacker === self.id) return false; break; }
        if (!combat || !self || combat.attacker !== self.id) return false;
        break;
      case 'defender':
        if (want === false) { if (combat && self && combat.defender === self.id) return false; break; }
        if (!combat || !self || combat.defender !== self.id) return false;
        break;
      case 'turnFlag': {
        const tf = (state && state.turnFlags) || null;
        if (!tf || !want) return false;
        for (const f of Object.keys(want)) if (!!tf[f] !== !!want[f]) return false;
        break;
      }
      case 'deck':
        if (c.deck !== want) return false;
        break;
      // 「本次伤害致命」—— 只有"受伤"打断窗口会给这个上下文（还阳术靠它收窄窗口）
      case 'lethal':
        if (!!c.lethal !== !!want) return false;
        break;
      // 「场上有可用的傀儡（还有替伤次数）」—— 【傀儡蜥蜴】靠它决定要不要摆出来问
      case 'puppet': {
        if (!self) return false;
        const pup = (self.puppets && self.puppets[0]) || null;
        if (!!(pup && pup.left > 0) !== !!want) return false;
        break;
      }
      default:
        return false;
    }
  }
  return true;
}

/**
 * 低境界装备的"对战启用费"门：没付钱的，本场对战里它的效果**一律不生效**。
 * 付费方式 = 在「对战·可选发动」时点响应一次（见 enable_equip_combat）。
 * 高境界装备（装备时已付过）和 0 费的直接放行；没有对战上下文时也放行（常驻汇总等场景）。
 */
function equipCombatActive(combat, pl, def, inst) {
  if (!combat || !pl || !def || !inst) return true;
  if (def.type !== 'equip') return true;
  // 只要这件装备**自己印了**「对战启用费」条目，就得先付过那笔费才生效 —— 不分高低境界。
  // 高境界装备本来"装备时已付过"所以放行，但【虚天鼎 乾蓝冰焰】是**两个效果各付各的**：
  // "1.虚天鼎：不消耗法力值，使对方任意1张牌无效"、"2.乾蓝冰焰：消耗1点法力值，本场战力+1"。
  // 所以它必须走"在场可选发动"（用户也这么说："两个效果应该是装备到场上后选择使用"）。
  const hasOwnFee = effectsOf(def, inst).some((e) => e.op === 'enable_equip_combat' && (e.manaCost || 0) > 0);
  if (hasOwnFee) {
    const m0 = combat.equipEnabled && combat.equipEnabled[pl.id];
    return !!(m0 && m0[inst.uid]);
  }
  // 2026-10-05 起不再按境界/角标推导：没印启用费的一律生效
  // （装备时收过费的效果免费；卡文免费但没印启用费的效果也免费）。
  return true;
}

/**
 * 通用效果收集器 —— 替代以前 6 个各自为政的扫描函数。
 *   pl     : 效果的主人
 *   whens  : 要收集的时机（字符串或数组）；传 null 表示"所有时机"
 *   ctx    : { foe, target, combat, state, deck, inst }
 *   scope  : 'equips' | 'companions' | 省略=两者都收
 * 返回 [{ def, inst, eff }]
 */
function collectEffects(pl, whens, ctx, scope) {
  if (!pl) return [];
  // ⚠️ 时机比较一律走**归一化键**（META.wantKeys / META.timingKey）：这样 `when:'win'` 与
  //    `{event:'combatResult',phase:'win'}` 完全等价，卡池数据从旧写法迁到总线坐标时
  //    这些"自动收集"通道不会失联。（2026-10-02 实测：不做归一化直接迁数据，14 套测试会挂）
  const want = whens == null ? null : META.wantKeys(whens);
  const subjects = [];
  if (scope !== 'companions') for (const inst of allEquips(pl)) subjects.push(inst);
  if (scope !== 'equips') for (const inst of pl.companions) subjects.push(inst);
  // 傀儡位（独立于储物袋/法术区/同行者）也要被收集到 —— 实物【傀儡蜥蜴】。
  // 它的"替你挨这一下"是「受伤」时点的响应，扫不到就永远开不出询问窗口。
  if (scope !== 'companions') for (const inst of (pl.puppets || [])) subjects.push(inst);
  const out = [];
  const base = ctx || {};
  for (const inst of subjects) {
    const def = cardDef(inst.id);
    if (!def) continue;
    for (const eff of effectsOf(def, inst)) {
      // 时机比较用归一化键（一条效果可能同时写了 when 与 event，两种都要认）
      if (want && !META.timingKeys(eff).some((k) => want.indexOf(k) >= 0)) continue;
      // 低境界装备的"对战启用费"没付 → 它在本场对战里的效果一律不生效（【绿煌剑】的"获胜时+1伤害"也走这里）。
      // ⚠️ `enable_equip_combat` 本身是"付费启用"那个动作，必须豁免，否则永远开不出询问窗口。
      if (eff.op !== 'enable_equip_combat' && !equipCombatActive(base.combat, pl, def, inst)) continue;
      const c = Object.assign({}, base, { self: pl, def: def, inst: inst });
      // 没显式给 foe 时，从当前对战里推出来（enemyRealm 条件要用）
      if (c.foe === undefined && c.combat && c.state) {
        const fid = c.combat.attacker === pl.id ? c.combat.defender : c.combat.attacker;
        c.foe = fid ? p(c.state, fid) : null;
      }
      if (!matchConditions(eff.if, c)) continue;
      out.push({ def: def, inst: inst, eff: eff });
    }
  }
  return out;
}

/**
 * 取一张装备牌「当前生效的效果」。
 * @deprecated 新代码请用 effectsOf() / collectEffects()。
 * 这里把新数据（`tiers[i].effects[0]` 用 `op`）转回旧的 `{kind, ...}` 形状，
 * 好让老调用点和老测试脚本继续可用（兼容层永久保留）。
 */
function tierEffect(def, inst) {
  if (!def) return null;
  if (def.tiers && def.tiers.length) {
    const i = Math.min(Math.max(0, (inst && inst.tier) || 0), def.tiers.length - 1);
    const t = def.tiers[i];
    if (!t) return null;
    if (t.effect) return t.effect;
    const e = t.effects && t.effects[0];
    if (!e) return null;
    const back = Object.assign({}, e);
    back.kind = back.op;
    delete back.op;
    return back;
  }
  return def.effect || null;
}
/** 该玩家当前境界在该装备上最高可选的档位下标（无 tiers 时返回 0）。 */
function maxTierFor(def, realm) {
  if (!def || !def.tiers || !def.tiers.length) return 0;
  let best = 0;
  for (let i = 0; i < def.tiers.length; i++) {
    if ((def.tiers[i].realm || 0) <= realm) best = i;
  }
  return best;
}

/**
 * 与第 i 档**同境界**的全部档位下标（含 i 自己）。
 *
 * 为什么要区分这个：`tiers` 在数据里承担了**两种完全不同的语义**——
 *   ① **境界档**（【青元剑诀】炼气/筑基/结丹三档，realm 各不相同）：同一个效果随境界升级；
 *   ② **同境界多选**（【火弹术】两档 realm 都是 0）：即卡文的「二选一」，是**并列的选项**，不是升级。
 * 用户裁定（2026-10-02）：**多档位牌一律自动适配当前境界**。这条对 ① 成立；
 * 对 ② 不能照搬 —— 自动取"最高档"只会永远是最后一个选项，把另一半直接打死。
 * 所以：境界档自动，同境界多选仍然由玩家在用时选（见 resolveTier）。
 */
function tierSiblings(def, i) {
  if (!def || !def.tiers || !def.tiers.length) return [];
  if (!(i >= 0 && i < def.tiers.length)) return [];
  const r = def.tiers[i].realm || 0;
  const out = [];
  for (let k = 0; k < def.tiers.length; k++) {
    if ((def.tiers[k].realm || 0) === r) out.push(k);
  }
  return out;
}

/** 这张卡是不是"同境界多选"（卡文二选一）—— 任一境界下挂了不止一个档位 */
function isEitherOr(def) {
  if (!def || !def.tiers || !def.tiers.length) return false;
  for (let i = 0; i < def.tiers.length; i++) {
    if (tierSiblings(def, i).length > 1) return true;
  }
  return false;
}

/**
 * 定档：把"请求里想用的档位"归一成最终该用哪一档。
 *   境界档（各档 realm 不同）→ **一律自动取当前境界的最高可用档**（用户裁定，手选已废）；
 *   同境界多选（二选一）→ 请求里指定的那一项**照用**（前提是它这一档境界够），没指定才自动取最高。
 */
function resolveTier(def, realm, want) {
  if (!def || !def.tiers || !def.tiers.length) return 0;
  const auto = maxTierFor(def, realm);
  if (typeof want === 'number' && want >= 0 && want < def.tiers.length
    && (def.tiers[want].realm || 0) <= realm
    && tierSiblings(def, want).length > 1) {
    return want;
  }
  return auto;
}

/**
 * 让某玩家场上所有带档位的牌**重新对齐当前境界**（晋升后调用）。
 * 境界只升不降，所以这里的档位只会往上走 —— 玩家晋升后手里的【青元剑诀】自动换成更高的档，
 * 不需要重新装备（"自动适配当前境界"这条裁定的另一半）。
 */
function syncEquipTiers(pl) {
  for (const pool of [pl.equip, pl.spells]) {
    for (const inst of pool || []) {
      const def = cardDef(inst.id);
      if (def && def.tiers && def.tiers.length) inst.tier = maxTierFor(def, pl.realm);
    }
  }
}

/** 常驻被动。由 effect-meta 的 passive op 集合决定要汇总哪些字段。
 *  战斗类走 activateCombatEquips（低境界装备要付激活费），不在这里。
 *
 *  `promote_discount` 按效果上的 `on` 拆成两个键（和一次性折扣同一条规矩）：
 *    on 缺省/'threshold' → promote_discount         减「门槛」（灵根符上印的"需达到"）【玄骨】
 *    on:'consume'        → promote_discount_consume 减「消耗」（晋升时真正扣掉的量）【六翼霜蜈】【辛如音】 */
function passives(pl) {
  const out = { damage_reduction: 0, mana_regen_bonus: 0,
    hand_limit_bonus: 0, promote_discount: 0, promote_discount_consume: 0, damage_shield: 0, reroll: 0 };
  for (const x of collectEffects(pl, null, { self: pl })) {
    const op = x.eff.op;
    if (!PASSIVE_OPS.has(op)) continue;           // 只汇总元数据里登记为"常驻"的 op
    const key = (op === 'promote_discount' && x.eff.on === 'consume') ? 'promote_discount_consume' : op;
    if (typeof x.eff.value === 'number') out[key] += x.eff.value;
    if (op === 'reroll') out.reroll += 1;
  }
  return out;
}

/** 同行者的「对战发生时」效果（无境界限制）。需要对战上下文以支持条件效果。
 *  一条同行者可以有多条对战效果（如【凌玉灵】骰点+1 与 战后回法力），DSL 天然支持。
 *  带 `manaCost` 的效果要先付费启用（【温天仁】对战中消耗 3 点法力），付不起则本场不生效。 */
function companionCombat(state, pl, c) {
  let bonus = 0, diceBonus = 0, rerollDice = 0;
  const ctx = { self: pl, state: state, combat: c || state.combat };
  const paid = (c && c.compPaid && c.compPaid[pl.id]) || null;
  for (const x of collectEffects(pl, META.COMBAT_BONUS_KEYS, ctx, 'companions')) {
    const e = x.eff, v = e.value || 1;
    if (typeof e.manaCost === 'number' && e.manaCost > 0) {
      // 只认本场对战开始时付过费的那几条（key 用 "卡id#序号"）
      const key = x.def.id + '#' + (e.manaCost);
      if (!paid || !paid[key]) continue;
    }
    if (e.op === 'combat_bonus') bonus += v;
    else if (e.op === 'dice_bonus') diceBonus += v;
    else if (e.op === 'combat_debuff') bonus -= v;
    // 「对战时额外投 1 次骰子，取点数最大值」—— 实物【银月】。
    // 以前这里漏了这个分支，所以银月的重掷**从来没生效过**（只有装备那条通道会算 rerollDice）。
    else if (e.op === 'reroll_dice') rerollDice += v;
  }
  return { bonus: bonus, diceBonus: diceBonus, rerollDice: rerollDice };
}

/**
 * 对战开始时给带法力消耗的同行者效果扣费（每场一次，平局二轮不重复扣）。
 * 结果记在 c.compPaid[玩家id] 里，companionCombat() 据此决定哪几条生效。
 */
function activateCombatCompanions(state, pl) {
  const paid = {};
  for (const x of collectEffects(pl, META.COMBAT_BONUS_KEYS, { self: pl, state: state }, 'companions')) {
    const e = x.eff;
    if (typeof e.manaCost !== 'number' || e.manaCost <= 0) continue;
    const key = x.def.id + '#' + e.manaCost;
    if (paid[key]) continue;
    if (pl.mana < e.manaCost) {
      log(state, 'info', `${pl.name} 法力值不足 ${e.manaCost} 点，同行者【${x.def.name}】本场对战效果不生效。`);
      continue;
    }
    pl.mana -= e.manaCost;
    log(state, 'mana_spend', `${pl.name} 消耗 ${e.manaCost} 点法力值，启用同行者【${x.def.name}】的对战效果。`, { player: pl.id, mana: pl.mana });
    paid[key] = true;
  }
  return paid;
}

/**
 * 结算某位修士在这场对战中由**装备**提供的战力。
 *   低境界装备（凡人/炼气）：角标法力是**对战启用费** —— 现在改成**由玩家在「对战·可选发动」时点决定**
 *     （用户判据：需要付费的都要询问，付不起自动跳过）。这里只统计**已经付过费启用**的那些，
 *     **不再自动扣费**；结果存进 combat.equipBonus，避免平局二轮重复算。
 *   高境界装备（筑基+）  ：装备时已付过，本场免费，一律生效。
 * 每场对战只在开始结算一次。
 */
function activateCombatEquips(state, pl, c) {
  let bonus = 0, diceBonus = 0, paid = 0, rerollDice = 0;
  const enabled = (c && c.equipEnabled && c.equipEnabled[pl.id]) || null;
  for (const inst of allEquips(pl)) {
    const def = cardDef(inst.id);
    if (!def) continue;
    // 「这件装备是不是对战相关」——按**时点**判，不是只按 op 判。
    // 早期只看 isCombatEffect(op)，于是【绿煌剑】（效果是"获胜时对方额外受1点伤害"）
    // 被当成"没有对战效果"而**从不收低境界启用费**。凡是落在对战窗口/常驻修正上的效果都算。
    const relevant = effectsOf(def, inst).filter((e) => {
      if (e.op === 'enable_equip_combat') return false;   // 它自己只是"付费启用"的标记，不加成
      // 常驻对战修正（低境界装备"本场生效"的效果，如【黑血刀】骰点 +2）—— 不占时点，一律算对战相关
      if (e.when === 'standing') return true;
      const t = META.timingOfEffect(e);
      if (!t || !t.event) return false;
      return isCombatEffect(e.op)
        || t.event === 'roll' || t.event === 'combatResult'
        || t.event === 'combatEnd' || t.event === 'combatDeclare';
    });
    if (!relevant.length) continue;
    // 自己印了「对战启用费」的 → 必须先付过费（付不起不生效）；
    // 其余一律生效（装备时收过费的 / 卡文免费但没印启用费的）——2026-10-05 起不再按境界分档。
    const ownFee = effectsOf(def, inst).some((e) => e.op === 'enable_equip_combat' && (e.manaCost || 0) > 0);
    if (ownFee && !(enabled && enabled[inst.uid])) continue;
    for (const e of relevant) {
      // 「主动使用」类效果（带 event、可被时点询问的那种）**不能当常驻加成自动算** ——
      // 它们要玩家在时点窗口里发动（可能还要付 manaCost）。以前这里不看 event：
      // 用户 2026-10-02 把【虚天鼎】写成 event:'combatPlay'/'roll' 时，战力 +1 被**白送**，
      // 而且 manaCost 在这条通道根本不收。带 event 的一律走锁链。
      if (e.event && boardAskable(def, e)) continue;
      if (e.op === 'dice_bonus') diceBonus += e.value || 1;
      else if (e.op === 'combat_bonus') bonus += e.value || 1;
      else if (e.op === 'combat_debuff') bonus -= e.value || 1;
      else if (e.op === 'reroll_dice') rerollDice += e.value || 1;
      // 「放弃掷骰，战力固定为 N（不可被增减）」—— 实物【敛气术】（装备类法术，装上即生效）
      else if (e.op === 'flat_power') {
        if (!c) continue;
        c.flatPower[pl.id] = e.value || 0;
        log(state, 'info', `${pl.name} 的【${def.name}】生效：本场对战战力固定为 ${e.value || 0} 点。`);
      }
      // 档位单独印了法力消耗的（如【虚天鼎 乾蓝冰焰】第一档免费、第二档 1 点）—— 这条仍是自动的（另说）
      const tm = META.isCombatWindow(e.when) ? tierManaCost(def, inst) : 0;
      if (tm > 0) {
        if (pl.mana < tm) {
          log(state, 'info', `${pl.name} 法力值不足 ${tm} 点，【${def.name}】该档效果本场不生效。`);
          continue;
        }
        pl.mana -= tm;
        paid += tm;
        log(state, 'mana_spend', `${pl.name} 消耗 ${tm} 点法力值，启用【${def.name}】的档位效果。`, { player: pl.id, mana: pl.mana });
      }
    }
  }
  return { bonus: bonus, diceBonus: diceBonus, paid: paid, rerollDice: rerollDice };
}

/** 该装备当前所选档位自己印的法力消耗（没写就是 0） */
function tierManaCost(def, inst) {
  if (!def || !def.tiers || !def.tiers.length) return 0;
  const i = Math.min(Math.max(0, (inst && inst.tier) || 0), def.tiers.length - 1);
  const t = def.tiers[i];
  return (t && typeof t.manaCost === 'number') ? t.manaCost : 0;
}

/**
 * 「使用超过当前境界的【宝物牌】时，投掷 1 次骰子，点数 ≥3 不需要额外消耗法力值」
 * —— 实物【钟卫娘】。返回 true 表示这次越级免掉了额外法力。
 * 每次越级都会重新掷骰（卡文没写每回合几次）。
 */
function overreachSaved(state, pl) {
  const list = collectEffects(pl, null, { self: pl, state: state }).filter((x) => x.eff.op === 'overreach_dice_save');
  if (!list.length) return false;
  const e = list[0].eff;
  const need = e.min == null ? 3 : e.min;
  const roll = d6(state);
  const ok = roll >= need;
  log(state, 'roll', `${pl.name} 的同行者【${list[0].def.name}】发动：掷出 ${roll} 点${ok ? `（≥${need}）越级使用不需要额外消耗法力值` : `（＜${need}）仍需额外消耗 1 点法力值`}。`,
    { player: pl.id, value: roll, scope: 'overreach' });
  return ok;
}

/**
 * 「每回合 1 次，装备任意【装备类宝物牌】时抽 1 张灵气牌」—— 实物【银月】。
 * 每张牌每回合各限一次（用 pl.equipTrigUsed 记账，回合开始清空）。
 */
function fireEquipTriggers(state, pl) {
  pl.equipTrigUsed = pl.equipTrigUsed || {};
  for (const x of collectEffects(pl, 'equip', { self: pl, state: state })) {
    const key = x.def.id;
    if (pl.equipTrigUsed[key]) continue;
    pl.equipTrigUsed[key] = true;
    log(state, 'info', `同行者【${x.def.name}】的装备触发效果生效。`);
    resolveEffect(state, pl, x.eff, { state: state }, { source: 'companion', def: x.def, inst: x.inst });
  }
}

function manaRegen(pl) { return MANA_REGEN + passives(pl).mana_regen_bonus; }

/** 「使用任意【宝物牌】/【法术牌】时，法力值消耗 -N（最低为 1）」—— 实物【玄骨】 */
function cardCostDiscount(pl) {
  let n = 0;
  for (const inst of pl.companions) {
    const def = cardDef(inst.id);
    if (def && typeof def.cardCostDiscount === 'number') n += def.cardCostDiscount;
  }
  return n;
}

/** 同行者「受伤时立即恢复法力/生命」—— 实物【燕如嫣】回 2 点法力、【慕沛灵】回 1 点法力。
 *  （用户裁定：【慕沛灵】第 2 条是**回法力**不是回血——原始抄录此处被手指挡住写作【??值】，
 *   当时按「生命值」猜的，2026-XX 由用户更正。返回 { mana, heal, names }） */
function hurtMana(pl) {
  let mana = 0, heal = 0; const names = [];
  for (const x of collectEffects(pl, 'hurt', { self: pl })) {
    if (x.eff.op === 'mana') { mana += x.eff.value || 1; names.push(x.def.name); }
    else if (x.eff.op === 'heal') { heal += x.eff.value || 1; names.push(x.def.name); }
  }
  return { mana: mana, heal: heal, names: names };
}

/** 场上有没有带某个「常驻·对战修正」op 的牌（同行者/装备都算）—— 实物【南陇侯】的 `ignore_enemy_equips` */
function standingHas(pl, op) {
  if (!pl) return false;
  for (const x of collectEffects(pl, 'standing', { self: pl })) {
    if (x.eff && x.eff.op === op) return true;
  }
  return false;
}

/** 同行者「生命值濒危时自救」—— 实物【元瑶】。返回 { heal, discardSelf, name, inst } */
function lowHpRescue(pl) {
  for (const x of collectEffects(pl, 'lowHp', { self: pl })) {
    if (x.eff.op !== 'lowHp' && x.eff.op !== 'heal' && x.eff.op !== 'low_hp_rescue') continue;
    return { heal: x.eff.value || 1, discardSelf: x.eff.discardSelf !== false, name: x.def.name, inst: x.inst };
  }
  return null;
}

/** 同行者「对战结束后不论输赢额外恢复法力」—— 实物【凌玉灵】 */
function afterCombatMana(pl) {
  let n = 0; const names = [];
  for (const x of collectEffects(pl, 'afterCombat', { self: pl })) {
    if (x.eff.op === 'after_combat_mana') { n += x.eff.value || 1; names.push(x.def.name); }
    else if (x.eff.op === 'mana') { n += x.eff.value || 1; names.push(x.def.name); }
  }
  return { value: n, names: names };
}

function promoteThreshold(pl, toRealm) { return ROOTS[pl.root].costs[toRealm - 1]; }
/** 常驻折扣：减「门槛」的【玄骨】 */
function promoteDiscount(pl) { return passives(pl).promote_discount; }
/** 常驻折扣：减「消耗」的【六翼霜蜈】【辛如音】（用户按实物裁定） */
function promoteConsumeDiscount(pl) { return passives(pl).promote_discount_consume; }
/**
 * 这位玩家**对外生效**的境界。
 *   伪丹期（实物【血凝五行丹】"进入伪丹期，【战力值】和结丹期一致"）期间视作更高境界。
 * ⚠️ 以前只有 baseCombat() 认这个，`matchConditions` 里的 `realm` / `enemyRealm` / `target.realmHigher`
 *    仍然拿 `pl.realm` 硬比 —— 于是伪丹期玩家照样会被"对战境界高于你的修士时战力+1"
 *    这类效果打中（用户实盘报过）。所有"比境界"的地方都走这个函数。
 */
function effRealm(pl) {
  if (!pl) return 0;
  // ⚠️ 这里**不要**再 +1：伪丹期是"视作结丹期"，等效境界就是 3。
  //    baseCombat 那层才做 realm+1（战力 = 境界+1），把 +1 挪进来会变成"伪丹 = 元婴"。
  if (pl.pseudoRealm && pl.pseudoRealm.turns > 0) return pl.pseudoRealm.realm || pl.realm;
  return pl.realm || 0;
}

function baseCombat(pl) {
  // 战力 = 生效境界 + 1（伪丹期因此等价于结丹期的战力）
  return effRealm(pl) + 1;
}
function qiOf(pl) { return pl.qiCards.length; }
function equipSlots(pl) { return pl.realm >= 1 ? 2 : 1; }
function baseCompanionSlots(pl) { return pl.realm >= 2 ? 2 : 1; }
function companionSlots(pl) {
  // 【胡月】"可放置【同行者】数量额外＋1"——它是一个**常驻字段**（`companionSlotBonus`），
  // 只要它在场就 +1；它离场时**靠它撑出来的那些位**要一起归还（见 loseCompanion）。
  let bonus = 0;
  for (const c of pl.companions || []) {
    const d = cardDef(c.id);
    if (d && typeof d.companionSlotBonus === 'number') bonus += d.companionSlotBonus;
  }
  return baseCompanionSlots(pl) + bonus;
}
/** 同行者只受占位限制，没有境界限制；部分同行者占 2 个位置。 */
function companionSlotCost(def) { return (def && def.slots) || 1; }
function companionUsedSlots(pl) {
  return pl.companions.reduce((n, c) => n + companionSlotCost(cardDef(c.id)), 0);
}
/**
 * 法术区格子数。
 * ⚠️ 用户裁定（2026-10-02）：**法术区只有 1 格，与境界无关**。
 *    旧实现写成"2 格（结丹期 3 格）"（规则文档第 40 行那句旧【裁定】），是错的。
 *    注意：这与"储物袋/同行者随境界扩到 2 格"是两回事。
 */
function spellSlots(pl) { return 1; }
function canBeAttacked(pl) { return !pl.out && !pl.inSeclusion; }

// ---------------------------------------------------------------- 抽牌

/** 一整组全新的灵气牌（60 张），洗混。 */
function freshQiPile(state) {
  const arr = [];
  // 同 cards.js buildDecks：`count == null ? 1 : count`，0 张就是 0 张（别写成 `|| 1`）
  for (const c of cards().qi) for (let i = 0; i < (c.count == null ? 1 : c.count); i++) arr.push(c.id);
  for (let k = arr.length - 1; k > 0; k--) {
    const j = Math.floor(nextRandom(state) * (k + 1));
    [arr[k], arr[j]] = [arr[j], arr[k]];
  }
  return arr;
}

function drawFrom(state, deck, n) {
  const pile = state.decks[deck];
  const out = [];
  for (let i = 0; i < n; i++) {
    if (pile.draw.length === 0) {
      if (deck === 'qi') {
        // 用户确认规则：灵气牌抽完后，直接「再加一组灵气牌」继续抽（不走弃牌堆洗混）
        pile.draw = freshQiPile(state);
        log(state, 'reshuffle', `灵气牌堆抽完，重新加入一整组灵气牌（60 张）继续抽取。`);
      } else if (pile.discard.length > 0) {
        pile.draw = pile.discard;
        pile.discard = [];
        for (let k = pile.draw.length - 1; k > 0; k--) {
          const j = Math.floor(nextRandom(state) * (k + 1));
          [pile.draw[k], pile.draw[j]] = [pile.draw[j], pile.draw[k]];
        }
        log(state, 'reshuffle', `${deckLabel(deck)}牌堆用尽，弃牌堆洗混后组成新一轮牌堆。`);
      } else {
        break;
      }
    }
    out.push(pile.draw.pop());
  }
  return out;
}
function toDiscard(state, deck, id) { state.decks[deck].discard.push(id); }
function toQiBottom(state, id) { state.decks.qi.draw.unshift(id); }   // 放回灵气牌堆底部

// ---------------------------------------------------------------- 灵气值

/** 获得灵气牌：每张 = 1 点灵气值，并结算牌的附加效果。 */
function gainQiCard(state, pl, id) {
  // 【拘灵阵】（实物【拘灵阵】）：被封锁的人**一张灵气牌都拿不到** ——
  // 手动炼化、卡牌效果抽取（【铁火蚁】放置抽、【长春功】补抽…）全走这里，一处拦住即可。
  if (pl.blockQiDraw > 0) {
    log(state, 'info', `${pl.name} 被【拘灵阵】封锁，本回合无法抽取【灵气牌】（这张【${(cardDef(id) || {}).name}】回到灵气牌堆底）。`);
    toQiBottom(state, id);
    return;
  }
  pl.qiCards.push(id);
  const def = cardDef(id);
  log(state, 'qi_gain', `${pl.name} 炼化【${def ? def.name : id}】，灵气值 → ${qiOf(pl)}。`, { player: pl.id, card: id, qi: qiOf(pl) });
  const e = playEffectOf(def);
  if (!e) return;
  if (e.op === 'mana' && e.value) {
    pl.mana = Math.min(manaCap(pl), pl.mana + e.value);
    log(state, 'info', `${pl.name} 法力值 +${e.value}（${pl.mana}）。`);
  }
  if (typeof e.mana === 'number' && e.op !== 'mana') {
    pl.mana = Math.min(manaCap(pl), pl.mana + e.mana);
    log(state, 'info', `${pl.name} 法力值 +${e.mana}（${pl.mana}）。`);
  }
  if (e.op === 'draw' && e.deck === 'qi' && e.value) {
    // 「每回合只能触发一次」是**按灵气牌种类**各算一次的：
    // 【充裕灵气】（额外抽 1）和【天地灵气】（额外抽 2）是两张不同的牌，
    // 同一回合里两张都抽到，就都应该各自触发。
    // 旧实现共用一个布尔闸门 `state.extraQiUsed`，导致同回合只触发其中一个（用户报的 bug）。
    state.extraQiUsed = state.extraQiUsed || {};
    const key = def.id;
    if (state.extraQiUsed[key]) {
      log(state, 'info', `【${def.name}】的额外抽取本回合不再触发（每回合每种灵气牌各触发一次）。`);
      return;
    }
    state.extraQiUsed[key] = true;   // 先置位，保证同一张牌的额外抽取不会递归再触发
    log(state, 'info', `【${def.name}】生效：额外抽取 ${e.value} 张灵气牌。`);
    const extra = drawFrom(state, 'qi', e.value);
    for (const x of extra) gainQiCard(state, pl, x);
  }
}

/** 消耗灵气值 N：把灵气牌从灵气区放回灵气牌堆底部。 */
function spendQi(state, pl, n) {
  let left = n;
  const paid = [];
  while (left > 0 && pl.qiCards.length > 0) {
    const id = pl.qiCards.shift();
    toQiBottom(state, id);
    paid.push(id);
    left--;
  }
  if (paid.length) {
    log(state, 'qi_spend', `${pl.name} 消耗 ${paid.length} 点灵气值（灵气值 → ${qiOf(pl)}）。`, { player: pl.id, qi: qiOf(pl) });
  }
  return paid.length;
}

// ---------------------------------------------------------------- 伤害

function applyDamage(state, pl, n, reason, source, opts) {
  if (pl.out || n <= 0) return 0;
  if (pl.inSeclusion) {
    log(state, 'info', `${pl.name} 正在闭关，不受卡牌效果影响。`);
    return 0;
  }
  // ⭐ 第 3 轮：**受伤窗口前置** —— 阶段事务模型推广到全部时点（用户 2026-10-05 裁定
  //   「受伤也是时点，时点响应，原效果最后生效」）。
  //   到这里先把【斗法】窗口开起来，**这一点伤害先不落地**：连减免（护体灵光/替挡）都还没算。
  //   响应直接改 `ctx.pending.value`（damage_cancel / damage_multiply / puppet_absorb / 遮天钟掷骰），
  //   逆序收势之后再 resume 回来走"基础行动"＝减免 → 扣血 → "受伤时"的自动效果 → 濒死判定。
  //   样板＝探索阶段的 `doDrawTreasure`：效果先收势、基础行动沉栈底。
  //   零响应直通：没人能响应时 fireTiming 返回 opened:false，照旧立刻落伤害（行为与旧版一致）。
  const willOpen = !(opts && opts.skipInterrupt) && !state.pending;
  if (willOpen) {
    const pending = { value: n };              // 待落地的伤害（响应对它的每一次改动都算数）
    const lethal = pl.hp - n <= 0;             // 粗判：真死不死由落地那一步决定
    const r = fireTiming(state, 'hurt', null, {
      subjectId: pl.id, counterId: null, combat: state.combat,
      lethal: lethal, damage: n, lostHp: n, pending: pending,
      reason: reason || null, source: source || null,
      resume: () => applyDamage(state, pl, pending.value, reason, source, { skipInterrupt: true }),
    });
    if (r.opened) {
      if (lethal) {
        log(state, 'damage', `${pl.name} 命悬一线：本次 ${n} 点伤害将使其生命值归零——等待是否有人出手相救。`,
          { player: pl.id, hp: pl.hp, value: n });
      }
      return n;                                // 伤害还没落地：收势后由 resume 落
    }
  }
  // 傀儡替伤（实物【傀儡蜥蜴】：每次替伤消耗 2 点法力值）**不再是自动**的 ——
  // 用户通则：**需要付费的都要询问**（付不起自动跳过）。所以它现在是「受伤」时点的一个响应
  // （op = puppet_absorb，写在自己的数据里），玩家决定要不要让傀儡挨这一下。
  // 免费替挡的同行者（寒蛟/离龟/啼魂等，卡文只写"可替你承受"、不花法力）仍然自动 —— 见下面那一段。
  // 受到伤害时掷骰抵消/反弹 —— 实物【遮天钟】（一次性）
  if (pl.damageSave && n > 0) {
    const roll = d6(state);
    const faces = pl.damageSave.faces || [4, 5];
    const reflectFace = pl.damageSave.reflect || 6;
    const save = pl.damageSave;
    pl.damageSave = null;
    if (roll === reflectFace) {
      log(state, 'roll', `${pl.name} 掷出 ${roll} 点——抵消本次伤害并反弹等额！`, { player: pl.id, value: roll, scope: 'damage_save' });
      if (source) { const src = p(state, source); if (src && !src.out) applyDamage(state, src, n, 'reflect', pl.id); }
      return 0;
    }
    if (faces.indexOf(roll) >= 0) {
      log(state, 'roll', `${pl.name} 掷出 ${roll} 点——抵消本次伤害。`, { player: pl.id, value: roll, scope: 'damage_save' });
      return 0;
    }
    log(state, 'info', `${pl.name} 掷出 ${roll} 点，未能抵消伤害。`);
    void save;
  }
  const pas = passives(pl);
  let dmg = Math.max(0, n - pas.damage_reduction);
  if (pl.shield > 0) {
    const used = Math.min(pl.shield, dmg);
    pl.shield -= used; dmg -= used;
    if (used > 0) log(state, 'info', `${pl.name} 的护体灵光抵挡了 ${used} 点伤害。`);
  }
  // 只有卡文写明「可替你承受 N 次伤害」的同行者（absorb / soak，如【啼魂】【离龟】【血玉蜘蛛】）才替挡。
  // 其他同行者只是常驻效果，伤害直接落到主人身上 —— 否则【燕如嫣】这类
  // 「当你受到任意伤害时……」的卡文永远无法触发，与实物卡文相矛盾。
  while (dmg > 0) {
    const idx = pl.companions.findIndex((x) => { const d = cardDef(x.id); return !!d && (d.absorb || d.soak); });
    if (idx < 0) break;
    const inst = pl.companions[idx];
    const def = cardDef(inst.id);
    const cname = def.name;
    const max = def.absorb === true ? 1 : (def.absorb || def.soak || 1);
    inst.absorbed = (inst.absorbed || 0) + 1;
    log(state, 'companion_hurt', `${pl.name} 的同行者【${cname}】替他挡下了本次全部 ${dmg} 点伤害（第 ${inst.absorbed}/${max} 次）。`);
    if (inst.absorbed >= max) {
      loseCompanion(state, pl, inst);   // 离场即重算手牌上限（【噬金虫】）
      toDiscard(state, 'companion', inst.id);
      log(state, 'companion_down', `同行者【${cname}】替主受过的次数已用尽，被放入弃牌堆。`);
    }
    dmg = 0;
  }
  if (dmg > 0) {
    pl.hp -= dmg;
    // 生命值不保留负数：归零就是归零（濒死窗口里的人会不会活下来由后面的逻辑决定），
    // 负数是内部细节，露到面板上没意义。
    if (pl.hp < 0) pl.hp = 0;
    log(state, 'damage', `${pl.name} 受到 ${dmg} 点伤害（生命值 ${Math.max(0, pl.hp)}/${HP_MAX}）。`,
      { player: pl.id, value: dmg, hp: Math.max(0, pl.hp), reason: reason || null });
    // 「当你受到任意伤害时，立即恢复 N 点法力值」—— 实物【燕如嫣】(N=2)、【慕沛灵】(N=1)
    // （op='mana' 走法力通道，op='heal' 才是回血；目前池里这一时点全是回法力）
    // 这里的效果都是**免费**的，按通则自动生效、不弹时点询问；需要表态的打断类效果走 `hurt` 锁链窗口。
    const hm = hurtMana(pl);
    if (!pl.out && (hm.mana > 0 || hm.heal > 0)) {
      const who = `【${hm.names.join('】【')}】`;
      if (hm.mana > 0) {
        pl.mana = Math.min(manaCap(pl), pl.mana + hm.mana);
        log(state, 'info', `${pl.name} 的同行者${who}效果发动，受伤后恢复 ${hm.mana} 点法力值（${pl.mana}）。`);
      }
      if (hm.heal > 0 && pl.hp < HP_MAX) {
        const hb = pl.hp;
        pl.hp = Math.min(HP_MAX, pl.hp + hm.heal);
        log(state, 'heal', `${pl.name} 的同行者${who}效果发动，受伤后恢复 ${pl.hp - hb} 点生命值（${pl.hp}/${HP_MAX}）。`, { player: pl.id, hp: pl.hp });
      }
    }
    // 「当你受到任意伤害时，使对方受到等额伤害，之后此【同行者】放入【弃牌堆】」—— 实物【刘靖】。
    // 卡文没有"可以" → 自动生效（`auto:true`），所以它**不进【斗法】窗**，在这里直接结算。
    // ⚠️ 免伤 / 翻倍 / 替挡那几条（damage_cancel / damage_multiply / puppet_absorb / damage_save_dice）
    //    是**窗口响应**，由玩家在受伤窗口里自己决定，不走这个自动通道。
    for (const x of collectEffects(pl, 'hurt', { self: pl, state: state })) {
      if (x.eff.op !== 'hurt_reflect') continue;
      if (x.eff.auto === false) continue;
      resolveEffect(state, pl, x.eff,
        { state: state, self: pl, source: source || null, lostHp: dmg, damage: n },
        { source: 'companion', def: x.def, inst: x.inst });
    }
  }
  // 「生命值仅剩 N 点或以下时恢复 M 点生命值，之后此同行者放入弃牌堆」—— 实物【元瑶】
  if (pl.hp <= 1 && !pl.out) {
    const r = lowHpRescue(pl);
    if (r) {
      const hb = pl.hp;
      pl.hp = Math.min(HP_MAX, pl.hp + r.heal);
      log(state, 'heal', `${pl.name} 生命垂危，同行者【${r.name}】发动：恢复 ${pl.hp - hb} 点生命值（${pl.hp}/${HP_MAX}）。`, { player: pl.id, hp: pl.hp });
      if (r.discardSelf) {
        loseCompanion(state, pl, r.inst);   // 离场即重算手牌上限（【噬金虫】）
        toDiscard(state, 'companion', r.inst.id);
        log(state, 'companion_down', `同行者【${r.name}】用尽自身之力，被放入弃牌堆。`);
      }
    }
  }
  if (pl.hp <= 0) {
    // 自救之法（实物【还阳术】）：生命归零时恢复到指定点数，而不是淘汰。
    // 它是在**受伤窗口里**打出来的（`if: {lethal:true}`）—— 窗口前置之后，那时伤害还没落地，
    // 所以"被救回来"是收势后的正常结果；没人出手才真的走淘汰。
    if (pl.reviveTo) {
      pl.hp = pl.reviveTo;
      pl.reviveTo = 0;
      log(state, 'heal', `${pl.name} 触发自救之法，生命值恢复到 ${pl.hp} 点！`, { player: pl.id, hp: pl.hp });
    } else {
      eliminate(state, pl, source);
      // 窗口开着时（收势后才落地）淘汰要顺手判一次终局 —— 与旧版 deferredDeath 那条路一致，
      // 否则"最后一人被打死"要等到下一次 advance() 才被发现。
      checkLastStanding(state);
    }
  }
  return dmg;
}

/** 淘汰：击杀者可从未出局者「剩余的所有卡牌」中任选 3 张加入手牌。 */
function eliminate(state, pl, killerId) {
  if (pl.out) return;
  pl.out = true;
  pl.hp = 0;
  const pool = pl.hand.map((c) => c.id)
    .concat(pl.equip.map((c) => c.id), pl.spells.map((c) => c.id), pl.companions.map((c) => c.id));
  const killer = killerId ? p(state, killerId) : null;
  // 先挑后弃：击杀者挑走的 3 张**不再进弃牌堆**——
  // 早期版本是"全部进弃牌堆再从中挑 3 张"，同一张牌既在弃牌堆又在击杀者手牌，
  // 弃牌堆重洗后牌池多出额外界副本（E1 回归：tests\dead-effect-test.js [淘汰分牌]）。
  const picks = [];
  if (killer && !killer.out && pool.length > 0) {
    const copy = pool.slice();
    for (let i = 0; i < 3 && copy.length; i++) {
      const idx = Math.floor(nextRandom(state) * copy.length);
      picks.push(copy.splice(idx, 1)[0]);
    }
  }
  const taken = {};
  for (const id of picks) taken[id] = (taken[id] || 0) + 1;
  // 手牌与场上装备全部进入对应弃牌堆（被挑走的除外；同名牌按张数扣减）
  for (const c of pl.hand.concat(pl.equip, pl.spells, pl.companions)) {
    if (taken[c.id] > 0) { taken[c.id] -= 1; continue; }
    const d = deckOf(c.id);
    if (d) toDiscard(state, d, c.id);
  }
  pl.hand = []; pl.equip = []; pl.spells = []; pl.companions = []; pl.puppets = [];
  log(state, 'eliminate', `${pl.name} 生命值归零，被淘汰出局。`, { player: pl.id });
  if (picks.length) {
    for (const id of picks) killer.hand.push(mk(UID++, id));
    log(state, 'steal', `${killer.name} 击败了 ${pl.name}，从其遗物中挑选 3 张收入手中：${picks.map((x) => cardDef(x).name).join('、')}。`,
      { from: pl.id, to: killer.id });
  }
  // 对战进行中有一方被淘汰（例如【风灵劲】这类瞬间伤害）→ 本次对战立即作废。
  // 否则会留下一个 attacker/defender 已出局的残局，谁也掷不了骰，整局卡死。
  const c = state.combat;
  if (c && c.stage !== 'done' && (c.attacker === pl.id || c.defender === pl.id)) {
    c.stage = 'done';
    state.combat = null;
    log(state, 'info', `${pl.name} 已出局，本次对战作废。`);
    checkLastStanding(state);
  }
}

// ---------------------------------------------------------------- 建局

function createGame(playerDefs, opts) {
  const o = opts || {};
  const state = {
    id: o.id || 'local',
    phase: 'lobby',
    rngSeed: o.seed || (Date.now() & 0x7fffffff),
    turn: 0, round: 0,
    players: [],
    decks: {
      treasure: { draw: [], discard: [] }, spell: { draw: [], discard: [] },
      companion: { draw: [], discard: [] }, qi: { draw: [], discard: [] },
    },
    log: [], combat: null, winner: null,
    turnFlags: { combat: false, promote: false },
    extraQiUsed: {},    // 本回合已触发过"额外抽灵气牌"的灵气牌 id（每种各一次）
    step: 'lobby',
  };
  playerDefs.forEach((pd, i) => {
    state.players.push({
      id: pd.id, name: pd.name, seat: i, connected: true, host: !!pd.host,
      realm: 0, hp: HP_MAX, mana: START_MANA,
      qiCards: [], root: 'wei',
      hand: [], equip: [], spells: [], companions: [], puppets: [],
      shield: 0, out: false,
      inSeclusion: false, seclusionUsed: 0, seclusionMax: 1,
      // 已经轮到过他几次。规则：**第一个回合不能发起对战**（见 doCombat）
      turnsTaken: 0,
      // 封锁计数（写入 → 被封锁方回合内生效 → 该回合结束时递减，见 endTurn）
      blockSpellDraw: 0, blockCompanionDraw: 0, blockTreasureDraw: 0, blockCombat: 0,
      // 跳过回合的额度（advance() 每次消耗 1，见【寒黎珠】【碧水青甲阵】【禁神牌】）
      skip: 0, skippedLastTurn: false,
    });
  });
  return state;
}

/**
 * 灵根符 8 张的**真实配比**。
 * `【裁定】`2026-10-02 深夜（第三版，用户给了实物照片后改）：**天 1 / 双 1 / 三 3 / 伪 3 = 8 张**。
 * （上一版是 天1/双1/三2/伪4。）
 *
 * 每人抽 1 张、**抽走不放回**（实物就是洗 8 张符各抽一张），所以：
 *   4 人局会把 8 张里的 4 张抽走，同资质出现多位是常态
 *   → `beginGame` 里"同资质各自掷骰争先手"那段是**活代码**（旧实现下它永远走不到）。
 *
 * ⚠️ 旧实现是"四种各 1 张的池子、抽完再补"，结果是 **4 人局必定人手一种、绝不重样**，
 *    与实物不符（用户实盘报了"貌似经常能抽到天灵根"）。已按用户裁定废掉，别改回去。
 */
const ROOT_DECK = ['tian', 'shuang', 'san', 'san', 'san', 'wei', 'wei', 'wei'];

function dealRoots(state) {
  const pool = ROOT_DECK.slice();   // 8 张 ≥ 最多 4 人，不需要补牌
  for (let i = 0; i < state.players.length; i++) {
    const idx = Math.floor(nextRandom(state) * pool.length);
    state.players[i].root = pool.splice(idx, 1)[0];
  }
}

function beginGame(state) {
  if (state.phase !== 'lobby') return { ok: false, error: '游戏已经开始' };
  if (state.players.length < 2) return { ok: false, error: '至少需要 2 名玩家' };
  if (state.players.length > 4) return { ok: false, error: '最多 4 名玩家' };
  const piles = buildDecks(() => nextRandom(state));
  for (const d of DECKS) state.decks[d] = { draw: piles[d] || [], discard: [] };
  dealRoots(state);
  for (const pl of state.players) {
    pl.hp = HP_MAX; pl.mana = START_MANA; pl.realm = 0; pl.out = false;
    pl.hand = []; pl.equip = []; pl.spells = []; pl.companions = [];
    pl.qiCards = []; pl.shield = 0; pl.inSeclusion = false; pl.seclusionUsed = 0;
    pl.turnsTaken = 0;
    // 起手：用户确认实物规则 —— 开局没有同行者，只有 2 张宝物牌
    const tr = drawFrom(state, 'treasure', 2);
    for (const t of tr) pl.hand.push(mk(UID++, t));
  }
  state.extraQiUsed = {};
  let order = state.players.slice().sort((a, b) => ROOTS[a.root].rank - ROOTS[b.root].rank || a.seat - b.seat);
  let best = order[0];
  const sameRank = order.filter((x) => ROOTS[x.root].rank === ROOTS[best.root].rank);
  if (sameRank.length > 1) {
    let bestRoll = -1;
    for (const x of sameRank) {
      const r = d6(state);
      log(state, 'roll', `${x.name}（${ROOTS[x.root].name}）争夺先手，掷出 ${r} 点。`, { player: x.id, value: r, scope: 'initiative' });
      if (r > bestRoll) { bestRoll = r; best = x; }
    }
  }
  state.phase = 'playing';
  state.turn = state.players.indexOf(best);
  state.round = 1;
  for (const pl of state.players) pl.turnsTaken = 0;
  log(state, 'info', `开局！灵根资质最高者为 ${best.name}（${ROOTS[best.root].name}），先行。`);
  countTurn(state, best);          // 第 1 个回合也算"轮到过他"
  startTurn(state);
  return { ok: true };
}

/**
 * 记一次"轮到过他"。
 * 规则：**每个人的第一个回合不能发起对战**（各自先铺一回合场，第 2 个回合才解锁）。
 * 所以在 advance() 分配回合时就要计数 —— 被跳过的那一回合也算轮到过他，
 * 否则"第一次被跳过"会让他的解锁往后多拖一轮。
 */
function countTurn(state, pl) {
  if (!pl) return;
  pl.turnsTaken = (pl.turnsTaken || 0) + 1;
}

// ---------------------------------------------------------------- 回合

function startTurn(state) {
  state.combat = null;
  state.turnFlags = { combat: false, promote: false };
  state.extraQiUsed = {};   // 按灵气牌种类分别计次：每种每回合各触发一次
  state.turnUses = {};      // 「一回合一次」的时点效果（oncePerTurn）在新回合开始时清零
  state.turnPlayed = {};    // 「本回合打出过哪些牌」也清零（供 if.playedThisTurn 的套装判定用）
  state.phaseMods = {};     // 阶段事务的修饰（如 exploreSwap）：只活在一个阶段里，回合开始兜底清零
  const pl = state.players[state.turn];
  if (!pl || pl.out) return advance(state);
  if (pl.inSeclusion) {
    pl.inSeclusion = false;
    log(state, 'info', `${pl.name} 闭关结束，出关。`);
  }
  // 回合开始：恢复 1 点法力值
  pl.mana = Math.min(manaCap(pl), pl.mana + manaRegen(pl));
  // 〔时点〕法力恢复（我方 / 对方）—— 图上的第 2 格，此前没有挂点
  fireTiming(state, 'manaRegen', null, { subjectId: pl.id, subject: 'self' });
  pl.equipTrigUsed = {};   // 【银月】这类"每回合 1 次"的装备触发在此重置
  pl.activateUsed = {};    // 主动技能每回合各一次
  // ⚠️ 封锁计数（blockSpellDraw / blockCompanionDraw / blockTreasureDraw / blockCombat）
  // **不在这里递减**，改到 endTurn 递减 —— 否则「对方下回合不能抽 X」在对方回合开始就被减到 0，
  // 轮到真正要抽牌时已经不再封锁，等于永远不生效（【寒蛟】就是这个 bug）。
  // 跳过额度（t.skip）的读取在 advance()；这里把「上回合被跳过」的标记清掉，
  // 否则【寒黎珠】用一次之后，以后所有「跳过」都会被"不可连续两回合"规则永久挡掉。
  pl.skippedLastTurn = false;
  // 「本回合不发起对战，回合结束额外回 N 点法力」（【三目豹】）的暂存值：**必须在回合开始归零**，
  // 否则 `when:'turn'` 每回合 +1 累加，第 N 回合就变成回 N 点法力，越玩越离谱。
  pl.noCombatMana = 0;
  // ⭐ 实物卡补充批（2026-10-05 第 8 件）的每回合字段 —— 一律**在回合开始清零**：
  pl.voidTurn = false;            // 【神风舟】"跳过本回合所有行动"（doPlay 收尾时消费）
  pl.freeCardThisTurn = false;    // 【七鬼噬魂术】"本回合出牌不消耗法力值"
  pl.freeCardSelfDamage = 0;
  pl.noTarget = false;            // 【隐灵纱】【神风舟】"到自己的下回合开始前无法被指定为对战目标"——到点即失效
  log(state, 'turn', `—— ${pl.name} 的回合开始（${REALMS[pl.realm]}，基础战力 ${baseCombat(pl)}）——`, { player: pl.id });
  // 同行者「自己的回合」效果（DSL：when === 'turn'）
  for (const x of collectEffects(pl, 'turn', { self: pl, state: state }, 'companions')) {
    log(state, 'info', `同行者【${x.def.name}】的回合效果生效。`);
    resolveEffect(state, pl, x.eff, { state: state }, { source: 'companion', def: x.def, inst: x.inst });
  }
  // 抽取改为**玩家手动分阶段点击**（用户要求）：
  //   回合开始 → 点"抽取灵气牌" → 点"探索阶段·抽宝物牌" → 二选一抽法术/同行者 → 行动阶段
  state.step = 'draw_qi';
}

/**
 * 轮到下一家。**被跳过的玩家不给回合** —— 实物【寒黎珠】【碧水青甲阵】【禁神牌】
 * 「使对方跳过下回合所有行为」。
 * 跳过额度存在 `pl.skip`（由 skip_turn / skip_turns / damage_and_skip 写入）。
 * 早期版本只写 `t.skip` 但从没人读，于是"说过要跳"其实一次都没跳。
 */
function advance(state) {
  state.combat = null;
  const n = state.players.length;
  const start = state.turn;
  let scanned = 0;
  for (let step = 1; scanned < n * 4 && step <= n * 4 + n; step++) {
    const idx = (start + step) % n;
    const cand = state.players[idx];
    if (!cand || cand.out) continue;
    scanned++;
    if (cand.skip > 0) {
      cand.skip -= 1;
      cand.skippedLastTurn = true;
      countTurn(state, cand);      // 被跳过也算"轮到过他"
      log(state, 'turn', `${cand.name} 的回合被跳过（跳过所有行为，剩余 ${cand.skip} 次）。`, { player: cand.id });
      continue;
    }
    if (idx <= start) state.round += 1;
    state.turn = idx;
    countTurn(state, cand);
    return startTurn(state);
  }
  // 兜底：不该出现"所有人都被跳过"——清空额度后按普通规则推进，避免卡死
  for (const q of state.players) q.skip = 0;
  for (let i = 1; i <= n; i++) {
    const idx = (state.turn + i) % n;
    if (!state.players[idx].out) {
      if (idx <= state.turn) state.round += 1;
      state.turn = idx;
      countTurn(state, state.players[idx]);
      return startTurn(state);
    }
  }
  state.phase = 'over';
}

/** 这位玩家此刻的「宝物牌手牌上限」加成（【噬金虫】+1；将来别的牌同理，卡文只写【宝物牌】） */
function handLimitBonus(pl) {
  if (!pl) return 0;
  return passives(pl).hand_limit_bonus || 0;
}

/**
 * 这位玩家此刻**真正生效**的手牌上限（宝物牌含常驻加成）。
 *
 * ⚠️ 显示与执行**必须走同一个函数**。分离过一次就出过这个 bug：
 *    `enforceHandLimits()` 自己算（6+1=7），而 `publicState()` 下发的是牌面基础值 6 ——
 *    于是带着【噬金虫】、手里 7 张时，界面渲染成「宝物 7/6」标红并提示"回合结束时会被弃置"，
 *    引擎却一张都不弃。玩家看到的就是**"超上限结束回合却无事发生"**。
 */
function effectiveHandLimits(pl) {
  const bonus = handLimitBonus(pl);
  return { treasure: HAND_LIMITS.treasure + bonus, spell: HAND_LIMITS.spell, companion: HAND_LIMITS.companion };
}

/**
 * 手牌上限收紧。宝物牌上限会被常驻效果抬高 —— 实物【噬金虫】
 * 「放置此同行者后，你的手中最多可保存 7 张宝物牌（此同行者放入弃牌堆时，则恢复至 6 张，
 *   多出的宝物牌需一起放入弃牌堆）」。
 * 所以这个函数不只回合结束要调，**同行者离场时也要立刻再调一次**（见 loseCompanion）。
 */
function enforceHandLimits(state, pl) {
  if (!pl) return 0;
  const limits = effectiveHandLimits(pl);
  let dropped = 0;
  for (const d of Object.keys(HAND_LIMITS)) {
    const limit = limits[d];
    let over = pl.hand.filter((c) => deckOf(c.id) === d).length - limit;
    for (let i = pl.hand.length - 1; i >= 0 && over > 0; i--) {
      if (deckOf(pl.hand[i].id) !== d) continue;
      const x = pl.hand.splice(i, 1)[0];
      toDiscard(state, d, x.id);
      log(state, 'discard', `${pl.name} 手中${deckLabel(d)}超过 ${limit} 张上限，弃置【${cardDef(x.id).name}】。`);
      over--; dropped++;
    }
  }
  return dropped;
}

/** 同行者离场（替伤用尽 / 主动弃置 / 被效果移走）后要立刻重算手牌上限 —— 实物【噬金虫】 */
function loseCompanion(state, pl, inst) {
  if (!pl || !inst) return;
  const i = pl.companions.indexOf(inst);
  if (i >= 0) pl.companions.splice(i, 1);
  // ⭐ 实物【胡月】：它离场 → 靠它撑出来的那些位一起归还 ——
  //    卡文"额外放置的【同行者】需一起放入【弃牌堆】"。
  //    判据：放置时**超出了基础格数**的那张（`inst.onBonusSlot`，见 doPlay 的同行者分支）。
  const def = cardDef(inst.id);
  if (def && typeof def.companionSlotBonus === 'number') {
    for (let k = pl.companions.length - 1; k >= 0; k--) {
      const gone = pl.companions[k];
      if (!gone.onBonusSlot) continue;
      pl.companions.splice(k, 1);
      const gd = cardDef(gone.id);
      const dk = deckOf(gone.id);
      if (dk) toDiscard(state, dk, gone.id);
      log(state, 'companion_down',
        `${pl.name} 的【${def.name}】离场，额外放置的同行者【${gd ? gd.name : ''}】一起被放入弃牌堆。`, { player: pl.id });
    }
    // 兜底：没打标记的老数据 / 手工构造的局面 —— 超出基础格数的从最后放置的往回收
    let guard = 0;
    while (pl.companions.length && companionUsedSlots(pl) > baseCompanionSlots(pl) && guard++ < 8) {
      const gone = pl.companions.pop();
      const gd = cardDef(gone.id);
      const dk = deckOf(gone.id);
      if (dk) toDiscard(state, dk, gone.id);
      log(state, 'companion_down',
        `${pl.name} 的【${def.name}】离场，额外放置的同行者【${gd ? gd.name : ''}】一起被放入弃牌堆。`, { player: pl.id });
    }
  }
  enforceHandLimits(state, pl);
}

/**
 * 手牌超上限检查（**只算不改**）：返回合计要弃的张数 + 每个牌堆各超多少 + 此刻的上限。
 * 显示（前端提示"还需弃置 N 张"）与判定都用它。
 */
function handOverLimit(pl) {
  const limits = effectiveHandLimits(pl);
  const over = {};
  let need = 0;
  for (const d of Object.keys(HAND_LIMITS)) {
    const n = pl.hand.filter((c) => deckOf(c.id) === d).length;
    if (n > limits[d]) { over[d] = n - limits[d]; need += n - limits[d]; }
  }
  return { need: need, over: over, limits: limits };
}

function endTurn(state, opts) {
  const o = opts || {};
  const pl = state.players[state.turn];
  // 〔时点〕回合结束（我方/对方）—— 图上的倒数第二格。
  // **消耗法力才能发动的效果在这里询问**（【墨彩环】"可消耗 3 点法力恢复 1 点生命值"）——
  // 用户定的判据：消耗法力 = 主动询问，不消耗法力 = 自动。所以这里不再自动扣钱回血。
  if (!o.windowed) {
    const r = fireTiming(state, 'turnEnd', null, {
      subjectId: pl.id, counterId: null,
      resume: () => endTurn(state, { windowed: true }),
    });
    if (r.opened) return;
  }
  // 手牌超上限：**让玩家自己挑**弃哪几张（用户裁定：「超出手牌上限当然是自己挑弃哪些牌」）。
  //   挂一个"必须弃到上限"的状态（state.forceDiscard）把回合**暂停在这里**，引擎挡掉其它动作，
  //   doDiscard() 每弃一张就重算；弃够了再回来把回合真正结束掉（见 endTurn 的 afterForcedDiscard）。
  //   以前这里是直接 enforceHandLimits() 从手牌**末尾**替他弃 —— 玩家既没得选，也常常没注意到。
  if (!o.afterForcedDiscard) {
    const chk = handOverLimit(pl);
    if (chk.need > 0) {
      state.forceDiscard = { playerId: pl.id, need: chk.need, over: chk.over, limits: chk.limits };
      log(state, 'info',
        `${pl.name} 手牌超过上限，请弃置 ${chk.need} 张（宝物 ${chk.limits.treasure} / 法术 ${chk.limits.spell} / 同行者 ${chk.limits.companion}）。`,
        { player: pl.id, need: chk.need });
      return { ok: true, forcedDiscard: chk.need };
    }
  }
  enforceHandLimits(state, pl);   // 兜底：真到这一步还有超的（理论上不会），照旧收掉
  // 封锁计数（【寒蛟】禁抽法术/同行者、【血咒禁制】禁抽宝物牌与发起对决）在**回合结束时**递减：
  // 本回合该封锁已经起过作用了，下一个自己的回合才算失效。
  if (pl.blockSpellDraw > 0) pl.blockSpellDraw -= 1;
  if (pl.blockCompanionDraw > 0) pl.blockCompanionDraw -= 1;
  if (pl.blockTreasureDraw > 0) pl.blockTreasureDraw -= 1;
  if (pl.blockCombat > 0) pl.blockCombat -= 1;
  // 【拘灵阵】的灵气封锁走同一套"回合结束递减"（实物【拘灵阵】"下回合内…"）
  if (pl.blockQiDraw > 0) pl.blockQiDraw -= 1;
  // 「仅存 1 回合」的傀儡（实物【傀儡弓手】）在回合结束时进弃牌堆
  if (pl.puppets && pl.puppets.length) {
    for (let i = pl.puppets.length - 1; i >= 0; i--) {
      const pup = pl.puppets[i];
      if (!pup.discardAtTurnEnd) continue;
      pl.puppets.splice(i, 1);
      if (pup.id) toDiscard(state, 'treasure', pup.id);
      log(state, 'companion_down', `${pl.name} 的傀儡【${pup.name}】只存 1 回合，回合结束被放入弃牌堆。`, { player: pl.id });
    }
  }
  // ⭐ 伪丹期（实物【血凝五行丹】）的**收尾**：卡文"持续 2 回合。回合结束若没有达到结丹期，
  //    则回到筑基期，且自身受到 1 点伤害"。
  //    ⚠️ 以前只写 `pseudoRealm.turns = 2` **从来没人递减** → 伪丹期是永久的（交接 §5.2 的老欠账）。
  //    按卡文只在**自己的回合结束**递减；归零时结算"回筑基 + 自伤"。
  if (pl.pseudoRealm && pl.pseudoRealm.turns > 0) {
    pl.pseudoRealm.turns -= 1;
    if (pl.pseudoRealm.turns > 0) {
      log(state, 'info', `${pl.name} 的【伪丹期】还剩 ${pl.pseudoRealm.turns} 个回合。`, { player: pl.id });
    } else {
      const penalty = pl.pseudoRealm.penalty || 1;
      pl.pseudoRealm = null;
      if (pl.realm < 3) {
        pl.realm = 1;                      // 回到筑基期
        syncEquipTiers(pl);                // 场上带档位的牌跟着对齐新境界
        log(state, 'info', `${pl.name} 未能结成金丹，【伪丹期】结束：境界退回【${REALMS[1]}】。`,
          { player: pl.id, realm: 1 });
        applyDamage(state, pl, penalty, 'card', pl.id);
      } else {
        log(state, 'info', `${pl.name} 已结成金丹，【伪丹期】平稳结束。`, { player: pl.id });
      }
    }
  }
  // 「本回合不发起对战，则回合结束时额外恢复法力」—— 实物【三目豹】
  if (!state.turnFlags.combat && pl.noCombatMana) {
    pl.mana = Math.min(manaCap(pl), pl.mana + pl.noCombatMana);
    log(state, 'info', `${pl.name} 本回合未发起对战，回合结束额外恢复 ${pl.noCombatMana} 点法力值（${pl.mana}）。`);
  }
  // 「本回合不发起对战，可花 N 法力回 M 生命」—— 实物【墨彩环】
  // 现在是**主动**的：在回合结束的时点询问窗口里发动（效果本体的实现在 resolveEffect）。
  advance(state);
}

/**
 * 「使用任意【消耗类法宝】后，投掷 1 次骰子，若点数为 6，选择任意一名修士受到 1 点伤害」
 * —— 实物【玄阴诀】（装备类法术，挂在法术区，属常驻钩子）。
 *
 * 从**场上实时读**而不是存标志位：玄阴诀离场（被弃置/被顶掉）后钩子自动失效，
 * 不会留下"只写不读"的幽灵状态。这也是当初这张牌完全没生效的原因。
 *
 * 卡文是"选择任意一名修士"，但引擎目前没有交互层，所以沿用引擎既有的兜底选法：
 * 正在对战时优先打对手，否则选生命值最低的另一位修士。
 */
function afterConsumeSources(pl) {
  return collectEffects(pl, null, { self: pl }).filter((x) => x.eff.op === 'after_consume_roll6');
}

function fireAfterConsumeRoll6(state, pl, usedDef) {
  const armed = afterConsumeSources(pl);
  if (!armed.length) return;
  const c = state.combat;
  let t = null;
  if (c) {
    const fid = c.attacker === pl.id ? c.defender : c.attacker;
    t = p(state, fid);
  }
  if (!t || !canBeAttacked(t)) {
    const cands = alive(state).filter((x) => x.id !== pl.id && !x.inSeclusion);
    cands.sort((a, b) => a.hp - b.hp);
    t = cands[0] || null;
  }
  const src = armed[0].def.name;
  const roll = d6(state);
  log(state, 'roll', `${pl.name} 使用【${usedDef.name}】后，【${src}】效果发动：掷出 ${roll} 点（点数 6 才生效）。`,
    { player: pl.id, value: roll, scope: 'consume_hook' });
  if (roll !== 6) return;
  if (!t) { log(state, 'info', `${src} 效果发动，但场上没有可指定的修士，效果落空。`); return; }
  log(state, 'info', `${src} 掷出 6 点！指定 ${t.name} 受到 1 点伤害。`);
  applyDamage(state, t, 1, 'card', pl.id);
}

/* ================================================================
 * 时点总线（事件 + 主体 + 阶段）
 * ----------------------------------------------------------------
 * 用户给的模型：一回合是一条流程主线，外加两条随时能插进来的独立事件。
 * 每个时点 = 事件 + 主体(我方/对方) + 阶段(前/后)，权威表在 effect-meta 的 EVENTS。
 *
 * 本层现在只做 **零响应直通**：走到流程点时问一句"有人能响应吗"——
 *   没人 → 立刻返回，开销是一次长度很小的数组扫描，行为与旧版**完全一致**；
 *   有人 → 如实记进 `state.timingLog` 并在战报里留一行（等第 4 步接上"打断—询问"再真正询问）。
 *
 * 为什么先做这一层：现在引擎的 18 个 `when` 全是"我方视角 + 没有主体概念"，
 * 缺的 7 个时点（法力恢复/抽牌三连/晋升前/使用卡牌前/对战宣告/选择目标/回合结束）
 * 连个挂点都没有。总线把挂点补齐，之后加卡只改数据、不改引擎。
 *
 * ⚠️ **命名（用户 2026-10-02 定）**：玩家侧的系统叫**「斗法」**、响应叫**「破招」**、
 *    结算叫**「收势」**，口诀「**后发先至，逆序收势**」（后出手的先结算）。
 *    代码里的 `pending` / `chain` / `openInterrupt` / `respondPlay` / `resolvePending` **保持原名**
 *    （大范围改名容易引回归）；只有**玩家看得见的文案**用斗法/破招/收势。
 * ================================================================ */

/**
 * 找出此刻**能响应**这个时点的人。
 *
 * 判定口径：手牌看它声明的时点是否落在当前窗口（satisfiedWindows），
 * 场上的装备/同行者交给 collectEffects。
 *
 * **主体是逐效果判的**（这是这层最容易写错的地方）：
 *   效果的 `subject` 表示"这件事发生在谁身上"，而**响应者是卡主**。
 *     · subject:'self'（卡文写「我方…」/「当你…」）→ 卡主必须就是**事件主体**
 *     · subject:'foe' （卡文写「对方…」）        → 卡主必须是**事件对家**
 *   例 1：【寒冰珠】「对方投骰**前**使用」→ 事件主体是那个要投骰的人，拿牌响应的是他的**对家**。
 *   例 2：【阴魂丝】「当你被指定为对战目标」→ 事件主体是**宣告对战的那个人**，
 *         拿牌响应的是**被指定的一方**，所以它写 subject:'foe'。
 * 没有 `subject` 的事件（对战结果/对战结束）谁都能响应。
 */
/**
 * 场上的效果（装备 / 同行者）在**锁链窗口**里该不该摆出来问玩家。
 *
 *   ✅ 该问：卡文写明「使用 / 发动」的**主动牌** —— 数据里表现为**总线写法**（有 `event`）。
 *      典型：【温天仁】（"在对战中使用，消耗 3 点法力值"）、【绿煌剑】【黑血刀】【青竹蜂云剑】
 *      【青元剑诀】（"对战启用费"）、【墨彩环】（"可消耗 3 点法力值恢复 1 点生命值"）、
 *      【虚天鼎】（虽然不耗法力，但卡文明写"使用"且要选目标）。
 *
 *   ❌ 不该问：旧 `when` 写法的**触发型**效果 —— 它们全部由引擎的**专用通道**自动执行：
 *      【慕沛灵】【燕如嫣】受伤回法力走 `hurtMana()`、【元瑶】濒危自救走 `lowHpRescue()`、
 *      【韩立】获胜夺装备走 `runOnWinEffects()`、【离龟】放置抽牌走 doPlay 的同行者分支……
 *      再摆出来问一遍不但多余，**玩家一点"响应"还会让同一条效果跑第二遍**（回血/回法力翻倍）。
 *      用户裁定：不消耗法力的都是自动 / 被动，不询问。
 *
 * 手牌不走这里 —— 手牌永远是玩家自己的选择（"要不要花掉这张牌"本身就是决策）。
 * `auto:true` / `auto:false` 可以显式覆盖上面的默认判断。
 */
function boardAskable(def, e) {
  if (!def || !e) return false;
  if (def.type !== 'companion' && def.type !== 'equip') return true;   // 手牌：另一条通道
  // ⭐ 要付费的效果**一定**要问（用户通则）—— 就算数据上误标了 `auto`，
  //    也不能默默白送（【绿煌剑】那种"付费 + auto"的写法会变成"免费自动触发"）。
  if ((e.manaCost || 0) > 0) return true;
  if (e.auto === true) return false;
  if (e.auto === false) return true;
  return !!e.event;
}

/**
 * 「本次对战中禁止使用某类牌」—— 实物【阴魂丝】（还有【虚天鼎】的旧式兜底）。
 * 以前只把封锁写进 `combat.blocked[pid]` 但**全引擎没有读取点**，阴魂丝整场白板（E4 回归）。
 * 在这里统一判：返回 true = 这张卡此刻被禁。
 */
function combatCardBlocked(combat, pl, def) {
  const list = combat && combat.blocked && pl ? combat.blocked[pl.id] : null;
  if (!list || !list.length || !def) return false;
  for (const b of list) {
    if (blockMatchesDef(b, def)) return true;
  }
  return false;
}

/**
 * 「这张牌的类别，对不对得上某个**类别写法**」——【阴魂丝】的类别封锁（`combat.blocked`）
 * 与【铜钱】【虚天鼎】【雷火锥】的"无效对方某类牌"（`effect.block`）共用同一套写法。
 *
 * 写法一共这几种（卡文原样抄进来）：
 *   `消耗类宝物牌` / `装备类宝物牌` / `宝物牌` / `法术牌` / `法术牌/宝物牌` / `同行者`
 * 认不出的写法返回 false —— 调用方各自决定"认不出就当拦不住"还是"认不出就不摆出来"。
 */
const BLOCK_KINDS = ['消耗类宝物牌', '装备类宝物牌', '宝物牌', '法术牌', '法术牌/宝物牌', '同行者'];
function blockMatchesDef(block, def) {
  if (!block || !def) return false;
  const deck = deckOf(def.id);
  if (block === '消耗类宝物牌') return deck === 'treasure' && def.type === 'consume';
  if (block === '装备类宝物牌') return deck === 'treasure' && def.type === 'equip';
  if (block === '宝物牌') return deck === 'treasure';
  if (block === '法术牌') return deck === 'spell';
  if (block === '法术牌/宝物牌') return deck === 'spell' || deck === 'treasure';
  if (block === '同行者') return deck === 'companion';
  return false;
}

/**
 * 找出此刻**能响应**这个时点的人。
 *
 * `event` 可以是：
 *   · 一个事件名（`'roll'`）—— 老用法；
 *   · 事件名数组（`['combatDeclare','combatOpt']`）—— **合并窗口**（名字相同、一次性问完）；
 *   · 规格数组（`[{event:'combatDeclare', subjectId, counterId}, {event:'combatOpt', allSides:true}]`）——
 *     每个事件各自的主体/对家规则。
 *
 * ⚠️ 合并窗口**不能**把一个 `allSides` 套给所有事件：`combatDeclare` 的规则是"被指定为目标的那一方"
 * （【阴魂丝】"当你被指定为对战目标时"），而 `combatOpt` 是"双方各看自己的牌" —— 混用会让**攻方**
 * 也能打出【阴魂丝】。
 *
 * 判定口径：手牌看它声明的时点是否落在当前窗口（satisfiedWindows），
 * 场上的装备/同行者交给 collectEffects。
 *
 * **主体是逐效果判的**（这是这层最容易写错的地方）：
 *   效果的 `subject` 表示"这件事发生在谁身上"，而**响应者是卡主**。
 *     · subject:'self'（卡文写「我方…」/「当你…」）→ 卡主必须就是**事件主体**
 *     · subject:'foe' （卡文写「对方…」）        → 卡主必须是**事件对家**
 *   例 1：【寒冰珠】「对方投骰**前**使用」→ 事件主体是那个要投骰的人，拿牌响应的是他的**对家**。
 *   例 2：【阴魂丝】「当你被指定为对战目标」→ 事件主体是**宣告对战的那个人**，
 *         拿牌响应的是**被指定的一方**，所以它写 subject:'foe'。
 * 没有 `subject` 的事件（对战结果/对战结束）谁都能响应。
 */
function timingResponders(state, event, phase, ctx) {
  const raw = Array.isArray(event) ? event : [event];
  const specs = raw.map((x) => (typeof x === 'string' ? { event: x } : x))
    .filter((sp) => sp && META.EVENTS[sp.event]);
  if (!specs.length) return [];
  const c = ctx.combat || null;
  const subjectId = ctx.subjectId || null;
  const counterId = ctx.counterId || null;
  const out = [];
  for (const cand of state.players) {
    if (!cand || cand.out) continue;
    // 每个规格各自的"主体 / 对家 / 阶段"
    const roles = specs.map((sp) => {
      const sid = sp.subjectId !== undefined ? sp.subjectId : subjectId;
      const cid2 = sp.counterId !== undefined ? sp.counterId : counterId;
      // allSides：这次询问**在场每个人都问**（"要不要花法力启用装备/发动效果"）——
      // 每个人只被问到**自己**的牌，所以把 isSubject/isCounter 都当成立即可。
      const all = !!(sp.allSides || ctx.allSides);
      return {
        spec: sp,
        ev: META.EVENTS[sp.event],
        // 「对家」是谁：明确指了就按指定的（对战宣告 = 被指定的那位）；
        // 没指定（如"对方出牌时"）就把**所有非主体的人**都算作潜在对家 —— 3~4 人局里
        // 谁都能拿【虚天鼎】去无效别人打出的牌。
        isSubject: all ? true : (!!sid && cand.id === sid),
        isCounter: all ? true : (cid2 ? (cand.id === cid2) : (!!sid && cand.id !== sid)),
        phase: sp.phase !== undefined ? sp.phase : (phase || null),
      };
    });
    // 场上的装备 / 同行者：只看一次，下面按效果各自判主体
    const board = collectEffects(cand, null, { self: cand, state: state, combat: c });
    const openWins = c ? satisfiedWindows(state, cand, c) : null;
    const push = (inst, def, e, where) => out.push({
      pl: cand, inst: inst, def: def, eff: e, timing: META.timingOfEffect(e), where: where,
    });
    const eligible = (e, def) => {
      const t = META.timingOfEffect(e);
      if (!t) return false;
      const hit = roles.find((r) => r.spec.event === t.event);
      if (!hit) return false;
      // ⭐「应对」门（用户 2026-10-05 裁定：**只有带应对的卡/效果才能进【斗法】链**）。
      //   只在**响应型窗口**上生效（被指定为目标 / 对战可选发动 / 对方出牌 / 投骰前后 / 对战结算 / 受伤）；
      //   阶段内可选窗口（探索替换、晋升减消耗、回合结束、装备即结算、放置、闭关、濒危）不算破招，照旧不问。
      //   效果级 `response` 可以覆盖卡级（写 false 表示这条不参与破招）。
      if (META.needsResponse(t.event, t.phase || hit.phase) && !hasResponse(def, e)) return false;
      // ⭐ 「只在对战中可用」的效果（OPS 标了 `requiresCombat`：【铜钱】【虚天鼎】的"使对方某张牌无效"、
      //    `damage` 的 attacker 模式）：**没有进行中的对战时不该摆出来问**。
      //    ⚠️ 以前只有"直接出牌"那条路拦了（playable 里那句 `effectRequiresCombat`），
      //    **窗口候选这条漏了** —— 于是对手在非对战时打一张牌，你手里的【铜钱】也被摆出来破招
      //    （用户 2026-10-06 截图报的：窗口是「卡牌使用·前」，但对战根本没开）。
      if (META.effectRequiresCombat(e) && !c) return false;
      // ⭐ 「无效对方某类牌」还得看**对方打的这张牌是哪一类**：
      //    【铜钱】只能无效【宝物牌】、【雷火锥】只能无效【法术牌】、【虚天鼎】两者都行。
      //    以前不看 —— 甲打一张法术牌，乙手里的【铜钱】（卡文明写"消耗类/装备类宝物牌"）也被摆出来问。
      //    `ctx.cardId` = 正在被打出的那张牌（两条路径都给了：链上那一环 / doPlay 的那张）。
      if (e.op === 'nullify_enemy_card' && ctx.cardId && BLOCK_KINDS.indexOf(e.block) >= 0) {
        const played = cardDef(ctx.cardId);
        if (!blockMatchesDef(e.block, played)) return false;
      }
      if (ctx.resultRole) {
        // 「对战结果」是**按卡主角色**判阶段的：赢家只能打「获胜时」，输家只能打「失败时」，
        // 平局时两边都能打「平局时」。所以这一个窗口里赢家和输家的牌都能进（锁链的基础）。
        const role = ctx.resultRole[cand.id];
        if (!role) return false;
        if ((t.phase || null) !== role) return false;
      } else if (hit.ev.phases.length && (t.phase || null) !== hit.phase) return false;
      if (hit.ev.subject === 'both') {
        const need = t.subject || 'self';
        if (need === 'self' && !hit.isSubject) return false;
        if (need === 'foe' && !hit.isCounter) return false;
      }
      // 晋升窗口特判（2026-10-05 用户实盘反馈）：「减**消耗**」的折扣牌在消耗已经是 0 时不摆出来 ——
      // 问了也白问（晋升炼气/筑基消耗本来就是 0，弹窗问【娑罗珠】【降尘丹】纯属打扰）。
      if (e.op === 'promote_discount_once' && (e.on === 'consume')
        && typeof ctx.promoteConsume === 'number' && ctx.promoteConsume <= 0) return false;
      // 附加条件（如【还阳术】的 if.lethal）
      return matchConditions(e.if, Object.assign({}, ctx, { self: cand, state: state, combat: c }));
    };
    // 付不起的牌不要摆出来问 —— 否则会开出"只能点放弃"的空窗口。
    // 规则：**消耗法力才能发动的都是主动询问**（【温天仁】3 点、【墨彩环】3 点…），付不起就不该问。
    const affordable = (e, where) => {
      const need = where === 'hand' ? 0 : ((e && e.manaCost) || 0);
      return need <= 0 || cand.mana >= need;
    };
    for (const inst of cand.hand) {
      const def = cardDef(inst.id);
      if (!def) continue;
      // 装备类（宝物牌 / 法术牌）**在手牌里永远不是时点响应候选**。
      // 规则：手里"打出"一张装备类 = 只是把它**【装备】**进储物袋/法术区，**不发动任何效果**
      //（卡文那句"（装备时不消耗【法力值】）"说的就是这个：装备免费，效果之后在场上花钱发动）。
      // 所以它的效果只能在**场上**进锁链：
      //   【绿煌剑】【黑血刀】【青竹蜂云剑】【青元剑诀】的"对战启用费"（combatOpt）
      //   【虚天鼎】的"使对方任意 1 张法术/宝物牌无效"（useCard·before）
      // 少了这一道，玩家会在时点弹窗里看到手里的【黑血刀】并点"手牌打出"，
      // 结果只是把它装备上、白白占掉一次响应机会（而且效果一点没发动）。
      if (def.type === 'equip') continue;
      if ((def.cost || 0) > cand.mana) continue;       // 手牌响应要付角标法力，付不起就别问
      if (combatCardBlocked(c, cand, def)) continue;   // 【阴魂丝】类别封锁：不摆出来问
      for (const e of effectsOf(def, inst)) {
        if (!eligible(e, def)) continue;
        // 「一回合一次」的效果发动过就不再摆出来（【虚天鼎】第一条，用户裁定）
        if (usedThisTurn(state, cand, inst, e)) continue;
        // 「可用 N 次」用完（卡面"此【宝物牌】可使用2次"）—— 不再摆出来问
        if (usesLeft(def, inst) <= 0) continue;
        // 「当前对战窗口开没开」这一关，**老写法与总线坐标都要过**（见 META.windowOk）：
        //   以前只查 `e.when`，效果迁成坐标后整段检查被跳过 → 甲投骰之后，他手里那张
        //   「我方投骰前」的牌还挂在响应者候选里（2026-10-02 timing-bus-test 逮到）。
        //   ⚠️ 判据必须落到**旧窗口名**上：`combatStart` 与 `beforeFoeRoll` 归一化后是同一个键。
        if (!META.windowOk(e, openWins)) continue;
        push(inst, def, e, 'hand');
      }
    }
    for (const x of board) {
      if (x.eff.when === 'passive' || x.eff.when === 'activate') continue;   // 非时点
      // 结果窗口默认只认**手牌**：**免费**的场上 win/lose 效果（【风雷翅】【敛气术】的"获胜追加伤害"、
      // 【罗烟步】）是自动触发的，由 runOnWinEffects / runOnLoseEffects 负责，不进锁链、也不该摆出来问。
      // ⚠️ 例外 = **要付费**的场上效果：用户通则「需要付费的都要询问」，而它的付费时刻就是卡文写的时点
      //    （【绿煌剑】"在对战获胜时"→ 获胜结算时才问「花 3 点让【绿煌剑】额外造成 1 点伤害？」）。
      //    2026-10-06 用户报的「战胜时发动的效果被移到对战开始时就触发时点」就是这一条漏了 ——
      //    它以前只能靠开战时的"启用费"通道，于是**问在开战、赢不赢都得先付**。
      if (ctx.handOnly && !((x.eff && x.eff.manaCost) || 0)) continue;
      if (!eligible(x.eff, x.def)) continue;
      // 同上：一回合一次的场上效果，本回合已发动过就不再问
      if (usedThisTurn(state, cand, x.inst, x.eff)) continue;
      // 「可用 N 次」用完（【青竹蜂云剑】【龙纹四象蟠龙带】【青冥针】这类"可使用2次"）
      if (usesLeft(x.def, x.inst) <= 0) continue;
      // 优先权循环的防重复问：本场对战出牌阶段（roll·before）里已发动过的**场上**牌，
      // 收势后重开的窗口不再问它（登记在 respondPlay；手牌打出去就没了，只有场上牌需要这道）。
      if (c && c.firedRollBoard && c.firedRollBoard[cand.id] && c.firedRollBoard[cand.id][x.inst.uid]) {
        const tb = META.timingOfEffect(x.eff);
        if (tb && tb.event === 'roll' && (tb.phase || null) === 'before') continue;
      }
      // 免费 / 触发型的场上效果一律**自动**，不进询问（否则会出现"只能点放弃"的空窗口，
      // 而且响应一下会把效果跑第二遍）。见 boardAskable() 的说明。
      if (!boardAskable(x.def, x.eff)) continue;
      if (!affordable(x.eff, 'board')) continue;
      push(x.inst, x.def, x.eff, 'board');
    }
  }
  return out;
}

/**
 * 排队顺序：**回合玩家优先**，其余按座位号（游戏王规矩）。
 */
function responderOrder(state, responders) {
  const ids = [];
  for (const r of responders) if (ids.indexOf(r.pl.id) < 0) ids.push(r.pl.id);
  const turnId = state.players[state.turn] ? state.players[state.turn].id : null;
  ids.sort((a, b) => {
    if (a === turnId) return -1;
    if (b === turnId) return 1;
    const sa = (p(state, a) || {}).seat || 0, sb = (p(state, b) || {}).seat || 0;
    return sa - sb;
  });
  return ids;
}

/**
 * 打开一个**打断窗口**：有人能响应就挂起流程，等人表态。
 * 返回 { opened:false } 表示没人在意 —— 调用方照旧往下走（绝大多数情况）。
 */
function openInterrupt(state, event, phase, ctx) {
  if (state.pending) return { opened: false };            // 已经有窗口开着，不叠（v1 限制）
  // 合并窗口：ctx.specs 里带着"多个事件各自的规则"（见 doCombat 的「对战阶段」）
  const responders = timingResponders(state, ctx.specs || event, phase || null, ctx);
  if (!responders.length) return { opened: false, responders: [] };
  // 只有**真的有牌可响应**的人才进队列。
  //   以前 `ctx.order`（结果窗口的"赢家先、输家后"）是**无条件**把人塞进来的，
  //   于是手里一张能打的牌都没有的那一方也会被弹窗问一次 —— 点开只有"跳过"。
  //   顺序仍然按 order 优先，但**成员资格**只由 responders 决定。
  const hasResp = {};
  for (const r of responders) hasResp[r.pl.id] = true;
  // 排队顺序：默认"回合玩家优先"；结果窗口会显式给 `ctx.order`（赢家先，输家后）
  let queue;
  if (ctx.order && ctx.order.length) {
    const seen = {};
    queue = ctx.order.filter((id) => { if (seen[id] || !hasResp[id]) return false; seen[id] = true; return true; });
    for (const id of responderOrder(state, responders)) if (!seen[id]) { seen[id] = true; queue.push(id); }
  } else {
    queue = responderOrder(state, responders);
  }
  if (!queue.length) return { opened: false, responders: [] };
  state.pending = {
    kind: 'interrupt',
    event: event, phase: phase || null,
    subjectId: ctx.subjectId || null, counterId: ctx.counterId || null,
    ctx: ctx,
    queue: queue, passed: {}, chain: [],
    at: Date.now(),
  };
  // 时点中文名：**运行时**才分得清先攻/后攻 —— 阶段图上那 4 格（先攻出牌/先攻投掷骰子/后攻…）
  // 在数据里是同一格（`roll`·我方/对方·前/后），只有引擎知道"投骰的这个人是不是先攻"。
  // 所以这里传 `attacker`：ctx.subjectId === combat.attacker 时才是先攻。
  const combat = ctx.combat || state.combat || null;
  const attackerFlag = (combat && ctx.subjectId)
    ? (ctx.subjectId === combat.attacker)
    : null;
  const label = META.timingLabelIn({ event: event, subject: ctx.subject || null, phase: phase || null },
    { attacker: attackerFlag });
  const first = p(state, queue[0]);
  log(state, 'timing',
    `〔斗法〕「${label}」${queue.map((id) => (p(state, id) || {}).name).join('、')} 可以破招。` +
    `请 ${first ? first.name : '?'} 先决定（打出牌或跳过）。`,
    { timing: event, phase: phase || null, queue: queue });
  return { opened: true, responders: responders, pending: state.pending };
}

/**
 * 当前该谁表态。
 *
 * ⚠️ 这里**必须走 settleIfQueueEmpty 而不是裸 prunePendingQueue**：
 * `pendingActor()` 会被 `publicState()` 调用（每次状态推送都调），而它是唯一
 * "把出局的人剔出队列"的入口。如果剔空了却只返回 null、把窗口留着，就会出现
 * **空窗口**：队列空 → 谁都不是 amActor → 跳过按钮对所有人都 disabled →
 * 又被全屏遮罩挡住 → **整桌硬死锁**。
 * （balance-stats 的 360 局实测里，约 3% 的局就是这样卡死的；当时的 harness
 *   只调了 pendingTimeout，而看门狗在空队列时也什么都不做，于是永远出不来。）
 */
function pendingActor(state) {
  if (!state.pending) return null;
  settleIfQueueEmpty(state);          // 剪空 → 顺手把窗口结算掉
  if (!state.pending || !state.pending.queue.length) return null;
  return p(state, state.pending.queue[0]);
}

/**
 * 把"已经出局"的人从待表态队列里剔掉。
 * 必须做：窗口开着的期间**别人可能已经把这个人打死了**（例如一张多目标伤害牌），
 * 这时他还占着队首，`act()` 会因为"你已出局"拒掉他的表态，整局就卡死了。
 */
function prunePendingQueue(state) {
  const pd = state.pending;
  if (!pd) return 0;
  let n = 0;
  while (pd.queue.length) {
    const who = p(state, pd.queue[0]);
    if (who && !who.out) break;
    pd.queue.shift();
    n++;
  }
  return n;
}

/** 队列被剪空的兜底：没人可表态就直接结算（否则窗口永远开着，整局卡死） */
function settleIfQueueEmpty(state) {
  if (!state.pending) return false;
  prunePendingQueue(state);
  if (state.pending.queue.length) return false;
  resolvePending(state);
  return true;
}

/**
 * 某个玩家此刻在打断窗口里可以响应的牌（给前端画按钮用）。
 * `where` 区分两种：
 *   'hand'  —— 打出手牌（付费 + 进弃牌堆）
 *   'board' —— 发动场上已有的装备/同行者（不弃牌，如【虚天鼎】是装备类法宝，装上后反复可用）
 */
function pendingCards(state, pl) {
  if (!state.pending || !pl) return [];
  if (state.pending.queue[0] !== pl.id) return [];
  const pd = state.pending;
  const out = [];
  for (const r of timingResponders(state, (pd.ctx && pd.ctx.specs) || pd.event, pd.phase, pd.ctx)) {
    if (r.pl.id !== pl.id) continue;
    // 这个候选要花多少法力 —— 手牌看角标，场上的看效果自己印的 `manaCost`
    // （【温天仁】的 3 点就印在效果上，不在卡面角标）。前端直接用这个数显示。
    const cost = r.where === 'hand' ? (r.def.cost || 0) : ((r.eff && r.eff.manaCost) || 0);
    const base = {
      uid: r.inst.uid, id: r.def.id, name: r.def.name,
      deck: deckOf(r.def.id), where: r.where, cost: cost,
      // ⭐ 这张候选要不要**在弹窗里先选目标**（【青冥针】选人 /【金魁】选场上的牌）——
      //    前端据此弹"选择目标"而不是直接把动作发出去。
      needsTarget: META.effectNeedsTarget(r.eff) || undefined,
      targetKind: META.effectTargetKind(r.eff) || undefined,
    };
    // 「二选一」这类**同境界多选**（【火弹术】）：每个选项各列一条候选，
    // 前端点哪条就是哪个效果（锁链里也能选了 —— 以前这里只有一条，永远只能走第 0 档）。
    // 境界档不进这里：它自动适配，只算一条候选。
    if (r.def.tiers && r.def.tiers.length && isEitherOr(r.def)) {
      for (const i of tierSiblings(r.def, maxTierFor(r.def, pl.realm))) {
        const t = r.def.tiers[i];
        if (!t || (t.realm || 0) > pl.realm) continue;
        // 「二选一」的另一半可能是"要指定目标"的那一条 → 每条候选各自判
        const te = (t.effects || []).find((x) => META.effectNeedsTarget(x)) || null;
        out.push(Object.assign({}, base, {
          tier: i, option: t.text || ('选项' + (i + 1)),
          needsTarget: te ? true : base.needsTarget,
          targetKind: te ? META.effectTargetKind(te) : base.targetKind,
        }));
      }
    } else {
      out.push(base);
    }
  }
  return out;
}

/**
 * 重新排一遍待表态队列。`preferId` 排在最前（刚出过牌的人可以**继续往上叠**，
 * 这是锁链"后进链的先结算"能成立的前提）；已经没牌可响应的人自动退出队列。
 */
function refreshPendingQueue(state, preferId) {
  const pd = state.pending;
  if (!pd) return;
  // 本窗口里已发动过的**场上**牌按 **uid** 记：以前按"人"记（chain 里有这人就锁死他全部场上效果），
  // 于是打出一张**手牌**（如【乌龙夺】）就把同一个人的**场上**牌（如【黑血刀】启用费）也锁死了
  // （用户 2026-10-05 实盘踩到：破招打出乌龙夺后，场上的黑血刀没被问就直接进投骰）。
  // 手牌打出即消耗、天然不会重复；场上同一张牌本窗口只发动一次。
  const boardPlayed = {};
  for (const link of pd.chain) {
    if (link.where === 'board') (boardPlayed[link.pid] = boardPlayed[link.pid] || {})[link.uid] = true;
  }
  const live = {};
  for (const r of timingResponders(state, (pd.ctx && pd.ctx.specs) || pd.event, pd.phase, pd.ctx)) {
    // 手牌：只要手里还有能响应的牌就算"还在"（可以继续叠）
    if (r.where === 'hand') live[r.pl.id] = true;
    // 场上：**这张 uid 还没发动过**才算"还在"
    else if (!(boardPlayed[r.pl.id] && boardPlayed[r.pl.id][r.inst.uid])) live[r.pl.id] = true;
  }
  const rest = pd.queue.filter((id) => live[id] && id !== preferId);
  const head = (preferId && live[preferId]) ? [preferId] : [];
  pd.queue = head.concat(rest);
}

/** 放弃破招（旧称"放弃响应"） */
function respondPass(state, pl) {
  const pd = state.pending;
  if (!pd) return { ok: false, error: '现在没有需要破招的时点' };
  if (pd.queue[0] !== pl.id) return { ok: false, error: '现在不是你的表态时机' };
  pd.queue.shift();
  pd.passed[pl.id] = true;
  log(state, 'timing', `${pl.name} 不破招，跳过。`);
  return nextOrResolve(state);
}

/**
 * 响应：打出手牌，或发动场上已有的牌（【虚天鼎】是装备类法宝，装上后反复可用）。
 * 进链后等所有人表态完一起倒序结算。
 */
/**
 * 破招：把一张牌（手牌或场上）入【斗法】链。
 *
 * ⭐ 2026-10-05 起支持**在窗口里选目标**（`a.target` = 一位修士 / `a.targetUid` = 场上一张牌）：
 *   【青冥针】"受伤时指定任意一位修士受到等额伤害"、【金魁】"使场上任意 1 张宝物/法术牌无效"
 *   都靠它。目标记在这条链的 link 上，收势时（resolvePending）注进效果的 ctx。
 */
function respondPlay(state, pl, uid, tier, actSrc) {
  const a = actSrc || {};
  const pd = state.pending;
  if (!pd) return { ok: false, error: '现在没有需要响应的时点' };
  if (pd.queue[0] !== pl.id) return { ok: false, error: '现在不是你的表态时机' };
  // ⚠️ uid 统一成数字再比：前端 dataset / JSON 往返都可能给出字符串，
  //    而下面几处原来是严格 `===`，字符串 uid 会一路匹配失败，
  //    最后报"你手里和场都没有这张牌"（装好的【虚天鼎】实测就死在这里）。
  uid = (typeof uid === 'string' && uid !== '' && !isNaN(Number(uid))) ? Number(uid) : uid;
  // 手牌 或 场上（储物袋/法术区/同行者）里找这张牌
  let inst = pl.hand.find((x) => x.uid === uid) || null;
  let where = 'hand';
  let handIdx = -1;
  if (inst) {
    handIdx = pl.hand.indexOf(inst);
  } else {
    for (const pool of [pl.equip, pl.spells, pl.companions, pl.puppets || []]) {
      const found = pool.find((x) => x.uid === uid);
      if (found) { inst = found; where = 'board'; break; }
    }
  }
  if (!inst) return { ok: false, error: '你手里和场都没有这张牌' };
  const def = cardDef(inst.id);
  if (where === 'hand' && combatCardBlocked(state.combat, pl, def)) {
    return { ok: false, error: `【${def.name}】被封锁：本次对战中不能使用该类卡牌（【阴魂丝】）` };
  }
  const ok = timingResponders(state, (pd.ctx && pd.ctx.specs) || pd.event, pd.phase, pd.ctx)
    .some((r) => r.pl.id === pl.id && r.inst.uid === uid);
  if (!ok) return { ok: false, error: `【${def.name}】不能在这个时点破招` };
  // 只有"打出手牌"才付角标法力、才进弃牌堆；发动场上的牌不弃牌。
  // ⚠️ 场上的牌如果这条效果自己印了 `manaCost`（【温天仁】"消耗 3 点法力值"、【墨彩环】同理），
  //    这里**不扣** —— 由 resolvePending 在链结算时统一扣一次，否则会和效果本体重复扣两遍。
  // 这次响应命中的效果条目（用于：场上效果的法力消耗、以及「一回合一次」的记账）
  const matched = timingResponders(state, (pd.ctx && pd.ctx.specs) || pd.event, pd.phase, pd.ctx)
    .find((r) => r.pl.id === pl.id && r.inst.uid === uid) || null;
  // ⭐ **窗口里选目标**（2026-10-05）：这条效果要目标就必须给，缺了直接拒（免得白打出这张牌）。
  //    kind='player' → `a.target`（一位修士）；kind='board' → `a.targetUid`（场上一张牌）。
  const needKind = matched ? META.effectTargetKind(matched.eff) : null;
  const linkTarget = a.target != null && a.target !== '' ? String(a.target) : null;
  const linkTargetUid = a.targetUid != null && a.targetUid !== '' ? a.targetUid : null;
  if (needKind === 'board') {
    if (linkTargetUid == null) return { ok: false, error: `【${def.name}】需要先指定场上的一张牌` };
    if (!findBoardInst(state, linkTargetUid)) return { ok: false, error: '指定的那张牌不在场上' };
  } else if (needKind === 'player' || META.effectNeedsTarget(matched && matched.eff)) {
    if (!linkTarget) return { ok: false, error: `【${def.name}】需要先指定一位目标` };
    const tp = p(state, linkTarget);
    if (!tp || tp.out) return { ok: false, error: '指定的目标无效（不存在或已出局）' };
  }
  let cost = 0;
  if (where === 'hand') {
    cost = def.cost || 0;
    if (cost > 0 && pl.mana < cost) return { ok: false, error: `法力值不足（需要 ${cost}，当前 ${pl.mana}）` };
    if (cost > 0) pl.mana -= cost;
    pl.hand.splice(handIdx, 1);
    if (def.equipSlot !== 'puppet') toDiscard(state, deckOf(def.id), def.id);
  } else {
    cost = (matched && matched.eff && matched.eff.manaCost) || 0;
    if (cost > 0 && pl.mana < cost) return { ok: false, error: `法力值不足（需要 ${cost}，当前 ${pl.mana}）` };
  }
  // 锁链里的档位：以前**完全不看** `tier` —— 手牌进链时 `inst.tier` 是 undefined，
  // `effectsOf` 会把它夹到第 0 档，于是【火弹术】"二选一"的另一半永远打不出来（用户报过）。
  // 现在：境界档自动适配（用户裁定），同境界多选照用前端勾的那一项。
  const linkTier = (def.tiers && def.tiers.length)
    ? resolveTier(def, pl.realm, tier)
    : inst.tier;
  pd.chain.push({ pid: pl.id, uid: uid, defId: def.id, cost: cost, where: where, tier: linkTier,
    target: linkTarget, targetUid: linkTargetUid });
  // 优先权循环的防重复问：出牌阶段（roll·before）里发动过的**场上**牌登记到本场对战，
  // 收势后重开的窗口不再问它（见 timingResponders 的过滤）
  if (where === 'board' && state.combat && pd.event === 'roll' && pd.phase === 'before') {
    const cc = state.combat;
    cc.firedRollBoard = cc.firedRollBoard || {};
    (cc.firedRollBoard[pl.id] = cc.firedRollBoard[pl.id] || {})[uid] = true;
  }
  // 「一回合一次」：发动即记账（回合开始清零）—— 之后本回合不再进候选
  if (matched) markTurnUse(state, pl, inst, matched.eff);
  // 「可用 N 次」：**发动即记账**（卡面"此【宝物牌】可使用2次"）。手牌打出的本来就进弃牌堆，只记场上牌。
  if (where === 'board' && def.uses) {
    markUse(pl, def, inst);
    const left = usesLeft(def, inst);
    log(state, 'info', `【${def.name}】用掉 1 次，还剩 ${left} 次。`, { player: pl.id, card: def.id, usesLeft: left });
  }
  // 破招打出的牌也算"本回合打出过"（【虚天鼎】这类场上的牌走 where==='board'，不重复记手牌）
  if (where === 'hand') markPlayed(state, pl, def);
  const onceNote = (matched && matched.eff && matched.eff.oncePerTurn) ? '（本回合仅此一次）' : '';
  const optNote = (def.tiers && def.tiers.length && isEitherOr(def) && def.tiers[linkTier])
    ? `（选：${def.tiers[linkTier].text}）` : '';
  log(state, 'timing',
    `${pl.name} 破招${where === 'hand' ? '打出' : '发动'}【${def.name}】${optNote}${onceNote}${cost ? `（消耗 ${cost} 点法力值）` : ''}，入【斗法】（后发先至，逆序收势）。`,
    { card: def.id, chainLength: pd.chain.length, where: where, tier: linkTier });
  // 出过牌的人留在队首 → 可以继续叠牌；他不叠了就点"放弃"，队列才往下走。
  refreshPendingQueue(state, pl.id);
  if (!pd.queue.length) return resolvePending(state);
  const nxt = p(state, pd.queue[0]);
  if (nxt && nxt.id !== pl.id) log(state, 'timing', `请 ${nxt.name} 决定是否破招。`);
  return { ok: true, waiting: pd.queue[0] };
}

/** 没人再表态 → 逆序收势 → 打开流程 */
function nextOrResolve(state) {
  const pd = state.pending;
  if (!pd) return { ok: true };
  prunePendingQueue(state);
  refreshPendingQueue(state, null);
  if (pd.queue.length) {
    const nxt = p(state, pd.queue[0]);
    log(state, 'timing', `请 ${nxt.name} 决定是否破招。`);
    return { ok: true, waiting: pd.queue[0] };
  }
  return resolvePending(state);
}

/**
 * 这个窗口**接受哪些事件**。普通窗口就一个；**合并窗口**（如「对战阶段」把
 * `combatDeclare` + `combatOpt` 合成一次询问）要在 `ctx.specs` 里列出来。
 *
 * ⚠️ 结链时必须用它、不能裸比 `pd.event`：否则玩家用「可选发动」类效果（付费启用【青元剑诀】、
 * 【温天仁】的 3 点）响应合并窗口时，会被判成"在这个时点上没有可结算的效果" →
 * **不扣费、不登记 equipEnabled**（2026-10-02 合并开战窗口时实测踩到）。
 */
function windowEventsOf(pd) {
  const specs = (pd && pd.ctx && pd.ctx.specs) || null;
  if (specs && specs.length) return specs.map((s) => (typeof s === 'string' ? s : s.event));
  return [pd && pd.event];
}

/**
 * 链的**收尾**：链跑完了要干的三件事 —— ①【虚天鼎】式"这次出牌被无效 → 不 resume"
 * ②把 resume 挂到"链结算途中新开的窗口"上 ③否则直接 resume 外面的流程。
 * 从 resolvePending 里抽出来，是因为链现在可能**中途挂起**（见 resolveChainFrom），
 * 收尾必须等整条链真的跑完才做。
 */
function finishPending(state, pd) {
  // 【虚天鼎】/【铜钱】：响应牌把对方正在打出的那张牌无效掉了 → **不 resume**，那次出牌就此取消
  //   ⚠️ 只对**出牌路径**（doPlay 的「卡牌使用·前」，`pd.ctx` 没有 `linkUid`）生效。
  //   对战里出牌走的是【斗法】链，那次无效由 `resolveChainFrom` 跳过链上那一环来表达，
  //   链**照常收尾**、外面的流程**照常 resume** —— 以前没分流，链内无效会被这里
  //   "取消出牌"提前 return，于是 ①不 resume ②链也没收尾 → 整场对战卡死（实测踩到）。
  const nul = state.nullifiedPlay;
  state.nullifiedPlay = null;
  const nulIsLink = !!(nul && nul.linkUid != null);
  if (nul && !nulIsLink && pd.event === 'useCard') {
    log(state, 'info', `【${nul.cardName}】被【${nul.byCardName || '虚天鼎'}】无效，本次出牌取消。`);
    return { ok: true, nullified: true };
  }
  // 继续原来的流程（resume 挂在 ctx 上，不是挂在 pending 顶层 —— 这里踩过一次坑）。
  // ⚠️ **链结算的过程中可能又开了新窗口**：例如【风灵劲】结算时打出了伤害，
  //    受伤那一格会开一个 `hurt` 询问（【慕沛灵】的免费回法力曾经也会开，已修）。
  //    这时**绝不能**立刻 resume —— 新窗口还没人表态，外面的流程就先跑完了：
  //    `doCombat` 会白白跳过 `combatOpt` 窗口、`resolveCombat` 会直接把战果结算掉，
  //    玩家手里「在对战获胜时使用」的【风云幡】【火弹术】就**再也没机会打**。
  //    做法：把 resume 挂到那个新窗口上，等它关掉之后再接着往下跑。
  const resume = (pd.ctx && pd.ctx.resume) || pd.resume;
  if (typeof resume === 'function') {
    if (state.pending) {
      const inner = state.pending.ctx.resume;
      state.pending.ctx.resume = function () {
        if (typeof inner === 'function') inner();
        resume();
      };
      return { ok: true, waiting: state.pending.queue[0] };
    }
    try { resume(); } catch (err) { log(state, 'info', `时点恢复失败：${err && err.message}`); }
  }
  return { ok: true };
}

/**
 * 从链的第 `i` 环往前结算（**后进链的先结算**）。
 *
 * 抽成可续跑的形式，是为了「**对方出牌时**」这一类效果（【铜钱】"让对方使用的任意 1 张
 * 【消耗类/装备类宝物牌】效果无效"、【虚天鼎】同理）：
 * 它们要的时点是"**那张牌结算之前**"，而在对战里出牌全走【斗法】链（不是 doPlay），
 * 所以只能在这里、对**每一环手牌**问一次对家。
 *   · 只在对战里问（`requiresCombat` 已在候选层把关）；
 *   · 没人能响应时 `fireTiming` 返回 opened:false → 零响应直通，与其他卡无差别；
 *   · 真开了窗口就 `return {paused:true}`，窗口的 resume 会回到同一个下标继续（同一环只问一次）。
 */
function resolveChainFrom(state, pd, winEvents, i, cont) {
  const chain = pd.chain;
  for (; i >= 0; i--) {
    const link = chain[i];
    const owner = p(state, link.pid);
    const def = cardDef(link.defId);
    if (!owner || !def) continue;
    // ⭐ 「对方出牌时」：手牌进链的这张牌，结算**之前**给对家一次破招机会
    if (link.where === 'hand' && pd.ctx && pd.ctx.combat) {
      state.nullifyAsked = state.nullifyAsked || {};
      if (!state.nullifyAsked[link.uid]) {
        state.nullifyAsked[link.uid] = true;
        const cc = pd.ctx.combat;
        const foeId = cc.attacker === link.pid ? cc.defender : (cc.defender === link.pid ? cc.attacker : null);
        const r = fireTiming(state, 'useCard', 'before', {
          subjectId: link.pid, counterId: foeId, combat: cc,
          cardUid: link.uid, cardName: def.name, playerId: link.pid, cardId: def.id, linkUid: link.uid,
          // ⚠️ 挂起后必须回到**同一个下标**接着跑，而且**整条链跑完才算完**：
          //    以前这里只 `resolveChainFrom(...)`，跑完链尾就没人调 `finishPending` 了，
          //    外层流程（投骰/对战）永远等不到 resume —— 实测会**整场卡死**（用户 2026-10-06 那局的同类）。
          //    所以回调统一走 `cont`（resolvePending 里的 step：跑链 + 收尾）。
          resume: () => (typeof cont === 'function' ? cont(i) : resolveChainFrom(state, pd, winEvents, i)),
        });
        if (r.opened) return { paused: true };
      }
    }
    // 被【铜钱】/【虚天鼎】无效掉的那一环：有效果也不结算（牌已经打出去了，只是白打）
    if (state.nullifiedLinks && state.nullifiedLinks[link.uid]) {
      log(state, 'info', `【${def.name}】已被无效，本次不结算它的效果。`, { card: def.id });
      continue;
    }
    const effs = effectsOf(def, { tier: link.tier }).filter((e) => {
      const t = META.timingOfEffect(e);
      return t && winEvents.indexOf(t.event) >= 0 && (!pd.phase || (t.phase || null) === pd.phase)
        && matchConditions(e.if, Object.assign({}, pd.ctx, { self: owner, state: state, combat: pd.ctx.combat }));
    });
    if (!effs.length) {
      log(state, 'info', `【${def.name}】在这个时点上没有可结算的效果。`);
      continue;
    }
    log(state, 'timing', `收势：【${def.name}】的效果发动。`, { card: def.id });
    // 发动费：效果自己印的 `manaCost`（【温天仁】3 点、【墨彩环】3 点）在**这里**统一扣一次 ——
    // respondPlay 只做"付得起吗"的检查，不扣，否则会和效果本体重复扣两遍。
    const fee = (effs[0] && effs[0].manaCost) || 0;
    if (fee > 0) {
      if (owner.mana < fee) {
        log(state, 'info', `${owner.name} 法力值不足 ${fee} 点，【${def.name}】的效果不发动。`);
        continue;
      }
      owner.mana -= fee;
      log(state, 'mana_spend', `${owner.name} 消耗 ${fee} 点法力值，发动【${def.name}】。`, { player: owner.id, mana: owner.mana });
    }
    const rctx = Object.assign({}, pd.ctx, {
      self: owner, selfCardId: def.id, deck: deckOf(def.id),
      // ⭐ 链上这条自己带的**目标**（【青冥针】选的人 /【金魁】选的场上那张牌）优先于窗口级 ctx：
      //    同一个窗口里不同的人可以选不同的目标。
      target: link.target || pd.ctx.target || null,
      targetUid: link.targetUid != null ? link.targetUid : (pd.ctx.targetUid != null ? pd.ctx.targetUid : null),
      targetPl: (link.target || pd.ctx.target) ? p(state, link.target || pd.ctx.target) : null,
      // 让响应牌知道"我是在哪个时点、针对哪件事"出手的（【虚天鼎】靠它拿到被打出的那张牌）
      reaction: {
        event: pd.event, phase: pd.phase,
        cardUid: pd.ctx.cardUid, playerId: pd.ctx.playerId, cardName: pd.ctx.cardName,
        // ⭐「这一枪打的是**链上的哪一环**」（【铜钱】【雷火锥】无效链内出牌就靠它：
        //    只有链内出牌有 linkUid，doPlay 那条老路没有 —— nullify_enemy_card 用它分流）。
        linkUid: pd.ctx.linkUid != null ? pd.ctx.linkUid : null,
        subjectId: pd.subjectId, counterId: pd.counterId,
        lethal: pd.ctx.lethal, lostHp: pd.ctx.lostHp, source: pd.ctx.source, damage: pd.ctx.damage,
      },
      // 响应的是哪一件场上的牌 —— 【enable_equip_combat】靠它记账
      uid: link.uid,
    });
    for (const e of effs) {
      resolveEffect(state, owner, e, rctx, { source: 'card', def: def, inst: null });
    }
  }
  return { done: true };
}

/**
 * 结算锁链（**后进链的先结算**），然后 resumed 原来的流程。
 */
function resolvePending(state) {
  const pd = state.pending;
  if (!pd) return { ok: true };
  state.pending = null;                       // 先摘掉，避免结算过程中再被判定为"有窗口"
  const winEvents = windowEventsOf(pd);
  const chain = pd.chain;
  // 「阶段事务」的信号量：让 resume 知道这一轮有没有人真的发动了效果 ——
  // 探索阶段靠它决定"再问一轮"还是"收手，落基础行动"（双方/本人连续不发动才推进）。
  if (pd.ctx && pd.ctx.signal) pd.ctx.signal.chainLength = chain.length;
  // ⚠️ 链可能**中途挂起**（"对方出牌时"的窗口）：挂起时由那个窗口的 resume 回到 step(i) 接着跑，
  //    整条链跑完才走 finishPending（收尾一旦提前做，外面的流程就会带着没结算完的链往下跑）。
  const step = (i) => {
    const r = resolveChainFrom(state, pd, winEvents, i, step);
    if (r && r.paused) return;
    finishPending(state, pd);
  };
  step(chain.length - 1);
  return { ok: true, waiting: state.pending ? state.pending.queue[0] : undefined };
}

/**
 * 打断窗口超时（看门狗的兜底，防止挂死）。
 *
 * ⚠️ 队列为空时**不能直接 return {ok:false} 了事** —— 那正是"空窗口"的样子：
 * 看门狗每隔 INTERRUPT_TIMEOUT_MS 调一次，如果每次都不作为，这个窗口就永远留着，
 * 而全屏时点弹窗会把所有人的操作都挡住（跳过按钮对所有人 disabled）→ 硬死锁。
 * 先交给 settleIfQueueEmpty 收尾，收不掉才按"当前该谁表态"处理。
 */
function pendingTimeout(state) {
  const pd = state.pending;
  if (!pd) return { ok: false };
  if (settleIfQueueEmpty(state)) return { ok: true, settled: true };   // 剪空 → 直接结算
  if (!state.pending || !state.pending.queue.length) return { ok: false };
  const who = p(state, state.pending.queue[0]);
  log(state, 'timing', `〔时点〕${who ? who.name : '?'} 超时未表态，按放弃处理。`);
  return respondPass(state, who);
}

/**
 * 打开一个时点。零响应直通（**有人能响应且需要询问时**才返回 opened:true 挂起）。
 * @param ctx { subjectId, counterId, subject, combat, resume, ...任意上下文 }
 */
function fireTiming(state, event, phase, ctx) {
  const ev = META.EVENTS[event];
  if (!ev) return { opened: false, responders: [] };
  if (!state.timingFired) state.timingFired = {};
  const key = phase ? event + ':' + phase : event;
  state.timingFired[key] = (state.timingFired[key] || 0) + 1;
  const c = (ctx && ctx.combat) || state.combat || null;
  const merged = Object.assign({ combat: c }, ctx);
  // 需要"打断询问"的时点走 openInterrupt（有人能响应就挂起流程）；其余只做记录（零响应直通）。
  // interrupt 可以是 true（所有阶段）或阶段数组（只在这些阶段开）—— `useCard` 只在前半开，
  // 否则每打一张牌都会停下来问一次。
  const wantsInterrupt = ev.interrupt === true
    || (Array.isArray(ev.interrupt) && ev.interrupt.indexOf(phase || null) >= 0);
  if (wantsInterrupt) {
    const r = openInterrupt(state, event, phase, merged);
    if (r.opened) return { opened: true, responders: r.responders, pending: state.pending };
    return { opened: false, responders: [] };
  }
  const responders = timingResponders(state, merged.specs || event, phase || null, merged);
  if (!responders.length) return { opened: false, responders: [] };
  state.timingLog = state.timingLog || [];
  const label = META.timingLabel({ event: event, subject: (ctx && ctx.subject) || null, phase: phase || null });
  const who = responders.map((r) => `${r.pl.name}·【${r.def.name}】`).join('、');
  const snapshot = responders.map((r) => ({ player: r.pl.id, card: r.def.name, where: r.where }));
  state.timingLog.push({
    event: event, phase: phase || null, round: state.round,
    responders: snapshot,
  });
  // ⚠️ 文本里带了**牌名**，其中可能有别人手牌里的牌。客户端看到的是 publicLog() 的**逐视图**版本，
  //    它会把"别人的手牌候选"整条滤掉（用户 2026-10-02 报：抽牌时点把对手手牌写成明牌）。
  //    payload.responders 就是留给它打码用的结构化数据 —— 别删。
  log(state, 'timing', `〔斗法〕「${label}」有牌可破招：${who}。（该时点暂未接入询问层）`, {
    timing: event, phase: phase || null, responders: snapshot,
  });
  return { opened: true, responders: responders };
}

function resolveEffect(state, self, effect, ctx, meta) {
  if (!effect) return;
  // 效果 DSL：新数据用 `op`，旧数据用 `kind` —— 这里统一成 kind，下面的 switch 一行不用改
  if (!effect.kind && effect.op) effect = Object.assign({}, effect, { kind: effect.op });
  if (!effect.kind) return;
  ctx = ctx || {};
  if (ctx.combat) ensureCombat(ctx.combat);
  const target = ctx.target ? p(state, ctx.target) : null;
  // 「目标是**场上的一张牌**」——【金魁】这类效果用 `ctx.targetUid`（不是玩家 id）
  const targetInst = ctx.targetUid != null ? findBoardInst(state, ctx.targetUid) : null;
  const fromCard = meta && meta.source === 'card';
  // 「获得 1 张指定的法术牌，使用它时无视境界条件」—— 实物【李化元】
  if (effect.kind === 'grant_spell') {
    const want = effect.name;
    const pool = state.decks.spell.draw;
    const i = pool.findIndex((id) => { const d = cardDef(id); return d && d.name === want; });
    if (i >= 0) {
      const got = pool.splice(i, 1)[0];
      self.hand.push(mk(UID++, got));
      self.ignoreRealmIds = self.ignoreRealmIds || [];
      if (self.ignoreRealmIds.indexOf(got) < 0) self.ignoreRealmIds.push(got);
      log(state, 'draw', `${self.name} 从法术牌堆取走了【${want}】（使用它时无视境界条件）。`, { player: self.id, card: got });
      return;
    }
    log(state, 'info', `法术牌堆里已经没有【${want}】了。`);
    if (!effect.fallback) return;
    // 兜底：弃置自身，抽 1 张同行者（【李化元】卡文后半句）
    const uid = Number(ctx && ctx.selfUid);
    for (const arr of [self.companions, self.equip, self.spells]) {
      const k = arr.findIndex((x) => Number(x.uid) === uid);
      if (k < 0) continue;
      const gone = arr.splice(k, 1)[0];
      const d = deckOf(gone.id);
      if (d) toDiscard(state, d, gone.id);
      log(state, 'companion_down', `牌堆里已无【${want}】，【${(cardDef(gone.id) || {}).name}】放入弃牌堆。`);
      break;
    }
    const gs = drawFrom(state, 'companion', 1);
    for (const g of gs) self.hand.push(mk(UID++, g));
    return;
  }
  // 「牌堆里已无该牌时，弃置自身并抽 1 张同行者」—— 实物【李化元】的兜底
  if (effect.kind === 'discard_self_draw_companion') {
    for (const arr of [self.companions, self.equip, self.spells]) {
      const i = arr.findIndex((x) => Number(x.uid) === Number((ctx && ctx.selfUid)));
      if (i < 0) continue;
      const gone = arr.splice(i, 1)[0];
      const d = deckOf(gone.id);
      if (d) toDiscard(state, d, gone.id);
      log(state, 'companion_down', `牌堆里已无指定法术牌，【${(cardDef(gone.id) || {}).name}】放入弃牌堆。`);
      break;
    }
    const gs = drawFrom(state, 'companion', 1);
    for (const g of gs) self.hand.push(mk(UID++, g));
    return;
  }
  switch (effect.kind) {
    // 直接抽宝物牌（【梅凝】主动使用、【血玉蜘蛛】放置时）
    case 'draw_treasure': {
      const n = effect.value || 1;
      const got = drawFrom(state, 'treasure', n);
      for (const g of got) self.hand.push(mk(UID++, g));
      log(state, 'draw', `${self.name} 抽取 ${got.length} 张【宝物牌】。`, { player: self.id, deck: 'treasure' });
      break;
    }
    // 直接抽灵气牌（【银月】装备触发等）
    case 'draw_qi': {
      const n = effect.value || 1;
      const got = drawFrom(state, 'qi', n);
      for (const g of got) gainQiCard(state, self, g);
      log(state, 'info', `${self.name} 抽取 ${got.length} 张【灵气牌】。`);
      break;
    }
    case 'qi': {      // 卡牌效果直接给灵气值：用一张同价值灵气牌模拟（走灵气牌堆）
      const n = effect.value || 1;
      for (let i = 0; i < n; i++) {
        const got = drawFrom(state, 'qi', 1);
        if (got.length) gainQiCard(state, self, got[0]);
      }
      break;
    }
    case 'mana':
      self.mana = Math.min(manaCap(self), self.mana + (effect.value || 1));
      log(state, 'info', `${self.name} 获得 ${effect.value || 1} 点法力值（${self.mana}）。`);
      break;
    case 'qi_and_mana': {
      for (let i = 0; i < (effect.qi || 0); i++) {
        const got = drawFrom(state, 'qi', 1);
        if (got.length) gainQiCard(state, self, got[0]);
      }
      self.mana = Math.min(manaCap(self), self.mana + (effect.mana || 0));
      break;
    }
    case 'heal': {
      const before = self.hp;
      self.hp = Math.min(HP_MAX, self.hp + (effect.value || 1));
      if (self.hp !== before) log(state, 'heal', `${self.name} 恢复 ${self.hp - before} 点生命值（${self.hp}/${HP_MAX}）。`, { player: self.id, hp: self.hp });
      break;
    }
    case 'damage_target': {
      const t = (target && canBeAttacked(target)) ? target
        : alive(state).filter((x) => x.id !== self.id && !x.inSeclusion)[0];
      if (t) { log(state, 'info', `${self.name} 指定 ${t.name} 承受伤害。`); applyDamage(state, t, effect.value || 1, 'card', self.id); }
      else log(state, 'info', `场上没有可指定的目标。`);
      break;
    }
    case 'damage_all_others':
      for (const t of alive(state)) if (t.id !== self.id) applyDamage(state, t, effect.value || 1, 'card', self.id);
      break;
    // ⭐ 统一抽牌 op（2026-10-05 参数化合族）：单堆 = `deck` + `value`；多堆混合 = treasure/spell/companion
    // 三个张数（原 draw_mixed 并入）。旧 op（draw_treasure / draw_qi / draw_mixed …）的 case 保留读旧备份。
    case 'draw': {
      if (effect.treasure || effect.spell || effect.companion) {
        for (const [dk, n] of [['treasure', effect.treasure || 0], ['spell', effect.spell || 0], ['companion', effect.companion || 0]]) {
          if (!n) continue;
          const got = drawFrom(state, dk, n);
          for (const g of got) { self.hand.push(mk(UID++, g)); log(state, 'draw', `${self.name} 抽到【${(cardDef(g) || {}).name}】。`, { player: self.id, card: g, deck: dk }); }
        }
        break;
      }
      const dk0 = effect.deck || 'treasure';
      const got = drawFrom(state, dk0, effect.value || 1);
      for (const g of got) {
        if (dk0 === 'qi') gainQiCard(state, self, g);
        else {
          self.hand.push(mk(UID++, g));
          log(state, 'draw', `${self.name} 抽到【${cardDef(g).name}】。`, { player: self.id, card: g, deck: effect.deck });
        }
      }
      break;
    }
    // ⭐ 统一伤害 op：给谁 = `target`（缺省 'target' 指定一名 / multi 一至两人（max 上限）/
    //   all_others 其他全部 / self 自己 / self_then_target 先自伤再指定 / attacker 发起对战者 /
    //   loser 对战输家（结算上下文给目标））。附加：skip（并跳过回合）、ignore_companion。
    // 旧 op（damage_target / damage_multi / …）的 case 保留读旧备份。
    case 'damage': {
      const mode = META.damageMode(effect);   // 缺省推导：对战结果时点的裸 damage = 给输家（旧数据兼容）
      const others = () => alive(state).filter((x) => x.id !== self.id && !x.inSeclusion);
      if (mode === 'self') { applyDamage(state, self, effect.value || 1, 'card', self.id); break; }
      if (mode === 'all_others') {
        for (const t of others()) applyDamage(state, t, effect.value || 1, 'card', self.id, !!effect.ignore_companion);
        break;
      }
      if (mode === 'attacker') {
        const cc = ctx.combat || state.combat;
        const atk = cc ? p(state, cc.attacker) : null;
        if (atk && !atk.out) {
          log(state, 'info', `${self.name} 让发起对战的 ${atk.name} 受到 ${effect.value || 1} 点伤害。`);
          applyDamage(state, atk, effect.value || 1, 'card', self.id);
        }
        break;
      }
      if (mode === 'self_then_target') applyDamage(state, self, effect.selfDamage || 1, 'card', self.id);
      // ⭐「让对方（输家/赢家）额外受到 N 点伤害」——【绿煌剑】"在对战获胜时，让对方额外受到1点伤害"
      //    走【斗法】链发动时（结果窗口里付费启用），落点由**本场对战的 winnerId/loserId** 决定。
      //    ⚠️ 以前没有这条分支：`mode==='loser'` 时 `picked` 一直是空的 → 链里发动**什么都不做**
      //    （只有 runOnWinEffects 那条专用通道会打），于是【绿煌剑】一旦改成"时点窗口发动"就哑了。
      if (mode === 'loser' || mode === 'winner') {
        const cc = ctx.combat || state.combat;
        const tid = cc ? (mode === 'loser' ? cc.loserId : cc.winnerId) : null;
        const tp = tid ? p(state, tid) : null;
        if (tp && !tp.out) {
          log(state, 'info', `${self.name} 的效果使 ${tp.name} 额外受到 ${effect.value || 1} 点伤害。`);
          applyDamage(state, tp, effect.value || 1, 'card', self.id, !!effect.ignore_companion);
        } else {
          log(state, 'info', `本场对战还没有分出结果，【${(ctx.selfCardId && (cardDef(ctx.selfCardId) || {}).name) || '此宝'}】的效果没有落点。`);
        }
        break;
      }
      // ⭐ 点名打一个**闭关**的人：卡文明写"闭关期间不受任何卡牌效果影响" ——
      //    以前是静默什么都不发生（人被打名了却没有任何提示），这里明确说一句（交接 §5.2 的老欠账）。
      const wantT = ctx.target ? p(state, ctx.target) : null;
      if (wantT && wantT.inSeclusion && mode !== 'all' && mode !== 'loser' && mode !== 'attacker') {
        log(state, 'info', `${wantT.name} 正在闭关，不受卡牌效果影响，本次效果无效。`);
        break;
      }
      const cap = (mode === 'multi' || mode === 'self_then_target') ? (effect.max || 2) : 1;
      let picked = ((ctx.targets && ctx.targets.length) ? ctx.targets : (ctx.target ? [ctx.target] : []))
        .map((id) => p(state, id)).filter((x) => x && canBeAttacked(x)).slice(0, cap);
      if (!picked.length && mode !== 'loser') picked = others().slice(0, 1);   // 未指定时的兜底（与旧实现一致）
      for (const t of picked) {
        log(state, 'info', `${self.name} 指定 ${t.name} 受到伤害。`);
        applyDamage(state, t, effect.value || 1, 'card', self.id, !!effect.ignore_companion);
        // 「伤害 + 跳过下回合」（【禁神牌】）：闭关者"不受任何卡牌效果影响" → 跳过也不生效
        if (effect.skip && !t.out && !t.inSeclusion) {
          t.skip = (t.skip || 0) + effect.skip; t.skippedLastTurn = true;
          log(state, 'info', `${t.name} 将跳过接下来 ${effect.skip} 个回合。`);
        }
      }
      break;
    }
    // 封锁某类抽取（原 block_spell_draw / block_companion_draw / block_treasure_draw 三合一）
    case 'block_draw': {
      const dk = effect.deck || 'spell';
      const field = { spell: 'blockSpellDraw', companion: 'blockCompanionDraw', treasure: 'blockTreasureDraw' }[dk];
      const deckName = { spell: '法术牌', companion: '同行者', treasure: '宝物牌' }[dk];
      if (!field) break;
      const t = (target && !target.out) ? target : null;
      if (t) {
        t[field] = (t[field] || 0) + (effect.value || 1);
        log(state, 'info', `${t.name} 接下来 ${effect.value || 1} 个回合不能抽取【${deckName}】。`);
      } else {
        log(state, 'info', `没有可封锁的目标。`);
      }
      break;
    }
    case 'dice_bonus':
      // ⭐「骰子点数 +N（最高 6 点）」= 改**骰点**，不是改战力！
      //    骰点再查表转成附加战力（1 → +0；2~5 → +1；6 → +2），所以必须写进 `c.diceBonus`
      //    （`finalOf()` 里 `pip = clamp(原始骰点 + extraDice, 1, 6)`，封顶 6 也由它保证）。
      //    ⚠️ 以前这条和 `combat_bonus` 合并处理，直接加到 `c.bonus` —— 于是走**时点窗口**发动时
      //    （【蓝丝剑】【金蚨子母刃】"投骰子前使用，骰子点数+1/+2"）变成了"战力 +1/+2"，
      //    跟卡文不一样（战力 +N 是【乾蓝冰焰】那种写法）。2026-10-06 用户要求复核装备时点，一并修正。
      if (ctx.combat) {
        ctx.combat.diceBonus[self.id] = (ctx.combat.diceBonus[self.id] || 0) + (effect.value || 1);
        log(state, 'info', `${self.name} 的【${(ctx.selfCardId && (cardDef(ctx.selfCardId) || {}).name) || '此宝'}】`
          + `使本场对战骰子点数 +${effect.value || 1}（最高 6 点）。`, { player: self.id });
      }
      break;
    case 'combat_bonus':
      if (ctx.combat) ctx.combat.bonus[self.id] = (ctx.combat.bonus[self.id] || 0) + (effect.value || 1);
      break;
    case 'reroll_dice': {
      // 「可额外投掷 1 次骰子，取点数最大值」—— 重掷在 `resolveCombat()` 里统一做，
      // 它读的是**装备加成表**（`c.equipBonus[pl].rerollDice`）和同行者那份。
      // 所以时点窗口发动时要把次数记到那张表里（以前只有"开战启用"那条通道会记，
      // 走窗口发动的【七鬼珠】【青元剑诀】筑基档**永远不生效**）。
      if (ctx.combat) {
        const c = ctx.combat;
        const n = effect.value || 1;
        c.equipBonus = c.equipBonus || {};
        c.equipBonus[self.id] = c.equipBonus[self.id] || { bonus: 0, diceBonus: 0, rerollDice: 0 };
        c.equipBonus[self.id].rerollDice = (c.equipBonus[self.id].rerollDice || 0) + n;
        log(state, 'info', `${self.name} 本场对战可额外投掷 ${n} 次骰子（取点数最大值）。`, { player: self.id });
      }
      break;
    }
    case 'combat_debuff':
      if (ctx.combat) {
        const foe = ctx.combat.attacker === self.id ? ctx.combat.defender : ctx.combat.attacker;
        ctx.combat.debuff[foe] = (ctx.combat.debuff[foe] || 0) + (effect.value || 1);
        log(state, 'info', `${self.name} 削减了对手 ${effect.value || 1} 点战力。`);
      }
      break;
    case 'cancel_attack':
      if (ctx.combat) { ctx.combat.cancelled = true; log(state, 'info', `${self.name} 使本次对战作废。`); }
      break;
    case 'skip_turn': {
      // ⚠️ 闭关中"不受任何卡牌效果影响"（交接 §5.2 的老欠账）→ 跳过回合这类效果对它无效。
      const t = (target && !target.out && !target.inSeclusion) ? target : null;
      if (!t && target && target.inSeclusion) log(state, 'info', `${target.name} 正在闭关，不受卡牌效果影响，【跳过回合】无效。`);
      if (t) {
        if (t.skippedLastTurn) {
          log(state, 'info', `${t.name} 上个回合已被跳过，不可连续两回合无法行动，效果无效。`);
        } else {
          t.skip = (t.skip || 0) + 1;
          t.skippedLastTurn = true;
          log(state, 'info', `${t.name} 被禁制，下个回合无法行动。`);
        }
      }
      break;
    }
    // ===== 常驻数值类 op：**故意不在这里处理** =====
    // hand_limit_bonus / damage_reduction / mana_regen_bonus / promote_discount 都是 passive op，
    // 由 passives(pl) 汇总成 {op: 值}，再由各处按需取用：
    //   hand_limit_bonus    → enforceHandLimits()（手牌上限，【噬金虫】）
    //   damage_reduction    → applyDamage()（每次受伤减免）
    //   mana_regen_bonus    → manaRegen()（每回合额外回法力，【慕沛灵】【紫灵】【南宫婉】）
    //   promote_discount    → promoteDiscount() / promoteConsumeDiscount()（【玄骨】【辛如音】【六翼霜蜈】）
    // 这里以前各写了一个 `self.xxx = (self.xxx || 0) + N` 的分支，把值写进没人读的字段，
    // 看起来"实装了"其实是死代码 —— 已删除，别再往这里加。
    // ⚠️ 注意 passives() 是按 **op** 汇总、不看 `when` 的，所以这几条只能当常驻用；
    //    哪天真要做"一次性 +N"，得另开一个 op，不要复用这几个名字。
    case 'reroll': self.hasReroll = true; break;
    case 'look_hand':
      if (target) log(state, 'info', `${self.name} 查看了 ${target.name} 的手牌：${target.hand.map((c) => cardDef(c.id).name).join('、') || '（空）'}`);
      break;
    case 'steal_card': {
      // 闭关者"不受任何卡牌效果影响" → 夺手牌对它无效（交接 §5.2 的老欠账）
      if (target && target.inSeclusion) {
        log(state, 'info', `${target.name} 正在闭关，不受卡牌效果影响，无法夺取其手牌。`);
        break;
      }
      const t = target && !target.out ? target : null;
      if (t && t.hand.length) {
        const idx = Math.floor(nextRandom(state) * t.hand.length);
        const got = t.hand.splice(idx, 1)[0];
        self.hand.push(got);
        log(state, 'steal', `${self.name} 从 ${t.name} 手中抽走了 1 张手牌。`, { from: t.id, to: self.id });
      }
      break;
    }
    case 'damage_shield': self.shield += effect.value || 1; break;

    // ===== 以下为「按实物卡文」新增的效果类型（v6）=====
    // 让对方的骰点 -N（最低 1）——实物【寒冰珠】
    case 'dice_penalty':
      if (ctx.combat) {
        const foe = ctx.combat.attacker === self.id ? ctx.combat.defender : ctx.combat.attacker;
        ctx.combat.dicePenalty[foe] = (ctx.combat.dicePenalty[foe] || 0) + (effect.value || 1);
        log(state, 'info', `${self.name} 压制 ${(p(state, foe) || {}).name} 的骰点 -${effect.value || 1}。`);
      }
      break;
    // 本场对战失败时不受惩罚 —— 实物【踏云靴】【风雷翅】
    case 'lose_immunity':
      if (ctx.combat) { ctx.combat.noPenalty[self.id] = true; log(state, 'info', `${self.name} 本场对战失败也不受惩罚。`); }
      break;
    // 放弃掷骰，本场对战中自身战力固定为该值（不可被增减）—— 实物【金光砖符】【敛气术】
    case 'flat_power':
      if (ctx.combat) { ctx.combat.flatPower[self.id] = effect.value || 0; log(state, 'info', `${self.name} 本场对战战力固定为 ${effect.value} 点。`); }
      break;
    // 指定 1~2 名修士同时受伤 —— 实物【真风符】【撼地符】【凤凰符】
    case 'damage_multi': {
      const list = (ctx.targets && ctx.targets.length ? ctx.targets
        : (ctx.target ? [ctx.target] : []))
        .map((id) => p(state, id)).filter((x) => x && canBeAttacked(x)).slice(0, effect.max || 2);
      const picked = list.length ? list : alive(state).filter((x) => x.id !== self.id && !x.inSeclusion).slice(0, 1);
      for (const t of picked) {
        log(state, 'info', `${self.name} 指定 ${t.name} 受到伤害。`);
        applyDamage(state, t, effect.value || 1, 'card', self.id, !!effect.ignore_companion);
      }
      break;
    }
    // 让目标跳过 N 个回合 —— 实物【寒黎珠】【碧水青甲阵】
    case 'skip_turns': {
      // 同上：闭关者不受卡牌效果影响
      const t = (target && !target.out && !target.inSeclusion) ? target : null;
      const n = effect.value || 1;
      if (!t && target && target.inSeclusion) log(state, 'info', `${target.name} 正在闭关，不受卡牌效果影响，【跳过回合】无效。`);
      if (t) {
        if (t.skippedLastTurn && n <= 1) log(state, 'info', `${t.name} 上个回合已被跳过，不可连续两回合无法行动，效果无效。`);
        else { t.skip = (t.skip || 0) + n; t.skippedLastTurn = true; log(state, 'info', `${t.name} 将跳过接下来 ${n} 个回合。`); }
      }
      break;
    }
    // 从目标的储物袋里取走 1 张装备 —— 实物【花篮】【韩立】
    case 'steal_equip': {
      const t = target && !target.out ? target : null;
      const pool = t ? (t.equip.length ? t.equip : t.spells) : null;
      // 实物【花篮】= 取走对方【储物袋】中**所有**装备类宝物牌；【韩立】= 取走其中 1 张
      const all = effect.count === 'all';
      const want = all ? (pool ? pool.length : 0) : Math.max(1, effect.count || 1);
      if (t && pool && pool.length) {
        const names = [];
        const takenUids = [];
        for (let i = 0; i < want && pool.length; i++) {
          const inst = pool.shift();
          self.hand.push(inst);
          takenUids.push(inst.uid);
          names.push((cardDef(inst.id) || {}).name);
        }
        // ⭐ 被夺走的底牌带着它上面的"叠牌"（【青竹蜂云剑 辟邪神雷】）一起走 —— 否则会留下孤儿
        for (const u of takenUids) {
          for (let i = t.equip.length - 1; i >= 0; i--) {
            const at = t.equip[i];
            if (at.attachedTo != null && String(at.attachedTo) === String(u)) {
              t.equip.splice(i, 1);
              self.hand.push(at);
              names.push((cardDef(at.id) || {}).name);
            }
          }
        }
        log(state, 'steal', `${self.name} 从 ${t.name} 的储物袋取走了${all ? '全部' : ''}【${names.join('】【')}】。`, { from: t.id, to: self.id });
      } else {
        log(state, 'info', `${self.name} 想夺取装备，但对方储物袋是空的。`);
      }
      break;
    }
    // 首次放置此同行者时抽 N 张灵气牌 —— 实物【铁火蚁】【血玉蜘蛛】
    case 'place_draw_qi': {
      const got = drawFrom(state, 'qi', effect.value || 1);
      for (const g of got) gainQiCard(state, self, g);
      break;
    }
    // 按生命值条件给对战加成 —— 实物【六翼霜蚣】【蛮胡子】
    case 'combat_bonus_if_hp_le':
      if (ctx.combat && self.hp <= (effect.threshold || 3)) {
        ctx.combat.bonus[self.id] = (ctx.combat.bonus[self.id] || 0) + (effect.value || 1);
        log(state, 'info', `${self.name} 生命值 ≤${effect.threshold}，本场战力 +${effect.value}。`);
      }
      break;
    case 'combat_bonus_if_hp_ge':
      if (ctx.combat && self.hp >= (effect.threshold || 4)) {
        ctx.combat.bonus[self.id] = (ctx.combat.bonus[self.id] || 0) + (effect.value || 1);
        log(state, 'info', `${self.name} 生命值 ≥${effect.threshold}，本场战力 +${effect.value}。`);
      }
      break;
    // 对方境界高于你时战力 +N —— 实物【紫灵】
    case 'combat_bonus_if_enemy_higher_realm':
      if (ctx.combat) {
        const foeId = ctx.combat.attacker === self.id ? ctx.combat.defender : ctx.combat.attacker;
        const foe = p(state, foeId);
        if (foe && foe.realm > self.realm) {
          ctx.combat.bonus[self.id] = (ctx.combat.bonus[self.id] || 0) + (effect.value || 1);
          log(state, 'info', `${self.name} 以弱击强，本场战力 +${effect.value}。`);
        }
      }
      break;
    // 阻止对手在本场对战中使用某一类牌 —— 实物【阴魂丝】
    case 'block_enemy_card_kind':
      if (ctx.combat) {
        const foeId = ctx.combat.attacker === self.id ? ctx.combat.defender : ctx.combat.attacker;
        ctx.combat.blocked[foeId] = ctx.combat.blocked[foeId] || [];
        ctx.combat.blocked[foeId].push(effect.block || '消耗类宝物牌');
        log(state, 'info', `${self.name} 封锁了 ${(p(state, foeId) || {}).name} 本场使用【${effect.block}】。`);
      }
      break;
    // 混合抽牌：宝物 + 法术 各 N —— 实物【大挪移令】
    case 'draw_mixed': {
      for (const [dk, n] of [['treasure', effect.treasure || 0], ['spell', effect.spell || 0], ['companion', effect.companion || 0]]) {
        if (!n) continue;
        const got = drawFrom(state, dk, n);
        for (const g of got) { self.hand.push(mk(UID++, g)); log(state, 'draw', `${self.name} 抽到【${(cardDef(g) || {}).name}】。`, { player: self.id, card: g, deck: dk }); }
      }
      break;
    }
    // 探索改抽（替换型）—— 实物【青易居士】。阶段事务模型：收势时只**登记**，
    // 基础行动「抽 2 宝物」最后结算时读 phaseMods.exploreSwap 改抽「1 宝物 + 1 法术」。
    case 'explore_swap': {
      state.phaseMods = state.phaseMods || {};
      state.phaseMods.exploreSwap = true;
      log(state, 'info', `【青易居士】效果登记：本次探索改为抽取 1 张宝物牌与 1 张法术牌（探索的基础行动收势后结算）。`);
      break;
    }
    // 本次晋升折扣 —— 实物【娑罗珠】（减**消耗**）【九曲灵参】【九曲灵参丹】（减**门槛**）
    // 「门槛」= 灵根符上印的「需达到」；「消耗」= 晋升时真正扣掉的那几点。
    // 卡文用词不同，落到 `on` 上：
    //   on:'threshold'（默认）—— 「晋升时，**所需**的灵气值-1」
    //   on:'consume'          —— 「使本次晋升**消耗**的灵气值-1」
    // 支持：限定目标境界（onlyRealm）、与指定卡组合使用时有额外折扣（comboWith/comboValue）、
    //        用掉后额外抽灵气牌（alsoDrawQi）。
    case 'promote_discount_once':
      self.promoPending = self.promoPending || [];
      self.promoPending.push({
        name: cardDef(ctx && ctx.selfCardId) ? cardDef(ctx.selfCardId).name : '',
        value: effect.value || 1,
        onlyRealm: effect.onlyRealm || 0,
        comboWith: effect.comboWith || null,
        comboValue: effect.comboValue || 0,
        drawQi: effect.alsoDrawQi || 0,
        on: effect.on === 'consume' ? 'consume' : 'threshold',
      });
      log(state, 'info', `${self.name} 的晋升折扣已就绪（${effect.on === 'consume' ? '减少消耗' : '降低门槛'}，晋升${effect.onlyRealm ? REALMS[effect.onlyRealm] : '境界'}时可用）。`);
      // 「若将此宝物牌放入弃牌堆，则可抽 N 张灵气牌」——消耗卡打出即进弃牌堆，故此刻结算
      if (effect.alsoDrawQi) {
        const g = drawFrom(state, 'qi', effect.alsoDrawQi);
        for (const q of g) gainQiCard(state, self, q);
        log(state, 'info', `【${(cardDef(ctx && ctx.selfCardId) || {}).name || '该牌'}】进入弃牌堆，抽取 ${effect.alsoDrawQi} 张灵气牌。`);
      }
      break;
    // 生命值归零时自救 —— 实物【还阳术】
    case 'self_revive':
      self.reviveTo = Math.max(self.reviveTo || 0, effect.value || 1);
      log(state, 'info', `${self.name} 布下自救之法（生命归零时恢复到 ${effect.value} 点）。`);
      break;
    // 在自己的回合不发起对战，则回合结束时额外恢复法力 —— 实物【三目豹】
    case 'turn_no_combat_mana':
      self.noCombatMana = (self.noCombatMana || 0) + (effect.value || 1);
      break;

    // 「让傀儡替你挨这一下」—— 实物【傀儡蜥蜴】。**需要付费（2 点法力）→ 主动询问**。
    // 伤害已经落地了，所以这里是"事后补救"：把刚扣的血补回来 + 消耗 1 次替伤额度。
    case 'puppet_absorb': {
      const pup = (self.puppets && self.puppets[0]) || null;
      if (!pup || pup.left <= 0) {
        log(state, 'info', `${self.name} 的【傀儡】已不在场上或替伤次数用尽，无法替伤。`);
        break;
      }
      // 第 3 轮：受伤窗口前置 → 伤害还没落地，直接把待落地值清掉就是"替主人挨了这一下"。
      // （旧版是事后补救：先补回刚扣的血；致死一击之所以也要补回来，是因为 deferredDeath
      //   把判死推到了收势之后 —— 那条通道已随窗口前置一起删掉。）
      const pm = ctx && ctx.pending;
      const saved = pm ? (pm.value || 0) : ((ctx && ctx.lostHp) || 0);
      if (pm) { pm.value = 0; ctx.lostHp = 0; }
      pup.left -= 1;
      log(state, 'companion_hurt',
        `${self.name} 的傀儡【${pup.name}】替其挡下本次伤害（${saved} 点，剩余 ${pup.left} 次替伤）。`);
      if (pup.left <= 0) {
        log(state, 'companion_down', `傀儡【${pup.name}】替伤次数用尽，被放入弃牌堆。`);
        self.puppets.shift();
        if (pup.id) toDiscard(state, 'treasure', pup.id);
      }
      break;
    }

    // 「支付对战启用费，本场启用这件装备」—— 低境界装备（用户判据：需要付费的都要询问）
    case 'enable_equip_combat':
      if (ctx.combat) {
        ctx.combat.equipEnabled = ctx.combat.equipEnabled || {};
        ctx.combat.equipEnabled[self.id] = ctx.combat.equipEnabled[self.id] || {};
        ctx.combat.equipEnabled[self.id][ctx.uid] = true;
        log(state, 'info', `${self.name} 本场启用【${(meta && meta.def ? meta.def.name : '该装备')}】的对战效果。`);
      }
      break;

    // 「本回合不发起对战，可花 N 法力回 M 生命」—— 实物【墨彩环】
    // 用户定的判据：**消耗法力才能发动 = 主动询问**（不消耗 = 自动）。
    // 所以改由玩家在"回合结束"时点的询问窗口里发动，这里就是它的本体实现 ——
    // 早期是 endTurn 里自动扣钱回血（不问玩家），属于同一类偏差。
    case 'turn_no_combat_heal': {
      // 发动费由 resolvePending 统一扣（见那里的 fee），这里只负责"能不能做 + 做"。
      const heal = effect.heal || effect.value || 1;
      const who = (meta && meta.def ? meta.def.name : '该同行者');
      if (state.turnFlags && state.turnFlags.combat) {
        log(state, 'info', `${self.name} 本回合已发起过对战，【${who}】不能发动。`);
        break;
      }
      if (self.hp >= HP_MAX) { log(state, 'info', `${self.name} 生命值已满，【${who}】无需发动。`); break; }
      const before = self.hp;
      self.hp = Math.min(HP_MAX, self.hp + heal);
      log(state, 'heal', `${self.name} 本回合未发起对战，【${who}】发动：恢复 ${self.hp - before} 点生命值（${self.hp}/${HP_MAX}）。`,
        { player: self.id, hp: self.hp });
      break;
    }

    // ===== v6 第二批：按用户修正后的实物卡文补齐 =====
    // 对战失败时掷骰，点数为指定面则免罚 —— 实物【风雷翅】
    case 'lose_save_dice':
      if (ctx.combat) {
        ctx.combat.loseSave[self.id] = { faces: effect.faces || [], rolled: 0, ok: false, mana: effect.mana || 0 };
        log(state, 'info', `${self.name} 布下保命之法（失败时掷出 ${(effect.faces || []).join('/')} 可免罚`
          + `${effect.mana ? `，并恢复 ${effect.mana} 点法力值` : ''}）。`);
      }
      break;
    // 对战失败时让对方也受伤 —— 实物【透明丝线】
    case 'lose_retaliate':
      if (ctx.combat) ctx.combat.loseRetaliate[self.id] = (ctx.combat.loseRetaliate[self.id] || 0) + (effect.value || 1);
      break;
    // 受到伤害时掷骰，4/5 抵消、6 抵消并反弹等额 —— 实物【遮天钟】
    case 'damage_save_dice': {
      // ① 在「受伤」窗口里响应打出 —— 【遮天钟】卡文「当你受到任意伤害时」。
      //    第 3 轮：伤害还没落地 → 直接把待落地的伤害清掉；掷出反弹面时把**等额**伤害弹回来源。
      const rc = ctx.reaction;
      if (rc && rc.event === 'hurt') {
        const roll = d6(state);
        const faces = effect.faces || [4, 5];
        const reflectFace = effect.reflect || 6;
        const pm = ctx.pending;
        const lost = pm ? (pm.value || 0) : (ctx.lostHp || 0);
        log(state, 'roll', `${self.name} 的【遮天钟】生效：掷出 ${roll} 点（${faces.join('/')} 抵消，${reflectFace} 反弹）。`,
          { player: self.id, value: roll, scope: 'damage_save' });
        if (roll === reflectFace || faces.indexOf(roll) >= 0) {
          if (pm) { pm.value = 0; ctx.lostHp = 0; }
          if (lost > 0) {
            log(state, 'info', `${self.name} 抵消了本次伤害（${lost} 点）。`);
          }
          if (roll === reflectFace && lost > 0 && ctx.source) {
            const src = p(state, ctx.source);
            if (src && !src.out && src.id !== self.id) {
              log(state, 'info', `${self.name} 的【遮天钟】把伤害原样弹回给 ${src.name}。`);
              applyDamage(state, src, lost, 'reflect', self.id, { skipInterrupt: true });
            }
          }
        } else {
          log(state, 'info', `${self.name} 的【遮天钟】掷出 ${roll} 点，未能抵消。`);
        }
        break;
      }
      // ② 平时打出（卡文写「在任意回合使用」）→ 预先挂一次护身之法
      self.damageSave = { faces: effect.faces || [4, 5], reflect: effect.reflect || 6 };
      log(state, 'info', `${self.name} 布下护身之法（受伤时掷出 ${(effect.faces || []).join('/')} 抵消，${effect.reflect || 6} 反弹）。`);
      break;
    }
    // 自伤后指定一至两人受伤 —— 实物【真凰符】
    case 'self_damage_then_multi': {
      applyDamage(state, self, effect.selfDamage || 1, 'card', self.id);
      const list = (ctx.targets || (ctx.target ? [ctx.target] : []))
        .map((id) => p(state, id)).filter((x) => x && canBeAttacked(x)).slice(0, effect.max || 2);
      const picked = list.length ? list : alive(state).filter((x) => x.id !== self.id && !x.inSeclusion).slice(0, 1);
      for (const t of picked) { log(state, 'info', `${self.name} 指定 ${t.name} 受到伤害。`); applyDamage(state, t, effect.value || 1, 'card', self.id); }
      break;
    }
    // 只能指定境界高于自己的修士受伤 —— 实物【红线遁光针】
    case 'damage_higher_realm': {
      const t = target && canBeAttacked(target) && target.realm > self.realm ? target : null;
      if (t) { log(state, 'info', `${self.name} 指定境界更高的 ${t.name} 受到伤害。`); applyDamage(state, t, effect.value || 1, 'card', self.id); }
      else log(state, 'info', `【红线遁光针】只能指定境界高于你的修士，本次无合法目标。`);
      break;
    }
    // 伤害 + 跳过回合 —— 实物【禁神牌】
    case 'damage_and_skip': {
      const t = target && canBeAttacked(target) ? target : null;
      if (t) {
        applyDamage(state, t, effect.damage || 1, 'card', self.id);
        if (!t.out) { t.skip = (t.skip || 0) + (effect.skip || 1); t.skippedLastTurn = true; log(state, 'info', `${t.name} 将跳过下个回合。`); }
      }
      break;
    }
    // 进入「伪丹期」：战力临时等同更高境界，若干回合后回落 —— 实物【血凝五行丹】
    case 'pseudo_realm':
      self.pseudoRealm = { realm: effect.realm || 3, turns: effect.turns || 2, penalty: effect.penalty || 1 };
      log(state, 'promote', `${self.name} 服下丹药，进入伪丹期（战力视为 ${REALMS[effect.realm || 3]}），持续 ${effect.turns || 2} 回合。`, { player: self.id });
      break;
    // 「使用任意【消耗类法宝】后，投骰点数 6 则指定一名修士受 1 点伤害」—— 实物【玄阴诀】
    // 玄阴诀是**装备类法术**（挂在法术区），这条是常驻钩子；真正的钩子点见 fireAfterConsumeRoll6()。
    // 这里不再往玩家身上写标志位 —— 那是"只写不读"的死字段，改成从场上实时读（玄阴诀离场即失效）。
    case 'after_consume_roll6':
      log(state, 'info', `【${(meta && meta.def ? meta.def.name : '玄阴诀')}】已挂起：此后每次使用【消耗类法宝】都会掷骰，点数 6 则指定一名修士受到伤害。`);
      break;
    // ⭐ 通用「掷骰分支」（用户 2026-10-05 蓝图式编辑要的通用节点）：
    //   branches: [{faces:[5,6], effects:[…]}, …]，else: [ … ] 兜底。
    //   子效果里的 `"$face"` = 本次点数、`"$lostHp"` = 本次受伤扣的血（受伤窗口用）。
    case 'roll_branch': {
      const face = d6(state);
      const branches = Array.isArray(effect.branches) ? effect.branches : [];
      const hitB = branches.find((b) => Array.isArray(b && b.faces) && b.faces.indexOf(face) >= 0);
      const list = hitB ? (hitB.effects || []) : (Array.isArray(effect.else) ? effect.else : []);
      const mark = hitB ? ((hitB.faces || []).join('/')) : '未命中';
      log(state, 'roll', `${self.name} 掷出 ${face} 点（${mark}）。`, { player: self.id, value: face, scope: 'roll_branch' });
      if (!list.length) {
        log(state, 'info', `【${(meta && meta.def ? meta.def.name : '掷骰判定')}】在 ${face} 点上没有对应结果。`);
        break;
      }
      for (const sub of list) {
        // 占位符替换（"$face" → 本次点数、"$lostHp" → 本次受伤量）—— 目标沿用外层 ctx.target
        resolveEffect(state, self, fillPlaceholders(sub, { face: face, lostHp: (ctx && ctx.lostHp) || 0 }), ctx, meta);
      }
      break;
    }
    // ⭐「使本次伤害无效 / 翻倍」—— **受伤是时点**（用户 2026-10-05 裁定：
    //   「受伤也是时点，时点响应，那么原效果最后生效」）。
    //   第 3 轮把受伤窗口**前置**之后，这两个效果是字面意义上的"改这笔伤害"：
    //   伤害还没落地，就躺在 `ctx.pending.value` 里 —— 直接改它，收势后照新值落地。
    //   （旧版是"事后补救"：伤害已经扣完，再补血/再扣一份 —— 同一套语义的两种实现。）
    //     · damage_cancel  ：本次伤害无效（待落地值 → 0）
    //     · damage_multiply：本次伤害 ×N（基数＝待落地的伤害值，之后才轮到减免之类）
    case 'damage_cancel': {
      const who = (meta && meta.def ? meta.def.name : '护身之物');
      const pm = ctx && ctx.pending;
      if (pm) {
        const before = pm.value || 0;
        pm.value = 0;
        ctx.lostHp = 0;
        log(state, 'info', `${self.name} 的【${who}】使本次伤害无效（${before} 点伤害被抵消）。`);
      } else {
        // 兜底（正常走不到：「受伤」时点一定有待落地的伤害）
        const lost = (ctx && ctx.lostHp) || 0;
        if (lost > 0) {
          const before = self.hp;
          self.hp = Math.min(HP_MAX, self.hp + lost);
          log(state, 'heal', `${self.name} 的【${who}】使本次伤害无效，生命值 ${before} → ${self.hp}。`,
            { player: self.id, hp: self.hp });
        }
      }
      break;
    }
    case 'damage_multiply': {
      const mul = Math.max(1, Number(effect.value) || 2);
      const who = (meta && meta.def ? meta.def.name : '护身之物');
      const pm = ctx && ctx.pending;
      if (pm) {
        const base = pm.value || 0;
        pm.value = base * mul;
        ctx.lostHp = pm.value;
        // 翻倍把人打到 0 → 让**后面才结算的**响应看到 lethal（【还阳术】的 if.lethal）
        if (self.hp - pm.value <= 0) ctx.lethal = true;
        log(state, 'damage', `${self.name} 的【${who}】使本次伤害 ×${mul}：${base} → ${pm.value} 点。`,
          { player: self.id, value: pm.value, hp: self.hp });
      } else {
        // 兜底（正常走不到）：没有待落地的伤害 → 当作一次新的伤害落地（走同一个收尾通道）
        const base = (ctx && typeof ctx.damage === 'number') ? ctx.damage : ((ctx && ctx.lostHp) || 0);
        const extra = Math.max(0, base * (mul - 1));
        if (extra > 0) {
          log(state, 'damage', `${self.name} 的【${who}】使本次伤害 ×${mul}：${base} → ${base * mul} 点。`,
            { player: self.id, value: base * mul, hp: self.hp });
          applyDamage(state, self, extra, 'card', (ctx && ctx.source) || null, { skipInterrupt: true });
        }
      }
      break;
    }
    // ⭐⭐ 实物卡补充批（2026-10-05 第 8 件）：19 张实物卡的引擎机制，一张一条。
    //  —— 与指定修士交换所有手牌 —— 实物【换形诀】
    case 'swap_hand': {
      const t = (target && !target.out && target.id !== self.id) ? target : null;
      if (!t) { log(state, 'info', `${self.name} 施展【换形诀】，但没有找到可交换手牌的目标。`); break; }
      const n0 = self.hand.length, n1 = t.hand.length;
      const tmp = self.hand;
      self.hand = t.hand;
      t.hand = tmp;
      log(state, 'info', `${self.name} 与 ${t.name} 交换了全部手牌（${n0} 张 ↔ ${n1} 张）。`, { from: t.id, to: self.id });
      break;
    }
    // —— 把对方放置的 1 张【同行者】移除并加入自己手牌 —— 实物【引魂钟】
    case 'steal_companion': {
      const t = target && !target.out ? target : null;
      const pool = (t && t.companions) || [];
      if (t && pool.length) {
        const inst = pool[0];
        loseCompanion(state, t, inst);        // 离场即重算手牌上限（【噬金虫】）
        self.hand.push(inst);
        log(state, 'steal', `${self.name} 摇动【引魂钟】，把 ${t.name} 场上的同行者【${(cardDef(inst.id) || {}).name}】收入自己手牌。`,
          { from: t.id, to: self.id });
      } else {
        log(state, 'info', `${self.name} 摇动【引魂钟】，但对方场上没有可夺取的同行者。`);
      }
      break;
    }
    // —— 本回合出牌不消耗法力值，但每张自身受 N 点伤害 —— 实物【七鬼噬魂术】
    //    扣费与自伤都在 doPlay 里（这里只登记），因为"打出那张牌"才是时点。
    case 'free_card_this_turn':
      self.freeCardThisTurn = true;
      self.freeCardSelfDamage = effect.value || 1;
      log(state, 'info', `${self.name} 修习【七鬼噬魂术】：本回合每使用 1 张【宝物牌】/【法术牌】都不消耗法力值，但自身受到 ${self.freeCardSelfDamage} 点伤害。`);
      break;
    // —— 本次对战结果直接视为获胜 —— 实物【大庚剑阵】（外面套 roll_branch：掷出 6 才走到这里）
    case 'force_win':
      if (ctx.combat) {
        ctx.combat.forcedWin = self.id;
        log(state, 'info', `${self.name} 的【大庚剑阵】剑气冲天：本次对战结果直接视为获胜！`);
      } else {
        log(state, 'info', `【大庚剑阵】只能在对战中使用。`);
      }
      break;
    // —— 受伤时让伤害来源受等额伤害，之后自身离场 —— 实物【刘靖】
    //    ⚠️ 受伤窗口已**前置**（第 3 轮）：这时伤害还没落地，"等额"取 `ctx.pending.value`。
    //    反伤本身用 skipInterrupt（与【遮天钟】的反弹同一套：不在链里再开一个受伤窗）。
    case 'hurt_reflect': {
      const who = effect.who || 'source';
      const foeId = who === 'source' ? (ctx && ctx.source) : (ctx && ctx.target);
      const foeP = foeId ? p(state, foeId) : null;
      const amt = (ctx && ctx.pending ? (ctx.pending.value || 0) : 0) || (ctx && ctx.lostHp) || 0;
      const cname = (meta && meta.def ? meta.def.name : '反伤');
      if (foeP && !foeP.out && foeP.id !== self.id && amt > 0) {
        log(state, 'info', `${self.name} 的【${cname}】发动：${foeP.name} 受到等额伤害（${amt} 点）。`);
        applyDamage(state, foeP, amt, 'reflect', self.id, { skipInterrupt: true });
      } else {
        log(state, 'info', `${self.name} 的【${cname}】没有可反伤的目标。`);
      }
      // 卡文"之后此【同行者】放入【弃牌堆】"—— 除非数据显式写了 discardSelf:false
      if (effect.discardSelf !== false && meta && meta.inst && meta.def) {
        loseCompanion(state, self, meta.inst);
        const dk = deckOf(meta.inst.id);
        if (dk) toDiscard(state, dk, meta.inst.id);
        log(state, 'companion_down', `同行者【${meta.def.name}】用尽自身之力，被放入弃牌堆。`);
      }
      break;
    }
    // —— 到自己的下回合开始前，无法被指定为对战目标 —— 实物【隐灵纱】【神风舟】
    case 'cannot_be_targeted':
      self.noTarget = true;
      log(state, 'info', `${self.name} 隐去行迹：在下个自己的回合开始之前，无法被指定为对战目标。`);
      break;
    // —— 下回合内除自己以外的所有修士不能抽灵气牌 —— 实物【拘灵阵】
    //    与 block_draw 的区别：它是**封所有人**、且封的是"灵气"这一种点（含卡牌效果抽取）。
    case 'block_qi_draw': {
      const n = effect.value || 1;
      const hit = [];
      for (const x of state.players) {
        if (x.id === self.id || x.out) continue;
        x.blockQiDraw = (x.blockQiDraw || 0) + n;
        hit.push(x.name);
      }
      log(state, 'info', `${self.name} 布下【拘灵阵】：${hit.join('、')} 下回合内无法抽取【灵气牌】（卡牌效果抽灵气同样被禁）。`);
      break;
    }
    // —— 下回合探索阶段额外抽 1 张宝物牌 —— 实物【神风舟】
    case 'explore_extra_treasure':
      self.nextExploreTreasure = (self.nextExploreTreasure || 0) + (effect.value || 1);
      log(state, 'info', `${self.name} 御风而行：下回合的探索阶段将额外抽取 ${effect.value || 1} 张【宝物牌】。`);
      break;
    // —— 跳过本回合所有行动，改为只抽 1 张灵气牌 —— 实物【神风舟】
    //    真正"结束本回合"在 doPlay 收尾处做（self.voidTurn），因为这里还在出牌流程中间。
    case 'void_turn_qi': {
      const got = drawFrom(state, 'qi', 1);
      for (const g of got) gainQiCard(state, self, g);
      self.voidTurn = true;
      log(state, 'info', `${self.name} 乘【神风舟】疾行：本回合跳过所有行动，只抽取 1 张【灵气牌】。`);
      break;
    }
    // —— 放置傀儡后，除自己以外的所有修士各掷 1 次骰：≤5 判定者受伤、≥5 放置者受伤 —— 实物【傀儡弓手】
    //    用户 2026-10-05 裁定：按卡面照实装 —— 5 点两边都吃伤。仅 1 回合，回合结束进弃牌堆。
    case 'puppet_judge_damage': {
      const cdef = cardDef(ctx && ctx.selfCardId);
      const inst = (ctx && ctx.selfInst) || null;
      self.puppets = self.puppets || [];
      self.puppets.push({
        uid: inst ? inst.uid : null,
        id: cdef ? cdef.id : null,
        name: cdef ? cdef.name : '傀儡弓手',
        left: 0, manaCost: 0, judge: true, discardAtTurnEnd: true,
      });
      log(state, 'play', `${self.name} 放出【${cdef ? cdef.name : '傀儡弓手'}】（不占储物袋，仅存 1 回合）。`, { player: self.id, puppet: true });
      const foes = state.players.filter((x) => x.id !== self.id && !x.out);
      for (const x of foes) {
        const roll = d6(state);
        log(state, 'roll', `${x.name} 判定掷出 ${roll} 点（≤5 判定者受伤，≥5 放出者受伤）。`,
          { player: x.id, value: roll, scope: 'puppet_judge' });
        if (roll <= 5) applyDamage(state, x, 1, 'card', self.id);
        if (roll >= 5) applyDamage(state, self, 1, 'card', x.id);
      }
      break;
    }
    // —— 使场上任意 1 张【宝物牌】/【法术牌】无效，之后抽 1 张灵气牌并自身离场 —— 实物【金魁】
    //    目标是一张**场上的牌**（`targetUid`），被无效的牌保留在场上但效果全停（见 effectsOf）。
    case 'nullify_board_card': {
      const who = (meta && meta.def ? meta.def.name : '该效果');
      const hitT = targetInst;
      if (!hitT || !hitT.inst) {
        log(state, 'info', `${self.name} 的【${who}】没有可指定的目标（场上没有宝物牌/法术牌）。`);
        break;
      }
      const d = cardDef(hitT.inst.id) || {};
      if (hitT.inst.nullified) {
        log(state, 'info', `【${d.name}】已经被无效过了。`);
        break;
      }
      hitT.inst.nullified = true;
      log(state, 'info',
        `${self.name} 的【${who}】使 ${hitT.owner.name} 场上的【${d.name}】失效（卡留在场上，但效果全部无效）。`,
        { player: hitT.owner.id, card: hitT.inst.id });
      break;
    }
    // —— 指定任意一位修士受伤（等额） —— 与【刘靖】共用 hurt_reflect，见那边
    // 指定生命值最低者，下回合不能抽宝物牌也不能发起对战 —— 实物【血咒禁制】
    // 复用已有的封锁计数（与【寒蛟】同一套：写入 → 被封锁方回合内生效 → 该回合结束时递减）。
    // 早期版本只写 `t.curse` 这个没人读的对象，等于这张牌完全没实装。
    case 'curse_target': {
      const cands = alive(state).filter((x) => x.id !== self.id && !x.inSeclusion);
      cands.sort((a, b) => a.hp - b.hp);
      const t = target && canBeAttacked(target) ? target : cands[0];
      if (t) {
        t.curse = { turns: 1, blockTreasure: !!(effect.blockTreasureDraw), blockCombat: !!(effect.blockCombat) };
        if (effect.blockTreasureDraw) t.blockTreasureDraw = (t.blockTreasureDraw || 0) + 1;
        if (effect.blockCombat) t.blockCombat = (t.blockCombat || 0) + 1;
        const parts = [];
        if (effect.blockTreasureDraw) parts.push('无法抽取【宝物牌】');
        if (effect.blockCombat) parts.push('无法发起对战');
        log(state, 'info', `${t.name} 被【血咒禁制】所困：下回合${parts.join('，')}。`, { player: t.id });
      }
      break;
    }
    // 「提升 1 次境界，抽取 1 张灵气牌（若装备此法术牌时已超过凡人境界，则补抽 1 张灵气牌）」
    // —— 实物【长春功】（装备类法术，装备即结算）
    // 卡文括号的含义：只有**凡人**能靠它直接升到炼气；已经超过凡人的，境界不再提升，改为补抽 1 张。
    // 旧版只往 promoteDrawQi / promoteDrawQiExtra 两个没人读的字段里写，等于整张牌没实装。
    case 'on_promote_draw_qi': {
      const aboveMortal = self.realm > 0;
      let qiDraw = effect.value || 1;
      if (!aboveMortal) {
        const before = self.realm;
        self.realm = before + 1;
        log(state, 'promote',
          `${self.name} 修习【长春功】，境界提升至【${REALMS[self.realm]}】！基础战力值提升至 ${baseCombat(self)} 点。`,
          { player: self.id, realm: self.realm, realmName: REALMS[self.realm] });
      } else {
        qiDraw += (effect.extraIfAboveMortal || 0);
        log(state, 'info', `${self.name} 已超过凡人境界，【长春功】不再提升境界，改为补抽 1 张灵气牌。`);
      }
      const got = drawFrom(state, 'qi', qiDraw);
      for (const g of got) gainQiCard(state, self, g);
      log(state, 'draw', `${self.name} 的【长春功】效果：抽取 ${got.length} 张灵气牌。`, { player: self.id });
      break;
    }
    // 强制对方重掷骰子并接受第二次结果 —— 实物【颠倒五行阵】
    case 'force_reroll_foe':
      if (ctx.combat) {
        const foe = ctx.combat.attacker === self.id ? ctx.combat.defender : ctx.combat.attacker;
        ctx.combat.forceReroll = ctx.combat.forceReroll || {};
        ctx.combat.forceReroll[foe] = true;
        log(state, 'info', `${self.name} 扰乱天机，强制 ${(p(state, foe) || {}).name} 重掷骰子并接受新结果。`);
      }
      break;
    // 放弃掷骰，战力改为「基础 + N」—— 实物【金光砖符】
    case 'dice_skip_bonus':
      if (ctx.combat) { ctx.combat.skipDice[self.id] = true; ctx.combat.bonus[self.id] = (ctx.combat.bonus[self.id] || 0) + (effect.value || 0); }
      break;
    // 天雷子：对手境界低则获胜后追加伤害；对手境界高则本场骰点 +N
    case 'versus_realm_effect':
      if (ctx.combat) {
        const foeId = ctx.combat.attacker === self.id ? ctx.combat.defender : ctx.combat.attacker;
        const foe = p(state, foeId);
        if (foe) {
          if (foe.realm <= (effect.lowRealm || 2) && effect.onWinDamage) {
            ctx.combat.winBonusDamage[self.id] = (ctx.combat.winBonusDamage[self.id] || 0) + effect.onWinDamage;
          }
          if (foe.realm >= (effect.highRealm || 3) && effect.diceBonus) {
            ctx.combat.diceBonus[self.id] = (ctx.combat.diceBonus[self.id] || 0) + effect.diceBonus;
          }
        }
      }
      break;
    // 朱雀环：对战中战力 +N，且获胜后回 M 点法力
    case 'combat_bonus_win_mana':
      if (ctx.combat) {
        ctx.combat.bonus[self.id] = (ctx.combat.bonus[self.id] || 0) + (effect.value || 0);
        if (effect.winMana) ctx.combat.winMana[self.id] = (ctx.combat.winMana[self.id] || 0) + effect.winMana;
      }
      break;
    // 风云幡：在对战获胜时使用，抽 N 张灵气牌
    case 'win_draw_qi':
      if (ctx.combat) ctx.combat.winDrawQi[self.id] = (ctx.combat.winDrawQi[self.id] || 0) + (effect.value || 1);
      break;
    // 「获胜则对方额外受 N 点伤害；失败则自己额外受 M 点伤害」—— 实物【青火雷】
    case 'risky_win_damage':
      if (ctx.combat) {
        ctx.combat.winBonusDamage[self.id] = (ctx.combat.winBonusDamage[self.id] || 0) + (effect.winDamage || 0);
        ctx.combat.selfLoseDamage[self.id] = (ctx.combat.selfLoseDamage[self.id] || 0) + (effect.loseDamage || 0);
        log(state, 'info', `${self.name} 押上风险：本场获胜则对方额外受 ${effect.winDamage || 0} 点伤害，失败则自己额外受 ${effect.loseDamage || 0} 点伤害。`);
      }
      break;
    // 「让一位发起对战的修士受到 N 点伤害」—— 实物【风灵劲】
    case 'damage_attacker': {
      const cc = ctx.combat || state.combat;
      if (!cc) { log(state, 'info', `${self.name} 打出【风灵劲】，但当前没有正在进行的对战，效果落空。`); break; }
      const atk = p(state, cc.attacker);
      if (atk && !atk.out) {
        log(state, 'info', `${self.name} 让发起对战的 ${atk.name} 受到 ${effect.value || 1} 点伤害。`);
        applyDamage(state, atk, effect.value || 1, 'card', self.id);
      }
      break;
    }
    // 虚天鼎/铜钱/雷火锥：使对方打出的那张牌无效
    case 'nullify_enemy_card': {
      const byName = (meta && meta.def) ? meta.def.name : '此宝';
      // ① 「对方出牌时」——**在对战里**出牌走的是【斗法】链，所以这次无效是"否决链上的那一环"：
      //    `resolveChainFrom` 看到 `nullifiedLinks[uid]` 就跳过它的效果（牌已经打出去了，只是白打）。
      //    时点来自 `resolveChainFrom` 给每一环手牌开的那个 `useCard · 前` 窗口（ctx.reaction.linkUid）。
      if (ctx.reaction && ctx.reaction.linkUid != null) {
        state.nullifiedLinks = state.nullifiedLinks || {};
        state.nullifiedLinks[ctx.reaction.linkUid] = true;
        if (ctx && ctx.combat) ctx.combat.nullified = (ctx.combat.nullified || 0) + 1;
        log(state, 'info', `${self.name} 使出【${byName}】，` +
          `${ctx.reaction.cardName ? '【' + ctx.reaction.cardName + '】' : '对方打出的那张牌'}被无效！`);
        break;
      }
      // ② 出牌路径（doPlay 的「卡牌使用 · 前」）：把对方**正在打出的那张牌**直接无效掉
      //   （中断层会看 state.nullifiedPlay，取消那次出牌，见 finishPending）
      if (ctx.reaction && ctx.reaction.event === 'useCard' && ctx.reaction.cardUid) {
        state.nullifiedPlay = {
          uid: ctx.reaction.cardUid,
          linkUid: null,                      // 出牌路径 —— finishPending 靠这个分清"这次要取消出牌"
          playerId: ctx.reaction.playerId || null,
          by: self.id,
          byName: self.name,
          byCardName: byName,
          cardName: ctx.reaction.cardName || '那张牌',
        };
        log(state, 'info', `${self.name} 使出【${byName}】，【${ctx.reaction.cardName || '对方打出的牌'}】被直接无效！`);
        break;
      }
      if (ctx.combat) {
        const foeId = ctx.combat.attacker === self.id ? ctx.combat.defender : ctx.combat.attacker;
        ctx.combat.blocked[foeId] = ctx.combat.blocked[foeId] || [];
        ctx.combat.blocked[foeId].push(effect.block || '法术牌/宝物牌');
        log(state, 'info', `${self.name} 使出【${byName}】，${(p(state, foeId) || {}).name} 本场的【${effect.block || '法术牌/宝物牌'}】将失效。`);
      }
      break;
    }
    // 火弹术：从对方手中抽 N 张牌
    case 'steal_hand_multi': {
      const t = target && !target.out ? target : alive(state).find((x) => x.id !== self.id && !x.inSeclusion);
      if (t) {
        let got = 0;
        for (let i = 0; i < (effect.value || 1) && t.hand.length; i++) {
          const idx = Math.floor(nextRandom(state) * t.hand.length);
          self.hand.push(t.hand.splice(idx, 1)[0]);
          got++;
        }
        if (got) log(state, 'steal', `${self.name} 从 ${t.name} 手中抽取了 ${got} 张牌。`, { from: t.id, to: self.id });
      }
      break;
    }
    // 火弹术：对战胜利时二选一（抽对方2张宝物牌 / 让对方额外受1点伤害）
    case 'win_steal_treasure':
      if (ctx.combat) ctx.combat.winStealTreasure[self.id] = (ctx.combat.winStealTreasure[self.id] || 0) + (effect.value || 1);
      break;
    case 'win_extra_damage':
      if (ctx.combat) ctx.combat.winBonusDamage[self.id] = (ctx.combat.winBonusDamage[self.id] || 0) + (effect.value || 1);
      break;
    // 傀儡形法器：有独立的「傀儡位」，不占储物袋/法术区/同行者 —— 实物【傀儡蜥蜴】
    case 'summon_puppet': {
      const cdef = cardDef(ctx && ctx.selfCardId);
      const inst = (ctx && ctx.selfInst) || null;
      self.puppets = self.puppets || [];
      // 已经在场上的那张（重复结算时不要叠出第二个位）
      const exist = self.puppets.find((x) => inst && Number(x.uid) === Number(inst.uid));
      if (exist) {
        exist.left = effect.absorbs || 2;
        exist.manaCost = effect.manaCost || 2;
        break;
      }
      self.puppets.push({
        uid: inst ? inst.uid : null,
        id: cdef ? cdef.id : null,
        name: cdef ? cdef.name : '傀儡',
        left: effect.absorbs || 2,
        manaCost: effect.manaCost || 2,
      });
      const p0 = self.puppets[self.puppets.length - 1];
      log(state, 'play', `${self.name} 放出【${p0.name}】，可替其承受 ${p0.left} 次伤害（每次消耗 ${p0.manaCost} 点法力值）；占用独立的【傀儡位】，不占储物袋格子。`, { player: self.id, puppet: true });
      break;
    }
    default: break;
  }
}

// ---------------------------------------------------------------- 动作校验

/** 手牌定位：DOM 的 dataset.uid 恒为字符串，客户端可能发字符串 uid，这里统一归一化比较。 */
function handIndexOf(pl, uid) {
  const n = typeof uid === 'string' && uid !== '' && !isNaN(Number(uid)) ? Number(uid) : uid;
  return pl.hand.findIndex((x) => x.uid === n || String(x.uid) === String(uid));
}

/**
 * 适用境界校验。返回 null 表示放行。
 * 三个分支（自己回合 / 对战准备 / 平局）都必须过这道闸 —— 早期只有"自己回合"分支校验，
 * 导致凡人能在别人的对战阶段装备元婴期法宝（前端 subagent 实测发现）。
 */
function realmGate(pl, def) {
  // 【李化元】：他带来的那张【青元剑诀】无视境界条件
  if (pl.ignoreRealmIds && pl.ignoreRealmIds.indexOf(def.id) >= 0) return null;
  if (pl.realm >= (def.realm || 0)) return null;
  if (def.type === 'companion') return null;   // 同行者没有境界限制，只有占位限制
  if (def.type === 'equip') return { ok: false, error: `${def.name} 需要 ${REALMS[def.realm]} 才能装备` };
  return { overreach: true };                  // 消耗类可越级使用，额外多付 1 点法力
}

function playable(state, pl, inst, action) {
  const def = cardDef(inst.id);
  if (!def) return { ok: false, error: '未知卡牌' };
  const a = action || {};
  // 傀儡位只有 1 个：场上的傀儡还没用完次数时不能再放一个（【傀儡蜥蜴】有自己的显示位）
  if (def.equipSlot === 'puppet' && (pl.puppets || []).length > 0) {
    const p0 = pl.puppets[0];
    return { ok: false, error: `傀儡位已被【${p0.name}】占用（还剩 ${p0.left} 次替伤），用完进弃牌堆后才会空出来` };
  }
  // 多档位卡（【青元剑诀】三档 / 【火弹术】二选一）要按**这次实际会用到的档**判断能不能打，
  // 否则永远拿第 1 档的时机去比对（第 1 档是"投骰前"，第 2 档却是"投骰后"）。
  // 用户裁定后：境界档自动适配当前境界，同境界多选才看请求里勾的那一项。
  const tierInst = (def.tiers && def.tiers.length)
    ? { tier: resolveTier(def, pl.realm, a.tier) } : inst;
  const plays = playNowEffects(def, tierInst);
  // 「指定一位修士」类牌必须先给目标，否则效果会落空（牌却已经被消耗）。
  // 参数化合族后按**效果**判（damage 的 target 参数），不再只按 op 名 —— META.effectNeedsTarget。
  for (const e of plays) {
    if (META.effectNeedsTarget(e) && !a.target && !(a.targets && a.targets.length)) {
      return { ok: false, error: `【${def.name}】需要先指定一位目标修士` };
    }
    // 卡文写「在任意回合使用」但效果依赖对战的牌（如【风灵劲】），没对战时不该被无意义地打掉。
    // 装备例外：装备本身在行动阶段放进储物袋，其对战效果在对战时才启用。
    if (def.type !== 'equip' && META.effectRequiresCombat(e) && !state.combat) {
      return { ok: false, error: `【${def.name}】只能在对战过程中使用（当前没有正在进行的对战）` };
    }
  }
  // 对战中的出牌**全部走时点询问**（链）：投骰前后是 `roll·before/after` 窗口、
  // 开战是 `combatDeclare`/`combatOpt`、结算后是 `combatResult`。
  // 所以这里不再有"玩家自己点手牌"的路径 —— 挂在 `when:'combatStart'/'beforeMyRoll'/…` 的牌
  // 只会在对应的询问弹窗里出现，用 respond_play 打出。
  if (state.combat && (state.combat.stage === 'pre' || state.combat.stage === 'roll_defender')) {
    return { ok: false, error: `【${def.name}】是「对战中使用」的牌，请在「斗法」弹窗里破招打出` };
  }
  if (state.combat && state.combat.stage === 'result') {
    // 结果窗口也是【斗法】：出牌走 respond_play，不再走 play。
    return { ok: false, error: '对战结算要走【斗法】：请用「结算获胜/失败时」的牌破招，或点「不破招·跳过」' };
  }
  if (state.combat && state.combat.stage === 'tie') {
    // 平局窗口：时机键含 combatResult:tie 的牌，或（旧数据）op 属于平局类
    const tieOk = plays.some((e) => META.timingKeys(e).indexOf('combatResult:tie') >= 0) || plays.some((e) => TIE_KINDS.has(e.op))
      || (def.effect && TIE_KINDS.has(def.effect.kind));
    if (!tieOk) {
      return { ok: false, error: '平局阶段只能打出改变战力结果的卡牌' };
    }
    const g = realmGate(pl, def);
    if (g && g.ok === false) return g;
    return { ok: true, def: def, overreach: !!(g && g.overreach) };
  }
  if (state.combat) return { ok: false, error: '对战结算中，只能打出对战类卡牌' };
  if (state.players[state.turn].id !== pl.id) return { ok: false, error: '现在不是你的回合' };
  if (state.step !== 'action') return { ok: false, error: '当前不是行动阶段' };
  // 行动阶段（没有对战）时，窗口全在"对战里"的消耗牌不该能打 ——
  // 【风云幡】「在对战获胜时使用」、【青火雷】「在对战中出牌阶段使用」都属于这类。
  // 装备例外：装备本来就是在自己回合放进储物袋的。
  // 只写了 `event` 的**纯响应牌**（【还阳术】【阴魂丝】【风灵劲】【虚天鼎】）也一律不能裸打 ——
  // 它们必须在对应时点由打断窗口询问时才打出。
  if (def.type !== 'equip' && def.type !== 'companion') {
    const hasPlay = plays.some((e) => META.timingKeys(e).indexOf('useCard:after') >= 0);
    if (!hasPlay) {
      const evLabels = (def.effects || []).filter((e) => e.event)
        .map((e) => META.timingLabel(META.timingOfEffect(e)));
      if (evLabels.length) {
        return { ok: false, error: `【${def.name}】只能在「${evLabels.join(' / ')}」时点破招使用` };
      }
      return { ok: false, error: `【${def.name}】只能在对战过程中使用（当前没有正在进行的对战）` };
    }
  }
  const g = realmGate(pl, def);
  if (g && g.ok === false) return g;
  return { ok: true, def: def, overreach: !!(g && g.overreach) };
}

// ---------------------------------------------------------------- 动作

function act(state, pid, action) {
  if (state.phase !== 'playing') return { ok: false, error: '游戏尚未开始或已结束' };
  const pl = p(state, pid);
  if (!pl || pl.out) return { ok: false, error: '你已出局' };
  const a = action || {};
  let res;
  // 打断窗口开着的时候，除了"表态"什么都不能做 —— 这是锁链能成立的前提。
  // 先剪掉已经出局的表态人；剪空了就直接把窗口结算掉（否则整局卡死）。
  if (state.pending) settleIfQueueEmpty(state);
  if (state.pending && a.type !== 'respond_pass' && a.type !== 'respond_play') {
    const who = pendingActor(state);
    return { ok: false, error: `正在等待【${who ? who.name : '?'}】决定是否破招，其他操作暂时不能进行` };
  }
  // 回合结束的「手牌超上限」期间：**只能弃牌**，弃够才放行
  if (state.forceDiscard && a.type !== 'discard') {
    const who = p(state, state.forceDiscard.playerId);
    return { ok: false, error: `正在等【${who ? who.name : '?'}】弃置超出上限的手牌（还需 ${state.forceDiscard.need} 张）` };
  }
  // ⭐ 看门狗代打（`autoIdleAction` 产出的动作带 `auto: '<在做什么>'`）：战报里说清楚是"超时自动"，
  //    免得玩家以为系统替他乱出牌。
  if (a.auto) log(state, 'info', `〔超时〕${pl.name} 长时间没有动作，系统自动${a.auto}。`, { player: pl.id, auto: true });
  switch (a.type) {
    case 'respond_pass': res = respondPass(state, pl); break;
    case 'respond_play': res = respondPlay(state, pl, a.uid, a.tier, a); break;
    case 'draw_qi': res = doDrawQi(state, pl); break;
    case 'draw_treasure': res = doDrawTreasure(state, pl, a); break;
    case 'choose_draw': res = doChooseDraw(state, pl, a); break;
    case 'play': res = doPlay(state, pl, a); break;
    case 'promote': res = doPromote(state, pl); break;
    case 'seclusion': res = doSeclusion(state, pl); break;
    case 'combat': res = doCombat(state, pl, a); break;
    case 'roll': res = doRoll(state, pl); break;
    case 'tie': res = doTie(state, pl, a); break;
    // 兼容旧前端：结果窗口也走【斗法】，`result_pass` 等价于"不破招、跳过这个时点"
    case 'result_pass': res = respondPass(state, pl); break;
    case 'activate': res = doActivate(state, pl, a); break;
    case 'discard': res = doDiscard(state, pl, a); break;
    case 'dismiss': res = doDismiss(state, pl, a); break;
    case 'end_turn':
      if (state.players[state.turn].id !== pl.id) return { ok: false, error: '现在不是你的回合' };
      if (state.combat) return { ok: false, error: '对战尚未结算' };
      // 把 endTurn 的返回值透出去 —— 超上限时它会带 { forcedDiscard: N }
      res = endTurn(state) || { ok: true };
      break;
    default: return { ok: false, error: '未知动作 ' + a.type };
  }
  postAction(state);
  return res;
}

function postAction(state) {
  if (state.phase !== 'playing') return;
  if (state.combat) return;
  // 任何动作后都检查终局（卡牌效果可能淘汰非当前玩家）
  checkLastStanding(state);
  if (state.phase !== 'playing') return;
  const cur = state.players[state.turn];
  if (cur && cur.out) {
    const nxt = alive(state);
    if (nxt.length <= 1) {
      const last = nxt[0];
      state.phase = 'over';
      state.winner = last ? last.id : null;
      if (last) log(state, 'win', `${last.name} 是最后一位存活者，直接获得本局胜利！`, { player: last.id });
      return;
    }
    advance(state);
  }
}

/** 手牌 + 场上（装备/法术区/同行者/傀儡）里有没有**这张牌名** —— 学习条件等用（实物【大庚剑阵】） */
function hasCardAnywhere(pl, name) {
  const hit = (arr) => (arr || []).some((x) => { const d = cardDef(x.id); return d && d.name === name; });
  return hit(pl.hand) || hit(pl.equip) || hit(pl.spells) || hit(pl.companions) || hit(pl.puppets);
}

/** 全局找一张"场上的牌"实例（按 uid）—— 【金魁】这类"使场上某张牌无效"的目标。 */
function findBoardInst(state, uid) {
  if (uid == null) return null;
  const want = (typeof uid === 'string' && uid !== '' && !isNaN(Number(uid))) ? Number(uid) : uid;
  for (const pl of state.players) {
    for (const arr of [pl.equip, pl.spells, pl.companions, pl.puppets || []]) {
      for (const inst of arr) if (inst.uid === want || String(inst.uid) === String(uid)) return { inst: inst, owner: pl };
    }
  }
  return null;
}

function doChooseDraw(state, pl, a) {
  if (state.players[state.turn].id !== pl.id) return { ok: false, error: '现在不是你的回合' };
  if (state.step !== 'choose_draw') return { ok: false, error: '当前不需要选择抽牌' };
  const deck = a.deck === 'companion' ? 'companion' : 'spell';
  // 「下回合不能抽取【法术牌】/【同行者】」—— 实物【寒蛟】【血咒禁制】
  const blocked = (deck === 'spell' && pl.blockSpellDraw > 0) || (deck === 'companion' && pl.blockCompanionDraw > 0);
  if (blocked) {
    return { ok: false, error: `你被封锁，本回合不能抽取${deckLabel(deck)}（还封锁 ${deck === 'spell' ? pl.blockSpellDraw : pl.blockCompanionDraw} 个回合）` };
  }
  const got = [];
  // ⭐ 学习条件（实物【大庚剑阵】）：抽到某张法术牌、但自己手上/场上没有它要求的搭配牌时，
  //    把它放回**法术牌堆底部**并重新抽 1 张。卡文原话：
  //    "若无【青元剑诀】的修士抽取到此神通时，需放置回【法术牌】牌堆底部，然后重新抽取1张【法术牌】"。
  for (let guard = 0; guard < 6; guard++) {
    const one = drawFrom(state, deck, 1);
    const gid = one[0];
    if (gid === undefined) break;
    const gdef = cardDef(gid);
    const need = gdef && gdef.learnRequires;
    if (!need || hasCardAnywhere(pl, need)) { got.push(gid); break; }
    state.decks[deck].draw.unshift(gid);            // 放回牌堆**底部**
    log(state, 'info',
      `${pl.name} 抽到【${gdef.name}】，但手上与场上都没有搭配的【${need}】——按学习条件放回${deckLabel(deck)}堆底部，重新抽取。`);
  }
  for (const g of got) {
    pl.hand.push(mk(UID++, g));
    log(state, 'draw', `${pl.name} 从${deckLabel(deck)}堆抽到【${cardDef(g).name}】。`, { player: pl.id, card: g, deck: deck });
  }
  // 〔时点〕法术或同行者抽取（只给抽牌的人自己触发，对手不能插 —— 用户裁定）
  fireTiming(state, 'drawSpell', null, { subjectId: pl.id, subject: 'self' });
  state.step = 'action';
  return { ok: true };
}

/** 阶段一：手动抽取 1 张灵气牌（原为回合开始自动抽）。 */
function doDrawQi(state, pl) {
  if (state.players[state.turn].id !== pl.id) return { ok: false, error: '现在不是你的回合' };
  if (state.step !== 'draw_qi') return { ok: false, error: '当前不是抽取灵气牌的阶段' };
  const q = drawFrom(state, 'qi', 1);
  for (const id of q) gainQiCard(state, pl, id);
  // 〔时点〕灵气抽取（只给自己）
  fireTiming(state, 'drawQi', null, { subjectId: pl.id, subject: 'self' });
  state.step = 'draw_treasure';
  return { ok: true };
}

/**
 * 阶段二：探索阶段 —— ⭐ **阶段事务模型**的样板（2026-10-05 用户设计）：
 *
 *   进阶段 → 该时点的效果先入【斗法】（卡文带「可以」= 主动发动，**必须问玩家**）
 *          → 逆序收势（增量型立即抽、替换型登记 phaseMods）
 *          → 有人发动过就**再问一轮**（oncePerTurn 滤掉已发动的，问无可问自然停）
 *          → 连续不发动，最后才落**基础行动**「抽 2 张宝物牌」（被替换就改抽 1 宝物 + 1 法术）。
 *
 * 旧的【青易居士】`mode:'qingyi'` 特殊按钮已废：它就是挂在探索时点的一条替换型效果，
 * 与其他卡不再有特殊通道。`exploreSwapDef` / 前端第二按钮 / publicState.exploreSwap 一并删除。
 */
function doDrawTreasure(state, pl, a, opts) {
  const o = opts || {};
  if (state.players[state.turn].id !== pl.id) return { ok: false, error: '现在不是你的回合' };
  if (state.step !== 'draw_treasure') return { ok: false, error: '当前不是探索阶段' };
  // 被封锁不能抽宝物牌 —— 实物【血咒禁制】（整个探索阶段跳过：不开窗、不落基础行动）
  if (pl.blockTreasureDraw > 0) {
    log(state, 'info', `${pl.name} 被封锁，本回合不能抽取【宝物牌】（跳过探索阶段）。`);
    state.step = 'choose_draw';
    return { ok: true };
  }

  // ① 阶段时点：探索效果先入【斗法】
  if (!o.base) {
    const signal = {};
    const r = fireTiming(state, 'drawTreasure', null, {
      subjectId: pl.id, subject: 'self', signal: signal,
      resume: () => {
        // 收势后：有人发动过 → 再问一轮（已发动的被 oncePerTurn 滤掉，问无可问 → 零响应直通）；
        //         没人发动 → 收手，落基础行动。
        if (signal.chainLength > 0) doDrawTreasure(state, pl, a, { base: false });
        else doDrawTreasure(state, pl, a, { base: true });
      },
    });
    if (r.opened) return { ok: true, paused: true, timing: 'drawTreasure' };
    // 零响应直通（场上没有探索类牌）→ 直接落基础行动
  }

  // ② 基础行动（栈底，最后结算；可被收势时登记的修饰替换）
  const swap = !!(state.phaseMods && state.phaseMods.exploreSwap);
  if (swap) delete state.phaseMods.exploreSwap;
  if (swap) {
    log(state, 'info', `【青易居士】效果结算：本次探索改为抽取 1 张宝物牌与 1 张法术牌。`);
    const tr = drawFrom(state, 'treasure', 1);
    for (const t of tr) {
      pl.hand.push(mk(UID++, t));
      log(state, 'draw', `${pl.name} 从宝物牌堆抽到【${cardDef(t).name}】。`, { player: pl.id, card: t, deck: 'treasure' });
    }
    const sp = drawFrom(state, 'spell', 1);
    for (const s of sp) {
      pl.hand.push(mk(UID++, s));
      log(state, 'draw', `${pl.name} 从法术牌堆抽到【${cardDef(s).name}】。`, { player: pl.id, card: s, deck: 'spell' });
    }
  } else {
    // ⭐ 实物【神风舟】："在**下回合**的探索阶段额外抽取 1 张【宝物牌】"（一次性，抽完清零）
    const extra = pl.nextExploreTreasure || 0;
    if (extra > 0) pl.nextExploreTreasure = 0;
    const tr = drawFrom(state, 'treasure', 2 + extra);
    for (const t of tr) {
      pl.hand.push(mk(UID++, t));
      log(state, 'draw', `${pl.name} 从宝物牌堆抽到【${cardDef(t).name}】。`, { player: pl.id, card: t, deck: 'treasure' });
    }
    if (extra > 0) log(state, 'info', `${pl.name} 的【神风舟】加持生效：本次探索额外抽取了 ${extra} 张【宝物牌】。`);
  }
  state.step = 'choose_draw';
  return { ok: true };
}

function doSeclusion(state, pl, opts) {
  const o = opts || {};
  if (state.players[state.turn].id !== pl.id) return { ok: false, error: '只有自己的回合才能闭关' };
  // 闭关在自己回合开始时宣布，因此三个抽取前阶段都允许
  if (state.step !== 'draw_qi' && state.step !== 'draw_treasure' && state.step !== 'choose_draw') {
    return { ok: false, error: '闭关须在自己回合开始时宣布' };
  }
  if (pl.seclusionUsed >= (pl.seclusionMax || 1)) {
    return { ok: false, error: `闭关次数已用完（本局共 ${pl.seclusionMax || 1} 次）` };
  }
  // 〔时点〕闭关（宣布时）—— 图上从"法力恢复"分出来的那条支线。
  // 第 3 轮把它也改成**阶段事务模型**：窗口先开、**基础行动**（额外抽 2 灵气 + 回 1 血 + 跳过本回合）
  // 收势之后再落 —— 与其他时点同一套（现在这一格还没有卡，先把结构对齐，
  // 免得将来往这一格挂牌时又变成"基础行动先跑、效果后跑"）。
  if (!o.windowed) {
    const r = fireTiming(state, 'seclusion', null, {
      subjectId: pl.id, subject: 'self',
      resume: () => doSeclusion(state, pl, { windowed: true }),
    });
    if (r.opened) return { ok: true, paused: true, timing: 'seclusion' };
  }
  pl.seclusionUsed = (pl.seclusionUsed || 0) + 1;
  pl.inSeclusion = true;
  log(state, 'seclusion', `${pl.name} 宣布闭关，潜心冲击境界！`);
  const extra = drawFrom(state, 'qi', 2);
  for (const id of extra) gainQiCard(state, pl, id);
  const before = pl.hp;
  pl.hp = Math.min(HP_MAX, pl.hp + 1);
  log(state, 'heal', `${pl.name} 闭关静养，恢复 ${pl.hp - before} 点生命值（${pl.hp}/${HP_MAX}）。`, { player: pl.id, hp: pl.hp });
  log(state, 'info', `${pl.name} 本回合跳过所有行动，闭关期间不会成为对战对象，也不受任何卡牌效果影响。`);
  advance(state);
  return { ok: true };
}

function doPlay(state, pl, a, opts) {
  const idx = handIndexOf(pl, a.uid);
  if (idx < 0) return { ok: false, error: '你手里没有这张牌' };
  const inst = pl.hand[idx];
  const chk = playable(state, pl, inst, a);
  if (!chk.ok) return chk;
  const def = chk.def;
  // 〔时点〕卡牌使用 · 前 —— 【虚天鼎】"使对方的任意 1 张牌无效"本质就是这一刻。
  // 注意：必须在**任何状态改动之前**挂起，恢复时重新走一遍 doPlay（带 skipInterrupt）。
  if (!(opts && opts.skipInterrupt)) {
    const foeId = (state.combat && (state.combat.attacker === pl.id ? state.combat.defender
      : (state.combat.defender === pl.id ? state.combat.attacker : null))) || null;
    const r = fireTiming(state, 'useCard', 'before', {
      subjectId: pl.id, counterId: foeId, combat: state.combat,
      cardUid: inst.uid, cardName: def.name, playerId: pl.id, cardId: def.id,
      resume: () => doPlay(state, pl, a, { skipInterrupt: true }),
    });
    if (r.opened && state.pending) return { ok: true, paused: true, timing: 'useCard.before' };
  }
  const inCombat = !!state.combat;
  let cost = def.cost || 0;
  if (chk.overreach && !overreachSaved(state, pl)) cost += OVERREACH_MANA;
  // 【玄骨】：使用宝物牌/法术牌时法力消耗 -N（最低为 1）。0 费牌不受影响，也不会被抬到 1。
  const costDisc = cardCostDiscount(pl);
  if (costDisc > 0 && cost > 0) cost = Math.max(1, cost - costDisc);
  // ⭐ 实物【七鬼噬魂术】："本回合使用任意 1 张【宝物牌】/【法术牌】时，**不消耗【法力值】**，
  //    但使自身受到 1 点伤害" —— 只对宝物/法术生效（灵气牌本来免费），自伤在打完之后落。
  let freeByQigui = false;
  if (pl.freeCardThisTurn && (deckOf(def.id) === 'treasure' || deckOf(def.id) === 'spell')) {
    freeByQigui = true;
    cost = 0;
  }
  if (def.type !== 'equip' && cost > 0 && pl.mana < cost) {
    return { ok: false, error: `法力值不足（需要 ${cost}，当前 ${pl.mana}）` };
  }

  if (def.type === 'equip') {
    const deck = deckOf(def.id);
    // 装备费按卡文（2026-10-05 用户裁定）：带「装备时不消耗」→ 免费（发动效果才消耗）；
    // 没写 → 装备时消耗（单独印的 equipCost 优先，如【虚天鼎 乾蓝冰焰】=5，否则用角标法力）。
    const freeByText = equipFreeByText(def);
    let equipCost = def.equipCost != null ? def.equipCost : (freeByText ? 0 : (def.cost || 0));
    if (costDisc > 0 && equipCost > 0) equipCost = Math.max(1, equipCost - costDisc);
    // ⭐ 【七鬼噬魂术】：本回合装备宝物牌同样不消耗法力值（自伤在装备完成后落）
    if (freeByQigui && equipCost > 0) {
      equipCost = 0;
      log(state, 'info', `${pl.name} 的【七鬼噬魂术】生效：装备【${def.name}】不消耗法力值。`);
    }
    if (equipCost > 0 && pl.mana < equipCost) {
      return { ok: false, error: `【${def.name}】装备时需消耗 ${equipCost} 点法力值（当前 ${pl.mana}）` };
    }
    // 法术类装备的档位：**用户裁定（2026-10-02）—— 一律自动适配当前境界**（取最高可用档），
    // 不再弹选档窗、也不再看请求里的 tier；唯一例外是"同境界多选"（卡文二选一，见 resolveTier）。
    let chosen = 0;
    if (def.tiers && def.tiers.length) {
      chosen = resolveTier(def, pl.realm, a.tier);
      if (!(chosen >= 0 && chosen < def.tiers.length)) {
        return { ok: false, error: `【${def.name}】的档位无效` };
      }
      if ((def.tiers[chosen].realm || 0) > pl.realm
        && !(pl.ignoreRealmIds && pl.ignoreRealmIds.indexOf(def.id) >= 0)) {
        return { ok: false, error: `【${def.name}】该档效果需要 ${REALMS[def.tiers[chosen].realm]} 才能使用` };
      }
    }
    inst.tier = chosen;
    if (deck === 'treasure') {
      // ⭐ 【青竹蜂云剑 辟邪神雷】这类"叠在另一张牌上"的装备（`attachTo`）：
      //    只要底牌在场，就**不额外占格**（卡面"放置于【青竹蜂云剑】上，即可持续装备"）。
      const attachTo = def.attachTo
        ? pl.equip.find((x) => { const d2 = cardDef(x.id); return d2 && d2.name === def.attachTo && x.attachedTo == null; })
        : null;
      if (pl.equip.length >= equipSlots(pl) && !attachTo) {
        return { ok: false, error: `储物袋已满（${equipSlots(pl)} 格）；第 2 格需炼气期以上才能开启` };
      }
      pl.equip.push(inst);
      pl.hand.splice(idx, 1);
      if (attachTo) {
        inst.attachedTo = attachTo.uid;
        log(state, 'info', `${pl.name} 把【${def.name}】放置在【${def.attachTo}】上**持续装备**（不额外占储物袋格子）。`,
          { player: pl.id, card: def.id });
      }
      // 「每回合 1 次，装备任意【装备类宝物牌】时抽 1 张灵气牌」—— 实物【银月】
      fireEquipTriggers(state, pl);
    } else {
      if (pl.spells.length >= spellSlots(pl)) return { ok: false, error: `法术区已满（${spellSlots(pl)} 格）` };
      pl.spells.push(inst);
      pl.hand.splice(idx, 1);
    }
    const tierNote = (def.tiers && def.tiers.length)
      ? `，选用「${REALMS[def.tiers[chosen].realm]}」档效果` : '';
    if (equipCost > 0) {
      pl.mana -= equipCost;
      log(state, 'mana_spend',
        `${pl.name} 装备【${def.name}】，消耗 ${equipCost} 点法力值（发动其效果不再消耗）${tierNote}。`,
        { player: pl.id, card: def.id, mana: pl.mana, equip: true, tier: chosen });
    } else {
      log(state, 'play',
        `${pl.name} 装备【${def.name}】——装备不消耗法力值（发动其效果时才消耗）${tierNote}。`,
        { player: pl.id, card: def.id, equip: true, tier: 'low', tiers: chosen });
    }
    // 「装备即结算」的一次性效果 —— 装备类法术里那些「自己回合内使用」的效果（【长春功】【玄阴诀】）。
    // 早期版本装备分支完全不跑任何效果，导致【长春功】的"提升1次境界"从来没发生过。
    {
      const equipCtx = {
        state: state, selfCardId: def.id, selfInst: inst, deck: deck,
        target: a.target, targetPl: a.target ? p(state, a.target) : null,
      };
      for (const e of effectsOf(def, inst)) {
        // ⚠️ 只跑「装备即结算」那一格 —— 旧写法 when:'play'，坐标写法 `useCard:after`，两者**等价**。
        //    combatStart / beforeMyRoll / win / lose 是对战窗口，靠 collectEffects 在用时触发，
        //    绝不能在"装备那一刻"就结算掉（那会让【敛气术】这类提前生效）。
        //    早期版本直接比 `e.when !== 'play'`：数据迁到坐标后【长春功】的"提升 1 次境界"
        //    又变回死效果（2026-10-02 dead-effect-test 逮到）。
        if (META.timingKey(e) !== 'useCard:after') continue;
        if (!matchConditions(e.if, equipCtx)) continue;
        resolveEffect(state, pl, e, equipCtx, { source: 'card', def: def, inst: inst });
      }
    }
    // ⭐ 【七鬼噬魂术】反噬：装备完再落自伤
    if (freeByQigui) {
      log(state, 'info', `${pl.name} 的【七鬼噬魂术】反噬：本次装备未消耗法力值，但自身受到 ${pl.freeCardSelfDamage || 1} 点伤害。`);
      applyDamage(state, pl, pl.freeCardSelfDamage || 1, 'card', pl.id);
    }
    return { ok: true };
  }

  if (def.type === 'companion') {
    const need = companionSlotCost(def);
    const used = companionUsedSlots(pl);
    const cap = companionSlots(pl);
    if (used + need > cap) {
      return { ok: false, error: `同行者位不足：【${def.name}】占 ${need} 个位置，当前已用 ${used}/${cap}（筑基期以上可扩充到 2 格）` };
    }
    pl.companions.push(inst);
    pl.hand.splice(idx, 1);
    // ⭐ 实物【胡月】：这张同行者是不是**靠它撑出来的额外位**才放得下？
    //    打了标记之后，胡月离场时要一起进弃牌堆（卡文原话）。
    if (used + need > baseCompanionSlots(pl)) inst.onBonusSlot = true;
    log(state, 'play', `${pl.name} 招来了同行者【${def.name}】${need > 1 ? `（占 ${need} 个位置）` : ''}。`,
      { player: pl.id, card: def.id, companion: true, slots: need });
    // 首次放置时的效果（DSL：when === 'place'）—— 实物【铁火蚁】【血玉蜘蛛】【离龟】
    for (const x of collectEffects(pl, 'place', { self: pl, state: state }, 'companions')) {
      const e = x.eff;
      if (e.op === 'draw_treasure') {
        const got = drawFrom(state, 'treasure', e.value || 1);
        for (const g of got) pl.hand.push(mk(UID++, g));
        log(state, 'draw', `${pl.name} 的同行者【${def.name}】效果发动：抽取 ${got.length} 张【宝物牌】。`, { player: pl.id });
      } else if (e.op === 'draw_qi' || e.op === 'place_draw_qi') {
        const got = drawFrom(state, 'qi', e.value || 1);
        for (const g of got) gainQiCard(state, pl, g);
      } else if (e.op === 'extra_seclusion') {
        pl.seclusionMax = (pl.seclusionMax || 1) + (e.value || 1);
        log(state, 'info', `${pl.name} 的同行者【${def.name}】效果发动：额外获得 ${e.value || 1} 次【过关】机会（共 ${pl.seclusionMax} 次）。`);
      } else {
        resolveEffect(state, pl, e, { state: state, selfUid: x.inst.uid }, { source: 'companion', def: def, inst: x.inst });
      }
    }
    return { ok: true };
  }

  // 多档位卡（如【火弹术】"二选一"）：消耗类卡以前没人处理 tiers，永远走第 1 档 —— 这里补上。
  // 境界档自动适配；同境界多选（二选一）照用玩家指定/勾选的那一项。
  if (def.tiers && def.tiers.length) {
    const t = resolveTier(def, pl.realm, a.tier);
    if (!(t >= 0 && t < def.tiers.length)) return { ok: false, error: `【${def.name}】的档位无效` };
    if ((def.tiers[t].realm || 0) > pl.realm) {
      return { ok: false, error: `【${def.name}】该档效果需要 ${REALMS[def.tiers[t].realm]} 才能使用` };
    }
    inst.tier = t;
  }
  pl.mana -= cost;
  pl.hand.splice(idx, 1);
  const ctx = { state: state, combat: inCombat ? state.combat : null,
    target: a.target, targets: a.targets, targetPl: a.target ? p(state, a.target) : null,
    selfCardId: def.id, selfInst: inst, deck: deckOf(def.id) };
  log(state, 'play', `${pl.name} 打出【${def.name}】${cost ? `（消耗 ${cost} 点法力值）` : ''}。`,
    { player: pl.id, card: def.id, overreach: !!chk.overreach });
  markPlayed(state, pl, def);      // 供 if.playedThisTurn 的套装判定（本回合打出过哪些牌）
  // 打出这张卡时立刻生效的效果（按 if 条件过滤）。同行者不走这里（它走上面的 place 分支）。
  const applied = [];
  for (const e of playNowEffects(def, inst)) {
    if (!matchConditions(e.if, ctx)) continue;
    resolveEffect(state, pl, e, ctx, { source: 'card', def: def, inst: inst });
    applied.push(e);
    markTurnUse(state, pl, inst, e);   // 「一回合一次」的牌打出后也记账（手牌类少见，但保持语义一致）
  }
  // 「使用指定丹药时效果翻倍，之后此同行者放入弃牌堆」—— 实物【陈巧倩】
  if (applied.length) {
    const doubler = doubleEffectSource(pl, def.name);
    if (doubler) {
      for (const e of applied) {
        applyDoubleEffect(state, pl, doubler, Object.assign({ name: def.name }, e), ctx);
      }
    }
  }
  // 傀儡形法器（【傀儡蜥蜴】）打出后**留在场上的独立傀儡位**，不立刻进弃牌堆；
  // 其余消耗牌照旧结算完就进弃牌堆。
  if (def.equipSlot !== 'puppet') toDiscard(state, deckOf(def.id), def.id);
  // ⭐ 实物【七鬼噬魂术】反噬：这张牌没花法力，但自身受 1 点伤害（打完才落）
  if (freeByQigui) {
    log(state, 'info', `${pl.name} 的【七鬼噬魂术】反噬：本次使用未消耗法力值，但自身受到 ${pl.freeCardSelfDamage || 1} 点伤害。`);
    applyDamage(state, pl, pl.freeCardSelfDamage || 1, 'card', pl.id);
  }
  // ⭐ 实物【神风舟】："跳过本回合所有行动" —— 打完这张牌就立刻收掉本回合
  //    （不再开 `useCard · 后` 窗：这个回合已经没有后续行动可响应了）
  if (pl.voidTurn) {
    pl.voidTurn = false;
    log(state, 'info', `${pl.name} 本回合的其余行动全部跳过。`);
    if (state.combat && state.combat.cancelled) { log(state, 'info', '本次对战被取消。'); state.combat = null; }
    advance(state);
    return { ok: true };
  }
  // 「使用任意【消耗类法宝】后」的钩子 —— 实物【玄阴诀】
  // 消耗类**法宝** = 宝物牌堆里的 consume（法术牌堆不算，玄阴诀自己也不会触发自己）
  if (def.type === 'consume' && deckOf(def.id) === 'treasure') fireAfterConsumeRoll6(state, pl, def);
  // 〔时点〕卡牌使用 · 后（对手也能响应 —— 【虚天鼎】那条是"对方 · 前"，这里是"我方 · 后"）
  fireTiming(state, 'useCard', 'after', { subjectId: pl.id, subject: 'self' });

  if (state.combat && state.combat.cancelled) {
    log(state, 'info', '本次对战被取消。');
    state.combat = null;
  }
  return { ok: true };
}

function doDiscard(state, pl, a) {
  // 用户裁定（2026-10-02）：**没有"主动弃置手牌"这个动作了**。
  // 弃牌只剩两个来源：① 卡片效果（如【噬金虫】离场收紧上限）② 回合结束时的那一次判定。
  // 所以这个函数现在**只服务于回合结束的强制弃牌**（state.forceDiscard）。
  const fd = state.forceDiscard;
  if (!fd) {
    return { ok: false, error: '手牌上限只在回合结束时判定一次，平时不能弃置手牌' };
  }
  if (fd.playerId !== pl.id) {
    const who = p(state, fd.playerId);
    return { ok: false, error: `正在等【${who ? who.name : '?'}】弃置超出上限的手牌` };
  }
  const idx = handIndexOf(pl, a.uid);
  if (idx < 0) return { ok: false, error: '你手里没有这张牌' };
  const inst = pl.hand.splice(idx, 1)[0];
  toDiscard(state, deckOf(inst.id), inst.id);
  log(state, 'discard', `${pl.name} 弃置了【${cardDef(inst.id).name}】。`);
  if (fd) {
    // 每弃一张重算一次：玩家可能弃的是别的牌堆的牌，所以不能简单地 need--
    const chk = handOverLimit(pl);
    fd.need = chk.need;
    fd.over = chk.over;
    if (chk.need <= 0) {
      state.forceDiscard = null;
      log(state, 'info', `${pl.name} 的手牌已回到上限内，回合结束。`);
      // 回到 endTurn 把它走完（windowed: 回合结束时点已经问过了；afterForcedDiscard: 别再拦一次）
      endTurn(state, { windowed: true, afterForcedDiscard: true });
    } else {
      log(state, 'info', `${pl.name} 还需弃置 ${chk.need} 张（宝物 ${chk.limits.treasure} / 法术 ${chk.limits.spell} / 同行者 ${chk.limits.companion}）。`);
    }
  }
  return { ok: true };
}

/**
 * 「撤下」—— 行动阶段把自己场上的牌（同行者/储物袋/法术区/傀儡位）撤下进弃牌堆腾格。
 * 用户裁定（A 方案）：免费、不限次数、撤下即进弃牌堆；放新牌仍按原规则。
 * 联动：同行者离场走 loseCompanion（【噬金虫】手牌上限立即收回并弃掉多出的）；
 * 常驻/被动效果本就按当前场面实时计算（passives/collectEffects），离场即失效，无需清理。
 */
/**
 * 【青竹蜂云剑 辟邪神雷】这类**叠在另一张牌上**的装备（卡面"若已装备【青竹蜂云剑】，
 * 将此【宝物牌】放置于【青竹蜂云剑】上，即可持续装备"）：
 * 底牌一离场（撤下 / 被弃置 / 被夺走），叠在它上面的牌**一起进弃牌堆**。
 * 返回被带走的张数。
 */
function detachAttached(state, pl, baseUid, why) {
  let n = 0;
  for (const zone of ['equip', 'spells']) {
    for (let i = pl[zone].length - 1; i >= 0; i--) {
      const inst = pl[zone][i];
      if (inst.attachedTo == null || String(inst.attachedTo) !== String(baseUid)) continue;
      pl[zone].splice(i, 1);
      const d = deckOf(inst.id);
      if (d) toDiscard(state, d, inst.id);
      log(state, 'discard',
        `${pl.name} 叠在上面的【${(cardDef(inst.id) || {}).name}】随之${why || '离场'}，放入弃牌堆。`, { player: pl.id });
      n++;
    }
  }
  return n;
}

function doDismiss(state, pl, a) {
  if (state.players[state.turn].id !== pl.id) return { ok: false, error: '只有自己的回合才能撤下' };
  if (state.step !== 'action') return { ok: false, error: '只有在行动阶段才能撤下场上的牌' };
  if (state.combat) return { ok: false, error: '对战结算中不能撤下' };
  const uid = Number(a.uid);
  const ci = pl.companions.findIndex((x) => Number(x.uid) === uid);
  if (ci >= 0) {
    const inst = pl.companions[ci];
    const name = (cardDef(inst.id) || {}).name;
    loseCompanion(state, pl, inst);
    toDiscard(state, 'companion', inst.id);
    log(state, 'companion_down', `${pl.name} 将同行者【${name}】撤下，放入弃牌堆。`);
    return { ok: true };
  }
  for (const zone of ['equip', 'spells']) {
    const i = pl[zone].findIndex((x) => Number(x.uid) === uid);
    if (i >= 0) {
      const inst = pl[zone].splice(i, 1)[0];
      const d = deckOf(inst.id);
      if (d) toDiscard(state, d, inst.id);
      log(state, 'discard', `${pl.name} 将【${(cardDef(inst.id) || {}).name}】撤下，放入弃牌堆。`);
      // 底牌走了 → 叠在它上面的【青竹蜂云剑 辟邪神雷】一起走
      detachAttached(state, pl, inst.uid, '被撤下');
      return { ok: true };
    }
  }
  const pi = (pl.puppets || []).findIndex((x) => Number(x.uid) === uid);
  if (pi >= 0) {
    const inst = pl.puppets.splice(pi, 1)[0];
    toDiscard(state, 'treasure', inst.id);
    log(state, 'companion_down', `${pl.name} 将傀儡【${inst.name || (cardDef(inst.id) || {}).name}】撤下，放入弃牌堆。`);
    return { ok: true };
  }
  return { ok: false, error: '你场上没有这张牌' };
}

/**
 * 计算「晋升折扣」卡对目标境界的合计折扣（纯计算，不消耗）。支持两张卡组合使用。
 *   kind = 'threshold'（默认）→ 只统计"降低门槛"的折扣（如【九曲灵参】）
 *   kind = 'consume'          → 只统计"减少消耗"的折扣（如【娑罗珠】）
 * 两条通道必须分开：卡文写「所需」的减门槛、写「消耗」的减消耗，混在一起就是打错折。
 */
function calcPromoteDiscount(state, pl, to, logIt, kind) {
  const want = kind === 'consume' ? 'consume' : 'threshold';
  const list = (pl.promoPending || []).filter((x) =>
    (x.on || 'threshold') === want && (!x.onlyRealm || x.onlyRealm === to));
  if (!list.length) return 0;
  let total = 0;
  const used = new Set();
  for (let i = 0; i < list.length; i++) {
    if (used.has(i)) continue;
    const a = list[i];
    if (a.comboWith) {
      const j = list.findIndex((b, k) => k !== i && !used.has(k) && b.name === a.comboWith);
      if (j >= 0) {
        used.add(i); used.add(j);
        const v = a.comboValue || ((a.value || 1) + (list[j].value || 1));
        total += v;
        if (logIt) log(state, 'info', `【${a.name}】与【${list[j].name}】组合使用，本次晋升${want === 'consume' ? '消耗' : '所需灵气值'} -${v}。`);
        continue;
      }
    }
    used.add(i);
    total += a.value || 1;
  }
  return total;
}
/** 消耗掉本次晋升用到的折扣卡（抽灵气牌的结算已在打出时完成）。 */
function consumePromoteDiscount(state, pl, to) {
  const all = pl.promoPending || [];
  pl.promoPending = all.filter((x) => !!x.onlyRealm && x.onlyRealm !== to);
}

function doPromote(state, pl, opts) {
  const o = opts || {};
  if (state.players[state.turn].id !== pl.id) return { ok: false, error: '现在不是你的回合' };
  if (state.step !== 'action') return { ok: false, error: '当前不是行动阶段' };
  // ⭐ 对战中禁止晋升（交接 §5.2 的老欠账）：以前没有这道闸，玩家能在别人打过来的对战里中途结丹。
  if (state.combat) return { ok: false, error: '对战结算中不能晋升（先把这场对战打完）' };
  if (state.turnFlags.promote) return { ok: false, error: '本回合已经晋升过了' };
  if (pl.realm >= 4) return { ok: false, error: '你已结成元婴' };
  // 窗口前的**可行性预检**：灵气不够就直接拒，别先弹"要不要用折扣牌"的窗口再悄悄失败
  //   （恢复阶段的返回值没人接 —— 客户端只会看到窗口一闪，然后什么都没发生）。
  //   窗口里的牌只会让晋升**更便宜**，所以用"当前折扣算出的门槛"做预检是保守且正确的。
  const to = pl.realm + 1;
  const preThreshold = Math.max(0, promoteThreshold(pl, to)
    - (promoteDiscount(pl) + calcPromoteDiscount(state, pl, to, false, 'threshold')));
  if (qiOf(pl) < preThreshold) {
    return { ok: false, error: `灵气值不足：晋升${REALMS[to]}需要 ${preThreshold} 点，当前 ${qiOf(pl)} 点` };
  }
  // 〔时点〕晋升 · 前 —— **已接上询问层**（用户 2026-10-02 拍板）。
  //   卡文写"晋升时使用"的牌（【娑罗珠】"使本次晋升消耗的灵气值 -1"）就在这一格打出，
  //   链结算完（折扣已经记进 pl.promoPending）再继续跑下面的晋升流程。
  //   恢复时带 opts.before，避免把窗口重新开一遍（与 doRoll 的 o.before 同一套路）。
  if (!o.before) {
    const w = fireTiming(state, 'promote', 'before', {
      subjectId: pl.id, subject: 'self',
      // 当前实际消耗（常驻折扣后）——给候选过滤用：减消耗的牌在消耗为 0 时不问
      promoteConsume: Math.max(0, (PROMOTE_CONSUME[to - 1] || 0) - promoteConsumeDiscount(pl)),
      resume: () => doPromote(state, pl, { before: true }),
    });
    if (w.opened) return { ok: true, paused: true, timing: 'promote.before' };
  }
  const need = promoteThreshold(pl, to);
  // 「门槛」与「消耗」是游戏里两个独立的数：
  //   门槛 = 灵根符上印的「需达到」，决定你有没有资格晋升
  //   消耗 = 晋升时真正扣掉的灵气值
  // 折扣必须分开算：卡文写「所需」的减门槛（九曲灵参/玄骨/辛如音…），
  // 卡文写「消耗」的减消耗（娑罗珠）。早期版本把两者一起减到门槛上，导致
  // 娑罗珠「说减消耗其实没减」——玩家照原价付钱。
  const discThreshold = promoteDiscount(pl) + calcPromoteDiscount(state, pl, to, false, 'threshold');
  const discConsume = promoteConsumeDiscount(pl) + calcPromoteDiscount(state, pl, to, false, 'consume');
  const threshold = Math.max(0, need - discThreshold);
  const consume = Math.max(0, PROMOTE_CONSUME[to - 1] - discConsume);
  if (qiOf(pl) < threshold) {
    return { ok: false, error: `灵气值不足：晋升${REALMS[to]}需要 ${threshold} 点，当前 ${qiOf(pl)} 点` };
  }
  // 折扣卡正式生效（含组合技播报与「进弃牌堆抽灵气」）
  calcPromoteDiscount(state, pl, to, true, 'threshold');
  calcPromoteDiscount(state, pl, to, true, 'consume');
  consumePromoteDiscount(state, pl, to);
  state.turnFlags.promote = true;
  log(state, 'info', `${pl.name} 在【灵根符】上确认：晋升${REALMS[to]}需 ${threshold} 点灵气值（当前 ${qiOf(pl)} 点），将消耗 ${consume} 点。`);
  spendQi(state, pl, consume);
  // 晋升时生效的效果（DSL：when === 'promote'）—— 【辛如音】【韩愈】折扣、【韩立】重掷等
  for (const x of collectEffects(pl, 'promote', { self: pl, state: state })) {
    log(state, 'info', `【${x.def.name}】的晋升效果生效。`);
    resolveEffect(state, pl, x.eff, { state: state }, { source: 'companion', def: x.def, inst: x.inst });
  }
  const diceNeed = PROMOTE_DICE[to - 1];
  let roll = 0;
  if (diceNeed > 0) {
    roll = d6(state);
    log(state, 'roll', `${pl.name} 冲击${REALMS[to]}，掷出 ${roll} 点（需 ≥${diceNeed}）。`,
      { player: pl.id, value: roll, scope: 'promote', need: diceNeed });
    if (roll < diceNeed && (passives(pl).reroll > 0 || pl.hasReroll)) {
      const r2 = d6(state);
      log(state, 'roll', `${pl.name} 借秘宝之力重掷：${r2} 点。`, { player: pl.id, value: r2, scope: 'promote', need: diceNeed, reroll: true });
      roll = r2;
    }
  }
  if (diceNeed === 0 || roll >= diceNeed) {
    pl.realm = to;
    syncEquipTiers(pl);          // 多档位牌自动对齐新境界（"自动适配当前境界"）
    log(state, 'promote', `${pl.name} 成功晋升【${REALMS[to]}】！基础战力值提升至 ${baseCombat(pl)} 点。`,
      { player: pl.id, realm: to, realmName: REALMS[to] });
    if (to >= 2) {
      log(state, 'congrats', `📣 祝贺词：恭喜 ${pl.name} 晋升${REALMS[to]}境界，自此仙途更上一层楼！`);
    }
    if (to >= 4) {
      state.phase = 'over';
      state.winner = pl.id;
      log(state, 'win', `${pl.name} 从凡人一路修炼至元婴——结婴之战，胜者是他！`, { player: pl.id });
    }
  } else {
    log(state, 'promote_fail', `${pl.name} 冲击${REALMS[to]}失败，灵气溃散（消耗的灵气值不予返还）。`, { player: pl.id });
  }
  return { ok: true };
}

function doCombat(state, pl, a, opts) {
  const o = opts || {};
  if (!o.ready) {
  if (state.players[state.turn].id !== pl.id) return { ok: false, error: '只有自己的回合才能发起对战' };
  if (state.step !== 'action') return { ok: false, error: '当前不是行动阶段' };
  if (state.turnFlags.combat) return { ok: false, error: '每位修士在自己的回合仅能发起一场对战' };
  // 规则：**每个人的第一个回合不能发起对战** —— 各人先铺一回合场（出牌/抽牌/晋升），第 2 个回合才解锁。
  if ((pl.turnsTaken || 0) <= 1) {
    return { ok: false, error: '这是你的第一个回合，还不能发起对战（各人先铺一回合场，第 2 个回合起可发起）' };
  }
  if (pl.inSeclusion) return { ok: false, error: '闭关中不可发起对战' };
  // 被封锁不能发起对决 —— 实物【血咒禁制】
  if (pl.blockCombat > 0) return { ok: false, error: `你被封锁，本回合无法发起对决（还封锁 ${pl.blockCombat} 个回合）` };
  const t = p(state, a.target);
  if (!t || !canBeAttacked(t)) return { ok: false, error: '目标无效（已出局或正在闭关）' };
  if (t.id === pl.id) return { ok: false, error: '不能对自己发起对战' };
  // ⭐ 实物【隐灵纱】【神风舟】："在你的下回合开始之前，你无法被指定为对战目标"
  //    —— 只挡**对战目标**，不挡"指定一位修士受伤"那类效果（所以没写进 canBeAttacked）。
  if (t.noTarget) {
    return { ok: false, error: `${t.name} 隐去行迹，在其下回合开始之前无法被指定为对战目标` };
  }
  if (pl.realm - t.realm >= 2) {
    return { ok: false, error: `不可向低于自己两个境界的修士发起对战（你是${REALMS[pl.realm]}，对方是${REALMS[t.realm]}）` };
  }
  state.turnFlags.combat = true;
  // 〔时点〕战斗选择目标（图上的第 9 格）—— 谁被选中是这一刻定下来的
  fireTiming(state, 'chooseTarget', null, { subjectId: pl.id, counterId: t.id, subject: 'self', combat: null });
  state.combat = {
    attacker: pl.id, defender: t.id, stage: 'pre',
    bonus: {}, debuff: {}, dice: {}, total: {}, diceBonus: {},
    // v6 新效果用的容器
    dicePenalty: {},   // 让某方骰点 -N（最低 1）
    noPenalty: {},     // 某方本场失败不受惩罚
    flatPower: {},     // 某方战力固定值（不可被增减）
    blocked: {},       // 某方被封锁的卡牌类别
    loseSave: {},      // 失败时掷骰免罚（风雷翅）
    compPaid: {},      // 同行者对战效果的法力已付记录（温天仁）
    loseRetaliate: {},  // 失败时反伤对方（透明丝线）
    forceReroll: {},   // 强制对方重掷（颠倒五行阵）
    skipDice: {},      // 放弃掷骰（金光砖符）
    winBonusDamage: {}, // 获胜后追加伤害（天雷子/火弹术）
    winStealTreasure: {}, // 获胜后抽对方宝物牌（火弹术）
    winMana: {},       // 获胜后回法力（朱雀环）
    winDrawQi: {},     // 获胜后抽灵气牌（风云幡）
    selfLoseDamage: {}, // 本场失败时自己额外受伤（青火雷）
    // 结果窗口（战果已定后的"获胜时/失败时"出牌机会）
    winnerId: null, loserId: null,
    equipBonus: null,
    // 低境界装备的"对战启用费"是否已付（按 玩家id → {装备uid: true}）—— 付了才在本场生效
    equipEnabled: {},
    tieUsed: {}, tiePassed: {}, cancelled: false,
  };
  log(state, 'combat_start', `${pl.name}（${REALMS[pl.realm]}）向 ${t.name}（${REALMS[t.realm]}）发起对战！对战开始前双方可打出对战类卡牌。`,
    { attacker: pl.id, defender: t.id });
  }   // ← 建好对战为止；之后的窗口在 resume 时会带着 ready 标记重进这里

  // 〔时点〕**「对战阶段」= 三合一窗口**（用户 2026-10-02 深夜四拍板："合"）。
  //
  // 以前这里是**两个窗口按顺序开**：
  //   ① `combatDeclare`（被指定为目标）——【阴魂丝】"当你被指定为对战目标时"、【风灵劲】"别人发起对战时"
  //   ② `combatOpt`（可选发动 / 付费启用）——【绿煌剑】【黑血刀】【青竹蜂云剑】【青元剑诀】【温天仁】
  // 玩家因此在开战时被连问两次（第三格 `chooseTarget` 只是留痕）。现在合成**一次询问**：
  // 候选 = 两类钩子的并集，但**各自按各自的主体规则判**（攻方不能打"被指定为目标"的【阴魂丝】）。
  // 断链后 resume 一次走完（`declared/played` 一起置位）。
  // **先建好 combat 再开窗口**，这样响应牌（block_enemy_card_kind / damage_attacker / enable_equip_combat）
  // 才有对战上下文。
  const cid = state.combat.attacker, did = state.combat.defender;
  if (!o.declared) {
    const specs = [
      { event: 'combatDeclare', subjectId: cid, counterId: did },   // 被指定为目标（只有被指定那位能响应）
      { event: 'combatOpt', allSides: true },                      // 双方各看自己的牌（启用费 / 温天仁）
    ];
    const r = fireTiming(state, 'combatDeclare', null, {
      specs: specs, combat: state.combat,
      attacker: cid, defender: did,
      // 合并窗口结算完 → 一次把 declared/played 都置位，不再开第二个窗口
      resume: () => doCombat(state, pl, a, { ready: true, declared: true, played: true }),
    });
    if (r.opened) return { ok: true, paused: true, timing: 'combatDeclare' };
  }
  return { ok: true };
}

/**
 * 掷骰（两段式：攻方先、应战方后）—— ⭐ **优先权循环**（2026-10-05 用户拍板）：
 *   「先攻/后攻出牌阶段」（投骰前）不再只开一次窗，而是：
 *     阶段主（投骰者）优先表态 → 对方响应 → 循环 → 双方连续不发动 → 逆序收势
 *     → 链非空就**再问一轮**（回到阶段主继续发动）→ 直到一轮谁都没发动，才推进到投骰。
 *   后攻出牌阶段同理，优先权给后攻（阶段主优先 —— 改的是铁律 2 在对战内的应用）。
 *   没人能响应就不开窗（零响应直通，行为与旧版一致）。
 * 掷完照旧开一个 `roll·after` 窗口（单次，不进循环）。
 * 原来"对战出牌阶段由玩家自己点手牌"的路径被这条链取代 —— `playable` 里已拒绝。
 */
function doRoll(state, pl, opts) {
  const o = Object.assign({}, opts);
  const c = state.combat;
  if (!c) return { ok: false, error: '当前没有进行中的对战' };
  const A = p(state, c.attacker), D = p(state, c.defender);
  const first = c.stage === 'pre';
  if (!first && c.stage !== 'roll_defender') return { ok: false, error: '当前不是掷骰阶段' };
  const roller = first ? A : D;
  const other = first ? D : A;
  if (roller.id !== pl.id) return { ok: false, error: first ? '由发起方先掷骰' : '现在应由应战方掷骰' };

  // ① 出牌阶段（掷骰·前）—— 阶段主优先的优先权循环
  if (!o.before) {
    const signal = {};
    const r = fireTiming(state, 'roll', 'before', {
      subjectId: roller.id, counterId: other.id, combat: c, signal: signal,
      order: [roller.id, other.id],          // 阶段主优先：先攻阶段先攻先被问、后攻阶段后攻先被问
      resume: () => {
        if (signal.chainLength > 0) doRoll(state, pl, {});        // 有人发动过 → 收势后回到阶段主再问一轮
        else doRoll(state, pl, { before: true });                 // 一轮谁都没发动 → 推进到投骰
      },
    });
    if (r.opened) return { ok: true, paused: true, timing: 'roll.before' };
    o.before = true;   // 零响应直通 = 双方本就无可发动，直接推进
  }

  // ② 真正掷骰（只做一次）
  if (!o.rolled) {
    if (first && !c.equipBonus) {
      // 装备结算只做一次；**费用已经在"对战·可选发动"时点由玩家付过了**（不再自动扣费）
      c.equipBonus = {};
      c.equipBonus[A.id] = activateCombatEquips(state, A, c);
      c.equipBonus[D.id] = activateCombatEquips(state, D, c);
      // 同行者里带法力消耗的对战效果也在这一刻扣费
      c.compPaid = {};
      c.compPaid[A.id] = activateCombatCompanions(state, A);
      c.compPaid[D.id] = activateCombatCompanions(state, D);
    }
    c.dice[roller.id] = d6(state);
    log(state, 'roll', `【${first ? '先攻' : '应战'}】${roller.name} 掷出 ${c.dice[roller.id]} 点。`,
      { scope: 'combat', side: first ? 'attacker' : 'defender', player: roller.id, value: c.dice[roller.id] });
    if (first) c.stage = 'roll_defender';
    o.rolled = true;
  }

  // ③ 掷骰·后
  if (!o.after) {
    const tail = () => { if (!first) resolveCombat(state, c); };   // 攻方投完还要等应战方
    const r2 = fireTiming(state, 'roll', 'after', {
      subjectId: roller.id, counterId: other.id, combat: c,
      resume: tail,
    });
    if (r2.opened) return { ok: true, paused: true, timing: 'roll.after' };
  }

  // ④ 收尾
  if (first) return { ok: true };
  resolveCombat(state, c);
  return { ok: true };
}

/**
 * 平局窗口 —— 也是**锁链**（和结果窗口同一套）。
 * 双方各可打出「改变战力结果」的牌（`when:'tie'` 或平局类 op），后进链的先结算；
 * 全部表态完再重算战力：还是平 → 本场以平局收场（双方无损失）；分出胜负 → 走结果窗口。
 */
function openTieWindow(state, c, total) {
  c.stage = 'tie';
  log(state, 'tie', `双方最终战力持平（${total} 点）——对战平局！双方各可使用一张「对战获胜／平局／失败」类卡牌改变结果。`);
  const role = {};
  role[c.attacker] = 'tie';
  role[c.defender] = 'tie';
  const after = () => afterTieWindow(state, c);
  const r = fireTiming(state, 'combatResult', 'tie', {
    combat: c, handOnly: true, resultRole: role,
    order: [c.attacker, c.defender],
    resume: after,
  });
  if (!r.opened) after();
}

/** 平局窗口关掉之后：重算战力并决定去向 */
function afterTieWindow(state, c) {
  if (!state.combat || state.combat !== c || c.stage !== 'tie') return;
  const A = p(state, c.attacker), D = p(state, c.defender);
  c.stage = 'pre';                     // 临时复位，避免重算时又被当成平局阶段
  // 平局里打出的牌可能改了骰点（【颠倒五行阵】强制重掷等）—— 这里补一次
  for (const pl of [A, D]) {
    if (c.forceReroll && c.forceReroll[pl.id]) {
      const r2 = d6(state);
      log(state, 'roll', `${pl.name} 被迫重掷：${c.dice[pl.id]} → ${r2}（必须接受）。`,
        { scope: 'combat', side: pl.id === c.attacker ? 'attacker' : 'defender', player: pl.id, value: r2, forced: true });
      c.dice[pl.id] = r2;
    }
  }
  const fa = finalOf(state, c, A.id), fd = finalOf(state, c, D.id);
  if (fa.total === fd.total) {
    // 视频只规定「视为对战平局，双方各可用一张改变结果的卡牌」，并未提及扣血。
    // 早期版本自创了「双方各受 1 点反噬」，但平手率本就高达 35~50%，会导致滚雪球式放血
    // （实测 4 轮内 3 人出局）。改为平局双方均无损失，更贴合原版。
    log(state, 'tie', `双方仍持平（${fa.total} 点）——本场对战以平局收场，双方均无损失。`);
    // ⚠️ **平局也算"对战结束"**：走一遍与胜负路径相同的收尾 —— 【凌玉灵】卡文是
    //    「对战结束后，不论输赢，额外恢复1点法力值」，原来这里直接清掉 combat 就返回，
    //    于是平局时这条效果永远不触发（平局率 35~50%，白丢法力）。2026-10-05 补上。
    applyAfterCombatMana(state, [A, D]);
    c.stage = 'done';
    state.combat = null;
    checkLastStanding(state);
    return;
  }
  log(state, 'info', `平局被改写：${A.name} ${fa.total} 点，${D.name} ${fd.total} 点。`);
  openResultWindows(state, c, fa.total > fd.total ? A : D, fa.total > fd.total ? D : A);
}

function finalOf(state, c, id) {
  const pl = p(state, id);
  const comp = companionCombat(state, pl, c);
  const eq = (c.equipBonus && c.equipBonus[id]) || { bonus: 0, diceBonus: 0 };
  const raw = (c.dice && c.dice[id]) || 0;
  const extraDice = ((c.diceBonus && c.diceBonus[id]) || 0) + comp.diceBonus + (eq.diceBonus || 0);
  // 对方压制：骰点 -N（最低 1）—— 实物【寒冰珠】
  const penalty = (c.dicePenalty && c.dicePenalty[id]) || 0;
  // 放弃掷骰：骰子不计入（改用固定加成）—— 实物【金光砖符】
  const skip = c.skipDice && c.skipDice[id];
  const pip = skip ? 0 : Math.max(1, Math.min(6, raw + extraDice) - penalty);
  // 战力固定（不可被增减）—— 实物【金光砖符】【敛气术】
  const flat = c.flatPower && c.flatPower[id];
  if (typeof flat === 'number') {
    return { base: baseCombat(pl), pip: pip, raw: raw, diceBonus: 0, gearBonus: 0, cardBonus: 0,
      extra: 0, total: flat, flat: true };
  }
  const cardBonus = (c.bonus && c.bonus[id]) || 0;
  const cardDebuff = (c.debuff && c.debuff[id]) || 0;
  // ⭐ 实物【南陇侯】："当你成为被对战目标时（＝你是后攻），若**你的骰子点数大于对方**，
  //    可无视对方所有【装备类宝物牌】" —— 只清对方**装备**那部分加成（同行者加成不受影响），
  //    判据用原始骰点（`c.dice`），与卡文的"骰子点数"一致。
  const foeId0 = (c.attacker === id) ? c.defender : ((c.defender === id) ? c.attacker : null);
  const foeIgnoresMyGears = (function () {
    if (!foeId0 || c.defender !== foeId0) return false;         // 只有"被指定为目标"那方才拥有这个能力
    const foeP = p(state, foeId0);
    if (!foeP || !standingHas(foeP, 'ignore_enemy_equips')) return false;
    return (((c.dice && c.dice[foeId0]) || 0) > ((c.dice && c.dice[id]) || 0));
  })();
  const gearBonus = (foeIgnoresMyGears ? 0 : (eq.bonus || 0)) + comp.bonus;
  const extra = diceToBonus(pip) + gearBonus + cardBonus - cardDebuff;
  const total = Math.max(0, baseCombat(pl) + extra);
  return { base: baseCombat(pl), pip: pip, raw: raw, diceBonus: diceToBonus(pip),
    gearBonus: gearBonus, cardBonus: cardBonus - cardDebuff, extra: extra, total: total };
}

function resolveCombat(state, c) {
  const A = p(state, c.attacker), D = p(state, c.defender);
  // 骰子已由 doRoll 的两段式掷完（攻方先、应战方后），这里只做结算。
  // 先处理「掷骰后可额外投掷一次、取点数最大值」类效果（如青元剑诀筑基档）。
  for (const pl of [A, D]) {
    const eb = c.equipBonus && c.equipBonus[pl.id];
    const compR = companionCombat(state, pl, c).rerollDice || 0;   // 同行者的重掷（【银月】）
    let n = (eb ? (eb.rerollDice || 0) : 0) + compR;
    while (n-- > 0) {
      const r2 = d6(state);
      if (r2 > (c.dice[pl.id] || 0)) {
        log(state, 'roll', `${pl.name} 重掷取得更大点数：${c.dice[pl.id]} → ${r2}。`,
          { scope: 'combat', side: pl.id === c.attacker ? 'attacker' : 'defender', player: pl.id, value: r2, reroll: true });
        c.dice[pl.id] = r2;
      } else {
        log(state, 'info', `${pl.name} 重掷得 ${r2} 点，不及原点数，维持不变。`);
      }
    }
  }
  // 强制对方重掷并接受新结果 —— 实物【颠倒五行阵】
  for (const pl of [A, D]) {
    if (c.forceReroll && c.forceReroll[pl.id]) {
      const r2 = d6(state);
      log(state, 'roll', `${pl.name} 被迫重掷：${c.dice[pl.id]} → ${r2}（必须接受）。`,
        { scope: 'combat', side: pl.id === c.attacker ? 'attacker' : 'defender', player: pl.id, value: r2, forced: true });
      c.dice[pl.id] = r2;
    }
  }
  const fa = finalOf(state, c, A.id), fd = finalOf(state, c, D.id);
  c.total[A.id] = fa.total; c.total[D.id] = fd.total;
  // 【南陇侯】播报（判据同上：后攻 + 骰点压制）—— 只在结算这一刻说一次
  if (D && standingHas(D, 'ignore_enemy_equips') && ((c.dice && c.dice[D.id]) || 0) > ((c.dice && c.dice[A.id]) || 0)) {
    log(state, 'info', `${D.name} 的【南陇侯】效果发动：骰点压制在先，${A.name} 的全部【装备类宝物牌】本场不生效。`, { player: D.id });
  }
  // ⭐ 实物【大庚剑阵】："若点数为6，将本次对战结果**直接视为获胜**" —— 不比较战力，直接开结果窗口。
  if (c.forcedWin && p(state, c.forcedWin)) {
    const w = p(state, c.forcedWin);
    const l = w.id === A.id ? D : A;
    log(state, 'combat_total', `【大庚剑阵】改判：${w.name} 的本次对战结果**直接视为获胜**（不比较战力）。`);
    return openResultWindows(state, c, w, l);
  }
  const fmt = (f) => `基础 ${f.base} + 骰点附加 ${f.diceBonus}`
    + (f.gearBonus ? ` + 装备/同行者 ${f.gearBonus}` : '')
    + (f.cardBonus ? ` + 卡牌修正 ${f.cardBonus}` : '')
    + ` = ${f.total}`;
  log(state, 'combat_total', `【结算】${A.name}：${fmt(fa)}；${D.name}：${fmt(fd)}`,
    { a: { id: A.id, total: fa.total, base: fa.base, dice: fa.diceBonus, gear: fa.gearBonus, card: fa.cardBonus },
      d: { id: D.id, total: fd.total, base: fd.base, dice: fd.diceBonus, gear: fd.gearBonus, card: fd.cardBonus } });
  if (fa.total === fd.total) {
    openTieWindow(state, c, fa.total);
    return;
  }
  const winner = fa.total > fd.total ? A : D;
  const loser = fa.total > fd.total ? D : A;
  // 战果已定 → 先开**结果窗口**：赢家在「获胜窗口」、输家在「失败窗口」各有一次出牌机会。
  // 这样「在对战获胜时使用」的牌（【风云幡】【火弹术】）不用再提前押注，
  // 「在对战失败时使用」的牌（【踏云靴】【透明丝线】【风雷翅】）也是真的输了再打。
  openResultWindows(state, c, winner, loser);
}

/**
 * 进入结果窗口。顺序：先赢家的「获胜窗口」，再输家的「失败窗口」。
 * 某一方没有可打的牌就自动跳过。两边都没有就直接结算。
 */
/**
 * 结果窗口（战果已定）—— **锁链**。
 *   赢家先有机会打「对战获胜时」的牌，**输家可以响应**（打「对战失败时」的牌），
 *   后进链的先结算；双方都表态完才真正结算战果。
 * 典型用法：赢家打【火弹术】（抽你 2 张宝物牌）→ 输家响应【踏云靴】（免罚）。
 *
 * ⚠️ 场上的 win/lose 效果（【绿煌剑】【风雷翅】）**不进链** —— 它们是自动触发的，
 *   由 runOnWinEffects / settleCombat 负责（`handOnly` 保证不会摆出来问）。
 */
function openResultWindows(state, c, winner, loser) {
  c.winnerId = winner.id;
  c.loserId = loser.id;
  c.stage = 'result';
  log(state, 'info', `【对战结果】${winner.name} 战胜 ${loser.name} —— 双方可结算「获胜时 / 失败时」的牌（或跳过）。`,
    { winner: winner.id, loser: loser.id });
  const resultRole = {};
  resultRole[winner.id] = 'win';
  resultRole[loser.id] = 'lose';
  const r = fireTiming(state, 'combatResult', null, {
    combat: c, handOnly: true,
    resultRole: resultRole,
    order: [winner.id, loser.id],       // 赢家先表态，输家后响应
    winnerId: winner.id, loserId: loser.id,
    resume: () => settleCombat(state, c, p(state, c.winnerId), p(state, c.loserId)),
  });
  // 没人能打（或已经挂起等表态）—— 没挂起就直接结算
  if (!r.opened) settleCombat(state, c, winner, loser);
}

// ---------------------------------------------------------------- 主动技能
//
// 场面上的牌可以自带一个"主动使用"的能力（effects 里 when === 'activate'）：
//   【梅凝】自己的回合使用 → 恢复1点生命 + 抽3张宝物牌，之后自身进弃牌堆
// （【青易居士】不再是主动技能、也不再是特殊按钮：它的"探索改抽"是「探索阶段」时点的
//   替换型效果，走斗法窗口，收势时登记、基础行动最后结算 —— 见 doDrawTreasure 的阶段事务模型）
// 每张牌每回合最多发动一次（pl.activateUsed 记账，回合开始清空）。

/** 找出这张场上牌此刻可以发动的主动技能（含条件判定）；不可发动返回 null */
function activatable(state, pl, inst) {
  const def = cardDef(inst.id);
  if (!def) return null;
  // 「可用 N 次」用完 → 主动技能也不给用了（卡留在场上，由玩家自己决定要不要撤下）
  if (usesLeft(def, inst) <= 0) return null;
  const list = effectsOf(def, inst).filter((e) => e.when === 'activate');
  if (!list.length) return null;
  const ctx = { self: pl, state: state, inst: inst, def: def };
  const ok = list.filter((e) => {
    if (!matchConditions(e.if, ctx)) return false;
    if (e.onlyStep && state.step !== e.onlyStep) return false;
    if (e.cost && e.cost.discard) {
      const need = e.cost.discard;
      if (!pl.hand.some((c) => deckOf(c.id) === need)) return false;
    }
    return true;
  });
  if (!ok.length) return null;
  // ⭐ 这条主动技能要不要**先选目标**（【金魁】"使场上任意 1 张宝物/法术牌无效"要选场上的一张牌）
  const needEff = ok.find((e) => META.effectNeedsTarget(e)) || null;
  // ⭐ 弃牌代价（【龙纹四象蟠龙带】）：把"要弃哪一堆 + 手里有哪些可选"交给前端弹确认
  const costEff = ok.find((e) => e.cost && e.cost.discard) || null;
  const costDeck = costEff ? costEff.cost.discard : null;
  const choices = costDeck
    ? pl.hand.filter((c) => deckOf(c.id) === costDeck).map((c) => ({ uid: c.uid, id: c.id, name: (cardDef(c.id) || {}).name }))
    : [];
  return {
    def: def, inst: inst, effects: ok, discardSelf: !!def.activateDiscardSelf,
    needsTarget: !!needEff, targetKind: needEff ? META.effectTargetKind(needEff) : null,
    costDiscard: costDeck, discardChoices: choices,
  };
}

/** 列出该玩家此刻所有可发动的主动技能（给前端画按钮用） */
function activatables(state, pl) {
  const out = [];
  pl.activateUsed = pl.activateUsed || {};
  for (const inst of pl.companions.concat(allEquips(pl))) {
    if (pl.activateUsed[inst.uid]) continue;
    const a = activatable(state, pl, inst);
    if (a) out.push({
      uid: inst.uid, cardId: inst.id, name: a.def.name, discardSelf: a.discardSelf,
      needsTarget: a.needsTarget, targetKind: a.targetKind,
      // ⭐ 弃牌代价（【龙纹四象蟠龙带】"将任意 1 张【宝物牌】放入弃牌堆"）：
      //    下发"要弃哪一堆 + 手里有几张可选"，前端据此弹**醒目确认 + 自己挑**
      costDiscard: a.costDiscard, discardChoices: a.discardChoices,
      effects: a.effects.map((e) => ({ op: e.op, when: e.when, value: e.value, deck: e.deck, label: e.label })),
    });
  }
  return out;
}

/** 发动一个主动技能 */
function doActivate(state, pl, a) {
  if (state.players[state.turn].id !== pl.id) return { ok: false, error: '只有自己的回合才能主动使用' };
  if (state.step === 'lobby') return { ok: false, error: '游戏还没开始' };
  if (state.combat) return { ok: false, error: '对战结算中不能使用主动技能' };
  const uid = Number(a.uid);
  const inst = pl.companions.concat(allEquips(pl)).find((x) => Number(x.uid) === uid);
  if (!inst) return { ok: false, error: '你场上没有这张牌' };
  pl.activateUsed = pl.activateUsed || {};
  if (pl.activateUsed[inst.uid]) return { ok: false, error: '这张牌本回合已经发动过了' };
  const act = activatable(state, pl, inst);
  if (!act) return { ok: false, error: '这张牌现在不能发动主动技能（阶段或条件不满足）' };

  // ⭐ 主动技能也能**先选目标**（【金魁】"使场上任意 1 张宝物/法术牌无效"）——
  //    缺目标直接拒（免得白扣次数、白弃牌）。
  const needEff = act.effects.find((e) => META.effectNeedsTarget(e)) || null;
  const needKind = needEff ? META.effectTargetKind(needEff) : null;
  if (needKind === 'board') {
    if (a.targetUid == null || a.targetUid === '') return { ok: false, error: `发动【${act.def.name}】需要先指定场上的一张牌` };
    if (!findBoardInst(state, a.targetUid)) return { ok: false, error: '指定的那张牌不在场上' };
  } else if (needKind === 'player') {
    if (a.target == null || a.target === '') return { ok: false, error: `发动【${act.def.name}】需要先指定一位目标` };
    const tp = p(state, String(a.target));
    if (!tp || tp.out) return { ok: false, error: '指定的目标无效（不存在或已出局）' };
  }

  // 先付代价：弃牌代价
  // ⭐ 2026-10-05 第 10 件（②c 舍弃类效果醒目确认）：卡文写「将**任意 1 张**【宝物牌】放入弃牌堆」，
  //    所以允许前端把"玩家挑的那一张"传进来（`a.discardUid`）；不传就沿用旧行为（挑第一张符合的），
  //    老调用方（命令行 / 自测 / 老前端）行为完全不变。
  for (const e of act.effects) {
    if (!e.cost || !e.cost.discard) continue;
    const need = e.cost.discard;
    const wantUid = (a.discardUid != null && a.discardUid !== '')
      ? (typeof a.discardUid === 'string' && /^\d+$/.test(a.discardUid) ? Number(a.discardUid) : a.discardUid)
      : null;
    let i = -1;
    if (wantUid != null) {
      i = pl.hand.findIndex((c) => Number(c.uid) === Number(wantUid) && deckOf(c.id) === need);
      if (i < 0) return { ok: false, error: `你手里没有这张${deckLabel(need)}（或牌堆不对），无法作为弃置代价` };
    } else {
      i = pl.hand.findIndex((c) => deckOf(c.id) === need);
    }
    if (i < 0) return { ok: false, error: `发动【${act.def.name}】需要先弃置 1 张${deckLabel(need)}` };
    const gone = pl.hand.splice(i, 1)[0];
    toDiscard(state, need, gone.id);
    log(state, 'discard', `${pl.name} 为发动【${act.def.name}】弃置了【${(cardDef(gone.id) || {}).name}】（${deckLabel(need)} → 弃牌堆）。`);
  }
  pl.activateUsed[inst.uid] = true;
  log(state, 'play', `${pl.name} 主动使用了【${act.def.name}】的能力。`, { player: pl.id, card: act.def.id, activate: true });
  // 「可用 N 次」：主动发动同样要扣次数（用完不再能发动，见 activatable() 的过滤）
  if (act.def.uses) {
    markUse(pl, act.def, inst);
    log(state, 'info', `【${act.def.name}】用掉 1 次，还剩 ${usesLeft(act.def, inst)} 次。`, { player: pl.id, card: act.def.id });
  }
  for (const e of act.effects) {
    resolveEffect(state, pl, e, {
      state: state, deck: e.deck,
      // ⭐ 主动技能选的目标（【金魁】的 `targetUid` = 场上那张牌）
      target: (a.target != null && a.target !== '') ? String(a.target) : null,
      targetUid: (a.targetUid != null && a.targetUid !== '') ? a.targetUid : null,
      targetPl: (a.target != null && a.target !== '') ? p(state, String(a.target)) : null,
    }, { source: 'companion', def: act.def, inst: inst });
  }
  if (act.discardSelf) {
    for (const arr of [pl.companions, pl.equip, pl.spells]) {
      const i = arr.findIndex((x) => Number(x.uid) === uid);
      if (i >= 0) {
        arr.splice(i, 1);
        const d = deckOf(inst.id);
        if (d) toDiscard(state, d, inst.id);
        log(state, 'companion_down', `【${act.def.name}】用后离场，放入弃牌堆。`);
        break;
      }
    }
  }
  return { ok: true };
}

/**
 * 「使用任意 1 次【补气丹】/【回气丹】时，可选择使效果翻倍，之后此同行者放入弃牌堆」
 * —— 实物【陈巧倩】。
 *
 * 卡文写「可选择」，引擎实现为**自动生效**：既然玩家已经在用那颗丹药，就没有理由不翻倍，
 * 唯一差别是没法"留着以后用"。若将来要做真正的二选一，需要走交互层（见规则文档 §14.5）。
 *
 * 找到就返回那个同行者（调用方负责再结算一次效果并弃置它）。
 */
function doubleEffectSource(pl, cardName) {
  if (!cardName) return null;
  for (const x of collectEffects(pl, null, { self: pl })) {
    if (x.eff.op !== 'double_card_effect') continue;
    const names = x.eff.names || [];
    if (names.indexOf(cardName) >= 0) return x;
  }
  return null;
}

/** 主动发动：把这张牌再结算一遍（等价于"效果翻倍"），然后源同行者离场 */
function applyDoubleEffect(state, pl, x, eff, ctx) {
  log(state, 'info', `同行者【${x.def.name}】发动：本次【${eff.name || '效果'}】翻倍结算。`);
  resolveEffect(state, pl, eff, ctx, { source: 'companion', def: x.def, inst: x.inst });
  for (const arr of [pl.companions, pl.equip, pl.spells]) {
    const i = arr.findIndex((y) => Number(y.uid) === Number(x.inst.uid));
    if (i < 0) continue;
    arr.splice(i, 1);
    const d = deckOf(x.inst.id);
    if (d) toDiscard(state, d, x.inst.id);
    log(state, 'companion_down', `同行者【${x.def.name}】用后离场，放入弃牌堆。`);
    break;
  }
}

/** 结果窗口里"跳过"（保留给旧调用点；新流程走 respond_pass） */
function doResultPass(state, pl) { return respondPass(state, pl); }

function settleCombat(state, c, win, lose) {
  const sameRealm = win.realm === lose.realm;
  // 先结算败方**场上**的「对战失败时」效果（填充 loseSave 等），再读免罚 ——
  // 结果窗口的锁链只认手牌（handOnly），场上 lose 效果没有别的通道，
  // 不在此处自动结算的话【风雷翅】装进储物袋就永远是白板（E5 回归）。
  runOnLoseEffects(state, c, win, lose);
  // 失败时掷骰免罚 —— 实物【风雷翅】
  let diceSaved = false;
  if (c.loseSave && c.loseSave[lose.id]) {
    const sv = c.loseSave[lose.id];
    const roll = d6(state);
    sv.rolled = roll;
    sv.ok = (sv.faces || []).indexOf(roll) >= 0;
    diceSaved = sv.ok;
    log(state, 'roll', `${lose.name} 掷出 ${roll} 点${diceSaved ? '，触发保命之法，免于战败惩罚！' : '，未能保命。'}`,
      { player: lose.id, value: roll, scope: 'save' });
    // ⭐ 实物【罗烟步】：卡文后半句"且恢复 1 点【法力值】" —— **只在免罚成功时**回法力
    //    （这就是回合结束那条"不能无条件回法力"的要求）。
    if (diceSaved) {
      const gain = Math.max(0, Number(sv.mana) || 0);
      if (gain > 0) {
        lose.mana = Math.min(manaCap(lose), lose.mana + gain);
        log(state, 'info', `${lose.name} 的【罗烟步】身法未乱，恢复 ${gain} 点法力值（${lose.mana}）。`, { player: lose.id, mana: lose.mana });
      }
    }
  }
  const immune = diceSaved || !!(c.noPenalty && c.noPenalty[lose.id]);
  let hpLoss = 1, qiLoss = 1, steal = false, note = '';
  if (immune) {
    hpLoss = 0; qiLoss = 0; steal = false;
    note = `${lose.name} 使出战果豁免，不受本次对战失败的惩罚。`;
  } else if (sameRealm) {
    note = `同境界对战，${lose.name} 扣除 1 点生命值和 1 点灵气值。`;
  } else if (lose.realm < win.realm) {
    qiLoss = 0;
    note = `败方境界较低，仅扣除 1 点生命值（不扣除灵气值）。`;
  } else {
    qiLoss = 2; steal = true;
    note = `败方境界较高，扣除 1 点生命值和 2 点灵气值，并被对手抽取一张手牌。`;
  }
  log(state, 'combat_result', `【对战结果】${win.name} 战胜 ${lose.name}！${note}`,
    { winner: win.id, loser: lose.id, dmg: hpLoss, qi: qiLoss });
  if (hpLoss > 0) applyDamage(state, lose, hpLoss, 'combat', win.id);
  if (qiLoss > 0) spendQi(state, lose, qiLoss);
  if (steal && !lose.out && lose.hand.length > 0) {
    const i = Math.floor(nextRandom(state) * lose.hand.length);
    const got = lose.hand.splice(i, 1)[0];
    win.hand.push(got);
    log(state, 'steal', `${win.name} 从 ${lose.name} 手中抽走 1 张手牌。`, { from: lose.id, to: win.id });
  }
  // 对战获胜时触发的效果（实物：宋玉/血玉蜘蛛/韩立/三目豹/寒蛟/绿煌剑）
  // 天雷子：对手境界低时获胜追加伤害（写在本场对战数据里）
  const extraWin = (c.winBonusDamage && c.winBonusDamage[win.id]) || 0;
  if (extraWin > 0 && !lose.out) {
    log(state, 'info', `${win.name} 的效果使 ${lose.name} 额外受到伤害。`);
    applyDamage(state, lose, extraWin, 'card', win.id);
  }
  runOnWinEffects(state, c, win, lose);
  // 获胜后回法力 / 抽灵气牌（朱雀环、风云幡）
  const wm = (c.winMana && c.winMana[win.id]) || 0;
  if (wm > 0) {
    win.mana = Math.min(manaCap(win), win.mana + wm);
    log(state, 'info', `${win.name} 对战获胜，恢复 ${wm} 点法力值（${win.mana}）。`);
  }
  const wq = (c.winDrawQi && c.winDrawQi[win.id]) || 0;
  if (wq > 0) {
    const g = drawFrom(state, 'qi', wq);
    for (const q of g) gainQiCard(state, win, q);
    log(state, 'info', `${win.name} 对战获胜，抽取 ${wq} 张灵气牌。`);
  }
  // 火弹术：获胜时从对方手中抽 N 张【宝物牌】
  const wst = (c.winStealTreasure && c.winStealTreasure[win.id]) || 0;
  if (wst > 0 && !lose.out) {
    let nb = 0;
    for (let i = 0; i < wst; i++) {
      const idx = lose.hand.findIndex((x) => deckOf(x.id) === 'treasure');
      if (idx < 0) break;
      win.hand.push(lose.hand.splice(idx, 1)[0]);
      nb++;
    }
    if (nb) log(state, 'steal', `${win.name} 从 ${lose.name} 手中抽取了 ${nb} 张【宝物牌】。`, { from: lose.id, to: win.id });
    else log(state, 'info', `${lose.name} 手中已无【宝物牌】。`);
  }
  // 对战失败时反伤对方 —— 实物【透明丝线】
  const retaliate = (c.loseRetaliate && c.loseRetaliate[lose.id]) || 0;
  if (retaliate > 0 && !lose.out) {
    log(state, 'info', `${lose.name} 的反击效果发动。`);
    applyDamage(state, win, retaliate, 'card', lose.id);
  }
  // 对战失败时**自己**额外受伤 —— 实物【青火雷】
  const selfLose = (c.selfLoseDamage && c.selfLoseDamage[lose.id]) || 0;
  if (selfLose > 0 && !lose.out) {
    log(state, 'info', `${lose.name} 打出的牌反噬，额外受到 ${selfLose} 点伤害。`);
    applyDamage(state, lose, selfLose, 'card', win.id);
  }
  // 对战结束后不论输赢额外恢复法力 —— 实物【凌玉灵】
  applyAfterCombatMana(state, [win, lose]);
  c.stage = 'done';
  state.combat = null;
  checkLastStanding(state);
}

/** 「对战结束后，不论输赢，额外恢复 N 点法力值」—— 实物【凌玉灵】 */
function applyAfterCombatMana(state, players) {
  for (const pl of players) {
    if (!pl || pl.out) continue;
    const am = afterCombatMana(pl);
    if (am.value > 0) {
      pl.mana = Math.min(manaCap(pl), pl.mana + am.value);
      log(state, 'info', `${pl.name} 的同行者【${am.names.join('】【')}】效果发动：对战结束后恢复 ${am.value} 点法力值（${pl.mana}）。`);
    }
  }
}

function runOnWinEffects(state, c, win, lose) {
  const list = collectEffects(win, 'win', { self: win, foe: lose, state: state, combat: c });
  for (const x of list) {
    const e = x.eff;
    // ⚠️ **要付费**的场上获胜效果走时点窗口（结果窗口里问「花 N 点发动吗」），
    //    不能在这里白送一份 —— 否则【绿煌剑】会"又自动打一次、又在窗口里问一次"。
    //    2026-10-06 起这些卡的费用印在效果上（§7.4「费用印在效果上」），不再是开战启用费。
    if ((e.manaCost || 0) > 0) continue;
    log(state, 'info', `【${x.def.name}】的对战获胜效果生效。`);
    if (e.op === 'damage' && !lose.out) applyDamage(state, lose, e.value || 1, 'card', win.id);
    else if (e.op === 'mana') {
      const n = e.value || 1;
      win.mana = Math.min(manaCap(win), win.mana + n);
      log(state, 'info', `${win.name} 恢复 ${n} 点法力值（${win.mana}）。`);
    } else if (e.op === 'draw_qi' || e.op === 'win_draw_qi') {
      const n = e.value || 1;
      const g = drawFrom(state, 'qi', n);
      for (const q of g) gainQiCard(state, win, q);
    } else if (e.op === 'steal_equip' && !lose.out) {
      resolveEffect(state, win, { kind: 'steal_equip', value: e.value || 1, count: e.count }, { state: state, target: lose.id });
    } else if (e.op === 'discard_enemy_equip' && !lose.out) {
      const pool = lose.equip.length ? lose.equip : (lose.spells.length ? lose.spells : null);
      if (pool) {
        const gone = pool.shift();
        const deck = deckOf(gone.id);
        if (deck) toDiscard(state, deck, gone.id);
        log(state, 'steal', `${win.name} 指定 ${lose.name} 的【${(cardDef(gone.id) || {}).name}】放入弃牌堆。`, { from: lose.id, to: win.id });
        detachAttached(state, lose, gone.uid, '被一并弃置');   // 叠在它上面的牌一起走
      }
    } else if (e.op === 'block_spell_draw' || e.op === 'block_companion_draw' || e.op === 'block_treasure_draw' || e.op === 'block_draw') {
      // 参数化合族后新写法是 block_draw + deck；旧三件套只用于读旧备份
      const dk = e.op === 'block_draw' ? (e.deck || 'spell')
        : { block_spell_draw: 'spell', block_companion_draw: 'companion', block_treasure_draw: 'treasure' }[e.op];
      const field = { spell: 'blockSpellDraw', companion: 'blockCompanionDraw', treasure: 'blockTreasureDraw' }[dk];
      const deckName = { spell: '法术牌', companion: '同行者', treasure: '宝物牌' }[dk];
      lose[field] = (lose[field] || 0) + (e.value || 1);
      log(state, 'info', `${lose.name} 接下来 ${e.value || 1} 个回合不能抽取【${deckName}】。`);
    } else {
      resolveEffect(state, win, e, { state: state, combat: c, target: lose.id, targetPl: lose }, { source: 'win', def: x.def, inst: x.inst });
    }
  }
}

/**
 * 败方场上「对战失败时」的自动效果（实物【风雷翅】掷骰免罚）。
 * 镜像 runOnWinEffects：结果窗口的锁链 handOnly 把场上牌挡在询问外，
 * 所以场上的 lose 效果在 settleCombat 开头由这里自动结算（卡文没写"可选择"）。
 */
function runOnLoseEffects(state, c, win, lose) {
  if (!lose || lose.out) return;
  const list = collectEffects(lose, 'lose', { self: lose, foe: win, state: state, combat: c });
  for (const x of list) {
    // 同上：付费的失败时效果（若有）走时点窗口，不在这里白送
    if ((x.eff && x.eff.manaCost || 0) > 0) continue;
    log(state, 'info', `【${x.def.name}】的对战失败效果生效。`);
    resolveEffect(state, lose, x.eff, { state: state, combat: c, target: win.id, targetPl: win }, { source: 'lose', def: x.def, inst: x.inst });
  }
}

function checkLastStanding(state) {
  if (state.winner) return;
  const left = alive(state);
  if (left.length <= 1) {
    const last = left[0];
    state.phase = 'over';
    state.winner = last ? last.id : null;
    if (last) log(state, 'win', `${last.name} 是最后一位存活者，直接获得本局胜利！`, { player: last.id });
  }
}

/** 平局阶段"跳过"（保留给旧调用点；新流程走 respond_pass） */
function doTie(state, pl, a) {
  // 旧动作：{type:'tie', uid} 打出平局牌 / {type:'tie'} 过牌 —— 现在分别等价于 respond_play / respond_pass
  if (a && a.uid) return respondPlay(state, pl, a.uid);
  return respondPass(state, pl);
}

// ---------------------------------------------------------------- 视图

/**
 * 战报下发（每个玩家一份视图）。
 *
 * ⚠️ **暗抽要打码**：用户实盘报过"游戏日志能看到对手抽到的牌，变成明牌打了"。
 * 手牌本来就是隐藏信息（`publicState` 里别人的 `hand` 是 undefined），
 * 但战报文本里直接写了"XX 从宝物牌堆抽到【青蛟旗】"，等于把对手手牌全摊开。
 * 规则：`kind === 'draw'` 且带 `card` 的条目 —— 自己抽的照原样；别人的换成"暗抽了 1 张"，
 * 并把 payload 里的 card 抹掉（前端别拿它去播动画/展示）。
 * **灵气牌例外**：灵气牌是公开信息（面板上人人可见），照原样。
 *
 * ⚠️ **时点日志也要打码**（用户 2026-10-02 报的第二个同类泄漏）：
 * `fireTiming` 那条"〔时点〕「XX」有牌可响应：甲·【牌名】"里，牌名可能来自**别人的手牌**
 * （`manaRegen` / `drawQi` / `drawTreasure` / `drawSpell` / `promote` / `chooseTarget` 这 6 个
 * 时点没接询问层，走的就是这条日志）。于是"对方抽牌时"我一刷战报就知道他手里有什么牌。
 * 规则：只有 `where === 'hand'` **且不是自己**的候选要遮 —— 整条滤掉（连"他有牌能响应"这件事也不露）；
 * 场上的候选（`where === 'board'`）是公开信息（牌就摆在桌上），照原样。
 */
function publicLog(state, forId) {
  const nameOf = (id) => (p(state, id) || {}).name || '某位修士';
  return state.log.slice(-80).map((l) => {
    if (!l) return null;
    const q = l.payload || {};

    // ---- 暗抽打码 ----
    if (l.kind === 'draw') {
      if (!q.card) return l;                       // 本来就是模糊的（"抽取 N 张"）
      if (q.deck === 'qi') return l;               // 灵气牌公开
      if (q.player === forId) return l;            // 自己抽的自己看得见
      const dk = q.deck ? deckLabel(q.deck) : '';
      return Object.assign({}, l, {
        text: `${nameOf(q.player)} 暗抽了 1 张${dk ? '【' + dk + '】' : ''}。`,
        payload: Object.assign({}, q, { card: null, hidden: true }),
      });
    }

    // ---- 时点日志里的手牌打码 ----
    if (l.kind === 'timing' && Array.isArray(q.responders)) {
      const shown = q.responders.filter((r) => r.where !== 'hand' || r.player === forId);
      if (!shown.length) return null;              // 只剩别人的手牌候选 → 整条不给他看
      if (shown.length === q.responders.length) return l;   // 没有要遮的，原样
      const label = META.timingLabel({ event: q.timing, subject: null, phase: q.phase || null });
      const who = shown.map((r) => `${nameOf(r.player)}·【${r.card}】`).join('、');
      return Object.assign({}, l, {
        text: `〔斗法〕「${label}」有牌可破招：${who}。（该时点暂未接入询问层）`,
        payload: Object.assign({}, q, { responders: shown, masked: true }),
      });
    }

    return l;
  }).filter(Boolean);
}

function publicState(state, forId) {
  return {
    id: state.id,
    phase: state.phase,
    step: state.step,
    turn: state.players[state.turn] ? state.players[state.turn].id : null,
    round: state.round,
    winner: state.winner,
    decks: {
      treasure: { draw: state.decks.treasure.draw.length, discard: state.decks.treasure.discard.length },
      spell: { draw: state.decks.spell.draw.length, discard: state.decks.spell.discard.length },
      companion: { draw: state.decks.companion.draw.length, discard: state.decks.companion.discard.length },
      qi: { draw: state.decks.qi.draw.length, discard: state.decks.qi.discard.length },
    },
    combat: state.combat,
    turnFlags: state.turnFlags,
    rules: {
      handLimits: HAND_LIMITS,
      diceTable: '骰点 1 → +0；2~5 → +1；6 → +2',
      promoteConsume: PROMOTE_CONSUME,
      promoteDice: PROMOTE_DICE,
      manaRegen: MANA_REGEN,
      hpMax: HP_MAX,
      manaMax: MANA_MAX,
      manaMaxMortal: MANA_MAX_MORTAL,
      // 2026-10-05 用户裁定：装备付费只看卡文，不再分高低境界（旧的 equipTierRule / 分档线下发已废）
      equipRule: '装备类法宝：卡文写「装备时不消耗法力值」的，装备免费、发动其效果才消耗；没写的，装备时消耗、发动效果不再消耗',
    },
    players: state.players.map((x) => ({
      id: x.id, name: x.name, seat: x.seat, host: x.host, connected: x.connected,
      realm: x.realm, realmName: REALMS[x.realm], hp: x.hp, hpMax: HP_MAX,
      mana: x.mana, manaCap: manaCap(x),
      qi: qiOf(x),
      root: x.root, rootName: ROOTS[x.root].name, rootCosts: ROOTS[x.root].costs,
      nextCost: x.realm < 4 ? ROOTS[x.root].costs[x.realm] : null,
      // ⚠️ 传给前端的两个数必须**把一次性折扣也算进去**（娑罗珠/九曲灵参/九曲灵参丹），
      // 否则玩家打完折扣卡界面纹丝不动，而且前端的"晋升"按钮是拿 nextThreshold 当开关的，
      // 漏算会让按钮白白置灰、点不下去。
      nextThreshold: x.realm < 4
        ? Math.max(0, ROOTS[x.root].costs[x.realm] - promoteDiscount(x) - calcPromoteDiscount(state, x, x.realm + 1, false, 'threshold'))
        : null,
      nextConsume: x.realm < 4
        ? Math.max(0, PROMOTE_CONSUME[x.realm] - promoteConsumeDiscount(x) - calcPromoteDiscount(state, x, x.realm + 1, false, 'consume'))
        : null,
      nextConsumeBase: x.realm < 4 ? PROMOTE_CONSUME[x.realm] : null,
      nextDice: x.realm < 4 ? PROMOTE_DICE[x.realm] : null,
      baseCombat: baseCombat(x),
      equip: x.equip, spells: x.spells, companions: x.companions, puppets: x.puppets || [],
      // ⭐ 实物卡补充批的两条"状态展示"：前端据此把不可选的对战目标置灰、把灵气封锁标出来
      noTarget: !!x.noTarget,              // 【隐灵纱】【神风舟】"到自己的下回合开始前无法被指定为对战目标"
      blockQiDraw: x.blockQiDraw || 0,     // 【拘灵阵】"本回合无法抽取【灵气牌】"
      handCount: x.hand.length,
      handCounts: x.hand.reduce((m, c) => { const d = deckOf(c.id); m[d] = (m[d] || 0) + 1; return m; }, { treasure: 0, spell: 0, companion: 0 }),
      // ⚠️ 这里是**这位玩家此刻真正的上限**，不是牌面基础值 —— 必须把 hand_limit_bonus
      //    （【噬金虫】"手中最多保存 7 张宝物牌"）算进去，否则界面会显示成"宝物 7/6"并标红
      //    提示"回合结束时会被弃置"，而引擎其实一张都不会弃（真上限是 7）——
      //    玩家看到的就是"超上限结束回合却无事发生"。
      handLimits: effectiveHandLimits(x),
      handLimitBonus: handLimitBonus(x),
      handLimit: effectiveHandLimits(x).treasure,
      hand: x.id === forId ? x.hand : undefined,
      out: x.out, shield: x.shield,
      inSeclusion: x.inSeclusion, seclusionUsed: x.seclusionUsed,
      seclusionMax: x.seclusionMax || 1,
      canSeclude: (x.seclusionUsed || 0) < (x.seclusionMax || 1),
      // 「第一个回合不能发起对战」——前端据此把按钮置灰并给出理由
      turnsTaken: x.turnsTaken || 0,
      canCombat: (x.turnsTaken || 0) > 1,
      // 封锁状态（前端画「本回合被禁制/被封锁」用）—— 【血咒禁制】禁抽宝物牌+禁对战、【寒蛟】禁抽法术/同行者
      blocks: {
        treasure: x.blockTreasureDraw || 0,
        spell: x.blockSpellDraw || 0,
        companion: x.blockCompanionDraw || 0,
        combat: x.blockCombat || 0,
      },
      curse: x.curse || null,
      skipTurns: x.skip || 0,
      slots: { equip: equipSlots(x), spell: spellSlots(x), companion: companionSlots(x) },
      companionUsedSlots: companionUsedSlots(x),
      // 主动技能：只给"自己"看（传给前端画按钮）
      activatables: x.id === forId ? activatables(state, x) : undefined,
      // 本回合已经发动过的「一回合一次」的牌（uid 列表）—— 前端在牌上打"本回合已发动"角标。
      // 只给本人看（别人不需要知道，也不该据此推测）。
      turnUsedUids: x.id === forId ? Object.keys((state.turnUses && state.turnUses[x.id]) || {}) : undefined,
      // （已删）exploreSwap：【青易居士】不再是特殊按钮，它走「探索阶段」时点的斗法窗口
    })),
    log: publicLog(state, forId),
    // 回合结束的「手牌超上限，请自行弃置」状态（用户裁定：自己挑弃哪些牌）。
    // 开着的时候引擎只接受 discard，所以前端要把画面切成"弃置模式"并挡住其它按钮。
    forceDiscard: state.forceDiscard ? {
      playerId: state.forceDiscard.playerId,
      name: (p(state, state.forceDiscard.playerId) || {}).name || null,
      need: state.forceDiscard.need,
      over: state.forceDiscard.over,
      limits: state.forceDiscard.limits,
    } : null,
    // 打断窗口（时点询问）。只在真的开着的时候下发，平时是 null。
    pending: state.pending ? (function () {
      const pd = state.pending;
      const actor = pendingActor(state);
      return {
        event: pd.event,
        phase: pd.phase || null,
        // 弹窗标题：**运行时**名字（先攻/后攻出牌阶段）—— 只有引擎知道"投骰的这个人是不是先攻"，
        // 数据里那一格（`roll`·我方·前）分不出先攻后攻，所以这里带上 attacker 标志。
        label: (function () {
          const c = state.combat || null;
          const subjId = pd.subjectId || pd.ctx && pd.ctx.subjectId || null;
          const atk = (c && pd.event === 'roll' && subjId) ? (subjId === c.attacker) : null;
          return META.timingLabelIn({ event: pd.event, subject: (pd.ctx && pd.ctx.subject) || null, phase: pd.phase || null },
            { attacker: atk });
        })(),
        actorId: actor ? actor.id : null,
        actorName: actor ? actor.name : null,
        queue: pd.queue.slice(),
        chain: pd.chain.map((x) => ({ player: x.pid, name: (cardDef(x.defId) || {}).name, where: x.where })),
        // 只给"当事人"看他能出什么牌；其他人看不到
        mine: (actor && actor.id === forId)
          ? pendingCards(state, actor).map((c) => ({
            uid: c.uid, id: c.id, name: c.name, deck: c.deck, where: c.where, cost: c.cost,
            // 「二选一」类卡会展开成多条候选：tier = 要打的那一档，option = 选项文案
            tier: c.tier, option: c.option,
            // ⭐ 这条候选要先选目标（【青冥针】选人 /【金魁】选场上的牌）—— 前端据此弹选择器
            needsTarget: c.needsTarget, targetKind: c.targetKind,
          }))
          : undefined,
        amActor: !!(actor && actor.id === forId),
        // 询问上下文（不要漏玩家手牌等隐私）
        about: {
          // 第 3 轮：受伤窗口前置 → 报**待落地**的伤害值（响应改过之后就是它）
          damage: (pd.ctx.pending ? pd.ctx.pending.value : pd.ctx.damage) || null,
          pending: !!pd.ctx.pending,
          lethal: !!pd.ctx.lethal,
          // 「受伤」时点：谁是**受伤的那个**（`subjectId`）。前端要靠它把"你受到"和"XX 受到"分开，
          // 否则别人掉血时你也会看到"你刚刚受到 1 点伤害"（用户实盘报过）。
          subjectId: pd.subjectId || pd.ctx.subjectId || null,
          subjectName: (function () {
            const sid = pd.subjectId || pd.ctx.subjectId;
            return sid ? ((p(state, sid) || {}).name || null) : null;
          })(),
          cardName: pd.ctx.cardName || null,
          reason: pd.ctx.reason || null,
          attacker: pd.ctx.attacker || null,
          defender: pd.ctx.defender || null,
        },
      };
    })() : null,
  };
}

/**
 * 「行动 / 抽取阶段挂机」的兜底（**看门狗用**，服务端拿到后自己 act()）：
 * 以前只有对战/打断窗口有超时，**行动阶段挂机 → 全桌永久卡死**（交接 §5.2 的老欠账）。
 * 纯函数、不改状态；返回 `{ pid, action }` 或 null（null = 当前没什么可自动推进的）。
 *
 * 动作里带 `auto: '<在做什么>'`，引擎会在战报里写「〔超时〕XX 长时间没有动作，系统自动…」。
 */
function autoIdleAction(state) {
  if (!state || state.phase !== 'playing') return null;
  if (state.pending || state.combat) return null;          // 有窗口/对战 → 各自的看门狗管
  if (state.forceDiscard) return null;                     // 等他自己挑弃哪些牌（超时不替他挑）
  const pl = state.players[state.turn];
  if (!pl || pl.out) return null;
  switch (state.step) {
    case 'draw_qi': return { pid: pl.id, action: { type: 'draw_qi', auto: '抽取 1 张【灵气牌】' } };
    case 'draw_treasure': return { pid: pl.id, action: { type: 'draw_treasure', auto: '在探索阶段抽宝物牌' } };
    case 'choose_draw': return { pid: pl.id, action: { type: 'choose_draw', deck: 'spell', auto: '在抉择阶段抽 1 张【法术牌】' } };
    case 'action': return { pid: pl.id, action: { type: 'end_turn', auto: '结束回合' } };
    default: return null;
  }
}

module.exports = {
  REALMS, ROOTS, ROOT_DECK, PROMOTE_CONSUME, PROMOTE_DICE, HAND_LIMITS,
  createGame, beginGame, act, publicState, fullState: publicState,
  // 「行动阶段挂机」的兜底候选（服务端看门狗用，见 server/index.js 的 armWatchdog）
  autoIdleAction,
  cardDef, deckOf, timingOf, passives, baseCombat, diceToBonus,
  finalOf,   // 结算口径（测试用：验证【南陇侯】这类"无视对方装备"的对战修正）
  equipSlots, spellSlots, companionSlots, companionUsedSlots, companionSlotCost,
  isHighTierEquip, manaCap, activateCombatEquips, companionCombat,
  tierEffect, maxTierFor, resolveTier, tierSiblings, isEitherOr, syncEquipTiers,
  applyDamage, alive, qiOf, freshQiPile, runOnWinEffects, runOnLoseEffects, cardCostDiscount,
  enforceHandLimits, effectiveHandLimits, handLimitBonus, handOverLimit, loseCompanion, effRealm,
  d6,   // 骰点（测试用注入点在 d6 里：state.forcedDice）
  fireTiming, timingResponders,
  // `matchConditions` / `markPlayed` 导出给**测试与工具**用：
  //   套装/联动条件（companion 数组 / onField / playedThisTurn）不容易从整局动作里精确制造，
  //   有它就能直接对条件求值做单元断言（tests\conditions-test.js）。
  matchConditions, markPlayed, usedThisTurn, markTurnUse,
  // 「应对」（只有带应对的才进斗法链）与「可用 N 次」—— 导出给测试与工具用
  hasResponse, usesLeft,
  openInterrupt, respondPass, respondPlay, resolvePending, pendingActor, pendingCards, pendingTimeout,
  openTieWindow, openResultWindows,
  HP_MAX, MANA_MAX, MANA_MAX_MORTAL, MANA_REGEN, EQUIP_HIGH_TIER_MIN_REALM,
};
