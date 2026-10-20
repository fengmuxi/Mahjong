"use strict";
/**
 * 赣州冲关麻将 · 精牌模型（规则 §3 翻精 / §5 精分）——纯函数，可单测
 *
 * 与南昌的本质区别：**精牌只用于结算记分，不作万能牌**（§3.3）：
 *   - 不能当万能牌替代其他牌，也不能作为精牌获得打出 / 吃 / 碰 / 杠 的特权；
 *   - 牌局进行中精牌就是普通牌，仅结算时按牌面计分；
 *   - 精牌会影响胡牌方式（有精受限，见 gzwin.ts）。
 *
 * ## 三类精牌（§3.6 对照表，`GZ_JING_CATEGORIES` 为权威定义）
 *
 * | 类别 | 张数 | 判定 | 可见 | 当万能牌 | 计分 |
 * |------|------|------|------|----------|------|
 * | ① 明面正精 | 1 | 掷骰从牌墙尾定位、翻出的那张（正精墩上张） | **公开** | ❌ | 2 分/张 |
 * | ② 隐藏正精 | 5 | 正精墩下张 + 前邻墩上下 + 后邻墩上下 | **全程扣放** | ❌（明文禁止，即使摸到） | 2 分/张 |
 * | ③ 副精 | 6 | 每张正精的**下一张序数牌**（按牌面推，不按牌墙位置） | 仅对应明面正精那 1 张公开 | ❌ | 1 分/张 |
 *
 * 精牌构成（§3.5/§3.4）：6 张正精（2 分/张）+ 6 张副精（1 分/张）= 12 个「精位」，
 * 一一配对成 6 组「正精 + 副精」。
 * 精分（§5.2 新口径）：**每组按冲关规则独立计算**，相同组合的多组分数重复累加；
 * 一张物理牌只计一次、优先顶正精位（详见 `gzJingSeatScores`）。
 * 精分归属（确认口径）：**手牌 + 副露 + 牌河**都算——打出无人碰的精仍归打出者。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.GZ_JING_CATEGORIES = void 0;
exports.gzJingCategory = gzJingCategory;
exports.gzFuOf = gzFuOf;
exports.gzJingFu = gzJingFu;
exports.gzJingSlots = gzJingSlots;
exports.gzJingPointsOf = gzJingPointsOf;
exports.gzIsJing = gzIsJing;
exports.gzIsWildcard = gzIsWildcard;
exports.gzWildcardTiles = gzWildcardTiles;
exports.gzJingPublicTiles = gzJingPublicTiles;
exports.gzChongguanMult = gzChongguanMult;
exports.gzJingCombos = gzJingCombos;
exports.gzJingSeatScores = gzJingSeatScores;
exports.gzJingHoldings = gzJingHoldings;
const gzconfig_1 = require("./rules/gzconfig");
const tiles_1 = require("./tiles");
exports.GZ_JING_CATEGORIES = [
    {
        kind: 'zhengOpen',
        label: '明面正精',
        count: 1,
        points: gzconfig_1.GZ_CONFIG.zhengPoints,
        how: '庄家两骰之和 → 牌墙尾倒数第 S 墩 → 翻开该墩上张（§3.1）；这张就是全场唯一公开的精',
        visible: true,
        wildcard: false,
        score: '2 分/张；可「精归位」按其本来牌面使用（§3.3），但不代任何牌',
    },
    {
        kind: 'zhengHidden',
        label: '隐藏正精',
        count: 5,
        points: gzconfig_1.GZ_CONFIG.zhengPoints,
        how: '正精墩下张 + 前邻墩上下张 + 后邻墩上下张，共 3 墩 6 张中除明面那张外的 5 张（§3.2）',
        visible: false,
        wildcard: false,
        score: '2 分/张；**即使被玩家摸到也只能按正精计分，不得当万能牌凑牌型**',
    },
    {
        kind: 'fu',
        label: '副精',
        count: 6,
        points: gzconfig_1.GZ_CONFIG.fuPoints,
        how: '每张正精的**下一张序数牌**（§3.4）：一万→二万；九万→一万（本花色循环）；东南西北、中发白各自循环（北→东、白→中）',
        visible: false,
        wildcard: false,
        score: '1 分/张；其中对应明面正精的那 1 张（fu[0]）随翻精一并公开',
    },
];
/** 按三分类取权威定义 */
function gzJingCategory(kind) {
    var _a;
    return (_a = exports.GZ_JING_CATEGORIES.find((c) => c.kind === kind)) !== null && _a !== void 0 ? _a : exports.GZ_JING_CATEGORIES[1];
}
/**
 * 副精 = 正精的**下一张序数牌**（§3.4）——按牌面推导，与牌墙位置无关。
 *
 * ⚠️ 2026-10-16 修订：旧实现按「牌墙取牌顺序的下一张」推副精，已废弃。
 * 现在副精只看牌面序数：一万→二万、九万→一万；风牌 东→南→西→北→东、
 * 箭牌 中→发→白→中（分组独立循环，组间不跨越）。
 */
function gzFuOf(t) {
    return (0, tiles_1.nextJing)(t);
}
/** 由 6 张正精推出 6 张副精（`fu[i]` 对应 `zheng[i]`）——**副精推导的唯一入口** */
function gzJingFu(zheng) {
    return zheng.map(gzFuOf);
}
/** 12 个精位（明面正精 1 + 隐藏正精 5 + 副精 6）；顺序：正精 0..5 → 副精 0..5 */
function gzJingSlots(j) {
    const out = [];
    j.zheng.forEach((tile, i) => {
        const kind = i === 0 ? 'zhengOpen' : 'zhengHidden';
        out.push({
            tile,
            kind,
            group: 'zheng',
            visible: i === 0,
            wildcard: false,
            points: gzconfig_1.GZ_CONFIG.zhengPoints,
        });
    });
    j.fu.forEach((tile, i) => {
        out.push({
            tile,
            kind: 'fu',
            group: 'fu',
            visible: i === 0, // 只有「明面正精对应的那张副精」公开（§3.4）
            wildcard: false,
            points: gzconfig_1.GZ_CONFIG.fuPoints,
        });
    });
    return out;
}
/** 该牌面每张被多少精位指向、合计多少分（重叠叠加，§5.2：一牌双精 = 2+1 = 3） */
function gzJingPointsOf(t, j) {
    let n = 0;
    for (const s of gzJingSlots(j))
        if (s.tile === t)
            n += s.points;
    return n;
}
/** 该牌面是否为精牌（任意精位指向） */
function gzIsJing(t, j) {
    return gzJingPointsOf(t, j) > 0;
}
/**
 * 该牌面能否当「精」= 万能牌用于凑牌型——**赣州恒 false**（§3.3）。
 *
 * 隐藏正精尤其明文禁止（三类对照表 ②）：玩家摸到也不知道，只能按正精参与计分。
 * 明面正精虽公开，同样没有万能功能，只能「精归位」当作其本来花色点数（§3.3）。
 * 此函数是「当精使用」的唯一判定入口；胡牌分解 `gzDecompose` 连 wild 参数都没有，
 * 结构上就不可能拿精凑牌。
 */
function gzIsWildcard(_t, _j) {
    return false;
}
/** 可作万能牌的牌面集合——赣州恒为空（扩展点：将来若某玩法开放明面正精当精，改这里） */
function gzWildcardTiles(_j) {
    return [];
}
/**
 * 下发给客户端的精牌牌面。
 * @param all true = 结算揭晓，**6 张正精 + 6 张副精全开且不去重**（同牌面重复出现即多张）；
 *            false = 对局中，只给「明面正精 + 它对应的副精」2 张
 */
function gzJingPublicTiles(j, all) {
    if (all)
        return { zheng: [...j.zheng], fu: [...j.fu] };
    return {
        zheng: j.zheng[0] === undefined ? [] : [j.zheng[0]],
        fu: j.fu[0] === undefined ? [] : [j.fu[0]],
    };
}
/** 冲关倍数（§5.3）：组合累计精分 ≥ 5 触发；表外档位（>12 子）按「精分 − 3」递推 */
function gzChongguanMult(points) {
    const t = gzconfig_1.GZ_CONFIG.chongguan[points];
    if (t !== undefined)
        return t;
    return points >= 5 ? points - 3 : 1;
}
/** 6 组配对：正精 `zheng[i]` 配副精 `fu[i]`（§3.4），相同组合合并计数（§5.2 重复累加） */
function gzJingCombos(j) {
    const out = [];
    const at = new Map();
    for (let i = 0; i < j.zheng.length; i++) {
        const z = j.zheng[i];
        const f = j.fu[i];
        if (z === undefined || f === undefined)
            continue;
        const key = `${z}:${f}`;
        const k = at.get(key);
        if (k === undefined) {
            at.set(key, out.length);
            out.push({ zheng: z, fu: f, count: 1 });
        }
        else
            out[k].count++;
    }
    return out;
}
/**
 * 某家精分（§5.2 新口径）：12 张精两两配对为 6 组（正精 + 副精），**每组按冲关规则独立计算**，
 * 相同组合的多组**分数重复累加**；某组正副精仅一家持有时该组得分 ×2（精霸，§5.4）。
 *
 * **按牌面计（2026-10-18 确认，不设精位上限）**：该家持有（手 + 副露 + 牌河）里每一张
 * 精面牌都计分——正精面每张 2 分、副精面每张 1 分（同面多张照算）；一张牌面同属正副精面
 * 时按两面叠加（= 3 分/张）。
 *
 * @param scoreHoldings 交叉账用持有（全包牌已剔除）
 * @param physHoldings  物理持有（精霸判定用，含全包牌与牌河）
 */
function gzJingSeatScores(scoreHoldings, physHoldings, j) {
    const combos = gzJingCombos(j);
    const physCounts = physHoldings.map((h) => (0, tiles_1.tileCounts)(h));
    return scoreHoldings.map((tiles, seat) => {
        const counts = (0, tiles_1.tileCounts)(tiles);
        const out = [];
        let raw = 0;
        let final = 0;
        for (const c of combos) {
            const accum = gzconfig_1.GZ_CONFIG.zhengPoints * counts[c.zheng] + gzconfig_1.GZ_CONFIG.fuPoints * counts[c.fu];
            const chongguan = gzChongguanMult(accum);
            // 精霸（§5.4 按组）：该组正副精仅此一家持有，且这家两张都有
            let owners = 0;
            let owner = -1;
            for (let s = 0; s < physCounts.length; s++) {
                if (physCounts[s][c.zheng] > 0 || physCounts[s][c.fu] > 0) {
                    owners++;
                    owner = s;
                }
            }
            const jingba = owners === 1 && owner === seat && physCounts[seat][c.zheng] > 0 && physCounts[seat][c.fu] > 0;
            const score = accum * chongguan * (jingba ? gzconfig_1.GZ_CONFIG.jingbaMult : 1) * c.count;
            raw += accum * c.count;
            final += score;
            out.push({ zheng: c.zheng, fu: c.fu, count: c.count, accum, chongguan, jingba, score });
        }
        return { combos: out, raw, final };
    });
}
/**
 * 统计各家持有的精牌张数（确认口径：手牌 + 副露 + 牌河——打出无人碰的精仍归打出者）。
 * 仅用于结算面板展示；精分本身走 `gzJingSeatScores`（§5.2 新口径）。
 */
function gzJingHoldings(holdings, j) {
    const slots = gzJingSlots(j);
    return holdings.map((tiles) => {
        let pi = 0;
        let fu = 0;
        for (const t of tiles) {
            for (const s of slots) {
                if (s.tile !== t)
                    continue;
                if (s.group === 'zheng')
                    pi++;
                else
                    fu++;
            }
        }
        return { pi, fu };
    });
}
