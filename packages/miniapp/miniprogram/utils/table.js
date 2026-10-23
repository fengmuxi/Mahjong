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
 */

const { tileName, seatWind, suitOf, rankOf } = require('../lib/shared/tiles.js');
const { RING_SLOTS, SEG_LEN, SEG_START } = require('../lib/shared/wall.js');
/** 牌面走 CDN（代码包零图片，见 utils/tileimg.js）；未就绪/失败一律回退矢量 */
const tileimg = require('./tileimg.js');
/** UI 贴图（牌背/庄标/大数字）：CDN 清单，取不到各绘制点回退矢量/文字 */
const uiart = require('./uiart.js');
/** 操作动画用哪张贴图（2026-10-23：中心区改用贴图字样） */
const OP_FX_ART = { chi: 'chi', peng: 'peng', gang: 'gang', angang: 'gang', bugang: 'gang', hu: 'hu' };
/** 触发中心操作动画的动作类型（2026-10-23 动画仲裁用） */
const ACTION_FX_KINDS = ['chi', 'peng', 'gang', 'angang', 'bugang', 'hu'];
/** 操作动画总时长（ms） */
const ACTION_FX_DUR = 1200;

const W = 1280;
const H = 640;
/**
 * 牌张尺寸（2026-10-18 布局重排）。
 *
 * 改动前：对手手牌带占了四条边（每条 22~32 逻辑宽），牌河被挤在环内只剩 24×32 ——
 * 画布逻辑 1280 宽在真机上约 500 CSS px，牌河单张落到屏上只有 9×12，字和花色根本认不出。
 * 现在：
 *   · **删掉对手手牌带**（手牌张数改在铭牌上显示），四条边全部让给牌河；
 *   · 牌河 24×32 → **46×58**，屏上约 18×23（原来的 1.9 倍）；
 *   · 副露 32×42 → **40×52**，并从环外挪进环内四侧（环外给了牌河）。
 * 牌河每侧容量：上下 13×2=26，左右 5×8=40 —— 足够一局的最大弃牌数。
 */
const RIVER_W = 34;
const RIVER_H = 44;
const RIVER_DX = 54;
const RIVER_DY = 66;
/**
 * 牌河**叠压**（2026-10-22 第六轮，用户「各家的牌显示都存在像阶梯一样的效果，
 * 想让下一张牌盖住上一张牌的一部分、连成一个平面」）。
 *
 * 原来行距 ≥ 牌高（上/下 46 vs 44、左/右 36 vs 34），一行一行之间留着 2px 的缝，
 * 屏幕上是一块块分开的小牌（"阶梯"）。现在把行距压到牌高的 6 成左右：
 *   · 上/下：h=44，行距 **27** → 每张露出 61%、重叠 39%；
 *   · 左/右：h=34，行距 **21** → 每张露出 62%、重叠 38%。
 *
 * **谁压在谁上面：四家统一「屏幕上更靠下的那张在上层」**（2026-10-22 第二轮定稿，
 * 用户先按「每人的下一张盖上一张」描述，之后纠正「对家的应该是上一排遮住下一排」）。
 * 2026-10-23 牌河改按牌主视角铺（见 `riverCell()`）：自己/上家的序号递增 = 屏幕往下，
 * 顺画即可；下家/对家的序号递增 = 屏幕往上，必须倒着画，屏幕靠下那张才压在上面。
 * 见 `drawRivers` 里的 `order.reverse()`。
 *
 * **一块牌河用同一个投影比 k**（`riverK`）：逐张按 `d(y)` 缩的话，同一列上下两张
 * 宽度差 1~3px，整条带边缘呈锯齿（用户报「四家的牌对得不整齐」）。改成块内常数后
 * 行列严格对齐、每张同宽同高，纵深感由**整块大小**承担（远的一块整体小一圈）。
 *
 * ⚠️ 行距也必须乘同一个 `k`（`riverPos` 里 `row*dy*k`），否则屏幕上的露出比例
 * = dy/(h·k)，对家 78%、自己 61%，四条边的叠压肉眼不等。
 *
 * 副露**不叠**（组合必须张张可辨），仍保持 2px 紧排，见 `meldMetrics`。
 */
const RIVER_LAP_FAR = 27;
const RIVER_LAP_SIDE = 21;
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
 * 侧边副露的**组内叠压比**（2026-10-22 第九轮，用户「上下家的副牌也要像手牌一样叠放」）。
 * 牌高 34 → 步距 21，每张露出 62%、下一张盖住上一张的下缘；与牌河（`RIVER_LAP_*`）
 * 同一个比值，四条边的「叠压密度」看起来才是一套。
 * 为什么不再小：副露是**亮牌**，玩家要认得出是什么；手牌摞那种 30% 露出只适合牌背。
 */
const MELD_SIDE_LAP = 0.62;
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
const BUBBLE_W_NARROW = 138;
const BUBBLE_W_WIDE = 230;
const BUBBLE_LINE_H = 15;
const BUBBLE_MAX_LINES = 3;
const BUBBLE_MS = 4200;
const BUBBLE_FADE = 420;
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
 * 牌河/副露/摊牌用的「按座位平放牌」图集键（2026-10-21，源项目 liumengniu/majiang 的美术）：
 *   0 下 = faceA（first，46×64 竖版） · 1 右 = faceB（second，48×59 竖版）
 *   2 上 = faceC（third，42×60 竖版） · 3 左 = faceD（fourth，48×59 竖版）
 * 源项目里 `myCard`（带金顶条的**立牌**）只给自己手牌；桌面上的弃牌/副露一律是这四套
 * 平放牌（`Main.ts getPlayedCardsImageUrl` 按 viewPos 选目录），与我们的槽位一一对应。
 * 图集未就绪/部署漏带时 `tileimg.faceArt()` 返回 null → 各绘制点自动回退竖版立牌。
 * （2026-10-23：平放牌图集归牌面大类 —— /api/tiles 的 faces 子清单，入口统一到 tileimg）
 */
const SEAT_FACE = ['faceA', 'faceB', 'faceC', 'faceD'];

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
 * 手牌在左右边**单列**铺开（一条直线，和上下两家的单排一致），整列用统一投影比
 * `k = projD(cy)`，列 x 用 `screenToLogicX()` 反算 → 投影后牌同宽同高、列严格竖直。
 * 列内行距取左右两家牌河同款的 `RIVER_LAP_SIDE·k`（叠压），不再留缝。
 * `handX` 是列带左缘。
 */
const OVER_SIDE = {
  cy: 320,
  k: projD(320),
  handX: 138,
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
  return W / 2 + (x + w / 2 - W / 2) / d - w / 2;
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
     * 行距校验（缩放后不会互相压）：上/下河 h62×d(0.737..0.766)=45.7..47.5 < dy66；
     * 左/右河 h50×d(0.80..0.92)=40..46 < dy54 —— 缝只会变大不会变负。
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
    this.dpr = 1;
    this.onDiscard = () => {};
    this.onRollDice = () => {};
    this.onTagClick = () => {};
    this.tagRects = [null, null, null, null];
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
    this.applyBackingStore();
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
    for (let slot = 0; slot < 4; slot++) {
      const tg = this.tagRects[slot];
      if (tg && x >= tg.x && x <= tg.x + tg.w && y >= tg.y && y <= tg.y + tg.h) {
        this.onTagClick((this.view.mySeat + slot) % 4);
        return;
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
    for (const a of fresh) {
      if (ACTION_FX_KINDS.indexOf(a.kind) < 0) continue;
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
        s0: pose ? pose.scale : 1.55,   // 接管起点：无旧动画 = 完整缩放入场
        a0: pose ? pose.alpha : 0,
      };
    }

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
    if (view.lastDiscard) this.drawLastMarker(view);
    this.drawJingHighlight(view);
    if (view.phase === 'over') {
      this.drawWinnerHighlight(view);
      this.drawResultBanner(view);
    }
    this.drawEmoteFx();
    this.drawBubbles();
    this.drawActionFx();
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
    // （1280×640 已裁到画布比例并擦掉中心「湖南麻将」字样，见
    //  packages/client/src/assets/ui/table.png；生成走 `npm run gen:ui-cdn`）。
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
    // 2026-10-20 藏青桌面 + 木金框（用户参考图为深蓝桌布 + 暖金外框的商业牌桌）：
    // 只换色系与框型，投影梯形几何一行不动（drawTable 是背景，不参与牌张几何校验）。
    // 金框用「4px 主边 + 内侧 1px 暖金高光」双线，不做雕花纹理 —— 参考图的雕花框是
    // 受保护素材，只借鉴「桌布深色 + 外框暖金」的结构与氛围。
    ctx.fillStyle = '#0d1626';
    ctx.fillRect(0, 0, W, H);
    // 2026-10-20 侧视俯瞰：桌面本体 = 投影梯形（顶边收敛 58%、底边满宽）。
    // 收敛后上下两角留出深色「桌外」区 —— 四角铭牌正好落在那里（参考图同款构图），
    // 中心区域收敛感最强，牌的可读重头（近边/自己侧）几乎不受影响。
    const z = { proj: true };
    quadPath(ctx, projQuad(8, 8, W - 16, H - 16, z), 18);
    ctx.fillStyle = '#23405f';
    ctx.fill();
    ctx.strokeStyle = '#a8823c';
    ctx.lineWidth = 4;
    ctx.stroke();
    quadPath(ctx, projQuad(14, 14, W - 28, H - 28, z), 14);
    ctx.strokeStyle = 'rgba(255,214,120,0.32)';
    ctx.lineWidth = 1;
    ctx.stroke();
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
   * 四方牌河块的落位（**只描述屏幕上的矩形与格距，阅读顺序见 `riverCell()`**）。
   *
   *   · 上（对家）8 列 × 3 行：x 497..783，首行 166 贴盘，往上叠压（行距 27）
   *   · 下（自己）8 列 × 3 行：x 497..783，首行 430 贴盘，往下叠压（行距 27）
   *   · 左（上家）3 列 × 8 行：右缘贴盘左边，往下叠压（行距 21）
   *   · 右（下家）3 列 × 8 行：左缘贴盘右边，往下叠压（行距 21）
   * 四块都紧贴中心盘（480..800 × 222..418），容量统一 24，溢出压最后一格。
   * 左右两家在**牌主视角**里其实是「8 列 × 3 行」，与上下两家同形（一行 8 张）。
   */
  riverOrigin(seat) {
    if (seat === 2) return { x: 497, y: 166, cols: 8, rows: 3, vertical: false, dx: 36, dy: -RIVER_LAP_FAR, cap: 24 };
    if (seat === 0) return { x: 497, y: 430, cols: 8, rows: 3, vertical: false, dx: 36, dy: RIVER_LAP_FAR, cap: 24 };
    // 左右两家：牌在桌上本来就是**横躺**的（字的「上」指向坐在那一侧的玩家），
    // 所以格用横版 44×34、行距 21（叠压）、列距 46。
    /*
     * 2026-10-22（整块刚体缩放）：
     *   · `y 241` —— 8 行叠压后只有 ~157px 高（k≈0.865），块心要落在中心盘（222..418）
     *     的竖向中轴上（算下来 319 ≈ 盘心 320）；
     *   · `x 303 / 841` —— x 是绕屏幕中心 (640) 缩的，若直接用「贴盘」的 330/814，
     *     近边会被拉进盘里 ~18px。这里把原点外推，让**缩放后的近边**回到 466 / 814
     *     （离盘边 14px，与原来一致）。
     */
    if (seat === 3) return { x: 303, y: 241, cols: 3, rows: 8, vertical: false, dx: 46, dy: RIVER_LAP_SIDE, w: RIVER_H, h: RIVER_W, cap: 24 };
    return { x: 841, y: 241, cols: 3, rows: 8, vertical: false, dx: 46, dy: RIVER_LAP_SIDE, w: RIVER_H, h: RIVER_W, cap: 24 };
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
    const l = W / 2 + (o.x - W / 2) * k;
    const r = W / 2 + (o.x + (o.cols - 1) * dx + w - W / 2) * k;
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
   * 判据按「谁盖住它」：四家统一「屏幕上更靠下的那张在上层」，所以盖住本张的
   * 是**视觉上再往下一格**的同列牌。左右两家按牌主视角是竖列，
   * 那一格可能对应 i+1 / i-1，不再恒为 i±cols。
   */
  riverVisH(seat, i, n) {
    const o = this.riverOrigin(seat);
    const h = o.h || RIVER_H;
    const dy = o.dy || RIVER_DY;
    const lim = Math.min(n, o.cap || n);
    const { row } = this.riverCell(seat, i);
    // dy<0（对家）时行号 0 才是屏幕下方，所以「视觉下一格」= row-1
    const below = row + (dy > 0 ? 1 : -1);
    let nb = -1;
    if (below >= 0 && below < o.rows) {
      if (seat === 0) nb = i + o.cols;
      else if (seat === 2) nb = i - o.cols;
      else if (seat === 3) nb = i + 1;
      else nb = i - 1;
    }
    return nb >= 0 && nb < lim ? Math.abs(dy) : h;
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
       * **绘制顺序 = 「谁压在谁上面」**（2026-10-22 定稿）：四家统一「屏幕上更靠下
       * 的那张在上层」。按 `riverCell()` 的牌主读序，自己/上家的序号递增 = 屏幕
       * 往下（顺画即可）；下家/对家的序号递增 = 屏幕往上，必须倒着画，屏幕靠下的
       * 那张才压在上面（对家是用户 2026-10-22 第二轮纠正的「上一排遮住下一排」）。
       */
      const order = river.map((_, i) => i);
      if (slot === 1 || slot === 2) order.reverse();
      for (const i of order) {
        const p = this.riverPos(slot, i);
        const visH = this.riverVisH(slot, i, river.length);
        const t2 = visH < p.h ? Object.assign({}, tilt, { visH }) : tilt;
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
     */
    if (slot === 2) return { x: 360, y: 6, step: 40, horiz: true, w: 38, h: 52, max: 14 };
    if (slot === 3) return { x: 56, y: 208, step: 16, horiz: false, w: 17, h: 36, max: 14 };
    return { x: 1200, y: 208, step: 16, horiz: false, w: 17, h: 36, max: 14 };
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
      if (!o.horiz && sideArt) {
        for (let i = 0; i < n; i++) {
          const y = o.y + i * o.step;
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
          const y = o.y + i * o.step;
          if (i === 0) {
            ctx.drawImage(back, o.x, y, o.w, o.h);
          } else {
            ctx.drawImage(back, 0, back.height * 0.3, back.width, back.height * 0.42, o.x, y, o.w, o.step + 1);
          }
        }
        continue;
      }
      for (let i = 0; i < n; i++) {
        const x = o.x + (o.horiz ? i * o.step : 0);
        const y = o.y + (o.horiz ? 0 : i * o.step);
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
    // 叠压：末张若被同列邻居盖住一截，金框/精框也要收口在露出带上（否则框底埋进别人牌身）
    const visH = this.riverVisH(slot, i, river.length);
    const fh = Math.min(p.h, visH);
    // 2026-10-20：牌面朝向做在贴图里（`rotFace`），**几何占位不变** → 金框照旧贴着矩形画
    ctx.save();
    ctx.strokeStyle = '#e6c14b';
    ctx.lineWidth = 2;
    // 金框与牌身同走投影四边形（Lean + 透视 + zw 补偿）
    quadPath(ctx, projQuad(p.x - 2, p.y - 2, p.w + 4, fh + 4, resolveZone(tilt)), 4);
    ctx.stroke();
    ctx.restore();
    // 弃的是明面精 → 精描边（正精橙 / 副精紫）要在金框**之上**：drawTile 里的精描边先画、
    // 已被上面的金框盖住，这里补画一次（金框垫底、精框在上），两圈都可见（2026-10-18）。
    const gz = view.gz;
    const isPi = gz ? last.tile === gz.zheng[0] : last.tile === view.jingPi;
    const isFu = gz ? last.tile === gz.fu[0] : last.tile === view.jingFu;
    if (isPi || isFu) {
      this.jingBorder(p.x, p.y, p.w, fh, Math.max(2, Math.floor(p.w * 0.14)), isPi, tilt);
    }
  }

  drawCenter(view, deal) {
    const ctx = this.ctx;
    // 中心信息盘（2026-10-20 按用户参考图改「深色牌匾 + 大数字/风字」精简混合）：
    //   · 外框 **532..750 × 256..396 不变**（2026-10-20 几何校验：左右竖排副露被透视
    //     向中心拉进 ~38px（(795−640)×(1−0.756)），盘再宽必被副露角铲 —— 勿回退）；
    //   · 皮 = 深色牌匾（rgba(8,12,18,.85) + 2px 金边），换皮不换几何；
    //   · 内容 = 左栏「牌墙剩余大数字 + 庄家风位」（对应参考图「05 / 东」），
    //     右栏「立精」（立牌展示态，信息焦点）；骰子面对面撤除、改左栏底部
    //     9px 小字（`骰 3·4`），「牌墙」文字标签撤除给大数字让位；
    //   · 风位从盘内移除是上一轮的决定，本轮参考图又把它加回（在数字下方）——
    //     四角铭牌第一行已带「风位·昵称」+ 庄标 + 宝×N，这里是视觉锚点不重复读。
    const px = 480;
    const py = 226;
    const pw = 320;
    const ph = 196;
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
    // 2026-10-21 盘宽 280 → 360（吃掉中央那片空地），左栏中心 74 → 96、
    // 右栏立精整体右移 38（146/204 → 184/242），其余字号不变。
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 左栏大数字：LED 光效位图（CDN；取不到回落 fillText）。逐位图定宽排版，
    // 与文字方案同轴同高（72），多位数（>122 不会出现，兜底 3 位内）不溢出盘面。
    const wallStr = String(wallLeft);
    const digitImgs = [];
    for (const ch of wallStr) digitImgs.push(uiart.art(`d${ch}`));
    if (digitImgs.length && digitImgs.every(Boolean)) {
      const dh = 72;
      const dw = dh * 0.75; // 数字源图 30×40 比例
      const gap = 2;
      const totalW = digitImgs.length * dw + (digitImgs.length - 1) * gap;
      let dx = px + 86 - totalW / 2;
      const dy = py + 74 - dh / 2;
      for (const im of digitImgs) {
        ctx.drawImage(im, dx, dy, dw, dh);
        dx += dw + gap;
      }
    } else {
      ctx.fillStyle = '#f2f7f3';
      ctx.font = font(72, true);
      ctx.fillText(wallStr, px + 86, py + 74);
    }
    ctx.fillStyle = '#e6c14b';
    ctx.font = font(30, true);
    ctx.fillText(this.wind(view.dealer), px + 86, py + 142);

    // ---- 上回骰子：9px 小字（原盘内骰子面撤除，给大数字让位；值不变）----
    let shown = null;
    const c = view.ceremony;
    if (c && c.state === 'rolling' && c.dice) {
      shown = this.revealed(view) ? c.dice : null;
    } else if (!(c && c.state === 'wait-roll' && c.kind === 'deal')) {
      shown = view.lastDice || view.dealDice;
    }
    if (shown) {
      ctx.font = font(12);
      ctx.fillStyle = '#9db5a8';
      ctx.fillText(`骰 ${shown[0]}·${shown[1]}`, px + 86, py + 172);
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
       * 尺寸按**牌面源图的比例**（279×405 = 0.689）定，不再写死 48×62。
       * 写死 48 宽时比例 0.774，比源图宽 12%，叠上旧的 Lean 后宽到 35% —— 牌被拍扁。
       * 牌心固定在 188 / 246（下面「正精/副精」文字的 x），宽度变了也不会偏。
       */
      const jh = 62;
      const art0 = tileimg.art(pi);
      const ratio0 = art0 && art0.width && art0.height ? art0.width / art0.height : 279 / 405;
      const jw = Math.round(jh * ratio0);
      this.drawTile(pi, px + 188 - jw / 2, py + 28, jw, jh, view, false, STAND_HUD);
      if (hasFu) this.drawTile(fu, px + 246 - jw / 2, py + 28, jw, jh, view, false, STAND_HUD);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = font(11);
      ctx.fillStyle = '#e0a86a';
      ctx.fillText('正精', px + 188, py + 104);
      if (hasFu) {
        ctx.fillStyle = '#b48ae0';
        ctx.fillText('副精', px + 246, py + 104);
      }
      if (gzOn && !view.gz.revealed) {
        /*
         * 2026-10-22（用户「字样的显示位置异常，应该放在正副精下面空白处居中」）：
         * 原来写在 `px+140, py+142` —— 那是左栏「东」字的右边，两个文案直接撞在一起。
         * 盘里唯一整块空白是**正/副精两张牌下面**（y 104 的标签再往下到盘底没有内容），
         * 所以居中在两条标签的中线 `188/246 → 217` 上。
         */
        ctx.font = font(11);
        ctx.fillStyle = '#9db5a8';
        ctx.fillText('其余 10 张结算揭晓', px + 217, py + 126);
      }
    }

    if (c && c.state === 'wait-roll' && !this.rollClicked) {
      const label = c.kind === 'deal' ? '掷骰开局' : c.kind === 'jing' ? '掷骰翻精' : '掷骰补牌';
      const mine = view.mySeat === c.seat;
      /*
       * 2026-10-21：按钮改为**铺满盘内**（原 240×84 居中），因为盘加宽后它不再
       * 盖得住内容 —— 上面会露出立精的顶边、下面露出「骰 x·y」，看着像两块东西叠在一起。
       * 现在整块按钮就是「此刻的唯一动作」，盘内其余信息让位（点完就回来）。
       */
      const bx = px + 16;
      const by = py + 16;
      const bw = pw - 32;
      const bh = ph - 32;
      roundRect(ctx, bx, by, bw, bh, 12);
      ctx.fillStyle = mine ? '#e6c14b' : 'rgba(28,44,36,0.94)';
      ctx.fill();
      ctx.strokeStyle = mine ? '#f6e3a1' : '#4d675a';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (mine) {
        ctx.fillStyle = '#22200f';
        ctx.font = font(28, true);
        ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1);
      } else {
        ctx.fillStyle = '#9db5a8';
        ctx.font = font(15);
        ctx.fillText(`等待${this.wind(c.seat)}家${label}…`, bx + bw / 2, by + bh / 2 + 1);
      }
      if (mine) this.rollBtn = { x: bx, y: by, w: bw, h: bh };
    }
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
   * 摊牌各家明牌落位（结算态，2026-10-23 重排）：
   *   自己/对家：顶/底边**一排** 40×50，按实际张数**居中**（14 张 = 612 宽）；
   *   上家/下家：左右边**一列** 44×34 横向格，整列竖向居中（与上下两家的单排一致）；
   *     列内行距用左右牌河同款 `RIVER_LAP_SIDE·k` 叠压（用户要求「牌间隙像牌河」）。
   * 侧边整列走统一投影比 `OVER_SIDE.k`，不再按 y 逐张漂移。
   */
  revealOrigin(slot, n) {
    const cnt = Math.max(1, n || 0);
    if (slot === 2) return { x: 640 - (cnt * 44 - 4) / 2, y: 0, vertical: false };
    if (slot === 0) return { x: 640 - (cnt * 44 - 4) / 2, y: 550, vertical: false };
    const k = OVER_SIDE.k;
    const sw = RIVER_H * k;
    const sh = RIVER_W * k;
    // 与左右两家牌河同款：列内叠压（屏幕行距 21·k），整列竖向居中
    const pitch = RIVER_LAP_SIDE * k;
    return {
      x: slot === 3 ? OVER_SIDE.handX : W - OVER_SIDE.handX - sw,
      y: OVER_SIDE.cy - ((cnt - 1) * pitch + sh) / 2,
      vertical: true,
      dy: pitch,
      w: RIVER_H,
      h: RIVER_W,
      k,
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
      const q = projQuad(x, y, w, h, z);
      for (const p of q) acc.push(p);
    };
    const o = this.revealOrigin(slot, tiles.length);
    if (!o.vertical) {
      // 横边：单排 40×50，行距 44；按张数居中（x 在 revealOrigin 里算）
      const HB_W = 40;
      const HB_H = 50;
      const HB_DX = 44;
      tiles.forEach((t, i) => {
        const x = o.x + i * HB_DX;
        this.drawTile(t, x, o.y, HB_W, HB_H, view, false, tilt, rot, slot);
        push(x, o.y, HB_W, HB_H);
      });
    } else {
      // 竖边：单列 44×34，整列竖向居中（与上下两家的单排对应）
      tiles.forEach((t, i) => {
        const x = screenToLogicX(o.x, o.k);
        const y = o.y + i * o.dy;
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
   *   slot 0/2 → 竖版 40×52，一组副露沿 x 横排（pitch = 牌宽，紧贴）
   *   slot 1/3 → 横向 56×44，一组副露沿 y 竖排（pitch 26，见 MELD_SIDE_*）
   */
  meldMetrics(slot) {
    /*
     * 2026-10-22（第十轮，用户「上家和下家的牌还是竖直方向没对齐，左右存在偏移」）：
     * **副露牌的尺寸必须和牌河牌一模一样**——侧边 44×34、上下 34×44。
     *
     * 上一版是「按图集比例反推」（侧边 h=44 → w=54），比牌河牌（44×34）大一圈；
     * 两者在同一家面前**并排成两列**，一列宽 54、一列宽 44，屏幕上就是「粗细不一、
     * 上下对不齐」，怎么调锚点都救不回来。图集比例（59/48=1.229）与牌河的 1.294
     * 只差 5%，统一到牌河的格子肉眼看不出来，但并排立刻齐了。
     *
     * 侧边（上家/下家）组内**叠压**（用户「上下家的副牌也要像手牌一样叠放」）：
     * pitch = 牌高 × 0.62。上下两家是横排，横着叠会挡牌面 → 仍是 2px 紧排。
     */
    const vertical = slot === 1 || slot === 3;
    const w = vertical ? RIVER_H : RIVER_W; // 44 / 34
    const h = vertical ? RIVER_W : RIVER_H; // 34 / 44
    const pitch = vertical ? Math.round(h * MELD_SIDE_LAP) : w + 2;
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
   * 副露（吃/碰/杠）落位：牌河搬到四条边之后，环内四侧空出来了，副露就画在这里，
   * 紧挨各自玩家的牌河。
   *
   * **参数是屏幕槽位（slot），不是真实座位**（2026-10-21 澄清）：
   * `rotForSlot` / `meldMetrics` / 上下列分支全部按槽位判定，所以调用方传 slot。
   * 只有「报杠展示」需要真实座位去筛 `view.declared` —— 用 `seatAt()` 反算，
   * 之前直接拿 slot 去比 `d.seat`，只有 mySeat===0 时才对。
   *
   * 四家副露的朝向与占位（横排居中 640；侧边单列，组内叠压、组间竖排）：
   *   slot 0（自己）→ 竖版 40×52，横排，贴在牌河块左右两侧；
   *   slot 2（对家）→ 竖版 40×52，横排，贴在牌河块左右两侧；
   *   slot 3（上家）→ 横向 44×34，屏幕列在左牌河块外侧，整列竖向居中；
   *   slot 1（下家）→ 横向 44×34，屏幕列在右牌河块外侧，整列竖向居中。
   * 结算相位（2026-10-23 用户要求）**沿用局内位置**，不再换成结算专用排布。
   */
  drawMelds(melds, slot) {
    const view = this.view;
    const seat = view ? this.seatAt(view, slot) : slot;
    const list = melds || [];
    const decl = (view && view.declared ? view.declared : [])
      .filter((d) => d.seat === seat)
      .map((d) => d.tile);
    if (list.length === 0 && decl.length === 0) return;
    // 副露按座位朝向；但侧边是**横向格**（56×44）→ 横版美术直接铺满，内容不转（2026-10-21）
    const rot = flatRotForSlot(slot);
    const mm = this.meldMetrics(slot);

    if (slot === 0 || slot === 2) {
      const groups = [];
      if (decl.length > 0) groups.push({ decl: true });
      for (const m of list) groups.push({ m });
      // 副露行的 y 先定下来 —— 总长要按该行的投影比 d(y) 算（见 meldSpan）
      const R = this.riverBlockRect(slot);
      const gy = Math.round(R.t + (R.b - R.t) / 2 - mm.h / 2);
      const spanOf = (g) => (g.decl ? this.meldSpanN(decl.length, slot, gy) : this.meldWidth(g.m, slot, gy));
      /*
       * 2026-10-22（第八轮，用户「副牌显示还是异常」）：锚点不再写死 483/797，
       * 改成**贴着牌河块的实际屏幕矩形**（`riverBlockRect`）：左右各离 6px、
       * 垂直方向与块**居中**。牌河块换成整块刚体缩放后，近边内收了 20~30px，
       * 写死的锚点就让副露孤零零飘在外侧（左边空 54px），看着跟牌河脱节。
       */
      // 屏幕左/右两侧的牌河块**恒为 slot 3 / slot 1**（上家/下家），与自己是 slot 0
      // 还是 slot 2 无关 —— 曾写成 `slot === 0 ? 3 : 1`，对家那一侧就取反了，
      // 左右限互换 → 副露一张都放不下（对家整组副露消失）。
      const leftR = this.riverBlockRect(3);
      const rightR = this.riverBlockRect(1);
      const y = gy;
      let lx = R.l - 6; // 左半区：往左长（下限 = 左侧牌河块的内缘）
      let rx = R.r + 6; // 右半区：往右长（上限 = 右侧牌河块的内缘）
      const lLimit = Math.min(leftR.l, leftR.r);
      const rLimit = Math.max(rightR.l, rightR.r);
      for (const g of groups) {
        const w = spanOf(g);
        let x = null;
        if (lx - w >= lLimit) {
          lx -= w;
          x = lx;
          lx -= 6;
        } else if (rx + w <= rLimit) {
          x = rx;
          rx += w + 6;
        }
        if (x === null) break; // 真放不下（双方都满副露）→ 少画不压穿
        if (g.decl) this.drawDeclared(decl, x, y, rot, slot);
        else this.drawMeldRow(g.m, x, y, rot, slot);
      }
      return;
    }

    // 左右两家：副露列在牌河块外侧，一组接一组往下排。
    /*
     * 左右两家的副露列也贴牌河块：左列在左块**左侧**、右列在右块**右侧**，都用
     * `riverBlockRect` 的屏幕边 + 6px，不再写死 236 / 984（牌河块换成刚体缩放后
     * 近边内收了，写死的值会离块 60~70px，副露像被甩在外面）。
     * y 仍从 56 往下排（一列放 3 组），因为这些列是「竖带」，高度不受牌河块限制。
     */
    const RB = this.riverBlockRect(slot);
    const gapX = 6;
    const colX = slot === 3 ? Math.min(RB.l, RB.r) - gapX - mm.w : Math.max(RB.l, RB.r) + gapX;
    /*
     * y：以牌河块的**竖向中心**为基准整体居中（2026-10-22 第八轮）。
     * 原来固定从 y=56 往下排，而牌河块叠压后缩到 241..398，副露于是停在块的
     * 右上方、跟牌河斜着错开（用户「副牌还是异常」）。居中后：一组落在块的腰部、
     * 三组自然往上下展开，始终与块并肩成一条带。
     */
    const cy = (RB.t + RB.b) / 2;
    const spans = [];
    if (decl.length > 0) spans.push(this.meldSpanN(decl.length, slot, cy));
    for (const m of list) spans.push(this.meldSpan(m, slot, cy));
    // 组间距：侧边组内已经叠压（27 一步），组间必须留明显的空档，否则 4 张和下一组
    // 粘成一条看不出「几组」。上下两家仍是横排 2px 紧排，组间距 5 就够。
    const gapY = mm.vertical ? 14 : 5;
    const total = spans.reduce((a, b) => a + b, 0) + gapY * Math.max(0, spans.length - 1);
    // 4 组（≈647 高）居中的话起点会到 -3 → 夹到 8，最后一组由 sideBottom 兜住少画
    let y = Math.max(8, Math.round(cy - total / 2));
    const sideBottom = 630; // 画布 640，留 10
    let gi = 0;
    if (decl.length > 0) {
      y = this.drawDeclared(decl, colX, y, rot, slot) + gapY;
      gi = 1;
    }
    for (const m of list) {
      const span = spans[gi++] || 0;
      if (y + span > sideBottom) break; // 极端的四组牌：少画不压穿
      y = this.drawMeldRow(m, colX, y, rot, slot) + gapY;
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
       * 暗杠中间两张是**扣着的**，自己/对家（slot 0/2，竖版牌 34×44）换成 44×72 那张
       * 偏瘦长的金背（`back_op`）。左右两家是**横躺牌**（44×34），塞竖版牌背会变形，
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
   * 第一行：风位圆牌（34px）+ `庄` + `宝×N` + `昵称·我`（左）/ 累计总分（右）。
   * 第二行：**「手牌 N」**（左，带底衬的胶囊，左缘与圆牌对齐 x+10）/ 状态（右）。
   *
   * 为什么张数要写进铭牌：画布里的对手手牌背已经整条删掉（四条边全部让给牌河），
   * 「还剩几张」必须另有出口。文案固定为「手牌 N」而不是光秃秃的「N 张」——
   * 牌河现在占四条边，只写张数会被读成弃牌数。数值取 `view.counts`
   * （服务端 `hands.map(h => h.length)`，摸牌 +1、出牌 -1、碰/杠 -n），每帧跟着状态走。
   *
   * 几何预算：高 54（INSET 14 → 占 y14..68 / y572..626），左右牌河从 y70 起 / 到 y548 止，
   * 上下牌河从 x328 起 —— 四角都不压牌；宽 220 也只伸到 x234 / x1046，同样让开牌河。
   * **2026-10-20 头像化只改内部排布，TAG_W/TAG_H/INSET/pos 一行不动** →
   * `tagRects`（hitTest 点击区 / 气泡锚点 / 表情飞行动画锚点）零移动。
   */
  drawTag(view, seat) {
    const ctx = this.ctx;
    const slot = this.disp(view, seat);
    const TAG_W = 220;
    const TAG_H = 54;
    const INSET = 14;
    const pos = {
      0: [INSET, H - INSET - TAG_H],
      1: [W - INSET - TAG_W, H - INSET - TAG_H],
      2: [W - INSET - TAG_W, INSET],
      3: [INSET, INSET],
    };
    const xy = pos[slot];
    const x = xy[0];
    const y = xy[1];
    const w = TAG_W;
    const h = TAG_H;
    this.tagRects[slot] = { x, y, w, h };
    const isTurn = view.phase === 'playing' && view.turn === seat;
    const isWinner = view.phase === 'over' && view.winner === seat;
    const me = seat === view.mySeat;
    const dealer = seat === view.dealer;
    const offline = view.connected !== undefined && !view.connected[seat];
    const autoPlay = view.auto !== undefined ? view.auto[seat] === true : offline;

    roundRect(ctx, x, y, w, h, 8);
    ctx.fillStyle = isWinner ? 'rgba(230,193,75,0.3)' : 'rgba(0,0,0,0.4)';
    ctx.fill();
    // 当前出牌方：边框呼吸。原来靠 `drawTurnCursor()` 在「对手手牌带」外面画一圈光标，
    // 手牌带删掉后那圈框会浮在牌河上，已整体删除 —— 回合提示改由铭牌承担。
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

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // ---- 风位圆牌（2026-10-20 头像化占位：金边深底 / 庄家金底深字）----
    const ccx = x + 27;
    const ccy = y + 27;
    ctx.beginPath();
    ctx.arc(ccx, ccy, 17, 0, Math.PI * 2);
    ctx.fillStyle = dealer ? '#e6c14b' : 'rgba(0,0,0,0.35)';
    ctx.fill();
    ctx.strokeStyle = '#e6c14b';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = dealer ? '#22200f' : '#e6c14b';
    ctx.font = font(17, true);
    ctx.textAlign = 'center';
    ctx.fillText(this.wind(seat), ccx, ccy + 1);
    ctx.textAlign = 'left';

    // ---- 第一行：庄标 + 上宝徽标 + 昵称（左）/ 总分（右）----
    let tx = x + 50;
    if (dealer) {
      const stamp = uiart.art('banker');
      if (stamp) {
        // 红印章庄标（CDN 位图；取不到回落下方金底「庄」字，语义不变）
        ctx.drawImage(stamp, tx - 1, y + 5, 24, 24);
      } else {
        roundRect(ctx, tx, y + 8, 22, 20, 5);
        ctx.fillStyle = '#e6c14b';
        ctx.fill();
        ctx.fillStyle = '#22200f';
        ctx.font = font(12, true);
        ctx.textAlign = 'center';
        ctx.fillText('庄', tx + 11, y + 18);
        ctx.textAlign = 'left';
      }
      tx += 26;
    }
    // 上宝倍数徽标（庄家标之后）：打出明面正精/副精累计，胡牌分按它翻倍
    const bao = (view && view.bao && view.bao[seat]) || 1;
    if (bao > 1) {
      roundRect(ctx, tx, y + 8, 42, 20, 5);
      ctx.fillStyle = '#c3603d';
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = font(12, true);
      ctx.textAlign = 'center';
      ctx.fillText(`宝×${bao}`, tx + 21, y + 18);
      ctx.textAlign = 'left';
      ctx.font = font(13);
      tx += 46;
    }

    const tv = (view.totals && view.totals[seat]) || 0;
    const scoreText = tv > 0 ? `+${tv}` : `${tv}`;
    ctx.font = font(13, true);
    const scoreW = ctx.measureText(scoreText).width;

    const rawName = (view.names && view.names[seat]) || '';
    ctx.font = font(13);
    // 风位已在圆牌上（2026-10-20 头像化），label 去掉「风位·」前缀 —— 省下的宽度给昵称；
    // 昵称本身是「我」时不再追加「·我」（否则显示成「我·我」）
    let label = rawName ? `${rawName}${me && rawName !== '我' ? '·我' : ''}` : this.wind(seat);
    // 昵称可能很长：按「分数左侧的剩余宽度」逐步截断，宁可省略也不压到分数
    const room = x + w - 10 - scoreW - 10 - tx;
    while (label.length > 2 && ctx.measureText(label).width > room) {
      label = `${label.slice(0, -2)}…`;
    }
    ctx.fillStyle = isWinner ? '#ffe9a8' : isTurn ? '#e6c14b' : '#e8efe9';
    ctx.fillText(label, tx, y + 18);

    ctx.textAlign = 'right';
    ctx.fillStyle = tv > 0 ? '#43c07c' : tv < 0 ? '#e07a6a' : '#9db5a8';
    ctx.fillText(scoreText, x + w - 10, y + 18);

    // ---- 第二行左：剩余手牌数量（胶囊底衬，避免与牌河混读）----
    // 2026-10-23（用户：手牌数显示位置异常）：胶囊左缘从 x+10 改到 x+50 ——
    // x+10 会压在风位圆牌（圆心 x+27、半径 17）的下半圈上，「手牌 N」正好盖住风字，
    // 四个铭牌都像被啃掉一块。x+50 与昵称起点对齐、完全避开圆牌；庄/宝徽标在
    // 第一行（y+8..y+28），胶囊在第二行（y+29..y+51），也不会互相压。
    const n = this.effCounts[seat] || 0;
    ctx.font = font(12);
    const lblW = ctx.measureText('手牌').width;
    ctx.font = font(16, true);
    const numW = ctx.measureText(String(n)).width;
    const chipW = lblW + numW + 16;
    roundRect(ctx, x + 50, y + 29, chipW, 22, 6);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(230,193,75,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = font(12);
    ctx.fillStyle = '#9db5a8';
    ctx.fillText('手牌', x + 54, y + 40);
    ctx.font = font(16, true);
    ctx.fillStyle = '#f2f7f3';
    ctx.fillText(String(n), x + 54 + lblW + 5, y + 40);

    // ---- 第二行右：状态 ----
    ctx.textAlign = 'right';
    if (isWinner) {
      ctx.font = font(14, true);
      ctx.fillStyle = '#ffe9a8';
      ctx.fillText('胡牌！', x + w - 10, y + 40);
    } else if (autoPlay) {
      ctx.font = font(13);
      ctx.fillStyle = '#e0a06a';
      ctx.fillText('托管中', x + w - 10, y + 40);
    } else if (isTurn) {
      ctx.font = font(13);
      ctx.fillStyle = '#e6c14b';
      ctx.fillText('出牌中', x + w - 10, y + 40);
    }
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
      ctx.font = font(emote ? 14 : 12, emote);
      const lines = this.wrapText(b.content, maxW - 18, BUBBLE_MAX_LINES);
      if (lines.length === 0) continue;
      let textW = 0;
      for (const l of lines) textW = Math.max(textW, ctx.measureText(l).width);
      const w = Math.min(maxW, Math.ceil(textW) + 18);
      const h = lines.length * BUBBLE_LINE_H + 12;
      const leftSide = slot === 0 || slot === 3;
      const up = slot === 0 || slot === 1;
      let x = leftSide ? tag.x : tag.x + tag.w - w;
      let y = up ? tag.y - 8 - h : tag.y + tag.h + 8;
      x = Math.max(8, Math.min(W - 8 - w, x));
      y = Math.max(8, Math.min(H - 8 - h, y));
      const age = now - b.t0;
      ctx.globalAlpha = Math.max(0, Math.min(1, age / 160, (BUBBLE_MS - age) / BUBBLE_FADE));
      const bg = emote ? 'rgba(48,34,10,0.94)' : 'rgba(16,26,21,0.92)';
      roundRect(ctx, x, y, w, h, 8);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = emote ? '#e6c14b' : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const tailX = leftSide ? tag.x + 20 : tag.x + tag.w - 20;
      ctx.beginPath();
      ctx.moveTo(tailX - 6, up ? y + h : y);
      ctx.lineTo(tailX + 6, up ? y + h : y);
      ctx.lineTo(tailX, up ? y + h + 7 : y - 7);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = emote ? '#ffe9a8' : '#e8efe9';
      lines.forEach((l, i) => ctx.fillText(l, x + 9, y + 6 + BUBBLE_LINE_H * i + BUBBLE_LINE_H / 2));
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
      // 暗杠/补杠：与普通「杠」同图，补小注区分
      const cap = fx.kind === 'angang' ? '暗杠' : fx.kind === 'bugang' ? '补杠' : '';
      if (cap) {
        ctx.font = font(26, true);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(0,0,0,0.65)';
        ctx.strokeText(cap, 0, 78);
        ctx.fillStyle = '#f6e3a1';
        ctx.fillText(cap, 0, 78);
      }
    } else {
      // 回退：圆角块 + 文字（贴图未就绪时保持旧行为）
      const conf = {
        chi: { label: '吃', color: '#81c784' },
        peng: { label: '碰', color: '#64b5f6' },
        gang: { label: '杠', color: '#ffb74d' },
        angang: { label: '暗杠', color: '#ffb74d' },
        bugang: { label: '补杠', color: '#ffb74d' },
        hu: { label: '胡', color: '#ef9a9a' },
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
   * 结算横幅：**挂在环内上沿、中心盘正上方**（y 214~254）。
   * 原来画在画布最顶端（y 4~48）——对手手牌背删掉后那里是「对家摊牌」的第一行，
   * 横幅刚好压住 9 张明牌（截图实测）。挪到环内后：对家副露在 160~212、中心盘从 256 起，
   * 左右两侧竖排副露止于 x 450 / 始于 x 835，横幅 470~810 全部避开。
   */
  drawResultBanner(view) {
    const seat = view.winner;
    if (seat === null || view.phase !== 'over') return;
    const name = (view.names && view.names[seat]) || this.wind(seat);
    let main = `${this.wind(seat)}·${name} 胡`;
    const sub = view.result || '';
    const ctx = this.ctx;
    const bw = 340;
    const bh = 40;
    const bx = (W - bw) / 2;
    const by = 214;
    ctx.font = font(16, true);
    while (main.length > 2 && ctx.measureText(main).width > bw - 24) {
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
    // 叠压牌河（RIVER_LAP_*）：牌的下部被下一行盖住了，精框若照整张牌画，
    // 底边就落进下一张牌身里 → 屏幕上看着像「两条竖杠、没有下边」。
    // 调用方用 `visH` 告诉这里「实际露出的高度」，框就收口在可见带上。
    // y 也要跟着补：projQuad 是**绕传入矩形的中心**缩的，直接换小 h 会让框整体下移。
    if (tilt && tilt.visH) {
      const k = tilt.k || 1;
      y += ((h - tilt.visH) * (1 - k)) / 2;
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
        c2.drawImage(img, sx, sy, cw, ch, 0, 0, bw, bh);
      } else if (t < 0) {
        this.paintTileBack(c2, 0, 0, bw, bh);
      } else {
        this.paintTileFace(c2, t, 0, 0, bw, bh);
      }
      c2.restore();
      cv = nc;
    }
    if (Object.keys(this._rotCache).length > 40) this._rotCache = {};
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
      const src = rot ? this.rotFace(t, w, h, rot, slot) : art || this.tileFace(t, w, h);
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
            if (!noGlow) this.jingBorder(x, y, w, h, r, isPi, tl);
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
