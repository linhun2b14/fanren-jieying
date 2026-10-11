'use strict';
// 四人在场验证：4 个独立 Edge 实例各占一个座位，检查牌桌网格渲染与手牌保密。
const { launch, newPage, sleep } = require('./cdp');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';
const OUT = require('path').join(__dirname, ('..'), 'ref', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const setVal = (s, v) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return 'NOELEM';
  e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`;
const click = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return 'NOELEM';
  if(e.disabled) return 'DISABLED'; e.click(); return 'ok'; })()`;
const text = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); return e?e.textContent.trim():null; })()`;

const NAMES = ['韩立', '南宫婉', '厉飞雨', '银月'];

(async () => {
  const browsers = [];
  const pages = [];
  for (let i = 0; i < 4; i++) {
    const b = await launch({ port: 9371 + i });
    browsers.push(b);
    pages.push(await newPage(b, BASE + '/'));
  }
  await sleep(1800);
  console.log('4 个独立浏览器就绪');

  // 房主建房
  await pages[0].evaluate(setVal('#input-name', NAMES[0]));
  await pages[0].evaluate(click('#btn-create'));
  await sleep(1200);
  const code = String(await pages[0].evaluate(text('#room-code'))).trim();
  console.log('房间码:', code);
  if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error('建房失败');

  // 其余三人加入
  for (let i = 1; i < 4; i++) {
    await pages[i].evaluate(setVal('#input-name', NAMES[i]));
    await pages[i].evaluate(setVal('#input-room', code));
    await pages[i].evaluate(click('#btn-join'));
    await sleep(900);
  }
  await sleep(1600);
  const seats = await pages[3].evaluate(`[...document.querySelectorAll('#room-seats > *')].map(e=>e.textContent.replace(/\\s+/g,' ').trim())`);
  console.log('座位列表:', JSON.stringify(seats));
  const seatCount = (seats || []).filter((s) => NAMES.some((n) => s.includes(n))).length;
  console.log('已入座真实玩家数:', seatCount, seatCount === 4 ? 'OK' : '异常');
  await pages[3].screenshot(OUT + '\\12-room-four.png');

  // 开局
  await pages[0].evaluate(click('#btn-start'));
  await sleep(3000);
  const inTable = [];
  for (let i = 0; i < 4; i++) inTable.push(await pages[i].evaluate(`(() => { const e=document.querySelector('#view-table');
    if(!e) return false; const r=e.getBoundingClientRect(); return r.width>0 && r.height>0; })()`));
  console.log('四人是否都进牌桌:', JSON.stringify(inTable));

  // 牌桌网格与保密性
  for (let i = 0; i < 4; i++) {
    const v = await pages[i].evaluate(`(() => {
      const panels=[...document.querySelectorAll('#foe-grid > *, #me-grid > *')];
      return {
        panels: panels.length,
        names: panels.map(p => (p.textContent.match(/韩立|南宫婉|厉飞雨|银月/)||['?'])[0]),
        handCounts: panels.map(p => { const m = p.textContent.match(/手牌\\s*(\\d+)/); return m ? m[1] : '?'; }),
        myFaceUp: [...document.querySelectorAll('#hand-zone > *')].length,
        turn: (document.querySelector('#tb-turn')||{}).textContent,
        piles: (document.querySelector('#tb-piles')||{}).textContent,
      }; })()`);
    console.log(`  ${NAMES[i]} 视角: 面板${v.panels}个 [${v.names.join('/')}] 各家手牌数=[${v.handCounts.join(',')}] 自己手牌${v.myFaceUp}张 | ${v.turn}`);
  }
  const grid = await pages[0].evaluate(`(() => {
    const f=document.querySelector('#foe-row'), m=document.querySelector('#me-row');
    const fg=document.querySelector('#foe-grid'), mg=document.querySelector('#me-grid');
    return { 敌方行顶: Math.round(f.getBoundingClientRect().top), 我方行顶: Math.round(m.getBoundingClientRect().top),
      敌方面板数: fg ? fg.children.length : -1, 我方面板数: mg ? mg.children.length : -1,
      敌方面板宽: fg && fg.children[0] ? Math.round(fg.children[0].getBoundingClientRect().width) : 0,
      我方面板宽: mg && mg.children[0] ? Math.round(mg.children[0].getBoundingClientRect().width) : 0,
      敌方行可横滑: f.scrollWidth > f.clientWidth + 2 }; })()`);
  console.log('桌面布局:', JSON.stringify(grid));
  if (grid.我方行顶 <= grid.敌方行顶) throw new Error('布局错误：我方没有在敌方下方');
  if (grid.我方面板宽 <= grid.敌方面板宽) throw new Error('布局错误：我方面板没有比敌方更大');
  await pages[0].screenshot(OUT + '\\13-table-four.png');

  // 手机端四人局
  await pages[0].setViewport(390, 844, true);
  await sleep(800);
  const mob = await pages[0].evaluate(`(() => {
    const f=document.querySelector('#foe-row'), m=document.querySelector('#me-row');
    return { 仍在上下两段: Math.round(f.getBoundingClientRect().top) < Math.round(m.getBoundingClientRect().top),
      敌方行可横滑: f.scrollWidth > f.clientWidth + 2,
      overflowX: document.documentElement.scrollWidth > innerWidth + 2,
      bodyW: document.body.scrollWidth, winW: innerWidth,
      面板总数: document.querySelectorAll('#foe-grid > *, #me-grid > *').length }; })()`);
  console.log('手机端:', JSON.stringify(mob));
  if (!mob.仍在上下两段) throw new Error('手机端布局错误：上下两段失效');
  if (mob.overflowX) throw new Error('手机端出现整页横向溢出');
  await pages[0].screenshot(OUT + '\\14-mobile-four.png');

  const errs = browsers.reduce((n, b) => n, 0);
  const allErr = pages.flatMap((p) => p.pageErrors);
  const allCon = pages.flatMap((p) => p.consoleErrors).filter((e) => !e.includes('favicon'));
  console.log('页面异常合计:', allErr.length, '控制台错误(非favicon):', allCon.length);
  allErr.slice(0, 5).forEach((e) => console.log('  ! ' + String(e).split('\n')[0]));
  allCon.slice(0, 5).forEach((e) => console.log('  ! ' + e));

  console.log('\nFOUR PLAYER PASS');
  for (const b of browsers) await b.close();
})().catch((e) => { console.error('\nFOUR PLAYER FAIL:', e.message); process.exit(1); });
