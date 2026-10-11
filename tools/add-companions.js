'use strict';
// 从用户提供的整版同行者实拍里，加入此前没有的同行者。
const fs = require('fs');
const P = 'data\\cards.json';
const d = JSON.parse(fs.readFileSync(P, 'utf8'));
const TOTAL = { treasure: 80, spell: 33, companion: 78, qi: 60 };
const id = (n) => 'k_' + Buffer.from(n, 'utf8').toString('hex');

const NEW = [
  {
    name: '陈巧倩', cat: '修士', slots: 1,
    text: '使用任意1次【补气丹】/【回气丹】时，可选择使效果翻倍，之后此【同行者】放入【弃牌堆】。',
    onTurn: null, note: '依赖【补气丹】/【回气丹】这两张牌，当前卡池还没有它们，效果暂挂起',
  },
  {
    name: '元瑶', cat: '修士', slots: 1,
    text: '当你的【生命值】仅剩1点或0点时，恢复2点【生命值】，之后此【同行者】放入【弃牌堆】。',
    onTurn: null, note: '「濒死时回2点并弃置」需要受伤钩子，暂未实现',
  },
  {
    name: '文思月', cat: '修士', slots: 1,
    text: '晋升时，可额外抽取1张【宝物牌】和1张【法术牌】。',
    onPromote: { kind: 'draw_mixed', treasure: 1, spell: 1 },
  },
  {
    name: '银月', cat: '器灵', slots: 1,
    text: '◆ 每回合1次，装备任意【装备类宝物牌】时，抽取1张【灵气牌】。◆ 当【储物袋】中有任意【装备类宝物牌】，在对战时，可额外投掷1次骰子，取最大值。',
    onCombat: { kind: 'reroll_dice', value: 1 },
    note: '第1条（装备时抽灵气）需要装备钩子，暂未实现；第2条已实现为「对战时重掷取大」',
  },
  {
    name: '钟卫娘', cat: '修士', slots: 1, absorb: 1,
    text: '◆ 使用超过当前境界的【宝物牌】时，投掷1次骰子，点数≥3，不需要额外消耗法力值。◆ 此同行者可替你承受任意1次伤害，之后此【同行者】放入【弃牌堆】。',
    note: '第1条（越级使用可免额外法力）需要打出钩子，暂未实现；承伤已实现',
  },
  {
    name: '玄骨', cat: '修士', slots: 2,
    text: '◆ 晋升时，所需的【灵气值】-1。◆ 使用任意【宝物牌】/【法术牌】时，【法力值】消耗-1（最低为1）。◆ 此【同行者】需要2个放置位。',
    onPromote: { kind: 'promote_discount', value: 1 },
    note: '第2条（消耗-1）需要费用钩子，暂未实现；第3条=占2位，已生效',
  },
  {
    name: '王蝉', cat: '修士', slots: 1,
    text: '对战境界高于你的修士时，【战力值】+1，若对战获胜，抽取1张【灵气牌】。',
    onCombat: { kind: 'combat_bonus_if_enemy_higher_realm', value: 1 },
    onWin: { draw_qi: 1 },
  },
  {
    name: '辛如音', cat: '修士', slots: 1, text: '（效果未拍到）',
    onTurn: null, note: '只拍到卡名，效果文本在照片外，待补',
  },
  {
    name: '凌玉灵', cat: '修士', slots: 1, text: '（效果未拍到）',
    onTurn: null, note: '只拍到卡名，效果文本在照片外，待补',
  },
  {
    name: '燕如嫣', cat: '修士', slots: 1, text: '（效果未拍到）',
    onTurn: null, note: '只拍到卡名，效果文本在照片外，待补',
  },
  {
    name: '墨彩环', cat: '修士', slots: 1, text: '（效果未拍到）',
    onTurn: null, note: '只拍到卡名，效果文本在照片外，待补',
  },
];

let added = 0;
for (const c of NEW) {
  if (d.companion.some((x) => x.name === c.name)) { console.log('已存在，跳过:', c.name); continue; }
  d.companion.push({
    id: id(c.name), name: c.name, type: 'companion', cost: null, realm: 0, count: 1,
    slots: c.slots || 1, cat: c.cat, absorb: c.absorb || undefined,
    text: c.text, onTurn: c.onTurn || null, onCombat: c.onCombat || null,
    onPromote: c.onPromote || null, onWin: c.onWin || null,
    note: c.note || undefined,
  });
  added++;
}

for (const deck of Object.keys(TOTAL)) {
  const list = d[deck];
  if (!list.length) continue;
  const base = Math.floor(TOTAL[deck] / list.length);
  let rest = TOTAL[deck] - base * list.length;
  list.forEach((c, i) => { c.count = base + (i < rest ? 1 : 0); });
}
fs.writeFileSync(P, JSON.stringify(d, null, 1), 'utf8');

console.log(`新增 ${added} 张同行者\n`);
for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
  console.log(`  ${deck}: ${d[deck].length} 种 / ${d[deck].reduce((a, c) => a + c.count, 0)} 张（官方 ${TOTAL[deck]}）`);
}
console.log('\n同行者类别分布:');
const byCat = {};
d.companion.forEach((c) => (byCat[c.cat || '?'] = (byCat[c.cat || '?'] || 0) + 1));
Object.keys(byCat).forEach((k) => console.log(`  ${k}: ${byCat[k]} 种`));
console.log('\n占 2 位的同行者:', d.companion.filter((c) => c.slots === 2).map((c) => c.name).join('、') || '（无）');
