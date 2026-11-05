/**
 * 画布绘制原语（对位 app.wxss / 各页 wxss 的通用样式）。
 *
 * 小游戏端没有 WXSS，这里把设计语言收敛成函数：配色取自 app.wxss（深绿桌布 + 金色强调），
 * 尺寸取自各页 wxss 的**紧凑档**（@media max-height 680px —— 小游戏强制横屏手机，恒走该档）。
 * 所有函数约定屏幕坐标 px；文本默认垂直居中、水平左对齐，超出 maxW 省略号截断。
 */

/* ---- 配色（app.wxss 逐项对照） ---- */
const C = {
  page: '#14241c',
  text: '#e8efe9',
  muted: '#9db5a8',
  gold: '#e6c14b',
  goldSoft: '#f6e3a1',
  goldDark: '#22200f',
  green: '#43c07c',
  red: '#e07a6a',
  tag: '#b9cfc2',
  panelBg: 'rgba(255,255,255,0.04)',
  panelBorder: 'rgba(255,255,255,0.08)',
  cardBorder: 'rgba(255,255,255,0.12)',
  cardBg: 'rgba(255,255,255,0.03)',
  inputBg: 'rgba(0,0,0,0.25)',
  inputBorder: 'rgba(255,255,255,0.16)',
  layerBg: 'rgba(0,0,0,0.55)',
  layerCard: '#16332a',
  layerBorder: 'rgba(230,193,75,0.35)',
};

/** 背景偏好（home 页 bg-* 四档；lobby/game 不消费） */
const BGS = ['felt', 'lattice', 'cloud', 'plain'];

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function hit(r, x, y) {
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

/** 省略号截断（.tbl-cell 的 white-space:nowrap + text-overflow:ellipsis 语义） */
function fitText(ctx, text, maxW) {
  const s = String(text == null ? '' : text);
  if (ctx.measureText(s).width <= maxW) return s;
  let out = s;
  while (out.length > 1 && ctx.measureText(out + '…').width > maxW) out = out.slice(0, -1);
  return out + '…';
}

/**
 * 多行折行（canvas 没有自动换行；对位 .hint 这类多行段落）。
 * 逐字贪心断行，行首避让收尾标点（避头点），返回行数组（至少一行）。
 */
function wrapText(ctx, str, size, maxW) {
  ctx.font = (size || 13) + 'px sans-serif';
  const s = String(str == null ? '' : str);
  const noStart = '，。；、！？：）】》”…';
  const lines = [];
  let line = '';
  for (const ch of s) {
    if (line && ctx.measureText(line + ch).width > maxW && noStart.indexOf(ch) < 0) {
      lines.push(line);
      line = ch;
    } else {
      line += ch;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * 画文本。opts: { size, color, align, baseline, bold, maxW }
 * 返回实际绘制宽度（maxW 截断后）。
 */
function text(ctx, str, x, y, opts) {
  const o = opts || {};
  ctx.font = (o.bold ? 'bold ' : '') + (o.size || 13) + 'px sans-serif';
  ctx.fillStyle = o.color || C.text;
  ctx.textAlign = o.align || 'left';
  ctx.textBaseline = o.baseline || 'middle';
  const s = o.maxW ? fitText(ctx, str, o.maxW) : String(str == null ? '' : str);
  ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}

/**
 * 图标字形（emoji / 符号单字形）**视觉居中**。
 *
 * 为什么不复用 text() 的 align:'center' + baseline:'middle'：那套按排版宽度/字体
 * 度量居中，而带变体选择符 U+FE0F 的 emoji（🎙️ ⚙️）在 Chromium 系上 VS16 有
 * 幻影进位（实测 '⚙️' 排版宽 17.85px、可见墨迹仅 15px），再叠上 emoji 回退字体
 * 更高的 ascent —— 合成结果就是「字形偏左上」（2026-11-04 用户报局内
 * 「设置/语音按钮图标不居中」的根因；🔊📋💬 无 VS16 所以看着正常）。
 *
 * 这里改按 measureText().actualBoundingBox*（字形墨迹盒）定位：锚点摆在墨迹盒
 * 几何中心，与排版度量彻底解耦，宽度/高度双轴都准。旧基础库或桩画布拿不到
 * 这些字段（typeof 非 number）时退回 text() 同款经验居中 —— 不比修复前差。
 *
 * opts: { size, color, bold, dy }；返回排版宽（调用方一般不用，语义同 text()）。
 */
function icon(ctx, str, cx, cy, opts) {
  const o = opts || {};
  const s = String(str == null ? '' : str);
  ctx.save();
  ctx.font = (o.bold ? 'bold ' : '') + (o.size || 13) + 'px sans-serif';
  ctx.fillStyle = o.color || C.text;
  // 先落锚点再量：actualBoundingBoxLeft/Right 是**相对当前 textAlign 锚点**的距离，
  // 继承调用方的 align/baseline 去量、再换锚点去画，等于双重偏移（复测踩过）
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText(s);
  const bb =
    m &&
    typeof m.actualBoundingBoxAscent === 'number' &&
    typeof m.actualBoundingBoxDescent === 'number' &&
    typeof m.actualBoundingBoxLeft === 'number' &&
    typeof m.actualBoundingBoxRight === 'number'
      ? m
      : null;
  if (!bb) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, cx, cy + (o.dy || 0));
    ctx.restore();
    return m.width;
  }
  // 墨迹盒：x ∈ [锚点−bbLeft, 锚点+bbRight]（bbLeft 正方向朝左）、y ∈ [锚点−bbAscent, 锚点+bbDescent]
  const ax = cx - (bb.actualBoundingBoxRight - bb.actualBoundingBoxLeft) / 2;
  const ay = cy + (bb.actualBoundingBoxAscent - bb.actualBoundingBoxDescent) / 2 + (o.dy || 0);
  ctx.fillText(s, ax, ay);
  ctx.restore();
  return m.width;
}

/**
 * 齿轮（矢量，2026-11-05）：设置钮专用图标。
 *
 * 为什么不用 ⚙️ 字形：U+2699 属「默认文字表现」，必须跟变体选择符 U+FE0F 才有
 * 彩色 emoji 形态；带 FE0F 的字形序列在真机 canvas 上度量不稳定（幻影进位 /
 * 回退字体差异，actualBoundingBox* 也不可靠），量宽居中就偏 —— 真机上 🔊📋💬🤖
 * 这类**默认 emoji 表现**（无 VS16）的单码点字形都好好的，唯独带 VS16 的
 * 🎙️/⚙️ 不居中（2026-11-05 二次报障；桌面 Chromium 复测是好的，真机不是同一套
 * 字体栈）。矢量画法与平台/字体完全无关，几何中心即圆心，天然居中。
 *
 * 中孔用 evenodd 挖空；极老基础库忽略 fillRule 时退成实心齿轮 —— 只影响造型，
 * 不影响居中。调用方自管颜色（railBtn 的 on/muted 状态色）。
 */
function gear(ctx, cx, cy, r, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = color;
  const teeth = 8;
  const step = (Math.PI * 2) / teeth;
  const tw = step * 0.42; // 齿的角宽（其余为齿根）
  ctx.beginPath();
  for (let i = 0; i < teeth; i++) {
    const a = (i * step) - Math.PI / 2;
    ctx.arc(0, 0, r, a, a + tw, false); // 齿顶
    ctx.arc(0, 0, r * 0.72, a + tw, a + step, false); // 齿根
  }
  ctx.closePath();
  const hole = r * 0.34;
  ctx.moveTo(hole, 0);
  ctx.arc(0, 0, hole, 0, Math.PI * 2, true); // 内环 → evenodd 挖孔
  ctx.fill('evenodd');
  ctx.restore();
}

function measure(ctx, str, size, bold) {
  ctx.font = (bold ? 'bold ' : '') + (size || 13) + 'px sans-serif';
  return ctx.measureText(String(str == null ? '' : str)).width;
}

/** 通用面板（.panel：圆角 + 细边 + 微亮底） */
function panel(ctx, r, opts) {
  const o = opts || {};
  ctx.fillStyle = o.bg || C.panelBg;
  roundRect(ctx, r.x, r.y, r.w, r.h, o.radius == null ? 8 : o.radius);
  ctx.fill();
  if (o.border !== false) {
    ctx.strokeStyle = o.borderColor || C.panelBorder;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/**
 * 页面背景（app.wxss .bg-felt/lattice/cloud/plain 的 canvas 对位）。
 * bg id 持久化在 mj-bg（home 向导切换，全局生效）。
 */
function pageBg(ctx, L, bg) {
  const sw = L.sw;
  const sh = L.sh;
  ctx.fillStyle = C.page;
  ctx.fillRect(0, 0, sw, sh);
  if (bg === 'felt') {
    const g = ctx.createRadialGradient(sw / 2, sh * 0.3, 0, sw / 2, sh * 0.3, Math.max(sw, sh) * 0.7);
    g.addColorStop(0, '#1d4030');
    g.addColorStop(0.7, '#14241c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sw, sh);
  } else if (bg === 'lattice') {
    // 回纹：±45° 双向斜线（repeating-linear-gradient 对位），条宽 12px、金色 6% 透明度
    ctx.save();
    ctx.strokeStyle = 'rgba(230,193,75,0.06)';
    ctx.lineWidth = 12;
    const step = 24;
    for (let x = -sh; x < sw + sh; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + sh, sh);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + sh, 0);
      ctx.lineTo(x, sh);
      ctx.stroke();
    }
    ctx.restore();
  } else if (bg === 'cloud') {
    let g = ctx.createRadialGradient(sw * 0.2, sh * 0.2, 0, sw * 0.2, sh * 0.2, Math.max(sw, sh) * 0.45);
    g.addColorStop(0, 'rgba(230,193,75,0.12)');
    g.addColorStop(1, 'rgba(230,193,75,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sw, sh);
    g = ctx.createRadialGradient(sw * 0.8, sh * 0.7, 0, sw * 0.8, sh * 0.7, Math.max(sw, sh) * 0.45);
    g.addColorStop(0, 'rgba(120,180,150,0.14)');
    g.addColorStop(1, 'rgba(120,180,150,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sw, sh);
  }
  // plain：纯底色，已铺
}

module.exports = { C, BGS, roundRect, hit, fitText, wrapText, text, icon, gear, measure, panel, pageBg };
