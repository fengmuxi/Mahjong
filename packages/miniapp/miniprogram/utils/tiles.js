/**
 * 牌面贴图加载（web 端 `tileart.ts` 的小程序版本）。
 *
 * 差异：
 *   · 小程序没有 `HTMLImageElement`，用 canvas 2d 节点的 `createImage()` 造图；
 *   · 图片来自主包 `tiles/`（方案 P5：4.4MB 原图降采样后 ≈0.7MB 入主包），
 *     路径为包内绝对路径；分包未就绪或路径不可达时 `tileArt()` 返回 null，
 *     画布自动回退**文字牌面**（与 web 端贴图未加载完的行为一致，功能不中断）。
 */

const PATHS = [];
for (let i = 0; i <= 33; i++) {
  PATHS.push(`/tiles/t${String(i).padStart(2, '0')}.png`);
}

const cache = new Map();
let pending = 0;
let onAllCb = null;

/** 启动即加载 34 张；全部完成（含失败）后回调一次，供页面重绘 */
function preload(canvasNode, onAllLoaded) {
  if (!canvasNode || typeof canvasNode.createImage !== 'function') {
    if (onAllLoaded) onAllLoaded();
    return;
  }
  onAllCb = onAllLoaded || null;
  for (let idx = 0; idx <= 33; idx++) {
    const img = canvasNode.createImage();
    pending += 1;
    const done = () => {
      pending -= 1;
      if (pending <= 0 && onAllCb) {
        const cb = onAllCb;
        onAllCb = null;
        cb();
      }
    };
    img.onload = done;
    img.onerror = done;
    img.src = PATHS[idx];
    cache.set(idx, img);
  }
  if (pending === 0 && onAllCb) {
    const cb = onAllCb;
    onAllCb = null;
    cb();
  }
}

/** 取牌面贴图；未就绪返回 null（调用方回退文字绘制） */
function tileArt(t) {
  const img = cache.get(t);
  if (!img) return null;
  // 小程序 CanvasImage 用 width/height 表达已解码尺寸
  const w = img.width || 0;
  if (!w) return null;
  return img;
}

module.exports = { PATHS, preload, tileArt };
