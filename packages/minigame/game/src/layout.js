/**
 * 布局量测（小程序端 SelectorQuery 量测体系的对位物）。
 *
 * 小程序端 game.js 的画布盒子是一套「setData → 等渲染 → SelectorQuery 实测」的闭环
 * （fitCanvas / measureCanvasBox / computeSafeInsets / syncRailTop / applyTableFrame），
 * 因为 WXML 的盒子尺寸由浏览器排版决定。小游戏端**只有一个全屏画布**，所有「盒子」
 * 都是纯数学 —— 量测即计算，不需要闭环收敛，也就没有「面板打开时量到 0」「陈旧帧」
 * 这类问题。常量与口径逐项照搬 pages/game/game.js：
 *   · 画布 2:1 定尺：w = max(240, min(game-main 宽 − RAIL_RESERVE, 行高×2))；
 *   · 画布在 game-main 里横向居中、纵向贴底（flex-end 语义）；
 *   · 顶栏 28px 自绘；操作带 34px 浮于底部、与画布同宽对齐；
 *   · 侧轨预留 RAIL_RESERVE = (36+6)×2 = 84px，绝不压画布矩形。
 */

/** 自绘顶栏高度（px，同 game.wxss 的 .g-top / game.js 的 TOPBAR_H） */
const TOPBAR_H = 28;
/** 侧轨按钮宽 / 间隙 / 双侧预留（同 game.js 的 RAIL_W / RAIL_GAP / RAIL_RESERVE） */
const RAIL_W = 36;
const RAIL_GAP = 6;
const RAIL_RESERVE = (RAIL_W + RAIL_GAP) * 2;
/** 轨与胶囊的最小间隙 / 拿不到胶囊时的兜底轨顶（同 game.js） */
const RAIL_GAP_CAP = 6;
const RAIL_TOP_FALLBACK = 16;
/** 自定义导航栏右侧胶囊估宽（小程序端 CAPSULE_W，仅 chrome 布局参考） */
const CAPSULE_W = 118;
/** 操作带高度（px）：2026-11-02 由 34 收到 24（艺术钮同比缩，给画布让纵向） */
const ACTION_BAR_GAME = 24;
/** 操作带宽度预算（同 game.js 的 handMetrics：14 张排满 679px，与画布同宽取大、被行宽截断） */
const HAND_TILES = 14;
const HAND_TILE_W = 46;
const HAND_TILE_GAP = 2;
const HAND_DRAWN_EXTRA = 7;
const HAND_NEED = HAND_TILES * (HAND_TILE_W + HAND_TILE_GAP) + HAND_DRAWN_EXTRA;

let cached = null;

function windowInfo() {
  try {
    if (typeof wx !== 'undefined' && wx.getWindowInfo) return wx.getWindowInfo();
  } catch (e) {
    /* 落到 getSystemInfoSync */
  }
  return wx.getSystemInfoSync();
}

/**
 * 微信胶囊（⋯ ○）屏幕矩形。小游戏没有文档保证的胶囊 API：特性检测，
 * 拿不到就返回 null（顶栏布局按 CAPSULE_W 估宽留白；table.capsuleRect 置 null →
 * 右上铭牌贴角，table.js 本就处理 null）。
 */
function capsuleRect() {
  try {
    if (typeof wx !== 'undefined' && wx.getMenuButtonBoundingClientRect) {
      const r = wx.getMenuButtonBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) return r;
    }
  } catch (e) {
    /* 忽略 */
  }
  return null;
}

/** 安全区内缩（px）：小游戏没有 env(safe-area-inset-*) 探针节点，直接用窗口信息换算。 */
function safeInsets(win) {
  const sa = win && win.safeArea;
  const w = win.windowWidth || win.screenWidth || 0;
  const h = win.windowHeight || win.screenHeight || 0;
  if (!sa || !(sa.width > 0)) return { l: 0, r: 0, t: 0, b: 0 };
  return {
    l: Math.max(0, Math.round(sa.left)),
    r: Math.max(0, Math.round(w - sa.right)),
    t: Math.max(0, Math.round(sa.top)),
    b: Math.max(0, Math.round(h - sa.bottom)),
  };
}

/**
 * 计算一帧布局（纯函数，结果缓存；窗口尺寸变化时 layoutDirty() 后重算）。
 *
 * 全部矩形都是**屏幕坐标**（px，原点 = 屏幕左上角，与 wx.onTouch* 的 clientX/Y 同系），
 * 触摸路由与绘制共用这一份坐标，不存在小程序端「页面坐标 / 局部坐标」的换算。
 */
function compute() {
  if (cached) return cached;
  const win = windowInfo();
  const sw = win.windowWidth || win.screenWidth || 0;
  const sh = win.windowHeight || win.screenHeight || 0;
  const dpr = Math.min(2, Math.max(1, win.pixelRatio || 1));
  const safe = safeInsets(win);

  // #game-main 对位物：顶栏以下的整行（顶栏 28px，同 navigationStyle:custom）
  const main = { x: 0, y: TOPBAR_H, w: sw, h: Math.max(0, sh - TOPBAR_H) };

  // fitCanvas 对位物：2:1 定尺，宽度扣侧轨预留；横向居中、纵向贴底
  const tw = Math.max(240, Math.floor(Math.min(Math.max(240, main.w - RAIL_RESERVE), main.h * 2)));
  const th = Math.round(tw / 2);
  const table = { x: main.x + (main.w - tw) / 2, y: main.y + main.h - th, w: tw, h: th };

  // 操作带（handMetrics 对位物）：与画布同宽取大、被行宽截断，浮于 game-main 底部
  const trayW = Math.max(0, Math.min(main.w, Math.max(tw, HAND_NEED)));
  const actionBar = { x: main.x + (main.w - trayW) / 2, y: main.y + main.h - ACTION_BAR_GAME, w: trayW, h: ACTION_BAR_GAME };

  // 侧轨：railTop = 胶囊下沿 + 6（对位 syncRailTop；拿不到胶囊退 safe.t + 16）
  const cap = capsuleRect();
  const railTop = cap && cap.bottom > 0
    ? Math.max(RAIL_GAP_CAP, Math.round(cap.bottom + RAIL_GAP_CAP))
    : Math.max(RAIL_GAP_CAP, safe.t + RAIL_TOP_FALLBACK);
  const railL = { x: safe.l + RAIL_GAP, y: railTop, w: RAIL_W, h: main.h - railTop };
  const railR = { x: sw - safe.r - RAIL_GAP - RAIL_W, y: railTop, w: RAIL_W, h: main.h - railTop };

  // 整屏桌面矩形（对位 .game 根节点 / pageBox：全屏画布下就是整块屏幕）
  const page = { x: 0, y: 0, w: sw, h: sh };

  cached = { win, sw, sh, dpr, safe, cap, main, table, actionBar, trayW, railTop, railL, railR, page, topbar: { x: 0, y: 0, w: sw, h: TOPBAR_H } };
  return cached;
}

/** 窗口尺寸 / 旋转变了（wx.onWindowResize 回调里调用）：下一帧重算。 */
function dirty() {
  cached = null;
}

function inRect(r, x, y) {
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/**
 * 屏幕坐标 → 牌桌画布逻辑坐标（1280×640）。
 * 与小程序端 onCanvasTap 同一换算：触摸点 − 画布 rect → ×1280/宽。
 * L 缺省用通用布局；对局场景应传 layout.game() 的结果（操作带会改变画布矩形）。
 * 不在画布内返回 null。
 */
function toTableLogical(x, y, L) {
  const lay = L || compute();
  if (!inRect(lay.table, x, y)) return null;
  return {
    x: ((x - lay.table.x) * 1280) / lay.table.w,
    y: ((y - lay.table.y) * 640) / lay.table.h,
  };
}

/**
 * 对局场景布局（2026-11-02「给牌留空间」重排）：
 *   .game（padding 3/8 + 安全区）→ banner? → **画布从 topbar 之下直接吃到底**
 *   → .board-overlay（!overPhase 时恒高 24px 操作带）。
 *
 * 相对旧版的两个增量（用户报「牌太小」，每省 1px 高 = 画布宽 +2px）：
 *   · **顶栏并入画布背景层**：chrome.render 画在桌面贴图之上（横幅同），不再占
 *     流内高度 —— 顶栏仍然可见可点（chrome 的命中先于牌桌），纵向净赚 25px；
 *   · **操作带 34 → 24px**（按钮艺术图 34×29 → 24×21 同比缩，compact 20×17）。
 * 逻辑常量同步放大见 utils/table.js 2026-11-02 段（RIVER 52×68 / 手牌 88×124）。
 */
function game(opts) {
  const o = opts || {};
  const L = compute();
  const padT = L.safe.t + 3;
  const padB = 3;
  const padL = L.safe.l + 8;
  const padR = L.safe.r + 8;
  let y = padT;
  let bannerRect = null;
  if (o.banner) {
    bannerRect = { x: padL, y, w: L.sw - padL - padR, h: 19 };
    y += 19 + 4;
  }
  // 顶栏仍在**屏幕坐标**里（chrome 画它 / 命中它），只是不再从流内高度里扣
  const topbar = { x: padL, y, w: L.sw - padL - padR, h: 24 };
  const over = !!o.overPhase;
  const gmY = y;
  const gmW = L.sw - padL - padR;
  const gmH = Math.max(0, L.sh - padB - y);
  // 2:1 定尺（操作栏已浮入画布内，不再扣纵向）。
  const tw = Math.max(240, Math.floor(Math.min(Math.max(240, gmW), gmH * 2)));
  const th = Math.round(tw / 2);
  const table = { x: padL + (gmW - tw) / 2, y: gmY + gmH - th, w: tw, h: th };
  // 操作栏：浮在画布内、手牌上方，**屏幕原生 34px 高**（2026-11-03：逻辑缩放版
  // 按钮太小，用户报）。x/y/宽全部走**中心带**（逻辑 465..1025 —— 左右手牌区之外的
  // 自由带），宽 560*sc 屏 px；按钮由 chrome 按屏幕原生尺寸排布（bar 内居中），
  // 844~1204 全尺寸放得下 7 钮（294 屏 px ≤ 321~505）。
  const sc = th / 640;
  const barW = 560 * sc;
  const actionBar = over
    ? null
    : {
        x: table.x + 465 * sc,
        y: table.y + 512 * sc - 34 - 4,
        w: barW,
        h: 34,
      };
  // 侧轨：顶 = 胶囊下沿 + 6；按钮浮在画布两侧的桌面上（x 贴屏幕边）
  const cap = capsuleRect();
  const railTop = cap && cap.bottom > 0 ? Math.max(2, Math.round(cap.bottom + RAIL_GAP_CAP)) : Math.max(2, L.safe.t + RAIL_TOP_FALLBACK);
  const railBandH = Math.max(0, gmY + gmH - 2 - railTop);
  const railL = { x: L.safe.l + 2, y: railTop, w: RAIL_W - 8, h: railBandH };
  const railR = { x: L.sw - L.safe.r - 2 - (RAIL_W - 8), y: railTop, w: RAIL_W - 8, h: railBandH };
  return Object.assign({}, L, {
    padL,
    padR,
    padT,
    padB,
    bannerRect,
    topbar,
    gameMain: { x: padL, y: gmY, w: gmW, h: gmH },
    table,
    actionBar,
    railTop,
    railL,
    railR,
    over,
    cap,
  });
}

/**
 * 整屏桌面矩形换算成画布逻辑坐标，交给 Table 铺背景（对位 game.js applyTableFrame）。
 * 矩形比画布大是常态，负坐标合法（drawImage 会自己裁）。
 * ⚠ 对局场景必须传 layout.game() 的结果 —— 它的画布矩形与通用 compute() 不同
 * （顶栏高度 / 横幅 / 操作带），传错会让牌桌内的桌面贴图与整屏那层错位
 * （表现为「画里画」的双层背景）。L 缺省才用通用布局。
 */
function tableFrame(L) {
  const lay = L || compute();
  const s = lay.table.w / 1280; // 屏幕px / 逻辑
  return {
    x: (lay.page.x - lay.table.x) / s,
    y: (lay.page.y - lay.table.y) / s,
    w: lay.page.w / s,
    h: lay.page.h / s,
  };
}

module.exports = {
  TOPBAR_H,
  RAIL_W,
  RAIL_GAP,
  RAIL_RESERVE,
  RAIL_GAP_CAP,
  RAIL_TOP_FALLBACK,
  CAPSULE_W,
  ACTION_BAR_GAME,
  HAND_NEED,
  compute,
  game,
  dirty,
  inRect,
  toTableLogical,
  tableFrame,
  capsuleRect,
};
