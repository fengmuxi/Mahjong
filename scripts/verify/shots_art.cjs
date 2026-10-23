/**
 * Chromium 实渲染 harness（真实贴图版）：把 utils/table.js 灌进真实 canvas 2D，
 * tileimg/uiart **返回真实 CDN WebP 位图**（public/tiles 34 张立牌 + face/ 4 张平放牌图集
 * + public/ui 5 组 26 张；2026-10-23 分类整理后均递归读子目录），
 * 出 4 个相位的截图 —— 用来肉眼验收 2026-10-21 换美术后的桌面效果
 * （新牌面 / 金纹牌背 / 红印章庄标 / LED 大数字）。
 * 与 shots.cjs（矢量版）、geomcheck.cjs（几何版）三者互补。
 */
const fs = require('fs');
const path = require('path');
const { loadPlaywright, chromiumExecutable } = require('./_pw.cjs');

const ROOT = path.resolve(__dirname, '../..');
const MP = path.join(ROOT, 'packages/miniapp/miniprogram');
const OUT = path.join(ROOT, '.recover-tmp/shots_art');

const { chromium } = loadPlaywright();

const read = (p) => fs.readFileSync(p, 'utf8');
const b64url = (p) => 'data:image/webp;base64,' + fs.readFileSync(p).toString('base64');

// 真实贴图：34 张牌面 + 19 张 UI（back/peng/gang/hu/guo/win/lost/draw/banker/d0..d9）
const ART = {
  tiles: {
    ...Object.fromEntries(
      Array.from({ length: 34 }, (_, i) => [
        String(i),
        b64url(path.join(ROOT, `packages/server/public/tiles/t${String(i).padStart(2, '0')}.webp`)),
      ])
    ),
    // 按座位平放牌图集（2026-10-23 起归牌面大类 public/tiles/face/，tileimg.faceArt 取）
    ...Object.fromEntries(
      fs.readdirSync(path.join(ROOT, 'packages/server/public/tiles/face'))
        .filter((f) => /^face[A-D]\.webp$/.test(f))
        .map((f) => [f.replace(/\.webp$/, ''), b64url(path.join(ROOT, `packages/server/public/tiles/face/${f}`))])
    ),
  },
  ui: Object.fromEntries(
    fs.readdirSync(path.join(ROOT, 'packages/server/public/ui'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) =>
        fs.readdirSync(path.join(ROOT, `packages/server/public/ui/${d.name}`))
          .filter((f) => /\.webp$/.test(f))
          .map((f) => [f.replace(/\.webp$/, ''), b64url(path.join(ROOT, `packages/server/public/ui/${d.name}/${f}`))])
      ),
  ),
};

// ---------- 页面：迷你 CJS 加载器 + 合成视图 ----------
const pageSrc = (modulesSrc) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#2a2f33}
  #c{display:block;width:1280px;height:640px}
</style></head>
<body><canvas id="c"></canvas><script>
const MODULES = ${JSON.stringify(modulesSrc).replace(/<\//g, '<\\/')};
const CACHE = {};
function req(name) {
  if (CACHE[name]) return CACHE[name].exports;
  const m = { exports: {} };
  CACHE[name] = m;
  new Function('module', 'exports', 'require', MODULES[name])(m, m.exports, req);
  return m.exports;
}
// 禁自绘：只保留显式 render 一帧，截图状态确定
window.requestAnimationFrame = function () { return 0; };

const wallLib = req('../lib/shared/wall.js');
const { Table } = req('./table.js');

function makeView(opts) {
  const recipe = wallLib.buildRecipe(opts.dealer, [3, 4]);
  return {
    code: 'TEST', phase: opts.phase || 'playing', dealer: opts.dealer === undefined ? 0 : opts.dealer, turn: opts.turn === undefined ? 1 : opts.turn, mySeat: 0,
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
}
function river(start, n) { const a = []; for (let i = 0; i < n; i++) a.push((start + i) % 34); return a; }

const VIEWS = {
  nanchang_playing: makeView({
    rivers: [river(0, 14), river(3, 20), river(7, 22), river(11, 18)],
    melds: [
      [{ type: 'chi', tiles: [0, 1, 2] }, { type: 'peng', tiles: [5, 5, 5] }],
      [{ type: 'gang', tiles: [9, 9, 9, 9] }],
      [{ type: 'chi', tiles: [12, 13, 14] }],
      [],
    ],
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
    rivers: [river(0, 14), river(3, 20), river(7, 22), river(11, 18)],
    melds: [
      [{ type: 'chi', tiles: [0, 1, 2] }, { type: 'peng', tiles: [5, 5, 5] }, { type: 'chi', tiles: [12, 13, 14] }, { type: 'chi', tiles: [12, 13, 14] }],
      [{ type: 'peng', tiles: [5, 5, 5] }, { type: 'gang', tiles: [9, 9, 9, 9] }, { type: 'chi', tiles: [12, 13, 14] }, { type: 'chi', tiles: [12, 13, 14] }],
      [],
      [{ type: 'peng', tiles: [5, 5, 5] }, { type: 'gang', tiles: [9, 9, 9, 9] }, { type: 'chi', tiles: [12, 13, 14] }, { type: 'chi', tiles: [12, 13, 14] }],
    ],
    counts: [0, 0, 0, 0],
    lastDiscard: { tile: 20, from: 0 },
  }),
};

// ---- 真实贴图预加载（dataURL → 已解码 HTMLImageElement）----
const ART_TILES = __ART_TILES__;
const ART_UI = __ART_UI__;
window.__art = null;
window.__preloadArt = async function () {
  const load = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = u; });
  // 遍历全部键：34 张立牌（数字键）+ faceA..faceD 平放牌图集（字符串键，2026-10-23 起）
  const tiles = {};
  for (const k of Object.keys(ART_TILES)) tiles[k] = await load(ART_TILES[k]);
  const ui = {};
  for (const k of Object.keys(ART_UI)) ui[k] = await load(ART_UI[k]);
  window.__art = { tiles, ui };
  return true;
};

window.__shot = function (name) {
  const table = new Table(document.getElementById('c'), 2);
  // FRAME：模拟"整屏桌面"——桌面贴图按页面矩形铺（逻辑坐标，可比画布大、含负值）
  if (window.__frame) table.frame = window.__frame;
  table.render(VIEWS[name]);
  window.__table = table;
  return true;
};
window.__setDegrade = function () {
  Table._canvasOff = true;
  return true;
};
window.__names = Object.keys(VIEWS);
</script></body></html>`;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const modules = {
    '../lib/shared/tiles.js': read(path.join(MP, 'lib/shared/tiles.js')),
    '../lib/shared/wall.js': read(path.join(MP, 'lib/shared/wall.js')),
    // tileimg/uiart stub：返回 window.__art 里的真实位图（未预加载前 → null → 矢量）
    './tileimg.js': `module.exports = {
  art: (t) => (window.__art ? window.__art.tiles[t] : null),
  faceArt: (k, t) => {
    const CELL = { faceA: [46, 64], faceB: [59, 48], faceC: [42, 60], faceD: [59, 48] };
    const c = CELL[k]; const img = window.__art ? window.__art.tiles[k] : null;
    if (!c || !img) return null;
    return { img, sx: (t % 9) * c[0], sy: Math.floor(t / 9) * c[1], sw: c[0], sh: c[1] };
  },
  ready: () => !!window.__art,
};`,
    './uiart.js': 'module.exports = { art: (k) => (window.__art ? window.__art.ui[k] : null), ready: () => !!window.__art };',
    './table.js': read(path.join(MP, 'utils/table.js')),
  };
  const html = pageSrc(modules)
    .replace('__ART_TILES__', JSON.stringify(ART.tiles))
    .replace('__ART_UI__', JSON.stringify(ART.ui));

  const exePath = chromiumExecutable();
  const browser = await chromium.launch({
    executablePath: exePath,
    headless: true,
    args: ['--no-sandbox', '--disable-extensions'],
  });

  const clips = {
    nanchang_playing: [
      { name: 'center', x: 480, y: 200, width: 320, height: 240 },   // 信息盘 + 左右副露
      { name: 'topright', x: 600, y: 0, width: 500, height: 260 },   // 对家牌河 + 副露 + 铭牌
      { name: 'tag', x: 1020, y: 0, width: 260, height: 90 },        // 右上铭牌（风位圆牌 + 庄标）
      { name: 'bottom', x: 318, y: 420, width: 640, height: 220 },   // 底边牌河 + 副露带
    ],
    gz_playing: [
      { name: 'disk', x: 500, y: 230, width: 280, height: 190 },
      { name: 'wall', x: 330, y: 100, width: 620, height: 72 },      // 顶边立体牌背墙特写
      { name: 'tag', x: 0, y: 556, width: 260, height: 84 },         // 左下铭牌（庄标）
    ],
    deal_ceremony: [
      { name: 'disk', x: 500, y: 230, width: 280, height: 190 },
    ],
    over_win: [
      { name: 'left', x: 0, y: 240, width: 420, height: 340 },       // 摊牌两列 × 缩排河
      { name: 'right', x: 880, y: 60, width: 400, height: 520 },     // 赢家摊牌 + 高亮框
    ],
  };

  for (const name of ['nanchang_playing', 'gz_playing', 'deal_ceremony', 'over_win']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 2, colorScheme: 'light' });
    page.on('pageerror', (e) => console.log(`  [pageerror] ${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console] ${name}: ${m.text()}`); });
    await page.setContent(html, { waitUntil: 'load' });
    if (process.env.FRAME) {
      await page.evaluate((f) => { window.__frame = f; }, JSON.parse(process.env.FRAME));
    }
    if (process.env.DEGRADE) await page.evaluate(() => window.__setDegrade());
    await page.evaluate(() => window.__preloadArt());
    const decoded = await page.evaluate(() => ({
      tiles: window.__art ? Object.values(window.__art.tiles).filter(Boolean).length : 0,
      ui: window.__art ? Object.values(window.__art.ui).filter(Boolean).length : 0,
    }));
    console.log(`  art decoded: tiles ${decoded.tiles}/34 · ui ${decoded.ui}/19`);
    await page.evaluate((n) => window.__shot(n), name);
    if (process.env.MELDPROBE) {
      const mp = await page.evaluate(() => {
        const t = window.__table, v = t.view;
        const out = [];
        for (let s = 0; s < 4; s++) {
          const slot = t.disp(v, s);
          const seat = s;
          out.push({
            seat, slot,
            melds: (v.melds[seat] || []).map((m) => ({ type: m.type, n: m.tiles.length })),
            decl: (v.declared || []).filter((d) => d.seat === seat).length,
            mm: t.meldMetrics(slot),
            cell: (window.__uiartCell ? window.__uiartCell(slot) : null),
          });
        }
        return out;
      });
      console.log('  [meldprobe]', JSON.stringify(mp));
    }
    if (process.env.PROBE) {
      const probe = await page.evaluate(() => ({
        o3: window.__table.riverOrigin(3), p3: window.__table.riverPos(3, 0),
        o1: window.__table.riverOrigin(1), p1: window.__table.riverPos(1, 0),
        o0: window.__table.riverOrigin(0), p0: window.__table.riverPos(0, 0),
      }));
      console.log("  [probe]", JSON.stringify(probe));
    }
    const ms = await page.evaluate(() => {
      const t = window.__table;
      const v = t.lastRendered;
      t.render(v);
      const t0 = performance.now();
      for (let i = 0; i < 30; i++) t.render(v);
      return (performance.now() - t0) / 30;
    });
    console.log(`  frame ${ms.toFixed(2)} ms`);
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(OUT, `${name}${process.env.DEGRADE ? "__degraded" : ""}.png`) });
    for (const c of (clips[name] || [])) {
      await page.screenshot({
        path: path.join(OUT, `${name}__${c.name}.png`),
        clip: { x: c.x, y: c.y, width: c.width, height: c.height },
      });
    }
    await page.close();
    console.log(`✔ ${name}.png`);
  }
  await browser.close();
  console.log('done →', OUT);
})().catch((e) => { console.error(e); process.exit(1); });
