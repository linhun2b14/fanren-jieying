'use strict';
// 合并各批次抄录结果：按卡名归并、冲突检测、统计与官方张数对比。
const fs = require('fs');
const path = require('path');

const DIR = 'ref\\su-cai\\out';
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^batch\d+\.json$/.test(f)).sort() : [];
if (!files.length) { console.error('还没有任何 batch 结果'); process.exit(1); }

const all = [];
const bad = [];
for (const f of files) {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')); }
  catch (e) { bad.push(f + ': ' + e.message); continue; }
  if (!Array.isArray(arr)) { bad.push(f + ': 不是数组'); continue; }
  arr.forEach((c) => all.push(Object.assign({ _src: f }, c)));
}

const str = (v) => (typeof v === 'string' ? v.trim() : (v && v.uncertain ? '?' + v.uncertain : ''));
const score = (c) => ({ high: 3, medium: 2, low: 1 }[c.confidence] || 0) * 100
  + (str(c.text).length) + (str(c.type).length) + (c.cost != null ? 10 : 0);

const byName = new Map();
for (const c of all) {
  const name = str(c.name);
  if (!name) continue;
  const prev = byName.get(name);
  if (!prev) { byName.set(name, c); continue; }
  // 取"信息更全"的那条，但把两边都留着以便冲突比对
  if (score(c) > score(prev)) {
    c._alt = prev;
    byName.set(name, c);
  } else {
    prev._alt = prev._alt || [];
    prev._alt.push(c);
  }
}

const merged = [...byName.values()];
const decks = {};
for (const c of merged) {
  const d = str(c.deck) || '?';
  (decks[d] = decks[d] || []).push(c);
}

console.log(`读到 ${files.length} 个批次文件，共 ${all.length} 条记录，去重后 ${merged.length} 张不同卡牌\n`);
for (const d of Object.keys(decks).sort()) {
  console.log(`【${d}】${decks[d].length} 种`);
}

// 冲突检测：同名但 cost/type/realm 读数不一致
const conflicts = [];
for (const c of merged) {
  const alts = Array.isArray(c._alt) ? c._alt : (c._alt ? [c._alt] : []);
  for (const a of alts) {
    const diff = [];
    if (String(c.cost) !== String(a.cost)) diff.push(`cost ${a.cost} vs ${c.cost}`);
    if (str(c.type) !== str(a.type)) diff.push(`type ${str(a.type)} vs ${str(c.type)}`);
    if (str(c.realm) !== str(a.realm)) diff.push(`realm ${str(a.realm)} vs ${str(c.realm)}`);
    if (diff.length) conflicts.push({ name: str(c.name), deck: str(c.deck), diff: diff, a: str(a.text).slice(0, 50), b: str(c.text).slice(0, 50) });
  }
}
console.log(`\n字段冲突 ${conflicts.length} 处（同名卡在不同批次读数不一致，需要我复核）：`);
conflicts.slice(0, 40).forEach((x) => console.log(`  · ${x.name} [${x.deck}] ${x.diff.join('; ')}`));

// 与官方张数对比
const OFFICIAL = { '宝物牌': 80, '法术牌': 33, '同行者牌': 78 };
console.log('\n官方公布张数 vs 本次抄到的种类数：');
for (const d of Object.keys(OFFICIAL)) {
  const n = (decks[d] || []).length;
  console.log(`  ${d}: 官方 ${OFFICIAL[d]} 张，抄到 ${n} 种${n > OFFICIAL[d] ? '（抄多了，可能有误读）' : ''}`);
}

// 低可信度清单
const low = merged.filter((c) => (c.confidence || 'low') === 'low');
console.log(`\n低可信度 ${low.length} 张（建议我回帧复核）：`);
low.slice(0, 25).forEach((c) => console.log(`  · [${str(c.deck)}] ${str(c.name)} — ${str(c.text).slice(0, 40)}`));

// 落盘
const outPath = path.join(DIR, '_merged.json');
fs.writeFileSync(outPath, JSON.stringify({
  merged: merged.map((c) => ({
    name: str(c.name), deck: str(c.deck), type: str(c.type),
    cost: (typeof c.cost === 'number' ? c.cost : null),
    realm: str(c.realm), text: str(c.text),
    slots: (typeof c.slots === 'number' ? c.slots : null),
    confidence: c.confidence || 'low', seenIn: c.seenIn || [], note: c.note || '',
    src: c._src,
  })),
  conflicts: conflicts, badFiles: bad,
}, null, 1), 'utf8');
console.log(`\n已写 ${outPath}`);
if (bad.length) console.log('读取失败的文件:', bad.join('; '));
