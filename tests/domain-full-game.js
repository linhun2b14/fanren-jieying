'use strict';
// 端到端：完全通过 HTTP 接口把一整局打完（含晋升、对战、平局、淘汰），确认部署后的服务能走到终局。
// 目标地址用 `BASE` 指定（默认本机 8094）；**连不上就跳过**（退出码 0），避免离线时假红。
const BASE = process.env.BASE || 'http://127.0.0.1:8094';

async function post(pathname, body) {
  const r = await fetch(BASE + pathname, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = {}; }
  return { status: r.status, body: j };
}
async function get(pathname) {
  const r = await fetch(BASE + pathname);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  console.log('BASE =', BASE);
  try {
    await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    console.log('  跳过：' + BASE + ' 上没有在跑的服务（先 `node server/index.js`，或用 BASE=… 指向部署地址）');
    process.exit(0);
  }
  const NAMES = ['韩立', '南宫婉', '厉飞雨', '银月'];
  const seats = [];
  const c = await post('/api/create', { name: NAMES[0] });
  if (c.status !== 200) throw new Error('create 失败: ' + JSON.stringify(c));
  seats.push(c.body);
  for (let i = 1; i < 4; i++) {
    const j = await post('/api/join', { roomId: c.body.roomId, name: NAMES[i] });
    if (j.status !== 200) throw new Error('join 失败: ' + JSON.stringify(j));
    seats.push(j.body);
  }
  console.log('房间', c.body.roomId, '四人就座');

  const st = await post('/api/start', seats[0]);
  if (st.status !== 200) throw new Error('start 失败: ' + JSON.stringify(st));

  const byId = {};
  seats.forEach((s) => { byId[s.playerId] = s; });
  const view = async () => (await get(`/api/state?roomId=${c.body.roomId}&playerId=${seats[0].playerId}&token=${seats[0].token}`)).body;

  let v = await view();
  console.log('开局: phase=%s step=%s turn=%s', v.phase, v.step, v.turn);
  console.log('  规则常量: 生命上限=%s 法力上限=%s(凡人%s) 掷骰门槛=%s',
    v.rules.hpMax, v.rules.manaMax, v.rules.manaMaxMortal, JSON.stringify(v.rules.promoteDice));
  console.log('  各家:', v.players.map((p) => `${p.name}(${p.rootName}) 生命${p.hp}/${p.hpMax} 法力${p.mana}/${p.manaCap} 灵气${p.qi} 同行者${p.companionUsedSlots}/${p.slots.companion}`).join(' | '));

  const want = (t, extra) => Object.assign({ type: t }, extra || {});
  const incidents = { promos: 0, promoFails: 0, combats: 0, ties: 0, elims: 0, manaLow: 0, refills: 0, congrats: 0, qiGain: 0 };
  let seenSeq = 0;
  let steps = 0;
  let lastSig = '', sameSig = 0;
  const MAX = 4000;

  while (v.phase === 'playing' && steps < MAX) {
    steps++;
    // 卡死检测：连续多步状态签名不变就报错退出，别空转到 MAX
    const sig = [v.round, v.turn, v.step, v.combat ? v.combat.stage : '-', v.log.length].join('|');
    if (sig === lastSig) {
      sameSig++;
      if (sameSig > 60) throw new Error(`疑似卡死：连续 60 步状态未变（${sig}）`);
    } else { sameSig = 0; lastSig = sig; }
    // 收集新战报做统计
    for (const l of v.log) {
      if (l.seq <= seenSeq) continue;
      seenSeq = l.seq;
      if (l.kind === 'promote') incidents.promos++;
      if (l.kind === 'promote_fail') incidents.promoFails++;
      if (l.kind === 'combat_result') incidents.combats++;
      if (l.kind === 'tie') incidents.ties++;
      if (l.kind === 'eliminate') incidents.elims++;
      if (l.kind === 'congrats') incidents.congrats++;
      if (l.kind === 'qi_gain') incidents.qiGain++;
      if (l.kind === 'reshuffle' && l.text.indexOf('灵气牌') >= 0) incidents.refills++;
      if (l.text && l.text.indexOf('法力值不足') >= 0) incidents.manaLow++;
    }

    let actorId = null, action = null;
    if (v.combat) {
      const cb = v.combat;
      if (cb.stage === 'pre') {
        actorId = cb.attacker;
        action = want('roll');
      } else if (cb.stage === 'roll_defender') {
        actorId = cb.defender;
        action = want('roll');
      } else {
        // 平局阶段：必须由「还没处理过」的那一方过牌，双方各过一次才算完
        const pending = [cb.attacker, cb.defender].find((id) => !cb.tieUsed[id] && !cb.tiePassed[id]);
        if (!pending) throw new Error('平局阶段双方都已处理但仍未结算');
        actorId = pending;
        action = want('tie');
      }
    } else if (v.step === 'draw_qi') {
      actorId = v.turn;
      action = want('draw_qi');
    } else if (v.step === 'draw_treasure') {
      actorId = v.turn;
      action = want('draw_treasure');
    } else if (v.step === 'choose_draw') {
      actorId = v.turn;
      action = want('choose_draw', { deck: 'companion' });
    } else if (v.step === 'action') {
      actorId = v.turn;
      const me = v.players.find((p) => p.id === actorId);
      if (!v.turnFlags.promote && me.realm < 4 && me.qi >= me.nextThreshold) {
        action = want('promote');
      } else if (!v.turnFlags.combat) {
        const t = v.players.find((p) => !p.out && !p.inSeclusion && p.id !== actorId && me.realm - p.realm < 2);
        if (t) action = want('combat', { target: t.id });
      }
      if (!action) action = want('end_turn');
    } else {
      throw new Error('未知 step: ' + v.step);
    }

    const seat = byId[actorId];
    if (!seat) throw new Error('找不到行动方座位: ' + actorId);
    const r = await post('/api/action', {
      roomId: c.body.roomId, playerId: seat.playerId, token: seat.token, action: action,
    });
    if (r.status !== 200) {
      // 动作被拒（例如法力不足、目标非法）→ 退回结束回合，避免死循环
      if (action.type === 'end_turn') throw new Error('end_turn 被拒: ' + JSON.stringify(r.body));
      const seat2 = byId[v.turn];
      await post('/api/action', { roomId: c.body.roomId, playerId: seat2.playerId, token: seat2.token, action: want('end_turn') });
    }
    v = await view();
    if (steps % 60 === 0) process.stdout.write('.');
  }
  console.log('');

  console.log(`\n推进 ${steps} 步 -> phase=${v.phase} 第 ${v.round} 轮`);
  const w = v.players.find((p) => p.id === v.winner);
  console.log(`胜者: ${w ? w.name + '（' + w.realmName + '）' : '（无）'}`);
  console.log('最终各家:');
  v.players.forEach((p) => console.log(`  ${p.name.padEnd(4)} ${p.realmName.padEnd(4)} 生命 ${p.hp}/${p.hpMax} 灵气 ${p.qi} ${p.out ? '【出局】' : ''}`));
  console.log('本局事件统计:', JSON.stringify(incidents));

  if (v.phase !== 'over') throw new Error('对局未终局，可能卡住');
  if (!w) throw new Error('终局但无胜者');
  if (incidents.combats === 0) throw new Error('整局没发生对战，测试无效');

  console.log('\nDOMAIN FULL GAME PASS');
})().catch((e) => { console.error('\nDOMAIN FULL GAME FAIL:', e.message); process.exit(1); });
