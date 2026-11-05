/**
 * 引导 + 主循环（小程序端 app.js + Page 框架的对位物）。
 *
 * 职责：
 *   1. 创建屏上主画布（wx.createCanvas 第一次调用）与 Table 的离屏宿主；
 *   2. 注册全局生命周期（wx.onShow/onHide → net 前后台；wx.onWindowResize → 布局重算）；
 *   3. 注册分享（对位 onShareAppMessage）并消费启动参数里的房间码；
 *   4. 注册场景工厂、boot 首场景；
 *   5. 单一 rAF 主循环：场景渲染 → 转场遮罩 → toast（自上而下三层，都不重入）。
 */

const app = require('./app.js');
const layout = require('./layout.js');
const state = require('./state.js');
const nav = require('./nav.js');
const input = require('./input.js');
const toast = require('./ui/toast.js');
const net = require('../utils/net.js');
const sound = require('../utils/sound.js');
const voice = require('../utils/voice.js');
const wxauth = require('../utils/wxauth.js');
// 隐私授权（2026-11-04）：注册 wx.onNeedPrivacyAuthorization 必须**先于任何隐私 API**
// （官方文档 Q3 注意），所以 import 后立刻 install —— 它只挂监听不弹窗，零副作用。
const privacy = require('../utils/privacy.js');
const HomeScene = require('./scenes/home.js');
const LobbyScene = require('./scenes/lobby.js');
const GameScene = require('./scenes/game.js');

function windowInfo() {
  try {
    if (wx.getWindowInfo) return wx.getWindowInfo();
  } catch (e) {
    /* 落到 getSystemInfoSync */
  }
  return wx.getSystemInfoSync();
}

/* ---- 1. 画布 ---- */

const info = windowInfo();
const L0 = layout.compute(); // 内部同样读窗口信息，dpr 口径一致
app.dpr = L0.dpr;
app.canvas = wx.createCanvas(); // 第一次调用 = 屏上画布（后续调用返回离屏画布）
app.canvas.width = Math.round(L0.sw * L0.dpr);
app.canvas.height = Math.round(L0.sh * L0.dpr);
app.ctx = app.canvas.getContext('2d');

function resizeCanvas() {
  layout.dirty();
  const L = layout.compute();
  app.canvas.width = Math.round(L.sw * L.dpr);
  app.canvas.height = Math.round(L.sh * L.dpr);
}

/**
 * Table 的离屏宿主：优先 wx.createOffscreenCanvas（对象签名，基础库 ≥ 2.16.1，
 * 与 table.js 内部 newCanvas 同一套口径）；拿不到就退「第二次 wx.createCanvas()」——
 * 小游戏里后续调用本就返回离屏画布。都没有则置 null（对局场景降级为只画 chrome）。
 */
function createTableHost() {
  try {
    if (typeof wx.createOffscreenCanvas === 'function') {
      const c = wx.createOffscreenCanvas({ type: '2d', width: 1280, height: 640 });
      if (c && typeof c.getContext === 'function' && c.getContext('2d')) return c;
    }
  } catch (e) {
    console.warn('[main] createOffscreenCanvas 不可用：', e && e.message);
  }
  try {
    const c = wx.createCanvas();
    if (c && typeof c.getContext === 'function' && c.getContext('2d')) return c;
  } catch (e) {
    console.warn('[main] 离屏宿主创建失败：', e && e.message);
  }
  return null;
}
app.tableHost = createTableHost();

/* ---- 2. 生命周期 / 全局选项 ---- */

try {
  if (wx.setInnerAudioOption) wx.setInnerAudioOption({ obeyMuteSwitch: false });
} catch (e) {
  /* 老基础库 / 非 iOS 忽略 */
}
// 启动段整体兜底：任何异常画到屏上（黑屏排查不再靠猜）+ 上报 wx.onError
let bootError = '';
try {
  wxauth.setClient('mg'); // 语音端标识：登录/签名端点按 client 选小游戏 appid/secret
} catch (e) {
  bootError = (e && (e.stack || e.message)) || String(e);
  console.error('[main] 启动异常：', bootError);
}
try {
  if (wx.onError) wx.onError((err) => { bootError = String(err); });
  if (wx.onUnhandledRejection) wx.onUnhandledRejection((r) => { bootError = String((r && r.reason) || r); });
} catch (e) { /* 老基础库忽略 */ }
net.setStatusHandler(() => {});
input.install();
input.installKeyboard();
privacy.install(); // onNeedPrivacyAuthorization 注册（文档要求先于一切隐私 API）
// 弹窗在屏时触摸全量拦截（不透给场景）：down 记按压态，up 结算同意/拒绝/指引链接。
// shown() 供 input.dispatch 判「按下被弹窗吃掉后的抬起」该归层还是归场景。
input.setInterceptor({
  down: (x, y) => privacy.down(x, y),
  up: (x, y) => privacy.up(x, y),
  shown: () => privacy.shown(),
});
if (wx.onWindowResize) wx.onWindowResize(resizeCanvas);

wx.onShow((opts) => {
  // 切回前台：socket 可能被系统回收，立刻补一次重连（对位 app.js onShow）
  net.onAppShow();
  consumeShareQuery(opts);
  // 对局中切回：续播 BGM（对位 game 页 onShow 的 bgmStart）。
  // 在语音房时不续：VoIP 占用通话通道，BGM 由 voice 状态机统一调度（applyVoice）。
  if (nav.sceneName() === 'game' && voice.status().state !== 'joined') sound.bgmStart();
});
wx.onHide(() => {
  net.onAppHide();
  // 切后台暂停 BGM（对位 game 页 onHide 的 bgmPause）
  sound.bgmPause();
});

/* ---- 3. 分享 ---- */

/**
 * 消费启动 / 切前台带的分享 query（room=码）。
 *
 * 去重：微信在每次 onShow 都会回放**同一份**启动 query（iOS 从后台切回也带着旧 room），
 * 不去重会把刚离开房间的人反复拽回邀请房间。所以只消费「没消费过、且不是当前房间」的码。
 */
let consumedShareRoom = '';
function consumeShareQuery(opts) {
  const q = opts && opts.query;
  const room = q && q.room ? String(q.room).toUpperCase().slice(0, 6) : '';
  if (!room) return;
  if (room === consumedShareRoom) return; // 同一张卡片的重复 onShow
  consumedShareRoom = room;
  if (room === String(state.roomCode || '').toUpperCase()) return; // 已经在这个房间里
  state.launchRoom = room;
  // 不在首页（大厅 / 牌桌）时点开新邀请：先回首页，由 home.enter() 自动进房
  const here = nav.sceneName();
  if (here && here !== 'home') nav.navigate('home');
}
function setupShare() {
  try {
    if (wx.showShareMenu) wx.showShareMenu({});
    // 被动分享（右上角菜单转发）：标题按当前场景（对位各页 onShareAppMessage），
    // query 带房间码，新玩家冷启动直达建房预填
    wx.onShareAppMessage(() => {
      const code = state.roomCode;
      const q = code ? 'room=' + code : '';
      const name = nav.sceneName();
      if (name === 'lobby') return { title: '来一局麻将（房间 ' + code + '）', query: q };
      if (name === 'game') return { title: '麻将 · 房间 ' + code, query: q };
      return { title: '来一局麻将', query: q };
    });
  } catch (e) {
    /* 老基础库忽略 */
  }
}
setupShare();
consumeShareQuery(wx.getLaunchOptionsSync ? wx.getLaunchOptionsSync() : null);

/* ---- 4. 场景 ---- */

nav.register({
  home: () => new HomeScene(),
  lobby: () => new LobbyScene(),
  game: () => new GameScene(),
});
// CDN 资源预热（清单 + 位图 + 音频）：与首场景并发后台拉取。等玩家进对局时
// 贴图九成已就绪，牌桌首帧即贴图 —— 消除「先兜底样式、资源到位再闪回来」。
const preload = require('./preload.js');
preload.warmup();

nav.boot('home');

/* ---- 5. 主循环 ---- */

const raf =
  typeof requestAnimationFrame === 'function'
    ? (cb) => requestAnimationFrame(cb)
    : app.canvas.requestAnimationFrame.bind(app.canvas);

function frame() {
  raf(frame);
  const L = layout.compute();
  const ctx = app.ctx;
  ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  // 场景层（全屏自绘）
  const s = nav.scene();
  if (s && typeof s.render === 'function') {
    try {
      s.render(ctx, L);
    } catch (e) {
      // 渲染异常不能打断主循环：打日志 + 兜底清屏，避免花屏残留
      console.error('[main] 场景渲染异常：', e);
      ctx.fillStyle = '#14241c';
      ctx.fillRect(0, 0, L.sw, L.sh);
    }
  }
  // 转场遮罩（170ms 淡出 / 220ms 淡入，对位 .page-leaving / .page-fade-in）
  const a = nav.fadeAlpha();
  if (a > 0) {
    ctx.globalAlpha = a;
    ctx.fillStyle = '#14241c';
    ctx.fillRect(0, 0, L.sw, L.sh);
    ctx.globalAlpha = 1;
  }
  // toast 永远最顶（跨场景存活，见 ui/toast.js 注释）
  toast.render(ctx, L);
  // 隐私弹窗（2026-11-04）：盖过 toast —— 授权等待期任何下层交互都无意义，
  // 且文档要求曝光/点击上报，弹窗必须可见可点。render 返回在屏与否供触摸拦截。
  privacy.setHit(privacy.render(ctx, L));
  // 启动/运行异常屏显（黑屏排查：红字前 3 行，点按不清除）
  if (bootError) {
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, L.sh - 74, L.sw, 74);
    ctx.fillStyle = '#ff8a80';
    ctx.font = '11px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    bootError.split(String.fromCharCode(10)).slice(0, 3).forEach((line, i2) => {
      ctx.fillText(String(line).slice(0, 90), 8, L.sh - 70 + i2 * 22);
    });
  }
}
raf(frame);
