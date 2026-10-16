/**
 * 玩法注册表（P0）：id → RuleSet。
 *
 * 新增玩法只需：① 新建 rules/<id>.ts 实现 RuleSet；② 在此登记一行。
 * 引擎与协议按 id 取用，不 import 任何具体玩法。
 */

import type { RuleSet, VariantMeta } from './types.ts';
import { nanchangRules } from './nanchang.ts';
import { ganzhouRules } from './ganzhou.ts';

export * from './types.ts';

/** 内置玩法表 */
export const VARIANTS: Record<string, RuleSet> = {
  nanchang: nanchangRules,
  ganzhou: ganzhouRules,
};

/** 默认玩法（缺省与向后兼容均指向南昌） */
export const DEFAULT_VARIANT = 'nanchang';

/** 前端可选玩法清单（仅元数据，供首页「选择玩法」渲染与展示） */
export const VARIANT_LIST: VariantMeta[] = Object.values(VARIANTS).map((r) => r.meta);

/** 玩法展示名（未知 id 回退 id 本身，用于房间页角标） */
export function variantName(id: string): string {
  return VARIANTS[id]?.meta.name ?? id;
}

/** 按 id 取玩法；未知 id 回退默认（南昌），保证旧客户端/旧房间不炸 */
export function getRules(id?: string | null): RuleSet {
  return (id ? VARIANTS[id] : undefined) ?? VARIANTS[DEFAULT_VARIANT];
}

export { nanchangRules, ganzhouRules };
