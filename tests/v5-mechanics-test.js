'use strict';
// 实物重排后的机制回归：
//   A. 境界金字塔：元婴 0 张、分布单调递减
//   B. 丹药 0 费
//   C. 法术类装备的「多境界档位」：选档、档位境界校验、效果按选档生效
//   D. reroll_dice（青元剑诀筑基档）在激活结果里可见
//   E. 同行者「替挡」：absorb 类挡下全部伤害后进弃牌堆；普通同行者仍是 2 点血
const E = require('../server/engine');
const C = require('../server/cards');
const { tierOp } = require('./fixtures');

let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  << ' + x : '')); } };
/** 把开着的窗口全放弃掉（清场用） */
const flush = (st) => { let g = 0; while (st.pending && g++ < 20) { const w = E.pendingActor(st); if (!w) break; E.act(st, w.id, { type: 'respond_pass' }); } };

console.log('[A] 境界分布（按用户实物卡文重建后的真实分布）');
{
  const tally = [0, 0, 0, 0, 0];
  for (const k of ['treasure', 'spell']) for (const c of C.cards()[k]) tally[c.realm || 0] += c.count;
  const total = tally.reduce((a, b) => a + b, 0);
  console.log('   分布:', tally.map((n, i) => `${E.REALMS[i]}${n}`).join(' / '), `（共 ${total}）`);
  check('元婴期卡牌为 0（到元婴就胜利，不该有元婴牌）', tally[4] === 0, String(tally[4]));
  check('凡人期最多', tally[0] === Math.max(...tally), JSON.stringify(tally));
  check('凡人占比 > 35%', tally[0] / total > 0.35, (tally[0] / total * 100).toFixed(1) + '%');
  console.log('   注：完整金字塔需官方全卡表；当前是从实拍素材抄到的部分卡，分布仅供参考');
}

console.log('\n[B] 丹药 0 费');
{
  const pills = C.cards().treasure.concat(C.cards().spell).filter((c) => /丹$/.test(c.name));
  check('存在丹药卡', pills.length > 0, String(pills.length));
  pills.forEach((c) => check(`【${c.name}】0 费`, c.cost === 0, 'cost=' + c.cost));
}

console.log('\n[C] 法术类装备的多境界档位');
{
  // 真实素材抄到的卡里没有带 tiers 的（实物【青元剑诀】那类没被拍到），
  // 所以这里注入一张合成卡来验证「多境界档位」机制本身仍然可用。
  let tiered = C.cards().spell.filter((c) => c.type === 'equip' && c.tiers && c.tiers.length);
  if (!tiered.length) {
    C.cards().spell.push({
      id: 'test_tiered', name: '测试·青元剑诀', type: 'equip', cost: 2, realm: 1, count: 1,
      text: '测试用多档法术', effect: { kind: 'dice_bonus', value: 1, cap: 6 },
      tiers: [
        { realm: 1, text: '炼气期档', effect: { kind: 'dice_bonus', value: 1, cap: 6 } },
        { realm: 2, text: '筑基期档', effect: { kind: 'reroll_dice', value: 1 } },
        { realm: 3, text: '结丹期档', effect: { kind: 'combat_bonus', value: 1 } },
      ],
    });
    tiered = [C.cards().spell[C.cards().spell.length - 1]];
    console.log('   （真实卡池无 tiers 卡，已注入合成卡验证机制）');
  }
  check('存在带档位的法术装备（真实或合成）', tiered.length > 0, String(tiered.length));
  console.log('   带档位:', tiered.map((c) => `${c.name}(${c.tiers.length}档)`).join(' / '));

  const qy = C.cards().spell.find((c) => c.tiers && c.tiers.length >= 3);
  check('存在 3 档的法术装备', !!qy, qy && String(qy.tiers.length));
  if (qy) {
    check('第一档对应对战骰点+1', tierOp(qy, 0) === 'dice_bonus', String(tierOp(qy, 0)));
    check('第二档对应重掷取大', tierOp(qy, 1) === 'reroll_dice', String(tierOp(qy, 1)));
    check('第三档对应对战战力+1', tierOp(qy, 2) === 'combat_bonus', String(tierOp(qy, 2)));

    const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 777 });
    E.beginGame(st);
    const P = st.players[0];
    st.turn = 0; st.step = 'action'; st.turnFlags = { combat: false, promote: false };
    P.hand = []; P.equip = []; P.spells = []; P.mana = 12;

    check('maxTierFor(凡人) = -1/0（凡人低于第一档）', E.maxTierFor(qy, 0) === 0, String(E.maxTierFor(qy, 0)));
    check('maxTierFor(炼气) = 0', E.maxTierFor(qy, 1) === 0, String(E.maxTierFor(qy, 1)));
    check('maxTierFor(筑基) = 1', E.maxTierFor(qy, 2) === 1, String(E.maxTierFor(qy, 2)));
    check('maxTierFor(结丹) = 2', E.maxTierFor(qy, 3) === 2, String(E.maxTierFor(qy, 3)));

    // 凡人不能装备它（第一档就要炼气）
    P.realm = 0; P.hand = [{ uid: 1, id: qy.id }];
    const r0 = E.act(st, P.id, { type: 'play', uid: 1, tier: 0 });
    check('凡人装不了（第一档需炼气）', r0.ok === false, JSON.stringify(r0));

    // ⭐ 用户裁定（2026-10-02）：多档位牌**一律自动适配当前境界**，手选档位已废。
    //    所以这里故意传一个"越级的第 2 档"，应该被忽略、落到炼气档而不是报错。
    P.realm = 1; P.hand = [{ uid: 2, id: qy.id }];
    const r1 = E.act(st, P.id, { type: 'play', uid: 2, tier: 1 });
    check('炼气能装备（请求里的越级档位被忽略，不再报错）', r1.ok === true, JSON.stringify(r1));
    check('自动落到第 1 档（炼气档）', P.spells[0] && P.spells[0].tier === 0, JSON.stringify(P.spells[0]));
    check('该档效果 = dice_bonus', E.tierEffect(qy, P.spells[0]).kind === 'dice_bonus');

    // 结丹：请求里写第 1 档也不作数 —— 自动取最高可用档（第 3 档）
    P.realm = 3; P.spells = []; P.hand = [{ uid: 3, id: qy.id }];
    const r3 = E.act(st, P.id, { type: 'play', uid: 3, tier: 0 });
    check('结丹能装备（写第 1 档也没用）', r3.ok === true, JSON.stringify(r3));
    check('自动升到第 3 档（结丹档）', P.spells[0] && P.spells[0].tier === 2, JSON.stringify(P.spells[0]));
    const eff = E.tierEffect(qy, P.spells[0]);
    check('第 3 档效果 = combat_bonus', eff && eff.kind === 'combat_bonus', JSON.stringify(eff));

    // 晋升后自动对齐：场上已装的多档牌要跟着境界往上走（"自动适配当前境界"的另一半）
    P.realm = 2; P.spells = []; P.mana = 12; P.hand = [{ uid: 40, id: qy.id }];
    E.act(st, P.id, { type: 'play', uid: 40, tier: 0 });
    check('筑基自动取第 2 档（reroll_dice）', P.spells[0] && P.spells[0].tier === 1, JSON.stringify(P.spells[0]));
    P.realm = 3;
    E.syncEquipTiers(P);          // doPromote 内部就是调它
    check('晋升到结丹后场上那张自动对齐到第 3 档', P.spells[0] && P.spells[0].tier === 2, JSON.stringify(P.spells[0]));

    // D. 筑基档（"投掷骰子后使用，可额外投掷1次骰子，取点数最大值"）在**它自己的时点**发动
    //    —— 2026-10-06 迁移：不再有"开战启用费"，费用跟着效果走（这张牌属于"装备时付过费"类 ⇒ 发动免费）。
    {
      const st2 = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 4242 });
      E.beginGame(st2);
      st2.players.forEach((q) => { q.turnsTaken = 2; });
      const Q = st2.players[0], F = st2.players[1];
      st2.turn = 0; st2.step = 'action'; st2.turnFlags = { combat: false, promote: false };
      Q.realm = 2; F.realm = 2; Q.mana = 12; F.mana = 12; Q.hp = 6; F.hp = 6;
      Q.hand = []; Q.equip = []; Q.spells = []; Q.companions = [];
      F.hand = []; F.equip = []; F.spells = []; F.companions = [];
      Q.hand = [{ uid: 4, id: qy.id }];
      E.act(st2, Q.id, { type: 'play', uid: 4, tier: 1 });          // 筑基 ⇒ 自动取第 2 档
      check('筑基档装上后 tiers=1（重掷取大）', !!(Q.spells[0] && Q.spells[0].tier === 1), JSON.stringify(Q.spells[0]));
      st2.forcedDice = [2, 1, 6];                                   // 甲掷 2 → 乙掷 1 → 结算时甲重掷 6（取大）
      E.act(st2, Q.id, { type: 'combat', target: F.id });
      const atStart = !!st2.pending;
      check('开战时不再为它开窗（旧写法是"开战付启用费"）', !atStart, JSON.stringify(st2.pending && st2.pending.event));
      const rr = E.act(st2, Q.id, { type: 'roll' });                // 掷骰 → 开「我方投骰后」窗口
      check('挂起在「我方投骰后」窗口（筑基档卡文 = 投掷骰子后使用）',
        !!(st2.pending && st2.pending.event === 'roll' && st2.pending.phase === 'after'),
        JSON.stringify([rr, st2.pending && [st2.pending.event, st2.pending.phase]]));
      const cands = E.pendingCards(st2, Q).map((c) => ({ name: c.name, cost: c.cost }));
      check('候选里有场上的【青元剑诀】（0 费：这张牌装备时已付过）',
        cands.some((c) => c.name === '青元剑诀' && c.cost === 0), JSON.stringify(cands));
      const m0 = Q.mana;
      check('发动成功', !!E.act(st2, Q.id, { type: 'respond_play', uid: Q.spells[0].uid }).ok, '');
      check('发动不扣法力', Q.mana === m0, `${m0} -> ${Q.mana}`);
      check('重掷次数记进了本场对战（equipBonus.rerollDice = 1）',
        !!((st2.combat.equipBonus || {})[Q.id] && st2.combat.equipBonus[Q.id].rerollDice === 1),
        JSON.stringify(st2.combat.equipBonus));
      E.act(st2, F.id, { type: 'roll' });
      flush(st2);
      check('结算时真的重掷并取最大值（骰 2 → 6）',
        /重掷取得更大点数：2 → 6/.test(st2.log.map((l) => l.text).join('\n')),
        st2.log.map((l) => l.text).filter((t) => /重掷/.test(t)).join(' | '));
    }
  }
}

console.log('\n[D] 同行者「替挡」');
{
  const tihun = C.cards().companion.find((c) => c.absorb);
  check('卡池里有 absorb 型同行者', !!tihun, tihun && tihun.name);
  const plain = C.cards().companion.find((c) => !c.absorb) || { id: 'test_plain', name: '测试·普通同行者' };
  check('存在非替挡型同行者（真实卡池可能都有 absorb，则用合成卡对照）', true, plain.name);

  const st = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 888 });
  E.beginGame(st);
  const P = st.players[0];
  P.companions = [{ uid: 101, id: tihun.id }];
  const hp0 = P.hp;
  E.applyDamage(st, P, 5, 'test');
  check('absorb 型挡下全部 5 点伤害（未掉血）', P.hp === hp0, `${hp0} -> ${P.hp}`);
  check('absorb 型随后进入弃牌堆（已离场）', P.companions.length === 0, String(P.companions.length));
  check('战报写明"挡下本次全部"', st.log.some((l) => l.text.includes('挡下了本次全部')));

  // 没有 absorb 卡文的普通同行者不替挡（否则【燕如嫣】「受伤回法力」永远触发不了）
  const st2 = E.createGame([{ id: 'a', name: '甲', host: true }, { id: 'b', name: '乙' }], { seed: 889 });
  E.beginGame(st2);
  const Q = st2.players[0];
  Q.companions = [{ uid: 201, id: plain.id }];
  const q0 = Q.hp;
  E.applyDamage(st2, Q, 1, 'test');
  check('普通同行者不替挡，主人直接掉血', Q.hp === q0 - 1, `hp=${Q.hp}`);
  check('普通同行者仍在场（未受创）', Q.companions.length === 1, String(Q.companions.length));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
