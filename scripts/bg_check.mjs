import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const url = process.env.URL || 'http://localhost:8099';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url, { waitUntil: 'networkidle' });
const info = await page.evaluate(() => {
  const cs = getComputedStyle(document.body);
  return {
    bgImage: cs.backgroundImage,
    bgRepeat: cs.backgroundRepeat,
    bgSize: cs.backgroundSize,
    hasFelt: cs.backgroundImage.includes('bg-felt-dots'),
  };
});
console.log(JSON.stringify({ ...info, errors }, null, 2));
await browser.close();
