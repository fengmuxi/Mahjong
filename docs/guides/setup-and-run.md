# 环境配置与完整运行示例

> 从零开始把麻将项目跑起来的完整手册：环境要求 → 安装 → 构建 → 起服务端 → 跑小游戏端 → 一局完整对局 → 上线配置。
> 规则文档见 `docs/rules/`，改动指引见 `agent.md`，本文只讲「怎么跑」。

## 1. 环境要求

| 依赖 | 版本要求 | 用途 |
|---|---|---|
| Node.js | ≥ 18（推荐 20 LTS） | 服务端运行时（`tsx` 跑 TS）、构建脚本 |
| npm | 随 Node | 依赖安装与脚本 |
| 微信开发者工具 | 最新稳定版 | 小游戏端的编译、预览、真机调试 |

> 服务端只用 Node + `ws`，无数据库、无其他外部服务；所有对局状态在内存中。

## 2. 安装与构建（首次必做）

在**仓库根目录**执行：

```bash
# ① 安装依赖（仅 tsx / typescript / ws 等少量开发依赖）
npm install

# ② 类型自检（strict 模式，应零报错）
npm run typecheck

# ③ 编译共享规则库到客户端（产物 lib/shared/ 勿手改）
npm run build:mg    # → packages/minigame/game/lib/shared/
```

**什么时候需要重跑构建**：改过 `packages/shared/src/`（规则 / 协议 / 牌面工具）之后必须重跑 `build:mg`。只改服务端或客户端页面代码不需要。

## 3. 启动服务端

```bash
npm run start        # 前台跑（tsx packages/server/src/index.ts）
npm run dev:server   # 开发推荐：watch 模式，改动即重启
```

启动成功会打印：

```
麻将服务器已启动  http://localhost:3130（玩法：nanchang / ganzhou）
局域网访问:  http://192.168.x.x:3130
```

- 默认端口 **3130**（改法：`PORT=4000 npm run start`）。
- `npm run start` 必须在**仓库根**执行（脚本路径以根为准）。
- 端口被占用时报错信息里会给出排查命令（`Get-NetTCPConnection -LocalPort 3130 …`）。

**局域网联调最小配置（默认即可跑）**：

```bash
# 本机验证可复现入座 + 关仪式动画（可选，纯调试用）
set MAHJONG_FIXED_SEATS=1
set MAHJONG_CEREMONY=0
npm run start
```

## 4. 客户端接入

客户端只有一个：微信小游戏端（`packages/minigame`），连服务端同一套协议。

### 4.1 小游戏端（packages/minigame）

1. 微信开发者工具 → 导入项目 → 目录选 **`packages/minigame/game`**（含 `game.js` / `game.json` 这一层）。
   - `project.config.json` 已带测试号 `touristappid` 占位；上线前换成你自己的**小游戏** appid。
2. 同样勾选「不校验合法域名」（贴图 / UI / 音效清单走 `wx.request`，不勾会全部被拦、只剩矢量兜底；控制台出现 `[mg] …清单拉取失败` 即此原因）。
3. 连本地服务端：

   ```js
   wx.setStorageSync('mj-wss', 'ws://127.0.0.1:3130/ws')
   ```

   然后重启小游戏。默认不设置时连线上 `wss://majiang.dwzynj.top/ws`（`utils/config.js` 的 `DEFAULT_WSS`）。

## 5. 完整运行示例：从零到一局对局

以「1 台电脑起服务端 + 2 个开发者工具窗口（或工具 + 真机预览）+ 机器人补位」为例：

```text
① 终端（仓库根）
   npm run start
   → 看到「麻将服务器已启动 http://localhost:3130」

② 开发者工具 A（小游戏端）
   → 首页填昵称「甲」→ 创建房间 → 记下 6 位房间码（如 ABCDEF）
   → 大厅点「准备」

③ 开发者工具 B（另一个小游戏窗口，或另一台设备）
   → 首页填昵称「乙」→ 加入房间 → 输 ABCDEF
   → 也可以直接点 A 分享出去的卡片（转发携带 room=ABCDEF，点开自动进房；
     没填昵称会随机分配「玩家XXXX」兜底）

④ 大厅补位
   → 房主（甲）点「加机器人」补满 4 家（或再开两个客户端真人加入）
   → 四人各掷两骰定庄（点数最大者坐庄，并列重掷）

⑤ 开局对局
   → 庄家点「掷骰」→ 发牌动画 → 依次出牌 / 吃碰杠胡
   → 结算面板四家 delta 之和恒为 0 → 可点「下一局」继续

⑥ 中途验证重连
   → 直接关掉 B 的工具再重开：凭本地 token 自动 resume 回原座位
```

服务端行为验证（可选，另开终端）：

```bash
node scripts/variant_settle_server.mjs   # 纯 WebSocket 自动打完一局赣州，验结算窗口（需 MAHJONG_CEREMONY=0 起服务端）
node scripts/mg_geomcheck.cjs            # 小游戏端回归：渲染/命中 + 布局几何 + utils 冒烟
```

## 6. 配置项总览

### 6.1 服务端配置（配置文件 + 环境变量）

**优先级：环境变量 > `mahjong.config.json`（仓库根）> 代码内置默认。**

- 日常部署改 [mahjong.config.json](../../mahjong.config.json)（键为小驼峰，与下表环境变量一一对应，文件内 `_comment` 键是说明、装载器忽略未知键）；
- CI / 临时调试用环境变量逐项覆盖，不必改文件；
- 装载器容忍 UTF-8 BOM（Windows 记事本保存也能读）；文件解析失败只告警并回退默认，不会起不来；
- 数值单位 ms；布尔兼容 `true/false`、`1/0`、`on/off`。

| 环境变量 | 配置文件键 | 默认 | 用途 |
|---|---|---|---|
| `PORT` | `port` | 3130 | 监听端口 |
| `MAHJONG_TURN_MS` | `turnMs` | 15000 | 响应窗口（共享 15s 倒计时） |
| `MAHJONG_AUTO_MS` | `autoMs` | 3000 | 掉线 / 手动托管自动出牌等待 |
| `MAHJONG_BOT_MS` | `botMs` | 1600 | 机器人**出牌**思考时间下限（区间内随机） |
| `MAHJONG_BOT_MS_MAX` | `botMsMax` | 下限 × 2.25 | 机器人出牌思考时间上限（两值相等→固定节奏，`0`→不等待） |
| `MAHJONG_BOT_CLAIM_MS` | `botClaimMs` | 700 | 机器人吃/碰/杠/胡响应思考下限 |
| `MAHJONG_BOT_CLAIM_MS_MAX` | `botClaimMsMax` | 下限 × 2.5 | 响应思考上限（机器人掷骰也用这档） |
| `MAHJONG_THROW_DICE` | `throwDice` | true | 掷骰补杠开关（`0`/`false` 关 → 摸倒数第一张） |
| `MAHJONG_CEREMONY` | `ceremony` | true | 掷骰仪式总开关（关，自动验证脚本需要关） |
| `MAHJONG_DEAL_MS` | `dealMs` | 6500 | 开局发牌动画窗口 |
| `MAHJONG_ROLL_MS` | `rollMs` | 2600 | 杠后掷骰动画窗口 |
| `MAHJONG_FIXED_SEATS` | `fixedSeats` | false | 设 `1`/`true` → 加入者按空位顺序入座（本地验证用，入座可复现） |
| `MAHJONG_ROOM_TTL_MS` | `roomTtlMs` | 1800000 | 房间无人类连接持续这么久 → 自动回收并作废 token |
| `MAHJONG_ROOM_SWEEP_MS` | `roomSweepMs` | 60000 | 房间回收巡检间隔 |
| `MAHJONG_PING_MS` | `pingMs` | 15000 | 心跳 ping 间隔（探活半开连接） |
| `MAHJONG_PONG_TTL_MS` | `pongTtlMs` | 45000 | 多久没收到 pong 掐断连接 → 掉线托管 + 重连宽限 |
| `MAHJONG_CDN` | `cdn` | 空 | 对外资源 base（留空 = 与接口同源） |
| `MAHJONG_TILES_VER` | `tilesVer` | v4 | 牌面资源版本（换美术抬号失效客户端缓存） |
| `MAHJONG_UI_VER` | `uiVer` | v14 | UI 贴图版本（同上，与牌面分开） |
| `MAHJONG_SOUND_VER` | `soundVer` | v3 | 音效资源版本 |
| `WX_MG_APPID` / `WX_MG_SECRET` | `wxMgAppid` / `wxMgSecret` | 空 | 小游戏端实时语音凭据（**secret 建议只走环境变量，勿提交仓库**） |

配置层实现：`packages/server/src/config.ts`（`str` / `num` / `bool` 三个取值助手，服务端所有 `process.env` 读取都经它）。

### 6.2 客户端配置

| 想改什么 | 改哪里 | 说明 |
|---|---|---|
| 服务器地址（上线必填） | `packages/minigame/game/utils/config.js` → `DEFAULT_WSS` | 例 `'wss://mahjong.example.com/ws'`。必须是 **wss**、不带端口（走 443）、域名已 ICP 备案 |
| 调试期临时换地址 | `wx.setStorageSync('mj-wss', 'ws://192.168.x.x:3130/ws')` | 覆盖 `DEFAULT_WSS`，上线前删除 |
| CDN 清单地址（可选） | `wx.setStorageSync('mj-api', 'https://cdn.example.com')` | 默认由 wss 域名推导（ws→http / wss→https） |
| AppID | 各端 `project.config.json` → `appid` | 测试号留 `touristappid`；正式号由微信后台获取 |
| 玩法（南昌 / 赣州） | 运行时首页选择；代码层在 `packages/shared/src/rules/` | 新增玩法只改 shared，服务端与客户端同时生效 |
| 背景（绒面/回纹/祥云/素色） | 首页底部「背景」按钮 | 存储键 `mj-bg` |

客户端本地存储键：`mj-token`（回桌凭证）、`mj-room`（上次房间码）、`mj-name`（昵称）、`mj-bg`（背景）、`mj-variant`（玩法）、`mj-wss`（调试地址覆盖）、`mj-api`（CDN 覆盖）。

### 6.3 微信后台域名登记（上线必须）

| 端 | 登记位置 | 需登记的域名 |
|---|---|---|
| 小游戏端 | 小游戏后台 → 开发管理 → 开发设置 → 服务器域名 | **socket 合法域名**：`wss://mahjong.example.com`（不带端口不带路径）；**request + downloadFile 合法域名**：`https://mahjong.example.com`（牌面/UI 贴图清单与图片下载） |

## 7. 上线前检查清单

- [ ] `DEFAULT_WSS` 改成真实 wss 域名（wss + 443 + ICP 备案），后台登记 socket / request / downloadFile 三类域名
- [ ] 服务端部署：`npm run start`（建议 pm2 / systemd 守护；单一 Node 进程，无外部依赖）
- [ ] 反向代理（nginx / 云负载均衡）放通 `/ws` 的 WebSocket 升级与 `/api` 静态清单
- [ ] 真机矩阵验证：iOS / Android 横屏、切后台重连、低端机 canvas 帧率
- [ ] **棋牌类目资质**（企业主体 / 软著 / 合规材料）——周期最长，与开发并行
- [ ] 隐私协议中说明 openid / 本地存储用途
- [ ] 若启用语音：配齐 `WX_MG_APPID`/`WX_MG_SECRET`（接入文档 `docs/integration/wechat-voice.md`）

## 8. 常见问题（按现象查）

| 现象 | 原因 / 处理 |
|---|---|
| 客户端提示「连接超时」 | 服务端没起 / IP 变了（`ipconfig` 确认）/ 端口不对 / Windows 防火墙拦了 Node（首次启动弹窗要勾「专用网络」）。PowerShell 验证：`Test-NetConnection 192.168.x.x -Port 3130` |
| 提示「域名未登记」 | 开发期勾「不校验合法域名」；真机 / 上线必须 wss + 备案域名 + 后台登记 |
| 贴图 / UI / 音效全不显示（小游戏端尤甚） | 九成是域名校验拦截了 `/api/*` 清单请求：勾「不校验合法域名」；控制台 `[mg] …清单拉取失败` / `预解码 0 张` 即此因 |
| 一直「正在重连…」 | 进房后掉线才会这样：检查服务端是否重启过（重启后 token 失效，会回向导重新进房） |
| 端口被占用（`EADDRINUSE`） | 上一个 tsx/node 没退干净：`Get-NetTCPConnection -LocalPort 3130 -State Listen` 找 PID 结束，或 `PORT=3131 npm run start` |
| 点牌位置偏 | 画布尺寸由 JS 精确计算，**不要**在 wxss / 画布上写死宽高或非等比拉伸 |
| 想清掉自动回桌 | `wx.removeStorageSync('mj-token')` 后重启客户端 |
| 改了 shared 规则没生效 | 重跑 `npm run build:mg`（`lib/shared/` 是产物，手改无效） |
