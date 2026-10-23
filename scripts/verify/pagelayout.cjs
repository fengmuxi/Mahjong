/**
 * 整页布局校验（2026-10-21，用户报「牌面区域小、功能挤在顶部 + 手牌要正的」）。
 *
 * 这一轮把「原生导航栏 + HUD 三栏」改成「自绘顶栏 + 画布独占整行 + 侧边按钮轨 +
 * 弹层面板」，同时手牌去掉 3D 后仰。本脚本用 Chromium 实测新布局的三个硬约束：
 *
 *   ① **侧轨绝不压画布矩形**（最关键）：原生 canvas 合成层级高于所有 DOM，
 *      压在画布上的按钮会被 canvas 盖住、点不到。fitCanvas 用 min(行宽−84, 行高×2)
 *      保证画布两侧各留 ≥42px；这里逐像素验证「轨矩形 ∩ 画布矩形 = 空」。
 *   ② 画布尺寸 = fitCanvas 算式（独占整行、扣 RAIL_RESERVE）；
 *   ③ 手牌条仍能「不滚动看全 14 张」（沿用 handfit 的口径），且牌面是**正矩形**
 *      （transform: none → getBoundingClientRect 宽高 = 牌位盒宽高，无梯形压缩）。
 *   ④ **局中对齐**（2026-10-21 用户报「手牌应该局中对齐」）：牌群中心 == 手牌条中心
 *      == 画布中心（同一根轴，±1px），且牌缝紧凑（非摸牌间隙 ≤3px）——副露后只剩
 *      7 张牌时，旧的 space-between 会把条宽空余摊成 57px 大缝把牌拉散。
 *
 * 口径全部是 Chromium 实测：CSS 用**真实**的 app.wxss + game.wxss，rpx 按
 * 「窗口宽/750」换算成 px（与 wcsc 同一基准），DOM 与 WXML 等价。
 * LEGACY=space-between 可复现修复前的「出血对齐」出对照图。
 */
const fs = require('fs');
const path = require('path');
const { loadPlaywright, chromiumExecutable } = require('./_pw.cjs');
const ROOT = path.resolve(__dirname, '../..');
const MP = path.join(ROOT, 'packages/miniapp/miniprogram');
const OUT = path.join(ROOT, '.recover-tmp/shots');
const { chromium } = loadPlaywright();

// ---------- 从真实源码提取 handMetrics 与 RAIL 常量 ----------
const src = fs.readFileSync(path.join(MP, 'pages/game/game.js'), 'utf8');
const consts = {};
for (const k of ['RAIL_W', 'RAIL_GAP', 'HAND_TILES', 'HAND_TILE_W', 'HAND_TILE_H', 'HAND_TILE_GAP', 'HAND_DRAWN_EXTRA', 'HAND_MIN_W']) {
  const m = src.match(new RegExp(`const ${k} = (-?\\d+(?:\\.\\d+)?);`));
  if (!m) { console.error('抠常量失败', k); process.exit(1); }
  consts[k] = Number(m[1]);
}
const RAIL_RESERVE = (consts.RAIL_W + consts.RAIL_GAP) * 2;
const mBody = src.match(/  handMetrics\(rowW, canvasW\) \{[\s\S]*?\n  \},/);
if (!mBody) { console.error('抠 handMetrics 失败'); process.exit(1); }
const handMetrics = new Function(
  'HAND_TILES', 'HAND_TILE_W', 'HAND_TILE_H', 'HAND_TILE_GAP', 'HAND_DRAWN_EXTRA', 'HAND_MIN_W',
  `return function ${mBody[0].replace(/,\s*$/, '')}`,
)(consts.HAND_TILES, consts.HAND_TILE_W, consts.HAND_TILE_H, consts.HAND_TILE_GAP, consts.HAND_DRAWN_EXTRA, consts.HAND_MIN_W);

// ---------- rpx → px（wcsc 基准：1rpx = 窗口宽 / 750） ----------
function rpx2px(css, winW) {
  const k = winW / 750;
  return css.replace(/(-?\d+(?:\.\d+)?)rpx/g, (_, n) => `${(Number(n) * k).toFixed(3)}px`);
}

// ---------- 等价 DOM ----------
// 可选：手牌用真实牌面贴图（真机是 <image mode="aspectFill">，这里是等价的 <img>），
// 出「最终观感」对比图时打开；默认走矢量文字兜底（与旧截图可比）
const TILE_IMGS = !!process.env.TILE_IMGS;
const TILE_DATA = {};
if (TILE_IMGS) {
  for (let t = 0; t < 34; t++) {
    const f = path.join(ROOT, `packages/server/public/tiles/t${String(t).padStart(2, '0')}.webp`);
    if (fs.existsSync(f)) TILE_DATA[t] = 'data:image/webp;base64,' + fs.readFileSync(f).toString('base64');
  }
}
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
function tilesHtml(n) {
  const list = HAND.slice(0, n);
  return list.map((t, i) => {
    const m = meta(t);
    const inner = TILE_DATA[t]
      ? `<img class="tile-img" style="object-fit:cover;border-radius:3px" src="${TILE_DATA[t]}">`
      : m.honor
        ? `<text class="tile-honor">${m.suitChar}</text>`
        : `<text class="tile-rank">${m.rank}</text><text class="tile-suit">${m.suitChar}</text>`;
    return `<view class="tile-btn tone-${m.tone}${i === list.length - 1 ? ' drawn' : ''}">${inner}</view>`;
  }).join('');
}

function pageHtml(winW, hm, canvasW, canvasH, canvasImg, n, justifyOverride) {
  const app = rpx2px(fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8'), winW);
  const game = rpx2px(fs.readFileSync(path.join(MP, 'pages/game/game.wxss'), 'utf8'), winW);
  const tableCss = canvasImg
    ? `#table{background:url(${canvasImg}) center/100% 100% no-repeat;border-radius:6px}`
    : `#table{background:linear-gradient(#23405f,#16283c);border-radius:6px}`;
  // 复现 2026-10-20 的完整组合：行占满条宽 + space-between（两个都要，缺一不可复现摊散）
  const legacy = justifyOverride
    ? `.tray-row{width:100%!important;margin:0!important;justify-content:${justifyOverride}!important}`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${app}</style><style>${game}</style>
<style>
  html,body{margin:0;font-family:sans-serif}
  /* 等价 WXML 结构：.page.game > .g-top + .game-main(rail-l + canvas-wrap + rail-r) + .board-overlay */
  .game-main{display:flex}
  ${legacy}
  ${tableCss}
  /* 真机里 .page 是 <view>，app.wxss 的 view{box-sizing:border-box} 生效；
     mock 用 <div> 就落回 content-box —— 页面凭空高出左右 padding 之和，
     表现为手牌条底边被视口裁掉（2026-10-22 排查「手牌被切」时踩到，纯 mock 假象）。 */
  div{box-sizing:border-box}
  view,text{display:block}
</style></head><body>
<div class="page game bg-cloud" style="--safe-l:0px;--safe-r:0px;--safe-t:0px">
  ${FELT_IMG ? `<div class="felt" style="background-image:url(${FELT_IMG})"></div>` : ''}
  <div class="g-top">
    <div class="g-top-back">‹</div>
    <div class="g-top-info"><text class="badge">赣州</text><text class="code">A1B2</text><text class="g-top-item">牌墙 51</text></div>
    <div class="g-top-cap"></div>
  </div>
  <div class="game-main" id="game-main">
    <div class="rail rail-l"><button class="rail-btn">📋</button></div>
    <div class="canvas-wrap" id="canvas-wrap"><div id="table" style="width:${canvasW}px;height:${canvasH}px"></div></div>
    <div class="rail rail-r">
      <button class="rail-btn">💬<text class="rail-badge">3</text></button>
      <button class="rail-btn on">🤖</button>
      <button class="rail-btn">🎯</button>
      <button class="rail-btn danger">✕</button>
    </div>
    ${PANEL === 'log' ? `
    <div class="side-panel">
      <div class="panel-card log-card">
        <div class="panel-head"><text class="panel-title">操作记录</text><button class="panel-x">✕</button></div>
        <div class="panel-body"><view class="log-row"><text class="log-seat">东家</text><text class="log-action peng">碰</text><text class="log-tiles">五万</text></view></div>
      </div>
    </div>` : ''}
    ${PANEL === 'chat' ? `
    <div class="side-panel">
      <div class="panel-card chat-card">
        <div class="panel-head"><text class="panel-title">聊天</text><button class="panel-x">✕</button></div>
        <div class="chat-log"><view class="chat-msg"><text class="chat-name">东家：</text><text class="chat-text">快点啊</text></view></div>
        <div class="chat-input-row"><input class="chat-input" value=""><button class="primary chat-send">发送</button></div>
      </div>
    </div>` : ''}
  </div>
  <div class="board-overlay" style="width:${hm.handTrayW}px;margin:0 auto">
    <div class="g-status"><text class="g-status-text">请出牌</text></div>
    <div class="tray-stack">
      <div class="hand-tray active"><div class="tray-row" style="--tw:${hm.handTileW}px;--th:${hm.handTileH}px;--ml-drawn:${hm.handMlDrawn}px;--fs-rank:${hm.handFsRank}px;--fs-suit:${hm.handFsSuit}px;--fs-honor:${hm.handFsHonor}px">${tilesHtml(n)}</div></div>
    </div>
  </div>
</div>
</body></html>`;
}

const VIEWPORTS = [
  { name: 'iphone_land', w: 844, h: 390, scale: 2, n: 14 },
  // 用户真机截图复现场：13 手牌 − 两组副露 6 张 = 7 张（当时被 space-between 摊散）
  { name: 'iphone_7tiles', w: 844, h: 390, scale: 2, n: 7 },
  { name: 'se_land', w: 667, h: 375, scale: 2, n: 14 },
  { name: 'pc_wide', w: 1290, h: 624, scale: 1, n: 14 },
];
// 可选：把真实牌桌渲染图（shots_live 的产物）贴进 #table，出「最终效果」截图
const CANVAS_IMG = process.env.CANVAS_IMG ? 'data:image/png;base64,' + fs.readFileSync(process.env.CANVAS_IMG).toString('base64') : '';
// 可选：整屏桌面（.felt 层）。默认读服务端 public/ui/hud/table.webp —— 与线上同一张图，
// 用来验「DOM 铺外圈 + canvas 铺内圈」两层接缝看不看得出来。
const FELT_PATH = process.env.FELT_IMG || path.join(ROOT, 'packages/server/public/ui/hud/table.webp');
const FELT_IMG = fs.existsSync(FELT_PATH)
  ? 'data:image/webp;base64,' + fs.readFileSync(FELT_PATH).toString('base64')
  : '';
// 可选：打开某个侧边面板（chat / log），验面板不遮底部手牌条
const PANEL = process.env.PANEL || '';
// 可选：LEGACY=space-between 复现 2026-10-20 的「出血对齐」，出修复前对照图
const JUSTIFY = process.env.LEGACY || '';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true, args: ['--no-sandbox', '--disable-extensions'],
  });

  let fails = 0;
  const rows = [];
  for (const v of VIEWPORTS) {
    const n = v.n || 14;
    const page = await browser.newPage({ viewport: { width: v.w, height: v.h }, deviceScaleFactor: v.scale, colorScheme: 'light' });
    // 第一遍：量 .game-main（真实 fitCanvas 的 W/H 就是它；rowW 也用它，不是窗口宽）
    await page.setContent(pageHtml(v.w, handMetrics(v.w, 600), 600, 300, CANVAS_IMG, n, JUSTIFY), { waitUntil: 'load' });
    await page.waitForTimeout(60);
    const main = await page.evaluate(() => {
      const m = document.querySelector('.game-main').getBoundingClientRect();
      return { w: m.width, h: m.height };
    });
    // 与 game.js fitCanvas 同一算式
    const expect = Math.max(240, Math.floor(Math.min(Math.max(240, main.w - RAIL_RESERVE), main.h * 2)));
    const hm = handMetrics(main.w, expect);
    // 第二遍：按算式写入画布尺寸 + 手牌度量，再量全部约束
    const htmlFinal = pageHtml(v.w, hm, expect, Math.round(expect / 2), CANVAS_IMG, n, JUSTIFY);
    if (process.env.DUMP_HTML) {
      // 按视口分文件，否则只会留下最后跑的那个（probe_v.mjs 要按视口复核竖向预算）
      const dumpFile = process.env.DUMP_HTML.replace(/\.html$/, '') + '_' + v.name + '.html';
      fs.writeFileSync(dumpFile, htmlFinal);
    }
    await page.setContent(htmlFinal, { waitUntil: 'load' });
    await page.waitForTimeout(80);
    const out = await page.evaluate((expectW) => {
      const rect = (sel) => { const e = document.querySelector(sel); return e ? e.getBoundingClientRect() : null; };
      const canvas = rect('#table');
      const main = rect('.game-main');
      const overlay = rect('.board-overlay');
      const game = rect('.game');
      // 轨的矩形（取所有钮的并集）
      const union = (sel) => {
        const rs = [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
        if (!rs.length) return null;
        return {
          l: Math.min(...rs.map((x) => x.left)), r: Math.max(...rs.map((x) => x.right)),
          t: Math.min(...rs.map((x) => x.top)), b: Math.max(...rs.map((x) => x.bottom)),
        };
      };
      const uL = union('.rail-l .rail-btn');
      const uR = union('.rail-r .rail-btn');
      const tray = document.querySelector('.hand-tray');
      const row = document.querySelector('.tray-row');
      const tile = document.querySelector('.tile-btn');
      const tileCs = getComputedStyle(tile);
      const tileRect = tile.getBoundingClientRect();
      const cs = getComputedStyle(document.querySelector('.g-top'));
      // 面板约束：必须留在 .game-main 内（盖牌桌区），且**不遮底部手牌条**
      const panel = document.querySelector('.side-panel');
      const overlayEl = document.querySelector('.board-overlay');
      const panelInfo = panel ? {
        insideMain: !!panel.closest('.game-main'),
        aboveTray: panel.getBoundingClientRect().bottom <= overlayEl.getBoundingClientRect().top + 0.5,
        bottom: panel.getBoundingClientRect().bottom,
        trayTop: overlayEl.getBoundingClientRect().top,
      } : null;
      // 牌群几何：相邻间隙 + 牌群中心 vs 条中心 vs 画布中心（「局中对齐」三项）
      const tileEls = [...document.querySelectorAll('.tile-btn')];
      const tiles = tileEls.map((e) => e.getBoundingClientRect());
      const gaps = [];
      for (let i = 1; i < tiles.length; i++) gaps.push(tiles[i].left - tiles[i - 1].right);
      const groupL = Math.min(...tiles.map((x) => x.left));
      const groupR = Math.max(...tiles.map((x) => x.right));
      // 摸牌位是最后一张（.drawn，syncHandTray 也是 push 到末尾）：它左边那道缝允许
      // 放宽到 --ml-drawn；其它缝必须 ≤3px（左右各 1px 外边距 + 舍入）
      const drawnIdx = tileEls.findIndex((e) => e.className.includes('drawn'));
      const drawnGap = drawnIdx > 0 ? gaps[drawnIdx - 1] : 0;
      const maxOtherGap = Math.max(0, ...gaps.filter((_, i) => i !== drawnIdx - 1));
      return {
        canvas: { x: canvas.left - main.left, w: canvas.width, h: canvas.height },
        canvasW_expect: expectW,
        uL, uR,
        railGapL: uL ? canvas.left - uL.r : null,
        railGapR: uR ? uR.l - canvas.right : null,
        topH: parseFloat(cs.height),
        content: row.scrollWidth,
        overlayW: overlay.width,
        overlayRight: overlay.right, gameRight: game.right,
        overlayInside: overlay.right <= game.right + 0.5 && overlay.left >= game.left - 0.5,
        trayRect: tileRect.width === parseFloat(tileCs.width) && tileRect.height === parseFloat(tileCs.height),
        tileTransform: tileCs.transform,
        tileShadow: tileCs.boxShadow !== 'none',
        nTiles: tiles.length,
        panelInfo,
        groupCenterRel: (groupL + groupR) / 2 - main.left,
        maxGap: gaps.length ? Math.max(...gaps) : 0,
        maxOtherGap,
        drawnGap,
        canvasCenterRel: canvas.left + canvas.width / 2 - main.left,
        overlayCenterRel: overlay.left + overlay.width / 2 - main.left,
      };
    }, expect);

    const gapOk = out.railGapL > 0 && out.railGapR > 0;
    const sizeOk = Math.abs(out.canvas.w - out.canvasW_expect) <= 1 && Math.abs(out.canvas.h - Math.round(out.canvasW_expect / 2)) <= 1;
    // 「不滑动」的真判据：14 张内容宽 ≤ 手牌条宽（board-overlay），且整条不溢出页面
    const trayOk = out.content <= out.overlayW + 0.5 && out.overlayInside;
    // 正视：transform 必须是 none，且实测盒 = 声明盒（无梯形压缩）
    const squareOk = out.tileTransform === 'none' && out.trayRect;
    const panelOk = !out.panelInfo || (out.panelInfo.insideMain && out.panelInfo.aboveTray);
    // 局中对齐（2026-10-21 用户报「手牌应该局中对齐」）：
    //   ① 牌群中心 == 条中心（±1）；② 牌群与画布同一条中心轴（±1）；
    //   ③ 牌缝紧凑：除摸牌位那道缝（放宽到 --ml-drawn）外，其余 ≤3px ——
    //      space-between 会把空余摊成几十 px 的大缝（真机实测 7 张牌摊出 57px 缝）
    const aligned = Math.abs(out.groupCenterRel - out.overlayCenterRel) <= 1
      && Math.abs(out.groupCenterRel - out.canvasCenterRel) <= 1;
    const tight = out.maxOtherGap <= 3;
    const ok = gapOk && sizeOk && trayOk && squareOk && panelOk && out.nTiles === n && out.tileShadow && aligned && tight;
    if (!ok) fails++;
    rows.push({
      v: v.name + (n === 14 ? '' : `(${n}张)`), canvas: `${out.canvas.w}×${out.canvas.h}`, expect: out.canvasW_expect,
      gapL: out.railGapL === null ? '-' : out.railGapL.toFixed(1),
      gapR: out.railGapR === null ? '-' : out.railGapR.toFixed(1),
      tray: `${out.content.toFixed(0)}≤${out.overlayW.toFixed(0)}${trayOk ? ' ✔' : ' ✘'}`,
      inside: out.overlayInside ? '✔' : '✘',
      panel: out.panelInfo ? `${out.panelInfo.insideMain ? 'main内' : '越界!'}·${out.panelInfo.aboveTray ? '不遮手牌✔' : '遮手牌✘'}` : '-',
      topH: out.topH, tf: out.tileTransform, ok,
      align: `${aligned ? '✔' : '✘'}${tight ? '' : '·缝大✘'}`,
      maxGap: out.maxOtherGap.toFixed(1),
      drawnGap: out.drawnGap.toFixed(1),
    });
    await page.screenshot({ path: path.join(OUT, `layout_${v.name}${JUSTIFY ? '_legacy' : ''}.png`) });
    await page.close();
  }

  console.log('视口            | 画布实测      | 算式   | 左轨缝 | 右轨缝 | 手牌内容≤条宽   | 不溢出 | 面板            | 顶栏 | transform | 局中 | 最大缝(非摸牌)');
  console.log('----------------|---------------|--------|--------|--------|-----------------|--------|-----------------|------|----------|------|---------------');
  for (const r of rows) {
    console.log(
      `${r.v.padEnd(15)} | ${r.canvas.padEnd(13)} | ${String(r.expect).padStart(6)} | ${r.gapL.padStart(6)} | ${r.gapR.padStart(6)} | ${r.tray.padEnd(15)} | ${r.inside.padStart(6)} | ${r.panel.padEnd(15)} | ${String(r.topH).padStart(4)} | ${r.tf.padEnd(8)} | ${r.align.padEnd(4)} | ${r.maxGap}`,
    );
  }
  console.log(fails === 0 ? '\n全部通过：轨不压画布、画布尺寸与算式一致、手牌内容排得进条宽且为正矩形、牌群局中且紧凑' : `\n失败 ${fails} 项`);
  await browser.close();
  process.exit(fails === 0 ? 0 : 1);
})();
