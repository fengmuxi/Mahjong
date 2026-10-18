"use strict";
/**
 * 赣州冲关麻将 · 胡牌判定（规则 §6）——纯函数，可单测
 *
 * 与南昌的核心差异：
 *   1. **精牌不当万能牌**（§3.3 / §3.6 三类对照表）——全部门牌按本身牌面分解，没有赖子通配；
 *      三类（明面正精 / 隐藏正精 / 副精）**都不能**当「精」凑牌型；隐藏正精即使被摸到，
 *      也只能按正精计分。本文件的分解函数 `gzDecompose` 连 wild 参数都没有，
 *      **结构上就不可能拿精凑牌**——新增任何通配能力都必须先改 `gzIsWildcard`。
 *   2. **乱风**（§四）——**风、箭各自成组**：东南西北任意 3 张不同风成一组、中发白任意 3 张不同箭
 *      成一组，**风箭不可混**（东+南 可吃 西、不可吃 中）；字牌之间可以相吃；
 *   3. **有精胡牌受限**（§6.5，2026-10-18 口径）——手上有精只能：精吊（听牌时精已单张在
 *      手作将：将牌 = {精, 胡牌张}，或精对作将）/ 特殊牌型 / 精归位（精当本张用，视为德国）/
 *      配将平胡（差将自摸摸精硬凑将，只按平胡结算不加分精吊分）。**点炮不允许平胡**——
 *      有精时点炮胡只能走精吊 / 德国（精归位）/ 杠开 / 其他特殊牌型；
 *   4. **德国 = 手上无精**（§6.4），德中德 = 德国 + 大牌型（×4）。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.gzDecompose = gzDecompose;
exports.gzChiOptions = gzChiOptions;
exports.gzAnalyzeWin = gzAnalyzeWin;
exports.gzIsDezhongde = gzIsDezhongde;
exports.gzShapeName = gzShapeName;
exports.gzWinLabel = gzWinLabel;
const tiles_1 = require("./tiles");
const wincheck_1 = require("./wincheck");
const gzconfig_1 = require("./rules/gzconfig");
// ---------- 无万能牌的标准型分解 ----------
/**
 * 为锚定在 k 的 g 个「字牌组」选取 2g 张后继字牌（每种至多 g 张——保证能两两配成
 * 牌面互异的组）；枚举所有可行选取并逐个尝试后续分解。成功返回 true（counts 已扣减）。
 *
 * 乱风口径（§四）：`windsDragons` 时同组须**同类别**——锚定在风牌（27-30）只能选风牌，
 * 锚定在箭牌（31-33）只能选箭牌；`any3` 时可选任意后继字牌。
 */
function takeGroupTiles(counts, k, g, setsLeft, pairLeft, allowSeq) {
    const later = [];
    const hi = gzconfig_1.GZ_CONFIG.honorGroup === 'windsDragons' && k < 31 ? 30 : 33;
    for (let j = k + 1; j <= hi; j++)
        if (counts[j] > 0)
            later.push(j);
    const rec = (idx, left) => {
        if (idx === later.length) {
            return left === 0 && decompStep(counts, k + 1, setsLeft - g, pairLeft, allowSeq);
        }
        const max = Math.min(counts[later[idx]], g, left);
        for (let m = 0; m <= max; m++) {
            counts[later[idx]] -= m;
            if (rec(idx + 1, left - m))
                return true;
            counts[later[idx]] += m;
        }
        return false;
    };
    return rec(0, 2 * g);
}
/** 分解递归：本位牌的出路只有「锚定在本位的组 / 顺子 / 刻子 / 对子」，张数唯一确定 */
function decompStep(counts, k, setsLeft, pairLeft, allowSeq) {
    if (k === 34)
        return setsLeft === 0 && !pairLeft;
    const c = counts[k];
    if (c === 0)
        return decompStep(counts, k + 1, setsLeft, pairLeft, allowSeq);
    if (k >= 27) {
        // 字牌：刻子 / 对子 / 同类别 3 张不同字牌的组（组锚定在组内最小牌，§四）
        for (let t = 0; 3 * t <= c; t++) {
            for (let p = 0; p <= 1; p++) {
                if (p === 1 && (!pairLeft || c - 3 * t < 2))
                    continue;
                const g = c - 3 * t - 2 * p;
                if (g < 0 || g > setsLeft)
                    continue;
                if (g > 0 && !allowSeq)
                    continue;
                counts[k] = 0;
                const ok = g === 0
                    ? decompStep(counts, k + 1, setsLeft - t, pairLeft && p === 0, allowSeq)
                    : takeGroupTiles(counts, k, g, setsLeft - t, pairLeft && p === 0, allowSeq);
                counts[k] = c;
                if (ok)
                    return true;
            }
        }
        return false;
    }
    // 数牌：顺子（锚定起点，同花色连续 3 张）/ 刻子 / 对子
    const canRun = k % 9 <= 6;
    for (let t = 0; 3 * t <= c; t++) {
        for (let p = 0; p <= 1; p++) {
            if (p === 1 && (!pairLeft || c - 3 * t < 2))
                continue;
            const r = c - 3 * t - 2 * p;
            if (r < 0 || r > setsLeft - t)
                continue;
            if (r > 0 && (!allowSeq || !canRun))
                continue;
            if (canRun && (counts[k + 1] < r || counts[k + 2] < r))
                continue;
            counts[k] = 0;
            counts[k + 1] -= r;
            counts[k + 2] -= r;
            const ok = decompStep(counts, k + 1, setsLeft - t - r, pairLeft && p === 0, allowSeq);
            counts[k] = c;
            counts[k + 1] += r;
            counts[k + 2] += r;
            if (ok)
                return true;
        }
    }
    return false;
}
/**
 * 无万能牌分解：counts 拆成 needSets 个面子 +（可选）一个对子。
 * allowSeq = false 时只认刻子（大七对用：无顺子、无字牌组）。
 */
function gzDecompose(counts, needSets, needPair, allowSeq) {
    if (needSets < 0)
        return false;
    return decompStep([...counts], 0, needSets, needPair, allowSeq);
}
// ---------- 吃牌选项（乱风，§四） ----------
/**
 * 吃的组合：返回手牌中用到的两张牌。
 * 数牌：同花色夹张 / 边张；字牌（乱风，§四）：**同类别**内任意 2 种不同字牌 + 打出张 = 3 张不同成组
 * （风牌组只吃风：东+南 吃 西；箭牌组只吃箭：中+发 吃 白；**风箭不可混**，东+南 不能吃 中）。
 */
function gzChiOptions(hand, discard) {
    const res = [];
    const c = (0, tiles_1.tileCounts)(hand);
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
            if (c[base + a] > 0 && c[base + b] > 0)
                res.push([base + a, base + b]);
        }
        return res;
    }
    // 乱风：手里同类别（风 27-30 / 箭 31-33）任意 2 种不同字牌即可与打出的字牌成组
    const sameKind = gzconfig_1.GZ_CONFIG.honorGroup === 'windsDragons';
    const lo = sameKind && discard >= 31 ? 31 : 27;
    const hi = sameKind && discard < 31 ? 30 : 33;
    const others = [];
    for (let t = lo; t <= hi; t++)
        if (t !== discard && c[t] > 0)
            others.push(t);
    for (let i = 0; i < others.length; i++) {
        for (let j = i + 1; j < others.length; j++)
            res.push([others[i], others[j]]);
    }
    return res;
}
// ---------- 胡牌分析 ----------
/** 精牌牌面去重（精吊判定用）——只含明面正精和它对应的副精 */
function jingKinds(j) {
    const out = [];
    if (j.zheng[0] !== undefined)
        out.push(j.zheng[0]);
    if (j.fu[0] !== undefined)
        out.push(j.fu[0]);
    return [...new Set(out)];
}
/**
 * 一次完整胡牌分析（§6）。
 * @param concealed 暗牌（含刚摸 / 点炮那张），melds 副露
 * @param gankai 是否杠上补牌胡（平胡豁免精吊限制，§6.6）
 * @param winTile 胡的那张牌（自摸 = 刚摸那张 / 点炮 = 被胡那张）。精吊判定（将牌 = {精, 胡牌张}）必需；
 *                缺省时只能判「精对作将」，配将一律按 jingPairPlain 处理
 * @param via 胡牌来源（自摸 / 点炮）。点炮不允许配将平胡、不允许精吊——有精点炮只能走
 *            德国（精全按本张的标准分解，特殊牌型按本张参与也在其中）（§6.5，2026-10-18 口径）
 */
function gzAnalyzeWin(concealed, melds, jing, gankai, winTile, via = 'zimo') {
    const counts = (0, tiles_1.tileCounts)(concealed);
    const setsNeeded = 4 - melds.length;
    const noChi = melds.every((m) => m.type !== 'chi');
    const shapes = [];
    let pinghu = false;
    let big7 = false;
    if (setsNeeded >= 0) {
        pinghu = gzDecompose(counts, setsNeeded, true, true);
        if (pinghu)
            shapes.push('pinghu');
        if (noChi) {
            big7 = gzDecompose(counts, setsNeeded, true, false);
            if (big7)
                shapes.push('big7');
        }
    }
    const small7 = melds.length === 0 && (0, wincheck_1.isSmallSevenPairs)(counts, 0);
    if (small7)
        shapes.push('small7');
    const sls = (0, wincheck_1.checkShisanlan)(concealed, melds, null, null) !== null;
    if (sls)
        shapes.push('shisanlan');
    // 有精 / 无精（§6.5）：只看暗牌——副露里的精牌视为已「归位」。
    // **只有明面正精（zheng[0]）和它对应的副精（fu[0]）算「有精」**；
    // 隐藏正精（zheng[1..5]）和隐藏副精（fu[1..5]）不显示、不算做精使用，只记分。
    const hasJing = concealed.some((t) => t === jing.zheng[0] || t === jing.fu[0]);
    // 精吊（§6.5 + 2026-10-18 澄清口径）：前提是**听牌时精已单张在手作将** ——
    //   ① 将牌 = {精, 胡牌张}：单吊精、摸/胡到任意一张都与它配成将（这就是「摸任意一张都能胡」）；
    //   ② 将牌 = {精, 精}：精对作将（两张精都在暗牌里，含正精+副精、同种两张）。
    // 「手上差个将、自摸摸上一张精硬凑将」（将牌 = {精, 手上原有普通牌}）**不算精吊**，
    // 只按平胡结算（jingPairPlain）——要精吊须先打掉另一张散牌、留精单吊，下一轮才是。
    // 分解全为刻子且无吃牌副露（大七对型）记 jingdiaoTrips、含顺子型记 jingdiaoRuns——计底分用。
    let jingdiaoRuns = false;
    let jingdiaoTrips = false;
    let jingPairPlain = false;
    /** 将牌 = 明面精 + 同面本张成对 → 精吊与德国同时成立（+5 +8 = 13，2026-10-18 口径） */
    let jingdiaoOnFace = false;
    const kinds = jingKinds(jing);
    if (hasJing && !small7 && setsNeeded >= 0) {
        // 从 counts 里摘掉将牌的两张再分解其余；返回该分解是「全刻子」还是「含顺子」
        const tryPair = (a, b) => {
            if (counts[a] < 1 || counts[b] < 1)
                return false;
            if (a === b && counts[a] < 2)
                return false;
            counts[a] -= 1;
            counts[b] -= 1;
            let r = false;
            if (gzDecompose(counts, setsNeeded, false, true)) {
                r = 'runs';
                if (noChi && gzDecompose(counts, setsNeeded, false, false))
                    r = 'trips';
            }
            counts[a] += 1;
            counts[b] += 1;
            return r;
        };
        // ① 将牌 = {精, 胡牌张}
        if (winTile != null) {
            for (const kind of kinds) {
                const r = tryPair(kind, winTile);
                if (r) {
                    if (r === 'trips')
                        jingdiaoTrips = true;
                    else
                        jingdiaoRuns = true;
                    // 将牌是「明面精 + 同面本张」成对（单吊精恰好摸上它的本张）→ 精吊与德国同时成立
                    if (kind === winTile)
                        jingdiaoOnFace = true;
                }
            }
        }
        // ② 将牌 = {精, 精}：精对作将 —— **两张精都必须在胡牌前的手牌里**（胡牌张不在将牌里，
        //    它在某一组面子里）。差将摸上一张精、与手里另一张精凑对不算（那由 ①/③ 表达）。
        const pre = [...counts];
        if (winTile != null && pre[winTile] > 0)
            pre[winTile] -= 1;
        for (const k1 of kinds) {
            for (const k2 of kinds) {
                if (pre[k1] < 1 || pre[k2] < 1 || (k1 === k2 && pre[k1] < 2))
                    continue;
                const r = tryPair(k1, k2);
                if (r) {
                    if (r === 'trips')
                        jingdiaoTrips = true;
                    else
                        jingdiaoRuns = true;
                    // 同面精对（明面精 + 它的本张）→ 同样精吊 + 德国同时成立
                    if (k1 === k2)
                        jingdiaoOnFace = true;
                }
            }
        }
        // ③ 配将（将牌 = {精, 手上原有普通牌}）：只保证胡牌成立，按平胡结算；
        //    仅自摸成立——点炮平胡一律禁止（§6.5，2026-10-18 口径），点炮必须走
        //    精吊 / 精归位德国 / 杠开 / 其他特殊牌型
        if (!jingdiaoRuns && !jingdiaoTrips) {
            outer: for (const kind of kinds) {
                if (counts[kind] < 1)
                    continue;
                counts[kind] -= 1;
                for (let partner = 0; partner < 34; partner++) {
                    if (counts[partner] < 1)
                        continue;
                    counts[partner] -= 1;
                    if (gzDecompose(counts, setsNeeded, false, true)) {
                        jingPairPlain = true;
                        counts[partner] += 1;
                        break outer;
                    }
                    counts[partner] += 1;
                }
                counts[kind] += 1;
            }
        }
    }
    // 七对含精对（{精,精}，两张都在暗牌里）也算精吊（§6.5）；
    // 七对里的精对必然是「明面精 + 同面本张」→ 同样精吊 + 德国同时成立
    const jingPair7 = small7 && kinds.some((k) => counts[k] >= 2);
    if (jingPair7)
        jingdiaoOnFace = true;
    const jingdiao = hasJing && (jingdiaoRuns || jingdiaoTrips || jingPair7);
    if (jingdiaoTrips && !shapes.includes('big7'))
        shapes.push('big7');
    if (jingdiaoRuns && !shapes.includes('pinghu'))
        shapes.push('pinghu');
    // 合法性（§6.5，2026-10-18 口径）：无精 → 标准牌型；自摸有精 → 精吊 / 特殊牌型 /
    // 精归位（标准分解成立 = 精全按本张使用，§6.5③ 视为德国）/ 配将平胡（含杠开豁免）。
    // **点炮有精 → 只认德国路线（standard = 精全按本张参与，特殊牌型按本张成也在其中）**：
    // 纯精吊（将牌 = {精, 胡牌张任意} 或精对作将）与配将平胡一律不成立。
    // 「单吊精胡到精本张」按下张成对属 standard → 点炮可胡，但只按德国结算（无精吊 +5）。
    const standard = pinghu || big7 || small7 || sls;
    // 精吊标志只对自摸有效：点炮胡即便同型也不给「精吊」牌型与 +5（仅按德国/特殊结算）
    const jingdiaoFlag = via === 'zimo' ? jingdiao : false;
    const guiwei = hasJing && !jingdiaoFlag && standard; // 精归位（配将平胡优先级更低，见下）
    let valid;
    if (!hasJing)
        valid = shapes.length > 0;
    else if (via === 'ron')
        valid = standard;
    else if (jingdiao)
        valid = true;
    else if (standard)
        valid = true;
    else if (jingPairPlain && via === 'zimo') {
        valid = true;
        if (!shapes.includes('pinghu'))
            shapes.push('pinghu');
    }
    else
        valid = gankai && pinghu; // 杠开平胡豁免（杠开必自摸）
    // 七星十三烂（§6.1）
    let qixing = false;
    if (sls) {
        const eff = new Set(concealed);
        for (const m of melds)
            for (const t of m.tiles)
                eff.add(t);
        qixing = [27, 28, 29, 30, 31, 32, 33].every((w) => eff.has(w));
    }
    // 底分（多牌型并存取最高；精吊按分解类型取平胡 / 大七对底分；配将平胡取平胡底分）
    let patternBase = 0;
    if (qixing)
        patternBase = gzconfig_1.GZ_CONFIG.patternBase.qixing;
    else if (big7 || jingdiaoTrips)
        patternBase = gzconfig_1.GZ_CONFIG.patternBase.big7;
    else if (small7 || sls)
        patternBase = Math.max(gzconfig_1.GZ_CONFIG.patternBase.small7, gzconfig_1.GZ_CONFIG.patternBase.shisanlan);
    else if (pinghu || jingdiaoRuns || jingPairPlain)
        patternBase = gzconfig_1.GZ_CONFIG.patternBase.pinghu;
    // 德国（§6.4 + §6.5③ + 2026-10-18 口径）：手上无精、精归位，
    // 或将牌是「明面精 + 同面本张」成对（精吊与德国同时成立）
    const german = !hasJing || guiwei || jingdiaoOnFace;
    // 德中德需看其余三家有没有精牌——胡型分析拿不到别家信息，由引擎判定（见 gzIsDezhongde）
    return { valid, shapes, qixing, hasJing, jingdiao: jingdiaoFlag, jingPairPlain: jingPairPlain && !guiwei, german, patternBase };
}
/**
 * 德中德（§6.4 + 确认口径）：**德国成立 + 任意胡牌牌型（含平胡）+ 其余三家一张精牌都没有** → 胡牌分 ×4。
 * 「没有精牌」按物理持有算（手牌 + 副露 + 牌河——打出无人碰的精仍算他的）。
 * **只算明面正精（zheng[0]）和它对应的副精（fu[0]）**；隐藏正精/副精不算做精使用。
 * @param german 赢家是否德国（暗牌无精）
 * @param othersHoldings 其余三家的全部持有（手牌 + 副露 + 牌河）
 */
function gzIsDezhongde(german, othersHoldings, jing) {
    if (!german)
        return false;
    const jingTiles = new Set([jing.zheng[0], jing.fu[0]]);
    return othersHoldings.every((tiles) => tiles.every((t) => !jingTiles.has(t)));
}
/** 胡牌 / 自摸按钮与结果文案的牌型名（普通平胡返回 '平胡'） */
function gzShapeName(f) {
    if (f.qixing)
        return '七星十三烂';
    if (f.shapes.includes('big7'))
        return '大七对';
    if (f.shapes.includes('small7'))
        return '小七对';
    if (f.shapes.includes('shisanlan'))
        return '十三烂';
    return '平胡';
}
/** 按钮标签组合（如「精吊·大七对」「德国·小七对·杠开」）；纯平胡返回 null */
function gzWinLabel(f, gankai, tiandi, dezhongde) {
    const parts = [];
    const shape = gzShapeName(f);
    if (shape !== '平胡')
        parts.push(shape);
    // 精吊（精作将胡）与德国（无精 / 精归位 / 明面精与本张同面成对）可同时成立 →「精吊·德国」
    if (f.jingdiao)
        parts.push('精吊');
    if (f.german)
        parts.push('德国');
    if (dezhongde)
        parts.push('德中德');
    if (gankai)
        parts.push('杠开');
    if (tiandi === 'tian')
        parts.push('天和');
    if (tiandi === 'di')
        parts.push('地和');
    return parts.length > 0 ? parts.join('·') : null;
}
