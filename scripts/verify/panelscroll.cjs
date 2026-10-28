/**
 * 复刻 game 页「操作记录 / 聊天」面板的 DOM + 完整 WXSS，在 Chromium 里量真实高度，
 * 验证 scroll-view 到底有没有可滚内容（用户报「操作记录和聊天信息无法滚动显示」）。
 *
 * 2026-10-24 改成断言式：输出 PASS/FAIL 而不是一堆数字。
 *
 * 与真机的差异只有三点，都不影响结论：
 *   ① rpx 按 iPhone 13（390pt 屏宽 → 750rpx）换算成 px；
 *   ② env(safe-area-inset-*) 解析为 0（无刘海）；
 *   ③ <scroll-view> 换成 <div> + overflow-y:auto（scroll-view 的框架行为就是这样）。
 */
const fs = require('fs');
const path = require('path');
const { loadPlaywright, chromiumExecutable } = require('./_pw.cjs');

const MP = path.resolve(__dirname, '../../packages/miniapp/miniprogram');
const raw = fs.readFileSync(path.join(MP, 'pages/game/game.wxss'), 'utf8');

// ---- WXSS → CSS（只做本页用得到的转换）----
const RPX = 390 / 750; // 1rpx = 0.52px
let css = raw
  .replace(/\/\*[\s\S]*?\*\//g, '') // 去注释
  .replace(/(\d+(?:\.\d+)?)rpx/g, (_, n) => `${(Number(n) * RPX).toFixed(3)}px`) // rpx → px
  .replace(/^\s*page\s*\{[^}]*\}/gm, ''); // page 选择器浏览器不认

// scroll-view 的框架行为：可纵向滚动
const SCROLLVIEW_BEHAVIOR = `
.panel-body,.chat-log,.chat-pop{overflow-y:auto;-webkit-overflow-scrolling:touch;}
`;

const rows = (n) => Array.from({ length: n }, () =>
  `<view class="log-row"><text class="log-seat">东家</text><text class="log-action peng">碰</text><text class="log-tiles">一万 二万</text></view>`).join('');
const msgs = (n) => Array.from({ length: n }, () =>
  `<view class="chat-msg"><text class="chat-name">玩家：</text><text class="chat-text">这是一条聊天消息内容，足够长以触发换行效果</text></view>`).join('');

const html = (nRows, nMsgs) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{font-family:sans-serif;}
/* 小程序内置标签的 display 语义：view=block / text=inline / button,input=inline-block。
   少了这几行，浏览器把 <view> 当自定义元素排成 inline，消息会全挤一行绕行，高度全错。 */
view{display:block;}
text{display:inline;}
button,input{display:inline-block;}
.game{height:100vh;display:flex;flex-direction:column;position:relative;
  padding-top:4px;padding-right:8.32px;padding-bottom:6.24px;padding-left:8.32px;}
.game-main,.board-overlay{position:relative;z-index:1;flex:1;min-height:0;display:flex;flex-direction:row;}
${SCROLLVIEW_BEHAVIOR}
${css}
</style></head><body>
<div class="game">
<div class="game-main" id="gm">
  <div class="side-panel" id="sp-log">
    <div class="panel-card log-card" id="card-log">
      <div class="panel-head"><text class="panel-title">操作记录</text><button class="panel-x">✕</button></div>
      <div class="panel-body" id="body-log">${rows(nRows)}</div>
    </div>
  </div>
  <div class="side-panel" id="sp-chat">
    <div class="panel-card chat-card" id="card-chat">
      <div class="panel-head"><text class="panel-title">聊天</text><button class="panel-x">✕</button></div>
      <div class="chat-log" id="body-chat">${msgs(nMsgs)}</div>
      <div class="chat-pop" id="pop-chat"><div class="chat-pop-row"><button class="chat-chip">快点吧</button><button class="chat-chip">手气真好</button></div></div>
      <div class="chat-input-row"><input class="chat-input"></div>
    </div>
  </div>
</div></div></body></html>`;

(async () => {
  const pw = loadPlaywright();
  const { chromium } = pw;
  const browser = await chromium.launch(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {});
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, colorScheme: 'light' });
  await page.setContent(html(40, 40));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  const out = await page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const res = {};
    for (const id of ['gm', 'sp-log', 'card-log', 'body-log', 'sp-chat', 'card-chat', 'body-chat', 'pop-chat']) {
      const el = g(id);
      const r = el.getBoundingClientRect();
      res[id] = {
        box: { w: +r.width.toFixed(1), h: +r.height.toFixed(1) },
        scrollH: el.scrollHeight, clientH: el.clientHeight,
        overflow: el.scrollHeight - el.clientHeight,
      };
    }
    const cs = getComputedStyle(g('card-chat'));
    res._chatCardCSS = { maxHeight: cs.maxHeight, height: cs.height, overflow: cs.overflow, display: cs.display };
    const csb = getComputedStyle(g('body-chat'));
    res._chatLogCSS = { flex: csb.flex, minHeight: csb.minHeight, maxHeight: csb.maxHeight, height: csb.height };
    const csi = getComputedStyle(g('pop-chat').nextElementSibling);
    res._inputRowCSS = { flexShrink: csi.flexShrink, height: csi.height };
    const csp = getComputedStyle(g('pop-chat'));
    res._chatPopCSS = { flexShrink: csp.flexShrink, maxHeight: csp.maxHeight };
    return res;
  });

  // 变体：内容很少时卡片不能被撑破/不能被压扁
  const page2 = await browser.newPage({ viewport: { width: 844, height: 390 }, colorScheme: 'light' });
  await page2.setContent(html(3, 3));
  await page2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const short = await page2.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const r = (id) => { const b = g(id).getBoundingClientRect(); return { w: +b.width.toFixed(1), h: +b.height.toFixed(1) }; };
    return { cardLog: r('card-log'), bodyLog: r('body-log'), cardChat: r('card-chat'), bodyChat: r('body-chat'),
             sp: r('sp-log'), gm: r('gm') };
  });

  // ---- 断言 ----
  const fails = [];
  const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) fails.push(msg); };

  console.log('== 多内容（40 条）==');
  ok(out['sp-log'].box.h > 0, `.side-panel 有高度（${out['sp-log'].box.h}px）`);
  ok(out['card-log'].box.h > 200, `.panel-card 定高生效（${out['card-log'].box.h}px，原来不确定高度链下会缩到内容高）`);
  ok(out['body-log'].overflow > 100, `.panel-body 可滚动（溢出 ${out['body-log'].overflow}px）`);
  ok(out['body-chat'].overflow > 100, `.chat-log 可滚动（溢出 ${out['body-chat'].overflow}px）`);
  ok(out['card-chat'].box.h > 200, `.chat-card 定高生效（${out['card-chat'].box.h}px）`);
  ok(out._chatCardCSS.height !== 'auto' && parseFloat(out._chatCardCSS.height) > 200, `卡片 height 计算值确定（${out._chatCardCSS.height}）`);
  ok(out._chatLogCSS.flex.startsWith('1'), `.chat-log flex 计算值 = ${out._chatLogCSS.flex}`);
  ok(out._chatLogCSS.maxHeight === 'none', `.chat-log 没有小帽子（max-height: ${out._chatLogCSS.maxHeight}）`);
  ok(out._chatPopCSS.flexShrink === '0', `.chat-pop 不被压缩（flex-shrink: ${out._chatPopCSS.flexShrink}）`);
  ok(out._inputRowCSS.flexShrink === '0', `.chat-input-row 不被压缩（flex-shrink: ${out._inputRowCSS.flexShrink}）`);

  console.log('== 少内容（3 条）==');
  ok(Math.abs(short.cardLog.h - short.sp.h) < 20, `记录卡片仍占满面板（卡 ${short.cardLog.h} / 面 ${short.sp.h}）`);
  ok(Math.abs(short.cardChat.h - short.gm.h) < 30, `聊天卡片仍占满面板（卡 ${short.cardChat.h} / 面 ${short.gm.h}）`);
  ok(short.bodyChat.h > 100, `聊天消息区仍有可视高度（${short.bodyChat.h}px，不被输入行挤没）`);

  // 截图留证。输出到 .recover-tmp/（scripts/verify 只跟踪 .cjs，PNG 一律落 harness 目录）。
  const SHOT = path.resolve(__dirname, '../../.recover-tmp');
  // 两个 .side-panel 都是 absolute inset:0，同时存在会互相盖住，
  // 截图前先把另一个藏掉。
  await page.evaluate(() => { document.getElementById('sp-chat').style.display = 'none'; });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.locator('#card-log').screenshot({ path: path.join(SHOT, 'panel_log.png') });
  await page.evaluate(() => { document.getElementById('sp-chat').style.display = ''; document.getElementById('sp-log').style.display = 'none'; });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.locator('#card-chat').screenshot({ path: path.join(SHOT, 'panel_chat.png') });
  await page2.evaluate(() => { document.getElementById('sp-log').style.display = 'none'; });
  await page2.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page2.locator('#card-chat').screenshot({ path: path.join(SHOT, 'panel_chat_short.png') });

  console.log(`\n== 结果：${fails.length === 0 ? '全部通过' : fails.length + ' 项失败'} ==`);
  await browser.close();
  if (fails.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
