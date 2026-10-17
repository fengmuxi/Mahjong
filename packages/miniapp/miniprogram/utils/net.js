/**
 * 网络层：对局 WebSocket 单例（对应 web 端 `main.ts` 的 ws 连接与重连逻辑）。
 *
 * 与 web 端的差异（均为平台约束，非业务改动）：
 *   1. `wx.connectSocket` 只能发文本 / ArrayBuffer，**发不出 ws 协议层的 ping 帧** ——
 *      因此这里每 10s 发一条应用级心跳 `{t:'ping'}`，服务端收到即刷新存活时间并回 `{t:'pong'}`
 *      （服务端改动见 packages/server/src/index.ts 的 case 'ping'）。web 端仍走 ws 级 ping，两条并存。
 *   2. 小程序切后台 / 息屏后 socket 可能被系统回收 → `onAppShow` 兜一次重连。
 *   3. 地址来自 utils/config.js（wss + 备案域名），不再是 `location.origin`。
 *
 * 重连策略照搬 web 端：指数退避 1s→4s，最多 10 次（≈34s，覆盖服务端 30s 断线宽限），
 * 凭 storage 里的 token `resume` 回原座位。
 *
 * 诊断（2026-10-17 加）：失败时必须把**平台给的真实原因**（errMsg / close code）带出去，
 * 否则页面上只能显示「正在重连…」，看不出是域名没登记、超时还是地址写错。
 */

const config = require('./config.js');
const store = require('./store.js');

const PING_MS = 10000;
const RECONNECT_MAX_TRIES = 10;
/** 单次连接握手超时（ms）：到点未 open 即视为失败，避免"卡住不动" */
const CONNECT_TIMEOUT = 8000;

let task = null;
let state = 'closed'; // closed | connecting | open | no-url | dead
let pendingMsg = null;
let inRoom = false;
let tries = 0;
let reconTimer = null;
let pingTimer = null;
/** 服务端不认识应用级心跳时置真（见 disablePing）；每次重连重新探测一次 */
let pingDisabled = false;
let connectTimer = null;
let appHidden = false;
let messageHandler = null;
let statusHandler = null;
/** 本次会话是否成功连上过（用于区分「刚进页面」与「真的断线了」） */
let everConnected = false;
/** 最近一次失败原因（平台原文，便于页面展示与排查） */
let lastError = '';
let lastUrl = '';

function emitStatus() {
  if (statusHandler) {
    statusHandler({
      state,
      inRoom,
      everConnected,
      error: lastError,
      url: lastUrl,
    });
  }
}

function clearTimers() {
  if (reconTimer) {
    clearTimeout(reconTimer);
    reconTimer = null;
  }
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (connectTimer) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
}

function startPing() {
  if (pingTimer) clearInterval(pingTimer);
  if (pingDisabled) return;
  pingTimer = setInterval(() => {
    if (state === 'open') sendRaw({ t: 'ping' });
  }, PING_MS);
}

/**
 * 关掉应用级心跳（**服务端不认识 `{t:'ping'}` 时**由 room.js 调用）。
 *
 * 背景（2026-10-17 线上复现）：线上部署的服务端版本落后，不认识这条应用级心跳，
 * 于是**每 10 秒**回一次 `{t:'error', reason:'未知消息'}` —— 客户端把它当业务错误
 * 弹在状态区，画面每隔 10s 抖一下。ws 协议层的 ping/pong 由平台自己处理、
 * 不依赖这条心跳，所以关掉不影响保活；等下次重连（可能服务端已升级）会重新启用。
 */
function disablePing() {
  if (pingDisabled) return;
  pingDisabled = true;
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  console.warn('[mj] 服务端不认识应用级心跳，已停发（ws 协议层 pong 仍由平台自动应答）');
}

function sendRaw(obj) {
  if (!task || state !== 'open') return;
  task.send({ data: JSON.stringify(obj) });
}

function flush() {
  if (pendingMsg && state === 'open') {
    sendRaw(pendingMsg);
    pendingMsg = null;
  }
}

/** 统一失败出口：记下原因、清连接、通知页面、按需重连 */
function fail(reason, fromClose) {
  lastError = reason || '连接失败';
  if (task) {
    try {
      task.close({ code: 1000 });
    } catch (e) {
      /* 已经断开时忽略 */
    }
  }
  task = null;
  state = everConnected || inRoom ? 'closed' : 'failed';
  clearTimers();
  emitStatus();
  if (!fromClose) scheduleReconnect();
}

function openSocket() {
  const url = config.resolve();
  lastUrl = url;
  if (!url) {
    state = 'no-url';
    lastError = '未配置服务器地址（utils/config.js 的 DEFAULT_WSS 或存储键 mj-wss）';
    emitStatus();
    return;
  }
  state = 'connecting';
  lastError = '';
  emitStatus();
  try {
    task = wx.connectSocket({
      url,
      timeout: CONNECT_TIMEOUT,
      fail: (res) => {
        fail((res && res.errMsg) || 'connectSocket 参数不合法（检查是否 ws:// 或 wss:// 开头、以 /ws 结尾）');
      },
    });
  } catch (e) {
    fail((e && e.message) || 'connectSocket 调用异常');
    return;
  }
  if (!task || typeof task.onOpen !== 'function') {
    fail('当前基础库不支持 SocketTask 接口');
    return;
  }

  // 兜底超时：部分平台 onError 不触发，只挂在那里
  connectTimer = setTimeout(() => {
    if (state === 'connecting') fail(`连接超时（${CONNECT_TIMEOUT / 1000}s）：服务端未响应`);
  }, CONNECT_TIMEOUT + 500);

  task.onOpen(() => {
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    state = 'open';
    everConnected = true;
    tries = 0;
    lastError = '';
    // 重连后重新探测一次应用级心跳（服务端可能已经升级到认识 ping 的版本）
    pingDisabled = false;
    startPing();
    emitStatus();
    flush();
  });
  task.onMessage((res) => {
    let msg = null;
    try {
      msg = JSON.parse(String(res.data));
    } catch (e) {
      return;
    }
    if (!msg || msg.t === 'pong') return; // 心跳应答：业务层无需处理
    if (messageHandler) messageHandler(msg);
  });
  task.onError((res) => {
    fail((res && res.errMsg) || 'WebSocket 连接失败');
  });
  task.onClose((res) => {
    if (state === 'open') {
      // 正常/异常关闭：记录原因，交给重连
      fail(
        res && res.code && res.code !== 1000
          ? `连接被关闭（code ${res.code}${res.reason ? ' ' + res.reason : ''}）`
          : '连接被关闭',
        true,
      );
      scheduleReconnect();
      return;
    }
    // 握手阶段被关（域名拦截常见表现）
    if (state === 'connecting') fail('连接被关闭：域名可能未加入合法域名（见下方提示）');
  });
}

/** 指数退避重连：与 web 端同参数（1s、2s、3s…上限 4s，共 10 次） */
function scheduleReconnect() {
  if (!inRoom) return; // 还没进房（创建/加入失败）→ 交给页面提示，不自动重连
  if (appHidden) return; // 在后台时不抢连，回到前台由 onAppShow 触发
  if (reconTimer) return;
  if (tries >= RECONNECT_MAX_TRIES) {
    state = 'dead';
    emitStatus();
    return;
  }
  tries += 1;
  reconTimer = setTimeout(() => {
    reconTimer = null;
    if (!inRoom) return;
    if (state === 'open') return;
    const token = store.get(store.KEYS.token, '');
    if (!token) {
      state = 'dead';
      emitStatus();
      return;
    }
    pendingMsg = { t: 'resume', token };
    openSocket();
  }, Math.min(1000 * tries, 4000));
}

module.exports = {
  /**
   * 把连接状态翻译成「人话」——空串表示不必提示。
   * 页面直接用它渲染横幅 / 表单错误，避免各页各写一套（也避免"还没连就显示正在重连"的误导）。
   */
  describe(s) {
    if (!s) return '';
    const err = s.error ? String(s.error) : '';
    const url = s.url ? `（当前 ${s.url}）` : '';
    if (s.state === 'open') return '';
    if (s.state === 'no-url') return '未配置服务器地址：填 utils/config.js 的 DEFAULT_WSS，或调试时设 mj-wss';
    if (s.state === 'dead') return '连接已断开：请返回首页重连，或检查服务端是否在运行';
    if (s.state === 'connecting') return s.inRoom ? '正在连接…' : '';
    if (s.state === 'closed') {
      return s.everConnected ? '连接已断开，正在重连…' : '';
    }
    // failed：握手就失败，多半是域名/地址/网络问题 —— 必须给出可执行提示
    if (/url not in domain list|合法域名/i.test(err)) {
      return `连接失败：域名未登记。开发期请在「详情 → 本地设置」勾选「不校验合法域名」；上线需在公众平台登记 socket 合法域名${url}`;
    }
    if (/timeout|超时/i.test(err)) {
      return `连接失败：${err}。确认服务端在运行、IP 与端口正确、Windows 防火墙已放行${url}`;
    }
    if (/fail|invalid|protocol|closed/i.test(err)) {
      return `连接失败：${err}。地址需以 ws:// 或 wss:// 开头并以 /ws 结尾${url}`;
    }
    return err ? `连接失败：${err}${url}` : '';
  },

  /** 注册消息回调（页面级：由当前页面挂上，切换页面时覆盖） */
  setMessageHandler(fn) {
    messageHandler = fn;
  },
  /** 注册连接状态回调（渲染横幅 / 表单错误） */
  setStatusHandler(fn) {
    statusHandler = fn;
  },
  getState() {
    return state;
  },
  isOpen() {
    return state === 'open';
  },
  /** 最近一次失败原因（平台原文），无失败为空串 */
  getLastError() {
    return lastError;
  },
  /** 本次会话是否成功连上过 */
  hasConnected() {
    return everConnected;
  },
  /** 当前使用的地址（排查用） */
  getUrl() {
    return lastUrl || config.resolve();
  },
  setInRoom(v) {
    inRoom = !!v;
    if (!inRoom) tries = 0;
  },
  /**
   * 连接并发送（等价 web 端 connectAndSend）：
   * 已连接/连接中时不另开一条 —— 否则两条连接各发一次，服务端会把第二条判为「你已经在房间里了」。
   */
  connectAndSend(msg) {
    pendingMsg = msg;
    if (state === 'open' || state === 'connecting') {
      flush();
      return;
    }
    openSocket();
  },
  send(msg) {
    sendRaw(msg);
  },
  /** 主动断开（离开房间 / 回首页） */
  closeSocket() {
    clearTimers();
    pendingMsg = null;
    inRoom = false;
    tries = 0;
    lastError = '';
    // 主动断开 = 本段会话结束：重置「连上过」标记，否则回首页会残留「正在重连」横幅
    everConnected = false;
    if (task) {
      try {
        task.close({ code: 1000 });
      } catch (e) {
        /* ignore */
      }
    }
    task = null;
    state = 'closed';
  },
  onAppShow() {
    appHidden = false;
    if (inRoom && state !== 'open' && state !== 'connecting') {
      tries = 0;
      reconTimer = null;
      scheduleReconnect();
    }
  },
  onAppHide() {
    appHidden = true;
  },
  /** 停发应用级心跳（服务端不认识 `{t:'ping'}` 时由 room.js 调用，见 disablePing 注释） */
  disablePing,
};
