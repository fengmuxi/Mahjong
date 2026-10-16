import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const URL = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
};

async function createRoom(page, name) {
  await page.click('#mode-create');
  await page.click('#variant-next');
  await page.waitForSelector('#step-form:not(.hidden)');
  await page.fill('#name', name);
  await page.click('#form-submit');
  await page.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
}
async function joinRoom(page, code, name) {
  await page.click('#mode-join');
  await page.waitForSelector('#step-form:not(.hidden)');
  await page.fill('#code', code);
  await page.fill('#name', name);
  await page.click('#form-submit');
  await page.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
}

const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
const A = await ctxA.newPage();
const B = await ctxB.newPage();
watch(A, 'A'); watch(B, 'B');

await waitServer();
await A.goto(URL, { waitUntil: 'load' });
await B.goto(URL, { waitUntil: 'load' });
await A.waitForSelector('#mode-create');
await B.waitForSelector('#mode-create');

await createRoom(A, '房主');
const code = (await A.textContent('#room-code')).trim();
await joinRoom(B, code, '茶友');

const hostSeesSwitch = await A.evaluate(() => !document.querySelector('#variant-switch').classList.contains('hidden'));
const guestSwitchHidden = await B.evaluate(() => document.querySelector('#variant-switch').classList.contains('hidden'));
const beforeA = await A.evaluate(() => document.querySelector('#room-variant').textContent);

const clickLobbyOther = (page) => page.evaluate(() => {
  const b = [...document.querySelectorAll('#variant-switch .vs-opt')].find((x) => !x.disabled);
  const name = b.textContent; b.click(); return name;
});
const confirmVisible = (page) => page.evaluate(() => !document.querySelector('#variant-confirm').classList.contains('hidden'));

// 1) 取消：不切换
const otherName = await clickLobbyOther(A);
const confirmShown = await confirmVisible(A);
await A.click('#vc-cancel');
await sleep(150);
const afterCancelA = await A.evaluate(() => document.querySelector('#room-variant').textContent);

// 2) 保留积分：切换生效，两方同步
await clickLobbyOther(A);
await A.click('#vc-keep');
await sleep(250);
const afterKeepA = await A.evaluate(() => document.querySelector('#room-variant').textContent);
const afterKeepB = await B.evaluate(() => document.querySelector('#room-variant').textContent);
const activeKeep = await A.evaluate(() => [...document.querySelectorAll('#variant-switch .vs-opt')].find((x) => x.classList.contains('active'))?.textContent ?? '');

// 3) 清除积分：切回原玩法，事件含「清零」
await clickLobbyOther(A);
await A.click('#vc-clear');
await sleep(250);
const afterClearA = await A.evaluate(() => document.querySelector('#room-variant').textContent);
const feedA = await A.evaluate(() => document.querySelector('#feed').textContent);

console.log(JSON.stringify({
  code,
  hostSeesSwitch,
  guestSwitchHidden,
  beforeA,
  otherName,
  confirmShown,
  cancelKeepsVariant: afterCancelA === beforeA,
  keepSwitched: afterKeepA === otherName && afterKeepB === otherName,
  activeKeep,
  clearSwitchedBack: afterClearA === beforeA,
  feedHasClearEvent: feedA.includes('清零累计积分'),
  errors,
}, null, 2));

await browser.close();
