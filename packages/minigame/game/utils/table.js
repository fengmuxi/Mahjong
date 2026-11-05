/**
 * 牌桌渲染（`packages/client/src/table.ts` 的小程序移植版）。
 *
 * 移植原则：**绘制与几何逻辑逐行保持不变**，只替换平台相关的三个入口 ——
 *   1. 取上下文：web 用 `canvas.getContext('2d')`，小程序用 canvas 2d 节点的
 *      `canvasNode.getContext('2d')`（节点由页面 wx.createSelectorQuery 取到）；
 *   2. 计时：web 用 `performance.now()`，小程序统一 `Date.now()`；
 *   3. 排帧：web 用全局 `requestAnimationFrame`，小程序优先用 canvas 节点的同名方法。
 * 牌面**优先用 CDN 位图（`utils/tileimg.js`），取不到就矢量绘制**：官方体检要求图片资源
 * 合计 ≤ 200KB、主包 < 1.5MB，34 张牌面塞不进代码包；矢量兜底保证 CDN/域名没配好时也能玩。
 *
 * 逻辑坐标恒为 1280×640（与 web 端一致），backing store 按 pixelRatio（上限 2x）重建，
 * 每帧 `setTransform` 映射；命中判定由页面把触摸点换算成逻辑坐标后调用 `hitTest()`。
 * 规则相关的取位（牌墙 slotPos / 精牌描边 / 风位 seatWind）全部走 shared 产物，不做二次实现。
 *
 * 2026-10-17：**画布内不再常驻自己的手牌带**（原本 52×70 逻辑 → 屏上仅 20×27，比画布下方
 * DOM 手牌条小一半且点不准）。出牌统一走 DOM 手牌条；画布只在摊牌（reveal）时展示一次
 * 自己的明牌，见 `drawRevealHand()`。
 *
 * 2026-10-18：**对手手牌背整条删除** —— 四条边原来画的是各家手牌背（22~32 逻辑宽），
 * 牌河被挤在环内只剩 24×32，真机上单张 9×12 完全看不清。现在四条边全部给牌河（46×58），
 * 副露挪进环内四侧（40×52），手牌张数改由铭牌上的「手牌 N」显示（`drawTag()`）。
 *
 * 2026-10-20：**局内改「侧视俯瞰」一点透视**（用户参考图确认：温和 0.58 / 牌背摞 /
 * 四边梯形牌河 / 仅小程序端）。牌桌与全部牌张过 `projQuad()`：逻辑梯形再逐角投影，
 * `d(y)=0.58+0.42·y/640` 只收敛 x、y 不动 —— **逻辑网格（riverPos/meldPos/slotPos/
 * 中心盘）一行不改**，牌张无热区故无需逆变换；zw 宽度补偿按分区深度配（远河 1.14、
 * 牌墙 1.3…），不补偿则顶边牌面只有原来的 60%。牌墙改静态层离屏预合成（`_wallCache`，
 * 272 张全走四边形切片，只在 removed 变化的帧重绘）。中心信息盘重排为
 * 「牌墙大数字 | 骰子 | 立精」两栏（风位撤到铭牌，四角铭牌本就带风位·昵称）。新增
 * `drawHandStacks()`：三家对手各一摞级联牌背贴铭牌内侧。**HUD 不投影**（铭牌/中心盘/
 * 骰子/横幅/气泡留在逻辑坐标）→ hitTest 与 fitCanvas 的均匀换算都不动。
 *
 * 2026-10-20：**按用户参考图（商业麻将牌桌实机）做「氛围对齐」** —— 只借鉴其结构与
 * 信息分工，不复制雕花框/头像框/徽标等受保护资产，全部用自有矢量画法重绘：
 *   · 桌面换藏青 + 暖金双线框（`drawTable`）；
 *   · 牌背蓝→绿（`paintTileBack`），墙/手牌摞/暗杠/幽灵牌一起换；
 *   · 牌墙从「深色底衬+平面小牌」升级为**满铺绿背立体墙**：`WALL_TILT` 去掉
 *     `fx:'flat'` 改缓 Lean，全套 3D 代价由 `_wallCache` 离屏预合成吸收
 *     （只在 removed 变化的帧重绘）；`WALL_PITCH` 30→28 / `WALL_ACROSS` 26→28，
 *     相邻牌 zw 补偿后 x 向 ~30px > 螺距 28 → 墙缝弥合，成「一面墙」观感；
 *   · 中心信息盘换深色牌匾皮并精简为「大数字 + 风字 + 立精」（骰子面对面改 9px
 *     小字、撤「牌墙」文字标签）—— 外框 532..750×256..396 不变，几何零变化；
 *   · 四角铭牌头像化：风位圆牌（金边/庄家金底）+ 昵称 + 积分，庄/宝×N/手牌N
 *     胶囊与状态行不变；`tagRects` 尺寸不变 → hitTest/气泡/表情锚点零移动。
 *
 * 2026-10-28 C1「手牌入画布 + 中央徽章化」（方案 docs/guides/plan-c1-hand-into-canvas.md）：
 * DOM 手牌带与状态行撤除（R3），自家手牌画进画布底沿 —— `drawMyHand`（HUD 平面
 * 84×110，**单击一张 = 出一张**，claims 期整行蒙罩禁点），状态行画进画布顶端
 * —— `drawStatusBar`（文案由 game.js 经 `table.statusBar` 下发；「本局结算 ▲」
 * 可点，命中走 `onSettleRestore`）。中央盘徽章化 320×196 → **200×88**，
 * 牌河格 48×63 → **55×72**（上下河区各得 ~140 逻辑高，贴住手牌/手排）。
 * 副露行改贴「靠手牌那一行」（自己=块底、对家=块顶）避侧河带。当年「画布内
 * 手牌 20×27 点不准」的否决前提（画布物理 ~500px 宽）已随 R3 撤带反转。
 *
 * 2026-10-30 **牌河间距两轮定稿**（用户真机截图反馈）：
 *   · 第一轮报「重叠遮挡」（圈四家牌河 + 上下家副露/摊牌/手牌）→ 行距一度改成
 *     = 牌边长（零叠压）；同轮顺带修中央出牌方提示（见下）。
 *   · 第二轮报「有空隙、像一层层楼梯、不在一个平面」（贴图边缘留白导致几何 0 缝
 *     视觉有缝）→ **定稿为小幅重叠几个像素**：`RIVER_LAP_FAR = RIVER_H − 6`、
 *     `RIVER_LAP_SIDE = RIVER_W − 5`、列距 = 牌宽 − 3、副露组内竖 5/横 4、
 *     摊牌单排步距 − 4、对家手排步距 − 5 —— 牌面仍露 88~91%，缝与台阶感同时消失；
 *   · 格子维持第一轮的缩幅：上下河 60×80 → **44×58**、左右河 80×60 → 58×44，
 *     四家锚点重解（`riverOrigin` 内有逐条推导）；
 *   · 结算上下家摊牌 14 张改 **≤7 张一列、折双列**（`REVEAL_COLS_MAX`）；
 *   · 第三轮用户逐家点名**叠压方向** → 绘制次序统一为「**后出的在上层**」
 *     （= 出牌顺序，删 2026-10-22 的 reverse 规则）：自己下排盖上排底、
 *     对家上排盖下排顶、上下家下一张盖上一张；描边收口按 `visAlign` 分朝向；
 *   · 第四轮「铭牌直接放四个角」→ 底部两块改 **44×88 竖角标**贴底角
 *     （手牌行 84→75 宽让出两端 9px），右上按**微信胶囊实测下移**
 *     （game.js `applyTableFrame` 换算 `table.capsuleRect`）；
 *   · 第五轮「想让这些牌像在同一个平面」→ 曾按用户方案**裁掉平放牌贴图底部的
 *     立体条**（faceA..D 占格高 11.7~12.5%）并配平铺间距；
 *   · 2026-10-31 用户最终澄清「**我要的是牌压着牌** —— 贴图的各个视角底部显示
 *     就是为了叠压更立体；并排不叠加就不像并排在一起」→ **撤销裁条**
 *     （`FLAT_FACE_CUT = 0`，`flatBox` 恒等）+ **恢复中压叠压**（上下行距 43 露
 *     74%、左右 39/列 50/41、副露组间回 14 分组档）—— 交界观感 = 下一张白边
 *     压住上一张的立体底条（厚度过渡）；
 *   · 中央提示从「116×26 箭头条贴徽章边线」（C1 后条有 22px 探进徽章、盖住牌墙
 *     数字与立精）改为「**该侧边线加粗发光 + 朝外小三角**」（`drawDirectors`，
 *     素材 `room_time_*` 退役），与徽章内容零重叠。
 *
 * 2026-11-01 **D 方案「四家牌面统一我的视角」试行与回退**（docs/guides/plan-d-uniform-face.md）：
 * 当日曾把 `SEAT_FACE` 统一 faceA（全员朝观看者）+ 左右河/副露/摊牌转置为正向格，
 * 同日用户实测后**定稿回退四套图集方案**：渲染本就视角相对（每台设备上设备主人恒为
 * 底部、自己的区域恒用 faceA 正向大牌绘制），四套图集「牌面朝牌主」即可让
 * 各家看自己家 = 我看我家的效果，且保有真实牌桌的方位感。全程记录见方案文档。
 *
 * 2026-11-03 **十字布局（用户手绘分区图定稿）**：四家牌河改绕中央徽章十字分布 ——
 * 对家/自己河居中上/下带（5 列 × 2 行，cap10）、上/下家河贴徽章左右（3 列 × 3 行，
 * cap9）；副露每家**两个块**（对家/自己 = 河块两侧，上/下家 = 河块外翼上下各一块），
 * 每块 ≤2 组、现行几何 scale 恒 1；上/下家手牌摞贴左右边缘（x54/x1196）；
 * 结算摊牌改专属带（对 y26 / 自 y506 / 侧双列 x54、x1120）。**容量从 22/24 收到
 * 10/9**：满容量几何放不进十字分区（44×58 牌 + 全可见约需四边整带），超出的弃牌
 * 沿用 `riverCell` 的 cap 机制压在末格。本轮只改小游戏端 —— 小程序端 table.js
 * 待同步（mg_geomcheck 的 parity 检查临时降级为警告）。
 */

const { tileName, seatWind, suitOf, rankOf } = require('../lib/shared/tiles.js');
const { RING_SLOTS, SEG_LEN, SEG_START } = require('../lib/shared/wall.js');
/** 牌面走 CDN（代码包零图片，见 utils/tileimg.js）；未就绪/失败一律回退矢量 */
const tileimg = require('./tileimg.js');
/** UI 贴图（牌背/庄标/大数字）：CDN 清单，取不到各绘制点回退矢量/文字 */
const uiart = require('./uiart.js');
/** 头像资源（2026-11-04）：铭牌头像绘制，清单下发 + 画布预解码，缺图回退风位圆 */
const avatarart = require('./avatarart.js');
/** 操作动画用哪张贴图（2026-10-23：中心区改用贴图字样） */
const OP_FX_ART = { chi: 'chi', peng: 'peng', gang: 'gang', angang: 'gang', bugang: 'gang', hu: 'hu' };
/** 触发中心操作动画的动作类型（2026-10-23 动画仲裁用） */
const ACTION_FX_KINDS = ['chi', 'peng', 'gang', 'angang', 'bugang', 'hu'];
/** 操作动画总时长（ms） */
const ACTION_FX_DUR = 1200;

const W = 1280;
const H = 640;
/**
 * 牌张尺寸（2026-10-24 第八轮，**牌河改 6 列 × 3 行 + 格子再放大 26%**）。
 *
 * 上一轮（38×50）不够用：画布物理只有 ~500×250 CSS px（`w = min(行宽−88, 行高×2)`，
 * 横屏下恒被行高卡住），34~38 逻辑宽的牌落到屏上只有 12~15 CSS px。
 * 而**牌的尺寸不是被画布卡住的，是被「每行几张」卡住的** —— 牌河每边要塞 24 张、
 * 分 3 行就意味着一行 8 张，一行 8 张就意味着一格只能 38 宽。把每边容量降到
 * **18 张（6 列 × 3 行）**，同样的区域里每格就能长到 48×63（+26%）。
 *
 * 为什么是 18：一局里单人最多弃 ~17~18 张（13 张起手 + 牌墙 67 张四家分），
 * 偶尔多出一两张仍由 `riverCell` 的「溢出压末格」兜住（叠在最后一格上）。
 * 每行 6 张也更接近真实麻将的牌河观感（原来 8 张一行偏宽）。
 *
 * 侧边（上家/下家）在牌主视角里也是「6 列 × 3 行」，屏幕上竖过来放：
 * 3 个竖列 × 6 行，因此 `cols: 3, rows: 6` —— 用的是**同一套 48×63 格子**，
 * 四家格子严格同尺寸（副露复用同格，见 `meldMetrics`）。
 *
 * ⚠ 四块牌河的原点必须重新解（贴盘侧钉死、往外圈长），否则贴盘那侧会被吃掉。
 * 解出来的屏幕矩形（见 `.recover-tmp/geomshot.mjs` 实校）：
 *   自己 495.7..784.3 × 426..556.2   对家 519.4..760.6 × 105.1..214
 *   上家 295.4..466.0 × 234.3..405.7  下家 814..984.6（关于 640 镜像）
 * 中心盘 480..800×226..422 一个像素没动。
 */
/**
 * 牌张尺寸（2026-10-28 C1「手牌入画布」再放大：48×63 → **55×72**）。
 *
 * C1 把 DOM 手牌带/状态行撤进画布（见文件头 2026-10-28 段），画布物理高度
 * 229 → ~356 CSS px，同样的 1280×640 逻辑里每张牌都能再长 15%。纵向预算
 * 重排后：对家河 t≈98、自家河 b≈506，河区各得 ~140 逻辑高 → 2 行 72 + 叠压。
 * 副露/摊牌尺寸全部由 RIVER_W/H 派生（`meldMetrics`/`REVEAL_*`），会跟着长。
 */
/**
 * 牌张尺寸（2026-10-30 两轮反馈后定稿：缩格子 + **小幅重叠**）。
 *
 * 60×80 时代上下河行距只有 37（露 46%）、左右河 30（露 50%）—— 每排被下一排盖掉
 * 一半，用户在真机截图上圈了四家牌河 + 上下家副露/摊牌/手牌，要求**减少遮挡**。
 * 纵向空间是固定的（徽章 254..342、自家手牌 520、对家手排 100），
 * 叠压大减后 3 行/6 行块高接近翻倍，只能缩格子：
 *   · 上下河 60×80 → **44×58**（-27%）：自家 3 行 = 3×58×0.91 ≈ 159 ≤ 166 可用；
 *     对家 3 行 ≈ 137 ≤ 142 可用（远端 k≈0.79 反而放得下更大的逻辑牌）。
 *   · 左右河横版 80×60 → **58×44**：6 行 ≈ 241，块居中 y200 起。
 * 第一轮先做了「零叠压」，第二轮报**空隙/楼梯**改小幅重叠，第三轮裁立体条后
 * 仍见深色接缝 → 行距最终定为**盖住圆角/阴影**（见 `RIVER_LAP_*`：行盖 6~8、列盖 6）。
 * 副露/摊牌尺寸全部由 RIVER_W/H 派生，跟着一起缩（`meldMetrics`/`REVEAL_*`）。
 */
const RIVER_W = 44; // 牌格短边（左右河牌宽 / 摊牌宽）
const RIVER_H = 58; // 牌格长边（左右河牌高 / 摊牌高）
// ⚠ 2026-11-04 九轮起：**上下河（自己/对家）不再用这一对**，改 `RIVER_V_W/H`（36×50，
// 与 faceA/faceC 的竖版纵横比对位）。RIVER_W/H 现在只剩「左右河横版 58×44」和
// 「结算摊牌 44×58（REVEAL_*）」两处消费者。
const RIVER_DX = 39; // 历史兜底（riverOrigin 恒显式给 dx，已无实际调用）
const RIVER_DY = 56; // 同上
/**
 * **上下河（自己 / 对家）专用竖版牌格**（2026-11-04 九轮定"竖版"，十一轮定尺寸）。
 *
 * 原则与八轮修左右河时同一条：**牌格纵横比必须等于该座位图集单格的纵横比**。
 * 自己 faceA 184×256（0.719）、对家 faceC 168×240（0.700）都是**竖版**，牌格就得
 * 是竖版；九轮之前的「四家统一 44×44 方格」把竖版牌面 cover 进正方形 → **上下各
 * 裁 14%**（牌顶白边与底部绿区双双消失、字被拦腰切），用户蓝框点名的就是这个。
 *
 * 尺寸由**纵向预算反推**，而且这块地方**一个像素都不能再挤**：
 *   · 下（自己）：徽章底 306（含朝外小三角 → 314）~ 操作栏顶。操作栏是 DOM 浮层，
 *     逻辑顶 = `512 − 38/sc` —— 844×390 机型 = 445.7，**667×375（SE）最紧 = 437**，
 *     必须按最紧的一档算，否则小屏上牌河会钻到按钮底下。净窗 = 314→437 = **123**；
 *   · 上（对家）：对家手排底 89（+6 呼吸）~ 徽章顶 218（三角 210）。净窗 = 95→204；
 *   · 3 行 × 牌高 × k（d ≈ 0.89 / 0.81）必须塞进这两个窗 —— 直接解出 **41×56**
 *     与行距 38（块 = (2×38+56)×0.89 = 117 ≤ 121；上面 107 ≤ 109）。
 *   · 用户十一轮报「比上下家明显要小、两边还有空隙」：把中心徽章上移 12px
 *     （230→218，见 `CENTER_BADGE`）换来这 12px，牌从 36×50 抬到 41×56
 *     （**面积 +28%**，屏上 36.4×49.7 ≈ 左右河的 49.1×37.3，终于等面积）；
 *   · 列距 38 = 牌宽 − 3：五列块宽 4×38+41 = **193 逻辑 = 172 屏**，窗口 186 屏，
 *     两侧只剩 7px 边 —— 「两边的空隙」就是这个（原 142 屏 / 单边 22px）；
 *   · 行距 38 = 牌高 − 18（叠 32%）：比贴图自带的立体条 28% 多盖 4%，接缝不露灰带；
 *   · 纵横比 41/56 = 0.732 vs faceA 0.719 → cover 只裁 1.8%，且牌照常露顶 68%。
 * ⚠ 副露必须跟这套（`meldMetrics` 的 slot 0/2 分支同改），否则「同一家的副露
 * 比牌河大一圈」这个 2026-10-22 定死的老毛病会立刻回来。
 * ⚠ 想再放大只能动 `CENTER_BADGE`（盘高 88 已被内部数字/立精/标签排满）或操作栏，
 * 这两处都是牵一发动全身，别再在牌格上抠。
 */
const RIVER_V_W = 41;
const RIVER_V_H = 56;
const RIVER_V_DX = RIVER_V_W - 3; // 列距（叠 3，只盖住贴图左右边缘那圈绿/暗边）
const RIVER_V_DY = RIVER_V_H - 18; // 行距（叠 18 = 32%，盖住立体条 28% 再多切 4%）
/**
 * 牌河**排间间距**（2026-10-31 第五轮终稿：**恢复叠压·中压档 + 立体条**）。
 *
 * 用户最终表态（一日内第三次反转，以本稿为准）：「我要的是**牌压着牌** ——
 * 我的牌贴图是有各个视角的底部显示（立体条），所以看起来才能更立体；
 * 直接并排不叠加覆盖，就不像这些牌并排在一起」→
 *   · **恢复立体条**（撤销同日的 FLAT_FACE_CUT 裁切，见该常量的时间线注释）；
 *   · **恢复叠压（中压）**：上下河行距 43（盖 15 → 露 74%，立体条全压进下张下，
 *     用户在三档里选定）；左右河行距 39（y 向盖 5，条在列向）；
 *   · 上下河列距 41（叠 3 压圆角）、左右河列距 50（盖 8 压条 + 圆角，条在列向）。
 * 叠压交界的观感 = 下一张的白边压住上一张的**立体底条**（厚度过渡），
 * 这正是立体条存在的意义 —— 之前历轮"台阶/额外显示"的真凶是**裁条后的生硬
 * 切口**，不是叠压本身。
 *
 * 中间两轮的尝试（记录防重蹈）：
 *   · 裁条+叠压（10-30 晚）→ 交界生硬轮廓 →"还是像楼梯"；
 *   · 并排细缝（10-31 上）→ 丢掉压叠立体关系 →"不像并排在一起"（本稿否定）。
 *
 * 谁盖谁（用户点名方向）：**后出的在上层** —— 自己下排盖上排底、对家上排盖
 * 下排顶、上下家下张盖上张；描边收口 `riverVisH`/`visAlign` 配对不变。
 * **一块牌河用同一个投影比 k**（`riverK`），行列严格对齐；
 * ⚠ 行距必须乘同一个 k（`riverPos` 里 `row*dy*k`）。
 */
const RIVER_LAP_FAR = RIVER_H + 2; // 上下河行间留 2px
const RIVER_LAP_SIDE = RIVER_W; // 侧河牌完整露出
// —— 2026-11-01 用户「左右家的牌也要像我家一样牌压着牌没缝隙」：原 39 只盖 5，
// 盖不住贴图 ~5.5px 立体底条 + 2px 白边 + 圆角 → 条带/缺口全露成台阶；33 与自家河
// 的平面感对齐（条 5.5 + 白边 2 + 圆角 3.5 ≈ 11 全盖住）。
/**
 * 自家手牌行（2026-10-28 C1：DOM 手牌带撤除，画进画布底沿，见文件头）。
 *
 * 尺寸按「屏上与旧 DOM 手牌持平」反推：C1 后画布 scale ≈ 0.556（356/640），
 * DOM 牌位 46×66 → 逻辑 ~83×119；取 **75×110**（屏上 42×61）+ 6 缝：
 * 14×(75+6)−6 + 摸牌跳出 18 = **1146** → 居中 x67..1213。
 * **HUD 牌**（STAND_HUD，proj:false）不吃透视 —— 手牌是离玩家最近的牌，
 * 投影缩了会比河牌还小。行顶 y520、行底 630（画布留 10）；
 * 选中/点击热区在 `hitTest` 的 handRects。
 *
 * 2026-10-30（铭牌贴四角那轮）：宽 84 → **75** —— 底部两角改放 44 宽的竖角标
 * （x14..58 / x1222..1266），最坏 14 张必须整体让出两端：x67−58=9、
 * 1222−1213=9，两侧各留 9px 缝。屏上 47→42px，点按仍够（当年 C1 的 84 底线是
 * 「与旧 DOM 46×66 持平」，为贴角牺牲 5px 宽度，高度 110 不变）。
 */
/*
 * 2026-11-02 三轮「手牌通栏置底」（用户要求）：手牌显示区直接放底部、**宽度占满
 * 横向**——左右角标/竖标全部迁到别处（见 drawTag），行宽只受画布约束：
 * 14 张 = 14×90−6+18 = 1272 ≤ 1280（两端各 4px）→ **84×124**（+11%/+11% vs 76×112），
 * MY_HAND_Y = 640−124−4 = **512**（底 636，留 4）。操作栏浮在手牌上方（y486..510，
 * 见 src/chrome.js / layout.game）。
 */
const MY_HAND_W = 84;
const MY_HAND_H = 124;
const MY_HAND_GAP = 6;
const MY_HAND_DRAWN_GAP = 18;
const MY_HAND_Y = 512;
/**
 * 两段式出牌的「抬高」位移（2026-11-04 防误触）：第 1 击选中后整张上移 26
 * （顶 512−26=486，底 610，仍在画布内；操作带 y486..510 只在 claims 期出现，
 * 而 claims 期 raise 已复位，不会同时压牌）。
 */
const MY_HAND_RAISE = 26;
/**
 * 牌墙开关（2026-10-20 用户决策：**取消四边牌堆**，把空间让给牌河/副露/手牌）。
 *
 * 关掉后：`drawWall` 只保留两个不可见副作用 —— ① `prevRemoved` 记账（发牌动画的
 * 「牌从墙里飞出来」仍按原逻辑生成 ghost）；② `wallLeft` 仍由 `computeRemoved` 算出，
 * 中心盘照常显示剩余张数。**牌墙本体（底衬环 + 272 张牌背）不再绘制**，
 * 原来被它占掉的四条 30px 带子全部交给牌河与副露。
 * 想恢复：把常量改回 true 即可（`wallSegs/slotPos/paintWall` 都还在）。
 */
const SHOW_WALL = false;
/**
 * 副露的格子**直接复用牌河的尺寸**（2026-10-22 第十轮）。
 *
 * 历史：最早是写死的 40×52（横版美术塞竖格 → 压扁）；后来改成「按图集比例反推」
 * （侧边 44 高 → 54 宽），牌不扁了，但**比牌河牌（44×34）大一圈**。而副露与牌河
 * 在同一家面前是**并排的两列**，一个宽 54、一个宽 44，屏幕上就是「粗细不一、
 * 上下对不齐」，怎么调锚点都救不回来（用户「左右存在偏移」）。
 *
 * 现在：侧边 44×34、上下 34×44，与牌河**完全同形**。图集比例（59/48=1.229）
 * 与牌河格（44/34=1.294）只差 5%，统一到牌河格肉眼看不出来，并排立刻齐。
 */
/**
 * 侧边副露的组内叠压（2026-10-30 **已废除**）：曾是 0.62（2026-10-22 第九轮
 * 「上下家的副牌也要像手牌一样叠放」），2026-10-30 用户反过来报「上下家的副牌
 * 存在同样的遮挡问题」→ pitch 从 0.62× 改为牌边长减几像素（小幅重叠，见 `meldMetrics`）。
 */
// 2026-10-20 牌墙加密加宽（用户参考图为「一面墙」的满铺观感）：
//   PITCH 30→28：相邻牌 zw 补偿后 x 向 ~30px，略大于螺距 → 墙缝弥合、连续墙面；
//   ACROSS 26→28：牌面更宽；侧墙内缘 284+28=312，仍离左副露列 x330 有 18px。
//   横墙 span = 19×28+22 = 554（x363..917），竖墙 span = 13×28+22 = 386（y127..513），
//   与四向牌河/副露/铭牌的间距都经几何校验复跑确认（geomcheck 全绿）。
const WALL_PITCH = 28;
const WALL_LAYER = 7;
const WALL_ACROSS = 28;
const WALL_ALONG = 22;
const WALL_BOTTOM_Y = 473;
const WALL_TOP_Y = 122;
const WALL_LEFT_X = 284;
const WALL_RIGHT_X = 974;
const WALL_V_LIMIT = 540;
const GHOST_MS = 420;
/**
 * 铭牌气泡（2026-10-23 放大，用户报「聊天气泡太小不好查看」）。
 *
 * 画布是 **1280×640 逻辑定尺**，而手机横屏实际只把它缩到 ~0.46~0.52 倍显示
 *（行高卡住宽：canvasW = min(行宽−88, 行高×2)），所以画布里的 12px 字
 * 落到屏幕上只有 **5.5~6px** —— 聊天内容根本看不清（桌面宽窗也才 9px）。
 * 这里按 **~1.8 倍**整体放大，字号 / 行高 / 内边距 / 圆角 / 尾巴 同比例，
 * 避免「大字号塞进小胶囊」：
 *
 *   字号 12 → 22（表情气泡 14 → 26）   · 行高 15 → 30
 *   窄侧宽 138 → 240 / 宽侧 230 → 340   · 最多行数 3 → 4
 *   内边距 (9,6) → (15,11) · 圆角 8 → 13 · 尾巴 6/7 → 9/11
 *
 * 落到屏幕上的实际字号：手机横屏 ≈ 10~11px、桌面宽窗 ≈ 17px（原 5.5~9px）。
 * 停留时间同步 4.2s → 5.2s，4 行中文才有足够阅读时间。
 */
const BUBBLE_W_NARROW = 240;
const BUBBLE_W_WIDE = 340;
const BUBBLE_LINE_H = 30;
const BUBBLE_MAX_LINES = 4;
const BUBBLE_MS = 5200;
const BUBBLE_FADE = 420;
/** 气泡字号（画布 px）：普通聊天 / 互动表情 */
const BUBBLE_FONT = 22;
const BUBBLE_FONT_EMOTE = 26;
/** 气泡内边距与圆角（随字号一起放大） */
const BUBBLE_PAD_X = 15;
const BUBBLE_PAD_Y = 11;
const BUBBLE_RADIUS = 13;
const EMOTE_MS = 1250;
const EMOTE_FLY = 0.38;
/** 小程序无 "Microsoft YaHei"，统一用系统默认族（iOS/Android 各自回退到中文字体） */
const FONT = 'sans-serif';
const EMOJI_FONT = 'sans-serif';

const SUIT_CHAR = { m: '万', s: '条', p: '筒' };
const SUIT_COLOR = { m: '#c62828', s: '#1b7f3b', p: '#1f5fbf' };

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function font(px, bold) {
  return `${bold ? 'bold ' : ''}${px}px ${FONT}`;
}

/**
 * 3D 立体牌面（2026-10-18 方案落地）。
 *
 * 画布内牌张**没有点击热区**（`hitTest()` 只剩掷骰按钮与四角铭牌，见文件头），
 * 所以可以在**不动任何布局坐标**的前提下，把每张牌的屏幕外观改成
 * 「底边锚定 y+h、顶边收窄、整体后仰」的梯形 —— tilt 只改外观四边形。
 *
 * 分区参数（视角俯仰 ~26°~30°、等效透视 f≈1400）：
 *   sq = 垂直压缩（≈cos 俯仰角）；ts = 顶边宽度比；dz = 深度缩放（锚定底边中点）。
 *   牌河按离视点远近分三档（自己侧最挺、对家最趴）；副露缓倾保可读；
 *   中心精牌是「立牌」展示态（最挺 + 略放大）。牌墙保持平面（量大且是背景）。
 * `TILE_TILT.on=false` 可整体退回平面（低端机降级开关）。
 */
const TILE_TILT = {
  on: true,
  slices: 8,
  // 结算相位也曾降到 4，但「条中心采样」近似下欠覆盖 = 半条高×边斜率：
  // over 相位侧边牌（x1022..1260、d0.63..0.94）斜率可达 0.32，4 条欠 1.9px、
  // 牌角露出底衬/厚度边。over 相位只静态渲染一次（无 rAF），切片数无性能代价 → 8。
  lowSlices: 8,
  zones: {
    /*
     * 2026-10-21 第三次修正（用户报「牌桌上的牌显示异常」）：**全部拉平**。
     *
     * 之前每个分区都带 sq<1（垂直压缩）+ ts<1（顶边收窄）—— 那是「牌斜立在桌上」
     * 的观感来源，但它把一张牌变成楔形，而牌面贴图是靠横切片重采样铺上去的，
     * 楔形 + 重采样 = 笔画被逐条拉斜、侧沿出现台阶。真机截图上牌河里的牌之所以
     * 像「歪的平行四边形」，就是这两项叠加。
     *
     * 现在的分工很干脆：
     *   · **纵深全部交给位置**（projQuad 的 rect 模式：越远的牌越小、越向中线收）；
     *   · **立体感交给阴影 + 底部厚度边 + 顶光**（三样都还在，且都不改几何）；
     *   · Lean 参数保留成常量以便随时调回，但当前取「无倾斜」。
     * 回报是牌永远是一张正矩形、笔画永远不被重采样拉歪 —— 认牌优先。
     */
    riverSelf: { sq: 1, ts: 1, dz: 1, zw: 1, edge: 0, shadow: 0 },
    riverSide: { sq: 1, ts: 1, dz: 1, zw: 1, edge: 0, shadow: 0 },
    riverFar: { sq: 1, ts: 1, dz: 1, zw: 1, edge: 0, shadow: 0 },
    meld: { sq: 1, ts: 1, dz: 1, zw: 1, edge: 0, shadow: 0 },
    // standing（中心盘立精）挪到文件下方 STAND_HUD：HUD 牌，带 proj:false
  },
};

/**
 * 解析绘制分区（2026-10-20 透视改造）：**投影（PROJ）与 Lean（TILE_TILT）两轴独立**。
 *   · zw = 宽度补偿（远处被横向压缩后放大保可读）—— 属投影轴，PROJ.on 时常开；
 *   · sq/ts/dz = Lean —— 属 3D 轴，仅 TILE_TILT.on 且分区 fx 非 'flat' 时生效；
 *   · fx:'flat' = 只投影、不要 Lean/投影贴片/厚度/顶光（2026-10-20 前牌墙走这一档；
 *     墙升立体后已无分区使用，低端机降级走 PROJ.on/TILE_TILT.on 而非 fx）；
 *   · tilt.proj===false（STAND_HUD）= HUD 牌：可 Lean 但不投影。
 * 返回 null = 纯平面（旧绘制路径；两轴全关或未传分区时）。
 */
function resolveZone(tilt) {
  if (!tilt) return null;
  const proj = PROJ.on && tilt.proj !== false;
  const lean = TILE_TILT.on && tilt.fx !== 'flat';
  if (!proj && !lean) return null;
  return {
    sq: lean && tilt.sq ? tilt.sq : 1,
    ts: lean && tilt.ts ? tilt.ts : 1,
    dz: lean && tilt.dz ? tilt.dz : 1,
    zw: proj && tilt.zw ? tilt.zw : 1,
    fx: lean ? 'full' : 'flat',
    proj,
    // 2026-10-22：**是否再画一条引擎自造的"厚度白边"**。源项目的牌面贴图自己就带
    // 底部白檐（bb1.png 下面那圈），再叠一条 = 牌底多出一块白域（用户报的就是这个）。
    // 所有牌行分区一律 edge:0，只有矢量兜底（无贴图）时才需要它。
    edge: tilt.edge !== 0,
    shadow: tilt.shadow !== 0,
    // 2026-10-21：牌张一律走「牌心单点透视 → 纯矩形」，牌内不再有楔形畸变。
    // 桌面（drawTable 直接传 {proj:true}，不经此处）仍走逐角梯形，保留整体纵深。
    rect: true,
    // 叠压牌河用：这张牌**实际露出的高度**（被下一行盖掉的部分不算），
    // 给 `jingBorder` 收口用；不传 = 整张牌都露着。
    visH: tilt.visH,
    // 牌河块统一投影比（2026-10-22）：整块当刚体缩，行列才对齐（见 projQuad 的说明）
    k: tilt.k,
    // 用哪张贴图当牌背（2026-10-22）：暗杠扣牌要 `back_op`（源项目 opposite_block_back_0），
    // 不传 = 默认 `back`（金顶白边那张）
    backKey: tilt.backKey,
  };
}

/** 牌河/摊牌的 tilt 按屏幕槽位取（0=自己侧底边、1/3=左右、2=对家顶边） */
function tiltForSlot(slot) {
  if (slot === 0) return TILE_TILT.zones.riverSelf;
  if (slot === 2) return TILE_TILT.zones.riverFar;
  return TILE_TILT.zones.riverSide;
}

/**
 * 牌张朝向（2026-10-20 修「各方位牌都朝我竖着」）：
 * **每家的牌都朝牌主** —— 自己 0°、下家（右侧）-90°、对家 180°、上家（左侧）+90°。
 *
 * 为什么是绕「投影四边形中心」旋转，而不是在逻辑坐标里转：投影只收敛 x（见 PROJ 注释），
 * 逻辑旋转后再投影会让收敛方向跟着转错；先按原位算出投影四边形、再绕自身中心转，
 * 牌的位置与大小不变、只是朝向变了 —— 也正是「他的牌他看得正」的物理效果：
 * 旋转后牌面的远端（窄边）统一朝向桌子中心。
 */
const SLOT_ROT = [0, Math.PI / 2, Math.PI, -Math.PI / 2];

function rotForSlot(slot) {
  // 2026-10-22 定稿：**一律 0**。四套图集按源图原样入图集（每套本来就是该座位的视角画好的），
  // 谁的牌朝谁已经做在美术里；这里再转一次就是双重旋转。
  return 0;
}

/**
 * 牌河/副露/摊牌用的「按座位平放牌」图集键（**定稿：四套图集**，2026-11-01 确认）：
 *   0 下 = faceA（first，46×64 竖版） · 1 右 = faceB（second，48×59 竖版）
 *   2 上 = faceC（third，42×60 竖版） · 3 左 = faceD（fourth，48×59 竖版）
 * 每家的牌面**朝向牌主**。同日 D 方案曾试行「四项统一 faceA（全员朝观看者）」，
 * 用户实测后定稿回退本方案 —— 渲染本就视角相对（每台设备上设备主人恒为底部、
 * 自己的区域恒用 faceA 正向大牌绘制），四套图集让「每家的牌面朝向牌主」，
 * 各家看自己家的效果与我看我家完全一致（docs/guides/plan-d-uniform-face.md 有全程记录）。
 * 图集未就绪/部署漏带时 `tileimg.faceArt()` 返回 null → 各绘制点自动回退竖版立牌。
 * （2026-10-23：平放牌图集归牌面大类 —— /api/tiles 的 faces 子清单，入口统一到 tileimg）
 */
const SEAT_FACE = ['faceA', 'faceB', 'faceC', 'faceD'];

/**
 * 平放牌贴图**底部立体条**的裁切比例（faceA..D 占格高 11.7~12.5%）。
 *
 * 时间线（2026-10-30~31 六轮往返）：裁条+中压叠压曾解决旧大格（52×68 时代）
 * 的条带/台阶误读。
 *
 * **2026-11-04 归零**（用户「牌看起来像被裁剪过」）：十字布局把牌格收到
 * 44×44/44×46 后，三层裁剪叠加（cover 居中裁带 → 砍底 12.5% → 行叠压盖底）
 * 让小格里的牌面只剩中间一条、字被切头切尾；且现行所有河/副露/摊牌均已
 * 互相叠压盖边，透明条空区不再有露出场景 —— 裁条机制整体失去意义。
 * 归零后贴图**满格铺满**，牌面完整；行叠压盖住的是照片自带的底边（立体条
 * 观感由贴图本身承担，与 10-31 用户「底部显示为了立体」诉求一致）。
 * `flatBox` 随之为恒等（描边/金框收口到整格）。
 */
const FLAT_FACE_CUT = 0;

/**
 * 平放牌**内容框**（裁掉立体条后牌内容的实际范围）——描边/金框/赢家框按它收口，
 * 否则框会画进条侧的裁切空区（悬在"空气"上）。
 * 条侧由 `rot` 决定（转前格底经旋转后落在哪条边）：0/不转=底、−90=右、180=顶、+90=左。
 */
function flatBox(rot, x, y, w, h) {
  if (rot === undefined || rot === null) return { x, y, w, h }; // HUD 立牌（手牌/立精）不裁
  if (!rot) return { x, y, w, h: h - h * FLAT_FACE_CUT }; // 不转：条在底（厚 = h 向 12.5%）
  if (Math.abs(rot + Math.PI / 2) < 0.01) {
    const c = w * FLAT_FACE_CUT; // −90：条转到右 —— 条厚 = 转前内框高 = w 向 12.5%
    return { x, y, w: w - c, h };
  }
  if (Math.abs(rot - Math.PI / 2) < 0.01) {
    const c = w * FLAT_FACE_CUT; // +90：条转到左
    return { x: x + c, y, w: w - c, h };
  }
  if (Math.abs(Math.abs(rot) - Math.PI) < 0.01) {
    const c = h * FLAT_FACE_CUT; // 180：条转到顶（厚 = h 向 12.5%）
    return { x, y: y + c, w, h: h - c };
  }
  return { x, y, w, h: h - h * FLAT_FACE_CUT };
}

/**
 * 该牌是否精：1=正精、2=副精（gz 优先，老字段 jingPi/jingFu 兜底 ——
 * 南昌/赣州等玩法无关，服务端有 gz 就按 gz 判）。
 */
function jingKindOf(view, tile) {
  if (!view || tile === undefined || tile === null || tile < 0) return 0;
  const gz = view.gz;
  if (gz && gz.zheng && gz.zheng.length && tile === gz.zheng[0]) return 1;
  if (gz && gz.fu && gz.fu.length && tile === gz.fu[0]) return 2;
  if (tile === view.jingPi) return 1;
  if (tile === view.jingFu) return 2;
  return 0;
}

/**
 * 牌角三角彩标（2026-10-31 用户图样：牌角三角 + 金字；三改逐轮放大 ——
 * 首版三角 24%/字 15px 真机看不清 → 二改 36%/0.26w → **三改（同日，用户仍嫌小）：
 * 按牌短边定标，三角目标 32px、上限 50% 短边；字 0.36×短边（clamp 13..28）**。
 * 用短边而不是宽定 u：横版格（58×44）与竖版格（44×58）短边一侧的直角边同大，
 * 三角形两条直角边各按自己那条边 × u（比例跟牌走，不变形）。正精 = 饱和橙红底、副精 = 亮紫底，**金字加黑描边**提对比；
 * 金边 1.5。`z` 可选：投影 zone —— 有则按 projQuad 左上角画（跟随透视），
 * 无（HUD 平面牌）按矩形角；字不随透视旋转，保持可读。
 * 同款式复用：`text`/`bg` 可覆盖字与底色 —— 报杠展示（drawDeclared 三张各一个）传
 * ('杠', '#16191e') 画墨黑底「杠」字角标（2026-10-31 用户要求，二改与精标配色区分）。
 */
function drawJingMark(ctx, kind, x, y, w, h, z, text, bg) {
  const ch = text || (kind ? '精' : '');
  if (!ch) return;
  const pts = z
    ? projQuad(x, y, w, h, z)
    : [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
  const tl = pts[0];
  const tr = pts[1];
  const bl = pts[3];
  const ms = Math.min(w, h); // 短边定标：横竖牌同大、三角形不随长边变形
  const u = Math.max(0.36, Math.min(0.5, 32 / Math.max(1, ms))); // 三角边 = 短边的 36%~50%（绝对目标 32）
  const ax = tl.x + (tr.x - tl.x) * u;
  const ay = tl.y + (tr.y - tl.y) * u;
  const bx = tl.x + (bl.x - tl.x) * u;
  const by = tl.y + (bl.y - tl.y) * u;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(tl.x, tl.y);
  ctx.lineTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.closePath();
  ctx.fillStyle = bg || (kind === 1 ? '#e0463a' : '#9b4fe0');
  ctx.fill();
  ctx.strokeStyle = '#ffd75e';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  const size = Math.max(13, Math.min(28, Math.round(ms * 0.36)));
  ctx.font = font(size, true);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const cx = (tl.x + ax + bx) / 3;
  const cy = (tl.y + ay + by) / 3 + 1;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 2.5;
  ctx.strokeText(ch, cx, cy); // 黑描边：真机小尺寸下金字在紫/红底上不糊
  ctx.fillStyle = '#ffd75e';
  ctx.fillText(ch, cx, cy);
  ctx.restore();
}

/**
 * 侧边（slot 1/3）是**横向格**（副露 56×44、结算牌河与摊牌 62×50）：源图横版美术
 * （59×48）直接铺满即可，**不能再把内容转 90°** —— 转完内框变 44×56 竖版，
 * 横版图会被裁掉 36% 宽度（2026-10-21 实测）。底边（0）/顶边（2）是竖版格，仍走 0/180°。
 */
function flatRotForSlot(slot) {
  // 副露/摊牌与牌河一致：美术已按座位朝向，绘制不转
  return 0;
}

/** 把一个四边形绕某点旋转（供结算高亮等「存下来的四边形」跟随牌朝向） */
function rotQuad(q, cx, cy, rot) {
  if (!rot) return q;
  const s = Math.sin(rot);
  const c = Math.cos(rot);
  return q.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
  });
}

/** 投影四边形的中心（旋转锚点） */
function quadCenter(q) {
  const x0 = Math.min(q[0].x, q[3].x);
  const x1 = Math.max(q[1].x, q[2].x);
  return { x: (x0 + x1) / 2, y: (q[0].y + q[3].y) / 2 };
}

/**
 * 牌张旋转锚点（2026-10-20 保留给未来的「整体旋转」用；当前朝向做在贴图里，见 rotFace）。
 * 注意不能用投影四边形的包围盒中心：投影只缩 x，质心与包围盒中心不重合，绕后者转会位移。
 */
function tileAnchor(x, y, w, h, tilt) {
  const z = resolveZone(tilt);
  const cx = x + w / 2;
  const cy = y + h / 2;
  if (z && z.proj === false) return { x: cx, y: cy };
  return projPt(cx, cy);
}

/** tilt 后的实际绘制盒（dz 深度缩放，锚定底边中点） */
function tiltBox(x, y, w, h, tl) {
  const dz = tl && tl.dz ? tl.dz : 1;
  const bw = w * dz;
  const bh = h * dz;
  return { x: x + (w - bw) / 2, y: y + (h - bh), w: bw, h: bh };
}

/** 倾斜梯形的四个角（TL/TR/BR/BR） */
function tiltPts(x, y, w, h, tl) {
  const b = tiltBox(x, y, w, h, tl);
  const sq = tl && tl.sq ? tl.sq : 1;
  const ts = tl && tl.ts ? tl.ts : 1;
  const topY = b.y + b.h * (1 - sq);
  const inset = b.w * (1 - ts) / 2;
  return [
    { x: b.x + inset, y: topY },
    { x: b.x + b.w - inset, y: topY },
    { x: b.x + b.w, y: b.y + b.h },
    { x: b.x, y: b.y + b.h },
  ];
}

/** 带切角的四边形 path（仿 roundRect 的圆角感，直边更省） */
function quadPath(ctx, pts, r) {
  const n = pts.length;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const v1x = p1.x - p0.x;
    const v1y = p1.y - p0.y;
    const v2x = p2.x - p1.x;
    const v2y = p2.y - p1.y;
    const l1 = Math.sqrt(v1x * v1x + v1y * v1y) || 1;
    const l2 = Math.sqrt(v2x * v2x + v2y * v2y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = p1.x - (v1x / l1) * rr;
    const ay = p1.y - (v1y / l1) * rr;
    const bx = p1.x + (v2x / l2) * rr;
    const by = p1.y + (v2y / l2) * rr;
    if (i === 0) ctx.moveTo(ax, ay);
    else ctx.lineTo(ax, ay);
    ctx.lineTo(bx, by);
  }
  ctx.closePath();
}

/**
 * 局内「侧视俯瞰」一点透视（2026-10-20 引入，2026-10-21 放缓）。
 *
 *   d(y) = base + (1−base)·y/640      —— 顶边收敛到 base 倍宽、底边 100%
 *   x′    = 640 + (x − 640)·d(y)      —— 只收敛 x、y 不变
 *
 * **base 0.58 → 0.72**（2026-10-21，用户报「牌显示异常」）：
 * 0.58 意味着顶边只有底边的 58% —— 那是一支超广角的俯拍，代价是
 *   · 一张牌自己就变成楔形（左右各缩 ~14px），贴图按横切片重采样后笔画被拉斜；
 *   · 左右两侧的牌河每往下一行就横向漂 ~13px，整列看着像斜着拖出去。
 * 牌张改走「牌心单点透视 → 纯矩形」后（见 `projQuad` 的 rect 分支），
 * 第一条已消失；base 收到 0.72 再把第二条的漂移量压到 ~7px/行 ——
 * 纵深还在（顶边 72% 宽 + 越远越小），但不再有「牌在融化」的观感。
 *
 * 为什么只收敛 x：逻辑网格（riverPos/meldPos/中心盘）一行不改，
 * 牌张在画布内无热区（hitTest 只有掷骰钮 + 四角铭牌），故无需逆变换；
 * y 不动还让「上下两条牌河的行列网格」在屏幕上仍是水平行。
 * **HUD 不投影**：铭牌/中心盘/骰子/横幅/气泡全部留在逻辑坐标（= 屏幕位置），
 * 与 fitCanvas 的均匀换算、hitTest 的逻辑矩形一一对应。
 * `PROJ.on=false` 一键整体退回平面（低端机降级开关）。
 */
const PROJ = { on: true, base: 0.72, span: 0.28 };

function projD(y) {
  return PROJ.base + PROJ.span * (y / H);
}

/**
 * 结算相位左右两家**摊牌手牌**的竖带参数（2026-10-23）。
 *
 * 牌河、副露已改回**局内位置**（用户要求），这里只服务 `drawRevealHand`：
 * 手牌在左右边铺开（2026-10-30 起**双列**，每列 ≤7 张，见 `REVEAL_COLS_MAX`），
 * 列 x 用 `screenToLogicX()` 反算 → 投影后牌同宽同高、列严格竖直。
 * 列内步距 = `RIVER_LAP_SIDE·k`（**小幅重叠**：牌高 − 5，与牌河同律 —— 2026-10-30
 * 上午改零叠压后真机报「空隙/楼梯感」，下午定稿回部分像素重叠；14 张单列仍放不下，故折列）。
 *
 * ⚠ 列带的**横向位置不在这里定**（2026-10-24 第四十五轮）：原来有个 `handX=138`，
 * 而副露列已经占到屏幕 168.5 —— 两列重叠 23.7px（左，占牌宽 44%），副露后画，
 * 结算时整列手牌被压掉一条。现在 x 由 `revealOrigin()` 按十字布局的预留竖带写死
 * （配合 `MELD_BLOCKS`，见该表注释），这里只留竖向中心与投影比。
 */
const OVER_SIDE = {
  cy: 320,
  k: projD(320),
};

/** 结算摊牌（自己/对家那一排）的牌张尺寸与步距。
 *  2026-10-24：40×50/44 → 43×54/47 → 48×60/52。
 *  2026-10-28 C1：跟牌河格 55×72 对齐 → **55×68 / 步距 60**（摊牌比河格略矮，容纳 14 张）。
 *  2026-10-30：随牌河格 44×58，**直接派生自 RIVER_W/H**，河格再变这里跟走；
 *  步距 = 牌宽 − 6（2026-10-30 第三轮，与牌河同律盖住圆角/格留白）。
 *  必须与 `revealOrigin()` 的居中算法用同一个 `REVEAL_DX`，否则牌排会偏一边。 */
const REVEAL_W = RIVER_W; // 44
const REVEAL_H = RIVER_H; // 58
const REVEAL_DX = REVEAL_W + 2; // 牌面完整排列，牌间留 2px 缝
/** 侧家摊牌列内行距（2026-11-04 用户「部分重叠、没有间隙」）：贴图底部 12.5%
 *  空区（44×0.125 = 5.5）须被下一行盖住且内容净叠 ~2px → 44−13 = **31**（原 46
 *  时行间露 ~13px 绿缝）。列间（colDx = sw+2）与横排摊牌（REVEAL_DX）保持细缝
 *  —— 摊牌是一手牌的展开，牌与牌留一线可读，不属「同排连排」的叠压语境。 */
const REVEAL_DY = RIVER_W - 13;

/** 副露列离牌河块的间隙（屏幕 px，`drawMelds` 左右两家） */
const MELD_GAP_X = 6;
/** 结算摊牌列离副露列的间隙（屏幕 px）—— 副露后画，没间隙就会压住手牌 */
const REVEAL_GAP_X = 18;
/** 上下家摊牌竖列的单列张数上限（7×44×0.86 ≈ 265 屏高，居中带内；超出折第二列。
 *  2026-10-30：列内步距 = 牌高 − 5 与牌河同律小幅重叠，14 张单列仍放不下 → 双列。 */
const REVEAL_COLS_MAX = 7;

/**
 * 中心徽章**出牌方提示**（2026-10-30 重做：「边框高亮 + 朝外小三角」）。
 *
 * 上一版是素材 `room_time_0..3` 的 116×26 箭头条贴在徽章边线上：2026-10-28 C1 把
 * 中心盘从 320×196 收成 200×88 徽章后，条有 22px 压进徽章内部 —— 真机截图里
 * 牌墙大数字「62」、立精牌顶都被绿条盖住，还与结算横幅互相切碎（用户 2026-10-30
 * 报「出牌方提示图标存在不合理」）。素材四条边（`room_time_*`）因此整体退役。
 *
 * 现画法：当前出牌方那一侧的徽章边线加粗发光（呼吸）+ 边中点一个朝外的小三角。
 * 占位已逐点核对：线段内侧只探 2.5px、三角内侧 6px（数字 261 / 立精 264 / 骰 327
 * 起，x 也全部错开），外侧探出 8px（对家河底 ≤240、自家河顶 ≥352、左右无冲突）。
 */
/**
 * 中心徽章矩形（**唯一真相**：`drawCenter` / `drawDirectors` / `drawResultBanner`
 * 三处都从这里取，别再各自写死 540/230/200/88）。
 *
 * 2026-11-04 十一轮：y 230 → **218**（上移 12）—— 用户「对家和自己的牌河明显比
 * 上下家小，两边还有空隙」。上下两条河是**竖版**牌格，牌高受纵向窗口硬卡
 * （下：徽章底 ~ 操作栏 437；上：对家手排底 89 ~ 徽章顶），盘让出 12px 正好
 * 把牌从 36×50 抬到 **41×56**（面积 +28%），牌河横宽也从 142 屏拉到 166 屏、
 * 基本填满 186 屏的窗口（「两边的空隙」消失）。
 * 上移后仍是「上下各留 14px」的对称关系：上河底 204 ↔ 盘顶 218（三角 210）、
 * 盘底 306（三角 314）↔ 下河顶 318。
 */
const CENTER_BADGE = { x: 540, y: 218, w: 200, h: 88 };

/**
 * 边线线段距徽章圆角的内缩量（避开 r=12 的圆角段）
 */
const DIR_INSET = 14;
/** 边线线段粗细（一半在徽章内、一半在外） */
const DIR_LINE_W = 5;
/** 朝外三角的高/半底（顶点外探 DIR_TRI 之外 8px，内侧只占 6px） */
const DIR_TRI_H = 14;
const DIR_TRI_HALF = 8;
/**
 * 副露行左右扩展上限（2026-10-28 C1，接替方案③ 的 EDGE_PAD=10）：
 * 历史值来源：2026-10-28 C1 时给「底部紧凑铭牌条（x14..144）外留 8px」→ 152 / 1128。
 * 2026-10-30 铭牌改贴底角竖角标（x≤58、y538 起，与副露行 y445..514 已不相交）后，
 * 真实约束只剩侧影列（x≤86）+8 ≈ 94 —— 152 作为保守值**暂不动**（无放宽需求，
 * 动它要重跑副露/摊牌全套几何断言）。
 * 容量 2 组/侧（方案③ 时 ≈3/侧，代价是被 15% 大牌 + 铭牌让位换走一档）。
 */
const MELD_LIMIT_X = 152;

/**
 * 副露块表（2026-11-04 四轮校位）：每家最多 4 组，分**两个块**，每块 ≤2 组。
 * 矩形 = **屏幕（投影后）落位**；组内步距见 `meldMetrics`（横排 38 / 竖排 33），
 * 组在块内居中，超块时整块等比收紧。
 * **上下对等、各归各半**（用户 2026-11-04 二次纠正：对家副牌必须留在上半场，
 * "靠近下面"指各自半场内贴下沿；两条带等高 52、均单行并排 2 组）：
 *   · slot 2（对家）：**y110..162** —— 手牌排（底 107）之下 3px、侧河
 *     （y165..263）之上 3px，即上半场可用窗的底部；x292..547 / x733..988
 *     （与顶河 x560..720 各让 13px）；
 *   · slot 0（自己）：**y388..440** —— 贴操作栏带（y444）之上 4px（被压缩的一侧）；
 *   · slot 3（上家）/ 1（下家）：草图副牌列 x250..372 / x908..1030，
 *     两块 **y170..270 / y276..376** —— 回到中部（对家带之下、自家带之上，
 *     与侧河 x 错 5px）。
 */
const MELD_BLOCKS = {
  0: [
    { x: 292, y: 388, w: 255, h: 52 },
    { x: 733, y: 388, w: 255, h: 52 },
  ],
  2: [
    { x: 292, y: 110, w: 255, h: 52 },
    { x: 733, y: 110, w: 255, h: 52 },
  ],
  3: [
    { x: 254, y: 170, w: 110, h: 100 },
    { x: 254, y: 276, w: 110, h: 100 },
    // 第 3 块（2026-11-04 审计 C「扩容到 5 组」）：4 副露 + 报杠展示（groups=5）时
    // 旧 2 块 × 2 组只画 4 组、第 5 组静默丢弃。探针四场景（全满/单侧满/空场）实测
    // y444..496 窗口（自/对家副露带 y440 止与手牌行 y512 之间）在副牌列竖带上 0 占用。
    { x: 254, y: 444, w: 110, h: 52 },
  ],
  1: [
    { x: 916, y: 170, w: 110, h: 100 },
    { x: 916, y: 276, w: 110, h: 100 },
    // 同上（下家侧列）：x 与前两块对齐、y444..496。
    { x: 916, y: 444, w: 110, h: 52 },
  ],
};

/** 把「投影后的屏幕左缘」反算成 `drawTile` 的逻辑 x（配合 `z.k` 的整块缩放） */
function screenToLogicX(sxScreen, k) {
  return W / 2 + (sxScreen - W / 2) / k;
}

/**
 * 反向补偿「牌心透视」的 x：projQuad 会把牌心按 d(y) 往中线拉，
 * 一列牌的上下两张 y 差得远、d 不一样 → 整列会往上撇/往外撇。
 * 这里把「期望的屏幕 x」反算成传给 drawTile 的逻辑 x，列就直了，
 * 于是 `riverOrigin` / 副露锚点的数字可以直接当屏幕坐标读。
 */
function unprojTileX(x, y, w, h, k) {
  if (!PROJ.on) return x;
  // k 显式传入时按统一比例反算（副露列用它，见 meldK）：位置与尺寸必须同一个比例，
  // 否则「牌多宽」和「牌放哪」两套尺度打架，列边缘就会出现 1~3px 的锯齿。
  const d = k || projD(y + h / 2);
  /*
   * 2026-11-02（用户「上下家的牌还是没对齐」，harness 实测左右副露列不对称 8.9px）：
   * 旧反推式与 projQuad 的 rect 分支**不互逆** —— 它把传入的 x 当
   * 「屏幕左缘 = 牌心 − w/2」（宽未乘 d），而正向投影的屏幕左缘是
   * 「牌心 − (w/2)·d」（rect 分支四角 = 牌心 ± (w/2)·d）。
   * 两式差 (w/2)(1−d)：d=0.847、w=58 时 ≈ 4.4px，右侧副露列外扩 4.4、
   * 左侧内收 4.4，合计 8.9 —— 与 harness 实测逐位吻合。修正为从
   * 「屏幕牌心 = 屏幕左缘 + (w/2)·d」出发，与正向逐项互逆
   * （scripts/mg_geomcheck.cjs 已加 roundtrip 断言锁死）。
   */
  return W / 2 + (x + (w / 2) * d - W / 2) / d - w / 2;
}

function projPt(x, y) {
  return { x: W / 2 + (x - W / 2) * projD(y), y };
}

/**
 * 分区四边形（[TL, TR, BR, BL]）：先算 Lean 逻辑梯形（tiltPts：dz 深度缩放 /
 * ts 顶边比 / sq 垂直压缩），再按 **zw 宽度补偿**（锚定底边中点，远处牌被横向
 * 压缩后放大保可读——不补偿则顶边牌河文字只有原来的 60%），最后逐角过投影。
 * z.proj===false = HUD 牌（中心盘立精）：只 Lean 不投影；z 为空 = 纯矩形。
 *
 * 2026-10-21 `z.rect`（**牌张专用**，由 resolveZone 置位）：投影比例 `d(y)` 只按
 * **牌心**取一次，四个角同比例 → 四边形退化成矩形。为什么必须这么做：
 *   · 逐角取 `d(y)` 时，一张 50×62 的牌上下沿的 `d` 相差 0.42·62/640 ≈ 4%，
 *     离中心越远差得越多（x=291 处左右各缩 ~14px）——牌被画成一个**楔形**，
 *     贴图按横切片重采样后笔画被逐条拉斜，观感是「牌在融化 / 斜切」；
 *   · 而且 `drawTileSlices` 用切片中点比例算左右边，相邻切片错开半格 →
 *     牌侧沿出现**台阶锯齿**（真机截图里的「半截牌」就是它）。
 * 牌心取一次后，牌本身零畸变，只剩「越远越小、位置越靠中间」这条**位置上的**
 * 透视 —— 桌面整体的纵深一点没丢（桌面/中心盘仍走逐角投影的梯形）。
 */
function projQuad(x, y, w, h, z) {
  const pts = tiltPts(x, y, w, h, z);
  const zw = z && z.zw ? z.zw : 1;
  const cx0 = (pts[2].x + pts[3].x) / 2;
  const zoomed = zw === 1 ? pts : pts.map((p) => ({ x: cx0 + (p.x - cx0) * zw, y: p.y }));
  if (!z || z.proj === false) return zoomed;
  if (z.rect) {
    /*
     * 牌心单点透视：以牌心为锚，整张牌**等比**缩放 d(y) → 纯矩形、零畸变。
     * 高度也一起缩（2026-10-21 补）：x-only 投影若只缩宽，顶边的牌会「窄而不矮」，
     * 牌面比例从 0.81 变成 0.60，远看是一排细长条。按牌心等比缩之后，
     * 顶边的牌就是一张**小一号的牌**，近大远小读得顺。
     * （2026-10-30 现行间距按**逻辑**口径校验：上下河 dy52 < h58 → 每行叠 6
     *   （屏 ~5px @k0.91、~4px @k0.79）；左右河 dy39 < h44 叠 5（屏 ~4px）、
     *   列距 55 < 牌宽 58 叠 3 —— 全部压住贴图边缘留白，块内连成一个平面，
     *   见 `RIVER_LAP_*`。）
     *
     * **`z.k`（2026-10-22，牌河专用）**：把比例从「逐张按 d(y)」换成「整块一个常数」。
     * 叠压之后每张牌都只露出一小条，逐张取 d 会让同一列上下两张**宽度差 1~2px**，
     * 整条带的左右边缘于是变成锯齿（用户报「四家的牌对得不整齐」）。
     * 牌河块取「容量行数中心那一行的 d」，整块当一块刚体缩放：行列严格对齐、
     * 每张同宽同高，纵深感由整块大小承担。
     */
    const d = z.k || projD(y + h / 2);
    const cx = x + w / 2;
    const cy = y + h / 2;
    const cxs = W / 2 + (cx - W / 2) * d;
    return zoomed.map((p) => ({ x: cxs + (p.x - cx) * d, y: cy + (p.y - cy) * d }));
  }
  return zoomed.map((p) => projPt(p.x, p.y));
}

/** 牌墙分区（2026-10-20 满铺立体绿背墙）：zw 1.3 = 顶边牌墙不被收敛成散沙；
 *  缓 Lean（sq .94 / ts .965 / dz 1.05）给墙 volume —— 不再走 fx:'flat'，
 *  整套 3D（投影+厚度+8 切片+顶光）的代价由 `_wallCache` 离屏预合成吸收：
 *  272 张只在 removed 变化的帧重绘一次，逐帧仍是一次 blit。 */
const WALL_TILT = { sq: 0.94, ts: 0.965, dz: 1.05, zw: 1.3 };

/** 中心盘立精 = HUD 牌：Lean 不投影（盘是 HUD，投影会把牌挤出盘外） */
/**
 * 中心盘里的「立精」= HUD 牌。
 *
 * **2026-10-22 第十一轮（用户「中心面板中精牌显示变形」）：把 Lean 全部归 1**。
 * 原来 `sq: 0.80 / ts: 0.93 / dz: 1.04` 是为了给立牌做俯视梯形，但牌面贴图**自带**
 * 透视与厚度，再 Lean 一次就是二次变形：62 高先被 dz 放到 64.5、再被 sq 压到 51.6，
 * 于是 43 宽的牌被画成 48 宽 51.6 高 —— 比例 0.93，而原图是 0.689（宽了 35%），
 * 屏幕上就是「九萬 / 8条 被拍扁」。
 * 现在只保留 `proj:false`（HUD 不投影），并显式 `fx:'flat'`：`resolveZone` 见
 * 「不投影 + 不 Lean」直接返回 null → 走**纯平面位图**那条路（不切片、不画顶光），
 * 牌面与牌河完全同一套画法，也不会在牌身上留下切片接缝。
 */
const STAND_HUD = { sq: 1, ts: 1, dz: 1, proj: false, edge: 0, fx: 'flat' };

/**
 * 桌面**矢量兜底**的配色（2026-10-24）。
 *
 * 取值必须与 WXSS 里 DOM 桌面层的兜底色**逐字相同**，否则画布边界会切出一条色带：
 *   · `felt` = `pages/game/game.wxss` 的 `.felt` background-color `#14614a`
 *     （采样 table.webp 的绒布平均色；清单正常、贴图还在路上时 DOM 露的就是它）；
 *   · `na`   = `.felt.na` 的 `#0d1626`（UI 整通道拿不到时的矢量桌外层藏青）。
 * 由 game.js 的 `loadUiArt` 按 `feltUrl` 有无写进 `table.feltNavy` 来选择。
 * `mid` 是中心那层径向渐变（绒布受光），`edge` 一律透明以露出 `base`，保证边缘同色。
 */
const FELT_FALLBACK = {
  felt: { base: '#14614a', mid: 'rgba(26,116,89,0.85)', edge: 'rgba(20,97,74,0)' },
  na: { base: '#0d1626', mid: 'rgba(35,64,95,0.85)', edge: 'rgba(13,22,38,0)' },
};

class Table {
  constructor(canvasNode, pixelRatio) {
    const ctx = canvasNode.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 上下文');
    this.canvas = canvasNode;
    this.ctx = ctx;
    this.pixelRatio = Math.min(2, Math.max(1, pixelRatio || 1));
    this.view = null;
    this.lastRendered = null;
    this.rafQueued = false;
    /** 摊牌时各家明牌占的矩形（index = 屏幕槽位，供中奖高亮用）；对局中是全 null */
    this.revealRects = [null, null, null, null];
    this.dealing = false;
    this.effCounts = [0, 0, 0, 0];
    this.dealAnim = null;
    this.prevRemoved = null;
    this.ghosts = [];
    this.diceReveal = null;
    this.rollBtn = null;
    this.rollClicked = false;
    /* ---- 2026-10-28 C1：自家手牌入画布 + 状态行入画布 ----
     * handRects：drawMyHand 每帧记录的牌位矩形（hitTest 命中用；claims 期清空禁点）；
     * settleRect：「本局结算 ▲」命中区；statusBar：game.js 每帧下发（view 不带文案）；
     * discardEnabled：出牌总开关（trayActive 同语义，game.js 按回合/claims 置位）。 */
    this.handRects = [];
    this.settleRect = null;
    this.prepRect = null; // 结算后画布底部「准备」胶囊命中区
    this.statusBar = null;
    this.discardEnabled = true;
    this.cancelEnabled = false; // 托管中可点手牌取消托管（与 discardEnabled 并行，不依赖 turn）
    /**
     * 两段式出牌（2026-11-04 防误触）：第 1 击「抬高」选中、第 2 击同牌才打出。
     * 记 { idx, tile }；drawMyHand 每帧校验 `myTiles[idx] === tile`，手牌一变
     * （摸牌插入/打出后重排）或交出回合（discardEnabled=false）即复位 → 不会
     * 出现「上一回合抬过的牌这一回合一点就飞出去」。idx 区分同点数的多张。
     */
    this.raisedHand = null;
    /**
     * 逻辑坐标 → backing 的像素比。**必须初始化为 pixelRatio 本身**：
     * 小游戏端宿主画布跨场景复用（app.tableHost 单例），上一局的 Table 已把宿主
     * 扩到 W×H×dpr —— 构造器末尾的 applyBackingStore() 见尺寸已符合会**早退**，
     * 若这里置 1，早退分支不会回头赋 this.dpr，新 Table 就一直以 1× 变换绘制：
     * 新局内容缩进宿主左上 1/4 象限，其余仍是上一局残帧 —— 用户报的
     * 「解散回房再开局出现两个对局界面」（2026-11-05）。
     * 小程序端 canvas 节点每次导航新建（尺寸 0）必走 resize 分支，两种初值都正确。
     */
    this.dpr = this.pixelRatio;
    this.onDiscard = () => {};
    this.onRaise = () => {};
    this.onRollDice = () => {};
    this.onTagClick = () => {};
    this.onSettleRestore = () => {};
    this.onPrep = () => {}; // 结算后「准备」胶囊（发 nextRound，与面板「准备」同一出口）
    this.tagRects = [null, null, null, null];
    /**
     * 语音座位态（2026-11-03 二期）：由宿主（game 页 / game 场景）在渲染前写入，
     * **按绝对座位**键控的 4 布尔（内部用 disp(view, seat) 相对化到 slot）。
     * speakingSeats[seat]=true → 铭牌/竖标画绿色光环；mutedSeats[seat]=true（闭麦且关扬声器）→ 角画 🔇。
     * null = 宿主未注入（冒烟/旧调用点）→ 完全不画，render(view) 签名因此不变。
     */
    this.speakingSeats = null;
    this.mutedSeats = null;
    /**
     * 光环模式（2026-11-05 B 方案）：true（默认）= 说话人事件有数据 → **呼吸**环
     * 「正在说话」；false = 真机从不触发时的降级「开麦即亮」→ **常亮**环。场景按
     * voice.hasSpeakerData() 注入，注释详见 game 场景 computeVoiceSeats。
     */
    this.voiceReactive = true;
    /**
     * 微信胶囊（⋯ ○）在**画布逻辑坐标**里的矩形（只需 left/bottom），
     * 由 game.js `applyTableFrame` 实测换算后写入 —— 右上铭牌据此下移避让
     * （见 `drawTag` slot2）。null = 拿不到实测 / 胶囊不压画布 → 贴角。
     */
    this.capsuleRect = null;
    this.bubbles = [];
    this.emoteFx = [];
    this.actionFx = null;
    /** 已处理到的动作 seq（单调递增；重连重放的旧 seq 直接丢弃） */
    this.fxSeenSeq = 0;
    /** 是否已对齐过历史日志（首次只对齐、不回放，避免进房突然播旧动画） */
    this.fxBootstrapped = false;
    /** 3D 牌面：结算相位降切片数；离屏缓存（矢量牌面/牌背/投影贴片） */
    this.overPhase = false;
    this._shadowCache = {};
    this._vecCache = {};
    /** 转过朝向的牌面贴图（key = t|w|h|rot，2026-10-20；只给侧边的牌用） */
    this._rotCache = {};
    /** 2026-10-20 透视：整面墙是静态层 → 离屏预合成，key 不变逐帧只 blit */
    this._wallCache = null;
    this._wallKey = '';
    /**
     * 整屏桌面矩形（**逻辑坐标**，可超出 0..W/0..H，负值合法）。
     *
     * 2026-10-22「桌面铺满」：桌面贴图不再只铺画布，而是铺**整个页面**
     * （画布上下左右都被页面 chrome 占着：顶栏 / 手牌条 / 两侧按钮轨）。
     * 页面层由 WXSS 的 `.felt` 用 `background-size:100% 100%` 铺同一张图，
     * 画布这边按同一个矩形画同一张图 —— 两层逐像素对齐，接缝不可见。
     * 由 game.js 的 `applyTableFrame()` 每次量到画布 rect 后写进来；
     * 为 null 时退回「铺满画布」的旧行为（截图/校验 harness 走的就是这条）。
     */
    this.frame = null;
    /**
     * 矢量兜底桌用哪套配色（2026-10-24）：true = 藏青 `.felt.na`（UI 整通道没起来），
     * false = 绿绒 `.felt`（清单正常、贴图还在路上）。**必须与 DOM 层当下的兜底色一致**，
     * 由 game.js 的 `loadUiArt` 每次写完 `feltUrl` 后同步进来，见 `FELT_FALLBACK`。
     * 默认 true（还没拉到清单时的状态，与 `feltNavy: true` 的初始 data 对齐）。
     */
    this.feltNavy = true;
    /**
     * 末张「活跃牌」光效贴图（2026-11-02，用户提供的 activeCard.png）：
     * 由宿主注入（小游戏端加载包内 assets/ui/activeCard.png；小程序端未注入 =
     * null → 只画金边，行为不变）。drawLastMarker 里叠加 + 上下浮动。
     */
    this.activeCardImg = null;
    this.applyBackingStore();
    // 复用宿主防残帧（2026-11-05「两个对局界面」第二层保险）：宿主跨场景单例，
    // 上一局最后一帧（含「本局结算▲」状态行 / 胡 pill）会留到新局首次 render。
    // 首帧 render 在 enter() 里随 lastGameView 同步发生，但 rAF 动画队列（rafQueued）
    // 可能把它推迟一帧 —— 主循环那一帧会把残帧 blit 出来闪一下。构造期清一次。
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, W, H);
  }

  /**
   * 离屏画布工厂（投影贴片/矢量牌面缓存用）：小程序走 `wx.createOffscreenCanvas`，
   * 浏览器兜底 `document.createElement`；都不可用返回 null → 绘制降级（见 `drawTile`）。
   *
   * ⚠️ **小程序端必须传对象签名** `{ type: '2d', width, height }`（基础库 ≥ 2.16.1）。
   * 位置参数 `wx.createOffscreenCanvas(w, h)` 拿到的是「旧版 canvas」，它的
   * `getContext('2d')` 会报 `Invalid context type [2d] for Canvas#getContext` 并返回 null
   * —— 2026-10-20 在 Windows 微信实测：整桌白屏 + 控制台刷屏，崩在 `tileFace` 把 null
   * 上下文传给 `paintTileBack`。此处**创建后立刻探一次 2D 上下文**：拿到就正常用；
   * 拿不到（老库/PC 端不支持）就 `_canvasOff` 一次性关掉离屏能力，之后所有牌都走
   * `drawTile` 的「投影包围盒近似」降级 —— 不白屏、不再刷错、布局仍收敛。
   */
  static newCanvas(w, h) {
    if (Table._canvasOff) return null;
    try {
      if (typeof wx !== 'undefined' && typeof wx.createOffscreenCanvas === 'function') {
        const c = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
        if (!c) throw new Error('createOffscreenCanvas → null');
        if (c.width !== w) c.width = w;
        if (c.height !== h) c.height = h;
        if (!c.getContext || !c.getContext('2d')) throw new Error('no 2d context');
        return c;
      }
      if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        if (!c.getContext || !c.getContext('2d')) throw new Error('no 2d context');
        return c;
      }
    } catch (e) {
      // 只提示一次：之后整局都走降级路径，避免每张牌刷一条日志
      if (!Table._canvasOff) {
        Table._canvasOff = true;
        console.warn('[table] 离屏画布不可用，牌面降级为投影包围盒绘制：', e && e.message);
      }
    }
    return null;
  }

  /**
   * 按设备像素比重建 backing store —— 解决手机上牌面贴图被放大后发虚的问题。
   * 逻辑坐标系恒为 1280×640：绘制代码一行不改，每帧开头用 setTransform 映射。
   */
  applyBackingStore() {
    const dpr = this.pixelRatio;
    const w = Math.round(W * dpr);
    const h = Math.round(H * dpr);
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.lastRendered) this.render(this.lastRendered);
  }

  /**
   * 命中判定（页面把触摸点换算成画布逻辑坐标后调用）。
   * 2026-10-17 起**只剩掷骰按钮与四角铭牌**：画布内手牌带已移除（见文件头说明），
   * 出牌统一走画布下方的 DOM 手牌条（42~46px 宽，是画布内牌面的 2 倍以上）。
   */
  hitTest(x, y) {
    if (!this.view) return;
    const rb = this.rollBtn;
    if (rb && x >= rb.x && x <= rb.x + rb.w && y >= rb.y && y <= rb.y + rb.h) {
      if (!this.rollClicked) {
        this.rollClicked = true;
        this.onRollDice();
      }
      return;
    }
    // 2026-10-28 C1：状态行「本局结算 ▲」（画布顶端，先于其它热区）
    const sr = this.settleRect;
    if (sr && x >= sr.x && x <= sr.x + sr.w && y >= sr.y && y <= sr.y + sr.h) {
      this.onSettleRestore();
      return;
    }
    // 2026-11-05：「准备」胶囊（结算后与本局结算并排，直接下一局准备）
    const pr = this.prepRect;
    if (pr && x >= pr.x && x <= pr.x + pr.w && y >= pr.y && y <= pr.y + pr.h) {
      this.onPrep();
      return;
    }
    for (let slot = 0; slot < 4; slot++) {
      const tg = this.tagRects[slot];
      if (tg && x >= tg.x && x <= tg.x + tg.w && y >= tg.y && y <= tg.y + tg.h) {
        this.onTagClick((this.view.mySeat + slot) % 4);
        return;
      }
    }
    // 2026-10-28 C1：自家手牌（热区上下各放宽，方便点）。
    // 2026-11-04 两段式出牌（防误触）：第 1 击命中 → 抬高该牌（onRaise），同牌
    // 第 2 击 → 才真正打出（onDiscard）；点别的牌则把抬高换到新牌上。
    // 2026-11-05：手牌可点 = 自己回合（出牌）∪ 托管中（随时取消托管）。claims 期
    // handRects 为空，蒙罩生效，取消托管走 🤖 钮。
    const handActive = this.discardEnabled !== false || this.cancelEnabled === true;
    if (handActive && this.handRects.length > 0) {
      for (const r of this.handRects) {
        if (x >= r.x - 4 && x <= r.x + r.w + 4 && y >= r.y - 16 && y <= r.y + r.h + 8) {
          // 托管中点手牌：只取消托管，不进入抬牌/出牌语义（两段式抬牌仅手动出牌用）
          if (this.cancelEnabled === true) {
            this.onRaise(r.idx, r.tile);
            return;
          }
          const rh = this.raisedHand;
          if (rh && rh.idx === r.idx && rh.tile === r.tile) {
            this.raisedHand = null;
            this.onDiscard(r.idx, r.tile);
          } else {
            this.raisedHand = { idx: r.idx, tile: r.tile };
            this.onRaise(r.idx, r.tile);
          }
          return;
        }
      }
    }
  }

  render(view) {
    this.view = view;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lastRendered = view;
    if (view.ceremony && view.ceremony.state !== 'wait-roll') this.rollClicked = false;
    this.rollBtn = null;

    /*
     * 操作动画仲裁（2026-10-23）：按 seq 排序取「上次之后」的新动作，
     * **后者立即打断前者**（覆盖 actionFx，不排队、不叠画）—— 解决多个操作动画
     * 同时在中心区域互相挤位置。打断时**继承旧动画当前的 scale/alpha**继续演化，
     * 避免画面在打断瞬间跳变（用户报「显示错位和异常」）。
     */
    const fresh = this.collectNewActions(view);
    this.applyActionFx(fresh);

    const deal = this.dealProgress(view);
    this.dealing = deal !== null;
    const effCounts = view.counts.slice();
    if (deal) {
      effCounts.fill(0);
      const steps = (view.wallRing && view.wallRing.recipe.steps) || [];
      for (let i = 0; i < Math.min(deal.done, steps.length); i++) {
        effCounts[steps[i].seat] += steps[i].slots.length;
      }
    }
    this.effCounts = effCounts;
    this.revealRects = [null, null, null, null];

    const over = view.phase === 'over';
    this.overPhase = over; // 结算相位摊牌张数多 → 3D 切片降档
    this.handRects = [];
    this.settleRect = null;
    this.prepRect = null; // 每帧清（防结算结束后旧「准备」矩形劫持下面的点击）
    this.drawTable();
    this.drawWall(view, deal);
    // 对局中四条边是牌河；结算/摊牌时**牌河、副露保持局内位置不动**（用户 2026-10-23），
    // 只在四条边额外倒下手牌（`drawRevealHand`，见下面的循环）。
    // 对局中**不画任何手牌**（含对手）—— 手牌张数在铭牌上，牌面信息全部让给牌河。
    this.drawRivers(view);
    this.drawCenter(view, deal);
    this.drawHandStacks(view);
    for (let s = 0; s < 4; s++) {
      const slot = this.disp(view, s);
      if (over) this.drawRevealHand(view, s);
      this.drawMelds(view.melds[s], slot);
      this.drawTag(view, s);
    }
    // 2026-10-28 C1：自家手牌画在画布底沿（over 相位不画，摊牌行顶替）
    this.drawMyHand(view);
    if (view.lastDiscard) this.drawLastMarker(view);
    this.drawJingHighlight(view);
    if (view.phase === 'over') {
      this.drawWinnerHighlight(view);
      this.drawResultBanner(view);
    }
    this.drawEmoteFx();
    this.drawBubbles();
    this.drawActionFx();
    // 2026-10-28 C1：状态行最顶层（错误/状态/听牌/倒计时/「本局结算 ▲」）
    this.drawStatusBar(view);
    if (
      view.phase === 'playing' ||
      this.emoteFx.length > 0 ||
      this.bubbles.length > 0 ||
      this.actionFx !== null
    ) {
      this.scheduleFrame();
    }
  }

  dealProgress(view) {
    const c = view.ceremony;
    if (!c || c.kind !== 'deal' || view.phase !== 'playing') return null;
    if (c.state === 'wait-roll') return { done: 0 };
    if (c.rollAt === null || c.until === null) return { done: 0 };
    if (!this.dealAnim || this.dealAnim.key !== c.rollAt) {
      this.dealAnim = { key: c.rollAt, start: Date.now(), dur: Math.max(300, c.until - c.rollAt) };
    }
    const a = this.dealAnim;
    const elapsed = Date.now() - a.start;
    if (elapsed >= a.dur) return null;
    const steps = (view.wallRing && view.wallRing.recipe.steps.length) || 0;
    const tumble = Math.min(2200, Math.floor(a.dur * 0.5));
    const end = a.dur * 0.94;
    const t = Math.min(1, Math.max(0, (elapsed - tumble) / Math.max(1, end - tumble)));
    return { done: Math.min(steps, Math.floor(t * steps + 1e-9)) };
  }

  // ---------- 绘制 ----------

  disp(view, seat) {
    return (((seat - view.mySeat) % 4) + 4) % 4;
  }

  /** `disp` 的逆：屏幕槽位 → 真实座位。副露的「报杠展示」要按真实座位筛 */
  seatAt(view, slot) {
    return (((slot + view.mySeat) % 4) + 4) % 4;
  }

  wind(seat) {
    return seatWind(seat, this.view ? this.view.dealer : 0);
  }

  drawTable() {
    const ctx = this.ctx;
    // 2026-10-21：桌面背景优先用 CDN 位图 —— 源项目 liumengniu/majiang 的绿绒龙纹桌
    // （1280×640 已裁到画布比例并擦掉中心「湖南麻将」字样；源图在
    //  assets/ui/hud/table.png，生成走 `node scripts/gen_ui_extra.mjs`；
    //  旧的 packages/client/src/assets/ui/table.png 与该生成器已随提交 104bfdc 删除）。
    // 取不到（清单未就绪 / 部署漏带 public/ui）就回退下面这套藏青+暖金矢量桌：
    // 桌面是纯背景，牌张几何一律走自己的 projQuad，**与这层画什么无关**。
    //
    // 2026-10-22「桌面铺满整屏」：画布不再是牌桌本身，而是**整屏桌面上的一扇窗**。
    // 贴图按 `this.frame`（页面矩形在画布逻辑坐标里的位置，通常比画布大、含负值）
    // 整铺，超出画布的部分由画布裁掉；页面其余部分由 WXSS 的 `.felt` 铺同一张图、
    // 同一个「整铺不裁切」映射（background-size:100% 100%），两层像素级对齐。
    // 为什么不用 cover 而用整铺：cover 会按比例裁边，2:1 的图铺到 2.16:1 的手机横屏
    // 会把上下各裁 ~16px —— 木框的上下两条边直接消失，只剩左右框，像"断框"。
    // 几何一律不动：牌河/铭牌/中心盘仍是 1280×640 里的原坐标。
    const bg = uiart.art('table');
    const R = this.frame || { x: 0, y: 0, w: W, h: H };
    if (bg) {
      ctx.drawImage(bg, R.x, R.y, R.w, R.h);
      return;
    }
    /*
     * 矢量兜底桌（2026-10-24 重写：**跟着 frame 铺满整屏，不再画老版的投影梯形**）。
     *
     * 老版本（2026-10-20）这里画的是「侧视俯瞰」的梯形桌面（顶边收敛 58%），
     * 那时画布就是牌桌本身。2026-10-22 起桌面改成**整屏的一扇窗**（DOM `.felt` 铺外圈、
     * canvas 铺内圈、同一映射），只有贴图那条路跟着改了，兜底这条还留在梯形年代 ——
     * 于是「有图」是平铺满屏、「没图」是斜的梯形桌，两种状态观感完全不同。
     *
     * 现在的兜底必须满足两条：
     *   ① **铺的区域 = frame 矩形**，与贴图那条 `drawImage(bg, R.x, R.y, R.w, R.h)`
     *      完全同一映射（frame 为 null 时退回铺满画布）；
     *   ② **底色 = DOM 层当下的兜底色**（`FELT_FALLBACK`，由 game.js 按 `feltUrl` 有无
     *      写进 `this.feltNavy`），否则画布边界会切出一条色带。
     * 金框画在 **frame 的内缩 8px** 上（对应贴图自带的木框，位置在**页面**边缘）——
     * 因此在真机横屏上它落在画布之外、看不见，画布里就是干净的一块绒布，与「有图」一致。
     * 不做雕花纹理：参考图的雕花框是受保护素材，只借鉴「桌布深色 + 外框暖金」的结构。
     */
    const fb = FELT_FALLBACK[this.feltNavy ? 'na' : 'felt'];
    ctx.fillStyle = fb.base;
    ctx.fillRect(R.x, R.y, R.w, R.h);
    // 绒布感：一层从桌面中心往外衰减的径向渐变（只影响画布可见的那块，其余被裁掉）
    const cx = R.x + R.w / 2;
    const cy = R.y + R.h / 2;
    const rad = Math.max(R.w, R.h) * 0.62;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grad.addColorStop(0, fb.mid);
    grad.addColorStop(1, fb.edge);
    ctx.fillStyle = grad;
    ctx.fillRect(R.x, R.y, R.w, R.h);
    // 暖金双线框（对应贴图的木框）：主边 4px + 内侧 1px 高光，画在页面边缘那一圈
    const fx = R.x + 8;
    const fy = R.y + 8;
    const fw = R.w - 16;
    const fh = R.h - 16;
    if (fw > 0 && fh > 0) {
      roundRect(ctx, fx, fy, fw, fh, 18);
      ctx.strokeStyle = '#a8823c';
      ctx.lineWidth = 4;
      ctx.stroke();
      roundRect(ctx, fx + 6, fy + 6, fw - 12, fh - 12, 14);
      ctx.strokeStyle = 'rgba(255,214,120,0.32)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  segPitch(seg) {
    if (seg.screen === 0 || seg.screen === 2 || seg.cols <= 1) return WALL_PITCH;
    const fit = Math.floor((2 * WALL_V_LIMIT - H - WALL_ALONG) / (seg.cols - 1));
    return Math.max(WALL_ALONG, Math.min(WALL_PITCH, fit));
  }

  segSpan(seg) {
    return (seg.cols - 1) * this.segPitch(seg) + WALL_ALONG;
  }

  wallSegs(view) {
    const dealerDisp = this.disp(view, view.dealer);
    const segs = [];
    for (let r = 0; r < 4; r++) {
      const seg = { r, screen: (dealerDisp + r) % 4, cols: SEG_LEN[r], x0: 0, y0: 0 };
      const span = this.segSpan(seg);
      if (seg.screen === 0 || seg.screen === 2) seg.x0 = (W - span) / 2;
      else seg.y0 = (H - span) / 2;
      segs.push(seg);
    }
    return segs;
  }

  segOfCol(col) {
    for (let s = 0; s < 4; s++) {
      if (col >= SEG_START[s] && col < SEG_START[s] + SEG_LEN[s]) return s;
    }
    return 0;
  }

  slotPos(seg, col, layer) {
    const i = col - SEG_START[seg.r];
    const span = this.segSpan(seg);
    const pitch = this.segPitch(seg);
    const off = layer * WALL_LAYER;
    switch (seg.screen) {
      case 0:
        return { x: seg.x0 + span - WALL_ALONG - i * pitch, y: WALL_BOTTOM_Y - off, w: WALL_ALONG, h: WALL_ACROSS };
      case 2:
        return { x: seg.x0 + i * pitch, y: WALL_TOP_Y + off, w: WALL_ALONG, h: WALL_ACROSS };
      case 3:
        return { x: WALL_LEFT_X + off, y: seg.y0 + span - WALL_ALONG - i * pitch, w: WALL_ACROSS, h: WALL_ALONG };
      default:
        return { x: WALL_RIGHT_X - off, y: seg.y0 + i * pitch, w: WALL_ACROSS, h: WALL_ALONG };
    }
  }

  computeRemoved(view, stepsDone) {
    const removed = new Array(RING_SLOTS).fill(false);
    const rr = view.wallRing;
    if (!rr) return removed;
    if (stepsDone !== null) {
      for (let s = 0; s < Math.min(stepsDone, rr.recipe.steps.length); s++) {
        const slots = rr.recipe.steps[s].slots;
        for (const slot of slots) removed[slot] = true;
      }
      return removed;
    }
    for (const step of rr.recipe.steps) {
      for (const slot of step.slots) removed[slot] = true;
    }
    let guard = 0;
    let s = rr.recipe.endSlot;
    while (s !== rr.frontSlot && guard++ < RING_SLOTS) {
      removed[s] = true;
      s = (s + 1) % RING_SLOTS;
    }
    for (const slot of rr.kongSlots) removed[slot] = true;
    return removed;
  }

  seatAnchor(view, seat) {
    const screen = this.disp(view, seat);
    if (screen === 0) return { x: W / 2, y: 604 };
    if (screen === 1) return { x: 1204, y: 320 };
    if (screen === 2) return { x: W / 2, y: 60 };
    return { x: 76, y: 320 };
  }

  drawWall(view, deal) {
    const rr = view.wallRing;
    if (!rr) return;
    const ctx = this.ctx;
    const removed = this.computeRemoved(view, deal ? deal.done : null);

    if (this.prevRemoved !== null) {
      const steps = rr.recipe.steps;
      for (let slot = 0; slot < RING_SLOTS; slot++) {
        if (!removed[slot] || this.prevRemoved[slot]) continue;
        let seat = view.turn;
        if (deal) {
          for (let i = 0; i < Math.min(deal.done, steps.length); i++) {
            if (steps[i].slots.indexOf(slot) >= 0) {
              seat = steps[i].seat;
              break;
            }
          }
        } else if (rr.kongSlots.indexOf(slot) >= 0 && view.ceremony && view.ceremony.kind === 'gang') {
          seat = view.ceremony.seat;
        }
        let seg = null;
        const segs = this.wallSegs(view);
        for (const s of segs) {
          if (s.r === this.segOfCol(slot >> 1)) {
            seg = s;
            break;
          }
        }
        if (!seg) continue;
        const p = this.slotPos(seg, slot >> 1, slot & 1);
        const a = this.seatAnchor(view, seat);
        this.ghosts.push({ x0: p.x + p.w / 2, y0: p.y + p.h / 2, x1: a.x, y1: a.y, t0: Date.now(), tilt: tiltForSlot(this.disp(view, seat)), rot: rotForSlot(this.disp(view, seat)) });
      }
    }
    this.prevRemoved = removed;

    // 2026-10-20 用户决策：**不画牌墙**（`SHOW_WALL=false`）。ghost 与 wallLeft 的记账
    // 在上面已经完成，这里直接收工 —— 省掉的四条 30px 带子全给牌河/副露。
    if (!SHOW_WALL) {
      // 不画墙也就不画飞牌 ghost：若不清理，每帧入队却永远不被 :1076 的过期过滤回收，
      // 数组持续膨胀只做无用记账。直接清空（上限 RING_SLOTS 也兜不住逐帧入队）。
      this.ghosts.length = 0;
      this._wallCache = null;
      this._wallKey = '';
      return;
    }

    // 2026-10-20 透视：整面墙是静态层（只有 removed / 精牌位会变）→ 离屏预合成，
    // key 不变逐帧只 blit 一次（272 张牌全走四边形切片也只在变化的帧付一次）。
    // 发牌动画的 removed 按 step 递进，不会逐帧重算；key 里带上精牌位与牌值。
    const jingFaceSlot = this.jingWallSlot(view);
    const wallKey = `${jingFaceSlot}|${view.jingPi}|${removed.join('')}`;
    if (!this._wallCache || this._wallKey !== wallKey) {
      this._wallKey = wallKey;
      this._wallCache = this.renderWallCache(view, removed, jingFaceSlot);
    }
    if (this._wallCache) {
      ctx.drawImage(this._wallCache, 0, 0, W, H);
    } else {
      this.paintWall(ctx, view, removed, jingFaceSlot); // 离屏不可用 → 直画（旧行为）
    }

    if (view.ceremony && view.ceremony.kind === 'deal') {
      const col = rr.recipe.startCol;
      const segs = this.wallSegs(view);
      let seg = null;
      for (const s of segs) {
        if (s.r === this.segOfCol(col)) {
          seg = s;
          break;
        }
      }
      if (seg) {
        const p0 = this.slotPos(seg, col, 0);
        const p1 = this.slotPos(seg, col, 1);
        const x = Math.min(p0.x, p1.x) - 4;
        const y = Math.min(p0.y, p1.y) - 4;
        const w = Math.max(p0.x + p0.w, p1.x + p1.w) - x + 4;
        const h = Math.max(p0.y + p0.h, p1.y + p1.h) - y + 4;
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 240);
        ctx.strokeStyle = `rgba(230,193,75,${0.35 + 0.6 * pulse})`;
        ctx.lineWidth = 2;
        quadPath(ctx, projQuad(x, y, w, h, WALL_TILT), 5);
        ctx.stroke();
      }
    }

    const now = Date.now();
    this.ghosts = this.ghosts.filter((g) => now - g.t0 < GHOST_MS);
    for (const g of this.ghosts) {
      const k = Math.min(1, (now - g.t0) / GHOST_MS);
      const e = 1 - (1 - k) * (1 - k);
      const x = g.x0 + (g.x1 - g.x0) * e;
      const y = g.y0 + (g.y1 - g.y0) * e - Math.sin(Math.PI * k) * 34;
      // 飞行中从「平面」（牌墙）插值到目标牌河的 tilt：起飞是平的、落地才立起来
      const gk = k < 0.25 ? 0 : (k - 0.25) / 0.75;
      const tl = g.tilt && gk > 0
        ? {
            sq: 1 + (g.tilt.sq - 1) * gk,
            ts: 1 + (g.tilt.ts - 1) * gk,
            dz: 1 + ((g.tilt.dz || 1) - 1) * gk,
          }
        : null;
      ctx.globalAlpha = 1 - k * k;
      this.drawTile(-1, x - 9, y - 12, 18, 24, view, false, tl, g.rot);
      ctx.globalAlpha = 1;
    }
  }

  /** 墙的离屏预合成（逻辑坐标 1280×640；绘制期间把 this.ctx 临时换到离屏上下文） */
  renderWallCache(view, removed, jingFaceSlot) {
    const cv = Table.newCanvas(W, H);
    if (!cv) return null;
    let c2 = null;
    try {
      c2 = cv.getContext('2d');
    } catch (e) {
      c2 = null;
    }
    if (!c2) return null;
    const save = this.ctx;
    this.ctx = c2;
    this.paintWall(c2, view, removed, jingFaceSlot);
    this.ctx = save;
    return cv;
  }

  /**
   * 墙面本体：投影底衬 + 全部未取走的牌（牌背 / 翻精位牌面）。
   * 2026-10-20 起走 WALL_TILT 投影；2026-10-20 升级为**满铺立体绿背墙**：
   * 缓 Lean + 厚度 + 8 切片 + 顶光全套 3D —— 272 张的成本由 `_wallCache`
   * 离屏预合成吸收（只在 removed / 精牌位变化的帧重绘），逐帧仍是一次 blit。
   */
  paintWall(ctx, view, removed, jingFaceSlot) {
    const segs = this.wallSegs(view);
    // 深绿底衬 = 藏青桌面上的「墙裙」，与绿牌背同色系（2026-10-20 由黑影换）。
    // 2026-10-20 二次：四条边各自画底衬会在**四角留断口**（一段一段的绿条），
    // 改成沿环画四条 40 宽的带子，转角自然搭接 —— 墙读作**一圈完整的墙**。
    // 带子外沿按 WALL_LEFT_X/RIGHT_X/WALL_TOP_Y/BOTTOM_Y 算，bleed 6px；
    // 牌河在画完墙之后画，压到 1~2px 也看不出（顺序见 render）。
    const bx0 = WALL_LEFT_X - 6;
    const bx1 = WALL_RIGHT_X + WALL_ACROSS + 6;
    const by0 = WALL_TOP_Y - 6;
    const by1 = WALL_BOTTOM_Y + WALL_ACROSS + 6;
    const ring = [
      [bx0, by0, bx1 - bx0, 40], // 上
      [bx0, by1 - 40, bx1 - bx0, 40], // 下
      [bx0, by0, 40, by1 - by0], // 左
      [bx1 - 40, by0, 40, by1 - by0], // 右
    ];
    ctx.fillStyle = '#0f2b1e';
    for (const r of ring) {
      quadPath(ctx, projQuad(r[0], r[1], r[2], r[3], WALL_TILT), 7);
      ctx.fill();
    }
    for (const seg of segs) {
      for (let i = 0; i < seg.cols; i++) {
        const col = SEG_START[seg.r] + i;
        for (let layer = 0; layer < 2; layer++) {
          const slot = col * 2 + layer;
          if (removed[slot]) continue;
          const p = this.slotPos(seg, col, layer);
          const face = slot === jingFaceSlot ? view.jingPi : -1;
          this.drawTile(face, p.x, p.y, p.w, p.h, view, false, WALL_TILT);
        }
      }
    }
  }

  /**
   * 四方牌河块的落位（**只描述逻辑网格与格距，屏幕落位见 `riverBlockRect()`**）。
   *
   * 2026-11-03 **十字布局**（用户手绘分区图，docs 见文件头）：四家河绕中央徽章
   * （540..740 × 218..306，见 `CENTER_BADGE`）十字分布，锚点为**逻辑坐标**，
   * 投影后屏幕块（k 缩放）落位如下：
   *   · 上（对家）5 列 × 3 行 cap15：逻辑 x543、锚 y148，列距 38、行距 −38
   *     （dy<0 = 行向屏幕上方长）→ 屏幕块 ~561..720 × 97..204，
   *     上离对家手排（底 89）8、下离徽章顶（含朝外三角 210）6；
   *   · 下（自己）5 列 × 3 行 cap15：逻辑 x543、锚 y318，行距 +38 → 屏幕块
   *     ~554..726 × 318..435，上离徽章底三角（314）4、下离操作栏（最紧机型 437）2；
   *   · 左（上家）3 列 × 5 行：逻辑 x339、锚 y206，列距 50（58 横牌叠 8）、
   *     行距 31 → 屏幕块 ~385..519 × 206..348，右离徽章 21；
   *   · 右（下家）3 列 × 5 行：逻辑 x783（镜像）。
   * 容量 15/15/15/15，溢出压最后一格（cap 机制，见 `riverCell`）。
   *
   * 副露块 / 手牌摞 / 结算摊牌的落位都按这套屏幕块推死（`MELD_BLOCKS` /
   * `handStackOrigin` / `revealOrigin`），改这里必须连跑三者的几何复核。
   */
  riverOrigin(seat) {
    /*
     * 上/下河（2026-11-04 九轮立形状、十一轮定尺寸）：牌格 = 竖版
     * `RIVER_V_W×RIVER_V_H`（41×56），与图集 faceA/faceC 的竖版纵横比对齐 ——
     * 缘由与尺寸推导见该常量注释。这里只说落位：`o.x/o.y` 是**逻辑坐标**，
     * 横向整块 4×38+41 = 193 逻辑，按 640 居中 → x543.5（取 543）；
     * 纵向按「自己 318..435、对家 97..204」反解 o.y。
     *   · 自己 dy>0：行首（第 0 行）贴徽章一侧 → o.y 就是块顶，
     *     块底 = o.y + (2·dy + h)·k，k = 0.888（`riverK` 取容量块中心那行）；
     *   · 对家 dy<0：行首贴徽章 → **块底恒 = o.y + h**（与 k 无关，见
     *     `riverBlockRect` 的 yAdj 推导），故 o.y = 204 − 56 = 148。
     * 更早几稿（44×46 / 44×44 方格 / 36×50）的数字与撤销原因见本文件历史注释。
     */
    if (seat === 2) {
      return { x: 543, y: 148, cols: 5, rows: 3, vertical: false, dx: RIVER_V_DX, dy: -RIVER_V_DY, w: RIVER_V_W, h: RIVER_V_H, cap: 15 };
    }
    if (seat === 0) {
      return { x: 543, y: 318, cols: 5, rows: 3, vertical: false, dx: RIVER_V_DX, dy: RIVER_V_DY, w: RIVER_V_W, h: RIVER_V_H, cap: 15 };
    }
    /*
     * 侧河（2026-11-04 六轮定稿：用户「一排 5 张」按**牌主视角**）：屏幕上
     * **3 列 × 5 行**（每竖列 5 张 = 玩家视角的一排，cap15）—— 与各自副牌列
     * （y170..376）垂直居中（块心 275 = 徽章心）；横向窗口 = 副牌列
     * （x364/x916）与徽章（x540/x740）之间 176 屏 px。
     *
     * 2026-11-04 八轮（用户「上下家牌面被裁切/压扁」）：牌面图集 faceB/faceD
     * 是**横版**（236×192，比例 1.229），牌格必须横版 **58×44**（RIVER_H×RIVER_W）
     * —— 上一稿「四家统一 44×44 方格」把横版牌面 cover 进正方形，左右各裁
     * ~9.3%、图案被压扁。块宽 = 2×dx+58、块高 = 4×dy+44。
     *
     * 2026-11-04 十轮（用户「蓝框那排像阶梯，牌不是连在一起的」）：那是**牌面贴图
     * 自带的立体条**（每格底部 27~28% 是牌的侧面 + 绿桌面，`faceA..D` 实测：
     * faceA 28.5%、faceB 26.6%、faceC 27.9%）没被下一排盖住 —— 八轮的 dy=38
     * 只盖 6/44 = 13.6%，剩下 ~15% 的灰带整排露出来，每排一条 → 五条台阶。
     * 定稿 **dy = 牌高 − 13 = 31（盖 30%）**：把立体条整条压进下一张底下，只剩
     * 一条细接缝（与上下河 dy = 牌高 − 14 = 36 同一比例 28~30%）。
     * 列向同理：dx 54 → **50**（盖 14%，把贴图左右边缘那圈绿/暗边压住）。
     * 块 = 158×164 逻辑，k = 0.8469（块心仍是 290 → **k 与八轮完全相同，屏上牌
     * 大小一点没变**）→ 133.8×138.9 屏，在 364..540 窗口内居中 → o.x 反解
     * 339 / 783（= 1280 − 339 − 158）；块 y206..345，块心 275.5 = 徽章心。
     */
    if (seat === 3) {
      return { x: 339, y: 206, cols: 3, rows: 5, vertical: true, dx: RIVER_H - 8, dy: RIVER_W - 13, w: RIVER_H, h: RIVER_W, cap: 15 };
    }
    return { x: 783, y: 206, cols: 3, rows: 5, vertical: true, dx: RIVER_H - 8, dy: RIVER_W - 13, w: RIVER_H, h: RIVER_W, cap: 15 };
  }

  /**
   * 第 i 张弃牌落在**屏幕网格**的第几列/第几行。
   *
   * 2026-10-23（用户：**四家牌河统一按「牌主自己视角」从左上角开始摆，
   * 从左往右排满第一行再换下一行**）。四家阅读方向：
   *   0 自己（底）→ 视角 = 屏幕：左上角 = 屏幕左上，行内往右、换行往下；
   *   1 下家（右）→ 视角 = 屏幕顺转 90°：左上角 = 屏幕左下，行内往上、换行往右；
   *   2 对家（顶）→ 视角 = 屏幕转 180°：左上角 = 屏幕右下，行内往左、换行往上；
   *   3 上家（左）→ 视角 = 屏幕逆转 90°：左上角 = 屏幕右上，行内往下、换行往左。
   *
   * 注意屏幕行号不一定沿视觉向下：左右两家的块被整块缩放过，行号只是网格下标。
   * `dy < 0` 的边（对家）行号 0 才是**屏幕下方**（贴中心盘）那一行。
   */
  riverCell(seat, i) {
    const o = this.riverOrigin(seat);
    // 溢出压到最后一格：极端长局（流局前 27 张弃牌）叠在最后一格，
    // 好过溢出到副露/铭牌上。
    const idx = o.cap && i >= o.cap ? o.cap - 1 : i;
    const cols = o.cols;
    const rows = o.rows;
    /*
     * 2026-10-23（用户：**四家牌河统一按「牌主自己视角」从左上角开始摆，
     * 从左往右排满第一行再换下一行**）——2026-11-04 恢复列主序（用户「一排 5 张」
     * 指**牌主视角的一排** = 侧河的一根竖列；行主序让牌少时横向摊开、竖列只有
     * 两三张，被用户否决）。四家阅读方向：
     *   0 自己（底）→ 视角 = 屏幕：左上角 = 屏幕左上，行内往右、换行往下；
     *   1 下家（右）→ 视角 = 屏幕顺转 90°：左上角 = 屏幕左下，行内往上、换行往右；
     *   2 对家（顶）→ 视角 = 屏幕转 180°：左上角 = 屏幕右下，行内往左、换行往上；
     *   3 上家（左）→ 视角 = 屏幕逆转 90°：左上角 = 屏幕右上，行内往下、换行往左。
     *
     * 注意屏幕行号不一定沿视觉向下：左右两家的块被整块缩放过，行号只是网格下标。
     * `dy < 0` 的边（对家）行号 0 才是**屏幕下方**（贴中心盘）那一行。
     */
    if (seat === 2) {
      // 180°：第一张在屏幕右下角，行内往左，换行往屏幕上方
      return { col: cols - 1 - (idx % cols), row: Math.floor(idx / cols) };
    }
    if (seat === 3) {
      // 牌主在左：第一张在屏幕右上角，行内往下，换行往屏幕左方
      return { col: cols - 1 - Math.floor(idx / rows), row: idx % rows };
    }
    if (seat === 1) {
      // 牌主在右：第一张在屏幕左下角，行内往上，换行往屏幕右方
      return { col: Math.floor(idx / rows), row: rows - 1 - (idx % rows) };
    }
    return { col: idx % cols, row: Math.floor(idx / cols) };
  }

  /**
   * 第 i 张弃牌的**逻辑网格**位置（网格坐标由 `riverCell()` 按牌主视角给出）。
   *
   * 2026-10-22 起这里返回的是**没经过透视的网格坐标**：整块的等比缩放交给
   * `projQuad` 的 `z.k`（见 `riverK`）。原来这里是「列距乘 d(y) + unprojTileX
   * 反补偿」，逐行比例不同 → 同一列上下两张宽度差 1~2px、整条带边缘呈锯齿
   * （用户报「四家的牌对得不整齐」）。改成一个常数后行列严格对齐。
   */
  riverPos(seat, i) {
    const o = this.riverOrigin(seat);
    const cell = this.riverCell(seat, i);
    const w = o.w || RIVER_W;
    const h = o.h || RIVER_H;
    const dx = o.dx || RIVER_DX;
    const dy = o.dy || RIVER_DY;
    const k = this.riverK(seat);
    /*
     * 行距也乘 k（否则屏幕上的露出比例 = dy/(h·k)，对家 k≈0.79 就露 78%、自己 k≈0.93
     * 只露 61% → 四条边叠压肉眼不等）。`yAdj` 把**贴盘那一侧**钉在原点：
     * rect 分支是绕牌心缩的，不补这一下，整块会朝中心盘漂 h(1−k)/2（对家 ≈4.6px）。
     */
    const yAdj = dy > 0 ? -(h * (1 - k)) / 2 : (h * (1 - k)) / 2;
    return { x: o.x + cell.col * dx, y: o.y + cell.row * dy * k + yAdj, w, h };
  }

  /** 牌河块的统一投影比：取「按容量铺满时的块中心那一行」的 d。
   *  用 `o.rows`（容量）而不是实际牌数 —— 牌数变化时整块尺度不能跟着跳。 */
  riverK(seat) {
    const o = this.riverOrigin(seat);
    const h = o.h || RIVER_H;
    const dy = o.dy || RIVER_DY;
    return projD(o.y + h / 2 + ((o.rows - 1) / 2) * dy);
  }

  /** 牌河的 tilt（分区 + 统一投影比）；副露/牌墙不走这个 */
  riverTilt(seat) {
    return Object.assign({}, tiltForSlot(seat), { k: this.riverK(seat) });
  }

  /**
   * 牌河块的**屏幕矩形**（左上右下，已含 k 缩放）。
   *
   * 副露要「贴着牌河块」摆，就不能再写死 483 / 797 / 236 / 984 —— 这些是上一版
   * 逐张透视时的屏幕位置，牌河改成整块刚体缩放后近边内收了 20~60px，
   * 写死的锚点会让副露孤零零飘在外侧（用户 2026-10-22：「副牌显示还是异常」）。
   * 一律用本方法现算，牌河怎么变副露都跟着走。
   */
  riverBlockRect(seat) {
    const o = this.riverOrigin(seat);
    const k = this.riverK(seat);
    const w = o.w || RIVER_W;
    const h = o.h || RIVER_H;
    const dx = o.dx || RIVER_DX;
    const dy = o.dy || RIVER_DY;
    const realSeat = this.view && this.view.mySeat !== undefined ? this.seatAt(this.view, seat) : seat;
    const river = this.view && this.view.rivers ? this.view.rivers[realSeat] || [] : null;
    const n = river ? Math.min(river.length, o.cap || Number.MAX_SAFE_INTEGER) : 0;
    // 与 riverPos 完全同一套缩放：x 绕画布中心缩，y 绕牌心缩（yAdj）
    const yAdj = dy > 0 ? -(h * (1 - k)) / 2 : (h * (1 - k)) / 2;
    const rowTop = (row) => o.y + row * dy * k + yAdj + h / 2 - (h * k) / 2;
    const realCols = o.cols;
    const l = W / 2 + (o.x - W / 2) * k;
    const r = W / 2 + (o.x + (realCols - 1) * dx + w - W / 2) * k;
    if (seat === 1 || seat === 3) {
      /*
       * 左右两家：牌河在屏幕上是**竖列**，按牌主视角往「牌主方向」（屏幕左/右）换列。
       * 副露列在块的外侧，所以 x 必须用**整块**的边 —— 若按已铺满的列算，
       * 牌河长到下一列时副露会被挤进还没用到的格子里。
       */
      return { l, r, t: Math.min(rowTop(0), rowTop(o.rows - 1)), b: Math.max(rowTop(0), rowTop(o.rows - 1)) + h * k };
    }
    /*
     * 上下两家：牌在屏幕上是**横排**、沿行增长。上下边按**实际画出来的行数**算，
     * 不是按容量（2026-10-22 第十轮）：容量固定 3 行只为块尺度稳定（`riverK` 仍按
     * 容量取 d），但副露要跟**看得见的牌河**对齐 —— 牌少时牌河只占贴盘的那几行。
     * 两家首行都是行号 0（对家 dy<0，行号 0 = 屏幕下方、贴盘那一排）。
     */
    const rows = n > 0 ? Math.max(1, Math.ceil(n / o.cols)) : o.rows;
    const topA = rowTop(0);
    const topB = rowTop(rows - 1);
    return { l, r, t: Math.min(topA, topB), b: Math.max(topA, topB) + h * k };
  }

  /**
   * 这张弃牌**露出来的高度**（逻辑值，未投影）——叠压后它被邻居盖掉一截。
   * 判据按「谁盖住它」（2026-11-01 终稿，与 `drawRivers` 的绘制序配套）：四家统一
   * 「屏幕更下的那张盖住屏幕更上那张的底」—— 露出带恒在**牌顶**、底条恒被盖：
   *   · 自己（行向下长，顺画）：盖者 = 同列下一排 i+cols（末行无人盖）；
   *   · 上家（列向下长，顺画）：盖者 = 下一张 i+1（末行无人盖）；
   *   · 对家（行向上长，逆画）：盖者 = 屏幕更下的**前出**邻格 i−cols（首行/贴中心
   *     盘那排无人盖）；
   *   · 下家（列向上长，逆画）：盖者 = i−1（末行无人盖）。
   * 露出边四家统一牌顶 → 描边收口恒 visAlign 'top'（见 `jingBorder`）。
   */
  riverVisH(seat, i, n) {
    const o = this.riverOrigin(seat);
    const h = o.h || RIVER_H;
    const dy = o.dy || RIVER_DY;
    const lim = Math.min(n, o.cap || n);
    const { row } = this.riverCell(seat, i);
    let nb = -1;
    if (seat === 0) {
      if (row + 1 < o.rows) nb = i + o.cols;
    } else if (seat === 3) {
      // 列内向下长：盖者 = 下一张 i+1
      if (row + 1 < o.rows) nb = i + 1;
    } else if (seat === 2) {
      if (row - 1 >= 0) nb = i - o.cols;
    } else {
      // 列内向上长：盖者 = 上一张 i−1
      if (row + 1 < o.rows) nb = i - 1;
    }
    return nb >= 0 && nb < lim ? Math.min(h, Math.abs(dy)) : h;
  }

  drawRivers(view) {
    for (let s = 0; s < 4; s++) {
      const slot = this.disp(view, s);
      const river = view.rivers[s] || [];
      const tilt = this.riverTilt(slot);
      // 每家的弃牌都朝他自己（2026-10-20）：上家 +90°、对家 180°、下家 -90°
      // 2026-10-21：牌面改按座位的平放牌图集（slot 传入 → faceA..faceD）
      const rot = rotForSlot(slot);
      /*
       * **绘制顺序 = 「谁压在谁上面」**（2026-11-01 终稿：四家统一「**下一张的白边
       * 压住上一张的立体底条**」—— 底条永远被盖住，四家都是无缝平面）。
       * 2026-11-04 侧河回列主序（牌主视角的一排 = 一根竖列）：
       *   · 自己：列向下长 → 顺画（i 升序），下排盖上排的底 ✓
       *   · 上家：列向下长 → 顺画，下张盖上张的底 ✓
       *   · 对家/下家：列向上长（后出的在屏幕更上）→ **逆画（i 降序）**，
       *     先画屏幕更上的后出牌，让屏幕更下的先出牌盖住它们露出的底 ✓
       * 溢出压末格不受影响（同格互相全盖，谁在上都一样）。
       */
      const order = river.map((_, i) => i);
      if (slot === 1 || slot === 2) order.reverse();
      for (const i of order) {
        const p = this.riverPos(slot, i);
        const visH = this.riverVisH(slot, i, river.length);
        // 描边收口：四家露出带统一在**牌顶**（盖底露顶 → visAlign 'top'，默认值）
        const t2 = visH < p.h
          ? Object.assign({}, tilt, {
              visH,
              visAlign: 'top',
            })
          : tilt;
        this.drawTile(river[i], p.x, p.y, p.w, p.h, view, false, t2, rot, slot);
      }
    }
  }

  /**
   * 对手手牌摞（2026-10-20 二次设计，用户报「手牌显示异常」后的重做）：
   * 原来是「沿 x 错开 5.5 + 每张下漂 1.2」的**斜向级联**，投影一压就成了一条斜着
   * 拖尾的绿条，读不出是「一摞手牌」。现在改成**沿牌主自己的轴向紧密叠压**：
   *   对家（顶）→ 横向一排、朝 180°；上家（左）→ 竖向一列、朝 +90°；
   *   下家（右）→ 右下角铭牌左侧空档、朝 -90°（右侧牌河已占满，竖列放不下）。
   * **步距按深度补偿**（`step ≈ 5.5 / d(y)`）：投影会把顶边的间距压到 0.6 倍，
   * 不补偿的话 13 张只剩 3px 一条边、又变成绿条 —— 补偿后屏幕上都约 5.5px 一条边。
   * 牌张 16×22（比牌河小一号，只作「一摞」示意；精确张数看铭牌「手牌 N」）。
   * 三个落位（屏幕坐标）：对家 ≈ 916..992@22..44、上家 ≈ 259..281 竖列、
   * 下家 ≈ 945..1025@552..570 —— 都不压铭牌、牌河与牌墙（geomcheck 实校）。
   * slot 0（自己）不画：手牌在画布下方 DOM 手牌条，比任何画内摞都大且点得准。
   */
  /**
   * 对手手牌摞（2026-10-20 第三次调整，配合「取消牌墙」）：
   * 牌墙取消后桌面被牌河吃满，**手牌摞挪到四角暗区当 HUD 元素画**（不投影、不吃布局），
   * 右下角留给下家、左上角上家、右上角对家 —— 与各自铭牌同一侧，读起来仍是「他的手牌」。
   * 牌张 18×26、步距 9（屏幕上就是 9px 一条边，12 张约 99px），一眼是「一叠牌」。
   * 精确张数仍看铭牌上的「手牌 N」；slot 0（自己）不画，手牌在画布下方 DOM 手牌条。
   */
  handStackOrigin(slot) {
    /*
     * 2026-10-22：三家对手的手牌改成「看得见的整手牌」（参考图同款）——
     *   对家：**一排 14 张牌背**，38×52，步距 40，居中在 640（x 360..918），贴着顶边；
     *   上家/下家：**竖着一摞**（牌背只露 ~11px 的边），像参考图右侧那条细长牌摞。
     * 改前是 18×26 的小牌背摞在铭牌内侧，几乎看不出是手牌。
     *
     * 2026-10-22（第二轮，用户指红框「一堆太难看」）：上/下家改用源项目的
     * 「立着的牌侧影」贴图 `inhand_l` / `inhand_r`（26×56，白边 + 金背两半）。
     *
     * 2026-10-23（第三轮，用户再发参考图红框）：**每张都是完整的立牌侧影**，
     * 均等缩影到 step 高竖直排列 —— 参考图左列实测 13 段、每段「白顶 + 金背」
     * （ref 放大图 mid row：white[75-97] + gold[102-121]，即左白右金；右列镜像），
     * 段间深色细线来自贴图自带黑底边（y53..55）。改前是「第一张整图 + 后 12 张
     * 只重复贴图中段（srcTop=16/srcH=17）」，既非参考图的均等结构，重复中段还
     * 叠成「条纹柱子」。步距 11→16（参考图牌列约占桌面高 31%：13×16=208）。
     *
     * 2026-10-23（第四轮，用户「为啥不是居中而在顶部开始」）：y 改**垂直居中** ——
     * 参考图牌列实测在桌面 27%..58%（中心 42.5%）；之前为贴近左上铭牌放到 y=96
     * （列中心仅 31%）偏上。按容量 14 张居中：y = (640 − 14×16)/2 = **208**；
     * 13 张时列中心 312（48.8%）、14 张 320（50%），张数变化只跳 8px。
     * 铭牌（左上 y14..68 / 右下 y572..626）、左右牌河（x303 起）与副露都不冲突。
     *
     * 2026-10-24（第五轮 38×52→44×60；**第八轮随牌河格 48×63 再对上**）：
     * 对家 44×60→**48×66**、步距 46→52（13×52+48=724 居中 → x 278）；
     * 左右两侧 19×18→**21×20**（14 张列高 280 → 居中 y=(640−280)/2=**180**），
     * 右侧 x 1200→1203 让左右留白都是 56。这样「对手手牌」和牌河里的牌一样大。
     *
     * 2026-10-30（第二轮间距反馈）：步距 52 > 牌宽 48 的 4px 横缝在真机上也显空隙
     * → **43（= 牌宽 − 5）小幅重叠**，14 张宽 = 13×43+48 = 607 居中 → x 336。
     */
    // 2026-11-03（用户「缩小对家手牌，给桌面上的牌留位置」）：48×66/步距43 →
    // **40×55/步距36**：排宽 13×36+40=508（旧 607），居中 x386..894、y52..107；
    // 两端各腾 ~100px 给横排铭牌（右）与透气。缩放比例与贴图 48×66 一致（0.833）。
    // 2026-11-04 六轮（上/下河 3 行化）：**y52 → 34**（y34..89）——给顶河 3 行块
    // （y108..204）让出上缘，与状态栏（y2..28）保持 6px；结算相位手牌排不画不冲突。
    if (slot === 2) return { x: 386, y: 34, step: 36, horiz: true, w: 40, h: 55, max: 14 };
    /*
     * 2026-10-28（用户报「上下家手牌叠加显示不完整」）：侧影从 21×20/步距 20 放大到
     * **30×54 / 步距 27** —— 步距 20 对牌高 42 只露 48%，缩影到屏上每段仅 ~11×11px，
     * 「一摞牌」读不出单张。锚带同步改：**顶铭牌底 68 与底部紧凑条顶 464 之间**
     * （y72..460，14 张 14×27=378 ≤ 388）—— 居中锚（y180..460）会被 B 档A 后变宽的
     * 侧副露列（colX=119，一列高 ~200，居中带 y191..415）正面撞上。
     * 锚带校验：y77 起 14 张到 455 ≤ 460 ✓；顶 77 ≥ 72（不压顶铭牌）✓；
     * 宽 30 → 左列 x56..86，与侧副露列 119、侧河块 x205 全部错开 ✓。
     */
    // 2026-11-04（用户红框：侧家手牌摞贴屏幕边不符草图）→ 移到草图「手牌」列位
    // （逻辑 ~x175..245 / 镜像 x1035..1105）：摞宽 30 居中 → x195..225 / x1050..1080。
    // 让开：对家横排铭牌（x188..378，y52..106，摞顶 110 之下 4px）、自家副露带
    // （x379..529 / x751..901，y332..441）、侧副露列（x250..372 / x908..1030）、
    // 自家铭牌（已移右下 x1088..1278，与右摞 x 间隔 8）；结算相位整摞不画。
    if (slot === 3) return { x: 195, y: 110, step: 27, horiz: false, w: 30, h: 54, max: 14 };
    return { x: 1050, y: 110, step: 27, horiz: false, w: 30, h: 54, max: 14 };
  }

  drawHandStacks(view) {
    if (view.phase === 'over') return;
    const ctx = this.ctx;
    const back = uiart.art('back');
    for (let s = 0; s < 4; s++) {
      const slot = this.disp(view, s);
      if (slot === 0) continue;
      const o = this.handStackOrigin(slot);
      const n = Math.min(this.effCounts[s] || 0, o.max || 12);
      if (n <= 0) continue;
      /*
       * 2026-10-22（用户报「红框处异常」）：上/下家的手牌原来是一叠 26×36 的整张牌背、
       * 步距 11 → 每格都露出牌背那条**白色顶边**，13 张叠下来成了「一把黄白相间的尺子」。
       * 现在按「一摞牌」画：顶面一张完整牌背，下面每格只取牌背**中段**的一条（去掉顶边），
       * 纵向铺满 → 连成一条干净的牌摞，只留很淡的缝。
       *
       * 2026-10-22 第二轮（用户「左右两家这一堆太难看」）：改用源项目的**立牌侧影**
       * `inhand_l`（上家/左：白边在左、金背在右）/ `inhand_r`（下家/右：金背在左、白边在右）
       * —— 牌背一律朝桌子中心，与源项目一致；不再是整张金色牌背叠出来的「一根金条」。
       *
       * 2026-10-23 第三轮（用户再贴参考图红框）：**每张都画完整侧影**、均等缩影到
       * step 高 —— 参考图实测就是 13 个均等的「白顶 + 金背」段（段间黑细线=贴图黑底边）。
       * 第二轮「第一张整图 + 后续只重复贴图中段」的切片画法作废：中段重复 12 遍会
       * 叠出明显纹理重复，且第一张与后 12 张结构不一致。
       */
      const sideArt = slot === 3 ? uiart.art('inhand_l') : uiart.art('inhand_r');
      /*
       * 2026-10-31（用户「打了牌就从底部少牌，显示是从上到下的不是居中」）：
       * 剩余 n 张围绕**锚带中心**居中排布 —— 出牌后两端各内缩一半，不再顶对齐、
       * 尾部缩水。14 张时偏移 0（与原锚完全一致）。
       */
      const mid = ((o.max || 14) - n) * o.step * 0.5;
      if (!o.horiz && sideArt) {
        for (let i = 0; i < n; i++) {
          const y = o.y + mid + i * o.step;
          // 整张贴图（26×56：白顶边 + 金背 + 黑底边）等比缩影到 17×step。
          // 白:金 ≈ 16:36（源图 mid col 实测），缩影后与参考图每段的双色结构一致。
          ctx.drawImage(sideArt, o.x, y, o.w, o.step);
          // 段间压一条极淡的暗缝：贴图黑底边缩影后不足 1px，补一刀才读得出「一摞牌」
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.fillRect(o.x, y, o.w, 1);
        }
        continue;
      }
      if (!o.horiz && back) {
        for (let i = 0; i < n; i++) {
          const y = o.y + mid + i * o.step;
          // 2026-10-30：整张牌背缩影到 step 高、**整段绘制**（与 sideArt 分支同构，
          // 段间只留 1px 暗缝 —— 侧影是「一摞牌」示意，不参与牌河的平面连排）。
          // 旧画法首张画整张 o.h(54)、后续每格 step+1 从图中段取 → 首张被第二张
          // 盖掉一半（用户报「上下家的手牌同样存在遮挡」的兜底路径成因）。
          ctx.drawImage(back, 0, 0, back.width, back.height, o.x, y, o.w, o.step);
          // 段间压一条极淡的暗缝：贴图缩影后黑底边不足 1px，补一刀才读得出「一摞牌」
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.fillRect(o.x, y, o.w, 1);
        }
        continue;
      }
      for (let i = 0; i < n; i++) {
        const x = o.x + (o.horiz ? mid + i * o.step : 0);
        const y = o.y + (o.horiz ? 0 : mid + i * o.step);
        // 不传 tilt：走平面绘制（HUD 元素，不吃 3D 管线的开销）
        this.drawTile(-1, x, y, o.w, o.h, view, true);
      }
    }
  }

  drawLastMarker(view) {
    const last = view.lastDiscard;
    if (!last) return;
    const river = view.rivers[last.from] || [];
    const i = river.length - 1;
    if (i < 0 || river[i] !== last.tile) return;
    const slot = this.disp(view, last.from);
    // 结算与对局都走局内牌河位置（2026-10-23 起结算不再缩排）
    const p = this.riverPos(slot, i);
    const ctx = this.ctx;
    // 牌河整块走统一投影比（riverTilt），金框才跟牌
    const tilt = this.riverTilt(slot);
    /*
     * 末张框的可见段 = **露出带（叠压收口，visAlign 朝向）∩ 内容框（裁立体条，
     * flatBox）**，再按统一投影式落位：gy = y0 + h/2 + k(A+B−h)/2 − (B−A)/2 ——
     * 「框屏幕中心 = 可见段屏幕中心」解出（projQuad 绕传入矩形自身中心缩、y 不动）；
     * 顶/底对齐与裁切的各情况都是它的特例（jingBorder 的 (1±k)/2 两式即 A=0/A=h−visH）。
     */
    const rot = rotForSlot(slot);
    const visH = this.riverVisH(slot, i, river.length);
    const ins = flatBox(rot, p.x, p.y, p.w, p.h); // 裁掉立体条后牌内容的实际范围
    // 露出带朝向：2026-11-01 绘制序统一后，四家都是「盖底露顶」（原对家/下家为
    // 盖顶露底，随 `drawRivers`/`riverVisH` 一并反转）
    const bottom = false;
    const visA = Math.max(bottom ? p.y + p.h - visH : p.y, ins.y);
    const visB = Math.min(bottom ? p.y + p.h : p.y + visH, ins.y + ins.h);
    const A = visA - p.y;
    const B = visB - p.y;
    const fh = Math.max(4, B - A);
    const k = tilt.k || 1;
    const base = p.y + p.h / 2 + (k * (A + B - p.h)) / 2 - (B - A) / 2;
    const gy = base - 2;
    const gh = fh + 4;
    ctx.save();
    ctx.strokeStyle = '#e6c14b';
    ctx.lineWidth = 2;
    // 金框与牌身同走投影四边形（Lean + 透视 + zw 补偿）；x 向同样按内容框收口
    const fq = projQuad(ins.x - 2, gy, ins.w + 4, gh, resolveZone(tilt));
    quadPath(ctx, fq, 4);
    ctx.stroke();
    ctx.restore();
    /*
     * 末张「活跃牌」指针（2026-11-03，参考图 mahiang-master：**金色水滴悬浮在
     * 末张牌上方、上下点动**——activeCard.png 18×41 就是这枚竖向水滴）：
     *   · 水平：对齐末张可见段中心；
     *   · 垂直：水滴**尖端悬在露出带顶缘上 2px**，整体以 720ms 周期上提 0..6 逻辑px
     *     （点动 = 触牌 → 弹起 → 回落），不做整张罩光；
     *   · 缩放：源 18×41 **× 1.0**（2026-11-04 用户「显示太大」：原 1.6 倍 29×66
     *     比河牌 44×44 的格还高大；现按原尺寸 18×41，屏上 ~15×35 居中悬着）；
     *   · 四家通用：四家河的露出边统一是「牌顶」（见 riverVisH），水滴一律屏幕上方；
     *   · miniapp 端未注入贴图 = null → 静默跳过（只画金边）。
     */
    if (this.activeCardImg) {
      const now = Date.now();
      const lift = -(Math.sin((now / 720) * Math.PI * 2) * 0.5 + 0.5) * 4; // 0..-4
      const dw = 18;
      const dh = 41;
      const cxp = (Math.min(fq[0].x, fq[3].x) + Math.max(fq[1].x, fq[2].x)) / 2;
      const qyTop = Math.min(fq[0].y, fq[1].y, fq[2].y, fq[3].y);
      ctx.save();
      ctx.globalAlpha = 0.95;
      ctx.drawImage(this.activeCardImg, cxp - dw / 2, qyTop - 2 - dh + lift, dw, dh);
      ctx.restore();
    }
    // 弃的是明面精 → 精描边（正精橙 / 副精紫）要在金框**之上**：drawTile 里的精描边先画、
    // 已被上面的金框盖住，这里补画一次（金框垫底、精框在上），两圈都可见（2026-10-18）。
    const gz = view.gz;
    const isPi = gz ? last.tile === gz.zheng[0] : last.tile === view.jingPi;
    const isFu = gz ? last.tile === gz.fu[0] : last.tile === view.jingFu;
    if (isPi || isFu) {
      // 与金框同一可见段收口（base/fh 已算好；tilt 不带 visH → jingBorder 内部不再二次缩）
      this.jingBorder(ins.x, base, ins.w, fh, Math.max(2, Math.floor(p.w * 0.14)), isPi, tilt);
    }
  }

  /**
   * 自家手牌（2026-10-28 C1，接替 2026-10-17 撤走的画布手牌带）。
   *
   * 与旧版的两点不同（旧版被否的根因已消除）：
   *   · 当年画布物理只有 ~500×250（操作区按需占高），牌落到屏上 20×27 点不准；
   *     现在 DOM 手牌带撤除后画布 ~712×356，屏上 ~47×61，与旧 DOM 牌位持平；
   *   · 走 **HUD 平面**（STAND_HUD，proj:false）—— 手牌是最近的牌，不吃透视。
 * 协议（2026-11-04 两段式防误触）：**第 1 击抬高选中、第 2 击同牌才打出**
 * （hitTest 分流 onRaise/onDiscard，tryDiscard 仍拦截报杠/必打），
 * claims 选择期整行蒙罩 + 清空热区（只看不可出）。
 * 每帧把牌位写进 `handRects` 供 `hitTest` 命中。
   */
  drawMyHand(view) {
    if (view.phase === 'over') return;
    const tiles = view.myTiles || [];
    if (tiles.length === 0) return;
    const ctx = this.ctx;
    // view.drawn 是**牌值**（shared：`drawn: Tile | null`），不是索引 —— 先在已排序的
    // myTiles 里定位它，渲染时把那**一张**移到最右端并留间隔（2026-11-05 用户：
    // 「新摸的牌放最右端、和其他牌隔一段距离，出牌后再整理回手牌」）。
    // 出牌后服务端下发 drawn=null → 这里回到纯排序顺序，自然归位，无需客户端记忆。
    const drawnTile = typeof view.drawn === 'number' ? view.drawn : -1;
    const drawnIdx = drawnTile < 0 ? -1 : tiles.indexOf(drawnTile);
    const hasDrawn = drawnIdx >= 0;
    const rowW =
      tiles.length * (MY_HAND_W + MY_HAND_GAP) - MY_HAND_GAP + (hasDrawn ? MY_HAND_DRAWN_GAP : 0);
    let x = Math.round((W - rowW) / 2);
    // claims 是 { options, deadline } 对象（shared GameView），不是数组（2026-11-04 审计 B4：
    // 旧代码取 .length 恒 undefined，claims 期整行蒙罩从未生效）
    const claims = !!(view.claims && view.claims.options && view.claims.options.length > 0);
    // 报杠冻结牌（2026-10-31：服务端按 tile 冻结 —— 展示的三张仍在手牌里、
    // 第 4 张摸到也须等杠，见 server index.ts autoDiscardTile 的同款 frozen 集合）→ 置灰
    const frozen = new Set(
      (view.declared || []).filter((d) => d.seat === view.mySeat).map((d) => d.tile)
    );
    // 出牌开关（hitTest 用）：轮到我且无响应窗口才可点。claims 期 handRects 本就为空，
    // 这里再按 view 现算一道，game.js 侧无需额外簿记（onCanvasDiscard 还有第二道守卫）。
    this.discardEnabled = view.phase === 'playing' && view.turn === view.mySeat && !view.claimWindow;
    // 取消托管开关（2026-11-05）：托管中（服务端代打）点手牌可随时接管，不依赖 turn ——
    // 别人回合也能点；claims 期 handRects 为空，蒙罩仍生效，那里走 🤖 钮取消。
    const myAuto = !!(view.auto && view.auto[view.mySeat] === true);
    this.cancelEnabled = view.phase === 'playing' && !view.claimWindow && myAuto;
    // 两段式出牌（2026-11-04 防误触）：抬高态每帧校验 —— 手牌一变（idx 对不上值）
    // 或交出回合（不可点）立即复位，绝不把上回合的抬高带进新回合。
    if (this.raisedHand) {
      const rh = this.raisedHand;
      if (!this.discardEnabled || view.myTiles[rh.idx] !== rh.tile) this.raisedHand = null;
    }
    const raised = this.raisedHand;
    // 渲染顺序：摸到的那张排到最右端（其余保持排序）；出牌后 drawn=null 自动复原归位
    const order = [];
    for (let i = 0; i < tiles.length; i++) if (i !== drawnIdx) order.push(i);
    if (hasDrawn) order.push(drawnIdx);
    for (let k = 0; k < order.length; k++) {
      const i = order[k];
      if (hasDrawn && k === order.length - 1) x += MY_HAND_DRAWN_GAP; // 摸到的牌前留间隔
      const up = raised && raised.idx === i && raised.tile === tiles[i];
      const y = up ? MY_HAND_Y - MY_HAND_RAISE : MY_HAND_Y;
      this.drawTile(tiles[i], x, y, MY_HAND_W, MY_HAND_H, view, false, STAND_HUD);
      // 精牌角标（2026-10-31，用户附图样：牌角三角 +「精」字，手牌与报杠都要）
      drawJingMark(ctx, jingKindOf(view, tiles[i]), x, y, MY_HAND_W, MY_HAND_H);
      // 报杠冻结牌置灰：罩在牌+角标之上，用户一眼知道这三张不可点
      // （第二击仍有 tryDiscard 拦截 toast「已展示的 X 要等第 4 张」，热区保留给出反馈）
      if (frozen.has(tiles[i])) {
        ctx.save();
        ctx.fillStyle = 'rgba(16,22,30,0.55)';
        roundRect(ctx, x, y, MY_HAND_W, MY_HAND_H, 8);
        ctx.fill();
        ctx.restore();
      }
      if (!claims) this.handRects.push({ x, y, w: MY_HAND_W, h: MY_HAND_H, tile: tiles[i], idx: i });
      x += MY_HAND_W + MY_HAND_GAP;
    }
    if (claims) {
      // 吃碰杠胡选择期：只看不可出（与 DOM 时代 trayActive=false 同语义）
      ctx.save();
      ctx.fillStyle = 'rgba(6,14,10,0.45)';
      roundRect(ctx, Math.round((W - rowW) / 2) - 10, MY_HAND_Y - 8, rowW + 20, MY_HAND_H + 16, 10);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * 状态行（2026-10-28 C1：DOM .g-status 撤除，画进画布顶端小字带 y2..28）。
   *
   * 文案不在 view 里（view 只带牌局状态）→ 由 game.js 每帧写 `table.statusBar`：
   *   { err, text, waits, countdown, settle }，全部可选、全空不画。
   * 「本局结算 ▲」是可点胶囊 → 记 `settleRect`，命中走 `onSettleRestore`。
   * 带宽封顶 640（x320..960）：四角铭牌在 x<280 / x>1000，永不相撞。
   */
  drawStatusBar(view) {
    let s = this.statusBar;
    let parts = [];
    if (s) {
      if (s.err) parts.push({ t: `⚠ ${s.err}`, c: '#f2b8b5', bold: true });
      else if (s.text) parts.push({ t: s.text, c: '#dce8de' });
      if (s.waits) parts.push({ t: s.waits, c: '#f6e3a1' });
      if (s.countdown) parts.push({ t: s.countdown, c: '#9db5a8' });
    }
    const ctx = this.ctx;
    const chipW = 108;
    ctx.font = font(16);
    /*
     * 2026-10-28（用户报「顶部结算信息遮挡」）：带宽封顶 640（x320..960）——
     * 注释从 C1 起一直这么写，代码从没实现；长 err + waits + countdown 同屏时
     * 整条直接顶进左上/右上铭牌（x≤234 / x≥1046）。超宽时把**文案段**按比例
     * 截断（每段以 … 收尾）。
     *
     * 2026-11-05（用户报「结算信息与顶部内容重叠」）：「本局结算 ▲」胶囊从
     * 顶部带尾**挪到画布底部居中** —— 顶部带与 chrome 顶栏（玩法徽章/房码/
     * 牌墙/精文案）同处屏幕顶端一条带，胶囊顶进去正好压住顶栏文字。底部
     * 位于自家手牌可视牌面之下（HUD 牌矩形 512..636，可视底约 566，其下到
     * 画布底是成片绒布空白），常驻无内容可撞；hitTest 里 settleRect 先于
     * 手牌热区判定，点这条带 = 恢复结算面板（点牌面不受影响）。
     */
    const hasSettle = !!(s && s.settle);
    const BAND_MAX = 640;
    const sepW = 18;
    const maxTextW = BAND_MAX - 20 - Math.max(0, parts.length - 1) * sepW;
    if (maxTextW > 0) {
      parts = parts.map((p) => {
        if (ctx.measureText(p.t).width <= maxTextW) return p;
        let t = p.t;
        while (t.length > 1 && ctx.measureText(`${t}…`).width > maxTextW) t = t.slice(0, -1);
        return Object.assign({}, p, { t: `${t}…` });
      });
    } else {
      parts = [];
    }
    const totalW = parts.reduce((a, p) => a + ctx.measureText(p.t).width, 0) + Math.max(0, parts.length - 1) * sepW;
    if (totalW > 0) {
      const midY = 15;
      // 底衬：半透明长条，压在画布最顶端（对家手排 y30 起，不冲突）
      ctx.fillStyle = 'rgba(6,14,10,0.55)';
      roundRect(ctx, 640 - totalW / 2 - 10, 2, totalW + 20, 26, 13);
      ctx.fill();
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      let cx = 640 - totalW / 2;
      for (const p of parts) {
        ctx.fillStyle = p.c;
        ctx.font = font(16, !!p.bold);
        ctx.fillText(p.t, cx, midY);
        cx += ctx.measureText(p.t).width + 18;
      }
    }
    if (hasSettle) {
      // 「本局结算 ▲」+「准备」并排（画布底部居中，2026-11-05 自顶部挪入，见上）。
      // 结算胶囊打开面板；准备胶囊直接发 nextRound（服务端置 ready 并尝试开局），
      // 点过后显示「已准备」并置灰（本地防重发，与服务端回执前行为一致）。
      const by = H - 30;
      const prepText = s.prepReady ? '已准备' : '准备';
      ctx.font = font(14, true);
      const prepW = Math.max(64, Math.round(ctx.measureText(prepText).width) + 28);
      const gap = 8;
      const bx = 640 - (chipW + gap + prepW) / 2;
      roundRect(ctx, bx, by, chipW, 24, 12);
      ctx.fillStyle = 'rgba(230,193,75,0.92)';
      ctx.fill();
      ctx.fillStyle = '#22200f';
      ctx.textAlign = 'center';
      ctx.fillText('本局结算 ▲', bx + chipW / 2, by + 12);
      this.settleRect = { x: bx, y: by, w: chipW, h: 24 };
      const px = bx + chipW + gap;
      roundRect(ctx, px, by, prepW, 24, 12);
      ctx.fillStyle = s.prepReady ? 'rgba(120,132,126,0.9)' : 'rgba(96,180,120,0.95)';
      ctx.fill();
      ctx.fillStyle = s.prepReady ? '#e6efe9' : '#0f1a14';
      ctx.fillText(prepText, px + prepW / 2, by + 12);
      ctx.textAlign = 'left';
      this.prepRect = { x: px, y: by, w: prepW, h: 24 };
    }
  }

  drawCenter(view, deal) {
    const ctx = this.ctx;
    // 中心信息盘（2026-10-20 按用户参考图改「深色牌匾 + 大数字/风字」精简混合）。
    // 2026-10-28 C1 **徽章化**：320×196 → **200×88**（x540..740 · y254..342）——
    //   纵向预算让给上下两条河区（各 ~140），盘收成「大数字+风位 | 立精」徽章。
    //   旧注释「532..750×256..396 勿回退」是当时副露透视拉进 ~38px 的约束，
    //   C1 重排后副露行已改贴「贴手牌行」（y434..506 / 100..172），与徽章带
    //   （y254..342）不再重叠，该约束作废（geomshot 复校：徽章与四河块零相交）。
    //   · 皮 = 深色牌匾（rgba(8,12,18,.85) + 2px 金边），换皮不换几何；
    //   · 左栏「牌墙剩余大数字 + 庄家风位 + 骰点小字」，右栏「立精」；
    // 2026-11-02 三轮：盘上移 254→230 —— 自家河随「手牌通栏」整体上移（y0 326，
    // 块底 ~480），盘让出 324..480 给河；对家河块底 224 ≤ 230−4 仍成立。
    const px = CENTER_BADGE.x;
    const py = CENTER_BADGE.y;
    const pw = CENTER_BADGE.w;
    const ph = CENTER_BADGE.h;
    roundRect(ctx, px, py, pw, ph, 12);
    ctx.fillStyle = 'rgba(8,12,18,0.85)';
    ctx.fill();
    ctx.strokeStyle = '#c9a54a';
    ctx.lineWidth = 2;
    ctx.stroke();

    let wallLeft = view.wallLeft;
    if (deal !== null) {
      const removed = this.computeRemoved(view, deal.done);
      let n = 0;
      for (const r of removed) if (r) n += 1;
      wallLeft = RING_SLOTS - n;
    }

    // ---- 左栏：牌墙剩余大数字 + 庄家风位 ----
    // 2026-10-28 C1 徽章化：左栏中心 96 → **52**，数字 72 → 46，风位 30 → 18，
    // 骰点 12 → 10（y 依徽章高度重排：数字 32 / 风位 64 / 骰点 78）。
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 左栏大数字：LED 光效位图（CDN；取不到回落 fillText）。逐位图定宽排版。
    const wallStr = String(wallLeft);
    const digitImgs = [];
    for (const ch of wallStr) digitImgs.push(uiart.art(`d${ch}`));
    if (digitImgs.length && digitImgs.every(Boolean)) {
      const dh = 46;
      const dw = dh * 0.75; // 数字源图 30×40 比例
      const gap = 2;
      const totalW = digitImgs.length * dw + (digitImgs.length - 1) * gap;
      let dx = px + 52 - totalW / 2;
      const dy = py + 30 - dh / 2;
      for (const im of digitImgs) {
        ctx.drawImage(im, dx, dy, dw, dh);
        dx += dw + gap;
      }
    } else {
      ctx.fillStyle = '#f2f7f3';
      ctx.font = font(46, true);
      ctx.fillText(wallStr, px + 52, py + 30);
    }
    ctx.fillStyle = '#e6c14b';
    ctx.font = font(18, true);
    ctx.fillText(this.wind(view.dealer), px + 52, py + 62);

    // ---- 上回骰子：10px 小字（值不变）----
    let shown = null;
    const c = view.ceremony;
    if (c && c.state === 'rolling' && c.dice) {
      shown = this.revealed(view) ? c.dice : null;
    } else if (!(c && c.state === 'wait-roll' && c.kind === 'deal')) {
      shown = view.lastDice || view.dealDice;
    }
    if (shown) {
      ctx.font = font(10);
      ctx.fillStyle = '#9db5a8';
      ctx.fillText(`骰 ${shown[0]}·${shown[1]}`, px + 52, py + 78);
    }

    // ---- 右栏：立精（HUD 牌 = Lean 不投影， STAND_HUD）----
    const hidden = !!(c && c.kind === 'jing' && !this.revealed(view));
    const gzOn = !!view.gz;
    const pi = gzOn ? view.gz.zheng[0] : view.jingPi;
    const fu = gzOn ? view.gz.fu[0] : view.jingFu;
    const hasFu = fu !== null && fu !== undefined;
    const showJing = gzOn ? view.gz.zheng.length > 0 && !hidden : view.jingPi !== null && view.jingFu !== null && !hidden;
    if (showJing) {
      /*
       * 尺寸按**牌面源图的比例**（279×405 = 0.689）定，不再写死宽。
       * 2026-10-28 C1 徽章化：立精 68 → **52**，牌心 x 188/246 → **116/158**，
       * 牌顶 py+10、标签 py+72（字号 9）、赣州待揭晓 py+82（字号 8）。
       */
      const jh = 52;
      const art0 = tileimg.art(pi);
      const ratio0 = art0 && art0.width && art0.height ? art0.width / art0.height : 279 / 405;
      const jw = Math.round(jh * ratio0);
      this.drawTile(pi, px + 116 - jw / 2, py + 10, jw, jh, view, false, STAND_HUD);
      if (hasFu) this.drawTile(fu, px + 158 - jw / 2, py + 10, jw, jh, view, false, STAND_HUD);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font(9);
      ctx.fillStyle = '#e0a86a';
      ctx.fillText('正精', px + 116, py + 71);
      if (hasFu) {
        ctx.fillStyle = '#b48ae0';
        ctx.fillText('副精', px + 158, py + 71);
      }
      if (gzOn && !view.gz.revealed) {
        ctx.font = font(8);
        ctx.fillStyle = '#9db5a8';
        ctx.fillText('其余 10 张结算揭晓', px + 137, py + 82);
      }
    }

    if (c && c.state === 'wait-roll' && !this.rollClicked) {
      const label = c.kind === 'deal' ? '掷骰开局' : c.kind === 'jing' ? '掷骰翻精' : '掷骰补牌';
      const mine = view.mySeat === c.seat;
      /*
       * 2026-10-21：按钮**铺满盘内**（此刻的唯一动作，盘内其余信息让位）。
       * 2026-10-28 C1：随徽章缩到 184×74（内缩 8/7），字号 22/13。
       */
      const bx = px + 8;
      const by = py + 7;
      const bw = pw - 16;
      const bh = ph - 14;
      roundRect(ctx, bx, by, bw, bh, 10);
      ctx.fillStyle = mine ? '#e6c14b' : 'rgba(28,44,36,0.94)';
      ctx.fill();
      ctx.strokeStyle = mine ? '#f6e3a1' : '#4d675a';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (mine) {
        ctx.fillStyle = '#22200f';
        ctx.font = font(22, true);
        ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1);
      } else {
        ctx.fillStyle = '#9db5a8';
        ctx.font = font(13);
        ctx.fillText(`等待${this.wind(c.seat)}家${label}…`, bx + bw / 2, by + bh / 2 + 1);
      }
      if (mine) this.rollBtn = { x: bx, y: by, w: bw, h: bh };
    }

    /*
     * 四向指示键放在**最后**画（2026-10-24）：它压在盘边线上，必须先让盘内内容
     * （大数字 / 立精 / 掷骰按钮）各就各位，否则会被「等待掷骰」那块铺满的按钮盖住。
     */
    this.drawDirectors(view);
  }

  /**
   * 中心徽章出牌方提示：**当前该谁行动（view.turn）就点亮哪条边**（2026-10-30 重做）。
   *
   * 画法 = 「该侧边线段加粗发光（呼吸）+ 边中点朝外小三角」，占位常量见
   * `DIR_INSET/DIR_LINE_W/DIR_TRI_*`。只画激活的那一条（不画另外三条暗的）。
   *
   * 为什么不再用 `room_time_*` 箭头条贴边：C1 徽章（200×88）比旧盘（320×196）小，
   * 116×26 的条有 22px 探进徽章内部 —— 真机截图里大数字「62」与立精牌顶都被压住，
   * 还与结算横幅互相切碎。现画法线段内侧只探 2.5px、三角内侧 6px，与数字（y261 起，
   * x574..609）、立精（y264 起，x638..716）、骰点（y327..337，x570..614）零冲突；
   * 外侧探出 8px 也都在空缝里（对家河底 ≤240、自家河顶 ≥352、左右无牌）。
   *
   * 呼吸动画靠局中 `render()` 末尾的 `scheduleFrame()` 每帧重绘自然跑，
   * 结算/摊牌相位不重绘，正好那时也不画提示。
   */
  drawDirectors(view) {
    if (view.phase !== 'playing') return;
    const seat = view.turn;
    if (typeof seat !== 'number' || seat < 0) return;
    const slot = this.disp(view, seat);
    const ctx = this.ctx;
    // 徽章矩形（2026-10-28 C1 徽章化：540..740 × 254..342）
    // 2026-11-02 三轮：盘上移 254→230 —— 自家河随「手牌通栏」整体上移（y0 326，
    // 块底 ~480），盘让出 324..480 给河；对家河块底 224 ≤ 230−4 仍成立。
    const px = CENTER_BADGE.x;
    const py = CENTER_BADGE.y;
    const pw = CENTER_BADGE.w;
    const ph = CENTER_BADGE.h;
    const cx = px + pw / 2;
    const cy = py + ph / 2;
    const bottom = py + ph;
    const right = px + pw;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 220);
    ctx.save();
    ctx.globalAlpha = 0.72 + 0.28 * pulse;
    ctx.lineCap = 'round';
    // ---- 该侧边线段（避开 r=12 圆角，内缩 DIR_INSET；线宽一半在徽章内）----
    ctx.shadowColor = 'rgba(246,227,161,0.9)';
    ctx.shadowBlur = 6 + 5 * pulse;
    ctx.strokeStyle = '#f6e3a1';
    ctx.lineWidth = DIR_LINE_W;
    ctx.beginPath();
    if (slot === 0) {
      ctx.moveTo(px + DIR_INSET, bottom);
      ctx.lineTo(right - DIR_INSET, bottom);
    } else if (slot === 2) {
      ctx.moveTo(px + DIR_INSET, py);
      ctx.lineTo(right - DIR_INSET, py);
    } else if (slot === 3) {
      ctx.moveTo(px, py + DIR_INSET);
      ctx.lineTo(px, bottom - DIR_INSET);
    } else {
      ctx.moveTo(right, py + DIR_INSET);
      ctx.lineTo(right, bottom - DIR_INSET);
    }
    ctx.stroke();
    // ---- 边中点朝外小三角：总高 DIR_TRI_H，骑在边线上（外探 8 / 内占 DIR_TRI_H−8）----
    ctx.shadowBlur = 4;
    ctx.fillStyle = '#f2d76b';
    ctx.beginPath();
    if (slot === 0) {
      ctx.moveTo(cx, bottom + 8);
      ctx.lineTo(cx - DIR_TRI_HALF, bottom - (DIR_TRI_H - 8));
      ctx.lineTo(cx + DIR_TRI_HALF, bottom - (DIR_TRI_H - 8));
    } else if (slot === 2) {
      ctx.moveTo(cx, py - 8);
      ctx.lineTo(cx - DIR_TRI_HALF, py + (DIR_TRI_H - 8));
      ctx.lineTo(cx + DIR_TRI_HALF, py + (DIR_TRI_H - 8));
    } else if (slot === 3) {
      ctx.moveTo(px - 8, cy);
      ctx.lineTo(px + (DIR_TRI_H - 8), cy - DIR_TRI_HALF);
      ctx.lineTo(px + (DIR_TRI_H - 8), cy + DIR_TRI_HALF);
    } else {
      ctx.moveTo(right + 8, cy);
      ctx.lineTo(right - (DIR_TRI_H - 8), cy - DIR_TRI_HALF);
      ctx.lineTo(right - (DIR_TRI_H - 8), cy + DIR_TRI_HALF);
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,246,214,0.9)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  revealed(view) {
    const c = view.ceremony;
    if (!c || c.state !== 'rolling' || c.rollAt === null || c.until === null) return true;
    const dur = Math.max(400, c.until - c.rollAt);
    const tumble = Math.min(c.kind === 'gang' ? 1500 : 2200, Math.floor(dur * 0.5));
    if (!this.diceReveal || this.diceReveal.key !== c.rollAt) {
      this.diceReveal = { key: c.rollAt, start: Date.now(), tumble };
    }
    return Date.now() - this.diceReveal.start >= this.diceReveal.tumble;
  }

  jingWallSlot(view) {
    if (view.jingSlot === null || view.jingPi === null) return -1;
    if (view.ceremony && view.ceremony.kind === 'jing' && !this.revealed(view)) return -1;
    return view.jingSlot;
  }

  drawJingHighlight(view) {
    if (!SHOW_WALL) return; // 墙不画了 → 墙上那格翻开的精牌没有落点（盘里已展示立精）
    const slot = this.jingWallSlot(view);
    if (slot < 0 || !view.wallRing || view.jingPi === null) return;
    let seg = null;
    const segs = this.wallSegs(view);
    for (const s of segs) {
      if (s.r === this.segOfCol(slot >> 1)) {
        seg = s;
        break;
      }
    }
    if (!seg) return;
    const p = this.slotPos(seg, slot >> 1, slot & 1);
    const jw = WALL_ACROSS;
    const jh = 38;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    // 2026-10-20：墙面翻开的精牌也按「墙属于哪一家」转向（原来对家顶墙漏了 180°）
    const rot = seg.screen === 3 ? Math.PI / 2 : seg.screen === 1 ? -Math.PI / 2 : seg.screen === 2 ? Math.PI : 0;
    const ctx = this.ctx;
    // 2026-10-20：高亮牌盖在墙面上 → 中心点过投影、尺寸按 d(y) 缩放，
    // 与投影后的墙牌对齐；旋转保持（侧墙是竖牌）。牌本身传 null 分区 = 平面。
    const pc = projPt(cx, cy);
    const d = projD(cy);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 4;
    ctx.translate(pc.x, pc.y);
    ctx.rotate(rot);
    ctx.scale(d, d);
    this.drawTile(view.jingPi, -jw / 2, -jh / 2, jw, jh, view, true);
    ctx.restore();
  }

  drawDieFace(x, y, size, value) {
    const ctx = this.ctx;
    const r = Math.max(4, Math.floor(size * 0.16));
    roundRect(ctx, x, y, size, size, r);
    ctx.fillStyle = '#f7f3e8';
    ctx.fill();
    ctx.strokeStyle = '#b7b09c';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    roundRect(ctx, x + 1, y + size - Math.max(3, size * 0.12), size - 2, Math.max(3, size * 0.12), r - 1);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (value === null) {
      ctx.fillStyle = '#8d8776';
      ctx.font = font(Math.floor(size * 0.5), true);
      ctx.fillText('?', x + size / 2, y + size / 2 + 1);
      return;
    }
    const PIP = {
      1: [4],
      2: [0, 8],
      3: [0, 4, 8],
      4: [0, 2, 6, 8],
      5: [0, 2, 4, 6, 8],
      6: [0, 2, 3, 5, 6, 8],
    };
    const cells = PIP[value] || [];
    const cs = size / 3;
    const pr = Math.max(3, size * 0.1);
    const red = value === 1 || value === 4;
    for (let i = 0; i < 9; i++) {
      if (cells.indexOf(i) < 0) continue;
      const cx = x + (i % 3) * cs + cs / 2;
      const cy = y + Math.floor(i / 3) * cs + cs / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, pr, 0, Math.PI * 2);
      ctx.fillStyle = red ? '#c62828' : '#1c1c2b';
      ctx.fill();
    }
  }

  /**
   * 摊牌各家明牌落位（结算态，2026-11-03 十字布局专属带）：
   *   自己/对家：底/顶**一排** 44×58，按实际张数居中（步距 REVEAL_DX = 牌宽+2）；
   *   上家/下家：外侧竖带**双列**（每列 ≤7 张，`REVEAL_COLS_MAX`），横向格 58×44，
   *     列内步距 = `REVEAL_DY`，列 x 按 `OVER_SIDE.k` 反算 → 投影后同宽同高。
   * 河/副露在结算相位**沿用局内位置**（2026-10-23 用户要求），摊牌走预留空带：
   *   · 对家 y26..77：状态行（底 28）之下、对家河（顶 137）之上；对家横排铭牌
   *     （x188..378）在左 → 排 x 一律 ≥384（14 张 = 642 宽，x384..1026）。
   *   · 自己 y506..563：副露块（底 ~481）之下；结算态自家手牌不画、
   *     左下铭牌在 x55..245 → 居中排 x319..961 与其错开。
   *   · 上/下家：草图「手牌」列位的双列摊牌（每列 ≤7），x142..244 / 镜像
   *     x1036..1138，y110..424 —— 结算相位手牌摞不画（`drawHandStacks` over
   *     返回），与对家横排铭牌（y..106）、侧副露列（x250/x908 起）、四角竖标
   *     （x6..50 / x1230..1274）全部错开；列距收紧为 sw+2（两列靠拢成一手）。
   */
  revealOrigin(slot, n) {
    const cnt = Math.max(1, n || 0);
    if (slot === 2) {
      // 2026-11-04（用户「对齐中轴线」）：去钳位**真居中**（x319..961，中心 640）——
      // 原避让对家铭牌的 x≥384 钳位把整排推右 65px；结算态铭牌改让位（见 drawTag）。
      return { x: 640 - (cnt * REVEAL_DX - 4) / 2, y: 26, vertical: false };
    }
    if (slot === 0) return { x: 640 - (cnt * REVEAL_DX - 4) / 2, y: 506, vertical: false };
    const k = OVER_SIDE.k;
    const sw = RIVER_H * k;
    // 列距收紧为 sw+2（两列靠拢成一手，2026-11-04 草图校位）；列带锚在草图
    // 「手牌」列位（逻辑 x175..245 / 镜像）上：左带 x142..244、右带 x1036..1138
    const colDx = sw + 2;
    const inner = slot === 3 ? colDx + 142 : W - sw - (colDx + 142);
    const per = Math.min(cnt, REVEAL_COLS_MAX);
    // 2026-11-04（用户「对齐中轴线」）：列沿**水平中轴**居中 —— 绘制块中心
    // = o.y + ((per−1)×dy + 牌高)/2（与 k 无关），令其 = 320 反解 y。
    return {
      x: inner,
      y: 320 - ((per - 1) * REVEAL_DY + RIVER_W) / 2,
      vertical: true,
      dy: REVEAL_DY,
      w: RIVER_H,
      h: RIVER_W,
      k,
      per,
      colDx,
    };
  }

  /** 结算相位牌张的 tilt：侧边整块加统一投影比 k，上下两家沿用逐张 d（同一行 d 相同） */
  overTilt(slot) {
    const t = tiltForSlot(slot);
    if (slot === 1 || slot === 3) return Object.assign({}, t, { k: OVER_SIDE.k });
    return t;
  }

  drawRevealHand(view, seat) {
    const slot = this.disp(view, seat);
    // 流局（phase=over 但 reveal=null）时自己那手牌仍要从 myTiles 画出来
    const tiles = (view.reveal && view.reveal[seat]) || (slot === 0 ? view.myTiles || [] : []);
    if (tiles.length === 0) return;
    const tilt = this.overTilt(slot);
    const z = resolveZone(tilt);
    // 摊牌按座位朝向（对家倒 180°）；侧边是横向格 → 不再转 90°（同局内牌河）
    const rot = flatRotForSlot(slot);
    /*
     * 2026-10-21 高亮框改成「**所有牌投影四边形的并集** + 5px 外扩」。
     *
     * 原来是对整块明牌算一个逻辑大矩形再过 projQuad。牌改走「牌心单点透视」后
     * （projQuad 的 rect 分支会把整块按块心的 d 等比缩成一个矩形），而块里的每张牌
     * 各自按自己的 d 缩放 —— 块心缩放 ≠ 逐牌缩放，框必然与牌错位（实测赢家框在半空）。
     * 并集是**由实际牌位反推**的，无论投影怎么改都不会再错。
     */
    const acc = [];
    const push = (x, y, w, h) => {
      // 2026-10-30：并集按**内容框**算（裁掉立体条后牌内容的范围，flatBox）——
      // 否则赢家框会比牌内容多出一条 12.5% 的空边（框与牌之间露桌布缝）。
      const b = flatBox(rot, x, y, w, h);
      const q = projQuad(b.x, b.y, b.w, b.h, z);
      for (const p of q) acc.push(p);
    };
    const o = this.revealOrigin(slot, tiles.length);
    if (!o.vertical) {
      // 横边：单排 REVEAL_W×REVEAL_H，步距 REVEAL_DX；按张数居中（x 在 revealOrigin 里算）
      const HB_W = REVEAL_W;
      const HB_H = REVEAL_H;
      const HB_DX = REVEAL_DX;
      tiles.forEach((t, i) => {
        const x = o.x + i * HB_DX;
        this.drawTile(t, x, o.y, HB_W, HB_H, view, false, tilt, rot, slot);
        push(x, o.y, HB_W, HB_H);
      });
    } else {
      // 竖边：整列竖向居中；14 张单列放不下 → 每 ≤7 张折第二列
      // （`revealOrigin` 的 per/colDx：内列贴副露、外列更靠画布边，两列同属一手牌只留 6px）
      const per = o.per || tiles.length;
      tiles.forEach((t, i) => {
        const col = Math.floor(i / per);
        const off = (o.colDx || 0) * col * (slot === 3 ? -1 : 1); // slot3 外列向左、slot1 向右
        const x = screenToLogicX(o.x + off, o.k);
        const y = o.y + (i % per) * o.dy;
        this.drawTile(t, x, y, o.w, o.h, view, false, tilt, rot, slot);
        push(x, y, o.w, o.h);
      });
    }
    if (acc.length === 0) return;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of acc) {
      if (p.x < x0) x0 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x;
      if (p.y > y1) y1 = p.y;
    }
    const PAD = 5;
    this.revealRects[slot] = [
      { x: x0 - PAD, y: y0 - PAD },
      { x: x1 + PAD, y: y0 - PAD },
      { x: x1 + PAD, y: y1 + PAD },
      { x: x0 - PAD, y: y1 + PAD },
    ];
  }

  /**
   * 副露的牌张尺寸 / 排列方向 / 行内步距（按**屏幕槽位**）。
   *   slot 0/2 → 竖版 36×50（`RIVER_V_W/H`），一组副露沿 x 横排（步距 = 牌宽 − 6）
   *   slot 1/3 → 横向 58×44（`RIVER_H/W`），一组副露沿 y 竖排（步距 = 牌高 − 11）
   * 尺寸全部由**该座位自己的牌河格**派生 —— 牌河格怎么变这里跟走，
   * 这正是「副露与牌河必须同格」这条约束带来的好处，不要再单独写死数字。
   * （2026-11-01 D 方案曾收敛为四家同构 44×58，同日随「四套图集」定稿回退本式；
   *  2026-11-04 九轮上下河换 36×50 竖版格，slot 0/2 分支跟改。）
   */
  meldMetrics(slot) {
    /*
     * 2026-10-22（第十轮，用户「上家和下家的牌还是竖直方向没对齐，左右存在偏移」）：
     * **副露牌的尺寸必须和牌河牌一模一样**——侧边 58×44、上下 36×50。
     *
     * 上一版是「按图集比例反推」（侧边 h=44 → w=54），比牌河牌大一圈；
     * 两者在同一家面前**并排成两列**，一列宽 54、一列宽 44，屏幕上就是「粗细不一、
     * 上下对不齐」，怎么调锚点都救不回来。图集比例（59/48=1.229）与牌河的 1.294
     * 只差 5%，统一到牌河的格子肉眼看不出来，但并排立刻齐了。
     */
    const side = slot === 1 || slot === 3;
    const sc = this._meldScale || 1;
    /*
     * 牌格（2026-11-04 八轮 / 九轮）：**格子纵横比 = 该座位图集单格纵横比**。
     *   · 侧家（slot 1/3）横版 58×44：faceB/faceD 236×192（1.229）；
     *   · 上下（slot 0/2）竖版 36×50：faceA 184×256（0.719）、faceC 168×240（0.700）。
     * 上一稿「四家统一 44×44 方格」两侧都裁（横版左右各 9.3%、竖版上下各 14%），
     * 用户连报两轮「牌面被裁切/压扁」。尺寸来源与纵向预算推导见 `RIVER_V_*` 注释。
     */
    const w = (side ? RIVER_H : RIVER_V_W) * sc;
    const h = (side ? RIVER_W : RIVER_V_H) * sc;
    /*
     * 组内排列方向（2026-11-03 十字布局恢复）：上下家（slot 0/2）横排；左右家
     * （slot 1/3）**竖排** —— 侧家副露块（`MELD_BLOCKS`，八轮起 110 宽）是窄高块，
     * 竖排组（58 宽 × 高 110/143）两列并排恰好放进一块。
     */
    const vertical = side;
    /*
     * 组内步距（「牌压着牌」，2026-11-01 用户定稿）：横排 = 牌宽 − 6 = **30**；
     * 竖排 = 牌高 − 11 = **33** —— 叠压方向正是贴图立体底条朝向的那条边，6/11px
     * 叠压盖住条(~5.5)+白边(2)+圆角(3.5)，条带不露成缝。随 `_meldScale` 等比收。
     */
    const pitch = (side ? RIVER_W - 11 : RIVER_V_W - 6) * sc;
    return { w, h, pitch, vertical };
  }

  /**
   * 一组副露的统一投影比：取**牌河块中心**的 d。
   *
   * 副露原来是逐张按 `d(y)` 缩的：侧边竖排一列 12 张，y 从 268 到 500 → d 从 0.845 到
   * 0.905，牌宽差 6px，整列边缘是一条锯齿。而副露本来就贴着牌河块摆、深度几乎一样，
   * 用块中心那一个 d 最合理 —— 位置（`unprojTileX` 传同一个 k）和尺寸（`projQuad` 的
   * `z.k`）同一把尺子，边缘就直了。
   * 横排（自己/对家）y 不变，块中心算出来本来就等于逐张的 d，行为不变。
   */
  meldK(slot) {
    const R = this.riverBlockRect(slot);
    return projD((R.t + R.b) / 2);
  }

  /**
   * 一组副露沿排列方向的**总长**（横排=宽，竖排=高）。
   *
   * 2026-10-22：必须乘投影比 `d(y)`。`projQuad` 的 `z.rect` 分支是把牌
   * **绕牌心**等比缩 `d`（见其注释），y 坐标本身不动 —— 于是「牌小了、步距没变」，
   * 屏幕上就出现越往远缝越大的观感（用户把一条杠看成「四张牌隔得很开」）。
   * 步距和总长一起乘 `d`，缝才回到设计值 `(pitch − 边长)·d`，也就是 2·d ≈ 1.6px。
   */
  meldSpan(m, slot, y) {
    return this.meldSpanN(m.tiles.length, slot, y);
  }

  /**
   * 同上，但按**张数**算（报杠展示那组不是 meld 对象，只有一个 tiles 数组） */
  meldSpanN(n, slot, y) {
    const mm = this.meldMetrics(slot);
    // 与 drawMeldRow 同一条规则：整组一把尺子（竖排/横排都乘 k），
    // 结算沿用局内副露位置，不再有「横排不乘 k」的分支。
    const k = this.meldK(slot);
    return ((n - 1) * mm.pitch + (mm.vertical ? mm.h : mm.w)) * k;
  }

  meldWidth(m, slot, y) {
    return this.meldSpan(m, slot, y);
  }

  /**
   * 副露（吃/碰/杠）落位 —— 2026-11-03 十字布局：每家两个副露块（`MELD_BLOCKS`），
   * 块内 ≤2 组，块内居中、超块整块等比收紧（兜底，现行几何 scale 恒 1）。
   *
   * **参数是屏幕槽位（slot），不是真实座位**（2026-10-21 澄清）：
   * `meldMetrics` / 块表全部按槽位判定，所以调用方传 slot。
   * 只有「报杠展示」需要真实座位去筛 `view.declared` —— 用 `seatAt()` 反算。
   * 结算相位（2026-10-23 用户要求）**沿用局内位置**，不换结算专用排布；
   * 报杠展示组在结算相位跳过（已并入摊牌，见下）。
   */
  drawMelds(melds, slot) {
    const view = this.view;
    const seat = view ? this.seatAt(view, slot) : slot;
    const list = melds || [];
    const over = !!(view && view.phase === 'over');
    const decl = over
      ? []
      : (view && view.declared ? view.declared : [])
          .filter((d) => d.seat === seat)
          .map((d) => d.tile);
    if (list.length === 0 && decl.length === 0) return;

    const rot = flatRotForSlot(slot);
    const groups = [];
    if (decl.length > 0) groups.push({ decl: true });
    for (const m of list) groups.push({ m });

    const GAP = 6;
    const vertical = slot === 1 || slot === 3;
    const k = this.meldK(slot);
    const blocks = MELD_BLOCKS[slot];
    for (let bi = 0; bi * 2 < groups.length && bi < blocks.length; bi++) {
      const B = blocks[bi];
      const gs = groups.slice(bi * 2, bi * 2 + 2);
      // 量块内需求 → 需要时整块等比收紧（需求随 sc 线性缩，min(1, B/need) 即不动点）
      this._meldScale = 1;
      const spanOf = (g) => this.meldSpanN(g.decl ? decl.length : g.m.tiles.length, slot, 0);
      let needW;
      let needH;
      if (vertical) {
        needW = gs.length * this.meldMetrics(slot).w * k + GAP * (gs.length - 1);
        needH = Math.max(...gs.map(spanOf));
      } else {
        // slot 0/2 共用（2026-11-04 副露带上下对等：两带都是 52 高单行双块，
        // 组并排占宽 → needW=总宽、needH=单组高）。⚠ slot0 之前误走「竖叠 2 组」
        // 的旧量法（needH=2×h·k+GAP≈109 > 块高 52），_meldScale 被压到 ~0.48，
        // 用户报「自己的副牌显示的这么小」——量法必须与落位（单行并排）一致。
        needW = gs.reduce((a, g) => a + spanOf(g), 0) + GAP * (gs.length - 1);
        needH = this.meldMetrics(slot).h * k;
      }
      this._meldScale = Math.min(1, B.w / needW, B.h / needH);
      const mm = this.meldMetrics(slot);
      // 落位：drawMeldRow/drawDeclared 收**屏幕左缘**（内部自己做 unprojTileX 反补偿）；
      // y 传「绘制顶 = sy」对应的逻辑值（drawTile 绘制顶 = y + h(1−k)/2）
      const drawAt = (g, sx, sy) => {
        const y = sy - (mm.h * (1 - k)) / 2;
        if (g.decl) this.drawDeclared(decl, sx, y, rot, slot);
        else this.drawMeldRow(g.m, sx, y, rot, slot);
      };
      if (vertical) {
        // 侧家：块内并排 2 列（竖排组），列距 = 列宽 + 6
        const colW = mm.w * k;
        const total = gs.length * colW + GAP * (gs.length - 1);
        let sx = B.x + (B.w - total) / 2;
        for (const g of gs) {
          drawAt(g, sx, B.y);
          sx += colW + GAP;
        }
      } else {
        // 自己/对家（2026-11-04 上下对等）：单行并排 2 组，块内居中
        const total = gs.reduce((a, g) => a + spanOf(g), 0) + GAP * (gs.length - 1);
        let sx = B.x + (B.w - total) / 2;
        const sy = B.y + (B.h - mm.h * k) / 2;
        for (const g of gs) {
          drawAt(g, sx, sy);
          sx += spanOf(g) + GAP;
        }
      }
      this._meldScale = 1;
    }
  }

  /** 赣州「报杠展示三张」：冻结不能打、但必须看得见 → 金框摆在副露块末端。
   *  2026-10-21：尺寸/步距/排列方向全跟副露走 `meldMetrics(slot)`（侧边是横向格竖排）。
   *  返回这组展示牌沿排列方向的末端坐标。 */
  drawDeclared(tiles, x, y, rot, slot) {
    const ctx = this.ctx;
    const tilt = TILE_TILT.zones.meld;
    const mm = this.meldMetrics(slot);
    let cx = x;
    let cy = y;
    let lastStart = 0;
    let cursor = 0;
    const n = tiles.length;
    // 与 drawMeldRow 同一个统一投影比（整列一把尺子，边缘才直）
    const k = this.meldK(slot);
    for (let i = 0; i < n; i++) {
      const t = tiles[i];
      // cx/cy 是**屏幕坐标**；drawTile 内部还会按 d(y) 往中线拉，所以先反补偿，
      // 高亮金框用同一个 px 算 projQuad → 框和牌重合。
      const px = unprojTileX(cx, cy, mm.w, mm.h, k);
      // 侧边竖排叠压 → 这张只露出 pitch，牌身和**金框**都按露出带走
      const visH = mm.vertical && i < n - 1 ? mm.pitch : mm.h;
      let t2 = visH < mm.h ? Object.assign({}, tilt, { visH }) : tilt;
      t2 = Object.assign({}, t2, { k });
      this.drawTile(t, px, cy, mm.w, mm.h, this.view, false, t2, rot, slot);
      // 报杠侧牌的精角标（2026-10-31，与手牌同款三角彩标，跟随投影透视）
      drawJingMark(ctx, jingKindOf(this.view, t), px, cy, mm.w, mm.h, resolveZone(t2));
      // 报杠身份角标（2026-10-31 二改：三张各带一个 + 换墨黑底与精标区分）——
      // 红底=正精、紫底=副精、黑底=报杠；首版金底与精标的金字在真机上易混淆
      drawJingMark(ctx, 0, px, cy, mm.w, mm.h, resolveZone(t2), '杠', '#16191e');
      ctx.save();
      ctx.strokeStyle = '#e6c14b';
      ctx.lineWidth = 2;
      quadPath(ctx, projQuad(px - 1, cy - 1, mm.w + 2, visH + 2, resolveZone(t2)), 4);
      ctx.stroke();
      ctx.restore();
      const step = mm.pitch * k;
      lastStart = cursor;
      cursor += step;
      if (mm.vertical) cy += step;
      else cx += step;
    }
    const len = (mm.vertical ? mm.h : mm.w) * k;
    return (mm.vertical ? y : x) + lastStart + len;
  }

  /** 画一组副露，返回沿排列方向的末端坐标（横排回 x，竖排回 y） */
  drawMeldRow(m, x, y, rot, slot) {
    const self = this;
    const tilt = TILE_TILT.zones.meld;
    const mm = this.meldMetrics(slot);
    /*
     * 组内牌距（2026-10-22 定稿）—— 只有**屏幕上**的缝/叠才算数，所以按「这一步走完
     * 之后牌心在屏幕上挪多远」来推：整组用统一投影比 `meldK`，x 先 `unprojTileX(k)`
     * 拉回屏幕坐标，牌宽 w·k → 步距同样 **乘 k**。不带「不小于边长」的下限 ——
     * pitch 只比边长大 2，任何 k<1 都被下限吃光。
     */
    const k = this.meldK(slot);
    const stepOf = () => mm.pitch * k;
    // 牌张在屏幕上实际占的长度（末张末端要用它，不能用步距，两者差 pitch−边长）
    const lenOf = () => (mm.vertical ? mm.h : mm.w) * k;
    let cursor = 0;
    let lastStart = 0;
    const n = m.tiles.length;
    m.tiles.forEach((t, i) => {
      const down = m.type === 'angang' && (i === 1 || i === 2);
      const tx = mm.vertical ? x : x + cursor;
      const ty = mm.vertical ? y + cursor : y;
      // 反补偿 x：副露列/行贴着牌河块摆，位置要能被「屏幕坐标」直接读。
      const px = unprojTileX(tx, ty, mm.w, mm.h, k);
      // 叠压（侧边竖排）时这张牌只露出 pitch 那么高 → 精描边要收口，
      // 否则框底边埋进下一张牌身（与牌河同一个问题，见 jingBorder）
      let t2 = tilt;
      if (mm.vertical && i < n - 1) t2 = Object.assign({}, tilt, { visH: mm.pitch });
      t2 = Object.assign({}, t2, { k });
      /*
       * 2026-10-22（用户「自己和对家的暗杠翻面牌用 opposite_block_back_0 这张贴图」）：
       * 暗杠中间两张是**扣着的**，自己/对家（slot 0/2，竖版牌）换成 44×72 那张
       * 偏瘦长的金背（`back_op`）。左右两家是**横躺牌**，塞竖版牌背会变形，
       * 所以仍用默认 `back`；要改的话得再出一张横版牌背，不是换个 key 的事。
       */
      if (down && (slot === 0 || slot === 2)) t2 = Object.assign({}, t2, { backKey: 'back_op' });
      self.drawTile(down ? -1 : t, px, ty, mm.w, mm.h, self.view, false, t2, rot, slot);
      lastStart = cursor;
      cursor += stepOf();
    });
    /* 返回**末张牌的末端**：调用方据此推进组间距，累计误差不会让行尾多出
     * (1−d) 的空（原来返回未投影的总长，行尾就永远比牌多一截）。 */
    return (mm.vertical ? y : x) + lastStart + lenOf();
  }

  /**
   * 四角铭牌（2026-10-18 重排 168×50 → 同日再放大 220×54，用户「铭牌字号过小」；
   * **2026-10-20 头像化**：用户参考图四角是「头像 + 积分」的商业牌桌样式 —— 我们没有
   * 头像资产（微信头像需协议加 avatarURL + CDN 域名登记，属独立需求），改用
   * **风位字圆牌**占位：金边深底 / 庄家金底，风位随庄（`this.wind(seat)`））。
   *
   * 顶部两块（220×54）第一行：风位圆牌（34px）+ `庄` + `宝×N` + `昵称·我`（左）/
   * 累计总分（右）；第二行：**「手牌 N」**（左，带底衬的胶囊）/ 状态（右）。
   * 底部两块（44×88 竖角标，2026-10-30）见函数内注释 —— 信息同构、竖排五行。
   *
   * 为什么张数要写进铭牌：画布里的对手手牌背已经整条删掉（四条边全部让给牌河），
   * 「还剩几张」必须另有出口。文案固定为「手牌 N」而不是光秃秃的「N 张」——
   * 牌河现在占四条边，只写张数会被读成弃牌数。数值取 `view.counts`
   * （服务端 `hands.map(h => h.length)`，摸牌 +1、出牌 -1、碰/杠 -n），每帧跟着状态走。
   *
   * 2026-10-30 几何预算（铭牌贴四角）：顶部 y14..68（右上按胶囊实测下移，≤50 起
   * 仍不压对家河顶 106）；底部竖角标 y538..626 × x14..58 / x1222..1266（底留 14
   * 与顶对称），手牌行缩到 75 宽后 x67..1213 让出两端 9px 缝；四角都不压牌河/侧影。
   * `tagRects`（hitTest 点击区 / 气泡锚点 / 表情飞行动画锚点）随 pos 同步更新。
   */

  /**
   * 铭牌头像 / 风位圆（2026-11-04）：优先画玩家头像（圆形裁剪），右下角压一枚小风位角标
   * 保住座位辨识；庄家头像亮金边、角标金底。头像取不到（未选/未解码）回退原风位圆。
   *
   * ⚠ 庄标（2026-11-04 补回）：「庄」字红金印章（`uiart.art('banker')`，即 `public/ui/hud/banker.webp`）
   *   曾在 104bfdc 重构 web 客户端时被删掉 —— 贴图还在、预热键表里还有 `banker`，但没人画它，
   *   于是庄家在铭牌上**没有任何标识**。现放头像**左上角**（与右下角风位角标对角），
   *   不挤占昵称行、不改铭牌整体布局。
   *   取不到位图 → 回落金底「庄」字小方章（语义不变）。
   *
   * @param id 头像 id（如 'a05'），空串走回退
   * @param cx,cy 圆心 @param r 半径 @param dealer 是否庄家 @param windChar 风位字（东南西北）
   */
  drawAvatarOrWind(ctx, id, cx, cy, r, dealer, windChar, off) {
    const img = id ? avatarart.art(id) : null;
    if (!img) {
      // 回退：风位圆（庄=金底）
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = dealer ? '#e6c14b' : 'rgba(0,0,0,0.35)';
      ctx.fill();
      ctx.strokeStyle = '#e6c14b';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = dealer ? '#22200f' : '#e6c14b';
      ctx.font = font(r > 14 ? 17 : 14, true);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(windChar, cx, cy + 1);
      ctx.textBaseline = 'alphabetic';
      if (dealer) this.drawDealerStamp(ctx, cx, cy, r, off);
      return;
    }
    // 头像圆（裁剪 + 暗底防透明边）
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();
    ctx.clip();
    try {
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    } catch (e) {
      /* 解码中跳过 */
    }
    ctx.restore();
    // 金边（庄家亮金 / 普通浅白）
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = dealer ? '#f6e3a1' : 'rgba(255,255,255,0.3)';
    ctx.lineWidth = dealer ? 2 : 1;
    ctx.stroke();
    // 风位小角标（右下）：保住座位辨识
    const br = Math.max(6, r * 0.34);
    const bx = cx + r * 0.66;
    const by = cy + r * 0.66;
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = dealer ? '#e6c14b' : 'rgba(0,0,0,0.6)';
    ctx.fill();
    ctx.fillStyle = dealer ? '#22200f' : '#e6c14b';
    ctx.font = font(Math.round(br * 1.1), true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(windChar, bx, by + 1);
    ctx.textBaseline = 'alphabetic';
    if (dealer) this.drawDealerStamp(ctx, cx, cy, r, off);
  }

  /**
   * 庄标（2026-11-04 补回）：头像**左上角**的「庄」字金章。
   *
   * 用 CDN 贴图 `ui/hud/banker.webp`（240×240 金框黄字方章）；取不到 → 回落矢量金底「庄」字。
   * 位置 = 头像圆左上对角（与右下角风位角标对称），尺寸 = r×0.95、圆心偏移 r×0.70。
   *   这组系数是四方案对比后选的：庄字清晰可辨、脸仍完整露出、像挂在角上的徽章
   *   （r×1.06 会遮住脸、r×0.72 会像浮在旁边）。
   *
   * ⚠ 竖排铭牌头像只有 26px（r=13）→ 贴图缩到 12px 会糊成一片，
   *   故 **尺寸 < 16px 时一律走矢量**（金底「庄」字，字高约 8px 仍清晰）。
   *
   * @param cx,cy 头像圆心 @param r 头像半径
   * @param off 圆心偏移系数（默认 0.70；竖排传 0.58 —— r 小，按比例偏移会顶出铭牌上沿）
   */
  drawDealerStamp(ctx, cx, cy, r, off) {
    const o = typeof off === 'number' ? off : 0.7;
    const size = Math.max(13, Math.round(r * 0.95));
    const sx = cx - r * o - size / 2;
    const sy = cy - r * o - size / 2;
    // 尺寸够大才用位图；小尺寸（竖排 26px 头像）走矢量，避免缩放糊掉
    const stamp = size >= 16 ? uiart.art('banker') : null;
    if (stamp) {
      try {
        ctx.drawImage(stamp, sx, sy, size, size);
        return;
      } catch (e) {
        /* 解码中/绘制失败 → 走矢量兜底 */
      }
    }
    // 矢量兜底：金底「庄」字小方章（描橙边，与 banker.webp 的橙金章同风格）
    roundRect(ctx, sx + 1, sy + 1, size - 2, size - 2, 3);
    ctx.fillStyle = '#e6c14b';
    ctx.fill();
    ctx.strokeStyle = '#c8853a';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#22200f';
    ctx.font = font(Math.round(size * 0.62), true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('庄', sx + size / 2, sy + size / 2 + 1);
    ctx.textBaseline = 'alphabetic';
    // ⚠ 必须还原成 'center'：drawAvatarOrWind 的约定是结束时 textAlign='center'
    //   （风位角标是居中画的）。若这里留 'left'，**后续「宝」倍数泡的 `×N` 会左对齐**
    //   → 「×」在圆心、「N」跑到圆外被铭牌边裁掉。
    ctx.textAlign = 'center';
  }

  drawTag(view, seat) {
    const ctx = this.ctx;
    const slot = this.disp(view, seat);
    /*
     * 四家铭牌（2026-11-02 四轮「贴各家手牌区」，用户点名）：
     *   · 对家（slot 2）：**对家手牌排左边**（排 x313..968 y52..118 → 竖标 x261..305，
     *     y52..164 与排顶对齐）；
     *   · 上家（slot 3）/ 下家（slot 1）：**手牌摞背后**（摞 x56..86 / x1194..1224，
     *     y77..455 居中带 → 竖标贴更外侧 x6..50 / x1230..1274，纵向随摞居中 y210..322）；
     *   · 自己（slot 0）：**手牌上方左端**（手牌 y512 起、操作栏居中 290..990 →
     *     竖标 x6..50, y478..590，与两者都缝 ≥8）。
     * 统一 44×112 五行竖标；胶囊避让只约束对家（顶部唯一与顶栏同带的铭牌）。
     */
    /*
     * 2026-11-03 四轮（用户红框）：自己/对家改**横排 190×54** ——
     *   · 对家：手牌排**右侧**（排 x313..968 → 竖标位改横排 x976 起，y52 与排顶对齐；
     *     胶囊实测更靠左时按 cap.left−8 收排）；
     *   · 自己：手牌上方左端红框位（x104, y446 —— 左侧副露柱底 429 之下、手牌 512 之上）；
     *   · 上家/下家维持竖标 44×112（手牌摞背后）。
     */
    const TAG_W = 44;
    const TAG_H = 112;
    const TAG_HW = 190; // 横排宽
    const TAG_HH = 54; // 横排高
    const hs2 = this.handStackOrigin(2);
    // 2026-11-03（用户「铭牌放手牌左侧，不遮挡」）：排左缘 − 8 − 排宽。
    // 胶囊在右上（左缘逻辑 >1100），与左侧位无冲突；左側元素（副露柱 y204 起、
    // 上家竖标 y210 起）均在 y106 之下 → y52..106 安全。
    let tx2 = hs2.x - 8 - TAG_HW;
    const pos = {
      // 2026-11-04（草图校位）：自家铭牌移到**右下**（草图示意位 x1088..1278）——
      // 左下 x55..245 原位与侧家手牌列（x195..225）冲突。结算相位仍在 y512 一行。
      0: [1088, view && view.phase === 'over' ? 512 : 446, TAG_HW, TAG_HH],
      // 上/下家竖标（2026-11-04 参考图）：**左右边缘竖直居中**（y244..356），
      // 不再贴顶角 —— 与各自手牌列（x195..225 / x1050..1080）左右相邻读作一家；
      // 让开左轨菜单/语音钮（x≈51..78，y≈82..170）与结算侧摊牌列（x142..244 /
      // x1036..1138，结算相位错 x 12px）。
      1: [W - 130, 244, TAG_W, TAG_H], // 竖标：右缘居中
      // 对家横排（2026-11-04）：局内贴手牌排左侧（tx2）；**结算态让位 x123** ——
      // 摊牌行改真居中（x319..961）后原位会压住排的左端。
      2: [view && view.phase === 'over' ? 123 : tx2, 52, TAG_HW, TAG_HH],
      3: [86, 244, TAG_W, TAG_H], // 竖标：左缘居中
    };
    const isTurn = view.phase === 'playing' && view.turn === seat;
    const isWinner = view.phase === 'over' && view.winner === seat;
    const me = seat === view.mySeat;
    const dealer = seat === view.dealer;
    const offline = view.connected !== undefined && !view.connected[seat];
    const autoPlay = view.auto !== undefined ? view.auto[seat] === true : offline;
    // 局内暂离（quit）：座位在、托管代打，但人已回房间页 —— 与普通托管分开显示（2026-11-05）
    const awayPlay = view.away !== undefined ? view.away[seat] === true : false;
    const xy = pos[slot];
    const x = xy[0];
    const y = xy[1];
    const w = xy[2];
    const h = xy[3];
    const horizontal = w > 100; // 横排铭牌（自己/对家）
    // 语音座位态（2026-11-03 二期）：宿主注入的绝对座位布尔 → 本铭牌是否在说/闭麦
    const speaking = !!(this.speakingSeats && this.speakingSeats[seat]);
    const voiceMuted = !!(this.mutedSeats && this.mutedSeats[seat]);

    if (horizontal) {
      /*
       * 横排铭牌（自己/对家，190×54）：风位圆（庄=金底+宝泡）· 昵称 · 分数 ·
       * 右侧「手牌 N」· 最右状态（托管/掉线/出牌中/胡牌）。
       */
      ctx.textBaseline = 'alphabetic';
      roundRect(ctx, x, y, w, h, 8);
      ctx.fillStyle = isWinner ? 'rgba(230,193,75,0.3)' : 'rgba(0,0,0,0.4)';
      ctx.fill();
      const pulseH = 0.5 + 0.5 * Math.sin(Date.now() / 280);
      ctx.strokeStyle = isWinner
        ? '#f6e3a1'
        : isTurn
          ? `rgba(230,193,75,${0.55 + 0.45 * pulseH})`
          : me
            ? 'rgba(230,193,75,0.45)'
            : 'rgba(255,255,255,0.15)';
      ctx.lineWidth = isWinner ? 3 : isTurn ? 3 : 1;
      ctx.stroke();
      // 语音说话光环（2026-11-03 二期）：绿色（Date.now 正弦，playing 相位 scheduleFrame
      // 自驱动重绘天然有动画），与 isTurn 金环区分；宿主未注入（speakingSeats=null）永不触发。
      // 双模式（2026-11-05 B 方案）：voiceReactive=true（说话人事件有数据）= **呼吸**环
      // 「正在说话」；false（真机从不触发，降级「开麦即亮」）= **常亮**环，二者视觉可辨。
      if (speaking) {
        const vp = this.voiceReactive === false ? 0.85 : 0.5 + 0.5 * Math.sin(Date.now() / 300);
        ctx.save();
        ctx.strokeStyle = `rgba(67,192,124,${0.45 + 0.4 * vp})`;
        ctx.lineWidth = 2.5;
        roundRect(ctx, x - 3, y - 3, w + 6, h + 6, 11);
        ctx.stroke();
        ctx.restore();
      } else if (voiceMuted) {
        // 闭麦角标：右上角小 🔇（对位大厅座位卡 .seat-voice）
        ctx.save();
        ctx.textAlign = 'right';
        ctx.font = font(10);
        ctx.fillText('🔇', x + w - 8, y + 16);
        ctx.restore();
      }
      // 头像（2026-11-04）：玩家头像优先，右下角压风位小角标；缺图回退风位圆
      const hcx = x + 27;
      const hcy = y + 27;
      this.drawAvatarOrWind(ctx, (view.avatars && view.avatars[seat]) || '', hcx, hcy, 17, dealer, this.wind(seat));
      const baoH = (view && view.bao && view.bao[seat]) || 1;
      if (baoH > 1) {
        ctx.beginPath();
        ctx.arc(x + 44, y + 8, 7.5, 0, Math.PI * 2);
        ctx.fillStyle = '#c3603d';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = font(8, true);
        ctx.textAlign = 'center';
        // ⚠ 基线对齐**圆心 +3**（8px 字的视觉中心），不要用 hcy-8（那是圆心下 11px → 数字掉到圆外）
        ctx.fillText('×' + baoH, x + 44, y + 11);
      }
      // 昵称 + 分数（中部）
      const rawN = (view.names && view.names[seat]) || '';
      let nm = rawN ? rawN + (me && rawN !== '我' ? '·我' : '') : this.wind(seat);
      ctx.font = font(13, true);
      while (nm.length > 2 && ctx.measureText(nm).width > 84) nm = nm.slice(0, -1) + '…';
      ctx.textAlign = 'left';
      ctx.fillStyle = isWinner ? '#ffe9a8' : isTurn ? '#e6c14b' : '#e8efe9';
      ctx.fillText(nm, x + 52, y + 21);
      const tvH = (view.totals && view.totals[seat]) || 0;
      ctx.font = font(12, true);
      ctx.fillStyle = tvH > 0 ? '#43c07c' : tvH < 0 ? '#e07a6a' : '#9db5a8';
      ctx.fillText(tvH > 0 ? '+' + tvH : String(tvH), x + 52, y + 41);
      // 右侧：手牌 N
      const nH = this.effCounts[seat] || 0;
      ctx.textAlign = 'right';
      ctx.font = font(10);
      ctx.fillStyle = '#c8d8cc';
      ctx.fillText('手牌', x + w - 34, y + 21);
      ctx.font = font(18, true);
      ctx.fillStyle = '#f2f7f3';
      ctx.fillText(String(nH), x + w - 10, y + 23);
      // 状态（右下）：结算相位优先显示「已准备/未准备」（掉线单独提示，掉线不阻塞开局）
      ctx.font = font(12);
      if (view.phase === 'over' && Array.isArray(view.ready)) {
        if (offline) {
          ctx.fillStyle = '#e0a86a';
          ctx.fillText('掉线', x + w - 10, y + 43);
        } else if (view.ready[seat]) {
          ctx.fillStyle = '#43c07c';
          ctx.fillText('✓ 已准备', x + w - 10, y + 43);
        } else {
          ctx.fillStyle = '#9db5a8';
          ctx.fillText('未准备', x + w - 10, y + 43);
        }
      } else if (isWinner) {
        ctx.fillStyle = '#ffe9a8';
        ctx.fillText('胡牌！', x + w - 10, y + 43);
      } else if (awayPlay) {
        ctx.fillStyle = '#e0a86a';
        ctx.fillText('已退出', x + w - 10, y + 43);
      } else if (autoPlay || offline) {
        ctx.fillStyle = '#e0a86a';
        ctx.fillText(offline ? '掉线' : '托管中', x + w - 10, y + 43);
      } else if (isTurn) {
        ctx.fillStyle = '#e6c14b';
        ctx.fillText('出牌中', x + w - 10, y + 43);
      }
      ctx.textAlign = 'left';
      this.tagRects[slot] = { x, y, w, h };
      return;
    }

    /*
     * 竖标渲染（上下家同款）：textBaseline 钉 alphabetic。
     */
    ctx.textBaseline = 'alphabetic';
    roundRect(ctx, x, y, w, h, 8);
    ctx.fillStyle = isWinner ? 'rgba(230,193,75,0.3)' : 'rgba(0,0,0,0.4)';
    ctx.fill();
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 280);
    ctx.strokeStyle = isWinner
      ? '#f6e3a1'
      : isTurn
        ? `rgba(230,193,75,${0.55 + 0.45 * pulse})`
        : me
          ? 'rgba(230,193,75,0.45)'
          : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = isWinner ? 3 : isTurn ? 3 : 1;
    ctx.stroke();
    // 语音说话光环（2026-11-03 二期，竖标分支）：同横排分支；双模式见横排注释（呼吸=说话/常亮=开麦）
    if (speaking) {
      const vp = this.voiceReactive === false ? 0.85 : 0.5 + 0.5 * Math.sin(Date.now() / 300);
      ctx.save();
      ctx.strokeStyle = `rgba(67,192,124,${0.45 + 0.4 * vp})`;
      ctx.lineWidth = 2.5;
      roundRect(ctx, x - 3, y - 3, w + 6, h + 6, 11);
      ctx.stroke();
      ctx.restore();
    } else if (voiceMuted) {
      // 闭麦角标：竖标底部小 🔇（此刻 ccx 尚未定义，用 x + w/2 同值）
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = font(10);
      ctx.fillText('🔇', x + w / 2, y + h - 5);
      ctx.restore();
    }

    // ---- 头像（2026-11-04，庄家金边）+ 宝倍数小泡 ----
    const ccx = x + 22;
    const ccy = y + 17;
    this.drawAvatarOrWind(ctx, (view.avatars && view.avatars[seat]) || '', ccx, ccy, 13, dealer, this.wind(seat), 0.58);
    // 竖排庄标（2026-11-04 补回）：庄家每局轮转，可能落到上/下家（竖排铭牌），
    // 不补的话这些局的庄家**没有任何标识**。头像只有 26px → 走矢量金底「庄」字。
    const bao = (view && view.bao && view.bao[seat]) || 1;
    if (bao > 1) {
      ctx.beginPath();
      ctx.arc(x + 36, y + 8, 7.5, 0, Math.PI * 2);
      ctx.fillStyle = '#c3603d';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = font(8, true);
      ctx.textAlign = 'center';
      // ⚠ 基线对齐圆心 +3（同横排）；textAlign 必须是 'center'（drawAvatarOrWind 的约定），
      //   否则「×」在圆心、「N」跑到圆外被铭牌边裁掉
      ctx.fillText(`×${bao}`, x + 36, y + 11);
    }
    ctx.textAlign = 'left';

    // ---- 昵称（9px，超 38px 截断）----
    const rawName = (view.names && view.names[seat]) || '';
    let label = rawName ? `${rawName}${me && rawName !== '我' ? '·我' : ''}` : this.wind(seat);
    ctx.font = font(9);
    while (label.length > 2 && ctx.measureText(label).width > 38) {
      label = `${label.slice(0, -2)}…`;
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = isWinner ? '#ffe9a8' : isTurn ? '#e6c14b' : '#e8efe9';
    ctx.fillText(label, ccx, y + 41);

    // ---- 分数 ----
    const tv = (view.totals && view.totals[seat]) || 0;
    ctx.font = font(11, true);
    ctx.fillStyle = tv > 0 ? '#43c07c' : tv < 0 ? '#e07a6a' : '#9db5a8';
    ctx.fillText(tv > 0 ? `+${tv}` : `${tv}`, ccx, y + 55);

    // ---- 手牌 N ----
    const n = this.effCounts[seat] || 0;
    ctx.font = font(8);
    ctx.fillStyle = '#c8d8cc';
    ctx.fillText(`手牌${n}`, ccx, y + 69);

    // ---- 状态（112 高的余量行，y+84：结算=准备状态 / 托管 / 出牌中 / 胡牌）----
    if (view.phase === 'over' && Array.isArray(view.ready)) {
      ctx.font = font(10, true);
      if (offline) {
        ctx.fillStyle = '#e0a86a';
        ctx.fillText('掉线', ccx, y + 84);
      } else if (view.ready[seat]) {
        ctx.fillStyle = '#43c07c';
        ctx.fillText('已准备', ccx, y + 84);
      } else {
        ctx.fillStyle = '#9db5a8';
        ctx.fillText('未准备', ccx, y + 84);
      }
    } else if (isWinner) {
      ctx.font = font(10, true);
      ctx.fillStyle = '#ffe9a8';
      ctx.fillText('胡牌！', ccx, y + 84);
    } else if (awayPlay) {
      ctx.fillStyle = '#e0a86a';
      ctx.fillText('已退出', ccx, y + 84);
    } else if (autoPlay || offline) {
      ctx.fillStyle = '#e0a86a';
      ctx.fillText(offline ? '掉线' : '托管', ccx, y + 84);
    } else if (isTurn) {
      ctx.fillStyle = '#e6c14b';
      ctx.fillText('出牌中', ccx, y + 84);
    }
    ctx.textAlign = 'left';
    this.tagRects[slot] = { x, y, w, h };
  }
  // ---------- 互动表情与铭牌气泡 ----------

  pushBubble(seat, content, kind) {
    const text = String(content || '').trim();
    if (!text || seat < 0 || seat > 3) return;
    this.bubbles = this.bubbles.filter((b) => b.seat !== seat);
    this.bubbles.push({ seat, content: text, kind, t0: Date.now() });
    this.scheduleFrame();
  }

  pushEmote(from, target, icon) {
    if (!icon) return;
    this.emoteFx.push({ from, target, icon, t0: Date.now() });
    this.scheduleFrame();
  }

  wrapText(text, maxW, maxLines) {
    const ctx = this.ctx;
    const chars = Array.from(text);
    const lines = [];
    let cur = '';
    let i = 0;
    for (; i < chars.length; i++) {
      const ch = chars[i];
      if (cur && ctx.measureText(cur + ch).width > maxW) {
        lines.push(cur);
        cur = '';
        if (lines.length === maxLines) break;
      }
      cur += ch;
    }
    let truncated = i < chars.length;
    if (lines.length < maxLines) {
      if (cur) lines.push(cur);
    } else if (cur) {
      truncated = true;
    }
    if (truncated && lines.length > 0) {
      let s = lines[lines.length - 1];
      while (s && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
      lines[lines.length - 1] = `${s}…`;
    }
    return lines;
  }

  drawBubbles() {
    const view = this.view;
    const now = Date.now();
    this.bubbles = this.bubbles.filter((b) => now - b.t0 < BUBBLE_MS);
    if (!view || this.bubbles.length === 0) return;
    const ctx = this.ctx;
    for (const b of this.bubbles) {
      const slot = this.disp(view, b.seat);
      const tag = this.tagRects[slot];
      if (!tag) continue;
      const wide = slot === 2 || slot === 3;
      const maxW = wide ? BUBBLE_W_WIDE : BUBBLE_W_NARROW;
      const emote = b.kind === 'emote';
      ctx.font = font(emote ? BUBBLE_FONT_EMOTE : BUBBLE_FONT, emote);
      const lines = this.wrapText(b.content, maxW - BUBBLE_PAD_X * 2, BUBBLE_MAX_LINES);
      if (lines.length === 0) continue;
      let textW = 0;
      for (const l of lines) textW = Math.max(textW, ctx.measureText(l).width);
      const w = Math.min(maxW, Math.ceil(textW) + BUBBLE_PAD_X * 2);
      const h = lines.length * BUBBLE_LINE_H + BUBBLE_PAD_Y * 2;
      const leftSide = slot === 0 || slot === 3;
      const up = slot === 0 || slot === 1;
      let x = leftSide ? tag.x : tag.x + tag.w - w;
      let y = up ? tag.y - 11 - h : tag.y + tag.h + 11;
      x = Math.max(8, Math.min(W - 8 - w, x));
      y = Math.max(8, Math.min(H - 8 - h, y));
      const age = now - b.t0;
      ctx.globalAlpha = Math.max(0, Math.min(1, age / 160, (BUBBLE_MS - age) / BUBBLE_FADE));
      const bg = emote ? 'rgba(48,34,10,0.94)' : 'rgba(16,26,21,0.92)';
      roundRect(ctx, x, y, w, h, BUBBLE_RADIUS);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = emote ? '#e6c14b' : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 2;
      ctx.stroke();
      const tailX = leftSide ? tag.x + 30 : tag.x + tag.w - 30;
      ctx.beginPath();
      ctx.moveTo(tailX - 9, up ? y + h : y);
      ctx.lineTo(tailX + 9, up ? y + h : y);
      ctx.lineTo(tailX, up ? y + h + 11 : y - 11);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = emote ? '#ffe9a8' : '#e8efe9';
      lines.forEach((l, i) => ctx.fillText(l, x + BUBBLE_PAD_X, y + BUBBLE_PAD_Y + BUBBLE_LINE_H * i + BUBBLE_LINE_H / 2));
      ctx.globalAlpha = 1;
    }
  }

  /**
   * 操作动画（吃/碰/杠/暗杠/补杠/胡）：中心区用**贴图字样**（chi/peng/gang/hu 艺术字）
   * 做「缩小的入场 + 渐隐的消失」（2026-10-23 改；此前是圆角块 + 彩色文字）。
   *   · 入场 0~25%：scale 1.55 → 1.0（easeOutCubic）+ 同步淡入 —— 缩小入场；
   *   · 停留 25%~72%：scale 1、alpha 1；
   *   · 消失 72%~100%：alpha 1 → 0（渐隐），同时微缩到 0.88。
   * 暗杠/补杠都画「杠」图，图下补一行小注区分（普通杠不补）。
   * 贴图未就绪（清单失败 / preload 未完成）时**回退原来的圆角块 + 文字**，行为与旧版一致。
   */
  /**
   * 把「新动作」落到中心动画上（纯逻辑，不绘制）。
   * 逐个应用、**后者覆盖前者**（= 立即打断）；打断时继承旧动画当前的 scale/alpha，
   * 避免画面在切换瞬间跳变。抽成方法是为了能单独测「动作 kind → 动画 kind」的对应关系
   * （2026-10-23 用户报「吃却显示了碰」，见 .recover-tmp/test_action_fx.cjs）。
   */
  applyActionFx(fresh) {
    for (const a of fresh || []) {
      if (!a || ACTION_FX_KINDS.indexOf(a.kind) < 0) continue;
      const now = Date.now();
      const prev = this.actionFx;
      const pose = prev
        ? this.fxPose(prev, Math.max(0, Math.min(1, (now - prev.t0) / ACTION_FX_DUR)))
        : null;
      this.actionFx = {
        kind: a.kind,
        seat: a.seat,
        t0: now,
        seq: Number(a.seq) || 0,
        // 胡牌张（来自 view.log 的 tiles[0]）：自摸=刚摸那张、点炮=打出那张。
        // 中心动画要标注「胡的是哪张」，其它三家/记录才能知道（见 drawActionFx）。
        tile: a.tiles && a.tiles.length ? a.tiles[0] : null,
        s0: pose ? pose.scale : 1.55, // 接管起点：无旧动画 = 完整缩放入场
        a0: pose ? pose.alpha : 0,
      };
      // 诊断（2026-10-23 用户报「吃却显示碰」）：每次真正起一段中心动画打一条，
      // 与页面侧 onControl 的 `[ctl]` 日志一对，就能确认「发出去的动作」和「播的动画」是否同一件。
      try {
        console.info(`[fx] ${a.kind} seat=${a.seat} seq=${a.seq}`);
      } catch (e) {
        /* 控制台不可用时忽略 */
      }
    }
  }

  /**
   * 收集「上次处理之后」的新动作（按 seq 升序）。
   * · 服务端 `view.log` 是完整动作日志（seq 递增，最多 500 条）→ 倒序扫到已处理位置即停，
   *   这样**多个动作同帧到达时也能按序处理**（只发 lastAction 会漏掉中间的）；
   * · 首次同步只对齐 seq、不回放历史（否则进房会突然播一个旧动画）；
   * · 没有 log 的老服务端回退用 lastAction；
   * · seq 必须比上次大（重连重放的旧 seq 丢弃，不会重播）。
   */
  collectNewActions(view) {
    const log = view && view.log;
    if (Array.isArray(log) && log.length) {
      if (!this.fxBootstrapped) {
        this.fxBootstrapped = true;
        this.fxSeenSeq = Number(log[log.length - 1].seq) || this.fxSeenSeq;
        return [];
      }
      const out = [];
      for (let i = log.length - 1; i >= 0; i--) {
        const a = log[i];
        const seq = Number(a && a.seq) || 0;
        if (seq <= this.fxSeenSeq) break;
        out.push(a);
      }
      out.reverse(); // 升序：后面的动作后播，也就后打断前一个
      if (out.length) {
        this.fxSeenSeq = Math.max(this.fxSeenSeq, Number(out[out.length - 1].seq) || 0);
      }
      return out;
    } else if (!this.fxBootstrapped) {
      // 新开一局/首次同步时 log 还为空（尚未有任何动作）：先标记已 bootstrap，
      // 这样首个真实动作抵达时不会被当成历史丢弃 —— 避免开局第一个吃/碰/杠/胡不播中心动画。
      this.fxBootstrapped = true;
    }
    const la = view && view.lastAction;
    if (la) {
      const seq = Number(la.seq) || 0;
      if (seq > this.fxSeenSeq) {
        this.fxSeenSeq = seq;
        return [la];
      }
    }
    return [];
  }

  /**
   * 操作动画的视觉曲线（归一化时间 t → scale/alpha）。
   * · 入场 0~25%：从 (s0,a0) 收到 1（easeOutCubic）；
   * · 停留 25%~72%：满值；
   * · 消失 72%~100%：alpha→0 渐隐 + 微缩到 0.88。
   * s0/a0 = 打断接管时**继承**的旧动画当前值（无旧动画时 = 1.55 / 0，即完整缩放入场）。
   */
  fxPose(fx, t) {
    const IN = 0.25;
    const OUT = 0.72;
    const s0 = fx && fx.s0 !== undefined ? fx.s0 : 1.55;
    const a0 = fx && fx.a0 !== undefined ? fx.a0 : 0;
    if (t < IN) {
      const k = t / IN;
      const e = 1 - Math.pow(1 - k, 3); // easeOutCubic
      return { scale: s0 + (1 - s0) * e, alpha: a0 + (1 - a0) * e };
    }
    if (t < OUT) return { scale: 1, alpha: 1 };
    const k = (t - OUT) / (1 - OUT);
    return { scale: 1 - 0.12 * k, alpha: 1 - k };
  }

  /**
   * 中心动画的归属小注（2026-10-23）：优先昵称，没昵称退回相对方位「我 / 下家 / 对家 / 上家」。
   * 不拼成「下家·下家西」那种双重前缀 —— 和「暗杠」拼起来会变成「暗杠 · 下家·下家西」。
   */
  fxSeatLabel(seat) {
    const v = this.view;
    if (!v || seat === undefined || seat === null || seat < 0) return '';
    const rel = ['我', '下家', '对家', '上家'][(((seat - (v.mySeat || 0)) % 4) + 4) % 4];
    const name = (v.names && v.names[seat]) || '';
    return name && name !== rel ? name : rel;
  }

  drawActionFx() {
    const fx = this.actionFx;
    if (!fx) return;
    const now = Date.now();
    const age = now - fx.t0;
    const DUR = ACTION_FX_DUR;
    if (age >= DUR) {
      this.actionFx = null;
      return;
    }
    const ctx = this.ctx;
    const pose = this.fxPose(fx, age / DUR);
    const scale = pose.scale;
    const alpha = pose.alpha;
    const art = uiart.art(OP_FX_ART[fx.kind]) || null;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(640, 300);
    ctx.scale(scale, scale);
    if (art) {
      // 贴图字样：源 113×94（webp 2x = 226×188），按高 132 绘制
      const h = 132;
      const w = h * (art.width / art.height);
      ctx.drawImage(art, -w / 2, -h / 2, w, h);
      /*
       * 图下小注（2026-10-23）：暗杠/补杠与普通「杠」同图要区分；另外**统一补上是谁做的**
       * ——用户报「明明是吃，中心却显示碰」，实际多半是下家的碰紧接着把动画打断了，
       * 但画面只孤零零一个「碰」，没有任何归属信息，看着就像自己那手吃变成了碰。
       * 加一行「下家·碰主昵称」式的归属后，一秒就能确认是不是自己的操作。
       */
      const cap =
        fx.kind === 'angang'
          ? '暗杠'
          : fx.kind === 'bugang'
            ? '补杠'
            : fx.kind === 'hu' && fx.tile !== null
              ? `胡 · ${tileName(fx.tile)}`
              : '';
      const seatLabel = this.fxSeatLabel(fx.seat);
      const note = [cap, seatLabel].filter(Boolean).join(' · ');
      if (note) {
        ctx.font = font(24, true);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(0,0,0,0.65)';
        ctx.strokeText(note, 0, 80);
        ctx.fillStyle = '#f6e3a1';
        ctx.fillText(note, 0, 80);
      }
    } else {
      // 回退：圆角块 + 文字（贴图未就绪时保持旧行为）
      const conf = {
        chi: { label: '吃', color: '#81c784' },
        peng: { label: '碰', color: '#64b5f6' },
        gang: { label: '杠', color: '#ffb74d' },
        angang: { label: '暗杠', color: '#ffb74d' },
        bugang: { label: '补杠', color: '#ffb74d' },
        hu: { label: fx.tile !== null ? `胡·${tileName(fx.tile)}` : '胡', color: '#ef9a9a' },
      };
      const c = conf[fx.kind] || { label: fx.kind, color: '#fff' };
      const w = 120;
      const h = 70;
      roundRect(ctx, -w / 2, -h / 2, w, h, 14);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fill();
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = c.color;
      ctx.font = font(42, true);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.label, 0, 2);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  drawEmoteFx() {
    const view = this.view;
    const now = Date.now();
    this.emoteFx = this.emoteFx.filter((f) => now - f.t0 < EMOTE_MS);
    if (!view || this.emoteFx.length === 0) return;
    const ctx = this.ctx;
    for (const f of this.emoteFx) {
      const a = this.tagRects[this.disp(view, f.from)];
      const b = this.tagRects[this.disp(view, f.target)];
      if (!a || !b) continue;
      const ax = a.x + a.w / 2;
      const ay = a.y + a.h / 2;
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      const k = Math.min(1, (now - f.t0) / EMOTE_MS);
      if (k < EMOTE_FLY) {
        const p = k / EMOTE_FLY;
        const e = p * p * (3 - 2 * p);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(ax + (bx - ax) * e, ay + (by - ay) * e - Math.sin(Math.PI * p) * 44);
        ctx.rotate(p * Math.PI * 1.6);
        ctx.font = `34px ${EMOJI_FONT}`;
        ctx.fillText(f.icon, 0, 0);
        ctx.restore();
      } else {
        const p = (k - EMOTE_FLY) / (1 - EMOTE_FLY);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(bx, by);
        const sc = 1.6 - 0.45 * Math.min(1, p / 0.4);
        ctx.scale(sc, sc);
        ctx.font = `34px ${EMOJI_FONT}`;
        ctx.globalAlpha = Math.max(0, 1 - Math.max(0, (p - 0.5) / 0.5));
        ctx.fillText(f.icon, 0, 0);
        ctx.globalAlpha = Math.max(0, 0.5 * (1 - p));
        ctx.strokeStyle = '#e6c14b';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, 8 + p * 40, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        const flash = Math.max(0, 1 - p / 0.55);
        if (flash > 0) {
          ctx.globalAlpha = flash * 0.9;
          ctx.strokeStyle = '#f6e3a1';
          ctx.lineWidth = 3;
          roundRect(ctx, b.x - 3, b.y - 3, b.w + 6, b.h + 6, 10);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  /**
   * 赢家高亮框 = 该家明牌的整体外框。`drawRevealHand()` 每帧都会把
   * 「这家明牌占了哪块矩形」写进 `revealRects[slot]`，这里直接取，不再另算一套坐标
   * （曾经两处各算一次，牌张尺寸一改就错位）。
   */
  winnerRect(view) {
    const seat = view.winner;
    if (seat === null || view.phase !== 'over') return null;
    return this.revealRects[this.disp(view, seat)] || null;
  }

  drawWinnerHighlight(view) {
    const quad = this.winnerRect(view);
    if (!quad) return;
    const ctx = this.ctx;
    // 2026-10-20：revealRects 改存投影四边形（drawRevealHand 写入）→ 高亮框
    // 与摊牌同形；旧版按逻辑矩形画、3D/透视后会从牌上飘走。（原 3D 时代的
    // 「上下内缩 4px」不再需要 —— 四边形本身就是牌的投影外沿。）
    ctx.save();
    ctx.shadowColor = 'rgba(230,193,75,0.95)';
    ctx.shadowBlur = 16;
    ctx.strokeStyle = '#f6e3a1';
    ctx.lineWidth = 3.5;
    quadPath(ctx, quad, 10);
    ctx.stroke();
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 结算横幅：**压在中央徽章上、垂直居中**（y 278~318，HUD 性质）。
   * 历史：原画画布最顶端（y4~48）→ 压对家摊牌，挪到环内上沿 y214~254。
   * 2026-10-28（用户报「顶部结算信息遮挡」）：B 档A 后对家河块底到 ~231，
   * y214 的横幅压住河块末行 17px，且底边 254 贴死徽章顶 / 压进方向指示键（250~254）。
   * 徽章在结算相位只剩「牌墙剩余」这类无用信息（精牌已由摊牌/高亮展示、DOM 顶栏
   * g-top 也有精牌文字）→ 横幅作为最顶层 HUD **与徽章同宽同轴**（540..740 × 278..318），
   * 宽度收到 200 后与左右河块（300..492 / 788..980，2026-10-30 现行值）、上下河块全不沾，零新遮挡。
   */
  drawResultBanner(view) {
    const seat = view.winner;
    if (seat === null || view.phase !== 'over') return;
    const name = (view.names && view.names[seat]) || this.wind(seat);
    let main = `${this.wind(seat)}·${name} 胡`;
    const sub = view.result || '';
    const ctx = this.ctx;
    // 与中央徽章同宽同轴（200），塞进徽章竖向中带（盘底 − 40）
    const bw = CENTER_BADGE.w;
    const bh = 40;
    const bx = CENTER_BADGE.x;
    const by = CENTER_BADGE.y + CENTER_BADGE.h - bh;
    ctx.font = font(14, true);
    while (main.length > 2 && ctx.measureText(main).width > bw - 20) {
      main = `${main.slice(0, -2)}…`;
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    roundRect(ctx, bx, by, bw, bh, 12);
    ctx.fillStyle = 'rgba(230,193,75,0.96)';
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#f6e3a1';
    ctx.lineWidth = 2;
    roundRect(ctx, bx, by, bw, bh, 12);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#22200f';
    ctx.font = font(16, true);
    ctx.fillText(main, W / 2, by + 14);
    if (sub) {
      ctx.fillStyle = 'rgba(34,32,15,0.78)';
      ctx.font = font(11);
      let s = sub;
      while (s.length > 2 && ctx.measureText(s).width > bw - 20) s = `${s.slice(0, -2)}…`;
      ctx.fillText(s, W / 2, by + 30);
    }
  }

  scheduleFrame() {
    if (this.rafQueued) return;
    this.rafQueued = true;
    const raf = this.canvas && typeof this.canvas.requestAnimationFrame === 'function'
      ? this.canvas.requestAnimationFrame.bind(this.canvas)
      : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 32));
    raf(() => {
      this.rafQueued = false;
      if (this.lastRendered) this.render(this.lastRendered);
    });
  }

  jingBorder(x, y, w, h, r, isPi, tilt) {
    const ctx = this.ctx;
    // 叠压牌河（RIVER_LAP_*）：牌被后出的邻居盖掉一截，精框若照整张牌画，
    // 被盖那条边就落进下一张牌身里（盖底时看着像「两条竖杠、没有下边」）。
    // 调用方用 `visH` 告诉这里「实际露出的高度」、`visAlign` 告诉「露出的是哪一段」：
    //   'top'（自己/上家，后出者盖底）→ 框贴牌顶，补偿 (1−k)/2（原逻辑）；
    //   'bottom'（对家/下家，后出者盖顶）→ 框贴牌底，补偿 (1+k)/2 —— 两者都由
    //   「框屏幕中心 = 露出段屏幕中心」解出（projQuad 绕传入矩形自身中心缩、y 不动）。
    if (tilt && tilt.visH) {
      const k = tilt.k || 1;
      if (tilt.visAlign === 'bottom') {
        y += ((h - tilt.visH) * (1 + k)) / 2;
      } else {
        y += ((h - tilt.visH) * (1 - k)) / 2;
      }
      h = tilt.visH;
    }
    ctx.save();
    ctx.shadowColor = isPi ? 'rgba(255,87,34,0.9)' : 'rgba(171,71,188,0.9)';
    ctx.shadowBlur = 8;
    ctx.strokeStyle = isPi ? '#ff5722' : '#ab47bc';
    ctx.lineWidth = 3;
    // 2026-10-20：分区经 resolveZone 解析（投影 + Lean 两轴），四边形与牌身同参
    const z = resolveZone(tilt);
    if (z) {
      quadPath(ctx, projQuad(x, y, w, h, z), Math.max(2, r * 0.8));
    } else {
      roundRect(ctx, x, y, w, h, r);
    }
    ctx.stroke();
    ctx.stroke();
    ctx.restore();
  }

  /** 3D：桌面投影贴片（离屏预渲染一次；不含逐帧 shadowBlur）。平铺在桌面上、**不随牌旋转** */
  shadowSprite(w, h) {
    const key = `${w}x${h}`;
    if (this._shadowCache[key] !== undefined) return this._shadowCache[key];
    let sp = null;
    const cv = Table.newCanvas(w + 40, h + 40);
    let c2 = null;
    if (cv) {
      try {
        c2 = cv.getContext('2d');
      } catch (e) {
        c2 = null;
      }
    }
    if (c2) {
      const r = Math.max(2, Math.floor(w * 0.14));
      /*
       * 2026-10-21：核心 alpha 0.5 → 0.34、模糊 10 → 13。
       *
       * 贴片是「牌位大小的实心圆角块 + 外扩模糊」，贴到牌下方时那张实心块只有
       * ~2px 露在牌外 —— 单张看不出问题，但**副露/牌河是零间隙紧排**，相邻牌的
       * 实心块会拼成一条连续深色底板（真机放大看像「牌摆在一个黑托盘上」）。
       * 压淡核心、加重模糊后，阴影回到「贴合牌的软边」，紧排处不再连成板。
       */
      c2.shadowColor = 'rgba(0,0,0,0.5)';
      c2.shadowBlur = 13;
      c2.shadowOffsetX = 5;
      c2.shadowOffsetY = 6;
      c2.fillStyle = 'rgba(0,0,0,0.34)';
      roundRect(c2, 20, 20, w, h, r);
      c2.fill();
      sp = cv;
    }
    this._shadowCache[key] = sp;
    return sp;
  }

  /** 3D：牌底厚度边（沿投影底边向右下挤出 3px，读作「牌有厚度」） */
  drawTileThickness(x, y, w, h, tilt) {
    const q = projQuad(x, y, w, h, tilt);
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = '#d8d0ba';
    ctx.beginPath();
    ctx.moveTo(q[3].x, q[3].y);
    ctx.lineTo(q[2].x, q[2].y);
    ctx.lineTo(q[2].x + 3, q[2].y + 3);
    ctx.lineTo(q[3].x + 3, q[3].y + 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /**
   * 立体/投影：把平面牌源切「横条」拼成四边形（2026-10-20 起四边形由
   * projQuad 给出 —— Lean 梯形再过一点透视；第 k 条的左右边 = 顶边↔底边
   * 线性插值，条间 +1px 重叠防接缝）。源图按条带取子矩形。
   */
  drawTileSlices(src, x, y, w, h, tilt, k) {
    const ctx = this.ctx;
    const q = projQuad(x, y, w, h, tilt);
    // src 支持两种：裸图（牌面/牌背位图、离屏矢量图）与**图集子矩形**
    // `{img,sx,sy,sw,sh}`（2026-10-21 按座位平放牌图集；不预裁 136 张小图省解码内存）
    const isDesc = !!(src && src.img);
    const img = isDesc ? src.img : src;
    const ox = isDesc ? src.sx : 0;
    const oy = isDesc ? src.sy : 0;
    const iw = isDesc ? src.sw : img.width;
    const ih = isDesc ? src.sh : img.height;
    if (!iw || !ih) return;
    /*
     * 2026-10-21 快路：四边形是**真矩形**（rect 模式 + 无 Lean 收窄，当前所有牌河/
     * 副露分区都是）→ 一次 drawImage 铺满即可。原来固定切 8 条，每条都要一次
     * drawImage 重采样，牌侧沿还会因「切片中点取左右边」错开半格出台阶。
     * 判定用容差 0.5px：跨 1 个逻辑像素以内的斜边不值得为它牺牲清晰度。
     */
    if (Math.abs(q[0].x - q[3].x) < 0.5 && Math.abs(q[1].x - q[2].x) < 0.5) {
      const dw = q[1].x - q[0].x;
      const dh = q[3].y - q[0].y;
      if (dw > 0 && dh > 0) {
        ctx.drawImage(img, ox, oy, iw, ih, q[0].x, q[0].y, dw, dh);
        return;
      }
    }
    const topY = q[0].y;
    const vh = q[3].y - q[0].y;
    const sh = vh / k;
    for (let i = 0; i < k; i++) {
      const f = (i + 0.5) / k;
      const xl = q[0].x + (q[3].x - q[0].x) * f;
      const xr = q[1].x + (q[2].x - q[1].x) * f;
      const sy0 = (i * ih) / k;
      const sy1 = Math.min(ih, ((i + 1) * ih) / k + 0.5);
      ctx.drawImage(img, ox, oy + sy0, iw, sy1 - sy0, xl, topY + i * sh, xr - xl, sh + 1);
    }
  }

  /**
   * 把「裸图 / 图集子矩形」等比裁切铺满目标矩形（2026-10-21）。
   * src 支持 `{img,sx,sy,sw,sh}`（座位平放牌图集）或裸图（牌面/牌背位图）。
   * 调用方负责 clip；返回是否真的画了。
   */
  drawArtInto(ctx, src, x, y, w, h) {
    const isDesc = !!(src && src.img);
    const img = isDesc ? src.img : src;
    const ix = isDesc ? src.sx : 0;
    const iy = isDesc ? src.sy : 0;
    const iw = isDesc ? src.sw : img.width;
    const ih = isDesc ? src.sh : img.height;
    if (!iw || !ih) return false;
    let sx = ix;
    let sy = iy;
    let cw = iw;
    let ch = ih;
    if (iw / ih < w / h) {
      ch = Math.max(1, Math.round((iw * h) / w));
      sy = iy + Math.round((ih - ch) / 2);
    } else {
      cw = Math.max(1, Math.round((ih * w) / h));
      sx = ix + Math.round((iw - cw) / 2);
    }
    ctx.drawImage(img, sx, sy, cw, ch, x, y, w, h);
    return true;
  }

  /** 3D：顶光烘焙（clip 投影四边形后铺两段半透明色带，不建渐变对象） */
  paintTileLight(x, y, w, h, tilt) {
    const q = projQuad(x, y, w, h, tilt);
    const ctx = this.ctx;
    const topY = q[0].y;
    const vh = q[3].y - q[0].y;
    const xl = Math.min(q[0].x, q[3].x);
    const xr = Math.max(q[1].x, q[2].x);
    ctx.save();
    quadPath(ctx, q, 3);
    ctx.clip();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(xl - 2, topY, xr - xl + 4, vh * 0.28);
    ctx.fillStyle = 'rgba(0,0,0,0.07)';
    ctx.fillRect(xl - 2, topY + vh * 0.68, xr - xl + 4, vh * 0.32);
    ctx.restore();
  }

  /** 3D：矢量牌面/牌背的离屏缓存（按 t|w|h；位图走 tileimg.art 不需要缓存） */
  tileFace(t, w, h) {
    const key = `${t}|${w}|${h}`;
    if (this._vecCache[key] !== undefined) return this._vecCache[key];
    let cv = null;
    const nc = Table.newCanvas(w, h);
    // 上下文拿不到（离屏不可用）→ 不缓存半成品，返回 null 让 drawTile 走降级
    let c2 = null;
    if (nc) {
      try {
        c2 = nc.getContext('2d');
      } catch (e) {
        c2 = null;
      }
    }
    if (c2) {
      if (t < 0) this.paintTileBack(c2, 0, 0, w, h);
      else this.paintTileFace(c2, t, 0, 0, w, h);
      cv = nc;
    }
    if (Object.keys(this._vecCache).length > 80) this._vecCache = {}; // 兜底防涨
    this._vecCache[key] = cv;
    return cv;
  }

  /** 矢量牌面（不含描边；描边由调用方按 tilt 画梯形）。与原 flat 分支同一套画法 */
  paintTileFace(ctx, t, x, y, w, h) {
    const r = Math.max(2, Math.floor(w * 0.14));
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = '#f8f5ec';
    ctx.fill();
    const bevel = Math.max(2, Math.round(h * 0.1));
    ctx.fillStyle = '#e3dcc8';
    ctx.fillRect(x + 1, y + h - bevel, w - 2, bevel - 1);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = x + w / 2;
    if (t < 27) {
      const suit = suitOf(t);
      const numColor = suit === 'm' ? '#1a1a2e' : SUIT_COLOR[suit];
      const suitColor = suit === 'm' ? '#c62828' : SUIT_COLOR[suit];
      ctx.fillStyle = numColor;
      ctx.font = font(Math.max(7, Math.round(h * 0.42)), true);
      ctx.fillText(String(rankOf(t)), cx, y + h * 0.34);
      ctx.fillStyle = suitColor;
      ctx.font = font(Math.max(6, Math.round(h * 0.3)), true);
      ctx.fillText(SUIT_CHAR[suit], cx, y + h * 0.7);
      return;
    }
    if (t === 33) {
      const bw = w * 0.54;
      const bh = h * 0.56;
      ctx.strokeStyle = '#1f5fbf';
      ctx.lineWidth = Math.max(1.5, w * 0.06);
      ctx.strokeRect(cx - bw / 2, y + h / 2 - bh / 2, bw, bh);
      ctx.strokeStyle = 'rgba(31,95,191,0.38)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - bw / 2 + 3, y + h / 2 - bh / 2 + 3, bw - 6, bh - 6);
      return;
    }
    ctx.fillStyle = t === 31 ? '#c62828' : t === 32 ? '#1b7f3b' : '#1a1a2e';
    ctx.font = font(Math.max(8, Math.round(h * 0.52)), true);
    ctx.fillText(tileName(t), cx, y + h / 2 + 1);
  }

  /** 牌背（原 drawTile 的 t<0 分支原样抽出，供离屏缓存用）。
   *  2026-10-20 蓝 → 绿（用户参考图为经典绿背麻将；与藏青桌面/深绿墙裙同色系）。 */
  paintTileBack(ctx, x, y, w, h) {
    const r = Math.max(2, Math.floor(w * 0.14));
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = '#177a4a';
    ctx.fill();
    ctx.strokeStyle = '#0c4630';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    roundRect(ctx, x + 2, y + 2, w - 4, h - 4, Math.max(2, r - 1));
    ctx.strokeStyle = 'rgba(255,255,255,0.38)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    roundRect(ctx, x + 2, y + 2, Math.max(2, w - 4), Math.max(2, (h - 4) * 0.35), Math.max(2, r - 2));
    ctx.fill();
  }

  /**
   * 画一张牌：**优先用 CDN 位图**，取不到则纯矢量兜底。
   *
   * 为什么位图不在代码包里：官方代码包体检两条硬指标 —— 主包 < 1.5MB、**图片资源合计 ≤ 200KB**，
   * 34 张牌面无论怎么压都过不了（139×202 WebP 也要 251KB，早期 93×135 PNG 更是 731KB）。
   * 现在走 `utils/tileimg.js`：后端 `/api/tiles` 给清单、CDN 给图；**清单没取到 / 单张解码失败，
   * 就落到下面的矢量分支**，表现只是「牌面抽象一点」，不会白板也不会卡住。
   * 矢量分支的另一个好处：牌河单张只有 9~13 CSS px，矢量文字比缩小的写实贴图更好认。
   *
   * 2026-10-18 3D：第 7 参 `tilt` 非空时走立体管线（详见 TILE_TILT 注释）——
   * 布局坐标不变、只改屏幕外观梯形；`hitTest` 不含牌张，故无需逆变换补偿。
   * 2026-10-20 透视：管线升级为「任意四边形贴图」—— Lean 梯形再过一点透视
   * （projQuad），K 切片按投影四边形的左右边插值；投影常开（PROJ.on），
   * Lean 仍由 TILE_TILT 分区控制，两轴经 resolveZone 独立解析。
   */
  /**
   * 画一张牌。第 9 参 `rot` = 牌主张开的角度（0 自己 / -90 下家 / 180 对家 / +90 上家），
   * **只改贴图内容朝向、不改几何**（见 `rotFace`）：占位与全部布局格保持原样。
   */
  drawTile(t, x, y, w, h, view, noGlow, tilt, rot, slot) {
    return this.paintTile(t, x, y, w, h, view, noGlow, tilt, rot, slot);
  }

  /**
   * 预渲染「转过朝向的牌面」：把牌面画进一张 **w×h 的离屏图**，但内容先转 `rot` 再铺。
   *
   * 为什么不在绘制时 `ctx.rotate`：投影只缩 x 不缩 y（见 PROJ 注释），在**屏幕空间**里转
   * 90° 会把「未缩的纵向尺寸」搬到横向去 —— 牌比布局格宽出 25%，整列牌互相压
   * （2026-10-20 几何校验实检出牌河自检 64~72 对相交）。把旋转做进**贴图**里，
   * 几何一行不改：占位仍是 46×58，48/60 的布局格与所有已校验的间距全部保持。
   * 只对「朝侧边」的牌（90°/270°）生成；180° 的牌面本来就是倒的，走普通缓存。
   */
  rotFace(t, w, h, rot, slot) {
    const key = `${t}|${w}|${h}|${rot}|${slot === undefined ? '' : slot}`;
    if (this._rotCache[key] !== undefined) return this._rotCache[key];
    let cv = null;
    const nc = Table.newCanvas(w, h);
    let c2 = null;
    if (nc) {
      try {
        c2 = nc.getContext('2d');
      } catch (e) {
        c2 = null;
      }
    }
    if (c2) {
      /*
       * 2026-10-21 修：**只有 ±90° 才换宽高**。
       *
       * 原实现不分角度一律用 h×w 当内框（注释写「转完坐标系里可用的矩形是 h×w」），
       * 那对 ±90° 成立，但对 0°/180° 是错的 —— 180° 时内框仍是 w×h。实测症状：
       * 对家（slot 2，rot=π）的牌河贴图被塞进一个 62×50 的横向框再转 180°，
       * 结果左右各裁掉约 10%、上下各留 6px 空带，牌面像「被切了一半」。
       * 现在按 |sin(rot)| 判定是否换轴，任何角度都精确填满 w×h。
       */
      const swap = Math.abs(Math.sin(rot)) > 0.5;
      const bw = swap ? h : w;
      const bh = swap ? w : h;
      c2.save();
      c2.translate(w / 2, h / 2);
      c2.rotate(rot);
      // 内框（未旋转坐标系里的贴图矩形）居中：左上角 = (-bw/2, -bh/2)
      c2.translate(-bw / 2, -bh / 2);
      // 按座位平放牌（faceA..faceD）优先；取不到回退竖版立牌 / 牌背
      const f = slot === undefined || t < 0 ? null : tileimg.faceArt(SEAT_FACE[slot], t);
      const art = f || (t >= 0 ? tileimg.art(t) : uiart.art('back'));
      if (art) {
        const isDesc = !!art.img;
        const img = isDesc ? art.img : art;
        const ax = isDesc ? art.sx : 0;
        const ay = isDesc ? art.sy : 0;
        const sw = isDesc ? art.sw : art.width;
        const sh = isDesc ? art.sh : art.height;
        let sx = ax;
        let sy = ay;
        let cw = sw;
        let ch = sh;
        if (sw / sh < bw / bh) {
          ch = Math.max(1, Math.round((sw * bh) / bw));
          sy = ay + Math.round((sh - ch) / 2);
        } else {
          cw = Math.max(1, Math.round((sh * bw) / bh));
          sx = ax + Math.round((sw - cw) / 2);
        }
        /*
         * 2026-10-31 晚（用户提议「裁掉多余的底部信息」）：cover 裁完再**砍掉源底
         * 12.5%**（条位，见 FLAT_FACE_CUT 的六轮时间线），目标同比砍底、顶对齐画。
         * 与 10-30 首次裁条的区别：现在行距是中压 43（盖 7.75）、列距 50、组间 −2
         * —— 裁切空区全部被下一张压住，交界只剩干净的白边压牌面，不再露台阶切口。
         */
        const keep = 1 - FLAT_FACE_CUT;
        const chDraw = Math.max(1, Math.round(ch * keep));
        const bhDraw = Math.max(1, Math.round(bh * keep));
        if (t < 0 && (slot === 0 || slot === 2)) {
          /*
           * 暗杠中间两张盖牌（自己/对家，竖版）**转 180°** 绘制（2026-10-31 用户：
           * 「盖着的牌显示反了，应该旋转180，上面的底部应该显示在下面」）——
           * 背贴图的"底边"（厚度面）当前朝上；在内框坐标系里绕中心再转半圈到底。
           * 左右家（slot 1/3）是横躺牌塞背，不涉及此朝向问题，保持原样。
           */
          c2.save();
          c2.translate(bw / 2, bhDraw / 2);
          c2.rotate(Math.PI);
          c2.drawImage(img, sx, sy, cw, chDraw, -bw / 2, -bhDraw / 2, bw, bhDraw);
          c2.restore();
        } else {
          c2.drawImage(img, sx, sy, cw, chDraw, 0, 0, bw, bhDraw);
        }
      } else if (t < 0) {
        this.paintTileBack(c2, 0, 0, bw, bh);
      } else {
        this.paintTileFace(c2, t, 0, 0, bw, bh);
      }
      c2.restore();
      cv = nc;
    }
    // 2026-10-30：平放牌（传 slot）**全部**走离屏预渲染（含 slot0 rot=0 —— 裁立体条
    // 必须经 rotFace 统一处理），缓存组合变多 → 上限 40 → 96（每张 ~44×58 ≈10KB，≈1MB）。
    if (Object.keys(this._rotCache).length > 96) this._rotCache = {};
    this._rotCache[key] = cv;
    return cv;
  }

  paintTile(t, x, y, w, h, view, noGlow, tilt, rot, slot) {
    const ctx = this.ctx;
    const r = Math.max(2, Math.floor(w * 0.14));
    const isPi = view.jingPi === t || ((view.gz && view.gz.zheng.indexOf(t) >= 0) || false);
    const isFu = view.jingFu === t || ((view.gz && view.gz.fu.indexOf(t) >= 0) || false);
    const tl = resolveZone(tilt);
    /**
     * 2026-10-21：传了 slot 的牌（牌河/副露/摊牌）优先用**该座位的平放牌图集**
     * （faceA..faceD，源项目 liumengniu/majiang 的分座位美术）。
     * 不传 slot 的是「立牌」场景（中心盘的立精、《handStacks》牌背），继续用 tileimg。
     */
    const faceArt = slot === undefined || t < 0 ? null : tileimg.faceArt(SEAT_FACE[slot], t);

    if (tl) {
      // 立体/投影管线：先取平面牌源（位图直用 / 矢量与牌背走离屏缓存），再按分区
      // （Lean + 投影 + zw 补偿）切横条拼形。每张牌 = 投影 1 次 + 厚度 1 次 +
      // 切片 k 次 + 顶光 1 段，零逐帧 shadowBlur。
      // 2026-10-20：`rot` 只影响**贴图内容**（预渲染成转过朝向的离屏图），几何不变。
      // 2026-10-22：暗杠扣牌可以指定另一张牌背（`tl.backKey`），见 drawMeldRow。
      const backImg = uiart.art((tl && tl.backKey) || 'back') || uiart.art('back');
      const art = faceArt || (t >= 0 ? tileimg.art(t) : backImg);
      /*
       * 2026-10-30：**传 slot 的平放牌一律走离屏预渲染**（原 `rot ?` 会把 rot=0 的
       * 自己/副露/摊牌留在直绘路径 —— 立体条裁切统一在 rotFace 里做，直绘不经手就
       * 裁不到）。HUD 立牌（不传 slot）保持原路径，无条不裁。
       */
      const flat = slot !== undefined && slot !== null;
      const src = flat ? this.rotFace(t, w, h, rot || 0, slot) : art || this.tileFace(t, w, h);
      if (src) {
        if (tl.fx !== 'flat') {
          /*
           * 2026-10-22：牌行的阴影可以关（分区 `shadow: 0`）。
           * 每张牌都投一遍 20px 模糊阴影，相邻牌的阴影互相压进那道 2px 的缝里，
           * 视觉上就变成「牌和牌之间隔了一条深色带」—— 用户报的「间隔大」主要就是它。
           * 贴图自带边缘明暗，去掉这层投影后整排牌是连着的。桌面（drawTable）不受影响。
           */
          if (tl.shadow) {
            const sp = this.shadowSprite(w, h);
            if (sp) {
              // 投影贴片按投影四边形的包围盒铺（上下各 20px 余量给模糊外扩）
              const q = projQuad(x, y, w, h, tl);
              const sx0 = Math.min(q[0].x, q[3].x) - 20;
              const sx1 = Math.max(q[1].x, q[2].x) + 20;
              ctx.drawImage(sp, sx0, q[0].y - 20, sx1 - sx0, q[3].y - q[0].y + 40);
            }
          }
          if (tl.edge) this.drawTileThickness(x, y, w, h, tl);
        }
        // 2026-10-20：牌墙已升 Lean 走全套 8 切片（离屏缓存吸收成本）；
        // fx:'flat' 分支保留给未来的「只要投影不要立体」分区（2 条就够）。
        const k = tl.fx === 'flat' ? 2 : this.overPhase ? TILE_TILT.lowSlices : TILE_TILT.slices;
        this.drawTileSlices(src, x, y, w, h, tl, k);
        if (tl.fx !== 'flat') this.paintTileLight(x, y, w, h, tl);
        if (t >= 0) {
          if (isPi || isFu) {
            // 描边收口到**内容框**（裁掉立体条后牌内容的实际范围，见 flatBox）——
            // 否则精框会画进条侧的留空区（框线悬在"空气"里）。HUD（rot 未传）恒等。
            if (!noGlow) {
              const ins = flatBox(rot, x, y, w, h);
              this.jingBorder(ins.x, ins.y, ins.w, ins.h, r, isPi, tl);
            }
          } else if (!art) {
            // 矢量牌补一圈浅描边（与平面矢量分支一致；位图自带边）
            ctx.save();
            ctx.strokeStyle = '#c9c2b0';
            ctx.lineWidth = 1;
            quadPath(ctx, projQuad(x, y, w, h, tl), Math.max(2, r * 0.8));
            ctx.stroke();
            ctx.restore();
          }
        }
        return;
      }
      // 离屏画布不可用（PC 微信 / 极老基础库 → `Table._canvasOff`）→ **投影包围盒近似**：
      // 不能退回下面那条「未投影平面」路径（牌会跑出已经收敛的桌面边缘，整桌错位），
      // 改为按投影四边形的包围盒画一张**矩形牌** —— 丢的是梯形/厚度/顶光，
      // 保住的是位置与大小（布局收敛不散），玩家看到的仍是完整一桌牌。
      // 2026-10-21：这里**不走离屏**，所以位图（牌面/牌背/座位平放牌）照常可用 ——
      // 能 clip + drawImage 就画位图，只有拿不到位图时才落回矢量。
      const q = projQuad(x, y, w, h, tl);
      const bx = Math.min(q[0].x, q[3].x);
      const by = q[0].y;
      const bw = Math.max(2, Math.max(q[1].x, q[2].x) - bx);
      const bh = Math.max(2, q[3].y - by);
      const br = Math.max(2, Math.floor(bw * 0.14));
      const flatArt = t < 0 ? uiart.art((tl && tl.backKey) || 'back') || uiart.art('back') : faceArt || tileimg.art(t);
      if (flatArt) {
        ctx.save();
        roundRect(ctx, bx, by, bw, bh, br);
        ctx.clip();
        this.drawArtInto(ctx, flatArt, bx, by, bw, bh);
        ctx.restore();
        if (t >= 0 && (isPi || isFu) && !noGlow) this.jingBorder(bx, by, bw, bh, br, isPi);
      } else if (t < 0) {
        this.paintTileBack(ctx, bx, by, bw, bh);
      } else {
        this.paintTileFace(ctx, t, bx, by, bw, bh);
        if (isPi || isFu) {
          if (!noGlow) this.jingBorder(bx, by, bw, bh, br, isPi);
        } else {
          ctx.save();
          ctx.strokeStyle = '#c9c2b0';
          ctx.lineWidth = 1;
          roundRect(ctx, bx, by, bw, bh, br);
          ctx.stroke();
          ctx.restore();
        }
      }
      return;
    }

    if (t < 0) {
      // 牌背：有 CDN 贴图就用贴图（源项目那张金顶白边的牌背），没有才矢量兜底。
      // 2026-10-22：这里原来无条件走矢量（绿方块），三家手牌摊成整排之后
      // 一眼就能看出跟参考图的金色牌背不是一回事。
      const back = uiart.art((tilt && tilt.backKey) || 'back') || uiart.art('back');
      if (back) {
        ctx.save();
        roundRect(ctx, x, y, w, h, r);
        ctx.clip();
        this.drawArtInto(ctx, back, x, y, w, h);
        ctx.restore();
        return;
      }
      this.paintTileBack(ctx, x, y, w, h);
      return;
    }

    // CDN 位图优先（`tileimg` 已按清单预解码）；没有就用下面的矢量牌面
    const art = faceArt || tileimg.art(t);
    if (art) {
      ctx.save();
      roundRect(ctx, x, y, w, h, r);
      ctx.clip();
      this.drawArtInto(ctx, art, x, y, w, h);
      ctx.restore();
      if ((isPi || isFu) && !noGlow) this.jingBorder(x, y, w, h, r, isPi);
      return;
    }

    // 牌面：米白底 + 底部立体边（与 3D 离屏缓存共用 paintTileFace，避免两套画法漂移）
    this.paintTileFace(ctx, t, x, y, w, h);
    if (isPi || isFu) {
      this.jingBorder(x, y, w, h, r, isPi);
    } else {
      ctx.save();
      roundRect(ctx, x, y, w, h, r);
      ctx.strokeStyle = '#c9c2b0';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.restore();
    }
  }
}

/** 离屏画布能力开关：首次探测失败后置 true，整局走 `drawTile` 的包围盒降级 */
Table._canvasOff = false;

module.exports = { Table, W, H };
