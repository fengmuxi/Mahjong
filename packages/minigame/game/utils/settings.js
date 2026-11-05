/**
 * 统一设置（2026-11-04）—— 音频相关的**唯一真相源**。
 *
 * 为什么单独一个模块：
 *   2026-10 那版声音偏好散在两个存储键里（`mj-sound-enabled` / `mj-sound-bgm`），
 *   utils/sound.js 自己读自己写。加到第四项（语音包）时这条路走不通了：
 *     · 局内右轨只能切 BGM，局外没有任何入口 → 用户找不到开关；
 *     · 每个键各自解析、各自容错，加一项就要改两处，容易「存了没生效」；
 *     · 无法做「恢复默认」「一键全静音」这种跨项操作。
 *   现在全部收敛到 **一个 JSON 键 `mj-settings`**：
 *     { v, master, bgm:{on,volume}, sfx:{on,volume}, voice:{on,volume,pack} }
 *   本模块负责读/写/校验/迁移/广播，utils/sound.js 只负责「按当前偏好播」——
 *   由 `applyPrefs()` 单向下发，声音模块不再碰存储（职责分离）。
 *
 * 实时生效：`set()` 改完立刻 `sound.applyPrefs()` 并通知订阅者，
 * 所以局内调音量、切语音包都不需要重进对局。
 *
 * 面板：局内 / 局外共用一份 UI（`templates/settings.wxml`）+ 本模块的 `panel` 动作集。
 * 三个页面各自只写 6 个一行转发方法，逻辑全在这里，避免三份实现漂移。
 */
const sound = require('./sound.js');

/** 设置存储键（**新的唯一键**；旧的两个键只作为一次性迁移来源） */
const KEY = 'mj-settings';
/** 旧键：迁移后不再读写，仅保留常量名以免后人翻不到出处 */
const LEGACY_SFX = 'mj-sound-enabled';
const LEGACY_BGM = 'mj-sound-bgm';
/** 结构版本：将来字段改名时靠它做升级分支（当前 1） */
const V = 1;

/**
 * 默认值 = **从没动过设置的人应听到的效果**：
 *   声音开、背景音乐开但压低（0.3，别盖住出牌反馈）、音效 0.85、语音满音量 + 青年男。
 *   局外背景音乐（2026-11-04）：与局内**分开**的一组 —— 开关/音量/曲目各管各的，
 *   默认曲目「蒙德的月光」。
 */
const DEFAULTS = {
  v: V,
  master: true,
  bgm: { on: true, volume: 0.3 },
  bgmOut: { on: true, volume: 0.3, track: 'moon' },
  sfx: { on: true, volume: 0.85 },
  voice: { on: true, volume: 1, pack: 'n2' },
};

let cur = null; // 当前生效的完整设置
let listeners = [];
let inited = false;

function clamp01(n, def) {
  const v = Number(n);
  if (!isFinite(v)) return def;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function bool(v, def) {
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return def;
}

/** 合法包 id 集合（以 sound.js 的定义为准，两边不会漂移） */
function packIds() {
  return sound.VOICE_PACKS.map((p) => p.id);
}

/** 合法局外曲目 id 集合（以 sound.js 的 OUT_BGM_TRACKS 为准，两边不会漂移） */
function outTrackIds() {
  return sound.OUT_BGM_TRACKS.map((t) => t.id);
}

/**
 * 把任意来源的对象**收敛成合法设置**：缺项补默认、越界夹紧、未知语音包退默认。
 * 存储被人手改过 / 旧版本残留字段都不会让设置页崩掉。
 */
function normalize(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const bgm = o.bgm && typeof o.bgm === 'object' ? o.bgm : {};
  const bgmOut = o.bgmOut && typeof o.bgmOut === 'object' ? o.bgmOut : {};
  const sfx = o.sfx && typeof o.sfx === 'object' ? o.sfx : {};
  const voice = o.voice && typeof o.voice === 'object' ? o.voice : {};
  const pack = packIds().indexOf(voice.pack) >= 0 ? voice.pack : DEFAULTS.voice.pack;
  const outTrack = outTrackIds().indexOf(bgmOut.track) >= 0 ? bgmOut.track : DEFAULTS.bgmOut.track;
  return {
    v: V,
    master: bool(o.master, DEFAULTS.master),
    bgm: { on: bool(bgm.on, DEFAULTS.bgm.on), volume: clamp01(bgm.volume, DEFAULTS.bgm.volume) },
    // 局外 BGM：与局内分开的一组。未知曲目 → 退默认（别让人以为设置丢了）
    bgmOut: {
      on: bool(bgmOut.on, DEFAULTS.bgmOut.on),
      volume: clamp01(bgmOut.volume, DEFAULTS.bgmOut.volume),
      track: outTrack,
    },
    sfx: { on: bool(sfx.on, DEFAULTS.sfx.on), volume: clamp01(sfx.volume, DEFAULTS.sfx.volume) },
    voice: {
      on: bool(voice.on, DEFAULTS.voice.on),
      volume: clamp01(voice.volume, DEFAULTS.voice.volume),
      pack,
    },
  };
}

/**
 * 首次迁移：没有 `mj-settings` 时，把旧的两个键翻成新结构。
 * 只在**确实没有新键**时做一次，之后旧键即使还在也不再理会。
 */
function migrate() {
  try {
    const raw = wx.getStorageSync(KEY);
    if (raw) {
      const o = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (o && typeof o === 'object') return o;
    }
  } catch (e) {
    /* 解析失败当作没有，走迁移 */
  }
  const legacy = {};
  try {
    const v = wx.getStorageSync(LEGACY_SFX);
    if (v === false || v === 'false') {
      // 旧「音效总开关」语义 = 所有声音：音效与语音一起关（背景音乐有自己的键）
      legacy.master = false;
    }
  } catch (e) {
    /* 忽略 */
  }
  try {
    const v = wx.getStorageSync(LEGACY_BGM);
    if (v === false || v === 'false') legacy.bgm = { on: false };
  } catch (e) {
    /* 忽略 */
  }
  return legacy;
}

function persist(next) {
  try {
    wx.setStorageSync(KEY, JSON.stringify(next));
  } catch (e) {
    /* 存储不可用：本次会话仍生效，只是下次回到默认 */
  }
}

function apply() {
  sound.applyPrefs(cur);
}

function emit() {
  for (const cb of listeners.slice()) {
    try {
      cb(get());
    } catch (e) {
      /* 订阅者自身出错不影响别人 */
    }
  }
}

/** 读当前设置（只读副本 —— 调用方改它不会影响内部状态） */
function get() {
  if (!cur) init();
  return JSON.parse(JSON.stringify(cur));
}

/**
 * 修改设置：`set({ voice:{ pack:'w1' } })` 这种**局部深合并**。
 * 改完立即落盘 + 下发声音模块 + 广播订阅者。
 */
function set(patch) {
  if (!cur) init();
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = {
    v: V,
    master: p.master !== undefined ? p.master : cur.master,
    bgm: Object.assign({}, cur.bgm, p.bgm || {}),
    bgmOut: Object.assign({}, cur.bgmOut, p.bgmOut || {}),
    sfx: Object.assign({}, cur.sfx, p.sfx || {}),
    voice: Object.assign({}, cur.voice, p.voice || {}),
  };
  cur = normalize(merged);
  persist(cur);
  apply();
  emit();
  return get();
}

/** 恢复默认（含语音包回青年男） */
function reset() {
  cur = normalize({});
  persist(cur);
  apply();
  emit();
  return get();
}

/** 订阅设置变化（面板/场景自动重绘用）；返回取消函数 */
function onChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.push(fn);
  return () => {
    listeners = listeners.filter((f) => f !== fn);
  };
}

/** 模块加载即初始化一次（app.js require 它就够了，页面无需各自调） */
function init() {
  if (inited) return cur;
  inited = true;
  cur = normalize(migrate());
  persist(cur);
  apply();
  return cur;
}

/** 百分比显示（0~1 → 0~100 整数，滑条与文案共用） */
function pct(v) {
  return Math.round(clamp01(v, 0) * 100);
}

/** 面板初始数据（三个页面 data 里都塞 `st: settings.panel.data()`） */
function data() {
  return {
    shown: false,
    master: true,
    /** 局内背景音乐（对局页播放） */
    bgmOn: true,
    bgmVol: 30,
    /** 局外背景音乐（首页 / 大厅播放）—— 与局内**分开**的一组 */
    bgmOutOn: true,
    bgmOutVol: 30,
    outTrack: sound.DEFAULT_OUT_BGM_TRACK,
    outTracks: [],
    sfxOn: true,
    sfxVol: 85,
    voiceOn: true,
    voiceVol: 100,
    pack: sound.DEFAULT_VOICE_PACK,
    packs: [],
    /** 当前包可用语音条数（-1 = 清单未就绪）；< 9 时面板提示可能缺条 */
    packCount: -1,
  };
}

/** 由内部设置生成面板展示数据（`d` = 面板现有状态，shown 等自有字段原样保留） */
function view(d) {
  const s = get();
  return Object.assign({}, d || {}, {
    master: s.master,
    bgmOn: s.bgm.on,
    bgmVol: pct(s.bgm.volume),
    bgmOutOn: s.bgmOut.on,
    bgmOutVol: pct(s.bgmOut.volume),
    outTrack: s.bgmOut.track,
    // 语音音色（与局内/局外音乐**无关**，独立一条带）
    packs: sound.VOICE_PACKS.map((p) => ({
      id: p.id,
      label: p.label,
      desc: p.desc,
      active: p.id === s.voice.pack,
    })),
    // 局外曲目（局外背景音乐放哪首）
    outTracks: sound.OUT_BGM_TRACKS.map((t) => ({
      id: t.id,
      label: t.label,
      desc: t.desc,
      active: t.id === s.bgmOut.track,
    })),
    sfxOn: s.sfx.on,
    sfxVol: pct(s.sfx.volume),
    voiceOn: s.voice.on,
    voiceVol: pct(s.voice.volume),
    pack: s.voice.pack,
    packCount: sound.voiceCount(s.voice.pack),
  });
}

/**
 * 面板动作集 —— 三个页面各自只写一行转发（见 game.js / home.js / lobby.js）。
 *
 * 为什么是「页面上写 6 个一行方法」而不是给 Page 打 mixin：
 * 小程序 Page() 的选项对象是声明式的，没有可靠的 mixin 机制（Page 只取一次对象）；
 * 硬做 Object.assign 会迫使学生重排整个文件结构。一行转发成本最低、最好读。
 */

/** 打开面板：把当前设置刷进 data，并让局内页藏掉原生画布（syncModal） */
function open(page, extra) {
  // 打开动作**本身就是用户手势**：顺手解锁 iOS 音频会话，否则面板里的试听/调音量
  // 要等下一次出牌才有声（表现为「调了没反应」）。放在这里而不是各页面，省得漏。
  sound.unlock();
  const st = view(Object.assign({}, (page.data && page.data.st) || data(), { shown: true }, extra || {}));
  page.setData({ st });
  // 局内：<canvas> 是原生组件、永远压在 DOM 之上，浮层期间必须 display:none
  if (page.syncModal) page.syncModal();
}

/** 关闭面板 */
function close(page) {
  const st = Object.assign({}, (page.data && page.data.st) || data(), { shown: false });
  page.setData({ st });
  if (page.syncModal) page.syncModal();
}

/**
 * 刷新面板 data（外部改了设置、或清单晚到时调用）。
 * 只覆盖「由设置推导出来的」字段，`shown` 等面板自有字段原样保留。
 */
function refresh(page) {
  if (!page || !page.data || !page.data.st) return;
  page.setData({ st: view(page.data.st) });
}

/**
 * 切换某个开关。`key` 取自 WXML 的 data-key，支持 `master` / `bgm.on` /
 * `sfx.on` / `voice.on` 四种（统一走这里，页面只需一个方法）。
 *
 * `value`：传 switch 自己的 `e.detail.value` 时以它为准（**默认做法**）。
 * 为什么不用 `!当前值` 翻转：连点两次时两次事件都基于同一份旧 data 计算，
 * 翻转会把「开→关→开」算成两次「关」；用控件回传的值则天然幂等。
 * 不传（老调用/脚本）才回退成翻转。
 */
function toggle(page, key, value) {
  const s = get();
  const cur =
    key === 'master'
      ? s.master
      : key === 'bgm.on'
        ? s.bgm.on
        : key === 'bgmOut.on'
          ? s.bgmOut.on
          : key === 'sfx.on'
            ? s.sfx.on
            : key === 'voice.on'
              ? s.voice.on
              : undefined;
  if (cur === undefined) return;
  const next = typeof value === 'boolean' ? value : !cur;
  const patch = {};
  if (key === 'master') patch.master = next;
  else if (key === 'bgm.on') patch.bgm = { on: next };
  else if (key === 'bgmOut.on') patch.bgmOut = { on: next };
  else if (key === 'sfx.on') patch.sfx = { on: next };
  else patch.voice = { on: next };
  set(patch);
  refresh(page);
}

/**
 * 音量滑动。`value` 是 0~100。
 * `commit=false`（滑条 dragging 阶段）只改运行期音量、不落盘：
 *   拖动过程中会连发几十次事件，每次都写存储既浪费又可能写坏；
 *   松手那一次的 `change` 才持久化（最终值与拖完的值一致）。
 */
function slide(page, key, value, commit) {
  const vol = clamp01(Number(value) / 100, 0);
  const patch = {};
  if (key === 'bgm.volume') patch.bgm = { volume: vol };
  else if (key === 'bgmOut.volume') patch.bgmOut = { volume: vol };
  else if (key === 'sfx.volume') patch.sfx = { volume: vol };
  else if (key === 'voice.volume') patch.voice = { volume: vol };
  else return;
  if (commit) {
    set(patch);
  } else {
    // 运行期直改：sound 的 setter 不落盘，正好用来做实时试听（拖到哪听到哪）
    if (key === 'bgm.volume') sound.setBgmVolume(vol);
    else if (key === 'bgmOut.volume') sound.setOutBgmVolume(vol);
    else if (key === 'sfx.volume') sound.setSfxVolume(vol);
    else sound.setVoiceVolume(vol);
  }
  // view() 读的是**已落盘**的设置，拖动阶段还没落盘 → 用本次的值覆盖显示，
  // 否则滑条会在手里「弹回旧位置」（数字跟手、滑条不跟手，观感很差）。
  const st = view((page.data && page.data.st) || data());
  if (key === 'bgm.volume') st.bgmVol = pct(vol);
  else if (key === 'bgmOut.volume') st.bgmOutVol = pct(vol);
  else if (key === 'sfx.volume') st.sfxVol = pct(vol);
  else st.voiceVol = pct(vol);
  page.setData({ st });
}

/** 选语音包（四种音色）。选完立刻用新音色试播一声「碰」，让用户听到差别 */
function pickPack(page, id) {
  if (packIds().indexOf(id) < 0) return;
  set({ voice: { pack: id } });
  const st = Object.assign({}, (page.data && page.data.st) || data());
  page.setData({ st: view(st) });
  preview();
}

/**
 * 选局外曲目（点一下即换曲）。
 * **不自动播**：局内正在放局内 BGM 时再叠一首曲子只是噪音；局外时选曲会直接切掉
 * 正在放的那首（sound.setOutBgmTrack 里换 src 续播）。
 */
function pickOutTrack(page, id) {
  if (outTrackIds().indexOf(id) < 0) return;
  set({ bgmOut: { track: id } });
  const st = Object.assign({}, (page.data && page.data.st) || data());
  page.setData({ st: view(st) });
}

/**
 * 试听：播当前语音包的「碰」（最短、最典型的一声）。
 * **不受语音开关影响** —— 用户点试听就是要听，关了就没法判断音色好不好。
 */
function preview() {
  if (!sound.ready()) sound.ensure();
  return sound.preview('peng');
}

/** 恢复默认 */
function doReset(page) {
  reset();
  const st = Object.assign({}, (page.data && page.data.st) || data());
  page.setData({ st: view(st) });
}

/** 模块加载即初始化（require 一次就把设置读进来并下发给声音模块） */
init();

module.exports = {
  KEY,
  DEFAULTS,
  get,
  set,
  reset,
  onChange,
  init,
  panel: {
    data,
    view,
    open,
    close,
    refresh,
    toggle,
    slide,
    pickPack,
    pickOutTrack,
    preview,
    reset: doReset,
  },
};
