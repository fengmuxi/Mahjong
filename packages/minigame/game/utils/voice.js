/**
 * 实时语音（wx.joinVoIPChat）封装 —— 2026-11-03 新增，双端（小程序/小游戏）逐字节一致。
 *
 * 分工：
 *   · 登录与签名走 wxauth.js + 服务端（/api/wx/session、/api/wx/voipsig，见 wxvoice.ts）；
 *   · 语音流本身走微信自建通道，不经过对局 WebSocket，与 net.js 完全无关；
 *   · UI 通过 setListener 订阅状态变化自行重绘（本模块不感知页面/场景）。
 *
 * 状态机：idle（未在语音）→ joining（授权/签名/入会中）→ joined；离开与异常都回 idle。
 * 房间映射：groupId = `mj-<房间码>`；微信 VoIP 按 appid 隔离 —— 跨端同桌时两端各成一个
 * 语音房（已知限制，见 docs/integration/wechat-voice.md）。
 *
 * 平台差异提示：VoIP 在开发者工具**不可用**（调用即 fail），必须真机调试。
 * 说话人事件里只有 openid，而对局协议是匿名 token+pid、不含 openid —— 一期无法把
 * 「谁在说话」映射到具体座位，只做「有人（除自己外）在说话」的按钮级指示；
 * 座位级映射需要扩展对局协议（voiceState 广播），列为二期。
 */

const config = require('./config.js');
const net = require('./net.js');
const store = require('./store.js');
const wxauth = require('./wxauth.js');
// 隐私授权闸门（2026-11-04）：joinVoIPChat 属隐私 API，用户未同意《用户隐私保护指引》
// 会 fail（errMsg: please go to mp open official popup or use wx.onNeedPrivacyAuthorization）。
// join 第一步先 ensure：已同意放行；未决拉起弹窗（小游戏=自绘层，小程序=官方弹窗），拒绝不进会。
const privacy = require('./privacy.js');

/** 房间码格式（与服务端 genCode 字符集一致） */
const GROUP_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;

/** 扬声器静音偏好持久化键（跨会话保留：不想听的人下次进房也不用再关一遍） */
const KEY_EAR = 'mj-voice-ear';

let state = 'idle'; // idle | joining | joined
/**
 * join 链世代号（2026-11-04 审计 B1）：exitVoip()（含 leave() 转发）与新 join() 都会自增。
 * 在途 join 链在每个 await 之后核对世代号，过期立即放弃 —— 没有它时，数秒长的 join 链
 * 会在用户离房/被踢/解散后才完成入会，把人拉进旧房间的 VoIP 会话（孤儿会话：
 * 人已回首页、麦克风灯亮、界面无出口）。
 */
let joinSeq = 0;
let joinedRoom = '';
let micMuted = false;
/** 扬声器静音（听不听得到别人）。随 voiceId 的 ear 字段广播给同房（仅供 🔇 角标显示，不改他人实际音频） */
let earMuted = false;
let memberCount = 0;
let othersSpeaking = false;
/** 最近一次说话人事件里的 openid 列表（含自己）：座位级指示用它 × 服务端 voice 映射算「哪个座位在说」 */
let lastSpeakers = [];
/**
 * 是否收到过说话人事件（2026-11-05 降级判据；2026-11-05 复核根因）。
 * 真机实测：onVoIPChatSpeakersChanged **注册成功（typeof === 'function'）但从不触发**，
 * speakers 日志一条都不打 → speakersSeen 恒 false → 走降级。
 * 根因（查官方文档 + 微信服务市场社区帖复核）：**微信平台级已知问题，非小游戏独有** ——
 * 社区自 2022 起大量「onVoIPChatSpeakersChanged 无反应」反馈，且反馈场景是**小程序**；
 * 同环境 onVoIPChatMembersChanged / onVoIPVideoMembersChanged 都正常，唯独说话人事件不推。
 * 基础库 2.7.0 起就支持该 API（可用性没问题），坑在「触发」，与基础库版本无关。
 * 补充：海外小游戏平台（overseas-game 可用性页）整组 VoIP 标 ❌ 不可用；本项目 appid 是国内版，
 *   国内小程序/小游戏 API 都在（typeof 才为 function），问题纯在说话人事件不推。
 * 收到过事件（哪怕一次）→ 座位级指示用「说话交集」（呼吸绿环）；从未收到 → 退化为「开麦即亮」
 * （常亮绿环 = 该座位开着麦克风，🔇 = 闭麦），数据源是现有 voiceId/muted 广播。
 * 结论：呼吸绿环（实时谁在说）在当前微信 VoIP 下**不可靠**，降级路径即正确终态，不再追 speakers 事件。
 */
let speakersSeen = false;
let lastError = '';
/** 最近一次失败的原因码（micDenied / relogin / network / interrupted…），供页面做差异化 UI */
let lastReason = '';
let listener = null;
/**
 * 自动入会失败后挂起（2026-11-06）：服务端 state/game 广播很频繁，失败后若每条都重试，
 * 会刷满「joinVoIPChat:fail」日志（开发者工具里 VoIP 必失败，尤其明显）。失败一次即挂起，
 * leave()/exitVoip() 复位（换房/退出后允许下次自动入会）；用户手动点语音钮走 join() 不受限。
 */
let autoJoinBlocked = false;

try {
  earMuted = store.get(KEY_EAR, false) === true;
} catch (e) {
  earMuted = false;
}

/** 功能开关探测缓存：true/false/null(未知)。由 probe() 从 GET /api/wx/voice 刷新 */
let enabledFlag = null;
let probing = null;

function notify() {
  if (listener) listener(status());
}

function status() {
  return {
    state,
    micMuted,
    earMuted,
    memberCount,
    othersSpeaking,
    error: lastError,
    reason: lastReason,
    room: joinedRoom,
  };
}

/** 最近一次说话人事件的 openid 快照（只读；页面/场景把它与服务端 voice 映射求交得「哪个座位在说」） */
function speakers() {
  return lastSpeakers;
}

/**
 * 是否收到过说话人事件（只读，2026-11-05 B 方案降级判据）：
 * true → 座位级指示用「说话交集」（呼吸绿环）；false（真机实测从不触发）→
 * 退化为「开麦即亮」（常亮绿环 = 该座位开着麦克风），语义见 speakersSeen 定义。
 */
function hasSpeakerData() {
  return speakersSeen;
}

/** VoIP 事件体形状各基础库版本略有差异：容忍 data 包裹 / 字段别名 / 元素为串或对象 */
function pickList(r, ...names) {
  const d = (r && (r.data || r)) || {};
  for (const n of names) {
    const v = d[n];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function openIdOf(m) {
  if (typeof m === 'string') return m;
  return (m && (m.openid || m.openId)) || '';
}

/** 事件监听在模块加载即注册一次（成员/说话人/打断事件不要求「已在会中」才能挂） */
if (typeof wx !== 'undefined') {
  // 方案 A 真机排查观测点（2026-11-05）：「speakers 日志一条不打」时先看这行 ——
  // 判定是「运行时缺 API（注册被跳过）」还是「事件没触发」。一次性打印。
  console.info(
    '[voice] voip apis: speakersChanged=' + typeof wx.onVoIPChatSpeakersChanged +
    ' membersChanged=' + typeof wx.onVoIPChatMembersChanged +
    ' updateMute=' + typeof wx.updateVoIPChatMuteConfig +
    ' join=' + typeof wx.joinVoIPChat,
  );
}
if (typeof wx !== 'undefined' && wx.onVoIPChatSpeakersChanged) {
  wx.onVoIPChatSpeakersChanged((r) => {
    speakersSeen = true; // 事件通道可用：座位级指示用「说话交集」（呼吸绿环）
    // 官方字段名为 openIdList（小程序/小游戏文档一致，**没有 loudSpeakers 这个字段**）。
    // 2026-11-05 曾误判「绿光环不亮」是字段没覆盖（补了 loudSpeakers 猜测）—— 复核后这是错的：
    // 根因是事件根本不触发（微信平台 bug），与字段解析无关。pickList 仍保留多别名兜底以兼容
    // 个别基础库版本的非常规形状，但权威字段就是 openIdList（已在列表末位）。
    lastSpeakers = pickList(r, 'loudSpeakers', 'speakers', 'speakerList', 'openIdList').map(openIdOf).filter(Boolean);
    const myId = wxauth.getOpenid();
    let others = 0;
    for (const id of lastSpeakers) {
      if (id && id !== myId) others += 1;
    }
    othersSpeaking = others > 0;
    // 方案 A 真机验证观测点（2026-11-05）：座位级指示的前提是「事件推全房响亮列表」。
    // 说话人集合变化才触发（不连续），真机 vConsole 看这行即可判定平台前提 ——
    // 若列表只含自己（others 恒 0），座位级光环不会亮，转方案 B（自报 + 服务端广播）。
    console.info('[voice] speakers:', JSON.stringify(lastSpeakers), 'others:', others, 'raw:', JSON.stringify(r && (r.data || r)));
    notify();
  });
  wx.onVoIPChatMembersChanged((r) => {
    memberCount = pickList(r, 'members', 'openIdList').length;
    notify();
  });
  wx.onVoIPChatInterrupted(() => {
    // 被系统打断（来电等）：微信侧会话结束。记住房间号不丢，回 idle 等待重进房/重连自愈
    retractId(); // 座位映射同步撤回（降级指示的绿环该灭了；WS 断开时静默丢弃，重连后自愈）
    state = 'idle';
    othersSpeaking = false;
    lastSpeakers = [];
    memberCount = 0;
    lastReason = 'interrupted';
    lastError = '语音被系统打断，已自动退出';
    notify();
  });
  wx.onVoIPChatStateChanged((r) => {
    const d = (r && (r.data || r)) || {};
    // 部分版本以 state/errCode 上报会话级异常；拿到明确失败就回 idle 交还给用户操作
    if (d.state === 'error' || (d.errCode && d.errCode !== 0)) {
      retractId();
      state = 'idle';
      othersSpeaking = false;
      lastReason = 'error';
      lastError = `语音会话异常（${d.errCode || d.state || 'unknown'}）`;
      notify();
    }
  });
}

/** 功能开关探测：进房/页面 onShow 时调一次，结果缓存供 available() 同步取用 */
function probe() {
  if (!wxauth.getClient()) {
    enabledFlag = false;
    return Promise.resolve(false);
  }
  if (probing) return probing;
  probing = new Promise((resolve) => {
    wx.request({
      url: `${config.resolveApi()}/api/wx/voice`,
      method: 'GET',
      timeout: 8000,
      success: (r) => {
        // 只有**可信的 JSON 回答**才有资格隐藏按钮（true/false 都尊重）。
        // 非 JSON（典型：线上服务端还是旧版本，/api/wx/voice 落进 web 兜底路由返回 HTML）
        // 一律视为「未知」→ 照常显示按钮；点了之后 join 链路会给出可读报错，
        // 而不是无声无息地消失让人以为功能没做。console.warn 留排查线索。
        const d = r.data && typeof r.data === 'object' ? r.data : null;
        if (!d) {
          enabledFlag = null;
          console.warn('[voice] /api/wx/voice 返回非 JSON（服务端版本过旧？），按「未知」处理，语音按钮照常显示');
          resolve(null);
          return;
        }
        enabledFlag = wxauth.getClient() === 'mp' ? !!d.mp : !!d.mg;
        resolve(enabledFlag);
      },
      fail: () => {
        enabledFlag = null; // 网络失败：不落死结论，下次再探
        resolve(null);
      },
      complete: () => {
        probing = null;
      },
    });
  });
  return probing;
}

/** 同步取最近一次探测结果（true/false/null）：页面在 !== false 时渲染语音按钮 */
function available() {
  return enabledFlag;
}

/** 录音权限：已拒 → micDenied（UI 引导 openSetting）；未决 → 现场弹授权 */
function ensureMicPermission() {
  return new Promise((resolve) => {
    wx.getSetting({
      success: (r) => {
        const auth = r.authSetting && r.authSetting['scope.record'];
        if (auth === true) {
          resolve({ ok: true });
          return;
        }
        if (auth === false) {
          resolve({ ok: false, reason: 'micDenied' });
          return;
        }
        wx.authorize({
          scope: 'scope.record',
          success: () => resolve({ ok: true }),
          fail: () => resolve({ ok: false, reason: 'micDenied' }),
        });
      },
      fail: () => resolve({ ok: false, reason: 'settingFailed' }),
    });
  });
}

/** 授权被拒后的引导出口：跳系统授权设置页，返回用户是否已放开录音 */
function openMicSetting() {
  return new Promise((resolve) => {
    wx.openSetting({
      success: (r) => resolve(!!(r.authSetting && r.authSetting['scope.record'])),
      fail: () => resolve(false),
    });
  });
}

function sign(group, openid) {
  return new Promise((resolve) => {
    wx.request({
      url: `${config.resolveApi()}/api/wx/voipsig`,
      method: 'POST',
      data: { client: wxauth.getClient(), openid, group },
      timeout: 8000,
      success: (r) => {
        const d = r.data && typeof r.data === 'object' ? r.data : null;
        if (d && d.ok) {
          resolve({ ok: true, groupId: d.groupId, nonceStr: d.nonceStr, timeStamp: d.timeStamp, signature: d.signature });
        } else if (!d) {
          // 非 JSON（旧服务端 HTML / CDN 劫持页）：点名服务端版本，别让人对着「签名失败」猜
          resolve({ ok: false, reason: 'serverOutdated' });
        } else {
          resolve({ ok: false, reason: (d && d.reason) || 'signFailed' });
        }
      },
      fail: () => resolve({ ok: false, reason: 'network' }),
    });
  });
}

/** joinVoIPChat 失败 errMsg → 可操作中文。高频坑直接给出后台操作步骤/自愈办法；
 *  拿不准的把原文附在末尾（真机排障线索），同时 join() 里 console.warn 全文。 */
function joinFailText(msg) {
  if (/privacy|onNeedPrivacyAuthorization|official popup/i.test(msg))
    return '微信要求隐私授权：请在 MP 后台「设置→基础设置」开通「官方隐私弹窗」，并在「用户隐私保护指引」声明「麦克风（录音）」后重试';
  if (/devtools|工具/i.test(msg)) return '开发者工具不支持实时语音，请用真机调试';
  if (/no permission/i.test(msg))
    return '微信拒绝加入语音：多为后台「实时语音」能力未开通（个人主体暂开不了），或麦克风被系统关闭。原文：' + msg;
  if (/parameter\.timeStamp/i.test(msg))
    return '语音参数格式错误：timeStamp 必须是 Unix 秒数值。请更新到最新客户端版本后重试。原文：' + msg;
  if (/signature|verification|timestamp|groupId/i.test(msg))
    return '语音签名校验失败：请重进房间刷新语音签名后重试。原文：' + msg;
  return '加入语音失败：' + msg;
}

function enterVoip(sig, micMutedInit) {
  return new Promise((resolve) => {
    if (typeof wx.joinVoIPChat !== 'function') {
      resolve({ ok: false, reason: 'unsupported' });
      return;
    }
    wx.joinVoIPChat({
      groupId: sig.groupId,
      nonceStr: sig.nonceStr,
      // 微信 API 明确要求 timeStamp 为 Number（Unix 秒）；签名端仍以 String(timeStamp) 拼接。
      timeStamp: Number(sig.timeStamp),
      signature: sig.signature,
      // 联动约束（2026-11-04）：开语音必须开扬声器 —— earphoneMuted 入会恒为 false
      // （上次手动关过扬声器的偏好在这里被强制放开；join 成功后同步清偏好落盘）。
      muteConfig: { muteMicrophone: !!micMutedInit, muteEarphone: false },
      success: () => resolve({ ok: true }),
      fail: (res) => {
        const msg = (res && res.errMsg) || '加入语音失败';
        // 走到这里时 ensureMicPermission 已确认 scope.record=true，所以**不能**把含
        // auth/permission 字样的失败翻成 micDenied：后台「实时语音」能力未开通、
        // 工具端不支持、签名失效等 errMsg 同样带这些字样 —— 一律标 micDenied 会把
        // 用户引进死循环（开权限 → 返回 → 点按钮又跳授权页，2026-11-03 报障）。
        // 只有 errMsg 明确指向录音/麦克风时才认 micDenied，其余原样透传给 UI 展示。
        const mic = /auth|deny|permission|权限/i.test(msg) && /record|mic|录音|麦克风/i.test(msg);
        resolve({ ok: false, reason: mic ? 'micDenied' : 'joinFailed:' + msg });
      },
    });
  });
}

function exitVoip() {
  return new Promise((resolve) => {
    joinSeq++; // 作废在途 join 链（leave() 也转发到这里）：链必须在下一个 await 后自行放弃
    const done = () => {
      // 退出语音先撤回座位映射（2026-11-05 B 方案）：降级指示是「开麦即亮」，人退了
      // 语音还留条目 = 绿环不灭。服务端对空 openid 的处理是清条目并广播（幂等）。
      if (state === 'joined') retractId();
      state = 'idle';
      joinedRoom = '';
      autoJoinBlocked = false; // 换房/退出后允许下次自动入会（2026-11-06）
      othersSpeaking = false;
      lastSpeakers = [];
      memberCount = 0;
      notify();
      resolve({ ok: true });
    };
    if (state !== 'joined') {
      done();
      return;
    }
    try {
      wx.exitVoIPChat({ success: done, fail: done });
    } catch (e) {
      done();
    }
  });
}

/**
 * 语音身份上报（2026-11-03 二期）：把 (openid, muted) 发给对局服务器，
 * 服务端挂到座位 Player 并广播 `{t:'voice', map}` —— 座位级说话/闭麦指示的映射源头。
 * WS 未开（net.send 静默丢弃）时不重试：state 消息驱动的 announce() 会补发。
 */
function announceId() {
  if (state !== 'joined') return;
  const openid = wxauth.getOpenid();
  if (!openid) return; // 未登录（理论不可达：join 前必经 ensureLogin）
  // 2026-11-05 起带 ear 字段：扬声器静音（听不听得到别人）随 voiceId 广播给同房，
  // 远端座位据此显示「闭麦且关扬声器」的 🔇 角标（此前 earMuted 是纯本地状态，远端无从得知）。
  net.send({ t: 'voiceId', openid, muted: micMuted, ear: earMuted });
}

/** 退出/打断语音时撤回座位映射（2026-11-05 B 方案）：空 openid → 服务端清条目并广播。
 *  前提是此前 announce 过（有映射可撤）；WS 未开时静默丢弃 —— 重连后服务端重建的
 *  映射已随人走（房间退场/退出者被 voiceMapOf 过滤），旧条目不会复活。 */
function retractId() {
  net.send({ t: 'voiceId', openid: '', muted: false });
}

/**
 * 进房语音（幂等）：同房已加入直接返回；已在别的房间先退旧的。
 * @param {string} roomCode 6 位房间码
 * @param {{micMuted?:boolean}} [opts] 首次开麦配置；缺省沿用上次状态（首进默认开麦）
 */
async function join(roomCode, opts) {
  const o = opts || {};
  if (!wxauth.getClient()) return { ok: false, reason: 'noClient' };
  if (!GROUP_RE.test(String(roomCode || ''))) return { ok: false, reason: 'badGroup' };
  if (state === 'joined' && joinedRoom === roomCode) return { ok: true, already: true };
  if (state === 'joining') return { ok: false, reason: 'busy' };
  // 开发者工具不支持 VoIP（调用即 fail「暂不支持此 API 调试」）：直接给可读结果，
  // 不调 joinVoIPChat，避免自动入会反复刷 fail 日志（2026-11-06）。
  if (isDevTools()) {
    lastReason = 'devtools';
    lastError = '开发者工具不支持实时语音，请用真机调试';
    notify();
    return { ok: false, reason: 'devtools' };
  }
  if (state === 'joined') await exitVoip();

  const seq = ++joinSeq; // 本链世代号：期间发生 leave/exitVoip/再次 join 都会使它过期
  state = 'joining';
  lastError = '';
  lastReason = '';
  notify();
  try {
    const wantMuted = typeof o.micMuted === 'boolean' ? o.micMuted : micMuted;
    const priv = await new Promise((resolve) => privacy.ensure(resolve));
    if (seq !== joinSeq) return { ok: false, reason: 'abandoned' }; // 链已作废（见 joinSeq 注释）
    if (!priv) {
      lastReason = 'privacyDenied';
      lastError = '需先同意《用户隐私保护指引》才能开启语音';
      return { ok: false, reason: 'privacyDenied' };
    }
    const perm = await ensureMicPermission();
    if (seq !== joinSeq) return { ok: false, reason: 'abandoned' };
    if (!perm.ok) {
      lastReason = perm.reason;
      lastError = perm.reason === 'micDenied' ? '未获麦克风权限' : '权限查询失败';
      return { ok: false, reason: perm.reason };
    }
    let lg = await wxauth.ensureLogin();
    if (seq !== joinSeq) return { ok: false, reason: 'abandoned' };
    if (!lg.ok) {
      lastReason = lg.reason;
      lastError = '微信登录失败';
      return { ok: false, reason: lg.reason };
    }
    let sig = await sign(roomCode, lg.openid);
    if (seq !== joinSeq) return { ok: false, reason: 'abandoned' };
    if (!sig.ok && sig.reason === 'relogin') {
      // 服务端 sessionKey 账本失效（重启/过期）：force 重登后重签一次
      lg = await wxauth.ensureLogin(true);
      if (seq !== joinSeq) return { ok: false, reason: 'abandoned' };
      if (!lg.ok) {
        lastReason = lg.reason;
        lastError = '微信登录失败';
        return { ok: false, reason: lg.reason };
      }
      sig = await sign(roomCode, lg.openid);
      if (seq !== joinSeq) return { ok: false, reason: 'abandoned' };
    }
    if (!sig.ok) {
      lastReason = sig.reason;
      lastError =
        sig.reason === 'voiceDisabled'
          ? '语音功能未开启'
          : sig.reason === 'serverOutdated'
            ? '服务器版本过旧，不支持语音（需部署包含 /api/wx/* 的新版本）'
            : '语音签名失败';
      return { ok: false, reason: sig.reason };
    }
    if (seq !== joinSeq) return { ok: false, reason: 'abandoned' }; // 链已作废：不再入会
    const r = await enterVoip(sig, wantMuted);
    if (!r.ok) {
      lastReason = r.reason;
      // joinFailed:* 经 joinFailText 翻成可操作中文；原始 errMsg 进 console（真机 vConsole 可查）
      if (r.reason.startsWith('joinFailed:')) {
        console.warn('[voice] joinVoIPChat fail:', r.reason.slice('joinFailed:'.length));
        lastError = joinFailText(r.reason.slice('joinFailed:'.length));
      } else {
        lastError = r.reason === 'micDenied' ? '未获麦克风权限' : r.reason;
      }
      return r;
    }
    if (seq !== joinSeq) {
      // 链在入会期间被作废（离房/被踢/发起了新的加入）：刚建立的会话必须立即退掉，
      // 否则人带着孤儿语音会话回首页（麦克风灯亮、能听到原房间、界面无出口）。
      // state 未置 joined（新链可能已在 joining），绕过 exitVoip 的状态守卫直接退会。
      try {
        wx.exitVoIPChat({ success: () => {}, fail: () => {} });
      } catch (e) {
        /* 会话可能已被系统收回 */
      }
      return { ok: false, reason: 'abandoned' };
    }
    state = 'joined';
    joinedRoom = roomCode;
    // 入会成功（无论自动还是手动）即清除「失败挂起」：否则手动连上后若再来电打断，
    // autoJoinBlocked 仍为 true 会抑制「打断后自动重入」，逼用户再点一次（2026-11-06）。
    autoJoinBlocked = false;
    micMuted = !!wantMuted;
    // 联动约束（2026-11-04）：开语音必须开扬声器 —— 入会时清掉「听不到别人」的
    // 旧偏好并落盘，避免上次手动关过扬声器的人这次进来听不见任何声音。
    if (earMuted) {
      earMuted = false;
      store.set(KEY_EAR, false);
    }
    // 入会静音补偿（2026-11-05）：入会成功后若 wantMuted，按真机签名（嵌套
    // muteConfig，见 toggleMic 注释）补一次静音，保证「上次闭麦了这次进会还是闭的」。
    // 失败不阻断（用户可再点一次开关，结果现在可见）。
    if (micMuted) {
      wx.updateVoIPChatMuteConfig({
        muteConfig: { muteMicrophone: true, muteEarphone: false },
        success: () => console.info('[voice] 入会静音已生效'),
        fail: (res) => console.warn('[voice] 入会静音失败：', (res && res.errMsg) || 'unknown'),
      });
    }
    announceId(); // 上报语音身份 → 服务端广播座位映射（大厅/桌面指示的来源）
    return { ok: true };
  } finally {
    // 只有本链仍是当前世代时才把 joining 复位：若链已作废（leave 后又有新 join 在途），
    // state 归新链管，这里乱置 'idle' 会把新链的入会中标志清掉。
    if (state === 'joining' && seq === joinSeq) state = 'idle';
    notify();
  }
}

/** 离房/退到首页/被踢/解散时调用（幂等） */
function leave() {
  if (state === 'idle' && !joinedRoom) {
    return Promise.resolve({ ok: true });
  }
  return exitVoip();
}

/** 开关麦（仅会中有效；状态本地维护，供按钮渲染；翻转后同步上报服务端）。
 *
 * ⚠️ 调用签名以**真机运行时为准**（2026-11-05 实测报错「parameter.muteConfig should
 * be Object instead of Undefined」）：小游戏端是**嵌套 muteConfig 对象**——
 * `{ muteConfig: { microphoneMuted, earphoneMuted } }`；小程序公开文档写的
 * openid 名单签名（mutedMicrophoneList…）在小游戏运行时上不成立，勿改。
 * 之前「开关无效」的观感来自两点叠加：① 失败被场景层吞掉、零日志，成功失败都不可见；
 * ② 胶囊的麦克风灯是**会话级**指示（VoIP 会话活着就亮，静音了也亮）——真正的
 * 验收标准是「别人听不到你」，不是灯灭。 */
function toggleMic() {
  if (state !== 'joined') return Promise.resolve({ ok: false, reason: 'notJoined' });
  const next = !micMuted;
  // 联动语义（2026-11-06 用户定案）：**开麦 = 同步开扬声器**；闭麦不动扬声器。
  // muteConfig 是全量配置（见上注释），两个开关一次下发；开扬声器同时落盘偏好，
  // 避免「会中开麦、按钮仍显已静音偏好」的错位（KEY_EAR 是下次入会的种子）。
  // ⚠ 方向（2026-11-06 修复，曾写反）：next=开麦(false) → earNext=false（同步开扬声器）；
  //   next=闭麦(true) → earNext=earMuted（扬声器维持原状）。写反时「全关闭状态开麦
  //   扬声器不激活」——用户真机报障即为该形态。
  const earNext = next ? earMuted : false;
  return new Promise((resolve) => {
    wx.updateVoIPChatMuteConfig({
      muteConfig: { muteMicrophone: next, muteEarphone: earNext },
      success: () => {
        micMuted = next;
        earMuted = earNext;
        store.set(KEY_EAR, earNext);
        announceId(); // mic/ear 变化 → 重发 voiceId（远端 🔇 角标与指示依赖它）
        notify();
        console.info('[voice] 麦克风 →', next ? '已静音（扬声器维持' + (earMuted ? '关' : '开') + '）' : '已打开（同步开扬声器）');
        resolve({ ok: true, micMuted: next, earMuted: earNext });
      },
      fail: (res) => {
        console.warn('[voice] 麦克风开关失败：', (res && res.errMsg) || 'unknown');
        notify();
        resolve({ ok: false, reason: (res && res.errMsg) || 'muteFailed' });
      },
    });
  });
}

/** 开/关扬声器（听不听得到别人）。
 *  · 联动语义（2026-11-06 用户定案，取代 11-05 的「解耦」）：**关扬声器 = 同步闭麦**
 *    （仍在语音房、不退出）；开扬声器不动麦克风（维持各自当前状态）。
 *    状态空间由此收敛为：开麦+开扬声器（全开）/ 闭麦+开扬声器（只听）/ 闭麦+关扬声器
 *    （全关）——「开麦+关扬声器」不再可达（这正是用户要的：不想出声的人才关扬声器）；
 *  · 未加入语音时仅翻转并持久化偏好（pending；入会时 join 会强制放开扬声器）；
 *  · 🔇 角标（闭麦 且 关扬声器）随 voiceId 广播 mic/ear 字段，远端指示一致。 */
function toggleEar() {
  const next = !earMuted;
  if (state !== 'joined') {
    earMuted = next;
    store.set(KEY_EAR, next);
    notify();
    // pending = 入会时生效：join 链会强制放开扬声器（见 join 注释），本偏好仅作记忆
    return Promise.resolve({ ok: true, earMuted: next, pending: true });
  }
  // 关扬声器 → 强制闭麦；开扬声器 → 麦克风维持原状
  const micNext = next ? true : micMuted;
  return new Promise((resolve) => {
    wx.updateVoIPChatMuteConfig({
      // 真机签名（见 toggleMic 注释）：嵌套 muteConfig 对象
      muteConfig: { muteMicrophone: micNext, muteEarphone: next },
      success: () => {
        earMuted = next;
        micMuted = micNext;
        store.set(KEY_EAR, next);
        announceId(); // mic/ear 变化 → 重发 voiceId（🔇 角标依赖它）
        notify();
        console.info('[voice] 扬声器 →', next ? '已关闭（同步闭麦，留在语音房）' : '已打开（麦克风维持' + (micMuted ? '静音' : '开麦') + '）');
        resolve({ ok: true, earMuted: next, micMuted: micNext });
      },
      fail: (res) => {
        console.warn('[voice] 扬声器开关失败：', (res && res.errMsg) || 'unknown');
        // 应用失败：偏好不动（保持旧值），让按钮与实际听感一致
        notify();
        resolve({ ok: false, reason: (res && res.errMsg) || 'muteFailed' });
      },
    });
  });
}

/** 是否微信开发者工具：VoIP 在 DevTools 不可用（调用即 fail「暂不支持此 API 调试」）。 */
function isDevTools() {
  try {
    const info = wx.getSystemInfoSync ? wx.getSystemInfoSync() : null;
    return !!(info && info.platform === 'devtools');
  } catch (e) {
    return false;
  }
}

/**
 * 进房自动加入（2026-11-06 用户定案：**进入房间即加入语音，但只开扬声器**）。
 * nav.js 收到 state/game 广播时调用（房间码已就位）——广播会频繁到来，必须幂等：
 *   · joined/joining → 空操作（不会重复入会，也不会打断在途 join 链）；
 *   · 语音未开通（probe 已探得 false）→ 空操作，避免每次进房都弹「语音功能未开启」；
 *   · 开发者工具不支持 VoIP → 空操作（否则每条广播都触发 joinVoIPChat:fail，刷满控制台）；
 *   · **失败一次即挂起**（autoJoinBlocked）：广播很密，持续失败时若每条都重试会刷满日志，
 *     leave/exitVoip 复位；手动点语音钮走 join() 不受限；
 *   · **麦克风静音入会**（micMuted: true）：未经用户操作绝不打开麦克风——入会后
 *     处于「只听」态，用户点麦克风 chip（onVoiceTap → toggleMic）才开麦（开麦会
 *     联动开扬声器，见 toggleMic 注释）；手动「开语音」入口不走本函数，不受影响；
 *   · 离房/被踢/解散走 leave() 复位状态 → 下次进房重新自动加入；
 *   · 被打断（来电等）后 state='idle' 但 joinedRoom 保留 → 下一拍 state/game 即自动重入
 *     （同样静音入会，覆盖原 rejoin 自愈语义）。
 */
function autoJoin(code) {
  if (!code) return Promise.resolve({ ok: false, reason: 'noRoom' });
  if (state !== 'idle') return Promise.resolve({ ok: false, reason: state });
  if (available() === false) return Promise.resolve({ ok: false, reason: 'disabled' });
  if (isDevTools()) return Promise.resolve({ ok: false, reason: 'devtools' });
  if (autoJoinBlocked) return Promise.resolve({ ok: false, reason: 'blocked' });
  return join(code, { micMuted: true }).then((r) => {
    if (!r.ok) autoJoinBlocked = true;
    return r;
  });
}

/** 重发 voiceId 上报（幂等；未在语音时空操作），语义见 module.exports 注释 */
function announce() {
  announceId();
}

module.exports = {
  probe,
  available,
  status,
  speakers,
  hasSpeakerData,
  join,
  leave,
  autoJoin,
  toggleMic,
  toggleEar,
  openMicSetting,
  /**
   * 重发语音身份上报（幂等，未在语音时空操作）：
   * 服务端重启/重连后映射丢失，room.js / nav.js 收到 state 视图时调用一次自愈。
   */
  announce,
  setListener(fn) {
    listener = fn || null;
  },
};
