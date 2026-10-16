/**
 * 南昌麻将玩法实现（P0）：把既有纯函数包装为 RuleSet 契约。
 *
 * 本文件**不改变任何现有行为**——所有能力都委托给既有实现
 * （tiles.ts / wincheck.ts / score.ts），仅作为「玩法 = 一份 RuleSet」的样板，
 * 也是后续新增玩法（红中麻将等）的对照参考。
 */

import { chiOptions, fullDeck, rankOf, suitOf, tileName } from '../tiles.ts';
import { analyzeWin, shapeLabel, type WinShape } from '../wincheck.ts';
import { classifyPattern, computeSettlement } from '../score.ts';
import type { RuleSet } from './types.ts';

export const nanchangRules: RuleSet = {
  meta: {
    id: 'nanchang',
    name: '南昌麻将',
    seats: 4,
    handSize: 13,
    desc: '翻精玩法：发牌后掷骰翻出正/副精，精牌可当万能牌，按算子表结算。',
    tags: ['4 人', '136 张', '翻精', '算子结算'],
  },

  tiles: {
    kinds: 34,
    deckSize: 136,
    buildDeck: fullDeck,
    suitOf,
    rankOf,
    nameOf: tileName,
    chiOptions,
  },

  // 翻精玩法：正/副精在发牌后由骰子定位翻出，正副精均可当万能牌
  wild: {
    kind: 'flipped',
    isWild: (t, s) => t === s.pi || t === s.fu,
    isUniversal: (t, s) => t === s.pi || t === s.fu,
  },

  actions: {
    claimPriority: { hu: -1, gang: 0, peng: 1, chi: 2 },
    chiFromLeftOnly: true,
    pengSize: 3,
    gangSize: 4,
    robbingKong: false,
  },

  win: {
    analyze: (i) => analyzeWin(i.concealed, i.melds, i.wild.pi, i.wild.fu, i.literalExtra),
    shapeLabel: (s) => shapeLabel(s as WinShape),
  },

  score: {
    classify: classifyPattern,
    settle: computeSettlement,
  },

  flow: { dealCeremony: true, flipWild: true, gangDice: true, turnOrder: 'ccw' },
};
