/**
 * 小游戏入口（packages/minigame/game —— 微信开发者工具以 compileType:"game" 导入本目录）。
 *
 * 小游戏端主入口。
 *   · 协议 / 规则来自 lib/shared（`npm run build:mg` 产物，与服务端同一份 shared 源码）；
 *   · 牌桌渲染 utils/table.js 原样移植（桌面画在一张离屏画布上，主画布负责合成）；
 *   · 页面体系（home/lobby/game 三个 Page + WXML/WXSS）换成单画布场景体系（src/scenes）。
 *
 * 本文件刻意保持极薄：生命周期、画布、主循环都在 src/main.js —— 便于整体替换 / 测试。
 */

require('./src/main.js');
