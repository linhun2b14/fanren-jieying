'use strict';
// 补全 4 张同行者的真实效果（照片已确认）：辛如音 / 凌玉灵 / 燕如嫣 / 墨彩环
// 这 4 张牌此前只拍到卡名，各 2 张的占位已在 78 张同行者总数内，故此处不改数量。
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'data', 'cards.json');
const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));

const PATCH = {
  辛如音: {
    text: '晋升时，使晋升所需的【灵气值】消耗-1。',
    onPromote: { kind: 'promote_discount', value: 1 },
  },
  凌玉灵: {
    text: '◆对战中投掷骰子前使用，使本次对战中骰子点数+1（最高为6点）。◆对战结束后，不论输赢，额外恢复1点【法力值】。',
    onCombat: { kind: 'dice_bonus', value: 1, cap: 6 },
    onCombat2: { kind: 'after_combat_mana', value: 1 },
  },
  燕如嫣: {
    text: '在任意回合使用，当你受到任意伤害时，立即恢复2点【法力值】。',
    onHurt: { kind: 'mana', value: 2 },
  },
  墨彩环: {
    text: '◆若在自己的回合不发起对战，可消耗3点【法力值】恢复1点【生命值】。◆此【同行者】需要2个放置点。',
    slots: 2,
    onTurn: { kind: 'turn_no_combat_heal', manaCost: 3, heal: 1 },
  },
};

let hit = 0;
for (const c of raw.companion) {
  const p = PATCH[c.name];
  if (!p) continue;
  hit++;
  // 保留 id/name/type/cost/realm/count/slots/cat 等既有字段，只覆盖效果相关项
  c.text = p.text;
  c.onTurn = p.onTurn || null;
  c.onCombat = p.onCombat || null;
  c.onCombat2 = p.onCombat2 || null;
  c.onPromote = p.onPromote || null;
  c.onHurt = p.onHurt || null;
  if (p.slots) c.slots = p.slots;
  delete c.note;
}

if (hit !== 4) {
  console.error(`期望匹配 4 张，实际 ${hit} 张，已中止未写入`);
  process.exit(1);
}

// 数量校验：不得改变官方总数 80/33/78/60
const TARGET = { treasure: 80, spell: 33, companion: 78, qi: 60 };
let bad = false;
for (const d of Object.keys(TARGET)) {
  const n = (raw[d] || []).reduce((s, x) => s + (x.count || 1), 0);
  if (n !== TARGET[d]) { console.error(`✗ ${d} 张数 ${n} != ${TARGET[d]}`); bad = true; }
}
if (bad) { console.error('数量校验失败，未写入'); process.exit(1); }

const json = JSON.stringify(raw, null, 2) + '\n';
if (/\uFFFD/.test(json)) { console.error('结果含替换字符 U+FFFD，未写入'); process.exit(1); }
fs.writeFileSync(FILE, json, 'utf8');
console.log(`已补全 ${hit} 张同行者效果，数量校验通过（80/33/78/60），U+FFFD=0`);
