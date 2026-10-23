/**
 * 对局页：Canvas 牌桌 + HUD + 控件 + 手牌操作条 + 聊天 / 记录 + 结算面板。
 *
 * 与 web 端的对应关系（逻辑不变，仅替换平台入口）：
 *   · `table.render(v)`        → utils/table.js（Canvas 2D，逻辑坐标恒 1280×640）
   *   · 画布尺寸                 → fitCanvas()：取 min(可用宽, 行高×2)，与 web 端同一约定，
   *                                保证画布盒 = 内容盒（小程序若非等比拉伸同样会让点牌错位）；
   *                                2026-10-21 起画布独占整行（记录/聊天改侧边钮 + 弹窗），
   *                                只在宽度方向扣 RAIL_RESERVE 给左右两条按钮轨
 *   · 点击换算                 → onCanvasTap：触摸点 − 画布 boundingClientRect → 逻辑坐标
 *                                （画布内现在只剩掷骰按钮与四角铭牌可点）
 *   · 手牌                     → **只在画布下方的 DOM 手牌条**。2026-10-17 起画布内不再常驻
 *                                手牌带：1280 逻辑宽被压到约 500 CSS px，牌面只剩 20×27，
 *                                比 DOM 条小一半且点不准；画布仅在摊牌时展示一次自己的明牌。
 *                                （曾试过用 cover-view 盖在牌桌上，开发者工具里盖不住原生
 *                                canvas、整块不可见，已改回流内，见 §10.8⑦）
 *   · window.confirm           → 页内 .layer 确认框（wx.showModal 原生弹窗在本环境不可靠）
 *   · 响应倒计时               → 200ms 心跳且只在文案变化时 setData（方案 P4：setData 节制）
 */

const { tileName, seatWind, suitOf, rankOf } = require('../../lib/shared/tiles.js');
const { CHAT_TEXT_MAX, THROW_EMOJI, THROW_EMOJI_TONES, throwEmojiOf } = require('../../lib/shared/index.js');
const { variantName } = require('../../lib/shared/rules/index.js');
const { Table } = require('../../utils/table.js');
const tileimg = require('../../utils/tileimg.js');
const uiart = require('../../utils/uiart.js');
const diceUtil = require('../../utils/dice.js');
const room = require('../../utils/room.js');
const net = require('../../utils/net.js');
const ui = require('../../utils/ui.js');
/** 局内音效（2026-10-23）：走 CDN 清单，音频不进代码包；见 utils/sound.js */
const sound = require('../../utils/sound.js');

/** 牌面花色字（万/条/筒）；风箭牌直接显示牌名（东南西北中发白） */
const SUIT_TEXT = { m: '万', s: '条', p: '筒' };
/** 风箭牌的色调类名（对应 game.wxss 的 .tone-*）：中红、发绿、白蓝框、风牌墨色 */
function honorTone(t) {
  if (t === 31) return 'zhong';
  if (t === 32) return 'fa';
  if (t === 33) return 'bai';
  return 'wind';
}

const CHAT_QUICK = ['快点啊', '胡了！🎉', '不好意思', '等一下', '这把稳了', '笑死😂', '加油', '别急'];
const CHAT_EMOJI = ['😀', '😂', '😍', '😎', '🤔', '😅', '👍', '👏', '🎉', '🔥', '💡', '🀄', '❤️', '🍺', '😴', '🙏'];
const LOG_ACTION_LABEL = {
  discard: '出牌',
  chi: '吃',
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
  bugang: '补杠',
  hu: '胡',
  draw: '流局',
};
/** 动作日志 kind → 音效键（2026-10-23）。 */
const SOUND_BY_ACTION = {
  discard: 'discard',
  chi: 'chi',
  peng: 'peng',
  gang: 'gang',
  angang: 'gang',
  bugang: 'gang',
  hu: 'hu',
};
const CHAT_MAX = 200;
const COUNTDOWN_MS = 200;
/** 操作记录最多渲染这么多行（服务端 actionLog 保留 500 条）：全量塞进常驻侧栏
 *  会在每次 state 广播时重排几千像素，长局明显掉帧。 */
const LOG_ROWS_MAX = 120;

/**
 * 侧边按钮轨（rail）的宽度预算（px，与 game.wxss 的 .rail / .rail-btn 必须一致）。
 *
 * 2026-10-21 布局重排（用户报「牌面区域小、功能都挤在顶部」）：左右侧栏（记录 / 聊天）
 * 从流内三栏改成**侧边按钮 + 弹窗面板**，画布由此独占整行。这条常量是
 * fitCanvas 从画布宽里扣掉的预留：手机横屏画布本来就被行高卡住（宽有富余），
 * 扣了不吃亏；宽窗口（画布吃宽度）时才真正让出 84px 给两条轨。
 *
 * ⚠️ 轨**绝不能压到画布矩形**：原生 canvas 合成层级高于所有 DOM，压在画布上的
 * 按钮会被画布盖住、点不到。所以 RAIL_RESERVE 必须 ≥ (RAIL_W+2)×2，
 * 保证画布两侧各留 ~42px 空白给轨（见 fitCanvas 的 min(W−84, H×2)）。
 */
const RAIL_W = 36;
const RAIL_GAP = 6;
const RAIL_RESERVE = (RAIL_W + RAIL_GAP) * 2;
/** 自定义导航栏（game.json navigationStyle=custom）下，顶栏右侧必须避让的胶囊宽（⋯ ○） */
const CAPSULE_W = 118;
/** 自绘顶栏高度（px，与 game.wxss 的 .g-top 一致；estimateWrap 的 chrome 估算要用） */
const TOPBAR_H = 28;

/**
 * 手牌条的尺寸预算（单位 px，与 game.wxss 的 `.tile-btn` 默认值同一套数值）。
 *
 * 2026-10-21 用户报「手牌为啥还能滑动，直接全部显示不行吗」。
 * 根因：手牌条宽度绑的是 `canvasW`（画布 2:1 反算）。PC 宽窗口画布能到 830px、
 * 14 张刚好放下；**手机横屏**行高只有 ~200px → 画布被压到 ~410px，而 14 张 46px
 * 的牌要 679px，放不下只能横向滚动。断点档（≤700px 缩到 39px）按**窗口宽**判断，
 * 844px 的横屏手机根本命中不了，球还是滚不起来。
 *
 * 现在牌位尺寸由 `fitCanvas()` 按实测行宽/画布宽算出（`handMetrics`）：上面这几个
 * 常量是**上限**，地方不够就整排同比缩小（牌位 + 字号 + 透视同一个比例，永不再裁切），
 * 再通过 CSS 变量写到 `.tray-row` 上。目标：任何横屏窗口都不靠滚动看全 14 张。
 */
const HAND_TILES = 14; // 最多 13 手牌 + 1 摸牌；按最坏情况排版，13 张时余量由居中吸收
const HAND_TILE_W = 46;
const HAND_TILE_H = 66;
const HAND_TILE_GAP = 2; // 每张牌左右 margin 合计（margin: 0 1px）
const HAND_DRAWN_EXTRA = 7; // 摸牌位 margin-left 8px 比普通位多出的 7px
const HAND_MIN_W = 30; // 窄于此不如留给 scroll-view 兜底（iPad 分屏这类极端窄窗）

/** 从 SelectorQuery 结果里取「宽高都大于 0」的盒子（fields({size}) 只给宽高；boundingClientRect 还给 left/top） */
function boxOf(r) {
  if (!r || !(r.width > 0) || !(r.height > 0)) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

Page({
  data: {
    // HUD
    code: '',
    // 页面切换转场：room.js 跳转前置 true → 根节点 .page-leaving 淡出后再 redirectTo
    pageLeaving: false,
    variantLabel: '',
    wallText: '',
    jingText: '',
    statusText: '',
    autoShown: false,
    autoOn: false,
    dissolveGameShown: false,
    /** 背景音乐开关（2026-10-23）：与音效总开关独立，持久化在 utils/sound.js */
    bgmOn: true,
    // 画布
    canvasW: 640,
    canvasH: 320,
    /**
     * 整屏桌面背景（2026-10-22）：绿绒龙纹桌铺满整个页面，而不是只在画布里铺一块。
     *
     * 改前：桌面贴图由 canvas 画在 1280×640 里 → 画布是 2:1、又被行高卡成手机横屏的
     * 65% 宽，于是屏幕左右两条深色空白里飘着按钮轨，观感是「一张牌桌摆在一间黑屋子里」。
     * 参考图（用户给的源项目截图）是绿绒桌铺到屏幕四边、手牌直接坐在桌上。
     *
     * 现在：`.felt` 这一层 DOM 铺整页（`<image mode="scaleToFill">`，与牌面同一条 CDN
     * 链路），canvas 里用**同一个矩形**画同一张图（table.js 的 `drawTable` + `frame`）
     * → 画布矩形内由 canvas 画、矩形外由 DOM 画，两层映射一致所以看不出接缝。
     * 为什么不干脆把 canvas 拉满整屏：`<canvas type="2d">` 是原生组件，会压住其矩形内
     * 的所有 DOM（手牌条/按钮轨都会消失），所以 canvas 只能占中间那块。
     * 用 `<image>` 而不是 WXSS 的 background-image：走的是和手牌牌面完全同一条加载链路
     * （downloadFile 合法域名 + 微信侧缓存），牌面能显示它就能显示，少一个排查变量。
     */
    feltUrl: '',
    /** UI 整通道拿不到时（清单空/请求失败）桌面底色退成矢量桌的藏青，见 loadUiArt */
    feltNavy: false,
    // 侧边面板开关（2026-10-21）：记录 / 聊天从「流内三栏」改成左右侧边按钮 + 弹窗，
    // 画布独占 .game-main。两者互斥（同时只开一个），打开时 panelOpen 会把原生画布
    // 藏掉 —— <canvas> 合成层级在 DOM 之上，不藏面板会被画布压住（见 syncPanels）。
    // 注意与 modalOpen 的区别：panelOpen **不藏底部操作区**（手牌条照常可见可点），
    // 模态类浮层（骰子/结算/解散…）才走 modalOpen。
    logOpen: false,
    chatOpen: false,
    panelOpen: false,
    // 左侧记录栏的滚动位置：每来一条新记录就往上加，scroll-top 递增 → 触底（跟随最新
    // 一步）。**不用 `scroll-into-view` 固定锚点**——那只有值变化时才生效，写死的 id
    // 在后续追加行时不会再滚一次，表现就是「新记录沉在下面看不见」。
    logScrollTop: 0,
    // 任一浮层打开（由 syncModal 统一维护）：原生 canvas 合成层级高于 DOM，
    // 浮层打开期间必须藏掉牌桌画布 —— 见 syncModal 注释
    modalOpen: false,
    // 控件
    controls: [],
    controlsErrShown: false,
    controlsErrText: '',
    countdownShown: false,
    countdownText: '',
    // 手牌操作条
    trayShown: false,
    trayActive: false,
    tray: [],
    // 手牌牌位度量（px）：由 fitCanvas → handMetrics 按实测行宽/画布宽算出，
    // 经 CSS 变量写进 .tray-row（--tw/--th/--ml-drawn/--fs-*/--persp）。
    // 初始值与 wxss 里的默认值一致 —— 首帧（还没量到布局）也不裁切、不溢出。
    handTrayW: 679,
    handTileW: 46,
    handTileH: 66,
    handFsRank: 25,
    handFsSuit: 12,
    handFsHonor: 27,
    handMlDrawn: 8,
    // 结算态（v.phase === 'over'）：手牌带整体退场、操作区只剩一行结果，
    // 画布要吃掉腾出的高度（见 renderGame 里的 fitCanvas）—— 见 §10.8⑫
    overPhase: false,
    // 聊天（面板化：由右侧轨 💬 按钮弹窗触发，见 logOpen/chatOpen）
    chatMax: 60,
    quickList: CHAT_QUICK,
    emojiList: CHAT_EMOJI,
    chatMsgs: [],
    chatUnread: 0,
    chatInput: '',
    quickShown: false,
    emojiShown: false,
    logRows: [],
    // 互动表情
    emoteShown: false,
    emoteTargets: [],
    emoteGroups: [],
    emoteTargetSeat: -1,
    // 结算
    settleShown: false,
    settleTitle: '',
    settleArt: '',
    settleHead: [],
    settleRows: [],
    settleNotes: [],
    settleTotals: '',
    settleRestoreShown: false,
    settleNextDisabled: false,
    // 其它浮层
    swapAskShown: false,
    swapAskText: '',
    abortAskShown: false,
    dissolvedShown: false,
    dissolvedTitle: '',
    dissolvedRows: [],
    diceShown: false,
    diceMsg: '',
    // 两枚骰子：{ idx, rows(3×3 点子网格：0 空 / 1 黑 / 2 红), tumbling, land }
    dice: diceUtil.pair(1, 1, false, false),
    netShown: false,
    netText: '',
    toastShown: false,
    toastText: '',
    // 刘海 / 挖孔屏安全区（px，横屏时在左或右侧边；无刘海设备为 0）。
    // 写进根节点 CSS 变量 --safe-l/--safe-r，wxss 的 .game 横向 padding 用它让位。
    safeL: 0,
    safeR: 0,
    // 顶部安全区（px）：自定义导航栏（navigationStyle=custom）后页面铺满全屏，
    // 顶栏必须自己避开系统状态栏（安卓横屏 ~24px，iOS 横屏 0）。来源同 computeSafeInsets。
    safeT: 0,
  },

  // ---------- 生命周期 ----------

  /**
   * 刘海 / 挖孔屏安全区检测（2026-10-18，探测元素版）。
   *
   * 三个来源取大者：
   *   ① **探测元素**（主来源，最可靠）：三个 0 高的隐藏节点分别把宽/高写成
   *      `env(safe-area-inset-left/right/top)`，用 SelectorQuery 把尺寸量回来 ——
   *      这就是**当前运行时里 env() 真实解析出的值**，和 padding 用的是同一个求值，
   *      模拟器 / 真机 / 新旧基础库都不会有「API 报告值与 CSS 实际值不一致」的缝隙；
   *   ② `wx.getWindowInfo().safeArea`（部分安卓机型横屏只认这个）；
   *      开发者工具的 getWindowInfo 可能不带 safeArea → 回退 getSystemInfoSync()。
   * 横屏下刘海在左或右侧边（哪侧取决于旋转方向）；无刘海设备三个来源都是 0。
   * 结果写进根节点 CSS 变量 --safe-l/--safe-r/--safe-t，wxss 的 padding 消费；
   * 变化时补 fitCanvas。
   */
  computeSafeInsets() {
    let l = 0;
    let r = 0;
    let t = 0;
    let raw = null;
    try {
      let info = null;
      try {
        info = wx.getWindowInfo ? wx.getWindowInfo() : null;
      } catch (e) {
        info = null;
      }
      if (!info || !info.safeArea) {
        // 开发者工具的 getWindowInfo 可能不带 safeArea → 回退旧接口
        const legacy = wx.getSystemInfoSync ? wx.getSystemInfoSync() : null;
        if (legacy && legacy.safeArea) info = legacy;
      }
      const sa = info && info.safeArea;
      if (sa && info.windowWidth > 0) {
        raw = sa;
        l = Math.max(0, Math.round(sa.left));
        r = Math.max(0, Math.round(info.windowWidth - sa.right));
        // 顶部：自定义导航栏（navigationStyle=custom）后页面铺满全屏，
        // 顶栏必须自己避开系统状态栏（安卓横屏 ~24px，iOS 横屏 0）
        t = Math.max(0, Math.round(sa.top));
      }
      // safeArea 整体缺失时用状态栏高度兜底（横屏安卓状态栏高度与竖屏同值）
      if (!sa && info && info.statusBarHeight) t = Math.max(t, Math.round(info.statusBarHeight));
    } catch (e) {
      /* 没有 safeArea：保持 0，由探测元素 / env() 兜底 */
    }
    const q = wx.createSelectorQuery();
    q.select('#safe-probe-l').boundingClientRect();
    q.select('#safe-probe-r').boundingClientRect();
    q.select('#safe-probe-t').boundingClientRect();
    q.exec((res) => {
      // 探测元素尺寸 = env() 在当前运行时的真实解析值（padding 里用的就是同一个 env()）
      const pl = res && res[0] && res[0].width > 0 ? Math.round(res[0].width) : 0;
      const pr = res && res[1] && res[1].width > 0 ? Math.round(res[1].width) : 0;
      const pt = res && res[2] && res[2].height > 0 ? Math.round(res[2].height) : 0;
      l = Math.max(l, pl);
      r = Math.max(r, pr);
      t = Math.max(t, pt);
      console.info(
        '[mj] safeArea =',
        raw ? JSON.stringify(raw) : 'null',
        '→ env 探测 l/r/t =',
        pl,
        pr,
        pt,
        '→ 取大后 =',
        l,
        r,
        t,
      );
      if (l !== this.data.safeL || r !== this.data.safeR || t !== this.data.safeT) {
        this.setData({ safeL: l, safeR: r, safeT: t });
        this.fitCanvas(); // 横向 padding 变了 → 画布可用宽变化，重量一次
      }
    });
  },

  onLoad() {
    this.view = null;
    this.ceremonyAnim = null;
    this.ceremonyExpiryKey = -1;
    this.lastCountdownText = '';
    this.chatUnread = 0;
    this.emoteTargetSeat = null;
    this.pendingVariant = '';
    // 操作区高度档位（仪式中 / 结算）—— 档位翻转要重量画布，见 renderGame
    this.chromeKey = undefined;
    // 操作记录的增量去重键（最后一条的 seq）
    this.logKey = undefined;
    // 音效：已播到的动作 seq（按 view.log 增量播，避免重复/漏播）
    this.sndSeenSeq = 0;
    // 音效：上次手牌张数（发牌/摸牌 → deal 音效）
    this.sndHandCount = 0;
    // 错误提示的自动回退定时器（见 onError）
    this.errTimer = null;
    // 窗口尺寸变化（真机旋转 / 模拟器改窗口）：Page.onResize 在部分环境不触发，
    // 再挂一个应用级监听兜底 —— 画布不重量就会出现留白或点牌错位。
    if (wx.onWindowResize) {
      this.windowResizeHandler = () => {
        this.computeSafeInsets(); // 旋转后刘海可能换边
        this.fitCanvas();
      };
      wx.onWindowResize(this.windowResizeHandler);
    }
    const g = getApp().globalData;
    this.setData({
      // 字数上限只认 shared 的常量（服务端用同一个值裁剪），不在 WXML 里另写一个数
      chatMax: CHAT_TEXT_MAX,
      chatMsgs: (g.chatHistory || []).map((m) => ({
        seat: m.seat,
        name: m.name,
        text: m.text,
        self: m.seat === g.mySeat,
      })),
      chatUnread: g.chatUnread || 0,
    });
  },

  onShow() {
    room.attach('game', this);
    this.syncNet();
    this.computeSafeInsets(); // 刘海 / 挖孔屏：每次显示重测（旋转方向变了内缩侧会互换）
    this.initCanvas();
    sound.ensure(); // 局内音效清单（CDN）；失败即静音，不影响对局
    this.setData({ bgmOn: sound.isBgmEnabled() }); // 侧轨音乐钮反映持久化开关
    sound.bgmStart(); // 背景音乐：循环播放；iOS 首次手势后由 unlock() 再起
    this.startCountdown();
    const g = getApp().globalData;
    if (g.lastGameView) this.renderGame(g.lastGameView);
  },

  onHide() {
    room.detach(this);
    this.stopCountdown();
    this.clearDice();
    sound.bgmPause(); // 切后台/离开页面暂停，回来 onShow 继续
  },

  onUnload() {
    room.detach(this);
    this.stopCountdown();
    this.clearDice();
    sound.bgmStop(); // 退局释放背景音乐实例
    if (this.windowResizeHandler && wx.offWindowResize) wx.offWindowResize(this.windowResizeHandler);
    this.windowResizeHandler = null;
    if (this.ceremonyExpiryTimer) clearTimeout(this.ceremonyExpiryTimer);
    if (this.errTimer) clearTimeout(this.errTimer);
    this.errTimer = null;
  },

  onResize() {
    // 横竖屏切换 / 分屏：重算安全区（刘海换边）与画布盒尺寸并重新量一次 rect
    this.computeSafeInsets();
    this.fitCanvas();
  },

  onNetStatus(s) {
    const text = net.describe(s);
    this.setData({ netText: text, netShown: !!text });
  },

  syncNet() {
    this.onNetStatus({
      state: net.getState(),
      inRoom: true,
      everConnected: net.hasConnected(),
      error: net.getLastError(),
      url: net.getUrl(),
    });
  },

  // ---------- 画布 ----------

  initCanvas() {
    if (this.table) {
      this.fitCanvas();
      return;
    }
    const sys = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const dpr = Math.min(2, Math.max(1, sys.pixelRatio || 1));
    // 取 canvas 节点（type="2d" 必须走 fields({node:true})）；
    // 矩形单独查一次 —— 与 fields 串联时返回值是否合并各版本不一致，分开更稳
    wx
      .createSelectorQuery()
      .select('#table')
      .fields({ node: true, size: true })
      .exec((res) => {
        const info = res && res[0];
        if (!info || !info.node) return;
        const canvas = info.node;
        this.canvasNode = canvas;
        this.table = new Table(canvas, dpr);
        // 画布不再承担出牌（手牌带已移除）：这里不再挂 onDiscard。
        // 出牌唯一入口是下方的 DOM 手牌条（onTrayTap → tryDiscard）。
        this.table.onRollDice = () => room.send({ t: 'rollDice' });
        this.table.onTagClick = (seat) => {
          if (seat !== this.view.mySeat) this.openEmotePicker(seat);
        };
        this.fitCanvas();
        if (this.view) this.table.render(this.view);
        // 牌面 CDN：拿到清单后预解码到画布，再重画布与手牌条（手牌条会换成 <image>）。
        // 失败/没配域名都不影响：矢量兜底已经在画了。
        this.loadTileArt(canvas);
        // UI 贴图 CDN（牌背/庄标/大数字/操作钮/结算艺术字）：同套路，无图回退矢量/文字
        this.loadUiArt(canvas);
      });
  },

  /** 拉 CDN 牌面（只做一次；失败就永远走矢量兜底） */
  loadTileArt(canvas) {
    if (this.tileArtAsked) return;
    this.tileArtAsked = true;
    tileimg.ensure((ok) => {
      if (!ok) return;
      // tileimg.preload 现在同时预解码 34 张立牌 + 4 张按座位平放牌图集（faces 子清单）
      tileimg.preload(canvas, (got) => {
        if (!got) return;
        if (this.view) this.table.render(this.view);
        if (this.trayV) this.syncHandTray(this.trayV, this.trayRitual);
      });
    });
  },

  /**
   * 拉 CDN UI 贴图（2026-10-21）：牌背/庄标/大数字走 canvas 预解码；
   * 操作钮与结算艺术字走 DOM `<image>`（urlOf 直接用地址，微信侧自行缓存）。
   * 到位后重画一次画布 + 重渲操作钮/结算艺术字；没到位各绘制点保持矢量/文字。
   */
  loadUiArt(canvas) {
    if (this.uiArtAsked) return;
    this.uiArtAsked = true;
    // 这个回调**可能来两次**：一次是本地缓存的清单（秒开），一次是网络清单
    // （可能带来缓存里没有的新键，比如 table / faceA..D）。所以这里必须是幂等的。
    uiart.ensure((ok) => {
      if (!ok) {
        // 降级（清单未就绪 / 线上服务端没带 public/ui）：桌面底色退回矢量桌的外层藏青，
        // 免得画布里的藏青桌周围是一圈绿绒（两套桌面拼在一起更难看）。
        this.setData({ feltUrl: '', feltNavy: true });
        return;
      }
      const feltUrl = uiart.urlOf('table');
      if (feltUrl && feltUrl !== this.data.feltUrl) this.setData({ feltUrl, feltNavy: false });
      uiart.preload(
        canvas,
        // 画布消费的位图：牌背（back / 暗杠 back_op / 左右家手牌 inhand_l·inhand_r）/庄标/大数字
        // + 操作动画字样（chi/peng/gang/hu —— 中心区动画用贴图，见 table.js drawActionFx）
        // + 桌面背景（faceA..faceD 平放牌图集 2026-10-23 移往牌面大类，由 tileimg.preload 预解码）
        ['back', 'back_op', 'inhand_l', 'inhand_r', 'banker', 'table', 'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'chi', 'peng', 'gang', 'hu'],
        () => {
          if (this.view) this.table.render(this.view);
          if (this.data.controls.length && this.view) this.renderControls(this.view);
          if (this.data.settleShown) this.refreshSettleArt();
        },
      );
    });
  },

  /** 结算艺术字就绪/重开面板时刷新（键在 onSettle 时定，见 settleArtKey） */
  refreshSettleArt() {
    const url = this.settleArtKey ? uiart.urlOf(this.settleArtKey) : '';
    if (url && url !== this.data.settleArt) this.setData({ settleArt: url });
  },

  /**
   * 布局预算：画布 2:1 定尺（高度吃满可用高度、宽度反算），**独占整行**。
   *
   * 2026-10-21 重排（用户报「牌面区域小、功能都挤在顶部」）：原来的三栏
   * （左记录 | 画布 | 右聊天）把画布宽度切走一块；现在记录/聊天改成**侧边按钮 +
   * 弹窗面板**（见 wxml 的 .rail / .side-panel），画布拿到整行宽。
   * 只在宽度方向扣掉 RAIL_RESERVE 给两条侧轨：
   *   · 手机横屏画布本来就被行高卡住（行宽有富余）→ 扣了不吃亏，轨落在空白区；
   *   · 宽窗口画布吃宽度 → 让出 84px，轨不遮牌河。
   * 顶部的原生导航栏也去掉了（game.json navigationStyle=custom，自绘 26px 信息条），
   * 行高 therefore 比原来多出 ~44px → 画布同比变大。
   *
   * `#game-main` 仍是唯一的测量基准：这个行容器的宽高只由父容器决定
   * （`.game-main{flex:1;min-height:0}`，子元素溢出不会撑大它）。侧轨与面板都是
   * absolute 浮层，不参与流内尺寸，所以不会出现「面板 → 画布变小 → 面板消失」的抖动。
   */
  /**
   * 手牌条度量（2026-10-21，见文件头 HAND_TILE_* 注释）。
   *
   * 牌条宽度 = **画布宽与「14 张排满」两者取大、再被行宽截断**：
   *   · 画布够宽（PC/平板）→ 手牌条与画布同宽，旧行为不变；
   *   · 画布被行高压窄（手机横屏）→ 放宽到 679px 让 14 张排满 —— 仍居中且不超过行宽，
   *     视觉上是「比牌桌更宽的满宽手牌带」（参考图同款）；
   *   · 行宽本身不够（iPad 分屏）→ 牌位按比例缩，最小到 HAND_MIN_W。
   * 牌位与字号永远同一个比例（k），绝不会再出现「rpx 尺寸配 px 字号」那种裁切。
   */
  handMetrics(rowW, canvasW) {
    const need = HAND_TILES * (HAND_TILE_W + HAND_TILE_GAP) + HAND_DRAWN_EXTRA;
    const trayW = Math.max(0, Math.min(rowW, Math.max(canvasW, need)));
    // -2 = 舍入余量：牌位取整后总宽可能比条宽多 1px，真机上会换来 1px 的滚动条
    const tw = Math.max(
      HAND_MIN_W,
      Math.min(HAND_TILE_W, Math.floor((trayW - HAND_TILE_GAP * HAND_TILES - HAND_DRAWN_EXTRA - 2) / HAND_TILES)),
    );
    const th = Math.round((tw * HAND_TILE_H) / HAND_TILE_W);
    const k = tw / HAND_TILE_W;
    return {
      handTrayW: trayW,
      handTileW: tw,
      handTileH: th,
      handFsRank: Math.round(25 * k),
      handFsSuit: Math.max(8, Math.round(12 * k)),
      handFsHonor: Math.round(27 * k),
      handMlDrawn: Math.max(3, Math.round(8 * k)),
    };
  },

  fitCanvas(depth) {
    const d = depth || 0;
    // 调用方常常刚 setData（聊天列显隐 / 手牌条显隐）——必须等渲染落地再量，
    // 否则拿到旧布局：画布尺寸按旧盒子算、rect 也量错 → 点牌错位。
    const run = () => {
      const q = wx.createSelectorQuery();
      q.select('#game-main').fields({ size: true });
      q.select('#canvas-wrap').boundingClientRect();
      q.exec((res) => {
        const main = boxOf(res && res[0]) || this.estimateWrap();
        if (!main) return;
        const W = main.width;
        const H = main.height;

        // 画布独占整行，宽度 = min(行宽 − 侧轨预留, 行高×2)，与 web 端同一 2:1 约定。
        // 侧轨是 absolute 浮层不占流宽，这里只是保证「画布吃宽时」左右各留 42px 给轨。
        const w = Math.max(240, Math.floor(Math.min(Math.max(240, W - RAIL_RESERVE), H * 2)));
        const h = Math.round(w / 2);

        const patch = {};

        // 手牌条（2026-10-21）：牌位/字号/条宽全部按实测行宽与画布宽推出，见 handMetrics。
        // 骰子期间画布尺寸是冻结的，手牌条也跟着用冻结值，免得条宽反复横跳。
        const hm = this.handMetrics(W, this.data.diceShown ? this.data.canvasW : w);
        if (hm.handTrayW !== this.data.handTrayW || hm.handTileW !== this.data.handTileW) {
          patch.handTrayW = hm.handTrayW;
          patch.handTileW = hm.handTileW;
          patch.handTileH = hm.handTileH;
          patch.handFsRank = hm.handFsRank;
          patch.handFsSuit = hm.handFsSuit;
          patch.handFsHonor = hm.handFsHonor;
          patch.handMlDrawn = hm.handMlDrawn;
        }
        // 画布尺寸在骰子期间**冻结**：骰子覆盖层下画布是隐藏态，若按「无侧栏」的宽高
        // 更新 canvasW/H，骰子一收画布会以先宽后窄经历一次缩放跳变（用户报的「缩放现象」）。
        // 冻结后骰子结束时的 canvasW/H 与骰前一致，clearDice 一次性还原侧栏即无缝回位。
        if (!this.data.diceShown) {
          if (w !== this.data.canvasW) patch.canvasW = w;
          if (h !== this.data.canvasH) patch.canvasH = h;
        }
        if (Object.keys(patch).length > 0) {
          this.setData(patch);
          // 布局变了要再量一轮：画布 rect（点击换算）。重跑自身会收敛 ——
          // 画布宽只由行宽/行高与 RAIL_RESERVE 决定，与当前布局无关，
          // 第二轮 patch 为空即自然终止。深度上限只是兜底，防止意外情况下卡死在
          // nextTick 循环里（每次都会 setData，界面上表现为持续闪烁）。
          if (d >= 3) {
            this.measureCanvasBox();
            return;
          }
          if (wx.nextTick) wx.nextTick(() => this.fitCanvas(d + 1));
          else setTimeout(() => this.fitCanvas(d + 1), 0);
          return;
        }
        this.measureCanvasBox();
      });
    };
    if (wx.nextTick) wx.nextTick(run);
    else setTimeout(run, 0);
  },

  /** 量画布的绝对位置（点牌换算依赖）。量到的 rect 与当前画布尺寸不符时判为陈旧帧，
   *  改用「容器左上角 + 居中偏移」推算 —— 后者与 fitCanvas 同源，不会滞后一帧。
   *  两条查询放在同一批里：画布 rect 给尺寸校验、容器 rect 给兜底推算的左上角。 */
  measureCanvasBox() {
    wx.createSelectorQuery()
      .select('#table')
      .boundingClientRect()
      .select('#canvas-wrap')
      .boundingClientRect()
      // 整屏桌面（.felt）铺的是**页面根节点**这一块，矩形要以它为准，见 applyTableFrame
      .select('.game')
      .boundingClientRect()
      .exec((r) => {
        const box = r && r[0];
        const wrap = (r && r[1]) || null;
        const page = (r && r[2]) || null;
        if (page && page.width > 0) {
          this.pageBox = { left: page.left, top: page.top, width: page.width, height: page.height };
        }
        const fresh =
          box &&
          box.width > 0 &&
          Math.abs(box.width - this.data.canvasW) <= 2 &&
          Math.abs(box.height - this.data.canvasH) <= 2;
        if (fresh) {
          this.canvasBox = { left: box.left, top: box.top, width: box.width, height: box.height };
          this.applyTableFrame();
          return;
        }
        // 兜底：canvas 在 canvas-wrap 里居中 → 容器左上角 + 居中偏移推算
        if (wrap && wrap.width > 0) {
          this.canvasBox = {
            left: wrap.left + (wrap.width - this.data.canvasW) / 2,
            // CSS 是 align-items:flex-end（画布贴操作区底边），竖向着底不居中
            top: wrap.top + (wrap.height - this.data.canvasH),
            width: this.data.canvasW,
            height: this.data.canvasH,
          };
          this.applyTableFrame();
          return;
        }
        if (box && box.width > 0) {
          this.canvasBox = { left: box.left, top: box.top, width: box.width, height: box.height };
          this.applyTableFrame();
        }
      });
  },

  /**
   * 把「整屏桌面」矩形换算成画布逻辑坐标，交给 Table 铺背景（见 data.feltUrl 的注释）。
   *
   * 画布逻辑 1280 宽按 `canvasBox.width` 等比映射到 CSS px，所以反向换算只要除以
   * 同一个比例：页面左上角 (0,0) 在逻辑坐标里就是 `-box.left / s`。
   * 矩形比画布大是常态，负坐标也合法（drawImage 会自己裁）。只有真的变了才重绘，
   * 否则每次 fitCanvas 都会多刷一帧。
   *
   * **页面矩形必须实测 `.game`，不能拿 `wx.getWindowInfo()` 凑**：两层的映射差 1px，
   * 画布边界就会现出一条缝（画布内是 canvas 按 frame 铺的、外面是 CSS 背景按页面盒铺的）。
   * windowHeight 在部分安卓机型与 `100vh` 不相等（状态栏算不算在内各家不同），
   * 所以只在量不到 `.game` 时才退回窗口尺寸。
   */
  applyTableFrame() {
    const box = this.canvasBox;
    if (!box || !box.width || !this.table) return;
    let vw = 0;
    let vh = 0;
    let vx = 0;
    let vy = 0;
    if (this.pageBox && this.pageBox.width > 0) {
      vx = this.pageBox.left;
      vy = this.pageBox.top;
      vw = this.pageBox.width;
      vh = this.pageBox.height;
    } else {
      let win = null;
      try {
        win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      } catch (e) {
        win = null;
      }
      vw = (win && win.windowWidth) || 0;
      vh = (win && win.windowHeight) || 0;
    }
    if (!vw || !vh) return;
    const s = box.width / 1280; // 画布逻辑宽 → CSS px 的缩放比
    const f = { x: (vx - box.left) / s, y: (vy - box.top) / s, w: vw / s, h: vh / s };
    const old = this.table.frame;
    if (
      old &&
      Math.abs(old.x - f.x) < 0.5 &&
      Math.abs(old.y - f.y) < 0.5 &&
      Math.abs(old.w - f.w) < 0.5 &&
      Math.abs(old.h - f.h) < 0.5
    ) {
      return;
    }
    this.table.frame = f;
    if (this.view) this.table.render(this.view);
  },

  /**
   * 两条几何通道都拿不到时的兜底估算：窗口尺寸 − 自绘顶栏 − 流内 chrome。
   * chrome 包含底部操作区（状态行 / 控件 / 手牌条）。
   *
   * 2026-10-21：game.json 改 `navigationStyle:custom` 后没有原生导航栏了，页面铺满
   * 全屏 → 第一项估成「顶部安全区 + 自绘顶栏高」（TOPBAR_H），而不是原来的
   * 「胶囊中心 × 2」。省下的 ~44px 全部归牌桌（这就是「放大中心牌面区域」的一部分）。
   */
  estimateWrap() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    if (!info || !info.windowWidth || !info.windowHeight) return null;
    // 顶栏高度随紧凑档切换（wxss：竖档 28px / ≤680px 档 24px），与 .g-top 实测一致
    const barH = info.windowHeight <= 680 ? 24 : TOPBAR_H;
    const topH = (this.data.safeT || 0) + barH + 4;
    // 紧凑档(≤680px)：状态 17 + 控件 30(可选) + 手牌 68 + 页内边距 ≈ 119
    const chrome = info.windowHeight <= 680 ? 119 : 60;
    const w = info.windowWidth - 16;
    const h = info.windowHeight - topH - chrome;
    if (!(w > 0) || !(h > 0)) return null;
    return { width: w, height: h };
  },

  onCanvasTap(e) {
    if (!this.table || !this.canvasBox) return;
    const d = e.detail || {};
    const x = typeof d.x === 'number' ? d.x : 0;
    const y = typeof d.y === 'number' ? d.y : 0;
    const box = this.canvasBox;
    if (!box.width || !box.height) return;
    const lx = ((x - box.left) * 1280) / box.width;
    const ly = ((y - box.top) * 640) / box.height;
    this.table.hitTest(lx, ly);
  },

  /**
   * 同步「是否有浮层打开」→ 牌桌画布可见性（modalOpen）。
   * 背景（2026-10-17 截图像素级取证）：<canvas type="2d"> 是原生组件，合成层级在
   * DOM 之上 —— position:fixed 的 .layer 既 Dim 不到它（牌桌在蒙层里照样发亮）、
   * 盖不住它（浮层卡片被画布压住左上角）、又会把点击穿透给它（浮层打开时牌桌
   * 仍可点牌出牌）。
   * 对策：浮层打开期间给画布切 display:none（WXML class 控制，**不用 wx:if** ——
   * 那会销毁 canvas 节点，this.table 实例与已绘牌面一起失效）。
   * 关闭时补一帧 render + 重量盒子：开浮层期间手牌条/结算恢复钮可能改过布局，
   * 且 display:none 期间量到的 rect 是 0（fitCanvas 内部有空盒保护不会写坏）。
   */
  syncModal() {
    const open = !!(
      this.data.diceShown ||
      this.data.emoteShown ||
      this.data.settleShown ||
      this.data.swapAskShown ||
      this.data.abortAskShown ||
      this.data.dissolvedShown
    );
    if (open === this.data.modalOpen) return;
    this.setData({ modalOpen: open });
    if (!open) {
      if (this.table && this.view) this.table.render(this.view);
      this.fitCanvas();
    }
  },

  // ---------- 对局渲染 ----------

  onGame(v) {
    this.renderGame(v);
  },

  wind(seat) {
    return seatWind(seat, this.view ? this.view.dealer : getApp().globalData.dealer || 0);
  },

  ritualPhase(v) {
    const c = v.ceremony;
    if (!c) return null;
    if (c.state === 'wait-roll') return 'wait';
    if (c.rollAt === null || c.until === null) return null;
    if (!this.ceremonyAnim || this.ceremonyAnim.key !== c.rollAt) {
      this.ceremonyAnim = { key: c.rollAt, start: Date.now(), dur: Math.max(300, c.until - c.rollAt) };
    }
    return Date.now() - this.ceremonyAnim.start < this.ceremonyAnim.dur ? 'roll' : null;
  },

  jingList(list) {
    const c = new Map();
    for (const t of list) c.set(t, (c.get(t) || 0) + 1);
    let out = '';
    c.forEach((n, t) => {
      out += `${out ? '/' : ''}${tileName(t)}${n > 1 ? `×${n}` : ''}`;
    });
    return out;
  },

  renderGame(v) {
    this.view = v;
    this.playActionSounds(v); // 他人动作音效（按 view.log 增量）
    // 发牌 / 摸牌音效：手牌张数增长即响（发牌是**逐张广播**的，靠 minGap 节流避免连响）
    const handCount = (v.myTiles || []).length;
    if (handCount > this.sndHandCount) sound.play('deal', { minGap: 250 });
    this.sndHandCount = handCount;
    const g = getApp().globalData;
    g.lastGameView = v;
    g.mySeat = v.mySeat;
    g.dealer = v.dealer || 0;

    const autoOn = v.auto
      ? v.auto[v.mySeat] === true
      : v.connected
        ? !v.connected[v.mySeat]
        : false;
    const rp = this.ritualPhase(v);
    let wallText = `牌墙 ${v.wallLeft}`;
    if (v.ceremony && v.ceremony.kind === 'deal' && rp === 'wait') wallText = '牌墙 136';
    else if (v.ceremony && v.ceremony.kind === 'deal' && rp === 'roll') wallText = '牌墙 …';

    let jingText = '';
    if (v.ceremony && v.ceremony.kind === 'jing' && v.ceremony.state === 'rolling') jingText = '';
    else if (v.gz) {
      if (v.gz.zheng.length > 0) {
        jingText = v.gz.revealed
          ? `正精 ${this.jingList(v.gz.zheng)} · 副精 ${this.jingList(v.gz.fu)}`
          : `正精 ${tileName(v.gz.zheng[0])}${v.gz.fu.length > 0 ? ` · 副精 ${tileName(v.gz.fu[0])}` : ''}（其余 10 张结算揭晓）`;
      }
    } else if (v.jingPi !== null && v.jingFu !== null) {
      jingText = `正精 ${tileName(v.jingPi)} · 副精 ${tileName(v.jingFu)}`;
    }

    const over = v.phase === 'over';
    // 操作区的「高度档位」：结算态整条手牌带（`.tray-stack`，紧凑档 ≈56px）不再渲染，
    // 腾出的高度必须归画布 —— 否则画布仍停在对局时的小尺寸（用户报「结算时麻将区域
    // 没放大」）。只在档位真正翻转的那一帧重量，同档位内的 state 广播不量
    // （SelectorQuery 有开销）。仪式中手牌虽也隐藏，但 `.tray-stack` 的 min-height
    // 仍在占位 → 高度不变 → 不需要重量，故档位只区分结算与否。
    const chromeKey = over ? 'o' : '-';
    const chromeChanged = this.chromeKey !== chromeKey;
    this.chromeKey = chromeKey;
    const patch = {
      code: v.code,
      variantLabel: v.variant ? variantName(v.variant) : '',
      wallText,
      jingText,
      autoShown: v.phase !== 'over',
      autoOn,
      dissolveGameShown: v.hostSeat === v.mySeat,
      controlsErrShown: false,
      overPhase: over,
    };
    // 新一局开始（或换玩法重开）时清掉「本局结算 ▲」——它只属于已结束的那一局
    if (!over && this.data.settleRestoreShown) patch.settleRestoreShown = false;
    this.setData(patch);

    // 结算浮层还开着但服务端已经开下一局 → 收掉浮层。
    // 2026-10-18 起「下一局」若全员就绪，服务端**只发 game 不再广播大厅态**
    // （避免 state→game 把客户端踹回大厅），所以收浮层必须靠 game 自己来。
    // 必须走 syncModal()：modalOpen 是六个浮层标志的取或，直接 setData 会漏掉
    // 画布的 .on-modal 摘除（syncModal 里还补 table.render + fitCanvas）。
    if (!over && this.data.settleShown) {
      this.setData({ settleShown: false });
      this.syncModal();
    }

    this.renderControls(v);
    this.renderLog(v);
    this.tickCountdown();
    this.syncHandTray(v, rp);
    if (this.table) this.table.render(v);
    if (chromeChanged) this.fitCanvas();

    if (v.ceremony && v.ceremony.state === 'rolling') {
      this.playDice(v);
      if (this.ceremonyExpiryKey !== v.ceremony.rollAt) {
        this.ceremonyExpiryKey = v.ceremony.rollAt === null ? -1 : v.ceremony.rollAt;
        if (this.ceremonyExpiryTimer) clearTimeout(this.ceremonyExpiryTimer);
        this.ceremonyExpiryTimer = setTimeout(() => {
          this.ceremonyExpiryTimer = null;
          if (this.view) this.renderGame(this.view);
        }, (this.ceremonyAnim ? this.ceremonyAnim.dur : 1000) + 80);
      }
    } else if (v.ceremony && v.ceremony.state === 'wait-roll') {
      this.clearDice();
    }
    // 注：不在这里每次量画布（SelectorQuery 有开销）—— 仅在 onShow / onResize /
    // 窗口尺寸变化 / 聊天列显隐 / 浮层开关 / **结算相位翻转** 时调用 fitCanvas()。
    // 对局中手牌带的显隐不改变 canvas-wrap 尺寸（.tray-stack 恒占位），故不重量；
    // 但结算态整条手牌带会退场，必须重量，否则画布仍停在对局时的小尺寸。
  },

  // ---------- 控件与状态 ----------

  relSeatName(seat) {
    const d = (((seat - this.view.mySeat) % 4) + 4) % 4;
    return ['自己', '下家', '对家', '上家'][d] || `${seat}号`;
  },

  seatNickname(seat) {
    const v = this.view;
    if (v && v.names && v.names[seat]) return v.names[seat];
    const s = getApp().globalData.lastState;
    const p = s && (s.players || []).find((x) => x.seat === seat);
    return (p && p.name) || this.wind(seat);
  },

  renderControls(v) {
    const controls = [];
    let status = '';
    if (v.phase === 'over') {
      // 结算态只留一行结果文案：右侧「本局结算 ▲」是按需出现的浮层入口，
      // 不再把「点最小化看牌 / 点下一局继续」写成文字（那串提示撑满整行且被省略号截断）。
      if (v.reveal && v.winner !== null) {
        const wn = (v.names && v.names[v.winner]) || this.wind(v.winner);
        status = `${this.wind(v.winner)}·${wn} 胡牌！${v.result || ''}`;
      } else if (v.reveal) {
        status = '本局结束 · 摊牌中';
      } else {
        status = `本局结束：${v.result || ''}`;
      }
      this.setData({ statusText: status, controls: [] });
      return;
    }

    const awaitingOthers = (v.awaiting || []).filter((s) => s !== v.mySeat).map((s) => this.wind(s));
    const awaitingAll = (v.awaiting || []).map((s) => this.wind(s));
    const rp = this.ritualPhase(v);

    if (rp === 'wait' && v.ceremony) {
      const c = v.ceremony;
      const label = c.kind === 'deal' ? '掷骰开局' : c.kind === 'jing' ? '掷骰翻精' : '掷骰补牌';
      status =
        c.seat === v.mySeat ? `点桌面正中的「${label}」按钮` : `等待${this.wind(c.seat)}家「${label}」…`;
      this.setData({ statusText: status, controls: [] });
      return;
    }
    if (rp === 'roll' && v.ceremony) {
      status =
        v.ceremony.kind === 'deal'
          ? '掷骰定方位 → 抓牌动画中…'
          : v.ceremony.kind === 'jing'
            ? '翻精掷骰 → 定位正精中…'
            : '掷骰定位补牌中…';
      this.setData({ statusText: status, controls: [] });
      return;
    }

    if (v.claims) {
      status = awaitingOthers.length
        ? `可以操作！还等：${awaitingOthers.join('、')}`
        : '轮到你选择 — 碰 / 杠 / 吃 / 胡，或点「过」';
      for (const opt of v.claims.options) {
        if (opt.kind === 'chi') {
          for (const choice of opt.chiChoices || []) {
            // art = CDN 操作钮位图（吃/碰/杠/胡/过）；cap = 图下缘小注（牌名/牌型）
            const cap = choice.map((t) => tileName(t)).join(' ');
            // 吃是唯一会多组出现的动作（顺子最多 3 种组合）：同屏 7 个钮时由
            // ctrlCompact 统一缩一号（不能只缩吃钮 —— 那会让同屏图标大小不一）。
            controls.push({
              text: `吃 ${cap}`,
              cap,
              act: { t: 'claim', kind: 'chi', chiTiles: choice },
              art: uiart.urlOf('chi'),
            });
          }
        } else if (opt.kind === 'peng') {
          // art = CDN 操作钮位图（碰/杠/胡/过；未就绪为空串 → wxml 回落文字钮）；
          // cap = 图上小注（牌名/牌型；与动作字重复的部分不显示）
          const t = tileName(opt.tile);
          controls.push({ text: `碰 ${t}`, cap: t, act: { t: 'claim', kind: 'peng' }, art: uiart.urlOf('peng') });
        } else if (opt.kind === 'hu') {
          const label = opt.label || tileName(opt.tile);
          controls.push({
            text: opt.label ? `胡·${opt.label}` : `胡 ${tileName(opt.tile)}`,
            cap: label,
            act: { t: 'claim', kind: 'hu' },
            art: uiart.urlOf('hu'),
          });
        } else {
          const t = tileName(opt.tile);
          controls.push({ text: `杠 ${t}`, cap: t, act: { t: 'claim', kind: 'gang' }, art: uiart.urlOf('gang') });
        }
      }
      controls.push({ text: '过', cap: '', act: { t: 'pass' }, ghost: true, art: uiart.urlOf('guo') });
      // 同屏 ≥7 个钮（吃 3 组 + 碰/杠/胡 + 过）时全体缩一号，否则 7×108=756rpx > 750rpx 必换行
      this.setData({ statusText: status, controls, ctrlCompact: controls.length >= 7 });
      return;
    }

    for (const sg of v.selfGangs || []) {
      const cap = `${sg.kind === 'angang' ? '暗杠' : '补杠'} ${tileName(sg.tile)}`;
      controls.push({
        text: cap,
        cap,
        act: { t: 'selfGang', kind: sg.kind, tile: sg.tile },
        art: uiart.urlOf('gang'),
      });
    }
    for (const dt of v.declareOptions || []) {
      const cap = `展示 ${tileName(dt)}`;
      controls.push({ text: cap, cap, act: { t: 'declareKong', tile: dt }, art: uiart.urlOf('gang') });
    }
    if (v.canZimo) {
      const cap = v.zimoLabel ? `自摸·${v.zimoLabel}` : '自摸';
      controls.push({ text: cap, cap, act: { t: 'zimo' }, art: uiart.urlOf('hu') });
    }

    if (v.canZimo) status = v.zimoLabel ? `可以自摸（${v.zimoLabel}）！` : '可以自摸！';
    else if (v.turn === v.mySeat)
      status =
        (v.mustDiscard || []).length > 0
          ? `必须先打出 ${v.mustDiscard.map((t) => tileName(t)).join('、')}（他人已展示）`
          : '轮到你了 — 点击手牌打出';
    else if (v.claimWindow)
      status =
        (awaitingAll.length ? `等待 ${awaitingAll.join('、')} 应答…` : '等待响应…') +
        (v.skipRon ? '（你已过水，暂不能点炮胡）' : '');
    else status = `等待${this.wind(v.turn)}家行动…`;

    // 同屏 ≥7 个钮（吃 3 组 + 碰/杠/胡 + 过）时全体缩一号，否则 7×108=756rpx > 750rpx 必换行

    this.setData({ statusText: status, controls, ctrlCompact: controls.length >= 7 });
  },

  /**
   * 局内音效：按动作日志的新条目播（2026-10-23）。
   * 数据源与中心操作动画一致（`view.log`，seq 递增）—— 同帧到达的多个动作按 seq 依次播，
   * 只播**别人**的动作（自己的操作在本地交互时已即时播过，避免双响）。
   * 首次只对齐 seq、不播历史（进房不该听见旧动作的声音）。
   */
  playActionSounds(v) {
    const log = v && v.log;
    if (!Array.isArray(log) || !log.length) return;
    if (!this.sndSeenSeq) {
      this.sndSeenSeq = Number(log[log.length - 1].seq) || 0;
      return;
    }
    const fresh = [];
    for (let i = log.length - 1; i >= 0; i--) {
      const seq = Number(log[i] && log[i].seq) || 0;
      if (seq <= this.sndSeenSeq) break;
      fresh.push(log[i]);
    }
    if (!fresh.length) return;
    fresh.reverse();
    this.sndSeenSeq = Number(fresh[fresh.length - 1].seq) || this.sndSeenSeq;
    const mySeat = v.mySeat;
    for (const a of fresh) {
      if (a.seat === mySeat) continue;
      const key = SOUND_BY_ACTION[a.kind];
      if (key) sound.play(key);
    }
  },

  onControl(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const item = this.data.controls[idx];
    if (!item || item.disabled) return;
    sound.unlock(); // 用户手势里补一次解锁（清单晚到时下次操作仍有机会）
    room.send(item.act);
    this.lockControls();
    // 音效：自己执行的动作即时反馈（他人动作由 playActionSounds 按日志播，避免双响）
    const k = item.act && item.act.kind;
    if (k === 'peng') sound.play('peng');
    else if (k === 'gang' || k === 'angang' || k === 'bugang') sound.play('gang');
    else if (k === 'hu') sound.play('hu');
    else if (k === 'chi') sound.play('chi');
  },

  lockControls() {
    const controls = this.data.controls.map((c) => Object.assign({}, c, { disabled: true }));
    this.setData({ controls });
  },

  /** 出牌唯一出口（DOM 手牌条），报杠两条拦截先于发信 */
  tryDiscard(tile) {
    const v = this.view;
    if (v) {
      if ((v.declared || []).some((d) => d.seat === v.mySeat && d.tile === tile)) {
        ui.showToast(this, `已展示的 ${tileName(tile)} 要等第 4 张，不能打`);
        return;
      }
      if ((v.mustDiscard || []).length > 0 && v.mustDiscard.indexOf(tile) < 0) {
        ui.showToast(this, `必须先打出 ${v.mustDiscard.map((t) => tileName(t)).join('、')}`);
        return;
      }
    }
    sound.unlock(); // 用户手势里补一次解锁
    sound.play('discard'); // 本地即时反馈（自己出牌；他人的由日志播）
    room.send({ t: 'discard', tile });
  },

  /** 手牌条 = **唯一的出牌入口**（画布内的常驻手牌带已于 2026-10-17 移除）。
   *  它在画布下方流内，手牌显隐不改变 canvas-wrap 尺寸，因此不需要重量画布盒。
   *  注意：**吃碰杠胡的选择期（v.claims）也要显示手牌** —— 不看手牌没法判断该碰还是该胡；
   *  此时 trayActive=false（不能出牌），提示与选项由半透明遮罩盖在手牌上（见 game.wxml）。 */
  /** 记住这一帧的参数，供 CDN 贴图到位后重跑（见 loadTileArt） */
  syncHandTray(v, ritual) {
    this.trayV = v;
    this.trayRitual = ritual === undefined ? null : ritual;
    if (ritual !== null || v.phase === 'over') {
      // 结算/摊牌：手牌带整条退场（WXML 里 overPhase 会直接不渲染 .tray-stack），
      // 腾出的高度归画布 —— 见 renderGame 的 chromeKey → fitCanvas()
      this.setData({ trayShown: false, trayActive: false, tray: [] });
      return;
    }
    let hand = v.myTiles || [];
    if (v.drawn !== null) {
      const i = hand.indexOf(v.drawn);
      if (i >= 0) hand = hand.slice(0, i).concat(hand.slice(i + 1));
    }
    if (hand.length === 0 && v.drawn === null) {
      this.setData({ trayShown: false, tray: [] });
      return;
    }
    const canDiscard = v.phase === 'playing' && v.turn === v.mySeat && !v.claimWindow;
    const frozen = (v.declared || []).filter((d) => d.seat === v.mySeat).map((d) => d.tile);
    const must = v.mustDiscard || [];
    const pi = v.jingPi;
    const fu = v.jingFu;
    // 手牌里同牌面可能有多张，wx:key 需要唯一 → 用「牌面-序号」合成
    // 牌面是**矢量文字**（2026-10-18 起不再有 PNG 贴图，官方体检要求图片合计 ≤ 200KB），
    // 这里按花色给出要渲染的两个字：主字（数字/风字/箭字）+ 花色字。
    const face = (t) => {
      const suit = suitOf(t);
      if (suit === 'z') return { honor: true, rank: '', suitChar: tileName(t), tone: honorTone(t) };
      return { honor: false, rank: String(rankOf(t)), suitChar: SUIT_TEXT[suit], tone: suit };
    };
    const tray = hand.map((t, i) => ({
      key: `${t}-${i}`,
      tile: t,
      name: tileName(t),
      ...face(t),
      cdn: tileimg.urlOf(t),
      pi: t === pi,
      fu: t === fu,
      frozen: frozen.indexOf(t) >= 0,
      must: must.indexOf(t) >= 0,
    }));
    if (v.drawn !== null) {
      tray.push({
        key: `${v.drawn}-drawn`,
        tile: v.drawn,
        name: tileName(v.drawn),
        ...face(v.drawn),
        cdn: tileimg.urlOf(v.drawn),
        pi: v.drawn === pi,
        fu: v.drawn === fu,
        frozen: frozen.indexOf(v.drawn) >= 0,
        must: must.indexOf(v.drawn) >= 0,
        drawn: true,
      });
    }
    this.setData({ trayShown: true, trayActive: canDiscard, tray });
  },

  /**
   * CDN 图片加载失败（域名没登记 / 网络不通 / 单张 404）→ 该张回退矢量牌面。
   * 只清这一张的 `cdn`，其它张继续用图片；不报错、不影响出牌。
   */
  onTileImgError(e) {
    const tile = Number(e.currentTarget.dataset.tile);
    const idx = this.data.tray.findIndex((x) => x.tile === tile);
    if (idx < 0) return;
    this.setData({ [`tray[${idx}].cdn`]: '' });
  },

  onTrayTap(e) {
    sound.unlock(); // 首个用户交互：解锁 iOS 音频会话（否则无交互触发的音效不响）
    sound.play('click', { minGap: 90 }); // 点牌反馈
    const tile = Number(e.currentTarget.dataset.tile);
    if (!this.data.trayActive) return;
    const item = this.data.tray.find((x) => x.tile === tile);
    if (item && item.frozen) return;
    this.tryDiscard(tile);
  },

  // ---------- 倒计时 ----------

  startCountdown() {
    if (this.countdownTimer) return;
    this.countdownTimer = setInterval(() => this.tickCountdown(), COUNTDOWN_MS);
  },

  stopCountdown() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = null;
  },

  tickCountdown() {
    const v = this.view;
    if (v && v.phase === 'playing' && v.windowDeadline) {
      const left = Math.max(0, v.windowDeadline - Date.now());
      // 短标签：倒计时并进状态行右侧（原来绝对定位在画布顶部，会被原生 canvas 盖住）
      const text = `⏱ ${(left / 1000).toFixed(1)}s`;
      if (text !== this.lastCountdownText) {
        this.lastCountdownText = text;
        this.setData({ countdownText: text, countdownShown: true });
      }
    } else if (this.lastCountdownText !== '') {
      this.lastCountdownText = '';
      this.setData({ countdownShown: false, countdownText: '' });
    }
  },

  // ---------- 掷骰覆盖层（对局内仪式） ----------

  diceResultText(v) {
    const c = v.ceremony;
    if (!c || !c.dice) return '';
    if (c.kind === 'deal') {
      const sum = c.dice[0] + c.dice[1];
      const small = Math.min(c.dice[0], c.dice[1]);
      const pos = ((sum - 1) % 4) + 1;
      const seat = (v.dealer + sum - 1) % 4;
      return `点数和 ${sum} → 庄家起逆时针第 ${pos} 位（${this.wind(seat)}门前） · 小点 ${small} → 空 ${small} 列、第 ${small + 1} 列起牌`;
    }
    const sum = c.dice[0] + c.dice[1];
    if (c.kind === 'jing') return `点数和 ${sum} → 摸牌处逆时针第 ${sum} 列 · 上层翻开 = 正精`;
    return `点数和 ${sum} → 摸牌处逆时针第 ${sum} 列 · 上层取牌（无则取下层）`;
  },

  playDice(v) {
    const c = v.ceremony;
    if (!c || c.state !== 'rolling' || c.rollAt === null || c.until === null) return;
    const dur = Math.max(400, c.until - c.rollAt);
    const tumbleMs = Math.min(c.kind === 'gang' ? 1500 : 2200, Math.floor(dur * 0.5));
    if (this.diceKey === c.rollAt) return;
    this.diceKey = c.rollAt;
    this.stopDiceTimers();
    // 弹窗面板在骰子阶段让位（骰子覆盖层盖满全页，面板叠在上面只是多一层无关元素）
    if (this.data.logOpen || this.data.chatOpen) this.setData({ logOpen: false, chatOpen: false, panelOpen: false });
    const msg = c.kind === 'deal' ? '庄家掷骰…' : c.kind === 'jing' ? '翻精掷骰…' : '杠后掷骰…';
    const dice = c.dice || [1, 1];
    // 骰子改用九宫格点子（utils/dice.js），翻滚期每 100ms 换一次随机面
    this.setData({
      diceShown: true,
      modalOpen: true,
      diceMsg: msg,
      dice: diceUtil.pair(diceUtil.randFace(), diceUtil.randFace(), true, false),
    });
    this.fitCanvas(); // 侧栏让位（记录 / 聊天在骰子阶段隐藏），结束后 clearDice 还原
    this.diceScramble = setInterval(() => {
      this.setData({ dice: diceUtil.pair(diceUtil.randFace(), diceUtil.randFace(), true, false) });
    }, 100);
    this.diceLand = setTimeout(() => {
      if (this.diceScramble) {
        clearInterval(this.diceScramble);
        this.diceScramble = null;
      }
      // 定格：真实点数 + 回弹动画（.die.land）+ 点数含义文案
      this.setData({
        diceMsg: this.diceResultText(v),
        dice: diceUtil.pair(dice[0], dice[1], false, true),
      });
    }, tumbleMs);
    this.diceHide = setTimeout(() => this.clearDice(), dur + 550);
  },

  /** 只停定时器（playDice 重入时用，不动 diceShown / 侧栏状态） */
  stopDiceTimers() {
    if (this.diceScramble) clearInterval(this.diceScramble);
    if (this.diceLand) clearTimeout(this.diceLand);
    if (this.diceHide) clearTimeout(this.diceHide);
    this.diceScramble = this.diceLand = this.diceHide = null;
  },

  /**
   * 骰子阶段结束：还原 diceShown，再显示画布。
   * fitCanvas 在骰子期间冻结 canvasW/H，clearDice 只翻 diceShown → 画布重新显示时
   * 就是最终尺寸，无缩放跳变（2026-10-18 用户报「缩放现象」的修法）。
   */
  clearDice() {
    this.stopDiceTimers();
    if (!this.data.diceShown) return;
    this.setData({ diceShown: false });
    this.syncModal();
    this.fitCanvas(); // 复核一次布局 + 重量画布点击盒（量到与冻结值一致则无事发生）
  },

  // ---------- 侧边面板（记录 / 聊天） ----------

  /**
   * 记录 / 聊天面板（2026-10-21 布局重排）：左右侧边按钮触发，弹窗盖在**牌桌区**
   * （`.game-main` 内 absolute，不遮底部手牌条）。
   *
   * 为什么要单独一套开关而不用 modalOpen：模态浮层（骰子/结算/解散）会把底部
   * 操作区一起藏掉（`board-overlay wx:if="{{!modalOpen}}"`）；而看记录/聊天时牌局
   * 还在走，手牌条必须留着。所以这里只翻 `panelOpen` —— 它只做一件事：
   * 把原生 canvas 切 display:none（合成层级在 DOM 之上，不藏面板会被牌桌盖住）。
   */
  syncPanels() {
    const open = !!(this.data.logOpen || this.data.chatOpen);
    if (open !== this.data.panelOpen) this.setData({ panelOpen: open });
    if (!open) this.fitCanvas(); // 面板收起 → 画布重新显示，重量一次 rect
  },

  onToggleLog() {
    const open = !this.data.logOpen;
    if (open && this.view) this.renderLog(this.view); // 打开时补齐最新记录
    this.setData({ logOpen: open, chatOpen: false, quickShown: false, emojiShown: false });
    this.syncPanels();
  },

  onToggleChat() {
    const open = !this.data.chatOpen;
    const patch = { chatOpen: open, logOpen: false };
    if (open) {
      patch.chatUnread = 0;
      patch.quickShown = false;
      patch.emojiShown = false;
      getApp().globalData.chatUnread = 0;
    }
    this.setData(patch);
    this.syncPanels();
  },

  // ---------- 聊天 ----------

  onChatInput(e) {
    this.setData({ chatInput: e.detail.value });
  },

  onSendChat() {
    const text = String(this.data.chatInput || '').trim();
    if (!text) return;
    room.send({ t: 'chat', text });
    this.setData({ chatInput: '' });
  },

  onTogglePop(e) {
    const which = e.currentTarget.dataset.pop;
    this.setData(
      which === 'quick'
        ? { quickShown: !this.data.quickShown, emojiShown: false }
        : { emojiShown: !this.data.emojiShown, quickShown: false },
    );
  },

  onQuickTap(e) {
    const text = e.currentTarget.dataset.text;
    room.send({ t: 'chat', text });
    this.setData({ quickShown: false });
  },

  onEmojiTap(e) {
    const text = e.currentTarget.dataset.text;
    room.send({ t: 'chat', text });
    this.setData({ emojiShown: false });
  },

  onChat(msg) {
    const g = getApp().globalData;
    const list = this.data.chatMsgs.concat([{ seat: msg.seat, name: msg.name, text: msg.text, self: msg.seat === g.mySeat }]);
    if (list.length > CHAT_MAX) list.shift();
    const patch = { chatMsgs: list };
    // 未读只在「聊天面板没打开」时累加（打开时就在眼前，无需红点）
    if (msg.seat !== g.mySeat && !this.data.chatOpen) {
      const unread = Math.min((this.data.chatUnread || 0) + 1, 999);
      patch.chatUnread = unread;
      g.chatUnread = unread;
    }
    this.setData(patch);
    if (this.table) this.table.pushBubble(msg.seat, msg.text, 'text');
  },

  renderLog(v) {
    const names = v.names || [];
    // 服务端 actionLog 保留 500 条（按时间正序）。面板里也只渲染尾部 —— 全量塞进
    // 一个 scroll-view 会在每次 state 广播时重排上万像素，长局明显掉帧。
    const src = (v.log || []).slice(-LOG_ROWS_MAX);
    const rows = src.map((entry) => ({
      seq: entry.seq,
      seatName: entry.seat >= 0 ? names[entry.seat] || `座位${entry.seat + 1}` : '系统',
      action: LOG_ACTION_LABEL[entry.kind] || entry.kind,
      actionClass: entry.kind,
      tiles: (entry.tiles || []).map((t) => tileName(t)).join(''),
      note: entry.note || '',
    }));
    // 面板跟随最新一步：scroll-top 每次加一个大数，超出最大滚动量时会自动夹到底部
    const key = rows.length ? String(rows[rows.length - 1].seq) : '';
    if (key === this.logKey) return;
    this.logKey = key;
    this.setData({ logRows: rows, logScrollTop: this.data.logScrollTop + 2000 });
  },

  // ---------- 互动表情 ----------

  openEmotePicker(preselect) {
    const v = this.view;
    if (!v) return;
    const mySeat = v.mySeat;
    const targets = [];
    for (let seat = 0; seat < 4; seat++) {
      if (seat === mySeat) continue;
      targets.push({
        seat,
        label: `${this.relSeatName(seat)} ${this.wind(seat)}·${this.seatNickname(seat)}`,
        active: seat === preselect,
      });
    }
    this.emoteTargetSeat = preselect !== undefined && preselect !== mySeat ? preselect : null;
    const groups = [];
    for (const g of THROW_EMOJI_TONES) {
      const list = THROW_EMOJI.filter((e) => e.tone === g.tone);
      if (list.length === 0) continue;
      groups.push({
        label: g.label,
        tone: g.tone,
        cells: list.map((e) => ({ id: e.id, icon: e.icon, name: e.name })),
      });
    }
    this.setData({ emoteShown: true, modalOpen: true, emoteTargets: targets, emoteGroups: groups });
  },

  onEmoteTarget(e) {
    const seat = Number(e.currentTarget.dataset.seat);
    this.emoteTargetSeat = seat;
    const targets = (this.data.emoteTargets || []).map((t) => Object.assign({}, t, { active: t.seat === seat }));
    this.setData({ emoteTargets: targets });
  },

  onEmoteCell(e) {
    const id = e.currentTarget.dataset.id;
    if (this.emoteTargetSeat === null || this.emoteTargetSeat === undefined) return;
    room.send({ t: 'emote', target: this.emoteTargetSeat, emote: id });
    this.setData({ emoteShown: false });
    this.syncModal();
  },

  onEmoteOpen() {
    this.openEmotePicker();
  },

  onEmoteClose() {
    this.setData({ emoteShown: false });
    this.emoteTargetSeat = null;
    this.syncModal();
  },

  onEmote(msg) {
    const fx = throwEmojiOf(msg.emote);
    if (!fx) return;
    if (this.table) {
      this.table.pushEmote(msg.from, msg.target, fx.icon);
      this.table.pushBubble(msg.target, `${fx.icon} ${fx.name}`, 'emote');
    }
    const g = getApp().globalData;
    const list = this.data.chatMsgs.concat([
      {
        seat: msg.from,
        name: this.seatNickname(msg.from),
        text: `向${this.relSeatName(msg.target)}扔了 ${fx.icon}${fx.name}`,
        self: msg.from === g.mySeat,
      },
    ]);
    if (list.length > CHAT_MAX) list.shift();
    this.setData({ chatMsgs: list });
  },

  // ---------- 结算 ----------

  onSettle(m) {
    this.lastSettleMsg = m;
    let rows = [];
    let head = [];
    if (m.gz) {
      head = ['玩家', '正精', '副精', '精分', '冲关', '胡牌分', '杠分', '本盘总分', '本局得分', '累计'];
      const nameOf = (seat) => {
        const r = (m.rows || []).find((x) => x.seat === seat);
        return r ? r.name : String(seat);
      };
      rows = (m.gz.rows || []).map((r) => {
        const total = (m.totals || []).find((t) => t.seat === r.seat);
        const tv = total ? total.value : 0;
        const cgs = [];
        for (const c of r.jingCombos || []) {
          if (c.score > 0 && c.chongguan > 1 && cgs.indexOf(c.chongguan) < 0) cgs.push(c.chongguan);
        }
        const jingDesc =
          r.jingFinal === 0 ? '—' : `${r.jingFinal}${(r.jingCombos || []).some((c) => c.jingba) ? ' ·精霸' : ''}`;
        return {
          me: r.seat === (this.view ? this.view.mySeat : -1),
          cells: [
            { text: nameOf(r.seat) },
            { text: String(r.pi) },
            { text: String(r.fu) },
            { text: jingDesc },
            { text: cgs.length > 0 ? cgs.map((x) => `×${x}`).join('') : '—' },
            { text: r.pattern > 0 ? String(r.pattern) : '—' },
            { text: r.gang > 0 ? String(r.gang) : '—' },
            { text: String(r.total) },
            { text: ui.fmtDelta(r.delta), cls: 'total-col ' + (r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : '') },
            { text: ui.fmtDelta(tv), cls: 'total-col ' + (tv > 0 ? 'pos' : tv < 0 ? 'neg' : '') },
          ],
        };
      });
    } else {
      head = ['玩家', '正精', '副精', '胡进', '胡出', '精进', '精出', '本局得分', '累计'];
      rows = (m.rows || []).map((r) => {
        const total = (m.totals || []).find((t) => t.seat === r.seat);
        const tv = total ? total.value : 0;
        return {
          me: r.seat === (this.view ? this.view.mySeat : -1),
          cells: [
            { text: r.name },
            { text: String(r.pi) },
            { text: String(r.fu) },
            { text: ui.fmtIn(r.patternIn), cls: r.patternIn > 0 ? 'pos' : '' },
            { text: ui.fmtOut(r.patternOut), cls: r.patternOut > 0 ? 'neg' : '' },
            { text: ui.fmtIn(r.jingIn), cls: r.jingIn > 0 ? 'pos' : '' },
            { text: ui.fmtOut(r.jingOut), cls: r.jingOut > 0 ? 'neg' : '' },
            { text: ui.fmtDelta(r.delta), cls: 'total-col ' + (r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : '') },
            { text: ui.fmtDelta(tv), cls: 'total-col ' + (tv > 0 ? 'pos' : tv < 0 ? 'neg' : '') },
          ],
        };
      });
    }
    const totalsText = (m.totals || []).map((t) => `${t.name} ${t.value >= 0 ? '+' : ''}${t.value}`).join('　');
    // 结算艺术字键（win/lost/draw，CDN；未就绪 setData 里就是空串 → 面板只显示文字标题）
    // **以本局赢家**判定，而不是 v.phase === 'over'：单局结算时 phase 还是 'playing'
    // （只有整盘结束才是 over）→ 旧判据导致单局结算面板顶部**从来看不到结果图标**。
    const v = this.view;
    const mySeat = v ? v.mySeat : -1;
    let artKey = '';
    const win = m.winner !== undefined ? m.winner : m.gz ? m.gz.winner : undefined;
    if (win === null) {
      artKey = 'draw'; // 流局（赣州 §7.5）
    } else if (win !== undefined) {
      artKey = win === mySeat ? 'win' : 'lost';
    } else if (v && v.phase === 'over') {
      // 老服务端兜底：settle 消息没有 winner 字段
      artKey = v.winner === null || v.winner === undefined ? 'draw' : v.winner === mySeat ? 'win' : 'lost';
    }
    this.settleArtKey = artKey;
    this.setData({
      settleShown: true,
      modalOpen: true,
      settleTitle: m.title,
      settleArt: artKey ? uiart.urlOf(artKey) : '',
      settleHead: head,
      settleRows: rows,
      settleNotes: m.notes || [],
      settleTotals: `累计子：${totalsText}`,
      settleRestoreShown: false,
      settleNextDisabled: false,
    });
  },

  onSettleHide() {
    // 恢复钮已挪进状态行（同一行，高度不变），所以这里不会改操作区总高；
    // syncModal(false) 内部会补 table.render + fitCanvas，无需再单独重量。
    this.setData({ settleShown: false, settleRestoreShown: true });
    this.syncModal();
  },

  onSettleRestore() {
    this.setData({ settleShown: true, modalOpen: true, settleRestoreShown: false });
    this.fitCanvas();
  },

  onSettleNext() {
    this.setData({ settleNextDisabled: true });
    room.send({ t: 'nextRound' });
  },

  onVariant(msg) {
    if (msg.totals && this.view) {
      const v = Object.assign({}, this.view, { totals: msg.totals });
      this.view = v;
      if (this.table) this.table.render(v);
    }
    ui.showToast(this, `玩法已切换为「${variantName(msg.variant)}」${msg.cleared ? '，积分已清零' : ''}`);
  },

  // ---------- 其它 ----------

  onEvent(msg) {
    ui.showToast(this, msg.text, 2500);
  },

  /**
   * 错误提示：**借用状态行显示**（占位替换状态文案），不再单独占一行。
   * 原先是一个独立的 `.g-error` 行，一出现就把操作区顶高一行 → 画布重排；
   * 线上旧服务端每 10s 回一条「未知消息」时，画面就每 10s 抖一次。
   * 4s 后自动让位给正常的回合提示（否则一条错误会长期盖住「轮到你了」）。
   */
  onError(reason) {
    if (this.errTimer) clearTimeout(this.errTimer);
    this.setData({ controlsErrText: reason, controlsErrShown: true });
    this.errTimer = setTimeout(() => {
      this.errTimer = null;
      if (!this.data.controlsErrShown) return;
      this.setData({ controlsErrShown: false });
      if (this.view) this.renderControls(this.view);
    }, 4000);
  },

  onSwapAsk(msg) {
    this.setData({ swapAskShown: true, modalOpen: true, swapAskText: `${this.wind(msg.from)}家「${msg.fromName}」想与你交换座位，是否同意？` });
  },

  onSwapRespond(e) {
    const accept = e.currentTarget.dataset.accept === '1';
    this.setData({ swapAskShown: false });
    this.syncModal();
    room.send({ t: 'swapRespond', accept });
  },

  onDissolved(msg) {
    this.setData({
      dissolvedShown: true,
      modalOpen: true,
      dissolvedTitle: msg.title,
      dissolvedRows: (msg.rows || []).map((r) => ({ name: r.name, value: r.value })),
    });
  },

  onDissolvedOk() {
    this.setData({ dissolvedShown: false });
    this.syncModal();
    room.resetChat();
    net.closeSocket();
    wx.reLaunch({ url: '/pages/home/home' });
  },

  onAuto() {
    if (!net.isOpen()) return;
    room.send({ t: 'setAuto', auto: !this.data.autoOn });
  },

  /**
   * 背景音乐开关（2026-10-23）：右轨 🎵 钮，**与音效总开关独立**（音效含点击/出牌/碰杠胡）。
   * 关 → 立即暂停，保留实例与进度；开 → 立即续播，不重下 1MB 音频。
   * iOS 首次播放必须由用户手势触发 —— **这次点击本身就是手势**，所以开启前先
   * unlock()，否则要等下一次出牌才出声（表现为「开关打开了却没反应」）。
   */
  onToggleBgm() {
    const next = !sound.isBgmEnabled();
    if (next) sound.unlock(); // 手势内解锁音频会话；清单没就绪会在下次手势自动重试
    const on = sound.setBgmEnabled(next);
    this.setData({ bgmOn: on });
    ui.showToast(this, on ? '背景音乐已开启' : '背景音乐已关闭', 1200);
  },

  /**
   * 解散对局：开**页内确认浮层**，不用 wx.showModal。
   * 原因（2026-10-17 用户报「无法解散对局」）：服务端 abort 链路已用 e2e 跑通
   * （abort → event + state(phase=lobby) → 客户端回大厅），按钮也确认已渲染且未禁用；
   * 断点只剩原生模态框 `wx.showModal` 这一环（原生弹窗在该环境下无反应、回调不达，
   * 表现就是点了毫无反应且无任何提示）。页内浮层与换位/解散结算同构，可见、可测。
   */
  onAbort() {
    this.setData({ abortAskShown: true });
    this.syncModal();
  },

  /**
   * 解散对局 = **强制结束本局、回到准备界面（大厅）**，房间保留、可重新开局。
   * 与服务端 `abort` 语义一致（web 端 confirmAbort 同此），**不是**解散房间。
   * 客户端不需要额外动作：服务端收到 abort 后会广播 lobby state，
   * room.js 的 `case 'state'` 负责把对局页 redirectTo 到大厅。
   */
  onAbortConfirm(e) {
    const accept = e.currentTarget.dataset.accept === '1';
    this.setData({ abortAskShown: false });
    this.syncModal();
    if (!accept) return;
    if (!net.isOpen()) {
      ui.showToast(this, '连接已断开，无法解散对局：请返回首页重连', 3000);
      return;
    }
    room.send({ t: 'abort' });
    ui.showToast(this, '本局已解散，正在返回房间…', 1500);
  },

  onShareAppMessage() {
    return { title: `麻将 · 房间 ${this.data.code}`, path: `/pages/home/home?room=${this.data.code}` };
  },
});
