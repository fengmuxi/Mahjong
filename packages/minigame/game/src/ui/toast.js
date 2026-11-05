/**
 * 画布 Toast（对位小程序端的 ui.js showToast / wx.showToast）。
 *
 * 小游戏端没有原生 toast 覆盖层（wx.showToast 虽在部分基础库可用，但项目在小程序端
 * 就已刻意避开原生弹层 —— 各机型表现不一致），改为自绘。渲染由 main.js 主循环放在
 * **最顶层**（高于场景与转场遮罩），所以场景切换不会打断提示 —— 与原生 toast 的
 * 「跨页面存活」语义一致。队列同时只显示一条：后到的替换先到的（wx.showToast 语义）。
 */

let cur = null; // { text, start, dur }
/** 骰子覆盖层显示期间的挂起位（对位 ui.js showToast 的 queuedToast 语义） */
let holding = false;
let queued = null;

const draw = require('./draw.js');

/** 显示一条提示。text 相同且正在显示时顺延（对位连续报错的节流观感）。 */
function push(text, ms) {
  if (holding) {
    // 骰子面板显示期间 toast 会盖住面板底部的说明行（2026-10-31 报障）：先挂起不入屏
    queued = { text, ms }; // 多条叠加时后到者胜
    return;
  }
  const now = Date.now();
  if (cur && cur.text === text && cur.start + cur.dur > now) {
    cur.start = now;
    return;
  }
  cur = { text: String(text || ''), start: now, dur: ms || 2000 };
}

/** 骰子覆盖层开场：收掉在屏 toast 并挂起后续提示（对位 ui.hideToast） */
function hold() {
  holding = true;
  queued = null;
  cur = null;
}

/** 骰子覆盖层收尾：放出挂起的提示（对位 ui.flushDiceToast） */
function flush() {
  if (!holding) return;
  holding = false;
  if (queued) {
    const q = queued;
    queued = null;
    push(q.text, q.ms);
  }
}

function clear() {
  cur = null;
}

function render(ctx, L) {
  const t = cur;
  if (!t) return;
  const now = Date.now();
  if (t.start + t.dur <= now) {
    cur = null;
    return;
  }
  // 淡入 120ms / 淡出 240ms
  const age = now - t.start;
  const remain = t.start + t.dur - now;
  let alpha = 1;
  if (age < 120) alpha = age / 120;
  if (remain < 240) alpha = Math.min(alpha, remain / 240);
  ctx.save();
  ctx.font = '12px sans-serif';
  // .toast（app.wxss）：底部 20px 居中，深绿底 + 金边，12px
  const lines = [];
  // 简单折行：每行最多 30 个字符宽，最多 3 行
  let rest = t.text;
  while (rest && lines.length < 3) {
    lines.push(rest.slice(0, 30));
    rest = rest.slice(30);
  }
  const w = Math.min(L.sw - 48, Math.max(120, measureMax(ctx, lines) + 24));
  const lh = 17;
  const h = lines.length * lh + 12;
  const x = (L.sw - w) / 2;
  const y = L.sh - 20 - h;
  ctx.globalAlpha = 0.96 * alpha;
  ctx.fillStyle = 'rgba(20,36,28,0.96)';
  draw.roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.strokeStyle = 'rgba(230,193,75,0.4)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = '#e8efe9';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  lines.forEach((line, i) => {
    ctx.fillText(line, L.sw / 2, y + 6 + lh * (i + 0.5));
  });
  ctx.restore();
}

function measureMax(ctx, lines) {
  let m = 0;
  for (const l of lines) {
    const w = ctx.measureText(l).width;
    if (w > m) m = w;
  }
  return m;
}

module.exports = { push, clear, hold, flush, render };
