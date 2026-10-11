'use strict';
/**
 * 「选目标」新交互的**真浏览器**验证（2026-10-05 第 9 件）：
 *   【青冥针】"受伤时指定任意一位修士受到等额伤害"、【金魁】"使场上任意 1 张宝物/法术牌无效" ——
 *   这两张卡的动作必须在**发起前先选目标**，引擎侧由 `respondPlay` / `doActivate` 收 `target` / `targetUid`。
 *
 * 本测只管界面：
 *   ① 斗法弹窗里 needsTarget 的候选 → 点开弹**选人**层 → 选中一位修士 → 发出的动作带 target
 *   ② 主动技能里 needsTarget 的能力 → 点开弹**选牌**层 → 选中场上的一张牌 → 动作带 targetUid
 *   ③ 不需要选目标的候选/技能**照旧直接发**（不受影响，不能平白多一步）
 *   ④ 点「取消」不发任何动作；全程无页面异常
 *
 * 造局方式：真实开一局（HTTP 拿 token/state），再用 app.js 里的测试钩子
 * `window.__fanrenPreview(state, session)` 把"斗法窗口 / 主动技能"这几段状态喂给渲染层 ——
 * 真实对局里很难稳定复现这些局面（要抽到特定牌、还要恰好挨打）。
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
  // ---- 真实开一局，拿一份货真价实的 publicState（省得手搓一堆渲染要用的字段）
  const room = await api('POST', '/api/create', { name: '甲' });
  const foe = await api('POST', '/api/join', { roomId: room.roomId, name: '乙' });
  await api('POST', '/api/start', { roomId: room.roomId, playerId: room.playerId, token: room.token });
  await sleep(400);
  const state = await api('GET', '/api/state?roomId=' + room.roomId
    + '&playerId=' + encodeURIComponent(room.playerId) + '&token=' + room.token);
  check('拿到真实的 publicState', !!(state && state.players && state.players.length === 2),
    JSON.stringify(state && state.players && state.players.map((p) => p.name)));
  const session = { roomId: room.roomId, playerId: room.playerId, token: room.token, name: '甲' };
  const meId = room.playerId, foeId = foe.playerId;
  // ⚠️ publicState 里的 `turn` 是**玩家 id**（不是下标）—— 前端一律写 `st.turn === me.id`
  const ME_ID = meId;
  console.log('  房间', room.roomId, '| 甲 =', meId, '| 乙 =', foeId);

  // 两张卡的 id 直接从服务端卡池拿
  const pool = await api('GET', '/api/cards');
  const byName = (n) => [].concat(pool.treasure, pool.spell, pool.companion).find((c) => c.name === n);
  const NEEDLE = byName('青冥针'), JINKUI = byName('金魁'), BLADE = byName('黑血刀');
  check('卡池里能拿到【青冥针】【金魁】【黑血刀】', !!(NEEDLE && JINKUI && BLADE), '');

  const browser = await launch({ port: 9463 });
  const page = await newPage(browser, BASE + '/');
  await sleep(1500);

  // 抓"发出去的动作"：把 /api/action 拦下来（不真的打给服务端，免得状态被改）
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

  const inject = (patch) => page.evaluate(`(() => {
    var st = ${JSON.stringify(state)};
    Object.assign(st, ${JSON.stringify(patch)});
    return window.__fanrenPreview(st, ${JSON.stringify(session)});
  })()`);
  const captured = () => page.evaluate('window.__captured');
  const clearCap = () => page.evaluate('(window.__captured = [])');
  const q = (sel, prop) => page.evaluate(`(() => { var e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return null; return ${prop ? 'e.' + prop : '(e.textContent||"")'}; })()`);
  const txt = (sel) => page.evaluate(`(() => { var e = document.querySelector(${JSON.stringify(sel)});
    return e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() : null; })()`);
  const clickSel = (sel) => page.evaluate(`(() => { var e = document.querySelector(${JSON.stringify(sel)});
    if (!e) return 'NOELEM'; if (e.disabled) return 'DISABLED'; e.click(); return 'ok'; })()`);
  const clickPick = (i) => page.evaluate(`(() => { var b = document.querySelectorAll('.pick-opt')[${i || 0}];
    if (!b) return 'NOPICK'; b.click(); return b.textContent.replace(/\\s+/g,' ').trim(); })()`);

  // ================================================================ ① 斗法弹窗选人（【青冥针】）
  console.log('\n[①] 斗法弹窗：【青冥针】候选 → 弹选人层 → 动作带 target');
  await inject({
    turn: ME_ID, step: 'action', phase: 'playing',
    pending: {
      event: 'hurt', label: '受伤', actorName: '甲', queue: [meId], chain: [], amActor: true,
      mine: [{ uid: 4242, id: NEEDLE.id, name: '青冥针', deck: 'treasure', where: 'board', cost: 2, needsTarget: true, targetKind: 'player' }],
      about: { damage: 2, subjectId: meId, subjectName: '甲', pending: true, lethal: false },
    },
  });
  await sleep(500);
  const modalTxt = await txt('#pending-list');
  check('斗法弹窗列出了【青冥针】候选（带"需选目标"的说明）',
    !!modalTxt && /青冥针/.test(modalTxt) && /选择目标|需要选择/.test(modalTxt), String(modalTxt).slice(0, 120));
  check('点之前没有选择层', (await q('.pick-overlay')) === null, '');
  await clearCap();
  await clickSel('#pending-list .tier-opt');
  await sleep(300);
  check('点候选 → 弹出选择层', !!(await q('.pick-overlay')), '');
  const pickTxt = await txt('.pick-box');
  check('选择层里列出了可选的修士（乙）', !!pickTxt && /乙/.test(pickTxt), String(pickTxt).slice(0, 160));
  check('选择层没有直接发动作', (await captured()).length === 0, JSON.stringify(await captured()));
  await clickPick(0);
  await sleep(400);
  const act1 = (await captured())[0];
  check('选中目标 → 动作带 target（且 uid/tier 都在）',
    !!(act1 && act1.type === 'respond_play' && act1.uid === 4242 && String(act1.target) === String(foeId)),
    JSON.stringify(act1));
  check('选择层已关闭', (await q('.pick-overlay')) === null, '');
  await page.screenshot(OUT + '\\ui-target-pick-1.png');

  // 取消不发动作
  await clearCap();
  await clickSel('#pending-list .tier-opt');
  await sleep(250);
  await clickSel('.pick-cancel');
  await sleep(250);
  check('点「取消」→ 不发动作、选择层关闭',
    (await captured()).length === 0 && (await q('.pick-overlay')) === null, JSON.stringify(await captured()));

  // ================================================================ ② 主动技能选场上的牌（【金魁】）
  console.log('\n[②] 主动技能：【金魁】→ 弹选牌层 → 动作带 targetUid');
  const state2 = JSON.parse(JSON.stringify(state));
  state2.pending = null;
  state2.turn = ME_ID; state2.step = 'action';
  const meView = state2.players.find((p) => p.id === meId);
  const foeView = state2.players.find((p) => p.id === foeId);
  foeView.equip = [{ uid: 8888, id: BLADE.id, tier: 0 }];
  meView.activatables = [{
    uid: 7777, cardId: JINKUI.id, name: '金魁', discardSelf: true,
    needsTarget: true, targetKind: 'board',
    effects: [{ op: 'nullify_board_card', when: 'activate', label: '使场上任意一张宝物/法术牌无效' }],
  }];
  await page.evaluate(`(() => window.__fanrenPreview(${JSON.stringify(state2)}, ${JSON.stringify(session)}))()`);
  await sleep(500);
  const barTxt = await txt('#action-bar');
  check('行动栏出现「主动使用 · 金魁」', !!barTxt && /主动使用 · 金魁/.test(barTxt), String(barTxt).slice(0, 160));
  await clearCap();
  const clicked = await page.evaluate(`(() => {
    var b = [...document.querySelectorAll('#action-bar button')].find(function (x) { return /金魁/.test(x.textContent) && !x.disabled; });
    if (!b) return 'NOBTN'; b.click(); return 'ok'; })()`);
  check('点得动', clicked === 'ok', clicked);
  await sleep(300);
  const boardPick = await txt('.pick-box');
  check('弹出选牌层，列出乙场上的【黑血刀】', !!boardPick && /黑血刀/.test(boardPick), String(boardPick).slice(0, 160));
  check('选牌层没有直接发动作', (await captured()).length === 0, JSON.stringify(await captured()));
  await clickPick(0);
  await sleep(400);
  const act2 = (await captured())[0];
  check('选中那张牌 → 动作带 targetUid',
    !!(act2 && act2.type === 'activate' && act2.uid === 7777 && String(act2.targetUid) === '8888'),
    JSON.stringify(act2));
  await page.screenshot(OUT + '\\ui-target-pick-2.png');

  // ================================================================ ③ 不需要选目标的照旧
  console.log('\n[③] 不需要选目标的：照旧一步发出（不能平白多一层）');
  await inject({
    turn: ME_ID, step: 'action', phase: 'playing',
    pending: {
      event: 'hurt', label: '受伤', actorName: '甲', queue: [meId], chain: [], amActor: true,
      mine: [{ uid: 5151, id: NEEDLE.id, name: '测试·普通候选', deck: 'treasure', where: 'board', cost: 0 }],
      about: { damage: 1, subjectId: meId, subjectName: '甲', pending: true, lethal: false },
    },
  });
  await sleep(400);
  await clearCap();
  await clickSel('#pending-list .tier-opt');
  await sleep(350);
  const act3 = (await captured())[0];
  check('普通候选：点一下就发动作、不弹选择层',
    !!(act3 && act3.type === 'respond_play' && act3.uid === 5151) && (await q('.pick-overlay')) === null,
    JSON.stringify(act3));

  // ================================================================ ④ 页面健康度
  const errs = page.pageErrors.concat(page.consoleErrors.filter((e) => !/favicon/.test(e)));
  check('全程没有未捕获异常 / 控制台报错', errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  await browser.close();
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('冒烟本身崩了:', e && e.message); process.exit(1); });
