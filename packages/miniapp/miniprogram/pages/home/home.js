/**
 * 首页：分步向导（① 创建/加入 → ② 选择玩法（仅创建分支）→ 最后 填写信息）。
 *
 * 逻辑与 web 端 `main.ts` 的向导保持一致，包括两条易被破坏的约定：
 *   · **步骤条按分支重建**，`stepSeq()` = join ? [mode, form] : [mode, variant, form]
 *     —— 加入分支没有玩法步（玩法由房间决定，让用户选会误导）；
 *   · **没有「锁定」态**：任何入口（含分享链接预填）都能回退到上一步。
 *
 * 分享入口：web 端靠 `?room=` 预填；小程序用 `onLoad(options.room)`（转发卡片携带的 query），
 * 语义同样是「只预填、可修改、可回退」。
 */

const { VARIANT_LIST, DEFAULT_VARIANT } = require('../../lib/shared/rules/index.js');
const room = require('../../utils/room.js');
const net = require('../../utils/net.js');
const store = require('../../utils/store.js');
const config = require('../../utils/config.js');
const ui = require('../../utils/ui.js');

const BG_OPTIONS = [
  { id: 'felt', label: '绒面' },
  { id: 'lattice', label: '回纹' },
  { id: 'cloud', label: '祥云' },
  { id: 'plain', label: '素色' },
];

Page({
  data: {
    step: 'mode',
    // 页面切换转场：room.js 跳转前置 true → 根节点 .page-leaving 淡出后再 redirectTo
    pageLeaving: false,
    wizardMode: '',
    steps: [],
    variants: [],
    selectedVariant: DEFAULT_VARIANT,
    variantName: '',
    name: '',
    code: '',
    codeFromLink: false,
    errorText: '',
    errorShown: false,
    bgOptions: BG_OPTIONS,
    bg: 'cloud',
    focusName: false,
    focusCode: false,
    toastShown: false,
    toastText: '',
    netShown: false,
    netText: '',
  },

  onLoad(options) {
    this.attempted = false;
    let selected = store.get(store.KEYS.variant, DEFAULT_VARIANT);
    if (!VARIANT_LIST.some((v) => v.id === selected)) selected = DEFAULT_VARIANT;
    const bg = store.get(store.KEYS.bg, 'cloud');
    this.setData({
      selectedVariant: selected,
      variants: VARIANT_LIST.map((v) => ({
        id: v.id,
        name: v.name,
        desc: v.desc || `${v.seats} 人局`,
        tags: v.tags || [`${v.seats} 人`],
      })),
      name: store.get(store.KEYS.name, ''),
      bg,
    });

    // 分享链接预填：options.room 来自转发卡片 / 扫码的 query（等价 web 端 ?room=）
    const roomParam = options && options.room ? String(options.room).toUpperCase().slice(0, 6) : '';
    if (roomParam) {
      this.setData({ code: roomParam, codeFromLink: true, wizardMode: 'join' });
      this.goStep('form');
    } else {
      this.goStep('mode');
      // 昵称为空才自动聚焦（本地记忆里已有昵称时不再弹键盘）
      if (!this.data.name) this.setData({ focusName: true });
    }
  },

  onShow() {
    room.attach('home', this);
    // 回桌失败（token 过期 / 座位已回收 / 房间已解散）：本地缓存的房间已失效。
    // 两条入口汇到这里：① reLaunch 落地后由 onShow 消费（人原本在别的页）；
    // ② 本来就在首页时由 room.js 直接回调 onResumeFail。统一走 handleResumeFail。
    const g = getApp().globalData;
    if (g.resumeFail) {
      const fail = g.resumeFail;
      g.resumeFail = null;
      this.handleResumeFail(fail);
      return;
    }
    // 启动即尝试凭本地 token 回桌（等价 web 端刷新自动重连）
    room.tryResume();
    this.syncNet();
  },

  onHide() {
    room.detach(this);
  },

  onUnload() {
    room.detach(this);
  },

  // ---------- 网络状态横幅 ----------
  onNetStatus(s) {
    const text = net.describe(s);
    this.setData({ netText: text, netShown: !!text });
    // 用户已经点过「创建/加入」却握手失败 → 把真实原因直接写在表单错误位（横幅容易被忽略）
    if (this.attempted && s && (s.state === 'failed' || s.state === 'no-url')) {
      this.showError(text);
      this.attempted = false;
    }
  },

  syncNet() {
    this.onNetStatus({
      state: net.getState(),
      inRoom: false,
      everConnected: net.hasConnected(),
      error: net.getLastError(),
      url: net.getUrl(),
    });
  },

  // ---------- 向导 ----------

  stepSeq() {
    return this.data.wizardMode === 'join' ? ['mode', 'form'] : ['mode', 'variant', 'form'];
  },

  stepLabel(id) {
    if (id === 'mode') return '创建 / 加入';
    if (id === 'variant') return '选择玩法';
    if (this.data.wizardMode === 'join') return '加入房间';
    if (this.data.wizardMode === 'create') return '创建房间';
    return '填写信息';
  },

  renderSteps() {
    const seq = this.stepSeq();
    const cur = seq.indexOf(this.data.step);
    this.setData({
      steps: seq.map((id, i) => ({
        id,
        no: String(i + 1),
        label: this.stepLabel(id),
        state: id === this.data.step ? 'current' : i < cur ? 'done' : 'todo',
      })),
    });
  },

  goStep(id) {
    this.setData({ step: id, errorShown: false, focusName: false, focusCode: false });
    this.renderSteps();
    if (id === 'form') {
      this.renderWizardForm();
      const focusCode = this.data.wizardMode === 'join' && !this.data.code;
      // 昵称已填（本地记忆回填 / 上一步带过来）就不要再抢焦点弹键盘——
      // 自动聚焦只在昵称为空时发生（2026-10-18）
      const focusName = !this.data.name && !focusCode;
      this.setData({ focusName, focusCode });
    }
  },

  renderWizardForm() {
    const isJoin = this.data.wizardMode === 'join';
    const meta = this.data.variants.find((v) => v.id === this.data.selectedVariant);
    const chips = [];
    if (isJoin) chips.push('玩法 由房间决定');
    else chips.push(`玩法 ${meta ? meta.name : this.data.selectedVariant}`);
    chips.push(isJoin ? '加入已有房间' : '成为房主（东家）');
    if (isJoin && this.data.codeFromLink) chips.push('房间码已预填 · 可修改');
    this.setData({
      formHead: isJoin ? '加入朋友的房间' : '开一桌新牌局',
      formSubmit: isJoin ? '加入房间' : '创建房间',
      chips,
    });
  },

  onStepTap(e) {
    const id = e.currentTarget.dataset.step;
    const seq = this.stepSeq();
    const idx = seq.indexOf(id);
    if (idx >= 0 && idx < seq.indexOf(this.data.step)) this.goStep(id);
  },

  onPickMode(e) {
    const mode = e.currentTarget.dataset.mode;
    const patch = { wizardMode: mode };
    if (mode === 'create') {
      // 改走创建分支 → 不再沿用分享链接预填的房间码（web 端是清掉 URL 参数）
      patch.code = '';
      patch.codeFromLink = false;
    }
    this.setData(patch);
    this.goStep(mode === 'join' ? 'form' : 'variant');
  },

  onPickVariant(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ selectedVariant: id });
    store.set(store.KEYS.variant, id);
    this.renderSteps();
  },

  onBack() {
    this.goStep(this.data.wizardMode === 'join' ? 'mode' : 'variant');
  },

  /** WXML 里「下一步」直接绑方法名，这里包一层跳转 */
  goStepForm() {
    this.goStep('form');
  },

  onNameInput(e) {
    this.setData({ name: e.detail.value });
  },

  onCodeInput(e) {
    this.setData({ code: e.detail.value });
  },

  onBgPick(e) {
    const id = e.currentTarget.dataset.id;
    this.setData({ bg: id });
    store.set(store.KEYS.bg, id);
  },

  showError(text) {
    this.setData({ errorText: text, errorShown: true });
  },

  onSubmit() {
    if (this.data.step !== 'form') return;
    const name = String(this.data.name || '').trim();
    if (!name) {
      this.showError('请先填写昵称');
      return;
    }
    store.set(store.KEYS.name, name);
    if (!config.resolve()) {
      this.showError('未配置服务器域名：请填写 utils/config.js 的 DEFAULT_WSS（wss + 已备案域名）');
      return;
    }
    if (this.data.wizardMode === 'join') {
      const code = String(this.data.code || '').trim().toUpperCase();
      if (code.length !== 6) {
        this.showError('房间码为 6 位');
        return;
      }
      this.setData({ errorShown: false });
      this.attempted = true;
      // pid = 本地稳定玩家 id：服务端先用 (pid, code) 找座位，找到就直接回原座位（掉线重进）
      room.connectAndSend({ t: 'join', code, name, pid: store.ensurePid() });
      return;
    }
    this.setData({ errorShown: false });
    this.attempted = true;
    room.connectAndSend({ t: 'create', name, variant: this.data.selectedVariant, pid: store.ensurePid() });
  },

  // ---------- 路由回调 ----------

  onError(reason) {
    this.showError(reason);
  },

  onResumeFail(fail) {
    this.handleResumeFail(fail);
  },

  /**
   * 本地缓存的房间已失效（2026-10-24，用户报「过期了还停在加入房间界面」）：
   *   ① 先 toast 提示服务端给的原因（房间已失效 / 房间不存在…），让人知道为什么被弹回来；
   *   ② 再把向导重置回**首页初始态**（mode 步）—— 旧行为是落到「加入房间」表单步，
   *      那里只有一行红字、还预填着一个已失效的房间码，用户既回不去也没有下一步可走。
   *
   * 房间码保留在 `data.code`（mode 步不可见）：失效的房间多半还能凭码重进
   * （服务端重启 / 座位被回收时房间往往还在），再点「加入房间」直接回填，
   * 不用重新找朋友要码；走创建分支时 `onPickMode` 会清掉它，不会串到创建流程。
   */
  handleResumeFail(fail) {
    const reason = String((fail && fail.reason) || '').trim();
    const room = String((fail && fail.room) || '').toUpperCase().slice(0, 6);
    const patch = {
      step: 'mode',
      wizardMode: '',
      codeFromLink: false,
      errorShown: false,
      errorText: '',
      focusName: false,
      focusCode: false,
    };
    if (/^[0-9A-Z]{6}$/.test(room)) patch.code = room;
    this.setData(patch);
    this.renderSteps();
    this.toast(reason || '房间已失效，请重新加入');
  },

  onShareAppMessage() {
    return { title: '来一局麻将', path: '/pages/home/home' };
  },

  toast(text) {
    ui.showToast(this, text);
  },
});
