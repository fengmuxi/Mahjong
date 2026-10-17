/**
 * 牌桌渲染（`packages/client/src/table.ts` 的小程序移植版）。
 *
 * 移植原则：**绘制与几何逻辑逐行保持不变**，只替换平台相关的三个入口 ——
 *   1. 取上下文：web 用 `canvas.getContext('2d')`，小程序用 canvas 2d 节点的
 *      `canvasNode.getContext('2d')`（节点由页面 wx.createSelectorQuery 取到）；
 *   2. 计时：web 用 `performance.now()`，小程序统一 `Date.now()`；
 *   3. 排帧：web 用全局 `requestAnimationFrame`，小程序优先用 canvas 节点的同名方法。
 * 牌面**优先用 CDN 位图（`utils/tileimg.js`），取不到就矢量绘制**：官方体检要求图片资源
 * 合计 ≤ 200KB、主包 < 1.5MB，34 张牌面塞不进代码包；矢量兜底保证 CDN/域名没配好时也能玩。
 *
 * 逻辑坐标恒为 1280×640（与 web 端一致），backing store 按 pixelRatio（上限 2x）重建，
 * 每帧 `setTransform` 映射；命中判定由页面把触摸点换算成逻辑坐标后调用 `hitTest()`。
 * 规则相关的取位（牌墙 slotPos / 精牌描边 / 风位 seatWind）全部走 shared 产物，不做二次实现。
 *
 * 2026-10-17：**画布内不再常驻自己的手牌带**（原本 52×70 逻辑 → 屏上仅 20×27，比画布下方
 * DOM 手牌条小一半且点不准）。出牌统一走 DOM 手牌条；画布只在摊牌（reveal）时展示一次
 * 自己的明牌，见 `drawRevealHand()`。
 *
 * 2026-10-18：**对手手牌背整条删除** —— 四条边原来画的是各家手牌背（22~32 逻辑宽），
 * 牌河被挤在环内只剩 24×32，真机上单张 9×12 完全看不清。现在四条边全部给牌河（46×58），
 * 副露挪进环内四侧（40×52），手牌张数改由铭牌上的「手牌 N」显示（`drawTag()`）。
 */

const { tileName, seatWind, suitOf, rankOf } = require('../lib/shared/tiles.js');
const { RING_SLOTS, SEG_LEN, SEG_START } = require('../lib/shared/wall.js');
/** 牌面走 CDN（代码包零图片，见 utils/tileimg.js）；未就绪/失败一律回退矢量 */
const tileimg = require('./tileimg.js');

const W = 1280;
const H = 640;
/**
 * 牌张尺寸（2026-10-18 布局重排）。
 *
 * 改动前：对手手牌带占了四条边（每条 22~32 逻辑宽），牌河被挤在环内只剩 24×32 ——
 * 画布逻辑 1280 宽在真机上约 500 CSS px，牌河单张落到屏上只有 9×12，字和花色根本认不出。
 * 现在：
 *   · **删掉对手手牌带**（手牌张数改在铭牌上显示），四条边全部让给牌河；
 *   · 牌河 24×32 → **46×58**，屏上约 18×23（原来的 1.9 倍）；
 *   · 副露 32×42 → **40×52**，并从环外挪进环内四侧（环外给了牌河）。
 * 牌河每侧容量：上下 13×2=26，左右 5×8=40 —— 足够一局的最大弃牌数。
 */
const RIVER_W = 46;
const RIVER_H = 58;
const RIVER_DX = 48;
const RIVER_DY = 60;
const MELD_W = 40;
const MELD_H = 52;
const WALL_PITCH = 30;
const WALL_LAYER = 7;
const WALL_ACROSS = 26;
const WALL_ALONG = 22;
const WALL_BOTTOM_Y = 473;
const WALL_TOP_Y = 122;
const WALL_LEFT_X = 284;
const WALL_RIGHT_X = 974;
const WALL_V_LIMIT = 540;
const GHOST_MS = 420;
const BUBBLE_W_NARROW = 138;
const BUBBLE_W_WIDE = 230;
const BUBBLE_LINE_H = 15;
const BUBBLE_MAX_LINES = 3;
const BUBBLE_MS = 4200;
const BUBBLE_FADE = 420;
const EMOTE_MS = 1250;
const EMOTE_FLY = 0.38;
/** 小程序无 "Microsoft YaHei"，统一用系统默认族（iOS/Android 各自回退到中文字体） */
const FONT = 'sans-serif';
const EMOJI_FONT = 'sans-serif';

const SUIT_CHAR = { m: '万', s: '条', p: '筒' };
const SUIT_COLOR = { m: '#c62828', s: '#1b7f3b', p: '#1f5fbf' };

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function font(px, bold) {
  return `${bold ? 'bold ' : ''}${px}px ${FONT}`;
}

class Table {
  constructor(canvasNode, pixelRatio) {
    const ctx = canvasNode.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 上下文');
    this.canvas = canvasNode;
    this.ctx = ctx;
    this.pixelRatio = Math.min(2, Math.max(1, pixelRatio || 1));
    this.view = null;
    this.lastRendered = null;
    this.rafQueued = false;
    /** 摊牌时各家明牌占的矩形（index = 屏幕槽位，供中奖高亮用）；对局中是全 null */
    this.revealRects = [null, null, null, null];
    this.dealing = false;
    this.effCounts = [0, 0, 0, 0];
    this.dealAnim = null;
    this.prevRemoved = null;
    this.ghosts = [];
    this.diceReveal = null;
    this.rollBtn = null;
    this.rollClicked = false;
    this.dpr = 1;
    this.onDiscard = () => {};
    this.onRollDice = () => {};
    this.onTagClick = () => {};
    this.tagRects = [null, null, null, null];
    this.bubbles = [];
    this.emoteFx = [];
    this.actionFx = null;
    this.lastActionSeq = 0;
    this.applyBackingStore();
  }

  /**
   * 按设备像素比重建 backing store —— 解决手机上牌面贴图被放大后发虚的问题。
   * 逻辑坐标系恒为 1280×640：绘制代码一行不改，每帧开头用 setTransform 映射。
   */
  applyBackingStore() {
    const dpr = this.pixelRatio;
    const w = Math.round(W * dpr);
    const h = Math.round(H * dpr);
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.lastRendered) this.render(this.lastRendered);
  }

  /**
   * 命中判定（页面把触摸点换算成画布逻辑坐标后调用）。
   * 2026-10-17 起**只剩掷骰按钮与四角铭牌**：画布内手牌带已移除（见文件头说明），
   * 出牌统一走画布下方的 DOM 手牌条（42~46px 宽，是画布内牌面的 2 倍以上）。
   */
  hitTest(x, y) {
    if (!this.view) return;
    const rb = this.rollBtn;
    if (rb && x >= rb.x && x <= rb.x + rb.w && y >= rb.y && y <= rb.y + rb.h) {
      if (!this.rollClicked) {
        this.rollClicked = true;
        this.onRollDice();
      }
      return;
    }
    for (let slot = 0; slot < 4; slot++) {
      const tg = this.tagRects[slot];
      if (tg && x >= tg.x && x <= tg.x + tg.w && y >= tg.y && y <= tg.y + tg.h) {
        this.onTagClick((this.view.mySeat + slot) % 4);
        return;
      }
    }
  }

  render(view) {
    this.view = view;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lastRendered = view;
    if (view.ceremony && view.ceremony.state !== 'wait-roll') this.rollClicked = false;
    this.rollBtn = null;

    if (view.lastAction && view.lastAction.seq !== this.lastActionSeq) {
      this.lastActionSeq = view.lastAction.seq;
      const k = view.lastAction.kind;
      if (k === 'chi' || k === 'peng' || k === 'gang' || k === 'angang' || k === 'bugang' || k === 'hu') {
        this.actionFx = { kind: k, seat: view.lastAction.seat, t0: Date.now() };
      }
    }

    const deal = this.dealProgress(view);
    this.dealing = deal !== null;
    const effCounts = view.counts.slice();
    if (deal) {
      effCounts.fill(0);
      const steps = (view.wallRing && view.wallRing.recipe.steps) || [];
      for (let i = 0; i < Math.min(deal.done, steps.length); i++) {
        effCounts[steps[i].seat] += steps[i].slots.length;
      }
    }
    this.effCounts = effCounts;
    this.revealRects = [null, null, null, null];

    const over = view.phase === 'over';
    this.drawTable();
    this.drawWall(view, deal);
    // 对局中四条边是牌河；摊牌/流局时同一个位置改画各家明牌（否则两者会叠在一起）。
    // 对局中**不画任何手牌**（含对手）—— 手牌张数在铭牌上，牌面信息全部让给牌河。
    if (!over) this.drawRivers(view);
    this.drawCenter(view, deal);
    for (let s = 0; s < 4; s++) {
      const slot = this.disp(view, s);
      if (over) this.drawRevealHand(view, s);
      this.drawMelds(view.melds[s], slot);
      this.drawTag(view, s);
    }
    if (view.lastDiscard) this.drawLastMarker(view);
    this.drawJingHighlight(view);
    if (view.phase === 'over') {
      this.drawWinnerHighlight(view);
      this.drawResultBanner(view);
    }
    this.drawEmoteFx();
    this.drawBubbles();
    this.drawActionFx();
    if (
      view.phase === 'playing' ||
      this.emoteFx.length > 0 ||
      this.bubbles.length > 0 ||
      this.actionFx !== null
    ) {
      this.scheduleFrame();
    }
  }

  dealProgress(view) {
    const c = view.ceremony;
    if (!c || c.kind !== 'deal' || view.phase !== 'playing') return null;
    if (c.state === 'wait-roll') return { done: 0 };
    if (c.rollAt === null || c.until === null) return { done: 0 };
    if (!this.dealAnim || this.dealAnim.key !== c.rollAt) {
      this.dealAnim = { key: c.rollAt, start: Date.now(), dur: Math.max(300, c.until - c.rollAt) };
    }
    const a = this.dealAnim;
    const elapsed = Date.now() - a.start;
    if (elapsed >= a.dur) return null;
    const steps = (view.wallRing && view.wallRing.recipe.steps.length) || 0;
    const tumble = Math.min(2200, Math.floor(a.dur * 0.5));
    const end = a.dur * 0.94;
    const t = Math.min(1, Math.max(0, (elapsed - tumble) / Math.max(1, end - tumble)));
    return { done: Math.min(steps, Math.floor(t * steps + 1e-9)) };
  }

  // ---------- 绘制 ----------

  disp(view, seat) {
    return (((seat - view.mySeat) % 4) + 4) % 4;
  }

  wind(seat) {
    return seatWind(seat, this.view ? this.view.dealer : 0);
  }

  drawTable() {
    const ctx = this.ctx;
    ctx.fillStyle = '#14241c';
    ctx.fillRect(0, 0, W, H);
    roundRect(ctx, 8, 8, W - 16, H - 16, 18);
    ctx.fillStyle = '#1d4030';
    ctx.fill();
    ctx.strokeStyle = '#2a5a44';
    ctx.lineWidth = 2;
    ctx.stroke();
    roundRect(ctx, 18, 18, W - 36, H - 36, 14);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  segPitch(seg) {
    if (seg.screen === 0 || seg.screen === 2 || seg.cols <= 1) return WALL_PITCH;
    const fit = Math.floor((2 * WALL_V_LIMIT - H - WALL_ALONG) / (seg.cols - 1));
    return Math.max(WALL_ALONG, Math.min(WALL_PITCH, fit));
  }

  segSpan(seg) {
    return (seg.cols - 1) * this.segPitch(seg) + WALL_ALONG;
  }

  wallSegs(view) {
    const dealerDisp = this.disp(view, view.dealer);
    const segs = [];
    for (let r = 0; r < 4; r++) {
      const seg = { r, screen: (dealerDisp + r) % 4, cols: SEG_LEN[r], x0: 0, y0: 0 };
      const span = this.segSpan(seg);
      if (seg.screen === 0 || seg.screen === 2) seg.x0 = (W - span) / 2;
      else seg.y0 = (H - span) / 2;
      segs.push(seg);
    }
    return segs;
  }

  segOfCol(col) {
    for (let s = 0; s < 4; s++) {
      if (col >= SEG_START[s] && col < SEG_START[s] + SEG_LEN[s]) return s;
    }
    return 0;
  }

  slotPos(seg, col, layer) {
    const i = col - SEG_START[seg.r];
    const span = this.segSpan(seg);
    const pitch = this.segPitch(seg);
    const off = layer * WALL_LAYER;
    switch (seg.screen) {
      case 0:
        return { x: seg.x0 + span - WALL_ALONG - i * pitch, y: WALL_BOTTOM_Y - off, w: WALL_ALONG, h: WALL_ACROSS };
      case 2:
        return { x: seg.x0 + i * pitch, y: WALL_TOP_Y + off, w: WALL_ALONG, h: WALL_ACROSS };
      case 3:
        return { x: WALL_LEFT_X + off, y: seg.y0 + span - WALL_ALONG - i * pitch, w: WALL_ACROSS, h: WALL_ALONG };
      default:
        return { x: WALL_RIGHT_X - off, y: seg.y0 + i * pitch, w: WALL_ACROSS, h: WALL_ALONG };
    }
  }

  computeRemoved(view, stepsDone) {
    const removed = new Array(RING_SLOTS).fill(false);
    const rr = view.wallRing;
    if (!rr) return removed;
    if (stepsDone !== null) {
      for (let s = 0; s < Math.min(stepsDone, rr.recipe.steps.length); s++) {
        const slots = rr.recipe.steps[s].slots;
        for (const slot of slots) removed[slot] = true;
      }
      return removed;
    }
    for (const step of rr.recipe.steps) {
      for (const slot of step.slots) removed[slot] = true;
    }
    let guard = 0;
    let s = rr.recipe.endSlot;
    while (s !== rr.frontSlot && guard++ < RING_SLOTS) {
      removed[s] = true;
      s = (s + 1) % RING_SLOTS;
    }
    for (const slot of rr.kongSlots) removed[slot] = true;
    return removed;
  }

  seatAnchor(view, seat) {
    const screen = this.disp(view, seat);
    if (screen === 0) return { x: W / 2, y: 604 };
    if (screen === 1) return { x: 1204, y: 320 };
    if (screen === 2) return { x: W / 2, y: 60 };
    return { x: 76, y: 320 };
  }

  drawWall(view, deal) {
    const rr = view.wallRing;
    if (!rr) return;
    const ctx = this.ctx;
    const removed = this.computeRemoved(view, deal ? deal.done : null);

    if (this.prevRemoved !== null) {
      const steps = rr.recipe.steps;
      for (let slot = 0; slot < RING_SLOTS; slot++) {
        if (!removed[slot] || this.prevRemoved[slot]) continue;
        let seat = view.turn;
        if (deal) {
          for (let i = 0; i < Math.min(deal.done, steps.length); i++) {
            if (steps[i].slots.indexOf(slot) >= 0) {
              seat = steps[i].seat;
              break;
            }
          }
        } else if (rr.kongSlots.indexOf(slot) >= 0 && view.ceremony && view.ceremony.kind === 'gang') {
          seat = view.ceremony.seat;
        }
        let seg = null;
        const segs = this.wallSegs(view);
        for (const s of segs) {
          if (s.r === this.segOfCol(slot >> 1)) {
            seg = s;
            break;
          }
        }
        if (!seg) continue;
        const p = this.slotPos(seg, slot >> 1, slot & 1);
        const a = this.seatAnchor(view, seat);
        this.ghosts.push({ x0: p.x + p.w / 2, y0: p.y + p.h / 2, x1: a.x, y1: a.y, t0: Date.now() });
      }
    }
    this.prevRemoved = removed;

    const segs = this.wallSegs(view);
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    for (const seg of segs) {
      const span = this.segSpan(seg);
      if (seg.screen === 0) roundRect(ctx, seg.x0 - 6, 463, span + 12, 40, 7);
      else if (seg.screen === 2) roundRect(ctx, seg.x0 - 6, 119, span + 12, 40, 7);
      else if (seg.screen === 3) roundRect(ctx, 281, seg.y0 - 6, 40, span + 12, 7);
      else roundRect(ctx, 964, seg.y0 - 6, 40, span + 12, 7);
      ctx.fill();
    }

    const jingFaceSlot = this.jingWallSlot(view);
    for (const seg of segs) {
      for (let i = 0; i < seg.cols; i++) {
        const col = SEG_START[seg.r] + i;
        for (let layer = 0; layer < 2; layer++) {
          const slot = col * 2 + layer;
          if (removed[slot]) continue;
          const p = this.slotPos(seg, col, layer);
          const face = slot === jingFaceSlot ? view.jingPi : -1;
          this.drawTile(face, p.x, p.y, p.w, p.h, view);
        }
      }
    }

    if (view.ceremony && view.ceremony.kind === 'deal') {
      const col = rr.recipe.startCol;
      let seg = null;
      for (const s of segs) {
        if (s.r === this.segOfCol(col)) {
          seg = s;
          break;
        }
      }
      if (seg) {
        const p0 = this.slotPos(seg, col, 0);
        const p1 = this.slotPos(seg, col, 1);
        const x = Math.min(p0.x, p1.x) - 4;
        const y = Math.min(p0.y, p1.y) - 4;
        const w = Math.max(p0.x + p0.w, p1.x + p1.w) - x + 4;
        const h = Math.max(p0.y + p0.h, p1.y + p1.h) - y + 4;
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 240);
        ctx.strokeStyle = `rgba(230,193,75,${0.35 + 0.6 * pulse})`;
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, w, h, 5);
        ctx.stroke();
      }
    }

    const now = Date.now();
    this.ghosts = this.ghosts.filter((g) => now - g.t0 < GHOST_MS);
    for (const g of this.ghosts) {
      const k = Math.min(1, (now - g.t0) / GHOST_MS);
      const e = 1 - (1 - k) * (1 - k);
      const x = g.x0 + (g.x1 - g.x0) * e;
      const y = g.y0 + (g.y1 - g.y0) * e - Math.sin(Math.PI * k) * 34;
      ctx.globalAlpha = 1 - k * k;
      this.drawTile(-1, x - 9, y - 12, 18, 24, view);
      ctx.globalAlpha = 1;
    }
  }

  /**
   * 四方牌河的落位。**牌河占四条边**（这里原来是各家手牌背，2026-10-18 已删除 ——
   * 手牌张数改由铭牌上的「手牌 N」承担，见 `drawTag()`）：
   *   seat 2 对家 → 顶边：13 列 × 2 行（y 0..118，紧贴牌墙上方 119 的底衬）
   *   seat 0 自己 → 底边：13 列 × 2 行（y 506..624，牌墙底衬 503 之下）
   *   seat 3 上家 → 左边：5 列 × 8 行（x 20..258；竖向先往下排，满一列换下一列）
   *   seat 1 下家 → 右边：同左，镜像（x 1022..1260）
   * 左右两侧只用 8 行、y 到 548，避开四角铭牌（顶 16..66 / 底 574..624）；
   * 横向两条只占中间 13 列（x 328..950），同样不压铭牌。
   * 牌张 46×58（原 24×32，翻倍），行距 60 / 列距 48 —— 2px 缝，够区分又不散。
   */
  riverOrigin(seat) {
    if (seat === 2) return { x: 328, y: 0, cols: 13, rows: 2, vertical: false };
    if (seat === 0) return { x: 328, y: 506, cols: 13, rows: 2, vertical: false };
    if (seat === 3) return { x: 20, y: 70, cols: 5, rows: 8, vertical: true };
    return { x: 1022, y: 70, cols: 5, rows: 8, vertical: true };
  }

  /** 第 i 张弃牌的位置（横向按行铺、纵向按列铺） */
  riverPos(seat, i) {
    const o = this.riverOrigin(seat);
    const per = o.vertical ? o.rows : o.cols;
    const col = o.vertical ? Math.floor(i / per) : i % per;
    const row = o.vertical ? i % per : Math.floor(i / per);
    return { x: o.x + col * RIVER_DX, y: o.y + row * RIVER_DY, w: RIVER_W, h: RIVER_H };
  }

  drawRivers(view) {
    for (let s = 0; s < 4; s++) {
      const slot = this.disp(view, s);
      const river = view.rivers[s] || [];
      river.forEach((tile, i) => {
        const p = this.riverPos(slot, i);
        this.drawTile(tile, p.x, p.y, p.w, p.h, view);
      });
    }
  }

  drawLastMarker(view) {
    const last = view.lastDiscard;
    if (!last) return;
    const river = view.rivers[last.from] || [];
    const i = river.length - 1;
    if (i < 0 || river[i] !== last.tile) return;
    const p = this.riverPos(this.disp(view, last.from), i);
    const ctx = this.ctx;
    ctx.strokeStyle = '#e6c14b';
    ctx.lineWidth = 2;
    roundRect(ctx, p.x - 2, p.y - 2, p.w + 4, p.h + 4, 4);
    ctx.stroke();
    // 弃的是明面精 → 精描边（正精橙 / 副精紫）要在金框**之上**：drawTile 里的精描边先画、
    // 已被上面的金框盖住，这里补画一次（金框垫底、精框在上），两圈都可见（2026-10-18）。
    const gz = view.gz;
    const isPi = gz ? last.tile === gz.zheng[0] : last.tile === view.jingPi;
    const isFu = gz ? last.tile === gz.fu[0] : last.tile === view.jingFu;
    if (isPi || isFu) {
      this.jingBorder(p.x, p.y, p.w, p.h, Math.max(2, Math.floor(p.w * 0.14)), isPi);
    }
  }

  drawCenter(view, deal) {
    const ctx = this.ctx;
    // 中心信息盘（2026-10-18 放大：220×140 → 288×140，字号 / 骰子 / 精牌同步放大；
    // 高度不动 —— 上有对家副露（y≤212）、下有自己副露（y≥400），只向两侧扩：
    // 左副露最宽到 x490、右副露最窄从 x795 起，288 宽正好嵌在中间不重叠）。
    const px = 496;
    const py = 256;
    const pw = 288;
    const ph = 140;
    roundRect(ctx, px, py, pw, ph, 12);
    ctx.fillStyle = 'rgba(0,0,0,0.34)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.stroke();

    let wallLeft = view.wallLeft;
    if (deal !== null) {
      const removed = this.computeRemoved(view, deal.done);
      let n = 0;
      for (const r of removed) if (r) n += 1;
      wallLeft = RING_SLOTS - n;
    }
    ctx.fillStyle = '#9db5a8';
    ctx.font = font(14);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`牌墙 ${wallLeft}`, px + 14, py + 17);

    const winds = [
      { seat: view.mySeat, x: px + 144, y: py + 125 },
      { seat: (view.mySeat + 1) % 4, x: px + 272, y: py + 70 },
      { seat: (view.mySeat + 2) % 4, x: px + 144, y: py + 18 },
      { seat: (view.mySeat + 3) % 4, x: px + 24, y: py + 70 },
    ];
    ctx.textAlign = 'center';
    for (const w of winds) {
      const isDealer = w.seat === view.dealer;
      if (isDealer) {
        roundRect(ctx, w.x - 17, w.y - 13, 34, 26, 7);
        ctx.fillStyle = '#e6c14b';
        ctx.fill();
        ctx.fillStyle = '#22200f';
        ctx.font = font(18, true);
      } else {
        ctx.fillStyle = '#b9cfc2';
        ctx.font = font(17);
      }
      ctx.fillText(this.wind(w.seat), w.x, w.y + 1);
    }

    let shown = null;
    const c = view.ceremony;
    if (c && c.state === 'rolling' && c.dice) {
      shown = this.revealed(view) ? c.dice : null;
    } else if (!(c && c.state === 'wait-roll' && c.kind === 'deal')) {
      shown = view.lastDice || view.dealDice;
    }
    this.drawDieFace(px + 54, py + 40, 44, shown ? shown[0] : null);
    this.drawDieFace(px + 104, py + 40, 44, shown ? shown[1] : null);

    if (view.gz) {
      const gzVis = view.gz.zheng.length > 0 && !(view.ceremony && view.ceremony.kind === 'jing' && !this.revealed(view));
      if (gzVis) {
        const hasFu = view.gz.fu.length > 0;
        this.drawTile(view.gz.zheng[0], px + 160, py + 36, 46, 58, view);
        if (hasFu) this.drawTile(view.gz.fu[0], px + 212, py + 36, 46, 58, view);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = font(12);
        ctx.fillStyle = '#e0a86a';
        ctx.fillText('正精', px + 183, py + 112);
        if (hasFu) {
          ctx.fillStyle = '#b48ae0';
          ctx.fillText('副精', px + 235, py + 112);
        }
        if (!view.gz.revealed) {
          ctx.font = font(11);
          ctx.fillStyle = '#9db5a8';
          ctx.fillText('其余 10 张结算揭晓', px + 104, py + 112);
        }
      }
    } else {
      const jingOk =
        view.jingPi !== null &&
        view.jingFu !== null &&
        !(view.ceremony && view.ceremony.kind === 'jing' && !this.revealed(view));
      if (jingOk) {
        this.drawTile(view.jingPi, px + 160, py + 36, 46, 58, view);
        this.drawTile(view.jingFu, px + 212, py + 36, 46, 58, view);
      }
    }

    if (c && c.state === 'wait-roll' && !this.rollClicked) {
      const label = c.kind === 'deal' ? '掷骰开局' : c.kind === 'jing' ? '掷骰翻精' : '掷骰补牌';
      const mine = view.mySeat === c.seat;
      const bx = px + 49;
      const by = py + 38;
      const bw = 190;
      const bh = 60;
      roundRect(ctx, bx, by, bw, bh, 12);
      ctx.fillStyle = mine ? '#e6c14b' : 'rgba(28,44,36,0.94)';
      ctx.fill();
      ctx.strokeStyle = mine ? '#f6e3a1' : '#4d675a';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (mine) {
        ctx.fillStyle = '#22200f';
        ctx.font = font(22, true);
        ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1);
      } else {
        ctx.fillStyle = '#9db5a8';
        ctx.font = font(15);
        ctx.fillText(`等待${this.wind(c.seat)}家${label}…`, bx + bw / 2, by + bh / 2 + 1);
      }
      if (mine) this.rollBtn = { x: bx, y: by, w: bw, h: bh };
    }
  }

  revealed(view) {
    const c = view.ceremony;
    if (!c || c.state !== 'rolling' || c.rollAt === null || c.until === null) return true;
    const dur = Math.max(400, c.until - c.rollAt);
    const tumble = Math.min(c.kind === 'gang' ? 1500 : 2200, Math.floor(dur * 0.5));
    if (!this.diceReveal || this.diceReveal.key !== c.rollAt) {
      this.diceReveal = { key: c.rollAt, start: Date.now(), tumble };
    }
    return Date.now() - this.diceReveal.start >= this.diceReveal.tumble;
  }

  jingWallSlot(view) {
    if (view.jingSlot === null || view.jingPi === null) return -1;
    if (view.ceremony && view.ceremony.kind === 'jing' && !this.revealed(view)) return -1;
    return view.jingSlot;
  }

  drawJingHighlight(view) {
    const slot = this.jingWallSlot(view);
    if (slot < 0 || !view.wallRing || view.jingPi === null) return;
    let seg = null;
    const segs = this.wallSegs(view);
    for (const s of segs) {
      if (s.r === this.segOfCol(slot >> 1)) {
        seg = s;
        break;
      }
    }
    if (!seg) return;
    const p = this.slotPos(seg, slot >> 1, slot & 1);
    const jw = WALL_ACROSS;
    const jh = 38;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    const rot = seg.screen === 3 ? Math.PI / 2 : seg.screen === 1 ? -Math.PI / 2 : 0;
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.55)';
    ctx.shadowBlur = 7;
    ctx.shadowOffsetY = 4;
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    this.drawTile(view.jingPi, -jw / 2, -jh / 2, jw, jh, view, true);
    ctx.restore();
  }

  drawDieFace(x, y, size, value) {
    const ctx = this.ctx;
    const r = Math.max(4, Math.floor(size * 0.16));
    roundRect(ctx, x, y, size, size, r);
    ctx.fillStyle = '#f7f3e8';
    ctx.fill();
    ctx.strokeStyle = '#b7b09c';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    roundRect(ctx, x + 1, y + size - Math.max(3, size * 0.12), size - 2, Math.max(3, size * 0.12), r - 1);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (value === null) {
      ctx.fillStyle = '#8d8776';
      ctx.font = font(Math.floor(size * 0.5), true);
      ctx.fillText('?', x + size / 2, y + size / 2 + 1);
      return;
    }
    const PIP = {
      1: [4],
      2: [0, 8],
      3: [0, 4, 8],
      4: [0, 2, 6, 8],
      5: [0, 2, 4, 6, 8],
      6: [0, 2, 3, 5, 6, 8],
    };
    const cells = PIP[value] || [];
    const cs = size / 3;
    const pr = Math.max(3, size * 0.1);
    const red = value === 1 || value === 4;
    for (let i = 0; i < 9; i++) {
      if (cells.indexOf(i) < 0) continue;
      const cx = x + (i % 3) * cs + cs / 2;
      const cy = y + Math.floor(i / 3) * cs + cs / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, pr, 0, Math.PI * 2);
      ctx.fillStyle = red ? '#c62828' : '#1c1c2b';
      ctx.fill();
    }
  }

  /**
   * 摊牌时各家明牌的落位（与 riverOrigin 同一套四边；摊牌时牌河不画，整条边都空着）。
   *   自己/对家：顶/底边各 13 列 × 2 行（14 张刚好两行）
   *   上家/下家：左右边各 2 列 × 7 行（13~14 张）
   * 牌张尺寸与牌河一致（RIVER_W/H），摊牌时看得最清楚。
   */
  revealOrigin(slot) {
    if (slot === 2) return { x: 328, y: 0, cols: 13, rows: 2, vertical: false };
    if (slot === 0) return { x: 328, y: 506, cols: 13, rows: 2, vertical: false };
    if (slot === 3) return { x: 20, y: 70, cols: 2, rows: 7, vertical: true };
    return { x: 1166, y: 70, cols: 2, rows: 7, vertical: true };
  }

  drawRevealHand(view, seat) {
    const slot = this.disp(view, seat);
    // 流局（phase=over 但 reveal=null）时自己那手牌仍要从 myTiles 画出来
    const tiles = (view.reveal && view.reveal[seat]) || (slot === 0 ? view.myTiles || [] : []);
    if (tiles.length === 0) return;
    const z = this.revealOrigin(slot);
    const per = z.vertical ? z.rows : z.cols;
    tiles.forEach((t, i) => {
      const col = z.vertical ? Math.floor(i / per) : i % per;
      const row = z.vertical ? i % per : Math.floor(i / per);
      this.drawTile(t, z.x + col * RIVER_DX, z.y + row * RIVER_DY, RIVER_W, RIVER_H, view);
    });
    const cols = z.vertical ? Math.ceil(tiles.length / z.rows) : Math.min(tiles.length, z.cols);
    const rows = z.vertical ? Math.min(tiles.length, z.rows) : Math.ceil(tiles.length / z.cols);
    this.revealRects[slot] = {
      // 顶边的明牌从 y=0 起，外扩 5px 会变成负数（赢家高亮被画布上沿切掉）→ 夹到 0
      x: Math.max(0, z.x - 5),
      y: Math.max(0, z.y - 5),
      w: cols * RIVER_DX - (RIVER_DX - RIVER_W) + 10,
      h: rows * RIVER_DY - (RIVER_DY - RIVER_H) + 10,
    };
  }

  meldWidth(m) {
    return m.tiles.length * MELD_W;
  }

  /**
   * 副露（吃/碰/杠）落位（2026-10-18 重排）：牌河搬到四条边之后，环内四侧空出来了，
   * 副露就画在这里，紧挨各自玩家的牌河。
   *   seat 0 自己 → 环内下沿（y 400，右对齐到 950；牌墙底衬从 503 起，留 51 余量）
   *   seat 2 对家 → 环内上沿（y 160，右对齐到 950；牌墙顶衬到 159 为止，结算横幅在 214）
   *   seat 3 上家 → 环内左侧竖排（x 330；左侧牌墙到 281 为止）
   *   seat 1 下家 → 环内右侧竖排（右对齐到 955；右侧牌墙从 964 起）
   * 赣州「报杠展示三张」（`view.declared`）是冻结但可见的牌，原来画在手牌带里，
   * 手牌带删除后接到副露块的末端（横排接左边、竖排接上边），带金框区分。
   */
  drawMelds(melds, seat) {
    const list = melds || [];
    const decl = (this.view && this.view.declared ? this.view.declared : [])
      .filter((d) => d.seat === seat)
      .map((d) => d.tile);
    if (list.length === 0 && decl.length === 0) return;
    const gap = 12;

    if (seat === 0 || seat === 2) {
      // 横排：右对齐到 950，展示牌接在最左边
      let total = gap * Math.max(0, list.length - 1);
      for (const m of list) total += this.meldWidth(m);
      if (decl.length > 0) total += decl.length * MELD_W + gap;
      let x = Math.max(292, 950 - total);
      const y = seat === 0 ? 400 : 160;
      if (decl.length > 0) {
        this.drawDeclared(decl, x, y);
        x += decl.length * MELD_W + gap;
      }
      for (const m of list) {
        x = this.drawMeldRow(m, x, y);
        x += gap;
      }
      return;
    }

    // 左右两家：竖排。起点 216 是刻意的 —— 对家的横排副露在 160~212，这里从它下面开始，
    // 两家同时在 4 组副露也不会叠（最多铺到 436，只有「左右 4 组 + 自己 3 组」这种
    // 极端情况才会在环内下沿擦到 44px，代价可接受）。
    let y = 216;
    if (decl.length > 0) {
      this.drawDeclared(decl, seat === 3 ? 330 : 955 - decl.length * MELD_W, y);
      y += MELD_H + 4;
    }
    for (const m of list) {
      const w = this.meldWidth(m);
      this.drawMeldRow(m, seat === 3 ? 330 : 955 - w, y);
      y += MELD_H + 4;
    }
  }

  /** 赣州「报杠展示三张」：冻结不能打、但必须看得见 → 金框摆在副露块末端 */
  drawDeclared(tiles, x, y) {
    const ctx = this.ctx;
    for (const t of tiles) {
      this.drawTile(t, x, y, MELD_W, MELD_H, this.view);
      ctx.strokeStyle = '#e6c14b';
      ctx.lineWidth = 2;
      roundRect(ctx, x - 1, y - 1, MELD_W + 2, MELD_H + 2, 4);
      ctx.stroke();
      x += MELD_W;
    }
  }

  drawMeldRow(m, x, y) {
    const self = this;
    m.tiles.forEach((t, i) => {
      const down = m.type === 'angang' && (i === 1 || i === 2);
      self.drawTile(down ? -1 : t, x + i * MELD_W, y, MELD_W, MELD_H, self.view);
    });
    return x + m.tiles.length * MELD_W;
  }

  /**
   * 四角铭牌（2026-10-18 重排 168×50 → 同日再放大 220×54，用户「铭牌字号过小」）。
   *
   * 第一行：`庄` + `风位·昵称·我`（左）/ 累计总分（右）。
   * 第二行：**「手牌 N」**（左，带底衬的胶囊）/ 状态（右：胡牌！/ 托管中 / 出牌中）。
   *
   * 为什么张数要写进铭牌：画布里的对手手牌背已经整条删掉（四条边全部让给牌河），
   * 「还剩几张」必须另有出口。文案固定为「手牌 N」而不是光秃秃的「N 张」——
   * 牌河现在占四条边，只写张数会被读成弃牌数。数值取 `view.counts`
   * （服务端 `hands.map(h => h.length)`，摸牌 +1、出牌 -1、碰/杠 -n），每帧跟着状态走。
   *
   * 几何预算：高 54（INSET 14 → 占 y14..68 / y572..626），左右牌河从 y70 起 / 到 y548 止，
   * 上下牌河从 x328 起 —— 四角都不压牌；宽 220 也只伸到 x234 / x1046，同样让开牌河。
   */
  drawTag(view, seat) {
    const ctx = this.ctx;
    const slot = this.disp(view, seat);
    const TAG_W = 220;
    const TAG_H = 54;
    const INSET = 14;
    const pos = {
      0: [INSET, H - INSET - TAG_H],
      1: [W - INSET - TAG_W, H - INSET - TAG_H],
      2: [W - INSET - TAG_W, INSET],
      3: [INSET, INSET],
    };
    const xy = pos[slot];
    const x = xy[0];
    const y = xy[1];
    const w = TAG_W;
    const h = TAG_H;
    this.tagRects[slot] = { x, y, w, h };
    const isTurn = view.phase === 'playing' && view.turn === seat;
    const isWinner = view.phase === 'over' && view.winner === seat;
    const me = seat === view.mySeat;
    const dealer = seat === view.dealer;
    const offline = view.connected !== undefined && !view.connected[seat];
    const autoPlay = view.auto !== undefined ? view.auto[seat] === true : offline;

    roundRect(ctx, x, y, w, h, 8);
    ctx.fillStyle = isWinner ? 'rgba(230,193,75,0.3)' : 'rgba(0,0,0,0.4)';
    ctx.fill();
    // 当前出牌方：边框呼吸。原来靠 `drawTurnCursor()` 在「对手手牌带」外面画一圈光标，
    // 手牌带删掉后那圈框会浮在牌河上，已整体删除 —— 回合提示改由铭牌承担。
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 280);
    ctx.strokeStyle = isWinner
      ? '#f6e3a1'
      : isTurn
        ? `rgba(230,193,75,${0.55 + 0.45 * pulse})`
        : me
          ? 'rgba(230,193,75,0.45)'
          : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = isWinner ? 3 : isTurn ? 3 : 1;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // ---- 第一行：庄标 + 风位·昵称（左）/ 总分（右）----
    let tx = x + 12;
    if (dealer) {
      roundRect(ctx, x + 10, y + 8, 24, 20, 5);
      ctx.fillStyle = '#e6c14b';
      ctx.fill();
      ctx.fillStyle = '#22200f';
      ctx.font = font(13, true);
      ctx.textAlign = 'center';
      ctx.fillText('庄', x + 22, y + 18);
      ctx.textAlign = 'left';
      tx = x + 40;
    }

    const tv = (view.totals && view.totals[seat]) || 0;
    const scoreText = tv > 0 ? `+${tv}` : `${tv}`;
    ctx.font = font(13, true);
    const scoreW = ctx.measureText(scoreText).width;

    const rawName = (view.names && view.names[seat]) || this.wind(seat);
    ctx.font = font(13);
    let label = `${this.wind(seat)}·${rawName}${me ? '·我' : ''}`;
    // 昵称可能很长：按「分数左侧的剩余宽度」逐步截断，宁可省略也不压到分数
    const room = x + w - 10 - scoreW - 10 - tx;
    while (label.length > 2 && ctx.measureText(label).width > room) {
      label = `${label.slice(0, -2)}…`;
    }
    ctx.fillStyle = isWinner ? '#ffe9a8' : isTurn ? '#e6c14b' : '#e8efe9';
    ctx.fillText(label, tx, y + 18);

    ctx.textAlign = 'right';
    ctx.fillStyle = tv > 0 ? '#43c07c' : tv < 0 ? '#e07a6a' : '#9db5a8';
    ctx.fillText(scoreText, x + w - 10, y + 18);

    // ---- 第二行左：剩余手牌数量（胶囊底衬，避免与牌河混读）----
    const n = this.effCounts[seat] || 0;
    ctx.font = font(12);
    const lblW = ctx.measureText('手牌').width;
    ctx.font = font(16, true);
    const numW = ctx.measureText(String(n)).width;
    const chipW = lblW + numW + 16;
    roundRect(ctx, tx - 4, y + 29, chipW, 22, 6);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(230,193,75,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = font(12);
    ctx.fillStyle = '#9db5a8';
    ctx.fillText('手牌', tx + 4, y + 40);
    ctx.font = font(16, true);
    ctx.fillStyle = '#f2f7f3';
    ctx.fillText(String(n), tx + 4 + lblW + 5, y + 40);

    // ---- 第二行右：状态 ----
    ctx.textAlign = 'right';
    if (isWinner) {
      ctx.font = font(14, true);
      ctx.fillStyle = '#ffe9a8';
      ctx.fillText('胡牌！', x + w - 10, y + 40);
    } else if (autoPlay) {
      ctx.font = font(13);
      ctx.fillStyle = '#e0a06a';
      ctx.fillText('托管中', x + w - 10, y + 40);
    } else if (isTurn) {
      ctx.font = font(13);
      ctx.fillStyle = '#e6c14b';
      ctx.fillText('出牌中', x + w - 10, y + 40);
    }
  }

  // ---------- 互动表情与铭牌气泡 ----------

  pushBubble(seat, content, kind) {
    const text = String(content || '').trim();
    if (!text || seat < 0 || seat > 3) return;
    this.bubbles = this.bubbles.filter((b) => b.seat !== seat);
    this.bubbles.push({ seat, content: text, kind, t0: Date.now() });
    this.scheduleFrame();
  }

  pushEmote(from, target, icon) {
    if (!icon) return;
    this.emoteFx.push({ from, target, icon, t0: Date.now() });
    this.scheduleFrame();
  }

  wrapText(text, maxW, maxLines) {
    const ctx = this.ctx;
    const chars = Array.from(text);
    const lines = [];
    let cur = '';
    let i = 0;
    for (; i < chars.length; i++) {
      const ch = chars[i];
      if (cur && ctx.measureText(cur + ch).width > maxW) {
        lines.push(cur);
        cur = '';
        if (lines.length === maxLines) break;
      }
      cur += ch;
    }
    let truncated = i < chars.length;
    if (lines.length < maxLines) {
      if (cur) lines.push(cur);
    } else if (cur) {
      truncated = true;
    }
    if (truncated && lines.length > 0) {
      let s = lines[lines.length - 1];
      while (s && ctx.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
      lines[lines.length - 1] = `${s}…`;
    }
    return lines;
  }

  drawBubbles() {
    const view = this.view;
    const now = Date.now();
    this.bubbles = this.bubbles.filter((b) => now - b.t0 < BUBBLE_MS);
    if (!view || this.bubbles.length === 0) return;
    const ctx = this.ctx;
    for (const b of this.bubbles) {
      const slot = this.disp(view, b.seat);
      const tag = this.tagRects[slot];
      if (!tag) continue;
      const wide = slot === 2 || slot === 3;
      const maxW = wide ? BUBBLE_W_WIDE : BUBBLE_W_NARROW;
      const emote = b.kind === 'emote';
      ctx.font = font(emote ? 14 : 12, emote);
      const lines = this.wrapText(b.content, maxW - 18, BUBBLE_MAX_LINES);
      if (lines.length === 0) continue;
      let textW = 0;
      for (const l of lines) textW = Math.max(textW, ctx.measureText(l).width);
      const w = Math.min(maxW, Math.ceil(textW) + 18);
      const h = lines.length * BUBBLE_LINE_H + 12;
      const leftSide = slot === 0 || slot === 3;
      const up = slot === 0 || slot === 1;
      let x = leftSide ? tag.x : tag.x + tag.w - w;
      let y = up ? tag.y - 8 - h : tag.y + tag.h + 8;
      x = Math.max(8, Math.min(W - 8 - w, x));
      y = Math.max(8, Math.min(H - 8 - h, y));
      const age = now - b.t0;
      ctx.globalAlpha = Math.max(0, Math.min(1, age / 160, (BUBBLE_MS - age) / BUBBLE_FADE));
      const bg = emote ? 'rgba(48,34,10,0.94)' : 'rgba(16,26,21,0.92)';
      roundRect(ctx, x, y, w, h, 8);
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.strokeStyle = emote ? '#e6c14b' : 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      const tailX = leftSide ? tag.x + 20 : tag.x + tag.w - 20;
      ctx.beginPath();
      ctx.moveTo(tailX - 6, up ? y + h : y);
      ctx.lineTo(tailX + 6, up ? y + h : y);
      ctx.lineTo(tailX, up ? y + h + 7 : y - 7);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = emote ? '#ffe9a8' : '#e8efe9';
      lines.forEach((l, i) => ctx.fillText(l, x + 9, y + 6 + BUBBLE_LINE_H * i + BUBBLE_LINE_H / 2));
      ctx.globalAlpha = 1;
    }
  }

  drawActionFx() {
    const fx = this.actionFx;
    if (!fx) return;
    const now = Date.now();
    const age = now - fx.t0;
    const DUR = 1200;
    if (age >= DUR) {
      this.actionFx = null;
      return;
    }
    const ctx = this.ctx;
    const t = age / DUR;
    const alpha = t < 0.15 ? t / 0.15 : t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
    const scale = t < 0.2 ? 0.5 + 0.65 * (t / 0.2) : 1.15 - 0.15 * ((t - 0.2) / 0.8);
    const conf = {
      chi: { label: '吃', color: '#81c784', bg: 'rgba(76,175,80,0.25)' },
      peng: { label: '碰', color: '#64b5f6', bg: 'rgba(33,150,243,0.25)' },
      gang: { label: '杠', color: '#ffb74d', bg: 'rgba(255,152,0,0.25)' },
      angang: { label: '暗杠', color: '#ffb74d', bg: 'rgba(255,152,0,0.25)' },
      bugang: { label: '补杠', color: '#ffb74d', bg: 'rgba(255,152,0,0.25)' },
      hu: { label: '胡', color: '#ef9a9a', bg: 'rgba(229,72,77,0.3)' },
    };
    const c = conf[fx.kind] || { label: fx.kind, color: '#fff', bg: 'rgba(0,0,0,0.3)' };
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(640, 300);
    ctx.scale(scale, scale);
    const w = 120;
    const h = 70;
    roundRect(ctx, -w / 2, -h / 2, w, h, 14);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();
    ctx.strokeStyle = c.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = c.color;
    ctx.font = font(42, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.label, 0, 2);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  drawEmoteFx() {
    const view = this.view;
    const now = Date.now();
    this.emoteFx = this.emoteFx.filter((f) => now - f.t0 < EMOTE_MS);
    if (!view || this.emoteFx.length === 0) return;
    const ctx = this.ctx;
    for (const f of this.emoteFx) {
      const a = this.tagRects[this.disp(view, f.from)];
      const b = this.tagRects[this.disp(view, f.target)];
      if (!a || !b) continue;
      const ax = a.x + a.w / 2;
      const ay = a.y + a.h / 2;
      const bx = b.x + b.w / 2;
      const by = b.y + b.h / 2;
      const k = Math.min(1, (now - f.t0) / EMOTE_MS);
      if (k < EMOTE_FLY) {
        const p = k / EMOTE_FLY;
        const e = p * p * (3 - 2 * p);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(ax + (bx - ax) * e, ay + (by - ay) * e - Math.sin(Math.PI * p) * 44);
        ctx.rotate(p * Math.PI * 1.6);
        ctx.font = `34px ${EMOJI_FONT}`;
        ctx.fillText(f.icon, 0, 0);
        ctx.restore();
      } else {
        const p = (k - EMOTE_FLY) / (1 - EMOTE_FLY);
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.translate(bx, by);
        const sc = 1.6 - 0.45 * Math.min(1, p / 0.4);
        ctx.scale(sc, sc);
        ctx.font = `34px ${EMOJI_FONT}`;
        ctx.globalAlpha = Math.max(0, 1 - Math.max(0, (p - 0.5) / 0.5));
        ctx.fillText(f.icon, 0, 0);
        ctx.globalAlpha = Math.max(0, 0.5 * (1 - p));
        ctx.strokeStyle = '#e6c14b';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, 8 + p * 40, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        const flash = Math.max(0, 1 - p / 0.55);
        if (flash > 0) {
          ctx.globalAlpha = flash * 0.9;
          ctx.strokeStyle = '#f6e3a1';
          ctx.lineWidth = 3;
          roundRect(ctx, b.x - 3, b.y - 3, b.w + 6, b.h + 6, 10);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  /**
   * 赢家高亮框 = 该家明牌的整体外框。`drawRevealHand()` 每帧都会把
   * 「这家明牌占了哪块矩形」写进 `revealRects[slot]`，这里直接取，不再另算一套坐标
   * （曾经两处各算一次，牌张尺寸一改就错位）。
   */
  winnerRect(view) {
    const seat = view.winner;
    if (seat === null || view.phase !== 'over') return null;
    return this.revealRects[this.disp(view, seat)] || null;
  }

  drawWinnerHighlight(view) {
    const rect = this.winnerRect(view);
    if (!rect) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = 'rgba(230,193,75,0.95)';
    ctx.shadowBlur = 16;
    ctx.strokeStyle = '#f6e3a1';
    ctx.lineWidth = 3.5;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 10);
    ctx.stroke();
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 结算横幅：**挂在环内上沿、中心盘正上方**（y 214~254）。
   * 原来画在画布最顶端（y 4~48）——对手手牌背删掉后那里是「对家摊牌」的第一行，
   * 横幅刚好压住 9 张明牌（截图实测）。挪到环内后：对家副露在 160~212、中心盘从 256 起，
   * 左右两侧竖排副露止于 x 450 / 始于 x 835，横幅 470~810 全部避开。
   */
  drawResultBanner(view) {
    const seat = view.winner;
    if (seat === null || view.phase !== 'over') return;
    const name = (view.names && view.names[seat]) || this.wind(seat);
    let main = `${this.wind(seat)}·${name} 胡`;
    const sub = view.result || '';
    const ctx = this.ctx;
    const bw = 340;
    const bh = 40;
    const bx = (W - bw) / 2;
    const by = 214;
    ctx.font = font(16, true);
    while (main.length > 2 && ctx.measureText(main).width > bw - 24) {
      main = `${main.slice(0, -2)}…`;
    }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    roundRect(ctx, bx, by, bw, bh, 12);
    ctx.fillStyle = 'rgba(230,193,75,0.96)';
    ctx.fill();
    ctx.restore();
    ctx.strokeStyle = '#f6e3a1';
    ctx.lineWidth = 2;
    roundRect(ctx, bx, by, bw, bh, 12);
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#22200f';
    ctx.font = font(16, true);
    ctx.fillText(main, W / 2, by + 14);
    if (sub) {
      ctx.fillStyle = 'rgba(34,32,15,0.78)';
      ctx.font = font(11);
      let s = sub;
      while (s.length > 2 && ctx.measureText(s).width > bw - 20) s = `${s.slice(0, -2)}…`;
      ctx.fillText(s, W / 2, by + 30);
    }
  }

  scheduleFrame() {
    if (this.rafQueued) return;
    this.rafQueued = true;
    const raf = this.canvas && typeof this.canvas.requestAnimationFrame === 'function'
      ? this.canvas.requestAnimationFrame.bind(this.canvas)
      : (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 32));
    raf(() => {
      this.rafQueued = false;
      if (this.lastRendered) this.render(this.lastRendered);
    });
  }

  jingBorder(x, y, w, h, r, isPi) {
    const ctx = this.ctx;
    ctx.save();
    ctx.shadowColor = isPi ? 'rgba(255,87,34,0.9)' : 'rgba(171,71,188,0.9)';
    ctx.shadowBlur = 8;
    ctx.strokeStyle = isPi ? '#ff5722' : '#ab47bc';
    ctx.lineWidth = 3;
    roundRect(ctx, x, y, w, h, r);
    ctx.stroke();
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 画一张牌：**优先用 CDN 位图**，取不到则纯矢量兜底。
   *
   * 为什么位图不在代码包里：官方代码包体检两条硬指标 —— 主包 < 1.5MB、**图片资源合计 ≤ 200KB**，
   * 34 张牌面无论怎么压都过不了（139×202 WebP 也要 251KB，早期 93×135 PNG 更是 731KB）。
   * 现在走 `utils/tileimg.js`：后端 `/api/tiles` 给清单、CDN 给图；**清单没取到 / 单张解码失败，
   * 就落到下面的矢量分支**，表现只是「牌面抽象一点」，不会白板也不会卡住。
   * 矢量分支的另一个好处：牌河单张只有 9~13 CSS px，矢量文字比缩小的写实贴图更好认。
   */
  drawTile(t, x, y, w, h, view, noGlow) {
    const ctx = this.ctx;
    const r = Math.max(2, Math.floor(w * 0.14));
    if (t < 0) {
      // 牌背
      roundRect(ctx, x, y, w, h, r);
      ctx.fillStyle = '#4f97e6';
      ctx.fill();
      ctx.strokeStyle = '#13325f';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      roundRect(ctx, x + 2, y + 2, w - 4, h - 4, Math.max(2, r - 1));
      ctx.strokeStyle = 'rgba(255,255,255,0.38)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      roundRect(ctx, x + 2, y + 2, Math.max(2, w - 4), Math.max(2, (h - 4) * 0.35), Math.max(2, r - 2));
      ctx.fill();
      return;
    }

    const isPi = view.jingPi === t || ((view.gz && view.gz.zheng.indexOf(t) >= 0) || false);
    const isFu = view.jingFu === t || ((view.gz && view.gz.fu.indexOf(t) >= 0) || false);

    // CDN 位图优先（`tileimg` 已按清单预解码）；没有就用下面的矢量牌面
    const art = tileimg.art(t);
    if (art) {
      ctx.save();
      roundRect(ctx, x, y, w, h, r);
      ctx.clip();
      const sw = art.width;
      const sh = art.height;
      let sx = 0;
      let sy = 0;
      let cw = sw;
      let ch = sh;
      if (sw / sh < w / h) {
        ch = Math.max(1, Math.round((sw * h) / w));
        sy = Math.round((sh - ch) / 2);
      } else {
        cw = Math.max(1, Math.round((sh * w) / h));
        sx = Math.round((sw - cw) / 2);
      }
      ctx.drawImage(art, sx, sy, cw, ch, x, y, w, h);
      ctx.restore();
      if ((isPi || isFu) && !noGlow) this.jingBorder(x, y, w, h, r, isPi);
      return;
    }

    // 牌面：米白底 + 底部立体边
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = '#f8f5ec';
    ctx.fill();
    const bevel = Math.max(2, Math.round(h * 0.1));
    ctx.fillStyle = '#e3dcc8';
    ctx.fillRect(x + 1, y + h - bevel, w - 2, bevel - 1);
    if (isPi || isFu) {
      this.jingBorder(x, y, w, h, r, isPi);
    } else {
      roundRect(ctx, x, y, w, h, r);
      ctx.strokeStyle = '#c9c2b0';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = x + w / 2;
    if (t < 27) {
      const suit = suitOf(t);
      // 万：数字用墨色、萬字用红色；条全绿、筒全蓝 —— 与真实牌面同色系，小尺寸下靠颜色分辨
      const numColor = suit === 'm' ? '#1a1a2e' : SUIT_COLOR[suit];
      const suitColor = suit === 'm' ? '#c62828' : SUIT_COLOR[suit];
      ctx.fillStyle = numColor;
      ctx.font = font(Math.max(7, Math.round(h * 0.42)), true);
      ctx.fillText(String(rankOf(t)), cx, y + h * 0.34);
      ctx.fillStyle = suitColor;
      ctx.font = font(Math.max(6, Math.round(h * 0.3)), true);
      ctx.fillText(SUIT_CHAR[suit], cx, y + h * 0.7);
      return;
    }
    if (t === 33) {
      // 白板：蓝框（真实牌面就是空框）
      const bw = w * 0.54;
      const bh = h * 0.56;
      ctx.strokeStyle = '#1f5fbf';
      ctx.lineWidth = Math.max(1.5, w * 0.06);
      ctx.strokeRect(cx - bw / 2, y + h / 2 - bh / 2, bw, bh);
      ctx.strokeStyle = 'rgba(31,95,191,0.38)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - bw / 2 + 3, y + h / 2 - bh / 2 + 3, bw - 6, bh - 6);
      return;
    }
    ctx.fillStyle = t === 31 ? '#c62828' : t === 32 ? '#1b7f3b' : '#1a1a2e';
    ctx.font = font(Math.max(8, Math.round(h * 0.52)), true);
    ctx.fillText(tileName(t), cx, y + h / 2 + 1);
  }
}

module.exports = { Table, W, H };
