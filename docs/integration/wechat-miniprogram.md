# 微信小程序迁移可行性与实施方案

> 评估对象：`nanchang-mahjong`（网页版麻将，Vite + 原生 DOM canvas + Node `ws` 服务端）。
> 目标：把现有对局整体迁移到微信小程序运行，同时不破坏规则层与既有 web 版。
> 结论先行：**整体可行**。规则/算分/服务端 100% 保留、零改动；客户端是唯一改造面；
> 工作量集中在 DOM 界面重写（canvas 牌桌可高保真移植）；三项硬前置需**并行提前启动**——
> ① 棋牌类目合规资质，② 备案域名 + HTTPS/WSS 公网部署，③ 包体积治理。

---

## 1. 现状盘点

### 1.1 技术栈

| 维度 | 现状（`agent.md` §2） |
|---|---|
| 语言 | TypeScript strict，ESM，`tsc --noEmit` 仅做类型检查 |
| 服务端 | Node + `ws`（WebSocket），`tsx` 直跑 `.ts`；单进程同时托管静态 `packages/client/dist` + `/ws` 对局 |
| 前端 | Vite 5，**原生 DOM 命令式渲染**（无框架），Canvas 2D 画 1280×640 牌桌 |
| 共享层 | `packages/shared/src`（规则/协议/算分），被 server & client 共同依赖，**纯 TS、零 DOM** |
| 运行时依赖 | 客户端 **0 个 npm 运行时依赖**；`vite/tsx/ws/typescript/@types` 全在 devDependencies |
| 部署形态 | 局域网 HTTP（`http://192.168.x.x:3130`），分享靠复制 URL（`?room=`） |

### 1.2 代码规模与浏览器依赖度

| 文件 | 体积 | 职责 | 小程序侧处置 |
|---|---|---|---|
| `shared/src/*`（21 文件） | ≈ 98 KB | 规则/算分/协议/精牌，**无任何 DOM/BOM 引用** | **原样保留**（编译产物入包） |
| `server/src/index.ts` | 61 KB | 房间/协议/定时器/换位/静态托管 | 基本原样，仅运维与心跳适配 |
| `server/src/game.ts` | 58 KB | 对局引擎（状态机/胡锁/精牌） | **零改动** |
| `client/src/table.ts` | 60 KB | Canvas 2D 牌桌渲染（全部绘制逻辑） | **移植**（API 面高度重合） |
| `client/src/main.ts` | 72 KB | 向导/大厅/聊天/表情/结算/弹窗，全命令式 DOM | **重写**为 WXML + setData |
| `client/src/style.css` | 56 KB | 全部样式（含移动端专区、`@media`、`env(safe-area)`） | **重写**为 WXSS（rpx/flex） |
| `client/src/mobile.ts` | 24 KB | 全屏/方向锁/强制横屏/`visualViewport`/手牌条 | **大部分删除**（小程序原生横屏替代），手牌条改组件 |
| `client/src/tileart.ts` | 1.2 KB | `import.meta.glob` 异步加载 PNG | 改为显式表 + `canvas.createImage()` |
| `client/index.html` | 16 KB | 挂载点 + 首帧预置脚本 | 拆成 `app.json` 路由 + 各页 WXML |
| 资源 | tiles 34×≈133KB ≈ **4.5MB**；bg 3 张 ≈ **4.0MB** | 牌面贴图 + 背景纹理 | **压缩/分包/CDN** |
| `dist` 现状 | **6.9MB** | web 构建产物 | — |

### 1.3 页面结构（客户端三个视图 + 覆盖层）

- `#view-home`：分步向导（创建/加入 → 选玩法 → 表单）+ 背景切换器。
- `#view-table`（大厅）：房间码/分享、四座位卡（换位/准备/加机器人/移除）、定庄骰区、事件 feed。
- `#view-game`：HUD + Canvas 牌桌 + 状态/控件 + 聊天/记录面板 + 手牌操作条。
- 覆盖层：结算面板、解散确认、换位请求、玩法切换确认、掷骰动画、toast、竖屏引导、强制横屏退出钮。

### 1.4 构建与运行方式

`npm run build`（vite → `packages/client/dist`）→ `npm run start` 起 Node 进程托管。WebSocket 协议为 JSON、`t` 字段区分（`shared/src/index.ts` 的 `ClientMsg`/`ServerMsg`），**协议与端无关**——这是双端互通的基础。

---

## 2. 阻塞项逐项分析

### 2.1 浏览器专有 API

| API / 用法 | 出现位置 | 小程序替代 | 改造性质 |
|---|---|---|---|
| 命令式 DOM（`createElement`/`classList`/`append`） | `main.ts` 全篇 | WXML + `setData` | **重写**（主要工作量） |
| Canvas 2D（`ctx.*`、`getContext('2d')`、DPR backing store、`getBoundingClientRect` 点击换算） | `table.ts` 全篇 | `<canvas type="2d">` + `SelectorQuery` + `createImage()`；**API 面 95% 重合** | **移植**（适配取图/取坐标/rAF） |
| `import.meta.glob`（Vite 专有） | `tileart.ts` | 显式文件名表或 `require` | 小改 |
| `localStorage`（`mj-name`/`mj-token`/`mj-room`/`mj-bg`/`mj-variant`） | `main.ts`/`mobile.ts` | `wx.setStorageSync`/`getStorageSync` | 一行级替换 |
| `URLSearchParams`(`?room=`) / `history.replaceState` | `main.ts` | 页面 `onLoad(options)` / `wx.reLaunch` | 小改 |
| `document.execCommand('copy')` / `navigator.clipboard` | 分享按钮 | `wx.setClipboardData` + `wx.showShareMenu` | 小改 |
| `window.confirm` | 解散/解散对局 | `wx.showModal` | 小改 |
| `screen.orientation.lock`/Fullscreen/`visualViewport`/`force-landscape` CSS 旋转/竖屏遮罩 | `mobile.ts` 约 60%、`index.html` 预置脚本 | **全部不需要**：`page.json` 声明 `"pageOrientation": "landscape"` 原生横屏，安全区用 `wx.getSystemInfoSync().safeArea` | **整段删除**（净减少代码） |
| `matchMedia('(pointer: coarse)')` / UA 探测 | `mobile.ts` | `wx.getSystemInfoSync()` | 小改 |
| `ResizeObserver` | `mobile.ts` 画布适配 | 页面 `onResize` + SelectorQuery 量容器 | 小改 |
| `performance.now()` | `table.ts` 动画时间轴 | `Date.now()` | 小改 |
| `setInterval`/`setTimeout`/`requestAnimationFrame` | 全客户端 | 同名 API；canvas 内 rAF 用 `canvasNode.requestAnimationFrame` | 零改 |

**要点**：Canvas 层是小程序迁移的最大利好——`table.ts` 的牌墙/罗盘/手牌/牌河/精牌描边/飞行动画全部是标准 2D 绘制，不存在小程序无法表达的能力。真正的成本在命令式 DOM 的界面重写。

### 2.2 第三方 npm 依赖

客户端运行时**零第三方依赖**（仅 vite/tsx/ws/ts 在 devDeps），因此不存在依赖兼容问题；vite 只服务 web 构建，小程序侧用官方工具链，互不干扰。`ws` 留在服务端（Node），与小程序 SDK 无关。

### 2.3 网络请求、域名与证书（**硬阻塞**）

- 小程序 `wx.request`/`wx.connectSocket` 只允许**白名单域名**：request/upload/download/socket **四类分列为独立配置**，每类上限 200 个。
- 协议限制：request 系只支持 **HTTPS**，WebSocket 只支持 **wss**；**不能用 IP/localhost**（仅局域网 IP 例外且不许本机）。
- 域名必须 **ICP 备案**（新备案需 24h 后才可配置），证书需受信任 CA、TLS ≥ 1.2；若配置带端口（如 `:3130`）则**只能访问该端口**，因此建议 **443 反代 + 无端口域名**。
- 当前项目定位就是「局域网 HTTP 联机」——**该形态在微信侧直接失效**：真机/体验版/正式版必须走公网 WSS。局域网调试只能靠开发者工具勾选「不校验合法域名」。
- 影响：必须准备一台公网服务器 + 备案域名 + 证书；这是 P0 前置，不是代码问题。
- 附带协议适配：`wx.connectSocket` **不能发自定义 ping 帧**，现有服务端心跳（`MAHJONG_PING_MS` 15s / `PONG_TTL` 45s）依赖 ws 级 ping/pong。需增加**应用级心跳**：客户端每 10s 发 `{t:'ping'}` 文本，服务端据此更新存活（web 端 ws 级 ping 保持不变，双协议并存）。

### 2.4 登录鉴权

现状**没有账号体系**：昵称 + 6 位房间码 + `token`（localStorage）即完成身份与断线重连。两条路线：

- **路线 A（推荐，零侵入）**：沿用匿名 token，仅把存储搬进 `wx.Storage`；`token` 仍随 `state` 消息下发，断线重连逻辑原样。
- **路线 B（可选增强）**：`wx.login` → code → 服务端 `code2session` 换 openid，与 token 绑定，解决"换手机/清缓存失座"问题；需在小程序后台声明 openid 用途，并处理用户隐私协议弹窗。

不涉及微信支付、虚拟货币，无额外鉴权阻塞。

### 2.5 包体积与性能约束

| 约束 | 官方限制 | 本项目现状 | 处置 |
|---|---|---|---|
| 主包 | 小程序 **≤ 2MB**（小游戏为 4MB，按 2MB 设计最稳妥） | 若直接搬 dist ≈ 6.9MB → **超 3 倍** | 代码进主包（估 200–400KB），**资源全部外置** |
| 单个分包 | 小程序 ≤ 2MB | tiles 4.5MB 必须治理 | 压缩后 ≤ 1.2MB 可装单包 |
| 总包 | ≤ 30MB（服务商 20MB） | 压缩后全量 ≈ 1.5–2MB，余量充足 | — |

- 牌面 PNG 34 张 ×133KB（合计 4.5MB）对牌面资源严重偏大 → PNG→WebP / 降色域 / 雪碧图合并后预计 **≤ 1.2MB**。
- 背景纹理 3 张合计 4.0MB（平铺背景 JPEG/WebP 化后约 200–400KB）→ 仍建议走 CDN 下载后本地缓存，或干脆改为 CSS 渐变（web 版已可这么做，实现跨端一致）。
- 性能红线（对应 MIT 经验）：① `setData` 只传变化字段、控制频率（倒计时 100ms → 200ms 且非 playing 态停表）；② 聊天/日志 200 条上限保留，用 `scroll-view`；③ canvas 用 `type="2d"` 同层渲染（基础库 2.9.0+），覆盖层（骰子/结算/表情面板）用普通视图叠加即可；④ 牌桌 rAF 循环独立于 setData。

### 2.6 合规资质（**第一风险**）

- 若按**游戏类目**上架（小游戏/小程序-游戏）：棋牌类需《软著》《网络游戏出版物号核发单》《产品合规报告》《产品运营报告》等材料，且**2025 起平台持续抽查涉赌内容**，材料不齐会被限制新增用户/分享/虚拟支付。
- 小程序**名称不得直接使用"麻将"等通用词**（有"斗地主"被拒、改为"XX棋牌对战"通过的先例）。
- 红线：不做房卡买卖、不做任何提现/充值、积分仅局内娱乐——本项目现状（纯积分、无支付）天然合规，但主体建议用**企业主体**。
- 建议：P0 阶段即在公众平台确认目标类目与资质清单，软著办理周期约 30 个工作日，**与开发并行启动**。

---

## 3. 迁移路径选型

| 方案 | 思路 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **原生重写**（推荐） | `packages/miniapp` 独立小程序工程；shared 编译产物入包；canvas 移植 + 界面 WXML 化 | 完全掌控性能与包体；shared/server 零改动；双端协议互通 | 工作量最大 | ✅ **推荐** |
| Kbone | 官方 DOM 模拟层，H5 代码低成本搬进小程序 | 初期快 | 命令式 DOM + rAF/setInterval 密集页面（本项目正是）会被翻译成大量 setData，性能与坑（canvas、动画、样式）风险高 | ✗ 不推荐 |
| Taro / uni-app | 用 React/Vue 重写后再编译小程序 | 跨端 | 等于**全量重写**现有 vanilla 界面，收益（本项目只多一个端）不成立 | ✗ 不推荐 |
| web-view 兜底 | 小程序内嵌现有 H5 | 工作量最小 | 仅**企业主体**可配业务域名；体验（横屏/输入法/滚动/切后台）明显受损；审核仍看类目内容 | ⚠️ 仅作临时过渡 |

**推荐架构**：

```
packages/shared/        ← 不动（纯 TS，无 DOM）
packages/server/        ← 不动（仅运维/心跳适配）
packages/client/        ← 不动（web 版继续服务存量用户）
packages/miniapp/       ← 新增：原生小程序工程
  ├── project.config.json / app.json / sitemap.json
  ├── miniprogram/      主包（页面/组件/WXSS/lib）
  ├── subpkg-tiles/     牌面分包（压缩后）
  └── lib/shared/       由 npm run build:mp 产出（CommonJS JS）
```

新目录挂入现有单仓，构建隔离（`tsconfig.mp.json`：`module: CommonJS`、`target: ES2017`、产物落 `packages/miniapp/lib/shared/`），不污染现有 vite/tsc 流程；`packages/shared` 的规则逻辑被 web 与小程序**共用同一份**，彻底杜绝两端规则漂移（延续项目"front 只渲染"铁律）。

---

## 4. 分阶段实施方案

> 环境约定：开发期用微信开发者工具 + 真机预览，勾选「不校验合法域名」；P0 完成后再关开关验真机。

### P0 — 服务端与运维前置（硬阻塞，立即启动，可与开发并行）
- 备案域名 + 公服 + HTTPS 证书；Nginx 443 反代 `/ws`（wss）与静态。
- 服务端：新增应用级心跳（`{t:'ping'}` 文本保活，同时保留 web 端 ws ping）；CORS 无需（同源白名单而非 Referer）。
- 后台配置：request/socket/upload/download 四类域名（`https://你的域名`，不带端口）。
- 启动**软著办理**与类目资质咨询。
- 验收：`wscat -c wss://域名/ws` 与现有 web 版同房间互通；掉线 30s 宽限/resume 保持。

### P1 — 小程序工程骨架与 shared 接入（≈3 人日）
- 建 `packages/miniapp`，`app.json` 声明三个页面（home/lobby/game，均 `"pageOrientation": "landscape"`）+ 分包规划（`subpkg-tiles`）+ 预下载规则（进大厅前预载牌面包）。
- 根 `package.json` 增加 `"build:mp": "tsc -p tsconfig.mp.json"`；产物 CommonJS 化后 `require`。
- 网络层：`utils/net.ts` 封装 `SocketTask` 单例 + 断线重连（退避 1→4s ×10，≈34s 覆盖服务端宽限，逻辑照搬 `main.ts` 的 `scheduleReconnect`）。
- 验收：`npm run typecheck` + `npm run build:mp` 通过；工具内可连真机 ws、收 `state`。

### P2 — Canvas 牌桌移植（核心，≈8 人日）
- `table.ts` → `miniprogram/components/table/`：`SelectorQuery` 取 2d canvas node；`node.createImage()` 替换 `HTMLImageElement`（`tileart.ts` 的 glob 改显式 34 项表）；DPR 逻辑保留（node.width/height 按 dpr 重建）；rAF 改 `node.requestAnimationFrame`。
- 点击换算：`bindtouchstart/bindtap` 的 `e.touches[0].x/y` − `boundingClientRect`（同为显示区基准）→ 逻辑坐标 1280×640；桌面端开发者工具支持鼠标事件。
- 骰子/结算/表情等覆盖层改普通 WXML 视图（不再画在 canvas 上），canvas 只管牌桌本体。
- 验收：按 `docs/rules/ganzhou.md` §6 / `docs/rules/nanchang.md` §10 的人工清单跑一局：牌墙取位、杠骰补牌、精牌描边、表情动画四端一致；翻精前不剧透。

### P3 — DOM 界面 WXML 化（最大工作量，≈12 人日）
按 `main.ts` 的职责逐块拆成页面数据 + 模板：
- 分步向导（三态/两分支，**保留现有"无锁定可回退"设计**）、玩法卡（读 shared 的 `VARIANT_LIST`）。
- 大厅：座位卡（换位/准备/加/移除机器人）、定庄骰区与动画（CSS 动画替代 `.tumbling`）、事件 feed。
- 对局 HUD + 控件（吃/碰/杠/胡/过/自摸/展示/托管/掷骰按钮，全部由 `GameView` 驱动，前端零规则逻辑）。
- 聊天/记录双 tab、红点未读、快捷语/表情点击即发；互动表情面板 + 铭牌直投（`table.onTagClick` 等价回调）。
- 结算面板（南昌 9 列 + 赣州 11 列逐家明细）、解散/换位/玩法切换确认弹窗、toast。
- 样式：`style.css` → WXSS，`rem/vw` → `rpx`，`@media` → 宽度判断或极简保留，`env(safe-area)` → `wx.getSystemInfoSync().safeArea` 折算。
- 分享：`onShareAppMessage` 路径 `/pages/game/game?room=CODE`（等价现有 `?room=` 预填，**预填但可改**的语义不变）+ `onShareTimeline`。
- 验收：`scripts/invite_flow_e2e.mjs` 的小程序等价路径（预填可改/上一步可回退/改码生效）+ 两真机同桌全流程。

### P4 — 平台体验适配（≈4 人日）
- 全部页面 `pageOrientation: landscape`，删除横屏兜底全家（`#force-exit`/`#rotate-hint`/强制横屏 CSS）。
- 输入法：聊天输入聚焦时页面 `adjustPosition`、`cursor-spacing` 适配；`confirm-type="send"` 发送。
- 切后台/息屏：socket 可能被回收 → 依赖 `scheduleReconnect` + 服务端宽限；`onShow` 重连探测。
- 手牌操作条（移动端 ≥44px 触控面）改 WXML 组件（复用画布牌面图）。
- 验收：低端 Android + iOS 双真机；断网/切后台/回前台矩阵。

### P5 — 资源治理（≈2 人日）
- tiles PNG → WebP/降色（预计 4.5MB → ≤1.2MB），入 `subpkg-tiles` 分包 + 预下载；备选：雪碧图 1 张。
- bg 纹理 4.0MB → CDN 下载 + 本地缓存（或 CSS 渐变，同步改 web 版统一观感）。
- 验收：上传代码主包 < 1MB、全量包 < 3MB；首屏启动 < 1.5s（中端 Android）。

### P6 — 资质、审核与灰度（≈6 人日，部分等待期）
- 主体/类目确认 → 软著与合规报告 → 提交审核 → 体验版灰度（先小范围牌友）。
- 审核要点预案：名称不用通用词；无诱导分享按钮文案（用「邀请好友」场景化转发）；隐私协议写明 openid/token 用途。
- 回滚策略：双端并存，出问题 web 版随时可用。

---

## 5. 模块改动明细

| 模块 | 处置 | 说明 |
|---|---|---|
| `packages/shared/src/**` | **零改动** | 编译为 CommonJS 产物供 miniapp 引用；规则/协议单一真相源不变 |
| `packages/server/src/game.ts` | **零改动** | 引擎与平台无关 |
| `packages/server/src/index.ts` | 小改 | 加应用级心跳分支；静态托管逻辑保留给 web 版 |
| 部署 | 新增 | 备案域名 + 443 反代 wss；替换「局域网 HTTP」假设 |
| `packages/client/**` | **不动** | web 版持续服务存量用户；协议一致 ⇒ 可与小程序同桌 |
| `packages/miniapp/**` | 新增 | 全部小程序代码（唯一新增工作量） |
| `scripts/`（playwright 体检） | 不迁移 | 属 web 端手段；小程序用真机 + 工具审计替代 |

---

## 6. 工作量评估

| 阶段 | 人日 | 关键路径 |
|---|---|---|
| P0 服务端/运维/备案 | 4 | **是**（外部周期 1–4 周） |
| P1 工程骨架/shared | 3 | 否 |
| P2 canvas 牌桌 | 8 | 是（核心保真度） |
| P3 界面 WXML 化 | 12 | 是（最大块） |
| P4 平台适配 | 4 | 否 |
| P5 资源治理 | 2 | 否（与 P3 可并行） |
| P6 资质/审核/灰度 | 6 | **是**（软著 ≈30 工作日，需与开发并行） |
| **合计** | **≈ 39 人日** | — |

- 单人连续推进 ≈ **7–8 周**；前端 + 半职后端双人 ≈ **3–4 周**。
- 建议按 ×1.3 预留平台坑缓冲（canvas 同层、分享链路、真机兼容）。
- 依赖前置：备案域名、企业主体、软著——这三项的**等待期**远大于任何开发任务，应从第一天并行启动。

---

## 7. 主要风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 棋牌类目资质被卡 | 无法上线（最高风险） | P0 确认类目；企业主体；软著/报告并行办理；先体验版内测 |
| 域名备案/证书周期 | 阻塞联调 | 提前 1 个月启动；先用「不校验域名」开发 |
| canvas 2d 机型兼容/内存 | 低端机闪退 | DPR 上限 2；贴图压缩；真机矩阵（覆盖 2019 款中低端） |
| setData 频繁卡顿 | 操作不跟手 | 倒计时停表/降频；批量合并；大列表封顶 200 条 |
| socket 切后台被回收 | 掉线托管 | 保留指数退避重连 + 30s 宽限（现有逻辑直接搬） |
| 牌面贴图失真 | 观感回归 | 压缩前后逐张 α 通道比对；不低于 2x 屏渲染 |
| 双端协议漂移 | 规则不一致 | shared 单一源码、双端编译产物；改规则仍走 `docs/rules` 铁律 |
| 审核驳回（诱导分享/名称/隐私） | 延期 | P6 预案逐条自检后再提交 |

---

## 8. 无法直接迁移的部分与降级策略

| 无法直接迁移 | 原因 | 替代/降级 |
|---|---|---|
| 局域网 HTTP 直达 | 微信禁 IP/HTTP 通信域名 | 公网 HTTPS+WSS；局域网调试只用开发者工具豁免 |
| 浏览器全屏/方向锁定/强制横屏兜底 | 小程序无对应 DOM 能力 | **反而更好**：`pageOrientation: landscape` 原生横屏，整套兜底删除 |
| `document.execCommand` 复制分享 | 无 DOM | `wx.setClipboardData` + `onShareAppMessage`（转发体验优于复制链接） |
| 4.5MB 牌面 PNG 直搬 | 主包 2MB 限制 | WebP/雪碧图/分包；极端降级：牌面用 canvas 程序化绘制文字牌（`tileName` 直绘），贴图全部省掉 |
| 4.0MB 背景纹理 | 同上 | CDN 缓存 / CSS 渐变 |
| web-view 过渡方案 | 仅企业主体 + 体验受损 | 仅资质未落地时作临时内测通道 |
| 服务端托管前端 dist | 小程序不读该产物 | 服务端保留 web 托管；miniapp 由工具链独立构建 |

---

## 9. 上线前检查清单

- [ ] 四类域名（request/socket/upload/download）+ 备案 + 证书链完整，真机关闭「不校验」复测
- [ ] 主包 < 2MB、分包 < 2MB、总包 < 30MB
- [ ] 协议双端互通：web 与小程序同桌开局、结算守恒（四家 delta 和 = 0）
- [ ] 复用现有验收清单：南昌 `docs/rules/nanchang.md` §10、赣州 `docs/integration/ganzhou.md` §6
- [ ] 断线重连 / 掉线托管 / 换位后 `binding/tokens/hostSeat/nextDealer` 一致（服务端逻辑未动，重点验小程序客户端）
- [ ] 翻精前不剧透、等待掷骰不自动掷（服务端原逻辑，客户端移植后回归）
- [ ] 分享卡片路径 `?room=` 预填可改、步骤条可回退（对照 `scripts/invite_flow_e2e.mjs` 的等价路径）
- [ ] 隐私协议弹窗、openid/token 用途声明；名称无通用词；无诱导分享文案
- [ ] iOS / Android 双真机 + 低端机型体验分屏矩阵

> 相关文档：`docs/guides/agent.md`（改动铁律）、`docs/architecture/multi-variant.md`（多玩法契约）、
> `docs/rules/nanchang.md`、`docs/rules/ganzhou.md`。
