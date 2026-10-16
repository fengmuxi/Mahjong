import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const url = process.env.URL || 'http://localhost:8099';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);
await page.screenshot({ path: 'E:/Temp/mj-bg/home-bg.png' });
// 仅背景（隐藏首页卡片，露出 body 背景）用于查看平铺与色调
await page.evaluate(() => {
  const card = document.querySelector('.home-card');
  if (card) card.style.visibility = 'hidden';
});
await page.screenshot({ path: 'E:/Temp/mj-bg/home-bg-bare.png' });
await browser.close();
console.log('shots saved');
