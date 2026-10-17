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
  └── miniprogram/      ← 项目根（app.json 所在目录）
      ├── app.js / app.json / app.wxss / sitemap.json
      ├── pages/        三个页面（home / lobby / game）
      ├── utils/        网络 / 存储 / 牌桌渲染 / 牌面加载
      ├── lib/shared/   由 npm run build:mp 产出（CommonJS JS）
      └── tiles/        牌面贴图（npm run prepare:mp 产出，压缩后 ≈0.7MB）
```

> 实施时**取消了分包**：`pages: []` 的纯资源分包不会被注册，`preloadRule` 会报「未找到」导致模拟器启动失败；
> 压缩后牌面仅 731KB，与代码合计 954KB，分包已无收益。详见 §10.3。

新目录挂入现有单仓，构建隔离（`--module commonjs --target ES2017`，产物落 `miniprogram/lib/shared/`），不污染现有 vite/tsc 流程；`packages/shared` 的规则逻辑被 web 与小程序**共用同一份**，彻底杜绝两端规则漂移（延续项目"front 只渲染"铁律）。

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
- 建 `packages/miniapp`，`app.json` 声明三个页面（home/lobby/game，均 `"pageOrientation": "landscape"`）+ 分包规划（`subpkg-tiles`）+ 预下载规则（进大厅前预载牌面包）。（实施时改为并入主包，见 §10.3 #1）
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
- tiles PNG → WebP/降色（预计 4.5MB → ≤1.2MB），入分包 + 预下载；**实施结果：降到 731KB 后直接入主包（分包无收益，见 §10.3）**；备选：雪碧图 1 张。
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

## 10. 实施状态（代码已落地）

按本方案完成「原生重写」路径的落地，产物在 `packages/miniapp/`。**服务端与 shared 层未做业务改动**，
web 版（`packages/client`）保持原样，两端协议一致 → 小程序用户可与网页用户同桌对战。

### 10.1 产物清单

```
packages/miniapp/
  miniprogram/                          ← 开发者工具的「项目根」（appid 已写入 project.config.json）
    app.js / app.json / app.wxss / sitemap.json
    lib/shared/                          shared 编译产物（npm run build:mp 生成，勿手改）
    utils/
      config.js     部署地址（wss + 备案域名）
      store.js      localStorage → wx.Storage（key 与 web 端一致）
      net.js        SocketTask 单例 + 指数退避重连 + 应用级心跳
      room.js       服务端消息路由（state→大厅 / game→对局 / 其余回调当前页面）
      table.js      Canvas 2D 牌桌（移植自 client/src/table.ts）
      tiles.js      canvas.createImage() 加载牌面贴图
      ui.js         toast / confirm（替代 window.confirm）
    pages/home/     分步向导（含分享链接预填）
    pages/lobby/    房间：座位/换位/准备/机器人/定庄骰/玩法切换/分享
    pages/game/     对局：画布 + HUD + 控件 + 手牌条 + 聊天/记录 + 结算
    tiles/          牌面贴图（npm run prepare:mp 生成，≈0.7MB，入主包）
    project.config.json / project.private.config.json   开发者工具工程配置（private 已 gitignore）
scripts/
  mp_build_shared.mjs    shared → CommonJS 产物 + 导出自检
  mp_prepare_assets.mjs  牌面 PNG 降采样重编码入分包（4.42MB → 731KB）
```

### 10.2 构建与校验

| 目的 | 命令 |
|---|---|
| 编译 shared 入小程序 | `npm run build:mp` |
| 生成牌面分包资源 | `npm run prepare:mp` |
| 类型检查（含服务端改动） | `npm run typecheck` |
| 打开工程 | 微信开发者工具 → 导入 **`packages/miniapp/miniprogram`**（app.json 所在目录即项目根；首次导入后工具会生成 `project.config.json`/`project.private.config.json`） |

已完成的自检（均为临时脚本，未落入仓库，遵循「项目不保留自动化脚本」约定）：
- 全部 JS 语法检查、JSON 合法性、WXML 标签配对与 require 路径解析 —— 通过；
- 桩环境冒烟 29 项：shared 导出 / Table 渲染与命中换算 / 三页面渲染与交互 / 南昌与赣州结算表构建 / 聊天未读 —— 通过；
- 服务端 P0 实测：起服务后连 ws 发 `{t:'ping'}` 收 `{t:'pong'}`，`create`/`join` 原有协议不变，双端可同桌 —— 通过；
- 横屏布局冒烟（桩 `wx` + 跟随布局的 rect 桩）：聊天开/关时 `fitCanvas` 重新量盒（canvasW 400↔280）、`canvasBox` 跟随到新尺寸、收起态未读红点、三页生命周期 —— 通过；
- 体积：主包 973KB（含 731KB 牌面贴图），无分包（主包上限 2MB）。

### 10.3 相对方案的偏离与原因

| # | 偏离 | 原因 |
|---|---|---|
| 1 | **牌面资源最终并入主包 `miniprogram/tiles/`，不设分包** | 实测：`pages: []` 的纯资源分包**不会被注册**，`app.json` 的 `preloadRule` 直接报「`tiles/` 未找到」，模拟器启动失败。压缩后牌面仅 731KB，分包已无体积收益（合计 954KB ≪ 2MB），故按本条预案并入主包并删除 `subpackages`/`preloadRule` |
| 2 | 分包方案整体取消 | 见 #1；将来资源增长超过 ~1.5MB 时，再引入「带真实页面的分包」（把对局页与贴图同包）或改走 CDN |
| 3 | 背景纹理降级为 CSS 渐变（4 档选项保留，未走 CDN） | 原 4MB 平铺纹理不进包；方案 P5 允许「CDN 或 CSS 渐变」，取零依赖的最小实现 |
| 4 | 掷骰覆盖层用大号数字代替 DOM 9 宫格骰面 | 方案未覆盖；翻滚/定格时序与文案与 web 端一致，视觉以最小实现补齐 |
| 5 | 新增协议字段 `{t:'ping'}` / `{t:'pong'}` | 方案 P0 明确要求的应用级心跳；web 端 `handle()` 开头忽略 `pong`，**不影响既有接口** |
| 6 | 分享改为「复制房间码 + 转发卡片（path 带 `?room=`）」 | 小程序无 `document.execCommand` 与页面 URL；方案 §2.1 已指定该替代 |
| 7 | 小程序登录鉴权（路线 B：wx.login→openid）未实现 | 方案列为可选增强；默认走路线 A（匿名 token + storage），行为与 web 端一致 |
| 8 | 「强制横屏退出钮」等横屏兜底全部删除 | 方案 P4：改用原生 `pageOrientation: landscape`，无需兜底 |
| 9 | 局内聊天从「fixed 右下角浮层」改为「流内右列 + HUD 圆钮」 | 浮层在横屏下会压画布右下角与手牌条右端（矮视口尤甚），且收起态的 92rpx 圆盒塞不进 tab 按钮。改为：收起=HUD 上的 💬 圆钮（带未读红点，零占位）；展开=流内右列（与画布并排，canvas-wrap 用 flex 让位）。「最小化结算」按钮同步改流内元素 |
| 10 | 新增横屏两档布局：`@media (max-height: 680px)` 时全页改 px 定尺 + 左右分栏 | rpx 随**屏宽**放大，宽而矮的横屏窗口里会把字号/间距一起撑爆、内容顶出屏幕（`disableScroll` 下直接裁掉，不可滚）。分界线 680px 落在手机横屏（≤430px）与平板横屏（≥744px）之间的空隙，两端都有确定行为。详见 §10.4 |

### 10.4 横屏布局约定（三页强制 `pageOrientation: landscape`）

三页 json 均为 `"pageOrientation": "landscape", "disableScroll": true"`——页面锁横屏且**不可滚动**，
布局必须「一屏装下」，横向才是可用维度。全部页面按同一套两档结构：

| 档位 | 命中条件 | 尺度 | 布局 |
|---|---|---|---|
| 标准档（默认） | 视口高 > 680px（平板横屏、桌面预览） | rpx | 原有竖向堆叠（home 步骤条→内容→说明/背景；lobby 单列；game 画布通栏 + 聊天右列） |
| 紧凑档 | 视口高 ≤ 680px（手机横屏、被压矮的模拟窗口） | **px** | 左右分栏（见下） |

分界线取 680px：手机横屏高度 ≤430px、平板横屏 webview ≥724px，中间是空隙，两端行为都确定。

- **px 定尺的原因**：rpx = 750/屏宽，宽而矮的窗口里 rpx 被放大（1280 宽时 1rpx≈1.7px），
  竖版堆叠的高度预算直接爆掉、内容被裁且不可滚；px 不随宽度缩放，紧凑档的预算才可算。
  紧凑档同时用 `calc(…px + env(safe-area-inset-bottom, 0px))` 给底部留 home 指示条安全区。
- **home 紧凑档**：`home-body` 由竖排改 `flex-direction: row`——左列当前步骤内容（ headed + 卡片/表单），
  右列（200px）说明文字 + 背景切换；步骤条保持一行三粒。
- **lobby 紧凑档**：`lobby-main` 左右分栏——左列定庄骰 + 四座位 + 换位提示，右列玩法切换 + 事件流
  （feed 滚区吃剩余高度），底部按钮行常驻。
- **game 紧凑档**：HUD/状态/控件/手牌条全部压到 px 最小（手牌格 42×54），剩余高度全给
  `#canvas-wrap`；聊天展开时占 `32vw`（240~320px 封顶）右列，与画布并排不重叠。
- **game HUD 防撑爆**：赣州 `jingText` 很长（"正精 北 · 副精 东（其余 10 张结算揭晓）"），
  `.hud-item` 用 `white-space:nowrap + overflow:hidden + text-overflow:ellipsis` 单行截断，
  `.hud-group` 加 `min-width:0`、右侧按钮组 `flex-shrink:0`——保证 HUD 恒一行，
  不会变两行挤掉牌桌高度。窄宽横屏（如 667px）下 jingText 会被省略号截短，属预期。
- **画布仍遵守「高度由宽度反算」**：`fitCanvas()` = `min(容器宽, 容器高×2)`，横屏下画布常是
  **高度受限**（手机横屏 ≈ 490×250），这是 2:1 牌桌的物理上限；点击换算始终按 `boundingClientRect()`
  实时量，保证点牌不错位。
- 任何导致 `#canvas-wrap` 尺寸变化的 setData（手牌条显隐、聊天开关、结算恢复条显隐）之后
  **必须**调 `fitCanvas()`；它内部已包 `wx.nextTick`，量的都是新布局。
- **改写整份页面 wxss 必须与旧版逐条 diff**：紧凑档里漏掉任何一条覆盖，都会静默退回 app.wxss 的
  rpx 竖档（矮宽窗口里 rpx 被放大 → 按钮变巨型）。实例（2026-10-17）：重写 game.wxss 时漏了
  `.btn-row button { height:30px; … }`，「关闭」按钮退回 `height:72rpx` 被撑成巨型并溢出卡片底部。
  三页的紧凑档覆盖清单：home `§376`、lobby `§419`、game `§（浮层按钮行）`。
- **`.btn-row.end` 是全局修饰类**（已提到 app.wxss）：此前只有 home.wxss 定义过，
  game/lobby 的 `btn-row end` 是空类名 → 浮层底部「取消/确定」全靠左，看起来像放错位置。
- **浮层（掷骰/表情/结算/换位/解散）打开期间牌桌画布会被藏掉、浮层改 absolute 定位**，
  成因与约定见 §10.7；**手牌/提示/吃碰杠胡是盖在牌桌上的 cover-view**（画布尺寸/占屏）见 §10.8。

### 10.5 IDE 自动化、编译缓存与截图取证（2026-10-17）

调试期踩过的坑与可直接复用的手段，全部在 IDE（`E:\微信web开发者工具`，用户数据
`…/User Data/44be4a7b…/`）上实测：

**① 改完 wxss 不生效 = 没编译（最大的时间陷阱）**

IDE 有编译缓存（`WeappCache/WeappCompileCache/<hash>/`，只存编译后的 JS，WXSS 不进缓存）。
改 `app.wxss` 后若没点「编译」，webview 仍在跑旧样式——表现与「修复无效」完全一样。
判定 stale 的三条独立证据：编译缓存目录 mtime 早于源文件 mtime；UA `width:184px` 精确复现；
`.code` 字号未按紧凑档生效。**无头重编译**（改完样式后可直接用，不必点 IDE）：

```
POST http://127.0.0.1:39895/session/1/wechatdevtools/compile   # body: {}
→ {"status":0}
```

约 2s 后小程序重载，`appservice/pagestack` 回到首页——**房间对局状态会没**，
验 game 页要重新进房。

**② 自动化端口（39895）可用路由**

| 路由 | 用途 |
|---|---|
| `GET /status`、`GET /session/1/window` | 探活 / 窗口句柄 |
| `GET /session/1/wechatdevtools/appservice/pagestack` | 当前页面栈 |
| `GET /session/1/wechatdevtools/appservice/data` | 页面 data（弹层/画布尺寸/文本全在里面） |
| `POST /session/1/wechatdevtools/currentwebview/html` | 渲染中页面的真实 DOM（自定义元素 `wx-*`） |
| `POST /session/1/wechatdevtools/compile` | 见上 |
| `POST /session/1/wechatdevtools/weixinjsbridge/invoke/:api` | 调 wx.* API |

截图两条路都不通（记录在案省得再试）：`/session/1/screenshot` 要 IDE 窗口**在前台**
否则 `Capture screenshot timeout`；`/currentwebview/screenshot` 在模拟器视图未挂载时
webview manager 为空（`webviewID … not exisits`）。窗口激活手段（WScript.Shell /
SetForegroundWindow）都被本机安全策略拦截——**要截图就请用户手动给 IDE 前台**。
端口 58987 是同协议的另一 session；`Get-NetTCPConnection` 可枚举全部 IDE 进程端口。

**③ wcsc.exe 实测：选择器会被改写，`button{}` 确实打到内置按钮上**

`WeappVendor/wcsc.exe`（WXSS 编译器本体，可直接跑：`wcsc -o out.wxss in.wxss`）：

| 源码写法 | 编译产物 |
|---|---|
| `button { width:auto !important }` | `wx-button { width: auto !important; }` |
| `page { height:100vh }` | `body { height: 100vh; }` |
| `.ghost { … }` | `wx-button.%%HERESUFFIX%%ghost { … }`（类带隔离后缀占位） |
| `padding: 0 24rpx` | `padding: 0 %%?24rpx?%%`（rpx 运行期占位） |

由此确认 10.6 的 `button{}` 基样式**没有**选错元素名——它被编译成 `wx-button`。
base library 实际版本以编译缓存 infoKey 为准（当前 `7.21.0`；project.config.json
的 libVersion `3.17.4` 是 IDE 库版本号，对应 UA 样式以 `WeappVendor/3.17.4.wxvpkg` 为准）。

**④ dpr / 黑带标定（读二倍截图用）**

模拟器进程带 `--device-scale-factor=1.5` → **dpr=1.5**：device px ÷ 1.5 = CSS px。
校准证据：紧凑档 `.tile-btn` 42px + gap 3px = 45 CSS px，实测相邻牌心距 67.5 device px。
（注意别用「全部相邻间距的平均值」——会把行首 margin 和尾部表情/图标钮的间距混进来。）

**⑤ 左缘黑带（三张旧截图都有）定性：不是页面元素**

≈32×211 CSS px 纯黑药丸、右端半圆、右/下缘 1px 白线，贴在屏幕左缘、纵跨页头下沿到
页脚上沿。逐层排除：实时 DOM（自动化接口拉的 live.html）**无对应元素**；三页 wxss
grep 纯黑零命中；home/lobby 无 canvas 也有同款 band；`html/pageframe.html`、
`appdevserver/pageframe.html`（实为 WEUI demo）、`static/simulator-video.v2.css`、
基础库 3.17.4 全部 grep 无黑药丸。它只出现在**按钮修复编译前的旧渲染**里（旧布局
184px 按钮把内容顶出视口）——判断为**溢出布局的页面级滚动条**（webview chrome，
非 DOM、我方改不掉），按钮修复后预期消失。**待重新进房后肉眼复验**；若仍在，再按
「模拟器注入样式」方向查 IDE `js/` 侧。

### 10.6 `<button>` 内置默认样式（排版的头号坑，2026-10-17）


`app.json` 里 `"style": "v2"` 会让基础库注入 **user agent 样式**。libVersion 3.17.4
（`WeappVendor/3.17.4.wxvpkg`）实测原文：

```css
wx-button{border-radius:4px;font-size:17px;font-weight:700;
          line-height:1.41176471;padding:8px 24px}
wx-button:not([size=mini]){margin-left:auto;margin-right:auto;width:184px}
wx-button[type=primary]{background-color:#07c160}
wx-button[type=default]{background-color:#f2f2f2;color:#06ae56}
wx-button[disabled]:not([type]),wx-button[disabled][type=default]{
  background-color:#fafafa;color:rgba(0,0,0,.18)}
```

> 注意与 2.x 基础库的差别：**没有** `min-height:40px`、**没有** `border`
> （3.17.4 全文件 `min-height:40px` 出现 0 次）；早期按旧版照抄的注释已作废。
> 真正常住的只有 `width:184px` + `margin auto` 这一组。

`wx-button:not([size=mini])` 特异度 `(0,1,1)`，高于裸类型选择器 `(0,0,1)`，且 UA
注入在我方 `app.wxss` / 页面 `wxss` **之后**——普通声明压不掉（`!important` 是唯一手段）。
后果不是「某个属性不生效」而是**整套盒模型被改写**：

| 症状 | 成因 |
|---|---|
| 按钮无论文字多少都是 ~184px 宽 | `width: 184px` |
| 一行按钮之间出现 `gap` 两倍多的空隙 | `margin-left/right: auto` 在 flex 行里吸收剩余空间 |
| 文字少的按钮折行（分享钮「分享房间/码」两行） | 184px 盒装不下 28rpx×5 + padding |
| `.chat-min` / `.chat-ico` 的定宽全部失效 | 同上，类选择器的 `width` 被压掉 |
| 禁用态按钮变成浅灰底浅灰字 | UA 的 `button[disabled]` 灰底同为高优先级内置样式 |

> 实测记录：850×397 CSS px 的矮横屏里，底部 4 个钮各 ~184px + 间距 ~35px（842px 挤满 826px
> 内容宽），字号/高度/配色却都按我方 12px/30px 生效——因为 UA 基础 `button` 规则特异度只有
> `(0,0,1)`，压不过类选择器；只有 `:not([size='mini'])` 里那三个属性会漏过去。

**约定（改按钮前必读）**：

- `app.wxss` 的 `button {}` 基样式已带 `display:inline-block / width:auto / min-height:0 / margin:0`
  四条 `!important`，这是刻意为之，**不要**为了「整洁」把它们改成普通声明。
- 任何**需要定宽**的按钮（圆钮、图标钮）在自己的类里写 `width: … !important`
  （例：`.chat-min` / `.chat-ico`）。
- 任何**依赖 `margin:auto` 对齐**的按钮要写 `margin-left: auto !important`（例：`.chat-min`）。
- **禁用态配色**必须逐类 `!important` 覆盖 `background` / `color`（例：`button.primary[disabled]`），
  否则内置灰底会把我方配色整层盖掉；`opacity: .45` 这条我方规则照常生效。
- 不要用 `size="mini"` 去「绕过」内置样式——那会连带改掉按钮的语义尺寸，且各基础库版本行为不一致。

### 10.7 原生 canvas 合成层级与浮层定位（game 页，2026-10-17）

**① `<canvas type="2d">` 合成在 DOM 之上——fixed 浮层盖不住、还会被穿透点击**

对局界面逐像素取证（模拟器 dpr=1.5，见 §10.5 ④）：互动表情面板打开时，
`.layer`（fixed + rgba(0,0,0,.55) dim + z-index:100）出现三种失效：

| 现象 | 实测 |
|---|---|
| Dim 不到牌桌 | 牌桌 felt 色 [29,64,48] 在蒙层里原样发亮 |
| 卡片被画布压住 | emote 卡片左上区域被画布盖住（卡片 x≈292..991 img px，画布 x128..728 重叠） |
| 点击穿透 | 浮层打开期间牌桌仍可点牌出牌（手牌条是 DOM 不受影响，scroll-view 同理非原生） |

根因：canvas 2d 是**原生组件**，走单独合成层，永远在 webview DOM 层上面——
与 z-index、fixed/absolute 无关。**对策（已落地）**：任一浮层打开期间给画布切
`display:none`：

- `game.js` 维护派生状态 `modalOpen`，唯一收口是 `syncModal()` ——
  `diceShown || emoteShown || settleShown || swapAskShown || dissolvedShown` 五者取或。
  **以后新增浮层必须把 flag 加进 syncModal 的这行**，打开处 setData 带 `modalOpen:true`，
  关闭处补一句 `this.syncModal()`（共 12 处已接线）。
- WXML 画布挂 `class="{{modalOpen ? 'on-modal' : ''}}"`，wxss 规则
  `.canvas-wrap canvas.on-modal { display: none; }`（特异度 (0,2,1) 压过基础 (0,1,1)，
  wcsc 编译产物已验证）。
- **不用 `wx:if` 藏画布**：那会销毁 canvas 节点，`this.table` 实例与已绘牌面一起失效。
- 关闭时 `syncModal` 补 `table.render()` + `fitCanvas()`：开浮层期间手牌条/结算恢复钮
  可能改过布局，且 `display:none` 期间量到的 rect 是 0（`fitCanvas` 内部有空盒保护）。

**② `.layer` fixed 的基准是小程序「文档」而非可视区——卡片不居中**

`app.wxss` 的 `.layer` 是 `position:fixed; inset:0` 弹性居中。game 页 `.game{height:100vh}`
含导航栏区，文档比可视区高一截，fixed 卡片实测（emoji 面板，卡片 480 CSS px）：

- 垂直：卡心比可视区中心低 ≈23 CSS px（= 文档中心 − 可视中心量级）
- 水平：卡心偏左 ≈34 CSS px（疑与页面溢出/滚动有关，未最终定性）

**对策（已落地，game + lobby 两页）**：页面根节点加 `position:relative` + `.xxx .layer{position:absolute}`
（game 用 `.game`、lobby 用 `.lobby`；`.layer` 基础样式仍在 app.wxss，页面 wxss 只做覆盖）。
`inset:0`/flex 居中不变。absolute 的基准变成页面根的 padding box——即该页整个可视流区，
卡片随之精确居中；导航栏是原生 UI 在流区之外，本就无需 Dim。

**③ 收尾说明（未改，记录在案）**

- Dim 对聊天列的覆盖不完全自洽：实测聊天列上半被 Dim（[7,12,9]）、下半呈自身底色
  （[15,25,20]）——仅观感，无交互影响，待后续一起看。
- 紧凑档画布 ≈400×200 CSS px 是 2:1 牌桌在手机横屏下的物理上限（`fitCanvas` 高度受限），
  非缺陷；聊天列展开时 240px 是触控可读下限，用户主动展开才占宽。

### 10.8 牌桌占满屏幕 · 手牌盖在牌桌上 · 解散对局（2026-10-17 晚）

用户第三轮反馈三条：① 无法解散对局；② 牌桌区域该更占满屏幕、手牌盖在牌桌上；③ 手牌现在偏左
该居中，且出牌提示/吃碰胡不能遮手牌、要放在手牌上方。逐项取证与处置如下。

**① 画布尺寸长期停在 data 默认的 400×200（真 bug，之前没人发现）**

- 实时 data：`canvasW:400 / canvasH:200`；而该窗口（1280×600 @dpr1.5 → CSS 853×400）
  的可用盒约 836×319 → 应算成 **638×319**，牌桌只占页面 54% 宽。
- 两次不同窗口（752×345 与 853×400）下都恰好是 400×200 = data 初值 → **从未适配成功**。
- 实时 DOM 里内层 `<canvas width="400" height="200">` 与宿主 `style` 完全一致 →
  **canvas 的 backing 跟着宿主 style 走**，`node.width` 的赋值不决定实际渲染尺寸
  （与「拿 node + 自行设 backing」的常见写法不同，改 size 要改 style，即 data 里的 canvasW/H）。
- 处置（`fitCanvas` 改为三条通道）：
  1. 同一批查询同时取 `fields({size:true})` 与 `boundingClientRect()`：**尺寸**优先 fields、
     **位置**（left/top）补 rect —— 任意一条通道可用都能拼出完整盒子；
  2. 两条都空 → `estimateWrap()`：窗口尺寸 − 导航栏（胶囊中心×2）− 流内 chrome；
  3. `measureCanvasBox()`：量到的 rect 与当前 `canvasW/H` 差 >2px 判为**陈旧帧**，
     改用「容器左上角 + 居中偏移」推算（与 fitCanvas 同源，不会滞后一帧）；
  4. 额外挂 `wx.onWindowResize`（Page `onResize` 在该环境不触发），`onUnload` 用**同一函数引用**
     注销（传新箭头函数注销不掉）。
- 桩测（假 wx + 真实 game.js）：fields 通道 → 638×319；仅 rect 通道 → 638×319；
  全空走估算 → 648×324。

**② 手牌 / 提示 / 吃碰杠胡改为盖在牌桌上的 cover-view**

- 诉求 → 结构：`.board-overlay`（`position:absolute; bottom:0; width=canvasW; 左右 margin:auto`）
  内自上而下 = 结算恢复钮 → 错误 → 倒计时 → 状态行 → 控件（吃碰杠胡/过）→ 手牌。
- **必须 cover-view**：canvas 是原生组件、合成层级在 DOM 之上（同 §10.7 ①），
  普通 `view`/`button` 会被盖住且点不到。控件/恢复钮没有 UA button 样式，改成自绘 chip；
  `active` 高亮从 `box-shadow` 改成 border 色。
- **手牌原来偏左的根因**：`scroll-view` 是块级、行内 `inline-flex` 的 `.tray-row` 起始贴左 →
  改 `justify-content: center` 即居中。
- 代价与兜底：cover-view **不能滚动** → 手牌用 `flex-wrap` 兜底换行，
  并加 `@media (max-width: 620px)` 把牌面缩到 34×44（老机型 568×320 一行放不下）。
- 连带收益：手牌/状态/控件离开流内 → `canvas-wrap` 变高 → 同窗口画布由 ~440×220 变 ~638×319
  （牌桌从 54% 宽变 76% 宽，正是「更占满屏幕」）。手牌显隐**不再需要** `fitCanvas()`（已删调用）。

**③ 解散对局（点了解散毫无反应）**

- 服务端已用 e2e 复现并验证**正常**：1 人 + 3 机器人 → 建房 → 首局定庄掷骰 → 准备 → 开局 →
  `abort` → 收到 `event「房主解散对局，庄家连庄」` + `state(phase=lobby)`，客户端随即回大厅。
- 实时 DOM 确认按钮已渲染、`bindtap="onAbort"`、`aria-disabled=false`；
  data 里 `controlsErrShown=false`（服务端从未拒过这个请求）。
- 断点只剩 `wx.showModal` 这一环：原生模态框在该环境下无反应/回调不达，
  表现就是点了毫无反应且**没有任何提示**。
- 处置：game 的「解散对局」与 lobby 的「解散牌桌」都改为**页内 `.layer` 确认框**
  （与换位请求/玩法切换同构），并加 `net.isOpen()` 守卫 + toast 提示，避免静默失败。

**④ tap 事件 detail 坐标（省得再查）**

官方文档明确：tap 类事件 `detail.x / detail.y` 是**相对于视口**的绝对坐标（不是相对元素）。
所以 `onCanvasTap` 里 `x - canvasBox.left` 的写法是对的，**不要**改成相对坐标；
出错时只该怀疑 `canvasBox` 是否量到（见 ① 的自愈推算）。

**⑤ 页面卸载清空了新页面的消息路由（静默失效，2026-10-17 深夜）**

用户报「解散房间无法回到准备界面」。服务端两条链路都用 e2e 复现过且**完全正常**（abort → event +
`state(phase=lobby)`；dissolve → `dissolved` + 最终积分），按钮也确认已渲染 —— 断点在客户端路由层：

```
小程序 redirectTo 的生命周期顺序：旧页 onHide → 新页 onLoad/onShow → 旧页 onUnload
```

三页都写的是 `onHide(){ room.detach() }` + `onUnload(){ room.detach() }`，而 `detach()` **无参、
无条件**把 `current = null` —— 旧页的 `onUnload` 晚于新页的 `onShow`，于是把新页面刚 `attach` 的
消息路由抹掉。**症状是静默的**：新页面界面看着正常，但所有回调空转。

按用户路径复现的完整链条（每一步都只是「没反应」）：

1. 解散对局 → 服务端 `state` → `redirectTo(lobby)`（导航靠 `current` 判空兜底，仍能跳）；
2. 大厅页 `attach('lobby')` 刚挂上，就被 game 页的 `onUnload` 清空 → **大厅从此收不到任何消息**；
3. 点「解散牌桌」→ 服务端删房 + 广播 `dissolved` → `store.clearRoom()` 执行了，
   但 `call('onDissolved')` **空转 → 最终积分弹窗不出现**；
4. 人留在一个「房间已不存在」的大厅页上：点准备 → 服务端回 error → `call('onError')` 同样空转 →
   **既没有弹窗也没有提示** —— 这就是「无法回到准备界面」。

修法（`utils/room.js` + 三页）：

- `detach(ctx)` 做**归属校验**：`if (current && (!ctx || current.ctx === ctx)) current = null;`
  三页的 onHide/onUnload 统一改成 `room.detach(this)`；
- `handle()` 入口加 `ensureCurrent()`：路由为空时按 `getCurrentPages()` 栈顶 `route`
  （lobby/game/home）重新挂上 —— 这类「路由丢失」失败是静默的，代价太高，必须自愈；
- **约定**：任何页面摘除自己时都必须传 `this`，新增页面照做，别写无参 `detach()`。

**⑥ 解散对局 = 结束本局回准备界面（语义澄清，2026-10-17 深夜）**

用户反馈：点解散 → 跳到准备界面 → **马上又自动开了一局**。

**先把服务端排除干净**：e2e 复刻完整路径（建房 → 3 机器人 → 定庄掷骰 → 准备 → 开局 → abort），
abort 后 10 秒静候只收到 `event` + `state`，`ready=[0H,1B,1B,1B]`（人类未就绪）、
**没有任何自动 `game`** —— `finalizeIfReady`（在线玩家须全 ready）与 `dealerStartTimer`
（再复核 `canStart`）两道门槛都挡住了。（第一版 e2e 只等 800ms，抓不到 2.6s 的定时器，
必须把静候拉到 10s 才排得干净。）

**语义澄清（用户明确纠正）**：解散对局 = **强制结束本局、回到准备界面（大厅）**，
房间保留、可重新开局；**不是解散房间，也不回首页**。与服务端 `abort` 一致，
`main.ts` 的 `confirmAbort` 注释同此。中途曾按「解散即离场回首页」实现过一版，已还原 ——
**别再把这两件事混为一谈**。

- 客户端无需额外动作：服务端 abort 后广播 lobby `state`，`room.js` 的 `case 'state'`
  把对局页 `redirectTo` 到大厅；人类 `ready` 被服务端重置（`p.ready = p.isBot`），
  回到大厅是**未准备**状态，要再点「准备」才开下一局；
- `game.wxml` 确认层文案：「将强制结束本局并返回准备界面（房间保留，可重新开局；本局不计分）。」

**「回大厅后看起来马上又开局」的真因：大厅把历史定庄掷骰重播了一遍。**

大厅 `renderLobby` 每次都拿 `dealerRolls` 最后一条播 2.6s 骰子动画，而 `dealerRolls` 是房间的
**持久状态**（首局定庄记录一直保留）→ 每次 `onShow`（含对局解散后回大厅、切后台回来）都把
「上一局的掷骰」当新事件重播，满屏骰子翻滚，观感就是「又在开局」。修法：**页面实例首帧只登记
key、不播动画**（`this.diceKey === undefined` 时直接赋值返回），后续真有新掷骰（key 变化）才播；
同 key 本来就有去重（`runDiceAnim` 首行）。

**⑦ cover-view 在开发者工具里盖不住 canvas → 操作区改回流内（2026-10-17 深夜）**

上一轮把手牌/状态/控件改成 cover-view 盖在牌桌下缘（用户报「开发者工具里无法显示手牌控制区域」）。

**取证**：实时 data 正常（`canvasW=578/canvasH=289` 适配已生效、`trayShown=true`、`statusText` 有值、
`controls` 有一项）；实时 DOM 里 `board-overlay` ×1、`cover-view` ×80、`cover-image` ×56、
`tile-btn` ×14 —— **全部渲染了却一个都看不见**。结论：canvas 是原生组件，普通 DOM 盖不住它
（只能用 cover-view），但**开发者工具里 cover-view 同样盖不住**；截图底部那排手牌其实是
`table.js` 自己画的内部手牌带（`HAND_Y=560`），不是 DOM 手牌条。

**处置**（放弃覆盖、回到流内，仍然满足三个诉求）：

- `.board-overlay` 从「`position:absolute` 盖在画布下缘」改为**画布下方的流内 flex 列**
  （`flex-shrink:0`），顺序：结算恢复钮 → 错误 → 状态行 → 吃碰杠胡 → 手牌；
- `cover-view`/`cover-image` 全部换回 `view`/`image`（手牌回到 `scroll-view scroll-x`，控件回到真
  `<button>`，样式挂 `.controls button` 而非自绘 `.ctrl`）；
- `.countdown` 回到 `.canvas-wrap` 内的绝对定位（原位）；
- `estimateWrap()` 的 chrome 从 30/40 改为 **130/90**：操作区回流内后要计入高度，
  否则估算通道会画出溢屏的画布（估算宁可略小）。

> **约定**：不要在小程序里试图用 cover-view/cover-image 覆盖 canvas 做交互控件 ——
> 开发者工具不保证可见，真机行为未验证。需要叠在画布附近就用**流内布局**把元素放在画布下方。

**⑨ 操作区高度必须恒定 + 倒计时并进状态行（2026-10-17 深夜）**

用户报两条：① 赣州「是否展示报杠」的提示一出现，牌桌被往上顶、样式变形；② 出牌倒计时出现在
麻将区域下面被遮挡。

- **① 的根因是操作区高度会变**：状态行原先用 `wx:if="{{controls.length === 0}}"`，控件一出现
  这行就消失（少 ~17px）→ `.canvas-wrap` 变高 → 画布重新居中 → 牌桌整体位移，看起来像被顶上去。
  修法：**状态行恒占一行**（不随控件增删；`height` 锁死 + 文案 `nowrap` + `ellipsis`），
  控件全部走 `.claim-mask`（`position:absolute`，不参与流内高度）→ 操作区总高恒定，画布不再跳。
- **② 的根因是原生 canvas 遮挡**：倒计时原先绝对定位在 `.canvas-wrap` 顶部（`top:8rpx`），
  画布占满该区域时两者重叠，而 canvas 是原生组件、合成层级在所有 DOM 之上 → 倒计时被盖住。
  修法：**把倒计时并进状态行右侧**（胶囊短标签 `⏱ 12.3s`），不再与画布有任何重叠。

> 通用原则：**任何会改变画布周边高度的增删都要避免**——画布尺寸由剩余空间反算，周边一动就重排。
> 需要临时出现的控件/提示，用绝对定位叠在**操作区内部**（DOM 区域），而不是插进流内。

**⑩ 大厅「准备」按钮函数名撞 Page 生命周期 `onReady`（2026-10-17 深夜，本次问题的真凶）**

用户报：解散对局 → 回到准备界面 → **马上又开一局**；并准确猜「是不是没重置玩家准备状态、
机器人自动准备那我自己也自动准备了」。**猜对了**。

`lobby.wxml` 的准备按钮写的是 `bindtap="onReady"`，而 `lobby.js` 里的 `onReady()` **同时是
Page 的生命周期回调** —— 页面首次渲染完成时框架会**自动调用**它。于是：

```
进入大厅 → 框架自动调 onReady() → room.send({t:'ready', ready:true})
        → 人类被置为「已准备」（界面上按钮直接显示「取消准备」）
        → 机器人恒就绪 + 首局已定庄 ⇒ canStart 立刻成立
        → 2.6s 后（或立即）自动开局
```

首局因为还没定庄（`firstDealerDecided=false`）挡住了，所以平时看不出来；一旦首局结束
（`firstDealerDecided` 变 true），**每次进大厅都会自动准备 → 自动开局**，正是「解散对局后马上又开始」。

**修法**：按钮处理器改名 `onToggleReady`（WXML + JS），并加注释说明不能叫 `onReady`。
顺带排查三页全部 `bindtap` 与生命周期名的冲突（现在零冲突）。

> **通用约定：Page 里的方法名绝不能与生命周期同名**（`onLoad/onShow/onReady/onHide/onUnload/
> onPullDownRefresh/onReachBottom/onShareAppMessage/onPageScroll/onResize/onTabItemTap/
> onShareTimeline/onAddToFavorites`）。撞名不会报错，只会在对应时机被静默自动触发。

**服务端防御**：`onGameOver` 补清 `dealerStartTimer`（定庄后那 2.6s「等骰子动画再开局」的定时器）
—— 本局已结束时残留的定时器会在 phase 回 lobby 后自行 `startGame`。临时端口 e2e 复核：
abort 后只收 `event`+`state`、`ready=[-H,RB,RB,RB]`（人类未准备）、**10 秒静候零自动开局**。

**⑪ 大厅定庄骰子动画只在自己掷时播（2026-10-17 深夜）**

用户报：首局定庄四人各掷一次，**别人（含机器人）掷骰也会在自己屏幕上弹全屏骰子动画**，
看起来像「自己又掷了一次」。

真因：`lobby.renderLobby()` 拿到 `dealerRolls` 的最新一条就无条件 `runDiceAnim()`，
不分掷骰者是谁。定庄是四人各掷一次，于是机器人依次补掷时会连弹 3 次。

修法：**动画只在自己掷骰时播**（`latest.seat === s.you`），别人的掷骰只静默登记 key、
交给右侧事件流那行文字（`XXX 掷出 a+b=c 点`）；首帧（刚进大厅 / 对局解散回大厅）依旧
只登记不播。骰子本身仍由服务端 `pushDealerRoll` 广播给所有人生效，只是动画不再互相打扰。

**同时**：服务端 `default` 分支的 `未知消息` 补上消息类型（`未知消息：xxx`）——
事件流里之前只显示「未知消息」，看不出是哪个包。已核对协议白名单（`ClientMsg` 联合与
服务端 `case` 完全对齐）与 `setVariant` 的 `return`（无 fall-through），暂未定位到具体来源，
等下次复现时按新文案一眼可见。

**待复验**：cover-view 在模拟器与真机的实际渲染（手牌换行、chip 外观、与画布的层叠）——
本轮无法自截图（IDE 窗口需前台，见 §10.5），需用户重新进房肉眼确认。

**⑧ 吃碰杠胡选择期要能看见手牌 → 半透明遮罩（2026-10-17 深夜）**

用户反馈：吃碰胡的选择期**看不到手牌**，没法判断该碰还是该胡；希望用半透明遮罩。

原因：`syncHandTray()` 原先把 `v.claims` 也列进隐藏条件（`ritual !== null || phase==='over' || v.claims`
三者任一都清空 `tray`），于是选择期整排手牌消失。

**处置**：

- `syncHandTray()` 去掉 `v.claims` —— 选择期照常显示手牌；此时 `trayActive=false`
  （`canDiscard` 已排除 `claimWindow`），手牌只读可见、点不出牌；
- 结构：手牌与遮罩同放 `.tray-stack`（`position:relative`，`min-height` 与手牌条同高兜底）；
  选择期渲染 `.claim-mask`（`position:absolute; inset:0`），**半透明 `rgba(8,18,13,.62)`**
  盖在手牌上，内含状态文案 + 吃碰杠胡按钮，手牌透过遮罩仍可见；
- **为什么这次能盖住**：遮罩与手牌都是普通 DOM，DOM 之间互相覆盖不受原生 canvas 限制
  （canvas 只挡在它自己的矩形上方，而操作区已经在画布下方）。**不需要 cover-view**
  （也就不会再踩 §10.8⑦ 的坑）；
- 平时的状态行已改为**恒占一行**（见 §10.8⑨），不再用 `wx:if` 增删，避免画布重排跳动；
  选择期的控件走 `.claim-mask` 绝对定位，不占流内高度。

**⑫ 结算态：牌桌要吃满腾出的高度，结算入口并进状态行（2026-10-17 深夜）**

用户报：**结算时麻将区域没有放大**，且**「本局结算」显示位置异常**（胶囊贴在画布底边、
结果文案又堆在它下面，中间还夹着一整条空的手牌带高度）。

两个独立成因：

1. **画布不会自己变大**。`v.phase === 'over'` 时 `syncHandTray()` 只把 `trayShown` 置 false，
   而 `.tray-stack` 的 `min-height`（紧凑档 56px）仍在占位 → `.canvas-wrap` 高度不变；
   更关键的是**没有任何地方在相位翻转时调 `fitCanvas()`**，画布停在结算前的小尺寸。
   修法：`renderGame()` 维护一个「操作区高度档位」`chromeKey`（`over ? 'o' : '-'`），
   档位翻转的那一帧补 `fitCanvas()`（同档位内的 state 广播不量，SelectorQuery 有开销）；
   同时 WXML 把 `.tray-stack` 挂 `wx:if="{{!overPhase}}"`，让整条手牌带真正退场。
   实测（667×375 横屏）：`532×266` → `644×322`（+21%）。
   **注意**：仪式中（`ritual !== null`）手牌也隐藏，但 `.tray-stack` 的 `min-height` 仍占位
   → 高度不变 → 档位只区分结算与否，否则仪式各阶段来回切会抖。
2. **结算入口的位置**。`settle-restore` 原是 `.board-overlay` 的第一个子元素（独占一行、
   紧贴画布下沿），结果文案又在它下面单独一行 —— 视觉上像被挤在牌桌与文案之间。
   修法：并进 `.g-status` 最右侧（同一行：结果文案 + `⏱` 或「本局结算 ▲」），
   `.g-status.over` 档把行高放宽（44rpx / 紧凑档 22px）让胡牌结果看得清。
   **高度必须 ≤ 状态行锁定高度**，否则会被 `.g-status` 的 `overflow:hidden` 裁掉一半
   （紧凑档 `.g-status.over .settle-restore` 18px < 行 22px）。

配套：`renderGame()` 在离开结算相位时清掉 `settleRestoreShown`（「本局结算 ▲」只属于
刚结束的那一局，不能带进下一局）；`renderControls()` 的结算文案去掉
「点『最小化』看牌，点『下一局』继续」这串尾巴（入口已经在按钮上，留着只会被省略号截断）。

**⑬ 画布两侧的空白改成「左操作记录 / 右聊天」两栏（2026-10-17 深夜）**

用户截图指出：牌桌是 2:1 定尺、高度吃满，**宽度吃不满**，两侧各留一大块空白，
要求左边放局内操作记录、右边放聊天。

**为什么不能写死宽度**：空白宽度 = 行宽 − 2×行高。手机横屏（1.78:1）这个值 ≈ 0，
写死两栏会把画布挤小甚至挤出屏幕；只有 ≥ ~2:1 的窗口（开发者工具窗口拉宽、平板横屏、
用户在截图里那档）才有真空白。所以**按实测余量分配**，没有余量就不出现（退回旧布局）。

**实现要点**（`game.js` 的 `fitCanvas()` 已重写为「布局预算」）：

- 量 `#game-main`（行容器）拿行宽/行高 —— 它的尺寸只由父容器决定（`flex:1;min-height:0`，
  子元素溢出不会撑大它），所以「有没有侧栏」不会让测量值抖动。**不能拿 `#canvas-wrap`
  判**：侧栏一出现就把自己量窄，形成「侧栏 → 画布变小 → 侧栏消失」的循环。
- 画布宽仍以 `#canvas-wrap` 实测宽为准（窄屏手动展开聊天列时它会变窄）；只在侧栏
  要出现的那一刻改用「行宽 − 侧栏宽」——那时 wrap 还没被挤窄，只能这么算。
- 预算：`leftover = 行宽 − min(行宽, 行高×2)`；两栏**按目标尺寸定尺**
  （`SIDE_LOG_PREF=180` / `SIDE_CHAT_PREF=230`，够宽就用这个值，余量留给中栏），
  不够宽时按可用量压缩（`chatW = clamp(avail×0.56, 150, 230)`，`logW = 余下`）；
  `logW < 110` 就只保留聊天栏（结算态行高变大、余量不够时会走到这里，记录栏自动让位，
  聊天不闪）；再不够就两栏都不出现。
  **2026-10-17 深夜第二轮调整**：原先按 `clamp(leftover×0.55, 150, 440)` 吃满余量，
  用户反馈「两栏太大、要尽量多的显示中心区域」—— 牌桌是 2:1 定尺、吃满高度，
  多出来的宽度给它也用不上，但给侧栏只会把中栏挤窄，所以改成定尺。
- 侧栏宽度写进**行内 style（px）**，`.chat.sided` 必须把 `32vw / min-width:240px /
  max-width:320px` 全部让开（`min-width` 优先于 `width`，不让开会把内联宽度顶回去）。
- `.game-main` 的 `gap` 从 `8rpx` 改成 **`6px`**：要和 JS 的 `SIDE_GAP` 对上，
  rpx 会随屏宽缩放，一旦对不上画布就溢出或留缝。
- `fitCanvas` 现在会**自我重跑一轮**（布局变了 → `nextTick` 再量），因为侧栏出现后
  wrap 的真实宽度变了；重跑收敛（`sideCols` 只由行宽/行高决定，与当前布局无关），
  另有 depth ≥ 3 的兜底防死循环。
- 聊天栏窄，快捷语/表情钮从底部输入行挪到标题行（`.chat-bar-tools`），
  输入行只留输入框 + 发送；`.chat-input` 补 `min-width:0`（input 默认有 ~150px
  固有宽度，会把「发送」挤出栏外）。
- 记录栏用 `scroll-top` 递增跟随最新一步（**不用写死的 `scroll-into-view` 锚点**：
  那只有值变化时才生效，后续追加行不会再滚，表现为新记录沉在底下看不见）；
  渲染上限 `LOG_ROWS_MAX=120` 行（服务端 `actionLog` 留 500 条，全量塞进常驻栏
  每次 state 广播都要重排上万像素）。

**验证**：把 `app.wxss`/`game.wxss` 转 px 后用 Playwright 真实渲染三栏复刻，实测
1080×361（行 1064×252）下 `logW 180 + 6 + [中栏 642 内居中画布 504] + 6 + chatW 230`，
画布无溢出、两栏 `height` 撑满行高；1080×502（行 1064×393）下退化为
`116/150 + 画布 786`。wcsc 实编 + IDE 无头 compile `{"status":0}`。

**⑭ 「未知消息」每 10 秒刷一次，并把操作区顶得一跳一跳（2026-10-17 深夜）**

用户报：游戏里老是弹出「未知消息」，而且一出现版面就变一下。

**根因（已实测坐实）**：小程序连的是线上 `wss://majiang.dwzynj.top/ws`，那台**服务端版本落后**，
不认识小程序的应用级心跳 `{t:'ping'}`（`utils/net.js` 每 **10s** 一条），于是每条心跳回一次
`{t:'error', reason:'未知消息'}`。客户端 `case 'error'` 把它当业务错误 → `onError` → 顶部
`.g-error` 多出一行 → `.board-overlay` 总高变化 → 画布重排。**每 10 秒抖一次**。
（`{t:'rollDealer'}` 等业务消息在线上服务端是认的，只有 `ping` 是新增的，所以只有它触发。）

复现方式：直连线上 `wss://majiang.dwzynj.top/ws` 发 `{t:'ping'}` →
`{"t":"error","reason":"未知消息"}`；发 `{t:'rollDealer'}` → `当前不在房间中`（认）。

**处置（三条，都不依赖重新部署）**：

1. **客户端吞掉「未知消息」**：`utils/room.js` 的 `case 'error'` 里，`reason` 以「未知消息」
   开头的一律 `return`（只 `console.warn` 一次）。这类回复是**版本错配**，不是用户操作错误，
   弹给玩家既没用又伤界面。
2. **顺手停掉应用级心跳**：`utils/net.js` 新增 `disablePing()`，由上面那条分支调用。
   ws 协议层的 ping/pong 由平台/服务端自己处理，不依赖这条应用级心跳，所以**不影响保活**；
   重连时会重新探测一次（服务端升级后自动恢复）。
3. **错误不再单独占一行**：`.g-error` 整个删掉，错误文案**占位替换状态行文案**
   （`<text class="g-status-text err" wx:if="{{controlsErrShown}}">⚠ …</text>`，`wx:else` 才是
   正常状态）。状态行高度锁死 → **任何错误都不会再顶高操作区**。`onError` 另加 4s 自动
   回退（否则一条错误会长期盖住「轮到你了」）。
4. **服务端加固**：`default` 分支加 `WeakSet` 记录，**每条连接只提示一次**，并
   `console.warn` 出具体消息类型。这样即使将来又出现版本错配，也不会刷屏/刷日志。

**顺带**：`.board-overlay` 上原本还有一份 `padding-bottom: env(safe-area-inset-bottom)`，
而 `.game` 的底部内边距已经算过一份 —— 双份叠加让横屏多空出 ~21px（正好是 home indicator
的高度），这段高度本该归画布。已删掉 `.board-overlay` 那份，牌桌直接变高。

### 10.9 待办（按方案仍需处理）

- [ ] **重新部署服务端**（`wss://majiang.dwzynj.top/ws`）：线上版本落后于仓库，不认识
      `{t:'ping'}`，也还没有 `未知消息：<t>` 的类型回显与「每连接只提示一次」。
      客户端已做兼容（吞掉 + 停发心跳），但**根治要靠部署新版本**。

- [ ] `utils/config.js` 的 `DEFAULT_WSS` 填入真实域名（wss + 已备案），并在后台登记 socket 合法域名
- [x] ~~`project.config.json` 填入 AppID~~（开发者工具导入时已写入，libVersion 3.17.4）
- [ ] 真机矩阵验证（iOS/Android 横屏、切后台重连、低端机 canvas 帧率、横屏键盘弹起与 `env(safe-area-inset-*)`）
- [ ] 棋牌类目资质与审核材料（方案 P6，周期最长，需与企业主体并行推进）

> 相关文档：`docs/guides/agent.md`（改动铁律）、`docs/architecture/multi-variant.md`（多玩法契约）、
> `docs/rules/nanchang.md`、`docs/rules/ganzhou.md`。
