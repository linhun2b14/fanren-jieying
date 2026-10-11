'use strict';
// 平衡数据实测：跑多局随机对局，统计胜因、回合数、平手率、晋升失败率、灵气牌续组次数。
//
// 用法：node tests\balance-stats.js [每档局数，默认 12]   → 2/3/4 人各跑 N 局
//
// ⚠️ 2026-10-01 修了两个让这个工具"输出垃圾数据"的问题：
//
//  ① **不认识打断询问层**（本次从临时脚本合并回来的修复）
//     窗口开着的时候，act() 会把除"表态"以外的动作全部拒掉。旧 harness 不知道 st.pending 这回事，
//     于是第一张伤害牌开出 hurt 窗口之后，所有随机动作都被拒 → 循环 `break` →
//     整局被当成"没人获胜"，输出"元婴 0% / 淘汰 100%"这种**看起来像结论的垃圾**。
//     修法：循环开头先把 pending 冲洗掉（pendingActor → respond_pass，失败就 pendingTimeout）。
//
//  ② **没有胜者 / 半途卡死的局被算进了"淘汰获胜"**
//     旧代码 `淘汰获胜占比 = 100% - 元婴获胜占比`，把"无胜者"也当成淘汰胜 —— 数字虚高且掩盖卡死。
//     修法：单独统计并打印 noWinner / abandoned。
//
//  另外把 harness 自己的随机源从 Math.random() 换成**自带种子 PRNG**：
//  固定种子的对局本来是可复现的，但 choose_draw 用 Math.random() 一掺，同一批种子每次跑
//  结果都不一样 —— 那样就没法判断"改动到底有没有影响平衡"（分不清是改动还是噪声）。
//  现在同样的参数跑两次结果**完全一致**。
//
// 结果不是"通过/失败"，所以它不进 run-all.js（那是验收闸门，不是平衡台）。
const E = require('../server/engine');

// ---- 自带的种子随机源（mulberry32）：只要种子一样，整轮统计就一样 ----
let rand = mulberry32(1);
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rnd(n) { return Math.floor(rand() * n); }

function runOne(playerCount, seed) {
  const defs = [];
  for (let i = 0; i < playerCount; i++) defs.push({ id: 'p' + i, name: '修士' + i, host: i === 0 });
  const st = E.createGame(defs, { seed: seed });
  E.beginGame(st);
  // 每局的 harness 随机序列由 seed 决定 —— 这样"同一批种子"才真的可复现
  rand = mulberry32((seed * 2654435761) >>> 0 || 1);
  let steps = 0, abandoned = false;
  while (st.phase === 'playing' && steps < 6000) {
    steps++;
    // ① 打断询问层：窗口开着时除"表态"什么都不能做，先把它冲掉
    if (st.pending) {
      const w = E.pendingActor(st);
      if (!w) { E.pendingTimeout(st); continue; }
      if (!E.act(st, w.id, { type: 'respond_pass' }).ok) E.pendingTimeout(st);
      continue;
    }
    // ①b 回合结束的「手牌超上限」：引擎挂起等玩家自己挑弃（用户裁定）。
    //     这个 harness 也得处理它，否则每局都会卡在 end_turn 上、被误报成"没有胜者"。
    if (st.forceDiscard) {
      const who = st.players.find((x) => x.id === st.forceDiscard.playerId);
      const card = who && who.hand[0];
      if (!card) { abandoned = true; why = '强制弃牌但手里没牌了'; break; }
      E.act(st, who.id, { type: 'discard', uid: card.uid });
      continue;
    }
    const cur = st.players[st.turn];
    if (cur.out) break;
    const acts = [];
    if (st.combat) {
      const c = st.combat;
      if (c.stage === 'pre' || c.stage === 'roll_defender') {
        if (c.stage === 'pre') {
          for (const pid of [c.attacker, c.defender]) {
            const pl = st.players.find((x) => x.id === pid);
            for (const card of pl.hand) acts.push({ pid: pid, a: { type: 'play', uid: card.uid } });
          }
        }
        acts.push({ pid: c.stage === 'pre' ? c.attacker : c.defender, a: { type: 'roll' } });
      } else if (c.stage === 'tie') {
        // 平局窗口现在也是锁链（挂 pending），上面的冲洗已经处理过；
        // 这里只兜"平局但没开窗"的残留情形。
        for (const pid of [c.attacker, c.defender]) {
          if (!c.tieUsed[pid] && !c.tiePassed[pid]) {
            const pl = st.players.find((x) => x.id === pid);
            for (const card of pl.hand) acts.push({ pid: pid, a: { type: 'tie', uid: card.uid } });
            acts.push({ pid: pid, a: { type: 'tie' } });
          }
        }
      }
    } else if (st.step === 'draw_qi') {
      acts.push({ pid: cur.id, a: { type: 'draw_qi' } });
    } else if (st.step === 'draw_treasure') {
      acts.push({ pid: cur.id, a: { type: 'draw_treasure' } });
    } else if (st.step === 'choose_draw') {
      acts.push({ pid: cur.id, a: { type: 'choose_draw', deck: rnd(2) === 0 ? 'spell' : 'companion' } });
    } else if (st.step === 'action') {
      for (const card of cur.hand) {
        const others = st.players.filter((x) => !x.out && x.id !== cur.id);
        acts.push({ pid: cur.id, a: { type: 'play', uid: card.uid, target: others.length ? others[rnd(others.length)].id : null } });
      }
      acts.push({ pid: cur.id, a: { type: 'promote' } });
      for (const t of st.players) if (!t.out && t.id !== cur.id) acts.push({ pid: cur.id, a: { type: 'combat', target: t.id } });
      acts.push({ pid: cur.id, a: { type: 'end_turn' } });
    } else break;
    let done = false;
    const order = acts.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = rnd(i + 1); [order[i], order[j]] = [order[j], order[i]]; }
    // 晋升优先：让"修炼到元婴"这条胜利路线能被真实走到
    const promoteFirst = order.filter((i) => acts[i].a.type === 'promote');
    const rest = order.filter((i) => acts[i].a.type !== 'promote');
    for (const oi of promoteFirst.concat(rest)) {
      if (E.act(st, acts[oi].pid, acts[oi].a).ok) { done = true; break; }
    }
    if (!done) {
      // 一个动作都做不成 = 这局卡住了，记下来（旧版会静默当成"淘汰获胜"）
      if (!E.act(st, cur.id, { type: 'end_turn' }).ok) { abandoned = true; break; }
    }
  }
  // 步数用尽仍在进行中，同样算"没跑完"
  if (st.phase === 'playing') abandoned = true;

  const logs = st.log;
  const count = (kind) => logs.filter((l) => l.kind === kind).length;
  const combats = count('combat_result');
  const ties = count('tie');
  const promFail = count('promote_fail');
  const promOk = count('promote');
  const refills = logs.filter((l) => l.kind === 'reshuffle' && l.text.indexOf('灵气牌') >= 0).length;
  const winner = st.winner ? st.players.find((p) => p.id === st.winner) : null;
  return {
    rounds: st.round,
    byYuanying: !!(winner && winner.realm >= 4),
    // ② 有胜者才算"淘汰获胜"；没胜者单独计数，不再混进去
    noWinner: !winner || abandoned,
    combats: combats, ties: ties,
    promOk: promOk, promFail: promFail,
    qiRefills: refills,
    steps: steps,
    abandoned: abandoned,
  };
}

const N = Number(process.argv[2] || 12);
const rows = [];
for (const pc of [2, 3, 4]) {
  for (let i = 0; i < N; i++) rows.push(Object.assign({ players: pc }, runOne(pc, 7000 + pc * 1000 + i)));
}
const sum = (f) => rows.reduce((a, r) => a + f(r), 0);
const avg = (f) => (sum(f) / rows.length).toFixed(2);
const pct = (n, d) => ((n / Math.max(1, d)) * 100).toFixed(1);

const decided = rows.filter((r) => !r.noWinner);
console.log(`样本 ${rows.length} 局（2/3/4 人各 ${N} 局；种子固定，同样参数跑两次结果一致）\n`);
console.log(`平均回合数        ${avg((r) => r.rounds)}`);
console.log(`平均步数          ${avg((r) => r.steps)}`);
console.log(`元婴获胜占比      ${pct(rows.filter((r) => r.byYuanying).length, rows.length)}%`);
console.log(`淘汰获胜占比      ${pct(rows.filter((r) => !r.byYuanying && !r.noWinner).length, rows.length)}%`);
console.log(`无胜者 / 未跑完   ${rows.filter((r) => r.noWinner).length} 局` +
  `（其中 harness 主动放弃 ${rows.filter((r) => r.abandoned).length} 局）`);
console.log(`   ↳ 若这一项不是 0，"元婴 + 淘汰"就凑不满 100%，说明还有卡死的局要查`);
console.log(`每局平均对战场次  ${avg((r) => r.combats)}`);
console.log(`对战平手率        ${pct(sum((r) => r.ties), sum((r) => r.combats + r.ties))}%`);
console.log(`晋升成功率        ${pct(sum((r) => r.promOk), sum((r) => r.promOk + r.promFail))}%  （成功 ${sum((r) => r.promOk)} / 失败 ${sum((r) => r.promFail)}）`);
console.log(`灵气牌续组次数    ${sum((r) => r.qiRefills)}（共 ${rows.length} 局）`);
console.log('\n各人数分项:');
for (const pc of [2, 3, 4]) {
  const sub = rows.filter((r) => r.players === pc);
  const s = (f) => sub.reduce((a, r) => a + f(r), 0);
  console.log(`  ${pc} 人局: 平均 ${(s((r) => r.rounds) / sub.length).toFixed(1)} 回合, ` +
    `元婴胜 ${pct(sub.filter((r) => r.byYuanying).length, sub.length)}%, ` +
    `淘汰胜 ${pct(sub.filter((r) => !r.byYuanying && !r.noWinner).length, sub.length)}%, ` +
    `平手率 ${pct(s((r) => r.ties), s((r) => r.combats + r.ties))}%`);
}
if (decided.length !== rows.length) {
  console.log(`\n（"元婴胜/淘汰胜"的占比是按全部 ${rows.length} 局算的，所以它们之和 = 100% − 无胜者占比）`);
}
