'use strict';
/**
 * 时点写法迁移：把卡池里旧的 `when: 'xxx'` 改写成总线坐标 `{event, subject, phase}`。
 *
 * 背景：现在 105 条效果里有 90 条还是旧 `when`（play/win/standing/turn…），只有 13 条用了新坐标，
 * 这就是用户说的"新老不一"。规范（docs\时点规范.md）要求：**时点类**只能写坐标。
 *
 * 分类规则（以 `effect-meta.js` 的 WHEN_TIMING 为唯一依据，不自己编）：
 *   · WHEN_TIMING[when].event 存在  → 是**真时点** → 改写成 {event, subject, phase}，删掉 when；
 *   · WHEN_TIMING[when].event 为 null → 是**常驻/按钮**（standing / passive / activate）→ **原样保留**，
 *     它们本来就不是"时点"，引擎用别的通道读（companionCombat / passives / activatables）。
 *
 * 用法：
 *   node tools\migrate-timing.js            # 空跑：只报告要改什么，不写盘
 *   node tools\migrate-timing.js --apply    # 走编辑器 /api/save（闸门 + 备份）真正写盘
 *   node tools\migrate-timing.js --write --file <路径>   # 直接写盘（只给临时副本做实验用，自带 .bak）
 *   node tools\migrate-timing.js --file <路径>  # 指定卡池文件（默认 data/cards.json）
 */
const fs = require('fs');
const path = require('path');
const META = require(path.join(__dirname, '..', 'server', 'effect-meta'));

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const WRITE = argv.includes('--write');
const fileArg = argv.indexOf('--file');
const FILE = path.resolve(ROOT, fileArg >= 0 ? argv[fileArg + 1] : path.join('data', 'cards.json'));
const API = process.env.EDITOR_API || 'http://127.0.0.1:8098';
const DECKS = ['treasure', 'spell', 'companion', 'qi'];
const DECK_CN = { treasure: '宝物牌', spell: '法术牌', companion: '同行者', qi: '灵气牌' };
/** 常驻/按钮类：不是时点，保持原样 */
const KEEP_WHEN = ['standing', 'passive', 'activate'];
/**
 * 「自动收集通道」的时点 —— 迁移时给落在这些格子上的**场上牌**补 `auto: true`（官方开关：**永不被问**）。
 *
 * 为什么必须补：迁移前这些效果只写 `when`、**没有 `event`**，`boardAskable()` 判它们"自动"，
 * 由引擎的专用通道执行（`hurtMana()` / `lowHpRescue()` / `runOnWinEffects()` / 回合开始的同行者收集…）。
 * 迁移后它们带上 `event`，默认判定**反过来把它们当成"可主动使用"** → 多余地开一个只能点"放弃"的空窗，
 * 玩家一点"响应"还会让同一条效果**跑第二遍**（回血/回法力翻倍）。
 * 2026-10-02 实测：不补 auto 直接迁移，`window-ask-test` 就是这么红的。
 *
 * ⚠️ **只补场上牌**（装备 / 同行者）：手牌走的是另一条通道，`boardAskable()` 根本不看它们。
 * ⚠️ **绝不能**补到 `roll:before|after`（【乾蓝冰焰】要问）、`turnEnd`（【墨彩环】带 manaCost 要问）、
 *    `useCard:*` / `combatDeclare` / `combatOpt`（都是主动牌）上。
 */
const AUTO_KEYS = ['turnStart', 'place', 'lowHp', 'equip', 'combatEnd', 'hurt',
  'promote:after', 'combatResult:win', 'combatResult:lose', 'combatResult:tie'];

const pool = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const changes = [];
const splits = [];
const kept = {};
const unknown = [];
let scanned = 0, alreadyBus = 0, autoAdded = 0;

/** 把一条效果转换成 1~2 条（双写法会拆成两条） */
function convertOne(e, where, board) {
  const keys = Object.keys(e).filter((k) => k !== '__card');
  const clean = {};
  for (const k of keys) clean[k] = e[k];
  if (!clean.when) return [clean];                       // 已是坐标 / 常驻
  if (KEEP_WHEN.indexOf(clean.when) >= 0) { kept[clean.when] = (kept[clean.when] || 0) + 1; return [clean]; }
  const t = META.timingOfWhen(clean.when);
  if (!t || !t.event) { unknown.push({ where: where, when: clean.when }); return [clean]; }
  // when 推出来的那条：先把原效果的 event/subject/phase 剔掉，再用映射写回去
  //   （否则原 `event` 会在同一个循环里把映射结果覆盖掉 —— 2026-10-02 踩过：
  //    拆【遮天钟】时拆出了 `event:'hurt' + phase:'after'` 这种非法组合，被 lint 拦下）
  const migrated = {};
  for (const k of keys) {
    if (k === 'when' || k === 'event' || k === 'subject' || k === 'phase') continue;
    migrated[k] = clean[k];
  }
  migrated.event = t.event;
  if (t.subject) migrated.subject = t.subject;
  if (t.phase) migrated.phase = t.phase;
  const key = t.event + (t.phase ? ':' + t.phase : '');
  // 「自动收集通道」的场上牌：补 auto:true，保证迁移前后**不进询问**（见 AUTO_KEYS 的说明）
  if (board && AUTO_KEYS.indexOf(key) >= 0) {
    migrated.auto = true;
    autoAdded++;
  }
  if (!clean.event) {
    changes.push({ where: where, from: clean.when, to: key, op: clean.op, auto: migrated.auto === true });
    return [migrated];
  }
  // 双写法（过渡期手改的，如【遮天钟】when:'play' + event:'hurt'）：拆成两条，一条一个时点
  const second = {};
  for (const k of keys) if (k !== 'when') second[k] = clean[k];
  splits.push({ where: where, one: key, two: clean.event + (clean.phase ? ':' + clean.phase : ''), op: clean.op });
  return [migrated, second];
}

function convertList(list, where, board) {
  const out = [];
  for (const e of (list || [])) {
    e.__card = undefined;
    for (const x of convertOne(e, where, board)) out.push(x);
  }
  return out;
}

for (const d of DECKS) {
  for (const c of pool[d] || []) {
    const tag = DECK_CN[d] + '【' + c.name + '】';
    // 场上牌（装备 / 同行者）才会被 boardAskable() 管 —— 只有它们需要 auto 补丁
    const board = c.type === 'equip' || c.type === 'companion';
    scanned += (c.effects || []).length;
    alreadyBus += (c.effects || []).filter((e) => !e.when && e.event).length;
    if (c.effects) c.effects = convertList(c.effects, tag, board);
    (c.tiers || []).forEach((t, i) => {
      scanned += (t.effects || []).length;
      alreadyBus += (t.effects || []).filter((e) => !e.when && e.event).length;
      if (t.effects) t.effects = convertList(t.effects, tag + ' 档' + (i + 1), board);
    });
  }
}

console.log('卡池文件：' + path.relative(ROOT, FILE));
console.log(`扫描效果条目 ${scanned} 条 —— 已是坐标写法 ${alreadyBus} 条；本次需改写 **${changes.length}** 条`);
console.log('保留不动的常驻/按钮类：' + (Object.keys(kept).map((k) => k + ' × ' + kept[k]).join('、') || '（无）'));
if (unknown.length) {
  console.log('\n⚠ 认不出、未改写的：');
  for (const u of unknown) console.log('   ' + u.where + ' when=' + u.when);
}
console.log('\n改写明细（前 25 条）：');
for (const c of changes.slice(0, 25)) console.log(`   ${c.where}  ${String(c.op).padEnd(20)} ${c.from}  →  ${c.to}${c.auto ? '   [auto:true]' : ''}`);
if (changes.length > 25) console.log(`   …… 还有 ${changes.length - 25} 条`);
// 补 auto 的条数按「自动收集通道」分组，方便核对（数字应与 §4 的键集合吻合）
const autoRows = changes.filter((c) => c.auto);
console.log(`\n补 auto:true（迁后不进询问的场上牌）**${autoAdded}** 条 —— 落点：`
  + (autoRows.length ? autoRows.map((c) => c.to).filter((v, i, a) => a.indexOf(v) === i).join('、') : '（无）'));
if (splits.length) {
  console.log('\n双写法拆成两条（一条效果只能有一个时点）：');
  for (const s of splits) console.log(`   ${s.where}  ${s.op}  ${s.one}  +  ${s.two}`);
}

if (!APPLY && !WRITE) {
  console.log('\n（空跑模式：**没有写盘**。确认无误后加 --apply 走编辑器，或 --write 直接写盘）');
  process.exit(0);
}

if (WRITE) {
  const bak = FILE + '.bak-migrate-' + Date.now();
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
})().catch((e) => { console.error('保存失败：' + e.message); process.exit(1); });
