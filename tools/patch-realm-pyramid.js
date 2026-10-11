'use strict';
// 按实物重排卡池：
//   1) 境界需求改成金字塔：凡人50% / 炼气25% / 筑基15% / 结丹10% / 元婴0（到元婴就胜利，不该有元婴牌）
//   2) 丹药类一律 0 费
//   3) 法术类装备（spell 的 equip）加 tiers —— 按境界解锁多档效果、装备时选 1 档（实物：青元剑诀）
//   4) 新增实物里的【啼魂】同行者：承受任意 1 次伤害后进弃牌堆（absorb）
const fs = require('fs');
const P = 'data\\cards.json';
const d = JSON.parse(fs.readFileSync(P, 'utf8'));

// ---- 1) 境界重排（按卡名指定，等价于按强度排序） ----
const REALM = {
  // 宝物 · 装备
  '落云宗令牌': 0, '青竹蜂云剑': 0, '金蚣剑': 0, '天鬼珠': 0, '银月轮': 0,
  '太乙五烟罗': 1, '掌天瓶': 1, '元阳磁光': 1, '虚天鼎': 1,
  '元磁神山': 2, '玄天斩灵剑': 3,
  // 宝物 · 消耗
  '施地符': 0, '火球符': 0, '金光罩符': 0, '化灵符': 0, '补元丹': 0, '千机符': 0,
  '定身符': 0, '傀儡符': 0,
  '血影遁符': 1, '阴罗幡': 1,
  '雷霆符': 2, '天雷子': 2,
  '凝婴丹': 3,
  // 法术 · 装备
  '长春功': 0, '大衍决': 0, '青元剑诀': 1, '元磁神光': 1,
  '大衍宝典': 2, '焚天魔功': 2, '太乙化清符': 3,
  // 法术 · 消耗
  '引气术': 0, '御风诀': 0, '吐纳术': 0, '凝神诀': 0, '回灵诀': 0, '烈焰术': 0, '玄冰诀': 0,
  '金网术': 1, '大衍神算': 1, '万剑诀': 1, '阴光遁': 1,
  '夺心术': 2, '聚灵大法': 2, '毒手': 3,
  '夺天造化': 3,
};

// ---- 3) 法术类装备的多境界档位（第一档境界 = 该卡的适用境界） ----
const TIERS = {
  '长春功': [
    { realm: 0, text: '凡人期：你的手牌上限 +1。', effect: { kind: 'hand_limit_bonus', value: 1 } },
    { realm: 1, text: '炼气期：每回合开始额外恢复 1 点法力值。', effect: { kind: 'mana_regen_bonus', value: 1 } },
    { realm: 2, text: '筑基期：晋升境界所需灵气值减少 1 点。', effect: { kind: 'promote_discount', value: 1 } },
  ],
  '大衍决': [
    { realm: 0, text: '凡人期：晋升境界所需灵气值减少 1 点。', effect: { kind: 'promote_discount', value: 1 } },
    { realm: 1, text: '炼气期：每回合开始额外恢复 1 点法力值。', effect: { kind: 'mana_regen_bonus', value: 1 } },
    { realm: 2, text: '筑基期：晋升境界掷骰后可重掷一次。', effect: { kind: 'reroll', scope: 'promote' } },
  ],
  // 实物截图（图2）原文照抄
  '青元剑诀': [
    { realm: 1, text: '炼气期：在对战中投掷骰子前使用，使本次对战中骰子点数+1（最高为6点）。',
      effect: { kind: 'dice_bonus', value: 1, cap: 6 } },
    { realm: 2, text: '筑基期：在对战中投掷骰子后使用，可额外投掷1次骰子，取点数最大值。',
      effect: { kind: 'reroll_dice', value: 1 } },
    { realm: 3, text: '结丹期：在对战中出牌阶段使用，使本次对战中自身的【战力值】+1。',
      effect: { kind: 'combat_bonus', value: 1 } },
  ],
  '元磁神光': [
    { realm: 1, text: '炼气期：对手本场对战最终战力 -1。', effect: { kind: 'combat_debuff', value: 1 } },
    { realm: 2, text: '筑基期：对手本场对战最终战力 -2。', effect: { kind: 'combat_debuff', value: 2 } },
  ],
  '大衍宝典': [
    { realm: 2, text: '筑基期：每回合开始额外恢复 1 点法力值。', effect: { kind: 'mana_regen_bonus', value: 1 } },
    { realm: 3, text: '结丹期：每回合开始额外恢复 2 点法力值。', effect: { kind: 'mana_regen_bonus', value: 2 } },
  ],
  '焚天魔功': [
    { realm: 2, text: '筑基期：你参与的每场对战最终战力 +1。', effect: { kind: 'combat_bonus', value: 1 } },
    { realm: 3, text: '结丹期：你参与的每场对战最终战力 +2。', effect: { kind: 'combat_bonus', value: 2 } },
  ],
  '太乙化清符': [
    { realm: 3, text: '结丹期：晋升境界掷骰后可重掷一次。', effect: { kind: 'reroll', scope: 'promote' } },
  ],
};

let changed = 0, missing = [];
for (const deck of ['treasure', 'spell']) {
  for (const c of d[deck]) {
    if (!(c.name in REALM)) { missing.push(c.name); continue; }
    c.realm = REALM[c.name];
    // 2) 丹药 0 费
    if (/丹$/.test(c.name)) { c.cost = 0; }
    // 3) 法术类装备加档位
    if (deck === 'spell' && c.type === 'equip' && TIERS[c.name]) {
      c.tiers = TIERS[c.name];
      c.effect = TIERS[c.name][0].effect;      // 保留 effect 作为第一档（向后兼容）
      c.text = '（达到对应境界后，装备时选 1 个效果生效）' + TIERS[c.name].map((t) => t.text).join('');
    }
    changed++;
  }
}
if (missing.length) { console.error('未指定境界的卡:', missing.join('、')); process.exit(1); }

// 4) 新增实物里的啼魂（图3）：替你承受任意 1 次伤害后进弃牌堆
if (!d.companion.some((c) => c.id === 'tihun')) {
  d.companion.push({
    id: 'tihun', name: '啼魂', type: 'companion', cost: null, realm: 0, count: 2, slots: 1, absorb: true,
    text: '此【同行者】可替你承受任意1次伤害，之后此【同行者】放入【弃牌堆】。对战时，【战力值】+1。',
    onTurn: null,
    onCombat: { kind: 'combat_bonus', value: 1 },
    onPromote: null,
  });
}

fs.writeFileSync(P, JSON.stringify(d, null, 1), 'utf8');

// ---- 校验 ----
const R = ['凡人', '炼气', '筑基', '结丹', '元婴'];
const tally = [0, 0, 0, 0, 0];
for (const deck of ['treasure', 'spell']) for (const c of d[deck]) tally[c.realm || 0] += c.count;
const total = tally.reduce((a, b) => a + b, 0);
console.log(`改动 ${changed} 张；同行者新增啼魂，共 ${d.companion.length} 种`);
console.log(`境界分布（共 ${total} 张）：`);
R.forEach((r, i) => console.log(`  ${r.padEnd(3)} ${String(tally[i]).padStart(3)} 张  ${(tally[i] / total * 100).toFixed(1)}%`));
console.log('目标：凡人50% / 炼气25% / 筑基15% / 结丹10% / 元婴0');
console.log('丹药费用:', d.treasure.filter((c) => /丹$/.test(c.name)).map((c) => `${c.name}=${c.cost}`).join(' '));
console.log('带档位的法术装备:', d.spell.filter((c) => c.tiers).map((c) => `${c.name}(${c.tiers.length}档,起${R[c.realm]})`).join(' / '));
console.log('啼魂 absorb:', !!d.companion.find((c) => c.id === 'tihun').absorb);
