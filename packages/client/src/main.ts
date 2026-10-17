import {
  CHAT_TEXT_MAX,
  THROW_EMOJI,
  THROW_EMOJI_TONES,
  throwEmojiOf,
  type ClientMsg,
  type GameView,
  type ServerMsg,
} from '@shared/index.ts';
import { DEFAULT_VARIANT, VARIANT_LIST, getRules, variantName } from '@shared/rules/index.ts';
import { seatWind, tileName, windName } from '@shared/tiles.ts';
import { Table } from './table.ts';
import { preloadTiles } from './tileart.ts';
import { fitCanvas, initMobile, isTouchDevice, renderHandTray, setTrayDiscardHandler } from './mobile.ts';

type StateMsg = Extract<ServerMsg, { t: 'state' }>;
type SettleMsg = Extract<ServerMsg, { t: 'settle' }>;

const $ = <T extends Element>(sel: string) => document.querySelector(sel) as T;

const homeView = $<HTMLElement>('#view-home');
const tableView = $<HTMLElement>('#view-table');
const gameView = $<HTMLElement>('#view-game');
const nameInput = $<HTMLInputElement>('#name');
const codeInput = $<HTMLInputElement>('#code');
const shareBtn = $<HTMLButtonElement>('#share-btn');
const toastEl = $<HTMLElement>('#toast');
const homeError = $<HTMLElement>('#home-error');
const roomCodeEl = $<HTMLElement>('#room-code');
const meEl = $<HTMLElement>('#me');
const seatsEl = $<HTMLElement>('#seats');
const drBtn = $<HTMLButtonElement>('#dr-btn');
const feedEl = $<HTMLElement>('#feed');
// 局内聊天
const chatEl = $<HTMLElement>('#chat');
const chatLogEl = $<HTMLElement>('#chat-log');
const logListEl = $<HTMLElement>('#log-list');
const chatTabChat = $<HTMLButtonElement>('#chat-tab-chat');
const chatTabLog = $<HTMLButtonElement>('#chat-tab-log');
const chatInputEl = $<HTMLInputElement>('#chat-input');
const chatSendBtn = $<HTMLButtonElement>('#chat-send');
const chatMinBtn = $<HTMLButtonElement>('#chat-min');
const chatQuickBtn = $<HTMLButtonElement>('#chat-quick-btn');
const chatEmojiBtn = $<HTMLButtonElement>('#chat-emoji-btn');
const chatQuickEl = $<HTMLElement>('#chat-quick');
const chatEmojiEl = $<HTMLElement>('#chat-emoji');
const chatBadgeEl = $<HTMLElement>('#chat-badge');
// 互动表情（定向投掷）
const emoteBtn = $<HTMLButtonElement>('#emote-btn');
const emotePicker = $<HTMLElement>('#emote-picker');
const emoteTargetsEl = $<HTMLElement>('#emote-targets');
const emoteGridEl = $<HTMLElement>('#emote-grid');
const emoteCancelBtn = $<HTMLButtonElement>('#emote-cancel');
// 局内聊天：预设内容（需在 initChat 调用前初始化，避免 TDZ）
const CHAT_QUICK = ['快点啊', '胡了！🎉', '不好意思', '等一下', '这把稳了', '笑死😂', '加油', '别急'];
const CHAT_EMOJI = ['😀', '😂', '😍', '😎', '🤔', '😅', '👍', '👏', '🎉', '🔥', '💡', '🀄', '❤️', '🍺', '😴', '🙏'];
/** 房间聊天历史（离房清空；跨小局持续保留） */
let chatHistory: { seat: number; name: string; text: string }[] = [];
/** 收起态下累积的未读数（展开即清零；离房重置） */
let chatUnread = 0;
const readyBtn = $<HTMLButtonElement>('#ready-btn');
const leaveBtn = $<HTMLButtonElement>('#leave-btn');
const allReadyEl = $<HTMLElement>('#all-ready');
const connBanner = $<HTMLElement>('#conn-banner');
const gCode = $<HTMLElement>('#g-code');
const gVariant = $<HTMLElement>('#g-variant');
const gWall = $<HTMLElement>('#g-wall');
const gJing = $<HTMLElement>('#g-jing');
const gStatus = $<HTMLElement>('#g-status');
const controls = $<HTMLElement>('#controls');
const controlsErr = $<HTMLElement>('#controls-err');
const settleEl = $<HTMLElement>('#settle');
const settleTitle = $<HTMLElement>('#settle-title');
const settleRows = $<HTMLElement>('#settle-rows');
const settleNotes = $<HTMLElement>('#settle-notes');
const settleTotals = $<HTMLElement>('#settle-totals');
const settleHideBtn = $<HTMLButtonElement>('#settle-hide');
const settleNextBtn = $<HTMLButtonElement>('#settle-next');
const settleRestoreBtn = $<HTMLButtonElement>('#settle-restore');
const countdownEl = $<HTMLElement>('#countdown');
const dissolveBtn = $<HTMLButtonElement>('#dissolve-btn');
const dissolveGameBtn = $<HTMLButtonElement>('#dissolve-game-btn');
const addBotBtn = $<HTMLButtonElement>('#add-bot-btn');
const autoBtn = $<HTMLButtonElement>('#auto-btn');
const dissolveEl = $<HTMLElement>('#dissolve');
const dissolveTitle = $<HTMLElement>('#dissolve-title');
const dissolveRows = $<HTMLElement>('#dissolve-rows');
const diceEl = $<HTMLElement>('#dice');
const die1 = $<HTMLDivElement>('#die1');
const die2 = $<HTMLDivElement>('#die2');
const diceMsg = $<HTMLElement>('#dice-msg');
const variantsEl = $<HTMLElement>('#variants');
const roomVariantEl = $<HTMLElement>('#room-variant');
const variantSwitchEl = $<HTMLElement>('#variant-switch');
const settleVariantEl = $<HTMLElement>('#settle-variant');
const variantConfirmEl = $<HTMLElement>('#variant-confirm');
const variantConfirmTextEl = $<HTMLElement>('#variant-confirm-text');
const vcKeepBtn = $<HTMLButtonElement>('#vc-keep');
const vcClearBtn = $<HTMLButtonElement>('#vc-clear');
const vcCancelBtn = $<HTMLButtonElement>('#vc-cancel');
const swapEl = $<HTMLElement>('#swap');
const swapTextEl = $<HTMLElement>('#swap-text');
const swapAcceptBtn = $<HTMLButtonElement>('#swap-accept');
const swapDeclineBtn = $<HTMLButtonElement>('#swap-decline');
// 分步向导
const stepsEl = $<HTMLOListElement>('#steps');
const stepModeEl = $<HTMLElement>('#step-mode');
const stepVariantEl = $<HTMLElement>('#step-variant');
const stepFormEl = $<HTMLElement>('#step-form');
const variantBackBtn = $<HTMLButtonElement>('#variant-back');
const variantNextBtn = $<HTMLButtonElement>('#variant-next');
const formHeadEl = $<HTMLElement>('#form-head');
const formSummaryEl = $<HTMLElement>('#form-summary');
const codeFieldEl = $<HTMLElement>('#code-field');
const formBackBtn = $<HTMLButtonElement>('#form-back');
const formSubmitBtn = $<HTMLButtonElement>('#form-submit');

const table = new Table($<HTMLCanvasElement>('#table'));

// 启动即加载 34 张牌面贴图；全部就绪后重绘一次（未就绪前回退文字牌面）
preloadTiles(() => {
  if (lastGameView) renderGame(lastGameView);
});

// 移动端适配：横屏引导 + 画布尺寸自适应 + 手牌操作条。
// 桌面端只会被打上 html 标记，行为与观感完全不变。
  initMobile(undefined, showToast);
setTrayDiscardHandler((tile) => {
  tryDiscard(tile); // 与画布点牌同一条出口（先过报杠拦截）
});

let ws: WebSocket | null = null;
let pending: ClientMsg | null = null;
let inRoom = false;
let autoResume = false;
/** 局内断线自动重连：服务端有 30s 宽限 + token 可 resume 回原座位，
 *  所以手机休眠、Wi-Fi 切换这类网络抖动不该把人踢回向导。 */
let reconnTimer: ReturnType<typeof setTimeout> | undefined;
let reconnTries = 0;
const RECONNECT_MAX_TRIES = 10; // 1+2+3+4×7 ≈ 34s，覆盖服务端 30s 宽限还有余量
let lastGameView: GameView | null = null;
let lastState: StateMsg | null = null;
let mySeat = -1;
/** 当前庄家座位：**风位随庄**，大厅与牌桌的一切风位显示都按它换算 */
let curDealer = 0;

/** 座位风位（庄家恒为东）——**客户端所有风位显示都走这里**，不要直接用 windName */
function wind(seat: number): string {
  return seatWind(seat, curDealer);
}
let toastTimer: ReturnType<typeof setTimeout> | undefined;
// 玩法切换：当前玩法 / 待确认目标 / 结算表行座位序 / 最近一次结算负载
let currentVariant = '';
let pendingVariant = '';
let settleRowOrder: number[] = [];
let lastSettleMsg: SettleMsg | null = null;

nameInput.value = localStorage.getItem('mj-name') ?? '';

// 背景偏好：默认祥云（cloud），plain=原始素色渐变；其余两张平铺纹理在 style.css 按 data-bg 切换
document.body.dataset.bg = localStorage.getItem('mj-bg') ?? 'cloud';

// ===========================================================================
// 入口分步向导：① 创建 / 加入 → ② 选择玩法（仅创建分支）→ 最后 填写信息
//
// 每一步的选择都决定下一步显示什么：
//   第 ① 步（创建 / 加入）→ 决定后面还有几步、以及最后一步是哪个表单
//   第 ② 步（玩法）→ 决定最后一步摘要里的玩法名，以及创建房间时上送的 variant
// 「加入房间」不经过玩法步——玩法由房间决定，让用户选会误导。
// 步骤条按分支动态渲染；已完成的步骤可点击回退，被邀请链接锁定的步骤不可回退。
// ===========================================================================

/** 面板标识（顺序由 stepSeq() 按分支给出） */
type StepId = 'mode' | 'variant' | 'form';
type WizardMode = 'create' | 'join';

let wizardStepId: StepId = 'mode';
let wizardMode: WizardMode | null = null;
/** 房间码来自分享链接（?room=）：**只是预填充**，不锁定任何步骤，
 *  仅用于在表单上提示「已预填 · 可修改」 */
let codeFromLink = false;

// 玩法清单来自共享注册表（VARIANTS）——新增玩法无需改动前端。
let selectedVariant = localStorage.getItem('mj-variant') ?? DEFAULT_VARIANT;
if (!VARIANT_LIST.some((v) => v.id === selectedVariant)) selectedVariant = DEFAULT_VARIANT;

function selectedVariantMeta() {
  return VARIANT_LIST.find((v) => v.id === selectedVariant) ?? VARIANT_LIST[0];
}

/** 当前分支的步骤序列（未选模式时按「创建」预览，因为它是更长的那条） */
function stepSeq(): StepId[] {
  return wizardMode === 'join' ? ['mode', 'form'] : ['mode', 'variant', 'form'];
}

function stepLabel(id: StepId): string {
  if (id === 'mode') return '创建 / 加入';
  if (id === 'variant') return '选择玩法';
  if (wizardMode === 'join') return '加入房间';
  if (wizardMode === 'create') return '创建房间';
  return '填写信息';
}

/** 第 ① 步：玩法卡片（点击选择；选中态即时同步到最后一步摘要） */
function renderVariants(): void {
  variantsEl.textContent = '';
  for (const v of VARIANT_LIST) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'variant' + (v.id === selectedVariant ? ' active' : '');
    card.setAttribute('aria-pressed', String(v.id === selectedVariant));
    const nm = document.createElement('div');
    nm.className = 'variant-name';
    nm.textContent = v.name;
    const ds = document.createElement('div');
    ds.className = 'variant-desc';
    ds.textContent = v.desc ?? `${v.seats} 人局`;
    const tg = document.createElement('div');
    tg.className = 'variant-tags';
    for (const tag of v.tags ?? [`${v.seats} 人`]) {
      const sp = document.createElement('span');
      sp.textContent = tag;
      tg.append(sp);
    }
    card.append(nm, ds, tg);
    card.addEventListener('click', () => {
      selectedVariant = v.id;
      localStorage.setItem('mj-variant', v.id);
      renderVariants();
    });
    variantsEl.append(card);
  }
}

/** 背景切换器：绒面 / 回纹 / 祥云 / 素色，选择写入 localStorage 并即时套用 */
const BG_OPTIONS: { id: string; label: string }[] = [
  { id: 'felt', label: '绒面' },
  { id: 'lattice', label: '回纹' },
  { id: 'cloud', label: '祥云' },
  { id: 'plain', label: '素色' },
];
function renderBgSwitch(): void {
  const host = $<HTMLElement>('#bg-opts');
  host.textContent = '';
  const cur = document.body.dataset.bg || 'cloud';
  for (const o of BG_OPTIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bg-opt' + (o.id === cur ? ' active' : '');
    btn.textContent = o.label;
    btn.setAttribute('aria-pressed', String(o.id === cur));
    btn.addEventListener('click', () => {
      document.body.dataset.bg = o.id;
      localStorage.setItem('mj-bg', o.id);
      renderBgSwitch();
    });
    host.append(btn);
  }
}

/** 步骤条：按 stepSeq() 重建，标出 current / done（done 表示可点击回退） */
function renderSteps(): void {
  const seq = stepSeq();
  const cur = seq.indexOf(wizardStepId);
  stepsEl.textContent = '';
  seq.forEach((id, i) => {
    const item = document.createElement('li');
    item.className = 'step-item' + (id === wizardStepId ? ' current' : '') + (i < cur ? ' done' : '');
    item.dataset.step = id;
    const dot = document.createElement('span');
    dot.className = 'step-dot';
    dot.textContent = String(i + 1);
    const label = document.createElement('span');
    label.className = 'step-label';
    label.textContent = stepLabel(id);
    item.append(dot, label);
    stepsEl.append(item);
  });
}

/** 最后一步：按分支渲染对应表单 */
function renderWizardForm(): void {
  const isJoin = wizardMode === 'join';
  const meta = selectedVariantMeta();
  formHeadEl.textContent = isJoin ? '加入朋友的房间' : '开一桌新牌局';
  codeFieldEl.classList.toggle('hidden', !isJoin);
  // 「上一步」始终可用：分享链接进来的用户也要能回退去创建自己的房间
  formSubmitBtn.textContent = isJoin ? '加入房间' : '创建房间';
  formSummaryEl.textContent = '';

  const chip1 = document.createElement('span');
  if (isJoin) {
    // 加入分支没有玩法步：这里如实说明玩法从哪来
    chip1.textContent = '玩法 由房间决定';
  } else {
    chip1.append('玩法 ');
    const strong = document.createElement('strong');
    strong.textContent = meta ? meta.name : selectedVariant;
    chip1.append(strong);
  }
  const chip2 = document.createElement('span');
  chip2.textContent = isJoin ? '加入已有房间' : '成为房主（东家）';
  formSummaryEl.append(chip1, chip2);
  // 分享链接只是「房间码预填充」的入口 —— 明确告知码可改、也可返回上一步
  if (isJoin && codeFromLink) {
    const chip3 = document.createElement('span');
    chip3.textContent = '房间码已预填 · 可修改';
    formSummaryEl.append(chip3);
  }
}

/** 切换步骤：更新可见面板 + 步骤条 */
function goStep(id: StepId): void {
  wizardStepId = id;
  stepModeEl.classList.toggle('hidden', id !== 'mode');
  stepVariantEl.classList.toggle('hidden', id !== 'variant');
  stepFormEl.classList.toggle('hidden', id !== 'form');
  renderSteps();
  homeError.classList.add('hidden');
  if (id === 'form') {
    renderWizardForm();
    const target =
      nameInput.value.trim() && wizardMode === 'join' && !codeInput.value.trim()
        ? codeInput
        : nameInput;
    setTimeout(() => target.focus(), 30);
  }
}

// 步骤条回退：点「已完成」的步骤回到那一步（未完成的步骤不可点）。
// 分享链接进来的用户也能这样回到模式步，去创建房间或重选加入。
stepsEl.addEventListener('click', (ev) => {
  const item = (ev.target as HTMLElement).closest<HTMLElement>('.step-item');
  if (!item || !item.classList.contains('done')) return;
  const idx = stepSeq().indexOf(item.dataset.step as StepId);
  if (idx >= 0 && idx < stepSeq().indexOf(wizardStepId)) goStep(item.dataset.step as StepId);
});

// 第 ① 步：选「创建」→ 去挑玩法；选「加入」→ 直接填房间码（玩法由房间决定）
$<HTMLButtonElement>('#mode-create').addEventListener('click', () => {
  wizardMode = 'create';
  dropRoomParam(); // 改走创建分支 → 不再需要链接里的房间码
  goStep('variant');
});
$<HTMLButtonElement>('#mode-join').addEventListener('click', () => {
  wizardMode = 'join';
  goStep('form');
});
// 第 ② 步（仅创建分支）
variantBackBtn.addEventListener('click', () => goStep('mode'));
variantNextBtn.addEventListener('click', () => goStep('form'));
// 最后一步
formBackBtn.addEventListener('click', () => goStep(wizardMode === 'join' ? 'mode' : 'variant'));

function submitWizardForm(): void {
  if (wizardStepId !== 'form') return;
  const name = nameInput.value.trim();
  if (!name) {
    showHomeError('请先填写昵称');
    nameInput.focus();
    return;
  }
  localStorage.setItem('mj-name', name);
  if (wizardMode === 'join') {
    const code = codeInput.value.trim().toUpperCase();
    if (code.length !== 6) {
      showHomeError('房间码为 6 位');
      codeInput.focus();
      return;
    }
    homeError.classList.add('hidden');
    connectAndSend({ t: 'join', code, name });
    return;
  }
  homeError.classList.add('hidden');
  // 玩法随创建消息上送（服务端按 id 取规则，未知 id 回退南昌）
  connectAndSend({ t: 'create', name, variant: selectedVariant });
}

formSubmitBtn.addEventListener('click', submitWizardForm);
for (const input of [nameInput, codeInput]) {
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') submitWizardForm();
  });
}

renderVariants();
renderBgSwitch();
initChat();
initChatTabs();
initEmote();

// 分享链接（?room=房间码）：**仅作为房间码预填充的入口** ——
// 落在「加入房间」表单上、房间码已填好但**可编辑**；同时保留完整的向导能力：
// 可点「上一步」或步骤条回到模式步，去创建自己的房间 / 重选加入 / 改房间码。
const roomParam = new URLSearchParams(location.search).get('room');
const roomParamCode = roomParam ? roomParam.toUpperCase().slice(0, 6) : '';
if (roomParamCode) {
  codeFromLink = true;
  wizardMode = 'join';
  codeInput.value = roomParamCode;
  goStep('form');
} else {
  goStep('mode');
  setTimeout(() => nameInput.focus(), 50);
}

/** 用户改走别的分支（如创建房间）时把 URL 里的 room 去掉，避免刷新又被拉回「加入某房间」 */
function dropRoomParam(): void {
  if (!codeFromLink) return;
  try {
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url.toString());
  } catch {
    /* 隐私模式等场景失败可忽略：只影响刷新后的预填 */
  }
}

// 刷新页面自动重连（对局中断线也能回桌）
const savedToken = localStorage.getItem('mj-token');
if (savedToken) {
  autoResume = true;
  connectAndSend({ t: 'resume', token: savedToken });
}

function showScreen(name: 'home' | 'lobby' | 'game'): void {
  homeView.classList.toggle('hidden', name !== 'home');
  tableView.classList.toggle('hidden', name !== 'lobby');
  gameView.classList.toggle('hidden', name !== 'game');
  refreshCanvasFit();
}

/** 画布尺寸依赖容器剩余空间：切换页面后立即量一次，并在布局落定后再校正一次 */
function refreshCanvasFit(): void {
  fitCanvas();
  requestAnimationFrame(fitCanvas);
}

function showHomeError(text: string): void {
  homeError.textContent = text;
  homeError.classList.remove('hidden');
}

function sendMsg(msg: ClientMsg): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connectAndSend(action: ClientMsg): void {
  pending = action;
  // 连接中（CONNECTING）不要另开一条：否则两条连接会各发一次（resume + create/join），
  // 服务端把第二条判为「你已经在房间里了」，用户点创建/加入却静默回到旧房间。
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    flush();
    return;
  }
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.addEventListener('open', flush);
  ws.addEventListener('message', (ev) => {
    handle(JSON.parse(String(ev.data)) as ServerMsg);
  });
  ws.addEventListener('close', () => {
    if (!inRoom) return; // 向导/大厅态断线：维持原行为，只提示
    if (reconnTimer !== undefined) return; // 已在重连队列中
    connBanner.textContent = '连接已断开，正在重连…';
    connBanner.classList.remove('hidden');
    scheduleReconnect();
  });
}

/** 指数退避重连：每次间隔 1s、2s、3s…（上限 4s）。凭 localStorage 里的 token resume 回原座位，
 *  服务端在宽限期内会保留座位；超时未连上才提示手动刷新。 */
function scheduleReconnect(): void {
  if (reconnTries >= RECONNECT_MAX_TRIES) {
    reconnTimer = undefined;
    connBanner.textContent = '连接已断开，请刷新页面重连';
    return;
  }
  reconnTries += 1;
  reconnTimer = setTimeout(() => {
    reconnTimer = undefined;
    if (!inRoom) return;
    if (ws && ws.readyState === WebSocket.OPEN) return; // 已恢复
    const token = localStorage.getItem('mj-token');
    if (!token) {
      connBanner.textContent = '连接已断开，请刷新页面重连';
      return;
    }
    // 借 autoResume 的兜底：若座位已过宽限期被回收，回向导并带上房间码
    autoResume = true;
    connectAndSend({ t: 'resume', token });
  }, Math.min(1000 * reconnTries, 4000));
}

function flush(): void {
  if (pending && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(pending));
    pending = null;
  }
}

function addFeed(text: string): void {
  const li = document.createElement('li');
  li.textContent = text;
  feedEl.prepend(li);
  // 与聊天记录一致设上限（新的在前，丢最旧）：对局中的事件也往这个（隐藏的）大厅
  // feed 里写，长时间蹲一个房间（多局连打 / 异常刷屏）不裁的话节点会无限堆积。
  while (feedEl.children.length > 200) feedEl.removeChild(feedEl.lastElementChild!);
}

// ---------- 局内聊天 ----------

/** 单条消息渲染进记录框并自动滚到底部（用 textContent，天然防 XSS） */
function appendChatEl(seat: number, name: string, text: string): void {
  const li = document.createElement('li');
  if (seat === mySeat) li.className = 'self';
  const nm = document.createElement('span');
  nm.className = 'chat-name';
  nm.textContent = name + '：';
  const tx = document.createElement('span');
  tx.className = 'chat-text';
  tx.textContent = text;
  li.append(nm, tx);
  chatLogEl.append(li);
  // 超出上限时丢弃最旧节点
  while (chatLogEl.children.length > 200) chatLogEl.removeChild(chatLogEl.firstChild!);
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

/** 收到聊天广播：入历史 + 渲染 */
function addChat(msg: { seat: number; name: string; text: string }): void {
  chatHistory.push(msg);
  if (chatHistory.length > 200) chatHistory.shift();
  appendChatEl(msg.seat, msg.name, msg.text);
  // 收起态收到**别人**的消息 → 标题栏亮红点，避免「默认最小化」导致漏消息。
  // 自己发的不计（收起时也发不出，这里只是防御）。
  if (msg.seat !== mySeat && chatEl.classList.contains('collapsed')) {
    chatUnread = Math.min(chatUnread + 1, 999);
    renderChatBadge();
  }
}

/** 刷新未读红点与「收起 / 展开」按钮的无障碍标签（只有收起态才提示未读） */
function renderChatBadge(): void {
  const collapsed = chatEl.classList.contains('collapsed');
  const n = collapsed ? chatUnread : 0;
  chatBadgeEl.hidden = n <= 0;
  chatBadgeEl.textContent = n <= 0 ? '' : n > 99 ? '99+' : String(n);
  chatMinBtn.setAttribute(
    'aria-label',
    (collapsed ? '展开聊天' : '收起聊天') + (n > 0 ? `，${n} 条未读消息` : ''),
  );
}

/** 明确读过了（展开、离房）→ 清空未读 */
function clearChatUnread(): void {
  if (chatUnread === 0 && chatBadgeEl.hidden) return;
  chatUnread = 0;
  renderChatBadge();
}

function sendChat(text: string): void {
  const t = text.trim();
  if (!t) return;
  sendMsg({ t: 'chat', text: t });
}

/** 初始化聊天面板：构建快捷语 / 表情、绑定发送与开关 */
function initChat(): void {
  // 字数上限只认 shared 的常量（服务端用同一个值裁剪），别在 HTML 里各写一遍
  chatInputEl.maxLength = CHAT_TEXT_MAX;
  // 快捷语：点击即发送
  chatQuickEl.textContent = '';
  for (const q of CHAT_QUICK) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chat-chip';
    b.textContent = q;
    b.addEventListener('click', () => {
      sendChat(q);
      chatQuickEl.hidden = true;
      chatQuickBtn.classList.remove('active');
    });
    chatQuickEl.append(b);
  }
  // 表情：点击即发送（与快捷语一致）—— 不再插入输入框，
  // 避免「点一下表情、还得再点一次发送」的两步操作，也不干扰用户已输入的文字
  chatEmojiEl.textContent = '';
  for (const e of CHAT_EMOJI) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chat-chip';
    b.textContent = e;
    b.addEventListener('click', () => {
      sendChat(e);
      chatEmojiEl.hidden = true;
      chatEmojiBtn.classList.remove('active');
    });
    chatEmojiEl.append(b);
  }

  const togglePop = (pop: HTMLElement, btn: HTMLButtonElement, other: HTMLElement, otherBtn: HTMLButtonElement): void => {
    const show = pop.hidden;
    pop.hidden = !show;
    btn.classList.toggle('active', show);
    other.hidden = true;
    otherBtn.classList.remove('active');
  };
  chatQuickBtn.addEventListener('click', () => togglePop(chatQuickEl, chatQuickBtn, chatEmojiEl, chatEmojiBtn));
  chatEmojiBtn.addEventListener('click', () => togglePop(chatEmojiEl, chatEmojiBtn, chatQuickEl, chatQuickBtn));

  chatSendBtn.addEventListener('click', () => {
    sendChat(chatInputEl.value);
    chatInputEl.value = '';
  });
  chatInputEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      sendChat(chatInputEl.value);
      chatInputEl.value = '';
    }
  });

  // 收起 / 展开：只留标题栏，避免遮挡牌桌控件。
  // 触摸设备收起后收成一个图标钮（移动端 .chat.collapsed 只有 46×44），故用 💬 更达意。
  const chatToggleIcon = (collapsed: boolean): string =>
    collapsed ? (isTouchDevice() ? '💬' : '▢') : '—';
  /** 关掉表情 / 快捷语弹层——它们必须与聊天窗口的收展状态一致 */
  const closeChatPops = (): void => {
    chatQuickEl.hidden = true;
    chatEmojiEl.hidden = true;
    chatQuickBtn.classList.remove('active');
    chatEmojiBtn.classList.remove('active');
  };
  const applyChatCollapsed = (collapsed: boolean): void => {
    chatEl.classList.toggle('collapsed', collapsed);
    chatMinBtn.textContent = chatToggleIcon(collapsed);
    if (collapsed) closeChatPops(); // 面板随窗口一起收起，不留在窗口外继续显示
    else {
      chatLogEl.scrollTop = chatLogEl.scrollHeight;
      chatUnread = 0; // 展开了就等于看过了
    }
    renderChatBadge(); // 顺带刷新红点与按钮的 aria-label（收起时才显示未读数）
  };
  chatMinBtn.addEventListener('click', () => {
    applyChatCollapsed(!chatEl.classList.contains('collapsed'));
  });

  // 默认收起（桌面端与移动端一致）：局内展开的聊天框会压住牌桌右下角
  applyChatCollapsed(true);
}

// ---------------------------------------------------------------------------
// 操作记录（对局日志）
// ---------------------------------------------------------------------------

const LOG_ACTION_LABEL: Record<string, string> = {
  discard: '出牌',
  chi: '吃',
  peng: '碰',
  gang: '杠',
  angang: '暗杠',
  bugang: '补杠',
  hu: '胡',
  draw: '流局',
};

/** 渲染操作记录列表 */
function renderLog(v: GameView): void {
  logListEl.textContent = '';
  const names = v.names ?? [];
  for (const entry of v.log) {
    const li = document.createElement('li');
    const seat = document.createElement('span');
    seat.className = 'log-seat';
    seat.textContent = entry.seat >= 0 ? (names[entry.seat] ?? `座位${entry.seat + 1}`) : '系统';
    const action = document.createElement('span');
    action.className = `log-action ${entry.kind}`;
    action.textContent = LOG_ACTION_LABEL[entry.kind] ?? entry.kind;
    li.append(seat, action);
    if (entry.tiles.length > 0) {
      const tiles = document.createElement('span');
      tiles.className = 'log-tiles';
      tiles.textContent = entry.tiles.map(tileName).join('');
      li.append(tiles);
    }
    if (entry.note) {
      const note = document.createElement('span');
      note.className = 'log-note';
      note.textContent = entry.note;
      li.append(note);
    }
    logListEl.append(li);
  }
  logListEl.scrollTop = logListEl.scrollHeight;
}

/** 初始化标签页切换 */
function initChatTabs(): void {
  chatTabChat.addEventListener('click', () => {
    chatEl.classList.remove('show-log');
    chatTabChat.classList.add('active');
    chatTabLog.classList.remove('active');
  });
  chatTabLog.addEventListener('click', () => {
    chatEl.classList.add('show-log');
    chatTabLog.classList.add('active');
    chatTabChat.classList.remove('active');
    if (lastGameView) renderLog(lastGameView);
  });
}

// ---------------------------------------------------------------------------
// 互动表情（定向投掷）：选玩家 → 选表情 → 服务端广播 → 各端在**目标位置**播动画
// ---------------------------------------------------------------------------

/** 当前选中的投掷目标座位（null = 尚未选人，此时表情格禁用，避免误发） */
let emoteTargetSeat: number | null = null;

/** 座位相对称呼（下家 / 对家 / 上家）——与牌桌镜像视角一致 */
function relSeatName(seat: number): string {
  const d = (((seat - mySeat) % 4) + 4) % 4;
  return ['自己', '下家', '对家', '上家'][d] ?? `${seat}号`;
}

/** 座位昵称：局内取视图里的名字 → 退回大厅名单 → 退回风位 */
function seatNickname(seat: number): string {
  const n = lastGameView?.names?.[seat];
  if (n) return n;
  return lastState?.players.find((x) => x.seat === seat)?.name ?? wind(seat);
}

function renderEmoteTargets(): void {
  emoteTargetsEl.textContent = '';
  for (let seat = 0; seat < 4; seat++) {
    if (seat === mySeat) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `emote-target${seat === emoteTargetSeat ? ' active' : ''}`;
    b.textContent = `${relSeatName(seat)} ${wind(seat)}·${seatNickname(seat)}`;
    b.addEventListener('click', () => {
      emoteTargetSeat = seat;
      renderEmoteTargets();
      renderEmoteGrid();
    });
    emoteTargetsEl.append(b);
  }
}

function renderEmoteGrid(): void {
  emoteGridEl.textContent = '';
  // 按语气分组展示（表在 shared，分组标题也来自 shared；某组为空则整组跳过）
  for (const g of THROW_EMOJI_TONES) {
    const list = THROW_EMOJI.filter((e) => e.tone === g.tone);
    if (list.length === 0) continue;
    const label = document.createElement('div');
    label.className = `emote-group ${g.tone}`;
    label.textContent = g.label;
    emoteGridEl.append(label);
    for (const e of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `emote-cell ${e.tone}`;
      b.disabled = emoteTargetSeat === null; // 没选人不给点，避免「扔错人」
      const ico = document.createElement('span');
      ico.className = 'ico';
      ico.textContent = e.icon;
      const nm = document.createElement('span');
      nm.textContent = e.name;
      b.append(ico, nm);
      b.addEventListener('click', () => {
        if (emoteTargetSeat === null) return;
        sendMsg({ t: 'emote', target: emoteTargetSeat, emote: e.id });
        closeEmotePicker();
      });
      emoteGridEl.append(b);
    }
  }
}

/** 打开选择面板；preselect 用于「点对手铭牌直达」 */
function openEmotePicker(preselect?: number): void {
  if (mySeat < 0) return;
  emoteTargetSeat = preselect !== undefined && preselect !== mySeat ? preselect : null;
  renderEmoteTargets();
  renderEmoteGrid();
  emotePicker.classList.remove('hidden');
}

function closeEmotePicker(): void {
  emotePicker.classList.add('hidden');
  emoteTargetSeat = null;
}

function initEmote(): void {
  emoteBtn.addEventListener('click', () => openEmotePicker());
  emoteCancelBtn.addEventListener('click', () => closeEmotePicker());
  // 点卡片外的遮罩关闭；点卡片内部不关
  emotePicker.addEventListener('click', (ev) => {
    if (ev.target === emotePicker) closeEmotePicker();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !emotePicker.classList.contains('hidden')) closeEmotePicker();
  });
  // 直接点对手铭牌 = 预选该玩家打开面板
  table.onTagClick = (seat) => {
    if (seat !== mySeat) openEmotePicker(seat);
  };
}

function handle(msg: ServerMsg): void {
  // 应用级心跳应答（小程序端用）：web 端走 ws 级 ping/pong，这里只需忽略
  if (msg.t === 'pong') return;
  if (msg.t === 'error') {
    if (!settleEl.classList.contains('hidden')) {
      settleHideBtn.disabled = false;
      settleNextBtn.disabled = false;
    }
    if (autoResume) {
      autoResume = false;
      const savedRoom = localStorage.getItem('mj-room');
      localStorage.removeItem('mj-token');
      localStorage.removeItem('mj-room');
      // 自动重连失败 → 回到向导：记着上次的房间码就落到「加入」表单，否则从第 1 步重来
      if (savedRoom) {
        codeInput.value = savedRoom.toUpperCase().slice(0, 6);
        wizardMode = 'join';
        goStep('form');
      } else {
        goStep('mode');
      }
      showHomeError(msg.reason);
      return;
    }
    if (inRoom && !gameView.classList.contains('hidden')) showControlsError(msg.reason);
    else if (inRoom) addFeed(`⚠ ${msg.reason}`);
    else showHomeError(msg.reason);
    return;
  }
  if (msg.t === 'event') {
    addFeed(msg.text);
    return;
  }
  if (msg.t === 'chat') {
    addChat(msg);
    // 铭牌气泡：在自己铭牌上显示刚说的话，几秒后自动消失
    table.pushBubble(msg.seat, msg.text, 'text');
    return;
  }
  if (msg.t === 'emote') {
    const fx = throwEmojiOf(msg.emote);
    if (!fx) return;
    // 全员收到同一条广播：在【目标玩家位置】播动画，并在目标铭牌上弹内容气泡
    table.pushEmote(msg.from, msg.target, fx.icon);
    table.pushBubble(msg.target, `${fx.icon} ${fx.name}`, 'emote');
    addChat({
      seat: msg.from,
      name: seatNickname(msg.from),
      text: `向${relSeatName(msg.target)}扔了 ${fx.icon}${fx.name}`,
    });
    return;
  }
  if (msg.t === 'variant') {
    // 结算/摊牌窗口内的玩法切换：只刷新切换器与积分显示，不切换视图
    currentVariant = msg.variant;
    const s = lastState;
    if (s) {
      buildVariantSwitch(variantSwitchEl, msg.variant, s.players.some((p) => p.seat === s.you && p.isHost));
    }
    if (!settleEl.classList.contains('hidden')) {
      buildVariantSwitch(settleVariantEl, msg.variant, !!lastGameView && lastGameView.hostSeat === mySeat);
    }
    if (msg.totals) {
      if (lastGameView) lastGameView.totals = msg.totals;
      applySettleTotals(msg.totals);
    }
    showToast(`玩法已切换为「${variantName(msg.variant)}」${msg.cleared ? '，积分已清零' : ''}`);
    return;
  }
  if (msg.t === 'settle') {
    renderSettle(msg);
    return;
  }
  if (msg.t === 'dissolved') {
    // 房主解散：弹出最终积分，关闭后回首页
    localStorage.removeItem('mj-token');
    localStorage.removeItem('mj-room');
    dissolveTitle.textContent = msg.title;
    renderDissolved(msg);
    dissolveEl.classList.remove('hidden');
    return;
  }
  if (msg.t === 'swapAsk') {
    // 有人想与我换位 → 弹窗征求意见
    swapTextEl.textContent = `${wind(msg.from)}家「${msg.fromName}」想与你交换座位，是否同意？`;
    swapEl.classList.remove('hidden');
    return;
  }
  autoResume = false;
  reconnTries = 0; // 已连上：重置退避计数，下次断线从 1s 重新开始
  connBanner.classList.add('hidden');
  if (msg.t === 'state') {
    inRoom = true;
    lastGameView = null;
    mySeat = msg.you;
    curDealer = msg.dealer ?? 0; // 风位随庄：大厅风位按当前庄家换算（旧服务端无此字段时兜底 0）
    hideSettle();
    clearDiceOverlay();
    tickCountdown();
    // 换位请求已处理/取消 → 收起询问弹窗（避免残留）
    if (!msg.pendingSwap || msg.pendingSwap.to !== msg.you) swapEl.classList.add('hidden');
    localStorage.setItem('mj-token', msg.token);
    localStorage.setItem('mj-room', msg.code);
    showScreen('lobby');
    renderLobby(msg);
    return;
  }
  inRoom = true;
  lastState = null;
  mySeat = msg.view.mySeat;
  showScreen('game');
  renderGame(msg.view);
}

function hideSettle(): void {
  settleEl.classList.add('hidden');
  settleRestoreBtn.classList.add('hidden');
}

// ---------- 响应窗口倒计时 ----------

function tickCountdown(): void {
  const d = lastGameView?.windowDeadline;
  if (lastGameView && lastGameView.phase === 'playing' && d) {
    const left = Math.max(0, d - Date.now());
    countdownEl.textContent = `响应倒计时 ${(left / 1000).toFixed(1)} 秒`;
    countdownEl.classList.remove('hidden');
  } else {
    countdownEl.classList.add('hidden');
  }
}
setInterval(tickCountdown, 100);

// ---------- 结算面板 ----------

/** 赣州冲关结算面板：每人三笔账（精分 / 胡牌分 / 杠分）+ 四人交叉与直付明细 */
function renderGzSettle(m: SettleMsg): void {
  const gz = m.gz!;
  const nameOf = (seat: number): string => m.rows.find((r) => r.seat === seat)?.name ?? String(seat);
  lastSettleMsg = m;
  settleRowOrder = gz.rows.map((r) => r.seat);
  renderSettleVariantSwitch();
  settleTitle.textContent = m.title;
  settleRows.textContent = '';
  settleHideBtn.disabled = false;
  settleNextBtn.disabled = false;
  settleRestoreBtn.classList.add('hidden');

  const fmtDelta = (v: number): string => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}`);
  const table = document.createElement('table');
  table.className = 'settle-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['玩家', '正精', '副精', '精分', '冲关', '胡牌分', '杠分', '本盘总分', '本局得分', '累计']) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const r of gz.rows) {
    const tr = document.createElement('tr');
    if (r.seat === mySeat) tr.className = 'me-row';
    const total = m.totals.find((t) => t.seat === r.seat)?.value ?? 0;
    // 精分（§5.2 新口径）：逐组冲关，显示终值；冲关列列出各组倍数
    const cgs = [...new Set(r.jingCombos.filter((c) => c.score > 0 && c.chongguan > 1).map((c) => c.chongguan))];
    const jingDesc = r.jingFinal === 0 ? '—' : `${r.jingFinal}${r.jingCombos.some((c) => c.jingba) ? ' ·精霸' : ''}`;
    const cells = [
      nameOf(r.seat),
      String(r.pi),
      String(r.fu),
      jingDesc,
      cgs.length > 0 ? cgs.map((x) => `×${x}`).join('') : '—',
      r.pattern > 0 ? String(r.pattern) : '—',
      r.gang > 0 ? String(r.gang) : '—',
      String(r.total),
      fmtDelta(r.delta),
      fmtDelta(total),
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = c;
      if (i === 8 || i === 9) {
        td.classList.add('total-col');
        const v = i === 8 ? r.delta : total;
        if (v > 0) td.classList.add('pos');
        else if (v < 0) td.classList.add('neg');
      }
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  settleRows.append(table);

  settleNotes.textContent = '';
  for (const line of m.notes) {
    const div = document.createElement('div');
    div.textContent = line;
    settleNotes.append(div);
  }
  const totalText = m.totals.map((t) => `${t.name} ${t.value >= 0 ? '+' : ''}${t.value}`).join('　');
  settleTotals.textContent = `累计子：${totalText}`;
  settleEl.classList.remove('hidden');
}

function renderSettle(m: SettleMsg): void {
  // 赣州冲关：精分 / 冲关 / 胡牌分 / 杠分 / 本盘总分 + 交叉与直付明细（§7）
  if (m.gz) {
    renderGzSettle(m);
    return;
  }
  settleTitle.textContent = m.title;
  settleRows.textContent = '';
  settleHideBtn.disabled = false;
  settleNextBtn.disabled = false;
  settleRestoreBtn.classList.add('hidden');
  settleEl.classList.remove('hidden');
  lastSettleMsg = m;
  settleRowOrder = m.rows.map((r) => r.seat);
  renderSettleVariantSwitch();

  const fmtIn = (v: number): string => (v > 0 ? `+${v}` : '—');
  const fmtOut = (v: number): string => (v > 0 ? `−${v}` : '—');
  const fmtDelta = (v: number): string => (v === 0 ? '0' : `${v > 0 ? '+' : ''}${v}`);

  const table = document.createElement('table');
  table.className = 'settle-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['玩家', '正精', '副精', '胡进', '胡出', '精进', '精出', '本局得分', '累计']) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const r of m.rows) {
    const tr = document.createElement('tr');
    if (r.seat === mySeat) tr.className = 'me-row';
    const total = m.totals.find((t) => t.seat === r.seat)?.value ?? 0;
    const cells = [
      r.name,
      String(r.pi),
      String(r.fu),
      fmtIn(r.patternIn),
      fmtOut(r.patternOut),
      fmtIn(r.jingIn),
      fmtOut(r.jingOut),
      fmtDelta(r.delta),
      fmtDelta(total),
    ];
    cells.forEach((c, i) => {
      const td = document.createElement('td');
      td.textContent = c;
      if (i === 3 && r.patternIn > 0) td.classList.add('pos');
      if (i === 4 && r.patternOut > 0) td.classList.add('neg');
      if (i === 5 && r.jingIn > 0) td.classList.add('pos');
      if (i === 6 && r.jingOut > 0) td.classList.add('neg');
      if (i >= 7) {
        td.classList.add('total-col');
        const v = i === 7 ? r.delta : total;
        if (v > 0) td.classList.add('pos');
        else if (v < 0) td.classList.add('neg');
      }
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  settleRows.append(table);

  settleNotes.textContent = '';
  for (const line of m.notes) {
    const div = document.createElement('div');
    div.textContent = line;
    settleNotes.append(div);
  }
  const totalText = m.totals.map((t) => `${t.name} ${t.value >= 0 ? '+' : ''}${t.value}`).join('　');
  settleTotals.textContent = `累计子：${totalText}`;
  settleEl.classList.remove('hidden');
}

settleHideBtn.addEventListener('click', () => {
  // 最小化结算框 → 看清摊开的牌；右下角「本局结算 ▲」可再次展开
  settleEl.classList.add('hidden');
  settleRestoreBtn.classList.remove('hidden');
});

settleRestoreBtn.addEventListener('click', () => {
  settleEl.classList.remove('hidden');
  settleRestoreBtn.classList.add('hidden');
});

settleNextBtn.addEventListener('click', () => {
  settleHideBtn.disabled = true;
  settleNextBtn.disabled = true;
  sendMsg({ t: 'nextRound' }); //回大厅并默认就绪；四人齐直接开下一局
});

// ---------- 大厅 ----------

function renderLobby(s: StateMsg): void {
  lastState = s;
  roomCodeEl.textContent = s.code;
  roomVariantEl.textContent = variantName(s.variant);
  roomVariantEl.classList.remove('hidden');
  currentVariant = s.variant;
  buildVariantSwitch(variantSwitchEl, s.variant, s.players.some((p) => p.seat === s.you && p.isHost));
  // 首局定庄状态（仅赣州起用）：?? 兜底——滚动升级时可能短暂连到还没带这些字段的旧服务端，别整页崩。
  const dealerRolls = s.dealerRolls ?? [];
  const dealerDecided = s.dealerDecided ?? false;
  const needRoll = getRules(s.variant).flow.firstDealerRoll === true;
  const inDealerRoll = needRoll && !dealerDecided;
  const dealerRollOf = (seat: number) => dealerRolls.find((r) => r.seat === seat);

  const me = s.players.find((p) => p.seat === s.you);
  const meScore = s.totals?.[s.you] ?? 0;
  meEl.textContent = me
    ? `${wind(s.you)}家 · ${me.name} · ${meScore > 0 ? '+' : ''}${meScore}分`
    : '';
  dissolveBtn.classList.toggle('hidden', !(me && me.isHost));
  // 加机器人按钮：仅房主、大厅未满 4 人时可见
  addBotBtn.classList.toggle('hidden', !(me && me.isHost) || s.players.length >= 4);

  const ps = s.pendingSwap;
  seatsEl.textContent = '';
  for (let seat = 0; seat < 4; seat++) {
    const p = s.players.find((x) => x.seat === seat);
    const isSelf = seat === s.you;
    const card = document.createElement('div');
    card.className =
      'seat' +
      (p ? (p.ready ? ' ready' : '') : ' empty') +
      (isSelf ? ' self' : p && p.isBot ? '' : ' swappable');
    const no = document.createElement('div');
    no.className = 'seat-no';
    no.textContent = `${wind(seat)}家${p && p.isHost ? ' · 房主' : ''}`;
    const nm = document.createElement('div');
    nm.className = 'seat-name';
    nm.textContent = p ? p.name : '等待加入…';
    if (p) {
      // 昵称旁的累计积分
      const sc = document.createElement('span');
      const tv = s.totals?.[seat] ?? 0;
      sc.className = 'seat-score ' + (tv > 0 ? 'pos' : tv < 0 ? 'neg' : 'zero');
      sc.textContent = tv > 0 ? `+${tv}` : `${tv}`;
      nm.append(sc);
      // 定庄掷骰期间（含已定庄）：已掷骰结果（金色，跟在名字旁）
      const roll = needRoll ? dealerRollOf(seat) : undefined;
      if (roll) {
        const dr = document.createElement('span');
        dr.className = 'seat-dr';
        dr.textContent = `${roll.dice[0]} + ${roll.dice[1]} = ${roll.sum} 点`;
        nm.append(dr);
      }
    }
    const st = document.createElement('div');
    st.className = 'seat-state';
    // 掉线宽限期（服务端默认 30s）：座位仍保留，可凭 token 重连回来
    const offline = !!p && p.connected === false;
    if (offline) st.classList.add('offline');
    st.textContent = !p
      ? ''
      : p.isBot
        ? '机器人 · 托管中'
        : offline
          ? '掉线 · 等待重连'
          : p.ready
            ? '已准备'
            : '未准备';
    card.append(no, nm, st);

    // 房主可移除机器人（对局中服务端会拒绝）
    if (p && p.isBot && me && me.isHost) {
      const kick = document.createElement('button');
      kick.type = 'button';
      kick.className = 'seat-kick';
      kick.textContent = '移除';
      kick.title = `移除 ${p.name}`;
      kick.addEventListener('click', (ev) => {
        ev.stopPropagation();
        sendMsg({ t: 'removeBot', seat });
      });
      card.append(kick);
    }

    // 换位状态：发起方 / 被请求方各显示一行提示
    if (ps && ps.from === seat) {
      const tip = document.createElement('div');
      tip.className = 'seat-swap pending';
      tip.textContent = `请求换到 ${wind(ps.to)}家…`;
      card.append(tip);
    } else if (ps && ps.to === seat) {
      const tip = document.createElement('div');
      tip.className = 'seat-swap ask';
      tip.textContent = '收到换位请求';
      card.append(tip);
    } else if (!isSelf && !(p && p.isBot)) {
      const tip = document.createElement('div');
      tip.className = 'seat-swap';
      tip.textContent = p ? '点击换位' : '空位 · 点此换入';
      card.append(tip);
    }

    if (!isSelf && !(p && p.isBot)) {
      card.title = p
        ? `与 ${p.name} 换位（需对方同意）`
        : `换到 ${wind(seat)}家空位（可直接换）`;
      card.addEventListener('click', () => requestSwap(seat));
    }
    seatsEl.append(card);
  }

  const self = s.players.find((p) => p.seat === s.you);
  readyBtn.textContent = self && self.ready ? '取消准备' : '准备';
  allReadyEl.classList.toggle('hidden', !s.allReady);

  // 首局定庄（仅赣州）：按钮在「准备」旁边；未定庄前可见，掷过/未满 4 人置灰
  drBtn.classList.toggle('hidden', !inDealerRoll);
  if (inDealerRoll) {
    const mine = dealerRollOf(s.you);
    // 未满 4 人不允许定庄（服务端同样校验，这里只是把按钮置灰避免点了才报错）
    drBtn.disabled = !!mine || !self || s.players.length < 4;
    drBtn.textContent = mine ? `已掷出 ${mine.sum} 点` : '打骰子';
  }
  // 最新一次掷骰 → 播局内同款覆盖层动画（翻滚 → 定格；结束后点数留在座位卡上）
  // 不受 decided 门控：定庄那一掷也要播；动画 key 保证同一掷不重播
  if (needRoll && dealerRolls.length > 0) {
    const latest = dealerRolls[dealerRolls.length - 1];
    const who = s.players.find((p) => p.seat === latest.seat)?.name ?? `${wind(latest.seat)}家`;
    runDiceAnim(
      latest.dice,
      `${dealerRolls.length}-${latest.seat}-${latest.sum}`,
      `${who} 掷骰…`,
      (d) => `${who} 掷出 ${d[0]} + ${d[1]} = ${latest.sum} 点`,
      1200,
      2600,
    );
  }
}

/** 玩法切换器（大厅 / 结算框通用）：仅房主可见可点，切换前弹确认框 */
function buildVariantSwitch(container: HTMLElement, current: string, editable: boolean): void {
  container.textContent = '';
  if (!editable) { container.classList.add('hidden'); return; }
  container.classList.remove('hidden');
  const label = document.createElement('span');
  label.className = 'vs-label';
  label.textContent = '玩法';
  container.append(label);
  for (const v of VARIANT_LIST) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'vs-opt' + (v.id === current ? ' active' : '');
    btn.textContent = v.name;
    btn.disabled = v.id === current;
    btn.addEventListener('click', () => { if (v.id !== current) openVariantConfirm(v.id); });
    container.append(btn);
  }
}

/** 打开「切换玩法」确认框（可选择是否清零累计积分） */
function openVariantConfirm(variant: string): void {
  pendingVariant = variant;
  variantConfirmTextEl.textContent = `切换为「${variantName(variant)}」。是否清除此前的累计积分？`;
  variantConfirmEl.classList.remove('hidden');
}

function submitVariantSwitch(clearScores: boolean): void {
  const v = pendingVariant;
  pendingVariant = '';
  variantConfirmEl.classList.add('hidden');
  if (!v) return;
  sendMsg({ t: 'setVariant', variant: v, clearScores });
}

/** 结算框内的玩法切换器（仅房主，结算窗口可切） */
function renderSettleVariantSwitch(): void {
  const host = !!lastGameView && lastGameView.hostSeat === mySeat;
  buildVariantSwitch(settleVariantEl, currentVariant, host);
}

/** 仅刷新结算表「累计」列与底部累计行（不清零时不重绘整表，避免按钮态被重置） */
function applySettleTotals(totals: number[]): void {
  if (!lastSettleMsg || settleEl.classList.contains('hidden')) return;
  const table = settleRows.querySelector('table.settle-table');
  if (table) {
    const trs = table.querySelectorAll('tbody tr');
    trs.forEach((tr, i) => {
      const seat = settleRowOrder[i];
      const cell = tr.lastElementChild as HTMLElement | null;
      if (seat === undefined || !cell) return;
      const val = totals[seat] ?? 0;
      cell.textContent = val === 0 ? '0' : val > 0 ? `+${val}` : `${val}`;
      cell.classList.toggle('pos', val > 0);
      cell.classList.toggle('neg', val < 0);
    });
  }
  const m = lastSettleMsg;
  const nameOf = (seat: number): string => m.totals.find((t) => t.seat === seat)?.name ?? String(seat);
  settleTotals.textContent = `累计子：${[0, 1, 2, 3]
    .map((s) => `${nameOf(s)} ${(totals[s] ?? 0) >= 0 ? '+' : ''}${totals[s] ?? 0}`)
    .join('　')}`;
}

vcCancelBtn.addEventListener('click', () => {
  pendingVariant = '';
  variantConfirmEl.classList.add('hidden');
});
vcKeepBtn.addEventListener('click', () => submitVariantSwitch(false));
vcClearBtn.addEventListener('click', () => submitVariantSwitch(true));

/** 请求换到目标座位：空位服务端直接换；有人则等对方同意 */
function requestSwap(toSeat: number): void {
  const s = lastState;
  if (!s) return;
  const ps = s.pendingSwap;
  if (ps) {
    showToast(
      ps.from === s.you
        ? `换位请求处理中：等待 ${wind(ps.to)}家同意`
        : '房间内已有换位请求在处理，请稍候',
    );
    return;
  }
  sendMsg({ t: 'swap', toSeat });
}

// ---------- 对局 ----------

/** 精牌列表文案：同牌面合并为「牌面×张数」（6 正精 / 6 副精 全列，不去重） */
function jingList(tiles: number[]): string {
  const c = new Map<number, number>();
  for (const t of tiles) c.set(t, (c.get(t) ?? 0) + 1);
  return [...c.entries()].map(([t, n]) => `${tileName(t)}${n > 1 ? `×${n}` : ''}`).join('/');
}

function renderGame(v: GameView): void {
  lastGameView = v;
  // 结算浮层还开着但服务端已经开下一局 → 收掉。2026-10-18 起「下一局」若全员就绪，
  // 服务端只发 game、不再广播大厅态（state→game 连发会把小程序端踹回大厅），收浮层靠这里。
  if (v.phase !== 'over' && !settleEl.classList.contains('hidden')) hideSettle();
  if (v.variant) currentVariant = v.variant;
  curDealer = v.dealer ?? 0; // 风位随庄
  dissolveGameBtn.classList.toggle('hidden', v.hostSeat !== v.mySeat);
  // 托管按钮：托管中显示高亮；摊牌后不可再切换（隐藏）
  const autoOn = v.auto
    ? (v.auto[v.mySeat] ?? false)
    : v.connected
      ? !v.connected[v.mySeat]
      : false;
  autoBtn.classList.toggle('hidden', v.phase === 'over');
  autoBtn.classList.toggle('on', autoOn);
  autoBtn.textContent = autoOn ? '托管中' : '托管';
  gCode.textContent = v.code;
  gVariant.textContent = v.variant ? variantName(v.variant) : '';
  const rp = ritualPhase(v);
  if (v.ceremony?.kind === 'deal' && rp === 'wait') gWall.textContent = '牌墙 136';
  else if (v.ceremony?.kind === 'deal' && rp === 'roll') gWall.textContent = '牌墙 …';
  else gWall.textContent = `牌墙 ${v.wallLeft}`;
  gJing.textContent =
    v.ceremony?.kind === 'jing' && v.ceremony.state === 'rolling'
      ? '' // 翻精骰揭示前不剧透（画布同拍显示）
      : v.gz
        ? v.gz.zheng.length > 0
          ? v.gz.revealed
            ? `正精 ${jingList(v.gz.zheng)} · 副精 ${jingList(v.gz.fu)}`
            : `正精 ${tileName(v.gz.zheng[0])}${
                v.gz.fu.length > 0 ? ` · 副精 ${tileName(v.gz.fu[0])}` : ''
              }（其余 10 张结算揭晓）`
          : ''
        : v.jingPi !== null && v.jingFu !== null
          ? `正精 ${tileName(v.jingPi)} · 副精 ${tileName(v.jingFu)}`
          : '';
  controlsErr.classList.add('hidden');
  table.render(v);
  renderControls(v);
  renderLog(v);
  tickCountdown();

  // 仪式驱动：骰子覆盖层 + 动画结束后的控件刷新
  if (v.ceremony?.state === 'rolling') {
    playDice(v);
    if (ceremonyAnim && ceremonyExpiryKey !== v.ceremony.rollAt) {
      ceremonyExpiryKey = v.ceremony.rollAt ?? -1;
      if (ceremonyExpiryTimer) clearTimeout(ceremonyExpiryTimer);
      ceremonyExpiryTimer = setTimeout(() => {
        ceremonyExpiryTimer = undefined;
        if (lastGameView) renderGame(lastGameView); // 仪式结束 → 解锁控件
      }, ceremonyAnim.dur + 80);
    }
  } else if (v.ceremony?.state === 'wait-roll') {
    clearDiceOverlay();
  }

  syncHandTray(v, rp);
  refreshCanvasFit();
}

/**
 * 移动端手牌操作条：把画布底部那条缩小后点不准的手牌带，换成一条 ≥44px 的
 * DOM 手牌带（真正的手指触控面）。桌面端恒为隐藏，原有交互不变。
 */
function syncHandTray(v: GameView, ritual: 'wait' | 'roll' | null): void {
  // 仪式进行中（画布故意逐步露牌）、摊牌后、以及有吃碰杠待选时都不显示
  if (!isTouchDevice() || ritual !== null || v.phase === 'over' || v.claims) {
    renderHandTray(null);
    return;
  }
  // 刚摸到的牌单独排在末尾（与画布一致：先剔重再单独摆）
  let hand = v.myTiles;
  if (v.drawn !== null) {
    const i = hand.indexOf(v.drawn);
    if (i >= 0) hand = [...hand.slice(0, i), ...hand.slice(i + 1)];
  }
  if (hand.length === 0 && v.drawn === null) {
    renderHandTray(null);
    return;
  }
  const myTurn = v.turn === v.mySeat;
  const canDiscard = v.phase === 'playing' && myTurn && !v.claimWindow;
  renderHandTray({
    hand,
    drawn: v.drawn,
    active: canDiscard,
    pi: v.jingPi,
    fu: v.jingFu,
    frozen: v.declared.filter((d) => d.seat === v.mySeat).map((d) => d.tile),
    must: v.mustDiscard,
  });
}

function showControlsError(text: string): void {
  controlsErr.textContent = text;
  controlsErr.classList.remove('hidden');
}

function renderControls(v: GameView): void {
  controls.textContent = '';
  if (v.phase === 'over') {
    if (v.reveal && v.winner !== null) {
      const wn = (v.names && v.names[v.winner]) || wind(v.winner);
      gStatus.textContent = `${wind(v.winner)}·${wn} 胡牌！${v.result ?? ''}　—— 点「最小化」看牌，点「下一局」继续`;
    } else if (v.reveal) {
      gStatus.textContent = '本局结束 · 摊牌中 —— 点「最小化」看牌，点「下一局」继续';
    } else {
      gStatus.textContent = `本局结束：${v.result ?? ''}`;
    }
    return;
  }

  const awaitingOthers = (v.awaiting ?? [])
    .filter((s) => s !== v.mySeat)
    .map((s) => wind(s));
  const awaitingAll = (v.awaiting ?? []).map((s) => wind(s));

  // 掷骰仪式：等待点击（按钮在桌面正中）/ 动画窗口
  const rp = ritualPhase(v);
  if (rp === 'wait' && v.ceremony) {
    const c = v.ceremony;
    const label = c.kind === 'deal' ? '掷骰开局' : c.kind === 'jing' ? '掷骰翻精' : '掷骰补牌';
    gStatus.textContent =
      c.seat === v.mySeat
        ? `点桌面正中的「${label}」按钮`
        : `等待${wind(c.seat)}家「${label}」…`;
    return;
  }
  if (rp === 'roll' && v.ceremony) {
    gStatus.textContent =
      v.ceremony.kind === 'deal'
        ? '掷骰定方位 → 抓牌动画中…'
        : v.ceremony.kind === 'jing'
          ? '翻精掷骰 → 定位正精中…'
          : '掷骰定位补牌中…';
    return;
  }

  if (v.claims) {
    gStatus.textContent = awaitingOthers.length
      ? `可以操作！还等：${awaitingOthers.join('、')}`
      : '轮到你选择 — 碰 / 杠 / 吃 / 胡，或点「过」';
    for (const opt of v.claims.options) {
      if (opt.kind === 'chi') {
        for (const choice of opt.chiChoices ?? []) {
          addBtn(`吃 ${choice.map((t) => tileName(t)).join(' ')}`, () => {
            sendMsg({ t: 'claim', kind: 'chi', chiTiles: choice });
            lockControls();
          });
        }
      } else if (opt.kind === 'peng') {
        addBtn(`碰 ${tileName(opt.tile)}`, () => {
          sendMsg({ t: 'claim', kind: 'peng' });
          lockControls();
        });
      } else if (opt.kind === 'hu') {
        // 特殊胡法在按钮上显示牌型名（如 德国 / 十三烂 / 德中德）
        addBtn(opt.label ? `胡·${opt.label}` : `胡 ${tileName(opt.tile)}`, () => {
          sendMsg({ t: 'claim', kind: 'hu' });
          lockControls();
        });
      } else {
        addBtn(`杠 ${tileName(opt.tile)}`, () => {
          sendMsg({ t: 'claim', kind: 'gang' });
          lockControls();
        });
      }
    }
    addBtn('过', () => {
      sendMsg({ t: 'pass' });
      lockControls();
    });
    return;
  }

  for (const sg of v.selfGangs) {
    addBtn(`${sg.kind === 'angang' ? '暗杠' : '补杠'} ${tileName(sg.tile)}`, () => {
      sendMsg({ t: 'selfGang', kind: sg.kind, tile: sg.tile });
      lockControls();
    }, true);
  }
  // 报杠（§8.5）：手里恰好 3 张的牌面可展示（冻结为三张，待第 4 张来杠）
  for (const dt of v.declareOptions) {
    addBtn(`展示 3 张 ${tileName(dt)}`, () => {
      sendMsg({ t: 'declareKong', tile: dt });
      lockControls();
    });
  }
  if (v.canZimo) {
    addBtn(v.zimoLabel ? `自摸·${v.zimoLabel}` : '自摸', () => {
      sendMsg({ t: 'zimo' });
      lockControls();
    });
  }

  if (v.canZimo)
    gStatus.textContent = v.zimoLabel ? `可以自摸（${v.zimoLabel}）！` : '可以自摸！';
  else if (v.turn === v.mySeat)
    gStatus.textContent = v.mustDiscard.length
      ? `必须先打出 ${v.mustDiscard.map((t) => tileName(t)).join('、')}（他人已展示）`
      : '轮到你了 — 点击手牌打出';
  else if (v.claimWindow)
    gStatus.textContent =
      (awaitingAll.length ? `等待 ${awaitingAll.join('、')} 应答…` : '等待响应…') +
      (v.skipRon ? '（你已过水，暂不能点炮胡）' : '');
  else gStatus.textContent = `等待${wind(v.turn)}家行动…`;
}

function addBtn(text: string, onClick: () => void, primary = true): void {
  const b = document.createElement('button');
  b.textContent = text;
  if (primary) b.classList.add('primary');
  b.addEventListener('click', onClick);
  controls.append(b);
}

function lockControls(): void {
  for (const b of Array.from(controls.querySelectorAll('button'))) {
    (b as HTMLButtonElement).disabled = true;
  }
}

/** 出牌唯一出口（画布点牌 + 手牌操作条）。报杠（§8.5）两条拦截先于发信。 */
function tryDiscard(tile: number): void {
  const v = lastGameView;
  if (v) {
    if (v.declared.some((d) => d.seat === v.mySeat && d.tile === tile)) {
      showToast(`已展示的 ${tileName(tile)} 要等第 4 张，不能打`);
      return;
    }
    if (v.mustDiscard.length > 0 && !v.mustDiscard.includes(tile)) {
      showToast(`必须先打出 ${v.mustDiscard.map((t) => tileName(t)).join('、')}`);
      return;
    }
  }
  sendMsg({ t: 'discard', tile });
}

table.onDiscard = (tile) => {
  tryDiscard(tile);
};

table.onRollDice = () => {
  sendMsg({ t: 'rollDice' });
};

// ---------- 交互 ----------

// ---------- 掷骰动画覆盖层 ----------

const PIP_MAP: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function setDieFace(el: HTMLDivElement, v: number): void {
  el.textContent = '';
  const pips = PIP_MAP[v] ?? [];
  const red = v === 1 || v === 4; // 中式骰子 1、4 为红
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement('span');
    if (pips.includes(i)) cell.className = red ? 'pip red' : 'pip';
    el.append(cell); // 9 宫格：空格子占位，pip 直接作为网格子项居中
  }
}

const diceAnim: {
  key: string | number | null;
  t1?: ReturnType<typeof setTimeout>;
  t2?: ReturnType<typeof setTimeout>;
  t3?: ReturnType<typeof setTimeout>;
  /** 翻滚期间的随机面刷新 */
  scramble?: ReturnType<typeof setInterval>;
} = { key: null };

function clearDiceOverlay(): void {
  if (diceAnim.t1) clearTimeout(diceAnim.t1);
  if (diceAnim.t2) clearTimeout(diceAnim.t2);
  if (diceAnim.t3) clearTimeout(diceAnim.t3);
  if (diceAnim.scramble) clearInterval(diceAnim.scramble);
  diceAnim.t1 = diceAnim.t2 = diceAnim.t3 = diceAnim.scramble = undefined;
  diceAnim.key = null;
  diceEl.classList.add('hidden');
  diceEl.classList.remove('show');
  die1.classList.remove('tumbling');
  die2.classList.remove('tumbling');
}

function diceResultText(v: GameView): string {
  const c = v.ceremony;
  if (!c || !c.dice) return '';
  if (c.kind === 'deal') {
    const sum = c.dice[0] + c.dice[1];
    const small = Math.min(c.dice[0], c.dice[1]);
    const pos = ((sum - 1) % 4) + 1;
    const seat = (v.dealer + sum - 1) % 4;
    return `点数和 ${sum} → 庄家起逆时针第 ${pos} 位（${wind(seat)}门前） · 小点 ${small} → 空 ${small} 列、第 ${small + 1} 列起牌`;
  }
  const sum = c.dice[0] + c.dice[1];
  if (c.kind === 'jing') return `点数和 ${sum} → 摸牌处逆时针第 ${sum} 列 · 上层翻开 = 正精`;
  return `点数和 ${sum} → 摸牌处逆时针第 ${sum} 列 · 上层取牌（无则取下层）`;
}

/** 通用掷骰动画引擎：翻滚随机面 → 定格真实点数 → 点数文字，结束后自动隐藏。
 *  局内仪式（playDice）与大厅定庄共用同一覆盖层。 */
function runDiceAnim(
  dice: [number, number],
  key: string | number,
  rollingMsg: string,
  landMsg: (dice: [number, number]) => string,
  tumbleMs: number,
  hideMs?: number,
): void {
  if (diceAnim.key === key) return;
  clearDiceOverlay();
  diceAnim.key = key;
  diceEl.classList.remove('hidden');
  // 翻滚期间持续刷随机点数（骰子始终有面），定格时换真实结果
  const scramble = (): void => {
    setDieFace(die1, 1 + Math.floor(Math.random() * 6));
    setDieFace(die2, 1 + Math.floor(Math.random() * 6));
  };
  scramble();
  diceAnim.scramble = setInterval(scramble, 90);
  diceMsg.textContent = rollingMsg;
  diceAnim.t1 = setTimeout(() => diceEl.classList.add('show'), 30);
  die1.classList.add('tumbling');
  die2.classList.add('tumbling');
  diceAnim.t2 = setTimeout(() => {
    if (diceAnim.scramble) {
      clearInterval(diceAnim.scramble);
      diceAnim.scramble = undefined;
    }
    die1.classList.remove('tumbling');
    die2.classList.remove('tumbling');
    setDieFace(die1, dice[0]);
    setDieFace(die2, dice[1]);
    diceMsg.textContent = landMsg(dice);
  }, tumbleMs);
  if (hideMs !== undefined) {
    diceAnim.t3 = setTimeout(() => clearDiceOverlay(), hideMs);
  }
}

/** 播放一次仪式掷骰动画（同一 rollAt 只播一次；时长取服务端窗口） */
function playDice(v: GameView): void {
  const c = v.ceremony;
  if (!c || c.state !== 'rolling' || c.rollAt === null || c.until === null) return;
  const dur = Math.max(400, c.until - c.rollAt);
  const tumbleMs = Math.min(c.kind === 'gang' ? 1500 : 2200, Math.floor(dur * 0.5));
  runDiceAnim(
    c.dice ?? [1, 1],
    c.rollAt,
    c.kind === 'deal' ? '庄家掷骰…' : c.kind === 'jing' ? '翻精掷骰…' : '杠后掷骰…',
    () => diceResultText(v),
    tumbleMs,
    dur + 550,
  );
}

// ---------- 仪式时钟（服务端窗口 → 本地演出时间轴） ----------

let ceremonyAnim: { key: number; start: number; dur: number } | null = null;
let ceremonyExpiryTimer: ReturnType<typeof setTimeout> | undefined;
let ceremonyExpiryKey = -1;

/** 'wait' = 等待点击掷骰；'roll' = 骰子/发牌动画窗口中；null = 无仪式或已结束 */
function ritualPhase(v: GameView): 'wait' | 'roll' | null {
  const c = v.ceremony;
  if (!c) return null;
  if (c.state === 'wait-roll') return 'wait';
  if (c.rollAt === null || c.until === null) return null;
  if (ceremonyAnim?.key !== c.rollAt) {
    ceremonyAnim = { key: c.rollAt, start: Date.now(), dur: Math.max(300, c.until - c.rollAt) };
  }
  return Date.now() - ceremonyAnim.start < ceremonyAnim.dur ? 'roll' : null;
}

function renderDissolved(m: Extract<ServerMsg, { t: 'dissolved' }>): void {
  dissolveRows.textContent = '';
  const table = document.createElement('table');
  table.className = 'settle-table';
  const thead = document.createElement('thead');
  const hr = document.createElement('tr');
  for (const h of ['玩家', '总积分']) {
    const th = document.createElement('th');
    th.textContent = h;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = document.createElement('tbody');
  for (const r of m.rows) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = r.name;
    const tdVal = document.createElement('td');
    tdVal.className = 'total-col' + (r.value > 0 ? ' pos' : r.value < 0 ? ' neg' : '');
    tdVal.textContent = r.value > 0 ? `+${r.value}` : `${r.value}`;
    tr.append(tdName, tdVal);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  dissolveRows.append(table);
}

$<HTMLButtonElement>('#dissolve-ok').addEventListener('click', () => {
  dissolveEl.classList.add('hidden');
  exitHome(false);
});

function confirmDissolve(): void {
  if (window.confirm('确定解散牌桌？所有玩家将退出，并弹出最终积分。')) {
    sendMsg({ t: 'dissolve' });
  }
}

/** 对局中：房主解散对局 = 强制结束本局、返回房间（房间保留） */
function confirmAbort(): void {
  if (window.confirm('确定解散对局？将强制结束当前对局并返回房间。')) {
    sendMsg({ t: 'abort' });
  }
}

dissolveBtn.addEventListener('click', confirmDissolve);
dissolveGameBtn.addEventListener('click', confirmAbort);

/** 离开/解散后的客户端清理（回首页） */
function exitHome(sendLeave: boolean): void {
  if (sendLeave) sendMsg({ t: 'leave' });
  localStorage.removeItem('mj-token');
  localStorage.removeItem('mj-room');
  ws?.close();
  ws = null;
  inRoom = false;
  lastGameView = null;
  lastState = null;
  mySeat = -1;
  tickCountdown();
  showScreen('home');
  feedEl.textContent = '';
  chatHistory = [];
  chatLogEl.textContent = '';
  logListEl.textContent = '';
  clearChatUnread();
  allReadyEl.classList.add('hidden');
  connBanner.classList.add('hidden');
  swapEl.classList.add('hidden');
  variantConfirmEl.classList.add('hidden');
  pendingVariant = '';
  currentVariant = '';
  settleRowOrder = [];
  lastSettleMsg = null;
  hideSettle();
  // 回到向导第 ① 步（玩法记忆保留）；离开房间后不再沿用分享链接的房间码标记
  codeFromLink = false;
  wizardMode = null;
  goStep('mode');
}

// ---------- 分享链接 ----------
function showToast(text: string): void {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('hidden'), 5000);
}

shareBtn.addEventListener('click', () => {
  const code = roomCodeEl.textContent?.trim();
  if (!code) return;
  const url = `${location.origin}/?room=${code}`;
  let copied = false;
  try {
    const ta = document.createElement('textarea');
    ta.value = url;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    copied = document.execCommand('copy');
    ta.remove();
  } catch {
    /* 忽略，走下面的提示 */
  }
  if (copied) {
    showToast(`链接已复制，发给朋友即可直接进房：${url}`);
  } else if (navigator.clipboard) {
    navigator.clipboard
      .writeText(url)
      .then(() => showToast(`链接已复制，发给朋友即可直接进房：${url}`))
      .catch(() => showToast(`请手动复制：${url}`));
  } else {
    showToast(`请手动复制：${url}`);
  }
});

readyBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const cancelling = readyBtn.textContent === '取消准备';
  sendMsg({ t: 'ready', ready: !cancelling });
});

leaveBtn.addEventListener('click', () => {
  exitHome(true);
});

// 加机器人：房主在大厅一键补一个占位机器人（满 4 人时按钮隐藏）
addBotBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  sendMsg({ t: 'addBot' });
});

// 托管开关：对局中随时切换，服务端代掷骰 / 代应答 / 代出牌
autoBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const on = autoBtn.classList.contains('on');
  sendMsg({ t: 'setAuto', auto: !on });
});

// 首局定庄：点一次掷两骰（服务端记录并广播；四人齐后点数最大者坐庄）
drBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  sendMsg({ t: 'rollDealer' });
});

// ---------- 换位请求应答 ----------

swapAcceptBtn.addEventListener('click', () => {
  swapEl.classList.add('hidden');
  sendMsg({ t: 'swapRespond', accept: true });
});

swapDeclineBtn.addEventListener('click', () => {
  swapEl.classList.add('hidden');
  sendMsg({ t: 'swapRespond', accept: false });
});
