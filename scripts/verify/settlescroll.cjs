/**
 * 复刻 game 页「结算弹框」DOM + 完整 WXSS（app.wxss + game.wxss），在 Chromium 里量真实高度，
 * 验证：内容多时 .settle-body 能滚动、弹框不溢出屏幕、底部按钮可见；内容少时弹框不被撑高。
 *
 * 用户报「结算弹框现在无法滚动和缩小」。
 * 根因：.layer-card 是 flex 列且 max-height:86vh，.settle-body 只有 max-height:52vh、min-height 默认 auto。
 *  WebView(Chromium) 对 overflow:auto 的元素自动取 min-size:0，能收缩 → 能滚；
 *  但微信 <scroll-view> 不套用 CSS overflow，min-height:auto = 内容高 → 顶住不缩 → 卡片溢出 86vh 被裁、
 *  底部按钮看不到、也划不动。所以这里用两种模型：
 *   · 'webview' = scroll-view 视作 overflow-y:auto（浏览器自动 min-size:0）→ 一直能滚（旧测试通过的原因）；
 *   · 'wechat'  = scroll-view 视作普通块（min-height:auto 按内容撑）→ 复现真机失败；修好后才通过。
 *
 * 与真机的差异（不影响结论）：rpx 按 iPhone13（390pt→750rpx）换算；env(safe-area-*) 解析为 0。
 */
const fs = require('fs');
const path = require('path');
const { loadPlaywright, chromiumExecutable } = require('./_pw.cjs');

const MP = path.resolve(__dirname, '../../packages/miniapp/miniprogram');
const RPX = 390 / 750;

function toCss(rel) {
  return fs
    .readFileSync(path.join(MP, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(\d+(?:\.\d+)?)rpx/g, (_, n) => `${(Number(n) * RPX).toFixed(3)}px`)
    .replace(/^\s*page\s*\{[^}]*\}/gm, '');
}
const css = toCss('app.wxss') + '\n' + toCss('pages/game/game.wxss');

const cell = (t) => `<view class="tbl-cell">${t}</view>`;
const rowsHTML = (n) => {
  let s = `<view class="tbl-row head">${Array.from({ length: 10 }, (_, i) => cell('列' + (i + 1))).join('')}</view>`;
  for (let i = 0; i < n; i++) {
    s += `<view class="tbl-row">${Array.from({ length: 10 }, (_, j) => cell(j === 0 ? '东家' : (i + 1) + '')).join('')}</view>`;
  }
  return s;
};
const notesHTML = (n) =>
  Array.from({ length: n }, () =>
    `<view class="settle-note">精分：东 3+副精1=4；南 正精2+副精1=5；交叉结算：东 付 南 6（精分+杠分 12 vs 18）</view>`,
  ).join('');

// model: 'webview' → 加 overflow-y:auto；'wechat' → 不加（普通块，min-height:auto 按内容）
const html = (model, nRows, nNotes) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;}
body{font-family:sans-serif;}
view{display:block;}
text{display:inline;}
button,input{display:inline-block;}
${model === 'webview' ? '.settle-body{overflow-y:auto;-webkit-overflow-scrolling:touch;}' : ''}
${css}
</style></head><body>
<div class="page game bg-cloud">
  <div class="layer" id="layer">
    <div class="layer-card settle-card" id="card">
      <div class="settle-art" id="art"></div>
      <div class="layer-title">张三 胡牌（平胡 · 精吊）</div>
      <div class="settle-wintile">胡牌张：五万（自摸）</div>
      <div class="settle-body" id="body">
        <div class="tbl">${rowsHTML(nRows)}</div>
        ${notesHTML(nNotes)}
      </div>
      <div class="settle-totals">累计子：东 +12　南 -4　西 -4　北 -4</div>
      <div class="btn-row end"><button>最小化</button><button class="primary">下一局</button></div>
    </div>
  </div>
</div></body></html>`;

async function measure(browser, vp, model, nRows, nNotes) {
  const page = await browser.newPage({ viewport: vp, colorScheme: 'light' });
  await page.setContent(html(model, nRows, nNotes));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const data = await page.evaluate(() => {
    const g = (id) => document.getElementById(id);
    const el = g('body');
    const card = g('card');
    const btns = card.querySelector('.btn-row');
    const cbr = card.getBoundingClientRect();
    const bbr = btns.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const ccs = getComputedStyle(card);
    return {
      vpH: window.innerHeight,
      bodyClientH: el.clientHeight,
      bodyScrollH: el.scrollHeight,
      bodyHasScrollable: el.scrollHeight - el.clientHeight > 20,
      bodyMinH: cs.minHeight,
      bodyFlex: cs.flex,
      cardH: +cbr.height.toFixed(1),
      cardOverflow: card.scrollHeight - card.clientHeight,
      cardBottom: +cbr.bottom.toFixed(1),
      cardCSS: { maxHeight: ccs.maxHeight, overflow: ccs.overflow },
      btnBottom: +bbr.bottom.toFixed(1),
    };
  });
  await page.close();
  return data;
}

(async () => {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(chromiumExecutable() ? { executablePath: chromiumExecutable() } : {});
  const fails = [];
  const ok = (cond, msg) => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`);
    if (!cond) fails.push(msg);
  };

  for (const [w, h] of [
    [844, 390],
    [780, 360],
    [700, 320],
  ]) {
    const vp = { width: w, height: h };
    console.log(`\n== ${w}×${h}（多内容：8 行 × 10 列 + 14 条 notes）==`);
    const wx = await measure(browser, vp, 'wechat', 8, 14);
    console.log('  wechat body:', { clientH: wx.bodyClientH, scrollH: wx.bodyScrollH, minH: wx.bodyMinH, flex: wx.bodyFlex });
    console.log('  wechat card:', { h: wx.cardH, bottom: wx.cardBottom, btnBottom: wx.btnBottom, vpH: wx.vpH, css: wx.cardCSS });
    // 说明：wechat 模型把 scroll-view 当普通块（内容溢出可见），card.scrollHeight 会被 body 溢出的内容撑大，
    // 不能拿它当「卡片是否裁切」的判据。真正要保的是**固定页脚（按钮）落在卡片盒内**、卡片在屏内、
    // 且 body 被压到可滚（有可滚内容）—— 这三条正是用户说的「划不动 / 按钮被裁 / 缩小不了」。
    ok(wx.btnBottom <= wx.cardBottom + 1, `[wechat] 页脚按钮在卡片盒内（btn ${wx.btnBottom} ≤ card bottom ${wx.cardBottom}）`);
    ok(wx.cardBottom <= wx.vpH + 1, `[wechat] 弹框不溢出屏幕底（bottom ${wx.cardBottom} ≤ ${wx.vpH}）`);
    ok(wx.btnBottom <= wx.vpH + 1, `[wechat] 底部按钮可见（btn bottom ${wx.btnBottom} ≤ ${wx.vpH}）`);
    ok(wx.bodyHasScrollable, `[wechat] 结算体有可滚内容（scrollH ${wx.bodyScrollH} > clientH ${wx.bodyClientH}）`);
    ok(parseFloat(wx.bodyMinH) === 0, `[wechat] 结算体 min-height=0（实际 ${wx.bodyMinH}，须显式归零否则真机顶住不缩）`);

    const wv = await measure(browser, vp, 'webview', 8, 14);
    ok(wv.btnBottom <= wv.vpH + 1, `[webview] 底部按钮也可见（btn bottom ${wv.btnBottom}）`);
  }

  // 少内容：弹框不能被撑满/撑破
  const vp = { width: 844, height: 390 };
  const short = await measure(browser, vp, 'wechat', 1, 1);
  console.log('\n== 少内容（1 行 + 1 notes）==');
  ok(short.cardH < short.vpH, `内容少时弹框不撑满屏（card ${short.cardH} < vp ${short.vpH}）`);
  ok(short.btnBottom <= short.vpH + 1, `内容少时按钮可见（btn bottom ${short.btnBottom}）`);

  // 截图留证：真机 <scroll-view> 是**内部裁剪**（内容不会溢到累计子/按钮上），
  // 而 'wechat' 模型为了复现 min-height:auto 必须把 body 当普通块（不加 overflow，否则浏览器会
  // 自动 min-size:0 把 bug 藏起来）。所以只在**拍照这一刻**补 overflow:hidden 还原真机观感；
  // 此时 min-height 已显式 0，加不加 overflow 的布局结果完全一致，不影响上面的断言。
  const SHOT = path.resolve(__dirname, '../../.recover-tmp');
  const page = await browser.newPage({ viewport: vp, colorScheme: 'light' });
  await page.setContent(html('wechat', 8, 14));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const before = await page.evaluate(() => document.getElementById('body').clientHeight);
  await page.evaluate(() => {
    document.getElementById('body').style.overflow = 'hidden';
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const after = await page.evaluate(() => document.getElementById('body').clientHeight);
  console.log(`\n== 截图（wechat 模型 + 拍照时补 overflow:hidden 模拟内部裁剪）==`);
  ok(before === after, `补裁剪不改布局（body clientH ${before} → ${after}）`);
  await page.screenshot({ path: path.join(SHOT, 'settle_scroll.png') });
  await page.close();

  console.log(`\n== 结果：${fails.length === 0 ? '全部通过' : fails.length + ' 项失败'} ==`);
  await browser.close();
  if (fails.length) process.exit(1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
