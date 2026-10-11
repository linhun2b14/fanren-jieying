/* =====================================================================
 * 《凡人修仙传：结婴之战》浏览器前端
 * ---------------------------------------------------------------------
 * 纯原生 HTML/CSS/JS，无框架、无依赖、完全离线可用。
 * 唯一数据契约：服务端 engine.js 的 publicState()（经 GET /api/stream 以 SSE 推送）。
 * 写操作全部走 POST /api/*（create / join / start / again / action）。
 *
 * 模块顺序：
 *   0 常量        1 DOM 工具      2 卡池缓存    3 会话持久化   4 网络层
 *   5 全局状态    6 提示与横幅    7 卡牌规则    8 大厅/房间    9 玩家面板
 *   10 手牌      11 操作区       12 牌堆/战报  13 对战面板   14 结算与弹窗
 *   15 动画反馈  16 主循环与启动
 * ===================================================================== */
(function () {
  'use strict';

  /* ================================================================
   * 0. 常量（与服务端 engine.js 对齐；仅用于渲染与本地可打性判定）
   * ================================================================ */

  // engine.js: const REALMS = ['凡人','炼气期','筑基期','结丹期','元婴期']
  var REALMS = ['凡人', '炼气期', '筑基期', '结丹期', '元婴期'];
  // 以下为兜底常量；实际渲染优先取 rules.hpMax / player.hpMax / player.manaCap / rules.*
  var MAX_HP = 6;          // engine.js: HP_MAX（实物确认：满血 6）
  var MAX_MANA = 12;       // engine.js: MANA_MAX
  var MANA_MAX_MORTAL = 6; // engine.js: MANA_MAX_MORTAL（凡人期法力上限仅 6）
  var OVERREACH_MANA = 1;  // engine.js: OVERREACH_MANA（越级强行使用的额外法力）
  // 装备付费规则（2026-10-05 用户裁定，取代旧的"按境界分高低档"）：
  //   卡文带「（装备时不消耗【法力值】）」→ 装备免费、发动其效果才消耗；没写 → 装备时消耗、效果不再消耗

  // engine.js: diceToBonus(pip) —— 骰点是**查表**转为额外战力值，不是直接相加
  //   1 点 → +0；2~5 点 → +1；6 点 → +2
  function diceToBonus(pip) { return pip >= 6 ? 2 : pip >= 2 ? 1 : 0; }
  // rules.diceTable 拿不到时的兜底文案（engine.js publicState().rules.diceTable）
  var DICE_TABLE_TEXT = '骰点 1 → +0；2~5 → +1；6 → +2';
  // rules.equipRule 拿不到时的兜底文案
  var EQUIP_RULE_TEXT = '装备类法宝：卡文写「装备时不消耗法力值」的，装备免费、发动其效果才消耗；没写的，装备时消耗、发动效果不再消耗';

  // engine.js: DECKS 顺序与中文名
  var DECK_LIST = ['treasure', 'spell', 'companion', 'qi'];
  var DECK_NAME = { treasure: '宝物', spell: '法术', companion: '同行者', qi: '灵气' };

  // ----------------------------------------------------------------
  // 卡牌时机一律看**效果 DSL 的 when**（卡池里每张卡都带 effects: [{when, op, if}]）。
  // 以前这里手抄过一份 COMBAT_KINDS/TIE_KINDS，但只抄了 4 条（引擎有 20 条），
  // 结果一堆本该能打的牌被置灰。现在改成从 when 推导，跟引擎同一套语义。
  // ----------------------------------------------------------------
  /** 这张卡"打出去立刻生效"的效果（同行者的是场面自动触发，不算出牌窗口）
   *  ⚠️ 时机判定与 engine 的 `effect-meta.timingKey()` **同一套规则**：旧的 `when` 与新的
   *  `{event,subject,phase}` 坐标都要认（数据正在迁移，见 docs/时点规范.md §5）。 */
  function playNowEffects(def) {
    if (!def) return [];
    if (cardType(def) === 'companion') return [];
    var list = def.effects || [];
    var out = [];
    var keys = playTimingKeys();
    for (var i = 0; i < list.length; i++) {
      // 与 engine 的 playNowEffects 一致：place（放置同行者）走另一条分支
      if (primaryTimingKey(list[i]) === 'place') continue;
      if (timingKeysOf(list[i]).some(function (k) { return keys.indexOf(k) >= 0; })) out.push(list[i]);
    }
    return out;
  }
  /** 这条效果的"主时机键"（与 engine 的 timingKey 同规则：坐标优先，其次 when） */
  function primaryTimingKey(e) {
    if (!e) return null;
    if (e.event) return e.phase ? e.event + ':' + e.phase : e.event;
    if (e.when) return whenTimingKey(e.when);
    return null;
  }
  /** 旧 when → 时机键（用 /api/meta 下发的 whenTiming 翻译，不在前端重写映射表） */
  function whenTimingKey(w) {
    var t = META.whenTiming && META.whenTiming[w];
    if (t && t.event) return t.phase ? t.event + ':' + t.phase : t.event;
    return w;
  }
  /** 一条效果声明的全部时机键（可能同时写了 when 与 event） */
  function timingKeysOf(e) {
    var out = [];
    if (!e) return out;
    if (e.when) { var k = whenTimingKey(e.when); if (k && out.indexOf(k) < 0) out.push(k); }
    if (e.event) { var k2 = e.phase ? e.event + ':' + e.phase : e.event; if (out.indexOf(k2) < 0) out.push(k2); }
    return out;
  }
  /** "可以从手里打出"的时机键表（由 /api/meta 的 playWindows 翻译而来） */
  function playTimingKeys() {
    var wm = META.playWindows || [];
    var out = [];
    for (var i = 0; i < wm.length; i++) {
      var k = whenTimingKey(wm[i]);
      if (out.indexOf(k) < 0) out.push(k);
    }
    return out;
  }
  function isPlayWindow(w) { return !!(META.playWindows && META.playWindows.indexOf(w) >= 0); }
  function isCombatWindow(w) { return !!(META.combatWindows && META.combatWindows.indexOf(w) >= 0); }
  /** "对战窗口"的时机键表（由 /api/meta 的 combatWindows 翻译而来，同样不在前端手写词典） */
  function combatTimingKeys() {
    var wm = META.combatWindows || [];
    var out = [];
    for (var i = 0; i < wm.length; i++) { var k = whenTimingKey(wm[i]); if (out.indexOf(k) < 0) out.push(k); }
    return out;
  }
  /** 这条效果是不是落在某个（旧 when 名的）时机上 —— **认旧 when 与总线坐标两种写法** */
  function hasTiming(e, whenName) { return timingKeysOf(e).indexOf(whenTimingKey(whenName)) >= 0; }
  /** 这条效果是不是落在某个对战窗口上（同样认两种写法） */
  function isCombatTimingEffect(e) {
    var keys = timingKeysOf(e), ck = combatTimingKeys();
    for (var i = 0; i < keys.length; i++) if (ck.indexOf(keys[i]) >= 0) return true;
    return false;
  }
  /** 当前对战里"已经满足"的出牌窗口（与 engine.js satisfiedWindows 同一套规则） */
  function satisfiedWindows(st, me) {
    var c = st && st.combat;
    if (!c) return [];
    if (c.stage === 'tie') return ['tie'];
    if (c.stage === 'result') return c.resultStep ? [c.resultStep] : [];
    if (c.stage === 'done') return [];
    var rolled = c.dice || {};
    var foeId = c.attacker === me.id ? c.defender : c.attacker;
    var meRolled = !!rolled[me.id], foeRolled = !!rolled[foeId];
    var out = [];
    if (!meRolled && !foeRolled) out.push('combatStart');
    out.push(meRolled ? 'afterMyRoll' : 'beforeMyRoll');
    out.push(foeRolled ? 'afterFoeRoll' : 'beforeFoeRoll');
    return out;
  }
  function isCombatCard(def) {
    var list = playNowEffects(def);
    // ⚠️ 时机判定一律走归一化（旧 when 与总线坐标两种写法都认）——
    //    数据迁到坐标后 `e.when` 是 undefined，直接比 when 会让所有对战牌都不是"对战牌"。
    for (var i = 0; i < list.length; i++) if (isCombatTimingEffect(list[i])) return true;
    return false;
  }
  // 需要指定目标的卡牌效果（engine.js 的 NEEDS_TARGET，由 /api/meta 下发）
  function needsTarget(def) {
    var list = playNowEffects(def);
    var nt = META.needsTarget || [];
    for (var i = 0; i < list.length; i++) if (nt.indexOf(list[i].op) >= 0) return true;
    return false;
  }

  // 战报条目样式：kind -> { mark, cls }
  var LOG_KIND = {
    turn: { mark: '轮' }, roll: { mark: '骰' },
    combat_start: { mark: '战' }, combat_total: { mark: '算' }, combat_result: { mark: '果' },
    tie: { mark: '平' }, damage: { mark: '伤' }, heal: { mark: '愈' },
    promote: { mark: '破' }, promote_fail: { mark: '败' }, congrats: { mark: '贺' },
    draw: { mark: '抽' }, draw_qi: { mark: '灵' }, reshuffle: { mark: '洗' },
    qi_gain: { mark: '灵' }, qi_spend: { mark: '耗' }, seclusion: { mark: '关' },
    mana_spend: { mark: '法' },
    play: { mark: '出' }, discard: { mark: '弃' }, steal: { mark: '夺' },
    eliminate: { mark: '殁' }, win: { mark: '胜' },
    companion_hurt: { mark: '仆' }, companion_down: { mark: '殇' },
    timing: { mark: '时' },
    info: { mark: '·' }
  };

  var CARD_TYPE_NAME = { equip: '装备', consume: '消耗', companion: '同行者', qi: '灵气牌' };

  var STORAGE_KEY = 'fanren.jieying.session.v1';

  /* ================================================================
   * 1. DOM 工具
   * ================================================================ */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  /**
   * HTML 转义 —— 凡是把**动态数据**（玩家昵称、卡牌名、服务端文本）拼进 innerHTML 的地方，
   * 一律先过它。静态模板字符串不需要。
   * 制度：新增代码遵守「动态值走 textContent 节点 / escapeHtml，静态模板才用 innerHTML」。
   */
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** 重放动画：先移除类、强制回流，再加类（保证同一帧内也能重新触发） */
  function replayAnim(node, cls) {
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
  }

  /**
   * 按 key 复用 DOM 节点：避免整块重绘导致 CSS 动画闪烁。
   * create(key) 只在首次创建时调用；update(node,key,index) 每帧调用。
   */
  function reconcile(container, keys, create, update) {
    var existing = {};
    Array.prototype.forEach.call(container.children, function (c) {
      if (c.dataset && c.dataset.key !== undefined) existing[c.dataset.key] = c;
    });
    var seen = {};
    keys.forEach(function (key, i) {
      var node = existing[key];
      if (!node) { node = create(key); node.dataset.key = key; }
      update(node, key, i);
      seen[key] = true;
      var at = container.children[i];
      if (at !== node) container.insertBefore(node, at || null);
    });
    Object.keys(existing).forEach(function (k) {
      if (!seen[k]) { existing[k].remove(); }
    });
  }

  /* ================================================================
   * 2. 卡池缓存（GET /api/cards，只取一次）
   * ================================================================ */

  var CARDS = { byId: {}, deckOf: {}, max: {}, ready: false };

  function loadCards() {
    return fetch('/api/cards', { method: 'GET' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        DECK_LIST.forEach(function (deck) {
          var arr = Array.isArray(data[deck]) ? data[deck] : [];
          var total = 0;
          arr.forEach(function (def) {
            CARDS.byId[def.id] = def;
            CARDS.deckOf[def.id] = deck;
            total += (def.count == null ? 1 : def.count);   // 0 张就是 0 张（没这个字段才算 1）
          });
          CARDS.max[deck] = total;
        });
        CARDS.ready = true;
      })
      .catch(function () { /* 卡池拉取失败时降级：仅显示 uid 与未知牌 */ });
  }

  function cardDef(id) { return CARDS.byId[id] || null; }
  function deckOf(id) { return CARDS.deckOf[id] || 'treasure'; }
  function cardName(id) { var d = cardDef(id); return d ? d.name : id; }
  function cardType(def) { return (def && def.type) || 'consume'; }
  function effectKind(def) {
    var list = playNowEffects(def);
    return list.length ? list[0].op : null;
  }
  function realmName(i) { return REALMS[i] || '凡人'; }
  /** 卡面「适用境界」文案 */
  function realmRequirement(def) {
    var r = (def && def.realm) || 0;
    return r <= 0 ? '凡人及以上' : realmName(r) + '及以上';
  }
  function costOf(def) { return (def && typeof def.cost === 'number') ? def.cost : 0; }

  /* ================================================================
   * 3. 会话持久化（**按窗口**存）
   *    { roomId, playerId, token, name }
   *
   * ⚠️ 为什么不是"localStorage 存一份就完事"—— 2026-10-06 用户报的 bug：
   *    **同一个浏览器开两个窗口当两个玩家**是常见玩法（用户就是这么玩的），
   *    而 localStorage 全浏览器只有**一份**：
   *      ① 窗口1 创建房间（localStorage = 甲）
   *      ② 窗口2 加入房间（localStorage 被覆盖成 乙）
   *      ③ 窗口1 一刷新/重连 → `load()` 读到的是 **乙** ⇒ 两个窗口变成同一个座位，
   *         谁赢都是「你赢了 / 你正获胜！」，用户看到的就是
   *         「**战斗结算胜利时，双方都显示我方胜利**」。
   *    所以现在：本窗口的座位存 **sessionStorage**（刷新还在、窗口之间互不干扰），
   *    localStorage 只留一份"最后一次用过的座位"给**新开的窗口**兜底；
   *    再配一份"座位被哪个活窗口占着"的**心跳**（`SEAT_TTL_MS`），新窗口不会稀里糊涂
   *    跟另一个窗口坐进同一个座位（真要坐，大厅里有明确的「仍要进入」按钮）。
   * ================================================================ */

  var TAB_KEY = 'fanren.jieying.tab.v1';        // 本窗口 id（sessionStorage，刷新不变）
  var SEAT_KEY = 'fanren.jieying.seat.v1.';     // localStorage：座位 -> { tab, ts }
  var SEAT_BEAT_MS = 4000;                      // 心跳间隔
  var SEAT_TTL_MS = 12000;                      // 这么久没心跳 = 那个窗口已经不在了

  /** 本窗口的 id（存 sessionStorage：刷新仍是同一个窗口；新标签/新窗口是新的） */
  function tabId() {
    var id = null;
    try { id = sessionStorage.getItem(TAB_KEY); } catch (e) { /* 隐私模式 */ }
    if (!id) {
      id = 't' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      try { sessionStorage.setItem(TAB_KEY, id); } catch (e) { /* 忽略 */ }
    }
    return id;
  }

  function readSession(store) {
    try {
      var raw = store.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s && s.roomId && s.playerId && s.token) return s;
    } catch (e) { /* 忽略损坏数据 */ }
    return null;
  }
  function writeSession(store, s) {
    try { store.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (e) { /* 隐私模式 */ }
  }
  function dropKey(store, key) {
    try { store.removeItem(key); } catch (e) { /* 忽略 */ }
  }

  function seatKeyOf(s) { return SEAT_KEY + s.roomId + '.' + s.playerId; }

  /** 这个座位此刻是不是**别的活窗口**坐在上面（心跳还新） */
  function seatHeldByOther(s) {
    if (!s || !s.roomId || !s.playerId) return false;
    try {
      var c = JSON.parse(localStorage.getItem(seatKeyOf(s)) || 'null');
      return !!(c && c.tab && c.tab !== tabId() && (Date.now() - (c.ts || 0)) < SEAT_TTL_MS);
    } catch (e) { return false; }
  }

  var seatBeat = null;        // 心跳定时器
  var seatBeatKey = null;     // 正在续期的 key
  /** 认领座位（带心跳）：关窗口/离开时释放，别的窗口就不会以为这里还坐着人 */
  function claimSeat(s) {
    releaseSeat();
    if (!s) return;
    seatBeatKey = seatKeyOf(s);
    var beat = function () {
      try {
        var c = JSON.parse(localStorage.getItem(seatBeatKey) || 'null');
        if (c && c.tab && c.tab !== tabId()) { releaseSeat(); return; }   // 座位被别的窗口接管了：让位
        localStorage.setItem(seatBeatKey, JSON.stringify({ tab: tabId(), ts: Date.now() }));
      } catch (e) { /* 隐私模式：没有心跳也能玩，只是新窗口不知道这个座位在用 */ }
    };
    beat();
    seatBeat = setInterval(beat, SEAT_BEAT_MS);
  }
  function releaseSeat() {
    if (seatBeat) { clearInterval(seatBeat); seatBeat = null; }
    if (seatBeatKey) {
      try {
        var c = JSON.parse(localStorage.getItem(seatBeatKey) || 'null');
        if (c && c.tab === tabId()) localStorage.removeItem(seatBeatKey);
      } catch (e) { /* 忽略 */ }
      seatBeatKey = null;
    }
  }

  var Session = {
    /** 本窗口要坐的座位：sessionStorage 优先（刷新后仍是自己那份） */
    load: function () {
      var own = readSession(sessionStorage);
      if (own) return own;
      // 新窗口兜底：用"最后一次用过的座位"，但**不抢**另一个活窗口正坐着的
      var last = readSession(localStorage);
      return (last && !seatHeldByOther(last)) ? last : null;
    },
    /** 新窗口兜底那份座位 —— 哪怕正被别的窗口用着（大厅据此提示，并给「仍要进入」） */
    loadHeldElsewhere: function () {
      if (readSession(sessionStorage)) return null;
      var last = readSession(localStorage);
      return (last && seatHeldByOther(last)) ? last : null;
    },
    save: function (s) {
      writeSession(sessionStorage, s);      // 本窗口自己那份（关键）
      writeSession(localStorage, s);        // 给新窗口兜底
      claimSeat(s);
    },
    clear: function () {
      dropKey(sessionStorage, STORAGE_KEY);
      dropKey(localStorage, STORAGE_KEY);
      releaseSeat();
    }
  };

  /* ================================================================
   * 4. 网络层
   * ================================================================ */

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok) {
          var msg = (data && data.error) || ('请求失败（HTTP ' + res.status + '）');
          throw new Error(msg);
        }
        return data || {};
      });
    });
  }

  function apiCreate(name) { return post('/api/create', { name: name }); }
  function apiJoinNew(roomId, name) { return post('/api/join', { roomId: roomId, name: name }); }
  function apiJoinBack(s) { return post('/api/join', { roomId: s.roomId, playerId: s.playerId, token: s.token }); }
  function apiStart(s) { return post('/api/start', { roomId: s.roomId, playerId: s.playerId, token: s.token }); }
  function apiAgain(s) { return post('/api/again', { roomId: s.roomId, playerId: s.playerId, token: s.token }); }
  function apiAction(s, action) {
    return post('/api/action', {
      roomId: s.roomId, playerId: s.playerId, token: s.token, action: action
    });
  }

  /* ================================================================
   * 5. 全局状态
   * ================================================================ */

  var S = {
    session: null,     // 座位凭证 {roomId, playerId, token, name}
    state: null,       // 最新 publicState（+ roomId/host/seats）
    es: null,          // EventSource
    view: 'lobby',     // lobby | room | table
    busy: false,       // 是否有写操作在飞行中
    targeting: null,   // {mode:'combat'} | {mode:'card', uid}
    discardMode: false,
    discardForced: false,   // 上次的弃置模式是"回合结束超上限"强制打开的（结束时要自动退出）
    logPrev: [],       // 上一次收到的 log 数组（用于差量追加）
    seenHand: {},      // 已渲染过的手牌 uid（用于入场动画）
    stats: {},         // pid -> {hp,mana,qi,realm,out}（用于数值变化动画）
    logAtBottom: true
  };

  function myId() { return S.session ? S.session.playerId : null; }

  function myPlayer(st) {
    st = st || S.state;
    if (!st || !st.players) return null;
    var id = myId();
    for (var i = 0; i < st.players.length; i++) if (st.players[i].id === id) return st.players[i];
    return null;
  }

  function playerById(st, pid) {
    st = st || S.state;
    if (!st || !st.players) return null;
    for (var i = 0; i < st.players.length; i++) if (st.players[i].id === pid) return st.players[i];
    return null;
  }

  function playerName(st, pid) {
    var p = playerById(st, pid);
    return p ? p.name : '某位道友';
  }

  function playerSeatIndex(st, pid) {
    if (!st || !st.players) return -1;
    for (var i = 0; i < st.players.length; i++) if (st.players[i].id === pid) return i;
    return -1;
  }

  /* ================================================================
   * 6. 提示（Toast）与横幅（Banner）
   * ================================================================ */

  function toast(msg, type) {
    var layer = $('#toast-layer');
    if (!layer) return;
    var box = el('div', 'toast ' + (type || 'info'), msg);
    layer.appendChild(box);
    setTimeout(function () {
      box.classList.add('out');
      setTimeout(function () { box.remove(); }, 240);
    }, type === 'err' ? 3600 : 2400);
  }

  function banner(text, cls, ms) {
    var layer = $('#banner-layer');
    if (!layer) return;
    var b = el('div', 'banner ' + (cls || ''), text);
    layer.appendChild(b);
    setTimeout(function () { b.remove(); }, ms || 2100);
  }

  /* ================================================================
   * 7. 卡牌可打性（镜像 engine.js playable()/doPlay() 的前置校验）
   * ================================================================ */

  /**
   * 适用的境界闸门（engine.js realmGate）：三个分支共用。
   * 返回 null = 放行；{block:'原因'} = 不可打出；{overreach:true} = 消耗类可越级（额外 1 法力）。
   */
  function realmGateOf(def, me) {
    if (me.realm >= (def.realm || 0)) return null;
    if (cardType(def) === 'companion') return null;      // 同行者没有境界限制，只有占位限制
    if (cardType(def) === 'equip') return { block: def.name + ' 需要 ' + realmName(def.realm) + ' 才能装备' };
    return { overreach: true };
  }

  /** 抽取阶段（step）未完成时的打牌原因，按阶段给明确指引 */
  var STEP_HINT = {
    draw_qi: '请先点【炼化灵气牌】',
    draw_treasure: '请先点【探索 · 取两张宝物牌】',
    choose_draw: '请先二选一抽牌（法术 / 同行者）'
  };
  function stepBlockReason(step) {
    return STEP_HINT[step] || '当前不是行动阶段';
  }

  /**
   * @returns {{ok:boolean, why?:string, cost?:number, overreach?:boolean, combat?:boolean, target?:boolean}}
   */
  function checkPlay(def, me, st) {
    if (!def) return { ok: false, why: '未知卡牌' };
    if (!st || st.phase !== 'playing') return { ok: false, why: '当前不在对局中' };
    if (!me) return { ok: false, why: '你不在本局中' };
    if (me.out) return { ok: false, why: '你已出局，只能旁观' };

    var kind = effectKind(def);
    var c = st.combat;
    var nowEffects = playNowEffects(def);
    // 对战窗口：准备阶段 + 两段式掷骰的「待应战方」阶段
    var inCombatWindow = !!c && (c.stage === 'pre' || c.stage === 'roll_defender');

    // ⚠️ 对战中的出牌**全部走时点询问（链）** —— 引擎的 playable() 在这三个阶段一律拒绝
    //    direct play（见 engine.js "对战中的出牌全部走时点询问"）。
    //    前端以前还在为这些牌算"能不能打"，于是**不是当前时点的牌也会高亮**、
    //    点下去才报错（用户报过）。这里跟引擎保持一致：一律不高亮，并说明去弹窗里响应。
    if (c && (c.stage === 'pre' || c.stage === 'roll_defender')) {
      return { ok: false, why: '对战中的牌要在【斗法】弹窗里破招打出' };
    }
    if (c && c.stage === 'result') {
      return { ok: false, why: '对战结算要走【斗法】：在弹窗里打「获胜/失败时」的牌，或点「不破招·跳过」' };
    }

    // ⚠️ 下面两段（对战窗口 / 结果窗口）**目前不可达** —— 上面 430/433 两行已经用同样的条件
    //    提前返回（对战中的出牌一律走时点询问弹窗）。保留它们只为将来重新放开时不出错，
    //    因此这里也一律用**归一化时机键**判定（旧 when 与总线坐标两种写法都认）。
    if (inCombatWindow) {
      var combatCard = false;
      for (var ci = 0; ci < nowEffects.length; ci++) if (isCombatTimingEffect(nowEffects[ci])) combatCard = true;
      if (!combatCard) return { ok: false, why: '这张牌不能在对战中打出' };
      // 时机校验（与引擎一致）：只有命中当前已满足的窗口才能打。
      // 引擎用的是 META.windowOk（逐**旧窗口名**比，能区分 combatStart / beforeFoeRoll）；前端这里
      // 只做键级别的近似判断，够用是因为本分支不可达。
      var okWins = satisfiedWindows(st, me);
      var okKeys = okWins.map(whenTimingKey);
      var timingOk = false;
      for (var ti = 0; ti < nowEffects.length; ti++) {
        if (timingKeysOf(nowEffects[ti]).some(function (k) { return okKeys.indexOf(k) >= 0; })) timingOk = true;
      }
      if (!timingOk) {
        var wants = [];
        for (var wi = 0; wi < nowEffects.length; wi++) wants.push(timingText(nowEffects[wi]));
        return { ok: false, why: '此时机不可用（该牌用于：' + wants.join(' / ') + '）' };
      }
      var g0 = realmGateOf(def, me);
      if (g0 && g0.block) return { ok: false, why: g0.block };
      var over0 = !!(g0 && g0.overreach);
      var cType = cardType(def);
      if (cType === 'equip') {
        // 对战窗口内打出装备类：引擎同样会走 doPlay 的装备分支（检查放置位与高境界装备费）
        var cDeck = deckOf(def.id);
        if (cDeck === 'treasure' && me.equip.length >= me.slots.equip) {
          return { ok: false, why: '储物袋已满（' + me.slots.equip + ' 格），无法在对战中装备' };
        }
        if (cDeck === 'spell' && me.spells.length >= me.slots.spell) {
          return { ok: false, why: '法术区已满（' + me.slots.spell + ' 格），无法在对战中装备' };
        }
        var eCost = equipCostOf(def);
        if (eCost > 0 && me.mana < eCost) {
          return { ok: false, why: '装备【' + def.name + '】需 ' + eCost + ' 点法力值（当前 ' + me.mana + '）' };
        }
        return { ok: true, cost: eCost, combat: true };
      }
      var cCost = costOf(def) + (over0 ? OVERREACH_MANA : 0);
      if (cCost > 0 && me.mana < cCost) {
        return { ok: false, why: '法力值不足（需要 ' + cCost + '，当前 ' + me.mana + '）' };
      }
      return { ok: true, cost: cCost, overreach: over0, combat: true, target: needsTarget(def) };
    }
    // —— 结果窗口：战果已定，赢家用「获胜窗口」、输家用「失败窗口」，各限一张
    if (c && c.stage === 'result') {
      var side = me.id === c.winnerId ? 'win' : (me.id === c.loserId ? 'lose' : null);
      if (!side) return { ok: false, why: '你不是本次对战的参与者' };
      if (c.resultStep !== side) return { ok: false, why: '现在不是你的结算时机' };
      if (c.resultUsed && c.resultUsed[side]) return { ok: false, why: '你已经在这个结算时机出过牌了' };
      var hasSide = false;
      for (var ri = 0; ri < nowEffects.length; ri++) if (hasTiming(nowEffects[ri], side)) hasSide = true;
      if (!hasSide) {
        return { ok: false, why: side === 'win' ? '这张牌不是「对战获胜时」使用的' : '这张牌不是「对战失败时」使用的' };
      }
      var g2 = realmGateOf(def, me);
      if (g2 && g2.block) return { ok: false, why: g2.block };
      var over2 = !!(g2 && g2.overreach);
      var rCost = costOf(def) + (over2 ? OVERREACH_MANA : 0);
      if (rCost > 0 && me.mana < rCost) return { ok: false, why: '法力值不足（需要 ' + rCost + '，当前 ' + me.mana + '）' };
      return { ok: true, cost: rCost, overreach: over2, result: side, target: needsTarget(def) };
    }
    // —— 平局结算阶段：只能打出「对战平局时」的牌（时机判定走归一化，认旧 when 与总线坐标）
    if (c && c.stage === 'tie') {
      var tieOk = false;
      for (var qi = 0; qi < nowEffects.length; qi++) if (hasTiming(nowEffects[qi], 'tie')) tieOk = true;
      if (!tieOk) return { ok: false, why: '平局阶段只能打出改变战力结果的卡牌' };
      var g1 = realmGateOf(def, me);
      if (g1 && g1.block) return { ok: false, why: g1.block };
      var over1 = !!(g1 && g1.overreach);
      var tCost = costOf(def) + (over1 ? OVERREACH_MANA : 0);
      if (tCost > 0 && me.mana < tCost) {
        return { ok: false, why: '法力值不足（需要 ' + tCost + '，当前 ' + me.mana + '）' };
      }
      return { ok: true, cost: tCost, overreach: over1, tie: true, target: needsTarget(def) };
    }
    if (c) return { ok: false, why: '对战结算中，只能打出对战类卡牌' };

    if (st.turn !== me.id) return { ok: false, why: '现在不是你的回合' };
    if (st.step !== 'action') return { ok: false, why: stepBlockReason(st.step) };

    var g = realmGateOf(def, me);
    if (g && g.block) return { ok: false, why: g.block };
    var overreach = !!(g && g.overreach);

    var type = cardType(def);
    if (type === 'equip') {
      // 装备费按卡文（带「装备时不消耗」→ 免费；没写 → 装备时付）
      var ec = equipCostOf(def);
      if (ec > 0 && me.mana < ec) {
        return { ok: false, why: '装备【' + def.name + '】需 ' + ec + ' 点法力值（当前 ' + me.mana + '）' };
      }
      var deck = deckOf(def.id);
      if (deck === 'treasure' && me.equip.length >= me.slots.equip) {
        return { ok: false, why: '储物袋已满（' + me.slots.equip + ' 格），请先弃置装备' };
      }
      if (deck === 'spell' && me.spells.length >= me.slots.spell) {
        return { ok: false, why: '法术区已满（' + me.slots.spell + ' 格）' };
      }
      return { ok: true, cost: ec };
    }
    if (type === 'companion') {
      // 同行者无境界限制，只受占位限制（部分同行者占 2 格）
      var need = companionSlotCost(def);
      var used = companionUsedOf(me);
      var cap = me.slots.companion;
      if (used + need > cap) {
        return { ok: false, why: '同行者位不足：占 ' + need + ' 位，当前已用 ' + used + '/' + cap };
      }
      return { ok: true, cost: 0 };
    }
    var cost = costOf(def) + (overreach ? OVERREACH_MANA : 0);
    if (cost > 0 && me.mana < cost) {
      return { ok: false, why: '法力值不足（需要 ' + cost + '，当前 ' + me.mana + '）' };
    }
    return { ok: true, cost: cost, overreach: overreach, target: needsTarget(def) };
  }

  /**
   * 目标合法性（镜像 engine.js 的校验）
   *   mode='combat' —— doCombat()：不可向低于自己两个境界者发起；出局者与闭关者不可为对象
   *   mode='card'   —— resolveEffect()：出局者与闭关者不受卡牌效果影响
   * @returns {{ok:Object, why:Object, list:Array}}
   */
  function targetInfo(st, mode) {
    var me = myPlayer(st);
    var ok = {}, why = {}, list = [];
    if (!st || !st.players || !me) return { ok: ok, why: why, list: list };
    st.players.forEach(function (p) {
      if (p.id === me.id) { why[p.id] = '不能选择自己'; return; }
      if (p.out) { why[p.id] = '已出局'; return; }
      if (p.inSeclusion) { why[p.id] = '闭关中，不受卡牌影响'; return; }
      // ⭐ 【隐灵纱】【神风舟】：只挡**对战目标**，不挡"指定一位修士受伤"那类卡牌效果
      if (mode === 'combat' && p.noTarget) { why[p.id] = '隐去行迹（到其下回合开始前无法被指定为对战目标）'; return; }
      if (mode === 'combat' && me.realm - p.realm >= 2) {
        why[p.id] = '不可向低两个境界发起（你 ' + (me.realmName || realmName(me.realm)) +
          ' · 对方 ' + (p.realmName || realmName(p.realm)) + '）';
        return;
      }
      ok[p.id] = true;
      list.push(p);
    });
    return { ok: ok, why: why, list: list };
  }

  function targetCandidates(st, mode) {
    return targetInfo(st, mode || 'card').list;
  }

  /* engine.js publicState().rules 的兜底（字段缺失时仍能渲染） */
  var RULES_FALLBACK = {
    handLimits: { treasure: 6, spell: 2, companion: 2 },
    diceTable: DICE_TABLE_TEXT,
    promoteConsume: [0, 2, 2, 3],
    promoteDice: [0, 0, 4, 5],
    manaRegen: 1,
    hpMax: MAX_HP,
    manaMax: MAX_MANA,
    manaMaxMortal: MANA_MAX_MORTAL,
    equipRule: EQUIP_RULE_TEXT
  };
  function rulesOf(st) { return (st && st.rules) ? st.rules : RULES_FALLBACK; }

  /** 生命上限：优先 player.hpMax，其次 rules.hpMax */
  function hpMaxOf(st, p) {
    if (p && typeof p.hpMax === 'number') return p.hpMax;
    return rulesOf(st).hpMax || MAX_HP;
  }
  /** 法力上限：优先 player.manaCap（凡人 6 / 其余 12），其次 rules */
  function manaCapOf(st, p) {
    if (p && typeof p.manaCap === 'number') return p.manaCap;
    var r = rulesOf(st);
    if (p && p.realm === 0 && typeof r.manaMaxMortal === 'number') return r.manaMaxMortal;
    return r.manaMax || MAX_MANA;
  }

  /* --- 装备付费（2026-10-05 用户裁定：只看卡文，不分高低境界） --- */
  /** 卡文带「（装备时不消耗【法力值】）」→ 装备免费 */
  function equipFreeByText(def) { return /装备时不消耗/.test((def && def.text) || ''); }
  /** 装备时要付的法力（单独印的 equipCost 优先，如【虚天鼎 乾蓝冰焰】=5；卡文免费 → 0） */
  function equipCostOf(def) {
    if (def && typeof def.equipCost === 'number') return def.equipCost;
    return equipFreeByText(def) ? 0 : costOf(def);
  }
  /** 装备位上的完整说明（装备说明弹窗 / title） */
  function equipTierText(def, st) {
    var ec = equipCostOf(def);
    return ec > 0
      ? '装备时付 ' + ec + ' 点法力值（发动其效果不再消耗）'
      : '装备不消耗法力值（发动其效果时才消耗）';
  }
  /** 手牌上的短标注 */
  function equipTierShort(def, st) {
    var ec = equipCostOf(def);
    return ec > 0 ? ('装备付 ' + ec + ' 法力 · 效果不再消耗') : '装备免费 · 效果才计费';
  }

  /* --- 法术类装备的多境界档位（engine.js tierEffect / maxTierFor / resolveTier） --- */

  /** 当前境界允许的最高档下标（镜像 engine.js maxTierFor）。用户裁定后**档位一律自动适配**，
   *  所以前端只需要"算当前生效哪一档"，不再需要"列出可选的档"。 */
  function maxTierFor(def, realm) {
    if (!def || !def.tiers || !def.tiers.length) return 0;
    var best = 0;
    for (var i = 0; i < def.tiers.length; i++) {
      if ((def.tiers[i].realm || 0) <= (realm || 0)) best = i;
    }
    return best;
  }
  /** 已装备实例的档位名（如「结丹期档」） */
  function equippedTierLabel(def, inst) {
    if (!def || !def.tiers || !def.tiers.length) return '';
    var i = (typeof inst.tier === 'number') ? inst.tier : 0;
    var t = def.tiers[i];
    return t ? (realmName(t.realm) + '档') : '';
  }

  /** 同行者占位（engine.js companionSlotCost：卡面 slots，1 或 2） */
  function companionSlotCost(def) {
    var n = def && def.slots;
    return (typeof n === 'number' && n > 0) ? n : 1;
  }
  function companionUsedOf(me) {
    return (me && typeof me.companionUsedSlots === 'number') ? me.companionUsedSlots : 0;
  }
  /** 同行者替挡次数（engine.js 的 absorb 字段）。0 = 不替挡，伤害直接落主人身上。 */
  function absorbTimes(def) {
    if (!def) return 0;
    var a = def.absorb;
    if (a === true) return 1;
    return (typeof a === 'number' && a > 0) ? a : 0;
  }

  /**
   * 晋升三条件文案（engine.js publicState 的 player 字段）：
   *   nextThreshold    —— 需「达到」的灵气值（已计入 同行者常驻折扣 + 一次性门槛折扣）
   *   nextConsume      —— 晋升要「消耗」的灵气值（已计入一次性消耗折扣，如【娑罗珠】）
   *   nextConsumeBase  —— 折扣前的固定消耗（用来把原价划掉显示）
   *   nextDice         —— 需掷出的骰点下限，0 表示不需要掷骰
   */
  function promoteConditionText(pl, short) {
    if (!pl) return '';
    if (pl.realm >= 4) return '已结成元婴';
    var t = [];
    t.push('灵气 ≥' + (pl.nextThreshold === null || pl.nextThreshold === undefined ? '?' : pl.nextThreshold));
    var consumeBase = (typeof pl.nextConsumeBase === 'number') ? pl.nextConsumeBase : pl.nextConsume;
    t.push('消耗 ' + (pl.nextConsume || 0) + (consumeBase !== pl.nextConsume ? '（原 ' + consumeBase + '）' : ''));
    t.push((pl.nextDice || 0) > 0 ? ('掷骰 ≥' + pl.nextDice) : '无需掷骰');
    return t.join(short ? '　' : ' · ');
  }

  /* ================================================================
   * 8. 视图切换 · 大厅 · 房间
   * ================================================================ */

  function setView(name) {
    if (S.view === name) return;
    S.view = name;
    ['lobby', 'room', 'table'].forEach(function (v) {
      var node = $('#view-' + v);
      if (node) node.classList.toggle('hidden', v !== name);
    });
    if (name !== 'lobby') S.targeting = null;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('房间码已复制：' + text, 'ok'); },
        function () { fallbackCopy(text); });
      return;
    }
    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('房间码已复制：' + text, 'ok');
    } catch (e) {
      toast('复制失败，请手动记下：' + text, 'err');
    }
  }

  function renderLobby() {
    var nameInput = $('#input-name');
    if (nameInput && !nameInput.value && S.session && S.session.name) nameInput.value = S.session.name;
    var btn = $('#btn-reconnect');
    if (btn) {
      if (S.session) {
        btn.classList.remove('hidden');
        // 这个座位正被**另一个窗口**坐着：按钮明说是"抢进来"，别让人以为点一下没事
        // （两个窗口坐同一个人 = 谁赢都显示「我方胜利」，用户 2026-10-06 报的 bug）
        btn.textContent = seatHeldByOther(S.session)
          ? '仍要进入 · 房间 ' + S.session.roomId + '（另一个窗口也在用）'
          : '回到牌桌 · 房间 ' + S.session.roomId;
      } else {
        btn.classList.add('hidden');
      }
    }
  }

  /** 大厅提示条（见 Session 的说明：只用来讲清"另一个窗口正坐着这个座位"） */
  function lobbyNotice(html) {
    var box = $('#lobby-notice');
    if (!box) return;
    if (!html) { box.innerHTML = ''; box.classList.add('hidden'); return; }
    box.innerHTML = html;
    box.classList.remove('hidden');
  }

  function roomIdOf(st) {
    return (st && st.roomId) || (S.session && S.session.roomId) || '----';
  }

  function renderRoom(st) {
    var rid = roomIdOf(st);
    $('#room-code').textContent = rid;

    var seats = (st && st.seats) ? st.seats.slice()
      : (st && st.players ? st.players.map(function (p) {
        return { id: p.id, name: p.name, connected: p.connected };
      }) : []);

    var list = $('#room-seats');
    list.innerHTML = '';
    var total = 4;
    for (var i = 0; i < total; i++) {
      var seat = seats[i];
      var row = el('li', 'seat-row' + (seat ? '' : ' empty'));
      row.appendChild(el('span', 'seat-idx', String(i + 1)));
      if (seat) {
        row.appendChild(el('span', 'seat-name', seat.name));
        if (seat.id === (st && st.host)) row.appendChild(el('span', 'seat-tag', '房主'));
        if (seat.id === myId()) row.appendChild(el('span', 'seat-tag you', '你'));
        var dot = el('span', 'seat-dot' + (seat.connected ? ' on' : ''));
        dot.title = seat.connected ? '在线' : '离线';
        row.appendChild(dot);
      } else {
        row.appendChild(el('span', 'seat-name', '虚位以待……'));
      }
      list.appendChild(row);
    }

    var isHost = !!(st && st.host && st.host === myId());
    var btnStart = $('#btn-start');
    var hint = $('#room-hint');
    var n = seats.length;

    if (isHost) {
      btnStart.classList.remove('hidden');
      btnStart.disabled = n < 2;
      hint.textContent = n < 2 ? '至少需要 2 位道友。' : (n >= 4 ? '已满座，随时开局。' : '当前 ' + n + ' 人，也可直接开局。');
    } else {
      btnStart.classList.add('hidden');
      hint.textContent = n < 2 ? '至少需要 2 位道友。' : '等待房主开仙门……';
    }
  }

  /* ================================================================
   * 9. 牌桌 · 玩家面板（按实物板子：左侧 2×2 放置区 + 右侧灵根资质竖牌）
   *    我方永远在屏幕下方并放大；敌方在屏幕上方排成一排（可横向滚动）。
   * ================================================================ */

  var ICON = {
    hp: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#e05a5a" stroke-width="1.8"><path d="M12 20s-7-4.6-7-9.4A4.2 4.2 0 0 1 12 7a4.2 4.2 0 0 1 7 3.6C19 15.4 12 20 12 20z"/></svg>',
    mana: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#5a8ce0" stroke-width="1.8"><path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7a5 5 0 1 1-5 5"/><circle cx="12" cy="12" r="1.6" fill="#5a8ce0" stroke="none"/></svg>',
    qi: '<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="#5fc9a0" stroke-width="1.8"><path d="M12 3c3 4 6 6 6 10a6 6 0 0 1-12 0c0-4 3-6 6-10z"/><path d="M12 9v9"/></svg>'
  };

  /** 生成 n 个圆点（境界轨道 / 生命 / 法力都用它） */
  function dotsHtml(n, cls) {
    var s = '';
    for (var i = 0; i < n; i++) s += '<i class="' + cls + '"></i>';
    return s;
  }

  function buildPlayerCard(pid) {
    var card = el('article', 'board');
    card.dataset.pid = pid;
    card.innerHTML =
      '<div class="bd-float"></div>' +
      '<header class="bd-head">' +
        '<span class="bd-seat"></span>' +
        '<span class="bd-name"></span>' +
        '<span class="bd-crown hidden" title="房主">♛</span>' +
        '<span class="bd-you hidden">你</span>' +
        '<span class="bd-secl hidden"></span>' +
        '<span class="bd-offline hidden">离线</span>' +
        '<span class="bd-out hidden">已出局</span>' +
        '<span class="bd-base" title="基础战力值">战力 <b>1</b></span>' +
      '</header>' +
      '<div class="bd-body">' +
        '<div class="bd-cells">' +
          // 左列上：储物袋
          '<section class="bd-cell cell-bag">' +
            '<h4 class="bd-label">储物袋 <b class="bd-count"></b></h4>' +
            '<span class="bd-hint">第 2 格 · 炼气及以上可扩充</span>' +
            '<div class="chips" data-slot="equip"></div>' +
          '</section>' +
          // 右列上：法术区
          '<section class="bd-cell cell-spell">' +
            '<h4 class="bd-label">法术 <b class="bd-count"></b></h4>' +
            '<span class="bd-hint">只有 1 格（与境界无关）</span>' +
            '<div class="chips" data-slot="spell"></div>' +
          '</section>' +
          // 左列下：同行者
          '<section class="bd-cell cell-comp">' +
            '<h4 class="bd-label">同行者 <b class="bd-count"></b></h4>' +
            '<span class="bd-hint">第 2 格 · 筑基及以上可扩充</span>' +
            '<div class="chips" data-slot="companion"></div>' +
          '</section>' +
          // 左列再下：傀儡位（独立于储物袋/法术区/同行者，实物【傀儡蜥蜴】专用）
          '<section class="bd-cell cell-puppet">' +
            '<h4 class="bd-label">傀儡位 <b class="bd-count"></b></h4>' +
            '<span class="bd-hint">不占储物袋格子 · 每次替伤消耗 2 点法力</span>' +
            '<div class="chips" data-slot="puppet"></div>' +
          '</section>' +
          // 右列下：当前境界 + 生命/法力轨道
          '<section class="bd-cell cell-realm">' +
            '<h4 class="bd-label">当前境界</h4>' +
            '<ol class="bd-track">' +
              '<li class="rdot" data-r="0"><i></i><span>凡人</span></li>' +
              '<li class="rdot" data-r="1"><i></i><span>炼气</span></li>' +
              '<li class="rdot" data-r="2"><i></i><span>筑基</span></li>' +
              '<li class="rdot" data-r="3"><i></i><span>结丹</span></li>' +
              '<li class="rdot" data-r="4"><i></i><span>元婴</span></li>' +
            '</ol>' +
            '<div class="bd-vitals">' +
              '<div class="vital vital-hp" title="生命值：归零即淘汰">' + ICON.hp +
                '<span class="vt-label">生命值</span>' +
                '<span class="vt-dots" data-dots="hp">' + dotsHtml(12, 'd') + '</span>' +
                '<b class="vt-num hp-num"></b></div>' +
              '<div class="vital vital-mana" title="法力值">' + ICON.mana +
                '<span class="vt-label">法力值</span>' +
                '<span class="vt-dots" data-dots="mana">' + dotsHtml(12, 'd') + '</span>' +
                '<b class="vt-num mana-num"></b></div>' +
              '<div class="vital vital-qi" title="灵气值 = 灵气区里灵气牌的张数">' + ICON.qi +
                '<span class="vt-label">灵气值</span>' +
                '<b class="vt-num qi-val"></b></div>' +
            '</div>' +
            '<div class="bd-extra">' +
              '<span class="bd-shield hidden"></span>' +
              '<span class="bd-next"></span>' +
            '</div>' +
          '</section>' +
        '</div>' +
        // 右侧竖排：灵根资质
        '<aside class="bd-root" title="灵根资质">' +
          '<span class="root-cap">灵根资质</span>' +
          '<span class="root-name"></span>' +
          '<span class="root-cost"></span>' +
        '</aside>' +
      '</div>' +
      '<footer class="bd-foot">' +
        '<span class="foot-hand">手牌 <b class="hand-num">0</b></span>' +
        '<span class="hc-mini"></span>' +
      '</footer>';
    return card;
  }

  function updatePlayerCard(card, p, st) {
    var me = myPlayer(st);
    var idx = playerSeatIndex(st, p.id);
    var isTurn = st.turn === p.id && st.phase === 'playing';
    var isMe = !!(me && p.id === me.id);

    card.classList.toggle('is-turn', !!isTurn);
    card.classList.toggle('is-me', isMe);
    card.classList.toggle('is-foe', !isMe);
    card.classList.toggle('is-out', !!p.out);
    card.dataset.pid = p.id;
    card.classList.remove('not-targetable');
    card.removeAttribute('data-twhy');
    card.classList.toggle('is-seclusion', !!p.inSeclusion);

    $('.bd-seat', card).textContent = 'P' + (idx + 1);
    $('.bd-name', card).textContent = p.name;
    $('.bd-crown', card).classList.toggle('hidden', !p.host);
    $('.bd-you', card).classList.toggle('hidden', !isMe);
    $('.bd-offline', card).classList.toggle('hidden', p.connected !== false);
    $('.bd-out', card).classList.toggle('hidden', !p.out);
    $('.bd-base b', card).textContent = p.baseCombat;

    // 闭关：inSeclusion = 闭关中；seclusionUsed = 一局一次已用掉
    var secl = $('.bd-secl', card);
    if (p.inSeclusion) {
      secl.classList.remove('hidden');
      secl.textContent = '闭关中';
      secl.title = '闭关中：不会成为对战对象，也不受任何卡牌效果影响';
    } else if (p.noTarget) {
      // ⭐ 实物【隐灵纱】【神风舟】："到自己的下回合开始前无法被指定为对战目标"
      //    —— 同时**也影响别人的"发起对战"**：引擎会直接拒，前端把目标置灰（见 targetInfo）。
      secl.classList.remove('hidden');
      secl.textContent = '隐去行迹';
      secl.title = '无法被指定为对战目标（到其下回合开始前）';
    } else if (p.blockQiDraw > 0) {
      // ⭐ 实物【拘灵阵】：本回合无法抽取【灵气牌】（手动炼化与卡牌效果都禁）
      secl.classList.remove('hidden');
      secl.textContent = '灵气封锁';
      secl.title = '被【拘灵阵】封锁：本回合无法抽取【灵气牌】';
    } else if (p.seclusionUsed) {
      secl.classList.remove('hidden');
      secl.textContent = '闭关已用';
      secl.title = '本局已使用过闭关（一局仅限一次）';
    } else {
      secl.classList.add('hidden');
    }

    // —— 境界轨道：5 个圆点，当前位置高亮，已过的境界点亮「已达成」
    var dots = card.querySelectorAll('.bd-track .rdot');
    Array.prototype.forEach.call(dots, function (d) {
      var r = parseInt(d.dataset.r, 10);
      d.classList.toggle('on', r === p.realm);
      d.classList.toggle('passed', r < p.realm);
      d.classList.toggle('future', r > p.realm);
    });
    card.dataset.realm = String(p.realm);

    // —— 生命值圆点（player.hpMax 个）
    var hpCap = hpMaxOf(st, p);
    var hpDots = $('[data-dots="hp"]', card);
    if (hpDots.children.length !== hpCap) hpDots.innerHTML = dotsHtml(hpCap, 'd');
    Array.prototype.forEach.call(hpDots.children, function (d, i) {
      d.classList.toggle('on', i < p.hp);
      d.classList.toggle('lost', i >= p.hp && i < hpCap);
    });
    $('.hp-num', card).textContent = p.hp + '/' + hpCap;
    $('.vital-hp', card).title = '生命值上限 ' + hpCap + ' 点，归零即淘汰';

    // —— 法力值轨道固定 12 格（rules.manaMax），超出当前上限的格子画成暗格，
    //    这样凡人期一眼能看出「只能用到 6」
    var manaCap = manaCapOf(st, p);
    var manaMax = rulesOf(st).manaMax || MAX_MANA;
    var manaDots = $('[data-dots="mana"]', card);
    if (manaDots.children.length !== manaMax) manaDots.innerHTML = dotsHtml(manaMax, 'd');
    Array.prototype.forEach.call(manaDots.children, function (d, i) {
      var locked = i >= manaCap;
      d.classList.toggle('locked', locked);
      d.classList.toggle('on', !locked && i < p.mana);
      d.classList.toggle('off', !locked && i >= p.mana);
    });
    $('.mana-num', card).textContent = p.mana + '/' + manaCap;
    $('.vital-mana', card).title = '法力值上限 ' + manaCap + ' 点（凡人期 6 / 炼气期及以上 12）' +
      (manaCap < manaMax ? '；灰色 ' + (manaMax - manaCap) + ' 格未解锁' : '');

    $('.qi-val', card).textContent = p.qi;

    var shield = $('.bd-shield', card);
    if (p.shield > 0) { shield.classList.remove('hidden'); shield.textContent = '护体 ' + p.shield; }
    else shield.classList.add('hidden');

    // 灵根资质竖牌：名字竖排 + 悬浮显示五档门槛
    var rootName = $('.root-name', card);
    rootName.textContent = p.rootName || '';
    var rc = $('.root-cost', card);
    if (p.rootCosts && p.rootCosts.length) {
      rc.innerHTML = p.rootCosts.map(function (c, i) {
        return '<span class="rc-row' + (i === p.realm ? ' cur' : '') + '"><i>' + realmName(i + 1) + '</i>' + c + '</span>';
      }).join('');
      $('.bd-root', card).title = (p.rootName || '') + ' · 晋升门槛（炼气/筑基/结丹/元婴）：' + p.rootCosts.join(' / ') + ' 灵气';
    } else {
      rc.innerHTML = '';
    }

    // 晋升三条件（nextThreshold / nextConsume / nextDice）
    var next = $('.bd-next', card);
    if (p.realm >= 4) { next.textContent = '已至元婴'; next.title = ''; }
    else {
      var consumeBase = (typeof p.nextConsumeBase === 'number') ? p.nextConsumeBase : p.nextConsume;
      var consumeTxt = '耗 ' + (p.nextConsume || 0);
      // 消耗被【娑罗珠】这类「使本次晋升消耗的灵气值-1」减过时，把原价标出来
      if (typeof consumeBase === 'number' && consumeBase !== p.nextConsume) {
        consumeTxt += '<s>' + consumeBase + '</s>';
      }
      next.innerHTML = '晋升 ≥<b>' + p.nextThreshold + '</b> 灵气 · ' + consumeTxt +
        ' · ' + ((p.nextDice || 0) > 0 ? '骰 ≥<b>' + p.nextDice + '</b>' : '无需掷骰');
      var thDisc = (typeof p.nextCost === 'number' && p.nextThreshold !== null) ? (p.nextCost - p.nextThreshold) : 0;
      var csDisc = (typeof consumeBase === 'number' && consumeBase !== p.nextConsume) ? (consumeBase - p.nextConsume) : 0;
      var discNotes = [];
      if (thDisc) discNotes.push('门槛减免 ' + thDisc + ' 点');
      if (csDisc) discNotes.push('消耗减免 ' + csDisc + ' 点');
      next.title = promoteConditionText(p) +
        (discNotes.length
          ? '（灵根符门槛 ' + p.nextCost + '，已由同行者/宝物减免：' + discNotes.join('、') + '）'
          : '');
    }

    // 放置区：储物袋 / 法术区 / 同行者区（同行者按占位格数）
    fillSlots($('[data-slot="equip"]', card), p.equip, p.slots.equip, 'equip');
    fillSlots($('[data-slot="spell"]', card), p.spells, p.slots.spell, 'spell');
    fillSlots($('[data-slot="companion"]', card), p.companions, p.slots.companion, 'companion', companionUsedOf(p));
    // 傀儡位：独立显示区，不占储物袋格子
    fillSlots($('[data-slot="puppet"]', card), p.puppets || [], 1, 'puppet');

    $('.hand-num', card).textContent = p.handCount;
    var mini = $('.hc-mini', card);
    var hc = p.handCounts || {};
    mini.innerHTML =
      '<i class="m-treasure">宝 ' + (hc.treasure || 0) + '</i>' +
      '<i class="m-spell">法 ' + (hc.spell || 0) + '</i>' +
      '<i class="m-companion">同 ' + (hc.companion || 0) + '</i>';
  }

  /** 本回合已发动过「一回合一次」效果的牌（uid 数组，字符串；只有本人视图里有） */
  function usedTurnUids(st) {
    var me = myPlayer(st);
    return (me && me.turnUsedUids) || [];
  }

  /**
   * 渲染一个放置区。
   * kind：'equip' 储物袋 / 'spell' 法术区 / 'companion' 同行者区（按占位格数计算）
   */
  function fillSlots(container, list, slots, kind, usedSlots) {
    var st = S.state;
    var countNode = container.parentNode.querySelector('.bd-count');
    var used = (kind === 'companion') ? (usedSlots || 0) : list.length;
    if (countNode) {
      countNode.textContent = used + '/' + slots;
      countNode.classList.toggle('full', used >= slots);
      countNode.title = used >= slots ? '已满：无法再放入（' + (kind === 'companion' ? '按占位格数计算' : '每件占 1 格') + '）' : '还可放入 ' + (slots - used);
    }
    container.innerHTML = '';
    if (!list.length) {
      container.appendChild(el('span', 'sg-empty', kind === 'companion' ? '虚位以待' : '空'));
      return;
    }
    list.forEach(function (inst) {
      var def = cardDef(inst.id);
      var chip = el('span', 'eq-chip deck-' + deckOf(inst.id));
      chip.appendChild(el('span', 'eq-name', def ? def.name : inst.id));

      var tips = [];
      if (def && def.text) tips.push(def.text);

      if (def && def.type === 'equip') {
        // 装备付费按卡文（2026-10-05）：带「装备时不消耗」→ 免费；没写 → 装备时付 —— 不再标高低境界
        var ec = equipCostOf(def);
        chip.classList.add(ec > 0 ? 'tier-high' : 'tier-low');
        chip.appendChild(el('span', 'eq-badge tier-badge', ec > 0 ? ('装备费' + ec) : '装备免费'));
        tips.push(equipTierText(def, st));
        // 法术类装备的多境界档位：实例上的 tier 下标
        if (def.tiers && def.tiers.length > 1 && typeof inst.tier === 'number') {
          var t = def.tiers[inst.tier];
          if (t) {
            chip.classList.add('has-tiers');
            chip.appendChild(el('span', 'eq-badge tier-pick', realmName(t.realm) + '档'));
            tips.push('当前生效档位：' + String(t.text || ''));
          }
        }
      } else if (kind === 'puppet' && def) {
        // 傀儡位：独立显示区，不占储物袋；每次替伤消耗法力，用完进弃牌堆
        var left = (typeof inst.left === 'number') ? inst.left : 2;
        var mc = (typeof inst.manaCost === 'number') ? inst.manaCost : 2;
        chip.classList.add('puppet-chip');
        chip.appendChild(el('span', 'eq-badge absorb-badge', '替伤 ' + left + ' 次'));
        tips.push('傀儡：替主人挡下整次伤害，每次消耗 ' + mc + ' 点法力值；剩余 ' + left + ' 次');
        tips.push('占用独立的【傀儡位】，不占储物袋格子');
      } else if (kind === 'companion' && def) {
        var need = companionSlotCost(def);
        var ab = absorbTimes(def);
        if (ab > 0) {
          chip.classList.add('absorb');
          chip.appendChild(el('span', 'eq-badge absorb-badge', '替挡 ' + ab + ' 次'));
          tips.push('替挡：可替你承受任意 ' + ab + ' 次伤害（整次全挡下），之后进弃牌堆');
        } else {
          chip.appendChild(el('span', 'eq-badge slot-badge', '占 ' + need + ' 位'));
          tips.push('同行者：占 ' + need + ' 个放置位，提供常驻效果（不替挡伤害）');
        }
      }

      // 「一回合一次」的牌：本回合已经发动过 → 打角标。
      // `turnUsedUids` 只有**本人视图**里才有这个字段，所以别人的牌不会被误标。
      if (usedTurnUids(st).map(String).indexOf(String(inst.uid)) >= 0) {
        chip.classList.add('used-this-turn');
        chip.appendChild(el('span', 'eq-badge used-badge', '本回合已发动'));
        tips.push('这张牌有「一回合一次」的效果，本回合已经发动过了（下个回合恢复）');
      }

      chip.title = tips.join('\n');
      chip.dataset.cardId = inst.id;
      chip.dataset.uid = inst.uid;
      container.appendChild(chip);
    });
  }

  /**
   * 桌面视角：我方永远在屏幕下方（#me-grid），敌方在屏幕上方排成一排（#foe-grid）。
   * 2 人局 1 个敌方、3 人局 2 个、4 人局 3 个。
   */
  function renderPlayers(st) {
    var meId = myId();
    var foes = [], mine = [];
    st.players.forEach(function (p) { (p.id === meId ? mine : foes).push(p); });
    // 敌方按座位顺序排列（先手在左）
    foes.sort(function (a, b) { return a.seat - b.seat; });

    var foeGrid = $('#foe-grid'), meGrid = $('#me-grid');
    foeGrid.setAttribute('data-count', String(foes.length));
    foeGrid.parentNode.classList.toggle('single', foes.length <= 1);

    reconcile(foeGrid, foes.map(function (p) { return p.id; }),
      function (pid) { return buildPlayerCard(pid); },
      function (node, pid) {
        var p = playerById(st, pid);
        if (p) updatePlayerCard(node, p, st);
      });

    reconcile(meGrid, mine.map(function (p) { return p.id; }),
      function (pid) { return buildPlayerCard(pid); },
      function (node, pid) {
        var p = playerById(st, pid);
        if (p) updatePlayerCard(node, p, st);
      });

    applyTargetingHighlight(st);
  }

  /** 两块面板区（敌方 / 我方）统一遍历 */
  function eachBoard(fn) {
    $$('#foe-grid > .board, #me-grid > .board').forEach(fn);
  }

  /* ================================================================
   * 10. 牌桌 · 手牌
   * ================================================================ */

  function buildHandCard(uid) {
    var btn = el('button', 'hand-card');
    btn.type = 'button';
    btn.innerHTML =
      '<span class="hc-cost"></span>' +
      '<span class="hc-tag"></span>' +
      '<span class="hc-name"></span>' +
      '<span class="hc-realm"></span>' +
      '<span class="hc-text"></span>' +
      '<span class="hc-why"></span>' +
      '<span class="hc-info" title="查看卡牌全文">i</span>';
    var info = $('.hc-info', btn);
    info.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openCardModal(btn.dataset.cardId, btn.dataset.reason || '');
    });
    return btn;
  }

  /** 更新一张手牌（复用节点，保留动画） */
  function updateHandCard(node, uid, me, st, opts) {
    opts = opts || {};
    var inst = null;
    if (me && me.hand) {
      for (var i = 0; i < me.hand.length; i++) if (String(me.hand[i].uid) === String(uid)) { inst = me.hand[i]; break; }
    }
    var def = inst ? cardDef(inst.id) : (opts.def || null);
    var deck = def ? deckOf(def.id) : 'treasure';
    var type = cardType(def);

    node.dataset.uid = String(uid);
    node.dataset.cardId = def ? def.id : '';
    node.className = 'hand-card deck-' + deck;

    var chk = checkPlay(def, me, st);
    var playable = chk.ok;
    if (opts.combatStrip && playable && !isCombatCard(def)) playable = false;
    if (opts.forcePlayable) playable = true;

    node.classList.add(playable ? 'is-playable' : 'is-blocked');
    if (def && isCombatCard(def)) node.classList.add('is-combat-card');
    var selected = S.targeting && S.targeting.mode === 'card' && String(S.targeting.uid) === String(uid);
    node.classList.toggle('is-selected', !!selected);

    //   点了也一样要能丢 —— 强制弃牌跟"现在能不能打出"无关（境界不够、阶段不对的牌照样要丢）。
    node.disabled = S.discardMode ? false : (!playable && !opts.forceClickable);
    node.classList.toggle('discard-ready', !!S.discardMode);

    $('.hc-cost', node).textContent = (typeof (def && def.cost) === 'number') ? def.cost : '—';
    $('.hc-cost', node).classList.toggle('free', !(def && typeof def.cost === 'number' && def.cost > 0));
    $('.hc-tag', node).textContent = DECK_NAME[deck] + ' · ' + (CARD_TYPE_NAME[type] || '');

    $('.hc-name', node).textContent = def ? def.name : ('未知牌 ' + uid);
    var realmNode = $('.hc-realm', node);
    realmNode.classList.remove('over');
    if (type === 'companion') {
      // 同行者没有境界限制，只有占位限制（部分同行者占 2 格）
      var needSlots = companionSlotCost(def);
      if (def && def.absorb) {
        // 啼魂：替挡任意 1 次伤害后进弃牌堆（不按 2 点血计算）
        realmNode.textContent = '无境界限制 · 占 ' + needSlots + ' 位 · 【替挡 1 次】';
      } else {
        realmNode.textContent = '无境界限制 · 占 ' + needSlots + ' 位';
      }
      node.classList.toggle('slot-heavy', needSlots > 1);
      node.classList.toggle('absorb-card', !!(def && def.absorb));
    } else if (type === 'equip') {
      // 装备付费按卡文（2026-10-05）：带「装备时不消耗」→ 免费、效果才计费；没写 → 装备时付
      var tierShort = realmRequirement(def) + ' · ' + equipTierShort(def, st);
      if (isTieredEquip(def)) {
        // 多档法术：**自动适配当前境界**（用户裁定 2026-10-02），所以这里报"当前生效哪一档"，
        // 不再是"可选 N 档"。低档不再是选项，境界不够时引擎会自动回退。
        var bestT = maxTierFor(def, me ? me.realm : 0);
        var curT = def.tiers[bestT];
        tierShort = '多档法术 · 自动按境界生效' + (curT ? '「' + realmName(curT.realm) + '档」' : '');
        node.classList.add('has-tiers');
      }
      realmNode.textContent = tierShort;
      node.classList.add(equipCostOf(def) > 0 ? 'tier-high' : 'tier-low');
    } else {
      realmNode.textContent = realmRequirement(def);
      realmNode.classList.toggle('over', !!(def && me && me.realm < (def.realm || 0)));
      if (def && me && me.realm < (def.realm || 0)) {
        realmNode.textContent += '（越级：额外 ' + OVERREACH_MANA + ' 法力）';
      }
    }
    $('.hc-text', node).textContent = def ? (def.text || '') : '卡池数据缺失';

    var why = $('.hc-why', node);
    node.dataset.reason = playable ? '' : (chk.why || '');
    why.textContent = playable ? (typeof chk.cost === 'number' && chk.cost > 0 ? '消耗法力 ' + chk.cost : '') : (chk.why || '');
  }

  function renderHand(st) {
    var zone = $('#hand-zone');
    var me = myPlayer(st);
    var hand = (me && me.hand) ? me.hand : [];
    hideHandZoom();          // 手牌一变，放大镜里的那张可能已经不在了 → 先收起来

    if (!hand.length) {
      zone.innerHTML = '';
      var p = el('div', 'empty-hand', me && me.out ? '你已出局，本局观战。' : '手中无牌。');
      zone.appendChild(p);
    } else {
      var keys = hand.map(function (c) { return String(c.uid); });
      reconcile(zone, keys,
        function (uid) {
          var node = buildHandCard(uid);
          if (!S.seenHand[uid]) { node.classList.add('card-in'); setTimeout(function () { node.classList.remove('card-in'); }, 520); }
          S.seenHand[uid] = true;
          return node;
        },
        function (node, uid) { updateHandCard(node, uid, me, st); });
    }

    // 手牌区信息：按类型显示 宝物 x/6 · 法术 y/2 · 同行者 z/2（超出上限标红）
    var meta = $('#hand-meta');
    if (!me) { meta.textContent = ''; return; }
    var hc = me.handCounts || { treasure: 0, spell: 0, companion: 0 };
    // ⚠️ 优先用**玩家级**的上限（服务端已经把 hand_limit_bonus 算进去了，如【噬金虫】+1）；
    //    以前这里是 `rulesOf(st).handLimits || me.handLimits`，而 rulesOf 里是牌面基础值 6
    //    —— 于是带着【噬金虫】手里 7 张时会渲染成「宝物 7/6」标红 + 提示"回合结束时会被弃置"，
    //    可引擎其实一张都不弃（真上限 7），玩家看到的就是"超上限结束回合却无事发生"。
    var hl = me.handLimits || rulesOf(st).handLimits || RULES_FALLBACK.handLimits;
    var hlBonus = me.handLimitBonus || 0;
    function lim(label, n, cap, why) {
      var over = n > cap;
      var title = over ? '超出上限，回合结束时会被弃置' : (why || '');
      return '<span class="hc-lim' + (over ? ' over-limit' : '') + '"' +
        (title ? ' title="' + title + '"' : '') + '>' +
        label + ' ' + n + '/' + cap + '</span>';
    }
    meta.innerHTML = '<span class="hc-total">共 ' + me.handCount + ' 张</span>' +
      lim('宝物', hc.treasure || 0, hl.treasure,
        hlBonus ? '基础 6 张 + 常驻加成 ' + hlBonus + ' 张（如【噬金虫】）' : '') +
      lim('法术', hc.spell || 0, hl.spell) +
      lim('同行者', hc.companion || 0, hl.companion) +
      (me.out ? '<span class="hc-lim over-limit">已出局</span>' : '');
  }

  /* ================================================================
   * 11. 牌桌 · 操作区
   * ================================================================ */

  function mkBtn(label, cls, onClick, disabled, why) {
    var b = el('button', 'btn ' + (cls || ''), label);
    b.type = 'button';
    b.disabled = !!disabled;
    if (why) b.title = why;
    b.addEventListener('click', function () { if (!b.disabled) onClick(); });
    return b;
  }

  function noteBox(html) {
    var n = el('div', 'action-note');
    n.innerHTML = html;
    return n;
  }

  /** 闭关按钮：engine.js doSeclusion 允许在 draw_qi / draw_treasure / choose_draw 三个阶段宣布 */
  function seclusionBtn(me, busy) {
    return mkBtn('闭 关（一局一次）', 'btn-cyan', function () { send({ type: 'seclusion' }); },
      busy || !me.canSeclude,
      me.canSeclude
        ? '宣布闭关：抽 2 张灵气牌、恢复 1 点生命，并跳过本回合所有行动（闭关中不会被选为对战对象）'
        : '本局已经闭关过（一局仅限一次）');
  }

  /**
   * 回合结束的「手牌超上限」→ 同步到弃置模式；并保证弃置模式**不会一直粘着**。
   *
   * ⚠️ 这段**只决定"手动「弃置手牌」按钮还要不要开着"**，它本身**不是弃牌判定**。
   *    手牌超上限**只在回合结束时判定一次**：回合中途爱超多少超多少
   *    （上回合留 6 张满上限、这回合又抽 2 张 + 效果再抽几张，都随便，
   *     出牌/晋升/发起对战一概不受影响）—— 见 tests/hand-limit-test.js [J]。
   *    以前的坑：上一版写成"只在强制弃牌是我的时候设为 true，其它情况直接 return"，
   *    于是强制弃牌结束之后 discardMode 永远停在 true，之后不管谁的回合，点手牌都被当弃牌。
   */
  function syncDiscardMode(st) {
    var me = myPlayer(st);
    var forced = !!(st && st.forceDiscard && me && st.forceDiscard.playerId === me.id);
    if (forced) { S.discardMode = true; S.discardForced = true; return; }
    if (S.discardForced) { S.discardForced = false; S.discardMode = false; return; }
    // 只要轮不到我（别人的回合 / 我已出局）就把手动弃牌模式关掉；
    // 至于"阶段不对/对战中/有询问"，交给服务端的 doDiscard 拒（别在这里反复开关，玩家会莫名其妙丢状态）
    if (!me || me.out || !st || st.turn !== me.id) S.discardMode = false;
  }

  function renderActionBar(st) {
    var bar = $('#action-bar');
    bar.innerHTML = '';
    var me = myPlayer(st);
    if (!st || !me) return;

    if (me.out) {
      bar.appendChild(noteBox('<span class="warn">你已出局</span>，静观他人问道。'));
      return;
    }

    // —— 回合结束的「手牌超上限」：由当事人**自己挑**弃哪几张（用户裁定）
    //    引擎此时只接受 discard，所以这里不给任何别的按钮。
    var fd = st.forceDiscard;
    if (fd) {
      if (fd.playerId === me.id) {
        var hc = me.handCounts || { treasure: 0, spell: 0, companion: 0 };
        bar.appendChild(noteBox('<span class="warn">手牌超过上限：请自己挑 ' + fd.need +
          ' 张弃置</span> —— <b>直接点手牌</b>就是弃置，弃够才会结束回合。'));
        bar.appendChild(noteBox('当前 宝物 ' + (hc.treasure || 0) + '/' + fd.limits.treasure +
          ' · 法术 ' + (hc.spell || 0) + '/' + fd.limits.spell +
          ' · 同行者 ' + (hc.companion || 0) + '/' + fd.limits.companion +
          '　|　还需弃置 <b>' + fd.need + '</b> 张'));
      } else {
        bar.appendChild(noteBox('等待 <b>' + escapeHtml(fd.name || '?') +
          '</b> 弃置超出上限的手牌（还需 ' + fd.need + ' 张）……'));
      }
      return;
    }

    var c = st.combat;
    var busy = S.busy;

    // —— 对战准备阶段：由发起者掷骰
    if (c && c.stage === 'pre') {
      if (c.attacker === me.id) {
        bar.appendChild(mkBtn('掷 骰 · 定胜负', 'btn-gold', function () { send({ type: 'roll' }); }, busy));
      } else {
        bar.appendChild(noteBox('等待 <b>' + escapeHtml(playerName(st, c.attacker)) + '</b> 掷骰……' +
          (c.attacker === me.id || c.defender === me.id ? ' 你也可打出对战类卡牌。' : '')));
      }
      return;
    }

    // —— 平局结算阶段
    if (c && c.stage === 'tie') {
      var mine = (c.attacker === me.id || c.defender === me.id);
      if (!mine) {
        bar.appendChild(noteBox('平局结算中，等待双方处理……'));
        return;
      }
      var done = c.tieUsed[me.id] || c.tiePassed[me.id];
      if (done) {
        bar.appendChild(noteBox('你已处理平局，等待对手……'));
        return;
      }
      bar.appendChild(mkBtn('过 牌 · 不加战力', 'btn-cyan', function () { send({ type: 'tie' }); }, busy));
      bar.appendChild(noteBox('或从下方白框手牌中打出一张「改变战力」的牌。'));
      return;
    }

    // —— 结果窗口：战果已定，赢家/输家各有一张「获胜时 / 失败时」的牌可打
    if (c && c.stage === 'result') {
      var rSide = me.id === c.winnerId ? 'win' : (me.id === c.loserId ? 'lose' : null);
      if (!rSide || c.resultStep !== rSide) {
        bar.appendChild(noteBox('战果已定 · 等待' +
          (c.resultStep === 'win' ? '获胜方' : '失败方') + '结算……'));
        return;
      }
      if (c.resultUsed && c.resultUsed[rSide]) {
        bar.appendChild(noteBox('你已处理完毕，等待结算……'));
        return;
      }
      bar.appendChild(noteBox(rSide === 'win'
        ? '你赢了！可从下方手牌打出一张「对战获胜时」的牌，或跳过。'
        : '你输了，可从下方手牌打出一张「对战失败时」的牌（免罚/反伤等），或跳过。'));
      bar.appendChild(mkBtn(rSide === 'win' ? '跳 过 · 不结算获胜效果' : '接 受 战 败 · 不打出反制牌',
        'btn-cyan', function () { send({ type: 'result_pass' }); }, busy));
      return;
    }

    // —— 阶段一：手动炼化灵气牌（engine.js doDrawQi）
    if (st.turn === me.id && st.step === 'draw_qi') {
      bar.appendChild(mkBtn('炼化灵气牌', 'btn-cyan', function () { send({ type: 'draw_qi' }); }, busy,
        '从灵气牌堆抽 1 张并立即结算：灵气值 +1；充裕灵气会再抽 1 张、天地灵气会再抽 2 张'));
      bar.appendChild(seclusionBtn(me, busy));
      bar.appendChild(noteBox('<b>回合开始</b>：点【炼化灵气牌】从灵气牌堆抽 1 张并立即结算（灵气值 +1；充裕/天地灵气会连锁额外抽取）。'));
      return;
    }

    // —— 阶段二：探索阶段手动抽 2 张宝物牌（engine.js doDrawTreasure）
    if (st.turn === me.id && st.step === 'draw_treasure') {
      bar.appendChild(mkBtn('探索 · 取两张宝物牌', 'btn-gold', function () { send({ type: 'draw_treasure' }); }, busy,
        '从宝物牌堆抽 2 张宝物牌加入手牌；场上有【御风诀】【掌天瓶】【青易居士】时会在【斗法】窗口里问你要不要发动'));
      bar.appendChild(seclusionBtn(me, busy));
      appendActivateBtns(bar, me, busy);   // 探索阶段的主动技能（历史遗留，目前池里已无此类）
      bar.appendChild(noteBox('<b>探索阶段</b>：点【探索 · 取两张宝物牌】从宝物牌堆抽 2 张加入手牌，之后才进入二选一抽牌。'));
      return;
    }

    // —— 阶段三：二选一抽法术 / 同行者（engine.js doChooseDraw）
    if (st.turn === me.id && st.step === 'choose_draw') {
      bar.appendChild(mkBtn('抽 法术牌', 'btn-cyan', function () { send({ type: 'choose_draw', deck: 'spell' }); }, busy,
        '从法术牌堆抽 1 张加入手牌'));
      bar.appendChild(mkBtn('抽 同行者', 'btn-gold', function () { send({ type: 'choose_draw', deck: 'companion' }); }, busy,
        '从同行者牌堆抽 1 张加入手牌'));
      bar.appendChild(seclusionBtn(me, busy));
      bar.appendChild(noteBox('<b>抉择阶段</b>：法术 / 同行者<b>二选一</b>抽 1 张，之后进入行动阶段。'));
      return;
    }

    // —— 阶段四：行动阶段（自己的回合）
    if (st.turn === me.id && st.step === 'action') {
      // 晋升三条件：nextThreshold（需达到的灵气值）+ nextConsume（需消耗）+ nextDice（掷骰下限，0=不需掷骰）
      var canPromote = !st.turnFlags.promote && me.realm < 4 && me.qi >= (me.nextThreshold || 0);
      var promoteWhy = st.turnFlags.promote ? '本回合已晋升过（每回合最多 1 次）'
        : (me.realm >= 4 ? '你已结成元婴'
          : (me.qi < (me.nextThreshold || 0)
            ? '灵气值不足（需 ≥' + me.nextThreshold + '，当前 ' + me.qi + '）'
            : promoteConditionText(me)));
      var promoteLabel = me.realm >= 4 ? '已至元婴' :
        ('晋升 · ' + realmName(me.realm + 1) + '（' + promoteConditionText(me) + '）');
      bar.appendChild(mkBtn(promoteLabel, 'btn-gold', function () { send({ type: 'promote' }); }, busy || !canPromote, promoteWhy));

      // 规则：每个人的第一个回合不能发起对战（各自先铺一回合场）
      var firstTurn = me.turnsTaken !== undefined ? (me.turnsTaken <= 1) : false;
      var canCombat = !st.turnFlags.combat && !me.inSeclusion && !firstTurn;
      var combatWhy = me.inSeclusion ? '闭关中不可发起对战'
        : (st.turnFlags.combat ? '本回合已发起过对战（每回合仅 1 场）'
          : (firstTurn ? '这是你的第一个回合，还不能发起对战（各人先铺一回合场，第 2 个回合起可发起）'
            : '选择目标发起对战（不可向低两个境界者发起）'));
      bar.appendChild(mkBtn('发起对战', 'btn-danger', function () { startTargeting('combat'); }, busy || !canCombat, combatWhy));

      bar.appendChild(mkBtn('结束回合', 'btn', function () { S.discardMode = false; send({ type: 'end_turn' }); }, busy));

      // 主动技能：场面上的牌自带的能力（【梅凝】回血抽牌后离场、【青易居士】弃宝物改抽法术）
      appendActivateBtns(bar, me, busy);

      bar.appendChild(noteBox('每回合恢复 <b>' + rulesOf(st).manaRegen + '</b> 点法力值（当前法力上限 ' +
        manaCapOf(st, me) + '）；' + (rulesOf(st).equipRule || EQUIP_RULE_TEXT)));
      return;
    }

    // —— 不是自己的回合
    if (st.phase === 'playing') {
      bar.appendChild(noteBox('等待 <b>' + escapeHtml(playerName(st, st.turn)) + '</b> 行动……（当前阶段：<b>' + stepLabel(st.step) + '</b>' +
        (st.turnFlags.combat ? '，其本回合已对战过' : '') + '）'));
    } else {
      bar.appendChild(noteBox('对局尚未开始。'));
    }
  }

  /* ---------------- 目标选择 ---------------- */

  function startTargeting(mode) {
    S.targeting = { mode: mode, uid: mode === 'card' ? undefined : null };
    S.discardMode = false;
    updateTargetHint();
    renderPlayers(S.state);
    renderHand(S.state);
  }

  function startCardTargeting(uid) {
    S.targeting = { mode: 'card', uid: numUid(uid) };
    updateTargetHint();
    renderPlayers(S.state);
    renderHand(S.state);
  }

  function cancelTargeting() {
    S.targeting = null;
    updateTargetHint();
    if (S.state) { renderPlayers(S.state); renderHand(S.state); }
  }

  function updateTargetHint() {
    var box = $('#target-hint');
    var txt = $('#target-hint-text');
    if (!S.targeting) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    txt.textContent = S.targeting.mode === 'combat'
      ? '选择对战目标（点击其面板；不可选者已置灰并标注原因）'
      : '选择「' + cardName(cardIdOfUid(S.targeting.uid)) + '」的目标（点击其面板）';
  }

  function cardIdOfUid(uid) {
    var me = myPlayer(S.state);
    if (!me || !me.hand) return '';
    for (var i = 0; i < me.hand.length; i++) if (String(me.hand[i].uid) === String(uid)) return me.hand[i].id;
    return '';
  }

  function applyTargetingHighlight(st) {
    if (!S.targeting) return;
    var info = targetInfo(st, S.targeting.mode);
    eachBoard(function (card) {
      var pid = card.dataset.pid;
      var good = !!info.ok[pid];
      card.classList.toggle('targetable', good);
      card.classList.toggle('not-targetable', !good);
      if (good) card.removeAttribute('data-twhy');
      else card.setAttribute('data-twhy', info.why[pid] || '不可选择');
    });
  }

  function onPlayerCardClick(pid) {
    if (!S.targeting) return;
    var st = S.state;
    if (!st || (!st.turn && !st.combat)) return;
    var info = targetInfo(st, S.targeting.mode);
    if (!info.ok[pid]) {
      toast('不可选择该目标：' + (info.why[pid] || '无效目标'), 'err');
      return;
    }
    if (S.targeting.mode === 'combat') {
      S.targeting = null; updateTargetHint();
      send({ type: 'combat', target: pid });
    } else if (S.targeting.mode === 'card') {
      var uid = numUid(S.targeting.uid);
      S.targeting = null; updateTargetHint();
      send({ type: 'play', uid: uid, target: pid });
    }
  }

  /* ---------------- 手牌点击 ---------------- */

  /**
   * 手牌 uid 归一化：DOM 的 dataset 取出来恒为字符串，而引擎的手牌实例是
   * `{uid: 数字, id}`，服务端用 `x.uid === a.uid` 严格比较 ——
   * 因此发给 /api/action 的 uid 必须还原成数字，否则会一律报「你手里没有这张牌」。
   */
  function numUid(uid) {
    if (typeof uid === 'number') return uid;
    var s = String(uid);
    return /^\d+$/.test(s) ? Number(s) : uid;
  }

  function onHandCardClick(uid, st) {
    var me = myPlayer(st);
    if (!me || me.out) return;
    uid = numUid(uid);

    // 回合结束的「强制弃牌」期间：点手牌 = 弃置（**只有**这个状态会进弃牌模式；
    // 平时没有"主动弃置手牌"这个动作了 —— 用户裁定，弃牌只有卡片效果与回合结束判定两个来源）
    if (S.discardMode && st.forceDiscard && st.forceDiscard.playerId === me.id) {
      send({ type: 'discard', uid: uid });
      return;
    }

    var inst = null;
    if (me.hand) for (var i = 0; i < me.hand.length; i++) if (me.hand[i].uid === uid) inst = me.hand[i];
    if (!inst) return;
    var def = cardDef(inst.id);
    var chk = checkPlay(def, me, st);

    // 平局阶段：用手牌改变战力（走 tie 动作）
    if (st.combat && st.combat.stage === 'tie') {
      var mine = st.combat.attacker === me.id || st.combat.defender === me.id;
      if (!mine) { toast('你不在本次对战中', 'err'); return; }
      if (st.combat.tieUsed[me.id] || st.combat.tiePassed[me.id]) { toast('你已经处理过平局了', 'err'); return; }
      var tieOK = false;
      var tEffs = playNowEffects(def);
      for (var te = 0; te < tEffs.length; te++) if (hasTiming(tEffs[te], 'tie')) tieOK = true;
      if (!tieOK) { toast('平局时只能打出改变战力结果的卡牌', 'err'); return; }
      send({ type: 'tie', uid: uid });
      return;
    }

    // 结果窗口：战果已定，赢家可打「获胜时」的牌、输家可打「失败时」的牌（各限一张）
    if (st.combat && st.combat.stage === 'result') {
      var sideR = me.id === st.combat.winnerId ? 'win' : (me.id === st.combat.loserId ? 'lose' : null);
      if (!sideR) { toast('你不是本次对战的参与者', 'err'); return; }
      if (st.combat.resultStep !== sideR) { toast('现在不是你的结算时机', 'err'); return; }
      // 档位由引擎按当前境界自动定（用户裁定），前端不再显式传 tier
      send({ type: 'play', uid: uid });
      return;
    }

    if (!chk.ok) { toast(chk.why || '现在不能打出这张牌', 'err'); return; }
    if (chk.target) { startCardTargeting(uid); return; }
    // 多档位法术：**不再弹选档窗** —— 用户裁定（2026-10-02）：一律自动适配当前境界（取最高可用档）。
    // 档位由引擎按当前境界算，前端只提示一声生效的是哪一档。
    if (isTieredEquip(def)) {
      var autoT = maxTierFor(def, me.realm);
      var autoDef = def.tiers[autoT];
      if (autoDef) toast('【' + def.name + '】自动生效「' + realmName(autoDef.realm) + '档」效果', 'ok');
      send({ type: 'play', uid: uid });
      return;
    }
    send({ type: 'play', uid: uid });
  }

  /** 带 tiers 的装备类法术（法宝没有 tiers，行为不变） */
  function isTieredEquip(def) {
    return !!(def && def.type === 'equip' && def.tiers && def.tiers.length);
  }

  /* 注：选档弹窗已删除（用户裁定 2026-10-02：多档位牌一律自动适配当前境界）。
     引擎侧 engine.js 的 maxTierFor / resolveTier 负责定档；
     "二选一"那类**同境界多选**不在这里选 —— 它由服务端展开成多条响应候选，见 pending 列表。 */

  /* ================================================================
   * 12. 牌桌 · 牌堆 & 战报
   * ================================================================ */

  function buildDeckRows() {
    var list = $('#deck-list');
    list.innerHTML = '';
    DECK_LIST.forEach(function (deck) {
      var row = el('div', 'deck-row deck-' + deck);
      row.dataset.deck = deck;
      row.innerHTML =
        '<span class="dk-name"></span>' +
        '<span class="dk-bar"><span></span></span>' +
        '<span class="dk-num">0</span>' +
        '<span class="dk-discard">弃 0</span>';
      $('.dk-name', row).textContent = DECK_NAME[deck] + '牌堆';
      if (deck === 'qi') {
        // engine.js: 灵气牌堆抽完不做弃牌洗混，而是直接再补一整组（60 张）
        var note = el('span', 'dk-note', '抽完自动补一组');
        note.title = '灵气牌堆抽尽时会重新加入一整组灵气牌（60 张）继续抽取，战报会提示「灵气牌堆抽完」';
        row.appendChild(note);
      }
      list.appendChild(row);
    });
  }

  function renderDecks(st) {
    if (!st || !st.decks) return;
    DECK_LIST.forEach(function (deck) {
      var row = $('#deck-list .deck-row[data-deck="' + deck + '"]');
      if (!row) return;
      var d = st.decks[deck] || { draw: 0, discard: 0 };
      // 灵气牌堆会被反复补组，分母固定取一整组（60）的牌量，超过时进度条按满格显示
      var max = CARDS.max[deck] || Math.max(1, d.draw + d.discard);
      var num = $('.dk-num', row);
      var prev = parseInt(num.dataset.v || '-1', 10);
      num.dataset.v = String(d.draw);
      num.textContent = d.draw;
      if (prev >= 0 && prev !== d.draw) replayAnim(num, 'bump');
      // 补组时数字是从小跳到大，用 refill 强调一下
      if (deck === 'qi' && prev >= 0 && d.draw - prev > 5) replayAnim(row, 'refill');
      $('.dk-bar span', row).style.width = Math.max(0, Math.min(100, (d.draw / max) * 100)) + '%';
      $('.dk-discard', row).textContent = '弃 ' + d.discard;
      row.title = DECK_NAME[deck] + '：抽牌堆 ' + d.draw + ' 张，弃牌堆 ' + d.discard + ' 张' +
        (deck === 'qi' ? '（抽尽自动补一整组 60 张）' : '');
    });

    var totalDraw = 0;
    DECK_LIST.forEach(function (deck) { totalDraw += (st.decks[deck] ? st.decks[deck].draw : 0); });
    var chip = $('#tb-piles');
    if (chip) chip.textContent = '牌堆合计 ' + totalDraw;
  }

  /** 战报差分：返回本轮新增条目（兼容 log 滑动窗口与 seq 重复） */
  function diffLog(prev, next) {
    if (!prev || !prev.length) return { fresh: true, add: next.slice() };
    if (!next || !next.length) return { fresh: true, add: [] };
    var maxL = Math.min(prev.length, next.length);
    for (var L = maxL; L >= 1; L--) {
      var same = true;
      for (var i = 0; i < L; i++) {
        var a = prev[prev.length - L + i], b = next[i];
        if (a.seq !== b.seq || a.kind !== b.kind || a.text !== b.text) { same = false; break; }
      }
      if (same) return { fresh: false, add: next.slice(L) };
    }
    return { fresh: true, add: next.slice() };
  }

  function logItem(entry) {
    var meta = LOG_KIND[entry.kind] || { mark: '·' };
    var node = el('div', 'log-item log-' + entry.kind);
    node.appendChild(el('span', 'li-mark', meta.mark));
    node.appendChild(el('span', 'li-text', entry.text));
    return node;
  }

  function appendLog(entries, fresh) {
    var list = $('#log-list');
    if (fresh) {
      list.innerHTML = '';
      $('#log-count').textContent = '';
    }
    if (!entries || !entries.length) {
      var c0 = S.state && S.state.log ? S.state.log.length : 0;
      $('#log-count').textContent = c0 ? ('共 ' + c0 + ' 条') : '';
      return;
    }
    // 记录用户是否停留在底部
    var atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    entries.forEach(function (e) { list.appendChild(logItem(e)); });
    while (list.children.length > 200) list.removeChild(list.firstChild);
    if (atBottom || fresh) list.scrollTop = list.scrollHeight;
    var c = S.state && S.state.log ? S.state.log.length : list.children.length;
    $('#log-count').textContent = '共 ' + c + ' 条';
  }

  /* ================================================================
   * 13. 对战面板（含骰子与逐项结算动画）
   * ================================================================ */

  var Combat = {
    pair: null,            // {a:pid, b:pid} 最近一次对战的双方
    snap: null,            // combat 快照（combat 变 null 后仍可渲染）
    queue: [],             // 待播动画步骤
    running: false,
    lingerUntil: 0,
    dice: { a: null, b: null },   // 动画中显示的骰面
    rollingSide: null,            // 当前正在滚动的一侧（attacker/defender）
    raw: {},                      // pid -> 原始骰点（来自 combat roll 日志 payload）
    totals: { a: null, b: null },
    winner: null,
    loser: null,
    resultHtml: '',
    resultShown: false,
    refs: null
  };

  /** 原始骰点：优先本次动画拿到的值，其次实时 combat/ 快照的 dice[id] */
  function rawPipOf(pid) {
    if (Combat.raw && Combat.raw[pid] !== undefined) return Combat.raw[pid];
    var c = S.state && S.state.combat;
    if (c && c.dice && c.dice[pid] !== undefined) return c.dice[pid];
    if (Combat.snap && Combat.snap.dice && Combat.snap.dice[pid] !== undefined) return Combat.snap.dice[pid];
    return null;
  }

  function initCombatArena() {
    var A = $('#combat-side-a'), B = $('#combat-side-b');
    A.innerHTML =
      '<span class="cs-role"></span><span class="cs-name"></span><span class="cs-realm"></span>' +
      '<span class="cs-base">基础战力 <b>1</b></span><span class="cs-flag"></span>' +
      '<div class="dice" id="combat-dice-a">?</div>';
    B.innerHTML =
      '<span class="cs-role"></span><span class="cs-name"></span><span class="cs-realm"></span>' +
      '<span class="cs-base">基础战力 <b>1</b></span><span class="cs-flag"></span>' +
      '<div class="dice" id="combat-dice-b">?</div>';
    Combat.refs = {
      a: { root: A, role: $('.cs-role', A), name: $('.cs-name', A), realm: $('.cs-realm', A), base: $('.cs-base b', A), flag: $('.cs-flag', A), dice: $('#combat-dice-a') },
      b: { root: B, role: $('.cs-role', B), name: $('.cs-name', B), realm: $('.cs-realm', B), base: $('.cs-base b', B), flag: $('.cs-flag', B), dice: $('#combat-dice-b') }
    };
  }

  function snapshotCombat(c) {
    if (!c) return;
    Combat.pair = { a: c.attacker, b: c.defender };
    Combat.snap = {
      attacker: c.attacker, defender: c.defender, stage: c.stage,
      dice: c.dice || {}, total: c.total || {}, bonus: c.bonus || {}, debuff: c.debuff || {},
      tieUsed: c.tieUsed || {}, tiePassed: c.tiePassed || {}, cancelled: !!c.cancelled
    };
  }

  /** 当前要渲染的对战视图：优先实时 combat，其次快照 */
  function combatView() {
    var c = S.state && S.state.combat;
    if (c) { snapshotCombat(c); }
    var src = c ? {
      attacker: c.attacker, defender: c.defender, stage: c.stage,
      dice: c.dice || {}, total: c.total || {}, bonus: c.bonus || {}, debuff: c.debuff || {},
      tieUsed: c.tieUsed || {}, tiePassed: c.tiePassed || {}, cancelled: !!c.cancelled
    } : Combat.snap;
    if (!src) return null;
    return src;
  }

  function combatSync(st, newEntries, skipAnim) {
    // 首帧（重新进入房间/中途重连）只做快照渲染，不重放历史对战动画
    if (skipAnim) {
      if (st.combat) snapshotCombat(st.combat);
      combatRender();
      return;
    }
    var steps = [];
    var batchHasSteal = newEntries.some(function (e) { return e.kind === 'steal'; });
    // 新的一场对战开始时，清掉上一场的结算残留
    var freshCombat = newEntries.some(function (e) { return e.kind === 'combat_start'; });
    if (freshCombat) {
      Combat.winner = null;
      Combat.loser = null;
      Combat.totals = { a: null, b: null };
      Combat.dice = { a: null, b: null };
      Combat.raw = {};
      Combat.lingerUntil = 0;
      $('#combat-steps').innerHTML = '';
      var r = Combat.refs;
      if (r) {
        [r.a.dice, r.b.dice].forEach(function (d) { d.classList.remove('settled', 'rolling'); d.textContent = '?'; });
      }
    }
    newEntries.forEach(function (e) {
      if (e.kind === 'roll' && e.payload && e.payload.scope === 'combat') steps.push({ t: 'dice', p: e.payload });
      // combat_total 的 text 是引擎写好的算式，直接展示
      else if (e.kind === 'combat_total' && e.payload) steps.push({ t: 'total', p: e.payload, text: e.text, steal: batchHasSteal });
      else if (e.kind === 'combat_result' && e.payload) steps.push({ t: 'result', p: e.payload, text: e.text, steal: batchHasSteal });
      else if (e.kind === 'tie') steps.push({ t: 'tie', text: e.text });
    });
    if (steps.length) {
      Combat.queue = Combat.queue.concat(steps);
      if (!Combat.running) { void runCombatQueue(); }
    }
    combatRender();
  }

  /** 「掷骰无意义」的两种情况 —— 有的话别让玩家白点一次按钮（用户实盘反馈：
   *  【金光砖符】"跳过投掷骰子加战力"，界面却还要点"投掷骰子"，很反直觉）。 */
  function noDiceReason(c, pl) {
    if (!c || !pl) return null;
    if (c.flatPower && typeof c.flatPower[pl.id] === 'number') {
      return '本场【战力值】已固定为 ' + c.flatPower[pl.id] + ' 点（不可被增减），骰点不计入';
    }
    if (c.skipDice && c.skipDice[pl.id]) return '本场已放弃投掷骰子，骰点不计入战力';
    return null;
  }

  /** 掷骰按钮：正常就是"掷骰"；骰点无意义时换成"继续（无需掷骰）"，并在 2.5 秒后自动继续。
   *  自动继续是安全的：点它只是进入「投骰 · 前」询问窗口（有牌要响应照样会问），
   *  不会替玩家跳过任何决策；同一局面只排一次。 */
  function appendRollOrContinue(actions, c, pl) {
    var why = noDiceReason(c, pl);
    var go = function () { send({ type: 'roll' }); };
    var first = c.stage === 'pre';
    if (!why) {
      actions.appendChild(mkBtn(first ? '掷 骰（先攻）' : '掷 骰（应战）', 'btn-gold', go, S.busy || Combat.running,
        first ? '先攻：由发起方先掷骰，之后轮到应战方' : '应战方掷骰：投完立即结算；你也可以先打出对战类卡牌再掷'));
      return;
    }
    actions.appendChild(noteBox(why + ' —— <b>无需掷骰</b>。'));
    actions.appendChild(mkBtn('继 续（无需掷骰）', 'btn-gold', go, S.busy || Combat.running, why));
    var key = (S.state.round || '') + '|' + c.stage + '|' + (pl && pl.id) + '|' + (c.attacker || '') + '|' + (c.defender || '');
    if (S.autoRollKey === key) return;
    S.autoRollKey = key;
    setTimeout(function () {
      var now = S.state && S.state.combat;
      if (!now || S.busy) return;
      var mine = (now.stage === 'pre' && now.attacker === pl.id) || (now.stage === 'roll_defender' && now.defender === pl.id);
      if (!mine) return;
      toast('骰点不计入战力 —— 自动继续', 'ok');
      send({ type: 'roll' });
    }, 2500);
  }

  function combatRender() {
    var st = S.state;
    if (!st) return;
    var mode = 'hidden';
    var v = combatView();
    if (Combat.running) mode = 'anim';
    else if (st.combat && st.combat.stage === 'pre') mode = 'pre';
    else if (st.combat && st.combat.stage === 'roll_defender') mode = 'roll_defender';
    else if (st.combat && st.combat.stage === 'tie') mode = 'tie';
    else if (st.combat && st.combat.stage === 'result') mode = 'result';
    else if (Combat.lingerUntil > Date.now()) mode = 'anim';
    Combat.mode = mode;

    var ov = $('#combat-overlay');
    ov.classList.toggle('hidden', mode === 'hidden');
    if (mode === 'hidden') return;

    var me = myPlayer(st);
    var refs = Combat.refs;
    if (!v) return;

    var isPre = mode === 'pre' && st.combat;
    var isRD = mode === 'roll_defender' && st.combat;
    var isResult = mode === 'result' && st.combat;
    $('#combat-title').textContent = isPre ? '对 战 · 战 前'
      : (isRD ? '对 战 · 待应战方掷骰'
        : (mode === 'tie' ? '平 局 结 算'
          : (isResult ? '对 战 · 结 算 时 机' : '对 战 · 结 算')));
    $('#combat-sub').textContent = isPre
      ? '双方均可打出「对战中使用」的牌；由发起者先掷骰，骰点查表转为额外战力值。'
      : (isRD
        ? '先攻已投出——现在由应战方掷骰；应战方看到对方点数后仍可打出对战类卡牌。'
        : (mode === 'tie' ? '最终战力持平：双方各可使用一张改变战力结果的牌。'
          : (isResult
            ? (st.combat.resultStep === 'win'
              ? '战果已定：获胜方可打出一张「对战获胜时」使用的牌，或跳过。'
              : '战果已定：失败方可打出一张「对战失败时」使用的牌（如免罚/反伤），或跳过。')
            : '')));
    // ③ 当前时点 + 谁在表态（用户 P4：战斗面板要看得出"现在处于哪个时点、谁持有优先权"）
    if (st.pending && st.combat) {
      $('#combat-sub').textContent = '【斗法】' + (st.pending.label || '') + ' · ' +
        (st.pending.amActor ? '轮到你表态（在弹窗里破招或跳过；双方都不发动才进入下一步）'
          : '等待 ' + (st.pending.actorName || '?') + ' 表态') + '　|　' + $('#combat-sub').textContent;
    }
    // 骰点 → 额外战力值 的换算表（来自 publicState().rules.diceTable）
    var ruleNode = $('#combat-dice-rule');
    if (ruleNode) ruleNode.textContent = '骰点转化表：' + rulesOf(st).diceTable;

    fillCombatSide(refs.a, v.attacker, v, 'attacker', me, mode);
    fillCombatSide(refs.b, v.defender, v, 'defender', me, mode);

    // 骰面：优先用 state 里已确定的点数（先攻投完的那一侧要一直亮着），
    // 该侧正在滚动时用动画中的临时值；还没投的一侧在 roll_defender 阶段显示「待掷」。
    var aKnown = v.dice[v.attacker] !== undefined && v.dice[v.attacker] !== null;
    var dKnown = v.dice[v.defender] !== undefined && v.dice[v.defender] !== null;
    var aVal = aKnown ? v.dice[v.attacker] : (Combat.running ? Combat.dice.a : null);
    var dVal = dKnown ? v.dice[v.defender] : (Combat.running ? Combat.dice.b : null);
    if (Combat.running && Combat.rollingSide === 'attacker') aVal = Combat.dice.a;
    if (Combat.running && Combat.rollingSide === 'defender') dVal = Combat.dice.b;
    setDice(refs.a.dice, aVal);
    setDice(refs.b.dice, dVal, isRD && !dKnown);

    // 大字比分「14 : 9」（vs 区中央）：动画中由 stepTotal 在算式揭示后点亮（Combat.totals，
    // 不提前剧透）；非动画（结果/平局阶段、刷新重进）直接读 state 里的总战力。
    (function () {
      var node = $('#combat-score');
      if (!node) return;
      var ta = null, td = null;
      if (Combat.running) {
        ta = Combat.totals ? Combat.totals.a : null;
        td = Combat.totals ? Combat.totals.b : null;
      } else {
        ta = (typeof v.total[v.attacker] === 'number') ? v.total[v.attacker] : null;
        td = (typeof v.total[v.defender] === 'number') ? v.total[v.defender] : null;
      }
      if (typeof ta !== 'number' || typeof td !== 'number') {
        node.classList.add('hidden');
        node.innerHTML = '';
        return;
      }
      node.innerHTML = '';
      node.appendChild(el('span', 'cs-num' + (ta >= td ? ' cs-win' : ''), String(ta)));
      node.appendChild(el('span', 'cs-sep', ':'));
      node.appendChild(el('span', 'cs-num' + (td >= ta ? ' cs-win' : ''), String(td)));
      node.classList.remove('hidden');
    })();

    // 结算步骤区：战前/待掷阶段保持空白，结算阶段由动画逐步填充
    if (mode === 'pre' || mode === 'roll_defender') $('#combat-steps').innerHTML = '';

    // 操作区
    var actions = $('#combat-actions');
    actions.innerHTML = '';

    if (isPre) {
      var cp = st.combat;
      if (cp.attacker === (me && me.id)) {
        appendRollOrContinue(actions, cp, me);
      } else {
        actions.appendChild(noteBox('等待 <b>' + escapeHtml(playerName(st, cp.attacker)) + '</b> 掷骰（先攻）……（60 秒后自动掷骰）'));
      }
    } else if (isRD) {
      var cr = st.combat;
      if (cr.defender === (me && me.id)) {
        appendRollOrContinue(actions, cr, me);
        if (!noDiceReason(cr, me)) {
          actions.appendChild(noteBox('先攻 <b>' + escapeHtml(playerName(st, cr.attacker)) + '</b> 已投出 <b>' +
            (cr.dice[cr.attacker] !== undefined ? cr.dice[cr.attacker] : '?') + '</b> 点——轮到你掷骰。'));
        }
      } else {
        actions.appendChild(noteBox('先攻已投出 <b>' + (cr.dice[cr.attacker] !== undefined ? cr.dice[cr.attacker] : '?') +
          '</b> 点，等待应战方 <b>' + escapeHtml(playerName(st, cr.defender)) + '</b> 掷骰……'));
      }
    } else if (mode === 'tie' && st.combat) {
      renderTieActions(actions, st, st.combat, me);
    } else if (mode === 'result' && st.combat) {
      renderResultActions(actions, st, st.combat, me);
    }

    renderCombatHand(st, me, mode);
  }

  function fillCombatSide(ref, pid, v, role, me, mode) {
    if (!pid) { ref.root.classList.add('hidden'); return; }
    ref.root.classList.remove('hidden');
    var p = playerById(S.state, pid);
    ref.role.textContent = role === 'attacker' ? '发起者' : '应战者';
    ref.name.textContent = (p ? p.name : '未知') + (me && me.id === pid ? '（你）' : '');
    ref.realm.textContent = (p ? (p.realmName || realmName(p.realm)) : '') + (p ? ' · 手牌 ' + p.handCount : '');
    ref.base.textContent = p ? p.baseCombat : 1;
    ref.root.classList.toggle('is-me', !!(me && me.id === pid));

    var flags = [];
    var ex = (v.bonus[pid] || 0) - (v.debuff[pid] || 0);
    if (ex) flags.push((ex > 0 ? '战力 +' : '战力 ') + ex);
    // 骰点查表换算，而不是直接相加
    var pip = rawPipOf(pid);
    if (pip !== null && pip !== undefined) flags.push('骰 ' + pip + ' 点 → 附加 +' + diceToBonus(pip));
    if (v.tieUsed && v.tieUsed[pid]) flags.push('已用改变牌');
    if (v.tiePassed && v.tiePassed[pid]) flags.push('已过牌');
    ref.flag.textContent = flags.join(' · ');

    var win = Combat.winner === pid && (mode === 'anim' || mode === 'hidden');
    var lose = Combat.loser === pid && (mode === 'anim' || mode === 'hidden');
    ref.root.classList.toggle('is-winner', !!win);
    ref.root.classList.toggle('is-loser', !!lose);
  }

  function setDice(node, value, pending) {
    if (!node) return;
    if (pending) {
      node.classList.remove('settled', 'rolling');
      node.classList.add('pending');
      if (node.textContent !== '待掷') node.textContent = '待掷';
      return;
    }
    node.classList.remove('pending');
    if (value === null || value === undefined) {
      if (node.textContent !== '?') node.textContent = '?';
      node.classList.remove('settled');
      if (!Combat.running) node.classList.remove('rolling');
      return;
    }
    if (node.textContent !== String(value)) node.textContent = String(value);
  }

  /* ---------------- 动画队列 ---------------- */

  function runCombatQueue() {
    Combat.running = true;
    Combat.holdExpired = false;        // 新一轮动画：恢复「斗法弹窗押后」（见 renderPending）
    combatRender();
    var chain = Promise.resolve();
    Combat.queue.forEach(function (step) {
      chain = chain.then(function () {
        if (step.t === 'dice') return stepDice(step.p);
        if (step.t === 'total') return stepTotal(step.p, step.text);
        if (step.t === 'result') return stepResult(step);
        if (step.t === 'tie') return stepTie(step);
        return null;
      });
    });
    return chain.then(function () {
      Combat.queue = [];
      Combat.running = false;
      Combat.rollingSide = null;
      Combat.lingerUntil = Date.now() + 2600;
      Combat.dice = { a: null, b: null };
      combatRender();
      // 结算动画播完了 —— 把押后的斗法弹窗放出来（用户实盘报：弹窗盖住没播完的结算 = 盲用）
      renderPending(S.state);
      setTimeout(function () { combatRender(); }, 2700);
    }).catch(function () {
      Combat.running = false;
      Combat.queue = [];
      combatRender();
      renderPending(S.state);
    });
  }

  /**
   * 掷骰动画：v4 是两段式，一条 roll 日志只含一方。
   * payload = {scope:'combat', side:'attacker'|'defender', player, value}
   * 兼容旧版一次给双边 {a:{id,value}, d:{id,value}} 的形状。
   */
  function stepDice(p) {
    var turns = [];
    if (p.side) {
      turns.push({ side: p.side, pid: p.player, value: p.value });
    }
    if (p.a) turns.push({ side: 'attacker', pid: p.a.id, value: p.a.value });
    if (p.d) turns.push({ side: 'defender', pid: p.d.id, value: p.d.value });
    Combat.dice = { a: null, b: null };
    var chain = Promise.resolve();
    turns.forEach(function (t) {
      chain = chain.then(function () { return rollOneSide(t); });
    });
    return chain;
  }

  /** 只滚当前这一方的骰子（另一方的骰面保持不动：先攻点数要一直亮着给应战方看） */
  function rollOneSide(t) {
    var refs = Combat.refs;
    var node = refs ? (t.side === 'defender' ? refs.b.dice : refs.a.dice) : null;
    Combat.rollingSide = t.side;
    if (t.side === 'defender') Combat.dice.b = 0; else Combat.dice.a = 0;
    if (node) {
      node.classList.remove('settled', 'pending');
      replayAnim(node, 'rolling');
    }
    var timer = setInterval(function () {
      if (node) node.textContent = String(1 + Math.floor(Math.random() * 6));
    }, 70);

    return sleep(880).then(function () {
      clearInterval(timer);
      if (t.side === 'defender') Combat.dice.b = t.value; else Combat.dice.a = t.value;
      // 记录原始骰点，供后面的查表结算使用
      if (t.pid) Combat.raw[t.pid] = t.value;
      if (node) {
        node.classList.remove('rolling');
        node.textContent = String(t.value);
        replayAnim(node, 'settled');
      }
      return sleep(560);
    });
  }

  function stepTotal(p, engineText) {
    var box = $('#combat-steps');
    box.innerHTML = '';
    var groups = [];
    if (p.a) groups.push({ tag: 'a', d: p.a });
    if (p.d) groups.push({ tag: 'b', d: p.d });

    groups.forEach(function (g) {
      var pid = g.d.id;
      var pl = playerById(S.state, pid);
      var base = (typeof g.d.base === 'number') ? g.d.base : (pl ? pl.baseCombat : 0);
      var pip = rawPipOf(pid);                 // 原始骰点（combat.dice[id]）
      // v3 payload 直接给出 骰点附加(dice)/装备·同行者(gear)/卡牌修正(card)，优先使用；缺字段时回退推导
      var diceAdd = (typeof g.d.dice === 'number') ? g.d.dice
        : (pip === null ? null : diceToBonus(pip));
      var total = (typeof g.d.total === 'number') ? g.d.total : null;
      var gearMod = (typeof g.d.gear === 'number') ? g.d.gear : null;
      var cardMod = (typeof g.d.card === 'number') ? g.d.card
        : ((total === null || diceAdd === null || gearMod === null) ? null : (total - base - diceAdd - gearMod));
      // gear 缺字段时把剩余量都算进装备/同行者一栏，保证「基础+各项=最终」自洽
      if (gearMod === null && total !== null && diceAdd !== null && cardMod !== null) {
        gearMod = total - base - diceAdd - cardMod;
      }

      var wrap = el('div', 'breakdown');
      wrap.dataset.side = g.tag;
      wrap.appendChild(el('div', 'bd-title', playerName(S.state, pid) + ' · 最终战力结算'));

      function signed(n) { return n > 0 ? '+' + n : String(n); }

      var rows = [
        { label: '基础战力', val: String(base), cls: '' },
        {
          label: '骰点转化',
          val: (pip === null ? '附加 ' + (diceAdd === null ? '?' : signed(diceAdd))
            : '骰 ' + pip + ' 点 → 附加 ' + signed(diceAdd === null ? 0 : diceAdd)),
          cls: diceAdd > 0 ? 'pos' : ''
        },
        {
          label: '装备/同行者',
          val: gearMod === null ? '?' : signed(gearMod),
          cls: gearMod > 0 ? 'pos' : (gearMod < 0 ? 'neg' : '')
        },
        {
          label: '卡牌修正',
          val: cardMod === null ? '?' : signed(cardMod),
          cls: cardMod > 0 ? 'pos' : (cardMod < 0 ? 'neg' : '')
        },
        { label: '最终战力', val: total === null ? '?' : String(total), cls: '', total: true }
      ];
      rows.forEach(function (r) {
        var row = el('div', 'bd-row' + (r.total ? ' bd-total' : ''));
        row.appendChild(el('span', 'bd-label', r.label));
        row.appendChild(el('span', 'bd-val ' + (r.cls || ''), r.val));
        wrap.appendChild(row);
      });
      box.appendChild(wrap);
    });

    // 引擎写好的结算算式（combat_total 的 text），原样列出作为权威口径
    if (engineText) {
      var formula = el('div', 'bd-formula', engineText);
      box.appendChild(formula);
    }

    // 逐行揭示
    var allRows = Array.prototype.slice.call(box.querySelectorAll('.bd-row'));
    var chain = Promise.resolve();
    allRows.forEach(function (row) {
      chain = chain.then(function () {
        row.classList.add('reveal');
        return sleep(200);
      });
    });
    return chain.then(function () {
      if (engineText) {
        var f = $('.bd-formula', box);
        if (f) f.classList.add('reveal');
      }
      // 算式全部揭示后再点亮大字比分（别在动画半途就剧透最终结果）
      Combat.totals = { a: p.a ? p.a.total : null, b: p.d ? p.d.total : null };
      combatRender();
      return sleep(420);
    });
  }

  function stepResult(step) {
    var p = step.p || {};
    Combat.winner = p.winner || null;
    Combat.loser = p.loser || null;
    var st = S.state;
    var box = $('#combat-steps');
    // 昵称是玩家输入：进 innerHTML 必须转义（双人名同段是串联注入的通道）
    var winName = escapeHtml(playerName(st, p.winner));
    var loseName = escapeHtml(playerName(st, p.loser));

    var dmg = p.dmg || 0, qi = p.qi || 0;
    var lines = '';
    lines += '<div class="cr-line">' + loseName + ' 扣除 <b>' + dmg + '</b> 点生命值' +
      (qi > 0 ? '、<b>' + qi + '</b> 点灵气值' : '（境界较低，不扣灵气值）') + '</div>';
    if (step.steal) lines += '<div class="cr-line">对方境界较高，' + winName + ' 还从其手中抽走 1 张手牌。</div>';

    var card = el('div', 'combat-result');
    card.innerHTML =
      '<div class="cr-head">' + winName + ' 战胜了 ' + loseName + '！</div>' +
      (step.text ? '<div class="cr-line">' + escapeHtml(step.text) + '</div>' : '') +
      lines;
    box.appendChild(card);
    replayAnim(card, 'combat-result');

    banner((p.winner && p.winner === myId() ? '你' : winName) + ' 胜！', 'win', 1600);
    combatRender();
    return sleep(1750);
  }

  function stepTie(step) {
    var box = $('#combat-steps');
    var card = el('div', 'combat-result tie');
    card.innerHTML = '<div class="cr-head">平 手</div><div class="cr-line">' + escapeHtml(step.text || '双方战力持平。') + '</div>';
    box.appendChild(card);
    replayAnim(card, 'combat-result');
    combatRender();
    return sleep(1500);
  }

  /* ---------------- 对战面板内的手牌与平局操作 ---------------- */

  /**
   * 对战中的手牌区。
   * 现在对战中的所有出牌**都走【斗法】弹窗**（破招），所以这里只提示"去看弹窗"，
   * 不再让玩家直接点手牌 —— 点也打不出去（服务端会拒）。
   */
  function renderCombatHand(st, me, mode) {
    var zone = $('#combat-hand');
    zone.innerHTML = '';
    if (!me || me.out) return;
    var hint = (mode === 'pre' || mode === 'roll_defender')
      ? '对战中出牌走【斗法】弹窗：投骰前后会问你能不能打「对战中使用」的牌，在弹窗里破招或跳过。'
      : (mode === 'tie' ? '平局结算走【斗法】弹窗：可打出改变战力结果的牌，或跳过。'
        : (mode === 'result' ? '结算时机走【斗法】弹窗：赢家可打「获胜时」、输家可打「失败时」，后发先至、逆序收势。' : ''));
    if (hint) zone.appendChild(el('span', 'combat-hint', hint));
  }

  /* ================================================================
   * 15.4c 拖拽出牌（②c 后半句："手牌拖到牌桌才打出"）
   *   点一下手牌本来就能打（**保留** —— 移动端与无障碍都靠它）；这里再加一条**拖到牌桌**的路径。
   *   规则：只有"轮到我在行动阶段、且这张牌此刻打得出去"的牌才拖得动；
   *        丢在自己的手牌区 = 取消；丢在牌桌 = 与点击完全同一条流程（要选目标的牌会接着弹选人）。
   * ================================================================ */
  function dragPlayEnabled(st) {
    var me = myPlayer(st);
    if (!me || me.out || S.busy || S.discardMode) return false;
    if (st.turn !== me.id || st.step !== 'action' || st.combat || st.pending) return false;
    if (st.forceDiscard) return false;
    return true;
  }

  function onHandDragStart(ev) {
    var st = S.state;
    if (!st || !dragPlayEnabled(st)) return;
    var card = ev.target.closest ? ev.target.closest('.hand-card') : null;
    if (!card || card.disabled || !card.classList.contains('is-playable')) return;
    S.dragUid = numUid(card.dataset.uid);
    try { if (ev.dataTransfer) { ev.dataTransfer.setData('text/plain', String(S.dragUid)); ev.dataTransfer.effectAllowed = 'move'; } } catch (e) {}
    document.body.classList.add('dragging-card');
  }

  function onHandDragEnd() {
    S.dragUid = null;
    document.body.classList.remove('dragging-card', 'drag-cancel');
  }

  /* ================================================================
   * 15.4d 手牌悬停放大镜（用户 2026-10-05："鼠标指到哪张牌哪张就放大，牌面字太小看不清"）
   * ----------------------------------------------------------------
   * 手牌区是横向滚动容器（`overflow-x:auto`），直接在卡片上 `transform: scale()` 会被裁掉，
   * 所以放大用的是**跟着卡片走的浮层** `#hand-zoom`：指到哪张就在它上方弹出同一张牌的
   * 高清大图（复用 `cardDetailHtml`，字号放大一档）。浮层 `pointer-events:none`，
   * 点击 / 拖拽出牌一概不受影响；卡片本体同时抬起来 + 描金边，指哪张一眼看得出来。
   *
   * 收起的时机：移到别的牌上（换内容）、移出手牌区、开始拖拽、手牌区滚动、
   * 弹窗/对战面板盖上来、以及**触屏设备**（`hover: none`，压根不绑）。
   * ================================================================ */
  var HAND_ZOOM = { uid: null, timer: null, bound: false };

  function handZoomable() {
    try {
      var noHover = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);
      if (!noHover) return true;                       // 桌面：有 hover，直接用
      // ⚠️ 只有 hover:none 还不够判断"触摸设备"：**无头浏览器（CDP 跑 UI 测试）也会报 hover:none**，
      //    但它既没有粗指针也没有触摸点。真手机是「hover:none + pointer:coarse + 有触摸」三者齐。
      var coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
      return !(coarse || touch);
    } catch (e) { return true; }
  }

  function hideHandZoom() {
    if (HAND_ZOOM.timer) { clearTimeout(HAND_ZOOM.timer); HAND_ZOOM.timer = null; }
    HAND_ZOOM.uid = null;
    var box = $('#hand-zoom');
    if (box) box.classList.add('hidden');
    eachHandCard(function (c) { c.classList.remove('hover-zoom'); });
  }

  function eachHandCard(fn) {
    var list = document.querySelectorAll('#hand-zone .hand-card');
    for (var i = 0; i < list.length; i++) fn(list[i]);
  }

  /** 把浮层摆到这张卡**上方**（上面没地方就改摆下方），左右夹在视口内 */
  function placeHandZoom(card, box) {
    var r = card.getBoundingClientRect();
    var w = box.offsetWidth || 380;
    var h = box.offsetHeight || 260;
    var gap = 12;
    var left = r.left + r.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    var top = r.top - h - gap;
    if (top < 8) top = Math.min(window.innerHeight - h - 8, r.bottom + gap);   // 上方放不下 → 摆到下方
    box.style.left = Math.round(left) + 'px';
    box.style.top = Math.round(Math.max(8, top)) + 'px';
  }

  function showHandZoom(card) {
    var box = $('#hand-zoom');
    if (!box || !card) return;
    var uid = numUid(card.dataset.uid);
    var st = S.state;
    var me = myPlayer(st);
    if (!me || !me.hand) return;
    var inst = null;
    for (var i = 0; i < me.hand.length; i++) if (String(me.hand[i].uid) === String(uid)) inst = me.hand[i];
    if (!inst) { hideHandZoom(); return; }
    var def = cardDef(inst.id);
    if (!def) { hideHandZoom(); return; }
    var chk = checkPlay(def, me, st);
    box.innerHTML = cardDetailHtml(def, { why: chk.ok ? '' : (chk.why || '') }) +
      '<div class="zoom-hint">点一下『打出 / 打出并选目标』，或者把它**拖到牌桌**上</div>';
    box.classList.remove('hidden');
    placeHandZoom(card, box);
    HAND_ZOOM.uid = String(uid);
    eachHandCard(function (c) { c.classList.toggle('hover-zoom', c === card); });
  }

  function bindHandZoom() {
    if (HAND_ZOOM.bound || !handZoomable()) return;
    var zone = $('#hand-zone');
    if (!zone) return;
    HAND_ZOOM.bound = true;
    // 事件委托：指到哪张卡就放大哪张（同牌上移动不重弹，避免闪烁）
    zone.addEventListener('mouseover', function (ev) {
      var card = ev.target.closest ? ev.target.closest('.hand-card') : null;
      if (!card) return;
      if (HAND_ZOOM.uid === String(card.dataset.uid)) return;
      if (HAND_ZOOM.timer) clearTimeout(HAND_ZOOM.timer);
      // 80ms 防抖：鼠标扫过一排牌时不会一路乱弹
      HAND_ZOOM.timer = setTimeout(function () { HAND_ZOOM.timer = null; showHandZoom(card); }, 80);
    });
    zone.addEventListener('mouseleave', hideHandZoom);
    zone.addEventListener('scroll', hideHandZoom, { passive: true });
    zone.addEventListener('dragstart', hideHandZoom);
    window.addEventListener('resize', hideHandZoom);
    document.addEventListener('mousedown', function (ev) {
      // 点手牌或点别处都收起（点手牌时会走打出/选目标的流程）
      if (ev.target && ev.target.closest && ev.target.closest('#hand-zone')) hideHandZoom();
    });
  }

  /* ================================================================
   * 15.4b 选目标弹层（斗法窗口 / 主动技能共用）
   *   【青冥针】"当你受到任意 1 点伤害时，指定**任意一位修士**受到等额伤害"、
   *   【金魁】"使**场上任意 1 张**宝物牌/法术牌无效" —— 这两张卡必须在发起动作**之前**选目标。
   *   两种目标：
   *     kind='player' → 选一位修士，动作里带 `target`（玩家 id）
   *     kind='board'  → 选场上的一张牌，动作里带 `targetUid`（实例 uid）
   *   引擎那边由 `respondPlay` / `doActivate` 收这两个字段（缺了会直接拒，免得白打出牌）。
   * ================================================================ */
  function openTargetPicker(opts) {
    var st = S.state;
    opts = opts || {};
    var kind = opts.kind || 'player';
    var prev = document.querySelector('.pick-overlay');
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);

    var ov = el('div', 'pick-overlay');
    var box = el('div', 'pick-box');
    box.appendChild(el('div', 'pick-title', opts.title || '选择目标'));
    box.appendChild(el('div', 'pick-sub', opts.sub || (kind === 'board'
      ? '选择场上的一张【宝物牌】/【法术牌】（被无效的牌留在场上，但效果全部失效）'
      : (kind === 'discard' ? '选一张放入弃牌堆' : '选择一位修士作为目标'))));
    var list = el('div', 'pick-list');
    var choices = opts.choices || [];
    if (!choices.length && kind === 'board') {
      (st && st.players || []).forEach(function (pl) {
        [['equip', '储物袋'], ['spells', '法术区'], ['companions', '同行者'], ['puppets', '傀儡位']].forEach(function (z) {
          (pl[z[0]] || []).forEach(function (inst) {
            var def = cardDef(inst.id);
            if (!def) return;
            choices.push({
              uid: inst.uid,
              label: '【' + def.name + '】',
              sub: pl.name + ' · ' + z[1] + (inst.nullified ? ' · 已失效' : ''),
            });
          });
        });
      });
    } else if (!choices.length && kind !== 'discard') {
      var info = targetInfo(st, 'card');
      (info.list || []).forEach(function (pl) {
        choices.push({ pid: pl.id, label: pl.name, sub: (pl.realmName || realmName(pl.realm)) + ' · ' + pl.hp + ' 血' });
      });
    }
    if (!choices.length) {
      list.appendChild(noteBox(kind === 'board' ? '场上现在没有可指定的宝物牌 / 法术牌。'
        : (kind === 'discard' ? '手里没有可作为代价的牌。' : '现在没有可指定的目标。')));
    }
    choices.forEach(function (o) {
      var b = el('button', 'pick-opt' + (opts.danger ? ' pick-danger' : ''));
      b.type = 'button';
      b.innerHTML = '<b>' + escapeHtml(o.label) + '</b><span>' + escapeHtml(o.sub || '') + '</span>';
      b.addEventListener('click', function () { close(); opts.onPick(o); });
      list.appendChild(b);
    });
    box.appendChild(list);
    var cancel = el('button', 'pick-cancel', '取 消');
    cancel.type = 'button';
    cancel.addEventListener('click', function () { close(); });
    box.appendChild(cancel);
    ov.appendChild(box);
    // 点遮罩（弹层本体以外）也当取消
    ov.addEventListener('click', function (ev) { if (ev.target === ov) close(); });
    document.body.appendChild(ov);
    function close() { if (ov.parentNode) ov.parentNode.removeChild(ov); }
    return ov;
  }

  /** 主动技能按钮：场面上的牌自带的能力（【梅凝】回血抽牌后离场、【青易居士】弃宝物改抽法术） */
  function appendActivateBtns(bar, me, busy) {
    var acts = (me && me.activatables) || [];
    acts.forEach(function (a) {
      var tips = (a.effects || []).map(function (e) {
        return (META.ops[e.op] ? META.ops[e.op].label : e.op) + (e.value ? ' ' + e.value : '');
      }).join('，') + (a.discardSelf ? '；之后自身进弃牌堆' : '');
      // 只在当前阶段确实能发动时才画（引擎的 onlyStep 判定）
      bar.appendChild(mkBtn('主动使用 · ' + a.name, 'btn-cyan', function () {
        // ⭐ 舍弃类代价：**先醒目确认"要用掉哪一张"**（②c 前半句）。
        //   卡文写「将**任意 1 张**【宝物牌】放入弃牌堆」，所以让玩家自己挑（引擎收 `discardUid`）。
        if (a.costDiscard) {
          var deckCn = { treasure: '宝物牌', spell: '法术牌', companion: '同行者', qi: '灵气牌' }[a.costDiscard] || '牌';
          openTargetPicker({
            kind: 'discard',
            danger: true,
            title: '⚠ 发动【' + a.name + '】要弃置 1 张' + deckCn,
            sub: '这是一次**舍弃**：选中的那张会进入弃牌堆，不可撤销。（卡文：将任意 1 张【' + deckCn + '】放入弃牌堆）',
            choices: (a.discardChoices || []).map(function (c) {
              return { uid: c.uid, label: '【' + c.name + '】', sub: '手里的' + deckCn + ' · 将被放入弃牌堆' };
            }),
            onPick: function (o) {
              send({ type: 'activate', uid: a.uid, discardUid: o.uid });
            },
          });
          return;
        }
        // 需要选目标的主动技能（【金魁】"使场上任意 1 张宝物/法术牌无效"）：
        //    先弹选择器，选完再发 activate（带上 target / targetUid）。
        if (!a.needsTarget) { send({ type: 'activate', uid: a.uid }); return; }
        openTargetPicker({
          kind: a.targetKind || 'player',
          title: '【' + a.name + '】—— 选择目标',
          onPick: function (o) {
            var act = { type: 'activate', uid: a.uid };
            if (o.uid != null) act.targetUid = o.uid; else act.target = o.pid;
            send(act);
          },
        });
      }, busy, tips));
    });
  }

  /**
   * 结果窗口（战果已定）。
   * 也是【斗法】：出牌与跳过都走斗法弹窗（#pending-modal），
   * 所以这里只画一个状态条，不再提供按钮 —— 真正操作在那边的弹窗里。
   */
  function renderResultActions(actions, st, c, me) {
    var box = el('div', 'tie-status');
    [['获胜方', c.winnerId], ['失败方', c.loserId]].forEach(function (row) {
      var s = el('span', (me && me.id === row[1]) ? 'wait' : '');
      // 昵称是玩家自己输入的 → 只能走 textContent，绝不能拼进 innerHTML
      s.textContent = row[0] + ' ' + playerName(st, row[1]);
      box.appendChild(s);
    });
    actions.appendChild(box);
    var who = st.pending && st.pending.actorName;
    actions.appendChild(noteBox(who
      ? '等待 <b>' + escapeHtml(who) + '</b> 决定是否破招……（在【斗法】弹窗里操作）'
      : '结算时点见【斗法】弹窗：赢家可打「获胜时」、输家可打「失败时」，后发先至、逆序收势。'));
  }

  function renderTieActions(actions, st, c, me) {
    if (!me) return;
    var mine = c.attacker === me.id || c.defender === me.id;
    var status = el('div', 'tie-status');
    [c.attacker, c.defender].forEach(function (pid) {
      var doneMark = c.tieUsed[pid] ? '已出牌' : (c.tiePassed[pid] ? '已过牌' : '等待中');
      var cls = (c.tieUsed[pid] || c.tiePassed[pid]) ? 'done' : 'wait';
      var s = el('span', cls);
      // 昵称走 textContent；cls / doneMark 是本文件里的内部常量，拼进标签属性是安全的
      s.appendChild(document.createTextNode(playerName(st, pid) + '：'));
      s.appendChild(el('b', cls, doneMark));
      status.appendChild(s);
    });
    actions.appendChild(status);

    if (!mine) return;
    if (c.tieUsed[me.id] || c.tiePassed[me.id]) return;
    actions.appendChild(mkBtn('过 牌（不加战力）', 'btn-cyan', function () { send({ type: 'tie' }); }, S.busy));
  }

  /* ================================================================
   * 14. 结算画面 · 卡牌详情 · 规则弹窗
   * ================================================================ */

  function renderOver(st) {
    var ov = $('#over-overlay');
    var show = st && st.phase === 'over';
    ov.classList.toggle('hidden', !show);
    if (!show) return;

    var winner = st.winner ? playerById(st, st.winner) : null;
    $('#over-seal').textContent = winner && winner.realm >= 4 ? '婴' : '终';
    $('#over-title').textContent = winner
      ? (winner.realm >= 4 ? winner.name + ' 结成元婴' : winner.name + ' 技压群修')
      : '无人生还';
    $('#over-sub').textContent = winner
      ? '九寰震动，万修俯首——本局终了。'
      : '众修同归于尽，此局无胜者。';

    var ranked = st.players.slice().sort(function (x, y) {
      if (x.id === st.winner) return -1;
      if (y.id === st.winner) return 1;
      if (!!x.out !== !!y.out) return x.out ? 1 : -1;
      if (y.realm !== x.realm) return y.realm - x.realm;
      if (y.hp !== x.hp) return y.hp - x.hp;
      return x.seat - y.seat;
    });

    var list = $('#over-rank');
    list.innerHTML = '';
    ranked.forEach(function (p, i) {
      var row = el('li', 'rank-row r' + (i + 1));
      row.appendChild(el('span', 'rank-no', String(i + 1)));
      row.appendChild(el('span', 'rank-name', p.name + (p.id === myId() ? '（你）' : '')));
      row.appendChild(el('span', 'rank-meta', (p.realmName || realmName(p.realm)) + ' · 生命 ' + p.hp + ' · 战力 ' + p.baseCombat + (p.out ? ' · 已出局' : '')));
      list.appendChild(row);
    });

    var isHost = st.host === myId();
    $('#btn-again').classList.toggle('hidden', !isHost);
    $('#over-wait').classList.toggle('hidden', isHost);
  }

  /**
   * 卡面详情的 HTML（**唯一实现**）：卡牌弹窗（点开）与手牌"悬停放大"面板共用，
   * 免得两处各写一份、改一处忘一处。
   * opts: { why?: 打不出的原因, usesLeft?: 这张牌还剩几次 }
   */
  function cardDetailHtml(def, opts) {
    opts = opts || {};
    if (!def) return '<p class="muted">卡牌数据缺失。</p>';
    var deck = deckOf(def.id);
    var st = S.state;
    var type = cardType(def);
    var meta = '';
    if (type === 'companion') {
      meta = '<span>境界 <b>无限制</b></span>' +
        '<span>占位 <b>占 ' + companionSlotCost(def) + ' 个放置位</b></span>' +
        '<span>牌堆共 <b>' + (def.count == null ? 1 : def.count) + '</b> 张</span>';
    } else if (type === 'equip') {
      meta = '<span>角标法力 <b>' + (typeof def.cost === 'number' ? def.cost : 0) + '</b></span>' +
        '<span>适用 <b>' + realmRequirement(def) + '</b></span>' +
        '<span>装备费 <b>' + (equipCostOf(def) > 0 ? equipCostOf(def) + ' 点法力' : '不消耗（效果才计费）') + '</b></span>' +
        '<span>牌堆共 <b>' + (def.count == null ? 1 : def.count) + '</b> 张</span>';
    } else {
      meta = '<span>消耗 <b>' + (typeof def.cost === 'number' ? def.cost + ' 法力' : '无') + '</b></span>' +
        '<span>适用 <b>' + realmRequirement(def) + '</b></span>' +
        '<span>牌堆共 <b>' + (def.count == null ? 1 : def.count) + '</b> 张</span>';
    }
    // ⭐「应对」与「可用 N 次」（2026-10-05 用户裁定）：
    //    只有带应对的牌才进【斗法】链（＝能被破招），所以卡面上必须写清楚；
    //    可用次数用完就不再被摆出来问，这里显示还剩几次。
    if (def.response === true) meta += '<span>标记 <b>应对</b>（可破招·进斗法链）</span>';
    if (def.uses) {
      var leftTxt = typeof opts.usesLeft === 'number' ? '（本张还剩 ' + opts.usesLeft + ' 次）' : '';
      meta += '<span>可用次数 <b>' + def.uses + ' 次</b>' + leftTxt + '</span>';
    }
    // 装备付费按卡文写清楚（带「装备时不消耗」→ 免费、效果才计费；没写 → 装备时付、效果不耗）
    var tierNote = (type === 'equip')
      ? '<p class="cd-tier">' + equipTierText(def, st) + '</p>'
      : '';
    // 多档位法术：列出全部档位。**装备类**是"自动按境界生效"（不用选），标出当前生效的那一档；
    // **消耗类**（【火弹术】）是同境界二选一，标出"响应时选一项"。
    if (isTieredEquip(def)) {
      var myRealm = myPlayer(st) ? myPlayer(st).realm : 0;
      var autoIdx = maxTierFor(def, myRealm);
      tierNote += '<div class="cd-tiers"><h4>档位效果（自动按当前境界生效，无需选择）</h4>' +
        def.tiers.map(function (t, i) {
          var ok = (t.realm || 0) <= myRealm;
          var isCur = ok && i === autoIdx;
          return '<div class="cd-tier-row' + (ok ? '' : ' locked') + (isCur ? ' current' : '') + '">' +
            '<span class="ct-realm">' + realmName(t.realm) + '档</span>' +
            '<span class="ct-text">' + escapeHtml(String(t.text || '')) + '</span>' +
            '<span class="ct-state">' + (isCur ? '当前生效' : (ok ? '已可用' : '境界不足')) + '</span></div>';
        }).join('') + '</div>';
    } else if (def && def.tiers && def.tiers.length) {
      // 消耗类的"多选项"（同境界二选一）：响应时会出现对应的选项按钮
      tierNote += '<div class="cd-tiers"><h4>多选项效果（使用时选 1 项触发）</h4>' +
        def.tiers.map(function (t, i) {
          return '<div class="cd-tier-row">' +
            '<span class="ct-realm">选项 ' + (i + 1) + '</span>' +
            '<span class="ct-text">' + escapeHtml(String(t.text || '')) + '</span>' +
            '<span class="ct-state">' + (realmName(t.realm) + '起') + '</span></div>';
        }).join('') + '</div>';
    }
    // 同行者「替挡」：只有卡文明写「可替你承受 N 次伤害」的才替挡
    var abTimes = absorbTimes(def);
    if (type === 'companion' && abTimes > 0) {
      tierNote += '<p class="cd-tier cd-absorb">替挡：可替你承受任意 <b>' + abTimes + ' 次</b>伤害（不论伤害多高，整次全挡下），' +
        '之后放入弃牌堆。</p>';
    } else if (type === 'companion') {
      tierNote += '<p class="cd-tier">普通同行者<b>不替挡伤害</b>——敌人打你时伤害直接落在你自己身上，' +
        '同行者只提供下面的常驻效果。</p>';
    }
    // 卡池数据虽然是自家 JSON，但同属"把数据拼进 innerHTML"，一并过 escapeHtml 做纵深
    return '<div class="card-detail">' +
      '<div class="cd-head">' +
        '<span class="cd-name">' + escapeHtml(def.name) + '</span>' +
        '<span class="cd-type deck-' + deck + '">' + DECK_NAME[deck] + ' · ' + (CARD_TYPE_NAME[type] || '') + '</span>' +
      '</div>' +
      '<div class="cd-meta">' + meta + '</div>' +
      '<p class="cd-text">' + escapeHtml(def.text || '') + '</p>' +
      tierNote +
      effRows(def) +
      (opts.why ? '<p class="cd-why">当前不可打出：' + escapeHtml(opts.why) + '</p>' : '') +
    '</div>';
  }

  function openCardModal(cardId, why, ctx) {
    var def = cardDef(cardId);
    var body = $('#card-modal-body');
    if (!def) { body.innerHTML = '<p class="muted">卡牌数据缺失。</p>'; $('#card-modal').classList.remove('hidden'); return; }
    var st = S.state;
    var usesLeftIn = (typeof ctx === 'object' && ctx && typeof ctx.usesLeft === 'number') ? ctx.usesLeft : null;
    body.innerHTML = cardDetailHtml(def, { why: why, usesLeft: usesLeftIn });
    // 「撤下」：我自己场上的牌，轮到我且处于行动阶段时，可撤下进弃牌堆腾格（用户裁定 A 方案）
    if (ctx && ctx.uid && ctx.ownerId === myId() && st && st.phase === 'playing' &&
        st.turn === myId() && st.step === 'action' && !st.combat && !st.pending) {
      var dismissBtn = mkBtn('撤 下（放入弃牌堆，腾出放置位）', 'btn-ghost', function () {
        send({ type: 'dismiss', uid: ctx.uid });
        $('#card-modal').classList.add('hidden');
      }, !!S.busy, '免费撤下：这张牌立即放入弃牌堆、效果失效；撤下后不可收回');
      dismissBtn.classList.add('cd-dismiss');
      body.appendChild(dismissBtn);
    }
    $('#card-modal').classList.remove('hidden');
  }

  /* ================================================================
   * 效果元数据（从 /api/meta 拉取，本地只留兜底）
   * ---------------------------------------------------------------
   * 以前这里有一份 60 条的 KIND_TXT 词典，加一个效果类型就得记得同步两处。
   * 现在标签的唯一来源是 server/effect-meta.js，服务端经 /api/meta 下发。
   * ================================================================ */
  var META = { ops: {}, whens: {}, conditions: {} };

  function loadMeta() {
    return fetch('/api/meta').then(function (r) { return r.json(); }).then(function (m) {
      if (m && m.ops) META = m;
      return META;
    }).catch(function () { return META; });
  }
  function opLabel(op) { var o = META.ops && META.ops[op]; return (o && o.label) || op; }
  function whenLabel(w) { var x = META.whens && META.whens[w]; return (x && x.label) || w; }

  /**
   * 把一条效果渲染成中文短语。
   * 数据形状：{ when, op, if, value/… }  —— 这里也负责把 if 条件翻译成人话。
   */
  function effectText(e) {
    var t = opLabel(e.op);
    var v = (typeof e.value === 'number') ? e.value : null;
    var extra = '';
    if (e.op === 'draw' || e.op === 'draw_treasure' || e.op === 'draw_qi') {
      extra = ' ' + (v == null ? 1 : v) + ' 张' + ({ treasure: '宝物牌', spell: '法术牌', qi: '灵气牌' }[e.deck] || '');
    } else if (e.op === 'heal' || e.op === 'mana' || e.op === 'damage' || e.op === 'damage_target') {
      extra = v == null ? '' : ' ' + v + ' 点';
    } else if (v != null) {
      extra = ' ' + v;
    }
    var cond = condText(e.if);
    return t + extra + (cond ? '（' + cond + '）' : '');
  }

  /** 把 if 条件翻译成中文；多个键之间是「且」 */
  function condText(cond) {
    if (!cond) return '';
    var parts = [];
    var cmp = function (o) {
      if (o == null) return '';
      if (typeof o !== 'object') return String(o);
      var s = [];
      if (o.lte != null) s.push('≤' + o.lte);
      if (o.lt != null) s.push('<' + o.lt);
      if (o.gte != null) s.push('≥' + o.gte);
      if (o.gt != null) s.push('>' + o.gt);
      if (o.eq != null) s.push('=' + o.eq);
      return s.join(',');
    };
    for (var k in cond) {
      if (!cond.hasOwnProperty(k)) continue;
      var w = cond[k];
      if (k === 'hp') parts.push('生命值' + cmp(w));
      else if (k === 'realm') parts.push('自己境界' + cmp(w));
      else if (k === 'enemyRealm') parts.push(w && w.higher ? '对方境界更高' : (w && w.lower ? '对方境界更低' : '对方境界' + cmp(w)));
      else if (k === 'target') parts.push(w && w.realmHigher ? '目标境界更高' : ('目标境界' + cmp(w && w.realm ? w.realm : w)));
      else if (k === 'companion') parts.push('场上有【' + w + '】');
      else if (k === 'hasEquip') parts.push('储物袋里有装备');
      else if (k === 'inCombat') parts.push('有进行中的对战');
      else if (k === 'turnFlag') parts.push('本回合标记满足');
      else parts.push(k);
    }
    return parts.join(' 且 ');
  }

  /**
   * 一条效果的"时机"中文名 —— **阶段图口径**（用户 2026-10-02）。
   * 名字来自 /api/meta 的 `timingNames`（服务端 effect-meta 的 TIMING_NAMES 唯一权威），
   * 前端**不再自己拼**「事件 · 主体 · 阶段」（那是引擎腔，且对不上阶段图的叫法）。
   * 只有服务端没给（老缓存/新坐标）时才退回拼法。
   */
  function timingText(e) {
    if (!e) return '特定时机';
    var key = timingLookupKey(e);
    var table = META.timingNames || {};
    for (var i = 0; i < key.length; i++) {
      var hit = table[key[i]];
      if (hit && hit.name) return hit.name;
    }
    if (e.event) {
      var ev = (META.events || {})[e.event];
      var lbl = (ev && ev.label) || e.event;
      if (e.subject === 'foe') lbl += ' · 对方';
      else if (e.subject === 'self' && ev && ev.subject === 'both') lbl += ' · 我方';
      if (e.phase) lbl += ' · ' + (({ before: '前', after: '后', win: '获胜', tie: '平局', lose: '失败' })[e.phase] || e.phase);
      return lbl;
    }
    if (e.when) return whenLabel(e.when);
    // （已删）engineDirect 特判：【青易居士】explore_swap 现在带 event:'drawTreasure'，走上面的正常查表
    return '特定时机';
  }
  /** 查名字表的候选键（与服务端 timingMetaOf 同一套回退顺序：最具体 → 最粗） */
  function timingLookupKey(e) {
    if (!e.event) return [];
    var sub = e.subject || (function () {
      var ev = (META.events || {})[e.event];
      return (ev && ev.subject === 'both') ? 'self' : '';
    })();
    var ph = e.phase || '';
    return [e.event + '|' + sub + '|' + ph, e.event + '|' + sub, e.event + '|' + ph, e.event];
  }

  /** 效果的代价/限定后缀：消耗法力、弃牌代价、限定阶段 */
  function effLimitText(e) {
    var bits = [];
    if (e.manaCost) bits.push('消耗 ' + e.manaCost + ' 点法力');
    if (e.cost && e.cost.discard) {
      bits.push('代价：弃 1 张' + (({ treasure: '宝物牌', spell: '法术牌', companion: '同行者', qi: '灵气牌' })[e.cost.discard] || e.cost.discard));
    }
    if (e.onlyStep) {
      bits.push('仅限' + (({ draw_qi: '炼化阶段', draw_treasure: '探索阶段', choose_draw: '抉择阶段', action: '行动阶段' })[e.onlyStep] || e.onlyStep));
    }
    return bits.length ? '（' + bits.join('；') + '）' : '';
  }

  function effRows(def) {
    var out = [];
    var list = def.effects || [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      out.push([timingText(e), effectText(e) + effLimitText(e)]);
    }
    if (def.cardCostDiscount) out.push(['常驻', '使用宝物牌/法术牌时法力消耗 -' + def.cardCostDiscount + '（最低为 1）']);
    if (def.absorb) out.push(['常驻', '可替你承受任意 ' + (def.absorb === true ? 1 : def.absorb) + ' 次伤害']);
    if (!out.length) return '';
    return '<div class="cd-effs">' + out.map(function (r) {
      return '<div class="eff"><b>' + r[0] + '</b><span>' + r[1] + '</span></div>';
    }).join('') + '</div>';
  }

  /* ================================================================
   * 15. 动画反馈（数值变化 / 晋升 / 抽牌 / 淘汰）
   * ================================================================ */

  function floatText(pid, text, cls) {
    var card = $('#foe-grid > .board[data-pid="' + pid + '"], #me-grid > .board[data-pid="' + pid + '"]');
    if (!card) return;
    var layer = $('.bd-float', card);
    if (!layer) return;
    var node = el('span', 'float-text ' + (cls || 'dmg'), text);
    layer.appendChild(node);
    setTimeout(function () { node.remove(); }, 1300);
  }

  function flashVal(pid, sel, cls) {
    var card = $('#foe-grid > .board[data-pid="' + pid + '"], #me-grid > .board[data-pid="' + pid + '"]');
    if (!card) return;
    var node = $(sel, card);
    if (!node) return;
    node.classList.remove('flash-down', 'flash-up', 'flash-soft');
    void node.offsetWidth;
    node.classList.add(cls);
    setTimeout(function () { node.classList.remove(cls); }, 950);
  }

  function updateAnimations(st) {
    var cur = {};
    st.players.forEach(function (p) {
      var prev = S.stats[p.id];
      cur[p.id] = { hp: p.hp, mana: p.mana, qi: p.qi, realm: p.realm, out: p.out };
      if (!prev) return;

      if (p.hp < prev.hp) {
        floatText(p.id, '-' + (prev.hp - p.hp), 'dmg');
        flashVal(p.id, '.hp-num', 'flash-down');
      } else if (p.hp > prev.hp) {
        floatText(p.id, '+' + (p.hp - prev.hp), 'heal');
        flashVal(p.id, '.hp-num', 'flash-up');
      }
      if (p.qi !== prev.qi) {
        if (p.qi > prev.qi) {
          // 若这次涨灵气已排进「抽取动画」，飘字改由牌落到灵气区时播，避免提前/重复
          var qiAnimating = DrawFx.running || DrawFx.queue.some(function (ev) { return ev.type === 'qi'; });
          if (!qiAnimating) floatText(p.id, '+' + (p.qi - prev.qi) + ' 灵气', 'qi');
        } else {
          floatText(p.id, '-' + (prev.qi - p.qi) + ' 灵气', 'qi');
        }
        flashVal(p.id, '.qi-val', 'flash-soft');
      }
      if (p.mana !== prev.mana) {
        if (p.mana > prev.mana) floatText(p.id, '+' + (p.mana - prev.mana) + ' 法力', 'mana');
        else floatText(p.id, '-' + (prev.mana - p.mana) + ' 法力', 'mana');
        flashVal(p.id, '.mana-num', 'flash-soft');
      }
      if (p.realm > prev.realm) {
        var card = $('#foe-grid > .board[data-pid="' + p.id + '"], #me-grid > .board[data-pid="' + p.id + '"]');
        if (card) replayAnim(card, 'breakthrough');
        banner('突破！' + p.name + ' 晋升【' + (p.realmName || realmName(p.realm)) + '】', 'win', 2400);
      }
      if (p.out && !prev.out) {
        var dead = $('#foe-grid > .board[data-pid="' + p.id + '"], #me-grid > .board[data-pid="' + p.id + '"]');
        if (dead) replayAnim(dead, 'is-dead-flash');
        banner(p.name + ' 出局', 'bad', 2000);
      }
    });
    S.stats = cur;
  }

  /* ================================================================
   * 16. 主循环 · SSE · 启动
   * ================================================================ */

  function send(action) {
    if (S.busy) return;
    if (!S.session) { toast('尚未入席', 'err'); return; }
    S.busy = true;
    renderActionBar(S.state);
    combatRender();
    // ⚠️ 请求结束时必须**连询问弹窗一起重绘**。
    // 时点询问弹窗可能在请求还在飞的时候被 SSE 推过来，那一刻 S.busy 还是 true，
    // 于是"不响应"按钮被渲染成 disabled；请求结束后如果只重绘行动栏/手牌，弹窗就永远点不动了
    // ——玩家会彻底卡住（这是实测抓到的真 bug）。
    var settled = false;
    var done = function () {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      S.busy = false;
      if (S.state) {
        syncDiscardMode(S.state);
        renderActionBar(S.state); renderHand(S.state); combatRender(); renderPending(S.state);
      }
    };
    // 兜底：请求万一挂住（网络抖动 / 服务端慢 / 连接被掐），不能让玩家永远卡在"操作中"
    var guard = setTimeout(done, 10000);
    apiAction(S.session, action).catch(function (e) {
      toast(e.message || '操作失败', 'err');
    }).then(done);
  }

  /**
   * 🧪 **测试钩子**（只给 CDP UI 回归用；线上行为零影响 —— 不读它、也没别的地方调用它）。
   *
   * 有些界面状态（例如"斗法弹窗里出现一条**需要选目标**的候选"）在真实对局里极难稳定复现，
   * 而它恰恰是新交互最容易出错的地方。这里允许把一份 publicState + 席位直接喂给渲染层，
   * 于是 tests\ui-target-pick.js 可以在浏览器里断言"选择器弹得出来、点了发出去的动作对不对"。
   * 用法：`window.__fanrenPreview(state, { playerId:'a', roomId:'XXXX', token:'...' })`
   */
  window.__fanrenPreview = function (st, session) {
    if (!st) return false;
    if (session) S.session = session;
    S.busy = false;
    S.logPrev = [];
    onState(st);
    return true;
  };

  function onState(st) {
    var isNewRoom = !S.state || S.state.roomId !== st.roomId;
    var diff = diffLog(S.logPrev, st.log || []);
    S.logPrev = st.log || [];

    var firstOfGame = !S.state || S.state.phase !== st.phase;
    S.state = st;
    syncDiscardMode(st);

    if (st.phase === 'lobby') {
      setView('room');
      renderRoom(st);
    } else {
      setView('table');
      if (firstOfGame && st.phase === 'playing') {
        S.stats = {};
        S.seenHand = {};
        banner('开局！' + playerName(st, st.turn) + ' 先行', 'cyan', 2200);
      }
      renderDeckChips(st);
      renderPlayers(st);
      renderHand(st);
      renderActionBar(st);
      renderDecks(st);
    }
    // 战报（对战动画需要新增条目）
    appendLog(diff.add, diff.fresh || isNewRoom);
    // 抽取动画：先收集队列（这样 updateAnimations 能把「灵气飘字」让给动画落点播）
    if (!isNewRoom) drawFxObserve(diff.add);
    updateAnimations(st);
    // 首帧（新入房/重连）不重放历史对战动画，也不补播历史横幅
    combatSync(st, diff.add, isNewRoom);
    if (!isNewRoom) handleSpecialEntries(diff.add);
    renderOver(st);
    renderPending(st);
    renderConnect(true);
  }

  /* ================================================================
   * 【斗法】窗口（代码里的"时点询问 / 打断窗口"）
   * ---------------------------------------------------------------
   * 命名（用户 2026-10-02 定）：系统叫**斗法**、响应叫**破招**、结算叫**收势**，
   * 口诀「**后发先至，逆序收势**」（后出手的先结算）。代码里的 pending / chain /
   * openInterrupt / resolvePending **不改名**（避免大范围改名引出回归），只有玩家看得见的文案用它。
   * 引擎在某处挂起后会在 state 里下发 pending。这里把它渲染成一个必须表态的弹窗：
   *   · 轮到我 → 列出我能破招的牌（手牌 = 打出；场上 = 发动）+「不破招·跳过」
   *   · 不是我 → 显示等待谁表态
   * 不表态就没法做别的（引擎侧也会拒绝其他动作），所以这个弹窗关不掉。
   * ================================================================ */
  /** 弹窗内战果条：对战中被问「要不要破招」时，先看清现在谁领先、双方还剩几命（不再盲用）。 */
  function renderPendingCombat(st) {
    var box = $('#pending-combat');
    if (!box) return;
    var c = st && st.combat;
    if (!c) { box.classList.add('hidden'); box.innerHTML = ''; return; }
    var meId = myId();
    var ta = (c.total && typeof c.total[c.attacker] === 'number') ? c.total[c.attacker] : null;
    var td = (c.total && typeof c.total[c.defender] === 'number') ? c.total[c.defender] : null;
    box.innerHTML = '';
    box.appendChild(el('div', 'pc-head', '当 前 战 况'));
    [[c.attacker, '先攻', ta], [c.defender, '后攻', td]].forEach(function (row) {
      var pid = row[0], total = row[2];
      var pl = playerById(st, pid);
      var known = (ta !== null && td !== null);
      var isWin = known && (c.winnerId ? c.winnerId === pid : (row[2] === Math.max(ta, td) && ta !== td));
      var r = el('div', 'pc-row' + (isWin ? ' pc-win' : (known && ta !== td ? ' pc-lose' : '')));
      var nm = el('span', 'pc-name');
      nm.textContent = row[1] + '·' + (pl ? pl.name : '?') + (meId === pid ? '（你）' : '');
      r.appendChild(nm);
      var dice = el('span', 'pc-dice');
      dice.textContent = (c.dice && typeof c.dice[pid] === 'number') ? ('骰 ' + c.dice[pid]) : '未掷';
      r.appendChild(dice);
      r.appendChild(el('span', 'pc-total', total !== null ? String(total) : '—'));
      var hp = el('span', 'pc-hp');
      hp.textContent = pl ? ('生命 ' + pl.hp) : '';
      r.appendChild(hp);
      box.appendChild(r);
    });
    var verdict = el('div', 'pc-verdict');
    if (ta !== null && td !== null) {
      if (ta === td) {
        verdict.textContent = '双方战力持平 ' + ta + ' : ' + td + '。';
      } else {
        var leadId = ta > td ? c.attacker : c.defender;
        verdict.textContent = (leadId === meId ? '你' : playerName(st, leadId)) + ' 领先 ' +
          Math.max(ta, td) + ' : ' + Math.min(ta, td) +
          (c.winnerId ? ' —— ' + (c.winnerId === meId ? '你正获胜！' : playerName(st, c.winnerId) + ' 获胜') : '。');
      }
    } else if (c.stage === 'roll_defender') {
      verdict.textContent = '先攻已掷出，应战方掷完即结算——现在出的牌还能改变结果。';
    } else {
      verdict.textContent = '双方都还没掷骰——现在出的牌会影响最终战力。';
    }
    box.appendChild(verdict);
    box.classList.remove('hidden');
  }

  function renderPending(st) {
    var pd = st && st.pending;
    var ov = $('#pending-modal');
    if (!ov) return;
    if (!pd) { ov.classList.add('hidden'); return; }
    // 结算动画还在播 → 押后弹窗：结果/平局/投骰类窗口与骰子、算式、胜负横幅常同帧到达，
    // 立刻弹出会盖住没播完的结算（用户实盘：被问"要不要破招"却不知道自己赢了还是输了 = 盲用）。
    // 动画队列播完（runCombatQueue 收尾）会补调本函数；10 秒兜底防动画意外卡死。
    if (st.combat && Combat.running && !Combat.holdExpired) {
      ov.classList.add('hidden');
      if (!Combat.holdTimer) {
        Combat.holdTimer = setTimeout(function () {
          Combat.holdTimer = null;
          Combat.holdExpired = true;
          renderPending(S.state);
        }, 10000);
      }
      return;
    }
    ov.classList.remove('hidden');
    renderPendingCombat(st);
    $('#pending-title').textContent = '斗 法 · 破 招 —— ' + (pd.label || pd.event);
    var about = $('#pending-about');
    var bits = [];
    // 卡名与玩家昵称都可能来自外部输入 → 一律 escapeHtml 后再拼
    if (pd.about && pd.about.cardName) bits.push('对方正在打出 <b>' + escapeHtml(pd.about.cardName) + '</b>');
    if (pd.about && pd.about.damage) {
      // 受伤的人不一定是我 —— 【阴魂丝】、【风灵劲】这类会让"对方"掉血而我被问一句。
      // 以前这里一律写"你刚刚受到"，于是别人掉血时我也看到"你受到"（用户实盘报过）。
      // 第 3 轮：受伤窗口**前置**（这一点伤害还没落地）→ 文案改成"即将受到"，收势之后才真扣血。
      var subj = pd.about.subjectName;
      var soon = pd.about.pending === true;
      var verb = soon ? '即将受到' : '刚刚受到';
      if (subj && pd.about.subjectId !== myId()) {
        bits.push('【' + escapeHtml(subj) + '】' + verb + ' <b>' + escapeHtml(pd.about.damage) + '</b> 点伤害');
      } else {
        bits.push('你' + verb + ' <b>' + escapeHtml(pd.about.damage) + '</b> 点伤害');
      }
    }
    if (pd.about && pd.about.lethal) {
      bits.push('<b class="danger">' + (pd.about.pending ? '这次伤害将使生命值归零——不出手就出局' : '生命值已归零——不出手就出局') + '</b>');
    }
    if (pd.about && pd.about.attacker && pd.about.defender) {
      bits.push(escapeHtml(playerName(st, pd.about.attacker)) + ' 向 ' +
        escapeHtml(playerName(st, pd.about.defender)) + ' 发起了对战');
    }
    about.innerHTML = bits.map(function (b) { return '<p>' + b + '</p>'; }).join('');

    var list = $('#pending-list');
    list.innerHTML = '';
    var pass = $('#btn-pending-pass');
    if (!pd.amActor) {
      $('#pending-sub').textContent = '等待「' + (pd.actorName || '?') + '」决定是否破招……（60 秒后自动跳过）';
      pass.disabled = true;
      pass.textContent = '等 待 中';
      $('#pending-foot').textContent = '';
      return;
    }
    $('#pending-sub').textContent = '轮到你破招：可以打出一张牌，也可以跳过。后发先至 —— 后出手的先结算。';
    pass.disabled = !!S.busy;
    pass.textContent = '不 破 招 · 跳 过';
    var mine = pd.mine || [];
    if (!mine.length) {
      list.appendChild(noteBox('你此刻没有可以破招的牌（可能是它们已经用掉了）。'));
    }
    mine.forEach(function (c) {
      var def = cardDef(c.id);
      var btn = el('button', 'tier-opt');
      btn.type = 'button';
      btn.disabled = !!S.busy;
      // 花费由服务端算好（手牌看角标；场上的牌看效果自己印的 manaCost，如【温天仁】的 3 点）
      var cost = (c.cost != null) ? c.cost : ((def && def.cost) || 0);
      // 「二选一」类卡（【火弹术】）在服务端被展开成多条候选，每条带 tier + 选项文案：
      // 点哪条就是哪个效果（以前锁链里只有一条，另一半永远打不出来）。
      var isOpt = (typeof c.tier === 'number' && !!c.option);
      var desc = isOpt ? c.option : ((def && def.text) ? def.text : '');
      btn.innerHTML = '<span class="to-realm">' + (isOpt ? '选 项' : (c.where === 'board' ? '场上发动' : '手牌打出')) + '</span>' +
        '<span class="to-text">【' + escapeHtml(c.name) + '】' + (cost ? '（' + cost + ' 法力）' : '（0 法力）') + '</span>' +
        (desc ? '<span class="to-eff">' + escapeHtml(desc) + '</span>' : '') +
        // ⭐ 需要选目标的候选（【青冥针】）先明说一句，玩家点了才知道还要选人
        (c.needsTarget ? '<span class="to-eff">※ 需要选择目标：'
          + (c.targetKind === 'board' ? '场上的一张牌' : '任意一位修士') + '</span>' : '') +
        '<span class="to-pick">破 招</span>';
      btn.addEventListener('click', function () {
        var act = { type: 'respond_play', uid: c.uid };
        if (typeof c.tier === 'number') act.tier = c.tier;
        // ⭐ 这条候选要先选目标（【青冥针】"指定任意一位修士受到等额伤害"）：
        //    弹选择器 → 选完把 target/targetUid 一起发给服务端（引擎会校验缺目标的情况）。
        if (!c.needsTarget) { send(act); return; }
        openTargetPicker({
          kind: c.targetKind || 'player',
          title: '【' + c.name + '】—— 选择目标',
          onPick: function (o) {
            if (o.uid != null) act.targetUid = o.uid; else act.target = o.pid;
            send(act);
          },
        });
      });
      list.appendChild(btn);
    });
    if (pd.chain && pd.chain.length) {
      $('#pending-foot').textContent = '已入【斗法】：' + pd.chain.map(function (x) { return x.name; }).join(' → ') +
        '（后发先至，逆序收势：最后出手的先结算）';
    } else {
      $('#pending-foot').textContent = '';
    }
  }

  /** 特殊战报条目的醒目提示：祝贺词（§11）/ 闭关 / 晋升掷骰 */
  function handleSpecialEntries(entries) {
    if (!entries || !entries.length) return;
    entries.forEach(function (e) {
      if (e.kind === 'congrats') {
        // engine.js：晋升筑基期及以上时触发「祝贺词」，其他修士需起立道贺
        banner(String(e.text).replace(/^📣\s*祝贺词：/, '📣 '), 'congrats', 3800);
      } else if (e.kind === 'seclusion') {
        banner(e.text, 'cyan', 2400);
      } else if (e.kind === 'roll' && e.payload && e.payload.scope === 'promote') {
        var need = e.payload.need || 0;
        var got = e.payload.value || 0;
        banner('晋升掷骰：' + got + ' 点（需 ≥' + need + '）' + (e.payload.reroll ? ' · 重掷' : '') + (got >= need ? ' ✔' : ' ✘'),
          got >= need ? 'cyan' : 'bad', 2400);
      }
    });
  }

  /* ================================================================
   * 15.5 抽取动画：灵气牌 / 手牌「一张一张飞进来」
   *   触发信号：新增战报里 kind==='draw'（手牌）或 'qi_gain'（灵气牌）
   *             且 payload.player === 我，按 seq 去重、逐条排队播放。
   *   动画期间不阻塞操作（全部异步，飞行层 pointer-events:none）；
   *   prefers-reduced-motion 下直接跳过。
   * ================================================================ */

  var DrawFx = {
    queue: [],          // {type:'hand'|'qi', deck, card, extra}
    running: false,
    seen: {},           // seq|text -> 1（去重，避免同一帧/回退帧重复播放）
    seenOrder: [],
    MAX_QUEUE: 6,       // 同时排队上限，防止一次抽太多卡顿
    DUR: 340            // 单张飞行时长（ms），间隔 ≈ DUR + 收尾
  };

  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function drawFxKey(e) { return String(e.seq) + '|' + e.kind + '|' + String(e.text); }
  function drawFxSeen(key) {
    if (DrawFx.seen[key]) return true;
    DrawFx.seen[key] = 1;
    DrawFx.seenOrder.push(key);
    if (DrawFx.seenOrder.length > 240) { delete DrawFx.seen[DrawFx.seenOrder.shift()]; }
    return false;
  }

  /** 收集新增日志中「属于我」的抽牌事件（手牌 / 灵气牌），按 seq 去重后排入队列 */
  function drawFxObserve(entries) {
    if (!entries || !entries.length) return;
    var me = myId();
    if (!me) return;
    var extraChain = false;
    entries.forEach(function (e) {
      if (!e) return;
      var pay = e.payload || {};
      // 「【充裕灵气】生效：额外抽取 N 张灵气牌」之后紧跟的 qi_gain 属于连锁抽卡
      if (e.kind === 'info' && /额外抽取/.test(String(e.text))) { extraChain = true; return; }
      if (e.kind !== 'draw' && e.kind !== 'qi_gain') return;
      if (pay.player !== me) return;
      if (drawFxSeen(drawFxKey(e))) return;
      drawFxEnqueue(e.kind === 'qi_gain'
        ? { type: 'qi', deck: 'qi', card: pay.card || null, extra: extraChain }
        : { type: 'hand', deck: pay.deck || 'treasure', card: pay.card || null, extra: false });
    });
  }

  function drawFxEnqueue(ev) {
    if (reducedMotion()) return;                       // 用户在系统里关了动效
    if (DrawFx.queue.length >= DrawFx.MAX_QUEUE) return; // 排队过多就丢，避免卡顿
    DrawFx.queue.push(ev);
    if (!DrawFx.running) drawFxRun();
  }

  function drawFxRun() {
    DrawFx.running = true;
    (function next() {
      if (!DrawFx.queue.length) { DrawFx.running = false; return; }
      drawFxPlay(DrawFx.queue.shift()).then(next, next);
    })();
  }

  function drawFxDeckNode(deck) {
    return $('#deck-list .deck-row[data-deck="' + deck + '"]') || $('#deck-list');
  }
  function drawFxRect(node) {
    if (!node) return null;
    var r = node.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return null;
    return r;
  }

  /** 播放一张：从牌堆飞出 → 落到手牌区/灵气区 → 翻面 + 飘字 */
  function drawFxPlay(ev) {
    var W = ev.type === 'qi' ? 52 : 58;
    var H = ev.type === 'qi' ? 72 : 80;
    var meId = myId();
    var srcNode = drawFxDeckNode(ev.deck);
    var dstNode = ev.type === 'qi'
      ? ($('#me-grid > .board[data-pid="' + meId + '"] .qi-val') || $('#me-grid') || $('#foe-grid'))
      : ($('#hand-zone .hand-card:last-child') || $('#hand-zone'));
    var src = drawFxRect(srcNode), dst = drawFxRect(dstNode);

    var node = el('div', 'draw-fly ' + (ev.type === 'qi' ? 'qi-fly' : 'hand-fly') +
      ' deck-' + (ev.deck || 'qi') + (ev.extra ? ' chain' : ''));
    node.setAttribute('aria-hidden', 'true');
    // 便于调试/自动化取证：记录这次飞行属于哪一类、哪张牌
    node.dataset.ev = ev.type + ':' + (ev.card || ev.deck || '');
    node.innerHTML = '<span class="df-back"></span><span class="df-face">' +
      (ev.type === 'qi' ? '灵气' : String(cardName(ev.card))) + '</span>';
    node.style.width = W + 'px';
    node.style.height = H + 'px';
    document.body.appendChild(node);

    var x0 = src ? src.left + src.width / 2 - W / 2 : window.innerWidth / 2;
    var y0 = src ? src.top + src.height / 2 - H / 2 : window.innerHeight / 2;
    var x1 = dst ? dst.left + dst.width / 2 - W / 2 : window.innerWidth / 2;
    var y1 = dst ? dst.top + dst.height / 2 - H / 2 : window.innerHeight / 2;
    var midX = x0 + (x1 - x0) * 0.4, midY = Math.min(y0, y1) - 46;

    var done;
    if (node.animate) {
      // Web Animations API：零依赖，天然不阻塞主线程交互
      var anim = node.animate([
        { transform: 'translate(' + x0 + 'px,' + y0 + 'px) scale(.72) rotate(-10deg)', opacity: 0 },
        { transform: 'translate(' + midX + 'px,' + midY + 'px) scale(1.06) rotate(7deg)', opacity: 1, offset: 0.45 },
        { transform: 'translate(' + x1 + 'px,' + y1 + 'px) scale(1) rotate(0deg)', opacity: 1 }
      ], { duration: DrawFx.DUR, easing: 'cubic-bezier(.25,.9,.3,1)', fill: 'forwards' });
      node.style.transform = 'translate(' + x0 + 'px,' + y0 + 'px)';
      done = anim.finished ? anim.finished.catch(function () {}) : null;
    } else {
      node.style.transform = 'translate(' + x1 + 'px,' + y1 + 'px)';
      node.style.transition = 'transform ' + DrawFx.DUR + 'ms cubic-bezier(.25,.9,.3,1)';
      done = null;
    }

    return (done || sleep(DrawFx.DUR)).then(function () {
      node.style.transform = 'translate(' + x1 + 'px,' + y1 + 'px)';
      node.classList.add('arrived');            // 翻面：牌背 → 牌面
      if (ev.type === 'qi') {
        floatText(meId, '+1 灵气', 'qi');        // 落点飘字
      } else {
        var card = $('#hand-zone .hand-card:last-child');
        if (card) replayAnim(card, 'card-in');
      }
      return sleep(ev.extra ? 150 : 190);
    }).then(function () {
      node.remove();
    }, function () {
      node.remove();
    });
  }

  /* 阶段名（step）→ 中文，顶部横幅与操作区共用 */
  var STEP_LABEL = { draw_qi: '炼化灵气', draw_treasure: '探索取宝', choose_draw: '二选一抽牌', action: '行动阶段' };
  var STEP_LABEL_OTHER = { draw_qi: '炼化灵气中', draw_treasure: '探索取宝中', choose_draw: '二选一抽牌中', action: '行动中' };
  function stepLabel(step) { return STEP_LABEL[step] || '行动阶段'; }

  function renderDeckChips(st) {
    $('#tb-room').textContent = roomIdOf(st);
    $('#tb-round').textContent = '第 ' + (st.round || 1) + ' 轮';
    var me = myPlayer(st);
    $('#tb-me').textContent = me ? me.name : (S.session ? S.session.name : '我');
    var turnNode = $('#tb-turn');
    turnNode.dataset.step = String(st.step || '');
    turnNode.dataset.stage = (st.combat && st.combat.stage) ? st.combat.stage : '';
    if (st.phase === 'over') {
      var w = st.winner ? playerById(st, st.winner) : null;
      turnNode.textContent = w ? (w.name + ' 已成元婴') : '本局终了';
      turnNode.classList.remove('mine');
      turnNode.classList.add('warn');
      return;
    }
    turnNode.classList.remove('warn');
    // 对战中的阶段优先展示（两段式掷骰的中间态要让双方都知道轮到谁）
    var cs = st.combat && st.combat.stage;
    if (cs === 'pre') {
      turnNode.classList.add('warn');
      turnNode.textContent = '对战准备 · ' + (st.combat.attacker === (me && me.id) ? '等你掷骰（先攻）' : '等待发起方掷骰');
      return;
    }
    if (cs === 'roll_defender') {
      turnNode.classList.add('warn');
      turnNode.textContent = '先攻已投 · ' + (st.combat.defender === (me && me.id) ? '轮到你掷骰（应战）' : '等待应战方掷骰');
      return;
    }
    if (cs === 'tie') {
      turnNode.classList.add('warn');
      turnNode.textContent = '平局结算 · 双方各可出一张改变战力的牌';
      return;
    }
    if (cs === 'result') {
      turnNode.classList.add('warn');
      var mySide = me && (st.combat.winnerId === me.id ? 'win' : (st.combat.loserId === me.id ? 'lose' : null));
      turnNode.textContent = '对战结果 · ' + (mySide === st.combat.resultStep
        ? (st.combat.resultStep === 'win' ? '你赢了，可打「获胜时」的牌' : '你输了，可打「失败时」的牌')
        : (st.combat.resultStep === 'win' ? '等待获胜方结算' : '等待失败方结算'));
      return;
    }
    if (me && st.turn === me.id) {
      turnNode.textContent = '轮到你 · ' + stepLabel(st.step);
      turnNode.classList.add('mine');
    } else {
      turnNode.classList.remove('mine');
      turnNode.textContent = '轮到 ' + playerName(st, st.turn) + ' · ' + (STEP_LABEL_OTHER[st.step] || '行动中');
    }
  }

  function renderConnect(ok) {
    var node = $('#tb-conn');
    if (!node) return;
    node.classList.toggle('bad', !ok);
    node.lastChild && (node.lastChild.textContent = ok ? '已连接' : '重连中');
  }

  function closeStream() {
    if (S.es) { try { S.es.close(); } catch (e) { /* 忽略 */ } S.es = null; }
  }

  /**
   * 弃牌堆查看：所有玩家随时可看（公开信息）。
   * 数据从 /api/discard 现取，不进 SSE 推流，避免每次状态更新都带上几十张牌。
   */
  /**
   * 弃牌堆里的一张「详细卡」—— 信息和手牌一样全（角标法力 / 牌堆·类型 / 牌名 /
   * 境界或占位 / 完整卡文），只是不带"现在能不能打"那套状态。
   * 同名牌在弃牌堆里可能有几十张，所以由调用方传张数 n，右上角用 ×N 标出来。
   * 点一下仍然打开全文详情弹窗。
   * 全部用 el() 拼（=textContent），不走 innerHTML，天然不怕注入。
   */
  function discardCardNode(id, n) {
    var def = cardDef(id);
    var btn = el('button', 'discard-card');
    btn.type = 'button';
    if (!def) {
      btn.textContent = id;
      btn.addEventListener('click', function () { openCardModal(id, ''); });
      return btn;
    }
    var deck = deckOf(id);
    var type = cardType(def);

    var top = el('span', 'dc-top');
    top.appendChild(el('span', 'dc-cost' + (typeof def.cost === 'number' && def.cost > 0 ? '' : ' free'),
      (typeof def.cost === 'number') ? String(def.cost) : '—'));
    top.appendChild(el('span', 'dc-name', def.name));
    if (n > 1) top.appendChild(el('span', 'dc-num', '×' + n));
    btn.appendChild(top);

    btn.appendChild(el('span', 'dc-tag', DECK_NAME[deck] + ' · ' + (CARD_TYPE_NAME[type] || '')));

    var sub;
    if (type === 'companion') {
      var absorb = def.absorb ? (def.absorb === true ? 1 : def.absorb) : 0;
      sub = '无境界限制 · 占 ' + companionSlotCost(def) + ' 位'
        + (absorb ? ' · 可替你承受 ' + absorb + ' 次伤害' : ' · 不替挡');
    } else if (type === 'equip') {
      sub = realmRequirement(def) + ' · ' + (isTieredEquip(def) ? '多档法术装备' : '装备类宝物');
    } else {
      sub = realmRequirement(def);
    }
    btn.appendChild(el('span', 'dc-sub', sub));
    btn.appendChild(el('span', 'dc-text', def.text || ''));

    btn.addEventListener('click', function () { openCardModal(id, ''); });
    return btn;
  }

  function openDiscardViewer() {
    if (!S.session) { toast('还没入席', 'err'); return; }
    var url = '/api/discard?roomId=' + encodeURIComponent(S.session.roomId) +
      '&playerId=' + encodeURIComponent(S.session.playerId) +
      '&token=' + encodeURIComponent(S.session.token);
    var body = $('#discard-body');
    body.innerHTML = '<p class="muted">读取中……</p>';
    $('#discard-modal').classList.remove('hidden');
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || data.error) { body.innerHTML = '<p class="discard-empty">读取失败：' + escapeHtml((data && data.error) || '未知错误') + '</p>'; return; }
      body.innerHTML = '';
      var any = false;
      DECK_LIST.forEach(function (deck) {
        var ids = data[deck] || [];
        if (!ids.length) return;
        any = true;
        // 同名牌合并：弃牌堆里【稀薄灵气】可能有十几张，一张一条没法看
        var order = [], count = {};
        ids.forEach(function (id) {
          if (count[id] === undefined) { count[id] = 0; order.push(id); }
          count[id]++;
        });
        var group = el('section', 'discard-group');
        var h = el('h4');
        h.appendChild(document.createTextNode(DECK_NAME[deck] + '牌堆弃牌'));
        h.appendChild(el('span', 'dgc-num',
          '共 ' + ids.length + ' 张 · ' + order.length + ' 种'));
        group.appendChild(h);
        var grid = el('div', 'discard-grid');
        order.forEach(function (id) { grid.appendChild(discardCardNode(id, count[id])); });
        group.appendChild(grid);
        body.appendChild(group);
      });
      if (!any) body.innerHTML = '<p class="discard-empty">四个弃牌堆目前都是空的。</p>';
    }).catch(function () {
      body.innerHTML = '<p class="discard-empty">读取失败，请稍后重试。</p>';
    });
  }

  function openStream() {
    closeStream();
    if (!S.session) return;
    var url = '/api/stream?roomId=' + encodeURIComponent(S.session.roomId) +
      '&playerId=' + encodeURIComponent(S.session.playerId) +
      '&token=' + encodeURIComponent(S.session.token);
    var es = new EventSource(url);
    S.es = es;
    es.onopen = function () { renderConnect(true); };
    es.onmessage = function (ev) {
      var data = null;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data && typeof data === 'object') onState(data);
    };
    es.onerror = function () { renderConnect(false); };
  }

  /* ---------------- 启动：自动重连 ---------------- */

  /**
   * 启动时的"回到自己的座位"。
   *
   * `force` = 玩家在大厅明确点了「仍要进入」—— 那时允许接管一个**另一个窗口正坐着**的座位
   * （默认不接管：两个窗口坐成同一个人 = 谁赢都显示"我方胜利"，用户 2026-10-06 报的就是这个）。
   */
  function resumeSession(force) {
    var held = force ? null : Session.loadHeldElsewhere();
    if (held) {
      S.session = held;                       // 只为把「仍要进入」按钮画出来（不连、不占座位）
      setView('lobby');
      renderLobby();
      lobbyNotice('这个浏览器里**另一个窗口**正坐在「<b>' + escapeHtml(held.name) +
        '</b>」这个座位上（房间 ' + escapeHtml(held.roomId) + '）。' +
        '想把本窗口当第二个玩家：直接在上面取个道号、点「加入房间」即可（**每个窗口各记各的座位**）。' +
        '如果那个窗口已经不在了，点下面的「仍要进入」。');
      return Promise.resolve(false);
    }
    var s = Session.load();
    if (!s) { setView('lobby'); renderLobby(); return Promise.resolve(false); }
    S.session = s;
    return apiJoinBack(s).then(function (res) {
      S.session = { roomId: res.roomId, playerId: res.playerId, token: res.token, name: res.name };
      Session.save(S.session);
      $('#input-name').value = res.name || '';
      toast('已回到房间 ' + res.roomId + ' 的座位', 'ok');
      openStream();
      return true;
    }).catch(function (e) {
      Session.clear();
      S.session = null;
      setView('lobby');
      renderLobby();
      toast('自动重连失败：' + (e.message || '房间已失效'), 'err');
      return false;
    });
  }

  function bindEvents() {
    // 大厅
    $('#btn-create').addEventListener('click', function () {
      var name = ($('#input-name').value || '').trim();
      if (!name) { toast('请先取个道号', 'err'); $('#input-name').focus(); return; }
      apiCreate(name).then(function (res) {
        S.session = { roomId: res.roomId, playerId: res.playerId, token: res.token, name: res.name };
        Session.save(S.session);
        lobbyNotice('');
        toast('房间已开：' + res.roomId, 'ok');
        setView('room');
        renderRoom(null);
        openStream();
      }).catch(function (e) { toast(e.message, 'err'); });
    });

    $('#btn-join').addEventListener('click', function () {
      var name = ($('#input-name').value || '').trim();
      var room = ($('#input-room').value || '').trim().toUpperCase();
      if (!name) { toast('请先取个道号', 'err'); return; }
      if (!/^[A-Z0-9]{4}$/.test(room)) { toast('房间码为 4 位字母或数字', 'err'); return; }
      apiJoinNew(room, name).then(function (res) {
        S.session = { roomId: res.roomId, playerId: res.playerId, token: res.token, name: res.name };
        Session.save(S.session);
        lobbyNotice('');
        setView('room');
        renderRoom(null);
        openStream();
      }).catch(function (e) { toast(e.message, 'err'); });
    });

    $('#btn-reconnect').addEventListener('click', function () {
      // 大厅那个按钮是**明确表态**：允许接管一个正被别的窗口坐着的座位（见 resumeSession 的说明）
      lobbyNotice('');
      resumeSession(true);
    });

    // 关窗口 / 刷新：把"这个座位有人坐着"的心跳让出来（刷新的话本窗口马上会重新认领）
    window.addEventListener('pagehide', function () { releaseSeat(); });

    $('#input-room').addEventListener('input', function (ev) {
      ev.target.value = ev.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    $('#input-room').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('#btn-join').click(); });
    $('#input-name').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') $('#btn-create').click(); });

    // 房间
    $('#btn-copy-room').addEventListener('click', function () { copyText(roomIdOf(S.state)); });
    $('#btn-copy-room-tb').addEventListener('click', function () { copyText(roomIdOf(S.state)); });

    $('#btn-start').addEventListener('click', function () {
      if (!S.session) return;
      apiStart(S.session).then(function () { toast('仙门已开！', 'ok'); })
        .catch(function (e) { toast(e.message, 'err'); });
    });

    $('#btn-leave-room').addEventListener('click', doLeave);
    $('#btn-leave').addEventListener('click', doLeave);

    // 牌桌交互（事件委托）
    $('#hand-zone').addEventListener('click', function (ev) {
      var card = ev.target.closest ? ev.target.closest('.hand-card') : null;
      if (!card) return;
      onHandCardClick(card.dataset.uid, S.state);
    });

    // ⭐ ②c：**手牌拖到牌桌才打出**（点击照旧能打，移动端/无障碍都靠点击）。
    //   拖起来 → 牌桌高亮；松手在牌桌上 = 打出（要选目标的牌会接着弹选人，与点击同一条流程）；
    //   松手在自己的手牌区或牌桌外 = 取消。
    document.addEventListener('dragstart', onHandDragStart);
    document.addEventListener('dragend', onHandDragEnd);
    (function () {
      var table = $('#view-table');
      if (!table) return;
      table.addEventListener('dragover', function (ev) {
        if (S.dragUid == null) return;
        ev.preventDefault();                       // 不 preventDefault 就不允许放下
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        var onHand = ev.target.closest && ev.target.closest('#hand-zone');
        document.body.classList.toggle('drag-cancel', !!onHand);   // 丢回手牌 = 取消，给个视觉反馈
      });
      table.addEventListener('drop', function (ev) {
        if (S.dragUid == null) return;
        var onHand = ev.target.closest && ev.target.closest('#hand-zone');
        var uid = S.dragUid;
        S.dragUid = null;
        document.body.classList.remove('dragging-card', 'drag-cancel');
        if (onHand) { toast('丢回手牌＝取消（想打出就丢到牌桌上）', 'info'); return; }
        ev.preventDefault();
        onHandCardClick(uid, S.state);
      });
      table.addEventListener('dragleave', function () {
        document.body.classList.remove('drag-cancel');
      });
    })();

    // 两块面板区（敌方在上 / 我方在下）都用同一套委托
    $('.table-main').addEventListener('click', function (ev) {
      var card = ev.target.closest ? ev.target.closest('.board') : null;
      if (!card) return;
      var chip = ev.target.closest('.eq-chip');
      if (chip && chip.dataset.cardId) { openCardModal(chip.dataset.cardId, '', { uid: chip.dataset.uid, ownerId: card.dataset.pid }); return; }
      onPlayerCardClick(card.dataset.pid);
    });

    $('#btn-cancel-target').addEventListener('click', cancelTargeting);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        cancelTargeting();
        S.discardMode = false;
        if (S.state) { renderActionBar(S.state); renderHand(S.state); }
        $('#card-modal').classList.add('hidden');
        $('#help-modal').classList.add('hidden');
      }
    });

    // 弹窗
    $('#btn-help').addEventListener('click', function () { $('#help-modal').classList.remove('hidden'); });
    $('#btn-hand-help').addEventListener('click', function () { $('#help-modal').classList.remove('hidden'); });
    $('#help-close').addEventListener('click', function () { $('#help-modal').classList.add('hidden'); });
    $('#card-modal-close').addEventListener('click', function () { $('#card-modal').classList.add('hidden'); });
    $('#btn-view-discard').addEventListener('click', openDiscardViewer);
    $('#discard-modal-close').addEventListener('click', function () { $('#discard-modal').classList.add('hidden'); });
    // 时点询问弹窗故意不给关闭/点背景关闭：不表态就没法继续
    $('#btn-pending-pass').addEventListener('click', function () { send({ type: 'respond_pass' }); });
    [$('#help-modal'), $('#card-modal'), $('#discard-modal')].forEach(function (ov) {
      ov.addEventListener('click', function (ev) { if (ev.target === ov) ov.classList.add('hidden'); });
    });

    // 结算
    $('#btn-again').addEventListener('click', function () {
      if (!S.session) return;
      apiAgain(S.session).then(function () { toast('新的一局，聚灵再来。', 'ok'); })
        .catch(function (e) { toast(e.message, 'err'); });
    });

    // 离开 → 断开推送但保留座位凭证
    window.addEventListener('beforeunload', closeStream);
  }

  function doLeave() {
    closeStream();
    S.state = null;
    S.logPrev = [];
    S.stats = {};
    S.seenHand = {};
    S.targeting = null;
    $('#log-list').innerHTML = '';
    $('#combat-overlay').classList.add('hidden');
    $('#over-overlay').classList.add('hidden');
    setView('lobby');
    renderLobby();
    toast('已断开推送；凭证仍在，可点「回到牌桌」继续。', 'info');
  }

  function boot() {
    bindEvents();
    bindHandZoom();      // 手牌悬停放大镜（触屏不绑）
    buildDeckRows();
    initCombatArena();
    renderConnect(false);
    loadMeta();          // 效果标签的唯一来源（服务端 effect-meta），拉不到才回退
    loadCards();
    resumeSession();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})();
