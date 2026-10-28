/**
 * 服务端校验：玩法切换（房主 / 未开局 / 结算窗口 / 清零积分）。
 * 用 4 个裸 WebSocket 客户端自动打完一局赣州（胡牌或流局都会进结算窗口），
 * 以真实结算窗口验证服务端放行与广播。需服务端以 MAHJONG_CEREMONY=0 运行。
 *
 * 用法：
 *   node scripts/variant_settle_server.mjs [端口]     # 端口默认 3130（服务端默认值）
 *   MJ_WS=ws://127.0.0.1:3201/ws node scripts/variant_settle_server.mjs
 *
 * ⚠ 2026-10-24：原脚本把地址硬编码成 `ws://127.0.0.1:3000/ws`，而服务端默认端口
 * 早已是 3130 —— 一运行就 ECONNREFUSED。现改为读参数/环境变量，默认对齐服务端。
 */
const WS_URL =
  process.env.MJ_WS || `ws://127.0.0.1:${Number(process.argv[2] || 3130)}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient() {
  const ws = new WebSocket(WS_URL);
  const msgs = [];
  let acting = false;
  let lastView = null;
  let discards = 0;
  let passes = 0;
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    msgs.push(m);
    if (m.t === 'game') {
      lastView = m.view;
      if (acting) autoAct(m.view);
    }
  });
  const open = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(e));
  });
  function autoAct(v) {
    if (v.phase !== 'playing') return;
    if (v.claims) { ws.send(JSON.stringify({ t: 'pass' })); passes++; return; }
    if (!v.claimWindow && v.turn === v.mySeat && v.myTiles.length > 0) {
      ws.send(JSON.stringify({ t: 'discard', tile: v.myTiles[0] }));
      discards++;
    }
  }
  return {
    ws, msgs, open,
    send: (m) => ws.send(JSON.stringify(m)),
    setActing: (b) => { acting = b; if (b && lastView) autoAct(lastView); },
    stats: () => ({ discards, passes, msgs: msgs.length }),
  };
}
const last = (msgs, t) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].t === t) return msgs[i]; return null; };
const errorsAfter = (msgs, from) => msgs.slice(from).filter((m) => m.t === 'error').map((m) => m.reason);
const kindsAfter = (msgs, t, from) => msgs.slice(from).filter((m) => m.t === t).length;

const cs = [makeClient(), makeClient(), makeClient(), makeClient()];
await Promise.all(cs.map((c) => c.open));
cs[0].send({ t: 'create', name: '房主', variant: 'ganzhou' });
await sleep(250);
const code = last(cs[0].msgs, 'state')?.code;
for (let i = 1; i < 4; i++) cs[i].send({ t: 'join', code, name: '玩家' + i });
await sleep(300);

// 未开局：非房主切换 → 拒绝
let mk = cs[1].msgs.length;
cs[1].send({ t: 'setVariant', variant: 'nanchang' });
await sleep(200);
const nonHostRejected = errorsAfter(cs[1].msgs, mk).some((r) => r.includes('房主'));

// 就绪开局（先不托管，停在庄家第一手，便于做「对局进行中」拒绝用例）
for (const c of cs) c.send({ t: 'ready', ready: true });

// 赣州 `flow.firstDealerRoll === true`：四人就绪后还要**各掷一次定庄骰**才真正开局
// （`canStart` 要求 `firstDealerDecided`；南昌东起庄则不需要这一步）。
// 消息是 `rollDealer`（不是局内的 `rollDice`）；每人一次，4/4 齐了才定庄，
// 定庄后服务端还有 2600ms 骰子动画延时才进对局，所以等待上限放到 12s。
for (const c of cs) c.send({ t: 'rollDealer' });

let started = false;
for (let i = 0; i < 600; i++) { if (last(cs[0].msgs, 'game')?.view?.phase === 'playing') { started = true; break; } await sleep(20); }
if (!started) {
  console.error('❌ 牌局未进入 playing。诊断：', JSON.stringify({
    states: cs.map((c) => last(c.msgs, 'state')?.players?.map((p) => ({ seat: p.seat, ready: p.ready, bot: p.isBot })) ?? null),
    errors: cs.map((c) => errorsAfter(c.msgs, 0)),
  }, null, 2));
  for (const c of cs) c.ws.close();
  process.exit(1);
}

// 对局进行中切换 → 拒绝（此时牌局停在庄家待出牌，稳定 playing）
mk = cs[0].msgs.length;
cs[0].send({ t: 'setVariant', variant: 'nanchang', clearScores: true });
await sleep(250);
const playingRejected = errorsAfter(cs[0].msgs, mk).some((r) => r.includes('进行中'));
const playingNoVariantMsg = kindsAfter(cs[0].msgs, 'variant', mk) === 0;

// 释放托管：自动打完一局直到结算窗口
for (const c of cs) c.setActing(true);
let settled = false;
for (let i = 0; i < 1200; i++) {
  if (last(cs[0].msgs, 'settle')) { settled = true; break; }
  await sleep(100);
}
for (const c of cs) c.setActing(false);

const settleMsg = last(cs[0].msgs, 'settle');
const gv = last(cs[0].msgs, 'game')?.view;
const diag = {
  stats: cs.map((c) => c.stats()),
  lastView: gv ? { phase: gv.phase, turn: gv.turn, wallLeft: gv.wallLeft, claimWindow: gv.claimWindow, awaiting: gv.awaiting } : null,
};

// 结算窗口内房主切换 + 清零积分
mk = cs[1].msgs.length;
let mk2 = cs[2].msgs.length;
cs[0].send({ t: 'setVariant', variant: 'nanchang', clearScores: true });
await sleep(300);
const vMsg1 = last(cs[1].msgs.slice(mk), 'variant');
const vMsg2 = last(cs[2].msgs.slice(mk2), 'variant');

console.log(JSON.stringify({
  code,
  nonHostRejected,
  started,
  playingRejected,
  playingNoVariantMsg,
  settled,
  settleHasRows: Array.isArray(settleMsg?.rows) && settleMsg.rows.length === 4,
  settleSwitchAllowed: !!vMsg1,
  variantBroadcast: vMsg1?.variant,
  broadcastToAllGuests: !!vMsg1 && !!vMsg2 && vMsg2.variant === vMsg1.variant,
  clearedFlag: vMsg1?.cleared === true,
  totalsAfterClear: vMsg1?.totals,
  diag,
}, null, 2));

for (const c of cs) c.ws.close();
