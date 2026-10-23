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
      └── lib/shared/   由 npm run build:mp 产出（CommonJS JS）
      （无任何图片资源：牌面为纯矢量绘制，见 §10.8⑯）
```

> 实施时**取消了分包**：`pages: []` 的纯资源分包不会被注册，`preloadRule` 会报「未找到」导致模拟器启动失败；
> 后来牌面改为纯矢量绘制，主包已降到约 250KB（无图片资源），分包更无必要。详见 §10.3 / §10.8⑯。

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
      table.js      Canvas 2D 牌桌（移植自 client/src/table.ts，牌面纯矢量）
      ui.js         toast / confirm（替代 window.confirm）
    pages/home/     分步向导（含分享链接预填）
    pages/lobby/    房间：座位/换位/准备/机器人/定庄骰/玩法切换/分享
    pages/game/     对局：画布 + HUD + 控件 + 手牌条 + 聊天/记录 + 结算
    project.config.json / project.private.config.json   开发者工具工程配置（private 已 gitignore）
scripts/
  mp_build_shared.mjs    shared → CommonJS 产物 + 导出自检
```

### 10.2 构建与校验

| 目的 | 命令 |
|---|---|
| 编译 shared 入小程序 | `npm run build:mp` |
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
| 1 | **牌面资源最终并入主包 `miniprogram/tiles/`，不设分包** | 实测：`pages: []` 的纯资源分包**不会被注册**，`app.json` 的 `preloadRule` 直接报「`tiles/` 未找到」，模拟器启动失败。当时压缩后牌面 731KB，分包已无体积收益（合计 954KB ≪ 2MB），故并入主包并删除 `subpackages`/`preloadRule`；**后续牌面改纯矢量绘制，主包只剩约 250KB、零图片资源**（§10.8⑯） |
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

**补充（同日，用户第二次红框）**：上/下家手牌原来叠 26×36 整张牌背、步距 11 → 每格都露出牌背那条**白顶边**，13 张叠下来像「黄白相间的尺子」。改成「一摞牌」的画法：顶面一张完整牌背，下面每格只取牌背**中段**（sy 30%、sh 42%）纵向铺满 → 连成一条干净的牌摞。右侧牌河起点 802→**808**（离中心盘留 8px，之前 2px 会被盘边压掉一截）。

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

**⑮ 取消画布内的常驻手牌带 + 贴图升到 139×202（2026-10-17 深夜）**

用户口径：「牌面偏小、看着吃力」，先做**低成本两项**（B + E）。

**为什么删画布内手牌带（B）**：画布逻辑坐标恒 1280×640，屏上画布只有约 500 CSS px 宽
（被高度锁死 + 2:1），**全局缩放 k≈0.39** —— 手牌 52×70 落到屏上只有 20×27，而画布下方
DOM 手牌条是 42×54。同一副牌出现两套尺度，小那套还点不准（20px 触控面）。
删掉后出牌只剩 DOM 手牌条一个入口，画布内只剩掷骰按钮与四角铭牌可点。

改动要点（`utils/table.js`）：

- 删 `drawMyHand()` / `drawDrawn()` / `markDeclare()` 及 `hits` / `canDiscard` / `handRect`
  / `anim` / `prevDrawn*` 全部状态；`hitTest()` 的手牌分支一并删除。
- `drawRevealHand()` **补 slot 0 分支**：摊牌时在画布下沿（`MY_HAND_Y=560`）用 34×44 只读
  展示自己的明牌（角标/结算要看），矩形存进 `myRevealRect`，供 `winnerRect()` 画胡牌高亮。
- 流局（`phase='over'` 但 `reveal=null`）也要出牌：`tiles` 回退到 `view.myTiles`。
- `render()` 的循环从「reveal 时跳过 slot 0」改成「reveal 或（slot 0 且 over）都走
  drawRevealHand」，否则流局时桌面底部空着。
- `drawTurnCursor()` 的 slot 0 分支失效（没有手牌带可圈）——「轮到你」由状态行文案 +
  DOM 手牌条的 `.hand-tray.active` 金色描边表达。

**贴图升级（E）**：`scripts/mp_prepare_assets.mjs` 的 `TARGET_MAX` 135 → **203**
（整数倍降采样，`factor = ceil(405/203) = 2`）→ 产物 **139×202**，34 张合计 1406KB
（原 731KB），主包 **1.65MB / 2MB**（余量 361KB）。
为什么必须升：DOM 手牌条要放到 46×60，**DPR 3 的真机需要 138×180 物理像素**，
旧的 93×135 会被上采样 1.5 倍 → 手牌发虚。

配套（`pages/game/game.wxss`）：手牌 42×54 → **46×60**（画布让出约 2% 宽度，手牌面积 +9.5%），
`.tray-stack` 56 → 62px，窄屏档 34×44 → 38×49，并把 `@media (max-width: 620px)` 抬到
**700px**（46px × 14 张 + 间距需 683px，667/568 这类窄横屏必须先缩档）。
`estimateWrap()` 的 chrome 常量 130 → 136 同步。

**验证**：用服务端（临时端口 3199，全机器人房）抓真实 `GameView`，在 Playwright 里加载
`utils/table.js` 真实渲染三种形态 —— **playing / over-reveal / over-draw 全部零异常**；
摊牌手牌矩形 `{x:390,y:555,w:500,h:54}` 居中不压角标；560 以下采样行确认对局中已无手牌带。
`wcsc` 实编 + IDE 无头 compile `{"status":0}` + `npm run typecheck` 全通过。

**⑯ 牌面不再进代码包：先纯矢量，后走 CDN（2026-10-18）**

官方「代码质量 / 上传体检」报了三项未通过，前两项的根因都是**包里那 34 张牌面 PNG**：

| 检查项 | 结果 | 真因 |
|---|---|---|
| 主包大小应小于 1.5M | 1.65MB ✗ | 牌面 PNG 占 1406KB |
| 图片和音频资源应不超过 200K | ✗ | 同上（93×135 时也有 731KB，这条基本封死「位图进包」） |
| 启用组件按需注入 | ✗ | `app.json` 缺 `lazyCodeLoading` |

两步走：**第一步先把牌面改成纯矢量**（删 PNG、包体降到 281KB，让体检能过）；
**第二步按用户要求接回位图，但走后端接口 + CDN**（见 ⑰）。矢量成为**永久兜底**。

**处置**：

1. **牌面全部改纯矢量绘制，删除全部图片资源**（`miniprogram/tiles/` 34 张 PNG、
   `utils/tiles.js`、`scripts/mp_prepare_assets.mjs`、`npm run prepare:mp`）。
   - `table.js` 的 `drawTile()` 去掉位图分支（`tileArt`/`drawImage`/clip），只保留矢量：
     米白底 + 底部立体边 + 数字（`h*0.42` 粗体）+ 花色字（`h*0.3`），按花色着色
     （万：数字墨色 + 萬字红 / 条全绿 / 筒全蓝 / 中红 / 发绿 / 白板画蓝框）；
     牌背（`t === -1`）不变。
   - DOM 手牌条（`game.wxml`/`game.wxss`）的 `<image>` 换成两个 `<text>`
     （`.tile-rank` + `.tile-suit`，风箭牌单个 `.tile-honor`），色调用 `.tone-*` 类；
     `syncHandTray()` 里给每张牌算出 `honor/rank/suitChar/tone`，删掉 `img/imgOk`
     与 `onTileImgError`。
   - **为什么不做「压到 200K 以内的位图」**：34 张牌面即使 93×135 也有 731KB，
     要 ≤200KB 只能上 WebP/调色板量化（canvas `createImage` 对 WebP 的支持不确定，
     且会有色带）；矢量方案零字节、任意 DPR 清晰、放大不受贴图分辨率限制，
     小尺寸下（牌河 9~13 CSS px）矢量文字比缩小的写实贴图更好认。
2. **`app.json` 加 `"lazyCodeLoading": "requiredComponents"`**（基础库 ≥ 2.11.1，本项目 3.17.4）。

**结果**：主包 **1.65MB → 281KB**（`js 209 + wxss 43 + wxml 26 + json 2`，**图片 0 字节**），
三条体检项全部可达标；顺带把之前「贴图分辨率不够、手牌发虚」的问题一并消除。

**验证**：`table.js`/`game.js` 语法检查、WXML 配平 + 22 个处理器全在、
IDE 无头 compile `{"status":0}`；另用 Playwright 把真实 `drawTile()` 在 24×32 / 32×42 /
34×44 / 52×70 四档尺寸下画满 34 张牌，确认数字与花色字在最小尺寸下仍可分辨。

**⑰ 牌面走「后端清单 + CDN」（2026-10-18）**

用户口径：接口给地址、图片走 CDN。**代码包依旧零图片**（体检两条线不变），位图全部联网拿。

**服务端**（`packages/server/src/index.ts`）

| 路由 | 作用 |
|---|---|
| `GET /api/tiles` | 清单 `{ version, base, tiles: ['t00.webp', …] }`，`cache-control: max-age=300` |
| `GET /tiles/tNN.webp` | 静态图，`cache-control: public, max-age=31536000, immutable` |
| `GET /api/ui` | UI 贴图清单 `{ version, base, images: { back:'back.webp', … } }`（2026-10-21，键名见 `utils/uiart.js`） |
| `GET /ui/<key>.webp` | 同上静态图，长缓存 |

- 资源目录 `packages/server/public/tiles/`，由 `npm run build:cdn-tiles`
  （`scripts/gen_cdn_tiles.mjs`）从 `packages/client/src/assets/tiles` 降采样生成。
- **格式与尺寸**：139×202 **WebP q=0.92，34 张共 165KB**（同尺寸 PNG 是 1.9MB+）。
  139×202 的依据是手牌条 46×60 在 DPR 3 真机上需要 138×180 物理像素。
- **2026-10-21 换美术**：34 张源图换成 liumengniu/majiang（MIT）的 27 张序数牌
  + 同风格补绘的 7 张字牌（该仓库无字牌），`TILES_VER` v1→v2；详见 §10.9.15。
- UI 贴图（牌背/操作钮/结算艺术字/庄标/大数字）走平行的 `public/ui/` 通道，
  由 `npm run gen:ui-cdn` 生成，`utils/uiart.js` 消费；同样不进代码包。
- 环境变量：`MAHJONG_CDN`（独立 CDN 域名，空 = 与接口同源）、`MAHJONG_TILES_VER`（换美术抬它）、
  `MAHJONG_UI_VER`（UI 换图抬它，与牌面分开 → UI 换图不让客户端重下 34 张牌面）。
- 生成脚本用无头 Chromium 缩放 + 编码（`toDataURL('image/webp')`）：仓库没有 sharp/jimp
  这类原生图像库，手写 PNG 编解码要 200 行；这只是**开发期构建脚本**。

**小程序端**

- `utils/config.js` 新增 `resolveApi()`：由 wss 地址**同域名推导**（`wss://x/ws` → `https://x`），
  可用 `wx.setStorageSync('mj-api', 'https://cdn.example.com')` 覆盖成独立 CDN。
- `utils/tileimg.js`：清单缓存到 storage（7 天 + 后台校验版本，**断网也能用上次清单**）→
  `urlOf(t)` 给 DOM `<image>`、`preload(canvas)` 用 `createImage()` 预解码给画布。
- `table.js` 的 `drawTile()` 恢复位图分支（`tileimg.art(t)`），**取不到就落回矢量**。
- 手牌条 `wx:if="{{item.cdn}}"` 走 `<image>`，`wx:else` 走矢量文字；单张失败由
  `onTileImgError` 只清该张的 `cdn`，其余继续用图。
- 时序：`initCanvas()` 里 `tileimg.ensure → preload → 重画布 + 重跑 syncHandTray`（已存本帧参数）。

⚠️ **域名必须在小程序后台登记两项**：`request 合法域名`（取清单）与
`downloadFile 合法域名`（`<image>` 与 canvas `createImage` 取图）。没登记时真机只会拿到
失败回调 —— 表现是**全部回退矢量牌面**（能玩，但没有贴图）。

**验证**：shim 模拟 `wx.request` 跑通整链 —— `ws://…:3199/ws` → `http://…:3199` →
`/api/tiles` 返回 34 个文件名 → `urlOf(0)` 取回 `HTTP 200 image/webp 6.9KB`；
死域名 / 无效 CDN 域名两个场景都正确 `failed` 并回退矢量；`wss://majiang.dwzynj.top/ws`
正确推导出 `https://majiang.dwzynj.top`（线上服务端**需重新部署**才有这两个路由，
未部署期间客户端自动走矢量兜底）。另：WXML 配平 + 23 个处理器全在、wcsc 实编、
IDE 无头 compile `{"status":0}`、主包 289KB 且图片 0 字节。

**⑱ 掷骰动画对齐 web 端（2026-10-18）**

用户口径：「打骰子的动画能不能仿照 web 端改造，现在看着太塑料了」。

**原来的问题**：小程序只有一个 `.die-big` —— 米白方块 + 一个 44rpx 的大数字，没有点子、
没有立体感、没有翻滚，`setInterval` 每 150ms 换一次数字。web 端是另一套：DOM 双骰 +
九宫格点子 + 渐变立体阴影 + `@keyframes dice-tumble`（旋转 + 上下抛落 + 缩放）+ 定格文案。

**移植做法**（两页共用，不再各写一份）：

| 文件 | 作用 |
|---|---|
| `templates/dice.wxml` | `wx:template name="dice"`：`.layer > .dice-box > .dice-row > .die-slot(.die-shadow + .die > 3×.die-grid-row > 3×.pip-cell > .pip)` |
| `utils/dice.js` | `dieGrid(v)`（点数 → 3×3 网格，0 空 / 1 黑 / 2 红，1、4 为红）、`pair(a,b,tumbling,land)` |
| `app.wxss` | `.die` 渐变 + `box-shadow` 三层立体（外投影 + `inset 0 -3px` 底部厚边 + `inset 0 2px` 顶部高光）、`.pip` 内凹、`dice-tumble` / `dice-shadow` / `dice-land` 三组关键帧 |

- 页面里 `<import src="/templates/dice.wxml" />` + `<template is="dice" data="{{diceShown, diceMsg, dice}}" />`，
  `game.wxml` / `lobby.wxml` 原有的 `.dice-box` 结构与两页 wxss 里的 `.dice-box/.die-big/.dice-msg`
  全部删除（样式统一上收到 `app.wxss`）。
- **两枚错开相位**：`.die-slot.b` 上 `animation-delay: -0.17s`，两枚不会同步得像贴图。
- **地面投影独立成层**：`.die-shadow` 自己跑 `dice-shadow`（抛得越高越小越淡）——
  做成本体的 `box-shadow` 不会跟着翻滚动。
- **定格回弹**：`tumble` 结束的同一帧切到 `.die.land`（`scale 1.14 → 0.95 → 1`，带过冲的
  `cubic-bezier`），避免「突然停住」的塑料感。
- 翻滚期随机面刷新从 150ms 收到 **100ms**；`wx:key="idx"` 保证 setData 不重建节点，
  否则挂在 `.die` 上的翻滚动画每 100ms 就会从头播一次（看着像卡住）。
- 紧凑档（`@media (max-height: 680px)`）骰子 **50px**、点子 10px、字号 12px；
  rpx 档 96rpx（矮宽窗口里 rpx 会放大到离谱，必须按 px 兜一档）。

**验证**：`dieGrid(1..6)` 逐点核对（点数个数与红点规则全部正确）；把 `app.wxss` 的样式与
模板结构在 Chromium 里复刻截图，1–6 点观感正常、翻滚帧两枚角度不同；
`wcc` 实编模板与两个页面 WXML exit 0、`wcsc` 实编 `app.wxss` OK、IDE 无头 compile `{"status":0}`。

**⑲ 骰子加立体感（2026-10-18，⑱ 的后续）**

用户口径：「骰子能不能加点立体感，现在就像平面骰子一样，加点阴影效果」。

**为什么 ⑱ 之后仍然显平**：只有一个 `0 8rpx 18rpx` 的软投影 + 两条 inset。软投影只会让物体
「浮起来」，读不出**厚度**；而骰子又是纯色浅面，缺少朝向信息 —— 三点加起来就是一张贴纸。

**现在的三层深度线索**（全部挂在 `app.wxss` 的 `.die` / `.die-slot` / `.pip`）：

1. **外形（朝向）**：`background` 两层 —— 左上高光斑 `radial-gradient(70% 56% at 22% 14%)` +
   球面渐变 `radial-gradient(circle at 30% 24%, #fffdf7 → #dcd2bc)`。**高光必须放在 background 层**：
   曾经做成 `::after` 覆盖层，结果把左上那枚点子（1 点唯一一枚、4 点第一枚）洗成灰粉色。
2. **侧面（厚度）**：三段**实色硬偏移** `box-shadow: 4rpx 5rpx 0 / 6rpx 7rpx 0 / 8rpx 10rpx 0`
   （`rgba(199,187,159,.98) → rgba(161,149,121,.9)`）。**这是关键**：模糊投影读作「悬空」，
   实色偏移才读作「块」。三段而不是两段，台阶更密，像连续侧壁而不是叠了两张纸。
3. **落影**：贴地紧影 + 大范围软影，**挂在 `.die-slot` 上而不是 `.die`** —— `box-shadow`
   会跟着元素旋转，挂在骰子本体上时翻滚中阴影会绕着骰子转圈，一眼假；高度变化仍由
   不旋转的 `.die-shadow` 椭圆（`dice-shadow` 关键帧）表达。
4. **点子 = 钻孔**：`radial-gradient(circle at 36% 30%, …)` 深色渐变 + `inset 0 2rpx 3rpx`（内壁阴影）
   + `inset 0 -1rpx 0 rgba(255,255,255,.18)`（孔底反光）+ 外侧 `0 1rpx 0 rgba(255,255,255,.55)`（孔口亮边）。

紧凑档（`@media max-height:680px`，手机横屏实尺 50px）逐条给了 px 版（2/3/4px 三段 + 2/3/4px inset），
两档数值同构。**注意 `.die::after` 已删除**，不要再加覆盖式高光。

**验证**：写脚本把 `app.wxss` 里真实的骰子段（rpx 档 + 紧凑档）`rpx→px` 转换后灌进 Chromium，
渲染 1–6 点与两枚「翻滚中」（旋转 30° / -140°）的帧，`deviceScaleFactor:4` 局部放大看边角；
另渲染 `.dice-box` 完整卡片确认阴影没有糊到下方文案。`wcsc` 实编 `app.wxss` OK、IDE compile `{"status":0}`。

**⑳ 下一局已开局，客户端却卡在准备界面（2026-10-18）**

用户截图：大厅里堆着一排「⚠ 对局进行中，无法准备」，但新一局其实已经开起来了。

**完整因果链**（点「下一局」触发）：

1. 服务端 `finalizeIfReady()` 里是 **`broadcastLobby()` 紧接着 `startGame()`** —— 客户端在同一毫秒
   连收 `state`（大厅）+ `game`（新一局）。`nextRound` 之前还先单发一条 `state`，共三条。
2. 小程序是三个独立页面：收到 `state` 立刻 `redirectTo(lobby)`，把人从摊牌页踹回大厅；
   紧接着的 `game` 落在**正在销毁**的对局页上（`current` 还是旧页），回调打进死页面 → 不跳转。
3. 人停在大厅，而新一局正等**本人掷骰**（`ceremony.state = 'wait-roll'`）→ 之后不再有任何
   `game` 广播 → 永久卡死。点「准备」只会刷「对局进行中，无法准备」。

**修复（三层）**：

- **服务端（根治）**：`finalizeIfReady()` / `ready` 分支改成「能直接开局就**不再广播大厅态**」——
  大厅要的一切（分数、昵称、庄家）`game` 视图里都有，跳过广播没有信息损失；
  `nextRound` 只在**没开成**（还有别人没点）时才回 `state`。同一毫秒的 state+game 不复存在。
- **客户端 `utils/room.js`（兜底）**：新增 `navigate()` 跳转合并 —— `redirectTo` 压到本 tick 末、
  **只保留最后一个目标**，并引入 `navInFlight`（在途目标优先于 `current` 判断自己在哪页，
  由新页 `attach` 清空；跳转失败清 `current` 交给 `ensureCurrent` 自愈）。这样无论服务端
  消息怎么排序，客户端最终都落在**最后一条消息**对应的页面。
- **客户端自救**：大厅 `onError` 看到「对局进行中」→ `room.recoverGame()`：跳回对局页 +
  用本地 token 发一次 `resume` 把当前视图要回来。为此服务端放开了 `resume` 的
  「你已经在房间里了」限制 —— **同连接、同座位**的重复 resume 视为合法重同步（换设备顶号语义不变）。

**连带修复（别漏）**：以前「结算浮层」是靠 `state` 里 `hideSettle()` 收掉的，现在开局不再广播
大厅态，两端都要靠 `game` 自己收 —— web `main.ts` 的 `renderGame()`（`v.phase !== 'over'` 时
`hideSettle()`）、小程序 `game.js` 的 `renderGame()`（`settleShown` 置 false 后**必须走
`syncModal()`**，`modalOpen` 是六个浮层标志的取或，直接 setData 会漏掉画布 `.on-modal` 的摘除）。

**验证**：

- 消息时序（临时服务端 + WS 机器人局）：修复后点「下一局」只收到一条
  `game phase=playing ceremony=wait-roll`，不再有 `state`。
- 路由单测（vm 加载真实 `room.js` + 假 `wx`/假页面栈，7 条全过）：`state+state+game` 只跳一次且
  落到对局页；只收 `state` 回大厅；大厅收 `game` 进对局；`game→state` 落大厅；同页不重复跳；
  对局页收 `game` 不跳；`recoverGame()` 回牌桌。
- `resume` 自救链路（真服务端）：`playing` 阶段发 `resume` 能拿回 `game` 视图（修复前回
  「你已经在房间里了」）。
- `typecheck` 零报错、`NODE_OPTIONS= npm run build` 通过、IDE compile `{"status":0}`。

### 10.9 牌桌信息密度重排：删对手手牌背 · 牌河吃满四条边 · 铭牌加「手牌 N」（2026-10-18）

用户反馈（附截图）：「牌河牌张太小看不清，框选那一片全是其他玩家的手牌，把空间让给牌河；
核心元素等比放大；铭牌上要有剩余手牌数并标明是手牌不是牌河。」

**真因**：`table.js` 沿用了 web 端早期布局 —— 四条边（每条 22~32 逻辑宽）画的是各家**手牌背**，
牌河被挤在牌墙环内只剩 **24×32**。画布逻辑 1280 宽在真机上约 500 CSS px，牌河单张落到屏上只有
**9×12**，花色和数字根本认不出。

**改动（全部在画布逻辑坐标 1280×640 内，视觉风格不动）**

| 元素 | 改前 | 改后 |
|---|---|---|
| 对手手牌背 | 四条边各 13 张 / 22×30，占满边带 | **整条删除**（张数改由铭牌显示） |
| 牌河 | 环内，24×32 | **四条边**，46×58（间距 48/60）；上/下 13×2=26 张，左右 5×8=40 张 |
| 副露 | 环外贴边（20 / 1260） | **环内四侧** 40×52：自己 y400、对家 y160（右对齐 950），上/下家竖排 x330 / 右对齐 955（起点 y216） |
| 铭牌 | 130×40，第二行只在不轮到自己时显示「N 张」 | **168×50**，第二行左「手牌 N」胶囊 + 右状态（胡牌！/托管中/出牌中，当前出牌方边框呼吸） |
| 结算横幅 | 画布顶端 y4（440×44） | 环内 y214（340×40） |
| 回合光标 | 围着已删除的手牌带画金框 + 箭头 | **删除**（改由铭牌边框呼吸表达） |
| DOM 手牌（紧凑档） | 46×60，数字 22 | **46×66**，数字 25 / 花色 12 / 风箭 27；≤700px 退 39×55 |

**「手牌 N」的口径**：数值取 `view.counts`（服务端 `hands.map(h => h.length)`），摸牌 +1、出牌 −1、
碰/杠 −n，随每个状态帧自动刷新；发牌仪式期间用 `effCounts`（随发牌动画递增）。文案**必须带「手牌」二字** ——
牌河现在占四条边，光写「13 张」会被读成弃牌数。

**踩到并修掉的三个几何坑**

1. **结算横幅压牌**：横幅原来在画布顶端（y4），而删掉手牌背后「对家摊牌」正好铺在顶边 —— 实测挡住 9 张明牌。
   挪到环内 y214 后：对家副露 160~212、中心盘从 256 起、左右竖排副露止于 x450 / 始于 x835，横幅 470~810 全避开。
2. **回合光标浮在牌河上**：`drawTurnCursor()` 按 `counts*34` 在四条边画金框，手牌带没了之后它就是一串空框 + 箭头，
   直接飘在牌河上方。整方法删除。
3. **副露互叠**：对家横排（右对齐 950，最多 4 组 516 宽）与下家竖排（右对齐 955）原本都从 y160 起 → 3 组以上就叠。
   竖排起点改 **216**（对家横排底 212 之下）。极端情况（左右 4 组 + 自己 3 组）仍会在环内下沿擦到约 44px，已接受。

**验证**（无自动化测试，靠真实视图 + 真实画布）

- 起临时服务端（`PORT=3201 MAHJONG_TURN_MS=1200 MAHJONG_AUTO_MS=120 …` 把机器人节奏调快），
  WS 走 `create → addBot×3 → rollDealer → setAuto → ready`，由服务端把一局打完并抓真实 `GameView`；
  顺带验证 `counts` 序列（`13/13/13/13 → 14/13/13/13 → 13/14/…`、碰后 `-2`、出牌 `-1`）。
- 自写 CommonJS mini-bundler 把 `utils/table.js` + `lib/shared/*` + `tileimg.js` + `config.js` 打包注入 Chromium，
  `new Table(canvas, 2).render(view)` 在真实 1280×640 画布上截图；`page.screenshot({clip})` 做局部放大看铭牌/牌河。
- **极限帧**：真实视图改写成「牌河 18/14/12/9 + 每家 3 组副露 + 超长昵称 + 三位数总分」验证最坏兜底；
  另造「对家 14 张摊牌」帧验证顶边两行明牌不碰横幅、赢家高亮框被夹到 `y=0` 不被裁。
- `node --check utils/table.js`、`wcsc` 实编 `game.wxss`/`app.wxss`、IDE 无头 compile `{"status":0}`。

**二次放大（2026-10-18 晚，用户截图圈中心盘「字号过小」）**

| 元素 | 改前 | 改后 |
|---|---|---|
| 中心信息盘 | 220×140 @ (530,256)，牌墙字 12 / 风位 14-15 / 骰子 32 / 精牌 34×42 | **288×140 @ (496,256)**：牌墙字 14、风位 17-18（庄标 34×26）、骰子 **44**、精牌 **46×58**（与牌河同尺寸）、正/副精标签 12 |
| 掷骰按钮 | 140×44，字 17 | **190×60**，字 22（等待文案 15） |
| 四角铭牌 | 168×50 @ INSET 16，名字 11 / 手牌数字 14 / 状态 12 | **220×54 @ INSET 14**：名字 13、手牌数字 16、状态 13-14、庄标 24×20 |

几何依据（放大后仍不压牌）：中心盘**高度不动**（上和对家副露 y≤212、下和自己副露 y≥400），
只向两侧扩——左右副露最宽 490 / 795 起，288 宽正好嵌中间；铭牌高 54（INSET 14 → 占 y14..68 /
y572..626），左右牌河 y70..548、上下牌河 x≥328，四角让位依旧成立。精牌「其余 10 张结算揭晓」
从盘外 (640,400) 挪进盘内，避免悬在盘外。结算横幅（y214..254）与中心盘（y256 起）刚好错开。

**没动的地方**：`packages/client/src/table.ts`（web 端）仍是旧布局（RIVER 24×32、四条边手牌背、画布内
`drawMyHand`）—— 两端渲染已分叉，要同步需单独一轮。

### 10.9.1 3D 立体牌面（2026-10-18）

**总架构**：三条管线，布局坐标一律不动（tilt 只改屏幕外观四边形，`hitTest` 不含牌张 → 无逆变换补偿）：

1. **DOM 手牌条（真 CSS 3D）**：`.tray-row{perspective:460rpx}` + `.tile-btn{transform:rotateX(16deg);transform-origin:50% 100%}` + 两段 box-shadow。`:active` 只加深阴影、**不做位移**（scroll-view 垂直裁溢出，抬升会被切角）。
2. **画布牌张（分区伪 3D）**：`drawTile` 第 7 参 `tilt` 非空 → 投影贴片（离屏预渲染、不随牌转）→ 底边厚度（右下挤出 3px）→ K 条横切片 `drawImage` 拼梯形（条间 +1px 重叠）→ clip 梯形铺顶光 → 梯形描边。矢量牌面/牌背先离屏渲染成平面源（按 `t|w|h` 缓存，上限 80 份），位图直切 —— 两路共用一个变换。
3. **牌墙保持平面**（量大且是背景）；ghost 从平面插值到目标牌河 tilt（起飞平、落地立）。

**分区参数**（`sq`=垂直压缩、`ts`=顶边宽比、`dz`=深度缩放，锚定底边中点）：

| 区域 | sq | ts | dz |
|---|---|---|---|
| 牌河·自己侧（槽位 0） | 0.90 | 0.960 | 1.02 |
| 牌河·左右（槽位 1/3） | 0.89 | 0.958 | 0.97 |
| 牌河·对家（槽位 2） | 0.88 | 0.955 | 0.94 |
| 副露（MELD 区） | 0.93 | 0.972 | 1.00 |
| 中心精牌（立牌展示） | 0.80 | 0.930 | 1.04 |

对局中 `slices=8`、结算相位 `lowSlices=4`；`jingBorder`/金框/`drawLastMarker`/`drawDeclared` 全部走同参数梯形（`quadPath`），保持「金垫底、精在上」；赢家高亮矩形按 tilt 上下内缩 4px。
**降级**：离屏画布不可用（极老基础库）自动回落平面；`TILE_TILT.on=false` 一键整体回退。
**铁律**：任何 `shadowBlur` 不进逐帧逐牌路径（只允许在预渲染贴片里烤一次）。

> 2026-10-20 订正（§10.9.2）：`lowSlices` 4 → 8。「条中心采样」近似下，切片对四边形
> 四角的欠覆盖 = 半条高 × 边斜率；结算相位侧边牌（x1022..1260、d 0.63..0.94）斜率可达
> 0.32，4 条欠 1.9px，牌角会露出底衬/厚度边。over 相位只静态渲染一次（无 rAF），
> 切片数没有性能代价，故两相位统一 8。赢家高亮改走 `revealRects` 投影四边形
> （§10.9.2），「上下内缩 4px」的逻辑随 `revealRects` 改存四边形一并删除。

**验证**（无回归脚本，按约定临时 harness）：临时服务端 + WS 抓真实 `GameView`（对局中/胡牌结算/流局），自写 CJS loader 把 `table.js` 灌进 Chromium（`wx.createOffscreenCanvas` 走 document 兜底）渲染 + 3x 局部截图；帧耗时：对局中 91 张 ≈ 4.3ms、结算 ≈ 5.0ms（桌面 Chromium，低端机靠 slices 降档 + `TILE_TILT.on=false`）。

### 10.9.2 侧视俯瞰透视布局（2026-10-20）

用户参考图确认的四项决策：**温和 0.58 一点透视 / 对手手牌=紧凑牌背摞+张数 / 牌河=四边梯形带 /
仅小程序端**（web `table.ts` 仍不同步，见 §10.9 末）。核心全部落在 `utils/table.js`
（+821/−190，含 §10.9.1 的 3D 管线本身——该实现曾因会话压缩从工作区丢失，从 transcript
回放恢复后在本节之上继续改，恢复过程记在 `memory/2026-10-20.md`）。

**投影模型**（`PROJ`，`projD`/`projPt`/`projQuad`）：

```
d(y) = 0.58 + 0.42·y/640        // 顶边收敛到 58% 宽、底边 100%
x′   = 640 + (x − 640)·d(y)     // 只收敛 x、y 不动
```

`projQuad(x,y,w,h,z)` = `tiltPts`（§10.9.1 的 Lean 梯形）→ **zw 宽度补偿**（锚定底边
中点，远处被横向压缩后放大保可读）→ 逐角过投影。**逻辑网格（riverPos/meldPos/slotPos/
中心盘）一行不改**，y 不动还让上下两条牌河在屏幕上仍是水平行；牌张在画布内无热区
（`hitTest` 只剩掷骰钮 + 四角铭牌）→ 无需逆变换。

**两轴分区 `resolveZone(tilt)`**：投影（PROJ）与 Lean（TILE_TILT）**互相独立**——
`zw` 属投影轴（PROJ.on 时常开）；`sq/ts/dz` 属 3D 轴（`TILE_TILT.on` 且分区 `fx` 非
`flat` 时生效）；`fx:'flat'`（牌墙 `WALL_TILT`）= 只投影不 Lean；`tilt.proj===false`
（`STAND_HUD`）= HUD 牌只 Lean 不投影。**HUD 不投影原则**：铭牌/中心盘/骰子/横幅/气泡
全部留在逻辑坐标（= 屏幕位置）→ `hitTest` 与 `fitCanvas` 的均匀换算都不动。

**zw 上限 = 牌河螺距 / Lean 后牌宽**（48 / (46×dz)，几何校验实测出的一等约束，
超了相邻牌底边开始相交）：

| 区域 | zw | 上限 | 超限后果 |
|---|---|---|---|
| 牌河·自己侧 | 1.02 | 1.023 | 0.75px 叠 |
| 牌河·左右 | 1.09 | 1.076 | 1.4px 叠 |
| 牌河·对家 | 1.14 | 1.110 | 4.2px 叠 |
| 牌墙（flat） | 1.30 | 30/22=1.36 | 螺距 30 与牌宽 28.6 仍留缝 |

**其余新增/改动**：

- **`drawHandStacks()`**：三家对手各一摞级联牌背贴铭牌内侧（`handStackOrigin` 逻辑落位
  在四角空白区、投影后正好挨铭牌；张数取 `effCounts`，≤14 封顶；slot 0 不画——手牌在
  DOM 手牌条）。级联重叠是刻意造型，几何校验的「牌河×牌河」自检对这类同摞不计。
- **牌墙静态层离屏预合成**（`_wallCache`，key=`jingFaceSlot|jingPi|removed.join('')`）：
  272 张全走四边形切片太贵 → key 不变逐帧只 blit 一次；发票动画按 step 递进不会逐帧重算。
- **中心信息盘 288 → 218 宽（532..750）**：竖排副露被透视向中心拉进 ~38px
  （(795−640)×(1−0.756)），盘顶 y=256 处投影窗口只剩 (527.8, 756)，288 宽的盘必被
  副露角铲进（几何校验实测：nanchang 1 对 / gz 2 对相交）→ 内部由「大数字|骰子|立精」
  横排改**两栏**（左栏牌墙大数字，右栏骰子+立精+标签，「其余 10 张结算揭晓」挪左下）。
  高度仍 140（上距对家副露 212 有 44、下距自己副露 400 有 4）。
- **结算缩排河外移**（`riverOverOrigin`：slot 3 x116→122、slot 1 x1022→1016）：原与
  摊牌外侧列逻辑缝仅 2px，投影剪切后两列底部两角相擦 0.5px → 扩到 8px。
- **`revealRects` 改存投影四边形**（`drawRevealHand` 写入，`drawWinnerHighlight` 走
  `quadPath(quad,10)`）：赢家高亮框与牌身同形；旧「上下内缩 4px」删除。
- `drawCenter`/`drawLastMarker`/`drawDeclared`/`jingBorder`/`drawJingHighlight` 全部改走
  `projQuad`/`projPt`；`PROJ.on=false` / `TILE_TILT.on=false` 各自一键回退。

**DOM 侧（`pages/game/game.wxml|wxss`，2026-10-20 出血对齐 + HUD 圆钮）**：

- **操作区宽度绑 `canvasW`**（`style="width:{{canvasW}}px;margin:0 auto"`）：画布在
  「行宽 < 行高×2」时常窄于行宽（`fitCanvas` 取 `min(可用宽, 行高×2)`），全宽操作区
  会探出画布两缘；绑宽后状态行/遮罩/手牌条与画布左右缘逐像素对齐。
- **`.tray-row` 居改 space-between**：有余量时两端铺满「出血」到画布两缘（参考图满宽
  手牌带）；内容超宽（小屏横滑）时自动退化为左起排列，滚动行为不变。
  ⚠️ **此决策已于 2026-10-21 废止**（§10.9.13）：条宽改按满编 14 张预算后，空余是常态，
  space-between 会把牌缝摊成几十 px（副露后只剩 7 张时实测 57px）。现为
  `width:max-content + margin:0 auto + justify-content:center`。
- **`.canvas-wrap` align-items: center → flex-end**：画布坐在手牌条正上方（无垂直余量
  时与原来完全一致——手机横屏常态即如此，改动零表现）。
- **HUD 右侧四枚正圆图标钮**（💬/🤖/🎯/✕，`.hud-ico` 定尺正圆、托管激活 `.on` 金底）：
  只改外观不动布局，直径与原文本钮同高（52rpx / 紧凑档 26px）。

**验证**（无回归脚本，按约定临时 harness，两轮都通过才算完）：

1. **Node 几何校验**（`.recover-tmp/geomcheck.cjs`，mock 2D ctx + CJS loader 灌
   `table.js`）：4 个合成 `GameView`（nanchang/gz 对局、掷骰、结算）逐帧截获 `drawTile`
   参数与切片 `drawImage` 落点 → ① 复本四边形（与 `projQuad` 同公式）vs 切片并集
   ±1.6px 互相印证（121/89/2/138 张）② 出界检查 ③ SAT 凸四边形跨类相交（牌河×铭牌/
   牌墙/副露/信息盘/手牌摞、副露×盘、摊牌×缩排河/副露/盘/墙、牌墙×铭牌/盘等 20+ 组，
   牌河自检用 1.5px 紧排容差）。**本节的 zw 上限、盘宽 218、缩排河外移、lowSlices=8
   全靠这轮检出/定位**。
2. **Chromium 实渲染**（`.recover-tmp/shots.cjs`）：同组合成视图 + tileimg stub（强制
   矢量牌面）+ 禁 rAF 稳态 → 4 相位全景 + 局部 3x 截图人工核对（透视收敛/四角铭牌/
   两栏信息盘/副露柱不铲盘/摊牌同边共存/赢家金框/精描边/金框末牌全部就位）。
   帧耗时（同机 Chromium，连渲 30 帧均值，合成满桌牌）：对局 122 张 ≈ 6.6ms、
   结算 139 张 ≈ 21ms（一次性静态渲染，无 rAF）、掷骰 ≈ 0.5ms；Node mock ctx 下
   纯 JS 几何成本 0.36/0.49ms。低端机降级 = `TILE_TILT.on=false`（连切片路径一起退
   平面）+ `PROJ.on=false`。

**仍待**：真机横屏预览（刘海安全区第三轮方案 + 本轮出血对齐/HUD 圆钮一并回报）；
web `table.ts` 未同步（用户确认本轮不做）。

### 10.9.3 氛围对齐：藏青桌面+金框 / 绿背立体墙 / 牌匾信息盘 / 风位圆牌（2026-10-20）

用户第二张参考图（商业麻将牌桌实机）→ 决策「全对齐（P0+P1）」+ 中心盘「精简混合
（大数字+风字+立精）」。**IP 口径先行：只借鉴结构与信息分工，不复制其雕花框/头像框/
徽标等受保护资产**——全部用自有矢量画法重绘。改动仍全部落在 `utils/table.js`
（P0 逻辑网格与热区零改动；P1 铭牌只改内部排布、几何不动）。

**P0 氛围三件**：

- **`drawTable` 桌面换装**：外底 `#14241c`→`#0d1626`、felt `#1d4030`→`#1b2c4a` 藏青、
  外框 `#2a5a44` 2px → `#a8823c` 4px 金边 + 内侧 1px `rgba(255,214,120,.32)` 暖金高光
  （双线金框，暗示参考图「木金外框」但不做雕花）。drawTable 是背景，不参与牌张几何校验。
- **`paintTileBack` 牌背蓝→绿**（`#4f97e6`→`#177a4a`、描边 `#13325f`→`#0c4630`）：
  牌墙 / 对手手牌摞 / 暗杠 / 飞行幽灵牌一起换色，零几何风险。
- **满铺立体绿背墙**（`WALL_TILT` + `WALL_PITCH`/`WALL_ACROSS`）：
  `WALL_TILT` 由 `{fx:'flat', zw:1.3}` → `{sq:0.94, ts:0.965, dz:1.05, zw:1.3}`（全套 3D：
  投影+厚度+8 切片+顶光）——272 张的成本由 `_wallCache` 离屏预合成吸收，**只在 removed
  变化的帧重绘**；`WALL_PITCH` 30→28、`WALL_ACROSS` 26→28：相邻牌投影后 x 向 ~30px >
  螺距 28 → **墙缝弥合成「一面墙」**（参考图核心观感）；底衬 `rgba(0,0,0,.4)`→`#0f2b1e`
  深绿墙裙。墙几何账（geomcheck 复跑验证）：横墙 span=19×28+22=554（x363..917）、
  竖墙 span=13×28+22=386（y127..513）；侧墙内缘 284+28=312 仍离左副露列 x330 有 18px；
  横墙脚 473..501 与底牌河 y506 / 摊牌底排 y506 均有 ≥5px 缝。

**P1 布局对齐**：

- **中心信息盘（`drawCenter`）外框 532..750×256..396 不变**（§10.9.2 的几何结论勿回退），
  只换皮与内容：深色牌匾（`rgba(8,12,18,.85)` + 2px 金边 `#c9a54a`）；左栏「牌墙剩余
  **54px 大数字** + 庄家风位 **22px 金**」（对应参考图「05 / 东」）；右栏立精 34×44→
  **36×46** 仍是 STAND_HUD（Lean 不投影）；骰子面对面撤除、改左栏底部 10px「骰 3·4」
  小字（值逻辑不变）；「牌墙」文字标签撤除给大数字让位；「其余 10 张结算揭晓」9px 挪
  盘底居中。rollBtn（bx/bw/bh）位置不动。
- **四角铭牌头像化（`drawTag`）**：`TAG_W/TAG_H/INSET/pos` **一行不动** →
  `tagRects` 不动 → hitTest 点击区 / 气泡锚点 / 表情飞行动画锚点零移动。左侧新增 **34px
  风位圆牌**（金边深底 / 庄家金底深字，风位随庄 `this.wind(seat)`，替代参考图的「头像」——
  真实微信头像需协议加 `avatarURL` + CDN downloadFile 域名登记，属独立需求）；`庄` 徽标
  24×20→22×20 跟在圆牌后；宝×N 徽标不变；昵称 label 去掉「风位·」前缀（风位已在圆牌），
  截断逻辑不变，昵称为「我」时不再追加「·我」（否则「我·我」）；「手牌 N」胶囊左缘由
  「跟昵称起点 tx」改**固定 x+10**（与圆牌左缘对齐，tx 现在会随庄/宝徽标右移）。
- **自家副露确认不动**：y=400 受底牌河 y506 与墙脚 473..501 夹击，最多下移 ~12px；
  参考图「副露贴手上沿」靠的是手牌在画布内，我们是 DOM 手牌条在画布外——记录原因备查。

**验证**（两轮 harness 均临时、无回归脚本）：

1. **geomcheck 双快照修复（顺带堵住一个老盲区）**：墙走 `_wallCache` 后**第二帧只剩
   blit、零 drawTile —— 此前所有「×牌墙」pairs 其实一直在空跑**（§10.9.2 引入墙缓存时
   留下的盲区，本轮墙大改时才暴露）。改为「第一帧（建墙缓存，wall=83/136 张）+ 第二帧
   （稳态 blit）」分别跑全套检查。本轮新墙第一次真正过检：牌河×墙 / 副露×墙 / 手牌摞×墙 /
   墙×铭牌 / 墙×信息盘 / 摊牌×墙全部零相交；复本印证 204/172/138/221 张、出界、墙 blit 均过。
2. **Chromium 实渲染**（shots.cjs 同口径 + tileimg stub 强制矢量牌面）：4 相位全景 + 新增
   顶墙特写 / 左右铭牌特写人工核对：四面绿背立体墙连续、藏青桌+金框、牌匾盘（大数字/
   风字/立精橙紫描边/骰子小字）、风位圆牌（庄家金底）、摊牌赢家金框、暗杠绿背。
3. **帧耗时**（Chromium 连渲 30 帧均值，122 牌满桌）：对局 4.0~6.1ms / 结算 22.8ms
   （一次性静态）/ 掷骰 0.3ms；**墙缓存重建帧增量 ≈ +5ms**（只在摸/打牌 removed 变化帧付，
   逐帧稳态不受影响——wall-rebuild 口径为本轮新增测量）。
4. `npm run typecheck` + `NODE_OPTIONS= npm run build` 均过。

**仍待**：真机横屏回报；`.recover-tmp/` 清理（pre3d 备份 + 三个 harness）；git 提交；
web `table.ts` 不同步（延续 §10.9.2 口径）。

### 10.9.4 离屏画布签名事故：进对局整桌白屏（2026-10-20，首次真机/PC 微信验证）

**现象**：Windows 微信开发者工具进对局后整桌白屏（只有桌面梯形与四边深绿墙底衬），
控制台刷屏：
`Invalid context type [2d] for Canvas#getContext` +
`TypeError: Cannot read property 'beginPath' of null` at `roundRect` ← `paintTileBack` ←
`tileFace` ← `drawTile` ← `paintWall` ← `drawWall` ← `render`。

**根因**：`Table.newCanvas` 用的是**旧版签名** `wx.createOffscreenCanvas(w, h)`。官方文档
明确「旧版入参**只能创建 webgl 类型**」，要 2D 必须用对象签名
`{type:'2d', width, height}`（基础库 ≥ 2.16.1，Windows/Mac/鸿蒙版均支持）。拿到 webgl
canvas 去 `getContext('2d')` → 报 Invalid context type、返回 null → `tileFace` 把 null 当
ctx 传给 `paintTileBack` → **崩在整帧第一张牌**，于是「啥都显示不出来」。3D（§10.9.1）
与透视（§10.9.2）两轮此前只用 Node mock + Chromium harness 验证，浏览器有
`document.createElement` 兜底，把这条真机专属缺陷完全掩盖了。

**修复**（`utils/table.js`）：

1. `newCanvas` 改对象签名，并在创建后**立刻探一次 2D 上下文**（`getContext('2d')`）——
   拿不到就判定该环境不支持离屏 2D。
2. `tileFace` / `shadowSprite` / `renderWallCache` 三处 `getContext` 全部 try/catch + 空守卫
   （不再把 null 往下传）。
3. 能力缺失时置 `Table._canvasOff`（**只 warn 一次**，不刷屏），`drawTile` 走
   **投影包围盒近似**：按 `projQuad` 的 bbox 画一张矩形牌——丢梯形/厚度/顶光，
   保住位置与大小。**不再退回「未投影平面」路径**（那条路径会让牌跑出已收敛的桌面边缘，
   整桌错位）。

**harness 加固**：

- `geomcheck.cjs` 的 wx mock 改为**只接受对象签名**（传位置参数直接抛错）——以后谁写回
  `createOffscreenCanvas(w, h)` 会立刻红，不会再到真机才发现。
- 新增「降级路径」用例：`Table._canvasOff = true` → 410 张包围盒牌 / 0 切片 / 无抛错 /
  无出界（`drawJingHighlight` 在 translate 后的局部坐标系里画牌，按同一口径跳过）。
- `shots.cjs` 新增 `DEGRADE=1` 模式，出 `*__degraded.png` 对照图：**降级后是完整可玩的
  一桌牌**（矩形牌、位置仍收敛），不是白屏。

**验证**：geomcheck 全绿（含降级用例）；shots 正常/降级两套图均过；`typecheck` 过。
**仍未验证**：iOS/Android 真机上离屏 2D 的实际支持情况与 `drawImage(离屏 canvas → 主画布)`
（官方称「新版 Canvas 2D 接口与 Web 一致」，理论支持）；若某环境拿不到离屏，控制台会有
一条中文 warn、画面为矩形牌，功能不受影响。

### 10.9.5 按座位朝向 + 对手手牌重做（2026-10-20，用户报「各方位牌方向/手牌显示异常」）

**① 每家牌朝他自己**：`rotForSlot = [0, -90°, 180°, +90°]`（自己 / 下家-右 / 对家-上 /
上家-左），牌河、结算缩排河、副露、报杠展示、摊牌明牌、墙面翻开的精牌全部按座位转。

**关键实现约束（踩过两次）**：朝向必须做在**贴图**里，不能 `ctx.rotate` 几何 ——
投影是「只缩 x 不缩 y」的剪切变换，90° 在屏幕空间里转会把未缩的纵向尺寸搬到横向，
牌比布局格宽出 ~25%：实测牌河自检 64~72 对相交、牌河压牌墙 13 对、副露吃进信息盘。
最终方案 `rotFace(t, w, h, rot)`：把牌面（CDN 位图 / 矢量 / 牌背三路）先转 `rot` 再画进
一张 **w×h 的离屏图**，`drawTile` 第 9 参只选贴图 —— **几何一行不改**，46×58 占位与
48/60 的布局格、以及此前全部几何校验结论继续成立。180° 的牌照旧走普通缓存（牌面自带倒向）。

**② 对手手牌摞重做**：原先是「沿 x 错开 5.5 + 每张下漂 1.2」的斜向级联，投影一压就是
一条斜着拖尾的绿条。现在改成**沿牌主自己的轴紧密叠压**（不做斜漂），并且**步距按深度
补偿**（`step ≈ 5.5 / d(y)`：顶边 d≈0.60 → 9.1，底边 d≈0.95 → 5.8），屏幕上每张稳定露出
≈5.5px 边条。三处落位（上家 X 在「左牌河右缘 258 / 左牌墙内缘 284」的竖缝、对家在下侧
铭牌左、下家在右下角铭牌左）经几何校验确认不压铭牌/牌河/牌墙。

**③ 牌墙收成闭环**：四条边各画底衬会在四角留断口（一段段绿条）→ 改为沿环画四条
40 宽带子（`WALL_LEFT_X/RIGHT_X/TOP_Y/BOTTOM_Y` 外扩 6px），转角自然搭接，墙读作一圈
完整的墙；桌布同时由 `#1b2c4a` 提亮到 `#23405f`，更接近参考图的蓝。

**④ DOM 手牌条**：`.tile-btn` 补 `flex-shrink: 0` —— 之前溢出时 flex 默认压缩会把牌挤成
十几像素的细条（用户截图里中间几张筒变竖细条的直接原因）；正确行为是保持 46×66 定尺、
交给 scroll-view 横滚。

**harness 两处修正**（这轮才发现的老问题）：

1. **pairs 相交从来没让校验失败**：`if (n > 0) { hits += n; console.log(...) }` 只打印不计数，
   所以「全部通过」的绿灯下一直藏着 11 处真实相交（副露×牌墙 8、副露×信息盘 1、牌河×牌墙 2）。
   改为 `ok(false, ...)`，本轮已把这些旧账清零。
2. **朝向不能进 `quadOf`**：贴图方案下几何不变，复本四边形不该再转（一度把 rot 转进
   `quadOf`，反而把正确的布局判成 84 对相交）。

验证：geomcheck 四视图 + 降级路径全绿（0 处相交）；Chromium 截图确认四家朝向、手牌摞、
闭环墙、提亮桌布；`typecheck` 过。

### 10.9.6 牌面贴图链路：为什么「牌面变成大字」（2026-10-20）

**判断口径**：看到的是「数字 + 花色/风箭大字」= **贴图没加载、走了矢量兜底**，不是美术差。
仓库里的正式素材是 139×202 的 WebP（34 张共 165KB；2026-10-21 起为 liumengniu/majiang
的「数字+牌名」经典牌面 + 补绘字牌，同风格同链路，见 §10.9.15），
换上去后同一套渲染管线的观感差别极大（见 `.recover-tmp/shots/gz_playing__live.png`
对比 `gz_playing.png`：同一局面、同一代码，只差「图有没有加载」）。

**三处通路**（缺一不可）：

1. 服务端 `GET /api/tiles` → `{version, base, tiles:[t00.webp…]}`（`packages/server/public/tiles`）；
2. 静态 `GET /tiles/tNN.webp`（`content-type: image/webp`，长缓存）；
3. 客户端 `utils/tileimg.js`：`ensure`（清单，本地缓存 7 天）→ `preload`（用主画布的
   `createImage()` 预解码 34 张）→ `art(t)` 给 `drawTile`、`urlOf(t)` 给 DOM 手牌条。

**本次补的可诊断性**（此前失败**完全静默**，只能靠肉眼判断「怎么这么丑」）：

- `tileimg` 每个失败分支打**一条**中文 warn（未配置域名 / 清单为空 / 请求失败），成功时打
  一条 info（`ready v1 · 34 张 · base`）；同一条只打一次，不刷屏。
- 暴露 `tileimg.debug()` → `{status, host, version, count, decoded}`，控制台可直接看卡在哪一步。
- 服务端启动自检：`牌面素材 … · 34 张 · 版本 v1`；不足 34 张时直接打 `⚠ 牌面素材缺失
  （n/34）→ 客户端会退回矢量牌面`，**部署漏带 `public/tiles` 一眼可见**。

**排查顺序**：

1. `curl <host>/api/tiles` 必须返回 34 项；少于 34 → 服务端没发布素材（`npm run build:cdn-tiles`）
   或部署漏带目录。
2. 小程序后台登记 **request 合法域名**（拿清单）与 **downloadFile 合法域名**（图片下载），
   开发者工具里也可临时勾「不校验合法域名」。
3. 本地开发不想连线上：`wx.setStorageSync('mj-wss', 'ws://<局域网IP>:3130/ws')` —— `resolveApi()`
   会按 ws→http 自动推导出 `http://<IP>:3130`，清单与图片都指向本机服务端。
4. 仍不行就看控制台那条 warn（它已经写明卡在清单还是域名）。

**顺带纠正一个判断**：开源项目 `liumengniu/majiang`（MIT）的牌面只有 65×99、且缺字牌
（东南西北中发白），**质量低于我们已有素材**；A/B 实测也确认「差距在素材有没有加载，
不在素材好坏，也不在引擎」。所以 A 的落点是**让已有素材稳定加载**，而不是替换素材。

### 10.9.7 透视与牌形的二次修正（2026-10-20，真机截图驱动）

真机截图放大后发现两处**几何层面**的不合理（不是美术）：

1. **左右两家的牌是斜的平行四边形** —— 侧边沿用「竖版 46×58 格子 + 贴图转 90°」，投影剪切
   （只缩 x）被一起转过去，形状从矩形变成斜条。正解：侧边改用**横向格子 58×46**
   （列距 61 / 行距 48 / 4 列 × 9 行 = 36 张），形状是真矩形，只有贴图内容转 90°。
2. **顶部牌河又扁又宽、行间连成一片** —— 「投影压缩 × Lean(sq .88 / dz .94) × zw 1.14
   宽度补偿」三重叠加。正解：牌河 Lean 放缓到 sq .96~.97 / ts .985~.99 / dz 1.0 /
   zw 1.0~1.02，只保留投影本身的透视；上下牌河改 12 列 × 50（缝约 1.8 屏幕 px）。
3. 副露 tilt 同步放缓（sq .96 / ts .99 / zw 1.04）；左右摊牌同步改横向格子（与牌河同参）。

**代价与取舍**（都可接受，记录备查）：牌河容量 39/26 → 36/24（实测单家最大弃牌约 20 张）；
水平牌河起点 328 → 322（13 列 ×50 会顶到右墙，改 12 列后避开）。中途试过把 WALL_ALONG
22→26 让墙连成一条，会顶到上家/对家手牌摞（9 + 17 对相交）→ 已回退。

验证：geomcheck 四视图全绿（牌墙/副露/手牌摞/信息盘零相交）、typecheck 过、真实素材实渲染核对。

### 10.9.8 取消牌墙 + 重排四边（用户要求：让牌河/副露/手牌更好显示，收紧中央空地）

- **牌墙关掉**：新增 `SHOW_WALL=false`。`drawWall` 保留两个不可见副作用 —— `prevRemoved` 记账（发牌 ghost 仍从原墙位飞向各家）、`wallLeft` 仍由 `computeRemoved` 算（中心盘照常显示余牌数）；牌墙本体（底衬环 + 272 张牌背）不再绘制。`drawJingHighlight` 直接 return（墙上那格翻开的精牌没有落点，盘内已展示立精）。想恢复只改常量。
- **牌河放大**：46×58 → **50×62**；上下 12 列×50 → **13 列×54**（x291..989，y4..132 / 504..632）；左右 4 列×61 → **3 列×66 横向 62×50**（x18..212 / 1068..1262，y100..528）。容量 上下 26 / 左右 24。
- **中心盘放大**：218×140 @(532,256) → **280×188 @(504,236)**；数字 54→72、风字 22→30、立精 36×46→48×62、标签 9→11、按钮 190×60→240×84。盘与牌河间距：上 138→104、下 110→80。
- **副露外移避让**：侧边 330→**290**（左）/ 955→**1000**（右）；对家 160→148、自己 400→430。
- **对手手牌摞改 HUD**：挪到四角暗区（不投影、不吃布局），18×26、步距 9、最多 12 张；右上对家 / 左上上家 / 右下下家。
- **结算超排简化**：单家 >18 张弃牌时不再切 30×38 小牌（会和网格互压），直接跳过不画；`riverOverPos` 仍 clamp 兜底。
- 验证：geomcheck 四视图 + 降级路径全绿（wall 相关 pair 自动失效，blit 检查改为「有墙才查」）；typecheck 过；`shots_live` 出图（对局/结算/掷骰三相位）。
- 遗留观感：弃牌少时中央仍有空地（牌数决定，非布局）；牌墙消失后「136」这个大数字少了语境，可考虑加一个 9px「余牌」小标签。

### 10.9.9 牌形与手牌的根因修复（2026-10-21，用户报「牌桌上的牌显示异常并且手牌也显示异常」）

这一轮不是调参，是四个**确凿的实现缺陷**被逐个定位后修掉。定位手段分别是
「隔离贴图实验（§rottest）」「实渲染放大对照」「geomcheck 复本印证」。

#### (1) `rotFace` 对 180° 用错了内框尺寸 —— 对家牌面被切一半

`rotFace(t,w,h,rot)` 原来不分角度，一律把贴图塞进 `h×w` 的内框（注释写「转完坐标系里
可用的矩形是 h×w」）。这对 ±90° 成立（宽高确实互换），但对 **0°/180° 是错的**。
实测（`.recover-tmp/rottest.cjs`，四角度 × 两种格子并排出图）：180° 时贴图被塞进一个
62×50 的横向框再旋转，结果**左右各裁 ~10%、上下各留 6px 空带**，对家整条牌河的牌
看起来「被切了一半」。

修法：`swap = Math.abs(Math.sin(rot)) > 0.5`，只有 ±90° 才换轴，内框 `bw×bh` 居中铺，
裁剪比也按 `bw/bh` 算。四角度实测全部精确填满。

#### (2) 一张牌自己是楔形 —— 「牌在融化 / 斜切」的真正来源

投影 `x′ = 640 + (x−640)·d(y)` 是**逐角**取的。一张 50×62 的牌，上下沿的 `d` 相差
`0.42·62/640 ≈ 4%`，离中线越远差得越多（x=291 处左右各缩 **14px**）—— 牌被画成一个
楔形，而牌面贴图是靠 `drawTileSlices` 逐条重采样铺上去的，楔形 + 重采样 = 笔画被逐条
拉斜。放大真机截图能直接看到「每张牌左沿有 2~3 级台阶」（切片按中点取左右边，
相邻切片错开半格）。

修法：`projQuad` 增加 **`z.rect` 分支**（`resolveZone` 对牌张一律置位）——
`d` 只按**牌心**取一次，整张牌等比缩放，四边形退化成真矩形。桌面 `drawTable` 直接传
`{proj:true}`、不经 `resolveZone`，所以**桌面整体纵深一点没丢**（仍是梯形）。
同时 `drawTileSlices` 加矩形快路（一次 `drawImage`），侧沿台阶与新采样模糊一起消失。

副作用处理：`revealRects`（结算赢家高亮）原来是对整块明牌算一个大矩形，牌改矩形后
块心缩放 ≠ 逐牌缩放 → 框飞到半空。改为**取所有牌投影四边形的并集 + 5px**，由实际牌位
反推，投影再怎么改都不会错。

#### (3) `PROJ.base` 0.58 → 0.72

0.58 意味着顶边只有底边的 58%（超广角俯拍）。牌内楔形修掉后，剩下的代价是
**左右牌河每往下一行横向漂 ~13px**，整列看着像斜着拖出去的一串。收到 0.72 后漂移
减半，纵深仍在（顶边 72% 宽 + 越远越小）。`geomcheck` 现在直接从 `table.js` 正则读
这两个常量，不再手抄，避免复本与实现漂移。

#### (4) 手牌：rpx 尺寸配 px 字号 —— 宽窗口下牌位放大 2.8 倍并被 `aspectFill` 裁切

`.tile-btn` 是 `76rpx × 92rpx`，rpx 的基准是**窗口宽度**：手机横屏 844px 时 1rpx≈1.13px →
牌位 86×104、一屏只放得下 9 张；PC 微信/平板 1290px 时牌位 **131×158**，14 张要 1870px，
手牌条只能横滑，看起来就是「牌特别大、只露一半」。更糟的是牌位比例 76/92=0.826，
而素材是 139×202=0.688，`<image mode="aspectFill">` 按宽度铺满 → **上下各裁 8.4%**，
数牌「数字在上+花色在下」两行各掉一截笔画。

修法：**牌位与字号全部统一到 px**（`46×66` / 25·12·27，窄横屏档 39×55 / 21·10·23），
两套度量永远同比。紧凑档里那四条重复覆盖已删除（双真相是这次事故的成因）。
实测 1290 / 844 / 667 三个视口牌位都是 48×61（含边框与 `rotateX` 投影），14 张一屏放下、无裁切。

顺带：`perspective` 从 `.tray-row` **挪到每张牌自己身上**。放在父层时整排共用一个消失点，
离排中心越远的牌被剪得越歪 —— 14 张排 700px 宽时两端的牌是明显的**平行四边形**
（近端外扩、远端内收），看起来像「手牌在向两边倒」。改成 `transform: perspective(240px) rotateX(16deg)`
后每张牌左右对称。

#### (5) 四边牌河对称重排 + 中心盘加宽

改前上下 13 列×2 行（横跨 291..1039）、左右 3 列×8 行（18..212）—— 两条边是长条、
另两条是长柱，视觉上完全不对称，正是「错位」的来源。现在**四条边都是同一个方形块**：
`10/12 列 × 2 行`（上下）与 `4 列 × 6 行`（左右），只是旋转 90°；容量统一 24/24。

| 区域 | 位置（逻辑坐标） |
|---|---|
| 上下牌河块 | x 318..962，y 8..136 / 504..632（12 列 × 2 行，容量 24） |
| 左右牌河块 | x 16..276 / 1004..1264，y 160..480（4 列 × 6 行，容量 24） |
| 中心盘 | **320×196 @(480,226)**（原 280×188 @504,236） |
| 侧边副露 | 左起 282 / 右右对齐 998（河与盘之间，4 张杠也放得下） |

盘宽的上限是**被投影的副露**卡死的：副露在逻辑 832 处，投影后落到屏幕 799，
而盘是 HUD（不投影）→ 盘再宽必被副露角铲。320 是「4 张杠 × d(242)=0.826」反算出的
最大可用宽度（留 8px 余量）。

另外两处配套：

- **行距也随深度收缩**（新增 `Table.rowY`）：牌高按 `d` 缩了，行距若仍是常量，
  越远的行越小、缝却一样宽 → 「越远越稀」。逐档乘 `d` 后行缝恒定
  （左右两河 6 行从 160 收到 433，比原来省 47px）。
- **溢出 clamp**：容量从「无限沿边铺」改成固定块后，`riverPos` 把第 25 张起的弃牌
  压到最后一格（叠在一起），好过溢出到副露/铭牌上。对局理论最大 27 张，属极端情况。
- 掷骰按钮改成**铺满盘内**（`px+16, py+16, pw−32, ph−32`）：盘加宽后原来的 240×84
  盖不住内容，上面露出立精顶边、下面露出「骰 x·y」，像两块东西叠着。

#### (6) 牌张阴影的核心 alpha 0.5 → 0.34

贴片是「牌位大小的实心圆角块 + 外扩模糊」，实心块有 ~2px 露在牌外。单张看不出问题，
但副露/牌河是**零间隙紧排**，相邻牌的实心块会拼成一条连续深色底板
（放大看像「牌摆在一个黑托盘上」）。压淡核心、模糊 10→13 后回到「贴合牌的软边」。

#### 验证

- `node .recover-tmp/geomcheck.cjs` → **全部通过**（四视图 × 双快照 + 降级路径 242 张 /
  0 切片）。过程中被它抓出三处真缺陷：牌河自检 6 对不同位置的牌完全重合（clamp 生效前
  的 cap 不足）、副露×信息盘 1 对（盘加宽的代价）、摊牌×结算牌河 5 对（摊牌与缩排河
  只隔 6px，投影下相位漂移就会相交 → 间距拉到 16px）。
- `node .recover-tmp/rottest.cjs` → 四角度贴图全部填满。
- `node .recover-tmp/handshot.cjs` → 1290/844/667 三视口手牌 48×61 恒定、14 张一屏、无裁切。
- `node .recover-tmp/shots_live.cjs` → 四相位出图；对局帧 10.0ms（改前 12.9ms，
  矩形快路省掉 8 次重采样）。
- `npm run typecheck` 通过。

### 10.9.10 侧边副露改成「和牌河同构」（2026-10-21，用户报「副露别面向我横着摆」）

**用户原话**：「副牌能不能不要面向我横着摆放，改为和牌河的一致面向出这张牌的玩家横向摆放」

**先排除的**：朝向本身没坏。`rotForSlot` 一直是对的（自己 0° / 下家 -90° / 对家 180° / 上家 +90°），
`drawMelds` 也确实收到了**屏幕槽位**而不是真实座位（`render()` 里 `drawMelds(view.melds[s], slot)`）。
把 mySeat 设成 2 重新渲染四家副露，方位全部正确。

**真正的两个错**（都在「牌转了 90°，外框和排列方向没跟着转」）：

| | 改前 | 改后 |
|---|---|---|
| 侧边牌格 | 竖版 **40×52**（牌转了 90°，字横着、牌却竖着） | 横向 **56×44**（比例 1.27 ≈ 牌河 62×50 的 1.24） |
| 侧边排列 | 一组副露**横着排一行**（与牌主的行方向垂直） | 一组副露**沿牌主行方向竖着往下排**（步距 46） |
| 观感 | 竖牌 + 横字 + 横排，和左边那列牌河完全两套 | 横牌 + 横字 + 竖排，和牌河一模一样 |

所以「和牌河的一致」= 不只是牌面朝向，**牌格形状与排列方向也要一致**。只改朝向（把 40×52 的格子
继续横排、只转字）会更糟：那正是改前的状态。

**实现**：`meldMetrics(slot)` 统一出口 ——
`slot 0/2 → { w:40, h:52, pitch:40, vertical:false }`、`slot 1/3 → { w:56, h:44, pitch:46, vertical:true }`。
`drawMeldRow` / `drawDeclared` 按 `vertical` 决定沿 x 还是沿 y 铺；`meldSpan` 给出一组副露沿
排列方向的总长（横排=宽、竖排=高）。

**多组副露的换列**：竖排一组 4 张杠 = 3×46+44 = 182，从 y216 起；一列排到 `MELD_SIDE_BOTTOM=548`
（再往下压左下/右下铭牌 y572）就换下一列（左 282→348 往右、右 1000→934 往左），带子
（左 282..480 / 右 800..1000）能放两列，4 组副露也不会顶到铭牌。

**顺手修的一个真 bug**：`drawMelds` 第二个参数是**槽位**，但报杠展示的筛选写的是
`d.seat === seat` —— 拿槽位比真实座位，只有 `mySeat===0` 时才碰巧对。新增
`seatAt(view, slot)`（`disp` 的逆）反算真实座位后再筛。

**为什么不用「横排 + 横牌」**：算过 —— 面板右缘 800（HUD 不投影）到右河左缘（屏幕 939）
只剩 ~139 屏幕 px，4 张杠就算零间隙也要 4×40×0.822 = 131，几乎没有余量；
要让它成立得把牌缩到 40×30 或把中心盘压回 288 以下。竖排一组只占 56 宽，一整列 182 高，
空间充裕且与牌河完全同构 —— 所以选竖排。

**验证**：`geomcheck` 全部通过（四视图 × 双快照 + 降级路径）；`meldshot.cjs` 出 mySeat=2 的四家
副露图，左/右副露与相邻牌河同形同向；`shots_live` 四相位正常；`npm run typecheck` 通过。

### 10.9.11 手牌条改成「按条宽自适应、不滚也能看全」（2026-10-21，用户报「手牌为啥还能滑动」）

**用户原话**：「手牌为啥还能滑动，直接全部显示不行吗，请进行调整」

**根因：两个真相互相补不齐**

| | 改前 |
|---|---|
| 牌位 | 46×66 px 定尺（14 张需 679px；还有 1px 边框 → content-box 下实际 707px） |
| 条宽 | 绑 `canvasW` = `min(行宽, 行高×2)`，PC 宽窗能到 918px、**手机横屏只有 ~520px** |
| 兜底档 | `@media (max-width:700px)` 缩到 39×55 —— 断点按**窗口宽**判，844px 的横屏手机命中不了 |

于是 PC 上「刚好放得下」、手机上「溢出 187px 只能滚」。附带：`scroll-x` 的 iOS 回弹
（`bounces` 默认 true）让内容放得下时也还能拽一下，观感上同样是「还能滑动」。

**改法（一份真相：fitCanvas → handMetrics）**

1. `handMetrics(rowW, canvasW)`（game.js）算出四个量：**条宽 `handTrayW` = max(画布宽, 679) 再被行宽截断**；
   牌宽 `handTileW` = min(46, (条宽 − 间隙 − 摸牌位差) / 14)，下限 30px；牌高 / 三个字号 / 透视距离全部按同一个 k 同比缩放。
2. 值经 **CSS 变量**写到 `.tray-row`（`--tw` / `--th` / `--ml-drawn` / `--fs-rank` / `--fs-suit` / `--fs-honor` / `--persp`），
   wxss 里 `.tile-btn{width:var(--tw,46px)}` 消费；默认值 = 上限值，首帧未量到布局时也一样。
3. `.tile-btn` 改 `box-sizing:border-box` —— `--tw` 必须是**真实外宽**，否则 46 的 width 外加 1px 边框，
   14 张恰差 28px 排不进条宽（Chromium 实测抓到）。
4. `scroll-x` 保留作极端窄窗（iPad 分屏 341px，连 30px 下限也放不下）的兜底，但加 `bounces="{{false}}"`
   关掉 iOS 回弹；`@media (max-width:700px)` 里那份 39×55 的缩小档**删除**（第二个真相，正是事故源）。

**验证（`node .recover-tmp/handfit.cjs`）**：从 game.js 源码里**抠出** `handMetrics` 与常量（不是抄副本，
改了真实代码这里自动跟上），用真实 wxss + 等价 DOM 在四种视口实测：

| 视口 | 画布 | 改前 | 改后条宽 | 牌位 | 内容宽 vs 客户宽 |
|---|---|---|---|---|---|
| PC 1290×624 | 918 | 放得下 | 918 | 46 | 679 ≤ 918 ✔ |
| iPhone 横屏 844×390 | 520 | 溢 187 | **679** | 45 | 665 ≤ 679 ✔ |
| SE 横屏 667×375 | 490 | 溢 217 | **624** | 41 | 608 ≤ 624 ✔ |
| iPad 分屏 341×390 | 319 | 溢 388 | 319 | 30（下限） | 452 > 319 → 滚动兜底（设计内） |

**过程中被抓到的两个真缺陷**（都不是猜的）：

- **注释里的「星斜杠」把 CSS 注释提前闭合**：手牌注释写了变量连写形式（形如 `--tw/--th/--ml-drawn/--fs-*/`），
  其中的 `*/` 结束注释，剩下的注释文字被当成选择器 → **整条 `.tile-btn{width/height/flex-shrink/…}` 被 CSS
  错误恢复丢弃**。症状极具误导性：位图模式下量到牌位 65×82（14 张图被 flex 等比挤扁的假象）、
  矢量模式下 27×28（退回文字宽），同一次渲染两种尺寸。抓法：`/*` 与 `*/` 计数 + 逐规则校验选择器。
- **`content-box` 让 `--tw` 不等于真实外宽**：14 张恰差 28px，边界视口恰好排不进。

**遗留**：真机横屏仍需预览确认（尤其是 4 组副露 + 14 张手牌同时在场时的总高度）。

### 10.9.12 顶栏精简 + 画布独占整行 + 侧边按钮轨（2026-10-21，用户报「牌面区域小、功能都挤在顶部 + 手牌要正的」）

**用户原话**：「首先手牌的视图应该是正的，现在手牌上的牌是上小下大的；第二放大中心牌面区域显示，
将左右两次的记录和聊天放到侧边按钮进行弹窗触发，将顶部的空间也尽量空出来用来显示牌桌，
部分功能也可以进行迁移到侧边进行使用」

**三条需求 → 三个根因**

| 需求 | 现状 | 根因 |
|---|---|---|
| 手牌上小下大 | `.tile-btn{transform:perspective(240px) rotateX(16deg)}` | 2026-10-18 刻意做的 3D 后仰梯形，现在要正的 → 整条 transform 删除 |
| 牌面区域小 | 画布宽 = 行宽 − 侧栏（PC 宽窗被吃掉 ~400px） | 记录/聊天是**流内三栏**，侧栏占流宽 |
| 功能挤在顶部 | 原生导航栏 44px + HUD 一行（信息 + 4 枚钮） | 顶部两行 chrome 吃掉 ~74px 高度 |

**改法**

1. **自定义导航栏**（`game.json` 的 `navigationStyle:"custom"`，配 `disableScroll`）：原生 44px
   导航栏没了，页面铺满全屏；自绘 28px 极简信息条（`‹` 返回 + 玩法·房间·牌墙·精，右侧
   留 118px 避让系统胶囊）。牌桌高度净赚 ~44px。
2. **画布独占 `.game-main`**：记录/聊天从流内三栏改成**侧边按钮 + 弹层面板**——
   左轨一枚 📋（操作记录），右轨 💬（聊天，带未读红点）/ 🤖（托管）/ 🎯（互动）/ ✕（解散）。
   轨道是 absolute 浮层，**不占流宽**；`fitCanvas` 只在宽度方向扣 `RAIL_RESERVE = 84`，
   即画布宽 = `min(行宽 − 84, 行高×2)`。
3. **HUD 整行删除**，信息并入顶栏（jingText 单行省略号）。
4. **弹层面板是 `.game-main` 的子元素**（absolute inset:0）：正好盖住牌桌区、**不遮底部
   手牌条**（看记录/聊天时牌局还在走，手牌必须能出）。面板打开只翻 `panelOpen`（把原生
   canvas 切 `display:none`，合成层级在 DOM 之上，不藏面板会被牌桌盖住），**不翻
   `modalOpen`**——后者会连带藏掉 `board-overlay`（手牌条）。
5. **顶部安全区**：`computeSafeInsets` 增加第三个探测元素 `#safe-probe-t`（量的是
   **高度** `env(safe-area-inset-top)`）+ `wx.getWindowInfo().safeArea.top` 兜底，
   写进 `--safe-t`，`.game` 的 padding-top 消费。
6. 手牌去掉 3D 后仰（`transform:none`，只剩阴影层次），`handPersp` / `--persp` 一并废除。

**⚠️ 铁律：侧轨绝不能压到画布矩形。** 原生 canvas 合成层级高于**所有** DOM（2026-10-17
实测连 cover-view 都盖不住 canvas），压在画布上的按钮会被 canvas 盖住、点不到。
所以 `RAIL_RESERVE` 必须 ≥ `(RAIL_W+2)×2 = 76`，保证画布两侧各留 ≥42px 空白给轨
（`pagelayout.cjs` 逐像素断言「轨矩形 ∩ 画布矩形 = 空」）。

**返回键 = 解散对局**：本项目页面跳转全是 `room.js` 的 `redirectTo`（跳转合并），没有可
`navigateBack` 的栈；且中途离桌服务端会把 `game` 广播回来、人又被拽回牌桌（room.js 的
自愈逻辑）。所以顶栏 `‹` 与右轨 `✕` 共用同一个 `abortAskShown` 确认框。

**验证（`node .recover-tmp/pagelayout.cjs`）**：真实 `app.wxss` + `game.wxss`（rpx 按
「窗宽/750」换算）+ 与 WXML 等价的 DOM，三种视口实测：

| 视口 | 画布实测 | 算式 | 左轨缝 | 右轨缝 | 手牌内容≤条宽 | 面板 | 顶栏高 | transform |
|---|---|---|---|---|---|---|---|---|
| iPhone 横屏 844×390 | 560×280 | 560 | 100px | 100px | 665≤679 ✔ | main 内·不遮手牌 ✔ | 24 | none |
| SE 横屏 667×375 | 530×265 | 530 | 26.5px | 26.5px | 636≤651 ✔ | 同上 ✔ | 24 | none |
| PC 1290×624 | 1028×514 | 1028 | 89px | 89px | 679≤1028 ✔ | 同上 ✔ | 24 | none |

`CANVAS_IMG=…` 可把真实牌桌渲染图贴进 `#table` 出「最终效果」截图；
`PANEL=chat|log` 验面板约束。另外 `handfit.cjs`（14 张排满）、`geomcheck.cjs`
（牌桌几何回归）、`typecheck` 全部通过。

**遗留**：`estimateWrap` 的兜底 chrome 估值已按新结构重算（顶栏 24/28 + 操作区），
但真机横屏仍建议预览一次；多轮改动尚未提交 git。

### 10.9.13 手牌「局中对齐」：space-between 摊大饼 → 局中居中且紧凑（2026-10-21，用户报「手牌应该局中对齐」）

**用户原话**：「手牌应该局中对齐，请修改布局」（附真机截图：底部 7 张牌被大间隙摊满整条）

**根因**：§10.9.2 的「出血对齐」`justify-content: space-between` 遇上 §10.9.11 的新条宽
口径就翻了车——条宽是按 **14 张满编**预算的（`handTrayW = max(画布宽, 14×48+7=679)`），
而有副露时手上只剩 7~10 张，space-between 把条宽空余**全摊到牌缝里**：真机实测 7 张牌
（13 手牌 − 两组副露 6 张的合法状态，`syncHandTray` 无人造数量上限）跨 1016 图素、
6 道缝每道 ~57 CSS px，牌群被拉得七零八落。连 PC 满编 14 张都被摊出 28.9px 的缝
（679 内容 vs 1028 条宽）——「摊大饼」与张数无关，只与「条宽 > 内容宽」有关。

**改法（`.tray-row`，双保险居中）**：

| 机制 | 作用 | 兜底 |
|---|---|---|
| `width: max-content` + `margin: 0 auto` | 行收缩到内容宽，auto 外边距把牌群稳在条中心 | 内容超宽（iPad 分屏真要横滑）时过约束 → 外边距归 0，行从左端起排，滚动行为不变**（若用 flex `center` 居中溢出，会左右都溢出、左边永远滚不到）** |
| `justify-content: center` | 万一某台老 webview 不认 `max-content`，行仍是整条宽，靠 flex 居中同样聚拢 | 绝不回到「摊大饼」 |

牌群在条内居中 → 条本身由 `board-overlay` 的 `margin:0 auto` 与画布同一根中心轴
（`.canvas-wrap` flex:1 居中画布，两轨 absolute 对称 42px，轴天然重合）。

**验证（`node .recover-tmp/pagelayout.cjs`，本轮新增用例与断言）**：

- 新增 `iphone_7tiles(7张)` 视口用例（真机场景复现）+ 三条断言：① 牌群中心 == 条中心
  （±1px）② 牌群中心 == 画布中心（±1px，「局中对齐」本体）③ 除摸牌位那道缝
  （放宽到 `--ml-drawn`）外其余牌缝 ≤3px（左右各 1px 外边距 + 舍入）。
- 修复版 4 视口全过：非摸牌缝一律 2.0px、7 张场内容宽 336≤679、局中 ✔；
- `LEGACY=space-between`（自动补 `width:100%` 复现当年完整组合）4 项全挂：
  7 张场最大缝 59.2px（与真机实测 ~57px 互相印证）、PC 满编 28.9px；
- `CANVAS_IMG=<真实牌桌图>` 可出修复前后对照截图（`.recover-tmp/shots/layout_iphone_7tiles*.png`）。

**教训**：`space-between` 只该用在「内容天然铺满」的场合；容器宽按**最坏情况满编**预算时，
空余是常态，摊大饼是必然。凡「条宽 = f(满编)」的地方一律用居中对齐。

### 10.9.14 结算相位「左右两家副露与弃牌重叠」：副露列内移 + 底边四行重排（2026-10-21，用户报「左右两边的玩家牌位置显示异常出现了重叠」）

**用户原话**：「左右两边的玩家牌位置显示异常出现了重叠请进行修复」（附真机结算截图：
南·机器人1 胡牌 自摸(平胡)，牌墙 23；左右两家摊牌区可见副露与弃牌角部相咬）。

**根因**：§10.9.10 把结算相位（over）侧边牌河改成**内侧两列**（左 162..290、右 990..1118）
后，副露列坐标没跟着挪——副露列是为**对局中**牌河四列（左 16..276、右 1004..1264）调的：
左列 282..338 咬结算牌河内侧列 8px、右列 944..1000 咬 10px，且每张牌都咬（投影后
角重叠 ~10×21px），真机截图左右两侧都能看到副露与弃牌斜插在一起。

**改法（`utils/table.js`，三处联动 + geomcheck 新增两条断言）**：

| 位置 | 改前 | 改后 | 理由 |
|---|---|---|---|
| 侧边副露列起点 `colX()` | 左 282→348 / 右 1000→934 | 左 300→366 / 右 980→914 | 与结算牌河内两列各让 10px；对局中牌河四列让 24px |
| 侧列底限 `MELD_SIDE_BOTTOM` | 548（单值） | 分相位：对局 498 / 结算 544 | 对局中底边牌河 y504 起、结算中摊牌行 y550 起，原 548 两个相位都压 |
| 底边摊牌行 | y506..556 | y550..600 | 给侧列结算底线 544 让位 |
| 结算底边牌河 | 两行 y578..638（52 张） | 单行 y606..634（25 张） | 摊牌行下移后底部只容一行；单家弃牌 ~20 张 ≤ 25 |
| 底边副露横排 | 右对齐 950 | **居中 640** + 结算 4 组折两行（430/486） | 右对齐时 ≥2 组右端 698..950 探进右侧副露列 y430..482 段；4 组（516px）宽于两侧副露列间 436px 窗口，结算相位才放得下两行 |

对局中底带被信息盘（y422）与牌河（y504）夹成 70px，放不下两行 112px → 底边 4 组
在对局中**不折行**，改为按左右邻居副露列占位**动态让位**（邻居 ≥2 组挡其 col0、
=4 组再挡其 col1，横排行 y430..482 与它们同带）。三方都满副露（窗口 416<516）时
夹紧后仍相擦——需底边+左右都 4 组，实战不可达，代码注释已声明。

**容量递推（为什么两列两相位底限就够）**：单家 ≤4 组（14 张 = 4×3 + 将）；4 组必为
3 张组（136×2+10=282 ≤ 列容 328/282），两列各 2 组到底限之上；3 组含双杠（182×2+10+136=328）
在结算列容（328）内恰好排下。唯一放不下的是「三暗杠」（3×182），需 12 张指定牌，
实战不可达——副露列写满后 `break` 少画一组，不压穿底边。

**验证（`node .recover-tmp/geomcheck.cjs`，本轮新增）**：

- 新增两条跨类断言：`副露×结算牌河`（本轮 bug 本体）、`副露×副露(跨槽)`；
  修复前满额牌局（左右各 4 组、底边 4 组）**52 对相擦**（副露×结算牌河 33 +
  摊牌×副露 5 + 出界 4 + 转向出界 10…），修复后 4 视图全绿；
- 类别名带槽位（`meld#s1`/`reveal#s3`）并按前缀聚合，跨槽相擦才定位到具体牌；
- `over_win` 视图的副露加到接近真机的满额（左右 4 组、底边 4 组、牌河压 cap 18）；
- `nanchang_playing`/`gz_playing` 同步加压（对局中侧列两列排满 + 底边 3 组动态让位）；
- typecheck ✔、`NODE_OPTIONS= npm run build` ✔。

**教训**：坐标改动（牌河内移）与**共用同一块地的其它画家**（副露列）必须成对验证；
`geomcheck` 原有 pairs 缺 `副露×结算牌河` 这条，所以相擦活到了真机。凡相位 A 改了
某区的占位，就要问「相位 B 谁还画在这」。

### 10.9.15 换美术：牌面/牌背/操作钮/结算艺术字/庄标/大数字整体切到 CDN 贴图（2026-10-21）

**诉求**：「请下载使用 liumengniu/majiang 项目中的 ui 和麻将贴图」。

**合规**：该仓库 MIT License（Copyright (c) 2023 liumengniu）→ 可自由使用/修改/商用，
保留版权声明即可（声明落在 `packages/client/src/assets/ui/README.md`；其牌面源图与
补绘说明随 `tiles/` 目录注释一并维护）。未照搬其 `ui/table.png`（绿色平纹桌、中心烙
「湖南麻将」字样，且与 10.9.12 前用户选定的藏青+暖金透视桌面冲突）与大厅/登录素材
（本项目无对应页面）。

**关键限制**：源项目是 108 张无风牌变体，**只有 27 张序数牌（万/条/筒各 1-9）、
没有字牌**；本项目 34 种牌制（含东南西北中发白）缺的 7 张按同风格补绘：

- 模板 = 源图 `myCard/w1.png` **擦墨**（逐行取左右内缘中位数当背景色、把墨字像素填回），
  金顶条/灰稜/米白渐变面/圆角原样保留；
- 字形用**传统字形**（東南西北中發白）与源图「萬」一致，字体 KaiTi/STKaiti 优先；
- 墨色从源图精确取样（红 ← w1 的「萬」、绿 ← t5 的条、白取经典牌蓝）；
- 补绘时模板是 65×99 → 279×405 非等比放大（横 4.29 × 纵 4.09），**字形同步横拉**
  （`ctx.scale(SX/SY, 1)`），否则字比牌框窄一圈。

**链路（全部不进代码包，守住「主包 < 1.5MB、图+音 ≤ 200KB」红线）**：

| 通道 | 源图 | 生成 | 服务端 | 小程序 |
|---|---|---|---|---|
| 牌面 34 张 | `packages/client/src/assets/tiles/t00-t33.png`（279×405，27 张取自源仓库 + 7 张补绘） | `npm run build:cdn-tiles`（139×202 WebP，合计 165KB） | `GET /api/tiles`，`TILES_VER` **v1→v2** | `utils/tileimg.js`（既有，客户端零改动） |
| UI 19 项 | `packages/client/src/assets/ui/*.png`（back/peng/gang/hu/guo/win/lost/draw/banker/d0-d9） | `npm run gen:ui-cdn`（2x WebP，合计 207KB） | `GET /api/ui` + `/ui/<key>.webp`，`UI_VER` v1 | `utils/uiart.js`（新，镜像 tileimg.js：清单缓存 7 天 + 后台校验版本 + 失败静默回退） |

**接线点（一律「有图用图、无图回退矢量/文字」，与牌面同哲学）**：

| 位图 | 消费者 | 回退 |
|---|---|---|
| back 牌背 | `table.js` `paintTile`/`rotFace`（t<0 分支） | `paintTileBack` 矢量绿背 |
| banker 庄标 | `drawTag` 庄家位（24×24 红印章） | 金底「庄」字 pill |
| d0-d9 大数字 | `drawCenter` 左栏牌墙剩余数（72 逻辑高、逐位图定宽） | `fillText` 72px |
| peng/gang/hu/guo | `game.js renderControls` 给 control 挂 `art`+`cap` → `game.wxml` `.ctrl.art`（图 + 压图下缘的小注 pill） | 纯文字钮 |
| win/lost/draw | `onSettle` 按 `view.winner`（null→draw / 我→win / 他家→lost）算 `settleArtKey` → 结算面板 `.settle-art` | 只显示标题文字 |

**踩坑记录**：

1. **注释里的 `*.webp` 会吞脚本**：doc 注释写 `public/ui/*.webp`，其中的 `/*` 被当作
   块注释起始、把整段注释提前闭合 → 后面代码全部解析失败。注释里写路径通篇用
   `<key>.webp` 或加空格。
2. **DOM 小注负边距**：`.ctrl-cap` 用 `margin-top:-12rpx` 压回图下缘，保证 art 钮
   总高 ≈ 图高 ≤ claim-mask（与手牌条同高）—— 顶部一旦溢出会被原生 canvas 合成层
   挡住（cover-view 都盖不住 canvas，见 §10.9.5）。已按 320/375/844 三档 rpx→px
   换算验证单排不穿帮（`.recover-tmp/claim_mock.png`）。
3. **app.wxss 全局 `button{}` 四条 !important**（inline-block/width/min-height/margin）
   会压掉 art 变体的布局 → `.ctrl.art` 的 `display:block !important` 与
   `margin:…!important` 是刻意为之，别删。
4. **矢量 harness 全部要补 `./uiart.js` stub**：`shots.cjs`/`geomcheck.cjs`/`handfit.cjs`
   /`pagelayout.cjs` 都经 require 加载 table.js，新 require 一加进去，没 stub 的
   直接 `new Function(undefined)` 挂掉。`shots_art.cjs`（新）则把 tileimg/uiart 换成
   **真实 WebP 位图**，四个相位实渲染验收。

**验证**：`geomcheck`（四视图双快照 + 降级路径）✔ · `handfit` ✔ · `pagelayout` ✔ ·
`shots_art.cjs`（真实贴图四相位，34/34 + 19/19 解码，无 pageerror）✔ · typecheck ✔ ·
`NODE_OPTIONS= npm run build` ✔ · 服务端冒烟（`/api/tiles` v2、`/api/ui` v1 19 键、
静态 200、`..%2f` 穿越 404）✔ · **帧耗时反降**（位图替代矢量绘字：nanchang 15.7→8.9ms、
over 25.8→17.4ms）。

### 10.9.16 桌面换绿绒桌 + 牌河/副露换「按座位平放牌」（2026-10-21 第二轮，用户「两个都需要」）

上一轮只换了牌面，用户接着问「牌桌上的牌为啥没直接用 ui 贴图替换」——追下去发现两个都漏了：
① 桌面背景还是自绘的藏青桌；② **源项目的牌面是两套美术**：`myCard`（带金顶条的**立牌**）
只用于自己手牌，桌面弃牌/副露用的是 `first/second/third/fourth` 四套**白瓷平放牌**
（`Main.ts:345` 按 viewPos 选目录）。本轮补上这两块。

**A. 桌面背景（table）**

- 源 `ui/table.png` 1280×720：绿绒 + 龙纹圆章 + 木框 + 顶部两角竹叶，**中心烙「湖南麻将」四字**。
- 后处理（一次性）：整图压到画布比例 **1280×640**（保四边框；不裁切 → 上下框都留）；
  文字区 `(452,133)-(756,201)` 逐行取框外左右参照色**线性插值 + ±2 噪声**填掉
  （绒面是平滑渐变，肉眼无痕；对比度拉爆的校验图上才看得出极淡的一小块）。原文字 bbox
  用「宽核滑动平均基线 + 偏差阈值」程序化定位，肉眼估了三次都不准。
- `table.js drawTable()`：`uiart.art('table')` 有图就 `drawImage(bg,0,0,W,H)` 直接 return，
  没有才走藏青+暖金矢量桌（梯形几何一行不动）。
- **1x 而非 2x**：源图本身就是 1280×720，2x 只是插值放大，但解码内存 3.3MB→13MB；
  绒面/龙纹是低频画面，GPU 放大肉眼无差。
- 四角铭牌在绿绒暗角上依然可读（源图四角本身就是深色渐变），**不需要加暗底衬**。

**B. 按座位平放牌（faceA..faceD）**

| 屏幕槽位 | 座位 | 图集 | 源目录 / 单元尺寸 | 牌河格 | 副露/结算格 |
|---|---|---|---|---|---|
| 0 下 | 自己 | `faceA` | `first` 46×64 | 50×62 竖格，**不转** | 40×52 竖格，不转 |
| 1 右 | 下家 | `faceB` | `second` 59×48 | 50×62 竖格，**转 −90°** | 56×44 横格，**不转** |
| 2 上 | 对家 | `faceC` | `third` 42×60 | 50×62 竖格，**转 180°** | 40×52 竖格，转 180° |
| 3 左 | 上家 | `faceD` | `fourth` 59×48 | 50×62 竖格，**转 +90°** | 56×44 横格，**不转** |

- **侧边「牌河转、副露/结算不转」是本轮的关键判断**：牌河格是竖版 50×62，横版美术转 90°
  后内框正好 62×50（1.23 vs 1.24），几乎零裁剪；而副露（56×44）、结算缩排河与摊牌
  （62×50）本身就是**横向格**，再转 90° 内框会变 44×56 竖版，横版图被裁掉 36% 宽度
  （实测过）。所以新增 `flatRotForSlot(slot)`：侧边回 0，底/顶仍 0/180°。
  代价是侧边的副露/摊牌字形是「正对观众」而非「朝该玩家」—— 这与源项目自身的呈现一致
  （他们的平放牌美术一律正对观众）。牌河仍保持「弃牌朝他自己」（2026-10-20 用户要求）。
- **字牌**：四套源图都只有 27 张序数牌。每个变体取 `bb1`（一筒）**逐行中位数擦墨**得净模板
  （白面 #f3f3f3 / 灰檐 / 绿底 #1e8b26 / 透视边全保留），再以同墨色（绿 #12802c、红 #a81818、
  白蓝 #1a3f7a）绘 東南西北中發白，字号 0.47×H、中心 0.36×H（避开绿底）。
- **打包成图集**：每套 9 列 × 4 行 = 34 格 → 4 张 PNG → WebP（1x，合计 128KB）。
  取用走 `uiart.face(key, t)` 返回 `{img,sx,sy,sw,sh}` 子矩形，由 `drawTileSlices` /
  `rotFace` / `drawArtInto` 直接 `drawImage` 子区域 —— **不预裁 136 张小图**（否则解码内存数 MB）。
- **1x 理由**：源图 42×48~59×64，显示尺寸就是 50×62 逻辑，2x 只会让 136 格解码内存 ×4。
- `FACE_CELL` 表在 `utils/uiart.js`，与 `scripts/gen_face_atlas.mjs` 的 `VARIANTS` 必须一致
  （脚本末尾会打印该表，改源图尺寸时直接抄）。

**C. 降级路径也画位图**：`Table._canvasOff`（离屏不可用）以前只画矢量牌，现在该分支
先 `clip + drawArtInto` 画位图（这一步本来就不需要离屏），只有拿不到位图才回退矢量。
`DEGRADE=1 node .recover-tmp/shots_art.cjs` 可出对照图。

**验证**：`geomcheck` 四视图 + 降级路径全绿（几何一行未动，只改取图与桌面背景）·
`handfit`/`pagelayout` ✔ · `typecheck` ✔ · `build` ✔ · `shots_art` 四相位（34/34 牌面 +
24/24 UI 解码，含 `DEGRADE=1` 降级图）✔ · 四槽位单张朝向实验（`rot_check`：绿边分别朝
下/右/上/左）✔。

### 10.9.17 「连点加机器人误触离开房间」：按钮消失 = 跳位（2026-10-21，用户报「点的快很容易误点」）

**根因不是按钮挨得近，而是按钮会消失**：房间里「加机器人」的条件是
`isHost && players.length < 4`，加上第 4 个人（bot）后整个按钮**从行里摘掉**，
右侧「离开房间」立刻**左移一个身位（≈按钮宽 + 12rpx 间距）**，正好落到连点的手指下面
—— 第二次点击就退房了。同理「准备 / 取消准备」文案变长也会把右侧按钮推走。

**四条改动**（`pages/lobby`）：

| 改动 | 作用 |
|---|---|
| 「加机器人」房主**恒在**，满员 `disabled` + 文案换 **等长的**「已满4人」（4 字 ↔ 4 字，宽度不变） | 位置钉死，连点落在禁用钮上 = 无操作 |
| 「离开房间」用 `.act-spacer{flex:1 1 24rpx;min-width:24rpx}` 推到行尾 | 与左侧动作至少留 24rpx 硬间隙，行宽富裕时继续拉开；退出类动作不再贴着高频钮 |
| 「离开房间」加**页内 layer 二次确认**（`leaveAskShown`，同「解散牌桌」那套；`wx.showModal` 在本环境不可靠） | 手滑最多弹框，不会直接退房丢座位 |
| `onAddBot` 加 **400ms 连点节流** | 加机器人是一来一回的异步动作，连发会让服务端一次加多人 / 回包错序 |

**为什么不靠 margin 推右**：`app.wxss` 的全局 `button{margin:0 !important}` 会吃掉外边距
（同 `.ctrl.art` 那次的坑），所以用**弹性占位 view** 而不是 `margin-left:auto`。

**教训（可复用）**：**任何按状态出现/消失的按钮，都要问一句「它消失后，谁挪到了手指下」**。
两条硬规矩：① 高频按钮的位置不能随状态跳；② 破坏性动作（退房/解散）与高频动作之间
要么有硬间隙、要么有二次确认，最好两者都有。

### 10.9.18 桌面铺满整屏 + 手牌坐上桌面（2026-10-22，用户「牌桌和手牌按图片所示调整对齐」）

**用户给的参考图是源项目 liumengniu/majiang 的对局画面**，最刺眼的两条差异：

| 参考图 | 改前 |
|---|---|
| 绿绒龙纹桌**铺满整屏**，木框在屏幕四边 | 桌面是 canvas 里的一张贴图；画布 2:1 又被行高卡成手机横屏宽度的 **65%**，左右两条深色空白里飘着按钮轨 |
| 手牌**坐在桌面上**（桌面一路延伸到屏幕底边） | 手牌条挂在画布外、页面黑背景上，中间还隔着一条「请出牌」 |

**为什么不能直接把 canvas 拉满整屏**：`<canvas type="2d">` 是原生组件，
会压住其矩形内的**所有 DOM**（手牌条、按钮轨都会看不见点不着，cover-view 实测也盖不住，
见 §10.8⑦）。所以 canvas 只能占中间那块，桌面只能「拼」出来。

**做法：桌面由两层同源图拼成，映射完全一致 → 接缝不可见**

1. `.felt`（新，`game.wxml` 第一个子节点）= `position:absolute; inset:0`，
   `background-size:**100% 100%**`，图片 URL 由 `uiart.urlOf('table')` 写进 inline style
   （代码包仍零图片）。`pointer-events:none`，`z-index:0`；
   `.g-top / .banner / .game-main / .board-overlay` 统一 `position:relative; z-index:1`。
2. canvas 不再「铺满自己」，而是按 **`Table.frame`** 铺：`frame` = **整个页面矩形在画布
   逻辑坐标里的位置**（`x`/`y` 常为负、宽高常大于 1280×640），由 `game.js` 的
   `applyTableFrame()` 在每次量到画布 rect 后算出：
   `s = canvasW/1280` → `frame = {(page.left-canvas.left)/s, (page.top-canvas.top)/s, pageW/s, pageH/s}`，
   其中 **page 矩形实测 `.game` 节点**（`measureCanvasBox` 多查一路），量不到才退回
   `wx.getWindowInfo()`。**不能直接用 windowHeight**：部分安卓机型它与 `100vh` 不等
   （状态栏算不算在内各家不同），差 1px 画布边界就会现一条缝。
   `drawTable()` 用 `ctx.drawImage(bg, frame.x, frame.y, frame.w, frame.h)`，
   超出画布的部分由画布自己裁掉。**`frame` 为 null 时退回旧行为（铺满画布）**，
   截图/几何校验 harness 走的就是这条，不必跟着改。

**为什么是 `100% 100%` 而不是 `cover`**：cover 会按比例裁边 —— 2:1 的桌面图铺到
2.16:1 的手机横屏要上下各裁 ~16px，**木框的上下两条边直接消失**，只剩左右两条竖框，
像「断框」。整铺只有 8% 的横向拉伸，绒布是纹理、看不出来。
两层必须用同一个映射，**改动任何一层都要同步另一层**，否则画布边界会现出一条缝。

**顺带修掉的三处**：

- 画布 `border-radius` 去掉 —— 桌面既然铺满整屏，给画布倒角等于在桌上抠一个圆角矩形，
  四角还会露出 DOM 底色与 canvas 的色差。
- `measureCanvasBox()` 兜底分支原来按 `(wrap.height - canvasH)/2` 居中推算，
  而 CSS 是 `align-items:flex-end`（画布贴操作区底边）—— 量不到真 rect 时 `canvasBox`
  会偏上半个差值，点击换算跟着错。改成贴底。
- `.felt` 兜底色定 `#14614a`（采样 `table.webp` 绒布 #116347~#186f4f）：
  万一真机上 CSS 背景图没加载（webview 与 request 域名是两条通道），画布外仍是绿绒
  而不是黑洞；`uiart.ensure` 失败时改回矢量桌的藏青 `#0d1626`，两套桌面不混拼。

**没做（本期选项是「几何不动」）**：牌河/铭牌/中心盘的坐标一行没改，所以
**牌张自身的像素尺寸不变** —— 手机横屏 844×390 上画布仍是 548×274（占宽 65%/占高 70%）。
想再大只能重排 1280×640 里的几何（缩牌河、缩中心盘、四家手牌整排背面显示，即选项二）。

**验证**（`.recover-tmp`）：

```bash
# 画布按整屏 desk 矩形渲染（iPhone 横屏 844×390 的等价参数）
FRAME='{"x":-345.7,"y":-65.4,"w":1971.4,"h":911.0}' node .recover-tmp/shots_art.cjs
# 整页合成：DOM 的 .felt + 画布 + 真实牌面贴图
TILE_IMGS=1 CANVAS_IMG=.recover-tmp/shots_art/gz_playing.png node .recover-tmp/pagelayout.cjs
# 竖向预算（顶栏/画布/状态行/手牌条是否被视口裁）
node .recover-tmp/probe_v.mjs .recover-tmp/mock_iphone_land.html 844 390
```

> ⚠️ `pagelayout.cjs` 的 mock 用 `<div>` 冒充 `<view>`，**必须补 `div{box-sizing:border-box}`**，
> 否则按 content-box 算、页面凭空高出左右 padding 之和，手牌条底边被视口裁掉 2~6px ——
> 这是 mock 假象，不是真机 bug（2026-10-22 排查了半天）。

### 10.9.19 「改了素材，真机还是老样子」：清单缓存同版本不覆盖（2026-10-22）

**症状**：代码/素材都改了、服务端接口也返回了新清单，真机（或开发者工具）上桌面还是老样子 ——
整屏桌面层没图、画布退回藏青矢量桌、牌河退回立牌。看起来像「改动没生效」。

**根因（`utils/tileimg.js` + `utils/uiart.js` 同款）**，两个叠在一起：

1. **同版本号 = 永远吃缓存**。原逻辑：
   ```js
   if (!cached || cached.version !== next.version) { state = next; writeCache(next); }
   ```
   版本号没变就把网络清单丢掉。而 UI 清单从 **19 项扩到 24 项**（加 `table` + `faceA..D`）
   时**没有抬 `MAHJONG_UI_VER`**，于是老客户端一直用缓存里那份 19 项清单：
   `urlOf('table')` 恒为空 → 整屏桌面没图、canvas 也没有 `art('table')` → 两层桌面全丢。
   版本号只是**缓存失效开关**，不兼职判断「清单是否可信」。
2. **缓存那一手把监听冲掉了**。`flush()` 是「回调 + 清空监听」，缓存先 flush 一次之后，
   网络清单回来时已经没人被通知 —— 即使 `state` 更新了，`loadUiArt` 的回调也不会再跑，
   `feltUrl` / `preload` 都不会被设置。

**改法**（两个 utils 同步）：

| 改动 | 说明 |
|---|---|
| 网络清单**无条件**采用 | `state = next; writeCache(next)`，版本变化时额外 `images.clear()`（丢旧位图） |
| 拆出 `emit()` / `flush()` | `emit` 回调但保留监听（缓存这一手），`flush` 回调并清空（终态） |
| 用 `inflight` / `netSettled` 代替 `status` 判在途 | `status` 只表示「现在有没有可用清单」；有缓存时它立刻 ready，但网络请求可能还在路上，此时新注册的监听必须留着 |
| `loadUiArt` 的回调做成幂等 | 可能被调用两次（缓存一次、网络一次），`feltUrl` 相同就不 `setData` |
| 抬 `MAHJONG_UI_VER` → **v2** | 已经中招的客户端立刻失效（版本号仍是缓存失效开关，换素材就抬一位） |

**顺带**：整屏桌面层从 WXSS 的 `background-image` 改成 `<image mode="scaleToFill">`
（`.felt` + `.felt.na` 兜底色）。理由：走的是**和手牌牌面完全同一条链路**
（downloadFile 合法域名 + 微信侧缓存），牌面能显示它就能显示，排查时少一个变量；
`scaleToFill` 就是非等比拉满，与 canvas 侧 `drawImage` 的整铺映射一致。

**验证**：`/api/ui` → `version=v2`、24 项、含 table/faceA..D；`/api/tiles` → v2、34 张；
`/ui/table.webp` 200（90KB）；`typecheck` + `pagelayout` 四视口全绿。

> 排查入口：控制台 `require('../../utils/uiart.js').debug()` → `{status, host, version, count, decoded}`。
> `count` 是清单项数（应为 24）、`decoded` 是已解码位图数。

### 10.9.20 牌河改成「各家面前一小块」+ 三家手牌上桌（2026-10-22，用户「像图中一样显示各个玩家的牌河」）

参考图（源项目对局画面）的结构：**四家手牌都看得见**（自己大立牌、对家一排牌背、
上下家一摞细条），**牌河是各家面前的一小块**（6~8 张一行、最多 3 行），中心只有一个
小金框数字。改前我们的牌河是四条**横贯全屏的长条**（上下 12 列 × 2 行、左右 4 列 × 6 行，
牌 50×62），看着像四堵牌墙，看不出「谁打的」。

**改动**

| 区域 | 改后（逻辑坐标 1280×640） |
|---|---|
| 牌河牌张 | **34×44**（原 50×62）；侧边旋转后 44×34 |
| 上/下（对家/自己） | 8 列 × 3 行，块 320×150，x **483..797**（正中让给中心盘）；上 y **66/116/166** 往下长、下 y **578/528/478** 往上长 |
| 左/右（上家/下家） | 3 列 × 8 行；左列 **428/378/328**、右列 **802/852/902**；y **163..470** |
| 容量 | 统一 24，溢出压最后一格（`riverPos` 的 cap） |
| 三家手牌 | 对家 = 一排 14 张牌背 38×52 步距 40（x 360..918, y 6）；上/下家 = 竖着一摞 26×36 步距 11（x 56 / 1200, y 248 起）→ 就是参考图那条细长牌摞 |
| 副露 0/2（自己/对家） | 牌河块**左右两侧**（左往左长下限 310、右往右长上限 970），y 524 / 112 |
| 副露 1/3（上下家） | 外侧**一条竖列**（左 236 / 右 984），y 56..500（一列 3 组，第 4 组少画不压穿） |
| 牌背 | 平面分支改吃 `uiart.art('back')`（金色那张）；改前无条件走矢量绿方块，三家手牌摊开后一眼看出不对 |

**踩到的两个坑（都得记住）**

1. **`projQuad` 的牌心透视会按 `d(y)` 把 x 往中线拉**（`cxs = 640 + (cx-640)*d`），
   所以「逻辑 x」≠「屏幕 x」：y=66 时 d≈0.75，写 236 的副露列会画到 ~337。
   一列牌上下 y 差 300、d 差 0.1 → 整列还会「往上撇」。
   解法：新增 `unprojTileX(x,y,w,h)` 反算，**竖排牌河、副露、报杠金框全部先反补偿**，
   于是 `riverOrigin` / 副露锚点的数字可以直接当屏幕坐标读。
   ⚠️ **结算相位不补偿**（`overPhase` 分支传原值）：它的摊牌行/缩排牌河还是旧坐标、自带投影，
   一补偿副露就整体外移压到旧摊牌列上（实测 22 处相交）。
2. **结算相位暂时留旧排布**（`drawMelds` 里 `overPhase` 分支）：摊牌行 `drawRevealHand`、
   缩排牌河 `drawRiversOver` 的坐标没跟着改，两套混用必然互咬。所以按相位分流：
   对局用新锚点、结算用旧锚点，`geomcheck` 的 8 个视图才都是 0 相交。
   **下一步要做的是把结算相位也搬到新几何上**（届时删掉这个分流）。

**素材**：用户补齐了 `ares/apes` 里四套方向牌 + myCard 的**全部 34 张（含字牌）**，
所以 `scripts/gen_tile_src.mjs` / `scripts/gen_face_atlas.mjs` 里的「擦墨模板补绘字牌」
整段删掉了，改成直接读 `z1..z7`；`third` 套的字牌是 46×64（其余 42×60），
改成「等比缩放进单元格并居中」。产物：牌面 v3、UI v3（atlas 格尺寸不变，`FACE_CELL` 不用动）。

**验证**：`geomcheck` 8 视图全部 0 相交（含降级路径）；`pagelayout` 四视口全绿；`typecheck` 通过。

### 10.9.21 四家牌面统一「竖版、字朝上」（2026-10-22 第二轮，用户「统一是竖直方向的不需要倾斜」）

**症状**：真机截图上左右两家（上家/下家）的牌是**横的**、字躺着，和对家/自己的竖版不一致。

**根因是双重旋转**：源项目四套牌**按座位视角画好**（first 竖版正立 / third 竖版倒立 /
second、fourth 横版侧卧），客户端又在 `rotForSlot()` 上转了一次（±90/180），两层叠加。

**改法**：把「摆正」这件事挪到**生成图集**这一步，客户端一律 rot=0。

| 环节 | 改动 |
|---|---|
| `scripts/gen_face_atlas.mjs` | VARIANTS 带旋转角：first 0° · second **-90°** · third **180°** · fourth **-90°**；格尺寸 = 旋转后尺寸 |
| `utils/uiart.js` | `FACE_CELL = { faceA:[46,64], faceB:**[48,59]**, faceC:[42,60], faceD:**[48,59]** }` |
| `utils/table.js` | `rotForSlot()` 恒 0（`flatRotForSlot` 随之恒 0）；侧边牌河改**竖格** 34×44（4 列 × 6 行，左 438 / 右 802，y 170）；侧边副露改**竖格** 40×52（pitch 58） |
| 服务端 | `MAHJONG_UI_VER` → **v4**（图集变了，客户端必须重下） |

⚠️ `shots_art.cjs` / `geomcheck.cjs` 里 stub 的 `FACE_CELL` 要同步，否则 harness 取到的是错位子矩形。

**验证**：`geomcheck` 8 视图 0 相交；四相位渲染里四条边的牌都是竖版、字朝上；`typecheck` 通过。

### 10.9.22 牌河紧贴中心盘四边、四家统一「从左往右」（2026-10-22 第三轮）

用户要求：**各个玩家的牌河紧贴中心指示器四边、从左往右排列**，并且四个座位各用自己那套贴图
（自己 first / 下家 second / 对家 third / 上家 fourth —— 与 `SEAT_FACE` 完全一致，本轮只是核对）。

**改法**（`riverOrigin`）：四条边统一成「方格阵 + **行优先、从左往右**」，
牌 34×44 竖版，一行的牌从左往右排满再换下一行（往远离中心盘的方向长）：

| 座位 | 块 | 位置 |
|---|---|---|
| 对家（上） | 8 列 × 3 行 | x 483..797，行 **166/116/66**（第 1 行贴盘，往上叠） |
| 自己（下） | 8 列 × 3 行 | x 483..797，行 430/480/530 |
| 上家（左） | 4 列 × 6 行 | x **312..466**（右缘贴盘左边），行 170..470 |
| 下家（右） | 4 列 × 6 行 | x **808..962**（左缘贴盘右边），行 170..470 |

左右两家**不再用竖排（column-major）**：那样一列读下来是「从上往下」，跟上下两家的「从左往右」
不一致。现在四块都按阅读顺序铺，且都紧贴中心盘（480..800 × 222..418）。

`riverPos` 的 x 反补偿从「只对竖排生效」改成**一律生效** —— 四块都不在 x=640 中线上时，
`projQuad` 的牌心透视会把整块往中间拉（y=170 时 d≈0.79，312 会被画到 ~380），
反补偿后 `riverOrigin` 的数字就是屏幕坐标，块边才能真的贴住盘边。

**验证**：`geomcheck` 8 视图 0 相交；渲染里四条边都是竖版、行内从左往右、块边贴盘。

### 10.9.23 每条边的牌「朝向坐那一侧的人」（2026-10-22 第四轮，含 10.9.21/22 的最终口径）

> ⚠️ **本节下面那句「必须转 ±90°」已被 §10.9.24 取代**（第五轮：用户贴 `bb1.png` 说「贴图明明
> 是这样的、界面显示的完全不一样」）。现口径：**美术自带朝向，代码 `rot` 恒 0**，本节表格只留作历史。
> 另：本节把「左右两家必须横格」的理由写成「否则字会变形」——真正的解是 §10.9.24 的
> **按图集格比例反推格子宽高**，横格本身只是那个比例的结果。

> **10.9.21 的「rot 一律 0」是过头了的**：那版把四家都转成「字朝我」，所以左右两家的牌虽然竖了，
> 却是躺给对面看的。10.9.23 起口径改为 **竖版/横版按座位 + 各自朝向**：

| 座位 | 格（逻辑） | rot | 效果 |
|---|---|---|---|
| 自己（下） | 34×44 竖 | 0 | 正立 |
| 下家（右） | **44×34 横** | **+90°** | 字的「上」指向屏幕右侧（他的人） |
| 对家（上） | 34×44 竖 | 180° | 倒立（他自己看是正的） |
| 上家（左） | **44×34 横** | **-90°** | 字的「上」指向屏幕左侧 |

**为什么左右两家必须是横格**：牌是桌上的实物，转过 90° 的牌，**外框也横过来**。
若强行给 90° 的牌套竖格外框，`rotFace` 的内框只能「装不下 → 把脸压扁」，字会变形。
所以「竖版/横版」不是审美选择，是跟着朝向走的。

**同时修正 `SLOT_ROT` 的符号**：原来是 `[0, -π/2, π, +π/2]` —— 左右两家的符号是反的
（下家的牌朝左、上家的牌朝右，正好背对坐着的人），这正是用户说「牌应该朝向自己」的根因。
现在是 `[0, +π/2, π, -π/2]`。`flatRotForSlot`（副露/摊牌）直接复用同一套。

**验证**：`geomcheck` 8 视图全部通过；渲染里用像素量紫框（精描边）确认——
左侧牌河 78×62、右侧 80×63 **横版**，顶部 62×78 **竖版**；对家那张 180° 的牌放大后字是倒的。

### 10.9.24 副露「又散又变形」的根治：格子按图集比例 + 牌距乘 d（2026-10-22 第五轮）

用户报「这边的三筒是什么牌为啥不仅间隔大而且还牌面变形了」。看着像两个 bug，实际是三个：

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 牌面被**横向压扁** | 副露格一律 `40×52` 竖格，四套图集的比例却各不相同（first 46×64、second/fourth 59×48、third 42×60）→ 横版美术塞竖格必压 | `meldMetrics(slot)` 改成「只定高度，按 `uiart.cell(SEAT_FACE[slot])` 的比例反推宽度」 |
| 2 | 牌与牌之间**大缝** | 牌距写成 `Math.max(边长+1, pitch·d(y))`。`pitch` 只比边长大 2，任何 `d<1` 时都被下限吃掉 → 步距恒等于边长+1，而牌身已被缩到 `边长·d`，屏幕缝 = `(1−d)·边长 ≈ 10px` | **去掉下限**，步距直接 `pitch·d` |
| 3 | 缝里像有一条**深色带** | 每张牌 20px 模糊投影压进 2px 的缝 | 牌行四个分区 `TILE_TILT.zones.*.shadow = 0`，`paintTile` 里 `if (tl.shadow)` 包住阴影 |

**为什么步距必须乘 `d`**：`projQuad` 的 `z.rect` 分支是「绕牌心等比缩 `d`」，**y 锚点不动**
——牌变小了、位置没变，所以屏幕缝 = `步距 − 边长·d`。`d` 在 0.72~1.0 之间，
不乘就是 4~10px 的缝，乘完回到 `2·d ≈ 1.6px`（贴紧、不叠压）。

**唯一的例外（写死在 `stepOf`）**：结算相位的横排副露**不做** `unprojTileX`（它的摊牌行还是旧坐标），
x 位置和宽度都已被 `d` 缩过一次，再乘 `d` 就是缩两次 → 相邻牌叠 1px，
`geomcheck` 的「副露×副露(跨槽) 16 对相交」就是它。规则收敛成一句：

```
步距 = pitch · d      // 竖排一律；横排且 x 已反补偿
步距 = pitch          // 横排且未反补偿（结算相位）
```

`meldSpan / meldSpanN`（组间距、一列能放几组）必须跟同一条规则，否则组与组之间会越算越歪。

**返回末端，不要返回总长**：`drawMeldRow / drawDeclared` 现在返回**末张牌的末端**
（`起点 + 末张起点 + 边长·比例`），调用方 `y = 返回值 + 5`。原来返回「未投影的总长」，
行尾永远比最后一张牌多出一截 `(1−d)·边长`。

**验证**：`node .recover-tmp/meldgap.cjs`（新写，Node 无浏览器）把每张副露的**屏幕矩形**打出来，
判据「相邻缝 1~2px、组间距 5」；`geomcheck` 8 视图全部通过 / 0 相交；
`gz_playing.png` 左侧四条杠放大后紧贴、不变形（`.recover-tmp/ref/meld_left9.png`）。

> 顺带记一个工具坑：`crop.cjs` 用 `locator.screenshot({clip})`，当视口小于图宽时浏览器会缩放整页，
> 裁出来的图看着「整张桌子缩进了一条缝」。改用 `.recover-tmp/pngcrop.cjs`（纯 Node 解码 +
> 整数放大 + 自己写 PNG，无浏览器）就没有这个问题。

### 10.9.25 牌河「叠压成一整条」（2026-10-22 第六 / 第七轮）

用户第一轮：「各家的牌显示都存在像阶梯一样的效果，想让下一张牌盖住上一张牌的一部分、
连成一个平面」。第二轮纠正两处：「对家的应该是**上一排遮住下一排**」+「四家的牌**对得
不是很整齐**」。

#### 一、行距压到牌高的 6 成

原状：行距 ≥ 牌高（上/下 46 vs 44、左/右 36 vs 34），每张完整露出 + 2px 缝 → 一格一格。
现在 `RIVER_LAP_FAR = 27`（上/下，h=44）、`RIVER_LAP_SIDE = 21`（左/右，h=34），
露出 61% / 62%，重叠 39% / 38%。

#### 二、谁压在谁上面：四家统一「屏幕上更靠下的那张在上层」

- 自己 / 左右：行往**屏幕下方**长（i 递增 = y 递增）→ 顺画，i 越大越晚画 = 越靠下 = 越在上层。
- 对家：行往**屏幕上方**长（`dy < 0`）→ **必须倒序画**（`order.reverse()`），
  贴中心盘那一排（先出、屏幕靠下）才压在外侧那排上。

第一版按「每人的下一张盖上一张」实现（对家没倒序），结果对家的层次与另外三家**相反**，
用户一眼看出来。现在四个座位在屏幕上观感一致：
**「贴盘那一排在最上面，外面几排依次被压住」**。

#### 三、一块牌河用**同一个投影比** `k`（这才是「对得不整齐」的修法）

逐张按 `d(y)` 缩时，同一列上下两张宽度差 1~3px → 整条带左右边缘呈锯齿。
改法：`riverK(seat)` 取「按容量铺满时块中心那一行」的 `d`，整块当**刚体**缩放：

| 配套 | 为什么 |
|---|---|
| `riverPos` 返回**未投影的网格**坐标（`x = o.x + col*dx`，`y = o.y + row*dy*k`） | 不再需要 `unprojTileX` 反补偿；行距也要乘 `k`，否则露出比例 = `dy/(h·k)`，对家 78% / 自己 61%，四边不等 |
| `projQuad` 的 `rect` 分支认 `z.k`（`resolveZone` 透传） | 位置和尺寸用同一个 `k`，牌才是刚体；`k` 缺省时仍回落到逐张 `d(y)` |
| `yAdj = ∓ h(1−k)/2` | rect 是绕牌心缩的，不补这一下整块会朝中心盘漂 ~4.6px（对家最明显），「贴盘」间距就变了 |
| 侧边 `o.x = 303 / 841`（不是 330/814） | x 绕屏幕中心 640 缩，直接给「贴盘的 330」会被拉进盘里 ~18px；把原点外推，让**缩放后的近边**回到 466 / 814（离盘 14px） |
| 侧边 `o.y = 241` | 8 行叠压后只剩 ~157px 高，块心要落在中心盘竖轴（算下来 319 ≈ 盘心 320） |

实测四块（1280×640 画布）：对家 `x 527..753 / y 132..210`、自己 `x 507..773 / y 430..521`、
左右 `x 354..466 / 808..926 / y 241..398`，与中心盘（480..800 × 222..418）间距
上 12 / 下 12 / 左右各 14，左右竖向居中。

#### 四、配套（漏一个就破相）

| 配套 | 为什么 |
|---|---|
| 精描边按「可见带」收口 | 被邻居盖住的牌，精框若照整张画，底边会埋进别人牌身 → 屏幕上只剩两条竖杠。`drawRivers` 算 `visH` → `resolveZone` 透传 → `jingBorder` 里 `h = min(h, visH)`，并且 `y += (h−visH)(1−k)/2` 补回「绕中心缩」引起的下移 |
| 末张金框同样收口 | `drawLastMarker` 在全部牌河之后画，对家的末张在最外排、会被压住 → 同样按 `visH` 收 `fh` |
| 副露**不叠** | 组合必须张张可辨，仍是 `pitch = 边长 + 2` 的紧排（见 §10.9.24） |
| 结算缩排河（`drawRiversOver`）不动 | 摊牌时要一张张数得清，22×28 逐张排开 |

#### 五、geomcheck 判据（换成更准的，不是放宽）

- 「牌河×牌河」自检原来 1.5px 容差抓同类相交；叠压是设计意图 → 改成**只查跨家**
  （`riverPos` 记座位 → 类别名带 `#sN`，同 `#sN` 内部跳过）。
- **新增正向断言**：同列相邻两张的露出比例必须落在 `[0.53, 0.72]`（理论 `dy/牌高`）。
- `replicaQuad` 必须认 `z.k`，`Δx` / 比例判据的「同一列」要用**屏幕中心 x（含 k）**，
  否则复本与真实切片差 1~3px（这条踩过：满屏 30+ 条「左缘不符」）。

### 10.9.26 副露「贴着牌河块」—— 锚点全部改成现算（2026-10-22 第八轮）

用户：「副牌的显示好像还是异常的，请对每个玩家的副牌（副露）进行修复」。

#### 根因：锚点是写死的屏幕坐标，牌河却换了坐标系

牌河改成「整块刚体缩放」（§10.9.25）之后，四块的内边缘整体内收了 20~60px，
而副露的锚点还是上一版的常量：

| 位置 | 旧锚点 | 牌河块实际 | 结果 |
|---|---|---|---|
| 自己/对家 副露横排 | `x 483 / 797`、`y 524 / 112` | 507..773 / 527..753，块高 91 / 78 | 左右各空 54px，y 挂在块的角上，既不贴也不居中 |
| 左右两家 副露竖列 | `x 236 / 984`、`y 从 56 起` | 354..466 / 808..926，`y 241..398` | 离块 60~70px，且副露列停在块的上方 → 跟牌河斜着错开 |

#### 修法：`riverBlockRect(seat)` 一处算，四家都用它

新增 `riverBlockRect(seat)` 返回牌河块的**屏幕矩形**（x 绕画布中心缩、y 只补「绕牌心缩」那半格），
副露全部按它定位，牌河怎么改副露都跟着：

- **自己 / 对家**：挂在块的左右两侧、各离 6px，**垂直居中于块**（`gy = 块中心 − 牌高/2`）。
- **上家 / 下家**：竖列贴在块的外侧 6px，整列**以块中心居中**（先算总高再定起点）；
  4 组（≈647 高）居中会顶到 -3 → 夹到 8，最后一组由 `sideBottom = 630` 兜住少画。

#### 两个坑（都踩了）

1. **左右侧牌河块的颜色写反**：写成 `slot === 0 ? 3 : 1` 取「左块」，
   对 slot 2（对家）就取成了右侧的下家块 → `lLimit` 变 813、`rLimit` 变 466（左右限互换），
   副露一组都放不下，**对家整组副露凭空消失**（截图里那一侧是空桌布）。
   正解：屏幕左/右恒为 `slot 3 / slot 1`，与自己是 slot 0 还是 2 无关。
2. **`riverBlockRect` 的上下边不能假定「首行在上」**：对家 `dy < 0`（往屏幕上方叠），
   首行 `y=170.6`、末行 `127.9`，直取会算出 `t > b`（负高度）→ 居中公式给出错的 y。
   一律 `min/max` 取真实上下边。

#### 验证

`geomcheck` 8 视图全部通过 / 0 相交（副露×牌河、副露×副露跨槽、副露×信息盘都仍然严格）。
`meldgap.cjs` 已扩到四个槽位（`单杠`/`三组` × slot 0..3），可逐张量副露的屏幕矩形：
自己 `y 451..500`（块 430..521）、对家 `y 150..191`（块 132..210）、左右 `y 240..399`（块 241..398），
组内缝 1.2~1.9、组间距 5。

### 10.9.27 侧边副露组内叠压（2026-10-22 第九轮，用户「上下家的副牌也要像手牌一样叠放」）

「上下家」= 屏幕左/右两家（上家 slot 3 / 下家 slot 1）。它们的副露是**横躺牌竖排**，
原来是「牌高 + 2」的紧排（一组 4 张 184 高），看着是一串独立的牌；现在改成**组内叠压**：

| 项 | 原来 | 现在 |
|---|---|---|
| 组内步距 | `h + 2` = 46 | **`h × 0.62` = 27**（露出 61%，下一张压住上一张的下缘） |
| 一组 4 张 | 184 高 | **107 高** |
| 组间距 | 5 | **14**（组内已经叠到 27，组间 5 会让两组粘成一条，看不出是几组） |

- **只改侧边**：自己/对家是**横排**，横着叠会挡掉牌面左侧 → 仍是 2px 紧排。
- 叠压比取 0.62，与牌河（`RIVER_LAP_*`）同一个值 —— 四条边的叠压密度看起来才是一套。
  再小就不行：副露是**亮牌**，要认得出是什么；手牌摞那种 30% 露出只适合牌背。
- **配套**：`drawMeldRow` 给每张（除末张）传 `visH = pitch`，精描边按露出带收口；
  `drawDeclared`（报杠展示）的金框同样收口，否则框底边埋进下一张牌身。
- 左右副露列的整体居中逻辑（§10.9.26）算的是**总高**，叠压后自动变短、自动重新居中，
  不用改常量；实测一列 4 张落在 `y 268..376`（牌河块 241..398 的腰部）。

#### 顺带把副露也改成「整列一个投影比」（`meldK`）

叠压后一列能排到 12 张（3 组），逐张按 `d(y)` 缩时 y 从 167 到 500 → d 从 0.80 到 0.91，
**牌宽差 6px**，整列边缘是一条锯齿（与牌河 §10.9.25 第三节同一个病）。

- `meldK(slot)` = `projD(牌河块中心 y)`：副露本来就贴着牌河块摆、深度几乎一样，用块中心那把尺子。
- 位置（`unprojTileX` 的第 5 参）和尺寸（`projQuad` 的 `z.k`）用**同一个 k**，边缘才直；
  `meldSpanN` 也换成 k，组间距不再随行漂。
- 横排（自己/对家）y 不变，块中心算出来本来就等于逐张的 d，**行为零变化**；
  结算相位（`overPhase`）仍用 `k = null` 走老路（不反补偿、步距取 pitch 原值），不必动。

实测 12 张一列：屏幕 `L 941.3 / R 987.7` 全程不变、组内 gap −14.6（叠压）、组间 +14。

### 10.9.28 副露「和牌河同形、按可见范围对齐」（2026-10-22 第十轮）

用户：「上家和下家的牌还是竖直方向没对齐，左右存在偏移」。截图量下来（1137px 高的真机图，
逐列扫白色像素）牌河三列的 x 是 349/388/428，「列」本身完全等距，问题出在**另外两处**：

#### 一、副露牌比牌河牌大一圈 → 并排两列「一粗一细」

上一版 `meldMetrics` 是「按图集比例反推」：侧边 h=44 → w=54，而牌河牌是 44×34。
两者在同一家面前**并排成两列**（副露列 + 牌河列），宽度 54 vs 44 —— 屏幕上就是
「左右存在偏移」，调锚点没用，因为**格子本身不一样大**。

改法：副露格**直接复用 `RIVER_H / RIVER_W`**（侧边 44×34、上下 34×44），与牌河完全同形。
图集比例 1.229 与牌河格 1.294 只差 5%，统一到牌河格肉眼看不出来，并排立刻齐。

#### 二、副露按「容量 8 行」居中，牌河只画了 3 行 → 上下错开

`riverBlockRect` 原来用 `o.rows`（容量）算上下边：侧边恒按 8 行 → 块 241..398、中心 319。
但牌少时牌河只占上面几行（8 张 = 3 行 → 实际 241..307），副露却居中到 319 → **两列错开 46px**。
这就是「竖直方向没对齐」。

改法：上下边按**实际画出来的行数**算（`Math.ceil(张数 / cols)`，从 `view.rivers` 取），
容量只留给 `riverK` 用（保证整块缩放比例不随牌数跳）。
实测：上家 8 张（3 行）→ 块 241..307、中心 274；副露 4 张总高 83 → 232..315，中心 273.7 ✔。

> 副作用：牌河每跨一列（8 张一档）副露会跟着挪一行 ≈18px。这是「跟可见牌河对齐」的代价，
> 比一直错开 46px 好；如果以后觉得跳，改成「按整组高度平滑」再说。

#### 三、顺手清掉死常量

`MELD_W / MELD_H / MELD_SIDE_W / MELD_SIDE_H / MELD_SIDE_BOTTOM_PLAY / MELD_SIDE_BOTTOM_OVER`
在几轮改造后都无人引用了（副露尺寸现在来自 `RIVER_*`，底限是 `sideBottom = 630`），
一律删除，注释合并进 `MELD_SIDE_LAP` 那一段。

### 10.9.29 中心盘精牌「被拍扁」的修法（2026-10-22 第十一轮）

用户：「修复中心面板中精牌显示变形的问题」。中心盘右栏那两张「正精 / 副精」是
`STAND_HUD` 分区的牌，之前两处叠加把牌压扁了：

| 原因 | 数值 | 后果 |
|---|---|---|
| `STAND_HUD` 带 Lean | `sq 0.80 / ts 0.93 / dz 1.04` | 62 高先被 `dz` 放到 64.5、再被 `sq` 压到 **51.6** |
| 框写死 `48×62` | 比例 0.774 | 源图是 279×405 = **0.689**，横向already多 12% |

净结果：48 宽 × 51.6 高 → 比例 **0.93**，比源图宽 35%，屏幕上「九萬 / 8条」明显被拍扁。

改法三条：

1. **Lean 全归 1**（`STAND_HUD = { sq:1, ts:1, dz:1, proj:false, edge:0, fx:'flat' }`）：
   牌面贴图**自带**透视与厚度，再 Lean 一次就是二次变形。
2. **宽度按源图比例算**：`jw = round(62 × art.width / art.height)` = 43（源 279×405），
   取不到图时回退 279/405。牌心固定在 `px+188 / px+246`（正/副精文字的 x），
   宽度变了文字也不会偏。
3. **`fx:'flat'`**：`resolveZone` 判定「不投影 + 不 Lean」→ 返回 null → 走**纯平面位图**
   那条路（`roundRect + clip + drawArtInto`），不切片、不画顶光 —— 牌身不再有
   8 切片重采样留下的横向接缝。

验证：`geomcheck` 8 视图全部通过（含「中心立精必须完整落在盘内」那条）；
`center_jing3/4.png` 3 倍放大：牌是 43×62 = 0.69 的竖长方形，九萬笔画、8 条的四根条都完整。

### 10.9.30 中心盘「其余 N 张结算揭晓」摆位（2026-10-22 第十二轮）

用户：「字样的显示位置异常，应该放在正副精显示的下面空白处居中」。

原来写在 `px+140, py+142` —— 那是左栏「东」字（x 86、30px 字号、宽约 30 → 71..101）的右边，
两个文案直接撞在一起，读起来像「东其余 10 张结算揭晓」。

改成 `px+217, py+126`：217 正好是「正精(188) / 副精(246)」两条标签的中线，126 在标签
（py+104）下方 22px —— 盘里唯一整块空白就在那里。字号 10 → 11（与「正精」一致）。
实测文案占 137..297，离盘右缘 320 还有 23px，与「东」「骰 3·4」都不相交。

### 10.9.31 暗杠扣牌专用牌背 `back_op`（2026-10-22 第十三轮）

用户：「我自己和对家的暗杠翻面牌使用 `opposite_block_back_0.png` 这张贴图」。

暗杠 = 4 张，**中间两张扣着**（`drawMeldRow` 里 `down = type==='angang' && (i===1||i===2)`）。
原来扣牌走的是通用牌背 `back`；现在自己/对家换成源项目那张 44×72 的瘦长金背。

#### 素材链路（走 CDN，不进代码包）

1. 源图 → `packages/client/src/assets/ui/back_op.png`（44×72，取自 `cardBack/opposite_block_back_0.png`）；
2. `npm run gen:ui-cdn` → `packages/server/public/ui/back_op.webp`（2x，2.4KB），
   `GET /api/ui` 自动扫目录，清单从 24 项变 25 项；
3. 抬 `MAHJONG_UI_VER` **v5 → v6**（版本号只是缓存失效开关，不抬会一直吃旧清单）；
4. `pages/game/game.js` 的 `uiart.preload` 列表加 `'back_op'`（小程序预解码是白名单制，
   漏了这一步 `art('back_op')` 永远是 null，静默回退到 `back`）。

#### 客户端怎么指定「这一张用哪个牌背」

不给 `drawTile` 加第 10 个参数，而是复用已有的 tilt 通道：
`tilt.backKey` → `resolveZone` 透传 → `paintTile` 里取
`uiart.art(tl.backKey || 'back') || uiart.art('back')`（3 处：3D 主路径 / 降级路径 / 平面路径）。

`drawMeldRow` 只加一行：

```js
if (down && (slot === 0 || slot === 2)) t2 = Object.assign({}, t2, { backKey: 'back_op' });
```

**为什么只给自己/对家**：这两家（以及下家/上家的副露）牌是 34×44 竖版，塞 44×72 的竖版牌背
比例接近（0.773 vs 0.611，`drawArtInto` 按 cover 居中裁，观感正常）；左右两家的副露是
**横躺牌 44×34**，竖版牌背塞进去会被裁掉大半 —— 要改得另出一张横版牌背，不是换个 key 的事。

验证：`meldgap.cjs` 的「暗杠(4张)」用例逐张打印 `back=` ——
slot 0/2 的中间两张为 `back_op`，slot 1/3 与两侧明牌为空（默认 back）；
`geomcheck` 8 视图全部通过。

### 10.9.32 上/下家手牌换「立牌侧影」贴图（2026-10-22 第十四轮）

用户：「上下家的手牌使用 `left_inhand_0.png` 和 `right_inhand_0.png` 作为贴图，
现在这样一堆太难看了」（截图里红框是左右两条**纯金色细柱**）。

源项目里玩家的手牌是**立在桌上的一排**，从对面看过去只能看到牌的**侧影**：
白色牌身的一条 + 金色牌背的一条。`cardBack/left_inhand_0.png`（26×56，白左金右）
与 `right_inhand_0.png`（26×56，金左白右）就是这两张侧影 —— **牌背一律朝桌子中心**。

#### 素材链路（与 §10.9.31 同一套，别只改一半）

1. 源图 → `packages/client/src/assets/ui/inhand_l.png` / `inhand_r.png`；
2. `npm run gen:ui-cdn` → `inhand_l.webp` / `inhand_r.webp`（各 ~1.8KB），清单 25 → **27 项**；
3. `MAHJONG_UI_VER` **v6 → v7**；
4. `pages/game/game.js` 的 `uiart.preload` 白名单加 `'inhand_l', 'inhand_r'`。

#### 画法

`drawHandStacks` 的竖摞分支改成按槽位取图（上家/左 = `inhand_l`，下家/右 = `inhand_r`）：

- **格子宽度按贴图比例改 26 → 17**（`36 × 26/56`）—— 不改的话把 26×56 的竖图塞进
  26 宽的框里会横向压扁 2 倍（跟之前副露「变形」同一个病）。
- **切片高度按露出步距等比取**（`step / 格子高 × 源高`），否则图被纵向压扁；
  切片起点取 0.28（避开顶面圆角与高光）。
- 每张之间压一条 `rgba(0,0,0,0.20)` 的 1px 暗缝：没有它整摞牌像「一根印了条纹的柱子」，
  有了它才看得出是**一叠牌**。

对家（slot 2）那排 14 张牌背没动（用户只提上下家），继续用 `back`。

> 为什么不能像源项目那样「一排斜着的牌」：源项目是 3D 场景，13 张牌斜排时每张只露一条竖影；
> 在我们这张 2:1 俯视图上，13 张完整牌要么排不开（13×26 宽会横穿左半区压到副露列）、
> 要么叠成 728 高超出画布。竖摞 + 双色侧影是 2D 下最接近的还原。

### 10.9.33 上下家手牌改「每张完整侧影」+ 侧影 alpha 压实（2026-10-23 第十五轮）

用户再贴参考图红框：「上下家手牌的排列效果应该如图所示」。参考图实测（裁剪放大
3 倍 + 像素分析）：**左右各一列 13 张竖直站立的牌，每张都是完整的「白顶 + 金背」侧影，
段间深色细线**；左列 mid row = `white[75-97] + gold[102-121]`（左白右金），右列镜像
（左金右白）；牌列约占桌面高 31%（源图 173/555）。与 §10.9.32 的「第一张整图 + 后 12 张
只重复贴图中段」不同——**参考图是均等结构**。

#### 改法（`handStackOrigin` / `drawHandStacks`）

- **每张都画完整贴图**：`ctx.drawImage(sideArt, o.x, y, o.w, o.step)`，26×56 等比缩影到
  17×16；删掉「第一张 36 高 + 后续取 srcTop=16/srcH=17 中段切片」的画法（中段重复 12 遍
  会叠出明显纹理重复，且首张与后 12 张结构不一致）。
- 步距 **11 → 16**（参考图牌列约占桌面高 31%：13×16=208）；y **248 → 96** 上移贴近
  左上铭牌（底 68，留 28px 间隙——参考图牌列同样紧贴头像下方）；`max` 13 → 14（摸牌后真实张数）。
- 段间暗缝保留 `rgba(0,0,0,0.22)` 1px（贴图自带黑底边缩影后不足 1px）。
- 方向不变：slot 3（左/上家）= `inhand_l`（左白右金）、slot 1（右/下家）= `inhand_r`（左金右白）。

#### ⚠️ 侧影 webp 的 alpha 坑（本轮真正修掉的渲染 bug）

改完后 harness 截图看白区发灰（216 → 157）。排查链路：drawImage 调用记录正常（13 张都在）、
ctx 状态干净（alpha 1 / transform dpr / filter none）—— 最后 `probe_alpha` 抓到
**webp 中心区域 alpha 只有 247**（src png 是 255）：源图边缘有抗锯齿半透明（23% 像素
alpha 1-254），`gen_ui_cdn.mjs` 的 2x 放大 + webp q=0.92 有损让半透明渗入内部；而
inhand 的显示尺寸只有源图 65%（26×56 → 17×16），**大幅缩小的双线性/mipmap 滤波把
半透明边缘平均进牌身**，叠到绿桌上整列发灰。

修在生成侧：`gen_ui_cdn.mjs` 加 `OPAQUE_KEYS`（`inhand_l` / `inhand_r`）——canvas 阶段
`getImageData` 后 **alpha<8 置 0（保圆角）、其余一律 255**，再编码 webp。
反例（不可加）：peng/gang/hu/guo/win/lost/draw 要镂空叠桌面的操作钮与艺术字。

**教训**：调试时按 16px 步长采样整列，采样点恰好全落在 1px 暗缝上，一度误判「整列发灰」——
采样要错开装饰线（本轮为此多绕了三轮探针）。另：harness 截图是 `deviceScaleFactor: 2`
的 2560×1280，按 1280×640 坐标裁剪会全盘错位（两次踩到）；页面内 `drawImage` 1:1 重导出
（`export1to1.cjs`）才是最可靠的验收方式。

#### 素材链路

1. 源图不变（`packages/client/src/assets/ui/inhand_{l,r}.png`）；
2. `npm run gen:ui-cdn` 重新生成 `inhand_{l,r}.webp`（alpha 压实后各 ~1.4KB，比压实前更小）；
3. `MAHJONG_UI_VER` **v7 → v8**（webp 内容变了，缓存失效开关）；
4. `uiart.preload` 白名单已含（§10.9.32 加的），无需再改。


#### 第四轮：y 改垂直居中（2026-10-23）

用户：「摆放位置现在为啥不是居中而是在顶部开始」。参考图牌列实测在桌面 27%..58%
（中心 42.5%）—— 第三轮为贴近左上铭牌放到 y=96，列中心只有 31%，明显偏上。
改为按容量 14 张**垂直居中**：`y = (640 − 14×16)/2 = 208`；13 张时列中心 312
（48.8%）、14 张 320（50%），张数变化只跳 8px。铭牌（y14..68 / y572..626）、
左右牌河（x303 起）与副露均不冲突，geomcheck 复跑全绿。
验证：`geomcheck` 8 视图全绿、`typecheck` / `build` 通过、harness 四相位截图 +
1:1 导出确认 13 段结构/方向/实色（白区 202,198,192）。

### 10.9.34 操作钮全面图标化：吃/暗杠/补杠/自摸/展示（2026-10-23 第十六轮）

用户：「吃碰胡杠过等操作使用图标代替按钮，相关 UI 图标在
`E:\86187\Desktop\SpringAi\majiang-master\assets\resources\apes\operate` 下面」。

#### 素材盘点（源项目 `apes/operate/`）

| 源文件 | 尺寸 | 状态 |
|---|---|---|
| `option_peng/gang/hu.png` | 113×94 | **已在用**（`assets/ui/peng/gang/hu.png` 即原图，2026-10-21 那轮就换成了图标钮） |
| `option_guo.png` | 71×67 | 已在用（「过」） |
| `option_chi.png` | **2304×1728（2.6MB）** | **缺** —— 源项目里是高分辨率大图，本项目没接 |
| `backHall/createRoom/joinRoom` | — | 大厅/房间页素材，本项目无对应页面，不用 |

#### 素材链路（吃）

1. 源图 → `packages/client/src/assets/ui/chi.png`：**裁掉透明边 → 等比缩到 113×94**
   （源内容 bbox 1560×1501，比例 4:3；缩后 98×94 居中于 113×94 画布 → 与其他钮
   同画布、视觉高度一致；**保留 alpha**（艺术字钮的墨迹底要透出桌面，故**不能**进
   `gen_ui_cdn.mjs` 的 `OPAQUE_KEYS`）；
2. `npm run gen:ui-cdn` → `chi.webp`（226×188，13.6KB），清单 27 → **28 项**；
3. `MAHJONG_UI_VER` **v8 → v9**；
4. `uiart.preload` 白名单**不加 chi** —— 它只给 DOM `<image>`（`urlOf`）用，不需要
   canvas 预解码（peng/gang/hu/guo 同理）。

#### 代码改动

- `game.js` 的 `controls` 构造：`吃` 加 `art: uiart.urlOf('chi')` + `cap`（吃的那两张牌名）；
  `暗杠/补杠` 用 `gang` 图 + cap；`自摸` 用 `hu` 图 + cap；`展示 3 张`（报杠）用 `gang` 图 + cap。
  清单未就绪时 `art` 为空串 → wxml 自动回落文字钮（行为与旧版一致）。
- `wxml`：按钮 class 加 `{{item.mini ? 'mini' : ''}}`。
- `wxss`：新增 `.ctrl.art.mini`（图 64×54rpx、cap 16rpx 字号、max-width 78rpx）。

#### ⚠️ 吃多组会把按钮挤出遮罩

吃是唯一会多组出现的动作（顺子最多 3 种组合）。7 个钮（吃 3 + 碰/杠/胡 + 过）按 92rpx
排一行要 756rpx > 750rpx 基准 —— 实测**换行并顶出 claim-mask 16~21px**（穿帮）。
因此**吃组 >1 时吃钮改小号**（`mini`）：3×74 + 4×108 = 654rpx < 750rpx，一行放得下；
其余钮保持 92rpx 的可点击尺寸。验证脚本 `.recover-tmp/claim_chi.mjs`：320/375/844 三档
视口 × 最坏 7 钮，`.ctrl-img`/`.ctrl-cap` 溢出量全为 **0**。

> 暗杠/补杠/自摸/展示 与 吃碰杠胡 是**互斥状态**（`renderControls` 里 claims 分支直接
> return），所以同屏最多 7 个钮，不存在 8 个钮挤爆的极端情况。
### 10.9.35 操作钮显示大小统一（2026-10-23 第十七轮）

用户：「统一图标的显示大小，现在有的显示更大有的显示更小」。

#### 两个大小不一的来源

1. **素材层**：五个钮的源图画布/内容占比各不相同 —— `guo` 71×67、`chi` 98×94、
   `peng` 113×94（内容仅占 92×83）、`gang` 113×94（97×90）、`hu` 113×94（109×93）。
   同一套 `.ctrl-img { width:92rpx; height:78rpx }` + `mode="aspectFit"` 之后，
   **实际显示的墨迹内容**「过」比「碰」高 15%、「吃」比「胡」小 → 肉眼看就是大小不一。
2. **布局层**：上一轮的多组吃只把**吃钮**缩小（`.mini` 64rpx），其余仍 92rpx ——
   同屏出现「3 个小 + 4 个大」。

#### 修法

- **素材层统一**（`.recover-tmp/unify_ops.cjs`）：五个钮一律「裁内容 bbox → 内容高度撑满 94
  → 居中放进 113×94 画布」。结果：内容高度全部 94（宽度 98~110 由字形比例决定），
  webp 统一 226×188。`过` 由此从 71×67 放大到 100×94，与其余同视觉重量。
- **布局层统一**：`.mini`（只缩吃钮）改为 `.compact`（**全体一起缩**）—— `ctrlCompact`
  在 `controls.length >= 7` 时置位，7 钮整体降到 76×64rpx（7×92=644rpx < 750rpx 放得下），
  同屏不会出现「大的一小的一撮」。

#### 验证（`.recover-tmp/verify_ops_size.mjs`，像素级端到端）

把每个 webp 按 CSS 显示框（含 aspectFit 规则）画进 canvas，量测 alpha>8 的墨迹 bbox：

| 状态 | 吃 | 碰 | 杠 | 胡 | 过 | 高度差 |
|---|---|---|---|---|---|---|
| standard 92×78rpx | 41×39 | 43×39 | 42×39 | 45×39 | 42×39 | **0px** |
| compact 76×64rpx | 34×32 | 35×32 | 34×32 | 37×32 | 34×32 | **0px** |

宽度差 41~45px 来自字形笔画比例（源素材固有），视觉重量一致。遮罩溢出量 0。
`MAHJONG_UI_VER` v9 → **v10**。
### 10.9.36 中心操作动画改「贴图字样」+ 缩小入场 + 渐隐消失（2026-10-23 第十八轮）

用户：「吃碰杠胡等操作现在会在中心区域显示一个简单的动画显示，请一并进行修改使用贴图的字样
添加缩小的入场动画和渐隐的消失动画」。

#### 改前

`drawActionFx()` 在中心 (640, 300) 画一个**圆角矩形 + 彩色文字**（吃/碰/杠/暗杠/补杠/胡），
缩放曲线是 `0.5 → 1.15 → 1.0`（从小放大再回落）。

#### 改后

- **贴图字样**：`uiart.art(OP_FX_ART[kind])` 取 `chi`/`peng`/`gang`/`hu` 艺术字（与操作钮
  同一套 CDN 位图），按**高 132** 绘制在中心 (640, 300)；暗杠/补杠都用 `gang` 图，
  图下补一行小注（`暗杠`/`补杠`）区分，普通杠不补。
- **缩小入场**：0~25%（300ms）`scale 1.55 → 1.0`（easeOutCubic）+ 同步淡入 —— 从大收拢到位；
- **停留**：25%~72%；
- **渐隐消失**：72%~100%（864~1200ms）`alpha 1 → 0`，同时微缩到 0.88。
- **回退**：贴图未就绪（清单失败 / preload 未完成）时仍画原来的圆角块 + 文字，行为与旧版一致。

#### 关键前提：canvas 侧要能拿到这四张位图

`chi/peng/gang/hu` 原先只给 DOM `<image>` 用（`urlOf`），**不在 `uiart.preload` 白名单** →
`uiart.art()` 取不到 → 动画会一直走回退分支。已在 `pages/game/game.js` 的 preload 列表
补上 `chi/peng/gang/hu`（画布侧预解码）。`table.js` 新增常量 `OP_FX_ART`。

#### 验证（`.recover-tmp/actionfx_frames.mjs`）

固定 `actionFx.t0` 后逐时刻渲染，与「无动画基准帧」**逐像素差分**量字样实际显示 bbox：

| 时刻 | 0ms | 60ms | 120ms | 200ms | 300ms | 600ms | 800ms | 950ms | 1100ms | 1190ms |
|---|---|---|---|---|---|---|---|---|---|---|
| 显示尺寸 | 无 | 196×161 | 172×143 | 157×133 | 155×130 | 155×130 | 155×130 | 149×125 | 140×116 | 无 |

60ms 最大（1.28×）→ 300ms 收拢到位（155×130）→ 950ms 起微缩渐隐 → 1190ms 消失。
### 10.9.37 操作动画仲裁：按 seq 排序 + 立即打断 + 平滑接管（2026-10-23 第十九轮）

用户：「为了防止两个动画效果重叠排挤位置的情况，请添加排序的逻辑，就是下一个操作的
显示动画能立马打断前一个然后进行显示，防止页面中的显示错位和异常」。

#### 原实现的问题

1. 只看 `view.lastAction`（服务端**只下发 actionLog 的最后一条**）→ 多个动作同帧到达时
   **中间的动画被整个漏掉**；
2. 没有 seq 排序与去重 → 重连重放旧 seq 会重播旧动画；
3. 打断是「硬切」：新动画从 scale 1.55 / alpha 0 重新开始，画面在切换瞬间**跳变**
   （这正是用户说的「显示错位和异常」）。

#### 改法（`table.js`）

- **数据源换成完整日志**：服务端视图里 `log` 就是完整 actionLog（`seq` 递增，最多 500 条）
  → `collectNewActions(view)` 从尾部倒扫到已处理位置即停（O(新动作数)），取 seq 升序返回。
- **排序 + 立即打断**：render 里按 seq 升序依次处理，每个新动作**覆盖** `actionFx`
  （后者立刻打断前者，不排队、不叠画）→ 画布上**任何时刻只有一个动画**。
- **平滑接管**：打断时**继承旧动画当前 scale/alpha** 作为新动画的起点（`s0`/`a0`），
  新动画由该值继续演化到满值 —— 消除切换跳变。曲线抽成 `fxPose(fx, t)` 供两处共用。
- **防重播**：`fxSeenSeq` 单调递增，seq ≤ 已处理的一律丢弃（重连重放不回放）；
  `fxBootstrapped` 首次只对齐 seq、**不回放历史**（否则进房会突然播一个旧动画）。
- **老服务端回退**：视图里没有 `log` 时退回用 `lastAction` 判定（seq 同样要求递增）。

#### 验证（`.recover-tmp/test_fxarb.mjs` 六项 + `.recover-tmp/fx_break_frames.mjs` 视觉）

| 用例 | 结果 |
|---|---|
| T1 首次进入（有历史日志）不回放 | `actionFx = null` ✓ |
| T2 同帧到达 5 个动作（seq 1..5） | 按序处理后只留最后一个（seq5 chi），画布上仅 1 个动画 ✓ |
| T3 旧动画播到 900ms 被打断 | 新动作继承 `s0=0.987 / a0=0.893`（= 打断瞬间的 scale/alpha），非硬切的 1.55/0 ✓ |
| T4 旧 seq（重连重放） | 不重播 ✓ |
| T5 无 `log` 的老服务端 | 回退 `lastAction` 正常播 ✓ |
| T6 同 seq 重复下发 | 不重播、不闪 ✓ |

视觉：0~200ms「胡」→ 300ms 被「碰」**立即替换**（同一时刻只有一个字样、位置一致、无重叠无错位），
新字样以满值接管，无缩放跳变。
### 10.9.38 结算面板顶部显示「当场对局结果图标」（2026-10-23 第二十轮）

用户：「在结算界面顶部显示当场对局的结果图标，采用图标地址在
`E:\86187\Desktop\SpringAi\majiang-master\assets\resources\apes\settlement`」。

#### 素材与位置（本来就齐了，缺的是「让它显示」）

- 源目录只有 3 张：`win.png` / `lost.png` / `draw.png`（各 260×144，书法立体字：
  胜利=金橙、失败=银灰、平局=金黄）；**已在素材链里**（`assets/ui/win|lost|draw.png` →
  `public/ui/*.webp` → `/api/ui` 清单 → `uiart.urlOf`）。
- 面板结构也已有：`<image wx:if="{{settleArt}}" class="settle-art">` 就在 `.settle-card` **顶部**
  （wxml 第 289 行），样式 `.settle-art { width:320rpx; height:178rpx; margin:0 auto 6rpx }`
  —— 比例 1.798 与源图 260/144 一致，`aspectFit` 不会拉伸。

#### 真正的根因：判据用错了，导致单局结算**从来没有**显示过图标

```js
// 改前
if (v && v.phase === 'over') {
  artKey = v.winner === null || v.winner === undefined ? 'draw' : v.winner === v.mySeat ? 'win' : 'lost';
}
```

`phase === 'over'` 只有**整盘结束**才成立；**单局结算**（每局胡牌/流局后弹的那个面板）时
phase 仍是 `playing` → `artKey` 恒为空 → 面板顶部只出文字标题，图标永远不出现。

#### 改法

1. **协议**（`packages/shared/src/index.ts`）：`settle` 消息加 `winner?: number | null`
   （null = 流局 / 无人胡牌）。
2. **服务端**（`packages/server/src/index.ts`）：赣州分支下发 `winner: outcome.winner`、
   南昌分支下发 `winner`（此前南昌的 settle **没有赢家字段**，客户端无从判断）。
3. **客户端**（`pages/game/game.js` `onSettle`）：判据换成**本局赢家**——
   `m.winner`（赣州可回退 `m.gz.winner`）：`null → draw`；等于我方座位 → `win`；否则 `lost`。
   老服务端（无 winner 字段）保留原判据兜底。

#### 验证（`.recover-tmp/test_settle_art.cjs` 源码级抽取 + `.recover-tmp/settle_art_mock.mjs` 视觉）

| 场景 | artKey |
|---|---|
| 单局结算·我方胡牌（南昌，winner=0） | `win` ✓ |
| 单局结算·别人胡牌 | `lost` ✓ |
| 单局结算·赣州流局（gz.draw） | `draw` ✓ |
| 赣州胡牌（顶层 winner 缺失、走 gz.winner） | `win` ✓ |
| 赣州别人胡牌 | `lost` ✓ |
| 老服务端（无 winner、phase=playing） | 不显示图标 ✓ |
| 老服务端兜底（phase=over, winner=2） | `lost` ✓ |

视觉：三张图标在 320×178rpx 盒内渲染比例 1.798 = 源图比例，无拉伸。

> ⚠️ **需要重新部署服务端**（settle 消息新增 winner 字段）+ 重新上传小程序代码包；
> 未部署时客户端走老服务端兜底，单局结算仍不显示图标。
### 10.9.39 局内音效：CDN 清单 + InnerAudioContext（2026-10-23 第二十一轮）

源素材 `E:/86187/Desktop/SpringAi/majiang-master/assets/resources/sound/`（中文名 mp3）。
**背景音乐（约 1MB）不接入**：流量/下载卡顿不划算，仅存档于源目录；代码包依旧**零音频**
（体检红线：图+音 ≤ 200KB），音效走与贴图同套路的 CDN 清单：

- **服务端**：`SOUND_FILES` 白名单（6 键 → ASCII 文件名，防误放文件混入清单）+
  `GET /api/sound`（`{version, base, sounds}`，`SOUND_VER` 缓存开关）+ `GET /sound/:name`
  静态下载（`/sound/` 前缀已在 downloadFile 域名规则内，与 `/ui/`、`/tiles/` 同源）。
  启动自检打印 `局内音效 … 6 个`，缺文件只警告（客户端静音回退，不影响对局）。
- **客户端** `utils/sound.js`：`ensure()`（缓存优先秒回 + 后台版本校验，网络清单
  **无条件覆盖**缓存）→ `play(key, {minGap})`（每键一个 InnerAudioContext 复用，
  stop+seek(0)+play 不叠音；`obeyMuteSwitch=false` 静音键不掐游戏音）。
  失败熔断：onError 后该键不再重试。`unlock()` 首个用户交互时零音量播 click 解锁
  iOS 音频会话（否则无交互触发的他人动作音效在 iOS 真机不响）。`setEnabled()` 持久化
  静音开关（先备好，暂无 UI 入口）。
- **触发点** `pages/game/game.js`：
  · `renderGame`：手牌张数增长 → `deal`（发牌是**逐张广播**，`minGap: 250` 节流防连响 13 下）；
  · `playActionSounds`：他人动作按 `view.log` **增量 seq** 播（discard/peng/gang/hu，
    chi=click），首次只对齐 seq 不回放历史——与动画仲裁 `fxBootstrapped` 同一约定；
  · `onControl`：自己执行的动作即时反馈（自己 + 他人不会双响：日志里的自己动作被跳过）；
  · `tryDiscard`：自己出牌 `discard` 本地即时；
  · `onTrayTap`：`unlock()` + 点牌 `click`（`minGap: 90`）。
- **坑**：`playActionSounds` 方法结尾漏逗号曾致 game.js 语法崩（`node --check` 在
  `static_check.cjs` 里必跑，别省）。

验证：`test_sound.cjs`（vm 沙箱源码级执行，工程根 "type":"module" 下 miniprogram CJS
模块不能直接 require）24 项全过——清单成功/空/失败、缓存优先、网络覆盖缓存、minGap、
静音持久化。冒烟：`/api/sound` 6 项、`/sound/hu.mp3` HTTP 200。

⚠ 上线三件套：重新部署服务端（新增 /api/sound 与 public/sound）；小程序后台
**downloadFile 合法域名**确认含 CDN 域名（音效是 downloadFile 语义）；重新上传代码包。
### 10.9.40 资源全量 CDN 化核查：web 端从 vite 本地打包改为清单加载（2026-10-23 第二十二轮）

用户要求「检查所有图标/音效/UI 是否都走 CDN 而非本地运行，不符合的改同步至 CDN」。
逐项核查结论与处置：

**小程序端（本来就达标，零改动）**：
· miniapp 目录 29 js + 7 json + 4 wxml + 4 wxss，**二进制资源 0 个**，代码包 470.8KB
  （限制 2048KB）；app.json 无 tabBar/本地图标；wxml 仅 3 个 `<image>`，
  src 全走动态 CDN URL（feltUrl / ctrl-img / settle-art）；wxss 无 url() 引用；
· 牌面 `/api/tiles`（34 张 169.5KB）、UI `/api/ui`（28→30 张）、音效 `/api/sound`（6 个），
  三个加载器全部 `config.resolveApi()` 取 host + 清单 base 拼地址。

**web 端（本轮改造，dist 6084KB → 141KB，缩 43 倍）**：
· 旧：`tileart.ts` 用 `import.meta.glob(./assets/tiles/t*.png)`（34 张 PNG 约 3.4MB）+
  `style.css` 三处 `url(./assets/bg/bg-*.png)`（2.4MB）→ vite 全打进 dist；
· 新：`tileart.ts` 改 `GET /api/tiles` 清单（web 与服务端**同源部署**，ws 即 location.host），
  base 兜底 location.origin；签名不变（preloadTiles/tileArt），调用方无感；
· `bg-cloud/bg-lattice` 两个源图复制进 `assets/ui/`，`gen:ui-cdn` 转 webp
  （SCALE_OF 加 1x：512 平铺图 2x 白费流量），清单 28→30 张；
· `style.css` 三处 data-bg 规则的纹理层改 `var(--bg-texture, none)`；
  `main.ts` 新增 `applyBgTexture(bg)`：fetch /api/ui → 按键写 --bg-texture，
  切换背景/plain（清空变量）时同步调；清单失败纹理层 none → 纯色渐变兜底。

**保留项**：dist 内 icon-192/512.png（共 11KB）= PWA 安装图标，manifest 必需，
属站点身份文件非游戏资源；`src/assets/{tiles,ui,bg,sound}` 源 PNG/mp3 存档保留
（生成脚本的输入，web/小程序代码均不再引用）。

验证：Playwright（chromium-1248，headless shell 缺失需 executablePath）6 项断言全过
—— --bg-texture 指向 /ui/bg-cloud、background-image 含 CDN 地址、bg-cloud.webp 可下载、
/api/tiles 34 项、切回纹后指向 bg-lattice、页面无 JS 异常；截图确认祥云/回纹纹理正常。

⚠ 上线：重新部署服务端（新增 bg-cloud/bg-lattice 键 + UI_VER v11）；web dist 重新构建
（141KB）；小程序侧仅清单多两项，无感。
### 10.9.41 服务端静态资源分类整理：public/ui 按用途分 6 组（2026-10-23 第二十三轮）

用户：「自家和对家上下家显示的手牌贴图呢为啥服务端没有相关文件，请统一排查进行规范化管理，
并且在服务端为这个静态资源做好分类整理」。

**排查结论**：文件一直都在（`public/ui/` 下 30 张平铺），链路也是通的
（`/api/ui` 动态扫目录下发、`uiart.preload` 白名单含 back/back_op/inhand_l/inhand_r、
`table.js` `uiart.art()` 正常取）——**「没有」的错觉来自 30 张混在一个平铺目录里，
手牌相关 4 张没有独立分类**。

**分类整理**（源目录 `assets/ui/<group>/` 与产物 `public/ui/<group>/` 同步分组）：

| 组 | 键 | 张数 |
|---|---|---|
| hand | back 牌背 · back_op 暗杠扣牌 · inhand_l/inhand_r 上下家手牌侧影 | 4 |
| operate | chi/peng/gang/hu/guo 操作钮（中心动画字样同图） | 5 |
| settle | win/lost/draw 结算结果图标 | 3 |
| hud | table 桌面 · banker 庄标 · d0..d9 大数字 | 11 |
| seat | faceA..faceD 座位平放牌图集 | 4 |
| bg | bg-cloud/bg-lattice web 背景纹理 | 2 |

· 清单值从 `back.webp` 改为**组内相对路径** `hand/back.webp`——客户端
  `uiart.urlOf` 拼 `${base}/ui/${images[key]}`，**零改动且不感知分组**；
  老服务端平铺清单仍兼容（vm 测试 T2 验证）。
· 静态路由 `/ui/<group>/<key>.webp`：已知组名单层 webp 白名单 + 原始串预检
  （拒 `..` 与百分号编码）。注意 WHATWG URL 构造时会**自动消除 dot segments**
  （含 `%2e%2e` 解码后的 `..`），所以穿越测试要用 `curl --path-as-is` 才测得准；
  资源本就全公开，无实质越权，预检是为守住分类边界。
· `gen_ui_cdn.mjs`：GROUPS 表 + 递归扫描 + 生成前清空 OUT（平铺残留必须清，
  否则清单会同时列出两级路径）。
· 台账落盘 `packages/server/public/README.md`（目录树/接口表/生成命令/维护约定）。
· UI_VER v11 → **v12**（URL 全变 = 微信侧缓存自然失效）。

验证：`/api/ui` 返回 6 组 30 键；9 个合法分组 URL 200、6 类非法 URL 404
（平铺残留/组外/不存在/穿越/伪造后缀）；web 端 Playwright 6 项复测全过
（`--bg-texture` 指向 `/ui/bg/bg-cloud.webp`）；小程序 uiart vm 测试 9 项全过。

⚠ 上线：重新部署服务端（目录结构变 + UI_VER v12）。客户端代码零改动，
但小程序会按新 URL 重新下载（旧平铺 URL 全部 404，属预期）。
### 10.9.42 face 平放牌归位牌面大类：从 ui/seat 迁到 tiles/face/（2026-10-23 第二十四轮）

用户：「每家不同的牌面显示为啥没有添加到 CDN」。

**根因是归错类**：faceA..faceD（按屏幕槽位的平放牌图集，牌河/副露/结算摊牌都在用）
在 10.9.41 被分进了 `ui/seat` 组，和「桌面 HUD、操作钮」混在一起；而客户端
`uiart.js` 又要为它单开一套 `face()`/`FACE_CELL` 取子格逻辑——**牌面相关能力
横跨 uiart/tileimg 两个模块**，既不符合「牌面唯一入口」的既有约定，
`/api/tiles` 的牌面清单也不含它们。

**迁移口径**：

- 源目录 `assets/ui/seat/faceA..D.png` → `assets/face/faceA..D.png`（mv）；
  `gen_face_atlas.mjs` 的 OUT 同步改指 `assets/face`。
- `gen_cdn_tiles.mjs` 扩成「牌面大类一个脚本」：34 立牌缩放到 W×H +
  `face/faceA..D.webp` 原尺寸（图集不能缩放，`FACE_CELL` 靠源尺寸切格），
  产物 `public/tiles/face/`。
- `gen_ui_cdn.mjs` GROUPS 去 seat：**5 组 26 张**；`packages/server/src/index.ts`
  的 `UI_GROUPS` 同步去 seat。
- 服务端 `/api/tiles` 加 `faces` 子清单：`{faceA:'face/faceA.webp', …}`；
  `/tiles/` 路由正则改 `/^(t\d{2}|face\/face[A-D])\.webp$/`；
  **TILES_VER v3 → v4、UI_VER v12 → v13**（URL 全变 = 微信侧缓存自然失效）。
- 客户端 `utils/tileimg.js` 成牌面唯一入口：新增 `faceImages` Map、
  `urlOfFace(key)`、`faceArt(key,t)`（返回 `{img,sx,sy,sw,sh}` 直传 drawImage）、
  `FACE_CELL` 与 `FACE_COLS=9`、`preload` 扩为 34 立牌 + 4 face 一起预解码、
  `debug()` 加 `faceCount`/`faceDecoded`；`table.js` 两处
  `uiart.face(SEAT_FACE[slot],t)` → `tileimg.faceArt(...)`；
  `uiart.js` 删 `face()/cell()/FACE_CELL/FACE_COLS`；`game.js` preload
  白名单去 faceA..D（tileimg.preload 已自动含）。
- 台账 `packages/server/public/README.md`：tiles 大类加 `face/` 子类、ui 改 5 组 26 张、
  接口表补 `/api/tiles` faces 与 `/tiles/face/` 路由。

验证：`/api/tiles` v4 含 faces 4 键、`/api/ui` v13 26 键 5 组且无 face 键、
`/tiles/face/faceA.webp` 200、`/ui/seat/faceA.webp` 404（旧类目已不存在）、
`/tiles/face/faceE.webp` 404（白名单外）；probe 确认 4 家 face 位图实际绘制
（A 20/B 24/C 25/D 次）；`shots_art` 4 截图 ✔；tileimg faces vm 测试 14 项全过
（含老服务端无 faces 字段时静默回退、立牌不受影响）。

⚠ 上线：重新部署服务端（TILES_VER v4 + UI_VER v13）。小程序代码零改动，
但会按新 URL 重新下载（`/ui/seat/*` 全部 404，属预期）。

### 10.10 待办（按方案仍需处理）
- [ ] **重新部署服务端**（`wss://majiang.dwzynj.top/ws`）：线上版本落后于仓库，不认识
      `{t:'ping'}`，也还没有 `未知消息：<t>` 的类型回显与「每连接只提示一次」；
      另需带上 10.9.41/42 的资源分类（UI_VER v13 + TILES_VER v4 + public/{tiles,ui,sound} 目录结构）。
      客户端已做兼容（吞掉 + 停发心跳；老清单静默回退），但**根治要靠部署新版本**。

- [ ] `utils/config.js` 的 `DEFAULT_WSS` 填入真实域名（wss + 已备案），并在后台登记 socket 合法域名
- [x] ~~`project.config.json` 填入 AppID~~（开发者工具导入时已写入，libVersion 3.17.4）
- [ ] 真机矩阵验证（iOS/Android 横屏、切后台重连、低端机 canvas 帧率、横屏键盘弹起与 `env(safe-area-inset-*)`）
- [ ] 棋牌类目资质与审核材料（方案 P6，周期最长，需与企业主体并行推进）

> 相关文档：`docs/guides/agent.md`（改动铁律）、`docs/architecture/multi-variant.md`（多玩法契约）、
> `docs/rules/nanchang.md`、`docs/rules/ganzhou.md`。
