/**
 * 牌面 CDN 资源（2026-10-18 起代码包内零图片）。
 *
 * 为什么走网络：官方代码包体检要求**图片资源合计 ≤ 200KB** 且 **主包 < 1.5MB**，
 * 34 张牌面无论怎么压都塞不进包（93×135 的 PNG 也有 731KB）。改为：
 *   1. `GET {api}/api/tiles` 取清单 `{ version, base, tiles: ['t00.webp', …],
 *      faces: { faceA: 'face/faceA.webp', … } }`；
 *   2. 按清单从 CDN 加载 34 张立牌 WebP（139×202）+ 4 张按座位平放牌图集（faceA..D）；
 *   3. `<image>` 直接使用地址，画布用 `canvasNode.createImage()` 预解码。
 *
 * **牌面大类两个子类**（2026-10-23 分类整理）：tiles 立牌（按牌值，所有座位共用）与
 * faces 平放牌（按座位朝向，faceA..D 各 9×4 格）——统一由本模块出口
 * （`art(t)` 立牌 / `faceArt(key, t)` 平放牌单格），调用方不感知 CDN 结构。
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
/** 平放牌图集位图：faceA..faceD → CanvasImage（副露/摊牌平放牌用） */
const faceImages = new Map();
let state = null; // { version, base, tiles: string[], faces?: Record<string,string> }
let status = 'idle'; // idle | loading | ready | failed
let listeners = [];
/**
 * 网络清单的进度（2026-10-22）：`status` 只表示「现在有没有可用清单」，
 * 有缓存时它立刻就是 ready，但网络请求可能还在路上。用这两个标志把「有缓存」
 * 和「网络已有结论」分开，否则「ready」会把后来注册的监听直接冲掉、
 * 网络清单回来时没人被通知（=新加的贴图键永远用不上）。
 */
let inflight = false;
let netSettled = false;

/**
 * 一次性日志（2026-10-20）：贴图失败以前是**完全静默**的 —— 真机上只表现为
 * 「牌面变成矢量大字」，看不出是域名没登记、清单空、还是服务端没发布素材。
 * 这里把原因打一条出来（同一条只打一次，不刷屏），并把 `debug()` 暴露给排查用。
 */
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

/**
 * 立刻回调、**不清空监听**：缓存清单先让界面秒开，网络清单回来还要再回一次
 * （新加的键只可能出现在网络清单里）。
 */
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
  // 网络已有结论：按当前状态回一次即可（failed 时调用方自己回退矢量）
  if (netSettled) {
    flush(status === 'ready');
    return;
  }
  // 请求在途：监听已挂上，等 success/fail 的终态回调（不要在这里提前 flush 掉）
  if (inflight) return;

  inflight = true;
  const cached = readCache();
  if (cached) {
    state = cached;
    status = 'ready';
    emit(true); // 先用缓存：换装瞬间不闪矢量牌面
  }

  const host = config.resolveApi();
  if (!host) {
    inflight = false;
    netSettled = true;
    log('warn', '[tiles] 未拿到 API 域名（config.resolveApi 为空）→ 牌面走矢量兜底；检查 utils/config.js 的 DEFAULT_WSS');
    if (status !== 'ready') status = 'failed';
    flush(status === 'ready');
    return;
  }

  wx.request({
    url: `${host}/api/tiles`,
    method: 'GET',
    timeout: 8000,
    success: (res) => {
      const o = res && res.data;
      if (!o || !Array.isArray(o.tiles) || o.tiles.length === 0) {
        log('warn', `[tiles] 清单为空（${host}/api/tiles 返回 0 项）→ 牌面走矢量兜底；先确认服务端 public/tiles 是否随版本一起发布`);
        inflight = false;
        netSettled = true;
        if (status !== 'ready') status = 'failed';
        flush(status === 'ready');
        return;
      }
      const next = {
        version: String(o.version || ''),
        // base 为空 = 与接口同源
        base: String(o.base || host).replace(/\/+$/, ''),
        tiles: o.tiles,
        // 按座位平放牌图集（老服务端没有 faces 字段 → 空对象，faceArt 走回退）
        faces: o.faces && typeof o.faces === 'object' ? o.faces : {},
      };
      if (cached && cached.version !== next.version) {
        images.clear(); // 换了美术 → 丢掉旧位图
        faceImages.clear();
      }
      /**
       * **无论版本号是否变化都采用网络清单**（2026-10-22 踩坑）：
       * 原来只在 `version !== cached.version` 时才 `state = next`，于是「版本号没抬、
       * 但清单加了新图」的情况下，客户端会一直吃缓存里那份旧清单 —— 牌面/贴图
       * 新加的键永远拿不到，表现是「改了素材，真机还是老样子」。
       * 版本号只是**缓存失效**的开关，不该兼职判断「清单是否可信」。
       */
      state = next;
      writeCache(next);
      status = 'ready';
      inflight = false;
      netSettled = true;
      log('info', `[tiles] ready ${next.version} · ${next.tiles.length} 张 · face ${Object.keys(next.faces).length} 张 · ${next.base}`);
      flush(true);
    },
    fail: (err) => {
      // 网络/域名问题：有缓存就继续用缓存，没有就只能矢量兜底
      log('warn', `[tiles] 清单请求失败（${host}/api/tiles，${(err && err.errMsg) || 'unknown'}）→ 牌面走矢量兜底；检查网络与 request 合法域名`);
      inflight = false;
      netSettled = true;
      if (status !== 'ready') status = 'failed';
      flush(status === 'ready');
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

/**
 * 按座位平放牌图集单格尺寸 [w,h]（2026-10-23 从 uiart.js 随 face 取用一起迁入）：
 * faceA 下家 46×64 · faceB 右家 59×48 · faceC 上家 42×60 · faceD 左家 59×48。
 * 副露/牌河按它算格子，保证与美术同宽高比，不被拉伸。
 */
const FACE_CELL = {
  faceA: [46, 64],
  faceB: [59, 48],
  faceC: [42, 60],
  faceD: [59, 48],
};
const FACE_COLS = 9;

/** 平放牌图集的 CDN 地址（`/tiles/face/faceX.webp`）；未就绪/无此键返回空串 */
function urlOfFace(key) {
  if (status !== 'ready' || !state || !state.faces) return '';
  const name = state.faces[key];
  if (!name) return '';
  return `${state.base}/tiles/${name}`;
}

/**
 * 平放牌图集里的单格：返回 `{ img, sx, sy, sw, sh }`（给 drawImage 的子矩形），
 * 图集未就绪/解码失败返回 null → 调用方回退竖版立牌。
 * `key` = faceA..faceD；`t` = 牌面索引 0..33。
 */
function faceArt(key, t) {
  const cell = FACE_CELL[key];
  if (!cell) return null;
  const img = faceImages.get(key);
  if (!img) return null;
  const [cw, ch] = cell;
  return { img, sx: (t % FACE_COLS) * cw, sy: Math.floor(t / FACE_COLS) * ch, sw: cw, sh: ch };
}

/** 预解码到 canvas（小程序 CanvasImage）：34 张立牌 + 4 张平放牌图集，全部完成/失败后回调一次 */
function preload(canvasNode, onDone) {
  if (status !== 'ready' || !canvasNode || typeof canvasNode.createImage !== 'function') {
    if (typeof onDone === 'function') onDone(false);
    return;
  }
  let pending = 0;
  const tick = () => {
    pending -= 1;
    if (pending <= 0 && typeof onDone === 'function') onDone(images.size + faceImages.size > 0);
  };
  const load = (url, set) => {
    pending += 1;
    const img = canvasNode.createImage();
    img.onload = () => {
      set(img);
      tick();
    };
    img.onerror = () => tick();
    img.src = url;
  };
  for (let t = 0; t < 34; t++) {
    if (images.has(t)) continue;
    const url = urlOf(t);
    if (!url) continue;
    load(url, (img) => images.set(t, img));
  }
  for (const key of Object.keys(FACE_CELL)) {
    if (faceImages.has(key)) continue;
    const url = urlOfFace(key);
    if (!url) continue;
    load(url, (img) => faceImages.set(key, img));
  }
  if (pending === 0 && typeof onDone === 'function') onDone(images.size + faceImages.size > 0);
}

module.exports = {
  ensure,
  urlOf,
  urlOfFace,
  art,
  faceArt,
  preload,
  ready() {
    return status === 'ready';
  },
  /** 排查用：在控制台执行 `require('../../utils/tileimg.js').debug()` 看贴图到底卡在哪一步 */
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
      count: state ? state.tiles.length : 0,
      faceCount: state && state.faces ? Object.keys(state.faces).length : 0,
      decoded: images.size,
      faceDecoded: faceImages.size,
    };
  },
};
