# 全量排查报告 — 2026-11-04

> ⚠️ 历史快照：文中提及的微信小程序端及其路径已于 2026-11-05 整体移除，相关引用均已失效，仅供追溯。

> 目标：通读全项目找出确实存在的缺陷；**确定性的小问题直接修复**，
> **存疑/需设计决策的一律不动**，整理在第三节统一交由你决定。
>
> 排查范围：`packages/server/src`（index.ts ≈2400 行 / game.ts ≈1600 行 / wxvoice.ts）、
> `packages/shared/src` 全部、`packages/miniapp/miniprogram`（三页 + utils 14 文件）、
> `packages/minigame/game`（src 场景体系 + utils）、`scripts/`（mp_build_shared / mg_geomcheck /
> variant_settle_server）。基线：`docs/guides/full-audit-2026-10-25.md`（该轮问题全部复核在位，无回归）。
>
> 本轮重点覆盖 10-25 之后的新增面：**语音功能**（voiceId/voice 协议、wxvoice.ts、双端 voice.js）、
> **小游戏端移植**（离屏宿主画布 + 场景体系）、**miniapp C1 重排后的渲染层**。

---

## 一、方法与基线

- `npm run typecheck`（strict）→ 0 错；小程序/小游戏 JS 用 `new Function` CJS 加载器逐文件校验
  （根 `package.json` 是 `type:module`，`node --check` 会误判）。
- **三路并行深审**（服务端+shared / miniapp / minigame）逐行通读 + 与协议两端交叉核对；
  关键疑点全部由主审逐条复核代码后才定论。
- **运行级实证**：起真实服务端 + ws 客户端端到端复现崩溃路径；小游戏端跑
  `node scripts/mg_geomcheck.cjs` 全量门禁（含场景实例化冒烟）。
- 修复后再跑一轮完整回归（见第五节），其中 **16/16 端到端用例**与**全流程打完一局结算**均通过。

---

## 二、已确认并修复（按严重度）

### S1 【严重·已修】任意连接发 4 字节文本 `null` 即打崩整个服务进程（未认证远程 DoS）

- **位置**：`packages/server/src/index.ts` — `ws.on('message')` 与 `handle()` 入口
- **原因**：`JSON.parse("null")` 合法返回 `null`，`switch (msg.t)` 对 null 取属性抛 TypeError；
  `handle` 与 message 监听器均无 try/catch，ws 库不吞监听器异常 → uncaughtException → 进程退出。
- **效果**：任意能连上 `/ws` 的人一条 4 字节消息打死服务端：全部房间/牌局/token 丢失、全体掉线。
- **修法**：① `handle()` 入口加垃圾输入守卫（非对象 / `t` 非字符串 → 回「消息格式错误」）；
  ② message 监听器里 `handle()` 外包 try/catch，任何分支漏抛的异常都收敛成一条 error 消息。
- **验证**：端到端实测 — 修复前发 `null` 进程必死；修复后 `null`/`5`/`[]`/`{}`/`"str"`/`true`
  全部各回一条 error、进程存活、后续连接正常（16/16 用例通过）。

### S1b 【严重·已修】ws 连接无 `error` 监听 → 接收层出错同样崩进程（S6 修复时 e2e 抓出）

- **位置**：`packages/server/src/index.ts` — `wss.on('connection')`
- **原因**：ws 库在接收出错（最典型是超过 `maxPayload` 的 `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`）
  时对连接 emit `'error'`；连接上没挂监听就逃逸成 uncaughtException。**此问题与 maxPayload 无关、
  原先就存在**（默认 100MiB 超限同样崩，只是更难触发）；本轮给 WSS 设 64KB 上限后冒烟立刻复现。
- **效果**：一条超大消息（或任何接收层错误）打死服务端，同 S1。
- **修法**：连接上补 `ws.on('error')` → 记日志 + `ws.terminate()`（触发 close 走正常掉线托管流程）。
- **验证**：80KB 消息 → 该连接以 1009 关闭、其余连接不受影响、服务进程存活（e2e 实测）。

### S2 【严重·已修】`variant` 传原型键（`__proto__`/`constructor`）→ TypeError → 崩进程

- **位置**：`packages/shared/src/rules/index.ts`（`VARIANTS` 字面量）；触发点
  `index.ts` `create` 分支 `getRules(...).meta.id` 与 `setVariant` 分支 `VARIANTS[v].meta.name`
- **原因**：`VARIANTS` 是普通对象字面量，`VARIANTS['__proto__']` 返回 `Object.prototype`（真值），
  绕过「未知玩法」校验后取 `.meta` 抛 TypeError。`create` 分支无需任何身份即可触发。
- **效果**：同 S1，未认证远程 DoS（`{"t":"create","variant":"__proto__"}` 一条消息即可）。
- **修法**：`VARIANTS` 改用无原型对象承载（`Object.assign(Object.create(null), {...})`），
  原型键查找一律得 `undefined` → 走既有的「未知玩法/回退默认」路径。一处改动覆盖全部三个触发点。
- **验证**：e2e 实测 — `create` 传 `__proto__`/`constructor`/`toString`/`hasOwnProperty`
  均正常建房（回退南昌）；`setVariant` 传原型键被「未知玩法」拒收；进程存活。

### F1 【严重·已修】小游戏确认框按钮数组跨帧残留 → 「幽灵按钮」可把「同意换位」劫持成「解散对局」

- **位置**：`packages/minigame/game/src/chrome.js` `render()`（配合 `src/ui/layer.js` 只 push 不清空）
- **原因**：对局场景的 `s.ui` 跨帧持久（`s.ui = s.ui || {}`），`layer.confirm()/scoreTable()` 对
  `u.layerBtns` 只做 `|| []` 兜底再 push；浮层关闭后不再重画按钮，但旧按钮矩形仍留在表里。
  `chrome.tap()` 第一段就消费 `u.layerBtns` → 命中旧矩形即执行旧回调。
- **效果**（冒烟实测复现）：关闭过一次确认框后，(a) 屏幕上「看不见的按钮」继续响应点击；
  (b) 旧「解散」按钮劫持新确认框的「同意/退出」——点「同意换位」实测发出的是 `abort`，
  **本局被误解散**；(c) 「取消」也可能被吞（点了没反应）。大厅/首页场景每帧重建 `ui` 不受影响。
- **修法**：`chrome.render()` 开头补 `u.layerBtns = [];`（每帧重建，与大厅场景 :891 同口径）。
- **验证**：`mg_geomcheck` 全量通过（场景冒烟含对局场景每帧 render）；代码层复核 tap 消费序。

### S3 【中·已修】房主对局中「解散牌桌」漏清杠后掷骰兜底定时器 → 解散后最多 15s 幽灵对局复活

- **位置**：`packages/server/src/index.ts` `case 'dissolve'`（对照 `syncGangRoll` 的定时器回调）
- **原因**：dissolve 只清 `windowTimer/autoTimer/dealerStartTimer/diceEndTimer`，**漏 `gangRollTimer`**，
  也不清 `room.game`/phase。定时器到点后的全部守卫（game 非空、phase==='playing'、dice===null、
  座位未变、非托管）在解散后**全数通过** → `rollDice` → `applyGameEvents` → `broadcastGame`
  （连接未关）→ `syncAuto` 重新挂 autoTimer，机器人/托管位继续行牌直到结算并写 `room.totals`。
- **效果**：解散后其他玩家已回首页，却陆续收到 `game/settle` 推送；局中有托管位时牌局无人操作
  也能自己打完、错误改分，客户端可能弹「幽灵结算面板」。触发序列：真人补杠进入杠后等掷骰
  （15s 兜底定时器已挂）→ 房主在 15s 内解散。
- **修法**：dissolve 补清 `gangRollTimer`；同因加固 `pruneGonePlayers` 与 `closeRoom`（两处
  同样漏清，现状推不出触发路径但一并收口）。
- **验证**：代码路径逐行复核（每个守卫对照 dissolve 后的实际状态）；清法定时器写法与同函数
  其余四个定时器完全同构；typecheck 0 错。

### B1 【中·已修】语音 join 链不可取消 → 离房/被踢/解散后「孤儿语音会话」（双端）

- **位置**：`packages/miniapp/miniprogram/utils/voice.js` 与 `packages/minigame/game/utils/voice.js`
  （`join`/`exitVoip`/`leave`）
- **原因**：`join()` 置 `state='joining'` 后要经隐私授权→麦克风权限→登录→签名→入会多个网络往返
  （数秒）；`leave()` 对 `joining` 只复位标志位，**没有任何机制中止在途链**。链走完后无条件
  `state='joined'; joinedRoom=房码; announceId()`。
- **效果**：点「开语音」后立刻离房/被踢/房间解散，数秒后仍被拉进**旧房间的 VoIP 会话**：
  人已回首页、麦克风灯亮、能听到原房间说话、界面无出口（只能重进房或杀小程序）。
- **修法**：加世代号 `joinSeq`（exitVoip 与新 join 都自增）；join 链在每个 await 后核对，
  过期立即放弃；入会成功后才发现过期则直接 `wx.exitVoIPChat` 拆掉刚建立的会话。
  `finally` 的状态复位加「本链仍是当前世代」条件，避免把新链的 joining 标志清掉。
- **验证**：CJS 语法通过；双端文件 diff 逐字节一致；逻辑逐 await 断点复核（授权/权限/登录/
  签名/入会五处 + 成功后一处）。

### B2 【中·已修】`voice.rejoin()` 全仓库零调用 —— 语音被打断后的自动重入会是死代码（双端）

- **位置**：`utils/room.js`（小游戏端 `src/nav.js`）`syncVoice()`；定义在 `utils/voice.js:474`
- **原因**：`rejoin()` 注释明说「对局 WS 重连成功回调、页面 onShow 均可调」，但 grep 全仓库
  无任何调用点。来电等打断后 `state='idle'`、`joinedRoom` 保留「等待自愈」，自愈实际不存在；
  `syncVoice()` 只调 `announce()`（重发 voiceId，要求 `state==='joined'`，中断后是空操作）。
- **效果**：来电打断后语音静默掉线；服务端 `voiceOpenid` 映射仍在 → 其他玩家铭牌一直显示
  你「已入会·未闭麦」（说话光环不亮但闭麦态失真），必须手动再点语音钮。
- **修法**：`syncVoice()`（收到 state/game 即回桌成功路径）里加 `voice.rejoin()` —— 幂等，
  无会可恢复时是空操作，不会重复入会。
- **验证**：rejoin 内部守卫复核（仅 `idle && joinedRoom` 才动作）；双端语法通过。

### B7 【低·已修】语音监听器不随页面卸载摘除 → 死页 setData + 后台复活 BGM（miniapp）

- **位置**：`pages/lobby/lobby.js`、`pages/game/game.js`（onHide/onUnload；监听挂载在 onShow 的 `initVoice`）
- **原因**：`voice.setListener` 是模块级单槽，onShow 挂 `this` 但 onHide/onUnload 从不清。
  离房回首页后语音状态一变（如来电打断），`notify()` 回调已销毁页面实例 → `setData` 报错刷屏；
  `applyVoice` 的 idle 分支还会把刚被 `app.onHide/game.onHide` 暂停的 BGM 重新拉起。
- **修法**：两页 onHide/onUnload 补 `voice.setListener(null);`（onShow 的 initVoice 会重挂）。
- **验证**：生命周期顺序复核（onHide 清 → onShow 重挂）；语法通过。
  （同类遗留 `ui.showToast`/`probe`/`exec` 回调见第三节 F。）

### B4 【低·已修】`view.claims.length` 恒假 → 响应窗口「手牌蒙罩」从未生效（双端）

- **位置**：`utils/table.js` `drawMyHand`（miniapp :1878 / minigame :1974）
- **原因**：协议里 `claims` 是 `{ options, deadline }` 对象（`shared/src/index.ts:180`），
  不是数组 → `.length` 恒 undefined → 「claims 期整行蒙罩（只看不可出）」永不渲染。
- **效果**：纯外观缺失——响应窗口期间自己的手牌行不变暗。无功能危害：
  出牌仍被 `discardEnabled`（`claimWindow` 口径）与 `onCanvasDiscard` 双守卫拦住。
- **修法**：改判 `view.claims.options.length > 0`（按真实协议形状），双端同改。
- **验证**：协议类型对照；`mg_geomcheck` 全量通过（其 claims 用例走 `claimWindow` 口径，不受影响）。

### F3 【低·已修】小游戏大厅掷骰覆盖层不拦截下层按钮（小程序端全屏 .layer 是挡住的）

- **位置**：`packages/minigame/game/src/scenes/lobby.js` `onTap`/`onTouchDown`
- **原因**：小程序端骰子覆盖层是全屏 `.layer`（盖住底层全部按钮）；小游戏端 `onTap` 在
  `dice.shown` 时仍依次命中 `btnReady/btnBot/btnDissolve/btnLeave/btnShare/btnRoll/voice` 等。
  对局场景 `chrome.tap` 有同款全吞（`diceFx.shown → return true`），两端行为不一致佐证遗漏。
- **效果**：1.2~2.6s 掷骰动画期间点击可穿透——能盖着动画点「准备/加机器人/解散/离开」
  改变房间状态，或让确认层与骰子层叠出两层弹窗观感。
- **修法**：`onTap`/`onTouchDown` 开头 `if (this.dice.shown) return;`（吞点击且不进按压态）。
- **验证**：`mg_geomcheck` 场景冒烟通过；与对局场景既有语义对齐。

### F4 【低·已修】多点触控时抬起坐标取错手指 → 幻影 tap 打在未抬起手指的位置（小游戏）

- **位置**：`packages/minigame/game/src/input.js` `pt()`
- **原因**：微信 touchend 里 `touches` 是**仍在屏上的手指**、`changedTouches` 才是刚抬起的手指；
  `pt()` 恒取 `touches[0]`。双指时 A 指点牌、B 指搭屏，A 抬起 → 取到 B 的坐标 → tap 落在 B 处。
- **效果**：搭着第二根指点牌时可能**误出牌**（tap 落在手牌行）或误开表情面板。
  小程序端每张牌是独立 bindtap 节点，无此问题。
- **修法**：`pt(e, preferChanged)` —— up/cancel 优先取 `changedTouches[0]`；down/move 维持 `touches[0]`。
- **验证**：单指路径等价（单指 touchend 的 touches 本就为空，原来也走 changedTouches 兜底）；
  `mg_geomcheck` 命中用例全过。

### F5 【低·已修】frame/胶囊变化后不重绘 → 进场首帧「画里画」错位直到下一条广播自愈（小游戏）

- **位置**：`packages/minigame/game/src/scenes/game.js` `updateTableGeometry`
- **原因**：只赋值 `this.table.frame/capsuleRect` 不补渲染；进场首帧 `table.frame` 还是 null
  （兜底映射），首帧 render 先于正确 frame 产生，之后改了 frame 也不重绘（牌桌是事件驱动重绘）。
  miniapp 的 `applyTableFrame` 在 frame/胶囊变化时会立即补一帧，移植时丢了。
- **效果**：进对局后（尤其开局发牌等待期）画布内桌布与全屏桌布两层映射不一致——可见一圈
  「画中画木框边」，直到下一次任意广播/动画帧才自愈。
- **修法**：frame 变化后 `if (this.view) this.table.render(this.view);`；胶囊变化且 frame 未变时同样补帧（对位 miniapp）。
- **验证**：`mg_geomcheck` 全量通过（含 frame 映射与投影互逆断言）。

### S5 【低·已修】摊牌展示中掉线不补收桌判定 → 其余已点「下一局」的玩家悬在结算面板

- **位置**：`packages/server/src/index.ts` `beginReconnectGrace`（对照 `removePlayer:1241` 同口径）
- **原因**：`removePlayer` 在 displaying 时显式 `finalizeIfReady(room)`（注释：否则会一直悬着）；
  但 `handleDisconnect` 对 displaying 走 `beginReconnectGrace`，不做该判定。若离线者是最后一个
  未点「下一局」的人，其余三家在其掉线前点击时凑不齐，掉线后无人再触发收桌。
- **效果**：三家停在摊牌/结算界面，直到离线者回来或有人再点一次任意 ready/nextRound。
  可自愈、无死锁，但体验上「卡住」。
- **修法**：`beginReconnectGrace` 里 `if (displaying(room)) finalizeIfReady(room);`，
  已收桌则跳过随后的 `broadcastGame`（finalizeIfReady 内部已广播，与 removePlayer 语义一致）。
- **验证**：与 removePlayer 路径逐行对照；typecheck 0 错。

### S6 【低·已修】ws 未限制单条消息大小（默认 100MiB）→ 超大消息解析期间阻塞事件循环

- **位置**：`packages/server/src/index.ts` `new WebSocketServer(...)`
- **修法**：`maxPayload: 64 * 1024`（协议最长消息远小于此）；超限帧被 ws 以 1009 关闭。
  **配套**：该修复暴露出 S1b（连接无 error 监听），一并修复（见上）。
- **验证**：e2e — 80KB 消息 → 连接 1009 关闭、服务无感、其余连接正常。

### S8 【低·加固】切换到需要定庄的玩法后不触发托管补掷，掉线座位的定庄骰无人代掷

- **位置**：`packages/server/src/index.ts` `case 'setVariant'` lobby 分支
- **原因**：`syncBotDealerRolls` 的触发点有 join/addBot/掉线/pushDealerRoll，唯独 setVariant
  切玩法（如南昌→赣州，定庄口径变了）后不补。满员房含掉线座位时可能卡在「等定庄」。
  恢复路径存在（掉线者回来自掷、任何 join/leave 都会触发），故列为加固而非确证缺陷。
- **修法**：setVariant lobby 分支末尾补 `syncBotDealerRolls(room);`（幂等，与既有触发点同一不变式）。
- **验证**：函数自身守卫复核；typecheck 0 错。

### B6 【低·已修】`lib/shared` 构建产物无「generated/勿手改」标记，构建脚本也不注入

- **位置**：`scripts/mp_build_shared.mjs`
- **原因/效果**：agent.md §3 规定产物勿手改，但文件本身不可辨识——手改会被下次构建静默覆盖。
- **修法**：构建脚本给每个产物 .js 注入一行 `/** GENERATED by scripts/mp_build_shared.mjs … DO NOT EDIT */`；
  重建双端产物。
- **验证**：`build:mp`/`build:mg` 自检通过；双端 `lib/shared` diff 逐字节一致；产物头部有标记。

---

## 三、存疑 / 需你决定（本轮未动）

### A.【已处理·2026-11-04 按方案①】上宝倍数可突破「上限 ×3」——同面普通牌可被同一玩家反复打出

> **处理结果**：用户选定方案①（认可实现口径「按打出张数累计、不设上限」，**代码零改动**，
> 修正文档与注释）。已改：`docs/rules/ganzhou.md` §5.7 正文（按牌面判定/按打出次数累计/不设上限，
> 并写明事实依据——翻出的物理正精随海底预留不入流通，正精面剩 3 张、副精面 4 张可被打出）、
> §九速查表、修订记录（新增 2026-11-04 修订节 + 历史行追溯注记）、`game.ts` 两处注释。
> 以下保留原始分析供追溯。

- **位置**：`packages/server/src/game.ts:704-708`（按**牌面**比较累计）+ `:1596-1599` `baoMult()`；
  对照 `docs/rules/ganzhou.md` §5.7（:244-255）与 `game.ts:165-168` 注释
- **矛盾**：文档/注释说「明面正精/明面副精**全场各仅一张**，倍数上限 ×3」；但翻出的那张物理
  明面正精被海底预留（`applyGzFlip` 截断）**永远不会被摸到**——实战中每次「打出正精面」都是
  同面的普通副本（3~4 张流通），代码按面计、打出几次累几次。实测同一玩家可叠到 ×9。
- **效果**：倍数进入 `gzscore` 直付（`pattern × mw × baoMult`），玩家可通过反复打出精面把自己
  的赔付/收分倍数抬到远超约定的 ×3，牌友可见分数争议。
- ~~**可选方案**（需你定口径）~~：
  1. ✅ **认可「按打出张数累计、不封顶」→ 只改文档与注释的「上限 ×3」表述（代码零改动）——已采用**；
  2. 按文档口径「每面至多计一次」→ `baoZheng/baoFu` 累计处加「该座位该面只计一次」判定；
  3. 保留张数累计但封顶 → `Math.min(3, 1 + 正 + 副)`。

### B.【已处理·2026-11-04 第二轮（用户定案后实测再定址）】自家铭牌（slot0）与下家副露下段几何相交

> **处理结果**：用户先选「右端上移避让」，几何探针实测**否决**——下家牌河满载占 y200..428、
> 右带 y108..508 几乎全满，54px 高的横排铭牌在右竖带无任何 54px 空档；回挪 x104 也有
> 上家 3 副露时 2 张相交。最终按实测数据改定：**slot0 铭牌移到最左端 (6,446)**——
> 上家副露列最左 x267、自己副露分区起 x300+，x6..196 竖带完全空闲；探针五组压力场景
> （含两侧 4 副露 + 双河满载极限）全部 **0 相交**；over 相位维持 508（实测 0 相交）。
> 气泡（leftSide/up 分支）与表情飞行锚点均为数据驱动，随 tagRects 自动跟随。
> 已改：`packages/miniapp/miniprogram/utils/table.js` drawTag pos 表 + 注释；
> `scripts/verify/geomcheck.cjs` 全量通过。以下保留原始分析供追溯。

- **位置**：`packages/miniapp/miniprogram/utils/table.js:2786`（铭牌放 x1050,y446 右端）；
  同函数 ：2768-2772 注释却说「自己：手牌上方**左端**红框位（x104, y446）」——注释与代码相反
- **实测**（真实 table.js + mock canvas）：下家（slot1）副露行 438/474 下段与 `tagRects[0]`
  （1050..1240 × 446..500）相交，下家「3 碰 1 杠」时 13 张副露牌里 7 张压在铭牌上，
  正好盖住昵称（x1102,y467）、积分（x1102,y487）与手牌数文本。
- **为何不动**：修法是布局决策——回挪 x104（注释口径）则要复核 x104..294 与上家副露列
  （slot3 lower x≈266..452）的 35px 重叠；或改竖标贴两端。需要你定位置后一次改对。
- **复核要点**：真机让下家凑 3+ 副露看自家铭牌；修完在 geomcheck 风格 harness 加
  「tagRects[0] × slot1 副露 SAT 不相交」断言锁死。

### C.【已处理·2026-11-04 第二轮（用户定案：扩容到 5 组）】第 5 组副露（4 组副露 + 报杠展示并存）静默不画（两端各一处）

> **处理结果（两端均已修并探针验证）**：
> · **miniapp**（`utils/table.js` drawMelds 侧家分支）：groups > 4 时上段收成三行
>   `[98,131,164]`（行距 33、组间叠压 1px，与牌河「牌压牌」同一设计语言；第三行底 198
>   距牌河顶 200 留 2px 缝），下段两行不动；≤4 组维持原布局零变化。探针实测：下家/上家
>   5 组各 28 张切片全部落屏（y 段 98..198 + 438..508），与牌河带 200..428 零重叠。
> · **minigame**（`utils/table.js` MELD_BLOCKS）：侧家（slot1/3）追加第 3 块
>   （x 同前两块对齐、y444..496、86×52）——探针四场景（全满/单侧满/空场）实测该窗口
>   0 占用（位于自/对家副露带 y440 止与手牌行 y512 之间）；5 组全部落屏。
>   slot0/2 本就 2 块单行双组 = 4 组容量、加 decl 最多 5 组恰好放下，无需扩。
> · 两端 geomcheck 全量通过、typecheck 0 错。以下保留原始分析供追溯。

- **位置**：miniapp `utils/table.js:2621-2625`（侧家 slot1/3 固定 4 行）；minigame
  `utils/table.js:729-761` + `:2646`（`MELD_BLOCKS` 每家 2 块 × ≤2 组 = 4 组）
- **原因**：两组代码都是 `groups = [报杠展示?] + 副露…` 后按固定容量截断。上一轮审计 A 只修了
  miniapp 自己/对家（现容量 6 组够用）；侧家换新布局后容量定格 4。可达性：赣州一家 4 组副露
  且正轮到他报杠展示（groups=5）→ 第 5 组整组不画（数据正确，纯渲染缺口）。
- **效果**：极端场景下最后一组副露或报杠展示牌在桌面消失；报杠展示不可见会让玩家不知道
  哪三张被冻结。实战频率很低。
- **可选方案**：① rows/blocks 各扩 1 组（需重校 y 几何与 B 的铭牌位）；② 溢出组并入末行等比缩；
  ③ 最低限度先在超容量时 `console.warn` 留痕。与 B 一起定布局时一并处理最划算。

### D.【已处理·2026-11-04 第二轮（用户定案：同 voipsig 全局 1s）】`/api/wx/session` 无频控，可被第三方当 jscode2session 代理刷配额

> **处理结果**：`packages/server/src/wxvoice.ts` 加 `SESSION_MIN_GAP_MS = 1000` 全局最小间隔
> （结构与 voipsig 的 `SIG_MIN_GAP_MS` 一致，命中回 `rateLimited`）。客户端路径复核无碍：
> `ensureLogin` 失败走「微信登录失败」toast、再点一次即过（1s 窗口）；正常登录有 openid
> 缓存 + `wx.checkSession` 兜底，只有真重登才打该端点。typecheck 0 错。以下保留原始分析。

- **位置**：`packages/server/src/wxvoice.ts:104-137`（对照 voipsig 端点有 `SIG_MIN_GAP_MS` 1s 限流）
- **风险**：端点公开且无鉴权，任意脚本可高频携带任意 code 调用，服务端用自家 appid/secret
  反复请求微信侧。最坏是语音登录被微信限流（45011）、影响真实玩家语音登录。无直接数据风险
  （sessionKey 不下发）。
- **为何不动**：加全局 1s 限流会误伤「同 IP/NAT 后多名玩家同时进房开语音」的正常场景；
  按 IP 限流又有代理聚合误伤。需要你定策略（全局间隔 / 按 IP / 按 code 前缀）。
- **复核要点**：脚本连发 20 次 `/api/wx/session`，看微信是否返回 45011。

### E.【已处理·2026-11-04 第二轮（用户确认 appid 归自己）】minigame `project.config.json` 已填真实 appid，README 仍写「touristappid 已写入」

> **处理结果**：`packages/minigame/README.md` 三处措辞修正（快速开始/域名校验提示/目录结构）
> 与实际配置一致；保留「新环境换成你自己的小游戏 appid」的通用指引。以下保留原始分析。

- **位置**：`packages/minigame/game/project.config.json:3`（`wxaceaba5cd7524fab`）
  vs `packages/minigame/README.md:10`
- **效果**：新环境按 README 导入时预期测试号，实际用这个 appid——若它未注册/无权限，
  开发者工具预览/上传直接失败且排查方向被文档带偏。
- **需你确认**：该 appid 归属。若是你的正式小游戏 appid → 改 README 措辞；否则换回 touristappid。

### F.【低·体验·已修】死页回调残余：`ui.showToast` 定时器、`voice.probe()`、`computeSafeInsets` 的 `exec` 回调

- **位置**：`utils/ui.js`（模块级 toastTimer 持页面 ctx）、`lobby.js` / `game.js`
  （probe().then → setData）、`game.js`（exec 回调）
- **效果**：页面在回调前卸载时对死页 setData——控制台告警，不崩溃、不影响数据。
- **修法（2026-11-04 第二轮）**：`ui.js` 加 `alive(ctx)` 帮手（`getCurrentPages()` 栈内查找；
  无该 API/栈空/异常时按存活处理，保持旧行为），`showToast`/`hideToast`/toastTimer 到点回调
  三处守卫；两页 `probe().then` 与 game.js `exec` 回调入口先验存活再 setData。
- **验证**：CJS 语法通过；`mg_geomcheck` 全量通过。

### G.【流程·防回归·已补注记】miniapp ↔ minigame 的 `table.js` 有意分叉处于「长期豁免」态，无跟踪项

- **现状**：两端 table.js 已分叉 517 行（小游戏端是 2026-11-03/04 十字布局新版，小程序端仍是
  10-31 中压布局）；`mg_geomcheck.cjs` 第 0 步一致性门禁对该文件降级为警告（本轮预期内），
  但豁免**没有跟踪项/负责人/到期机制**；其余 9 个共享 utils 逐字节一致，privacy.js 为文档明示的平台差异。
- **风险**：后续渲染修复容易只落一端（本轮 B4/C/B3 就同时存在两端不同步的影子）。
- **处理（2026-11-04 第二轮）**：已在 `mg_geomcheck.cjs` 豁免处写明 4 步同步待办
  （① miniapp 同步十字布局全套锚点 → ② 带上 C 的副露容量缺口 → ③ 随重排解决铭牌相交
  （见第三节 B）→ ④ 两端 geomcheck + 恢复硬校验）。门禁本身工作正常（全量通过）。
  同步实施仍待用户排期。

---

## 四、已核验**无问题**的关键不变量（避免误报）

| 不变量 | 结论 |
|---|---|
| 结算零和 | ✅ 南昌三块（pattern/chong/gang）2000 组 + 赣州（交叉+直付+抄庄+上宝复合）1500 组随机属性测试，四家 delta 之和恒为 0 |
| 牌墙一致性 | ✅ `wall.shift/splice` ↔ ring 槽位严格同步；赣州海底预留截断同步；`wallLeft ∈ [0,136]`；空墩守卫齐全无死循环 |
| 响应窗口唯一解算 | ✅ 窗口仅两处创建且要求 `!pending`；respond 幂等；晚到应答静默忽略；不会二次 applyWin |
| 一炮一响 | ✅ HuLock 与 huPriority 共用裁决，不可能两家同时胡 |
| 定时器清单 | ✅ 五类对局定时器在 onGameOver/prune/removePlayer/dissolve/closeRoom 全清（本轮 S3 补上 gangRollTimer 缺口后收口）；sync* 均先清后挂 |
| 换位迁移完整性 | ✅ seat/binding/tokens/hostSeat/nextDealer/totals/dealerRolls + voice 广播全部同步（10-25 ③⑤ 修复在位） |
| 机器人/开局链路 | ✅ addBot→canStart→startGame（④在位）与定庄 2.6s 定时器不会双重开局 |
| 回桌/断线/顶号 | ✅ resume/join 对 exited/kicked 拦截；顶号先删 binding 再 close；对局掉线托管接管 |
| 语音服务端 | ✅ voiceMapOf 过滤 bot/exited；voiceId 幂等+白名单；sessionKeys 24h TTL + sigLast 60s + 10 分钟巡检，无内存泄漏；HTTP 面白名单无目录穿越 |
| miniapp 页面生命周期 | ✅ 三页全部定时器有清理路径；room.attach/detach 归属校验；WXML 51 个 bind* 处理器 0 缺失；data-* 类型约定符合 |
| 协议对齐 | ✅ 客户端 22 种上行消息与服务端 case 逐一比对 0 错发/漏发；服务端 12 种推送双端全部消费到位；voice 链路字段与 wxvoice.ts 完全一致 |
| 上一轮修复无回归 | ✅ 10-25 报告 ①②③④⑤⑥/A/C/D/F/G/H/I 逐项复核全部在位（A 已被 C1 方案接替；副露放宽仅剩侧家/小游戏容量缺口，见第三节 C） |
| minigame 移植等价性 | ✅ nav.js↔room.js 逐语义等价（autoResume 修复随移植在位）；场景 exit 清理覆盖 miniapp onHide/onUnload 全集；结算面板/掷骰仪式/托管/报杠链路逐字段一致 |

---

## 五、回归验证

| 项目 | 命令/方式 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | ✅ 0 错 |
| 双端 JS 语法 | `new Function` CJS 加载器 × 12 个改动文件 | ✅ ALL PASS |
| 小游戏门禁 | `node scripts/mg_geomcheck.cjs` | ✅ 全量通过（含场景实例化冒烟） |
| 崩溃修复 e2e | 真实服务端 + ws 客户端（`null`/`5`/`[]`/`{}`/原型键/80KB） | ✅ 16/16 |
| 全流程打完一局 | `MAHJONG_CEREMONY=0 node --require ws scripts/variant_settle_server.mjs` | ✅ 9/9（门控/开局/对局中拒绝/结算/切玩法/清零） |
| 双端产物一致 | `diff -rq miniapp/lib/shared minigame/game/lib/shared` | ✅ 逐字节一致 |
| 双端 voice.js 一致 | `diff miniapp/utils/voice.js minigame/utils/voice.js` | ✅ 逐字节一致 |

> 未能静态/脚本覆盖、建议真机走一遍的点：B1（点开语音后立刻离房，看麦克风灯是否立刻灭）、
> B2（来电打断后回房间是否自动恢复语音）、B4（claims 期手牌蒙罩）、F1/F3/F4/F5（对应交互场景）、
> 第三节 B（下家 3+ 副露看自家铭牌）。

---

## 六、修复文件清单（本轮全部改动）

| 文件 | 改动 |
|---|---|
| `packages/server/src/index.ts` | S1（入口守卫+监听器兜底）、S1b（连接 error 监听）、S3（dissolve/prune/closeRoom 清 gangRollTimer）、S5（displaying 掉线补收桌）、S6（maxPayload 64KB）、S8（setVariant 补托管补掷） |
| `packages/shared/src/rules/index.ts` | S2（VARIANTS 无原型对象） |
| `packages/miniapp/miniprogram/utils/voice.js` | B1（joinSeq 世代号） |
| `packages/minigame/game/utils/voice.js` | B1（同款，保持双端逐字节一致） |
| `packages/miniapp/miniprogram/utils/room.js` | B2（syncVoice 接入 rejoin） |
| `packages/minigame/game/src/nav.js` | B2（同款） |
| `packages/miniapp/miniprogram/utils/table.js` | B4（claims options 判定）、B（slot0 铭牌移最左端 6,446——用户定案右端上移后实测否决，探针五场景 0 相交）、C（侧家 groups>4 时上段收三行，5 组全落屏） |
| `packages/minigame/game/utils/table.js` | B4（同款）、C（MELD_BLOCKS 侧家追加第 3 块 y444..496，探针四场景 0 占用） |
| `packages/miniapp/miniprogram/pages/lobby/lobby.js` | B7（onHide/onUnload 摘语音监听）、F（probe 回调存活守卫） |
| `packages/miniapp/miniprogram/pages/game/game.js` | B7（onHide/onUnload 摘语音监听）、F（probe/exec 回调存活守卫） |
| `packages/miniapp/miniprogram/utils/ui.js` | F（alive() 帮手 + showToast/hideToast/定时器回调守卫） |
| `scripts/mg_geomcheck.cjs` | G（table.js 豁免处补 4 步同步待办注记） |
| `packages/minigame/game/src/chrome.js` | F1（render 每帧清 layerBtns） |
| `packages/minigame/game/src/scenes/lobby.js` | F3（骰子覆盖层吞点击） |
| `packages/minigame/game/src/input.js` | F4（抬起取 changedTouches） |
| `packages/minigame/game/src/scenes/game.js` | F5（frame/胶囊变化补渲染） |
| `packages/server/src/wxvoice.ts` | D（session 端点全局 1s 限流，对齐 voipsig——用户定案） |
| `packages/minigame/README.md` | E（appid 措辞与实际配置一致——用户确认归自己） |
| `scripts/mp_build_shared.mjs` | B6（产物注入 generated banner） |
| `docs/rules/ganzhou.md` | A（§5.7 正文/§九速查表/修订记录：上宝倍数废止 ×3 上限，按打出张数累计——2026-11-04 用户定案） |
| `packages/server/src/game.ts`（注释） | A（`baoZheng/baoFu` 与出牌处注释同款修正，代码逻辑零改动） |
| `packages/*/lib/shared/**`（双端产物） | B6（重新构建，仅多 banner 行 + shared S2 改动） |
