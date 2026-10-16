# 文档索引

> 麻将项目（多玩法）的全部文档入口。**规则以 `docs/rules/` 为准，代码在 `packages/`，改规则先改文档。**

## 目录结构与命名规范

```
README.md                      ← 本文：索引与命名规范（在仓库根）
agent.md                       ← 改动指引（在仓库根）：铁律 / 协议 / 坑 / 验证清单
docs/
  rules/<玩法 id>.md           规则文档（玩法唯一真源）
  architecture/*.md            架构设计
  integration/<玩法 id>.md     单个玩法的接入说明
  guides/*.md                  指引与测试记录
```

**命名约定**

| 约定 | 说明 |
|---|---|
| **文件名 = 玩法 id** | `rules/nanchang.md` ↔ `rules/ganzhou.md` ↔ 代码 `rules/index.ts` 的 `VARIANTS` 键、`create` 消息的 `variant` 值。新增玩法即新增同名文件，代码与文档靠 id 一一对应 |
| 全小写 kebab-case | `multi-variant.md`、`ganzhou.md`；不用中文文件名、不用 `RULES.md` 这类大写名 |
| 目录按「文档性质」分 | `rules`（规则）/ `architecture`（架构）/ `integration`（接入）/ `guides`（指引） |
| 根目录不放文档 | 根目录只留 `package.json`、`tsconfig.json`、`packages/`、`scripts/` 等工程文件 |
| 引用一律写相对路径 | 如 `docs/rules/ganzhou.md`；代码注释里也写全路径，便于跳转 |

## 规则文档（`docs/rules/`）

| 文档 | 说明 |
|---|---|
| [rules/nanchang.md](rules/nanchang.md) | **南昌麻将**（默认玩法，v1.19 冻结稿）。规则与算分唯一真源；未覆盖组合以 `packages/shared/src/score.ts` 为准 |
| [rules/ganzhou.md](rules/ganzhou.md) | **赣州冲关麻将**。含 2026-10-15 牌友确认口径（14 条）与修订记录；数值的可调项在 `packages/shared/src/rules/gzconfig.ts` |

## 架构（`docs/architecture/`）

| 文档 | 说明 |
|---|---|
| [architecture/multi-variant.md](architecture/multi-variant.md) | 多玩法可扩展架构：RuleSet 契约、分层、P0–P5 迁移分期、两个玩法的落地记录 |

## 玩法接入（`docs/integration/`）

| 文档 | 说明 |
|---|---|
| [integration/ganzhou.md](integration/ganzhou.md) | 赣州冲关接入改动说明：架构接入点、改动文件清单、配置项、**校验方式（人工验证清单）**、待确认事项 |
| [integration/wechat-miniprogram.md](integration/wechat-miniprogram.md) | **微信小程序迁移方案**：可行性评估（DOM/Canvas/依赖/域名备案/包体积/资质逐项分析）、原生重写路径、P0–P6 分阶段实施、工作量与风险 |

## 指引（`docs/guides/`）

| 文档 | 说明 |
|---|---|
| [guides/full-audit-2026-10-16.md](guides/full-audit-2026-10-16.md) | 2026-10-16 全面排查与测试报告：问题清单（严重度分级）、修复方案、复测结果 |
| [../agent.md](../agent.md) | 改动前必读（在仓库根）：项目是什么、技术栈、目录职责、编码约定、**规则改动铁律**、环境变量、验证清单、常见坑 |

## 开发辅助脚本（`scripts/`）

非测试门禁，用于本地核对：移动端布局/交互（`mobile_shot.mjs`、`mobile_interact.mjs`）、聊天链路（`chat_e2e.mjs`）、背景纹理（`bg_*.mjs`）、图片处理（`clean_bg.py`）。

## 校验方式

项目**不保留自动化测试与回归脚本**（2026-10-15 移除）。改动后的校验手段：

```bash
npm run typecheck   # tsc --noEmit，必须零报错
npm run build       # 客户端构建（改协议/渲染层时必跑）
npm run start       # 起服务端，按规则文档人工验证
```

各玩法的**人工验证清单**见对应文档：赣州见 [integration/ganzhou.md](integration/ganzhou.md) §6，南昌见 [rules/nanchang.md](rules/nanchang.md) §10。
