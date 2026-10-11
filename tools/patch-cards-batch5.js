'use strict';
// 第五批：把 lint 报出来的「部分未实装」逐张补上（引擎侧新能力已在 engine.js 里做好）。
//   【虚天鼎 乾蓝冰焰】第二档单独计费（1 点法力）
//   【银月】装备宝物牌时抽灵气（每回合1次）+ 额外掷骰需储物袋里有装备
//   【钟卫娘】越级使用宝物牌时掷骰 ≥3 免额外法力
//   【温天仁】对战中使用消耗 3 点法力
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'cards.json');
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const log = [];

const T = (n) => raw.treasure.find((c) => c.name === n);
const CP = (n) => raw.companion.find((c) => c.name === n);

// ---- 虚天鼎 乾蓝冰焰：第二档（乾蓝冰焰）消耗 1 点法力 ----
{
  const c = T('虚天鼎 乾蓝冰焰');
  if (!c) { console.error('✗ 没有【虚天鼎 乾蓝冰焰】'); process.exit(1); }
  const t1 = c.tiers[0], t2 = c.tiers[1];
  t1.manaCost = 0;   // 虚天鼎：不消耗法力值
  t2.manaCost = 1;   // 乾蓝冰焰：消耗 1 点法力值
  delete c.note;
  log.push('【虚天鼎 乾蓝冰焰】档位级法力：第1档 0 点、第2档 1 点');
}

// ---- 银月 ----
{
  const c = CP('银月');
  if (!c) { console.error('✗ 没有【银月】'); process.exit(1); }
  // 效果2：额外掷骰只在储物袋里真有装备类宝物牌时成立
  const rr = c.effects.find((e) => e.op === 'reroll_dice');
  rr.if = { hasEquip: true };
  // 效果1：每回合 1 次，装备装备类宝物牌时抽 1 张灵气牌
  if (!c.effects.some((e) => e.op === 'draw_qi' && e.when === 'equip')) {
    c.effects.push({ when: 'equip', op: 'draw_qi', value: 1 });
  }
  delete c.note;
  log.push('【银月】补上「装备宝物牌时抽1张灵气」+ 额外掷骰加 hasEquip 条件');
}

// ---- 钟卫娘 ----
{
  const c = CP('钟卫娘');
  if (!c) { console.error('✗ 没有【钟卫娘】'); process.exit(1); }
  if (!c.effects.some((e) => e.op === 'overreach_dice_save')) {
    c.effects.push({ when: 'passive', op: 'overreach_dice_save', min: 3 });
  }
  delete c.note;
  log.push('【钟卫娘】补上「越级使用宝物牌掷骰≥3免额外法力」');
}

// ---- 温天仁 ----
{
  const c = CP('温天仁');
  if (!c) { console.error('✗ 没有【温天仁】'); process.exit(1); }
  const cb = c.effects.find((e) => e.op === 'combat_bonus');
  cb.manaCost = 3;
  delete c.note;
  log.push('【温天仁】对战效果补上 3 点法力消耗（引擎已支持同行者对战效果计费）');
}

// ---- 火弹术：二选一其实已经通过「消耗类卡牌档位选择」实现了，note 是旧的 ----
{
  const h = raw.spell.find((c) => c.name === '火弹术');
  if (h && h.note) { delete h.note; log.push('【火弹术】二选一已由档位选择实现，清掉旧 note'); }
}

// ---- 校验 ----
const TARGET = { treasure: 80, spell: 33, companion: 78, qi: 60 };
let bad = false;
for (const d of Object.keys(TARGET)) {
  const n = (raw[d] || []).reduce((s, x) => s + (x.count || 1), 0);
  if (n !== TARGET[d]) { console.error(`✗ ${d} 张数 ${n} != ${TARGET[d]}`); bad = true; }
}
if (bad) { console.error('数量校验失败，未写入'); process.exit(1); }
const json = JSON.stringify(raw, null, 2) + '\n';
if (/\uFFFD/.test(json)) { console.error('结果含 U+FFFD，未写入'); process.exit(1); }
fs.writeFileSync(FILE, json, 'utf8');
console.log('变更：');
for (const l of log) console.log('  ' + l);
