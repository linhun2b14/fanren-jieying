'use strict';
// 真浏览器首屏探测：打开页面 → 抓截图 → 收集 id/可见文案/JS 报错。
const { launch, newPage, sleep } = require('./cdp');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';
const OUT = require('path').join(__dirname, ('..'), 'ref', 'shots');
require('fs').mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await launch({ port: 9333 });
  console.log('浏览器:', browser.version);
  const page = await newPage(browser, BASE + '/');
  await sleep(1200);

  const info = await page.evaluate(`(() => {
    const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
    const visible = [...document.querySelectorAll('body *')].filter(e => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && e.children.length === 0 && e.textContent.trim();
    }).map(e => e.textContent.trim()).slice(0, 60);
    return {
      title: document.title,
      bodySize: [document.body.scrollWidth, document.body.scrollHeight],
      idCount: ids.length,
      ids: ids.slice(0, 80),
      visibleText: visible,
      hasStyle: !!document.querySelector('link[rel=stylesheet]'),
      styleLoaded: getComputedStyle(document.body).backgroundColor,
      buttons: [...document.querySelectorAll('button')].map(b => ({ id: b.id, text: b.textContent.trim(), visible: b.getBoundingClientRect().width > 0 })),
      inputs: [...document.querySelectorAll('input')].map(i => ({ id: i.id, placeholder: i.placeholder, visible: i.getBoundingClientRect().width > 0 })),
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));

  await page.screenshot(OUT + '\\01-lobby.png');
  console.log('\n截图:', OUT + '\\01-lobby.png');
  console.log('页面异常:', page.pageErrors.length, JSON.stringify(page.pageErrors.slice(0, 5)));
  console.log('控制台错误:', page.consoleErrors.length, JSON.stringify(page.consoleErrors.slice(0, 5)));

  await browser.close();
})().catch(async (e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
