'use strict';
// 第三批同行者/宝物补全：按实物卡文把「获胜时」「受伤时」「放置时」等效果补进卡池。
// 只补卡文已经拍到、语义明确的效果；语义有歧义或需要玩家选择的，统一写进 note 标注还没做。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'cards.json');
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const byName = (n) => raw.companion.find((c) => c.name === n);
const NOTE = (s) => s;

// ---- 同行者：按卡文补全 ----
const C = {
  寒蛟: {
    onCombat: { kind: 'combat_bonus_if_companion', value: 1, name: '离龟' },
    onWin: { block_spell_draw: 1, block_companion_draw: 1 },
    note: null,
  },
  韩立: {
    onWin: { steal_equip: 1 },
    note: null,
  },
  离龟: {
    onPlace: { extra_seclusion: 1 },
    note: null,
  },
  慕沛灵: {
    // 【慕沛灵】第 2 条经用户裁定是**回法力**（原始抄录此字被手指挡住写作【??值】）
    onHurt: { kind: 'mana', value: 1 },
    note: null,
  },
  三目豹: {
    onWin: { discard_enemy_equip: 1 },
    note: null,
  },
  宋玉: {
    onWin: { mana: 1, draw_qi: 1 },
    note: null,
  },
  血玉蜘蛛: {
    onTurn: null,
    onPlace: { draw_treasure: 3 },
    onWin: { mana: 2 },
    note: null,
  },
  火龙童子: { onWin: { mana: 4 }, note: null },
  蛮胡子: {
    onCombat: { kind: 'combat_bonus_if_hp_ge', value: 1, threshold: 4 },
    onCombat2: { kind: 'combat_bonus_if_hp_le', value: 1, threshold: 3 },
    note: null,
  },
  噬金虫: { onWin: { draw_qi: 1 }, note: null },
  铁火蚁: { onTurn: null, onPlace: { draw_qi: 1 }, absorb: 1, note: null },
  王蝉: { onWin: { draw_qi: 1 }, note: null },
  元瑶: { onLowHp: { threshold: 1, heal: 2, discardSelf: true }, note: null },
  // 以下卡文有「需要玩家选择 / 改消耗」的复合效果，先保留 note
  温天仁: { note: NOTE('对战中使用需消耗3法力（引擎目前不扣这3点法力）；获胜时「改为降低对方2点灵气值」的二选一未实现') },
  银月: { note: NOTE('「每回合1次装备装备类宝物牌时抽1张灵气牌」未实现；额外掷骰取大已实现，但未校验储物袋中是否有装备类宝物牌') },
  钟卫娘: { note: NOTE('「使用超过当前境界的宝物牌时掷骰≥3免额外法力」未实现；替挡已实现') },
  玄骨: { note: NOTE('「使用宝物牌/法术牌时法力消耗-1（最低1）」未实现；晋升折扣与占2位已实现') },
  李化元: { note: NOTE('需要「获得1张法术牌·青云剑诀（实物应为【青元剑诀】）并使其无视境界」与「牌堆无该牌时弃置自身并抽1张同行者」，均未实现') },
  青易居士: { note: NOTE('「探索阶段可放弃1张宝物牌改为抽1张法术牌」是玩家主动选择，引擎还没有对应动作，未实现') },
  陈巧倩: { note: NOTE('卡文引用的【补气丹】/【回气丹】不在已抄录卡池中，无法实现') },
  梅凝: { note: NOTE('「使用后恢复1点生命并抽3张宝物牌，然后弃置自身」是一次性主动效果，引擎还没有同行者主动使用动作，未实现') },
};

let n = 0;
for (const name of Object.keys(C)) {
  const c = byName(name);
  if (!c) { console.error(`✗ 卡池里没有【${name}】`); process.exit(1); }
  const patch = C[name];
  for (const k of Object.keys(patch)) {
    if (k === 'note') continue;
    c[k] = patch[k];
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'note')) {
    if (patch.note) c.note = patch.note; else delete c.note;
  }
  n++;
}

// ---- 花篮：卡文明写「取走所有【装备类宝物牌】」，之前只取 1 张 ----
const hualan = raw.treasure.find((c) => c.name === '花篮');
if (hualan && hualan.effect && hualan.effect.kind === 'steal_equip') {
  hualan.effect.count = 'all';
  console.log('已修正【花篮】：取走对方储物袋中全部装备类宝物牌');
}

// ---- 数量校验 ----
const TARGET = { treasure: 80, spell: 33, companion: 78, qi: 60 };
let bad = false;
for (const d of Object.keys(TARGET)) {
  const t = (raw[d] || []).reduce((s, x) => s + (x.count || 1), 0);
  if (t !== TARGET[d]) { console.error(`✗ ${d} 张数 ${t} != ${TARGET[d]}`); bad = true; }
}
if (bad) { console.error('数量校验失败，未写入'); process.exit(1); }

const json = JSON.stringify(raw, null, 2) + '\n';
if (/\uFFFD/.test(json)) { console.error('结果含 U+FFFD，未写入'); process.exit(1); }
fs.writeFileSync(FILE, json, 'utf8');

const still = raw.companion.filter((c) => c.note);
console.log(`已补全 ${n} 张同行者，数量校验通过（80/33/78/60）`);
console.log(`仍标注未实现的同行者 ${still.length} 张: ${still.map((c) => c.name).join('、')}`);
