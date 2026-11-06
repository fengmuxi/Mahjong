/**
 * 对局场景（pages/game/game.js 的画布移植，逻辑逐行对照）。
 *
 * 职责分两半：
 *   · **牌桌**：utils/table.js 原样跑在离屏宿主画布上（applyBackingStore 自管 backing
 *     store），场景每帧把宿主 blit 到主画布的桌面矩形；触摸点换算逻辑坐标后走
 *     table.hitTest（掷骰按钮 / 结算 ▲ / 铭牌 / 手牌）。
 *   · **chrome**：顶栏 / 侧轨 / 操作带 / 面板 / 浮层 → src/chrome.js（DOM 半边的对位物）。
 *
 * 与小程序端的平台差异：
 *   · SelectorQuery / fitCanvas 闭环 → layout.game() 纯数学（画布贴 game-main 底、2:1 定尺）；
 *   · setData → 场景字段；浮层打开不再需要藏画布（无合成层级问题）；
 *   · 倒计时 / 骰子仪式的定时器保留原节奏，重渲染由每帧主循环天然覆盖。
 */

const { tileName, seatWind } = require('../../lib/shared/tiles.js');
const { CHAT_TEXT_MAX, THROW_EMOJI, THROW_EMOJI_TONES, throwEmojiOf } = require('../../lib/shared/index.js');
const { variantName } = require('../../lib/shared/rules/index.js');
const { Table } = require('../../utils/table.js');
const tileimg = require('../../utils/tileimg.js');
const uiart = require('../../utils/uiart.js');
/** 头像资源（2026-11-04）：铭牌头像；缺图回退风位圆 */
const avatarart = require('../../utils/avatarart.js');
const sound = require('../../utils/sound.js');
/** 统一声音设置（2026-11-04）：语音包/音量/开关的唯一真相源，与小程序的同一份 */
/** 声音设置面板（2026-11-04）：画布版，game/lobby/home 共用（src/ui/settingspanel.js） */
const settingsPanel = require('../ui/settingspanel.js');
const voice = require('../../utils/voice.js');
const nav = require('../nav.js');
const net = require('../../utils/net.js');
const state = require('../state.js');
const layout = require('../layout.js');
const chrome = require('../chrome.js');
const draw = require('../ui/draw.js');
const DiceFx = require('../ui/dicefx.js');
const toast = require('../ui/toast.js');
const Scene = require('./scene.js');
const app = require('../app.js');

const CHAT_QUICK = ['快点啊', '胡了！🎉', '不好意思', '等一下', '这把稳了', '笑死😂', '加油', '别急'];
const CHAT_EMOJI = ['😀', '😂', '😍', '😎', '🤔', '😅', '👍', '👏', '🎉', '🔥', '💡', '🀄', '❤️', '🍺', '😴', '🙏'];
const LOG_ACTION_LABEL = {
  discard: '出牌',
  chi: '吃',
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
  bugang: '补杠',
  declare: '报杠', // 2026-11-04：报杠开始进日志（以前只有执行者本地知道）
  hu: '胡',
  draw: '流局',
};
/**
 * 动作 kind → 语音动作的映射**不在这里**：统一在 utils/sound.js 的 `VOICE_BY_KIND`，
 * 由 `sound.playAction(kind)` 消化（含「语音关了/缺这条 → 退原音效」兜底）。
 * 与小程序端 2026-11-04 起同一套（两端 utils/sound.js 逐字节一致）。
 */
const CHAT_MAX = 200;
/** 常规牌局动作的 event toast 过滤（兼容未升级的线上服务端，见 game.js 同名常量） */
const PLAY_ACTION_EVENT = /^[^·\s]+·.+?\s(报杠|打出|吃|碰|杠)\s/;
const LOG_ROWS_MAX = 120;
const COUNTDOWN_MS = 200;
/**
 * 头像位图等待上限（ms）：原子换装闸门里头像通道的最长阻塞时间。
 * 头像是装饰（缺失有风位圆兜底），池子变大后不该拖慢进桌 —— 超时先放行，后到的补画。
 */
const AVATAR_GATE_MS = 2500;

const fmtDelta = (v) => (v === 0 ? '0' : v > 0 ? '+' + v : String(v));
const fmtIn = (v) => (v > 0 ? '+' + v : '—');
const fmtOut = (v) => (v > 0 ? '−' + v : '—');

/** 排查日志用的 API 基址（拿不到给空串，不打断日志） */
function safeApi() {
  try {
    return require('../../utils/config.js').resolveApi();
  } catch (e) {
    return '';
  }
}

const preload = require('../preload.js');

/**
 * 图片预解码宿主适配：preload 只消费 `canvasNode.createImage`（鸭子类型）。
 * 优先屏上画布自带的方法（小游戏 Canvas.createImage，基础库支持时）；
 * 拿不到退全局 `wx.createImage()`（小游戏标准入口）。实现收敛在 src/preload.js，
 * 与启动预热共用同一适配 —— 两处逻辑漂移会让「预热解码的位图」与「场景解码的」不同源。
 */
function imageHost(canvasNode) {
  return preload.imageHost(canvasNode);
}

class GameScene extends Scene {
  constructor() {
    super();
    this.view = null;
    // chrome 状态
    this.code = '';
    this.variantLabel = '';
    this.wallText = '';
    this.jingText = '';
    this.statusText = '';
    this.waitsText = '';
    this.autoShown = false;
    this.autoOn = false;
    this._autoCancelPending = false; // 「点手牌取消托管」已发未回执（挡连发，见 cancelAutoByTouch）
    this._autoCancelTimer = null; // 上面那个闸门的兜底复位定时器（回执没到也必须放开）
    /* 声音设置面板（2026-11-04）：菜单 ⚙️ 打开；面板在屏时吞掉全部触摸。
       press/drag 是面板自己的按压与拖动态（不复用 this.pressed，避免与 chrome 的 id 撞车）。 */
    this.settingsShown = false;
    this.setPressed = '';
    this._setDrag = null;
    // 房间语音（2026-11-03 反馈：可选开启 + 麦克风/扬声器双开关）：合并菜单双钮渲染态样
    this.voiceAvailable = true;
    this.voiceOn = false;
    this.voiceMuted = false;
    this.voiceEar = false;
    this.voiceSpeaking = false;
    this.voiceBusy = false;
    this.controls = [];
    this.declares = [];
    this.declareBusy = false;
    this.controlsErrShown = false;
    this.controlsErrText = '';
    this.countdownShown = false;
    this.countdownText = '';
    this.overPhase = false;
    this.netShown = false;
    this.netText = '';
    // 面板
    this.logOpen = false;
    this.chatOpen = false;
    this.menuOpen = false; // 合并菜单（☰）展开态
    this.logRows = [];
    this.logScroll = 0;
    this.chatMsgs = [];
    this.chatUnread = 0;
    this.chatInput = '';
    this.chatFocus = false;
    this.chatScroll = 0;
    this.quickShown = false;
    this.emojiShown = false;
    this.quickList = CHAT_QUICK;
    this.emojiList = CHAT_EMOJI;
    // 浮层
    this.emoteShown = false;
    this.emoteTargets = [];
    this.emoteGroups = [];
    this.emoteTargetSeat = null;
    this.settleShown = false;
    this.settleRestoreShown = false;
    this.settleTitle = '';
    this.settleWinTile = '';
    this.settleArtKey = '';
    this.settleHead = [];
    this.settleRows = [];
    this.settleNotes = [];
    this.settleTotals = '';
    this.settleNextDisabled = false;
    this.settleScroll = 0;
    // 「退出本局」确认框（顶栏 ‹）：任何人可点，只退出自己这一局（2026-11-05）
    this.quitAskShown = false;
    this.quitShown = true; // ‹ 是否可点：只有 phase==='playing' 才有「退出本局」可言（见 renderGame）
    this.swapAskShown = false;
    this.swapAskText = '';
    this.dissolvedShown = false;
    this.dissolvedTitle = '';
    this.dissolvedRows = [];
    // 骰子
    this.diceFx = new DiceFx();
    this.diceKey = undefined;
    this.ceremonyAnim = null;
    this.ceremonyExpiryKey = -1;
    // 内部簿记（对位 game.js 实例字段）
    this.chromeKey = undefined;
    this.logKey = undefined;
    this.sndSeenSeq = 0;
    this.sndHandCount = 0;
    this.lastCountdownText = '';
    this.lastCountdownAt = 0;
    this.table = null;
    this.canvasNode = null;
    this.tileArtAsked = false;
    this.activeCardAsked = false;
    this.activeCardImg = null;
    this.uiArtAsked = false;
    this.artImages = {};
    this.feltNavy = true;
    this.ui = {};
    this.pressed = '';
    this.Lg = null;
    this._errTimer = null;
    this._declareTimer = null;
    this._declareView = null;
    this._ceremonyExpiryTimer = null;
    this._declareOptionsKey = '';
  }

  /* ---------------- 生命周期 ---------------- */

  enter() {
    nav.attach('game', this);
    this.initCanvas();
    sound.ensure(); // 局内音效清单（CDN）；失败即静音，不影响对局
    sound.outBgmStop(); // 局内/局外 BGM **互斥**：进对局页先停掉局外那首
    sound.bgmStart();
    this.initVoice(); // 语音态样挂载（在 bgmStart 之后：joined 态会在 applyVoice 里把 BGM 压下去）
    const g = state;
    this.chatMsgs = (g.chatHistory || []).map((m) => ({
      seat: m.seat,
      name: m.name,
      text: m.text,
      self: m.seat === g.mySeat,
    }));
    this.chatUnread = g.chatUnread || 0;
    this.chatScroll = 1e9; // 载入即跟随最新（对位 scroll-top +2000）
    if (g.lastGameView) this.renderGame(g.lastGameView);
    this.syncNet();
  }

  exit() {
    nav.detach(this);
    this.diceFx.dispose();
    this.stopTimers();
    voice.setListener(null); // 监听是模块级单槽：本场景退出即摘除，新场景 enter 重新挂
    sound.bgmStop(); // 退局释放背景音乐实例（对位 onUnload）
  }

  stopTimers() {
    if (this._errTimer) clearTimeout(this._errTimer);
    if (this._declareTimer) clearTimeout(this._declareTimer);
    if (this._ceremonyExpiryTimer) clearTimeout(this._ceremonyExpiryTimer);
    this._errTimer = this._declareTimer = this._ceremonyExpiryTimer = null;
  }

  /* ---------------- 画布初始化（initCanvas / loadTileArt / loadUiArt） ---------------- */

  initCanvas() {
    if (this.table) return;
    if (!app.tableHost) return;
    this.canvasNode = app.canvas;
    this.table = new Table(app.tableHost, app.dpr);
    this.table.onRollDice = () => nav.send({ t: 'rollDice' });
    this.table.onTagClick = (seat) => {
      if (!this.view) return;
      // 点自己的铭牌 → 开聊天面板并直接展开快捷短语（点一下即发）；
      // 点别人的铭牌 → 互动表情（与之前一致）。
      if (seat === this.view.mySeat) this.openQuickChat();
      else this.openEmotePicker(seat);
    };
    this.table.onDiscard = (idx, tile) => this.onCanvasDiscard(tile);
    this.table.onRaise = (idx, tile) => this.onCanvasRaise(tile);
    this.table.onSettleRestore = () => this.onSettleRestore();
    this.table.onPrep = () => this.onSettleNext(); // 画布「准备」胶囊 → 与面板「准备」同一出口
    this.loadTileArt(); // 含 UI 通道（原子换装闸门，见 loadTileArt 注释）
  }

  /**
   * 资源通道拉取（进入对局时触发一次；冷启动预热已在跑，这里只是挂回调）。
   *
   * **原子换装**（2026-11-02 感官优化）：牌面、平放图集、UI 贴图三个通道各自完成
   * 时间不同，逐通道重绘会出现「桌布换了牌面没换 / 牌面换了操作钮没换」的中间态
   * （用户报「先显示兜底样式再闪回来」）。这里把三通道汇到一个闸门：
   * 全部 settle（成功或失败）后**只重绘一次**——要么全套贴图、要么全套兜底，不闪两回。
   */
  loadTileArt() {
    if (this.tileArtAsked) return;
    this.tileArtAsked = true;
    const host = () => imageHost(this.canvasNode);
    let pending = 3; // tiles / ui / avatar 三通道
    const settle = () => {
      pending -= 1;
      if (pending > 0) return;
      // 闸门放行：此刻 tileimg/uiart 内部已是终态，一次性取全部位图重绘
      this.artImages = {};
      const keys = [
        'back', 'back_op', 'inhand_l', 'inhand_r', 'banker', 'table',
        'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9',
        'chi', 'peng', 'gang', 'hu', 'guo', 'win', 'lost', 'draw',
      ];
      for (const k of keys) this.artImages[k] = uiart.art(k);
      this.feltNavy = !uiart.urlOf('table');
      if (this.table) this.table.feltNavy = this.feltNavy;
      if (this.view && this.table) this.table.render(this.view);
    };
    tileimg.ensure((ok) => {
      if (!ok) {
        console.warn('[mg] 牌面清单拉取失败，暂用矢量牌面。排查：详情→本地设置→勾选「不校验合法域名」，或确认服务器可达（' + safeApi() + '）');
        settle();
        return;
      }
      const h = host();
      if (!h) {
        console.warn('[mg] 当前环境无 createImage（屏上画布与 wx.createImage 都没有），牌面保持矢量');
        settle();
        return;
      }
      tileimg.preload(h, (got) => {
        if (!got) console.warn('[mg] 牌面位图预解码 0 张（CDN 图片地址不可达？）');
        settle();
      });
    });
    uiart.ensure((ok) => {
      if (!ok) {
        console.warn('[mg] UI 清单拉取失败（操作钮/桌面/结算艺术字走文字与矢量兜底）。排查同上（' + safeApi() + '）');
        settle();
        return;
      }
      const h = host();
      if (!h) {
        console.warn('[mg] 当前环境无 createImage，UI 贴图保持矢量/文字');
        settle();
        return;
      }
      uiart.preload(
        h,
        [
          'back', 'back_op', 'inhand_l', 'inhand_r', 'banker', 'table',
          'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9',
          'chi', 'peng', 'gang', 'hu', 'guo', 'win', 'lost', 'draw',
        ],
        () => settle(),
      );
    });
    // 头像通道（2026-11-04）：铭牌头像；取不到就回退风位圆，不影响牌桌可用性
    //
    // ⚠ 超时兜底（2026-11-04，池子扩到 39 张后加的）：头像是**装饰**（本来就有风位圆
    //   兜底），却排在原子换装闸门上 → 弱网下 39 张没下齐牌桌首帧就一直卡在兜底样式。
    //   超过 AVATAR_GATE_MS 就先放行闸门（铭牌画风位圆），后到的头像逐张补画。
    //   闸门本身只放行一次，settle 幂等化避免重复重绘。
    avatarart.ensure((ok) => {
      if (!ok) {
        console.warn('[mg] 头像清单拉取失败，铭牌走风位圆兜底。排查同上（' + safeApi() + '）');
        settle();
        return;
      }
      const h = host();
      if (!h) {
        settle();
        return;
      }
      let settled = false;
      let timedOut = false;
      const settleOnce = () => {
        if (settled) return;
        settled = true;
        settle();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        console.warn('[mg] 头像位图未在 ' + AVATAR_GATE_MS + 'ms 内下齐，先放行（铭牌走风位圆，后到的头像会补画）');
        settleOnce();
      }, AVATAR_GATE_MS);
      avatarart.preload(
        h,
        avatarart.list(),
        () => {
          clearTimeout(timer);
          settleOnce();
        },
        () => {
          // 逐张到货：若闸门已超时放行（头像是后补的），补画一次
          if (timedOut && this.table && this.view) this.table.render(this.view);
        },
      );
    });
    this.loadActiveCard();
  }

  /**
   * 末张「活跃牌」光效贴图（assets/ui/activeCard.png，包内 1.5KB）：加载成功注入
   * table.activeCardImg（drawLastMarker 叠加上下浮动光效）；失败静默 —— 只画金边。
   * 小游戏 createImage 支持包内相对路径；拿不到宿主/加载失败都不影响对局。
   */
  loadActiveCard() {
    if (this.activeCardAsked) return;
    this.activeCardAsked = true;
    const host = imageHost(this.canvasNode);
    if (!host) return;
    try {
      const img = host.createImage();
      img.onload = () => {
        this.activeCardImg = img;
        if (this.table) this.table.activeCardImg = img;
        if (this.view && this.table) this.table.render(this.view);
      };
      img.onerror = () => {
        console.warn('[mg] activeCard.png 加载失败（不影响对局，末张只画金边）');
      };
      img.src = 'assets/ui/activeCard.png';
    } catch (e) {
      /* 老基础库：静默降级 */
    }
  }

  /** 布局对位 fitCanvas/measureCanvasBox/applyTableFrame：纯数学，帧内直接算 */
  updateTableGeometry(Lg) {
    if (!this.table) return;
    // frame 必须用**对局布局**（Lg）：整屏桌面贴图两层（主画布整铺 + 牌桌内按 frame 画）
    // 靠同一映射重叠成一层；来源布局不一致就会出现错位的「画里画」。
    const f = layout.tableFrame(Lg);
    const old = this.table.frame;
    const same =
      old && Math.abs(old.x - f.x) < 0.5 && Math.abs(old.y - f.y) < 0.5 && Math.abs(old.w - f.w) < 0.5 && Math.abs(old.h - f.h) < 0.5;
    if (!same) {
      this.table.frame = f;
      // frame 变了立即补一帧（2026-11-04 审计 F5，对位 miniapp applyTableFrame）：
      // 牌桌是事件驱动重绘，不补的话进场首帧/横竖屏切换后宿主画布仍是旧 frame 的
      // 映射 —— 画布内桌布出现「画里画」错位，要等下一条广播才自愈。
      if (this.view) this.table.render(this.view);
    }
    // 胶囊 → 画布逻辑坐标（右上铭牌避让）；拿不到置 null → 铭牌贴角
    let capRect = null;
    const cap = Lg.cap;
    if (cap && cap.bottom > 0 && cap.height > 0) {
      const s = Lg.table.w / 1280;
      capRect = { left: (cap.left - Lg.table.x) / s, bottom: (cap.bottom - Lg.table.y) / s };
    }
    const oldCap = this.table.capsuleRect;
    const capSame =
      (oldCap && capRect && Math.abs(oldCap.left - capRect.left) < 0.5 && Math.abs(oldCap.bottom - capRect.bottom) < 0.5) ||
      (!oldCap && !capRect);
    if (!capSame) {
      this.table.capsuleRect = capRect;
      if (same && this.view) this.table.render(this.view); // 胶囊变了但 frame 没变 → 补一帧刷铭牌
    }
  }

  /* ---------------- 每帧渲染 ---------------- */

  render(ctx /* L 不用：场景内自算 game 布局，签名与主循环对齐 */) {
    const Lg = layout.game({ banner: this.netShown, overPhase: this.overPhase });
    this.Lg = Lg;
    // 1) 整屏桌面（DOM .felt 的对位）：贴图整铺 or 兜底纯色，与 table.frame 同映射无缝
    const feltArt = this.artImages && this.artImages.table;
    if (feltArt) {
      ctx.drawImage(feltArt, 0, 0, Lg.sw, Lg.sh);
    } else {
      ctx.fillStyle = this.feltNavy ? '#0d1626' : '#14614a';
      ctx.fillRect(0, 0, Lg.sw, Lg.sh);
    }
    // 2) 牌桌（离屏宿主 → 桌面矩形）
    if (this.table && app.tableHost) {
      this.updateTableGeometry(Lg);
      ctx.drawImage(app.tableHost, Lg.table.x, Lg.table.y, Lg.table.w, Lg.table.h);
    }
    // 3) 倒计时（200ms 节流语义由文案变化天然保证）
    this.tickCountdown();
    // 4) chrome（顶栏 / 侧轨 / 操作带 / 面板 / 浮层 / 骰子）
    chrome.render(ctx, Lg, this);
    // 5) 设置面板：画在**最上层**（含骰子之上）—— 与触摸路由「面板最先判定」对称，
    //    否则会出现「点得到但看不见 / 看得见点不到」的错位
    settingsPanel.render(ctx, Lg, this);
  }

  /* ---------------- 网络横幅 ---------------- */

  onNetStatus(s) {
    const text = net.describe(s);
    this.netText = text;
    this.netShown = !!text;
  }

  syncNet() {
    this.onNetStatus({
      state: net.getState(),
      inRoom: true,
      everConnected: net.hasConnected(),
      error: net.getLastError(),
      url: net.getUrl(),
    });
  }

  /* ---------------- 房间语音（2026-11-03，对位 game.js initVoice 一节） ---------------- */

  /** 进场景挂语音监听 + 刷新开关探测。监听是模块级单槽：本场景覆盖大厅场景的。 */
  initVoice() {
    voice.setListener((st) => this.applyVoice(st));
    this.applyVoice(voice.status());
    voice.probe().then((v) => {
      this.voiceAvailable = v !== false;
    });
  }

  applyVoice(st) {
    this.voiceOn = st.state === 'joined';
    this.voiceMuted = st.micMuted;
    this.voiceEar = st.earMuted;
    this.voiceSpeaking = st.othersSpeaking;
    this.voiceBusy = st.state === 'joining';
    this.voiceAvailable = voice.available() !== false;
    // BGM 与语音互斥（显式暂停策略，待真机验证两者并存行为后可放宽）：进语音压 BGM，退语音恢复
    if (st.state === 'joined') sound.bgmPause();
    else if (st.state === 'idle') sound.bgmStart();
    // 说话人集合变化：桌面铭牌光环要跟着刷新
    this.syncVoiceSeats();
    // 麦克风权限被拒：只提示一次（每场景实例），去开启走语音钮（tap 手势里调 openSetting）
    if (st.state === 'idle' && st.reason === 'micDenied' && !this.voiceAskSeen) {
      this.voiceAskSeen = true;
      toast.push('需要麦克风权限：点语音钮去开启', 2200);
    }
    // 其它加入失败（joinFailed: 开通未生效/工具端不支持/签名失效…）：透出真实原因，
    // 别让用户对着授权页打转。lastVoiceToastErr 去重：error 留在语音模块状态里，
    // 后续 notify 不能反复弹同一条；每次进入 joining 都重置，重试同一失败也会再提示。
    else if (st.state === 'joining') {
      this.lastVoiceToastErr = '';
    } else if (st.state === 'idle' && st.error && st.error !== this.lastVoiceToastErr) {
      this.lastVoiceToastErr = st.error;
      toast.push(st.error, 3200);
    } else if (st.state === 'idle' && !st.error) {
      this.lastVoiceToastErr = ''; // 新一次尝试已把 error 清空：重试再失败要能再次提示
    }
  }

  /** 语音钮：idle=开始使用（加入语音）；joined=开/闭麦切换；joining=忽略连点 */
  onVoiceTap() {
    const st = voice.status();
    if (st.state === 'joined') {
      // 开关麦失败要可见（2026-11-05）：旧写法吞掉结果，toggleMic 的 fail（权限/会话态）
      // 只在 console 里 —— 用户看着按钮变了、实际没生效，误以为「开关无效」
      voice.toggleMic().then((r) => {
        if (r && !r.ok && r.reason !== 'notJoined') toast.push('麦克风开关失败：' + (r.reason || ''), 2200);
      });
      return;
    }
    if (st.state === 'joining') return;
    const go = () => voice.join(this.code || state.roomCode || '').catch(() => {});
    if (st.reason === 'micDenied') {
      // wx.openSetting 必须由用户手势触发 —— 此处是 tap 回调，满足
      voice.openMicSetting().then((granted) => {
        if (granted) go();
      });
      return;
    }
    go();
  }

  /** 扬声器开关（听不听得到别人）。未在语音时点它=顺带入会（用户定案 B，2026-11-06）：
   *  按「只听」入会（micMuted:true）——点 🔊 是「想听」，不替你开麦（想说话再点 🎤）；
   *  会中才真正开关扬声器（关 = 联动闭麦，见 toggleEar）。 */
  onVoiceEar() {
    const st = voice.status();
    if (st.state === 'joined') {
      voice.toggleEar().then((r) => {
        if (r && r.ok && r.earMuted && r.micMuted) toast.push('已关闭扬声器并闭麦（仍在语音中）', 2400);
        else if (r && r.pending) toast.push('未在语音中：扬声器偏好将在开启语音后生效', 2400);
      });
      return;
    }
    if (st.state === 'joining') return;
    // 未在语音：顺带入会（只听、不开麦）；权限被拒先引导去设置（与麦克风钮同流程）
    const go = () => voice.join(this.code || state.roomCode || '', { micMuted: true }).catch(() => {});
    if (st.reason === 'micDenied') {
      voice.openMicSetting().then((granted) => { if (granted) go(); });
      return;
    }
    go();
  }

  /** 服务端 voice 座位映射广播（nav.js 路由）：刷新桌面铭牌的说话光环/闭麦角标 */
  onVoice() {
    this.syncVoiceSeats();
  }

  /**
   * 座位级语音指示（2026-11-03 二期，对位 game.js computeVoiceSeats）：
   * voiceMap × voice.speakers() → 4 布尔数组，按**绝对座位**写入 table 注入字段
   * （table.js 内部 disp() 自行相对化到铭牌 slot）。
   *
   * 双模式（2026-11-05 B 方案）：真机实测说话人事件从不触发，「正在说话」没有
   * 数据源 → 按 voice.hasSpeakerData() 分流：
   *   · 事件通道可用（收到过数据）→ 说话交集，铭牌**呼吸**绿环；
   *   · 从未收到 → 降级「开麦即亮」：映射里有条目且未闭麦 = **常亮**绿环（该座位
   *     随时能说话），闭麦 且 关扬声器 = 🔇 角标（2026-11-05：单独闭麦不画 🔇）。数据源是现有 voiceId/muted/ear 广播，退会时有
   *     retractId 撤回，映射新鲜。哪天事件恢复触发，指示自动升级回呼吸级。
   */
  computeVoiceSeats() {
    if (!this.table) return;
    const vmap = state.voiceMap || {};
    const speakers = voice.speakers();
    const reactive = voice.hasSpeakerData();
    const speaking = [false, false, false, false];
    const muted = [false, false, false, false];
    for (let seat = 0; seat < 4; seat++) {
      const v = vmap[seat];
      if (!v) continue;
      speaking[seat] = reactive ? speakers.indexOf(v.openid) >= 0 : !v.muted;
      // 2026-11-05：🔇 角标 = 闭麦 且 关扬声器（v.muted && v.ear）；单独闭麦不画 🔇。
      muted[seat] = !!(v.muted && v.ear);
    }
    this.table.speakingSeats = speaking;
    this.table.mutedSeats = muted;
    this.table.voiceReactive = reactive;
  }

  /** computeVoiceSeats + 补一帧渲染（voice 事件驱动，不等下一次对局广播） */
  syncVoiceSeats() {
    this.computeVoiceSeats();
    if (this.table && this.view) this.table.render(this.view);
  }

  /* ---------------- 对局渲染（renderGame 逐行移植） ---------------- */

  onGame(v) {
    this.renderGame(v);
  }

  wind(seat) {
    return seatWind(seat, this.view ? this.view.dealer : state.dealer || 0);
  }

  ritualPhase(v) {
    const c = v.ceremony;
    if (!c) return null;
    if (c.state === 'wait-roll') return 'wait';
    if (c.rollAt === null || c.until === null) return null;
    if (!this.ceremonyAnim || this.ceremonyAnim.key !== c.rollAt) {
      this.ceremonyAnim = { key: c.rollAt, start: Date.now(), dur: Math.max(300, c.until - c.rollAt) };
    }
    return Date.now() - this.ceremonyAnim.start < this.ceremonyAnim.dur ? 'roll' : null;
  }

  jingList(list) {
    const c = new Map();
    for (const t of list) c.set(t, (c.get(t) || 0) + 1);
    let out = '';
    c.forEach((n, t) => {
      out += (out ? '/' : '') + tileName(t) + (n > 1 ? '×' + n : '');
    });
    return out;
  }

  renderGame(v) {
    this.view = v;
    this.playActionSounds(v); // 他人 + 托管代打（自己无手动交互）的动作音效（按 view.log 增量）
    // 发牌 / 摸牌音效：手牌张数增长即响（minGap 节流避免连响）
    const handCount = (v.myTiles || []).length;
    if (handCount > this.sndHandCount) sound.play('deal', { minGap: 250 });
    this.sndHandCount = handCount;
    state.lastGameView = v;
    state.mySeat = v.mySeat;
    state.dealer = v.dealer || 0;

    const autoOn = v.auto ? v.auto[v.mySeat] === true : v.connected ? !v.connected[v.mySeat] : false;
    const rp = this.ritualPhase(v);
    let wallText = '牌墙 ' + v.wallLeft;
    if (v.ceremony && v.ceremony.kind === 'deal' && rp === 'wait') wallText = '牌墙 136';
    else if (v.ceremony && v.ceremony.kind === 'deal' && rp === 'roll') wallText = '牌墙 …';

    let jingText = '';
    if (v.ceremony && v.ceremony.kind === 'jing' && v.ceremony.state === 'rolling') jingText = '';
    else if (v.gz) {
      if (v.gz.zheng.length > 0) {
        jingText = v.gz.revealed
          ? '正精 ' + this.jingList(v.gz.zheng) + ' · 副精 ' + this.jingList(v.gz.fu)
          : '正精 ' + tileName(v.gz.zheng[0]) + (v.gz.fu.length > 0 ? ' · 副精 ' + tileName(v.gz.fu[0]) : '') + '（其余 10 张结算揭晓）';
      }
    } else if (v.jingPi !== null && v.jingFu !== null) {
      jingText = '正精 ' + tileName(v.jingPi) + ' · 副精 ' + tileName(v.jingFu);
    }

    const over = v.phase === 'over';
    const chromeKey = over ? 'o' : '-';
    const chromeChanged = this.chromeKey !== chromeKey;
    this.chromeKey = chromeKey;
    this.overPhase = over;
    // 听牌提示：服务端算好 view.waits，前端只拼字
    const waits = Array.isArray(v.waits) ? v.waits : [];
    this.waitsText =
      over || waits.length === 0 ? '' : waits.length >= 34 ? '听任意一张' : waits.length > 5 ? '听 ' + waits.length + ' 张' : '听 ' + waits.map((t) => tileName(t)).join('、');
    this.code = v.code;
    this.variantLabel = v.variant ? variantName(v.variant) : '';
    this.wallText = wallText;
    this.jingText = jingText;
    this.autoShown = v.phase !== 'over';
    // ‹ 只在打牌相位可点：结算/摊牌时本局已结束，服务端会拒 quit（「当前没有进行中的对局」），
    // 与其让用户点了跳空，不如置灰（chrome.topbar 按这个标志降透明度并跳过命中）
    this.quitShown = v.phase === 'playing';
    this.autoOn = autoOn;
    if (!autoOn) {
      // 解除回执到了：允许下一次手牌交互再次解除（并清掉兜底超时）
      this._autoCancelPending = false;
      if (this._autoCancelTimer) {
        clearTimeout(this._autoCancelTimer);
        this._autoCancelTimer = null;
      }
    }
    this.controlsErrShown = false;
    // 新一局开始（或换玩法重开）时清掉「本局结算 ▲」
    if (!over && this.settleRestoreShown) this.settleRestoreShown = false;
    // 结算浮层还开着但服务端已开下一局 → 收掉（下一局只发 game 不广播 state）
    if (!over && this.settleShown) this.settleShown = false;

    this.renderControls(v);
    this.renderLog(v);
    this.syncCanvasStatus();
    this.computeVoiceSeats(); // 座位级语音指示：渲染前刷新注入字段（2026-11-03 二期）
    if (this.table) this.table.render(v);

    if (v.ceremony && v.ceremony.state === 'rolling') {
      this.playDice(v);
      if (this.ceremonyExpiryKey !== v.ceremony.rollAt) {
        this.ceremonyExpiryKey = v.ceremony.rollAt === null ? -1 : v.ceremony.rollAt;
        if (this._ceremonyExpiryTimer) clearTimeout(this._ceremonyExpiryTimer);
        this._ceremonyExpiryTimer = setTimeout(() => {
          this._ceremonyExpiryTimer = null;
          if (this.view) this.renderGame(this.view);
        }, (this.ceremonyAnim ? this.ceremonyAnim.dur : 1000) + 80);
      }
    } else if (v.ceremony && v.ceremony.state === 'wait-roll') {
      this.clearDice();
    }
  }

  /* ---------------- 控件与状态 ---------------- */

  relSeatName(seat) {
    const d = (((seat - (this.view ? this.view.mySeat : 0)) % 4) + 4) % 4;
    return ['自己', '下家', '对家', '上家'][d] || seat + '号';
  }

  seatNickname(seat) {
    const v = this.view;
    if (v && v.names && v.names[seat]) return v.names[seat];
    const s = state.lastState;
    const p = s && (s.players || []).find((x) => x.seat === seat);
    return (p && p.name) || this.wind(seat);
  }

  renderControls(v) {
    this.syncDeclares(v); // 报杠常驻行
    const controls = [];
    let status = '';
    if (v.phase === 'over') {
      if (v.reveal && v.winner !== null) {
        const wn = (v.names && v.names[v.winner]) || this.wind(v.winner);
        status = this.wind(v.winner) + '·' + wn + ' 胡牌！' + (v.result || '');
      } else if (v.reveal) {
        status = '本局结束 · 摊牌中';
      } else {
        status = '本局结束：' + (v.result || '');
      }
      this.applyControls(status, controls);
      return;
    }

    const rp = this.ritualPhase(v);
    if (rp === 'wait' && v.ceremony) {
      const c = v.ceremony;
      const label = c.kind === 'deal' ? '掷骰开局' : c.kind === 'jing' ? '掷骰翻精' : '掷骰补牌';
      status = c.seat === v.mySeat ? '点桌面正中的「' + label + '」按钮' : '等待' + this.wind(c.seat) + '家「' + label + '」…';
      this.applyControls(status, controls);
      return;
    }
    if (rp === 'roll' && v.ceremony) {
      status =
        v.ceremony.kind === 'deal'
          ? '掷骰定方位 → 抓牌动画中…'
          : v.ceremony.kind === 'jing'
            ? '翻精掷骰 → 定位正精中…'
            : '掷骰定位补牌中…';
      this.applyControls(status, controls);
      return;
    }

    if (v.claims) {
      // 隐私：响应窗口里不点名还有谁在考虑（会泄露手牌匹配情况）
      status = '轮到你选择 — 碰 / 杠 / 吃 / 胡，或点「过」';
      for (const opt of v.claims.options) {
        if (opt.kind === 'chi') {
          for (const choice of opt.chiChoices || []) {
            const cap = choice.map((t) => tileName(t)).join(' ');
            controls.push({
              text: '吃 ' + cap,
              cap,
              act: { t: 'claim', kind: 'chi', chiTiles: choice },
              art: uiart.urlOf('chi'),
              artKey: 'chi',
            });
          }
        } else if (opt.kind === 'peng') {
          const t = tileName(opt.tile);
          controls.push({ text: '碰 ' + t, cap: t, act: { t: 'claim', kind: 'peng' }, art: uiart.urlOf('peng'), artKey: 'peng' });
        } else if (opt.kind === 'hu') {
          const label = opt.label || tileName(opt.tile);
          controls.push({
            text: opt.label ? '胡·' + opt.label : '胡 ' + tileName(opt.tile),
            cap: label,
            act: { t: 'claim', kind: 'hu' },
            art: uiart.urlOf('hu'),
            artKey: 'hu',
          });
        } else {
          const t = tileName(opt.tile);
          controls.push({ text: '杠 ' + t, cap: t, act: { t: 'claim', kind: 'gang' }, art: uiart.urlOf('gang'), artKey: 'gang' });
        }
      }
      controls.push({ text: '过', cap: '', act: { t: 'pass' }, ghost: true, art: uiart.urlOf('guo'), artKey: 'guo' });
      this.applyControls(status, controls);
      return;
    }

    for (const sg of v.selfGangs || []) {
      const cap = (sg.kind === 'angang' ? '暗杠' : '补杠') + ' ' + tileName(sg.tile);
      controls.push({
        text: cap,
        cap,
        act: { t: 'selfGang', kind: sg.kind, tile: sg.tile },
        art: uiart.urlOf('gang'),
        artKey: 'gang',
      });
    }
    if (v.canZimo) {
      const cap = v.zimoLabel ? '自摸·' + v.zimoLabel : '自摸';
      controls.push({ text: cap, cap, act: { t: 'zimo' }, art: uiart.urlOf('hu'), artKey: 'hu' });
      // 自摸也要给「过」：让手牌恢复可点（服务端对「自己回合的过」是空操作，本地撤行即可）
      controls.push({ text: '过', cap: '', act: { t: 'pass' }, ghost: true, art: uiart.urlOf('guo'), artKey: 'guo' });
    }

    if (v.canZimo) status = v.zimoLabel ? '可以自摸（' + v.zimoLabel + '）！' : '可以自摸！';
    else if (v.turn === v.mySeat)
      status =
        (v.mustDiscard || []).length > 0
          ? '必须先打出 ' + v.mustDiscard.map((t) => tileName(t)).join('、') + '（他人已展示）'
          : '轮到你了 — 点击手牌打出';
    else if (v.claimWindow) status = '等待其他玩家响应…' + (v.skipRon ? '（你已过水，暂不能点炮胡）' : '');
    else status = '等待' + this.wind(v.turn) + '家行动…';

    this.applyControls(status, controls);
  }

  applyControls(status, controls) {
    // compact 按**总钮数**（吃碰杠胡 + 报杠）算
    controls.forEach((c, i) => {
      c.idx = i;
      c.disabled = false;
    });
    const compact = controls.length + (this.declares || []).length >= 7;
    this.statusText = status;
    this.controls = controls;
    this.ctrlCompact = compact;
    this.syncCanvasStatus();
  }

  /**
   * 局内音效：按动作日志的新条目播。
   *   · 他人动作：一律按日志播；
   *   · 自己的动作：非托管时跳过 —— 手动出牌/吃碰杠胡走 onCanvasDiscard / onControl
   *     的**本地即时反馈**，日志再播一次就双响；
   *   · 自己的动作 + **托管中**（v.auto[mySeat]）：服务端代打，没有手动交互、也就没有
   *     本地即时音 —— 必须按日志播，否则托管期间出牌/吃碰杠胡整局无声
   *     （2026-11-05 用户报「自己开启托管后没有出牌音效和操作语音」）。
   *     用服务端回传的 auto 位而不是本地标记：断线代打（座位由托管接管）同样命中。
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
    const myAuto = Array.isArray(v.auto) ? v.auto[mySeat] === true : false;
    const GANG = { gang: 1, angang: 1, bugang: 1 };
    for (let i = 0; i < fresh.length; i++) {
      const a = fresh[i];
      if (!a) continue;
      if (a.seat === mySeat && !myAuto) continue; // 自己的动作：手动路径已有本地即时音；托管代打的由日志播
      if (a.kind === 'draw' && a.note) continue; // forceOver 的「流局」不算
      const opts = {};
      if (a.kind === 'hu') {
        // 胡分三条语音：杠开后自摸 = 杠开（服务端 note 只写自摸/点炮，靠紧邻上一条是否为杠推断）
        const prev = fresh[i - 1];
        const zimo = /自摸/.test(a.note || '');
        const gankai = zimo && prev && prev.seat === a.seat && GANG[prev.kind];
        opts.voice = gankai ? 'gangkai' : zimo ? 'zimo' : 'hu';
      }
      sound.playAction(a.kind, opts);
    }
  }

  /** 报杠钮集合（与吃碰杠胡并排；独立连点锁，见 game.js syncDeclares 注释） */
  syncDeclares(v) {
    const on = !!v && v.phase === 'playing';
    const list = on
      ? (v.declareOptions || []).map((t) => {
          const name = tileName(t);
          return { tile: t, name, cap: '报杠 ' + name, art: uiart.urlOf('gang'), artKey: 'gang' };
        })
      : [];
    const prev = this.declares || [];
    const same = list.length === prev.length && list.every((x, i) => prev[i] && prev[i].tile === x.tile);
    if (!same) {
      this.declares = list;
      this.declareBusy = false;
      return;
    }
    if (this.declareBusy && this._declareView !== v) this.declareBusy = false;
  }

  onDeclareTap(tile) {
    if (this.declareBusy) return;
    if (!Number.isInteger(tile) || tile < 0) return;
    const v = this.view;
    if (!v || v.phase !== 'playing' || v.turn !== v.mySeat || v.claimWindow) return;
    sound.unlock();
    sound.playAction('declare'); // 走语音包；无语音时自动退杠音效
    this._declareView = v;
    this.declareBusy = true;
    nav.send({ t: 'declareKong', tile });
    // 兜底解锁：服务端拒绝时只回 error、不一定有新 view
    if (this._declareTimer) clearTimeout(this._declareTimer);
    this._declareTimer = setTimeout(() => {
      this._declareTimer = null;
      this.declareBusy = false;
    }, 2500);
  }

  onControl(idx) {
    const item = (this.controls || [])[idx];
    if (!item || item.disabled) return;
    // 自摸「过」：本地撤行即可（服务端对「自己回合的过」是空操作）
    if (item.act.t === 'pass' && (!this.view || !this.view.claims)) {
      sound.playAction('pass', { voice: 'guo' }); // 「过」也有人声
      nav.send({ t: 'pass' });
      this.applyControls(this.statusText, []);
      return;
    }
    sound.unlock();
    nav.send(item.act);
    this.lockControls();
    // 统一走 playAction：语音优先、缺/关则退原音效（与小程序端同一套判定）
    const k = item.act && item.act.kind;
    if (item.act.t === 'pass') sound.playAction('pass', { voice: 'guo' });
    else if (item.act.t === 'zimo') sound.playAction('hu', { voice: 'zimo' });
    else if (k) sound.playAction(k);
  }

  lockControls() {
    this.controls = (this.controls || []).map((c) => Object.assign({}, c, { disabled: true }));
  }

  /**
   * 画布手牌第 1 击（2026-11-04 两段式防误触）：
   *   · 托管中（autoOn）：点手牌 = 想自己接管，**随时**都可触发（不要求自己回合），
   *     只解除托管 + 提示，不抬牌、不出牌（命中入口在 table.hitTest 的 cancelEnabled 分支）。
   *   · 非托管：仅自己回合且无响应窗口才「抬高」待出（真出牌在 onCanvasDiscard 第 2 击）。
   */
  onCanvasRaise(tile) {
    const v = this.view;
    if (!v || v.phase !== 'playing') return;
    // 托管中：点手牌随时取消托管（先于回合守卫，故别人回合也能解除）
    if (this.autoOn) {
      this.cancelAutoByTouch();
      return;
    }
    if (v.turn !== v.mySeat || v.claimWindow) return;
    sound.unlock();
    sound.play('click', { minGap: 90 });
  }

  /**
   * 手牌交互解除托管（2026-11-05）：发 setAuto:false + 提示。
   * 回执（下一次 view 广播 auto=false）到达前用 _autoCancelPending 挡重发 ——
   * 广播回执会把 autoOn 置 false 并清掉标记（见 renderGame 的 autoOn 赋值处）；
   * 若服务端拒绝/没回，标记保持，用户仍可走 🤖 钮显式切换。
   */
  cancelAutoByTouch() {
    if (this._autoCancelPending) return;
    this._autoCancelPending = true;
    // 兜底（2026-11-05）：回执（view.auto=false）若 2s 内没到（旧视图/丢包/服务端状态
    // 与客户端不一致），放开标记允许再点一次 —— 否则 _autoCancelPending 会永久卡住，
    // 表现为「提示已解除、按钮还亮、又出不了牌」（用户 2026-11-05 报）。
    if (this._autoCancelTimer) clearTimeout(this._autoCancelTimer);
    this._autoCancelTimer = setTimeout(() => {
      this._autoCancelTimer = null;
      this._autoCancelPending = false;
    }, 2000);
    nav.send({ t: 'setAuto', auto: false });
    toast.push('已解除托管，可继续出牌', 1600);
  }

  /** 画布手牌第 2 击（同牌再点）打出（C1 语义 + 两段式）：只有「轮到我且无响应窗口」才出牌 */
  onCanvasDiscard(tile) {
    const v = this.view;
    if (!v || v.phase !== 'playing' || v.turn !== v.mySeat || v.claimWindow) return;
    sound.unlock();
    sound.play('click', { minGap: 90 });
    this.tryDiscard(tile);
  }

  /** 状态行文案下发给画布（table.drawStatusBar 读） */
  syncCanvasStatus() {
    if (!this.table) return;
    this.table.statusBar = {
      err: this.controlsErrShown ? this.controlsErrText || '' : '',
      text: this.statusText || '',
      waits: this.waitsText || '',
      countdown: this.countdownShown ? this.countdownText || '' : '',
      settle: !!this.settleRestoreShown,
      prepReady: !!this.settleNextDisabled, // 结算后「准备」胶囊：已点 → 显示「已准备」
    };
  }

  /** 出牌唯一出口：报杠两条拦截先于发信（对位 tryDiscard） */
  tryDiscard(tile) {
    const v = this.view;
    if (v) {
      if ((v.declared || []).some((d) => d.seat === v.mySeat && d.tile === tile)) {
        toast.push('已展示的 ' + tileName(tile) + ' 要等第 4 张，不能打');
        return;
      }
      if ((v.mustDiscard || []).length > 0 && v.mustDiscard.indexOf(tile) < 0) {
        toast.push('必须先打出 ' + v.mustDiscard.map((t) => tileName(t)).join('、'));
        return;
      }
    }
    sound.unlock();
    sound.play('discard');
    nav.send({ t: 'discard', tile });
  }

  /* ---------------- 倒计时（每帧调用，200ms 文案节流） ---------------- */

  tickCountdown() {
    const v = this.view;
    if (v && v.phase === 'playing' && v.windowDeadline) {
      const left = Math.max(0, v.windowDeadline - Date.now());
      const text = '⏱ ' + (left / 1000).toFixed(1) + 's';
      if (text !== this.lastCountdownText) {
        this.lastCountdownText = text;
        this.countdownText = text;
        this.countdownShown = true;
        this.syncCanvasStatus();
      }
    } else if (this.lastCountdownText !== '') {
      this.lastCountdownText = '';
      this.countdownShown = false;
      this.countdownText = '';
      this.syncCanvasStatus();
    }
  }

  /* ---------------- 掷骰覆盖层（对局内仪式） ---------------- */

  diceResultText(v) {
    const c = v.ceremony;
    if (!c || !c.dice) return '';
    if (c.kind === 'deal') {
      const sum = c.dice[0] + c.dice[1];
      const small = Math.min(c.dice[0], c.dice[1]);
      const pos = ((sum - 1) % 4) + 1;
      const seat = (v.dealer + sum - 1) % 4;
      return '点数和 ' + sum + ' → 庄家起逆时针第 ' + pos + ' 位（' + this.wind(seat) + '门前） · 小点 ' + small + ' → 空 ' + small + ' 列、第 ' + (small + 1) + ' 列起牌';
    }
    const sum = c.dice[0] + c.dice[1];
    // 赣州的精墩/补牌定位是「牌墙尾倒数第 S 墩」，与南昌「逆时针第 S 列」不同口径
    if (v.variant === 'ganzhou') {
      if (c.kind === 'jing') return '点数和 ' + sum + ' → 牌墙尾倒数第 ' + sum + ' 墩 · 翻开上层 = 正精';
      return '点数和 ' + sum + ' → 牌墙尾倒数第 ' + sum + ' 墩 · 上层取牌（无则取下层）';
    }
    if (c.kind === 'jing') return '点数和 ' + sum + ' → 摸牌处逆时针第 ' + sum + ' 列 · 上层翻开 = 正精';
    return '点数和 ' + sum + ' → 摸牌处逆时针第 ' + sum + ' 列 · 上层取牌（无则取下层）';
  }

  playDice(v) {
    const c = v.ceremony;
    if (!c || c.state !== 'rolling' || c.rollAt === null || c.until === null) return;
    const dur = Math.max(400, c.until - c.rollAt);
    const tumbleMs = Math.min(c.kind === 'gang' ? 1500 : 2200, Math.floor(dur * 0.5));
    if (this.diceKey === c.rollAt) return;
    this.diceKey = c.rollAt;
    // 骰子阶段让位：收掉面板（记录 / 聊天在骰子阶段隐藏）
    if (this.logOpen || this.chatOpen) {
      this.logOpen = false;
      this.chatOpen = false;
      this.quickShown = false;
      this.emojiShown = false;
      this.blurChat();
    }
    const msg = c.kind === 'deal' ? '庄家掷骰…' : c.kind === 'jing' ? '翻精掷骰…' : '杠后掷骰…';
    const dice = c.dice || [1, 1];
    this.diceFx.run(dice, msg, this.diceResultText(v), tumbleMs, dur + 550);
  }

  clearDice() {
    if (!this.diceFx.shown) return;
    this.diceFx.clear();
  }

  /* ---------------- 侧边面板（记录 / 聊天） ---------------- */

  onToggleLog() {
    this.menuOpen = false;
    if (this.logOpen) {
      this.logOpen = false;
      return;
    }
    if (this.view) this.renderLog(this.view); // 打开时补齐最新记录
    this.logOpen = true;
    this.chatOpen = false;
    this.quickShown = false;
    this.emojiShown = false;
    this.blurChat();
  }

  onToggleChat() {
    this.menuOpen = false;
    if (this.chatOpen) {
      this.chatOpen = false;
      this.blurChat();
      return;
    }
    this.chatOpen = true;
    this.logOpen = false;
    this.quickShown = false;
    this.emojiShown = false;
    this.chatUnread = 0;
    state.chatUnread = 0;
    this.chatScroll = 1e9; // 打开就落到最新一条
  }

  /**
   * 点自己的铭牌 → 开聊天面板并**强制展开快捷短语**（点一下即发）。
   * 与 onToggleChat 同入口同语义，但 onToggleChat 打开时 quickShown=false
   * （还要再点一下输入框旁的 💬 才出短语）；这里一步到位，契合「点铭牌直接发聊天」。
   */
  openQuickChat() {
    this.menuOpen = false;
    this.chatOpen = true;
    this.logOpen = false;
    this.emojiShown = false;
    this.quickShown = true;
    this.chatUnread = 0;
    state.chatUnread = 0;
    this.chatScroll = 1e9;
  }

  /* ---------------- 聊天 ---------------- */

  onChatFieldTap() {
    if (this.chatFocus) return; // 已聚焦：不重复 showKeyboard（系统键盘会闪一下）
    this.chatFocus = true;
    inputFocus({
      value: this.chatInput,
      maxLength: CHAT_TEXT_MAX,
      confirmType: 'send',
      onInput: (v) => {
        this.chatInput = v;
      },
      onConfirm: () => this.onSendChat(),
      onBlur: () => {
        this.chatFocus = false;
      },
    });
  }

  blurChat() {
    if (this.chatFocus) {
      this.chatFocus = false;
      inputBlur();
    }
  }

  onSendChat() {
    const text = String(this.chatInput || '').trim();
    if (!text) return;
    nav.send({ t: 'chat', text });
    this.chatInput = '';
  }

  onTogglePop(which) {
    if (which === 'quick') {
      this.quickShown = !this.quickShown;
      this.emojiShown = false;
    } else {
      this.emojiShown = !this.emojiShown;
      this.quickShown = false;
    }
  }

  onChatChip(text) {
    nav.send({ t: 'chat', text });
    this.quickShown = false;
    this.emojiShown = false;
  }

  onChat(msg) {
    this.chatMsgs = this.chatMsgs.concat([
      { seat: msg.seat, name: msg.name, text: msg.text, self: msg.seat === state.mySeat },
    ]);
    if (this.chatMsgs.length > CHAT_MAX) this.chatMsgs.shift();
    this.chatScroll = 1e9;
    // 未读只在聊天面板没打开时累加
    if (msg.seat !== state.mySeat && !this.chatOpen) {
      this.chatUnread = Math.min((this.chatUnread || 0) + 1, 999);
      state.chatUnread = this.chatUnread;
    }
    if (this.table) this.table.pushBubble(msg.seat, msg.text, 'text');
  }

  renderLog(v) {
    const names = v.names || [];
    const src = (v.log || []).slice(-LOG_ROWS_MAX);
    const rows = src.map((entry) => ({
      seq: entry.seq,
      seatName: entry.seat >= 0 ? names[entry.seat] || '座位' + (entry.seat + 1) : '系统',
      action: LOG_ACTION_LABEL[entry.kind] || entry.kind,
      actionClass: entry.kind,
      tiles: (entry.tiles || []).map((t) => tileName(t)).join(''),
      note: entry.note || '',
    }));
    const key = rows.length ? String(rows[rows.length - 1].seq) : '';
    if (key === this.logKey) return;
    this.logKey = key;
    this.logRows = rows;
    this.logScroll = 1e9; // 跟随最新一步
  }

  /* ---------------- 互动表情 ---------------- */

  openEmotePicker(preselect) {
    const v = this.view;
    if (!v) return;
    const mySeat = v.mySeat;
    const targets = [];
    for (let seat = 0; seat < 4; seat++) {
      if (seat === mySeat) continue;
      targets.push({
        seat,
        label: this.relSeatName(seat) + ' ' + this.wind(seat) + '·' + this.seatNickname(seat),
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
    this.emoteShown = true;
    this.emoteTargets = targets;
    this.emoteGroups = groups;
  }

  onEmoteTarget(seat) {
    this.emoteTargetSeat = seat;
    this.emoteTargets = this.emoteTargets.map((t) => Object.assign({}, t, { active: t.seat === seat }));
  }

  onEmoteCell(id) {
    if (this.emoteTargetSeat === null || this.emoteTargetSeat === undefined) return;
    nav.send({ t: 'emote', target: this.emoteTargetSeat, emote: id });
    this.emoteShown = false;
  }

  onEmoteOpen() {
    this.openEmotePicker();
  }

  onEmoteClose() {
    this.emoteShown = false;
    this.emoteTargetSeat = null;
  }

  onEmote(msg) {
    const fx = throwEmojiOf(msg.emote);
    if (!fx) return;
    if (this.table) {
      this.table.pushEmote(msg.from, msg.target, fx.icon);
      this.table.pushBubble(msg.target, fx.icon + ' ' + fx.name, 'emote');
    }
    this.chatMsgs = this.chatMsgs.concat([
      {
        seat: msg.from,
        name: this.seatNickname(msg.from),
        text: '向' + this.relSeatName(msg.target) + '扔了 ' + fx.icon + fx.name,
        self: msg.from === state.mySeat,
      },
    ]);
    if (this.chatMsgs.length > CHAT_MAX) this.chatMsgs.shift();
  }

  /* ---------------- 结算 ---------------- */

  onSettle(m) {
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
        const jingDesc = r.jingFinal === 0 ? '—' : r.jingFinal + ((r.jingCombos || []).some((c) => c.jingba) ? ' ·精霸' : '');
        return {
          me: r.seat === (this.view ? this.view.mySeat : -1),
          cells: [
            { text: nameOf(r.seat) },
            { text: String(r.pi) },
            { text: String(r.fu) },
            { text: jingDesc },
            { text: cgs.length > 0 ? cgs.map((x) => '×' + x).join('') : '—' },
            { text: r.pattern > 0 ? String(r.pattern) : '—' },
            { text: r.gang > 0 ? String(r.gang) : '—' },
            { text: String(r.total) },
            { text: fmtDelta(r.delta), cls: 'total-col ' + (r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : '') },
            { text: fmtDelta(tv), cls: 'total-col ' + (tv > 0 ? 'pos' : tv < 0 ? 'neg' : '') },
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
            { text: fmtIn(r.patternIn), cls: r.patternIn > 0 ? 'pos' : '' },
            { text: fmtOut(r.patternOut), cls: r.patternOut > 0 ? 'neg' : '' },
            { text: fmtIn(r.jingIn), cls: r.jingIn > 0 ? 'pos' : '' },
            { text: fmtOut(r.jingOut), cls: r.jingOut > 0 ? 'neg' : '' },
            { text: fmtDelta(r.delta), cls: 'total-col ' + (r.delta > 0 ? 'pos' : r.delta < 0 ? 'neg' : '') },
            { text: fmtDelta(tv), cls: 'total-col ' + (tv > 0 ? 'pos' : tv < 0 ? 'neg' : '') },
          ],
        };
      });
    }
    const totalsText = (m.totals || []).map((t) => t.name + ' ' + (t.value >= 0 ? '+' : '') + t.value).join('　');
    // 结算艺术字键以**本局赢家**判定（单局结算时 phase 还是 playing）
    const v = this.view;
    const mySeat = v ? v.mySeat : -1;
    let artKey = '';
    const win = m.winner !== undefined ? m.winner : m.gz ? m.gz.winner : undefined;
    if (win === null) artKey = 'draw';
    else if (win !== undefined) artKey = win === mySeat ? 'win' : 'lost';
    else if (v && v.phase === 'over') artKey = v.winner === null || v.winner === undefined ? 'draw' : v.winner === mySeat ? 'win' : 'lost';
    this.settleArtKey = artKey;
    // 默认不直接弹面板：牌桌保留亮牌，状态行右侧挂「本局结算 ▲」入口
    const settleWinTile =
      m.winTile !== undefined && m.winTile !== null
        ? '胡牌张：' + tileName(m.winTile) + (m.winVia === 'zimo' ? '（自摸）' : m.winVia === 'ron' ? '（点炮）' : '')
        : '';
    this.settleShown = false;
    this.settleTitle = m.title;
    this.settleWinTile = settleWinTile;
    this.settleHead = head;
    this.settleRows = rows;
    this.settleNotes = m.notes || [];
    this.settleTotals = '累计子：' + totalsText;
    this.settleRestoreShown = true;
    this.settleNextDisabled = false;
    this.settleScroll = 0;
    this.syncCanvasStatus();
  }

  onSettleHide() {
    this.settleShown = false;
    this.settleRestoreShown = true;
    this.syncCanvasStatus();
  }

  onSettleRestore() {
    this.settleShown = true;
    this.settleRestoreShown = false;
    this.syncCanvasStatus();
  }

  onSettleNext() {
    this.settleNextDisabled = true;
    nav.send({ t: 'nextRound' });
  }

  /* ---------------- 其它路由回调 ---------------- */

  onEvent(msg) {
    const text = (msg && msg.text) || '';
    if (!text) return;
    if (PLAY_ACTION_EVENT.test(text)) return;
    toast.push(text, 2500);
  }

  /** 错误提示借用状态行显示，4s 自动让位（对位 onError） */
  onError(reason) {
    if (this._errTimer) clearTimeout(this._errTimer);
    this.controlsErrText = reason;
    this.controlsErrShown = true;
    this.syncCanvasStatus();
    this._errTimer = setTimeout(() => {
      this._errTimer = null;
      if (!this.controlsErrShown) return;
      this.controlsErrShown = false;
      this.syncCanvasStatus();
      if (this.view) this.renderControls(this.view);
    }, 4000);
  }

  onSwapAsk(msg) {
    this.swapAskShown = true;
    this.swapAskText = this.wind(msg.from) + '家「' + msg.fromName + '」想与你交换座位，是否同意？';
  }

  onSwapRespond(accept) {
    this.swapAskShown = false;
    nav.send({ t: 'swapRespond', accept });
  }

  onDissolved(msg) {
    this.dissolvedShown = true;
    this.dissolvedTitle = msg.title;
    this.dissolvedRows = (msg.rows || []).map((r) => ({ name: r.name, value: r.value }));
  }

  onDissolvedOk() {
    this.dissolvedShown = false;
    nav.resetChat();
    net.closeSocket();
    nav.navigate('home');
  }

  onAuto() {
    if (!net.isOpen()) return;
    nav.send({ t: 'setAuto', auto: !this.autoOn });
  }

  /**
   * 声音设置（2026-11-04）：合并菜单 ⚙️ 打开画布版面板。
   * **取代**了原来的 🎵 单钮 —— 那个只能切 BGM 开关，音量/音效/语音包都没有入口；
   * 现在一处全管，且与小程序端（右轨 ⚙️）语义一致。
   * 原来这里还有 onToggleBgm（直接翻 sound.setBgmEnabled），已删除：
   * 面板里改的是 settings，BGM 开关状态由 settings 单向下发给 sound，
   * 留两条写入口只会让「开关显示」和「实际状态」有机会不一致。
   */
  onSettingsOpen() {
    settingsPanel.open(this);
    this.menuOpen = false; // 打开面板顺手收起 ☰，避免两层浮层叠着
  }

  /**
   * 退出本局（2026-11-05 用户需求）：顶栏 ‹ 的**唯一**语义，任何人（含房主）点都只退出
   * 自己这一局 —— 服务端把该座位交给托管代打至本局结束，牌局继续、另外三家完全不受影响。
   * 自己回到房间页（大厅），本局结束后座位还在，可继续准备下一局。
   * 旧「解散对局」（房主强制结束全场）已从 UI 移除，服务端 abort 分支仅为兼容老客户端保留。
   */
  onQuit() {
    this.quitAskShown = true;
  }

  onQuitConfirm(accept) {
    this.quitAskShown = false;
    if (!accept) return;
    if (!net.isOpen()) {
      toast.push('连接已断开，无法退出本局：请返回首页重连', 3000);
      return;
    }
    nav.send({ t: 'quit' });
    toast.push('已退出本局，托管代打至本局结束', 1800);
    // 服务端随后会回一条 state（playing=true）→ nav 同样会跳房间页（同一场景，幂等）；
    // 这里先跳是为了点击立刻有反馈。
    nav.navigate('lobby');
  }

  onVariant(msg) {
    if (msg.totals && this.view) {
      const v = Object.assign({}, this.view, { totals: msg.totals });
      this.view = v;
      if (this.table) this.table.render(v);
    }
    toast.push('玩法已切换为「' + variantName(msg.variant) + '」' + (msg.cleared ? '，积分已清零' : ''));
  }

  /* ---------------- 触摸（设置面板 → chrome → 牌桌） ---------------- */

  onTouchDown(x, y) {
    // 设置面板在最上层：在屏时吞掉一切触摸（含面板内空白），绝不漏给侧轨/牌桌
    if (settingsPanel.down(x, y, this)) return;
    if (chrome.down(x, y, this)) return;
    this._tableDown = this.Lg && draw.hit(this.Lg.table, x, y);
  }

  onTouchMove(x, y) {
    if (settingsPanel.move(x, y, this)) return; // 面板拖动滑条
    if (chrome.move(x, y, this)) this._tableDown = false;
  }

  onTouchUp() {
    if (settingsPanel.up(this)) return; // 抬起即把滑条值落盘
    chrome.up(this);
  }

  onTouchCancel() {
    if (settingsPanel.up(this)) return;
    chrome.up(this);
    this._tableDown = false;
  }

  onTap(x, y) {
    if (settingsPanel.tap(x, y, this)) return; // 面板在屏：只走面板
    if (chrome.tap(x, y, this)) return;
    if (!this._tableDown) return;
    this._tableDown = false;
    const Lg = this.Lg;
    if (!Lg || !this.table) return;
    if (x < Lg.table.x || x > Lg.table.x + Lg.table.w || y < Lg.table.y || y > Lg.table.y + Lg.table.h) return;
    const lx = ((x - Lg.table.x) * 1280) / Lg.table.w;
    const ly = ((y - Lg.table.y) * 640) / Lg.table.h;
    this.table.hitTest(lx, ly);
  }
}

/* input 延迟引用（与 home 场景同一手法，避免 require 环） */
let _input = null;
function inputFocus(f) {
  if (!_input) _input = require('../input.js');
  _input.focus(f);
}
function inputBlur() {
  if (_input) _input.blur();
}

module.exports = GameScene;
