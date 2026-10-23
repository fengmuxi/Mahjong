# 服务端静态资源台账（public/）

> 2026-10-23 第二十三轮（face 平放牌归位牌面大类）。所有资源**不进小程序代码包**（体检红线：主包 < 1.5MB、
> 图+音 ≤ 200KB），一律走 CDN 清单 + 长缓存静态路由。

## 目录结构与分组

```
public/
├── tiles/                 牌面（独立分类，38 张 · 版本 TILES_VER）
│   ├── t00.webp .. t33.webp        立牌索引进阶：t00..t08 万 / t09..t17 条 / t18..t26 筒 /
│   │                               t27..t33 风箭（东南西北中发白 ×4 + 3 张）
│   └── face/                       平放牌（按屏幕槽位，9×4 格图集，取子格绘制）
│       └── faceA..faceD.webp        slot 0下/1右/2上/3左 → first..fourth（table.js tileimg.faceArt）
├── ui/                    UI 贴图（5 组 30 张 · 版本 UI_VER - v14）
│   ├── hand/              手牌相关（4）★ 自家/对家/上下家手牌显示全在这组
│   │   ├── back.webp              牌背：对家手牌（一排 14 张）、暗杠外的扣牌、立牌牌背
│   │   ├── back_op.webp           暗杠专用扣牌（仅上下两家不换向，见 table.js back_op 规则）
│   │   ├── inhand_l.webp          上家（屏幕左）手牌侧影：左白右金，13~14 段竖排
│   │   └── inhand_r.webp          下家（屏幕右）手牌侧影：左金右白，13~14 段竖排
│   ├── operate/           操作钮（5）—— DOM `<image>` + canvas 中心动画字样同图
│   │   ├── chi/peng/gang/hu/guo.webp   吃/碰/杠/胡/过（书法艺术字，113×94 画布统一规格）
│   ├── settle/            结算面板顶部结果图标（3）
│   │   └── win/lost/draw.webp     胜利/失败/平局（按本局赢家判定，见 game.js onSettle）
│   ├── hud/               桌面 HUD（15）
│   │   ├── table.webp             桌面底图（1280×640，1x，DOM .felt 与 canvas 同映射）
│   │   ├── banker.webp            庄标
│   │   ├── d0..d9.webp            大数字（0.688 比例）
│   │   └── room_time_0..3.webp    中心盘四向指示键（2026-10-24）：0 下/1 右/2 上/3 左
│   │                              = 同一张 130×130 画布的四条边（箭头指向外），260×260 2x
│   │                              按 bbox 裁切绘制，见 table.js ROOM_TIME_SRC
│   └── bg/                web 端背景平铺纹理（2，1024×1024 1x）
│       └── bg-cloud/bg-lattice.webp   style.css 经 --bg-texture 变量吃地址（main.ts applyBgTexture）
└── sound/                 音频（独立分类，8 个 · 约 1.18MB · 版本 SOUND_VER）
    ├── discard.mp3 出牌 · deal.mp3 发牌/摸牌 · gang.mp3 杠 · peng.mp3 碰 · hu.mp3 胡 · chi.mp3 吃 · click.mp3 点牌
    └── bgm.mp3 背景音乐（约 65s 循环 / 1.0MB）：客户端按需下载 + 独立开关，不进代码包
```

## 接口

| 接口 | 返回 | 说明 |
|---|---|---|
| `GET /api/tiles` | `{version, base, tiles:['t00.webp',…], faces:{faceA:'face/faceA.webp',…}}` | 34 张立牌 + 4 张平放牌子清单 |
| `GET /api/ui` | `{version, base, images:{key:'<group>/<key>.webp',…}}` | 26 键 5 组，**值是组内相对路径** |
| `GET /api/sound` | `{version, base, sounds:{key:'<key>.mp3'}}` | 8 键音频清单（7 音效 + bgm） |
| `GET /tiles/t<XX>.webp` | webp | 立牌，长缓存 immutable |
| `GET /tiles/face/face<X>.webp` | webp | 平放牌图集（仅 faceA..D），长缓存 immutable |
| `GET /ui/<group>/<key>.webp` | webp | 长缓存 immutable；只认已知组名单层 webp |
| `GET /sound/<key>.mp3` | mp3 | 长缓存 immutable；支持 Range/206（iOS 播放器必需） |

客户端（小程序 `utils/tileimg.js` 管牌面、`utils/uiart.js` 管 UI、web `src/tileart.ts` /
`main.ts applyBgTexture`）拼 `${base}/<类>/<清单值>` —— **不感知分组结构**，分组调整不影响客户端代码。

- **牌面唯一入口是 `tileimg.js`**：立牌走 `tileArt`（tXX），平放牌走 `faceArt(key, t)`
  （faces 子清单，`FACE_CELL` 格子尺寸与 `gen_face_atlas.mjs` 同步）。`uiart.js` 已不再管牌面。

## 生成与维护

| 源 | 命令 | 产物 |
|---|---|---|
| `packages/client/src/assets/ui/<group>/*.png` | `npm run gen:ui-cdn` | `public/ui/<group>/*.webp` |
| `packages/client/src/assets/tiles/*.png` | `npm run build:cdn-tiles` | `public/tiles/*.webp`（34 立牌）+ `public/tiles/face/*.webp`（4 平放牌，源自 `assets/face/`） |
| `packages/client/src/assets/sound/*.mp3` | 手工拷贝（ASCII 名） | `public/sound/*.mp3` |

- **换素材四连**（漏一步静默不生效）：换源图 → 跑对应 gen 命令 → 抬版本号
  （`TILES_VER` / `UI_VER` / `SOUND_VER`，缓存失效开关）→ 小程序 canvas 侧消费的键
  加进 `pages/game/game.js` 的 `uiart.preload` 白名单（牌面不用：`tileimg.preload` 已自动含 34 立牌 + 4 face）。
- 版本号只是缓存失效开关；客户端网络清单**无条件覆盖**缓存，回调可能来两次须幂等。
- 新增 UI 键必须归入既有分组（新组要同时改 `gen_ui_cdn.mjs` 的 `GROUPS`、
  `packages/server/src/index.ts` 的 `UI_GROUPS` 与本文台账）。
