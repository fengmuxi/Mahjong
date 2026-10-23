/**
 * 生成「牌面 CDN 资源」：`packages/server/public/tiles/`。
 *
 * 背景：官方代码包体检两条硬线 —— 主包 < 1.5MB、图片资源合计 ≤ 200KB。
 * 牌面无论如何都塞不进代码包（93×135 也要 731KB），所以改成**不进包、走 CDN**：
 * 后端 `GET /api/tiles` 返回清单，小程序按清单从 CDN 加载；未就绪/失败时回退纯矢量牌面。
 *
 * 为什么用无头浏览器缩放：仓库里没有图像库（sharp/jimp 都是原生模块），手写 PNG 编解码
 * 要 200 行左右。这是**开发期构建脚本**，用 Chromium 的高质量缩放 + PNG 编码器即可。
 *
 * 格式 **WebP**：同样 139×202，PNG 是 58KB/张（34 张 1.97MB），WebP q=0.92 只有 6.9KB/张
 * （34 张 235KB）—— CDN 走流量，体积必须压下来。小程序 `<image>` 与 canvas `createImage`
 * 都走微信自带解码器，支持 WebP；万一某端解不出来，也不过是回退矢量牌面（兜底已在）。
 *
 * **牌面大类两个子类**（2026-10-23 分类整理，TILES_VER v4）：
 *   · `t00..t33.webp`  按牌值的**立牌**（所有座位共用；源 assets/tiles/，缩放到 W×H）
 *   · `face/faceA..faceD.webp`  按座位的**平放牌**图集（9×4 格 = 34 张；源 assets/face/，
 *     由 gen_face_atlas.mjs 拼好；保持原尺寸不缩放，缩放会让格子切分错位）
 *
 * 用法：node scripts/gen_cdn_tiles.mjs [宽=139] [高=202] [质量=0.92]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const ROOT = 'E:/86187/Desktop/Mahjong';
const SRC = path.join(ROOT, 'packages/client/src/assets/tiles');
const SRC_FACE = path.join(ROOT, 'packages/client/src/assets/face');
const OUT = path.join(ROOT, 'packages/server/public/tiles');
const QUALITY = Number(process.argv[4] || 0.92);
const W = Number(process.argv[2] || 139);
const H = Number(process.argv[3] || 202);

fs.mkdirSync(OUT, { recursive: true });

/** 立牌：34 张，缩放 W×H */
const items = [];
for (let i = 0; i <= 33; i++) {
  const src = `t${String(i).padStart(2, '0')}.png`; // 源图是 279×405 的 PNG
  const dst = `t${String(i).padStart(2, '0')}.webp`; // 产物走 WebP（同尺寸只有 PNG 的 1/8）
  const buf = fs.readFileSync(path.join(SRC, src));
  items.push([dst, `data:image/png;base64,${buf.toString('base64')}`, W, H]);
}
/** 平放牌图集：faceA..D，**保持原尺寸**（图集按格子切，缩放会错位） */
const faceFiles = fs.existsSync(SRC_FACE)
  ? fs.readdirSync(SRC_FACE).filter((x) => /\.png$/.test(x)).sort()
  : [];
for (const f of faceFiles) {
  const buf = fs.readFileSync(path.join(SRC_FACE, f));
  items.push([`face/${f.replace(/\.png$/, '.webp')}`, `data:image/png;base64,${buf.toString('base64')}`, 0, 0]);
}

const browser = await chromium.launch({
  executablePath: 'C:/Users/86187/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
});
const page = await browser.newPage();
const encoded = await page.evaluate(
  async ([list, q]) => {
    const out = [];
    for (const [name, dataUrl, w, h] of list) {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      if (w && h) {
        c.width = w;
        c.height = h;
      } else {
        c.width = img.width;
        c.height = img.height;
      }
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      out.push([name, c.toDataURL('image/webp', q).split(',')[1], c.width, c.height]);
    }
    return out;
  },
  [items, QUALITY],
);
await browser.close();

let total = 0;
let faceTotal = 0;
let faceCount = 0;
for (const [name, b64, w, h] of encoded) {
  const buf = Buffer.from(b64, 'base64');
  fs.mkdirSync(path.dirname(path.join(OUT, name)), { recursive: true });
  fs.writeFileSync(path.join(OUT, name), buf);
  total += buf.length;
  if (name.startsWith('face/')) {
    faceTotal += buf.length;
    faceCount += 1;
    console.log(`  ${name.padEnd(22)} ${w}×${h}  ${(buf.length / 1024).toFixed(1)}KB`);
  }
}
console.log(`牌面 CDN 资源已生成：${OUT}`);
console.log(`  立牌 34 张 × ${W}×${H} → ${((total - faceTotal) / 1024).toFixed(0)}KB`);
console.log(`  平放牌图集 ${faceCount} 张（face/ 原尺寸）→ ${(faceTotal / 1024).toFixed(0)}KB`);
console.log(`  合计 ${(total / 1024).toFixed(0)}KB`);
