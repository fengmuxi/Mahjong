/**
 * 透视布局几何校验（Node，无浏览器）：
 *   mock 2D 上下文 + wx.createOffscreenCanvas → 让 table.js 的离屏/切片管线真实跑起来；
 *   合成 GameView（ nanchang / gz / 结算 / 发牌仪式 四种）→ render → 截获每次
 *   drawTile 的 (x,y,w,h,tilt)，用 projQuad 复本算精确四边形，与录制到的切片
 *   drawImage 并集互相印证，再做 SAT 四边形相交检查（牌河×铭牌/牌墙/副露/信息盘、
 *   副露×信息盘、手牌摞×各方、出界检查）。
 */
const path = require('path');
const MP = path.resolve(__dirname, '../../packages/minigame/game');

// ---------- mock canvas / ctx ----------
function mockCtx(canvas) {
  const rec = { images: [], texts: [] };
  const base = {
    canvas,
    _rec: rec,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1,
    shadowColor: 'rgba(0,0,0,0)', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0,
    font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    globalAlpha: 1, globalCompositeOperation: 'source-over', lineCap: 'butt', lineJoin: 'miter', miterLimit: 10,
    measureText(t) { return { width: String(t).length * 9 }; },
    createLinearGradient() { return { addColorStop() {} }; },
    createRadialGradient() { return { addColorStop() {} }; },
    createPattern() { return null; },
    setTransform() {}, transform() {}, resetTransform() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, arc() {}, ellipse() {}, rect() {}, closePath() {},
    fill() {}, stroke() {}, clip() {}, isPointInPath() { return false; },
    fillRect() {}, strokeRect() {}, clearRect() {},
    drawImage(...a) { rec.images.push(a); },
    fillText(t, x, y) { rec.texts.push({ t, x, y }); },
    strokeText() {},
    getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }; },
    putImageData() {}, createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }; },
  };
  return base;
}
function mockCanvas(w, h) {
  const c = { width: w, height: h, _ctx: null, style: {} };
  c.getContext = () => (c._ctx = c._ctx || mockCtx(c));
  return c;
}
/**
 * mock 离屏画布：**必须对象签名** `{type:'2d', width, height}`。
 * 传位置参数（旧写法）时真机拿到的是旧版 canvas、`getContext('2d')` 直接失效
 * （2026-10-20 Windows 微信白屏事故的根因）——这里直接抛错，防止回归。
 */
global.wx = {
  createOffscreenCanvas: (o) => {
    if (!o || typeof o !== 'object' || o.type !== '2d') {
      throw new Error('createOffscreenCanvas 必须用对象签名 {type:"2d",width,height}');
    }
    return mockCanvas(o.width || 300, o.height || 150);
  },
};
global.document = { createElement: (tag) => mockCanvas(300, 150) };

// ---------- 载入 table.js（根 package.json 是 type:module → .js 走 ESM；
// 用 vm + CJS 包装加载，自定义 require 递归解析 minigame 内相对路径） ----------
const fs = require('fs');
const vm = require('vm');
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
const { Table, W, H } = loadCJS(path.join(MP, 'utils/table.js'));

// ---------- projQuad 复本（与 table.js 同公式；用录制数据交叉印证） ----------
// 直接从 table.js 读 PROJ 常量，避免手动同步漂移（2026-10-21）
const _projSrc = fs.readFileSync(path.join(MP, 'utils/table.js'), 'utf8').match(/const PROJ = \{[^}]*base: ([0-9.]+), span: ([0-9.]+)/);
const PROJ_BASE = _projSrc ? Number(_projSrc[1]) : 0.72, PROJ_SPAN = _projSrc ? Number(_projSrc[2]) : 0.28;
function projD(y) { return PROJ_BASE + PROJ_SPAN * (y / H); }
function tiltBox(x, y, w, h, z) {
  const dz = z && z.dz ? z.dz : 1;
  const bw = w * dz, bh = h * dz;
  return { x: x + (w - bw) / 2, y: y + (h - bh), w: bw, h: bh };
}
function replicaQuad(x, y, w, h, z) {
  const b = tiltBox(x, y, w, h, z);
  const sq = z && z.sq ? z.sq : 1;
  const ts = z && z.ts ? z.ts : 1;
  const zw = z && z.zw ? z.zw : 1;
  const cx = b.x + b.w / 2;
  const topY = b.y + b.h * (1 - sq);
  const inset = b.w * (1 - ts) / 2;
  let pts = [
    { x: cx + (b.x + inset - cx) * zw, y: topY },
    { x: cx + (b.x + b.w - inset - cx) * zw, y: topY },
    { x: cx + (b.x + b.w - cx) * zw, y: b.y + b.h },
    { x: cx + (b.x - cx) * zw, y: b.y + b.h },
  ];
  if (z && z.proj === false) return pts;
  // 2026-10-21 rect 模式（牌张专用）：牌心单点透视 + 等比缩放 → 纯矩形
  if (z && z.proj !== false) {
    // 牌河块传了统一投影比 z.k（2026-10-22，整块当刚体缩）→ 必须跟着用，
    // 否则复本与真实切片对不上（逐张 d 与块常数 d 差 1~3px）
    const d = z.k || projD(y + h / 2);
    const ox = x + w / 2;
    const oy = y + h / 2;
    const cxs = W / 2 + (ox - W / 2) * d;
    return pts.map((p) => ({ x: cxs + (p.x - ox) * d, y: oy + (p.y - oy) * d }));
  }
  return pts.map((p) => ({ x: W / 2 + (p.x - W / 2) * projD(p.y), y: p.y }));
}

// ---------- SAT 四边形相交 ----------
// tol = 分离容差：跨类检查用 0.5px（真缺陷）；牌河自检用 1.5px（zw 补偿后牌宽
// 49.2 > 螺距 48，相邻牌底边有 ≤0.8px 贴合 —— 紧排是设计意图，不是重叠）。
function quadSAT(a, b, tol) {
  const eps = tol || 0.5;
  const polys = [a, b];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const p1 = poly[i], p2 = poly[(i + 1) % poly.length];
      const nx = -(p2.y - p1.y), ny = p2.x - p1.x;
      const len = Math.hypot(nx, ny) || 1;
      const ax = nx / len, ay = ny / len;
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const p of a) { const d = p.x * ax + p.y * ay; if (d < aMin) aMin = d; if (d > aMax) aMax = d; }
      for (const p of b) { const d = p.x * ax + p.y * ay; if (d < bMin) bMin = d; if (d > bMax) bMax = d; }
      if (aMax <= bMin + eps || bMax <= aMin + eps) return false;
    }
  }
  return true;
}
function quadBounds(q) {
  const xs = q.map((p) => p.x), ys = q.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

/** 按朝向算复本四边形（2026-10-20 转向后：侧边的真实占位是转过的） */
function quadOf(t) {
  // 2026-10-20：朝向做在贴图里（rotFace），几何占位不变 → 复本四边形不再旋转
  const q = replicaQuad(t.x, t.y, t.w, t.h, t.tilt);
  q.t = t; // 供相交报告打印逻辑坐标
  return q;
}

// ---------- 截获 drawTile ----------
const tiles = []; // { cls, x,y,w,h, tilt, slices: [rects] }
let curCls = 'none';
let curTile = null;
/**
 * 牌河要能分家（2026-10-22）：同家内部**相邻行叠压**是设计意图（table.js 的
 * RIVER_LAP_*），只有**跨家**相擦才是缺陷。`riverPos(seat,i)` 在每个
 * `drawTile` 之前紧邻调用，借它把座位号带进类别名。
 */
const _origRiverPos = Table.prototype.riverPos;
Table.prototype.riverPos = function (seat) {
  this.__riverSeat = seat;
  return _origRiverPos.apply(this, arguments);
};
const origDrawTile = Table.prototype.drawTile;
Table.prototype.drawTile = function (t, x, y, w, h, view, noGlow, tilt, rot) {
  const before = this.ctx._rec.images.length;
  const cls = curCls === 'drawRivers' && this.__riverSeat != null ? 'drawRivers#s' + this.__riverSeat : curCls;
  curTile = { cls, t, x, y, w, h, tilt, rot: rot || 0, slices: [] };
  tiles.push(curTile);
  const r = origDrawTile.apply(this, arguments);
  for (let i = before; i < this.ctx._rec.images.length; i++) {
    const a = this.ctx._rec.images[i];
    if (a.length >= 9) curTile.slices.push({ x: a[5], y: a[6], w: a[7], h: a[8] });
  }
  curTile = null;
  return r;
};
const wrap = (name, cls) => {
  const orig = Table.prototype[name];
  Table.prototype[name] = function (...a) { const prev = curCls; curCls = cls; try { return orig.apply(this, a); } finally { curCls = prev; } };
};
['drawRivers', 'drawHandStacks', 'drawCenter', 'drawJingHighlight'].forEach((n) => wrap(n, n));
// drawMelds(melds, slot) / drawRevealHand(view, seat)：把槽位编进类别名，跨槽相擦才看得清
const _origDrawMelds = Table.prototype.drawMelds;
Table.prototype.drawMelds = function (melds, slot) {
  if (process.env.DBG) console.log('    [meld] slot=' + slot + ' n=' + (melds || []).map((m) => m.tiles.length).join('/'));
  const prev = curCls; curCls = 'meld#s' + slot;
  try { return _origDrawMelds.apply(this, arguments); } finally { curCls = prev; }
};
wrap('drawRevealHand', 'reveal');
const _origDrawReveal = Table.prototype.drawRevealHand;
Table.prototype.drawRevealHand = function (view, seat) {
  const prev = curCls; curCls = 'reveal#s' + this.disp(view, seat);
  try { return _origDrawReveal.apply(this, arguments); } finally { curCls = prev; }
};
['drawWall', 'paintWall', 'renderWallCache'].forEach((n) => wrap(n, 'wall'));

// ---------- 合成 GameView ----------
const wallLib = loadCJS(path.join(MP, "lib/shared/wall.js"));
function makeView(opts) {
  const recipe = wallLib.buildRecipe(opts.dealer, [3, 4]);
  const v = {
    code: 'TEST', phase: opts.phase || 'playing', dealer: opts.dealer, turn: opts.turn, mySeat: 0,
    myTiles: opts.myTiles || [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    counts: opts.counts || [13, 13, 13, 13],
    melds: opts.melds || [[], [], [], []],
    rivers: opts.rivers || [[], [], [], []],
    wallLeft: 60,
    jingPi: opts.jingPi === undefined ? 8 : opts.jingPi,
    jingFu: opts.jingFu === undefined ? 12 : opts.jingFu,
    jingSlot: opts.jingSlot === undefined ? 100 : opts.jingSlot,
    dice: null, dealDice: [3, 4], lastDice: [3, 4],
    ceremony: opts.ceremony || null,
    wallRing: { recipe, frontSlot: recipe.endSlot, kongSlots: [] },
    lastDiscard: opts.lastDiscard === undefined ? { tile: 20, from: 1 } : opts.lastDiscard,
    claimWindow: false, claims: null, selfGangs: [], declareOptions: [], declared: opts.declared || [],
    mustDiscard: [], canZimo: false, zimoLabel: null, drawn: null,
    connected: [true, true, true, true], auto: [false, false, false, false],
    names: ['我', '下家', '对家', '上家'], totals: [0, 12, -4, -8], hostSeat: 0,
    windowDeadline: null, awaiting: [], skipRon: false,
    reveal: opts.reveal || null,
    gz: opts.gz || null,
    bao: [1, 2, 1, 1],
    winner: opts.winner === undefined ? null : opts.winner,
    result: opts.result || null,
    log: [], lastAction: null,
  };
  return v;
}
// 牌河：制造「接近满载」的场景（验证容量与出界）
function river(start, n) { const a = []; for (let i = 0; i < n; i++) a.push((start + i) % 34); return a; }

const views = {
  nanchang_playing: makeView({
    rivers: [river(0, 22), river(3, 24), river(7, 22), river(11, 24)],
    // 几何压力样本：四家各 4 组副露，和四家满容量牌河同时存在。
    melds: [0, 1, 2, 3].map(() => [
      { type: 'peng', tiles: [5, 5, 5] },
      { type: 'gang', tiles: [9, 9, 9, 9] },
      { type: 'chi', tiles: [12, 13, 14] },
      { type: 'chi', tiles: [12, 13, 14] },
    ]),
    counts: [10, 9, 11, 12],
  }),
  gz_playing: makeView({
    gz: { zheng: [8], fu: [12], revealed: false },
    jingPi: 8, jingFu: 12, jingSlot: 100,
    rivers: [river(1, 10), river(4, 9), river(6, 12), river(9, 8)],
    melds: [[{ type: 'angang', tiles: [16, 16, 16, 16] }], [], [], [{ type: 'bugang', tiles: [20, 20, 20, 20] }]],
    declared: [{ seat: 2, tile: 21 }],
    counts: [13, 13, 13, 13],
  }),
  deal_ceremony: makeView({
    ceremony: { kind: 'deal', state: 'wait-roll', seat: 0, dice: null, rollAt: null, until: null },
    counts: [4, 4, 4, 4],
  }),
  over_win: makeView({
    phase: 'over', winner: 1, result: '炮胡 · 对对胡',
    reveal: [river(0, 14), river(3, 14), river(7, 14), river(11, 14)],
    // 接近真机结算局（2026-10-21 截图）：左右两家各 4 组副露（侧列排满两列），
    // 底边也 4 组（横排折两行），牌河接近满载（18~22 张，压 cap）
    rivers: [river(0, 22), river(3, 24), river(7, 22), river(11, 24)],
    // 最大摊牌压力：四家各 4 组（每家实际最多 4 组），并同时展示 14 张结算手牌。
    melds: [0, 1, 2, 3].map(() => [
      { type: 'peng', tiles: [5, 5, 5] },
      { type: 'gang', tiles: [9, 9, 9, 9] },
      { type: 'chi', tiles: [12, 13, 14] },
      { type: 'chi', tiles: [12, 13, 14] },
    ]),
    counts: [0, 0, 0, 0],
    lastDiscard: { tile: 20, from: 0 },
  }),
};

// ---------- 跑 ----------
let fail = 0;
const ok = (cond, msg) => { if (!cond) { fail++; console.log('  ✘ ' + msg); } };
const near = (a, b, eps, msg) => ok(Math.abs(a - b) <= eps, `${msg}（${a.toFixed(1)} vs ${b.toFixed(1)}）`);

/**
 * 单帧快照的全套检查。
 * 为什么拆两个快照：**墙走 `_wallCache` 离屏预合成** —— 第一帧 render 建缓存
 * （drawTile 全被截获、cls='wall'），第二帧只剩一次 blit、零 drawTile。
 * 只查第二帧的话所有「×牌墙」pairs 一直在空跑（2026-10-20 引入墙缓存后留下的盲区，
 * 2026-10-21 墙加密加宽时发现并修复 —— 墙是这轮改动最大的对象，必须真验）。
 * 两帧都不产生 ghost（第一帧 prevRemoved=null；第二帧 removed 不变）→ 快照可直接比。
 */
function checkSnapshot(label, tiles, table, canvas, withBlit) {
  console.log(`\n--- ${label}（${tiles.length} 个 drawTile）---`);

  // 1) 复本四边形 vs 录制切片并集（互相印证，误差 < 1.5px）
  let checked = 0;
  for (const t of tiles) {
    if (!t.slices.length) continue;
    const q = replicaQuad(t.x, t.y, t.w, t.h, t.tilt);
    const b = quadBounds(q);
    const u = t.slices.reduce((acc, r) => ({
      x0: Math.min(acc.x0, r.x), x1: Math.max(acc.x1, r.x + r.w),
      y0: Math.min(acc.y0, r.y), y1: Math.max(acc.y1, r.y + r.h),
    }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity });
    near(b.x0, u.x0, 1.6, `#${checked} ${t.cls} 左缘`);
    near(b.x1, u.x1, 1.6, `#${checked} ${t.cls} 右缘`);
    near(b.y0, u.y0, 1.6, `#${checked} ${t.cls} 上缘`);
    near(b.y1, u.y1, 1.6, `#${checked} ${t.cls} 下缘`);
    checked++;
  }
  console.log(`  复本印证 ${checked} 张`);

  // 2) 出界检查（投影后任何牌不得出了画布；容许 3px 模糊外扩）
  for (const t of tiles) {
    if (!t.slices.length) continue;
    const b = quadBounds(replicaQuad(t.x, t.y, t.w, t.h, t.tilt));
    ok(b.x0 >= -3 && b.x1 <= W + 3 && b.y0 >= -3 && b.y1 <= H + 3,
      `出界 ${t.cls} tile=${t.t}@(${t.x},${t.y},${t.w}×${t.h}) → [${b.x0.toFixed(0)},${b.y0.toFixed(0)},${b.x1.toFixed(0)},${b.y1.toFixed(0)}]`);
  }

  // 2b) 朝向检查（2026-10-20 按座位旋转）：有 rot 的牌绕自身中心转完仍不得出画布
  for (const t of tiles) {
    if (!t.slices.length || !t.rot) continue;
    const q = replicaQuad(t.x, t.y, t.w, t.h, t.tilt);
    const cx = (Math.min(q[0].x, q[3].x) + Math.max(q[1].x, q[2].x)) / 2;
    const cy = (q[0].y + q[3].y) / 2;
    const sn = Math.sin(t.rot), cs = Math.cos(t.rot);
    const rq = q.map((p) => ({ x: cx + (p.x - cx) * cs - (p.y - cy) * sn, y: cy + (p.x - cx) * sn + (p.y - cy) * cs }));
    const b = quadBounds(rq);
    ok(b.x0 >= -3 && b.x1 <= W + 3 && b.y0 >= -3 && b.y1 <= H + 3,
      `转向出界 ${t.cls} rot=${(t.rot * 180 / Math.PI).toFixed(0)}° → [${b.x0.toFixed(0)},${b.y0.toFixed(0)},${b.x1.toFixed(0)},${b.y1.toFixed(0)}]`);
  }

  // 3) SAT 跨类相交
  const groups = {};
  for (const t of tiles) {
    if (!t.slices.length) continue;
    (groups[t.cls] = groups[t.cls] || []).push(quadOf(t));
  }
  console.log('  groups: ' + Object.entries(groups).map(([k, v]) => `${k}=${v.length}`).join(' '));
  // HUD 逻辑矩形（= 屏幕位置，不投影）
  const hud = {
    tags: (table.tagRects || []).filter(Boolean).map((r) => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }]),
    disk: [[{ x: 540, y: 230 }, { x: 740, y: 230 }, { x: 740, y: 318 }, { x: 540, y: 318 }]],
    actionBar: table.view && table.view.phase !== 'over'
      ? [[{ x: 465, y: 444 }, { x: 1025, y: 444 }, { x: 1025, y: 506 }, { x: 465, y: 506 }]]
      : [],
  };
  const pairs = [
    ['drawRivers', 'tags', '牌河×铭牌'],
    ['drawRivers', 'disk', '牌河×信息盘'],
    ['drawRivers', 'actionBar', '牌河×操作栏'],
    ['drawRivers', 'wall', '牌河×牌墙'],
    ['meld', 'actionBar', '副露×操作栏'],
    ['drawHandStacks', 'actionBar', '手牌摞×操作栏'],
    ['tags', 'actionBar', '铭牌×操作栏'],
    ['drawRivers', 'meld', '牌河×副露'],
    // 副露跨槽：底边副露（y430）可能与侧边副露列（排到 548）在角落相擦
    ['meld', 'meld', '副露×副露(跨槽)'],
    ['drawRivers', 'drawHandStacks', '牌河×手牌摞'],
    ['meld', 'disk', '副露×信息盘'],
    ['meld', 'wall', '副露×牌墙'],
    ['drawHandStacks', 'tags', '手牌摞×铭牌'], ['drawHandStacks', 'wall', '手牌摞×牌墙'],
    ['drawHandStacks', 'disk', '手牌摞×信息盘'], ['drawHandStacks', 'meld', '手牌摞×副露'],
    ['wall', 'tags', '牌墙×铭牌'], ['wall', 'disk', '牌墙×信息盘'],
    // 摊牌（over 相位）：结算沿用局内牌河/副露，只额外倒下手牌
    ['reveal', 'drawRivers', '摊牌×牌河'],
    ['reveal', 'meld', '摊牌×副露'],
    ['reveal', 'disk', '摊牌×信息盘'],
    ['reveal', 'wall', '摊牌×牌墙'],
    // 牌河自检：同家「相邻行叠压」是设计（见 RIVER_LAP_*），只查**跨家**相擦；
    // 同家的叠压比例另有一条正向断言（revealLap），见下方 4)
    ['drawRivers', 'drawRivers', '牌河×牌河(跨家)', Number(process.env.STOL || 1.5)],
    // 注：中心立精本就应在盘内（包含而非不相交）——由下方单独检查，不进 pairs
  ];
  let hits = 0;
  // 类别名解析：meld/reveal 等带 #sN 槽位后缀 —— 按前缀聚合，槽位内/跨槽都能查
  const resolve = (name) => hud[name] || Object.entries(groups)
    .filter(([k]) => k === name || k.startsWith(name + '#'))
    .flatMap(([, v]) => v);
  for (const [ca, cb, label, tol] of pairs) {
    const A = resolve(ca);
    const B = resolve(cb);
    let n = 0;
    for (const qa of A) for (const qb of B) {
      if (qa === qb) continue;
      // 同一条牌河内部：相邻行故意叠压 → 不算相交（跨家/跨类仍严格）
      if (ca === cb && qa.t && qb.t && qa.t.cls === qb.t.cls) continue;
      if (quadSAT(qa, qb, tol)) {
        n++;
        if (label !== '中心立精×信息盘内') {
          const ba = quadBounds(qa), bb = quadBounds(qb);
          const ta = qa.t, tb = qb.t;
          const id = (q) => q ? `${q.cls}@(${q.x},${q.y},${q.w}×${q.h})` : 'HUD';
          console.log(`    · [${ba.x0.toFixed(0)},${ba.y0.toFixed(0)} ~ ${ba.x1.toFixed(0)},${ba.y1.toFixed(0)}] ${id(ta)} × [${bb.x0.toFixed(0)},${bb.y0.toFixed(0)} ~ ${bb.x1.toFixed(0)},${bb.y1.toFixed(0)}] ${id(tb)}`);
        }
      }
    }
    // 2026-10-20：原实现只打印不计数 —— pairs 相交从来没让本轮失败（假绿）。
    if (n > 0) { hits += n; ok(false, `${label} 相交 ${n} 对`); }
  }
  // 中心立精必须完整落在盘内（不是相交而是包含）
  const centerTiles = groups.drawCenter || [];
  for (const q of centerTiles) {
    const b = quadBounds(q);
    ok(b.x0 >= 540 - 1 && b.x1 <= 740 + 1 && b.y0 >= 230 - 1 && b.y1 <= 318 + 1,
      `中心立精出盘 [${b.x0.toFixed(0)},${b.y0.toFixed(0)},${b.x1.toFixed(0)},${b.y1.toFixed(0)}]`);
  }
  console.log(`  跨类相交检查完成（${hits} 处未过）`);
  /*
   * 4) 牌河同列相邻两排必须完整显示、不互相遮挡。
   * 使用屏幕中心 x 匹配，容许反投影造成的逻辑坐标微差。
   */
  for (const [name, group] of Object.entries(groups)) {
    if (!name.startsWith('drawRivers#')) continue;
    let checked2 = 0;
    const kOf = (t) => (t.tilt && t.tilt.k) || PROJ_BASE + PROJ_SPAN * ((t.y + t.h / 2) / H);
    const scx = (t) => W / 2 + (t.x + t.w / 2 - W / 2) * kOf(t);
    for (let i = 1; i < group.length; i++) {
      const cur = group[i].t;
      if (!cur) continue;
      let prev = null;
      for (let j = i - 1; j >= 0; j--) {
        const p = group[j].t;
        if (p && Math.abs(scx(p) - scx(cur)) < 1.5 && Math.abs(p.y - cur.y) > 1) { prev = p; break; }
      }
      if (!prev) continue;
      const ratio = Math.abs(cur.y - prev.y) / (prev.h * kOf(prev));
      checked2++;
      // 行距下限：拦「行坍缩」（相邻两排几乎完全重叠）。2026-11-04 十轮定稿把行距
      // 改为「盖住贴图立体条 28~32%」——上下河 38/56=0.679、侧河 31/44=0.705
      // （见 minigame table.js RIVER_V_DY / 侧河 dy=RIVER_W−13 的注释），因此
      // 阈值从早期版本的 0.80 下调到 0.62：设计值全部落在窗内，行坍缩（≪0.62）仍会被拦。
      ok(ratio >= 0.62, `${name} 相邻两排遮挡（露出比例 ${ratio.toFixed(3)}）`);
    }
    // 单行牌河没有纵向相邻对。2026-11-03 十字布局起同排相邻牌**设计内小幅叠压**
    // （列距 39/48 < 牌边 44/58，用户「牌压着牌」定稿），逐对不相交断言随之作废；
    // 出界（检查 2）与跨类 SAT（检查 3）仍全覆盖。
  }
  // 4) 墙缓存确实生效（仅第二帧：主画布应收到整屏 blit）
  if (withBlit && (groups.wall || []).length > 0) {
    const blit = canvas._ctx._rec.images.filter((a) => a.length === 5 && a[3] === W && a[4] === H);
    ok(blit.length >= 1, `墙缓存 blit 缺失（${blit.length} 次）`);
  }
}

for (const [name, view] of Object.entries(views)) {
  tiles.length = 0;
  const canvas = mockCanvas(W, H);
  const table = new Table(canvas, 2);
  table.render(view); // 第一帧：建墙缓存 + prevRemoved（无 ghost）
  const first = tiles.slice();
  tiles.length = 0;
  table.render(view); // 第二帧：墙 = blit，无新增 drawTile
  console.log(`\n=== ${name} ===`);
  checkSnapshot('第一帧（建墙缓存）', first, table, canvas, false);
  checkSnapshot('第二帧（稳态 + 墙 blit）', tiles, table, canvas, true);
}


// ---------- 降级路径（PC 微信：离屏画布不可用 → 投影包围盒近似） ----------
Table._canvasOff = true;
tiles.length = 0;
{
  const canvas = mockCanvas(W, H);
  const table = new Table(canvas, 2);
  let threw = null;
  try {
    table.render(views.nanchang_playing);
    table.render(views.nanchang_playing);
  } catch (e) {
    threw = e;
  }
  ok(!threw, '降级路径 render 抛错：' + (threw && threw.message));
  const drew = tiles.filter((t) => t.slices.length === 0).length;
  const sliced = tiles.filter((t) => t.slices.length > 0).length;
  ok(drew > 50, '降级路径牌张数异常（无切片牌 ' + drew + ' 张）');
  ok(sliced === 0, '降级路径不应再有切片 drawImage（' + sliced + ' 张）');
  // 降级后仍必须落在画布内：包围盒由 projQuad 算，出界即坐标算错
  for (const t of tiles) {
    // drawJingHighlight 在 translate/rotate 后的局部坐标系里画牌（x,y 相对牌心），
    // 不能直接当画布坐标量 —— 与主检查里「跳过无切片牌」同一口径
    if (t.cls === 'hud' || t.cls === 'drawJingHighlight') continue;
    const q = replicaQuad(t.x, t.y, t.w, t.h, t.tilt);
    const b = quadBounds(q);
    ok(b.x0 >= -3 && b.x1 <= W + 3 && b.y0 >= -3 && b.y1 <= H + 3, '降级路径出界 ' + t.cls + ' tile=' + t.t);
  }
  console.log('降级路径检查完成（' + drew + ' 张包围盒牌 / 0 切片）');
}
Table._canvasOff = false;

console.log(`\n========== ${fail === 0 ? '全部通过 ✔' : fail + ' 处失败 ✘'} ==========`);
process.exit(fail === 0 ? 0 : 1);
