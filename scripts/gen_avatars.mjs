/**
 * 头像增量转换：把源目录里的图片（avif / webp / jpg / png）转成 120×120 PNG，
 * 写入 `packages/server/public/avatars/aNN.png`。
 *
 * ⚠ 只增不重排（2026-11-04 确立，务必遵守）
 *   头像 id 是**持久协议**：玩家本地存了 `mj-avatar=a05`，服务端池里 a05 换图 =
 *   老玩家设置的头像静默变成另一个人。所以：
 *     · 既有 aNN.png 永不重写、永不重编号；
 *     · 新源文件一律**追加**到当前最大编号之后（a28 → a29 → …）；
 *     · 源文件 → id 的映射写在 `scripts/avatar-map.json`，重复跑同一批源文件
 *       不会重复分配、不会换号。
 *   源文件删掉后再加回来会分到新 id（旧图仍在池里，属正常）。
 *
 * 为什么用 Chromium 转码：微信 canvas 对 avif 支持不稳，统一重编码成 PNG。
 *
 * 用法：
 *   node scripts/gen_avatars.mjs                      # 用默认源目录
 *   node scripts/gen_avatars.mjs "E:/某目录"          # 指定源目录
 *   node scripts/gen_avatars.mjs --force              # 忽略映射，重转已存在的源文件（慎用：会换图）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const ROOT = 'E:/86187/Desktop/Mahjong';
const DEFAULT_SRC = 'E:/86187/下载/新建文件夹';
const OUT = path.join(ROOT, 'packages/server/public/avatars');
const MAP_FILE = path.join(ROOT, 'scripts/avatar-map.json');
const SIZE = 120;
const EXTS = new Set(['.avif', '.webp', '.jpg', '.jpeg', '.png']);
const MIME = {
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

const args = process.argv.slice(2);
const force = args.includes('--force');
const srcArg = args.find((a) => !a.startsWith('--')) || DEFAULT_SRC;
const SRC = path.resolve(srcArg);

/** 源文件名 → 头像 id（不含扩展名，如 'a05'） */
function loadMap() {
  try {
    return JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveMap(map) {
  const sorted = {};
  for (const k of Object.keys(map).sort()) sorted[k] = map[k];
  fs.writeFileSync(MAP_FILE, JSON.stringify(sorted, null, 2) + '\n');
}

/** 池里已占用的编号（a01 → 1） */
function takenIds() {
  if (!fs.existsSync(OUT)) return new Set();
  const s = new Set();
  for (const f of fs.readdirSync(OUT)) {
    const m = /^a(\d{2,3})\.png$/.exec(f);
    if (m) s.add(Number(m[1]));
  }
  return s;
}

function idOf(n) {
  return 'a' + String(n).padStart(2, '0');
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`✗ 源目录不存在：${SRC}`);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const files = fs
    .readdirSync(SRC)
    .filter((f) => EXTS.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  if (!files.length) {
    console.error(`✗ 源目录没有可转换的图片（${[...EXTS].join('/')}）：${SRC}`);
    process.exit(1);
  }

  const map = loadMap();
  const taken = takenIds();

  // —— 计划：已有映射且产物在位 → 跳过；否则追加新编号 ——
  const plan = [];
  for (const f of files) {
    const known = map[f];
    if (!force && known && taken.has(Number(String(known).slice(1))) && fs.existsSync(path.join(OUT, known + '.png'))) {
      plan.push({ file: f, id: known, skip: true });
      continue;
    }
    plan.push({ file: f, id: null, skip: false });
  }
  const pending = plan.filter((p) => !p.skip);
  let next = (taken.size ? Math.max(...taken) : 0) + 1;
  for (const p of pending) {
    p.id = idOf(next++);
    taken.add(Number(p.id.slice(1)));
  }

  console.log(`[gen_avatars] 源目录 ${SRC}`);
  console.log(`[gen_avatars] 找到 ${files.length} 张，跳过已映射 ${plan.length - pending.length} 张，待转 ${pending.length} 张`);
  console.log(`[gen_avatars] 池内现有 ${taken.size - pending.length} 个编号，新号从 ${pending.length ? idOf(Number(plan.find((p) => !p.skip).id.slice(1))) : '-'} 起`);
  if (!pending.length) {
    console.log('[gen_avatars] 无需转换。');
    return;
  }

  const browser = await chromium.launch({
    executablePath:
      'C:/Users/86187/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe',
  });
  const page = await browser.newPage();
  await page.setContent('<canvas id="c"></canvas>');

  let ok = 0;
  let failed = 0;
  for (const p of pending) {
    const ext = path.extname(p.file).toLowerCase();
    const b64 = fs.readFileSync(path.join(SRC, p.file)).toString('base64');
    const dataUrl = `data:${MIME[ext]};base64,${b64}`;
    try {
      const pngDataUrl = await page.evaluate(
        async ({ dataUrl, size }) => {
          const img = new Image();
          img.src = dataUrl;
          await img.decode();
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext('2d');
          // cover 裁剪（保证正方形不拉伸）
          const s = Math.max(size / img.width, size / img.height);
          const dw = img.width * s;
          const dh = img.height * s;
          ctx.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
          return canvas.toDataURL('image/png');
        },
        { dataUrl, size: SIZE },
      );
      const out = path.join(OUT, p.id + '.png');
      fs.writeFileSync(out, Buffer.from(pngDataUrl.split(',')[1], 'base64'));
      map[p.file] = p.id;
      const kb = Math.round(fs.statSync(out).size / 1024);
      console.log(`[gen_avatars] ${p.id}.png <- ${p.file} (${kb}KB)`);
      ok++;
    } catch (e) {
      console.error(`[gen_avatars] ✗ 失败 ${p.file}:`, (e && e.message) || e);
      failed++;
    }
  }
  await browser.close();
  saveMap(map);

  console.log(`[gen_avatars] 完成：成功 ${ok}，失败 ${failed}；池内共 ${taken.size} 张`);
  if (failed) process.exit(2);
  console.log('⚠ 记得抬头像版本号（两处）：服务端 index.ts 的 AVATAR_VER 默认值 + mahjong.config.json 的 avatarVer');
}

main().catch((e) => {
  console.error('[gen_avatars] 致命错误：', e);
  process.exit(3);
});
