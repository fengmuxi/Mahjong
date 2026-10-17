"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HuLock = void 0;
const resolver_1 = require("./resolver");
class HuLock {
    constructor(tile, from, dealer) {
        /** 暂定 / 最终持有者；null = 尚无人点胡 */
        this.holder = null;
        /** 是否已终局（窗口收齐或超时后置位） */
        this.granted = false;
        /** 按到达顺序记录的胡牌请求 */
        this.attempts = [];
        /** 被排除的座位（有资格点胡但没抢到锁） */
        this.denied = [];
        this.tile = tile;
        this.from = from;
        this.dealer = dealer;
    }
    /**
     * 某座位尝试加锁。
     * 优先级取 `huPriority`（从庄家起的座位顺序）；持有者只可能被**更靠前**的座位抢占，
     * 因此 `finalize()` 时 `holder` 恒为全部请求中优先级最高者，与 `resolveClaim` 的胡裁决一致。
     */
    attempt(seat) {
        if (this.granted)
            return 'closed';
        if (this.attempts.includes(seat))
            return 'duplicate';
        this.attempts.push(seat);
        if (this.holder === null) {
            this.holder = seat;
            return 'tentative';
        }
        if ((0, resolver_1.huPriority)(seat, this.dealer) < (0, resolver_1.huPriority)(this.holder, this.dealer)) {
            this.denied.push(this.holder); // 原暂定持有者被抢占 → 本张牌不能再胡
            this.holder = seat;
            return 'preempted';
        }
        this.denied.push(seat);
        return 'denied';
    }
    /** 窗口收齐（或超时）→ 定锁。幂等，可重复调用（重复调用返回同一结果）。 */
    finalize() {
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
    get pendingHolder() {
        return this.granted ? null : this.holder;
    }
}
exports.HuLock = HuLock;
