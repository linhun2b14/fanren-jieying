'use strict';
/**
 * 2026-10-05 第 1 轮字段落地后，把三张「待实装」卡真正做出来（都能用新字段/新节点表达）：
 *
 *   1.【凤帝】(同行者)   —— 靠新的**先攻判据** `if:{attacker:true}`：只有自己主动发起对战时骰点 +1。
 *   2.【玄铁飞天盾】(法器) —— 靠新的**掷骰分支** `roll_branch` + `"$lostHp"` 占位符：
 *        5/6 → 无效（把刚扣的血补回来）、2/3/4 → 照旧、1 → 双倍（再受一份）。
 *   3.【青竹蜂云剑 辟邪神雷】—— 靠新的**可用 N 次** `uses:2`（卡面"此【宝物牌】可使用2次"）。
 *
 * 幂等：按牌名找卡；已经是目标状态就跳过。用法： node tools\patch-cards-1005.js [--apply]
 */
const fs = require('fs');
const path = require('path');
const P = path.join(__dirname, '..', 'data', 'cards.json');
const APPLY = process.argv.includes('--apply');
const raw = JSON.parse(fs.readFileSync(P, 'utf8'));
const find = (name) => {
  for (const deck of ['treasure', 'spell', 'companion', 'qi']) {
    const c = (raw[deck] || []).find((x) => x.name === name);
    if (c) return c;
  }
  return null;
};

const changes = [];

// ① 凤帝：先攻才生效的骰点 +1（同行者常驻对战修正）
{
  const c = find('凤帝');
  if (!c) changes.push('【凤帝】不在卡池里 —— 跳过');
  else {
    const want = [{ when: 'standing', op: 'dice_bonus', value: 1, cap: 6, if: { attacker: true } }];
    if (JSON.stringify(c.effects) !== JSON.stringify(want) || c.count !== 1) {
      c.effects = want;
      c.count = 1;
      delete c.note;
      changes.push('【凤帝】落地：when:standing + dice_bonus(1, cap6) + if:{attacker:true}，张数 0 → 1');
    }
  }
}

// ② 玄铁飞天盾：受伤掷骰三分支
//   ⚠️ 用户 2026-10-05 二次裁定：掷出 1 点的"双倍伤害"**不是新的一次伤害**，而是**同一次受伤翻倍** ——
//      "受伤也是时点，时点响应，原效果最后生效" ⇒ 先翻倍、再无其他加成时算出结果（1×2 = 2 点）。
//      所以用 damage_multiply（作用在同一次受伤上、不开新窗口），而不是"再受一份"。
//      5/6 的"伤害无效"同理用 damage_cancel（把这次扣的血补回来，也不开新窗口）。
{
  const c = find('玄铁飞天盾');
  if (!c) changes.push('【玄铁飞天盾】不在卡池里 —— 跳过');
  else {
    const want = [{
      op: 'roll_branch', event: 'hurt', subject: 'self', manaCost: 2,
      branches: [
        { faces: [5, 6], effects: [{ op: 'damage_cancel' }] },        // 使该伤害无效
        { faces: [2, 3, 4], effects: [] },                            // 仍受到该伤害
        { faces: [1], effects: [{ op: 'damage_multiply', value: 2 }] }, // 本次受伤 ×2（同一次受伤）
      ],
    }];
    if (JSON.stringify(c.effects) !== JSON.stringify(want) || c.count !== 1 || c.response !== true) {
      c.effects = want;
      c.count = 1;
      c.response = true;                 // 受伤是**响应型窗口** → 要应对才能进斗法链
      delete c.note;
      changes.push('【玄铁飞天盾】对齐新语义：5/6 → damage_cancel（无效）、2/3/4 → 空、1 → damage_multiply ×2（同一次受伤，不是追加一次伤害）');
    }
  }
}

// ②b 掌天瓶：用户 2026-10-05 通则 —— **卡文带「装备时不消耗【法力值】」的，发动效果就按角标法力收费**
//     （除非卡文明确写了该效果要几点）。掌天瓶角标 1 → 探索阶段那次"额外抽 1 张宝物牌"收 1 点。
{
  const c = find('掌天瓶');
  if (!c) changes.push('【掌天瓶】不在卡池里 —— 跳过');
  else {
    const e = (c.effects || []).find((x) => x.op === 'draw');
    if (e && e.manaCost !== 1) {
      e.manaCost = 1;
      changes.push('【掌天瓶】按通则补发动费：探索阶段额外抽 1 张宝物牌 → 消耗 1 点法力（＝角标）');
    } else if (!e) changes.push('【掌天瓶】没找到 draw 效果 —— 跳过');
  }
}

// ③ 辟邪神雷：可使用 2 次
{
  const c = find('青竹蜂云剑 辟邪神雷');
  if (!c) changes.push('【青竹蜂云剑 辟邪神雷】不在卡池里 —— 跳过');
  else if (c.uses !== 2) {
    c.uses = 2;
    c.note = '卡面「若已装备【青竹蜂云剑】可将此牌放上去持续装备（替换装备）」引擎暂未实现 —— 待实装；'
      + '「可使用2次」已由 uses:2 实装（用完后不再摆出来问，卡留在场上）';
    changes.push('【青竹蜂云剑 辟邪神雷】补上 uses:2（卡面"可使用2次"）');
  }
}

console.log(changes.length ? changes.map((s) => '  · ' + s).join('\n') : '  （都已到位，无需改动）');
if (!APPLY) {
  console.log('\n（只报告。加 --apply 才写盘）');
  process.exit(0);
}
if (changes.length) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
  fs.copyFileSync(P, P + '.bak-round1-' + stamp);
  fs.writeFileSync(P, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  console.log(`\n已写盘（备份 cards.json.bak-round1-${stamp}）`);
}
