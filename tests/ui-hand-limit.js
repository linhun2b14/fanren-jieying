'use strict';
// 回合结束「手牌超上限 → 自己挑弃」的真浏览器验证。
// 引擎侧已由 tests\hand-limit-test.js 覆盖（37 项），这里只管**界面上看不看得见、点不点得动**：
//   ① 行动栏出现"手牌超过上限：请自己挑 N 张弃置"并列出各牌堆计数
//   ② 手牌自动进入弃置模式（有 .discard-ready 角标、被锁的牌也能点）
//   ③ 每弃一张"还需弃置 N"就减 1，弃够后提示消失、回合真的转交给对手
//   ④ 全程无页面异常
//
// 造局方式：双方轮流"只抽牌不打牌"地过回合，手牌每回合 +3，第 2~3 个回合必然超上限。
const { launch, newPage, sleep } = require('./cdp');
const fs = require('fs');
const BASE = process.env.BASE || 'http://127.0.0.1:8094';
const OUT = require('path').join(__dirname, ('..'), 'ref', 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

const setVal = (s, v) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return 'NOELEM';
  e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event('input',{bubbles:true})); return 'ok'; })()`;
const click = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); if(!e) return 'NOELEM';
  if(e.disabled) return 'DISABLED'; e.click(); return 'ok'; })()`;
const text = (s) => `(() => { const e=document.querySelector(${JSON.stringify(s)}); return e?e.textContent.trim():null; })()`;
const clickBtn = (re) => `(() => { const b=[...document.querySelectorAll('#action-bar button')].find(x=>new RegExp(${JSON.stringify(re)}).test(x.textContent)&&!x.disabled);
  if(!b) return null; b.click(); return b.textContent.trim(); })()`;
const barText = `(document.querySelector('#action-bar')||{}).textContent || ''`;
const handTreasure = `(document.querySelector('#hand-meta')||{}).textContent || ''`;

const isTurn = (p) => p.evaluate(`/轮到你/.test(((document.querySelector('#tb-turn')||{}).textContent||''))`);
const needOf = (t) => { const m = String(t).match(/还需弃置\s*(\d+)\s*张/); return m ? Number(m[1]) : null; };

/**
 * 轮询等待（交接 §7 待办 5「UI 抖动治理」）：
 * 服务端算完 + SSE 推回来有往返延迟，**固定 sleep 在全量里会偶挂**（这套 ui-hand-limit 就是那个倒霉蛋）。
 * 传一段返回"真值即停"的表达式；超时返回 null（由调用方决定怎么报）。
 */
async function waitFor(p, expr, ms) {
  const t0 = Date.now();
  for (;;) {
    const v = await p.evaluate(expr);
    if (v) return v;
    if (Date.now() - t0 > (ms || 6000)) return null;
    await sleep(200);
  }
}

/** 点一个按钮，然后**等它从行动栏消失**（= 服务端确实推进了阶段），不再用固定 sleep */
async function clickAndWaitGone(p, re) {
  const clicked = await p.evaluate(clickBtn(re));
  if (!clicked) return null;
  await waitFor(p, `(() => { const b=[...document.querySelectorAll('#action-bar button')]
    .find(x=>new RegExp(${JSON.stringify(re)}).test(x.textContent)); return b ? null : 'gone'; })()`, 6000);
  return clicked;
}

async function advanceToAction(p, tag) {
  await clickAndWaitGone(p, '灵气');
  await clickAndWaitGone(p, '宝物');
  const picked = (await clickAndWaitGone(p, '同行者')) || (await clickAndWaitGone(p, '法术'));
  return picked;
}

(async () => {
  const b1 = await launch({ port: 9451 });
  const b2 = await launch({ port: 9452 });
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

  let hit = null;                       // 出现强制弃牌的那一页
  for (let turn = 1; turn <= 8 && !hit; turn++) {
    let me = null, tag = '';
    for (const [p, n] of [[host, '房主'], [guest, '客人']]) if (await isTurn(p)) { me = p; tag = n; }
    if (!me) { console.log(`  第 ${turn} 轮：找不到行动方，停`); break; }
    const picked = await advanceToAction(me, tag);
    const meta = await me.evaluate(handTreasure);
    console.log(`  第 ${turn} 轮 [${tag}] 抽完手牌: ${meta.replace(/\s+/g, ' ')}（抉择=${JSON.stringify(picked)}）`);
    await me.evaluate(clickBtn('结束回合'));
    // ⚠️ 这里原来是固定 `sleep(1200)` 再读行动栏 —— 全量里偶挂就是这一步：服务端算完 + SSE 推回来
    //    偶尔超过 1.2 秒，于是这条没看到"手牌超过上限"，回合被跳过、8 轮下来一次都没触发。
    //    改成**轮询**：等到"提示出现"（命中）或"轮到对面了"（这轮确实没超）为止。
    const hitText = await waitFor(me,
      `(() => { const t = (document.querySelector('#action-bar')||{}).textContent || '';
        return /手牌超过上限/.test(t) ? t : null; })()`, 4000);
    const bt = hitText || (await me.evaluate(barText));
    if (hitText) { hit = { page: me, tag: tag, text: String(hitText).replace(/\s+/g, ' ') }; }
  }

  check('若干回合后真的触发了「手牌超过上限」', !!hit, hit ? hit.text.slice(0, 140) : '8 轮内没触发（可能是手牌一直没超）');

  if (hit) {
    const p = hit.page;
    const t0 = hit.text;
    console.log('\n  触发时的行动栏:', t0.slice(0, 220));
    check('提示写明"请自己挑 N 张弃置"', /请自己挑\s*\d+\s*张弃置/.test(t0), t0.slice(0, 120));
    check('列出了各牌堆计数（宝物 x/6 …）', /宝物\s*\d+\/\d+/.test(t0), t0.slice(0, 160));
    check('写明了"直接点手牌"', /直接点手牌/.test(t0), t0.slice(0, 160));
    const need0 = needOf(t0);
    check('读得到"还需弃置 N 张"', need0 !== null && need0 > 0, String(need0));

    // 手牌应该已经自动进入弃置模式：所有牌都可点，且带 .discard-ready
    const cards = await p.evaluate(`(() => {
      const list = [...document.querySelectorAll('#hand-zone .hand-card')];
      return { n: list.length, ready: list.filter(c => c.classList.contains('discard-ready')).length,
        disabled: list.filter(c => c.disabled).length,
        blocked: list.filter(c => c.classList.contains('is-blocked')).length };
    })()`);
    console.log('  手牌状态:', JSON.stringify(cards));
    check('手牌已自动进入弃置模式（都带 .discard-ready）', cards.n > 0 && cards.ready === cards.n, JSON.stringify(cards));
    check('被锁的牌（is-blocked）也点得动', cards.disabled === 0, JSON.stringify(cards));

    await p.screenshot(OUT + '\\ui-forced-discard-1.png');

    // 一张一张弃，验证"还需弃置 N"递减
    let last = need0;
    let n = 0;
    while (n < 12) {
      const bt = await p.evaluate(barText);
      if (!/手牌超过上限/.test(bt)) break;
      const cur = needOf(bt);
      if (cur !== null && cur !== last) {
        check(`弃到第 ${n + 1} 张时"还需弃置"从 ${last} 减到 ${cur}`, cur === last - 1, `${last} -> ${cur}`);
      }
      last = cur === null ? last : cur;
      const okClick = await p.evaluate(`(() => { const c=document.querySelector('#hand-zone .hand-card'); if(!c) return 'NO_CARD'; c.click(); return c.querySelector('.hc-name').textContent; })()`);
      if (okClick === 'NO_CARD') break;
      // 轮询：等这一张真落下去（"还需弃置"变了，或提示消失），别用固定 sleep
      await waitFor(p, `(() => { const t = (document.querySelector('#action-bar')||{}).textContent || '';
        if (!/手牌超过上限/.test(t)) return 'gone';
        const m = /还需弃置\\s*(\\d+)\\s*张/.exec(t);
        return (m && Number(m[1]) !== ${cur}) ? 'changed' : null; })()`, 5000);
      n++;
      if (n === 1) console.log(`    弃了【${okClick}】`);
    }
    check('一路弃到提示消失（回合得以结束）', !/手牌超过上限/.test(await p.evaluate(barText)), (await p.evaluate(barText)).slice(0, 120));
    await p.screenshot(OUT + '\\ui-forced-discard-2.png');

    // 回合应该真的交出去了（同样轮询，别赌固定 sleep）
    const other = p === host ? guest : host;
    const handed = await waitFor(other, `/轮到你/.test(((document.querySelector('#tb-turn')||{}).textContent||''))`, 8000);
    check('回合确实转交给对手', !!handed, '对手那边没显示"轮到你"');
  }

  const errs = [...host.pageErrors, ...guest.pageErrors];
  console.log('\n页面异常:', errs.length);
  errs.slice(0, 3).forEach((e) => console.log('  ! ' + String(e).split('\n')[0]));
  check('全程无页面异常', errs.length === 0, errs.slice(0, 2).map(String).join(' | '));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  await b1.close(); await b2.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('\nFORCED-DISCARD UI FAIL:', e.message); process.exit(1); });
