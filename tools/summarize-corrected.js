'use strict';
// 汇总用户修正版：列出全部行、标出仍余 ?? 的、并区分「原有」与「用户新增」。
const fs = require('fs');
const parsed = JSON.parse(fs.readFileSync('ref\\su-cai\\xlsx\\parsed.json', 'utf8'));
const rows = parsed[0].rows;
const HEAD = rows[0].map((h) => String(h || ''));

function cell(r, i) { const v = r[i]; return v == null ? '' : String(v).trim(); }

const out = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i];
  const name = cell(r, 1);
  if (!name) continue;
  out.push({
    row: i + 1,
    name: name,
    deck: cell(r, 2), type: cell(r, 3), cost: cell(r, 4), realm: cell(r, 5), slots: cell(r, 6),
    e1: cell(r, 7), e2: cell(r, 8), e3: cell(r, 9),
    conf: cell(r, 10), src: cell(r, 11), note: cell(r, 12),
  });
}

const byDeck = {};
for (const c of out) (byDeck[c.deck || '未标牌堆'] = byDeck[c.deck || '未标牌堆'] || []).push(c);

console.log(`用户表格共 ${out.length} 张有卡名的行（原表 49 张）\n`);
for (const d of Object.keys(byDeck)) console.log(`  【${d}】${byDeck[d].length} 张`);

const stillUnknown = out.filter((c) => /\?\?/.test(c.e1 + c.e2 + c.e3 + c.type + c.realm + c.name));
console.log(`\n仍含 ?? 的：${stillUnknown.length} 张`);
stillUnknown.forEach((c) => console.log(`  · ${c.name}（第 ${c.row} 行）`));

console.log('\n================ 全部内容 ================');
for (const d of Object.keys(byDeck)) {
  console.log(`\n### ${d}（${byDeck[d].length}）`);
  for (const c of byDeck[d]) {
    const eff = [c.e1, c.e2, c.e3].filter(Boolean).map((s) => s.replace(/\n/g, ' ⏎ '));
    console.log(`[${c.row}] ${c.name} | ${c.type || '-'} | 耗${c.cost || '-'} | ${c.realm || '-'}${c.slots ? ' | 占'+c.slots : ''} | ${c.conf}`);
    eff.forEach((s) => console.log(`      ${s}`));
  }
}

fs.writeFileSync('ref\\su-cai\\xlsx\\corrected.json', JSON.stringify(out, null, 1), 'utf8');
console.log('\n已写 corrected.json');
