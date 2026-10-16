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

const read = () => page.evaluate(() => ({
  dataBg: document.body.dataset.bg,
  bgImage: getComputedStyle(document.body).backgroundImage,
  stored: localStorage.getItem('mj-bg'),
}));

const before = await read();

// 切到「回纹」(lattice)
await page.locator('#bg-opts .bg-opt', { hasText: '回纹' }).click();
const afterLattice = await read();

// 再切到「祥云」(cloud)
await page.locator('#bg-opts .bg-opt', { hasText: '祥云' }).click();
const afterCloud = await read();

// 刷新后应保持上次选择
await page.reload({ waitUntil: 'networkidle' });
const afterReload = await read();

console.log(JSON.stringify({
  before, afterLattice, afterCloud, afterReload, errors,
}, null, 2));
await browser.close();
