# 全功能与界面检查检测报告 — 2026-11-06

> 范围：提交 `5ac6d51`（小游戏端唯一客户端 + 11-04 审计修复）之后的**当前代码**。
> 方法：静态检查 → 服务端真实进程 e2e（HTTP + WebSocket 双模式）→ 渲染/命中/浮层矩阵
> （真实 table.js + 场景实例 + mock canvas）→ 资源与部署面。全部自动化，无真机项。
>
> **总结论：产品代码（server / shared / minigame）未发现新缺陷**；
> 本轮发现并修复的 2 个问题都在**测试脚本自身**（断言过时 / 加载方式过时，见 §五）。

---

## 一、静态检查（全部通过）

| 项目 | 结果 |
|---|---|
| `npm run typecheck`（strict，覆盖 server+shared） | ✅ 0 错 |
| minigame 全部 47 个 JS 文件 `node --check` | ✅ 全过 |
| `npm run build:mg`（shared 产物 + 8 项自检 + generated banner） | ✅ 通过 |
| **主门禁 `scripts/mg_geomcheck.cjs`** | ✅ 全量通过：四相位渲染（playing/claims/over/ceremony）、命中语义（两段式出牌 / claims 禁出 / 掷骰 / 结算▲）、布局几何（844×390 安全区 47）、副露块镜像成对 + unproj/proj roundtrip（<1px）、三场景 enter/render/tap/exit 冒烟（含键盘抬升） |
| `scripts/verify/geomcheck.cjs`（完整断言套件：复本印证 / 出界 / 朝向 / 跨类 SAT / 叠压 / 墙缓存 / 降级路径） | ✅ 修复断言阈值后全过（修复前 290 处失败，定性见 §五-1） |
| `scripts/verify/gzgerman.cjs`（赣州德国规则回归） | ✅ 8/8 |
| `scripts/verify/noisetoast.mjs`（事件通道静默规则） | ✅ 修复加载方式后实跑通过（§五-2） |

## 二、服务端功能 e2e（真实进程，全过）

### 2.1 HTTP 端点矩阵

| 端点 | 结果 |
|---|---|
| `/`（兜底页） | ✅ 200，39B 提示文案 |
| `GET /api/tiles`（v7）/ `/api/ui`（v16）/ `/api/sound`（v5 + 语音包 n1/n2/w1/w2 + bgmOut）/ `/api/avatars`（v3，a01..a49） | ✅ 清单完整、版本号正确 |
| 静态资源：`/tiles/face/faceA.webp`(1.5MB)、`/ui/hud/table.webp`(9.6MB)、`/sound/bgm_wind.mp3`、`/sound/v_n1_hu.mp3`、`/avatars/a01.png` | ✅ 全部 200、字节数正确、长缓存头 |
| `GET /api/wx/voice` | ✅ `{"mg":true}`（mg 端语音凭据已配置） |
| **安全面**：`/tiles/../mahjong.config.json` 与 `%2e%2e` 编码穿越 | ✅ 白名单正则拒绝 → 落回 39B 兜底页，**无任何文件泄漏** |
| `/tiles/back/my/t00.webp` | 404 —— **白名单设计**（只放行 `tNN/faceX` 两类；`back/` 目录是历史遗留，见 §六-1） |

### 2.2 WebSocket 协议与牌局流程

| 场景 | 结果 |
|---|---|
| 崩溃修复回归（2026-11-04 审计 S1/S2/S6） | ✅ **16/16**：`null`/`5`/`[]`/`{}`/`"str"`/`true` 全回 error 不崩；`create/setVariant` 传 `__proto__`/`constructor` 拒收或回退默认；80KB 超限帧 1009 关闭、服务存活 |
| 全流程一局（`MAHJONG_CEREMONY=0`，赣州，4 真人 WS） | ✅ **9/9**：非房主切玩法拒 / 四人 rollDealer 开局 / 对局中切玩法拒且无 variant 广播 / 自动打完到结算 / 结算 4 行 / 结算窗口切玩法放行 / 双客户端收到 variant / 清零标志 |
| 仪式模式一局（`MAHJONG_CEREMONY=1` 默认档） | ✅ 定庄掷骰→playing、翻精仪式出现（「牌墙尾倒数第 N 墩，翻出正精」）、全员托管自动掷骰+行牌至流局结算（4 行、winner 正确） |
| 语音协议 | ✅ **6/6**：`voiceId` → `voice` 广播（seat/openid/muted 齐全）；非法 openid（对象注入）不崩不污染；muted 翻转同步；离房映射回收；重复上报幂等 |
| 房间内事件通道 | ✅ noisetoast 规则成立：整局出牌/吃/碰/杠/报杠 **0 条 toast**，房间级事件（加入/下局坐庄）照发 |

## 三、界面与交互（渲染 + 命中 + 浮层，全过）

### 3.1 渲染矩阵（mg_geomcheck + verify/geomcheck 双套覆盖）

- 四相位（对局/响应窗口/摊牌/发牌仪式）× 两帧（建墙缓存 + 稳态）渲染，全部切片与 projQuad 复本互相印证（误差 <1.6px）、0 出界、0 朝向越界；
- 跨类 SAT：牌河×铭牌/信息盘/牌墙/副露/手牌摞、副露跨槽、摊牌×全类、跨家牌河——**0 相交**（含铭牌已移位到 (6,446) 的新布局）；
- 牌河叠压比例实测 0.679（上下河）/ 0.705（侧河），与 11-04 十轮「盖立体条 28~32%」定稿一致（§五-1）；
- 降级路径（PC 微信离屏不可用）：384 张包围盒牌、0 切片、0 出界、不抛错。

### 3.2 chrome 浮层/面板矩阵（本轮新增探针，13/13 过）

| 状态 | 断言 |
|---|---|
| 日志面板 | ✅ 渲染 + close 命中关闭 |
| 聊天面板 | ✅ 渲染 + close 关闭 |
| 表情选择层 | ✅ 14 个 cell 渲染 + close 关闭 |
| 合并菜单（☰） | ✅ 日志/聊天/托管/设置四钮（11-05 改版：退出已移顶栏 ‹） |
| 退出确认层 | ✅ 2 钮；点「取消」**不发任何消息**、层正确关闭 |
| 换位确认层（**F1 幽灵按钮回归**） | ✅ 关闭过确认层后再开新层，点「同意」发出的是 `{t:'swapRespond',accept:true}`（不是 quit/其他）；无残留按钮 |
| 解散积分浮层 | ✅ 表格渲染 + 关闭钮 |
| 骰子覆盖层 | ✅ 在屏时吞掉全部点击（不透传下层） |

## 四、资源与部署面

- `build:mg` 产物落在 `packages/minigame/game/lib/shared/`（13 文件 + banner）；**`build:mp` 已在 11-05 提交中随 miniapp 删除一并清理**（package.json 无遗留脚本，构建脚本默认输出已指 minigame）；
- 代码包侧（minigame/game）无静态资源包袱（贴图/音频全部服务端托管，符合官方包体红线）；
- 静态资源总量较大项：`ui/hud/table.webp` 9.6MB（见 §六-2）。

## 五、本轮发现并修复（均为测试脚本自身问题，产品代码零改动）

### 5.1 `scripts/verify/geomcheck.cjs` — 290 处断言过时（假红）

- **现象**：全跑 290 处「相邻两排遮挡」失败，露出比例全部集中在 0.679（132 处）与 0.705（158 处）。
- **定性**：断言阈值 0.80 来自 11-04 早期「行距=牌高−8~10」版本；当日**十轮定稿**把行距改为「盖住贴图立体条 28~32%」（table.js 注释明确：上下河 `RIVER_V_DY=56−18=38 → 38/56=0.679`、侧河 `dy=RIVER_W−13=31 → 31/44=0.705`），断言没跟着更新——**渲染是定稿设计，断言过时**。主门禁 mg_geomcheck 一直是绿的（两者断言集不同步）。
- **修复**：阈值 0.80 → 0.62（设计值全部落窗，行坍缩 ≪0.62 仍会被拦），注释同步十轮定稿出处。修复后全套全过。

### 5.2 `scripts/verify/noisetoast.cjs` — Node 20 下直接崩（ReferenceError: WebSocket is not defined）

- **原因**：脚本用全局 `WebSocket`（Node 22+ 才内置），Node 20.10 没有。
- **修复**：改名 `noisetoast.mjs` + `createRequire(import.meta.url)('ws')` 加载（与 variant_settle_server 的 wspreload 方案同构）；实跑验证通过。

## 六、遗留观察（不构成缺陷，供排期参考）

1. **`public/tiles/back/` 目录为历史遗留**：`first/second/third/fourth/my` 约 140 个文件仍随仓库分发，但服务端白名单只服务 `tNN/faceX`，客户端清单也不引用——可整目录删除省体积（动前确认无外部直链）。
2. **`ui/hud/table.webp` 9.6MB**：单文件最大的资源，真机首次加载耗时主要来源；客户端有「未就绪走矢量兜底」与 preload 预热，无功能风险，仅首屏流量/时长观感。
3. **noisetoast 等待窗偏紧**：开局等待 18s，在「刚被杀过进程再起」的实例上偶发不足（复跑即过）；如需稳定可加到 30s 或加重试。
4. **`packages/minigame/game/project.private.config.json` 已随 11-05 提交入库**（`urlCheck:false` 为有意的联调配置，minigame/README 有说明）——注意它此后会覆盖开发者本机的私有配置，若将来要分机器管理需再评估。

## 七、未覆盖项（需真机/人工）

- 真机 VoIP 实际入会/说话人光环/打断自愈（开发者工具不支持 joinVoIPChat）；
- 真机触摸手感（两段式出牌的第二次确认在真机的误触率）、iOS 音频解锁时序；
- CDN 生产域（本报告全部本地服务实测；线上 `majiang.dwzynj.top` 的清单版本一致性未在本轮范围）；
- 长时间多局连续对局的服务端内存曲线（本次单局级验证）。

## 八、真机报障补录（2026-11-06 报告发出后）

### 8.1 【已修复】大厅语音环 `ReferenceError: reactive is not defined`（真机 WAGame.js）

- **位置**：`packages/minigame/game/src/scenes/lobby.js` 座位卡渲染循环（:826）
- **原因**：说话环双模式开关 `reactive` 是 `renderLobby()`（:221）的**局部变量**，每帧渲染循环直接引用——跨作用域漏引；`node --check` 查不出，本轮冒烟也没抓到（**空 voiceMap 时该分支永不进入**，正是「运行时冒烟要富状态」的教训）。
- **效果**：真机上一旦有座位开麦（voiceMap 有未闭麦条目），渲染帧抛 ReferenceError 被 main.js 兜住 → 大厅座位卡语音环不画、每帧报错刷屏。
- **修法**：渲染循环内按设计注释「每帧现取 `hasSpeakerData()`」重取（game 场景同类路径本就走 `table.voiceReactive` 字段传递，无需改）。
- **验证**：富状态探针 7 场景（语音环/定庄/换位/浮层矩阵）×3 帧全过；并把该场景固化进主门禁 `mg_geomcheck.cjs`（`lobby.voice-rich`：非空 voiceMap + 定庄骰 + 换位，连渲 3 帧）——**阴性对照**：临时注入旧 bug 后门禁立即报红，还原后全绿。
- **教训入册**：memory `runtime-smoke-for-scenes` 第八类「空状态冒烟不进分支」。

### 8.2 【无需处理·基础库噪声】`[wxapplib] backgroundfetch privacy fail {"errno":101,...}`

- **来源**：微信基础库（wxapplib 前缀）冷启动时对「周期性更新/数据预拉取」能力的内部探测（`private_getBackgroundFetchData`）——**本项目全仓库零调用**该 API，`game.json` 也未声明预拉取/周期更新。
- **errno 101 含义**：控制台未开通「周期性更新」且未设置 fetch token，基础库探测即失败并打出这条日志；"privacy" 字样是私有 API 受隐私协议门控的正常标注。
- **影响**：无。启动流程（main.js / preload.js 的 CDN 清单拉取与预解码）完全不依赖该能力；这是 many 小游戏真机日志里的常见噪声，可忽略。
- **如将来要用**：管理后台「开发管理→接口设置」开通周期性更新 + `wx.setBackgroundFetchToken` 后日志自然消失；当前无需求，不做任何改动。

## 九、回归验证命令一览

```bash
npm run typecheck && npm run build:mg
node scripts/mg_geomcheck.cjs          # 主门禁（渲染/命中/布局/场景冒烟）
node scripts/verify/geomcheck.cjs      # 完整断言套件（阈值已修复）
node scripts/verify/gzgerman.cjs       # 赣州德国规则
node scripts/verify/noisetoast.mjs 3310   # 需 (MAHJONG_CEREMONY=0 PORT=3310 npm start &)
# 全流程：MAHJONG_CEREMONY=0 起服后 node --require wspreload scripts/variant_settle_server.mjs
```
