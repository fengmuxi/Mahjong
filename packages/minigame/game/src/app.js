/**
 * 运行时单例：main.js 启动时填充，场景 / chrome 直接 require 使用（避免层层传参）。
 *
 * 与 state.js 的分工：state 是「业务共享量」（对位 app.js globalData），
 * app 是「运行时资源」（画布 / 上下文 / 离屏宿主 / dpr），两份都模块级单例。
 */

const app = {
  /** 屏上主画布（wx.createCanvas() 第一次调用的返回值） */
  canvas: null,
  /** 主画布 2d 上下文（backing store = 屏幕 × dpr，每帧 setTransform 回逻辑 px） */
  ctx: null,
  /** 设备像素比（上限 2，与小程序端同一钳制） */
  dpr: 1,
  /**
   * 牌桌离屏画布（Table 的渲染目标）。
   *
   * utils/table.js 的 applyBackingStore() 会把宿主画布 width/height 设成 1280×640×dpr
   * （小程序端它独占一个 <canvas type="2d"> 节点、CSS 尺寸负责缩放）。小游戏端主画布
   * 是全屏的、还有 chrome 要画，所以给 Table 一张**离屏画布**，主循环每帧把宿主
   * drawImage 到主画布的桌面矩形 —— table.js 一行不改，合成层自己接管缩放。
   */
  tableHost: null,
  /** 主循环里 blit 宿主用的桌面矩形（布局坐标，game 场景每帧写入） */
  tableBox: null,
};

module.exports = app;
