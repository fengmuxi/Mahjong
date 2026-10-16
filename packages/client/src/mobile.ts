/**
 * 移动端适配模块（仅调整展示与交互，不触碰任何规则/协议逻辑）
 * ===========================================================================
 * 为什么需要它？牌桌是一块**定尺 1280×640 的画布**（`table.ts` 的 W/H），所有牌位
 * 尺寸写死在逻辑坐标里，靠 CSS 等比缩放去「适应」屏幕。手机竖屏时画布被压到 ~390px 宽，
 * 手牌逻辑宽 52px 缩放后只剩十几 CSS px —— 手指根本点不准。
 *
 * 关于「自动横屏」必须先认清平台事实，否则一定会写出"点了没反应"的代码：
 *   ① `screen.orientation.lock()` 需要**安全上下文**（HTTPS / localhost）。
 *      本项目典型部署是**局域网 HTTP**（`http://192.168.x.x:3000`）→ 不满足条件。
 *   ② 即使满足①，`lock()` 还要求文档**已真正处于全屏**：必须先进全屏、等
 *      `fullscreenchange` 落地之后再锁；紧挨着 await 就调用会被拒绝。
 *   ③ **iOS / iPadOS 的 Safari 完全不实现 Screen Orientation API**（Apple 明确不开放），
 *      任何"网页自动横屏"在 iPhone 上都不成立；manifest 的 orientation 在 iOS 也被忽略。
 *   ④ 退出全屏时必须**主动 `unlock()`**：否则 Android Chrome 上方向会被"卡"在横屏，
 *      表现为「点了全屏之后就转不回来了」。
 * 因此这里的策略是分层的：
 *   A. 首选「用户直接旋转设备」——零权限、全平台可用，用竖屏遮罩引导；
 *   B. 能力允许时提供「全屏 + 锁定横屏」，且**可逆**（能退出、能解锁）；
 *   C. 都不行时提供「强制横屏显示」——用 CSS 逻辑旋转 90°（`html.force-landscape`），
 *      零权限即可看到横屏牌桌，代价是文字与手机物理方向成 90°。
 *
 * 同时负责：
 *   · 用 `visualViewport` 实测高度刷新 CSS 变量（`--vv-*` / `--ld-*`），避免 100vh
 *     把底部内容顶到浏览器 UI 之下；并同步 `<html>` 上的门控类。
 *   · 手牌操作条：把画布底部那条缩小后点不准的手牌带，换成一条 ≥44px 的触控面。
 *   · 画布尺寸自适应：按容器实测空间与 2:1 比例反算，保证浏览器不介入裁剪
 *     （一旦画布被非等比拉伸，`table.ts` 基于 getBoundingClientRect 的点击换算会错位）。
 */

import { tileName } from '@shared/tiles.ts';
import { tileArt } from './tileart.ts';

const html = document.documentElement;
const LS_FORCE = 'mj-force-landscape';

/** 轻提示回调（由 main.ts 传入 showToast；未传入时静默） */
let notify: ((text: string) => void) | undefined;

/* ===========================================================================
   环境探测
   =========================================================================== */

/**
 * 是否触摸设备。**不看 `navigator.maxTouchPoints`**：带触摸屏的笔记本会报告多点触控，
 * 但主指针是鼠标 —— 误判会让用户首次点击就被强行全屏并锁成横屏。
 */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const ua = /Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(navigator.userAgent);
  return coarse || ua;
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    // iPadOS 13+ 伪装成 macOS，靠触点数区分
    (navigator.userAgent.includes('Macintosh') && (navigator.maxTouchPoints ?? 0) > 1)
  );
}

/** 真实可视视口尺寸 —— 这才是「用户真正能看到多大」，100vh 不是 */
export function visualViewportSize(): { w: number; h: number } {
  const vv = window.visualViewport;
  return {
    w: Math.round(vv?.width ?? window.innerWidth),
    h: Math.round(vv?.height ?? window.innerHeight),
  };
}

/** 物理方向：直接用可视视口宽高比判断（iOS 上 screen.orientation 恒为 portrait，不可用） */
export function isPortrait(): boolean {
  const { w, h } = visualViewportSize();
  return h >= w;
}

export interface Capability {
  /** 安全上下文（HTTPS / localhost）。局域网 HTTP 为 false */
  secure: boolean;
  /** Fullscreen API 可用 */
  fullscreen: boolean;
  /** 方向锁定可用（iOS 恒为 false） */
  lock: boolean;
  ios: boolean;
  /** 触屏设备 */
  touch: boolean;
}

export function platformCapability(): Capability {
  const anyDoc = document as Document & { webkitFullscreenEnabled?: boolean };
  return {
    secure: window.isSecureContext !== false,
    fullscreen: !!(document.fullscreenEnabled ?? anyDoc.webkitFullscreenEnabled),
    lock: !isIOS() && typeof (screen.orientation as { lock?: unknown } | undefined)?.lock === 'function',
    ios: isIOS(),
    touch: isTouchDevice(),
  };
}

/* ===========================================================================
   横屏引导 / 全屏 / 方向锁定
   =========================================================================== */

export type OrientFailure =
  | 'insecure-context'
  | 'ios'
  | 'no-api'
  | 'fullscreen-rejected'
  | 'lock-rejected';

export interface OrientResult {
  /** 是否进入全屏 */
  fullscreen: boolean;
  /** 是否成功锁定方向 */
  locked: boolean;
  reason?: OrientFailure;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type FsElement = HTMLElement & { webkitRequestFullscreen?: (o?: unknown) => Promise<void> | void };
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  webkitFullscreenEnabled?: boolean;
};

function fullscreenEl(): Element | null {
  const d = document as FsDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

export function fullscreenActive(): boolean {
  return !!fullscreenEl();
}

/** 等 fullscreenchange 真正落地（`lock()` 要求此刻文档确实处于全屏） */
function waitFullscreen(ms = 600): Promise<boolean> {
  return new Promise((resolve) => {
    if (fullscreenEl()) return resolve(true);
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      document.removeEventListener('fullscreenchange', finish);
      document.removeEventListener('webkitfullscreenchange', finish);
      clearTimeout(timer);
      resolve(!!fullscreenEl());
    };
    const timer = setTimeout(finish, ms);
    document.addEventListener('fullscreenchange', finish);
    document.addEventListener('webkitfullscreenchange', finish);
  });
}

/** 释放方向锁。退出全屏前必须调用，否则 Android Chrome 会把方向"卡"住 */
export function unlockOrientation(): void {
  try {
    (screen.orientation as { unlock?: () => void } | undefined)?.unlock?.();
  } catch {
    /* 未锁定时调用无害；部分浏览器无 unlock */
  }
}

/**
 * 全屏 + 锁定横屏（可逆：用 exitLandscapeFullscreen 退出）。必须由用户手势触发。
 *
 * 两步能力分开处理，任何一步失败都不阻塞另一步：
 *   ① 全屏：Fullscreen API **不要求安全上下文**，局域网 HTTP 也能用（能隐藏浏览器 UI）；
 *   ② 锁方向：要求安全上下文 + 文档已全屏（iOS 无此 API），失败如实返回。
 * 调用方（activateLandscape）在锁不住方向时会叠加 CSS 强制横屏兜底。
 */
export async function enterLandscapeFullscreen(): Promise<OrientResult> {
  const cap = platformCapability();
  if (!cap.touch) return { fullscreen: false, locked: false, reason: 'no-api' };
  if (!cap.fullscreen && !cap.lock) {
    return { fullscreen: false, locked: false, reason: cap.ios ? 'ios' : 'no-api' };
  }

  // 先清掉可能残留的方向锁，避免沿用上一轮的朝向
  unlockOrientation();

  let fs = fullscreenActive();
  if (!fs && cap.fullscreen) {
    const el = document.documentElement as FsElement;
    const fn = el.requestFullscreen ?? el.webkitRequestFullscreen;
    if (typeof fn !== 'function') return { fullscreen: false, locked: false, reason: 'no-api' };
    try {
      await fn.call(el, { navigationUI: 'hide' });
    } catch {
      /* 全屏被拒：继续尝试锁方向，最后如实返回 */
    }
    fs = await waitFullscreen(); // 关键：等 fullscreenchange，别紧接着就锁
  }

  if (cap.lock) {
    for (let i = 0; i < 3; i++) {
      try {
        const so = screen.orientation as unknown as { lock: (o: string) => Promise<void> };
        await so.lock('landscape');
        return { fullscreen: fs, locked: true };
      } catch {
        await sleep(150); // 平台差异：稍等重试，仍失败则如实返回
      }
    }
  }

  return {
    fullscreen: fs,
    locked: false,
    reason: !cap.lock ? (cap.ios ? 'ios' : 'no-api') : 'lock-rejected',
  };
}

/** 退出全屏（顺序很重要：先解锁方向，再退全屏，最后再解一次兜底）。 */
export async function exitLandscapeFullscreen(): Promise<void> {
  unlockOrientation();
  try {
    const d = document as FsDocument;
    const fn = d.exitFullscreen ?? d.webkitExitFullscreen;
    if (typeof fn === 'function' && fullscreenActive()) await fn.call(document);
  } catch {
    /* 忽略：可能已被用户手势/系统退出 */
  }
  await sleep(50);
  unlockOrientation();
}

export function failureText(reason?: OrientFailure): string {
  switch (reason) {
    case 'insecure-context':
      return '当前用局域网 HTTP 打开，浏览器禁止网页锁定方向（需 HTTPS）。请直接横握手机，或点「强制横屏显示」。';
    case 'ios':
      return 'iPhone / iPad 的浏览器不支持网页锁定方向（Apple 未开放该能力）。请直接横握手机，或点「强制横屏显示」。';
    case 'no-api':
      return '当前浏览器不支持网页全屏或方向锁定，请直接横握手机，或点「强制横屏显示」。';
    case 'fullscreen-rejected':
      return '浏览器拒绝了全屏请求，请直接横握手机，或点「强制横屏显示」。';
    case 'lock-rejected':
      return '本机不允许锁定方向，已切换为强制横屏显示。';
    default:
      return '';
  }
}

/* ===========================================================================
   「自动横屏」统一入口
   =========================================================================== */

/**
 * 点击「自动横屏」后唯一起点：
 *   能锁方向（HTTPS / localhost）→ 全屏 + 锁定横屏；
 *   锁不住（iOS / 局域网 HTTP）→ 仍然进全屏（隐藏浏览器 UI）**并叠加 CSS 强制横屏**，
 *   至少保证牌桌是横的 —— 而不是用户抱怨的「只全屏、还是竖屏」。
 */
async function activateLandscape(): Promise<void> {
  const cap = platformCapability();
  if (!cap.fullscreen && !cap.lock) {
    setForceLandscape(true);
    return;
  }
  const r = await enterLandscapeFullscreen();
  if (r.locked) return;
  // 锁不住方向：叠加 CSS 强制横屏兜底，牌桌保证是横的
  setForceLandscape(true);
  notify?.(r.fullscreen ? '已切换为强制横屏显示' : failureText(r.reason));
  sync();
}

/** 退出横屏：先退 CSS 强制横屏，再退全屏（顺序与进入时相反） */
async function deactivateLandscape(): Promise<void> {
  setForceLandscape(false);
  if (fullscreenActive()) await exitLandscapeFullscreen();
  sync();
}

/* ===========================================================================
   强制横屏（CSS 逻辑旋转）
   =========================================================================== */

let forceLandscape = false;

export function isForceLandscape(): boolean {
  return forceLandscape;
}

export function setForceLandscape(on: boolean): void {
  forceLandscape = on;
  html.classList.toggle('force-landscape', on);
  try {
    localStorage.setItem(LS_FORCE, on ? '1' : '0');
  } catch {
    /* 隐私模式等场景写入失败：不影响本次会话 */
  }
  sync();
}

/* ===========================================================================
   视口同步：写 CSS 变量 + 门控类
   =========================================================================== */

/** 「横屏语义宽度」超过这个值就认为屏幕够宽，可把聊天放进侧边留白 */
const WIDE_MIN = 820;
/** 「横屏语义宽度」低于这个值手牌收一档（保证 14 张一屏放下） */
const NARROW_MAX = 720;
/** 短边不超过这个值才认为是手机级屏幕（避免把平板/桌面小窗套进移动布局） */
const PHONE_MAX_SHORT = 620;

function sync(): void {
  const { w, h } = visualViewportSize();
  const touch = isTouchDevice();
  const portrait = h >= w;

  html.classList.toggle('touch', touch);
  html.classList.toggle('force-landscape', forceLandscape);

  // 呈现横屏：物理横屏，或用户开了强制横屏
  const presentLandscape = !portrait || forceLandscape;
  const phoneSized = Math.min(w, h) <= PHONE_MAX_SHORT;
  html.classList.toggle('mobile-layout', touch && phoneSized && presentLandscape);

  // 横屏语义下的宽高：物理竖屏 + 强制横屏时，横屏宽 = 物理高
  const landW = portrait ? h : w;
  const landH = portrait ? w : h;
  html.classList.toggle('land-narrow', landW <= NARROW_MAX);
  html.classList.toggle('land-wide', landW >= WIDE_MIN);

  const s = html.style;
  s.setProperty('--vv-w', `${w}px`);
  s.setProperty('--vv-h', `${h}px`);
  s.setProperty('--ld-w', `${landW}px`);
  s.setProperty('--ld-h', `${landH}px`);

  // 软键盘高度补偿：fixed 定位相对「布局视口」，键盘弹出时布局视口不变，
  // 底部元素会被键盘盖住；用 visualViewport 实测差值把底部元素顶到键盘上方。
  // chat-typing（打字临时退出旋转）与 mobile-layout（真实横屏）下都需要。
  const vv = window.visualViewport;
  const kb = Math.max(0, Math.round(window.innerHeight - (vv?.height ?? h) - (vv?.offsetTop ?? 0)));
  s.setProperty('--kb-bottom', `${kb}px`);

  syncRotateHint();
  syncOrientButton();
  fitCanvas();
}

let rafPending = false;
function scheduleSync(): void {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    sync();
  });
}

/* ===========================================================================
   画布尺寸自适应
   =========================================================================== */

/**
 * 按容器可用空间反算画布宽度（高度由 aspect-ratio 推出）。
 *
 * 取 `min(容器宽, 容器高 × 2)`：两个约束都落在**宽度**这一个维度上，于是
 * `max-width` / `max-height` 永远不会介入裁剪，画布盒 = 内容盒，
 * `table.ts` 基于 `getBoundingClientRect()` 的点击换算保持正确。
 * 与 `style.css` 的 `#table` 写法同一约定（§5.7：画布尺寸一律由宽度反算高度）。
 * 手牌条与控件是 `.canvas-wrap` 的兄弟节点，它们占的高度已被容器实测值自然扣除。
 */
export function fitCanvas(): void {
  const wrap = document.querySelector<HTMLElement>('.canvas-wrap');
  const canvas = document.querySelector<HTMLCanvasElement>('#table');
  if (!wrap || !canvas) return;

  // 只在移动布局下接管尺寸，其余情况把控制权交回 CSS（桌面观感不变）
  if (!html.classList.contains('mobile-layout')) {
    canvas.style.width = '';
    canvas.style.height = '';
    return;
  }
  const availH = wrap.clientHeight;
  const availW = wrap.clientWidth;
  if (availH <= 0 || availW <= 0) return;
  canvas.style.width = `${Math.max(240, Math.floor(Math.min(availW, availH * 2)))}px`;
  canvas.style.height = '';
}

/* ===========================================================================
   手牌操作条
   =========================================================================== */

export interface HandTrayState {
  /** 手牌（已剔除刚摸到的那张，它单独排在末尾） */
  hand: number[];
  /** 刚摸到的牌 */
  drawn: number | null;
  /** 是否轮到自己且可出牌（其余情况按钮置灰，仅作展示） */
  active: boolean;
  /** 正精 / 副精，用于与画布一致的描边标记 */
  pi: number | null;
  fu: number | null;
  /** 自己已展示（冻结）的三张：置灰不可点（§8.5 报杠） */
  frozen?: number[];
  /** 被他人强制的牌面：只能打这些 */
  must?: number[];
}

let discardHandler: (tile: number) => void = () => {};
/** 出牌回调（与画布 `table.onDiscard` 同一条出口） */
export function setTrayDiscardHandler(fn: (tile: number) => void): void {
  discardHandler = fn;
}

let trayHost: HTMLElement | null = null;
let trayRow: HTMLElement | null = null;
let trayBound = false;

function resolveTray(): boolean {
  if (!trayHost) trayHost = document.getElementById('hand-tray');
  if (!trayRow) trayRow = document.getElementById('hand-tray-row');
  if (!trayHost || !trayRow) return false;
  if (!trayBound) {
    // 事件委托：操作条每次重绘都会重建子节点，监听挂在容器上才不会丢
    trayRow.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.tile-btn');
      if (!btn || btn.disabled) return;
      const t = Number(btn.dataset.tile);
      if (Number.isFinite(t)) discardHandler(t);
    });
    trayBound = true;
  }
  return true;
}

function makeTileBtn(t: number, kind: 'normal' | 'drawn', state: HandTrayState): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `tile-btn ${kind}`;
  b.dataset.tile = String(t);
  const frozen = (state.frozen ?? []).includes(t);
  b.disabled = !state.active || frozen;
  if (frozen) b.classList.add('frozen');
  else if ((state.must ?? []).includes(t)) b.classList.add('must');
  b.setAttribute('aria-label', `${tileName(t)}${state.active ? '，点击打出' : ''}`);
  if (t === state.pi) b.classList.add('pi');
  else if (t === state.fu) b.classList.add('fu');
  // 复用画布同一套牌面贴图；未加载完成时回退文字牌面（画布重绘时会再调用本函数）
  const art = tileArt(t);
  if (art) b.style.backgroundImage = `url("${art.src}")`;
  else {
    b.classList.add('plain');
    b.textContent = tileName(t);
  }
  return b;
}

/** 渲染手牌操作条；传 null 表示隐藏（非触摸设备 / 摊牌 / 仪式进行中 / 有吃碰杠待选） */
export function renderHandTray(state: HandTrayState | null): void {
  if (!resolveTray()) return;
  const host = trayHost!;
  const row = trayRow!;

  if (!state) {
    host.classList.add('hidden');
    return;
  }
  host.classList.remove('hidden');
  // active = 轮到自己可出牌：整条描金边，一眼看出「该我了」
  host.classList.toggle('active', state.active);

  row.textContent = '';
  for (const t of state.hand) row.append(makeTileBtn(t, 'normal', state));
  if (state.drawn !== null) {
    const gap = document.createElement('span');
    gap.className = 'tray-gap';
    row.append(gap, makeTileBtn(state.drawn, 'drawn', state));
  }
  row.scrollLeft = 0;
  // 手牌条出现/消失会改变画布可用高度，重新量一次
  fitCanvas();
}

/* ===========================================================================
   旋转引导遮罩 / 方向按钮
   =========================================================================== */

let hintEl: HTMLElement | null = null;
let orientBtn: HTMLButtonElement | null = null;

function syncRotateHint(): void {
  if (!hintEl) hintEl = document.getElementById('rotate-hint');
  if (!hintEl) return;
  // 竖屏且未开强制横屏时才盖提示；桌面端永不出现
  hintEl.classList.toggle('hidden', !(isTouchDevice() && isPortrait() && !forceLandscape));
}

/** 方向按钮文案随状态变化：进全屏 / 退全屏 / 强制横屏；强制横屏时整钮让位给右上角的「退出」图标钮 */
function syncOrientButton(): void {
  if (!orientBtn) orientBtn = document.getElementById('rotate-btn') as HTMLButtonElement | null;
  if (!orientBtn) return;
  const cap = platformCapability();
  // 强制横屏下右上角常驻 44×44 的「退出」图标钮（#force-exit）已覆盖同一功能，
  // HUD 里再摆一个同名按钮纯属重复占位 → 让位（那里腾出的空间见 agent.md §5.6）
  if (!cap.touch || forceLandscape) {
    orientBtn.classList.add('hidden');
    return;
  }
  orientBtn.classList.remove('hidden');
  if (fullscreenActive()) orientBtn.textContent = '退出全屏';
  else if (!cap.lock) orientBtn.textContent = '强制横屏';
  else orientBtn.textContent = '全屏横屏';
}

async function onOrientButton(): Promise<void> {
  if (forceLandscape) {
    // 该状态下这枚按钮已隐藏（功能交给右上角的 #force-exit），这里只是防御
    await deactivateLandscape();
    return;
  }
  if (fullscreenActive()) {
    await exitLandscapeFullscreen();
    sync();
    return;
  }
  await activateLandscape();
}

/* ===========================================================================
   初始化
   =========================================================================== */

/**
 * 初始化移动端行为。
 * `onLayout` 在屏幕尺寸/方向变化后回调（供页面重算布局）；
 * `notify` 用于轻提示（如「已切换为强制横屏显示」）。
 */
export function initMobile(onLayout?: () => void, notifyFn?: (text: string) => void): void {
  notify = notifyFn;
  const touch = isTouchDevice();

  // 恢复上次的强制横屏选择
  try {
    forceLandscape = localStorage.getItem(LS_FORCE) === '1';
  } catch {
    forceLandscape = false;
  }
  html.classList.toggle('force-landscape', forceLandscape);

  // 视口变化：地址栏收放、软键盘、旋转 —— visualViewport 才是最灵敏的来源
  window.visualViewport?.addEventListener('resize', scheduleSync);
  window.addEventListener('resize', scheduleSync, { passive: true });
  window.addEventListener('orientationchange', () => window.setTimeout(sync, 80));
  const so = screen.orientation as unknown as { addEventListener?: (t: string, cb: () => void) => void } | undefined;
  so?.addEventListener?.('change', () => window.setTimeout(sync, 80));
  // 全屏被系统/手势退出（Esc、返回键、下滑）时，务必同步解锁方向，否则会"卡"在横屏
  document.addEventListener('fullscreenchange', () => {
    if (!fullscreenActive()) unlockOrientation();
    sync();
  });
  document.addEventListener('webkitfullscreenchange', () => scheduleSync());

  if (touch) {
    // 遮挡层：主按钮走「全屏 + 锁横屏，锁不住则强制横屏」，次按钮无权限要求地强制横屏
    document.getElementById('rotate-go')?.addEventListener('click', () => void activateLandscape());
    document.getElementById('rotate-force')?.addEventListener('click', () => setForceLandscape(true));
    // 强制横屏状态下的常驻「退出横屏」图标钮（44×44，右上角）：
    // 该状态下大厅 / 对局面板的入口可能不可见，必须随时能点回来
    document.getElementById('force-exit')?.addEventListener('click', () => void deactivateLandscape());

    const rb = document.getElementById('rotate-btn');
    if (rb) rb.addEventListener('click', () => void onOrientButton());
  }

  // 容器尺寸变化（手牌条出现、面板切换）也要重算画布
  const wrap = document.querySelector('.canvas-wrap');
  if (wrap && typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => fitCanvas()).observe(wrap);
  }

  sync();
  window.addEventListener('load', sync, { once: true });
  onLayout?.();
}
