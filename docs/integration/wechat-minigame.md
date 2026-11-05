# 微信小游戏端迁移记录（packages/minigame）

> 2026-11-01：新建 `packages/minigame` 实现微信**小游戏**版客户端，协议与规则零改动。
> 使用说明见 `packages/minigame/README.md`。
> ⚠️ 2026-11-05：微信小程序端（`packages/miniapp`）及其迁移方案文档已整体移除。
> 下文「小程序端机制 / 跨端同桌 / 两端逐字节一致」等均为**移植当时的历史记录**，路径与校验
> 已失效，仅作为设计决策留档；现行配置一律以 `docs/guides/setup-and-run.md` 为准。

## 1. 背景与决策

| 决策点 | 结论 | 依据 |
|---|---|---|
| 代码位置 | `packages/minigame/`，开发者工具项目根 = `packages/minigame/game` | 与当时小程序端的双层结构对齐 |
| 与小程序端的关系 | 并行实现；`utils/` 八件**逐字节复制**并由回归脚本校验一致性 | table.js 的移植原则「绘制与几何逻辑逐行保持不变」延续到第二端 |
| lib/shared | `scripts/mp_build_shared.mjs` 输出 `packages/minigame/game/lib/shared`（`npm run build:mg`） | 单一 shared 源码编译产物，防规则漂移 |
| 牌桌渲染 | table.js 跑在**离屏宿主画布**（`wx.createOffscreenCanvas({type:'2d'})`，退 `wx.createCanvas()` 第二次调用），主循环 blit 到全屏主画布 | applyBackingStore 会独占宿主画布的 width/height（1280×640×dpr）；小游戏只有一个屏上画布，还要画 chrome |
| 视觉 | 完全复刻（用户确认）：配色 / 几何常量 / CDN 素材 / 交互节奏逐项照搬 | 现有 UI 经多轮真机反馈打磨 |
| 交付范围 | 全功能对齐（用户确认）：对局核心 + 聊天/表情/日志/结算 + 重连 + 分享 | |

## 2. 平台差异 → 对位实现

| 小程序端机制 | 小游戏端实现 | 备注 |
|---|---|---|
| `Page` × 3 + `wx.redirectTo` | `src/nav.js` 场景切换，场景实例每次新建 | 保留 170/220ms 淡出淡入、跳转合并（state→game 同毫秒连发）、attach/detach 归属校验 |
| `app.js` globalData | `src/state.js` 模块级单例 | 字段一一对应 |
| SelectorQuery 量测（fitCanvas / measureCanvasBox / computeSafeInsets / syncRailTop / applyTableFrame） | `src/layout.js` 纯数学（`layout.game()`） | 画布 2:1 定尺 `min(gameMain宽−84, 行高×2)`、贴底居中；安全区走 `wx.getWindowInfo().safeArea` |
| `<canvas type="2d">` 原生组件合成层级问题（.on-modal 藏画布 / cover-view 失效 / DOM 盖不住） | **问题整体消失**：单画布自管分层，浮层直接画在牌桌之上 | syncModal / syncPanels 的 display:none 机制不再需要 |
| `<input>`（昵称 / 房间码 / 聊天） | `wx.showKeyboard/onKeyboardInput/onKeyboardConfirm/onKeyboardComplete/hideKeyboard` 单焦点管理（`src/input.js`） | 键盘回调整给的 value 是全量串（等价 bindinput）；maxlength 控件侧裁剪；无 bindpaste，但系统键盘粘贴经 onInput 全量到达，`cleanCode` 语义不受影响 |
| `scroll-view` | 触摸拖拽 + clip 自绘（日志 120 行 / 聊天 200 条 / 结算明细） | 「scroll-top +2000 触底跟随」语义 = 写 1e9 再夹取 |
| CSS keyframes（骰子翻滚/落定、页面转场） | `src/ui/dicefx.js` JS 补间（420ms 翻滚周期、第二枚 −170ms 相位、0.36s 回弹）、nav.js 遮罩 | 参数取自 app.wxss 紧凑档；骰子绘制三个抗毛边要点：**厚边用「圆角矩形下错 3px 叠画」而非 fillRect**（直角会从圆角外戳出方角）、点子渐变末端透明消硬边、落影与翻滚相位同步缩放淡出（对位 .die-shadow 关键帧） |
| 胶囊 `wx.getMenuButtonBoundingClientRect` | 特性检测；拿不到 → `safe.t + 16` 兜底轨顶、`table.capsuleRect = null`（右上铭牌贴角） | table.js 本就处理 null |
| `env(safe-area-inset-*)` 探针节点 | `wx.getWindowInfo().safeArea` 直接换算 | |
| `wx.nextTick`（setData 后量测闭环） | 不需要（纯数学布局无闭环） | |
| `onShareAppMessage`（Page） | `wx.onShareAppMessage`（按场景出标题）+ `wx.shareAppMessage`（大厅「分享房间码」点击即拉起转发面板，query 带 `room=`）+ 启动参数 `wx.getLaunchOptionsSync().query.room` 自动进房 | query 同一码只消费一次（`onShow` 会回放旧 query） |
| `wx.showModal` | 依旧不用（沿用项目「页内浮层」决策）：`src/ui/layer.js` 自绘确认框 | |
| toast（ui.js 页内 toast + 挂起队列） | `src/ui/toast.js` 全局单条队列 + `hold()/flush()`（骰子覆盖层显示期间挂起，对位 2026-10-31 报障修复） | 渲染在主循环最顶层，跨场景存活 |

## 3. 对局页（game 场景）的拆分

- **牌桌**：`utils/table.js` 原样（逻辑 1280×640、投影、hitTest、状态行、手牌入画布、
  离屏缓存全部不动）。场景每帧 `drawImage(离屏宿主 → 桌面矩形)`。
- **整屏桌面**：主画布先整铺 `uiart('table')` 贴图（兜底 `#0d1626`/`#14614a` 纯色），
  `table.frame` 用同一矩形映射（`layout.tableFrame()`）—— 两层无缝对齐的既有机制照搬。
  ⚠ **`tableFrame()` 必须传对局布局 `layout.game()`，不能让它默认用通用 `compute()`**：
  小游戏没有 DOM `.felt`，两条绘制腿（主画布整铺 + 牌桌内按 frame 画）若来源布局不同
  （顶栏 24 vs 28、横幅、操作带 34px），牌桌矩形内就会画出**错位的桌面贴图**，
  表现为「一张桌子里面又套了一张桌子」（2026-11-01 真机报障）。回归脚本已加不变量：
  整页矩形经 frame → 逻辑坐标 → 再映射回屏幕必须精确等于 `(0,0,sw,sh)`。
- **chrome**（`src/chrome.js`）：顶栏 24px（紧凑档）／侧轨 28px 圆钮（含未读红点）／
  操作带 34px（报杠胶囊 + 吃碰杠胡过 + 自摸暗杠；艺术图 = CDN 预解码位图 + 图下小注，
  未就绪回落文字钮；≥7 钮全体缩号）／记录·聊天面板／表情选择／结算面板（gz 10 列）／
  确认浮层。触摸路由：模态 > 面板 > 轨/顶栏/操作带 > 牌桌 hitTest。
- **结算/掷骰/报杠/音效/倒计时逻辑**：game.js 逐行移植（seq 去重音效、报杠 2.5s 连点锁、
  mustDiscard/declared 拦截、仪式到期重渲染、`PLAY_ACTION_EVENT` 兼容过滤）。

## 4. 与小程序端的功能差异清单

| 项 | 差异 | 原因 |
|---|---|---|
| 粘贴按钮（bindpaste） | 无独立事件；系统键盘粘贴经 onInput 全量到达 | 小游戏无 input 组件 |
| 键盘 `adjust-position` | `wx.onKeyboardHeightChange`（特性检测）拿键盘高度 → 聚焦输入行抬到键盘上沿：home 表单盖住的框内联压暗 + 悬浮重画；聊天输入行（含快捷/表情弹层）连体上移、消息区缩短；点输入区外先收键盘；重复聚焦不再拉起键盘（`src/input.js kbH()` + 消费点） | 原生 adjust-position 的画布对位 |
| `hover-class` | `pressed` 状态字段（onTouchDown 命中即按下，60ms 观感对齐） | 自绘 UI |
| 富文本滚动条 | 自绘滚动无滚动条 | 可后续加 |
| 主包体积 | 代码包约 300KB（小游戏上限 4MB） | 素材全 CDN |

## 5. 验证记录

- `npm run build:mg`：shared 产物 8 项自检通过。
- `node scripts/mg_geomcheck.cjs`（新增）：
  - 小游戏 table.js 对 4 种合成 GameView（对局/claims/结算/发牌仪式）各渲染两帧不抛错，
    手牌 14 张逐张命中、claims 期禁出、掷骰按钮防连点、结算 ▲ 回调均正确；
  - `layout.game()` 在 844×390（安全区 47）下：画布 650×325 严格 2:1、双轨不压画布、
    操作带贴画布底、overPhase 画布贴底下移、frame 映射为负、触摸换算正确；
  - config / store / dice 冒烟。
- 全部 25 个 JS 过 `node --check`。
- 真机/工具手工链路待跑：见 `packages/minigame/README.md` 末节
  （create → ready → addBot → 仪式 → 对局 → 结算 → 下一局 → 解散；后台/断网恢复）。

## 6. 「给牌留空间」版面放大（2026-11-02）

用户报「牌显示太小」。诊断：画布恒被**高度**锁死（2:1 定尺），牌小的根源是纵向预算
被 chrome 层层扣掉 + 逻辑常量在旧 DOM 时代的保守值。两层组合（预期牌面 +30%+）：

- **纵向预算**（`src/layout.js`）：顶栏 24px **并入画布背景层**（chrome 画在桌面贴图
  之上、不再占流内高度，中央状态行胶囊天然同带无冲突）→ 画布顶 = 顶栏位；
  操作带 34 → **24px**（艺术钮 24×21 / compact 20×17 同比缩）。每省 1px 高 =
  画布宽 +2px。侧轨同时取消 84px 宽度预留（按钮浮在画布两侧桌面上，贴屏幕边）。
- **逻辑常量**（两端 `table.js` 同步）：RIVER 44×58 → **52×68**（+18%，叠压比例
  75% 不变：LAP_FAR 51 / LAP_SIDE 39、侧河列距 64）；手牌 75×110 → **80×118**
  （14 张行宽 1196 ≤ 1280，允许轻压半透明角标内缘 ~16px）；锚点重解：对家河
  y156、自家河 y350（贴盘底 342+4，距手牌 ~8px）、侧河 y204（x222/798 镜像重居中）、
  上下河原点 467；中心盘 200×88@254 不变。
- **回归**：`meld.symmetry`（对称/互逆）照旧；layout 断言改为新契约（画布顶=顶栏位、
  操作带 24、overPhase 画布贴页面底且更大）；两端 table.js 逐字节一致通过。

## 7. 上下家副露列对齐修复（2026-11-02）

用户报「上下家的牌没对齐」（截图红框：左右副露列与牌河的间距不一致）。harness
实测：列顶完全对齐（都是块顶 200），但**左右列不对称 8.9px**（左列内缘距画布中心
349.4、右列 340.5）。根因两处、都在共享几何（两端同源同步修）：

1. **`meldColumnX` 尺度混用**：`riverBlockRect` 返回**投影后屏幕矩形**，左列却减
   **逻辑宽** `mm.w`(58) 而非屏幕宽 `58·k`(≈49.1) → 左列多退 8.9px。
2. **`unprojTileX` 与 projQuad rect 分支不互逆**：旧反推把目标 x 当「牌心 − w/2」，
   正向的屏幕左缘是「牌心 − (w/2)·d」，差 `(w/2)(1−d)` ≈ 4.4px（右列外扩、左列内收，
   各 4.4px）。反推式改为 `W/2 + (x + (w/2)·d − W/2)/d − w/2`，逐项互逆。

回归（`mg_geomcheck` 的 `meld.symmetry`）：同一份 melds 喂 slot1/slot3，
左右列内缘到中心差 <1px；目标位 → unprojTileX → 正向投影 roundtrip <0.5px。
两端 `utils/table.js` 保持逐字节一致（一致性断言同步通过）。

## 7b. 放大后遮挡二轮修复（2026-11-02，用户截图四处红框）

放大布局暴露四处遮挡，harness 逐项量化后修复（两端 table.js 同步）：

1. **顶角标埋进顶栏**：顶栏并入画布层后最坏占逻辑 ~43px，顶角标（y14 起）被盖
   → 锚收到 **TOP_INSET=46**（胶囊避让上限放宽到 88）。
2. **手牌压底角标**：80 宽行宽 1216，与角标横向压 16px 且纵向重叠 88px
   （上轮「半透明可接受」判断错误——牌面白底不透明）→ 手牌定 **76×112**
   （行宽 1160，x60..1220 恰让出角标内缘）。
3. **侧河块吃进中心盘 / 压上下河端头（三轮迭代）**：列距 64 时块宽 260 近缘屏
   503.6 吃进中心盘 → 列距 60；再发现上下河块加宽到 346 后侧河块（251/781）与
   上下河**逻辑重叠 32px**（用户截图红框：自家河端头被副露列压住）→ 原点外移；
   又因**两侧块 k 不同**（自家河 0.910 / 侧河 0.863），逻辑缝在屏幕上被 k 差吃掉
   （211/821 仍压 1.2px）→ 最终按屏幕约束反解 **207 / 镜像 825**，双侧屏缝 2.3。
   河牌 52×68 的放大红利保留。回归新增：侧河块与上下河块（自家/对家）横向不相交
   断言（`meld.symmetry` 内）。

## 7c. 四家铭牌统一样式与位置（2026-11-02，用户截图）

旧版顶部两家 220×54 横排大铭牌、底部两家 44×88 竖角标——两套样式，且横排与
chrome 顶栏文字同带交叠、竖标被手牌行端头压住（截图左下/右下红框）。统一为
**四家同款 44×112 竖标**贴左右边（x14..58 / x1222..1266）：

- 顶部两家（对家/上家）y=52：chrome 顶栏最坏 ~43 逻辑之下；胶囊实测更深时取
  max(52, cap.bottom+4)，上限 96；
- 底部两家（自己/下家）y=514（H−14−112）：与手牌行（x60..1220）横向缝 2；
- 与侧河块（x207..455 / 825..1073）、副露列、中心盘全部横向错开，harness 实测
  四家 tagRect 与手牌行/侧河块面积重叠均为 0；
- 五行：风位圆（庄=金底+宝倍数泡）· 昵称 · 分数 · 手牌 N · 状态（托管/掉线/
  出牌中/胡牌——112 高度新增胡牌行）。两端 table.js 同步。

## 7d. 手牌通栏置底 + 操作栏上浮（2026-11-02 四轮，用户点名）

版面重排（两端 table.js / 小游戏 layout+chrome 同步）：

- **手牌通栏**：MY_HAND **84×124 @ y512**（14 张行宽 1272，两端各 4px 占满 1280；
  屏上 844 机型手牌 ~55×81px，比初版 42×61 放大 ~30%）；底 636 留 4。
- **操作栏上浮**：吃碰杠胡/报杠/自摸栏从底部流内改**浮在画布内**（手牌上方
  逻辑 y486..510、宽 700 逻辑居中），整条随画布缩放（chrome 按 bar.h/24 比例尺
  包裹绘制）；画布因此吃满到页面底（含手牌行）。
- **中心盘上移** 254→230（drawCenter 与 drawDirectors 回合徽章同改），自家河
  y0 350→**326**（块底 ~480 ≤ 操作栏上缘 484）；对家手牌排 y34→**52**（顶栏之下）
  x 重居中 313。
- **四家铭牌贴各家手牌区**（用户点名）：对家=手牌排左边（x261..305）；上家/下家=
  手牌摞背后（x6..50 / x1230..1274，纵向随摞居中 y210..322）；自己=手牌上方左端
  （x6..50, y478..590，与操作栏/手牌都缝 ≥8）。统一 44×112 五行竖标不变。
- 回归契约更新：操作栏在画布内且水平居中、画布贴页面底；overPhase 画布几何
  恒定（操作栏已浮入画布）。两端 table.js 逐字节一致。

## 7e. 左右菜单合并为可展开菜单（2026-11-02 五轮，用户要求）

对局左右两条按钮轨（📋 | 💬🤖🎵🎯退出✕）合并为**左缘一枚 ☰**：收起只占 28×28；
点 ☰（或 ✕）展开为纵向一列（记录/聊天(+未读)/托管/音乐/表情/退出/解散[房主]），
点菜单外任意处自动收起；打开日志/聊天面板时菜单同步收起。右缘区域整体让给
牌桌与侧河。chrome `rails()` → `menu()`，状态 `GameScene.menuOpen`。

## 7f. 末张「活跃牌」浮动光效（2026-11-02，用户提供 activeCard.png）

当前打出的牌原本只有金边，感官不显眼。新增**上下浮动光效**：金框之上叠加
`activeCard.png`（18×41，1.5KB，**打进小游戏包** `assets/ui/`，零 CDN 依赖），
参照 mahiang-master 实机 GIF（用户指定效果）改为**金色水滴指针**：18×41 贴图
× 1.6 → 29×66，水平对齐末张可见段中心、尖端悬在露出带顶缘上 2px，
**720ms 周期上提 0..6 逻辑px 点动**（触牌→弹起→回落）；金边与精框保持不变。实现为**注入式**：`table.activeCardImg`
由宿主加载后注入（`GameScene.loadActiveCard`，小游戏 `createImage` 读包内
相对路径，失败静默只画金边）；两端 `table.js` 代码一致 —— 小程序端未注入
资产，行为保持旧版（只画金边）。回归 `activeCard.fx`：注入 mock 贴图后
渲染生效且不抛错。

## 7g. 区域所有制 + 横排铭牌 + 操作栏原生尺寸（2026-11-03，用户红框）

- **区域所有制**（用户：先划区互不占用）：旧版自/对副露行「压河块末行 43/62px」
  是刻意 z 序，放大后刺眼（用户报重叠）。新契约（逻辑坐标）：
  自家副露带 y438..500 × x825..1240（右侧河块之下/自家河之右/手牌之上）；
  对家副露带 y124..186 × x825..1214（对家手排之下/对家河之右/右侧河块之上）；
  均右缘锚定向左生长、容量 3 组标准，≥4 组整行 0.72 紧凑（`_meldScale`）。
  牌河/手牌/侧河/副露柱各归其带，互不侵入。
- **铭牌横排**（用户红框）：自己 190×54 @ [104,446]（手牌上方左端红框位）、
  对家 190×54 @ 手牌排右侧（x=排右缘+8，胶囊左缘 −8 收排）；上下家维持竖标
  44×112（手牌摞背后）。横排内容：风位圆(+宝泡)·昵称·分数·手牌 N·状态。
- **操作栏原生尺寸**（用户报按钮太小）：操作栏从「画布逻辑缩放」改**屏幕原生
  34px 高**（宽 min(560, 行宽)），按钮 34×29 艺术图原尺寸绘制，位置=手牌顶之上
  4px 居中。两端 table.js 同步。

## 8a. 启动黑屏排查（2026-11-03）

黑屏根因：语音接入时 `main.js` 调了 `voice.setClient('mg')`，但 `setClient` 实际在
**wxauth.js**（voice.js 未导出该方法）→ 模块加载期 TypeError → main.js 整体失败、
主循环未启动。修复：改调 `wxauth.setClient('mg')` 并补 require。两道防线防复发：
① main.js 启动段 try/catch + `wx.onError/onUnhandledRejection` 采集；② 主循环
帧末把最近错误以红字屏显（前 3 行）—— 启动异常永远可见，不再黑屏静默。
另：Node 侧启动模拟（严格 wx Proxy）已跑通 BOOT OK + 3 帧渲染。

> 注：项目内 `utils/voice.js` / `utils/wxauth.js` / chrome 语音钮为语音功能接入
> （小游戏 VoIP：join/leave/mic/说话人事件），签名走 `/api/wx/voipsig`（client=mg）。

## 7h. 铭牌/手牌/副露四轮微调（2026-11-03，用户点名）

- **对家铭牌遮挡手牌**：铭牌锚从「排首 + 13×步距 + 8」漏加了末张宽 → 改
  `hs2.x + 13*step + hs2.w + 8`（排右缘 + 8）；
- **对家手牌缩小**：48×66/步距43 → **40×55/步距36**（排宽 607→508，居中
  x386..894），给桌面牌与铭牌腾位；
- **副露左右手位**（用户点名，各自视角）：自己 = **自己左手边 = 屏幕左**
  （x60 向右长、≤461 自家河左界外）；对家 = **对家左手边 = 屏幕右**
  （x1214 向左长、≥825 对家河右界外）。容量 3 组标准、≥4 组整行 0.72 紧凑；
- **自己铭牌让位**：横排 190×54 挪**手牌上方右端**（x1050..1240 —— 左带让给
  副露；与右副露柱/手牌 y 错开）；
- **操作栏中心带**：x 锚改画布逻辑 465..1025（左右手牌/副露带之间的自由带），
  宽 560·sc 屏 px —— 844~1204 全尺寸 7 钮（294 屏 px）均放得下，不再压副露带。
- 两端 table.js 同步；boot 模拟 + 回归全绿。

## 7i. 铭牌左置 + 副露避让手牌摞（2026-11-03 二轮）

- **对家铭牌 → 手牌排左侧**（用户：不能遮挡手牌）：x = 排左缘 − 8 − 190 =
  188..378（y52..106）；与副露柱/上家竖标（y204 起）纵向错开；去掉旧
  `max(825,…)` 残留钳制（正是它把铭牌拉回手排上）。
- **副露避让上下家手牌摞**（摞 x56..86 / 1194..1224 × y77..458）：
  ① 摞体上移 y77→**54**（列底 435）；② 自家副露带左界 60→**94**（摞右缘 +8）、
  对家副露带右界 1214→**1186**（摞左缘 −8）；③ 带宽不足时**整行动态等比收紧**
  （`_meldScale = clamp((avail−gaps)/total, 0.6, 1)`，替换固定 0.72 档）。
  终验（4 组满载压力）：对家铭牌 188..378 不遮手排 ✓；自/对副露带与左右摞、
  对家手排零相交 ✓。两端 table.js 同步。

## 7j. 宽桌适配：河 2 行 + 副露带加宽 + 侧柱压缩（2026-11-03，用户「左右更宽上下更短」）

- **上下河 3 行 → 2 行**（cap 14，溢出压末格）：自家河块底 481→434、对家河块顶
  91→112 —— 中部透气、副露带随之校准；整局人均弃牌 ~14-16，Late-game 末格叠
  2~3 张由 riverCell 兜底；
- **自己副露带复核回退**：曾试右扩 x94..528，实测与操作栏（中心带 x465..1025 ×
  y445..507）双重叠 → 回退 **x94..459**（x 分离是唯一干净解：副露带与操作栏纵向
  恒共带）。带宽不足由动态 _meldScale 收排（3 组 ≈0.9、4 组 ≈0.68）；
- **对家副露带维持** x825..1186（对家河 2 行块顶 112 与带 124..186 纵向重叠，
  x 不可 <813+12——河块占位所致）；
- **上下家副露柱动态压缩**（用户「压缩高度」）：柱带 y204..435（摞底 435 与自家
  副露带 438 之间），≥2 组即整行等比收紧（_meldScale 下限 0.6）—— 柱不再撑到
  y547 压向手牌带；
- 两端 table.js 同步；boot 模拟 + 回归全绿（对称/互逆、侧河不相交、手牌命中）。

## 7k. 结算相位遮挡修复（2026-11-03 二轮，用户截图两红框）

两框同根因：**上下家副露柱满载 4 组向下越界到 y464**（动态收紧加入前的旧状态）——
左框=上家柱压自己副露带区、右框=下家柱被自己铭牌压。修复（两端同步）：

1. **侧柱带底钳制 630 → 435**（摞底与自家副露带之间）：动态收紧是主手段
   （4 组收进 ~288），钳制兜极端；
2. **自己铭牌结算下移**：over 相位 y446 → **508**（副露带 438..500 之下、自己
   摊牌排 552 之上，x 1050..1240 与摊牌 334..946 横向错开）；对局中维持 446。

排查插曲：Node 实测侧柱底 531 为测量伪影（hook 装在 metrics 重置后）——

框架内追踪确认 `_meldScale=0.6/h=31.2` 生效、真实底缘 ~288。另：utils/config.js
的 DEFAULT_WSS 允许两端各自切本地/线上（联调有意差异），一致性断言对该行归一。

## 8. 大厅表头胶囊避让（2026-11-02）

用户报「分享房间码被小程序胶囊压住无法点击」：lobby 表头右侧控件原来贴屏幕右缘，
正好落进胶囊（⋯ ○，约 87×32 @ 右上）带。修复：表头右侧可点控件以**胶囊左缘 − 8**
为右界（分享钮贴胶囊左侧收排、「我的信息」文本让位），拿不到胶囊 API 退旧行为。
game 场景顶栏（chrome `capRight`）与对局侧轨此前已按同一接口避让；回归新增
`lobby.capsule` 断言（分享钮右缘 ≤ 胶囊左缘 − 8）。

## 9. CDN 资源预热与「原子换装」（2026-11-02）

用户报「资源加载慢时先显示兜底样式、到位后闪回来，感官不友好」。两层处置：

- **启动预热**（`src/preload.js`，main.js 在 boot 首场景前调 `warmup()`）：
  tiles / uiart / sound 三份清单**冷启动即并发拉取**（原来等进对局页才拉，首页/大厅
  那几秒在空转），位图拿到清单立即预解码。utils 三模块自带 7 天 storage 缓存 +
  「先缓存后网络」+ inflight 去重，warmup 幂等。`progress()` 暴露就绪度供排查。
- **原子换装**（`GameScene.loadTileArt`）：牌面 / 平放图集 / UI 贴图三通道汇到一个
  闸门，**全部 settle 后只重绘一次**——要么全套贴图、要么全套兜底，杜绝
  「桌布换了牌面没换」的中间态闪换。

图片宿主适配（`imageHost`：画布自带 createImage → 全局 wx.createImage → null）
收敛在 preload.js，GameScene 引用同一份，防两处逻辑漂移。

## 9. 后续可选项

- 平板/大窗布局档（对位 rpx 档）。
- 小游戏专属资产（如需要：包内预置首屏桌面图，省 CDN 首帧）。
- 若 table.js 端侧需分叉（不建议），把一致性校验从「逐字节」降级为「几何断言」。

## 10. 四套语音包 + 画布版声音设置面板（2026-11-04）

小游戏端补齐了「音频第二通道 + 统一设置菜单」。与小程序端的分工：

| 层 | 小程序 | 小游戏 | 是否共用 |
|---|---|---|---|
| 音频/设置**逻辑** | `utils/sound.js`、`utils/settings.js` | 同两个文件（**逐字节一致**） | ✅ |
| 设置**界面** | `templates/settings.wxml` + `.set-*` | `src/ui/settingspanel.js`（canvas 自绘） | ❌ 平台必然 |

### 10.1 逻辑层（本轮之前已就位，此处只记要点）

`require('../utils/settings.js')` 放在 **`src/main.js`** 的启动路径上（只取副作用）：
模块加载即读 `mj-settings`、迁移旧键、向 `sound.js` 下发偏好 —— 保证**第一声之前**就生效。
局内动作音效全部走 `sound.playAction(kind)`，兜底链为
**当前包 → 默认包(n2) → 原音效 → 无声**，两端同一份实现。

### 10.2 面板：为什么是独立模块

`src/ui/settingspanel.js` 不塞进 `chrome.js`：chrome 是**对局页**的 chrome，
而面板 **game / lobby / home 三个场景都要**；塞进去会让 lobby/home 反向依赖对局页 UI。

两个刻意的设计：

- **布局是纯函数**（`layout(L)`，不读 ctx、不量文本）。命中矩形每次现算、不缓存到 `s.ui`。
  项目里踩过「浮层按钮矩形跨帧残留 → 看不见的按钮劫持点击」（chrome.js `u.layerBtns`
  那段注释），纯布局从根上不会产生陈旧矩形。代价：面板内文字一律定宽排版，不按文本自适应。
- **值的真相源是 `utils/settings.js`**，面板不存副本。拖动滑条时用临时 `s._setDrag`
  覆盖显示（否则滑条在手里「弹回旧位置」），**松手才落盘** —— 与小程序端
  `bindchanging`/`bindchange` 的分工一一对应（拖动会连发几十次事件，逐次写存储既浪费又可能写坏）。

### 10.3 接入约定（三场景一致）

每个场景七个钩子，缺一不可（静态检查脚本已固化）：

| 钩子 | 作用 | 漏了会怎样 |
|---|---|---|
| `constructor` 置 `settingsShown=false` | 状态位 | 面板永不出现 |
| `onTouchDown` → `panel.down` | 按下/滑条跳值 | 按钮无按压反馈、滑条不跟手 |
| `onTouchMove` → `panel.move` | 拖动 | **只有按下那一下生效**（home 原本没有这个钩子，本轮补上） |
| `onTouchUp` / `onTouchCancel` → `panel.up` | 落盘 | 拖完不保存 |
| `onTap` → `panel.tap` | 分发 | 点不动 |
| `render` 末尾 → `panel.render` | 绘制 | 看不见 |

顺序铁律：**面板先于 chrome/dice 判定**，且**最后绘制** —— 两者必须对称，
否则出现「点得到但看不见 / 看得见点不到」。

入口：game = ☰ 菜单里的 ⚙️（**取代原 🎵 单钮** —— 那个只能切 BGM，音量/音效/语音包都没入口）；
lobby = 表头房间码右侧 ⚙️（右侧胶囊带已被分享/语音占满）；home = 步骤条行右端 ⚙️
（底部那行已被「背景 + 四档」占满）。

### 10.4 版式

卡片宽 `min(sw-24, 520)`，内容固定块高：标题 24 + 四行 30×4 + 分隔 8 + 音色块 48 +
（可选）提示行 14 + 底栏 30 + 内边距 24 ≈ **260~274px**。
最小横屏 740×320 实测仍完整落在屏内（不等高视口不缩放，靠内容本身足够矮）。
`⚙️` 画在 canvas 上是**单色齿轮**（文字默认符号），实测清晰可辨。

### 10.5 验证

`.recover-tmp/mg_setpanel.mjs` —— 把**真实模块源码**塞进 Chromium 用**真 canvas 2D** 绘制，
**60 断言**全过：4 档横屏视口（812×375 / 667×375 / 896×414 / 740×320）不溢出、控件互不重叠、
9 个控制点命中正确；总开关翻转/切音色即试听/滑条按下跳值/拖动跟手/**拖动不落盘、松手才落盘**/
关闭后 `down` 返回 false（不再吞触摸）；缺条提示与「总开关关」提示的优先级；
以及「☰ 菜单里确实有 ⚙️、旧 🎵 已移除、点它被消费并打开面板」。

**未覆盖**：真机手势与真解码播放（本轮验证止于绘制与状态机）。

### 10.6 掷骰音效（2026-11-04）

与小程序端同一条 `dice` 音效（清单 v5）。**接线点只有一处**：`src/ui/dicefx.js` 的 `run()` ——
对局与大厅都走它，所以不必像小程序端那样在 `playDice` / `runDiceAnim` 各写一次。
素材处理与体积取舍见 `scripts/gen_sound_dice.mjs`。

## 11. 首页 ⚙️ 被微信胶囊遮挡（2026-11-04，用户截图报障）

**现象**：小游戏首页设置钮只剩半边露在胶囊（⋯ ●）左侧，点不到也看不全。

**根因**：`scenes/home.js` 里 `u.btnSettings.x = ix + iw - 24` —— 贴着 `.home-card` 右上角，
而步骤条那一行的 y 正好落在胶囊带内。lobby 的 ⚙️ 放在表头**左侧**（房间码之后）、
game 的 ⚙️ 在**左轨菜单**里，两者都不受影响；只有首页走了右上角。

**为什么不用「量胶囊再避让」当主方案**：`layout.capsuleRect()` 走
`wx.getMenuButtonBoundingClientRect()`，layout.js 自己的注释就写了「小游戏没有文档保证的
胶囊 API，拿不到返回 null」。lobby 表头那段 `headerRight = cap.left - 8 : padR` 的退化分支
在 API 缺失时同样会退回右缘 —— 不能把可点控件的安全性押在这个 API 上。

**改法**：把 ⚙️ 从卡片右缘移到**最后一枚步骤胶囊之后**（`sx + 8`，sx 是循环排布游标，
已含 8px 余量 → 实际间隔 16px）。步骤条只占 2~3 枚胶囊（约 260~320px），之后恒有大片空白，
按钮永远落在屏幕左/中部，**与胶囊是否存在、在哪儿都无关**。另外保留
`Math.min(afterSteps, cap.left - 8 - 24)` 作为极窄屏的二道保险。

**顺带修**：`btn.render` 的 `maxW = w-12` 把 24px 方钮里的 ⚙️ 截成「⚙…」（与设置面板
关闭钮「✕…」同一个坑）。新增 `btn.icon()` 原语（不截断、整字形居中的图标方钮），
首页 ⚙️ / 大厅 ⚙️ / 设置面板 ✕ 三处统一走它。

**验证**：`.recover-tmp/home_capsule.mjs` 用真实 home.js + 真 canvas 渲染 6 档视口
（812×375 / 667×375 / 568×320 / 896×414 / 1024×768 / **胶囊 API 返回 null**），
断言「不与胶囊重叠 / 不压最后一枚步骤胶囊 / 完整在屏内 / 无 API 时仍不在右上角」→ **19/19**。
`mg_setpanel` 60/60、settingscheck 31/31、他人动作音效、typecheck 全绿。
截图 `.recover-tmp/home-cap-*.png`。

**口径**：小游戏端**任何常驻可点控件都不要放在右上角**；胶囊 API 只配当二道保险，
不能当唯一依据。小程序端 home/lobby 是默认导航栏（胶囊在原生导航条内）、
game 页右轨有 `syncRailTop` + railtop 守护，均无此问题。

## 12. 对局合并菜单移除「互动 / 退出 / 解散」三枚（2026-11-04，用户截图报障）

**现象**：对局场景 ☰ 展开后列表末尾三枚钮（🎯 互动 / 退出 / ✕ 解散）多余，用户要求取消，
理由：互动改由点头像、退出解散由左上角 ‹ 承担。

**核对（用户要求「重新核对左上角退出按钮功能」）—— 四枚钮真实语义**：

| 钮 | 入口 | 调用 | 真实语义 |
|---|---|---|---|
| 顶栏 ‹（左上角） | backBtn | `onAbort()` | **解散对局**：强制结束本局、全员回大厅（房间保留、可重开）。**不是**退房、也不是解散房间 |
| 菜单🎯 互动 | menuEmote | `onEmoteOpen()` → `openEmotePicker()` | 互动表情选择器；**但 `table.onTagClick` 已接到 `openEmotePicker(seat)`**（game.js:235），点头像即等价 → 冗余 |
| 菜单退出 | menuExit | `onExit()` → `nav.exitGame()`+`navigate('home')` | **退出本局且直接退房回首页**（座位交托管打完）；这是唯一的「一步退房」入口 |
| 菜单✕ 解散 | menuAbort | `onAbort()` | 与左上角 ‹ **完全相同**（解散对局）→ 冗余 |

**结论**：用户「左上角已覆盖退出/解散」的判断**只对一半** ——
- 解散对局：左上角 ‹ 确实覆盖（菜单✕ 纯冗余，删之无害）；
- 退出房间（一步退房）：**左上角 ‹ 并不做**；唯一入口是菜单「退出」，删掉后只剩「‹→大厅→离开房间」两步。
  （`menuAbort` 文案写「解散」实为「解散对局」而非「解散房间」，别被字面骗。）

**改动**（`src/chrome.js`）：菜单 `btns` 只留 `menuLog/menuChat/menuAuto(?)/menuSettings`，
删 `menuEmote/menuExit/menuAbort` 三行的 push；`tap()` 里对应的三条 `if (mb.xxx && …)` 分支一并删（均带
`&&` 守卫，删后无空引用）。`onExit/onExitConfirm/onEmoteOpen` 在 game.js 成为死代码但保留
（顶栏若日后升级为「统一出口」可直接复用 `onExit`）。

**验证**：`.recover-tmp/chrome_menu.mjs` 真加载 `chrome.js`+`draw`/`btn`/`layer`，三档视口（含胶囊 API=null）
展开菜单后断言 `menuBtns` 仅含 `menuLog/menuChat/menuSettings`、不含三枚 → **15/15**；
`node --check` chrome.js/game.js 通过；minigame 31 个 js 全部可解析。

**同构提示**：小程序 `pages/game/game.wxml:92-95` 右轨是**完全相同**的三枚（🎯/退出/✕）+ 左上角返回
`onAbort`，结构与本改动一一对应。若要保持两端一致，可在小程序端做同款移除（但小程序点头像触发表情
需另接 DOM 事件，非 1:1）。

## 13. 点自己铭牌弹快捷聊天（2026-11-04，用户要求）

**需求**：点自己的铭牌 → 弹出快捷对话，直接点预设短语即发聊天；点别人铭牌维持互动表情。

**实现**（`scenes/game.js`）：
- `initCanvas` 里的 `table.onTagClick` 路由改为：
  `seat === this.view.mySeat → openQuickChat()`，否则 `openEmotePicker(seat)`。
  座位号来自 `table.hitTest` 的 `(this.view.mySeat + slot) % 4`（绝对座位），与场景
  `this.view.mySeat` 同源，判定成立；`seat !== mySeat` 分支仍把绝对 seat 传给 openEmotePicker，与改动前一致。
- 新增 `openQuickChat()`：与 `onToggleChat` 同语义但**强制展开** `quickShown`
  （onToggleChat 开面板时 quickShown=false，还要再点输入框旁 💬 才出短语；这里一步到位）。
  预设短语取自 `CHAT_QUICK`（8 条：`快点啊 / 胡了！🎉 / 不好意思 / 等一下 / 这把稳了 / 笑死😂 / 加油 / 别急`）。
  点短语走既有 `onChatChip` → `nav.send({t:'chat'})`，无需键盘。
- 加 `if (!this.view) return;` 守空 view（牌局未就绪时铭牌区不响应）。

**验证**：`.recover-tmp/game_tagclick.mjs` 真加载 `game.js`（版式依赖打桩）+ 跑 `initCanvas` 捕获真实
`onTagClick` 闭包，自/他/空 view 三档触发 → **13/13**（自己→chatOpen+quickShown、别人→emoteShown+
emoteTargetSeat、空 view 不崩）；`node --check` 通过；minigame 31 个 js 全部可解析；菜单探针复跑 15/15。

**同构提示**：小程序端目前铭牌（座位）是否触发表情/聊天需另接 DOM 事件，非 1:1；如需两端一致再议。

## 14. 头像（2026-11-04，用户要求）

**需求**：① 无头像用户随机显示头像；② 有头像用户按自己设置的头像显示；③ 用户可设置头像且实时生效。
**范围**：用户随后明确 —— 头像选择器放在「创建/加入房间前的昵称表单」上，**不放设置面板**，**只改小游戏端**。

### 14.1 资源与协议

- **头像集**：`packages/server/public/avatars/a01.png … a39.png`（120×120 PNG，圆角透明）。
  源图在 `E:/86187/下载/新建文件夹/`（avif / webp / jpg / png 混装）。**微信 canvas 对 avif 支持不稳**，
  故用 `node scripts/gen_avatars.mjs`（Chromium 解码 → cover 裁剪 → 重编码 PNG）转换 —— 见 14.6。
- **不进代码包**，与牌面/UI/音效同套路：
  - `GET /api/avatars` → `{ version, base, avatars: ['a01', …] }`（`no-cache`，抬 `MAHJONG_AVATAR_VER` 即失效）；
  - `GET /avatars/aNN.png` → 200 + `image/png` + `max-age=31536000, immutable`；
    **只认 `a\d{2,3}\.png`**（挡目录穿越与任意后缀，`/avatars/xx.png`、`/avatars/%2e%2e%2f…` 一律 404）。
- **服务端字段**：`Player.avatar`（座位级）、`SeatPlayer.avatar`（大厅广播）、`GameView.avatars`（局内广播，4 项数组）。
  `ClientMsg` 的 `create` / `join` 均可带 `avatar?: string`。

### 14.2 头像分配规则（服务端 `packages/server/src/index.ts`）

- `cleanAvatar(raw)`：非空且在头像池内才认，否则返回 `''`（**非法串不放行**）。
- `deriveAvatar(pid)`：**按 pid 哈希的确定性随机** —— 同一 pid 永远分到同一张，
  避免「每次刷新换脸」，也保证**所有客户端看到同一张**（不能各端自己随机）。
- `resolveAvatar(p)` = 选定的 id，否则按 pid 确定性随机。
- `create` / `join` 收到合法 `avatar` 就原样存；收到空串或非法 id → 一律走 `deriveAvatar`。
  机器人无 pid → 随机一张。

### 14.3 小游戏端

- **新增 `utils/avatarart.js`**（对标 `utils/uiart.js`）：`ensure/list/urlOf/art/preload`，
  清单缓存 7 天 + 后台校验版本；`art(id)` 返回画布位图，取不到返回 `null`（调用方回退）。
- **预热**：`src/preload.js` 的 `warmup()` 增加第 ⑥ 通道（清单 + 全部位图预解码，39 张 ~1.4MB）。
  `scenes/game.js` 的 `loadTileArt()` 把 pending 由 2 提到 **3**，头像作为**第三个通道并入原子换装闸门**
  —— 避免「桌布换了牌面没换」式中间态重演。`scenes/home.js` / `scenes/lobby.js` 进场景时也 ensure + preload。
- **昵称表单内的选择器**（`scenes/home.js`，本轮核心）：
  - 表单步重排为：**chips → 昵称 → 头像网格 →（房间码）→ 上一步/创建**。按钮行**钉在底部**
    （`yBtn = footY - 12 - 34`），房间码贴按钮上方，头像网格占中间剩余高度。
  - 网格：**首格「🎲 随机」**（选中 = 空串 → 服务端随机分配）+ 全部头像（39 张），圆形缩略图，
    10 列 × 3 行（列数按表单宽算），选中格金边。
  - **可滚动**：内容超出视口时裁剪 + 右侧滚动条；`avatarScroll` 夹在 `[0, maxScroll]`。
  - **手势**：`onTouchDown` 落在网格内 → 记 `avatarDrag{lastY,moved}`；`onTouchMove` 按位移滚动；
    `onTap` 消费 `avatarDrag` —— **位移过 = 滚动不选中；未位移 = 选中该格**。
    （`input.js` 的派发顺序是 down → up → **tap**，所以 `avatarDrag` 必须在 `onTap` 里读、不能在 `onTouchUp` 里清。）
  - 选中即 `store.set(store.KEYS.avatar, id)`（键 `mj-avatar`）；`onSubmit` 把 `avatar` 带上
    （`{t:'join'|'create', …, avatar: this.avatar}`）→ **进房即生效，无需重启**。
  - 进表单步时 `avatarart.ensure + preload`，位图解码完下一帧自动补画（主循环每帧重绘）。
- **牌桌铭牌**（`utils/table.js` `drawTag`）：新增 `drawAvatarOrWind(ctx, id, cx, cy, r, dealer, windChar)`，
  横排（自己/对家）与竖排（上/下家）两处的**风位圆原位**改画头像（尺寸仍是原风位圆直径 34 / 26）。
  - 头像到位后**风位仍可辨识**：右下角压一枚小风位角标（庄家金底金边，普通黑底金字）。
  - 庄家头像走**亮金边** `#f6e3a1`，普通头像浅白边。
  - **回退**：无头像 / `view.avatars` 缺失（老服务端）/ 非法 id / 位图未解码 → 画回原风位圆，绝不白板。
- **大厅座位卡**（`scenes/lobby.js`）：卡片右上角画 26px 圆形头像（空位/未选画空心圆占位）；
  闭麦 🔇 角标左移 30px 避让；昵称行的 `maxW` 相应收窄 32px。

### 14.4 两端一致性约束（重要）

移植当时 `packages/minigame/game/utils/*.js` 与小程序端 `utils/*.js` 曾是**逐字节相同的两份拷贝**
（`scripts/mg_geomcheck.cjs` 第 0 步硬校验，10 个文件）。本次给 `store.js` 加了 `avatar` 键，
（该同步约束随小程序端移除而失效，此处仅留档。）
`avatarart.js` 是小游戏端**新增**文件，不在该比对清单内，无需同步。

### 14.5 验证

- `scripts/gen_avatars.mjs`：12 张（webp+avif 混装）→ PNG 全成功；重复运行幂等（12 张全部跳过）；
  产物 39 张全部通过 PNG magic + 120×120 尺寸校验；dHash 查重**无近似重复**。
- `.recover-tmp/avatar_probe.mjs`（**24/24**）：清单项数 = 实读目录数（动态）/ id 形如 `aNN`（两位或三位）且连续有序；
  静态资源 200 + `image/png` + PNG magic；路径穿越与非法后缀 404；
  `create` 带 `avatar=a05` 原样生效；不带 → 按 pid 随机；非法串 → 退回随机；
  **同 pid 离座重进 → 同一张头像**（确定性）；开局后 `view.avatars` 为 4 项字符串数组。
- `.recover-tmp/avatar_picker_probe.mjs`（**80/80**，5 档视口 812×375 / 667×375 / 568×320 / 896×414 / 1024×768）：
  网格 40 格（1 随机 + 39 头像）、完整落屏、**不与昵称框/房间码框/两个按钮重叠**、网格顶底不倒挂；
  点格选中并持久化、点「🎲 随机」清空、拖动滚动且不误选；`join`/`create` 消息**均带 avatar**。
- `.recover-tmp/table_avatar_probe.cjs`（**19/19**，Node mock ctx）：横排头像 34×34 落在风位圆原位、
  竖排 26×26、画的是**该座位**的位图、风位角标仍画「东」、无头像/无 `view.avatars`/非法 id 三种回退
  均不画头像图且不抛异常、庄家亮金边 vs 非庄家浅白边。
- `.recover-tmp/avatar_nameplate_shot.mjs`：出效果图 `.recover-tmp/nameplate-avatar.png`（旧 id）/
  `.recover-tmp/nameplate-new.png`（新 id a30/a34/a37/a39）—— 真 table.js + 真头像 PNG 渲染四角铭牌，**只出图不断言**。
- `.recover-tmp/avatar_picker_shot.mjs`：出真图选择器效果图 `.recover-tmp/avatar-picker-real.png`（39 张真头像，**只出图不断言**）。
- `.recover-tmp/avatar_gate_probe.mjs`（**13/13**）：头像通道超时兜底 —— 闸门只放行一次；
  未超时 → 无补画重绘；超时 → 仍放行一次（牌桌不卡住）+ 后到的头像触发补画。
- `.recover-tmp/avatar_sheet.mjs` / `.recover-tmp/avatar_dup.mjs`：39 张总览图 + dHash 查重（无近似重复）。
- `.recover-tmp/bot_avatar_probe.mjs`（**14/14**）：机器人头像 —— 大厅非空且合法、机器人之间互不相同、
  刷新不换脸、跨房间稳定、局内 `view.avatars` 非空（不回落风位圆）、同桌不撞脸、40 房间压力零撞脸。
- `.recover-tmp/avatar_stability_probe.mjs`（**5/5**）：稳定性语义边界 —— 自选头像跨房间绝对稳定、
  未选用户同桌构成不变时稳定、加人时可能换脸、机器人与人类零撞脸。
- `.recover-tmp/lobby_bot_shot.cjs`：出大厅效果图 `.recover-tmp/lobby-bots.png`（真服务端 + 真 lobby.js + 真头像，
  4 座各一张不同的脸：房主 a05 + 机器人 a02/a03/a04）。
- `.recover-tmp/table_banker_probe.cjs`（**15/15**，Node mock ctx）：庄标 —— 横排画位图、非庄家不画、
  完全落在铭牌矩形内、竖排走矢量金底「庄」字、无头像回退风位圆时**仍画**、位图缺失回落矢量。
- `.recover-tmp/banker_pix_probe.mjs`（**像素实证**，真 canvas + `getImageData` 采样）：
  竖排庄标底色 `rgb(230,193,75)` = #e6c14b（矢量金底、**未画** banker 位图）；
  横排庄标为 16×16 位图 at (1095.1,453.1)。⚠ 颜色判定**必须采样**，肉眼会看错。
- `.recover-tmp/avatar_nameplate_shot.mjs`：出效果图 —— `DEALER=1 OUT=…/nameplate-vert.png` 出竖排庄标，
  `DEALER=0 OUT=…/nameplate-row.png` 出横排庄标（真 table.js + 真头像 PNG + 真 banker.webp，**只出图不断言**）。
- 回归：`npx tsc --noEmit` 通过；`node --check` 全部改动文件通过；
  `mg_geomcheck.cjs` **全部通过**（含两端 utils 逐字节一致性，`sound.js` 漂移本轮已不复现）；
  `scripts/verify/geomcheck.cjs` 的 290 处 `drawRivers 相邻两排遮挡` 失败**为既有问题**
  （把本次 table.js 改动整段还原后仍是 290，与头像无关）；
  `game_tagclick.mjs` 13/13、`chrome_menu.mjs` 15/15、`home_capsule.mjs` 19/19、`mg_outside_close.mjs` 64/64 全绿
  （后两者需为新增的 `utils/avatarart.js` / `src/preload.js` 补桩）；
  `mg_setpanel.mjs` 72/72、`mg_outbgm.mjs` 55/55、`settingscheck.mjs` 31/31、`actionsound_probe.mjs` 全绿。

### 14.6 增量追加头像（2026-11-04 第二批）

用户又提供了一批头像（12 个：6 webp + 6 avif，哈希命名）到同一源目录。
⚠ **源目录里的文件会被整体替换**（第一批的 27 个 avif 已被删除），所以**绝不能重跑旧脚本** ——
旧脚本按文件名排序依次编号 a01..aNN，会**整体重排编号** → 已在用 `a05`/`a17` 的玩家
选中项静默变成另一个人。

**永久脚本**：`scripts/gen_avatars.mjs`（放 `scripts/` 而非 `.recover-tmp/` —— 后者被 gitignore，会丢）。
- 支持 **avif / webp / jpg / jpeg / png** 混装；Chromium 解码 → cover 裁剪 → 120×120 PNG。
- **只增不重排**：既有 `aNN.png` 永不重写、永不重编号；新源文件**追加**到当前最大编号之后
  （本批 a28 → a39，共 39 张）。
- **映射表** `scripts/avatar-map.json`（源文件名 → id）：重复跑同一批源文件**不会重复分配、不会换号**；
  源文件删掉后再加回来会分到新 id（旧图仍在池里，属正常）。
- `--force` 会忽略映射重转已存在的源文件（**慎用：会换图**）。
- 用法：`node scripts/gen_avatars.mjs [源目录]`（默认 `E:/86187/下载/新建文件夹`）。

**服务端改动**（`packages/server/src/index.ts`）：
- 头像池过滤与 `/avatars/` 路由守卫的正则由 `a\d{2}` 放宽为 **`a\d{2,3}`**（否则第 100 张起访问不到）。
- 池排序改为**按数值**（`.sort((x,y)=>Number(x.slice(1))-Number(y.slice(1))`）——
  字符串排序会让 `a100` 排在 `a39` 前面（"1"<"3"）。
- **版本号两处抬到 `v2`**：代码 `AVATAR_VER` 默认值 + `mahjong.config.json` 的 `avatarVer`（配置优先），
  否则客户端 7 天缓存的旧清单不会拿到新增的 id。

### 14.7 头像通道超时兜底（2026-11-04，池子扩到 39 张后加的）

头像排在 `scenes/game.js` 的**原子换装闸门**上 → 池子变大（27→39，约 1.4MB）后，弱网下
牌桌首帧会被拖住。而头像是**装饰**（缺失有风位圆兜底），本不该阻塞牌桌可用性。

- `AVATAR_GATE_MS = 2500`（`scenes/game.js"）：头像位图超时就**先放行闸门**（铭牌画风位圆），
  后到的头像**逐张补画**。
- `settled`（闸门幂等，只放行一次）与 `timedOut`（区分「超时放行」与「正常完成」）**分开两个标志**：
  补画条件用 `timedOut`，否则正常完成时也会多余重绘一次。
- `utils/avatarart.js` 的 `preload(canvasNode, ids, onDone, onEach)` 新增可选 `onEach` 逐张回调。


### 14.8 机器人也有头像（2026-11-04，用户问「添加的机器人没有头像吗」）

**原来确实没有**，两个缺陷叠在一起：

1. `addBot` 的 `room.players.push` **根本没设 `avatar` 字段** → 机器人 avatar 恒 undefined；
2. `broadcastGame` 取的是**原始** `p.avatar ?? ''`（不是 resolveAvatar）
   → 局内机器人是空串 → 铭牌**回退风位圆**（大厅有脸、局内没脸，两处不一致）。

**修法**：

- 机器人按**座位号**派生头像（`pickFreeAvatar(seat, takenAvatars(room))`）：
  不能走 `deriveAvatar(pid)` —— 机器人 pid 恒为空串，会落到 `Math.random()` 分支
  → **每次刷新大厅就换一张脸**；也不能按房间码派生（房间重建后换脸）。
  座位号 0~3 固定 → 同一房间同一座位永远是同一张脸，各端一致。
- `broadcastGame` 改用与大厅**同一份** `roomAvatars(room)` → 两处绝不打架。

**⚠ 顺带修了一个更隐蔽的撞脸问题**：

人类按 pid 哈希、机器人按座位号，两套独立分配都会**均匀铺满整个池**
（实测每 id ≈ 2.56%）→ 一桌 3 人类 + 1 机器人有约 **21%** 概率出现「两个人长得一样」。

解法：`roomAvatars(room)` **整房一次算完**（按座位顺序、互相避让）：

- 第一轮落「已确定」的（玩家自选 + 入座时已派生的）；
- 第二轮才对还没定的派生，并**沿池顺延到第一个空闲位**。
- ⚠ 必须**整房一次算**而不是逐人算：逐人算「避开同桌」会让两个都没定的玩家**互相避开对方**
  → 各自算出同一张，房间内外不一致。
- 池够大（4 人 vs 39 张）时几乎不会绕回。

**语义优先级**（探针 `.recover-tmp/avatar_stability_probe.mjs` 实测）：

| 场景 | 结果 |
|---|---|
| **自选头像** | **绝对稳定** —— 跨房间、跨同桌都原样生效（用户自己的选择，最高优先级） |
| 未选 + 同桌构成不变 | 稳定（入座那一刻派生完就固定，之后加人也不变） |
| 未选 + 同桌后来加入新玩家 | 可能换脸（避让的代价，让位给新来者） |
| 机器人 vs 人类 | **绝不撞脸**（40 房间压力测试零撞脸） |


### 14.9 庄标补回（2026-11-04，用户问「铭牌上本来庄家有个『庄』的图标为啥没有了」）

**根因**：`104bfdc`（移除 web 客户端那次重构）把 `drawTag` 里 `uiart.art('banker')` 的绘制删掉了，
但**贴图还在**（`packages/server/public/ui/hud/banker.webp`，240×240 橙框黄字方章）、
**预热键表里也还有 `banker`** → 资源链路完整，**只缺绘制**。于是庄家在铭牌上没有任何标识。

**修法**（`packages/minigame/game/utils/table.js`）：

- 新增 `drawDealerStamp(ctx, cx, cy, r, off)` —— 在头像**左上角**画「庄」字章
  （与右下角风位角标对角对称，不挤昵称行、不改铭牌布局）。
- `drawAvatarOrWind(...)` 增加第 8 参 `off`（圆心偏移系数，默认 0.70）；
  **头像分支与「回退风位圆」分支都调** —— 庄家没头像时标识也不能丢。
- 尺寸 `size = max(13, round(r*0.95))`：
  - **横排**（r=17）→ 16px ≥ 16 → 用 `uiart.art('banker')` **位图**（即原设计的那枚印章）；
  - **竖排**（r=13）→ 13px < 16 → 走**矢量**（金底 `#e6c14b` + 深字 `#22200f` + 橙边 `#c8853a`）。
    ⚠ 位图从 240px 缩到 13px 会糊成一团，**小尺寸一律走矢量**。
- 竖排用 `off = 0.58`（比横排小）：r 小则按比例偏移会**顶出铭牌上沿**。

**⚠ 竖排为什么必须有**：庄家每局轮转，会落到上/下家（竖排铭牌），
不补的话这些局的庄家**完全没有标识**。

**验证**（`.recover-tmp/table_banker_probe.cjs` 15/15 + `.recover-tmp/banker_pix_probe.mjs` 像素实证）：

| 项 | 结果 |
|---|---|
| 竖排庄标几何 | 13×13，中心 (1164.5, 253.5)，铭牌顶边 y=244 → **内缩 3px，不越界** |
| 竖排像素 | 底 `rgb(230,193,75)` = #e6c14b ✅ 矢量金底；**未画** banker 位图 ✅ |
| 横排像素 | 16×16 位图 at (1095.1, 453.1)，铭牌 rect (1088,446,190,54) → **四周留白 7px** ✅ |
| 非庄家 / 无头像回退 / 位图缺失 | 分别不画、仍画、回落矢量 —— 三条兜底路径都验过 |

**⚠ 教训**：肉眼看缩放截图会把「金底深字」误读成「深底亮字」，
**颜色判定必须用 `getImageData` 采样**（`banker_pix_probe.mjs` 就是为这个写的）。

### 14.10 「宝」倍数泡的 textAlign 契约（2026-11-04，庄标修复引出的连带回归）

**症状**：铭牌右上角的红棕「宝」倍数气泡里只剩一个「✕」，**「×N」的 N 跑到圆外被铭牌边裁掉**。

**根因**：`drawDealerStamp` 收尾时写了 `ctx.textAlign = 'left'`，
而 `drawAvatarOrWind` 的**约定是结束时保持 `textAlign = 'center'`**（风位角标是居中画的）。
宝泡紧跟在 `drawAvatarOrWind` 之后绘制、依赖这个居中状态 → 「×」落在圆心、「N」右移出圆外。

**修法**：`drawDealerStamp` 收尾还原成 `ctx.textAlign = 'center'`；
并且**两排宝泡都显式设 `textAlign='center'`**，不再依赖调用链的隐式状态。

**顺带修**：宝泡文字基线原本用 `hcy - 8`（圆心下 11px）→ 数字掉到圆的下方。
改为**圆心 + 3**（8px 字的视觉中心）：横排 `y + 11`、竖排 `y + 11`。

**⚠ 由此确立的通用契约**：`drawAvatarOrWind` 结束时 **textAlign 必须仍是 'center'**、
textBaseline 必须仍是 'alphabetic'。任何在它之后画的东西（宝泡等）都会吃到这个状态 ——
**新增绘制点要么显式设对齐，要么别改上游的对齐状态**。

**验证**：`table_banker_probe.cjs` ⑦ 段新增 **10 条断言**（横排/竖排各 5 条：
画出「×N」/画出圆/`textAlign=center`/水平居中于圆心/基线=圆心+3，另加「宝=1 不画」），
合计 **25/25**。




### 14.11 局内「退出本局」（2026-11-05，用户要求「谁点都只退出自己」）

**需求**：局内左上角原来是「解散对局」（房主强制结束全场）。改为**任何人**点都只是
「退出这一局」：自己回到房间页，**另外三家完全不受影响**（牌局继续、不被中止、不被带走）。

**协议**：新增 `{ t: 'quit' }`（与 `exit` 彻底离场、`abort` 房主强制结束都不同）。
局内 UI 只发 `quit`；服务端 `abort` 分支保留，仅供老客户端兼容。

**服务端**：
- `case 'quit'`：置 `away/auto/ready` → 座位交给 `syncAuto` 代打；只给本人发 `lobbyState`
  （`playing=true`），其余三家 `broadcastGame` 看到该座位转托管。幂等（重复点只重发 state）。
- `broadcastGame` **跳过 away 座位** —— 否则 `game` 消息会让客户端 `navigate('game')`，
  把人从房间页硬拽回牌桌。
- `startGame` / `attachSeat` 清 `away` —— 新一局与重连都自动回桌。
- `leaveRoom` 遇 `playing` 改走 `exitDuringPlay()`（保座托管到本局结束）：
  否则退出者在房间页点「离开房间」会 `removePlayer → forceOver`，一个人走掉废掉别人的局。

**客户端**：
- `chrome.topbar` 的 `‹` → `game.onQuit()` → 确认框（**第一个动作=取消**，点框外也取消）
  → 发 `quit` + `navigate('lobby')`。原来的 `onAbort/onExit` 两套已删。
- 房间页：`state.playing=true` → 准备按钮置灰成「本局进行中」、自己那格「已退出本局 · 托管代打」、
  座位卡不给「点击换位」提示（服务端此时会拒）。
- 牌桌铭牌：`GameView.away[seat]` → 显示「已退出」，与普通「托管中」区分（横排 y+43 / 竖排 y+84）。

**⚠ 坑**：`layer.confirm` 的按钮是**从右往左 push**，`ui.layerBtns` 顺序与 `actions` 相反 →
探针里按 `id`（`layer0`/`layer1`）取，别用下标。

**验证**：`.recover-tmp/quit_probe.mjs`（真服务端 e2e，**20 断言**：退出者收到 state/playing=true、
自己那格 away+auto、其余三家 playing 未被中止、away/auto/names 正确、退出者此后 **0 条 game**、
牌局继续推进、重复 quit 幂等、大厅 quit 被拒、本局结束下一局自动回桌、退出后离开房间仍不中止本局）；
`mg_geomcheck.cjs` 新增 1d（away 铭牌「已退出」）、`game.quit`（‹→确认框→quit+lobby、
取消与点框外均不发请求）、`lobby.away`（playing 透传、准备按钮文案、座位文案）。
