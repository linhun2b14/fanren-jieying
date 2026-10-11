'use strict';
// 真浏览器全流程：两个独立 Edge 实例当两名玩家，从大厅一路打到牌桌并出一手牌。
const { launch, newPage, sleep } = require('./cdp');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';
const OUT = require('path').join(__dirname, ('..'), 'ref', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const setVal = (sel, v) => `(() => { const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return 'NOELEM ' + ${JSON.stringify(sel)};
  e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input', {bubbles:true})); return 'ok'; })()`;
const click = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return 'NOELEM ' + ${JSON.stringify(sel)};
  if (e.disabled) return 'DISABLED ' + ${JSON.stringify(sel)};
  e.click(); return 'ok'; })()`;
const text = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? e.textContent.trim() : null; })()`;
const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)});
  if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.classList.contains('hidden'); })()`;

function errs(tag, page) {
  if (page.pageErrors.length || page.consoleErrors.length) {
    console.log(`  [${tag}] 页面异常 ${page.pageErrors.length} / 控制台 ${page.consoleErrors.length}`);
    page.pageErrors.slice(0, 3).forEach((e) => console.log('    ! ' + String(e).split('\n')[0]));
    page.consoleErrors.filter((e) => !e.includes('favicon')).slice(0, 3).forEach((e) => console.log('    ! ' + e));
  } else {
    console.log(`  [${tag}] 无 JS 报错`);
  }
}

(async () => {
  const b1 = await launch({ port: 9341 });
  const b2 = await launch({ port: 9342 });
  console.log('两个浏览器就绪:', b1.version, '/', b2.version);

  const host = await newPage(b1, BASE + '/');
  const guest = await newPage(b2, BASE + '/');
  await sleep(1500);

  // ---- 1. 建房 ----
  console.log('\n[1] 房主建房');
  console.log('  昵称:', await host.evaluate(setVal('#input-name', '韩立')));
  await sleep(200);
  console.log('  点创建:', await host.evaluate(click('#btn-create')));
  await sleep(1200);
  const code = await host.evaluate(text('#room-code'));
  console.log('  房间码:', JSON.stringify(code));
  if (!code || !/^[A-Z0-9]{4}$/.test(String(code).trim())) {
    await host.screenshot(OUT + '\\fail-create.png');
    throw new Error('建房失败，房间码异常');
  }
  const room = String(code).trim();
  await host.screenshot(OUT + '\\02-room-host.png');

  // ---- 2. 加入 ----
  console.log('\n[2] 客人凭码加入');
  console.log('  昵称:', await guest.evaluate(setVal('#input-name', '南宫婉')));
  await sleep(200);
  console.log('  房号:', await guest.evaluate(setVal('#input-room', room)));
  await sleep(200);
  console.log('  点加入:', await guest.evaluate(click('#btn-join')));
  await sleep(1500);
  console.log('  客人是否在房间视图:', await guest.evaluate(visible('#view-room')));
  const seats = await guest.evaluate(text('#room-seats'));
  console.log('  座位列表:', JSON.stringify(seats));
  await guest.screenshot(OUT + '\\03-room-guest.png');

  // 房主那边应通过 SSE 看到第二个座位
  await sleep(1000);
  const hostSeats = await host.evaluate(text('#room-seats'));
  console.log('  房主看到的座位:', JSON.stringify(hostSeats));
  const hostSeesGuest = String(hostSeats || '').includes('南宫婉');
  console.log('  SSE 同步座位:', hostSeesGuest ? 'OK' : '失败');

  // ---- 3. 开局 ----
  console.log('\n[3] 房主开局');
  const startState = await host.evaluate(`(() => { const b = document.querySelector('#btn-start'); return b ? { disabled: b.disabled, text: b.textContent.trim() } : null; })()`);
  console.log('  开局按钮:', JSON.stringify(startState));
  console.log('  点开始:', await host.evaluate(click('#btn-start')));
  await sleep(2000);
  console.log('  房主进入牌桌:', await host.evaluate(visible('#view-table')));
  await sleep(1500);
  console.log('  客人进入牌桌:', await guest.evaluate(visible('#view-table')));

  // ---- 4. 牌桌信息 ----
  const board = await host.evaluate(`(() => ({
    round: (document.querySelector('#tb-round')||{}).textContent,
    turn: (document.querySelector('#tb-turn')||{}).textContent,
    me: (document.querySelector('#tb-me')||{}).textContent,
    conn: (document.querySelector('#tb-conn')||{}).textContent,
    piles: (document.querySelector('#tb-piles')||{}).textContent,
    playerCards: [...document.querySelectorAll('#foe-grid > *, #me-grid > *')].map(e => e.textContent.replace(/\\s+/g,' ').trim().slice(0,120)),
    layout: (() => { const f=document.querySelector('#foe-row'), m=document.querySelector('#me-row');
      if(!f||!m) return 'NO_LAYOUT_NODES';
      return { foeTop: Math.round(f.getBoundingClientRect().top), meTop: Math.round(m.getBoundingClientRect().top) }; })(),
    handMeta: (document.querySelector('#hand-meta')||{}).textContent,
    handCards: [...document.querySelectorAll('#hand-zone > *')].map(e => e.textContent.replace(/\\s+/g,' ').trim().slice(0,60)),
    actionButtons: [...document.querySelectorAll('#action-bar button')].map(b => ({ t: b.textContent.trim(), dis: b.disabled })),
  }))()`);
  console.log('  轮次:', board.round, '| 当前:', board.turn);
  console.log('  牌堆:', board.piles);
  console.log('  手牌区:', JSON.stringify(board.handMeta));
  console.log('  我方手牌数:', board.handCards.length, board.handCards.slice(0, 4));
  console.log('  可用操作:', JSON.stringify(board.actionButtons));
  await host.screenshot(OUT + '\\04-table-host.png');
  await guest.screenshot(OUT + '\\05-table-guest.png');

  errs('房主', host);
  errs('客人', guest);

  // ---- 5. 出一手牌 ----
  console.log('\n[5] 房主执行一次操作');
  const acted = await host.evaluate(`(() => {
    const bar = document.querySelector('#action-bar');
    const btns = [...bar.querySelectorAll('button')].filter(b => !b.disabled);
    if (!btns.length) return 'NO_ENABLED_BUTTON';
    const b = btns.find(x => /抽|法术|同行者|探索/.test(x.textContent)) || btns[0];
    const label = b.textContent.trim(); b.click(); return label;
  })()`);
  console.log('  点击了:', JSON.stringify(acted));
  await sleep(1800);

  const after = await host.evaluate(`(() => ({
    handMeta: (document.querySelector('#hand-meta')||{}).textContent,
    actionButtons: [...document.querySelectorAll('#action-bar button')].map(b => ({ t: b.textContent.trim(), dis: b.disabled })),
    logLines: [...document.querySelectorAll('#log-list > *')].map(e => e.textContent.replace(/\\s+/g,' ').trim()).slice(-6),
  }))()`);
  console.log('  操作后手牌区:', JSON.stringify(after.handMeta));
  console.log('  操作后按钮:', JSON.stringify(after.actionButtons));
  console.log('  战报尾部:');
  after.logLines.forEach((l) => console.log('    · ' + l.slice(0, 110)));
  await host.screenshot(OUT + '\\06-after-action.png');

  errs('房主', host);
  errs('客人', guest);

  console.log('\nUI FLOW PASS');
  await b1.close(); await b2.close();
})().catch(async (e) => { console.error('\nUI FLOW FAIL:', e.message); process.exit(1); });
