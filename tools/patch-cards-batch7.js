'use strict';
// 第七批（用户口头确认的实物数据）：
//   【风雷翅】装备时消耗 **3** 点法力（不是卡文里误抄的 2 点）→ 修卡文
//   新增【补气丹】凡人+/0费/抽1张灵气牌
//   新增【回气丹】凡人+/0费/回复2点法力
//   【傀儡蜥蜴】改为"需要装备、有独立傀儡位、不占储物袋格子"
//
// 张数约束：官方公布总数是硬指标（宝物 80 / 法术 33 / 同行者 78 / 灵气 60）。
// 单张牌的副本数实物没抄到，历来按"配平到官方总数"分配，所以新加 2 种各 3 张后
// 从已有卡里下调 6 张来保持 80。⚠️ 这些副本数是可调参数，用户可随时给准确值。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'cards.json');
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const idOf = (name) => 'k_' + Buffer.from(name, 'utf8').toString('hex');
const log = [];

// ---- ① 风雷翅：卡文里的 2 点改成 3 点（用户确认） ----
{
  const c = raw.treasure.find((x) => x.name === '风雷翅');
  if (!c) { console.error('✗ 没有【风雷翅】'); process.exit(1); }
  const before = c.text;
  c.text = c.text.replace('装备时消耗2点', '装备时消耗3点');
  if (c.text === before) { console.error('✗ 风雷翅卡文里没找到「装备时消耗2点」'); process.exit(1); }
  log.push('【风雷翅】卡文「装备时消耗2点」→「3点」（与 cost=3 一致，lint 的数据分歧消除）');
}

// ---- ② 新增两张丹药 ----
const NEW = {
  补气丹: {
    type: 'consume', cost: 0, realm: 0, count: 3, cat: '消耗类丹药',
    text: '使用后抽取1张【灵气牌】。',
    effects: [{ when: 'play', op: 'draw_qi', value: 1 }],
  },
  回气丹: {
    type: 'consume', cost: 0, realm: 0, count: 3, cat: '消耗类丹药',
    text: '使用后恢复2点【法力值】。',
    effects: [{ when: 'play', op: 'mana', value: 2 }],
  },
};
for (const name of Object.keys(NEW)) {
  if (raw.treasure.some((c) => c.name === name)) { console.error(`✗ 【${name}】已存在`); process.exit(1); }
  const s = NEW[name];
  raw.treasure.push({
    id: idOf(name), name: name, type: s.type, cost: s.cost, realm: s.realm, count: s.count,
    cat: s.cat, text: s.text, effects: s.effects,
  });
  log.push(`新增 [宝物/丹药]【${name}】${s.count} 张（0 费，凡人+，${s.effects[0].op}）`);
}

// ---- ③ 傀儡蜥蜴：独立傀儡位 ----
{
  const c = raw.treasure.find((x) => x.name === '傀儡蜥蜴');
  if (!c) { console.error('✗ 没有【傀儡蜥蜴】'); process.exit(1); }
  c.equipSlot = 'puppet';    // 需要装备，但占的是**独立的傀儡位**，不占储物袋
  c.cat = '傀儡形法器';
  delete c.note;
  log.push('【傀儡蜥蜴】加 equipSlot=puppet：装备不花法力、占独立傀儡位、不占储物袋格子');
}

// ---- ④ 配平：宝物 +6，从已有卡里下调 6 张 3→2 ----
const TRIM = ['大挪移令', '黑血刀', '红线遁光针', '血凝五行丹', '青蛟旗', '青火雷'];
for (const n of TRIM) {
  const c = raw.treasure.find((x) => x.name === n);
  if (!c) { console.error(`✗ 宝物里没有【${n}】`); process.exit(1); }
  if (c.count <= 1) { console.error(`✗ 【${n}】已是最低张数`); process.exit(1); }
  log.push(`宝物【${n}】${c.count} → ${c.count - 1}（配平用）`);
  c.count -= 1;
}

// ---- 校验 ----
const TARGET = { treasure: 80, spell: 33, companion: 78, qi: 60 };
let bad = false;
for (const d of Object.keys(TARGET)) {
  const n = (raw[d] || []).reduce((s, x) => s + (x.count || 1), 0);
  const ok = n === TARGET[d];
  if (!ok) bad = true;
  console.log(`${ok ? '✓' : '✗'} ${d}: ${(raw[d] || []).length} 种 / ${n} 张（官方 ${TARGET[d]}）`);
}
if (bad) { console.error('数量校验失败，未写入'); process.exit(1); }
const seen = new Set();
for (const d of ['treasure', 'spell', 'companion', 'qi']) for (const c of raw[d]) {
  if (seen.has(c.id)) { console.error(`✗ id 冲突 ${c.id}`); process.exit(1); }
  seen.add(c.id);
}
const json = JSON.stringify(raw, null, 2) + '\n';
if (/\uFFFD/.test(json)) { console.error('结果含 U+FFFD，未写入'); process.exit(1); }
fs.writeFileSync(FILE, json, 'utf8');
console.log('\n变更：');
for (const l of log) console.log('  ' + l);
