'use strict';
// 合并「8 个批次 + 3 个补读组」的结果，并把同卡异名归并（如 `?阴魂丝` 与 `阴魂丝`）。
// 归并策略：去掉卡名里的 `?`/括号注释后取前 2~4 字做 key；若两边的类型/消耗不冲突则视为同一张。
const fs = require('fs');
const path = require('path');

const DIR = 'ref\\su-cai\\out';
const BATCH = fs.readdirSync(DIR).filter((f) => /^batch\d+\.json$/.test(f)).sort();
const RECHECK = fs.readdirSync(DIR).filter((f) => /^recheck[A-Z]\.json$/.test(f)).sort();

const load = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); } catch (e) { console.log('  [跳过]', f, e.message); return []; } };

const str = (v) => (typeof v === 'string' ? v.trim() : (v && v.uncertain ? '' : ''));
/** 归并用的键：去掉 ? 与括号注释后取前两个字（中文卡名足够区分） */
function keyOf(name) {
  const n = str(name).replace(/[?？]/g, '').replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
  return n.slice(0, 2) || n;
}
const clean = (name) => str(name).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();

const all = [];
for (const f of BATCH) load(f).forEach((c) => all.push(Object.assign({ _src: f, _round: 1 }, c)));
for (const f of RECHECK) load(f).forEach((c) => all.push(Object.assign({ _src: f, _round: 2 }, c)));
if (!all.length) { console.error('没有可合并的结果'); process.exit(1); }

const rank = (c) => ({ high: 3, medium: 2, low: 1 }[c.confidence] || 0) * 1000
  + (c._round === 2 ? 500 : 0)                       // 补读轮优先
  + str(c.text).replace(/\?/g, '').length            // 文本越完整越优先
  + (c.cost != null ? 50 : 0) + (str(c.realm) ? 50 : 0) + (str(c.type) ? 50 : 0);

const groups = new Map();
for (const c of all) {
  const k = keyOf(c.name);
  if (!k) continue;
  if (!groups.has(k)) { groups.set(k, [c]); continue; }
  groups.get(k).push(c);
}

const merged = [];
const conflicts = [];
for (const [k, list] of groups) {
  list.sort((a, b) => rank(b) - rank(a));
  const best = Object.assign({}, list[0]);
  best.name = clean(best.name) || str(best.name);
  const alts = list.slice(1);
  for (const a of alts) {
    const d = [];
    if (String(a.cost) !== String(best.cost) && a.cost != null && best.cost != null) d.push(`cost ${a.cost} vs ${best.cost}`);
    if (str(a.type) && str(best.type) && str(a.type) !== str(best.type)) d.push(`type ${str(a.type)} vs ${str(best.type)}`);
    if (str(a.realm) && str(best.realm) && str(a.realm) !== str(best.realm)) d.push(`realm ${str(a.realm)} vs ${str(best.realm)}`);
    if (str(a.deck) && str(best.deck) && str(a.deck) !== str(best.deck)) d.push(`deck ${str(a.deck)} vs ${str(best.deck)}`);
    if (d.length) conflicts.push({ name: best.name, src: [a._src, best._src], diff: d });
  }
  // 合并所有出现过的帧号
  const seen = new Set();
  list.forEach((c) => (c.seenIn || []).forEach((f) => seen.add(f)));
  best.seenIn = [...seen];
  best._variants = list.length;
  merged.push(best);
}

const byDeck = {};
for (const c of merged) (byDeck[str(c.deck) || '?'] = byDeck[str(c.deck) || '?'] || []).push(c);

console.log(`批次文件 ${BATCH.length} 个 + 补读文件 ${RECHECK.length} 个，原始记录 ${all.length} 条`);
console.log(`归并后 ${merged.length} 张不同卡牌\n`);
for (const d of Object.keys(byDeck).sort()) console.log(`  【${d}】${byDeck[d].length} 种`);
console.log(`\n归并掉的重名/异名合并：${all.length - merged.length} 条`);
console.log(`字段冲突 ${conflicts.length} 处（需要人工判断）：`);
conflicts.forEach((x) => console.log(`  · ${x.name} [${x.src.join(' + ')}] ${x.diff.join('; ')}`));

const low = merged.filter((c) => (c.confidence || 'low') !== 'high');
console.log(`\n仍需补读（非 high）${low.length} 张：`);
low.forEach((c) => console.log(`  · [${str(c.deck)}] ${c.name} (${c.confidence}) ${str(c.text).slice(0, 34)}`));

const out = path.join(DIR, '_final.json');
fs.writeFileSync(out, JSON.stringify({
  cards: merged.map((c) => ({
    name: clean(c.name), deck: str(c.deck), type: str(c.type),
    cost: typeof c.cost === 'number' ? c.cost : null,
    realm: str(c.realm), text: str(c.text),
    slots: typeof c.slots === 'number' ? c.slots : null,
    confidence: c.confidence || 'low', seenIn: c.seenIn, note: c.note || '',
    src: c._src, variants: c._variants,
  })),
  conflicts: conflicts,
}, null, 1), 'utf8');
console.log(`\n已写 ${out}`);
