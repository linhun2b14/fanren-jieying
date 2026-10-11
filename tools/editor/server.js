'use strict';
/**
 * 《凡人修仙传：结婴之战》卡牌编辑器 —— 独立小服务（零依赖，只用 node 内置模块）。
 *
 *   node tools\editor\server.js                 # 编辑 data\cards.json，绑定 0.0.0.0:8098
 *   node tools\editor\server.js --cards <路径>   # 编辑指定文件（安全自测用）
 *   CARDS_FILE=<路径> node tools\editor\server.js
 *   node tools\editor\server.js --port 8099 --host 127.0.0.1
 *
 * 它做什么：
 *   · GET  /api/cards     → 磁盘上的卡池原始 JSON（不做任何归一化，编辑的是真数据）
 *   · GET  /api/meta      → server/effect-meta.js 的元数据 + 界面侧参数提示（op 清单唯一来源）
 *   · POST /api/validate  → 只跑校验（不写盘）
 *   · POST /api/save      → 三步校验 → 通过才备份 + 写盘
 *   · POST /api/regression→ 后台跑 node tests\run-all.js --no-ui（异步任务，可轮询）
 *
 * 它**绝不**做什么：
 *   · 不碰游戏服务（不重启、不写它的端口、不碰计划任务）
 *   · 不改 server/ public/ tests/ docs/ 下的任何文件；只读 data/<目标文件>
 *   · 校验时**不写**真实的 data/cards.json —— 见下方"校验镜像"说明
 *
 * ---------------------------------------------------------------- 校验镜像
 * tools/lint-cards.js 与 tools/verify-dsl.js 都把 `data/cards.json` 写死在源码里
 * （`path.join(__dirname, '..', 'data', 'cards.json')`），没法传路径。要让它们在
 * "还没写盘的候选数据"上跑，本服务把仓库**复制成一份临时镜像**（server/ public/ tools/
 * docs\规则文档.md），只把候选卡池写进镜像的 data/cards.json，然后在镜像里跑这两个
 * **原封不动的**校验器。于是：
 *   · 校验器输出是原样输出（退出码、stdout 都真）
 *   · 真实仓库在保存之前一个字节都没动，校验失败更是完全无副作用
 * 镜像建在系统临时目录，进程退出时删除。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HERE = __dirname;
const META = require(path.join(ROOT, 'server', 'effect-meta'));
const OPPARAMS = require('./op-params');
const SIM = require('./sim');

// ---------------------------------------------------------------- 配置
const DECKS = ['treasure', 'spell', 'companion', 'qi'];
const DECK_CN = { treasure: '宝物牌', spell: '法术牌', companion: '同行者', qi: '灵气牌' };
/**
 * 官方基线张数 —— **只是参考，不再是闸门**（用户 2026-10-02 深夜："卡组总数不固定，按改的算"）。
 * 第 3 步已改成"牌堆自洽"：每堆张数 = 各卡 count 之和（必须是正整数），实得多少就报多少；
 * 与基线的差值只作为提示显示（加新卡 / 改数量时自然会偏移）。
 */
const BASE_COUNT = { treasure: 80, spell: 33, companion: 78, qi: 60 };
const BASE_TOTAL = DECKS.reduce((s, d) => s + BASE_COUNT[d], 0);
/** 最多保留几份编辑器备份 */
const KEEP_BACKUPS = 10;

// ---------------------------------------------------------------- 「这个进程是不是比代码旧」
// 本服务依赖的源码：改完任意一个，**必须重启**（effect-meta 是 require 进内存的，
// 它的"校验镜像"也是进程启动时建的一次快照）。`/api/healthz` 的 stale 就是拿它判的。
const CODE_FILES = ['server/effect-meta.js', 'server/engine.js', 'server/cards.js',
  'tools/editor/server.js', 'tools/editor/app.js', 'tools/editor/sim.js'];
function codeMtimeNow() {
  let mx = 0;
  for (const f of CODE_FILES) {
    try { mx = Math.max(mx, fs.statSync(path.join(ROOT, f)).mtimeMs); } catch (e) { /* 忽略 */ }
  }
  return mx;
}
const BOOT_STARTED = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
const BOOT_CODE_MTIME = codeMtimeNow();
/** 单次请求体上限（卡池 JSON 才 40KB，给足余量） */
const MAX_BODY = 8 * 1024 * 1024;
/** 校验器 / 回归 的超时（毫秒） */
const VALIDATE_TIMEOUT = 180000;
const REGRESSION_TIMEOUT = 900000;

function parseArgs(argv) {
  const out = { cards: null, port: null, host: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cards' || a === '-c') out.cards = argv[++i];
    else if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a === '--host' || a === '-h') out.host = argv[++i];
    else if (a === '--help') out.help = true;
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.help) {
  console.log([
    '卡牌编辑器 · 用法：',
    '  node tools\\editor\\server.js [--cards <路径>] [--port 8098] [--host 0.0.0.0]',
    '环境变量：CARDS_FILE / EDITOR_PORT / EDITOR_HOST / EDITOR_REGRESSION_CMD',
    '默认编辑 data\\cards.json；--cards 用于在临时副本上安全自测。',
  ].join('\n'));
  process.exit(0);
}

const CARDS_FILE = path.resolve(ROOT, ARGS.cards || process.env.CARDS_FILE || path.join('data', 'cards.json'));
const PORT = Number(ARGS.port || process.env.EDITOR_PORT || 8098);
const HOST = ARGS.host || process.env.EDITOR_HOST || '0.0.0.0';

// ---------------------------------------------------------------- 小工具
const nowStamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function sendJson(res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}
function sendText(res, code, text, type) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, {
    'content-type': (type || 'text/plain') + '; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大（超过 ' + Math.round(MAX_BODY / 1048576) + ' MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- 卡池读写
/** 读卡池：保留原文件的 BOM / 换行 / 末尾换行风格，写回时照原样还回去（改动最小） */
function readPool(file) {
  if (!fs.existsSync(file)) return { exists: false, text: null, json: null, style: null };
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  const bom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const bare = bom ? text.slice(1) : text;
  let json = null, parseError = null;
  try { json = JSON.parse(bare); } catch (e) { parseError = e.message; }
  return {
    exists: true, text, json, parseError,
    style: {
      bom,
      crlf: /\r\n/.test(text),
      trailingNewline: /\n$/.test(text),
      indent: 2,
    },
    bytes: buf.length,
    mtime: fs.statSync(file).mtime.toISOString(),
  };
}

function serializePool(obj, style) {
  const s = style || { bom: false, crlf: false, trailingNewline: true, indent: 2 };
  let text = JSON.stringify(obj, null, s.indent == null ? 2 : s.indent);
  if (s.crlf) text = text.split('\n').join('\r\n');
  if (s.trailingNewline !== false) text += s.crlf ? '\r\n' : '\n';
  if (s.bom) text = '\uFEFF' + text;
  return text;
}

/** 备份：<目标>.bak-editor-<时间戳>，只留最新 KEEP_BACKUPS 份 */
function backup(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const prefix = base + '.bak-editor-';
  let stamp = nowStamp();
  let dest = path.join(dir, prefix + stamp);
  let n = 2;
  while (fs.existsSync(dest)) { dest = path.join(dir, prefix + stamp + '-' + n); n++; }
  fs.copyFileSync(target, dest);
  const all = fs.readdirSync(dir).filter((f) => f.startsWith(prefix)).sort();
  const pruned = [];
  while (all.length > KEEP_BACKUPS) {
    const old = all.shift();
    try { fs.rmSync(path.join(dir, old), { force: true }); pruned.push(old); } catch (e) { /* 忽略 */ }
  }
  return { file: path.basename(dest), path: dest, kept: all.length, pruned };
}

function listBackups(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith(base + '.bak-editor-'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, bytes: st.size, mtime: st.mtime.toISOString() };
    })
    .sort((a, b) => (a.name < b.name ? 1 : -1));
}

// ---------------------------------------------------------------- 校验镜像
// ⚠️ 目录名里除了 pid 还要带**启动时间戳**：Windows 会复用 pid，一旦复用，
//    `ensureMirror()` 会认下**上一个进程留下的旧镜像**（`.ready` 在就复用），
//    于是校验器拿旧 effect-meta/engine 去校验新卡池 —— 2026-10-05 实测踩到：
//    旧镜像里没有 damage_cancel / damage_multiply，编辑器一直报"op 不在元数据表里"。
const MIRROR = path.join(os.tmpdir(), 'fanren-card-editor-mirror-' + process.pid + '-' + Date.now());

/**
 * 清掉"上一个实例被强杀"留下的镜像目录（进程退出钩子在某些杀法下不会执行）。
 * 只删进程已经不在的（用 pid 探活），所以同时跑多个实例互不影响。
 */
function sweepStaleMirrors() {
  const prefix = 'fanren-card-editor-mirror-';
  let removed = 0;
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir()); } catch (e) { return 0; }
  for (const name of entries) {
    if (name.indexOf(prefix) !== 0) continue;
    // 名字形如 <prefix><pid>-<启动时间戳>（旧格式只有 <pid>，照样认得出来）
    const pid = Number(name.slice(prefix.length).split('-')[0]);
    if (!Number.isFinite(pid) || pid <= 0) continue;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
    if (alive) continue;
    try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); removed++; } catch (e) { /* 忽略 */ }
  }
  return removed;
}

function copyDirInto(from, to, filter) {
  if (!fs.existsSync(from)) return 0;
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => (typeof filter === 'function' ? filter(src) : true),
  });
  return 1;
}

/**
 * 镜像里**不复制**的东西：体积大或与校验无关的目录，以及历史备份 / 自测副本。
 * 其余整棵仓库都复制 —— 校验器读什么（cards.json / engine.js / app.js / 两份 docs…）
 * 就有什么，将来校验器多读一个文件也不会突然在镜像里报"文件不存在"。
 */
function skipInMirror(src) {
  const s = src.split(path.sep).join('/');
  if (/\/(node_modules|\.git|logs|ref)\//.test(s)) return false;
  if (/\/tools\/(ff|editor)(\/|$)/.test(s)) return false;
  if (/\/data\/[^/]*\.bak-/.test(s)) return false;
  if (/\/data\/_editor-selftest/.test(s)) return false;
  return true;
}

/** 建镜像（建一次，之后只刷新 data/cards.json） */
function ensureMirror() {
  const ready = path.join(MIRROR, '.ready');
  if (fs.existsSync(ready)) return MIRROR;
  try { fs.rmSync(MIRROR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  fs.mkdirSync(MIRROR, { recursive: true });
  copyDirInto(ROOT, MIRROR, skipInMirror);
  fs.mkdirSync(path.join(MIRROR, 'data'), { recursive: true });
  fs.writeFileSync(ready, '1', 'utf8');
  return MIRROR;
}

function runScript(scriptRel, label, args) {
  const mirror = ensureMirror();
  const target = path.join(mirror, scriptRel);
  if (!fs.existsSync(target)) {
    return { key: label, name: label, cmd: 'node ' + scriptRel, code: -1, ok: false, output: `镜像里找不到 ${scriptRel}（仓库结构变了？）` };
  }
  const argList = (args || []).map(String);
  const cmd = 'node ' + scriptRel.split(path.sep).join('/') + (argList.length ? ' ' + argList.join(' ') : '')
    + '　（临时镜像里跑，data/cards.json = 候选数据）';
  const r = cp.spawnSync(process.execPath, [target].concat(argList), {
    cwd: mirror, encoding: 'utf8', timeout: VALIDATE_TIMEOUT, windowsHide: true,
  });
  const out = ((r.stdout || '') + (r.stderr || '')).replace(/\r\n/g, '\n').trim();
  const code = r.status == null ? -1 : r.status;
  return {
    key: label, name: label, cmd,
    code, ok: code === 0,
    timedOut: r.error && r.error.code === 'ETIMEDOUT',
    output: out || '(无输出)',
  };
}

/** 把"界面上这份卡池"写进镜像 —— 校验器与平衡试跑都读镜像里的 data/cards.json */
function writeMirrorPool(pool) {
  const mirror = ensureMirror();
  fs.writeFileSync(path.join(mirror, 'data', 'cards.json'), JSON.stringify(pool, null, 2) + '\n', 'utf8');
  return mirror;
}

// ---------------------------------------------------------------- 校验三步走
// ---------------------------------------------------------------- 时点接线表
/**
 * 从**引擎源码**读出"哪些时点真的会被走到"。
 *
 * 为什么需要：`effect-meta.js` 里声明了 EVENTS **不等于**引擎会触发它。用户 2026-10-02 在
 * 编辑器里连踩两个坑 —— 把【虚天鼎】写成 `event:'combatPlay'`、把【娑罗珠】写成 `event:'promote'`，
 * 而：
 *   · `combatPlay`（对战出牌阶段）**只在 EVENTS 表里有**，engine.js 里从来没有
 *     `fireTiming(..., 'combatPlay')` → 那两条效果是**死效果**；
 *   · `promote` 会触发，但 EVENTS.promote 没有 `interrupt` → `fireTiming` 只记一行
 *     "该时点暂未接入询问层"就过去了 → **写了也不会问玩家**。
 * 两种都不是 op 名写错（lint/verify-dsl 都查不出来），所以编辑器必须自己查。
 *
 * 判据（按 engine.js 的 mtime 缓存；改了引擎立刻反映）：
 *   · fired —— engine.js 源码里出现过 `fireTiming(state, '<事件>'` 的事件
 *   · asked —— EVENTS[事件] 带 `interrupt`（会真的开窗问玩家）
 */
let wiringCache = { at: -1, fired: null, asked: null };
function timingWiring() {
  const f = path.join(ROOT, 'server', 'engine.js');
  let mtime = -1;
  try { mtime = fs.statSync(f).mtimeMs; } catch (e) { /* 读不到就用上一次结果 */ }
  if (wiringCache.at === mtime && wiringCache.fired) return wiringCache;
  const fired = new Set();
  const autoKeys = new Set();
  try {
    const src = fs.readFileSync(f, 'utf8');
    const re = /fireTiming\(\s*state\s*,\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(src))) fired.add(m[1]);
    // ⚠️ 还有**第二条通道**：不走 fireTiming、而是被 `collectEffects(pl, '<时机>')` 直接收集的
    //    自动类时点（回合开始 / 放置同行者 / 装备宝器 / 濒危 / 对战结束…）。
    //    只认 fireTiming 会把这些误报成"引擎从不触发"（2026-10-02 迁移时实测踩到）。
    const re2 = /collectEffects\(\s*\w+\s*,\s*'([^']+)'/g;
    while ((m = re2.exec(src))) autoKeys.add(m[1]);
    // ⚠️ 第三条通道：**合并窗口的规格字面量**（`{ event: 'combatOpt', allSides: true }`）——
    //    「对战阶段」把 combatDeclare + combatOpt 合成一次询问（2026-10-02），
    //    它们不再各自走 `fireTiming(state, '...')`，只认前两条会把它们误判成"引擎从不触发"。
    //    先去掉注释、并要求前面有 `{`：注释里举反例的 `event:'combatPlay'` 不算数。
    const code = src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const re3 = /\{\s*event:\s*'([^']+)'/g;
    while ((m = re3.exec(code))) fired.add(m[1]);
    // 常量名单（COMBAT_BONUS_KEYS）也算自动通道
    for (const k of (META.COMBAT_BONUS_KEYS || [])) autoKeys.add(k);
  } catch (e) { /* 保持空集合（宁可多报也不放过） */ }
  const auto = new Set();
  for (const w of autoKeys) for (const k of META.wantKeys([w])) auto.add(k);
  const asked = new Set();
  for (const k of Object.keys(META.EVENTS || {})) {
    const ev = META.EVENTS[k];
    if (ev && (ev.interrupt === true || Array.isArray(ev.interrupt))) asked.add(k);
  }
  wiringCache = { at: mtime, fired: fired, asked: asked, auto: auto };
  return wiringCache;
}

/** 这条效果的时点在引擎里到底什么下场：null = 没问题 */
function timingVerdict(e) {
  if (!e || !e.event) return null;
  const ev = META.EVENTS[e.event];
  if (!ev) return { level: 'error', text: `时点「${e.event}」不在 effect-meta 的 EVENTS 表里` };
  const w = timingWiring();
  if (!w.fired.has(e.event) && !w.auto.has(e.event)) {
    return {
      level: 'error',
      text: `时点「${e.event}」（${ev.label}）**引擎从不触发** —— engine.js 里没有 fireTiming(..., '${e.event}')，这条效果是死的（不会生效、也不会问人）`,
    };
  }
  if (!w.asked.has(e.event) && !w.auto.has(e.event)) {
    const passive = !!(META.OPS && META.OPS[e.op] && META.OPS[e.op].passive);
    return {
      level: 'warn',
      text: passive
        ? `时点「${e.event}」（${ev.label}）**没接询问层**（EVENTS 里没有 interrupt）→ 不会被问，只会按「常驻/自动」生效`
        : `时点「${e.event}」（${ev.label}）**没接询问层**（EVENTS 里没有 interrupt）→ 写了也不会问玩家，这条效果不会生效`,
    };
  }
  return null;
}

/** 数值形参必须是数字：字符串会变成 JS 的字符串拼接（"-1" → "0-1" → 结算 NaN） */
function paramTypeProblems(where, e) {
  const out = [];
  if (!e || typeof e !== 'object' || !e.op) return out;
  let hints = OPPARAMS.PARAM_HINTS[e.op] || [];
  try { if (OPPARAMS.mergeHints) hints = OPPARAMS.mergeHints(e.op, META.OPS) || hints; } catch (err) { /* 用原始提示 */ }
  for (const h of hints) {
    if (h.type !== 'int' && h.type !== 'num') continue;
    const v = e[h.key];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'number' || !isFinite(v)) {
      out.push(`${where} 的参数「${h.label || h.key}」(${h.key}) 必须是**数字**，现在是 ${JSON.stringify(v)}`
        + ' —— 字符串会让引擎算成 NaN（实测：value:"-1" → 战力 "00-1" → 结算 NaN）');
    }
  }
  return out;
}

/** 新增的两类校验：① 数值形参类型 ② 时点接线。error 拦保存，warn 只提示。 */
function dataShapeCheck(pool) {
  const errors = [], warns = [];
  for (const d of DECKS) {
    for (const c of pool[d] || []) {
      const where = `${DECK_CN[d]}【${c.name || c.id}】`;
      const scan = (arr, tag) => {
        (arr || []).forEach((e, i) => {
          const at = `${where}${tag} 第 ${i + 1} 条效果`;
          for (const p of paramTypeProblems(at, e)) errors.push(p);
          const t = timingVerdict(e);
          if (t && t.level === 'error') errors.push(`${at}：${t.text}`);
          else if (t) warns.push(`${at}：${t.text}`);
        });
      };
      scan(c.effects, '');
      (c.tiers || []).forEach((t, ti) => scan(t.effects, ` 的档位 ${ti + 1}`));
    }
  }
  return { errors: errors, warns: warns };
}

/** 结构预检：防止把一个残缺/空卡池写上去（比校验器更早拦住灾难性错误） */
function preflight(pool) {
  const problems = [];
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) return ['卡池不是一个 JSON 对象'];
  for (const d of DECKS) {
    if (!Array.isArray(pool[d])) { problems.push(`缺少牌堆「${DECK_CN[d]}」(${d})，或它不是数组`); continue; }
    if (!pool[d].length) problems.push(`牌堆「${DECK_CN[d]}」是空的 —— 拒绝写盘`);
  }
  if (problems.length) return problems;
  const seenId = new Map(), seenName = new Map();
  for (const d of DECKS) {
    pool[d].forEach((c, i) => {
      const where = `${DECK_CN[d]} #${i + 1}`;
      if (!c || typeof c !== 'object') { problems.push(`${where} 不是对象`); return; }
      if (!c.id) problems.push(`${where}【${c.name || '?'}】缺 id`);
      if (!c.name) problems.push(`${where} 缺 name`);
      if (typeof c.count !== 'number' || !(c.count >= 0)) problems.push(`${where}【${c.name}】的 count 不是非负数字`);
      if (c.effects !== undefined && !Array.isArray(c.effects)) problems.push(`${where}【${c.name}】的 effects 不是数组`);
      for (const t of c.tiers || []) {
        if (!Array.isArray(t.effects)) problems.push(`${where}【${c.name}】的某个 tiers 档位没有 effects 数组`);
      }
      if (c.id) {
        if (seenId.has(c.id)) problems.push(`id 重复：${c.id}（${seenId.get(c.id)} 与 ${where}）`);
        else seenId.set(c.id, where);
      }
      if (c.name) {
        if (seenName.has(c.name)) problems.push(`牌名重复：${c.name}（${seenName.get(c.name)} 与 ${where}）`);
        else seenName.set(c.name, where);
      }
    });
  }
  return problems;
}

/**
 * 第 3 步闸门：**牌堆自洽**（不再是"必须等于官方 80/33/78/60 · 251"）。
 *
 * 用户 2026-10-02 深夜："卡池每张卡在编辑器里能编辑吗？不行的话改成也已编辑的每种牌的数量，
 * 卡组总数不固定、按改的算。" —— 所以这里只校验**能不能自洽**：
 *   · 每张卡的 `count` 必须是 **≥0 的整数**（0 = 暂时不放，允许）；
 *   · 每堆张数 = 该堆各卡 count 之和（实得多少报多少）；
 *   · 与官方基线（80/33/78/60·251）的差值只提示、不拦。
 * 想恢复"必须等于官方张数"就把 BASE_COUNT 拿来做硬比 —— 但默认不再这么干。
 */
function countCheck(pool) {
  const got = { kinds: {}, cards: {} };
  let total = 0;
  const lines = [];
  let ok = true;
  const bad = [];
  for (const d of DECKS) {
    const arr = Array.isArray(pool[d]) ? pool[d] : [];
    got.kinds[d] = arr.length;
    for (const c of arr) {
      if (typeof c.count !== 'number' || !isFinite(c.count) || c.count < 0 || Math.floor(c.count) !== c.count) {
        bad.push(`${DECK_CN[d]}【${c.name || c.id || '?'}】的张数必须是 ≥0 的整数，现在是 ${JSON.stringify(c.count)}`);
      }
    }
    got.cards[d] = arr.reduce((s, c) => s + (typeof c.count === 'number' ? c.count : 0), 0);
    total += got.cards[d];
    const diff = got.cards[d] - BASE_COUNT[d];
    lines.push(`✓ ${DECK_CN[d]}（${d}）：${got.cards[d]} 张（${arr.length} 种）` +
      (diff ? `　· 官方基线 ${BASE_COUNT[d]}，差 ${diff > 0 ? '+' : ''}${diff}` : '　· 与官方基线一致'));
  }
  for (const b of bad) { ok = false; lines.push('✗ ' + b); }
  const totalDiff = total - BASE_TOTAL;
  lines.push(`${ok ? '✓' : '✗'} 合计：${total} 张` +
    (totalDiff ? `（官方基线 ${BASE_TOTAL}，差 ${totalDiff > 0 ? '+' : ''}${totalDiff}）` : '（与官方基线一致）'));
  lines.push('（本步只查"自洽"：每堆张数 = 各卡 count 之和、count 是 ≥0 的整数。总数不固定，按你改的算。）');
  return { ok, got, total, baseline: BASE_COUNT, baselineTotal: BASE_TOTAL, output: lines.join('\n') };
}

/**
 * 跑完整三步：① lint-cards ② verify-dsl ③ 牌堆自洽（张数不固定，只查自洽）。
 * 任何一步不过 → ok:false，调用方必须拒绝写盘。
 */
function validate(pool) {
  const steps = [];

  // ⓪ 结构预检（编辑器自己的保险丝）
  const pf = preflight(pool);
  steps.push({
    key: 'preflight', name: '结构预检（编辑器自检）', cmd: '（编辑器内置）',
    code: pf.length ? 1 : 0, ok: pf.length === 0,
    output: pf.length ? pf.map((p) => '✗ ' + p).join('\n') : '✓ 四堆齐全、id/牌名不重复、字段类型正确',
  });
  if (pf.length) return { ok: false, steps };

  // ⓪.5 参数类型 + 时点接线（2026-10-02 新增：用户实盘在编辑器里踩过这两类坑）
  const ds = dataShapeCheck(pool);
  steps.push({
    key: 'shape', name: '第 0.5 步 · 参数类型 / 时点接线（编辑器自检）', cmd: '（编辑器内置）',
    code: ds.errors.length ? 1 : 0, ok: ds.errors.length === 0,
    output: (ds.errors.length
      ? ds.errors.map((x) => '✗ ' + x).join('\n')
      : '✓ 数值形参都是数字；所有 event 时点引擎都会真的触发')
      + (ds.warns.length ? '\n' + ds.warns.map((x) => '⚠ ' + x).join('\n') : ''),
  });
  if (ds.errors.length) return { ok: false, steps, warnings: ds.warns };

  // ① ② 在镜像里跑真实校验器（先写候选，不碰真实仓库）
  writeMirrorPool(pool);
  const lint = runScript(path.join('tools', 'lint-cards.js'), '卡牌一致性体检 lint-cards.js');
  lint.name = '第 1 步 · 卡牌一致性体检（tools/lint-cards.js）';
  steps.push(lint);
  if (!lint.ok) return { ok: false, steps };

  const dsl = runScript(path.join('tools', 'verify-dsl.js'), '效果 DSL 验收 verify-dsl.js');
  dsl.name = '第 2 步 · 效果 DSL 验收（tools/verify-dsl.js）';
  steps.push(dsl);
  if (!dsl.ok) return { ok: false, steps };

  // ③ 牌堆自洽（张数不固定）
  const cnt = countCheck(pool);
  steps.push({
    key: 'count', name: '第 3 步 · 牌堆自洽（每堆 = 各卡张数之和；总数不固定）',
    cmd: '（编辑器内置）', code: cnt.ok ? 0 : 1, ok: cnt.ok, output: cnt.output,
  });
  return { ok: cnt.ok, steps, counts: cnt.got, total: cnt.total };
}

// ---------------------------------------------------------------- 回归任务（异步）
const jobs = new Map();

function resolveRegression() {
  const envCmd = process.env.EDITOR_REGRESSION_CMD;
  if (envCmd) {
    // 自定义命令（自测 / 临时替换）：`node x.js` 与 `x.js` 都认，其它命令交给 shell
    const parts = envCmd.split(/\s+/).filter(Boolean);
    let argv = parts, shell = false, exe = process.execPath;
    if (parts.length && /node(\.exe)?$/i.test(parts[0])) argv = parts.slice(1);
    else if (parts.length && !/\.js$/i.test(parts[0])) { shell = true; exe = null; argv = [envCmd]; }
    return { argv: argv, exe: exe, shell: shell, cmd: envCmd, source: '环境变量 EDITOR_REGRESSION_CMD', note: '自定义命令（临时替换用）' };
  }
  for (const p of [path.join('tests', 'run-all.js'), path.join('tools', 'run-all.js')]) {
    if (fs.existsSync(path.join(ROOT, p))) {
      return {
        argv: [path.join(ROOT, p), '--no-ui'], exe: process.execPath, shell: false,
        cmd: 'node ' + p.split(path.sep).join('\\') + ' --no-ui',
        source: '仓库里找到的 ' + rel(path.join(ROOT, p)),
        note: '引擎/规则单测 + 卡池不变量 + 服务端连通（不跑浏览器 UI）',
      };
    }
  }
  return null;
}

function startRegression() {
  const r = resolveRegression();
  if (!r) return { error: '找不到 run-all.js（tests/run-all.js 或 tools/run-all.js 都不存在）' };
  const id = 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const job = { id, cmd: r.cmd, source: r.source, note: r.note, running: true, code: null, output: '', startedAt: Date.now(), endedAt: null, timedOut: false };
  let child;
  try {
    const opts = { cwd: ROOT, windowsHide: true, shell: !!r.shell, env: Object.assign({}, process.env, { NO_COLOR: '1' }) };
    child = r.exe
      ? cp.spawn(r.exe, r.argv, opts)
      : cp.spawn(r.argv[0], [], opts);
  } catch (e) {
    return { error: '启动失败：' + e.message };
  }
  const push = (buf) => {
    job.output += buf.toString('utf8');
    if (job.output.length > 400000) job.output = job.output.slice(-400000);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  const timer = setTimeout(() => {
    job.timedOut = true;
    try { child.kill(); } catch (e) { /* 忽略 */ }
  }, REGRESSION_TIMEOUT);
  child.on('error', (e) => { job.output += '\n[启动/运行错误] ' + e.message + '\n'; });
  child.on('close', (code) => {
    clearTimeout(timer);
    job.running = false;
    job.code = code;
    job.endedAt = Date.now();
    job.output += `\n（退出码 ${code}，耗时 ${((job.endedAt - job.startedAt) / 1000).toFixed(1)} 秒）\n`;
  });
  jobs.set(id, job);
  return { id };
}

// ---------------------------------------------------------------- 字段使用情况（治"幽灵字段"）
let FIELD_SEEN = null;
function fieldSeen() {
  if (FIELD_SEEN) return FIELD_SEEN;
  let src = '';
  for (const p of ['server/engine.js', 'public/app.js', 'server/cards.js']) {
    try { src += fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { /* 忽略 */ }
  }
  const names = new Set();
  for (const op of Object.keys(OPPARAMS.PARAM_HINTS)) for (const p of OPPARAMS.PARAM_HINTS[op]) names.add(p.key);
  for (const k of Object.keys(OPPARAMS.FIELD_LABELS)) names.add(k);
  const out = {};
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const n of names) {
    // 找 `.字段名` 或 `['字段名']`（不匹配注释里提到的纯文字）
    const re = new RegExp('\\.' + escapeRe(n) + '\\b');
    const re2 = new RegExp("\\[\\s*['\"]" + escapeRe(n) + "['\"]\\s*\\]");
    out[n] = re.test(src) || re2.test(src);
  }
  FIELD_SEEN = out;
  return out;
}

// ---------------------------------------------------------------- HTTP 路由
const STATIC = {
  '/': { file: path.join(HERE, 'index.html'), type: 'text/html' },
  '/index.html': { file: path.join(HERE, 'index.html'), type: 'text/html' },
  '/app.js': { file: path.join(HERE, 'app.js'), type: 'text/javascript' },
  '/style.css': { file: path.join(HERE, 'style.css'), type: 'text/css' },
  // 复用游戏前端的暗金国风（只读，一份 CSS 两个地方用，不另起风格）
  '/game-style.css': { file: path.join(ROOT, 'public', 'style.css'), type: 'text/css' },
};

async function handle(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  // 浏览器一定会来要 favicon —— 不处理就在控制台留一条 404 噪音（会掩盖真正的报错）。给个 204。
  if (p === '/favicon.ico') { res.writeHead(204, { 'cache-control': 'max-age=86400' }); return res.end(); }

  // ---- 静态 ----
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (STATIC[p]) {
      const s = STATIC[p];
      if (!fs.existsSync(s.file)) return sendText(res, 404, '缺少文件：' + rel(s.file));
      const body = fs.readFileSync(s.file);
      res.writeHead(200, {
        'content-type': s.type + '; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : body);
    }
  }

  // ---- API ----
  if (p === '/api/healthz') {
    // `stale` = 进程启动时读的源码 mtime vs **现在**磁盘上的 mtime：
    // 看门狗 5 秒会把被杀的进程拉起来，但"旧进程还占着端口、新进程起不来"是分不出来的
    // （2026-10-05 实测踩到过：8097 上坐着上一会话的进程）→ 这里给个可判的字段。
    return sendJson(res, 200, {
      ok: true, service: 'fanren-card-editor', pid: process.pid, cardsFile: rel(CARDS_FILE),
      started: BOOT_STARTED, codeMtime: BOOT_CODE_MTIME, codeMtimeNow: codeMtimeNow(),
      stale: codeMtimeNow() !== BOOT_CODE_MTIME,
    });
  }

  if (p === '/api/meta') {
    const m = META.meta();
    return sendJson(res, 200, Object.assign({}, m, {
      paramHints: OPPARAMS.hintsSnapshot(m.ops),
      fieldLabels: OPPARAMS.FIELD_LABELS,
      cardFieldLabels: OPPARAMS.CARD_FIELD_LABELS,
      effectReserved: OPPARAMS.EFFECT_RESERVED,
      fieldSeen: fieldSeen(),
      decks: DECKS,
      deckNames: DECK_CN,
      baselineCounts: BASE_COUNT,
      baselineTotal: BASE_TOTAL,
      keepBackups: KEEP_BACKUPS,
    }));
  }

  if (p === '/api/state') {
    const pool = readPool(CARDS_FILE);
    return sendJson(res, 200, {
      cardsFile: rel(CARDS_FILE),
      cardsFileAbsolute: CARDS_FILE,
      exists: pool.exists,
      bytes: pool.bytes || 0,
      mtime: pool.mtime || null,
      parseError: pool.parseError || null,
      backups: listBackups(CARDS_FILE),
      keepBackups: KEEP_BACKUPS,
      baselineCounts: BASE_COUNT,
      baselineTotal: BASE_TOTAL,
      regression: resolveRegression(),
      mirror: MIRROR,
      pid: process.pid,
      port: PORT,
      host: HOST,
      nodeVersion: process.version,
    });
  }

  if (p === '/api/cards') {
    const pool = readPool(CARDS_FILE);
    if (!pool.exists) return sendJson(res, 404, { error: '文件不存在：' + rel(CARDS_FILE) });
    if (pool.parseError) return sendJson(res, 500, { error: 'JSON 解析失败：' + pool.parseError });
    return sendJson(res, 200, {
      cardsFile: rel(CARDS_FILE), cardsFileAbsolute: CARDS_FILE, bytes: pool.bytes, mtime: pool.mtime,
      decks: DECKS, deckNames: DECK_CN, baselineCounts: BASE_COUNT, baselineTotal: BASE_TOTAL,
      pool: pool.json,
    });
  }

  if (p === '/api/validate' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: '请求体不是 JSON：' + e.message }); }
    if (!body || !body.cards) return sendJson(res, 400, { error: '请求体缺少 cards 字段' });
    let result;
    try { result = validate(body.cards); } catch (e) { return sendJson(res, 500, { error: '校验过程出错：' + (e && e.stack || e.message) }); }
    return sendJson(res, 200, Object.assign({ wrote: false, cardsFile: rel(CARDS_FILE) }, result));
  }

  if (p === '/api/save' && req.method === 'POST') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: '请求体不是 JSON：' + e.message }); }
    if (!body || !body.cards) return sendJson(res, 400, { error: '请求体缺少 cards 字段' });
    if (!fs.existsSync(CARDS_FILE)) return sendJson(res, 409, { error: '目标文件不存在：' + rel(CARDS_FILE) + '（编辑器不新建卡池文件）' });
    let result;
    try { result = validate(body.cards); } catch (e) { return sendJson(res, 500, { error: '校验过程出错：' + (e && e.stack || e.message) }); }
    if (!result.ok) {
      return sendJson(res, 200, Object.assign({ wrote: false, cardsFile: rel(CARDS_FILE) }, result, {
        reason: '校验未通过 —— 已拒绝写盘，磁盘上的文件一个字节都没变',
      }));
    }
    // ⚠️ 并发保护（2026-10-05 加）：客户端把"本页载入时的 mtime"回传上来（`baseMtime`）。
    //    磁盘上的卡池要是被**别的路子**改过（另一个会话直接编辑 data/cards.json、迁移脚本等），
    //    这里的直接写盘会把它整段覆盖掉 —— 2026-10-05 就这么丢掉过当轮刚修的两张卡数据
    //    （旧页面存盘把【掌天瓶】启用费删改和【降尘丹】第二时点整段回退，害得下个会话把
    //    3 个测试套件当"引擎真回归"查了半天）。所以对不上就 409，让前端问一句。
    //    `force: true` 或没带 `baseMtime`（命令行/自检脚本）时照旧写 —— 不改变老调用方的行为。
    if (!body.force && body.baseMtime) {
      const diskMtime = fs.statSync(CARDS_FILE).mtime.toISOString();
      const same = new Date(diskMtime).getTime() === new Date(body.baseMtime).getTime();
      if (!same) {
        return sendJson(res, 409, {
          wrote: false, conflict: true, cardsFile: rel(CARDS_FILE),
          baseMtime: body.baseMtime, diskMtime: diskMtime,
          reason: '磁盘上的卡池在你编辑期间被改过 —— 直接写盘会把那边的改动整段覆盖，先确认',
        });
      }
    }
    const before = readPool(CARDS_FILE);
    const text = serializePool(body.cards, before.style);
    let bak = null;
    try {
      bak = backup(CARDS_FILE);
      fs.writeFileSync(CARDS_FILE, text, 'utf8');
    } catch (e) {
      return sendJson(res, 500, Object.assign({ wrote: false, cardsFile: rel(CARDS_FILE) }, result, {
        error: '写盘失败：' + e.message, backup: bak,
      }));
    }
    const after = readPool(CARDS_FILE);
    return sendJson(res, 200, Object.assign({
      wrote: true, cardsFile: rel(CARDS_FILE), backup: bak, bytes: after.bytes, mtime: after.mtime,
      parseErrorAfterWrite: after.parseError || null,
      hint: '已写入磁盘。要让游戏生效：跑回归 → 重启线上服务（计划任务 FanrenGame）。',
    }, result));
  }

  if (p === '/api/backups') {
    return sendJson(res, 200, { cardsFile: rel(CARDS_FILE), keepBackups: KEEP_BACKUPS, backups: listBackups(CARDS_FILE) });
  }

  // 平衡试跑：拿**界面上这份卡池**（不必先存盘）跑 `tests\balance-stats.js`（多档位各打 N 局，出胜率表）。
  // 和沙盒一样"用界面上的数据"，但只读、不改任何东西；跑在镜像里，线上不受影响。
  if (p === '/api/balance') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 POST' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: '请求体不是 JSON：' + e.message }); }
    const games = Math.max(1, Math.min(200, Number(body && body.games) || 12));
    const pool = (body && body.cards) || readPool(CARDS_FILE).json;
    if (!pool) return sendJson(res, 500, { error: '读不到卡池' });
    writeMirrorPool(pool);
    const r = runScript(path.join('tests', 'balance-stats.js'), '平衡试跑 balance-stats.js', [String(games)]);
    return sendJson(res, 200, { ok: r.code === 0, games: games, output: r.output, cmd: r.cmd });
  }

  // 效果模拟沙盒：在**编辑器里当前那份卡池**上就地建局跑引擎（详见 tools\editor\sim.js 顶部注释）。
  // 无状态：请求体自带 setup + 动作序列，每次整体重放 —— 前端点一下按钮就 append 一条再重跑。
  if (p === '/api/simulate') {
    if (req.method === 'GET') {
      return sendJson(res, 200, { ok: true, meta: { steps: SIM.STEPS, actions: SIM.ACTIONS } });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: '只支持 GET（取元数据）/ POST（跑场景）' });
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { return sendJson(res, 400, { error: '请求体不是 JSON：' + e.message }); }
    let out;
    try { out = SIM.runScenario(body); } catch (e) {
      return sendJson(res, 500, { ok: false, error: '沙盒跑挂了：' + (e && e.message), stack: e && e.stack });
    }
    return sendJson(res, 200, out);
  }

  if (p === '/api/regression') {
    if (req.method === 'POST') {
      const r = startRegression();
      if (r.error) return sendJson(res, 409, r);
      return sendJson(res, 200, { started: true, id: r.id, ...(jobs.get(r.id) ? { cmd: jobs.get(r.id).cmd, source: jobs.get(r.id).source, note: jobs.get(r.id).note } : {}) });
    }
    const id = u.searchParams.get('id');
    if (id) {
      const job = jobs.get(id);
      if (!job) return sendJson(res, 404, { error: '没有这个任务：' + id });
      return sendJson(res, 200, {
        id: job.id, cmd: job.cmd, source: job.source, note: job.note,
        running: job.running, code: job.code, timedOut: job.timedOut,
        elapsedMs: (job.endedAt || Date.now()) - job.startedAt,
        output: job.output,
      });
    }
    return sendJson(res, 200, {
      available: !!resolveRegression(),
      resolved: resolveRegression(),
      jobs: [...jobs.values()].map((j) => ({ id: j.id, cmd: j.cmd, running: j.running, code: j.code })),
    });
  }

  return sendJson(res, 404, { error: '没有这个接口：' + p });
}

// ---------------------------------------------------------------- 启动
function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { sendJson(res, 500, { error: '服务内部错误：' + (e && e.stack || e.message) }); } catch (e2) { /* 忽略 */ }
  });
});

server.on('error', (e) => {
  console.error('[editor] 启动失败：' + e.message);
  if (e.code === 'EADDRINUSE') console.error(`[editor] 端口 ${PORT} 已被占用（换一个：--port 8099）`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const swept = sweepStaleMirrors();
  const pool = readPool(CARDS_FILE);
  console.log('=== 凡人修仙传·结婴之战 —— 卡牌编辑器 ===');
  console.log(`目标卡池： ${CARDS_FILE}`);
  console.log(`          ${pool.exists ? `已读取 ${pool.bytes} 字节，${pool.parseError ? '⚠ JSON 解析失败：' + pool.parseError : 'JSON 正常'}` : '⚠ 文件不存在'}`);
  console.log(`本地访问： http://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0') {
    const lan = lanAddresses();
    for (const a of lan) console.log(`局域网访问：http://${a.address}:${PORT}   （${a.name}）`);
    if (!lan.length) console.log('局域网访问：未发现非回环 IPv4 地址');
    console.log('提示：局域网可访问 = 同 WiFi 的手机/平板也能打开。若连不上，多半是 Windows 防火墙没放行 TCP ' + PORT + '。');
  }
  console.log(`备份上限： ${KEEP_BACKUPS} 份（<目标文件>.bak-editor-<时间戳>）`);
  if (swept) console.log(`已清理 ${swept} 个上次残留的校验镜像`);
  const reg = resolveRegression();
  console.log(`回归命令： ${reg ? reg.cmd : '⚠ 没找到 run-all.js'}${reg && reg.source.indexOf('环境变量') === 0 ? '（被 EDITOR_REGRESSION_CMD 覆盖）' : ''}`);
  console.log('校验镜像： ' + MIRROR);
  console.log('按 Ctrl+C 退出。本进程不碰游戏服务（8094/计划任务）。');
});

let cleaning = false;
function cleanup() {
  if (cleaning) return;
  cleaning = true;
  try { fs.rmSync(MIRROR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
