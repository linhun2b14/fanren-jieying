'use strict';
// 第四批：新增 3 张实物卡（青蛟旗 / 风灵劲 / 青火雷）+ 补全【玄骨】的法力折扣。
// 张数约束：官方牌堆总数是硬指标（宝物 80 / 法术 33 / 同行者 78 / 灵气 60 = 251）。
// 但**每张牌的副本数实物并未抄到**，历来是按「配平到官方总数」分配的。
// 因此新增 3 种（各 3 张）后，从最新补录的卡里下调同样张数来保持官方总数不变。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'cards.json');
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const idOf = (name) => 'k_' + Buffer.from(name, 'utf8').toString('hex');

const NEW = {
  青蛟旗: {
    deck: 'treasure', cat: '法器', type: 'consume', cost: 2, realm: 0, count: 3,
    text: '在自己的回合使用，指定任意一位修士，让对方受到1点伤害。',
    effect: { kind: 'damage_target', value: 1 },
  },
  青火雷: {
    deck: 'treasure', cat: '法宝', type: 'consume', cost: 2, realm: 2, count: 3,
    text: '在对战中出牌阶段使用，若本次对战获胜，对方额外受到2点伤害。若对战失败，你额外受到1点伤害。',
    effect: { kind: 'risky_win_damage', winDamage: 2, loseDamage: 1 },
  },
  风灵劲: {
    deck: 'spell', cat: '法术', type: 'consume', cost: 2, realm: 1, count: 3,
    text: '在任意回合使用，让一位发起对战的修士受到1点伤害。',
    effect: { kind: 'damage_attacker', value: 1, requiresCombat: true },
  },
};

// ---- 配平：从最新补录的卡里各下调 1 张 ----
// 宝物：数组末尾 6 张 count=3 的卡 3 → 2（共 -6）
// 法术：把 3 张 count=4 的卡降到 3（共 -3，且 4 张本来就是最高值，相对改动最小）
const TREASURE_TRIM = ['禁神牌', '虚天鼎 乾蓝冰焰', '朱雀环', '风云幡', '九曲灵参', '九曲灵参丹'];
const SPELL_TRIM = ['天星大阵', '碧水青甲阵', '还阳术'];

const log = [];
for (const n of TREASURE_TRIM) {
  const c = raw.treasure.find((x) => x.name === n);
  if (!c) { console.error(`✗ 宝物里没有【${n}】`); process.exit(1); }
  log.push(`宝物【${n}】${c.count} → ${c.count - 1}`);
  c.count -= 1;
}
for (const n of SPELL_TRIM) {
  const c = raw.spell.find((x) => x.name === n);
  if (!c) { console.error(`✗ 法术里没有【${n}】`); process.exit(1); }
  log.push(`法术【${n}】${c.count} → ${c.count - 1}`);
  c.count -= 1;
}

// ---- 新增卡 ----
for (const name of Object.keys(NEW)) {
  const spec = NEW[name];
  if (raw[spec.deck].some((c) => c.name === name)) { console.error(`✗ 【${name}】已存在`); process.exit(1); }
  const card = {
    id: idOf(name), name: name, type: spec.type, cost: spec.cost, realm: spec.realm,
    count: spec.count, cat: spec.cat, text: spec.text, effect: spec.effect,
  };
  raw[spec.deck].push(card);
  log.push(`新增 [${spec.deck}]【${name}】${spec.count} 张（${spec.cat}，${spec.cost} 法力，${['凡人', '炼气期', '筑基期', '结丹期'][spec.realm]}及以上）`);
}

// ---- 玄骨：补上「使用宝物牌/法术牌时法力消耗 -1（最低为 1）」----
const xuangu = raw.companion.find((c) => c.name === '玄骨');
if (!xuangu) { console.error('✗ 卡池里没有【玄骨】'); process.exit(1); }
xuangu.cardCostDiscount = 1;
delete xuangu.note;
log.push('【玄骨】补上 cardCostDiscount=1，清掉未实装 note');

// ---- 校验 ----
const TARGET = { treasure: 80, spell: 33, companion: 78, qi: 60 };
let bad = false;
for (const d of Object.keys(TARGET)) {
  const n = (raw[d] || []).reduce((s, x) => s + (x.count || 1), 0);
  const ok = n === TARGET[d];
  if (!ok) bad = true;
  console.log(`${ok ? '✓' : '✗'} ${d}: ${(raw[d] || []).length} 种 / ${n} 张（官方 ${TARGET[d]}）`);
}
if (bad) { console.error('张数校验失败，未写入'); process.exit(1); }

// id 唯一性
const seen = new Set();
for (const d of ['treasure', 'spell', 'companion', 'qi']) for (const c of raw[d]) {
  if (seen.has(c.id)) { console.error(`✗ id 冲突 ${c.id}`); process.exit(1); }
  seen.add(c.id);
}

const json = JSON.stringify(raw, null, 2) + '\n';
if (/\uFFFD/.test(json)) { console.error('结果含 U+FFFD，未写入'); process.exit(1); }
fs.writeFileSync(FILE, json, 'utf8');

console.log('\n变更明细:');
for (const l of log) console.log('  ' + l);
console.log(`\n总张数: ${['treasure', 'spell', 'companion', 'qi'].reduce((s, k) => s + raw[k].reduce((a, c) => a + c.count, 0), 0)}`);
