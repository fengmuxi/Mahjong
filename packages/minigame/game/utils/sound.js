/**
 * 局内音效 + 语音包（2026-11-04 起两条通道）。
 *
 * 与牌面 / UI 贴图同套路 —— **音频也不进代码包**（官方体检红线：主包 < 1.5MB、
 * 图+音 ≤ 200KB），走 `GET /api/sound` 清单 + CDN 静态文件：
 *   1. `GET {api}/api/sound` 取清单
 *      `{ version, base, sounds:{…}, voiceVer, voices:{ n1:{ chi:'v_n1_chi.mp3', … }, … } }`；
 *   2. `wx.createInnerAudioContext()` 按键播放（远端 src 需在 **downloadFile** 合法域名里）。
 *   3. 清单请求失败/未返回时，用内置文件名 + 当前 API host 兜底（request 域名未登记也能响）。
 *
 * **两条通道**（2026-11-04 新增语音包）：
 *   · 音效 `play(key)` —— 不带人声的反馈音（出牌 / 发牌 / 点击 / 背景音乐），键名：
 *     discard 出牌 · deal 发牌摸牌 · click 点击手牌 · bgm 背景音乐（1MB 循环长音频，
 *     唯一的大文件，按需下载）。另有 gang / peng / hu / chi 四个**旧**人声替代音，
 *     现在只在「语音包关闭 / 该条语音缺失」时兜底（见 playAction）。
 *   · 语音 `playVoice(action)` —— 四套人声播报，按角色分 n1 中年男 / n2 青年男 /
 *     w1 中年女 / w2 青年女，**默认 n2**（没有设置过的人听到的就是青年男）。
 *     action：chi 吃 · peng 碰 · gang 杠 · angang 暗杠 · gangkai 杠开 · hu 胡(点炮)
 *     zimo 自摸 · liuju 流局 · guo 过。
 *
 * **统一入口 `playAction(kind)`**：对局里一律走它 —— 「有语音就播语音，
 * 没语音/关了语音就退原音效」，调用处不需要知道当前是哪套包、开没开语音。
 * 逐级兜底链：当前包 → 默认包(n2) → 原音效 mp3 → 无声。
 *
 * 约定：
 *   · 任何一步失败都**只打一条日志**，绝不影响对局（没音效只是没声音）；
 *   · **局外 BGM（2026-11-04）**：整首曲子，与局内 `bgm.mp3`（65s 循环）**分成两套**。
 *     局内由对局页起（`bgmStart/bgmStop`），局外由首页/大厅起（`outBgmStart/outBgmStop`），
 *     **两个独立实例** —— 切场景时「停旧起新」若共用一个 InnerAudioContext，就是 stop() 紧跟
 *     play()，撞微信 504「error player to stop」。三首曲目：风洗的群山 / 蒙德的月光（默认）/
 *     钓客漫歌；整曲 1.6~2.3MB 且 InnerAudioContext 是「整文件下完再播」→ 首次播放有下载延迟，
 *     所以局外 BGM **进首页/大厅就起**，让下载与用户浏览同时进行；
 *   · 同一音效连播 → 已播过用 `seek(0)` 回开头再播（不叠音），
 *     **不要 stop()+play()**：微信要求 stop 必须在 canplay 之后，
 *     高频音效（碰/杠）常在上一次还没 canplay 时被再次触发 → 504「error player to stop」；
 *   · 静音键不掐断音效（obeyMuteSwitch = false + app.js 的全局 setInnerAudioOption）；
 *   · `unlock()` 在用户交互时调用；清单没就绪不置 unlocked，下次交互继续重试
 *     （否则「他人出牌 / 碰杠胡」这类无交互触发的音效在 iOS 真机上不响）；
 *   · **所有开关/音量都由 utils/settings.js 通过 `applyPrefs()` 下发**（单一真相源在
 *     那边，本模块只负责「按当前偏好播」）；`applyPrefs` 从未被调用时（老代码路径 /
 *     小游戏还没接设置面板）退回默认值 + 一次性的旧存储键读取，不会把人的静音丢掉。
 */
const config = require('./config.js');

const CACHE_KEY = 'mj-sound';
/** 旧版背景音乐开关的独立存储键（2026-10-23）：仍被 settings.js 用作迁移来源 */
const BGM_KEY = CACHE_KEY + '-bgm';
const CACHE_DAYS = 7;
/** 音效默认音量（出牌/点击这类短反馈，略低于满值以免刺耳） */
const DEFAULT_VOLUME = 0.85;
/** 背景音乐默认音量：低于音效，避免盖住出牌/碰杠胡反馈 */
const BGM_VOLUME = 0.3;
/** 语音默认音量：人声是主要内容，默认满值（再靠用户自己调） */
const VOICE_VOLUME = 1;
/**
 * 语音包清单（顺序即设置面板里的展示顺序）。`label` / `desc` 直接给 UI 用，
 * 避免面板里再写一份中文映射。
 */
const VOICE_PACKS = [
  { id: 'n1', label: '中年男', desc: '沉稳厚重' },
  { id: 'n2', label: '青年男', desc: '清爽利落（默认）' },
  { id: 'w1', label: '中年女', desc: '温和亲切' },
  { id: 'w2', label: '青年女', desc: '明快活泼' },
  { id: 'ht', label: '胡桃', desc: '俏皮灵动' },
];
/** 默认语音包：**青年男**。没存过设置、或存的值不认识时都用它 */
const DEFAULT_VOICE_PACK = 'n2';
/** 清单请求失败后的重试间隔 / 次数（真机首屏网络抖动时不能一失即哑） */
const RETRY_MS = 8000;
const MAX_RETRIES = 3;
/** 连续失败 3 次后冷却 30s 再试（避免一次网络抖动把某个音效永久拉黑） */
const FAIL_RESET_MS = 30000;
/**
 * 本地兜底清单（2026-10-23）：服务端 SOUND_FILES 的约定文件名。
 * `/api/sound` 只是「版本 + CDN base」的覆盖；请求域名未登记 / 首屏网络抖动时，
 * 直接用当前 API host 拼 `/sound/xxx.mp3` 播放，避免整局静音。
 */
const DEFAULT_SOUNDS = {
  discard: 'discard.mp3',
  deal: 'deal.mp3',
  gang: 'gang.mp3',
  peng: 'peng.mp3',
  hu: 'hu.mp3',
  chi: 'chi.mp3',
  click: 'click.mp3',
  bgm: 'bgm.mp3',
  /** 掷骰起手声（2026-11-04）：局内开局/杠后/翻精 + 大厅定庄共用 */
  dice: 'dice.mp3',
};
/**
 * 局外背景音乐曲目（2026-11-04）。`id` 与服务端 `/api/sound` 的 `bgmOut` 键一一对应；
 * `label`/`desc` 直接给设置面板用，避免面板里再写一份中文映射。
 * 顺序即设置面板里的展示顺序。
 */
const OUT_BGM_TRACKS = [
  { id: 'wind', label: '风洗的群山', desc: '清越空灵' },
  { id: 'moon', label: '蒙德的月光', desc: '静谧温柔（默认）' },
  { id: 'reed', label: '钓客漫歌', desc: '悠扬古韵' },
];
/** 默认局外曲目：蒙德的月光。没存过设置、或存的值不认识时都用它 */
const DEFAULT_OUT_BGM_TRACK = 'moon';
/**
 * 局外 BGM 的本地兜底清单（与服务端 OUT_BGM_FILES 的文件名约定一致）。
 * 和 DEFAULT_SOUNDS 同样的赌法 —— 清单没回来也先按约定文件名试播；
 * 真不存在时客户端会退默认曲目（不会整局哑掉）。
 */
const DEFAULT_OUT_BGM = {
  wind: 'bgm_wind.mp3',
  moon: 'bgm_moon.mp3',
  reed: 'bgm_reed.mp3',
};
/** 语音包的动作键（与服务端 VOICE_ACTIONS 一一对应） */
const VOICE_ACTIONS = ['chi', 'peng', 'gang', 'angang', 'gangkai', 'hu', 'zimo', 'liuju', 'guo'];
/**
 * 本地兜底语音清单：`v_<pack>_<action>.mp3`（与 scripts/gen_sound_voice.mjs 的输出一致）。
 * 和 DEFAULT_SOUNDS 同样的赌法 —— 首屏清单没回来也先按约定文件名试播；
 * 真不存在时由「连败 3 次 → 退原音效」兜住，不会整局哑掉。
 */
const DEFAULT_VOICES = (() => {
  const o = {};
  for (const p of VOICE_PACKS) {
    o[p.id] = {};
    for (const a of VOICE_ACTIONS) o[p.id][a] = `v_${p.id}_${a}.mp3`;
  }
  return o;
})();
/**
 * 对局动作 kind → 语音动作。
 * `bugang`/`declare` 复用杠（补杠、报杠都是「杠」这一声）；`draw` 走流局。
 * 胡的**自摸/点炮**要分开，靠调用处传 `{ zimo: true }` 覆盖（见 playAction）。
 */
const VOICE_BY_KIND = {
  chi: 'chi',
  peng: 'peng',
  gang: 'gang',
  angang: 'angang',
  bugang: 'gang',
  declare: 'gang',
  hu: 'hu',
  draw: 'liuju',
};
/** 动作 kind → 原音效键（语音关闭/缺失时的兜底；`draw` 没有旧音效，故缺省） */
const SFX_BY_KIND = {
  chi: 'chi',
  peng: 'peng',
  gang: 'gang',
  angang: 'gang',
  bugang: 'gang',
  declare: 'gang',
  hu: 'hu',
  discard: 'discard',
  deal: 'deal',
};

let state = null; // { version, base, sounds, voiceVer, voices, host, ts }
let status = 'idle'; // idle | loading | ready | failed
let enabled = true;
let unlocked = false;
let listeners = [];
let inflight = false;
let netSettled = false;
let retries = 0;
let retryTimer = null;
let lastLogged = '';
/** 偏好是否已由 applyPrefs 下发过（没下发时才去读旧存储键，见文件头约定） */
let prefsBound = false;
/** 当前生效的偏好（默认值 = 从没动过设置的人听到的效果） */
let sfxEnabled = true;
let sfxVolume = DEFAULT_VOLUME;
let voiceEnabled = true;
let voiceVolume = VOICE_VOLUME;
let voicePack = DEFAULT_VOICE_PACK;
/** key → InnerAudioContext（每键一个，重复播放走同一个） */
const pool = new Map();
/** key → 连续失败次数（失败 3 次才放弃；成功一次即清零，不再永久拉黑） */
const failCounts = new Map();
/** key → 最近一次失败时间（用于 30s 冷却后重试） */
const failAt = new Map();
/** key → 上次播放时间戳（用于 minGap 节流） */
const lastPlayed = new Map();
/** 背景音乐实例 / 是否希望播放（用于 onShow/手势重试） / 是否正在播 / 用户是否开启 */
let bgmCtx = null;
let bgmWanted = false;
let bgmPlaying = false;
let bgmEnabled = true;
/** 背景音乐音量（独立于音效/语音，见 setBgmVolume） */
let bgmVolume = BGM_VOLUME;
/* ---- 局外背景音乐（2026-11-04）：独立实例、独立开关/音量/曲目 ---- */
let outBgmEnabled = true;
let outBgmVolume = BGM_VOLUME;
let outBgmTrack = DEFAULT_OUT_BGM_TRACK;
let outBgmCtx = null;
/** 是否希望播放（用于 onShow/手势重试） / 是否正在播 */
let outBgmWanted = false;
let outBgmPlaying = false;

function log(level, msg) {
  if (lastLogged === msg) return;
  lastLogged = msg;
  try {
    if (level === 'warn') console.warn(msg);
    else console.info(msg);
  } catch (e) {
    /* 控制台不可用时忽略 */
  }
}

function safeCall(cb, ok) {
  try {
    cb(ok);
  } catch (e) {
    /* 回调出错不影响渲染 */
  }
}

function emit(ok) {
  for (const cb of listeners.slice()) safeCall(cb, ok);
}

function flush(ok) {
  const list = listeners.splice(0, listeners.length);
  for (const cb of list) safeCall(cb, ok);
}

function hostOf(url) {
  const m = /^(?:https?|wss?):\/\/([^/]+)/i.exec(String(url || ''));
  return m ? m[1].toLowerCase() : '';
}

function readCache(host) {
  try {
    const raw = wx.getStorageSync(CACHE_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (!o || !o.sounds || Object.keys(o.sounds).length === 0) return null;
    // 新缓存带 host（API 域名）；旧缓存没有 host，只拦「http 局域网/旧环境」地址，
    // 不拦独立 CDN（base 可能是另一个 https 域名）。
    if (o.host) {
      if (host && hostOf(o.host) !== hostOf(host)) return null;
    } else if (o.base && /^http:\/\//i.test(o.base) && host && hostOf(o.base) !== hostOf(host)) {
      return null;
    }
    if (o.ts && Date.now() - Number(o.ts) > CACHE_DAYS * 86400000) return null;
    return o;
  } catch (e) {
    return null;
  }
}

function writeCache(o) {
  try {
    wx.setStorageSync(CACHE_KEY, JSON.stringify(o));
  } catch (e) {
    /* 存储不可用时忽略 */
  }
}

/**
 * 旧版偏好键的一次性读取（2026-11-04）。
 *
 * 偏好从「两个键各管一半」收敛成 `mj-settings` 一份（见 utils/settings.js），
 * 迁移责任在 settings.js。但**老代码路径不能因此变哑**：小游戏端在接设置面板之前
 * 没人调 applyPrefs，此时按旧键回读一次，避免「上次静音了，这次突然全响」。
 * 只要 applyPrefs 调用过一次，就再也不看这些旧键（prefsBound = true）。
 */
function readLegacyPrefs() {
  if (prefsBound) return;
  prefsBound = true;
  try {
    const v = wx.getStorageSync(CACHE_KEY + '-enabled');
    if (v === false || v === 'false') {
      sfxEnabled = false;
      voiceEnabled = false; // 旧版「音效总开关」语义 = 全部声音，一并转成新语义
    }
  } catch (e) {
    /* 忽略 */
  }
  try {
    const v = wx.getStorageSync(BGM_KEY);
    if (v === false || v === 'false') bgmEnabled = false;
  } catch (e) {
    /* 忽略 */
  }
}

function scheduleRetry() {
  if (retryTimer || retries >= MAX_RETRIES) return;
  retries += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    netSettled = false;
    ensure();
  }, RETRY_MS * retries);
}

/**
 * 取清单。先立即用「缓存 / 本地兜底清单」置 ready（进房第一声就能响），
 * 再后台请求 `/api/sound` 校验版本。请求失败只影响版本刷新，不再整局静音。
 */
function ensure(cb) {
  if (typeof cb === 'function') listeners.push(cb);
  if (inflight) return;

  readLegacyPrefs(); // 仅当 applyPrefs 从未下发过时生效（老路径兜底）
  if (!enabled) log('warn', '[sound] 总开关关闭（mj-settings.master=false）→ 全局静音');
  const host = config.resolveApi();
  if (!host) {
    netSettled = true;
    if (status !== 'ready') status = 'failed';
    log('warn', '[sound] 未拿到 API 域名（config.resolveApi 为空）→ 局内静音；检查 utils/config.js 的 DEFAULT_WSS');
    flush(status === 'ready');
    return;
  }
  if (/^https?:\/\/(?:localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(host)) {
    log('warn', `[sound] API 指向局域网 ${host} → 真机不在同一 Wi-Fi 时音频/牌面都会失败；清 mj-wss / mj-api 或改 DEFAULT_WSS`);
  }

  // 运行期换了 host（如从局域网切到线上）：旧 base / 旧 context 全部作废
  if (state && state.host && state.host !== host) {
    state = null;
    status = 'idle';
    netSettled = false;
    retries = 0;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    failCounts.clear();
    failAt.clear();
  }

  if (status !== 'ready') {
    const cached = readCache(host);
    state = cached
      ? Object.assign({}, cached, {
          sounds: Object.assign({}, DEFAULT_SOUNDS, cached.sounds), // 旧缓存补上新键（如 chi）
          // 旧缓存没有 voices（升级前存的）：先按约定文件名兜底，等 /api/sound 回来再校正。
          // 这里**不**把缓存里的 voices 与 DEFAULT_VOICES 合并 —— 服务端刻意「只列真实存在
          // 的文件」，合并会把缺的那条又加回来，兜底链就永远不会退到默认包。
              voices: cached.voices && Object.keys(cached.voices).length ? cached.voices : DEFAULT_VOICES,
              // 局外曲目同理：旧缓存没有 bgmOut → 先按约定文件名兜底，等清单回来再校正
              bgmOut: cached.bgmOut && Object.keys(cached.bgmOut).length ? cached.bgmOut : DEFAULT_OUT_BGM,
              bgmOutVer: cached.bgmOutVer || 'local',
            })
          : {
              version: 'local',
              base: host,
              sounds: Object.assign({}, DEFAULT_SOUNDS),
              voiceVer: 'local',
              voices: DEFAULT_VOICES,
              bgmOut: DEFAULT_OUT_BGM,
              bgmOutVer: 'local',
              host,
              ts: Date.now(),
            };
    if (!state.host) state.host = host;
    if (!/^https?:\/\//i.test(String(state.base || ''))) state.base = host;
    status = 'ready';
    log(
      'info',
      `[sound] ready(local) · ${state.base} · ${Object.keys(state.sounds).length} 音效 · ` +
        `${Object.keys(state.voices || {}).length} 语音包`,
    );
    emit(true);
  }

  if (netSettled) {
    flush(true);
    return;
  }

  inflight = true;
  log('info', `[sound] GET ${host}/api/sound`);
  wx.request({
    url: `${host}/api/sound`,
    method: 'GET',
    timeout: 8000,
    success: (res) => {
      const o = res && res.data;
      inflight = false;
      netSettled = true;
      if (!o || !o.sounds || Object.keys(o.sounds).length === 0) {
        log('warn', `[sound] 清单为空（${host}/api/sound 返回 0 项）→ 继续用本地清单；确认服务端 public/sound 是否随版本一起发布`);
        if (status !== 'ready') status = 'failed';
        if (status === 'ready') scheduleRetry();
        flush(status === 'ready');
        return;
      }
      const rawBase = String(o.base || host).replace(/\/+$/, '');
      const next = {
        version: String(o.version || ''),
        base: /^https?:\/\//i.test(rawBase) ? rawBase : host,
        sounds: Object.assign({}, DEFAULT_SOUNDS, o.sounds), // 客户端先更新、服务端清单未跟上时仍能取到 chi
        voiceVer: String(o.voiceVer || o.version || ''),
        // 语音清单**不并 DEFAULT_VOICES**：服务端只列真实存在的文件，
        // 合并等于把「缺这条」的信息抹掉，兜底链失效（见上面 readCache 处的说明）。
        // 服务端还没升级（无 voices 字段）时才退回本地约定清单。
        voices: o.voices && Object.keys(o.voices).length ? o.voices : DEFAULT_VOICES,
        // 局外曲目清单同样**不与 DEFAULT_OUT_BGM 合并**：服务端只列真实存在的曲子，
        // 合并会把「没部署这首」的信息抹掉，兜底（退默认曲目）就失效了。
        // 服务端还没升级（无 bgmOut 字段）时才退回本地约定清单。
        bgmOut: o.bgmOut && Object.keys(o.bgmOut).length ? o.bgmOut : DEFAULT_OUT_BGM,
        bgmOutVer: String(o.bgmOutVer || o.version || ''),
        host,
        ts: Date.now(),
      };
      state = next;
      writeCache(next);
      status = 'ready';
      retries = 0;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      log(
        'info',
        `[sound] ready ${next.version} · ${Object.keys(next.sounds).length} 音效 · ` +
          `${Object.keys(next.voices).length} 语音包 · ${next.base}`,
      );
      flush(true);
    },
    fail: (err) => {
      inflight = false;
      netSettled = true;
      if (status !== 'ready') status = 'failed';
      log('warn', `[sound] 清单请求失败（${host}/api/sound，${(err && err.errMsg) || 'unknown'}）→ 继续用本地清单；检查网络与 request 合法域名`);
      if (status === 'ready') scheduleRetry();
      flush(status === 'ready');
    },
  });
}

/** 该键的 CDN 地址；未就绪/无此键返回空串 */
function urlOf(key) {
  if (status !== 'ready' || !state) return '';
  const name = state.sounds[key];
  if (!name) return '';
  return `${state.base}/sound/${name}?v=${state.version}`;
}

/**
 * 解析某条语音的落盘文件名：**当前包 → 默认包**（缺这条就借青年男的），
 * 都没有返回 null。返回 `{ name, url }`。
 *
 * 为什么按「文件名」而不是按「包+动作」做键：兜底时播的是**别的包**的文件，
 * 池子若按 (包,动作) 建索引，同一份文件会为每个包各建一个 InnerAudioContext
 * （多份解码器 + 重复下载）。按文件名索引天然去重。
 */
function resolveVoice(action) {
  if (status !== 'ready' || !state || !action) return null;
  const voices = state.voices || {};
  const mine = voices[voicePack] || {};
  let name = mine[action];
  if (!name) {
    const def = voices[DEFAULT_VOICE_PACK] || {};
    name = def[action];
  }
  if (!name) return null;
  return { name, url: `${state.base}/sound/${name}?v=${state.voiceVer || state.version}` };
}

/**
 * 播一条语音。返回是否真的播了。
 * 同 play() 的连败/节流/seek 语义完全一致（共用 startKey），差别只有：
 *   · 门禁是 `voiceEnabled`（独立于音效开关）；
 *   · 地址走 resolveVoice（含包级兜底）。
 * 失败 3 次以上返回 false —— 调用方 playAction 据此**退原音效**，保证不会因为
 * 「语音包没部署/文件名对不上」而彻底没声。
 */
function playVoice(action, opts) {
  if (!enabled || !voiceEnabled) return false;
  let hit = resolveVoice(action);
  if (!hit) {
    ensure();
    hit = resolveVoice(action);
    if (!hit) {
      log('info', `[sound] 无 ${action} 语音（包 ${voicePack} 与默认包都没有）→ 交给调用方兜底`);
      return false;
    }
  }
  return startKey('v:' + hit.name, hit.url, voiceVolume, opts);
}

/**
 * 对局动作的统一播放入口（2026-11-04）。
 *
 * 调用处只写 `sound.playAction(a.kind)`，不需要知道：
 * 现在选的是哪套包、语音开关开没开、这条语音服务端有没有。
 * 兜底顺序：**当前包语音 → 默认包(n2)语音 → 原音效 mp3 → 无声**。
 *
 * `opts.zimo`：胡牌时区分自摸/点炮（`hu` 与 `zimo` 是两条不同语音）。
 * 传了 `opts.voice` 则强制用指定语音动作（如杠开传 'gangkai'）。
 */
function playAction(kind, opts) {
  const o = opts || {};
  const act = o.voice || VOICE_BY_KIND[kind];
  if (act && playVoice(act, o)) return true;
  const sfx = SFX_BY_KIND[kind];
  if (sfx && o.fallback !== false) return play(sfx, o);
  return false;
}

/**
 * 真正的播放执行器（play / playVoice 共用）。
 *
 * @param key   池子索引（音效用逻辑键，语音用 `v:<文件名>`）
 * @param url   已解析的绝对地址
 * @param volume 期望音量（0~1，调用方已算好）
 * @param opts  { minGap }
 */
function startKey(key, url, volume, opts) {
  if (!url) return false;
  const n = failCounts.get(key) || 0;
  if (n >= 3) {
    if (Date.now() - (failAt.get(key) || 0) > FAIL_RESET_MS) {
      failCounts.delete(key);
      failAt.delete(key);
    } else {
      return false;
    }
  }
  const now = Date.now();
  const gap = opts && opts.minGap ? opts.minGap : 0;
  if (gap) {
    const last = lastPlayed.get(key) || 0;
    if (now - last < gap) return false;
  }
  try {
    const ctx = pool.get(key) || createCtx(key, url);
    if (ctx._mjUrl !== url) {
      ctx.src = url;
      ctx._mjUrl = url;
      ctx._mjPlaying = false;
    }
    ctx.volume = clamp01(volume);
    /*
     * 重触发：**seek(0) 回到开头继续播**，不要 stop()（2026-10-23 修 504）。
     * 微信要求 stop() 必须在 canplay 之后调用；「碰」这类高频音效常在上一次
     * 还没 canplay 时就被再次触发，旧写法 `stop(); play();` 于是稳定报
     * `errCode 504 / error player to stop`。
     * 只有极老基础库没有 seek 时才退回 stop+play，并记下 stop 时刻让 onError 放过噪声。
     */
    if (ctx._mjPlaying) {
      let seeked = false;
      try {
        if (typeof ctx.seek === 'function') {
          ctx.seek(0);
          seeked = true;
        }
      } catch (e) {
        seeked = false;
      }
      if (!seeked) {
        ctx._mjStopAt = Date.now();
        try {
          ctx.stop();
        } catch (e) {
          /* 忽略：状态错误已由 onError 的 400ms 窗口放过 */
        }
        ctx._mjPlaying = false;
      }
    }
    ctx.play();
    lastPlayed.set(key, now);
    return true;
  } catch (e) {
    const n = (failCounts.get(key) || 0) + 1;
    failCounts.set(key, n);
    failAt.set(key, Date.now());
    log('warn', `[sound] 播放 ${key} 异常（第 ${n} 次）：${(e && e.message) || e}`);
    return false;
  }
}

function clamp01(v) {
  const n = Number(v);
  if (!isFinite(n)) return 1;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * 播一个音效。返回是否真的播了（未就绪 / 已静音 / 连续失败 3 次 → false）。
 * 同一键连播不叠音：只在**已经播过**时 seek 回 0 再播（见 startKey）。
 * `opts.minGap`（ms）：同键最小播放间隔 —— 发牌是**逐张广播**的（13 张 = 13 次 view），
 * 不节流会连响 13 下；调用处给 deal 传 250。
 * 音量：默认取音效音量（sfxVolume）；`opts.volume` 显式覆盖时**不再乘** sfxVolume
 * （unlock 的 0.01 探针就靠这一点）。
 */
function play(key, opts) {
  if (!enabled || !sfxEnabled) return false;
  let url = urlOf(key);
  if (!url) {
    ensure();
    url = urlOf(key); // 兜底清单在 ensure() 里同步置 ready，首次操作也能响
    if (!url) {
      log('warn', `[sound] 未就绪，跳过 ${key}（base 为空）`);
      return false;
    }
  }
  const vol = opts && opts.volume !== undefined ? opts.volume : sfxVolume;
  return startKey(key, url, vol, opts);
}

function createCtx(key, url) {
  const ctx = wx.createInnerAudioContext();
  ctx.obeyMuteSwitch = false; // 静音键不掐断游戏音效
  ctx.src = url;
  ctx._mjUrl = url;
  /**
   * 是否**确实在播**：只认 onPlay / onEnded / onStop 三个事件，**绝不乐观置位**。
   * 早期版本在 `play()` 之后立刻置 true，于是「还没 canplay 就再次触发」会走到
   * `stop()` —— 微信要求 stop 必须在 canplay 之后调，否则原生播放器直接报
   * `errCode 504 / error player to stop`（用户 2026-10-23 贴的正是这条，
   * 与域名配置无关）。
   */
  ctx._mjPlaying = false;
  /** 最近一次**我们自己**调 stop() 的时刻：用于放过随之而来的状态噪声 */
  ctx._mjStopAt = 0;
  ctx.onPlay(() => {
    ctx._mjPlaying = true;
    failCounts.delete(key);
    failAt.delete(key);
  });
  ctx.onStop(() => {
    ctx._mjPlaying = false;
  });
  ctx.onEnded(() => {
    ctx._mjPlaying = false;
  });
  ctx.onError((err) => {
    ctx._mjPlaying = false;
    const code = (err && err.errCode) || 0;
    const msg = (err && err.errMsg) || 'unknown';
    // ① 我们自己 stop 之后 400ms 内的报错 = 播放器状态噪声，不计数（否则连点几次就永久静音）
    if (Date.now() - (ctx._mjStopAt || 0) < 400) {
      log('info', `[sound] ${key} 停止时的状态噪声（${code} ${msg}）→ 忽略`);
      return;
    }
    // ② 504 / "error player to stop" 是**播放器状态错误**（未 canplay 就 stop），
    //    不是域名/网络问题 —— 既不计数也不建议改域名，免得被误导去查域名配置。
    if (code === 504 || /player to stop/i.test(msg)) {
      log('warn', `[sound] ${key} 播放器状态异常（${code} ${msg}）→ 不计入失败；持续无声再看 errCode 10002/10003`);
      return;
    }
    const n = (failCounts.get(key) || 0) + 1;
    failCounts.set(key, n);
    failAt.set(key, Date.now());
    const hint =
      code === 10001 || code === 10002
        ? '（网络/域名：检查 downloadFile 合法域名是否含音频域名）'
        : '（文件/格式：确认 public/sound 已部署且为 mp3）';
    log('warn', `[sound] 播放失败 ${key}（第 ${n} 次）：errCode ${code} ${msg}${hint}`);
  });
  pool.set(key, ctx);
  return ctx;
}

/**
 * iOS 解锁：音频会话要在用户交互后才能播。
 * **清单没就绪时不能把 unlocked 置 true** —— 否则首次点牌太早会永久失去解锁机会。
 * 每次用户交互都可以重复调；真正 play 成功后才算解锁。
 */
function unlock() {
  if (!enabled) return;
  if (unlocked) return;
  let url = urlOf('click');
  if (!url) {
    ensure();
    url = urlOf('click');
  }
  if (!url) {
    log('info', '[sound] 解锁等待清单就绪…');
    return;
  }
  try {
    const ctx = wx.createInnerAudioContext();
    ctx.obeyMuteSwitch = false;
    ctx.volume = 0.01; // 0 音量在部分 iOS 上不算解锁，留一点底噪
    ctx.src = url;
    ctx.onError(() => {
      unlocked = false;
      try {
        ctx.destroy();
      } catch (e) {
        /* 忽略 */
      }
    });
    ctx.play();
    unlocked = true;
    failCounts.clear(); // 解锁前被 iOS 拦下的播放失败不算数，解锁后重新给每个键机会
    failAt.clear();
    /*
     * 首次手势**补起**BGM（iOS 无手势会被拦）：只补「已经被场景要求过的」——
     * 局内看 bgmWanted（对局页 bgmStart 置位、退局 bgmStop 清掉），局外看 outBgmWanted。
     * 不能无条件 bgmStart：设置面板在首页/大厅打开也会走到 unlock()（settings.panel.open
     * 顺手解锁音频会话），旧写法把**局内** BGM 在局外拉起来，与局外 BGM 叠着放
     * （2026-11-05 用户报「局外在放局内背景音乐」；此后局内/局外任一开关看起来
     * 都「关不干净」，其实是两首叠着各关各的）。顺带补上局外的手势重试：
     * 此前 unlock 只管局内，iOS 首进大厅若被拦，局外 BGM 要等到下一次场景切换才响。
     */
    if (bgmWanted) bgmStart();
    if (outBgmWanted) outBgmStart();
    setTimeout(() => {
      try {
        ctx.destroy();
      } catch (e) {
        /* 忽略 */
      }
    }, 500);
  } catch (e) {
    unlocked = false;
    /* 解锁失败不影响后续 */
  }
}

/**
 * 背景音乐：循环播放，进局开始、退局停止、切后台暂停。
 * 与音效共用 `mj-sound` 清单/兜底地址；iOS 首次播放仍需用户手势，
 * 所以 `onShow` 先试一次，失败时 `unlock()` 会在首个手势里再起。
 * **`bgmWanted` 只记「本局要不要 BGM」，与用户开关 `bgmEnabled` 分开**：
 * 开关关掉时仍然置 wanted=true（这样在开关里重新打开就能立刻续播），
 * 但不创建 / 不播放实例。
 */
function bgmStart() {
  bgmWanted = true;
  if (!enabled || !bgmEnabled) return;
  let url = urlOf('bgm');
  if (!url) {
    ensure();
    url = urlOf('bgm');
  }
  if (!url) return;
  try {
    if (!bgmCtx) {
      const ctx = wx.createInnerAudioContext();
      bgmCtx = ctx;
      ctx.loop = true;
      ctx.obeyMuteSwitch = false;
      ctx.volume = bgmVolume;
      ctx.src = url;
      ctx._mjUrl = url;
      ctx.onPlay(() => {
        bgmPlaying = true;
      });
      ctx.onPause(() => {
        bgmPlaying = false;
      });
      ctx.onStop(() => {
        bgmPlaying = false;
      });
      ctx.onEnded(() => {
        bgmPlaying = false;
        if (bgmWanted && enabled) {
          try {
            ctx.play();
          } catch (e) {
            /* 忽略 */
          }
        }
      });
      ctx.onError((err) => {
        bgmPlaying = false;
        log('warn', `[sound] 背景音乐失败：${(err && err.errMsg) || 'unknown'}（检查 downloadFile 合法域名/文件是否部署）`);
        if (bgmCtx === ctx) bgmCtx = null;
        try {
          ctx.destroy();
        } catch (e) {
          /* 忽略 */
        }
      });
    } else if (bgmCtx._mjUrl !== url) {
      bgmCtx.src = url;
      bgmCtx._mjUrl = url;
      bgmPlaying = false;
    }
    if (!bgmPlaying) bgmCtx.play();
  } catch (e) {
    bgmPlaying = false;
    log('warn', `[sound] 背景音乐异常：${(e && e.message) || e}`);
  }
}

/** 切后台/离开页面：暂停但保留“想播”状态，回来继续 */
function bgmPause() {
  if (!bgmCtx) return;
  try {
    bgmCtx.pause();
  } catch (e) {
    /* 忽略 */
  }
}

/** 退局：停止并释放背景音乐实例 */
function bgmStop() {
  bgmWanted = false;
  if (!bgmCtx) return;
  const ctx = bgmCtx;
  bgmCtx = null;
  bgmPlaying = false;
  try {
    ctx.stop();
  } catch (e) {
    /* 忽略 */
  }
  try {
    ctx.destroy();
  } catch (e) {
    /* 忽略 */
  }
}

/* ---------------- 局外背景音乐（2026-11-04） ---------------- */

/**
 * 局外曲目的落盘地址。**当前曲目 → 默认曲目**（没部署这首就退「蒙德的月光」），
 * 都没有返回空串。地址带 `bgmOutVer`：换曲子只让这一组三个文件缓存失效，
 * 不牵连局内那 1MB 的 bgm.mp3。
 */
function outBgmUrl() {
  if (status !== 'ready' || !state) return '';
  const map = state.bgmOut || DEFAULT_OUT_BGM;
  let name = map[outBgmTrack];
  if (!name) name = map[DEFAULT_OUT_BGM_TRACK];
  if (!name) return '';
  return `${state.base}/sound/${name}?v=${state.bgmOutVer || state.version}`;
}

/**
 * 起局外 BGM。`force` = 试听用（不受局外 BGM 开关约束，但仍受总开关与音量约束）。
 *
 * 与局内 BGM 一样：实例独立、循环播放、静音键不掐断；`unlock()` 的手势解锁对它同样有效
 * （iOS 无手势不响）。整曲要先下完才播，所以**进首页/大厅就起**，别等用户点按钮。
 */
function outBgmStart(force) {
  outBgmWanted = true;
  if (!enabled) return;
  if (!outBgmEnabled && !force) return;
  let url = outBgmUrl();
  if (!url) {
    ensure();
    url = outBgmUrl();
  }
  if (!url) return;
  try {
    if (!outBgmCtx) {
      const ctx = wx.createInnerAudioContext();
      outBgmCtx = ctx;
      ctx.loop = true; // 整曲放完自动重播（背景音乐常规行为）
      ctx.obeyMuteSwitch = false; // 静音键不掐断游戏音乐
      ctx.volume = outBgmVolume;
      ctx.src = url;
      ctx._mjUrl = url;
      ctx.onPlay(() => {
        outBgmPlaying = true;
      });
      ctx.onPause(() => {
        outBgmPlaying = false;
      });
      ctx.onStop(() => {
        outBgmPlaying = false;
      });
      ctx.onEnded(() => {
        outBgmPlaying = false;
        if (outBgmWanted && enabled) {
          try {
            ctx.play();
          } catch (e) {
            /* 忽略 */
          }
        }
      });
      ctx.onError((err) => {
        outBgmPlaying = false;
        log('warn', `[sound] 局外 BGM 失败：${(err && err.errMsg) || 'unknown'}（检查 downloadFile 合法域名/文件是否部署）`);
        if (outBgmCtx === ctx) outBgmCtx = null;
        try {
          ctx.destroy();
        } catch (e) {
          /* 忽略 */
        }
      });
    } else if (outBgmCtx._mjUrl !== url) {
      // 换了曲目：换 src（会重新下载 → 有延迟，属预期）
      outBgmCtx.src = url;
      outBgmCtx._mjUrl = url;
      outBgmPlaying = false;
    }
    if (!outBgmPlaying) outBgmCtx.play();
  } catch (e) {
    outBgmPlaying = false;
    log('warn', `[sound] 局外 BGM 异常：${(e && e.message) || e}`);
  }
}

/** 切后台/离开页面：暂停但保留「想播」状态，回来继续 */
function outBgmPause() {
  if (!outBgmCtx) return;
  try {
    outBgmCtx.pause();
  } catch (e) {
    /* 忽略 */
  }
}

/** 离开局外（进对局页/退房）：停止并释放实例（与局内 BGM 互斥，不能同时响） */
function outBgmStop() {
  outBgmWanted = false;
  if (!outBgmCtx) return;
  const ctx = outBgmCtx;
  outBgmCtx = null;
  outBgmPlaying = false;
  try {
    ctx.stop();
  } catch (e) {
    /* 忽略 */
  }
  try {
    ctx.destroy();
  } catch (e) {
    /* 忽略 */
  }
}

/** 局外 BGM 开关（独立于局内 BGM 与音效/语音） */
function setOutBgmEnabled(v) {
  outBgmEnabled = !!v;
  if (!outBgmEnabled) {
    outBgmPause();
  } else if (outBgmWanted) {
    outBgmStart();
  }
  return outBgmEnabled;
}

/** 局外 BGM 音量（0~1）。正在播就立刻生效 */
function setOutBgmVolume(v) {
  outBgmVolume = clamp01(v);
  if (outBgmCtx) {
    try {
      outBgmCtx.volume = outBgmVolume;
    } catch (e) {
      /* 忽略 */
    }
  }
  return outBgmVolume;
}

/**
 * 切换局外曲目。传了不认识的值 → 退回默认曲目（蒙德的月光），
 * 这样「本地存了个旧版本才有的曲目名」不会让人变成哑巴。
 *
 * 切曲**不调 stop()**：整曲要重新下载，停掉再起可能撞 504；直接换 src 让播放器自己切。
 */
function setOutBgmTrack(id) {
  const next = OUT_BGM_TRACKS.some((t) => t.id === id) ? id : DEFAULT_OUT_BGM_TRACK;
  const changed = next !== outBgmTrack;
  outBgmTrack = next;
  if (changed) {
    if (outBgmCtx) {
      const url = outBgmUrl();
      if (url) {
        try {
          outBgmCtx.src = url;
          outBgmCtx._mjUrl = url;
          outBgmPlaying = false;
          if (outBgmWanted) outBgmCtx.play();
        } catch (e) {
          /* 忽略 */
        }
      }
    } else if (outBgmWanted) {
      outBgmStart();
    }
  }
  return outBgmTrack;
}

/**
 * 试听当前局外曲目（设置面板用）：**不受局外 BGM 开关影响** ——
 * 用户点试听就是要听，哪怕他现在把局外音乐关了。仍受总开关与音量约束。
 * 整曲 1.6~2.3MB → 首次试听要等下载，属预期。
 */
function previewOutBgm() {
  if (!enabled) return false;
  // 局内 BGM 正在响 → 不试听局外曲目：两套音乐同时响是噪音，不是预览
  if (bgmCtx && bgmPlaying) {
    log('info', '[sound] 局内 BGM 在响 → 跳过局外曲目试听（两套音乐会同时响）');
    return false;
  }
  outBgmStart(true);
  return !!outBgmCtx;
}

/**
 * 新语义（2026-11-04）：`enabled` = **游戏总开关**（总音乐）。关掉 = 一切声音停，
 * 等价设置面板里的「游戏声音」。三个子开关（音效/背景音乐/语音）各自独立。
 *
 * ⚠ 本模块**不再写任何存储** —— 持久化统一由 utils/settings.js 负责（单一真相源，
 * 避免「面板改了没存」和「存了没生效」两条不一致的路径）。这里只改运行期状态。
 * 老调用方若直接调 setEnabled/setBgmEnabled，只影响本次会话（下次启动回到设置面板里的值），
 * 这是刻意的：声音偏好本该只有一个入口。
 */
function setEnabled(v) {
  enabled = !!v;
  if (!enabled) {
    stopAll();
    bgmPause();
    outBgmPause();
  } else {
    failCounts.clear();
    failAt.clear();
    if (bgmWanted) bgmStart();
    if (outBgmWanted) outBgmStart();
  }
  return enabled;
}

/** 停掉所有在播的音效/语音实例（总开关关闭、切换语音包时用） */
function stopAll() {
  for (const ctx of pool.values()) {
    // 只停「确实在播」的实例：未 canplay 就 stop 会触发 504 状态错误
    if (!ctx._mjPlaying) continue;
    ctx._mjStopAt = Date.now();
    try {
      ctx.stop();
    } catch (e) {
      /* 忽略：状态错误已由 onError 的 400ms 窗口放过 */
    }
    ctx._mjPlaying = false;
  }
}

/**
 * 背景音乐开关（独立于音效/语音，持久化在 settings）。
 *
 * 关 → 立即暂停：**保留实例与播放进度**，重新打开时瞬间续播、不重下载 1MB 音频；
 * 开 → 本局希望有 BGM（bgmWanted）就立刻续播（iOS 若还没被手势解锁，
 *      调用方应先 `unlock()`；本轮 UI 的切换手势本身就会解锁）。
 * 返回切换后的状态，便于 UI 直接 setData。
 */
function setBgmEnabled(v) {
  bgmEnabled = !!v;
  if (!bgmEnabled) {
    bgmPause();
  } else if (bgmWanted && enabled) {
    bgmStart();
  }
  return bgmEnabled;
}

/** 背景音乐音量（0~1）。正在播就立刻生效，不必等下一局 */
function setBgmVolume(v) {
  bgmVolume = clamp01(v);
  if (bgmCtx) {
    try {
      bgmCtx.volume = bgmVolume;
    } catch (e) {
      /* 忽略 */
    }
  }
  return bgmVolume;
}

/** 音效开关（出牌/发牌/点击这类无人声反馈）。关掉后 play() 直接返回 false */
function setSfxEnabled(v) {
  sfxEnabled = !!v;
  return sfxEnabled;
}

/** 音效音量（0~1）。下一次播放生效（已在播的短音效没必要追着改） */
function setSfxVolume(v) {
  sfxVolume = clamp01(v);
  return sfxVolume;
}

/**
 * 语音播报开关。关掉后 playAction 全部退原音效 —— 不是静音，
 * 因为「关了人声」不等于「打牌没反馈」，这是两件事。
 */
function setVoiceEnabled(v) {
  voiceEnabled = !!v;
  return voiceEnabled;
}

/** 语音音量（0~1） */
function setVoiceVolume(v) {
  voiceVolume = clamp01(v);
  return voiceVolume;
}

/**
 * 切换语音包（n1/n2/w1/w2）。返回实际生效的包 —— 传了不认识的值就退回默认 n2，
 * 这样「本地存了个旧版本才有的包名」不会让人变成哑巴。
 * 切包要**清掉在播的语音实例**：它们绑定的是旧包的文件，留着只是占内存。
 */
function setVoicePack(id) {
  const next = VOICE_PACKS.some((p) => p.id === id) ? id : DEFAULT_VOICE_PACK;
  const changed = next !== voicePack;
  voicePack = next;
  if (changed) {
    for (const [k, ctx] of pool) {
      if (!k.startsWith('v:')) continue;
      if (ctx._mjPlaying) {
        ctx._mjStopAt = Date.now();
        try {
          ctx.stop();
        } catch (e) {
          /* 忽略 */
        }
      }
      try {
        ctx.destroy();
      } catch (e) {
        /* 忽略 */
      }
      pool.delete(k);
      failCounts.delete(k);
      failAt.delete(k);
    }
  }
  return voicePack;
}

/**
 * 一次性下发全部偏好（utils/settings.js 在启动/改动时调用）。
 * 这是本模块与设置面板之间**唯一**的接口，参数缺项保持原值。
 */
function applyPrefs(p) {
  const o = p || {};
  prefsBound = true; // 从此不再回读旧存储键
  if (o.master !== undefined) setEnabled(o.master);
  if (o.bgm) {
    if (o.bgm.on !== undefined) setBgmEnabled(o.bgm.on);
    if (o.bgm.volume !== undefined) setBgmVolume(o.bgm.volume);
  }
  // 局外 BGM：与局内**分开**的一组（开关 / 音量 / 曲目各管各的）
  if (o.bgmOut) {
    if (o.bgmOut.on !== undefined) setOutBgmEnabled(o.bgmOut.on);
    if (o.bgmOut.volume !== undefined) setOutBgmVolume(o.bgmOut.volume);
    if (o.bgmOut.track !== undefined) setOutBgmTrack(o.bgmOut.track);
  }
  if (o.sfx) {
    if (o.sfx.on !== undefined) setSfxEnabled(o.sfx.on);
    if (o.sfx.volume !== undefined) setSfxVolume(o.sfx.volume);
  }
  if (o.voice) {
    if (o.voice.on !== undefined) setVoiceEnabled(o.voice.on);
    if (o.voice.volume !== undefined) setVoiceVolume(o.voice.volume);
    if (o.voice.pack !== undefined) setVoicePack(o.voice.pack);
  }
  return snapshot();
}

/** 当前生效的偏好快照（面板渲染 + debug 用） */
function snapshot() {
  return {
    master: enabled,
    bgm: { on: bgmEnabled, volume: bgmVolume },
    bgmOut: { on: outBgmEnabled, volume: outBgmVolume, track: outBgmTrack },
    sfx: { on: sfxEnabled, volume: sfxVolume },
    voice: { on: voiceEnabled, volume: voiceVolume, pack: voicePack },
  };
}

/**
 * 试听一条语音（设置面板用）：绕过节流、不受「语音关」影响
 * —— 用户点试听就是要听，哪怕他现在把语音关着（关着就没法判断音色好不好）。
 * 仍受总开关与语音音量约束。
 */
function preview(action) {
  const act = action || 'peng';
  if (!enabled) return false;
  let hit = resolveVoice(act);
  if (!hit) {
    ensure();
    hit = resolveVoice(act);
  }
  if (!hit) {
    log('warn', `[sound] 试听失败：${act} 在包 ${voicePack}/默认包都没有文件`);
    return false;
  }
  const key = 'v:' + hit.name;
  failCounts.delete(key); // 试听是显式操作，把之前的连败计数清掉再给一次机会
  failAt.delete(key);
  return startKey(key, hit.url, voiceVolume, {});
}

/** 切换背景音乐开关并返回切换后的状态 */
function toggleBgm() {
  return setBgmEnabled(!bgmEnabled);
}

module.exports = {
  ensure,
  play,
  playVoice,
  playAction,
  preview,
  unlock,
  bgmStart,
  bgmPause,
  bgmStop,
  outBgmStart,
  outBgmPause,
  outBgmStop,
  setEnabled,
  setBgmEnabled,
  setBgmVolume,
  setOutBgmEnabled,
  setOutBgmVolume,
  setOutBgmTrack,
  previewOutBgm,
  setSfxEnabled,
  setSfxVolume,
  setVoiceEnabled,
  setVoiceVolume,
  setVoicePack,
  applyPrefs,
  snapshot,
  toggleBgm,
  urlOf,
  /** 语音包定义（给设置面板渲染，避免面板里再写一份中文映射） */
  VOICE_PACKS,
  DEFAULT_VOICE_PACK,
  /** 局外曲目定义（给设置面板渲染） */
  OUT_BGM_TRACKS,
  DEFAULT_OUT_BGM_TRACK,
  isEnabled: () => enabled,
  isBgmEnabled: () => bgmEnabled,
  isOutBgmEnabled: () => outBgmEnabled,
  outBgmTrack: () => outBgmTrack,
  isVoiceEnabled: () => voiceEnabled,
  voicePack: () => voicePack,
  ready: () => status === 'ready',
  /** 某套包当前有几条语音可用（面板上提示「这套包缺 2 条」用；清单没回来返回 -1） */
  voiceCount(pack) {
    if (status !== 'ready' || !state) return -1;
    const row = (state.voices || {})[pack || voicePack];
    return row ? Object.keys(row).length : 0;
  },
  debug() {
    const fails = {};
    for (const [k, n] of failCounts) fails[k] = n;
    return {
      status,
      enabled,
      unlocked,
      version: state ? state.version : '',
      base: state ? state.base : '',
      count: state ? Object.keys(state.sounds).length : 0,
      retries,
      failed: fails,
      bgm: { enabled: bgmEnabled, wanted: bgmWanted, playing: bgmPlaying, volume: bgmVolume },
      outBgm: {
        enabled: outBgmEnabled,
        wanted: outBgmWanted,
        playing: outBgmPlaying,
        volume: outBgmVolume,
        track: outBgmTrack,
        tracks: state ? Object.keys(state.bgmOut || {}) : [],
        ver: state ? state.bgmOutVer : '',
      },
      voice: {
        enabled: voiceEnabled,
        pack: voicePack,
        volume: voiceVolume,
        packs: state ? Object.keys(state.voices || {}) : [],
        ver: state ? state.voiceVer : '',
      },
      sfx: { enabled: sfxEnabled, volume: sfxVolume },
    };
  },
};
