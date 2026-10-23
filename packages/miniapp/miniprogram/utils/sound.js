/**
 * 局内音效（2026-10-23 新增）。
 *
 * 与牌面 / UI 贴图同套路 —— **音频也不进代码包**（官方体检红线：主包 < 1.5MB、
 * 图+音 ≤ 200KB），走 `GET /api/sound` 清单 + CDN 静态文件：
 *   1. `GET {api}/api/sound` 取清单 `{ version, base, sounds: { discard:'discard.mp3', … } }`；
 *   2. `wx.createInnerAudioContext()` 按键播放（远端 src 需在 **downloadFile** 合法域名里）。
 *   3. 清单请求失败/未返回时，用内置文件名 + 当前 API host 兜底（request 域名未登记也能响）。
 *
 * 键名（与服务端 SOUND_FILES 一一对应）：
 *   discard 出牌 · deal 发牌/摸牌 · gang 杠 · peng 碰 · hu 胡 · chi 吃 · click 点击手牌
 *   bgm 背景音乐（1MB 循环长音频，唯一的大文件；按需下载，不进代码包）
 *
 * 约定：
 *   · 任何一步失败都**只打一条日志**，绝不影响对局（没音效只是没声音）；
 *   · 同一音效连播 → 已播过才 stop + play（不叠音；新 context 不 stop/seek）；
 *   · 静音键不掐断音效（obeyMuteSwitch = false + app.js 的全局 setInnerAudioOption）；
 *   · `unlock()` 在用户交互时调用；清单没就绪不置 unlocked，下次交互继续重试
 *     （否则「他人出牌 / 碰杠胡」这类无交互触发的音效在 iOS 真机上不响）；
 *   · **BGM 有独立开关**（`setBgmEnabled` / `toggleBgm`，存 `mj-sound-bgm`），
 *     与音效总开关 `setEnabled`（存 `mj-sound-enabled`）互不影响。
 */
const config = require('./config.js');

const CACHE_KEY = 'mj-sound';
/** 背景音乐开关的独立存储键（2026-10-23：与音效总开关解耦） */
const BGM_KEY = CACHE_KEY + '-bgm';
const CACHE_DAYS = 7;
const DEFAULT_VOLUME = 0.85;
/** 背景音乐音量：低于音效，避免盖住出牌/碰杠胡反馈 */
const BGM_VOLUME = 0.3;
/** 清单请求失败后的重试间隔 / 次数（真机首屏网络抖动时不能一失即哑） */
const RETRY_MS = 8000;
const MAX_RETRIES = 3;
/** 连续失败 3 次后冷却 30s 再试（避免一次网络抖动把某个音效永久拉黑） */
const FAIL_RESET_MS = 30000;
/**
 * 本地兜底清单（2026-10-23）：服务端 SOUND_FILES 的约定文件名。
 * `/api/sound` 只是「版本 + CDN base」的覆盖；请求域名未登记 / 首屏网络抖动时，
 * 直接用当前 API host 拼 `/sound/xxx.mp3` 播放，避免整局静音。
 */
const DEFAULT_SOUNDS = {
  discard: 'discard.mp3',
  deal: 'deal.mp3',
  gang: 'gang.mp3',
  peng: 'peng.mp3',
  hu: 'hu.mp3',
  chi: 'chi.mp3',
  click: 'click.mp3',
  bgm: 'bgm.mp3',
};

let state = null; // { version, base, sounds, host, ts }
let status = 'idle'; // idle | loading | ready | failed
let enabled = true;
let unlocked = false;
let listeners = [];
let inflight = false;
let netSettled = false;
let retries = 0;
let retryTimer = null;
let lastLogged = '';
/** key → InnerAudioContext（每键一个，重复播放走同一个） */
const pool = new Map();
/** key → 连续失败次数（失败 3 次才放弃；成功一次即清零，不再永久拉黑） */
const failCounts = new Map();
/** key → 最近一次失败时间（用于 30s 冷却后重试） */
const failAt = new Map();
/** key → 上次播放时间戳（用于 minGap 节流） */
const lastPlayed = new Map();
/** 背景音乐实例 / 是否希望播放（用于 onShow/手势重试） / 是否正在播 / 用户是否开启 */
let bgmCtx = null;
let bgmWanted = false;
let bgmPlaying = false;
let bgmEnabled = true;

function log(level, msg) {
  if (lastLogged === msg) return;
  lastLogged = msg;
  try {
    if (level === 'warn') console.warn(msg);
    else console.info(msg);
  } catch (e) {
    /* 控制台不可用时忽略 */
  }
}

function safeCall(cb, ok) {
  try {
    cb(ok);
  } catch (e) {
    /* 回调出错不影响渲染 */
  }
}

function emit(ok) {
  for (const cb of listeners.slice()) safeCall(cb, ok);
}

function flush(ok) {
  const list = listeners.splice(0, listeners.length);
  for (const cb of list) safeCall(cb, ok);
}

function hostOf(url) {
  const m = /^(?:https?|wss?):\/\/([^/]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

function readCache(host) {
  try {
    const raw = wx.getStorageSync(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.sounds || Object.keys(o.sounds).length === 0) return null;
    // 新缓存带 host（API 域名）；旧缓存没有 host，只拦「http 局域网/旧环境」地址，
    // 不拦独立 CDN（base 可能是另一个 https 域名）。
    if (o.host) {
      if (host && hostOf(o.host) !== hostOf(host)) return null;
    } else if (o.base && /^http:\/\//i.test(o.base) && host && hostOf(o.base) !== hostOf(host)) {
      return null;
    }
    if (o.ts && Date.now() - Number(o.ts) > CACHE_DAYS * 86400000) return null;
    return o;
  } catch (e) {
    return null;
  }
}

function writeCache(o) {
  try {
    wx.setStorageSync(CACHE_KEY, JSON.stringify(o));
  } catch (e) {
    /* 存储不可用时忽略 */
  }
}

function readEnabled() {
  try {
    const v = wx.getStorageSync(CACHE_KEY + '-enabled');
    if (v === false || v === 'false') return false;
  } catch (e) {
    /* 忽略 */
  }
  return true;
}

/** 背景音乐开关：默认开；只有显式存过 false 才关 */
function readBgmEnabled() {
  try {
    const v = wx.getStorageSync(BGM_KEY);
    if (v === false || v === 'false') return false;
  } catch (e) {
    /* 忽略 */
  }
  return true;
}

function scheduleRetry() {
  if (retryTimer || retries >= MAX_RETRIES) return;
  retries += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    netSettled = false;
    ensure();
  }, RETRY_MS * retries);
}

/**
 * 取清单。先立即用「缓存 / 本地兜底清单」置 ready（进房第一声就能响），
 * 再后台请求 `/api/sound` 校验版本。请求失败只影响版本刷新，不再整局静音。
 */
function ensure(cb) {
  if (typeof cb === 'function') listeners.push(cb);
  if (inflight) return;

  enabled = readEnabled();
  bgmEnabled = readBgmEnabled();
  if (!enabled) log('warn', '[sound] 音效已被存储开关关闭（mj-sound-enabled=false）→ 如需恢复执行 setEnabled(true)');
  const host = config.resolveApi();
  if (!host) {
    netSettled = true;
    if (status !== 'ready') status = 'failed';
    log('warn', '[sound] 未拿到 API 域名（config.resolveApi 为空）→ 局内静音；检查 utils/config.js 的 DEFAULT_WSS');
    flush(status === 'ready');
    return;
  }
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(host)) {
    log('warn', `[sound] API 指向局域网 ${host} → 真机不在同一 Wi-Fi 时音频/牌面都会失败；清 mj-wss / mj-api 或改 DEFAULT_WSS`);
  }

  // 运行期换了 host（如从局域网切到线上）：旧 base / 旧 context 全部作废
  if (state && state.host && state.host !== host) {
    state = null;
    status = 'idle';
    netSettled = false;
    retries = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    failCounts.clear();
    failAt.clear();
  }

  if (status !== 'ready') {
    const cached = readCache(host);
    state = cached
      ? Object.assign({}, cached, {
          sounds: Object.assign({}, DEFAULT_SOUNDS, cached.sounds), // 旧缓存补上新键（如 chi）
        })
      : {
          version: 'local',
          base: host,
          sounds: Object.assign({}, DEFAULT_SOUNDS),
          host,
          ts: Date.now(),
        };
    if (!state.host) state.host = host;
    if (!/^https?:\/\//i.test(String(state.base || ''))) state.base = host;
    status = 'ready';
    log('info', `[sound] ready(local) · ${state.base} · ${Object.keys(state.sounds).length} 项`);
    emit(true);
  }

  if (netSettled) {
    flush(true);
    return;
  }

  inflight = true;
  log('info', `[sound] GET ${host}/api/sound`);
  wx.request({
    url: `${host}/api/sound`,
    method: 'GET',
    timeout: 8000,
    success: (res) => {
      const o = res && res.data;
      inflight = false;
      netSettled = true;
      if (!o || !o.sounds || Object.keys(o.sounds).length === 0) {
        log('warn', `[sound] 清单为空（${host}/api/sound 返回 0 项）→ 继续用本地清单；确认服务端 public/sound 是否随版本一起发布`);
        if (status !== 'ready') status = 'failed';
        if (status === 'ready') scheduleRetry();
        flush(status === 'ready');
        return;
      }
      const rawBase = String(o.base || host).replace(/\/+$/, '');
      const next = {
        version: String(o.version || ''),
        base: /^https?:\/\//i.test(rawBase) ? rawBase : host,
        sounds: Object.assign({}, DEFAULT_SOUNDS, o.sounds), // 客户端先更新、服务端清单未跟上时仍能取到 chi
        host,
        ts: Date.now(),
      };
      state = next;
      writeCache(next);
      status = 'ready';
      retries = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      log('info', `[sound] ready ${next.version} · ${Object.keys(next.sounds).length} 项 · ${next.base}`);
      flush(true);
    },
    fail: (err) => {
      inflight = false;
      netSettled = true;
      if (status !== 'ready') status = 'failed';
      log('warn', `[sound] 清单请求失败（${host}/api/sound，${(err && err.errMsg) || 'unknown'}）→ 继续用本地清单；检查网络与 request 合法域名`);
      if (status === 'ready') scheduleRetry();
      flush(status === 'ready');
    },
  });
}

/** 该键的 CDN 地址；未就绪/无此键返回空串 */
function urlOf(key) {
  if (status !== 'ready' || !state) return '';
  const name = state.sounds[key];
  if (!name) return '';
  return `${state.base}/sound/${name}`;
}

function createCtx(key, url) {
  const ctx = wx.createInnerAudioContext();
  ctx.obeyMuteSwitch = false; // 静音键不掐断游戏音效
  ctx.src = url;
  ctx._mjUrl = url;
  ctx._mjStarted = false;
  ctx.onPlay(() => {
    ctx._mjStarted = true;
    failCounts.delete(key);
    failAt.delete(key);
  });
  ctx.onStop(() => {
    ctx._mjStarted = false;
  });
  ctx.onEnded(() => {
    ctx._mjStarted = false;
  });
  ctx.onError((err) => {
    ctx._mjStarted = false;
    const n = (failCounts.get(key) || 0) + 1;
    failCounts.set(key, n);
    failAt.set(key, Date.now());
    log('warn', `[sound] 播放失败 ${key}（第 ${n} 次）：${(err && err.errMsg) || 'unknown'}（检查 downloadFile 合法域名是否含音频域名）`);
  });
  pool.set(key, ctx);
  return ctx;
}

/**
 * 播一个音效。返回是否真的播了（未就绪 / 已静音 / 连续失败 3 次 → false）。
 * 同一键连播不叠音：只在**已经播过**时 stop，再 play（新 context 直接 play，
 * 避免部分机型对未开始播放的 context 调 stop/seek 触发错误并被误判为永久失败）。
 * `opts.minGap`（ms）：同键最小播放间隔 —— 发牌是**逐张广播**的（13 张 = 13 次 view），
 * 不节流会连响 13 下；调用处给 deal 传 250。
 */
function play(key, opts) {
  if (!enabled) return false;
  let url = urlOf(key);
  if (!url) {
    ensure();
    url = urlOf(key); // 兜底清单在 ensure() 里同步置 ready，首次操作也能响
    if (!url) {
      log('warn', `[sound] 未就绪，跳过 ${key}（base 为空）`);
      return false;
    }
  }
  const n = failCounts.get(key) || 0;
  if (n >= 3) {
    if (Date.now() - (failAt.get(key) || 0) > FAIL_RESET_MS) {
      failCounts.delete(key);
      failAt.delete(key);
    } else {
      return false;
    }
  }
  const now = Date.now();
  const gap = opts && opts.minGap ? opts.minGap : 0;
  if (gap) {
    const last = lastPlayed.get(key) || 0;
    if (now - last < gap) return false;
  }
  try {
    const ctx = pool.get(key) || createCtx(key, url);
    if (ctx._mjUrl !== url) {
      ctx.src = url;
      ctx._mjUrl = url;
    }
    const vol = opts && opts.volume !== undefined ? opts.volume : DEFAULT_VOLUME;
    ctx.volume = vol;
    if (ctx._mjStarted) {
      try {
        ctx.stop();
      } catch (e) {
        /* 忽略 */
      }
    }
    ctx.play();
    ctx._mjStarted = true;
    lastPlayed.set(key, now);
    return true;
  } catch (e) {
    const n = (failCounts.get(key) || 0) + 1;
    failCounts.set(key, n);
    failAt.set(key, Date.now());
    log('warn', `[sound] 播放 ${key} 异常（第 ${n} 次）：${(e && e.message) || e}`);
    return false;
  }
}

/**
 * iOS 解锁：音频会话要在用户交互后才能播。
 * **清单没就绪时不能把 unlocked 置 true** —— 否则首次点牌太早会永久失去解锁机会。
 * 每次用户交互都可以重复调；真正 play 成功后才算解锁。
 */
function unlock() {
  if (!enabled) return;
  if (unlocked) return;
  let url = urlOf('click');
  if (!url) {
    ensure();
    url = urlOf('click');
  }
  if (!url) {
    log('info', '[sound] 解锁等待清单就绪…');
    return;
  }
  try {
    const ctx = wx.createInnerAudioContext();
    ctx.obeyMuteSwitch = false;
    ctx.volume = 0.01; // 0 音量在部分 iOS 上不算解锁，留一点底噪
    ctx.src = url;
    ctx.onError(() => {
      unlocked = false;
      try {
        ctx.destroy();
      } catch (e) {
        /* 忽略 */
      }
    });
    ctx.play();
    unlocked = true;
    failCounts.clear(); // 解锁前被 iOS 拦下的播放失败不算数，解锁后重新给每个键机会
    failAt.clear();
    bgmStart(); // 首次手势顺便起背景音乐（iOS 无手势会被拦）
    setTimeout(() => {
      try {
        ctx.destroy();
      } catch (e) {
        /* 忽略 */
      }
    }, 500);
  } catch (e) {
    unlocked = false;
    /* 解锁失败不影响后续 */
  }
}

/**
 * 背景音乐：循环播放，进局开始、退局停止、切后台暂停。
 * 与音效共用 `mj-sound` 清单/兜底地址；iOS 首次播放仍需用户手势，
 * 所以 `onShow` 先试一次，失败时 `unlock()` 会在首个手势里再起。
 * **`bgmWanted` 只记「本局要不要 BGM」，与用户开关 `bgmEnabled` 分开**：
 * 开关关掉时仍然置 wanted=true（这样在开关里重新打开就能立刻续播），
 * 但不创建 / 不播放实例。
 */
function bgmStart() {
  bgmWanted = true;
  if (!enabled || !bgmEnabled) return;
  let url = urlOf('bgm');
  if (!url) {
    ensure();
    url = urlOf('bgm');
  }
  if (!url) return;
  try {
    if (!bgmCtx) {
      const ctx = wx.createInnerAudioContext();
      bgmCtx = ctx;
      ctx.loop = true;
      ctx.obeyMuteSwitch = false;
      ctx.volume = BGM_VOLUME;
      ctx.src = url;
      ctx._mjUrl = url;
      ctx.onPlay(() => {
        bgmPlaying = true;
      });
      ctx.onPause(() => {
        bgmPlaying = false;
      });
      ctx.onStop(() => {
        bgmPlaying = false;
      });
      ctx.onEnded(() => {
        bgmPlaying = false;
        if (bgmWanted && enabled) {
          try {
            ctx.play();
          } catch (e) {
            /* 忽略 */
          }
        }
      });
      ctx.onError((err) => {
        bgmPlaying = false;
        log('warn', `[sound] 背景音乐失败：${(err && err.errMsg) || 'unknown'}（检查 downloadFile 合法域名/文件是否部署）`);
        if (bgmCtx === ctx) bgmCtx = null;
        try {
          ctx.destroy();
        } catch (e) {
          /* 忽略 */
        }
      });
    } else if (bgmCtx._mjUrl !== url) {
      bgmCtx.src = url;
      bgmCtx._mjUrl = url;
      bgmPlaying = false;
    }
    if (!bgmPlaying) bgmCtx.play();
  } catch (e) {
    bgmPlaying = false;
    log('warn', `[sound] 背景音乐异常：${(e && e.message) || e}`);
  }
}

/** 切后台/离开页面：暂停但保留“想播”状态，回来继续 */
function bgmPause() {
  if (!bgmCtx) return;
  try {
    bgmCtx.pause();
  } catch (e) {
    /* 忽略 */
  }
}

/** 退局：停止并释放背景音乐实例 */
function bgmStop() {
  bgmWanted = false;
  if (!bgmCtx) return;
  const ctx = bgmCtx;
  bgmCtx = null;
  bgmPlaying = false;
  try {
    ctx.stop();
  } catch (e) {
    /* 忽略 */
  }
  try {
    ctx.destroy();
  } catch (e) {
    /* 忽略 */
  }
}

/** 静音开关（持久化）。关掉后 play() 直接返回 false。 */
function setEnabled(v) {
  enabled = !!v;
  try {
    wx.setStorageSync(CACHE_KEY + '-enabled', enabled);
  } catch (e) {
    /* 忽略 */
  }
  if (!enabled) {
    for (const ctx of pool.values()) {
      try {
        ctx.stop();
      } catch (e) {
        /* 忽略 */
      }
    }
    bgmPause();
  } else {
    failCounts.clear();
    failAt.clear();
    if (bgmWanted) bgmStart();
  }
  return enabled;
}

/**
 * 背景音乐开关（独立于音效总开关，持久化到 `mj-sound-bgm`）。
 *
 * 关 → 立即暂停：**保留实例与播放进度**，重新打开时瞬间续播、不重下载 1MB 音频；
 * 开 → 本局希望有 BGM（bgmWanted）就立刻续播（iOS 若还没被手势解锁，
 *      调用方应先 `unlock()`；本轮 UI 的切换手势本身就会解锁）。
 * 返回切换后的状态，便于 UI 直接 setData。
 */
function setBgmEnabled(v) {
  bgmEnabled = !!v;
  try {
    wx.setStorageSync(BGM_KEY, bgmEnabled);
  } catch (e) {
    /* 存储不可用时只影响下次进局的默认值 */
  }
  if (!bgmEnabled) {
    bgmPause();
  } else if (bgmWanted && enabled) {
    bgmStart();
  }
  return bgmEnabled;
}

/** 切换背景音乐开关并返回切换后的状态 */
function toggleBgm() {
  return setBgmEnabled(!bgmEnabled);
}

module.exports = {
  ensure,
  play,
  unlock,
  bgmStart,
  bgmPause,
  bgmStop,
  setEnabled,
  setBgmEnabled,
  toggleBgm,
  urlOf,
  isEnabled: () => enabled,
  isBgmEnabled: () => bgmEnabled,
  ready: () => status === 'ready',
  debug() {
    const fails = {};
    for (const [k, n] of failCounts) fails[k] = n;
    return {
      status,
      enabled,
      unlocked,
      version: state ? state.version : '',
      base: state ? state.base : '',
      count: state ? Object.keys(state.sounds).length : 0,
      retries,
      failed: fails,
      bgm: { enabled: bgmEnabled, wanted: bgmWanted, playing: bgmPlaying },
    };
  },
};
