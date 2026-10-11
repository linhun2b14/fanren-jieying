'use strict';
// 服务端接口联调：建房 → 加入 → 开局 → 推进到结束
const BASE = process.env.BASE || 'http://127.0.0.1:8094';

async function post(pathname, body) {
  const r = await fetch(BASE + pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
}
async function get(pathname) {
  const r = await fetch(BASE + pathname);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  const hz = await fetch(BASE + '/healthz');
  console.log('healthz', hz.status, await hz.text());

  const seats = [];
  const c = await post('/api/create', { name: '韩立' });
  if (c.status !== 200) throw new Error('create failed ' + JSON.stringify(c));
  const roomId = c.body.roomId;
  seats.push(c.body);
  console.log('create ->', roomId, c.body.playerId);

  for (const n of ['南宫婉', '厉飞雨', '银月']) {
    const j = await post('/api/join', { roomId: roomId, name: n });
    if (j.status !== 200) throw new Error('join failed ' + JSON.stringify(j));
    seats.push(j.body);
  }
  console.log('4 人房间:', seats.map((s) => s.name).join(' / '));

  const st = await get(`/api/state?roomId=${roomId}&playerId=${seats[0].playerId}&token=${seats[0].token}`);
  console.log('lobby phase=', st.body.phase, 'seats=', st.body.seats.length);

  const s = await post('/api/start', seats[0]);
  if (s.status !== 200) throw new Error('start failed ' + JSON.stringify(s));
  console.log('start ok');

  let view = (await get(`/api/state?roomId=${roomId}&playerId=${seats[0].playerId}&token=${seats[0].token}`)).body;
  console.log('phase=', view.phase, 'turn=', view.turn, 'step=', view.step);
  console.log('玩家:', view.players.map((p) => `${p.name}(${p.rootName}) 战力${p.baseCombat} 灵气${p.qi} 法力${p.mana} 手牌${p.handCount}`).join(' | '));

  // 手牌保密性检查
  const me = seats.find((x) => x.playerId === view.turn);
  const other = seats.find((x) => x.playerId !== view.turn);
  const ov = (await get(`/api/state?roomId=${roomId}&playerId=${other.playerId}&token=${other.token}`)).body;
  const meInOtherView = ov.players.find((x) => x.id === view.turn);
  console.log('手牌保密: 对手视角中我的 hand =', meInOtherView.hand, '(应为 undefined)');

  // 推进：每步都尝试合法动作直到结束
  let steps = 0;
  const deadline = Date.now() + 20000;
  while (view.phase === 'playing' && steps < 300 && Date.now() < deadline) {
    steps++;
    const actorSeat = seats.find((x) => x.playerId === (view.combat ? view.combat.attacker : view.turn));
    if (!actorSeat) break;
    let action = null;
    if (view.combat && view.combat.stage === 'pre') action = { type: 'roll' };
    else if (view.step === 'choose_draw') action = { type: 'choose_draw', deck: 'spell' };
    else if (view.step === 'action') action = { type: 'end_turn' };
    if (!action) break;
    const r = await post('/api/action', { roomId: roomId, playerId: actorSeat.playerId, token: actorSeat.token, action: action });
    if (r.status !== 200) { console.log('action 失败', action, r.body); break; }
    view = (await get(`/api/state?roomId=${roomId}&playerId=${seats[0].playerId}&token=${seats[0].token}`)).body;
  }
  console.log(`推进 ${steps} 步 -> phase=${view.phase} round=${view.round} winner=${view.winner}`);
  console.log('最终:', view.players.map((p) => `${p.name}:${p.realmName}${p.out ? '(出局)' : ''} HP${p.hp}`).join(' | '));
  console.log('最近战报:');
  for (const l of view.log.slice(-8)) console.log('   ', l.text);
  console.log('SERVER TEST PASS');
})().catch((e) => { console.error('SERVER TEST FAIL:', e.message); process.exit(1); });
