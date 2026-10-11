'use strict';
/**
 * 按一份"卡牌更新清单"改卡池：**新增卡** + **按牌名改卡**（卡文/效果/张数…）。
 *
 * 为什么要它：用户 2026-10-04 拍了实物卡照片，要"加新牌 + 把之前猜的老牌效果按卡面重写"。
 * 手改 76 张的 JSON 既容易错、又没法复核；这里把改动写成一份清单（可读、可 diff、可重跑），
 * 再走**编辑器保存闸门**（结构预检 → 参数/时点接线 → lint-cards → verify-dsl → 牌堆自洽）落盘。
 *
 * 用法：
 *   node tools\apply-card-updates.js <清单.json>            # 空跑：只报告会改什么
 *   node tools\apply-card-updates.js <清单.json> --apply    # 走编辑器 /api/save 真写盘（自动备份）
 *   node tools\apply-card-updates.js <清单.json> --write    # 直接写盘（自带 .bak，仅临时副本用）
 *
 * 清单格式（JSON）：
 *   {
 *     "add":    [ { "deck":"treasure", "id":"...", "name":"...", "type":"consume",
 *                   "cost":2, "realm":1, "count":3, "cat":"消耗类法宝", "text":"卡文…",
 *                   "effects":[ {…DSL…} ] } ],
 *     "update": [ { "name":"凤凰符", "patch": { "text":"新卡文…", "effects":[…] } } ],
 *     "count":  [ { "name":"寒冰珠", "count":3 } ]
 *   }
 * `deck` 只能取 treasure / spell / companion / qi；`id` 省略时按牌名自动生成（拼音风格 slug）。
 */
const fs = require('fs');
const path = require('path');
const META = require(path.join(__dirname, '..', 'server', 'effect-meta'));

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const WRITE = argv.includes('--write');
const listArg = argv.find((a) => !a.startsWith('--'));
if (!listArg) {
  console.error('用法：node tools\\apply-card-updates.js <清单.json> [--apply|--write]');
  process.exit(1);
}
const LIST = JSON.parse(fs.readFileSync(path.resolve(ROOT, listArg), 'utf8'));
const FILE = path.resolve(ROOT, process.env.CARDS_FILE || path.join('data', 'cards.json'));
const API = process.env.EDITOR_API || 'http://127.0.0.1:8098';
const DECKS = ['treasure', 'spell', 'companion', 'qi'];
const DECK_CN = { treasure: '宝物牌', spell: '法术牌', companion: '同行者', qi: '灵气牌' };

const pool = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const report = { added: [], updated: [], counted: [], problems: [] };

/** 牌名 → { deck, card }（跨四堆找） */
function find(name) {
  for (const d of DECKS) for (const c of pool[d] || []) if (c.name === name) return { deck: d, card: c };
  return null;
}
/** 牌名 → id：沿用卡池既有约定 `k_` + 牌名的 UTF-8 十六进制（如 凤凰符 → k_e587a4e587b0e7aca6） */
function slugId(name) {
  return 'k_' + Buffer.from(String(name), 'utf8').toString('hex');
}

// ---- 新增 ----
for (const spec of LIST.add || []) {
  const deck = spec.deck;
  if (DECKS.indexOf(deck) < 0) { report.problems.push(`新增【${spec.name}】的 deck 非法：${deck}`); continue; }
  if (find(spec.name)) { report.problems.push(`新增【${spec.name}】失败：牌名已存在（要改就用 update）`); continue; }
  const card = Object.assign({}, spec);
  delete card.deck;
  card.id = card.id || slugId(card.name);
  if (card.count == null) card.count = 3;
  if (card.cost == null && card.type !== 'companion') card.cost = 0;
  for (const d of DECKS) for (const c of pool[d] || []) {
    if (c.id === card.id) report.problems.push(`新增【${card.name}】的 id 与【${c.name}】重复：${card.id}`);
  }
  for (const e of (card.effects || [])) checkEffect(e, card.name);
  pool[deck] = pool[deck] || [];
  pool[deck].push(card);
  report.added.push(`${DECK_CN[deck]}【${card.name}】 ${card.count} 张 · ${(card.effects || []).length} 条效果`);
}

// ---- 改已有卡 ----
for (const item of LIST.update || []) {
  const hit = find(item.name);
  if (!hit) { report.problems.push(`更新【${item.name}】失败：卡池里没有这张牌`); continue; }
  const patch = item.patch || {};
  for (const e of (patch.effects || [])) checkEffect(e, item.name);
  const before = JSON.stringify(hit.card);
  Object.assign(hit.card, patch);
  if (JSON.stringify(hit.card) !== before) {
    report.updated.push(`${DECK_CN[hit.deck]}【${item.name}】改了：${Object.keys(patch).join('、')}`);
  }
}

// ---- 只改张数 ----
for (const item of LIST.count || []) {
  const hit = find(item.name);
  if (!hit) { report.problems.push(`改张数【${item.name}】失败：卡池里没有这张牌`); continue; }
  const old = hit.card.count;
  hit.card.count = item.count;
  report.counted.push(`【${item.name}】${old} → ${item.count} 张`);
}

/** 效果条目的静态检查（和编辑器第 0.5 步一个口径，能提前抓到低级错） */
function checkEffect(e, cardName) {
  if (!e || !e.op) { report.problems.push(`【${cardName}】有一条效果没写 op`); return; }
  if (!META.OPS[e.op]) { report.problems.push(`【${cardName}】的 op「${e.op}」不在元数据表里`); return; }
  for (const [k, v] of Object.entries(e)) {
    if (['value', 'damage', 'count', 'cap', 'manaCost', 'selfDamage', 'winDamage', 'loseDamage'].indexOf(k) < 0) continue;
    if (typeof v !== 'number') report.problems.push(`【${cardName}】的 ${e.op}.${k} 必须是数字，现在是 ${JSON.stringify(v)}`);
  }
  if (e.event && !META.EVENTS[e.event]) report.problems.push(`【${cardName}】的时点「${e.event}」不在 EVENTS 表里`);
  if (e.event && e.phase) {
    const ev = META.EVENTS[e.event];
    if (ev && ev.phases.length && ev.phases.indexOf(e.phase) < 0) {
      report.problems.push(`【${cardName}】的 ${e.event} 不接受阶段「${e.phase}」（可选：${ev.phases.join('/')}）`);
    }
  }
}

// ---- 报告 ----
console.log('清单：' + listArg + '　目标卡池：' + path.relative(ROOT, FILE));
console.log(`\n新增 ${report.added.length} 张：`); for (const s of report.added) console.log('  + ' + s);
console.log(`\n改已有 ${report.updated.length} 张：`); for (const s of report.updated) console.log('  ~ ' + s);
console.log(`\n只改张数 ${report.counted.length} 处：`); for (const s of report.counted) console.log('  # ' + s);
if (report.problems.length) {
  console.log('\n⚠ 有问题，先修清单：');
  for (const p of report.problems) console.log('  ! ' + p);
}
const totals = {};
for (const d of DECKS) totals[d] = (pool[d] || []).reduce((s, c) => s + (c.count || 0), 0);
console.log('\n改完的牌堆张数：' + DECKS.map((d) => DECK_CN[d] + ' ' + totals[d]).join(' · ') +
  ' · 合计 ' + DECKS.reduce((s, d) => s + totals[d], 0) + ' 张（张数不固定，按数据算）');

if (report.problems.length) process.exit(1);
if (!APPLY && !WRITE) {
  console.log('\n（空跑模式：**没有写盘**。确认无误后加 --apply 走编辑器，或 --write 直接写盘）');
  process.exit(0);
}
if (WRITE) {
  const bak = FILE + '.bak-cardupd-' + Date.now();
  fs.copyFileSync(FILE, bak);
  fs.writeFileSync(FILE, JSON.stringify(pool, null, 2) + '\n', 'utf8');
  console.log('\n【直接写盘】已写入 ' + path.relative(ROOT, FILE) + '，备份 ' + path.basename(bak));
  process.exit(0);
}
(async () => {
  const r = await fetch(API + '/api/save', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cards: pool }),
  });
  const j = await r.json();
  console.log('\n/api/save wrote = ' + j.wrote + ' | backup = ' + (j.backup && j.backup.file));
  for (const s of j.steps || []) {
    console.log(`  [${s.ok ? '通过' : '不通过'}] ${s.name}`);
    if (!s.ok) console.log('     ' + String(s.output).replace(/\n/g, '\n     '));
  }
  process.exit(j.wrote ? 0 : 1);
})().catch((e) => { console.error('保存失败：' + e.message); process.exit(1); });
