'use strict';
/**
 * 部署自检：**"端口上那个进程，跑的是不是最新代码"** —— 一条命令问清楚。
 *
 * 为什么需要它：`Start-Process node …` 撞端口的失败是**静默**的，端口上继续坐着上一个会话遗留的旧进程，
 * 你以为新代码起来了，结果回归/实盘打的是旧代码（2026-10-05 实测白跑了一趟全量）。
 * 判据两重（互为印证）：
 *   ① 服务自己报的 `stale`（进程启动时读的源码哈希 vs 现在磁盘上的哈希）；
 *   ② `started`（进程启动时间） vs 源码文件 mtime（进程比代码旧 = 该重启了）。
 *
 * 用法：
 *   node tools\deploy-check.js              # 检查 8094 游戏 / 8098 编辑器（没起的跳过）
 *   node tools\deploy-check.js 8095 8097    # 也可以点名检查临时服
 *   BASE=http://127.0.0.1:8094 node …       # 只查一个（老习惯，兼容）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// ⚠️ 每个服务**只看它自己的源码**，而且只看"**必须重启才生效**"的那些：
//    · 游戏服 8094/8095：`server\*.js` + `data\cards.json` 是**启动时读进内存**的（改了必须重启）；
//      `public\*`（app.js / style.css / index.html）是**每次请求现读磁盘**的 —— 改完刷新页面就行，
//      不该把进程判成"旧"（2026-10-05 实测踩到这个假报警）。
//    · 编辑器 8097/8098：`server\effect-meta` 是 require 进内存的、`tools\editor\server.js` 改了要重启；
//      它自己的 app.js/index.html/style.css 同样是静态文件（刷新即可，不参与进程新旧判定）。
const WATCH = {
  game: ['server/engine.js', 'server/cards.js', 'server/effect-meta.js', 'server/index.js', 'data/cards.json'],
  editor: ['server/effect-meta.js', 'server/engine.js', 'server/cards.js', 'data/cards.json',
    'tools/editor/server.js', 'tools/editor/sim.js', 'tools/editor/op-params.js'],
};
const EDITOR_PORTS = [8097, 8098];

function mtime(rel) {
  try { return fs.statSync(path.join(ROOT, rel)).mtime; } catch (e) { return null; }
}
function newest(files) {
  let best = null, who = '';
  for (const f of files) {
    const m = mtime(f);
    if (m && (!best || m > best)) { best = m; who = f; }
  }
  return { at: best, file: who };
}
/** 这个端口该拿哪份源码清单比（认不出就当游戏服，并把两边都算进来） */
function watchFor(port) {
  if (EDITOR_PORTS.indexOf(port) >= 0) return WATCH.editor;
  if (port === 8094 || port === 8095) return WATCH.game;
  return WATCH.game.concat(WATCH.editor);
}
async function getJson(url, ms) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 3000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return { http: r.status };
    return await r.json();
  } catch (e) {
    return { err: e.message };
  } finally { clearTimeout(t); }
}

const PORTS = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
const list = PORTS.length ? PORTS.map(Number)
  : (process.env.BASE ? [Number(new URL(process.env.BASE).port || 80)] : [8094, 8098]);

(async () => {
  console.log('=== 部署自检（DEPLOY CHECK）===');
  let bad = 0, live = 0;
  for (const port of list) {
    const tag = '[' + port + ']';
    const src = newest(watchFor(port));      // 每个服务比自己的源码（见 watchFor 的注释）
    let info = await getJson('http://127.0.0.1:' + port + '/api/version');
    if (!info || info.err || info.http) {
      // 编辑器没有 /api/version，回落 /api/healthz
      const h = await getJson('http://127.0.0.1:' + port + '/api/healthz');
      if (h && h.ok) info = h;
    }
    if (!info || info.err) { console.log(`${tag} 没在跑（${(info && info.err) || '连不上'}）`); continue; }
    live++;
    const started = info.started ? new Date(info.started) : null;
    const stale = info.stale === true;
    const older = !!(started && src.at && started < src.at);
    const ok = !stale && !older;
    if (!ok) bad++;
    console.log(`${tag} ${ok ? '✅ 最新' : '❌ 旧进程，该重启'} | pid=${info.pid}`
      + ` | started=${started ? started.toLocaleString() : '?'}`
      + (info.engine && info.engine.hash ? ` | engine=${info.engine.hash}` : '')
      + (info.cards && info.cards.hash ? ` | cards=${info.cards.hash}` : '')
      + (info.service ? ` | ${info.service}` : '')
      + ` | 比对基准 ${src.at ? src.at.toLocaleString() + '（' + src.file + '）' : '?'}`
      + (stale ? ' | stale=TRUE（源码动过、进程没重启）' : '')
      + (older ? ' | 启动时间早于最新源码 mtime' : ''));
  }
  console.log(live ? `\n共 ${live} 个服务在跑${bad ? `，**${bad} 个是旧进程** → 先 Stop-Process 再起` : '，全部是最新代码'}` : '\n（一个都没有在跑）');
  // ⚠️ 别在这里 `process.exit()`：Windows 上还有 fetch/AbortController 的句柄没关完，
  //    直接退会触发 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 崩掉。设 exitCode 让它自然退出。
  process.exitCode = bad ? 1 : 0;
})();
