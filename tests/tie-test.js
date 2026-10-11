'use strict';
// 平局阶段出牌回归测试：构造 stage='tie' 的对战，验证 TIE_KINDS 卡牌可打出且能改变结果。
const E = require('../server/engine');
const META = require('../server/effect-meta');
const { opsOf } = require('./fixtures');

const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 7 });
const r = E.beginGame(st);
   // 测试直接造局，不走真实回合流程 —— 这里标记"两边的第一个回合都已经过去"（新规则：第一个回合不能发起对战）
      for (const q of st.players) q.turnsTaken = 2;
if (!r.ok) throw new Error(r.error);
// 跳过抽牌阶段，进入行动阶段
E.act(st, st.players[st.turn].id, { type: 'choose_draw', deck: 'spell' });

const A = st.players[0], B = st.players[1];
st.turn = 0;
st.step = 'action';
st.turnFlags = { combat: false, promote: false };

const c = E.act(st, A.id, { type: 'combat', target: B.id });
if (!c.ok) throw new Error('发起对战失败: ' + c.error);
/** 打断层上线后，开战/投骰都会开时点询问窗口 —— 这里全部放弃（本测试只关心平局出牌） */
function flushPending() { let g = 0; while (st.pending && g++ < 10) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } }
flushPending();

// 先找到那张"改变战力结果"的牌并放进甲手里 ——
// 必须在窗口打开**之前**放好，否则没人能响应就不会开窗（零响应直通）
let card = null;
for (const d of ['treasure', 'spell']) {
  const found = require('../server/cards').cards()[d]
    .find((x) => x.type !== 'equip' && (x.effects || []).some((e) => {
      const t = META.timingOfEffect(e);
      return t && t.event === 'combatResult' && t.phase === 'tie';
    }));
  if (found) { card = found; break; }
}
if (!card) throw new Error('卡池里没有平局时点（combatResult·tie）的牌，无法测试');
A.hand.push({ uid: 990001, id: card.id });
A.mana = 5;

// 双方都投一次，进结算
E.act(st, A.id, { type: 'roll' }); flushPending();
E.act(st, B.id, { type: 'roll' }); flushPending();
if (!st.combat || st.combat.stage !== 'tie') {
  console.log('未进入平局阶段（骰点/修正偶然不等），改为一局强制构造并手动开平局窗口。');
  st.combat = { attacker: A.id, defender: B.id, stage: 'pre', bonus: {}, debuff: {},
    dice: { [A.id]: 3, [B.id]: 3 }, diceBonus: {}, total: {},
    equipEnabled: {}, compPaid: {}, noPenalty: {}, flatPower: {}, blocked: {}, loseSave: {},
    loseRetaliate: {}, forceReroll: {}, skipDice: {}, winBonusDamage: {}, winStealTreasure: {},
    winMana: {}, winDrawQi: {}, selfLoseDamage: {}, dicePenalty: {},
    winnerId: null, loserId: null, equipBonus: null, tieUsed: {}, tiePassed: {}, cancelled: false };
  E.openTieWindow(st, st.combat, 2);
}

// 平局窗口现在是**锁链**：挂着 combatResult·tie 的时点询问，用 respond_play 出牌
if (!st.pending || st.pending.event !== 'combatResult' || st.pending.phase !== 'tie') {
  throw new Error('平局没有挂上时点询问：' + JSON.stringify(st.pending && [st.pending.event, st.pending.phase]));
}
if (E.pendingActor(st).id !== A.id) throw new Error('平局窗口该由甲先表态');
if (!E.pendingCards(st, A).some((c) => c.name === card.name)) throw new Error('候选里没有这张平局牌');
const refCombat = st.combat;          // 先抓住这一个对象（结算后 state.combat 会被清空）
const hpBefore = A.hp;
const res = E.act(st, A.id, { type: 'respond_play', uid: 990001 });
console.log('平局响应出牌结果:', JSON.stringify(res));
if (!res.ok) throw new Error('平局出牌仍然失败: ' + res.error);
console.log('使用的卡:', card.name, JSON.stringify(card.effects));
// 甲打的是【天星大阵】（平局时回 1 点血）——验证效果真的结算了
if (A.hp !== Math.min(6, hpBefore + 1)) throw new Error(`平局牌效果没结算：hp ${hpBefore} -> ${A.hp}`);
// 乙手里没有平局牌 → 没人再能响应 → 锁链自动结算；本局仍是平局 → 双方无损失收场
console.log('对战是否已结算:', st.combat === null ? '已结算' : '仍在进行');
if (st.combat) throw new Error('双方都没别的平局牌，应该直接结算完');
void refCombat;
console.log('PASS: 平局出牌链路正常');
