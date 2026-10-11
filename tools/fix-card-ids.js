'use strict';
// 修复卡牌 id 冲突：原 id 取卡名前 12 个 hex 字符（= 前 2 个汉字），
// 「九曲灵参」与「九曲灵参丹」这类同前缀卡名会撞成同一个 id，导致 cardDef() 认错卡。
// 改为用完整卡名的 hex（卡名唯一 → id 唯一）。
const fs = require('fs');
const P = 'data\\cards.json';
const d = JSON.parse(fs.readFileSync(P, 'utf8'));

const seen = new Map();
let changed = 0;
for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
  for (const c of d[deck]) {
    const fresh = 'k_' + Buffer.from(c.name, 'utf8').toString('hex');
    if (c.id !== fresh) { c.id = fresh; changed++; }
    if (seen.has(c.id)) { console.error('仍然冲突:', seen.get(c.id), '与', c.name); process.exit(1); }
    seen.set(c.id, c.name);
  }
}
fs.writeFileSync(P, JSON.stringify(d, null, 1), 'utf8');
console.log(`重排 ${changed} 个 id，共 ${seen.size} 张卡，无冲突`);

// 校验：cardDef 能唯一定位
const C = require('../server/cards');
const probe = ['九曲灵参', '九曲灵参丹', '青元剑诀', '虚天鼎 乾蓝冰焰', '朱雀环', '风云幡', '火弹术', '傀母斩蜃', '傀母斩蜴'];
for (const n of probe) {
  const t = ['treasure', 'spell', 'companion', 'qi'].map((k) => C.cards()[k].find((c) => c.name === n)).find(Boolean);
  if (!t) continue;
  const back = C.byId ? C.byId(t.id) : null;
  console.log(`  ${n} → id=${t.id.slice(0, 20)}…  反查=${back && back.name === n ? 'OK' : '（无 byId，跳过）'}`);
}
