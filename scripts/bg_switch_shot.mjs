import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const url = process.env.URL || 'http://localhost:8099';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(300);
const card = await page.$('.home-card');
await card.screenshot({ path: 'E:/Temp/mj-bg/home-card-switch.png' });
await browser.close();
console.log('shot saved');
