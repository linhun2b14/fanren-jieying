'use strict';
// 检查"离线/已连接/已出局"这类状态元素是否被错误地可见显示。
const { launch, newPage, sleep } = require('./cdp');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';

(async () => {
  const b = await launch({ port: 9361 });
  const p = await newPage(b, BASE + '/');
  await sleep(1300);

  const expr = `(() => {
    const hits = [...document.querySelectorAll('*')].filter(e =>
      e.children.length === 0 && /离线|已出局|已连接|房主|你/.test(e.textContent || ''));
    return hits.map(e => {
      const rc = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      return { t: (e.textContent || '').trim().slice(0, 14),
        visible: rc.width > 0 && rc.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
        cls: String(e.className).slice(0, 40) };
    }).filter(x => x.t);
  })()`;
  const r = await p.evaluate(expr);
  console.log('状态类元素（仅列出可见的）:');
  r.filter((x) => x.visible).forEach((x) => console.log('  可见:', JSON.stringify(x)));
  console.log('隐藏的:', r.filter((x) => !x.visible).map((x) => x.t).join(' | ') || '(无)');
  console.log('页面异常:', p.pageErrors.length, '控制台:', p.consoleErrors.filter((e) => !e.includes('favicon')).length);

  await b.close();
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
