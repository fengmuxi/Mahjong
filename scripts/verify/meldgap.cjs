/**
 * 副露间距探针（Node，无浏览器）：直接调 `drawMelds`，把每张牌的
 * (x, y, w, h, slot) 与投影后的屏幕矩形打出来 —— 用来量「牌与牌之间的缝」。
 * 判据：相邻两张的屏幕缝 = 步距 − 边长·d，设计值 = 2·d ≈ 1.6px（贴紧但不叠压）。
 */
const path = require('path');
const MP = path.resolve(__dirname, '../../packages/miniapp/miniprogram');
const fs = require('fs');
const vm = require('vm');

function mockCtx(canvas) {
  const rec = { images: [] };
  const base = {
    canvas, _rec: rec,
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
    fillText() {}, strokeText() {}, getImageData(x, y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }; },
    putImageData() {}, createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(Math.max(4, w * h * 4)) }; },
  };
  return base;
}
function mockCanvas(w, h) { const c = { width: w, height: h, _ctx: null, style: {} }; c.getContext = () => (c._ctx = c._ctx || mockCtx(c)); return c; }
global.wx = { createOffscreenCanvas: (o) => (o && o.type === '2d' ? mockCanvas(o.width || 300, o.height || 150) : (() => { throw new Error('bad sig'); })()) };
global.document = { createElement: () => mockCanvas(300, 150) };

const cache = {};
function loadCJS(file) {
  if (cache[file]) return cache[file].exports;
  const src = fs.readFileSync(file, 'utf8');
  const m = { exports: {} };
  cache[file] = m;
  const req = (id) => {
    if (id.startsWith('.')) { let p = path.resolve(path.dirname(file), id); if (!p.endsWith('.js')) p += '.js'; return loadCJS(p); }
    return require(id);
  };
  vm.runInThisContext(`(function(exports, require, module, __filename, __dirname){${src}\n})`, { filename: file })(m.exports, req, m, file, path.dirname(file));
  return m.exports;
}
const { Table, W, H } = loadCJS(path.join(MP, 'utils/table.js'));

const RE = fs.readFileSync(path.join(MP, 'utils/table.js'), 'utf8').match(/const PROJ = \{[^}]*base: ([0-9.]+), span: ([0-9.]+)/);
const BASE = Number(RE[1]), SPAN = Number(RE[2]);
const d = (y) => BASE + SPAN * (y / H);

function run(label, melds, slot, over) {
  const t = new Table(mockCanvas(W, H), 2);
  t.overPhase = !!over;
  t.view = { mySeat: 0, dealer: 0, melds, declared: [], names: ['我', '下', '对', '上'], totals: [0, 0, 0, 0] };
  const recs = [];
  const orig = t.drawTile.bind(t);
  t.drawTile = (tile, x, y, w, h, v, noGlow, tilt, rot, sl) => {
    recs.push({ tile, x, y, w, h, slot: sl, backKey: tilt && tilt.backKey });
    return orig(tile, x, y, w, h, v, noGlow, tilt, rot, sl);
  };
  t.drawMelds(melds, slot);
  const mm = t.meldMetrics(slot);
  console.log(`\n== ${label} (slot ${slot}${over ? ', overPhase' : ''}) mm=${JSON.stringify(mm)}`);
  // 屏幕矩形：rect 分支 = 牌心按 d 拉 + 边长·d
  // 副露整列走统一投影比 meldK（2026-10-22）→ 屏幕矩形也按它算，否则量出来的
  // 「边缘不齐」是探针自己的错（真实渲染用的是 k）
  const scr = recs.map((r) => {
    const k = recs.length && !mm.vertical ? t.meldK(slot) : t.meldK(slot);
    const cxs = W / 2 + (r.x + r.w / 2 - W / 2) * k;
    return { ...r, k, l: cxs - (r.w * k) / 2, r: cxs + (r.w * k) / 2, t: r.y + r.h / 2 - (r.h * k) / 2, b: r.y + r.h / 2 + (r.h * k) / 2 };
  });
  scr.forEach((s, i) => {
    const prev = scr[i - 1];
    const gapX = prev ? +(s.l - prev.r).toFixed(2) : null;
    const gapY = prev ? +(s.t - prev.b).toFixed(2) : null;
    console.log(`  #${i} tile=${s.tile} back=${s.backKey || '-'} xy=(${s.x.toFixed(2)},${s.y}) d=${s.k.toFixed(3)} screen L=${s.l.toFixed(1)} R=${s.r.toFixed(1)} T=${s.t.toFixed(1)} B=${s.b.toFixed(1)}  gap=${mm.vertical ? gapY : gapX}`);
  });
}

// 四张一杠（用户截图那一处）+ 三组副露
const gang = [{ type: 'gang', tiles: [9, 9, 9, 9] }];
const mixed = [
  { type: 'chi', tiles: [0, 1, 2] },
  { type: 'peng', tiles: [5, 5, 5] },
  { type: 'gang', tiles: [9, 9, 9, 9] },
];
for (const slot of [1, 3]) run('单杠', gang, slot, false);
const angang = [{ type: 'angang', tiles: [16, 16, 16, 16] }];
for (const slot of [0, 2]) run('单杠(竖排)', gang, slot, false);
for (const slot of [0, 1, 2, 3]) run('暗杠(4张)', angang, slot, false);
for (const slot of [0, 2]) run('三组', mixed, slot, false);
for (const slot of [1, 3]) run('三组(侧列)', mixed, slot, false);
for (const slot of [1, 3]) run('三组', mixed, slot, false);
for (const slot of [0, 2]) run('单杠', gang, slot, false);
run('三组(over)', mixed, 1, true);
run('三组(over)', mixed, 0, true);
