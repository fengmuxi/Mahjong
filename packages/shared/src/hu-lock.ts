/**
 * 胡牌锁（一炮一响的承载结构）—— 南昌麻将 / 赣州冲关共用，规则见 `docs/rules/nanchang.md` §5.1。
 *
 * 一次出牌（或一次补杠抢杠）只对应**一把锁**，锁绑定在那一张「点炮牌」上：
 * 同一张牌最多一名玩家能胡。关键口径是**不按点击先后**，而按
 * 「从庄家起的座位顺序」（庄 → 下家 → 对家 → 上家）依次尝试加锁——
 * 后到但优先级更高的座位可以**抢占**锁，被抢占者即被限制为「不能胡同一张牌」。
 *
 * 生命周期：
 *   窗口开启（`discard` / `openRobWindow`）→ `new HuLock(tile, from, dealer)`
 *   → 每次有人点「胡」调一次 `attempt(seat)`（登记 / 抢占 / 被排除）
 *   → 窗口收齐或超时后 `finalize()` 定锁（幂等），此后 `attempt()` 一律返回 `'closed'`
 */
import type { Tile } from './index.ts';
import { huPriority } from './resolver.ts';

/** 一次加锁尝试的结果 */
export type HuLockAttempt =
  /** 登记为暂定持有者（窗口内第一个点胡者） */
  | 'tentative'
  /** 抢占成功：比先前的暂定持有者更靠前（不按点击先后） */
  | 'preempted'
  /** 被更靠前的座位锁定 → **本张牌不能胡**（本次请求仍登记，用于回执） */
  | 'denied'
  /** 重复请求：本次窗口内该座位已点过胡 */
  | 'duplicate'
  /** 窗口已结束（并发点胡里后到的请求，锁已终局） */
  | 'closed';

/** 锁终局结果（供结算播报与「不能胡同一张牌」回执） */
export interface HuLockOutcome {
  /** 被争夺的点炮牌（抢杠窗口为被抢的杠牌） */
  tile: Tile;
  /** 出牌者 / 杠者 */
  from: number;
  /** 最终赢家（无人点胡则为 null） */
  winner: number | null;
  /** 按到达顺序的全部胡牌请求 */
  attempts: number[];
  /** 被锁排除、不得胡同一张牌的座位 */
  denied: number[];
}

export class HuLock {
  readonly tile: Tile;
  readonly from: number;
  readonly dealer: number;
  /** 暂定 / 最终持有者；null = 尚无人点胡 */
  holder: number | null = null;
  /** 是否已终局（窗口收齐或超时后置位） */
  granted = false;
  /** 按到达顺序记录的胡牌请求 */
  readonly attempts: number[] = [];
  /** 被排除的座位（有资格点胡但没抢到锁） */
  readonly denied: number[] = [];

  constructor(tile: Tile, from: number, dealer: number) {
    this.tile = tile;
    this.from = from;
    this.dealer = dealer;
  }

  /**
   * 某座位尝试加锁。
   * 优先级取 `huPriority`（从庄家起的座位顺序）；持有者只可能被**更靠前**的座位抢占，
   * 因此 `finalize()` 时 `holder` 恒为全部请求中优先级最高者，与 `resolveClaim` 的胡裁决一致。
   */
  attempt(seat: number): HuLockAttempt {
    if (this.granted) return 'closed';
    if (this.attempts.includes(seat)) return 'duplicate';
    this.attempts.push(seat);
    if (this.holder === null) {
      this.holder = seat;
      return 'tentative';
    }
    if (huPriority(seat, this.dealer) < huPriority(this.holder, this.dealer)) {
      this.denied.push(this.holder); // 原暂定持有者被抢占 → 本张牌不能再胡
      this.holder = seat;
      return 'preempted';
    }
    this.denied.push(seat);
    return 'denied';
  }

  /** 窗口收齐（或超时）→ 定锁。幂等，可重复调用（重复调用返回同一结果）。 */
  finalize(): HuLockOutcome {
    this.granted = true;
    return {
      tile: this.tile,
      from: this.from,
      winner: this.holder,
      attempts: [...this.attempts],
      denied: [...this.denied],
    };
  }

  /** 窗口未结束时，当前持有者是否已确定（窗口仍在等其他人应答） */
  get pendingHolder(): number | null {
    return this.granted ? null : this.holder;
  }
}
