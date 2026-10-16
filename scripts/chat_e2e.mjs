import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const URL = process.env.MJ_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(URL); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('server not up');
}

const browser = await chromium.launch();
const errors = [];
const watch = (page, tag) => {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(tag + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push(tag + ': ' + String(e)));
};

async function createRoom(page) {
  await page.click('#mode-create');
  await page.click('#variant-next');
  await page.waitForSelector('#step-form:not(.hidden)');
  await page.fill('#name', '玩家A');
  await page.click('#form-submit');
  await page.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
  return (await page.textContent('#room-code')).trim();
}
async function joinRoom(page, code) {
  await page.click('#mode-join');
  await page.waitForSelector('#step-form:not(.hidden)');
  // #code 上挂有 +30ms 自动聚焦，直接 fill 会被后续聚焦/清空竞态吃掉 → 先等一拍 + 校验 + 重试
  await sleep(60);
  let ok = false;
  for (let i = 0; i < 3 && !ok; i++) {
    await page.fill('#code', code);
    ok = (await page.inputValue('#code')) === code;
    if (!ok) await sleep(150);
  }
  if (!ok) throw new Error('房间码填入即丢失：' + code);
  await page.fill('#name', '玩家B');
  await page.click('#form-submit');
  await page.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
}

const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
const A = await ctxA.newPage();
const B = await ctxB.newPage();
watch(A, 'A'); watch(B, 'B');

await waitServer();
await A.goto(URL, { waitUntil: 'load' });
await B.goto(URL, { waitUntil: 'load' });
await A.waitForSelector('#mode-create');
await B.waitForSelector('#mode-create');

const code = await createRoom(A);
await joinRoom(B, code);
await sleep(300);

// 1) A 发自定义文字
await A.evaluate(() => { const i = document.querySelector('#chat-input'); i.value = '大家好'; document.querySelector('#chat-send').click(); });
await sleep(200);
// 2) B 发快捷语（CHAT_QUICK[0] = 快点啊）
await B.evaluate(() => document.querySelector('#chat-quick').children[0].click());
await sleep(200);
// 3) A 先在输入框留一段未发送文字，再点表情：
//    表情应**直接发送**，且不得写进输入框（用户原有文字必须原样保留）
const DRAFT = '这段草稿不该被表情污染';
await A.evaluate((d) => { document.querySelector('#chat-input').value = d; }, DRAFT);
const EMOJI = await A.evaluate(() => document.querySelector('#chat-emoji').children[0].textContent);
await A.evaluate(() => document.querySelector('#chat-emoji').children[0].click());
await sleep(250);
const inputAfterEmoji = await A.evaluate(() => document.querySelector('#chat-input').value);
const emojiPopClosed = await A.evaluate(() => document.querySelector('#chat-emoji').hidden);

const logA = await A.evaluate(() => document.querySelector('#chat-log').textContent);
const logB = await B.evaluate(() => document.querySelector('#chat-log').textContent);
const cntA = await A.evaluate(() => document.querySelector('#chat-log').children.length);

// 4) 未读红点：A 全程处于收起态，B 发的快捷语应计为未读，A 自己发的表情不算
const badgeOf = (p) =>
  p.evaluate(() => {
    const chat = document.querySelector('#chat');
    const b = document.querySelector('#chat-badge');
    const r = b.getBoundingClientRect();
    const cs = getComputedStyle(b);
    return {
      hidden: b.hidden,
      text: b.textContent,
      display: cs.display,
      size: [Math.round(r.width), Math.round(r.height)],
      collapsed: chat.classList.contains('collapsed'),
      minAria: document.querySelector('#chat-min').getAttribute('aria-label'),
    };
  });
// 聊天面板在 #view-game 里，此刻两人还在大厅视图 —— 先强制显示游戏视图，
// 否则整棵子树 display:none，读到的 getBoundingClientRect 全是 0（等于没验）
await A.evaluate(() => document.querySelector('#view-game').classList.remove('hidden'));
await sleep(120);
const badgeCollapsed = await badgeOf(A); // 期望显示「1」：只算 B 的「快点啊」
await A.locator('#chat').screenshot({ path: 'E:/Temp/mj-bg/chat-badge.png' });

const sendFrom = (p, text) =>
  p.evaluate((t) => {
    const i = document.querySelector('#chat-input');
    i.value = t;
    document.querySelector('#chat-send').click();
  }, text);
await sendFrom(B, '第三条未读');
await sleep(250);
const badgeCollapsed2 = await badgeOf(A); // 期望「2」

// 5) 展开 = 已读：红点消失，且 aria-label 不再带未读数
await A.evaluate(() => document.querySelector('#chat-min').click());
await sleep(150);
const badgeAfterOpen = await badgeOf(A);
// 6) 展开态收到消息不该再攒未读（人就在看着）
await sendFrom(B, '展开时收到的');
await sleep(250);
const badgeWhileOpen = await A.evaluate(() => document.querySelector('#chat-badge').hidden);
const logAFinal = await A.evaluate(() => document.querySelector('#chat-log').textContent);

// 7) 截图：展开态（消息 + 被刻意保留下来的草稿）
const collapsed = await A.evaluate(() => document.querySelector('#chat').classList.contains('collapsed'));

// 截图聊天界面（强制显示游戏视图以便截取固定定位的聊天面板）
await A.evaluate(() => document.querySelector('#view-game').classList.remove('hidden'));
await A.locator('#chat').screenshot({ path: 'E:/Temp/mj-bg/chat-ui.png' });

console.log(JSON.stringify({
  code,
  cntA,
  A_sees_own_text: logA.includes('玩家A') && logA.includes('大家好'),
  A_sees_B_quick: logA.includes('玩家B') && logA.includes('快点啊'),
  B_sees_A_text: logB.includes('玩家A') && logB.includes('大家好'),
  // 表情改为「点击即发送」：必须真的发出去了，且输入框内容不受影响
  emojiChar: EMOJI,
  emoji_sent_directly: logB.includes(EMOJI) && logA.includes(EMOJI),
  emoji_input_untouched: inputAfterEmoji === DRAFT,
  emoji_pop_closed: emojiPopClosed,
  // 收起态未读红点
  badgeCollapsed,
  badge_counts_only_others: badgeCollapsed.hidden === false && badgeCollapsed.text === '1',
  badge_rendered: badgeCollapsed.display !== 'none' && badgeCollapsed.size[0] > 0 && badgeCollapsed.size[1] > 0,
  badge_increments: badgeCollapsed2.text === '2',
  badge_cleared_on_open: badgeAfterOpen.hidden === true && badgeAfterOpen.text === '',
  badge_open_aria_clean: badgeAfterOpen.minAria === '收起聊天',
  badge_no_count_while_open: badgeWhileOpen === true,
  A_sees_all_messages: ['快点啊', '第三条未读', '展开时收到的'].every((t) => logAFinal.includes(t)),
  cross_realtime: logA.includes('玩家B') && logB.includes('玩家A'),
  collapsed,
  errors,
}, null, 2));

await browser.close();
