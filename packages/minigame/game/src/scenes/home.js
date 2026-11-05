/**
 * 首页：分步向导（① 创建/加入 → ② 选择玩法（仅创建分支）→ 最后 填写信息）。
 *
 * pages/home/home.js + home.wxml + home.wxss（紧凑档）的画布移植，逻辑逐行对照：
 *   · 步骤条按分支重建，stepSeq() = join ? [mode, form] : [mode, variant, form]；
 *   · 没有「锁定」态：任何入口（含分享链接预填）都能回退到上一步；
 *   · 分享入口：state.launchRoom（main.js 消费启动参数 query.room）→ 自动进房（无昵称随机名字兜底）。
 *
 * 小游戏端差异：
 *   · `<input>` → src/ui 的输入框（wx.showKeyboard 单焦点）：系统键盘支持粘贴，
 *     整段分享文案仍会经 cleanCode 抠出 6 位房间码（bindpaste 语义由 onInput 全量回写覆盖）；
 *   · hover-class 按下态 → this.pressed（onTouchDown 命中即按下）。
 */

const { VARIANT_LIST, DEFAULT_VARIANT } = require('../../lib/shared/rules/index.js');
const nav = require('../nav.js');
const net = require('../../utils/net.js');
const store = require('../../utils/store.js');
const config = require('../../utils/config.js');
const state = require('../state.js');
const draw = require('../ui/draw.js');
const btn = require('../ui/btn.js');
const toast = require('../ui/toast.js');
/** 头像资源（2026-11-04）：清单下发 + 画布预解码，选择器网格/铭牌共用 */
const avatarart = require('../../utils/avatarart.js');
/** 图片预解码宿主（app.canvas.createImage / wx.createImage 适配） */
const preload = require('../preload.js');
/** 声音设置面板（2026-11-04）：画布版，game/lobby/home 共用 */
const sound = require('../../utils/sound.js');
const settingsPanel = require('../ui/settingspanel.js');
const Scene = require('./scene.js');

const BG_OPTIONS = [
  { id: 'felt', label: '绒面' },
  { id: 'lattice', label: '回纹' },
  { id: 'cloud', label: '祥云' },
  { id: 'plain', label: '素色' },
];

/** 页脚常驻说明（错误提示会临时顶替它） */
const HINT_TEXT = '创建房间时可挑选玩法，加入房间时玩法由房间决定；桌位自动分配东/南/西/北，准备阶段可点其他座位换位。';

const { C } = draw;

class HomeScene extends Scene {
  constructor() {
    super();
    this.step = 'mode';
    this.wizardMode = '';
    this.steps = [];
    this.variants = [];
    // 声音设置面板（2026-11-04）：步骤条行右端 ⚙️ 打开；在屏时吞掉全部触摸
    this.settingsShown = false;
    this.setPressed = '';
    this._setDrag = null;
    let selected = store.get(store.KEYS.variant, DEFAULT_VARIANT);
    if (!VARIANT_LIST.some((v) => v.id === selected)) selected = DEFAULT_VARIANT;
    this.selectedVariant = selected;
    this.name = store.get(store.KEYS.name, '');
    this.avatar = store.get(store.KEYS.avatar, '');
    this.avatarScroll = 0;
    this.avatarDrag = null;
    this.code = '';
    this.codeFromLink = false;
    this.errorText = '';
    this.errorShown = false;
    this.submitting = false;
    this.bg = store.get(store.KEYS.bg, 'cloud');
    this.focusField = ''; // 'name' | 'code' | ''
    this.netShown = false;
    this.netText = '';
    this.attempted = false;
    this.formHead = '';
    this.formSubmit = '';
    this.chips = [];
    /** 每帧 render 重建的可点矩形（onTouchDown / onTap 消费） */
    this.ui = {};
    this.pressed = '';
    this._submitTimer = null;
  }

  enter() {
    nav.attach('home', this);
    // 局外背景音乐（2026-11-04）：整首曲子，先下完才播 → 进首页就起，让下载与浏览并行
    sound.outBgmStart();
    this.variants = VARIANT_LIST.map((v) => ({
      id: v.id,
      name: v.name,
      desc: v.desc || v.seats + ' 人局',
      tags: v.tags || [v.seats + ' 人'],
    }));
    // 分享卡片/扫码带入（对位小程序 onLoad(options.room)）：自动进房，零输入。
    // ① 本地记着**别的**房间 → 先退干净（同一连接上 join 会撞「你已经在房间里了」）；
    // ② 本地就是这个房间 → 不重复 join，交给下面 tryResume 凭 token/pid 回桌；
    // ③ 对局进行中 → 不 leave（服务端 removePlayer 会 forceOver 中止整局、把同桌带走）；
    // ④ 没昵称 → ensureName 随机一个并持久化，流程不卡在「请先填写昵称」。
    // 失败（房间不存在 / 已满 / 已开局）由 onError 落回本表单提示原因，可改可重试。
    const launch = String(state.launchRoom || '').toUpperCase().slice(0, 6);
    let autoJoin = false;
    if (launch) {
      state.launchRoom = '';
      state.resumeFail = null; // 旧房间的回桌失败提示与本次邀请无关
      const storedRoom = String(store.get(store.KEYS.room, '') || '');
      const gv = state.lastGameView;
      const sameRoom = storedRoom === launch;
      const inGame = !!(storedRoom && gv && gv.phase === 'playing');
      if (!sameRoom && storedRoom && !inGame) nav.leaveRoom();
      this.code = launch;
      this.codeFromLink = true;
      this.wizardMode = 'join';
      this.name = store.ensureName();
      this.goStep('form'); // code/name 都已就绪 → 不弹键盘
      if (!sameRoom && !inGame) {
        this.onSubmit();
        autoJoin = true;
      }
    } else {
      this.goStep('mode');
    }
    // 回桌失败（token 过期 / 座位已回收 / 房间已解散）：统一走 handleResumeFail
    if (state.resumeFail) {
      const fail = state.resumeFail;
      state.resumeFail = null;
      this.handleResumeFail(fail);
      return;
    }
    // 启动即尝试凭本地 token 回桌（等价 web 端刷新自动重连）；已发起自动进房则不重复发
    if (!autoJoin) nav.tryResume();
    this.syncNet();
  }

  exit() {
    this.clearSubmitTimer();
    inputBlur();
    sound.outBgmStop(); // 离开局外：停掉局外 BGM（进对局页时由 game.enter 起局内 BGM）
    nav.detach(this);
  }

  /* ---------------- 网络状态横幅 ---------------- */

  onNetStatus(s) {
    const text = net.describe(s);
    this.netText = text;
    this.netShown = !!text;
    // 用户已经点过「创建/加入」却握手失败 → 真实原因直接写在表单错误位
    if (this.attempted && s && (s.state === 'failed' || s.state === 'no-url')) {
      this.showError(text);
      this.attempted = false;
    }
  }

  syncNet() {
    this.onNetStatus({
      state: net.getState(),
      inRoom: false,
      everConnected: net.hasConnected(),
      error: net.getLastError(),
      url: net.getUrl(),
    });
  }

  /* ---------------- 向导 ---------------- */

  stepSeq() {
    return this.wizardMode === 'join' ? ['mode', 'form'] : ['mode', 'variant', 'form'];
  }

  stepLabel(id) {
    if (id === 'mode') return '创建 / 加入';
    if (id === 'variant') return '选择玩法';
    if (this.wizardMode === 'join') return '加入房间';
    if (this.wizardMode === 'create') return '创建房间';
    return '填写信息';
  }

  renderSteps() {
    const seq = this.stepSeq();
    const cur = seq.indexOf(this.step);
    this.steps = seq.map((id, i) => ({
      id,
      no: String(i + 1),
      label: this.stepLabel(id),
      state: id === this.step ? 'current' : i < cur ? 'done' : 'todo',
    }));
  }

  goStep(id) {
    this.step = id;
    this.errorShown = false;
    this.setFocus('');
    this.renderSteps();
    if (id === 'form') {
      this.renderWizardForm();
      // 头像清单/位图预热（2026-11-04）：选择器网格要画 27 张缩略图，提前确保清单并预解码
      avatarart.ensure(() => {});
      avatarart.preload(preload.imageHost(), avatarart.list());
      const focusCode = this.wizardMode === 'join' && !this.code;
      // 自动聚焦只在昵称为空时发生（本地记忆已回填就不抢焦点弹键盘）
      const focusName = !this.name && !focusCode;
      this.setFocus(focusCode ? 'code' : focusName ? 'name' : '');
    }
  }

  renderWizardForm() {
    const isJoin = this.wizardMode === 'join';
    const meta = this.variants.find((v) => v.id === this.selectedVariant);
    const chips = [];
    if (isJoin) chips.push('玩法 由房间决定');
    else chips.push('玩法 ' + (meta ? meta.name : this.selectedVariant));
    chips.push(isJoin ? '加入已有房间' : '成为房主（东家）');
    if (isJoin && this.codeFromLink) chips.push('房间码已预填 · 可修改');
    this.formHead = isJoin ? '加入朋友的房间' : '开一桌新牌局';
    this.formSubmit = isJoin ? '加入房间' : '创建房间';
    this.chips = chips;
  }

  onStepTap(id) {
    const seq = this.stepSeq();
    if (seq.indexOf(id) >= 0 && seq.indexOf(id) < seq.indexOf(this.step)) this.goStep(id);
  }

  onPickMode(mode) {
    this.wizardMode = mode;
    if (mode === 'create') {
      // 改走创建分支 → 不再沿用分享链接预填的房间码
      this.code = '';
      this.codeFromLink = false;
    }
    this.goStep(mode === 'join' ? 'form' : 'variant');
  }

  onPickVariant(id) {
    this.selectedVariant = id;
    store.set(store.KEYS.variant, id);
    this.renderSteps();
  }

  onBack() {
    this.goStep(this.wizardMode === 'join' ? 'mode' : 'variant');
  }

  /* ---------------- 输入 ---------------- */

  setFocus(id) {
    if (id && id === this.focusField) return; // 已聚焦：不重复拉起键盘（避免系统键盘闪一下）
    this.focusField = id;
    if (!id) {
      inputBlur();
      return;
    }
    const f =
      id === 'name'
        ? { value: this.name, maxLength: 8, confirmType: 'done' }
        : { value: this.code, maxLength: 40, confirmType: 'done' };
    f.onInput = (v) => {
      if (id === 'name') this.name = v;
      else this.code = this.cleanCode(v);
    };
    f.onConfirm = () => this.onSubmit();
    f.onBlur = () => {
      if (this.focusField === id) this.focusField = '';
    };
    inputFocus(f);
  }

  /**
   * 从任意输入里取出 6 位房间码（对位 home.js cleanCode）：
   * 粘贴整段分享文案 → 抠出连续 6 位；手动输入 → 清洗非字母数字、大写、最多 6 位。
   */
  cleanCode(raw) {
    raw = String(raw || '').toUpperCase();
    if (raw.length > 6 || /[^0-9A-Z]/.test(raw)) {
      const m = raw.match(/[0-9A-Z]{6}/);
      if (m) return m[0];
    }
    return raw.replace(/[^0-9A-Z]/g, '').slice(0, 6);
  }

  showError(text) {
    this.errorText = text;
    this.errorShown = true;
  }

  onSubmit() {
    if (this.step !== 'form') return;
    const name = String(this.name || '').trim();
    if (!name) {
      this.showError('请先填写昵称');
      return;
    }
    store.set(store.KEYS.name, name);
    if (!config.resolve()) {
      this.showError('未配置服务器域名：请填写 utils/config.js 的 DEFAULT_WSS（wss + 已备案域名）');
      return;
    }
    if (this.wizardMode === 'join') {
      const code = String(this.code || '').trim().toUpperCase();
      if (code.length !== 6) {
        this.showError('房间码为 6 位');
        return;
      }
      this.errorShown = false;
      this.attempted = true;
      this.beginSubmit();
      // pid = 本地稳定玩家 id：服务端先用 (pid, code) 找座位，找到就直接回原座位（掉线重进）
      // avatar 空串 = 未选 → 服务端按 pid 确定性随机分配
      nav.connectAndSend({ t: 'join', code, name, pid: store.ensurePid(), avatar: this.avatar });
      return;
    }
    this.errorShown = false;
    this.attempted = true;
    this.beginSubmit();
    nav.connectAndSend({ t: 'create', name, variant: this.selectedVariant, pid: store.ensurePid(), avatar: this.avatar });
  }

  /** 最多 8s 自动复位，防连点 / 服务端无回包永久转圈（对位 beginSubmit） */
  beginSubmit() {
    this.clearSubmitTimer();
    this.submitting = true;
    this._submitTimer = setTimeout(() => {
      this.submitting = false;
    }, 8000);
  }

  clearSubmitTimer() {
    if (this._submitTimer) {
      clearTimeout(this._submitTimer);
      this._submitTimer = null;
    }
  }

  /* ---------------- 路由回调 ---------------- */

  onError(reason) {
    this.clearSubmitTimer();
    this.submitting = false;
    this.showError(reason);
  }

  onResumeFail(fail) {
    this.handleResumeFail(fail);
  }

  /**
   * 本地缓存的房间已失效：① toast 原因；② 向导重置回 mode 步（旧行为落在加入表单步，
   * 只有一行红字还预填失效码，回不去也走不下去）。房间码保留在 this.code。
   */
  handleResumeFail(fail) {
    const reason = String((fail && fail.reason) || '').trim();
    const room = String((fail && fail.room) || '').toUpperCase().slice(0, 6);
    this.step = 'mode';
    this.wizardMode = '';
    this.codeFromLink = false;
    this.errorShown = false;
    this.errorText = '';
    this.setFocus('');
    if (/^[0-9A-Z]{6}$/.test(room)) this.code = room;
    this.renderSteps();
    this.clearSubmitTimer();
    this.submitting = false;
    toast.push(reason || '房间已失效，请重新加入');
  }

  /* ---------------- 触摸 ---------------- */

  onTouchDown(x, y) {
    const u = this.ui;
    this.pressed = '';
    // 设置面板在最上层：在屏时吞掉一切触摸（含面板内空白）
    if (settingsPanel.down(x, y, this)) return;
    // 头像网格拖拽起点（仅在视口内；move 时按位移滚动，up 后未移动则视为选中）
    const g = this.ui.avatarGrid;
    const inGrid = g && x >= g.x && x <= g.x + g.w && y >= g.y && y <= g.y + g.h;
    if (inGrid) {
      this.avatarDrag = { lastY: y, moved: false };
      return;
    }
    this.avatarDrag = null;
    const zones = [
      ...(u.steps || []),
      ...(u.bgOpts || []),
      u.btnSettings ? { id: 'settings', rect: u.btnSettings } : null,
      u.modeCreate,
      u.modeJoin,
      ...((u.variants || []).map((v) => ({ id: v.id, rect: v.rect }))),
      u.btnBack,
      u.btnNext,
      u.btnSubmit,
      u.fieldName,
      u.fieldCode,
    ].filter(Boolean);
    for (const z of zones) {
      if (draw.hit(z.rect || z, x, y)) {
        this.pressed = z.id || '';
        break;
      }
    }
  }

  /**
   * 拖动：首页本来**没有**可拖控件（没有滚动区），所以这个钩子是本面板引入的
   * —— 设置面板的音量滑条靠它跟手。少了它只在首页表现为「拖不动、只有按下那一下生效」。
   */
  onTouchMove(x, y) {
    if (settingsPanel.move(x, y, this)) return;
    // 头像网格滚动
    if (this.avatarDrag) {
      const dy = y - this.avatarDrag.lastY;
      this.avatarDrag.lastY = y;
      if (Math.abs(dy) > 2) this.avatarDrag.moved = true;
      const g = this.ui.avatarGrid;
      if (g) this.avatarScroll = Math.max(0, Math.min(g.maxScroll, (this.avatarScroll || 0) - dy));
    }
  }

  onTouchUp() {
    if (settingsPanel.up(this)) return; // 抬起即落盘滑条值
    this.pressed = '';
  }
  onTouchCancel() {
    if (settingsPanel.up(this)) return;
    this.pressed = '';
  }

  onTap(x, y) {
    const u = this.ui;
    // 设置面板在屏：只走面板（必须最先判定 —— 它画在所有内容之上）
    if (settingsPanel.tap(x, y, this)) return;
    // 头像网格：先消费拖拽手势（down→up 期间记的）：位移过 = 滚动不选中；未位移 = 选中对应格
    const drag = this.avatarDrag;
    this.avatarDrag = null;
    if (drag) {
      if (!drag.moved) {
        const idx = this.avatarGridHit(x, y);
        if (idx >= 0) {
          const cells = [''].concat(avatarart.list());
          this.avatar = cells[idx];
          store.set(store.KEYS.avatar, this.avatar);
        }
      }
      return;
    }
    // 键盘弹出时点空白 = 先收键盘（原生 input 语义）；点悬浮/内联输入框则保持或切换焦点
    if (this.focusField && inputKbH() > 0) {
      const inside =
        (u.floatField && draw.hit(u.floatField.rect, x, y)) ||
        draw.hit(u.fieldName, x, y) ||
        draw.hit(u.fieldCode, x, y);
      if (!inside) {
        this.setFocus('');
        return;
      }
      if (u.floatField && draw.hit(u.floatField.rect, x, y)) return; // 悬浮输入条：保持焦点
    }
    for (const s of u.steps || []) {
      if (draw.hit(s.rect, x, y)) return this.onStepTap(s.id);
    }
    if (u.btnSettings && draw.hit(u.btnSettings, x, y)) return settingsPanel.open(this);
    if (draw.hit(u.modeCreate, x, y)) return this.onPickMode('create');
    if (draw.hit(u.modeJoin, x, y)) return this.onPickMode('join');
    for (const v of u.variants || []) {
      if (draw.hit(v.rect, x, y)) return this.onPickVariant(v.id);
    }
    if (draw.hit(u.btnBack, x, y)) return this.onBack();
    if (draw.hit(u.btnNext, x, y)) return this.goStep('form');
    if (draw.hit(u.btnSubmit, x, y)) return this.onSubmit();
    if (draw.hit(u.fieldName, x, y)) return this.setFocus('name');
    if (draw.hit(u.fieldCode, x, y)) return this.setFocus('code');
    for (const b of u.bgOpts || []) {
      if (draw.hit(b.rect, x, y)) {
        this.bg = b.id;
        store.set(store.KEYS.bg, b.id);
        return;
      }
    }
  }

  /* ---------------- 渲染（home.wxss 紧凑档逐项对照） ---------------- */

  render(ctx, L) {
    this.ui = {};
    const u = this.ui;
    const padL = L.safe.l + 12;
    const padR = L.safe.r + 12;
    const padT = L.safe.t + 8;
    const padB = 8;
    draw.pageBg(ctx, L, this.bg);

    let y = padT;
    const contentW = L.sw - padL - padR;
    if (this.netShown) {
      // .banner：bg rgba(224,122,106,.16) / color #e07a6a / 11px / 圆角 5
      const bh = 19;
      ctx.fillStyle = 'rgba(224,122,106,0.16)';
      draw.roundRect(ctx, padL, y, contentW, bh, 5);
      ctx.fill();
      draw.text(ctx, this.netText, padL + 10, y + bh / 2, { size: 11, color: C.red, maxW: contentW - 20 });
      y += bh + 6;
    }

    // .home-card 面板
    const cardW = Math.min(1000, contentW);
    const cardX = padL + (contentW - cardW) / 2;
    const cardY = y;
    const cardH = Math.max(120, L.sh - padB - cardY);
    draw.panel(ctx, { x: cardX, y: cardY, w: cardW, h: cardH }, { radius: 8, bg: 'rgba(255,255,255,0.04)', borderColor: C.panelBorder });

    const padI = 14;
    const ix = cardX + padI;
    const iw = cardW - padI * 2;
    let iy = cardY + padI;

    // 步骤条（pill 胶囊，可点回退）
    const steps = [];
    let sx = ix;
    const sy = iy;
    for (const st of this.steps) {
      const labelW = draw.measure(ctx, st.label, 12);
      const w = 10 + 18 + 4 + labelW + 10;
      const r = { x: sx, y: sy, w, h: 24 };
      const color = st.state === 'current' ? C.goldSoft : st.state === 'done' ? C.green : C.muted;
      const border = st.state === 'current' ? C.gold : st.state === 'done' ? 'rgba(67,192,124,0.5)' : 'rgba(255,255,255,0.1)';
      ctx.strokeStyle = border;
      ctx.lineWidth = 1;
      draw.roundRect(ctx, r.x, r.y, r.w, r.h, r.h / 2);
      ctx.stroke();
      // 序号圆点
      ctx.beginPath();
      ctx.arc(r.x + 10 + 9, sy + 12, 8, 0, Math.PI * 2);
      ctx.stroke();
      draw.text(ctx, st.no, r.x + 10 + 9, sy + 12.5, { size: 11, color, align: 'center' });
      draw.text(ctx, st.label, r.x + 10 + 18 + 4, sy + 12, { size: 12, color });
      steps.push({ id: st.id, rect: r });
      sx += w + 8;
    }
    /*
     * 声音设置入口（2026-11-04）：**紧跟在最后一枚步骤胶囊后面**，不贴卡片右缘。
     *
     * 原来写的是 `x = ix + iw - 24`（卡片右上角），实测被微信胶囊（⋯ ●）压住 ——
     * 用户截图里 ⚙️ 只剩半边露在胶囊左侧。为什么不用「量胶囊再避让」当主方案：
     *   · layout.capsuleRect() 走 wx.getMenuButtonBoundingClientRect，小游戏端**没有文档保证**，
     *     拿不到就返回 null（layout.js 自己的注释）；靠它避让在真机上可能直接失效；
     *   · 与其猜测右上角哪儿安全，不如根本不去右上角：步骤条只占 2~3 枚胶囊（约 260~320px），
     *     后面到胶囊带之间恒有大片空白，跟在它后面永远在屏幕左/中部。
     * 底部那一行已被「背景 + 四档按钮」占满（bgX 贴右边框），所以还是放这一行。
     * 24×24 与步骤胶囊同高，用 16px 间隔（sx 已含 8px 游标余量 + 8）与编号胶囊区分开。
     */
    const afterSteps = sx + 8;
    // 二道保险：极窄屏时若步骤条本身就伸到胶囊带，仍把按钮拉到胶囊左侧
    const capLeft = L.cap && L.cap.left > 0 ? L.cap.left : Infinity;
    const btnX = Math.min(afterSteps, capLeft - 8 - 24);
    u.btnSettings = { x: btnX, y: sy, w: 24, h: 24 };
    btn.icon(ctx, u.btnSettings, { label: '⚙️', vec: 'gear', size: 11, pressed: this.pressed === 'settings' }); // ⚙️ 带 VS16 真机不居中 → 矢量齿轮
    u.steps = steps;
    iy += 24 + 12;

    // 页脚（说明 + 背景切换）先定位，主区按剩余高度排：
    // 旧版把双卡拉满面板 + 右侧 200px 栏底部挂背景钮，造成「高瘦空卡 + 大片空白」。
    const footH = 28;
    const footY = cardY + cardH - padI - footH;
    const topY = iy + 26; // 标题占 26px
    const availH = Math.max(96, footY - 12 - topY);

    // 标题（各步共用一行）
    draw.text(
      ctx,
      this.step === 'variant' ? '选择麻将玩法' : this.step === 'form' ? this.formHead : '创建房间，还是加入房间？',
      ix,
      iy + 12,
      { size: 16, color: C.goldSoft, bold: true },
    );

    if (this.step === 'mode') {
      // 双卡：宽度吃满主区，高度取「够大但不拉满」（上限 196），整组垂直居中
      const gap = 12;
      const cw = (iw - gap) / 2;
      const ch = Math.min(196, availH);
      const cy = topY + (availH - ch) / 2;
      u.modeCreate = { id: 'create', x: ix, y: cy, w: cw, h: ch };
      u.modeJoin = { id: 'join', x: ix + cw + gap, y: cy, w: cw, h: ch };
      this.modeCard(ctx, u.modeCreate, '＋', '创建房间', '开一桌新局，把分享卡片发给朋友', this.pressed === 'create');
      this.modeCard(ctx, u.modeJoin, '→', '加入房间', '输入朋友给的 6 位房间码', this.pressed === 'join');
    } else if (this.step === 'variant') {
      const n = Math.max(1, this.variants.length);
      const gap = 10;
      const cw = (iw - gap * (n - 1)) / n;
      const bh = 34;
      const ch = Math.min(104, Math.max(84, availH - bh - 12));
      const blockH = ch + 12 + bh;
      const cy = topY + Math.max(0, (availH - blockH) / 2);
      u.variants = this.variants.map((v, i) => {
        const r = { x: ix + i * (cw + gap), y: cy, w: cw, h: ch };
        const active = v.id === this.selectedVariant;
        ctx.fillStyle = active ? 'rgba(230,193,75,0.12)' : 'rgba(255,255,255,0.03)';
        draw.roundRect(ctx, r.x, r.y, r.w, r.h, 8);
        ctx.fill();
        ctx.strokeStyle = active ? C.gold : C.cardBorder;
        ctx.stroke();
        draw.text(ctx, v.name, r.x + 12, r.y + 18, { size: 14, color: C.goldSoft, bold: true, maxW: r.w - 24 });
        draw.text(ctx, v.desc, r.x + 12, r.y + 40, { size: 12, color: C.muted, maxW: r.w - 24 });
        // tags 胶囊
        let tx = r.x + 12;
        const ty = r.y + 58;
        for (const tag of v.tags || []) {
          const tw = draw.measure(ctx, tag, 10) + 12;
          if (tx + tw > r.x + r.w - 10) break;
          ctx.fillStyle = 'rgba(255,255,255,0.07)';
          draw.roundRect(ctx, tx, ty, tw, 16, 8);
          ctx.fill();
          draw.text(ctx, tag, tx + tw / 2, ty + 8.5, { size: 10, color: C.tag, align: 'center' });
          tx += tw + 4;
        }
        return { id: v.id, rect: r };
      });
      // 按钮行：上一步 / 下一步（右对齐，紧贴卡片下方）
      const by = cy + ch + 12;
      u.btnNext = { x: ix + iw - 88, y: by, w: 88, h: bh };
      u.btnBack = { x: ix + iw - 88 - 8 - 78, y: by, w: 78, h: bh };
      btn.render(ctx, u.btnBack, { label: '上一步', pressed: this.pressed === 'back' });
      btn.render(ctx, u.btnNext, { label: '下一步', kind: 'primary', pressed: this.pressed === 'next' });
    } else if (this.step === 'form') {
      // 摘要 chips
      let cx = ix;
      for (const chip of this.chips) {
        const w = draw.measure(ctx, chip, 11) + 20;
        ctx.fillStyle = 'rgba(230,193,75,0.12)';
        draw.roundRect(ctx, cx, topY, w, 20, 10);
        ctx.fill();
        draw.text(ctx, chip, cx + w / 2, topY + 10.5, { size: 11, color: C.goldSoft, align: 'center' });
        cx += w + 8;
      }
      // 输入区宽度上限 520：超宽屏上整行输入框会显得空旷
      const formW = Math.min(iw, 520);
      const bh = 34;
      const gap = 8;
      // 底部按钮行钉死（与输入区右对齐）
      const yBtn = footY - 12 - bh;
      // 房间码（join 分支）紧贴按钮上方
      let yCodeEnd = yBtn;
      if (this.wizardMode === 'join') {
        u.fieldCode = this.field(ctx, ix, yBtn - gap - 30, formW, '房间码', this.code, '6 位房间码', this.focusField === 'code', true);
        yCodeEnd = yBtn - gap - 30;
      }
      // 昵称
      const yName = topY + 30;
      u.fieldName = this.field(ctx, ix, yName, formW, '昵称', this.name, '1~8 个字', this.focusField === 'name', false);
      const yNameEnd = yName + 30 + gap;
      // 头像网格（可滚动）：占昵称下方到房间码/按钮上方的剩余区域
      this.renderAvatarGrid(ctx, ix, yNameEnd, formW, yCodeEnd - gap - yNameEnd);
      // 键盘抬升（对位 <input adjust-position>）：聚焦框被键盘上沿遮住时，内联框压暗、
      // 同款输入行抬到键盘上方重画（命中目标换到悬浮行）。判定用本帧刚记录的矩形。
      const kb = inputKbH();
      const kbLimit = L.sh - kb - 8;
      const active =
        this.focusField === 'name' ? u.fieldName : this.focusField === 'code' ? u.fieldCode : null;
      if (active && kb > 0 && active.y + active.h > kbLimit) {
        const isName = this.focusField === 'name';
        ctx.fillStyle = 'rgba(20,36,28,0.6)';
        draw.roundRect(ctx, active.x, active.y, active.w, active.h, 5);
        ctx.fill();
        const fy = Math.max(L.safe.t + 44, kbLimit - 30);
        u.floatField = {
          id: this.focusField,
          rect: this.field(
            ctx,
            ix,
            fy,
            formW,
            isName ? '昵称' : '房间码',
            isName ? this.name : this.code,
            isName ? '1~8 个字' : '6 位房间码',
            true,
            !isName,
          ),
        };
      }
      // 按钮行（与输入区右对齐）
      u.btnSubmit = { x: ix + formW - 88, y: yBtn, w: 88, h: bh };
      u.btnBack = { x: ix + formW - 88 - 8 - 78, y: yBtn, w: 78, h: bh };
      btn.render(ctx, u.btnBack, { label: '上一步', pressed: this.pressed === 'back' });
      btn.render(ctx, u.btnSubmit, {
        label: this.formSubmit,
        kind: 'primary',
        disabled: this.submitting,
        pressed: this.pressed === 'submit',
      });
    }

    // —— 页脚：说明（左）/ 错误提示 + 背景切换（右）——
    // 错误占用说明位（红字），不再额外挤占主区高度
    const bgSizes = BG_OPTIONS.map((o) => draw.measure(ctx, o.label, 11) + 16);
    const bgRowW = 26 + bgSizes.reduce((a, b) => a + b, 0) + 5 * (BG_OPTIONS.length - 1);
    const bgX = ix + iw - bgRowW;
    const hintW = bgX - 16 - ix;
    if (hintW > 160) {
      const lines = draw.wrapText(ctx, this.errorShown ? this.errorText : HINT_TEXT, 11, hintW).slice(0, 2);
      const lh = 15;
      const ly = footY + footH / 2 - ((lines.length - 1) * lh) / 2;
      lines.forEach((line, i) =>
        draw.text(ctx, line, ix, ly + i * lh, { size: 11, color: this.errorShown ? C.red : C.muted }),
      );
    }
    // 「背景」标签 + 四档按钮（行宽 193 ≤ iw，末钮不会压到面板右边框）
    draw.text(ctx, '背景', bgX, footY + footH / 2, { size: 11, color: C.muted });
    let bx = bgX + 26;
    u.bgOpts = BG_OPTIONS.map((o, i) => {
      const w = bgSizes[i];
      const r = { x: bx, y: footY + (footH - 28) / 2, w, h: 28 };
      const on = o.id === this.bg;
      ctx.fillStyle = on ? C.gold : 'rgba(255,255,255,0.08)';
      draw.roundRect(ctx, r.x, r.y, r.w, r.h, 5);
      ctx.fill();
      ctx.strokeStyle = on ? C.goldSoft : 'rgba(255,255,255,0.14)';
      ctx.stroke();
      draw.text(ctx, o.label, r.x + r.w / 2, r.y + r.h / 2, { size: 11, color: on ? C.goldDark : C.text, align: 'center' });
      bx += w + 5;
      return { id: o.id, rect: r };
    });

    // 设置面板最后画（在一切内容之上），与 onTap 里「面板最先判定」对称
    settingsPanel.render(ctx, L, this);
  }

  modeCard(ctx, r, icon, title, desc, pressed) {
    ctx.save();
    if (pressed) {
      ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
      ctx.scale(0.97, 0.97);
      ctx.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
    }
    ctx.fillStyle = pressed ? 'rgba(230,193,75,0.16)' : 'rgba(255,255,255,0.03)';
    draw.roundRect(ctx, r.x, r.y, r.w, r.h, 8);
    ctx.fill();
    ctx.strokeStyle = pressed ? 'rgba(230,193,75,0.5)' : C.cardBorder;
    ctx.stroke();
    // 内容块 = 圆形图标徽章(44) + 标题(22) + 说明(按卡宽换行)，整块垂直居中。
    // 旧版 20px 图标 + 单行 11px 说明放在近 300px 高的卡里，内容占比过小、显得空。
    const padX = 18;
    const maxW = r.w - padX * 2;
    const badge = 44;
    const lines = draw.wrapText(ctx, desc, 12, maxW);
    const lh = 17;
    const blockH = badge + 12 + 22 + 8 + lines.length * lh;
    const top = r.y + Math.max(16, (r.h - blockH) / 2);
    const bcx = r.x + padX + badge / 2;
    ctx.beginPath();
    ctx.arc(bcx, top + badge / 2, badge / 2, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(230,193,75,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(230,193,75,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    draw.text(ctx, icon, bcx, top + badge / 2 + 1, { size: 22, color: C.gold, align: 'center' });
    draw.text(ctx, title, r.x + padX, top + badge + 12 + 11, { size: 17, color: C.text, bold: true });
    lines.forEach((line, i) => {
      draw.text(ctx, line, r.x + padX, top + badge + 12 + 22 + 8 + i * lh, { size: 12, color: C.muted });
    });
    ctx.restore();
  }

  /** 表单输入框（.field / .field-input；focus = 金边 + 闪烁光标） */
  field(ctx, x, y, w, label, value, placeholder, focused, code) {
    draw.text(ctx, label, x, y + 15, { size: 12, color: C.muted });
    const fx = x + 56;
    const fw = w - 56;
    const r = { x: fx, y, w: fw, h: 30 };
    ctx.fillStyle = C.inputBg;
    draw.roundRect(ctx, r.x, r.y, r.w, r.h, 5);
    ctx.fill();
    ctx.strokeStyle = focused ? C.gold : C.inputBorder;
    ctx.stroke();
    const shown = value || '';
    const size = 13;
    const maxTW = fw - 16;
    const color = shown ? '#e8efe9' : 'rgba(232,239,233,0.35)';
    let disp = shown || placeholder;
    let tx = r.x + 8;
    if (draw.measure(ctx, disp, size) > maxTW) {
      // 超宽从尾部展示（光标语义在末尾）：左侧截断
      disp = shown;
      while (draw.measure(ctx, disp, size) > maxTW && disp.length > 1) disp = disp.slice(1);
    }
    draw.text(ctx, disp, tx, y + 15, { size, color, baseline: 'middle' });
    if (focused && shown) {
      // 光标（500ms 闪烁）
      if (Math.floor(Date.now() / 500) % 2 === 0) {
        const cw = draw.measure(ctx, shown, size);
        const cx = Math.min(r.x + 8 + cw, r.x + r.w - 8);
        ctx.strokeStyle = C.goldSoft;
        ctx.beginPath();
        ctx.moveTo(cx, r.y + 6);
        ctx.lineTo(cx, r.y + r.h - 6);
        ctx.stroke();
      }
    }
    return r;
  }

  /**
   * 头像选择网格（2026-11-04）：首格「🎲 随机」（选中=空串，服务端按 pid 确定性随机），
   * 其后按清单顺序排玩家可选头像。区域可滚动（内容超出时），绘制时裁剪到视口 + 右侧滚动条。
   * 布局参数记到 u.avatarGrid，供 onTap 命中检测。
   */
  renderAvatarGrid(ctx, x, y, w, h) {
    const u = this.ui;
    const { C } = draw;
    // 标题
    draw.text(ctx, '选择头像（不选则随机分配）', x, y + 12, { size: 12, color: C.muted });
    const captionH = 18;
    const gTop = y + captionH;
    const gH = Math.max(40, h - captionH);
    const ids = avatarart.list();
    const cells = [''].concat(ids); // 0 = 随机
    const cell = 44;
    const gx = 6;
    const gy = 6;
    const cols = Math.max(1, Math.floor((w + gx) / (cell + gx)));
    const rows = Math.ceil(cells.length / cols);
    const rowH = cell + gy;
    const contentH = rows * rowH;
    const maxScroll = Math.max(0, contentH - gH);
    this.avatarScroll = Math.max(0, Math.min(maxScroll, this.avatarScroll || 0));

    u.avatarGrid = {
      x, y: gTop, w, h: gH, cell, gx, gy, cols, rowH, maxScroll, count: cells.length, scroll: this.avatarScroll,
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(x, gTop, w, gH);
    ctx.clip();
    for (let i = 0; i < cells.length; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx = x + c * (cell + gx) + cell / 2;
      const cy = gTop - this.avatarScroll + r * rowH + cell / 2;
      const id = cells[i];
      const selected = id === this.avatar;
      ctx.beginPath();
      ctx.arc(cx, cy, cell / 2, 0, Math.PI * 2);
      ctx.fillStyle = selected ? 'rgba(230,193,75,0.18)' : 'rgba(255,255,255,0.04)';
      ctx.fill();
      if (id === '') {
        ctx.fillStyle = selected ? C.gold : C.muted;
        ctx.font = '22px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🎲', cx, cy + 1);
      } else {
        const img = avatarart.art(id);
        if (img) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(cx, cy, cell / 2 - 1, 0, Math.PI * 2);
          ctx.clip();
          try { ctx.drawImage(img, cx - cell / 2, cy - cell / 2, cell, cell); } catch (e) { /* 解码中跳过 */ }
          ctx.restore();
        } else {
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.beginPath();
          ctx.arc(cx, cy, cell / 2 - 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.beginPath();
      ctx.arc(cx, cy, cell / 2, 0, Math.PI * 2);
      ctx.strokeStyle = selected ? C.gold : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = selected ? 2 : 1;
      ctx.stroke();
    }
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    // 滚动条
    if (maxScroll > 0) {
      const barH = Math.max(12, (gH / contentH) * gH);
      const barY = gTop + (this.avatarScroll / maxScroll) * (gH - barH);
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      draw.roundRect(ctx, x + w - 3, barY, 3, barH, 1.5);
      ctx.fill();
    }
  }

  /** 命中检测：视口内点 (x,y) 落在第几个头像格（0=随机）；不在网格内或落空返回 -1 */
  avatarGridHit(x, y) {
    const g = this.ui.avatarGrid;
    if (!g) return -1;
    if (x < g.x || x > g.x + g.w || y < g.y || y > g.y + g.h) return -1;
    const cols = g.cols;
    const cell = g.cell;
    const gx = g.gx;
    const gy = g.gy;
    const rowH = g.rowH;
    const scroll = g.scroll;
    for (let i = 0; i < g.count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx = g.x + c * (cell + gx) + cell / 2;
      const cy = g.y - scroll + r * rowH + cell / 2;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= (cell / 2) * (cell / 2)) return i;
    }
    return -1;
  }
}

/* input 模块延迟引用（避免 require 环：input 不依赖 scenes，直接引也没环 —— 但保持与 nav 同风格） */
let _input = null;
function inputMod() {
  if (!_input) _input = require('../input.js');
  return _input;
}
function inputFocus(f) {
  inputMod().focus(f);
}
function inputBlur() {
  if (_input) _input.blur();
}
/** 键盘当前高度（input.js 未初始化时 0；特性检测失败也恒 0 → 不抬升） */
function inputKbH() {
  return _input ? _input.kbH() : 0;
}

module.exports = HomeScene;
