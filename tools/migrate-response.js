'use strict';
/**
 * 迁移：「应对」字段（用户 2026-10-05 裁定 —— 只有带应对的卡/效果才能进【斗法】链＝能被破招）
 *
 * 判据（从数据实算，不手写清单）：
 *   一张牌只要有一条**非 auto** 的效果落在**响应型窗口**上，就该带应对：
 *     被指定为目标(combatDeclare) / 对战·可选发动(combatOpt) / 对方出牌(useCard·前) /
 *     投骰前·后(roll) / 对战结算(combatResult · 胜/平/负) / 受伤(hurt)
 *   「阶段内可选型」窗口（探索替换 drawTreasure、晋升减消耗 promote·前、回合结束 turnEnd、
 *     装备即结算 equip、放置 place、闭关 seclusion、濒危 lowHp）**不需要**应对 —— 那些不是破招。
 *   `auto: true` 的效果是自动收集的、本来就不进链，所以带它们的牌不需要因此标应对。
 *
 * 用法： node tools\migrate-response.js            # 只报告
 *        node tools\migrate-response.js --apply    # 写盘（自带 .bak-response-<时间戳> 备份）
 */
const fs = require('fs');
const path = require('path');
const M = require('../server/effect-meta');

const P = path.join(__dirname, '..', 'data', 'cards.json');
const APPLY = process.argv.includes('--apply');
const DECKS = ['treasure', 'spell', 'companion', 'qi'];

const raw = JSON.parse(fs.readFileSync(P, 'utf8'));

const norm = (e) => {
  const t = M.timingOfEffect(e);
  return t ? { event: t.event, phase: t.phase || null } : null;
};

const need = [];
const optionalHit = [];
for (const d of DECKS) {
  for (const c of raw[d] || []) {
    const list = (c.effects || []).concat(...(c.tiers || []).map((t) => t.effects || []));
    let hitResponse = null, hitOptional = null;
    for (const e of list) {
      const t = norm(e);
      if (!t) continue;
      const ev = M.EVENTS[t.event];
      if (!ev || !ev.interrupt) continue;
      const isWin = ev.interrupt === true || (Array.isArray(ev.interrupt) && ev.interrupt.indexOf(t.phase) >= 0);
      if (!isWin) continue;
      const label = t.event + (t.phase ? '·' + t.phase : '');
      if (M.needsResponse(t.event, t.phase)) { if (e.auto !== true && !hitResponse) hitResponse = label + ' / ' + (e.op || ''); }
      else if (!hitOptional) hitOptional = label + ' / ' + (e.op || '');
    }
    if (hitResponse) need.push({ deck: d, card: c, why: hitResponse });
    else if (hitOptional) optionalHit.push({ deck: d, card: c, why: hitOptional });
  }
}

console.log('=== 该带「应对」的牌（%d 张）===', need.length);
for (const x of need) console.log('  [' + x.deck + '] ' + x.card.name + (x.card.response ? '  (已有)' : '') + '   ← ' + x.why);
console.log('\n=== 只落在「阶段内可选」窗口、**不需要**应对的牌（%d 张，列出来供核对）===', optionalHit.length);
for (const x of optionalHit) console.log('  [' + x.deck + '] ' + x.card.name + '   ← ' + x.why);

if (!APPLY) {
  console.log('\n（只报告。加 --apply 才写盘）');
  process.exit(0);
}

let n = 0;
for (const x of need) {
  if (x.card.response !== true) { x.card.response = true; n++; }
}
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
fs.copyFileSync(P, P + '.bak-response-' + stamp);
fs.writeFileSync(P, JSON.stringify(raw, null, 2) + '\n', 'utf8');
console.log(`\n已写盘：${n} 张卡补上 response:true，备份 ${path.basename(P)}.bak-response-${stamp}`);
