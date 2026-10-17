"use strict";
/**
 * 赣州冲关麻将玩法实现：把赣州纯函数（gzjing / gzwin / gzscore）包装为 RuleSet 契约。
 *
 * 与南昌的本质差异（详见各模块注释）：
 *   - 精牌**只结算记分、不作万能牌**（§3.3）——wild.kind 仍为 flipped（掷骰翻出），
 *     但 isUniversal 恒 false；
 *   - 翻精定位 = 牌墙尾倒数（§3.1），产出 6 正精 + 6 副精共 12 个精位；
 *   - 乱风：任意 3 张不重复字牌成组（§四）——chiOptions 走 gzChiOptions；
 *   - 有精胡牌受限（§6.5）、德国 = 无精（§6.4）、无通庄四人交叉结算（§7）；
 *   - 补杠后掷骰定位补牌（牌友确认口径）、允许抢杠胡（§6.2）。
 *
 * 引擎（server/game.ts）对这些差异的接入点见 docs/integration/ganzhou.md。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ganzhouRules = void 0;
const tiles_1 = require("../tiles");
const gzwin_1 = require("../gzwin");
const gzscore_1 = require("../gzscore");
const gzconfig_1 = require("./gzconfig");
exports.ganzhouRules = {
    meta: {
        id: 'ganzhou',
        name: '赣州冲关麻将',
        seats: 4,
        handSize: 13,
        desc: '精牌纯结算记分（不作万能牌），有精只能精吊/特殊牌型/精归位德国；无通庄，四人交叉结算。',
        tags: ['4 人', '136 张', '翻精', '交叉结算', '抢杠'],
    },
    tiles: {
        kinds: 34,
        deckSize: 136,
        buildDeck: tiles_1.fullDeck,
        suitOf: tiles_1.suitOf,
        rankOf: tiles_1.rankOf,
        nameOf: tiles_1.tileName,
        // 乱风：字牌任意 3 张不重复成组、字牌可相吃（§四）
        chiOptions: gzwin_1.gzChiOptions,
    },
    // 翻精玩法：精牌由骰子定位翻出，但只用于结算记分，不当万能牌（§3.3）
    wild: {
        kind: 'flipped',
        isWild: (t, s) => !!s.gz && (s.gz.zheng.includes(t) || s.gz.fu.includes(t)),
        isUniversal: () => false,
    },
    actions: {
        claimPriority: { hu: -1, gang: 0, peng: 1, chi: 2 },
        chiFromLeftOnly: true,
        pengSize: 3,
        gangSize: 4,
        // 赣州允许抢杠胡：别人补杠的牌被自己胡（§6.2）
        robbingKong: true,
    },
    win: {
        analyze: (i) => {
            var _a, _b, _c;
            const jing = (_b = (_a = i.gzJing) !== null && _a !== void 0 ? _a : i.wild.gz) !== null && _b !== void 0 ? _b : { zheng: [], fu: [] };
            const f = (0, gzwin_1.gzAnalyzeWin)(i.concealed, i.melds, jing, (_c = i.gzGankai) !== null && _c !== void 0 ? _c : false);
            // 适配 WinAnalysis 形状（german 语义 = 无精德国；额外事实挂在 gz 字段）
            return { valid: f.valid, shapes: f.shapes, german: f.german, gz: f };
        },
        shapeLabel: (s) => s === 'shisanlan' ? '十三烂' : s === 'big7' ? '大七对' : s === 'small7' ? '小七对' : '平胡',
    },
    score: {
        // 赣州不走南昌算子表（§6.1/6.6 为底分直加）；分类由 gzAnalyzeWin 直接产出
        classify: () => null,
        // 完整结算走 settleGz（引擎直连）；此占位显式失败，避免误用南昌形状得出错分
        settle: () => {
            throw new Error('赣州冲关麻将请使用 score.settleGz（SettleInput 无法表达 12 精位持有）');
        },
        settleGz: gzscore_1.gzSettle,
    },
    // 翻精 = 开；杠后掷骰定位补牌（牌友确认口径，见 GZ_CONFIG.gangDice——覆盖文档 §8.3 的牌尾补牌）；
    // 过水默认关（规则文档未提及）；首局四家掷骰比大小坐庄
    flow: {
        dealCeremony: true,
        flipWild: true,
        gangDice: gzconfig_1.GZ_CONFIG.gangDice,
        turnOrder: 'ccw',
        skipRon: false,
        declaredKong: true,
        firstDealerRoll: true,
    },
};
