'use strict';
/**
 * 从 `server\effect-meta.js` 的 **`TIMING_GRID`** 生成 `docs\时点规范.md` §2 的时点总表。
 *
 * 为什么要有它：时点表 = 玩家看到的东西，**只能有一份真值**（TIMING_GRID）。文档里手抄一份迟早对不上。
 * 用法：
 *   node tools\gen-timing-table.js           # 打印表格（看看会变成什么）
 *   node tools\gen-timing-table.js --write   # 直接写进 docs\时点规范.md 的标记区里
 *
 * 文档里的标记：
 *   <!-- TIMING-TABLE:BEGIN -->  …  <!-- TIMING-TABLE:END -->
 */
const fs = require('fs');
const path = require('path');
const META = require(path.join(__dirname, '..', 'server', 'effect-meta'));

const ROOT = path.join(__dirname, '..');
const DOC = path.join(ROOT, 'docs', '时点规范.md');
const pool = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cards.json'), 'utf8'));
const DECKS = ['treasure', 'spell', 'companion', 'qi'];

const rows = [];
for (const d of DECKS) for (const c of pool[d] || []) {
  (c.effects || []).forEach((e) => rows.push({ deck: d, card: c, e: e }));
  (c.tiers || []).forEach((t) => (t.effects || []).forEach((e) => rows.push({ deck: d, card: c, e: e })));
}

function hookMatcher(hook) {
  const parts = String(hook).split('|');
  const ev = parts[0];
  const sub = parts[1] && parts[1] !== '*' ? parts[1] : null;
  const ph = parts[2] && parts[2] !== '*' ? parts[2] : null;
  return (eff) => {
    const t = META.timingOfEffect(eff);
    if (!t || t.event !== ev) return false;
    if (sub && (t.subject || 'self') !== sub) return false;
    if (ph && (t.phase || null) !== ph) return false;
    if (!ph && ev === 'combatResult' && !t.phase) return false;
    return true;
  };
}
const G = META.meta();
const line = (cells) => '| ' + cells.join(' | ') + ' |';

const out = [];
const HEAD = '| # | 挂在图上哪一格 | 引擎钩子（数据里写的坐标） | 中文名（卡面 ／ 运行时） | 谁能响应 | 现在挂着几张 |';
const SEP = '|---|---|---|---|---|---|';
let n = 0;
// ⭐ 2026-10-05：按 TIMING_GROUPS 分三组渲染（主要阶段 / 次要阶段 / 独立时点）——
//    用户拍板"不合并那 6 格，只收拢分组"，所以行数不变、变的只是看表的方式。
const groups = G.timingGroups || [];
const grid = G.timingGrid || [];
const ordered = groups.length
  ? groups.map((g) => ({ g: g, rows: grid.filter((r) => (r.group || 'main') === g.id) }))
  : [{ g: null, rows: grid }];
for (const blk of ordered) {
  if (blk.g) out.push(`**${blk.g.label}**（${blk.rows.length} 格）—— ${blk.g.note}`);
  else out.push('**时点总表**');
  out.push('');
  out.push(HEAD);
  out.push(SEP);
  blk.rows.forEach((g) => {
    n += 1;
    const matchers = g.hooks.map(hookMatcher);
    const hit = rows.filter((r) => matchers.some((m) => m(r.e)));
    const hooks = g.hooks.map((h) => '`' + h.replace(/\|/g, ' · ') + '`').join(' + ');
    let name = g.name;
    if (/先攻/.test(name)) name += `　（运行时名，见 §2.1）`;
    const status = hit.length
      ? `✅ 已接（${hit.length} 条：` + [...new Set(hit.map((r) => '【' + r.card.name + '】'))].join('') + '）'
      : '⬜ **预留**（引擎会走到，暂时没有卡）';
    out.push(line([n, g.stage, hooks, name, g.who, status]));
  });
  out.push('');
}
const table = out.join('\n') + '\n';

if (!process.argv.includes('--write')) {
  console.log(table);
  process.exit(0);
}
const doc = fs.readFileSync(DOC, 'utf8');
const BEGIN = '<!-- TIMING-TABLE:BEGIN -->';
const END = '<!-- TIMING-TABLE:END -->';
let next;
const b = doc.indexOf(BEGIN);
const e = doc.indexOf(END);
if (b >= 0 && e >= 0) {
  next = doc.slice(0, b + BEGIN.length) + '\n' + table + doc.slice(e);
} else {
  // 首次使用：把 §2 里那张手写的表整块换成"标记区 + 生成的表"
  const sec = doc.indexOf('## 2. 时点总表');
  const tblStart = doc.indexOf('\n|', sec);
  const tblEnd = doc.indexOf('\n\n', tblStart + 1);
  if (sec < 0 || tblStart < 0 || tblEnd < 0) {
    console.error('找不到 §2 的表格，无法插入标记区');
    process.exit(1);
  }
  next = doc.slice(0, tblStart + 1)
    + BEGIN + '\n' + table + END + '\n'
    + doc.slice(tblEnd + 1);
}
fs.writeFileSync(DOC, next, 'utf8');
console.log('已写入 docs\\时点规范.md（' + G.timingGrid.length + ' 行）');
