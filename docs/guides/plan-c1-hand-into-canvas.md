# C1 实现方案：手牌入画布 + 中央徽章化（v1，待确认）

> ⚠️ 历史快照：文中提及的微信小程序端及其路径已于 2026-11-05 整体移除，相关引用均已失效，仅供追溯。

> 2026-10-28 起草。目标：撤掉 DOM 手牌带与状态行，把手牌画进牌桌 canvas，
> 换取画布大幅增高；同时把中央 320×196 信息盘瘦成徽章。**本方案未经确认不实施。**

## 0. 范围与不做的事

| 做 | 不做（另立轮次） |
|---|---|
| C1：自家手牌 + 状态行画进 canvas；吃碰杠胡**按钮带保留 DOM**（34px 恒高不变） | C2：按钮也画进 canvas（再 +1.5~2 天，视 C1 真机效果） |
| 中央面板徽章化（320×196 → ~200×76） | B：河区「贴手牌」锚定 + 满行叠牌（C1 落地后的下一步） |
| 删 DOM 手牌条 / handMetrics CSS 变量 / handTrayW 联动 | 伪 3D 透视贴图 |

**行为变化（需用户确认）**：打开记录/聊天等面板时 canvas 整块 `display:none`（`.on-modal` 机制），
DOM 手牌随之消失——原来 DOM 手牌不消失，C1 后会跟着画布一起藏。技术上限定（DOM 盖不住原生 canvas）。

## 1. 已核实的关键事实

- `fitCanvas`：`w = min(W−84, H×2)`，量 `#game-main`（`.page` flex 列，`game-main{flex:1}`，
  `.board-overlay`（状态 32rpx + action-bar 34px + tray min-height 68px）在其下**方**流内。
- iPhone 13 横屏 844×390：现状 game-main 240 → canvas **458×229**；C1 后 game-main ~356 → canvas **712×356**。
- canvas 点击基建已有：`onCanvasTap`（触点 − boundingClientRect → 逻辑坐标）+
  `table.hitTest`（掷骰钮、四角铭牌已用）。
- 出牌协议：`onTrayTap → tryDiscard(tile)` **单击直接出**（报杠/必打拦截在 tryDiscard 内），
  claims 选择期 `trayActive=false` 只看不可出。
- `table.js` 已有 `drawRevealHand`（摊牌画自家明牌）可复用画法与贴图路径；2026-10-17 前
  canvas 手牌带旧实现在 git 历史可考（game.js 有「画布不再挂 onDiscard」残留注释）。
- `drawCenter` 有「盘 532..750 勿回退」注释——那是针对**当时**副露透视拉进 ~38px 的约束，
  C1 改小盘后必须重新校验，不能当永久铁律。

## 2. 目标纵向预算（1280×640 逻辑，C1「手牌持平档」）

| 区（自上而下） | 现状 | C1 目标 | 说明 |
|---|---|---|---|
| 对家手排 + 墙顶 | 105 | 95 | 压缩上缘余量 |
| 对家河区 | 109 | 160 | 2 行 × 牌高 72 + 缝，贴手排下沿 |
| 中央徽章区 | 216 | 88 | 徽章 ~200×76：剩余大数字 + 风位 + 骰点 + 立精缩略 |
| 自家河区 | 130 | 160 | 2 行 × 72，贴手牌上沿 |
| 自家手牌行（新） | 0（DOM 68+） | 130 | 牌 ~83×112 逻辑，14 张 + 摸牌跳出 ≤1280 宽 |
| 合计 | 640 | 633 + 余量 | R1 用 geomshot 校准微调 |

换算到屏（scale 356/640 = 0.556）：河牌 **27×40px（+78%）**、手牌 **46×62px（与现 DOM 持平）**、
画布 712×356（+55% 高）。若选「紧凑档」（手牌行 110）河区再多 20 逻辑，但手牌屏上降到 ~53px。

## 3. 分轮安排（每轮独立提交、可回退）

### R1 绘制层 `utils/table.js`（1~1.5 天）
- `drawMyHand(view)`：14 张 + 摸牌跳出格；claims 期画半透明遮罩（沿用 trayActive 语义）；
  精牌高亮复用 `jingBorder`；render 时把每张牌矩形记进 `handRects` 供命中。
- `drawStatusBar(view)`：错误文本 / 状态 / 听牌 chip / 倒计时 / 「本局结算 ▲」
  （▲ 是命中区 `settleRect` + 回调 `onSettleRestore`），画布顶端小字带。
- `drawCenter` 徽章化 320×196 → 200×76；重验副露透视约束。
- `drawMelds`/摊牌锚点全走 `riverBlockRect` 现算，预期自动跟随；逐个复核。
- **验证**：`geomshot.mjs` 扩 hand/status 相位 + 断言（手牌 14 张全落界内、与河区/徽章零相交、
  状态行不压徽章），前后对照截图。

### R2 交互层 `game.js` + `table.js`（1 天）
- `hitTest` 扩展：`handRects → onTileTap(idx)`、`settleRect → onSettleRestore`；
  掷骰/铭牌路径不动。
- `onTileTap` → `tryDiscard` 直连（报杠/必打拦截不动）；claims 期命中忽略；
  选中/按下反馈走 canvas 单帧重绘，不过 `setData`。
- **验证**：新增 `scripts/verify/handhit.cjs`——模拟触点 → 坐标换算 → 命中 → 断言
  `tryDiscard` 收到正确 tile；claims 期不出牌；±4px 容差。

### R3 布局层 `game.wxml`/`game.wxss`/`game.js`（1 天）
- WXML：删 `.tray-stack/.hand-tray/.g-status`（board-overlay 只剩 action-bar）；
  overPhase 结构调整（画布全高、不画手牌、状态行仍画）。
- `fitCanvas`：量算不变（game-main flex:1 自动吃高）；骰子冻结、chromeKey、
  `estimateWrap` 兜底重验；`RAIL_RESERVE` 84 保留。
- 桌面两层同源：`.felt` 外圈与 canvas `Table.frame` 映射复核（frame 变了）。
- **验证**：`claimrow.cjs` 改断言（按钮带 34px 恒定、画布不跳——手牌显隐不再影响，
  断言从「按钮不改带高」换成「claims 不改画布尺寸」）；`railtop/panelscroll/wxbalance` 回归；
  844×390 / 780×360 / 700×320 三档 fitCanvas 数值断言。

### R4 清理与兼容（0.5 天）
- 删 handMetrics CSS 变量下发、`handTrayW`、tile-btn 相关样式；`game.js` 头注释改写
  （2026-10-17 旧决策正式改判，理由记档）。
- `wxbalance.cjs`、WXML 配平、`node --check`、`typecheck`、`build:mp`。

### R5 全量回归 + 文档 + 真机（1 天）
- geomshot 全断言绿；`a_meld_bounds.mjs` 重跑；`noisetoast` 不受影响确认。
- 文档：`docs/integration/wechat-miniprogram.md` 新增 §10.9.72+（含旧决策改判记录）；memory 轮次。
- 真机清单：iOS/Android 横屏各点牌 30 次无误触、切后台回桌、弹框开合、骰子相位、重连。

**总计 ≈ 4.5~5 个工作日**；纯客户端渲染层，**服务端与协议零改动**。

## 4. 风险与对策

| 风险 | 对策 |
|---|---|
| 弹框打开手牌消失 | 技术限定，需用户接受（结算态无影响） |
| 点不准（2026-10-17 教训） | 手牌行保 130 逻辑（屏上 ≥58px）；命中 ±4px 容差；真机 30 次点测 |
| 窄窗无滚动逃生门 | handMetrics 缩牌逻辑改造成 canvas 版 `handScale()` 保留 |
| 触摸坐标 dpr 换算 | `measureCanvasBox` 已有；handhit.cjs 用同一换算防两套真相 |
| 中央盘「勿回退」注释冲突 | R1 重新实测副露透视拉进量后更新注释，不盲从旧数字 |
| 回归 harness 大改 | R1~R3 每轮同步改，不积压到 R5 |

## 5. 验收标准（量化）

- 844×390：canvas ≥ 700×350；河牌屏上高 ≥ 38px（现 23）；手牌屏上高 ≥ 58px（现 66）；徽章 ≤ 200×80。
- 全部验证脚本绿；claimrow「画布不跳」在新语义下成立。
- 弹框开合、骰子、重连、overPhase 四相位无布局跳变。
- 真机（iOS + Android 各一台）：横屏点牌 30 次 0 误触。

## 6. 待拍板的 3 个决策

1. **手牌尺寸档**：持平档（推荐，屏上 ~46×62）还是紧凑档（河区多 20 逻辑，手牌 ~42×53）。
2. **状态行入画**（推荐，画布顶端小字带）还是塞进按钮带左侧（省 0.5 天但按钮带变挤）。
3. **弹框时手牌消失**是否接受（技术限定）。
