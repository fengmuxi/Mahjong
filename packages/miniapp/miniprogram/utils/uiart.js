/**
 * UI 贴图 CDN 资源（2026-10-21 起，与 utils/tileimg.js 同套路）。
 *
 * 牌面之外的位图（牌背 / 碰杠过胡钮 / 结算艺术字 / 庄标 / 大数字）同样不进代码包：
 *   1. `GET {api}/api/ui` 取清单 `{ version, base, images: { back:'back.webp', … } }`；
 *   2. 按清单从 CDN 加载（`urlOf(key)` 给 DOM `<image>` 用，`preload` 给 canvas 预解码）；
 *   3. 任何一步失败都只回退各绘制点的原有矢量/文字方案，不会白板。
 *
 * 清单缓存 7 天 + 后台校验版本：断网也能用上次的清单，换美术抬 `MAHJONG_UI_VER` 即失效。
 * 键名约定（服务端 /api/ui 与 scripts/gen_ui_cdn.mjs 同款，5 组）：
 *   hand：back 牌背 · back_op 暗杠扣牌 · inhand_l/inhand_r 上下家手牌侧影 ·
 *   operate：chi/peng/gang/hu/guo 操作钮 · settle：win/lost/draw 结算艺术字 ·
 *   hud：banker 庄标 · d0..d9 数字 · table 桌面背景 · bg：bg-cloud/bg-lattice
 * （faceA..faceD 平放牌图集 2026-10-23 移往牌面大类：/api/tiles 的 faces 子清单，
 *   入口统一到 utils/tileimg.js 的 faceArt()，本模块不再管牌面位图。）
 */
const config = require('./config.js');

const CACHE_KEY = 'mj-ui-art';
/** 已解码的画布位图：key → CanvasImage（canvas 绘制用；DOM 直接吃地址） */
const images = new Map();
let state = null; // { version, base, images: Record<string,string> }
let status = 'idle'; // idle | loading | ready | failed
let listeners = [];
/** 网络清单的进度，语义同 tileimg.js：`status` 只表示「有没有可用清单」 */
let inflight = false;
let netSettled = false;

/** 一次性日志：同 tileimg.js 的口径，失败原因只打一条，不刷屏 */
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
    return o && o.images && Object.keys(o.images).length ? o : null;
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

/** 取清单。有缓存就先用缓存回调一次（UI 立刻换上），同时后台校验版本。 */
function ensure(cb) {
  if (typeof cb === 'function') listeners.push(cb);
  // 网络已有结论：按当前状态回一次（failed 时调用方各自回退矢量）
  if (netSettled) {
    flush(status === 'ready');
    return;
  }
  // 请求在途：监听已挂上，等终态回调（别在这里提前 flush 掉）
  if (inflight) return;

  inflight = true;
  const cached = readCache();
  if (cached) {
    state = cached;
    status = 'ready';
    emit(true); // 先用缓存：桌面图/贴图不闪
  }

  const host = config.resolveApi();
  if (!host) {
    inflight = false;
    netSettled = true;
    log('warn', '[ui-art] 未拿到 API 域名（config.resolveApi 为空）→ UI 走矢量/文字兜底；检查 utils/config.js 的 DEFAULT_WSS');
    if (status !== 'ready') status = 'failed';
    flush(status === 'ready');
    return;
  }

  wx.request({
    url: `${host}/api/ui`,
    method: 'GET',
    timeout: 8000,
    success: (res) => {
      const o = res && res.data;
      if (!o || !o.images || Object.keys(o.images).length === 0) {
        log('warn', `[ui-art] 清单为空（${host}/api/ui 返回 0 项）→ UI 走矢量/文字兜底；先确认服务端 public/ui 是否随版本一起发布`);
        inflight = false;
        netSettled = true;
        if (status !== 'ready') status = 'failed';
        flush(status === 'ready');
        return;
      }
      const next = {
        version: String(o.version || ''),
        base: String(o.base || host).replace(/\/+$/, ''),
        images: o.images,
      };
      if (cached && cached.version !== next.version) images.clear(); // 换了美术 → 丢掉旧位图
      /**
       * **无论版本号是否变化都采用网络清单**（2026-10-22 踩坑，与 tileimg.js 同因）：
       * 原来只在版本号变化时才 `state = next`。而 UI 清单从 19 项扩到 24 项（加了
       * table）时**没有抬 `MAHJONG_UI_VER`**，于是老客户端一直吃缓存里
       * 那份 19 项清单：`urlOf('table')` 恒为空 → 整屏桌面层没图、画布退回藏青矢量桌、
       * 平放牌退回立牌 —— 用户看到的就是「改了但真机还是老样子」。
       * 版本号只是缓存失效开关，不兼职判断清单是否可信。
       */
      state = next;
      writeCache(next);
      status = 'ready';
      inflight = false;
      netSettled = true;
      log('info', `[ui-art] ready ${next.version} · ${Object.keys(next.images).length} 项 · ${next.base}`);
      flush(true);
    },
    fail: (err) => {
      log('warn', `[ui-art] 清单请求失败（${host}/api/ui，${(err && err.errMsg) || 'unknown'}）→ UI 走矢量/文字兜底；检查网络与 request 合法域名`);
      inflight = false;
      netSettled = true;
      if (status !== 'ready') status = 'failed';
      flush(status === 'ready');
    },
  });
}

/** 该键的 CDN 地址；未就绪/无此键返回空串 —— 调用方据此回退 */
function urlOf(key) {
  if (status !== 'ready' || !state) return '';
  const name = state.images[key];
  if (!name) return '';
  return `${state.base}/ui/${name}`;
}

/** 画布用的已解码位图；没有返回 null → 各绘制点回退矢量 */
function art(key) {
  return images.get(key) || null;
}

/** 预解码到 canvas（小程序 CanvasImage），全部完成/失败后回调一次 */
function preload(canvasNode, keys, onDone) {
  if (status !== 'ready' || !canvasNode || typeof canvasNode.createImage !== 'function') {
    if (typeof onDone === 'function') onDone(false);
    return;
  }
  const list = Array.isArray(keys) ? keys : Object.keys(state.images);
  let pending = 0;
  const tick = () => {
    pending -= 1;
    if (pending <= 0 && typeof onDone === 'function') onDone(images.size > 0);
  };
  for (const key of list) {
    if (images.has(key)) continue;
    const url = urlOf(key);
    if (!url) continue;
    pending += 1;
    const img = canvasNode.createImage();
    img.onload = () => {
      images.set(key, img);
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
  /** 排查用：控制台执行 `require('../../utils/uiart.js').debug()` 看卡在哪一步 */
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
      count: state ? Object.keys(state.images).length : 0,
      decoded: images.size,
    };
  },
};
