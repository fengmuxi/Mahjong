/**
 * 生成「增量 UI 贴图」：`packages/miniapp/assets/ui/<group>/<key>.png`
 *   → `packages/server/public/ui/<group>/<key>.webp`
 *
 * 为什么单独一个脚本（2026-10-24）：
 *   `gen_ui_cdn.mjs` 的源目录是 `packages/client/src/assets/ui`，而 `packages/client`
 *   已在提交 104bfdc「Remove client-side assets and configuration files」整体删除 ——
 *   那个脚本现在**跑不了**（找不到源目录就 exit 1，但它 `fs.rmSync(OUT)` 在检查之前，
 *   半途退出会把 public/ui 整个清空，千万别在这种状态下跑它）。
 *   之后新增的 UI 贴图一律走本脚本：**只增不删**，源图放 `packages/miniapp/assets/ui/`。
 *
 * 编码参数与 `gen_ui_cdn.mjs` 保持一致（同一 Chromium、quality 0.92、imageSmoothing high），
 * 这样新旧产物的画质口径一样；`SCALE` 默认 2（画布 backing store 最高 2x，避免高分屏发虚）。
 *
 * 用法：
 *   node scripts/gen_ui_extra.mjs              # 全部增量贴图
 *   node scripts/gen_ui_extra.mjs hud          # 只跑某个分组
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const ROOT = 'E:/86187/Desktop/Mahjong';
const SRC = path.join(ROOT, 'packages/miniapp/assets/ui');
const OUT = path.join(ROOT, 'packages/server/public/ui');
const QUALITY = 0.92;
const DEFAULT_SCALE = 2;

if (!fs.existsSync(SRC)) {
  console.error(`增量源目录不存在：${SRC}`);
  process.exit(1);
}

const only = process.argv[2] ? [process.argv[2]] : null;
const groups = fs
  .readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((g) => !only || only.includes(g))
  .sort();

const items = [];
for (const g of groups) {
  for (const f of fs.readdirSync(path.join(SRC, g)).filter((f) => /\.png$/.test(f)).sort()) {
    items.push({ key: f.replace(/\.png$/, ''), group: g, file: path.join(SRC, g, f) });
  }
}
if (!items.length) {
  console.error(`没有找到任何 PNG：${SRC}`);
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: 'C:/Users/86187/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
});
const page = await browser.newPage();
const payload = items.map((it) => [
  it.key,
  `data:image/png;base64,${fs.readFileSync(it.file).toString('base64')}`,
  DEFAULT_SCALE,
]);
const encoded = await page.evaluate(
  async ([list, q]) => {
    const res = [];
    for (const [name, dataUrl, scale] of list) {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      res.push([name, c.toDataURL('image/webp', q).split(',')[1], c.width, c.height]);
    }
    return res;
  },
  [payload, QUALITY],
);
await browser.close();

let total = 0;
const byGroup = {};
for (let i = 0; i < items.length; i++) {
  const it = items[i];
  const [name, b64, w, h] = encoded[i];
  const buf = Buffer.from(b64, 'base64');
  const dest = path.join(OUT, it.group, `${it.key}.webp`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  total += buf.length;
  (byGroup[it.group] ||= []).push(`${it.key} ${w}×${h} ${(buf.length / 1024).toFixed(1)}KB`);
}
for (const g of groups) {
  if (!byGroup[g]) continue;
  console.log(`  [${g}]`);
  for (const line of byGroup[g]) console.log(`    ${line}`);
}
console.log(`增量 UI 贴图已生成：${total} B / ${items.length} 张 → ${OUT}`);
console.log('⚠ 记得抬 `MAHJONG_UI_VER`（服务端 index.ts 的 UI_VER），否则客户端仍吃旧缓存清单');
