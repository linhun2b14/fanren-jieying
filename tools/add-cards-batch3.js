'use strict';
// 加入【九曲灵参】与【九曲灵参丹】——一对可组合使用的晋升折扣卡（结丹期使用，目标境界=元婴）。
const fs = require('fs');
const P = 'data\\cards.json';
const d = JSON.parse(fs.readFileSync(P, 'utf8'));
const TOTAL = { treasure: 80, spell: 33, companion: 78, qi: 60 };
const id = (n) => 'k_' + Buffer.from(n, 'utf8').toString('hex').slice(0, 12);

const NEW = [
  {
    id: id('九曲灵参'), name: '九曲灵参', type: 'consume', cost: 0, realm: 3, count: 1,
    cat: '消耗类灵药',
    text: '晋升元婴期时，所需【灵气值】-1。可和【九曲灵参丹】一起使用，使所需【灵气值】-3。',
    effect: { kind: 'promote_discount_once', value: 1, onlyRealm: 4, comboWith: '九曲灵参丹', comboValue: 3 },
  },
  {
    id: id('九曲灵参丹'), name: '九曲灵参丹', type: 'consume', cost: 0, realm: 3, count: 1,
    cat: '消耗类丹药',
    text: '晋升元婴期时，所需【灵气值】-1。若将此【宝物牌】放入【弃牌堆】，则可抽取1张【灵气牌】。可和【九曲灵参】一起使用，使所需【灵气值】-3。',
    effect: { kind: 'promote_discount_once', value: 1, onlyRealm: 4, comboWith: '九曲灵参', comboValue: 3, alsoDrawQi: 1 },
  },
];

let added = 0;
for (const c of NEW) {
  if (d.treasure.some((x) => x.name === c.name)) { console.log('已存在，跳过:', c.name); continue; }
  d.treasure.push(c); added++;
}

for (const deck of Object.keys(TOTAL)) {
  const list = d[deck];
  if (!list.length) continue;
  const base = Math.floor(TOTAL[deck] / list.length);
  let rest = TOTAL[deck] - base * list.length;
  list.forEach((c, i) => { c.count = base + (i < rest ? 1 : 0); });
}

fs.writeFileSync(P, JSON.stringify(d, null, 1), 'utf8');
console.log(`新增 ${added} 张\n`);
for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
  console.log(`  ${deck}: ${d[deck].length} 种 / ${d[deck].reduce((a, c) => a + c.count, 0)} 张（官方 ${TOTAL[deck]}）`);
}
console.log('\n结丹期(境界3)的卡:');
for (const k of ['treasure', 'spell']) d[k].filter((c) => (c.realm || 0) >= 3).forEach((c) => console.log(`  [${k}] ${c.name} — ${c.cat || c.type} 耗${c.cost}`));
