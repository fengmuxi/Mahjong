/// <reference types="vite/client" />
/** 牌面贴图加载：assets/tiles/t00..t33.png → 按牌值索引的 HTMLImageElement */

const mods = import.meta.glob('./assets/tiles/t*.png', {
  eager: true,
  query: '?url',
  import: 'default',
});

const cache = new Map<number, HTMLImageElement>();
let pending = 0;

/** 启动即开始加载；全部解码完成后回调（供界面重绘一次） */
export function preloadTiles(onAllLoaded?: () => void): void {
  for (const [path, url] of Object.entries(mods)) {
    const m = /t(\d{2})\.png$/.exec(path);
    if (!m) continue;
    const idx = Number(m[1]);
    const img = new Image();
    pending++;
    const done = (): void => {
      pending--;
      if (pending <= 0 && onAllLoaded) onAllLoaded();
    };
    img.onload = done;
    img.onerror = done;
    img.src = String(url);
    cache.set(idx, img);
  }
  if (pending === 0 && onAllLoaded) onAllLoaded();
}

/** 取牌面贴图；未加载完成返回 null（调用方回退文字绘制） */
export function tileArt(t: number): HTMLImageElement | null {
  const img = cache.get(t);
  return img && img.complete && img.naturalWidth > 0 ? img : null;
}
