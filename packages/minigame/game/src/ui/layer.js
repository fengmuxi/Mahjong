/**
 * 通用确认浮层（app.wxss .layer / .layer-card 的画布对位，lobby / game 共用）。
 *
 * 小程序端刻意不用 wx.showModal（原生弹窗在部分环境不弹/回调不达，见 game.js onQuit
 * 的注释），全部走页内浮层 —— 这里保持同一决策：自绘遮罩 + 卡片 + 右对齐按钮行。
 *
 * 「点遮罩关闭」（2026-11-04）：卡片外的第一次点击 → 执行 `layerDismiss`。
 *   · 确认框取**第一个**动作（取消 / 拒绝 / 再等等）—— 唯一安全的默认项，
 *     绝不把误触当成「解散」「离开」这类不可逆操作；
 *   · 积分表取「关闭」。
 * 卡片矩形记在 `ui.layerCard`，由调用方（chrome / lobby 的 tap）判定落点是否在卡外。
 */

const draw = require('./draw.js');
const btn = require('./btn.js');

const { C } = draw;

/**
 * 确认框：标题 + 文本 + 按钮行。actions: [{label, kind, fn}]
 * 命中矩形写进 ui.layerBtns（tap 路由统一消费）；pressed 为空串/按钮 id。
 */
function confirm(ctx, L, ui, pressed, title, body, actions) {
  ctx.fillStyle = C.layerBg;
  ctx.fillRect(0, 0, L.sw, L.sh);
  const cardW = Math.min(L.sw * 0.88, 460);
  const cardH = 132;
  const cx = (L.sw - cardW) / 2;
  const cy = (L.sh - cardH) / 2;
  // 弹框外（遮罩）点击 = 第一个动作（取消/拒绝/再等等）：见文件头说明
  ui.layerCard = { x: cx, y: cy, w: cardW, h: cardH };
  ui.layerDismiss = actions[0] ? actions[0].fn : null;
  ctx.fillStyle = C.layerCard;
  draw.roundRect(ctx, cx, cy, cardW, cardH, 8);
  ctx.fill();
  ctx.strokeStyle = C.layerBorder;
  ctx.stroke();
  draw.text(ctx, title, cx + 16, cy + 20, { size: 15, color: C.goldSoft, bold: true });
  draw.text(ctx, body, cx + 16, cy + 44, { size: 12, color: C.text, maxW: cardW - 32 });
  ui.layerBtns = ui.layerBtns || [];
  let bx = cx + cardW - 16;
  const by = cy + cardH - 14 - 30;
  for (let i = actions.length - 1; i >= 0; i--) {
    const a = actions[i];
    const w = draw.measure(ctx, a.label, 12) + 24;
    bx -= w;
    const r = { x: bx, y: by, w, h: 30 };
    btn.render(ctx, r, { label: a.label, kind: a.kind, size: 12, pressed: pressed === 'layer' + i });
    ui.layerBtns.push({ id: 'layer' + i, rect: r, fn: a.fn });
    bx -= 6;
  }
}

/**
 * 两列积分表浮层（解散最终积分）：标题 + 玩家/总积分表 + 关闭按钮。
 * rows: [{name, value}]
 */
function scoreTable(ctx, L, ui, pressed, title, rows, onClose) {
  ctx.fillStyle = C.layerBg;
  ctx.fillRect(0, 0, L.sw, L.sh);
  const cardW = Math.min(L.sw * 0.88, 380);
  const n = Math.max(1, rows.length);
  const cardH = 60 + (n + 1) * 22 + 14 + 30 + 14;
  const cx = (L.sw - cardW) / 2;
  const cy = Math.max(10, (L.sh - cardH) / 2);
  // 弹框外（遮罩）点击 = 「关闭」
  ui.layerCard = { x: cx, y: cy, w: cardW, h: cardH };
  ui.layerDismiss = onClose;
  ctx.fillStyle = C.layerCard;
  draw.roundRect(ctx, cx, cy, cardW, cardH, 8);
  ctx.fill();
  ctx.strokeStyle = C.layerBorder;
  ctx.stroke();
  draw.text(ctx, title, cx + 16, cy + 20, { size: 15, color: C.goldSoft, bold: true });
  const tx = cx + 16;
  const tw = cardW - 32;
  let ty = cy + 38;
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(tx, ty, tw, 22);
  draw.text(ctx, '玩家', tx + tw * 0.25, ty + 11, { size: 12, color: C.muted, align: 'center' });
  draw.text(ctx, '总积分', tx + tw * 0.75, ty + 11, { size: 12, color: C.muted, align: 'center' });
  ty += 22;
  for (const r of rows) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(tx, ty + 0.5);
    ctx.lineTo(tx + tw, ty + 0.5);
    ctx.stroke();
    draw.text(ctx, r.name, tx + tw * 0.25, ty + 12, { size: 12, color: C.text, align: 'center', maxW: tw * 0.5 });
    const vc = r.value > 0 ? C.green : r.value < 0 ? C.red : C.text;
    draw.text(ctx, (r.value > 0 ? '+' : '') + r.value, tx + tw * 0.75, ty + 12, {
      size: 12,
      color: vc,
      align: 'center',
      bold: true,
    });
    ty += 22;
  }
  const bw = draw.measure(ctx, '关闭', 12) + 24;
  const br = { x: cx + cardW - 16 - bw, y: cy + cardH - 14 - 30, w: bw, h: 30 };
  btn.render(ctx, br, { label: '关闭', kind: 'primary', size: 12, pressed: pressed === 'layerClose' });
  ui.layerBtns = ui.layerBtns || [];
  ui.layerBtns.push({ id: 'layerClose', rect: br, fn: onClose });
}

module.exports = { confirm, scoreTable };
