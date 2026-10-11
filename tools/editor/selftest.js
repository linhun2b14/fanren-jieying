'use strict';
/**
 * 卡牌编辑器 · 端到端自测（服务端 + 接口 + 写盘/校验/备份）
 *
 * 它做什么（全部在**临时副本**上，绝不碰 data/cards.json）：
 *   1. 复制 data/cards.json → data/_editor-selftest.json（并清掉旧的自测备份）
 *   2. 打编辑器接口：首页 / 卡池 JSON / meta / state / 备份列表
 *   3. POST /api/validate：原样数据应三步全过、且不写盘
 *   4. POST /api/save：改一条效果数值 → 应写盘 + 生成 .bak-editor-<时间戳> 备份
 *   5. 故意写坏三连：op 不在元数据表 / 张数不对 / 结构坏（空堆、id 重复）
 *      —— 每次都必须"拒绝写盘"，且临时副本字节不变
 *   6. 备份上限：造 12 份假备份 + 一次真实保存 → 只留 10 份、删的是最旧的
 *   7. 异步任务管道（POST /api/regression + 轮询）
 *   8. 收尾核对：data/cards.json 与仓库其它文件 sha 全程不变；清理自测副本
 *
 * 前置（两件事）：
 *   ① 起服务，目标指向自测副本：
 *        node tools\editor\server.js --cards data\_editor-selftest.json --port 8098
 *   ② 想验异步任务管道但不想连线上时，用替身命令起服务：
 *        $env:EDITOR_REGRESSION_CMD = 'node <某个小脚本>'
 *
 * 用法： node tools\editor\selftest.js [--keep]      （--keep = 保留自测副本不删）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const BASE = process.env.EDITOR_BASE || 'http://127.0.0.1:8098';
const TMP = path.join(ROOT, 'data', '_editor-selftest.json');
const REAL = path.join(ROOT, 'data', 'cards.json');
const KEEP = process.argv.includes('--keep');
const DECKS = ['treasure', 'spell', 'companion', 'qi'];

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const line = (s) => console.log('\n===== ' + s + ' =====');
let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? '   ' + extra : ''));
  if (!ok) fails++;
}
const J = async (url, opt) => {
  const r = await fetch(BASE + url, opt);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { body = { __raw: text.slice(0, 300) }; }
  return { status: r.status, body };
};
const post = (url, obj) => J(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) });
const step = (res, key) => (res.steps || []).find((s) => s.key === key) || null;
const clearBaks = () => {
  const dir = path.dirname(TMP);
  const base = path.basename(TMP) + '.bak-editor-';
  for (const f of fs.readdirSync(dir)) if (f.startsWith(base)) fs.rmSync(path.join(dir, f), { force: true });
};

(async () => {
  // ---------------------------------------------------------------- 准备
  const realBefore = sha(REAL);
  const files = ['docs/卡牌实装覆盖率.md', 'docs/规则文档.md', 'server/engine.js', 'server/effect-meta.js',
    'public/app.js', 'public/style.css', 'tests/run-all.js', 'tools/lint-cards.js', 'tools/verify-dsl.js'];
  const before = {};
  for (const f of files) before[f] = sha(path.join(ROOT, f));

  line('0. 准备自测副本 + 确认服务目标是它（不是真实卡池）');
  fs.copyFileSync(REAL, TMP);
  clearBaks();
  const tmpBefore = sha(TMP);
  check('已复制 data/cards.json → data/_editor-selftest.json', sha(TMP) === realBefore, 'sha=' + tmpBefore);
  const st0 = await J('/api/state');
  check('编辑器服务在线', st0.status === 200, BASE);
  check('服务目标 = 自测副本（若是 cards.json 就拒绝继续）', /_editor-selftest\.json$/.test(st0.body.cardsFileAbsolute || ''), st0.body.cardsFileAbsolute);
  if (!/_editor-selftest\.json$/.test(st0.body.cardsFileAbsolute || '')) {
    console.log('\n服务目标不是自测副本 —— 为避免误写真实卡池，自测中止。请用：\n  node tools\\editor\\server.js --cards data\\_editor-selftest.json --port 8098\n');
    process.exit(2);
  }

  line('1. 静态资源与首页');
  const home = await fetch(BASE + '/');
  const html = await home.text();
  check('GET / → 200 且是编辑器页面', home.status === 200 && /卡牌编辑器/.test(html), 'length=' + html.length);
  check('GET /style.css → 200（编辑器布局）', (await fetch(BASE + '/style.css')).status === 200);
  const gcss = await (await fetch(BASE + '/game-style.css')).text();
  check('GET /game-style.css → 200（复用 public/style.css 的暗金国风）', /--gold:/.test(gcss), gcss.length + ' 字节');
  check('GET /app.js → 200', /effEditor/.test(await (await fetch(BASE + '/app.js')).text()));
  check('GET /api/healthz → ok', (await J('/api/healthz')).body.ok === true);

  line('2. GET /api/cards 卡池 JSON');
  const cards = await J('/api/cards');
  const pool = cards.body.pool;
  const kinds = {}, sums = {};
  let total = 0;
  for (const d of DECKS) { kinds[d] = pool[d].length; sums[d] = pool[d].reduce((s, c) => s + c.count, 0); total += sums[d]; }
  // 牌堆张数**不写死**（用户 2026-10-02 深夜："卡组总数不固定，按改的算"）：只看结构自洽 + 打印实得值
  check('四堆都有牌', DECKS.every((d) => Array.isArray(pool[d]) && pool[d].length > 0), JSON.stringify(kinds));
  check('每堆张数 = 各卡 count 之和（实得）',
    DECKS.every((d) => sums[d] === pool[d].reduce((s, c) => s + c.count, 0)) && total > 0,
    JSON.stringify(sums) + ' 合计 ' + total);
  check('是磁盘原始数据（含 cat/text/effects 等字段）', !!(pool.treasure[0].cat && pool.treasure[0].text && Array.isArray(pool.treasure[0].effects)));

  line('3. GET /api/meta 元数据（op / 时点 / 条件 / 参数提示）');
  const M = (await J('/api/meta')).body;
  check('op 数 ≥ 60（OPS 表）', Object.keys(M.ops).length >= 60, Object.keys(M.ops).length + ' 个');
  check('when 表 19 项', Object.keys(M.whens).length === 19, Object.keys(M.whens).length + ' 项');
  check('条件表含 hp/realm/enemyRealm/target/companion/lethal/puppet', ['hp', 'realm', 'enemyRealm', 'target', 'companion', 'lethal', 'puppet'].every((k) => M.conditions[k]));
  check('时点总线 EVENTS（roll 带前后两阶段）', M.events.roll.phases.join('/') === 'before/after' && M.events.roll.subject === 'both');
  check('damage_target 的参数只有「伤害点数」', JSON.stringify(M.paramHints.damage_target.map((p) => p.key)) === JSON.stringify(['value']));
  check('promote_discount 的 params 来自 effect-meta（on 在前）', M.paramHints.promote_discount[0].key === 'on');
  check('比较符含 lte/lt/gte/gt/eq/higher/lower', ['lte', 'lt', 'gte', 'gt', 'eq', 'higher', 'lower'].every((k) => M.conditions.enemyRealm.keys.includes(k)));
  check('幽灵字段启发式（fieldSeen）随 meta 下发', typeof M.fieldSeen.value === 'boolean');
  check('官方基线随 meta 下发（只作提示：80 · 251）', M.baselineCounts.treasure === 80 && M.baselineTotal === 251);

  line('4. 只校验：原样数据应通过且不写盘');
  const v1 = await post('/api/validate', { cards: pool });
  check('校验通过', v1.body.ok === true, v1.body.steps.map((s) => s.key + ':' + s.code).join(' '));
  check('① lint-cards 退出码 0（原样报告）', step(v1.body, '卡牌一致性体检 lint-cards.js').code === 0 && /卡池一致性体检/.test(step(v1.body, '卡牌一致性体检 lint-cards.js').output));
  // ⚠️ 别写死 `35 / 35` 这种数字 —— verify-dsl 每加一条自检这里就假红（2026-10-02 加时点硬校验时踩到）。
  //    改成"两端数字相等即全通过"。
  check('② verify-dsl 退出码 0（全部通过）', step(v1.body, '效果 DSL 验收 verify-dsl.js').code === 0 && (() => {
    const m = /通过 (\d+) \/ (\d+)/.exec(step(v1.body, '效果 DSL 验收 verify-dsl.js').output);
    return !!m && m[1] === m[2];
  })(), (step(v1.body, '效果 DSL 验收 verify-dsl.js').output.split('\n').filter(Boolean).slice(-1)[0] || ''));
  check('③ 牌堆自洽通过（合计 = 各卡张数之和，张数不固定）',
    step(v1.body, 'count').code === 0 && /合计：\d+ 张/.test(step(v1.body, 'count').output),
    (step(v1.body, 'count').output || '').split('\n').filter(Boolean).slice(-2).join(' / '));
  check('wrote=false，且副本字节未变', v1.body.wrote === false && sha(TMP) === tmpBefore);

  line('5. 成功路径：改效果数值 → 写盘 + 备份');
  const pool2 = JSON.parse(JSON.stringify(pool));
  const t2 = pool2.treasure.find((c) => c.name === '寒冰珠');
  t2.text += '［自测标记］';
  t2.effects[0].value = 3;
  const s1 = await post('/api/save', { cards: pool2 });
  check('保存成功', s1.body.wrote === true, s1.body.steps.map((s) => s.key + ':' + s.code).join(' '));
  check('生成 _editor-selftest.json.bak-editor-<时间戳>', /_editor-selftest\.json\.bak-editor-\d{8}-\d{6}/.test(s1.body.backup.file), s1.body.backup.file);
  check('磁盘上是改后的数据', JSON.parse(fs.readFileSync(TMP, 'utf8')).treasure.find((c) => c.name === '寒冰珠').effects[0].value === 3);
  check('备份里是改前的数据', JSON.parse(fs.readFileSync(path.join(ROOT, 'data', s1.body.backup.file), 'utf8')).treasure.find((c) => c.name === '寒冰珠').effects[0].value === 2);
  const written = JSON.parse(fs.readFileSync(TMP, 'utf8'));
  // 换行风格**两种都要认**：Git for Windows 的 `core.autocrlf=true` 会在 checkout 时把文件写成 CRLF，
  // 而这条断言原来只认 LF —— 谁在中间 `git checkout` 一次就会假红（2026-10-05 踩到）。
  // 真正要守的是"2 空格缩进 + 末尾换行 + 无 BOM"这三件事。
  const rawTmp = fs.readFileSync(TMP, 'utf8');
  check('风格保持（2 空格缩进 + 末尾换行 + 无 BOM；LF/CRLF 都算）',
    rawTmp.split('\r\n').join('\n') === JSON.stringify(written, null, 2) + '\n' && rawTmp.charCodeAt(0) !== 0xFEFF);
  check('★ 真实 data/cards.json 未被动过', sha(REAL) === realBefore, 'sha=' + sha(REAL));

  line('5.5 并发保护：磁盘版本在本页载入之后被改过 → 不静默覆盖（2026-10-05 事故的守卫）');
  // 2026-10-05 真事故：8098 里一个**旧页面**存盘，把当轮刚修的两处卡数据（【掌天瓶】启用费、
  // 【降尘丹】第二时点）整段回退，害得下一个会话把因此变红的 3 个套件当"引擎真回归"查了半天。
  // 现在 /api/save 认 `baseMtime`（前端载入时拿到的那份）。
  const curMtime = (await J('/api/cards')).body.mtime;
  const stalePool = JSON.parse(JSON.stringify(written));
  stalePool.treasure.find((c) => c.name === '寒冰珠').text += '［并发自测］';
  const staleMtime = new Date(Date.parse(curMtime) - 60000).toISOString();
  const b55 = sha(TMP);
  const sStale = await post('/api/save', { cards: stalePool, baseMtime: staleMtime });
  check('带过期 baseMtime → 409 且拒绝写盘', sStale.status === 409 && sStale.body.wrote === false && sStale.body.conflict === true,
    JSON.stringify({ status: sStale.status, diskMtime: sStale.body.diskMtime }));
  check('副本字节没变（旧页面覆盖不进来）', sha(TMP) === b55);
  const sCur = await post('/api/save', { cards: stalePool, baseMtime: curMtime });
  check('带当前 baseMtime → 正常写盘（不误伤正常保存）', sCur.body.wrote === true, JSON.stringify(sCur.body.reason || ''));
  check('磁盘确实是这一版', /［并发自测］/.test(JSON.parse(fs.readFileSync(TMP, 'utf8')).treasure.find((c) => c.name === '寒冰珠').text));
  check('force:true 能强行覆盖（前端 confirm 后走这条）',
    (await post('/api/save', { cards: written, baseMtime: staleMtime, force: true })).body.wrote === true);
  check('不带 baseMtime 的老调用方行为不变（命令行 / 迁移脚本）',
    (await post('/api/save', { cards: written })).body.wrote === true);
  check('★ 真实 data/cards.json 仍未被动过', sha(REAL) === realBefore, 'sha=' + sha(REAL));

  line('5.6 效果模拟沙盒：/api/simulate（挑阶段 / 手牌 / 生命法力 + 对手响应，就地跑引擎）');
  // 用户 2026-10-05 要的功能：在编辑器里摆一个局面跑引擎看效果。要点是**用界面上那份卡池**
  // （可能还没存盘），所以 §5.6 特意验一遍"带 cards / 不带 cards"两条路。
  const bSim = sha(TMP);
  const smeta = await J('/api/simulate');
  check('GET 拿到阶段表与动作表', smeta.status === 200 && (smeta.body.meta.steps || []).length >= 4 && (smeta.body.meta.actions || []).length >= 10,
    JSON.stringify({ steps: (smeta.body.meta.steps || []).length, actions: (smeta.body.meta.actions || []).length }));
  const sim1 = await post('/api/simulate', {
    seed: 42, turn: 0, step: 'action',
    players: { a: { realm: 2, hp: 3, mana: 12, hand: ['补气丹'] }, b: { realm: 2, hp: 6 } },
    actions: [{ player: 'a', action: { type: 'play', card: '补气丹' } }],
  });
  check('跑场景：打出【补气丹】回 1 点血（3 → 4）', sim1.body.ok === true && sim1.body.state.players[0].hp === 4,
    JSON.stringify({ hp: sim1.body.state.players[0] && sim1.body.state.players[0].hp }));
  check('战报原样回传（含「打出【补气丹】」）', (sim1.body.log || []).some((l) => /打出【补气丹】/.test(l.text)),
    JSON.stringify((sim1.body.log || []).map((l) => l.text).slice(0, 3)));
  const sim2 = await post('/api/simulate', {
    seed: 43, step: 'action',
    players: { a: { realm: 2, mana: 12, hand: ['青蛟旗'] }, b: { realm: 2, mana: 12, hand: ['阴魂丝'] } },
    actions: [
      { player: 'a', action: { type: 'combat', target: 'b' } },
      { player: 'b', action: { type: 'respond_play', card: '阴魂丝' } },
    ],
  });
  check('对手在开战窗口破招打出【阴魂丝】并生效', sim2.body.ok === true && (sim2.body.log || []).some((l) => /破译|封锁|阴魂丝/.test(l.text)),
    JSON.stringify((sim2.body.log || []).map((l) => l.text).slice(0, 4)));
  // 注入卡池：把【补气丹】改成回 4 点血 —— 立刻生效，不必存盘
  const poolMod = JSON.parse(JSON.stringify(pool));
  poolMod.treasure.find((c) => c.name === '补气丹').effects[0].value = 4;
  const sim3 = await post('/api/simulate', {
    cards: poolMod, seed: 44, step: 'action',
    players: { a: { realm: 2, hp: 1, mana: 12, hand: ['补气丹'] }, b: { realm: 2 } },
    actions: [{ player: 'a', action: { type: 'play', card: '补气丹' } }],
  });
  check('带 cards = 用**界面上那份**卡池（改过的 heal 4 → 1+4=5）', sim3.body.state.players[0].hp === 5, String(sim3.body.state.players[0].hp));
  const sim4 = await post('/api/simulate', {
    seed: 44, step: 'action',
    players: { a: { realm: 2, hp: 1, mana: 12, hand: ['补气丹'] }, b: { realm: 2 } },
    actions: [{ player: 'a', action: { type: 'play', card: '补气丹' } }],
  });
  check('不带 cards = 回落到磁盘那份（heal 1 → 2）', sim4.body.state.players[0].hp === 2, String(sim4.body.state.players[0].hp));
  const simBad = await post('/api/simulate', { players: { a: { hand: ['这张牌不存在'] } } });
  check('牌名写错时明确报错（不静默跑空局）', simBad.body.ok === false && /没有这些牌/.test(simBad.body.error || ''), JSON.stringify(simBad.body.error));
  check('★ 沙盒全程不写盘（副本字节未变）', sha(TMP) === bSim);

  line('5.7 平衡试跑：/api/balance（拿界面上那份卡池跑多档位对局）');
  {
    const bBal = sha(TMP);
    const bal = await post('/api/balance', { games: 2 });
    check('跑得起来且退出码 0', bal.status === 200 && bal.body.ok === true, JSON.stringify({ status: bal.status, ok: bal.body && bal.body.ok }));
    check('输出里有胜率/平手率那几行（balance-stats 的表）',
      /平均回合数|元婴获胜占比|对战平手率/.test(bal.body.output || ''), String(bal.body.output || '').slice(0, 120));
    check('回传了实际用的局数（每档 2 局）', bal.body.games === 2, String(bal.body.games));
    check('局数越界会被夹住（999 → ≤200）', (await post('/api/balance', { games: 999 })).body.games === 200, '');
    // 带一份"改过数值"的卡池：跑的还是界面这份（不写盘）
    const pmod = JSON.parse(JSON.stringify(pool));
    pmod.treasure.find((c) => c.name === '补气丹').effects[0].value = 3;
    const bal2 = await post('/api/balance', { games: 2, cards: pmod });
    check('带 cards 也能跑（用界面上那份卡池）', bal2.body.ok === true, JSON.stringify(bal2.body && bal2.body.ok));
    check('★ 平衡试跑全程不写盘（副本字节未变）', sha(TMP) === bBal);
  }

  line('6. 拒绝写盘 ①：op 不在元数据表（幽灵效果）');
  const p3 = JSON.parse(JSON.stringify(written));
  p3.treasure.find((c) => c.name === '寒冰珠').effects[0].op = 'not_a_real_op';
  const b3 = sha(TMP);
  const s2 = await post('/api/save', { cards: p3 });
  check('拒绝写盘', s2.body.wrote === false && /已拒绝写盘/.test(s2.body.reason || ''));
  check('lint 退出码非 0 且原样点名非法 op', step(s2.body, '卡牌一致性体检 lint-cards.js').code === 1 && /op「not_a_real_op」不在元数据表里/.test(step(s2.body, '卡牌一致性体检 lint-cards.js').output));
  check('副本字节未变', sha(TMP) === b3);

  line('7. 拒绝写盘 ②：张数**非法**（牌堆自洽闸门）');
  // 张数现在可以随便改（总数不固定），但**不能是非法的**：必须是 ≥0 的整数。
  const p4 = JSON.parse(JSON.stringify(written));
  p4.treasure.find((c) => c.name === '寒冰珠').count = -1;
  const s3 = await post('/api/save', { cards: p4 });
  check('拒绝写盘（结构预检先拦下，后面的步骤根本没跑）',
    s3.body.wrote === false && !!step(s3.body, 'preflight') && step(s3.body, 'preflight').code === 1);
  // ⚠️ 负数张数在**结构预检**（第 0 步）就被拦下了，走不到第 3 步 —— 断言按实际拦它的那一步写，
  //    并额外确认"第 3 步只在数量自洽上把关"（下面那条合法改张数的用例会真的跑到第 3 步）。
  check('结构预检点名"张数不是非负数字"',
    step(s3.body, 'preflight').code === 1 && /count 不是非负数字/.test(step(s3.body, 'preflight').output),
    (step(s3.body, 'preflight').output || '').split('\n').filter((l) => /✗/.test(l))[0] || '');
  const p4b = JSON.parse(JSON.stringify(written));          // 合法改张数 → 必须放行（用户要的就是这个）
  p4b.treasure.find((c) => c.name === '寒冰珠').count = 5;
  const s3b = await post('/api/validate', { cards: p4b });
  check('合法改张数（4→5）不再被拦（总数不固定）', step(s3b.body, 'count').code === 0,
    (step(s3b.body, 'count').output || '').split('\n').slice(0, 2).join(' / '));
  check('副本字节未变', sha(TMP) === b3);

  line('8. 拒绝写盘 ③：结构坏（空堆 / id 重复 / 删掉 effects）');
  const p5 = JSON.parse(JSON.stringify(written)); p5.qi = [];
  const s4 = await post('/api/save', { cards: p5 });
  check('空牌堆被结构预检拦下', s4.body.wrote === false && /空的/.test(step(s4.body, 'preflight').output));
  const p6 = JSON.parse(JSON.stringify(written)); p6.qi[1].id = p6.qi[0].id;
  const s5 = await post('/api/save', { cards: p6 });
  check('id 重复被拦下', s5.body.wrote === false && /id 重复/.test(step(s5.body, 'preflight').output));
  const p7 = JSON.parse(JSON.stringify(written)); delete p7.treasure[0].effects;
  const s6 = await post('/api/save', { cards: p7 });
  check('删掉 effects 数组 → 第 2 步 verify-dsl 拦下', s6.body.wrote === false && step(s6.body, '卡牌一致性体检 lint-cards.js').code === 0 && step(s6.body, '效果 DSL 验收 verify-dsl.js').code === 1);
  check('副本字节未变', sha(TMP) === b3);

  line('8.5 拒绝写盘 ④：数值写成字符串 / 时点没接线（2026-10-02 新增的两道校验）');
  // 这两类错是用户实盘踩出来的，op 名/结构/张数都合法，两个校验器查不出来：
  //   · value:"-1"（字符串）→ 战力算成 "00-1" → 实战结算 NaN
  //   · event:'combatPlay' → EVENTS 表里有，但 engine.js 从不 fireTiming → 死效果
  const p8 = JSON.parse(JSON.stringify(written));
  p8.companion.find((c) => c.name === '蛮胡子').effects[1].value = '-1';
  const s8 = await post('/api/save', { cards: p8 });
  check('字符串数值被拦下（不写盘）', s8.body.wrote === false && step(s8.body, 'shape') && step(s8.body, 'shape').ok === false);
  check('点名"必须是数字"并说清 NaN 后果',
    /必须是\*\*数字\*\*/.test(step(s8.body, 'shape').output) && /NaN/.test(step(s8.body, 'shape').output),
    (step(s8.body, 'shape').output.split('\n')[0] || '').slice(0, 80));

  const p9 = JSON.parse(JSON.stringify(written));
  p9.treasure.find((c) => c.name === '虚天鼎 乾蓝冰焰').effects =
    [{ op: 'nullify_enemy_card', block: '法术牌/宝物牌', event: 'combatPlay', subject: 'foe' }];
  const s9 = await post('/api/save', { cards: p9 });
  check('引擎从不触发的时点被拦下', s9.body.wrote === false && /引擎从不触发/.test(step(s9.body, 'shape').output),
    (step(s9.body, 'shape').output.split('\n')[0] || '').slice(0, 80));
  check('副本字节未变（两次拒绝都没落盘）', sha(TMP) === b3);

  // ⚠️ 用 `manaRegen` 当样本（**会 fireTiming、但没接询问层**）。
  //    原来这里用 promote —— 2026-10-02 把 `promote · before` 接进询问层之后，
  //    promote 不再产生这条警告，这个断言就悄悄变成了假红（编辑器自测不在 run-all 里，没人发现）。
  const p10 = JSON.parse(JSON.stringify(written));
  p10.treasure.find((c) => c.name === '娑罗珠').effects =
    [{ op: 'promote_discount_once', value: 1, on: 'consume', event: 'manaRegen', subject: 'self' }];
  const v10 = await post('/api/validate', { cards: p10 });
  check('"会触发但没接询问层"（manaRegen）只警告、不拦保存',
    step(v10.body, 'shape').ok === true && /没接询问层/.test(step(v10.body, 'shape').output),
    step(v10.body, 'shape').output.split('\n').filter((l) => /⚠/.test(l))[0] || '(没有警告!)');
  check('真实卡池本身零误报（两道新校验不拦正常数据）',
    step((await post('/api/validate', { cards: written })).body, 'shape').ok === true);

  line('9. 备份上限 10 份（造 12 份假备份 + 一次真实保存）');
  for (let i = 0; i < 12; i++) {
    fs.writeFileSync(path.join(ROOT, 'data', '_editor-selftest.json.bak-editor-20200101-' + (100000 + i)), '{"fake":1}');
  }
  const beforeList = fs.readdirSync(path.join(ROOT, 'data')).filter((f) => f.startsWith('_editor-selftest.json.bak-editor-'));
  check('先有 ' + beforeList.length + ' 份备份', beforeList.length >= 13);
  const s7 = await post('/api/save', { cards: written });
  const afterList = fs.readdirSync(path.join(ROOT, 'data')).filter((f) => f.startsWith('_editor-selftest.json.bak-editor-'));
  check('保存成功', s7.body.wrote === true);
  check('备份恰好 10 份', afterList.length === 10, afterList.length + ' 份');
  check('删的是最旧的（20200101-100000..100003）', ['100000', '100001', '100002', '100003'].every((n) => !afterList.some((f) => f.endsWith(n))));
  check('刚写的备份在列表里', afterList.includes(s7.body.backup.file), s7.body.backup.file);

  line('10. 异步任务管道（POST /api/regression + 轮询）');
  const rg = await post('/api/regression', {});
  check('任务启动（返回 job id）', rg.status === 200 && !!rg.body.id, rg.body.cmd);
  let last = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 900));
    last = (await J('/api/regression?id=' + rg.body.id)).body;
    process.stdout.write('    轮询#' + (i + 1) + ' running=' + last.running + ' 收到 ' + (last.output || '').length + ' 字节\r');
    if (!last.running) break;
  }
  console.log('');
  check('任务跑完并带回退出码', last && last.running === false && last.code === 0, 'code=' + (last && last.code) + ' 耗时 ' + (last && (last.elapsedMs / 1000).toFixed(1)) + 's');
  check('输出被原样收上来', (last.output || '').length > 20, JSON.stringify((last.output || '').split('\n').filter(Boolean).slice(-1)[0] || ''));

  line('11. 收尾核对');
  check('★ data/cards.json sha 与开头一致', sha(REAL) === realBefore, realBefore + ' -> ' + sha(REAL));
  const changed = files.filter((f) => sha(path.join(ROOT, f)) !== before[f]);
  check('仓库其它文件（docs/server/public/tests/tools 校验器）都没被改', changed.length === 0, changed.join(',') || files.length + ' 个 sha 全一致');
  check('副本确实被改过（说明写盘真的生效了）', sha(TMP) !== tmpBefore);

  if (!KEEP) {
    fs.rmSync(TMP, { force: true });
    clearBaks();
    const left = fs.readdirSync(path.join(ROOT, 'data')).filter((f) => /^_editor-selftest/.test(f));
    check('自测副本与它的备份已清理', left.length === 0, left.join(', ') || 'data/ 干净');
  } else {
    console.log('  （--keep：保留 data/_editor-selftest.json 与备份，记得手动删）');
  }

  console.log('\n===== 自测结束：' + (fails ? '失败 ' + fails + ' 项' : '全部通过') + ' =====');
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('自测异常：', e && e.stack || e);
  process.exit(2);
});
