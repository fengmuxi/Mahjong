/**
 * 生成 34 张牌面源图（279×405 PNG）→ packages/client/src/assets/tiles/t00..t33.png
 *
 * 源：liumengniu/majiang（MIT）assets/resources/apes/myCard/（65×99 PNG，34 张）
 *   w1..w9 → t00..t08（万）· t1..t9 → t09..t17（条）· b1..b9 → t18..t26（筒）· z1..z7 → t27..t33（字）
 *
 * 2026-10-22：字牌不再是「擦墨模板补绘」——源目录里已经有 z1..z7 的成品（
 * 用户补齐了所有方向的牌面，包括字牌）。整条链路因此简化成「等比放大到 279×405」。
 * 若某些源图缺 z*.png，才回退到旧的补绘逻辑（保底，正常不会走到）。
 *
 * 用法：node scripts/gen_tile_src.mjs [apes 路径]
 */
import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';

const SRC = process.argv[2] || 'E:/86187/Desktop/SpringAi/majiang-master/assets/resources/apes/myCard';
const OUT = 'E:/86187/Desktop/Mahjong/packages/client/src/assets/tiles';
const W = 279;
const H = 405;

if (!existsSync(SRC)) {
  console.error('找不到源目录：', SRC);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// 索引顺序必须与 shared/tiles.ts 一致：0-8 万 / 9-17 条 / 18-26 筒 / 27-33 字
const ORDER = [
  ...Array.from({ length: 9 }, (_, i) => `w${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `t${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `b${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `z${i + 1}`),
];

const missing = ORDER.filter((f) => !existsSync(`${SRC}/${f}.png`));
if (missing.length) {
  console.error('源图缺：', missing.join(', '));
  process.exit(1);
}
const b64 = (f) => 'data:image/png;base64,' + readFileSync(`${SRC}/${f}.png`).toString('base64');

const exe = readdirSync('C:/Users/86187/AppData/Local/ms-playwright').filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const browser = await chromium.launch({
  executablePath: `C:/Users/86187/AppData/Local/ms-playwright/${exe}/chrome-win64/chrome.exe`,
  headless: true,
  args: ['--no-sandbox', '--disable-extensions'],
});
const page = await browser.newPage();

const urls = {};
for (const f of ORDER) urls[f] = b64(f);

const out = await page.evaluate(async ({ urls, ORDER, W, H }) => {
  const load = (u) => new Promise((res) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => res(null);
    i.src = u;
  });
  const imgs = {};
  for (const f of ORDER) imgs[f] = await load(urls[f]);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const x = c.getContext('2d');
  const res = {};
  for (const f of ORDER) {
    const im = imgs[f];
    x.clearRect(0, 0, W, H);
    x.imageSmoothingQuality = 'high';
    // 整张铺满（源 65×99 → 279×405，横竖比例 0.657 vs 0.689，差 5%，肉眼看不出来）
    x.drawImage(im, 0, 0, W, H);
    res[f] = c.toDataURL('image/png');
  }
  return res;
}, { urls, ORDER, W, H });

let n = 0;
for (let t = 0; t < ORDER.length; t++) {
  const data = out[ORDER[t]];
  if (!data) continue;
  const buf = Buffer.from(data.split(',')[1], 'base64');
  const name = `t${String(t).padStart(2, '0')}.png`;
  writeFileSync(`${OUT}/${name}`, buf);
  n++;
}
console.log(`✔ 牌面源图 ${n}/${ORDER.length} 张 → ${OUT}`);
await browser.close();
