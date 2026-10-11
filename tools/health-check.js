'use strict';
// 一致性体检：U+FFFD、JSON 可解析、卡牌 id 唯一、牌堆张数、效果 kind 是否有引擎分支
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const files = ['server/engine.js', 'server/index.js', 'server/cards.js', 'data/cards.json', 'public/app.js', 'public/index.html', 'docs/规则文档.md'];
let bad = 0;
for (const f of files) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { console.log(`✗ 缺失 ${f}`); bad++; continue; }
  const s = fs.readFileSync(p, 'utf8');
  const n = (s.match(/\uFFFD/g) || []).length;
  if (n) { console.log(`✗ ${f} 含 ${n} 个 U+FFFD`); bad++; }
  else console.log(`✓ ${f} 无替换字符`);
}
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/cards.json'), 'utf8'));
const ids = new Map(); let dup = 0;
for (const d of ['treasure', 'spell', 'companion', 'qi']) for (const c of raw[d] || []) {
  if (ids.has(c.id)) { console.log(`✗ id 冲突: ${c.id} (${ids.get(c.id)} / ${c.name})`); dup++; }
  ids.set(c.id, c.name);
}
console.log(dup ? `✗ ${dup} 个 id 冲突` : '✓ 卡牌 id 全局唯一');
if (dup) bad++;
const TARGET = { treasure: 80, spell: 33, companion: 78, qi: 60 };
for (const d of Object.keys(TARGET)) {
  const n = (raw[d] || []).reduce((s, x) => s + (x.count || 1), 0);
  const ok = n === TARGET[d];
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${d} ${(raw[d] || []).length}种 / ${n}张（应为 ${TARGET[d]}）`);
}
// 效果 op 清单 → 确认引擎/元数据表里都有对应分支
const engine = fs.readFileSync(path.join(ROOT, 'server/engine.js'), 'utf8');
const META = require(path.join(ROOT, 'server/effect-meta'));
const ops = new Set(); const whens = new Set();
const scan = (o) => {
  if (!o || typeof o !== 'object') return;
  if (typeof o.op === 'string') ops.add(o.op);
  if (typeof o.when === 'string') whens.add(o.when);
  for (const v of Object.values(o)) if (v && typeof v === 'object') scan(v);
};
for (const d of ['treasure', 'spell', 'companion', 'qi']) for (const c of raw[d] || []) scan(c);
const missingMeta = [...ops].filter((k) => !META.OPS[k]);
const missingEngine = [...ops].filter((k) => !engine.includes(`'${k}'`));
const badWhen = [...whens].filter((w) => !META.WHEN[w]);
console.log(`效果 op 共 ${ops.size} 种，when 共 ${whens.size} 种`);
if (missingMeta.length) { console.log(`✗ 元数据表里没有的 op: ${missingMeta.join(', ')}`); bad++; }
if (missingEngine.length) { console.log(`✗ 引擎里找不到分支的 op: ${missingEngine.join(', ')}`); bad++; }
if (badWhen.length) { console.log(`✗ 时机表里没有的 when: ${badWhen.join(', ')}`); bad++; }
if (!missingMeta.length && !missingEngine.length && !badWhen.length) {
  console.log('✓ 所有 op 与 when 都有元数据与引擎分支');
}
console.log(bad ? `\n体检不通过（${bad} 项）` : '\n体检全部通过');
process.exit(bad ? 1 : 0);
