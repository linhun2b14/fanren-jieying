'use strict';
/**
 * op 参数化合族迁移（2026-10-05 用户拍板：迁移数据 + 旧 op 留 deprecated 兼容读旧备份）。
 *
 * 把卡池里"时点/目标语义焊进 op 名"的旧 op 改写成参数化新 op：
 *   抽牌族（25 条摊 6 个 op）→ draw + deck/value（多堆 = treasure/spell/companion 张数）
 *   伤害族（13 条摊 9 个 op）→ damage + target（target/multi/all_others/self_then_target/attacker/loser）+ value…
 *   封锁族（3 个 op）→ block_draw + deck
 *
 * 不改写（各有原因，见 OPS 的 deprecated 说明）：
 *   · damage_higher_realm（红线遁光针）—— 要 if.target.realmHigher 的求值上下文，走自己的废弃路径；
 *   · win_extra_damage / risky_win_damage / versus_realm_effect —— 不是基础伤害 op 的重复，是对战容器效果。
 *
 * 用法：
 *   node tools\migrate-ops.js            # 空跑：只报告要改什么，不写盘
 *   node tools\migrate-ops.js --apply    # 走编辑器 /api/save（闸门 + 备份）真正写盘
 *   node tools\migrate-ops.js --write --file <路径>   # 直接写盘（只给临时副本做实验用，自带 .bak）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const WRITE = argv.includes('--write');
const fileArg = argv.indexOf('--file');
const FILE = path.resolve(ROOT, fileArg >= 0 ? argv[fileArg + 1] : path.join('data', 'cards.json'));
const API = process.env.EDITOR_API || 'http://127.0.0.1:8098';
const DECKS = ['treasure', 'spell', 'companion', 'qi'];
const DECK_CN = { treasure: '宝物牌', spell: '法术牌', companion: '同行者', qi: '灵气牌' };

/** 把 e 改写成新 op：先改 op 名，再合入 params（不覆盖已有的同名字段，除非显式 force） */
function rewrite(e, op, params) {
  const out = {};
  for (const k of Object.keys(e)) out[k] = e[k];
  out.op = op;
  for (const k of Object.keys(params || {})) out[k] = params[k];
  return out;
}

/** 每条旧 op 的改写规则（返回新效果对象） */
const OP_MAP = {
  draw_treasure: (e) => rewrite(e, 'draw', { deck: 'treasure' }),
  draw_qi: (e) => rewrite(e, 'draw', { deck: 'qi' }),
  win_draw_qi: (e) => rewrite(e, 'draw', { deck: 'qi' }),
  // ⚠️ on_promote_draw_qi（长春功）**不迁**：它不是纯抽牌 —— 凡人期晋升一境、非凡人期才补抽，
  //   是带专属逻辑的 op（OPS 里也不标 deprecated）。
  place_draw_qi: (e) => rewrite(e, 'draw', { deck: 'qi' }),
  draw_mixed: (e) => rewrite(e, 'draw', {}),           // treasure/spell/companion 张数参数原样保留
  damage_target: (e) => rewrite(e, 'damage', {}),       // target 缺省 = 指定一名
  damage_multi: (e) => rewrite(e, 'damage', { target: 'multi' }),
  damage_all_others: (e) => rewrite(e, 'damage', { target: 'all_others' }),
  damage_and_skip: (e) => {
    const r = rewrite(e, 'damage', {});                 // skip 参数原名保留
    r.value = e.damage || e.value || 1;                 // 旧参数名 damage → 统一 value
    delete r.damage;
    return r;
  },
  self_damage_then_multi: (e) => rewrite(e, 'damage', { target: 'self_then_target' }),
  damage_attacker: (e) => rewrite(e, 'damage', { target: 'attacker' }),
  block_spell_draw: (e) => rewrite(e, 'block_draw', { deck: 'spell' }),
  block_companion_draw: (e) => rewrite(e, 'block_draw', { deck: 'companion' }),
  block_treasure_draw: (e) => rewrite(e, 'block_draw', { deck: 'treasure' }),
};

const pool = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const changes = [];
let scanned = 0, winDamageTagged = 0;

function convertList(list, where) {
  return (list || []).map((e) => {
    if (!e || !e.op) return e;
    if (OP_MAP[e.op]) {
      const r = OP_MAP[e.op](e);
      changes.push({ where: where, from: e.op, to: r.op + (r.deck ? '+' + r.deck : '') + (r.target ? '+' + r.target : '') });
      return r;
    }
    // 特例：裸 damage 写在对战结果时点 → 标明「给输家」（语义不变，runOnWinEffects 本来就打给 lose）
    if (e.op === 'damage' && !e.target && e.event === 'combatResult') {
      winDamageTagged++;
      return rewrite(e, 'damage', { target: 'loser' });
    }
    return e;
  });
}

for (const d of DECKS) {
  for (const c of pool[d] || []) {
    const tag = DECK_CN[d] + '【' + c.name + '】';
    scanned += (c.effects || []).length;
    if (c.effects) c.effects = convertList(c.effects, tag);
    (c.tiers || []).forEach((t, i) => {
      scanned += (t.effects || []).length;
      if (t.effects) t.effects = convertList(t.effects, tag + ' 档' + (i + 1));
    });
  }
}

console.log('卡池文件：' + path.relative(ROOT, FILE));
console.log(`扫描效果条目 ${scanned} 条；本次改写 **${changes.length}** 条，另给 ${winDamageTagged} 条对战结果 damage 补标 target:'loser'`);
const byFrom = {};
for (const c of changes) byFrom[c.from] = (byFrom[c.from] || 0) + 1;
console.log('\n按旧 op 分组：' + Object.keys(byFrom).map((k) => `${k} × ${byFrom[k]}`).join('、'));
console.log('\n改写明细（前 30 条）：');
for (const c of changes.slice(0, 30)) console.log(`   ${c.where}  ${c.from}  →  ${c.to}`);
if (changes.length > 30) console.log(`   …… 还有 ${changes.length - 30} 条`);

if (!APPLY && !WRITE) {
  console.log('\n（空跑模式：**没有写盘**。确认无误后加 --apply 走编辑器，或 --write 直接写盘）');
  process.exit(0);
}

if (WRITE) {
  const bak = FILE + '.bak-migrate-ops-' + Date.now();
  fs.copyFileSync(FILE, bak);
  fs.writeFileSync(FILE, JSON.stringify(pool, null, 2) + '\n', 'utf8');
  console.log('\n【直接写盘】已写入 ' + path.relative(ROOT, FILE) + '，备份 ' + path.basename(bak));
  process.exit(0);
}

(async () => {
  const r = await fetch(API + '/api/save', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cards: pool }),
  });
  const j = await r.json();
  console.log('\n/api/save wrote = ' + j.wrote + ' | backup = ' + (j.backup && j.backup.file));
  for (const s of j.steps || []) {
    console.log(`  [${s.ok ? '通过' : '不通过'}] ${s.name}`);
    if (!s.ok) console.log('     ' + String(s.output).replace(/\n/g, '\n     '));
  }
  if (!j.wrote) process.exit(1);
})().catch((e) => { console.error('保存失败：' + e.message); process.exit(1); });
