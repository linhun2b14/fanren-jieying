'use strict';
// 抽取动画验证（v4：抽取改为手动点击，所以直接观察「行动方自己」点击时的动画节点）
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

/** 点某个按钮的同时高频采样飞行节点（data-ev），返回 {seq, frames, peak} */
async function sampleClick(page, labelRe, ms) {
  const clickExpr = `(() => {
    const norm = s => (s||'').replace(/\\s+/g,'');
    const b = [...document.querySelectorAll('#action-bar button')].find(x => !x.disabled && ${labelRe}.test(norm(x.textContent)));
    if (!b) return null; b.click(); return b.textContent.trim(); })()`;
  const frames = [];
  const t0 = Date.now();
  const clicking = (async () => { await sleep(80); return page.evaluate(clickExpr); })();
  while (Date.now() - t0 < ms) {
    const evs = await page.evaluate(`[...document.querySelectorAll('[data-ev]')].map(e => e.getAttribute('data-ev'))`);
    frames.push(evs);
    await sleep(45);
  }
  const clicked = await clicking;
  const seq = [];
  for (const f of frames) for (const e of f) if (seq[seq.length - 1] !== e) seq.push(e);
  return { clicked: clicked, seq: seq, peak: Math.max(0, ...frames.map((f) => f.length)), activeFrames: frames.filter((f) => f.length > 0).length };
}

(async () => {
  const b1 = await launch({ port: 9431 });
  const b2 = await launch({ port: 9432 });
  const host = await newPage(b1, BASE + '/');
  const guest = await newPage(b2, BASE + '/');
  await sleep(1400);
  await host.evaluate(setVal('#input-name', '韩立'));
  await host.evaluate(click('#btn-create'));
  await sleep(1100);
  const code = String(await host.evaluate(text('#room-code'))).trim();
  await guest.evaluate(setVal('#input-name', '南宫婉'));
  await guest.evaluate(setVal('#input-room', code));
  await guest.evaluate(click('#btn-join'));
  await sleep(1200);
  await host.evaluate(click('#btn-start'));
  await sleep(2200);
  console.log('房间', code, '已开局');

  let me = null;
  for (const [p, n] of [[host, '房主'], [guest, '客人']]) {
    const t = await p.evaluate(`(() => (document.querySelector('#tb-turn')||{}).textContent || '')()`);
    if (/轮到你/.test(t)) me = p;
  }
  if (!me) throw new Error('找不到当前行动方');

  const stepNow = () => me.evaluate(`(() => (document.querySelector('#tb-turn')||{}).dataset.step || '')()`);
  console.log('开局 step =', await stepNow());

  // ---- ① 炼化灵气牌 ----
  const r1 = await sampleClick(me, /炼化灵气/, 2600);
  console.log(`\n[① 炼化灵气牌] 点了=${JSON.stringify(r1.clicked)} 峰值=${r1.peak} 有动画帧=${r1.activeFrames}`);
  console.log('   飞行序列:', JSON.stringify(r1.seq.slice(0, 12)));
  console.log('   点后 step =', await stepNow());
  await me.screenshot(OUT + '\\v5-01-draw-qi.png');

  // ---- ② 探索取宝 ----
  const r2 = await sampleClick(me, /探索/, 3000);
  console.log(`\n[② 探索取两张宝物牌] 点了=${JSON.stringify(r2.clicked)} 峰值=${r2.peak} 有动画帧=${r2.activeFrames}`);
  console.log('   飞行序列:', JSON.stringify(r2.seq.slice(0, 12)));
  console.log('   点后 step =', await stepNow());
  await me.screenshot(OUT + '\\v5-02-draw-treasure.png');

  // ---- ③ 二选一（无动画要求，确认能推进） ----
  const r3 = await sampleClick(me, /法术牌|同行者/, 1800);
  console.log(`\n[③ 二选一] 点了=${JSON.stringify(r3.clicked)} 飞行序列=${JSON.stringify(r3.seq.slice(0, 8))}`);
  console.log('   点后 step =', await stepNow());

  // 战报侧证
  const logs = await me.evaluate(`[...document.querySelectorAll('#log-list > *')].map(e=>e.textContent.replace(/\\s+/g,' ').trim()).slice(-10)`);
  console.log('\n战报:');
  logs.forEach((l) => console.log('   · ' + l.slice(0, 96)));

  const qiSeen = r1.seq.some((s) => /^qi:/.test(s));
  const handSeen = r2.seq.some((s) => /^hand:/.test(s));
  const errs = [...host.pageErrors, ...guest.pageErrors];
  console.log(`\n灵气牌动画: ${qiSeen ? 'YES' : 'NO'}；手牌动画: ${handSeen ? 'YES' : 'NO'}；页面异常: ${errs.length}`);
  errs.slice(0, 3).forEach((e) => console.log('  ! ' + String(e).split('\n')[0]));

  if (!qiSeen) throw new Error('点击【炼化灵气牌】时没观察到灵气牌飞入动画');
  if (!handSeen) throw new Error('点击【探索取宝】时没观察到手牌飞入动画');
  console.log('\nDRAW FX PASS');
  await b1.close(); await b2.close();
})().catch((e) => { console.error('\nDRAW FX FAIL:', e.message); process.exit(1); });
