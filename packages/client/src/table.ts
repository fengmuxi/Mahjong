import type { GameView, Meld, Tile } from '@shared/index.ts';
import { rankOf, seatWind, suitOf, tileName } from '@shared/tiles.ts';
import { RING_COLS, RING_SLOTS, SEG_LEN, SEG_START } from '@shared/wall.ts';
import { tileArt } from './tileart.ts';

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
/** 摸到的新牌：与手牌的间隔、抬起高度 */
const DRAWN_GAP = 20;
const DRAWN_RAISE = 14;
/** 出牌后新牌归位动画时长（ms） */
const ANIM_MS = 300;
/** 牌墙环（内移方形摆位）：横段墩 20×16、竖段墩 16×20、列距 24、上层向桌心偏 6 */
/** 牌墙环：墩的长边“指向该边玩家”（垂直于墙）、短边沿墙；列距 30、上层向桌心偏 7 */
const WALL_PITCH = 30;
const WALL_LAYER = 7;
const WALL_ACROSS = 26; // 墩朝玩家的长边（横段的高 / 竖段的宽）
const WALL_ALONG = 22; // 墩沿墙的短边（横段的宽 / 竖段的高）
/** 各边外层基线（上层 = 向桌心偏 WALL_LAYER） */
const WALL_BOTTOM_Y = 473;
const WALL_TOP_Y = 122;
const WALL_LEFT_X = 284;
const WALL_RIGHT_X = 974;
/**
 * 竖段（左右两边）下端允许到达的最大 y。其下方是手牌带（HAND_Y=560；摸到的牌
 * 会抬起 DRAWN_RAISE，最高到 546），牌墙必须整段留在手牌之上——规则文档
 * 《南昌麻将》§3 也写明牌墙「位于手牌与牌河之间」。
 */
const WALL_V_LIMIT = 540;
/** 飞向玩家手牌的牌背动画时长（ms） */
const GHOST_MS = 420;
/**
 * 铭牌气泡宽度上限分两档：**下排**（自己/下家的铭牌）上方紧挨着左右两家的手牌背
 * （x 160..182 / 1092..1114，纵向到 y≈576），只剩 ~140px 可用；**上排**下方是空地，
 * 可以放宽。行数上限 3 行，超出截断加省略号——气泡永远待在四角空档里，不压牌面。
 */
const BUBBLE_W_NARROW = 138;
const BUBBLE_W_WIDE = 230;
const BUBBLE_LINE_H = 15;
const BUBBLE_MAX_LINES = 3;
/** 气泡停留总时长与末段淡出时长（ms） */
const BUBBLE_MS = 4200;
const BUBBLE_FADE = 420;
/** 互动表情动画：总时长与「飞行段」占比（其余为命中溅射 + 淡出） */
const EMOTE_MS = 1250;
const EMOTE_FLY = 0.38;
/** 画布上画 emoji 的字体栈（Chromium 走彩色字形） */
const EMOJI_FONT = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

const SUIT_CHAR: Record<string, string> = { m: '万', s: '条', p: '筒' };
const SUIT_COLOR: Record<string, string> = { m: '#c62828', s: '#1b7f3b', p: '#1f5fbf' };

interface Hit {
  tile: Tile;
  x: number;
  y: number;
}

interface WallSeg {
  /** 环段（0 庄前 … 3 庄的上家前） */
  r: number;
  /** 屏幕方位 0下 1右 2上 3左 */
  screen: number;
  cols: number;
  x0: number;
  y0: number;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export class Table {
  private ctx: CanvasRenderingContext2D;
  private view: GameView | null = null;
  private hits: Hit[] = [];
  private canDiscard = false;
  /** 新牌归位动画 */
  private anim: { tile: Tile; from: number; to: number; start: number } | null = null;
  private prevDrawn: Tile | null = null;
  private prevDrawnX = 0;
  private prevHandLen = 0;
  private lastRendered: GameView | null = null;
  private rafQueued = false;
  /** 自己手牌的占位（出牌光标用） */
  private handRect: { x: number; y: number; w: number; h: number } | null = null;
  /** 发牌仪式进行中（手牌/牌墙按步骤渐进展示） */
  private dealing = false;
  private effCounts: number[] = [0, 0, 0, 0];
  private dealAnim: { key: number; start: number; dur: number } | null = null;
  private prevRemoved: boolean[] | null = null;
  private ghosts: { x0: number; y0: number; x1: number; y1: number; t0: number }[] = [];
  /** 中央骰子揭示时刻（与 DOM 翻滚动画同步：翻滚结束才出点数） */
  private diceReveal: { key: number; start: number; tumble: number } | null = null;
  /** 桌面正中的掷骰按钮命中区（仅等待掷骰时存在） */
  private rollBtn: { x: number; y: number; w: number; h: number } | null = null;
  private rollClicked = false;
  /** backing store 的设备像素比（逻辑坐标恒为 1280×640，绘制时统一缩放） */
  private dpr = 1;
  onDiscard: (tile: Tile) => void = () => {};
  /** 点击桌面正中掷骰按钮 */
  onRollDice: () => void = () => {};
  /** 点击某家铭牌（seat 为座位号）——用于「点对手铭牌 → 打开互动表情面板」 */
  onTagClick: (seat: number) => void = () => {};
  /** 四家铭牌矩形（按屏幕位次；drawTag 时刷新）——气泡定位与点击命中共用 */
  private tagRects: ({ x: number; y: number; w: number; h: number } | null)[] = [null, null, null, null];
  /** 铭牌内容气泡：文字挂发送者铭牌、互动表情挂目标铭牌，到时自动消失 */
  private bubbles: { seat: number; content: string; kind: 'text' | 'emote'; t0: number }[] = [];
  /** 互动表情动画：从发送者铭牌飞向目标铭牌，在目标处溅射并淡出 */
  private emoteFx: { from: number; target: number; icon: string; t0: number }[] = [];
  /** 吃碰胡杠中心动画 */
  private actionFx: { kind: string; seat: number; t0: number } | null = null;
  private lastActionSeq = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 canvas 上下文');
    this.ctx = ctx;
    canvas.addEventListener('click', (ev) => this.onClick(ev));
    this.applyBackingStore();
    // 旋转屏幕 / 跨屏拖动 / 缩放后 DPR 会变，需要重算 backing store
    window.addEventListener('resize', () => this.applyBackingStore(), { passive: true });
  }

  /**
   * 按设备像素比重建 backing store —— 解决手机上牌面贴图被放大后发虚的问题。
   *
   * 逻辑坐标系恒为 1280×640：绘制代码一行不改，每帧开头用 setTransform 把逻辑
   * 坐标映射到物理像素。而点击换算走的是 `getBoundingClientRect()`（只与 CSS 尺寸
   * 有关），因此放大 backing store 不会影响命中判定。
   * 上限 2x 是性能与清晰度的折中：3x 屏按 2x 渲染肉眼已看不出差别，显存却省一半。
   */
  private applyBackingStore(): void {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const w = Math.round(W * dpr);
    const h = Math.round(H * dpr);
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.dpr = dpr;
    this.canvas.width = w;
    this.canvas.height = h;
    if (this.lastRendered) this.render(this.lastRendered);
  }

  render(view: GameView): void {
    this.view = view;
    // 重建物理像素 → 逻辑坐标的映射（backing store 可能是 2x）
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lastRendered = view;
    if (view.drawn !== null && this.anim) this.anim = null; // 新一轮摸牌则取消旧动画
    if (view.ceremony?.state !== 'wait-roll') this.rollClicked = false;
    this.rollBtn = null;

    // 检测新操作 → 触发中心动画
    if (view.lastAction && view.lastAction.seq !== this.lastActionSeq) {
      this.lastActionSeq = view.lastAction.seq;
      const k = view.lastAction.kind;
      if (k === 'chi' || k === 'peng' || k === 'gang' || k === 'angang' || k === 'bugang' || k === 'hu') {
        this.actionFx = { kind: k, seat: view.lastAction.seat, t0: performance.now() };
      }
    }

    // 发牌仪式：手牌与牌墙按步骤渐进（动画结束前不露出最终手牌）
    const deal = this.dealProgress(view);
    this.dealing = deal !== null;
    const effCounts = [...view.counts];
    let effMy = view.myTiles;
    let effDrawn = view.drawn;
    if (deal) {
      effCounts.fill(0);
      const steps = view.wallRing?.recipe.steps ?? [];
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
    const ctx = this.ctx;

    this.drawTable();
    this.drawWall(view, deal);
    // 结算（over）时牌河照画：本端牌河在环内（y156/y398 带），与边上的摊牌手牌
    // （y54 / x160 / x1092）不在同一网格，无需让位
    this.drawRivers(view);
    this.drawCenter(view, deal);
    for (let s = 0; s < 4; s++) {
      if (view.reveal) {
        // 摊牌：对手暗牌全部亮出（自己那手由 drawMyHand 画）
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
    this.drawJingHighlight(view); // 翻开的正精立牌（最上层，牌面可读）
    if (view.phase === 'over') {
      // 摊牌：显著标识赢家（赢家手牌金色光晕 + 顶部横幅点名）
      this.drawWinnerHighlight(view);
      this.drawResultBanner(view);
    }
    // 互动表情动画与铭牌气泡画在最上层（它们都待在四角空档里，不会压住牌面）
    this.drawEmoteFx();
    this.drawBubbles();
    this.drawActionFx();
    // 光标呼吸 / 表情动画 / 气泡淡出 / 操作动画都需要连续帧，任一存在就继续排帧
    if (
      view.phase === 'playing' ||
      this.emoteFx.length > 0 ||
      this.bubbles.length > 0 ||
      this.actionFx !== null
    ) {
      this.scheduleFrame();
    }
  }

  /** 发牌仪式进度：null = 无仪式/已结束；否则返回已完成的发牌步数 */
  private dealProgress(view: GameView): { done: number } | null {
    const c = view.ceremony;
    if (!c || c.kind !== 'deal' || view.phase !== 'playing') return null;
    if (c.state === 'wait-roll') return { done: 0 };
    if (c.rollAt === null || c.until === null) return { done: 0 };
    if (this.dealAnim?.key !== c.rollAt) {
      this.dealAnim = {
        key: c.rollAt,
        start: performance.now(),
        dur: Math.max(300, c.until - c.rollAt),
      };
    }
    const a = this.dealAnim;
    const elapsed = performance.now() - a.start;
    if (elapsed >= a.dur) return null;
    const steps = view.wallRing?.recipe.steps.length ?? 0;
    // 时间轴：先播骰子翻滚（与中央揭示时刻一致），翻滚结束后抓牌，尾段收束
    const tumble = Math.min(2200, Math.floor(a.dur * 0.5));
    const end = a.dur * 0.94;
    const t = Math.min(1, Math.max(0, (elapsed - tumble) / Math.max(1, end - tumble)));
    return { done: Math.min(steps, Math.floor(t * steps + 1e-9)) };
  }

  private onClick(ev: MouseEvent): void {
    if (!this.view) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = ((ev.clientX - rect.left) * W) / rect.width;
    const y = ((ev.clientY - rect.top) * H) / rect.height;
    // 桌面正中的掷骰按钮（等待掷骰时）
    const rb = this.rollBtn;
    if (rb && x >= rb.x && x <= rb.x + rb.w && y >= rb.y && y <= rb.y + rb.h) {
      if (!this.rollClicked) {
        this.rollClicked = true;
        this.onRollDice();
      }
      return;
    }
    // 铭牌命中（互动表情入口）：优先于出牌判定。铭牌钉在四个桌角，与手牌带不重叠，
    // 因此不会抢走出牌的点击；点自己那枚由上层忽略（不做任何事）。
    for (let slot = 0; slot < 4; slot++) {
      const tg = this.tagRects[slot];
      if (tg && x >= tg.x && x <= tg.x + tg.w && y >= tg.y && y <= tg.y + tg.h) {
        this.onTagClick((this.view.mySeat + slot) % 4);
        return;
      }
    }
    if (!this.canDiscard) return;
    // 命中区左右各外扩半个牌距、上下各外扩 8：把相邻手牌之间的缝隙也纳入判定，
    // 小屏上「差一点点」也能点中；相邻命中区恰好相接、互不重叠，判定无歧义。
    const padX = (HAND_PITCH - HAND_W) / 2;
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i];
      if (
        x >= h.x - padX &&
        x <= h.x + HAND_W + padX &&
        y >= h.y - 8 &&
        y <= h.y + HAND_H + 8
      ) {
        this.onDiscard(h.tile);
        return;
      }
    }
  }

  // ---------- 绘制 ----------

  /** 展示位次（相对自己镜像）：0=自己(下) 1=下家(右) 2=对家(上) 3=上家(左) */
  private disp(view: GameView, seat: number): number {
    return (((seat - view.mySeat) % 4) + 4) % 4;
  }

  /** 座位风位（**庄家恒为东**，风位随庄转）——牌桌所有风位显示都走这里 */
  private wind(seat: number): string {
    return seatWind(seat, this.view?.dealer ?? 0);
  }

  private drawTable(): void {
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

  // ---------- 牌墙环 ----------

  /**
   * 段内墩距。横段恒为 WALL_PITCH；**竖段**若也按 WALL_PITCH 摆，20 墩段会长达
   * ≈592px 一直伸进手牌带（庄家坐在自己左右两侧时就是这种情况），因此压缩到
   * 「整段刚好停在手牌之上」的最大墩距。段长（SEG_LEN）属规则模型不可改，只能改摆法。
   */
  private segPitch(seg: WallSeg): number {
    if (seg.screen === 0 || seg.screen === 2 || seg.cols <= 1) return WALL_PITCH;
    // 竖段居中摆放：y0 = (H − span) / 2，故要求 span ≤ 2·WALL_V_LIMIT − H
    const fit = Math.floor((2 * WALL_V_LIMIT - H - WALL_ALONG) / (seg.cols - 1));
    return Math.max(WALL_ALONG, Math.min(WALL_PITCH, fit));
  }

  /** 段在屏幕上的跨度 = 墩距 × (墩数 − 1) + 墩的短边 */
  private segSpan(seg: WallSeg): number {
    return (seg.cols - 1) * this.segPitch(seg) + WALL_ALONG;
  }

  /** 四段牌墙（环段 → 屏幕方位随庄家视角旋转），整体呈桌心方形 */
  private wallSegs(view: GameView): WallSeg[] {
    const dealerDisp = this.disp(view, view.dealer);
    const segs: WallSeg[] = [];
    for (let r = 0; r < 4; r++) {
      const seg: WallSeg = { r, screen: (dealerDisp + r) % 4, cols: SEG_LEN[r], x0: 0, y0: 0 };
      const span = this.segSpan(seg);
      if (seg.screen === 0 || seg.screen === 2) seg.x0 = (W - span) / 2;
      else seg.y0 = (H - span) / 2;
      segs.push(seg);
    }
    return segs;
  }

  private segOfCol(col: number): number {
    for (let s = 0; s < 4; s++) {
      if (col >= SEG_START[s] && col < SEG_START[s] + SEG_LEN[s]) return s;
    }
    return 0;
  }

  /** 环槽位（环列 + 层）→ 屏幕矩形；段内墩序 = **顺时针**行走方向 */
  private slotPos(
    seg: WallSeg,
    col: number,
    layer: number,
  ): { x: number; y: number; w: number; h: number } {
    const i = col - SEG_START[seg.r];
    const span = this.segSpan(seg);
    const pitch = this.segPitch(seg);
    const off = layer * WALL_LAYER;
    switch (seg.screen) {
      case 0: // 下沿：顺时针 右→左；长边朝下（对着玩家）
        return {
          x: seg.x0 + span - WALL_ALONG - i * pitch,
          y: WALL_BOTTOM_Y - off,
          w: WALL_ALONG,
          h: WALL_ACROSS,
        };
      case 2: // 上沿：顺时针 左→右；长边朝上
        return {
          x: seg.x0 + i * pitch,
          y: WALL_TOP_Y + off,
          w: WALL_ALONG,
          h: WALL_ACROSS,
        };
      case 3: // 左沿：顺时针 下→上；长边朝左
        return {
          x: WALL_LEFT_X + off,
          y: seg.y0 + span - WALL_ALONG - i * pitch,
          w: WALL_ACROSS,
          h: WALL_ALONG,
        };
      default: // 右沿：顺时针 上→下；长边朝右
        return { x: WALL_RIGHT_X - off, y: seg.y0 + i * pitch, w: WALL_ACROSS, h: WALL_ALONG };
    }
  }

  /** 牌墙移除表；stepsDone 非空时按发牌步骤渐进 */
  private computeRemoved(view: GameView, stepsDone: number | null): boolean[] {
    const removed = new Array<boolean>(RING_SLOTS).fill(false);
    const rr = view.wallRing;
    if (!rr) return removed;
    if (stepsDone !== null) {
      for (let s = 0; s < Math.min(stepsDone, rr.recipe.steps.length); s++) {
        for (const slot of rr.recipe.steps[s].slots) removed[slot] = true;
      }
      return removed;
    }
    for (const step of rr.recipe.steps) for (const slot of step.slots) removed[slot] = true;
    // 牌墙前端已被行牌摸走的连续区域
    let guard = 0;
    let s = rr.recipe.endSlot;
    while (s !== rr.frontSlot && guard++ < RING_SLOTS) {
      removed[s] = true;
      s = (s + 1) % RING_SLOTS;
    }
    for (const slot of rr.kongSlots) removed[slot] = true;
    return removed;
  }

  private seatAnchor(view: GameView, seat: number): { x: number; y: number } {
    const screen = this.disp(view, seat);
    if (screen === 0) return { x: W / 2, y: 604 };
    if (screen === 1) return { x: 1204, y: 320 };
    if (screen === 2) return { x: W / 2, y: 60 };
    return { x: 76, y: 320 };
  }

  private drawWall(view: GameView, deal: { done: number } | null): void {
    const rr = view.wallRing;
    if (!rr) return;
    const ctx = this.ctx;
    const removed = this.computeRemoved(view, deal ? deal.done : null);

    // 新减少的牌 → 飞向对应玩家（发牌步骤定座位；行牌摸牌归当前回合者）
    if (this.prevRemoved !== null) {
      const steps = rr.recipe.steps;
      for (let slot = 0; slot < RING_SLOTS; slot++) {
        if (!removed[slot] || this.prevRemoved[slot]) continue;
        let seat = view.turn;
        if (deal) {
          for (let i = 0; i < Math.min(deal.done, steps.length); i++) {
            if (steps[i].slots.includes(slot)) {
              seat = steps[i].seat;
              break;
            }
          }
        } else if (rr.kongSlots.includes(slot) && view.ceremony?.kind === 'gang') {
          seat = view.ceremony.seat;
        }
        const seg = this.wallSegs(view).find((x) => x.r === this.segOfCol(slot >> 1));
        if (!seg) continue;
        const p = this.slotPos(seg, slot >> 1, slot & 1);
        const a = this.seatAnchor(view, seat);
        this.ghosts.push({
          x0: p.x + p.w / 2,
          y0: p.y + p.h / 2,
          x1: a.x,
          y1: a.y,
          t0: performance.now(),
        });
      }
    }
    this.prevRemoved = removed;

    const segs = this.wallSegs(view);
    // 墩槽阴影（加深：与桌布明确区分）
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    for (const seg of segs) {
      const span = this.segSpan(seg);
      if (seg.screen === 0) roundRect(ctx, seg.x0 - 6, 463, span + 12, 40, 7);
      else if (seg.screen === 2) roundRect(ctx, seg.x0 - 6, 119, span + 12, 40, 7);
      else if (seg.screen === 3) roundRect(ctx, 281, seg.y0 - 6, 40, span + 12, 7);
      else roundRect(ctx, 964, seg.y0 - 6, 40, span + 12, 7);
      ctx.fill();
    }

    // 墩（下层先画，上层叠放偏移）；正精原位翻面显示（翻精揭示后）
    const jingFaceSlot = this.jingWallSlot(view);
    for (const seg of segs) {
      for (let i = 0; i < seg.cols; i++) {
        const col = SEG_START[seg.r] + i;
        for (let layer = 0; layer < 2; layer++) {
          const slot = col * 2 + layer;
          if (removed[slot]) continue;
          const p = this.slotPos(seg, col, layer);
          const face = slot === jingFaceSlot ? view.jingPi! : -1;
          this.drawTile(face, p.x, p.y, p.w, p.h, view);
        }
      }
    }

    // 起牌墩：开局仪式期间金色呼吸提示
    if (view.ceremony?.kind === 'deal') {
      const col = rr.recipe.startCol;
      const seg = segs.find((x) => x.r === this.segOfCol(col));
      if (seg) {
        const p0 = this.slotPos(seg, col, 0);
        const p1 = this.slotPos(seg, col, 1);
        const x = Math.min(p0.x, p1.x) - 4;
        const y = Math.min(p0.y, p1.y) - 4;
        const w = Math.max(p0.x + p0.w, p1.x + p1.w) - x + 4;
        const h = Math.max(p0.y + p0.h, p1.y + p1.h) - y + 4;
        const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 240);
        ctx.strokeStyle = `rgba(230,193,75,${0.35 + 0.6 * pulse})`;
        ctx.lineWidth = 2;
        roundRect(ctx, x, y, w, h, 5);
        ctx.stroke();
      }
    }

    // 飞牌动画
    const now = performance.now();
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

  private riverOrigin(seat: number): { x: number; y: number; perRow: number; dx: number } {
    if (seat === 0) return { x: 458, y: 398, perRow: 14, dx: RIVER_W + 2 };
    if (seat === 2) return { x: 537, y: 156, perRow: 8, dx: RIVER_W + 2 };
    if (seat === 3) return { x: 334, y: 156, perRow: 7, dx: RIVER_W + 2 };
    return { x: 764, y: 156, perRow: 7, dx: RIVER_W + 2 };
  }

  private riverPos(seat: number, i: number): { x: number; y: number } {
    const o = this.riverOrigin(seat);
    const col = i % o.perRow;
    const row = Math.floor(i / o.perRow);
    return { x: o.x + col * o.dx, y: o.y + row * (RIVER_H + 2) };
  }

  private drawRivers(view: GameView): void {
    for (let s = 0; s < 4; s++) {
      const slot = this.disp(view, s);
      view.rivers[s].forEach((tile, i) => {
        const p = this.riverPos(slot, i);
        this.drawTile(tile, p.x, p.y, RIVER_W, RIVER_H, view);
      });
    }
  }

  private drawLastMarker(view: GameView): void {
    const { tile, from } = view.lastDiscard!;
    const river = view.rivers[from];
    const i = river.length - 1;
    if (i < 0 || river[i] !== tile) return;
    const p = this.riverPos(this.disp(view, from), i);
    const ctx = this.ctx;
    ctx.strokeStyle = '#e6c14b';
    ctx.lineWidth = 2;
    roundRect(ctx, p.x - 2, p.y - 2, RIVER_W + 4, RIVER_H + 4, 4);
    ctx.stroke();
  }

  /** 中央：东南西北罗盘（庄家高亮）+ 双骰点数 + 正/副精 + 牌墙剩余 */
  private drawCenter(view: GameView, deal: { done: number } | null): void {
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

    // 牌墙剩余（发牌仪式中按动画实时递减）
    let wallLeft = view.wallLeft;
    if (deal !== null) {
      const removed = this.computeRemoved(view, deal.done);
      wallLeft = RING_SLOTS - removed.filter(Boolean).length;
    }
    ctx.fillStyle = '#9db5a8';
    ctx.font = '12px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`牌墙 ${wallLeft}`, px + 12, py + 14);

    // 东南西北罗盘：四方位 = 四家（镜像视角），庄家金色高亮
    const winds: { seat: number; x: number; y: number }[] = [
      { seat: view.mySeat, x: 640, y: py + ph - 12 }, // 下
      { seat: (view.mySeat + 1) % 4, x: px + pw - 22, y: py + 66 }, // 右
      { seat: (view.mySeat + 2) % 4, x: 640, y: py + 14 }, // 上
      { seat: (view.mySeat + 3) % 4, x: px + 22, y: py + 66 }, // 左
    ];
    ctx.textAlign = 'center';
    for (const w of winds) {
      const isDealer = w.seat === view.dealer;
      if (isDealer) {
        roundRect(ctx, w.x - 14, w.y - 11, 28, 22, 6);
        ctx.fillStyle = '#e6c14b';
        ctx.fill();
        ctx.fillStyle = '#22200f';
        ctx.font = 'bold 15px "Microsoft YaHei", sans-serif';
      } else {
        ctx.fillStyle = '#b9cfc2';
        ctx.font = '14px "Microsoft YaHei", sans-serif';
      }
      ctx.fillText(this.wind(w.seat), w.x, w.y + 1);
    }

    // 双骰：未掷/翻滚中显示 ?，翻滚结束揭示；平时显示最近一次掷骰
    let shown: [number, number] | null = null;
    const c = view.ceremony;
    if (c && c.state === 'rolling' && c.dice) {
      shown = this.revealed(view) ? c.dice : null;
    } else if (!(c && c.state === 'wait-roll' && c.kind === 'deal')) {
      shown = view.lastDice ?? view.dealDice;
    }
    this.drawDieFace(603, 292, 32, shown ? shown[0] : null);
    this.drawDieFace(645, 292, 32, shown ? shown[1] : null);

    // 正精 / 副精：明牌摆在桌面上（翻精揭示后才出现）
    if (view.gz) {
      // 赣州（§3.6）：只画「明面正精」+「它对应的那张副精」；
      // 5 张隐藏正精 + 5 张隐藏副精一律不下发，结算时才揭晓
      const gzVis = view.gz.zheng.length > 0 && !(view.ceremony?.kind === 'jing' && !this.revealed(view));
      if (gzVis) {
        const hasFu = view.gz.fu.length > 0;
        this.drawTile(view.gz.zheng[0], 602, 330, 34, 42, view);
        if (hasFu) this.drawTile(view.gz.fu[0], 644, 330, 34, 42, view);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '10px "Microsoft YaHei", sans-serif';
        ctx.fillStyle = '#e0a86a'; // 正精 = 橙（与描边同色系）
        ctx.fillText('正精', 619, 381);
        if (hasFu) {
          ctx.fillStyle = '#b48ae0'; // 副精 = 紫
          ctx.fillText('副精', 661, 381);
        }
        if (!view.gz.revealed) {
          ctx.font = '11px "Microsoft YaHei", sans-serif';
          ctx.fillStyle = '#9db5a8';
          ctx.fillText('其余 10 张结算揭晓', 640, 400);
        }
      }
    } else {
      const jingOk =
        view.jingPi !== null &&
        view.jingFu !== null &&
        !(view.ceremony?.kind === 'jing' && !this.revealed(view));
      if (jingOk) {
        this.drawTile(view.jingPi!, 602, 330, 34, 42, view);
        this.drawTile(view.jingFu!, 644, 330, 34, 42, view);
      }
    }

    // 桌面正中的掷骰按钮（等待掷骰时）
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
        ctx.font = 'bold 17px "Microsoft YaHei", sans-serif';
        ctx.fillText(label, bx + bw / 2, by + bh / 2 + 1);
      } else {
        ctx.fillStyle = '#9db5a8';
        ctx.font = '13px "Microsoft YaHei", sans-serif';
        ctx.fillText(`等待${this.wind(c.seat)}家${label}…`, bx + bw / 2, by + bh / 2 + 1);
      }
      if (mine) this.rollBtn = { x: bx, y: by, w: bw, h: bh };
    }
  }

  /** 翻滚动画是否已到揭示时刻（与 DOM 骰子动画同拍）；非 rolling 视为已揭示 */
  private revealed(view: GameView): boolean {
    const c = view.ceremony;
    if (!c || c.state !== 'rolling' || c.rollAt === null || c.until === null) return true;
    const dur = Math.max(400, c.until - c.rollAt);
    const tumble = Math.min(c.kind === 'gang' ? 1500 : 2200, Math.floor(dur * 0.5));
    if (this.diceReveal?.key !== c.rollAt) {
      this.diceReveal = { key: c.rollAt, start: performance.now(), tumble };
    }
    return performance.now() - this.diceReveal.start >= this.diceReveal.tumble;
  }

  /** 牌墙上正精槽位（未翻 / 翻精揭示前返回 -1） */
  private jingWallSlot(view: GameView): number {
    if (view.jingSlot === null || view.jingPi === null) return -1;
    if (view.ceremony?.kind === 'jing' && !this.revealed(view)) return -1;
    return view.jingSlot;
  }

  /** 翻开的正精：立牌叠画在牌墙上——左右两边横放（牌面朝该边玩家）、上下竖放；
   * 宽与墙墩同（26）、高 38；不带光晕边框，仅留投影 */
  private drawJingHighlight(view: GameView): void {
    const slot = this.jingWallSlot(view);
    if (slot < 0 || !view.wallRing || view.jingPi === null) return;
    const seg = this.wallSegs(view).find((s) => s.r === this.segOfCol(slot >> 1));
    if (!seg) return;
    const p = this.slotPos(seg, slot >> 1, slot & 1);
    const jw = WALL_ACROSS; // 26
    const jh = 38;
    const cx = p.x + p.w / 2;
    const cy = p.y + p.h / 2;
    // 左右段旋转 90°：牌面“上”朝桌心（即朝该边玩家的视线正向）
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

  /** 中央骰子面（value=null → 显示 ? ） */
  private drawDieFace(x: number, y: number, size: number, value: number | null): void {
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
      ctx.font = `bold ${Math.floor(size * 0.5)}px "Microsoft YaHei", sans-serif`;
      ctx.fillText('?', x + size / 2, y + size / 2 + 1);
      return;
    }
    const PIP: Record<number, number[]> = {
      1: [4],
      2: [0, 8],
      3: [0, 4, 8],
      4: [0, 2, 6, 8],
      5: [0, 2, 4, 6, 8],
      6: [0, 2, 3, 5, 6, 8],
    };
    const cells = PIP[value] ?? [];
    const cs = size / 3;
    const pr = Math.max(3, size * 0.1);
    const red = value === 1 || value === 4;
    for (let i = 0; i < 9; i++) {
      if (!cells.includes(i)) continue;
      const cx = x + (i % 3) * cs + cs / 2;
      const cy = y + Math.floor(i / 3) * cs + cs / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, pr, 0, Math.PI * 2);
      ctx.fillStyle = red ? '#c62828' : '#1c1c2b';
      ctx.fill();
    }
  }

  private drawBacks(view: GameView, seat: number): void {
    const slot = this.disp(view, seat);
    const n = this.effCounts[seat];
    // 报杠（§8.5）：该座位已展示的三张明牌朝上（金框），其余仍是牌背
    const shown = view.declared.filter((d) => d.seat === seat).map((d) => d.tile);
    const cell = (i: number, x: number, y: number, w: number, h: number): void => {
      if (i < shown.length) {
        this.drawTile(shown[i], x, y, w, h, view);
        const ctx = this.ctx;
        ctx.strokeStyle = '#e6c14b';
        ctx.lineWidth = 2;
        roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 4);
        ctx.stroke();
      } else {
        this.drawTile(-1, x, y, w, h, view);
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

  /** 摊牌：亮出对手的暗牌（按镜像位次摆放） */
  private drawRevealHand(view: GameView, seat: number): void {
    const slot = this.disp(view, seat);
    const tiles = view.reveal?.[seat] ?? [];
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

  private meldWidth(m: Meld): number {
    return m.tiles.length * MELD_W;
  }

  private drawMelds(melds: Meld[], seat: number): void {
    if (melds.length === 0) return;
    if (seat === 0) {
      const gap = 14;
      const total = melds.reduce((a, m) => a + this.meldWidth(m), 0) + gap * (melds.length - 1);
      let x = 950 - total; // 避开右段牌墙（x≥968）
      for (const m of melds) {
        x = this.drawMeldRow(m, x, 502);
        x += gap;
      }
    } else if (seat === 2) {
      const gap = 14;
      const total = melds.reduce((a, m) => a + this.meldWidth(m), 0) + gap * (melds.length - 1);
      let x = 950 - total;
      for (const m of melds) {
        x = this.drawMeldRow(m, x, 80); // 上移：给上段牌墙（y≥126）让位
        x += gap;
      }
    } else if (seat === 3) {
      let y = 160;
      for (const m of melds) {
        this.drawMeldRow(m, 20, y); // 贴左缘：避开左段牌墙（x≥290）
        y += MELD_H + 4;
      }
    } else {
      let y = 160;
      for (const m of melds) {
        const w = this.meldWidth(m);
        this.drawMeldRow(m, 1260 - w, y); // 贴右缘：避开右段牌墙（x≤990）
        y += MELD_H + 4;
      }
    }
  }

  private drawMeldRow(m: Meld, x: number, y: number): number {
    m.tiles.forEach((t, i) => {
      const down = m.type === 'angang' && (i === 1 || i === 2);
      this.drawTile(down ? -1 : t, x + i * MELD_W, y, MELD_W, MELD_H, this.view!);
    });
    return x + m.tiles.length * MELD_W;
  }

  private drawTag(view: GameView, seat: number): void {
    const ctx = this.ctx;
    const slot = this.disp(view, seat);
    /**
     * 名牌贴在四个桌角，取「该玩家**自己左手边**的桌角」：
     * 下（自己）→ 左下、右（下家）→ 右下、上（对家）→ 右上、左（上家）→ 左上。
     * 玩家都朝向桌心，其左手方向即：下方朝上→屏幕左、右方朝左→屏幕下、
     * 上方朝下→屏幕右、左方朝右→屏幕上，故四角正好一一对应。
     * 这样名牌随视角镜像一起旋转，任一玩家看到自己那枚恒在左下角。
     */
    const TAG_W = 130;
    const TAG_H = 40;
    /** 四角统一内边距（与牌桌边框留出余量） */
    const INSET = 16;
    const pos: Record<number, [number, number]> = {
      0: [INSET, H - INSET - TAG_H], // 下（自己）：左下角
      1: [W - INSET - TAG_W, H - INSET - TAG_H], // 右（下家）：右下角
      2: [W - INSET - TAG_W, INSET], // 上（对家）：右上角
      3: [INSET, INSET], // 左（上家）：左上角
    };
    const [x, y] = pos[slot];
    const w = TAG_W;
    const h = TAG_H;
    // 记住位置：气泡要贴着自己铭牌长，点击铭牌也要能命中（见 drawBubbles / onClick）
    this.tagRects[slot] = { x, y, w, h };
    const isTurn = view.phase === 'playing' && view.turn === seat;
    const isWinner = view.phase === 'over' && view.winner === seat;
    const me = seat === view.mySeat;
    const dealer = seat === view.dealer;
    const offline = view.connected !== undefined && !view.connected[seat];
    // 托管标记：优先用服务端下发的 auto（机器人 / 手动托管 / 掉线）；旧服务端回退到连接状态
    const autoPlay = view.auto !== undefined ? view.auto[seat] === true : offline;

    roundRect(ctx, x, y, w, h, 6);
    ctx.fillStyle = isWinner ? 'rgba(230,193,75,0.3)' : 'rgba(0,0,0,0.4)';
    ctx.fill();
    ctx.strokeStyle = isWinner
      ? '#f6e3a1'
      : isTurn
        ? '#e6c14b'
        : me
          ? 'rgba(230,193,75,0.45)'
          : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = isWinner ? 3 : isTurn ? 2 : 1;
    ctx.stroke();

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // 庄家徽标（左侧）
    let tx = x + 10;
    if (dealer) {
      roundRect(ctx, x + 8, y + 5, 20, 17, 4);
      ctx.fillStyle = '#e6c14b';
      ctx.fill();
      ctx.fillStyle = '#22200f';
      ctx.font = 'bold 11px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('庄', x + 18, y + 14);
      ctx.textAlign = 'left';
      tx = x + 33;
    }
    // 上宝倍数徽标（庄家徽标之后）：打出明面正精/副精累计，胡牌分按它翻倍
    const bao = (view as { bao?: number[] }).bao?.[seat] ?? 1;
    if (bao > 1) {
      roundRect(ctx, tx, y + 5, 36, 17, 4);
      ctx.fillStyle = '#c3603d';
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(`宝×${bao}`, tx + 18, y + 14);
      ctx.textAlign = 'left';
      ctx.font = '11px "Microsoft YaHei", sans-serif';
      tx += 40;
    }

    // 第一行：风位 · 昵称
    const rawName = (view.names && view.names[seat]) || this.wind(seat);
    const short =
      rawName.length > (me ? 4 : 5) ? rawName.slice(0, me ? 4 : 5) + '…' : rawName;
    ctx.font = '11px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = isWinner ? '#ffe9a8' : isTurn ? '#e6c14b' : '#e8efe9';
    ctx.fillText(`${this.wind(seat)}·${short}${me ? '·我' : ''}`, tx, y + 14);

    // 第二行：状态（左）+ 累计积分（右，昵称旁的身份卡位置）
    ctx.font = '12px "Microsoft YaHei", sans-serif';
    if (isWinner) {
      ctx.fillStyle = '#ffe9a8';
      ctx.font = 'bold 13px "Microsoft YaHei", sans-serif';
      ctx.fillText('胡牌！', tx, y + 31);
      ctx.font = '12px "Microsoft YaHei", sans-serif';
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
    ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
    ctx.fillStyle = tv > 0 ? '#43c07c' : tv < 0 ? '#e07a6a' : '#9db5a8';
    ctx.fillText(tv > 0 ? `+${tv}` : `${tv}`, x + w - 10, y + 31);
  }

  // ---------- 互动表情与铭牌气泡 ----------

  /** 铭牌内容气泡：文字挂**发送者**铭牌、互动表情挂**目标**铭牌，数秒后自动淡出 */
  pushBubble(seat: number, content: string, kind: 'text' | 'emote'): void {
    const text = content.trim();
    if (!text || seat < 0 || seat > 3) return;
    // 同一家只留最新一条，避免多条叠在一起糊住四角
    this.bubbles = this.bubbles.filter((b) => b.seat !== seat);
    this.bubbles.push({ seat, content: text, kind, t0: performance.now() });
    this.scheduleFrame();
  }

  /** 互动表情：从 from 飞向 target 并在目标处溅射（每个客户端各播一次，人人可见） */
  pushEmote(from: number, target: number, icon: string): void {
    if (!icon) return;
    this.emoteFx.push({ from, target, icon, t0: performance.now() });
    this.scheduleFrame();
  }

  /** 按像素宽度折行；超出 maxLines 时末行加省略号 */
  private wrapText(text: string, maxW: number, maxLines: number): string[] {
    const ctx = this.ctx;
    const chars = Array.from(text);
    const lines: string[] = [];
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

  /** 铭牌气泡：贴着四角铭牌朝**画布内侧**生长，并夹在画布内（绝不越界） */
  private drawBubbles(): void {
    const view = this.view;
    const now = performance.now();
    this.bubbles = this.bubbles.filter((b) => now - b.t0 < BUBBLE_MS);
    if (!view || this.bubbles.length === 0) return;
    const ctx = this.ctx;
    for (const b of this.bubbles) {
      const slot = this.disp(view, b.seat);
      const tag = this.tagRects[slot];
      if (!tag) continue;
      const wide = slot === 2 || slot === 3; // 上排铭牌下方是空地，可放宽
      const maxW = wide ? BUBBLE_W_WIDE : BUBBLE_W_NARROW;
      const emote = b.kind === 'emote';
      ctx.font = emote
        ? `bold 14px "Microsoft YaHei", ${EMOJI_FONT}`
        : '12px "Microsoft YaHei", sans-serif';
      const lines = this.wrapText(b.content, maxW - 18, BUBBLE_MAX_LINES);
      if (lines.length === 0) continue;
      const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const w = Math.min(maxW, Math.ceil(textW) + 18);
      const h = lines.length * BUBBLE_LINE_H + 12;
      const leftSide = slot === 0 || slot === 3; // 铭牌在画布左半边 → 气泡左对齐
      const up = slot === 0 || slot === 1; // 下排铭牌 → 气泡往上长
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
      // 指向铭牌的小尖角
      const tailX = leftSide ? tag.x + 20 : tag.x + tag.w - 20;
      ctx.beginPath();
      ctx.moveTo(tailX - 6, up ? y + h : y);
      ctx.lineTo(tailX + 6, up ? y + h : y);
      ctx.lineTo(tailX, up ? y + h + 7 : y - 7);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();
      // 正文
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = emote ? '#ffe9a8' : '#e8efe9';
      lines.forEach((l, i) => ctx.fillText(l, x + 9, y + 6 + BUBBLE_LINE_H * i + BUBBLE_LINE_H / 2));
      ctx.globalAlpha = 1;
    }
  }

  /** 吃碰胡杠中心动画：牌桌中央大字弹出 + 淡入淡出 */
  private drawActionFx(): void {
    const fx = this.actionFx;
    if (!fx) return;
    const now = performance.now();
    const age = now - fx.t0;
    const DUR = 1200;
    if (age >= DUR) {
      this.actionFx = null;
      return;
    }
    const ctx = this.ctx;
    const t = age / DUR;
    // 透明度：前 15% 淡入，后 25% 淡出
    const alpha = t < 0.15 ? t / 0.15 : t > 0.75 ? 1 - (t - 0.75) / 0.25 : 1;
    // 缩放：前 20% 从 0.5 弹到 1.15，之后缓降到 1.0
    const scale = t < 0.2 ? 0.5 + 0.65 * (t / 0.2) : 1.15 - 0.15 * ((t - 0.2) / 0.8);
    // 文字与配色
    const conf: Record<string, { label: string; color: string; bg: string }> = {
      chi: { label: '吃', color: '#81c784', bg: 'rgba(76,175,80,0.25)' },
      peng: { label: '碰', color: '#64b5f6', bg: 'rgba(33,150,243,0.25)' },
      gang: { label: '杠', color: '#ffb74d', bg: 'rgba(255,152,0,0.25)' },
      angang: { label: '暗杠', color: '#ffb74d', bg: 'rgba(255,152,0,0.25)' },
      bugang: { label: '补杠', color: '#ffb74d', bg: 'rgba(255,152,0,0.25)' },
      hu: { label: '胡', color: '#ef9a9a', bg: 'rgba(229,72,77,0.3)' },
    };
    const c = conf[fx.kind] ?? { label: fx.kind, color: '#fff', bg: 'rgba(0,0,0,0.3)' };
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(640, 300);
    ctx.scale(scale, scale);
    // 背景圆角矩形
    const w = 120;
    const h = 70;
    roundRect(ctx, -w / 2, -h / 2, w, h, 14);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();
    ctx.strokeStyle = c.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    // 文字
    ctx.fillStyle = c.color;
    ctx.font = 'bold 42px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(c.label, 0, 2);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** 互动表情动画：飞行段 → 命中溅射 + 目标铭牌闪边 */
  private drawEmoteFx(): void {
    const view = this.view;
    const now = performance.now();
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
        // 飞行段：抛物线 + 自旋，从扔的人飞到目标
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
        // 命中段：放大回弹 + 溅射环 + 淡出
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
        // 目标铭牌闪金边（绝对坐标画，避免被上面的 scale 影响）
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

  /** 赢家手牌区域（摊牌高亮用）：自己用 handRect，其余按镜像位次与摊牌布局推算 */
  private winnerRect(view: GameView): { x: number; y: number; w: number; h: number } | null {
    const seat = view.winner;
    if (seat === null || view.phase !== 'over') return null;
    const slot = this.disp(view, seat);
    if (slot === 0) return this.handRect; // 自己那手由 drawMyHand 画，已有占位
    const n = (view.reveal?.[seat] ?? []).length;
    if (n === 0) return null;
    if (slot === 2) {
      const total = n * 30 - 2; // 摊牌横排：pitch 30、宽 28
      return { x: (W - total) / 2 - 5, y: 49, w: total + 10, h: 46 };
    }
    const total = n * 34 - 2; // 摊牌竖排：pitch 34、宽 28
    const x = slot === 3 ? 155 : 1087;
    return { x, y: 155, w: 38, h: total + 10 };
  }

  /** 摊牌：赢家手牌区金色发光框（最直接的「谁胡了」视觉定位） */
  private drawWinnerHighlight(view: GameView): void {
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

  /** 摊牌：画布顶部横幅点名赢家 + 牌型（最醒目的标识） */
  private drawResultBanner(view: GameView): void {
    const seat = view.winner;
    if (seat === null || view.phase !== 'over') return;
    const name = (view.names && view.names[seat]) || this.wind(seat);
    const main = `${this.wind(seat)}·${name} 胡`;
    const sub = view.result ?? '';
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
    ctx.font = 'bold 19px "Microsoft YaHei", sans-serif';
    ctx.fillText(main, W / 2, by + 16);
    if (sub) {
      ctx.fillStyle = 'rgba(34,32,15,0.78)';
      ctx.font = '12px "Microsoft YaHei", sans-serif';
      ctx.fillText(sub, W / 2, by + 34);
    }
  }

  /** 出牌光标：轮到谁，就在其牌列上画呼吸金框 + 箭头选中特效 */
  private drawTurnCursor(view: GameView): void {
    if (this.dealing || view.phase !== 'playing' || view.claimWindow) return;
    const seat = view.turn;
    const slot = this.disp(view, seat);
    let rect: { x: number; y: number; w: number; h: number } | null = null;
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
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 280);
    ctx.save();
    // 呼吸金框（盖在牌上）
    ctx.strokeStyle = `rgba(230, 193, 75, ${0.35 + 0.55 * pulse})`;
    ctx.lineWidth = 3;
    roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 8);
    ctx.stroke();

    // 箭头光标（置于牌面靠近桌面中心的一侧，微微呼吸浮动）
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

  private drawMyHand(view: GameView, myTiles: Tile[], drawn: Tile | null): void {
    let rest = myTiles;
    if (drawn !== null) {
      const idx = rest.indexOf(drawn);
      if (idx >= 0) rest = [...rest.slice(0, idx), ...rest.slice(idx + 1)];
    }

    const n = rest.length + (drawn !== null ? 1 : 0);
    if (n === 0) {
      this.handRect = null;
      return;
    }
    const total = n * HAND_PITCH - (HAND_PITCH - HAND_W) + (drawn !== null ? DRAWN_GAP : 0);
    const startX = (W - total) / 2;
    const topY = drawn !== null ? HAND_Y - DRAWN_RAISE : HAND_Y;
    this.handRect = { x: startX - 4, y: topY - 4, w: total + 8, h: HAND_H + 8 + (drawn !== null ? DRAWN_RAISE : 0) };

    // 出牌后：上一帧的“新牌”归位动画
    if (
      this.prevDrawn !== null &&
      drawn === null &&
      this.prevHandLen === myTiles.length + 1 &&
      this.prevDrawnX > 0
    ) {
      const target = myTiles.indexOf(this.prevDrawn);
      if (target >= 0) {
        this.anim = {
          tile: this.prevDrawn,
          from: this.prevDrawnX,
          to: startX + target * HAND_PITCH,
          start: performance.now(),
        };
      }
    }

    let skipped = false;
    rest.forEach((t, i) => {
      if (this.anim && !skipped && t === this.anim.tile) {
        skipped = true; // 动画中的那张单独画
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
      const k = Math.min(1, (performance.now() - this.anim.start) / ANIM_MS);
      const x = this.anim.from + (this.anim.to - this.anim.from) * k;
      const y = HAND_Y - DRAWN_RAISE * (1 - k);
      this.drawTile(this.anim.tile, x, y, HAND_W, HAND_H, view);
      this.markDeclare(view, this.anim.tile, x, y);
      this.hits.push({ tile: this.anim.tile, x, y });
      if (k >= 1) this.anim = null;
      else this.scheduleFrame();
    }

    // 记录本帧状态（供下一帧触发动画）
    this.prevDrawn = drawn;
    this.prevHandLen = myTiles.length;
    if (drawn !== null) this.prevDrawnX = drawnX;

    if (this.canDiscard) {
      const ctx = this.ctx;
      ctx.fillStyle = 'rgba(230,193,75,0.9)';
      ctx.font = '12px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(
        view.mustDiscard.length
          ? `必须先打出 ${view.mustDiscard.map((t) => tileName(t)).join('、')}`
          : '点击手牌打出',
        W / 2,
        HAND_Y - 10,
      );
    }
  }

  /**
   * 报杠（§8.5）手牌标记：自己已展示（冻结）的三张金框 + 「展」字；
   * 被他人强制要打的牌面红框。精牌描边优先级更高（jingBorder 后画）。
   */
  private markDeclare(view: GameView, t: Tile, x: number, y: number): void {
    const frozen = view.declared.some((d) => d.seat === view.mySeat && d.tile === t);
    const must = view.mustDiscard.includes(t);
    if (!frozen && !must) return;
    const ctx = this.ctx;
    ctx.strokeStyle = frozen ? '#e6c14b' : '#e05a4a';
    ctx.lineWidth = 2;
    roundRect(ctx, x - 1, y - 1, HAND_W + 2, HAND_H + 2, 5);
    ctx.stroke();
    if (frozen) {
      ctx.fillStyle = '#e6c14b';
      ctx.font = 'bold 11px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('展', x + 3, y + 8);
    }
  }

  /** 摸到的新牌：抬起 + 金框 + 「新」标记 */
  private drawDrawn(t: Tile, x: number, view: GameView): void {
    const y = HAND_Y - DRAWN_RAISE;
    this.drawTile(t, x, y, HAND_W, HAND_H, view);
    this.markDeclare(view, t, x, y);
    const ctx = this.ctx;
    ctx.strokeStyle = '#e6c14b';
    ctx.lineWidth = 2;
    roundRect(ctx, x - 1, y - 1, HAND_W + 2, HAND_H + 2, 5);
    ctx.stroke();
    ctx.fillStyle = '#e6c14b';
    ctx.font = 'bold 11px "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('新', x + HAND_W + 4, y + 8);
  }

  private scheduleFrame(): void {
    if (this.rafQueued) return;
    this.rafQueued = true;
    requestAnimationFrame(() => {
      this.rafQueued = false;
      if (this.lastRendered) this.render(this.lastRendered);
    });
  }

  // ---------- 牌面 ----------

  /** 精牌描边：橙红/紫 + 光晕——与金色「新牌 / 刚出的牌」标记明确区分（贴图与文字牌面共用） */
  private jingBorder(x: number, y: number, w: number, h: number, r: number, isPi: boolean): void {
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

  private drawTile(
    t: Tile,
    x: number,
    y: number,
    w: number,
    h: number,
    view: GameView,
    noGlow = false,
  ): void {
    const ctx = this.ctx;
    const r = Math.max(3, Math.floor(w * 0.12));
    if (t < 0) {
      // 牌背（提亮：与深绿桌布拉开对比）
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
      // 顶部受光
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      roundRect(ctx, x + 2, y + 2, Math.max(2, w - 4), Math.max(2, (h - 4) * 0.35), Math.max(2, r - 2));
      ctx.fill();
      return;
    }

    // 赣州：**已公开**的正精 / 副精全部描边（未揭晓时各 1 张，结算时 12 张全亮）——橙=正精、紫=副精
    const isPi = view.jingPi === t || (view.gz?.zheng.includes(t) ?? false);
    const isFu = view.jingFu === t || (view.gz?.fu.includes(t) ?? false);

    // 实物牌面贴图：圆角裁切 + 等比铺满（居中裁边）
    const art = tileArt(t);
    if (art) {
      ctx.save();
      roundRect(ctx, x, y, w, h, r);
      ctx.clip();
      const sw = art.naturalWidth;
      const sh = art.naturalHeight;
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

    // —— 贴图未就绪时的文字牌面（回退）——
    roundRect(ctx, x, y, w, h, r);
    ctx.fillStyle = '#f6f2e7';
    ctx.fill();
    // 底部厚度
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
      ctx.font = `bold ${Math.floor(h * 0.4)}px "Microsoft YaHei", sans-serif`;
      ctx.fillText(rank, cx, y + h * 0.33);
      ctx.fillStyle = SUIT_COLOR[suit];
      ctx.font = `bold ${Math.floor(h * 0.32)}px "Microsoft YaHei", sans-serif`;
      ctx.fillText(SUIT_CHAR[suit], cx, y + h * 0.68);
    } else if (t === 33) {
      // 白：空框
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
      ctx.font = `bold ${Math.floor(h * 0.5)}px "Microsoft YaHei", sans-serif`;
      ctx.fillText(ch, cx, y + h / 2 + 1);
    }
  }
}
