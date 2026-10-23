/**
 * 局内音效（2026-10-23 新增）。
 *
 * 与牌面 / UI 贴图同套路 —— **音频也不进代码包**（官方体检红线：主包 < 1.5MB、
 * 图+音 ≤ 200KB），走 `GET /api/sound` 清单 + CDN 静态文件：
 *   1. `GET {api}/api/sound` 取清单 `{ version, base, sounds: { discard:'discard.mp3', … } }`；
 *   2. `wx.createInnerAudioContext()` 按键播放（远端 src 需在 **downloadFile** 合法域名里）。
 *
 * 键名（与服务端 SOUND_FILES 一一对应）：
 *   discard 出牌 · deal 发牌/摸牌 · gang 杠 · peng 碰 · hu 胡 · click 点击手牌
 *
 * 约定：
 *   · 任何一步失败都**只打一条日志**，绝不影响对局（没音效只是没声音）；
 *   · 同一音效连播 → stop + seek(0) + play（不叠音）；
 *   · 静音键不掐断音效（obeyMuteSwitch = false）；
 *   · `unlock()` 在首个用户交互时调用，解锁 iOS 的音频自动播放限制
 *     （否则「他人出牌 / 碰杠胡」这类无交互触发的音效在 iOS 真机上不响）。
 */
const config = require('./config.js');

const CACHE_KEY = 'mj-sound';
const CACHE_DAYS = 7;
const DEFAULT_VOLUME = 0.85;

let state = null; // { version, base, sounds }
let status = 'idle'; // idle | loading | ready | failed
let enabled = true;
let unlocked = false;
let listeners = [];
let inflight = false;
let netSettled = false;
let lastLogged = '';
/** key → InnerAudioContext（每键一个，重复播放走同一个） */
const pool = new Map();
/** 播放失败过的键：不再重试（避免每次出牌都刷错误日志） */
const failed = new Set();
/** key → 上次播放时间戳（用于 minGap 节流） */
const lastPlayed = new Map();

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

function readCache() {
  try {
    const raw = wx.getStorageSync(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.sounds && Object.keys(o.sounds).length ? o : null;
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

/** 取清单。有缓存先用缓存回调一次（进房就能发声），同时后台校验版本。 */
function ensure(cb) {
  if (typeof cb === 'function') listeners.push(cb);
  if (netSettled) {
    flush(status === 'ready');
    return;
  }
  if (inflight) return;

  inflight = true;
  enabled = readEnabled();
  const cached = readCache();
  if (cached) {
    state = cached;
    status = 'ready';
    emit(true);
  }

  const host = config.resolveApi();
  if (!host) {
    inflight = false;
    netSettled = true;
    if (status !== 'ready') status = 'failed';
    log('warn', '[sound] 未拿到 API 域名（config.resolveApi 为空）→ 局内静音；检查 utils/config.js 的 DEFAULT_WSS');
    flush(status === 'ready');
    return;
  }

  wx.request({
    url: `${host}/api/sound`,
    method: 'GET',
    timeout: 8000,
    success: (res) => {
      const o = res && res.data;
      if (!o || !o.sounds || Object.keys(o.sounds).length === 0) {
        log('warn', `[sound] 清单为空（${host}/api/sound 返回 0 项）→ 局内静音；确认服务端 public/sound 是否随版本一起发布`);
        inflight = false;
        netSettled = true;
        if (status !== 'ready') status = 'failed';
        flush(status === 'ready');
        return;
      }
      const next = {
        version: String(o.version || ''),
        base: String(o.base || host).replace(/\/+$/, ''),
        sounds: o.sounds,
      };
      state = next;
      writeCache(next);
      status = 'ready';
      inflight = false;
      netSettled = true;
      log('info', `[sound] ready ${next.version} · ${Object.keys(next.sounds).length} 项 · ${next.base}`);
      flush(true);
    },
    fail: (err) => {
      log('warn', `[sound] 清单请求失败（${host}/api/sound，${(err && err.errMsg) || 'unknown'}）→ 局内静音；检查网络与 request 合法域名`);
      inflight = false;
      netSettled = true;
      if (status !== 'ready') status = 'failed';
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
  ctx.src = url;
  ctx.obeyMuteSwitch = false; // 静音键不掐断游戏音效
  ctx.onError((err) => {
    failed.add(key);
    log('warn', `[sound] 播放失败 ${key}：${(err && err.errMsg) || 'unknown'}（检查 downloadFile 合法域名是否含音频域名）`);
  });
  pool.set(key, ctx);
  return ctx;
}

/**
 * 播一个音效。返回是否真的播了（清单未就绪 / 已静音 / 之前失败过 → false）。
 * 同一键连播不叠音：stop + seek(0) + play。
 * `opts.minGap`（ms）：同键最小播放间隔 —— 发牌是**逐张广播**的（13 张 = 13 次 view），
 * 不节流会连响 13 下；调用处给 deal 传 250。
 */
function play(key, opts) {
  if (!enabled) return false;
  if (failed.has(key)) return false;
  const url = urlOf(key);
  if (!url) return false;
  const now = Date.now();
  const gap = opts && opts.minGap ? opts.minGap : 0;
  if (gap) {
    const last = lastPlayed.get(key) || 0;
    if (now - last < gap) return false;
  }
  try {
    const ctx = pool.get(key) || createCtx(key, url);
    const vol = opts && opts.volume !== undefined ? opts.volume : DEFAULT_VOLUME;
    ctx.volume = vol;
    try {
      ctx.stop();
    } catch (e) {
      /* 忽略 */
    }
    try {
      ctx.seek(0);
    } catch (e) {
      /* 忽略 */
    }
    ctx.play();
    lastPlayed.set(key, now);
    return true;
  } catch (e) {
    failed.add(key);
    log('warn', `[sound] 播放 ${key} 异常：${(e && e.message) || e}`);
    return false;
  }
}

/**
 * iOS 解锁：音频会话要在用户交互后才能播。
 * 在首个用户交互（点手牌等）里调一次：放一个 0 音量的 context 播一下即解锁。
 */
function unlock() {
  if (unlocked) return;
  unlocked = true;
  const url = urlOf('click');
  if (!url) return;
  try {
    const ctx = wx.createInnerAudioContext();
    ctx.volume = 0;
    ctx.src = url;
    ctx.play();
    setTimeout(() => {
      try {
        ctx.destroy();
      } catch (e) {
        /* 忽略 */
      }
    }, 500);
  } catch (e) {
    /* 解锁失败不影响后续 */
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
  }
  return enabled;
}

module.exports = {
  ensure,
  play,
  unlock,
  setEnabled,
  urlOf,
  isEnabled: () => enabled,
  ready: () => status === 'ready',
  debug() {
    return {
      status,
      enabled,
      version: state ? state.version : '',
      count: state ? Object.keys(state.sounds).length : 0,
      failed: Array.from(failed),
    };
  },
};
