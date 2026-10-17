# 麻将 · 微信小程序端

> 本目录是 web 版麻将的**小程序客户端**。规则与协议与 web 端共用同一份 `packages/shared`，
> 服务端仍是 `packages/server` —— 小程序与网页可以**同桌对战**。
> 迁移方案与偏离说明见 `docs/integration/wechat-miniprogram.md`。

---

## 1. 最快跑起来（局域网联调，5 步）

```bash
# ① 起服务端（仓库根目录，另开一个终端）
npm run build     # 首次或改过 web 端后才需要：产出 packages/client/dist 供浏览器访问
npm run start     # 默认监听 3130，终端会打印「局域网访问: http://192.168.x.x:3130」
```

> 若在 WorkBuddy 内置终端里执行构建，需写成 `NODE_OPTIONS= npm run build`
> （安全 shim 会拦截 vite 对 dist 的清理并超时）；普通终端不受影响。

1. 微信开发者工具 → **导入项目** → 目录选 **`packages/miniapp/miniprogram`**（app.json 所在目录）。
   - 没有 AppID 就点「测试号」；已有 AppID 会自动写入 `project.config.json`。
2. **详情 → 本地设置 → 勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**
   （局域网 `ws://` 不是合法域名，不勾会连不上）。
3. 在开发者工具的**调试器 Console** 里执行一次（改成你电脑的局域网 IP）：

   ```js
   wx.setStorageSync('mj-wss', 'ws://192.168.1.10:3130/ws')
   ```

   这个键是**调试覆盖**，优先级高于代码里的默认值，清空用 `wx.removeStorageSync('mj-wss')`。
4. 编译（Ctrl+B）→ 首页填昵称 → **创建房间** → 记下 6 位房间码。
5. 想验证「小程序 ↔ 网页同桌」：浏览器打开 `http://192.168.1.10:3130`，填同一房间码「加入房间」即可。

> 真机预览时**多数机型不允许 `ws://` 局域网地址**，真机验证需要第 3 节的正式配置（wss + 备案域名）。

---

## 2. 目录结构与「改哪里」

```
packages/miniapp/miniprogram/        ← 开发者工具的「项目根」（导入这一层）
├── app.json                         页面路由（home / lobby / game）
├── app.js                           全局状态（座位、庄家、聊天历史）
├── app.wxss                         全局样式（四档背景渐变 + 掷骰覆盖层样式）
├── project.config.json              工具生成：AppID、基础库、编译选项
├── templates/
│   └── dice.wxml                    掷骰覆盖层模板（对局页 / 大厅页共用）
├── utils/
│   ├── config.js                    ★ 部署地址 DEFAULT_WSS（上线必填）
│   ├── net.js                       WebSocket 单例 / 退避重连 / 应用级心跳
│   ├── room.js                      服务端消息路由（state→大厅、game→对局）
│   ├── store.js                     本地存储键（与 web 端 localStorage 同名）
│   ├── table.js                     Canvas 2D 牌桌（移植自 client/src/table.ts）
│   ├── tileimg.js                   牌面 CDN 资源（后端清单 → 未就绪回退矢量）
│   ├── dice.js                      骰子点子网格（九宫格 3×3，1、4 为红）
│   └── ui.js                        toast / confirm
├── pages/home/                      分步向导（创建/加入、玩法、昵称）
├── pages/lobby/                     房间：座位、换位、准备、机器人、定庄骰
├── pages/game/                      对局：画布、控件、手牌条、聊天、结算
└── lib/shared/                      shared 编译产物（npm run build:mp 生成，勿手改）
```

改规则/算分 → 改 `packages/shared/src`，然后 `npm run build:mp`（**不要动 `lib/shared/`**）。

### 横屏布局约定（改样式前必读）

三页 json 都是 `"pageOrientation": "landscape"` + `"disableScroll": true`——**页面锁横屏且不能滚动**，
布局必须一屏装下，横向才是主场。每页 wxss 都是两档：

| 档位 | 命中条件 | 尺度 | 行为 |
|---|---|---|---|
| 标准档 | 视口高 > 680px（平板横屏） | rpx | 竖向堆叠 |
| 紧凑档 | 视口高 ≤ 680px（手机横屏、压矮的模拟窗口） | **px** | 左右分栏 + chrome 压到最小 |

分界线 680px 落在「手机横屏 ≤430px」与「平板横屏 ≥724px」之间的空隙，两端行为都确定。
紧凑档用 px 而不用 rpx：rpx 随**屏宽**放大，宽而矮的窗口里会把字号/间距撑爆、内容顶出屏幕且不可滚。

- **game 页**：紧凑档下 HUD/状态/控件/手牌条全部压到最小，剩余高度全给 `#canvas-wrap`；
  聊天展开时占 `32vw`（240~320px 封顶）右列，与画布并排、互不遮挡。收起态是 HUD 上的 💬 圆钮。
- **画布尺寸**：`fitCanvas() = min(容器宽, 容器高×2)`，横屏下常常是**高度受限**（手机横屏 ≈490×250），
  这是 2:1 牌桌的物理上限。手牌条/聊天/结算恢复条的显隐都会改变容器尺寸——**改这些 WXML 结构时，
  对应的 JS 里要跟一次 `fitCanvas()`**（它内部已包 `wx.nextTick`，量的是新布局；
  漏了这步不会报错，只会「点牌错位」）。

### `<button>` 内置默认样式（改按钮必读）

`app.json` 的 `"style": "v2"` 会注入一条 **UA 样式**，特异度 `(0,1,1)` 且排在我方 wxss **之后**，
普通声明压不掉，只能用 `!important`：

```css
button:not([size='mini']) { min-height: 40px; width: 184px;
                            margin-left: auto; margin-right: auto }
```

不处理的后果：每个按钮都被撑成 184px 定宽、`margin:auto` 在 flex 行里散布成双倍间距、
定宽圆钮全部失效、禁用态被内置灰底盖掉我方配色。

**因此**：`app.wxss` 的 `button {}` 基样式里那四条 `!important`
（`display:inline-block / width:auto / min-height:0 / margin:0`）是**刻意为之，别当冗余删掉**；
要定宽的按钮在自己类里写 `width: … !important`；靠 `margin:auto` 对齐的写 `margin-left:auto !important`；
禁用态配色逐类 `!important` 覆盖 `background`/`color`。
（2026-10-17 排查记录：`docs/integration/wechat-miniprogram.md` §10.6）
- 任何 `position: fixed` 的新浮层都会压画布或手牌条（横屏高度太贵），新增面板请并排进 flex 流。
- 真机上 iOS 横屏有 home 指示条安全区，紧凑档用 `env(safe-area-inset-bottom)` 兜底。

---

## 3. 配置项速查

| 想改什么 | 改哪里 | 说明 |
|---|---|---|
| **服务器地址（上线必填）** | `miniprogram/utils/config.js` → `DEFAULT_WSS` | 例：`'wss://mahjong.example.com/ws'`。必须是 **wss**、**不带端口**（走 443）、域名已 **ICP 备案** |
| 调试期临时换地址 | `wx.setStorageSync('mj-wss', 'ws://192.168.x.x:3130/ws')` | 覆盖 `DEFAULT_WSS`；上线前应删除 |
| 小程序后台域名登记 | 微信公众平台 → 开发管理 → 开发设置 → **服务器域名 → socket 合法域名** | 填 `wss://mahjong.example.com`（不带端口、不带路径）。若后台填了端口，请求就只能用那一个端口 |
| AppID | `miniprogram/project.config.json` → `appid` | 测试号留空即可；正式号由后台获取 |
| 服务端端口 | 启动前 `PORT=4000 npm run start` | 默认 3130 |
| 服务端行为（响应窗口/仪式/机器人节奏等） | 环境变量：`MAHJONG_TURN_MS`、`MAHJONG_CEREMONY`、`MAHJONG_FIXED_SEATS`、`MAHJONG_RECON_MS` … | 完整清单见 `docs/guides/agent.md` §7 |
| 玩法（南昌 / 赣州） | 运行时在首页选择；代码层在 `packages/shared/src/rules/` | 新增玩法只改 shared，两端同时生效 |
| 背景（绒面/回纹/祥云/素色） | 首页底部「背景」按钮 | 写入存储键 `mj-bg`；已降级为 CSS 渐变（原 4MB 纹理不进包） |

本地存储键（与 web 端 `localStorage` 同名，便于双端一致）：
`mj-token`（回桌凭证）、`mj-room`（上次的房间码）、`mj-name`（昵称）、`mj-bg`（背景）、`mj-variant`（玩法）、`mj-wss`（调试地址覆盖）。

---

## 4. 构建命令（什么时候需要重跑）

| 命令 | 作用 | 何时执行 |
|---|---|---|
| `npm run build:mp` | 把 `packages/shared` 编译成 CommonJS 产物 → `miniprogram/lib/shared/` | **改过 shared / 协议后必须跑** |
| `npm run build` | 构建 web 客户端 `packages/client/dist` | 需要用浏览器加入同一房间验证时 |
| `npm run typecheck` | 全仓类型检查 | 改 shared/server/client 后自检 |

小程序端的页面/样式改动**不需要跑任何命令**，开发者工具编译即生效。

---

## 5. 连不上时按这个顺序查

排障要看**页面现在给出的文案**：横幅 / 表单错误位会写明 `域名未登记`、`超时`、`地址格式` 三类原因（2026-10-17 起）。

**① 服务端在跑吗**

```bash
netstat -ano | findstr :3130        # 应看到 0.0.0.0:3130  LISTENING
# 或在浏览器打开 http://192.168.1.10:3130 —— 能看到麻将首页就说明服务在跑
```

服务端启动时会打印 `局域网访问: http://192.168.x.x:3130`；`npm run start` 的目录必须是**仓库根**。

**② 这个 IP/端口真的通吗**（PowerShell，改成你的 IP）

```powershell
Test-NetConnection 192.168.31.63 -Port 3130    # TcpTestSucceeded : True 才算通
```

`False` 多为 Windows 防火墙拦了 Node（首次运行 `npm run start` 时若弹过「允许访问网络」，要勾**专用网络**）。

**③ 域名校验关了吗**

详情 → 本地设置 → 勾「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」。
它对应 `project.private.config.json` 里的 `"urlCheck": false`（本仓库已置为 false）。

> ⚠️ 点「清缓存 → 清除全部缓存」会把 `wx.setStorageSync('mj-wss', …)` 一起清掉，
> 之后会提示「未配置服务器地址」，重设一次即可。

| 现象 | 原因 / 处理 |
|---|---|
| 首页一进来就显示「连接已断开，正在重连…」 | 旧版本误报（还没连就提示重连）已修：未连接过不再提示。若仍出现，说明之前连上过又断了，看后面的原因文案 |
| 点「创建/加入」没反应 | 现在会把平台原因写在按钮下方；同时看调试器 **Network** 面板有无 `connectSocket` 失败记录 |
| 提示「域名未登记」 | 开发期勾「不校验合法域名」；真机/上线必须 wss + 备案域名 + 后台登记 socket 域名 |
| 提示「连接超时」 | 服务端没起 / IP 变了（`ipconfig` 确认）/ 端口不是 3130 / 防火墙 |
| 一直「正在重连…」且服务端正常 | 进房后掉线才会这样：检查是否服务端重启过（token 失效 → 会回向导） |
| 模拟器启动失败，报 `preloadRule … 未找到` | `pages: []` 的纯资源分包不会被注册。**本项目不用分包**，也不要再加空 pages 的分包 |
| 代码包体检「图片资源 > 200KB / 主包 > 1.5MB」 | 牌面**已改纯矢量绘制**（无任何图片资源），包体约 250KB；不要再往主包塞 PNG 美术资源 |
| 点牌位置偏 | 画布由 JS 按 `min(容器宽, 容器高×2)` 精确设尺寸并 `wx.nextTick` 后量 rect。**不要在 WXSS 里给 `canvas` 写死宽高或让它被非等比拉伸** |
| 想清掉自动回桌 | `wx.removeStorageSync('mj-token')` 后重启（等价于 web 端清 localStorage） |

---

## 6. 上线前还差什么

- [ ] `DEFAULT_WSS` 填真实 wss 域名 + 后台登记 **socket 合法域名**（域名须 ICP 备案）
- [ ] 真机矩阵：iOS / Android 横屏、切后台重连、低端机 canvas 帧率
- [ ] **棋牌类目资质**（企业主体 / 软著 / 合规材料）—— 周期最长，建议与开发并行
- [ ] 隐私协议中说明 openid / 本地存储的用途

详见 `docs/integration/wechat-miniprogram.md` §10.4 与 §2.6（合规风险）。
