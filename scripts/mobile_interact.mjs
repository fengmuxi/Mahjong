/**
 * 移动端交互验证（不只看布局，要确认功能真的走通）：
 *   场景1：点手牌操作条的牌 → 真的出牌（WS → 服务端 → 新视图 → 重绘）
 *   场景2：点画布上的手牌（原有交互） → 仍然可出牌（回归）
 *   场景3：竖屏提示层的「进入全屏横屏」→ 不报错、提示层保持
 */
import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium, devices } = require('playwright');

const URL = process.env.MJ_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iphone = devices['iPhone 13'];
const land = { ...iphone, viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 } };

const browser = await chromium.launch();
const results = {};

/** 每个玩家用独立 context = 独立设备与独立 localStorage（4 个标签页共享存储会互相串）
 *  返回：[A, B, C, D] 页面，以及 errors 收集器、close() 清理函数 */
async function setupPlayers(ctxOpts) {
  const errors = [];
  const contexts = [];
  const pages = [];
  for (let i = 0; i < 4; i++) {
    const c = await browser.newContext(ctxOpts);
    contexts.push(c);
    const p = await c.newPage();
    p.on('pageerror', (e) => errors.push(`p${i}: ${String(e).split('\n')[0]}`));
    p.on('console', (m) => m.type() === 'error' && errors.push(`p${i} console: ${m.text()}`));
    pages.push(p);
  }
  const close = async () => {
    for (const c of contexts) await c.close();
  };
  const [A, B, C, D] = pages;
  await Promise.all(pages.map((p) => p.goto(URL, { waitUntil: 'load' })));
  // ⚠ 必须等「脚本生成」的元素：`#mode-create` 是静态 HTML，页面解析完就已存在，
  //   但 vite 的模块脚本是 defer 执行的 —— 此时监听器可能还没绑上，点击会被静默吞掉。
  //   `#bg-opts .bg-opt` 由 renderBgSwitch() 注入，出现即代表应用已就绪可交互。
  await Promise.all(pages.map((p) => p.waitForSelector('#bg-opts .bg-opt')));

  await A.click('#mode-create');
  await A.click('#variant-next');
  await A.waitForSelector('#step-form:not(.hidden)');
  await A.fill('#name', '东家A');
  await A.click('#form-submit');
  await A.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
  // 房号由 renderLobby 写入，必须等它落地再取值，否则会拿到空串
  await A.waitForFunction(() => (document.querySelector('#room-code')?.textContent ?? '').trim().length === 6);
  const code = (await A.textContent('#room-code')).trim();

  try {
    for (const [p, nm] of [[B, '南家B'], [C, '西家C'], [D, '北家D']]) {
      await p.click('#mode-join');
      await p.waitForSelector('#step-form:not(.hidden)');
      await sleep(60);
      await p.fill('#code', code);
      const v1 = await p.inputValue('#code');
      if (v1 !== code) throw new Error(`${nm} 房间码填入即丢失：期望 ${code}，实得 "${v1}"`);
      await p.fill('#name', nm);
      const v2 = await p.inputValue('#code');
      if (v2 !== code) throw new Error(`${nm} 填昵称后房间码丢失："${v2}"`);
      await p.click('#form-submit');
      const v3 = await p.inputValue('#code').catch(() => '(元素已不可用)');
      if (v3 !== code) throw new Error(`${nm} 提交后房间码变化："${v3}"`);
      await p.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'), null, { timeout: 6000 });
    }
  } catch (err) {
    const diag = await Promise.all(
      pages.map((p) =>
        p.evaluate(() => ({
          homeErr: document.querySelector('#home-error')?.textContent ?? '',
          codeVal: document.querySelector('#code')?.value ?? '',
          step: document.querySelector('#steps')?.textContent ?? '',
          screen: ['#view-home', '#view-table', '#view-game'].map((s) => `${s}:${!document.querySelector(s).classList.contains('hidden')}`).join(','),
        })),
      ),
    );
    await close();
    throw new Error(`JOIN FAILED code=${code} :: ${JSON.stringify(diag)} :: ${errors.join(' | ')}`);
  }

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
  await A.waitForFunction(() => !document.querySelector('#view-game').classList.contains('hidden'));
  await sleep(600);
  return { A, B, C, D, errors, close };
}

const trayState = (A) =>
  A.evaluate(() => {
    const row = document.querySelector('#hand-tray-row');
    const btns = Array.from(row.querySelectorAll('.tile-btn'));
    return {
      tiles: btns.length,
      active: document.querySelector('#hand-tray').classList.contains('active'),
      firstDisabled: btns.length ? btns[0].disabled : null,
      firstBg: btns.length ? (btns[0].style.backgroundImage ? 'art' : 'text') : null,
      status: document.querySelector('#g-status').textContent,
    };
  });

// ---------- 场景1：点手牌操作条出牌 ----------
{
  const { A, errors, close } = await setupPlayers(land);
  const before = await trayState(A);
  await A.locator('#hand-tray-row .tile-btn').last().click();
  await sleep(600);
  const after = await trayState(A);
  results.trayDiscard = {
    before: { tiles: before.tiles, active: before.active, art: before.firstBg },
    after: { tiles: after.tiles, active: after.active, status: after.status },
    discardHappened: before.tiles === 14 && after.tiles === 13,
    turnAdvanced: after.status !== before.status,
    errors,
  };
  await A.screenshot({ path: 'E:/Temp/mj-mobile/x1-after-tray-discard.png' });
  await close();
}

// ---------- 场景2：点画布手牌（原有交互回归） ----------
{
  const { A, errors, close } = await setupPlayers(land);
  const before = await trayState(A);
  // 画布逻辑坐标：手牌行 y=560..630，按 CSS 尺寸换算到页面坐标
  const pt = await A.evaluate(() => {
    const c = document.querySelector('#table');
    const b = c.getBoundingClientRect();
    const n = 14;
    const total = n * 56 - (56 - 52);
    const startX = (1280 - total) / 2;
    const lx = startX + 52 / 2; // 第一张手牌中心
    const ly = 560 + 70 / 2;
    return { x: b.x + (lx * b.width) / 1280, y: b.y + (ly * b.height) / 640, rect: { w: +b.width.toFixed(1), h: +b.height.toFixed(1) } };
  });
  await A.mouse.click(pt.x, pt.y);
  await sleep(600);
  const after = await trayState(A);
  results.canvasDiscard = {
    canvasCss: pt.rect,
    before: { tiles: before.tiles, active: before.active },
    after: { tiles: after.tiles, status: after.status },
    discardHappened: before.tiles === 14 && after.tiles === 13,
    turnAdvanced: after.status !== before.status,
    errors,
  };
  await close();
}

// ---------- 场景3：竖屏提示层的全屏按钮 ----------
{
  const ctx = await browser.newContext({ ...iphone, screen: { width: 390, height: 844 } });
  const P = await ctx.newPage();
  const errors = [];
  P.on('pageerror', (e) => errors.push(String(e).split('\n')[0]));
  P.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await P.goto(URL, { waitUntil: 'load' });
  await P.waitForSelector('#rotate-go');
  const hintBefore = await P.evaluate(() => !document.querySelector('#rotate-hint').classList.contains('hidden'));
  await P.click('#rotate-go');
  await sleep(600);
  const hintAfter = await P.evaluate(() => ({
    visible: !document.querySelector('#rotate-hint').classList.contains('hidden'),
    note: document.querySelector('#rotate-note').textContent,
  }));
  results.portraitHint = { hintBefore, hintAfter, errors };
  await P.screenshot({ path: 'E:/Temp/mj-mobile/x3-portrait-after-click.png' });
  await ctx.close();
}

// ---------- 场景4：收起态收到别人的消息 → 未读红点（手机横屏，宽/窄两种布局各验一遍） ----------
const badgeState = (p) =>
  p.evaluate(() => {
    const chat = document.querySelector('#chat');
    const b = document.querySelector('#chat-badge');
    const r = b.getBoundingClientRect();
    return {
      collapsed: chat.classList.contains('collapsed'),
      chatSize: [chat.offsetWidth, chat.offsetHeight],
      chatOverflow: getComputedStyle(chat).overflow,
      hidden: b.hidden,
      text: b.textContent,
      display: getComputedStyle(b).display,
      size: [Math.round(r.width), Math.round(r.height)],
      minAria: document.querySelector('#chat-min').getAttribute('aria-label'),
      // 红点必须真的画在视口里（收起态是挂在 46×46 圆钮右上角外面 3px 的，别被 overflow 裁掉）
      inViewport: r.width > 0 && r.right <= innerWidth && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight,
    };
  });
const landNarrow = { ...iphone, viewport: { width: 667, height: 375 }, screen: { width: 667, height: 375 } };

for (const [tag, dev] of [['land-wide-844x390', land], ['land-narrow-667x375', landNarrow]]) {
  const { A, B, errors, close } = await setupPlayers(dev);
  const before = await badgeState(A);
  await B.evaluate(() => {
    const i = document.querySelector('#chat-input');
    i.value = '手机上收到的新消息';
    document.querySelector('#chat-send').click();
  });
  await sleep(400);
  const after = await badgeState(A);
  await A.locator('#chat').screenshot({ path: `E:/Temp/mj-mobile/x4-chat-badge-${tag}.png` });
  await A.screenshot({ path: `E:/Temp/mj-mobile/x4-chat-badge-page-${tag}.png` });
  // 点圆钮展开 → 红点消失、聊天框回到正常宽度
  await A.click('#chat-min');
  await sleep(300);
  const opened = await badgeState(A);
  results[`unreadBadge_${tag}`] = {
    before: { hidden: before.hidden, collapsed: before.collapsed },
    after,
    opened: { hidden: opened.hidden, collapsed: opened.collapsed, chatSize: opened.chatSize },
    badge_appeared: before.hidden === true && after.hidden === false && after.text === '1',
    collapsed_is_round_button: after.chatSize[0] === 46 && after.chatSize[1] === 46,
    badge_visible_not_clipped: after.display !== 'none' && after.size[0] > 0 && after.inViewport,
    cleared_on_open: opened.hidden === true && opened.collapsed === false && opened.chatSize[0] > 100,
    errors,
  };
  await close();
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
