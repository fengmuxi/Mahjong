/**
 * 多玩法契约（P0）：与具体麻将玩法无关的「规则集」接口。
 *
 * 设计目标：新增玩法（红中麻将、长沙麻将…）= 新增一个 RuleSet 实现并注册，
 * 无需修改对局引擎（server/game.ts）与既有南昌实现。
 *
 * 分层：
 *   engine（对局状态机，与玩法无关）
 *     └─ RuleSet（本文件定义的契约）
 *          └─ variants（rules/nanchang.ts …）
 *
 * 约定：牌仍用数字 id（Tile = number），但「id → 牌面语义」由玩法声明。
 */

import type { ClaimKind, Meld, Tile } from '../index.ts';
import type { PatternRow, ScoreFlags, SettleInput, SettleOutcome } from '../score.ts';
import type { WinAnalysis, WinShape } from '../wincheck.ts';
import type { GzJing } from '../gzjing.ts';
import type { GzSettleInput, GzSettleOutcome } from '../gzscore.ts';

/** 玩法元信息 */
export interface VariantMeta {
  /** 稳定唯一 id（房间与协议用），如 'nanchang' */
  id: string;
  /** 展示名，如 '南昌麻将' */
  name: string;
  /** 座位数（当前引擎固定 4） */
  seats: number;
  /** 每家起手张数（庄家 +1） */
  handSize: number;
  /** 一句话简介（首页玩法卡片） */
  desc?: string;
  /** 特征标签（首页玩法卡片，如 ['4 人', '翻精', '算子结算']） */
  tags?: string[];
}

/** 牌库 / 牌面模型 */
export interface TileModel {
  /** 牌种数（南昌 34） */
  kinds: number;
  /** 全副牌张数（南昌 136） */
  deckSize: number;
  /** 构造未洗的全副牌 */
  buildDeck(): Tile[];
  /** 花色标识（南昌 'm' | 's' | 'p' | 'z'） */
  suitOf(t: Tile): string;
  /** 点数 / 序号 */
  rankOf(t: Tile): number;
  /** 中文牌面名 */
  nameOf(t: Tile): string;
  /** 吃的组合（数牌夹张/边张、字牌成串等玩法差异在此收敛） */
  chiOptions(hand: Tile[], discard: Tile): Tile[][];
}

/** 赖子（万能牌）当前状态 */
export interface WildState {
  /** 主赖子（南昌 = 正精） */
  pi: Tile | null;
  /** 副赖子（南昌 = 副精） */
  fu: Tile | null;
  /** 赣州冲关：12 个精位（6 正精 + 6 副精，只结算记分不万能）——其他玩法不填 */
  gz?: GzJing;
}

/** 赖子模型 —— 无赖子玩法用 kind:'none' */
export interface WildModel {
  kind: 'none' | 'fixed' | 'flipped';
  /** fixed 玩法（如红中）的固定赖子牌面；flipped / none 为 undefined */
  fixedTiles?: Tile[];
  /** 该牌是否为赖子 */
  isWild(t: Tile, s: WildState): boolean;
  /** 该牌能否当任意牌（红中等玩法可能只计分不万能） */
  isUniversal(t: Tile, s: WildState): boolean;
}

/** 动作合法性 & 裁决 */
export interface ActionRules {
  /** 优先级（数值越小越优先）：胡 > 杠 > 碰 > 吃 */
  claimPriority: Record<ClaimKind, number>;
  /** 是否只能吃上家 */
  chiFromLeftOnly: boolean;
  /** 碰 / 杠所需张数 */
  pengSize: number;
  gangSize: number;
  /** 是否允许抢杠胡（预留） */
  robbingKong: boolean;
}

/** 胡牌上下文（引擎提供原始事实，玩法自行解读） */
export interface WinContext {
  via: 'zimo' | 'ron';
  seat: number;
  dealer: number;
  /** 已出牌总数（天胡 / 地胡判定用） */
  totalDiscards: number;
  /** 本次是否为杠后补牌（杠开判定用） */
  afterKong: boolean;
  /** 牌墙剩余可摸牌种（精吊等判定用） */
  wallKinds: Iterable<Tile>;
  /** 本局赖子状态 */
  wild: WildState;
}

/** 胡牌判定输入 */
export interface WinInput {
  /** 手牌（含刚摸 / 点炮那张） */
  concealed: Tile[];
  melds: Meld[];
  wild: WildState;
  /** 点炮的那张牌——只按本身牌面参与，不得万能代牌 */
  literalExtra?: Tile;
  /** 玩法上下文 */
  ctx: WinContext;
  /** 赣州冲关：本局精牌（有则按 gzwin 规则判定，忽略 wild） */
  gzJing?: GzJing;
  /** 赣州冲关：是否杠上补牌胡（平胡豁免精吊限制，§6.6） */
  gzGankai?: boolean;
}

/** 胡牌判定模型 */
export interface WinRules {
  /** 基础牌型分析（平胡 / 七对 / 十三烂…由玩法定义） */
  analyze(input: WinInput): WinAnalysis;
  /** 牌型展示名 */
  shapeLabel(s: WinShape | string): string;
}

/** 算分模型 */
export interface ScoreRules {
  /** 旗标 → 算分行 */
  classify(f: ScoreFlags): PatternRow | null;
  /** 完整结算 */
  settle(input: SettleInput): SettleOutcome;
  /** 赣州冲关原生结算（§7：精分 + 胡牌分 + 杠分 → 四人交叉 + 点炮直付 + 全包）。
   *  南昌 SettleInput 形状无法表达 12 精位持有，故赣州走此入口；其他玩法不实现。 */
  settleGz?(input: GzSettleInput): GzSettleOutcome;
}

  /** 流程 / 仪式配置 */
  export interface FlowConfig {
    /** 开局掷骰定起牌位 */
    dealCeremony: boolean;
    /** 翻精掷骰（赖子为 flipped 时通常开） */
    flipWild: boolean;
    /** 杠后掷骰补牌 */
    gangDice: boolean;
    /** 行牌方向 */
    turnOrder: 'ccw' | 'cw';
    /** 过水：过胡（含超时未应）后到自己摸牌前不能再点炮胡；缺省 true（南昌），赣州关 */
    skipRon?: boolean;
    /** 报杠（展示三张）：手有三张同牌可展示，冻结这三张并强制他家打出第 4 张（规则 §8.5）；
     *  缺省 false（南昌），仅赣州开 */
    declaredKong?: boolean;
    /** 首局是否需要掷骰定庄：缺省 false（南昌，默认东起庄），仅赣州开（四家掷骰比大小坐庄） */
    firstDealerRoll?: boolean;
  }

/** 玩法契约：引擎只依赖这些能力，不关心具体玩法 */
export interface RuleSet {
  meta: VariantMeta;
  tiles: TileModel;
  wild: WildModel;
  actions: ActionRules;
  win: WinRules;
  score: ScoreRules;
  flow: FlowConfig;
}
