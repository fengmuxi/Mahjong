"use strict";
/** 胡牌判定（M3）：赖子通配、牌型识别、德国 / 精吊辅助 —— 纯函数，可单测 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSmallSevenPairs = isSmallSevenPairs;
exports.checkShisanlan = checkShisanlan;
exports.analyzeWin = analyzeWin;
exports.isAnyDrawTenpai = isAnyDrawTenpai;
exports.shapeLabel = shapeLabel;
const WIND_GROUP = [27, 28, 29, 30];
const DRAGON_GROUP = [31, 32, 33];
function shapeList(allowRuns) {
    const out = Array.from({ length: 34 }, () => []);
    if (!allowRuns)
        return out;
    for (let k = 0; k < 27; k++) {
        if (k % 9 <= 6)
            out[k].push([k, k + 1, k + 2]);
    }
    // 风牌：任意 3 种不同（按最小牌锚定）
    out[27].push([27, 28, 29], [27, 28, 30], [27, 29, 30]);
    out[28].push([28, 29, 30]);
    // 箭牌：中发白为一组
    out[31].push([31, 32, 33]);
    return out;
}
/**
 * 标准型分解：把 arr 拆成 needSets 个面子 +（可选）一个对子。
 * 万能牌单独记账，可补任意缺口，也可单独成面子/对子。
 */
function decompose(input, wild, needSets, needPair, allowRuns) {
    const arr = [...input];
    const shapesAt = shapeList(allowRuns);
    function step(k, setsLeft, pairLeft, wildLeft) {
        if (k === 34)
            return setsLeft === 0 && !pairLeft && wildLeft === 0;
        const c = arr[k];
        const shapes = shapesAt[k];
        const undo = [];
        const attempt = (p, t, vec) => {
            let shapeTotal = 0;
            for (const n of vec)
                shapeTotal += n;
            const setsUsed = t + shapeTotal;
            if (setsUsed > setsLeft)
                return false;
            const D = 2 * p + 3 * t + shapeTotal;
            if (D < c)
                return false; // 本位真实牌必须有处安放
            let cost = D - c; // 本位用万能补的缺口
            for (let si = 0; si < shapes.length; si++) {
                for (let r = 0; r < vec[si]; r++) {
                    for (const j of shapes[si]) {
                        if (j === k)
                            continue;
                        if (arr[j] > 0) {
                            arr[j]--;
                            undo.push(j);
                        }
                        else {
                            cost++;
                        }
                    }
                }
            }
            let ok = false;
            if (cost <= wildLeft) {
                ok = step(k + 1, setsLeft - setsUsed, pairLeft && p === 0, wildLeft - cost);
            }
            for (const j of undo)
                arr[j]++;
            undo.length = 0;
            return ok;
        };
        const vec = new Array(shapes.length).fill(0);
        const enumVec = (idx) => {
            if (idx === shapes.length) {
                for (const p of [0, 1]) {
                    if (p === 1 && !pairLeft)
                        continue;
                    for (let t = 0; t <= setsLeft; t++) {
                        if (attempt(p, t, vec))
                            return true;
                    }
                }
                return false;
            }
            for (let n = 0; n <= setsLeft; n++) {
                vec[idx] = n;
                if (enumVec(idx + 1))
                    return true;
            }
            vec[idx] = 0;
            return false;
        };
        return enumVec(0);
    }
    return step(0, needSets, needPair, wild);
}
/** 小7对（无副露）：奇数张的牌种各需一张万能补齐，剩余万能须成对（赣州冲关以 wild=0 复用） */
function isSmallSevenPairs(counts, wild) {
    let singles = 0;
    for (const c of counts)
        singles += c % 2;
    return wild >= singles && (wild - singles) % 2 === 0;
}
/** 十三烂：14 张全不同、同花色数牌间隔 ≥2；返回万能牌的分配（无万能则为空数组） */
function checkShisanlan(concealed, melds, pi, fu) {
    if (melds.some((m) => m.type !== 'chi'))
        return null;
    const wildSet = new Set();
    if (pi !== null)
        wildSet.add(pi);
    if (fu !== null)
        wildSet.add(fu);
    const fixed = new Array(34).fill(0);
    let wild = 0;
    let total = 0;
    const add = (t) => {
        total++;
        if (wildSet.has(t))
            wild++;
        else
            fixed[t]++;
    };
    for (const t of concealed)
        add(t);
    for (const m of melds)
        for (const t of m.tiles)
            add(t);
    if (total !== 14)
        return null;
    if (fixed.some((n) => n > 1))
        return null;
    // 占用情况 + 各花色已占用的点数
    const used = fixed.map((n) => n > 0);
    const suitRanks = [[], [], []];
    const noteFixed = (t) => {
        if (t < 27)
            suitRanks[Math.floor(t / 9)].push(t % 9);
    };
    for (let t = 0; t < 34; t++)
        if (fixed[t] > 0)
            noteFixed(t);
    // 固定牌自身必须满足同花色间隔 ≥2
    for (const ranks of suitRanks) {
        ranks.sort((a, b) => a - b);
        for (let i = 1; i < ranks.length; i++) {
            if (ranks[i] - ranks[i - 1] < 3)
                return null;
        }
    }
    const spacingOk = (kind) => {
        if (kind >= 27)
            return true;
        const suit = Math.floor(kind / 9);
        const r = kind % 9;
        return suitRanks[suit].every((x) => Math.abs(x - r) >= 3);
    };
    const assign = [];
    const rec = (i) => {
        if (i === wild)
            return true;
        for (let kind = 0; kind < 34; kind++) {
            if (used[kind] || !spacingOk(kind))
                continue;
            used[kind] = true;
            assign.push(kind);
            if (kind < 27)
                suitRanks[Math.floor(kind / 9)].push(kind % 9);
            if (rec(i + 1))
                return true;
            used[kind] = false;
            assign.pop();
            if (kind < 27)
                suitRanks[Math.floor(kind / 9)].pop();
        }
        return false;
    };
    return rec(0) ? assign : null;
}
/** 一次完整胡牌分析（含德国判定）
 * @param literalExtra 点炮的那张牌——它只能按本身牌面参与，不得当万能代牌
 */
function analyzeWin(concealed, melds, pi, fu, literalExtra) {
    const wildSet = new Set();
    if (pi !== null)
        wildSet.add(pi);
    if (fu !== null)
        wildSet.add(fu);
    const arr = new Array(34).fill(0);
    let wild = 0;
    let literalKeep = literalExtra !== undefined && wildSet.has(literalExtra) ? 1 : 0;
    for (const t of concealed) {
        if (wildSet.has(t) && literalKeep > 0 && t === literalExtra) {
            literalKeep--; // 点炮的精按本身计入，不进万能池
            arr[t]++;
        }
        else if (wildSet.has(t)) {
            wild++;
        }
        else {
            arr[t]++;
        }
    }
    const setsNeeded = 4 - melds.length;
    const shapes = [];
    if (setsNeeded >= 0) {
        if (decompose(arr, wild, setsNeeded, true, true))
            shapes.push('pinghu');
        if (melds.every((m) => m.type !== 'chi') && decompose(arr, wild, setsNeeded, true, false)) {
            shapes.push('big7');
        }
    }
    if (melds.length === 0 && isSmallSevenPairs(arr, wild))
        shapes.push('small7');
    if (checkShisanlan(concealed, melds, pi, fu))
        shapes.push('shisanlan');
    // 德国 = 关掉万能能力（赖子按本身牌面）后依然成立
    const lit = new Array(34).fill(0);
    for (const t of concealed)
        lit[t]++;
    const german = (setsNeeded >= 0 &&
        (decompose(lit, 0, setsNeeded, true, true) ||
            (melds.every((m) => m.type !== 'chi') && decompose(lit, 0, setsNeeded, true, false)))) ||
        (melds.length === 0 && isSmallSevenPairs(lit, 0)) ||
        checkShisanlan(concealed, melds, null, null) !== null;
    return { valid: shapes.length > 0, shapes, german };
}
/** 精吊：牌墙里剩余可摸的任一种牌补进 13 张都能胡（全部满足才成立） */
function isAnyDrawTenpai(pre13, melds, pi, fu, wallKinds) {
    let any = false;
    for (const k of wallKinds) {
        any = true;
        if (!analyzeWin([...pre13, k], melds, pi, fu).valid)
            return false;
    }
    return any;
}
function shapeLabel(s) {
    return s === 'pinghu'
        ? '平胡'
        : s === 'big7'
            ? '大7对'
            : s === 'small7'
                ? '小7对'
                : '十三烂';
}
