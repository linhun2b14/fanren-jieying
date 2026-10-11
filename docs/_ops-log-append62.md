# 2026-10-05（第九件）· **窗口 / 主动技能里选目标** —— 最后两张卡收口，全池 100% 实装

> 承接第 8 件（`_ops-log-append61.md`）：实物卡补充批 19 张里只剩【青冥针】【金魁】，
> 缺的不是"牌的效果"，而是**"发起动作前先选一个目标"**这个交互。这一件就是它。

---

## 1. 结果

| 项 | 之前 | 现在 |
|---|---|---|
| 完全未实装 | 2 张（【青冥针】【金魁】） | **0 张** |
| 卡池 | 280 张 | **282 张**（宝物 75 / 法术 54 / 同行者 93 / 灵气 60） |
| 引擎侧闸门 | 35/35 | **35/35**（batch8 从 106 → 124 项） |
| 全量（含 UI） | 46/46 | **47/47**（新增 `ui-target-pick.js` 17 项） |

## 2. 引擎：目标怎么从动作传到效果

1. **动作收目标**：`respondPlay(state, pl, uid, tier, action)` 收 `action.target`（一位修士）/
   `action.targetUid`（场上一张牌）；`doActivate(state, pl, action)` 同样收。
   **缺目标直接拒**（`【青冥针】需要先指定一位目标`），免得牌白打出去、次数白扣。
2. **目标挂在链上**：`pd.chain.push({ …, target, targetUid })` —— 一个窗口里两个人可以选不同目标，
   所以目标**不能**只放在窗口级 `ctx` 上。
3. **收势时注进效果**：`resolvePending()` 组装 rctx 时 `target: link.target || pd.ctx.target`（同理 targetUid / targetPl）。
4. **元数据告诉界面该选什么**：新增 `effectTargetKind(e)` →
   `'player'`（选人）/ `'board'`（选场上的牌）。`pendingCards()` 的候选与 `activatables()` 的能力
   都带上 `needsTarget` / `targetKind`（"二选一"的多档位卡按**每档自己的效果**分别判）。
5. **"无效一张场上的牌"怎么实现**：【金魁】的 `nullify_board_card` 给那张实例打 `inst.nullified = true`，
   由 **`effectsOf(def, inst)`**（"这张牌有什么效果"的唯一入口）返回空 —— 于是常驻加成、主动技能、
   时点响应、对战启用费**全部停**，而**卡还留在场上**（是"无效"，不是"弃置"）。
   `findBoardInst(state, uid)` 负责按 uid 在四方场上找实例。

## 3. 前端：`pick-overlay` 选目标弹层

- 新增 `.pick-overlay` / `.pick-box` / `.pick-opt`（`public\style.css`），斗法弹窗与主动技能**共用**：
  - `kind='player'`：列出合法修士（复用 `targetInfo(st,'card')` 的判据：出局/闭关/自己不含）；
  - `kind='board'`：列出四方场上（储物袋 / 法术区 / 同行者 / 傀儡位）的牌，带"谁的·哪个区"。
- 斗法弹窗：`needsTarget` 的候选按钮上多一行「※ 需要选择目标：…」，点击后先弹选择器，
  选中才把 `{type:'respond_play', uid, tier?, target|targetUid}` 发出去；点「取消」或点遮罩**不发动作**。
- 主动技能：按钮同理（【金魁】"主动使用 · 金魁" → 选场上的一张牌 → `{type:'activate', uid, targetUid}`）。
- 🧪 顺带加了**测试钩子** `window.__fanrenPreview(state, session)`（只为 CDP UI 回归：
  有些局面真实对局里极难稳定复现）。它只往渲染层喂一份 publicState，不参与任何业务逻辑。

## 4. 测试

- **引擎**：`tests\batch8-cards-test.js` 的
  **[P]【青冥针】**：数据形状 → 候选带 `needsTarget/targetKind` → **不带目标被拒** →
  带目标 → 收势等额反伤 → 付 2 点发动费 → 可用 2 次递减 → 用完不再进候选；
  **[Q]【金魁】**：主动技能列表带 `targetKind=board` → 不带/乱填目标被拒 → 选牌后
  `nullified=true`、**对方的回法力加成真的归 0**、卡还在场上、抽 1 张灵气、自身进弃牌堆。
- **界面**：新增 `tests\ui-target-pick.js`（17 项，真浏览器，接进 run-all）：
  ① 弹窗候选 → 弹选人层 → 取消不发动作 → 选中后动作带 `target`；
  ② 主动技能 → 弹选牌层 → 动作带 `targetUid`；
  ③ 不需要选目标的候选照旧一步发出；④ 全程无页面异常/控制台报错。

## 5. 顺手修的一处"种子漂移"（卡池 280 → 282 的连带）

`dead-effect-test` 的 setup **没清空对手的随机起手牌**：卡池一变，乙就可能发到【虚天鼎 乾蓝冰焰】
这类「使用卡牌 · 前」的响应牌 → 甲的出牌被挂起 → "【长春功】升境界"那三条断言全红。
按 `companions-v2-test` 的老办法，setup 里**把对手的手牌与场上也清空**（并写清为什么）。

> 这也是这一轮反复出现的同一个规律：**卡池每变一次（哪怕只多两张），所有靠种子/起手牌决定的东西都会漂**。
> 需要"必胜/必平/必不被打断"的断言，一律用 `state.forcedDice` 注入或显式清空对手牌。

## 6. 验收

```powershell
node tests\run-all.js --no-ui                                  # 35/35（batch8 124 项）
$env:BASE='http://127.0.0.1:8095'; node tests\run-all.js        # 47/47（含 UI 十二测）
node tools\verify-dsl.js                                       # 40/40
node tools\lint-cards.js                                       # 硬错误 0，完全未实装 0 张
node tools\gen-cardlist.js                                     # docs\卡牌一览.md → 总计 282 张
$env:EDITOR_BASE='http://127.0.0.1:8097'; node tools\editor\selftest.js          # 全部通过
$env:EDITOR_BASE='http://127.0.0.1:8097'; node tools\editor\selftest-browser.js  # 54/54
```

线上 **8094**、编辑器 **8098** 已重启（`/api/version`、`/api/healthz` 的 `stale=false`）。
