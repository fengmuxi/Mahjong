/**
 * 移动端适配验证：多视口截图 + 布局度量。
 * 用法：先起服务端（MAHJONG_CEREMONY=0 MAHJONG_FIXED_SEATS=1 npm run start），再 node scripts/mobile_shot.mjs
 */
import { createRequire } from 'module';
import fs from 'node:fs';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium, devices } = require('playwright');

const URL = process.env.MJ_URL || 'http://localhost:3000';
const OUT = 'E:/Temp/mj-mobile';
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等应用真正可交互：`#mode-create` 是静态 HTML，页面一解析就存在，
 *  但 vite 的模块脚本 defer 执行 —— 此时监听器可能尚未绑定，点击会被静默吞掉。
 *  `#bg-opts .bg-opt` 由脚本注入，出现即代表应用已就绪。 */
const waitReady = (p) => p.waitForSelector('#bg-opts .bg-opt');
/** 房号由 renderLobby 写入，必须等它落地再取值 */
const waitRoomCode = (p) =>
  p.waitForFunction(() => (document.querySelector('#room-code')?.textContent ?? '').trim().length === 6);

async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(URL);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('server not up');
}

const iphone = devices['iPhone 13']; // 390x844 @3x, isMobile, hasTouch
/** 横屏模拟：viewport 与 screen 必须同步交换，否则设备宽度与视口不一致（会读出假的布局宽度） */
const landCtx = (w, h, dsf) => ({
  ...iphone,
  viewport: { width: w, height: h },
  screen: { width: w, height: h },
  deviceScaleFactor: dsf ?? iphone.deviceScaleFactor,
});

const CONFIGS = [
  { name: '1-portrait-390x844', ctx: { ...iphone, screen: { width: 390, height: 844 } }, portrait: true },
  { name: '2-landscape-iphone13-844x390', ctx: landCtx(844, 390), portrait: false },
  { name: '3-landscape-small-667x375', ctx: landCtx(667, 375, 2), portrait: false },
  { name: '4-landscape-wide-932x430', ctx: landCtx(932, 430), portrait: false },
  { name: '5-desktop-1280x800', ctx: { viewport: { width: 1280, height: 800 } }, portrait: false },
];

async function drive(page, name) {
  await waitReady(page);
  await page.click('#mode-create');
  await page.click('#variant-next');
  await page.waitForSelector('#step-form:not(.hidden)');
  await page.fill('#name', name);
  await page.click('#form-submit');
  await page.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
  await waitRoomCode(page);
  return (await page.textContent('#room-code')).trim();
}

async function join(page, code, name) {
  await waitReady(page);
  await page.click('#mode-join');
  await page.waitForSelector('#step-form:not(.hidden)');
  // goStep('form') 会在 +30ms 里 focus 输入框，与 Playwright 的 fill 抢焦点时偶发把值抹掉
  // （症状：提交时报「房间码为 6 位」→ 入房失败）。等稳定 + 断言，值不对就重填。
  await sleep(60);
  for (let i = 0; i < 3; i++) {
    await page.fill('#code', code);
    if ((await page.inputValue('#code')) === code) break;
    await sleep(120);
  }
  if ((await page.inputValue('#code')) !== code) throw new Error(`房间码填入失败：期望 ${code}`);
  await page.fill('#name', name);
  await page.click('#form-submit');
  await page.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
}

const measure = async (page) => {
  return page.evaluate(() => {
    const de = document.documentElement;
    const r = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: +b.x.toFixed(1), y: +b.y.toFixed(1), w: +b.width.toFixed(1), h: +b.height.toFixed(1) };
    };
    const canvas = document.querySelector('#table');
    const wrap = document.querySelector('.canvas-wrap');
    const tile = document.querySelector('#hand-tray .tile-btn');
    const tray = document.querySelector('#hand-tray');
    const ctrlBtn = document.querySelector('#controls button') || document.querySelector('#ready-btn');
    const hint = document.querySelector('#rotate-hint');
    const cr = r(canvas);
    return {
      docScrollW: de.scrollWidth,
      docClientW: de.clientWidth,
      docScrollH: de.scrollHeight,
      docClientH: de.clientHeight,
      noXScroll: de.scrollWidth <= de.clientWidth + 1,
      noYScroll: de.scrollHeight <= de.clientHeight + 1,
      canvas: cr,
      canvasRatio: cr ? +(cr.w / cr.h).toFixed(3) : null,
      canvasBacking: canvas ? `${canvas.width}x${canvas.height}` : null,
      wrap: r(wrap),
      canvasFitsWrap: cr && wrap ? cr.w <= wrap.getBoundingClientRect().width + 1 && cr.h <= wrap.getBoundingClientRect().height + 1 : null,
      /* 手牌条是否压住画布（应为 0：它已改为独立占位）。
         注意：托盘隐藏时其 rect 全是 0，直接相减会得到一个无意义的大数（如 663），
         必须在「可见」时才计算，否则会误导排查。 */
      trayOverlapsCanvas:
        cr && tray && !tray.classList.contains('hidden') && getComputedStyle(tray).display !== 'none'
          ? +Math.max(0, cr.y + cr.h - r(tray).y).toFixed(1)
          : 0,
      innerW: window.innerWidth,
      visualW: window.visualViewport ? +window.visualViewport.width.toFixed(1) : null,
      screenW: window.screen.width,
      /* 谁把布局视口撑宽了？（列出宽于布局视口的元素） */
      overflowers: Array.from(document.querySelectorAll('body *'))
        .filter((el) => el.getBoundingClientRect().width > de.clientWidth + 1)
        .slice(0, 6)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}:${Math.round(el.getBoundingClientRect().width)}`),
      trayVisible: !!tray && !tray.classList.contains('hidden') && getComputedStyle(tray).display !== 'none',
      trayTiles: document.querySelectorAll('#hand-tray .tile-btn').length,
      tile: r(tile),
      trayRect: r(tray),
      trayHint: document.querySelector('#hand-tray-hint')?.textContent ?? null,
      controlsButtons: document.querySelectorAll('#controls button').length,
      ctrlBtn: r(ctrlBtn),
      hintVisible: !!hint && !hint.classList.contains('hidden'),
      htmlClass: de.className,
      isTouchCss: matchMedia('(pointer: coarse)').matches,
      hasTouchPoints: navigator.maxTouchPoints,
      dpr: window.devicePixelRatio,
    };
  });
};

const browser = await chromium.launch();
await waitServer();
const report = {};
const flush = () => fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

for (const cfg of CONFIGS) {
  const tag = cfg.name;
  try {
    const errors = [];
    // 每个玩家独立 context：真实玩家是不同设备（独立 localStorage）。
    // 4 个标签页共用同一 context 会共享 localStorage → token 互相串，join 随机失败。
    const contexts = [];
    const pages = [];
    for (let i = 0; i < 4; i++) {
      const c = await browser.newContext(cfg.ctx);
      contexts.push(c);
      const p = await c.newPage();
      p.on('pageerror', (e) => errors.push(`${tag} p${i}: ${String(e)}`));
      p.on('console', (m) => {
        if (m.type() === 'error') errors.push(`${tag} p${i} console: ${m.text()}`);
      });
      pages.push(p);
    }
    const closeAll = async () => {
      for (const c of contexts) await c.close();
    };
    const A = pages[0];
    await A.goto(URL, { waitUntil: 'load' });

    if (cfg.portrait) {
      await waitReady(A);
      await sleep(400);
      const m = await measure(A);
      await A.screenshot({ path: `${OUT}/${tag}-portrait-hint.png` });
      report[tag] = { mode: 'portrait', hintVisible: m.hintVisible, htmlClass: m.htmlClass, errors };
      flush();
      await closeAll();
      continue;
    }

    const [B, C, D] = pages.slice(1);
    await Promise.all([B.goto(URL, { waitUntil: 'load' }), C.goto(URL, { waitUntil: 'load' }), D.goto(URL, { waitUntil: 'load' })]);

    const code = await drive(A, '东家A');
    await Promise.all([join(B, code, '南家B'), join(C, code, '西家C'), join(D, code, '北家D')]);
    await sleep(300);
    await A.screenshot({ path: `${OUT}/${tag}-lobby.png` });
    const lobbyMetrics = await measure(A);

    // 首局定庄：四人各掷一次（并列自动重掷）；定庄完成前点准备也不会开局
    for (let r = 0; r < 8; r++) {
      if (await pages[0].evaluate(() => document.querySelector('#dealer-roll').classList.contains('hidden'))) break;
      for (const p of pages) {
        const canRoll = await p.evaluate(() => {
          const b = document.querySelector('#dr-btn');
          const box = document.querySelector('#dealer-roll');
          return !!b && !!box && !box.classList.contains('hidden') && !b.disabled;
        });
        if (canRoll) await p.click('#dr-btn');
        await sleep(120);
      }
      await sleep(250);
    }
    for (const p of pages) await p.click('#ready-btn');
    await A.waitForFunction(() => !document.querySelector('#view-game').classList.contains('hidden'), null, { timeout: 12000 });
    await sleep(700);

    const m = await measure(A);
    await A.screenshot({ path: `${OUT}/${tag}-game.png` });
    if (m.trayVisible) await A.locator('#hand-tray').screenshot({ path: `${OUT}/${tag}-tray.png` });

    report[tag] = {
      mode: 'landscape/desktop',
      code,
      lobby: { innerW: lobbyMetrics.innerW, noXScroll: lobbyMetrics.noXScroll, noYScroll: lobbyMetrics.noYScroll },
      game: m,
      errors,
    };
    await closeAll();
  } catch (e) {
    report[tag] = { mode: 'FAILED', error: String(e).split('\n')[0] };
  }
  flush();
}

console.log(JSON.stringify(report, null, 2));
await browser.close();

