'use strict';
/**
 * 卡牌编辑器 · 界面逻辑（原生 JS + DOM，无框架、无 CDN）
 *
 * 数据流：
 *   GET /api/cards → S.pool（磁盘上的**原始** JSON，不做归一化；改的就是这份）
 *   GET /api/meta  → S.meta（server/effect-meta.js 的元数据 + 界面侧参数提示）
 *   点保存         → POST /api/save（三步校验，通过才写盘）
 *
 * 关键约定：
 *   · 时点 / op / 触发条件 / 比较符 四个下拉的选项**全部**由 /api/meta 生成，
 *     界面里没有任何一份自己维护的 op 词典（只有中文标签与参数提示）。
 *   · op 不在 META.ops 里 → 红色标出（治"只写不读的幽灵效果"）。
 *   · 任何没登记在提示表里的字段都还能编辑（落在「其它字段」/「原始 JSON」区），不会丢数据。
 */
(function () {

  // ================================================================ 常量
  var REALM_NAMES = ['凡人', '炼气期', '筑基期', '结丹期', '元婴期'];
  var DECK_CN = { treasure: '宝物牌', spell: '法术牌', companion: '同行者', qi: '灵气牌' };
  var DECK_ORDER = ['treasure', 'spell', 'companion', 'qi'];
  var TYPE_CN = { equip: '装备类', consume: '消耗类', companion: '同行者', qi: '灵气牌' };
  var TYPE_OPTS = {
    treasure: [['equip', '装备类'], ['consume', '消耗类']],
    spell: [['equip', '装备类'], ['consume', '消耗类']],
    companion: [['companion', '同行者']],
    qi: [['qi', '灵气牌']],
  };
  var PHASE_CN = { before: '前', after: '后', win: '获胜', tie: '平局', lose: '失败' };
  var SUBJECT_CN = { self: '我方', foe: '对方' };
  var COND_KEYS_STR = { companion: 1, deck: 1, turnFlag: 1 };
  var COND_KEYS_BOOL = { hasEquip: 1, inCombat: 1, lethal: 1, puppet: 1 };
  var COND_BOOL_CMP = { higher: 1, lower: 1, realmHigher: 1, notSelf: 1 };
  /** 卡级已知字段（其余键会落进「其它字段」区，仍可编辑） */
  var KNOWN_CARD_KEYS = ['id', 'name', 'type', 'cost', 'realm', 'count', 'cat', 'text', 'effects', 'tiers',
    'slots', 'absorb', 'equipSlot', 'equipCost', 'activateDiscardSelf', 'cardCostDiscount', 'note',
    'response', 'uses'];
  var EFFECT_RESERVED = ['when', 'op', 'event', 'subject', 'phase', 'if'];

  // ================================================================ 状态
  var S = {
    meta: null,
    pool: null,
    file: '',
    fileAbs: '',
    // 官方基线只作参考（用户 2026-10-02 深夜："卡组总数不固定，按改的算"）
    baseline: { treasure: 80, spell: 33, companion: 78, qi: 60 },
    baselineTotal: 251,
    keepBackups: 10,
    sel: null,          // { deck: 'treasure', id: 'k_xxx' }
    search: '',
    dirty: {},          // cardId -> true
    view: 'blueprint',  // 效果编辑视图：'blueprint'（蓝图，默认）| 'form'（表单）
    regressionTimer: null,
    fieldSeen: {},      // 字段名 -> 引擎源码里是否读到
  };

  // ================================================================ DOM 小工具
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function opt(value, label, selected) {
    var o = el('option', null, label);
    o.value = value;
    if (selected) o.selected = true;
    return o;
  }
  function isPlainObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function deepCopy(v) { return JSON.parse(JSON.stringify(v)); }
  function fmtNum(v) { return (typeof v === 'number') ? String(v) : (v == null ? '—' : String(v)); }
  function realmName(r) { return REALM_NAMES[r] || ('境界 ' + r); }

  // ================================================================ 元数据取用
  function ops() { return (S.meta && S.meta.ops) || {}; }
  function whens() { return (S.meta && S.meta.whens) || {}; }
  function conds() { return (S.meta && S.meta.conditions) || {}; }
  function events() { return (S.meta && S.meta.events) || {}; }
  function opMeta(op) { return ops()[op] || null; }
  function opLabel(op) { var o = opMeta(op); return (o && o.label) || op; }
  /** 下拉里那一行的文字：中文标签 +（op 名）+ 关键旗标 */
  function opLabelOf(op, m) {
    var label = ((m && m.label) || op) + '（' + op + '）';
    var flags = [];
    if (m && m.passive) flags.push('常驻');
    if (m && m.needsTarget) flags.push('需目标');
    if (m && m.requiresCombat) flags.push('仅对战');
    if (m && m.deprecated) flags.push('已废弃');
    return label + (flags.length ? ' [' + flags.join('·') + ']' : '');
  }
  function whenMeta(w) { return whens()[w] || null; }
  function whenLabel(w) { var x = whenMeta(w); return (x && x.label) || w; }
  function isKnownOp(op) { return !!opMeta(op); }
  /** 查阶段/时点名表（服务端 effect-meta 的 TIMING_NAMES，经 /api/meta 的 timingNames 下发） */
  function timingNames() { return (S.meta && S.meta.timingNames) || {}; }
  function timingKeysOf(eff) {
    if (!eff || !eff.event) return [];
    var ev = events()[eff.event];
    var sub = eff.subject || ((ev && ev.subject === 'both') ? 'self' : '');
    var ph = eff.phase || '';
    return [eff.event + '|' + sub + '|' + ph, eff.event + '|' + sub, eff.event + '|' + ph, eff.event];
  }
  /** 坐标 → 阶段图口径的名字（「对战结算阶段 · 获胜」「先攻出牌阶段」这类） */
  function timingName(eff) {
    var keys = timingKeysOf(eff);
    var t = timingNames();
    for (var i = 0; i < keys.length; i++) if (t[keys[i]] && t[keys[i]].name) return t[keys[i]].name;
    return null;
  }
  function timingText(eff) {
    var nm = timingName(eff);
    if (nm) return nm;
    if (eff.event) {
      var ev = events()[eff.event];
      var s = (ev && ev.label) || eff.event;
      if (eff.subject) s += ' · ' + (SUBJECT_CN[eff.subject] || eff.subject);
      if (eff.phase) s += ' · ' + (PHASE_CN[eff.phase] || eff.phase);
      return s;
    }
    if (eff.when) return whenLabel(eff.when);
    if (eff.op && opMeta(eff.op) && opMeta(eff.op).engineDirect) return '特定阶段直查（不占时点）';
    return '（没写时点）';
  }
  function condSummary(cond) {
    if (!cond) return '';
    var parts = [];
    for (var k in cond) {
      if (!Object.prototype.hasOwnProperty.call(cond, k)) continue;
      var label = (conds()[k] && conds()[k].label) || k;
      var v = cond[k];
      if (isPlainObj(v)) {
        var bits = [];
        for (var c in v) {
          if (!Object.prototype.hasOwnProperty.call(v, c)) continue;
          if (COND_BOOL_CMP[c]) { if (v[c]) bits.push(c === 'lower' ? '更低' : '更高'); }
          else bits.push(c + ' ' + v[c]);
        }
        parts.push(label + '(' + bits.join(',') + ')');
      } else if (typeof v === 'boolean') {
        if (v) parts.push(label);
      } else {
        parts.push(label + ' = ' + v);
      }
    }
    return parts.join(' 且 ');
  }
  function effSummary(eff) {
    var t = opLabel(eff.op);
    var bits = [];
    for (var k of ['value', 'damage', 'count', 'max', 'cap', 'faces', 'manaCost', 'selfDamage', 'winDamage', 'loseDamage',
      'treasure', 'spell', 'heal', 'winMana', 'absorbs', 'realm', 'turns', 'min', 'reflect', 'on', 'name', 'names', 'deck', 'block']) {
      if (eff[k] === undefined) continue;
      var label = (S.meta.fieldLabels && S.meta.fieldLabels[k] && S.meta.fieldLabels[k].label) || k;
      bits.push(label + '=' + (Array.isArray(eff[k]) ? eff[k].join('/') : String(eff[k])));
    }
    var c = condSummary(eff.if);
    return t + (bits.length ? '（' + bits.join('，') + '）' : '') + (c ? ' ［若 ' + c + '］' : '');
  }
  function allEffects(card) {
    var out = [];
    for (var i = 0; i < (card.effects || []).length; i++) out.push({ eff: card.effects[i], where: '主效果', tier: -1, index: i });
    for (var t = 0; t < (card.tiers || []).length; t++) {
      var list = card.tiers[t].effects || [];
      for (var j = 0; j < list.length; j++) out.push({ eff: list[j], where: '第 ' + (t + 1) + ' 档', tier: t, index: j });
    }
    return out;
  }
  function unknownOps(card) {
    var out = [];
    allEffects(card).forEach(function (x) { if (!x.eff.op || !isKnownOp(x.eff.op)) out.push(x); });
    return out;
  }

  // ================================================================ 载入
  // ⚠️ 必须看 r.ok：服务端出错时返回的是 `{error:'…'}` 的 JSON（例如目标卡池文件不存在 → 404）。
  //    旧写法直接 `r.json()` 会"成功地"拿到一个没有 pool 的对象 → 界面变成空列表 +「载入中…」，
  //    用户完全看不出哪里错了（实测：把 --cards 指到一个不存在的文件就是这样静默装死）。
  function get(url) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error((body && body.error) || ('HTTP ' + r.status + ' ' + url));
        return body;
      });
    });
  }

  function boot() {
    Promise.all([get('/api/meta'), get('/api/cards'), get('/api/state')]).then(function (res) {
      S.meta = res[0];
      S.fieldSeen = S.meta.fieldSeen || {};
      var cards = res[1];
      var state = res[2];
      S.pool = cards.pool;
      // ⭐ 「加载时那份」的**副本**：差异视图（与磁盘版本对比）与"恢复这张牌"都靠它。
      //    注意 S.pool 之后是被就地改的（界面上所有编辑都改它），所以必须留一份原始快照。
      try { S.poolBase = deepCopy(cards.pool); } catch (e) { S.poolBase = null; }
      // 存盘并发基线：本页"载入时的磁盘版本"。保存时回传给服务端 —— 磁盘要是被别人改过
      // （例如另一个会话直接编辑了 data/cards.json），服务端会 409 拦下来，见 doValidate。
      S.baseMtime = cards.mtime || null;
      S.file = cards.cardsFile;
      S.fileAbs = cards.cardsFileAbsolute;
      S.baseline = cards.baselineCounts || S.baseline;
      S.baselineTotal = cards.baselineTotal || 251;
      S.keepBackups = state.keepBackups || 10;
      renderFile(state, cards);
      renderCounts();
      renderList();
      renderForm();
      renderPreview();
      // 沙盒：默认收起（用户 2026-10-05："先设一个开关，不要常占着窗口下面"），
      // 上次展开过就记着；收起时不发 /api/simulate 的元数据请求，展开时才拉。
      try { SIM.open = localStorage.getItem(SIM_OPEN_KEY) === '1'; } catch (e) { SIM.open = false; }
      simApplyOpen();
      if (SIM.open) simLoadMeta();
      // 效果编辑视图：蓝图（默认）/ 表单，记住上次选择
      try { S.view = localStorage.getItem(VIEW_KEY) === 'form' ? 'form' : 'blueprint'; } catch (e) { S.view = 'blueprint'; }
      // 二期/三期的两个面板：默认收起，展开状态各自记着
      try {
        if (localStorage.getItem('fanren-editor-diff-open') === '1') {
          $('#diff-panel').classList.remove('hidden');
          $('#btn-diff-toggle').textContent = '差异 ▾';
          renderDiff();
        }
      } catch (e) { /* 忽略 */ }
      try { balanceSetOpen(localStorage.getItem('fanren-editor-balance-open') === '1'); } catch (e) { /* 忽略 */ }
      // 批量改张数面板：同样记住展开状态；展开时先算一遍"命中"
      try {
        if (localStorage.getItem('fanren-editor-bulk-open') === '1') {
          $('#bulk-panel').classList.remove('hidden');
          $('#btn-bulk-toggle').textContent = '批量张数 ▾';
        }
      } catch (e) { /* 忽略 */ }
      renderBulk();
      bindButtons();
      $('#ed-foot-info').textContent =
        '服务 pid ' + state.pid + ' · ' + state.host + ':' + state.port + ' · node ' + state.nodeVersion +
        ' · 校验镜像 ' + state.mirror + ' · 备份最多留 ' + S.keepBackups + ' 份';
    }).catch(function (e) {
      banner('载入失败：' + e.message + '（检查 --cards 指的卡池文件是否存在；编辑器服务还活着吗？）', true);
      // 列表区也留一句人话 —— 否则页面就停在"空列表 + 载入中…"，看起来像卡住了
      var box = $('#list');
      clear(box);
      box.appendChild(el('div', 'empty-hint', '卡池读不出来：' + e.message));
      var lc = $('#list-count');
      if (lc) lc.textContent = '载入失败';
    });
  }

  function renderFile(state, cards) {
    $('#ed-file-path').textContent = cards.cardsFile + (cards.cardsFileAbsolute && cards.cardsFileAbsolute !== S.fileAbs ? '' : '');
    var badge = $('#ed-file-state');
    badge.className = 'ed-badge';
    badge.textContent = state.backups && state.backups.length ? ('备份 ' + state.backups.length + ' 份') : '无备份';
    $('#ed-file').title = cards.cardsFileAbsolute + '\n' + (cards.mtime || '');
  }

  function banner(text, bad) {
    var b = $('#ed-banner');
    if (!text) { b.classList.add('hidden'); return; }
    b.textContent = text;
    b.style.borderColor = bad ? 'rgba(212,87,78,.6)' : 'rgba(217,177,104,.5)';
    b.style.color = bad ? '#f0b3ad' : 'var(--gold-2)';
    b.classList.remove('hidden');
  }

  // ================================================================ 左：列表
  function counts() {
    var out = { kinds: {}, cards: {}, total: 0 };
    DECK_ORDER.forEach(function (d) {
      var arr = S.pool[d] || [];
      out.kinds[d] = arr.length;
      out.cards[d] = arr.reduce(function (s, c) { return s + (typeof c.count === 'number' ? c.count : 0); }, 0);
      out.total += out.cards[d];
    });
    return out;
  }

  function renderCounts() {
    var box = $('#ed-counts');
    clear(box);
    var c = counts();
    // 张数：**按你改的算**（不再和官方基线硬比），只有"改了但没保存"时标黄
    DECK_ORDER.forEach(function (d) {
      var n = el('span', 'cc ok');
      n.appendChild(el('b', null, DECK_CN[d] + ' ' + c.cards[d]));
      var base = S.baseline[d];
      var diff = c.cards[d] - base;
      n.appendChild(document.createTextNode(' 张·' + c.kinds[d] + '种' +
        (diff ? '（基线 ' + base + '，' + (diff > 0 ? '+' : '') + diff + '）' : '')));
      box.appendChild(n);
    });
    var t = el('span', 'cc ok');
    t.appendChild(el('b', null, '合计 ' + c.total));
    var td = c.total - S.baselineTotal;
    t.appendChild(document.createTextNode(' 张' + (td ? '（基线 ' + S.baselineTotal + '，' + (td > 0 ? '+' : '') + td + '）' : '')));
    box.appendChild(t);
  }

  function matchCard(card) {
    var q = S.search.trim().toLowerCase();
    if (!q) return true;
    var hay = [card.name, card.id, card.text, card.cat, card.type, card.equipSlot].join('\n').toLowerCase();
    if (hay.indexOf(q) >= 0) return true;
    return allEffects(card).some(function (x) { return (x.eff.op || '').toLowerCase().indexOf(q) >= 0; });
  }

  function renderList() {
    var box = $('#list');
    clear(box);
    var total = 0, shown = 0, unknownCount = 0;
    DECK_ORDER.forEach(function (d) {
      var arr = S.pool[d] || [];
      var list = arr.filter(matchCard);
      total += arr.length;
      shown += list.length;
      var head = el('div', 'grp-head dk-' + d);
      head.appendChild(el('span', null, DECK_CN[d]));
      var n = el('span', 'grp-n', list.length + '/' + arr.length + ' 种');
      head.appendChild(n);
      // ⭐ 二期：每个牌堆一个「＋ 新建卡」（建在这个牌堆里，建完直接选中）
      var add = el('button', 'btn btn-mini btn-cyan', '＋ 新建卡');
      add.type = 'button';
      add.title = '在【' + DECK_CN[d] + '】里新建一张卡（count 默认 0＝先进编辑器，确认后再调张数）';
      add.addEventListener('click', function (ev) { ev.stopPropagation(); newCard(d); });
      head.appendChild(add);
      box.appendChild(head);
      if (!list.length) box.appendChild(el('div', 'empty-hint', '（没有匹配的牌）'));
      list.forEach(function (card) {
        var unk = unknownOps(card);
        unknownCount += unk.length;
        var row = el('button', 'card-row' + (card.tiers && card.tiers.length ? ' is-tiers' : ''));
        row.type = 'button';
        if (S.sel && S.sel.deck === d && S.sel.id === card.id) row.classList.add('on');
        var cost = el('span', 'cr-cost' + (typeof card.cost === 'number' && card.cost > 0 ? '' : ' none'),
          typeof card.cost === 'number' ? card.cost : '—');
        row.appendChild(cost);
        var name = el('span', 'cr-name', card.name || '(无名)');
        row.appendChild(name);
        if (S.dirty[card.id]) row.appendChild(el('span', 'cr-dot', ''));
        row.appendChild(el('span', 'cr-tag', card.count + '张'));
        if (unk.length) {
          var b = el('span', 'cr-bad', '幽灵 ×' + unk.length);
          b.title = '这些效果的 op 不在引擎元数据表里：' + unk.map(function (x) { return x.eff.op; }).join(', ');
          row.appendChild(b);
        }
        row.addEventListener('click', function () { selectCard(d, card.id); });
        box.appendChild(row);
      });
    });
    $('#list-count').textContent = '共 ' + total + ' 种' + (S.search ? '（筛出 ' + shown + '）' : '');
    if (unknownCount) {
      banner('⚠ 当前卡池里有 ' + unknownCount + ' 条效果的 op 不在引擎元数据表（effect-meta.js）里，已用红色标出 —— 引擎不会执行它们（"只写不读的幽灵效果"）。', true);
    } else {
      banner('', false);
    }
  }

  function selectCard(deck, id) {
    S.sel = { deck: deck, id: id };
    renderList();
    renderForm();
    renderPreview();
    var body = $('#form');
    if (body) body.scrollTop = 0;
  }

  function findCard() {
    if (!S.sel) return null;
    var arr = S.pool[S.sel.deck] || [];
    for (var i = 0; i < arr.length; i++) if (arr[i].id === S.sel.id) return arr[i];
    return null;
  }
  function currentDeck() { return S.sel ? S.sel.deck : null; }
  function markDirty() {
    if (S.sel) S.dirty[S.sel.id] = true;
    renderCounts();
    renderList();
    renderPreview();
    if (diffOpen()) renderDiff();      // 差异面板开着就跟着刷新（改一个字段立刻能看到 old → new）
  }

  /** 只把某张卡标脏（不重绘）—— 批量操作里一次标一堆，重绘由调用方统一做 */
  function markDirtyCard(id) { if (id) S.dirty[id] = true; }

  // ================================================================ 中：表单
  function renderForm() {
    var box = $('#form');
    clear(box);
    var card = findCard();
    var title = $('#form-title');
    if (!card) {
      title.textContent = '从左边选一张牌';
      box.appendChild(el('p', 'empty-hint',
        '左边点一张牌开始编辑。\n\n· 所有下拉选项都来自 server/effect-meta.js（时点 / op / 条件 / 比较符）\n' +
        '· 保存前依次跑：结构预检 → 参数/时点接线 → lint-cards → verify-dsl → 牌堆自洽（张数不固定）\n' +
        '· 任何一步不过都不写盘，校验器输出原样显示在下面的面板\n' +
        '· 写盘前自动备份 <目标文件>.bak-editor-<时间戳>，最多留 ' + S.keepBackups + ' 份'));
      return;
    }
    title.textContent = DECK_CN[currentDeck()] + ' · ' + card.name;

    // ⭐ 卡级操作条：**删除这张卡** / **恢复到磁盘版**（只在"与磁盘版不同"时才出现后者）
    var bar = el('div', 'card-ops');
    var changed = cardDiff(card);
    if (changed && changed.added) bar.appendChild(el('span', 'warn', '这是一张**还没保存**的新卡'));
    else if (changed && changed.changed) bar.appendChild(el('span', 'warn', '与磁盘版不同（' + changed.fields.length + ' 个字段）'));
    var del = el('button', 'btn btn-mini btn-danger', '删除此卡');
    del.type = 'button';
    del.title = '从卡池里删掉（保存前只在界面上生效；保存时会跑校验）';
    del.addEventListener('click', function () { deleteCard(card); });
    bar.appendChild(del);
    if (changed && changed.changed) {
      var revert = el('button', 'btn btn-mini btn-ghost', '恢复成磁盘版');
      revert.type = 'button';
      revert.addEventListener('click', function () { revertCard(card); });
      bar.appendChild(revert);
    }
    box.appendChild(bar);

    box.appendChild(cardFieldsSection(card));
    box.appendChild(effectsSection(card));
    box.appendChild(tiersSection(card));
  }

  // ================================================================ 二期：新建 / 删除 / 差异
  /**
   * 新卡的 id：跟池子里一样是 `k_` + 牌名的 UTF-8 十六进制（例：青冥针 → k_e99d92...）。
   * 撞了就加 `_2`、`_3`…；改牌名**不会**自动改 id（id 是主键，改名请另存新卡再删旧卡）。
   */
  function cardIdFor(name, deck) {
    var hex = '';
    try {
      var bytes = new TextEncoder().encode(String(name));
      for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    } catch (e) { hex = String(Date.now().toString(16)); }
    var base = 'k_' + hex, id = base, n = 2;
    var exists = function (x) { return DECK_ORDER.some(function (d) { return (S.pool[d] || []).some(function (c) { return c.id === x; }); }); };
    while (exists(id)) { id = base + '_' + n; n++; }
    void deck;
    return id;
  }

  /** 新建一张卡（放进指定的牌堆，默认按牌堆给个合理的 type），建完立刻选中它 */
  function newCard(deck) {
    var d = deck || (S.sel ? S.sel.deck : DECK_ORDER[0]);
    S.pool[d] = S.pool[d] || [];
    var name = '新卡 ' + (S.pool[d].length + 1);
    var card = {
      id: cardIdFor(name, d),
      name: name,
      type: d === 'companion' ? 'companion' : (d === 'qi' ? 'consume' : 'consume'),
      cost: d === 'companion' ? null : 0,
      realm: 0,
      count: 0,                 // 新卡先 0 张（不进牌堆），想清楚效果再往上调 —— 与"实物卡入库"的老做法一致
      cat: d === 'companion' ? '修士' : '',
      text: '（新卡）写清卡面文案。',
      effects: [],
    };
    S.pool[d].push(card);
    markDirty(card.id);
    S.sel = { deck: d, id: card.id };
    renderCounts(); renderList(); renderForm(); renderPreview();
    banner('已新建【' + name + '】：先写卡面与效果，**count 默认 0（不进牌堆）**，确认没问题再调张数。', false);
    return card;
  }

  /** 删除一张卡：先查"有没有别的牌按牌名引用它"，把引用的牌列出来让用户确认 */
  function deleteCard(card) {
    var refs = refsToName(card.name, card.id);
    var msg = '确定删除【' + card.name + '】吗？（保存前只在界面上生效）';
    if (refs.length) msg += '\n\n⚠ 有 ' + refs.length + ' 处**按牌名引用**它，删掉后这些引用会指向不存在的牌：\n· ' + refs.slice(0, 8).join('\n· ');
    if (!window.confirm(msg)) return;
    var deck = currentDeck();
    var arr = S.pool[deck] || [];
    var i = arr.findIndex(function (c) { return c.id === card.id; });
    if (i < 0) return;
    var gone = arr.splice(i, 1)[0];
    markDirty(gone.id);
    banner('已删除【' + (gone.name || gone.id) + '】（界面上）。保存时校验会跑；真删掉的是磁盘那份要等写盘。', false);
    S.sel = null;
    renderCounts(); renderList(); renderForm(); renderPreview();
    if (diffOpen()) renderDiff();
  }

  /** 卡池里其它牌**按牌名**引用这张卡的地方（learnRequires / if.companion / grant_spell.name …） */
  function refsToName(name, selfId) {
    var out = [];
    if (!name) return out;
    DECK_ORDER.forEach(function (d) {
      (S.pool[d] || []).forEach(function (c) {
        if (c.id === selfId) return;
        var hit = [];
        var scan = function (o, path) {
          if (o == null) return;
          if (typeof o === 'string') { if (o === name) hit.push(path); return; }
          if (Array.isArray(o)) { o.forEach(function (x, i) { scan(x, path + '[' + i + ']'); }); return; }
          if (typeof o === 'object') {
            Object.keys(o).forEach(function (k) { scan(o[k], path + '.' + k); });
          }
        };
        ['learnRequires', 'if', 'effects', 'tiers'].forEach(function (k) { if (c[k] != null) scan(c[k], k); });
        if (hit.length) out.push('【' + (c.name || c.id) + '】' + hit.slice(0, 3).join('、'));
      });
    });
    return out;
  }

  /** 与磁盘版（S.poolBase）比这张卡：{added} 新增 / {changed, fields} 改动 / null 无变化 */
  function cardDiff(card) {
    if (!S.poolBase || !card) return null;
    var deck = currentDeck();
    var base = (S.poolBase[deck] || []).find(function (c) { return c.id === card.id; });
    if (!base) return { added: true, changed: false, fields: [] };
    var keys = {};
    Object.keys(base).forEach(function (k) { keys[k] = 1; });
    Object.keys(card).forEach(function (k) { keys[k] = 1; });
    var fields = Object.keys(keys).filter(function (k) {
      return JSON.stringify(base[k]) !== JSON.stringify(card[k]);
    });
    return { added: false, changed: fields.length > 0, fields: fields };
  }

  /** 把这张卡恢复成磁盘上那一版（只恢复这一张，别的改动不动） */
  function revertCard(card) {
    if (!S.poolBase) return;
    var deck = currentDeck();
    var base = (S.poolBase[deck] || []).find(function (c) { return c.id === card.id; });
    if (!base) return;
    var arr = S.pool[deck] || [];
    var i = arr.findIndex(function (c) { return c.id === card.id; });
    if (i < 0) return;
    arr[i] = deepCopy(base);
    delete S.dirty[card.id];
    renderCounts(); renderList(); renderForm(); renderPreview();
    if (diffOpen()) renderDiff();
    banner('【' + base.name + '】已恢复成磁盘版。', false);
  }

  function diffOpen() { var p = $('#diff-panel'); return !!(p && !p.classList.contains('hidden')); }

  /** 差异总览：新增 / 删除 / 改动（逐卡逐字段 old → new） */
  function renderDiff() {
    var box = $('#diff');
    if (!box) return;
    clear(box);
    if (!S.poolBase) { box.appendChild(el('p', 'empty-hint', '没有基准快照（页面可能没载入完），点一次「重新比对」试试。')); return; }
    var added = [], removed = [], changed = [];
    DECK_ORDER.forEach(function (d) {
      var cur = S.pool[d] || [], base = S.poolBase[d] || [];
      cur.forEach(function (c) {
        var b = base.find(function (x) { return x.id === c.id; });
        if (!b) { added.push({ deck: d, card: c }); return; }
        var keys = {};
        Object.keys(b).forEach(function (k) { keys[k] = 1; });
        Object.keys(c).forEach(function (k) { keys[k] = 1; });
        var fs = Object.keys(keys).filter(function (k) { return JSON.stringify(b[k]) !== JSON.stringify(c[k]); });
        if (fs.length) changed.push({ deck: d, card: c, base: b, fields: fs });
      });
      base.forEach(function (b) {
        if (!cur.some(function (c) { return c.id === b.id; })) removed.push({ deck: d, card: b });
      });
    });
    var sub = $('#diff-sub');
    if (sub) sub.textContent = '新增 ' + added.length + ' · 删除 ' + removed.length + ' · 改动 ' + changed.length
      + '（基准＝载入时磁盘上那份）';
    if (!added.length && !removed.length && !changed.length) {
      box.appendChild(el('p', 'empty-hint', '✓ 与磁盘版一致（没有未保存的改动）。'));
      return;
    }
    var short = function (v) {
      var s = typeof v === 'string' ? v : JSON.stringify(v);
      if (s == null) s = String(v);
      return s.length > 90 ? s.slice(0, 90) + '…' : s;
    };
    var sec = function (title, list, kind) {
      if (!list.length) return;
      box.appendChild(el('div', 'diff-head', title + '（' + list.length + '）'));
      list.forEach(function (x) {
        var row = el('div', 'diff-row');
        var head = el('div', 'diff-card', '[' + DECK_CN[x.deck] + '] 【' + (x.card.name || x.card.id) + '】');
        if (kind !== 'removed') {
          var go = el('button', 'btn btn-mini btn-ghost', '定位');
          go.type = 'button';
          go.addEventListener('click', function () { selectCard(x.deck, x.card.id); });
          head.appendChild(go);
        }
        row.appendChild(head);
        if (kind === 'changed') {
          x.fields.forEach(function (f) {
            var line = el('div', 'diff-field');
            line.appendChild(el('code', null, f));
            line.appendChild(el('span', 'diff-old', short(x.base[f])));
            line.appendChild(el('span', 'diff-arrow', '→'));
            line.appendChild(el('span', 'diff-new', short(x.card[f])));
            row.appendChild(line);
          });
        } else if (kind === 'added') {
          row.appendChild(el('div', 'diff-field', '（新卡：count ' + x.card.count + '，效果 ' + ((x.card.effects || []).length) + ' 条）'));
        } else {
          row.appendChild(el('div', 'diff-field', '（磁盘上有、界面上已删掉）'));
        }
        box.appendChild(row);
      });
    };
    sec('新增', added, 'added');
    sec('删除', removed, 'removed');
    sec('改动', changed, 'changed');
  }

  // ================================================================ 批量改张数
  //  用户 2026-10-05 要的："法术类全选所有牌，张数整体加减一"这种批量操作。
  //  拆成两步：① 先按 牌堆 / 境界 / 当前搜索 筛出"命中"，逐个列出来（可单独勾掉）；
  //            ② 对**勾选的**卡执行 ＋1 / －1 / 设为 N。
  //  预览里直接写清每张牌的 `旧 → 新`，点应用才真改（改的仍是界面上那份卡池，保存时照旧过五步闸门）。
  var BULK = {
    decks: { treasure: true, spell: true, companion: true, qi: false },
    realm: 'all',
    inSearch: false,
    skipZero: false,
    op: '+1',
    value: 3,
    picked: {},        // 'deck|id' -> true（默认跟随"命中"，用户可单独取消）
  };

  function bulkKey(deck, id) { return deck + '|' + id; }

  /** 当前筛选命中的卡：{deck, card}[] */
  function bulkCandidates() {
    var out = [];
    DECK_ORDER.forEach(function (d) {
      if (!BULK.decks[d]) return;
      (S.pool[d] || []).forEach(function (card) {
        if (BULK.realm !== 'all' && String(card.realm == null ? 0 : card.realm) !== String(BULK.realm)) return;
        if (BULK.inSearch && !matchCard(card)) return;
        if (BULK.skipZero && (card.count || 0) === 0) return;
        out.push({ deck: d, card: card });
      });
    });
    return out;
  }

  /** 这张卡按当前操作会变成几（负数/非法值夹到 0；上限 99） */
  function bulkNext(card) {
    var cur = typeof card.count === 'number' ? card.count : 0;
    var next = cur;
    if (BULK.op === '+1') next = cur + 1;
    else if (BULK.op === '-1') next = cur - 1;
    else if (BULK.op === 'set') next = Number(BULK.value);
    if (!isFinite(next)) next = cur;
    return Math.max(0, Math.min(99, Math.round(next)));
  }

  function bulkRenderDecks() {
    var box = $('#bulk-decks');
    if (!box) return;
    clear(box);
    DECK_ORDER.forEach(function (d) {
      var lab = el('label', 'bulk-deck');
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!BULK.decks[d];
      cb.addEventListener('change', function () { BULK.decks[d] = cb.checked; BULK.picked = {}; renderBulk(); });
      lab.appendChild(cb);
      lab.appendChild(el('span', null, DECK_CN[d]));
      box.appendChild(lab);
    });
  }

  function renderBulk() {
    var box = $('#bulk-preview');
    if (!box) return;
    bulkRenderDecks();
    clear(box);
    var cands = bulkCandidates();
    var hitEl = $('#bulk-hit');
    var willChange = cands.filter(function (x) { return bulkNext(x.card) !== (x.card.count || 0); });
    if (hitEl) hitEl.textContent = '命中 ' + cands.length + ' 张（其中 ' + willChange.length + ' 张会变）';
    if (!cands.length) {
      box.appendChild(el('div', 'bulk-empty', '没有命中任何卡（换个牌堆 / 境界，或清掉搜索）。'));
      return;
    }
    cands.forEach(function (x) {
      var key = bulkKey(x.deck, x.card.id);
      // 默认全选；用户手动取消过的记住（BULK.picked[key] === false）
      var on = BULK.picked[key] !== false;
      var row = el('label', 'bulk-item' + (bulkNext(x.card) === (x.card.count || 0) ? ' unchanged' : ''));
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = on;
      cb.className = 'bulk-cb';
      cb.addEventListener('change', function () {
        BULK.picked[key] = cb.checked;
        var h = $('#bulk-hit');
        if (h) {
          var n = bulkCandidates().filter(function (y) { return BULK.picked[bulkKey(y.deck, y.card.id)] !== false; }).length;
          h.textContent = '命中 ' + cands.length + ' 张（已勾选 ' + n + ' 张）';
        }
      });
      row.appendChild(cb);
      row.appendChild(el('span', 'bi-name', '[' + DECK_CN[x.deck] + '] 【' + (x.card.name || x.card.id) + '】'));
      row.appendChild(el('span', 'bi-old', (x.card.count || 0) + ' 张'));
      row.appendChild(el('span', 'diff-arrow', '→'));
      row.appendChild(el('span', 'bi-new', bulkNext(x.card) + ' 张'));
      box.appendChild(row);
    });
  }

  /** 执行批量操作（只改勾选的；改完标脏 + 刷新列表/计数/差异） */
  function applyBulk() {
    var cands = bulkCandidates().filter(function (x) { return BULK.picked[bulkKey(x.deck, x.card.id)] !== false; });
    if (!cands.length) { banner('没有勾选任何卡。', true); return; }
    var changed = 0, delta = 0;
    cands.forEach(function (x) {
      var before = typeof x.card.count === 'number' ? x.card.count : 0;
      var next = bulkNext(x.card);
      if (next === before) return;
      x.card.count = next;
      delta += next - before;
      changed++;
      markDirtyCard(x.card.id);
    });
    renderCounts(); renderList(); renderForm(); renderPreview();
    if (diffOpen()) renderDiff();
    renderBulk();
    banner('批量改张数：改了 ' + changed + ' 张卡（' + (delta >= 0 ? '+' : '') + delta + ' 张合计）。'
      + '这是界面上那份卡池，点「保存（先校验）」才会写盘。', false);
  }

  // ================================================================ 三期：平衡试跑
  function balanceSetOpen(v) {
    S.balanceOpen = !!v;
    try { localStorage.setItem('fanren-editor-balance-open', S.balanceOpen ? '1' : '0'); } catch (e) { /* 忽略 */ }
    var panel = $('#balance-panel');
    if (panel) panel.classList.toggle('hidden', !S.balanceOpen);
    var btn = $('#btn-balance-toggle');
    if (btn) btn.textContent = S.balanceOpen ? '平衡试跑 ▾' : '平衡试跑 ▸';
  }
  function runBalance() {
    var box = $('#balance');
    var games = Math.max(1, Math.min(200, Number(($('#balance-games') || {}).value) || 12));
    clear(box);
    box.appendChild(el('p', 'muted', '跑着呢……（每档 ' + games + ' 局，临时镜像里跑，不影响线上）'));
    var btn = $('#btn-balance-run'); if (btn) btn.disabled = true;
    post('/api/balance', { games: games, cards: S.pool }).then(function (r) {
      var b = (r && r.body) || {};
      clear(box);
      var head = el('div', 'bal-head', '每档 ' + (b.games == null ? '?' : b.games) + ' 局 · ' + (b.ok ? '✓ 跑完' : '✗ 跑失败（看下面的输出）'));
      box.appendChild(head);
      var pre = el('pre', 'bal-out');
      pre.textContent = b.output || b.error || '(无输出)';
      box.appendChild(pre);
    }).catch(function (e) {
      clear(box);
      box.appendChild(el('p', 'warn', '平衡试跑失败：' + e.message));
    }).then(function () { if (btn) btn.disabled = false; });
  }


  /** 卡级字段：已知字段 + 其它字段 */
  function cardFieldsSection(card) {
    var sec = el('div', 'sec');
    var head = el('div', 'sec-head');
    head.appendChild(el('span', null, '卡面字段'));
    head.appendChild(el('span', 'muted', '牌名 / 牌堆 / 类型 / 角标法力 / 适用境界 / 张数 / 占位 / 装备位 / 文本'));
    sec.appendChild(head);

    var grid = el('div', 'fgrid');
    var deck = currentDeck();
    cardSpecs(card, deck).forEach(function (spec) {
      grid.appendChild(fieldControl(spec, card, function (v) { setCardField(card, spec, v); }));
    });
    sec.appendChild(grid);

    var extras = Object.keys(card).filter(function (k) { return KNOWN_CARD_KEYS.indexOf(k) < 0; });
    if (extras.length) {
      var sub = el('div', 'sec');
      sub.appendChild(el('div', 'sec-head', '其它字段（数据里有、编辑器没登记 —— 仍可编辑）'));
      var g2 = el('div', 'fgrid');
      extras.forEach(function (k) {
        g2.appendChild(fieldControl(genericSpec(k, card[k]), card, function (v) { setCardField(card, { k: k, generic: true }, v); }));
      });
      sub.appendChild(g2);
      sec.appendChild(sub);
    }
    return sec;
  }

  function cardSpecs(card, deck) {
    var out = [];
    var deckOpts = DECK_ORDER.map(function (d) { return [d, DECK_CN[d]]; });
    out.push({ k: 'name', label: '牌名', t: 'str' });
    out.push({ k: 'deck', label: '牌堆（改这里=把这张牌搬到另一堆）', t: 'enum', opts: deckOpts, virtual: true });
    out.push({ k: 'type', label: '类型', t: 'enum', opts: TYPE_OPTS[deck] || TYPE_OPTS.treasure });
    out.push({ k: 'cat', label: '品类（实物卡面分类）', t: 'str', optional: true });
    if (deck === 'treasure' || deck === 'spell') {
      out.push({ k: 'cost', label: '角标法力', t: 'num', nullable: true });
      out.push({ k: 'equipCost', label: '装备时消耗法力（可选）', t: 'optInt' });
    } else {
      out.push({ k: 'cost', label: '角标法力（这堆没有 → 留空 = null）', t: 'num', nullable: true });
    }
    out.push({
      k: 'realm', label: '适用境界', t: 'enum',
      opts: [[0, '凡人（0）'], [1, '炼气期（1）'], [2, '筑基期（2）'], [3, '结丹期（3）'], [4, '元婴期（4）']],
      numeric: true,
    });
    out.push({ k: 'count', label: '张数 count（牌堆里放几张）', t: 'int' });
    // ⭐ 2026-10-05 用户裁定：只有带「应对」的卡/效果才能进【斗法】链（＝能被破招）。
    //    只在**响应型窗口**上问（被指定为目标/对战可选发动/对方出牌/投骰前后/对战结算/受伤）；
    //    阶段内可选窗口（探索替换、晋升减消耗…）不算破招，不用勾。
    out.push({ k: 'response', label: '应对（勾上才能被破招·进斗法链）', t: 'optBool' });
    // 卡面"此【宝物牌】可使用2次"——整局可用次数（用完不再被摆出来问，卡留在场上）
    out.push({ k: 'uses', label: '可用次数 uses（卡面"可使用N次"，留空=不限）', t: 'optInt' });
    if (card.type === 'companion') {
      out.push({ k: 'slots', label: '占位 slots（占几个放置位）', t: 'optInt' });
      out.push({ k: 'absorb', label: '替挡次数 absorb（可替你承受任意 N 次伤害）', t: 'optInt' });
      out.push({ k: 'activateDiscardSelf', label: '主动发动后自身进弃牌堆', t: 'optBool' });
      out.push({ k: 'cardCostDiscount', label: '用宝物/法术牌时法力 -（最低 1）', t: 'optInt' });
    }
    if (deck === 'treasure' || deck === 'spell') {
      out.push({ k: 'equipSlot', label: '装备位 equipSlot（如 puppet = 傀儡位）', t: 'optStr' });
    }
    out.push({ k: 'note', label: '备注 note（给人看，引擎不读）', t: 'optStr' });
    out.push({ k: 'id', label: 'ID id（唯一标识，一般别改）', t: 'str' });
    out.push({ k: 'text', label: '卡文 text（玩家看到的那段字）', t: 'textarea', wide: true });
    return out;
  }

  /** 通用字段描述（其它字段 / 效果参数都用它） */
  function genericSpec(key, value) {
    var known = (S.meta.fieldLabels && S.meta.fieldLabels[key]) || null;
    var t = 'str';
    if (typeof value === 'number') t = 'num';
    else if (typeof value === 'boolean') t = 'bool';
    else if (Array.isArray(value)) t = value.every(function (x) { return typeof x === 'number'; }) ? 'intlist' : 'strlist';
    else if (isPlainObj(value)) t = 'json';
    return { k: key, label: (known && known.label) || key, t: t, optional: true, generic: true };
  }

  function setCardField(card, spec, value) {
    var k = spec.k;
    if (k === 'deck' && spec.virtual) {
      moveCard(S.sel.deck, card, value);
      return;
    }
    if (spec.optional && (value === '' || value === undefined)) delete card[k];
    else if (spec.nullable && (value === '' || value === null)) card[k] = null;
    else if (value === '') delete card[k];
    else card[k] = value;
    markDirty();
    if (k === 'name') $('#form-title').textContent = DECK_CN[currentDeck()] + ' · ' + card.name;
    if (k === 'count' || k === 'realm' || k === 'slots') renderCounts();
  }

  function moveCard(fromDeck, card, toDeck) {
    if (!toDeck || toDeck === fromDeck) return;
    var from = S.pool[fromDeck] || [];
    var i = from.indexOf(card);
    if (i >= 0) from.splice(i, 1);
    S.pool[toDeck] = S.pool[toDeck] || [];
    S.pool[toDeck].push(card);
    S.sel = { deck: toDeck, id: card.id };
    markDirty();
    renderCounts();
    renderList();
    renderForm();
    renderPreview();
  }

  /** 一个输入控件（由 spec 驱动） */
  function fieldControl(spec, holder, onChange) {
    var wrap = el('label', 'fld' + (spec.wide ? ' wide' : ''));
    var val = holder[spec.k];
    var lab = el('span', null, spec.label);
    wrap.appendChild(lab);
    var ctl;

    if (spec.t === 'enum') {
      ctl = el('select');
      (spec.opts || []).forEach(function (o) {
        var v = String(o[0]), label = o[1];
        var selected = spec.numeric ? String(val) === v : String(val === undefined ? '' : val) === v;
        ctl.appendChild(opt(v, label, selected));
      });
      if (spec.numeric) {
        ctl.addEventListener('change', function () { onChange(Number(ctl.value)); });
      } else {
        ctl.addEventListener('change', function () { onChange(ctl.value); });
      }
      ctl.value = spec.numeric ? String(val == null ? 0 : val) : String(val == null ? '' : val);
      wrap.appendChild(ctl);
      if (!spec.numeric && String(val) !== '' && val !== undefined &&
        !(spec.opts || []).some(function (o) { return String(o[0]) === String(val); })) {
        wrap.appendChild(el('span', 'warn', '当前值「' + val + '」不在可选项里（保存前先改掉，否则校验器会拦）'));
      }
    } else if (spec.t === 'bool' || spec.t === 'optBool') {
      var row = el('span', 'fld-row-check');
      ctl = document.createElement('input');
      ctl.type = 'checkbox';
      ctl.checked = !!val;
      ctl.addEventListener('change', function () { onChange(ctl.checked); });
      row.appendChild(ctl);
      row.appendChild(el('span', 'hint', ctl.checked ? '是' : '否'));
      ctl.addEventListener('change', function () { row.lastChild.textContent = ctl.checked ? '是' : '否'; });
      wrap.appendChild(row);
    } else if (spec.t === 'textarea') {
      ctl = el('textarea');
      ctl.value = val == null ? '' : String(val);
      ctl.addEventListener('input', function () { onChange(ctl.value); });
      wrap.appendChild(ctl);
    } else if (spec.t === 'intlist' || spec.t === 'strlist') {
      ctl = el('input');
      ctl.type = 'text';
      ctl.value = Array.isArray(val) ? val.join(', ') : (val == null ? '' : String(val));
      ctl.placeholder = spec.t === 'intlist' ? '用逗号分隔，如 1, 3, 6' : '用逗号分隔，如 补气丹, 回气丹';
      ctl.addEventListener('change', function () {
        var parts = ctl.value.split(/[,，、\s]+/).filter(Boolean);
        if (!parts.length) { onChange(''); return; }
        onChange(spec.t === 'intlist' ? parts.map(Number) : parts);
      });
      wrap.appendChild(ctl);
    } else if (spec.t === 'json') {
      ctl = el('textarea');
      ctl.value = JSON.stringify(val, null, 2);
      ctl.addEventListener('change', function () {
        try { onChange(JSON.parse(ctl.value)); ctl.style.borderColor = ''; }
        catch (e) { ctl.style.borderColor = 'var(--danger)'; }
      });
      wrap.appendChild(ctl);
    } else if (spec.t === 'num' || spec.t === 'int' || spec.t === 'optInt') {
      ctl = el('input');
      ctl.type = 'number';
      ctl.value = (typeof val === 'number') ? String(val) : '';
      ctl.addEventListener('change', function () {
        if (ctl.value === '') { onChange(spec.nullable ? null : ''); return; }
        var n = Number(ctl.value);
        if (isNaN(n)) { ctl.value = ''; onChange(''); return; }
        onChange(spec.t === 'int' || spec.t === 'optInt' ? Math.round(n) : n);
      });
      wrap.appendChild(ctl);
    } else {
      ctl = el('input');
      ctl.type = 'text';
      ctl.value = val == null ? '' : String(val);
      ctl.addEventListener('input', function () { onChange(ctl.value); });
      wrap.appendChild(ctl);
    }

    if (spec.hint) wrap.appendChild(el('span', 'hint', spec.hint));
    if (spec.generic && S.fieldSeen && S.fieldSeen[spec.k] === false) {
      wrap.appendChild(el('span', 'warn', '⚠ 引擎源码里没读到这个字段名（可能是幽灵字段，写了也没人执行）'));
    }
    return wrap;
  }

  // ================================================================ 效果列表
  function effectsSection(card) {
    var sec = el('div', 'sec');
    var head = el('div', 'sec-head');
    head.appendChild(el('span', null, S.view === 'blueprint' ? '效果蓝图' : '效果列表 effects'));
    head.appendChild(el('span', 'muted', S.view === 'blueprint'
      ? '时机 → 条件 → 效果：同一时点的效果归在一个「时机」块里，投骰分支在块内展开'
      : '每条效果 = 时点 + 触发条件 + op + 参数'));
    var right = el('span', 'right');
    // 双视图切换：蓝图看结构，表单看全部字段（复杂卡 / 其它字段用表单）
    var vt = el('button', 'btn btn-mini btn-ghost', S.view === 'blueprint' ? '▤ 表单视图' : '◫ 蓝图视图');
    vt.type = 'button';
    vt.title = '蓝图视图：按「时机 → 条件 → 效果」分块看结构；表单视图：平铺全部字段';
    vt.addEventListener('click', function () {
      S.view = (S.view === 'blueprint') ? 'form' : 'blueprint';
      try { localStorage.setItem(VIEW_KEY, S.view); } catch (e) { /* 忽略 */ }
      renderForm();
    });
    right.appendChild(vt);
    var add = el('button', 'btn btn-mini btn-cyan', '＋ 加一条效果');
    add.type = 'button';
    add.addEventListener('click', function () {
      card.effects = card.effects || [];
      card.effects.push({ when: 'play', op: 'damage_target', value: 1 });
      markDirty(); renderForm();
    });
    right.appendChild(add);
    head.appendChild(right);
    sec.appendChild(head);

    if (!(card.effects || []).length) {
      sec.appendChild(el('div', 'empty-hint',
        '这张牌还没有效果。若卡文本来就写着「未拍到 / 待补」，空着是正常的（lint 会记为"未实装"，不算硬错误）。'));
    }
    if (S.view !== 'blueprint') {
      (card.effects || []).forEach(function (eff, i) {
        sec.appendChild(effEditor(card, eff, card.effects, i, '主效果', function () { markDirty(); renderForm(); }));
      });
      return sec;
    }
    // ---- 蓝图视图：按「时机」分块 ----
    var refresh = function () { markDirty(); renderForm(); };
    blueprintBlocks(card, card.effects, refresh).forEach(function (b) { sec.appendChild(b); });
    return sec;
  }

  /**
   * ⭐ 蓝图视图（2026-10-05 用户要的"蓝图式编辑效果"）：
   *   把一张牌的效果按**时机**分组，每组画成一个「时机 → 条件 → 效果」的块，块内每条效果是一条支线。
   *   三轴模型在这一屏同时呈现：轴 1 时机（块头）、轴 2 条件（支线里的条件行）、轴 3 效果（支线里的 op + 参数）。
   *   ⚠️ 编辑的还是**同一份 effects JSON**（没有中间格式、也不需要编译）——
   *   切回表单视图看到的就是这些改动，存盘/校验/沙盒全都直接生效。
   */
  function blueprintBlocks(card, list, refresh) {
    var out = [];
    if (!list || !list.length) return out;
    var groups = [], index = {};
    list.forEach(function (eff, i) {
      var key = timingKeysOf(eff).join(' + ') || '（未声明时点）';
      if (index[key] === undefined) { index[key] = groups.length; groups.push({ key: key, items: [] }); }
      groups[index[key]].items.push({ eff: eff, i: i });
    });
    groups.forEach(function (g, gi) {
      var block = el('div', 'bp-block');
      var h = el('div', 'bp-timing');
      h.appendChild(el('span', 'bp-n', '时机 ' + (gi + 1)));
      h.appendChild(el('span', 'bp-name', timingText(g.items[0].eff) || g.key));
      h.appendChild(el('span', 'bp-key', g.key));
      // 「应对」是"能不能被破招"的唯一判据，画在块头最显眼的位置
      var rFlag = card.response === true;
      var effFlag = g.items.some(function (m) { return m.eff.response === true; });
      var offFlag = g.items.every(function (m) { return m.eff.response === false; });
      var respTxt = offFlag ? '本条写了 response:false（不参与破招）'
        : (effFlag ? '应对（效果级）' : (rFlag ? '应对（卡级）' : '不带应对 —— 只在阶段内可选窗口问'));
      h.appendChild(el('span', 'badge ' + (rFlag || effFlag ? 'gold' : 'dim'), respTxt));
      if (card.uses) h.appendChild(el('span', 'badge dim', '可用 ' + card.uses + ' 次'));
      block.appendChild(h);
      g.items.forEach(function (m) {
        block.appendChild(el('div', 'bp-arrow', '↓'));
        var flow = el('div', 'bp-flow');
        flow.appendChild(effEditor(card, m.eff, list, m.i, '效果', refresh));
        block.appendChild(flow);
      });
      out.push(block);
    });
    return out;
  }

  /**
   * ⭐「掷骰分支」编辑器（roll_branch）：1~6 点每个点数点一下就归到某条支线，
   *   每条支线后面接自己的子效果（子效果不写时点，数字可用 $face / $lostHp 占位符）。
   *   这是蓝图里"是否要投骰子（值可多选，每个值后面都可接后面的效果）"那一层的落地。
   */
  function diceBranchEditor(eff, onStruct) {
    var box = el('div', 'bp-dice');
    if (!Array.isArray(eff.branches)) eff.branches = [];
    var FACES = [1, 2, 3, 4, 5, 6];

    var head = el('div', 'bp-dice-head');
    head.appendChild(el('span', null, '🎲 掷骰分支：勾点数 → 该点数走哪条支线，每条支线自己接效果'));
    var addB = el('button', 'btn btn-mini btn-cyan', '＋ 加一条支线');
    addB.type = 'button';
    addB.addEventListener('click', function () {
      eff.branches.push({ faces: [], effects: [] });
      markDirty(); onStruct();
    });
    head.appendChild(addB);
    box.appendChild(head);

    var used = {};
    eff.branches.forEach(function (b) { (b.faces || []).forEach(function (f) { used[f] = true; }); });

    eff.branches.forEach(function (br, bi) {
      var row = el('div', 'bp-branch');
      var faces = el('div', 'bp-faces');
      faces.appendChild(el('span', 'bp-branch-n', '支线 ' + (bi + 1)));
      FACES.forEach(function (f) {
        var on = (br.faces || []).indexOf(f) >= 0;
        var b = el('button', 'bp-face' + (on ? ' on' : ''), String(f));
        b.type = 'button';
        b.title = on ? ('把 ' + f + ' 点从这条支线去掉') : ('把 ' + f + ' 点归到这条支线');
        b.addEventListener('click', function () {
          br.faces = br.faces || [];
          var k = br.faces.indexOf(f);
          if (k >= 0) br.faces.splice(k, 1); else br.faces.push(f);
          br.faces.sort(function (x, y) { return x - y; });
          markDirty(); onStruct();
        });
        faces.appendChild(b);
      });
      var del = el('button', 'btn btn-mini btn-danger', '删支线');
      del.type = 'button';
      del.addEventListener('click', function () { eff.branches.splice(bi, 1); markDirty(); onStruct(); });
      faces.appendChild(del);
      row.appendChild(faces);
      row.appendChild(miniEffectList(br, 'effects', onStruct));
      box.appendChild(row);
    });

    // 兜底支线（没勾中的点数）
    var elseRow = el('div', 'bp-branch bp-else');
    var eh = el('div', 'bp-faces');
    eh.appendChild(el('span', 'bp-branch-n', '兜底'));
    var un = FACES.filter(function (f) { return !used[f]; });
    eh.appendChild(el('span', 'muted', un.length ? ('没勾中的点数（' + un.join('、') + '）') : '所有点数都勾完了'));
    elseRow.appendChild(eh);
    elseRow.appendChild(miniEffectList(eff, 'else', onStruct));
    box.appendChild(elseRow);

    box.appendChild(el('div', 'empty-hint',
      '子效果**不写时点**（跟着这次掷骰走）；数字可写占位符 "$face"（本次点数）、"$lostHp"（本次受伤扣的血）。\n' +
      '真实对局里点数是随机的；要在编辑器沙盒里复现，用沙盒的「骰点注入」。'));
    return box;
  }

  /** 子效果列表（掷骰支线用）：op 下拉（按大类分组）+ 参数 + 删除 */
  function miniEffectList(holder, key, onStruct) {
    var wrap = el('div', 'bp-sub');
    if (!Array.isArray(holder[key])) holder[key] = [];
    var list = holder[key];
    list.forEach(function (sub, si) {
      var row = el('div', 'bp-sub-row');
      var sel = el('select', 'input');
      sel.appendChild(opt('', '（选效果）', !sub.op));
      var table = ops();
      var groups = (S.meta && S.meta.opGroups) || [];
      var placed = {};
      groups.forEach(function (gn) {
        var g = el('optgroup'); g.label = gn;
        Object.keys(table).forEach(function (op) {
          if (table[op].group !== gn || op === 'roll_branch') return;   // 支线里不再套掷骰分支（免得无限嵌套）
          placed[op] = true;
          g.appendChild(opt(op, opLabelOf(op, table[op]), sub.op === op));
        });
        if (g.childNodes.length) sel.appendChild(g);
      });
      Object.keys(table).forEach(function (op) {
        if (placed[op] || op === 'roll_branch') return;
        sel.appendChild(opt(op, opLabelOf(op, table[op]), sub.op === op));
      });
      sel.addEventListener('change', function () { sub.op = sel.value; markDirty(); onStruct(); });
      row.appendChild(sel);

      // 参数：数字用文本框（允许 $face / $lostHp 占位符），布尔用勾选
      var hints = (S.meta.paramHints && S.meta.paramHints[sub.op]) || [];
      hints.forEach(function (h) {
        var v = sub[h.key];
        if (h.type === 'bool') {
          var lab = el('label', 'sim-check');
          var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!v;
          cb.addEventListener('change', function () { if (this.checked) sub[h.key] = true; else delete sub[h.key]; markDirty(); onStruct(); });
          lab.appendChild(cb); lab.appendChild(el('span', null, h.label));
          row.appendChild(lab);
        } else {
          var inp = el('input', 'input');
          inp.type = 'text';
          inp.style.width = '96px';
          inp.placeholder = h.label;
          inp.title = h.label + '（可写 $face / $lostHp）';
          inp.value = v === undefined ? '' : String(v);
          inp.addEventListener('change', function () {
            if (this.value === '') delete sub[h.key]; else sub[h.key] = this.value;
            markDirty(); onStruct();
          });
          row.appendChild(inp);
        }
      });
      var del = el('button', 'btn btn-mini btn-danger', '×');
      del.type = 'button';
      del.title = '删掉这条子效果';
      del.addEventListener('click', function () { list.splice(si, 1); markDirty(); onStruct(); });
      row.appendChild(del);
      wrap.appendChild(row);
    });
    var add = el('button', 'btn btn-mini btn-ghost', '＋ 子效果');
    add.type = 'button';
    add.addEventListener('click', function () { list.push({ op: '' }); markDirty(); onStruct(); });
    wrap.appendChild(add);
    return wrap;
  }

  function tiersSection(card) {
    var sec = el('div', 'sec');
    var head = el('div', 'sec-head');
    head.appendChild(el('span', null, '多境界档位 tiers'));
    head.appendChild(el('span', 'muted', '法术类装备：装备时选一档生效（每档：境界 / 文本 / 效果）'));
    var right = el('span', 'right');
    var add = el('button', 'btn btn-mini btn-cyan', '＋ 加一档');
    add.type = 'button';
    add.addEventListener('click', function () {
      card.tiers = card.tiers || [];
      card.tiers.push({ realm: card.tiers.length, text: '', effects: [] });
      markDirty(); renderForm();
    });
    right.appendChild(add);
    head.appendChild(right);
    sec.appendChild(head);

    if (!(card.tiers || []).length) {
      sec.appendChild(el('div', 'empty-hint', '没有档位（不是所有牌都需要）。加一档后记得把主效果也理顺 —— verify-dsl 会检查 tiers 里没有旧的 effect 槽。'));
    }
    (card.tiers || []).forEach(function (tier, ti) {
      var t = el('div', 'tier-card');
      var th = el('div', 'sec-head');
      th.appendChild(el('span', null, '第 ' + (ti + 1) + ' 档'));
      var tr = el('span', 'right');
      var up = el('button', 'btn btn-mini btn-ghost', '↑');
      up.type = 'button';
      up.addEventListener('click', function () { if (ti > 0) { swap(card.tiers, ti, ti - 1); markDirty(); renderForm(); } });
      var del = el('button', 'btn btn-mini btn-danger', '删除档位');
      del.type = 'button';
      del.addEventListener('click', function () { card.tiers.splice(ti, 1); markDirty(); renderForm(); });
      tr.appendChild(up); tr.appendChild(del);
      th.appendChild(tr);
      t.appendChild(th);

      var g = el('div', 'fgrid');
      g.appendChild(fieldControl({
        k: 'realm', label: '这一档适用境界', t: 'enum', numeric: true,
        opts: [[0, '凡人（0）'], [1, '炼气期（1）'], [2, '筑基期（2）'], [3, '结丹期（3）'], [4, '元婴期（4）']],
      }, tier, function (v) { tier.realm = v; markDirty(); renderPreview(); }));
      g.appendChild(fieldControl({ k: 'text', label: '这一档的卡文', t: 'textarea', wide: true }, tier,
        function (v) { tier.text = v; markDirty(); renderPreview(); }));
      t.appendChild(g);

      if (!Array.isArray(tier.effects)) {
        t.appendChild(el('div', 'empty-hint', '⚠ 这一档的 effects 不是数组 —— verify-dsl 会判失败，点下面的按钮修好'));
        var fix = el('button', 'btn btn-mini btn-cyan', '改成空数组');
        fix.type = 'button';
        fix.addEventListener('click', function () { tier.effects = []; markDirty(); renderForm(); });
        t.appendChild(fix);
      } else {
        var addE = el('button', 'btn btn-mini btn-cyan', '＋ 这一档加一条效果');
        addE.type = 'button';
        addE.addEventListener('click', function () { tier.effects.push({ when: 'standing', op: 'combat_bonus', value: 1 }); markDirty(); renderForm(); });
        t.appendChild(addE);
        tier.effects.forEach(function (eff, i) {
          t.appendChild(effEditor(card, eff, tier.effects, i, '第 ' + (ti + 1) + ' 档', function () { markDirty(); renderForm(); }));
        });
      }
      sec.appendChild(t);
    });
    return sec;
  }

  function swap(arr, i, j) { var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }

  /**
   * 单条效果的编辑区：
   *  ① 时点下拉（EVENTS 总线 + WHEN 旧写法，界面中文、JSON 坐标）
   *  ② 触发条件下拉（CONDITIONS + 比较符）
   *  ③ op 下拉（OPS，绝不手写）+ 参数输入（OPS[op].params 优先，其余按提示表/现有数据）
   *  ④ 其它字段 + 原始 JSON（保证不丢数据）
   */
  function effEditor(card, eff, list, index, where, onStruct) {
    var unknown = !eff.op || !isKnownOp(eff.op);
    var box = el('div', 'eff-card' + (unknown ? ' unknown' : ''));

    // ---- 头 ----
    var head = el('div', 'eff-head');
    head.appendChild(el('span', 'idx', '#' + (index + 1)));
    head.appendChild(el('span', 'badge cyan', timingText(eff)));
    head.appendChild(el('span', 'badge' + (unknown ? ' red' : ' gold'), eff.op ? opLabel(eff.op) : '缺 op'));
    if (eff.op && opMeta(eff.op)) {
      var m = opMeta(eff.op);
      if (m.passive) head.appendChild(el('span', 'badge dim', '常驻'));
      if (m.needsTarget) head.appendChild(el('span', 'badge dim', '需指定目标'));
      if (m.requiresCombat) head.appendChild(el('span', 'badge dim', '仅对战中使用'));
      if (m.engineDirect) head.appendChild(el('span', 'badge dim', '引擎直查'));
      if (m.deprecated) head.appendChild(el('span', 'badge red', '已废弃'));
    } else {
      head.appendChild(el('span', 'badge red', '幽灵效果：引擎不认这个 op'));
    }
    var sp = el('span', 'sp');
    var mk = function (label, title, fn, danger) {
      var b = el('button', 'btn btn-mini ' + (danger ? 'btn-danger' : 'btn-ghost'), label);
      b.type = 'button';
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    sp.appendChild(mk('↑', '上移', function () { if (index > 0) { swap(list, index, index - 1); onStruct(); } }));
    sp.appendChild(mk('↓', '下移', function () { if (index < list.length - 1) { swap(list, index, index + 1); onStruct(); } }));
    sp.appendChild(mk('复制', '复制这条效果', function () { list.splice(index + 1, 0, deepCopy(eff)); onStruct(); }));
    sp.appendChild(mk('删除', '删除这条效果', function () { list.splice(index, 1); onStruct(); }, true));
    head.appendChild(sp);
    box.appendChild(head);

    // ---- ① 时点 ----
    var g1 = el('div', 'fgrid');
    g1.appendChild(timingControl(eff, function () { markDirty(); renderForm(); }));
    box.appendChild(g1);
    if (eff.op === 'explore_swap') {
      box.appendChild(el('div', 'empty-hint', '【青易居士】替换型效果：挂在「探索阶段」时点（drawTreasure），收势时登记、基础行动最后改抽。'));
    }

    // ---- ② 触发条件 ----
    box.appendChild(conditionsEditor(eff, onStruct));

    // ---- ③ op + 参数 ----
    var g2 = el('div', 'fgrid');
    g2.appendChild(opControl(eff, onStruct));
    box.appendChild(g2);

    if (unknown) {
      box.appendChild(el('div', 'empty-hint',
        '⚠ 这个 op「' + eff.op + '」不在 effect-meta.js 的 OPS 表里 —— 引擎 resolveEffect 不会执行它。\n' +
        '要留就确认它确实是引擎直查/前端用的；否则从上面下拉里换成表内 op。'));
    }

    var hints = (S.meta.paramHints && S.meta.paramHints[eff.op]) || [];
    if (eff.op === 'roll_branch') {
      // ⭐ 掷骰分支用专用编辑器：分支/子效果是嵌套结构，平铺的"参数行"展不平
      box.appendChild(diceBranchEditor(eff, onStruct));
    } else {
      var pg = el('div', 'fgrid');
      hints.forEach(function (h) {
        var spec = Object.assign({}, h, { generic: true });
        pg.appendChild(fieldControl(spec, eff, function (v) {
          if (v === '' && h.type !== 'bool') delete eff[h.key]; else eff[h.key] = v;
          markDirty(); renderPreview(); renderList();
        }));
      });
      if (hints.length) box.appendChild(pg);
      else if (isKnownOp(eff.op)) box.appendChild(el('div', 'empty-hint', '这条 op 没有登记参数（不需要参数，或者参数都在下面的「其它字段」里）。'));
    }

    // ---- 其它字段（数据里的、提示表没登记的） ----
    var hintKeys = hints.map(function (h) { return h.key; });
    var extras = Object.keys(eff).filter(function (k) {
      return EFFECT_RESERVED.indexOf(k) < 0 && hintKeys.indexOf(k) < 0;
    });
    if (extras.length) {
      box.appendChild(el('div', 'sec-head', '其它字段（数据里有、没登记的 —— 仍可编辑）'));
      var eg = el('div', 'fgrid');
      extras.forEach(function (k) {
        eg.appendChild(fieldControl(genericSpec(k, eff[k]), eff, function (v) {
          if (v === '') delete eff[k]; else eff[k] = v;
          markDirty(); renderPreview(); renderList();
        }));
      });
      box.appendChild(eg);
    }

    // ---- 加字段 ----
    var addRow = el('div', 'eff-head');
    var addBtn = el('button', 'btn btn-mini btn-ghost', '＋ 加一个字段');
    addBtn.type = 'button';
    addBtn.addEventListener('click', function () {
      var name = prompt('要加的字段名（如 value / cap / manaCost）：');
      if (!name) return;
      var known = (S.meta.fieldLabels && S.meta.fieldLabels[name]) || null;
      var v = prompt('字段值（数字/true/false/字符串；留空=空字符串）：', known && known.type === 'int' ? '1' : '');
      if (v === null) return;
      var val = v === '' ? '' : (v === 'true' ? true : (v === 'false' ? false : (isNaN(Number(v)) ? v : Number(v))));
      eff[name] = val;
      markDirty(); onStruct();
    });
    addRow.appendChild(addBtn);
    box.appendChild(addRow);

    // ---- ④ 原始 JSON ----
    var det = el('details', 'raw-json');
    det.appendChild(el('summary', null, '原始 JSON（高级：直接改这条效果，应用后覆盖上面的输入）'));
    var ta = el('textarea');
    ta.value = JSON.stringify(eff, null, 2);
    det.appendChild(ta);
    var ra = el('div', 'raw-actions');
    var apply = el('button', 'btn btn-mini btn-cyan', '应用 JSON');
    var msg = el('span', 'raw-msg', '');
    apply.type = 'button';
    apply.addEventListener('click', function () {
      try {
        var obj = JSON.parse(ta.value);
        if (!isPlainObj(obj)) throw new Error('必须是一个 JSON 对象');
        Object.keys(eff).forEach(function (k) { delete eff[k]; });
        Object.keys(obj).forEach(function (k) { eff[k] = obj[k]; });
        markDirty(); onStruct();
      } catch (e) { msg.textContent = 'JSON 不合法：' + e.message; }
    });
    ra.appendChild(apply);
    ra.appendChild(msg);
    var undo = el('button', 'btn btn-mini btn-ghost', '还原文本');
    undo.type = 'button';
    undo.addEventListener('click', function () { ta.value = JSON.stringify(eff, null, 2); msg.textContent = ''; });
    ra.appendChild(undo);
    det.appendChild(ra);
    box.appendChild(det);

    return box;
  }

  /** 时点下拉：EVENTS（总线）+ WHEN（旧写法）+ 「不占时点」 */
  function timingControl(eff, onStruct) {
    var wrap = el('label', 'fld wide');
    wrap.appendChild(el('span', null, '时点（写进 JSON 的是坐标，界面显示中文）'));
    var sel = el('select');

    var cur = currentTimingValue(eff);
    var groups = [];

    var g0 = el('optgroup');
    g0.label = '引擎直查（不占时点）';
    g0.appendChild(opt('', '— 不写时点（仅 engineDirect 的 op 才对）—', cur === ''));
    groups.push(g0);

    // ⭐ 时点（坐标）：**按阶段图分组**，选项文字就是玩家在卡面上看到的那个名字
    //    2026-10-05：下拉先分「主要阶段 / 次要阶段 / 独立时点」三组，再落到图上那一格
    //    （分组真值在服务端 effect-meta 的 TIMING_GROUPS / STAGE_GROUP，经 /api/meta 下发）。
    var evs = events();
    var tnames = timingNames();
    var stageGroups = (S.meta && S.meta.stageGroups) || {};
    var timingGroups = (S.meta && S.meta.timingGroups) || [];
    var groupLabel = {};
    var GROUP_ORDER = [];
    timingGroups.forEach(function (g) { groupLabel[g.id] = g.label; GROUP_ORDER.push(g.id); });
    GROUP_ORDER.push('other');
    var STAGE_ORDER = ['开始阶段', '探索阶段', '抉择阶段', '出牌阶段', '结束阶段',
      '闭关阶段', '晋升阶段', '对战阶段', '独立'];
    var stageBox = {};
    var stageGroup = {};
    Object.keys(evs).sort(function (a, b) { return (evs[a].order || 99) - (evs[b].order || 99); }).forEach(function (ename) {
      var ev = evs[ename];
      var phases = (ev.phases || []).length ? ev.phases : [null];
      var subjects = ev.subject === 'both' ? ['self', 'foe'] : [null];
      phases.forEach(function (ph) {
        subjects.forEach(function (sub) {
          var value = 'e:' + ename + '|' + (sub || '') + '|' + (ph || '');
          var hit = tnames[ename + '|' + (sub || '') + '|' + (ph || '')]
            || tnames[ename + '|' + (sub || '')] || tnames[ename];
          var stage = (hit && hit.stage) || '其他';
          var label = (hit && hit.name) || ev.label;
          if (!stageBox[stage]) {
            stageBox[stage] = el('optgroup');
            stageGroup[stage] = stageGroups[stage] || 'other';
            var gl = groupLabel[stageGroup[stage]];
            stageBox[stage].label = '⭐ ' + (gl ? gl + ' · ' : '') + stage;
          }
          stageBox[stage].appendChild(opt(value,
            label + '　〔' + ename + (sub ? ' · ' + sub : '') + (ph ? ' · ' + ph : '') + '〕', cur === value));
        });
      });
    });
    Object.keys(stageBox).sort(function (a, b) {
      var ga = GROUP_ORDER.indexOf(stageGroup[a]), gb = GROUP_ORDER.indexOf(stageGroup[b]);
      if (ga !== gb) return ga - gb;
      var ia = STAGE_ORDER.indexOf(a), ib = STAGE_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    }).forEach(function (s) { groups.push(stageBox[s]); });

    var g2 = el('optgroup');
    g2.label = '⚠ 旧写法 WHEN —— 时点类（兼容层输入，新卡请用上面的坐标）';
    var g2b = el('optgroup');
    g2b.label = '常驻 / 按钮类（**不是时点**，照旧这么写：standing / passive / activate）';
    var ws = whens();
    var wt = (S.meta && S.meta.whenTiming) || {};
    Object.keys(ws).forEach(function (w) {
      var value = 'w:' + w;
      var kind = { window: '出牌窗口', auto: '自动触发', passive: '常驻', active: '主动使用' }[ws[w].kind] || ws[w].kind;
      // 没有总线事件的 when（standing/passive/activate）= 不是时点 → 它们**必须**继续这么写
      var m = wt[w];
      var nonTiming = !(m && m.event);
      var label = ws[w].label + '（' + w + '）· ' + kind;
      if (nonTiming) g2b.appendChild(opt(value, label, cur === value));
      else g2.appendChild(opt(value, label + '　〔旧写法，建议迁移到坐标〕', cur === value));
    });
    groups.push(g2b);
    groups.push(g2);

    var inList = false;
    groups.forEach(function (g) {
      Array.prototype.forEach.call(g.children, function (o) { if (o.value === cur) inList = true; });
    });
    if (!inList) {
      var g3 = el('optgroup');
      g3.label = '当前值（不在上面任何选项里）';
      g3.appendChild(opt(cur, '⚠ ' + (cur || '(无)') + ' —— 校验器会拦，请换掉', true));
      groups.push(g3);
    }
    groups.forEach(function (g) { sel.appendChild(g); });
    sel.value = cur;

    sel.addEventListener('change', function () {
      var v = sel.value;
      delete eff.when; delete eff.event; delete eff.subject; delete eff.phase;
      if (v.indexOf('w:') === 0) {
        eff.when = v.slice(2);
      } else if (v.indexOf('e:') === 0) {
        var parts = v.slice(2).split('|');
        eff.event = parts[0];
        if (parts[1]) eff.subject = parts[1];
        if (parts[2]) eff.phase = parts[2];
      }
      markDirty(); onStruct();
    });
    wrap.appendChild(sel);
    var hint = eff.op && opMeta(eff.op) && opMeta(eff.op).engineDirect
      ? '这个 op 是 engineDirect，不占时点。'
      : '⭐ 新卡**只能**从时点总表（docs\\时点规范.md §2 的 24 格）里挑坐标；'
        + '旧 when 只是兼容层输入（standing / passive / activate 除外 —— 它们不是时点，本来就这么写）。';
    wrap.appendChild(el('span', 'hint', hint));
    return wrap;
  }

  function currentTimingValue(eff) {
    if (eff.event) return 'e:' + eff.event + '|' + (eff.subject || '') + '|' + (eff.phase || '');
    if (eff.when) return 'w:' + eff.when;
    return '';
  }

  /** op 下拉：全部来自 OPS，绝不手写 */
  function opControl(eff, onStruct) {
    var wrap = el('label', 'fld wide');
    wrap.appendChild(el('span', null, '效果 op（按大类分组；下拉里没有的 op = 幽灵效果，红色标出）'));
    var sel = el('select');
    var table = ops();

    var ghost = el('optgroup');
    ghost.label = '⚠ 不在元数据表里';
    if (eff.op && !isKnownOp(eff.op)) ghost.appendChild(opt(eff.op, eff.op + '（引擎不认）', true));
    else ghost.appendChild(opt('', '— 没有幽灵 op —', !eff.op));
    sel.appendChild(ghost);

    // ⭐ 按**效果大类**分组（2026-10-05 三轴模型的「轴 3」）：回合 / 手牌 / 生命 / 防御 / 法力 /
    //    灵气 / 晋升 / 抽取 / 骰子 / 战力 / 封锁与无效 / 夺取·弃置对方的牌 / 装备与场上。
    var groups = (S.meta && S.meta.opGroups) || [];
    var placed = {};
    groups.forEach(function (gname) {
      var g = el('optgroup');
      g.label = gname;
      Object.keys(table).forEach(function (op) {
        var m = table[op];
        if (m.group !== gname) return;
        placed[op] = true;
        g.appendChild(opt(op, opLabelOf(op, m), eff.op === op));
      });
      if (g.childNodes.length) sel.appendChild(g);
    });
    var rest = Object.keys(table).filter(function (op) { return !placed[op]; });
    if (rest.length) {
      var gu = el('optgroup');
      gu.label = '未分类（记得往 effect-meta 的 OP_GROUPS 里补一行）';
      rest.forEach(function (op) { gu.appendChild(opt(op, opLabelOf(op, table[op]), eff.op === op)); });
      sel.appendChild(gu);
    }

    // 显式回填当前值：幽灵 op 落在最上面的占位组里，已知 op 落在 OPS 组里
    sel.value = eff.op || '';
    sel.addEventListener('change', function () {
      eff.op = sel.value;
      // op 换了：把不属于新 op 的旧参数清掉？—— 不清，交给用户（避免误删数据）；只提示
      markDirty(); onStruct();
    });
    wrap.appendChild(sel);

    var m2 = eff.op ? opMeta(eff.op) : null;
    if (m2 && m2.deprecated) {
      wrap.appendChild(el('span', 'warn', '⚠ 已废弃：' + m2.deprecated + '（数据里现在不该再用它）'));
    }
    if (m2 && m2.needsTarget) wrap.appendChild(el('span', 'hint', '打出时必须先指定目标（引擎 NEEDS_TARGET）'));
    if (m2 && m2.requiresCombat) wrap.appendChild(el('span', 'hint', '只在对战中可用（引擎 REQUIRES_COMBAT）'));
    if (m2 && m2.engineDirect) wrap.appendChild(el('span', 'hint', '由引擎流程直接查询，不占时点'));
    return wrap;
  }

  /** 触发条件：CONDITIONS + 比较符 */
  function conditionsEditor(eff, onStruct) {
    var box = el('div', 'sec');
    var head = el('div', 'sec-head');
    head.appendChild(el('span', null, '触发条件 if'));
    head.appendChild(el('span', 'muted', '多个条件之间是「且」'));
    var right = el('span', 'right');
    var add = el('button', 'btn btn-mini btn-cyan', '＋ 加条件');
    add.type = 'button';
    add.addEventListener('click', function () {
      eff.if = eff.if || {};
      eff.if.hp = eff.if.hp || { lte: 3 };
      markDirty(); onStruct();
    });
    right.appendChild(add);
    head.appendChild(right);
    box.appendChild(head);

    var rows = condRows(eff.if);
    if (!rows.length) {
      box.appendChild(el('div', 'empty-hint', '无条件 —— 到了时点就生效。加条件可以从「自己的生命值」「对战对手的境界」「场上有该同行者」里挑。'));
      return box;
    }
    rows.forEach(function (row, i) {
      box.appendChild(condRowEditor(eff, row, i, onStruct));
    });
    return box;
  }

  /** 把 eff.if 拆成可编辑的行 */
  function condRows(cond) {
    var rows = [];
    if (!cond) return rows;
    Object.keys(cond).forEach(function (k) {
      var v = cond[k];
      if (isPlainObj(v)) {
        Object.keys(v).forEach(function (c) { rows.push({ key: k, cmp: c, value: v[c] }); });
      } else if (typeof v === 'boolean') {
        rows.push({ key: k, cmp: '', value: v, bool: true });
      } else {
        var def = conds()[k];
        rows.push({ key: k, cmp: '', value: v, str: !(def && def.cmp) && COND_KEYS_STR[k] });
      }
    });
    return rows;
  }

  function rebuildCond(eff, rows) {
    var out = {};
    rows.forEach(function (r) {
      if (!r.key) return;
      if (r.cmp) {
        if (!isPlainObj(out[r.key])) out[r.key] = {};
        out[r.key][r.cmp] = r.value;
      } else {
        out[r.key] = r.value;
      }
    });
    if (Object.keys(out).length) eff.if = out; else delete eff.if;
    markDirty(); renderPreview(); renderList();
  }

  function condRowEditor(eff, row, index, onStruct) {
    var wrap = el('div', 'cond-row');
    var all = conds();

    // 条件键
    var keySel = el('select', 'k');
    Object.keys(all).forEach(function (k) {
      keySel.appendChild(opt(k, all[k].label + '（' + k + '）', row.key === k));
    });
    if (!all[row.key]) keySel.appendChild(opt(row.key, '⚠ ' + row.key + '（不在条件表里）', true));
    keySel.value = row.key;
    keySel.addEventListener('change', function () {
      row.key = keySel.value;
      var def = all[row.key];
      row.cmp = (def && def.cmp) ? (def.keys && def.keys[0]) || 'lte' : '';
      row.value = (def && def.cmp) ? 1 : (COND_KEYS_STR[row.key] ? '' : true);
      var rows = condRows(eff.if);
      rows[index] = row;
      rebuildCond(eff, rows);
      renderForm();
    });
    wrap.appendChild(keySel);

    var def = all[row.key];
    // 比较符
    if (def && def.cmp) {
      var cmpSel = el('select', 'c');
      (def.keys || ['lte', 'gte', 'eq']).forEach(function (c) {
        cmpSel.appendChild(opt(c, (COND_BOOL_CMP[c] ? '(逻辑) ' : '') + c, row.cmp === c));
      });
      if (row.cmp && (def.keys || []).indexOf(row.cmp) < 0) cmpSel.appendChild(opt(row.cmp, '⚠ ' + row.cmp, true));
      cmpSel.value = row.cmp || '';
      cmpSel.addEventListener('change', function () {
        row.cmp = cmpSel.value;
        if (COND_BOOL_CMP[row.cmp] && typeof row.value !== 'boolean') row.value = true;
        var rows = condRows(eff.if);
        rows[index] = row;
        rebuildCond(eff, rows);
        renderForm();
      });
      wrap.appendChild(cmpSel);
    }

    // 值
    var isBool = def && !def.cmp && !COND_KEYS_STR[row.key];
    if (def && def.cmp && COND_BOOL_CMP[row.cmp]) isBool = true;
    if (isBool) {
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'v';
      cb.checked = !!row.value;
      cb.addEventListener('change', function () { row.value = cb.checked; rebuildCond(eff, condRows(eff.if)); });
      wrap.appendChild(cb);
      wrap.appendChild(el('span', 'hint', '（勾上 = 条件成立）'));
    } else {
      var vi = el('input', 'v');
      vi.type = typeof row.value === 'number' ? 'number' : 'text';
      vi.value = row.value == null ? '' : String(row.value);
      vi.addEventListener('change', function () {
        var s = vi.value;
        var t = (typeof row.value === 'number') ? Number(s) : s;
        if (typeof t === 'number' && isNaN(t)) t = 0;
        row.value = t;
        rebuildCond(eff, condRows(eff.if));
      });
      wrap.appendChild(vi);
      if (COND_KEYS_STR[row.key]) wrap.appendChild(el('span', 'hint', '字符串值'));
    }

    var del = el('button', 'btn btn-mini btn-danger', '✕');
    del.type = 'button';
    del.addEventListener('click', function () {
      var rows = condRows(eff.if);
      rows.splice(index, 1);
      rebuildCond(eff, rows);
      onStruct();
    });
    wrap.appendChild(del);
    return wrap;
  }

  // ================================================================ 右：预览
  function renderPreview() {
    var box = $('#preview');
    clear(box);
    var card = findCard();
    if (!card) { box.appendChild(el('p', 'empty-hint', '选一张牌后，这里显示玩家在游戏里看到的样子（卡面 + 详情 + 什么时候能打）。')); return; }

    var deck = currentDeck();
    var stack = el('div', 'pv-stack');

    // ---- 卡面（复用 public/style.css 的 .hand-card 观感） ----
    var face = el('div', 'hand-card pv-face deck-' + deck);
    face.appendChild(el('span', 'hc-cost' + (typeof card.cost === 'number' && card.cost > 0 ? '' : ' free'),
      typeof card.cost === 'number' ? card.cost : '—'));
    face.appendChild(el('span', 'hc-tag', DECK_CN[deck] + ' · ' + (TYPE_CN[card.type] || '')));
    face.appendChild(el('span', 'hc-name', card.name || '(无名)'));
    face.appendChild(el('span', 'hc-realm', cardRealmLine(card, deck)));
    face.appendChild(el('span', 'hc-text', card.text || ''));
    if (card.type === 'companion') {
      if ((card.slots || 1) > 1) face.classList.add('slot-heavy');
      if (card.absorb) face.classList.add('absorb-card');
    }
    if (card.type === 'equip') {
      face.classList.add((card.realm || 0) <= 1 ? 'tier-low' : 'tier-high');
      if (card.tiers && card.tiers.length) face.classList.add('has-tiers');
    }
    stack.appendChild(face);

    // ---- 详情 ----
    var detail = el('div', 'card-detail');
    var cdHead = el('div', 'cd-head');
    cdHead.appendChild(el('span', 'cd-name', card.name || '(无名)'));
    cdHead.appendChild(el('span', 'cd-type deck-' + deck, DECK_CN[deck] + ' · ' + (TYPE_CN[card.type] || '')));
    detail.appendChild(cdHead);

    var meta = el('div', 'cd-meta');
    var addMeta = function (label, val) {
      var s = el('span');
      s.appendChild(document.createTextNode(label + ' '));
      s.appendChild(el('b', null, val));
      meta.appendChild(s);
    };
    addMeta('境界', (card.type === 'companion') ? '无限制' : realmName(card.realm || 0));
    addMeta('角标法力', typeof card.cost === 'number' ? card.cost : '无');
    addMeta('张数', card.count + ' 张');
    if (card.type === 'companion') addMeta('占位', '占 ' + (card.slots || 1) + ' 个放置位');
    if (card.type === 'companion' && card.absorb) addMeta('替挡', '任意 ' + card.absorb + ' 次伤害');
    if (card.equipCost !== undefined) addMeta('装备消耗', card.equipCost + ' 法力');
    if (card.equipSlot) addMeta('装备位', card.equipSlot);
    if (card.cardCostDiscount) addMeta('出牌折扣', '用宝物/法术牌法力 -' + card.cardCostDiscount);
    if (card.id) addMeta('ID', card.id);
    detail.appendChild(meta);

    detail.appendChild(el('p', 'cd-text', card.text || '（没有卡文）'));

    // 什么时候能打
    var whenBox = el('p', 'cd-tier');
    whenBox.textContent = playabilityText(card, deck);
    detail.appendChild(whenBox);

    // 效果行（时点 → 效果）
    var list = allEffects(card);
    if (list.length) {
      var effs = el('div', 'cd-effs');
      list.forEach(function (x) {
        var bad = !x.eff.op || !isKnownOp(x.eff.op);
        var row = el('div', 'eff');
        var b = el('b', null, (x.where === '主效果' ? '' : x.where + ' ') + timingText(x.eff));
        row.appendChild(b);
        var sp = el('span', null, effSummary(x.eff));
        if (bad) { sp.style.color = '#ff9c8c'; sp.textContent = '⚠ 幽灵效果：' + (x.eff.op || '(缺 op)'); }
        row.appendChild(sp);
        effs.appendChild(row);
        if (bad) {
          var w = el('div', 'cd-why', '　└ op「' + (x.eff.op || '(缺 op)') + '」不在 effect-meta.js 的 OPS 表里，引擎 resolveEffect 不会执行它。');
          effs.appendChild(w);
        }
      });
      detail.appendChild(effs);
    } else {
      detail.appendChild(el('div', 'empty-hint', '（这条牌没有效果条目）'));
    }

    // 档位
    if (card.tiers && card.tiers.length) {
      var tbox = el('div', 'cd-tiers');
      tbox.appendChild(el('h4', null, '档位效果（装备时选一档生效）'));
      card.tiers.forEach(function (t) {
        var r = el('div', 'cd-tier-row');
        r.appendChild(el('span', 'ct-realm', realmName(t.realm || 0)));
        r.appendChild(el('span', 'ct-text', (t.text || '') + '　' + (t.effects || []).map(function (e) { return '[' + timingText(e) + '] ' + effSummary(e); }).join(' / ')));
        r.appendChild(el('span', 'ct-state', (t.effects || []).length + ' 条'));
        tbox.appendChild(r);
      });
      detail.appendChild(tbox);
    }

    stack.appendChild(detail);
    box.appendChild(stack);

    if (!hasWindowEffect(card)) box.firstChild.style.opacity = '0.62';
  }

  function hasWindowEffect(card) {
    return allEffects(card).some(function (x) {
      var e = x.eff;
      if (e.event) return true;
      var w = whenMeta(e.when);
      return !!(w && (w.kind === 'window' || w.kind === 'active'));
    });
  }

  function cardRealmLine(card, deck) {
    if (card.type === 'companion') {
      return '无境界限制 · 占 ' + (card.slots || 1) + ' 位' + (card.absorb ? ' · 【替挡 ' + card.absorb + ' 次】' : '');
    }
    if (deck === 'qi') return '灵气牌 · 炼化即结算';
    var base = realmName(card.realm || 0);
    if (card.type === 'equip') {
      var cost = typeof card.cost === 'number' ? card.cost : 0;
      if (!cost) return base + ' · 免费';
      return (card.realm || 0) <= 1 ? (base + ' · 装备免费/对战启用付 ' + cost + ' 法力') : (base + ' · 装备付 ' + cost + ' 法力/对战启用免费');
    }
    return base + (typeof card.cost === 'number' && card.cost > 0 ? ' · 打出付 ' + card.cost + ' 法力' : '');
  }

  function playabilityText(card, deck) {
    if (deck === 'qi') return '灵气牌：在「炼化灵气牌」阶段抽到即结算，不进手牌。';
    var windows = [];
    allEffects(card).forEach(function (x) {
      var e = x.eff;
      var label = timingText(e);
      if (windows.indexOf(label) < 0) windows.push(label);
    });
    var head;
    if (card.type === 'companion') head = '同行者：放到场上后按下面的时点自动触发（不需要"打出"）。';
    else if (card.type === 'equip') head = '装备类：装备后常驻；对战启用费见角标法力。';
    else head = '消耗类：在下面的时点从手牌打出（用完进弃牌堆）。';
    if (!hasWindowEffect(card)) {
      head += ' ⚠ 这张牌**没有出牌窗口**（全是常驻/自动触发）—— 玩家点不动它，确认是不是设计如此。';
    }
    return head + (windows.length ? ' 时点：' + windows.join(' / ') : '');
  }

  // ================================================================ 控制台输出
  function consoleBox() { return $('#console'); }
  function consoleReset(html) {
    var box = consoleBox();
    clear(box);
    if (html) box.appendChild(el('p', 'muted', html));
  }
  function consoleAdd(node) { consoleBox().appendChild(node); }

  function verdict(text, ok) {
    var v = el('div', 'verdict ' + (ok ? 'ok' : 'bad'), text);
    consoleAdd(v);
  }

  function stepBlock(step, index) {
    var wrap = el('div', 'step ' + (step.ok ? 'ok' : 'bad'));
    var h = el('div', 'step-head');
    h.appendChild(el('span', 'st-name', (index !== undefined ? (index + ' ') : '') + step.name));
    h.appendChild(el('span', 'st-cmd', step.cmd));
    h.appendChild(el('span', 'badge ' + (step.ok ? 'gold' : 'red'), '退出码 ' + step.code));
    if (step.timedOut) h.appendChild(el('span', 'badge red', '超时'));
    wrap.appendChild(h);
    var pre = el('pre', 'step-body', step.output || '(无输出)');
    wrap.appendChild(pre);
    return wrap;
  }

  function showValidation(res, wroteLabel) {
    consoleReset();
    var ok = !!res.ok;
    verdict((ok ? '✓ 校验全部通过' : '✗ 校验未通过 —— 已拒绝写盘，磁盘上的文件一个字节都没动') +
      (wroteLabel ? '　' + wroteLabel : ''), ok);
    (res.steps || []).forEach(function (s, i) { consoleAdd(stepBlock(s, i + 1)); });
    if (res.backup) {
      consoleAdd(el('p', 'muted', '备份：' + res.backup.file + '（保留 ' + res.backup.kept + ' 份' +
        (res.backup.pruned && res.backup.pruned.length ? '，已清理旧备份：' + res.backup.pruned.join('、') : '') + '）'));
    }
    if (res.counts) {
      consoleAdd(el('p', 'muted', '写入后各堆张数：' + DECK_ORDER.map(function (d) { return DECK_CN[d] + ' ' + res.counts[d]; }).join(' · ') + ' · 合计 ' + res.total));
    }
    if (res.error) consoleAdd(el('p', null, '错误：' + res.error));
    if (res.hint) consoleAdd(el('p', 'muted', res.hint || ''));
  }

  // ================================================================ 动作
  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, body: j }; });
    });
  }

  function doValidate(save, force) {
    if (!S.pool) return;
    var btn = save ? $('#btn-save') : $('#btn-validate');
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = '校验中…';
    consoleReset('正在跑校验（真实校验器，输出原样显示）……');
    post(save ? '/api/save' : '/api/validate',
      { cards: S.pool, baseMtime: save ? S.baseMtime : null, force: !!force }).then(function (r) {
      var res = r.body || {};
      // 409 = 磁盘版本在本页载入之后被改过。静默写盘会整段覆盖那边的改动
      // （2026-10-05 真踩过：8098 的旧页面存盘把当轮刚修的两张卡数据整段回退），所以先问人。
      if (r.status === 409 && save && !force) {
        consoleReset();
        var go = confirm('⚠ 磁盘上的卡池在你这轮编辑期间被改过（磁盘版本 ' + (res.diskMtime || '?') + '）。\n'
          + '直接保存会把那边的新改动（很可能包含别人刚修的牌）整段覆盖掉。\n\n'
          + '确定要用当前页面这份覆盖磁盘吗？\n（点【取消】＝不覆盖；按页面上的「重新载入」可把磁盘版本读进来）');
        if (go) return doValidate(true, true);
        verdict('✗ 已放弃保存：磁盘版本更新 —— 请先「重新载入」，本页改动还在', false);
        return;
      }
      if (r.status !== 200) {
        consoleReset();
        verdict('✗ 请求失败（HTTP ' + r.status + '）：' + (res.error || '未知错误'), false);
        return;
      }
      if (res.wrote) { S.dirty = {}; S.baseMtime = res.mtime || S.baseMtime; }
      showValidation(res, res.wrote ? ('已写入 ' + res.cardsFile + '，备份 ' + (res.backup ? res.backup.file : '?')) : '（只校验，未写盘）');
      if (res.wrote) {
        renderList(); renderCounts();
        get('/api/state').then(function (st) { renderFile(st, { cardsFile: S.file, cardsFileAbsolute: S.fileAbs, mtime: res.mtime }); });
      }
    }).catch(function (e) {
      consoleReset();
      verdict('✗ 请求异常：' + e.message, false);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = old;
    });
  }

  function doReload() {
    var dirtyCount = Object.keys(S.dirty).length;
    if (dirtyCount && !confirm('界面上有 ' + dirtyCount + ' 张牌的改动还没保存，确定放弃并重新从磁盘载入？')) return;
    consoleReset('重新载入中……');
    get('/api/cards').then(function (cards) {
      S.pool = cards.pool;
      // 重新载入 = 基准快照也跟着对齐（差异视图从此以"刚载入的这一版"为准）
      try { S.poolBase = deepCopy(cards.pool); } catch (e) { S.poolBase = null; }
      S.baseMtime = cards.mtime || S.baseMtime;      // 重新载入 = 把并发基线也对齐到磁盘
      S.dirty = {};
      S.sel = null;
      renderCounts(); renderList(); renderForm(); renderPreview(); consoleReset();
      if (diffOpen()) renderDiff();
    });
  }

  function doRegression() {
    consoleReset('启动回归任务……');
    post('/api/regression', {}).then(function (r) {
      if (r.status !== 200) { verdict('✗ 起不来：' + (r.body && r.body.error), false); return; }
      var id = r.body.id;
      var head = el('div', 'step ok');
      var hh = el('div', 'step-head');
      hh.appendChild(el('span', 'st-name', '回归（引擎/规则单测 + 卡池不变量 + 服务端连通）'));
      hh.appendChild(el('span', 'st-cmd', r.body.cmd || ''));
      hh.appendChild(el('span', 'badge gold', '运行中…'));
      head.appendChild(hh);
      var pre = el('pre', 'step-body', '(等待输出…)');
      head.appendChild(pre);
      consoleAdd(head);
      consoleAdd(el('p', 'muted', '说明：' + (r.body.note || '') + '　不跑浏览器 UI（--no-ui），也不会重启线上服务。'));
      var badge = hh.querySelector('.badge');
      if (S.regressionTimer) clearInterval(S.regressionTimer);
      S.regressionTimer = setInterval(function () {
        get('/api/regression?id=' + encodeURIComponent(id)).then(function (j) {
          pre.textContent = j.output || '(还没有输出)';
          pre.scrollTop = pre.scrollHeight;
          if (!j.running) {
            clearInterval(S.regressionTimer);
            S.regressionTimer = null;
            head.className = 'step ' + (j.code === 0 ? 'ok' : 'bad');
            badge.className = 'badge ' + (j.code === 0 ? 'gold' : 'red');
            badge.textContent = '退出码 ' + j.code + ' · ' + (j.elapsedMs / 1000).toFixed(1) + ' 秒' + (j.timedOut ? '（超时被杀）' : '');
          }
        });
      }, 1500);
    }).catch(function (e) { verdict('✗ 请求异常：' + e.message, false); });
  }

  function doBackups() {
    consoleReset('备份列表……');
    get('/api/backups').then(function (j) {
      consoleAdd(el('p', null, '目标文件：' + j.cardsFile + '　备份最多保留 ' + j.keepBackups + ' 份'));
      if (!j.backups.length) { consoleAdd(el('p', 'muted', '还没有编辑器备份。第一次点保存时会自动生成。')); return; }
      j.backups.forEach(function (b) {
        consoleAdd(el('div', 'bak-row', b.name + '　' + b.bytes + ' 字节　' + b.mtime));
      });
      consoleAdd(el('p', 'muted', '恢复方式（命令行，确认无误再执行）：Copy-Item <备份文件> ' + j.cardsFile));
    });
  }

  function bindButtons() {
    $('#btn-save').addEventListener('click', function () { doValidate(true); });
    $('#btn-validate').addEventListener('click', function () { doValidate(false); });
    $('#btn-reload').addEventListener('click', doReload);
    $('#btn-regression').addEventListener('click', function () {
      if (!confirm('跑一次回归？会连线上服务（8094 / fanren.example.com）做联通检查，并在线上建临时房间；不会重启服务。')) return;
      doRegression();
    });
    $('#btn-backups').addEventListener('click', doBackups);
    $('#btn-console-clear').addEventListener('click', function () { consoleReset(); });
    $('#btn-sim-toggle').addEventListener('click', function () { simSetOpen(!SIM.open); });
    $('#btn-sim-run').addEventListener('click', function () { simRun(); });
    $('#btn-sim-reset').addEventListener('click', function () { SIM.actions = []; SIM.last = null; simRender(); });
    $('#btn-sim-auto').addEventListener('click', function () { simPassWindow(); });
    // 二期：差异视图开关 + 重新比对
    $('#btn-diff-toggle').addEventListener('click', function () {
      var panel = $('#diff-panel');
      var open = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !open);
      this.textContent = open ? '差异 ▾' : '差异 ▸';
      try { localStorage.setItem('fanren-editor-diff-open', open ? '1' : '0'); } catch (e) { /* 忽略 */ }
      if (open) renderDiff();
    });
    $('#btn-diff-refresh').addEventListener('click', function () { renderDiff(); });
    // 三期：平衡试跑开关 + 跑一轮
    $('#btn-balance-toggle').addEventListener('click', function () { balanceSetOpen($('#balance-panel').classList.contains('hidden')); });
    $('#btn-balance-run').addEventListener('click', function () { runBalance(); });
    // 批量改张数：开关 + 筛选 + 三个操作 + 应用
    var bulkRefresh = function () {
      BULK.op = '+1';                        // 改筛选后操作回到默认，避免"以为在 +1 其实在设为 3"
      BULK.picked = {};
      renderBulk();
    };
    $('#btn-bulk-toggle').addEventListener('click', function () {
      var panel = $('#bulk-panel');
      var open = panel.classList.contains('hidden');
      panel.classList.toggle('hidden', !open);
      this.textContent = open ? '批量张数 ▾' : '批量张数 ▸';
      try { localStorage.setItem('fanren-editor-bulk-open', open ? '1' : '0'); } catch (e) { /* 忽略 */ }
      if (open) renderBulk();
    });
    $('#btn-bulk-all').addEventListener('click', function () {
      DECK_ORDER.forEach(function (d) { BULK.decks[d] = true; }); bulkRefresh();
    });
    $('#btn-bulk-none').addEventListener('click', function () {
      DECK_ORDER.forEach(function (d) { BULK.decks[d] = false; }); bulkRefresh();
    });
    $('#bulk-realm').addEventListener('change', function () { BULK.realm = this.value; bulkRefresh(); });
    $('#bulk-in-search').addEventListener('change', function () { BULK.inSearch = this.checked; bulkRefresh(); });
    $('#bulk-skip-zero').addEventListener('change', function () { BULK.skipZero = this.checked; bulkRefresh(); });
    $('#btn-bulk-plus').addEventListener('click', function () { BULK.op = '+1'; renderBulk(); });
    $('#btn-bulk-minus').addEventListener('click', function () { BULK.op = '-1'; renderBulk(); });
    $('#btn-bulk-set').addEventListener('click', function () {
      BULK.op = 'set';
      BULK.value = Number(($('#bulk-value') || {}).value);
      renderBulk();
    });
    $('#bulk-value').addEventListener('change', function () {
      BULK.value = Number(this.value);
      if (BULK.op === 'set') renderBulk();
    });
    $('#btn-bulk-checkall').addEventListener('click', function () { BULK.picked = {}; renderBulk(); });
    $('#btn-bulk-uncheck').addEventListener('click', function () {
      bulkCandidates().forEach(function (x) { BULK.picked[bulkKey(x.deck, x.card.id)] = false; });
      renderBulk();
    });
    $('#btn-bulk-apply').addEventListener('click', function () { applyBulk(); });
    $('#search').addEventListener('input', function () {
      S.search = this.value;
      renderList();
      // 批量面板里勾了"只改当前搜索结果"时，搜索一变命中就跟着变
      var bp = $('#bulk-panel');
      if (bp && !bp.classList.contains('hidden') && BULK.inSearch) { BULK.picked = {}; renderBulk(); }
    });
    $('#btn-clear-search').addEventListener('click', function () {
      $('#search').value = '';
      S.search = '';
      renderList();
    });
    window.addEventListener('beforeunload', function (e) {
      if (Object.keys(S.dirty).length) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  boot();

  // ================================================================ 效果模拟沙盒
  //
  // 用户 2026-10-05："做一个卡牌效果模拟测试场景，可以挑选任意阶段、任意手牌、任意生命法力，
  // 以及对手所要发动的手牌或者场上效果。"
  //
  // 工作方式：**无状态重放** —— 界面把「局面设置 + 动作脚本」整个发给 /api/simulate（连同 S.pool，
  // 所以**改完没存盘也能试**），服务端从零建局、按脚本跑一遍、回传 trace + 战报 + 状态快照。
  // 点候选牌 = 往脚本里 append 一条再重跑，所以"下一步会怎样"随时可试、也随时可撤销（✕ 删掉那条）。
  var SIM = {
    seed: 20261005,
    turn: 0,
    step: 'action',
    flags: { combat: false, promote: false },
    plainQi: true,
    players: {
      a: { realm: 0, hp: 6, mana: 12, qi: 0, hand: [], equip: [], spells: [], companions: [], puppets: [] },
      b: { realm: 0, hp: 6, mana: 12, qi: 0, hand: [], equip: [], spells: [], companions: [], puppets: [] },
    },
    meta: null,          // { steps:[], actions:[] } ← GET /api/simulate
    actions: [],         // 动作脚本
    last: null,          // 上一次运行结果
    dice: [],            // 骰点注入（钉住接下来几次掷骰的点数）
    open: false,         // 面板展开开关（默认收起，别常占窗口下方；状态记在 localStorage）
  };
  var SIM_OPEN_KEY = 'fanren-editor-sim-open';
  var VIEW_KEY = 'fanren-editor-view';       // 'form' | 'blueprint'（效果编辑的双视图）

  /** 面板开关：收起时 DOM 整个 display:none，只留顶栏那个按钮 */
  function simApplyOpen() {
    var panel = $('#sim-panel');
    if (panel) panel.classList.toggle('hidden', !SIM.open);
    var btn = $('#btn-sim-toggle');
    if (btn) {
      btn.textContent = SIM.open ? '效果模拟 ▾' : '效果模拟 ▸';
      btn.title = SIM.open
        ? '收起效果模拟沙盒（不占窗口下方）'
        : '效果模拟沙盒：挑阶段/手牌/生命法力 + 对手要发动的牌，就地跑引擎（默认收起，不占地方）';
    }
  }
  function simSetOpen(v) {
    SIM.open = !!v;
    try { localStorage.setItem(SIM_OPEN_KEY, SIM.open ? '1' : '0'); } catch (e) { /* 隐私模式等：忽略 */ }
    simApplyOpen();
    if (SIM.open) {
      if (!SIM.meta) simLoadMeta(); else simRender();
      var panel = $('#sim-panel');
      if (panel && panel.scrollIntoView) panel.scrollIntoView({ block: 'nearest' });
    }
  }
  var SIM_SLOTS = [
    ['hand', '手牌'],
    ['equip', '储物袋'],
    ['spells', '法术区'],
    ['companions', '同行者'],
    ['puppets', '傀儡位'],
  ];
  var SIM_REALM_NAMES = ['凡人', '炼气期', '筑基期', '结丹期', '元婴期'];

  /** 卡池里可手动摆上桌的牌（灵气牌不摆，用「灵气」数字表示张数） */
  function simCardNames() {
    if (!S.pool) return [];
    var out = [];
    ['treasure', 'spell', 'companion'].forEach(function (deck) {
      (S.pool[deck] || []).forEach(function (c) { out.push({ deck: deck, name: c.name, id: c.id, count: c.count }); });
    });
    return out;
  }

  function simLoadMeta() {
    return get('/api/simulate').then(function (r) {
      SIM.meta = (r && r.meta) || null;
      simRender();
    }).catch(function (e) {
      var box = $('#sim');
      if (box) { clear(box); box.appendChild(el('p', 'muted', '沙盒元数据载入失败：' + e.message)); }
    });
  }

  function simRender() {
    var box = $('#sim');
    if (!box) return;
    clear(box);
    var names = simCardNames();

    // ---- 局面：种子 / 回合 / 阶段 / 回合标记 ----
    var row = el('div', 'sim-row');
    row.appendChild(el('span', 'sim-lab', '种子'));
    var seed = el('input', 'input sim-num');
    seed.type = 'number'; seed.value = SIM.seed;
    seed.addEventListener('change', function () { SIM.seed = Number(this.value) || 20261005; });
    row.appendChild(seed);
    row.appendChild(el('span', 'sim-lab', '当前回合'));
    var turnSel = el('select', 'input sim-sel');
    turnSel.appendChild(opt('0', '甲先手（甲的回合）', SIM.turn === 0));
    turnSel.appendChild(opt('1', '乙先手（乙的回合）', SIM.turn === 1));
    turnSel.addEventListener('change', function () { SIM.turn = Number(this.value) || 0; });
    row.appendChild(turnSel);
    row.appendChild(el('span', 'sim-lab', '阶段'));
    var stepSel = el('select', 'input sim-sel');
    var steps = (SIM.meta && SIM.meta.steps) || [{ key: 'action', label: '行动阶段' }];
    steps.forEach(function (s) { stepSel.appendChild(opt(s.key, s.label, SIM.step === s.key)); });
    stepSel.addEventListener('change', function () { SIM.step = this.value; });
    row.appendChild(stepSel);
    [['combat', '本回合已发起过对战'], ['promote', '本回合已晋升']].forEach(function (f) {
      var lab = el('label', 'sim-check');
      var cb = el('input');
      cb.type = 'checkbox'; cb.checked = !!SIM.flags[f[0]];
      cb.addEventListener('change', function () { SIM.flags[f[0]] = this.checked; });
      lab.appendChild(cb); lab.appendChild(el('span', null, f[1]));
      row.appendChild(lab);
    });
    var lab2 = el('label', 'sim-check');
    var cb2 = el('input');
    cb2.type = 'checkbox'; cb2.checked = SIM.plainQi;
    cb2.addEventListener('change', function () { SIM.plainQi = this.checked; });
    lab2.appendChild(cb2);
    lab2.appendChild(el('span', null, '抽灵气不连锁（灵气堆换成纯【稀薄灵气】）'));
    row.appendChild(lab2);
    // 骰点注入：测掷骰类效果时把点数钉住（否则每次掷出来都不一样，没法复现）
    row.appendChild(el('span', 'sim-lab', '骰点注入'));
    var dice = el('input', 'input sim-num');
    dice.type = 'text'; dice.style.width = '96px';
    dice.placeholder = '如 6,1';
    dice.value = (SIM.dice || []).join(',');
    dice.title = '按顺序钉住接下来每次掷骰的点数（1~6，逗号分隔）；用完就回到真随机';
    dice.addEventListener('change', function () {
      SIM.dice = String(this.value || '').split(/[^0-9]+/).map(Number).filter(function (n) { return n >= 1 && n <= 6; });
    });
    row.appendChild(dice);
    box.appendChild(row);

    // ---- 双方：境界 / 生命 / 法力 / 灵气 + 手牌/场上 ----
    var wrap = el('div', 'sim-players');
    ['a', 'b'].forEach(function (pid) {
      var cfg = SIM.players[pid];
      var col = el('div', 'sim-pl');
      col.appendChild(el('div', 'sim-pl-name', pid === 'a' ? '甲（房主）' : '乙'));
      var nums = el('div', 'sim-row');
      nums.appendChild(el('span', 'sim-lab', '境界'));
      var realmSel = el('select', 'input sim-sel');
      SIM_REALM_NAMES.forEach(function (n, i) { realmSel.appendChild(opt(i, n, cfg.realm === i)); });
      realmSel.addEventListener('change', function () { cfg.realm = Number(this.value) || 0; });
      nums.appendChild(realmSel);
      [['hp', '生命', 0, 6], ['mana', '法力', 0, 12], ['qi', '灵气', 0, 60]].forEach(function (f) {
        nums.appendChild(el('span', 'sim-lab', f[1]));
        var inp = el('input', 'input sim-num');
        inp.type = 'number'; inp.min = f[2]; inp.max = f[3]; inp.value = cfg[f[0]];
        inp.addEventListener('change', function () { cfg[f[0]] = Number(this.value) || 0; });
        nums.appendChild(inp);
      });
      col.appendChild(nums);

      SIM_SLOTS.forEach(function (slot) {
        var line = el('div', 'sim-slot');
        line.appendChild(el('span', 'sim-lab', slot[1]));
        var sel = el('select', 'input sim-pick');
        var grouped = {};
        names.forEach(function (c) { (grouped[c.deck] = grouped[c.deck] || []).push(c); });
        ['treasure', 'spell', 'companion'].forEach(function (deck) {
          if (!grouped[deck]) return;
          var g = el('optgroup');
          g.label = DECK_CN[deck] || deck;
          grouped[deck].forEach(function (c) { g.appendChild(opt(c.name, c.name + '（' + c.count + ' 张）')); });
          sel.appendChild(g);
        });
        line.appendChild(sel);
        var add = el('button', 'btn btn-mini btn-cyan', '＋');
        add.type = 'button';
        add.addEventListener('click', function () {
          if (!sel.value) return;
          cfg[slot[0]].push(sel.value);
          simRender();
        });
        line.appendChild(add);
        var chips = el('span', 'sim-chips');
        (cfg[slot[0]] || []).forEach(function (nm, i) {
          var chip = el('span', 'sim-chip', nm);
          var x = el('span', 'sim-chip-x', '✕');
          x.addEventListener('click', function () { cfg[slot[0]].splice(i, 1); simRender(); });
          chip.appendChild(x);
          chips.appendChild(chip);
        });
        line.appendChild(chips);
        col.appendChild(line);
      });
      wrap.appendChild(col);
    });
    box.appendChild(wrap);

    // ---- 动作编辑：谁 / 做什么 / 哪张牌 / 打谁 ----
    var act = el('div', 'sim-row sim-actrow');
    act.appendChild(el('span', 'sim-lab', '动作'));
    var whoSel = el('select', 'input sim-sel');
    whoSel.appendChild(opt('a', '甲'));
    whoSel.appendChild(opt('b', '乙'));
    act.appendChild(whoSel);
    var typeSel = el('select', 'input sim-sel');
    ((SIM.meta && SIM.meta.actions) || [{ key: 'play', label: '打出 / 装备一张手牌', needs: 'card' }]).forEach(function (a) {
      typeSel.appendChild(opt(a.key, a.label));
    });
    act.appendChild(typeSel);
    var cardSel = el('select', 'input sim-pick');
    cardSel.appendChild(opt('', '（不指定牌）'));
    names.forEach(function (c) { cardSel.appendChild(opt(c.name, '[' + (DECK_CN[c.deck] || c.deck) + '] ' + c.name)); });
    act.appendChild(cardSel);
    var tgtSel = el('select', 'input sim-sel');
    tgtSel.appendChild(opt('', '（不指定目标）'));
    tgtSel.appendChild(opt('b', '目标：乙'));
    tgtSel.appendChild(opt('a', '目标：甲'));
    act.appendChild(tgtSel);
    var deckSel = el('select', 'input sim-sel');
    deckSel.appendChild(opt('', '（抉择牌堆）'));
    deckSel.appendChild(opt('treasure', '宝物牌'));
    deckSel.appendChild(opt('spell', '法术牌'));
    deckSel.appendChild(opt('companion', '同行者'));
    deckSel.appendChild(opt('qi', '灵气牌'));
    act.appendChild(deckSel);
    function syncActRow() {
      var meta = ((SIM.meta && SIM.meta.actions) || []).filter(function (x) { return x.key === typeSel.value; })[0] || {};
      cardSel.style.display = meta.needs === 'card' ? '' : 'none';
      tgtSel.style.display = meta.target ? '' : 'none';
      deckSel.style.display = meta.deck ? '' : 'none';
    }
    typeSel.addEventListener('change', syncActRow);
    syncActRow();
    var addAct = el('button', 'btn btn-mini btn-gold', '加入脚本');
    addAct.type = 'button';
    addAct.addEventListener('click', function () {
      var a = { type: typeSel.value };
      if (cardSel.style.display !== 'none' && cardSel.value) a.card = cardSel.value;
      if (tgtSel.style.display !== 'none' && tgtSel.value) a.target = tgtSel.value;
      if (deckSel.style.display !== 'none' && deckSel.value) a.deck = deckSel.value;
      SIM.actions.push({ player: whoSel.value, action: a });
      simRender();
    });
    act.appendChild(addAct);
    box.appendChild(act);

    // ---- 脚本 ----
    var script = el('div', 'sim-script');
    if (!SIM.actions.length) {
      script.appendChild(el('span', 'muted', '脚本为空：点「▶ 运行」先看初始局面，或直接加入动作。'));
    } else {
      SIM.actions.forEach(function (step, i) {
        var chip = el('span', 'sim-step');
        chip.appendChild(el('b', null, (i + 1) + '.'));
        chip.appendChild(el('span', null, ' ' + (step.player === 'a' ? '甲' : '乙') + ' ' + simActionText(step.action)));
        var x = el('span', 'sim-chip-x', '✕');
        x.addEventListener('click', function () { SIM.actions.splice(i, 1); simRender(); });
        chip.appendChild(x);
        script.appendChild(chip);
      });
    }
    box.appendChild(script);

    // ---- 输出 ----
    box.appendChild(simOutput());
  }

  function simActionText(a) {
    var CN = { play: '打出/装备', respond_play: '破招打出/发动', respond_pass: '放弃', promote: '晋升', combat: '发起对战', roll: '投骰', draw_qi: '抽灵气', draw_treasure: '抽宝物', choose_draw: '抉择抽牌', seclusion: '闭关', discard: '弃牌', dismiss: '撤下', activate: '发动', end_turn: '结束回合' };
    var s = CN[a.type] || a.type;
    if (a.card) s += '【' + a.card + '】';
    if (a.target) s += ' →' + (a.target === 'a' ? '甲' : '乙');
    if (a.deck) s += '（' + (DECK_CN[a.deck] || a.deck) + '）';
    return s;
  }

  function simOutput() {
    var out = el('div', 'sim-out');
    var r = SIM.last;
    if (!r) { out.appendChild(el('p', 'muted', '还没跑过。')); return out; }
    if (r.ok === false) {
      out.appendChild(el('p', 'sim-bad', '✗ ' + (r.error || '运行失败')));
      return out;
    }
    // 动作结果
    (r.trace || []).forEach(function (t) {
      var bad = t.result && t.result.ok === false;
      var line = el('div', bad ? 'sim-trace sim-bad' : 'sim-trace sim-good');
      line.appendChild(el('b', null, (bad ? '✗ ' : '✓ ') + (t.i + 1) + '. ' + t.label));
      if (bad) line.appendChild(el('span', null, '  ' + (t.result.error || '')));
      else if (t.result && t.result.waiting) line.appendChild(el('span', 'muted', '  → 等 ' + (t.result.waiting === 'a' ? '甲' : t.result.waiting === 'b' ? '乙' : t.result.waiting) + ' 表态'));
      out.appendChild(line);
    });
    if (r.stopped) out.appendChild(el('div', 'sim-warn', '⚠ ' + r.stopped));

    // 战报
    var lg = el('div', 'sim-log');
    (r.log || []).forEach(function (l) {
      var line = el('div', 'sim-logline sim-k-' + (l.kind || 'info'));
      line.textContent = '[' + (l.kind || 'info') + '] ' + l.text;
      lg.appendChild(line);
    });
    if (!(r.log || []).length) lg.appendChild(el('div', 'muted', '（这一步没有战报）'));
    out.appendChild(lg);

    // 当前局面
    var st = r.state;
    var tbl = el('div', 'sim-state');
    var head = el('div', 'sim-state-row sim-state-head');
    ['', '甲', '乙'].forEach(function (t) { head.appendChild(el('span', null, t)); });
    tbl.appendChild(head);
    var rows = [
      ['境界', function (p) { return SIM_REALM_NAMES[p.realm] || p.realm; }],
      ['生命', function (p) { return p.hp + '/' + p.hpMax; }],
      ['法力', function (p) { return p.mana + '/' + p.manaCap; }],
      ['灵气值', function (p) { return p.qi; }],
      ['手牌', function (p) { return p.hand.length ? p.hand.join('、') : '—'; }],
      ['储物袋', function (p) { return p.equip.join('、') || '—'; }],
      ['法术区', function (p) { return p.spells.join('、') || '—'; }],
      ['同行者', function (p) { return p.companions.join('、') || '—'; }],
      ['傀儡位', function (p) { return (p.puppets || []).join('、') || '—'; }],
    ];
    rows.forEach(function (rw) {
      var line = el('div', 'sim-state-row');
      line.appendChild(el('span', 'sim-state-lab', rw[0]));
      st.players.forEach(function (p) { line.appendChild(el('span', null, String(rw[1](p)))); });
      tbl.appendChild(line);
    });
    out.appendChild(tbl);
    out.appendChild(el('div', 'muted', '阶段：' + (st.step) + ' · 当前回合：' + (st.turn === 'a' ? '甲' : st.turn === 'b' ? '乙' : st.turn) +
      ' · 回合标记：已发起对战=' + (st.turnFlags && st.turnFlags.combat ? '是' : '否') + ' / 已晋升=' + (st.turnFlags && st.turnFlags.promote ? '是' : '否') +
      (st.combat ? ' · 对战：' + st.combat.stage + '（攻=' + st.combat.attacker + ' 守=' + st.combat.defender + '）' : '')));

    // 窗口：候选牌 / 放弃，一点就 append 进脚本再重跑
    if (st.pending) {
      var win = el('div', 'sim-window');
      win.appendChild(el('b', null, '现在轮到【' + (st.pending.actorName || st.pending.actor) + '】表态'));
      win.appendChild(el('span', 'muted', '（时点：' + st.pending.event + (st.pending.phase ? ' · ' + st.pending.phase : '') + '）'));
      var who = st.pending.actor;
      var cands = el('div', 'sim-chips');
      (st.pending.candidates || []).forEach(function (c) {
        var b = el('button', 'btn btn-mini btn-cyan', '破招打出/发动【' + c.name + '】' + (c.where === 'board' ? '（场上）' : '') + (c.option ? '（' + c.option + '）' : ''));
        b.type = 'button';
        b.addEventListener('click', function () {
          SIM.actions.push({ player: who, action: { type: 'respond_play', card: c.name } });
          simRun();
        });
        cands.appendChild(b);
      });
      var bp = el('button', 'btn btn-mini btn-ghost', '放弃（不破招）');
      bp.type = 'button';
      bp.addEventListener('click', function () { SIM.actions.push({ player: who, action: { type: 'respond_pass' } }); simRun(); });
      cands.appendChild(bp);
      win.appendChild(cands);
      out.appendChild(win);
    }
    if (st.forceDiscard) {
      out.appendChild(el('div', 'sim-warn', '⚠ 手牌超上限：还要弃 ' + st.forceDiscard.need + ' 张（动作选「弃置一张手牌」）'));
    }
    return out;
  }

  function simRun() {
    if (!S.pool) return;
    var payload = {
      cards: S.pool,                       // ⭐ 用界面上这份（可能还没存盘）
      seed: SIM.seed, turn: SIM.turn, step: SIM.step,
      turnFlags: SIM.flags, plainQi: SIM.plainQi,
      forcedDice: SIM.dice || [],
      players: SIM.players, actions: SIM.actions,
    };
    var btn = $('#btn-sim-run');
    var old = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '跑…'; }
    post('/api/simulate', payload).then(function (r) {
      SIM.last = r.body || { ok: false, error: 'HTTP ' + r.status };
      if (r.status !== 200 && !SIM.last.error) SIM.last = { ok: false, error: 'HTTP ' + r.status };
      simRender();
    }).catch(function (e) {
      SIM.last = { ok: false, error: '请求异常：' + e.message };
      simRender();
    }).then(function () {
      if (btn) { btn.disabled = false; btn.textContent = old; }
    });
  }

  /** 「放弃当前窗口」：把最后一次运行里开着的窗口放弃掉 */
  function simPassWindow() {
    var st = SIM.last && SIM.last.state;
    if (!st || !st.pending) { window.alert('现在没有开着的窗口（先点一次「▶ 运行」看当前局面）'); return; }
    SIM.actions.push({ player: st.pending.actor, action: { type: 'respond_pass' } });
    simRun();
  }
})();
