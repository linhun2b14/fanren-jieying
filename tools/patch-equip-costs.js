'use strict';
// 给装备类法宝补上角标消耗值（原先统一为 0，无法体现「低境界装备免费/对战启用付费」的分档）。
//   低境界（凡人/炼气）：角标 = 对战中启用该效果时要付的法力
//   高境界（筑基+）    ：角标 = 装备时一次性支付的法力（此后对战免费）
const fs = require('fs');
const P = 'data\\cards.json';
const d = JSON.parse(fs.readFileSync(P, 'utf8'));

const LOW = {
  luoyun_token: 0,          // 凡人 · 手牌上限（非常驻战斗效果，无启用费）
  changchun_gong: 0,        // 凡人 · 手牌上限
  qingzhu_fengyun_sword: 1, // 炼气 · 对战战力+1（视频实物角标就是 1）
  jingong_sword: 1,         // 炼气 · 骰点+1
  tiangui_zhu: 1,           // 炼气 · 抵挡 2 点伤害
  dayan_jue: 1,             // 炼气 · 晋升减免
  qingyuan_jianjue: 1,      // 炼气 · 对战战力+1
};
const HIGH = {
  taiyi_wuyan_luo: 1,       // 筑基 · 抵挡 2 点伤害
  yinyue_lun: 1,            // 筑基 · 手牌上限+1
  zhangtian_bottle: 2,      // 筑基 · 每回合法力+1
  xutian_ding: 2,           // 筑基 · 伤害-1
  dayan_baodian: 2,         // 筑基 · 每回合法力+1
  yuancishen_guang: 2,      // 筑基 · 对战时对方-1
  yuancishen_shan: 2,       // 结丹 · 对战时对方-1
  yuanyang_ciguang: 2,      // 结丹 · 晋升减免
  taiyi_huaqing_fu: 2,      // 结丹 · 重掷
  fenmo_dugong: 3,          // 结丹 · 对战战力+2
  xuantian_zhanling_sword: 3, // 元婴 · 对战战力+2
};

let low = 0, high = 0, miss = [];
for (const deck of ['treasure', 'spell']) {
  for (const c of d[deck]) {
    if (c.type !== 'equip') continue;
    const tier2 = (c.realm || 0) >= 2;
    const table = tier2 ? HIGH : LOW;
    if (!(c.id in table)) { miss.push(c.id); continue; }
    c.cost = table[c.id];
    if (tier2) high++; else low++;
  }
}
if (miss.length) { console.error('未赋值的装备:', miss.join(', ')); process.exit(1); }
fs.writeFileSync(P, JSON.stringify(d, null, 1), 'utf8');

console.log(`低境界装备 ${low} 张（角标=对战启用费） / 高境界装备 ${high} 张（角标=装备费）`);
for (const deck of ['treasure', 'spell']) {
  d[deck].filter((c) => c.type === 'equip').forEach((c) =>
    console.log('  ', (c.realm >= 2 ? '高' : '低'), c.name.padEnd(10), 'realm=' + c.realm, 'cost=' + c.cost, '|', c.effect.kind));
}
