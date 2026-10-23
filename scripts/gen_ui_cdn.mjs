/**
 * 生成「UI 贴图 CDN 资源」：`packages/server/public/ui/<group>/<key>.webp`。
 *
 * 与 `gen_cdn_tiles.mjs` 同思路（官方体检红线：主包 < 1.5MB、图+音 ≤ 200KB，
 * 所有位图一律不进代码包、走 CDN 清单）：
 *   · 源图 = `packages/client/src/assets/ui/<group>/<key>.png`（2026-10-21 换美术自
 *     liumengniu/majiang，MIT，见该目录 README）；
 *   · 产物 = WebP（默认 2x 高分屏兜底；DOM `<image>` 与 canvas 离屏都直接吃地址/位图），
 *     经 `GET /api/ui` 清单下发，未就绪/失败时各绘制点回退原有矢量/文字方案；
 *   · 体积：整包现约 740KB（30 张，含两张 web 背景）—— 全部走 CDN，**不进代码包**。
 *
 * 分组（2026-10-23 第二十二轮起，服务端静态资源分类整理；清单值 = `<group>/<key>.webp`
 * 相对路径，客户端 `uiart.urlOf` 拼 `${base}/ui/${images[key]}`，**不感知分组**）：
 *   hand    手牌相关：back 牌背 · back_op 暗杠扣牌 · inhand_l/inhand_r 左右家手牌侧影
 *   operate 操作钮：  chi/peng/gang/hu/guo（吃/碰/杠/胡/过，中心动画字样同图）
 *   settle  结算艺术字：win/lost/draw
 *   hud     桌面 HUD：table 桌面 · banker 庄标 · d0..d9 大数字
 *   bg      web 端背景平铺纹理：bg-cloud/bg-lattice
 *
 * 用法：node scripts/gen_ui_cdn.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const ROOT = 'E:/86187/Desktop/Mahjong';
const SRC = path.join(ROOT, 'packages/client/src/assets/ui');
const OUT = path.join(ROOT, 'packages/server/public/ui');
const QUALITY = 0.92;
/** 分组目录名（顺序即台账顺序） */
const GROUPS = ['hand', 'operate', 'settle', 'hud', 'bg'];
/**
 * 倍率。默认 2x（DOM `<image>` 与 canvas 位图在高分屏上都不发虚）；
 * 例外走 1x，理由是「源图本身没有更多细节，2x 只是插值放大」：
 *   · table：源图 1280×720，2x 解码要 13MB 显存/内存，而绒面/龙纹是低频画面，
 *     让 GPU 放大与预放大肉眼无差；
 *   · faceA..faceD：源平放牌 42×48~59×64，显示尺寸≈源尺寸（50×62 逻辑），
 *     2x 会让 136 格的解码内存 ×4；
 *   · bg-cloud/bg-lattice：512×512 无缝 repeat 平铺，2x 白费流量。
 */
const SCALE_OF = {
  table: 1,
  faceA: 1,
  faceB: 1,
  faceC: 1,
  faceD: 1,
  'bg-cloud': 1,
  'bg-lattice': 1,
};
const scaleOf = (k) => SCALE_OF[k] || 2;
/**
 * 需要**实心**（alpha 压实到 255）的 key。源图边缘带抗锯齿半透明（inhand_l/r 约
 * 23% 像素 alpha 1-254），而这两张的显示尺寸只有源图的 65%（26×56 → 17×16）——
 * 大幅缩小的双线性滤波会把半透明边缘平均进牌身，叠到绿桌面上整列发灰
 * （白边 216→157）。圆角外（alpha < 8）仍保持透明，内部一律压实。
 * 反例（不可加）：peng/gang/hu/guo/win/lost/draw 等要镂空叠桌面的操作钮与艺术字。
 */
const OPAQUE_KEYS = new Set(['inhand_l', 'inhand_r']);

/*
 * ⚠️⚠️ **本脚本当前处于停用状态**（2026-10-24）。
 *
 * 源目录 `packages/client/src/assets/ui` 随 `packages/client` 在提交 104bfdc
 * 「Remove client-side assets and configuration files」被整体删除。而本脚本原本是
 * **先 `fs.rmSync(OUT)` 再检查分组目录**，源不全就 `process.exit(1)` —— 也就是说，
 * 现在跑一次它会先把 `packages/server/public/ui` 整个清空、然后才报「源目录缺分组」退出。
 * 线上 26 张 UI 贴图（牌背/操作钮/结算字/庄标/大数字/桌面）会**一次性全没**。
 *
 * 因此在有人把 assets 源图恢复之前，本脚本必须先自杀：下面这道守卫放在 rmSync **之前**，
 * 源目录不存在就直接退出，绝不碰产物。
 *
 * · 新增 UI 贴图：改走 `node scripts/gen_ui_extra.mjs`
 *   （源放 `packages/miniapp/assets/ui/<group>/`，只增不删）。
 * · 想让本脚本重新可用：把 30 张源 PNG 从 git 历史恢复到 `packages/client/src/assets/ui`
 *   对应分组目录，再删掉这道守卫。
 */
if (!fs.existsSync(SRC)) {
  console.error(
    `[gen:ui-cdn] 源目录已不存在：${SRC}\n` +
      `[gen:ui-cdn] 本脚本会先清空产物目录，源不全时产物会全丢 —— 拒绝执行。\n` +
      `[gen:ui-cdn] 新增贴图请改用：node scripts/gen_ui_extra.mjs`,
  );
  process.exit(1);
}

// 清空旧产物（平铺时代的残留必须清掉，否则 /api/ui 会同时列出两级路径）
fs.rmSync(OUT, { recursive: true, force: true });

/** 扫源目录分组 → [{ key, rel, file }]（rel = `<group>/<key>`） */
const items = [];
for (const g of GROUPS) {
  const dir = path.join(SRC, g);
  if (!fs.existsSync(dir)) {
    console.error(`源目录缺分组：${dir}`);
    process.exit(1);
  }
  for (const f of fs.readdirSync(dir).filter((f) => /\.png$/.test(f)).sort()) {
    const key = f.replace(/\.png$/, '');
    items.push({ key, rel: `${g}/${key}`, file: path.join(dir, f), group: g });
  }
}
if (!items.length) {
  console.error(`源目录无 PNG：${SRC}`);
  process.exit(1);
}

const encoded = await (async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Users/86187/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  });
  const page = await browser.newPage();
  const payload = items.map((it) => [
    it.key,
    `data:image/png;base64,${fs.readFileSync(it.file).toString('base64')}`,
    scaleOf(it.key),
    OPAQUE_KEYS.has(it.key),
  ]);
  const out = await page.evaluate(
    async ([list, q]) => {
      const res = [];
      for (const [name, dataUrl, scale, opaque] of list) {
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
        if (opaque) {
          // alpha 压实：内部一律 255（防缩小滤波把半透明边缘平均进牌身、叠桌面发灰），
          // 圆角外（alpha<8）仍透明
          const im = ctx.getImageData(0, 0, c.width, c.height);
          const d = im.data;
          for (let i = 3; i < d.length; i += 4) {
            if (d[i] > 0 && d[i] < 255) d[i] = d[i] < 8 ? 0 : 255;
          }
          ctx.putImageData(im, 0, 0);
        }
        res.push([name, c.toDataURL('image/webp', q).split(',')[1], c.width, c.height]);
      }
      return res;
    },
    [payload, QUALITY],
  );
  await browser.close();
  return out;
})();

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
for (const g of GROUPS) {
  console.log(`  [${g}]`);
  for (const line of byGroup[g] || []) console.log(`    ${line}`);
}
console.log(`UI CDN 资源已生成：${OUT}`);
console.log(`  ${items.length} 张 / ${GROUPS.length} 组 → 合计 ${(total / 1024).toFixed(0)}KB`);
