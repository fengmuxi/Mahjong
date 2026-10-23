/**
 * 生成「按座位的平放牌图集」：packages/client/src/assets/face/faceA..faceD.png
 * （2026-10-23 起归牌面大类：产物由 gen_cdn_tiles.mjs 转 webp 到 public/tiles/face/，
 *  经 /api/tiles 的 faces 子清单下发；以前挂在 ui/seat 组，分类不合理）
 *
 * 源：liumengniu/majiang（MIT）assets/resources/apes/{first,second,third,fourth}/
 *   四套**平放牌**（自己的手牌走 myCard 立牌，桌面弃牌/副露走这四套，34 张含字牌）。
 *
 * 2026-10-22（用户「统一竖直、不要倾斜」）：源项目四套牌是**按座位视角**画好的 ——
 *   first 竖版正立 / third 竖版倒立（对家视角）/ second、fourth 横版侧卧（左右两家视角）。
 * 之前客户端还要再加一次 rot，两层叠加后左右两家字形是横的。
 * **按源图原样入图集（不做任何旋转）**：每套牌本来就是按座位视角画好的
 * （first 竖立 / third 倒立 / second·fourth 横卧），客户端一律 rot=0，直接按源图显示 ——
 * 谁的牌朝谁，跟源项目一致。
 *
 * 产物布局：9 列 × 4 行，格尺寸 = 该套旋转后的尺寸（见 VARIANTS 表末尾打印）。
 * ⚠️ 格尺寸必须与 **packages/miniapp/miniprogram/utils/uiart.js 的 FACE_CELL 表**一致，
 *    脚本末尾会打印该表，直接抄过去。
 *
 * 用法：node scripts/gen_face_atlas.mjs [apes 路径]
 */
import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';

const SRC = process.argv[2] || 'E:/86187/Desktop/SpringAi/majiang-master/assets/resources/apes';
const OUT = 'E:/86187/Desktop/Mahjong/packages/client/src/assets/face';
const COLS = 9;

/** [key, 目录, 旋转角(度，canvas 顺时针为正)]。A=自己(下) B=下家(右) C=对家(上) D=上家(左) */
const VARIANTS = [
  ['faceA', 'first', 0],
  ['faceB', 'second', 0],
  ['faceC', 'third', 0],
  ['faceD', 'fourth', 0],
];
/** 与 shared/tiles.ts 的索引一一对应（0-8 万 / 9-17 条 / 18-26 筒 / 27-33 字） */
const ORDER = [
  ...Array.from({ length: 9 }, (_, i) => `bw${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `bt${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `bb${i + 1}`),
  ...Array.from({ length: 7 }, (_, i) => `bz${i + 1}`),
];

if (!existsSync(SRC)) {
  console.error('找不到源目录：', SRC);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const payload = {};
for (const [key, dir] of VARIANTS) {
  payload[key] = {};
  for (const f of ORDER) {
    const p = `${SRC}/${dir}/${f}.png`;
    if (!existsSync(p)) {
      console.error(`缺图：${dir}/${f}.png`);
      process.exit(1);
    }
    payload[key][f] = 'data:image/png;base64,' + readFileSync(p).toString('base64');
  }
}

const exe = readdirSync('C:/Users/86187/AppData/Local/ms-playwright').filter((d) => /^chromium-\d+$/.test(d)).sort().pop();
const browser = await chromium.launch({
  executablePath: `C:/Users/86187/AppData/Local/ms-playwright/${exe}/chrome-win64/chrome.exe`,
  headless: true,
  args: ['--no-sandbox', '--disable-extensions'],
});
const page = await browser.newPage();

const cells = {};
for (const [key, , rotDeg] of VARIANTS) {
  const out = await page.evaluate(async ({ urls, ORDER, COLS, rotDeg }) => {
    const load = (u) => new Promise((res) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => res(null);
      i.src = u;
    });
    const imgs = [];
    for (const f of ORDER) imgs.push(await load(urls[f]));
    const any = imgs.find(Boolean);
    const swap = Math.abs(rotDeg) % 180 === 90;
    // 格 = 旋转后的源图尺寸；各套里个别字牌尺寸不齐（third 的 46×64 vs 42×60）由「等比放进格内」吸收
    const srcW = swap ? any.naturalHeight : any.naturalWidth;
    const srcH = swap ? any.naturalWidth : any.naturalHeight;
    const cw = srcW;
    const ch = srcH;
    const rows = Math.ceil(ORDER.length / COLS);
    const c = document.createElement('canvas');
    c.width = cw * COLS;
    c.height = ch * rows;
    const x = c.getContext('2d');
    x.imageSmoothingQuality = 'high';
    const rad = (rotDeg * Math.PI) / 180;
    imgs.forEach((im, i) => {
      if (!im) return;
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      const w0 = swap ? im.naturalHeight : im.naturalWidth;
      const h0 = swap ? im.naturalWidth : im.naturalHeight;
      const k = Math.min(cw / w0, ch / h0);
      const dw = w0 * k;
      const dh = h0 * k;
      x.save();
      x.translate(col * cw + cw / 2, row * ch + ch / 2);
      x.rotate(rad);
      x.drawImage(im, -dw / 2, -dh / 2, dw, dh);
      x.restore();
    });
    return { url: c.toDataURL('image/png'), cw, ch, rows };
  }, { urls: payload[key], ORDER, COLS, rotDeg });
  cells[key] = [out.cw, out.ch];
  writeFileSync(`${OUT}/${key}.png`, Buffer.from(out.url.split(',')[1], 'base64'));
  console.log(`✔ ${key}.png  ${out.cw * COLS}×${out.ch * out.rows}  (格 ${out.cw}×${out.ch} · 旋转 ${rotDeg}°)`);
}

console.log('\nFACE_CELL（抄进 miniprogram/utils/uiart.js）：');
console.log('const FACE_CELL = {');
for (const [key] of VARIANTS) console.log(`  ${key}: [${cells[key][0]}, ${cells[key][1]}],`);
console.log('};');
await browser.close();
