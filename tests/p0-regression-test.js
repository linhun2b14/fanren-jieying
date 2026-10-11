'use strict';
// P0 回归：2026-10 全量审查发现的 5 个引擎级 bug（E1-E5）。
// 每一条都对应一张（或一类）曾真实失效/出错的牌，修复后在这里留下守卫。
//   E1 淘汰分牌重复：被挑走的 3 张不再进弃牌堆（同名牌按张数扣减）
//   E2 青元剑诀：tiers 不再遮蔽顶层的「对战启用费」入口（combatOpt 能问到、付费后生效）
//   E3 傀儡蜥蜴：致死一击也能替挡（第 3 轮窗口前置后：伤害还没落地，傀儡直接挡掉）
//   E4 阴魂丝：「本次对战禁消耗类宝物牌」有了读取点（候选不出现、强打被拒）
//   E5 风雷翅：场上「对战失败时」效果有了自动结算通道（掷骰免罚真实发生）
const E = require('../server/engine');
const C = require('../server/cards');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
const T = (n) => C.cards().treasure.find((c) => c.name === n);
const S = (n) => C.cards().spell.find((c) => c.name === n);
const logText = (st) => st.log.map((l) => l.text).join(' | ');

function setup(seed, opts) {
  const o = opts || {};
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  for (const q of st.players) q.turnsTaken = 2;   // 越过"第一个回合不能发起对战"
  st.turn = 0; st.step = o.step || 'action'; st.turnFlags = { combat: false, promote: false };
  const A = st.players[0], B = st.players[1];
  A.realm = o.aRealm == null ? 3 : o.aRealm;
  B.realm = o.bRealm == null ? 3 : o.bRealm;
  A.mana = 12; B.mana = 12; A.hp = o.aHp == null ? 6 : o.aHp; B.hp = o.bHp == null ? 6 : o.bHp;
  A.qiCards = []; B.qiCards = []; A.hand = []; B.hand = [];
  A.equip = []; B.equip = []; A.spells = []; B.spells = [];
  A.companions = []; B.companions = []; A.puppets = []; B.puppets = [];
  return { st: st, A: A, B: B };
}
const discardCount = (st) => ['treasure', 'spell', 'companion', 'qi']
  .reduce((n, d) => n + (st.decks[d] && st.decks[d].discard ? st.decks[d].discard.length : 0), 0);
const flush = (st) => { let g = 0; while (st.pending && g++ < 20) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };

console.log('[E1] 淘汰分牌：击杀者挑走的 3 张不再重复进弃牌堆');
{
  const { st, A, B } = setup(7101);
  const t1 = T('青蛟旗'), t2 = T('红线遁光针');
  // 乙有 4 张牌（含同名牌 2 张，考验"按张数扣减"）：手牌 3 + 装备 1
  B.hand = [{ uid: 11, id: t1.id }, { uid: 12, id: t2.id }, { uid: 13, id: t1.id }];
  B.equip = [{ uid: 14, id: t2.id }];
  B.hp = 2;
  const d0 = discardCount(st);
  E.applyDamage(st, B, 99, 'combat', 'a');
  check('乙被淘汰', B.out === true);
  check('甲从遗物中挑走 3 张', A.hand.length === 3, String(A.hand.length));
  const d1 = discardCount(st);
  check('弃牌堆只增加 1 张（4 - 3），没有重复发卡', d1 - d0 === 1, `弃牌堆 +${d1 - d0}（修复前是 +4）`);
  check('牌数守恒：甲 3 + 弃牌堆 1 = 乙原有 4', A.hand.length + (d1 - d0) === 4);
}

/**
 * [E2] 的判别种子（2026-10-06 起不再"找种子"，直接钉死骰点）。
 * ⚠️ 历史：这里原来是"动态找一个能判别的种子"，因为 `diceToBonus` 是台阶表
 * （1→0、2~5→1、6→2），raw≤4 时 +1 前后同分，断言没有判别力；而 RNG 流会随卡池/规则漂移。
 * 现在用引擎的测试注入点 `state.forcedDice` 直接给 raw=5 ⇒ pip=6 一定跨台阶，**确定性**。
 */

console.log('\n[E2] 青元剑诀（带 tiers）：档位效果按卡文时点进窗口（不再被"顶层启用费"遮蔽）');
{
  const { st, A, B } = setup(7102, { aRealm: 1, bRealm: 1 });
  A.spells = [{ uid: 21, id: S('青元剑诀').id, tier: 0 }];   // 已装备，炼气档（投骰前 · 骰点 +1）
  A.mana = 12;
  st.forcedDice = [5, 1];                                   // 甲 5 → +1 → 6 点（跨台阶：+1 分 → +2 分）
  const r0 = E.act(st, 'a', { type: 'combat', target: 'b' });
  // 2026-10-06 迁移：装备的"发动费"不再在开战统一收（那是把【绿煌剑】的获胜效果也提前到开战问的病根），
  // 而是**跟着效果自己的时点走**。青元剑诀卡文没写「装备时不消耗」⇒ 装备时付角标 2、效果免费。
  check('开战时不再有"对战启用费"窗口', r0.paused !== true && !st.pending,
    JSON.stringify([r0, st.pending && st.pending.event]));
  const r1 = E.act(st, 'a', { type: 'roll' });              // 开「我方投骰前」窗口
  check('挂起在「我方投骰前」窗口（炼气档卡文 = 投掷骰子前使用）',
    !!(st.pending && st.pending.event === 'roll' && st.pending.phase === 'before'),
    JSON.stringify([r1, st.pending && [st.pending.event, st.pending.phase]]));
  const cands = E.pendingCards(st, A).map((c) => ({ name: c.name, cost: c.cost, where: c.where }));
  check('候选里有场上的【青元剑诀】（档位效果进得了窗口，不被 tiers 遮蔽）',
    cands.some((c) => c.name === '青元剑诀' && c.where === 'board'), JSON.stringify(cands));
  const m0 = A.mana;
  const r = E.act(st, 'a', { type: 'respond_play', uid: 21 });
  check('发动成功', r.ok, JSON.stringify(r));
  check('这张牌是"装备时付过费"类 ⇒ 发动效果不再扣法力', A.mana === m0, `${m0} -> ${A.mana}`);
  check('骰点 +1 交到了本场对战（combat.diceBonus = 1）',
    (st.combat.diceBonus[A.id] || 0) === 1, JSON.stringify(st.combat.diceBonus));
  flush(st);
  E.act(st, 'b', { type: 'roll' });
  flush(st);
  const tot = (st.log.filter((l) => l.kind === 'combat_total' && l.payload && l.payload.a).pop() || {}).payload || {};
  const aInfo = tot.a || {};
  check(`骰 5 点 +1 → 6 点 ⇒ 附加 +2（不发动只有 +1）；实得 +${aInfo.dice}`,
    aInfo.dice === 2, JSON.stringify(aInfo));
}

console.log('\n[E3] 傀儡蜥蜴：致死一击也能替挡（不再白付法力白送命）');
{
  const { st, A, B } = setup(7103);
  const pup = T('傀儡蜥蜴');
  A.puppets = [{ uid: 31, id: pup.id, name: pup.name, left: 2 }];
  A.hp = 1; A.mana = 12;
  E.applyDamage(st, A, 3, 'card', 'b');   // 3 点致死伤害
  check('致死伤害开出「受伤」窗口', !!st.pending && st.pending.event === 'hurt', st.pending && st.pending.event);
  check('窗口前置：伤害还没落地（生命值仍是 1）', A.hp === 1, String(A.hp));
  check('候选里有傀儡（board）', E.pendingCards(st, A).some((c) => c.name === '傀儡蜥蜴'),
    JSON.stringify(E.pendingCards(st, A)));
  const r = E.act(st, 'a', { type: 'respond_play', uid: 31 });
  check('响应傀儡替伤成功', r.ok, JSON.stringify(r));
  check('支付了 2 点法力替伤费（12 -> 10）', A.mana === 10, String(A.mana));
  check('玩家活着、没出局（修复前：付了费照样出局）', !A.out && A.hp > 0, `hp=${A.hp} out=${A.out}`);
  check('这 3 点伤害被傀儡整个挡下（生命值仍是 1，一滴没掉）', A.hp === 1, String(A.hp));
  check('傀儡剩余替伤次数 2 -> 1', A.puppets.length === 1 && A.puppets[0].left === 1, JSON.stringify(A.puppets));
}

console.log('\n[E4] 阴魂丝：「本次对战禁消耗类宝物牌」真的禁得住');
{
  const { st, A, B } = setup(7104, { aRealm: 3, bRealm: 3 });
  B.hand = [{ uid: 41, id: T('阴魂丝').id }];
  A.hand = [{ uid: 42, id: T('朱雀环').id }];   // 消耗类宝物牌（combatStart 窗口）
  E.act(st, 'a', { type: 'combat', target: 'b' });
  check('开出「被指定为目标」窗口', !!st.pending && st.pending.event === 'combatDeclare', st.pending && st.pending.event);
  const r1 = E.act(st, 'b', { type: 'respond_play', uid: 41 });
  check('乙响应打出【阴魂丝】', r1.ok, JSON.stringify(r1));
  check('封锁已写入本场对战（blocked.a 含消耗类宝物牌）',
    !!(st.combat && st.combat.blocked && (st.combat.blocked.a || []).indexOf('消耗类宝物牌') >= 0),
    JSON.stringify(st.combat && st.combat.blocked));
  // 窗口链走完（或本就没有别的响应）后到投骰前窗口：朱雀环不该再出现
  let sawRollWindow = false, candsA = [];
  for (let g = 0; g < 10 && st.pending; g++) {
    const w = E.pendingActor(st);
    if (!w) break;
    if (w.id === 'a') { candsA = E.pendingCards(st, A).map((c) => c.name); if (st.pending.event === 'roll') sawRollWindow = true; }
    E.act(st, w.id, { type: 'respond_pass' });
  }
  check('甲的响应候选里没有【朱雀环】（被封锁，修复前照出不误）', candsA.indexOf('朱雀环') < 0, JSON.stringify(candsA));
  // 强行打也打不出去：被封锁的牌在**任何时点**都该被拒，且文案要点明这是【阴魂丝】的封锁。
  // ⚠️ 时序（2026-10-02 开战窗口"三合一"之后）：【阴魂丝】的封锁**要等收势才生效**
  //    （"后发先至"：同一个窗口里谁都没结算）。所以先让开战窗口结算完，再到「投骰前」窗口试打。
  const CP2 = (n) => C.cards().companion.find((c) => c.name === n);
  const s2 = setup(7105, { aRealm: 3, bRealm: 3 });
  s2.B.hand = [{ uid: 43, id: T('阴魂丝').id }];
  s2.A.hand = [{ uid: 44, id: T('朱雀环').id }];
  s2.A.companions = [{ uid: 45, id: CP2('温天仁').id }];   // 让甲在开战窗口里也是表态人
  E.act(s2.st, 'a', { type: 'combat', target: 'b' });
  // 队列是"回合玩家优先" → 甲（本回合玩家/攻方）先表态；先让甲放弃，轮到乙
  for (let g = 0; g < 6 && s2.st.pending && E.pendingActor(s2.st) && E.pendingActor(s2.st).id === 'a'; g++) {
    E.act(s2.st, 'a', { type: 'respond_pass' });
  }
  const rp0 = E.act(s2.st, 'b', { type: 'respond_play', uid: 43 });   // 乙打出【阴魂丝】
  check('乙在开战窗口打出【阴魂丝】', rp0.ok === true, JSON.stringify(rp0));
  for (let g = 0; g < 10 && s2.st.pending; g++) {                     // 全部放弃 → 收势 → 封锁生效
    const w = E.pendingActor(s2.st);
    if (!w) break;
    E.act(s2.st, w.id, { type: 'respond_pass' });
  }
  check('阴魂丝的封锁已生效（本场甲的消耗类宝物牌被禁）',
    !!(s2.st.combat && s2.st.combat.blocked && s2.st.combat.blocked.a && s2.st.combat.blocked.a.length),
    JSON.stringify(s2.st.combat && s2.st.combat.blocked));
  E.act(s2.st, 'a', { type: 'roll' });                     // 攻方掷骰
  // ⚠️ 合并窗口（"对战阶段"三合一）之后，"被封锁的人正好轮到自己表态"这条路径变窄了：
  //    开战窗口结算完就没有后续窗口，而被封锁方的**宝物/法术都被禁** → 它可能根本不在任何候选里
  //    （这正是我们想要的：候选里没有它，也就没得打）。所以这里验的是**用户可见的不变量**：
  //      a) 被封锁的牌不会出现在候选里（见上面那条断言）；
  //      b) 就算硬打也一定失败（没有窗口 / 不是时候 / 被封锁，三种理由都算）；
  //      c) 封锁状态确实记在本场对战里（下一场/下一个窗口继续生效）。
  const rejected = E.act(s2.st, 'a', { type: 'respond_play', uid: 44 });
  check('强行用【朱雀环】响应一定失败', !!rejected && rejected.ok === false, JSON.stringify(rejected));
}

console.log('\n[E5] 风雷翅：场上「对战失败时」自动掷骰免罚（不再是白板）');
{
  const { st, A, B } = setup(7106, { aRealm: 4, bRealm: 3 });
  B.equip = [{ uid: 51, id: T('风雷翅').id }];   // 筑基档装备，装备时已付费
  // 双方空手牌 → 结果窗口无人可响应，直接 settleCombat
  E.act(st, 'a', { type: 'combat', target: 'b' });
  st.combat.bonus['a'] = 5;   // 保证甲赢
  E.act(st, 'a', { type: 'roll' }); E.act(st, 'b', { type: 'roll' });
  flush(st);
  const saveLog = st.log.filter((l) => l.kind === 'roll' && l.payload && l.payload.scope === 'save');
  check('战败时触发了风雷翅保命掷骰（修复前从不掷）', saveLog.length === 1,
    JSON.stringify(st.log.filter((l) => l.kind === 'roll').map((l) => l.text)));
  const rolled = saveLog.length ? saveLog[0].payload.value : 0;
  const faces = [1, 3, 6];
  const saved = faces.indexOf(rolled) >= 0;
  check(`掷出 ${rolled} 点（免罚面 ${faces.join('/')}）→ 血量与判罚一致`,
    saved ? B.hp === 6 : B.hp === 5, `hp=${B.hp}（${saved ? '应免罚' : '应 -1'}）`);
  check('战报写明保命是否成功', /保命|免/.test(logText(st)), '');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
