# 全量排查报告 — 2026-10-25

> 目标：通读全项目、回归主要功能，找出确实影响功能运行的缺陷并修复；
> **存疑/需设计决策的一律不动**，整理在第三节交由你决定。
>
> 排查范围：`packages/server/src`（game.ts 1581 行 / index.ts 2223 行）、
> `packages/shared/src`、`packages/miniapp/miniprogram`（game.js 83KB / table.js 153KB /
> home.js / lobby.js / utils/{room,net,table,tileimg,uiart,sound}.js）+ 三页 WXML/WXSS。

## 一、方法与基线

- `npm run typecheck`（strict）→ **0 错**。TS 侧无静态缺陷，问题集中在**未被 tsc 覆盖的小程序 JS** 与**运行时逻辑**。
- 用 `new Function` CJS 加载器把小程序 `.js` 当 CJS 校验语法（根 `package.json` 是 `type:module`，
  `node --check` 会误判）。
- 对渲染层用**真实 `table.js` + 打桩 canvas** 实测几何（不是读代码猜）。
- 对 `room.js` 用**真实模块 + 打桩 wx/net/store** 做消息流回归，并跑「修复前」对照证明测试有效。

---

## 二、已确认并修复（按严重度）

### ① 回桌成功后 `autoResume` 永不复位 → 任意一条 error 把玩家踢出房间 【严重·已修】

- **位置**：`utils/room.js`（修复前 :301 置真、:153 判定、:185/:202 未复位；:310 `clearAutoResume()` **全仓库零调用**）
- **根因**：`tryResume()` 置 `autoResume = true`，只有 `case 'error'`（:154）和 `case 'kicked'`（:174）会复位。
  回桌成功走 `state` / `game` 分支，**这两个分支从不复位** → 该标志一旦置真就终身为真。
  此后 `error` 分支的 `if (autoResume || isFatalRoomError(...))` 恒命中。
- **症状**：玩家凭本地 token 自动回桌成功后，**任何**一次被服务端拒绝的操作
  （响应窗口刚过期时点「碰」、非房主点解散、大厅校验失败…）都会
  清 token + 断 socket + `reLaunch` 回首页并提示「房间已失效」——
  **房间其实还在，其他人还在打**。附带把 `lobby.js` 的 `recoverGame()` 自救逻辑变成死代码。
- **修法**：`case 'state'` 与 `case 'game'` 到手即 `autoResume = false`（回桌成功＝不再需要自动回桌降级路径）。
  「房间已失效」这类真致命错误仍由 `isFatalRoomError(/已失效/)` 独立判定，不受影响。
- **验证**：`.recover-tmp/f1_room_resume.mjs`，7/7 通过；
  **修复前对照跑 3 通过 / 4 失败**（确实抓到回归）。

### ② `onAppShow` 未 `clearTimeout` 就置空重连句柄 → 重复建连、重复发 resume 【中·已修】

- **位置**：`utils/net.js`（修复前 :329；配合 :210 守卫、:219 只挡 `'open'`）
- **根因**：退避等待窗口（1~4s）内切后台再回前台 → `onAppShow` 把 `reconTimer` **只置空不清定时器**，
  旧定时器仍在倒计时；随后 `scheduleReconnect()` 因 `if (reconTimer) return` 已被绕过而**又排一个**。
  旧定时器到期后 `state === 'connecting'` 挡不住（只挡 `'open'`）→ 再 `openSocket()`。
- **症状**：两条 WebSocket 并存、`task` 被覆盖、发出**两份 resume**；叠加缺陷 ① 会直接被踢回首页。
- **修法**：`onAppShow` 里先 `if (reconTimer) clearTimeout(reconTimer);` 再置空。
  （未改 `state === 'connecting'` 的判定，避免动到重连语义——`openSocket` 有 `connectTimer` 兜底，不会卡在 connecting。）
- **验证**：语法校验通过；逻辑经 `openSocket`/`scheduleReconnect` 全路径核对。

### ③ 换位不迁移累计积分 → 分数跟着座位跑而不是跟着人跑 【中·已修】

- **位置**：`packages/server/src/index.ts` `applySeatSwap()`（修复前 :982-1003）
- **根因**：该函数同步了 `seat` / `binding` / `tokens` / `hostSeat` / `nextDealer` / `dealerRolls`，
  唯独漏了 `room.totals`（声明于 :178，按**座位下标**存的累计分，初值 `[0,0,0,0]`）。
- **症状**：打完一盘回大厅后做一次换位 → 甲乙累计分互相对调，且后续在新座位上继续累加，
  **错误永久固化**，最终「解散牌桌」弹窗的累计分也是错的。
- **修法**：在函数末尾交换 `room.totals[a]` 与 `room.totals[b]`。
- **验证**：`npm run typecheck` 0 错。

### ④ 用机器人补满最后一席时不触发开局 → 房间卡在大厅 【中·已修】

- **位置**：`packages/server/src/index.ts` `case 'addBot'`（修复前 :1459 `return;`）
- **根因**：协议里**没有「开始」指令**，开局只由服务端自动触发，触发点只有 `ready` 分支（:1583）
  与定庄结算（:1040/:1047）。`addBot` 结尾只 `broadcastLobby` + `syncBotDealerRolls`，
  而后者对南昌直接 return（`needsDealerRoll` 为 false）→ **无人再检查 `canStart`**。
- **症状**：房主「先点准备、后用机器人补满」→ 四人齐全、全部就绪，但 `startGame` 从未被调用，
  房间永远停在大厅；只能再点一次「准备 / 取消准备」重新走 `ready` 分支才能动。
- **修法**：`addBot` 结尾补 `if (!room.game && room.phase === 'lobby' && canStart(room)) startGame(room);`。
  （赣州不受影响：其定庄路径本就会触发；此处对南昌生效，且不会与赣州的 `dealerStartTimer` 重复开局。）
- **验证**：`npm run typecheck` 0 错。

### ⑤ 大厅「可以开局」横幅在南昌玩法下永远不显示 【低·显示·已修】

- **位置**：`packages/server/src/index.ts` `lobbyState()`（修复前 :290-293）
- **根因**：`allReady` 写死了 `room.firstDealerDecided`，而该标志**只在 `pushDealerRoll` 里置真**（:1043），
  南昌不需要定庄 → 恒为 `false`。与模块级 `allReady(room)` / `canStart(room)` 口径**不一致**（后者才是对的）。
- **症状**：南昌房间即使已经能开局，大厅横幅也永远不显示（`lobby.wxml:53` `wx:if="{{allReady}}"`）。
  不影响实际开局（第 4 次 ready 会触发），纯显示错误。
- **修法**：`const allReady = canStart(room);`，与唯一的开局判据同口径。
- **验证**：`npm run typecheck` 0 错。

### ⑥ 大厅定庄掷骰动画定时器不在页面销毁时清理 【低·已修】

- **位置**：`pages/lobby/lobby.js`（修复前 :61-67 `onHide`/`onUnload` 只 `room.detach(this)`）
- **根因**：`runDiceAnim` 挂了 100ms `setInterval` + 1200/2600ms `setTimeout`，
  唯一清理入口 `clearDice()`（:275-281）只被重入与到期时调用，**页面销毁路径没接**
  （对比 `game.js` 的 `onHide/onUnload` 都调了 `clearDice()`）。
- **症状**：掷骰动画播放期间离开/退房 → 定时器继续对已销毁页面 `setData`，控制台刷警告、可能与新页面抢数据。
- **修法**：`onHide` / `onUnload` 各加 `this.clearDice();`。
- **验证**：CJS 语法校验通过。

---

## 三、存疑 / 需你决定（已全部修复）

> B/E/C/D/F/G/H/I 第二、三轮已修（见第六、七节）；A 第八轮已按**方案③**修复（见第八节）。
> 本节保留原始分析供追溯——**九条现均已闭环**。

### A. 【确认有影响，已修·第八轮（方案③）】自己/对家第 3 组及以后的副露被静默丢弃

- **位置**：`utils/table.js:2111-2129`（`drawMelds` 的 `slot === 0 || slot === 2` 分支）
- **实测**（打桩 canvas 跑真实 `table.js`）：
  - `riverBlockRect(0)`=495.47..784.53、`(3)`=237.46..466.00、`(1)`=814.00..1042.54
  - 左/右可用区各 `252.01px`；一组碰 span `138.63`、一组杠 `185.46`
  - → **每侧只放得下 1 组，两侧合计 2 组**；第 3 组起 `if (x === null) break;` 整组不画。
  - 左右两家（slot 1/3）是竖向排列，可放多组 → **四家行为不对称**。
- **影响**：你做出第 3 个吃/碰/杠时，那组牌**在桌面上完全不显示**（数据是对的，纯渲染容量不足）。
  3 组副露在实战中并不罕见。
- **为何当初不动**：修法要改牌桌布局（加第二行 / 缩小副露 / 放宽边界），属**设计决策**。
- **可选方案（当时列的三条）**：① 副露组数 >2 时整体等比缩小塞进同宽；② 溢出组改画到副露列（竖向第二行）；
  ③ 放宽 `lLimit/rLimit`（现用侧块**外缘**，实际上下两家副露与侧块在 y 上不重叠，留有余量）。
- **最终采用**：**方案③** —— 用户第八轮指定。理由：侧家牌河块在 y 234..405，自己/对家副露行在
  y≈428..491（对家≈164..214），**两者 y 不重叠**，放宽到屏幕边零碰撞风险，且改动最小、不动副露尺寸/行数。

### B. 【确认有影响，已修·第三轮】听牌提示缓存 key 漏掉参与计算的外部状态

- **位置**：`packages/server/src/game.ts:611-643` `waitsFor`
- **根因**：缓存 key 只含「我自己的手牌 + 我自己的副露」，但函数输出还依赖
  `visibleRemain`（遍历**全部** 4 家牌河与副露，:646-656）以及 `jingPi/jingFu`（翻精前后会变）。
  这些都不在 key 里 → 自己手牌没变时命中旧缓存。
- **症状**：我听 X，别家打出第 4 张 X 后，提示**仍标 X**（已不可能自摸的死张）；直到自己下一次动手牌才自愈。
- **为何不动**：该文件自己的注释（:609）写「四个座位一次广播 ≈ 0.8ms，不需要缓存」，
  与实现的缓存策略自相矛盾。两种修法——① 直接去掉缓存（正确性最好，改性能特征）；
  ② 把外部状态摘要拼进 key（保留性能，key 构造成本上升）——**该选哪个需要你定**。

### C. 【结构性缺陷，但推不出复现路径】抢杠胡：回滚后若 `buildWin` 返回 null，会既记杠分又补牌

- **位置**：`packages/server/src/game.ts:854-868`
- **根因**：`revertBugang()` 已把副露改回「碰」、牌还回手牌，随后 `if (info) { applyWin; return; }`
  **没有 else** → 若 `buildWin` 返回 null 会继续掉到下面 `logGang()` + `drawReplacement()`，
  形成「副露是 3 张却按杠记 2 分、还多摸一张」的畸形状态。
- **为何不动**：`openRobWindow` 的 `awaiting` 本就是按 `buildWin` 为真建立的，
  逐条核对 `revertBugang` 对输入集合的影响后**推不出**突变为假的路径 → 属「结构上缺 else」而非可复现 bug。
- **若要修**：`if (info) {...return [];} else return this.advanceTurn();`（一行，风险极低）。

### D. 【依赖运行时行为，需真机复核】`data-bot` 直接把布尔值当真值用

- **位置**：`pages/lobby/lobby.wxml:47` + `lobby.js:366-371`
- **风险**：`item.bot` 是布尔；若基础库把 `data-bot="{{false}}"` 落成字符串 `"false"`，
  则 `if (dataset.bot)` 为真 → 对**真人**发 `removeBot` → 服务端回「该座位不是机器人」，**踢人永远失败**。
- **佐证**：仓库其余 `data-*` 要么用字符串字面量（`data-accept="0"/"1"` 配 `=== '1'`），
  要么用 `Number()` 包裹；只有这里不一致。
- **若要修**：`data-bot="{{item.bot ? '1' : '0'}}"` + JS 侧 `=== '1'`，与既有约定一致。
- **复核方式**：真机在 `onSeatKick` 里 `console.log(typeof e.currentTarget.dataset.bot)`。

### E. 【文档明示为设计，但会锁死整桌，已修·第三轮】杠后掷骰等待无任何超时

- **位置**：`game.ts:1092-1099`（`drawReplacement` 置 `gangCeremony.dice=null` 后 `return []`）、
  `index.ts:379-406`（`syncDice` 三分支都要求 `until != null`）、`index.ts:885-899`（`syncAuto` 对非托管座位直接 return）
- **事实**：此时房间里**一个定时器都没有**，杠者不点「掷骰」就永远卡住，其余三家任何行牌都被
  `assertNoRitual()` 拒绝，只有房主解散才能救。
- **为何不动**：`docs/guides/agent.md` §5.4 明确写着「等待掷骰阶段不自动掷…**设计如此，勿"修复"成自动掷**」，
  且客户端**确实**渲染了「掷骰补牌 / 杠后掷骰…」按钮（`game.js:988`/`:1384`）→ 有出路，属设计。
- **请你定**：是否要接受这个锁死风险？若不接受，建议只加**兜底超时**（如 `TURN_MS` 后自动 `doGangDraw()`），
  而不是改成「仪式中自动掷」。

### F. 【影响极小，纯浪费】`table.js` 的 `ghosts` 永不清理

- **位置**：`table.js:1029-1033`（`SHOW_WALL === false` 时提前 return，跳过 :1075 的过期过滤与绘制）
- **事实**：发牌飞牌 ghost 仍每帧入队却不清理（上限 `RING_SLOTS=136`，不是无限增长）。
  无视觉症状，只是每帧白算一遍 `wallSegs()/segOfCol()`。
- **若要修**：把过滤/绘制移到 `SHOW_WALL` 判断之前，或在 return 前 `this.ghosts.length = 0`。

### G. 【低·动画】开局后第一个动作的中心动画必被吞掉

- **位置**：`table.js:2583-2588` `collectNewActions`
- **根因**：只有 `log` 非空时才做「首次对齐」；新开一局时 log 为空 → 不 bootstrap，
  等第一个动作抵达时 log 首次变非空 → 走这段 bootstrap，把**这个刚发生的动作**当历史丢弃。
- **症状**：从房间开局就在场时，本局**第一个**吃/碰/杠/胡不播中心大字动画（之后正常）。
- **若要修**：log 为空时也置 `fxBootstrapped = true`。

### H. 【极低·视觉】最后一张弃牌的金框缺 y 补偿

- **位置**：`table.js:1476-1484` `drawLastMarker`
- **事实**：`jingBorder`（:2869-2873）对同一问题显式补偿了 `y += ((h - tilt.visH) * (1 - k)) / 2`，
  这里没有 → 金框比对家牌的露出带高约 2.7 逻辑 px（左右 1.2、自己 0.8），屏上约 0.5~1.3 CSS px。
- **若要修**：照 `jingBorder` 补同一行补偿。

### I. 【纯视觉·样式缺失】两个 class 在 game 页没有任何生效规则

- `.total-col`：只在 `lobby.wxss:227` 定义（`font-weight:700`）；小程序 WXSS 是**页级作用域**，
  对 game 页不生效 → 结算表「本局得分 / 累计」两列**不粗体**。
  （**注意**：红绿配色 `.pos`/`.neg` 定义在 `app.wxss:288-294`，是全局的，**生效正常**，只有加粗丢了。）
- `.tone-wind`：`game.js:41` 会产出该类，但全仓库无对应规则 → 风牌在手牌条里没有配色（中/发/白有）。
- **若要修**：往 `game.wxss` 补 `.total-col{font-weight:700}` 与一条 `.tone-wind` 配色（颜色需你定）。

---

## 四、已核验**无问题**的关键不变量（避免误报）

| 不变量 | 结论 |
|---|---|
| 结算四家 `delta` 之和恒为 0 | ✅ 南昌 `score.ts` 三块（patternDelta / chongNet / gangNet）各自零和；赣州 `gzscore.ts` 逐笔 from/to 配对，无 `from===to` |
| `wallLeft ∈ [0,136]` | ✅ 初值 83；`shift`/`splice` 前均有空墙检查；wall 与 ring 槽位严格同步 |
| 每个响应窗口恰有唯一解算路径 | ✅ 窗口仅在两处创建且都要求 `!pending`；`huLock` 与 `resolveClaim` 共用 `huPriority`，不可能两家同时胡 |
| 牌局结束清除全部定时器 | ✅ `onGameOver` 清 window/auto/dealerStart/diceEnd/botThink；所有 over 路径必经 `applyGameEvents` |
| Page 方法名撞生命周期 | ✅ 三页逐个枚举与 10 个生命周期求交，无冲突（`onError` 是 App 级，不算） |
| WXML `bind*` 处理器 ↔ JS 方法 | ✅ 三页 51 个处理器全部有实现，0 缺失 |
| `hitTest` 点错牌 | ✅ 画布内牌张无热区，出牌走 DOM 手牌条；四角铭牌映射 mySeat=0..3 实测正确 |
| 画布非等比拉伸 | ✅ `fitCanvas` 强制 `h=w/2`，WXML 内联定尺，等比 |
| 渲染越界 / 跨组件重叠 / NaN | ✅ 12 种局面（mySeat×牌河张数×相位×副露数）实测 0 越界、0 重叠、0 异常 |
| rAF 排帧闸门 / 缓存上限 | ✅ `rafQueued` 闸门有效；`_vecCache` 80 / `_rotCache` 40 / bubbles 按座位去重 |
| `wx.showModal` | ✅ 仅 `ui.js` 定义且无调用点，三页确认框均走页内 `.layer` |
| 画布隐藏方式 | ✅ 用 `.on-modal` class，未用 `wx:if`（符合约定） |

---

## 五、回归验证

| 项目 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 0 错 |
| 小程序 JS 语法 | `new Function` CJS 加载器逐文件校验 | ✅ room/net/lobby/game/home 全通过 |
| 缺陷 ① 回归 | `node .recover-tmp/f1_room_resume.mjs` | ✅ 7/7 通过（修复前对照 3/7，证明有效） |
| 缺陷 A 回归 | `node .recover-tmp/a_meld_bounds.mjs` | ✅ slot0/2 满副露(5组) 5/5 放下；不越屏幕边、左右有序、y 不与侧块(234..405)交叠；旧逻辑对照仅 3 组 |

> 说明：服务端/小程序逻辑均需真机或起服务实测才能覆盖网络时序与触摸交互；
> 上述为静态 + 单元级回归。建议起服务按 `docs/guides/agent.md` §8 清单走一遍重点流程
> （回桌、换位、机器人补位开局、杠后补牌、结算守恒）。

---

## 六、第二轮修复清单（2026-10-25 09:30，用户指定）

> C / D 确认有影响且方案明确；F / G / H / I 低优先级顺手清。
> 全部改动：服务端 1 处（game.ts）+ 小程序 JS/WXML/WXSS 4 处（lobby.js / lobby.wxml / table.js / game.wxss）。
> **验证**：`npm run typecheck` 0 错；小程序 JS 逐文件 CJS 语法校验全通过；`collectNewActions` 引导逻辑用真实 `table.js` 跑 3 场景 → PASS（开局首动作不再被吞）。

### C. 抢杠胡回滚缺 else 【已修】
- **位置**：`packages/server/src/game.ts`（原 :854-868，`if (p.robKong)` 块内）
- **修法**：`buildWin` 返回 null 时补 `return this.advanceTurn();`（原只 `if (info) {...}` 无 else → 漏到下面 `logGang`+`drawReplacement` 形成畸形状态）。
- 低风险一行补丁；原「推不出突变为假路径」的判断不变，仅堵结构性缺口。

### D. `data-bot` 布尔当真值 → 改为约定写法 【已修】
- **位置**：`pages/lobby/lobby.wxml:47` + `pages/lobby/lobby.js:370-375`
- **修法**：WXML `data-bot="{{item.bot ? '1' : '0'}}"`；JS 侧 `if (e.currentTarget.dataset.bot === '1')`。
  与仓库其余 `data-*` 用字符串 + `=== '1'` 的约定一致，避免真机把 `"false"` 当真值 → 真人踢不掉。

### F. `ghosts` 永不清理 【已修】
- **位置**：`utils/table.js`（原 `SHOW_WALL===false` 提前 return 块）
- **修法**：return 前 `this.ghosts.length = 0;`，避免每帧入队却不被过期过滤回收、数组无谓膨胀。

### G. 开局首个动作动画被吞 【已修】
- **位置**：`utils/table.js` `collectNewActions`（原 :2584）
- **修法**：`log` 为空且未 bootstrap 时先置 `fxBootstrapped = true`，使首个真实动作抵达时正常播放中心动画。
- **验证**：真实模块 3 场景（空log首调→首个动作→后续动作）PASS。

### H. 金框缺 y 补偿 【已修】
- **位置**：`utils/table.js` `drawLastMarker`（原 :1476-1488）
- **修法**：照 `jingBorder` 补 `gy += ((p.h - tilt.visH) * (1 - k)) / 2;`，把金框收口在露出带上（偏移约 0.5~1.3 CSS px）。

### I. 补 `.total-col` 样式 【已修（部分）】
- **位置**：`pages/game/game.wxss`（新增）
- **修法**：加 `.total-col { font-weight: 700; }` → 解散结算表「总积分」列加粗（红绿配色由全局 `.pos/.neg` 负责，原本就生效）。
- **关于 `.tone-wind`**：复核后判定**非缺陷**——`game.js:36` 注释明写「风牌墨色」，风牌（东南西北）本就该用默认墨色 `#1a1a2e`，`.tone-wind` 缺规则正是让其继承默认墨色，**符合设计**，故不补。

### 仍待你決（未动）
- ~~**A** 副露容量不足（第 3 组起静默丢弃）—— 需定布局方案（加第二行 / 缩小 / 放宽边界）。~~
  → **已于第八轮按方案③（放宽到屏幕边）修复**，见第八节。

---

## 七、第三轮修复清单（2026-10-25 10:06，用户选方案后指定）

> B 走「扩展缓存 key」，E 走「加 15s 自动掷骰兜底」。**验证**：`npm run typecheck` 0 错；
> `node_modules/.bin/tsx` 跑 B/E 回归脚本（`b_waits_cache.mts`、`e_gang_roll.mts`）均 ALL PASS。

### B. 听牌提示标死张（扩展缓存 key）【已修】
- **位置**：`packages/server/src/game.ts` `waitsFor`（原 :621-627）
- **根因**：缓存 key 只含「自己手牌 + 自己副露」，漏了 `visibleRemain` 依赖的**全部副露 + 全部牌河**与翻精口径（`jingPi/jingFu` 或 `gzJing` 正副）。
- **修法**：key 并入 `jingKey`（翻精）+ 全部副露 + 全部牌河摘要。改动只在 `waitsFor` 内，保住南昌 ≈4.3ms/座 的缓存收益（仅多一次全牌扫描 ≈0.05ms）。
- **验证**：`b_waits_cache.mts` —— 别家打牌改变牌河 → key 变化；翻精变化 → key 变化；seat0 单钓 12，别家打出第 4 张 12 后提示剔除死张 → ALL PASS。

### E. 杠后掷骰无超时锁死整桌（加 15s 自动掷骰兜底）【已修】
- **位置**：`packages/server/src/index.ts` —— 新增 `Room.gangRollTimer` 字段、初始化、`syncGangRoll()` 函数，并在 `applyGameEvents` 末调用；`onGameOver` 一并清该定时器。
- **修法**：进入「杠后等掷骰」态（`gangCeremony.dice === null`）且掷骰者为**真实在线人类**（托管/机器人/掉线由 `syncAuto` 接管）时，挂 `TURN_MS`（15s，同响应窗口）定时器，到期自动 `rollDice(seat)`——与手动同一路径、摸牌位置一致（保公平）。
  - 仅覆盖**杠后**掷骰等待，**不扩大**到开局/翻精的掷骰等待（尊重 §5.4「不自动掷」的原范围）。
  - 人类在 15s 内点击 → `applyGameEvents` 重算时 `gangCeremony.dice !== null` → 定时器被清，无重复掷。
  - 本局结束（`onGameOver`/forceOver）→ 清定时器。
- **验证**：`e_gang_roll.mts` —— 人工进入杠后等掷骰态后 `rollDice(0)` 解开等待、补牌（牌墙 83→82）、产出杠补事件 → ALL PASS（该动作即兜底定时器触发的动作本身）。定时器调度逻辑与已验证的 `syncWindow` 同构。

---

## 八、第八轮修复清单（2026-10-25，用户指定按方案③）

> A 副露容量不足：自己/对家（slot 0/2）副露行左右限被侧家牌河块**外缘**卡住，每侧只放 1 组、共 2 组，
> 第 3 组起 `if (x === null) break;` 整组静默不画（数据正确，纯渲染缺口）。用户从三方案中选 **③ 放宽边界**。

### A. 自己/对家第 3 组副露被静默丢弃（方案③：放宽到屏幕边）【已修】

- **位置**：`utils/table.js` `drawMelds` 的 `slot === 0 || slot === 2` 分支（原 :2123-2129）
- **根因**：`lLimit = Math.min(leftR.l,leftR.r)`、`rLimit = Math.max(rightR.l,rightR.r)` 把副露行的
  左右限钉死在**侧家牌河块的内缘**（slot0 对应 `(3)`=237.46、(1)=1042.54）。实测 `riverBlockRect(0)`
  左右各只剩 252px，一组碰 138.63 / 杠 185.46 → 每侧仅 1 组、共 2 组，第 3 组整组消失。
- **修法**：
  1. 常量区新增 `const EDGE_PAD = 10;`（牌桌金边上下 12px 空缝，探 10 仍不碰牌河）。
  2. 该分支 `lLimit = EDGE_PAD; rLimit = W - EDGE_PAD;`，副露行左右放宽到「屏幕边 + 10px 内缩」。
  3. 删除原 `leftR/rightR`（`riverBlockRect(3)/(1)`）取值——它们只为算 lLimit/rLimit 服务，改后成死代码；
     保留解释「侧块恒为 slot3/slot1、曾写反导致对家整组消失」的注释，并补第八轮改动说明。
- **碰撞安全性（实测）**：侧家牌河块在 y 234..405；自己副露行 gy≈464（y 464..527，在侧块下方）、
  对家副露行 gy≈128（y 128..191，在侧块上方）→ **y 与侧块零交叠**，放宽 x 不会压到牌河；
  中心方向指示条（room_time）在 x 476..804 / y 222..426，副露行 y 已避开，亦不交叠；DOM 手牌条 y≥560 在下方。
- **容量提升（验证）**：`a_meld_bounds.mjs` 用真实 `table.js` + 打桩 canvas 实测——
  slot0 与 slot2 在「碰×3 + 杠×1 + 声明」共 5 组的极端满副露下均 **5/5 放下**；
  所有副露矩形均在 `[10, 1270]` 内、左右分区有序、y 不与侧块(234..405)交叠。
  **旧逻辑对照**：同一 5 组场景仅放下 3 组 → 容量提升且消除静默缺口。
- **验证**：CJS 语法（同款 `new Function` 加载器加载 `table.js` 成功 → 语法有效）；
  `node .recover-tmp/a_meld_bounds.mjs` → ALL PASS。
