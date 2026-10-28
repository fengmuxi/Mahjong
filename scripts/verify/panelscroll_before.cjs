/**
 * 对照组：把 .panel-card / .chat-log 还原成修复前的写法，确认探针会 FAIL。
 * 只改探针内的 CSS 副本，不动仓库真实文件。
 */
const fs = require('fs');
const path = require('path');
const { loadPlaywright, chromiumExecutable } = require('./_pw.cjs');

const MP = path.resolve(__dirname, '../../packages/miniapp/miniprogram');
const raw = fs.readFileSync(path.join(MP, 'pages/game/game.wxss'), 'utf8');

const RPX = 390 / 750;
let css = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(\d+(?:\.\d+)?)rpx/g, (_, n) => `${(Number(n) * RPX).toFixed(3)}px`)
  .replace(/^\s*page\s*\{[^}]*\}/gm, '');

// ---- 还原修复前的写法 ----
// ① 卡片只有 max-height，没有 height（不确定高度链）
css = css.replace('.panel-card{', '.panel-card-before{');
css += `
.panel-card{width:min(72vw,560px);max-height:100%;display:flex;flex-direction:column;
  background:rgba(16,26,21,.97);border:2px solid rgba(255,255,255,.16);border-radius:14px;
  overflow:hidden;box-shadow:0 10px 28px rgba(0,0,0,.45);}
.chat-card{width:min(64vw,480px);}
/* ② .chat-log 上的 300rpx 小帽子（≈156px）*/
.chat-log{max-height:156px;flex:1;min-height:0;padding:4.16px 6.24px;}
`;

const rows = (n) => Array.from({ length: n }, () =>
  `<view class="log-row"><text class="log-seat">东家</text><text class="log-action peng">碰</text><text class="log-tiles">一万 二万</text></view>`).join('');
const msgs = (n) => Array.from({ length: n }, () =>
  `<view class="chat-msg"><text class="chat-name">玩家：</text><text class="chat-text">这是一条聊天消息内容，足够长以触发换行效果</text></view>`).join('');

const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{font-family:sans-serif;}
view{display:block;}text{display:inline;}button,input{display:inline-block;}
.game{height:100vh;display:flex;flex-direction:column;position:relative;
  padding-top:4px;padding-right:8.32px;padding-bottom:6.24px;padding-left:8.32px;}
.game-main{position:relative;z-index:1;flex:1;min-height:0;display:flex;flex-direction:row;}
.panel-body,.chat-log{overflow-y:auto;-webkit-overflow-scrolling:touch;}
${css}
</style></head><body>
<div class="game"><div class="game-main" id="gm">
  <div class="side-panel" id="sp-log"><div class="panel-card log-card" id="card-log">
    <div class="panel-head"><text class="panel-title">操作记录</text><button class="panel-x">✕</button></div>
    <div class="panel-body" id="body-log">${rows(40)}</div>
  </div></div>
  <div class="side-panel" id="sp-chat"><div class="panel-card chat-card" id="card-chat">
    <div class="panel-head"><text class="panel-title">聊天</text><button class="panel-x">✕</button></div>
    <div class="chat-log" id="body-chat">${msgs(40)}</div>
    <div class="chat-input-row"><input class="chat-input"></div>
  </div></div>
</div></div></body></html>`;

(async () => {
  const pw = loadPlaywright();
  const { chromium } = pw;
  const browser = await chromium.launch(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {});
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, colorScheme: 'light' });
  await page.setContent(html);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const out = await page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const r = (id) => { const b = g(id).getBoundingClientRect(); return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
    return { gm: r('gm'), cardLog: r('card-log'), bodyLog: r('body-log'), cardChat: r('card-chat'), bodyChat: r('body-chat'),
             ovLog: g('body-log').scrollHeight - g('body-log').clientHeight,
             ovChat: g('body-chat').scrollHeight - g('body-chat').clientHeight };
  });
  console.log('对照组（修复前写法）：');
  console.log('  game-main 高 =', out.gm.h);
  console.log('  记录卡片高 =', out.cardLog.h, ' 消息区溢出 =', out.ovLog);
  console.log('  聊天卡片高 =', out.cardChat.h, ' 消息区溢出 =', out.ovChat);
  console.log('  → 卡片是否缩到内容高（而非占满面板）：', out.cardLog.h < out.gm.h - 40 ? '是（症状复现）' : '否');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
