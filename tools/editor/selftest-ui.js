'use strict';
/**
 * 卡牌编辑器 · 界面冒烟测试（**不需要浏览器**、不占用 CDP 端口）
 *
 * 做法：用一份极简 DOM 垫片（见文件内的 El 类）把 tools/editor/app.js 真正**执行**起来，
 *       让它去打真实运行的编辑器服务（fetch 走真网络），然后检查它渲染出来的 DOM：
 *         · 左栏 76 行 / 4 个牌堆分组 / 张数合计
 *         · 中栏 op 下拉、时点下拉（总线坐标 + 旧写法 when）、参数区、档位区、条件行编辑器
 *         · 右栏卡面预览与"什么时候能打"
 *         · 幽灵 op 的红色标出（列表 + 表单 + 预览）
 *         · 点「只校验」后控制台真的贴上校验器原始输出（通过 / 不通过两条路径）
 *
 * 前置：编辑器服务在跑（只读，不会写盘）：
 *   node tools\editor\server.js --cards data\_editor-selftest.json --port 8098
 * 用法： node tools\editor\selftest-ui.js        （EDITOR_BASE 可改地址）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const BASE = process.env.EDITOR_BASE || 'http://127.0.0.1:8098';

// ---------------------------------------------------------------- 极简 DOM 垫片
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.listeners = {};
    this._text = '';
    this.className = '';
    this.style = {};
    this.dataset = {};
    this.value = '';
    this.type = '';
    this.checked = false;
    this.disabled = false;
    this.selected = false;
    this.title = '';
    this.placeholder = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
  }
  appendChild(n) { n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  insertBefore(n, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    n.parentNode = this;
    if (i < 0) this.childNodes.push(n); else this.childNodes.splice(i, 0, n);
    return n;
  }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get children() { return this.childNodes; }
  set textContent(v) { this._text = v == null ? '' : String(v); this.childNodes = []; }
  get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (c) => { const l = list(); if (l.indexOf(c) < 0) { l.push(c); self.className = l.join(' '); } },
      remove: (c) => { self.className = list().filter((x) => x !== c).join(' '); },
      contains: (c) => list().indexOf(c) >= 0,
      toggle: (c, force) => {
        const has = list().indexOf(c) >= 0;
        const want = force === undefined ? !has : !!force;
        if (want && !has) self.className = list().concat(c).join(' ');
        if (!want && has) self.className = list().filter((x) => x !== c).join(' ');
        return want;
      },
    };
  }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  fire(type, ev) { (this.listeners[type] || []).forEach((fn) => fn.call(this, ev || {})); }
  matches(sel) {
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    return this.tagName.toLowerCase() === sel.toLowerCase();
  }
  descendants(out) { for (const c of this.childNodes) { out.push(c); c.descendants(out); } return out; }
  querySelector(sel) { return this.descendants([]).find((n) => n.matches(sel)) || null; }
  querySelectorAll(sel) { return this.descendants([]).filter((n) => n.matches(sel)); }
}

// 用 index.html 里的 id 建"骨架"，保证 app.js 的 $('#xxx') 都能拿到节点
const html = fs.readFileSync(path.join(ROOT, 'tools/editor/index.html'), 'utf8');
const byId = {};
for (const m of html.matchAll(/id="([^"]+)"/g)) { const n = new El('div'); n.id = m[1]; byId[m[1]] = n; }
const document = {
  createElement: (t) => new El(t),
  createTextNode: (t) => { const n = new El('#text'); n._text = String(t); return n; },
  querySelector: (sel) => (sel.startsWith('#') ? byId[sel.slice(1)] || null : null),
  querySelectorAll: () => [],
  body: new El('body'),
};
const windowStub = { addEventListener: () => {} };

let fails = 0;
function check(name, ok, extra) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (extra !== undefined ? '   ' + extra : ''));
  if (!ok) fails++;
}
const rowsOf = (root) => root.descendants([]).filter((n) => n.matches('.card-row'));
const nameOf = (row) => ((row.descendants([]).find((n) => n.matches('.cr-name')) || {}).textContent || '');
const selectsOf = (root) => root.descendants([]).filter((n) => n.tagName === 'SELECT');

(async () => {
  const st = await (await fetch(BASE + '/api/state')).json();
  console.log('目标服务：' + BASE + '　编辑器目标文件：' + st.cardsFileAbsolute);
  if (!/_editor-selftest\.json$/.test(st.cardsFileAbsolute || '')) {
    console.log('提示：服务目标不是自测副本。本脚本只调用"只校验"（不写盘），继续执行是安全的。\n');
  }

  const src = fs.readFileSync(path.join(ROOT, 'tools/editor/app.js'), 'utf8');
  // 浏览器的 fetch 认相对路径，Node 的 fetch 不认 —— 补上 BASE
  const fetchStub = (url, opt) => fetch(url.startsWith('http') ? url : BASE + url, opt);
  const fn = new Function('document', 'window', 'fetch', 'confirm', 'prompt', 'setInterval', 'clearInterval', src);
  fn(document, windowStub, fetchStub, () => true, () => null, setInterval, clearInterval);
  await new Promise((r) => setTimeout(r, 1500));

  console.log('\n===== 界面冒烟（Node + DOM 垫片，无浏览器） =====');
  if (byId['ed-banner'].textContent) console.log('  [提示] 顶部横幅：' + byId['ed-banner'].textContent.slice(0, 160));
  check('app.js 执行无未捕获异常（boot 跑完）', true);

  const list = byId['list'];
  check('左栏 4 个牌堆分组', list.descendants([]).filter((n) => n.matches('.grp-head')).length === 4,
    list.descendants([]).filter((n) => n.matches('.grp-head')).map((g) => g.textContent).join(' | '));
  const rows = rowsOf(list);
  check('左栏 76 张牌', rows.length === 76, rows.length + ' 行');
  check('牌名渲染（含风雷翅）', rows.map(nameOf).indexOf('风雷翅') >= 0, rows.slice(0, 3).map(nameOf).join('、'));
  const counts = byId['ed-counts'].textContent;
  check('张数徽章报出四堆 + 合计（张数不固定）', /宝物牌 \d+/.test(counts) && /同行者 \d+/.test(counts) && /合计 \d+/.test(counts), counts);

  // 青元剑诀：3 档 + engineDirect op，最复杂的一张
  rows.find((r) => nameOf(r) === '青元剑诀').fire('click');
  const form = byId['form'];
  const preview = byId['preview'];
  check('中栏渲染卡面字段区', /卡面字段/.test(form.textContent));
  const opSel = selectsOf(form).find((s) => s.descendants([]).some((o) => o.value === 'enable_equip_combat'));
  check('op 下拉由 OPS 生成（能找到 enable_equip_combat）', !!opSel, opSel ? opSel.descendants([]).length + ' 个选项' : '没找到');
  check('时点下拉含总线坐标 e:roll|self|before（投骰 · 我方 · 前）',
    !!selectsOf(form).find((s) => s.descendants([]).some((o) => o.value === 'e:roll|self|before' && /投骰/.test(o.textContent))));
  check('时点下拉含旧写法 when 组（w:standing）', !!selectsOf(form).find((s) => s.descendants([]).some((o) => o.value === 'w:standing')));
  check('参数区按 op 生成（对战启用费 = manaCost）', /对战启用费/.test(form.textContent));
  check('档位区渲染（3 档）', /多境界档位 tiers/.test(form.textContent) && /第 3 档/.test(form.textContent));
  check('效果卡片按条渲染', /效果列表 effects/.test(form.textContent) && ((form.textContent.match(/#\d/g) || []).length >= 2));
  check('右栏渲染出卡面（.hand-card）', preview.descendants([]).some((n) => n.matches('.hand-card')));
  check('右栏有卡名/卡文/效果行/什么时候能打', /青元剑诀/.test(preview.textContent) && /骰子/.test(preview.textContent) && /时点：|装备类：/.test(preview.textContent));

  // 干净数据点「只校验」→ 通过路径
  byId['btn-validate'].fire('click');
  await new Promise((r) => setTimeout(r, 9000));
  let con = byId['console'].textContent;
  check('「只校验」→ 界面显示"校验全部通过"', /校验全部通过/.test(con), con.slice(0, 50).replace(/\s+/g, ' '));
  check('控制台显示三步走（lint-cards / verify-dsl / 数量闸门）', /lint-cards/.test(con) && /verify-dsl/.test(con) && /数量闸门/.test(con));
  check('控制台原样贴上校验器输出（体检报告 + 35/35）', /卡池一致性体检/.test(con) && /通过 35 \/ 35/.test(con));
  check('写明未写盘', /未写盘/.test(con));

  // 条件行编辑器（寒蛟带 if.companion）
  rows.find((r) => nameOf(r) === '寒蛟').fire('click');
  const condSel = selectsOf(byId['form']).find((s) => ['hp', 'enemyRealm', 'companion', 'lethal'].every((k) => s.descendants([]).some((o) => o.value === k)));
  check('条件键下拉含 hp/enemyRealm/companion/lethal（CONDITIONS 生成）', !!condSel, condSel ? condSel.descendants([]).length + ' 项' : '没找到');
  check('既有 if.companion 回填进下拉', condSel && condSel.value === 'companion', condSel && condSel.value);

  // 加条件 → 比较符
  rows.find((r) => nameOf(r) === '寒冰珠').fire('click');
  const opSel2 = selectsOf(byId['form']).find((s) => s.descendants([]).some((o) => o.value === 'dice_penalty'));
  check('【寒冰珠】op 下拉选中 dice_penalty', !!opSel2 && opSel2.value === 'dice_penalty', opSel2 && opSel2.value);
  const addCond = byId['form'].descendants([]).find((n) => n.matches('.btn') && /加条件/.test(n.textContent));
  check('效果卡片有「＋ 加条件」按钮', !!addCond);
  addCond.fire('click');
  const cmpSel = selectsOf(byId['form']).find((s) => ['lte', 'lt', 'gte', 'gt', 'eq'].every((k) => s.descendants([]).some((o) => o.value === k)));
  check('比较符下拉 lte/lt/gte/gt/eq 且默认选中 lte', !!cmpSel && cmpSel.value === 'lte', cmpSel ? cmpSel.descendants([]).map((o) => o.value).join(',') : '没找到');
  check('预览同步显示条件（生命值）', /生命值/.test(byId['preview'].textContent));

  // 幽灵 op → 红色标出
  opSel2.value = 'ghost_op_xyz';
  opSel2.fire('change');
  check('幽灵 op 红色标出（文案 + .unknown 样式）',
    /幽灵效果：引擎不认这个 op/.test(byId['form'].textContent) && byId['form'].descendants([]).some((n) => n.matches('.eff-card') && n.classList.contains('unknown')));
  check('顶部横幅提示幽灵效果', /幽灵效果/.test(byId['ed-banner'].textContent));
  check('预览里也标出幽灵效果', /幽灵效果/.test(byId['preview'].textContent));

  // 脏数据点「只校验」→ 拒绝路径
  byId['btn-validate'].fire('click');
  await new Promise((r) => setTimeout(r, 9000));
  con = byId['console'].textContent;
  check('脏数据「只校验」→ 显示"校验未通过 / 已拒绝写盘"', /校验未通过/.test(con) && /已拒绝写盘/.test(con));
  check('原样带出 lint 错误行（点名 ghost_op_xyz）', /ghost_op_xyz/.test(con), (con.split('\n').find((l) => /ghost_op_xyz/.test(l)) || '').trim().slice(0, 80));

  // 搜索
  byId['search'].value = '青易';
  byId['search'].fire('input');
  check('搜索「青易」筛出 1 张', rowsOf(byId['list']).length === 1, rowsOf(byId['list']).map((r) => r.textContent).join(','));
  byId['search'].value = '';
  byId['search'].fire('input');
  check('清空搜索恢复 76 张', rowsOf(byId['list']).length === 76);

  console.log('\n===== 界面冒烟结束：' + (fails ? '失败 ' + fails + ' 项' : '全部通过') + ' =====');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('冒烟异常：', e && e.stack || e); process.exit(2); });
