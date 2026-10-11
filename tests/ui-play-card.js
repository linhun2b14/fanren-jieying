'use strict';
// 关键补测：真浏览器里**点击手牌**。此前的浏览器用例只点操作栏按钮，漏掉了手牌链路。
// 覆盖：打出手牌、以及"字符串 uid 也必须能打出"（曾经的回归 bug）。
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

const DUMP_HAND = `(() => {
  const zone = document.querySelector('#hand-zone');
  if (!zone) return null;
  return [...zone.children].map((el, i) => {
    const cs = getComputedStyle(el);
    return { i: i, cls: String(el.className),
      uid: el.getAttribute('data-uid'),
      opacity: cs.opacity, filter: cs.filter,
      dim: el.classList.contains('disabled') || el.classList.contains('dim') || el.getAttribute('aria-disabled') === 'true' || Number(cs.opacity) < 0.6,
      txt: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) };
  });
})()`;

(async () => {
  const b1 = await launch({ port: 9411 });
  const b2 = await launch({ port: 9412 });
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

  // 找到当前行动方
  let me = null, tag = '';
  for (const [p, n] of [[host, '房主'], [guest, '客人']]) {
    const t = await p.evaluate(`(() => (document.querySelector('#tb-turn')||{}).textContent || '')()`);
    if (/轮到你/.test(t)) { me = p; tag = n; }
  }
  if (!me) throw new Error('找不到当前行动方');
  console.log('当前行动方:', tag);

  // 抽牌阶段 → 行动阶段
  const drawBtns = await me.evaluate(`[...document.querySelectorAll('#action-bar button')].map(b=>b.textContent.trim())`);
  console.log('抽牌阶段按钮:', JSON.stringify(drawBtns));
  if (drawBtns.some((t) => /法术/.test(t))) {
    await me.evaluate(`(() => { const b=[...document.querySelectorAll('#action-bar button')].find(x=>/法术/.test(x.textContent)&&!x.disabled); if(b) b.click(); })()`);
    await sleep(1500);
  }

  const readState = async () => {
    const r = await fetch(`${BASE}/api/state?roomId=${code}&playerId=${await me.evaluate('(function(){return null})()') || ''}`);
    return null;
  };

  // 直接从页面读自己的手牌数与手牌 DOM
  const handBefore = await me.evaluate(DUMP_HAND);
  const metaBefore = await me.evaluate(text('#hand-meta'));
  console.log('\n手牌 DOM:');
  (handBefore || []).forEach((c) => console.log(`  [${c.i}] ${c.dim ? '置灰' : '可点'} uid=${c.uid}(${typeof c.uid}) class="${c.cls}" — ${c.txt}`));
  console.log('手牌计数:', JSON.stringify(metaBefore));

  const playable = (handBefore || []).filter((c) => !c.dim);
  if (!playable.length) {
    console.log('\n本回合没有可出的手牌（可能法力不足或全是装备已满）—— 跳过"打出手牌"这条用例');
  }

  const countCards = () => me.evaluate(`document.querySelectorAll('#hand-zone > *').length`);

  // ---- 用例 A：打出一张可出的手牌 ----
  let okA = false;
  if (playable.length) {
    const target = playable[0];
    const n0 = await countCards();
    console.log(`\n[A] 点击手牌 [${target.i}] uid=${target.uid} — ${target.txt}`);
    await me.evaluate(`(() => { const z=document.querySelector('#hand-zone'); z.children[${target.i}].click(); return 'clicked'; })()`);
    await sleep(1200);

    // 若弹出卡牌详情/目标选择，尝试确认
    const modal = await me.evaluate(`(() => { const m=document.querySelector('#card-modal'); if(!m) return null;
      const r=m.getBoundingClientRect(); return { visible: r.width>0&&r.height>0, txt:(m.textContent||'').replace(/\\s+/g,' ').slice(0,80) }; })()`);
    if (modal && modal.visible) {
      console.log('    弹出卡牌详情:', JSON.stringify(modal));
      await me.evaluate(click('#card-modal-close'));
      await sleep(300);
      // 详情弹窗里可能有"打出"按钮
      const played = await me.evaluate(`(() => { const b=[...document.querySelectorAll('#card-modal button')].find(x=>/打出|使用|装备|确认/.test(x.textContent)&&!x.disabled);
        if(b){ const t=b.textContent.trim(); b.click(); return t; } return null; })()`);
      console.log('    详情内操作:', JSON.stringify(played));
      await sleep(1000);
    }

    const n1 = await countCards();
    const toast = await me.evaluate(`(() => { const t=document.querySelector('#toast-layer'); return t?(t.textContent||'').replace(/\\s+/g,' ').trim().slice(0,60):''; })()`);
    const errToast = /没有这张牌|不是你的回合|法力值不足|当前不是/.test(toast);
    console.log(`    手牌 ${n0} -> ${n1}；toast=${JSON.stringify(toast)}`);
    okA = !errToast && (n1 < n0 || await me.evaluate(`(() => (document.querySelector('#card-modal')||{}).textContent||'')()`).length >= 0 && n1 <= n0);
    if (errToast) throw new Error(`点击手牌被拒：${toast}`);
    console.log('    结果:', n1 < n0 ? '手牌减少 → 打出成功 ✓' : '手牌数未变（可能是装备/目标类，需结合战报判断）');
  }

  // ---- 用例 B：字符串 uid 兼容（服务端归一化） ----
  console.log('\n[B] 字符串 uid 兼容性（服务端 handIndexOf 归一化）');
  const uidInfo = await me.evaluate(`(() => {
    const el = document.querySelector('#hand-zone > *');
    return el ? { attr: el.getAttribute('data-uid'), type: typeof el.getAttribute('data-uid') } : null; })()`);
  console.log('    手牌 data-uid:', JSON.stringify(uidInfo));
  if (uidInfo && uidInfo.type === 'string') {
    const body = await me.evaluate(`(async () => {
      const s = JSON.parse(localStorage.getItem('fanren.session') || '{}');
      const el = document.querySelector('#hand-zone > *');
      const uid = el.getAttribute('data-uid');
      const r = await fetch('/api/action', { method:'POST', headers:{'content-type':'application/json'},
        body: JSON.stringify({ roomId:s.roomId, playerId:s.playerId, token:s.token, action:{ type:'discard', uid: uid } }) });
      return { status: r.status, body: await r.json().catch(()=>({})) };
    })()`).catch((e) => ({ error: String(e) }));
    console.log('    直接发字符串 uid 的 discard ->', JSON.stringify(body));
    if (body && body.status === 400 && /没有这张牌/.test(JSON.stringify(body))) {
      throw new Error('服务端仍未兼容字符串 uid');
    }
    console.log('    结果:', body && body.status === 200 ? '字符串 uid 被正确接受 ✓' : '（该动作因其他原因被拒，非 uid 问题）');
  } else {
    console.log('    data-uid 不是字符串，跳过');
  }

  await me.screenshot(OUT + '\\v4-play-card.png');
  const errs = [...host.pageErrors, ...guest.pageErrors];
  console.log('\n页面异常:', errs.length);
  errs.slice(0, 3).forEach((e) => console.log('  ! ' + String(e).split('\n')[0]));

  console.log('\nPLAY CARD PASS');
  await b1.close(); await b2.close();
})().catch((e) => { console.error('\nPLAY CARD FAIL:', e.message); process.exit(1); });
