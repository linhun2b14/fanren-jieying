'use strict';
// 第六批：把最后几张「完全未实装」的卡补上（引擎侧已加好「主动技能」机制）。
//   【李化元】放置时取走【青元剑诀】并无视境界；牌堆无该牌则弃自身抽 1 张同行者
//   【梅凝】主动使用：回 1 血 + 抽 3 张宝物牌，之后自身进弃牌堆
//   【青易居士】探索阶段主动使用：弃 1 张宝物牌，改抽 1 张法术牌
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'cards.json');
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const log = [];
const CP = (n) => raw.companion.find((c) => c.name === n);

// ---- 李化元 ----
{
  const c = CP('李化元');
  if (!c) { console.error('✗ 没有【李化元】'); process.exit(1); }
  c.effects = [{ when: 'place', op: 'grant_spell', name: '青元剑诀', deck: 'spell', fallback: true }];
  delete c.note;
  log.push('【李化元】放置时取走【青元剑诀】并无视境界；牌堆无该牌则弃自身抽 1 张同行者');
}

// ---- 梅凝 ----
{
  const c = CP('梅凝');
  if (!c) { console.error('✗ 没有【梅凝】'); process.exit(1); }
  c.effects = [
    { when: 'activate', op: 'heal', value: 1 },
    { when: 'activate', op: 'draw_treasure', value: 3 },
  ];
  c.activateDiscardSelf = true;   // 「之后此【同行者】放入【弃牌堆】」
  delete c.note;
  log.push('【梅凝】主动使用：回 1 血 + 抽 3 张宝物牌，之后自身进弃牌堆');
}

// ---- 青易居士 ----
{
  const c = CP('青易居士');
  if (!c) { console.error('✗ 没有【青易居士】'); process.exit(1); }
  c.effects = [
    { when: 'activate', op: 'draw', deck: 'spell', value: 1, onlyStep: 'draw_treasure', cost: { discard: 'treasure' } },
  ];
  delete c.note;
  log.push('【青易居士】探索阶段主动使用：弃 1 张宝物牌，改抽 1 张法术牌');
}

// ---- 陈巧倩：卡文引用的【补气丹】【回气丹】不在卡池里，但机制本身已实装 ----
{
  const c = CP('陈巧倩');
  if (c) {
    c.effects = [{ when: 'passive', op: 'double_card_effect', names: ['补气丹', '回气丹'] }];
    c.note = '机制（使用指定丹药时效果翻倍并自身离场）已实装为 op=double_card_effect；'
      + '但卡文引用的【补气丹】/【回气丹】不在已抄录卡池中（全池只有 血凝五行丹、九曲灵参丹），'
      + '所以这两张牌抄到之前不会有任何实际效果';
    log.push('【陈巧倩】实装 double_card_effect 机制（等【补气丹】【回气丹】抄到即生效）');
  }
}

// ---- 校验 ----
const TARGET = { treasure: 80, spell: 33, companion: 78, qi: 60 };
let bad = false;
for (const d of Object.keys(TARGET)) {
  const n = (raw[d] || []).reduce((s, x) => s + (x.count || 1), 0);
  if (n !== TARGET[d]) { console.error(`✗ ${d} 张数 ${n} != ${TARGET[d]}`); bad = true; }
}
if (bad) { console.error('数量校验失败，未写入'); process.exit(1); }
const json = JSON.stringify(raw, null, 2) + '\n';
if (/\uFFFD/.test(json)) { console.error('结果含 U+FFFD，未写入'); process.exit(1); }
fs.writeFileSync(FILE, json, 'utf8');
console.log('变更：');
for (const l of log) console.log('  ' + l);
