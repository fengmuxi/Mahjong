/**
 * Playwright 定位助手（供 scripts/verify 下的视觉 harness 共用）。
 *
 * 仓库不把 playwright 列为依赖（体积大、仅验证用）。可用两种方式提供：
 *   1) 在仓库根目录 `npm i -D playwright`（或 playwright-core）；
 *   2) 设置 `PLAYWRIGHT_REQUIRE` 指向任意能 require('playwright') 的 package.json。
 * 浏览器默认用 Playwright 自带版本；也可用 `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
 * 指定 chrome.exe，或 `PLAYWRIGHT_BROWSERS_PATH` 指定浏览器缓存目录。
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

function loadPlaywright() {
  const reqs = [process.env.PLAYWRIGHT_REQUIRE, path.join(__dirname, '../../package.json')].filter(Boolean);
  for (const rq of reqs) {
    try {
      return createRequire(rq)('playwright');
    } catch (e) {}
  }
  throw new Error('未找到 playwright：请在仓库根目录 npm i -D playwright，或设置 PLAYWRIGHT_REQUIRE');
}

function chromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(base)) return undefined;
  const dir = fs
    .readdirSync(base)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .pop();
  if (!dir) return undefined;
  const exe = path.join(base, dir, 'chrome-win64', 'chrome.exe');
  return fs.existsSync(exe) ? exe : undefined;
}

module.exports = { loadPlaywright, chromiumExecutable };
