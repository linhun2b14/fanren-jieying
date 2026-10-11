'use strict';
// 两个修复的回归测试：
//   A. 字符串 uid 兼容（前端 dataset.uid 恒为字符串，曾导致所有手牌操作被拒）
//   B. 越级装备漏洞（凡人不该在对战阶段装备高境界法宝）
const BASE = process.env.BASE || 'http://127.0.0.1:8094';

async function post(p, b) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => ({})) }; };

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
let skipCount = 0;
/** 「条件不成立 → 这条没什么可验」的断言走 skip()：**只记录、不计入通过数**
 *  （以前写成 `check(名, true)`，永远通过，把"通过数"撑虚高了 —— 交接 §5.2 的老欠账）。 */
const skip = (n, why) => { skipCount++; console.log('  ⊘ ' + n + (why ? '  << ' + why : '')); };

(async () => {
  console.log('BASE =', BASE);
  const seats = [];
  const a = await post('/api/create', { name: '甲' });
  seats.push(a.body);
  for (const n of ['乙', '丙', '丁']) seats.push((await post('/api/join', { roomId: a.body.roomId, name: n })).body);
  await post('/api/start', seats[0]);

  const view = async (s) => (await get(`/api/state?roomId=${a.body.roomId}&playerId=${s.playerId}&token=${s.token}`)).body;
  const seatOf = (pid) => seats.find((s) => s.playerId === pid);

  /** 把当前玩家的回合推进到行动阶段（现在要依次走 draw_qi → draw_treasure → choose_draw）
   *  viewer = 用哪个座位的视角读状态（要读自己的手牌就必须用自己座位） */
  async function advanceToAction(v, viewer) {
    const vw = viewer || seats[0];
    for (let i = 0; i < 8; i++) {
      if (v.combat || v.step === 'action') return v;
      const s = seatOf(v.turn);
      let act = null;
      if (v.step === 'draw_qi') act = { type: 'draw_qi' };
      else if (v.step === 'draw_treasure') act = { type: 'draw_treasure' };
      else if (v.step === 'choose_draw') act = { type: 'choose_draw', deck: 'spell' };
      else return v;
      await post('/api/action', { roomId: a.body.roomId, playerId: s.playerId, token: s.token, action: act });
      v = await view(vw);
    }
    return v;
  }

  let v = await view(seats[0]);
  console.log('\n[A] 字符串 uid 兼容');
  const cur = seatOf(v.turn);
  let cv = await view(cur);
  let me = cv.players.find((p) => p.id === v.turn);
  console.log(`  当前行动方 ${me.name}，手牌 ${me.handCount} 张，step=${cv.step}`);

  // 进入行动阶段（用当前玩家自己的视角，才能读到自己的 hand）
  cv = await advanceToAction(cv, cur);
  me = cv.players.find((p) => p.id === v.turn);
  const uidNum = me.hand && me.hand[0] ? me.hand[0].uid : null;
  console.log(`  取一张手牌 uid = ${uidNum}（${typeof uidNum}）`);
  check('state 里手牌 uid 是数字', typeof uidNum === 'number', typeof uidNum);

  // 用户裁定（2026-10-02）：**没有"主动弃置手牌"这个动作了** —— 弃牌只剩
  // ① 卡片效果 ② 回合结束时的那一次判定。
  // 这条规则由 tests/hand-limit-test.js [I] 在"确定没有 forceDiscard"的环境里守着；
  // 这里只保留"不存在的 uid 一律被拒"，避免和那个测试重复（本测试的流程可能正处在回合结束判定中）。
  const bogus = await post('/api/action', {
    roomId: a.body.roomId, playerId: cur.playerId, token: cur.token,
    action: { type: 'discard', uid: '999999' },
  });
  check('不存在的 uid 一律被拒', bogus.status === 400, JSON.stringify(bogus.body));

  console.log('\n[B] 越级装备漏洞');
  // 规则：每个人的第一个回合不能发起对战 —— 一直过回合，直到当前行动方已经轮到过 2 次
  for (let guard = 0; guard < 8; guard++) {
    let vv = await view(seats[0]);
    const curP = vv.players.find((p) => p.id === vv.turn);
    if (curP && curP.turnsTaken >= 2) break;
    const who = seatOf(vv.turn);
    vv = await advanceToAction(vv, who);
    const rr = await post('/api/action', {
      roomId: a.body.roomId, playerId: who.playerId, token: who.token, action: { type: 'end_turn' },
    });
    if (rr.status !== 200) console.log('  （过回合被拒：' + JSON.stringify(rr.body) + '）');
  }
  {
    const vv = await view(seats[0]);
    const curP = vv.players.find((p) => p.id === vv.turn);
    console.log(`  当前行动方 ${curP.name}，已轮到过 ${curP.turnsTaken} 次（≥2 可发起对战）`);
  }
  // 让甲向乙发起对战；乙是凡人，试图在对战准备阶段装备高境界法宝
  let v2 = await view(seats[0]);
  const iA = v2.players.findIndex((p) => p.id === v2.turn);
  const A = v2.players[iA];
  const B = v2.players.find((p) => p.id !== A.id);

  // 甲先进入行动阶段
  v2 = await advanceToAction(v2);
  if (v2.step !== 'action') throw new Error('没能推进到行动阶段: ' + v2.step);
  const rc = await post('/api/action', {
    roomId: a.body.roomId, playerId: A.id, token: seatOf(A.id).token, action: { type: 'combat', target: B.id },
  });
  check('甲发起对战成功', rc.status === 200, JSON.stringify(rc.body));

  // 把一张高境界装备塞给乙（模拟它手里正好有），然后让乙在对战中打出
  const bv = await view(seatOf(B.id));
  const bMe = bv.players.find((p) => p.id === B.id);
  console.log(`  乙: 境界=${bMe.realmName} 法力=${bMe.mana} 手牌=${bMe.handCount}`);
  const highEquip = bMe.hand && bMe.hand.find((c) => /xuantian_zhanling_sword|fenmo_dugong|yuancishen_shan/.test(c.id));
  if (!highEquip) {
    console.log('  乙手上没有高境界法宝，跳过（改用引擎级断言）');
    skip('乙（凡人）手上无高境界法宝时该分支不适用');
  } else {
    const bad = await post('/api/action', {
      roomId: a.body.roomId, playerId: B.id, token: seatOf(B.id).token, action: { type: 'play', uid: highEquip.uid },
    });
    check(`凡人不能在战斗阶段装备【${highEquip.id}】`, bad.status === 400 && /才能装备/.test(JSON.stringify(bad.body)),
      JSON.stringify(bad.body));
  }

  console.log('\n[B2] 引擎级：三个分支都必须过境界闸');
  const E = require('../server/engine');
  const C = require('../server/cards');
  const st = E.createGame([{ id: 'x', name: '甲', host: true }, { id: 'y', name: '乙' }], { seed: 5150 });
  E.beginGame(st);
  const P = st.players[0], Q = st.players[1];
  const def = ['treasure', 'spell'].reduce((a, d) => a.concat(C.cards()[d]), [])
    .find((c) => c.type === 'equip' && (c.realm || 0) >= 2);
  if (!def) throw new Error('卡池缺少高境界装备');
  P.realm = 0; P.hand = [{ uid: 4242, id: def.id }];

  // 分支1：自己回合
  st.turn = 0; st.step = 'action'; st.combat = null;
  check(`凡人自己回合装不了【${def.name}】`, E.act(st, P.id, { type: 'play', uid: 4242 }).ok === false);
  // 分支2：对战准备阶段（旧漏洞所在）
  st.combat = { attacker: P.id, defender: Q.id, stage: 'pre', bonus: {}, debuff: {}, dice: {}, diceBonus: {}, total: {}, tieUsed: {}, tiePassed: {}, cancelled: false };
  const r2 = E.act(st, P.id, { type: 'play', uid: 4242 });
  check(`凡人不能在对战准备阶段装【${def.name}】（旧漏洞）`, r2.ok === false, JSON.stringify(r2));
  // 分支3：平局阶段
  st.combat.stage = 'tie';
  const r3 = E.act(st, P.id, { type: 'play', uid: 4242 });
  check(`凡人不能在平局阶段装【${def.name}】`, r3.ok === false, JSON.stringify(r3));
  // 对照：满足境界就放行（高境界装备还需付得起角标法力）
  P.realm = 4;
  P.mana = 12;
  st.combat = null; st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
  P.hand = [{ uid: 4242, id: def.id }];
  P.equip = []; P.spells = [];
  const r4 = E.act(st, P.id, { type: 'play', uid: 4242 });
  check(`元婴期且法力充足可以装备【${def.name}】`, r4.ok === true, JSON.stringify(r4));

  // 对照：境界够了但付不起法力 → 仍应被拒（高境界装备的口径）
  P.equip = []; P.spells = []; P.hand = [{ uid: 4243, id: def.id }]; P.mana = 0;
  const r5 = E.act(st, P.id, { type: 'play', uid: 4243 });
  check('境界够但法力不足时高境界装备仍被拒', r5.ok === false && /法力值/.test(r5.error || ''), JSON.stringify(r5));

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
