'use strict';
// 依据用户修正版表格（52 张真实卡文）重建卡池。
// 数据源：ref/su-cai/xlsx/corrected.json（由 read-xlsx.js 解析 D:\结婴之战卡牌抄录表修正版.xlsx 得到）
// 输出：data/cards.json
const fs = require('fs');

const SRC = 'ref\\su-cai\\xlsx\\corrected.json';
const OUT = 'data\\cards.json';
const cards = JSON.parse(fs.readFileSync(SRC, 'utf8'));

const REALM = { '凡人及以上': 0, '炼气及以上': 1, '筑基及以上': 2, '结丹及以上': 3, '元婴及以上': 4 };
const DECK = { '宝物牌': 'treasure', '法术牌': 'spell', '同行者牌': 'companion', '灵气牌': 'qi' };
const TYPE = { '消耗': 'consume', '装备': 'equip' };

/** 官方公布的总张数（含重复副本） */
const DECK_TOTAL = { treasure: 80, spell: 33, companion: 78, qi: 60 };

function idOf(name) {
  // 中文卡名 → 稳定英文 id（用拼音首字母不现实，改用序号 + 简短前缀）
  return 'c' + (idOf._n = (idOf._n || 0) + 1) + '_' + Buffer.from(name, 'utf8').toString('hex').slice(0, 8);
}
function typeKind(t) {
  const s = String(t || '');
  if (s.indexOf('装备') === 0 || s.indexOf('装备') >= 0) return 'equip';
  if (s.indexOf('消耗') >= 0) return 'consume';
  return null;
}

// ===== 逐张卡的效果映射（依据用户修正后的卡文）=====
const EFFECT = {
  // --- 宝物牌 ---
  '风雷翅':      { kind: 'lose_save_dice', faces: [1, 3, 6] },
  '凤凰符':      { kind: 'damage_multi', value: 1, max: 2, ignore_companion: true },
  '寒冰珠':      { kind: 'dice_penalty', value: 2 },
  '寒黎珠':      { kind: 'skip_turns', value: 1 },
  '撼地符':      { kind: 'damage_multi', value: 1, max: 2 },
  '花篮':        { kind: 'steal_equip', all: true },
  '金光砖符':    { kind: 'dice_skip_bonus', value: 2 },
  '绿煌剑':      { kind: 'combat_bonus', value: 0, on_win: { damage: 1 } },
  '娑罗珠':      { kind: 'promote_discount_once', value: 1 },
  '踏云靴':      { kind: 'lose_immunity' },
  '天雷子':      { kind: 'versus_realm_effect', lowRealm: 2, onWinDamage: 1, highRealm: 3, diceBonus: 1 },
  '透明丝线':    { kind: 'lose_retaliate', value: 1 },
  '阴魂丝':      { kind: 'block_enemy_card_kind', block: '消耗类宝物牌' },
  '遮天钟':      { kind: 'damage_save_dice', faces: [4, 5], reflect: 6 },
  '真凰符':      { kind: 'self_damage_then_multi', selfDamage: 1, value: 2, max: 2 },
  '大挪移令':    { kind: 'draw_mixed', treasure: 1, spell: 1 },
  '黑血刀':      { kind: 'dice_bonus', value: 2, cap: 6 },
  '红线遁光针':  { kind: 'damage_higher_realm', value: 1 },
  '血凝五行丹':  { kind: 'pseudo_realm', realm: 3, turns: 2, penalty: 1 },
  '青竹蜂云剑':  { kind: 'dice_bonus', value: 1, cap: 6 },
  '禁神牌':      { kind: 'damage_and_skip', damage: 1, skip: 1 },
  // --- 法术牌 ---
  '天星大阵':    { kind: 'heal', value: 1 },
  '碧水青甲阵':  { kind: 'skip_turns', value: 1 },
  '还阳术':      { kind: 'self_revive', value: 2 },
  '敛气术':      { kind: 'flat_power', value: 5, on_win: { damage: 2 } },
  '玄阴诀':      { kind: 'after_consume_roll6' },
  '血咒禁制':    { kind: 'curse_target', blockTreasureDraw: true, blockCombat: true },
  '长春功':      { kind: 'on_promote_draw_qi', value: 1, extraIfAboveMortal: 1 },
  '颠倒五行阵':  { kind: 'force_reroll_foe' },
  // --- 灵气牌 ---
  '稀薄灵气':    null,
  '混杂灵气':    { kind: 'mana', value: 1 },
  '充裕灵气':    { kind: 'draw', deck: 'qi', value: 1 },
  '天地灵气':    { kind: 'draw', deck: 'qi', value: 2 },
};

// ===== 同行者：absorb + 三个时机 =====
const COMPANION = {
  '寒蛟':    { absorb: 1, onWin: { block_enemy_draw: 'spell' }, note: '第3条「与离龟同场战力+1」需同场判定，暂未实现' },
  '韩立':    { onTurn: { kind: 'draw', deck: 'treasure', value: 1 }, onWin: { steal_equip: true }, onPromote: { kind: 'reroll', scope: 'promote' }, note: '第3条「结丹/元婴晋升时额外掷1次」用重掷近似' },
  '离龟':    { absorb: 2, note: '第2条「额外获得1次过关机会」超出当前玩法范围，未实现' },
  '李化元':  { note: '两条效果都与「青云剑诀」这张牌绑定，当前卡池没有该牌，未实现' },
  '六翼霜蚣': { onCombat: { kind: 'combat_bonus_if_hp_le', threshold: 3, value: 1 }, onPromote: { kind: 'promote_discount', value: 1 } },
  '慕沛灵':  { onTurn: { kind: 'mana_regen_bonus', value: 1 }, onHurt: { kind: 'mana', value: 1 }, note: '第2条经用户裁定为「受伤时回1点法力值」（原始抄录该字被手指挡住写作【??值】，曾误猜为生命值）' },
  '青易居士': { note: '换抽（弃1宝物改抽1法术）需交互，暂未实现' },
  '三目豹':  { onTurn: { kind: 'turn_no_combat_mana', value: 1 }, onWin: { discard_enemy_equip: true } },
  '宋玉':    { onWin: { mana: 1, draw_qi: 1 } },
  '啼魂':    { absorb: 1, onCombat: { kind: 'combat_bonus', value: 1 } },
  '温天仁':  { onCombat: { kind: 'combat_bonus', value: -1 }, onPromote: { kind: 'reroll', scope: 'promote' }, note: '「对战中使用消耗3法力使对方-1」简化为常驻-1；「获胜时改降2灵气」未实现' },
  '血玉蜘蛛': { onWin: { mana: 2 }, onTurn: { kind: 'place_draw_qi', value: 3 }, note: '「首次放置时抽3张」挂在回合效果上近似' },
  '紫灵':    { onTurn: { kind: 'mana_regen_bonus', value: 1 }, onCombat: { kind: 'combat_bonus_if_enemy_higher_realm', value: 1 } },
  '火龙童子': { onWin: { mana: 4 } },
  '蛮胡子':  { onCombat: { kind: 'combat_bonus_if_hp_ge', threshold: 4, value: 1 }, onCombat2: { kind: 'combat_bonus_if_hp_le', threshold: 3, value: 1 } },
  '梅凝':    { note: '「在自己的回合使用后弃置」需主动发动交互，暂未实现' },
  '南宫婉':  { absorb: 2, onTurn: { kind: 'mana_regen_bonus', value: 1 } },
  '噬金虫':  { onTurn: { kind: 'hand_limit_bonus', value: 1 }, onWin: { draw_qi: 1 } },
  '铁火蚁':  { absorb: 1, onTurn: { kind: 'place_draw_qi', value: 1 } },
};

// ===== 组装 =====
const decks = { treasure: [], spell: [], companion: [], qi: [] };
const unmapped = [];

for (const c of cards) {
  const deck = DECK[c.deck];
  if (!deck) { unmapped.push(`${c.name}(未知牌堆 ${c.deck})`); continue; }
  const realm = REALM[c.realm] != null ? REALM[c.realm] : 0;
  const cost = c.cost === '' || c.cost == null ? 0 : Number(c.cost);
  const text = [c.e1, c.e2, c.e3].filter(Boolean).join('\n');
  const id = 'k_' + Buffer.from(c.name, 'utf8').toString('hex').slice(0, 12);

  if (deck === 'companion') {
    const m = COMPANION[c.name] || {};
    if (!COMPANION[c.name]) unmapped.push(`${c.name}(同行者未映射)`);
    decks.companion.push({
      id: id, name: c.name, type: 'companion', cost: null, realm: 0, count: 1,
      slots: c.slots ? Number(c.slots) : 1,
      cat: (String(c.type) === '灵兽' ? '灵兽' : '修士'),
      absorb: m.absorb || undefined,
      text: text.replace(/\n/g, ' '),
      onTurn: m.onTurn || null, onCombat: m.onCombat || null, onPromote: m.onPromote || null,
      onWin: m.onWin || null,
      note: m.note || undefined,
    });
  } else if (deck === 'qi') {
    const e = EFFECT[c.name];
    if (!(c.name in EFFECT)) unmapped.push(`${c.name}(灵气未映射)`);
    decks.qi.push({ id: id, name: c.name, type: 'qi', cost: null, realm: 0, count: 1, text: text.replace(/\n/g, ' '), effect: e });
  } else {
    if (!(c.name in EFFECT)) unmapped.push(`${c.name}(未映射)`);
    const tk = typeKind(c.type);
    decks[deck].push({
      id: id, name: c.name, type: tk || 'consume', cost: cost, realm: realm, count: 1,
      cat: String(c.type || ''),
      text: text.replace(/\n/g, ' '),
      effect: EFFECT[c.name] || { kind: 'none' },
    });
  }
}

// ===== 配平张数到官方总数 =====
for (const d of Object.keys(DECK_TOTAL)) {
  const list = decks[d];
  if (!list.length) continue;
  const total = DECK_TOTAL[d];
  const base = Math.floor(total / list.length);
  let rest = total - base * list.length;
  list.forEach((c, i) => { c.count = base + (i < rest ? 1 : 0); });
}

fs.writeFileSync(OUT, JSON.stringify(decks, null, 1), 'utf8');

console.log('=== 重建后的卡池 ===');
let grand = 0;
for (const d of ['treasure', 'spell', 'companion', 'qi']) {
  const n = decks[d].reduce((a, c) => a + c.count, 0);
  grand += n;
  console.log(`  ${d}: ${decks[d].length} 种 / ${n} 张（官方 ${DECK_TOTAL[d]}）`);
}
console.log(`  合计 ${grand} 张`);
if (unmapped.length) console.log('\n未映射/需注意:', unmapped.join('、'));
const withNote = [];
for (const d of ['treasure', 'spell', 'companion']) decks[d].forEach((c) => { if (c.note) withNote.push(`${c.name}: ${c.note}`); });
if (withNote.length) { console.log('\n标注「暂未实现」的卡（不影响其他部分）:'); withNote.forEach((x) => console.log('  · ' + x)); }
console.log('\n已写', OUT);
