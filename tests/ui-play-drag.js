'use strict';
/**
 * ②c 的真浏览器验证（2026-10-05 第 10 件）：
 *   ① **手牌拖到牌桌才打出**：拖起来 → 丢到牌桌上 = 打出（发 `{type:'play', uid}`）；
 *      丢回自己的手牌区 = 取消（不发动作）；**点击照旧能打**（移动端与无障碍靠它）。
 *   ② **舍弃类效果的醒目确认**：发动带"弃牌代价"的主动技能（【龙纹四象蟠龙带】）时，
 *      先弹 ⚠ 确认层、**让玩家自己挑哪一张**被弃掉，再发 `{type:'activate', uid, discardUid}`。
 *   ③ 全程无页面异常。
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
  const foe = await api('POST', '/api/join', { roomId: room.roomId, name: '乙' });
  await api('POST', '/api/start', { roomId: room.roomId, playerId: room.playerId, token: room.token });
  await sleep(400);
  const state = await api('GET', '/api/state?roomId=' + room.roomId
    + '&playerId=' + encodeURIComponent(room.playerId) + '&token=' + room.token);
  const session = { roomId: room.roomId, playerId: room.playerId, token: room.token, name: '甲' };
  const meId = room.playerId;
  const pool = await api('GET', '/api/cards');
  const byName = (n) => [].concat(pool.treasure, pool.spell, pool.companion).find((c) => c.name === n);
  const PILL = byName('补气丹'), BELT = byName('龙纹四象蟠龙带'), BLADE = byName('黑血刀'), SWORD = byName('青竹蜂云剑');
  check('卡池里拿到【补气丹】【龙纹四象蟠龙带】【黑血刀】【青竹蜂云剑】',
    !!(PILL && BELT && BLADE && SWORD), '');

  const browser = await launch({ port: 9465 });
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

  const captured = () => page.evaluate('window.__captured');
  const clearCap = () => page.evaluate('(window.__captured = [])');
  const txt = (sel) => page.evaluate(`(() => { var e = document.querySelector(${JSON.stringify(sel)});
    return e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() : null; })()`);
  const has = (sel) => page.evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);

  // ---- 造一个"轮到我在行动阶段、手里有一张打得出的牌"的局面
  const st1 = JSON.parse(JSON.stringify(state));
  st1.pending = null; st1.combat = null; st1.turn = meId; st1.step = 'action'; st1.phase = 'playing';
  st1.turnFlags = { combat: false, promote: false };
  const me1 = st1.players.find((p) => p.id === meId);
  me1.realm = 2; me1.mana = 12; me1.hp = 6; me1.qi = 20; me1.qiCards = me1.qiCards || [];
  me1.hand = [{ uid: 5001, id: PILL.id }];
  me1.activatables = [];
  await page.evaluate(`(() => window.__fanrenPreview(${JSON.stringify(st1)}, ${JSON.stringify(session)}))()`);
  await sleep(500);
  check('手牌区渲染出【补气丹】且标成"打得出去"',
    (await has('#hand-zone .hand-card.is-playable')), String(await txt('#hand-zone')));

  // ================================================================ ① 拖到牌桌 = 打出
  console.log('\n[①] 手牌拖到牌桌才打出');
  await clearCap();
  const dragTo = (targetSel) => page.evaluate(`(() => {
    var card = document.querySelector('#hand-zone .hand-card');
    var target = document.querySelector(${JSON.stringify(targetSel)});
    if (!card || !target) return 'NOELEM';
    var dt = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return 'ok';
  })()`);
  const r1 = await dragTo('#view-table .table-main');
  await sleep(500);
  const act1 = (await captured())[0];
  check('拖起来时牌桌高亮（dragstart 生效）', r1 === 'ok', r1);
  check('丢在牌桌上 → 打出（动作带 uid）',
    !!(act1 && act1.type === 'play' && String(act1.uid) === '5001'), JSON.stringify(act1));
  await page.screenshot(OUT + '\\ui-drag-play.png');

  // 丢回自己的手牌区 = 取消
  await clearCap();
  await dragTo('#hand-zone');
  await sleep(400);
  check('丢回自己的手牌区 → 不发动作（取消）', (await captured()).length === 0, JSON.stringify(await captured()));

  // 点击照旧能打（移动端/无障碍路径不能坏）
  await clearCap();
  await page.evaluate(`(() => { var c = document.querySelector('#hand-zone .hand-card'); if (!c) return 'NOELEM'; c.click(); return 'ok'; })()`);
  await sleep(400);
  const act3 = (await captured())[0];
  check('点击手牌照旧能打出（回归）', !!(act3 && act3.type === 'play' && String(act3.uid) === '5001'), JSON.stringify(act3));

  // ================================================================ ② 舍弃类代价的醒目确认
  console.log('\n[②] 舍弃类效果：⚠ 确认 + 自己挑弃哪一张');
  const st2 = JSON.parse(JSON.stringify(st1));
  const me2 = st2.players.find((p) => p.id === meId);
  me2.hand = [{ uid: 5001, id: PILL.id }, { uid: 5002, id: BLADE.id }, { uid: 5003, id: SWORD.id }];
  me2.equip = [{ uid: 7777, id: BELT.id, tier: 0 }];
  me2.mana = 1;
  me2.activatables = [{
    uid: 7777, cardId: BELT.id, name: '龙纹四象蟠龙带', discardSelf: false,
    costDiscard: 'treasure',
    discardChoices: [
      { uid: 5002, id: BLADE.id, name: '黑血刀' },
      { uid: 5003, id: SWORD.id, name: '青竹蜂云剑' },
      { uid: 5001, id: PILL.id, name: '补气丹' },
    ],
    effects: [{ op: 'mana', value: 2, label: '恢复法力值 2' }],
  }];
  await page.evaluate(`(() => window.__fanrenPreview(${JSON.stringify(st2)}, ${JSON.stringify(session)}))()`);
  await sleep(500);
  await clearCap();
  const stepped = await page.evaluate(`(() => {
    var b = [...document.querySelectorAll('#action-bar button')].find(function (x) { return /龙纹四象蟠龙带/.test(x.textContent) && !x.disabled; });
    if (!b) return 'NOBTN'; b.click(); return 'ok'; })()`);
  check('行动栏里有「主动使用 · 龙纹四象蟠龙带」且点得动', stepped === 'ok', stepped);
  await sleep(350);
  const warn = await txt('.pick-box');
  check('先弹 ⚠ 确认层（写明这是一次舍弃、哪些牌会被弃掉）',
    !!warn && /弃置 1 张宝物牌/.test(warn) && /舍弃/.test(warn) && /黑血刀/.test(warn), String(warn).slice(0, 180));
  check('确认层里没有直接发动作', (await captured()).length === 0, JSON.stringify(await captured()));
  check('每个候选都写明了"将被放入弃牌堆"', /将被放入弃牌堆/.test(String(warn)), '');
  // 挑第 2 张（【青竹蜂云剑】）→ 动作带 discardUid
  const picked = await page.evaluate(`(() => { var b = document.querySelectorAll('.pick-opt')[1]; if (!b) return 'NOPICK'; b.click(); return b.textContent.replace(/\\s+/g,' ').trim(); })()`);
  await sleep(450);
  const act4 = (await captured())[0];
  check('选中后发出的动作带 discardUid（＝我挑的那张）',
    !!(act4 && act4.type === 'activate' && String(act4.uid) === '7777' && String(act4.discardUid) === '5003'),
    JSON.stringify({ picked: picked, act: act4 }));
  check('确认层已关闭', !(await has('.pick-overlay')), '');
  await page.screenshot(OUT + '\\ui-discard-confirm.png');

  // ================================================================ ③ 页面健康度
  const errs = page.pageErrors.concat(page.consoleErrors.filter((e) => !/favicon/.test(e)));
  check('全程没有未捕获异常 / 控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  await browser.close();
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('冒烟本身崩了:', e && e.message); process.exit(1); });
