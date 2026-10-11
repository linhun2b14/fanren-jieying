'use strict';
// 「**同一个浏览器开两个窗口当两个玩家**」的回归 —— 用户 2026-10-06 报：
//   「战斗结算胜利时，双方都显示我方胜利」。
//
// 根因（不是结算代码写错，是**两个窗口其实是同一个座位**）：
//   会话只存在 `localStorage`（一个浏览器只有一份），所以
//     ① 窗口1 创建房间（localStorage = 甲）
//     ② 窗口2 加入房间（localStorage 被覆盖成 乙）
//     ③ 窗口1 一旦刷新/重连 → `Session.load()` 读到 **乙** → 窗口1 也变成乙
//   ⇒ 两个窗口是同一个玩家，谁赢都是「你赢了 / 你正获胜！」，自然"双方都显示我方胜利"。
//
// 修法：会话按**窗口**存（`sessionStorage` 为主，`localStorage` 只当"新窗口的兜底"），
//       再加一份"座位被哪个活窗口占着"的心跳 —— 新窗口不会去抢一个正在被使用的座位。
//
// 断言：① 两个窗口各自显示自己的道号；② **刷新窗口1 后它还是甲**（这条原来必挂）；
//       ③ 窗口2 不受影响；④ 再新开第三个窗口时它**不会**顶掉正在使用的座位（停在入席界面）。
const { launch, newPage, sleep } = require('./cdp');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';
const OUT = require('path').join(__dirname, ('..'), 'ref', 'shots');
const fs = require('fs');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

const setVal = (sel, v) => `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'NOELEM';
  e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`;
const click = (sel) => `(() => { const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return 'NOELEM';
  if(e.disabled) return 'DISABLED'; e.click(); return 'ok'; })()`;
const text = (sel) => `(() => { const e=document.querySelector(${JSON.stringify(sel)}); return e?e.textContent.trim():null; })()`;
/** 这一页现在是谁（牌桌右上角那个 chip）；不在牌桌上返回 null */
const who = (page) => page.evaluate(`(() => {
  const t = document.querySelector('#view-table');
  if (!t || t.classList.contains('hidden')) return null;
  const e = document.querySelector('#tb-me');
  return e ? e.textContent.trim() : null;
})()`);
/** 停在哪一屏（lobby / room / table / 其它） */
const view = (page) => page.evaluate(`(() => {
  for (const n of ['lobby','room','table']) {
    const e = document.querySelector('#view-' + n);
    if (e && !e.classList.contains('hidden')) return n;
  }
  return '?';
})()`);

(async () => {
  const browser = await launch({ port: 9381 });
  const p1 = await newPage(browser, BASE + '/');
  await sleep(1400);

  // ---- 窗口1：创建房间（甲）
  await p1.evaluate(setVal('#input-name', '甲'));
  await p1.evaluate(click('#btn-create'));
  await sleep(1200);
  const code = String(await p1.evaluate(text('#room-code'))).trim();
  check('窗口1 开好房间', /^[A-Z0-9]{4}$/.test(code), code);

  // ---- 窗口2：同一个浏览器里的第二个窗口，加入房间（乙）
  const p2 = await newPage(browser, BASE + '/');
  await sleep(1200);
  await p2.evaluate(setVal('#input-name', '乙'));
  await p2.evaluate(setVal('#input-room', code));
  await p2.evaluate(click('#btn-join'));
  await sleep(1300);
  check('窗口2 加入成功（还在房间界面）', (await view(p2)) === 'room', await view(p2));

  // ---- 第三个窗口（新标签）：不该稀里糊涂接管一个正在使用的座位
  const p3 = await newPage(browser, BASE + '/');
  await sleep(2000);
  const v3 = await view(p3), n3 = await who(p3);
  console.log('  窗口3 =', v3, n3);
  check('新窗口不会顶掉正在使用的座位（停在入席界面）', v3 === 'lobby', JSON.stringify([v3, n3]));
  const notice = await p3.evaluate(text('#lobby-notice'));
  check('新窗口把话说清楚了（提示"另一个窗口正坐着这个座位"）',
    /另一个窗口/.test(String(notice)) && /甲|乙/.test(String(notice)), String(notice).slice(0, 80));
  // 新窗口照旧可以自己加入当第三个玩家（房间还没开局）
  await p3.evaluate(setVal('#input-name', '丙'));
  await p3.evaluate(setVal('#input-room', code));
  await p3.evaluate(click('#btn-join'));
  await sleep(1300);
  check('新窗口能自己加入当第三个玩家', (await view(p3)) === 'room', await view(p3));

  // ---- ★ 核心：刷新窗口1 —— 它必须还是「甲」，不能变成窗口2/3 的座位
  await p1.evaluate(click('#btn-start'));
  await sleep(2200);
  check('开局后三个窗口都在牌桌上',
    (await view(p1)) === 'table' && (await view(p2)) === 'table' && (await view(p3)) === 'table',
    JSON.stringify([await view(p1), await view(p2), await view(p3)]));
  const names = [await who(p1), await who(p2), await who(p3)];
  console.log('  三个窗口 =', names.join(' / '));
  check('三个窗口分别是「甲 / 乙 / 丙」', names[0] === '甲' && names[1] === '乙' && names[2] === '丙',
    JSON.stringify(names));

  await p1.send('Page.reload');
  await sleep(2600);
  const n1b = await who(p1);
  console.log('  刷新后 窗口1 =', n1b);
  check('★ 刷新窗口1 后它还是「甲」（不是被别人窗口的座位顶掉）', n1b === '甲', String(n1b));
  check('刷新不影响窗口2 / 窗口3',
    (await who(p2)) === '乙' && (await who(p3)) === '丙',
    JSON.stringify([await who(p2), await who(p3)]));

  await p1.screenshot(OUT + '\\ui-two-windows-1.png');
  await p2.screenshot(OUT + '\\ui-two-windows-2.png');
  await p3.screenshot(OUT + '\\ui-two-windows-3.png');

  const errs = [...p1.pageErrors, ...p2.pageErrors, ...p3.pageErrors];
  check('全程没有页面异常', errs.length === 0, errs.slice(0, 2).join(' | '));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('UI TWO-WINDOWS FAIL:', e && e.message || e); process.exit(1); });
