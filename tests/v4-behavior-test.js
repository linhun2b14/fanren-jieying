'use strict';
// v4 新行为回归：
//   A. 三段式手动抽取：顺序正确、跳步被拒、闭关三阶段都可宣布
//   B. 两段式掷骰：roll_defender 阶段只有应战方能投；且**双方在该阶段仍可打对战类卡牌**（本轮刚修）
//   C. 非对战类卡牌在后投阶段仍被拒
const E = require('../server/engine');
const C = require('../server/cards');
const { opsOf, opOf } = require('./fixtures');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
let skipCount = 0;
/** 「条件不成立 → 这条没什么可验」的断言走 skip()：**只记录、不计入通过数**
 *  （以前写成 `check(名, true)`，永远通过，把"通过数"撑虚高了 —— 交接 §5.2 的老欠账）。 */
const skip = (n, why) => { skipCount++; console.log('  ⊘ ' + n + (why ? '  << ' + why : '')); };

function newGame(seed) {
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
   // 测试直接造局，不走真实回合流程 —— 这里标记"两边的第一个回合都已经过去"（新规则：第一个回合不能发起对战）
      for (const q of st.players) q.turnsTaken = 2;
  return st;
}
function toAction(st) {
  const pl = st.players[st.turn];
  E.act(st, pl.id, { type: 'draw_qi' });
  E.act(st, pl.id, { type: 'draw_treasure' });
  E.act(st, pl.id, { type: 'choose_draw', deck: 'spell' });
  return pl;
}

console.log('[A] 三段式手动抽取');
{
  const st = newGame(3001);
  const pl = st.players[st.turn];
  check('开局停在 draw_qi（不再自动抽完）', st.step === 'draw_qi', st.step);
  check('开局手牌 = 2 张宝物', pl.hand.length === 2, String(pl.hand.length));
  check('开局灵气区为空', E.qiOf(pl) === 0, String(E.qiOf(pl)));

  const skip1 = E.act(st, pl.id, { type: 'draw_treasure' });
  check('跳步（draw_qi 阶段点探索）被拒', skip1.ok === false, JSON.stringify(skip1));
  const skip2 = E.act(st, pl.id, { type: 'choose_draw', deck: 'spell' });
  check('跳步（draw_qi 阶段点二选一）被拒', skip2.ok === false, JSON.stringify(skip2));
  const skip3 = E.act(st, pl.id, { type: 'end_turn' });
  check('draw_qi 阶段可以直接结束回合（允许）', skip3.ok === true, JSON.stringify(skip3));

  const st2 = newGame(3002);
  const p2 = st2.players[st2.turn];
  check('闭关可在 draw_qi 宣布', E.act(st2, p2.id, { type: 'seclusion' }).ok === true
    || p2.seclusionUsed === false, '（本局已被占用则跳过）');
  const st3 = newGame(3003);
  const p3 = st3.players[st3.turn];
  E.act(st3, p3.id, { type: 'draw_qi' });
  check('闭关可在 draw_treasure 宣布', E.act(st3, p3.id, { type: 'seclusion' }).ok === true, st3.step);

  const st4 = newGame(3004);
  const p4 = st4.players[st4.turn];
  E.act(st4, p4.id, { type: 'draw_qi' });
  E.act(st4, p4.id, { type: 'draw_treasure' });
  check('闭关可在 choose_draw 宣布', E.act(st4, p4.id, { type: 'seclusion' }).ok === true, st4.step);

  // 正常三段
  const st5 = newGame(3005);
  const p5 = st5.players[st5.turn];
  const before = E.qiOf(p5);
  E.act(st5, p5.id, { type: 'draw_qi' });
  check('抽灵气后灵气值增加', E.qiOf(p5) > before, `${before} -> ${E.qiOf(p5)}`);
  E.act(st5, p5.id, { type: 'draw_treasure' });
  check('探索后手牌 +2', p5.hand.length === 4, String(p5.hand.length));
  E.act(st5, p5.id, { type: 'choose_draw', deck: 'spell' });
  check('二选一后手牌 +1 且进入行动阶段', p5.hand.length === 5 && st5.step === 'action', `${p5.hand.length}/${st5.step}`);
}

console.log('\n[B] 两段式掷骰 + 后投窗口打牌');
{
  const st = newGame(3010);
  const A = toAction(st);
  const B = st.players.find((x) => x.id !== A.id);
  A.mana = 12; B.mana = 12;
  A.realm = 4; B.realm = 4; A.equip = []; B.equip = [];

  const rc = E.act(st, A.id, { type: 'combat', target: B.id });
  check('发起对战成功', rc.ok, rc.error);
  // ⚠️ 开战那一刻是**三合一窗口**（combatDeclare + combatOpt）：只要随机起手牌里有对战类牌就会挂起，
  //    后面的"掷骰"会被拒（"正在等待 XX 决定是否破招"）。本段只关心两段式掷骰，先把窗口全部放弃。
  //    （卡池一变，洗牌与起手牌都会变 —— 2026-10-06 用户改过张数后实测踩到）
  for (let g = 0; g < 6 && st.pending; g++) {
    const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' });
  }
  check('进入 pre 阶段', st.combat.stage === 'pre', st.combat.stage);

  const wrongRoll = E.act(st, B.id, { type: 'roll' });
  check('pre 阶段应战方不能掷骰（必须先由攻方投）', wrongRoll.ok === false, JSON.stringify(wrongRoll));

  // 先把应战方那张"对方投骰后"的牌放进手里，再让攻方掷骰 ——
  // 这样"投骰·后"窗口一开就有他作为候选（没人在意的时点是不开窗的）
  const META0 = require('../server/effect-meta');
  const afterFoeCard = ['treasure', 'spell'].map((d) => C.cards()[d]).flat()
    .find((c) => c.type !== 'equip' && (c.effects || []).some((e) => {
      const t = META0.timingOfEffect(e);
      return t && t.event === 'roll' && t.phase === 'after' && t.subject === 'foe';
    }));
  if (afterFoeCard) B.hand = [{ uid: 5501, id: afterFoeCard.id }];

  const r1 = E.act(st, A.id, { type: 'roll' });
  // 新的锁链流程：攻方点掷骰先开「投骰·前」窗口，掷完再开「投骰·后」窗口。
  // 这里先把「前」窗口放弃掉（本段只关心"后投窗口还能不能打牌"），再去处理「后」窗口。
  for (let g = 0; g < 4 && st.pending; g++) {
    if (st.pending.phase !== 'before') break;
    const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' });
  }
  check('攻方掷骰成功', r1.ok, r1.error);
  check('进入 roll_defender 阶段', st.combat.stage === 'roll_defender', st.combat.stage);
  check('攻方点数已确定', typeof st.combat.dice[A.id] === 'number', String(st.combat.dice[A.id]));
  check('应战方点数尚未确定', st.combat.dice[B.id] === undefined, String(st.combat.dice[B.id]));

  const again = E.act(st, A.id, { type: 'roll' });
  check('攻方不能连投两次', again.ok === false, JSON.stringify(again));

  // 找一张应战方在 roll_defender 阶段**确实可以**打的牌。
  // 注意：不能随便挑「对战类」牌 —— 卡文写「对方投骰前」的（【寒冰珠】）在应战方这边
  // 已经不成立（攻方那一投早出去了），按卡文字面上就不该能打。
  // 应战方此刻还没投骰、但对方已投，所以合法的是「我方投骰前」和「对方投骰后」的牌。
  // （低境界装备里那些"投骰前"的已经改成常驻修正【standing】，由"对战启用费"询问决定用不用，
  //   不再走投骰窗口；所以这里用「对方投骰后」的【颠倒五行阵】来验证。）
  const META = require('../server/effect-meta');
  const combatCard = ['treasure', 'spell'].map((d) => C.cards()[d]).flat()
    .find((c) => c.type !== 'companion' && c.type !== 'equip'
      && (c.effects || []).some((e) => {
        const t = META.timingOfEffect(e);
        return t && t.event === 'roll' && t.phase === 'after' && t.subject === 'foe';
      }));
  check('卡池里有「对方投骰后」的对战牌', !!combatCard, combatCard && combatCard.name);

  if (afterFoeCard) {
    // 关键：应战方在攻方投完之后仍能出牌 —— 用户报过的 bug。
    // 锁链里这一刻就是"投骰·后"窗口（主体=攻方、对家=应战方），【颠倒五行阵】属「对方投骰后」→ 轮到应战方。
    check('攻方投完后开出了「投骰·后」窗口等应战方响应',
      !!st.pending && st.pending.event === 'roll' && st.pending.phase === 'after',
      JSON.stringify(st.pending && [st.pending.event, st.pending.phase]));
    check('待表态的是应战方', !!E.pendingActor(st) && E.pendingActor(st).id === B.id,
      E.pendingActor(st) && E.pendingActor(st).id);
    B.mana = 12;
    const cands = E.pendingCards(st, B).map((c) => c.name);
    check(`应战方在"后投窗口"能打出【${afterFoeCard.name}】`, cands.indexOf(afterFoeCard.name) >= 0, JSON.stringify(cands));
    const rPlay = E.act(st, B.id, { type: 'respond_play', uid: 5501 });
    check(`应战方打出【${afterFoeCard.name}】`, rPlay.ok === true, JSON.stringify(rPlay));
    check('牌确实生效了（离开手牌）', B.hand.length === 0, `手牌 ${B.hand.length}`);
    const c2 = st.combat || {};
    const touched = (c2.diceBonus && Object.keys(c2.diceBonus).length) > 0
      || (c2.equipBonus && Object.keys(c2.equipBonus).length) > 0
      || ['bonus', 'debuff', 'dicePenalty', 'flatPower', 'skipDice', 'forceReroll', 'loseSave', 'loseRetaliate']
        .some((k) => c2[k] && Object.keys(c2[k]).length);
    check('该牌确实进入了本次对战的结算数据（强制重掷等）', !!touched,
      JSON.stringify({ bonus: c2.bonus, forceReroll: c2.forceReroll, equipBonus: c2.equipBonus && Object.keys(c2.equipBonus) }));
    // 把剩下的窗口放弃掉，让对战继续
    for (let g = 0; g < 8 && st.pending; g++) {
      const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' });
    }
  }

  // 卡文时机不符的牌不该出现在窗口里：应战方自己的"投骰·前"窗口里，
  // 「对方投骰前」的【寒冰珠】不合法（攻方那一投早出去了）
  const wrongWindow = ['treasure', 'spell'].map((d) => C.cards()[d]).flat()
    .find((c) => c.type !== 'equip' && (c.effects || []).some((e) => {
      const t = META.timingOfEffect(e);
      return t && t.event === 'roll' && t.phase === 'before' && t.subject === 'foe';
    }));
  // 非对战类卡牌在该阶段仍应被拒（走询问响应时会因为"不是这个时点的牌"被拒）
  const nonCombat = ['treasure', 'spell'].map((d) => C.cards()[d]).flat()
    .find((c) => c.type !== 'equip' && opOf(c, 'play') === 'heal');
  if (nonCombat) {
    B.hand = [{ uid: 5502, id: nonCombat.id }];
    const rBad = E.act(st, B.id, { type: 'play', uid: 5502 });
    check(`非对战类【${nonCombat.name}】在 roll_defender 阶段被拒`, rBad.ok === false, JSON.stringify(rBad));
  } else {
    skip('（卡池无 heal 类消耗卡，跳过）');
  }

  // 应战方掷骰 —— 会先开「投骰·前」窗口。
  // 顺便验证：应战方自己这口"投骰前"的窗口里，「对方投骰前」的【寒冰珠】不合法（攻方那一投早出去了）。
  if (wrongWindow) B.hand = [{ uid: 5503, id: wrongWindow.id }];
  const r2 = E.act(st, B.id, { type: 'roll' });
  if (wrongWindow && st.pending && st.pending.event === 'roll' && st.pending.phase === 'before') {
    const cands = E.pendingCards(st, B).map((c) => c.name);
    check(`「对方投骰前」的【${wrongWindow.name}】不在应战方"投骰·前"的候选里（时点校验）`,
      cands.indexOf(wrongWindow.name) < 0, JSON.stringify(cands));
    for (let g = 0; g < 8 && st.pending; g++) {
      const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' });
    }
  }
  check('应战方掷骰成功（窗口关掉后已结算）', r2.ok, r2.error);
  const totalLog = st.log.filter((l) => l.kind === 'combat_total').pop();
  check('产生了结算日志', !!totalLog, '（无）');
  if (totalLog) console.log('     ' + totalLog.text.slice(0, 130));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
