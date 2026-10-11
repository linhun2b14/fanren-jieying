'use strict';
// 按用户口头确认修正两张卡：
//   1) 傀儡蜥蜴：不是「傀母斩蜴」，且**不是同行者而是宝物牌**，类型是「傀儡形法器」，
//      无限制、不占储物袋格子，可替主人承受任意2次伤害（每次消耗2点法力值）。
//   2) 火弹术：对战**胜利时**使用，二选一 —— 从对方手中抽2张【宝物牌】 或 让对方额外受1点伤害。
const fs = require('fs');
const P = 'data\\cards.json';
const d = JSON.parse(fs.readFileSync(P, 'utf8'));
const TOTAL = { treasure: 80, spell: 33, companion: 78, qi: 60 };
const id = (n) => 'k_' + Buffer.from(n, 'utf8').toString('hex');

// ---- 1) 把【傀母斩蜴】从同行者移除，改成宝物牌【傀儡蜥蜴】 ----
const before = d.companion.length;
d.companion = d.companion.filter((c) => c.name !== '傀母斩蜴');
const removed = before - d.companion.length;
if (!d.treasure.some((c) => c.name === '傀儡蜥蜴')) {
  d.treasure.push({
    id: id('傀儡蜥蜴'), name: '傀儡蜥蜴', type: 'consume', cost: 0, realm: 0, count: 1,
    cat: '傀儡形法器',
    text: '可替你承受任意2次伤害（每承受1次伤害消耗2点法力值），之后此【傀儡】放入【弃牌堆】。（不占用储物袋格子）',
    effect: { kind: 'summon_puppet', absorbs: 2, manaCost: 2 },
    note: '不占用储物袋格子；角标未拍到，暂按 0 法力。傀儡耗尽后进弃牌堆',
  });
}

// ---- 2) 火弹术：改成「对战胜利时二选一」，用档位机制让玩家选 ----
const huo = d.spell.find((c) => c.name === '火弹术');
if (huo) {
  huo.text = '对战胜利时，可选择从对方手中抽取2张【宝物牌】或让对方额外受到1点伤害。';
  huo.tiers = [
    { realm: 0, text: '对战胜利时，从对方手中抽取2张【宝物牌】。', effect: { kind: 'win_steal_treasure', value: 2 } },
    { realm: 0, text: '对战胜利时，让对方额外受到1点伤害。', effect: { kind: 'win_extra_damage', value: 1 } },
  ];
  huo.effect = huo.tiers[0].effect;
  huo.note = '两个选项用「档位」机制让玩家二选一（同境界）';
}

for (const deck of Object.keys(TOTAL)) {
  const list = d[deck];
  if (!list.length) continue;
  const base = Math.floor(TOTAL[deck] / list.length);
  let rest = TOTAL[deck] - base * list.length;
  list.forEach((c, i) => { c.count = base + (i < rest ? 1 : 0); });
}
fs.writeFileSync(P, JSON.stringify(d, null, 1), 'utf8');

console.log(`从同行者移除 ${removed} 张（傀母斩蜴）\n`);
for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
  console.log(`  ${deck}: ${d[deck].length} 种 / ${d[deck].reduce((a, c) => a + c.count, 0)} 张（官方 ${TOTAL[deck]}）`);
}
const tl = d.treasure.find((c) => c.name === '傀儡蜥蜴');
console.log('\n傀儡蜥蜴:', tl.cat, '|', tl.text);
console.log('火弹术:', (huo ? huo.tiers.length + ' 档：' + huo.tiers.map((t) => t.text).join(' / ') : '（未找到）'));
