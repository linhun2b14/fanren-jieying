'use strict';
/**
 * 手牌悬停放大镜的真浏览器验证（2026-10-05 用户要的："鼠标指到哪张牌哪张就放大，牌面字太小看不清"）。
 *
 * 要点：
 *   ① 指到一张手牌 → 上方弹出这张牌的**高清大图**（卡面详情，字号放大一档）；
 *   ② 指到另一张 → 内容跟着换（不是叠一堆）；
 *   ③ 移出手牌区 / 手牌重绘 → 收起；
 *   ④ 浮层 `pointer-events:none` —— **点击照旧能打出**（放大镜不能挡操作）；
 *   ⑤ 位置：卡片上方、夹在视口内；
 *   ⑥ 全程无页面异常。
 *
 * 造局：真实开一局拿 publicState，再用 `window.__fanrenPreview(state, session)` 喂给渲染层。
 */
const { launch, newPage, sleep } = require('./cdp');
const http = require('http');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';
const OUT = require('path').join(__dirname, ('..'), 'ref', 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(BASE + path);
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { resolve(b); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  const room = await api('POST', '/api/create', { name: '甲' });
  await api('POST', '/api/join', { roomId: room.roomId, name: '乙' });
  await api('POST', '/api/start', { roomId: room.roomId, playerId: room.playerId, token: room.token });
  await sleep(400);
  const state = await api('GET', '/api/state?roomId=' + room.roomId
    + '&playerId=' + encodeURIComponent(room.playerId) + '&token=' + room.token);
  const session = { roomId: room.roomId, playerId: room.playerId, token: room.token, name: '甲' };
  const meId = room.playerId;
  const pool = await api('GET', '/api/cards');
  const byName = (n) => [].concat(pool.treasure, pool.spell, pool.companion).find((c) => c.name === n);
  const A = byName('禁神牌'), B = byName('换形诀');
  check('卡池里拿到两张字多的牌（【禁神牌】【换形诀】）', !!(A && B), '');

  const browser = await launch({ port: 9467 });
  const page = await newPage(browser, BASE + '/');
  await sleep(1500);
  await page.evaluate(`(() => {
    window.__captured = [];
    var of = window.fetch;
    window.fetch = function (u, o) {
      try {
        if (String(u).indexOf('/api/action') >= 0 && o && o.body) {
          window.__captured.push(JSON.parse(o.body).action);
          return Promise.resolve(new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
      } catch (e) {}
      return of.apply(this, arguments);
    };
    return 'ok';
  })()`);

  const st = JSON.parse(JSON.stringify(state));
  st.pending = null; st.combat = null; st.turn = meId; st.step = 'action'; st.phase = 'playing';
  st.turnFlags = { combat: false, promote: false };
  const me = st.players.find((p) => p.id === meId);
  me.realm = 2; me.mana = 12; me.hp = 6; me.qi = 20;
  me.hand = [{ uid: 61001, id: A.id }, { uid: 61002, id: B.id }];
  me.activatables = [];
  await page.evaluate(`(() => window.__fanrenPreview(${JSON.stringify(st)}, ${JSON.stringify(session)}))()`);
  await sleep(600);

  const txt = (sel) => page.evaluate(`(() => { var e = document.querySelector(${JSON.stringify(sel)});
    return e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() : null; })()`);
  const hidden = (sel) => page.evaluate(`(() => { var e = document.querySelector(${JSON.stringify(sel)});
    return !e || e.classList.contains('hidden') || e.getBoundingClientRect().height === 0; })()`);
  const hover = (i) => page.evaluate(`(() => {
    var cards = document.querySelectorAll('#hand-zone .hand-card');
    var c = cards[${i}]; if (!c) return 'NOCARD';
    c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return c.querySelector('.hc-name').textContent; })()`);
  const leave = () => page.evaluate(`(() => {
    document.querySelector('#hand-zone').dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    return 'ok'; })()`);

  check('手牌渲染出两张', (await page.evaluate(`document.querySelectorAll('#hand-zone .hand-card').length`)) === 2, '');
  check('一开始没有放大镜', await hidden('#hand-zoom'), '');

  // ① 指到第一张
  console.log('\n[①] 指到哪张放大哪张');
  const first = await hover(0);
  await sleep(500);                      // 80ms 防抖 + 渲染
  check('指到第一张后放大镜出现', !(await hidden('#hand-zoom')), '');
  const z1 = await txt('#hand-zoom');
  check(`放大镜里是这张牌（【${first}】）`, !!z1 && z1.indexOf(String(first)) >= 0, String(z1).slice(0, 120));
  check('放大镜里带了卡面正文（不是只有名字）', !!z1 && /法力|回合|使用/.test(z1), String(z1).slice(0, 160));
  check('放大镜里提示可以点/拖到牌桌', !!z1 && /拖到牌桌/.test(z1), '');
  const geom = await page.evaluate(`(() => {
    var z = document.querySelector('#hand-zoom').getBoundingClientRect();
    var c = document.querySelector('#hand-zone .hand-card').getBoundingClientRect();
    return { above: z.bottom <= c.top + 2, inView: z.left >= 0 && z.right <= window.innerWidth + 1 && z.top >= 0,
      w: Math.round(z.width), h: Math.round(z.height) }; })()`);
  check('放大镜摆在卡片**上方**、且在视口内', geom.above && geom.inView, JSON.stringify(geom));
  check('放大镜够大（>=320px 宽）', geom.w >= 320, JSON.stringify(geom));
  const pe = await page.evaluate(`getComputedStyle(document.querySelector('#hand-zoom')).pointerEvents`);
  check('浮层 pointer-events:none（不挡点击/拖拽）', pe === 'none', String(pe));
  const lifted = await page.evaluate(`document.querySelectorAll('#hand-zone .hand-card.hover-zoom').length`);
  check('被指的那张牌自己也抬起来了（.hover-zoom）', lifted === 1, String(lifted));
  await page.screenshot(OUT + '\\ui-hand-zoom.png');

  // ② 换一张
  console.log('\n[②] 换一张牌');
  const second = await hover(1);
  await sleep(500);
  const z2 = await txt('#hand-zoom');
  check(`内容换成第二张（【${second}】）`, !!z2 && z2.indexOf(String(second)) >= 0 && (!first || z2.indexOf(String(first)) < 0),
    String(z2).slice(0, 120));
  check('同时只有一个放大镜', (await page.evaluate(`document.querySelectorAll('#hand-zoom').length`)) === 1, '');

  // ③ 移出手牌区 → 收起
  console.log('\n[③] 移出就收');
  await leave();
  await sleep(300);
  check('移出手牌区后收起', await hidden('#hand-zoom'), '');
  check('抬起来的样式也一并去掉', (await page.evaluate(`document.querySelectorAll('.hover-zoom').length`)) === 0, '');

  // ④ 放大镜开着时，点击照旧能打出
  console.log('\n[④] 不挡操作');
  await hover(0);
  await sleep(400);
  await page.evaluate('(window.__captured = [])');
  await page.evaluate(`(() => { var c = document.querySelector('#hand-zone .hand-card'); c.click(); return 'ok'; })()`);
  await sleep(400);
  const act = (await page.evaluate('window.__captured'))[0];
  check('点手牌照旧打出（放大镜没吞掉点击）', !!(act && act.type === 'play' && String(act.uid) === '61001'), JSON.stringify(act));
  check('点完放大镜自动收起', await hidden('#hand-zoom'), '');

  // ⑤ 手牌重绘 → 收起（免得显示已经不存在的牌）
  await hover(0);
  await sleep(400);
  check('重新指出来（准备验重绘）', !(await hidden('#hand-zoom')), '');
  const st2 = JSON.parse(JSON.stringify(st));
  st2.players.find((p) => p.id === meId).hand = [{ uid: 62001, id: B.id }];
  await page.evaluate(`(() => window.__fanrenPreview(${JSON.stringify(st2)}, ${JSON.stringify(session)}))()`);
  await sleep(400);
  check('手牌一变（重绘）放大镜自动收起', await hidden('#hand-zoom'), '');

  const errs = page.pageErrors.concat(page.consoleErrors.filter((e) => !/favicon/.test(e)));
  check('全程没有未捕获异常 / 控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  await browser.close();
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('冒烟本身崩了:', e && e.message); process.exit(1); });
