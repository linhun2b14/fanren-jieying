'use strict';
// 生成可供人工编辑的卡牌抄录表（CSV，UTF-8 带 BOM，Excel 可直接打开）。
const fs = require('fs');
const SRC = 'ref\\su-cai\\out\\_final.json';
const OUT = 'D:\\结婴之战卡牌抄录表.csv';

const cards = JSON.parse(fs.readFileSync(SRC, 'utf8')).cards;

const DECK_ORDER = ['宝物牌', '法术牌', '同行者牌', '灵气牌'];
const CONF = { high: '高', medium: '中', low: '低' };

/** 把多行效果按 ●/◆ 拆成独立的 1~3 条 */
function splitEffects(text) {
  const raw = String(text || '').replace(/\r/g, '').trim();
  if (!raw) return ['', '', ''];
  const parts = raw.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const merged = [];
  for (const p of parts) {
    if (/^[●◆]/.test(p) || merged.length === 0) merged.push(p);
    else merged[merged.length - 1] += '\n' + p;   // 续行并入上一条
  }
  const out = merged.slice(0, 3);
  while (out.length < 3) out.push('');
  return out;
}

function q(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const HEAD = ['序号', '卡名', '牌堆', '类型', '法力消耗', '适用境界', '占位',
  '效果1', '效果2', '效果3', '可信度', '来源帧', '备注（遮挡/待确认）'];

const rows = [];
const sorted = cards.slice().sort((a, b) =>
  DECK_ORDER.indexOf(a.deck) - DECK_ORDER.indexOf(b.deck)
  || ({ high: 0, medium: 1, low: 2 }[a.confidence] || 3) - ({ high: 0, medium: 1, low: 2 }[b.confidence] || 3)
  || String(a.name).localeCompare(String(b.name), 'zh'));

let i = 0;
for (const c of sorted) {
  i++;
  const e = splitEffects(c.text);
  rows.push([
    i, c.name, c.deck, c.type || '', c.cost == null ? '' : c.cost, c.realm || '',
    c.slots == null ? '' : c.slots,
    e[0], e[1], e[2],
    CONF[c.confidence] || c.confidence,
    (c.seenIn || []).map((f) => String(f).replace(/\.jpg$/, '')).join(' '),
    c.note || '',
  ]);
}

// 预留 30 行空白，供手动添加新牌
for (let k = 0; k < 30; k++) rows.push([i + k + 1, '', '', '', '', '', '', '', '', '', '', '', '']);

const csv = '\uFEFF' + [HEAD].concat(rows).map((r) => r.map(q).join(',')).join('\r\n') + '\r\n';
fs.writeFileSync(OUT, csv, 'utf8');

console.log('已生成:', OUT);
console.log('字节:', Buffer.byteLength(csv, 'utf8'), ' 数据行:', rows.length, '（含 30 行空行备用）');
const byDeck = {};
cards.forEach((c) => (byDeck[c.deck] = (byDeck[c.deck] || 0) + 1));
console.log('内容:', Object.keys(byDeck).map((d) => `${d} ${byDeck[d]}`).join(' / '));
console.log('\n列说明:');
console.log('  卡名/牌堆/类型/法力消耗/适用境界/占位 = 直接改文字即可');
console.log('  效果1~3 = 卡面效果，多条各占一列；看不清的地方我留了 ??');
console.log('  可信度 = 高/中/低（我抄录时的把握）');
console.log('  备注 = 哪几个字被手挡了、哪处两次读数冲突');
console.log('  空行 = 你看到我漏掉的牌就往下填，牌堆/类型按上面格式写即可');
