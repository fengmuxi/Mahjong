/**
 * P5 资源治理：把 web 端的牌面贴图写进小程序主包 `packages/miniapp/miniprogram/tiles/`。
 *
 * 为什么必须处理：现有 34 张 t00..t33.png 合计 ≈4.5MB，超过小程序「单个分包 / 主包 ≤ 2MB」
 * 的上限，直接拷贝会在上传 / 预览时被拦截。做法（对齐方案 P5「压缩后入分包」）：
 *   1. 纯 Node 解码 PNG（IHDR + IDAT + zlib inflate + 逐行反滤波）；
 *   2. 整数倍降采样（长边压到 ~135px）。牌面在画布上的逻辑尺寸只有 52×70，
 *      即便 2x DPR 的物理像素也不过百来 px，降采样后肉眼无差别；
 *   3. 重新编码为 8bit RGB PNG（filter 0 + zlib deflate level 9 + 手写 CRC32）。
 * 不做有损调色板量化，避免牌面出现色带。
 *
 * 用法：node scripts/mp_prepare_assets.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, '..');
const SRC = path.join(ROOT, 'packages/client/src/assets/tiles');
const OUT = path.join(ROOT, 'packages/miniapp/miniprogram/tiles');

/** 降采样后长边目标（px）。牌面逻辑尺寸 52×70，画布 1280 宽 → 取 ~135 仍远超显示需求 */
const TARGET_MAX = 135;

// ---------- PNG 解码 ----------

function chunks(buf) {
  const out = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    out.push({ type, data: buf.subarray(off + 8, off + 8 + len) });
    off += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/** 反滤波：PNG 每行首字节为 filter type（0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth） */
function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[pos];
    pos += 1;
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= bpp ? prev[x - bpp] : 0;
      const v = line[x];
      let val;
      switch (ft) {
        case 0:
          val = v;
          break;
        case 1:
          val = v + a;
          break;
        case 2:
          val = v + b;
          break;
        case 3:
          val = v + ((a + b) >> 1);
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          val = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default:
          throw new Error(`不支持的 filter type: ${ft}`);
      }
      cur[x] = val & 0xff;
    }
  }
  return out;
}

function decodePng(buf) {
  const cs = chunks(buf);
  const ihdr = cs.find((c) => c.type === 'IHDR');
  if (!ihdr) throw new Error('缺少 IHDR');
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`仅支持 8bit 非隔行（实际 ${bitDepth}/${interlace}）`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`不支持的 colorType ${colorType}`);
  const idat = Buffer.concat(cs.filter((c) => c.type === 'IDAT').map((c) => c.data));
  const raw = zlib.inflateSync(idat);
  return { width, height, channels, pixels: unfilter(raw, width, height, channels) };
}

// ---------- PNG 编码（8bit RGB） ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bitDepth
  ihdr[9] = 2; // colorType RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // filter 0：每行前置一个 0 字节
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 整数倍盒式降采样（α 通道丢弃：牌面贴图无透明需求，且底色由画布绘制） */
function downscale(img, factor) {
  const w = Math.floor(img.width / factor);
  const h = Math.floor(img.height / factor);
  const { channels, pixels } = img;
  const out = Buffer.alloc(w * h * 3);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const i = ((y * factor + dy) * img.width + (x * factor + dx)) * channels;
          r += pixels[i];
          g += pixels[i + 1];
          b += pixels[i + 2];
        }
      }
      const o = (y * w + x) * 3;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
    }
  }
  return { width: w, height: h, rgb: out };
}

// ---------- 主流程 ----------

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  let totalIn = 0;
  let totalOut = 0;
  let skipped = 0;
  for (let i = 0; i <= 33; i++) {
    const name = `t${String(i).padStart(2, '0')}.png`;
    const srcPath = path.join(SRC, name);
    const dstPath = path.join(OUT, name);
    const src = fs.readFileSync(srcPath);
    totalIn += src.length;
    let out = src;
    try {
      const img = decodePng(src);
      const factor = Math.max(1, Math.ceil(Math.max(img.width, img.height) / TARGET_MAX));
      const small = factor > 1 ? downscale(img, factor) : { width: img.width, height: img.height, rgb: toRgb(img) };
      out = encodePng(small.width, small.height, small.rgb);
    } catch (err) {
      skipped += 1;
      console.warn(`[warn] ${name} 未能重编码（${err.message}），原样拷贝`);
    }
    fs.writeFileSync(dstPath, out);
    totalOut += out.length;
  }
  const kb = (n) => `${(n / 1024).toFixed(0)}KB`;
  console.log(`牌面资源已生成：${OUT}`);
  console.log(`  原始 ${kb(totalIn)} → 产物 ${kb(totalOut)}（跳过重编码 ${skipped} 张）`);
  if (totalOut > 2 * 1024 * 1024) {
    console.warn('[warn] 分包资源超过 2MB，需进一步降采样或改走 CDN（见方案 P5）');
  }
}

function toRgb(img) {
  const { width, height, channels, pixels } = img;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0, o = 0; o < out.length; i += channels, o += 3) {
    out[o] = pixels[i];
    out[o + 1] = pixels[i + 1];
    out[o + 2] = pixels[i + 2];
  }
  return out;
}

main();
