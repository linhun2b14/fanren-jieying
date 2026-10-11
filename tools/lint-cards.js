'use strict';
// 卡牌一致性体检：把**卡文**和**效果数据**对照，自动找出
//   · 硬错误（op/when/if 条件写错、数据自相矛盾）
//   · 卡文写了但没实现的牌（以前这份清单靠人工比对，会漏）
//   · 数据有但卡文没说清的牌
//   · 数字对不上（卡文说「抽 3 张」，数据写 2）
//
// 用法：
//   node tools/lint-cards.js            # 打印报告（硬错误会返回非 0）
//   node tools/lint-cards.js --md       # 同时写出 docs/卡牌实装覆盖率.md
const fs = require('fs');
const path = require('path');
const META = require('../server/effect-meta');

const ROOT = path.join(__dirname, '..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cards.json'), 'utf8'));
const DECKS = ['treasure', 'spell', 'companion', 'qi'];
const DECK_CN = { treasure: '宝物', spell: '法术', companion: '同行者', qi: '灵气' };

const hard = [];      // 必须修
const warn = [];      // 提示
const gaps = [];      // 卡文有、数据没有
const extra = [];     // 数据有、卡文没写清

/**
 * 一张卡的全部效果条目（含各档位 + **掷骰分支的子效果**）。
 * ⚠️ `roll_branch` 的 `branches[].effects` / `else` 也要递归进来 —— 否则分支里的 op
 *    会绕过"op 在不在元数据表里"这道检查（＝漏掉"只写不读的幽灵效果"）。
 */
function allEffects(c) {
  const out = [];
  const walk = (e, where, nested) => {
    out.push({ e: e, where: where, nested: !!nested });
    if (e && e.op === 'roll_branch') {
      for (const b of (e.branches || [])) for (const s of (b.effects || [])) walk(s, where + '·掷骰支线', true);
      for (const s of (e.else || [])) walk(s, where + '·掷骰兜底', true);
    }
  };
  for (const e of c.effects || []) walk(e, '主效果', false);
  (c.tiers || []).forEach((t, i) => {
    for (const e of t.effects || []) walk(e, `第${i + 1}档`, false);
  });
  return out;
}

// ---------------------------------------------------------------- 硬错误 + 覆盖
// ⭐ 「字段型实装」：有些卡的效果**不用 effects 表达**，而是靠引擎直接读卡面上的字段 ——
//    【啼魂】【离龟】【厉飞雨】【曲魂】【胡月】的替挡 `absorb`、【齐云霄】的 `cardCostDiscount`、
//    【胡月】的 `companionSlotBonus`。以前这类卡被算成"完全未实装"（假红），这里放行。
const FIELD_IMPL = ['absorb', 'soak', 'cardCostDiscount', 'companionSlotBonus', 'damageSave'];
const fieldImplemented = (c) => FIELD_IMPL.some((f) => c[f] != null);
for (const deck of DECKS) {
  for (const c of raw[deck] || []) {
    const list = allEffects(c);
    // 「稀薄灵气」= 纯 1 点灵气值，本来就没有附加效果，不算未实装
    const isPlainQi = deck === 'qi' && !c.effect;
    if (!list.length && !isPlainQi && !fieldImplemented(c) && !/未拍到|待补/.test(c.text || '')) {
      // effects 一条都没有 = 完全没实装（note 里通常写着为什么）
      gaps.push({ kind: 'full', deck: deck, name: c.name, why: c.note || '卡文有内容，但 effects 是空的', text: c.text });
    } else if (c.note && /待实装|未实装|暂未实现|需要新\s*op|缺哪|待补/.test(c.note)
      // ⚠️ 但注明"**已**实装/不是未实装"的说明性 note 不算 —— 否则【厉飞雨】【曲魂】这种
      //    "字段型实装 + 写了说明"的卡又被列进未实装桶（2026-10-05 第 10 件修）
      && !/已实装|不是未实装/.test(c.note)) {
      // ⚠️ 只有**note 里真的写了"缺什么"**才算"部分未实装"。
      //    以前凡是带 note 的一律进这个桶 —— 于是"已实装 + 写了说明"的卡也被列成未实装（假红）。
      gaps.push({ kind: 'partial', deck: deck, name: c.name, why: c.note, text: c.text });
    }
    for (const x of list) {
      const e = x.e;
      if (!e.op) hard.push(`【${c.name}】${x.where} 缺 op`);
      // 时点两种写法都合法：老写法 when，总线写法 {event, subject?, phase?}
      // （engineDirect 例外已废：【青易居士】explore_swap 自 2026-10-05 起挂在探索时点，全池无 engineDirect op）
      // ⚠️ `roll_branch` 的**支线子效果不算**：它们不声明时点，跟着父节点那条掷骰一起结算。
      if (!x.nested && !e.when && !e.event) hard.push(`【${c.name}】${x.where} 既没有 when 也没有 event（没声明时点）`);
      if (e.event && !META.EVENTS[e.event]) hard.push(`【${c.name}】${x.where} 的 event「${e.event}」不在事件表里`);
      if (e.event && e.phase && META.EVENTS[e.event] && META.EVENTS[e.event].phases.indexOf(e.phase) < 0) {
        hard.push(`【${c.name}】${x.where} 的阶段「${e.phase}」没有被事件「${e.event}」声明`);
      }
      if (e.op && !META.OPS[e.op]) hard.push(`【${c.name}】${x.where} 的 op「${e.op}」不在元数据表里`);
      if (e.when && !META.WHEN[e.when]) hard.push(`【${c.name}】${x.where} 的 when「${e.when}」不在时机表里`);
      if (e.if) {
        for (const k of Object.keys(e.if)) {
          if (!META.CONDITIONS[k]) hard.push(`【${c.name}】${x.where} 的 if 条件「${k}」不在条件表里（引擎会 fail-closed 直接不生效）`);
        }
      }
      // 需要目标的 op 一定是「指定…」，卡文里也该有「指定 / 选择」。
      // 只查**出牌窗口**的效果：同行者的 win/turn 等是场面自动触发，目标由引擎决定
      // （【韩立】获胜夺装备就是自动挑败者，不需要玩家指定）。
      if (c.type !== 'companion' && META.isPlayEffect(e) && META.timingKey(e) !== 'place'
        && META.OPS[e.op] && META.OPS[e.op].needsTarget && !/指定|选择/.test(c.text || '')) {
        warn.push(`【${c.name}】${x.where} 的 op「${e.op}」需要目标，但卡文里没有「指定」字样`);
      }
    }
  }
}

// ---------------------------------------------------------------- 数字交叉核对
// 只对「已实装」的卡做（未实装的卡少效果是正常的，别重复报）
const gapNames = new Set(gaps.map((g) => g.name));
/** 收集某张卡上某些 op 的全部数值 */
const valsOf = (c, ops) => {
  const out = [];
  for (const x of allEffects(c)) {
    if (ops.indexOf(x.e.op) < 0) continue;
    if (typeof x.e.value === 'number') out.push(x.e.value);
    if (typeof x.e.reviveTo === 'number') out.push(x.e.reviveTo);
    if (typeof x.e.selfDamage === 'number') out.push(x.e.selfDamage);   // 【真凰符】先自伤 1 再群伤 2
    if (typeof x.e.onWinDamage === 'number') out.push(x.e.onWinDamage);
    if (typeof x.e.damage === 'number') out.push(x.e.damage);
  }
  return out;
};
const DRAW_OPS = ['draw', 'draw_treasure', 'draw_qi', 'draw_mixed', 'place_draw_qi', 'win_draw_qi', 'on_promote_draw_qi'];
const DMG_OPS = ['damage', 'damage_target', 'damage_multi', 'damage_all_others', 'damage_attacker',
  'damage_and_skip', 'self_damage_then_multi', 'win_extra_damage', 'risky_win_damage', 'lose_retaliate',
  'selfLoseDamage', 'damage_higher_realm'];

for (const deck of DECKS) {
  for (const c of raw[deck] || []) {
    const t = c.text || '';
    if (/未拍到|待补/.test(t) || gapNames.has(c.name)) continue;

    // 「恢复 N 点生命值」
    const healM = t.match(/恢复\s*(\d+)\s*点【?生命值】?/);
    if (healM) {
      const want = Number(healM[1]);
      const got = valsOf(c, ['heal', 'low_hp_rescue', 'self_revive']);
      if (got.length && got.indexOf(want) < 0) warn.push(`【${c.name}】卡文说恢复 ${want} 点生命，数据里的 heal 值是 [${got}]`);
    }
    // 「抽取 N 张」
    const drawM = t.match(/抽取\s*(\d+)\s*张/);
    if (drawM) {
      const want = Number(drawM[1]);
      const got = valsOf(c, DRAW_OPS);
      // draw_mixed 用的是 treasure/spell 字段而不是 value，单独取
      for (const x of allEffects(c)) {
        if (x.e.op === 'draw_mixed') { if (typeof x.e.treasure === 'number') got.push(x.e.treasure); if (typeof x.e.spell === 'number') got.push(x.e.spell); }
      }
      if (got.length && got.indexOf(want) < 0) warn.push(`【${c.name}】卡文说抽 ${want} 张，数据里的抽牌数是 [${got}]`);
    }
    // 「受到 N 点伤害」—— 用集合判断，因为一张牌可能有多个伤害数值（【真凰符】先自伤1再群伤2）
    const dmgRe = /受到\s*(\d+)\s*点(?:伤害|【伤害】)/g;
    let dm;
    const wantDmg = [];
    while ((dm = dmgRe.exec(t)) !== null) wantDmg.push(Number(dm[1]));
    if (wantDmg.length) {
      const got = valsOf(c, DMG_OPS);
      for (const w of wantDmg) {
        if (got.length && got.indexOf(w) < 0) warn.push(`【${c.name}】卡文说 ${w} 点伤害，数据里的伤害值是 [${got}]`);
      }
    }
    // 「装备时消耗 N 点法力值」vs equipCost/cost —— 精确检查，不做泛化的"消耗N点法力"
    const eqM = t.match(/装备时消耗\s*(\d+)\s*点【?法力值】?/);
    if (eqM) {
      const want = Number(eqM[1]);
      const actual = (c.equipCost != null) ? c.equipCost : c.cost;
      if (actual !== want) warn.push(`【${c.name}】卡文说装备时消耗 ${want} 点法力，equipCost/cost 是 ${actual}`);
    }
  }
}

// ---------------------------------------------------------------- 报告
const total = DECKS.reduce((s, d) => s + (raw[d] || []).length, 0);
const effectCount = DECKS.reduce((s, d) => s + (raw[d] || []).reduce((a, c) => a + allEffects(c).length, 0), 0);

console.log('=== 卡池一致性体检 ===');
console.log(`${total} 种卡 / ${effectCount} 条效果\n`);

console.log(`【硬错误】${hard.length} 处`);
for (const h of hard) console.log('  ✗ ' + h);
if (!hard.length) console.log('  ✓ 无');

const fullGaps = gaps.filter((g) => g.kind === 'full');
const partGaps = gaps.filter((g) => g.kind === 'partial');

console.log(`\n【完全未实装（卡文有、effects 为空）】${fullGaps.length} 张`);
for (const g of fullGaps) console.log(`  ⚠ [${DECK_CN[g.deck]}]【${g.name}】${g.text}`);
if (!fullGaps.length) console.log('  ✓ 无');

console.log(`\n【部分未实装（有 note 标注缺什么）】${partGaps.length} 张`);
for (const g of partGaps) console.log(`  ⚠ [${DECK_CN[g.deck]}]【${g.name}】${g.why}`);
if (!partGaps.length) console.log('  ✓ 无');

console.log(`\n【数字/描述可能对不上】${warn.length} 处`);
for (const w of warn) console.log('  ? ' + w);
if (!warn.length) console.log('  ✓ 无');

// 窗口分布
const dist = {};
for (const deck of DECKS) for (const c of raw[deck] || []) for (const x of allEffects(c)) dist[x.e.when] = (dist[x.e.when] || 0) + 1;
console.log('\n【时机窗口分布】');
for (const w of Object.keys(dist).sort((a, b) => dist[b] - dist[a])) {
  console.log(`  ${String(dist[w]).padStart(3)}  ${w.padEnd(14)} ${META.whenLabel(w)}`);
}

if (process.argv.includes('--md')) {
  let md = '# 卡牌实装覆盖率（自动生成）\n\n';
  md += '> 由 `tools/lint-cards.js --md` 从 `data/cards.json` 与卡文自动比对生成，**不要手改**。\n';
  md += `> 共 ${total} 种卡 / ${effectCount} 条效果。\n\n`;
  md += `## 完全未实装（${fullGaps.length} 张）\n\n`;
  if (!fullGaps.length) md += '（无）\n';
  else {
    md += '| 牌堆 | 卡名 | 实物卡文 |\n|---|---|---|\n';
    for (const g of fullGaps) md += `| ${DECK_CN[g.deck]} | ${g.name} | ${String(g.text || '').replace(/\|/g, '\\|')} |\n`;
  }
  md += `\n## 部分未实装（${partGaps.length} 张）\n\n`;
  if (!partGaps.length) md += '（无）\n';
  else {
    md += '| 牌堆 | 卡名 | 还没做的部分 |\n|---|---|---|\n';
    for (const g of partGaps) md += `| ${DECK_CN[g.deck]} | ${g.name} | ${g.why} |\n`;
  }
  md += `\n## 数字/描述待核对（${warn.length} 处）\n\n`;
  if (!warn.length) md += '（无）\n';
  else for (const w of warn) md += `- ${w}\n`;
  md += `\n## 硬错误（${hard.length} 处）\n\n`;
  if (!hard.length) md += '（无）\n';
  else for (const h of hard) md += `- ${h}\n`;
  md += '\n## 时机窗口分布\n\n| 次数 | 窗口 | 含义 |\n|---|---|---|\n';
  for (const w of Object.keys(dist).sort((a, b) => dist[b] - dist[a])) md += `| ${dist[w]} | \`${w}\` | ${META.whenLabel(w)} |\n`;
  const OUT = path.join(ROOT, 'docs', '卡牌实装覆盖率.md');
  fs.writeFileSync(OUT, md, 'utf8');
  console.log(`\n已写出 ${path.relative(ROOT, OUT)}`);
}

console.log(`\n结论：硬错误 ${hard.length}，未实装 ${gaps.length} 张，待核对 ${warn.length} 处`);
process.exit(hard.length ? 1 : 0);
