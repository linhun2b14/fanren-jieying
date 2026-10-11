'use strict';
// 走域名/端口的真实联机验证：建房 → 加入 → 开局 → SSE 推送 → 动作。
// 目标地址用 `BASE` 指定（默认本机 8094）；**连不上就跳过**（退出码 0），
// 这样"离线 / 刚 clone 还没起服务"时跑全量不会出现假红。
const BASE = process.env.BASE || 'http://127.0.0.1:8094';

async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  console.log('BASE =', BASE);
  let hz;
  try {
    hz = await fetch(BASE + '/healthz', { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    console.log('  跳过：' + BASE + ' 上没有在跑的服务（先 `node server/index.js`，或用 BASE=… 指向部署地址）');
    process.exit(0);
  }
  console.log('healthz', hz.status, (await hz.text()).trim());

  const a = await post('/api/create', { name: '韩立' });
  if (a.status !== 200) throw new Error('create 失败: ' + JSON.stringify(a));
  const b = await post('/api/join', { roomId: a.body.roomId, name: '南宫婉' });
  const c = await post('/api/join', { roomId: a.body.roomId, name: '厉飞雨' });
  console.log('房间', a.body.roomId, '三人就座');

  // SSE：接 3 帧
  const url = `${BASE}/api/stream?roomId=${a.body.roomId}&playerId=${a.body.playerId}&token=${a.body.token}`;
  const frames = [];
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 12000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'text/event-stream' } });
    console.log('SSE status', res.status, res.headers.get('content-type'));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (frames.length < 3) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of raw.split('\n')) {
          if (line.startsWith('data: ')) frames.push(JSON.parse(line.slice(6)));
        }
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') throw e;
  } finally { clearTimeout(t); ac.abort(); }
  console.log('SSE 收到帧数:', frames.length, '最后一帧 phase =', frames[frames.length - 1] && frames[frames.length - 1].phase);

  // 开局
  const s = await post('/api/start', a.body);
  if (s.status !== 200) throw new Error('start 失败: ' + JSON.stringify(s));

  // 取状态：轮到谁
  async function state(seat) {
    const r = await fetch(`${BASE}/api/state?roomId=${a.body.roomId}&playerId=${seat.playerId}&token=${seat.token}`);
    return r.json();
  }
  let v = await state(a.body);
  console.log('开局后 phase=%s step=%s turn=%s', v.phase, v.step, v.turn);
  console.log('玩家:', v.players.map((p) => `${p.name}(${p.rootName}) 灵气${p.qi} 法力${p.mana} 手牌${p.handCount}`).join(' | '));

  const seats = { [a.body.playerId]: a.body, [b.body.playerId]: b.body, [c.body.playerId]: c.body };
  // 走一轮：当前玩家选择抽牌 → 结束回合
  const cur = seats[v.turn];
  let r1 = await post('/api/action', { roomId: a.body.roomId, playerId: cur.playerId, token: cur.token, action: { type: 'choose_draw', deck: 'companion' } });
  console.log('choose_draw ->', r1.status, JSON.stringify(r1.body));
  let r2 = await post('/api/action', { roomId: a.body.roomId, playerId: cur.playerId, token: cur.token, action: { type: 'end_turn' } });
  console.log('end_turn ->', r2.status, JSON.stringify(r2.body));
  v = await state(a.body);
  console.log('下一手 turn=%s（应已换人）', v.turn);

  // 非法动作：非当前玩家结束回合
  const notCur = v.players.find((p) => p.id !== v.turn);
  const bad = await post('/api/action', { roomId: a.body.roomId, playerId: notCur.id, token: seats[notCur.id].token, action: { type: 'end_turn' } });
  console.log('非当前玩家 end_turn ->', bad.status, JSON.stringify(bad.body));

  // 身份校验：错 token
  const forged = await fetch(`${BASE}/api/state?roomId=${a.body.roomId}&playerId=${a.body.playerId}&token=deadbeef`);
  console.log('伪造 token ->', forged.status, '(应为 403)');

  console.log('\nDOMAIN E2E PASS');
})().catch((e) => { console.error('DOMAIN E2E FAIL:', e.message); process.exit(1); });
