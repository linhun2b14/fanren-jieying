'use strict';
// 把 data/cards.json 从「8 个分散槽」落盘成统一的 effects[] 数组（效果 DSL）。
//
// 关键：本脚本**只搬家，不改语义**。
//   · 每个效果的 when 窗口，由 effect-meta 的 defaultWhenFor() 决定 ——
//     保证 timingOf() 判定与搬家前一字不变（纯搬家、零行为差异）
//   · 更精确的窗口（如【天星大阵】应归"平局"）由 tools/refine-windows.js 单独做，
//     并会先打印差异清单给人过目
//
// 用法：node tools/compile-effects.js [--apply]     不带 --apply 只做 dry-run
const fs = require('fs');
const path = require('path');
const META = require('../server/effect-meta');
const { normalizeCard } = require('../server/cards');

const FILE = path.join(__dirname, '..', 'data', 'cards.json');
const BAK = path.join(__dirname, '..', 'data', 'cards.json.bak-pre-dsl');
const APPLY = process.argv.includes('--apply');

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));

/** 把效果条目排成 {when, op, if, ...参数} 的稳定顺序，便于人读 */
function tidy(e) {
  const out = { when: e.when, op: e.op };
  if (e.if) out.if = e.if;
  for (const k of Object.keys(e)) {
    if (k === 'when' || k === 'op' || k === 'if') continue;
    out[k] = e[k];
  }
  return out;
}

const LEGACY_FIELDS = ['effect', 'onPlace', 'onTurn', 'onCombat', 'onCombat2',
  'onHurt', 'onLowHp', 'onWin', 'onPromote'];

let moved = 0, effects = 0;
for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
  for (const c of raw[deck] || []) {
    const hadLegacy = LEGACY_FIELDS.some((f) => c[f] !== undefined)
      || (c.tiers || []).some((t) => t.effect);
    normalizeCard(c);              // 合成 c.effects / tiers[].effects
    c.effects = (c.effects || []).map(tidy);
    effects += c.effects.length;
    for (const t of c.tiers || []) {
      if (Array.isArray(t.effects)) t.effects = t.effects.map(tidy);
      delete t.effect;
    }
    for (const f of LEGACY_FIELDS) delete c[f];
    if (hadLegacy) moved++;
  }
}

// 校验：条数不能少（每个老槽都应该有对应的新条目）
let bad = 0;
for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
  for (const c of raw[deck] || []) {
    for (const e of c.effects) {
      if (!e.op || !e.when) { console.error(`✗ ${c.name} 效果条目缺 op/when: ${JSON.stringify(e)}`); bad++; }
      if (!META.OPS[e.op]) { console.error(`✗ ${c.name} 的 op「${e.op}」不在元数据表里`); bad++; }
      if (!META.WHEN[e.when]) { console.error(`✗ ${c.name} 的 when「${e.when}」不在时机表里`); bad++; }
    }
  }
}
if (bad) { console.error(`\n有 ${bad} 处问题，未写入`); process.exit(1); }

console.log(`搬家完成：${moved} 张卡，共 ${effects} 条效果`);
console.log('效果最多的卡：');
const top = [];
for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
  for (const c of raw[deck] || []) if (c.effects.length > 1) top.push(`${c.name}(${c.effects.length})`);
}
console.log('  ' + top.join('、'));
console.log('\n抽样：');
for (const nm of ['蛮胡子', '凌玉灵', '天雷子', '血玉蜘蛛', '元瑶', '寒蛟']) {
  for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
    const c = (raw[deck] || []).find((x) => x.name === nm);
    if (c) { console.log(`  【${nm}】`); for (const e of c.effects) console.log('    ' + JSON.stringify(e)); break; }
  }
}

if (!APPLY) { console.log('\n（dry-run，未写入。加 --apply 才落盘）'); process.exit(0); }

if (!fs.existsSync(BAK)) {
  fs.copyFileSync(FILE, BAK);
  console.log(`\n已备份原文件 → ${path.basename(BAK)}`);
}
const json = JSON.stringify(raw, null, 2) + '\n';
if (/\uFFFD/.test(json)) { console.error('结果含 U+FFFD，未写入'); process.exit(1); }
fs.writeFileSync(FILE, json, 'utf8');
console.log(`已写入 ${FILE}`);
