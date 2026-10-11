'use strict';
// 【傀儡蜥蜴】与【火弹术】专项回归（依据用户口头确认的卡文）。
const E = require('../server/engine');
const C = require('../server/cards');
const { tierOp, effOf, opOf } = require('./fixtures');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
let skipCount = 0;
/** 「条件不成立 → 这条没什么可验」的断言走 skip()：**只记录、不计入通过数**
 *  （以前写成 `check(名, true)`，永远通过，把"通过数"撑虚高了 —— 交接 §5.2 的老欠账）。 */
const skip = (n, why) => { skipCount++; console.log('  ⊘ ' + n + (why ? '  << ' + why : '')); };

const puppet = C.cards().treasure.find((c) => c.name === '傀儡蜥蜴');
const huo = C.cards().spell.find((c) => c.name === '火弹术');

console.log('[A] 傀儡蜥蜴是「宝物牌 / 傀儡形法器」，不是同行者');
check('在宝物牌堆里', !!puppet, puppet && puppet.cat);
check('类型是「傀儡形法器」', puppet && puppet.cat === '傀儡形法器', puppet && puppet.cat);
check('不在同行者牌堆里', !C.cards().companion.some((c) => c.name === '傀儡蜥蜴' || c.name === '傀母斩蜴'));
check('效果 = 召唤傀儡（替伤2次 / 每次2法力）',
  puppet && opOf(puppet, 'play') === 'summon_puppet' && effOf(puppet, 'play').absorbs === 2 && effOf(puppet, 'play').manaCost === 2,
  puppet && JSON.stringify(effOf(puppet, 'play')));

{
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 5001 });
  E.beginGame(st);
  const P = st.players[0];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  P.mana = 12; P.hand = [{ uid: 9001, id: puppet.id }]; P.companions = []; P.hp = 6;
  P.equip = []; P.spells = []; P.puppets = [];

  const manaBefore = P.mana;
  check('打出成功', E.act(st, P.id, { type: 'play', uid: 9001 }).ok);
  check('装备时不消耗法力', P.mana === manaBefore, `${manaBefore} -> ${P.mana}`);
  check('傀儡已就位（独立傀儡位，2 次）', P.puppets.length === 1 && P.puppets[0].left === 2, JSON.stringify(P.puppets));
  check('不占储物袋格子', P.equip.length === 0, String(P.equip.length));
  check('牌留在场上，没进弃牌堆', !st.decks.treasure.discard.includes(puppet.id));

  const hp0 = P.hp; let m0 = P.mana;
  // 用户通则：**需要付费的都要询问**（付不起自动跳过）——
  // 【傀儡蜥蜴】每次替伤要 2 点法力，所以现在是「受伤」时点的一个**响应**，由玩家决定。
  E.applyDamage(st, P, 5, 'test');
  check('受到伤害后开出了受伤窗口', !!st.pending && st.pending.event === 'hurt',
    JSON.stringify(st.pending && st.pending.event));
  check('候选里有【傀儡蜥蜴】（场上响应）',
    E.pendingCards(st, P).some((c) => c.name === '傀儡蜥蜴' && c.where === 'board'),
    JSON.stringify(E.pendingCards(st, P)));
  E.act(st, P.id, { type: 'respond_play', uid: P.puppets[0].uid });
  check('第1次替伤：主人不掉血', P.hp === hp0, `${hp0} -> ${P.hp}`);
  check('第1次替伤：消耗 2 点法力', m0 - P.mana === 2, `${m0} -> ${P.mana}`);
  check('剩余 1 次', P.puppets.length === 1 && P.puppets[0].left === 1, JSON.stringify(P.puppets));

  m0 = P.mana;
  E.applyDamage(st, P, 3, 'test');
  E.act(st, P.id, { type: 'respond_play', uid: P.puppets[0].uid });
  check('第2次替伤：主人仍不掉血', P.hp === hp0);
  check('第2次替伤后傀儡进弃牌堆（傀儡位空出来）',
    P.puppets.length === 0 && st.decks.treasure.discard.includes(puppet.id), JSON.stringify(P.puppets));

  E.applyDamage(st, P, 2, 'test');
  check('傀儡用尽后伤害落到主人身上（不再开窗）', P.hp === hp0 - 2 && !st.pending, `${P.hp}`);

  // 放弃替伤 → 伤害落到自己身上（也要能拒绝）
  const R = st.players[0];
  R.puppets = [];
  R.hand = [{ uid: 9010, id: puppet.id }];
  R.mana = 12; R.hp = 6;
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  if (st.pending) { const w = E.pendingActor(st); E.act(st, w.id, { type: 'respond_pass' }); }
  E.act(st, R.id, { type: 'play', uid: 9010 });
  const rh = R.hp;
  E.applyDamage(st, R, 3, 'test');
  check('放弃替伤时挂着窗口', !!st.pending, '');
  E.act(st, R.id, { type: 'respond_pass' });
  check('放弃后伤害落到自己身上', R.hp === rh - 3, `${rh} -> ${R.hp}`);
  check('放弃后傀儡次数没被消耗', R.puppets[0].left === 2, JSON.stringify(R.puppets));
  R.puppets = [];

  // 法力不足时根本不该问
  const Q = st.players[1];
  Q.mana = 12; Q.hp = 6; Q.hand = [{ uid: 9002, id: puppet.id }]; Q.puppets = [];
  st.turn = 1; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  E.act(st, Q.id, { type: 'play', uid: 9002 });
  Q.mana = 1;                                        // 不足 2 点
  const qh = Q.hp;
  E.applyDamage(st, Q, 2, 'test');
  check('法力不足 2 点时傀儡无法替伤（连窗口都不开）', Q.hp === qh - 2 && Q.puppets[0].left === 2 && !st.pending,
    `hp=${Q.hp} puppets=${JSON.stringify(Q.puppets)} pending=${!!st.pending}`);

  // 傀儡位只有一个：已有傀儡时不能再放
  Q.mana = 12;
  Q.hand = [{ uid: 9003, id: puppet.id }];
  check('傀儡位被占用时不能再放一个', !E.act(st, Q.id, { type: 'play', uid: 9003 }).ok);
}

console.log('\n[B] 火弹术：对战胜利时二选一');
check('法术牌 / 耗1 / 凡人+', huo && huo.cost === 1 && huo.realm === 0, huo && `${huo.cost}/${huo.realm}`);
check('有 2 个档位（二选一）', huo && huo.tiers && huo.tiers.length === 2, huo && String(huo.tiers && huo.tiers.length));
check('选项1 = 抽对方2张宝物牌', tierOp(huo, 0) === 'win_steal_treasure', String(tierOp(huo, 0)));
check('选项2 = 让对方额外受1点伤害', tierOp(huo, 1) === 'win_extra_damage', String(tierOp(huo, 1)));

{
  // 走一遍「对战获胜 → 在**获胜窗口**打出火弹术 → 抽对方 2 张宝物牌」
  // 注意：卡文是「对战胜利时，可选择…」，所以现在是**打完之后**才在结果窗口出牌，
  // 不再是投骰前提前押注（结果窗口是这轮新加的机制）。
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 5002 });
  E.beginGame(st);
  const A = st.players[0], B = st.players[1];
  st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  A.realm = 4; B.realm = 4; A.mana = 12; B.mana = 12;
  A.hand = [{ uid: 9101, id: huo.id }]; A.spells = []; A.equip = [];
  B.hand = []; B.spells = []; B.equip = []; B.hp = 6; B.qiCards = [];
  // 给乙 3 张宝物牌
  const tre = C.cards().treasure.slice(0, 3);
  tre.forEach((c, i) => B.hand.push({ uid: 9200 + i, id: c.id }));

  E.act(st, A.id, { type: 'combat', target: B.id });
  // FANREN_TIMING_ENFORCE=0 是回滚用的"宽松模式"（任何对战窗口都能打对战牌），
  // 那种模式下火弹术在投骰前就打掉了，下面这套"结果窗口"流程走不通，整段跳过。
  const enforce = process.env.FANREN_TIMING_ENFORCE !== '0';
  if (!enforce) {
    skip('（宽松模式：跳过结果窗口断言；默认模式见下方 FANREN_TIMING_ENFORCE=1）');
  } else {
    // 关键：投骰**前**打火弹术应被拒（卡文是「对战胜利时」）
    const early = E.act(st, A.id, { type: 'play', uid: 9101 });
    check('投骰前打【火弹术】被拒（卡文是"对战胜利时"）', !early.ok, JSON.stringify(early));
    E.act(st, A.id, { type: 'roll' });                   // 攻方掷骰
    E.act(st, B.id, { type: 'roll' });                   // 应战方掷骰 → 进入结果窗口

    const winLog = st.log.map((l) => l.text).join(' | ');
    if (/甲 战胜 乙/.test(winLog)) {
      check('战果判定后进入「获胜窗口」', st.combat && st.combat.stage === 'result' && st.combat.resultStep === 'win',
        st.combat && `${st.combat.stage}/${st.combat.resultStep}`);
      const bBefore = B.hand.length;
      const r = E.act(st, A.id, { type: 'play', uid: 9101, tier: 0 });
      check('在获胜窗口打出【火弹术】成功', r.ok, JSON.stringify(r));
      const rp = E.act(st, B.id, { type: 'result_pass' });   // 乙没有失败时卡牌 → 跳过
      check('乙跳过后对战正常结算', rp.ok && st.combat === null, JSON.stringify(rp));
      // 甲打出火弹术（手牌 -1）后，再从乙手里抽 2 张宝物牌
      check('获胜后从乙手中抽走了 2 张宝物牌', A.hand.length === 2 && B.hand.length === bBefore - 2,
        `A手牌=${A.hand.length}(打出1张后又抽2)，B ${bBefore}->${B.hand.length}`);
    } else {
      skip('（本局甲未获胜，跳过抽牌断言；对战结果已正常结算）');
      console.log('     结果日志: ' + (st.log.filter((l) => l.kind === 'combat_result')[0] || {}).text);
    }
  }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
