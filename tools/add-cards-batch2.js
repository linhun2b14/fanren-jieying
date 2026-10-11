'use strict';
// 把用户后续补拍的 6 张真卡加进卡池，并重新配平到官方总数（宝物80/法术33/同行者78/灵气60）。
const fs = require('fs');
const P = 'data\\cards.json';
const d = JSON.parse(fs.readFileSync(P, 'utf8'));
const TOTAL = { treasure: 80, spell: 33, companion: 78, qi: 60 };
const id = (n) => 'k_' + Buffer.from(n, 'utf8').toString('hex').slice(0, 12);

const NEW = {
  spell: [
    {
      id: id('青元剑诀'), name: '青元剑诀', type: 'equip', cost: 2, realm: 1, count: 1,
      cat: '装备类法术',
      text: '（达到对应境界后，对战时，选1个效果触发）炼气期：在对战中投掷骰子前使用，使本次对战中骰子点数+1（最高为6点）。筑基期：在对战中投掷骰子后使用，可额外投掷1次骰子，取点数最大值。结丹期：在对战中出牌阶段使用，使本次对战中自身的【战力值】+1。',
      effect: { kind: 'dice_bonus', value: 1, cap: 6 },
      tiers: [
        { realm: 1, text: '炼气期：在对战中投掷骰子前使用，使本次对战中骰子点数+1（最高为6点）。', effect: { kind: 'dice_bonus', value: 1, cap: 6 } },
        { realm: 2, text: '筑基期：在对战中投掷骰子后使用，可额外投掷1次骰子，取点数最大值。', effect: { kind: 'reroll_dice', value: 1 } },
        { realm: 3, text: '结丹期：在对战中出牌阶段使用，使本次对战中自身的【战力值】+1。', effect: { kind: 'combat_bonus', value: 1 } },
      ],
    },
    {
      id: id('火弹术'), name: '火弹术', type: 'consume', cost: 1, realm: 0, count: 1,
      cat: '消耗类法术',
      text: '在出牌阶段时，可选择从对方手中抽取2张【宝物牌】或让对方额…（后半句被裁断）',
      effect: { kind: 'steal_hand_multi', value: 2 },
      note: '卡面后半句未拍到，暂按「从对方手中抽取2张宝物牌」实现，待补',
    },
  ],
  treasure: [
    {
      id: id('虚天鼎乾蓝冰焰'), name: '虚天鼎 乾蓝冰焰', type: 'equip', cost: 0, equipCost: 5, realm: 2, count: 1,
      cat: '装备类通天灵宝',
      text: '1.虚天鼎：在对战中出牌阶段使用，不消耗【法力值】，使对方的任意1张【法术牌】/【宝物牌】无效。 2.乾蓝冰焰：在对战中出牌阶段使用，消耗1点【法力值】，使本次对战中自身的【战力值】+1。（装备时消耗5点【法力值】）',
      effect: { kind: 'nullify_enemy_card', block: '法术牌/宝物牌' },
      tiers: [
        { realm: 2, text: '虚天鼎：不消耗法力值，使对方的任意1张【法术牌】/【宝物牌】无效。', effect: { kind: 'nullify_enemy_card', block: '法术牌/宝物牌' } },
        { realm: 2, text: '乾蓝冰焰：消耗1点法力值，使本次对战中自身的【战力值】+1。', effect: { kind: 'combat_bonus', value: 1 } },
      ],
      note: '一张牌两个可发动效果（角标 0/1），用「档位」机制让玩家二选一；第二个效果的 1 点法力消耗暂未单独计费',
    },
    {
      id: id('朱雀环'), name: '朱雀环', type: 'consume', cost: 1, realm: 1, count: 1,
      cat: '消耗类法宝',
      text: '在对战中出牌阶段使用，使本次对战中自身的【战力值】+1，若对战获胜，恢复2点【法力值】。',
      effect: { kind: 'combat_bonus_win_mana', value: 1, winMana: 2 },
    },
    {
      id: id('风云幡'), name: '风云幡', type: 'consume', cost: 0, realm: 1, count: 1,
      cat: '消耗类法宝',
      text: '在对战获胜时使用，抽取1张【灵气牌】。',
      effect: { kind: 'win_draw_qi', value: 1 },
    },
  ],
  companion: [
    {
      id: id('傀母斩蜴'), name: '傀母斩蜴', type: 'companion', cost: null, realm: 0, count: 1, slots: 1,
      cat: '灵兽', absorb: 2,
      text: '【傀母斩蜴】可替你承受任意2次伤害，之后此【傀儡】放入【弃牌堆】。',
      onTurn: null, onCombat: null, onPromote: null, onWin: null,
      note: '卡名与括号内文字未完全读清（疑为「不占用储物袋」/「每次消耗2点」），待用户确认',
    },
  ],
};

let added = 0;
for (const deck of Object.keys(NEW)) {
  for (const c of NEW[deck]) {
    if (d[deck].some((x) => x.name === c.name)) { console.log('已存在，跳过:', c.name); continue; }
    d[deck].push(c);
    added++;
  }
}

// 重新配平
for (const deck of Object.keys(TOTAL)) {
  const list = d[deck];
  if (!list.length) continue;
  const base = Math.floor(TOTAL[deck] / list.length);
  let rest = TOTAL[deck] - base * list.length;
  list.forEach((c, i) => { c.count = base + (i < rest ? 1 : 0); });
}

fs.writeFileSync(P, JSON.stringify(d, null, 1), 'utf8');
console.log(`新增 ${added} 张卡\n`);
for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
  const n = d[deck].reduce((a, c) => a + c.count, 0);
  console.log(`  ${deck}: ${d[deck].length} 种 / ${n} 张（官方 ${TOTAL[deck]}）`);
}
console.log('\n新增的卡:');
for (const deck of Object.keys(NEW)) NEW[deck].forEach((c) => console.log(`  [${deck}] ${c.name} — ${c.cat || c.type}${c.note ? '  ⚠' + c.note.slice(0, 30) : ''}`));
