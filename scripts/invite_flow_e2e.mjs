/**
 * 分享链接流程端到端验证
 * ---------------------------------------------------------------------------
 * 要求：`?room=` 只作「房间码预填充」的入口 —— 落在加入表单、房间码已填但**可改**，
 * 且完整的向导能力都在：可点「上一步」或步骤条回到模式步，去创建房间 / 重选加入。
 * 用法：先起服务端，再 node scripts/invite_flow_e2e.mjs [端口]
 */
import { createRequire } from 'module';
const require = createRequire('C:/Users/86187/.workbuddy/binaries/node/workspace/package.json');
const { chromium, devices } = require('playwright');

const BASE = process.env.MJ_URL || `http://localhost:${Number(process.argv[2] || 3100)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iphone = devices['iPhone 13'];
const ctxOpts = { ...iphone, viewport: { width: 844, height: 390 }, screen: { width: 844, height: 390 } };

const browser = await chromium.launch();
const results = {};

const waitReady = (p) => p.waitForSelector('#bg-opts .bg-opt');

/** 取向导当前完整状态 */
const state = (p) =>
  p.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const hidden = (s) => q(s).classList.contains('hidden');
    const err = q('#home-error');
    return {
      homeVisible: !hidden('#view-home'),
      lobbyVisible: !hidden('#view-table'),
      modeVisible: !hidden('#step-mode'),
      variantVisible: !hidden('#step-variant'),
      formVisible: !hidden('#step-form'),
      codeValue: q('#code').value,
      codeEditable: !q('#code').readOnly,
      backVisible: !hidden('#form-back'),
      submitText: q('#form-submit').textContent,
      steps: Array.from(document.querySelectorAll('#steps .step-item')).map((el) => ({
        id: el.dataset.step,
        done: el.classList.contains('done'),
        current: el.classList.contains('current'),
      })),
      summary: q('#form-summary').textContent ?? '',
      homeError: hidden('#home-error') ? '' : err.textContent,
      search: location.search,
    };
  });

const fillCode = async (p, v) => {
  for (let i = 0; i < 3; i++) {
    await p.fill('#code', v);
    if ((await p.inputValue('#code')) === v) return true;
    await sleep(120);
  }
  return false;
};

try {
  // A 建房，拿到房间码
  const ctxA = await browser.newContext(ctxOpts);
  const A = await ctxA.newPage();
  A.on('pageerror', (e) => results.A_error = String(e).split('\n')[0]);
  await A.goto(BASE, { waitUntil: 'load' });
  await waitReady(A);
  await A.click('#mode-create');
  await A.click('#variant-next');
  await A.waitForSelector('#step-form:not(.hidden)');
  await A.fill('#name', '东家A');
  await A.click('#form-submit');
  await A.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'));
  await A.waitForFunction(() => (document.querySelector('#room-code')?.textContent ?? '').trim().length === 6);
  const code = (await A.textContent('#room-code')).trim();

  // B 用分享链接进入
  const ctxB = await browser.newContext(ctxOpts);
  const B = await ctxB.newPage();
  const consoleErrors = [];
  B.on('pageerror', (e) => consoleErrors.push(String(e).split('\n')[0]));
  B.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  await B.goto(`${BASE}/?room=${code}`, { waitUntil: 'load' });
  await waitReady(B);
  await sleep(250);

  const s1 = await state(B);
  await B.screenshot({ path: 'E:/Temp/mj-mobile/invite-1-form.png' });
  results['1_链接进入_预填且可改'] = {
    ok:
      s1.formVisible &&
      s1.codeValue === code &&
      s1.codeEditable &&
      s1.backVisible &&
      s1.steps.length === 2 &&
      s1.steps[0]?.done === true &&
      s1.summary.includes('已预填'),
    detail: s1,
  };

  // 点上一步 → 回到模式步
  await B.click('#form-back');
  await sleep(150);
  const s2 = await state(B);
  results['2_点"上一步"回模式步'] = { ok: s2.modeVisible && !s2.formVisible, detail: s2 };

  // 模式步选「创建房间」→ 应进入玩法步，且 URL 里的 room 参数被清掉
  await B.click('#mode-create');
  await sleep(150);
  const s3 = await state(B);
  results['3_可选创建房间'] = {
    ok: s3.variantVisible && s3.steps.length === 3 && !s3.search.includes('room'),
    detail: s3,
  };

  // 回模式步 → 重选「加入房间」：房间码应仍在（可继续改）
  await B.click('#variant-back');
  await sleep(120);
  await B.click('#mode-join');
  await sleep(150);
  const s4 = await state(B);
  results['4_重选加入_房间码保留'] = { ok: s4.formVisible && s4.codeValue === code && s4.codeEditable, detail: s4 };

  // 步骤条回退：点「创建 / 加入」那一格
  await B.click('#steps .step-item[data-step="mode"]');
  await sleep(150);
  const s5 = await state(B);
  results['5_步骤条可回退'] = { ok: s5.modeVisible, detail: s5 };

  // 改房间码 → 必须真的按改后的码去加入（服务端报「房间不存在」）
  await B.click('#mode-join');
  await sleep(150);
  await B.fill('#name', '南家B');
  const filledBogus = await fillCode(B, 'ZZZZZZ');
  await B.click('#form-submit');
  await B.waitForFunction(() => !document.querySelector('#home-error').classList.contains('hidden'), null, { timeout: 5000 });
  const s6 = await state(B);
  results['6_改码生效_用改后码加入'] = {
    ok: filledBogus && s6.homeError === '房间不存在，请检查房间码',
    detail: { homeError: s6.homeError, codeValue: s6.codeValue },
  };

  // 改回正确房间码 → 加入成功
  const filledRight = await fillCode(B, code);
  await B.click('#form-submit');
  await B.waitForFunction(() => !document.querySelector('#view-table').classList.contains('hidden'), null, { timeout: 6000 });
  const s7 = await state(B);
  const lobbyCode = (await B.textContent('#room-code')).trim();
  results['7_改回正确码_加入成功'] = {
    ok: filledRight && s7.lobbyVisible && lobbyCode === code,
    detail: { lobbyCode, lobbyVisible: s7.lobbyVisible },
  };
  results.consoleErrors = consoleErrors;

  await ctxA.close();
  await ctxB.close();
} catch (e) {
  results.fatal = String(e).split('\n')[0];
}
await browser.close();

let bad = 0;
let checked = 0;
for (const [k, v] of Object.entries(results)) {
  if (k === 'consoleErrors' || k === 'fatal') continue;
  if (typeof v !== 'object' || !('ok' in v)) continue;
  checked++;
  if (!v.ok) bad++;
  console.log(`${v.ok ? 'PASS' : 'FAIL'}  ${k}`);
  if (!v.ok) console.log('      ' + JSON.stringify(v.detail));
}
// 致命错误必须计为失败，否则「全部达标」会说谎
if (results.fatal) {
  bad++;
  console.log('FATAL ' + results.fatal);
}
if (results.consoleErrors?.length) {
  bad++;
  console.log('控制台报错: ' + JSON.stringify(results.consoleErrors));
}
const expected = 7;
if (checked !== expected) {
  bad++;
  console.log(`断言项数异常：期望 ${expected}，实得 ${checked}（可能中途异常退出）`);
}
console.log(bad ? `\n>>> ${bad} 项不达标` : `\n>>> 分享链接流程 ${checked}/${expected} 全部达标`);
