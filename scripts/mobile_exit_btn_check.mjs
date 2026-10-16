/**
 * 强制横屏（CSS 逻辑旋转）下「退出横屏」入口的空间占用与遮挡核查。
 *
 * 背景：该状态整页被逻辑旋转 90°，浏览器截图拿到的是「物理竖屏」帧缓冲，
 *       所以原始截图是躺倒的。脚本额外产出一份 **未旋转预览**：把视口换成等价的
 *       横屏尺寸并摘掉 force-landscape 类（逻辑几何完全一致，只是不再旋转），
 *       方便人眼核对布局。
 *
 * 逻辑坐标换算：逻辑x = 物理rect.top；逻辑y = 物理视口宽 −(物理rect.left+宽)；宽高互换。
 * 查的是「浮动退出按钮有没有压住别人」，所以用同一坐标系里的矩形算重叠面积。
 *
 * 用法：node scripts/mobile_exit_btn_check.mjs [端口]
 */
import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium, devices } = require('playwright');

const PORT = process.argv[2] || process.env.MJ_PORT || '3100';
const URL = process.env.MJ_URL || `http://localhost:${PORT}`;
const OUT = process.env.MJ_OUT || 'E:/Temp/mj-mobile';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iphone = devices['iPhone 13'];

// 横屏宽 ≥820 走 land-wide、<720 走 land-narrow —— 两类各验一遍
const SIZES = [
  ['wide', 390, 844], // → 逻辑 844×390
  ['narrow', 375, 667], // → 逻辑 667×375
];

const browser = await chromium.launch();

async function forcedCtx(pw, ph) {
  const c = await browser.newContext({ ...iphone, viewport: { width: pw, height: ph }, screen: { width: pw, height: ph } });
  await c.addInitScript(() => {
    try {
      localStorage.setItem('mj-force-landscape', '1');
    } catch {}
  });
  const p = await c.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { c, p, errors };
}

/** 量逻辑横屏坐标下各元素，并算出浮动退出按钮压住了谁 */
const measure = (p) =>
  p.evaluate(() => {
    const PW = window.innerWidth; // 物理（竖屏）视口宽
    const pick = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const shown = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0;
      return {
        sel,
        shown,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 12),
        css: `${Math.round(el.offsetWidth)}x${Math.round(el.offsetHeight)}`,
        padding: cs.padding,
        rect: [r.left, r.top, r.width, r.height].map((v) => Math.round(v)),
        logical: [Math.round(r.top), Math.round(PW - (r.left + r.width)), Math.round(r.height), Math.round(r.width)],
      };
    };
    const overlap = (a, b) => {
      if (!a || !b || !a.shown || !b.shown) return 0;
      const [ax, ay, aw, ah] = a.rect;
      const [bx, by, bw, bh] = b.rect;
      const w = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx));
      const h = Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by));
      return Math.round(w * h);
    };
    const ex = pick('#force-exit');
    // 可点元素：被浮动按钮压住 = 用户点不到 → 必须为空
    const interactive = [
      '.mode-card', '#share-btn', '#ready-btn', '#leave-btn', '#dissolve-btn', '.seat',
      '#bg-opts .bg-opt', '#rotate-btn', '#dissolve-game-btn', '#table', '#hand-tray', '.chat', '#chat-min',
    ];
    // 非可点的容器：浮动按钮落在它们**预留的空槽**（padding）里属设计内，只作信息
    const containers = ['.home-card', '.table-head', '.game-hud'];
    const hitOf = (sel) => {
      const t = pick(sel);
      return t && t.shown && overlap(ex, t) > 0
        ? { sel, text: t.text, area: overlap(ex, t), logical: t.logical }
        : null;
    };
    const hits = interactive.map(hitOf).filter(Boolean);
    const containerHits = containers.map(hitOf).filter(Boolean);
    return {
      cls: document.documentElement.className.split(' ').filter((x) => /force|mobile|land|touch/.test(x)).join(' '),
      forceExit: ex,
      rotateBtn: pick('#rotate-btn'),
      head: pick('.head-right'),
      shareBtn: pick('#share-btn'),
      hud: pick('.game-hud'),
      exitAreaPx: ex && ex.shown ? ex.rect[2] * ex.rect[3] : 0,
      exitHits: hits,
      exitContainerHits: containerHits,
      coveredTotal: hits.reduce((s, h) => s + h.area, 0),
      tapTargetOk: !!ex && ex.shown && Math.min(ex.rect[2], ex.rect[3]) >= 40,
      blocksNothing: hits.length === 0,
      ariaLabel: document.querySelector('#force-exit')?.getAttribute('aria-label') || '',
      title: document.querySelector('#force-exit')?.getAttribute('title') || '',
    };
  });

/** 未旋转预览：**保留 force-landscape 类**（所有该状态下的规则都还在），只把旋转本身
 *  用一段临时样式抵消掉。
 *  ⚠ 不能自己 dispatch resize，也不能摘掉 force-landscape —— 前者会触发 scheduleSync()
 *    让 sync() 按 JS 变量把类加回来，后者会把「HUD/头部预留空槽」这类
 *    `html.force-landscape …` 作用域的规则一起丢掉，预览就假了。 */
async function previewShot(p, w, h, file) {
  await p.setViewportSize({ width: w, height: h });
  await sleep(400);
  await p.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'mj-preview-unrotate';
    s.textContent = 'html.force-landscape body{transform:none !important;width:100vw !important;height:100vh !important;}';
    document.head.append(s);
  });
  await sleep(300);
  const state = await p.evaluate(() => ({
    forced: document.documentElement.classList.contains('force-landscape'),
    bodyTransform: getComputedStyle(document.body).transform,
    exitShown: getComputedStyle(document.querySelector('#force-exit')).display !== 'none',
  }));
  await p.screenshot({ path: file });
  // 右上角放大图：设备 DPR=3，所以这张 330×130 的裁剪会输出约 990×390，便于肉眼看间隙
  await p.screenshot({ path: file.replace(/\.png$/, '-corner.png'), clip: { x: Math.max(0, w - 330), y: 0, width: 330, height: 130 } });
  // 还原：去掉临时样式、回到物理竖屏
  await p.evaluate(() => document.getElementById('mj-preview-unrotate')?.remove());
  await p.setViewportSize({ width: h, height: w });
  await sleep(300);
  return { unrotated: state.bodyTransform === 'none' && state.forced === true, bodyTransform: state.bodyTransform, exitShownInPreview: state.exitShown };
}

const results = {};

for (const [tag, pw, ph] of SIZES) {
  const out = {};

  // ---------- 首页 ----------
  {
    const { c, p, errors } = await forcedCtx(pw, ph);
    await p.goto(URL, { waitUntil: 'load' });
    await p.waitForSelector('#bg-opts .bg-opt');
    await sleep(350);
    out.home = await measure(p);
    out.home.errors = errors;
    await p.screenshot({ path: `${OUT}/z-home-${tag}-raw.png` });
    out.home.preview = await previewShot(p, ph, pw, `${OUT}/z-home-${tag}-preview.png`);
    await c.close();
  }

  // ---------- 大厅 + 对局（真实四人开局） ----------
  {
    const players = [];
    for (let i = 0; i < 4; i++) players.push(await forcedCtx(pw, ph));
    const ps = players.map((x) => x.p);
    const errors = [];
    ps.forEach((p, i) => {
      p.on('pageerror', (e) => errors.push(`p${i}: ${String(e).split('\n')[0]}`));
      p.on('console', (m) => m.type() === 'error' && errors.push(`p${i}: ${m.text()}`));
    });
    await Promise.all(ps.map((p) => p.goto(URL, { waitUntil: 'load' })));
    await Promise.all(ps.map((p) => p.waitForSelector('#bg-opts .bg-opt')));
    const [A, B, C, D] = ps;

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
    await sleep(300);
    out.lobby = await measure(A);
    out.lobby.code = code;
    out.lobby.errors = errors.slice();
    await A.screenshot({ path: `${OUT}/z-lobby-${tag}-raw.png` });
    out.lobby.preview = await previewShot(A, ph, pw, `${OUT}/z-lobby-${tag}-preview.png`);

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
    await sleep(800);
    out.game = await measure(A);
    out.game.errors = errors.slice();
    await A.screenshot({ path: `${OUT}/z-game-${tag}-raw.png` });
    out.game.preview = await previewShot(A, ph, pw, `${OUT}/z-game-${tag}-preview.png`);

    // ---------- 功能核查：点「退出」图标 ----------
    // Playwright 的 click 会检查元素是否被遮挡/可见 —— 顺便当「没被压住」的断言
    const beforeClick = await A.evaluate(() => ({
      forced: document.documentElement.classList.contains('force-landscape'),
      exitShown: getComputedStyle(document.querySelector('#force-exit')).display !== 'none',
    }));
    let clickErr = '';
    try {
      await A.click('#force-exit', { timeout: 4000 });
    } catch (e) {
      clickErr = String(e).split('\n')[0];
    }
    await sleep(450);
    const afterClick = await A.evaluate(() => ({
      forced: document.documentElement.classList.contains('force-landscape'),
      stored: localStorage.getItem('mj-force-landscape'),
      exitShown: getComputedStyle(document.querySelector('#force-exit')).display !== 'none',
      hintShown: !document.querySelector('#rotate-hint').classList.contains('hidden'),
      hudRotateShown: getComputedStyle(document.querySelector('#rotate-btn')).display !== 'none',
    }));
    out.exitAction = {
      beforeClick,
      afterClick,
      clicked: clickErr === '',
      clickErr,
      exitsForced: beforeClick.forced === true && afterClick.forced === false && afterClick.stored === '0',
      entryHidesItself: afterClick.exitShown === false,
      hintComesBack: afterClick.hintShown === true,
      errors,
    };
    await A.screenshot({ path: `${OUT}/z-after-exit-${tag}.png` });
    for (const x of players) await x.c.close();
  }

  results[tag] = out;
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
