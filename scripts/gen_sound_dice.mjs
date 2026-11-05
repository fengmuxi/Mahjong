/**
 * 骰子音效处理：任意 mp3（源素材）→ `packages/server/public/sound/dice.mp3`
 *
 * 为什么要过一道（不是直接拷）：
 *   ① **体积 = 首播延迟**。源文件 43.5KB@256kbps，而 InnerAudioContext 对远端音频是
 *      「整文件下完再播」—— 骰子刚开始滚的那一瞬间要等它下完，弱网下能差出几百毫秒。
 *      裁掉静音 + 96kbps 之后约 10KB，落在一次 RTT 里。
 *   ② **尾巴全是静音**。源文件 1.39s，真正响的只有 0.10~0.88s，后面 0.5s 是空白
 *      （解码实测包络），留着只是白等。
 *   ③ **峰值顶到 1.000**（削波边缘），归一化到 -1dBFS 更稳。
 *
 * 解码用 Chromium 的 decodeAudioData（lamejs 只能编码不能解码，本机也没有 ffmpeg）；
 * 编码用 lamejs —— 与 scripts/gen_sound_voice.mjs 同一套工具链。
 *
 * 用法：
 *   node scripts/gen_sound_dice.mjs [源文件]
 * 默认源：E:/86187/下载/u_qpfzpydtro-dice-142528.mp3
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// 两套 require 解析基：lamejs 在本工程 node_modules，playwright 在工作区里的那份
// （与 scripts/gen_ui_extra.mjs 同一约定，别问为什么不在同一个地方）。
const reqProj = createRequire(import.meta.url);
const reqWs = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const CHROME = 'C:/Users/86187/AppData/Local/ms-playwright/chromium-1248/chrome-win64/chrome.exe';

const ROOT = 'E:/86187/Desktop/Mahjong';
const SRC = process.argv[2] || 'E:/86187/下载/u_qpfzpydtro-dice-142528.mp3';
const OUT = path.join(ROOT, 'packages/server/public/sound/dice.mp3');

/** 码率：单声道语音级音效 96kbps 足够（骰子声是宽频噪声，再低会糊） */
const KBPS = 96;
/** 首尾各留的余量（ms）：裁到干干净净会把骰子第一声「咔」的起振削掉 */
const PAD_MS = 20;
/**
 * 静音判定：相对峰值的比例（约 -34dB）。
 * ⚠ 这里比 gen_sound_voice.mjs 的 0.005 严得多，原因是实测：这份素材尾巴上有一层
 * 约 0.01（-40dB）的底噪/编码残响，用 -46dB 门限会「整段都不算静音」，0.5s 空白一点没裁掉。
 * 一次性音效的尾巴本来就是听不见的噪声，抬到 -34dB 才切得干净。
 */
const SILENCE_RATIO = 0.02;
/** 峰值归一目标（-1dBFS） */
const PEAK = 0.89;
const FADE_MS = 5;

/** lamejs 只能 require 不了（1.2.1 打包缺全局；lame.all.js 是 IIFE、导出挂在函数自己身上） */
function loadLame() {
  const src = fs.readFileSync(reqProj.resolve('lamejs/lame.all.js'), 'utf8');
  return new Function(`${src}\nreturn lamejs;`)();
}

const lamejs = loadLame();
const { chromium } = reqWs('playwright');

if (!fs.existsSync(SRC)) {
  console.error(`源文件不存在：${SRC}`);
  process.exit(1);
}

/* ---------- 1. 解码（Chromium decodeAudioData） ---------- */
const b64 = fs.readFileSync(SRC).toString('base64');
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage();
await page.goto('about:blank');
const decoded = await page.evaluate(async (data) => {
  const bin = atob(data);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const buf = await ctx.decodeAudioData(u8.buffer);
  // 多声道 → 平均成单声道
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return { rate: buf.sampleRate, pcm: Array.from(out) };
}, b64);
await browser.close();

const rate = decoded.rate;
const pcm = Float32Array.from(decoded.pcm);
console.log(`解码：${(pcm.length / rate).toFixed(2)}s · ${rate}Hz · 峰值 ${Math.max(...pcm.map(Math.abs)).toFixed(3)}`);

/* ---------- 2. 裁静音 + 归一 + 淡入淡出 ---------- */
const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
if (peak < 1e-6) {
  console.error('源文件近乎静音，放弃');
  process.exit(1);
}
const gate = peak * SILENCE_RATIO;
let head = 0;
while (head < pcm.length && Math.abs(pcm[head]) < gate) head++;
let tail = pcm.length - 1;
while (tail > head && Math.abs(pcm[tail]) < gate) tail--;

const pad = Math.round((PAD_MS / 1000) * rate);
const start = Math.max(0, head - pad);
const end = Math.min(pcm.length - 1, tail + pad);
const outLen = end - start + 1;
const gain = PEAK / peak;
const fade = Math.max(1, Math.round((FADE_MS / 1000) * rate));
const shaped = new Float32Array(outLen);
for (let i = 0; i < outLen; i++) {
  let v = pcm[start + i] * gain;
  if (i < fade) v *= i / fade;
  const back = outLen - 1 - i;
  if (back < fade) v *= back / fade;
  shaped[i] = v;
}
console.log(`处理：${(pcm.length / rate).toFixed(2)}s → ${(outLen / rate).toFixed(2)}s（裁掉 ${(((pcm.length - outLen) / rate) * 1000).toFixed(0)}ms 静音）`);

/* ---------- 3. 编码 ---------- */
const enc = new lamejs.Mp3Encoder(1, rate, KBPS);
const samples = new Int16Array(outLen);
for (let i = 0; i < outLen; i++) {
  const v = Math.max(-1, Math.min(1, shaped[i]));
  samples[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
}
const parts = [];
for (let i = 0; i < samples.length; i += 1152) {
  const buf = enc.encodeBuffer(samples.subarray(i, i + 1152));
  if (buf.length) parts.push(Buffer.from(buf));
}
const tailBuf = enc.flush();
if (tailBuf.length) parts.push(Buffer.from(tailBuf));
const mp3 = Buffer.concat(parts);
fs.writeFileSync(OUT, mp3);
console.log(`输出：${path.basename(OUT)} · ${(mp3.length / 1024).toFixed(1)}KB（源 ${(fs.statSync(SRC).size / 1024).toFixed(1)}KB）· ${KBPS}kbps`);
