import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import {
  CHAT_TEXT_MAX,
  MAX_SEATS,
  throwEmojiOf,
  type ClientMsg,
  type DealerRoll,
  type GameView,
  type SeatPlayer,
  type ServerMsg,
} from '../../shared/src/index.ts';
import { getRules, VARIANTS } from '../../shared/src/rules/index.ts';
import { type ClaimRequest } from '../../shared/src/resolver.ts';
import { computeSettlement } from '../../shared/src/score.ts';
import { seatWind, tileName, windName } from '../../shared/src/tiles.ts';
import { Game, type GameEvent } from './game.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../../client/dist');
const PORT = Number(process.env.PORT ?? 3130);
const TURN_MS = Number(process.env.MAHJONG_TURN_MS ?? 15000);
/** 掉线托管：回合者无连接时的自动出牌等待 */
const AUTO_MS = Number(process.env.MAHJONG_AUTO_MS ?? 3000);
/** 机器人代打节奏（ms）：比掉线托管快一些，减少等待感 */
const BOT_MS = Number(process.env.MAHJONG_BOT_MS ?? 1200);
const THROW_DICE = process.env.MAHJONG_THROW_DICE !== '0';
/** 掷骰仪式（开局/杠后点骰子按钮）；MAHJONG_CEREMONY=0 关闭 */
const CEREMONY = process.env.MAHJONG_CEREMONY !== '0';
/** 开局发牌动画窗口（ms） */
const DEAL_MS = Number(process.env.MAHJONG_DEAL_MS ?? 6500);
/** 杠后掷骰动画窗口（ms） */
const ROLL_MS = Number(process.env.MAHJONG_ROLL_MS ?? 2600);
/** 随机风位入座；MAHJONG_FIXED_SEATS=1 时按空位顺序固定入座（本地手动验证用） */
const RANDOM_SEATS = process.env.MAHJONG_FIXED_SEATS !== '1';
/** 掉线后保留座位的宽限期（ms）：刷新页面 / 网络闪断不该把人踢出房间 */
const RECON_MS = Number(process.env.MAHJONG_RECON_MS ?? 30000);
/** 心跳间隔 / 存活判定（ms）。笔记本合盖、Wi-Fi 掉线这类「半开连接」不会触发 close，
 *  只能靠 ping/pong 主动探活：超过 PONG_TTL 没有回应就掐断，让人走「掉线托管 + 重连宽限」，
 *  而不是让全桌等一个其实已经不在的人。 */
const PING_MS = Number(process.env.MAHJONG_PING_MS ?? 15000);
const PONG_TTL = Number(process.env.MAHJONG_PONG_TTL_MS ?? 45000);
const CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

interface Player {
  seat: number;
  name: string;
  token: string;
  ready: boolean;
  ws: WebSocket | null;
  /** 断线宽限计时器：非对局进行中断线时先保留座位，超时未重连才真正离座 */
  reconTimer: NodeJS.Timeout | null;
  /** 机器人（AI 凑桌）：无连接、恒 ready、恒托管；不可 resume */
  isBot: boolean;
  /** 手动托管：开启期间由服务端代你掷骰 / 应答 / 出牌 */
  auto: boolean;
}

interface Room {
  code: string;
  /** 玩法 id（如 'nanchang'）——创建房间时确定，整局沿用 */
  variant: string;
  hostSeat: number;
  players: Player[];
  phase: 'lobby' | 'game';
  game: Game | null;
  nextDealer: number;
  /** 首局定庄掷骰（四人各一次；并列者重掷时清空） */
  dealerRolls: DealerRoll[];
  /** 首局庄家是否已定；未定庄不允许开局 */
  firstDealerDecided: boolean;
  totals: number[];
  /** 待处理的换位请求（from 发起 → to 目标，需对方同意） */
  pendingSwap: { from: number; to: number } | null;
  windowTimer: NodeJS.Timeout | null;
  deadlineAt: number | null;
  autoTimer: NodeJS.Timeout | null;
  /** 掷骰动画结束后的视图刷新（等待掷骰阶段不自动掷——一直等到玩家点击） */
  diceEndTimer: NodeJS.Timeout | null;
  /** 首局定庄：此定时器让最后一掷的骰子动画与金色点数亮满监听再进对局 */
  dealerStartTimer: NodeJS.Timeout | null;
}

const rooms = new Map<string, Room>();
const binding = new Map<WebSocket, { code: string; seat: number }>();
/** 断线重连：token → 房间/座位 */
const tokens = new Map<string, { code: string; seat: number }>();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json',
};

function genCode(): string {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

function cleanName(raw: unknown, fallbackSeat: number): string {
  const s = typeof raw === 'string' ? raw.trim().slice(0, 8) : '';
  return s || windName(fallbackSeat);
}

/**
 * 风位换算基准的庄家：**对局中取当局庄家**（结算也还在看这一局），
 * 大厅/结算后取「下一局庄家」。风位随庄，所以任何风位文案都以它为基准。
 */
function roomDealer(room: Room): number {
  return room.game ? room.game.dealer : room.nextDealer;
}

/** 座位在本房当前庄家下的风位（庄家恒为东）——**所有风位文案都必须走这里** */
function windOf(room: Room, seat: number): string {
  return seatWind(seat, roomDealer(room));
}

/** 「下局 X 坐庄」播报：风位随庄后下一局庄家恒为东，报风位就没信息量了，故报**人名** */
function nextDealerText(room: Room): string {
  const p = room.players.find((x) => x.seat === room.nextDealer);
  return `下局「${p?.name ?? `${room.nextDealer + 1}号位`}」坐庄`;
}

function playerName(room: Room, seat: number): string {
  const p = room.players.find((x) => x.seat === seat);
  return p ? `${windOf(room, seat)}·${p.name}` : `${seat + 1}号`;
}

function send(ws: WebSocket | null, msg: ServerMsg): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastLobby(room: Room): void {
  for (const p of room.players) send(p.ws, lobbyState(room, p.seat));
}

function lobbyState(room: Room, you: number): ServerMsg {
  const players: SeatPlayer[] = room.players.map((p) => ({
    seat: p.seat,
    name: p.name,
    ready: p.ready,
    connected: p.isBot || p.ws !== null,
    isHost: p.seat === room.hostSeat,
    isBot: p.isBot,
    auto: p.isBot || p.auto || p.ws === null,
  }));
  // 大厅横幅的语义是「可以开局了」：四人就绪 **且** 首局已定庄（机器人恒就绪）
  const allReady =
    players.length === MAX_SEATS && room.players.every((p) => p.ready || p.isBot) && room.firstDealerDecided;
  const token = room.players.find((p) => p.seat === you)?.token ?? '';
  return {
    t: 'state',
    code: room.code,
    variant: room.variant,
    phase: 'lobby',
    you,
    token,
    players,
    allReady,
    totals: [...room.totals],
    pendingSwap: room.pendingSwap ? { ...room.pendingSwap } : null,
    dealer: roomDealer(room),
    dealerRolls: room.dealerRolls.map((r) => ({ ...r, dice: [...r.dice] as [number, number] })),
    dealerDecided: room.firstDealerDecided,
  };
}

function broadcastEvent(room: Room, text: string): void {
  for (const p of room.players) send(p.ws, { t: 'event', text });
}

function broadcastGame(room: Room): void {
  if (!room.game) return;
  // 机器人没有连接但恒在座；掉线 / 手动托管 / 机器人一律视为「托管中」
  const connected = room.players.map((p) => p.isBot || p.ws !== null);
  const auto = room.players.map((p) => p.isBot || p.auto || p.ws === null);
  const names = [0, 1, 2, 3].map(
    (s) => room.players.find((p) => p.seat === s)?.name ?? '',
  );
  const totals = [...room.totals];
  const hostSeat = room.hostSeat;
  for (const p of room.players) {
    const view = room.game.viewFor(p.seat, room.deadlineAt);
    send(p.ws, { t: 'game', view: { ...view, connected, auto, names, totals, hostSeat, variant: room.variant } });
  }
}

function eventText(room: Room, e: GameEvent): string | null {
  const who = (seat: number) => playerName(room, seat);
  switch (e.kind) {
    case 'discard':
      return `${who(e.seat)} 打出 ${tileName(e.tile)}`;
    case 'chi':
      return `${who(e.seat)} 吃 ${tileName(e.tile)}`;
    case 'peng':
      return `${who(e.seat)} 碰 ${tileName(e.tile)}`;
    case 'gang':
      return `${who(e.seat)} 杠 ${tileName(e.tile)}`;
    case 'declare':
      return `${who(e.seat)} 报杠 ${tileName(e.tile)}（展示三张）`;
    case 'flip':
      return room.variant === 'ganzhou'
        ? `掷骰 ${e.dice[0]}、${e.dice[1]}（和 ${e.dice[0] + e.dice[1]}）→ 牌墙尾倒数第 ${e.dice[0] + e.dice[1]} 墩，翻出正精「${tileName(e.pi)}」（正精共 6 张、副精共 6 张，结算时揭晓）`
        : `掷骰 ${e.dice[0]}、${e.dice[1]}（和 ${e.dice[0] + e.dice[1]}），翻出正精「${tileName(e.pi)}」· 副精「${tileName(e.fu)}」`;
    case 'dealRoll':
      return `庄家掷骰 ${e.dice[0]}、${e.dice[1]} → 定位起牌`;
    case 'gangRoll':
      return `${who(e.seat)} 掷骰 ${e.dice[0]}、${e.dice[1]}（和 ${e.dice[0] + e.dice[1]}） → 牌墙定位补牌`;
    case 'over':
      return null;
  }
}

function syncWindow(room: Room): void {
  const open = !!room.game?.windowOpen;
  if (open) {
    if (!room.windowTimer) {
      // 一个窗口 15 秒，所有人共享
      room.deadlineAt = Date.now() + TURN_MS;
      room.windowTimer = setTimeout(() => {
        room.windowTimer = null;
        if (!room.game) return;
        const evs = room.game.expireWindow();
        applyGameEvents(room, evs);
      }, TURN_MS);
    }
  } else {
    if (room.windowTimer) clearTimeout(room.windowTimer);
    room.windowTimer = null;
    room.deadlineAt = null;
  }
}

/** 掷骰仪式：只负责动画窗口结束后的视图刷新；等待阶段不自动掷（没有点击就一直卡住） */
function syncDice(room: Room): void {
  if (room.diceEndTimer) {
    clearTimeout(room.diceEndTimer);
    room.diceEndTimer = null;
  }
  const g = room.game;
  if (!g || g.phase !== 'playing') return;
  const now = Date.now();
  if (g.dealUntil !== null && now < g.dealUntil) {
    const until = g.dealUntil;
    room.diceEndTimer = setTimeout(() => {
      room.diceEndTimer = null;
      applyGameEvents(room, []); // 动画结束 → 推新视图（进入翻精等待）
    }, until - now + 30);
  } else if (g.jingUntil !== null && now < g.jingUntil) {
    const until = g.jingUntil;
    room.diceEndTimer = setTimeout(() => {
      room.diceEndTimer = null;
      applyGameEvents(room, []); // 翻精动画结束 → 解锁行牌
    }, until - now + 30);
  } else if (g.gangCeremony?.until != null && now < g.gangCeremony.until) {
    const until = g.gangCeremony.until;
    room.diceEndTimer = setTimeout(() => {
      room.diceEndTimer = null;
      applyGameEvents(room, []); // 动画结束 → 推新视图并恢复托管推进
    }, until - now + 30);
  }
}

function clearDiceTimers(room: Room): void {
  if (room.diceEndTimer) clearTimeout(room.diceEndTimer);
  room.diceEndTimer = null;
}

function onGameOver(room: Room): void {
  if (room.windowTimer) {
    clearTimeout(room.windowTimer);
    room.windowTimer = null;
  }
  if (room.autoTimer) {
    clearTimeout(room.autoTimer);
    room.autoTimer = null;
  }
  clearDiceTimers(room);
  room.deadlineAt = null;
  const g = room.game;
  const dealer = g?.dealer ?? 0;
  const winner = g?.winnerSeat ?? null;
  const result = g?.result ?? '本局结束';
  // 轮庄：南昌 = 庄家胡牌连庄、闲家胡牌轮到庄的下家、流局连庄；
  // 赣州 = 胡牌者接庄、流局庄连庄（赣州规则 §二）
  room.nextDealer =
    room.variant === 'ganzhou'
      ? (winner !== null ? winner : dealer)
      : winner !== null && winner !== dealer
        ? (dealer + 1) % 4
        : dealer;

  // 赣州冲关结算（§7）：精分 + 胡牌分 + 杠分 → 四人交叉 + 点炮直付 + 全包。
  // 胡牌与流局都结算（§7.5 流局只算精分和杠分）；强制中止不结算。
  const gzDraw = winner === null && (g?.result ?? '').startsWith('流局');
  if (room.variant === 'ganzhou' && g && (winner !== null || gzDraw)) {
    const outcome = g.gzSettle();
    if (outcome) {
      for (let s = 0; s < 4; s++) room.totals[s] += outcome.deltas[s];
      const r = (s: number) => outcome.rows[s];

      const notes: string[] = [];
      // 精分明细（§5.2 新口径：12 张精两两配对成 6 组，逐组冲关、相同组合重复累加）
      notes.push(
        `精分：${[0, 1, 2, 3]
          .map((s) => {
            const row = r(s);
            const parts = row.jingCombos
              .filter((c) => c.score > 0)
              .map((c) => {
                const n = c.count > 1 ? `×${c.count}` : '';
                const cg = c.chongguan > 1 ? `·冲关×${c.chongguan}` : '';
                const jb = c.jingba ? '·精霸×2' : '';
                return `${tileName(c.zheng)}+${tileName(c.fu)}${n}${cg}${jb}=${c.score}`;
              });
            return `${windOf(room, s)} ${parts.length > 0 ? parts.join('，') : '0'}=${row.jingFinal}`;
          })
          .join('；')}（正精2分/副精1分，逐组冲关）`,
      );
      if (winner !== null) {
        const how = outcome.direct.some((d) => d.kind === 'zimo') ? '自摸三家各付全分' : '点炮：点炮者付全分、其余各4';
        notes.push(`胡牌分：${playerName(room, winner)} ${outcome.patternName} = ${r(winner).pattern} 分（${how}）`);
      }
      for (const m of outcome.moves) {
        notes.push(
          `交叉结算：${windOf(room, m.from)} 付 ${windOf(room, m.to)} ${m.amount}（精分+杠分 ${r(m.from).jingFinal + r(m.from).gang} vs ${r(m.to).jingFinal + r(m.to).gang}）`,
        );
      }
      for (const d of outcome.direct) {
        const kind =
          d.kind === 'ron'
            ? '点炮全分'
            : d.kind === 'ron-other'
              ? '点炮平摊'
              : d.kind === 'zimo'
                ? '自摸全分'
                : d.kind === 'pack-gang'
                  ? '全包（杠分+精分）'
                  : d.kind === 'pack-meld'
                    ? '全包精分'
                    : d.kind === 'pack-hu'
                      ? '全包胡分'
                      : '抄庄';
        notes.push(`直付：${windOf(room, d.from)} 付 ${windOf(room, d.to)} ${d.amount}（${kind}）`);
      }
      if (g?.chaozhuang) notes.push('抄庄：第一轮四家同张手牌 → 庄家给每位闲家结算 10 分');

      // 兼容旧客户端的聚合字段 + 赣州专用负载
      const patternIn = [0, 0, 0, 0];
      const patternOut = [0, 0, 0, 0];
      const jingIn = [0, 0, 0, 0];
      const jingOut = [0, 0, 0, 0];
      for (const d of outcome.direct) {
        if (d.kind === 'pack-gang' || d.kind === 'pack-meld') {
          jingIn[d.to] += d.amount;
          jingOut[d.from] += d.amount;
        } else {
          patternIn[d.to] += d.amount;
          patternOut[d.from] += d.amount;
        }
      }
      for (const m of outcome.moves) {
        jingIn[m.to] += m.amount;
        jingOut[m.from] += m.amount;
      }

      const settle: ServerMsg = {
        t: 'settle',
        title: winner !== null ? `${playerName(room, winner)} ${result}` : `${result} · 精分结算`,
        rows: [0, 1, 2, 3].map((s) => ({
          seat: s,
          name: playerName(room, s),
          pi: r(s).pi,
          fu: r(s).fu,
          patternIn: patternIn[s],
          patternOut: patternOut[s],
          jingIn: jingIn[s],
          jingOut: jingOut[s],
          delta: r(s).delta,
        })),
        notes,
        totals: [0, 1, 2, 3].map((s) => ({ seat: s, name: playerName(room, s), value: room.totals[s] })),
        gz: {
          winner: outcome.winner,
          draw: outcome.draw,
          patternName: outcome.patternName,
          rows: outcome.rows,
          moves: outcome.moves,
          direct: outcome.direct,
        },
      };
      for (const p of room.players) send(p.ws, settle);
      if (winner !== null) broadcastEvent(room, `${playerName(room, winner)} ${result}`);
      // 胡牌锁回执（一炮一响）：其余被锁排除的胡牌请求
      const gzLock = g?.huLockOutcome;
      if (winner !== null && gzLock && gzLock.winner !== null && gzLock.denied.length > 0) {
        broadcastEvent(
          room,
          `一炮一响：本张牌由 ${windOf(room, winner)}·${playerName(room, winner)} 取得胡牌权，` +
            `其余 ${gzLock.denied.length} 家的胡牌请求被锁排除`,
        );
      }
      broadcastEvent(room, nextDealerText(room));

      // 摊牌展示：保留牌局亮牌（流局不亮暗牌），等每人点「下一局」
      for (const p of room.players) p.ready = p.isBot;
      broadcastGame(room);
      return;
    }
  }

  // 结算（仅胡牌）：牌型 + 冲关 + 杠精 → 面板 + 房间累计
  if (winner !== null && g?.winInfo) {
    const wi = g.winInfo;
    const wildPts = g.wildPoints();
    const outcome = computeSettlement({
      winner,
      dealer,
      winType: wi.via,
      discarder: wi.from,
      flags: {
        shapes: wi.shapes,
        qixing: wi.qixing,
        german: wi.german,
        dezhongde: wi.dezhongde,
        jingdiao: wi.jingdiao,
        gankai: wi.gankai,
        tiandi: wi.tiandi,
      },
      wildPoints: wildPts,
      gangJing: g.gangJingLog,
      jingPi: g.jingPi,
      jingFu: g.jingFu,
    });
    for (let s = 0; s < 4; s++) room.totals[s] += outcome.deltas[s];
    const wildCounts = g.wildTileCounts();

    const notes: string[] = [];
    // 精点透明：列出每家点数与结算口径（逐对点差 ≥2 才结算）
    notes.push(
      `精点：${[0, 1, 2, 3].map((s) => `${windOf(room, s)}${wildPts[s]}`).join('、')}（正精2点/副精1点，点差≥2逐对结算）`,
    );
    for (const m of outcome.chongMoves) {
      notes.push(
        `冲关：${windOf(room, m.from)} 付 ${windOf(room, m.to)} ${m.amount} 子（点差 ${m.d}）`,
      );
    }
    for (const ev of outcome.gangEvents) {
      const amt = ev.tile === g.jingPi ? 20 : 10;
      const kind = ev.tile === g.jingPi ? '正精' : '副精';
      notes.push(`杠精：${playerName(room, ev.seat)} 杠${kind} → 其余三家每家出 ${amt}`);
    }
    // 胡牌锁回执（一炮一响）：本张牌按庄位顺序锁定给一名玩家，其余胡牌请求被排除
    const lock = g.huLockOutcome;
    if (lock && lock.winner !== null && lock.denied.length > 0) {
      notes.push(
        `胡牌锁：本张 ${tileName(lock.tile)} 按庄位顺序由 ${windOf(room, lock.winner)} 取得胡牌权；` +
          `被锁排除（本张牌不能胡）：${lock.denied.map((s) => `${windOf(room, s)}·${playerName(room, s)}`).join('、')}`,
      );
    }

    const settle: ServerMsg = {
      t: 'settle',
      title: `${playerName(room, winner)} ${result}`,
      rows: [0, 1, 2, 3].map((s) => ({
        seat: s,
        name: playerName(room, s),
        pi: wildCounts[s].pi,
        fu: wildCounts[s].fu,
        patternIn: outcome.patternIn[s],
        patternOut: outcome.patternOut[s],
        jingIn: outcome.jingIn[s],
        jingOut: outcome.jingOut[s],
        delta: outcome.deltas[s],
      })),
      notes,
      totals: [0, 1, 2, 3].map((s) => ({
        seat: s,
        name: playerName(room, s),
        value: room.totals[s],
      })),
    };
    for (const p of room.players) send(p.ws, settle);
    broadcastEvent(room, `${playerName(room, winner)} ${result}`);
    if (lock && lock.winner !== null && lock.denied.length > 0) {
      broadcastEvent(
        room,
        `一炮一响：本张牌由 ${windOf(room, lock.winner)}·${playerName(room, lock.winner)} 胡，` +
          `其余 ${lock.denied.length} 家的胡牌请求被锁排除`,
      );
    }
    broadcastEvent(room, nextDealerText(room));

    // 胡牌 → 摊牌展示：保留牌局、亮出四家手牌，等每人点「下一局」
    for (const p of room.players) p.ready = p.isBot;
    broadcastGame(room);
    return;
  }

  // 流局 / 中止 → 立即收桌回大厅
  broadcastEvent(room, `${result}，庄家连庄`);
  room.game = null;
  room.phase = 'lobby';
  for (const p of room.players) p.ready = p.isBot;

  // 本局结束仍未重连的座位 → 离座（机器人不在此列）
  if (!pruneGonePlayers(room)) return;
  broadcastLobby(room);
}

/** 摊牌展示中（胡牌后未点「下一局」） */
function displaying(room: Room): boolean {
  return room.game !== null && room.game.phase === 'over';
}

/**
 * 清退「本局结束后仍未重连」的人类座位（机器人不在此列，恒保留）；
 * 若房间里已没有人类（只剩机器人）→ 直接删房。返回 false 表示房间已删除。
 */
function pruneGonePlayers(room: Room): boolean {
  const gone = room.players.filter((p) => p.ws === null && !p.isBot);
  if (gone.length > 0) {
    for (const p of gone) tokens.delete(p.token);
    room.players = room.players.filter((p) => p.ws !== null || p.isBot);
    pruneDealerRolls(room);
    for (const p of gone) broadcastEvent(room, `${windOf(room, p.seat)}·${p.name} 未重连，已离座`);
  }
  if (!room.players.some((p) => !p.isBot)) {
    // 只剩机器人：没人看了，收掉房间
    if (room.windowTimer) clearTimeout(room.windowTimer);
    if (room.autoTimer) clearTimeout(room.autoTimer);
    if (room.dealerStartTimer) clearTimeout(room.dealerStartTimer);
    room.dealerStartTimer = null;
    clearDiceTimers(room);
    rooms.delete(room.code);
    return false;
  }
  ensureHost(room);
  return true;
}

/** 房主必须由人类担任：房主不在场时交给座位最靠前的人类 */
function ensureHost(room: Room): void {
  if (room.players.some((p) => p.seat === room.hostSeat)) return;
  const humans = room.players.filter((p) => !p.isBot);
  if (humans.length > 0) room.hostSeat = Math.min(...humans.map((p) => p.seat));
}

/** 所有在线玩家都点了「下一局」（默认就绪）→ 收桌回大厅，人齐则直接开下一局 */
function finalizeIfReady(room: Room): void {
  const conn = room.players.filter((x) => x.ws !== null);
  if (!conn.every((x) => x.ready)) return;

  room.game = null;
  room.phase = 'lobby';
  clearDiceTimers(room);

  // 展示期间仍未重连的 → 离座（机器人保留）
  if (!pruneGonePlayers(room)) return;
  broadcastLobby(room);
  if (canStart(room)) startGame(room); // 4 人默认就绪且已定庄 → 直接开下一局
}

function applyGameEvents(room: Room, events: GameEvent[]): void {
  for (const e of events) {
    const text = eventText(room, e);
    if (text) broadcastEvent(room, text);
  }
  syncWindow(room);
  if (room.game && room.game.phase === 'over') {
    onGameOver(room);
    return;
  }
  syncDice(room);
  broadcastGame(room);
  syncAuto(room);
}

/** 该座位是否由服务端代打（机器人 / 手动托管 / 掉线） */
function isAutoSeat(room: Room, seat: number): boolean {
  const p = room.players.find((x) => x.seat === seat);
  return !!p && (p.isBot || p.auto || p.ws === null);
}

/** 代打节奏：机器人快一些，掉线 / 手动托管沿用原托管等待 */
function autoDelay(room: Room, seat: number): number {
  const p = room.players.find((x) => x.seat === seat);
  return p?.isBot ? BOT_MS : AUTO_MS;
}

/** 等待点击掷骰的座位（开局 / 翻精 = 庄家，杠后 = 杠者）；无处可掷返回 -1 */
function pendingRollSeat(g: Game): number {
  if (g.dealWaitRoll || g.jingWait) return g.dealer;
  if (g.gangCeremony && g.gangCeremony.dice === null) return g.gangCeremony.seat;
  return -1;
}

/** 最简 AI · 响应选择：能胡就胡、能杠就杠、能碰就碰，其余过（不做吃） */
function autoClaim(g: Game, seat: number): ClaimRequest | 'pass' {
  const opts = g.viewFor(seat, null).claims?.options ?? [];
  const has = (kind: ClaimRequest['kind']) => opts.some((o) => o.kind === kind);
  if (has('hu')) return { seat, kind: 'hu' };
  if (has('gang')) return { seat, kind: 'gang' };
  if (has('peng')) return { seat, kind: 'peng' };
  return 'pass';
}

/** 单张牌的「留手价值」：对子 / 刻子最高、邻张次之、隔张再次（字牌只算对子） */
function keepScore(hand: number[], t: number): number {
  let score = 0;
  for (const x of hand) {
    if (x === t) score += 3;
    else if (t < 27 && x < 27 && Math.floor(x / 9) === Math.floor(t / 9) && Math.abs(x - t) <= 2) {
      score += 3 - Math.abs(x - t); // 邻张 +2、隔张 +1
    }
  }
  return score;
}

/** 最简 AI · 出牌选择：打留手价值最低的牌；精牌优先留手；平手时优先打刚摸的牌 */
function autoDiscardTile(view: GameView): number {
  const tiles = view.myTiles;
  // 报杠（§8.5）：自己展示的三张打不出去（服务端会拒），托管也绝不能选它们
  const frozen = new Set(view.declared.filter((d) => d.seat === view.mySeat).map((d) => d.tile));
  // 持有他人展示的牌面时只能打它
  const must = view.mustDiscard ?? [];
  const allowed = tiles.filter(
    (t) => !frozen.has(t) && (must.length === 0 || must.includes(t)),
  );
  const pool = allowed.length > 0 ? allowed : tiles;
  let best = pool[0];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const t of pool) {
    let score = keepScore(tiles, t); // 留手价值仍按全手牌算，只是候选池被收窄
    if (t === view.jingPi || t === view.jingFu) score += 50;
    if (score < bestScore || (score === bestScore && t === view.drawn)) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

/** 托管回合行动：能自摸就自摸、能暗杠 / 补杠就杠，否则自动出牌。
 *  每步失败（引擎拒收）就降级下一步，绝不空转——否则无人再推进、整桌卡死。 */
function autoTurn(room: Room, seat: number): void {
  const g = room.game;
  if (!g || g.phase !== 'playing' || g.turn !== seat || g.ritualActive || g.pending) return;
  if (!isAutoSeat(room, seat)) return;
  const view = g.viewFor(seat, null);
  // 只有刚摸牌时才会有自摸 / 暗杠 / 补杠；吃碰后的回合直接出牌
  if (g.justDrew) {
    if (view.canZimo) {
      try {
        applyGameEvents(room, g.zimo(seat));
        return;
      } catch {
        /* 竞态：继续往下走（杠 / 出牌） */
      }
    }
    const sg = view.selfGangs[0];
    if (sg) {
      try {
        applyGameEvents(room, g.selfGang(seat, sg.kind, sg.tile));
        return;
      } catch {
        /* 竞态：继续出牌 */
      }
    }
  }
  // 出牌：AI 首选，被拒则按手牌顺序逐个兜底（防冻结牌 / 强制出牌等极端组合）
  const preferred = autoDiscardTile(view);
  const order = [preferred, ...view.myTiles.filter((t) => t !== preferred)];
  for (const t of order) {
    try {
      applyGameEvents(room, g.discard(seat, t));
      return;
    } catch {
      /* 换下一张 */
    }
  }
}

/** 托管推进：机器人 / 手动托管 / 掉线的座位由服务端代掷骰、代应答、代出牌 */
function syncAuto(room: Room): void {
  if (room.autoTimer) {
    clearTimeout(room.autoTimer);
    room.autoTimer = null;
  }
  const g = room.game;
  if (!g || g.phase !== 'playing') return;

  // 等待点击的掷骰（开局 / 翻精 / 杠后）：有权者托管时自动掷
  const rollSeat = pendingRollSeat(g);
  if (rollSeat >= 0) {
    if (!isAutoSeat(room, rollSeat)) return;
    room.autoTimer = setTimeout(() => {
      room.autoTimer = null;
      const gg = room.game;
      if (!gg || gg.phase !== 'playing') return;
      if (pendingRollSeat(gg) !== rollSeat || !isAutoSeat(room, rollSeat)) return;
      try {
        applyGameEvents(room, gg.rollDice(rollSeat));
      } catch {
        /* 状态竞态忽略 */
      }
    }, autoDelay(room, rollSeat));
    return;
  }

  if (g.ritualActive) return; // 动画窗口结束由 syncDice 的定时器回调再次推进

  if (g.windowOpen) {
    // 并行窗口：托管座位代为应答，每次推进一位直至收齐
    const seat = g.waitingSeats.find((s) => isAutoSeat(room, s));
    if (seat === undefined) return;
    try {
      applyGameEvents(room, g.respond(seat, autoClaim(g, seat)));
    } catch {
      /* 已应答等情况忽略 */
    }
    return;
  }

  // 轮到托管座位（含吃碰后未摸牌、须直接出牌的回合）
  if (isAutoSeat(room, g.turn)) {
    const seat = g.turn;
    room.autoTimer = setTimeout(() => {
      room.autoTimer = null;
      autoTurn(room, seat);
    }, autoDelay(room, seat));
  }
}

function startGame(room: Room): void {
  room.phase = 'game';
  room.pendingSwap = null; // 开局后换位请求作废
  room.game = new Game({
    code: room.code,
    dealer: room.nextDealer,
    throwDice: THROW_DICE,
    ceremony: CEREMONY,
    dealMs: DEAL_MS,
    rollMs: ROLL_MS,
    rules: getRules(room.variant),
  });
  const events: GameEvent[] = [];
  const g = room.game;
  // 仪式模式：翻精与掷骰播报等庄家点击骰子按钮后触发（dealWaitRoll 时跳过）
  if (!g.dealWaitRoll && g.jingPi !== null && (g.gzJing ? true : g.jingFu !== null)) {
    events.push({ kind: 'flip', dice: g.dealDice, pi: g.jingPi, fu: g.jingFu ?? g.jingPi });
  }
  applyGameEvents(room, events);
}

function allReady(room: Room): boolean {
  return room.players.length === MAX_SEATS && room.players.every((p) => p.ready || p.isBot);
}

/** 当前玩法是否需要首局掷骰定庄（南昌默认东起庄 → false；赣州四家比大小 → true） */
function needsDealerRoll(room: Room): boolean {
  return getRules(room.variant).flow.firstDealerRoll === true;
}

/** 能否开局：四人就绪，且（需要定庄的玩法）首局庄家已定 */
function canStart(room: Room): boolean {
  if (!allReady(room)) return false;
  return needsDealerRoll(room) ? room.firstDealerDecided : true;
}

/**
 * 换位：把 a、b 两个座位的占位互换（b 为空位即「搬家」）。
 * 房主身份与下一局庄家随人走；连接绑定与重连令牌必须同步改座，
 * 否则 resume / broadcast 会按旧座位找人而失联。
 */
function applySeatSwap(room: Room, a: number, b: number): void {
  if (a === b) return;
  for (const p of room.players) {
    if (p.seat !== a && p.seat !== b) continue;
    p.seat = p.seat === a ? b : a;
    const bd = p.ws ? binding.get(p.ws) : undefined;
    if (bd) bd.seat = p.seat;
    const tk = tokens.get(p.token);
    if (tk) tk.seat = p.seat;
  }
  if (room.hostSeat === a) room.hostSeat = b;
  else if (room.hostSeat === b) room.hostSeat = a;
  if (room.phase === 'lobby') {
    if (room.nextDealer === a) room.nextDealer = b;
    else if (room.nextDealer === b) room.nextDealer = a;
  }
  // 首局定庄的掷骰结果随人迁移：换位后仍是同一批人比大小，不该白扔
  for (const r of room.dealerRolls) {
    if (r.seat === a) r.seat = b;
    else if (r.seat === b) r.seat = a;
  }
}

/** 玩家离场后清掉他的定庄掷骰 —— 否则「四人齐」的判定永远不成立、卡在定庄阶段 */
function pruneDealerRolls(room: Room): void {
  room.dealerRolls = room.dealerRolls.filter((r) => room.players.some((p) => p.seat === r.seat));
}

/**
 * 记一次定庄掷骰（人类点击 / 机器人自动共用）：每人一次，
 * 满 4 人且四人都掷过才结算，点数最大者坐庄，并列者重掷（剔除最高分后从头再来）。
 * 结算后检查能否直接开局（玩家完全可能「先准备、后掷骰」）。
 */
function pushDealerRoll(room: Room, seat: number, d1: number, d2: number): void {
  if (!needsDealerRoll(room)) return;
  if (room.phase !== 'lobby' || room.game || room.firstDealerDecided) return;
  const p = room.players.find((x) => x.seat === seat);
  if (!p || room.dealerRolls.some((r) => r.seat === seat)) return;
  room.dealerRolls.push({ seat, dice: [d1, d2], sum: d1 + d2 });
  broadcastEvent(room, `${p.name} 掷出 ${d1}+${d2}=${d1 + d2} 点`);

  if (room.players.length === MAX_SEATS && room.dealerRolls.length === MAX_SEATS) {
    const best = Math.max(...room.dealerRolls.map((r) => r.sum));
    const tops = room.dealerRolls.filter((r) => r.sum === best);
    const nameOf = (s: number): string =>
      room.players.find((x) => x.seat === s)?.name ?? `${s + 1}号位`;
    if (tops.length === 1) {
      room.nextDealer = tops[0].seat;
      room.firstDealerDecided = true;
      broadcastEvent(room, `${nameOf(room.nextDealer)} 以 ${best} 点坐庄（本局东家）`);
    } else {
      room.dealerRolls = room.dealerRolls.filter((r) => r.sum !== best);
      broadcastEvent(room, `${tops.map((r) => nameOf(r.seat)).join('、')} 同为 ${best} 点，并列重掷`);
    }
  } else {
    broadcastEvent(room, `等待其余玩家掷骰（${room.dealerRolls.length}/${room.players.length}）`);
  }
  broadcastLobby(room);
  if (room.phase === 'lobby' && canStart(room)) {
    // 刚定下庄：让最后一掷的骰子动画与座位上的金色点数展示约 2.6s 再进对局，
    // 否则玩家点完骰子瞬间就跳到牌桌，什么都看不到
    if (room.dealerStartTimer) clearTimeout(room.dealerStartTimer);
    room.dealerStartTimer = setTimeout(() => {
      room.dealerStartTimer = null;
      // 窗口期内可能有人离场/房倒：逐项复核再开
      if (room.phase === 'lobby' && !room.game && room.firstDealerDecided && canStart(room)) startGame(room);
    }, 2600);
  }
  // 并列重掷后由机器人补齐（首次触发在 addBot / join 时）
  syncBotDealerRolls(room);
}

/**
 * 机器人自动掷骰定庄：满 4 人且庄家未定时，未掷过的机器人依次补掷。
 * 不满 4 人时不掷（与人类口径一致：等满 4 人再定庄）。
 */
function syncBotDealerRolls(room: Room): void {
  if (!needsDealerRoll(room)) return;
  if (room.phase !== 'lobby' || room.game || room.firstDealerDecided) return;
  if (room.players.length < MAX_SEATS) return;
  for (const p of room.players) {
    if (!p.isBot || room.dealerRolls.some((r) => r.seat === p.seat)) continue;
    pushDealerRoll(room, p.seat, 1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6));
    if (room.firstDealerDecided || room.game) return;
  }
}

/** 与某座位相关的待办换位请求作废（发起方或目标离开房间时） */
function dropPendingSwapOf(room: Room, seat: number): void {
  const ps = room.pendingSwap;
  if (!ps || (ps.from !== seat && ps.to !== seat)) return;
  room.pendingSwap = null;
  const other = ps.from === seat ? ps.to : ps.from;
  const op = room.players.find((p) => p.seat === other);
  if (op) send(op.ws, { t: 'event', text: '换位请求已取消（对方离开了房间）' });
}

/**
 * 真正移除一名玩家（并做随之而来的房间清理）。
 * 只有「用户主动离开」与「断线宽限期届满」才走这里。
 */
function removePlayer(room: Room, seat: number): void {
  const idx = room.players.findIndex((p) => p.seat === seat);
  if (idx < 0) return;
  const [removed] = room.players.splice(idx, 1);
  if (removed.reconTimer) clearTimeout(removed.reconTimer);
  removed.reconTimer = null;
  tokens.delete(removed.token);
  pruneDealerRolls(room); // 定庄掷骰随人离场作废
  // 已定庄但庄家本人离场（如房主移除坐庄的机器人）：定庄作废、回大厅重掷，否则开局庄位悬空卡死
  if (
    needsDealerRoll(room) &&
    !room.game &&
    room.firstDealerDecided &&
    !room.players.some((p) => p.seat === room.nextDealer)
  ) {
    room.firstDealerDecided = false;
    room.dealerRolls = [];
  }
  dropPendingSwapOf(room, seat); // 换位请求随人离场作废
  if (!room.players.some((p) => !p.isBot)) {
    // 一个人（或只剩机器人）都不剩 → 收掉房间
    if (room.windowTimer) clearTimeout(room.windowTimer);
    if (room.autoTimer) clearTimeout(room.autoTimer);
    if (room.dealerStartTimer) clearTimeout(room.dealerStartTimer);
    room.dealerStartTimer = null;
    clearDiceTimers(room);
    rooms.delete(room.code);
    return;
  }
  ensureHost(room); // 房主离场 → 交给座位最靠前的人类（绝不让机器人当房主）
  broadcastEvent(room, `${windOf(room, removed.seat)}·${removed.name} 离开了房间`);
  if (room.game && room.game.phase === 'playing') {
    // 显式离开 → 中止本局（掉线不走这里，见 handleDisconnect）
    applyGameEvents(room, room.game.forceOver('有玩家离开，本局中止'));
    return;
  }
  if (room.game) {
    // 摊牌展示中离座：不打断他人展示（等点「下一局」时统一收桌广播）。
    // 但若其余人已经都点了「下一局」，此刻人少了要补一次收桌判定，否则会一直悬着。
    if (displaying(room)) finalizeIfReady(room);
    return;
  }
  broadcastLobby(room);
}

function leaveRoom(ws: WebSocket): void {
  const b = binding.get(ws);
  if (!b) return;
  binding.delete(ws);
  const room = rooms.get(b.code);
  if (!room) return;
  removePlayer(room, b.seat);
}

/**
 * 非对局进行中的掉线：**保留座位 + 令牌**，给一段宽限期等重连。
 *
 * 背景：ws close 是「连接断开」而不是「用户想走」。刷新页面、切后台、网络闪断
 * 都会触发它，若在这里直接删令牌移出房间，token 重连就永远失效
 * （表现为「刷新一下就被踢出房间」）。对局进行中仍走原有托管逻辑（不阻塞牌局推进）。
 */
function beginReconnectGrace(room: Room, p: Player, ws: WebSocket): void {
  binding.delete(ws);
  p.ws = null;
  p.ready = false; // 别让「掉线但仍就绪」把牌局开起来
  if (p.reconTimer) clearTimeout(p.reconTimer);
  p.reconTimer = setTimeout(() => {
    p.reconTimer = null;
    if (!rooms.has(room.code)) return;
    if (p.ws !== null) return; // 期间已重连
    // 牌局已在进行：该座位本就按「掉线托管」参与，不该在这里把牌局中止 ——
    // 留到本局结束（`onGameOver` / `finalizeIfReady` 会清掉未重连的座位）。
    if (room.game && room.game.phase === 'playing') return;
    removePlayer(room, p.seat);
  }, RECON_MS);
  const secs = Math.round(RECON_MS / 1000);
  broadcastEvent(room, `${playerName(room, p.seat)} 掉线，${secs} 秒内可重连`);
  if (room.game) broadcastGame(room);
  else broadcastLobby(room);
}

/** 对局中掉线：保留座位进入托管（可 resume 重连） */
function handleDisconnect(ws: WebSocket): void {
  const b = binding.get(ws);
  if (!b) return;
  const room = rooms.get(b.code);
  if (!room) return;
  const p = room.players.find((x) => x.seat === b.seat);
  if (!p) return;
  if (room.game && room.game.phase === 'playing') {
    binding.delete(ws);
    p.ws = null;
    broadcastEvent(room, `${playerName(room, p.seat)} 掉线，进入托管`);
    broadcastGame(room);
    syncAuto(room);
    return;
  }
  // 大厅 / 摊牌展示：不立刻移出，先等重连
  beginReconnectGrace(room, p, ws);
}

function handle(ws: WebSocket, msg: ClientMsg): void {
  switch (msg.t) {
    case 'create': {
      if (binding.has(ws)) {
        send(ws, { t: 'error', reason: '你已经在房间里了' });
        return;
      }
      const code = genCode();
      const token = randomUUID();
      const seat = 0; // 创建者固定 0 号位（东），且为首局庄家；其余加入者随机入座
      // 玩法 id：未知/缺省回退南昌（getRules 内部保证）
      const variant = getRules(typeof msg.variant === 'string' ? msg.variant : null).meta.id;
      const room: Room = {
        code,
        variant,
        hostSeat: seat,
        players: [{
          seat,
          name: cleanName(msg.name, seat),
          token,
          ready: false,
          ws,
          reconTimer: null,
          isBot: false,
          auto: false,
        }],
        phase: 'lobby',
        game: null,
        nextDealer: 0,
        // 首局庄家由四人掷骰决定（创建者不再自动坐庄），未定庄前不允许开局
        dealerRolls: [],
        firstDealerDecided: false,
        totals: [0, 0, 0, 0],
        pendingSwap: null,
        windowTimer: null,
        deadlineAt: null,
        autoTimer: null,
        diceEndTimer: null,
        dealerStartTimer: null,
      };
      rooms.set(code, room);
      binding.set(ws, { code, seat });
      tokens.set(token, { code, seat });
      send(ws, lobbyState(room, seat));
      return;
    }
    case 'resume': {
      if (binding.has(ws)) {
        send(ws, { t: 'error', reason: '你已经在房间里了' });
        return;
      }
      const rec = tokens.get(String(msg.token ?? ''));
      const room = rec ? rooms.get(rec.code) : null;
      const player = room && rec ? room.players.find((p) => p.seat === rec.seat) : null;
      if (!room || !player || !rec) {
        send(ws, { t: 'error', reason: '会话已失效，请重新加入房间' });
        return;
      }
      // 换设备登录：顶掉旧连接
      if (player.ws && player.ws !== ws) {
        binding.delete(player.ws);
        player.ws.close();
      }
      player.ws = ws;
      binding.set(ws, { code: rec.code, seat: rec.seat });
      if (player.reconTimer) {
        clearTimeout(player.reconTimer);
        player.reconTimer = null;
      }
      broadcastEvent(room, `${playerName(room, rec.seat)} 重新连接`);
      if (room.game && room.game.phase === 'playing') {
        broadcastGame(room);
        syncAuto(room);
      } else if (displaying(room)) {
        // 摊牌展示中：只把大厅状态发给自己（不打断他人看牌）
        send(ws, lobbyState(room, rec.seat));
      } else {
        broadcastLobby(room);
      }
      return;
    }
    case 'join': {
      if (binding.has(ws)) {
        send(ws, { t: 'error', reason: '你已经在房间里了' });
        return;
      }
      const code = String(msg.code ?? '').trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) {
        send(ws, { t: 'error', reason: '房间不存在，请检查房间码' });
        return;
      }
      if (room.game) {
        send(ws, { t: 'error', reason: '本局对战已开始，暂不能中途加入' });
        return;
      }
      if (room.players.length >= MAX_SEATS) {
        send(ws, { t: 'error', reason: '房间已满（4 人）' });
        return;
      }
      const taken = new Set(room.players.map((p) => p.seat));
      const free = [0, 1, 2, 3].filter((s) => !taken.has(s));
      const seat = RANDOM_SEATS ? free[Math.floor(Math.random() * free.length)] : free[0];
      const name = cleanName(msg.name, seat);
      const token = randomUUID();
      room.players.push({ seat, name, token, ready: false, ws, reconTimer: null, isBot: false, auto: false });
      binding.set(ws, { code, seat });
      tokens.set(token, { code, seat });
      broadcastEvent(room, `${windOf(room, seat)}·${name} 加入了房间`);
      broadcastLobby(room);
      syncBotDealerRolls(room); // 满员后机器人自动掷骰定庄
      return;
    }
    case 'setVariant': {
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) { send(ws, { t: 'error', reason: '当前不在房间中' }); return; }
      // 允许「未开局」与「结算/摊牌窗口」（room.game 为 over）；仅对局进行中禁止
      if (room.game && room.game.phase === 'playing') {
        send(ws, { t: 'error', reason: '对局进行中，无法切换玩法' });
        return;
      }
      if (b.seat !== room.hostSeat) {
        send(ws, { t: 'error', reason: '只有房主可以切换玩法' });
        return;
      }
      const v = typeof msg.variant === 'string' ? msg.variant : '';
      const rules = VARIANTS[v];
      if (!rules) { send(ws, { t: 'error', reason: '未知玩法' }); return; }
      if (v === room.variant && !msg.clearScores) return;
      const clearScores = Boolean(msg.clearScores);
      room.variant = v;
      if (clearScores) room.totals = [0, 0, 0, 0];
      const who = room.players.find((p) => p.seat === b.seat)?.name ?? '房主';
      broadcastEvent(
        room,
        `${who} 切换玩法为 ${rules.meta.name}${clearScores ? '，并已清零累计积分' : ''}`,
      );
      if (room.game) {
        // 结算/摊牌窗口：客户端停留在牌桌视图，仅发轻量通知，避免切回大厅视图
        for (const p of room.players) {
          send(p.ws, { t: 'variant', variant: v, totals: [...room.totals], cleared: clearScores });
        }
      } else {
        broadcastLobby(room);
      }
      return;
    }
    case 'rollDealer': {
      // 首局定庄：四人各掷两骰，点数最大者坐庄；并列者重掷
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) {
        send(ws, { t: 'error', reason: '当前不在房间中' });
        return;
      }
      if (room.game || room.phase !== 'lobby') {
        send(ws, { t: 'error', reason: '对局已经开始，无法再定庄' });
        return;
      }
      if (room.firstDealerDecided) {
        send(ws, { t: 'error', reason: '庄家已定' });
        return;
      }
      // 定庄必须是**满 4 人**各掷一次：否则先到的 2~3 人就能把庄定了，后到的人没机会掷
      if (room.players.length < MAX_SEATS) {
        send(ws, { t: 'error', reason: `等待满 4 人再定庄（当前 ${room.players.length}/4）` });
        return;
      }
      if (!room.players.some((p) => p.seat === b.seat)) return;
      if (room.dealerRolls.some((r) => r.seat === b.seat)) {
        send(ws, { t: 'error', reason: '你已经掷过了，等其他人' });
        return;
      }
      pushDealerRoll(room, b.seat, 1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6));
      return;
    }
    case 'addBot': {
      // 房主在大厅添加一个机器人占空位（满 4 人不可加）
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) {
        send(ws, { t: 'error', reason: '当前不在房间中' });
        return;
      }
      if (b.seat !== room.hostSeat) {
        send(ws, { t: 'error', reason: '只有房主可以添加机器人' });
        return;
      }
      if (room.game) {
        send(ws, { t: 'error', reason: '对局进行中，无法添加机器人' });
        return;
      }
      if (room.players.length >= MAX_SEATS) {
        send(ws, { t: 'error', reason: '房间已满（4 人）' });
        return;
      }
      const taken = new Set(room.players.map((p) => p.seat));
      const free = [0, 1, 2, 3].filter((s) => !taken.has(s));
      const seat = RANDOM_SEATS ? free[Math.floor(Math.random() * free.length)] : free[0];
      const used = new Set(room.players.filter((p) => p.isBot).map((p) => p.name));
      let n = 1;
      while (used.has(`机器人${n}`)) n++;
      const name = `机器人${n}`;
      room.players.push({
        seat,
        name,
        token: randomUUID(), // 不注册进 tokens：机器人座位不可被 resume
        ready: true, // 机器人恒就绪，人类准备完即可开局
        ws: null,
        reconTimer: null,
        isBot: true,
        auto: true,
      });
      broadcastEvent(room, `${windOf(room, seat)}·${name} 加入了房间`);
      broadcastLobby(room);
      syncBotDealerRolls(room); // 机器人自动掷骰定庄
      return;
    }
    case 'removeBot': {
      // 房主在大厅移除机器人（对局中不可删）
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) {
        send(ws, { t: 'error', reason: '当前不在房间中' });
        return;
      }
      if (b.seat !== room.hostSeat) {
        send(ws, { t: 'error', reason: '只有房主可以移除机器人' });
        return;
      }
      if (room.game) {
        send(ws, { t: 'error', reason: '对局进行中，无法移除机器人' });
        return;
      }
      const bot = room.players.find((p) => p.seat === Number(msg.seat) && p.isBot);
      if (!bot) {
        send(ws, { t: 'error', reason: '该座位不是机器人' });
        return;
      }
      removePlayer(room, bot.seat);
      return;
    }
    case 'setAuto': {
      // 托管开关：开启后服务端代你掷骰 / 应答 / 出牌，可随时取消
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) {
        send(ws, { t: 'error', reason: '当前不在房间中' });
        return;
      }
      const me = room.players.find((p) => p.seat === b.seat);
      if (!me) return;
      const next = Boolean(msg.auto);
      if (me.auto === next) return;
      me.auto = next;
      broadcastEvent(room, `${me.name} ${next ? '开启托管' : '取消托管'}`);
      if (room.game) {
        broadcastGame(room);
        syncAuto(room);
      } else {
        broadcastLobby(room);
      }
      return;
    }
    case 'ready': {
      const b = binding.get(ws);
      if (!b) return;
      const room = rooms.get(b.code);
      if (!room) return;
      const p = room.players.find((x) => x.seat === b.seat);
      if (!p) return;
      if (room.game && room.game.phase === 'playing') {
        send(ws, { t: 'error', reason: '对局进行中，无法准备' });
        return;
      }
      p.ready = Boolean(msg.ready);
      if (displaying(room)) {
        // 摊牌展示中：只回自己的大厅状态（不打断他人看牌）
        send(ws, lobbyState(room, b.seat));
        if (p.ready) finalizeIfReady(room);
        return;
      }
      broadcastEvent(room, `${p.name}${p.ready ? ' 已准备' : ' 取消准备'}`);
      broadcastLobby(room);
      if (!room.game && room.phase === 'lobby' && canStart(room)) startGame(room);
      return;
    }
    case 'nextRound': {
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room || !displaying(room)) {
        send(ws, { t: 'error', reason: '当前没有可结算的牌局' });
        return;
      }
      const p = room.players.find((x) => x.seat === b.seat);
      if (!p) return;
      p.ready = true; // 点「下一局」= 默认就绪
      send(ws, lobbyState(room, b.seat));
      finalizeIfReady(room);
      return;
    }
    case 'abort': {
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) {
        send(ws, { t: 'error', reason: '当前不在房间中' });
        return;
      }
      if (room.hostSeat !== b.seat) {
        send(ws, { t: 'error', reason: '只有房主可以解散对局' });
        return;
      }
      if (!room.game) {
        send(ws, { t: 'error', reason: '当前没有进行中的对局' });
        return;
      }
      if (room.game.phase === 'playing') {
        // 强制结束本局 → onGameOver 收桌回大厅（房间保留）
        applyGameEvents(room, room.game.forceOver('房主解散对局'));
      } else {
        // 摊牌展示中：直接收桌
        room.game = null;
        room.phase = 'lobby';
        clearDiceTimers(room);
        for (const p of room.players) p.ready = p.isBot;
        broadcastEvent(room, '房主解散对局，返回房间');
        broadcastLobby(room);
      }
      return;
    }
    case 'dissolve': {
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) {
        send(ws, { t: 'error', reason: '当前不在房间中' });
        return;
      }
      if (room.hostSeat !== b.seat) {
        send(ws, { t: 'error', reason: '只有房主可以解散牌桌' });
        return;
      }
      // 最终积分快照 → 全员弹窗
      const rows = room.players.map((p) => ({
        name: `${windOf(room, p.seat)}·${p.name}`,
        value: room.totals[p.seat],
      }));
      const msg: ServerMsg = { t: 'dissolved', title: `房间 ${room.code} 已解散`, rows };
      for (const p of room.players) send(p.ws, msg);
      // 解绑 + 清理（连接保留，客户端弹窗关闭后回首页）
      for (const p of room.players) {
        if (p.ws) binding.delete(p.ws);
        if (p.reconTimer) clearTimeout(p.reconTimer);
        tokens.delete(p.token);
      }
      if (room.windowTimer) clearTimeout(room.windowTimer);
      if (room.autoTimer) clearTimeout(room.autoTimer);
      if (room.dealerStartTimer) clearTimeout(room.dealerStartTimer);
      room.dealerStartTimer = null;
      clearDiceTimers(room);
      rooms.delete(room.code);
      return;
    }
    case 'leave': {
      leaveRoom(ws);
      return;
    }
    case 'swap': {
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) {
        send(ws, { t: 'error', reason: '当前不在房间中' });
        return;
      }
      if (room.game) {
        send(ws, { t: 'error', reason: '对局进行中，无法换位' });
        return;
      }
      const me = room.players.find((p) => p.seat === b.seat);
      if (!me) return;
      const to = Number(msg.toSeat);
      if (!Number.isInteger(to) || to < 0 || to >= MAX_SEATS) {
        send(ws, { t: 'error', reason: '座位无效' });
        return;
      }
      if (to === b.seat) return;
      if (room.pendingSwap) {
        send(ws, { t: 'error', reason: '已有换位请求处理中，请稍候' });
        return;
      }
      const target = room.players.find((p) => p.seat === to);
      // 空位 → 直接搬过去（无需对方同意）
      if (!target) {
        applySeatSwap(room, b.seat, to);
        broadcastEvent(room, `${me.name} 换到 ${windOf(room, to)}家（空位）`);
        broadcastLobby(room);
        return;
      }
      // 有人 → 发起交换请求，等对方同意
      if (target.ready) {
        send(ws, { t: 'error', reason: `${windOf(room, to)}家已准备，无法交换座位` });
        return;
      }
      room.pendingSwap = { from: b.seat, to };
      send(target.ws, { t: 'swapAsk', from: b.seat, fromName: me.name });
      send(ws, {
        t: 'event',
        text: `已向 ${windOf(room, to)}家（${target.name}）发起换位请求，等待对方同意`,
      });
      broadcastLobby(room);
      return;
    }
    case 'swapRespond': {
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) {
        send(ws, { t: 'error', reason: '当前不在房间中' });
        return;
      }
      const ps = room.pendingSwap;
      if (!ps || ps.to !== b.seat) {
        send(ws, { t: 'error', reason: '没有待处理的换位请求' });
        return;
      }
      const me = room.players.find((p) => p.seat === ps.to);
      const requester = room.players.find((p) => p.seat === ps.from);
      room.pendingSwap = null;
      if (msg.accept && me && requester) {
        applySeatSwap(room, ps.from, ps.to);
        broadcastEvent(
          room,
          `${requester.name} 与 ${me.name} 换位：${requester.name} → ${windOf(room, ps.to)}家、${me.name} → ${windOf(room, ps.from)}家`,
        );
      } else {
        broadcastEvent(room, `${me ? me.name : windOf(room, ps.to)} 拒绝了换位请求`);
      }
      broadcastLobby(room);
      return;
    }
    case 'chat': {
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) {
        send(ws, { t: 'error', reason: '当前不在房间中' });
        return;
      }
      // 清洗：去除控制字符与换行，trim 后按 CHAT_TEXT_MAX 截断，空消息不广播
      const text = String(msg.text ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, CHAT_TEXT_MAX);
      if (!text) return;
      const me = room.players.find((p) => p.seat === b.seat);
      if (!me) return;
      for (const p of room.players) {
        if (p.ws) send(p.ws, { t: 'chat', seat: b.seat, name: me.name, text });
      }
      return;
    }
    case 'emote': {
      // 定向互动表情：校验目标座位有人且不是自己、id 合法，然后**广播给全员**
      // （各端在 target 的位置播同一段动画，所有玩家可见）
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!b || !room) {
        send(ws, { t: 'error', reason: '当前不在房间中' });
        return;
      }
      const target = Number(msg.target);
      if (!Number.isInteger(target) || target < 0 || target >= MAX_SEATS || target === b.seat) return;
      if (!room.players.some((p) => p.seat === target)) return; // 目标座位必须有人
      if (!throwEmojiOf(String(msg.emote ?? ''))) return; // 只认表内的 id
      const emote = String(msg.emote);
      for (const p of room.players) {
        if (p.ws) send(p.ws, { t: 'emote', from: b.seat, target, emote });
      }
      return;
    }
    case 'rollDice': {
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!room || !room.game || !b) {
        send(ws, { t: 'error', reason: '当前没有进行中的对局' });
        return;
      }
      try {
        applyGameEvents(room, room.game.rollDice(b.seat));
      } catch (err) {
        send(ws, { t: 'error', reason: err instanceof Error ? err.message : '操作无效' });
      }
      return;
    }
    case 'discard':
    case 'claim':
    case 'pass':
    case 'selfGang':
    case 'declareKong':
    case 'zimo': {
      const b = binding.get(ws);
      const room = b ? rooms.get(b.code) : null;
      if (!room || !room.game || !b) {
        send(ws, { t: 'error', reason: '当前没有进行中的对局' });
        return;
      }
      // 对局已结束：这个动作在发出时多半还是合法的（例如「我点了胡，同一张炮被另一个人抢先胡走」），
      // 纯粹是网络/处理顺序竞态。此时静默忽略即可 —— 客户端马上会收到结算视图，
      // 再弹一条「本局已结束」只会让人以为是自己的操作出了问题。
      if (room.game.phase !== 'playing') return;
      try {
        let events: GameEvent[];
        if (msg.t === 'discard') {
          events = room.game.discard(b.seat, msg.tile);
        } else if (msg.t === 'pass') {
          events = room.game.respond(b.seat, 'pass');
        } else if (msg.t === 'claim') {
          events = room.game.respond(b.seat, {
            seat: b.seat,
            kind: msg.kind,
            chiTiles: msg.chiTiles,
          });
        } else if (msg.t === 'zimo') {
          events = room.game.zimo(b.seat);
        } else if (msg.t === 'declareKong') {
          events = room.game.declareKong(b.seat, msg.tile);
        } else {
          events = room.game.selfGang(b.seat, msg.kind, msg.tile);
        }
        applyGameEvents(room, events);
      } catch (err) {
        send(ws, { t: 'error', reason: err instanceof Error ? err.message : '操作无效' });
      }
      return;
    }
    default:
      send(ws, { t: 'error', reason: '未知消息' });
  }
}

const server = http.createServer((req, res) => {
  try {
    if (!fs.existsSync(DIST)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('客户端尚未构建：请先运行 npm run build');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    let file = path.normalize(path.join(DIST, decodeURIComponent(url.pathname)));
    if (file !== DIST && !file.startsWith(DIST + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    if (url.pathname === '/' || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      file = path.join(DIST, 'index.html');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch {
    res.writeHead(500).end();
  }
});

const wss = new WebSocketServer({ server, path: '/ws' });
/** 连接 → 最近一次确认存活的时间戳。笔记本合盖、Wi-Fi 掉线这类「半开连接」不会触发 close，
 *  只能靠 ping/pong 主动探活；超时未回应就掐断，让人走「掉线托管 + 重连宽限」，
 *  而不是让全桌等一个其实已经不在的人。 */
const lastAlive = new Map<WebSocket, number>();
wss.on('connection', (ws) => {
  lastAlive.set(ws, Date.now());
  ws.on('message', (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(raw)) as ClientMsg;
    } catch {
      send(ws, { t: 'error', reason: '消息格式错误' });
      return;
    }
    handle(ws, msg);
  });
  ws.on('pong', () => lastAlive.set(ws, Date.now()));
  ws.on('close', () => {
    lastAlive.delete(ws);
    handleDisconnect(ws);
  });
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const [ws, t] of lastAlive) {
    if (ws.readyState !== WebSocket.OPEN) {
      lastAlive.delete(ws); // 正在关/已关：等 close 事件收尾，不重复处理
      continue;
    }
    if (now - t > PONG_TTL) {
      lastAlive.delete(ws);
      ws.terminate(); // 触发 close → 掉线托管 + 重连宽限
    } else {
      ws.ping();
    }
  }
}, PING_MS);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`麻将服务器已启动  http://localhost:${PORT}（玩法：${Object.keys(VARIANTS).join(' / ')}）`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list ?? []) {
      if (it.family === 'IPv4' && !it.internal) console.log(`局域网访问:  http://${it.address}:${PORT}`);
    }
  }
  console.log(`响应窗口 ${TURN_MS}ms，掷骰补杠：${THROW_DICE ? '开' : '关'}`);
  console.log('SERVER_READY');
});
