/**
 * 隐私授权（小游戏「自定义隐私弹窗」方案）—— 2026-11-04 新增。
 *
 * 为什么需要：wx.joinVoIPChat 属于隐私 API，用户未同意《用户隐私保护指引》时
 * fail errMsg = `joinVoIPChat:fail please go to mp open official popup or use
 * wx.onNeedPrivacyAuthorization...`。官方弹窗组件（mp 后台「隐私授权弹窗」）与
 * 自定义弹窗二选一；我们走自定义（文章 Q1/Q2）：
 *   · 必须注册 wx.onNeedPrivacyAuthorization（Q2：有自己的弹窗也要注册上报）；
 *   · 注册时机必须在任何隐私 API 之前（Q3 注意）→ 由 main.js 启动段最先调用 install()；
 *   · 三个事件按文档上报：弹窗曝光 exposureAuthorization / 用户同意 agree /
 *     用户拒绝 disagree，resolve 都要求用户有过点击行为 —— 同意/拒绝按钮天然满足；
 *   · 弹窗内《隐私保护指引》必须经 wx.openPrivacyContract 打开（文档强约束）。
 *
 * 用法（对局/大厅语音钮等「处理用户信息前」的时机）：
 *   privacy.ensure((granted) => { granted ? 加入语音 : toast 提示 });
 *   —— 已同意过则同步回调 true；未决则拉起本模块自绘弹窗，点击后异步回调。
 *   多个等待方：同一弹窗期结束时按登记顺序全部回调。
 *
 * 弹窗绘制/触摸：模块自管（main.js 在场景层之上调 render()/hit()，全屏拦截），
 * 复用 ui/draw.js 与 ui/btn.js —— 与游戏其余部分同一套视觉语言。
 */

const draw = require('../src/ui/draw.js');
const btn = require('../src/ui/btn.js');
const { C } = draw;

/** 已同意过？（wx.getPrivacySetting 的 needAuthorization=false 也算） */
let agreed = false;
/** 授权结果是否已探测（getPrivacySetting 只探一次；onNeed 回调到达时强制刷新） */
let probed = false;
/** 当前弹窗态：null = 关闭；{ resolve, buttons, lines, linkRect } = 在屏 */
let open = null;
/** 弹窗期间登记的等待方 ensure(cb) 回调列表（同一弹窗期共享结果） */
let waiters = [];
/** 弹窗命中区（render 时产出，hit 消费） */
let hit = null;
/** 注册成功标志（install 幂等） */
let installed = false;

function settingAvailable() {
  return typeof wx !== 'undefined' && typeof wx.getPrivacySetting === 'function';
}

/** 主动探测当前授权态：needAuthorization=false → 已同意/无需弹窗 */
function probe(cb) {
  if (!settingAvailable()) {
    // 老基础库没有隐私接口：视为不受限（这类环境也不会拦 VoIP）
    agreed = true;
    probed = true;
    cb(true);
    return;
  }
  wx.getPrivacySetting({
    success: (r) => {
      // needAuthorization=false：已同意或指引未配置任何需授权项 → 直接放行
      agreed = !!(r && r.needAuthorization === false);
      probed = true;
      cb(agreed);
    },
    fail: () => {
      // 探测失败（基础库差异）：不落死结论，让 ensure 走 requirePrivacyAuthorize 询问
      probed = true;
      cb(false);
    },
  });
}

/**
 * 启动时调用（幂等）：注册 wx.onNeedPrivacyAuthorization。
 * 基础库在任何隐私 API 被调且未授权时会回调这里 —— 我们拉起自绘弹窗；
 * 用户点击同意/拒绝后 resolve 上报（文档 2.2.1）。
 */
function install() {
  if (installed) return;
  installed = true;
  if (typeof wx === 'undefined' || typeof wx.onNeedPrivacyAuthorization !== 'function') return;
  wx.onNeedPrivacyAuthorization((resolve) => {
    // 弹窗曝光即上报「已曝光」（文档：页面展示给用户时调用）
    show((event) => resolve({ event }));
  });
}

/** 文档要求弹窗内经 wx.openPrivacyContract 打开《隐私保护指引》 */
function openContract() {
  try {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({ success: () => {}, fail: () => {} });
    }
  } catch (e) {
    /* 老基础库忽略 */
  }
}

function finish(event) {
  const rs = open;
  open = null;
  hit = null;
  const granted = event === 'agree';
  if (granted) agreed = true;
  const list = waiters;
  waiters = [];
  if (rs && rs.onEvent) {
    try {
      rs.onEvent(event); // agree / disagree 经 install 的包装 resolve 上报平台
    } catch (e) {
      console.warn('[privacy] resolve 失败：', e && e.message);
    }
  }
  for (const w of list) {
    try {
      w(granted);
    } catch (e) {
      /* 等待方回调异常不影响其余 */
    }
  }
}

/** 拉起自绘弹窗（onNeed 回调或 ensure 探测未授权时）。onEvent(event) 上报用 */
function show(onEvent) {
  if (open) return; // 已在屏：复用同一弹窗期
  // 文案折行按 320px 预排（render 阶段再用真实宽度重排一次，这里只为算卡高）
  const text =
    '为提供房间实时语音功能，我们会在你开启语音后使用麦克风采集声音，仅用于本房间内的实时通话，不用于其他目的。详情请阅读《用户隐私保护指引》。';
  open = {
    onEvent: onEvent || null,
    text,
    lines: null, // render 时按实际宽度 wrapText
    linkRect: null,
    buttons: null,
    resolve: null,
    pressed: '',
  };
  // 曝光即上报（文档：页面展示给用户时 resolve({event:'exposureAuthorization'})）。
  // 注意 onNeed 场景 onEvent 包着框架 resolve；ensure 主动拉起场景 onEvent=null，
  // 无平台上报对象，只弹窗收点击。
  if (open.onEvent) {
    try {
      open.onEvent('exposureAuthorization');
    } catch (e) {
      console.warn('[privacy] 曝光上报失败：', e && e.message);
    }
  }
}

/**
 * 处理用户信息前调用：granted → 继续；否则等待本次弹窗结果。
 * @param {(granted: boolean) => void} cb
 */
function ensure(cb) {
  install();
  if (agreed) {
    cb(true);
    return;
  }
  waiters.push(cb);
  if (open) return; // 弹窗已在屏：等待中
  if (!probed) {
    probe((ok) => {
      if (ok) {
        agreed = true;
        const list = waiters;
        waiters = [];
        for (const w of list) w(true);
      } else if (!open) {
        show(null); // 主动拉起（无 onNeed resolve 可报：纯本地记录）
      }
    });
    return;
  }
  show(null); // 已探测过且未同意：直接拉起
}

/**
 * 通用隐私授权（2026-11-04 扩展）：除语音外，剪贴板等 API 同样受隐私指引约束
 * （`setClipboardData:fail api scope is not declared in the privacy agreement`）。
 * 用 requirePrivacyAuthorize 拉起官方/自定义弹窗（同意过则直接 success 不弹），
 * 供任意「隐私 API 被拒」的现场重试。
 * @param {(granted: boolean) => void} cb
 */
function authorize(cb) {
  install();
  if (agreed) {
    cb(true);
    return;
  }
  if (typeof wx !== 'undefined' && typeof wx.requirePrivacyAuthorize === 'function') {
    wx.requirePrivacyAuthorize({
      success: () => {
        agreed = true;
        cb(true);
      },
      fail: () => cb(false),
    });
    return;
  }
  // 老基础库没有该 API：走 ensure 的自绘弹窗路径
  ensure(cb);
}

/* ---------------- 自绘渲染与触摸（main.js 顶层调用） ---------------- */

/** 弹窗在屏则全屏绘制（场景之上、toast 之下）。返回是否在屏（便于调用方短路触摸） */
function render(ctx, L) {
  if (!open) return false;
  const cardW = Math.min(L.sw * 0.86, 440);
  const pad = 18;
  const textW = cardW - pad * 2;
  const lines = draw.wrapText(ctx, open.text, 12, textW);
  open.lines = lines;
  const textH = lines.length * 18;
  const cardH = 52 + textH + 46 + 16 + 12;
  const cx = (L.sw - cardW) / 2;
  const cy = (L.sh - cardH) / 2;

  ctx.fillStyle = C.layerBg;
  ctx.fillRect(0, 0, L.sw, L.sh);
  ctx.fillStyle = C.layerCard;
  draw.roundRect(ctx, cx, cy, cardW, cardH, 8);
  ctx.fill();
  ctx.strokeStyle = C.layerBorder;
  ctx.stroke();

  let y = cy + 24;
  draw.text(ctx, '用户隐私保护提示', cx + pad, y, { size: 14, color: C.goldSoft, bold: true });
  y += 28;
  for (const line of lines) {
    draw.text(ctx, line, cx + pad, y, { size: 12, color: C.text });
    y += 18;
  }
  // 《用户隐私保护指引》独立可点行（金色）：openPrivacyContract 是文档强约束
  const linkText = '《用户隐私保护指引》';
  const lw = draw.measure(ctx, linkText, 12, true);
  open.linkRect = { x: cx + pad, y: y + 2, w: lw + 8, h: 20 };
  draw.text(ctx, linkText, cx + pad, y + 12, { size: 12, color: C.gold, bold: true });

  // 按钮行：右对齐（拒绝 ghost | 同意 primary），与 layer() 同款
  const by = cy + cardH - 14 - 30;
  const bw1 = draw.measure(ctx, '拒绝', 12) + 24;
  const bw2 = draw.measure(ctx, '同意', 12) + 24;
  const bx2 = cx + cardW - 16 - bw2;
  const bx1 = bx2 - 6 - bw1;
  open.buttons = {
    agree: { x: bx2, y: by, w: bw2, h: 30 },
    disagree: { x: bx1, y: by, w: bw1, h: 30 },
  };
  btn.render(ctx, open.buttons.disagree, { label: '拒绝', kind: 'ghost', size: 12, pressed: open.pressed === 'disagree' });
  btn.render(ctx, open.buttons.agree, { label: '同意', kind: 'primary', size: 12, pressed: open.pressed === 'agree' });
  return true;
}

/** 触摸按下（命中记按压态；返回 true 表示弹窗消费了这次按下） */
function down(x, y) {
  if (!open) return false; // 不在屏：不拦截
  // 判定以 render 产出的 buttons 为准（不依赖外部 setHit —— 调用方漏同步
  // 也不能把「按下」丢掉，否则 up 结算不到，用户点了同意却像没点一样）
  const b = open.buttons || {};
  if (b.agree && draw.hit(b.agree, x, y)) open.pressed = 'agree';
  else if (b.disagree && draw.hit(b.disagree, x, y)) open.pressed = 'disagree';
  return true; // 弹窗层全屏拦截：按在空白处也不透给场景
}

/** 触摸抬起：命中按钮才结算（tap 语义：down/up 同钮）。返回 true = 已消费 */
function up(x, y) {
  if (!open) return false;
  const pressed = open.pressed;
  open.pressed = '';
  // 以 render 产出的 buttons 存在为准（main.js 每帧 render→setHit 同步；
  // 不用外部 hit 挡结算 —— 万一调用方漏 setHit，点击也不能吞掉用户的选择）
  if (!open.buttons) return true;
  if (pressed === 'agree' && draw.hit(open.buttons.agree, x, y)) {
    finish('agree');
    return true;
  }
  if (pressed === 'disagree' && draw.hit(open.buttons.disagree, x, y)) {
    finish('disagree');
    return true;
  }
  if (open.linkRect && draw.hit(open.linkRect, x, y)) openContract();
  return true; // 弹窗层全屏拦截
}

/** 命中区标记（render 产出后由 main.js 在触摸分发前同步；render 返回 false 时置 null） */
function setHit(v) {
  hit = v ? true : false;
}

/** 弹窗是否在屏（main.js 判断是否拦截触摸/键盘） */
function shown() {
  return !!open;
}

/** 可测性：当前在屏弹窗的按钮/链接命中区（无弹窗返回 null；冒烟与调试用，业务勿依赖） */
function rects() {
  if (!open) return null;
  return { buttons: open.buttons, linkRect: open.linkRect };
}

module.exports = { install, ensure, authorize, render, down, up, setHit, shown, openContract, rects };
