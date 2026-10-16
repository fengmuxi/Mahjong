/**
 * 方向/全屏能力诊断：对比「安全上下文（localhost）」与「非安全上下文（局域网 IP）」下
 * 全屏 API 与 screen.orientation.lock 的可用性 —— 定位"点全屏不旋转"的成因。
 * 用法：node scripts/orient_diag.mjs [LAN_IP]
 */
import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium, devices } = require('playwright');

const PORT = 3000;
const lanIp = process.argv[2] || '192.168.31.63';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iphone = devices['iPhone 13'];
const land = { ...iphone, viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 } };

const probe = async (page) =>
  page.evaluate(async () => {
    const out = {
      origin: location.origin,
      isSecureContext: window.isSecureContext,
      fullscreenEnabled: document.fullscreenEnabled,
      webkitFullscreenEnabled: document.webkitFullscreenEnabled,
      hasRequestFullscreen: typeof document.documentElement.requestFullscreen,
      hasWebkitRequestFullscreen: typeof document.documentElement.webkitRequestFullscreen,
      hasOrientationLock: typeof screen.orientation?.lock,
      orientationType: screen.orientation?.type,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      vvW: window.visualViewport ? Math.round(window.visualViewport.width) : null,
      vvH: window.visualViewport ? Math.round(window.visualViewport.height) : null,
      mq_orientation_landscape: matchMedia('(orientation: landscape)').matches,
      mq_maxH560: matchMedia('(max-height: 560px)').matches,
      // 100vh 与实际可视高度是否一致（不一致 = 底部会被浏览器 UI 遮住）
      vh100: (() => {
        const d = document.createElement('div');
        d.style.cssText = 'position:absolute;height:100vh;width:0';
        document.body.appendChild(d);
        const h = d.getBoundingClientRect().height;
        d.remove();
        return Math.round(h);
      })(),
      dvh100: (() => {
        const d = document.createElement('div');
        d.style.cssText = 'position:absolute;height:100dvh;width:0';
        document.body.appendChild(d);
        const h = d.getBoundingClientRect().height;
        d.remove();
        return Math.round(h);
      })(),
      clientH: document.documentElement.clientHeight,
    };
    // 实测：请求全屏
    try {
      const fn = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
      if (typeof fn !== 'function') out.enterFullscreen = 'method-missing';
      else {
        await fn.call(document.documentElement, { navigationUI: 'hide' });
        out.enterFullscreen = 'ok';
      }
    } catch (e) {
      out.enterFullscreen = `REJECTED: ${e && e.name ? e.name : ''} ${e && e.message ? e.message : String(e)}`.slice(0, 120);
    }
    out.fullscreenElementAfter = document.fullscreenElement ? document.fullscreenElement.tagName : null;
    // 实测：锁定横屏
    try {
      const lock = screen.orientation?.lock;
      if (typeof lock !== 'function') out.orientationLock = 'method-missing';
      else {
        await lock.call(screen.orientation, 'landscape');
        out.orientationLock = 'ok';
      }
    } catch (e) {
      out.orientationLock = `REJECTED: ${e && e.name ? e.name : ''} ${e && e.message ? e.message : String(e)}`.slice(0, 120);
    }
    out.orientationTypeAfter = screen.orientation?.type;
    return out;
  });

const browser = await chromium.launch();
for (const [label, base] of [
  ['安全上下文 localhost', `http://localhost:${PORT}`],
  [`非安全上下文 局域网 ${lanIp}`, `http://${lanIp}:${PORT}`],
]) {
  const ctx = await browser.newContext(land);
  const page = await ctx.newPage();
  try {
    await page.goto(base, { waitUntil: 'load', timeout: 8000 });
    await page.waitForSelector('#bg-opts .bg-opt', { timeout: 8000 });
    await sleep(300);
    console.log('=====', label, '=====');
    console.log(JSON.stringify(await probe(page), null, 2));
  } catch (e) {
    console.log('=====', label, '=====');
    console.log('访问失败：', String(e).split('\n')[0]);
  }
  await ctx.close();
}
await browser.close();
