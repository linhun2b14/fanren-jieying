# 2026-10-06（第十四件）· 引擎：**【铜钱】的破招时机**（用户截图报的 bug）

> 用户原话：**「铜钱的破招时机不对，并没有在战斗中就触发了」**
> 截图：对手在**行动阶段**（**根本没有对战**）打出一张【青冥针】，弹出「卡牌使用 · 前」窗口，
> 把乙手里的【铜钱】摆出来问 —— 红圈圈住的正是卡面那句「**在对战中使用**」。

---

## 1. 三个 bug 一次报出来（②③ 用户还没踩到，但一定会踩）

| # | 现象 | 根因 |
|---|---|---|
| ① | **对战外**也把【铜钱】摆出来问 | `requiresCombat`（OPS 标记）**只在 `playable()` 里拦过**，`timingResponders()` 的候选这条路完全没判 |
| ② | **对战里反而问不到**（真正该用的时候用不出来） | 对战里出牌走**【斗法】链**（`respondPlay` → `resolvePending`），**不经过 `doPlay`**，所以 `useCard · 前` 那一刻压根没被触发；只有非对战的 `doPlay` 会开这个窗 |
| ③ | 顺着②实装后，**整场对战卡死** | 链"挂起 → 续跑"完**没人调 `finishPending`** —— 外面（投骰/对战）永远等不到 resume；实测：无效掉一环比完后，`combat.stage` 停在 `pre`，谁也不动了 |

`requiresCombat` 目前覆盖：`nullify_enemy_card`（【铜钱】【虚天鼎】【雷火锥】）、
`risky_win_damage`、`damage`（attacker 模式）、`damage_attacker`（已废弃写法）。

---

## 2. 改法（`server\engine.js`）

1. **候选层补门**（`timingResponders()` 的 `eligible()`）：`effectRequiresCombat(e) && !ctx.combat` → 拒。
   修的正是用户截图那一幕（那一幕里窗口是 `useCard · 前`，但对战根本没开）。
2. **链内也开一次「对方出牌时」**（`resolveChainFrom()`）：对战里每一环**手牌**在结算**之前**，
   给对家开一次 `useCard · 前` 窗口（`ctx.linkUid` = 打的是链上哪一环）。
   - 同一环**只问一次**（`state.nullifyAsked[uid]`）；
   - 真开了窗口就 `{paused:true}` 挂起，窗口关掉后**回到同一个下标**接着跑；
   - `openInterrupt` 不叠窗口（v1 限制）：链结算途中已经被别的效果开了窗 → 这一环的无效机会
     **静默跳过**（可接受的降级，写在这里免得下次当成新 bug）。
3. **无效掉的那一环不结算**：`nullify_enemy_card` 命中 `ctx.reaction.linkUid`
   → `state.nullifiedLinks[uid] = true`，收势时跳过它的效果（牌已经打出去、法力已经付，只是白打）。
   旧的 `state.nullifiedPlay`（`doPlay` 路径"取消这次出牌"）保留，两条路靠 **`linkUid` 有没有值**分流。
4. **修③（真 bug）**：链的续跑统一走 `resolvePending` 里的 `step(i)`
   （= `resolveChainFrom(...)` 跑完 **再** `finishPending`），`finishPending` 里那句
   "出牌被无效 → 不 resume" 也加了 `linkUid == null` 的前置条件 ——
   **链内无效不再吞掉 resume**，外面的流程照常往下走。
5. **类别必须对得上**（同一份卡文里就有三种写法）：

   | 牌 | `effect.block` | 能无效的目标 |
   |---|---|---|
   | 【铜钱】 | `宝物牌` | 消耗类/装备类宝物牌（卡文） |
   | 【雷火锥】 | `法术牌` | 法术牌 |
   | 【虚天鼎 乾蓝冰焰】 | `法术牌/宝物牌` | 两者皆可 |

   判据用 `ctx.cardId`（**正在被打出的那张牌**，链上那环 / `doPlay` 那张都给了），
   写法统一收在 **`blockMatchesDef(block, def)`** ——【阴魂丝】的类别封锁（`combat.blocked`）共用同一套，
   以前是内联在 `combatCardBlocked()` 里的四行 `if`。认不出的写法 → 不拦（宁可宽松，别让错别字把牌变成死卡）。
6. **战报去硬编码**：`nullify_enemy_card` 以前三条分支全写死「使出**虚天鼎**」——
   【铜钱】【雷火锥】无效成功也报"虚天鼎"（用户截图那张就是）。现在报真正发动的那张牌。

---

## 3. 测试改动

| 文件 | 改动 |
|---|---|
| `tests\window-ask-test.js` | [K] 段扩成 ④⑤⑥：④ 对战里把牌打进链 → 确实给乙开窗、候选有【铜钱】、**真能无效**、效果没结算、**收势后流程照常走**（这条同时守住③的卡死）；⑤ 类别过滤：乙打进链的是法术牌 → 只摆【雷火锥】、不摆【铜钱】；⑥ 对战外硬 `respond_play` 被拒 |
| `tests\interrupt-test.js` | [C] 改写成**新语义**：对战外（行动阶段）出牌【补气丹】**不再**为【虚天鼎】挂起、那张照常结算;[C2] 改成"对战里无效链上那一环"（含"挂起→续跑后乙真的投了骰，不是死锁"） |
| `tests\card-bugfix-test.js` | [A] 段同样的改写：数字 uid / 字符串 uid / 不耗法力 / "本回合仅此一次" / `turnUsedUids` 记账全部保留，但**时点搬到对战里**；"同一回合第二次不再摆出"改成更强的一版 —— 链上还剩一环会**照常开窗**（甲手里有【雷火锥】），只是【虚天鼎】不再出现（以前那条在"窗口都没开"时是空断言） |

> ⚠️ 写这条链的测试**不能用 `flushAll()` 收势** —— 那个窗口正是开给对方的，
> flush 会把他的机会"替他放弃"掉，于是断言永远看不到 `pending`（④ 一开始就是这么误判的）。

---

## 4. 验收

```powershell
node tests\run-all.js --no-ui                                  # 36/36（domain-test 要公网，见交接 §7）
$env:BASE='http://127.0.0.1:8095'; node tests\run-all.js        # 全量（引擎 + UI 十四测）
node tools\verify-dsl.js; node tools\lint-cards.js              # 40/40、0 错
node tools\deploy-check.js 8094 8095                            # 两个服务都是最新（改 server\ 必须重启 8094）
```

引擎侧改动 ⇒ **8094 已重启**（`Stop-ScheduledTask`/`Start-ScheduledTask`，`/api/version` 的
`engine.hash` 与磁盘一致、`stale:false`）。
