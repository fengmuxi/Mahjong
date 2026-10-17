/**
 * 掷骰覆盖层的共享数据构造（对局页与大厅页共用，模板见 `templates/dice.wxml`，
 * 样式在 `app.wxss` 的「掷骰覆盖层」段）。
 *
 * 视觉对齐 web 端（`packages/client/src/style.css` 的 `.die`）：
 *   九宫格点子 + 渐变立体 + 翻滚关键帧，**不再是「白方块 + 一个大数字」**。
 * 1、4 点为红色（中式骰子）。
 */

/** 各点数在 3×3 宫格里的位置（与 web 端 main.ts 的 PIP 表一致） */
const PIP = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

/** 点数 → 3×3 网格：0 = 空位，1 = 黑点，2 = 红点 */
function dieGrid(v) {
  const cells = PIP[v] || [];
  const red = v === 1 || v === 4;
  const flat = [];
  for (let i = 0; i < 9; i += 1) flat.push(cells.indexOf(i) >= 0 ? (red ? 2 : 1) : 0);
  return [flat.slice(0, 3), flat.slice(3, 6), flat.slice(6, 9)];
}

/** 翻滚期间的随机面 */
function randFace() {
  return 1 + Math.floor(Math.random() * 6);
}

/**
 * 两枚骰子的渲染数据。`idx` 是稳定 key（setData 时不重建节点，翻滚动画才不会被打断），
 * 同时用来给第二枚错开动画相位。
 */
function pair(a, b, tumbling, land) {
  return [
    { idx: 0, rows: dieGrid(a), tumbling: !!tumbling, land: !!land },
    { idx: 1, rows: dieGrid(b), tumbling: !!tumbling, land: !!land },
  ];
}

module.exports = { dieGrid, randFace, pair, PIP };
