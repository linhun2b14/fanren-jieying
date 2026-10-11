'use strict';
// 《凡人修仙传：结婴之战》服务端。
// 零依赖：Node 内置 http + SSE（Server-Sent Events）做服务端推送。
// 房间制：房主创建房间拿到 4 位房间码，其他人凭码加入。

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./engine');
const C = require('./cards');

const PORT = Number(process.env.PORT || 8094);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');
const IDLE_MS = 6 * 60 * 60 * 1000;   // 房间闲置 6 小时回收
const PRE_TIMEOUT_MS = 60 * 1000;     // 对战准备阶段超时自动掷骰
const TIE_TIMEOUT_MS = 45 * 1000;     // 平局结算超时自动过牌
const RESULT_TIMEOUT_MS = 45 * 1000;  // 结果窗口（获胜时/失败时）超时自动跳过
const INTERRUPT_TIMEOUT_MS = 60 * 1000; // 打断窗口（时点询问）超时按"放弃响应"处理
// ⭐ 行动 / 抽取阶段挂机：以前**没有**这层兜底 —— 一个人不动，全桌永久卡死（交接 §5.2 的老欠账）。
//   90 秒没动作就把当前回合往前推一格（抽取阶段帮抽、行动阶段自动结束回合），并在战报里写明"超时自动"。
const ACTION_TIMEOUT_MS = Number(process.env.ACTION_TIMEOUT_MS || 90 * 1000);

const rooms = new Map();

/**
 * 「**线上跑的是哪一版**」—— 这是已知欠账（交接 §5.2）里那条：
 * 只看 `/healthz` 的 `ok`，分不出"端口上这个是**旧进程**"。
 * 2026-10-05 实测踩到：临时服 8095 上坐着上一会话遗留的进程，新起的那个没绑上端口就退了，
 * 于是全量回归打的是旧代码。现在 `/api/version` 给出 pid / 启动时间 / 引擎与卡池的哈希，
 * 以及 `stale`（进程启动时的哈希 vs **现在**磁盘上的哈希）—— 不一致就是"该重启了"。
 */
function fileStamp(f) {
  try {
    const buf = fs.readFileSync(f);
    return {
      hash: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12),
      mtime: new Date(fs.statSync(f).mtimeMs).toISOString(),
    };
  } catch (e) { return { hash: null, mtime: null }; }
}
const ENGINE_FILE = path.join(__dirname, 'engine.js');
const CARDS_FILE = path.join(__dirname, '..', 'data', 'cards.json');
const BOOT_STAMP = {
  started: new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString(),
  engine: fileStamp(ENGINE_FILE),
  cards: fileStamp(CARDS_FILE),
};
function versionInfo() {
  const engine = fileStamp(ENGINE_FILE);
  const cards = fileStamp(CARDS_FILE);
  return {
    service: 'fanren-jieying', pid: process.pid, port: PORT,
    started: BOOT_STAMP.started,
    engine: engine, cards: cards,
    stale: engine.hash !== BOOT_STAMP.engine.hash || cards.hash !== BOOT_STAMP.cards.hash,
  };
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
};

function newRoomId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let s = '';
    for (let i = 0; i < 4; i++) s += alphabet[crypto.randomInt(alphabet.length)];
    if (!rooms.has(s)) return s;
  }
}

function createRoom(playerName) {
  const id = newRoomId();
  const room = {
    id: id,
    createdAt: Date.now(), touched: Date.now(),
    host: null,
    seats: [],          // {id, name, token, connected, lastSeen}
    state: null,        // 引擎状态（lobby 阶段为 null）
    clients: new Map(), // playerId -> Set(res)
    timer: null,
  };
  rooms.set(id, room);
  return room;
}

function addPlayer(room, name) {
  if (room.state && room.state.phase !== 'lobby') {
    if (room.seats.length >= 4) return { error: '房间已满' };
    return { error: '本局游戏已经开始，无法加入' };
  }
  if (room.seats.length >= 4) return { error: '房间已满（最多 4 人）' };
  const seat = {
    id: 'p' + crypto.randomBytes(3).toString('hex'),
    name: String(name || '无名散修').slice(0, 12),
    token: crypto.randomBytes(16).toString('hex'),
    connected: false, lastSeen: Date.now(),
  };
  room.seats.push(seat);
  if (!room.host) room.host = seat.id;
  ensureLobbyState(room);
  return { seat: seat };
}

function ensureLobbyState(room) {
  const defs = room.seats.map((s) => ({ id: s.id, name: s.name, host: s.id === room.host }));
  const st = E.createGame(defs, { id: room.id });
  room.state = st;
}

function findSeat(room, playerId, token) {
  const s = room.seats.find((x) => x.id === playerId);
  if (!s) return null;
  if (token && s.token !== token) return null;
  return s;
}

function viewFor(room, playerId) {
  if (!room.state) return { phase: 'lobby', players: [], log: [] };
  const v = E.publicState(room.state, playerId);
  v.roomId = room.id;
  v.host = room.host;
  v.seats = room.seats.map((s) => ({ id: s.id, name: s.name, connected: s.connected }));
  v.cardDb = undefined;
  return v;
}

function broadcast(room) {
  for (const seat of room.seats) {
    const set = room.clients.get(seat.id);
    if (!set || set.size === 0) continue;
    const payload = 'data: ' + JSON.stringify(viewFor(room, seat.id)) + '\n\n';
    for (const res of set) {
      try { res.write(payload); } catch (e) { /* 连接已断，由 close 事件清理 */ }
    }
  }
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

/** 对战准备/平局阶段的看门狗：防止有人挂机把整局卡死。 */
function armWatchdog(room) {
  clearTimer(room);
  const st = room.state;
  if (!st) return;
  // 打断窗口（时点询问）优先：挂着的时候别的阶段计时都没意义
  if (st.pending) {
    room.timer = setTimeout(() => {
      const s = room.state;
      if (!s || !s.pending) return;
      E.pendingTimeout(s);            // 当前该表态的人按"放弃"处理
      broadcast(room);
      armWatchdog(room);
    }, INTERRUPT_TIMEOUT_MS);
    return;
  }
  if (!st.combat) {
    // ⭐ 行动 / 抽取阶段挂机兜底：到点自动把当前回合推一格（见 engine.autoIdleAction）。
    //   用 `room.lastActAt`（每次 /api/action 都刷新）判"真的没人动过"，避免把正在思考的玩家打断。
    const idle = E.autoIdleAction(st);
    if (idle) {
      const since = Date.now() - (room.lastActAt || room.touched || Date.now());
      room.timer = setTimeout(() => {
        const s = room.state;
        const now = s && E.autoIdleAction(s);
        if (!s || !now || now.pid !== idle.pid || now.action.type !== idle.action.type) return;   // 局面已经动了
        if (Date.now() - (room.lastActAt || 0) < ACTION_TIMEOUT_MS - 500) { armWatchdog(room); return; }
        E.act(s, now.pid, now.action);
        broadcast(room);
        armWatchdog(room);
      }, Math.max(1000, ACTION_TIMEOUT_MS - since));
    }
    return;
  }
  const stage = st.combat.stage;
  if (stage === 'pre' || stage === 'roll_defender') {
    // 两段式掷骰：准备阶段由发起方掷，投完轮到应战方掷
    room.timer = setTimeout(() => {
      const s = room.state;
      if (!s || !s.combat) return;
      if (s.combat.stage !== 'pre' && s.combat.stage !== 'roll_defender') return;
      const actor = s.combat.stage === 'pre' ? s.combat.attacker : s.combat.defender;
      E.act(s, actor, { type: 'roll' });
      broadcast(room);
      armWatchdog(room);
    }, PRE_TIMEOUT_MS);
  } else if (stage === 'tie') {
    room.timer = setTimeout(() => {
      const s = room.state;
      if (!s || !s.combat || s.combat.stage !== 'tie') return;
      const c = s.combat;
      for (const pid of [c.attacker, c.defender]) {
        if (!c.tieUsed[pid] && !c.tiePassed[pid]) E.act(s, pid, { type: 'tie' });
      }
      broadcast(room);
      armWatchdog(room);
    }, TIE_TIMEOUT_MS);
  } else if (stage === 'result') {
    // 结果窗口现在是"锁链"：它挂着 state.pending，由上面的打断分支兜底（60 秒超时自动跳过）。
    // 这里不再单独计时，避免和 pending 的超时打架。
  }
}

// ---------------------------------------------------------------- HTTP

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
  });
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const full = path.join(PUBLIC, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'GET,POST' });
    res.end(); return;
  }

  try {
    if (p === '/api/cards' && req.method === 'GET') {
      return sendJson(res, 200, C.cards());
    }

    // 效果元数据（中文标签 / 时机表 / op 属性）—— 唯一来源是 server/effect-meta.js。
    // 前端拿它生成标签，不再本地维护第二份词典，杜绝"引擎加了 op、前端忘了同步"。
    if (p === '/api/meta' && req.method === 'GET') {
      return sendJson(res, 200, C.meta());
    }

    if (p === '/api/create' && req.method === 'POST') {
      const b = await readBody(req);
      const room = createRoom();
      const r = addPlayer(room, b.name);
      if (r.error) return sendJson(res, 400, { error: r.error });
      broadcast(room);
      return sendJson(res, 200, { roomId: room.id, playerId: r.seat.id, token: r.seat.token, name: r.seat.name });
    }

    if (p === '/api/join' && req.method === 'POST') {
      const b = await readBody(req);
      const room = rooms.get(String(b.roomId || '').toUpperCase());
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      room.touched = Date.now();
      // 重连：带 playerId+token 直接恢复座位
      if (b.playerId && b.token) {
        const s = findSeat(room, b.playerId, b.token);
        if (s) { s.connected = true; s.lastSeen = Date.now(); broadcast(room); return sendJson(res, 200, { roomId: room.id, playerId: s.id, token: s.token, name: s.name }); }
        return sendJson(res, 403, { error: '身份校验失败' });
      }
      const r = addPlayer(room, b.name);
      if (r.error) return sendJson(res, 400, { error: r.error });
      broadcast(room);
      return sendJson(res, 200, { roomId: room.id, playerId: r.seat.id, token: r.seat.token, name: r.seat.name });
    }

    if (p === '/api/start' && req.method === 'POST') {
      const b = await readBody(req);
      const room = rooms.get(String(b.roomId || '').toUpperCase());
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const s = findSeat(room, b.playerId, b.token);
      if (!s) return sendJson(res, 403, { error: '身份校验失败' });
      if (room.host !== s.id) return sendJson(res, 403, { error: '只有房主可以开始游戏' });
      ensureLobbyState(room);
      const r = E.beginGame(room.state);
      if (!r.ok) return sendJson(res, 400, { error: r.error });
      room.lastActAt = Date.now();      // 开局也算一次"有人动了"（挂机兜底的计时基准）
      broadcast(room); armWatchdog(room);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/again' && req.method === 'POST') {
      const b = await readBody(req);
      const room = rooms.get(String(b.roomId || '').toUpperCase());
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const s = findSeat(room, b.playerId, b.token);
      if (!s) return sendJson(res, 403, { error: '身份校验失败' });
      if (room.host !== s.id) return sendJson(res, 403, { error: '只有房主可以重开' });
      clearTimer(room);
      ensureLobbyState(room);
      broadcast(room);
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/action' && req.method === 'POST') {
      const b = await readBody(req);
      const room = rooms.get(String(b.roomId || '').toUpperCase());
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const s = findSeat(room, b.playerId, b.token);
      if (!s) return sendJson(res, 403, { error: '身份校验失败' });
      room.touched = Date.now();
      room.lastActAt = Date.now();     // 「行动阶段挂机」兜底的计时基准（见 armWatchdog）
      if (!room.state) return sendJson(res, 400, { error: '游戏尚未开始' });
      const r = E.act(room.state, s.id, b.action || {});
      if (r.ok) { broadcast(room); armWatchdog(room); }
      return sendJson(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/state' && req.method === 'GET') {
      const room = rooms.get(String(url.searchParams.get('roomId') || '').toUpperCase());
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const s = findSeat(room, url.searchParams.get('playerId'), url.searchParams.get('token'));
      if (!s) return sendJson(res, 403, { error: '身份校验失败' });
      return sendJson(res, 200, viewFor(room, s.id));
    }

    // 弃牌堆内容（公开信息，所有玩家随时可查看）
    if (p === '/api/discard' && req.method === 'GET') {
      const room = rooms.get(String(url.searchParams.get('roomId') || '').toUpperCase());
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const s = findSeat(room, url.searchParams.get('playerId'), url.searchParams.get('token'));
      if (!s) return sendJson(res, 403, { error: '身份校验失败' });
      if (!room.state || !room.state.decks) return sendJson(res, 200, {});
      const out = {};
      for (const d of ['treasure', 'spell', 'companion', 'qi']) {
        const pile = room.state.decks[d] || { discard: [] };
        // 按「后弃的在前」返回，方便一眼看到最近发生了什么
        out[d] = pile.discard.slice().reverse();
      }
      return sendJson(res, 200, out);
    }

    if (p === '/api/stream' && req.method === 'GET') {
      const room = rooms.get(String(url.searchParams.get('roomId') || '').toUpperCase());
      if (!room) { res.writeHead(404); res.end('no room'); return; }
      const s = findSeat(room, url.searchParams.get('playerId'), url.searchParams.get('token'));
      if (!s) { res.writeHead(403); res.end('forbidden'); return; }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      s.connected = true; s.lastSeen = Date.now();
      if (!room.clients.has(s.id)) room.clients.set(s.id, new Set());
      room.clients.get(s.id).add(res);
      res.write('retry: 2000\n\n');
      res.write('data: ' + JSON.stringify(viewFor(room, s.id)) + '\n\n');
      const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
      const cleanup = () => {
        clearInterval(hb);
        const set = room.clients.get(s.id);
        if (set) { set.delete(res); if (set.size === 0) { s.connected = false; } }
        broadcast(room);
      };
      req.on('close', cleanup);
      req.on('error', cleanup);
      return;
    }

    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
    // 「线上跑的是哪一版」：pid / 启动时间 / engine.js 与 cards.json 的哈希 + stale（见文件上方注释）
    if (p === '/api/version') { sendJson(res, 200, versionInfo()); return; }

    return serveStatic(req, res, p);
  } catch (err) {
    console.error('[server] error', err);
    try { sendJson(res, 500, { error: 'server error: ' + err.message }); } catch (e) {}
  }
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    const active = Array.from(room.clients.values()).some((s) => s.size > 0);
    if (!active && now - room.touched > IDLE_MS) { clearTimer(room); rooms.delete(id); console.log(`[room] 回收闲置房间 ${id}`); }
  }
}, 10 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  const st = C.stats();
  console.log(`凡人修仙传·结婴之战 服务已启动`);
  console.log(`  监听 http://${HOST}:${PORT}`);
  console.log(`  本机 http://127.0.0.1:${PORT}`);
  console.log(`  卡池 宝物${st.treasure} 法术${st.spell} 同行者${st.companion} 灵气${st.qi} 共 ${st.total} 张`);
});
