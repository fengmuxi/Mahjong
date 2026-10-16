# docs/guides/agent.md — 麻将（多玩法 · 当前已实现南昌麻将）

> 给 AI agent 的项目指引。读完即可安全改动代码；**改动规则/算分前先读本文「铁律」一节**。

## 1. 这个项目是什么

一个**网页版麻将**对战游戏：4 人同房间、WebSocket 实时同步、带掷骰翻精/补杠等仪式动画与桌面渲染。单 TypeScript 仓库，无构建框架之外的后端，规则已**冻结**（见 `docs/rules/nanchang.md`）。

- **多玩法**：架构上按「玩法 = 一份 `RuleSet`」插拔（`packages/shared/src/rules/`），已实现**南昌麻将**；首页第 ① 步从玩法注册表列出可选玩法，创建房间时按 id 选定并整局沿用。
- 运行模型：一个 Node 进程同时托管①静态前端（`packages/client/dist`）②`/ws` WebSocket 对局服务。4 名玩家各自一个浏览器标签连同一房间码。
- 权威来源优先级：**`docs/rules/<玩法>.md`（规则与算分）> `packages/shared`（代码实现）> 前端（仅渲染）**。前端不持有任何规则逻辑。

## 2. 技术栈

| 维度 | 选型 |
|---|---|
| 语言 | TypeScript（ESM，`"type": "module"`），`tsconfig` 开 `strict` |
| 服务端运行时 | Node + `ws`（WebSocket），用 `tsx` 直接跑 `.ts`（见 `npm run start`） |
| 前端 | Vite 5，原生 DOM 渲染（无 React/Vue），`target: ES2022` + `DOM` lib |
| 共享层 | `packages/shared/src` 被 server & client 共同依赖 |
| 校验 | `npm run typecheck`（tsc --noEmit）+ `npm run build` + 按规则文档人工复算/试玩（自动化测试已于 2026-10-15 移除） |

注意：源码大量使用**带 `.ts` 扩展名的相对导入**（`import ... from './index.ts'`），依赖 `tsconfig` 的 `allowImportingTsExtensions` 与 `tsx`/`vite` 的解析能力；`tsc` 仅做 `--noEmit` 类型检查，不输出。

## 3. 目录结构与职责

```
packages/
  shared/src/            规则/算分/协议 单一真相源（优先改这里）
    index.ts             房间与对局共享协议类型：Tile / GameView / ClientMsg / ServerMsg / MAX_SEATS
    tiles.ts             牌面编码与工具（suitOf/rankOf/tileName/nextJing/fullDeck）
    wall.ts              牌墙构造与发牌配方（DealRecipe）
    wincheck.ts          胡牌判定（平胡/七对/十三烂/天胡/地胡等）
    resolver.ts          吃/碰/杠/胡 的应答裁决与优先级
    score.ts             算分：classifyPattern + computeSettlement（§6.2 算子表的代码落地）
    rules/               多玩法契约与实现
      types.ts           RuleSet 接口（meta/tiles/wild/actions/win/score/flow）+ WildModel 等
      nanchang.ts        南昌实现（包装既有纯函数，零行为改动）= 新增玩法的对照样板
      index.ts           注册表：VARIANTS / DEFAULT_VARIANT / getRules(id) / VARIANT_LIST（前端用）
  server/src/
    index.ts             HTTP + WebSocket 入口、房间管理、协议分发、定时器（响应窗口/托管/掷骰仪式）、换位
    game.ts              对局引擎（状态机：行牌/响应窗口/轮庄/流局/结算）
  client/src/
    main.ts              WebSocket 连接、入口分步向导（创建/加入 → 玩法 → 表单）、大厅（含换位）/牌桌装配
    table.ts             牌桌渲染（1280×640 画布、牌墙环、罗盘、赢家标识、结算面板）
    tileart.ts           牌面美术（68 张 PNG 资源，见 packages/client 下资源）
    mobile.ts            移动端适配：横屏引导 + 画布尺寸自适应 + 手牌操作条（见 §5.6）
    style.css            全部样式（含 §5.6 的移动端横屏区段）
    vite.config.ts       前端构建配置
scripts/                             开发辅助脚本（截图 / 布局度量 / 移动端交互 / 背景与聊天诊断），非测试门禁
  mobile_shot.mjs        移动端布局核对：4 种手机视口 + 桌面，度量横向/纵向溢出、画布比例、触控尺寸
  mobile_interact.mjs    移动端交互核对：点手牌操作条出牌 / 点画布出牌 / 竖屏提示层
  mobile_orient.mjs      横竖屏专项：能力探测 / 全屏进退与解锁 / 浏览器 UI 遮挡 / 强制横屏 / 静态资源
  mobile_clip_check.mjs  裁剪审计：标准视口（严格「一屏装下 + 元素不越界」）+ 极端视口（可达性）
  invite_flow_e2e.mjs    分享链接流程 e2e：预填可改 / 上一步可回退 / 可改走创建 / 改码真的生效
  mobile_orient_shot.mjs 横竖屏状态截图（竖屏遮罩与原因文案 / 强制横屏首页与对局）
  gen_icon.mjs           生成应用图标（纯 Node 手写 PNG，供 manifest 安装态使用）
  chat_e2e.mjs           聊天链路核对
  bg_*.mjs               背景纹理核对与截图
docs/
  README.md                          文档索引与命名规范
  rules/nanchang.md                  南昌规则（v1.19 冻结稿）——实现与验收唯一规则来源
  rules/ganzhou.md                   赣州冲关麻将规则（含 2026-10-15 确认口径与修订记录）
  architecture/multi-variant.md      多玩法改造设计与迁移分期（P0–P5）
  integration/ganzhou.md             赣州接入改动说明（接入点 / 配置项 / 待确认事项）
  guides/agent.md                    本文
```

## 4. 常用命令（必须会）

```bash
npm run dev:server   # tsx watch 跑服务端（改动即重启）
npm run dev:client   # vite 跑前端（默认 5173，仅开发用；生产由服务端托管 dist）
npm run build        # vite build 产出 packages/client/dist（服务端静态托管依赖它）
npm run start        # tsx 跑服务端（PORT 默认 3000；dist 不存在时回提示先 build）
npm run typecheck    # tsc --noEmit（strict）
# 校验（自动化测试已移除，以下为必做）
npm run typecheck    # tsc --noEmit：改 shared/server/client 后必须零报错
npm run build        # 改协议/渲染后确认能构建出 dist
```

> 改动后至少跑 `typecheck` + `build`；涉及规则/算分的改动，还要按对应 `docs/rules/<玩法>.md` 的表格**人工复算典型行**（见 §5.7）。

## 5. 编码约定（改动前必须知道）

### 5.1 牌面编号（`Tile = number`，0–33）
- `0–8` 万（1–9万），`9–17` 条，`18–26` 筒，`27–33` 字（27东 28南 29西 30北 31中 32发 33白）。
- 比较/排序/计数一律用数字 id；`tileName(t)` 得中文（如 `5万`/`中`），`suitOf`/`rankOf` 拆分花色与点数，`nextJing(t)` 算副精（分组独立循环：9万→1万、北→东、白→中）。
- 136 张牌 = `fullDeck()`（每种 id × 4）。

### 5.2 座位、风位与定庄
- 座位号固定 `0/1/2/3`；`WIND_NAMES` 是**座位基准序**（0东…），**只在「还没有庄家」的兜底文案里用**。
- **风位随庄**：`seatWind(seat, dealer)` = 庄家为东、其余按座位顺序顺延。**牌桌上一切风位显示（名牌、罗盘、播报、结算）都必须走它**——服务端 `windOf(room, seat)`、客户端 `main.ts` 的 `wind()`、`table.ts` 的 `Table.wind()`。**不要直接用 `windName(seat)`**，那是与庄无关的固定映射，会让「庄家=东」失效。
  - 服务端的换算基准 `roomDealer(room)`：**对局中取 `game.dealer`**（结算时看的还是刚打完这局），大厅取 `nextDealer`。
- **首局定庄（掷骰）**：大厅里四人各掷两骰（`{t:'rollDealer'}`，每人一次），点数最大者坐庄；**并列者重掷**（服务端把并列的最高分从 `dealerRolls` 里剔除后重来）。四人齐才结算 → 写 `room.nextDealer` 并置 `firstDealerDecided`。
  - **未定庄不允许开局**：`canStart(room) = allReady(room) && room.firstDealerDecided`；两个 `startGame` 调用点（`case 'ready'` 与 `rollDealer` 结算后）都要用 `canStart`——玩家完全可能「先准备、后掷骰」。
  - `dealerRolls` 必须随人走：**换位时同步平移**（`applySeatSwap`）、**离场时清理**（`pruneDealerRolls`），否则「四人齐」的判定永远不成立、卡在定庄阶段。
- 庄家胡牌连庄；闲家胡牌轮到庄的下家；流局/中止庄家继续（见 `server/src/index.ts` 的 `onGameOver`）。
- **准备阶段可换位**：点其他座位 → 空位直接搬、有人则发请求需对方同意。`applySeatSwap()` 必须在改座位的同时同步 **`binding`（ws→seat）与 `tokens`（token→seat）**，否则 `resume`/广播会按旧座位找人而失联；**房主身份（`hostSeat`）与 `nextDealer` 随人走**，不随座位号。

### 5.3 WebSocket 协议（JSON，`t` 区分类型）
- 客户端→服务端 `ClientMsg`：`create`(带可选 `variant` = 玩法 id) `join` `resume`(凭 token 重连) `ready` `leave` `swap`(请求换位 `toSeat`) `swapRespond`(应答换位 `accept`) `rollDice` `discard` `claim` `pass` `selfGang` `zimo` `nextRound` `abort`(房主解散对局) `dissolve`(房主解散牌桌) `chat`(局内聊天 `text`，服务端按 `CHAT_TEXT_MAX` 截断) `emote`(定向互动表情 `target` + `emote` id) `addBot`(房主大厅加机器人，见 §5.11) `removeBot`(移除机器人 `seat`) `setAuto`(托管开关 `auto`) `declareKong`(赣州报杠 `tile`，见 §5.10)。
- 服务端→客户端 `ServerMsg`：`state`(大厅，含 `variant` 与 `pendingSwap`) `swapAsk`(有人请求与你换位) `game`(个性化视图 `GameView`) `settle`(结算面板) `dissolved`(最终积分) `event`(播报) `chat`(聊天广播 `seat`/`name`/`text`) `emote`(互动表情广播 `from`/`target`/`emote`，**发全房**) `error`。
- **玩法 id 一定由服务端归一**：`create` 里 `getRules(msg.variant).meta.id`——未知 id 静默回退默认玩法（南昌），客户端/SDK 传脏值不会炸。
- 每个玩家收到**个性化 `game` 视图**（只看见自己手牌 `myTiles`、其他家仅张数 `counts`），翻精骰掷出前 `jingPi/jingFu` 为 `null`（防剧透）。

### 5.4 掷骰仪式（服务端权威时间戳）
- 开局/翻精/杠后补牌三步仪式，由 `Game` 里的 `dealUntil`/`jingUntil`/`gangCeremony.until` 控制动画窗口。
- **等待掷骰阶段不自动掷**——庄家/杠者不点「掷骰」就一直卡住，无任何超时代掷（设计如此，勿"修复"成自动掷）。**例外**：该座位处于机器人 / 托管 / 掉线状态时，`syncAuto` 会到点代掷（§5.11）。

### 5.5 入口分步向导（`client/main.ts`，纯前端，不涉及协议）
- 顺序：**① 创建 / 加入 → ② 选择玩法（仅创建分支）→ 最后 填写信息 → 进入房间**。
- 状态：`wizardStepId: 'mode'|'variant'|'form'`、`wizardMode: 'create'|'join'|null`、`codeFromLink: boolean`。
- **步骤数随分支变化**：`stepSeq()` = `join ? ['mode','form'] : ['mode','variant','form']`——**加入分支没有玩法步**（玩法由房间决定，让用户选会误导）。所以 `renderSteps()` 必须按 `stepSeq()` **重建**步骤条（编号也随之重排），不要在 HTML 里写死步骤项。
- `goStep(id)` 统一收口可见面板 + `renderSteps()` + 清错误 + 最后一步聚焦；`renderWizardForm()` 按 `wizardMode` 切换标题 / 房间码字段 / 按钮文案 / 摘要 chip（加入分支的 chip1 写「玩法 由房间决定」）。
- **步骤条状态**：`.current`（金色）/ `.done`（绿色且**可点击回退**）。没有「锁定」态 —— 任何入口都必须能回退到上一步。
- 分支跳转：`#mode-create` → `goStep('variant')`；`#mode-join` → `goStep('form')`（直达）；`#form-back` → `wizardMode === 'join' ? goStep('mode') : goStep('variant')`。
- 分享链接（`?room=`）：**仅作「房间码预填充」的入口** —— `codeFromLink = true` + `wizardMode='join'` + `goStep('form')`，房号预填但**可编辑**，「上一步」与步骤条回退都保留（可回到模式步去创建房间 / 重选加入 / 改房间码）。表单上用摘要 chip「房间码已预填 · 可修改」告知用户。用户改走创建分支时 `dropRoomParam()` 清掉 URL 里的 `room`，避免刷新又被拉回「加入某房间」。
- `exitHome()` 重置回 `'mode'` 并清 `codeFromLink`。
- 改这一步时注意：`#home-error` 是各步**共用**的错误位；`goStep()` 会先清错误，所以顺序必须是「先跳步、再 `showHomeError`」。

### 5.6 移动端适配（`client/src/mobile.ts` + `style.css` 的 `html.mobile-layout` 区段）
移动端只改**展示与交互**，不触碰任何规则/协议。以下每条都对应一次真实事故：

- **布局门控用 `<html>` 上的类，不要用「视口高度」媒体查询**。`index.html` 的预置脚本在首次绘制前写好 `touch / mobile-layout / land-narrow / land-wide / force-landscape`，`mobile.ts` 的 `sync()` 持续维护。因为 `max-height` 媒体查询按「布局视口」（含地址栏隐藏后的大视口）计算，与真实可见高度不一致 —— 一旦判断失手，整套移动布局会**静默失效**并退回桌面布局。
- **高度必须取 `visualViewport` 实测值（`--vv-*` / `--ld-*`），并显式覆盖 `min-height: 100vh`**。`100vh` 是「大视口」，有地址栏时比可视区高，而 `min-height` 会压过 `height` → body 被撑高、底部（手牌条/控件）被顶到浏览器 UI 之下，又因 `overflow: hidden` 无法滚动，表现为「内容被遮挡」。仅写 `height: 100dvh` 不够。
- **画布绝不能非等比拉伸**。`table.ts` 的点击换算基于 `getBoundingClientRect()`，一旦画布盒被拉伸，画布盒≠内容盒，点牌就会错位。`fitCanvas()` 取 `min(容器可用高, 可用宽/2)` 正是为了让 `max-width` 永不介入裁剪。改尺寸逻辑时先想这一点。
- **手牌操作条（`#hand-tray`）是独立占位，不是覆盖层**。它若覆盖画布，会遮住自己那排副露（逻辑 y=502）与下段牌墙。因此它必须是 `.canvas-wrap` 的**兄弟节点**，画布尺寸随之自动让出空间。
- **触屏判定不能用 `navigator.maxTouchPoints`**。带触摸屏的笔记本会报多点触控，但主指针是鼠标 —— 误判会导致首次点击就被强行全屏。
- **全屏 / 锁定横屏的三条平台铁律**（平台行为，不是代码风格）：
  1. `screen.orientation.lock()` 需要**安全上下文**。本项目典型部署是**局域网 HTTP**（`http://192.168.x.x:3000`）→ **必然失败**；要真生效得走 HTTPS，或把网页**加到主屏幕**（manifest 已声明 `orientation: landscape`，仅安装态生效）。
  2. 必须**先进全屏、等 `fullscreenchange` 落地之后**再 `lock()`；紧挨着 await 就锁会被拒绝（"全屏尚未真正生效"）。
  3. 退出全屏前**必须 `unlock()`**，否则 Android Chrome 会把方向"卡"在横屏 —— 就是「点了全屏之后再转不回来」。另外 iOS Safari **完全不实现**该 API（Apple 未开放），任何"网页自动横屏"在 iPhone 上都不成立。
- **能力缺失必须给原因，不能静默无反应**：`platformCapability()` 判定 → `failureText()` 出可执行文案；按钮文案随状态在「全屏横屏 / 退出全屏 / 强制横屏」间切换（强制横屏那一档不再改文案，见下条）。
- **`html.force-landscape` 是零权限兜底**：竖屏下用 CSS 逻辑旋转 90° 铺满视口，只用 `--vv-w` 做平移量。代价是文字与手机物理方向成 90°，故**只由用户显式开启**，并配常驻退出入口（`#force-exit`），避免用户被困。
- **强制横屏的退出入口 = 右上角 44×44「退出」图标钮（`#force-exit`）**，2026-10-15 从「98×44 文字胶囊」改来（面积 −55%），同时**让 HUD 里那个同名按钮退场**（`syncOrientButton()` 在 `forceLandscape` 时直接 `hidden`）。三条必须一起改，否则会点不到东西：
  1. **给按钮留槽，别硬压**：`.table-head` / `.game-hud` 的右端正好落在这一格上 —— 实测原胶囊**整块盖住**「分享链接」（3219px²）和「解散对局」（2072px²）。故 `html.force-landscape .table-head, .game-hud { padding-right: 52px }` 预留空槽。
  2. **`#rotate-btn` 一隐藏，它那条 `margin-left:auto` 的右推力也没了** →「解散对局」会塌到信息项后面。要补 `html.force-landscape .game-hud > .hud-danger { margin-left: auto }`（`.game-hud >` 是为了比文件更后面的 `html.mobile-layout .hud-danger{margin-left:0}` 更具体）。
  3. **尺寸/内边距必须写在 `html.force-landscape .force-exit`（(0,2,1)）里**：`html.mobile-layout button` 的 `padding:10px 18px; min-height:44px` 是 (0,1,1)，基础 `.force-exit` 的 (0,1,0) 压不过它，写在外面这枚钮会变成一坨宽扁空框（与 §5.8 的 `.chat-ico` 同一类坑）。
- **⚠️ 逻辑旋转容器内，一切「视口相关量」都会算错**（本次"内容被裁剪"的全部成因，逐个都踩过）：
  | 失效的东西 | 症状（实测） | 正确做法 |
  |---|---|---|
  | `vw` / `vh` 单位 | 首页卡片沿用 `calc(100vw − 32px)` → 被压成 358 宽（应 600），换行变多、高 538 > 容器 390 → 上下被裁 | 一律用 `--ld-w` / `--ld-h`（JS 按可视视口算好的容器逻辑尺寸） |
  | `@media (max-width/height…)` | `@media (max-width:460px)` 被误触发 → 首页两张模式卡从并排变堆叠，卡片 347→471 → 撑破容器 | 改用类断点 `html.land-narrow` / `.land-wide`，并在 `html.mobile-layout` 内显式覆盖基础规则的 vw/vh |
  | `env(safe-area-inset-*)` | 旋转后物理四周与布局四周错位（物理上→布局左、右→上、下→右、左→下），刘海会压住内容 | 用 `--ls-*`（默认等于 `--sa-*`，在 `html.force-landscape` 内互换） |
  | `position: fixed` 的初始包含块 | —— | 无需处理：transform 会使其相对旋转容器定位，正是所需 |
  另：`height` 必须显式覆盖基础规则的 `min-height: 100vh`（`min-height` 压过 `height`），并加 `text-size-adjust: 100%` 防移动端文字自动放大撑破定尺布局。
- **栅格断点要按「容器逻辑宽度」判断**：`html.mobile-layout` 内 `.mode-cards` 恒为 1fr 1fr、`.seats` 恒为四列 —— 横屏语义宽度足够（≥640）时不该退回窄屏布局。

另：画布 backing store 按 `devicePixelRatio`（上限 2x）重建，逻辑坐标恒为 1280×640，每帧 `setTransform` 映射——绘制代码不必改。

验证（均需先起服务端，建议 `MAHJONG_CEREMONY=0 MAHJONG_FIXED_SEATS=1`）：
`node scripts/mobile_shot.mjs`（4 视口 + 桌面布局度量）、`node scripts/mobile_interact.mjs`（点手牌条出牌 / 点画布出牌 / 竖屏提示 / 聊天未读红点）、
`node scripts/mobile_orient.mjs <局域网IP> <端口>`（能力探测 / 全屏进退 / 遮挡 / 强制横屏 / 静态资源）、
`node scripts/mobile_clip_check.mjs <端口>`（**改任何尺寸/间距后必跑**：裁剪与越界审计）、
`node scripts/mobile_exit_btn_check.mjs <端口>`（**改动强制横屏任何浮层后必跑**：首页/大厅/对局 × 宽窄两种横屏，量退出钮的逻辑坐标、有没有压住可点元素、点得动吗；并把躺倒的原始截图转成「未旋转预览」）。
`node scripts/mobile_orient_shot.mjs`（截图，含真实对局的强制横屏）。
> ⚠️ 强制横屏下整页被逻辑旋转 90°，`page.screenshot()` 拿到的是**物理竖屏**帧缓冲（图是躺倒的）。
> 要看「人眼视角」就换成等价的横屏视口，并**临时注入 `html.force-landscape body{transform:none}`** —— 只把旋转抵消掉；
> **不能摘 `force-landscape` 类**（会把该作用域的规则一起丢掉，预览就假了），也**不能自己 dispatch resize**（`scheduleSync()` 会按 JS 变量把类加回来）。
> `mobile_exit_btn_check.mjs` 里的 `previewShot()` 就是干这个的，可直接抄。
> 脚本里访问玩家用**独立 context**（同一 context 的多个标签页共享 localStorage，会互相串 token 导致 join 随机失败）；等就绪要等**脚本生成**的元素（如 `#bg-opts .bg-opt`），`#mode-create` 是静态 HTML、监听器可能还没绑上。
> 表单 `#code` 上挂有 +30ms 自动聚焦：`fill` 后**必须回读校验**并重试，否则会被聚焦/清空竞态吃掉（表现为「加入房间超时」）。

### 5.7 牌桌渲染（`client/src/table.ts` + `style.css` 的 `#table`）

- **画布尺寸一律「由宽度反算高度」**。桌面端 `#table` 用 `width: min(100%, 1100px, calc((100vh − 225px) × 2))` + `height: auto` + `aspect-ratio`；**不要**写回「定死 height + `max-width: 100%`」——那种写法在容器比「高度×2」窄时会把宽度裁掉而高度不动，画布盒≠内容盒，牌面被非等比拉伸（2026-10-15 修：800×600 下实测 1.957 而非 2.0）。`fitCanvas()` 只在触摸横屏时用行内 height 接管（它自己保证 ≤ 可用宽/2，故不触发裁剪）。
- **牌墙竖段墩距自适应，段长（`SEG_LEN`）不可改**。牌墙 4 段随庄家视角旋转（`wallSegs()` 的 `screen = (dealerDisp + r) % 4`），庄家在自己上/下家方位时 20 墩的**长段会竖着摆**——按 `WALL_PITCH=30` 长达 ≈592px，会一路伸进手牌带（手牌 y=560，摸到的牌抬起后 546），把手牌外侧的牌挡掉。因此 `segPitch()` 对竖段压缩墩距，使整段下端不超过 `WALL_V_LIMIT=540`；横段仍用 `WALL_PITCH`（外观与修改前完全一致）。**所有牌墙取位都必须走 `slotPos()`**（它内部用 `segPitch/segSpan`），自己另算 span 会与正精立牌、杠骰补牌、起牌墩高亮错位。
- **名牌（座位角标）贴四角**：`drawTag()` 的 `pos` 按「该玩家自己左手边的桌角」取——下→左下、右→右下、上→右上、左→左上。别写回「各边中段」（会压住牌河/牌墙）。
- **赣州中心并排显示「正精 + 它对应的副精」**：`GzJingView.zheng[0]` 是翻出的**明面正精**、`fu[0]` 是它对应的副精（`gzFlip` 保证 `fu[i]` ↔ `zheng[i]`）；服务端**未揭晓时也下发 `fu[0]`**，其余 10 张结算才揭晓。`drawTile` 的精牌描边判定用的是 `view.gz.zheng/fu`（不再只看 `revealed`），所以副精进行中就有紫边。
- **⚠️ 副精 = 正精的「下一张序数牌」，按牌面推导，与牌墙位置无关**（2026-10-16 修订，**此前两版口径均已作废**：一版按槽位 +1、一版按取牌顺序）：一万→二万、九万→一万、北→东、白→中（分组独立循环）。唯一实现在 `shared/src/tiles.ts` 的 `nextJing()`，赣州经 `gzjing.ts` 的 `gzFuOf()` / `gzJingFu()` 转出——**改副精只动这两处**，`gzFlip()` 里不要再碰槽位/`nextSlot`。
- **三类精牌（`gzjing.ts` 的 `GZ_JING_CATEGORIES` 是权威定义，改规则先改它）**：
  - ① **明面正精** 1 张 = 翻出的那张，`visible: true`；
  - ② **隐藏正精** 5 张 = 正精墩下张 + 前后邻墩各 2 张，`visible: false`，**即使被摸到也不能当「精」（万能牌）凑牌型**，只按正精计 2 分；
  - ③ **副精** 6 张 = 每张正精的下一张序数牌，只有 `fu[0]` 公开，1 分/张。
  - 三类**计分口径一致**（都进 `gzJingSlots`、都参与冲关 / 精霸 / 打出全包），差别只在判定与可见性；**「能否当精」三类全 false**，且是结构性保证——`gzDecompose` 连 wild 参数都没有、`gzIsWildcard()` 恒 false，开通配必须先改这两个入口。
  - 可见性只有 `gzJingPublicTiles()` 一个出口（对局中给 2 张，结算全开），服务端 `gzJingView()` 走它，别在别处另写一份。

### 5.8 局内聊天框（`index.html` 的 `#chat` + `style.css` 的 `.chat-*`）

- **固定尺寸的小图标钮必须显式 `padding: 0`**。全局 `button{padding:10px 22px}` 加上 `box-sizing:border-box`，会让指定 `width:30px` 的 `.chat-ico` 被「内边距+边框(46px)」兜宽成 **46×30 的宽扁空框**，内容盒被挤成 0 宽、表情图标溢出（2026-10-15 修）。凡 `width/height` 写死的小按钮，都要检查是否继承了全局 padding。
- **默认最小化**：`initChat()` 结尾统一 `applyChatCollapsed(true)`（桌面/移动一致）；收起态的默认外观不能遮牌桌右下角。
- **弹层与窗口收展必须同步**：CSS 里 `.chat.collapsed .chat-pop{display:none}` 的**特异度会被 ID 规则压过**——`#chat-emoji:not([hidden]){display:grid}` 是 (1,2,0) > (0,2,0)，所以那条网格规则必须写成 `.chat:not(.collapsed) #chat-emoji:not([hidden])`；JS 侧在收起时再调 `closeChatPops()` 清掉弹层状态，二者一起保证「最小化后表情面板不残留」。
- **表情与快捷语一律「点击即发送」**：`#chat-emoji` / `#chat-quick` 里的 `.chat-chip` 点一下就 `sendChat(文本)` 并关掉弹层（`hidden = true` + 去掉 `active`），**不写回 `#chat-input`**（2026-10-15 改：表情此前是「插入输入框」，用户还得再点一次「发送」，两步操作且会污染已输入的草稿）。改这块时注意：直接发送意味着**输入框里的草稿必须原样保留**，验证脚本 `scripts/chat_e2e.mjs` 会断言 `emoji_sent_directly` / `emoji_input_untouched` / `emoji_pop_closed` 三条。
- **收起态未读红点**（`#chat-badge`，2026-10-15 加）：`addChat()` 里判断「非自己 + 面板处于 `.collapsed`」才 `chatUnread++` 并 `renderChatBadge()`；展开（`applyChatCollapsed(false)`）与离房时清零。两个易错点：
  - `.chat-badge` 写了 `display:inline-block`，**会压过 UA 的 `[hidden]{display:none}`**（同特异度、作者样式优先），必须显式补 `.chat-badge[hidden]{display:none}`——同 §5.8 上一条的 `.chat-pop[hidden]` 是同一类坑。
  - 宽横屏（`html.mobile-layout.land-wide .chat{width:150px}`，(0,3,2)）**比 `.chat.collapsed{width:46px}`（(0,3,1)）更具体**，收起态会变成一条 150px 空盒子、红点飘在离图标很远的地方 → 已补 `html.mobile-layout.land-wide .chat.collapsed{width:46px}`（(0,4,1)）压回去。**改 `.chat` 宽度相关规则时先数一遍特异度**。
  - 桌面端红点是标题栏里的 flex 项（`margin-right:auto` 让它紧贴标题、同时把收起按钮顶到最右）；移动端收起态没有标题，改为绝对定位挂到圆钮右上角（`.chat.collapsed` 该状态下额外 `overflow:visible`，否则基础 `.chat` 的 `overflow:hidden` 会把探出 3px 的红点裁掉）。

### 5.9 互动表情与铭牌气泡（`main.ts` + `table.ts`）

- **一次投掷，全房各播一遍**。客户端发 `{t:'emote', target, emote}`（`emote` 只传 `THROW_EMOJI` 的 id），服务端校验「目标座位有人 + 不是自己 + id 在表内」后**广播给全房** `{t:'emote', from, target, emote}`；各端收到后自己在 `table.pushEmote()` 播动画。**动画不是服务端下发的坐标，而是各端用本地 `tagRects` 算出来的**——所以改铭牌位置时动画会跟着走，不用同步任何东西。
- **表情表是唯一扩展点**（`shared/src/index.ts` 的 `THROW_EMOJI` + `THROW_EMOJI_TONES`）：加/删/改一行即可，**前端面板（按 `tone` 分「捧场 / 捣蛋」两组）、服务端校验、气泡文案会同时跟着变**，不需要动其它文件。**别改已有条目的 `id`**（旧客户端/历史协议对不上），换 `icon` / 改 `name` / 调 `tone` 都安全。`tone` 只有 `'good' | 'bad'` 两种，新增语气要同时补 `THROW_EMOJI_TONES` 一行与 `.emote-group` 的配色。
- **入口有两个**：牌桌 HUD 的「🎯 互动」按钮，以及**点对手铭牌**（`Table.onTagClick`，在 `onClick` 里**先于出牌判定**，命中即 return）。铭牌钉在四角、离手牌带很远，不会抢走出牌的点击。
- **铭牌气泡有「几何预算」，别随手改宽**：气泡贴四角铭牌朝画布内侧长（下排往上、上排往下），宽度分两档 —— 下排铭牌上方紧邻**左右两家的手牌背**（x 160..182 / 1092..1114，纵向到 y≈576），只剩 ~140px（`BUBBLE_W_NARROW`）；上排下方是空地，可放宽到 230px（`BUBBLE_W_WIDE`）。最长 3 行、超出截断加省略号，最后统一 `clamp` 在画布内。**这几个数字一起保证气泡不压手牌（y≥546）、牌墙列（x 284..317 / 960..1000）、牌河与副露**；要放大气泡先回来看这段。
- **连续帧**：`render()` 末尾的排帧条件已从「仅 playing」改为「playing **或** 有表情动画 **或** 有气泡」——否则摊牌/结算时动画会卡在第一帧。`pushEmote`/`pushBubble` 自己也会 `scheduleFrame()`（它们是在 WS 回调里调用的，不在渲染帧内）。
- **字数上限只有一个来源**：`shared` 的 `CHAT_TEXT_MAX`（客户端 `maxlength` + 服务端 `slice` 共用），别在 `index.html` 里再写一个数。

### 5.10 赣州报杠（展示三张）（`game.ts` + `index.html`/`main.ts`/`table.ts`）

规则规格 `docs/rules/ganzhou.md` §8.5。机制与坑：

- **开关走契约**：`FlowConfig.declaredKong`（`rules/types.ts`，仅 `rules/ganzhou.ts` 置 true）。引擎一律判 `this.rules.flow.declaredKong`，**不要写成 `this.gz` 之类的 id 判断**——这是流程能力，不是赣州专属身份。
- **冻结的三件事**：① 声明者**不能打**（`discard()` 里挡）② **不能进吃碰组合**（`claimOptionsFor` 过滤用到冻结牌面的 `chiOptions`；该牌面也不给他 `peng`）③ **可正常参与胡牌判定**（`gzBuildWin`/`tryBuildWin` 零改动，别"顺手"剔除冻结牌——那会把"冻结期间仍可胡"改坏）。
- **强制出牌只在"轮到自己出牌时"生效**（`mustDiscard` 非空则只能打其中一张）；不打断别人回合、不即时打出。托管出牌（`server/index.ts` `syncAuto`）必须**优先打 `mustDiscard`**，否则会打错牌被服务端拒。
- **第 4 张的窗口收窄 + 预填杠**：被展示牌面被打出时，他家只留 `hu`（碰/吃/杠全去掉），声明者的 `gang` **预填进 `responses` 且不进 `awaiting`**——所以他不会被询问、`respond()` 的 `awaiting.includes` 天然挡掉二次操作；`awaiting` 只含能胡者，**空则立即 `resolvePending()` 杠成立**（否则会走 `advanceTurn` 把牌放走）。一炮一响 `huLock` 照旧。
- **自摸第 4 张 = 自动杠**：`advanceTurn()` / `doGangDraw()` 摸牌入手机后立刻查 `declaredKongs.get(t)?.seat === this.turn` → 副露 `angang` + `logGang` + 解除挂起 + `drawReplacement()`（允许连杠、牌墙尽则流局）。**别忘了 `doGangDraw`**——杠补牌也可能摸到第 4 张。
- **协议三字段**（`GameView.declareOptions / declared / mustDiscard`，南昌恒空数组）：`declared` 是对手明牌渲染的唯一来源（`table.ts` `drawBacks` 把该家展示的每副 3 张画成明牌，槽位取前排、不新增几何常量）。
- **计分零新增**：杠成立走既有 `gzGangs`（2 分进交叉）；打出者是精牌时 §5.6 全包照旧（`gzPacks` 路径未动）。

### 5.11 人机 / 托管（`server/index.ts` + `client`）

- **三种「服务端代打」同一套**：机器人（`isBot`）、手动托管（`auto`）、掉线（`ws === null`）都由 `syncAuto()` 驱动。AI 最简：响应窗口 胡＞杠＞碰＞过（不点吃）；回合 自摸＞暗/补杠＞打「留手价值最低」的牌（对子/邻张留手，精牌 +50 强留，平手优先打刚摸的 `drawn`）。托管出牌**优先打 `mustDiscard`**、绝不打自己冻结的展示牌（§5.10）。
- **机器人**：房主在大厅 `addBot` 补位（满 4 人 / 对局中不可加）、大厅 `removeBot` 移除；机器人 `ready=true`、`ws=null`、token **不注册**进 `tokens`（不可 resume）；满 4 人后自动掷定庄骰（`syncBotDealerRolls`，并列重掷后自动补掷）。
- **手动托管**：对局 HUD「托管」按钮发 `setAuto`，可随时开关；托管中该按钮高亮、牌桌铭牌显示「托管中」（`GameView.auto`，广播时由服务端按 `isBot || auto || ws === null` 填充）。
- **两个易错点**：① 出牌调度**不能只看 `justDrew`**——吃/碰后 `justDrew=false` 但仍须出牌，`syncAuto` 按「轮到你且无窗口」调度；② 窗口代应答只看 `waitingSeats`（未答复者），不能用 `awaiting` 全量（含已答复者会互相等、卡到超时）。
- **节奏**：机器人用 `MAHJONG_BOT_MS`（默认快），人类托管 / 掉线沿用 `MAHJONG_AUTO_MS`。
- 大厅座位卡：机器人不可换位（恒 `ready`）、房主卡片带「移除」按钮；`addBot`/`removeBot` 仅房主且仅大厅（`room.game` 为 null）。

## 6. ⚠️ 铁律：规则/算分改动流程
`docs/rules/<玩法>.md` 已声明"**改动规则须先改本文档**"，且未覆盖组合以 `packages/shared/src/` 的实现为准。任何算分/牌型改动**必须**按此顺序，缺一步都会让文档与代码打架：

1. **先改 `docs/rules/<玩法>.md` 的算分/牌型章节**（南昌 §6.2 算子表；赣州 §6 牌型底分与 §7 结算）。
2. **同步 shared 实现**：南昌 `score.ts`（`classifyPattern`/`computeSettlement`）；赣州 `gzconfig.ts`（数值）+ `gzwin.ts`/`gzscore.ts`（判定与结算）。
3. **跑 `npm run typecheck`（零报错）+ `npm run build`**，并按文档表格**人工复算典型行**（见 §8 清单）。
4. **按玩法实测**：改动涉及翻精/胡型/结算的，起两个浏览器标签按 `docs/integration/ganzhou.md` §6 或 `docs/rules/nanchang.md` §10 的清单走一遍。

> 易错点：只改代码忘了文档 → 下次有人以文档为准反向"修"代码，来回拉扯。改一处须两处同改。

## 7. 调试钩子（环境变量）

服务端读取以下环境变量（默认见 `server/src/index.ts`）：

| 变量 | 默认 | 用途 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `MAHJONG_TURN_MS` | 15000 | 响应窗口（共享 15s 倒计时） |
| `MAHJONG_AUTO_MS` | 3000 | 掉线 / 手动托管自动出牌等待 |
| `MAHJONG_BOT_MS` | 1200 | 机器人自动掷骰 / 应答 / 出牌的等待（更快的凑桌体验） |
| `MAHJONG_THROW_DICE` | `1` | 掷骰补杠开关（`'0'` 关 → 摸倒数第一张） |
| `MAHJONG_CEREMONY` | `1` | 掷骰仪式总开关（`'0'` 关） |
| `MAHJONG_DEAL_MS` | 6500 | 开局发牌动画窗口 |
| `MAHJONG_ROLL_MS` | 2600 | 杠后掷骰动画窗口 |
| `MAHJONG_FIXED_SEATS` | 未设 | 设 `1` → 加入者按空位顺序入座（本地手动验证用，入座可复现） |
| `MAHJONG_RECON_MS` | 30000 | 断线宽限：掉线后保留座位 + token 多久（大厅/摊牌阶段届满才移出；对局中只托管不移出） |
| `MAHJONG_PING_MS` | 15000 | 心跳 ping 间隔。半开连接（合盖/掉网不发 FIN）只能靠它探活 |
| `MAHJONG_PONG_TTL_MS` | 45000 | 多久没收到 pong 就掐断连接 → 走「掉线托管 + 重连宽限」 |

> 断线相关行为一览：`ws` 正常关闭 → 对局中托管 / 大厅宽等；半开连接超时 → 同上；
> 宽限内凭 `token` `resume` 回原座位（客户端断线后会自动重连，退避 1s→4s，约 34s 覆盖宽限期）。

## 8. 验证清单（提交前自检）

- [ ] `npm run typecheck` 无错（strict）；改动协议/渲染层另跑 `npm run build`
- [ ] 改了算分/牌型 → 对应 `docs/rules/<玩法>.md` **已同步**，且按其表格人工复算过典型行
- [ ] 结算守恒：四家 `delta` 之和恒为 0（人工抽查结算面板，勿破坏）
- [ ] 改动流程/交互 → 至少起两个标签实测一遍（见 `docs/integration/ganzhou.md` §6 清单）
- [ ] 翻精前不下发 `jingPi/jingFu`；等待掷骰阶段不自动掷
- [ ] 重连：`token` 有效、可 `resume` 回原座位；掉线进入托管不影响对局推进
- [ ] 换位后 **`binding`/`tokens`/`hostSeat`/`nextDealer` 四者一致**（换位后刷新页面能 resume 回新座位）
- [ ] 新增玩法：只改 `rules/`（新实现 + 注册一行），**不动 `server/game.ts`**；旧客户端不传 `variant` 仍可正常开局
- [ ] 改动聊天/互动表情 → 四家视角各看一眼：投掷动画四端都出、气泡挂在正确那家铭牌上、约 4 秒后自动消失、**气泡没有压到手牌/牌墙/牌河**（可用 `scripts/chat_e2e.mjs` 打底，再看截图）
- [ ] 改了赣州报杠（§5.10）→ 展示后三张亮明且打不出、持有者被强制出牌、第 4 张只可胡且自动杠 +2 分、自摸第 4 张自动杠、**冻结期间仍可胡**；南昌无「展示」按钮

## 9. 不要做的事（常见坑）

- ❌ 把规则/算分逻辑写进 `packages/client`——前端只渲染 `GameView`，所有判定在服务端 + `shared`。
- ❌ 改算分倍数/牌型却不改 `docs/rules/<玩法>.md`（见 §6 铁律）。
- ❌ 把 `Tile` 当字符串或中文处理——全程数字 id 0–33。
- ❌ "优化"掉掷骰仪式的等待卡点（设计为无点击不自动掷）。
- ❌ 混淆 `abort`（房主解散**对局**，房间保留）与 `dissolve`（房主解散**牌桌**，全员最终积分弹窗）。
- ❌ 用 `ts-node`——本仓库用 `tsx`（`npm run start` / `dev:server`）。
- ❌ 在 `server/game.ts` 里 `import` 具体玩法（`nanchang.ts`）——引擎只能经 `RuleSet` 契约取能力，否则新增玩法就"必须改核心代码"。
- ❌ 只改 `room.players[].seat` 而漏改 `binding`/`tokens`（换位、重连会按旧座位找人）。
- ❌ 在入口向导里让某一步的选择"不留痕"——每一步的标题 / 表单 / 步骤条标签都必须反映前序选择，否则分步导航就退化成了一张长表单。
- ❌ 给「加入房间」分支也塞一个玩法选择步——玩法由房间决定，让用户选是误导。分支步骤数不同是**特性**（`stepSeq()`），不是 bug。

## 10. 关键文件索引（快速跳转）

- 协议类型 / 牌视图：`packages/shared/src/index.ts`
- 牌编码工具：`packages/shared/src/tiles.ts`
- 算分落地：`packages/shared/src/score.ts`（与 `docs/rules/nanchang.md` §6 对齐）
- 对局引擎：`packages/server/src/game.ts`
- 房间/协议/定时器/换位：`packages/server/src/index.ts`
- 入口流程与大厅换位 UI：`packages/client/src/main.ts`（`renderVariants` / `renderLobby` / `requestSwap`）
- 规则权威文档：`docs/rules/nanchang.md`
- 赣州规则：`docs/rules/ganzhou.md`；赣州接入说明：`docs/integration/ganzhou.md`
- 开发辅助脚本（截图/布局/交互核对）：`scripts/`
- 文档索引：`docs/README.md`
- 多玩法契约（RuleSet 接口）：`packages/shared/src/rules/types.ts`
- 多玩法注册表：`packages/shared/src/rules/index.ts`（`VARIANTS` / `getRules` / `VARIANT_LIST`）
- 多玩法架构设计（含迁移分期 P0–P5）：`docs/architecture/multi-variant.md`
