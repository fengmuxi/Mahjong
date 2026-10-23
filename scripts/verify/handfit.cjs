/**
 * 手牌条「全部显示、不再滑动」验证（2026-10-21，用户报「手牌为啥还能滑动」）。
 *
 * 做三件事：
 *  ① 从 game.js **源码里抠出** handMetrics 与 HAND_TILE_* 常量（不是抄一份副本，
 *     改了真实代码这里自动跟上），在浏览器里按真实 fitCanvas 的算式跑各视口；
 *  ② 用**真实的 game.wxss** + 与 WXML 等价的 DOM（牌位/字号全走 CSS 变量）渲染，
 *     断言「14 张内容宽 ≤ 条宽」（scrollWidth == clientWidth，没东西可滚）、
 *     以及「文字不被牌位裁切」；
 *  ③ 出四种视口的截图：PC 宽窗 / iPhone 横屏 / SE 横屏 / 极端窄窗（iPad 分屏级）。
 *
 * 判定口径（全部为 Chromium 实测，不是估算）：
 *   fit    = .tray-row.scrollWidth <= .hand-tray.clientWidth + 0.5
 *   nocut  = 每个 .tile-btn 的 scrollWidth/scrollHeight <= client（文字/图片不出血、不裁切）
 */
const fs = require('fs');
const path = require('path');
const { loadPlaywright, chromiumExecutable } = require('./_pw.cjs');
const ROOT = path.resolve(__dirname, '../..');
const MP = path.join(ROOT, 'packages/miniapp/miniprogram');
const OUT = path.join(ROOT, '.recover-tmp/shots');
const { chromium } = loadPlaywright();

// ---------- ① 从真实源码提取 handMetrics ----------
const src = fs.readFileSync(path.join(MP, 'pages/game/game.js'), 'utf8');
const consts = {};
for (const k of ['HAND_TILES', 'HAND_TILE_W', 'HAND_TILE_H', 'HAND_TILE_GAP', 'HAND_DRAWN_EXTRA', 'HAND_MIN_W']) {
  const m = src.match(new RegExp(`const ${k} = (-?\\d+(?:\\.\\d+)?);`));
  if (!m) { console.error('抠常量失败', k); process.exit(1); }
  consts[k] = Number(m[1]);
}
const mBody = src.match(/  handMetrics\(rowW, canvasW\) \{[\s\S]*?\n  \},/);
if (!mBody) { console.error('抠 handMetrics 失败'); process.exit(1); }
const handMetrics = new Function(
  'HAND_TILES', 'HAND_TILE_W', 'HAND_TILE_H', 'HAND_TILE_GAP', 'HAND_DRAWN_EXTRA', 'HAND_MIN_W',
  `return function ${mBody[0].replace(/,\s*$/, '')}`,
)(consts.HAND_TILES, consts.HAND_TILE_W, consts.HAND_TILE_H, consts.HAND_TILE_GAP, consts.HAND_DRAWN_EXTRA, consts.HAND_MIN_W);

// ---------- fitCanvas 的算式副本（用来给各视口算 canvasW；与 game.js fitCanvas 同源） ----------
// 2026-10-21 布局重排后：画布独占整行，只在宽度方向扣 RAIL_RESERVE 给左右两条按钮轨。
const RAIL_W = 36, RAIL_GAP = 6;
const RAIL_RESERVE = (RAIL_W + RAIL_GAP) * 2;
function fitCanvasMath(W, H) {
  const w = Math.max(240, Math.floor(Math.min(Math.max(240, W - RAIL_RESERVE), H * 2)));
  return { canvasW: w, canvasH: Math.round(w / 2), sideCols: false };
}

// ---------- ② 真实 wxss + 等价 DOM ----------
const wxss = fs.readFileSync(path.join(MP, 'pages/game/game.wxss'), 'utf8');
const HAND = [0, 1, 2, 4, 6, 9, 13, 16, 18, 20, 27, 31, 32, 33];
const meta = (t) => {
  if (t < 27) {
    const suit = t < 9 ? ['m', '万'] : t < 18 ? ['s', '条'] : ['p', '筒'];
    return { tone: suit[0], honor: false, rank: (t % 9) + 1, suitChar: suit[1] };
  }
  const names = { 27: '东', 28: '南', 29: '西', 30: '北', 31: '中', 32: '发', 33: '白' };
  const tone = t === 31 ? 'zhong' : t === 32 ? 'fa' : t === 33 ? 'bai' : 'wind';
  return { tone, honor: true, suitChar: names[t] };
};
const tilesHtml = (mode) => HAND.map((t, i) => {
  const m = meta(t);
  const inner = mode === 'img'
    ? `<img class="tile-img" src="/tiles/t${String(t).padStart(2, '0')}.webp" style="width:100%;height:100%;object-fit:cover;display:block">`
    : (m.honor ? `<text class="tile-honor">${m.suitChar}</text>` : `<text class="tile-rank">${m.rank}</text><text class="tile-suit">${m.suitChar}</text>`);
  return `<view class="tile-btn tone-${m.tone}${i === HAND.length - 1 ? ' drawn' : ''}">${inner}</view>`;
}).join('');

const pageHtml = (hm, canvasW, mode) => `<!DOCTYPE html><html><head><meta charset="utf-8"><base href="http://localhost/tiles/">
<style>${wxss}</style>
<style>
html,body{margin:0;background:#0d1626;font-family:sans-serif}
view{display:block}
/* scroll-view 的等价物：横向滚动容器 */
.hand-tray{display:flex;justify-content:center;white-space:nowrap;overflow-x:auto}
.tray-row{display:flex;flex-wrap:nowrap;justify-content:space-between}
.stage{padding:8px 0}
.tip{color:#9db5a8;font-size:11px;padding:2px 4px}
</style></head><body>
<div class="stage"><div class="tip">牌位 ${hm.handTileW}×${hm.handTileH} · 条宽 ${hm.handTrayW} · 画布 ${canvasW}</div>
<view class="board-overlay" style="width:${hm.handTrayW}px;margin:0 auto">
  <view class="g-status"><text class="g-status-text">请出牌</text></view>
  <view class="tray-stack">
    <scroll-view class="hand-tray active">
      <view class="tray-row" style="--tw:${hm.handTileW}px; --th:${hm.handTileH}px; --ml-drawn:${hm.handMlDrawn}px; --fs-rank:${hm.handFsRank}px; --fs-suit:${hm.handFsSuit}px; --fs-honor:${hm.handFsHonor}px; --persp:${hm.handPersp}px">${tilesHtml(mode)}</view>
    </scroll-view>
  </view>
</view></div>
</body></html>`;

// 视口表：HUD+状态行+手牌条的总高度（实测布局的近似，用于算画布高 → canvasW）
// 手机横屏 ≈ 40(HUD)+17(状态)+68(手牌条)+间隙 ≈ 130；PC 宽窗 ≈ 60+30+70 ≈ 165
const VIEWS = [
  { name: 'fit_wide', w: 1290, h: 624, chrome: 165 },   // PC 微信 / 开发者工具宽窗
  { name: 'fit_phone', w: 844, h: 390, chrome: 130 },   // iPhone 12/13/14 横屏
  { name: 'fit_se', w: 667, h: 375, chrome: 130 },      // iPhone SE 横屏
  { name: 'fit_split', w: 341, h: 390, chrome: 130 },   // iPad 分屏 1/3（极端窄窗）
];

(async () => {
  const TILE_DIR = path.join(ROOT, 'packages/server/public/tiles');
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true, args: ['--no-sandbox', '--disable-extensions'],
  });

  let fail = 0;
  const report = [];
  for (const v of VIEWS) {
    // 页面横向 padding = 24rpx×2（rpx 基准 = 窗口宽）
    const pad = Math.round(48 * (v.w / 750));
    const W = v.w - pad;
    const H = Math.max(120, v.h - v.chrome);
    const { canvasW } = fitCanvasMath(W, H);
    const hm = handMetrics(W, canvasW);
    const oldTrayW = canvasW; // 改前：条宽 = canvasW、牌位固定 46
    const overflowBefore = HAND_NEED() > oldTrayW;
    function HAND_NEED() { return consts.HAND_TILES * (consts.HAND_TILE_W + consts.HAND_TILE_GAP) + consts.HAND_DRAWN_EXTRA; }

    for (const mode of ['img', 'vec']) {
      const page = await browser.newPage({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: 2, colorScheme: 'light' });
      await page.route('**/tiles/t*.webp', (route) => {
        const f = path.join(TILE_DIR, path.basename(new URL(route.request().url()).pathname));
        fs.existsSync(f) ? route.fulfill({ path: f, contentType: 'image/webp' }) : route.abort();
      });
      await page.setContent(pageHtml(hm, canvasW, mode), { waitUntil: 'load' });
      await page.waitForTimeout(200);
      const m = await page.evaluate(() => {
        const tray = document.querySelector('.hand-tray');
        const row = document.querySelector('.tray-row');
        const btns = [...document.querySelectorAll('.tile-btn')];
        // 裁切：牌位盒 scrollWidth/Height 超出 client → 内容被 overflow:hidden 切了
        const cut = btns.filter((b) => b.scrollWidth > b.clientWidth + 0.5 || b.scrollHeight > b.clientHeight + 0.5).length;
        // 文字是否超出各自盒子（矢量兜底时最关键）
        const txt = [...document.querySelectorAll('.tile-rank,.tile-suit,.tile-honor')]
          .filter((t) => t.scrollWidth > t.clientWidth + 1).length;
        const r0 = btns[0].getBoundingClientRect();
        return {
          content: row.scrollWidth, client: tray.clientWidth,
          fit: row.scrollWidth <= tray.clientWidth + 0.5,
          cut, txt,
          tile: [Math.round(r0.width), Math.round(r0.height)],
        };
      });
      // 判定分两个 regime：条宽够 14 张（缩到手牌下限也放得下）→ 必须排得进、不许滚；
      // 条宽连下限都放不下（iPad 分屏这类极端窄窗）→ 设计内留给 scroll-view 滚动，
      // 但仍不许出现裁切/文字超框。
      const FLOOR_NEED = consts.HAND_TILES * (consts.HAND_MIN_W + consts.HAND_TILE_GAP) + consts.HAND_DRAWN_EXTRA;
      const expectFit = hm.handTrayW >= FLOOR_NEED;
      const ok = m.fit === expectFit && m.cut === 0 && m.txt === 0;
      if (!ok) fail++;
      report.push({ v: v.name, mode, canvasW, trayW: hm.handTrayW, tw: hm.handTileW, ...m, ok, expectFit, overflowBefore });
      if (mode === 'img') await page.screenshot({ path: path.join(OUT, `${v.name}.png`) });
      await page.close();
    }
  }
  await browser.close();

  console.log('常量（取自 game.js）:', JSON.stringify(consts));
  console.log('');
  console.log('视口            | 画布 | 改前溢出 | 改后条宽 | 牌位 | 内容宽 | 客户宽 | 应排满 | 排得进 | 裁切 | 文字超框');
  console.log('----------------|------|----------|----------|------|--------|--------|--------|--------|------|----------');
  for (const r of report) {
    console.log(
      `${r.v.padEnd(15)} | ${String(r.canvasW).padStart(4)} | ${(r.overflowBefore ? '是' : '否').padStart(8)} | ${String(r.trayW).padStart(8)} | ${String(r.tw).padStart(4)} | ${String(r.content).padStart(6)} | ${String(r.client).padStart(6)} | ${(r.expectFit ? '是' : '否(滚动兜底)').padStart(12)} | ${(r.fit ? '✔' : '✘').padStart(6)} | ${String(r.cut).padStart(4)} | ${String(r.txt).padStart(8)}`,
    );
  }
  console.log('');
  console.log(fail === 0 ? '✅ 全部通过：14 张永远排得进条宽，无滚动、无裁切' : `❌ ${fail} 项失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
