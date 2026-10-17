"use strict";
/**
 * 玩法注册表（P0）：id → RuleSet。
 *
 * 新增玩法只需：① 新建 rules/<id>.ts 实现 RuleSet；② 在此登记一行。
 * 引擎与协议按 id 取用，不 import 任何具体玩法。
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ganzhouRules = exports.nanchangRules = exports.VARIANT_LIST = exports.DEFAULT_VARIANT = exports.VARIANTS = void 0;
exports.variantName = variantName;
exports.getRules = getRules;
const nanchang_1 = require("./nanchang");
Object.defineProperty(exports, "nanchangRules", { enumerable: true, get: function () { return nanchang_1.nanchangRules; } });
const ganzhou_1 = require("./ganzhou");
Object.defineProperty(exports, "ganzhouRules", { enumerable: true, get: function () { return ganzhou_1.ganzhouRules; } });
__exportStar(require("./types"), exports);
/** 内置玩法表 */
exports.VARIANTS = {
    nanchang: nanchang_1.nanchangRules,
    ganzhou: ganzhou_1.ganzhouRules,
};
/** 默认玩法（缺省与向后兼容均指向南昌） */
exports.DEFAULT_VARIANT = 'nanchang';
/** 前端可选玩法清单（仅元数据，供首页「选择玩法」渲染与展示） */
exports.VARIANT_LIST = Object.values(exports.VARIANTS).map((r) => r.meta);
/** 玩法展示名（未知 id 回退 id 本身，用于房间页角标） */
function variantName(id) {
    var _a, _b;
    return (_b = (_a = exports.VARIANTS[id]) === null || _a === void 0 ? void 0 : _a.meta.name) !== null && _b !== void 0 ? _b : id;
}
/** 按 id 取玩法；未知 id 回退默认（南昌），保证旧客户端/旧房间不炸 */
function getRules(id) {
    var _a;
    return (_a = (id ? exports.VARIANTS[id] : undefined)) !== null && _a !== void 0 ? _a : exports.VARIANTS[exports.DEFAULT_VARIANT];
}
