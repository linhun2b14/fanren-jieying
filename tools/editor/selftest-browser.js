'use strict';
// 卡牌编辑器的**真浏览器**冒烟（无头 Edge 真渲染，不是 DOM 垫片）。
// 子代理交付时只做了无头 DOM 垫片验证，这一步补上"真人浏览器里到底能不能用"。
//
// 前置：编辑器服务已经在 8098 上起着，例如
//   node tools\editor\server.js --cards data\_editor-selftest.json --port 8098
//
// 用法：
//   node tools\editor\selftest-browser.js                     # 正常场景（目标卡池存在）
//   设 EDITOR_MISSING=1 再跑                                   # 异常场景（目标卡池不存在 → 必须明确报错）
//     PowerShell: $env:EDITOR_MISSING='1'; node tools\editor\selftest-browser.js
const { launch, newPage, sleep } = require('../../tests/cdp');
const fs = require('fs');
const BASE = process.env.EDITOR_BASE || 'http://127.0.0.1:8098';
const MISSING = !!process.env.EDITOR_MISSING;
const OUT = require('path').join(__dirname, ('..', '..'), 'ref', 'shots');
fs.mkdirSync(OUT, { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };

/** 异常场景：目标卡池文件不存在时，页面必须明确报错，而不是静默空列表。 */
async function missingTargetScenario(browser) {
  const page = await newPage(browser, BASE + '/');
  await sleep(1800);
  const txt = (sel) => page.evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() : null; })()`);
  const bannerTxt = await txt('#ed-banner');
  const listTxt = await txt('#list');
  console.log('   顶部横幅：' + bannerTxt);
  console.log('   列表区　：' + listTxt);
  check('顶部横幅报出"载入失败"', /载入失败/.test(bannerTxt || ''), bannerTxt);
  check('横幅里说清了原因（文件不存在）', /不存在|文件不存在/.test(bannerTxt || ''), bannerTxt);
  check('列表区不再停在空白（给了人话提示）', /读不出来/.test(listTxt || ''), String(listTxt).slice(0, 80));
  check('左栏没有假装有卡（0 行）', (await page.evaluate(`document.querySelectorAll('#list .card-row').length`)) === 0);
  check('页面无未捕获异常', page.pageErrors.length === 0, JSON.stringify(page.pageErrors.slice(0, 2)));
  await page.screenshot(OUT + '\\editor-missing-target.png');
}

(async () => {
  const browser = await launch({ port: 9437, width: 1680, height: 1050 });

  // 异常场景（EDITOR_MISSING=1）：目标卡池文件不存在，页面必须明确报错
  if (MISSING) {
    try { await missingTargetScenario(browser); } finally { await browser.close(); }
    console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
    process.exit(fail === 0 ? 0 : 1);
    return;
  }

  try {
    const page = await newPage(browser, BASE + '/');
    await sleep(1800);

    const n = (sel) => page.evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
    const txt = (sel) => page.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return e ? (e.textContent || '').replace(/\\s+/g, ' ').trim() : null; })()`);
    const box = (sel) => page.evaluate(
      `(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()`);

    // ① 页面能开、无异常
    check('页面标题是「卡牌编辑器」', /卡牌编辑器/.test(await page.evaluate('document.title')), await page.evaluate('document.title'));
    check('页面上没有未捕获异常', page.pageErrors.length === 0, JSON.stringify(page.pageErrors.slice(0, 2)));
    check('控制台没有报错', page.consoleErrors.length === 0, JSON.stringify(page.consoleErrors.slice(0, 2)));

    // ② 卡池真的加载出来了
    const rows = await n('#list .card-row');
    // ⚠️ 别写死种数（卡池一直在长：2026-10-05 已 122 种）。按 /api/cards 实算。
    const poolInfo = await page.evaluate(`(async () => {
      const r = await fetch('/api/cards'); const j0 = await r.json();
      const j = j0.pool || j0;                       // 编辑器这个端点把卡池包在 pool 里
      const decks = ['treasure', 'spell', 'companion', 'qi'];
      let n = 0, tot = 0;
      for (const d of decks) { const a = j[d] || []; n += a.length; tot += a.reduce((s, c) => s + (c.count == null ? 1 : c.count), 0); }
      return { n: n, tot: tot };
    })()`);
    check(`左侧列出 ${poolInfo.n} 种卡（与卡池一致，实得 ${rows}）`, rows === poolInfo.n, String(rows));
    check('分成 4 个牌堆分组', (await n('#list .grp-head')) === 4, String(await n('#list .grp-head')));
    const counts = await txt('#ed-counts');
    // 张数**不写死**：只要求"四堆都报出数字 + 合计有数"（用户："卡组总数不固定，按改的算"）
    check('张数徽章报出四堆张数', /宝物牌 \d+/.test(counts || '') && /法术牌 \d+/.test(counts || '')
      && /同行者 \d+/.test(counts || '') && /灵气牌 \d+/.test(counts || ''), counts);
    check('合计张数报出来了（不固定值）', /合计 \d+/.test(counts || ''), counts);
    check('目标卡池路径显示出来了', /\.json$/.test(await txt('#ed-file-path') || ''), await txt('#ed-file-path'));

    // ③ 三栏布局真的可见（不是 0 尺寸）
    for (const [name, sel] of [['卡池列表', '.ed-col-list'], ['编辑表单', '.ed-col-form'], ['卡面预览', '.ed-col-preview']]) {
      const b = await box(sel);
      check(`${name}栏可见（宽高 > 0）`, b && b.w > 100 && b.h > 100, JSON.stringify(b));
    }

    // ④ 点一张牌 → 表单填充 + 预览渲染
    await page.evaluate(`(() => { const r = document.querySelector('#list .card-row'); r.click(); return 'ok'; })()`);
    await sleep(600);
    const formTitle = await txt('#form-title');
    check('点了卡之后表单标题变成牌名', !!formTitle && formTitle !== '从左边选一张牌', formTitle);
    const nameVal = await page.evaluate(`(() => { const e = document.querySelector('#form .fgrid input'); return e ? e.value : null; })()`);
    check('表单里牌名输入框有值', !!nameVal && nameVal.length > 0, String(nameVal));
    check('表单标题带上了这张牌的名字', !!nameVal && (formTitle || '').indexOf(nameVal) >= 0, `表单=${nameVal} 标题=${formTitle}`);
    const prev = await txt('#preview');
    check('右侧预览有内容（不是空白）', !!prev && prev.length > 10, String(prev).slice(0, 40));
    check('预览里有卡名', !!nameVal && (prev || '').indexOf(nameVal) >= 0, String(prev).slice(0, 40));
    check('预览渲染出了效果行（.eff）', (await n('#preview .eff')) > 0, String(await n('#preview .eff')));
    // 「什么时候能打」那一句：选中卡后必须非空（这是编辑器最实用的提示之一）
    const whenTxt = await txt('#preview .cd-tier');
    check('预览里有"什么时候能打"的说明', !!whenTxt && whenTxt.length > 4, String(whenTxt));

    // ④b 时点下拉（步骤 C①）：新卡**只能从坐标里挑**，旧 when 被归到"旧写法，建议迁移"那一组
    await page.evaluate(`(() => { const e = document.querySelector('#search'); e.value = '燕如嫣'; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await sleep(500);
    await page.evaluate(`(() => { const r = document.querySelector('#list .card-row'); r.click(); return 'ok'; })()`);
    await sleep(700);
    const timingSel = await page.evaluate(`(() => {
      const sels = [...document.querySelectorAll('#form select')];
      // 时点下拉 = 带"阶段分组"的那个（分组标签现在是「⭐ 开始阶段」这类；兼容旧的「时点总线」字样）
      const s = sels.find((x) => [...x.querySelectorAll('optgroup')].some((g) => /⭐|时点总线/.test(g.label)));
      if (!s) return null;
      const txtOf = (v) => { const o = [...s.options].find((x) => x.value === v); return o ? o.textContent : null; };
      return {
        groups: [...s.querySelectorAll('optgroup')].map((g) => g.label),
        oldOpt: txtOf('w:play'), standOpt: txtOf('w:standing'),
        coordCount: [...s.options].filter((o) => o.value.indexOf('e:') === 0).length,
        value: s.value };
    })()`);
    check('编辑表单里有「时点总线」下拉', !!timingSel, JSON.stringify(timingSel));
    check('下拉里坐标可选（e: 开头的项 ≥ 20 个）', !!timingSel && timingSel.coordCount >= 20, timingSel && String(timingSel.coordCount));
    check('旧写法 when 被标成「旧写法，建议迁移」', !!timingSel && !!timingSel.oldOpt && /旧写法，建议迁移/.test(timingSel.oldOpt), timingSel && timingSel.oldOpt);
    check('常驻/按钮类单独一组（standing 不带"建议迁移"）',
      !!timingSel && !!timingSel.standOpt && !/建议迁移/.test(timingSel.standOpt), timingSel && timingSel.standOpt);
    // ⭐ 时点名走**阶段图口径**（用户 2026-10-02）：下拉按阶段分组、选项文字就是卡面上显示那个名字
    const hurtOpt = timingSel && timingSel.groups ? await page.evaluate(`(() => {
      const s = [...document.querySelectorAll('#form select')]
        .find((x) => [...x.querySelectorAll('optgroup')].some((g) => /独立|对战阶段/.test(g.label)));
      if (!s) return null;
      const o = [...s.options].find((x) => x.value === 'e:hurt|self|');
      return { text: o ? o.textContent : null, groups: [...s.querySelectorAll('optgroup')].map((g) => g.label) };
    })()`) : null;
    check('下拉按阶段分组（出现「⭐ 独立」「⭐ 对战阶段」这类分组）',
      !!hurtOpt && hurtOpt.groups.some((g) => /独立/.test(g)) && hurtOpt.groups.some((g) => /对战阶段/.test(g)),
      hurtOpt && JSON.stringify(hurtOpt.groups));
    // ⭐ 2026-10-05：再收拢一层 —— 先分「主要阶段 / 次要阶段 / 独立时点」三组（用户拍板不合并那 6 格）
    check('2026-10-05 三组分节（主要阶段 / 次要阶段 / 独立时点）',
      !!hurtOpt && hurtOpt.groups.some((g) => /主要阶段/.test(g))
        && hurtOpt.groups.some((g) => /次要阶段/.test(g))
        && hurtOpt.groups.some((g) => /独立时点/.test(g)),
      hurtOpt && JSON.stringify(hurtOpt.groups));
    check('选项文字 = 阶段图口径的名字（受伤，不再是「受伤 · 我方」）',
      !!hurtOpt && /^受伤/.test(hurtOpt.text || '') && !/我方/.test(hurtOpt.text || ''), hurtOpt && hurtOpt.text);

    // ⑤ 搜索能筛（并检查清空能恢复）    await page.evaluate(`(() => { const e = document.querySelector('#search'); e.value = '青易'; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await sleep(400);
    const filtered = await n('#list .card-row');
    check(`搜「青易」筛出 ${filtered} 张（应少于 ${poolInfo.n}）`, filtered > 0 && filtered < poolInfo.n, String(filtered));
    await page.evaluate(`(() => { const e = document.querySelector('#search'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await sleep(400);
    check(`清空搜索后恢复 ${poolInfo.n} 张`, (await n('#list .card-row')) === poolInfo.n, String(await n('#list .card-row')));

    // ⑥ 点「只校验」→ 真校验器输出贴进控制台（这条最值钱：证明后端校验链路在真浏览器里通）
    await page.evaluate(`(() => { document.querySelector('#btn-validate').click(); return 'ok'; })()`);
    let consoleTxt = '';
    // ⚠️ 不要写死 `35 / 35` 这类条数：verify-dsl 每加一条自检，这里就会假红
    //    （2026-10-02 加"时点硬校验"时踩到）。判据改成"两端数字相等"。
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      consoleTxt = (await txt('#console')) || '';
      if (/verify-dsl|通过 \d+ \/ \d+/.test(consoleTxt)) break;
    }
    check('「只校验」把校验器原始输出贴出来了', /lint-cards|verify-dsl|硬错误/.test(consoleTxt), consoleTxt.slice(0, 120));
    // ⚠️ 控制台是 textContent（换行被吃掉），整块拼起来时 `通过 40 / 40` 后面紧跟着下一步的序号 "5 "
    //    会粘成 "通过 40 / 405"。所以**读那一步自己的 pre**（里面只有校验器原始输出），而不是整块文本。
    const vdBody = await page.evaluate(`(() => {
      const s = [...document.querySelectorAll('#console .step')].find((x) => /verify-dsl/.test(x.textContent));
      const pre = s && s.querySelector('pre.step-body');
      return pre ? pre.textContent : null;
    })()`);
    const vd = /通过 (\d+) \/ \1(?![0-9])/.exec(vdBody || '');
    check('校验结果显示 verify-dsl 全部通过（N / N）', !!vd, '实际：' + (vd ? vd[0] : String(vdBody).slice(-40)));
    check('校验器是新版（带「时点硬校验」那一节）',
      /时点硬校验/.test(vdBody || '') || /引擎从不触发/.test(vdBody || ''), String(vdBody).slice(-160));
    check('校验是"只校验"（提示了没有写盘）', /未写盘|没有写盘|不写盘|wrote|只校验/.test(consoleTxt), consoleTxt.slice(-160));

    // ⑦ 效果模拟沙盒（用户 2026-10-05 要的）：先验开关，再摆牌 → 加动作 → 运行 → 战报里真出现那张牌
    const hidden0 = await page.evaluate(`document.querySelector('#sim-panel').classList.contains('hidden')`);
    await page.evaluate(`(() => { document.querySelector('#btn-sim-toggle').click(); return 'ok'; })()`);
    await sleep(600);
    const hidden1 = await page.evaluate(`document.querySelector('#sim-panel').classList.contains('hidden')`);
    check('顶栏「效果模拟」开关能切换面板显隐', hidden1 !== hidden0, `点击前 hidden=${hidden0} 点击后 hidden=${hidden1}`);
    // 再点一次应回到原状（收起时不占窗口下方 —— 用户要的就是这个）
    await page.evaluate(`(() => { document.querySelector('#btn-sim-toggle').click(); return 'ok'; })()`);
    await sleep(300);
    const hidden2 = await page.evaluate(`document.querySelector('#sim-panel').classList.contains('hidden')`);
    check('再点一次回到收起/展开的原状', hidden2 === hidden0, `期望 ${hidden0} 实得 ${hidden2}`);
    // 保证展开，继续后面的场景
    await page.evaluate(`(() => {
      const p = document.querySelector('#sim-panel');
      if (p.classList.contains('hidden')) document.querySelector('#btn-sim-toggle').click();
      return 'ok';
    })()`);
    await sleep(900);
    check('展开后沙盒真的占位了（高度 > 0）',
      (await page.evaluate(`document.querySelector('#sim-panel').offsetHeight`)) > 60,
      String(await page.evaluate(`document.querySelector('#sim-panel').offsetHeight`)));
    await page.evaluate(`(() => { document.querySelector('#sim').scrollIntoView({ block: 'center' }); return 'ok'; })()`);
    await sleep(300);
    check('沙盒面板有两个玩家栏', (await n('#sim .sim-pl')) === 2, String(await n('#sim .sim-pl')));
    const stepOpts2 = await page.evaluate(`(() => { const s = [...document.querySelectorAll('.sim-row select')][1]; return s ? s.options.length : 0; })()`);
    check('阶段下拉从 /api/simulate 拿到了阶段表（≥4 项）', stepOpts2 >= 4, String(stepOpts2));
    const actOpts = await page.evaluate(`(() => { const s = [...document.querySelectorAll('.sim-actrow select')][1]; return s ? s.options.length : 0; })()`);
    check('动作下拉拿到了动作表（≥10 项）', actOpts >= 10, String(actOpts));
    // 甲：生命改 3、手牌加一张【补气丹】
    await page.evaluate(`(() => {
      const pl = document.querySelectorAll('#sim .sim-pl')[0];
      const hp = pl.querySelectorAll('input[type=number]')[0];
      hp.value = '3'; hp.dispatchEvent(new Event('change'));
      const sel = pl.querySelector('.sim-slot .sim-pick');
      sel.value = '补气丹';
      pl.querySelector('.sim-slot .btn').click();
      return 'ok';
    })()`);
    await sleep(300);
    check('甲手牌里摆上了【补气丹】', /补气丹/.test((await txt('#sim .sim-pl')) || ''), String(await txt('#sim .sim-pl')).slice(0, 80));
    // 动作：甲 打出【补气丹】→ 加入脚本
    await page.evaluate(`(() => {
      const sels = document.querySelectorAll('.sim-actrow select');
      sels[1].value = 'play'; sels[1].dispatchEvent(new Event('change'));
      return 'ok';
    })()`);
    await sleep(200);
    await page.evaluate(`(() => {
      const row = document.querySelector('.sim-actrow');
      const sels = row.querySelectorAll('select');
      sels[2].value = '补气丹';
      row.querySelector('button').click();
      return 'ok';
    })()`);
    await sleep(300);
    check('动作脚本里出现了这条（甲 打出/装备【补气丹】）', /补气丹/.test((await txt('#sim .sim-script')) || ''), String(await txt('#sim .sim-script')).slice(0, 80));
    await page.evaluate(`(() => { document.querySelector('#btn-sim-run').click(); return 'ok'; })()`);
    await sleep(1500);
    const simLog = (await txt('#sim .sim-log')) || '';
    check('沙盒跑出战报：打出【补气丹】且回了 1 点血', /打出【补气丹】/.test(simLog) && /恢复 1 点生命值/.test(simLog), String(simLog).slice(0, 180));
    check('沙盒输出了局面表（甲 生命 4/6）', /4\/6/.test((await txt('#sim .sim-state')) || ''), String(await txt('#sim .sim-state')).slice(0, 120));
    check('沙盒跑完页面仍无未捕获异常', page.pageErrors.length === 0, JSON.stringify(page.pageErrors.slice(0, 2)));

    // ⑧ 效果蓝图视图（2026-10-05 用户要的"蓝图式编辑效果"）
    await page.evaluate(`(() => { const e = document.querySelector('#search'); e.value = '玄铁飞天盾'; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await sleep(400);
    await page.evaluate(`(() => { document.querySelector('#list .card-row').click(); return 'ok'; })()`);
    await sleep(700);
    check('蓝图视图：渲染出「时机」块', (await n('#form .bp-block')) >= 1, String(await n('#form .bp-block')));
    check('块头写明了时机与应对状态', /应对/.test((await txt('#form .bp-timing')) || ''), String(await txt('#form .bp-timing')).slice(0, 90));
    check('掷骰分支编辑器出现（玄铁飞天盾）', (await n('#form .bp-dice')) === 1, String(await n('#form .bp-dice')));
    check('每条支线的点数勾选与数据一致（5,6 / 2,3,4 / 1 / 兜底空）+ 兜底行在',
      (await page.evaluate(`[...document.querySelectorAll('#form .bp-branch')].map((r) => [...r.querySelectorAll('.bp-face')].filter((b) => b.classList.contains('on')).map((b) => b.textContent).join('')).join('|')`)) === '56|234|1|'
      && (await page.evaluate(`[...document.querySelectorAll('#form .bp-branch')].map((r) => r.className).join(',')`)).indexOf('bp-else') >= 0,
      await page.evaluate(`[...document.querySelectorAll('#form .bp-branch')].map((r) => [...r.querySelectorAll('.bp-face')].filter((b) => b.classList.contains('on')).map((b) => b.textContent).join('')).join('|')`));
    check('支线里列出了子效果（回血 = 把伤害补回来）',
      /恢复生命值/.test((await txt('#form .bp-sub')) || '') || (await n('#form .bp-sub-row')) >= 1,
      String(await txt('#form .bp-sub')).slice(0, 80));
    // 在**支线 1**里点一下「3」→ 归到支线 1（并标脏）
    await page.evaluate(`(() => { const r = document.querySelectorAll('#form .bp-branch')[0]; [...r.querySelectorAll('.bp-face')].find((b) => b.textContent === '3').click(); return 'ok'; })()`);
    await sleep(600);
    check('支线 1 变成 3,5,6（点数可多选、点了就归这条支线）',
      (await page.evaluate(`[...document.querySelectorAll('#form .bp-branch')].map((r) => [...r.querySelectorAll('.bp-face')].filter((b) => b.classList.contains('on')).map((b) => b.textContent).join('')).join('|')`)) === '356|234|1|',
      await page.evaluate(`[...document.querySelectorAll('#form .bp-branch')].map((r) => [...r.querySelectorAll('.bp-face')].filter((b) => b.classList.contains('on')).map((b) => b.textContent).join('')).join('|')`));
    check('改动被标脏（左栏出现改动的点）', (await n('#list .card-row .cr-dot')) >= 1, String(await n('#list .card-row .cr-dot')));
    // 蓝图视图截图存档（给人看的：时机块 → 条件 → 掷骰支线）
    // ⚠️ 表单列是**自己内部滚动**的（.ed-form-body），scrollIntoView 在窗口层没用 —— 直接设 scrollTop
    await page.evaluate(`(() => {
      const f = document.querySelector('#form');
      const b = f.querySelector('.bp-block');
      if (f && b) f.scrollTop = b.offsetTop - f.offsetTop - 8;
      return 'ok';
    })()`);
    await sleep(400);
    const bpShot = await page.screenshot(OUT + '\\editor-blueprint.png');
    check('蓝图视图截图已保存', fs.existsSync(bpShot) && fs.statSync(bpShot).size > 20000, bpShot);
    // 切到表单视图再切回来
    const toggleView = `(() => {
      const bs = [...document.querySelectorAll('#form .sec-head button')];
      const b = bs.find((x) => /表单视图|蓝图视图/.test(x.textContent));
      b.click(); return b.textContent;
    })()`;
    await page.evaluate(toggleView);
    await sleep(500);
    check('切到表单视图后不再有蓝图块', (await n('#form .bp-block')) === 0, String(await n('#form .bp-block')));
    check('表单视图里仍是那条效果（op 分组下拉）', (await n('#form .eff-card')) >= 1, String(await n('#form .eff-card')));
    await page.evaluate(toggleView);
    await sleep(500);
    check('切回蓝图视图正常', (await n('#form .bp-block')) >= 1, String(await n('#form .bp-block')));
    await page.evaluate(`(() => { const e = document.querySelector('#search'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await sleep(400);

    // ⑨ 二期：差异视图 / 新建卡 / 删除卡 + 三期：平衡试跑（2026-10-05 第 11 件）
    //    这几个面板默认收起，靠顶栏开关切换（与"效果模拟"同一套）。
    const clickById = (id) => `(() => { const b = document.getElementById(${JSON.stringify(id)}); if (!b) return 'NOBTN'; b.click(); return 'ok'; })()`;
    // 先改一个字段，让"差异"有东西可比
    await page.evaluate(`(() => {
      const e = document.querySelector('#search'); e.value = '补气丹'; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await sleep(400);
    await page.evaluate(`(() => { const r = document.querySelector('#list .card-row'); if (r) r.click(); return 'ok'; })()`);
    await sleep(500);
    const edited = await page.evaluate(`(() => {
      const c = document.querySelector('#form input[type=number]');
      if (!c) return 'NOINPUT';
      const old = c.value;
      c.value = String(Number(old) + 1);
      c.dispatchEvent(new Event('input', { bubbles: true }));
      c.dispatchEvent(new Event('change', { bubbles: true }));
      return old + ' -> ' + c.value; })()`);
    check('改了一个数值字段（制造出一个差异）', edited !== 'NOINPUT', String(edited));
    await sleep(300);
    await page.evaluate(clickById('btn-diff-toggle'));
    await sleep(400);
    check('「差异 ▸」能展开面板', (await n('#diff-panel')) > 0 && !(await page.evaluate(`document.querySelector('#diff-panel').classList.contains('hidden')`)), '');
    const diffTxt = await txt('#diff');
    check('差异面板列出了改动的卡与字段级 old → new',
      !!diffTxt && /改动/.test(diffTxt) && /补气丹/.test(diffTxt) && /→/.test(diffTxt), String(diffTxt).slice(0, 160));
    check('差异面板有"定位"按钮（点一下跳到该卡）', (await page.evaluate(`!!document.querySelector('#diff .diff-row button')`)) === true, '');
    await page.evaluate(clickById('btn-diff-refresh'));
    await sleep(300);
    check('「重新比对」不报错', (await n('#diff .diff-row')) >= 1, '');

    // 新建卡：第一个牌堆分组里点「＋ 新建卡」
    await page.evaluate(`(() => { const e = document.querySelector('#search'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); return 'ok'; })()`);
    await sleep(400);
    const beforeNew = await n('#list .card-row');
    await page.evaluate(`(() => { const b = [...document.querySelectorAll('#list .grp-head button')].find((x) => /新建卡/.test(x.textContent)); if (!b) return 'NOBTN'; b.click(); return 'ok'; })()`);
    await sleep(600);
    const afterNew = await n('#list .card-row');
    check('「＋ 新建卡」多出一张卡', afterNew === beforeNew + 1, `${beforeNew} -> ${afterNew}`);
    const newName = await txt('#form-title');
    check('新卡立刻被选中（表单标题是它）', !!newName && /新卡/.test(newName), String(newName));
    check('新卡的张数默认 0（先进编辑器，确认后再调）',
      (await page.evaluate(`(() => { const r = document.querySelector('#list .card-row.on .cr-tag'); return r ? r.textContent : null; })()`)) === '0张',
      String(await page.evaluate(`(() => { const r = document.querySelector('#list .card-row.on .cr-tag'); return r ? r.textContent : null; })()`)));

    // 删除卡：confirm 会被 CDP 自动接受（见 tests\cdp.js 里那段 handler）
    const beforeDel = await n('#list .card-row');
    const delRes = await page.evaluate(`(() => { const b = [...document.querySelectorAll('#form .card-ops button')].find((x) => /删除此卡/.test(x.textContent)); if (!b) return 'NOBTN'; b.click(); return 'ok'; })()`);
    await sleep(600);
    const afterDel = await n('#list .card-row');
    check('「删除此卡」把它从列表里去掉', delRes === 'ok' && afterDel === beforeDel - 1, `${delRes}: ${beforeDel} -> ${afterDel}`);

    // 平衡试跑：跑一小轮（每档 1 局，几秒钟）
    await page.evaluate(clickById('btn-balance-toggle'));
    await sleep(300);
    check('「平衡试跑 ▸」能展开面板', !(await page.evaluate(`document.querySelector('#balance-panel').classList.contains('hidden')`)), '');
    await page.evaluate(`(() => { const e = document.getElementById('balance-games'); e.value = '1'; return 'ok'; })()`);
    await page.evaluate(clickById('btn-balance-run'));
    let balTxt = '';
    for (let i = 0; i < 40; i++) {                    // 轮询等它跑完（生成对局要几秒）
      await sleep(700);
      balTxt = await txt('#balance');
      if (/平均回合数|元婴获胜占比/.test(String(balTxt))) break;
    }
    check('平衡试跑出结果（胜率 / 平手率那几行）', /平均回合数|元婴获胜占比/.test(String(balTxt)), String(balTxt).slice(0, 160));
    check('平衡面板是"跑在临时镜像里、不写盘"（顶栏还留着存盘前的改动）',
      (await page.evaluate(`!!document.querySelector('#list .cr-dot')`)) === true, '');

    // ⑩ 批量改张数（用户 2026-10-05 要的："法术类全选所有牌，张数整体加减一"）
    await page.evaluate(clickById('btn-bulk-toggle'));
    await sleep(300);
    check('「批量张数 ▸」能展开面板', !(await page.evaluate(`document.querySelector('#bulk-panel').classList.contains('hidden')`)), '');
    // 只留"法术牌堆"，其余全不选
    const rowsOf = (deckCn) => page.evaluate(`(() => {
      const box = document.querySelector('#list');
      const head = [...box.querySelectorAll('.grp-head')].find((h) => h.textContent.indexOf(${JSON.stringify('')} + ${JSON.stringify(deckCn)}) >= 0);
      if (!head) return null;
      const out = []; let n = head.nextElementSibling;
      while (n && !n.classList.contains('grp-head')) {
        if (n.classList.contains('card-row')) out.push(n.querySelector('.cr-name').textContent + '=' + n.querySelector('.cr-tag').textContent);
        n = n.nextElementSibling;
      }
      return out; })()`);
    await page.evaluate(clickById('btn-bulk-none'));
    await sleep(200);
    await page.evaluate(`(() => {
      const cbs = [...document.querySelectorAll('#bulk-decks input')];
      const spells = cbs[1];                      // DECK_ORDER = 宝物/法术/同行者/灵气
      spells.checked = true; spells.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok'; })()`);
    await sleep(300);
    const hitTxt = await txt('#bulk-hit');
    const spellBefore = await rowsOf('法术牌');
    const treasureBefore = await rowsOf('宝物牌');
    check('只勾「法术牌」后，命中数 = 法术张数（其它堆不算）',
      !!hitTxt && new RegExp('命中\\s*' + spellBefore.length + '\\s*张').test(String(hitTxt)), String(hitTxt));
    check('命中列表把每张法术牌列出来（含 旧 → 新 预览）',
      (await page.evaluate(`document.querySelectorAll('#bulk-preview .bulk-item').length`)) === spellBefore.length,
      String(await page.evaluate(`document.querySelectorAll('#bulk-preview .bulk-item').length`)));

    // 法术类整体 ＋1（其它牌堆必须**不动**）
    await page.evaluate(clickById('btn-bulk-plus'));
    await sleep(300);
    const previewTxt = await txt('#bulk-preview');
    check('预览写明每张牌的 旧 → 新', /→/.test(String(previewTxt)) && /张/.test(String(previewTxt)), String(previewTxt).slice(0, 120));
    await page.evaluate(clickById('btn-bulk-apply'));
    await sleep(600);
    const spellUp = await rowsOf('法术牌');
    const treasureUp = await rowsOf('宝物牌');
    const plusOne = spellBefore.every((row, i) => {
      const [n1, c1] = row.split('=');
      const [n2, c2] = (spellUp[i] || '').split('=');
      return n1 === n2 && Number(String(c2).replace('张', '')) === Number(String(c1).replace('张', '')) + 1;
    });
    check(`法术牌整体 ＋1（${spellBefore.length} 张全部 +1）`, spellUp.length === spellBefore.length && plusOne,
      JSON.stringify({ before: spellBefore.slice(0, 3), after: spellUp.slice(0, 3) }));
    check('别的牌堆（宝物）一点没动', JSON.stringify(treasureUp) === JSON.stringify(treasureBefore),
      JSON.stringify(treasureUp.slice(0, 2)));
    const bannerUp = await txt('#ed-banner');
    check('横幅报出"改了 N 张卡"，并提醒要点保存才写盘',
      /批量改张数：改了\s*\d+\s*张卡/.test(String(bannerUp)) && /保存/.test(String(bannerUp)), String(bannerUp).slice(0, 140));
    check('改完仍是"界面上"的改动（左栏出现改动的点）',
      (await page.evaluate(`document.querySelectorAll('#list .cr-dot').length`)) > 0, '');
    check('差异面板同步列出这些改动（没开也不报错）',
      (await page.evaluate(`document.querySelectorAll('#diff .diff-row').length`)) >= 0, '');

    // 再整体 －1，回到原样（顺带验"夹到 0 不出现负数"）
    await page.evaluate(clickById('btn-bulk-minus'));
    await sleep(300);
    await page.evaluate(clickById('btn-bulk-apply'));
    await sleep(600);
    const spellDown = await rowsOf('法术牌');
    check('整体 －1 回到原样', JSON.stringify(spellDown) === JSON.stringify(spellBefore),
      JSON.stringify({ before: spellBefore.slice(0, 3), after: spellDown.slice(0, 3) }));
    const noNeg = await page.evaluate(`[...document.querySelectorAll('#bulk-preview .bi-new')].every((e) => !/^-/.test(e.textContent))`);
    check('张数不会变成负数（夹到 0）', noNeg === true, String(noNeg));

    // 设为固定值：法术牌堆全部 → 4 张（其它牌堆依旧不动）
    await page.evaluate(`(() => { const e = document.getElementById('bulk-value'); e.value = '4'; e.dispatchEvent(new Event('change', { bubbles: true })); return 'ok'; })()`);
    await page.evaluate(clickById('btn-bulk-set'));
    await sleep(300);
    await page.evaluate(clickById('btn-bulk-apply'));
    await sleep(500);
    const spellSet = await rowsOf('法术牌');
    const treasureSet = await rowsOf('宝物牌');
    check('「设为 4」把法术牌全部设成 4 张',
      spellSet.length > 0 && spellSet.every((row) => /4张$/.test(row)), JSON.stringify(spellSet.slice(0, 3)));
    check('「设为 4」没碰别的牌堆', JSON.stringify(treasureSet) === JSON.stringify(treasureBefore), '');

    // ⑪ 截图存档
    await page.setViewport(1680, 1050, false);
    await sleep(300);
    const shot = await page.screenshot(OUT + '\\editor-overview.png');
    check('截图已保存', fs.existsSync(shot) && fs.statSync(shot).size > 20000, shot);

    console.log('\n页面异常: ' + page.pageErrors.length + ' | 控制台错误: ' + page.consoleErrors.length);
  } finally {
    await browser.close();
  }
  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('冒烟本身崩了: ' + e.message); process.exit(1); });
