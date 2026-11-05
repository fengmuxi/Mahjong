/**
 * 按钮（app.wxss button 各类 + 按下态的 canvas 对位）。
 *
 * 小程序端按下反馈靠 hover-class（tapped / button-hover：底色提亮 + 缩放下沉）；
 * 场景在 onTouchDown 命中按钮时记 pressed id、onTouchUp/Cancel 清掉，本模块按
 * pressed 画按下态 —— 反馈节奏与 60ms transition 的观感对齐。
 */

const draw = require('./draw.js');

/** kind → 配色（app.wxss button.primary/.danger/.ghost/.on） */
function colors(kind) {
  switch (kind) {
    case 'primary':
    case 'on':
      return { bg: '#e6c14b', color: '#22200f', border: '#f6e3a1', bold: true };
    case 'danger':
      return { bg: 'rgba(255,255,255,0.08)', color: '#e07a6a', border: 'rgba(224,122,106,0.5)' };
    case 'ghost':
      return { bg: 'transparent', color: '#e8efe9', border: 'rgba(255,255,255,0.18)' };
    default:
      return { bg: 'rgba(255,255,255,0.08)', color: '#e8efe9', border: 'rgba(255,255,255,0.14)' };
  }
}

/**
 * 画一枚按钮。r: {x,y,w,h}；opts: { label, kind, size, bold, disabled, pressed, radius }
 * disabled = opacity .45（button[disabled]），底色仍按 kind（保住主色，同 wxss 的 !important 组）。
 */
function render(ctx, r, opts) {
  const o = opts || {};
  const c = colors(o.kind);
  const pressed = o.pressed && !o.disabled;
  const scale = pressed ? 0.96 : 1;
  ctx.save();
  if (o.disabled) ctx.globalAlpha = 0.45;
  if (scale !== 1) {
    ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
    ctx.scale(scale, scale);
    ctx.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
  }
  let bg = c.bg;
  if (pressed) bg = o.kind === 'primary' || o.kind === 'on' ? '#f2d266' : o.kind === 'danger' ? 'rgba(224,122,106,0.24)' : 'rgba(255,255,255,0.18)';
  ctx.fillStyle = bg;
  draw.roundRect(ctx, r.x, r.y, r.w, r.h, o.radius == null ? 5 : o.radius);
  ctx.fill();
  ctx.strokeStyle = c.border;
  ctx.lineWidth = 1;
  ctx.stroke();
  draw.text(ctx, o.label || '', r.x + r.w / 2, r.y + r.h / 2, {
    size: o.size || 13,
    color: c.color,
    align: 'center',
    bold: c.bold || o.bold,
    maxW: r.w - 12,
  });
  ctx.restore();
}

/** pill 形按钮（步骤条 / 背景档位 / chip 的圆胶囊变体） */
function pill(ctx, r, opts) {
  const o = opts || {};
  ctx.save();
  if (o.disabled) ctx.globalAlpha = 0.45;
  const bg = o.pressed ? 'rgba(230,193,75,0.16)' : o.active ? o.bgActive || 'rgba(230,193,75,0.12)' : o.bg || 'transparent';
  if (bg && bg !== 'transparent') {
    ctx.fillStyle = bg;
    draw.roundRect(ctx, r.x, r.y, r.w, r.h, r.h / 2);
    ctx.fill();
  }
  ctx.strokeStyle = o.active ? '#e6c14b' : o.borderColor || 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  draw.roundRect(ctx, r.x, r.y, r.w, r.h, r.h / 2);
  ctx.stroke();
  draw.text(ctx, o.label || '', r.x + r.w / 2, r.y + r.h / 2, {
    size: o.size || 12,
    color: o.active ? '#f6e3a1' : o.color || '#9db5a8',
    align: 'center',
    bold: o.active,
  });
  ctx.restore();
}

/**
 * 图标方钮（⚙️ / ✕ 这类**单字形**按钮）。
 *
 * 为什么不复用 render()：render 一律按 `maxW = w-12` 截断文字，对 20~26px 的方钮
 * 只剩 8~14px，而 emoji 字形通常比这宽 → 实测被截成「⚙…」「✕…」。
 * 这里**不做任何截断**：整字形居中画，只画底色/边框/按下态。
 * 用它的地方：首页与大厅的设置入口、设置面板的关闭钮。
 */
function icon(ctx, r, opts) {
  const o = opts || {};
  const C = draw.C;
  ctx.save();
  ctx.fillStyle = o.pressed ? 'rgba(255,255,255,0.18)' : o.bg || 'rgba(255,255,255,0.06)';
  draw.roundRect(ctx, r.x, r.y, r.w, r.h, o.radius == null ? 5 : o.radius);
  ctx.fill();
  ctx.strokeStyle = o.border || 'rgba(255,255,255,0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();
  // label 是单字形图标：默认走 draw.icon（墨迹盒居中）。o.vec='gear' → draw.gear
  // 矢量齿轮：⚙️ 必须带 U+FE0F 变体选择符，真机 canvas 对这类字形度量不稳、
  // 居中失效（2026-11-05 二次报障），矢量画法与平台/字体无关。
  if (o.vec === 'gear') {
    draw.gear(ctx, r.x + r.w / 2, r.y + r.h / 2, (o.size || 12) * 0.55, o.color || C.muted);
  } else {
    draw.icon(ctx, o.label || '', r.x + r.w / 2, r.y + r.h / 2, {
      size: o.size || 12,
      color: o.color || C.muted,
      bold: o.bold,
      dy: o.dy,
    });
  }
  ctx.restore();
}

module.exports = { render, pill, icon };
