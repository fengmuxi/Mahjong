/**
 * P1：把 `packages/shared`（规则 / 协议 / 算分的单一真相源）编译成小程序可直接 require 的
 * CommonJS 产物，输出到 `packages/miniapp/miniprogram/lib/shared/`。
 *
 * 为什么要这一步：
 *   1. shared 是纯 TypeScript、零 DOM 引用，web 与小程序两端共用同一份源码 → 规则不会漂移
 *      （延续 `docs/guides/agent.md` 的铁律：前端不持有规则逻辑）。
 *   2. 源码大量使用「带 .ts 扩展名的相对导入」（`allowImportingTsExtensions`），小程序运行时
 *      不认 `require('./index.ts')`。因此这里先把源码拷到临时目录并去掉导入路径的 `.ts`，
 *      再用 tsc 以 CommonJS 输出。
 *
 * 用法：npm run build:mp
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(dir, '..');
const SRC = path.join(ROOT, 'packages/shared/src');
const TMP = path.join(ROOT, '.tmp-mp-shared');
const OUT = path.join(ROOT, 'packages/miniapp/miniprogram/lib/shared');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copySources(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copySources(src, dst);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    const text = fs.readFileSync(src, 'utf8');
    // 相对导入的 `.ts` 后缀去掉：小程序 require 不认，tsc 也不允许带 .ts 的导入路径
    const fixed = text.replace(/(from\s+['"])(\.{1,2}\/[^'"]+?)\.ts(['"])/g, '$1$2$3');
    fs.writeFileSync(dst, fixed);
  }
}

/** 全部 .ts 都作为入口：保证 resolver / hu-lock 这类「仅被引擎引用」的模块也产出，
 *  将来小程序侧若要复用同一份裁决逻辑可直接 require。 */
function listTs(root) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) out.push(p);
    }
  };
  walk(root);
  return out;
}

function main() {
  rmrf(TMP);
  copySources(SRC, TMP);
  rmrf(OUT);

  const tsc = path.join(ROOT, 'node_modules/typescript/lib/tsc.js');
  const args = [
    tsc,
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--target', 'ES2017',
    '--lib', 'ES2017',
    '--strict',
    '--skipLibCheck',
    '--esModuleInterop',
    '--removeComments', 'false',
    '--outDir', OUT,
    '--rootDir', TMP,
    ...listTs(TMP),
  ];
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    // tsc 对「无类型声明」等场景会非 0 退出，但只要产物落地就继续（校验在下一步做）
    console.warn(`[warn] tsc 退出码 ${res.status}`);
  }
  rmrf(TMP);

  // 自检：产物必须能被 CommonJS require，且关键导出可用。
  // 仓库根 package.json 是 "type": "module"，Node 会把 .js 当 ESM；小程序工具链则按
  // CommonJS 处理，故这里拷到临时目录（补一个 type:commonjs 的 package.json）再校验。
  const idx = path.join(OUT, 'index.js');
  if (!fs.existsSync(idx)) throw new Error('shared 产物缺失，编译失败');
  const VERIFY = path.join(ROOT, '.tmp-mp-verify');
  rmrf(VERIFY);
  fs.mkdirSync(VERIFY, { recursive: true });
  fs.cpSync(OUT, VERIFY, { recursive: true });
  fs.writeFileSync(path.join(VERIFY, 'package.json'), '{"type":"commonjs"}');
  const shared = require(path.join(VERIFY, 'index.js'));
  const tiles = require(path.join(VERIFY, 'tiles.js'));
  const wall = require(path.join(VERIFY, 'wall.js'));
  const rules = require(path.join(VERIFY, 'rules/index.js'));
  const checks = [
    ['CHAT_TEXT_MAX', shared.CHAT_TEXT_MAX === 60],
    ['THROW_EMOJI', Array.isArray(shared.THROW_EMOJI) && shared.THROW_EMOJI.length > 0],
    ['tileName', tiles.tileName(4) === '5万'],
    ['seatWind', typeof tiles.seatWind(1, 1) === 'string'],
    ['VARIANT_LIST', Array.isArray(rules.VARIANT_LIST) && rules.VARIANT_LIST.length >= 2],
    ['DEFAULT_VARIANT', rules.DEFAULT_VARIANT === 'nanchang'],
    ['variantName', rules.variantName('ganzhou').includes('赣州')],
    ['RING_SLOTS', wall.RING_SLOTS === 136],
  ];
  let bad = 0;
  for (const [name, ok] of checks) {
    if (!ok) {
      bad += 1;
      console.error(`  ✗ ${name}`);
    }
  }
  rmrf(VERIFY);
  if (bad > 0) throw new Error('shared 产物自检未通过');
  console.log(`shared 产物已生成：${OUT}`);
  console.log('  自检通过：' + checks.map(([n]) => n).join(' / '));
}

main();
