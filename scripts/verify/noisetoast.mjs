/**
 * 服务端校验：常规牌局动作**不再广播 `{t:'event'}` toast**（2026-10-25）。
 *
 * 背景：用户报「打出提示挡牌桌，能不能移除」。根因是 `applyGameEvents()` 给每个
 * GameEvent 都 `broadcastEvent()` 一条 toast，而出牌/吃/碰/杠/报杠本来就在牌河、
 * 副露、画布中心动画、操作记录面板四处表达。
 * 改法：`eventText()` 对 discard/chi/peng/gang/declare 返回 null。
 *
 * 本脚本验两头：
 *   ① 打完整一局，事件里**不应出现**任何「打出/吃/碰/杠/报杠」文案；
 *   ② 房间级事件（加入房间）**仍然照发** —— 不能把整个 event 通道一起关掉。
 *
 * 用法（服务端以 MAHJONG_CEREMONY=0 运行；起服务与跑脚本必须放同一条命令，
 * 否则后台进程会随 bash 命令结束被回收）：
 *   (MAHJONG_CEREMONY=0 PORT=3310 npm run start &) ; sleep 9 ; node scripts/verify/noisetoast.cjs 3310
 */
import { createRequire } from 'node:module';
const WebSocket = createRequire(import.meta.url)('ws');
const WS_URL = process.env.MJ_WS || `ws://127.0.0.1:${Number(process.argv[2] || 3310)}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClient() {
  const ws = new WebSocket(WS_URL);
  const msgs = [];
  let acting = false;
  let lastView = null;
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    msgs.push(m);
    if (m.t === 'game') { lastView = m.view; if (acting) autoAct(m.view); }
  });
  const open = new Promise((res, rej) => {
    ws.addEventListener('open', () => res());
    ws.addEventListener('error', (e) => rej(e));
  });
  function autoAct(v) {
    if (v.phase !== 'playing') return;
    if (v.claims) { ws.send(JSON.stringify({ t: 'pass' })); return; }
    if (v.canZimo) { ws.send(JSON.stringify({ t: 'zimo' })); return; }
    for (const sg of v.selfGangs || []) {
      // 暗杠/补杠也走一遍，顺带覆盖 gangRoll 事件
      ws.send(JSON.stringify({ t: 'selfGang', kind: sg.kind, tile: sg.tile }));
      return;
    }
    if (!v.claimWindow && v.turn === v.mySeat && v.myTiles.length > 0) {
      ws.send(JSON.stringify({ t: 'discard', tile: v.myTiles[0] }));
    }
  }
  return {
    ws, msgs, open,
    send: (m) => ws.send(JSON.stringify(m)),
    setActing: (b) => { acting = b; if (b && lastView) autoAct(lastView); },
  };
}
const last = (msgs, t) => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].t === t) return msgs[i]; return null; };
const events = (msgs) => msgs.filter((m) => m.t === 'event').map((m) => m.text);

/** 常规牌局动作文案特征（与服务端 eventText / 客户端 PLAY_ACTION_EVENT 同一口径） */
const PLAY_ACTION = /^[^·\s]+·.+?\s(报杠|打出|吃|碰|杠)\s/;

(async () => {
  const cs = [makeClient(), makeClient(), makeClient(), makeClient()];
  await Promise.all(cs.map((c) => c.open));
  cs[0].send({ t: 'create', name: '房主', variant: 'ganzhou' });
  await sleep(300);
  const code = last(cs[0].msgs, 'state')?.code || last(cs[0].msgs, 'code')?.code;
  if (!code) {
    console.error('❌ 没拿到房间号，服务端可能没起来（' + WS_URL + '）');
    for (const c of cs) c.ws.close();
    process.exit(1);
  }

  // ② 房间级事件必须还在：后三个人加入 → 房主应收到「加入了房间」
  const beforeJoin = cs[0].msgs.length;
  for (let i = 1; i < 4; i++) cs[i].send({ t: 'join', code, name: '玩家' + i });
  await sleep(500);
  const joinEvents = events(cs[0].msgs.slice(beforeJoin));

  // 开局（赣州：四人就绪后各掷一次定庄）
  for (const c of cs) c.send({ t: 'ready', ready: true });
  await sleep(250);
  for (const c of cs) c.send({ t: 'rollDealer' });

  let started = false;
  for (let i = 0; i < 900; i++) {
    if (last(cs[0].msgs, 'game')?.view?.phase === 'playing') { started = true; break; }
    await sleep(20);
  }
  if (!started) {
    console.error('❌ 牌局未进入 playing，无法验证');
    for (const c of cs) c.ws.close();
    process.exit(1);
  }

  // ① 打满一整局，收集全部事件
  const markAll = cs.map((c) => c.msgs.length);
  for (const c of cs) c.setActing(true);
  let over = false;
  for (let i = 0; i < 4000; i++) {
    if (last(cs[0].msgs, 'game')?.view?.phase === 'over') { over = true; break; }
    await sleep(20);
  }
  const playEvents = cs.flatMap((c, i) => events(c.msgs.slice(markAll[i])));
  const noisy = playEvents.filter((t) => PLAY_ACTION.test(t));

  const fails = [];
  const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };

  console.log('== ② 房间级 event 通道仍然可用 ==');
  console.log(`  加入房间事件 ${joinEvents.length} 条：${JSON.stringify(joinEvents.slice(0, 3))}`);
  ok(joinEvents.length >= 3, `三个玩家加入 → 至少 3 条「加入了房间」事件（实收 ${joinEvents.length}）`);
  ok(joinEvents.every((t) => String(t).includes('加入了房间')), `加入事件文案正确`);

  console.log(`== ① 一整局打下来（${over ? '正常进入结算' : '超时未进结算'}）==`);
  console.log(`  event 总数 ${playEvents.length} 条；其中常规牌局动作 ${noisy.length} 条`);
  if (playEvents.length) console.log('  保留的事件样例：' + JSON.stringify(playEvents.slice(0, 4)));
  if (noisy.length) console.log('  ❗仍会弹的样例：' + JSON.stringify(noisy.slice(0, 5)));
  ok(noisy.length === 0, `出牌/吃/碰/杠/报杠 一条事件都没发（实发 ${noisy.length}）`);

  console.log(`\n== 结果：${fails.length === 0 ? '全部通过' : fails.length + ' 项失败'} ==`);
  for (const c of cs) c.ws.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
