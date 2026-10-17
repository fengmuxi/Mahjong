/**
 * 牌桌渲染（`packages/client/src/table.ts` 的小程序移植版）。
 *
 * 移植原则：**绘制与几何逻辑逐行保持不变**，只替换平台相关的四个入口 ——
 *   1. 取上下文：web 用 `canvas.getContext('2d')`，小程序用 canvas 2d 节点的
 *      `canvasNode.getContext('2d')`（节点由页面 wx.createSelectorQuery 取到）；
 *   2. 取图：web 用 `new Image()`，小程序用 `canvasNode.createImage()`（见 utils/tiles.js）；
 *   3. 计时：web 用 `performance.now()`，小程序统一 `Date.now()`；
 *   4. 排帧：web 用全局 `requestAnimationFrame`，小程序优先用 canvas 节点的同名方法。
 *
 * 逻辑坐标恒为 1280×640（与 web 端一致），backing store 按 pixelRatio（上限 2x）重建，
 * 每帧 `setTransform` 映射；命中判定由页面把触摸点换算成逻辑坐标后调用 `hitTest()`。
 * 规则相关的取位（牌墙 slotPos / 精牌描边 / 风位 seatWind）全部走 shared 产物，不做二次实现。
 */

const { tileName, seatWind, suitOf, rankOf } = require('../lib/shared/tiles.js');
const { RING_SLOTS, SEG_LEN, SEG_START } = require('../lib/shared/wall.js');
const { tileArt } = require('./tiles.js');

const W = 1280;
const H = 640;
const HAND_W = 52;
const HAND_H = 70;
const HAND_PITCH = 56;
const HAND_Y = 560;
const RIVER_W = 24;
const RIVER_H = 32;
const MELD_W = 32;
const MELD_H = 42;
const DRAWN_GAP = 20;
const DRAWN_RAISE = 14;
const ANIM_MS = 300;
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
    this.hits = [];
    this.canDiscard = false;
    this.anim = null;
    this.prevDrawn = null;
    this.prevDrawnX = 0;
    this.prevHandLen = 0;
    this.lastRendered = null;
    this.rafQueued = false;
    this.handRect = null;
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
   * 与 web 端 onClick 的判定顺序完全一致：掷骰按钮 → 铭牌（互动表情入口）→ 手牌。
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
    if (!this.canDiscard) return;
    const padX = (HAND_PITCH - HAND_W) / 2;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (x >= h.x - padX && x <= h.x + HAND_W + padX && y >= h.y - 8 && y <= h.y + HAND_H + 8) {
        this.onDiscard(h.tile);
        return;
      }
    }
  }

  render(view) {
    this.view = view;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lastRendered = view;
    if (view.drawn !== null && this.anim) this.anim = null;
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
    let effMy = view.myTiles;
    let effDrawn = view.drawn;
    if (deal) {
      effCounts.fill(0);
      const steps = (view.wallRing && view.wallRing.recipe.steps) || [];
      for (let i = 0; i < Math.min(deal.done, steps.length); i++) {
        effCounts[steps[i].seat] += steps[i].slots.length;
      }
      effMy = view.myTiles.slice(0, effCounts[view.mySeat]);
      effDrawn = null;
    }
    this.effCounts = effCounts;
    this.canDiscard =
      view.phase === 'playing' &&
      view.turn === view.mySeat &&
      !view.claimWindow &&
      !view.claims &&
      !this.dealing;
    this.hits = [];

    this.drawTable();
    this.drawWall(view, deal);
    this.drawRivers(view);
    this.drawCenter(view, deal);
    for (let s = 0; s < 4; s++) {
      if (view.reveal) {
        if (this.disp(view, s) !== 0) this.drawRevealHand(view, s);
      } else {
        this.drawBacks(view, s);
      }
      this.drawMelds(view.melds[s], this.disp(view, s));
      this.drawTag(view, s);
    }
    this.drawMyHand(view, effMy, effDrawn);
    if (view.lastDiscard) this.drawLastMarker(view);
    this.drawTurnCursor(view);
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

  riverOrigin(seat) {
    if (seat === 0) return { x: 458, y: 398, perRow: 14, dx: RIVER_W + 2 };
    if (seat === 2) return { x: 537, y: 156, perRow: 8, dx: RIVER_W + 2 };
    if (seat === 3) return { x: 334, y: 156, perRow: 7, dx: RIVER_W + 2 };
    return { x: 764, y: 156, perRow: 7, dx: RIVER_W + 2 };
  }

  riverPos(seat, i) {
    const o = this.riverOrigin(seat);
    const col = i % o.perRow;
    const row = Math.floor(i / o.perRow);
    return { x: o.x + col * o.dx, y: o.y + row * (RIVER_H + 2) };
  }

  drawRivers(view) {
    for (let s = 0; s < 4; s++) {
      const slot = this.disp(view, s);
      const river = view.rivers[s] || [];
      river.forEach((tile, i) => {
        const p = this.riverPos(slot, i);
        this.drawTile(tile, p.x, p.y, RIVER_W, RIVER_H, view);
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
    roundRect(ctx, p.x - 2, p.y - 2, RIVER_W + 4, RIVER_H + 4, 4);
    ctx.stroke();
  }

  drawCenter(view, deal) {
    const ctx = this.ctx;
    const px = 530;
    const py = 256;
    const pw = 220;
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
    ctx.font = font(12);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`牌墙 ${wallLeft}`, px + 12, py + 14);

    const winds = [
      { seat: view.mySeat, x: 640, y: py + ph - 12 },
      { seat: (view.mySeat + 1) % 4, x: px + pw - 22, y: py + 66 },
      { seat: (view.mySeat + 2) % 4, x: 640, y: py + 14 },
      { seat: (view.mySeat + 3) % 4, x: px + 22, y: py + 66 },
    ];
    ctx.textAlign = 'center';
    for (const w of winds) {
      const isDealer = w.seat === view.dealer;
      if (isDealer) {
        roundRect(ctx, w.x - 14, w.y - 11, 28, 22, 6);
        ctx.fillStyle = '#e6c14b';
        ctx.fill();
        ctx.fillStyle = '#22200f';
        ctx.font = font(15, true);
      } else {
        ctx.fillStyle = '#b9cfc2';
        ctx.font = font(14);
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
    this.drawDieFace(603, 292, 32, shown ? shown[0] : null);
    this.drawDieFace(645, 292, 32, shown ? shown[1] : null);

    if (view.gz) {
      const gzVis = view.gz.zheng.length > 0 && !(view.ceremony && view.ceremony.kind === 'jing' && !this.revealed(view));
      if (gzVis) {
        const hasFu = view.gz.fu.length > 0;
        this.drawTile(view.gz.zheng[0], 602, 330, 34, 42, view);
        if (hasFu) this.drawTile(view.gz.fu[0], 644, 330, 34, 42, view);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = font(10);
        ctx.fillStyle = '#e0a86a';
        ctx.fillText('正精', 619, 381);
        if (hasFu) {
          ctx.fillStyle = '#b48ae0';
          ctx.fillText('副精', 661, 381);
        }
        if (!view.gz.revealed) {
          ctx.font = font(11);
          ctx.fillStyle = '#9db5a8';
          ctx.fillText('其余 10 张结算揭晓', 640, 400);
        }
      }
    } else {
      const jingOk =
        view.jingPi !== null &&
        view.jingFu !== null &&
        !(view.ceremony && view.ceremony.kind === 'jing' && !this.revealed(view));
      if (jingOk) {
        this.drawTile(view.jingPi, 602, 330, 34, 42, view);
        this.drawTile(view.jingFu, 644, 330, 34, 42, view);
      }
    }

    if (c && c.state === 'wait-roll' && !this.rollClicked) {
      const label = c.kind === 'deal' ? '掷骰开局' : c.kind === 'jing' ? '掷骰翻精' : '掷骰补牌';
      const mine = view.mySeat === c.seat;
      const bx = 570;
      const by = 286;
      const bw = 140;
      const bh = 44;
      roundRect(ctx, bx, by, bw, bh, 10);
      ctx.fillStyle = mine ? '#e6c14b' : 'rgba(28,44,36,0.92)';
      ctx.fill();
      ctx.strokeStyle = mine ? '#f6e3a1' : '#4d675a';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (mine) {
        ctx.fillStyle = '#22200f';
        ctx.font = font(17, true);
        ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1);
      } else {
        ctx.fillStyle = '#9db5a8';
        ctx.font = font(13);
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

  drawBacks(view, seat) {
    const slot = this.disp(view, seat);
    const n = this.effCounts[seat];
    const shown = (view.declared || []).filter((d) => d.seat === seat).map((d) => d.tile);
    const self = this;
    const cell = (i, x, y, w, h) => {
      if (i < shown.length) {
        self.drawTile(shown[i], x, y, w, h, view);
        const ctx = self.ctx;
        ctx.strokeStyle = '#e6c14b';
        ctx.lineWidth = 2;
        roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 4);
        ctx.stroke();
      } else {
        self.drawTile(-1, x, y, w, h, view);
      }
    };
    if (slot === 2) {
      const pitch = 34;
      const total = n * pitch - 2;
      let x = (W - total) / 2;
      for (let i = 0; i < n; i++, x += pitch) cell(i, x, 54, 32, 22);
    } else if (slot === 3) {
      let y = 160;
      for (let i = 0; i < n; i++, y += 32) cell(i, 160, y, 22, 30);
    } else if (slot === 1) {
      let y = 160;
      for (let i = 0; i < n; i++, y += 32) cell(i, 1092, y, 22, 30);
    }
  }

  drawRevealHand(view, seat) {
    const slot = this.disp(view, seat);
    const tiles = (view.reveal && view.reveal[seat]) || [];
    if (tiles.length === 0) return;
    if (slot === 2) {
      const pitch = 30;
      const w = 28;
      const total = tiles.length * pitch - (pitch - w);
      let x = (W - total) / 2;
      for (const t of tiles) {
        this.drawTile(t, x, 54, w, 36, view);
        x += pitch;
      }
    } else if (slot === 3) {
      let y = 160;
      for (const t of tiles) {
        this.drawTile(t, 160, y, 28, 32, view);
        y += 34;
      }
    } else if (slot === 1) {
      let y = 160;
      for (const t of tiles) {
        this.drawTile(t, 1092, y, 28, 32, view);
        y += 34;
      }
    }
  }

  meldWidth(m) {
    return m.tiles.length * MELD_W;
  }

  drawMelds(melds, seat) {
    if (!melds || melds.length === 0) return;
    if (seat === 0) {
      const gap = 14;
      let total = gap * (melds.length - 1);
      for (const m of melds) total += this.meldWidth(m);
      let x = 950 - total;
      for (const m of melds) {
        x = this.drawMeldRow(m, x, 502);
        x += gap;
      }
    } else if (seat === 2) {
      const gap = 14;
      let total = gap * (melds.length - 1);
      for (const m of melds) total += this.meldWidth(m);
      let x = 950 - total;
      for (const m of melds) {
        x = this.drawMeldRow(m, x, 80);
        x += gap;
      }
    } else if (seat === 3) {
      let y = 160;
      for (const m of melds) {
        this.drawMeldRow(m, 20, y);
        y += MELD_H + 4;
      }
    } else {
      let y = 160;
      for (const m of melds) {
        const w = this.meldWidth(m);
        this.drawMeldRow(m, 1260 - w, y);
        y += MELD_H + 4;
      }
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

  drawTag(view, seat) {
    const ctx = this.ctx;
    const slot = this.disp(view, seat);
    const TAG_W = 130;
    const TAG_H = 40;
    const INSET = 16;
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

    roundRect(ctx, x, y, w, h, 6);
    ctx.fillStyle = isWinner ? 'rgba(230,193,75,0.3)' : 'rgba(0,0,0,0.4)';
    ctx.fill();
    ctx.strokeStyle = isWinner ? '#f6e3a1' : isTurn ? '#e6c14b' : me ? 'rgba(230,193,75,0.45)' : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = isWinner ? 3 : isTurn ? 2 : 1;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    let tx = x + 10;
    if (dealer) {
      roundRect(ctx, x + 8, y + 5, 20, 17, 4);
      ctx.fillStyle = '#e6c14b';
      ctx.fill();
      ctx.fillStyle = '#22200f';
      ctx.font = font(11, true);
      ctx.textAlign = 'center';
      ctx.fillText('庄', x + 18, y + 14);
      ctx.textAlign = 'left';
      tx = x + 33;
    }

    const rawName = (view.names && view.names[seat]) || this.wind(seat);
    const short = rawName.length > (me ? 4 : 5) ? rawName.slice(0, me ? 4 : 5) + '…' : rawName;
    ctx.font = font(11);
    ctx.fillStyle = isWinner ? '#ffe9a8' : isTurn ? '#e6c14b' : '#e8efe9';
    ctx.fillText(`${this.wind(seat)}·${short}${me ? '·我' : ''}`, tx, y + 14);

    ctx.font = font(12);
    if (isWinner) {
      ctx.fillStyle = '#ffe9a8';
      ctx.font = font(13, true);
      ctx.fillText('胡牌！', tx, y + 31);
      ctx.font = font(12);
    } else if (autoPlay) {
      ctx.fillStyle = '#e0a06a';
      ctx.fillText('托管中', tx, y + 31);
    } else if (isTurn) {
      ctx.fillStyle = '#e6c14b';
      ctx.fillText('出牌中', tx, y + 31);
    } else {
      ctx.fillStyle = '#9db5a8';
      ctx.fillText(`${this.effCounts[seat]} 张`, tx, y + 31);
    }
    const tv = (view.totals && view.totals[seat]) || 0;
    ctx.textAlign = 'right';
    ctx.font = font(12, true);
    ctx.fillStyle = tv > 0 ? '#43c07c' : tv < 0 ? '#e07a6a' : '#9db5a8';
    ctx.fillText(tv > 0 ? `+${tv}` : `${tv}`, x + w - 10, y + 31);
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

  winnerRect(view) {
    const seat = view.winner;
    if (seat === null || view.phase !== 'over') return null;
    const slot = this.disp(view, seat);
    if (slot === 0) return this.handRect;
    const n = ((view.reveal && view.reveal[seat]) || []).length;
    if (n === 0) return null;
    if (slot === 2) {
      const total = n * 30 - 2;
      return { x: (W - total) / 2 - 5, y: 49, w: total + 10, h: 46 };
    }
    const total = n * 34 - 2;
    const x = slot === 3 ? 155 : 1087;
    return { x, y: 155, w: 38, h: total + 10 };
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

  drawResultBanner(view) {
    const seat = view.winner;
    if (seat === null || view.phase !== 'over') return;
    const name = (view.names && view.names[seat]) || this.wind(seat);
    const main = `${this.wind(seat)}·${name} 胡`;
    const sub = view.result || '';
    const ctx = this.ctx;
    const bw = 440;
    const bh = 44;
    const bx = (W - bw) / 2;
    const by = 4;
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
    ctx.font = font(19, true);
    ctx.fillText(main, W / 2, by + 16);
    if (sub) {
      ctx.fillStyle = 'rgba(34,32,15,0.78)';
      ctx.font = font(12);
      ctx.fillText(sub, W / 2, by + 34);
    }
  }

  drawTurnCursor(view) {
    if (this.dealing || view.phase !== 'playing' || view.claimWindow) return;
    const seat = view.turn;
    const slot = this.disp(view, seat);
    let rect = null;
    if (slot === 0) {
      rect = this.handRect;
    } else if (slot === 2) {
      const total = view.counts[seat] * 34 - 2;
      rect = { x: (W - total) / 2 - 4, y: 50, w: total + 8, h: 30 };
    } else if (slot === 3) {
      const total = view.counts[seat] * 32 - 2;
      rect = { x: 156, y: 156, w: 30, h: total + 8 };
    } else if (slot === 1) {
      const total = view.counts[seat] * 32 - 2;
      rect = { x: 1088, y: 156, w: 30, h: total + 8 };
    }
    if (!rect) return;

    const ctx = this.ctx;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 280);
    ctx.save();
    ctx.strokeStyle = `rgba(230, 193, 75, ${0.35 + 0.55 * pulse})`;
    ctx.lineWidth = 3;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 8);
    ctx.stroke();

    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const s = 11;
    ctx.fillStyle = `rgba(230, 193, 75, ${0.55 + 0.45 * pulse})`;
    ctx.beginPath();
    if (slot === 0) {
      const px = cx;
      const py = rect.y + 16 + pulse * 5;
      ctx.moveTo(px, py);
      ctx.lineTo(px - s, py - s);
      ctx.lineTo(px + s, py - s);
    } else if (slot === 2) {
      const px = cx;
      const py = rect.y + rect.h - 16 - pulse * 5;
      ctx.moveTo(px, py);
      ctx.lineTo(px - s, py + s);
      ctx.lineTo(px + s, py + s);
    } else if (slot === 3) {
      const px = rect.x + rect.w - 16 - pulse * 5;
      ctx.moveTo(px, cy);
      ctx.lineTo(px + s, cy - s);
      ctx.lineTo(px + s, cy + s);
    } else {
      const px = rect.x + 16 + pulse * 5;
      ctx.moveTo(px, cy);
      ctx.lineTo(px - s, cy - s);
      ctx.lineTo(px - s, cy + s);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  drawMyHand(view, myTiles, drawn) {
    let rest = myTiles;
    if (drawn !== null) {
      const idx = rest.indexOf(drawn);
      if (idx >= 0) rest = rest.slice(0, idx).concat(rest.slice(idx + 1));
    }

    const n = rest.length + (drawn !== null ? 1 : 0);
    if (n === 0) {
      this.handRect = null;
      return;
    }
    const total = n * HAND_PITCH - (HAND_PITCH - HAND_W) + (drawn !== null ? DRAWN_GAP : 0);
    const startX = (W - total) / 2;
    const topY = drawn !== null ? HAND_Y - DRAWN_RAISE : HAND_Y;
    this.handRect = {
      x: startX - 4,
      y: topY - 4,
      w: total + 8,
      h: HAND_H + 8 + (drawn !== null ? DRAWN_RAISE : 0),
    };

    if (this.prevDrawn !== null && drawn === null && this.prevHandLen === myTiles.length + 1 && this.prevDrawnX > 0) {
      const target = myTiles.indexOf(this.prevDrawn);
      if (target >= 0) {
        this.anim = { tile: this.prevDrawn, from: this.prevDrawnX, to: startX + target * HAND_PITCH, start: Date.now() };
      }
    }

    let skipped = false;
    rest.forEach((t, i) => {
      if (this.anim && !skipped && t === this.anim.tile) {
        skipped = true;
        return;
      }
      const x = startX + i * HAND_PITCH;
      this.drawTile(t, x, HAND_Y, HAND_W, HAND_H, view);
      this.markDeclare(view, t, x, HAND_Y);
      this.hits.push({ tile: t, x, y: HAND_Y });
    });

    let drawnX = -1;
    if (drawn !== null) {
      drawnX = startX + rest.length * HAND_PITCH + DRAWN_GAP;
      this.drawDrawn(drawn, drawnX, view);
      this.hits.push({ tile: drawn, x: drawnX, y: HAND_Y - DRAWN_RAISE });
    }

    if (this.anim) {
      const k = Math.min(1, (Date.now() - this.anim.start) / ANIM_MS);
      const x = this.anim.from + (this.anim.to - this.anim.from) * k;
      const y = HAND_Y - DRAWN_RAISE * (1 - k);
      this.drawTile(this.anim.tile, x, y, HAND_W, HAND_H, view);
      this.markDeclare(view, this.anim.tile, x, y);
      this.hits.push({ tile: this.anim.tile, x, y });
      if (k >= 1) this.anim = null;
      else this.scheduleFrame();
    }

    this.prevDrawn = drawn;
    this.prevHandLen = myTiles.length;
    if (drawn !== null) this.prevDrawnX = drawnX;

    if (this.canDiscard) {
      const ctx = this.ctx;
      ctx.fillStyle = 'rgba(230,193,75,0.9)';
      ctx.font = font(12);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const tip =
        view.mustDiscard.length > 0
          ? `必须先打出 ${view.mustDiscard.map((t) => tileName(t)).join('、')}`
          : '点击手牌打出';
      ctx.fillText(tip, W / 2, HAND_Y - 10);
    }
  }

  markDeclare(view, t, x, y) {
    const frozen = (view.declared || []).some((d) => d.seat === view.mySeat && d.tile === t);
    const must = (view.mustDiscard || []).indexOf(t) >= 0;
    if (!frozen && !must) return;
    const ctx = this.ctx;
    ctx.strokeStyle = frozen ? '#e6c14b' : '#e05a4a';
    ctx.lineWidth = 2;
    roundRect(ctx, x - 1, y - 1, HAND_W + 2, HAND_H + 2, 5);
    ctx.stroke();
    if (frozen) {
      ctx.fillStyle = '#e6c14b';
      ctx.font = font(11, true);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('展', x + 3, y + 8);
    }
  }

  drawDrawn(t, x, view) {
    const y = HAND_Y - DRAWN_RAISE;
    this.drawTile(t, x, y, HAND_W, HAND_H, view);
    this.markDeclare(view, t, x, y);
    const ctx = this.ctx;
    ctx.strokeStyle = '#e6c14b';
    ctx.lineWidth = 2;
    roundRect(ctx, x - 1, y - 1, HAND_W + 2, HAND_H + 2, 5);
    ctx.stroke();
    ctx.fillStyle = '#e6c14b';
    ctx.font = font(11, true);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('新', x + HAND_W + 4, y + 8);
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

  drawTile(t, x, y, w, h, view, noGlow) {
    const ctx = this.ctx;
    const r = Math.max(3, Math.floor(w * 0.12));
    if (t < 0) {
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

    const art = tileArt(t);
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

    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = '#f6f2e7';
    ctx.fill();
    ctx.fillStyle = '#ddd6c2';
    ctx.fillRect(x + 1, y + h - Math.max(3, h * 0.1), w - 2, Math.max(3, h * 0.1));
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
      const rank = String(rankOf(t));
      ctx.fillStyle = suit === 'm' ? '#1a1a2e' : SUIT_COLOR[suit];
      ctx.font = font(Math.floor(h * 0.4), true);
      ctx.fillText(rank, cx, y + h * 0.33);
      ctx.fillStyle = SUIT_COLOR[suit];
      ctx.font = font(Math.floor(h * 0.32), true);
      ctx.fillText(SUIT_CHAR[suit], cx, y + h * 0.68);
    } else if (t === 33) {
      const bw = w * 0.52;
      const bh = h * 0.56;
      ctx.strokeStyle = '#1f5fbf';
      ctx.lineWidth = 2;
      ctx.strokeRect(cx - bw / 2, y + h / 2 - bh / 2, bw, bh);
      ctx.strokeStyle = 'rgba(31,95,191,0.4)';
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - bw / 2 + 3, y + h / 2 - bh / 2 + 3, bw - 6, bh - 6);
    } else {
      const ch = tileName(t);
      ctx.fillStyle = t === 31 ? '#c62828' : t === 32 ? '#1b7f3b' : '#1a1a1a';
      ctx.font = font(Math.floor(h * 0.5), true);
      ctx.fillText(ch, cx, y + h / 2 + 1);
    }
  }
}

module.exports = { Table, W, H };
