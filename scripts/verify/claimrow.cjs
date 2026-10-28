/**
 * 复刻 game 页「操作带 + 手牌条」的 DOM + 完整 WXSS/app.wxss，在 Chromium 里验证
 * 2026-10-24 第五轮的改造：操作带恒高、按钮浮入、画布不再忽大忽小。
 *
 * 背景：用户报「操作的按钮会把牌面挤变形，不应该是浮动在上层的吗，这样会导致牌桌的
 * 显示忽大忽小」。根因是按钮行按需占高度 → .board-overlay 总高变化 → 画布由
 * #game-main 剩余高度反算 → iPhone 13 横屏画布宽 526 → 436（−17%）。
 * 改法：合成一行 + 恒高 .action-bar（2026-10-25 由 44px 收到 34px），按钮 absolute 浮进去。
 */
const fs = require('fs');
const path = require('path');
const { loadPlaywright, chromiumExecutable } = require('./_pw.cjs');

const MP = path.resolve(__dirname, '../../packages/miniapp/miniprogram');
const RPX = 390 / 750; // iPhone 13：750rpx = 390px

function toCss(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(\d+(?:\.\d+)?)rpx/g, (_, n) => `${(Number(n) * RPX).toFixed(3)}px`)
    .replace(/^\s*page\s*\{[^}]*\}/gm, '');
}
const gameCss = toCss(fs.readFileSync(path.join(MP, 'pages/game/game.wxss'), 'utf8'));
const appCss = toCss(fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8'));

// 小程序内置标签的 display 语义（浏览器把 <view> 当自定义元素 → inline）
const TAG = `view{display:block;}text{display:inline;}button,input,image{display:inline-block;}`;

const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA=';
/** 操作带常量高度：直接从真 CSS 读，避免探针里写第二份真相 */
const BAR_H = Number((gameCss.match(/\.action-bar\s*\{[^}]*height:\s*([\d.]+)px/) || [])[1]);
const artBtn = (k, i, compact) =>
  `<button class="ctrl ${i === 0 ? '' : 'primary'} art ${compact ? 'compact' : ''}" data-idx="${i}">` +
  `<image class="ctrl-img" src="${PX}" mode="aspectFit"></image><text class="ctrl-cap">${k}${i}</text></button>`;
const declareBtn = (i, compact) =>
  `<button class="ctrl declare ${compact ? 'compact' : ''}" data-tile="${i}">报杠 ${'一二三四五六七八九'[i]}萬</button>`;
const tiles = (n) => Array.from({ length: n }, (_, i) =>
  `<view class="tile-btn tone-w" data-tile="${i}"><text class="tile-rank">${i + 1}</text><text class="tile-suit">萬</text></view>`).join('');

const html = ({ nClaim, nDeclare, compact, nTiles }) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}body{font-family:sans-serif;}
${TAG}
.game{height:100vh;display:flex;flex-direction:column;position:relative;
  padding-top:4px;padding-right:8.32px;padding-bottom:6.24px;padding-left:8.32px;}
.g-top{display:flex;align-items:center;height:28px;margin-bottom:2px;flex-shrink:0;}
.game-main{flex:1;min-height:0;display:flex;flex-direction:row;position:relative;z-index:1;}
.canvas-wrap{flex:1;min-width:0;min-height:0;display:flex;align-items:flex-end;justify-content:center;position:relative;}
.board-overlay{display:flex;flex-direction:column;align-items:center;flex-shrink:0;position:relative;z-index:1;}
${gameCss}
${appCss}
</style></head><body>
<div class="game">
  <div class="g-top"><text>南昌麻将</text></div>
  <div class="game-main" id="game-main">
    <div class="canvas-wrap" id="canvas-wrap"><canvas id="table" style="width:526px;height:263px;display:block"></canvas></div>
  </div>
  <div class="board-overlay" id="board-overlay" style="width:679px;margin:0 auto;">
    <div class="g-status" id="g-status"><text class="g-status-text">轮到你选择 — 碰 / 杠 / 吃 / 胡，或点「过」</text></div>
    <div class="action-bar" id="action-bar">
      <div class="claim-row" id="claim-row" ${nClaim + nDeclare > 0 ? '' : 'style="display:none"'}>
        <div class="controls" id="controls">
          ${Array.from({ length: nDeclare }, (_, i) => declareBtn(i, compact)).join('')}
          ${Array.from({ length: nClaim }, (_, i) => artBtn(['chi', 'peng', 'gang', 'hu', 'guo', 'chi', 'chi'][i % 7], i, compact)).join('')}
        </div>
      </div>
    </div>
    <div class="tray-stack" id="tray-stack">
      <div class="hand-tray" id="hand-tray">
        <div class="tray-row" id="tray-row" style="--tw:46px;--th:66px;--ml-drawn:8px;--fs-rank:25px;--fs-suit:12px;--fs-honor:27px">${tiles(nTiles)}</div>
      </div>
    </div>
  </div>
</div></body></html>`;

(async () => {
  const pw = loadPlaywright();
  const { chromium } = pw;
  const browser = await chromium.launch(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {});
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, colorScheme: 'light' });

  const fails = [];
  const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };

  const measure = async (cfg) => {
    await page.setContent(html(cfg));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return page.evaluate(() => {
      const g = (id) => document.getElementById(id);
      const rect = (el) => { const b = el.getBoundingClientRect(); return { y: +b.y.toFixed(1), h: +b.height.toFixed(1), top: +b.top.toFixed(1), bottom: +b.bottom.toFixed(1), w: +b.width.toFixed(1) }; };
      /*
       * 「有没有折行 / 有没有溢出格子」不按 top 聚类、也不按高度比：
       * `.controls` 是 align-items:flex-end —— 报杠胶囊 22~25px、艺术钮 29~33px
       * 底对齐后顶边天然相差一截，任何「按 top 分组」的指标都会误判。
       * 直接查两件**真正要保证的事**：
       *   ① flex-wrap 必须是 nowrap（折行会把内容推向上方、落进原生 canvas 看不见）；
       *   ② 每个按钮的矩形都必须落在 .action-bar 的矩形内（不向上/向下溢出）。
       */
      const barBox = g('action-bar').getBoundingClientRect();
      const items = [...document.querySelectorAll('.ctrl')];
      const noWrap = getComputedStyle(g('controls')).flexWrap === 'nowrap';
      const allInside = items.every((b) => {
        const r = b.getBoundingClientRect();
        return r.top >= barBox.top - 0.5 && r.bottom <= barBox.bottom + 0.5;
      });
      const overflow = Math.max(0, ...items.map((b) => {
        const r = b.getBoundingClientRect();
        return Math.max(barBox.top - r.top, r.bottom - barBox.bottom);
      }));
      const tile = g('tray-row').querySelector('.tile-btn');
      const tb = tile.getBoundingClientRect();
      const hit = document.elementFromPoint(tb.x + tb.width / 2, tb.y + tb.height / 2);
      const chain = [];
      for (let n = hit; n && chain.length < 4; n = n.parentElement) chain.push(n.id || n.className || n.tagName);
      return {
        bar: rect(g('action-bar')), tray: rect(g('tray-stack')), claim: rect(g('claim-row')),
        overlay: rect(g('board-overlay')), gm: rect(g('game-main')),
        nBtn: items.length, noWrap, allInside, overflow: +overflow.toFixed(1),
        hitIsTile: !!(hit && (hit === tile || tile.contains(hit))), chain,
      };
    });
  };

  console.log('== ① 有按钮（5 个吃碰杠胡过）==');
  const a = await measure({ nClaim: 5, nDeclare: 0, compact: false, nTiles: 10 });
  console.log(`  action-bar y=${a.bar.y} h=${a.bar.h} · claim-row h=${a.claim.h} · tray y=${a.tray.y} · overlay 总高 ${a.overlay.h}`);
  ok(a.bar.h === BAR_H, `.action-bar 恒高 ${BAR_H}px（实测 ${a.bar.h}）`);
  ok(a.claim.h <= BAR_H, `按钮行浮在带内不溢出（${a.claim.h} ≤ ${BAR_H}）`);
  ok(a.claim.bottom <= a.tray.top + 0.5, `按钮整体在手牌上方（底 ${a.claim.bottom} ≤ 手牌顶 ${a.tray.top}）`);
  ok(a.allInside && a.noWrap, `5 钮不折行且全在格子内（溢出 ${a.overflow}px）`);
  ok(a.hitIsTile, `手牌中心命中手牌自己（${a.chain.join(' < ')}）`);

  console.log('== ② 无按钮（平时态）==');
  const b = await measure({ nClaim: 0, nDeclare: 0, compact: false, nTiles: 10 });
  ok(b.bar.h === BAR_H, `无钮时操作带仍恒高 ${BAR_H}px（${b.bar.h}）—— 不塌掉`);
  ok(Math.abs(b.overlay.h - a.overlay.h) < 0.5,
    `**board-overlay 总高恒定**（有钮 ${a.overlay.h} vs 无钮 ${b.overlay.h}）→ 画布不会忽大忽小`);
  ok(Math.abs(b.gm.h - a.gm.h) < 0.5, `game-main 高度恒定（${a.gm.h} vs ${b.gm.h}）→ fitCanvas 量到同一个行高`);
  ok(b.hitIsTile, `平时态手牌也可点`);

  console.log('== ③ 报杠 + 暗杠/自摸 同现（4 报杠 + 4 操作钮 = 8 钮，compact）==');
  const c = await measure({ nClaim: 4, nDeclare: 4, compact: true, nTiles: 10 });
  console.log(`  action-bar h=${c.bar.h} · claim-row h=${c.claim.h} · 钮数 ${c.nBtn} · 溢出 ${c.overflow}px`);
  ok(c.bar.h === BAR_H, `8 钮时操作带仍恒高 ${BAR_H}px（${c.bar.h}）`);
  ok(c.allInside && c.noWrap, `8 钮不折行且全在格子内（溢出 ${c.overflow}px）`);
  ok(c.claim.h <= BAR_H, `按钮行不溢出格子（${c.claim.h}）`);
  ok(c.hitIsTile, `手牌仍不被遮挡`);

  console.log('== ④ 7 钮 compact（响应窗口最坏：吃 3 组 + 碰/杠/胡 + 过）==');
  const d = await measure({ nClaim: 7, nDeclare: 0, compact: true, nTiles: 10 });
  ok(d.allInside && d.noWrap, `7 钮 compact 不折行且全在格子内（溢出 ${d.overflow}px）`);
  ok(d.claim.h <= BAR_H, `不溢出格子（${d.claim.h}）`);

  // 截图留证：回到「5 钮正常态」，并把 3:1 的虚拟画布换成纯色块，
  // 让截图能看出「操作带 / 手牌」两段的分界（画布本体在真机上是 canvas，探针里是占位）
  await measure({ nClaim: 5, nDeclare: 2, compact: false, nTiles: 13 });
  await page.evaluate(() => {
    const cv = document.getElementById('table');
    cv.style.background = 'linear-gradient(180deg,#14614a,#0d3d30)';
    cv.style.borderRadius = '4px';
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.locator('#board-overlay').screenshot({ path: path.resolve(__dirname, '../../.recover-tmp/claimrow.png') });

  console.log('== ⑤ 极端窄条（board-overlay 收到 320px，8 钮）—— 只许压缩、不许折行 ==');
  const e = await measure({ nClaim: 4, nDeclare: 4, compact: true, nTiles: 10 });
  await page.evaluate(() => { document.getElementById('board-overlay').style.width = '320px'; });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const narrow = await page.evaluate(() => {
    const cs = document.getElementById('controls');
    const btns = [...document.querySelectorAll('.ctrl')];
    const barBox = document.getElementById('action-bar').getBoundingClientRect();
    const allInside = btns.every((b) => {
      const r = b.getBoundingClientRect();
      return r.top >= barBox.top - 0.5 && r.bottom <= barBox.bottom + 0.5;
    });
    const noWrap = getComputedStyle(cs).flexWrap === 'nowrap';
    const overflow = +Math.max(0, ...btns.map((b) => {
      const r = b.getBoundingClientRect();
      return Math.max(barBox.top - r.top, r.bottom - barBox.bottom);
    })).toFixed(1);
    const box = document.getElementById('action-bar').getBoundingClientRect();
    // 溢出方向：多出的内容若向上（top < box.top）会被原生 canvas 盖住 → 按钮看不见
    const firstTop = btns[0].getBoundingClientRect().top;
    return {
      allInside, noWrap, overflow, firstTop: +firstTop.toFixed(1), boxTop: +box.top.toFixed(1),
      boxH: +box.height.toFixed(1), controlsW: +cs.getBoundingClientRect().width.toFixed(1),
      scrollW: cs.scrollWidth,
      minBtnW: Math.min(...btns.map((b) => b.getBoundingClientRect().width)),
    };
  });
  console.log(`  320px 条宽 → 溢出 ${narrow.overflow}px · 首钮 top=${narrow.firstTop} vs 格顶 ${narrow.boxTop}` +
    ` · 内容宽 ${narrow.scrollW} · 最窄钮 ${narrow.minBtnW.toFixed(1)}px`);
  ok(narrow.allInside && narrow.noWrap, `窄条下仍不折行、全在格子内（溢出 ${narrow.overflow}px）`);
  ok(narrow.firstTop >= narrow.boxTop - 0.5,
    `没有向上溢出（首钮 top ${narrow.firstTop} ≥ 格顶 ${narrow.boxTop}）→ 不会被 canvas 盖住`);
  ok(narrow.boxH === BAR_H, `格子仍恒高 ${BAR_H}px（${narrow.boxH}）`);

  console.log(`== ⑥ 结算相位（overPhase：整带隐藏，${BAR_H}px 还给画布）==`);
  const ov = await (async () => {
    await page.setContent(html({ nClaim: 0, nDeclare: 0, compact: false, nTiles: 10 }));
    // 模拟 wx:if="{{!overPhase}}" 的两种状态：隐藏 vs 显示
    const before = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return { bar: +r('action-bar').height.toFixed(1), overlay: +r('board-overlay').height.toFixed(1), gm: +r('game-main').height.toFixed(1) };
    });
    await page.evaluate(() => { document.getElementById('action-bar').style.display = 'none'; });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const after = await page.evaluate(() => {
      const r = (id) => document.getElementById(id).getBoundingClientRect();
      return { bar: +r('action-bar').height.toFixed(1), overlay: +r('board-overlay').height.toFixed(1), gm: +r('game-main').height.toFixed(1) };
    });
    return { before, after };
  })();
  console.log(`  平时：带 ${ov.before.bar}px · overlay ${ov.before.overlay}px · game-main ${ov.before.gm}px`);
  console.log(`  结算：带 ${ov.after.bar}px · overlay ${ov.after.overlay}px · game-main ${ov.after.gm}px`);
  ok(ov.after.bar === 0, `结算态操作带高度归零（${ov.after.bar}）`);
  ok(Math.abs(ov.after.gm - ov.before.gm - BAR_H) < 1,
    `结算态画布多拿 ${BAR_H}px（game-main ${ov.before.gm} → ${ov.after.gm}，差 ${(ov.after.gm - ov.before.gm).toFixed(1)}）`);

  console.log(`\n== 结果：${fails.length === 0 ? '全部通过' : fails.length + ' 项失败'} ==`);
  await browser.close();
  if (fails.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
