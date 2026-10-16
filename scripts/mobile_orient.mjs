/**
 * 横竖屏适配专项验证（真机旋转无法在模拟器里复现，因此验证的是「能力探测 → 状态机 →
 * 布局不变量」这三层可测的部分，并显式记录真机才能确认的部分）。
 *
 * 用法：先起服务端，再 node scripts/mobile_orient.mjs [局域网IP]
 * 覆盖：
 *   T1 非安全上下文（局域网 HTTP）：点「自动横屏」必须**如实说明原因**且不进全屏
 *   T2 安全上下文（localhost）：点「自动横屏」应进入全屏；再点同一按钮应能退出并解锁
 *   T3 遮挡修复：body 的 min-height 必须为 0（不能是 100vh），且布局跟随实测可视高度变化
 *   T4 强制横屏：竖屏下逻辑旋转成横屏、铺满视口、无溢出、右上角有「退出」图标钮、
 *      且 HUD 里的同名按钮已让位
 *   T5 静态资源：manifest / 图标可访问且声明了 orientation: landscape
 */
import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium, devices } = require('playwright');

const PORT = Number(process.argv[3] || 3000);
const LAN = process.argv[2] || '192.168.31.63';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iphone = devices['iPhone 13'];
const ctxOf = (w, h) => ({ ...iphone, viewport: { width: w, height: h }, screen: { width: w, height: h } });

const results = {};
const browser = await chromium.launch();

async function openPage(ctx, url) {
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await p.goto(url, { waitUntil: 'load' });
  await p.waitForSelector('#bg-opts .bg-opt');
  await sleep(250);
  return { p, errors };
}

const snapshot = (p) =>
  p.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    const cs = getComputedStyle(body);
    const br = body.getBoundingClientRect();
    const app = document.querySelector('.app');
    const ar = app ? app.getBoundingClientRect() : null;
    const vv = window.visualViewport;
    const canvas = document.querySelector('#table');
    const tray = document.querySelector('#hand-tray');
    return {
      classes: html.className,
      isSecureContext: window.isSecureContext,
      fullscreenElement: document.fullscreenElement ? document.fullscreenElement.tagName : null,
      unlockCalls: window.__unlockCalls ?? null,
      bodyMinHeight: cs.minHeight,
      bodyHeight: +br.height.toFixed(1),
      bodyWidth: +br.width.toFixed(1),
      bodyLayoutSize: `${body.offsetWidth}x${body.offsetHeight}`,
      vv: vv ? { w: Math.round(vv.width), h: Math.round(vv.height) } : null,
      inner: { w: window.innerWidth, h: window.innerHeight },
      appRect: ar ? { y: +ar.y.toFixed(1), h: +ar.height.toFixed(1), w: +ar.width.toFixed(1) } : null,
      appBottom: ar ? +(ar.y + ar.height).toFixed(1) : null,
      noScrollX: html.scrollWidth <= html.clientWidth + 1,
      noScrollY: html.scrollHeight <= html.clientHeight + 1,
      // 注意：强制横屏时 body 有 transform，getBoundingClientRect() 返回的是**旋转后**
      // 的包围盒（宽高互换）。判断画布比例必须用未变换的 offsetWidth/offsetHeight。
      canvas: canvas
        ? {
            layout: `${canvas.offsetWidth}x${canvas.offsetHeight}`,
            ratio: +(canvas.offsetWidth / canvas.offsetHeight).toFixed(3),
            fitsWrap: (() => {
              const wr = document.querySelector('.canvas-wrap');
              return wr ? canvas.offsetWidth <= wr.clientWidth + 1 && canvas.offsetHeight <= wr.clientHeight + 1 : null;
            })(),
          }
        : null,
      tray: tray && !tray.classList.contains('hidden')
        ? { layout: `${tray.offsetWidth}x${tray.offsetHeight}`, tiles: tray.querySelectorAll('.tile-btn').length }
        : null,
      hintHidden: document.querySelector('#rotate-hint')?.classList.contains('hidden') ?? null,
      noteText: document.querySelector('#rotate-note')?.textContent ?? '',
      forceExitVisible: !!document.querySelector('#force-exit') && getComputedStyle(document.querySelector('#force-exit')).display !== 'none',
      orientBtnText: document.querySelector('#rotate-btn')?.textContent ?? null,
      orientBtnVisible: !!document.querySelector('#rotate-btn') && getComputedStyle(document.querySelector('#rotate-btn')).display !== 'none',
    };
  });

/* ---------- T1：非安全上下文（局域网 HTTP） ---------- */
{
  const ctx = await browser.newContext(ctxOf(390, 844));
  try {
    const { p, errors } = await openPage(ctx, `http://${LAN}:${PORT}`);
    const before = await snapshot(p);
    await p.click('#rotate-go');
    await sleep(700);
    const after = await snapshot(p);
    results.T1_insecureContext = {
      url: `http://${LAN}:${PORT}`,
      secure: before.isSecureContext,
      hintShown: before.hintHidden === false,
      fullscreenAfterClick: after.fullscreenElement,
      noteText: after.noteText,
      // 期望：不进全屏（浏览器禁止），但给出可执行的原因
      ok: before.isSecureContext === false && after.fullscreenElement === null && /HTTP|横握|强制横屏/.test(after.noteText),
      errors,
    };
  } catch (e) {
    results.T1_insecureContext = { error: String(e).split('\n')[0] };
  }
  await ctx.close();
}

/* ---------- T2：安全上下文 + Android（localhost）全屏进入 / 退出 ---------- */
{
  // 必须用 Android 设备描述符：iPhone UA 会让 isIOS() 为真，从而正确地判定
  // 「iOS 不支持方向锁定」并走强制横屏兜底 —— 那样就测不到全屏路径了。
  const pixel = devices['Pixel 7'];
  const ctx = await browser.newContext({ ...pixel, viewport: { width: 915, height: 412 }, screen: { width: 915, height: 412 } });
  const { p, errors } = await openPage(ctx, `http://localhost:${PORT}`);
  // 统计 unlock 调用（退出时必须解锁方向，否则 Android Chrome 会"卡"在横屏）
  await p.evaluate(() => {
    window.__unlockCalls = 0;
    const so = screen.orientation;
    if (so && typeof so.unlock === 'function') {
      const orig = so.unlock.bind(so);
      try {
        Object.defineProperty(so, 'unlock', { value: () => { window.__unlockCalls++; return orig(); }, configurable: true });
      } catch {}
    }
  });
  const btn0 = await snapshot(p);
  await p.evaluate(() => document.querySelector('#rotate-btn').click());
  await sleep(900);
  const entered = await snapshot(p);
  await p.evaluate(() => document.querySelector('#rotate-btn').click());
  await sleep(900);
  const left = await snapshot(p);
  results.T2_secureFullscreen = {
    secure: btn0.isSecureContext,
    btnLabelBefore: btn0.orientBtnText,
    fullscreenAfterEnter: entered.fullscreenElement,
    btnLabelWhenFullscreen: entered.orientBtnText,
    fullscreenAfterExit: left.fullscreenElement,
    unlockCallsOnExit: left.unlockCalls,
    ok:
      btn0.orientBtnText === '全屏横屏' &&
      entered.fullscreenElement !== null &&
      entered.orientBtnText === '退出全屏' &&
      left.fullscreenElement === null &&
      (left.unlockCalls ?? 0) > 0,
    errors,
  };
  await ctx.close();
}

/* ---------- T6：iOS 能力缺失（无全屏 / 无方向锁定）必须直接走可用的兜底 ----------
   注意：模拟器里的 Chromium 其实**支持**全屏 API，光用 iPhone 的 UA 测不出 iOS 的真实
   处境（实测：点「自动横屏」会真的进全屏）。必须显式剥掉全屏能力，才能复现现场。 */
{
  const ctx = await browser.newContext(ctxOf(390, 844));
  await ctx.addInitScript(() => {
    try {
      Object.defineProperty(document, 'fullscreenEnabled', { get: () => false, configurable: true });
      Object.defineProperty(document, 'webkitFullscreenEnabled', { get: () => false, configurable: true });
      delete Element.prototype.requestFullscreen;
      delete Element.prototype.webkitRequestFullscreen;
      Object.defineProperty(screen.orientation, 'lock', { get: () => undefined, configurable: true });
      Object.defineProperty(screen.orientation, 'unlock', { get: () => undefined, configurable: true });
    } catch (e) {}
  });
  const { p, errors } = await openPage(ctx, `http://localhost:${PORT}`);
  const before = await snapshot(p);
  await p.click('#rotate-go'); // 主按钮：能力缺失时应**不进全屏**并说明原因
  await sleep(500);
  const afterGo = await snapshot(p);
  await p.evaluate(() => document.querySelector('#rotate-btn').click());
  await sleep(300);
  const afterHudBtn = await snapshot(p);
  results.T6_iosFallback = {
    btnLabel: before.orientBtnText,
    fullscreenAfterAutoTry: afterGo.fullscreenElement,
    noteAfterAutoTry: afterGo.noteText,
    // 能力缺失时按钮直接给「强制横屏」，一点就能用，不给用户一个必然失败的全屏按钮
    classesAfterHudBtn: afterHudBtn.classes,
    hintHiddenAnyway: afterHudBtn.hintHidden,
    ok:
      before.orientBtnText === '强制横屏' &&
      afterGo.fullscreenElement === null &&
      /iPhone|Apple/.test(afterGo.noteText) &&
      afterHudBtn.classes.includes('force-landscape') &&
      afterHudBtn.hintHidden === true,
    errors,
  };
  await ctx.close();
}

/* ---------- T3：遮挡修复（布局必须跟随实测可视高度） ---------- */
{
  const ctx = await browser.newContext(ctxOf(844, 390));
  const { p, errors } = await openPage(ctx, `http://localhost:${PORT}`);
  const base = await snapshot(p);
  // 模拟「浏览器工具栏占掉 70px」：把实测可视高度改小（真机上由 visualViewport 自动更新）
  await p.evaluate(() => {
    document.documentElement.style.setProperty('--ld-h', '320px');
    document.documentElement.style.setProperty('--vv-h', '320px');
  });
  await sleep(120);
  const shrunk = await snapshot(p);
  await p.evaluate(() => {
    document.documentElement.style.removeProperty('--ld-h');
    document.documentElement.style.removeProperty('--vv-h');
  });
  await sleep(120);
  const restored = await snapshot(p);
  results.T3_occlusion = {
    // 旧实现把基础规则的 min-height:100vh 留在身上（= 大视口高度），会撑高 body 把底部
    // 顶到浏览器 UI 之下；修复后必须是 0
    bodyMinHeight: base.bodyMinHeight,
    bodyHeightEqualsVisual: Math.abs(base.bodyHeight - base.vv.h) <= 1,
    appBottomEqualsViewportBottom: base.appBottom === base.inner.h || base.appBottom === base.vv.h,
    noOverflow: base.noScrollX && base.noScrollY,
    // 可视高度变小后，布局必须跟着缩（而不是仍按 100vh 排 → 溢出被遮挡）
    followsVisualHeight: { base: base.bodyHeight, shrunk: shrunk.bodyHeight, restored: restored.bodyHeight },
    shrunkNoOverflow: shrunk.noScrollX && shrunk.noScrollY,
    shrunkAppBottom: shrunk.appBottom,
    ok:
      base.bodyMinHeight === '0px' &&
      Math.abs(base.bodyHeight - base.vv.h) <= 1 &&
      Math.abs(shrunk.bodyHeight - 320) <= 1 &&
      shrunk.noScrollX &&
      shrunk.noScrollY &&
      shrunk.appBottom === 320,
    errors,
  };
  await ctx.close();
}

/* ---------- T4：强制横屏（竖屏下 CSS 逻辑旋转） ---------- */
{
  const ctx = await browser.newContext(ctxOf(390, 844));
  const { p, errors } = await openPage(ctx, `http://localhost:${PORT}`);
  await p.click('#rotate-force');
  await sleep(300);
  const forced = await snapshot(p);
  // 让画布参与布局，检查横屏下的比例与不溢出
  const canvasInfo = await p.evaluate(() => {
    document.querySelector('#view-game').classList.remove('hidden');
    window.dispatchEvent(new Event('resize'));
    return null;
  });
  await sleep(400);
  const withGame = await snapshot(p);
  await p.evaluate(() => document.querySelector('#force-exit').click());
  await sleep(300);
  const restored = await snapshot(p);
  results.T4_forceLandscape = {
    landscapeClasses: forced.classes,
    // 旋转后：未变换的布局尺寸应为 横屏语义尺寸 844×390，变换后的包围盒应铺满 390×844
    bodyLayoutSize: forced.bodyLayoutSize,
    bodyBoundingBox: `${forced.bodyWidth}x${forced.bodyHeight}`,
    overflowWhenForced: { noX: forced.noScrollX, noY: forced.noScrollY },
    hintHiddenWhenForced: forced.hintHidden,
    forceExitVisible: forced.forceExitVisible,
    // 强制横屏下 HUD 里的同名按钮要让位给右上角的「退出」图标钮（避免两个重复入口）
    hudOrientBtnHiddenWhenForced: forced.orientBtnVisible === false,
    canvasInForced: withGame.canvas,
    // 点「退出横屏」图标钮可回到竖屏提示状态
    afterRestore: { classes: restored.classes, hintHidden: restored.hintHidden },
    ok:
      forced.bodyLayoutSize === '844x390' &&
      Math.abs(forced.bodyWidth - 390) <= 1 &&
      Math.abs(forced.bodyHeight - 844) <= 1 &&
      forced.noScrollX &&
      forced.noScrollY &&
      forced.hintHidden === true &&
      forced.forceExitVisible === true &&
      forced.orientBtnVisible === false &&
      withGame.canvas !== null &&
      withGame.canvas.fitsWrap === true &&
      Math.abs(withGame.canvas.ratio - 2) < 0.02 &&
      withGame.noScrollX &&
      withGame.noScrollY &&
      restored.hintHidden === false,
    errors,
  };
  await ctx.close();
}

/* ---------- T5：静态资源 ---------- */
{
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const out = { status: {}, manifest: null };
  for (const f of ['manifest.webmanifest', 'icon-192.png', 'icon-512.png']) {
    const r = await p.request.get(`http://localhost:${PORT}/${f}`);
    out.status[f] = r.status();
  }
  const mr = await p.request.get(`http://localhost:${PORT}/manifest.webmanifest`);
  if (mr.ok()) out.manifest = JSON.parse(await mr.text());
  out.ok = Object.values(out.status).every((s) => s === 200) && out.manifest?.orientation === 'landscape' && (out.manifest?.icons?.length ?? 0) >= 2;
  results.T5_assets = out;
  await ctx.close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
