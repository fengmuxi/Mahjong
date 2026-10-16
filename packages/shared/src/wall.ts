/** 牌墙环：136 张 = 68 墩 × 上下两层，绕桌码 4 段（环序 = **顺时针**行走）。
 *
 * 环段 0 = 庄门前（长段 20 墩）、1 = 庄的下家门前（短段 14 墩）、
 * 2 = 对家门前（长段 20 墩）、3 = 庄的上家门前（短段 14 墩）。
 * 槽位 slot = col * 2 + layer（layer 0 = 下层、1 = 上层）。
 * **列数与行进方向均为顺时针**（下沿右→左、左沿下→上、上沿左→右、右沿上→下）；
 * 数座位按两骰之和（庄起逆时针循环），数列（小点数）为顺时针。
 */

export const SEG_LEN = [20, 14, 20, 14];
/** 环段 id → 列区间起点；行走序 = seg0 → seg3 → seg2 → seg1（顺时针）故起点为 [0,54,34,20] */
export const SEG_START = [0, 54, 34, 20];
export const RING_COLS = 68;
export const RING_SLOTS = 136;

export interface DealStep {
  seat: number;
  /** 本步从牌墙取走的槽位 */
  slots: number[];
  /** grab = 抓 2 墩 4 张；jump = 庄跳子；solo = 闲家补 1 张 */
  kind: 'grab' | 'jump' | 'solo';
}

export interface DealRecipe {
  dice: [number, number];
  big: number;
  small: number;
  /** 起牌槽位（段内小点数所指墩的下层） */
  startSlot: number;
  startCol: number;
  steps: DealStep[];
  /** 发牌结束后的牌墙前端（下一张可摸的槽位） */
  endSlot: number;
}

/** 发牌轮转顺序：顺时针 = 庄 → 上家 → 对家 → 下家 */
export function dealOrder(dealer: number): number[] {
  return [dealer, (dealer + 3) % 4, (dealer + 2) % 4, (dealer + 1) % 4];
}

/** 由两骰点数生成完整发牌配方：
 * **两骰之和 S** → 从庄起**逆时针**数到的座位（庄=1，循环：S≡1→庄、S≡2→下家…）；
 * 小点数 → 在该座位门前**顺时针空出小点数列**、从下一列开始抓牌
 * （例 4、1 → 和 5≡1 → 庄家门前，空 1 列、第 2 列起牌） */
export function buildRecipe(dealer: number, dice: [number, number]): DealRecipe {
  const [d1, d2] = dice;
  const sum = d1 + d2;
  const big = Math.max(d1, d2); // 仅保留在配方里（展示/诊断用）
  const small = Math.min(d1, d2);
  const seg = (sum - 1) % 4;
  const startCol = SEG_START[seg] + small; // 空出 small 列 → 第 small+1 列
  const startSlot = startCol * 2;

  const removed = new Array<boolean>(RING_SLOTS).fill(false);
  const steps: DealStep[] = [];
  const nextAvail = (from: number): number => {
    for (let i = 0; i < RING_SLOTS; i++) {
      const s = (from + i) % RING_SLOTS;
      if (!removed[s]) return s;
    }
    return -1;
  };

  // 3 轮 × 每次 2 墩（上下两层 = 4 张），顺时针轮转
  let col = startCol;
  for (let r = 0; r < 3; r++) {
    for (const seat of dealOrder(dealer)) {
      const c1 = col % RING_COLS;
      const c2 = (col + 1) % RING_COLS;
      const slots = [c1 * 2, c1 * 2 + 1, c2 * 2, c2 * 2 + 1];
      for (const s of slots) removed[s] = true;
      steps.push({ seat, slots, kind: 'grab' });
      col = (col + 2) % RING_COLS;
    }
  }

  // 庄跳子：上面一层隔一墩取 2 张（庄共 14 张）
  const jc = col % RING_COLS;
  const jSlots = [jc * 2 + 1, ((jc + 2) % RING_COLS) * 2 + 1];
  for (const s of jSlots) removed[s] = true;
  steps.push({ seat: dealer, slots: jSlots, kind: 'jump' });

  // 闲家按顺时针各补 1 张（从跳子墩继续逆时针找可用槽）
  let scan = jc * 2;
  for (const seat of [(dealer + 3) % 4, (dealer + 2) % 4, (dealer + 1) % 4]) {
    const s = nextAvail(scan);
    removed[s] = true;
    steps.push({ seat, slots: [s], kind: 'solo' });
    scan = s + 1;
  }

  return { dice: [d1, d2], big, small, startSlot, startCol, steps, endSlot: nextAvail(scan) };
}

/** 牌墙环运行态：槽位移除表 + 牌墙前端游标（服务端与客户端共用同一套推进逻辑） */
export class WallRing {
  readonly removed: boolean[];
  front: number;
  /** 起牌列（摸牌处）——翻精/杠骰和数逆时针定位的锚点 */
  readonly startCol: number;
  /** 按骰子定位取走的槽位（杠补） */
  kongSlots: number[] = [];

  constructor(recipe: DealRecipe) {
    this.removed = new Array<boolean>(RING_SLOTS).fill(false);
    for (const step of recipe.steps) for (const s of step.slots) this.removed[s] = true;
    this.front = recipe.endSlot;
    this.startCol = recipe.startCol;
  }

  nextAvail(from: number): number {
    for (let i = 0; i < RING_SLOTS; i++) {
      const s = (from + i) % RING_SLOTS;
      if (!this.removed[s]) return s;
    }
    return -1;
  }

  /** 行牌摸牌：取牌墙前端一张 */
  takeFront(): number {
    const s = this.nextAvail(this.front);
    if (s < 0) return -1;
    this.removed[s] = true;
    this.front = (s + 1) % RING_SLOTS;
    return s;
  }

  /** 牌尾取一张（掷骰关的补杠 = 摸倒数第一张） */
  takeTail(): number {
    for (let i = 1; i <= RING_SLOTS; i++) {
      const s = (((this.front - i) % RING_SLOTS) + RING_SLOTS) % RING_SLOTS;
      if (!this.removed[s]) {
        this.removed[s] = true;
        return s;
      }
    }
    return -1;
  }

  /** 按骰子定位（翻精与杠补同一规则）：两骰和 S，从摸牌处（起牌列）**逆时针**数 S 列。
   * 摸牌处那一墩已被抓走——从它逆时针方向**第一个完整墩起为第 1 列**，目标 = 摸牌处 − S 列；
   * 上层在取上层，上层已取则取下层，整墩空则继续逆时针。返回槽位（不移除）；无可用返回 -1。 */
  locate(dice: [number, number]): number {
    const sum = dice[0] + dice[1];
    const col0 = (((this.startCol - sum) % RING_COLS) + RING_COLS) % RING_COLS;
    for (let k = 0; k < RING_COLS; k++) {
      const c = (((col0 - k) % RING_COLS) + RING_COLS) % RING_COLS;
      if (!this.removed[c * 2 + 1]) return c * 2 + 1;
      if (!this.removed[c * 2]) return c * 2;
    }
    return -1;
  }

  remove(slot: number): void {
    if (slot < 0 || this.removed[slot]) return;
    this.removed[slot] = true;
    this.kongSlots.push(slot);
  }

  /** 槽位在牌墙数组（从前端起的可用槽序）中的下标；未找到返回 -1 */
  indexOfFromFront(slot: number): number {
    if (this.removed[slot]) return -1;
    let n = 0;
    for (let i = 0; i < RING_SLOTS; i++) {
      const s = (this.front + i) % RING_SLOTS;
      if (s === slot) return n;
      if (!this.removed[s]) n++;
    }
    return -1;
  }
}
