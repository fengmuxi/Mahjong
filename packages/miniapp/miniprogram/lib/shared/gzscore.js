"use strict";
/**
 * 赣州冲关麻将 · 算分结算（规则 §7 + 确认口径）——纯函数，可单测
 *
 * 结算模型（「胡牌分和精分分开计算」，确认口径）：
 *   ① **精分 + 杠分 → 四人交叉结算**：每人拿自己的（精分终值 + 杠分）与另外三人逐一相抵，
 *      两两共 6 笔，恒为零和（§7.1/7.2 的「无通庄」部分）。
 *   ② **胡牌分 → 直付**（与交叉分开）：
 *      - 自摸：其余三家各付胡牌全分（由 §7.4 示例算术可证：交叉 25 + 3×32 = 121）；
 *      - 点炮（含抢杠）：点炮者付胡牌全分，其余两家各付 4（§6.3）。
 *   ③ **打出精牌被吃 / 碰 / 杠 → 打出者全包**（§5.6 + 确认口径）：该次的杠分 + 进副露
 *      那几张牌的精分，由打出者一人全额支付，**不进交叉结算**（= 帮另外两位一起出）。
 *   ④ **抄庄**（确认口径）：第一轮四家同张手牌 → 庄家给每位闲家 10 分。
 *  精分归属（确认口径）：手牌 + 副露 + 牌河都算——打出无人碰的精仍归打出者；
 *  点炮胡的胡牌张归赢家。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.gzSettle = gzSettle;
const gzconfig_1 = require("./rules/gzconfig");
const gzjing_1 = require("./gzjing");
function gzSettle(input) {
    // ---- 全包调整：被吃/碰/杠进副露的那几张牌，精分不走交叉（改由打出者全额直付） ----
    const excluded = [[], [], [], []];
    for (const p of input.packs)
        for (const t of p.tiles)
            excluded[p.claimer].push(t);
    const take = (tiles, ex) => {
        const rest = [...ex];
        return tiles.filter((t) => {
            const i = rest.indexOf(t);
            if (i < 0)
                return true;
            rest.splice(i, 1);
            return false;
        });
    };
    const crossHoldings = input.holdings.map((h, s) => take(h, excluded[s]));
    // ---- 精分（§5.2 新口径：逐组配对 → 逐组冲关 → 重复累加）；精霸按物理持有判定 ----
    const holdings = (0, gzjing_1.gzJingHoldings)(crossHoldings, input.jing);
    const jingScores = (0, gzjing_1.gzJingSeatScores)(crossHoldings, input.holdings, input.jing);
    // ---- 杠分：明 / 暗 / 补杠各 2 分；全包杠不走交叉 ----
    const gangOf = [0, 0, 0, 0];
    for (const g of input.gangs) {
        if (!g.packed)
            gangOf[g.seat] += gzconfig_1.GZ_CONFIG.gangScore;
    }
    const rows = [0, 1, 2, 3].map((seat) => {
        const ss = jingScores[seat];
        const chongguan = ss.combos.reduce((m, c) => Math.max(m, c.chongguan), 1);
        const pattern = input.winner === seat ? input.pattern : 0;
        return {
            seat,
            pi: holdings[seat].pi,
            fu: holdings[seat].fu,
            jingRaw: ss.raw,
            chongguan,
            jingba: ss.combos.some((c) => c.jingba),
            jingCombos: ss.combos,
            jingFinal: ss.final,
            pattern,
            gang: gangOf[seat],
            total: ss.final + pattern + gangOf[seat],
            delta: 0,
        };
    });
    // ---- ① 四人交叉结算（精分 + 杠分，§7.2） ----
    const moves = [];
    for (let a = 0; a < 4; a++) {
        for (let b = a + 1; b < 4; b++) {
            const ta = rows[a].jingFinal + rows[a].gang;
            const tb = rows[b].jingFinal + rows[b].gang;
            const d = ta - tb;
            if (d === 0)
                continue;
            moves.push({ from: d > 0 ? b : a, to: d > 0 ? a : b, amount: Math.abs(d) });
        }
    }
    // ---- ②③④ 直付 ----
    const direct = [];
    const w = input.winner;
    const dsc = input.discarder;
    // 打出精牌全包：杠分 + 进副露牌的精分，打出者一人全额（§5.6）
    for (const p of input.packs) {
        let amount = p.kind === 'gang' ? gzconfig_1.GZ_CONFIG.gangScore : 0;
        for (const t of p.tiles)
            amount += (0, gzjing_1.gzJingPointsOf)(t, input.jing);
        if (amount > 0) {
            direct.push({ from: p.discarder, to: p.claimer, amount, kind: p.kind === 'gang' ? 'pack-gang' : 'pack-meld' });
        }
    }
    // 胡牌分直付（与交叉分开）
    if (w !== null && input.pattern > 0) {
        if (dsc === null) {
            // 自摸：其余三家各付全分
            for (let s = 0; s < 4; s++) {
                if (s !== w)
                    direct.push({ from: s, to: w, amount: input.pattern, kind: 'zimo' });
            }
        }
        else if (dsc !== w) {
            // 点炮 / 抢杠：点炮者付全分，其余两家各付 4（§6.3）
            direct.push({ from: dsc, to: w, amount: input.pattern, kind: 'ron' });
            for (let s = 0; s < 4; s++) {
                if (s !== w && s !== dsc)
                    direct.push({ from: s, to: w, amount: gzconfig_1.GZ_CONFIG.ronOthersPay, kind: 'ron-other' });
            }
        }
        // 被吃 / 碰后该家胡牌：打出者再承担其胡牌分（§5.6，建议全包）
        if (gzconfig_1.GZ_CONFIG.packHuShare > 0) {
            for (const p of input.packs) {
                if (p.kind === 'gang' || p.claimer !== w || p.discarder === w)
                    continue;
                const amount = Math.round(input.pattern * gzconfig_1.GZ_CONFIG.packHuShare);
                if (amount > 0)
                    direct.push({ from: p.discarder, to: w, amount, kind: 'pack-hu' });
            }
        }
    }
    // 抄庄：庄家给每位闲家结算（确认口径）
    if (input.chaozhuang) {
        for (let s = 0; s < 4; s++) {
            if (s !== input.dealer) {
                direct.push({ from: input.dealer, to: s, amount: gzconfig_1.GZ_CONFIG.chaozhuangScore, kind: 'chaozhuang' });
            }
        }
    }
    const deltas = [0, 0, 0, 0];
    for (const m of moves) {
        deltas[m.from] -= m.amount;
        deltas[m.to] += m.amount;
    }
    for (const d of direct) {
        deltas[d.from] -= d.amount;
        deltas[d.to] += d.amount;
    }
    for (let s = 0; s < 4; s++)
        rows[s].delta = deltas[s];
    return { draw: w === null, winner: w, patternName: input.patternName, rows, moves, direct, deltas };
}
