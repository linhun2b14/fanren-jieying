'use strict';
// 测试夹具：按条件在「真实卡池」里找卡，避免用例写死我早期自造的卡名。
//
// 卡牌效果现在统一在 `effects: [{when, op, if, ...}]` 里（效果 DSL），
// 不再有 `effect` / `onTurn` / `onCombat` / `onWin` 等散槽。
// 下面的 effsOf / effOf / opOf / opsOf / mainOf 让用例按新形状取值。
const C = require('../server/cards');
const META = require('../server/effect-meta');

const all = (deck) => C.cards()[deck] || [];
const every = () => ['treasure', 'spell', 'companion', 'qi'].reduce((a, d) => a.concat(all(d).map((c) => Object.assign({ _deck: d }, c))), []);
const byName = (n) => every().find((c) => c.name === n) || null;
const byId = (id) => every().find((c) => c.id === id) || null;

/** 一张卡的所有效果条目 */
const effsOf = (card) => (card && Array.isArray(card.effects)) ? card.effects : [];
/** 该效果的时机键（与 engine 的 effect-meta.timingKey 同一套规则） */
const timingKeysOf = (e) => META.timingKeys(e);
/** 某个时机的第一条效果 —— ⚠️ 认**两种写法**：旧 when 名（'play'/'win'…）与总线坐标。
 *  2026-10-02 数据迁到坐标后，`effOf(card,'play')` 仍要能取到 `{event:'useCard',phase:'after'}`。 */
const effOf = (card, when) => {
  const want = META.timingKey({ when: when });
  return effsOf(card).find((e) => timingKeysOf(e).indexOf(want) >= 0) || null;
};
/** 某个时机的 op 名 */
const opOf = (card, when) => { const e = effOf(card, when); return e ? e.op : null; };
/** 该卡用到的所有 op */
const opsOf = (card) => effsOf(card).map((e) => e.op);
/**
 * 「主效果」：自己回合 / 对战窗口的第一条 —— 等价于旧的卡面 `effect` 槽。
 * 注意：同行者的常驻效果不在这个槽里（旧数据里同行者的 effect 本来就是 null）。
 */
const mainOf = (card) => {
  if (!card) return null;
  if (!Array.isArray(card.effects)) return card.effect || null;
  return card.effects.find((e) => META.timingKey(e) === 'useCard:after' || META.isCombatEffectByTiming(e)) || card.effects[0] || null;
};

/** 一张卡用到的所有 op（旧名 kindsOf，语义不变） */
const kindsOf = (card) => opsOf(card);

/** 找第一张「效果 op 命中给定集合」的卡 */
const withKind = (ops, opts) => {
  const o = opts || {};
  return every().find((c) => {
    if (o.deck && c._deck !== o.deck) return false;
    if (o.type && c.type !== o.type) return false;
    if (o.maxRealm != null && (c.realm || 0) > o.maxRealm) return false;
    if (o.minRealm != null && (c.realm || 0) < o.minRealm) return false;
    return kindsOf(c).some((k) => ops.includes(k));
  }) || null;
};
/** 找一件装备（指定境界档位），用于装备分档测试 */
const equipAt = (pred) => every().find((c) => c.type === 'equip' && pred(c)) || null;

/** 取某张卡第 i 档的 op */
const tierOp = (card, i) => {
  const t = card && card.tiers && card.tiers[i];
  if (!t) return null;
  if (Array.isArray(t.effects)) return t.effects.length ? t.effects[0].op : null;
  return t.effect ? t.effect.kind : null;
};
/** 取某张卡第 i 档的完整效果对象 */
const tierEff = (card, i) => {
  const t = card && card.tiers && card.tiers[i];
  if (!t) return null;
  if (Array.isArray(t.effects)) return t.effects.length ? t.effects[0] : null;
  return t.effect || null;
};
/** 取一张卡「打出去」的效果 op */
const playOp = (card) => { const e = mainOf(card); return e ? (e.op || e.kind) : null; };

module.exports = { all, every, byName, byId, kindsOf, withKind, equipAt, tierOp, tierEff, playOp,
  effsOf, effOf, opOf, opsOf, mainOf, C, META };
