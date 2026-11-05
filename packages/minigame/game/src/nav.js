/**
 * 房间路由 + 场景切换（小程序端 utils/room.js 的对位物）。
 *
 * 职责分两半：
 *   · **消息路由**（自 room.js 逐行移植）：服务端消息收敛后回调给当前场景的同名钩子
 *     （onState / onGame / onChat / onEmote / onSwapAsk / onSettle / onDissolved /
 *      onVariant / onEvent / onError / onNetStatus / onResumeFail），协议字段不改写；
 *   · **导航**：小程序端是 wx.redirectTo 重建 Page，小游戏端换成本模块的
 *     switchTo（重建场景对象，语义与「导航重建页面」一致 —— 场景内部状态不跨场景残留）。
 *     转场保留小程序端的 170ms 淡出 + 220ms 淡入（.page-leaving / .page-fade-in）。
 *
 * 跳转合并（「已经开始下一局却卡在准备界面」修复，见 room.js 注释）原样保留：
 * 服务端同一毫秒连发 state + game 时只保留最后一个目标。
 */

const net = require('../utils/net.js');
const store = require('../utils/store.js');
const voice = require('../utils/voice.js');
const input = require('./input.js');
const state = require('./state.js');
const toast = require('./ui/toast.js');

const app = () => state;

/**
 * 语音自愈（2026-11-03 反馈调整：语音改为**用户可选**，进房不再自动加入，对位 room.js）：
 * 收到 state / game 时 ——
 *   1. 重发一次 voiceId（已在语音中才生效），服务端座位映射不失联；
 *   2. 会话被打断后自动重新入会（2026-11-04 审计 B2：rejoin 此前零调用；幂等，无会可恢复时是空操作）。
 * 开启/关闭语音由场景语音钮显式驱动（lobby/game 场景的 onVoiceTap）。
 */
function syncVoice() {
  voice.rejoin();
  voice.announce();
}

/** voice 广播的 map（数组）→ 按 seat 键控的对象：场景渲染直接取 state.voiceMap[seat] */
function toVoiceMap(entries) {
  const map = {};
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && Number.isInteger(e.seat) && e.openid) map[e.seat] = { openid: e.openid, muted: !!e.muted, ear: !!e.ear };
  }
  return map;
}

/** 场景工厂表（main.js 注册：{ home: () => new HomeScene(), ... }）——避免 scenes ↔ nav 循环 require */
let factories = {};
/** 当前场景 { name, scene } */
let current = null;
/** 自动 resume 标记：凭本地 token 回桌失败时用它决定「回向导」的降级路径 */
let autoResume = false;
/** 「服务端不认识的消息」只打印一次 */
let unknownWarned = false;

/* ---- 转场状态（main.js 每帧读 fadeAlpha 画遮罩） ---- */
let fadeStart = 0;
let fadeDur = 0;
let fadeMode = ''; // 'out'（遮暗旧场景）| 'in'（揭开新场景）

/* ---- 跳转合并（对位 room.js navigate/flushNav） ---- */
let navTarget = null;
let navTimer = null;
let navInFlight = null;

/** 当前「认为」自己在哪个场景：待跳目标 > 在途目标 > 当前场景 */
function destName() {
  if (navTarget) return navTarget;
  if (navInFlight) return navInFlight;
  return current ? current.name : null;
}

/** 房间已失效类错误：清本地会话并回首页提示 */
function isFatalRoomError(reason) {
  return /已失效/.test(String(reason || ''));
}

function navigate(name) {
  if (navInFlight === name) return;
  navTarget = name;
  if (navTimer) return;
  navTimer = setTimeout(flushNav, 0);
}

function flushNav() {
  navTimer = null;
  const t = navTarget;
  navTarget = null;
  if (!t) return;
  if (navInFlight === t) return;
  if (navInFlight && navInFlight !== t) {
    // 上一次跳转还没落地：先让它完成，60ms 后再补这一次（对位 room.js）
    navTarget = t;
    navTimer = setTimeout(flushNav, 60);
    return;
  }
  navInFlight = t;
  if (current) {
    // 170ms 淡出窗口内可能又来了新目标（state→game 竞态）：以最新的为准
    fadeStart = Date.now();
    fadeDur = 170;
    fadeMode = 'out';
    setTimeout(() => {
      const latest = navTarget && navTarget !== t ? navTarget : t;
      navTarget = null;
      switchTo(latest);
    }, 170);
    return;
  }
  switchTo(t);
}

/** 真正的场景切换：旧场景 exit → 新建 → enter（场景在 enter 里 attach 自己） */
function switchTo(name) {
  if (!factories[name]) return;
  if (current && current.scene && typeof current.scene.exit === 'function') {
    try {
      current.scene.exit();
    } catch (e) {
      console.warn('[nav] 旧场景 exit 异常：', e && e.message);
    }
  }
  current = null;
  let scene = null;
  try {
    scene = factories[name]();
  } catch (e) {
    console.error('[nav] 场景创建失败：', name, e);
    navInFlight = null;
    return;
  }
  current = { name, scene };
  navInFlight = null;
  input.setScene(scene); // 切场景收键盘、换触摸路由目标
  if (typeof scene.enter === 'function') scene.enter();
  fadeStart = Date.now();
  fadeDur = 220;
  fadeMode = 'in';
}

/** main.js 主循环每帧取转场遮罩透明度（0 = 不画） */
function fadeAlpha() {
  if (!fadeMode) return 0;
  const p = (Date.now() - fadeStart) / fadeDur;
  if (p >= 1) {
    fadeMode = '';
    return 0;
  }
  return fadeMode === 'out' ? p : 1 - p;
}

function call(hook, arg) {
  if (current && current.scene && typeof current.scene[hook] === 'function') {
    try {
      current.scene[hook](arg);
    } catch (e) {
      console.error('[nav] 场景钩子异常：', hook, e);
    }
  }
}

/* ---------------- 消息路由（room.js handle 逐行移植，仅导航语句替换） ---------------- */

function handle(msg) {
  const g = app();
  switch (msg.t) {
    case 'error': {
      // 「未知消息」= 服务端版本落后不认识应用级心跳：吞掉 + 关心跳（见 room.js 注释）
      if (msg.reason && String(msg.reason).indexOf('未知消息') === 0) {
        if (!unknownWarned) {
          unknownWarned = true;
          console.warn('[mj] 服务端不认识的消息（多半是服务端版本落后）：', msg.reason);
        }
        net.disablePing();
        return;
      }
      if (autoResume || isFatalRoomError(msg.reason)) {
        autoResume = false;
        const savedRoom = store.get(store.KEYS.room, '');
        store.clearRoom();
        g.resumeFail = { reason: msg.reason, room: savedRoom };
        net.setInRoom(false);
        net.closeSocket();
        voice.leave(); // 房间没了，语音一并退（幂等）
        if (!current || current.name !== 'home') {
          navigate('home');
        } else {
          call('onResumeFail', g.resumeFail);
        }
        return;
      }
      call('onError', msg.reason);
      return;
    }
    case 'kicked': {
      // 被房主移出：必须清本地房间态，否则 auto-resume 会把人又拽回去（见 room.js 注释）
      autoResume = false;
      store.clearRoom();
      g.resumeFail = null;
      g.lastState = null;
      g.lastGameView = null;
      net.setInRoom(false);
      net.closeSocket();
      voice.leave();
      toast.push(msg.reason || '你已被移出房间', 2000);
      if (!current || current.name !== 'home') navigate('home');
      return;
    }
    case 'state': {
      autoResume = false;
      g.lastState = msg;
      g.mySeat = msg.you;
      g.dealer = msg.dealer || 0;
      g.roomCode = msg.code;
      g.variant = msg.variant;
      g.lastGameView = null;
      store.set(store.KEYS.token, msg.token);
      store.set(store.KEYS.room, msg.code);
      net.setInRoom(true);
      syncVoice();
      if (destName() !== 'lobby') {
        navigate('lobby');
        return;
      }
      call('onState', msg);
      return;
    }
    case 'game': {
      autoResume = false;
      g.lastGameView = msg.view;
      g.mySeat = msg.view.mySeat;
      g.dealer = msg.view.dealer || 0;
      g.roomCode = msg.view.code;
      if (msg.view.variant) g.variant = msg.view.variant;
      net.setInRoom(true);
      syncVoice();
      if (destName() !== 'game') {
        navigate('game');
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
      voice.leave(); // 解散即房间终结：语音随之退出
      call('onDissolved', msg);
      return;
    case 'voice':
      // 语音座位映射（2026-11-03 二期，对位 room.js）：座位 → {openid, muted}。
      // 存 state 供大厅/对局场景渲染「谁在说话/谁闭麦」；场景实现 onVoice 钩子时通知重绘。
      g.voiceMap = toVoiceMap(msg.map);
      call('onVoice', msg);
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
  /** main.js 启动时注册场景工厂（避免循环 require） */
  register(map) {
    factories = map;
  },
  /** 场景 enter 时挂载自己（对位 room.attach；同名钩子会被调用） */
  attach(name, scene) {
    current = { name, scene };
    navInFlight = null; // 跳转已落地
    net.setMessageHandler(handle);
    net.setStatusHandler((s) => call('onNetStatus', s));
    if (navTarget && navTarget !== name) navigate(navTarget);
  },
  /**
   * 场景 exit 时摘除自己。**必须传 this 做归属校验**（对位 room.detach 的注释：
   * 归属不对就把新场景刚挂上的路由抹掉，症状是全部回调静默失效）。
   */
  detach(scene) {
    if (current && (!scene || current.scene === scene)) current = null;
  },
  /** main.js 启动首个场景（无淡出，直切 + 淡入） */
  boot(name) {
    switchTo(name);
  },
  /**
   * 供场景主动跳转（离开房间 / 退出对局 / 解散后回首页等纯客户端导航）。
   * 与消息驱动的 navigate 走同一套「跳转合并 + 170/220ms 转场」。
   */
  navigate(name) {
    navigate(name);
  },
  scene() {
    return current ? current.scene : null;
  },
  sceneName() {
    return current ? current.name : '';
  },
  fadeAlpha,
  /** 房间内聊天历史（跨场景保留） */
  chatHistory() {
    return app().chatHistory;
  },
  /** 服务端明确回「对局进行中」而人还停在大厅时：回牌桌 + 补发 resume（对位 room.recoverGame） */
  recoverGame() {
    if (destName() === 'game') return;
    navigate('game');
    const token = store.get(store.KEYS.token, '');
    if (token) net.connectAndSend({ t: 'resume', token });
    else {
      const code = String(store.get(store.KEYS.room, '') || '');
      if (code) net.connectAndSend({ t: 'join', code, name: store.get(store.KEYS.name, ''), pid: store.ensurePid() });
    }
  },
  resetChat() {
    app().chatHistory = [];
    app().chatUnread = 0;
  },
  /** 启动即尝试回桌（token 优先，退 (pid + 房间码)），对位 room.tryResume */
  tryResume() {
    const token = store.get(store.KEYS.token, '');
    const code = String(store.get(store.KEYS.room, '') || '');
    if (!token && !code) return false;
    autoResume = true;
    net.setInRoom(true);
    if (token) net.connectAndSend({ t: 'resume', token });
    else net.connectAndSend({ t: 'join', code, name: store.get(store.KEYS.name, ''), pid: store.ensurePid() });
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
    voice.leave(); // 主动离房：语音一并退出
  },
  /**
   * 彻底离场：先发 exit 再清本地态并断开（「先发后断」，见 room.js 注释）。
   * ⚠ 2026-11-05 起**局内 UI 不再用它**：顶栏 ‹ 改走 `quit`（保座暂离、回房间页），
   * 所以退出后 `store` 里的房间/令牌要留着（还要接着打下一局）。这里保留给「真正离开」
   * 的调用方与旧代码兼容。
   */
  exitGame() {
    net.send({ t: 'exit' });
    store.clearRoom();
    this.resetChat();
    net.setInRoom(false);
    net.closeSocket();
    voice.leave();
  },
};
