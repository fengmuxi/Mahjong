/**
 * 校验侧边轨（.rail）与微信胶囊的纵向关系 —— 2026-10-25 第五十二轮。
 *
 * 用户报「对局中时右侧的菜单栏会和顶部的小程序 ui 重叠」。
 * 根因：侧轨原来 `top:50% + translateY(-50%)` 在整块 .game-main 里垂直居中，
 * 而 `navigationStyle=custom` 下微信胶囊会伸进 game-main 顶部；手机横屏 game-main
 * 只有 215~230px、6 个钮的轨要 222px → 居中后轨顶被顶进胶囊（实测重叠 18~25.5px）。
 *
 * 修法：轨顶 = 胶囊实测下沿 + 6px（JS 下发 railTop），容器 bottom:2px，
 * 按钮在 .rail-inner 里 `margin:auto 0` 居中；装不下时 margin 归零、可滚动。
 *
 * 本探针用**真 game.wxss** 复刻结构，胶囊位置按 `wx.getMenuButtonBoundingClientRect()`
 * 的典型返回值模拟（iOS 横屏 / 安卓带状态栏两档），断言：
 *   ① 轨顶 ≥ 胶囊下沿 + 6；
 *   ② 轨底不越过 game-main 底（不压到状态行/手牌）；
 *   ③ 6 个按钮在常规手机横屏下**不需要滚动**（scrollHeight ≤ clientHeight）；
 *   ④ 单个按钮仍可点（elementFromPoint 命中自己）。
 */
const fs = require('fs');
const path = require('path');
const { loadPlaywright, chromiumExecutable } = require('./_pw.cjs');

const MP = path.resolve(__dirname, '../../packages/miniapp/miniprogram');
const RPX = 390 / 750;
const toCss = (raw) => raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(\d+(?:\.\d+)?)rpx/g, (_, n) => `${(Number(n) * RPX).toFixed(3)}px`)
  .replace(/^\s*page\s*\{[^}]*\}/gm, '');
const gameCss = toCss(fs.readFileSync(path.join(MP, 'pages/game/game.wxss'), 'utf8'));
const appCss = toCss(fs.readFileSync(path.join(MP, 'app.wxss'), 'utf8'));

// 与 game.js 的常量保持一致（探针直接读源码，避免第二份真相）
const jsSrc = fs.readFileSync(path.join(MP, 'pages/game/game.js'), 'utf8');
const RAIL_GAP_CAP = Number(jsSrc.match(/const RAIL_GAP_CAP = (\d+)/)[1]);
const RAIL_TOP_FALLBACK = Number(jsSrc.match(/const RAIL_TOP_FALLBACK = (\d+)/)[1]);

/** 侧轨按钮（与 WXML 同序；✕ 是房主专属，这里按最多 6 个算） */
const BTNS = ['💬<text class="rail-badge">3</text>', '🤖', '🎵', '🎯', '<span class="rail-exit">退出</span>', '✕'];

const html = ({ topSafe, railTop, railLeft }) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{font-family:sans-serif;}
view{display:block;}text{display:inline;}button,input,image{display:inline-block;}
.rail-exit{font-size:12px;}
.g-top{display:flex;align-items:center;height:28px;margin-bottom:2px;flex-shrink:0;min-width:0;}
.g-top-cap{width:118px;flex-shrink:0;}
.game-main{flex:1;min-height:0;display:flex;flex-direction:row;position:relative;z-index:1;}
.canvas-wrap{flex:1;min-width:0;min-height:0;display:flex;align-items:flex-end;justify-content:center;position:relative;}
.board-overlay{display:flex;flex-direction:column;align-items:center;flex-shrink:0;position:relative;z-index:1;}
${gameCss}
${appCss}
/* ⚠ 必须写在 gameCss 之后：否则 .game 的 padding-top（用到 --safe-t）会把它顶掉，
   探针就量不到「有状态栏」的布局。这里用 --safe-t 变量走真机制。 */
.game{padding-top:calc(4px + ${topSafe}px);height:100vh;display:flex;flex-direction:column;position:relative;}
</style></head><body>
<div class="game" id="game">
  <div class="felt" style="background:#14614a"></div>
  <div class="g-top" id="g-top"><view class="g-top-back">‹</view><view class="g-top-info"><text class="badge">赣州</text><text class="code">W4KACJ</text></view><view class="g-top-cap"></view></div>
  <div class="game-main" id="game-main">
    <div class="rail rail-l" id="rail-l" style="top:${railLeft}px;"><div class="rail-inner"><button class="rail-btn">📋</button></div></div>
    <div class="canvas-wrap" id="canvas-wrap"><canvas id="table" style="width:800px;height:400px;display:block"></canvas></div>
    <div class="rail rail-r" id="rail-r" style="top:${railTop}px;">
      <div class="rail-inner" id="rail-inner">${BTNS.map((t) => `<button class="rail-btn">${t}</button>`).join('')}</div>
    </div>
  </div>
  <div class="board-overlay" id="board-overlay" style="width:860px;margin:0 auto;">
    <div class="g-status"><text class="g-status-text">轮到你了 — 点击手牌打出</text></div>
    <div class="action-bar"><div class="claim-row" style="display:none"></div></div>
    <div class="tray-stack"><div class="hand-tray"><div class="tray-row" style="--tw:46px;--th:66px;--ml-drawn:8px;--fs-rank:25px;--fs-suit:12px;--fs-honor:27px">${Array.from({ length: 13 }, (_, i) => `<view class="tile-btn tone-w"><text class="tile-rank">${i + 1}</text></view>`).join('')}</div></div></div>
  </div>
</div></body></html>`;

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {});
  const fails = [];
  const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails.push(m); };

  /**
   * 场景：窗口尺寸 + 状态栏高（topSafe）+ 胶囊矩形（模拟 wx.getMenuButtonBoundingClientRect）
   * 胶囊典型值：高度 32；纵向 = 状态栏 + (导航栏 44 - 32)/2 ≈ 状态栏 + 6
   */
  const scenes = [
    { w: 844, h: 390, topSafe: 0, label: 'iPhone 13 横屏（iOS，无状态栏）' },
    { w: 667, h: 375, topSafe: 0, label: 'iPhone SE 横屏（iOS）' },
    { w: 844, h: 390, topSafe: 24, label: '安卓横屏（状态栏 24px）' },
    { w: 1206, h: 561, topSafe: 0, label: '用户截图 1206×561' },
  ];

  for (const sc of scenes) {
    const capTop = sc.topSafe + 6;
    const capBottom = capTop + 32;
    const page = await browser.newPage({ viewport: { width: sc.w, height: sc.h }, colorScheme: 'light' });

    // 第一遍：量 game-main 的 top，算出 JS 会下发的 railTop（= game.js 的算法）
    await page.setContent(html({ topSafe: sc.topSafe, railTop: RAIL_TOP_FALLBACK, railLeft: RAIL_TOP_FALLBACK }));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const gmTop = await page.evaluate(() => document.getElementById('game-main').getBoundingClientRect().top);
    const wantRailTop = Math.max(RAIL_GAP_CAP, Math.round(capBottom + RAIL_GAP_CAP - gmTop));

    // 第二遍：按算出的 railTop 重排
    await page.setContent(html({ topSafe: sc.topSafe, railTop: wantRailTop, railLeft: wantRailTop }));
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const m = await page.evaluate(() => {
      const rail = document.getElementById('rail-r');
      const rb = rail.getBoundingClientRect();
      const gm = document.getElementById('game-main').getBoundingClientRect();
      const inner = document.getElementById('rail-inner');
      const btns = [...inner.querySelectorAll('.rail-btn')];
      const first = btns[0].getBoundingClientRect();
      const hit = document.elementFromPoint(first.x + first.width / 2, first.y + first.height / 2);
      // 未读红点是外凸的（top/right:-2px），必须完整落在 .rail 的 padding box 内，
      // 否则会被 overflow 裁掉一条 —— 用 closest 找回红点（探针里手动塞一个）
      const badge = inner.querySelector('.rail-badge');
      const bb = badge ? badge.getBoundingClientRect() : null;
      const ir = rail.getBoundingClientRect();
      const cs = getComputedStyle(rail);
      // overflow 的裁切边界 = **padding box 的外缘**（= border box 去掉 border），
      // 不是 right - padding。这里 rail 无 border，所以边界就是 border box。
      const bw = { t: parseFloat(cs.borderTopWidth) || 0, r: parseFloat(cs.borderRightWidth) || 0,
                   b: parseFloat(cs.borderBottomWidth) || 0, l: parseFloat(cs.borderLeftWidth) || 0 };
      return {
        railTop: +rb.top.toFixed(1), railBottom: +rb.bottom.toFixed(1), railH: +rb.height.toFixed(1),
        gmTop: +gm.top.toFixed(1), gmBottom: +gm.bottom.toFixed(1),
        innerH: +inner.getBoundingClientRect().height.toFixed(1),
        scrollH: rail.scrollHeight, clientH: rail.clientHeight,
        btnH: +first.height.toFixed(1), n: btns.length,
        hitIsBtn: !!(hit && (hit === btns[0] || btns[0].contains(hit))),
        badgeInside: !bb ? null : (
          bb.top >= ir.top + bw.t - 0.5 && bb.bottom <= ir.bottom - bw.b + 0.5 &&
          bb.left >= ir.left + bw.l - 0.5 && bb.right <= ir.right - bw.r + 0.5
        ),
        badgeBox: bb ? { t: +bb.top.toFixed(1), r: +bb.right.toFixed(1) } : null,
      };
    });
    await page.close();

    // 截图留证（只拍最后一档 + 画一个模拟胶囊，证明两者不重叠）
    if (sc.label.includes('iPhone 13')) {
      const p2 = await browser.newPage({ viewport: { width: sc.w, height: sc.h }, deviceScaleFactor: 2, colorScheme: 'light' });
      await p2.setContent(html({ topSafe: sc.topSafe, railTop: wantRailTop, railLeft: wantRailTop })
        .replace('</body>', `<div style="position:fixed;right:8px;top:${capTop}px;width:96px;height:32px;border-radius:16px;
          border:1px solid rgba(255,255,255,.7);background:rgba(20,20,20,.72);display:flex;align-items:center;
          justify-content:space-evenly;font-size:15px;color:#fff;z-index:9999">⋯<span style="width:16px;height:16px;
          border-radius:50%;border:1.5px solid #fff;display:inline-block"></span></div></body>`));
      await p2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await p2.screenshot({ path: path.resolve(__dirname, '../../.recover-tmp/railtop.png'),
        clip: { x: sc.w - 140, y: 0, width: 140, height: 300 } });
      await p2.close();
    }

    console.log(`── ${sc.label}（${sc.w}×${sc.h}，胶囊 ${capTop}..${capBottom}）──`);
    console.log(`  game-main ${m.gmTop}..${m.gmBottom} · 轨 ${m.railTop}..${m.railBottom}（h=${m.railH}，内容 ${m.innerH}）` +
      ` · ${m.n} 钮 × ${m.btnH}px` + (m.scrollH > m.clientH ? ` · **需滚动 ${m.scrollH - m.clientH}px**` : ''));
    ok(m.railTop >= capBottom + RAIL_GAP_CAP - 0.5,
      `轨顶 ${m.railTop} ≥ 胶囊下沿+${RAIL_GAP_CAP} = ${capBottom + RAIL_GAP_CAP}（不压胶囊）`);
    ok(m.railBottom <= m.gmBottom + 0.5, `轨底 ${m.railBottom} ≤ game-main 底 ${m.gmBottom}（不压状态行）`);
    ok(m.scrollH <= m.clientH + 0.5, `不需滚动即可看全 ${m.n} 个钮（内容 ${m.innerH} ≤ 容器 ${m.railH}）`);
    ok(m.hitIsBtn, `第一个按钮可点（elementFromPoint 命中自己）`);
    ok(m.badgeInside !== false,
      `未读红点未被 overflow 裁切（badge ${JSON.stringify(m.badgeBox)}）`);
  }

  await browser.close();
  console.log(`\n== 结果：${fails.length === 0 ? '全部通过' : fails.length + ' 项失败'} ==`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
