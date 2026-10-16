/** 横竖屏相关状态的截图：竖屏遮罩（双按钮）/ 强制横屏（首页与对局） */
import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium, devices } = require('playwright');

const URL = process.env.MJ_URL || 'http://localhost:3100';
const OUT = 'E:/Temp/mj-mobile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iphone = devices['iPhone 13'];
const ctxOf = (w, h) => ({ ...iphone, viewport: { width: w, height: h }, screen: { width: w, height: h } });

const browser = await chromium.launch();

// 1) 竖屏遮罩（两个按钮：自动横屏 / 强制横屏显示）
{
  const ctx = await browser.newContext(ctxOf(390, 844));
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForSelector('#bg-opts .bg-opt');
  await sleep(400);
  await p.screenshot({ path: `${OUT}/y1-portrait-overlay.png` });
  // 2) 点「自动横屏」→ 局域网 HTTP 下应给出原因（而不是静默无反应）
  await p.click('#rotate-go');
  await sleep(600);
  await p.screenshot({ path: `${OUT}/y2-portrait-reason.png` });
  await ctx.close();
}

// 3) 强制横屏：首页
{
  const ctx = await browser.newContext(ctxOf(390, 844));
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForSelector('#bg-opts .bg-opt');
  await p.click('#rotate-force');
  await sleep(400);
  await p.screenshot({ path: `${OUT}/y3-forced-home.png` });
  // 4) 强制横屏 + 对局视图（确认牌桌/手牌条在旋转容器内布局正常）
  await p.evaluate(() => {
    document.querySelector('#view-home').classList.add('hidden');
    document.querySelector('#view-game').classList.remove('hidden');
    window.dispatchEvent(new Event('resize'));
  });
  await sleep(500);
  await p.screenshot({ path: `${OUT}/y4-forced-game.png` });
  const m = await p.evaluate(() => {
    const c = document.querySelector('#table');
    const t = document.querySelector('#hand-tray');
    const tb = t && !t.classList.contains('hidden') ? t.offsetHeight : null;
    return {
      canvas: `${c.offsetWidth}x${c.offsetHeight}`,
      ratio: +(c.offsetWidth / c.offsetHeight).toFixed(3),
      trayH: tb,
      forceExitShown: getComputedStyle(document.querySelector('#force-exit')).display !== 'none',
    };
  });
  console.log('forced-game:', JSON.stringify(m));
  await ctx.close();
}

// 5) 正常横屏（对照）：首页 + 对局
{
  const ctx = await browser.newContext(ctxOf(844, 390));
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForSelector('#bg-opts .bg-opt');
  await sleep(300);
  await p.screenshot({ path: `${OUT}/y5-landscape-home.png` });
  await ctx.close();
}

// 6) 强制横屏 + 真实对局：4 个客户端全部预置 force-landscape（预置脚本会立即生效），
//    走完整入房流程后截图 —— 这才是用户实际会看到的画面
{
  const mk = async () => {
    const c = await browser.newContext(ctxOf(390, 844));
    await c.addInitScript(() => {
      try {
        localStorage.setItem('mj-force-landscape', '1');
      } catch (e) {}
    });
    return { c, p: await c.newPage() };
  };
  const players = [];
  for (let i = 0; i < 4; i++) players.push(await mk());
  const [A, B, C, D] = players.map((x) => x.p);
  const ps = players.map((x) => x.p);
  await Promise.all(ps.map((p) => p.goto(URL, { waitUntil: 'load' })));
  await Promise.all(ps.map((p) => p.waitForSelector('#bg-opts .bg-opt')));

  await A.click('#mode-create');
  await A.click('#variant-next');
  await A.waitForSelector('#step-form:not(.hidden)');
  await A.fill('#name', '东家A');
  await A.click('#form-submit');
  await A.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
  await A.waitForFunction(() => (document.querySelector('#room-code')?.textContent ?? '').trim().length === 6);
  const code = (await A.textContent('#room-code')).trim();

  for (const [p, nm] of [[B, '南家B'], [C, '西家C'], [D, '北家D']]) {
    await p.click('#mode-join');
    await p.waitForSelector('#step-form:not(.hidden)');
    await sleep(60);
    for (let i = 0; i < 3; i++) {
      await p.fill('#code', code);
      if ((await p.inputValue('#code')) === code) break;
      await sleep(120);
    }
    await p.fill('#name', nm);
    await p.click('#form-submit');
    await p.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
  }
  // 首局定庄：四人各掷一次（并列自动重掷）；定庄完成前点准备也不会开局
  for (let r = 0; r < 8; r++) {
    if (await ps[0].evaluate(() => document.querySelector('#dealer-roll').classList.contains('hidden'))) break;
    for (const p of ps) {
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
  for (const p of ps) await p.click('#ready-btn');
  await A.waitForFunction(() => !document.querySelector('#view-game').classList.contains('hidden'));
  await sleep(900);
  await A.screenshot({ path: `${OUT}/y6-forced-real-game.png` });
  const m = await A.evaluate(() => {
    const c = document.querySelector('#table');
    const t = document.querySelector('#hand-tray');
    const cw = document.querySelector('.canvas-wrap');
    const vw = Math.round(window.visualViewport.width);
    const vh = Math.round(window.visualViewport.height);
    const rects = {};
    for (const [k, sel] of [['hud', '.game-hud'], ['canvas', '#table'], ['tray', '#hand-tray'], ['status', '#g-status'], ['controls', '#controls']]) {
      const el = document.querySelector(sel);
      if (!el || el.classList.contains('hidden')) continue;
      const r = el.getBoundingClientRect();
      rects[k] = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)].join(',');
    }
    // 旋转容器内：矩形与视口是否相交（越界即被裁）
    const outside = Object.entries(rects).filter(([, v]) => {
      const [l, t, w, h] = v.split(',').map(Number);
      return l < -1 || t < -1 || l + w > vw + 1 || t + h > vh + 1;
    }).map(([k]) => k);
    return {
      cls: document.documentElement.className,
      canvas: `${c.offsetWidth}x${c.offsetHeight}`,
      canvasWrap: `${cw.clientWidth}x${cw.clientHeight}`,
      trayTiles: t ? t.querySelectorAll('.tile-btn').length : 0,
      trayLayout: t ? `${t.offsetWidth}x${t.offsetHeight}` : null,
      rects,
      outsideKeys: outside,
      htmlOverflow: document.documentElement.scrollHeight > document.documentElement.clientHeight + 2,
    };
  });
  console.log('forced-real-game:', JSON.stringify(m));
  for (const x of players) await x.c.close();
}

console.log('screenshots written to', OUT);
await browser.close();
