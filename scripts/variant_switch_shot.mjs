import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const URL = 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('#mode-create');
await page.click('#mode-create');
await page.click('#variant-next');
await page.waitForSelector('#step-form:not(.hidden)');
await page.fill('#name', '房主');
await page.click('#form-submit');
await page.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
await sleep(150);

const before = 'E:/Temp/mj-bg/variant-switch-before.png';
await page.locator('#view-table').screenshot({ path: before });

// 点击另一玩法 → 弹出「是否清零积分」确认框
await page.evaluate(() => { const b = [...document.querySelectorAll('#variant-switch .vs-opt')].find((x) => !x.disabled); b.click(); });
await sleep(200);
const confirm = 'E:/Temp/mj-bg/variant-confirm.png';
await page.locator('#variant-confirm .modal-card').screenshot({ path: confirm });

// 保留积分 → 切换生效
await page.click('#vc-keep');
await sleep(300);
const after = 'E:/Temp/mj-bg/variant-switch-after.png';
await page.locator('#view-table').screenshot({ path: after });

console.log(JSON.stringify({ before, confirm, after }));
await browser.close();
