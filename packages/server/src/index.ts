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
/**
 * 牌面 CDN 资源目录（`npm run build:cdn-tiles` 产出）。
 *
 * 为什么不进代码包：官方代码包体检要求**图片资源合计 ≤ 200KB**、主包 < 1.5MB，
 * 34 张牌面无论怎么压都塞不进（93×135 的 PNG 也有 731KB）。改为服务端托管 + 小程序
 * 联网加载：包体 0 字节，流量走 CDN（34 张 WebP 共约 251KB，带长缓存）。
 */
const TILES_DIR = path.resolve(__dirname, '../public/tiles');
/**
 * UI 贴图 CDN 资源目录（`npm run gen_ui_cdn` 产出）：牌背/操作钮/结算艺术字/庄标/数字。
 * 与牌面同思路 —— 不进代码包，经 `GET /api/ui` 清单下发，客户端「有图用图、无图回退矢量」。
 */
const UI_DIR = path.resolve(__dirname, '../public/ui');
/**
 * UI 贴图分组（2026-10-23 静态资源分类整理）：
 *   hand    手牌相关：back 牌背 · back_op 暗杠扣牌 · inhand_l/inhand_r 左右家手牌侧影
 *   operate 操作钮：chi/peng/gang/hu/guo（中心动画字样同图）
 *   settle  结算艺术字：win/lost/draw
 *   hud     桌面 HUD：table 桌面 · banker 庄标 · d0..d9 大数字
 *   bg      web 端背景平铺纹理：bg-cloud/bg-lattice
 * （faceA..faceD 平放牌图集 2026-10-23 移往牌面大类：/api/tiles 的 faces 子清单）
 * 清单值 = `<group>/<key>.webp` 相对路径（客户端 urlOf 拼 `${base}/ui/${值}`，不感知分组）。
 */
const UI_GROUPS = ['hand', 'operate', 'settle', 'hud', 'bg'] as const;
/**
 * 局内音效目录（2026-10-23）：与牌面/UI 贴图同思路 —— **音频也不进代码包**
 *（官方体检红线：主包 < 1.5MB、图+音 ≤ 200KB），经 `GET /api/sound` 清单下发。
 */
const SOUND_DIR = path.resolve(__dirname, '../public/sound');
/** 音效资源版本号：换了音频就改它，客户端缓存自动失效 */
const SOUND_VER = process.env.MAHJONG_SOUND_VER || 'v1';
/**
 * 音效键 → 文件名。**白名单**而不是扫目录：源项目还有一个 1MB 的「背景音乐.mp3」，
 * 它既不进清单也不出 CDN（流量大、循环播放耗电），只留在 client/src/assets/sound 备查。
 * 键名与小程序 utils/sound.js 的取用键一一对应。
 */
const SOUND_FILES: Record<string, string> = {
  discard: 'discard.mp3',
  deal: 'deal.mp3',
  gang: 'gang.mp3',
  peng: 'peng.mp3',
  hu: 'hu.mp3',
  click: 'click.mp3',
};
/** 对外 base：留空表示「与接口同源」，由小程序自己拼绝对地址 */
const CDN_BASE = process.env.MAHJONG_CDN || '';
/** 资源版本号：换了牌面美术就改它，客户端缓存会自动失效 */
const TILES_VER = process.env.MAHJONG_TILES_VER || 'v4';
/**
 * UI 贴图版本号（同上；与牌面分开，UI 换图不必让客户端重下 34 张牌面）。
 * v1 → v2（2026-10-22）：v1 期间清单从 19 项扩到 24 项（加了 table + faceA..D）却**没抬版本号**，
 * 老客户端于是长期吃缓存里那份 19 项清单 —— 整屏桌面没图、平放牌退回立牌。
 * 客户端已改成「网络清单无条件覆盖缓存」，但版本号仍是**缓存失效开关**：
 * 换过美术就抬一位，别省这一步。
 * v12 → v13（2026-10-23）：faceA..faceD 平放牌图集移往牌面大类（/api/tiles faces 子清单），
 * UI 清单 30 → 26 键、6 组 → 5 组。
 * v11 → v12（2026-10-23）：UI 贴图**分组归档** —— public/ui 下按 hand/operate/settle/hud/seat/bg
 * 六组建子目录，清单值改 `<group>/<key>.webp` 相对路径（URL 全变 = 缓存自然失效）。
 * v10 → v11（2026-10-23）：新增 bg-cloud/bg-lattice 两个键 —— web 端背景纹理从
 * vite 本地打包（dist 6MB）改为 CDN 清单加载（bg 走 1x 1024×1024，cloud 198KB/lattice 88KB）。
 * v9 → v10（2026-10-23）：五个操作钮（chi/peng/gang/hu/guo）**画布与内容尺寸统一** ——
 * 源图内容 bbox 统一裁到高 94、居中放进 113×94 画布（此前「过」只有 71×67，放进同一
 * 92×78rpx 框后内容显示大 15%，「吃」偏小 → 同屏图标大小不一）。
 * v8 → v9（2026-10-23）：新增 chi 操作钮（源 option_chi.png 2304×1728 缩到 113×94），
 * 吃/暗杠/补杠/自摸/展示 从文字钮改图标钮；清单 27 → 28 项。
 * v7 → v8（2026-10-23）：inhand_l / inhand_r 重生成 —— alpha 压实（源图边缘半透明在
 * 26×56→17×16 大幅缩小后被滤波平均进牌身，叠绿桌整列发灰），牌身边际一律不透明。
 */
const UI_VER = process.env.MAHJONG_UI_VER || 'v13';
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
/** 掉线后保留座位的宽限期已被「房间级保留」取代：座位与 token 一直保留到房间被定时回收，
 *  凭 token 随时可 resume 续上（程序退出 / 网络闪断重进都不丢座位）。 */
/** 房间定时回收：房间内没有任何人类连接持续这么久 → 自动关闭（token 一并作废）。
 *  期间有人 resume / join 就继续存活 —— 退出程序再进来能凭房间码/token 续上，
 *  长期没人回来的无效房间也不会永久占着房间码。 */
const ROOM_TTL_MS = Number(process.env.MAHJONG_ROOM_TTL_MS ?? 30 * 60_000);
/** 房间回收巡检间隔（ms） */
const ROOM_SWEEP_MS = Number(process.env.MAHJONG_ROOM_SWEEP_MS ?? 60_000);
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
  /** 没有任何人类连接的起始时间（回收巡检用；有人连接即清空） */
  noHumanSince: number | null;
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
  '.webp': 'image/webp',
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
  // 大厅横幅的语义是「可以开局了」：四人就绪（离线座位按托管算）**且**首局已定庄（机器人恒就绪）
  const allReady =
    players.length === MAX_SEATS &&
    room.players.every((p) => p.ready || p.isBot || p.ws === null) &&
    room.firstDealerDecided;
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
  // 定庄后那 2.6s 的「等骰子动画再开局」定时器也必须清掉：本局既然已经结束
  // （含房主主动 abandon），残留的定时器会在phase 回 lobby 后自行 startGame，
  // 表现为「解散对局后马上又开一局」。
  if (room.dealerStartTimer) {
    clearTimeout(room.dealerStartTimer);
    room.dealerStartTimer = null;
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
        winner: outcome.winner, // null = 流局（客户端据此选 draw 图标）
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
      winner, // 本局赢家座位（客户端据此选 win/lost 图标）
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
 * 【保留制】人类座位（含掉线）一律保留，掉线者凭 token 随时可 resume 续上；
 * 只在「房间里一个人类都不剩」时收房（只剩机器人 = 没有可续的会话）。
 * 逐个座位的老「未重连即离座」已废弃 —— 改由房间级 TTL 巡检统一回收。
 */
function pruneGonePlayers(room: Room): boolean {
  if (!room.players.some((p) => !p.isBot)) {
    // 只剩机器人：没有 token 可续，直接收房
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

  // 能立刻开下一局就**不要再广播大厅态**：客户端是三个独立页面，
  // 「大厅（redirectTo lobby）+ 新一局（redirectTo game）」同一毫秒连发会互相打架 ——
  // 后到的 game 落在正在销毁的对局页上，人卡在大厅，而新一局正等着他掷骰 → 永久卡死。
  // 大厅所需的一切（分数、昵称、庄家）game 视图里都有，跳过广播没有信息损失。
  if (canStart(room)) {
    startGame(room);
    return;
  }
  broadcastLobby(room);
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

/** 四人就绪：掉线（离线托管）座位不阻塞开局——他们由服务端代打、随时可 resume 续上 */
function allReady(room: Room): boolean {
  return (
    room.players.length === MAX_SEATS &&
    room.players.every((p) => p.ready || p.isBot || p.ws === null)
  );
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
 * 满员且未定庄时，**机器人**与**掉线的人类**自动补掷定庄骰（与位置无关的托管语义：
 * 掉线者不应让其余人卡在「等他掷骰」上）。在线人类不在此列 —— 骰子必须自己点。
 */
function syncBotDealerRolls(room: Room): void {
  if (!needsDealerRoll(room)) return;
  if (room.phase !== 'lobby' || room.game || room.firstDealerDecided) return;
  if (room.players.length < MAX_SEATS) return;
  for (const p of room.players) {
    if (room.dealerRolls.some((r) => r.seat === p.seat)) continue;
    if (!p.isBot && p.ws !== null) continue; // 在线人类：等他自己掷
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
 * 非对局进行中的掉线：**长期保留座位 + 令牌**（房间级保留制）。
 *
 * 背景：ws close 是「连接断开」而不是「用户想走」。刷新页面、切后台、网络闪断、
 * 直接杀掉小程序再重开，都会触发它 —— 凭 token `resume` 随时回原座位续上；
 * 房间里没有任何人类连接持续 ROOM_TTL_MS 后才由巡检自动关房（无效房间定时关闭）。
 * 对局进行中仍走原有托管逻辑（不阻塞牌局推进）。
 */
function beginReconnectGrace(room: Room, p: Player, ws: WebSocket): void {
  binding.delete(ws);
  p.ws = null;
  p.ready = false; // 别让「掉线但仍就绪」把牌局开起来（离线座位按托管参与）
  if (p.reconTimer) {
    clearTimeout(p.reconTimer);
    p.reconTimer = null;
  }
  const mins = Math.max(1, Math.round(ROOM_TTL_MS / 60000));
  broadcastEvent(room, `${playerName(room, p.seat)} 掉线，座位将保留 ${mins} 分钟，期间重进即可续局`);
  if (room.game) broadcastGame(room);
  else {
    // 掉线者错过定庄掷骰会卡死 others（要满 4 人全掷才定庄）→ 托管补掷
    syncBotDealerRolls(room);
    broadcastLobby(room);
  }
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
  // 大厅 / 摊牌展示：座位 + 令牌长期保留（可随时 resume 续上）
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
        noHumanSince: null,
      };
      rooms.set(code, room);
      binding.set(ws, { code, seat });
      tokens.set(token, { code, seat });
      send(ws, lobbyState(room, seat));
      return;
    }
    case 'resume': {
      const bound = binding.get(ws);
      if (bound) {
        // 同一条连接重复 resume 是**合法的重同步**（客户端「人卡在大厅但牌局在跑」时
        // 会发它把当前视图要回来，见 utils/room.js 的 recoverGame）。座位对得上就照常回，
        // 别报「你已经在房间里了」把自救链路堵死。
        const same = (() => {
          const r = tokens.get(String(msg.token ?? ''));
          return !!r && r.code === bound.code && r.seat === bound.seat;
        })();
        if (!same) {
          send(ws, { t: 'error', reason: '你已经在房间里了' });
          return;
        }
      }
      const rec = tokens.get(String(msg.token ?? ''));
      const room = rec ? rooms.get(rec.code) : null;
      const player = room && rec ? room.players.find((p) => p.seat === rec.seat) : null;
      if (!room || !player || !rec) {
        // 令牌不存在/座位不在：房间已被定时回收、解散，或服务端重启过（内存态丢失）
        send(ws, { t: 'error', reason: '房间已失效，请重新创建或加入房间' });
        return;
      }
      const sameWs = player.ws === ws;
      // 换设备登录：顶掉旧连接
      if (player.ws && !sameWs) {
        binding.delete(player.ws);
        player.ws.close();
      }
      player.ws = ws;
      binding.set(ws, { code: rec.code, seat: rec.seat });
      if (player.reconTimer) {
        clearTimeout(player.reconTimer);
        player.reconTimer = null;
      }
      if (!sameWs) broadcastEvent(room, `${playerName(room, rec.seat)} 重新连接`);
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
        // 摊牌展示中：只回自己的大厅状态（不打断他人看牌）。
        // 若这一下正好凑齐所有人 → finalizeIfReady 直接开下一局，那条 game 才是客户端
        // 该走的路；此时再补一条 state 会把它踹回大厅（同 finalizeIfReady 的说明）。
        if (p.ready) {
          finalizeIfReady(room);
          if (displaying(room)) send(ws, lobbyState(room, b.seat));
        } else {
          send(ws, lobbyState(room, b.seat));
        }
        return;
      }
      broadcastEvent(room, `${p.name}${p.ready ? ' 已准备' : ' 取消准备'}`);
      // 满员就绪 → 直接开局：**不要再先广播大厅态**（见 finalizeIfReady 里的同款说明）
      if (!room.game && room.phase === 'lobby' && canStart(room)) startGame(room);
      else broadcastLobby(room);
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
      finalizeIfReady(room);
      // 没开成（还有别人没点）才回大厅态；开成了会收到 game，此时再甩一条 state
      // 就会把客户端往大厅踹（用户报「已经开始下一局却卡在准备界面」）。
      if (displaying(room)) send(ws, lobbyState(room, b.seat));
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
    case 'ping':
      // 应用级心跳（微信小程序：wx.connectSocket 发不出 ws 级 ping 帧）——
      // 收到即视为存活，并回一个 pong 供客户端确认链路。见 docs/integration/wechat-miniprogram.md P0
      lastAlive.set(ws, Date.now());
      send(ws, { t: 'pong' });
      return;
    default: {
      // 带上消息类型：以前只回「未知消息」，客户端事件流里根本看不出是哪条包。
      // 每条连接只回一次：新旧版本错配时（例如旧服务端不认识小程序的 10s 应用级心跳
      // `{t:'ping'}`）会每 10 秒触发一次，既刷屏又把客户端操作区顶得一跳一跳。
      const raw = msg as unknown as { t?: unknown };
      if (!unknownMsgWarned.has(ws)) {
        unknownMsgWarned.add(ws);
        console.warn(`[ws] 未知消息：${String(raw && raw.t)}（同一连接只提示一次）`);
        send(ws, { t: 'error', reason: `未知消息：${String(raw && raw.t)}` });
      }
    }
  }
}

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // 牌面资源清单：`GET /api/tiles` → { version, base, tiles: ['t00.webp', …], faces: { faceA:'face/faceA.webp', … } }
    // base 为空时，小程序用接口自身的 origin 拼出绝对地址。
    if (url.pathname === '/api/tiles') {
      const tiles = fs.existsSync(TILES_DIR)
        ? fs.readdirSync(TILES_DIR).filter((f) => /^t\d{2}\.webp$/.test(f)).sort()
        : [];
      // 牌面大类两个子类：tiles 立牌（按牌值）+ faces 平放牌（按座位，faceA..faceD）
      const facesDir = path.join(TILES_DIR, 'face');
      const faces: Record<string, string> = {};
      if (fs.existsSync(facesDir)) {
        for (const f of fs.readdirSync(facesDir).filter((f) => /^face[A-D]\.webp$/.test(f)).sort()) {
          faces[f.replace(/\.webp$/, '')] = `face/${f}`;
        }
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        // 清单本身要能被刷新（换版本时立刻生效），但缓存一下能省掉每次进房的往返
        'cache-control': 'public, max-age=300',
      });
      res.end(JSON.stringify({ version: TILES_VER, base: CDN_BASE, tiles, faces }));
      return;
    }

    // 牌面静态资源 `/tiles/tNN.webp`：内容不变，可以长缓存（版本升级走清单里的 version）
    if (url.pathname.startsWith('/tiles/')) {
      // 牌面大类：`/tiles/tXX.webp`（立牌）与 `/tiles/face/faceX.webp`（按座位平放牌）
      const rel = decodeURIComponent(url.pathname.slice(7));
      if (!/^(t\d{2}|face\/face[A-D])\.webp$/.test(rel)) {
        res.writeHead(404).end();
        return;
      }
      const file = path.join(TILES_DIR, rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'image/webp',
        'cache-control': 'public, max-age=31536000, immutable',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // 局内音效清单：`GET /api/sound` → { version, base, sounds: { discard:'discard.mp3', … } }
    // 音频同样不进代码包；键名与小程序 utils/sound.js 一一对应。
    if (url.pathname === '/api/sound') {
      const sounds: Record<string, string> = {};
      if (fs.existsSync(SOUND_DIR)) {
        for (const [k, f] of Object.entries(SOUND_FILES)) {
          if (fs.existsSync(path.join(SOUND_DIR, f))) sounds[k] = f;
        }
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=300',
      });
      res.end(JSON.stringify({ version: SOUND_VER, base: CDN_BASE, sounds }));
      return;
    }

    // 音效静态资源 `/sound/xxx.mp3`：内容不变，长缓存（换版本走清单里的 version）
    if (url.pathname.startsWith('/sound/')) {
      const name = path.basename(decodeURIComponent(url.pathname));
      const file = path.join(SOUND_DIR, name);
      if (!/^[a-z0-9_]+\.mp3$/.test(name) || !fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'cache-control': 'public, max-age=31536000, immutable',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // UI 贴图清单：`GET /api/ui` → { version, base, images: { back:'hand/back.webp', … } }（分组相对路径）
    // 键名与小程序 utils/uiart.js 的取用键一一对应（back/peng/gang/hu/guo/win/lost/draw/banker/d0..d9）。
    if (url.pathname === '/api/ui') {
      // 分组清单：images[key] = `<group>/<key>.webp`（递归子目录，平铺残留自动忽略）
      const images: Record<string, string> = {};
      if (fs.existsSync(UI_DIR)) {
        for (const g of fs.readdirSync(UI_DIR, { withFileTypes: true })) {
          if (!g.isDirectory() || !UI_GROUPS.includes(g.name as (typeof UI_GROUPS)[number])) continue;
          for (const f of fs.readdirSync(path.join(UI_DIR, g.name)).filter((f) => /\.webp$/.test(f)).sort()) {
            images[f.replace(/\.webp$/, '')] = `${g.name}/${f}`;
          }
        }
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'public, max-age=300',
      });
      res.end(JSON.stringify({ version: UI_VER, base: CDN_BASE, images }));
      return;
    }

    // UI 贴图静态资源 `/ui/<group>/<key>.webp`（2026-10-23 分组）：同牌面，长缓存
    if (url.pathname.startsWith('/ui/')) {
      // 原始串预检：合法 URL 不含 '..' 与百分号编码（WHATWG URL 虽已消除 dot segments，
      // 但 %2e%2e 之类解码后仍可能跨组跳跃 —— 公开资源无安全影响，与分类规范不符，直接拒）
      const rawUi = req.url || '';
      if (rawUi.includes('..') || /%[0-9a-fA-F]{2}/.test(rawUi)) {
        res.writeHead(404).end();
        return;
      }
      const rel = decodeURIComponent(url.pathname.slice(4));
      // 只认「已知组名单层 webp」：挡目录穿越（..）、平铺残留与非常规后缀
      if (!UI_GROUPS.some((g) => rel.startsWith(g + '/')) || !/^[\w-]+\/[\w-]+\.webp$/.test(rel)) {
        res.writeHead(404).end();
        return;
      }
      const file = path.join(UI_DIR, rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'image/webp',
        'cache-control': 'public, max-age=31536000, immutable',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (!fs.existsSync(DIST)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('客户端尚未构建：请先运行 npm run build');
      return;
    }
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
/**
 * 端口占用要说人话（2026-10-22）。
 *
 * `new WebSocketServer({ server })` 会把 http.Server 的 'error' **转发到 wss 上**，
 * 而没人接 wss 的 'error' → node 直接抛 Unhandled 'error' event，日志是一大段栈，
 * 关键信息（`EADDRINUSE :::3130`）埋在最底下，完全看不出「端口被上一个没退干净的
 * tsx/node 占了」。本项目里这个坑特别容易踩：`TaskStop` / 关掉终端都杀不掉 tsx 拉起
 * 子进程，外壳结束了真正 listen 的 node 还活着，并且还在服务旧代码。
 * 这里接住，把「怎么查 / 怎么杀 / 怎么换端口」直接印出来，并以 1 退出（别静默换端口 ——
 * 客户端 WSS 地址是写死的，偷偷换端口只会表现成「连不上」）。
 */
wss.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      [
        '',
        `❌ 端口 ${PORT} 已被占用：多半是上一个 tsx/node 没退干净（关终端/停任务都杀不掉子进程）。`,
        `   查占用（PowerShell）：Get-NetTCPConnection -LocalPort ${PORT} -State Listen | Select-Object -Expand OwningProcess`,
        `   结束进程：          Stop-Process -Id <上面查到的 PID> -Force`,
        `   或换个端口起：      PORT=${PORT + 1} npm run dev:server`,
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  console.error('WebSocket 服务出错：', err);
  process.exit(1);
});
/** 连接 → 最近一次确认存活的时间戳。笔记本合盖、Wi-Fi 掉线这类「半开连接」不会触发 close，
 *  只能靠 ping/pong 主动探活；超时未回应就掐断，让人走「掉线托管 + 重连宽限」，
 *  而不是让全桌等一个其实已经不在的人。 */
const lastAlive = new Map<WebSocket, number>();
/** 已经提示过「未知消息」的连接（同一连接只提示一次，见 handleMessage 的 default 分支） */
const unknownMsgWarned = new WeakSet<WebSocket>();
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

/** 房间定时关闭：房间内没有任何人类连接持续 ROOM_TTL_MS → 自动关闭（全部 token 一并作废）。
 *  每次巡检都按「是否还有人连着」实时刷新计数，有人 resume / 重连即清零 ——
 *  正常退出程序再进来凭 token 续局；长期无人续上的房间给后来的加入者让出房间码。 */
function closeRoom(room: Room): void {
  if (room.windowTimer) clearTimeout(room.windowTimer);
  if (room.autoTimer) clearTimeout(room.autoTimer);
  if (room.dealerStartTimer) clearTimeout(room.dealerStartTimer);
  room.dealerStartTimer = null;
  clearDiceTimers(room);
  for (const p of room.players) {
    if (p.reconTimer) clearTimeout(p.reconTimer);
    p.reconTimer = null;
    tokens.delete(p.token);
  }
  rooms.delete(room.code);
  console.log(
    `[room] ${room.code} 已无人连接 ${Math.round(ROOM_TTL_MS / 1000)}s，自动关闭（token 已作废）`,
  );
}

const roomSweeper = setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.players.some((p) => !p.isBot && p.ws !== null)) {
      room.noHumanSince = null; // 还有人连着：清零计数
      continue;
    }
    if (room.noHumanSince === null) {
      room.noHumanSince = now; // 从现在起开始计「无人」时长
      continue;
    }
    if (now - room.noHumanSince >= ROOM_TTL_MS) closeRoom(room);
  }
}, ROOM_SWEEP_MS);

server.listen(PORT, () => {
  console.log(`麻将服务器已启动  http://localhost:${PORT}（玩法：${Object.keys(VARIANTS).join(' / ')}）`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const it of list ?? []) {
      if (it.family === 'IPv4' && !it.internal) console.log(`局域网访问:  http://${it.address}:${PORT}`);
    }
  }
  console.log(`响应窗口 ${TURN_MS}ms，掷骰补杠：${THROW_DICE ? '开' : '关'}`);
  // 牌面素材自检（2026-10-20）：清单为空 = 客户端会**静默退回矢量牌面**，
  // 表现成「牌面变成大字」。启动时把目录/张数打出来，部署漏带 public/tiles 一眼可见。
  const tileCount = fs.existsSync(TILES_DIR)
    ? fs.readdirSync(TILES_DIR).filter((f) => /^t\d{2}\.webp$/.test(f)).length
    : 0;
  console.log(
    tileCount === 34
      ? `牌面素材 ${TILES_DIR} · ${tileCount} 张 · 版本 ${TILES_VER}`
      : `⚠ 牌面素材缺失（${TILES_DIR} 里只有 ${tileCount}/34 张）→ 客户端会退回矢量牌面；先跑 npm run build:cdn-tiles 或检查部署是否漏带 public/tiles`,
  );
  // UI 贴图自检（2026-10-21）：同理，清单为空 = 各绘制点回退矢量/文字
  const uiFiles = fs.existsSync(UI_DIR)
    ? UI_GROUPS.flatMap((g) => {
        const d = path.join(UI_DIR, g);
        return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.webp$/.test(f)).map((f) => `${g}/${f}`) : [];
      })
    : [];
  const uiCount = uiFiles.length;
  console.log(
    uiCount >= 24
      ? `UI 贴图 ${UI_DIR} · ${uiCount} 张 · 版本 ${UI_VER}`
      : `⚠ UI 贴图缺失（${UI_DIR} 里只有 ${uiCount}/24 张）→ 牌背/操作钮/结算艺术字/桌面/座位平放牌会回退矢量；先跑 npm run gen:ui-cdn 或检查部署是否漏带 public/ui`,
  );
  // 局内音效自检（2026-10-23）：音效同样走 CDN 清单，缺文件 = 客户端静音回退（不影响对局）
  const soundTotal = Object.keys(SOUND_FILES).length;
  const soundCount = fs.existsSync(SOUND_DIR)
    ? Object.keys(SOUND_FILES).filter((k) => fs.existsSync(path.join(SOUND_DIR, SOUND_FILES[k]))).length
    : 0;
  console.log(
    soundCount === soundTotal
      ? `局内音效 ${SOUND_DIR} · ${soundCount} 个 · 版本 ${SOUND_VER}`
      : `⚠ 局内音效缺失（${SOUND_DIR} 里 ${soundCount}/${soundTotal} 个）→ 客户端静音回退；确认 public/sound 随版本一起发布`,
  );
  console.log('SERVER_READY');
});
