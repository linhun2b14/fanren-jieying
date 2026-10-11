'use strict';
// 生成 docs/卡牌一览.md：把当前卡池按牌堆/类型整理成可读表格。
const fs = require('fs');
const d = require('../data/cards.json');

const REALMS = ['凡人', '炼气期', '筑基期', '结丹期', '元婴期'];
const DECKNAME = { treasure: '宝物牌堆', spell: '法术牌堆', companion: '同行者牌堆', qi: '灵气牌堆' };

const KIND_CN = {
  qi: '获得灵气值', mana: '获得法力值', qi_and_mana: '获得灵气值+法力值', heal: '恢复生命值',
  damage_target: '指定玩家受伤害', damage_all_others: '其他玩家各受伤害', draw: '抽牌',
  dice_bonus: '对战骰点加成', combat_bonus: '对战最终战力加成', combat_debuff: '削减对方战力',
  cancel_attack: '取消对战', skip_turn: '目标跳过下回合', hand_limit_bonus: '手牌上限+',
  damage_reduction: '每次受伤减免', mana_regen_bonus: '每回合法力恢复+', promote_discount: '晋升灵气消耗-',
  promote_discount_once: '晋升灵气消耗-（一次性，用后进弃牌堆）',
  reroll: '掷骰可重掷', look_hand: '查看手牌', steal_card: '抽走对方手牌', damage_shield: '抵挡伤害',
  // 以下为实物卡专属效果
  damage_multi: '指定 1~2 人同时受伤', skip_turns: '跳过下回合所有行为', draw_mixed: '抽宝物+法术各若干',
  reroll_dice: '对战额外掷骰取大', place_draw_qi: '放置时抽灵气牌', combat_bonus_if_enemy_higher_realm: '对方境界更高时战力+',
  lose_save_dice: '战败时掷骰免罚', dice_penalty: '压制对方骰点', steal_equip: '夺走对方全部装备',
  dice_skip_bonus: '放弃掷骰换固定战力+', lose_immunity: '战败免罚', versus_realm_effect: '按对方境界分支',
  lose_retaliate: '战败时反伤对方', block_enemy_card_kind: '禁止对方用某类牌', damage_save_dice: '受伤掷骰抵消/反弹',
  self_damage_then_multi: '先自伤再群伤', damage_higher_realm: '指定境界更高的修士受伤',
  pseudo_realm: '进入伪丹期（限时）', damage_and_skip: '受伤并跳过下回合', nullify_enemy_card: '无效对方 1 张法术/宝物',
  combat_bonus_win_mana: '对战战力+，胜利回法力', win_draw_qi: '对战胜利抽灵气牌', summon_puppet: '召唤傀儡替伤',
  self_revive: '生命归零时自救', flat_power: '放弃掷骰，固定战力值', after_consume_roll6: '用消耗牌后掷6触发伤害',
  curse_target: '诅咒生命最低者', on_promote_draw_qi: '装备/晋升时抽灵气牌', force_reroll_foe: '强制对方重掷',
  win_steal_treasure: '胜利时抽对方宝物牌', win_extra_damage: '胜利时对方额外受伤',
  combat_bonus_if_hp_le: '生命值偏低时战力+', combat_bonus_if_hp_ge: '生命值偏高时战力+',
  turn_no_combat_mana: '回合不发起对战略回法力', turn_no_combat_heal: '回合不发起对战可花法力回生命',
  after_combat_mana: '对战结束后回法力',
};
function eff(e) {
  if (!e || !e.kind) return '—';
  const cn = KIND_CN[e.kind] || e.kind;
  const parts = [];
  if (typeof e.value === 'number') parts.push(e.value);
  if (e.kind === 'qi_and_mana') { parts.length = 0; parts.push(`灵${e.qi}+法${e.mana}`); }
  if (e.deck) parts.push(`(${e.deck})`);
  if (e.cap) parts.push(`上限${e.cap}`);
  if (e.manaCost) parts.push(`耗${e.manaCost}法力`);
  if (e.threshold) parts.push(`阈值${e.threshold}`);
  if (e.scope) parts.push(e.scope);
  return cn + (parts.length ? ' ' + parts.join(' ') : '');
}
/** 同行者三个槽位合并渲染：回合 / 对战（含第二条）/ 晋升 / 受伤 */
function companionCells(c) {
  const turn = eff(c.onTurn);
  const cb = [c.onCombat, c.onCombat2].filter(Boolean).map(eff);
  const combat = cb.length ? cb.join('；') : '—';
  const promote = eff(c.onPromote);
  const hurt = c.onHurt ? eff(c.onHurt) : null;
  return { turn: turn, combat: combat, promote: promote, hurt: hurt };
}
// 装备付费按卡文（2026-10-05 用户裁定）：带「装备时不消耗」→ 免费、效果才计费；没写 → 装备时付
// ⚠️ 2026-10-06 起**费用印在效果上**（`规则文档.md` §7.4）：不再有"开战统一启用费"
//    （`enable_equip_combat` 已从卡池里删干净），所以这里读**效果级 `manaCost`**。
function costCell(c) {
  const effs = (c.effects || []).concat(...(c.tiers || []).map((t) => t.effects || []));
  const fees = effs.map((e) => e.manaCost || 0).filter((n) => n > 0);
  const feeTxt = fees.length ? Array.from(new Set(fees)).join('/') : null;
  if (c.type === 'equip') {
    if (c.equipCost != null) {
      return `装备时付 ${c.equipCost} 法力（效果${feeTxt ? '还要 ' + feeTxt + ' 点' : '不再消耗'}）`;
    }
    if (/装备时不消耗/.test(c.text || '')) {
      // 免费句只说明"装备免费"，**发动其效果时才消耗**，费用印在效果上（每条效果自带的 manaCost）。
      // 角标法力 `cost` 只是实物印刷数字，不能无脑当费用 —— 【掌天瓶】当年就是照抄角标写出假象（④）。
      return feeTxt ? `装备免费（发动效果时才花 ${feeTxt} 点）` : '装备免费（效果也不消耗法力）';
    }
    return `装备时付 ${c.cost || 0} 法力（效果不再消耗）`;
  }
  return c.cost == null ? '—' : String(c.cost);
}

let out = '# 《凡人修仙传：结婴之战》卡牌一览（自动生成）\n\n';
out += '> 由 `tools/gen-cardlist.js` 从 `data/cards.json` 生成，改数据后重跑即可。\n';
out += '> 效果列的括号里是该效果引擎内实现的 `kind`，便于对照 `docs/规则文档.md` §13。\n\n';

const total = ['treasure', 'spell', 'companion', 'qi'].reduce((a, k) => a + d[k].reduce((x, c) => x + c.count, 0), 0);
out += `**总计 ${total} 张**：`;
out += ['treasure', 'spell', 'companion', 'qi'].map((k) => `${DECKNAME[k]} ${d[k].reduce((a, c) => a + c.count, 0)}`).join(' / ');
out += '\n\n---\n\n';

for (const deck of ['treasure', 'spell']) {
  const arr = d[deck];
  out += `## ${DECKNAME[deck]}（${arr.reduce((a, c) => a + c.count, 0)} 张 / ${arr.length} 种）\n\n`;
  for (const type of ['consume', 'equip']) {
    const sub = arr.filter((c) => c.type === type);
    if (!sub.length) continue;
    out += `### ${type === 'consume' ? '消耗类' : '装备类'}（${sub.length} 种）\n\n`;
    out += type === 'equip'
      ? '| 卡名 | 适用境界 | 装备费 | 效果 | 张数 |\n|---|---|---|---|---|\n'
      : '| 卡名 | 适用境界 | 消耗 | 效果 | 张数 |\n|---|---|---|---|---|\n';
    for (const c of sub) {
      const tierBlock = (c.tiers && c.tiers.length)
        ? '<br>**多境界档位（装备时选 1 档）**：' + c.tiers.map((t, i) =>
            `<br>　${i + 1}. ${t.text} <br>　　\`${eff(t.effect)}\``).join('')
        : '';
      if (type === 'equip') {
        out += `| ${c.name} \`${c.id}\` | ${REALMS[c.realm] || '凡人'}及以上 | ${costCell(c)} | ${c.text} <br>\`${eff(c.effect)}\`${tierBlock} | ${c.count} |\n`;
      } else {
        out += `| ${c.name} \`${c.id}\` | ${REALMS[c.realm] || '凡人'}及以上 | ${costCell(c)} | ${c.text} <br>\`${eff(c.effect)}\` | ${c.count} |\n`;
      }
    }
    out += '\n';
  }
}

out += `## ${DECKNAME.companion}（${d.companion.reduce((a, c) => a + c.count, 0)} 张 / ${d.companion.length} 种）\n\n`;
out += '> 同行者**没有境界限制**，只看占位：`slots` = 占几个位置（1 或 2）。\n';
out += '> 效果分四个触发时点：**回合**（自己回合内）、**对战**（对战发生时，可有多条）、**晋升**、**受伤**。\n';
out += '> **普通同行者不替挡伤害**，只有卡文明写「可替你承受」的（`absorb`）才会替挡；没写替挡的同行者只是常驻效果。\n';
out += '> 「待补卡文」= 这张牌已从实物照片抄到卡名，但效果文字还没拍到，**引擎里是空效果**。\n\n';
out += '| 卡名 | 占位 | 替挡 | 效果卡文 | 回合 | 对战 | 晋升 | 受伤 | 张数 |\n|---|---|---|---|---|---|---|---|---|\n';
for (const c of d.companion) {
  const absorb = c.absorb ? `**替挡**：挡下 ${c.absorb === true ? 1 : c.absorb} 次伤害后弃置` : '不替挡';
  const k = companionCells(c);
  const text = c.note ? `⚠️ ${c.text}（${c.note}）` : c.text;
  out += `| ${c.name} \`${c.id}\` | ${c.slots === 2 ? '**占 2 位**' : '占 1 位'} | ${absorb} | ${text} | ${k.turn} | ${k.combat} | ${k.promote} | ${k.hurt || '—'} | ${c.count} |\n`;
}
out += '\n## ' + DECKNAME.qi + `（${d.qi.reduce((a, c) => a + c.count, 0)} 张 / ${d.qi.length} 种）\n\n`;
out += '> 每张灵气牌本身 = **1 点灵气值**；抽完自动再补一整组 60 张。\n\n';
out += '| 卡名 | 附加效果 | 张数 |\n|---|---|---|\n';
for (const c of d.qi) out += `| ${c.name} \`${c.id}\` | ${c.effect ? eff(c.effect) : '（无，仅 1 点灵气值）'} | ${c.count} |\n`;

fs.writeFileSync('docs\\卡牌一览.md', out, 'utf8');
console.log('已生成 docs/卡牌一览.md，', out.length, '字符');

// 同时打印一份纯文本清单，便于直接贴给人看
console.log('\n========== 纯文本清单 ==========');
for (const deck of ['treasure', 'spell']) {
  console.log(`\n### ${DECKNAME[deck]}`);
  for (const c of d[deck]) {
    const t = c.type === 'equip' ? '装备' : '消耗';
    console.log(`[${t}] ${c.name}（${REALMS[c.realm] || '凡人'}+，${costCell(c)}，${c.count}张）— ${c.text}`);
  }
}
console.log('\n### 同行者');
for (const c of d.companion) {
  const parts = [];
  if (c.onTurn) parts.push('回合:' + eff(c.onTurn));
  if (c.onCombat) parts.push('对战:' + eff(c.onCombat));
  if (c.onCombat2) parts.push('对战2:' + eff(c.onCombat2));
  if (c.onPromote) parts.push('晋升:' + eff(c.onPromote));
  if (c.onHurt) parts.push('受伤:' + eff(c.onHurt));
  if (c.absorb) parts.push(`替挡x${c.absorb === true ? 1 : c.absorb}`);
  const flag = c.note ? ' ⚠️待补' : '';
  console.log(`${c.name}（占${c.slots}位，${c.count}张）${flag} — ${c.text}${parts.length ? '  || ' + parts.join('；') : ''}`);
}
console.log('\n### 灵气牌');
for (const c of d.qi) console.log(`${c.name}（${c.count}张）— ${c.effect ? eff(c.effect) : '仅 1 点灵气值'}`);
