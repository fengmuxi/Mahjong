"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.WIND_NAMES = exports.DRAGONS = exports.WINDS = void 0;
exports.windName = windName;
exports.seatWind = seatWind;
exports.suitOf = suitOf;
exports.rankOf = rankOf;
exports.tileName = tileName;
exports.nextJing = nextJing;
exports.fullDeck = fullDeck;
exports.sortTiles = sortTiles;
exports.tileCounts = tileCounts;
exports.chiOptions = chiOptions;
exports.WINDS = [27, 28, 29, 30]; // 东南西北
exports.DRAGONS = [31, 32, 33]; // 中发白
/** 座位 → 风位显示（0东 1南 2西 3北）——**座位基准映射**，仅作兜底；实际显示见 `seatWind` */
exports.WIND_NAMES = ['东', '南', '西', '北'];
/** 座位基准风位（0东 1南 2西 3北）。只用于「还没有庄家」时的兜底文案。 */
function windName(seat) {
    return exports.WIND_NAMES[((seat % 4) + 4) % 4];
}
/**
 * 座位在某局庄家下的风位：**庄家恒为东**，其余按座位顺序顺延（南 / 西 / 北）。
 *
 * 本玩法采用「**风位随庄**」——风位不是贴在座位上的固定标签，而是跟着庄家转：
 * 庄轮转到谁，谁就是东。**牌桌上一切风位显示（名牌、罗盘、播报、结算）都必须走这里**，
 * 只有 `windName()` 那种与庄无关的兜底文案才用座位基准映射。
 */
function seatWind(seat, dealer) {
    return exports.WIND_NAMES[(((seat - dealer) % 4) + 4) % 4];
}
const ZH = ['东', '南', '西', '北', '中', '发', '白'];
function suitOf(t) {
    if (t < 9)
        return 'm';
    if (t < 18)
        return 's';
    if (t < 27)
        return 'p';
    return 'z';
}
function rankOf(t) {
    return t < 27 ? (t % 9) + 1 : t - 27;
}
function tileName(t) {
    if (t < 27) {
        const suit = suitOf(t) === 'm' ? '万' : suitOf(t) === 's' ? '条' : '筒';
        return `${rankOf(t)}${suit}`;
    }
    return ZH[t - 27];
}
/**
 * 副精 / 下精 = 正精在本组内的下一张（分组独立循环，组间不跨越）。
 *
 * 这是**副精推导的唯一实现**，南昌与赣州共用（赣州经 `gzjing.ts` 的 `gzFuOf` 转出）：
 * 一万 → 二万；九万 → 一万；东→南→西→北→东；中→发→白→中。
 * ⚠️ 只看**牌面序数**，与牌墙位置 / 取牌顺序无关（赣州 2026-10-16 修订口径，§3.4）。
 */
function nextJing(t) {
    if (t < 27) {
        const base = Math.floor(t / 9) * 9;
        return base + (t % 9 === 8 ? 0 : (t % 9) + 1);
    }
    if (t <= 30)
        return t === 30 ? 27 : t + 1; // 北 → 东
    return t === 33 ? 31 : t + 1; // 白 → 中
}
/** 136 张牌（未洗） */
function fullDeck() {
    const deck = [];
    for (let t = 0; t < 34; t++)
        for (let i = 0; i < 4; i++)
            deck.push(t);
    return deck;
}
function sortTiles(tiles) {
    return [...tiles].sort((a, b) => a - b);
}
function tileCounts(tiles) {
    const c = new Array(34).fill(0);
    for (const t of tiles)
        c[t]++;
    return c;
}
/**
 * 吃的组合：返回手牌中用到的两张牌。
 * 数牌：同花色夹张/边张（差 1 的两段）；风牌：任意 2 种风 + 这张风 = 3 种不同；
 * 箭牌：中发白三张齐二缺一。
 */
function chiOptions(hand, discard) {
    const res = [];
    const c = tileCounts(hand);
    if (discard < 27) {
        const base = Math.floor(discard / 9) * 9;
        const r = discard % 9;
        const cands = [
            [r - 2, r - 1],
            [r - 1, r + 1],
            [r + 1, r + 2],
        ];
        for (const [a, b] of cands) {
            if (a < 0 || b > 8)
                continue;
            const ta = base + a;
            const tb = base + b;
            if (c[ta] > 0 && c[tb] > 0)
                res.push([ta, tb]);
        }
    }
    else if (discard <= 30) {
        const have = exports.WINDS.filter((w) => w !== discard && c[w] > 0);
        for (let i = 0; i < have.length; i++) {
            for (let j = i + 1; j < have.length; j++)
                res.push([have[i], have[j]]);
        }
    }
    else {
        const others = exports.DRAGONS.filter((d) => d !== discard);
        if (others.every((o) => c[o] > 0))
            res.push(others);
    }
    return res;
}
