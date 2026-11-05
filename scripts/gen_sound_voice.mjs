/**
 * 语音包转码：`<源目录>/<pack>-<中文动作>.wav` → `packages/server/public/sound/v_<pack>_<action>.mp3`
 *
 * 为什么需要这一步（2026-11-04）：
 *   ① **命名**：源文件是 `n1-吃.wav` —— 中文 + 连字符，服务端 `/sound/` 路由的白名单是
 *      `^[a-z0-9_]+\.mp3$`（见 server/src/index.ts），既不让中文也不让 `-`，直接放进去必然 404。
 *      统一改成 `v_<pack>_<action>.mp3` 后**不需要动任何路由**。
 *   ② **体积**：各套 9 条动作 WAV（24kHz/16bit 未压缩）。
 *      InnerAudioContext 对远端音频是「整文件下完再播」，193KB 在弱网下要几百毫秒，
 *      碰/杠这种即时反馈会明显滞后。MP3 64kbps 单声道把总量压到 ~600KB，单条 20KB 级。
 *   ③ **听感**：TTS 产物首尾常有 100~300ms 空白，直接播等于「点了碰，半拍后才出声」。
 *      这里按能量裁掉首尾静音（各留 PAD_MS 余量），再峰值归一 + 5ms 淡入淡出，
 *      让四条语音包之间的响度一致、也没有爆音。
 *
 * 用法：
 *   node scripts/gen_sound_voice.mjs                 # 用默认源目录
 *   node scripts/gen_sound_voice.mjs <源目录>        # 换源目录（如换了 TTS 批次）
 *
 * 依赖：lamejs（devDependency，纯 JS 的 MP3 编码器）。本机无 ffmpeg，所以不用它。
 * 幂等：同名输出直接覆盖；源文件缺失只警告不中断（支持先补一部分语音再跑）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// lamejs 装在**工程自己的** node_modules（devDependency），按本文件位置解析即可；
// 不要照抄 gen_ui_extra.mjs 里那条 workspace 路径 —— playwright 在那边，lamejs 不在。
const require = createRequire(import.meta.url);

/**
 * 取 lamejs 编码器。**不能** `require('lamejs')`：
 *   1.2.1 的 `src/js/index.js` 在 Node 下会抛 `MPEGMode is not defined`（多文件打包漏了全局），
 *   而 `lame.min.js` / `lame.all.js` 是浏览器 IIFE —— 它把导出挂在**函数自己**身上
 *   （`lamejs.Mp3Encoder = ...`）且不写 `module.exports`，require 回来是个空对象。
 * 所以直接把 UMD 源码塞进 Function 作用域，末尾 return 那个内部函数，稳且不依赖打包器。
 */
function loadLame() {
  const src = fs.readFileSync(require.resolve('lamejs/lame.all.js'), 'utf8');
  return new Function(`${src}\nreturn lamejs;`)();
}
const lamejs = loadLame();

const ROOT = 'E:/86187/Desktop/Mahjong';
const SRC = process.argv[2] || 'E:/86187/下载/breeze-tts-260916/outputs';
const OUT = path.join(ROOT, 'packages/server/public/sound');

/**
 * 语音包 → 源文件前缀映射（与客户端 utils/sound.js 的 VOICE_PACKS 一一对应）。
 * 现有四套源文件就是 `<pack>-<动作>.wav`（前缀 = ASCII 包号）；
 * 胡桃这批是 TTS 直接出的 `胡桃-<动作>.wav`，前缀是中文，但落盘文件名
 * 仍必须是 ASCII（服务端白名单 ^[a-z0-9_]+\.mp3$），所以这里把「包号 ht」
 * 和「源前缀 胡桃」分开：读 <前缀>-<动作>.wav，写 v_<id>_<动作>.mp3。
 */
const PACKS = {
  n1: 'n1',
  n2: 'n2',
  w1: 'w1',
  w2: 'w2',
  ht: '胡桃',
};
/**
 * 中文动作名 → 协议用 ASCII 键。
 * 键名与 `packages/shared` 的 GameActionKind / 服务端日志语义对齐：
 *   chi 吃 · peng 碰 · gang 杠 · angang 暗杠 · gangkai 杠开 · hu 胡(点炮)
 *   zimo 自摸 · liuju 流局 · guo 过(放弃吃碰杠胡)
 */
const ACTIONS = {
  吃: 'chi',
  碰: 'peng',
  杠: 'gang',
  暗杠: 'angang',
  杠开: 'gangkai',
  胡: 'hu',
  自摸: 'zimo',
  流局: 'liuju',
  过: 'guo',
};

/** MP3 码率（kbps）：语音用 64 单声道足够，再高只是白占流量 */
const KBPS = 64;
/** 首尾各保留的静音余量（ms）：裁到干干净净会在字头字尾切出「咔」声 */
const PAD_MS = 25;
/** 静音判定阈值（相对峰值的比例）：-46dB 左右，足够放过气声、不会把字头吃掉 */
const SILENCE_RATIO = 0.005;
/** 峰值归一目标（-1dBFS）：留 1dB 余量避免个别机型解码后削波 */
const PEAK = 0.89;
/** 淡入淡出时长（ms） */
const FADE_MS = 5;

/** 读 WAV（只支持 PCM 16bit；TTS 产物都是这个格式）→ { rate, ch, pcm:Int16Array 或 Float32 单声道 } */
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 文件');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        ch: buf.readUInt16LE(body + 2),
        rate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      // 有些导出工具把 size 写成 0 或超长：一律以「实际剩余字节」为准
      data = buf.subarray(body, Math.min(body + size, buf.length));
    }
    pos = body + size + (size % 2); // chunk 按偶数字节对齐
  }
  if (!fmt || !data) throw new Error('缺少 fmt/data 块');
  if (fmt.format !== 1 || fmt.bits !== 16) {
    throw new Error(`仅支持 16bit PCM（实际 format=${fmt.format} bits=${fmt.bits}）`);
  }
  // 多声道 → 平均成单声道（当前素材都是单声道，留着以防换批次）
  const frames = Math.floor(data.length / (fmt.ch * 2));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.ch; c++) sum += data.readInt16LE((i * fmt.ch + c) * 2);
    mono[i] = sum / fmt.ch / 32768;
  }
  return { rate: fmt.rate, pcm: mono };
}

/**
 * 裁首尾静音 + 峰值归一 + 淡入淡出。
 * 输入输出都是 [-1,1] 的 Float32 单声道。
 */
function polish(pcm, rate) {
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (peak < 1e-6) return pcm; // 全静音：原样返回，交给上层跳过
  const gate = peak * SILENCE_RATIO;
  let head = 0;
  while (head < pcm.length && Math.abs(pcm[head]) < gate) head++;
  let tail = pcm.length - 1;
  while (tail > head && Math.abs(pcm[tail]) < gate) tail--;

  const pad = Math.round((PAD_MS / 1000) * rate);
  const start = Math.max(0, head - pad);
  const end = Math.min(pcm.length - 1, tail + pad);
  const outLen = end - start + 1;
  const out = new Float32Array(outLen);

  const gain = PEAK / peak;
  const fade = Math.max(1, Math.round((FADE_MS / 1000) * rate));
  for (let i = 0; i < outLen; i++) {
    let v = pcm[start + i] * gain;
    // 淡入 / 淡出：只在最外沿几个 ms 上做，不影响字头
    if (i < fade) v *= i / fade;
    const back = outLen - 1 - i;
    if (back < fade) v *= back / fade;
    out[i] = v;
  }
  return out;
}

function encode(pcm, rate, kbps) {
  const enc = new lamejs.Mp3Encoder(1, rate, kbps);
  const samples = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    samples[i] = v < 0 ? Math.round(v * 32768) : Math.round(v * 32767);
  }
  // 逐块喂：lamejs 单次调用过大会占住内存，1152 是 MP3 一帧的样本数
  const CHUNK = 1152;
  const parts = [];
  for (let i = 0; i < samples.length; i += CHUNK) {
    const buf = enc.encodeBuffer(samples.subarray(i, i + CHUNK));
    if (buf.length > 0) parts.push(Buffer.from(buf));
  }
  const tail = enc.flush();
  if (tail.length > 0) parts.push(Buffer.from(tail));
  return Buffer.concat(parts);
}

const srcFiles = fs.readdirSync(SRC);
const tasks = [];
for (const [pack, prefix] of Object.entries(PACKS)) {
  for (const [cn, act] of Object.entries(ACTIONS)) {
    const name = `${prefix}-${cn}.wav`;
    if (!srcFiles.includes(name)) {
      console.warn(`⚠ 源文件缺失，跳过：${name}`);
      continue;
    }
    tasks.push({ pack, act, cn, file: path.join(SRC, name), out: `v_${pack}_${act}.mp3` });
  }
}
if (!tasks.length) {
  console.error(`源目录里没有任何 <pack>-<动作>.wav：${SRC}`);
  process.exit(1);
}

const stat = { files: 0, bytes: 0, skipped: 0, ms: [0, 0] };
for (const t of tasks) {
  let wav;
  try {
    wav = readWav(t.file);
  } catch (e) {
    console.warn(`⚠ 读取失败 ${path.basename(t.file)}：${e.message}`);
    stat.skipped++;
    continue;
  }
  const pcm = polish(wav.pcm, wav.rate);
  const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  if (peak < 1e-3) {
    console.warn(`⚠ 近乎静音，跳过：${path.basename(t.file)}`);
    stat.skipped++;
    continue;
  }
  const mp3 = encode(pcm, wav.rate, KBPS);
  fs.writeFileSync(path.join(OUT, t.out), mp3);
  stat.files++;
  stat.bytes += mp3.length;
  stat.ms[0] += (wav.pcm.length / wav.rate) * 1000;
  stat.ms[1] += (pcm.length / wav.rate) * 1000;
  console.log(
    `${t.out.padEnd(22)} ${(mp3.length / 1024).toFixed(1).padStart(6)}KB  ` +
      `${(wav.pcm.length / wav.rate).toFixed(2)}s → ${(pcm.length / wav.rate).toFixed(2)}s`,
  );
}

console.log(
  `\n完成 ${stat.files} 条（跳过 ${stat.skipped}）· 合计 ${(stat.bytes / 1024).toFixed(0)}KB · ` +
    `首尾静音共裁掉 ${((stat.ms[0] - stat.ms[1]) / 1000).toFixed(1)}s → ${OUT}`,
);
