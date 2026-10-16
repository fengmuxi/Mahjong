/**
 * 赣州冲关麻将 · 胡牌判定（规则 §6）——纯函数，可单测
 *
 * 与南昌的核心差异：
 *   1. **精牌不当万能牌**（§3.3 / §3.6 三类对照表）——全部门牌按本身牌面分解，没有赖子通配；
 *      三类（明面正精 / 隐藏正精 / 副精）**都不能**当「精」凑牌型；隐藏正精即使被摸到，
 *      也只能按正精计分。本文件的分解函数 `gzDecompose` 连 wild 参数都没有，
 *      **结构上就不可能拿精凑牌**——新增任何通配能力都必须先改 `gzIsWildcard`。
 *   2. **乱风**（§四）——任意 3 张不重复字牌成一组，字牌之间可以相吃；
 *   3. **有精胡牌受限**（§6.5）——手上有精只能：精吊（精作将）/ 特殊牌型 /
 *      精归位后无精走德国；**不得平胡**（杠开豁免除外）；
 *   4. **德国 = 手上无精**（§6.4），德中德 = 德国 + 大牌型（×4）。
 */

import type { Meld, Tile } from './index.ts';
import { tileCounts } from './tiles.ts';
import { checkShisanlan, isSmallSevenPairs } from './wincheck.ts';
import { GZ_CONFIG } from './rules/gzconfig.ts';
import { gzJingPointsOf, gzJingSlots, type GzJing } from './gzjing.ts';

export type GzShape = 'pinghu' | 'small7' | 'big7' | 'shisanlan';

export interface GzWinFacts {
  /** 是否存在合法胡型（含 §6.5 有精限制） */
  valid: boolean;
  /** 命中的牌型（结算取最高底分） */
  shapes: GzShape[];
  /** 七星十三烂（十三烂 + 七种字牌齐全，§6.1） */
  qixing: boolean;
  /** 手上有精牌（暗牌，含胡进那张；§6.5） */
  hasJing: boolean;
  /** 精吊：精牌作将牌（平胡 / 大七对型）或七对含精对（§6.5，+5 分） */
  jingdiao: boolean;
  /** 德国：手上无精（§6.4，+8 分） */
  german: boolean;
  /** 牌型底分（§6.1；多牌型并存取最高） */
  patternBase: number;
}

// ---------- 无万能牌的标准型分解 ----------

/**
 * 为锚定在 k 的 g 个「字牌组」选取 2g 张后继字牌（每种至多 g 张——保证能两两配成
 * 牌面互异的组）；枚举所有可行选取并逐个尝试后续分解。成功返回 true（counts 已扣减）。
 */
function takeGroupTiles(
  counts: number[],
  k: number,
  g: number,
  setsLeft: number,
  pairLeft: boolean,
  allowSeq: boolean,
): boolean {
  const later: number[] = [];
  for (let j = k + 1; j < 34; j++) if (counts[j] > 0) later.push(j);
  const rec = (idx: number, left: number): boolean => {
    if (idx === later.length) {
      return left === 0 && decompStep(counts, k + 1, setsLeft - g, pairLeft, allowSeq);
    }
    const max = Math.min(counts[later[idx]], g, left);
    for (let m = 0; m <= max; m++) {
      counts[later[idx]] -= m;
      if (rec(idx + 1, left - m)) return true;
      counts[later[idx]] += m;
    }
    return false;
  };
  return rec(0, 2 * g);
}

/** 分解递归：本位牌的出路只有「锚定在本位的组 / 顺子 / 刻子 / 对子」，张数唯一确定 */
function decompStep(
  counts: number[],
  k: number,
  setsLeft: number,
  pairLeft: boolean,
  allowSeq: boolean,
): boolean {
  if (k === 34) return setsLeft === 0 && !pairLeft;
  const c = counts[k];
  if (c === 0) return decompStep(counts, k + 1, setsLeft, pairLeft, allowSeq);

  if (k >= 27) {
    // 字牌：刻子 / 对子 / 任意 3 张不同字牌的组（组锚定在组内最小牌，§四）
    for (let t = 0; 3 * t <= c; t++) {
      for (let p = 0; p <= 1; p++) {
        if (p === 1 && (!pairLeft || c - 3 * t < 2)) continue;
        const g = c - 3 * t - 2 * p;
        if (g < 0 || g > setsLeft) continue;
        if (g > 0 && !allowSeq) continue;
        counts[k] = 0;
        const ok =
          g === 0
            ? decompStep(counts, k + 1, setsLeft - t, pairLeft && p === 0, allowSeq)
            : takeGroupTiles(counts, k, g, setsLeft - t, pairLeft && p === 0, allowSeq);
        counts[k] = c;
        if (ok) return true;
      }
    }
    return false;
  }

  // 数牌：顺子（锚定起点，同花色连续 3 张）/ 刻子 / 对子
  const canRun = k % 9 <= 6;
  for (let t = 0; 3 * t <= c; t++) {
    for (let p = 0; p <= 1; p++) {
      if (p === 1 && (!pairLeft || c - 3 * t < 2)) continue;
      const r = c - 3 * t - 2 * p;
      if (r < 0 || r > setsLeft - t) continue;
      if (r > 0 && (!allowSeq || !canRun)) continue;
      if (canRun && (counts[k + 1] < r || counts[k + 2] < r)) continue;
      counts[k] = 0;
      counts[k + 1] -= r;
      counts[k + 2] -= r;
      const ok = decompStep(counts, k + 1, setsLeft - t - r, pairLeft && p === 0, allowSeq);
      counts[k] = c;
      counts[k + 1] += r;
      counts[k + 2] += r;
      if (ok) return true;
    }
  }
  return false;
}

/**
 * 无万能牌分解：counts 拆成 needSets 个面子 +（可选）一个对子。
 * allowSeq = false 时只认刻子（大七对用：无顺子、无字牌组）。
 */
export function gzDecompose(counts: number[], needSets: number, needPair: boolean, allowSeq: boolean): boolean {
  if (needSets < 0) return false;
  return decompStep([...counts], 0, needSets, needPair, allowSeq);
}

// ---------- 吃牌选项（乱风，§四） ----------

/**
 * 吃的组合：返回手牌中用到的两张牌。
 * 数牌：同花色夹张 / 边张；字牌：**任意 2 种不同字牌** + 打出张 = 3 张不重复成组。
 */
export function gzChiOptions(hand: Tile[], discard: Tile): Tile[][] {
  const res: Tile[][] = [];
  const c = tileCounts(hand);
  if (discard < 27) {
    const base = Math.floor(discard / 9) * 9;
    const r = discard % 9;
    const cands: [number, number][] = [
      [r - 2, r - 1],
      [r - 1, r + 1],
      [r + 1, r + 2],
    ];
    for (const [a, b] of cands) {
      if (a < 0 || b > 8) continue;
      if (c[base + a] > 0 && c[base + b] > 0) res.push([base + a, base + b]);
    }
    return res;
  }
  // 乱风：手里任意 2 种不同字牌即可与打出的字牌成组（东+南 吃西、东+中 吃南 均算）
  const others: Tile[] = [];
  for (let t = 27; t < 34; t++) if (t !== discard && c[t] > 0) others.push(t);
  for (let i = 0; i < others.length; i++) {
    for (let j = i + 1; j < others.length; j++) res.push([others[i], others[j]]);
  }
  return res;
}

// ---------- 胡牌分析 ----------

/** 精牌牌面去重（精吊判定用） */
function jingKinds(j: GzJing): Tile[] {
  return [...new Set(gzJingSlots(j).map((s) => s.tile))];
}

/**
 * 一次完整胡牌分析（§6）。
 * @param concealed 暗牌（含刚摸 / 点炮那张），melds 副露
 * @param gankai 是否杠上补牌胡（平胡豁免精吊限制，§6.6）
 */
export function gzAnalyzeWin(concealed: Tile[], melds: Meld[], jing: GzJing, gankai: boolean): GzWinFacts {
  const counts = tileCounts(concealed);
  const setsNeeded = 4 - melds.length;
  const noChi = melds.every((m) => m.type !== 'chi');

  const shapes: GzShape[] = [];
  let pinghu = false;
  let big7 = false;
  if (setsNeeded >= 0) {
    pinghu = gzDecompose(counts, setsNeeded, true, true);
    if (pinghu) shapes.push('pinghu');
    if (noChi) {
      big7 = gzDecompose(counts, setsNeeded, true, false);
      if (big7) shapes.push('big7');
    }
  }
  const small7 = melds.length === 0 && isSmallSevenPairs(counts, 0);
  if (small7) shapes.push('small7');
  const sls = checkShisanlan(concealed, melds, null, null) !== null;
  if (sls) shapes.push('shisanlan');

  // 有精 / 无精（§6.5）：只看暗牌——副露里的精牌视为已「归位」。
  // 三类精牌一视同仁：明面正精、隐藏正精、副精都算「有精」（都按牌面计分、都触发受限）。
  const hasJing = concealed.some((t) => gzJingPointsOf(t, jing) > 0);

  // 精吊：精牌作将牌（平胡 / 大七对），或七对含精对（七对中精牌必成精对）
  let jingdiao = false;
  if (hasJing) {
    if (small7) jingdiao = true;
    if (!jingdiao && setsNeeded >= 0) {
      for (const kind of jingKinds(jing)) {
        if (counts[kind] < 2) continue;
        counts[kind] -= 2;
        const ok =
          gzDecompose(counts, setsNeeded, false, true) || (noChi && gzDecompose(counts, setsNeeded, false, false));
        counts[kind] += 2;
        if (ok) {
          jingdiao = true;
          break;
        }
      }
    }
  }

  // 合法性（§6.5 有精胡牌限制）
  let valid: boolean;
  if (!hasJing) valid = shapes.length > 0;
  else if (jingdiao && (pinghu || big7)) valid = true;
  else if (small7 || big7 || sls) valid = true;
  else valid = gankai && pinghu; // 杠开平胡豁免

  // 七星十三烂（§6.1）
  let qixing = false;
  if (sls) {
    const eff = new Set<Tile>(concealed);
    for (const m of melds) for (const t of m.tiles) eff.add(t);
    qixing = [27, 28, 29, 30, 31, 32, 33].every((w) => eff.has(w));
  }

  // 底分（多牌型并存取最高）
  let patternBase = 0;
  if (qixing) patternBase = GZ_CONFIG.patternBase.qixing;
  else if (big7) patternBase = GZ_CONFIG.patternBase.big7;
  else if (small7 || sls) patternBase = Math.max(GZ_CONFIG.patternBase.small7, GZ_CONFIG.patternBase.shisanlan);
  else if (pinghu) patternBase = GZ_CONFIG.patternBase.pinghu;

  const german = !hasJing; // 德国 = 手上无精（§6.4）
  // 德中德需看其余三家有没有精牌——胡型分析拿不到别家信息，由引擎判定（见 gzIsDezhongde）

  return { valid, shapes, qixing, hasJing, jingdiao, german, patternBase };
}

/**
 * 德中德（§6.4 + 确认口径）：**德国成立 + 任意胡牌牌型（含平胡）+ 其余三家一张精牌都没有** → 胡牌分 ×4。
 * 「没有精牌」按物理持有算（手牌 + 副露 + 牌河——打出无人碰的精仍算他的）。
 * @param german 赢家是否德国（暗牌无精）
 * @param othersHoldings 其余三家的全部持有（手牌 + 副露 + 牌河）
 */
export function gzIsDezhongde(german: boolean, othersHoldings: Tile[][], jing: GzJing): boolean {
  if (!german) return false;
  return othersHoldings.every((tiles) => tiles.every((t) => gzJingPointsOf(t, jing) === 0));
}

/** 胡牌 / 自摸按钮与结果文案的牌型名（普通平胡返回 '平胡'） */
export function gzShapeName(f: GzWinFacts): string {
  if (f.qixing) return '七星十三烂';
  if (f.shapes.includes('big7')) return '大七对';
  if (f.shapes.includes('small7')) return '小七对';
  if (f.shapes.includes('shisanlan')) return '十三烂';
  return '平胡';
}

/** 按钮标签组合（如「精吊·大七对」「德国·小七对·杠开」）；纯平胡返回 null */
export function gzWinLabel(
  f: GzWinFacts,
  gankai: boolean,
  tiandi: 'tian' | 'di' | null,
  dezhongde: boolean,
): string | null {
  const parts: string[] = [];
  const shape = gzShapeName(f);
  if (shape !== '平胡') parts.push(shape);
  if (f.hasJing) parts.push('精吊'); // 有宝 = 走精吊路线（§6.6）
  else parts.push('德国');
  if (dezhongde) parts.push('德中德');
  if (gankai) parts.push('杠开');
  if (tiandi === 'tian') parts.push('天和');
  if (tiandi === 'di') parts.push('地和');
  return parts.length > 0 ? parts.join('·') : null;
}
