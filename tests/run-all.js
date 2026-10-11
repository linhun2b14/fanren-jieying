'use strict';
// 全量回归：引擎/规则单测 + 服务端/域名连通 + 浏览器 UI。用法 node tests\run-all.js [--no-ui]
const { spawnSync } = require('child_process');
const path = require('path');

const NO_UI = process.argv.includes('--no-ui');
const ENGINE = [
  'smoke.js',
  'p0-regression-test.js',
  'dismiss-test.js',
  'hand-limit-test.js',
  'card-bugfix-test.js',
  'tie-test.js',
  'qi-extra-test.js',
  'rules-v3-test.js',
  'equip-combat-test.js',
  'uid-realm-test.js',
  'v4-behavior-test.js',
  'v5-mechanics-test.js',
  'combo-discount-test.js',
  'promote-discount-test.js',
  'dead-effect-test.js',
  'timing-bus-test.js',
  'window-ask-test.js',
  'interrupt-test.js',
  'first-turn-test.js',
  'puppet-huodan-test.js',
  'tier-roots-test.js',
  'companions-v2-test.js',
  'companions-v3-test.js',
  'cards-batch4-test.js',
  'conditions-test.js',
  'mechanisms-v6-test.js',
  'explore-phase-test.js',
  'combat-priority-test.js',
  'playtest-fixes-test.js',
  'response-uses-dice-test.js',
  'batch8-cards-test.js',
  'old-debts-test.js',
];
const NET = ['server-test.js', 'domain-test.js'];
const UI = ['ui-probe.js', 'ui-flow.js', 'ui-combat.js', 'ui-four.js', 'ui-play-card.js', 'ui-drawfx.js', 'ui-status.js', 'ui-card-modal.js', 'ui-layout.js', 'ui-discard.js', 'ui-hand-limit.js', 'ui-target-pick.js', 'ui-play-drag.js', 'ui-hand-zoom.js', 'ui-two-windows.js'];
// 卡池 / DSL 的不变量自检。以前这两个工具只手动跑，结果 verify-dsl 从 2026-10 起
// 一直是红的（【青易居士】的 engineDirect 效果没有 when/event，而 lint-cards 豁免了、
// verify-dsl 漏了），没人发现。接进闸门后就不会再烂。
const INVARIANT = ['../tools/verify-dsl.js', '../tools/lint-cards.js'];

const groups = [['引擎/规则', ENGINE], ['卡池/DSL 不变量', INVARIANT], ['服务端/域名', NET]];
if (!NO_UI) groups.push(['浏览器 UI', UI]);

let total = 0, bad = 0;
const failed = [];
for (const g of groups) {
  console.log('\n' + '='.repeat(60));
  console.log(`# ${g[0]}`);
  console.log('='.repeat(60));
  for (const f of g[1]) {
    total++;
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { encoding: 'utf8', timeout: 240000 });
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    const tail = out.split('\n').slice(-4).join('\n');
    const ok = r.status === 0;
    if (!ok) { bad++; failed.push(f); }
    console.log(`\n[${ok ? 'PASS' : 'FAIL'}] ${f}`);
    if (!ok) console.log(tail);
    else console.log('   ' + out.split('\n').filter((l) => /结果|ALL PASS|通过/.test(l)).slice(-2).join(' | ') || '   ok');
  }
}
console.log('\n' + '='.repeat(60));
console.log(`总计: ${total - bad}/${total} 通过` + (bad ? `  失败: ${failed.join(', ')}` : '  全部通过'));
process.exit(bad === 0 ? 0 : 1);
