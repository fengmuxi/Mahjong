/**
 * 头像资源（2026-11-04）：玩家可选头像（原神角色），命名 `a01` … `aNN`。
 *
 * 与 utils/uiart.js 同套路（清单下发 + 画布预解码 + 矢量/缺图回退）：
 *   1. `GET {api}/api/avatars` 取清单 `{ version, base, avatars: ['a01', …] }`；
 *   2. 选择器/铭牌按 id 从 CDN 加载，`preload` 给 canvas 预解码；
 *   3. 任何一步失败只回退各绘制点的风位圆方案，不会白板。
 *
 * 头像图集由 `.recover-tmp/avif2png.mjs` 从源 avif 转换（微信 canvas 对 avif 不稳），
 * 清单缓存 7 天 + 后台校验版本：断网也能用上次清单，换头像抬 `MAHJONG_AVATAR_VER` 即失效。
 */

const config = require('./config.js');

const CACHE_KEY = 'mj-avatar-art';
/** 已解码的画布位图：id → CanvasImage（canvas 绘制用；DOM 直接吃地址） */
const images = new Map();
let state = null; // { version, base, avatars: string[] }
let status = 'idle'; // idle | loading | ready | failed
let listeners = [];
let inflight = false;
let netSettled = false;

let lastLogged = '';
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

/** 立刻回调、**不清空监听**：缓存清单先让界面秒开，网络清单回来再回一次 */
function emit(ok) {
  for (const cb of listeners.slice()) safeCall(cb, ok);
}

/** 终态回调：清空监听 */
function flush(ok) {
  const list = listeners.splice(0, listeners.length);
  for (const cb of list) safeCall(cb, ok);
}

function readCache() {
  try {
    const raw = wx.getStorageSync(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.avatars && Array.isArray(o.avatars) && o.avatars.length ? o : null;
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

/** 取清单。有缓存就先用缓存回调一次，同时后台校验版本。 */
function ensure(cb) {
  if (typeof cb === 'function') listeners.push(cb);
  if (netSettled) {
    flush(status === 'ready');
    return;
  }
  if (inflight) return;

  inflight = true;
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
    log('warn', '[avatar-art] 未拿到 API 域名（config.resolveApi 为空）→ 头像走风位圆兜底；检查 utils/config.js 的 DEFAULT_WSS');
    if (status !== 'ready') status = 'failed';
    flush(status === 'ready');
    return;
  }

  wx.request({
    url: `${host}/api/avatars`,
    method: 'GET',
    timeout: 8000,
    success: (res) => {
      const o = res && res.data;
      if (!o || !o.avatars || !Array.isArray(o.avatars) || o.avatars.length === 0) {
        log('warn', `[avatar-art] 清单为空（${host}/api/avatars 返回 0 项）→ 头像走风位圆兜底；先确认服务端 public/avatars 是否随版本一起发布`);
        inflight = false;
        netSettled = true;
        if (status !== 'ready') status = 'failed';
        flush(status === 'ready');
        return;
      }
      const next = {
        version: String(o.version || ''),
        base: String(o.base || host).replace(/\/+$/, ''),
        avatars: o.avatars,
      };
      if (cached && cached.version !== next.version) images.clear(); // 换了头像集 → 丢掉旧位图
      state = next;
      writeCache(next);
      status = 'ready';
      inflight = false;
      netSettled = true;
      log('info', `[avatar-art] ready ${next.version} · ${next.avatars.length} 张 · ${next.base}`);
      flush(true);
    },
    fail: (err) => {
      log('warn', `[avatar-art] 清单请求失败（${host}/api/avatars，${(err && err.errMsg) || 'unknown'}）→ 头像走风位圆兜底；检查网络与 request 合法域名`);
      inflight = false;
      netSettled = true;
      if (status !== 'ready') status = 'failed';
      flush(status === 'ready');
    },
  });
}

/** 头像清单里的 id 列表（['a01', …]），供选择器渲染网格；未就绪返回空数组 */
function list() {
  return state && Array.isArray(state.avatars) ? state.avatars.slice() : [];
}

/** 某 id 的 CDN 地址；未就绪/无此 id 返回空串 —— 调用方据此回退 */
function urlOf(id) {
  if (status !== 'ready' || !state || !id) return '';
  return `${state.base}/avatars/${id}.png?v=${state.version}`;
}

/** 画布用的已解码位图；没有返回 null → 各绘制点回退风位圆 */
function art(id) {
  return images.get(id) || null;
}

/**
 * 预解码指定 id 列表到 canvas（小程序 CanvasImage），全部完成/失败后回调一次。
 *
 * @param onEach 可选：每张解码完成（或失败）时回调一次 —— 供「后到的头像陆续补画」
 *              用（池子变大后全部等齐会拖慢进桌，见 game.js 的头像通道超时兜底）。
 */
function preload(canvasNode, ids, onDone, onEach) {
  if (status !== 'ready' || !canvasNode || typeof canvasNode.createImage !== 'function' || !Array.isArray(ids)) {
    if (typeof onDone === 'function') onDone(false);
    return;
  }
  let pending = 0;
  const tick = () => {
    pending -= 1;
    if (pending <= 0 && typeof onDone === 'function') onDone(images.size > 0);
  };
  for (const id of ids) {
    if (images.has(id)) continue;
    const url = urlOf(id);
    if (!url) continue;
    pending += 1;
    const img = canvasNode.createImage();
    img.onload = () => {
      images.set(id, img);
      if (typeof onEach === 'function') onEach(id, img);
      tick();
    };
    img.onerror = () => {
      if (typeof onEach === 'function') onEach(id, null);
      tick();
    };
    img.src = url;
  }
  if (pending === 0 && typeof onDone === 'function') onDone(images.size > 0);
}

module.exports = {
  ensure,
  list,
  urlOf,
  art,
  preload,
  ready() {
    return status === 'ready';
  },
  /** 排查用：控制台执行 `require('../../utils/avatarart.js').debug()` 看卡在哪一步 */
  debug() {
    let host = '';
    try {
      host = config.resolveApi();
    } catch (e) {
      host = '';
    }
    return {
      status,
      host,
      version: state ? state.version : '',
      count: state ? state.avatars.length : 0,
      decoded: images.size,
    };
  },
};
