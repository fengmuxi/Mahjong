/**
 * 牌面 CDN 资源（2026-10-18 起代码包内零图片）。
 *
 * 为什么走网络：官方代码包体检要求**图片资源合计 ≤ 200KB** 且 **主包 < 1.5MB**，
 * 34 张牌面无论怎么压都塞不进包（93×135 的 PNG 也有 731KB）。改为：
 *   1. `GET {api}/api/tiles` 取清单 `{ version, base, tiles: ['t00.webp', …] }`；
 *   2. 按清单从 CDN 加载 34 张 WebP（139×202，合计约 251KB，服务端带长缓存）；
 *   3. `<image>` 直接使用地址，画布用 `canvasNode.createImage()` 预解码。
 *
 * **任何一步失败都只回退矢量牌面**（table.js 的 drawTile 与 game.wxml 的手牌条都已实现
 * 矢量兜底），不会白板：域名没登记 / 请求超时 / 单张解码失败，都只是少一层贴图。
 *
 * 清单本身缓存 7 天 + 后台校验版本：断网也能用上次的清单，换美术抬 `MAHJONG_TILES_VER` 即失效。
 */
const config = require('./config.js');

const CACHE_KEY = 'mj-tiles';
/** 已解码的画布位图：tile → CanvasImage（画布绘制用；DOM 手牌条直接吃地址） */
const images = new Map();
let state = null; // { version, base, tiles: string[] }
let status = 'idle'; // idle | loading | ready | failed
let listeners = [];

function flush(ok) {
  const list = listeners.slice();
  listeners.length = 0;
  for (const cb of list) {
    try {
      cb(ok);
    } catch (e) {
      /* 回调出错不影响渲染 */
    }
  }
}

function readCache() {
  try {
    const raw = wx.getStorageSync(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && Array.isArray(o.tiles) && o.tiles.length ? o : null;
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

/**
 * 取清单。有缓存就**先用缓存回调一次**（牌立刻画出来、不等网络），同时后台校验版本。
 * cb 只会被调用一次（后续版本刷新不再回调，交给下一次进页）。
 */
function ensure(cb) {
  if (typeof cb === 'function') listeners.push(cb);
  if (status === 'ready' || status === 'failed') {
    flush(status === 'ready');
    return;
  }
  if (status === 'loading') return;

  status = 'loading';
  const cached = readCache();
  if (cached) {
    state = cached;
    status = 'ready';
    flush(true);
  }

  const host = config.resolveApi();
  if (!host) {
    if (status !== 'ready') {
      status = 'failed';
      flush(false);
    }
    return;
  }

  wx.request({
    url: `${host}/api/tiles`,
    method: 'GET',
    timeout: 8000,
    success: (res) => {
      const o = res && res.data;
      if (!o || !Array.isArray(o.tiles) || o.tiles.length === 0) {
        if (status !== 'ready') {
          status = 'failed';
          flush(false);
        }
        return;
      }
      const next = {
        version: String(o.version || ''),
        // base 为空 = 与接口同源
        base: String(o.base || host).replace(/\/+$/, ''),
        tiles: o.tiles,
      };
      if (cached && cached.version !== next.version) images.clear(); // 换了美术 → 丢掉旧位图
      if (!cached || cached.version !== next.version) {
        state = next;
        writeCache(next);
      }
      status = 'ready';
      flush(true);
    },
    fail: () => {
      // 网络/域名问题：有缓存就继续用缓存，没有就只能矢量兜底
      if (status !== 'ready') {
        status = 'failed';
        flush(false);
      }
    },
  });
}

/** 该牌的 CDN 地址；未就绪返回空串 —— 调用方据此回退矢量牌面 */
function urlOf(t) {
  if (status !== 'ready' || !state) return '';
  const name = state.tiles[t];
  if (!name) return '';
  return `${state.base}/tiles/${name}`;
}

/** 画布用的已解码位图；没有返回 null → drawTile 回退矢量 */
function art(t) {
  return images.get(t) || null;
}

/** 预解码 34 张到 canvas（小程序 CanvasImage），全部完成/失败后回调一次 */
function preload(canvasNode, onDone) {
  if (status !== 'ready' || !canvasNode || typeof canvasNode.createImage !== 'function') {
    if (typeof onDone === 'function') onDone(false);
    return;
  }
  let pending = 0;
  const tick = () => {
    pending -= 1;
    if (pending <= 0 && typeof onDone === 'function') onDone(images.size > 0);
  };
  for (let t = 0; t < 34; t++) {
    if (images.has(t)) continue;
    const url = urlOf(t);
    if (!url) continue;
    pending += 1;
    const img = canvasNode.createImage();
    img.onload = () => {
      images.set(t, img);
      tick();
    };
    img.onerror = () => tick();
    img.src = url;
  }
  if (pending === 0 && typeof onDone === 'function') onDone(images.size > 0);
}

module.exports = {
  ensure,
  urlOf,
  art,
  preload,
  ready() {
    return status === 'ready';
  },
};
