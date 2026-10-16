/**
 * 生成应用图标（纯 Node：手写 PNG 编码，不引入任何依赖）。
 * 为什么需要：Manifest 的 `orientation: "landscape"` 只在**安装到主屏幕**后生效，
 * 而 Chrome 判定"可安装"要求 manifest 提供 192/512 图标 —— 没有图标，orientation
 * 这条声明就是空文。
 * 产出：packages/client/public/icon-512.png / icon-192.png（会被 vite 原样拷进 dist 根）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT_DIR = path.resolve('packages/client/public');

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
const BG = hex('#16301f');
const FELT = hex('#1d4030');
const GOLD = hex('#e6c14b');
const TILE = hex('#f6f2e7');
const TILE_SIDE = hex('#d8d0bc');
const RED = hex('#c62828');

/** 圆角矩形覆盖测试（返回 0~1 的覆盖率，用于抗锯齿） */
function insideRoundRect(x, y, rx, ry, w, h, r) {
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function render(N) {
  const SS = 3; // 超采样倍数
  const S = N * SS;
  const out = Buffer.alloc(N * N * 4);
  const acc = new Float64Array(N * N * 4);

  const pad = S * 0.045;
  const bgR = S * 0.235;
  // 牌：居中、竖向比例接近真实麻将牌 279:405
  const tw = S * 0.4;
  const th = tw * (405 / 279);
  const tx = (S - tw) / 2;
  const ty = (S - th) / 2;
  const tr = S * 0.045;
  // 一筒：白色牌面上一个红环
  const ccx = tx + tw / 2;
  const ccy = ty + th / 2;
  const cR = tw * 0.34;
  const cTh = tw * 0.1;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let col = null;
      let alpha = 0;
      // 底：深绿圆角方块
      if (insideRoundRect(x, y, pad, pad, S - pad * 2, S - pad * 2, bgR)) {
        const t = (y / S) * 0.5;
        col = [BG[0] + (FELT[0] - BG[0]) * t + 6, BG[1] + (FELT[1] - BG[1]) * t + 8, BG[2] + (FELT[2] - BG[2]) * t + 4];
        alpha = 1;
      }
      // 金色描边（外沿一圈）
      if (alpha && !insideRoundRect(x, y, pad + S * 0.012, pad + S * 0.012, S - (pad + S * 0.012) * 2, S - (pad + S * 0.012) * 2, bgR - S * 0.012)) {
        col = GOLD;
      }
      if (alpha) {
        // 牌身
        if (insideRoundRect(x, y, tx, ty, tw, th, tr)) {
          const isSide = y > ty + th - th * 0.1;
          col = isSide ? TILE_SIDE : TILE;
          const dx = x - ccx;
          const dy = y - ccy;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (Math.abs(d - cR) <= cTh) col = RED;
        }
        // 累加到「下采样后」的那一个像素：索引必须用 oy=N 级、ox=N 级
        const oy = Math.floor(y / SS);
        const ox = Math.floor(x / SS);
        const i = (oy * N + ox) * 4;
        acc[i] += col[0];
        acc[i + 1] += col[1];
        acc[i + 2] += col[2];
        acc[i + 3] += 255;
      }
    }
  }
  const n = SS * SS;
  for (let i = 0; i < N * N * 4; i++) out[i] = Math.round(acc[i] / n);
  return out;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const size of [512, 192]) {
  const png = encodePng(size, size, render(size));
  const p = path.join(OUT_DIR, `icon-${size}.png`);
  fs.writeFileSync(p, png);
  console.log(`${p}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`);
}
