/**
 * 掷骰覆盖层（小程序端 templates/dice.wxml + app.wxss「掷骰覆盖层」段的对位物，
 * 对局页与大厅页共用）。
 *
 * 动画语义逐项对照：
 *   · 乱滚 100ms 一换（setInterval）+ 翻滚关键帧 420ms 循环（旋转 + 上下抛落 + 缩放）；
 *   · tumbleMs 后落定：定格回弹（dice-land 0.36s，scale 1.14→0.95→1）；
 *   · hideMs 后整体收起（clear）；
 *   · 第二枚骰子错开相位（CSS .die-slot.b 的 -0.17s delay 对位 phase 偏移）。
 * 1、4 点红色（中式骰子），点子用 utils/dice.js 的 dieGrid（3×3，与小程序端同一份数据）。
 */

const diceUtil = require('../../utils/dice.js');
const draw = require('./draw.js');
const toast = require('./toast.js');

const TUMBLE_MS = 420; // 翻滚周期（css dice-tumble 0.42s）

class DiceFx {
  constructor() {
    this.shown = false;
    this.msg = '';
    this.a = 1;
    this.b = 1;
    this.tumbling = false;
    this.landAt = 0; // 落定时刻（回弹动画起点）
    this.landPhaseB = -170; // 第二枚错开相位（css -0.17s）
    this._scramble = null;
    this._land = null;
    this._hide = null;
  }

  /**
   * 播一场骰子（对位 runDiceAnim）：开场收 toast，100ms 乱滚，tumbleMs 落定，
   * hideMs 后收层。key 去重由调用方（renderLobby / 对局页 playDice）负责。
   */
  run(dice, rollingMsg, landMsg, tumbleMs, hideMs) {
    this.clear();
    toast.hold();
    this.shown = true;
    this.msg = rollingMsg;
    this.a = diceUtil.randFace();
    this.b = diceUtil.randFace();
    this.tumbling = true;
    this.landAt = 0;
    this._scramble = setInterval(() => {
      this.a = diceUtil.randFace();
      this.b = diceUtil.randFace();
    }, 100);
    this._land = setTimeout(() => {
      if (this._scramble) {
        clearInterval(this._scramble);
        this._scramble = null;
      }
      this.tumbling = false;
      this.a = dice[0];
      this.b = dice[1];
      this.landAt = Date.now();
      this.msg = landMsg;
    }, tumbleMs);
    if (hideMs !== undefined) {
      this._hide = setTimeout(() => this.clear(), hideMs);
    }
  }

  clear() {
    if (this._scramble) clearInterval(this._scramble);
    if (this._land) clearTimeout(this._land);
    if (this._hide) clearTimeout(this._hide);
    this._scramble = this._land = this._hide = null;
    const wasShown = this.shown;
    this.shown = false;
    // 收尾放出挂起的 toast（对位 clearDice → ui.flushDiceToast）
    if (wasShown) toast.flush();
  }

  /** 场景 exit 时必须调用（乱滚 interval 不清会一直跑） */
  dispose() {
    this.clear();
  }

  render(ctx, L) {
    if (!this.shown) return;
    const now = Date.now();
    // .layer 遮罩
    ctx.fillStyle = draw.C.layerBg;
    ctx.fillRect(0, 0, L.sw, L.sh);

    // .dice-box（紧凑档：padding 14px 22px，两枚 50px 骰 + 说明行 12px）
    const die = 50;
    const padX = 22;
    const padY = 14;
    const gap = 20;
    const msgFont = 12;
    // 说明行按 .dice-msg{max-width:86vw} 逐字折行；盒子不再按骰宽写死 164px ——
    // 旧版 26 字硬切实测行长 240px+，文字戳出盒子边框（2026-11-02 报障）。
    // 盒子改为内容撑开（对位小程序端 .dice-box 无宽度、align-items:center 的收缩盒）。
    this.msgLines = this.msg ? draw.wrapText(ctx, this.msg, msgFont, L.sw * 0.86) : [];
    let textW = 0;
    for (const line of this.msgLines) textW = Math.max(textW, draw.measure(ctx, line, msgFont));
    const rowW = die * 2 + gap;
    const boxW = Math.max(rowW, textW) + padX * 2;
    const boxH = padY + die + 10 + this.msgLines.length * (msgFont + 4) + padY;
    const bx = (L.sw - boxW) / 2;
    const by = (L.sh - boxH) / 2;
    ctx.fillStyle = 'rgba(20,36,28,0.96)';
    draw.roundRect(ctx, bx, by, boxW, boxH, 8);
    ctx.fill();
    ctx.strokeStyle = 'rgba(230,193,75,0.4)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // 两枚骰子（骰行在盒内水平居中 —— 对位 .dice-box align-items:center；
    // 盒子被文字撑宽后不能再从 padX 起排，否则骰行偏左）
    const cy = by + padY + die / 2;
    const ax = bx + (boxW - rowW) / 2 + die / 2;
    const bxx = ax + die + gap;
    this.die(ctx, ax, cy, this.a, now, 0);
    this.die(ctx, bxx, cy, this.b, now, this.landPhaseB);

    // 说明行（.dice-msg 12px #f6e3a1 居中）
    this.msgLines.forEach((line, i) => {
      draw.text(ctx, line, L.sw / 2, by + padY + die + 10 + (msgFont + 4) * (i + 0.5), {
        size: msgFont,
        color: draw.C.goldSoft,
        align: 'center',
      });
    });
  }

  /** 单枚骰子：槽位（固定朝下落影）+ 本体（翻滚旋转 / 落定回弹）+ 九宫格点子 */
  die(ctx, cx, cy, value, now, phase) {
    const d = 50;
    const r = d / 2;
    // 落影（.die-shadow：抛得越高越小越淡；随翻滚相位同步，与本体不脱节）。
    // 关键帧对位：0% scale1/α0.5 → 50% scale0.62/α0.24 → 100% 回 1/0.5
    let shScale = 1;
    let shAlpha = 0.5;
    if (this.tumbling) {
      const t = ((now + phase) % TUMBLE_MS) / TUMBLE_MS;
      const w = 0.5 - Math.sin(t * Math.PI * 2) * 0.5; // 0..1..0
      shScale = 1 - 0.38 * w;
      shAlpha = 0.5 - 0.26 * w;
    } else if (this.landAt) {
      const t = Math.min(1, (now - this.landAt) / 360);
      shAlpha = 0.5 + 0.1 * Math.sin(t * Math.PI); // 落定瞬间略深
    }
    ctx.fillStyle = 'rgba(0,0,0,' + shAlpha.toFixed(3) + ')';
    ctx.beginPath();
    ctx.ellipse(cx, cy + r + 4, r * 0.9 * shScale, 5 * shScale, 0, 0, Math.PI * 2);
    ctx.fill();

    let rot = 0;
    let dy = 0;
    let scale = 1;
    if (this.tumbling) {
      const t = ((now + phase) % TUMBLE_MS) / TUMBLE_MS;
      rot = t * 360;
      // 抛落轨迹（对位 keyframes：25% -26rpx、50% +8rpx、75% -14rpx；紧凑档 50px 骰按比例缩）
      const k = d / 96; // rpx 档 96px 骰 → 紧凑档 50px
      dy = t < 0.25 ? -t / 0.25 * 13 * k : t < 0.5 ? (13 - (t - 0.25) / 0.25 * 21) * k : t < 0.75 ? (-8 + (t - 0.5) / 0.25 * 11) * k : (3 - (t - 0.75) / 0.25 * 3) * k;
      scale = 1 + Math.sin(t * Math.PI * 2) * 0.05;
    } else if (this.landAt) {
      // 定格回弹 0.36s（scale 1.14 → 0.95 → 1）
      const t = Math.min(1, (now - this.landAt) / 360);
      scale = t < 0.55 ? 1.14 - (t / 0.55) * 0.19 : 0.95 + ((t - 0.55) / 0.45) * 0.05;
    }

    ctx.save();
    ctx.translate(cx, cy + dy);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(scale, scale);
    // 本体：暖白渐变（左上亮、右下暗）。**先画底色厚边再画本体**：厚边用同一圆角
    // 路径沿 y 偏移扫描填充（不能 fillRect 直角矩形 —— 会从圆角外戳出方角毛边）。
    const g = ctx.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r * 1.25);
    g.addColorStop(0, '#fffdf7');
    g.addColorStop(0.34, '#fbf7ef');
    g.addColorStop(0.68, '#eee7d6');
    g.addColorStop(1, '#dcd2bc');
    // ① 底部厚边（inset 0 -4px 0 #cfc5ac）：圆角矩形向下错 3px 画一层深色，
    //    被本体盖住只露出下缘一条弧边 —— 圆角完整、无方角毛刺
    ctx.fillStyle = '#cfc5ac';
    draw.roundRect(ctx, -r, -r + 3, d, d, 10);
    ctx.fill();
    // ② 本体（渐变面）盖在厚边上，露出下缘 3px 厚度
    ctx.fillStyle = g;
    draw.roundRect(ctx, -r, -r, d, d, 10);
    ctx.fill();
    // ③ 描边一次画完（先 fill 后 stroke 在同一路径上，避免两次 fill 的接缝）
    ctx.strokeStyle = 'rgba(184,172,144,0.9)';
    ctx.lineWidth = 1;
    draw.roundRect(ctx, -r, -r, d, d, 10);
    ctx.stroke();
    // 九宫格点子（10px，1/4 红）。渐变内缩 0.5px 消硬边；点子画在本体坐标系里随转
    const rows = diceUtil.dieGrid(value);
    const cell = (d - 10) / 3; // padding 5
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        const v = rows[gy][gx];
        if (!v) continue;
        const px = -r + 5 + cell * (gx + 0.5);
        const py = -r + 5 + cell * (gy + 0.5);
        const pg = ctx.createRadialGradient(px - 1.5, py - 1.5, 0.5, px, py, 5.5);
        if (v === 2) {
          pg.addColorStop(0, '#e35555');
          pg.addColorStop(0.7, '#9c1616');
          pg.addColorStop(1, 'rgba(156,22,22,0)'); // 末端透明 → 圆周无硬边
        } else {
          pg.addColorStop(0, '#3b3b48');
          pg.addColorStop(0.68, '#101018');
          pg.addColorStop(1, 'rgba(16,16,24,0)');
        }
        ctx.fillStyle = pg;
        ctx.beginPath();
        ctx.arc(px, py, 5.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }
}

module.exports = DiceFx;
