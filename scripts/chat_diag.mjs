import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto('http://localhost:3000', { waitUntil: 'load' });
await page.waitForSelector('#mode-create');
await page.click('#mode-create');
await page.click('#variant-next');
await page.waitForSelector('#step-form:not(.hidden)');
await page.fill('#name', '玩家A');
await page.click('#form-submit');
await sleep(2000);

const state = await page.evaluate(() => ({
  homeHidden: document.querySelector('#view-home').classList.contains('hidden'),
  tableHidden: document.querySelector('#view-table').classList.contains('hidden'),
  gameHidden: document.querySelector('#view-game').classList.contains('hidden'),
  roomCode: document.querySelector('#room-code').textContent,
  homeError: document.querySelector('#home-error').textContent,
  wsState: (window.__wsState ?? 'n/a'),
}));
console.log('STATE', JSON.stringify(state, null, 2));
console.log('LOGS', JSON.stringify(logs.slice(-20), null, 2));
await browser.close();
