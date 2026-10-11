'use strict';
// 时点/触发审计（只读，不改任何东西）：
//   ① 死字段审计 —— 效果把某个字段写了，但全引擎没人读（= 效果静默失效，如 t.skip）
//   ② 卡文 vs 实现的时点对照 —— 每张牌每个效果的 when/op，配上卡文原文
//   ③ 启发式标记三类高风险：
//        · 卡文含「可使用/可选择/可放弃」→ 需要玩家决定，但引擎可能直接自动执行
//        · 场面触发窗口（win/lose/turn/hurt/lowHp/place/equip/passive）出现在**消耗牌**上
//          → 前端卡片详情不区分"在手上/在场上"，会在手里就把这些效果列出来
//        · 卡文提到「受到伤害时 / 对战失败时使用」→ 需要"中断询问"，引擎目前是自动/预置
//
// 用法：node tools/audit-timing.js [--md]
const fs = require('fs');
const path = require('path');
const META = require('../server/effect-meta');

const ROOT = path.join(__dirname, '..');
const engine = fs.readFileSync(path.join(ROOT, 'server', 'engine.js'), 'utf8');
const appjs = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cards.json'), 'utf8'));
const DECKS = ['treasure', 'spell', 'companion', 'qi'];

/** 场地触发窗口：这些 when 的效果只在"场上"才有意义 */
const BOARD_WHENS = ['place', 'turn', 'equip', 'hurt', 'lowHp', 'win', 'lose', 'afterCombat', 'passive', 'activate'];
/** 上面那份名单的**归一化键**（卡池迁到总线坐标后，比较时机一律走这个） */
const BOARD_KEYS = META.wantKeys(BOARD_WHENS);
/** 一条效果声明的时机（坐标写法优先）—— 报告里统一显示这个，别再显示裸 when */
const timingOfRow = (e) => META.timingKeys(e).join('+') ||
  (e.op && META.OPS[e.op] && META.OPS[e.op].engineDirect ? '(engineDirect 不占时点)' : '(无)');

// ---------------------------------------------------------------- ① 死字段审计
// 收集引擎里所有 player/combat/state 上的字段名
const FIELD_RE = /\b(?:pl|self|t|target|win|lose|A|D|x|def)\.([A-Za-z_][A-Za-z0-9_]*)/g;
const fields = new Map();
const lines = engine.split('\n').map((l) => {
  // 注释行不参与字段扫描，否则注释里写的示例代码会被当成真代码（例如 "self.xxx = ..."）
  const stripped = l.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return stripped;
});
lines.forEach((line, i) => {
  let m;
  FIELD_RE.lastIndex = 0;
  while ((m = FIELD_RE.exec(line)) !== null) {
    const f = m[1];
    if (!fields.has(f)) fields.set(f, []);
    fields.get(f).push({ line: i + 1, text: line.trim() });
  }
});

/**
 * 这一行里，`.F` 有没有"真正的读"？
 * 先把两种伪读剔掉，再看还剩不剩：
 *   ① 自默认读：`(x.F || 0)`、`(x.F || [])` —— `t.skip = (t.skip || 0) + 1` 里的那个是伪读
 *   ② 赋值目标：`x.F =` / `x.F +=` / `x.F -=` / `x.F++` —— 是写，不是读
 * 只要还剩一处 `.F`，就是真读。
 * 例：
 *   t.skip = (t.skip || 0) + 1;                  → 伪读，写-only
 *   if (pl.blockTreasureDraw > 0) pl.blockTreasureDraw -= 1;  → 有真读（> 0 那次）
 *   Number(x.uid) === uid                        → 真读
 */
function lineHasRealRead(line, f) {
  let s = line;
  const assignRe = new RegExp(`[\\w.$]+\\.${f}\\b\\s*(\\+\\+|--|[+\\-*/%|&^]?=(?!=)|\\?\\?=|&&=|\\|\\|=)`);
  // ⚠️ 只有"这一行确实在给自己赋值"时才剔 —— 否则会把 `(x.on || 'threshold') === want`
  // 这种"读 + 兜底默认值"误判成自读（那是真正的读）。
  if (assignRe.test(line)) {
    // ① 剔掉 `(x.F || 默认值)` 这种自默认
    s = s.replace(new RegExp(`\\(\\s*[\\w.$]+\\.${f}\\b\\s*\\|\\|\\s*[^()]*\\)`, 'g'), '');
    // ② 剔掉"作为赋值目标"的那一处
    s = s.replace(new RegExp(`[\\w.$]+\\.${f}\\b\\s*(\\+\\+|--|[+\\-*/%|&^]?=(?!=)|\\?\\?=|&&=|\\|\\|=)`, 'g'), '');
  }
  return new RegExp(`\\.${f}\\b`).test(s);
}

const deadFields = [];
for (const [f, occ] of fields) {
  if (occ.length === 0 || occ.length > 40) continue;   // 太常见的（hp/mana）跳过
  if (!occ.some((o) => lineHasRealRead(o.text, f))) deadFields.push({ field: f, occ: occ });
}

// 死字段 → 哪个 op 在写它（`x.F = ...` 往上找最近的 `case 'xxx':`，因为 case 常常不在同一行）
function nearestCase(lineNo) {
  for (let i = lineNo - 1; i >= 0 && i >= lineNo - 25; i--) {
    const m = lines[i].match(/case '([a-z_0-9]+)'/);
    if (m) return m[1];
  }
  return '?';
}
const deadOps = [];
for (const d of deadFields) {
  for (const o of d.occ) {
    const m = o.text.match(/case '([a-z_0-9]+)'/);
    const op = m ? m[1] : nearestCase(o.line);
    if (op !== '?' && deadOps.indexOf(op) < 0) deadOps.push(op);
  }
}

console.log('=== ① 只写不读的字段（写进状态但全引擎没人读）===');
if (!deadFields.length) console.log('  ✓ 没找到');
for (const d of deadFields) {
  const ops = d.occ.map((o) => (o.text.match(/case '([a-z_0-9]+)'/) || [, nearestCase(o.line)])[1]);
  const op = ops.find((x) => x && x !== '?') || '?';
  console.log(`  ⚠ .${d.field}  ← op:${[...new Set(ops)].join('/')}  （${d.occ.length} 处，全是赋值）`);
  for (const o of d.occ.slice(0, 2)) console.log(`      L${o.line}: ${o.text.slice(0, 110)}`);
}
console.log(`\n  ⇒ 静默失效的 op（${deadOps.length} 个）：${deadOps.join(', ')}`);

// 反查：这些死 op 分别被哪些卡用了
const deadOpCards = new Map(deadOps.map((o) => [o, []]));
function scanDead(name, deck, arr, where) {
  for (const e of arr || []) {
    if (e && e.op && deadOpCards.has(e.op)) deadOpCards.get(e.op).push({ name: name, deck: deck, where: where, e: e });
  }
}
for (const deck of DECKS) {
  for (const c of raw[deck] || []) {
    scanDead(c.name, deck, c.effects, '主效果');
    (c.tiers || []).forEach((t, i) => scanDead(c.name, deck, t.effects, `第${i + 1}档`));
  }
}
console.log('\n=== ①b 静默失效的 op 影响了哪些卡 ===');
for (const [op, list] of deadOpCards) {
  const isPassive = !!(META.OPS[op] && META.OPS[op].passive);
  console.log(`  ${op}  —  ${list.length} 处：${list.map((x) => x.name + '(' + x.deck + '·' + x.where + ')').join('、') || '（卡池里没人用）'}${isPassive ? '   [常驻类，见 ①c]' : ''}`);
}

// ---------------------------------------------------------------- ①c 常驻 op 通道
// 常驻类 op 不走 runEffect 的 switch，而是由 passives(pl) 汇总成 {op: 数值} 对象，
// 再由引擎各处的 `passives(x).<op>` 读取。所以"字段只写不读"对它们不成立 —— 必须单独核查
// passives() 的返回值到底有没有人取用。
const passiveOps = Object.keys(META.OPS).filter((o) => META.OPS[o] && META.OPS[o].passive);
/** 引擎里"提到这个 op"的行，排掉两类不算消费的：
 *    ① `case 'op':`  —— 那是写字段的那条分支本身
 *    ② `op: 0`       —— passives() 返回值对象的初始声明
 *  剩下任一行出现该 op，才算有人真的取用（`passives(x).op`、`x.eff.op === 'op'`、专用 helper 都算）。 */
function passiveConsumed(op) {
  return lines.some((l) => {
    if (l.indexOf(op) < 0) return false;
    if (new RegExp(`case '${op}'`).test(l)) return false;
    if (new RegExp(`\\b${op}:\\s*0\\b`).test(l)) return false;
    return true;
  });
}
console.log('\n=== ①c 常驻 op 通道核查（passives() 汇总 → 谁在取用）===');
/** 人工核对过的补充说明：有些 op 的 passives 键没人读，但效果靠专用字段/helper 生效了 */
const PASSIVE_NOTES = {
  turn_no_combat_mana: '效果其实生效：L1290 写 self.noCombatMana，L973 回合结束读取；但该字段**从不重置**，每回合 +1 累积（三目豹越玩越强）',
  damage_shield: '卡池里没有任何卡用它，属预留 op',
};
const orphanPassive = [];
for (const op of passiveOps) {
  if (passiveConsumed(op)) continue;
  orphanPassive.push(op);
}
for (const op of orphanPassive) {
  const users = [];
  for (const deck of DECKS) {
    for (const c of raw[deck] || []) {
      const has = (c.effects || []).some((e) => e.op === op) ||
        (c.tiers || []).some((t) => (t.effects || []).some((e) => e.op === op));
      if (has) users.push(c.name + '(' + deck + ')');
    }
  }
  const deadField = deadFields.find((d) => nearestCase(d.occ[0].line) === op);
  const note = PASSIVE_NOTES[op] ? '  ⓘ ' + PASSIVE_NOTES[op] : '';
  console.log(`  ✗ op:${op}  —— passives() 汇总了，但全引擎没有任何地方取用` +
    (deadField ? `（开关分支写进 .${deadField.field} 后也没人读）` : '') +
    (users.length ? `  ⇒ 受影响卡：${users.join('、')}` : '  ⇒ 卡池里没人用（预留的 op）') + note);
}

// ---------------------------------------------------------------- ①d 累加型字段
console.log('\n=== ①d 累加型字段的"回合重置"核查 ===');
console.log('  （写形如 `x.F = (x.F || 0) + n` 的字段，如果回合开始不归零，就会一回合涨一次）');
console.log('  （注意：局级计数器——如 seclusionUsed「本局闭关次数」——本来就不该每回合重置，需人工区分）');
const turnStart = lines.findIndex((l) => /^function startTurn\(/.test(l));
const turnEnd = lines.findIndex((l, i) => i > turnStart && /^\}/.test(l));
const turnBody = lines.slice(turnStart, turnEnd + 1).join('\n');
const accumFields = [];
{
  const re = /(?:self|pl|t|A|D)\.([A-Za-z_]\w*)\s*=\s*\((?:self|pl|t|A|D)\.\1\s*\|\|\s*0\)\s*\+/g;
  let m;
  while ((m = re.exec(engine)) !== null) if (accumFields.indexOf(m[1]) < 0) accumFields.push(m[1]);
}
for (const f of accumFields) {
  const reset = new RegExp(`\\.${f}\\s*=`).test(turnBody);
  const realRead = lines.some((l) => lineHasRealRead(l, f) && !new RegExp(`= \\((?:self|pl|t)\\.${f}`).test(l));
  const tag = !realRead ? '⛔ 只写不读（见 ①）' : (reset ? '✓ 回合开始重置' : '⚠️ 从不重置 → 数值逐回合累加');
  console.log(`  .${f}  ${tag}`);
}

// ---------------------------------------------------------------- ②③ 卡文 vs 实现
const PICK_WORDS = ['可使用', '可选择', '可放弃', '你可以选择', '可选择使', '可选择放弃', '可选择对方'];
const HURT_WORDS = [/受到任意伤害时/, /当你受到.*伤害/, /在对战失败时/, /生命值.*0点.*使用/, /受到伤害时/];

const rows = [];
for (const deck of DECKS) {
  for (const c of raw[deck] || []) {
    const all = [];
    for (const e of c.effects || []) all.push({ e: e, where: '主效果' });
    (c.tiers || []).forEach((t, i) => { for (const e of t.effects || []) all.push({ e: e, where: `第${i + 1}档` }); });
    if (!all.length) continue;
    const text = c.text || '';
    const flags = [];
    if (PICK_WORDS.some((w) => text.includes(w))) flags.push('需玩家选择');
    if (HURT_WORDS.some((re) => re.test(text))) flags.push('受伤/失败时点');
    for (const x of all) {
      // ⚠️ 时机比较走**归一化键**：卡池 2026-10-02 已从旧 `when` 迁到总线坐标，
      //    直接比 `x.e.when` 的话这条标记永远不会亮（静默失效）。
      if (META.timingKeys(x.e).some((k) => BOARD_KEYS.indexOf(k) >= 0) && c.type !== 'companion') {
        flags.push('场面效果出现在非同行者牌上');
      }
    }
    rows.push({ deck: deck, card: c, all: all, flags: [...new Set(flags)], text: text });
  }
}

const flagged = rows.filter((r) => r.flags.length);
console.log(`\n=== ②③ 需要人工核对的卡（${flagged.length} / ${rows.length} 张）===`);
for (const r of flagged) {
  console.log(`\n【${r.card.name}】(${r.deck}/${r.card.type}, 费用 ${r.card.cost})  标记: ${r.flags.join('、')}`);
  console.log(`   卡文: ${r.text}`);
  console.log('   实现: ' + r.all.map((x) => `${x.where} 时点=${timingOfRow(x.e)} op=${x.e.op}${x.e.value != null ? ' value=' + x.e.value : ''}`).join(' | '));
}

// ---------------------------------------------------------------- 全部卡一览（便于逐条对）
console.log('\n\n=== 全池逐条对照（卡文 → when/op）===');
for (const r of rows) {
  console.log(`\n[${r.deck}] 【${r.card.name}】`);
  console.log(`  卡文: ${r.text}`);
  for (const x of r.all) {
    console.log(`  → ${x.where}: 时点=${timingOfRow(x.e)} op=${x.e.op}${x.e.if ? ' if=' + JSON.stringify(x.e.if) : ''}${Object.keys(x.e).filter((k) => !['when', 'op', 'if', 'event', 'subject', 'phase', 'auto'].includes(k)).length ? ' ' + JSON.stringify(Object.fromEntries(Object.entries(x.e).filter(([k]) => !['when', 'op', 'if', 'event', 'subject', 'phase', 'auto'].includes(k)))) : ''}`);
  }
}

if (process.argv.includes('--md')) {
  const OUT = path.join(ROOT, 'docs', '时点触发审计.md');
  const cardsOf = (op) => {
    const out = [];
    for (const deck of DECKS) {
      for (const c of raw[deck] || []) {
        const has = (c.effects || []).some((e) => e.op === op) ||
          (c.tiers || []).some((t) => (t.effects || []).some((e) => e.op === op));
        if (has) out.push(`【${c.name}】(${deck})`);
      }
    }
    return out.join('、') || '（卡池里没人用）';
  };
  let md = '# 时点 / 触发 审计（机器产出，未改代码）\n\n';
  md += '> 由 `node tools/audit-timing.js --md` 生成。人工逐条核对后的结论见 `docs/时点触发不符清单.md`。\n\n';
  md += '审计分四层，逐层往下挖：\n\n';
  md += '1. **①字段层** —— op 写进玩家状态的字段，全引擎有没有人读。\n';
  md += '2. **①b 卡牌层** —— 这些死 op 分别被哪些卡用了。\n';
  md += '3. **①c 常驻层** —— `passive: true` 的 op 不走 switch，而是由 `passives(pl)` 汇总；单独核查汇总出来的键有没有人取用。\n';
  md += '4. **①d 生命周期层** —— 累加型字段（`x.F = (x.F||0)+n`）有没有在回合开始归零。\n\n';

  md += '## ① 只写不读的字段\n\n';
  md += '| 字段 | 对应 op | 出现处 | 判定 |\n|---|---|---|---|\n';
  for (const d of deadFields) {
    const ops = [...new Set(d.occ.map((o) => nearestCase(o.line)))];
    md += `| \`.${d.field}\` | ${ops.join(' / ')} | ${[...new Set(d.occ.map((o) => 'L' + o.line))].join(', ')} | 全是赋值，无读取点 |\n`;
  }
  md += '\n## ①b 死 op 影响的卡\n\n';
  md += '| op | 常驻类 | 受影响卡 |\n|---|---|---|\n';
  for (const op of deadOps) {
    md += `| \`${op}\` | ${META.OPS[op] && META.OPS[op].passive ? '是' : '否'} | ${cardsOf(op)} |\n`;
  }
  md += '\n## ①c 常驻 op 通道（passives() 汇总后没人取用）\n\n';
  if (!orphanPassive.length) md += '（无）\n';
  for (const op of orphanPassive) {
    md += `- \`${op}\` ⇒ ${cardsOf(op)}${PASSIVE_NOTES[op] ? '  \n  ⓘ ' + PASSIVE_NOTES[op] : ''}\n`;
  }
  md += '\n## ①d 累加型字段的回合重置核查\n\n';
  md += '| 字段 | 判定 |\n|---|---|\n';
  for (const f of accumFields) {
    const reset = new RegExp(`\\.${f}\\s*=`).test(turnBody);
    const realRead = lines.some((l) => lineHasRealRead(l, f) && !new RegExp(`= \\((?:self|pl|t)\\.${f}`).test(l));
    md += `| \`.${f}\` | ${!realRead ? '只写不读' : (reset ? '回合开始重置 ✓' : '从不重置（需人工判断是回合级还是局级）')} |\n`;
  }
  md += `\n## ② 需要人工核对的卡（${flagged.length} / ${rows.length} 张有实现的卡）\n\n`;
  for (const r of flagged) {
    md += `### 【${r.card.name}】\n\n`;
    md += `- 牌堆：${r.deck} / 类型：${r.card.type} / 费用：${r.card.cost}\n`;
    md += `- 机检标记：${r.flags.join('、')}\n`;
    md += `- 卡文：${r.text}\n`;
    md += `- 实现：${r.all.map((x) => `\`${x.where} when=${x.e.when} op=${x.e.op}\``).join('，')}\n\n`;
  }
  md += '\n## ③ 全池逐条对照\n\n';
  for (const r of rows) {
    md += `**${r.card.name}**（${r.deck} / ${r.card.type}）\n\n`;
    md += `> ${r.text}\n\n`;
    for (const x of r.all) md += `- \`${x.where}\` → \`when=${x.e.when}\` (${META.whenLabel(x.e.when)}) / \`op=${x.e.op}\`\n`;
    md += '\n';
  }
  fs.writeFileSync(OUT, md, 'utf8');
  console.log(`\n已写出 ${path.relative(ROOT, OUT)}`);
}

console.log(`\n汇总：只写不读字段 ${deadFields.length} 个；需人工核对卡 ${flagged.length} 张 / 共 ${rows.length} 张有实现的卡`);
