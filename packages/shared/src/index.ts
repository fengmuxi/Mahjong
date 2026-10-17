/** 房间与对局共享协议（M1 房间 + M2 行牌） */

import type { DealRecipe } from './wall.ts';

export const MAX_SEATS = 4;

/** 聊天正文长度上限（客户端 `maxlength` 与服务端裁剪**共用这一处数值**） */
export const CHAT_TEXT_MAX = 60;

/** 互动表情的语气分组：good = 捧场（送好处）、bad = 捣蛋（扔东西） */
export type ThrowEmojiTone = 'good' | 'bad';

export interface ThrowEmojiDef {
  /** 协议里传的 id（改 id 会破坏旧客户端的发送，只能改 icon/name/tone） */
  id: string;
  /** 展示用表情字符 */
  icon: string;
  /** 中文名（面板标签 + 气泡文案） */
  name: string;
  tone: ThrowEmojiTone;
}

/**
 * 定向互动表情表 —— **唯一的扩展点**。
 *
 * 在这里加/删/改一行即可：协议里只传 `id`，图标与中文名由两端各自查这张表，
 * 因此**前端面板、服务端校验、气泡文案会同时跟着变，不需要动任何其它文件**。
 * 注意：**不要改已有条目的 `id`**（会与旧客户端/历史协议对不上），换图标或改名字是安全的。
 */
export const THROW_EMOJI: readonly ThrowEmojiDef[] = [
  // —— 捧场：送点好的 ——
  { id: 'flower', icon: '💐', name: '鲜花', tone: 'good' },
  { id: 'rose', icon: '🌹', name: '玫瑰', tone: 'good' },
  { id: 'beer', icon: '🍺', name: '啤酒', tone: 'good' },
  { id: 'cake', icon: '🍰', name: '蛋糕', tone: 'good' },
  { id: 'thumb', icon: '👍', name: '点赞', tone: 'good' },
  { id: 'clap', icon: '👏', name: '鼓掌', tone: 'good' },
  { id: 'heart', icon: '❤️', name: '比心', tone: 'good' },
  // —— 捣蛋：扔点什么 ——
  { id: 'egg', icon: '🥚', name: '臭鸡蛋', tone: 'bad' },
  { id: 'tomato', icon: '🍅', name: '番茄', tone: 'bad' },
  { id: 'banana', icon: '🍌', name: '香蕉皮', tone: 'bad' },
  { id: 'brick', icon: '🧱', name: '板砖', tone: 'bad' },
  { id: 'mahjong', icon: '🀄', name: '麻将牌', tone: 'bad' },
  { id: 'bomb', icon: '💣', name: '炸弹', tone: 'bad' },
  { id: 'poop', icon: '💩', name: '一坨', tone: 'bad' },
];

/** 面板里各语气组的展示顺序与标题（分组为空则自动跳过） */
export const THROW_EMOJI_TONES: readonly { tone: ThrowEmojiTone; label: string }[] = [
  { tone: 'good', label: '捧场' },
  { tone: 'bad', label: '捣蛋' },
];

/** 按 id 取互动表情；未知 id 返回 null（服务端据此拒绝非法投掷） */
export function throwEmojiOf(id: string): ThrowEmojiDef | null {
  return THROW_EMOJI.find((e) => e.id === id) ?? null;
}

/** 牌面编号：0-8 万、9-17 条、18-26 筒、27-33 字（东南西北中发白） */
export type Tile = number;

export interface SeatPlayer {
  seat: number;
  name: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  /** 机器人（AI 凑桌；恒 ready、恒托管） */
  isBot?: boolean;
  /** 托管中（房主添加的机器人恒为 true；玩家手动开启或掉线也为 true） */
  auto?: boolean;
}

export type ClaimKind = 'hu' | 'chi' | 'peng' | 'gang';

export interface Meld {
  type: 'chi' | 'peng' | 'gang' | 'angang';
  tiles: Tile[];
  /** 来源座位（angang 为自己） */
  from: number;
}

export interface ClaimOption {
  kind: ClaimKind;
  /** 被吃 / 碰 / 杠 的那张牌 */
  tile: Tile;
  /** 吃：每个组合为手牌中用到的两张 */
  chiChoices?: Tile[][];
  /** 点炮胡的特殊牌型名（如「德国」「十三烂」）；平胡为 null → 按钮显示普通「胡」 */
  label?: string | null;
}

export interface SelfGangOption {
  kind: 'angang' | 'bugang';
  tile: Tile;
}

/** 掷骰仪式（服务端权威时间戳）：
 * deal = 开局定起牌位；jing = 发牌后翻精（和数定位）；gang = 杠后补牌定位 */
export interface CeremonyInfo {
  kind: 'deal' | 'jing' | 'gang';
  state: 'wait-roll' | 'rolling';
  /** 有权掷骰的座位（开局/翻精 = 庄家，杠后 = 杠牌者） */
  seat: number;
  /** rolling 时的两骰点数 */
  dice: [number, number] | null;
  /** rolling 起止（epoch ms；wait-roll 为 null） */
  rollAt: number | null;
  until: number | null;
}

/** 牌墙环渲染状态（配方含全部发牌步骤；客户端据此动画减少牌墙） */
export interface WallRingView {
  recipe: DealRecipe;
  frontSlot: number;
  kongSlots: number[];
}

/** 赣州冲关 · 牌桌精牌视图（§3：翻出的正精 + 它对应的副精全程公开，其余 10 张结算时揭晓） */
export interface GzJingView {
  /** 正精牌面（去重）；未揭晓只含翻出的那一张 */
  zheng: Tile[];
  /** 副精牌面（去重）；未揭晓只含**翻出那张正精对应的副精**（即 fu[0]） */
  fu: Tile[];
  /** phase=over 时 12 张精牌全部揭晓 */
  revealed: boolean;
}

/** 对局操作类型（日志用） */
export type GameActionKind = 'discard' | 'chi' | 'peng' | 'gang' | 'angang' | 'bugang' | 'hu' | 'draw';

/** 一条对局操作记录 */
export interface GameActionLog {
  /** 递增序号 */
  seq: number;
  /** 操作类型 */
  kind: GameActionKind;
  /** 执行者座位 */
  seat: number;
  /** 涉及的牌（吃/碰/杠为整组，出牌/胡为那张牌） */
  tiles: Tile[];
  /** 额外说明（如胡牌来源、牌型名） */
  note?: string;
}

/** 每个座位看到的个性化对局视图 */
export interface GameView {
  code: string;
  phase: 'playing' | 'over';
  dealer: number;
  /** 当前行动座位（phase=over 时无意义） */
  turn: number;
  mySeat: number;
  myTiles: Tile[];
  /** 各家手牌张数（含自己也给，冗余无害） */
  counts: number[];
  melds: Meld[][];
  rivers: Tile[][];
  wallLeft: number;
  /** 正精 / 副精 的牌面 */
  jingPi: Tile | null;
  jingFu: Tile | null;
  /** 最近一次掷骰的大点数（展示用） */
  dice: number | null;
  /** 开局仪式的两骰点数（构造后即有；杠骰/翻精骰另见 ceremony） */
  dealDice: [number, number] | null;
  /** 最近一次掷骰点数（开局 → 翻精 → 杠骰依次覆盖；未揭前客户端不显示） */
  lastDice: [number, number] | null;
  /** 正精在牌墙上的槽位（翻精定位后下发，供牌墙翻面显示） */
  jingSlot: number | null;
  /** 掷骰仪式：等待点击掷骰 / 骰子动画窗口（无仪式为 null） */
  ceremony: CeremonyInfo | null;
  /** 牌墙环（发牌配方 + 前端游标 + 杠取槽位） */
  wallRing: WallRingView | null;
  lastDiscard: { tile: Tile; from: number } | null;
  /** 响应窗口是否开着（开着时任何人都不能再出牌） */
  claimWindow: boolean;
  /** 我对最近一张出牌可做的操作（已响应或无资格则为 null） */
  claims: { options: ClaimOption[]; deadline: number } | null;
  /** 我的回合内可做的特殊动作（暗杠 / 补杠） */
  selfGangs: SelfGangOption[];
  /** 报杠（赣州 §8.5）：我当前可「展示三张」的牌面（自己回合、手牌恰好 3 张且未被挂起）；
   *  非报杠玩法恒为空数组 */
  declareOptions: Tile[];
  /** 全场已展示的报杠（seat 拥有该牌面的三张冻结牌）——对手明牌渲染与强制出牌判定的唯一来源 */
  declared: { seat: number; tile: Tile }[];
  /** 我本回合必须打出的牌面（持有他人/自己已展示的牌面时；可多张，任打其一即可） */
  mustDiscard: Tile[];
  /** 我的回合且当前手牌可自摸 */
  canZimo: boolean;
  /** 自摸的特殊牌型名（平胡为 null → 按钮显示「自摸」） */
  zimoLabel: string | null;
  /** 我刚摸到的牌（渲染时置于最右侧并高亮；非我回合或已打牌为 null） */
  drawn: Tile | null;
  /** 四家连接状态（false = 掉线；机器人恒为 true） */
  connected: boolean[];
  /** 四家是否由服务端代打（机器人 / 手动托管 / 掉线，均为 true）——供牌桌「托管中」标记 */
  auto: boolean[];
  /** 座位索引的玩家名（服务端填充） */
  names: string[];
  /** 房间累计积分（按座位，服务端填充） */
  totals: number[];
  /** 房主座位（服务端填充） */
  hostSeat: number;
  /** 当前玩法 id（服务端在广播时填充；引擎 viewFor 不产出，故可选） */
  variant?: string;
  /** 响应窗口截止时间（epoch ms；窗口关闭为 null）——供倒计时 */
  windowDeadline: number | null;
  /** 仍在等待响应的座位（当前被问者，分阶段顺序询问） */
  awaiting: number[];
  /** 过水：过胡后到自己摸牌前不能再点炮胡 */
  skipRon: boolean;
  /** 摊牌（phase=over 时）：四家暗牌全部亮出；对局中为 null */
  reveal: Tile[][] | null;
  /** 赣州冲关：精牌视图（未揭晓仅含翻出的正精）；其他玩法为 null */
  gz: GzJingView | null;
  /** 胡牌者座位（phase=over 且有赢家时；流局为 null）——供牌桌显著标识赢家 */
  winner: number | null;
  /** phase=over 时的结果文案 */
  result: string | null;
  /** 本局操作记录（出牌 / 吃 / 碰 / 杠 / 胡 / 流局） */
  log: GameActionLog[];
  /** 最近一次操作（用于客户端播放动画） */
  lastAction: GameActionLog | null;
}

/** 首局定庄的一次掷骰记录（两骰点数 + 和值） */
export interface DealerRoll {
  seat: number;
  dice: [number, number];
  /** 两骰之和（2..12）——定庄比的就是它 */
  sum: number;
}

export type ClientMsg =
  /** 创建房间：variant = 玩法 id（缺省南昌） */
  | { t: 'create'; name: string; variant?: string }
  | { t: 'join'; code: string; name: string }
  | { t: 'resume'; token: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'leave' }
  /** 请求换位：目标座位空闲 → 直接换；有人 → 向对方发起交换请求 */
  | { t: 'swap'; toSeat: number }
  /** 应答换位请求（被请求方） */
  | { t: 'swapRespond'; accept: boolean }
  | { t: 'discard'; tile: Tile }
  | { t: 'claim'; kind: ClaimKind; chiTiles?: Tile[] }
  | { t: 'pass' }
  | { t: 'selfGang'; kind: 'angang' | 'bugang'; tile: Tile }
  | { t: 'zimo' }
  /** 报杠（赣州 §8.5）：展示手牌中恰好 3 张的同牌面（仅自己回合、规则开启时有效） */
  | { t: 'declareKong'; tile: Tile }
  | { t: 'rollDice' }
  | { t: 'nextRound' }
  | { t: 'dissolve' }
  /** 房主：强制结束当前对局并返回房间（不解散房间） */
  | { t: 'abort' }
  /** 局内聊天：text 为消息正文（服务端清洗控制字符后按 CHAT_TEXT_MAX 截断） */
  | { t: 'chat'; text: string }
  /** 定向互动表情：向 target 座位扔 emote（THROW_EMOJI 的 id）；不可扔给自己 */
  | { t: 'emote'; target: number; emote: string }
  /** 房主：未开局 / 结算窗口内切换玩法（variant = 玩法 id；clearScores 为真则清零累计积分） */
  | { t: 'setVariant'; variant: string; clearScores?: boolean }
  /** 首局定庄：掷两骰，四人各掷一次，点数最大者坐庄（并列则并列者重掷） */
  | { t: 'rollDealer' }
  /** 房主：在大厅添加一个机器人占空位（满 4 人不可加；对局中不可加） */
  | { t: 'addBot' }
  /** 房主：移除指定座位的机器人（仅大厅） */
  | { t: 'removeBot'; seat: number }
  /** 托管开关：开启后服务端代你掷骰 / 应答 / 出牌，可随时取消 */
  | { t: 'setAuto'; auto: boolean }
  /**
   * 应用级心跳（微信小程序专用）。
   * `wx.connectSocket` 只能发文本/二进制消息，发不了 WebSocket 协议层的 ping 帧，
   * 因此小程序端用它替代 ws 级 ping/pong：服务端收到即刷新存活时间并回 `{t:'pong'}`。
   * web 端仍走 ws 级 ping，两条探活路径并存，互不影响。
   */
  | { t: 'ping' };

/** 赣州冲关 · 单组精分（§5.2 新口径：12 张精两两配对为 6 组，逐组独立冲关） */
export interface GzJingComboRow {
  /** 正精牌面 */
  zheng: Tile;
  /** 副精牌面 */
  fu: Tile;
  /** 该组合在 6 组中的出现次数（相同组合重复累加） */
  count: number;
  /** 组合累计精分 = 正精计入张数 ×2 + 副精计入张数 ×1（同牌面跨组只计一次） */
  accum: number;
  /** 冲关倍数（按 accum 查 §5.3） */
  chongguan: number;
  /** 精霸（§5.4 按组）：该组正副精仅此一家持有 → 本组得分 ×2 */
  jingba: boolean;
  /** 本组得分 = accum × 冲关 × 精霸 × count */
  score: number;
}

/** 赣州冲关 · 结算逐家明细（§7：精分 + 胡牌分 + 杠分） */
export interface GzSettleRow {
  seat: number;
  /** 正精 / 副精张数（按精位计，一牌双精算 2 张） */
  pi: number;
  fu: number;
  /** 精分原始值 = Σ 组合累计 × 组数（未冲关 / 未精霸） */
  jingRaw: number;
  /** 冲关倍数（该家各组中的最大倍数，明细见 jingCombos） */
  chongguan: number;
  /** 精霸：任一组合正副精独占 → 该组 ×2（§5.4） */
  jingba: boolean;
  /** 单组精分明细（§5.2 新口径） */
  jingCombos: GzJingComboRow[];
  /** 精分终值 = Σ 各组得分 */
  jingFinal: number;
  /** 胡牌分（未胡为 0） */
  pattern: number;
  /** 杠分（独立，不含全包杠） */
  gang: number;
  /** 本盘总分 = 精分终值 + 胡牌分 + 杠分 */
  total: number;
  /** 本局得分（交叉结算 + 直付 + 全包） */
  delta: number;
}

/** 赣州冲关 · 四人交叉结算的一笔（低分付高分，§7.2；口径 = 精分 + 杠分） */
export interface GzSettleMove {
  from: number;
  to: number;
  amount: number;
}

/** 赣州冲关 · 直付的一笔 */
export interface GzSettleDirect {
  from: number;
  to: number;
  amount: number;
  kind:
    | 'ron' // 点炮者付胡牌全分
    | 'ron-other' // 点炮时其余两家各付 4
    | 'zimo' // 自摸时三家各付胡牌全分
    | 'pack-gang' // 打出精牌被杠：打出者全包（杠分 + 精分）
    | 'pack-meld' // 打出精牌被吃/碰：打出者全包精分
    | 'pack-hu' // 打出精牌被吃/碰后该家胡牌：打出者承担胡牌分
    | 'chaozhuang'; // 抄庄：庄家给闲家各 10
}

/** 赣州冲关 · 结算负载（t:'settle' 的 gz 字段；南昌对局为 undefined） */
export interface GzSettleMsg {
  winner: number | null;
  /** 流局（只算精分和杠分，§7.5） */
  draw: boolean;
  /** 赢家牌型名（如「精吊·大七对」） */
  patternName: string;
  rows: GzSettleRow[];
  /** 四人两两交叉结算明细（共 6 笔，分差为 0 则不出现在内） */
  moves: GzSettleMove[];
  /** 点炮直付与全包明细 */
  direct: GzSettleDirect[];
}

export type ServerMsg =
  | {
      t: 'state';
      code: string;
      /** 玩法 id（如 'nanchang'） */
      variant: string;
      phase: 'lobby';
      you: number;
      token: string;
      players: SeatPlayer[];
      allReady: boolean;
      /** 房间累计积分（按座位） */
      totals: number[];
      /** 待处理的换位请求（from 发起 → to 目标）；无则 null */
      pendingSwap: { from: number; to: number } | null;
      /** 当前庄家座位（风位随庄：牌桌/大厅的风位都按它换算；未定庄时为首局默认值） */
      dealer: number;
      /** 首局定庄掷骰：已掷者的点数（并列者重掷时会被清空重来） */
      dealerRolls: DealerRoll[];
      /** 首局庄家是否已定（false 时不允许开局） */
      dealerDecided: boolean;
    }
  /** 有人请求与你换位（被请求方收到） */
  | { t: 'swapAsk'; from: number; fromName: string }
  | { t: 'game'; view: GameView }
  | {
      t: 'settle';
      title: string;
      rows: {
        seat: number;
        name: string;
        pi: number;
        fu: number;
        patternIn: number;
        patternOut: number;
        jingIn: number;
        jingOut: number;
        delta: number;
      }[];
      notes: string[];
      totals: { seat: number; name: string; value: number }[];
      /** 赣州冲关结算负载（南昌对局不提供） */
      gz?: GzSettleMsg;
    }
  | { t: 'dissolved'; title: string; rows: { name: string; value: number }[] }
  | { t: 'event'; text: string }
  /** 玩法切换轻量通知（不改动视图；结算/摊牌窗口内广播，客户端仅刷新切换器与提示） */
  | { t: 'variant'; variant: string; totals?: number[]; cleared?: boolean }
  /** 局内聊天广播：seat/name 为发送者，text 为清洗后的正文 */
  | { t: 'chat'; seat: number; name: string; text: string }
  /** 互动表情广播：from 扔给 target（发给**全员**，各端都在 target 的位置播同一段动画） */
  | { t: 'emote'; from: number; target: number; emote: string }
  /** 应用级心跳应答（见 ClientMsg 的 `ping`） */
  | { t: 'pong' }
  | { t: 'error'; reason: string };
