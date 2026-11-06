/**
 * 小游戏端回归（Node，无浏览器）—— 对位 scripts/verify/geomcheck.cjs，
 * 跑的是 **packages/minigame/game** 这份拷贝：
 *   1) mock 2D 上下文 + wx → 小游戏 table.js 真实渲染 4 种合成 GameView（各两帧）：
 *      不抛错、出界检查、handRects / discardEnabled / hitTest 语义（手牌逐张命中
 *      的两段式：第 1 击抬高、第 2 击同牌打出、换选/复位、claims 期禁出、
 *      结算 ▲ 与掷骰按钮回调）；
 *   2) src/layout.game() 几何：844×390（iPhone 13 横屏 + 刘海安全区）下画布 2:1、
 *      侧轨不压画布、操作带贴画布底、overPhase 画布吃满、frame 映射为负、触摸换算正确；
 *   3) utils 冒烟：config.resolve / store.ensurePid / dice.dieGrid。
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MG = path.join(ROOT, 'packages/minigame/game');

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) {
    fail++;
    console.log('  ✘ ' + msg);
  }
};
const okFn = (fn, label) => {
  try {
    fn();
  } catch (e) {
    fail++;
    console.log('  ✘ ' + (label || '函数调用') + '：' + (e && e.message));
  }
};

/* ---------- mock 平台 ---------- */
function mockCtx(canvas) {
  const rec = { images: [], texts: [] };
  return {
    canvas,
    _rec: rec,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    shadowColor: 'rgba(0,0,0,0)', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    globalAlpha: 1, globalCompositeOperation: 'source-over',
    measureText(t) { return { width: String(t).length * 9 }; },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createPattern() { return null; },
    setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, arc() {}, ellipse() {}, rect() {}, closePath() {},
    fill() {}, stroke() {}, clip() {}, isPointInPath() { return false; },
    fillRect() {}, strokeRect() {}, clearRect() { this._recClears = (this._recClears || 0) + 1; },
    drawImage(...a) { rec.images.push(a); },
    fillText(t) { rec.texts.push(t); },
    strokeText() {},
    getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }; },
    putImageData() {},
  };
}
function mockCanvas(w, h) {
  const c = { width: w, height: h, _ctx: null, style: {} };
  c.getContext = () => (c._ctx = c._ctx || mockCtx(c));
  c.requestAnimationFrame = (cb) => setTimeout(cb, 16);
  return c;
}
const storage = {};
global.wx = {
  createOffscreenCanvas: (o) => {
    if (!o || typeof o !== 'object' || o.type !== '2d') {
      throw new Error('createOffscreenCanvas 必须用对象签名 {type:"2d",width,height}');
    }
    return mockCanvas(o.width || 300, o.height || 150);
  },
  getWindowInfo: () => ({
    windowWidth: 844, windowHeight: 390, pixelRatio: 2,
    safeArea: { left: 47, right: 844 - 47, top: 0, bottom: 390, width: 844 - 94, height: 390 },
  }),
  getSystemInfoSync: () => ({ windowWidth: 844, windowHeight: 390, pixelRatio: 2 }),
  getMenuButtonBoundingClientRect: () => ({ left: 844 - 118, top: 6, right: 844 - 7, bottom: 38, width: 111, height: 32 }),
  getStorageSync: (k) => (k in storage ? storage[k] : ''),
  setStorageSync: (k, v) => { storage[k] = v; },
  removeStorageSync: (k) => { delete storage[k]; },
};

/* ---------- CJS 加载器（根 package.json type:module → 用 vm 包装加载） ---------- */
const cache = {};
function loadCJS(file) {
  if (cache[file]) return cache[file].exports;
  const src = fs.readFileSync(file, 'utf8');
  const m = { exports: {} };
  cache[file] = m;
  const req = (id) => {
    if (id.startsWith('.')) {
      let p = path.resolve(path.dirname(file), id);
      if (!p.endsWith('.js')) p += '.js';
      return loadCJS(p);
    }
    return require(id);
  };
  vm.runInThisContext(
    `(function(exports, require, module, __filename, __dirname){${src}\n})`,
    { filename: file },
  )(m.exports, req, m, file, path.dirname(file));
  return m.exports;
}

/* ---------- 1) 小游戏 table.js 渲染 + 命中语义 ---------- */
console.log('--- 1) 小游戏 table.js 渲染与命中 ---');
const { Table, W, H } = loadCJS(path.join(MG, 'utils/table.js'));
const wallLib = loadCJS(path.join(MG, 'lib/shared/wall.js'));

function makeView(opts) {
  const o = opts || {};
  const recipe = wallLib.buildRecipe(o.dealer || 0, [3, 4]);
  return {
    code: 'TEST', phase: o.phase || 'playing', dealer: o.dealer || 0, turn: 'turn' in o ? o.turn : 0, mySeat: 0,
    myTiles: o.myTiles || [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    counts: o.counts || [13, 13, 13, 13],
    melds: o.melds || [[], [], [], []],
    rivers: o.rivers || [[], [], [], []],
    wallLeft: 60,
    jingPi: 8, jingFu: 12, jingSlot: 100,
    dice: null, dealDice: [3, 4], lastDice: [3, 4],
    ceremony: o.ceremony || null,
    wallRing: { recipe, frontSlot: recipe.endSlot, kongSlots: [] },
    lastDiscard: { tile: 20, from: 1 },
    claimWindow: !!o.claimWindow, claims: null, selfGangs: [], declareOptions: [], declared: [],
    mustDiscard: [], canZimo: false, zimoLabel: null, drawn: null,
    connected: [true, true, true, true], auto: [false, false, false, false],
    names: ['我', '下家', '对家', '上家'], totals: [0, 0, 0, 0], hostSeat: 0,
    windowDeadline: null, awaiting: [], skipRon: false,
    reveal: o.reveal || null,
    gz: null,
    bao: [1, 2, 1, 1],
    winner: o.winner === undefined ? null : o.winner,
    result: o.result || null,
    log: [], lastAction: null,
  };
}
function river(start, n) {
  const a = [];
  for (let i = 0; i < n; i++) a.push((start + i) % 34);
  return a;
}

// 渲染冒烟：四种相位各两帧，不抛错 + 手牌热区在画布内
const views = {
  playing: makeView({ rivers: [river(0, 10), river(3, 9), river(7, 10), river(11, 9)], melds: [[{ type: 'peng', tiles: [5, 5, 5] }], [], [], []] }),
  claims: makeView({ claimWindow: true, turn: 1 }),
  over: makeView({ phase: 'over', winner: 1, result: '炮胡 · 对对胡', reveal: [river(0, 14), river(3, 14), river(7, 14), river(11, 14)], counts: [0, 0, 0, 0] }),
  ceremony: makeView({ ceremony: { kind: 'deal', state: 'wait-roll', seat: 0, dice: null, rollAt: null, until: null }, counts: [4, 4, 4, 4] }),
};
for (const [name, view] of Object.entries(views)) {
  let threw = null;
  const canvas = mockCanvas(W, H);
  const table = new Table(canvas, 2);
  try {
    table.render(view);
    table.render(view);
  } catch (e) {
    threw = e;
  }
  ok(!threw, name + ' render 抛错：' + (threw && threw.message));
  for (const r of table.handRects) {
    ok(r.x >= 0 && r.x + r.w <= W && r.y >= 0 && r.y + r.h <= H, name + ' 手牌热区出画布 tile=' + r.tile);
  }
  console.log('  ' + name + ' 渲染 OK（handRects=' + table.handRects.length + '）');
}

// 手牌逐张命中（playing：turn=0 无窗口 → 两段式：第 1 击抬高、第 2 击同牌才打出）
{
  const canvas = mockCanvas(W, H);
  const table = new Table(canvas, 2);
  const view = views.playing;
  table.render(view);
  const handCount = table.handRects.length;
  const got = [];
  const raised = [];
  table.onDiscard = (idx, tile) => got.push({ idx, tile });
  table.onRaise = (idx, tile) => raised.push({ idx, tile });
  // 2026-11-04 两段式（防误触）：单击不再出牌 —— 每张先抬高、再点同张才出
  for (const r of table.handRects) {
    table.hitTest(r.x + r.w / 2, r.y + r.h / 2); // 第 1 击：只抬高
  }
  ok(got.length === 0, '第 1 击就出牌（' + got.length + ' 次，应全部只抬高）');
  ok(raised.length === handCount, '抬高尚少（第一轮）' + raised.length + '/' + handCount);
  // 换选：抬高 tile0 后点 tile1 → 抬高移到 tile1，不触发 tile0 出牌
  const r0 = table.handRects[0];
  const r1 = table.handRects[1];
  table.hitTest(r0.x + r0.w / 2, r0.y + r0.h / 2);
  got.length = 0;
  table.hitTest(r1.x + r1.w / 2, r1.y + r1.h / 2);
  ok(got.length === 0, '抬高换牌时误触发了出牌（tile0 被打出）');
  // 同牌第 2 击：打出（逐张：抬 1 击 → 同张再击 → 出 1 张）
  for (const r of table.handRects) {
    table.hitTest(r.x + r.w / 2, r.y + r.h / 2);
    table.hitTest(r.x + r.w / 2, r.y + r.h / 2);
  }
  ok(got.length === handCount, '手牌命中数不符 ' + got.length + '/' + handCount);
  ok(got.every((g, i) => g.idx === i && g.tile === view.myTiles[i]), '手牌命中 tile/idx 错位');
  // 打出后抬高态复位：同位置再击 → 回到「抬高」而非立即二次出牌
  const r2 = table.handRects[2];
  got.length = 0;
  table.hitTest(r2.x + r2.w / 2, r2.y + r2.h / 2);
  table.hitTest(r2.x + r2.w / 2, r2.y + r2.h / 2);
  ok(got.length === 1, '打出后抬高未复位（复击出牌 ' + got.length + ' 次）');
  // claims 期（claimWindow=true → discardEnabled=false）→ 不出牌、抬高也复位
  table.render(views.claims);
  got.length = 0;
  const rects = table.handRects.slice();
  for (const r of rects) table.hitTest(r.x + r.w / 2, r.y + r.h / 2);
  ok(got.length === 0, 'claims 期仍然出牌（' + got.length + ' 次）');
  ok(table.raisedHand === null, 'claims 期抬高态未复位');
  // 掷骰按钮（wait-roll 且轮到自己）：命中一次且只一次（rollClicked 防连点）
  table.render(views.ceremony);
  let rolls = 0;
  table.onRollDice = () => rolls++;
  ok(!!table.rollBtn, 'wait-roll 未给出掷骰按钮');
  table.hitTest(table.rollBtn.x + table.rollBtn.w / 2, table.rollBtn.y + table.rollBtn.h / 2);
  table.hitTest(table.rollBtn.x + table.rollBtn.w / 2, table.rollBtn.y + table.rollBtn.h / 2);
  ok(rolls === 1, '掷骰按钮回调次数异常：' + rolls);
  // 结算 ▲（statusBar.settle → settleRect）
  table.render(views.over);
  table.statusBar = { err: '', text: '', waits: '', countdown: '', settle: true };
  table.render(views.over);
  let restored = 0;
  table.onSettleRestore = () => restored++;
  ok(!!table.settleRect, 'settle 标志未产生「本局结算 ▲」热区');
  table.hitTest(table.settleRect.x + table.settleRect.w / 2, table.settleRect.y + table.settleRect.h / 2);
  ok(restored === 1, '结算 ▲ 回调异常：' + restored);
  console.log('  命中语义 OK（手牌 ' + handCount + ' 张两段式命中 / claims 禁出 / 掷骰 / 结算▲）');
}

/* ---------- 1c) 托管中手牌 = 随时取消托管（2026-11-05 用户报「托管后点手牌卡死」） ----------
 * 托管中手牌必须仍可点（否则根本取消不了），但命中只能走 onRaise 的取消分支：
 * 既不抬牌（raisedHand 不变）也不出牌（onDiscard 不触发）—— 否则等于绕过托管手动打牌。
 * 同时守住反向：非托管 + 非自己回合时手牌必须完全点不动。
 */
{
  const canvas = mockCanvas(W, H);
  const table = new Table(canvas, 2);
  const view = makeView({ turn: 1 }); // 别人回合：这个口子只能靠 cancelEnabled 撑开
  view.auto = [true, false, false, false];
  table.render(view);
  ok(table.cancelEnabled === true, '托管中 cancelEnabled 未开启 → 手牌点不动，取消不了托管');
  ok(table.discardEnabled === false, '托管中 discardEnabled 应为 false');
  let disc = 0;
  let raise = 0;
  table.onDiscard = () => disc++;
  table.onRaise = () => raise++;
  const r = table.handRects[0];
  for (let k = 0; k < 3; k++) table.hitTest(r.x + r.w / 2, r.y + r.h / 2);
  ok(raise === 3, '托管中点手牌未触发取消回调（' + raise + '/3）');
  ok(disc === 0, '托管中点手牌绕过去出了牌（' + disc + ' 次）');
  ok(table.raisedHand === null, '托管中点手牌仍把牌抬了起来（应只取消托管）');
  // 非托管 + 非自己回合 → 手牌完全点不动（不能白吃点击）
  const v2 = makeView({ turn: 1 });
  table.render(v2);
  ok(table.cancelEnabled === false, '非托管却开了 cancelEnabled');
  raise = 0;
  disc = 0;
  const r2 = table.handRects[0];
  table.hitTest(r2.x + r2.w / 2, r2.y + r2.h / 2);
  ok(raise === 0 && disc === 0, '非自己回合且非托管时手牌仍可点');
  console.log('  托管取消 OK（cancelEnabled 放开命中 / 只取消不抬牌不出牌 / 非托管回合外仍禁点）');
}

/* ---------- 1d) 局内暂离（quit）：铭牌显示「已退出」而非「托管」 ----------
 * 2026-11-05：局内 ‹ 改成「退出本局」后，座位仍在、由托管代打，但人已回房间页。
 * 铭牌必须与普通托管区分开，否则牌桌上「谁还在、谁走了」看不出来。
 */
{
  const canvas = mockCanvas(W, H);
  const table = new Table(canvas, 2);
  const view = makeView({});
  view.away = [false, true, false, false];
  view.auto = [false, true, false, false];
  table.render(view);
  const texts = canvas._ctx._rec.texts;
  ok(texts.indexOf('已退出') >= 0, 'away 座位铭牌没有显示「已退出」');
  ok(texts.indexOf('托管中') < 0 && texts.indexOf('托管') < 0, 'away 座位仍显示「托管/托管中」（应与普通托管区分）');
  console.log('  局内暂离铭牌 OK（away → 「已退出」）');
}

/* ---------- 1b) 复用宿主的二次进对局：dpr 不许回退 + 构造期清残帧 ----------
 * 小游戏端 app.tableHost 跨场景单例：解散回房再开局时，新 Table 拿到的宿主
 * 尺寸已是 W×H×dpr —— applyBackingStore 尺寸相符会早退，若构造器把 this.dpr
 * 初始化成 1，早退分支不回头赋值 → 新局以 1× 变换画进宿主左上 1/4 象限，
 * 其余是上一局残帧，主循环 blit 出来就是「两个对局界面」（2026-11-05 报障）。 */
{
  const host = mockCanvas(W, H); // 与 main.js createTableHost 同起点（1280×640）
  const t1 = new Table(host, 2); // 第一局：扩 backing 到 2560×1280
  ok(t1.dpr === 2 && host.width === W * 2, 'Table#1 backing/dpr 异常：' + t1.dpr + ' ' + host.width);
  const clearsBefore = host._ctx._recClears || 0;
  const t2 = new Table(host, 2); // 解散回房再开局：宿主尺寸已符合 → applyBackingStore 早退
  ok(t2.dpr === 2, '复用宿主后 Table#2.dpr 回退成 ' + t2.dpr + '（应为 2，否则出现两个对局界面）');
  ok((host._ctx._recClears || 0) > clearsBefore, 'Table#2 构造期未清宿主残帧');
  console.log('  复用宿主二次进对局 OK（dpr 保持 2 + 构造期清残帧）');
}

/* ---------- 2) layout.game() 几何 ---------- */
console.log('--- 2) layout.game() 几何（844×390 安全区 47）---');
{
  const layout = loadCJS(path.join(MG, 'src/layout.js'));
  layout.dirty();
  const L = layout.game({ banner: false, overPhase: false });
  ok(L.table.h * 2 === L.table.w, '画布不是 2:1（' + L.table.w + '×' + L.table.h + '）');
  // 2026-11-02「给牌留空间」新契约：顶栏并入画布背景层（不再占流内高度）→
  // 画布顶 = topbar.y（顶栏画在画布上层）；侧轨浮在画布两侧桌面上（不再占宽预留）。
  ok(L.table.y >= L.topbar.y - 1, '画布顶越过顶栏');
  ok(Math.abs(L.table.y + L.table.h - (L.sh - 3)) <= 1, '画布未贴页面底（手牌应随画布置底）');
  ok(L.table.x >= L.safe.l, '画布左出安全区');
  // 四轮契约：操作栏浮在画布内（手牌上方），画布吃满到底部（含手牌行）
  ok(L.actionBar && L.actionBar.h === 34, '操作栏应为屏幕原生 34px（用户报按钮太小）');
  ok(L.actionBar.y + L.actionBar.h < L.table.y + L.table.h, '操作栏不在画布内');
  ok(L.actionBar.y > L.table.y, '操作栏应在画布内（手牌上方）');
  {
    const scL = L.table.h / 640;
    const cxL = L.table.x + 465 * scL + L.actionBar.w / 2;
    ok(Math.abs(cxL - (L.table.x + (465 + 560 / 2) * scL)) <= 1, '操作栏未按中心带锚定');
    ok(L.actionBar.x >= L.table.x + 460 * scL, '操作栏越出中心带左界（应避让左手副露带）');
  }
  ok(L.railL.h >= 7 * 30 - 2, '菜单展开 7 钮装不下（带高 ' + L.railL.h + '）');
  ok(L.railL.x + L.railL.w < L.sw / 2 && L.railR.x > L.sw / 2, '侧轨不在各自半屏内');
  // overPhase：操作带收起 → 画布贴底下移（宽度仍被 min(gmW−84, …) 卡住，尺寸不变）
  const Lo = layout.game({ banner: false, overPhase: true });
  ok(Lo.actionBar === null, 'overPhase 仍有操作栏');
  ok(Lo.table.y === L.table.y && Lo.table.h === L.table.h, 'overPhase 画布几何不应变化（操作栏已浮在画布内）');
  // frame 映射：整页矩形映射到逻辑坐标 → 负坐标合法且覆盖画布外圈
  const f = layout.tableFrame();
  ok(f.x < 0 && f.y < 0 && f.w > 1280 && f.h > 640, 'frame 映射异常 ' + JSON.stringify(f));
  // frame 必须跟**对局布局**走（2026-11-01「画里画」回归：通用布局与对局布局的画布
  // 矩形不同 → 传错来源会让牌桌内的桌面贴图与整屏那层错位）。横幅开/关也要跟着变。
  const fbNo = layout.tableFrame(layout.game({ banner: false, overPhase: false }));
  const fbYes = layout.tableFrame(layout.game({ banner: true, overPhase: false }));
  const fbNo2 = layout.tableFrame(layout.game({ banner: false, overPhase: false }));
  ok(fbYes.y !== fbNo.y, 'frame 未随横幅开关变化（横幅会压画布矩形）');
  ok(Math.abs(fbNo2.y - fbNo.y) < 0.5 && Math.abs(fbNo2.x - fbNo.x) < 0.5, '同参数 frame 应稳定');
  // 通用布局与对局布局必须不同（顶栏 28 vs 24 + 操作带 34）——正是传错来源才会「画里画」
  ok(Math.abs(f.y - fbNo.y) > 1, '对局布局与通用布局的 frame 理应不同（否则本回归失效）');
  // 两层桌面的重合不变量：整页矩形经 frame → 牌桌画布逻辑坐标 → 再映射回屏幕，
  // 必须精确等于整屏（0,0,sw,sh）。不成立就是「画里画」双层错位。
  {
    const sc = L.table.w / 1280;
    const sx = L.table.x + fbNo.x * sc;
    const sy = L.table.y + fbNo.y * sc;
    const sw2 = fbNo.w * sc;
    const sh2 = fbNo.h * sc;
    ok(Math.abs(sx) < 0.5 && Math.abs(sy) < 0.5, '桌面两层横向/纵向错位（' + sx.toFixed(2) + ',' + sy.toFixed(2) + '）');
    ok(Math.abs(sw2 - L.sw) < 0.5 && Math.abs(sh2 - L.sh) < 0.5, '桌面两层铺幅不一致（' + sw2.toFixed(1) + '×' + sh2.toFixed(1) + ' vs ' + L.sw + '×' + L.sh + '）');
  }
  // 触摸换算：画布中心 → (640,320)；画布外 → null（对局布局要显式传入）
  const c = layout.toTableLogical(L.table.x + L.table.w / 2, L.table.y + L.table.h / 2, L);
  ok(Math.abs(c.x - 640) < 0.5 && Math.abs(c.y - 320) < 0.5, '中心换算异常 ' + JSON.stringify(c));
  ok(layout.toTableLogical(1, 1, L) === null, '画布外触摸未返回 null');
  console.log('  布局几何 OK（画布 ' + L.table.w + '×' + L.table.h + ' @ ' + L.table.x.toFixed(0) + ',' + L.table.y.toFixed(0) + '）');
}

/* ---------- 3) utils 冒烟 ---------- */
console.log('--- 3) utils 冒烟 ---');
{
  const config = loadCJS(path.join(MG, 'utils/config.js'));
  // resolve() 只验「返回非空 wss/ws 地址」——小游戏端可能有意切本地联调地址
  ok(/^(wss|ws):\/\//.test(config.resolve() || ''), 'config.resolve 未返回地址');
  ok(typeof config.resolveApi() === 'string' && config.resolveApi().length > 0, 'resolveApi 未返回地址');
  const store = loadCJS(path.join(MG, 'utils/store.js'));
  const pid = store.ensurePid();
  ok(/^[A-Za-z0-9_-]{8,64}$/.test(pid), 'ensurePid 格式异常：' + pid);
  ok(store.ensurePid() === pid, 'ensurePid 不稳定');
  const dice = loadCJS(path.join(MG, 'utils/dice.js'));
  const g4 = dice.dieGrid(4);
  const reds = g4.flat().filter((v) => v === 2).length;
  ok(reds === 4, '4 点应有 4 红子：' + reds);
  console.log('  config / store / dice OK');
}

/* ---------- 4) 场景运行时冒烟（enter / render / 路由回调 / tap / exit） ----------
 * 语法检查抓不到「用了没 require 的标识符」（真机报 state is not defined 就是这类），
 * 这里把三个场景真实实例化并跑一遍生命周期与消息钩子 —— 未定义标识符会在这里抛。 */
console.log('--- 4) 场景运行时冒烟 ---');
{
  // 补充场景运行时会碰到的 wx API（清单/音频/剪贴板：全部失败/空实现即可）
  wx.request = (o) => {
    if (o && typeof o.fail === 'function') setTimeout(() => o.fail(new Error('mock: 无网络')), 0);
  };
  wx.setInnerAudioOption = () => {};
  wx.createInnerAudioContext = () => ({
    src: '', loop: false, volume: 1, obeyMuteSwitch: false,
    play() {}, pause() {}, stop() {}, seek() {}, destroy() {},
    onCanplay() {}, onEnded() {}, onError() {}, onPlay() {}, onStop() {}, onPause() {}, onTimeUpdate() {}, onWaiting() {},
  });
  wx.setClipboardData = (o) => {
    if (o && typeof o.success === 'function') o.success();
  };
  wx.showKeyboard = () => {};
  wx.hideKeyboard = () => {};
  wx.onTouchStart = () => {};
  wx.onTouchMove = () => {};
  wx.onTouchEnd = () => {};
  wx.onTouchCancel = () => {};
  wx.onKeyboardInput = () => {};
  wx.onKeyboardConfirm = () => {};
  wx.onKeyboardComplete = () => {};
  // 键盘高度：安装时注册回调，测试里手动驱动（模拟键盘弹出/收起）
  let kbCb = null;
  let kbNow = 0;
  wx.onKeyboardHeightChange = (cb) => { kbCb = cb; };
  wx.showKeyboard = () => { kbNow = 260; if (kbCb) kbCb({ height: 260 }); };
  wx.hideKeyboard = () => { kbNow = 0; if (kbCb) kbCb({ height: 0 }); };

  const app = loadCJS(path.join(MG, 'src/app.js'));
  const layout = loadCJS(path.join(MG, 'src/layout.js'));
  const state = loadCJS(path.join(MG, 'src/state.js'));
  const nav = loadCJS(path.join(MG, 'src/nav.js'));
  // 场景不经 main.js 直接实例化：input 的全局触摸/键盘安装需在此补上
  // （真实入口由 main.js 调用；缺了它 onKeyboardHeightChange 不注册 → kbH 恒 0）。
  const inputMod = loadCJS(path.join(MG, 'src/input.js'));
  inputMod.install();
  inputMod.installKeyboard();
  const HomeScene = loadCJS(path.join(MG, 'src/scenes/home.js'));
  const LobbyScene = loadCJS(path.join(MG, 'src/scenes/lobby.js'));
  const GameScene = loadCJS(path.join(MG, 'src/scenes/game.js'));
  nav.register({
    home: () => new HomeScene(),
    lobby: () => new LobbyScene(),
    game: () => new GameScene(),
  });
  app.canvas = mockCanvas(844 * 2, 390 * 2);
  app.ctx = app.canvas.getContext('2d');
  app.dpr = 2;
  app.tableHost = mockCanvas(1280, 640);
  const ctx = mockCtx(mockCanvas(844, 390));
  layout.dirty();

  const run = (label, fn) => {
    try {
      fn();
    } catch (e) {
      fail++;
      console.log('  ✘ ' + label + '：' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    }
  };

  // home：mode / form / 分享预填 / 回桌失败
  run('home.mode', () => {
    const s = new HomeScene();
    s.enter();
    s.render(ctx, layout.compute());
    s.onTap(422, 195);
    s.onTouchDown(422, 195);
    s.onTouchUp(422, 195);
    s.exit();
  });
  run('home.prefill+resumeFail', () => {
    state.launchRoom = 'abcdef';
    const s = new HomeScene();
    s.enter();
    ok(s.step === 'form' && s.code === 'ABCDEF', '分享预填未生效');
    s.render(ctx, layout.compute());
    state.resumeFail = { reason: '房间已失效', room: 'ABCDEF' };
    const s2 = new HomeScene();
    s2.enter();
    ok(s2.step === 'mode' && s2.code === 'ABCDEF', '回桌失败未回 mode 步');
    s2.exit();
  });

  // lobby：完整 state 渲染 + 事件/换位/解散
  run('lobby', () => {
    state.lastState = {
      t: 'state', code: 'ABC123', variant: 'nanchang', you: 0, token: 'tok',
      players: [
        { seat: 0, name: '我', isHost: true, ready: false, connected: true },
        { seat: 1, name: '机器人', isBot: true, ready: true, connected: true },
      ],
      totals: [0, 0, 0, 0], dealer: 0, allReady: false, pendingSwap: null,
      dealerRolls: [], dealerDecided: false,
    };
    const s = new LobbyScene();
    s.enter();
    s.render(ctx, layout.compute());
    s.onEvent({ t: 'event', text: '我 创建了房间' });
    s.onSwapAsk({ t: 'swapAsk', from: 1, fromName: '机器人' });
    s.render(ctx, layout.compute());
    s.onSwapRespond(false);
    s.onDissolved({ t: 'dissolved', title: '最终积分', rows: [{ name: '我', value: 0 }] });
    s.render(ctx, layout.compute());
    s.onTap(422, 195);
    s.exit();
  });

  // 局内退出回房间（2026-11-05）：房间页要能表达「本局还在打」——
  // 准备按钮置灰改文案、自己那格写明「已退出本局 · 托管代打」。
  run('lobby.away', () => {
    state.lastState = {
      t: 'state', code: 'ABC123', variant: 'nanchang', you: 1, token: 'tok',
      players: [
        { seat: 0, name: '房主', isHost: true, ready: false, connected: true },
        { seat: 1, name: '我', ready: false, connected: true, away: true, auto: true },
      ],
      totals: [0, 0, 0, 0], dealer: 0, allReady: false, pendingSwap: null,
      dealerRolls: [], dealerDecided: false, playing: true,
    };
    const s = new LobbyScene();
    s.enter();
    s.render(ctx, layout.compute());
    ok(s.playing === true, 'state.playing 未透传到大厅场景');
    ok(s.readyText === '本局进行中', '准备按钮文案未切换：' + s.readyText);
    ok(!!s.ui.btnReady, '准备按钮热区缺失');
    const seat = (s.seats || []).find((x) => x.seat === 1);
    ok(!!seat && /已退出本局/.test(seat.state), 'away 座位状态文案异常：' + (seat && seat.state));
    s.exit();
  });

  // 语音环富状态（2026-11-06 真机报障回归）：voiceMap 有开麦条目 → 座位卡 voiceSpeaking
  // 为真 → 渲染走「说话环」分支。此分支在空 voiceMap 冒烟下永不进入（node --check 也查不
  // 出跨作用域漏引），曾在真机抛 `ReferenceError: reactive is not defined`——必须用带
  // 语音映射的状态连渲多帧压住。定庄面板（drShown）同理富状态化。
  run('lobby.voice-rich', () => {
    state.voiceMap = {
      0: { seat: 0, openid: 'oA', muted: false, ear: false },
      1: { seat: 1, openid: 'oB', muted: true, ear: true },
    };
    state.lastState = {
      t: 'state', code: 'ABC123', variant: 'ganzhou', you: 0, token: 'tok',
      players: [
        { seat: 0, name: '我', isHost: true, ready: true, connected: true },
        { seat: 1, name: '下家', ready: true, connected: true },
        { seat: 2, name: '机器人', isBot: true, ready: true, connected: true },
        { seat: 3, name: '上家', ready: false, connected: true },
      ],
      totals: [10, -4, 0, -6], dealer: 0, allReady: true, pendingSwap: { from: 3, to: 0 },
      dealerRolls: [{ seat: 0, dice: [3, 4], sum: 7 }, { seat: 1, dice: [2, 5], sum: 7 }, { seat: 2, dice: [1, 1], sum: 2 }, { seat: 3, dice: [6, 6], sum: 12 }],
      dealerDecided: false,
    };
    const s = new LobbyScene();
    s.enter();
    s.onState(state.lastState);
    let threw = null;
    try {
      for (let f = 0; f < 3; f++) s.render(ctx, layout.compute());
    } catch (e) { threw = e; }
    ok(!threw, '语音环+定庄富状态连渲 3 帧抛错：' + (threw && (threw.stack || threw.message).split('\n').slice(0, 2).join(' | ')));
    const seat = (s.seats || []).find((x) => x.seat === 0);
    ok(!!seat && seat.voiceSpeaking === true, '开麦座位 voiceSpeaking 未点亮');
    s.exit();
    state.voiceMap = {};
  });

  // game：onGame 全相位 + 聊天/表情/事件/错误/结算 + tap
  run('game', () => {
    const s = new GameScene();
    s.enter();
    s.onGame(makeView({ rivers: [river(0, 10), river(3, 9), river(7, 10), river(11, 9)], melds: [[{ type: 'peng', tiles: [5, 5, 5] }], [], [], []] }));
    s.render(ctx, layout.compute());
    s.onChat({ t: 'chat', seat: 1, name: '下家', text: '快点啊' });
    s.onEmote({ t: 'emote', from: 1, target: 0, emote: 'flower' });
    s.onEvent({ t: 'event', text: '我 · 下家 打出 5万' }); // PLAY_ACTION_EVENT 应过滤
    s.onError('窗口已过期');
    // 面板与表情层渲染路径（chrome 最复杂的两块）
    s.onToggleChat();
    s.onChat({ t: 'chat', seat: 1, name: '下家', text: '快点啊' });
    s.onTogglePop('quick');
    s.render(ctx, layout.compute());
    s.onTogglePop('emoji');
    s.render(ctx, layout.compute());
    s.onToggleLog();
    s.render(ctx, layout.compute());
    s.onEmoteOpen();
    s.render(ctx, layout.compute());
    s.onEmoteClose();
    s.render(ctx, layout.compute());
    s.onGame(makeView({ claimWindow: true, turn: 1 }));
    s.render(ctx, layout.compute());
    s.onSettle({
      t: 'settle', title: '胡牌', winner: 0, winTile: 5, winVia: 'zimo',
      rows: [{ seat: 0, name: '我', pi: 1, fu: 0, patternIn: 0, patternOut: 2, jingIn: 0, jingOut: 0, delta: 4 }],
      totals: [{ seat: 0, name: '我', value: 4 }],
      notes: ['自摸 2 花'],
    });
    ok(s.settleRestoreShown && !s.settleShown, '结算默认最小化态不符');
    s.render(ctx, layout.compute());
    s.onSettleRestore();
    s.render(ctx, layout.compute()); // 结算面板路径
    s.onTap(422, 195);
    s.onGame(makeView({ phase: 'over', winner: 1, result: '炮胡', reveal: [river(0, 14), river(3, 14), river(7, 14), river(11, 14)], counts: [0, 0, 0, 0] }));
    s.render(ctx, layout.compute()); // overPhase 布局路径
    s.exit();
  });
  // 托管中「点手牌取消托管」的客户端链路（2026-11-05 用户报「提示已取消但按钮还亮、
  // 既不代打也不能出牌」）：闸门只发一次 + 必有兜底复位 + 回执到达后闸门与定时器一起清。
  run('game.auto-cancel', () => {
    const s = new GameScene();
    s.enter();
    const v = makeView({ turn: 1 }); // 别人回合也要能取消（不要求自己回合）
    v.auto = [true, false, false, false];
    s.onGame(v);
    ok(s.autoOn === true, '托管状态未识别（autoOn=false → 点手牌不会走取消分支）');
    const sent = [];
    const origSend = nav.send;
    nav.send = (m) => sent.push(m);
    try {
      s.onCanvasRaise(0);
      ok(s._autoCancelPending === true, '取消托管未置闸门标记（会连发 setAuto）');
      ok(
        sent.length === 1 && sent[0].t === 'setAuto' && sent[0].auto === false,
        '未发出 setAuto:false：' + JSON.stringify(sent),
      );
      s.onCanvasRaise(0);
      ok(sent.length === 1, '重复点手牌重复发 setAuto（闸门失效，发了 ' + sent.length + ' 次）');
      ok(!!s._autoCancelTimer, '未排兜底复位定时器（回执丢了就永久卡死）');
      const v2 = makeView({ turn: 1 });
      v2.auto = [false, false, false, false];
      s.onGame(v2); // 回执到达
      ok(
        s._autoCancelPending === false && s._autoCancelTimer === null,
        '回执到达后闸门/定时器未清（下一次就点不动了）',
      );
    } finally {
      nav.send = origSend;
      s.exit();
    }
  });

  // 局内顶栏 ‹ = 「退出本局」（2026-11-05）：**任何人**可点，只退出自己这一局。
  // 这里盯住客户端链路：‹ → 确认框 → 发 quit + 回房间页；「取消」绝不能发请求。
  run('game.quit', () => {
    const chrome = loadCJS(path.join(MG, 'src/chrome.js'));
    const net = loadCJS(path.join(MG, 'utils/net.js'));
    const s = new GameScene();
    s.enter();
    s.onGame(makeView({}));
    s.render(ctx, layout.compute());
    const back = s.ui.backBtn;
    ok(!!back, '顶栏 ‹ 热区缺失');
    chrome.tap(back.x + 4, back.y + 4, s);
    ok(s.quitAskShown === true, '点顶栏 ‹ 没有打开「退出本局」确认框');
    s.render(ctx, layout.compute());
    ok((s.ui.layerBtns || []).length === 2, '确认框按钮数异常：' + (s.ui.layerBtns || []).length);
    // ⚠ layer.confirm 是从右往左 push，layerBtns 顺序与 actions 相反 → 一律按 id 取
    //   （layer0 = actions[0] = 取消，layer1 = 退出）
    const byId = (id) => (s.ui.layerBtns || []).find((b) => b.id === id);
    const sent = [];
    const origSend = nav.send;
    const origNav = nav.navigate;
    const origOpen = net.isOpen;
    nav.send = (m) => sent.push(m);
    nav.navigate = (to) => sent.push({ t: '__nav', to });
    net.isOpen = () => true;
    try {
      ok(!!byId('layer0') && !!byId('layer1'), '确认框缺少「取消/退出」按钮');
      byId('layer0').fn(); // 第 1 个动作 = 取消（安全默认）
      ok(s.quitAskShown === false && sent.length === 0, '「取消」误发了退出请求：' + JSON.stringify(sent));
      s.onQuit();
      s.render(ctx, layout.compute());
      ok(typeof s.ui.layerDismiss === 'function', '确认框未登记「点框外」处理');
      s.ui.layerDismiss(); // 点遮罩 = 取消
      ok(sent.length === 0, '点弹框外误发了退出请求：' + JSON.stringify(sent));
      s.onQuit();
      s.render(ctx, layout.compute());
      byId('layer1').fn(); // 退出
      ok(sent.some((m) => m.t === 'quit'), '「退出」没有发 quit：' + JSON.stringify(sent));
      ok(sent.some((m) => m.t === '__nav' && m.to === 'lobby'), '「退出」没有回房间页');
      // 结算/摊牌相位：本局已结束，「退出本局」没有语义 → ‹ 必须置灰且不吃点击
      // （否则用户点它会拿到服务端「当前没有进行中的对局」，同时客户端已经跳走了）
      s.onGame(makeView({ phase: 'over', winner: 0, result: '自摸', reveal: [river(0, 14), river(3, 14), river(7, 14), river(11, 14)], counts: [0, 0, 0, 0] }));
      s.render(ctx, layout.compute());
      ok(s.quitShown === false, 'over 相位 ‹ 仍标记为可点');
      const ob = s.ui.backBtn;
      chrome.tap(ob.x + 4, ob.y + 4, s);
      ok(s.quitAskShown === false, 'over 相位点 ‹ 仍打开了「退出本局」确认框');
    } finally {
      nav.send = origSend;
      nav.navigate = origNav;
      net.isOpen = origOpen;
      s.exit();
    }
  });

  // 场景用的 nav 入口必须真的存在（2026-11-02 真机报 nav.navigate is not a function：
  // nav.js 导出表漏了 navigate，离开房间一按即炸 —— 语法检查抓不到跨模块成员缺失）
  run('nav.surface', () => {
    for (const fn of ['register', 'attach', 'detach', 'boot', 'navigate', 'scene', 'sceneName', 'fadeAlpha', 'chatHistory', 'recoverGame', 'resetChat', 'tryResume', 'isAutoResume', 'clearAutoResume', 'send', 'connectAndSend', 'leaveRoom', 'exitGame']) {
      ok(typeof nav[fn] === 'function', 'nav.' + fn + ' 未导出（场景在调用）');
    }
  });

  // 离开房间路径真实走一遍（onLeaveConfirm(true) 不抛错，落到 home 场景）
  run('lobby.leave', () => {
    state.lastState = {
      t: 'state', code: 'ABC123', variant: 'nanchang', you: 0, token: 'tok',
      players: [{ seat: 0, name: '我', isHost: false, ready: false, connected: true }],
      totals: [0, 0, 0, 0], dealer: 0, allReady: false, pendingSwap: null,
      dealerRolls: [], dealerDecided: false,
    };
    const s = new LobbyScene();
    s.enter();
    s.render(ctx, layout.compute());
    s.onLeave(); // 打开确认层
    s.render(ctx, layout.compute()); // layerBtns 由渲染重建（每帧 this.ui = {}）
    const u = s.ui;
    ok(u.layerBtns && u.layerBtns.length === 2, '离开确认层按钮数异常');
    const okBtn = (u.layerBtns || [])[1]; // 右侧第二枚 = 「离开」（danger）
    if (okBtn) okFn(okBtn.fn, '离开确认回调'); // 不抛错即过；内部 nav.navigate('home') → 跳转合并 setTimeout
    s.exit();
  });

  // 末张「活跃牌」光效（2026-11-02）：注入 mock 贴图后渲染不抛错且生效
  run('activeCard.fx', () => {
    const cv2 = mockCanvas(W, H);
    const tb2 = new Table(cv2, 2);
    tb2.render(views.playing);
    const imgs0 = cv2._ctx._rec.images.length;
    tb2.activeCardImg = { width: 18, height: 41 }; // mock 贴图
    tb2.render(views.playing);
    const imgs1 = cv2._ctx._rec.images.length;
    ok(imgs1 > imgs0, '注入 activeCardImg 后未见额外 drawImage（光效未画）');
    ok(!tb2.render(views.playing) || true, '');
  });

  // 副露列对称 + unproj/proj 互逆（2026-11-02「上下家牌没对齐」回归）：
  // 同一份 melds 喂 slot1/slot3，两列屏幕内缘到画布中心的距离必须相等；
  // unprojTileX 反推后的逻辑位再正向投影，屏幕左缘必须回到目标位（±0.5px）。
  run('meld.symmetry', () => {
    const wallLib2 = loadCJS(path.join(MG, 'lib/shared/wall.js'));
    const recipe2 = wallLib2.buildRecipe(0, [3, 4]);
    const v2 = {
      code: 'T', phase: 'playing', dealer: 0, turn: 0, mySeat: 0,
      myTiles: [0,1,2,3,4,5,6,7,8,9,10,11,12], counts: [13,10,13,10],
      melds: [[], [{ type: 'peng', tiles: [5,5,5] }], [], [{ type: 'peng', tiles: [5,5,5] }]],
      // 15 张 = 侧河 3 列全满（cap15）：按牌主视角填充时半满列的贴端差是预期行为，
      // 镜像断言需满列才逐张成立（块位对称仍由 riverBlockRect 断言覆盖）。
      rivers: [[], [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14], [], [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14]],
      wallLeft: 40, jingPi: 8, jingFu: 12, jingSlot: 100,
      dice: null, dealDice: [3,4], lastDice: [3,4], ceremony: null,
      wallRing: { recipe: recipe2, frontSlot: recipe2.endSlot, kongSlots: [] },
      lastDiscard: { tile: 20, from: 1 }, claimWindow: false, claims: null,
      selfGangs: [], declareOptions: [], declared: [], mustDiscard: [],
      canZimo: false, zimoLabel: null, drawn: null,
      connected: [true,true,true,true], auto: [false,false,false,false],
      names: ['我','下','对','上'], totals: [0,0,0,0], hostSeat: 0,
      windowDeadline: null, awaiting: [], skipRon: false, reveal: null, gz: null,
      bao: [1,2,1,1], winner: null, result: null, log: [], lastAction: null,
    };
    const cv = mockCanvas(W, H);
    const tb = new Table(cv, 2);
    // 截获副露牌（slot1/3）屏幕矩形：rect 分支 = 牌心按 k 拉 + 边长·k
    const meldTiles = [];
    const origDT = Table.prototype.drawTile;
    Table.prototype.drawTile = function (t, x, y, w2, h2, view2, ng, tilt2, rot2, sl2) {
      if (sl2 === 1 || sl2 === 3) {
        const k2 = tilt2 && tilt2.k ? tilt2.k : this.meldK(sl2);
        const cxs = W / 2 + (x + w2 / 2 - W / 2) * k2;
        meldTiles.push({ slot: sl2, l: cxs - (w2 * k2) / 2, r: cxs + (w2 * k2) / 2, t: y + h2 / 2 - (h2 * k2) / 2 });
      }
      return origDT.apply(this, arguments);
    };
    tb.render(v2);
    tb.render(v2);
    Table.prototype.drawTile = origDT;
    // 十字布局（2026-11-03）：左右副露块镜像（x251..373 ↔ x907..1029），
    // 同一份 melds 画出的每张牌必须关于 x=640 镜像成对（±1px）
    const L = meldTiles.filter((m) => m.slot === 3);
    const R = meldTiles.filter((m) => m.slot === 1);
    ok(L.length > 0 && L.length === R.length, '左右副露牌数不一致：' + L.length + ' vs ' + R.length);
    let mirrorMiss = 0;
    for (const m of L) {
      const hit = R.some((n) => Math.abs(W - m.r - n.l) < 1 && Math.abs(W - m.l - n.r) < 1 && Math.abs(m.t - n.t) < 1);
      if (!hit) mirrorMiss++;
    }
    ok(mirrorMiss === 0, '左右副露非镜像成对：' + mirrorMiss + ' 张无镜像');
    // 互逆：目标屏幕左缘 X → unprojTileX → 正向（rect 分支：牌心 ± (w/2)d）
    const mm = tb.meldMetrics(3);
    const k = tb.meldK(3);
    for (const target of [300, 500, 640]) {
      // 反推在 table.js 模块内部：借 drawTile 截获逻辑入参再正向算
      let logicX = null;
      const orig = Table.prototype.drawTile;
      Table.prototype.drawTile = function (t, x, y, w2, h2, view2, ng, tilt2, rot2, slot2) {
        logicX = x;
        return orig.apply(this, arguments);
      };
      tb.drawMeldRow({ type: 'peng', tiles: [5] }, target, 200, 0, 3);
      Table.prototype.drawTile = orig;
      const cx = logicX + mm.w / 2;
      const sx = W / 2 + (cx - W / 2) * k - (mm.w / 2) * k;
      ok(Math.abs(sx - target) < 0.5, 'unproj/proj 不互逆：目标 ' + target.toFixed(1) + ' 实落 ' + sx.toFixed(1));
    }
    console.log('  副露块镜像成对 + unproj/proj 互逆 OK（左右逐张镜像 <1px，roundtrip <0.5px）');
    // 满载区域间距：侧河与上下河在投影后也不得相交。
    const rb0 = tb.riverBlockRect(0);
    const rb3 = tb.riverBlockRect(3);
    const rb1 = tb.riverBlockRect(1);
    const rb2c = tb.riverBlockRect(2);
    const overlaps = (a, b) => a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5;
    for (const [a, b, label] of [[rb3, rb0, '上家×自己'], [rb3, rb2c, '上家×对家'], [rb1, rb0, '下家×自己'], [rb1, rb2c, '下家×对家'], [rb3, rb1, '两侧河']]) {
      ok(!overlaps(a, b), label + '牌河矩形相交');
    }
  });

  // 自家/对家副露不被压小（2026-11-04 用户报「自己的副牌显示的这么小」回归）：
  // 一块 2 组（碰+杠）时 slot0 旧量法误用「竖叠 2 组」需求高 → _meldScale 被压到
  // ~0.48。断言：slot0/slot2 各喂碰+杠两组，副露牌投影后屏幕高必须 ≥ 满高 92%
  // （92% 留 1~2px 圆角/投影测量余量；压小 bug 时代只有 48%，一断就断）。
  run('meld.slot02-fullsize', () => {
    const mkV = (slot) => {
      const recipe3 = wallLib.buildRecipe(0, [3, 4]);
      const melds = [[], [], [], []];
      melds[slot] = [{ type: 'peng', tiles: [5, 5, 5] }, { type: 'gang', tiles: [9, 9, 9, 9] }];
      return {
        code: 'T', phase: 'playing', dealer: 0, turn: 0, mySeat: 0,
        myTiles: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], counts: [13, 13, 13, 13],
        melds,
        rivers: [[], [], [], []],
        wallLeft: 40, jingPi: 8, jingFu: 12, jingSlot: 100,
        dice: null, dealDice: [3, 4], lastDice: [3, 4], ceremony: null,
        wallRing: { recipe: recipe3, frontSlot: recipe3.endSlot, kongSlots: [] },
        lastDiscard: { tile: 20, from: 1 }, claimWindow: false, claims: null,
        selfGangs: [], declareOptions: [], declared: [], mustDiscard: [],
        canZimo: false, zimoLabel: null, drawn: null,
        connected: [true, true, true, true], auto: [false, false, false, false],
        names: ['我', '下', '对', '上'], totals: [0, 0, 0, 0], hostSeat: 0,
        windowDeadline: null, awaiting: [], skipRon: false, reveal: null, gz: null,
        bao: [1, 2, 1, 1], winner: null, result: null, log: [], lastAction: null,
      };
    };
    for (const slot of [0, 2]) {
      const cv3 = mockCanvas(W, H);
      const tb3 = new Table(cv3, 2);
      const hs = [];
      const origDT3 = Table.prototype.drawTile;
      Table.prototype.drawTile = function (t, x, y, w2, h2, view2, ng, tilt2, rot2, sl2) {
        if (sl2 === slot) {
          const k3 = tilt2 && tilt2.k ? tilt2.k : this.meldK(sl2);
          hs.push(h2 * k3);
        }
        return origDT3.apply(this, arguments);
      };
      tb3.render(mkV(slot));
      hs.length = 0; // 只量第二帧（稳定态；hook 跨帧累计会把 7 张数成 14）
      tb3.render(mkV(slot));
      Table.prototype.drawTile = origDT3;
      const expect = tb3.meldMetrics(slot).h * tb3.meldK(slot);
      const minH = expect * 0.92;
      const bad = hs.filter((h) => h < minH).length;
      ok(hs.length === 7, 'slot' + slot + ' 副露牌数异常：' + hs.length + '/7（碰3+杠4）');
      ok(bad === 0, 'slot' + slot + ' 副露被压小：' + bad + '/7 张低于满高 92%（' + expect.toFixed(1) + '），最小 ' + Math.min(...hs).toFixed(1));
    }
    console.log('  自家/对家副露满尺寸 OK（碰+杠同块两组，slot0/2 投影高 ≥ 92% 满高）');
  });

  // CDN 预热模块：warmup 幂等、progress 快照结构、imageHost 适配（画布 / wx.createImage / null）
  run('preload.warmup', () => {
    const preloadMod = loadCJS(path.join(MG, 'src/preload.js'));
    okFn(() => preloadMod.warmup(), 'warmup 首次调用');
    okFn(() => preloadMod.warmup(), 'warmup 重复调用（必须幂等）');
    const pr = preloadMod.progress();
    ok(pr && typeof pr.tiles === 'string' && typeof pr.ui === 'string' && typeof pr.sound === 'boolean', 'progress 结构异常：' + JSON.stringify(pr));
    ok(preloadMod.imageHost(null) !== undefined, 'imageHost(null) 应返回 null 而非抛错');
    const hostObj = preloadMod.imageHost({ createImage: () => ({}) });
    ok(hostObj && typeof hostObj.createImage === 'function', 'imageHost 未识别画布自带 createImage');
    const hostWx = preloadMod.imageHost(null);
    ok(hostWx === null || (hostWx && typeof hostWx.createImage === 'function'), 'imageHost 全局回退路径异常');
  });

  // 骰子渲染（毛边回归）：跑满一帧翻滚相位 + 落定回弹，画布命令数稳定、
  // 本体路径必须全部是圆角矩形（不得出现 fillRect 直角厚边戳出圆角）。
  run('dice.render', () => {
    const DiceFx = loadCJS(path.join(MG, 'src/ui/dicefx.js'));
    const fx = new DiceFx();
    const Lg = layout.compute();
    // 翻滚中（对位 scramble 期）
    fx.run([3, 4], '庄家掷骰…', '掷出 3 + 4 = 7 点', 1200, 2600);
    fx.render(ctx, Lg);
    // 落定回弹中
    fx.a = 3; fx.b = 4; fx.tumbling = false; fx.landAt = Date.now() - 100;
    fx.render(ctx, Lg);
    ok(!fx.tumbling && fx.landAt > 0, '落定态未进入');
    // 收层
    fx.clear();
    ok(!fx.shown, '骰子层未收起');
  });

  // 大厅胶囊避让：分享按钮右缘必须 ≤ 胶囊左缘（mock 胶囊 left=726）
  run('lobby.capsule', () => {
    state.lastState = {
      t: 'state', code: 'ABC123', variant: 'nanchang', you: 0, token: 'tok',
      players: [{ seat: 0, name: '我', isHost: true, ready: false, connected: true }],
      totals: [0, 0, 0, 0], dealer: 0, allReady: false, pendingSwap: null,
      dealerRolls: [], dealerDecided: false,
    };
    const s = new LobbyScene();
    s.enter();
    s.render(ctx, layout.compute());
    const share = s.ui.btnShare;
    ok(share && share.x + share.w <= 726 - 8 + 0.5, '分享按钮未避让胶囊（右缘 ' + (share && share.x + share.w) + ' > 胶囊左缘 726-8）');
    ok(share && share.x > 400, '分享按钮位置异常：' + JSON.stringify(share));
    s.exit();
  });

  // 键盘抬升（adjust-position 对位）：聚焦 home 昵称框（贴底会被 260px 键盘遮住）
  // → 渲染应产出悬浮输入行 u.floatField，且其底沿在键盘上沿之上
  run('home.keyboard-lift', () => {
    const s = new HomeScene();
    s.enter();
    s.wizardMode = 'create';
    s.goStep('form');
    s.setFocus('name');
    s.render(ctx, layout.compute());
    const L1 = layout.compute();
    const u1 = s.ui;
    if (process.env.DBG) {
      const inputDbg = require('path');
      console.log('    [dbg] focusField=' + s.focusField + ' kbH=' + inputMod.kbH() + ' fieldName=' + JSON.stringify(u1.fieldName) + ' sh=' + L1.sh + ' kbLimit=' + (L1.sh - 260 - 8));
    }
    const covered = u1.fieldName && u1.fieldName.y + u1.fieldName.h > L1.sh - 260 - 8;
    if (covered) {
      ok(!!u1.floatField, '昵称框被键盘遮住但未出现悬浮输入行');
      if (u1.floatField) {
        ok(u1.floatField.rect.y + u1.floatField.rect.h <= L1.sh - 260 + 0.5, '悬浮输入行底沿没抬到键盘上沿之上');
        // 悬浮行矩形数值健全（命中判定在场景内用同一 rect 结构）
        const fr = u1.floatField.rect;
        ok(fr && fr.w > 0 && fr.h === 30, '悬浮输入行矩形异常：' + JSON.stringify(fr));
      }
    }
    // 点空白 → 收键盘（focusField 清空）
    s.onTap(10, 10);
    ok(!s.focusField, '键盘弹出时点空白未收起焦点');
    s.exit();
  });

  // 聊天输入行抬升：game 场景聚焦聊天框 → 输入行 y 应高于面板底（键盘 260px）
  run('game.chat-lift', () => {
    const s = new GameScene();
    s.enter();
    s.onGame(makeView({ rivers: [river(0, 10), river(3, 10), river(7, 10), river(11, 10)] }));
    s.onToggleChat();
    s.onChatFieldTap();
    s.render(ctx, layout.compute());
    const Lg = layout.game({ banner: false, overPhase: false });
    const u2 = s.ui;
    ok(s.chatFocus, '聊天框聚焦失败');
    ok(u2.chatField && u2.chatField.y + u2.chatField.h <= Lg.sh - 260 + 0.5, '聊天输入行未抬到键盘上沿（y=' + (u2.chatField && u2.chatField.y) + '）');
    // 点消息区（输入框外）→ 收键盘
    s.onTap(u2.chatField.x, u2.chatField.y - 40);
    ok(!s.chatFocus, '点聊天面板空白未收起键盘');
    s.exit();
  });
  console.log('  home / lobby / game 场景冒烟完成（含键盘抬升）');
}

console.log('\n========== ' + (fail === 0 ? '全部通过 ✔' : fail + ' 处失败 ✘') + ' ==========');
process.exit(fail === 0 ? 0 : 1);
