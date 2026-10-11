'use strict';
// 卡池加载与牌堆构建。数据源：data/cards.json（由卡池设计产出）。
const fs = require('fs');
const path = require('path');
const META = require('./effect-meta');

const DATA = path.join(__dirname, '..', 'data', 'cards.json');
const DECKS = ['treasure', 'spell', 'companion', 'qi'];

// 兜底最小卡池：cards.json 缺失时保证服务仍可启动自检。
const FALLBACK = {
  treasure: [
    { id: 'qing_zhu_feng_yun_jian', name: '青竹蜂云剑', type: 'equip', cost: 0, realm: 0, count: 3,
      text: '在对战中投掷骰子前使用，使本次对战中骰子点数+1（最高为6点）。（装备时不消耗【法力值】）',
      effect: { kind: 'dice_bonus', value: 1, cap: 6 } },
    { id: 'qing_wen_qi', name: '青纹旗', type: 'consume', cost: 1, realm: 0, count: 3,
      text: '指定一位玩家，令其受到1点伤害。', effect: { kind: 'damage_target', value: 1 } },
  ],
  spell: [
    { id: 'huo_qiu_fu', name: '火球符', type: 'consume', cost: 1, realm: 0, count: 3,
      text: '对战中使对方最终战力值-2。', effect: { kind: 'combat_debuff', value: 2 } },
  ],
  companion: [
    { id: 'han_li', name: '韩立', type: 'companion', cost: null, realm: 0, count: 3,
      text: '你的回合内抽1张宝物牌；对战时骰子点数+1；晋升时少消耗1点灵气值。',
      onTurn: { kind: 'draw', deck: 'treasure', value: 1 },
      onCombat: { kind: 'dice_bonus', value: 1, cap: 6 },
      onPromote: { kind: 'promote_discount', value: 1 } },
  ],
  qi: [
    { id: 'xi_bo_ling_qi', name: '稀薄灵气', type: 'qi', cost: null, realm: 0, count: 6,
      text: '获得1点灵气值。', effect: { kind: 'qi', value: 1 } },
  ],
};

let CACHE = null;

// ---------------------------------------------------------------- 兼容层
//
// 效果 DSL：一张卡的所有触发效果统一放在 `effects: [{when, if, op, ...}]` 数组里。
// 老的写法（`effect` / `onTurn` / `onCombat` / `onCombat2` / `onWin` / `onPlace` …）
// 在**加载时**自动合成为 `effects`，所以：
//   · 引擎只读 `effects`，代码路径单一
//   · 任何旧版 cards.json / 备份 / 手写卡都能直接读，出事能秒回滚
// 这个兼容层**永久保留**。

/** 旧 `onWin` / `onPlace` 用的是裸字段（{mana:1, draw_qi:1}），逐个展开成 op */
const BARE_WIN_FIELDS = ['mana', 'draw_qi', 'steal_equip', 'discard_enemy_equip',
  'block_spell_draw', 'block_companion_draw', 'block_treasure_draw', 'damage'];
const BARE_PLACE_FIELDS = ['draw_treasure', 'draw_qi', 'extra_seclusion'];

function effectEntry(when, src) {
  if (!src) return null;
  const e = Object.assign({}, src);
  e.when = when;
  if (!e.op) { e.op = e.kind; delete e.kind; }
  return e.op ? e : null;
}

/** 把一张卡的老字段合成 `effects` 与 `tiers[].effects`（已是新格式则原样返回） */
function normalizeCard(c) {
  if (!c || Array.isArray(c.effects)) return c;
  const out = [];
  const add = (e) => { if (e && e.op) out.push(e); };

  // ① 卡面主效果：旧 COMBAT_KINDS 里的算对战窗口，其余算自己回合
  if (c.effect && c.effect.kind) {
    // 绿煌剑 / 敛气术：主效果里嵌了一个 `on_win` 子效果（裸字段 {damage:N}），单独拆出来
    if (c.effect.on_win && typeof c.effect.on_win.damage === 'number') {
      add({ when: 'win', op: 'damage', value: c.effect.on_win.damage });
    }
    const e = effectEntry(META.defaultWhenFor(c.effect.kind), c.effect);
    if (e) { delete e.on_win; add(e); }
  }

  // ② 同行者/装备的各个触发时点（有 `kind` 的槽）
  add(effectEntry('turn', c.onTurn));
  // onCombat / onCombat2 是混合桶：按 op 语义细化窗口（after_combat_mana 应归"对战结束后"）
  for (const slot of [c.onCombat, c.onCombat2]) {
    if (slot) add(effectEntry(META.defaultWhenFor(slot.kind), slot));
  }
  add(effectEntry('hurt', c.onHurt));
  add(effectEntry('promote', c.onPromote));

  // ③ 濒危自救：threshold 其实是条件，不是效果参数
  if (c.onLowHp) {
    const e = { when: 'lowHp', op: 'low_hp_rescue', value: c.onLowHp.heal || 1,
      discardSelf: c.onLowHp.discardSelf !== false };
    e.if = { hp: { lte: c.onLowHp.threshold == null ? 1 : c.onLowHp.threshold } };
    add(e);
  }

  // ④ `onWin` / `onPlace` 是裸字段写法（{mana:1, draw_qi:1}），按字段名展开成 op
  if (c.onWin) {
    for (const f of BARE_WIN_FIELDS) {
      if (c.onWin[f] === undefined) continue;
      add({ when: 'win', op: f, value: typeof c.onWin[f] === 'number' ? c.onWin[f] : 1 });
    }
  }
  if (c.onPlace) {
    for (const f of BARE_PLACE_FIELDS) {
      if (c.onPlace[f] === undefined) continue;
      add({ when: 'place', op: f, value: typeof c.onPlace[f] === 'number' ? c.onPlace[f] : 1 });
    }
  }

  // ⑤ tiers（多境界档位）：内层 effect → effects，窗口按旧 COMBAT_KINDS 判定
  if (Array.isArray(c.tiers)) {
    for (const t of c.tiers) {
      if (Array.isArray(t.effects) || !t.effect) continue;
      const e = effectEntry(META.defaultWhenFor(t.effect.kind), t.effect);
      t.effects = e ? [e] : [];
      delete t.effect;
    }
  }

  c.effects = out.reduce((acc, e) => acc.concat(conditionifyAll(e)), []).filter(Boolean);
  return c;
}

/**
 * 把「条件型 op」降级成「通用 op + if 条件」—— 这是消灭组合爆炸的关键一步。
 * 以前每多一种条件组合就得新造一个 kind；现在只是 if 里多一行数据。
 */
function conditionify(e) {
  if (!e || !e.op) return e;
  switch (e.op) {
    case 'combat_bonus_if_hp_le':
      return { when: e.when, op: 'combat_bonus', value: e.value, if: { hp: { lte: e.threshold == null ? 3 : e.threshold } } };
    case 'combat_bonus_if_hp_ge':
      return { when: e.when, op: 'combat_bonus', value: e.value, if: { hp: { gte: e.threshold == null ? 4 : e.threshold } } };
    case 'combat_bonus_if_enemy_higher_realm':
      return { when: e.when, op: 'combat_bonus', value: e.value, if: { enemyRealm: { higher: true } } };
    case 'combat_bonus_if_companion':
      return { when: e.when, op: 'combat_bonus', value: e.value, if: { companion: e.name } };
    case 'versus_realm_effect':
      // 天雷子：按对方境界分两条自解释的效果（以前是一个 kind 塞四个参数）
      // 这里只能返回一条，调用方另行展开 —— 见 conditionifyAll
      return e;
    default:
      return e;
  }
}

/** 有些效果要展开成多条（[versus_realm_effect] → 两条带 if 的效果） */
function conditionifyAll(e) {
  if (e && e.op === 'versus_realm_effect') {
    const out = [];
    if (e.onWinDamage) {
      out.push({ when: e.when, op: 'win_extra_damage', value: e.onWinDamage,
        if: { enemyRealm: { lte: e.lowRealm == null ? 2 : e.lowRealm } } });
    }
    if (e.diceBonus) {
      out.push({ when: e.when, op: 'dice_bonus', value: e.diceBonus,
        if: { enemyRealm: { gte: e.highRealm == null ? 3 : e.highRealm } } });
    }
    return out.length ? out : [e];
  }
  return [conditionify(e)];
}

function cards() {
  if (CACHE) return CACHE;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  } catch (e) {
    raw = FALLBACK;
    console.warn(`[cards] 无法读取 ${DATA}（${e.message}），使用内置兜底卡池`);
  }
  const out = {};
  for (const d of DECKS) {
    if (!Array.isArray(raw[d]) || raw[d].length === 0) {
      out[d] = (FALLBACK[d] || []).map(normalizeCard);
      continue;
    }
    out[d] = raw[d].map(normalizeCard);
  }
  CACHE = out;
  return out;
}

/**
 * **注入卡池**（编辑器效果沙盒 / 测试用）。
 *   setPool(pool)  → 用这份卡池（结构与 cards.json 相同；走同一条 normalizeCard 兼容层）
 *   setPool(null)  → 丢弃缓存，下次 cards() 重新读磁盘
 *
 * 为什么需要它：编辑器的沙盒要能跑**界面上还没存盘**的那份卡池 —— 改完一张卡立刻试效果，
 * 不必先过存盘闸门。注意它只影响**当前进程**（编辑器服务自己的进程），线上 8094 不受影响。
 */
function setPool(raw) {
  if (!raw) { CACHE = null; return null; }
  const out = {};
  for (const d of DECKS) out[d] = Array.isArray(raw[d]) ? raw[d].map(normalizeCard) : [];
  CACHE = out;
  return out;
}

function byId() {
  const m = new Map();
  for (const d of DECKS) for (const c of cards()[d]) m.set(c.id, c);
  return m;
}

/** 构建四个牌堆：返回 { deck: [cardId...] } 已洗牌 */
function buildDecks(shuffle) {
  const rng = shuffle || Math.random;
  const out = {};
  for (const d of DECKS) {
    const arr = [];
    for (const c of cards()[d]) {
      // ⚠️ 用 `count == null ? 1 : count`，**不能**写 `count || 1` —— 那样 `count: 0` 会被当成 1 张，
      //    "不入牌堆"的卡（新卡效果还没实装时先给 0 张）会悄悄进牌堆，还会把洗牌随机流整体推偏
      //    （2026-10-05 补 19 张实物新卡时踩到：4 个套件因为随机流漂移假红）。
      for (let i = 0; i < (c.count == null ? 1 : c.count); i++) arr.push(c.id);
    }
    out[d] = rngArr(arr, rng);
  }
  return out;
}

function rngArr(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function stats() {
  const c = cards();
  const o = {};
  let total = 0;
  for (const d of DECKS) {
    o[d] = c[d].length;
    for (const x of c[d]) total += x.count == null ? 1 : x.count;
  }
  o.total = total;
  return o;
}

module.exports = { cards, byId, buildDecks, stats, DECKS, normalizeCard, meta: META.meta, setPool };
