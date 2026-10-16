/**
 * 局内聊天面板截图脚本
 *   - A 房主、B 加入者，各用独立 context（避免 localStorage token 串号）
 *   - 对话覆盖三类：文字 / 快捷语 / 表情
 *   - 表情已改为「点击即发送」，故 B 只点一次表情按钮即可，不再回读输入框再发送
 * 用法：node scripts/chat_shot.mjs
 *   可用 MJ_URL 指定地址，MJ_OUT 指定输出目录（默认 E:/Temp/mj-bg）
 */
import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium } = require('playwright');

const URL = process.env.MJ_URL || 'http://localhost:3000';
const OUT = process.env.MJ_OUT || 'E:/Temp/mj-bg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitServer() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(URL); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('server not up: ' + URL);
}

const browser = await chromium.launch();

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
  // 表单 #code 上挂有 +30ms 自动聚焦，先等一拍再填，避免 fill 被后续聚焦/清空竞态吃掉
  await sleep(60);
  await page.fill('#code', code);
  await page.fill('#name', '玩家B');
  await page.click('#form-submit');
  await page.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
}

const ctxA = await browser.newContext();
const ctxB = await browser.newContext();
const A = await ctxA.newPage();
const B = await ctxB.newPage();

await waitServer();
await A.goto(URL, { waitUntil: 'load' });
await B.goto(URL, { waitUntil: 'load' });
await A.waitForSelector('#mode-create');
await B.waitForSelector('#mode-create');

const code = await createRoom(A);
await joinRoom(B, code);
await sleep(300);

// 一组有代表性的对话：文字 / 快捷语 / 表情
await A.evaluate(() => { const i = document.querySelector('#chat-input'); i.value = '大家好，开始吧！'; document.querySelector('#chat-send').click(); });
await sleep(200);
await B.evaluate(() => document.querySelector('#chat-quick').children[0].click()); // 快点啊
await sleep(200);
// 表情：点击即发送（不再写回输入框）
const emojiChar = await B.evaluate(() => document.querySelector('#chat-emoji').children[1].textContent);
await B.evaluate(() => document.querySelector('#chat-emoji').children[1].click()); // 😂
await sleep(250);
await A.evaluate(() => { const i = document.querySelector('#chat-input'); i.value = '哈哈，稳了'; document.querySelector('#chat-send').click(); });
await sleep(300);

// 强制显示游戏视图以便截取固定定位的聊天面板（展开态、含消息）
// 聊天默认是收起的（展开会压住牌桌右下角），截图前先展开
await A.evaluate(() => document.querySelector('#view-game').classList.remove('hidden'));
await A.evaluate(() => {
  const chat = document.querySelector('#chat');
  if (chat.classList.contains('collapsed')) document.querySelector('#chat-min').click();
});
await sleep(150);
await A.locator('#chat').screenshot({ path: `${OUT}/chat-open.png` });
// 表情弹层单独来一张，便于核对样式
await A.evaluate(() => document.querySelector('#chat-emoji-btn').click());
await sleep(120);
await A.locator('#chat').screenshot({ path: `${OUT}/chat-emoji-pop.png` });

const logA = await A.evaluate(() => document.querySelector('#chat-log').textContent);
console.log(JSON.stringify({
  code,
  emojiChar,
  emoji_visible_to_A: logA.includes(emojiChar),
  shots: [`${OUT}/chat-open.png`, `${OUT}/chat-emoji-pop.png`],
}, null, 2));
await browser.close();
