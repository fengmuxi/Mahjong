"use strict";
/** 计分结算（M4）：算子表分类 + 逐家算子 + 冲关/杠精 —— 纯函数，与 docs/rules/nanchang.md §6 对齐 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.classifyPattern = classifyPattern;
exports.payFor = payFor;
exports.computeSettlement = computeSettlement;
/**
 * 旗标 → 算子表行（覆盖 RULES §6.2 全部 30 行）。
 * 表未覆盖的组合按 §6.5 回退（德中德 = 德国行 ×2）。
 * 天地胡单独结算，返回 null。
 */
function classifyPattern(f) {
    if (f.tiandi)
        return null;
    const g = f.german || f.dezhongde; // 德中德必含德国
    const dz = f.dezhongde;
    const j = f.jingdiao;
    const k = f.gankai;
    const qx = f.qixing;
    const s = f.shapes;
    if (s.includes('shisanlan')) {
        if (g && qx)
            return { name: '德国七星十三烂', M: 8, plus5: true, fold: false };
        if (g)
            return dz
                ? { name: '德国十三烂·德中德', M: 8, plus5: true, fold: false } // 回退：德国行×2
                : { name: '德国十三烂', M: 4, plus5: true, fold: false };
        return { name: '十三烂', M: 2, plus5: false, fold: false };
    }
    if (s.includes('big7')) {
        if (k && j) {
            if (dz)
                return { name: '大7杠开精吊杠开德国大7对德中德', M: 128, plus5: true, fold: true };
            if (g)
                return { name: '大7杠开精吊杠开德国大7对', M: 64, plus5: true, fold: true };
            return { name: '大7杠开精吊杠开大7对', M: 32, plus5: true, fold: true };
        }
        if (k) {
            if (dz)
                return { name: '大7杠开德国大7对德中德', M: 64, plus5: true, fold: true };
            if (g)
                return { name: '大7杠开德国大7对', M: 32, plus5: true, fold: true };
            return { name: '大7杠开大7对', M: 16, plus5: false, fold: true };
        }
        if (j) {
            if (dz)
                return { name: '精吊德国大7对德中德', M: 32, plus5: true, fold: false };
            if (g)
                return { name: '精吊德国大7对', M: 16, plus5: true, fold: false };
            return { name: '精吊大7对', M: 8, plus5: true, fold: false };
        }
        if (dz)
            return { name: '德国大7对·德中德', M: 16, plus5: true, fold: false }; // 回退：德国行×2
        if (g)
            return { name: '德国大7对', M: 8, plus5: true, fold: false };
        return { name: '大7对', M: 4, plus5: false, fold: false };
    }
    if (s.includes('small7')) {
        if (j && dz)
            return { name: '精吊德国小7对德中德', M: 32, plus5: true, fold: false };
        if (j && g)
            return { name: '精吊德国小7对', M: 16, plus5: true, fold: false };
        if (j)
            return { name: '精吊小7对', M: 4, plus5: true, fold: false };
        if (dz)
            return { name: '德国小7对·德中德', M: 16, plus5: true, fold: false }; // 回退
        if (g)
            return { name: '德国小7对', M: 8, plus5: true, fold: false };
        return { name: '小7对', M: 2, plus5: false, fold: false };
    }
    // 平胡
    if (k) {
        if (j && dz)
            return { name: '精吊杠开德中德', M: 32, plus5: true, fold: true };
        if (j && g)
            return { name: '精吊杠开德国', M: 16, plus5: true, fold: true };
        if (j)
            return { name: '精吊杠开', M: 8, plus5: true, fold: true };
        if (dz)
            return { name: '德国杠开德中德', M: 16, plus5: true, fold: true };
        if (g)
            return { name: '德国杠开', M: 8, plus5: true, fold: true };
        return { name: '平胡杠开', M: 4, plus5: false, fold: true };
    }
    if (j) {
        if (dz)
            return { name: '精吊德国德中德', M: 16, plus5: true, fold: false }; // 用户修正行
        if (g)
            return { name: '精吊德国', M: 4, plus5: true, fold: false };
        return { name: '精吊', M: 2, plus5: true, fold: false };
    }
    if (dz)
        return { name: '德中德', M: 4, plus5: true, fold: false };
    if (g)
        return { name: '德国', M: 2, plus5: true, fold: false };
    return { name: '平胡', M: 1, plus5: false, fold: false };
}
/** 单个付款方的牌型子数 */
function payFor(row, winnerIsDealer, winType, payerIsDealer, payerIsDiscarder) {
    const base = winnerIsDealer ? 2 : payerIsDealer ? 2 : 1;
    const mult = winType === 'zimo' ? (row.fold ? 1 : 2) : payerIsDiscarder ? 2 : 1;
    const p5 = row.plus5 && (winType === 'zimo' || payerIsDiscarder);
    return base * row.M * mult + (p5 ? 5 : 0);
}
function computeSettlement(input) {
    var _a;
    const patternDelta = [0, 0, 0, 0];
    const patternIn = [0, 0, 0, 0];
    const patternOut = [0, 0, 0, 0];
    const row = classifyPattern(input.flags);
    const winnerIsDealer = input.winner === input.dealer;
    const patternName = input.flags.tiandi === 'tian'
        ? '天胡'
        : input.flags.tiandi === 'di'
            ? '地胡'
            : ((_a = row === null || row === void 0 ? void 0 : row.name) !== null && _a !== void 0 ? _a : '平胡');
    if (input.flags.tiandi) {
        // 天地胡：固定每家 20（精吊天地 40），不叠其他牌型
        const per = input.flags.jingdiao ? 40 : 20;
        for (let s = 0; s < 4; s++) {
            if (s === input.winner)
                continue;
            patternDelta[input.winner] += per;
            patternDelta[s] -= per;
            patternIn[input.winner] += per;
            patternOut[s] += per;
        }
    }
    else if (row) {
        for (let s = 0; s < 4; s++) {
            if (s === input.winner)
                continue;
            const pay = payFor(row, winnerIsDealer, input.winType, s === input.dealer, input.winType === 'ron' && s === input.discarder);
            patternDelta[input.winner] += pay;
            patternDelta[s] -= pay;
            patternIn[input.winner] += pay;
            patternOut[s] += pay;
        }
    }
    // 精点逐对结算：四家两两比较，点差 d ≥ 2 → 低方付高方 d × max(d−3, 2) 子
    const chongNet = [0, 0, 0, 0];
    const gangNet = [0, 0, 0, 0];
    const jingIn = [0, 0, 0, 0];
    const jingOut = [0, 0, 0, 0];
    const chongMoves = [];
    for (let a = 0; a < 4; a++) {
        for (let b = a + 1; b < 4; b++) {
            const pa = input.wildPoints[a];
            const pb = input.wildPoints[b];
            const d = Math.abs(pa - pb);
            if (d < 2)
                continue;
            const amount = d * Math.max(d - 3, 2);
            const low = pa < pb ? a : b;
            const high = pa < pb ? b : a;
            chongNet[high] += amount;
            chongNet[low] -= amount;
            jingIn[high] += amount;
            jingOut[low] += amount;
            chongMoves.push({ from: low, to: high, d, amount });
        }
    }
    // 杠精：杠正精 +20 / 副精 +10，其余三家每家各出一份
    const gangEvents = [];
    for (const ev of input.gangJing) {
        const amount = ev.tile === input.jingPi ? 20 : ev.tile === input.jingFu ? 10 : 0;
        if (amount === 0)
            continue;
        gangEvents.push(Object.assign(Object.assign({}, ev), { amount }));
        gangNet[ev.seat] += amount * 3;
        jingIn[ev.seat] += amount * 3;
        for (let o = 0; o < 4; o++)
            if (o !== ev.seat) {
                gangNet[o] -= amount;
                jingOut[o] += amount;
            }
    }
    const deltas = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++)
        deltas[i] = patternDelta[i] + chongNet[i] + gangNet[i];
    return {
        patternName,
        deltas,
        patternDelta,
        chongNet,
        gangNet,
        patternIn,
        patternOut,
        jingIn,
        jingOut,
        chongMoves,
        gangEvents,
    };
}
