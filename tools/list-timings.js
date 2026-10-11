'use strict';
/**
 * 报表：**缩减后的时点总表**实况 —— 每个时点（玩家看到的名字）现在挂着哪些卡。
 *
 * 数据来源：
 *   · 时点表 = `server/effect-meta.js` 的 **`TIMING_GRID`**（唯一权威；一行可含多个引擎钩子）
 *   · 卡池   = `data/cards.json`
 *   · 界面文案 = 直接从 `public/app.js` 抠 `timingText()` 执行（与玩家看到的逐字一致）
 *
 * 用法：node tools\list-timings.js
 */
const fs = require('fs');
const path = require('path');
const META = require(path.join(__dirname, '..', 'server', 'effect-meta'));

const ROOT = path.join(__dirname, '..');
const pool = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cards.json'), 'utf8'));
const app = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');

function grab(src, header) {
  const i = src.indexOf(header);
  if (i < 0) throw new Error('找不到函数：' + header);
  let depth = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  throw new Error('花括号不配对：' + header);
}
const M = META.meta();               // 与 /api/meta 同一份
const whenLabel = new Function('META', grab(app, 'function whenLabel(w)') + '\nreturn whenLabel;')(M);
// ⚠️ `timingText()` 依赖同闭包里的 `timingLookupKey()`，抠函数时要一起带上
const uiText = new Function('META', 'whenLabel',
  grab(app, 'function whenLabel(w)')
  + '\n' + grab(app, 'function timingText(e)')
  + '\n' + grab(app, 'function timingLookupKey(e)')
  + '\nreturn timingText;')(M, whenLabel);

const DECKS = ['treasure', 'spell', 'companion', 'qi'];
const DECK_CN = { treasure: '宝物', spell: '法术', companion: '同行者', qi: '灵气' };

const rows = [];
for (const d of DECKS) for (const c of pool[d] || []) {
  (c.effects || []).forEach((e) => rows.push({ deck: d, card: c, e: e, tier: null }));
  (c.tiers || []).forEach((t, i) => (t.effects || []).forEach((e) => rows.push({ deck: d, card: c, e: e, tier: i + 1 })));
}

/** 钩子键 `事件[|主体][|阶段]`（`*` = 任意）→ 匹配函数 */
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

console.log('===== 缩减后的时点总表（TIMING_GRID，玩家看到的名字）=====');
console.log('一行 = 一个时点，可含多个引擎钩子；名字来自 effect-meta 的 TIMING_NAMES');
console.log('2026-10-05：按「主要阶段 / 次要阶段 / 独立时点」三组收拢（TIMING_GROUPS，行数仍是 18）\n');
let used = 0, empty = 0, total = 0;
let idx = 0;
let lastGroup = null;
M.timingGrid.forEach((g) => {
  idx += 1;
  const gid = g.group || 'main';
  if (gid !== lastGroup) {
    const meta = (M.timingGroups || []).find((x) => x.id === gid);
    console.log(`\n—— ${meta ? meta.label : gid}${meta ? '：' + meta.note : ''} ——`);
    lastGroup = gid;
  }
  const matchers = g.hooks.map(hookMatcher);
  const list = rows.filter((r) => matchers.some((m) => m(r.e)));
  total += list.length;
  const mark = list.length ? '✅' : '⬜';
  if (list.length) used++; else empty++;
  console.log(`${mark} #${String(idx).padStart(2)} ${g.stage}　**${g.name}**　← 钩子 ${g.hooks.join(' + ')}`);
  if (list.length) {
    const names = list.map((r) => `【${r.card.name}】(${DECK_CN[r.deck]}${r.tier ? '档' + r.tier : ''}/${r.e.auto === true ? '自动' : '要问'})`);
    console.log(`      ${list.length} 条：` + names.join('、'));
  } else {
    console.log('      0 条（预留：引擎会走到，但暂时没有卡挂在这里）');
  }
});
console.log(`\n合计：有卡 ${used} 行 / 预留 ${empty} 行（共 ${M.timingGrid.length} 行）；落在表里的效果 ${total} 条`);

// 不在表里的（常驻 / 按钮 / 引擎直查）
const inGrid = new Set();
M.timingGrid.forEach((g) => g.hooks.forEach((h) => inGrid.add(h)));
const nonTiming = rows.filter((r) => {
  const t = META.timingOfEffect(r.e);
  if (t && t.event) {
    return !M.timingGrid.some((g) => g.hooks.some((h) => hookMatcher(h)(r.e)));
  }
  return true;
});
console.log('\n===== 不在时点表里（常驻 / 按钮 / 引擎直查）=====');
nonTiming.forEach((r) => {
  const w = r.e.when || (r.e.op && META.OPS[r.e.op] && META.OPS[r.e.op].engineDirect ? 'engineDirect' : '?');
  console.log(`   · 【${r.card.name}】${DECK_CN[r.deck]}${r.tier ? '档' + r.tier : ''} when=${w} op=${r.e.op} → 界面「${uiText(r.e)}」`);
});
console.log(`共 ${nonTiming.length} 条`);

// 一张卡上出现相同界面文案多行 → 玩家眼里就是"重复/乱"
console.log('\n===== 一张卡上**同一文案重复多行**的（"看着乱"的根源）=====');
let dupCards = 0;
for (const d of DECKS) for (const c of pool[d] || []) {
  const labels = [];
  (c.effects || []).forEach((e) => labels.push({ t: uiText(e), where: '主体' }));
  (c.tiers || []).forEach((t, i) => (t.effects || []).forEach((e) => labels.push({ t: uiText(e), where: '档' + (i + 1) })));
  if (labels.length < 2) continue;
  const dup = labels.filter((x, i) => labels.findIndex((y) => y.t === x.t) !== i);
  if (!dup.length) continue;
  dupCards++;
  console.log(`   【${c.name}】(${DECK_CN[d]}/${c.type})：` + labels.map((x) => `${x.where}「${x.t}」`).join('  '));
}
if (!dupCards) console.log('   （无）');
