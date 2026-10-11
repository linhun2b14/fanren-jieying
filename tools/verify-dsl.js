'use strict';
// 效果 DSL 重构的**验收自检** —— 一键复现"重构确实做完了"的证据。
// 用法：node tools/verify-dsl.js
const fs = require('fs');
const path = require('path');
const META = require('../server/effect-meta');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const engine = read('server/engine.js');
const appjs = read('public/app.js');
const raw = JSON.parse(read('data/cards.json'));
const DECKS = ['treasure', 'spell', 'companion', 'qi'];

let pass = 0, fail = 0;
let badTiming = [];
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  << ' + extra : '')); }
};

/**
 * 一张卡的**全部**效果（主效果 + 各档位 + `roll_branch` 的支线子效果）。
 * ⚠️ 递归是必须的：分支里的 op/时点要是漏检，就会长出"只写不读的幽灵效果"（本项目的老毛病）。
 */
function flatEffects(c) {
  const out = [];
  const walk = (e, nested) => {
    out.push({ e: e, nested: !!nested });
    if (e && e.op === 'roll_branch') {
      for (const b of (e.branches || [])) for (const s of (b.effects || [])) walk(s, true);
      for (const s of (e.else || [])) walk(s, true);
    }
  };
  for (const e of c.effects || []) walk(e, false);
  for (const t of c.tiers || []) for (const e of t.effects || []) walk(e, false);
  return out;
}

console.log('[① cards.json 统一成 effects 数组，8 个散槽消失]');
const LEGACY = ['effect', 'onPlace', 'onTurn', 'onCombat', 'onCombat2', 'onHurt', 'onLowHp', 'onWin', 'onPromote'];
let legacyLeft = 0, withEffects = 0, tierLegacy = 0, effectTotal = 0;
for (const deck of DECKS) for (const c of raw[deck] || []) {
  if (Array.isArray(c.effects)) withEffects++;
  for (const f of LEGACY) if (c[f] !== undefined) legacyLeft++;
  for (const t of c.tiers || []) { if (t.effect !== undefined) tierLegacy++; effectTotal += (t.effects || []).length; }
  effectTotal += (c.effects || []).length;
}
const cardCount = DECKS.reduce((s, d) => s + (raw[d] || []).length, 0);
check(`全部 ${cardCount} 张卡都有 effects 数组`, withEffects === cardCount, `${withEffects}/${cardCount}`);
check('数据里没有残留的 effect/onCombat/onWin 等散槽', legacyLeft === 0, String(legacyLeft));
check('tiers 内层也迁成了 effects', tierLegacy === 0, String(tierLegacy));
check('每条效果都声明了时点（when 或 event）与 op', (() => {
  // （engineDirect 例外已废：2026-10-05 阶段事务模型后【青易居士】explore_swap 也挂探索时点，
  //   全池不再有"不占时点"的 op —— 这条检查恢复为无条件要求 when/event。）
  badTiming = [];
  for (const deck of DECKS) for (const c of raw[deck] || []) {
    const all = flatEffects(c);
    for (const x of all) {
      const e = x.e;
      if (!e.op) { badTiming.push(`${c.name}: 没有 op`); continue; }
      // `roll_branch` 的支线子效果**不声明时点**（跟着父节点那次掷骰结算）
      if (!x.nested && !e.when && !e.event) badTiming.push(`${c.name}: ${e.op} 既没 when 也没 event`);
    }
  }
  return badTiming.length === 0;
})(), badTiming.slice(0, 5).join('、'));
check('【青易居士】explore_swap 挂在探索时点（阶段事务：替换型效果）', (() => {
  const qy = (raw.companion || []).find((c) => c.name === '青易居士');
  if (!qy) return false;
  const e = (qy.effects || []).find((x) => x.op === 'explore_swap');
  return !!e && e.event === 'drawTreasure' && e.oncePerTurn === true;
})());
check('用总线写法（event）的效果，其事件与阶段都在权威表里', (() => {
  for (const deck of DECKS) for (const c of raw[deck] || []) {
    const all = flatEffects(c);
    for (const e of all) {
      if (!e.event) continue;
      const ev = META.EVENTS[e.event];
      if (!ev) return false;
      if (e.phase && ev.phases.indexOf(e.phase) < 0) return false;
    }
  }
  return true;
})());

console.log('\n[② 通用触发收集器 + 条件求值器，替代 6 个各自为政的扫描函数]');
check('引擎有 collectEffects()', /function collectEffects\(/.test(engine));
check('引擎有 matchConditions()', /function matchConditions\(/.test(engine));
// noCombatHeal 已删（【墨彩环】改由 resolveEffect 的 turn_no_combat_heal 分支实现，不再另设扫描函数）
const SCANNERS = ['passives', 'companionCombat', 'hurtMana', 'lowHpRescue', 'afterCombatMana'];
for (const f of SCANNERS) {
  const i = engine.indexOf('function ' + f + '(');
  const body = i < 0 ? '' : engine.slice(i, i + 800).split('\n}\n')[0];
  check(`${f}() 走 collectEffects（不再自己扫槽）`, body.indexOf('collectEffects') >= 0);
}
check('doPlay 里内联的 onPlace 已改为 collectEffects(place)',
  /collectEffects\(pl, 'place'/.test(engine));

console.log('\n[③ 条件型 kind 已降级为「通用 op + if」]');
const COND_KINDS = ['combat_bonus_if_hp_le', 'combat_bonus_if_hp_ge',
  'combat_bonus_if_enemy_higher_realm', 'combat_bonus_if_companion', 'versus_realm_effect'];
let usedCond = 0;
for (const deck of DECKS) for (const c of raw[deck] || []) {
  for (const e of (c.effects || [])) if (COND_KINDS.indexOf(e.op) >= 0) usedCond++;
  for (const t of c.tiers || []) for (const e of (t.effects || [])) if (COND_KINDS.indexOf(e.op) >= 0) usedCond++;
}
check('卡池里已不再使用条件型 kind', usedCond === 0, String(usedCond));
check('引擎有 conditionify（旧数据自动降级）', /combat_bonus_if_hp_le/.test(read('server/cards.js')));
const withIf = [];
for (const deck of DECKS) for (const c of raw[deck] || []) {
  for (const e of (c.effects || [])) if (e.if) withIf.push(c.name);
}
check('确实有卡在用 if 条件（不再靠新 kind）', withIf.length > 0, withIf.slice(0, 5).join('、'));

console.log('\n[④ 元数据单一来源 + /api/meta 下发（前端无第二份词典）]');
check('server/effect-meta.js 存在且零依赖', fs.existsSync(path.join(ROOT, 'server/effect-meta.js'))
  && !/require\(/.test(read('server/effect-meta.js')));
for (const [name, expr] of [['NEEDS_TARGET', 'META.needsTargetOps()'], ['REQUIRES_COMBAT', 'META.requiresCombatOps()'],
  ['TIE_KINDS', 'META.tieOps()'], ['PASSIVE_OPS', 'META.passiveOps()'], ['COMBAT_KINDS', 'META.LEGACY_COMBAT_OPS']]) {
  check(`${name} 由元数据派生`, new RegExp('const ' + name + ' = new Set\\(\\s*' + expr.replace(/[.()]/g, '\\$&')).test(engine));
}
check('服务端暴露 /api/meta', /'\/api\/meta'/.test(read('server/index.js')));
const appCode = appjs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
check('前端代码里已无本地 KIND_TXT 词典', !/KIND_TXT/.test(appCode));
check('前端确实去 /api/meta 取标签', /\/api\/meta/.test(appCode));
check(`元数据表登记了 ${Object.keys(META.OPS).length} 个 op / ${Object.keys(META.WHEN).length} 个时机`,
  Object.keys(META.OPS).length >= 60 && Object.keys(META.WHEN).length >= 16);

console.log('\n[⑤ lint-cards.js 自动比对卡文与数据]');
check('tools/lint-cards.js 存在', fs.existsSync(path.join(ROOT, 'tools', 'lint-cards.js')));
check('能自动产出未实装清单（docs/卡牌实装覆盖率.md）',
  fs.existsSync(path.join(ROOT, 'docs', '卡牌实装覆盖率.md')));

console.log('\n[⑥ 文档]');
const rules = read('docs/规则文档.md');
check('规则文档有 DSL 速查章节', /效果 DSL 速查/.test(rules));
check('规则文档写了 when 表', /beforeMyRoll/.test(rules) && /afterFoeRoll/.test(rules));
check('规则文档写了 if 条件表', /enemyRealm/.test(rules) && /companion/.test(rules));
check('规则文档写了「加一张新卡的标准流程」', /加一张新卡的标准流程/.test(rules));
check('规则文档写了时机校验开关', /FANREN_TIMING_ENFORCE/.test(rules));
check('规则文档的未实装清单已改为自动生成说明', /自动生成/.test(rules));

console.log('\n[⑦ 时点硬校验（步骤 C）：卡池声明的时点必须**真会被引擎触发**]');
// 判据（与编辑器 tools/editor/server.js 的 timingWiring 同一套，两条通道都要认）：
//   ① engine.js 里的 `fireTiming(state, '<事件>'`（会开窗/留痕的时点）
//   ② `collectEffects(x, '<时机>')` 这类**自动收集**通道（回合开始 / 放置同行者 / 装备宝器 /
//      生命濒危 / 对战结束 / 受伤 / 晋升 …）—— 少了它会把 turnStart/place/lowHp/equip/combatEnd
//      误判成"引擎从不触发"（2026-10-02 迁移数据时实测踩到）
//   ③ 常量名单 COMBAT_BONUS_KEYS（对战窗口的归一化键，由 ① 之外的通道收集）
// 为什么要有这条：以前"时点接线"只有编辑器在管，绕过编辑器直接改 cards.json 就没人拦
//（`combatPlay` 这种"表里有、引擎从不触发"的坐标写进去也不会有人报错）——见 docs\时点规范.md §2/§5。
const LIVE_KEYS = new Set();
{
  let m;
  const re1 = /fireTiming\(\s*state\s*,\s*'([^']+)'/g;
  while ((m = re1.exec(engine))) LIVE_KEYS.add(m[1]);
  const re2 = /collectEffects\(\s*\w+\s*,\s*'([^']+)'/g;
  const collected = [];
  while ((m = re2.exec(engine))) collected.push(m[1]);
  for (const w of collected.concat(META.COMBAT_BONUS_KEYS || [])) {
    for (const k of META.wantKeys([w])) LIVE_KEYS.add(k);
  }
  // ③ **合并窗口的规格**：`{ event: 'combatOpt', allSides: true }` 这类字面量 ——
  //    「对战阶段」把 combatDeclare + combatOpt 合成一次询问（2026-10-02），
  //    它们不再各自出现在 `fireTiming(state, '...')` 里，只认前两条会把它们误判成"引擎从不触发"。
  //    ⚠️ 先去掉注释再扫，并且要求前面有个 `{` —— 否则注释里举反例的 `event:'combatPlay'`
  //    会被当成"引擎真会触发"（2026-10-02 实测：这条自检就是这么红的）。
  const code = engine.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const re3 = /\{\s*event:\s*'([^']+)'/g;
  while ((m = re3.exec(code))) LIVE_KEYS.add(m[1]);
}
/** 非时点的"时机"（常驻 / 按钮类）—— 它们本来就不该被引擎触发，继续这么写 */
const NON_TIMING = ['standing', 'passive', 'activate'];
/** 这条效果的时点有什么问题？没问题返回 null（返回字符串便于 CLI 直接读） */
function timingProblem(e) {
  if (!e) return null;
  if (!e.op) return '没有 op';
  if (!e.when && !e.event) {
    const o = META.OPS[e.op];
    return (o && o.engineDirect) ? null : `${e.op}: 既没 when 也没 event（又不是 engineDirect）`;
  }
  for (const k of META.timingKeys(e)) {
    if (NON_TIMING.indexOf(k) >= 0) continue;
    const evName = String(k).split(':')[0];
    const ev = META.EVENTS[evName];
    if (!ev) {
      return `时点「${k}」不在 EVENTS 表里（新卡只能从 docs\\时点规范.md §2 的 24 格表里挑）`;
    }
    if (!LIVE_KEYS.has(k) && !LIVE_KEYS.has(evName)) {
      return `时点「${k}」（${ev.label}）**引擎从不触发** —— 这条效果是死的（不会生效、也不会问人）`;
    }
  }
  return null;
}
const deadTiming = [];
for (const deck of DECKS) for (const c of raw[deck] || []) {
  const all = flatEffects(c);
  for (const x of all) {
    if (x.nested) continue;                        // 掷骰支线的子效果不声明时点，跟着父节点走
    const p = timingProblem(x.e);
    if (p) deadTiming.push(c.name + ' → ' + p);
  }
}
check(`卡池里 ${effectTotal} 条效果的时点全部落在"引擎真会触发"的格子上`,
  deadTiming.length === 0, deadTiming.slice(0, 5).join('、'));
// 自检的自检：校验器必须**能判别**（改坏了要红）。只会"恰好为真"的校验等于没校验。
check('硬校验认得自动收集通道（turnStart 的卡判为合法）',
  timingProblem({ event: 'turnStart', op: 'draw' }) === null);
check('硬校验拦得住"表里有、引擎从不触发"的坐标（combatPlay）',
  !!timingProblem({ event: 'combatPlay', op: 'damage' }),
  String(timingProblem({ event: 'combatPlay', op: 'damage' })));
check('硬校验拦得住 EVENTS 表里没有的事件（拼错的事件名）',
  !!timingProblem({ event: 'turnStartt', op: 'draw' }));
check('硬校验不会误伤常驻/按钮类（standing / activate）',
  timingProblem({ when: 'standing', op: 'combat_bonus' }) === null
  && timingProblem({ when: 'activate', op: 'heal' }) === null);

console.log(`\n通过 ${pass} / ${pass + fail}`);
process.exit(fail ? 1 : 0);
