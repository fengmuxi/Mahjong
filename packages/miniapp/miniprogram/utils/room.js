/**
 * 房间路由：把服务端消息分发到当前页面，并在页面间跳转。
 *
 * web 端是单页（三个 section 切换显隐）；小程序是三个 Page，导航会重建页面实例，
 * 因此「跨页面共享量」放 app.globalData，消息统一由这里收敛后再回调给当前页面：
 *   · state → 大厅页（不在大厅则 redirectTo）
 *   · game  → 对局页（不在对局则 redirectTo）
 *   · 其余  → 当前页面的同名钩子（onChat / onEmote / onSettle / onSwapAsk / onDissolved / onVariant / onEvent / onError）
 *
 * 协议与 web 端完全一致（shared 的 ServerMsg），不做任何字段改写。
 */

const net = require('./net.js');
const store = require('./store.js');

const app = () => getApp().globalData;

let current = null; // { name, ctx }
/** 自动 resume 标记：凭本地 token 回桌失败时用它决定「回向导」的降级路径 */
let autoResume = false;
/** 「服务端不认识的消息」只打印一次（见 case 'error' 的未知消息分支） */
let unknownWarned = false;

/**
 * 跳转合并（2026-10-18 修「已经开始下一局却卡在准备界面」）。
 *
 * 服务端在「点下一局 / 全员准备」这类时机，会在**同一毫秒**内连发两条消息：
 * 大厅态 `state`（收桌）+ 新一局的 `game`。若收到一条就立刻 `redirectTo`：
 *   1. `state` 先把人从对局页踹回大厅；
 *   2. 紧接着的 `game` 落在**正在销毁**的对局页上（`current` 还是旧页），
 *      回调打进死页面 → 不跳转；
 *   3. 人停在准备界面，而新一局正在等玩家掷骰 → 之后不再有 `game` 广播 → 永久卡死。
 * 所以跳转统一走 `navigate()`：压到本 tick 末，**只保留最后一个目标**。
 */
let navTarget = null;
let navTimer = null;
/** 正在跳往的页面名（落地前不再重复跳；由新页 attach 清空） */
let navInFlight = null;

/** 当前「认为」自己在哪一页：**待跳目标 > 在途目标 > 当前页**（旧页正在销毁，不可信） */
function destName() {
  if (navTarget) return navTarget.name;
  if (navInFlight) return navInFlight;
  return current ? current.name : null;
}

function navigate(name, url) {
  if (navInFlight === name) return;
  navTarget = { name, url };
  if (navTimer) return;
  navTimer = setTimeout(flushNav, 0);
}

function flushNav() {
  navTimer = null;
  const t = navTarget;
  navTarget = null;
  if (!t) return;
  if (navInFlight === t.name) return;
  if (navInFlight && navInFlight !== t.name) {
    // 上一次跳转还没落地：先让它完成，60ms 后再补这一次（同时发两个 redirectTo 会被吞）
    navTarget = t;
    navTimer = setTimeout(flushNav, 60);
    return;
  }
  // 转场淡出（2026-10-18）：redirectTo 是硬切，直接换页会有一次跳变闪动。
  // 先把当前页根节点淡出（.page-leaving，160ms）再跳，配合新页的 220ms 淡入，
  // 两次硬切缝成一次交叉溶解。只在页面声明了 pageLeaving 数据位时启用（home/lobby/game）。
  const cur = current && current.ctx;
  if (cur && cur.data && cur.data.pageLeaving === false) {
    // 先占住在途目标：淡出的 170ms 窗口内 destName 以目标页为准，
    // 防止 state→game 竞态在淡出窗口里回潮（见上方「跳转合并」）
    navInFlight = t.name;
    cur.setData({ pageLeaving: true });
    setTimeout(() => {
      // 淡出期间可能又来了新目标（旧服务端 state→game 连发）：以最新的为准
      const latest = navTarget && navTarget.name !== t.name ? navTarget : t;
      navTarget = null;
      wx.redirectTo({
        url: latest.url,
        fail: () => {
          navInFlight = null;
          current = null;
        },
      });
    }, 170);
    return;
  }
  navInFlight = t.name;
  wx.redirectTo({
    url: t.url,
    fail: () => {
      // 跳转失败：把路由交还 ensureCurrent 自愈，别让 current 停在死页面上
      navInFlight = null;
      current = null;
    },
  });
}

function call(hook, arg) {
  if (current && current.ctx && typeof current.ctx[hook] === 'function') {
    current.ctx[hook](arg);
  }
}

/**
 * 兜底：current 为空时按页面栈顶的 route 重新挂上。
 * 这类「路由丢失」的失败是**静默**的（回调全部空转、界面看着正常却不响应），
 * 代价太高，所以除了 detach 的归属校验外再加一道自愈。
 */
function ensureCurrent() {
  if (current) return current;
  try {
    const pages = getCurrentPages();
    const top = pages && pages[pages.length - 1];
    const route = top && top.route ? String(top.route) : '';
    if (!route) return null;
    if (route.indexOf('lobby') >= 0) current = { name: 'lobby', ctx: top };
    else if (route.indexOf('game') >= 0) current = { name: 'game', ctx: top };
    else if (route.indexOf('home') >= 0) current = { name: 'home', ctx: top };
    return current;
  } catch (e) {
    return null;
  }
}

function handle(msg) {
  const g = app();
  ensureCurrent();
  switch (msg.t) {
    case 'error': {
      // 服务端不认识这条消息（版本落后 / 新旧错配）：「未知消息」不是用户操作错误。
      // 最典型的是小程序每 10s 一条的应用级心跳 —— 线上服务端还是旧版本时不认识它，
      // 于是每 10 秒回一次「未知消息」，客户端把它当业务错误画在操作区，
      // 画面每隔 10s 抖一下（用户报「老是出现未知消息导致页面布局变化」）。
      // 处置：吞掉 + 关掉应用级心跳（ws 协议层 pong 由平台自动应答，不影响保活）。
      if (msg.reason && String(msg.reason).indexOf('未知消息') === 0) {
        if (!unknownWarned) {
          unknownWarned = true;
          console.warn('[mj] 服务端不认识的消息（多半是服务端版本落后）：', msg.reason);
        }
        net.disablePing();
        return;
      }
      if (autoResume) {
        autoResume = false;
        const savedRoom = store.get(store.KEYS.room, '');
        store.clearRoom();
        g.resumeFail = { reason: msg.reason, room: savedRoom };
        if (!current || current.name !== 'home') {
          wx.reLaunch({ url: '/pages/home/home' });
        } else {
          call('onResumeFail', g.resumeFail);
        }
        return;
      }
      call('onError', msg.reason);
      return;
    }
    case 'state': {
      g.lastState = msg;
      g.mySeat = msg.you;
      g.dealer = msg.dealer || 0;
      g.roomCode = msg.code;
      g.variant = msg.variant;
      g.lastGameView = null;
      store.set(store.KEYS.token, msg.token);
      store.set(store.KEYS.room, msg.code);
      net.setInRoom(true);
      if (destName() !== 'lobby') {
        navigate('lobby', '/pages/lobby/lobby');
        return;
      }
      call('onState', msg);
      return;
    }
    case 'game': {
      g.lastGameView = msg.view;
      g.mySeat = msg.view.mySeat;
      g.dealer = msg.view.dealer || 0;
      g.roomCode = msg.view.code;
      if (msg.view.variant) g.variant = msg.view.variant;
      net.setInRoom(true);
      if (destName() !== 'game') {
        navigate('game', '/pages/game/game');
        return;
      }
      call('onGame', msg.view);
      return;
    }
    case 'chat':
      g.chatHistory.push(msg);
      if (g.chatHistory.length > 200) g.chatHistory.shift();
      call('onChat', msg);
      return;
    case 'emote':
      call('onEmote', msg);
      return;
    case 'swapAsk':
      call('onSwapAsk', msg);
      return;
    case 'settle':
      call('onSettle', msg);
      return;
    case 'dissolved':
      store.clearRoom();
      call('onDissolved', msg);
      return;
    case 'variant':
      if (msg.variant) g.variant = msg.variant;
      call('onVariant', msg);
      return;
    case 'event':
      call('onEvent', msg);
      return;
    default:
      return;
  }
}

module.exports = {
  /** 页面 onShow 时挂载自己（同名钩子会被调用） */
  attach(name, ctx) {
    current = { name, ctx };
    navInFlight = null; // 跳转已落地
    net.setMessageHandler(handle);
    net.setStatusHandler((s) => call('onNetStatus', s));
    // 落地的页和「最后一条消息想去的地方」不一致（同 tick 内 state→game 的竞态）→ 再补跳一次
    if (navTarget && navTarget.name !== name) navigate(navTarget.name, navTarget.url);
  },
  /**
   * 页面 onHide / onUnload 时摘除自己。**必须传 this 做归属校验**（2026-10-17 修复）：
   * 小程序 redirectTo 的生命周期顺序是「旧页 onHide → 新页 onLoad/onShow → 旧页 onUnload」，
   * 旧页的 onUnload 会晚于新页的 onShow。若无脑置空 current，就会把新页面刚挂上的
   * 消息路由抹掉 —— 症状是新页面从此收不到任何回调（dissolved 不弹窗、结算/表情/聊天
   * /换位/事件全部静默失效），人卡在旧界面上出不来。详见 docs §10.8。
   */
  detach(ctx) {
    if (current && (!ctx || current.ctx === ctx)) current = null;
  },
  /** 房间内聊天历史（跨页面保留） */
  chatHistory() {
    return app().chatHistory;
  },
  /**
   * 兜底自救：服务端明确回「对局进行中」而人还停在大厅时，回牌桌。
   *
   * 光跳页面不够 —— 卡住时 `lastGameView` 往往已被 `state` 清成 null，牌桌是空的，
   * 而且新一局可能正等着本人掷骰（没有后续广播）。所以顺带用本地 token 发一次
   * `resume`：服务端在 `playing` 阶段回 resume 会广播一次 `game`，视图就补回来了。
   */
  recoverGame() {
    if (destName() === 'game') return;
    navigate('game', '/pages/game/game');
    const token = store.get(store.KEYS.token, '');
    if (token) net.connectAndSend({ t: 'resume', token });
  },
  resetChat() {
    app().chatHistory = [];
    app().chatUnread = 0;
  },
  /** 启动即尝试凭本地 token 回桌（等价 web 端刷新自动重连） */
  tryResume() {
    const token = store.get(store.KEYS.token, '');
    if (!token) return false;
    autoResume = true;
    net.setInRoom(true);
    net.connectAndSend({ t: 'resume', token });
    return true;
  },
  isAutoResume() {
    return autoResume;
  },
  clearAutoResume() {
    autoResume = false;
  },
  send(msg) {
    net.send(msg);
  },
  connectAndSend(msg) {
    net.connectAndSend(msg);
  },
  leaveRoom() {
    net.send({ t: 'leave' });
    store.clearRoom();
    this.resetChat();
    net.setInRoom(false);
    net.closeSocket();
  },
};
