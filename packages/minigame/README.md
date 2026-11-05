# 小游戏端（packages/minigame）

微信**小游戏**版客户端（`compileType: "game"`，单画布 + `game.js` 入口），**当前唯一对局入口**。
复用服务端协议与 `packages/shared` 规则库；web 客户端与微信小程序端均已移除。

## 快速开始

1. **微信开发者工具** → 导入项目 → 目录选 `packages/minigame/game`（含 `game.js` /
   `game.json` 的这一层）。AppID 已配置为项目的小游戏 appid（project.config.json；
   ⚠ 新环境换成你自己的**小游戏** appid 即可）。
2. 连服务器（二选一）：
   - 线上：默认 `wss://majiang.dwzynj.top/ws`（`utils/config.js`），无需配置；
   - 本地：仓库根 `npm run dev:server`，然后在开发者工具控制台执行
     `wx.setStorageSync('mj-wss', 'ws://127.0.0.1:3130/ws')` 后重启小游戏。

   ⚠ **贴图 / UI / 音效全不显示？** 九成是**域名校验**：appid 尚未配置合法域名（或用
   touristappid 测试号）时，DevTools 会把 `wx.request`（拉 `/api/tiles`、`/api/ui`、`/api/sound` 清单）全部拦掉，
   于是整条链路走矢量/文字兜底。处置：**详情 → 本地设置 → 勾选
   「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**
   （`project.private.config.json` 已带 `urlCheck:false`，但 DevTools 导入时可能生成
   覆盖它的私有配置 —— 以工具界面为准）。控制台若出现 `[mg] …清单拉取失败` /
   `预解码 0 张` 的警告，按提示排查即可。
3. CDN 资源（贴图 / UI / 音频）在**冷启动即后台预热**（`src/preload.js`）——无需
   手动预加载；对局内资源到位后一次性换装，不会出现「先兜底样式再闪回来」。
4. 构建规则库（lib/shared 是产物，勿手改）：

   ```bash
   npm run build:mg   # packages/shared/src → packages/minigame/game/lib/shared（带 8 项自检）
   ```

## 目录结构

```
packages/minigame/
  game/                      ← 开发者工具导入这一层
    game.js                  入口（薄）：只 require src/main.js
    game.json                {"deviceOrientation":"landscape"}
    project.config.json      compileType:"game" + 小游戏 appid
    lib/shared/              build:mg 产物（协议/规则，与服务端同一份 shared 源码）
    utils/                   牌桌渲染 / 资源加载 / 设置等工具模块
    src/
      main.js                引导 + 单一 rAF 主循环（场景 → 转场遮罩 → toast）
      app.js                 运行时单例（主画布 / dpr / 牌桌离屏宿主）
      state.js               全局共享量（对位 app.js globalData）
      layout.js              纯数学布局（对位 SelectorQuery 量测体系）
      input.js               全局触摸路由 + wx.showKeyboard 单焦点管理
      nav.js                 消息路由（room.js 逐行移植）+ 场景切换（对位页面导航）
      chrome.js              对局 DOM 半边的画布实现（顶栏/侧轨/操作带/面板/浮层）
      scenes/{home,lobby,game}.js   三场景（对位三页面；每次导航重建实例）
      scenes/scene.js        场景基类（钩子契约）
      ui/                    画布控件：draw / btn / toast / layer / dicefx
scripts/mg_geomcheck.cjs     回归：渲染/命中 + 布局几何 + utils 冒烟
```

## 移植原则（历史：自小程序端迁入）

| 层 | 策略 |
|---|---|
| `utils/table.js` 等 utils | 移植时逐字节原样复制（小程序端移除后不再做双端一致性校验）。table.js 渲染到**离屏宿主画布**，主循环 blit 到全屏主画布 —— 它自管 backing store 的假设不变 |
| `lib/shared` | `npm run build:mg` 重新产出（`scripts/mp_build_shared.mjs`） |
| 页面导航（wx.redirectTo） | `src/nav.js` 场景切换：重建场景实例（对位「导航重建 Page」）+ 170/220ms 淡出淡入 |
| WXML/WXSS（DOM 半边） | `src/scenes/*` + `src/chrome.js` + `src/ui/*` 画布重绘，样式取各页 wxss **紧凑档**（@media max-height 680px —— 小游戏恒为横屏手机） |
| `<input>` | `wx.showKeyboard` 单焦点输入框（src/input.js）；系统键盘支持粘贴，整段分享文案经 `cleanCode` 抠 6 位房间码 |
| `scroll-view` | 触摸拖拽 + clip 自绘滚动（日志 / 聊天 / 结算明细） |
| CSS 动画（骰子翻滚 / 页面转场） | JS 补间（src/ui/dicefx.js、nav.js） |
| 胶囊避让 | 特性检测 `wx.getMenuButtonBoundingClientRect`，拿不到则退 `safe.t + 16` 兜底 |

**服务端零改动**：协议（含 app 级 `ping/pong` 心跳）、匿名 token+pid 认证、CDN
素材清单（/api/tiles、/api/ui、/api/sound）全部不变。

## 已知差异 / 限制

- 小游戏键盘无组件级 maxlength 光标控制：控件侧裁剪（昵称 8 字、聊天 60 字照搬
  `CHAT_TEXT_MAX`）；键盘高度经 `wx.onKeyboardHeightChange` 拿到，聚焦的输入行自动
  抬到键盘上沿（adjust-position 对位），点输入区外收键盘。
- 桌面贴图（table）与操作钮艺术图（chi/peng/gang/hu/guo）从 CDN 清单预解码到画布；
  未就绪时走同一套矢量/文字兜底。
- 只实现了紧凑档（横屏手机）布局；平板大窗按同布局呈现（不缩放）。
- 上线需要独立小游戏资质（类目 / 版号 / 合规材料），域名需配置 socket /
  request / downloadFile 三类合法域名。

## 验证

```bash
npm run build:mg                 # shared 产物 + 8 项自检
node scripts/mg_geomcheck.cjs    # 渲染/命中语义 + 布局几何 + utils 冒烟
for f in $(find packages/minigame/game -name '*.js'); do node --check $f; done
```

手工链路（开发者工具 / 真机预览）：create → ready → addBot → 掷骰仪式 → 对局
（出牌 / 吃碰杠胡 / 报杠 / 托管）→ 结算（含赣州 gz 明细）→ 下一局 → 解散；
后台切换与断网 10s 重连回座。
