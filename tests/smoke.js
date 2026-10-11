'use strict';
// 冒烟测试：跑完整局随机对局，验证引擎不会崩、状态不变量成立。
const E = require('../server/engine');
const C = require('../server/cards');

let seed = Number(process.argv[2] || 12345);

function rnd(state, n) { return Math.floor(Math.random() * n); }

function runGame(playerCount, gameSeed) {
  const defs = [];
  for (let i = 0; i < playerCount; i++) defs.push({ id: 'p' + i, name: '修士' + i, host: i === 0 });
  const st = E.createGame(defs, { seed: gameSeed });
  const r = E.beginGame(st);
  if (!r.ok) throw new Error('beginGame failed: ' + r.error);
  let steps = 0;
  while (st.phase === 'playing' && steps < 4000) {
    steps++;
    const cur = st.players[st.turn];
    const acts = [];
    // 打断窗口开着时：只有该表态的人能动作，且只能"响应/放弃"。
    // 随机驱动这里选择放弃（要测响应牌的话见 tests/interrupt-test.js）。
    if (st.pending) {
      const who = E.pendingActor(st);
      if (who) acts.push({ pid: who.id, a: { type: 'respond_pass' } });
    }
    // 回合结束的「手牌超上限」：引擎挂起等玩家自己挑弃哪几张（用户裁定），
    // **随机驱动也必须知道这个状态**，否则一轮到 end_turn 就死锁
    //（跟 st.pending 一样：驱动引擎的测试台都得处理它，见 tests/balance-stats.js）。
    if (st.forceDiscard) {
      const who = st.players.find((x) => x.id === st.forceDiscard.playerId);
      const card = who && who.hand[0];
      if (card) acts.push({ pid: who.id, a: { type: 'discard', uid: card.uid } });
    }
    if (st.combat) {
      const c = st.combat;
      if (c.stage === 'pre' || c.stage === 'roll_defender') {
        if (c.stage === 'pre') {
          // 准备阶段：双方可打出对战类卡牌
          for (const pl of [st.players.find((x) => x.id === c.attacker), st.players.find((x) => x.id === c.defender)]) {
            for (const card of pl.hand) acts.push({ pid: pl.id, a: { type: 'play', uid: card.uid } });
          }
        }
        // 两段式掷骰：攻方先投，应战方后投
        acts.push({ pid: c.stage === 'pre' ? c.attacker : c.defender, a: { type: 'roll' } });
      } else if (c.stage === 'tie') {
        for (const pl of [st.players.find((x) => x.id === c.attacker), st.players.find((x) => x.id === c.defender)]) {
          if (!c.tieUsed[pl.id] && !c.tiePassed[pl.id]) {
            for (const card of pl.hand) acts.push({ pid: pl.id, a: { type: 'tie', uid: card.uid } });
            acts.push({ pid: pl.id, a: { type: 'tie' } });
          }
        }
      } else if (c.stage === 'result') {
        // 结果窗口：战果已定，赢家用「获胜窗口」、输家用「失败窗口」，各限一张
        const actorId = c.resultStep === 'win' ? c.winnerId : c.loserId;
        const actor = st.players.find((x) => x.id === actorId);
        if (actor) {
          for (const card of actor.hand) acts.push({ pid: actor.id, a: { type: 'play', uid: card.uid, tier: 0 } });
          acts.push({ pid: actor.id, a: { type: 'result_pass' } });
        }
      }
    } else if (st.step === 'draw_qi') {
      acts.push({ pid: cur.id, a: { type: 'draw_qi' } });
      if (Math.random() < 0.25) acts.push({ pid: cur.id, a: { type: 'seclusion' } });
    } else if (st.step === 'draw_treasure') {
      acts.push({ pid: cur.id, a: { type: 'draw_treasure' } });
      if (Math.random() < 0.25) acts.push({ pid: cur.id, a: { type: 'seclusion' } });
    } else if (st.step === 'choose_draw') {
      acts.push({ pid: cur.id, a: { type: 'choose_draw', deck: Math.random() < 0.5 ? 'spell' : 'companion' } });
      if (Math.random() < 0.25) acts.push({ pid: cur.id, a: { type: 'seclusion' } });
    } else if (st.step === 'action' && !st.pending) {
      for (const card of cur.hand) acts.push({ pid: cur.id, a: { type: 'play', uid: card.uid, target: pickTarget(st, cur) } });
      acts.push({ pid: cur.id, a: { type: 'promote' } });
      for (const t of st.players) if (!t.out && t.id !== cur.id) acts.push({ pid: cur.id, a: { type: 'combat', target: t.id } });
      acts.push({ pid: cur.id, a: { type: 'end_turn' } });
    } else if (!st.pending) {
      throw new Error('unknown step ' + st.step);
    }
    let done = false;
    const reasons = [];
    const order = acts.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = rnd(st, i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    for (const oi of order) {
      const res = E.act(st, acts[oi].pid, acts[oi].a);
      if (res.ok) { done = true; break; }
      reasons.push(acts[oi].a.type + ': ' + res.error);
    }
    if (!done) {
      // 全部非法：强制结束回合避免死循环
      const forced = E.act(st, cur.id, { type: 'end_turn' });
      if (!forced.ok) {
        throw new Error('deadlock at step ' + steps + ' step=' + st.step
          + ' combat=' + JSON.stringify(st.combat && st.combat.stage)
          + ' 全部非法原因=' + JSON.stringify([...new Set(reasons)].slice(0, 4))
          + ' end_turn=' + forced.error);
      }
    }
    // 不变量
    for (const pl of st.players) {
      if (pl.hp < 0) throw new Error(pl.name + ' hp<0');
      if (pl.hp > E.HP_MAX) throw new Error(pl.name + ' hp>max');
      if (pl.mana < 0 || pl.mana > E.MANA_MAX) throw new Error(pl.name + ' mana out of range ' + pl.mana);
      if (E.qiOf(pl) < 0) throw new Error(pl.name + ' qi<0');
      if (pl.realm < 0 || pl.realm > 4) throw new Error(pl.name + ' realm out of range');
      if (pl.hand.length > 40) throw new Error(pl.name + ' hand ballooned');
    }
  }
  return { steps: steps, phase: st.phase, winner: st.winner, round: st.round,
    realms: st.players.map((x) => `${x.name}:${E.REALMS[x.realm]}${x.out ? '(出局)' : ''}`).join(' ') };
}

function pickTarget(st, cur) {
  const others = st.players.filter((x) => !x.out && x.id !== cur.id);
  return others.length ? others[Math.floor(Math.random() * others.length)].id : null;
}

console.log('卡池统计:', JSON.stringify(C.stats()));
let fail = 0;
for (const n of [2, 3, 4]) {
  for (let g = 0; g < 4; g++) {
    try {
      const r = runGame(n, 1000 + n * 100 + g);
      console.log(`✓ ${n}人局 seed=${1000 + n * 100 + g} 步数=${r.steps} 回合=${r.round} 结束=${r.phase} 胜者=${r.winner || '无'} | ${r.realms}`);
    } catch (e) {
      fail++;
      console.log(`✗ ${n}人局 seed=${1000 + n * 100 + g} 失败: ${e.message}\n${(e.stack || '').split('\n').slice(0, 6).join('\n')}`);
    }
  }
}
console.log(fail === 0 ? 'ALL PASS' : `${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
