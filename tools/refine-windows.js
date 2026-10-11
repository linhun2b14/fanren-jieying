'use strict';
// 时点审计：**按卡文**推断每张牌该在哪个窗口生效，跟数据里的 when 对照，列出所有不符的。
//
// 为什么要有这个：效果 DSL 把「时机」变成数据之后，数据写错了引擎不会报错，
// 只会表现成"这张牌在某个时刻点不动/乱能点"这种很难发现的 bug
// （用户报的例子：对方指定我为对战目标时，【阴魂丝】打不出来）。
// 所以用卡文里的时机词做一次全池扫描。
//
// 用法：
//   node tools/refine-windows.js          # 只看差异（dry-run）
//   node tools/refine-windows.js --apply  # 把推断出来的窗口落盘
const fs = require('fs');
const path = require('path');
const META = require('../server/effect-meta');

const FILE = path.join(__dirname, '..', 'data', 'cards.json');
const APPLY = process.argv.includes('--apply');

// ---------------------------------------------------------------- 卡文 → 窗口
//
// 顺序敏感：越具体的规则放越前面（「对方投掷骰子后」不能被「投掷骰子后」先吃掉）。
// `scope` 限定只对某些牌堆/类型生效，避免把场面自动触发的效果也改掉。
const RULES = [
  // ---- 对方投骰 前/后（必须先于"我方"规则，因为卡文里是"对方投掷骰子后"）----
  { re: /对方投掷骰子后/, when: 'afterFoeRoll', scope: 'playable' },
  { re: /对方投掷骰子前/, when: 'beforeFoeRoll', scope: 'playable' },
  // ---- 我方投骰 前/后 ----
  { re: /投掷骰子后/, when: 'afterMyRoll', scope: 'playable' },
  { re: /投掷骰子前/, when: 'beforeMyRoll', scope: 'playable' },
  // ---- 出牌阶段 ----
  { re: /出牌阶段/, when: 'combatStart', scope: 'playable' },
  // ---- 被指定为对战目标（对方发起对战时，我要能在对战开始前打出）----
  { re: /被指定为对战目标|无法在本次对战|本次对战中的/, when: 'combatStart', scope: 'playable' },
  // ---- 结算后窗口 ----
  { re: /对战平局时/, when: 'tie', scope: 'playable' },
  { re: /对战获胜时|对战胜利时|对战获胜后/, when: 'win', scope: 'playable' },
  { re: /对战失败时/, when: 'lose', scope: 'playable' },
  // ---- 任意回合 / 自己的回合（最后才判断，避免吃掉上面更具体的）----
  { re: /在任意回合使用/, when: 'play', scope: 'playable' },
  { re: /在自己的回合使用|在自己的回合时使用/, when: 'play', scope: 'playable' },
];

/**
 * 这张效果该不该参与"按卡文推断窗口"。
 * 加这些限制是因为盲推会误伤：
 *   · 同行者的 win/lose/turn 都是**场面自动触发**，不是出牌窗口
 *   · 有 tiers 的卡，卡面 effects 是**死代码**（引擎只读所选档位的 effects）
 *   · `win`/`lose`/`place`/`afterCombat`/`turn`/... 这些窗口在迁移时**已按语义分配好**，
 *     不该被关键词再改一遍（否则【敛气术】的"获胜时对方受伤 2"会被改成出牌阶段）
 *   · 低境界装备的 `combat_bonus 0` 是**「对战启用费」的标记**（如【绿煌剑】付 3 点），
 *     必须留在对战窗口，否则那笔启用费永远收不到
 */
function skipReason(card, e, isTier, rule) {
  if (!META.isPlayWindow(e.when)) return '非出牌窗口';
  if (card.type === 'companion') return '同行者是场面自动触发';
  if (!isTier && (card.tiers || []).length) return '有档位的卡，卡面效果是死代码';
  if (e.when !== 'combatStart' && e.when !== 'play') return '窗口已按语义分配过';
  if (META.OPS[e.op] && META.OPS[e.op].requiresCombat) return '该 op 必须在对战中（requiresCombat）';
  // 低境界装备的「对战启用费」标记：它必须留在**对战窗口**里（引擎按 op 找它并收启用费），
  // 但移到"我方投骰前"这类更精确的对战窗口是安全的（【黑血刀】【青竹蜂云剑】卡文就是"投骰前"）。
  // 只有当推断结果落到"结算后窗口"（win/lose/tie）时才跳过 —— 那种窗口它根本打不出去。
  if (!isTier && card.type === 'equip' && (card.realm || 0) < 2 && (card.cost || 0) > 0) {
    if (rule && !META.isRollWindow(rule.when) && rule.when !== 'combatStart') {
      return '低境界装备的「对战启用费」标记，不能挪到结算后窗口';
    }
  }
  return null;
}

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const decks = ['treasure', 'spell', 'companion', 'qi'];

function infer(text) {
  for (const r of RULES) if (r.re.test(text || '')) return r;
  return null;
}

const changes = [];
const noRule = [];
const skipped = [];

for (const deck of decks) {
  for (const c of raw[deck] || []) {
    // 卡面效果 + 各档位效果；档位效果用**该档自己的文字**推断
    const spots = [];
    for (const e of c.effects || []) spots.push({ e: e, isTier: false, text: c.text, label: '' });
    (c.tiers || []).forEach((t, i) => {
      for (const e of t.effects || []) spots.push({ e: e, isTier: true, text: t.text || c.text, label: `（第${i + 1}档）` });
    });
    for (const s of spots) {
      const rule = infer(s.text);
      const why = skipReason(c, s.e, s.isTier, rule);
      if (why) { if (META.isPlayWindow(s.e.when)) skipped.push(`【${c.name}】${s.label} [${s.e.when}] — ${why}`); continue; }
      if (!rule) {
        if (META.isCombatWindow(s.e.when)) noRule.push(`【${c.name}】${s.label} 现在是对战窗口(${s.e.when})，但卡文里找不到时机词`);
        continue;
      }
      if (s.e.when !== rule.when) {
        changes.push({ card: c, e: s.e, from: s.e.when, to: rule.when, why: rule.re.source, label: s.label });
      }
    }
  }
}

console.log('=== 时点审计（按卡文全池扫描）===\n');
console.log(`扫描了 ${decks.reduce((n, d) => n + (raw[d] || []).length, 0)} 张卡，发现 ${changes.length} 处窗口与卡文不符：\n`);

const WHEN_DETAIL = {
  play: '自己回合行动阶段，随时可打',
  combatStart: '对战刚开始、双方都还没投骰时（含"对方指定我为目标、对战阶段开始前"）',
  beforeMyRoll: '轮到我投骰之前',
  afterMyRoll: '我投完骰之后',
  beforeFoeRoll: '对方还没投骰之前',
  afterFoeRoll: '对方投完骰之后',
  tie: '双方战力持平、进入平局改判窗口时',
  win: '本次对战已判我获胜之后',
  lose: '本次对战已判我落败之后',
};

for (const ch of changes) {
  console.log(`【${ch.card.name}】${ch.label}  ${ch.from} → ${ch.to}`);
  console.log(`    卡文命中：/${ch.why}/`);
  console.log(`    现在能打：${WHEN_DETAIL[ch.from] || ch.from}`);
  console.log(`    改完能打：${WHEN_DETAIL[ch.to] || ch.to}`);
  console.log('');
}

if (noRule.length) {
  console.log(`【提示】${noRule.length} 处是对战窗口但卡文没写时机词，保持原样：`);
  for (const n of noRule) console.log('  · ' + n);
  console.log('');
}
if (skipped.length) {
  console.log(`【已刻意跳过】${skipped.length} 处（避免误伤，见 skipReason 注释）：`);
  for (const s of skipped) console.log('  · ' + s);
  console.log('');
}

// 窗口分布
const dist = {};
for (const deck of decks) for (const c of raw[deck] || []) {
  for (const e of c.effects || []) dist[e.when] = (dist[e.when] || 0) + 1;
  for (const t of c.tiers || []) for (const e of t.effects || []) dist[e.when] = (dist[e.when] || 0) + 1;
}
console.log('全池窗口分布：');
for (const w of Object.keys(dist).sort((a, b) => dist[b] - dist[a])) {
  console.log(`  ${String(dist[w]).padStart(3)}  ${w.padEnd(14)} ${META.whenLabel(w)}`);
}

if (!APPLY) { console.log('\n（dry-run，未写入。加 --apply 才落盘）'); process.exit(0); }

for (const ch of changes) ch.e.when = ch.to;
const json = JSON.stringify(raw, null, 2) + '\n';
if (/\uFFFD/.test(json)) { console.error('结果含 U+FFFD，未写入'); process.exit(1); }
fs.writeFileSync(FILE, json, 'utf8');
console.log(`\n已写入 ${FILE}（${changes.length} 处）`);
