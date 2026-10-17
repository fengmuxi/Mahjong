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
      if (!current || current.name !== 'lobby') {
        wx.redirectTo({ url: '/pages/lobby/lobby' });
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
      if (!current || current.name !== 'game') {
        wx.redirectTo({ url: '/pages/game/game' });
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
    net.setMessageHandler(handle);
    net.setStatusHandler((s) => call('onNetStatus', s));
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
