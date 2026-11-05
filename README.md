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
| [integration/wechat-minigame.md](integration/wechat-minigame.md) | **微信小游戏端迁移记录**：packages/minigame 的移植决策、平台差异对位实现、功能差异清单、验证记录 |

## 指引（`docs/guides/`）

| 文档 | 说明 |
|---|---|
| [guides/setup-and-run.md](guides/setup-and-run.md) | **环境配置与完整运行示例**：环境要求、安装构建、起服务端、客户端接入、一局完整对局示例、环境变量 / 客户端配置总览、上线清单与排障 |
| [guides/full-audit-2026-10-16.md](guides/full-audit-2026-10-16.md) | 2026-10-16 全面排查与测试报告：问题清单（严重度分级）、修复方案、复测结果 |
| [../agent.md](../agent.md) | 改动前必读（在仓库根）：项目是什么、技术栈、目录职责、编码约定、**规则改动铁律**、环境变量、验证清单、常见坑 |

## 客户端（`packages/minigame` 微信小游戏端）

复用 `packages/shared` 与服务端。web 客户端（`packages/client`，提交 104bfdc）与微信小程序端（`packages/miniapp`）均已移除，**小游戏端是唯一对局入口**。

- **小游戏端（packages/minigame/）**：单画布 `game.js` 入口，协议与规则零改动；启动与配置见 [packages/minigame/README.md](packages/minigame/README.md)，移植记录见 [integration/wechat-minigame.md](integration/wechat-minigame.md)。

## 开发辅助脚本（`scripts/`）

非测试门禁，用于本地核对：

| 脚本 | 作用 |
|---|---|
| `mp_build_shared.mjs` | shared 编译入小游戏（`npm run build:mg`；文件名 `mp_` 为历史命名） |
| `gen_ui_extra.mjs` | 增量生成 UI 贴图：源 `assets/ui/<group>/` → `packages/server/public/ui/`，用完抬 `UI_VER` |
| `variant_settle_server.mjs` | 纯 WebSocket 自动打完一局赣州，验服务端结算窗口（需 `MAHJONG_CEREMONY=0` 起服务端） |
| `verify/*.cjs` | 小游戏渲染层几何 / 规则回归（`geomcheck` / `noisetoast` / `gzgerman`） |
| `mg_geomcheck.cjs` | 小游戏端回归：渲染/命中语义 + 布局几何 + utils 冒烟 |

> 2026-10-24 清理：原先面向 web 客户端（`packages/client`）的截图/交互/背景/聊天脚本
> （`mobile_*` / `bg_*` / `chat_*` / `invite_flow_e2e` / `orient_diag` / `variant_*_e2e` 等）
> 与三个牌面/UI 资源生成器已随该包一起删除——它们加载的页面已不存在。

## 校验方式

项目**不保留自动化测试与回归脚本**（2026-10-15 移除）。改动后的校验手段：

```bash
npm run typecheck   # tsc --noEmit，必须零报错
npm run start       # 起服务端，按规则文档人工验证
npm run build:mg    # 微信小游戏：编译 shared → packages/minigame/game/lib/shared
```

各玩法的**人工验证清单**见对应文档：赣州见 [integration/ganzhou.md](integration/ganzhou.md) §6，南昌见 [rules/nanchang.md](rules/nanchang.md) §10。
