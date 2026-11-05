# 微信实时语音（多人房间语音聊天）接入文档

> 2026-11-03 新增。房间内（大厅 + 对局）4 人实时语音，基于微信官方 `wx.joinVoIPChat`。
> 服务端支撑代码 `packages/server/src/wxvoice.ts`；客户端封装 `game/utils/wxauth.js` + `game/utils/voice.js`。

## 1. 选型决策

| 候选 | 结论 | 原因 |
|---|---|---|
| **wx.joinVoIPChat（选定）** | ✅ 小游戏可用 | 官方 API；**免费**；语音流走微信自建通话通道，不经自建服务器 |
| 腾讯云 TRTC | ❌ 弃 | 平台矩阵已不再支持原生 JS 小游戏（仅 Unity）；live-pusher/live-player 组件要求企业主体 + 特定类目；按量计费 |
| 自建 WebRTC / SFU | ❌ 不可行 | wx 运行时不暴露 RTCPeerConnection |
| 语音消息（录音上传） | ⏸ 备用降级 | 非实时；个人主体开通不了 VoIP 时启用（见 §7） |

代价：VoIP 签名需要**用户级 sessionKey**（`hmac_sha256`），因此项目首次引入微信登录链路
（wx.login → code2Session），这是本功能最大的新增基础设施。

## 2. 开通步骤（上线前置，缺一不可）

1. **小游戏**（appid `wxaceaba5cd7524fab`）：MP 后台 → 游戏能力地图 → 实时语音 → 申请开通
2. 准备 AppSecret，**只通过环境变量注入**（严禁提交入库）：

```bash
WX_MG_APPID=wxaceaba5cd7524fab   WX_MG_SECRET=****   # 小游戏端
```

未配置 = 语音功能关闭：`GET /api/wx/voice` 如实上报，客户端隐藏语音入口，
其余对局功能完全不受影响。服务端启动日志会打印「实时语音签名服务 mg:开」一类自检。

## 3. 签名链路（为什么服务端要参与）

```
客户端                          服务端                          微信
  │ wx.login ──────────────►  │  code ──► jscode2session ──► openid+sessionKey
  │ ◄──── openid ──────────── │  （sessionKey 留服务端，绝不下发）
  │ POST /api/wx/voipsig ───► │  signature = hmac_sha256(
  │ ◄─ groupId/nonce/time/sig │      [appId,groupId,nonce,time].sort().join(''),
  │                           │      sessionKey)
  │ wx.joinVoIPChat(...) ──────────────────────────────────────► 微信 VoIP 通道
```

- `groupId = mj-<房间码>`（如 `mj-K7X2AB`，8 字节 ≤ 官方 32 上限）
- sessionKey 内存账本 24h 过期；服务重启即清空 → 签名端点回 `relogin` → 客户端 force 重登重签，用户无感
- `wx.checkSession` 失败（微信侧会话过期）同样自动重建登录态

## 4. 服务端端点（挂在既有 HTTP 端口，见 wxvoice.ts）

| 端点 | 方法 | 入参 | 出参 |
|---|---|---|---|
| `/api/wx/voice` | GET | — | `{ mp: true, mg: false }` 功能开关状态 |
| `/api/wx/session` | POST | `{ client:'mp'\|'mg', code }` | `{ ok, openid }` / `{ ok:false, reason }` |
| `/api/wx/voipsig` | POST | `{ client, openid, group }` | `{ ok, groupId, appId, nonceStr, timeStamp, signature }` |

统一 200 + `ok` 标志；`reason`：`voiceDisabled` / `badRequest` / `relogin` / `rateLimited` / `wx:<errcode>:<errmsg>` / `wxUnreachable`。
房间码格式校验（`[23456789A-Z]{6}`）+ 每 openid 1s 限流，防签名端点被滥用。

### 对局 WS 协议扩展（2026-11-03 二期：座位级语音指示）

- **ClientMsg `voiceId`** `{ openid, muted }`：客户端加入语音成功 / 开关麦后上报；服务端清洗（`[A-Za-z0-9_-]{1,64}`）后挂到座位 Player，**仅变化时**向全房间广播
- **ServerMsg `voice`** `{ map: [{seat, openid, muted}] }`：座位→语音身份映射。下发时机：① 映射变化（上报 / 离开 / 被踢 / 换位 / 局内退出回收）全房广播；② 新连接拿到视图后**定向补发**（create / join / attachSeat 回桌）。机器人、未上报者、已退出者不进 map
- 信任模型：openid 是客户端自报（WS 侧无法验证），仅用于「谁在说话/谁闭麦」的回显，最坏后果是指示错位（外观问题），**不参与任何权限判断**
- 客户端把映射（`voiceMap`）与 `voice.speakers()`（VoIP 说话人 openid 快照）求交 → 「哪个座位在说话」：大厅座位卡（🎙️/🔇 角标）、对局桌面铭牌（绿色呼吸光环 + 🔇，table.js 实例字段 `speakingSeats`/`mutedSeats` 注入）

## 5. 客户端集成点

**客户端共享**
- `utils/wxauth.js`：登录态（openid 持久化键 `mj-openid`，与对局身份 token/pid 完全平行、互不影响）
- `utils/voice.js`：VoIP 封装。状态机 `idle → joining → joined`；`probe/join/leave/toggleMic/openMicSetting/setListener`

**小游戏端**
- `src/main.js`：`voice.setClient('mg')`；onShow 续播 BGM 前检查 `voice.status().state !== 'joined'`
- `src/nav.js`：对位 room.js 的 `syncVoice`（仅映射自愈）/`leave` 挂点
- `src/scenes/lobby.js`：表头**双 chip**（麦克风 + 扬声器，贴分享钮左侧，胶囊避让内）
- `src/scenes/game.js` + `src/chrome.js`：合并菜单「🎙️」钮（menuVoice）+「🔊/🔕」钮（menuEar，
  语音开启后出现），说话呼吸光环

## 6. 验证清单（真机，开发者工具不支持 VoIP）

- [ ] 两台手机同房间互讲：成员进出、按钮「正在说话」光环正确
- [ ] **语音可选开启**：进房默认不在语音；点「开语音/🎙️」才加入，权限弹窗在首次点击时出现
- [ ] **扬声器开关**：🔕 后听不到对方、对方不受影响；偏好持久化（杀掉小游戏重进仍保持）
- [ ] **开关麦全量配置**：闭麦→开扬声器（或反之）互不干扰（muteConfig 全量覆盖的坑，见 voice.js toggleMic 注释）
- [ ] **座位级指示（二期）**：互讲时对方大厅座位卡亮 🎙️、对局桌面铭牌亮绿色呼吸环；闭麦后对方看到 🔇
- [ ] **换位后指示正确**：换位座位后说话环跟着人走（映射随 swap 重广播）
- [ ] 开/闭麦切换生效（对方能听到/听不到）
- [ ] 录音权限拒绝 → 引导层/提示 → openSetting 开启 → 回房间自动重进语音
- [ ] 切后台语音保持（微信电话行为）、回前台状态同步；BGM 暂停/恢复正确
- [ ] WS 断线重连（kill 服务端再起）：resume 成功后语音自动恢复
- [ ] 被踢 / 解散 / 离开房间 / 局内退出：语音一并退出
- [ ] 服务端不配 secret：语音按钮隐藏、对局功能正常（功能开关演练）

## 7. 已知限制与降级路径

1. **语音房按 appid 隔离**：微信 VoIP 房间按 appid 划分；本项目只服务小游戏一个 appid，
   同房间玩家处于同一语音房。
2. **开通审核不确定**：个人主体大概率开不了。降级路径：企业主体 → 换 TRTC；
   个人主体 → 语音消息方案（`wx.getRecorderManager` 录音 + 服务端上传端点 + WS 广播，
   全端可用、零资质）。
3. **开发者工具不可用**：VoIP 全程真机调试；工具里调用 `wx.joinVoIPChat` 直接 fail，
   按钮仍可渲染（`probe()` 依赖服务端开关状态，不依赖工具）。
4. ~~座位级说话指示未做~~ → **2026-11-03 二期已实现**（voiceId/voice 协议 + 大厅座位卡
   + 桌面铭牌光环，见 §4）。残余限制：openid 客户端自报（见信任模型）；说话光环动画
   仅在 playing 相位自驱动重绘（over/大厅相位按事件驱动刷新，光环静态）。
5. **「循环授权页」误判（2026-11-03 修复）**：`joinVoIPChat` 失败 errMsg 里含
   auth/permission 字样的原因不止「麦克风被拒」—— 后台「实时语音」能力未开通、
   工具端不支持、sessionKey 失效同样命中。旧版一律归因为 `micDenied` 并引导
   openSetting，而 `scope.record` 本来就是开的 → 用户在授权页与语音钮之间死循环，
   真实原因全程被吞。修复：`enterVoip` 只在 errMsg 同时命中权限类与录音/麦克风类
   字样时才判 `micDenied`，其余以 `joinFailed:<原始 errMsg>` 透传，两端 UI 用
   toast 原样展示。真机上再遇到「点开语音没反应/反复跳授权页」，先看 toast 里的
   原始 errMsg：`no permission` 类多半是**后台实时语音能力未开通**（§2），与
   用户级麦克风授权无关。
6. **隐私弹窗未配置（2026-11-03 真机实录）**：fail errMsg
   `joinVoIPChat:fail please go to mp open official popup or use
   wx.onNeedPrivacyAuthorization` = 用户从未同意过隐私保护指引。修复在**后台**
   不在代码：MP 后台「设置→基础设置」开通**官方隐私弹窗**，且「设置→服务内容
   声明→用户隐私保护指引」声明收集「麦克风（录音）」并生效。开完后点语音钮
   由微信自动弹协议，同意即正常入会。客户端
   `joinFailText` 已把该 errMsg 翻成带操作步骤的中文 toast，原始 errMsg 进
   console.warn（真机 vConsole 可查）。
7. **隐私授权代码接入（2026-11-04，官方弹窗开了仍报错的兜底）**：后台组件配置后
   部分环境仍 fail 同样 errMsg → 按官方《小游戏隐私合规开发指南》接入自定义路径：
   - 小游戏 `game/utils/privacy.js`：`wx.onNeedPrivacyAuthorization` 注册（main.js
     启动段**最先**调用 install —— 文档要求先于一切隐私 API）+ 自绘弹窗（draw/btn
     同套视觉）；曝光 `exposureAuthorization` / 同意 `agree` / 拒绝 `disagree`
     三事件经 resolve 上报；《用户隐私保护指引》只经 `wx.openPrivacyContract`
     打开。弹窗在屏时 input.js 拦截器全量接管触摸（不透场景）。
   - `voice.js`：join 第一步 `privacy.ensure` 闸门，
     拒绝 → `reason:'privacyDenied'`，UI toast「需先同意《用户隐私保护指引》」。
   - 冒烟：stub wx 15 断言全过（曝光→同意→join 放行；拒绝→短路；指引链接；
     空白点击不关闭；ensure 复用在屏弹窗）。
8. **`parameter.timeStamp` 参数类型错误（2026-11-04 真机报错）**：原始 errMsg
   `joinVoIPChat:fail parameter error: parameter.timeStamp`。官方 `wx.joinVoIPChat`
   参数表规定 `timeStamp` 为 **Number，Unix 秒**；服务端 `/api/wx/voipsig` 为签名
   HMAC 返回秒级十进制字符串，客户端传 API 前必须 `Number(sig.timeStamp)`。HMAC
   输入仍用 `String(timeStamp)` 拼接，不能改签名字符串格式。双端 voice.js 已按此转换，
   非法参数错误现在单独提示，不再误导成 sessionKey 过期。
9. **说话人事件（onVoIPChatSpeakersChanged）不触发（2026-11-05 查实）**：真机实测该回调
   注册成功（`typeof === 'function'`）但开麦说话**一次都不触发**，speakers 日志全无 →
   `speakersSeen` 恒 false → 座位级指示走「开麦即亮」降级（呼吸绿环不可靠）。查官方文档 +
   微信服务市场社区帖复核，结论：
   - **非小游戏独有、非基础库版本问题**：社区自 2022 起大量「onVoIPChatSpeakersChanged 无反应」
     反馈，场景是**小程序**；同环境 `onVoIPChatMembersChanged` / `onVoIPVideoMembersChanged` 都正常，
     唯独说话人事件不推。基础库 2.7.0 起就支持该 API（可用性没问题），坑在「触发」。
   - **字段名是 `openIdList`，不是 `loudSpeakers`**（小程序/小游戏文档一致，无 `loudSpeakers`
     字段）。曾误判「绿光环不亮」是字段没覆盖并补了 `loudSpeakers` 猜测 —— 复核后错：根因是事件
     不触发，字段解析无关（`pickList` 末位已是权威字段 `openIdList`，保留多别名兜底无害）。
   - **`onVoIPChatStateChanged` 拿不到说话人**：它是「房间状态变化」事件（回调 `code`/`data`/
     `errCode`/`errMsg`，基础库 2.16.0），只报房间级错误/状态，**不含说话人列表**。想靠它做
     「谁在说话」行不通。
   - **海外小游戏平台整组 VoIP 标 ❌ 不可用**（overseas-game 可用性页）；本项目 appid 是国内版，
     国内 API 都在，问题纯在说话人事件不推 —— 别被海外文档误导（那页会把所有 VoIP 接口标红）。
   - 结论：实时「谁在说话」呼吸绿环在当前微信 VoIP 下**不可靠**，降级路径（开麦即亮，数据源是自有
     `voiceId`/`voice` WS 协议）即正确终态；不追 speakers 事件，也不改 onVoIPChatStateChanged。

10. **🔇 角标规则：闭麦 + 关扬声器 才显示（2026-11-05 改）**：原规则「闭麦即显示 🔇」被推翻 —— 用户要求
    🔇 只在「闭麦 且 关闭扬声器」同时满足时出现，**单独闭麦不显示 🔇**。配套做了三处联动改动：
    - **关扬声器不再自动退出语音（解耦）**：原 `toggleEar` 在「会中关扬声器」会同步 `leave()` 退房，导致
      语音房里 `earMuted` 恒为 false、组合条件永不出现。改为只翻转本地 `earMuted` + 调微信
      `updateVoIPChatMuteConfig` 改 `earphoneMuted`，人仍留在语音房；麦克风状态独立生效。
    - **扬声器状态随 `voiceId` 广播 `ear` 字段**：`earMuted` 从「纯本地、远端无从得知」改为随 `voiceId`
      （`{t:'voiceId', openid, muted, ear}`）上报服务端，服务端 `voiceMapOf` 的 map 条目加 `ear`，全房
      广播 `{t:'voice', map}`（条目 `{seat, openid, muted, ear}`），远端座位才能据此画 🔇。
    - **显示点统一按 `muted && ear` 判定**：双端 `computeVoiceSeats` 的 `mutedSeats` 改为 `v.muted && v.ear`；
      大厅/对局座位卡 🔇、自己麦克风钮 🔇（chrome.js / game.wxml / lobby.wxml）一律 `micMuted && earMuted`；
      仅麦克风按钮的「灰显」反馈仍按 `micMuted` 单独判断（不影响 🔇 语义，只作视觉提示）。
    - 进语音仍**强制开扬声器**（join 链 `earphoneMuted:false` + 清 `KEY_EAR` 偏好），与解耦不冲突：用户进房
      后手动关扬声器才会触发 🔇 组合，符合「关了扬声器又闭了麦」才提醒的预期。
    - 协议字段：`shared` 的 `ClientMsg` 的 `voiceId` 加可选 `ear?: boolean`（旧客户端不报 ear → 服务端
      `msg.ear === true` 自然降级为「只按 mic 看」，不影响旧端）。
