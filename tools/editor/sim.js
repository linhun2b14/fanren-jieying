'use strict';
/**
 * 卡牌编辑器 · **效果模拟沙盒**（服务端跑引擎，无状态、可重放）
 *
 * 用户要的用法（2026-10-05）：
 *   "挑选任意阶段、任意手牌、任意生命法力，以及对手所要发动的手牌或者场上效果。"
 *
 * 设计要点：
 *   · **无状态**：每次请求都从零建局 → 应用 setup → 依次执行 actions → 返回 trace。
 *     前端把动作存成一个数组，点一次按钮就 append 一条再整体重放，所以"撤销/回看"天然成立，
 *     服务端也不用记会话。同一个 seed 每次都跑出同样的结果。
 *   · **用界面上那份卡池**：请求体可以带 `cards`（编辑器里的 S.pool，可能还没存盘），
 *     走 `cards.setPool()` 注入 —— 改完一张卡立刻能试效果，不必先过存盘闸门。
 *   · 卡牌在动作里用**牌名**引用（`card: '补气丹'`），uid 由服务端按固定规则分配（在 hand 里先找、
 *     再找场上），省得前端管 uid；返回 `instances` 供前端展示。
 *
 * ⚠️ 这是**开发者工具**，只读地建局、不进线上房间、不写任何文件。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'server', 'cards.js'));
const E = require(path.join(ROOT, 'server', 'engine.js'));

const DECK_CN = { treasure: '宝物牌堆', spell: '法术牌堆', companion: '同行者牌堆', qi: '灵气牌堆' };
const UID_BASE = { hand: 1000, equip: 2000, spells: 3000, companions: 4000, puppets: 5000 };

/** 阶段（state.step）：晋升/对战/投骰不是阶段，是行动阶段里的动作 */
const STEPS = [
  { key: 'draw_qi', label: '抽取灵气牌阶段' },
  { key: 'draw_treasure', label: '探索阶段（抽宝物牌）' },
  { key: 'choose_draw', label: '抉择阶段' },
  { key: 'action', label: '行动阶段（出牌 / 晋升 / 发起对战 / 投骰都在这）' },
  { key: 'seclusion', label: '闭关阶段' },
];

/** 允许的动作白名单：label 给界面的按钮/下拉用；needs: card=要指定一张牌，target=要指定对手 */
const ACTIONS = [
  { key: 'play', label: '打出 / 装备一张手牌', needs: 'card', target: 'optional' },
  { key: 'respond_play', label: '破招打出 / 发动（窗口开着时）', needs: 'card', window: true },
  { key: 'respond_pass', label: '放弃（不破招 / 跳过这个时点）', needs: null, window: true },
  { key: 'promote', label: '晋升', needs: null },
  { key: 'combat', label: '发起对战', needs: null, target: 'required' },
  { key: 'roll', label: '投掷骰子', needs: null },
  { key: 'draw_qi', label: '抽灵气牌', needs: null },
  { key: 'draw_treasure', label: '抽宝物牌（探索）', needs: null },
  { key: 'choose_draw', label: '抉择：选一个牌堆', needs: null, deck: true },
  { key: 'seclusion', label: '闭关', needs: null },
  { key: 'discard', label: '弃置一张手牌（手牌超上限时）', needs: 'card' },
  { key: 'dismiss', label: '撤下一张场上的牌', needs: 'card' },
  { key: 'activate', label: '发动场上牌的主动效果', needs: 'card' },
  { key: 'end_turn', label: '结束回合', needs: null },
];

const MAX_ACTIONS = 60;
const DEFAULT_SEED = 20261005;

const clamp = (v, lo, hi, dflt) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(n)));
};

/** 牌名 → 卡定义；同时报出重名的堆 */
function nameIndex() {
  const m = new Map();
  const dup = [];
  for (const d of C.DECKS) {
    for (const c of C.cards()[d]) {
      if (m.has(c.name)) { dup.push(c.name); continue; }
      m.set(c.name, { def: c, deck: d });
    }
  }
  return { m, dup };
}

function mkInstance(seq, id) { return { uid: seq, id: id }; }

/**
 * 跑一个场景。
 * @param body { cards?, seed?, turn?, step?, turnFlags?, plainQi?, players:{a,b}, actions? }
 */
function runScenario(body) {
  const b = body || {};
  // ① 卡池：带 cards 就用界面上的那份（可能未存盘），否则回落到磁盘
  C.setPool(b.cards || null);
  const { m: byName, dup } = nameIndex();

  const setup = b.players || {};
  const seed = clamp(b.seed == null ? DEFAULT_SEED : b.seed, 1, 2147483646, DEFAULT_SEED);
  const turn = clamp(b.turn, 0, 1, 0);
  const step = STEPS.some((s) => s.key === b.step) ? b.step : 'action';

  // ② 建局（与单测同一套造局手法）
  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: seed });
  E.beginGame(st);
  for (const q of st.players) q.turnsTaken = 2;   // 关掉"第一个回合不能发起对战"的闸门（沙盒不该被它挡）
  st.turn = turn;
  st.step = step;
  const tf = b.turnFlags || {};
  st.turnFlags = { combat: !!tf.combat, promote: !!tf.promote };

  // ③ 清空随机发的牌，再按设置摆牌
  const unknown = [];
  const seq = { hand: UID_BASE.hand, equip: UID_BASE.equip, spells: UID_BASE.spells, companions: UID_BASE.companions, puppets: UID_BASE.puppets };
  const instances = { a: { hand: [], equip: [], spells: [], companions: [], puppets: [] }, b: { hand: [], equip: [], spells: [], companions: [], puppets: [] } };
  const raw = ['treasure', 'spell', 'companion', 'qi'];
  for (const pl of st.players) {
    pl.hand = []; pl.equip = []; pl.spells = []; pl.companions = []; pl.puppets = []; pl.qiCards = [];
  }
  for (const pid of ['a', 'b']) {
    const pl = st.players.find((x) => x.id === pid);
    const cfg = setup[pid] || {};
    pl.realm = clamp(cfg.realm, 0, 4, 0);
    pl.hp = clamp(cfg.hp, 0, E.HP_MAX, E.HP_MAX);
    pl.mana = clamp(cfg.mana, 0, E.manaCap(pl), 1);
    const qiN = clamp(cfg.qi, 0, 60, 0);
    const qiDef = byName.get('稀薄灵气') || { def: C.cards().qi[0] };
    for (let i = 0; i < qiN && qiDef && qiDef.def; i++) pl.qiCards.push(mkInstance(6000 + i, qiDef.def.id));
    for (const slot of ['hand', 'equip', 'spells', 'companions', 'puppets']) {
      for (const nm of (cfg[slot] || [])) {
        const hit = byName.get(nm);
        if (!hit) { if (unknown.indexOf(nm) < 0) unknown.push(nm); continue; }
        const inst = mkInstance(++seq[slot], hit.def.id);
        if (slot === 'hand') pl.hand.push(inst);
        else if (slot === 'equip') pl.equip.push(inst);
        else if (slot === 'spells') pl.spells.push(inst);
        else if (slot === 'companions') pl.companions.push(inst);
        else pl.puppets.push(inst);
        instances[pid][slot].push({ name: hit.def.name, uid: inst.uid, deck: hit.deck });
      }
    }
  }
  // 灵气牌堆：默认换成纯【稀薄灵气】，抽灵气不连锁（要用真牌堆就把 plainQi 关掉）
  if (b.plainQi !== false) {
    const plain = byName.get('稀薄灵气');
    if (plain) st.decks.qi.draw = st.decks.qi.draw.map(() => plain.def.id);
  }
  // 骰点注入（引擎现成的测试注入点 `state.forcedDice`，见 d6）：测掷骰类效果时把结果钉住，
  // 否则同一个场景每次掷出来的点数都不一样、没法复现。按 FIFO 逐个取用，取完回到真随机。
  const forced = Array.isArray(b.forcedDice) ? b.forcedDice.map((x) => Number(x)).filter((x) => x >= 1 && x <= 6) : [];
  if (forced.length) st.forcedDice = forced.slice();
  if (unknown.length) {
    return { ok: false, error: '卡池里没有这些牌：' + unknown.join('、') + '（名字要与卡池完全一致）' };
  }

  // ④ 依次执行动作，逐条留痕
  const actions = Array.isArray(b.actions) ? b.actions.slice(0, MAX_ACTIONS) : [];
  const trace = [];
  const logStart = st.log.length;
  let stopped = null;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i] || {};
    const pid = a.player === 'b' ? 'b' : 'a';
    const pl = st.players.find((x) => x.id === pid);
    const act = Object.assign({}, a.action || {});
    const label = actLabel(pid, act, pl, byName);
    // 牌名 → uid（hand 优先，其次场上）
    if (act.card) {
      const uid = findUid(pl, act.card, byName);
      if (!uid) {
        trace.push({ i: i, player: pid, label: label, result: { ok: false, error: `【${act.card}】不在 ${pl.name} 的手牌/场上` } });
        stopped = '找不到牌，后面的动作没继续';
        break;
      }
      delete act.card;
      act.uid = uid;
    }
    let result;
    try { result = E.act(st, pid, act); } catch (err) { result = { ok: false, error: '引擎抛错：' + (err && err.message) }; }
    trace.push({ i: i, player: pid, label: label, result: result || { ok: true } });
    if (!result || result.ok === false) { stopped = '第 ' + (i + 1) + ' 步失败，后面的动作没继续'; break; }
    if (st.phase !== 'playing') { stopped = '对局已结束（' + st.phase + '）'; break; }
  }

  return {
    ok: true,
    meta: { steps: STEPS, actions: ACTIONS, seed: seed, maxActions: MAX_ACTIONS },
    error: null,
    stopped: stopped,
    instances: instances,
    trace: trace,
    log: st.log.slice(logStart).map((l) => ({ kind: l.kind, text: l.text })),
    logAll: st.log.map((l) => ({ kind: l.kind, text: l.text })),
    state: viewState(st, byName),
  };
}

/** 动作的中文描述（给 trace 用） */
function actLabel(pid, act, pl, byName) {
  const who = pl ? pl.name : pid;
  const card = act.card ? `【${act.card}】` : '';
  const tgt = act.target ? ` → ${act.target === 'a' ? '甲' : '乙'}` : '';
  const map = {
    play: '打出 / 装备' + card,
    respond_play: '破招打出 / 发动' + card,
    respond_pass: '放弃（不破招）',
    promote: '晋升',
    combat: '发起对战',
    roll: '投掷骰子',
    draw_qi: '抽灵气牌',
    draw_treasure: '抽宝物牌',
    choose_draw: '抉择抽牌' + (act.deck ? '（' + (DECK_CN[act.deck] || act.deck) + '）' : ''),
    seclusion: '闭关',
    discard: '弃置' + card,
    dismiss: '撤下' + card,
    activate: '发动' + card,
    end_turn: '结束回合',
  };
  return who + ' ' + (map[act.type] || act.type) + tgt;
}

/** 在该玩家的手牌 / 场上按牌名找 uid（hand 优先） */
function findUid(pl, name, byName) {
  const hit = byName.get(name);
  if (!hit) return null;
  const pools = [pl.hand, pl.equip, pl.spells, pl.companions, pl.puppets || []];
  for (const pool of pools) {
    const inst = pool.find((x) => x.id === hit.def.id);
    if (inst) return inst.uid;
  }
  return null;
}

/** 给前端的状态快照（比 publicState 更全：含对手手牌、场上牌名） */
function viewState(st, byName) {
  const cache = new Map();
  const finder = (id) => {
    if (cache.has(id)) return cache.get(id);
    let out = null;
    for (const d of C.DECKS) {
      const hit = C.cards()[d].find((c) => c.id === id);
      if (hit) { out = hit; break; }
    }
    cache.set(id, out);
    return out;
  };
  const nm = (id) => (finder(id) || {}).name || id;
  const names = (arr) => arr.map((x) => nm(x.id));
  return {
    phase: st.phase,
    round: st.round,
    turn: st.players[st.turn] ? st.players[st.turn].id : null,
    step: st.step,
    turnFlags: st.turnFlags,
    players: st.players.map((pl) => ({
      id: pl.id, name: pl.name, realm: pl.realm, root: pl.root,
      hp: pl.hp, hpMax: E.HP_MAX, mana: pl.mana, manaCap: E.manaCap(pl),
      qi: E.qiOf(pl), out: !!pl.out, turnsTaken: pl.turnsTaken,
      hand: names(pl.hand), equip: names(pl.equip), spells: names(pl.spells),
      companions: names(pl.companions), puppets: names(pl.puppets || []),
      handCount: pl.hand.length,
    })),
    combat: st.combat ? {
      stage: st.combat.stage, attacker: st.combat.attacker, defender: st.combat.defender,
      winnerId: st.combat.winnerId || null, loserId: st.combat.loserId || null,
      dice: st.combat.dice || {}, bonus: st.combat.bonus || {}, diceBonus: st.combat.diceBonus || {},
    } : null,
    pending: st.pending ? {
      event: st.pending.event, phase: st.pending.phase || null,
      actor: E.pendingActor(st) ? E.pendingActor(st).id : null,
      actorName: E.pendingActor(st) ? E.pendingActor(st).name : null,
      queue: st.pending.queue.slice(),
      candidates: (function () {
        const who = E.pendingActor(st);
        if (!who) return [];
        try {
          return E.pendingCards(st, who).map((c) => ({ name: c.name, where: c.where, tier: c.tier, option: c.option || null }));
        } catch (e) { return []; }
      })(),
    } : null,
    forceDiscard: st.forceDiscard ? { playerId: st.forceDiscard.playerId, need: st.forceDiscard.need } : null,
  };
}

module.exports = { runScenario, STEPS, ACTIONS };
