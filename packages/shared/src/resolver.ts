import type { ClaimKind } from './index.ts';

export interface ClaimRequest {
  seat: number;
  kind: ClaimKind;
  chiTiles?: number[];
}

/** 优先级：胡 > 杠 > 碰 > 吃 */
const PRIORITY: Record<ClaimKind, number> = { hu: -1, chi: 2, peng: 1, gang: 0 };

/**
 * 座位优先级：**从庄家起的座位顺序**（庄 → 下家 → 对家 → 上家），越小越优先。
 * 胡牌锁（`hu-lock.ts`）与窗口裁决（`resolveClaim`）共用这一个顺序基准，保证两者永不分叉。
 */
export function huPriority(seat: number, dealer: number): number {
  return (seat - dealer + 4) % 4;
}

/**
 * 裁决一个响应窗口内的全部应答（规则 §5 / §5.1：一炮只一响，按庄位顺序）：
 * - **胡请求之间**按 `huPriority`（从庄家起的座位顺序）取**第一个**——
 *   同一张牌多人可胡时等齐应答后由前者胡，前面的不胡（过 / 超时 / 被锁排除）才轮到后面；
 * - 胡整体优先于杠 / 碰 / 吃；杠 / 碰 / 吃之间仍按优先级 + 距离出牌者最近者。
 */
export function resolveClaim(
  from: number,
  dealer: number,
  claims: ClaimRequest[],
): ClaimRequest | null {
  if (claims.length === 0) return null;
  const hus = claims.filter((c) => c.kind === 'hu');
  if (hus.length > 0) {
    return [...hus].sort(
      (a, b) => huPriority(a.seat, dealer) - huPriority(b.seat, dealer),
    )[0];
  }
  const dist = (s: number) => (s - from + 4) % 4;
  return [...claims].sort(
    (a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || dist(a.seat) - dist(b.seat),
  )[0];
}
