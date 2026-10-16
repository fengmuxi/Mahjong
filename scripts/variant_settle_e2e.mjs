import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const URL = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 等页面条件成立：**在 Node 侧轮询 + evaluate**，不用 Playwright 的 waitForFunction。
 * 原因：本脚本要同时开 4 个 context，非活动页面的定时器会被浏览器节流，
 * 页面内轮询（raf/interval）可能长时间不触发 → 条件明明成立也超时假死。
 */
async function waitFor(page, fn, timeout = 20000) {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return;
    if (Date.now() - t0 > timeout) throw new Error("waitFor 超时");
    await sleep(200);
  }
}

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(URL); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('server not up');
}

const browser = await chromium.launch();
const errors = [];
const watch = (page, tag) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(tag + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push(tag + ': ' + String(e)));
  // 「解散对局」走的是原生 window.confirm；Playwright 默认自动**取消**，
  // 不接住它就等于点了「取消」、abort 根本不会发出（后续等结算必然超时）。
  page.on('dialog', (d) => void d.accept());
};

// 就绪信号：机身脚本已执行（背景切换器由 renderBgSwitch() 注入）
async function ready(page) {
  await page.waitForSelector('#mode-create');
  await waitFor(page, () => document.querySelectorAll('#bg-opts > *').length > 0);
}

async function createRoom(page, name) {
  await page.click('#mode-create');
  await page.click('#variant-next');
  await page.waitForSelector('#step-form:not(.hidden)');
  await page.fill('#name', name);
  await page.click('#form-submit');
  await waitFor(page, () => !document.querySelector('#view-table').classList.contains('hidden'));
}
async function joinRoom(page, code, name) {
  await page.click('#mode-join');
  await page.waitForSelector('#step-form:not(.hidden)', { timeout: 20000 });
  // #code 上挂有 +30ms 自动聚焦，直接 fill 会被后续聚焦/清空竞态吃掉 → 先等一拍 + 校验 + 重试
  await sleep(60);
  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    await page.fill('#code', code);
    ok = (await page.inputValue('#code')) === code;
    if (!ok) await sleep(150);
  }
  if (!ok) throw new Error('房间码填入即丢失：' + code);
  await page.fill('#name', name);
  await page.click('#form-submit');
  await waitFor(page, () => !document.querySelector('#view-table').classList.contains('hidden'));
}

const names = ['房主', '乙', '丙', '丁'];
const pages = [];
await waitServer();
for (let i = 0; i < 4; i++) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  watch(p, names[i]);
  await p.goto(URL, { waitUntil: 'load' });
  await ready(p);
  pages.push(p);
}
const [host, guestA, guestB] = pages;

await createRoom(host, names[0]);
const code = (await host.textContent('#room-code')).trim();
for (let i = 1; i < 4; i++) await joinRoom(pages[i], code, names[i]);
await sleep(300);

// 全员准备 → 开局
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
await sleep(1200);
const diag = await host.evaluate(() => ({
  seats: document.querySelectorAll('#seats .seat:not(.empty)').length,
  ready: document.querySelectorAll('#seats .seat.ready').length,
  tableVisible: !document.querySelector('#view-table').classList.contains('hidden'),
  gameVisible: !document.querySelector('#view-game').classList.contains('hidden'),
}));
console.log('DIAG', JSON.stringify(diag));
await waitFor(host, () => !document.querySelector('#view-game').classList.contains('hidden'));
await sleep(300);

// 房主强制结束对局 → 进入结算/摊牌窗口
await host.click('#dissolve-game-btn');
await waitFor(host, () => !document.querySelector('#settle').classList.contains('hidden'));
await sleep(400);

const hostSettleSwitchVisible = await host.evaluate(() => !document.querySelector('#settle-variant').classList.contains('hidden'));
const guestSettleSwitchHidden = await guestA.evaluate(() => document.querySelector('#settle-variant').classList.contains('hidden'));
const settleBefore = await host.evaluate(() => [...document.querySelectorAll('#settle-variant .vs-opt')].find((x) => x.classList.contains('active'))?.textContent ?? '');
const cumBefore = await host.evaluate(() => document.querySelector('#settle-totals').textContent);

// 结算窗口内切换玩法 + 清除积分
const newName = await host.evaluate(() => {
  const b = [...document.querySelectorAll('#settle-variant .vs-opt')].find((x) => !x.disabled);
  const n = b.textContent; b.click(); return n;
});
const confirmShown = await host.evaluate(() => !document.querySelector('#variant-confirm').classList.contains('hidden'));
await host.click('#vc-clear');
await sleep(400);

const hostActiveAfter = await host.evaluate(() => [...document.querySelectorAll('#settle-variant .vs-opt')].find((x) => x.classList.contains('active'))?.textContent ?? '');
const guestActiveAfter = await guestA.evaluate(() => [...document.querySelectorAll('#settle-variant .vs-opt')].find((x) => x.classList.contains('active'))?.textContent ?? '');
const guestSettleStillOpen = await guestA.evaluate(() => !document.querySelector('#settle').classList.contains('hidden'));
const cumAfter = await host.evaluate(() => document.querySelector('#settle-totals').textContent);

console.log(JSON.stringify({
  code,
  hostSettleSwitchVisible,
  guestSettleSwitchHidden,
  settleBefore,
  newName,
  confirmShown,
  hostActiveAfter,
  guestActiveAfter,
  settleSwitchSynced: hostActiveAfter === newName && guestActiveAfter === newName,
  guestSettleStillOpen,
  cumBefore,
  cumAfter,
  errors,
}, null, 2));

await browser.close();
