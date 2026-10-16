# 多玩法可扩展架构设计（南昌麻将 → 多麻将引擎）

> 目标：把当前"只支持南昌麻将"的单体，改造为**可插拔多玩法引擎**。新增红中麻将或任何地方玩法时，**只新增一个玩法包，不修改核心引擎**，且现有南昌功能与行为完全不变。

状态：**P0 已落地**（契约定义 + 南昌实现 + 注册表，零行为改动）。后续分期见 §7。

---

## 1. 设计原则

1. **核心引擎不认玩法**：`server/game.ts` 只做与玩法无关的状态机（摸/打/吃碰杠/响应窗口/裁决/流局/轮庄），玩法细节全部经 `RuleSet` 注入。
2. **玩法 = 数据 + 纯函数**：一个玩法就是一份 `RuleSet`（配置 + 若干纯函数），不含状态机。
3. **向后兼容优先**：默认玩法为南昌，`GameView`/协议**只增字段不改语义**；旧路径行为逐位一致。
4. **可证伪**：兼容性以 `npm run typecheck` 零报错 + 按规则文档人工复算/试玩为证，而非口头承诺（自动化测试已于 2026-10-15 移除）。

---

## 2. 现状耦合点清单（改造靶点）

| 位置 | 硬编码的南昌规则 | 抽象归属 |
|---|---|---|
| `tiles.ts` `fullDeck()` | 固定 136 张（万条筒 + 东南西北中发白） | `TileModel.buildDeck` |
| `tiles.ts` `chiOptions()` | 字牌顺子（任意 3 种风）、中发白成组 | `ActionRules` / `TileModel.chiOptions` |
| `tiles.ts` `nextJing()` | 副精 = 正精组内下一张（分组循环） | `WildModel`（flipped 内部实现） |
| `wincheck.ts` `shapeList()` | 字牌顺子形状、风/箭分组 | `WinRules.analyze`（内部） |
| `wincheck.ts` | 平胡 / 大7对 / 小7对 / 十三烂 / 德国 | `WinRules.analyze` |
| `score.ts` `classifyPattern()` | 30 行算子表（M、+5、fold） | `ScoreRules.classify` |
| `score.ts` `computeSettlement()` | 底分、翻倍、+5、冲关、杠精 | `ScoreRules.settle` |
| `game.ts` 构造/翻精 | 翻精仪式、和数定位、正/副精 | `WildModel` + `FlowConfig.flipWild` |
| `game.ts` `wildPoints/wildTileCounts/logGangJing` | 正精 2 / 副精 1、杠精奖励 | `WildModel.points` + `ScoreRules.settle` |
| `game.ts` `tryBuildWin()` | 德中德 / 精吊 / 天地胡 / 杠开 | `WinRules` + `WinContext` |
| `game.ts` `claimOptionsFor()` | 只能吃上家、胡>杠>碰>吃 | `ActionRules` |
| `game.ts` `drawReplacement()` | 杠补掷骰定位 | `FlowConfig.gangDice` |
| `wall.ts` | 68 墩 4 段（20/14）固定牌墙布局 | `WallModel`（P2 引入） |
| `resolver.ts` `PRIORITY` | 优先级权重 | `ActionRules.claimPriority` |

> 结论：耦合点集中在 **牌库 / 赖子 / 胡型 / 算分 / 流程 / 牌墙** 六个切面，正好对应 §4 的六个子接口。

---

## 3. 目标分层

```
┌─────────────────────────────────────────────────────────────┐
│  engine（与玩法无关）                                         │
│    server/game.ts   对局状态机                                │
│    shared/engine/*  响应窗口 / 裁决 / 轮庄（P2 起逐步外提）     │
└───────────────▲─────────────────────────────────────────────┘
                │ 只依赖 RuleSet 契约
┌───────────────┴─────────────────────────────────────────────┐
│  RuleSet 契约   shared/src/rules/types.ts                    │
│    meta · tiles · wild · actions · win · score · flow        │
└───────────────▲─────────────────────────────────────────────┘
                │ 实现
┌───────────────┴─────────────────────────────────────────────┐
│  variants   shared/src/rules/nanchang.ts（✅ 已建）           │
│             shared/src/rules/hongzhong.ts（P5 新增）          │
│             …                                                │
│  registry   shared/src/rules/index.ts  getRules(id)          │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. 核心接口（已落地于 `packages/shared/src/rules/types.ts`）

| 接口 | 职责 | 关键成员 |
|---|---|---|
| `VariantMeta` | 玩法元信息 | `id` `name` `seats` `handSize` |
| `TileModel` | 牌库与牌面语义 | `buildDeck()` `kinds` `deckSize` `suitOf/rankOf/nameOf` `chiOptions()` |
| `WildModel` | 赖子（万能牌） | `kind: 'none'\|'fixed'\|'flipped'` `fixedTiles?` `isWild()` `isUniversal()` |
| `ActionRules` | 动作合法性/裁决 | `claimPriority` `chiFromLeftOnly` `pengSize/gangSize` `robbingKong` |
| `WinRules` | 胡牌判定 | `analyze(WinInput)` `shapeLabel()` |
| `ScoreRules` | 算分 | `classify(ScoreFlags)` `settle(SettleInput)` |
| `FlowConfig` | 流程/仪式 | `dealCeremony` `flipWild` `gangDice` `turnOrder` |
| `RuleSet` | 以上七者聚合 | — |

**设计要点**
- **赖子三态**覆盖全部玩法光谱：南昌 `flipped`（翻精）、红中 `fixed`（固定红中）、部分玩法 `none`。
- **`isWild` 与 `isUniversal` 分离**：支持"红中只计分、不当万能"这类规则。
- **牌型判定交给玩法**：`WinRules.analyze` 返回 `WinAnalysis`（`valid/shapes/german`），引擎只问"能否胡"，不问"为什么"。
- **算分整体可替换**：`ScoreRules.settle` 直接产出逐家 `deltas`，引擎只做零和聚合。

---

## 5. 数据结构与配置项

### 5.1 牌表示（保持不变）
`Tile = number`（0–33）。**每种玩法的 id→牌面映射由其 `TileModel` 声明**，引擎只当作不透明整数处理。这样牌墙槽位、手牌数组、协议传输全部无需改动。

### 5.2 房间配置
```ts
interface RoomOptions {
  variant: string;                     // ✅ P0.5 已落地（Room.variant，创建房间时按 id 归一）
  switches: Record<string, boolean>;   // P4 启用：回头一笑 / 掷骰补杠 / 精吊+5 / 德国+5
}
```

### 5.3 视图扩展（P5 启用，只增不改）
```ts
interface GameView {
  variant: string;                       // 新增：前端按玩法渲染（当前已在大厅 state 下发，牌桌视图待 P5）
  wild: WildState | null;                // 新增：通用赖子（与 jingPi/jingFu 并存过渡）
  // 其余字段语义不变 → 旧客户端仍可运行
}
```

### 5.4 玩法开关（现有 4 个）
`回头一笑 / 掷骰补杠 / 精吊+5 / 德国+5` 从"南昌专属硬编码"降级为 `switches` 配置项，由玩法声明的默认值 + 房间覆盖决定。

---

## 6. 兼容策略（保证南昌不受影响）

1. **默认注入**：`Game` 增加可选入参 `rules?: RuleSet`，缺省 `getRules('nanchang')`。所有现有调用点不传 → 行为不变。
2. **旧导出保留**：`tiles.ts / wincheck.ts / score.ts / wall.ts` 的现有函数**不删除**，仅被 `rules/nanchang.ts` 引用；外部 import 路径不变。
3. **协议只增字段**：`variant` / `wild` 为新增可选字段；未提供时按南昌处理。
4. **验收门禁**：每期结束必须 `npm run typecheck` 零报错 + `npm run build` 通过 + 按两份规则文档人工复算关键场景。
5. **回退开关**：若某期引入回归，直接不传 `rules` 即回到 P0 前的南昌路径（可即时回滚）。

---

## 7. 分期迁移计划（每期可独立验收）

| 期 | 内容 | 触及文件 | 验收 |
|---|---|---|---|
| **P0 ✅** | 契约 + 南昌实现 + 注册表 | `rules/*`（新增） | `typecheck` 通过，无行为改动 |
| **P0.5 ✅** | 房间玩法落库 + 入口流程「先选玩法 → 创建/加入」+ 准备阶段换位 | `shared/index.ts` `server/index.ts` `client/*` | `typecheck` 零报错 + 换位/入口人工验证 |
| **P1** | 牌库参数化：引擎用 `rules.tiles.buildDeck()` 替代 `fullDeck()` | `game.ts` | typecheck + 人工对局 |
| **P2** | 牌墙/发牌参数化：`WallModel` 抽象 `wall.ts` 布局与环 | `wall.ts` `game.ts` | 人工跑通发牌全流程 |
| **P3** | 赖子参数化：翻精 → `WildModel`；`wildPoints/logGangJing` 走契约 | `game.ts` | 计分测试全绿 |
| **P4** | 胡型/算分参数化：`tryBuildWin` 走 `WinRules`；`computeSettlement` 走 `ScoreRules` | `game.ts` | 按 §6.2 人工复算全表 |
| **P5** | 前端按玩法渲染（`view.variant`）；新增**红中麻将**验证"零改核心接入" | `server/game.ts` 传入 rules；`client/*` | 两玩法各试玩一局 |

> **P5 的判据**：新增红中玩法时，`git diff` 中 **`server/game.ts` 与 `shared/engine/**` 零改动**，只新增 `rules/hongzhong.ts` + 注册一行。这是"可插拔"是否真正达成的唯一硬标准。

---

## 8. 新玩法接入清单（以红中麻将为例）

新增 `packages/shared/src/rules/hongzhong.ts`，实现：

| 能力 | 红中麻将的取值（示例） |
|---|---|
| `tiles.buildDeck` | 万/条/筒 108 张（视规则）＋红中若干，无风牌 |
| `tiles.chiOptions` | 仅数牌顺子（无字牌成组） |
| `wild` | `kind:'fixed'`，`fixedTiles:[红中]`；`isUniversal` 视规则可 true/false |
| `actions` | 沿用 胡>杠>碰>吃；`chiFromLeftOnly:true` |
| `win.analyze` | 平胡 + 七对（无十三烂 / 无德国） |
| `score.classify/settle` | 独立倍数表（无冲关 / 无杠精） |
| `flow` | `flipWild:false`（不翻精）、`gangDice` 视规则 |

并在 `rules/index.ts` 的 `VARIANTS` 登记一行 `hongzhong: hongzhongRules` 即可。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| `game.ts` 中南昌语义与通用流程高度交织 | 分期小步（P1–P4），每期以测试全绿为闸门，失败即不动核心 |
| 不同玩法牌数不同，动态牌墙/槽位可能越界 | P2 抽象 `WallModel` 时，槽位数、段长改为由 `deckSize` 推导 |
| 算分差异大，硬替换易回归 | `ScoreRules.settle` 以"逐家 deltas + 零和"为接口边界，玩法内部自由实现 |
| 前端写死南昌牌面/精显示 | P5 前端按 `view.variant` 选择渲染器；`table.ts` 的精显示改为读 `view.wild` |

---

## 10. 附：本轮产出

### P0（契约层，已落地）
- `packages/shared/src/rules/types.ts` —— 全部核心接口
- `packages/shared/src/rules/nanchang.ts` —— 南昌玩法实现（委托既有纯函数）
- `packages/shared/src/rules/index.ts` —— 注册表 `getRules(id)`
- 本文档

### P0.5（玩法进入房间 + 入口流程 + 换位，已落地）
- **协议**（`shared/src/index.ts`）：`create` 增加可选 `variant`；大厅 `state` 增加 `variant` 与 `pendingSwap`；新增 `swap` / `swapRespond` 客户端消息与 `swapAsk` 服务端消息。全部为**新增字段/类型**，旧客户端不传 `variant` 仍按南昌开局。
- **服务端**（`server/src/index.ts`）：`Room.variant` 由 `getRules(msg.variant).meta.id` 归一（**未知 id 静默回退南昌**）；`applySeatSwap()` 实现换位并在迁移座位时同步 `binding` / `tokens` / `hostSeat` / `nextDealer`；换位请求单飞（`pendingSwap`）、任一方离开自动作废（`dropPendingSwapOf`）、开局即作废。
- **前端**（`client/`）：首页第 ① 步 `renderVariants()` 从 `VARIANT_LIST` 渲染玩法卡片（默认选中记忆在 `localStorage`），第 ② 步才填昵称并创建/加入；邀请链接（`?room=`）直达时隐藏玩法选择；房间页角标显示本桌玩法；大厅座位可点 → 空位直换 / 有人弹窗征求同意。
- **`VariantMeta` 扩展**：新增可选 `desc` / `tags`，供玩法卡片展示；`VARIANT_LIST` 从 `VARIANTS` 派生，新增玩法**无需改前端**。

> P0 不修改任何现有行为；P0.5 仅让"玩法 id"进入房间与入口流程，并补上换位这一大厅能力——`server/game.ts` **未改动一行**，红中麻将的接入仍待 P1–P5。

---

## 11. 赣州冲关麻将接入（2026-10 · 第二玩法落地）

`ganzhou` 已按 RuleSet 契约接入并注册（`rules/ganzhou.ts` + `VARIANTS`），前端玩法卡片、
房间落库、入口流程**零改动**自动生效。与南昌差异过大（12 精位只结算不万能、乱风任意 3 字牌
成组、有精胡牌受限、胡牌分与精分分开算、精分+杠分四人交叉、全包、抢杠胡、杠后掷骰定位补牌、
抄庄、正精墩即海底），落地方式：

- **纯函数模块**：`shared/src/gzjing.ts`（精牌模型）/ `gzwin.ts`（胡型判定）/ `gzscore.ts`（结算）
  + `rules/gzconfig.ts`（全部可配数值）；引擎经 `rules.tiles` / `rules.actions.robbingKong` /
  `rules.flow` 契路消费，差异逻辑集中在少量玩法分支（`game.ts` 的 `gz` getter）。
- **契约增量**（只增可选字段）：`WinInput.gzJing/gzGankai`、`ScoreRules.settleGz?`、
  `FlowConfig.skipRon?`、`WildState.gz`、`WinAnalysis.gz`、协议 `GameView.gz` 与 `settle.gz`。
- **口径确认（2026-10-15 牌友）**：精霸=整套正副精独占；精分含牌河；无霸王精；小七不允暗杠；
  天和/地和严格定义；补牌=牌墙尾倒数 S 墩；一炮多响按逆时针；全包含杠分+精分且帮另两家出；
  胡牌分与精分分开算；德中德=德国+任意牌型+其余三家无精；抄庄；精墩前缘为海底。14 条确认记录 +
  9 条待确认事项见 `docs/integration/ganzhou.md` §7/§8。
- **校验**：`npm run typecheck` + `npm run build` 零报错，并按 `docs/integration/ganzhou.md` §6 的人工验证清单逐条试玩（含 §7.4 结算示例算式复核）。自动化测试已于 2026-10-15 移除。

> 遗留：① `ganzhou` 的 `score.settle`（南昌形状）为显式抛错占位，`settle` 泛型化（P6）后可移除；
> ② 南昌补牌公式是否也改为「牌墙尾倒数 S 墩」待用户确认（`docs/rules/nanchang.md` §3 现记为「从摸牌处逆时针数 S 列」）；
> ③ `game.ts` 的玩法分支后续可按 P3/P4 计划继续上提为契约方法。
