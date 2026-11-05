/**
 * 声音设置面板（画布版，2026-11-04）—— 对位小程序 `templates/settings.wxml` + app.wxss 的 `.set-*`。
 *
 * 为什么是独立模块而不是塞进 chrome.js：
 *   chrome.js 是「对局页 chrome」（顶栏/侧轨/操作带），而设置面板**三个场景都要**（game /
 *   lobby / home）。放 chrome 里会让 lobby/home 反向依赖对局页的 UI 模块；抽出来则是
 *   三处共用一份实现，与小程序端「一份模板三页复用」同构。
 *
 * 三个刻意的设计：
 *   ① **布局是纯函数**（`layout(L)`，不读 ctx、不量文本）。命中矩形每帧现算，不缓存到
 *      `s.ui` 上 —— 项目里踩过「浮层按钮矩形跨帧残留 → 看不见的按钮劫持点击」
 *      （见 chrome.js render 里 u.layerBtns 那段注释），纯布局从根上不会出现陈旧矩形；
 *      代价是面板里的文字一律按固定宽度排版，不做「按文本量宽」的自适应。
 *   ② **值的真相源是 utils/settings.js**，面板自己不存一份。拖动滑条时用一个临时
 *      `s._setDrag` 覆盖显示（否则滑条会在手里「弹回旧位置」），松手才落盘
 *      —— 与小程序端 bindchanging/bindchange 的分工完全一致。
 *   ③ **局内/局外背景音乐是两条独立的行**（2026-11-04）：局内那首在对局页放，局外那首在
 *      首页/大厅放 —— 各自独立开关 + 独立音量。**下面两条选项带也各自独立**：
 *      「语音音色」与局内外音乐**毫无关系**（音色不区分局内外），「局外曲目」只管局外音乐。
 *      早期版本用「局内/局外」分段钮复用同一行 + 复用同一条选项带，结果切音乐时语音音色
 *      也跟着变 —— 概念串了，已改回各占各的位置。
 *
 * 交互约定（与 chrome 一致）：down 记按下 id、tap 分发、up 提交拖动。
 * 面板在屏时 **吞掉一切触摸**（返回 true），不会漏给牌桌/侧轨。
 */

const draw = require('./draw.js');
const btn = require('./btn.js');
const layoutBase = require('../layout.js');
const settings = require('../../utils/settings.js');
const sound = require('../../utils/sound.js');

const { C } = draw;

/* ---------------- 尺寸（屏幕 px；横屏手机可用高 ~320，必须紧凑） ---------------- */
/*
 * 面板塞了两条音乐行 + 两条选项带，总高 ~308px —— 320px 高的屏只剩 12px 余量。
 * 所以每个尺寸都压到「刚好放得下」：行 26、格子 28、标题 22、底栏 26。
 * ⚠ 再加任何一行/一条带都必须重新算这个预算（画布面板**不能滚动**，长了就溢出屏）。
 */
const PAD = 8;
const TITLE_H = 22;
const ROW_H = 26;
/** 左侧标签列宽（固定，不量文本：见文件头「布局是纯函数」）——所有行共用，开关上下对齐 */
const LABEL_W = 62;
const SW_W = 34;
const SW_H = 18;
const SEP_H = 6;
const PACK_HEAD_H = 12;
const PACK_H = 28;
const PACK_GAP = 6;
const WARN_H = 12;
const FOOT_H = 26;
const KNOB = 12;
const GAP = 4;
const CLOSE = 20;

/** 语音包按钮（顺序同 utils/sound.js 的 VOICE_PACKS，颜色/文案都在那边） */
const PACKS = sound.VOICE_PACKS;
/** 局外曲目按钮（顺序同 utils/sound.js 的 OUT_BGM_TRACKS） */
const TRACKS = sound.OUT_BGM_TRACKS;

/** 当前是否开着（场景侧唯一需要的判断） */
function isOpen(s) {
  return !!(s && s.settingsShown);
}

/**
 * 提交/实时值的读取：拖动中先用临时值，否则读已落盘的设置。
 * `s._setDrag = { id, value }`，id 形如 'bgm.vol' / 'bgmOut.vol'。
 */
function volOf(st, s, id, key) {
  if (s && s._setDrag && s._setDrag.id === id) return s._setDrag.value;
  const seg = st[key];
  return seg.volume;
}

/**
 * 提示行文案（为空 = 不占高度）。两种，**缺条优先**：
 *   · 当前音色缺条目 → 客户端会退默认包，必须告诉用户「缺的会用默认音色补」
 *     （这是功能性限制，比「总开关关着」更需要被看见）；
 *   · 总开关关 → 解释为什么没声（面板此时整体压暗，本身已经暗示了）。
 */
function warnText(st) {
  const n = sound.voiceCount(st.voice.pack);
  if (n >= 0 && n < 9) return `当前音色只有 ${n}/9 条语音，缺的用默认音色补`;
  if (!st.master && (st.voice.on || st.bgm.on || st.bgmOut.on)) return '总开关关闭时听不到声音';
  return '';
}

/**
 * 一排选项格（语音音色 / 局外曲目共用）。
 * `items` 来自 utils/sound.js（VOICE_PACKS / OUT_BGM_TRACKS），`activeId` 是当前选中项。
 */
function chipRow(items, activeId, cardX, iw, y) {
  const chipW = (iw - PACK_GAP * (items.length - 1)) / items.length;
  return items.map((p, i) => ({
    id: p.id,
    label: p.label,
    desc: p.desc,
    active: p.id === activeId,
    rect: { x: cardX + PAD + i * (chipW + PACK_GAP), y, w: chipW, h: PACK_H },
  }));
}

/**
 * 纯几何布局。所有矩形都是屏幕坐标（与触摸同系）。
 */
function layout(L) {
  const st = settings.get();
  const cardW = Math.min(L.sw - 24, 520);
  const iw = cardW - PAD * 2;
  const warn = warnText(st);
  const cardH =
    PAD +
    TITLE_H +
    ROW_H +
    SEP_H +
    ROW_H * 4 +
    GAP +
    (PACK_HEAD_H + 4 + PACK_H) * 2 +
    (warn ? WARN_H : 0) +
    GAP +
    FOOT_H +
    PAD;
  const cardX = Math.round((L.sw - cardW) / 2);
  const cardY = Math.max(4, Math.round((L.sh - cardH) / 2));
  const card = { x: cardX, y: cardY, w: cardW, h: cardH };

  let y = cardY + PAD;
  const title = { x: cardX + PAD, y, w: iw - CLOSE - GAP, h: TITLE_H };
  const close = { x: cardX + cardW - PAD - CLOSE, y: y + (TITLE_H - CLOSE) / 2, w: CLOSE, h: CLOSE };
  y += TITLE_H;

  // 行内水平锚：所有开关对齐在同一条竖线上（主子项视觉一致）
  const swX = cardX + PAD + LABEL_W;
  const valW = 32;
  const trackX = swX + SW_W + 10;
  const trackW = Math.max(40, cardX + cardW - PAD - valW - 4 - trackX);

  /** 一行：[标签][开关][滑条][数值] */
  const sliderRow = (rowY) => ({
    label: { x: cardX + PAD, y: rowY, w: LABEL_W, h: ROW_H },
    sw: { x: swX, y: rowY + (ROW_H - SW_H) / 2, w: SW_W, h: SW_H },
    // 滑条的触摸带比视觉轨道高：手指要能稳稳落在 4px 轨道上
    track: { x: trackX, y: rowY + (ROW_H - 16) / 2, w: trackW, h: 16 },
    valX: cardX + cardW - PAD,
    row: { x: cardX + PAD, y: rowY, w: iw, h: ROW_H },
  });

  // 总开关：右侧留出说明文字，开关仍在 swX（与下面四行对齐）
  const master = {
    row: { x: cardX + PAD, y, w: iw, h: ROW_H },
    sw: { x: swX, y: y + (ROW_H - SW_H) / 2, w: SW_W, h: SW_H },
    hintX: swX + SW_W + 10,
  };
  y += ROW_H + SEP_H / 2;

  // 四行：局内音乐 / 局外音乐 / 音效 / 语音播报（局内外两条**各自独立**）
  const bgm = sliderRow(y); // 局内（对局页放）
  y += ROW_H;
  const bgmOut = sliderRow(y); // 局外（首页/大厅放）
  y += ROW_H;
  const sfx = sliderRow(y);
  y += ROW_H;
  const voice = sliderRow(y);
  y += ROW_H + GAP;

  // 选项带 ①：语音音色 —— 与局内外音乐**无关**，始终显示
  const packsHead = { x: cardX + PAD, y, w: iw, h: PACK_HEAD_H };
  y += PACK_HEAD_H + 4;
  const packs = chipRow(PACKS, st.voice.pack, cardX, iw, y);
  y += PACK_H;

  // 选项带 ②：局外曲目 —— 只管局外音乐放哪首
  const tracksHead = { x: cardX + PAD, y, w: iw, h: PACK_HEAD_H };
  y += PACK_HEAD_H + 4;
  const tracks = chipRow(TRACKS, st.bgmOut.track, cardX, iw, y);
  y += PACK_H;

  const warnRect = warn ? { x: cardX + PAD, y: y + 2, w: iw, h: WARN_H, text: warn } : null;
  if (warn) y += WARN_H;
  y += GAP;

  const btnW = (iw - GAP * 2) / 3;
  const foot = [
    { id: 'preview', label: '试听', rect: { x: cardX + PAD, y, w: btnW, h: FOOT_H } },
    { id: 'reset', label: '恢复默认', rect: { x: cardX + PAD + btnW + GAP, y, w: btnW, h: FOOT_H } },
    { id: 'close', label: '完成', kind: 'primary', rect: { x: cardX + PAD + (btnW + GAP) * 2, y, w: btnW, h: FOOT_H } },
  ];

  return { st, card, title, close, master, bgm, bgmOut, sfx, voice, packsHead, packs, tracksHead, tracks, warnRect, foot };
}

/* ---------------- 绘制 ---------------- */

/** 开关（.set-switch 的 canvas 对位：34×18px 胶囊 + 12px 圆钮） */
function drawSwitch(ctx, r, on, disabled) {
  ctx.save();
  if (disabled) ctx.globalAlpha = 0.4;
  ctx.fillStyle = on ? C.gold : 'rgba(255,255,255,0.16)';
  draw.roundRect(ctx, r.x, r.y, r.w, r.h, r.h / 2);
  ctx.fill();
  ctx.strokeStyle = on ? 'rgba(246,227,161,0.8)' : 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.stroke();
  const kx = on ? r.x + r.w - KNOB / 2 - 3 : r.x + KNOB / 2 + 3;
  ctx.fillStyle = on ? '#1a2b22' : '#e8efe9';
  ctx.beginPath();
  ctx.arc(kx, r.y + r.h / 2, KNOB / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * 滑条可用的「钮心行程」：两端各内缩半个钮半径。
 * 不内缩时 v=1 的钮会压在右侧百分比文字上、v=0 的钮会越出轨道左端
 * （实测 100% 那格钮与「100%」贴死）。绘制与取值共用这一份，位置才与数值一致。
 */
function knobRange(track) {
  const l = track.x + KNOB / 2;
  const r = track.x + track.w - KNOB / 2;
  return [l, Math.max(l + 1, r)];
}

/** 滑条（.set-slider：4px 轨道 + 12px 圆钮；disabled 时整体压暗） */
function drawSlider(ctx, track, v, disabled) {
  ctx.save();
  if (disabled) ctx.globalAlpha = 0.4;
  const cy = track.y + track.h / 2;
  const left = track.x;
  const [kl, kr] = knobRange(track);
  const kx = kl + (kr - kl) * v;
  // 轨道
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  draw.roundRect(ctx, left, cy - 2, track.w, 4, 2);
  ctx.fill();
  // 已选段
  ctx.fillStyle = C.gold;
  draw.roundRect(ctx, left, cy - 2, Math.max(0, kx - left), 4, 2);
  ctx.fill();
  // 圆钮
  ctx.fillStyle = '#f6e3a1';
  ctx.beginPath();
  ctx.arc(kx, cy, KNOB / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 一排选项格（语音音色 / 局外曲目共用） */
function drawChips(ctx, chips, dim) {
  for (const p of chips) {
    const on = !!p.active;
    const r = p.rect;
    ctx.save();
    if (dim) ctx.globalAlpha = 0.45;
    ctx.fillStyle = on ? 'rgba(230,193,75,0.16)' : 'rgba(255,255,255,0.05)';
    draw.roundRect(ctx, r.x, r.y, r.w, r.h, 5);
    ctx.fill();
    ctx.strokeStyle = on ? 'rgba(230,193,75,0.75)' : 'rgba(255,255,255,0.12)';
    ctx.stroke();
    draw.text(ctx, p.label, r.x + r.w / 2, r.y + 10, { size: 11, color: on ? C.goldSoft : C.text, align: 'center', bold: on });
    draw.text(ctx, p.desc, r.x + r.w / 2, r.y + 20, { size: 9, color: C.muted, align: 'center', maxW: r.w - 6 });
    ctx.restore();
  }
}

function render(ctx, L, s) {
  if (!isOpen(s)) return;
  const g = layout(L);
  const { st } = g;
  const dim = !st.master; // 总开关关：子项压暗但保留各自的开关状态

  // 遮罩（.layer：rgba(0,0,0,.55) 铺满）
  ctx.fillStyle = C.layerBg;
  ctx.fillRect(0, 0, L.sw, L.sh);

  // 卡片（.layer-card：深底 + 金边）
  ctx.fillStyle = C.layerCard;
  draw.roundRect(ctx, g.card.x, g.card.y, g.card.w, g.card.h, 8);
  ctx.fill();
  ctx.strokeStyle = C.layerBorder;
  ctx.lineWidth = 1;
  ctx.stroke();

  // 标题 + 关闭（✕）
  draw.text(ctx, '声音设置', g.title.x, g.title.y + g.title.h / 2, { size: 14, color: C.goldSoft, bold: true });
  /*
   * 关闭钮**不走 btn.render**：那个函数会按 maxW = w-12 截断文字，
   * 20px 的方钮只剩 8px 可用宽 → 「✕」被截成「✕…」（首版实测如此）。
   * 改用 btn.icon（不做截断的图标方钮，与首页/大厅的 ⚙️ 同一个原语）。
   */
  btn.icon(ctx, g.close, { label: '✕', size: 11, radius: 4, pressed: s.setPressed === 'close' });

  // ① 总开关：标签 + 说明 + 开关
  const cy = (r) => r.y + r.h / 2;
  draw.text(ctx, '游戏声音', g.master.row.x, cy(g.master.row), { size: 12, color: C.text });
  draw.text(ctx, st.master ? '全部声音已开启' : '已全部静音（分项值保留）', g.master.hintX, cy(g.master.row), {
    size: 10,
    color: C.muted,
    maxW: g.card.x + g.card.w - PAD - g.master.hintX - 4,
  });
  drawSwitch(ctx, g.master.sw, st.master, false);

  // 分隔线（.set-sep）
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.beginPath();
  const sepY = g.master.row.y + g.master.row.h + SEP_H / 2;
  ctx.moveTo(g.card.x + PAD, sepY + 0.5);
  ctx.lineTo(g.card.x + g.card.w - PAD, sepY + 0.5);
  ctx.stroke();

  // ②③④ 四行：局内音乐 / 局外音乐 / 音效 / 语音播报
  const rows = [
    { g: g.bgm, key: 'bgm', id: 'bgm', label: '局内音乐' },
    { g: g.bgmOut, key: 'bgmOut', id: 'bgmOut', label: '局外音乐' },
    { g: g.sfx, key: 'sfx', id: 'sfx', label: '音效' },
    { g: g.voice, key: 'voice', id: 'voice', label: '语音播报' },
  ];
  for (const r of rows) {
    const on = st[r.key].on;
    const off = dim || !on;
    draw.text(ctx, r.label, r.g.label.x, cy(r.g.row), { size: 12, color: C.text });
    drawSwitch(ctx, r.g.sw, on, dim);
    const v = volOf(st, s, r.id + '.vol', r.key);
    drawSlider(ctx, r.g.track, v, off);
    draw.text(ctx, Math.round(v * 100) + '%', r.g.valX, cy(r.g.row), { size: 10, color: C.muted, align: 'right' });
  }

  // ⑤ 语音音色：与局内外音乐**无关**，点一下即试听
  draw.text(ctx, '语音音色', g.packsHead.x, g.packsHead.y + g.packsHead.h / 2, { size: 11, color: C.text });
  draw.text(ctx, '点一下即试听', g.packsHead.x + 62, g.packsHead.y + g.packsHead.h / 2, { size: 9, color: C.muted });
  drawChips(ctx, g.packs, dim);

  // ⑥ 局外曲目：只管局外音乐放哪首，点一下即切换
  draw.text(ctx, '局外曲目', g.tracksHead.x, g.tracksHead.y + g.tracksHead.h / 2, { size: 11, color: C.text });
  draw.text(ctx, '点一下即切换', g.tracksHead.x + 62, g.tracksHead.y + g.tracksHead.h / 2, { size: 9, color: C.muted });
  drawChips(ctx, g.tracks, dim);

  // ⑦ 提示行（缺条 / 总开关关）
  if (g.warnRect) {
    draw.text(ctx, g.warnRect.text, g.warnRect.x, g.warnRect.y + g.warnRect.h / 2, {
      size: 10,
      color: '#e8b98a',
      maxW: g.warnRect.w,
    });
  }

  // ⑧ 底部：试听 / 恢复默认 / 完成
  for (const b of g.foot) {
    btn.render(ctx, b.rect, {
      label: b.label,
      kind: b.kind,
      size: 12,
      pressed: s.setPressed === b.id,
    });
  }
}

/* ---------------- 交互 ---------------- */

/** 命中测试：返回 id 或 '' */
function pick(g, x, y) {
  if (draw.hit(g.close, x, y)) return 'close';
  if (draw.hit(g.master.sw, x, y)) return 'master';
  // 四行各自的开关/滑条（局内音乐与局外音乐**各管各的**）
  for (const id of ['bgm', 'bgmOut', 'sfx', 'voice']) {
    const r = g[id];
    if (draw.hit(r.sw, x, y)) return id + '.on';
    if (draw.hit(r.track, x, y)) return id + '.vol';
  }
  for (const p of g.packs) if (draw.hit(p.rect, x, y)) return 'pack:' + p.id;
  for (const p of g.tracks) if (draw.hit(p.rect, x, y)) return 'track:' + p.id;
  for (const b of g.foot) if (draw.hit(b.rect, x, y)) return b.id;
  return '';
}

/** 滑条 x → 0~1（与 drawSlider 的钮心行程同一份，避免「拖到最右却显示 97%」） */
function trackValue(track, x) {
  const [l, r] = knobRange(track);
  const v = (x - l) / Math.max(1, r - l);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 拖动中即时改运行期音量（不落盘；sound 的 setter 本身不写存储） */
function applyLive(id, v) {
  if (id === 'bgm.vol') sound.setBgmVolume(v);
  else if (id === 'bgmOut.vol') sound.setOutBgmVolume(v);
  else if (id === 'sfx.vol') sound.setSfxVolume(v);
  else sound.setVoiceVolume(v);
}

/** 落盘（松手时一次） */
function commit(id, v) {
  if (id === 'bgm.vol') settings.set({ bgm: { volume: v } });
  else if (id === 'bgmOut.vol') settings.set({ bgmOut: { volume: v } });
  else if (id === 'sfx.vol') settings.set({ sfx: { volume: v } });
  else if (id === 'voice.vol') settings.set({ voice: { volume: v } });
}

/**
 * 面板只关心**屏幕**尺寸（卡片居中、与对局 HUD 无关），所以统一用基础布局；
 * 不读场景的 Lg / L —— 免掉「触摸时布局还没算过」的先后问题。
 */
function screenLayout() {
  return layoutBase.compute();
}

/**
 * 按下。返回 false = 面板没开（调用方继续走常规分发）；true = 已消费（含面板内空白）。
 * 滑条在这里就**立即跳值**（点哪到哪），拖动由 move 继续，up 落盘。
 */
function down(x, y, s) {
  if (!isOpen(s)) return false;
  const g = layout(screenLayout());
  const id = pick(g, x, y);
  s.setPressed = id;
  if (id && id.indexOf('.vol') > 0) {
    const key = id.split('.')[0];
    const v = trackValue(g[key].track, x);
    s._setDrag = { id, value: v };
    applyLive(id, v);
  }
  return true;
}

/** 拖动。返回 true = 已消费 */
function move(x, y, s) {
  if (!isOpen(s)) return false;
  const d = s._setDrag;
  if (!d) return true; // 面板在屏，手指划空白也不许漏给牌桌
  const g = layout(screenLayout());
  const key = d.id.split('.')[0];
  d.value = trackValue(g[key].track, x);
  applyLive(d.id, d.value);
  return true;
}

/** 抬起。返回 true = 已消费 */
function up(s) {
  if (!isOpen(s)) return false;
  const d = s._setDrag;
  s._setDrag = null;
  s.setPressed = '';
  if (d) commit(d.id, d.value);
  return true;
}

/** 点按分发。返回 true = 已消费（面板在屏时恒 true，遮罩不关闭） */
function tap(x, y, s) {
  if (!isOpen(s)) return false;
  const g = layout(screenLayout());
  const id = pick(g, x, y);
  if (!id) {
    // 点弹框外（遮罩）→ 关闭面板；卡内空白仍只是吞掉点击，不透给牌桌
    if (!draw.hit(g.card, x, y)) close(s);
    return true;
  }
  if (id === 'close') {
    close(s);
    return true;
  }
  if (id === 'master') {
    settings.set({ master: !settings.get().master });
    return true;
  }
  if (id === 'bgm.on' || id === 'bgmOut.on' || id === 'sfx.on' || id === 'voice.on') {
    const key = id.split('.')[0];
    const st = settings.get();
    // 不用计算属性名（老基础库更稳）：先建对象再赋值
    const patch = {};
    patch[key] = { on: !st[key].on };
    settings.set(patch);
    return true;
  }
  if (id.indexOf('pack:') === 0) {
    // 语音音色：与局内外音乐无关，选完立刻试播一声，听差别
    settings.set({ voice: { pack: id.slice(5) } });
    sound.unlock(); // 手势内解锁（iOS）
    sound.preview('peng');
    return true;
  }
  if (id.indexOf('track:') === 0) {
    // 局外曲目：只切换，**不自动播** —— 局内 BGM 在响时再叠一首曲子只是噪音；
    // 局外正在放的那首会立刻换掉（sound.setOutBgmTrack 换 src 续播）
    settings.set({ bgmOut: { track: id.slice(6) } });
    return true;
  }
  if (id === 'preview') {
    sound.unlock();
    sound.preview('peng');
    return true;
  }
  if (id === 'reset') {
    settings.reset();
    return true;
  }
  return true; // 点滑条区域（tap 到达时 down/move 已改过值，up 已落盘）
}

/** 打开（顺手解锁音频会话：面板里的试听要能立刻出声） */
function open(s) {
  s.settingsShown = true;
  s.setPressed = '';
  s._setDrag = null;
  /*
   * 清掉可能残留的按压态：面板打开前的触摸可能把 s.pressed / _tableDown 置上了。
   * 面板在屏时 chrome.down 不再执行（场景先判面板），它内部那条 `s.pressed = ''`
   * 也就不会跑 —— 不清的话关掉面板后可能有按钮以「按下」的样子亮着，
   * 更是有甚者 _tableDown 残留 true 会让关面板后的第一下点击直接触发出牌。
   */
  s.pressed = '';
  s._tableDown = false;
  sound.unlock();
}

function close(s) {
  s.settingsShown = false;
  s.setPressed = '';
  s._setDrag = null;
}

module.exports = { render, down, move, up, tap, open, close, isOpen, layout };
