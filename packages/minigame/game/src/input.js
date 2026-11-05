/**
 * 输入路由：触摸 → 当前场景；键盘 → 焦点输入框。
 *
 * 小程序端触摸是组件级事件（bindtap / catchtouchmove 各自挂），键盘是 `<input>` 组件；
 * 小游戏端只有四条全局触摸回调 + wx.showKeyboard 一套键盘 API，必须在入口收敛成
 * 「场景级触摸分发 + 单焦点输入框」两个原语，由场景自己再分发给内部控件。
 *
 * 触摸约定（与小程序端语义对齐）：
 *   · tap（按下并在原地抬起）才触发「点按类」交互 —— 对位 bindtap；
 *   · move 连续回报给场景（面板滚动 / 拖拽用）；
 *   · 场景在收到 tap 前会先收到 down/up，可自行实现按压态（对位 hover-class）。
 */

const layout = require('./layout.js');

/** 当前场景（由 nav.js 注入；setScene 时挂上） */
let scene = null;

/** 触摸手势状态：识别 tap（位移 < 阈值且时长 < 500ms） */
const TAP_SLOP = 10;
const TAP_MS = 600;
let down = null; // { x, y, t, moved }

function pt(e, preferChanged) {
  // 抬起/取消必须取 changedTouches（2026-11-04 审计 F4）：微信 touchend 里 touches 是
  // **仍在屏上的手指** —— 双指时 A 指点牌、B 指搭屏，A 抬起会取到 B 的坐标，
  // 在 B 的位置触发幻影 tap（可能误出牌/误开表情）。down/move 维持 touches[0]。
  if (preferChanged) {
    const c0 = e && e.changedTouches && e.changedTouches[0];
    if (c0) return { x: c0.clientX, y: c0.clientY };
  }
  const t = e && e.touches && e.touches[0];
  if (t) return { x: t.clientX, y: t.clientY };
  // 兜底：touches 为空（单指 touchend 的正常形态）取 changedTouches
  const c = e && e.changedTouches && e.changedTouches[0];
  return c ? { x: c.clientX, y: c.clientY } : null;
}

/** 模态拦截器（2026-11-04）：隐私弹窗等全屏层在屏时，触摸不再进场景。
 *  形如 { down(x,y), up(x,y) }；down 返回 true 表示该层在屏（此次按下已消费，
 *  本轮 tap 识别同步作废）。up 总会被调用以便层内结算「按压→抬起」的完整手势。 */
let interceptor = null;

function setInterceptor(i) {
  interceptor = i || null;
}

function dispatch(phase, e) {
  if (!scene) return;
  const p = pt(e, phase === 'up' || phase === 'cancel');
  if (!p) return;
  // 拦截层（隐私弹窗等）：只在**该层在屏**时接管（down 返回 true = 吃掉本次按下）。
  // 弹窗关着时拦截器仍挂着，但 down 返回 false → 必须落回常规场景分发。
  // 曾在这里无条件 return（只要装了拦截器），导致全界面点不动 —— 2026-11-04 修复。
  if (phase === 'down' && interceptor && interceptor.down(p.x, p.y)) {
    down = null; // 弹窗吃掉按下：本轮 tap 作废（up 时经 below 走 up 分支结算层内点击）
    return;
  }
  if (phase === 'up' && interceptor && interceptor.shown && interceptor.shown()) {
    interceptor.up(p.x, p.y); // 按下被弹窗吃掉后抬起：交层结算，不进场景
    down = null;
    return;
  }
  const fn = phase === 'down' ? 'onTouchDown' : phase === 'move' ? 'onTouchMove' : phase === 'up' ? 'onTouchUp' : 'onTouchCancel';
  if (typeof scene[fn] === 'function') scene[fn](p.x, p.y);
  if (phase === 'down') {
    down = { x: p.x, y: p.y, t: Date.now(), moved: false };
  } else if (phase === 'move' && down) {
    if (Math.abs(p.x - down.x) > TAP_SLOP || Math.abs(p.y - down.y) > TAP_SLOP) down.moved = true;
  } else if (phase === 'up' && down) {
    const isTap = !down.moved && Date.now() - down.t < TAP_MS;
    down = null;
    if (isTap && typeof scene.onTap === 'function') scene.onTap(p.x, p.y);
  } else if (phase === 'cancel') {
    down = null;
  }
}

function install() {
  wx.onTouchStart((e) => dispatch('down', e));
  wx.onTouchMove((e) => dispatch('move', e));
  wx.onTouchEnd((e) => dispatch('up', e));
  wx.onTouchCancel((e) => dispatch('cancel', e));
}

/* ---------------- 键盘（wx.showKeyboard 单焦点管理） ---------------- */

let field = null; // 当前焦点输入框 { value, maxLength, onInput, onConfirm, onBlur, confirmType }
let kbHeight = 0; // 键盘当前高度（wx.onKeyboardHeightChange 回写；0 = 收起 / 不支持）

/**
 * 让某个输入框持有键盘焦点（对位 `<input focus>`）。
 * field 约定：{ value, maxLength, confirmType, onInput(v), onConfirm(v), onBlur() }。
 */
function focus(f) {
  blur();
  field = f;
  try {
    wx.showKeyboard({
      defaultValue: String(f.value || ''),
      maxLength: f.maxLength || 140,
      multiple: false,
      confirmHold: false,
      confirmType: f.confirmType || 'done',
    });
  } catch (e) {
    // 某些环境（DevTools 早期版本）showKeyboard 抛错：保底不崩，字段仍可用 onInput 模拟
    console.warn('[input] showKeyboard 失败：', e && e.message);
  }
}

/** 收起键盘并清焦点（幂等）。done=true 表示这次收起由「确认」触发，不再回调 onConfirm。 */
function blur(done) {
  const f = field;
  if (!f) return;
  field = null;
  try {
    if (wx.hideKeyboard) wx.hideKeyboard({});
  } catch (e) {
    /* 忽略 */
  }
  if (typeof f.onBlur === 'function' && !done) f.onBlur();
}

function installKeyboard() {
  // value 是**当前完整输入串**（非增量）：直接回写字段值即可，等价 bindinput 的 e.detail.value
  wx.onKeyboardInput((res) => {
    const f = field;
    if (!f) return;
    let v = String(res && res.value ? res.value : '');
    const max = f.maxLength || 0;
    // maxLength 小游戏键盘自身不裁剪：控件侧兜底（与 <input maxlength> 同语义）
    if (max > 0 && v.length > max) v = v.slice(0, max);
    f.value = v;
    if (typeof f.onInput === 'function') f.onInput(v);
  });
  wx.onKeyboardConfirm((res) => {
    const f = field;
    if (!f) return;
    if (typeof f.onConfirm === 'function') f.onConfirm(String(res && res.value ? res.value : f.value || ''));
    blur(true); // 确认即收起（confirm-type=send/done 的组件语义），onComplete 不会再走 onBlur
  });
  wx.onKeyboardComplete(() => {
    const f = field;
    field = null;
    if (f && typeof f.onBlur === 'function') f.onBlur();
  });
  // 键盘高度（对位 <input adjust-position>：场景据此把聚焦的输入行抬到键盘上沿）。
  // 特性检测：拿不到此 API 的环境 kbH 恒 0 → 不抬升（输入框位置本就在中上时无感）。
  // 主循环每帧重渲染，场景直接每帧读 kbH() 即可，无需订阅回调。
  try {
    if (typeof wx.onKeyboardHeightChange === 'function') {
      wx.onKeyboardHeightChange((res) => {
        kbHeight = Math.max(0, (res && res.height) || 0);
      });
    }
  } catch (e) {
    /* 老基础库忽略：退化为不抬升 */
  }
}

/** 当前键盘高度（px）；0 = 未弹出 / 环境不支持高度回调 */
function kbH() {
  return kbHeight;
}

module.exports = {
  install,
  installKeyboard,
  /** 由 nav.js 在场景切换后调用 */
  setScene(s) {
    scene = s;
    blur(true);
  },
  /** 模态触摸拦截（隐私弹窗用，见 dispatch 注释） */
  setInterceptor,
  focus,
  blur,
  kbH,
  /** 当前是否有键盘焦点（场景切浮层时用来先收键盘） */
  focused() {
    return field;
  },
};
