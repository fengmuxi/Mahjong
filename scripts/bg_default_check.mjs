import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const URL = 'http://localhost:3000';
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('#mode-create');
const dataBg = await page.evaluate(() => document.body.dataset.bg);
const bgImage = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
console.log(JSON.stringify({ dataBg, isCloud: dataBg === 'cloud', bgImageHasCloud: bgImage.includes('bg-cloud') }, null, 2));
await browser.close();
