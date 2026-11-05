/**
 * 服务端配置装载（2026-11-03）：**环境变量 > mahjong.config.json > 内置默认**。
 *
 * 之前所有配置只能走环境变量（`PORT` / `MAHJONG_*` / `WX_*`），Windows 下 set 临时变量、
 * 部署平台配变量都很繁琐；现在仓库根放一份 `mahjong.config.json` 即可持久化全部配置，
 * 环境变量仍可逐项覆盖（CI / 临时调试不改文件）。
 *
 * 用法（index.ts / wxvoice.ts）：
 *   const PORT = cfg.num('PORT', 'port', 3130);
 *                        ^环境变量名  ^配置文件键   ^两层都没有时的默认值
 *
 * 配置文件键用小驼峰（与 agent.md §7 环境变量表一一对应，见 docs/guides/setup-and-run.md §6.1）。
 * 布尔值兼容 `true/false`、`'1'/'0'`、`'on'/'off'`。数值/布尔解析失败时静默回退默认并告警一次。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // packages/server/src
/** 仓库根：config.ts 永远在 <root>/packages/server/src/ 下，比按 cwd 找更稳 */
const ROOT = join(here, '..', '..', '..');
export const CONFIG_FILE = join(ROOT, 'mahjong.config.json');

let fileCfg: Record<string, unknown> = {};
let warned = false;
try {
  if (existsSync(CONFIG_FILE)) {
    // Windows 记事本等工具保存会带 UTF-8 BOM，JSON.parse 不认 —— 读进来先剥掉
    const text = readFileSync(CONFIG_FILE, 'utf8').replace(/^\uFEFF/, '');
    fileCfg = JSON.parse(text);
    console.log(`[config] 已加载 ${CONFIG_FILE}`);
  }
} catch (e) {
  if (!warned) {
    warned = true;
    console.warn(`[config] ${CONFIG_FILE} 解析失败，忽略配置文件层：`, (e as Error).message);
  }
}

/** 两层取值：环境变量优先（空串视为未设），其次配置文件（null / 空串视为未设） */
function raw(envKey: string, fileKey: string): unknown {
  const ev = process.env[envKey];
  if (ev !== undefined && ev !== '') return ev;
  const fv = fileCfg[fileKey];
  if (fv !== undefined && fv !== null && fv !== '') return fv;
  return undefined;
}

export function str(envKey: string, fileKey: string, dflt: string): string {
  const v = raw(envKey, fileKey);
  return v === undefined ? dflt : String(v);
}

export function num(envKey: string, fileKey: string, dflt: number): number {
  const v = raw(envKey, fileKey);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    if (!warned) {
      warned = true;
      console.warn(`[config] ${envKey}/${fileKey} = ${JSON.stringify(v)} 不是数字，用默认 ${dflt}`);
    }
    return dflt;
  }
  return n;
}

/** 开关：接受布尔 true/false 或 '1'/'0' / 'on'/'off' / 'true'/'false' */
export function bool(envKey: string, fileKey: string, dflt: boolean): boolean {
  const v = raw(envKey, fileKey);
  if (v === undefined) return dflt;
  if (typeof v === 'boolean') return v;
  const s = String(v).trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'off') return false;
  if (!warned) {
    warned = true;
    console.warn(`[config] ${envKey}/${fileKey} = ${JSON.stringify(v)} 不是开关值，用默认 ${dflt}`);
  }
  return dflt;
}
