"use strict";
/**
 * 多玩法契约（P0）：与具体麻将玩法无关的「规则集」接口。
 *
 * 设计目标：新增玩法（红中麻将、长沙麻将…）= 新增一个 RuleSet 实现并注册，
 * 无需修改对局引擎（server/game.ts）与既有南昌实现。
 *
 * 分层：
 *   engine（对局状态机，与玩法无关）
 *     └─ RuleSet（本文件定义的契约）
 *          └─ variants（rules/nanchang.ts …）
 *
 * 约定：牌仍用数字 id（Tile = number），但「id → 牌面语义」由玩法声明。
 */
Object.defineProperty(exports, "__esModule", { value: true });
