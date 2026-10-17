/**
 * 对局页：Canvas 牌桌 + HUD + 控件 + 手牌操作条 + 聊天 / 记录 + 结算面板。
 *
 * 与 web 端的对应关系（逻辑不变，仅替换平台入口）：
 *   · `table.render(v)`        → utils/table.js（Canvas 2D，逻辑坐标恒 1280×640）
 *   · 画布尺寸                 → fitCanvas()：取 min(可用宽, 行高×2)，与 web 端同一约定，
 *                                保证画布盒 = 内容盒（小程序若非等比拉伸同样会让点牌错位）；
 *                                画布之外富余的宽度分给左右两栏（左记录 / 右聊天）
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
const diceUtil = require('../../utils/dice.js');
const room = require('../../utils/room.js');
const net = require('../../utils/net.js');
const ui = require('../../utils/ui.js');

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
const CHAT_MAX = 200;
const COUNTDOWN_MS = 200;
/** 操作记录最多渲染这么多行（服务端 actionLog 保留 500 条）：全量塞进常驻侧栏
 *  会在每次 state 广播时重排几千像素，长局明显掉帧。 */
const LOG_ROWS_MAX = 120;

/**
 * 左右侧栏的宽度预算（单位 px，与 game.wxss 的 `.game-main{gap:6px}` 必须一致）。
 *
 * 为什么用 px 而不用 rpx：这里的数要和 `fitCanvas()` 的减法对得上 —— 画布宽度 =
 * min(行宽 − 侧栏总宽, 行高×2)，rpx 会随屏宽缩放，wxss 里的 gap 与 JS 里的常量
 * 一旦对不上，画布就会溢出或留缝。
 */
const SIDE_GAP = 6;
const SIDE_CHAT_MIN = 150; // 聊天栏最小宽度：再窄输入行（输入框 + 发送）放不下
const SIDE_LOG_MIN = 110; // 记录栏最小宽度：容得下「东家 + 碰 + 五万」
/**
 * 侧栏的**目标宽度**（够宽就按这个尺寸，不再按比例铺满）。
 * 为什么不再吃满余量：牌桌是 2:1 定尺、高度吃满，多出来的宽度给画布也用不上，
 * 但给侧栏只会把中栏挤窄。用户口径（2026-10-17 深夜）：「控制好两边的记录和聊天
 * 模块大小，尽量多的显示中心区域的内容」—— 所以两栏定尺，余量留给中栏。
 */
const SIDE_CHAT_PREF = 230;
const SIDE_LOG_PREF = 180;

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
    // 画布
    canvasW: 640,
    canvasH: 320,
    // 左右侧栏（由 fitCanvas 按「画布之外的真实余量」决定）：sideCols 为 true 时
    // 左边常驻操作记录、右边常驻聊天；窄窗口（手机横屏 1.78:1）没有余量则整块不出现，
    // 退回「画布居中 + HUD 聊天圆钮」的旧布局。logW/chatW 是 px，直接写进内联 style。
    sideCols: false,
    logW: 0,
    chatW: 0,
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
    // 结算态（v.phase === 'over'）：手牌带整体退场、操作区只剩一行结果，
    // 画布要吃掉腾出的高度（见 renderGame 里的 fitCanvas）—— 见 §10.8⑫
    overPhase: false,
    // 聊天
    chatTab: 'chat',
    chatCollapsed: true,
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
  },

  // ---------- 生命周期 ----------

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
    // 错误提示的自动回退定时器（见 onError）
    this.errTimer = null;
    // 窗口尺寸变化（真机旋转 / 模拟器改窗口）：Page.onResize 在部分环境不触发，
    // 再挂一个应用级监听兜底 —— 画布不重量就会出现留白或点牌错位。
    if (wx.onWindowResize) {
      this.windowResizeHandler = () => this.fitCanvas();
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
    this.initCanvas();
    this.startCountdown();
    const g = getApp().globalData;
    if (g.lastGameView) this.renderGame(g.lastGameView);
  },

  onHide() {
    room.detach(this);
    this.stopCountdown();
    this.clearDice();
  },

  onUnload() {
    room.detach(this);
    this.stopCountdown();
    this.clearDice();
    if (this.windowResizeHandler && wx.offWindowResize) wx.offWindowResize(this.windowResizeHandler);
    this.windowResizeHandler = null;
    if (this.ceremonyExpiryTimer) clearTimeout(this.ceremonyExpiryTimer);
    if (this.errTimer) clearTimeout(this.errTimer);
    this.errTimer = null;
  },

  onResize() {
    // 横竖屏切换 / 分屏：重算画布盒尺寸并重新量一次 rect
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
      });
  },

  /** 拉 CDN 牌面（只做一次；失败就永远走矢量兜底） */
  loadTileArt(canvas) {
    if (this.tileArtAsked) return;
    this.tileArtAsked = true;
    tileimg.ensure((ok) => {
      if (!ok) return;
      tileimg.preload(canvas, (got) => {
        if (!got) return;
        if (this.view) this.table.render(this.view);
        if (this.trayV) this.syncHandTray(this.trayV, this.trayRitual);
      });
    });
  },

  /**
   * 布局预算：画布 2:1 定尺（高度吃满可用高度、宽度反算），**画布之外多出来的宽度**
   * 分给左右两栏 —— 左边操作记录、右边聊天。
   *
   * 为什么用 `#game-main` 定侧栏：这个行容器的宽高只由父容器决定
   * （`.game-main{flex:1;min-height:0}`，子元素溢出不会撑大它），所以「有没有侧栏」
   * 不会让测量值抖动。若拿 `#canvas-wrap` 来判，侧栏一出现就把自己量窄，形成
   * 「侧栏 → 画布变小 → 侧栏消失」的循环抖动。
   * 但**画布宽度**仍以 `#canvas-wrap` 实测宽为准（窄屏手动展开聊天列时它会变窄，
   * 用 `#game-main` 的宽度算会把画布撑到聊天列下面去）；仅当侧栏要出现时才改用
   * 「行宽 − 侧栏宽」——那一刻 wrap 还没被侧栏挤窄，只能这么算。
   *
   * 宽窗口（≥ ~2:1，例如把开发者工具窗口拉宽 / 平板横屏）余量充足，两栏都出现；
   * 手机横屏（1.78:1）画布本来就把宽度吃满，余量为 0 → 两栏都不出现，与旧行为一致。
   */
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
        const wrap = boxOf(res && res[1]) || null;
        const W = main.width;
        const H = main.height;
        // 画布区实测宽（窄屏手动展开聊天列时比行宽小）
        const wrapW = wrap ? wrap.width : W;

        // 1) 「无侧栏」时的画布宽：高度吃满、宽度按 2:1 反算（与 web 端同一约定）
        const baseW = Math.max(240, Math.floor(Math.min(W, H * 2)));
        // 2) 画布之外真正多余的宽度
        const leftover = W - baseW;

        let logW = 0;
        let chatW = 0;
        const availBoth = leftover - SIDE_GAP * 2;
        if (availBoth >= SIDE_LOG_PREF + SIDE_CHAT_PREF) {
          // 够宽：两栏定尺，剩余宽度留给中栏（画布在更宽的区域里居中，不裁不拉伸）
          logW = SIDE_LOG_PREF;
          chatW = SIDE_CHAT_PREF;
        } else if (availBoth >= SIDE_LOG_MIN + SIDE_CHAT_MIN) {
          // 不够宽：按可用量压缩，聊天优先（它有输入行，压太窄会挤掉「发送」）
          chatW = Math.min(SIDE_CHAT_PREF, Math.max(SIDE_CHAT_MIN, Math.round(availBoth * 0.56)));
          logW = availBoth - chatW;
          if (logW < SIDE_LOG_MIN) {
            logW = 0;
            chatW = 0;
          }
        }
        if (chatW === 0) {
          // 只够放一栏时优先保聊天（记录这次让位，结算时就会走到这条分支）
          const availOne = leftover - SIDE_GAP;
          chatW = availOne >= SIDE_CHAT_MIN ? Math.min(SIDE_CHAT_PREF, availOne) : 0;
        }
        // 掷骰仪式（diceShown）期间侧栏整条让位：骰子覆盖层盖满全页、画布也是隐藏态，
        // 记录 / 聊天留在原位只是两块被压暗的空壳。骰子收起后由 clearDice → fitCanvas 还原。
        // diceShown 在本轮量算里不会变，收敛性不受影响。
        if (this.data.diceShown) {
          logW = 0;
          chatW = 0;
        }

        const sideCols = chatW > 0;
        // 侧栏占掉的宽度：一栏时只有 1 个 gap，两栏时 2 个
        const colsW = sideCols ? chatW + logW + SIDE_GAP * (logW > 0 ? 2 : 1) : 0;
        const availW = sideCols ? W - colsW : wrapW;
        const w = Math.max(240, Math.floor(Math.min(availW, H * 2)));
        const h = Math.round(w / 2);

        const patch = {};
        // 画布尺寸在骰子期间**冻结**：骰子覆盖层下画布是隐藏态，若按「无侧栏」的宽高
        // 更新 canvasW/H，骰子一收画布会以先宽后窄经历一次缩放跳变（用户报的「缩放现象」）。
        // 冻结后骰子结束时的 canvasW/H 与骰前一致，clearDice 一次性还原侧栏即无缝回位。
        if (!this.data.diceShown) {
          if (w !== this.data.canvasW) patch.canvasW = w;
          if (h !== this.data.canvasH) patch.canvasH = h;
        }
        if (sideCols !== this.data.sideCols) patch.sideCols = sideCols;
        if (logW !== this.data.logW) patch.logW = logW;
        if (chatW !== this.data.chatW) patch.chatW = chatW;
        if (Object.keys(patch).length > 0) {
          this.setData(patch);
          // 布局变了要再量一轮：画布 rect（点击换算）、以及侧栏出现后 wrap 的真实宽度。
          // 重跑自身会收敛 —— sideCols 只由行宽/行高决定，与当前布局无关，
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
      .exec((r) => {
        const box = r && r[0];
        const wrap = (r && r[1]) || null;
        const fresh =
          box &&
          box.width > 0 &&
          Math.abs(box.width - this.data.canvasW) <= 2 &&
          Math.abs(box.height - this.data.canvasH) <= 2;
        if (fresh) {
          this.canvasBox = { left: box.left, top: box.top, width: box.width, height: box.height };
          return;
        }
        // 兜底：canvas 在 canvas-wrap 里居中 → 容器左上角 + 居中偏移推算
        if (wrap && wrap.width > 0) {
          this.canvasBox = {
            left: wrap.left + (wrap.width - this.data.canvasW) / 2,
            top: wrap.top + (wrap.height - this.data.canvasH) / 2,
            width: this.data.canvasW,
            height: this.data.canvasH,
          };
          return;
        }
        if (box && box.width > 0) {
          this.canvasBox = { left: box.left, top: box.top, width: box.width, height: box.height };
        }
      });
  },

  /**
   * 两条几何通道都拿不到时的兜底估算：窗口尺寸 − 导航栏 − 流内 chrome。
   * chrome 包含 HUD + 画布下方的操作区（状态行 / 控件 / 手牌条），
   * 与 wxss 紧凑档的实测量级对齐，宁可略小也不要让画布溢出屏幕。
   */
  estimateWrap() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    if (!info || !info.windowWidth || !info.windowHeight) return null;
    // 导航栏高度：胶囊按钮在导航栏内垂直居中 → 导航栏高 ≈ 2 × 胶囊中心
    let navH = 0;
    try {
      const cap = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
      if (cap && cap.top != null && cap.height) navH = Math.round((cap.top + cap.height / 2) * 2);
    } catch (e) {
      /* 老基础库无此 API：走下面的兜底值 */
    }
    if (!(navH > 0)) navH = (info.statusBarHeight || 0) + 44;
    // 紧凑档(≤680px)：HUD 26 + 状态 17 + 控件 30(可选) + 手牌 62 + 页内边距 ≈ 136
    const chrome = info.windowHeight <= 680 ? 136 : 90;
    const w = info.windowWidth - 16;
    const h = info.windowHeight - navH - chrome;
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
            controls.push({
              text: `吃 ${choice.map((t) => tileName(t)).join(' ')}`,
              act: { t: 'claim', kind: 'chi', chiTiles: choice },
            });
          }
        } else if (opt.kind === 'peng') {
          controls.push({ text: `碰 ${tileName(opt.tile)}`, act: { t: 'claim', kind: 'peng' } });
        } else if (opt.kind === 'hu') {
          controls.push({
            text: opt.label ? `胡·${opt.label}` : `胡 ${tileName(opt.tile)}`,
            act: { t: 'claim', kind: 'hu' },
          });
        } else {
          controls.push({ text: `杠 ${tileName(opt.tile)}`, act: { t: 'claim', kind: 'gang' } });
        }
      }
      controls.push({ text: '过', act: { t: 'pass' }, ghost: true });
      this.setData({ statusText: status, controls });
      return;
    }

    for (const sg of v.selfGangs || []) {
      controls.push({
        text: `${sg.kind === 'angang' ? '暗杠' : '补杠'} ${tileName(sg.tile)}`,
        act: { t: 'selfGang', kind: sg.kind, tile: sg.tile },
      });
    }
    for (const dt of v.declareOptions || []) {
      controls.push({ text: `展示 3 张 ${tileName(dt)}`, act: { t: 'declareKong', tile: dt } });
    }
    if (v.canZimo) {
      controls.push({ text: v.zimoLabel ? `自摸·${v.zimoLabel}` : '自摸', act: { t: 'zimo' } });
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

    this.setData({ statusText: status, controls });
  },

  onControl(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const item = this.data.controls[idx];
    if (!item || item.disabled) return;
    room.send(item.act);
    this.lockControls();
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
    // 记住骰前侧栏状态：结束后一次性还原（配合 fitCanvas 的画布尺寸冻结，无缩放跳变）
    if (!this.data.diceShown) {
      this.preDiceSides = { sideCols: this.data.sideCols, logW: this.data.logW, chatW: this.data.chatW };
    }
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
   * 骰子阶段结束：**一次性**还原 diceShown + 骰前侧栏，再显示画布。
   * 之前的写法是「先显示画布（此时 canvasW 已被骰子期间的无侧栏布局改宽）、
   * fitCanvas 隔一拍再收窄」→ 画布以先宽后窄两次渲染 → 用户看到一次缩放跳变。
   * 现在 fitCanvas 在骰子期间冻结 canvasW/H，clearDice 又把侧栏与 diceShown
   * 合并在同一批 setData 里 → 画布重新显示时就是最终尺寸，无缩放。
   */
  clearDice() {
    this.stopDiceTimers();
    if (!this.data.diceShown) return;
    const patch = { diceShown: false };
    const pre = this.preDiceSides;
    if (pre) {
      patch.sideCols = pre.sideCols;
      patch.logW = pre.logW;
      patch.chatW = pre.chatW;
      this.preDiceSides = null;
    }
    this.setData(patch);
    this.syncModal();
    this.fitCanvas(); // 复核一次布局 + 重量画布点击盒（量到与冻结值一致则无事发生）
  },

  // ---------- 聊天 ----------

  onChatTab(e) {
    const tab = e.currentTarget.dataset.tab;
    this.setData({ chatTab: tab, quickShown: false, emojiShown: false });
    if (tab === 'log' && this.view) this.renderLog(this.view);
  },

  onToggleChat() {
    const collapsed = !this.data.chatCollapsed;
    const patch = { chatCollapsed: collapsed };
    if (collapsed) {
      patch.quickShown = false;
      patch.emojiShown = false;
    } else {
      patch.chatUnread = 0;
      getApp().globalData.chatUnread = 0;
    }
    this.setData(patch);
    // 聊天列是流内元素：展开/收起会改变 canvas-wrap 的宽度 → 画布盒与点击 rect 都要重量
    this.fitCanvas();
  },

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
    // 未读只在「聊天面板看不见」时累加：宽屏侧栏模式聊天常驻，不算未读
    if (msg.seat !== g.mySeat && this.data.chatCollapsed && !this.data.sideCols) {
      const unread = Math.min((this.data.chatUnread || 0) + 1, 999);
      patch.chatUnread = unread;
      g.chatUnread = unread;
    }
    this.setData(patch);
    if (this.table) this.table.pushBubble(msg.seat, msg.text, 'text');
  },

  renderLog(v) {
    const names = v.names || [];
    // 服务端 actionLog 保留 500 条（按时间正序）。常驻侧栏只渲染尾部 —— 全量塞进
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
    // 侧栏跟随最新一步：scroll-top 每次加一个大数，超出最大滚动量时会自动夹到底部
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
    this.setData({
      settleShown: true,
      modalOpen: true,
      settleTitle: m.title,
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
