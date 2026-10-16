/**
 * 裁剪 / 越界审计（适配改动的客观验证）
 * ---------------------------------------------------------------------------
 * 判据分两档，避免"超出视口 = 失败"这种误判（内容比屏幕高时本就该滚动）：
 *   A. 标准视口（真实手机/桌面尺寸）→ **严格**：关键布局容器不得溢出（一屏装下，
 *      无需滚动），且所有关键元素完整落在可视区内。
 *   B. 极端视口（极矮/极窄）→ **可达**：允许滚动，但关键元素必须"滚得到"
 *      （不能落在 overflow:hidden 的裁切区里，也不能因 flex 居中而挤到容器外滚不回来）。
 * 用法：先起服务端，再 node scripts/mobile_clip_check.mjs [端口]
 */
import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium, devices } = require('playwright');

const URL = process.env.MJ_URL || `http://localhost:${Number(process.argv[2] || 3100)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iphone = devices['iPhone 13'];
const phoneCtx = (w, h) => ({ ...iphone, viewport: { width: w, height: h }, screen: { width: w, height: h } });

const HOME_KEYS = ['#steps', '.home-card', '#bg-opts', '#mode-create', '#mode-join', '.hint'];
const GAME_KEYS = ['.game-hud', '#table', '#hand-tray', '#g-status', '#controls'];
/** 关键布局容器：这些溢出就意味着"一屏装不下"（除非在极端视口下） */
const CRITICAL = ['html', 'body', '.app', '#view-home', '#view-table', '#view-game', '.canvas-wrap', '#controls'];

const audit = (page, keys) =>
  page.evaluate(
    ({ keys, critical }) => {
      const de = document.documentElement;
      const vw = Math.round(window.visualViewport ? window.visualViewport.width : innerWidth);
      const vh = Math.round(window.visualViewport ? window.visualViewport.height : innerHeight);
      const vis = (el) => el && !el.classList.contains('hidden') && getComputedStyle(el).display !== 'none';

      /** 是否可通过滚动看到（逐级向上找可滚动祖先；滚动容器或页面本身可滚即可达） */
      const reachable = (el) => {
        let p = el.parentElement;
        while (p && p !== de) {
          const cs = getComputedStyle(p);
          if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 2) return true;
          if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 2) return true;
          p = p.parentElement;
        }
        return de.scrollHeight > de.clientHeight + 2 || de.scrollWidth > de.clientWidth + 2;
      };

      const keysOut = [];
      const keysUnreachable = [];
      for (const sel of keys) {
        const el = document.querySelector(sel);
        if (!vis(el)) continue;
        const r = el.getBoundingClientRect();
        const outside = [];
        if (r.left < -1) outside.push('左');
        if (r.top < -1) outside.push('上');
        if (r.right > vw + 1) outside.push('右');
        if (r.bottom > vh + 1) outside.push('下');
        if (!outside.length) continue;
        keysOut.push(`${sel}(${outside.join('')})`);
        if (!reachable(el)) keysUnreachable.push(`${sel}(${outside.join('')})`);
      }

      // 关键容器溢出
      const overflow = [];
      for (const sel of critical) {
        const el = document.querySelector(sel);
        if (!el) continue;
        if (el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2) {
          overflow.push(`${sel} ${el.clientWidth}x${el.clientHeight}→内容 ${el.scrollWidth}x${el.scrollHeight}`);
        }
      }
      return { vw, vh, cls: de.className, keysOut, keysUnreachable, overflow };
    },
    { keys, critical: CRITICAL },
  );

const showGame = (page) =>
  page.evaluate(() => {
    for (const s of ['#view-home', '#view-table']) document.querySelector(s)?.classList.add('hidden');
    document.querySelector('#view-game')?.classList.remove('hidden');
    window.dispatchEvent(new Event('resize'));
  });

const STANDARD = [
  ['竖屏 390x844', phoneCtx(390, 844), false],
  ['强制横屏 390x844', phoneCtx(390, 844), true],
  ['竖屏 360x780', phoneCtx(360, 780), false],
  ['强制横屏 360x780', phoneCtx(360, 780), true],
  ['横屏 667x375', phoneCtx(667, 375), false],
  ['横屏 844x390', phoneCtx(844, 390), false],
  ['横屏 844x330（工具栏可见）', phoneCtx(844, 330), false],
  ['横屏 667x330（工具栏可见）', phoneCtx(667, 330), false],
  ['强制横屏 330x844', phoneCtx(330, 844), true],
  ['横屏 932x430', phoneCtx(932, 430), false],
  ['横屏 1024x600', phoneCtx(1024, 600), false],
  ['横屏 1280x720', phoneCtx(1280, 720), false],
  ['桌面 1280x800', { viewport: { width: 1280, height: 800 } }, false],
  ['桌面 1440x720', { viewport: { width: 1440, height: 720 } }, false],
  ['桌面 1920x1080', { viewport: { width: 1920, height: 1080 } }, false],
  ['桌面 900x500', { viewport: { width: 900, height: 500 } }, false],
];
const EXTREME = [
  ['极矮横屏 844x300', phoneCtx(844, 300), false],
  ['极矮强制横屏 300x844', phoneCtx(300, 844), true],
  ['超窄竖屏 280x760', phoneCtx(280, 760), true],
  ['超宽横屏 1600x420', phoneCtx(1600, 420), false],
];

const browser = await chromium.launch();
let bad = 0;

async function run(list, strict) {
  for (const [name, ctxOpts, force] of list) {
    const ctx = await browser.newContext(ctxOpts);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    try {
      await page.goto(URL, { waitUntil: 'load' });
      await page.waitForSelector('#bg-opts .bg-opt');
      if (force) await page.evaluate(() => document.querySelector('#rotate-force')?.click());
      await sleep(350);
      const home = await audit(page, HOME_KEYS);
      await showGame(page);
      await sleep(450);
      const game = await audit(page, GAME_KEYS);

      const issues = [];
      for (const [tag, a] of [['首页', home], ['对局', game]]) {
        if (a.keysUnreachable.length) issues.push(`${tag}关键元素不可达 ${a.keysUnreachable.join(', ')}`);
        else if (a.keysOut.length) issues.push(`${tag}元素超出视口(可滚动) ${a.keysOut.join(', ')}`);
        if (strict && a.overflow.length) issues.push(`${tag}容器溢出(一屏装不下) ${a.overflow.join('; ')}`);
      }
      if (errors.length) issues.push('控制台报错 ' + errors.slice(0, 2).join(' | '));

      const hard = issues.filter((i) => !i.includes('(可滚动)'));
      if (hard.length) {
        bad++;
        console.log(`✗ [${strict ? '严格' : '可达'}] ${name} (${home.vw}x${home.vh})`);
        for (const i of issues) console.log('    ' + i);
      } else {
        console.log(`✓ [${strict ? '严格' : '可达'}] ${name} (${home.vw}x${home.vh})${issues.length ? '  ' + issues.join(' | ') : ''}`);
      }
    } catch (e) {
      bad++;
      console.log(`✗ ${name} ERROR ${String(e).split('\n')[0]}`);
    }
    await ctx.close();
  }
}

console.log('—— A. 标准视口（严格：一屏装下 + 元素不越界）——');
await run(STANDARD, true);
console.log('\n—— B. 极端视口（可达：允许滚动，但不许"滚不到"）——');
await run(EXTREME, false);
await browser.close();
console.log(bad ? `\n>>> ${bad} 处不达标` : '\n>>> 全部达标：无裁剪、无不可达内容、标准视口一屏装下');
