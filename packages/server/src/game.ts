import type {
  CeremonyInfo,
  ClaimKind,
  ClaimOption,
  GameActionKind,
  GameActionLog,
  GameView,
  Meld,
  SelfGangOption,
  Tile,
} from '../../shared/src/index.ts';
import { resolveClaim, type ClaimRequest } from '../../shared/src/resolver.ts';
import { HuLock, type HuLockOutcome } from '../../shared/src/hu-lock.ts';
import {
  nextJing,
  sortTiles,
  tileCounts,
  tileName,
} from '../../shared/src/tiles.ts';
import { classifyPattern } from '../../shared/src/score.ts';
import {
  analyzeWin,
  checkShisanlan,
  isAnyDrawTenpai,
  shapeLabel,
  type WinShape,
} from '../../shared/src/wincheck.ts';
import { buildRecipe, RING_COLS, RING_SLOTS, WallRing, type DealRecipe } from '../../shared/src/wall.ts';
import { getRules, nanchangRules, type RuleSet } from '../../shared/src/rules/index.ts';
import { GZ_CONFIG } from '../../shared/src/rules/gzconfig.ts';
import { gzJingFu, gzJingPublicTiles, type GzJing } from '../../shared/src/gzjing.ts';
import { gzAnalyzeWin, gzIsDezhongde, gzWinLabel, type GzWinFacts } from '../../shared/src/gzwin.ts';
import { gzSettle, type GzSettleOutcome } from '../../shared/src/gzscore.ts';

export type GameEvent =
  | { kind: 'discard'; seat: number; tile: Tile }
  | { kind: 'chi' | 'peng' | 'gang'; seat: number; tile: Tile }
  | { kind: 'declare'; seat: number; tile: Tile }
  | { kind: 'flip'; dice: [number, number]; pi: Tile; fu: Tile }
  | { kind: 'dealRoll'; dice: [number, number] }
  | { kind: 'gangRoll'; seat: number; dice: [number, number] }
  | { kind: 'over' };

/** 胡牌详情（供结算与播报） */
export interface WinInfo {
  seat: number;
  via: 'zimo' | 'ron';
  /** 点炮的那张牌 */
  tile: Tile | null;
  /** 点炮者座位（ron） */
  from: number | null;
  shapes: WinShape[];
  /** 七星十三烂 */
  qixing: boolean;
  german: boolean;
  dezhongde: boolean;
  jingdiao: boolean;
  tiandi: 'tian' | 'di' | null;
  gankai: boolean;
  /** 赣州冲关附加事实（有精 / 精吊 / 德中德 / 底分）；南昌不填 */
  gz?: GzWinFacts;
}

export interface GameConfig {
  code: string;
  dealer: number;
  /** 掷骰补杠开关：杠后掷两骰定位补牌 */
  throwDice: boolean;
  /** 玩法规则集（缺省南昌；未知 id 由 getRules 归一） */
  rules?: RuleSet;
  /** 掷骰仪式（开局点骰子按钮 / 杠后点骰子） */
  ceremony?: boolean;
  /** 开局发牌动画窗口（ms） */
  dealMs?: number;
  /** 杠后掷骰动画窗口（ms） */
  rollMs?: number;
  /** 随机源（默认 Math.random） */
  rng?: () => number;
}

/** 一个响应窗口内的单人询问（用于裁决与执行） */
interface Ask {
  seat: number;
  kind: ClaimKind;
}

interface Pending {
  tile: Tile;
  from: number;
  /** 有操作资格的座位 */
  awaiting: number[];
  /** 已应答（'pass' = 过） */
  responses: Map<number, ClaimRequest | 'pass'>;
  options: Map<number, ClaimOption[]>;
  /** 抢杠窗口（补杠后等待他人抢胡，§6.2）：seat = 补杠者 */
  robKong?: { seat: number };
  /** 本张牌的胡牌锁（一炮一响：同一张牌最多一人胡，见 shared/src/hu-lock.ts） */
  huLock: HuLock;
}

export class Game {
  readonly code: string;
  readonly dealer: number;
  phase: 'playing' | 'over' = 'playing';
  result: string | null = null;
  turn: number;
  hands: Tile[][] = [];
  melds: Meld[][] = [[], [], [], []];
  rivers: Tile[][] = [[], [], [], []];
  wall: Tile[] = [];
  jingPi: Tile | null = null;
  jingFu: Tile | null = null;
  dice: number | null = null;
  /** 开局两骰（点数和 → 庄起逆时针座位；小点数 → 顺时针空列偏移） */
  readonly dealDice: [number, number];
  readonly recipe: DealRecipe;
  readonly ring: WallRing;
  /** 本局规则集（引擎按它分支玩法差异；缺省 = 南昌） */
  readonly rules: RuleSet;
  /** 开局仪式：等待庄家点击掷骰按钮 */
  dealWaitRoll = false;
  dealRollAt: number | null = null;
  dealUntil: number | null = null;
  /** 翻精仪式：发牌动画结束后等待庄家第二次掷骰（和数定位） */
  jingWait = false;
  jingRollAt: number | null = null;
  jingUntil: number | null = null;
  jingDice: [number, number] | null = null;
  /** 正精所在牌墙槽位（翻精定位后下发，供牌墙翻面显示） */
  jingSlot: number | null = null;
  /** 最近一次掷骰（展示：开局 → 翻精 → 杠骰依次覆盖） */
  lastDice: [number, number];
  /** 杠后仪式：等待杠者掷骰（rolling 时 dice 非空） */
  gangCeremony: { seat: number; dice: [number, number] | null; rollAt: number | null; until: number | null } | null =
    null;
  lastDiscard: { tile: Tile; from: number } | null = null;
  pending: Pending | null = null;
  justDrew = false;
  /** 过水：过胡后到自己摸牌前不能再点炮胡 */
  skipRon = [false, false, false, false];
  /** 胡牌（M3 起） */
  winnerSeat: number | null = null;
  winInfo: WinInfo | null = null;
  /** 本局胡牌锁的终局结果（一炮一响的播报与「不能胡同一张牌」回执） */
  huLockOutcome: HuLockOutcome | null = null;
  /** 杠精事件（M4 结算用） */
  gangJingLog: { seat: number; tile: Tile }[] = [];

  // ---------- 赣州冲关（玩法分支，南昌对局下全部保持初始值） ----------
  /** 12 个精位（6 正精 + 6 副精，按牌面计，可重叠）；南昌为 null */
  gzJing: GzJing | null = null;
  /** 打出精牌被吃 / 碰 / 杠的全包账（§5.6）；tiles = 该次进副露的整组牌 */
  gzPacks: { discarder: number; claimer: number; kind: 'chi' | 'peng' | 'gang'; tiles: Tile[] }[] = [];
  /** 杠账（packed = 全包杠：不进交叉结算，改直付） */
  gzGangs: { seat: number; tile: Tile; packed: boolean }[] = [];
  /** 海底（确认口径）：翻出正精所在墩即牌墙尾预留区前缘，该墩及牌墙尾方向不再被摸走 */
  gzHaiCol: number | null = null;
  /** 抄庄（确认口径）：第一轮四家都打出同一张手牌 */
  private firstDiscards: (Tile | null)[] = [null, null, null, null];
  chaozhuang = false;
  /** 报杠（§8.5）：牌面 → 展示者（该三张冻结：不可打、不进吃碰，可参与胡牌判定） */
  declaredKongs: Map<Tile, { seat: number }> = new Map();

  private lastDrawn: Tile | null = null;
  private gangDrawJustNow = false;
  private totalDiscards = 0;
  /** 本局操作记录（出牌 / 吃 / 碰 / 杠 / 胡 / 流局） */
  private actionLog: GameActionLog[] = [];
  private logSeq = 0;
  private rng: () => number;
  private throwDice: boolean;
  private ceremony: boolean;
  private dealMs: number;
  private rollMs: number;
  /** 发牌后槽位 → 牌面（翻精定位用） */
  private slotTile: Tile[] | null = null;

  /** 是否赣州冲关对局（玩法分支总开关） */
  private get gz(): boolean {
    return this.rules.meta.id === 'ganzhou';
  }

  /** 过水开关（南昌默认开；赣州按 flow.skipRon 关） */
  private get skipRonEnabled(): boolean {
    return this.rules.flow.skipRon ?? true;
  }

  /** 杠后是否掷骰定位补牌（关 = 摸牌墙尾；赣州固定摸尾） */
  private get gangDice(): boolean {
    return this.throwDice && this.rules.flow.gangDice;
  }

  /** 报杠（展示三张）是否启用（FlowConfig.declaredKong；仅赣州开） */
  private get declaredEnabled(): boolean {
    return this.rules.flow.declaredKong ?? false;
  }

  /** seat 自己展示而冻结的牌面（不能打、不能进吃碰组合） */
  private frozenFacesOf(seat: number): Tile[] {
    const out: Tile[] = [];
    for (const [tile, d] of this.declaredKongs) if (d.seat === seat) out.push(tile);
    return out;
  }

  /** seat 当前必须打出的牌面：持有**他人**展示的牌面时（任打其一即可）；自己冻结的不算——那些打不了 */
  mustDiscardFor(seat: number): Tile[] {
    if (this.phase !== 'playing' || this.turn !== seat) return [];
    const hand = this.hands[seat] ?? [];
    const out: Tile[] = [];
    for (const [tile, d] of this.declaredKongs) {
      if (d.seat === seat) continue;
      if (hand.includes(tile)) out.push(tile);
    }
    return out;
  }

  constructor(cfg: GameConfig) {
    this.code = cfg.code;
    this.dealer = cfg.dealer;
    this.turn = cfg.dealer;
    this.rng = cfg.rng ?? Math.random;
    this.throwDice = cfg.throwDice;
    this.ceremony = cfg.ceremony ?? false;
    this.dealMs = cfg.dealMs ?? 6500;
    this.rollMs = cfg.rollMs ?? 2600;
    this.rules = cfg.rules ?? nanchangRules;

    // 开局两骰：点数和 → 起牌方位；小点数 → 起牌空列偏移（§5 开局仪式）
    const d1 = this.roll();
    const d2 = this.roll();
    this.dealDice = [d1, d2];
    this.dice = Math.max(d1, d2);
    this.recipe = buildRecipe(cfg.dealer, this.dealDice);
    this.ring = new WallRing(this.recipe);
    this.lastDice = this.dealDice;

    // 牌墙环真实发牌：洗牌铺进环 → 按发牌配方逐槽取给各家
    const deck = this.shuffle(this.rules.tiles.buildDeck());
    const slotTile = new Array<Tile>(RING_SLOTS);
    for (let k = 0; k < RING_SLOTS; k++) {
      slotTile[(this.recipe.startSlot + k) % RING_SLOTS] = deck[k];
    }
    this.hands = [[], [], [], []];
    let jumpLast: Tile | null = null;
    for (const step of this.recipe.steps) {
      for (const s of step.slots) this.hands[step.seat].push(slotTile[s]);
      if (step.kind === 'jump') jumpLast = slotTile[step.slots[step.slots.length - 1]];
    }
    this.lastDrawn = jumpLast;
    this.wall = [];
    for (let i = 0; i < RING_SLOTS; i++) {
      const s = (this.recipe.endSlot + i) % RING_SLOTS;
      if (!this.ring.removed[s]) this.wall.push(slotTile[s]);
    }
    this.slotTile = slotTile;
    this.hands = this.hands.map((h) => sortTiles(h));

    // 翻精：仪式模式等发牌后由庄家第二次掷骰（和数定位、逆时针数列）；
    // 非仪式在构造时按大点数从牌尾翻出
    if (this.gz) {
      if (!this.ceremony) {
        // 两骰之和 → 牌墙尾倒数定位（§3.1）
        const r = this.gzFlip(d1 + d2);
        if (r) this.applyGzFlip(r);
      }
    } else if (!this.ceremony && this.wall.length > 0) {
      const idx = this.wall.length - Math.min(this.dice, this.wall.length);
      this.jingPi = this.wall[idx];
      this.jingFu = nextJing(this.jingPi);
    }
    this.justDrew = true; // 庄家起手 14 张
    if (this.ceremony) this.dealWaitRoll = true;
  }

  private roll(): number {
    return 1 + Math.floor(this.rng() * 6);
  }

  private shuffle(arr: Tile[]): Tile[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- 赣州翻精（§3：牌墙尾倒数 → 6 正精 + 6 副精） ----------

  /** 记录翻精结果（正精墩上张同时作为牌桌展示的正精），并按确认口径预留海底 */
  private applyGzFlip(r: { zheng: Tile[]; fu: Tile[]; slot: number }): void {
    this.gzJing = { zheng: r.zheng, fu: r.fu };
    this.jingPi = r.zheng[0] ?? null;
    this.jingSlot = r.slot >= 0 ? r.slot : null;
    // 海底（确认口径）：正精墩即牌墙尾预留区前缘——该墩及牌墙尾方向不再被摸走，
    // 摸到正精墩前缘仍无人胡牌即流局（“摸牌到翻的精的前一墩视为海底”）
    if (r.slot >= 0) {
      const haiCol = r.slot >> 1;
      this.gzHaiCol = haiCol;
      const rm = this.ring.removed;
      const boundary = ((haiCol * 2 - this.recipe.endSlot) % RING_SLOTS + RING_SLOTS) % RING_SLOTS;
      let drawable = 0;
      for (let i = 0; i < RING_SLOTS; i++) {
        const s = (this.recipe.endSlot + i) % RING_SLOTS;
        if (rm[s]) continue;
        if (i >= boundary) {
          rm[s] = true; // 预留区（正精墩及牌墙尾方向）不再可摸
          continue;
        }
        drawable++;
      }
      if (this.wall.length > drawable) this.wall.length = drawable;
    }
  }

  /**
   * 赣州补牌定位（确认口径）：两骰之和 S → 从**牌墙尾**（可摸区尾部 = 正精墩前缘）倒数第 S 个
   * 非空墩 → 取该墩**上张**（上层已被摸走则取下张）。返回槽位；牌墙头方向已尽时用最近的可用墩，
   * 全不可用返回 -1（调用方按流局处理）。
   */
  private gzLocateTail(sum: number): number {
    const hai = this.gzHaiCol;
    if (hai === null) return -1;
    const rm = this.ring.removed;
    const colEmpty = (col: number): boolean => rm[col * 2] && rm[col * 2 + 1];
    const prev = (col: number): number => ((((col - 1) % RING_COLS) + RING_COLS) % RING_COLS);
    // 倒数第 1 墩 = 正精墩前缘往前第一个非空墩（朝牌墙头方向）
    let col = prev(hai);
    for (let g = 0; g < RING_COLS && colEmpty(col); g++) col = prev(col);
    if (colEmpty(col)) return -1;
    // 继续朝牌墙头数 sum-1 个非空墩
    for (let k = 1; k < sum; k++) {
      let c = prev(col);
      let guard = 0;
      while (colEmpty(c) && guard++ < RING_COLS) c = prev(c);
      if (colEmpty(c)) break; // 牌墙头方向已尽：留在当前墩
      col = c;
    }
    if (!rm[col * 2 + 1]) return col * 2 + 1;
    if (!rm[col * 2]) return col * 2;
    return -1;
  }

  /**
   * 赣州翻精（§3.1 / §3.2 / §3.4）：庄家两骰之和 S → 从**牌墙尾**倒数第 S 墩 → 该墩**上张**
   * 即翻出的**明面正精**；
   * 正精 6 张 = 正精墩 + 前邻墩（朝牌墙尾）+ 后邻墩（朝牌墙头）的上下张，
   *   其中 `zheng[0]`（正精墩上张）公开，其余 5 张为**隐藏正精**，全程扣放；
   * 副精 6 张 = 每张正精的**下一张序数牌**（`gzJingFu`，一万→二万），与牌墙位置无关，
   *   其中 `fu[0]`（明面正精对应的那张）随翻精一并公开，其余 5 张结算揭晓。
   */
  private gzFlip(sum: number): { zheng: Tile[]; fu: Tile[]; slot: number } | null {
    if (!this.slotTile) return null;
    {
      const rm = this.ring.removed;
      const colEmpty = (col: number): boolean => rm[col * 2] && rm[col * 2 + 1];
      const step = (from: number, dir: number): number => {
        let c = from;
        for (let guard = 0; guard < RING_COLS; guard++) {
          c = dir < 0 ? ((((c - 1) % RING_COLS) + RING_COLS) % RING_COLS) : (c + 1) % RING_COLS;
          if (!colEmpty(c)) return c;
        }
        return from;
      };
      // 牌墙尾：front 逆环向第一个未取走的槽所在墩
      let tailCol = -1;
      for (let i = 1; i <= RING_SLOTS; i++) {
        const s = (((this.ring.front - i) % RING_SLOTS) + RING_SLOTS) % RING_SLOTS;
        if (!rm[s]) {
          tailCol = s >> 1;
          break;
        }
      }
      if (tailCol < 0) return null;
      // 从尾往头数第 sum 个非空墩 = 正精墩
      let col = tailCol;
      for (let k = 1; k < sum; k++) col = step(col, -1);
      // 列号 +1 = 朝牌墙尾方向（环上取牌顺序递增：牌墙头 front → 牌墙尾）
      const cols = [col, step(col, +1), step(col, -1)]; // 正精墩 + 前邻（朝尾）+ 后邻（朝头）
      const zheng: Tile[] = [];
      for (const c of cols) {
        for (const layer of [1, 0]) zheng.push(this.slotTile[c * 2 + layer]);
      }
      // 副精 = 每张正精的下一张序数牌（§3.4，2026-10-16 修订口径）——只看牌面，
      // 与牌墙位置 / 取牌顺序无关。fu[i] 与 zheng[i] 一一对应，fu[0] 是翻精时公开的那张。
      const fu = gzJingFu(zheng);
      return { zheng, fu, slot: cols[0] * 2 + 1 };
    }
  }

  // ---------- 视图 ----------

  /** 过期的杠骰动画窗口懒清理 */
  private pruneCeremony(): void {
    const g = this.gangCeremony;
    if (g && g.until !== null && Date.now() >= g.until) this.gangCeremony = null;
  }

  /** 阶段推进：发牌动画窗口结束 → 进入翻精等待（仅仪式模式，等待不超时——不点就卡住） */
  private advancePhases(): void {
    this.pruneCeremony();
    if (
      this.ceremony &&
      this.dealRollAt !== null &&
      this.dealUntil !== null &&
      Date.now() >= this.dealUntil &&
      !this.jingWait &&
      this.jingRollAt === null
    ) {
      this.jingWait = true;
    }
  }

  /** 仪式模式下翻精骰掷出前不下发精（防剧透） */
  private jingVisible(): boolean {
    return !this.ceremony || this.jingRollAt !== null;
  }

  /** 当前掷骰仪式（无则 null） */
  private ceremonyInfo(): CeremonyInfo | null {
    if (this.phase !== 'playing') return null;
    if (this.dealWaitRoll) {
      return { kind: 'deal', state: 'wait-roll', seat: this.dealer, dice: null, rollAt: null, until: null };
    }
    if (this.dealRollAt !== null && this.dealUntil !== null && Date.now() < this.dealUntil) {
      return {
        kind: 'deal',
        state: 'rolling',
        seat: this.dealer,
        dice: this.dealDice,
        rollAt: this.dealRollAt,
        until: this.dealUntil,
      };
    }
    if (this.jingWait) {
      return { kind: 'jing', state: 'wait-roll', seat: this.dealer, dice: null, rollAt: null, until: null };
    }
    if (this.jingRollAt !== null && this.jingUntil !== null && Date.now() < this.jingUntil) {
      return {
        kind: 'jing',
        state: 'rolling',
        seat: this.dealer,
        dice: this.jingDice,
        rollAt: this.jingRollAt,
        until: this.jingUntil,
      };
    }
    const g = this.gangCeremony;
    if (g) {
      if (g.dice === null) {
        return { kind: 'gang', state: 'wait-roll', seat: g.seat, dice: null, rollAt: null, until: null };
      }
      if (g.until !== null && Date.now() < g.until) {
        return { kind: 'gang', state: 'rolling', seat: g.seat, dice: g.dice, rollAt: g.rollAt, until: g.until };
      }
    }
    return null;
  }

  /** 仪式期间禁止行牌动作 */
  private assertNoRitual(): void {
    this.advancePhases();
    const c = this.ceremonyInfo();
    if (c === null) return;
    throw new Error(
      c.kind === 'deal'
        ? '开局掷骰仪式进行中'
        : c.kind === 'jing'
          ? '翻精掷骰进行中'
          : '杠后掷骰补牌中',
    );
  }

  viewFor(seat: number, deadline: number | null): GameView {
    this.advancePhases();
    const ceremony = this.ceremonyInfo();
    const ritual = ceremony !== null;
    const p = this.pending;
    let claims: GameView['claims'] = null;
    if (p && p.awaiting.includes(seat) && !p.responses.has(seat)) {
      claims = { options: p.options.get(seat) ?? [], deadline: deadline ?? 0 };
    }
    const canTurn =
      this.phase === 'playing' &&
      this.turn === seat &&
      this.justDrew &&
      !this.pending &&
      !ritual;
    const zimoWin = canTurn ? this.buildWin(seat, 'zimo', null, null) : null;
    return {
      code: this.code,
      phase: this.phase,
      dealer: this.dealer,
      turn: this.turn,
      mySeat: seat,
      myTiles: sortTiles(this.hands[seat] ?? []),
      counts: this.hands.map((h) => h.length),
      melds: this.melds.map((m) => m.map((x) => ({ ...x, tiles: [...x.tiles] }))),
      rivers: this.rivers.map((r) => [...r]),
      wallLeft: this.wall.length,
      jingPi: this.jingVisible() ? this.jingPi : null,
      jingFu: this.jingVisible() ? this.jingFu : null,
      dice: this.dice,
      dealDice: this.dealDice,
      lastDice: this.lastDice,
      jingSlot: this.jingVisible() ? this.jingSlot : null,
      ceremony,
      wallRing: { recipe: this.recipe, frontSlot: this.ring.front, kongSlots: [...this.ring.kongSlots] },
      lastDiscard: this.lastDiscard ? { ...this.lastDiscard } : null,
      claimWindow: this.pending !== null,
      claims: ritual ? null : claims,
      selfGangs:
        this.phase === 'playing' && this.turn === seat && this.justDrew && !this.pending && !ritual
          ? this.selfGangOptions(seat)
          : [],
      declareOptions: ritual ? [] : this.declareOptionsFor(seat),
      declared: [...this.declaredKongs].map(([tile, d]) => ({ seat: d.seat, tile })),
      mustDiscard: this.mustDiscardFor(seat),
      canZimo: zimoWin !== null && !ritual,
      zimoLabel: zimoWin && !ritual ? this.labelOf(zimoWin) : null,
      drawn:
        this.phase === 'playing' && this.turn === seat && this.justDrew && this.lastDrawn !== null && !ritual
          ? this.lastDrawn
          : null,
      connected: [true, true, true, true],
      auto: [false, false, false, false],
      names: ['', '', '', ''],
      totals: [0, 0, 0, 0],
      hostSeat: 0,
      windowDeadline: this.pending ? deadline : null,
      awaiting: this.pending
        ? this.pending.awaiting.filter((s) => !this.pending!.responses.has(s))
        : [],
      skipRon: this.skipRon[seat],
      reveal:
        this.phase === 'over' && this.winnerSeat !== null
          ? this.hands.map((h) => sortTiles(h))
          : null,
      gz: this.gzJingView(),
      winner: this.phase === 'over' ? this.winnerSeat : null,
      result: this.result,
      log: [...this.actionLog],
      lastAction: this.actionLog.length > 0 ? this.actionLog[this.actionLog.length - 1] : null,
    };
  }

  /**
   * 赣州精牌视图（§3.6 三类精牌的可见性出口）：
   * - 对局中：只公开**明面正精 `zheng[0]`** 与**它对应的副精 `fu[0]`** 两张；
   *   5 张隐藏正精 + 5 张隐藏副精一律不下发（规则 4：玩家不可见）。
   * - phase=over（结算）：12 张全部揭晓，供翻牌确认归属。
   */
  private gzJingView(): GameView['gz'] {
    if (!this.gz || !this.gzJing) return null;
    const revealed = this.phase === 'over';
    const flipped = this.jingVisible() && this.jingPi !== null;
    if (revealed) {
      const all = gzJingPublicTiles(this.gzJing, true);
      return { zheng: all.zheng, fu: all.fu, revealed };
    }
    if (!flipped) return { zheng: [], fu: [], revealed: false };
    const pub = gzJingPublicTiles(this.gzJing, false);
    return { zheng: pub.zheng, fu: pub.fu, revealed: false };
  }

  private selfGangOptions(seat: number): SelfGangOption[] {
    const c = tileCounts(this.hands[seat]);
    const out: SelfGangOption[] = [];
    for (let t = 0; t < 34; t++) {
      if (c[t] === 4) out.push({ kind: 'angang', tile: t });
      if (c[t] >= 1 && this.melds[seat].some((m) => m.type === 'peng' && m.tiles[0] === t)) {
        out.push({ kind: 'bugang', tile: t });
      }
    }
    return out;
  }

  /** 我当前可「展示三张」的牌面：自己回合、无响应窗口、手牌恰好 3 张且未被挂起（§8.5） */
  private declareOptionsFor(seat: number): Tile[] {
    if (!this.declaredEnabled || this.phase !== 'playing' || this.turn !== seat || this.pending) return [];
    const c = tileCounts(this.hands[seat]);
    const out: Tile[] = [];
    for (let t = 0; t < 34; t++) {
      if (c[t] === 3 && !this.declaredKongs.has(t)) out.push(t);
    }
    return out;
  }

  /** 报杠（§8.5）：展示手牌中恰好 3 张的同牌面 → 冻结这三张，他家此后必须打出第 4 张 */
  declareKong(seat: number, tile: Tile): GameEvent[] {
    this.assertPlaying();
    this.assertNoRitual();
    if (!this.declaredEnabled) throw new Error('本玩法没有报杠');
    if (this.pending) throw new Error('响应窗口未结束');
    if (this.turn !== seat) throw new Error('还没轮到你');
    if (this.declaredKongs.has(tile)) throw new Error('这张牌已经有人展示');
    const c = tileCounts(this.hands[seat]);
    if (c[tile] !== 3) throw new Error('手里没有恰好三张');
    this.declaredKongs.set(tile, { seat });
    return [{ kind: 'declare', seat, tile }];
  }

  // ---------- 行牌 ----------

  /** 出牌；若开出响应窗口或直接推进，返回事件 */
  discard(seat: number, tile: Tile): GameEvent[] {
    this.assertPlaying();
    this.assertNoRitual();
    if (this.pending) throw new Error('响应窗口未结束');
    if (this.turn !== seat) throw new Error('还没轮到你');
    // 报杠（§8.5）：自己展示的三张不能打；持有他人展示的牌面时必须先打它
    if (this.declaredEnabled) {
      if (this.declaredKongs.get(tile)?.seat === seat) throw new Error('已展示的牌须等杠');
      const must = this.mustDiscardFor(seat);
      if (must.length > 0 && !must.includes(tile)) {
        throw new Error(`必须先打出 ${tileName(must[0])}`);
      }
    }
    const hand = this.hands[seat];
    const idx = hand.indexOf(tile);
    if (idx < 0) throw new Error('手里没有这张牌');
    hand.splice(idx, 1);
    this.rivers[seat].push(tile);
    this.lastDiscard = { tile, from: seat };
    this.justDrew = false;
    this.gangDrawJustNow = false;
    this.totalDiscards++;
    // 抄庄检测（确认口径）：第一轮四家都打出同一张手牌 → 触发
    if (this.gz && !this.chaozhuang) {
      if (this.firstDiscards[seat] === null) {
        this.firstDiscards[seat] = tile;
        const all = this.firstDiscards.every((t) => t !== null);
        if (all && this.firstDiscards.every((t) => t === this.firstDiscards[0])) {
          this.chaozhuang = true;
        }
      }
    }
    const events: GameEvent[] = [{ kind: 'discard', seat, tile }];
    this.pushLog('discard', seat, [tile]);

    // 并行响应：所有能操作的人同时拿到全部选项，一个15秒窗口内应答
    const options = new Map<number, ClaimOption[]>();
    const awaiting: number[] = [];
    for (let s = 0; s < 4; s++) {
      if (s === seat) continue;
      const opts = this.claimOptionsFor(s, seat, tile);
      if (opts.length > 0) {
        options.set(s, opts);
        awaiting.push(s);
      }
    }
    // 报杠（§8.5）：被展示的牌面被打出 → 声明者的「杠」预填（不进 awaiting、不再询问），
    // 他家只剩「胡」（options 里本就只有 hu）；杠应答即时成立，等的只是「有没有人胡」。
    const dk = this.declaredEnabled ? this.declaredKongs.get(tile) : undefined;
    let prefilled: ClaimRequest | null = null;
    if (dk && dk.seat !== seat) {
      const decl = dk.seat;
      options.delete(decl);
      const i = awaiting.indexOf(decl);
      if (i >= 0) awaiting.splice(i, 1);
      prefilled = { seat: decl, kind: 'gang' };
    }

    if (awaiting.length > 0 || prefilled) {
      this.pending = {
        tile,
        from: seat,
        awaiting,
        responses: new Map(),
        options,
        huLock: new HuLock(tile, seat, this.dealer),
      };
      if (prefilled) this.pending.responses.set(prefilled.seat, prefilled);
      // 没人可胡（awaiting 空）→ 立即裁决，杠直接成立（否则牌会被 advanceTurn 放走）
      if (awaiting.length === 0) return this.resolvePending();
    } else {
      events.push(...this.advanceTurn());
    }
    return events;
  }

  private claimOptionsFor(seat: number, from: number, tile: Tile): ClaimOption[] {
    const opts: ClaimOption[] = [];
    const c = tileCounts(this.hands[seat]);
    if (seat !== from) {
      // 点炮胡：全部选项同时给出；点炮的精只能当本身（规则 3）
      if (!this.skipRon[seat]) {
        const wi = this.buildWin(seat, 'ron', tile, from);
        if (wi) opts.push({ kind: 'hu', tile, label: this.labelOf(wi) });
      }
      // 报杠牌面（§8.5）：他家只可胡；声明者只杠（碰/吃一律不给，杠由 discard 预填）
      const dk = this.declaredEnabled ? this.declaredKongs.get(tile) : undefined;
      if (dk) {
        if (dk.seat === seat && c[tile] >= 3) opts.push({ kind: 'gang', tile });
        return opts;
      }
      if (c[tile] >= 3) opts.push({ kind: 'gang', tile });
      if (c[tile] >= 2) opts.push({ kind: 'peng', tile });
      if (seat === (from + 1) % 4) {
        // 吃法由玩法声明（赣州乱风：字牌任意 3 张不重复成组）
        const chis = this.rules.tiles.chiOptions(this.hands[seat], tile);
        // 用到自己冻结（已展示）牌面的吃法不可用（§8.5：冻结不进吃碰组合）
        const frozen = new Set(this.frozenFacesOf(seat));
        const usable = frozen.size > 0 ? chis.filter((ch) => ch.every((t) => !frozen.has(t))) : chis;
        if (usable.length > 0) opts.push({ kind: 'chi', tile, chiChoices: usable });
      }
    }
    return opts;
  }

  /** 响应窗口内：给出全部可做操作，全部应答（或超时）后按 胡>杠>碰>吃 裁决；
   *  多人可胡时按从庄家起的座位顺序取第一个点「胡」的（§5.1 一炮只一响）。
   *  窗口已被他人结算（并发应答）时静默忽略——「过」本身就是「不做任何事」。 */
  respond(seat: number, intent: ClaimRequest | 'pass'): GameEvent[] {
    this.assertPlaying();
    const p = this.pending;
    if (!p) return []; // 一炮多响等并发场景下窗口可能已被收走，此时忽略比报错更贴切
    if (!p.awaiting.includes(seat)) throw new Error('你没有可做的操作');
    if (p.responses.has(seat)) throw new Error('已经操作过了');
    const opts = p.options.get(seat) ?? [];
    if (intent === 'pass') {
      // 过胡 → 过水（到自己摸牌前不能再点炮胡；赣州按 flow.skipRon 关闭）
      if (this.skipRonEnabled && opts.some((o) => o.kind === 'hu')) this.skipRon[seat] = true;
    } else {
      if (!opts.some((o) => o.kind === intent.kind)) throw new Error('不可执行该操作');
      if (intent.kind === 'chi') {
        const opt = opts.find((o) => o.kind === 'chi');
        const valid = opt?.chiChoices?.some(
          (c) =>
            intent.chiTiles?.length === 2 &&
            c[0] === intent.chiTiles[0] &&
            c[1] === intent.chiTiles[1],
        );
        if (!valid) throw new Error('吃牌组合不合法');
      }
    }
    p.responses.set(seat, intent);
    if (intent !== 'pass' && intent.kind === 'hu') {
      // 一炮一响：本张牌的胡牌锁**按庄位顺序依次尝试加锁**（不按点击先后）——
      // 更靠前的座位可抢占，被抢占 / 被前位挡下的座位即「本张牌不能胡」（结果见 huLockOutcome）
      p.huLock.attempt(seat);
      // 窗口里若还有别的能胡的人未应答，等齐后按 庄家→下家→对家→上家 取第一个点「胡」的结算；
      // 仅「只有一人能胡」时立即结算
      const othersCanHu = p.awaiting.some(
        (s) => s !== seat && !p.responses.has(s) && (p.options.get(s) ?? []).some((o) => o.kind === 'hu'),
      );
      if (!othersCanHu) return this.resolvePending();
      return [];
    }
    // 收齐**被询问者**的应答才裁决——报杠窗口里声明者的「杠」是预填响应、不在 awaiting 里，
    // 用 every 判齐（responses.size === awaiting.length 会被预填多算一份而永不齐）
    if (p.awaiting.every((s) => p.responses.has(s))) return this.resolvePending();
    return [];
  }

  /** 超时：未应答者视为过（有胡则记过水） */
  expireWindow(): GameEvent[] {
    const p = this.pending;
    if (!p) return [];
    for (const s of p.awaiting) {
      if (p.responses.has(s)) continue;
      const opts = p.options.get(s) ?? [];
      if (this.skipRonEnabled && opts.some((o) => o.kind === 'hu')) this.skipRon[s] = true;
      p.responses.set(s, 'pass');
    }
    return this.resolvePending();
  }

  /** 收齐应答（或胡被接受）→ 按优先级裁决并执行 */
  private resolvePending(): GameEvent[] {
    const p = this.pending!;
    const claims: ClaimRequest[] = [];
    for (const [seat, r] of p.responses) {
      if (r !== 'pass') claims.push(r);
    }
    const chosen = resolveClaim(p.from, this.dealer, claims);
    // 定锁（幂等）：登记赢家与被排除的胡牌请求。与上一行裁决共用同一顺序基准，两者恒一致。
    const lock = p.huLock.finalize();

    // 抢杠窗口（§6.2）：有人胡 → 撤回补杠、胡牌者赢；无人胡 → 补杠成立并补牌
    if (p.robKong) {
      this.pending = null;
      if (chosen && chosen.kind === 'hu') {
        this.revertBugang(p.robKong.seat, p.tile);
        const info = this.buildWin(chosen.seat, 'ron', p.tile, p.robKong.seat);
        if (info) {
          this.applyWin(info, lock);
          return [];
        }
      }
      this.logGang(p.robKong.seat, p.tile, false);
      this.pushLog('bugang', p.robKong.seat, [p.tile, p.tile, p.tile, p.tile]);
      return this.drawReplacement();
    }

    if (!chosen) {
      this.pending = null;
      return this.advanceTurn();
    }
    return this.applyAsk(chosen.seat, { seat: chosen.seat, kind: chosen.kind }, chosen.chiTiles);
  }

  /** 执行被接受的操作 */
  private applyAsk(seat: number, ask: Ask, chiTiles?: Tile[]): GameEvent[] {
    const p = this.pending!;
    const tile = p.tile;
    const from = p.from;
    this.pending = null;

    if (ask.kind === 'hu') {
      // 点炮胡：赢的牌留在牌河展示，不收回
      const info = this.buildWin(seat, 'ron', tile, from);
      if (info) {
        this.applyWin(info, p.huLock.finalize());
        return [];
      }
      return this.advanceTurn();
    }
    // 赣州：打出精牌被吃 / 碰 / 杠 → 打出者全包（§5.6 + 确认口径）；
    // 全包范围 = 该次的杠分 + 进副露这整组牌的精分（不进交叉结算）。
    // 注：这里认的是「明面正精 / 明面副精」——隐藏正精不算做精使用，不触发全包。
    const packed =
      this.gz && this.gzJing !== null && (tile === this.gzJing.zheng[0] || tile === this.gzJing.fu[0])
        ? {
            discarder: from,
            claimer: seat,
            kind: ask.kind,
            tiles:
              ask.kind === 'gang'
                ? [tile, tile, tile, tile]
                : ask.kind === 'peng'
                  ? [tile, tile, tile]
                  : sortTiles([tile, ...(chiTiles ?? [])]),
          }
        : null;
    if (packed) this.gzPacks.push(packed);
    // 被吃的牌从牌河收回
    this.rivers[from].pop();
    this.lastDiscard = null;
    const hand = this.hands[seat];
    const events: GameEvent[] = [];
    if (ask.kind === 'peng') {
      this.pull(hand, tile, 2);
      this.melds[seat].push({ type: 'peng', tiles: [tile, tile, tile], from });
      this.turn = seat;
      this.justDrew = false;
      events.push({ kind: 'peng', seat, tile });
      this.pushLog('peng', seat, [tile, tile, tile]);
    } else if (ask.kind === 'gang') {
      this.pull(hand, tile, 3);
      // 报杠（§8.5）：声明者的预填杠执行后撤销声明（自摸路径的撤销见 autoGangDeclared）
      if (this.declaredEnabled && this.declaredKongs.get(tile)?.seat === seat) {
        this.declaredKongs.delete(tile);
      }
      this.melds[seat].push({ type: 'gang', tiles: [tile, tile, tile, tile], from });
      this.turn = seat;
      events.push({ kind: 'gang', seat, tile });
      this.pushLog('gang', seat, [tile, tile, tile, tile]);
      this.logGang(seat, tile, packed !== null);
      events.push(...this.drawReplacement());
    } else {
      const use = chiTiles!;
      this.pull(hand, use[0], 1);
      this.pull(hand, use[1], 1);
      this.melds[seat].push({
        type: 'chi',
        tiles: sortTiles([tile, use[0], use[1]]),
        from,
      });
      this.turn = seat;
      this.justDrew = false;
      events.push({ kind: 'chi', seat, tile });
      this.pushLog('chi', seat, sortTiles([tile, use[0], use[1]]));
    }
    return events;
  }

  /** 暗杠 / 补杠（须在自己回合、刚摸完牌、无响应窗口时） */
  selfGang(seat: number, kind: 'angang' | 'bugang', tile: Tile): GameEvent[] {
    this.assertPlaying();
    this.assertNoRitual();
    if (this.pending) throw new Error('响应窗口未结束');
    if (this.turn !== seat || !this.justDrew) throw new Error('还没轮到你');
    const hand = this.hands[seat];
    const c = tileCounts(hand);
    if (kind === 'angang') {
      if (c[tile] !== 4) throw new Error('手里没有这 4 张牌');
      this.pull(hand, tile, 4);
      this.melds[seat].push({ type: 'angang', tiles: [tile, tile, tile, tile], from: seat });
      const events: GameEvent[] = [{ kind: 'gang', seat, tile }];
      this.pushLog('angang', seat, [tile, tile, tile, tile]);
      this.logGang(seat, tile, false);
      events.push(...this.drawReplacement());
      return events;
    }
    const meld = this.melds[seat].find((m) => m.type === 'peng' && m.tiles[0] === tile);
    if (!meld || c[tile] < 1) throw new Error('无法补杠');
    this.pull(hand, tile, 1);
    meld.type = 'gang';
    meld.tiles = [tile, tile, tile, tile];
    // 允许抢杠胡的玩法（赣州，§6.2）：先开窗口等其余三家，无人抢再补牌
    if (this.rules.actions.robbingKong) return this.openRobWindow(seat, tile);
    const events: GameEvent[] = [{ kind: 'gang', seat, tile }];
    this.pushLog('bugang', seat, [tile, tile, tile, tile]);
    this.logGang(seat, tile, false);
    events.push(...this.drawReplacement());
    return events;
  }

  /** 抢杠窗口：补杠后其余三家可胡这张；无人能抢则补杠直接成立并补牌 */
  private openRobWindow(seat: number, tile: Tile): GameEvent[] {
    const options = new Map<number, ClaimOption[]>();
    const awaiting: number[] = [];
    for (let s = 0; s < 4; s++) {
      if (s === seat) continue;
      const info = this.buildWin(s, 'ron', tile, seat);
      if (info) {
        options.set(s, [{ kind: 'hu', tile, label: this.labelOf(info) }]);
        awaiting.push(s);
      }
    }
    if (awaiting.length === 0) {
      this.pushLog('bugang', seat, [tile, tile, tile, tile]);
      this.logGang(seat, tile, false);
      return this.drawReplacement();
    }
    this.pending = {
      tile,
      from: seat,
      awaiting,
      responses: new Map(),
      options,
      robKong: { seat },
      huLock: new HuLock(tile, seat, this.dealer),
    };
    return [];
  }

  /** 抢杠胡 → 撤回补杠：副露改回碰、牌归还手牌（杠分不计，补牌不发生） */
  private revertBugang(seat: number, tile: Tile): void {
    const meld = this.melds[seat].find((m) => m.type === 'gang' && m.tiles[0] === tile);
    if (meld) {
      meld.type = 'peng';
      meld.tiles = [tile, tile, tile];
    }
    this.hands[seat].push(tile);
    this.hands[seat] = sortTiles(this.hands[seat]);
  }

  /** 杠成立记账：南昌记杠精事件；赣州记杠分（packed = 全包杠，不进交叉结算） */
  private logGang(seat: number, tile: Tile, packed: boolean): void {
    if (this.gz) {
      this.gzGangs.push({ seat, tile, packed });
      return;
    }
    this.logGangJing(seat, tile);
  }

  /** 追加一条操作日志（上限 500 条，超出丢最旧） */
  private pushLog(kind: GameActionKind, seat: number, tiles: Tile[], note?: string): void {
    this.actionLog.push({ seq: ++this.logSeq, kind, seat, tiles, note });
    if (this.actionLog.length > 500) this.actionLog.shift();
  }

  /** 杠的牌是正精/副精 → 记入结算 */
  private logGangJing(seat: number, tile: Tile): void {
    if (this.jingPi !== null && (tile === this.jingPi || tile === this.jingFu)) {
      this.gangJingLog.push({ seat, tile });
    }
  }

  /** 每家归属精点数（正精 ×2 + 副精 ×1）；点炮的精归赢家 */
  wildPoints(): number[] {
    const out = [0, 0, 0, 0];
    const pts = (t: Tile): number => (t === this.jingPi ? 2 : t === this.jingFu ? 1 : 0);
    for (let s = 0; s < 4; s++) {
      let n = 0;
      for (const t of this.hands[s]) n += pts(t);
      for (const m of this.melds[s]) for (const t of m.tiles) n += pts(t);
      for (const t of this.rivers[s]) n += pts(t);
      out[s] = n;
    }
    const wi = this.winInfo;
    if (wi && wi.via === 'ron' && wi.tile !== null && wi.from !== null) {
      const p = pts(wi.tile);
      if (p > 0) {
        out[wi.from] -= p; // 牌河中的点炮精转给赢家
        out[wi.seat] += p;
      }
    }
    return out;
  }

  /** 每家正精/副精的张数（含点炮牌转移）——结算展示用 */
  wildTileCounts(): { pi: number; fu: number }[] {
    const out = [0, 1, 2, 3].map(() => ({ pi: 0, fu: 0 }));
    const bump = (s: number, t: Tile): void => {
      if (t === this.jingPi) out[s].pi++;
      else if (t === this.jingFu) out[s].fu++;
    };
    for (let s = 0; s < 4; s++) {
      for (const t of this.hands[s]) bump(s, t);
      for (const m of this.melds[s]) for (const t of m.tiles) bump(s, t);
      for (const t of this.rivers[s]) bump(s, t);
    }
    const wi = this.winInfo;
    if (wi && wi.via === 'ron' && wi.tile !== null && wi.from !== null) {
      if (wi.tile === this.jingPi || wi.tile === this.jingFu) {
        if (wi.tile === this.jingPi) out[wi.from].pi--;
        else out[wi.from].fu--;
        bump(wi.seat, wi.tile);
      }
    }
    return out;
  }

  /** 杠后补牌：仪式开 → 先等杠者点骰子按钮；否则立即掷骰定位补牌（关 = 取牌尾；赣州固定摸尾） */
  private drawReplacement(): GameEvent[] {
    if (this.wall.length === 0) return this.over();
    if (this.ceremony && this.gangDice) {
      this.gangCeremony = { seat: this.turn, dice: null, rollAt: null, until: null };
      return [];
    }
    return this.doGangDraw();
  }

  /** 执行杠补。赣州（确认口径）：两骰和 S → 从牌墙尾（可摸区尾部 = 正精墩前缘）倒数第 S 墩，
   *  上层在取上层、无上层取下层；南昌：从起牌列（摸牌处）逆时针数 S 列（与南昌翻精同一公式）。 */
  private doGangDraw(): GameEvent[] {
    if (this.wall.length === 0) return this.over();
    const evs: GameEvent[] = [];
    let idx: number;
    if (this.gz && this.gzHaiCol !== null) {
      const d: [number, number] = [this.roll(), this.roll()];
      const sum = d[0] + d[1];
      this.dice = Math.max(d[0], d[1]);
      this.lastDice = d;
      evs.push({ kind: 'gangRoll', seat: this.turn, dice: d });
      if (this.ceremony) {
        const now = Date.now();
        this.gangCeremony = { seat: this.turn, dice: d, rollAt: now, until: now + this.rollMs };
      }
      const slot = this.gzLocateTail(sum);
      if (slot < 0) return this.over();
      idx = this.ring.indexOfFromFront(slot);
      this.ring.remove(slot);
    } else if (this.gangDice) {
      const d: [number, number] = [this.roll(), this.roll()];
      this.dice = Math.max(d[0], d[1]);
      this.lastDice = d;
      const slot = this.ring.locate(d);
      if (slot >= 0) {
        idx = this.ring.indexOfFromFront(slot);
        this.ring.remove(slot);
      } else {
        idx = this.wall.length - 1;
        this.ring.takeTail();
      }
      evs.push({ kind: 'gangRoll', seat: this.turn, dice: d });
      if (this.ceremony) {
        const now = Date.now();
        this.gangCeremony = { seat: this.turn, dice: d, rollAt: now, until: now + this.rollMs };
      }
    } else {
      idx = this.wall.length - 1;
      this.ring.takeTail();
    }
    const [t] = this.wall.splice(idx, 1);
    this.hands[this.turn].push(t);
    this.justDrew = true;
    this.lastDrawn = t;
    this.gangDrawJustNow = true;
    this.skipRon[this.turn] = false; // 摸牌解除过水
    return [...evs, ...this.autoGangDeclared(t)];
  }

  /** 仪式掷骰：开局由庄家、翻精由庄家、杠后由杠者点击触发 */
  rollDice(seat: number): GameEvent[] {
    this.assertPlaying();
    this.advancePhases();
    if (this.dealWaitRoll) {
      if (seat !== this.dealer) throw new Error('只有庄家可以掷骰');
      this.dealWaitRoll = false;
      const now = Date.now();
      this.dealRollAt = now;
      this.dealUntil = now + this.dealMs;
      return [{ kind: 'dealRoll', dice: this.dealDice }];
    }
    if (this.jingWait) {
      // 第二次掷骰。南昌：和数 S → 起牌列逆时针第 S 列的上层 = 正精（牌墙原位翻面显示）。
      // 赣州：和数 S → 牌墙尾倒数第 S 墩的上张 = 正精墩上张，另推出 5 正精 + 6 副精（§3）。
      if (seat !== this.dealer) throw new Error('只有庄家可以掷骰');
      this.jingWait = false;
      const d1 = this.roll();
      const d2 = this.roll();
      const jd: [number, number] = [d1, d2];
      const sum = d1 + d2;
      this.jingDice = jd;
      this.lastDice = jd;
      this.dice = Math.max(d1, d2);
      const evs: GameEvent[] = [];
      if (this.gz) {
        if (!this.gzJing) {
          const r = this.gzFlip(sum);
          if (r) this.applyGzFlip(r);
        }
        if (this.gzJing && this.jingPi !== null) {
          evs.push({ kind: 'flip', dice: jd, pi: this.jingPi, fu: this.gzJing.fu[0] ?? this.jingPi });
        }
      } else {
        const slot = this.ring.locate(jd);
        this.jingSlot = slot >= 0 ? slot : null;
        if (slot >= 0 && this.slotTile) this.jingPi = this.slotTile[slot];
        if (this.jingPi !== null) this.jingFu = nextJing(this.jingPi);
        if (this.jingPi !== null && this.jingFu !== null) {
          evs.push({ kind: 'flip', dice: jd, pi: this.jingPi, fu: this.jingFu });
        }
      }
      const now = Date.now();
      this.jingRollAt = now;
      this.jingUntil = now + this.rollMs;
      return evs;
    }
    const g = this.gangCeremony;
    if (g && g.dice === null) {
      if (seat !== g.seat) throw new Error('只有杠牌者可以掷骰');
      return this.doGangDraw();
    }
    throw new Error('当前无需掷骰');
  }

  private advanceTurn(): GameEvent[] {
    this.turn = (this.turn + 1) % 4;
    if (this.wall.length === 0) return this.over();
    const t = this.wall.shift()!;
    this.ring.takeFront(); // 牌墙对应槽位同步减少（渲染动画用）
    this.hands[this.turn].push(t);
    this.justDrew = true;
    this.lastDrawn = t;
    this.gangDrawJustNow = false;
    this.skipRon[this.turn] = false; // 摸牌解除过水
    return this.autoGangDeclared(t);
  }

  /**
   * 报杠·自摸第 4 张（§8.5-5）：摸到**自己展示**的牌面 → 立即自动杠（4 张全进副露、记杠分）
   * 并走 `drawReplacement()` 掷骰补牌（允许连杠：补牌也可能摸到另一副的第 4 张；牌墙尽则流局）。
   * 摸牌入口有两处——`advanceTurn()`（正常摸牌）与 `doGangDraw()`（杠后补牌），两处都要触发。
   */
  private autoGangDeclared(t: Tile): GameEvent[] {
    if (!this.declaredEnabled) return [];
    const d = this.declaredKongs.get(t);
    if (!d || d.seat !== this.turn) return [];
    const seat = this.turn;
    this.declaredKongs.delete(t);
    this.pull(this.hands[seat], t, 4); // 3 张冻结 + 刚摸的第 4 张
    this.melds[seat].push({ type: 'gang', tiles: [t, t, t, t], from: seat }); // 已明示 → 全明面显示
    const events: GameEvent[] = [{ kind: 'gang', seat, tile: t }];
    this.logGang(seat, t, false);
    events.push(...this.drawReplacement());
    return events;
  }

  /** 自摸胡 */
  zimo(seat: number): GameEvent[] {
    this.assertPlaying();
    this.assertNoRitual();
    if (this.pending) throw new Error('响应窗口未结束');
    if (this.turn !== seat || !this.justDrew) throw new Error('还没轮到你');
    const info = this.buildWin(seat, 'zimo', null, null);
    if (!info) throw new Error('当前手牌还不能胡');
    this.applyWin(info);
    return [];
  }

  /** 构建胡牌详情（按玩法分发）；不满足胡型返回 null */
  private buildWin(
    seat: number,
    via: 'zimo' | 'ron',
    tile: Tile | null,
    from: number | null,
  ): WinInfo | null {
    if (this.gz) return this.gzBuildWin(seat, via, tile, from);
    return this.tryBuildWin(seat, via, tile, from);
  }

  /**
   * 赣州胡牌构建（§6）：**三类精牌（明面正精 / 隐藏正精 / 副精）都不能当万能牌** →
   * 全部门牌按本身牌面分解（`gzDecompose` 连 wild 参数都没有）+ 有精限制（§6.5）。
   * 隐藏正精即使被摸到也只按正精计分，不参与任何凑牌（§3.6 ②）。
   */
  private gzBuildWin(
    seat: number,
    via: 'zimo' | 'ron',
    tile: Tile | null,
    from: number | null,
  ): WinInfo | null {
    const jing = this.gzJing;
    if (!jing) return null;
    const concealed = via === 'zimo' ? [...this.hands[seat]] : [...this.hands[seat], tile!];
    const gankai = via === 'zimo' && this.gangDrawJustNow;
    const f = gzAnalyzeWin(concealed, this.melds[seat], jing, gankai);
    if (!f.valid) return null;

    // 天和（确认口径）：庄家起手 14 张即胡牌牌型；地和：庄家打出的第一张牌被闲家胡（仅此一种）
    let tiandi: 'tian' | 'di' | null = null;
    if (via === 'zimo' && seat === this.dealer && this.totalDiscards === 0) tiandi = 'tian';
    else if (
      via === 'ron' &&
      from !== null &&
      from === this.dealer &&
      seat !== this.dealer &&
      this.totalDiscards === 1
    ) {
      tiandi = 'di';
    }

    // 德中德（确认口径）：德国 + 任意胡牌牌型 + 其余三家一张精牌都没有（按物理持有：
    // 手牌 + 副露 + 牌河；点炮张仍在打出者牌河里，算他有）；天地胡只叠精吊/德国，不叠德中德
    const others = [0, 1, 2, 3]
      .filter((s) => s !== seat)
      .map((s) => [...this.hands[s], ...this.melds[s].flatMap((m) => m.tiles), ...this.rivers[s]]);
    const dezhongde = tiandi ? false : gzIsDezhongde(f.german, others, jing);

    return {
      seat,
      via,
      tile,
      from,
      shapes: f.shapes,
      qixing: f.qixing,
      german: f.german,
      dezhongde,
      jingdiao: f.jingdiao,
      tiandi,
      gankai,
      gz: { ...f, patternBase: tiandi ? GZ_CONFIG.patternBase.tiandi : f.patternBase },
    };
  }

  private tryBuildWin(
    seat: number,
    via: 'zimo' | 'ron',
    tile: Tile | null,
    from: number | null,
  ): WinInfo | null {
    const concealed = via === 'zimo' ? [...this.hands[seat]] : [...this.hands[seat], tile!];
    const melds = this.melds[seat];
    // 点炮的那张精只能按本身计（规则 3）
    const a = analyzeWin(
      concealed,
      melds,
      this.jingPi,
      this.jingFu,
      via === 'ron' && tile !== null ? tile : undefined,
    );
    if (!a.valid) return null;

    const wildSet = new Set<Tile>();
    if (this.jingPi !== null) wildSet.add(this.jingPi);
    if (this.jingFu !== null) wildSet.add(this.jingFu);
    const isWild = (t: Tile): boolean => wildSet.has(t);

    // 七星十三烂
    let qixing = false;
    if (a.shapes.includes('shisanlan')) {
      const assign = checkShisanlan(concealed, melds, this.jingPi, this.jingFu);
      if (assign) {
        const eff = new Set<Tile>();
        for (const t of concealed) if (!isWild(t)) eff.add(t);
        for (const m of melds) for (const t of m.tiles) eff.add(t);
        for (const t of assign) eff.add(t);
        qixing = [27, 28, 29, 30, 31, 32, 33].every((w) => eff.has(w));
      }
    }

    // 德中德：其余三家归属精为 0（手牌 + 副露 + 牌河）
    const wildCountOf = (s: number): number => {
      let n = 0;
      for (const t of this.hands[s]) if (isWild(t)) n++;
      for (const m of this.melds[s]) for (const t of m.tiles) if (isWild(t)) n++;
      for (const t of this.rivers[s]) if (isWild(t)) n++;
      return n;
    };
    const dezhongde =
      a.german && [0, 1, 2, 3].filter((s) => s !== seat).every((s) => wildCountOf(s) === 0);

    // 精吊：自摸、非"仅十三烂"、胡前 13 张摸任意可摸牌都能胡
    const onlySls = a.shapes.length === 1 && a.shapes[0] === 'shisanlan';
    let jingdiao = false;
    if (via === 'zimo' && !onlySls && this.lastDrawn !== null) {
      const pre13 = [...this.hands[seat]];
      const idx = pre13.indexOf(this.lastDrawn);
      if (idx >= 0) {
        pre13.splice(idx, 1);
        const kinds = new Set<Tile>(this.wall);
        kinds.add(this.lastDrawn);
        jingdiao = isAnyDrawTenpai(pre13, melds, this.jingPi, this.jingFu, kinds);
      }
    }

    let tiandi: 'tian' | 'di' | null = null;
    if (via === 'zimo' && seat === this.dealer && this.totalDiscards === 0) tiandi = 'tian';
    if (
      via === 'ron' &&
      from !== null &&
      from === this.dealer &&
      seat !== this.dealer &&
      this.totalDiscards === 1
    ) {
      tiandi = 'di';
    }

    return {
      seat,
      via,
      tile,
      from,
      shapes: a.shapes,
      qixing,
      german: a.german,
      dezhongde,
      jingdiao,
      tiandi,
      gankai: via === 'zimo' && this.gangDrawJustNow,
    };
  }

  /** 胡/自摸按钮显示的特殊牌型名（普通平胡 → null，按钮显示普通「胡/自摸」） */
  private labelOf(info: WinInfo): string | null {
    if (this.gz && info.gz) return gzWinLabel(info.gz, info.gankai, info.tiandi, info.dezhongde);
    const parts: string[] = [];
    const name =
      classifyPattern({
        shapes: info.shapes,
        qixing: info.qixing,
        german: info.german,
        dezhongde: info.dezhongde,
        jingdiao: info.jingdiao,
        gankai: info.gankai,
        tiandi: null,
      })?.name ?? '平胡';
    if (name !== '平胡') parts.push(name);
    if (info.tiandi === 'tian') parts.push('天胡');
    if (info.tiandi === 'di') parts.push('地胡');
    return parts.length > 0 ? parts.join('·') : null;
  }

  /** 结算胡牌。lock = 本张牌的胡牌锁终局结果（自摸无锁，传 null） */
  private applyWin(info: WinInfo, lock: HuLockOutcome | null = null): void {
    this.phase = 'over';
    this.pending = null;
    this.winnerSeat = info.seat;
    this.winInfo = info;
    this.huLockOutcome = lock;
    const labels = info.shapes.map((s) =>
      s === 'shisanlan' && info.qixing ? '七星十三烂' : shapeLabel(s),
    );
    if (this.gz && info.gz) {
      // 赣州：有宝走精吊路线（+5）、无宝德国（+8）（§6.6）
      if (info.gz.hasJing) labels.push('精吊');
      else labels.push('德国');
      if (info.dezhongde) labels.push('德中德');
    } else {
      if (info.dezhongde) labels.push('德中德');
      else if (info.german) labels.push('德国');
      if (info.jingdiao) labels.push('精吊');
    }
    if (info.tiandi === 'tian') labels.push(this.gz ? '天和' : '天胡');
    if (info.tiandi === 'di') labels.push(this.gz ? '地和' : '地胡');
    if (info.gankai) labels.push('杠开');
    this.result = `${info.via === 'zimo' ? '自摸' : '胡牌'}（${labels.join(' · ')}）`;
    this.pushLog(
      'hu',
      info.seat,
      info.tile !== null ? [info.tile] : [],
      info.via === 'zimo' ? '自摸' : '点炮',
    );
  }

  private over(): GameEvent[] {
    this.phase = 'over';
    this.result = '流局（荒庄）';
    this.pending = null;
    this.pushLog('draw', -1, []);
    return [{ kind: 'over' }];
  }

  /** 断线 / 强制结束本局 */
  forceOver(reason: string): GameEvent[] {
    if (this.phase === 'over') return [];
    this.phase = 'over';
    this.result = reason;
    this.pending = null;
    this.pushLog('draw', -1, [], reason);
    return [{ kind: 'over' }];
  }

  private pull(hand: Tile[], tile: Tile, n: number): void {
    for (let i = 0; i < n; i++) {
      const idx = hand.indexOf(tile);
      if (idx < 0) throw new Error('内部错误：手牌不足');
      hand.splice(idx, 1);
    }
  }

  private assertPlaying(): void {
    if (this.phase !== 'playing') throw new Error('本局已结束');
  }

  /** 是否存在未结束的响应窗口（服务端掉线托管 / 超时托管用） */
  get windowOpen(): boolean {
    return this.pending !== null;
  }

  get awaitingSeats(): number[] {
    return this.pending ? [...this.pending.awaiting] : [];
  }

  /** 响应窗口内**尚未应答**的座位（托管推进用；注意 awaitingSeats 含已应答者） */
  get waitingSeats(): number[] {
    return this.pending
      ? this.pending.awaiting.filter((s) => !this.pending!.responses.has(s))
      : [];
  }

  /** 是否有未结束的掷骰仪式（等待点击 / 动画窗口中）——托管推进在此期间不得行牌 */
  get ritualActive(): boolean {
    return this.phase === 'playing' && this.ceremonyInfo() !== null;
  }

  // ---------- 赣州结算数据（§7） ----------

  /** 各家精牌持有（确认口径）：手牌 + 副露 + 牌河——打出无人碰的精仍归打出者；
   *  点炮胡的胡牌张归赢家（从打出者牌河移出） */
  gzHoldings(): Tile[][] {
    const out = [0, 1, 2, 3].map((s) => [
      ...this.hands[s],
      ...this.melds[s].flatMap((m) => m.tiles),
      ...this.rivers[s],
    ]);
    const wi = this.winInfo;
    if (wi && wi.via === 'ron' && wi.tile !== null && wi.from !== null) {
      const i = out[wi.from].indexOf(wi.tile);
      if (i >= 0) out[wi.from].splice(i, 1);
      out[wi.seat].push(wi.tile);
    }
    return out;
  }

  /** 胡牌分（§6.1/6.4/6.6）：底分 + 杠开8 + 精吊5/德国8，德中德 ×4；天地胡 40 + 5/8 */
  private gzPatternScore(wi: WinInfo): number {
    const f = wi.gz;
    if (!f) return 0;
    const base = wi.tiandi ? GZ_CONFIG.patternBase.tiandi : f.patternBase;
    let score =
      base +
      (wi.gankai ? GZ_CONFIG.gankaiBonus : 0) +
      (f.hasJing ? GZ_CONFIG.jingdiaoBonus : GZ_CONFIG.germanBonus);
    if (wi.dezhongde && !wi.tiandi) score *= GZ_CONFIG.dezhongdeMult;
    return score;
  }

  /** 赣州冲关完整结算（非赣州对局返回 null） */
  gzSettle(): GzSettleOutcome | null {
    const jing = this.gzJing;
    if (!jing) return null;
    const wi = this.winInfo;
    return gzSettle({
      jing,
      holdings: this.gzHoldings(),
      gangs: this.gzGangs.map((g) => ({ seat: g.seat, packed: g.packed })),
      packs: this.gzPacks,
      winner: wi?.seat ?? null,
      pattern: wi ? this.gzPatternScore(wi) : 0,
      discarder: wi && wi.via === 'ron' ? wi.from : null,
      patternName: wi ? (this.labelOf(wi) ?? '平胡') : '流局',
      chaozhuang: this.chaozhuang,
      dealer: this.dealer,
    });
  }
}
