/**
 * 对局页 chrome（pages/game/game.wxml DOM 半边的画布对位物）：
 * 顶栏 / 侧轨 / 操作带（报杠 + 吃碰杠胡过 + 自摸暗杠）/ 记录·聊天面板 / 模态浮层。
 *
 * 牌桌本体不在这里：utils/table.js 原样渲染在离屏宿主上，场景每帧 blit；本模块只画
 * 「画布以外的一圈」。样式取 game.wxss 紧凑档（@media max-height 680px）逐项对照。
 *
 * 与小程序端的行为差异（均为平台必然）：
 *   · 原生 canvas 合成层级问题不存在了 —— 浮层直接画在牌桌之上，无 .on-modal/display:none；
 *   · 操作钮艺术图改走 canvas 预解码位图（uiart.art），未就绪回落文字钮（wxml 同语义）；
 *   · scroll-view → 触摸拖拽自绘滚动（logScroll / chatScroll / settleScroll）。
 */

const draw = require('./ui/draw.js');
const btn = require('./ui/btn.js');
const layerUi = require('./ui/layer.js');
const input = require('./input.js');

const { C } = draw;

/* ---------------- 顶栏（.g-top 24px） ---------------- */

function topbar(ctx, L, s) {
  const r = L.topbar;
  // 返回 ‹ = **退出本局**（确认框，2026-11-05 用户需求）：任何人可点，只退出自己这一局，
  // 座位交托管代打至本局结束、牌局继续，人回房间页。旧「解散对局（房主强制结束全场）」已移除。
  // 只在 phase==='playing' 可点（s.quitShown）：结算/摊牌相位本局已经结束，
  // 「退出本局」没有语义，点它会拿到服务端「当前没有进行中的对局」，所以置灰不吃点击。
  const back = { x: r.x, y: r.y + 1, w: 22, h: 22 };
  s.ui.backBtn = back;
  const quitOk = s.quitShown !== false;
  ctx.save();
  if (!quitOk) ctx.globalAlpha = 0.32;
  ctx.fillStyle = 'rgba(16,26,21,0.7)';
  draw.roundRect(ctx, back.x, back.y, back.w, back.h, 4);
  ctx.fill();
  ctx.strokeStyle = s.pressed === 'back' ? C.gold : 'rgba(255,255,255,0.18)';
  ctx.stroke();
  draw.text(ctx, '‹', back.x + back.w / 2, back.y + back.h / 2, { size: 15, color: C.goldSoft, align: 'center' });
  ctx.restore();
  // 信息组：徽章（玩法）+ 房间码 + 牌墙 + 精（jingText 单独一色，超宽省略）
  let x = back.x + back.w + 6;
  const capRight = L.cap && L.cap.left > 0 ? L.cap.left : L.sw - L.padR;
  const maxW = capRight - 4 - x;
  if (s.variantLabel) {
    const bw = draw.measure(ctx, s.variantLabel, 9) + 16;
    ctx.fillStyle = 'rgba(230,193,75,0.16)';
    draw.roundRect(ctx, x, r.y + 4, bw, 16, 8);
    ctx.fill();
    draw.text(ctx, s.variantLabel, x + bw / 2, r.y + 12.5, { size: 9, color: C.goldSoft, align: 'center' });
    x += bw + 6;
  }
  x += draw.text(ctx, s.code, x, r.y + 12, { size: 10, color: C.goldSoft, bold: true });
  x += 6;
  x += draw.text(ctx, s.wallText, x, r.y + 12, { size: 10, color: C.tag, maxW: Math.max(0, maxW - (x - back.x)) });
  x += 6;
  if (s.jingText) {
    draw.text(ctx, s.jingText, x, r.y + 12, { size: 10, color: '#e0a86a', maxW: Math.max(0, maxW - (x - back.x)) });
  }
}

/* ---------------- 侧轨（.rail 28px 圆钮） ---------------- */

function railBtn(ctx, r, o) {
  ctx.save();
  if (o.disabled) ctx.globalAlpha = 0.45;
  const on = o.on && !o.pressed;
  // on 激活底色 0.22→0.45：绿桌直接透出时 22% 金几乎不可见（合成后 rgb(66,118,74)
  // 与桌面同色），用户看着像「空心金圈异常」（2026-11-04 报障）。加实后金底明确可辨。
  ctx.fillStyle = o.pressed
    ? 'rgba(255,255,255,0.3)'
    : on
      ? 'rgba(230,193,75,0.45)'
      : 'rgba(16,26,21,0.82)';
  draw.roundRect(ctx, r.x, r.y, r.w, r.h, r.h / 2);
  ctx.fill();
  ctx.strokeStyle = on
    ? 'rgba(230,193,75,0.85)'
    : o.danger
      ? 'rgba(224,122,106,0.5)'
      : o.exit
        ? 'rgba(240,198,116,0.55)'
        : o.muted
          ? 'rgba(255,255,255,0.1)'
          : 'rgba(255,255,255,0.16)';
  ctx.stroke();
  // 图标走 draw.icon（墨迹盒视觉居中）：rail 的 🔊📋💬🤖🎤 是**默认 emoji 表现**
  // 的单码点字形，真机上也居中；⚙️ 这类必须带 U+FE0F 的字形在真机上度量不稳
  // （2026-11-05 二次报障）→ 走 o.vec 矢量画法（draw.gear），与平台字体无关
  const iconColor = o.danger ? C.red : o.exit ? '#f0c674' : o.muted ? '#8b93a5' : on ? '#f6e3a1' : '#e8e2cf';
  if (o.vec === 'gear') draw.gear(ctx, r.x + r.w / 2, r.y + r.h / 2, 6.4, iconColor);
  else draw.icon(ctx, o.icon, r.x + r.w / 2, r.y + r.h / 2, { size: o.exit ? 11 : 13, color: iconColor });
  ctx.restore();
  // 有人说话（除自己）：金色呼吸光环（正弦调 alpha，对位 game.wxss .rail-btn.voice.speaking）
  if (o.speaking) {
    ctx.save();
    ctx.globalAlpha = 0.3 + 0.3 * Math.sin(Date.now() / 300);
    ctx.strokeStyle = 'rgba(246,227,161,0.8)';
    ctx.lineWidth = 2;
    draw.roundRect(ctx, r.x - 2, r.y - 2, r.w + 4, r.h + 4, r.h / 2 + 2);
    ctx.stroke();
    ctx.restore();
  }
  if (o.badge > 0) {
    // 未读红点（.rail-badge 右上外凸）
    const bw = 14;
    ctx.fillStyle = '#e5484d';
    draw.roundRect(ctx, r.x + r.w - bw / 2, r.y - 2, bw, 14, 7);
    ctx.fill();
    draw.text(ctx, o.badge > 99 ? '99+' : String(o.badge), r.x + r.w - bw / 2 + bw / 2, r.y + 5.5, {
      size: 9,
      color: '#fff',
      align: 'center',
      bold: true,
    });
  }
}

function menu(ctx, L, s) {
  const u = s.ui;
  // 合并菜单（2026-11-02 五轮，用户要求「左右菜单栏合并、可展开收起」）：
  // 收起 = 左缘一枚 ☰；展开 = 纵向一列钮（托管/记录/聊天/设置），
  // 点 ☰ 切换、点菜单外任意处收起。位置沿用左轨锚（胶囊下沿起）。
  // 2026-11-04：互动/退出/解散三枚从菜单移除 ——
  //   · 互动表情改由「点头像」直接触发（table.onTagClick → openEmotePicker(seat)，game.js 已接）；
  //   · 退出/解散统一走顶栏左上角 ‹（2026-11-05 起 = 退出本局，只影响自己，见 topbar 注释）。
  const x = L.railL.x;
  const u_toggle = { x, y: L.railL.y, w: 28, h: 28 };
  u.menuToggle = u_toggle;
  railBtn(ctx, u_toggle, { icon: s.menuOpen ? '✕' : '☰', on: s.menuOpen, pressed: s.pressed === 'menuToggle' });
  u.menuBtns = {};
  /*
   * 房间语音双钮（2026-11-03 反馈四轮）：**移出 ☰ 菜单、常驻在 ☰ 正下方**——
   * 语音是高频开关，不该藏在两次点击之后；菜单展开时从语音钮下方继续排，互不重叠。
   *   · voice = 开始使用/开闭麦（在语音房=金底，有人说话=呼吸光环，闭麦且关扬声器=🔇）；
   *   · voiceEar = 扬声器开关（听不听得到别人；未加入语音时也可设偏好，入会生效），
   *     开启=金底 / 静音=灰显（2026-11-04：此前只有图标切换，开没开看不出来；
   *     对位 lobby chip 与 game.wxml 同钮的 on·muted 类）。
   */
  const voiceTop = u_toggle.y + u_toggle.h + 4;
  const vRect = { x, y: voiceTop, w: 28, h: 28 };
  const eRect = { x, y: voiceTop + 30, w: 28, h: 28 };
  u.voiceBtn = vRect;
  u.voiceEarBtn = eRect;
  railBtn(ctx, vRect, {
    icon: s.voiceBusy ? '…' : s.voiceOn ? (s.voiceMuted && s.voiceEar ? '🔇' : '🎤') : '🎤', // 🎤（U+1F3A4）默认 emoji 表现，无 VS16 —— 🎙️ 真机度量不稳，2026-11-05 换
    on: s.voiceOn && !s.voiceMuted,
    muted: !!s.voiceMuted,
    speaking: s.voiceSpeaking && s.voiceOn && !s.voiceMuted,
    pressed: s.pressed === 'voiceBtn',
  });
  railBtn(ctx, eRect, {
    icon: s.voiceEar ? '🔕' : '🔊',
    on: !s.voiceEar,
    muted: !!s.voiceEar,
    pressed: s.pressed === 'voiceEarBtn',
  });
  if (!s.menuOpen) return;
  const btns = [];
  // AI 托管移到「操作记录」之上（2026-11-05 用户）
  if (s.autoShown) btns.push({ id: 'menuAuto', icon: '🤖', on: s.autoOn });
  btns.push({ id: 'menuLog', icon: '📋', on: s.logOpen });
  btns.push({ id: 'menuChat', icon: '💬', on: s.chatOpen, badge: s.chatUnread });
  /*
   * 声音设置（2026-11-04）：原 menuBgm（🎵 只切 BGM 开关）换成 ⚙️ 打开完整设置面板
   * —— 音量/音效/语音包原先没有任何入口。与小程序端右轨 🎵→⚙️ 同一决策。
   */
  btns.push({ id: 'menuSettings', icon: '⚙️', vec: 'gear' }); // 矢量齿轮：⚙️ 带 VS16 真机不居中（2026-11-05）
  let y = voiceTop + 60; // 语音双钮（两枚 28px + 间距）之下，互不重叠
  for (const b of btns) {
    const r = { x, y, w: 28, h: 28 };
    u.menuBtns[b.id] = r;
    railBtn(ctx, r, {
      icon: b.icon,
      vec: b.vec,
      on: b.on,
      danger: b.danger,
      exit: b.exit,
      badge: b.badge,
      speaking: b.speaking,
      pressed: s.pressed === b.id,
    });
    y += 30;
  }
}

/* ---------------- 操作带（.action-bar 34px：报杠 + 吃碰杠胡过 + 自摸暗杠） ---------------- */

/** 艺术钮尺寸：标准 34×29 / compact 30×25（.ctrl.art / .compact） */
function artSize(compact) {
  return compact ? { w: 30, h: 25 } : { w: 34, h: 29 };
}

function renderControl(ctx, s, rect, item, compact) {
  const artImg = item.art ? s.artImages[item.artKey] : null;
  if (artImg) {
    const a = artSize(compact);
    const scale = Math.min(1, rect.w / a.w);
    const w = a.w * scale;
    const h = a.h * scale;
    const x = rect.x + (rect.w - w) / 2;
    const imgY = rect.y + rect.h - (h + 9 - 5); // 图贴底，小注压图下缘 5px
    ctx.save();
    if (item.disabled) ctx.globalAlpha = 0.45;
    if (item.pressed) {
      ctx.translate(x + w / 2, imgY + h / 2);
      ctx.scale(0.94, 0.94);
      ctx.translate(-(x + w / 2), -(imgY + h / 2));
      ctx.globalAlpha = 0.92;
    }
    ctx.drawImage(artImg, x, imgY, w, h);
    if (item.cap) {
      // .ctrl-cap：深底胶囊小注（8px/7px，最大宽 46/38）
      const capFont = compact ? 7 : 8;
      const capW = Math.min(compact ? 38 : 46, draw.measure(ctx, item.cap, capFont) + 8);
      const cy = imgY + h - 4;
      ctx.fillStyle = 'rgba(8,12,18,0.72)';
      draw.roundRect(ctx, x + w / 2 - capW / 2, cy - 4.5, capW, 9, 4.5);
      ctx.fill();
      draw.text(ctx, item.cap, x + w / 2, cy, { size: capFont, color: '#f2e6c8', align: 'center' });
    }
    ctx.restore();
    return;
  }
  // 文字回落（.controls button 30px；过 = ghost 透明底）
  const pressed = item.pressed;
  ctx.save();
  if (item.disabled) ctx.globalAlpha = 0.45;
  if (pressed) {
    ctx.translate(rect.x + rect.w / 2, rect.y + rect.h / 2);
    ctx.scale(0.96, 0.96);
    ctx.translate(-(rect.x + rect.w / 2), -(rect.y + rect.h / 2));
  }
  ctx.fillStyle = item.ghost ? 'transparent' : pressed ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.08)';
  if (item.ghost && !pressed) {
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  } else if (!item.ghost) {
    ctx.strokeStyle = pressed ? C.gold : 'rgba(255,255,255,0.14)';
  }
  draw.roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 5);
  if (ctx.fillStyle !== 'transparent') ctx.fill();
  ctx.stroke();
  draw.text(ctx, item.text, rect.x + rect.w / 2, rect.y + rect.h / 2, {
    size: 12,
    color: item.ghost ? C.text : '#22200f',
    align: 'center',
    bold: !item.ghost,
    maxW: rect.w - 8,
  });
  ctx.restore();
}

function actionBar(ctx, L, s) {
  const bar = L.actionBar;
  if (!bar) return;
  const u = s.ui;
  u.actionBtns = [];
  const declares = s.declares || [];
  const controls = s.controls || [];
  const total = declares.length + controls.length;
  if (total === 0) return;
  const compact = total >= 7;
  // 统一 Button 描述：{ type:'declare'|'control', item }
  const items = [];
  for (const d of declares) items.push({ type: 'declare', item: d });
  for (const c of controls) items.push({ type: 'control', item: c });
  /*
   * 2026-11-03（用户报「操作按钮太小而且不居中」）：
   *   · 居中：**按屏幕中线排布**（bar 只是个锚定矩形，窄屏时 560*sc 可能被两侧
   *     副露带侵入；直接对 bar 中心而不是从 bar.x 起排，视觉上永远居中）；
   *   · 尺寸：报杠不再按「报杠 X」整词量宽（那是文字回落态的量法），艺术态与
   *     吃碰杠钮同构 —— 图钮 34×29 + 4px 边距，文字「报杠 吃」由 renderControl
   *     的 cap 小注承载（和小注同一渲染路径），宽窄稳定不再把整排撑爆触发 shrink。
   */
  const measureW = (it) => {
    if (it.item.art && s.artImages[it.item.artKey || 'gang']) return artSize(compact).w + 8;
    // 文字回落态：报杠胶囊按文本宽；普通钮按钮面文本宽
    const label = it.type === 'declare' ? '报杠 ' + it.item.name : it.item.text;
    return draw.measure(ctx, label, compact ? 11 : 12, true) + 22;
  };
  let totalW = items.reduce((acc, it) => acc + measureW(it), 0);
  const avail = Math.max(120, bar.w - 8);
  // 溢出一档再缩（compact 已含）：整体按比例压（flex-shrink 的画布近似，绝不折行）
  const shrink = totalW > avail ? Math.max(0.62, avail / totalW) : 1;
  const centerX = bar.x + bar.w / 2;
  let x = centerX - (totalW * shrink) / 2;
  const y0 = bar.y;
  for (const it of items) {
    const w = measureW(it) * shrink;
    const rect = { x, y: y0 + 1, w, h: 32 };
    x += w;
    if (it.type === 'declare') {
      if (it.item.art && s.artImages.gang) {
        renderControl(ctx, s, rect, { art: true, artKey: 'gang', cap: it.item.cap, disabled: s.declareBusy, pressed: s.pressed === 'declare' + it.item.tile }, compact);
      } else {
        // 文字胶囊回落（.ctrl.declare:not(.art)：金边胶囊 25px/22px）
        const h = compact ? 22 : 25;
        const yr = y0 + bar.h - h - 1;
        ctx.save();
        if (s.declareBusy) ctx.globalAlpha = 0.45;
        ctx.fillStyle = s.pressed === 'declare' + it.item.tile ? 'rgba(230,193,75,0.32)' : 'rgba(230,193,75,0.18)';
        draw.roundRect(ctx, rect.x, yr, rect.w, h, h / 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(230,193,75,0.85)';
        ctx.stroke();
        draw.text(ctx, '报杠 ' + it.item.name, rect.x + rect.w / 2, yr + h / 2, {
          size: compact ? 11 : 12,
          color: C.goldSoft,
          align: 'center',
          maxW: rect.w - 10,
        });
        ctx.restore();
      }
      u.actionBtns.push({ rect, type: 'declare', tile: it.item.tile });
    } else {
      renderControl(ctx, s, rect, {
        art: it.item.art,
        artKey: it.item.artKey,
        cap: it.item.cap,
        text: it.item.text,
        ghost: it.item.ghost,
        disabled: it.item.disabled,
        pressed: s.pressed === 'ctrl' + it.item.idx,
      }, compact);
      u.actionBtns.push({ rect, type: 'control', idx: it.item.idx });
    }
  }
}

/* ---------------- 记录 / 聊天面板（.side-panel） ---------------- */

/** 裁剪滚动区：clip + 平移，回调内用相对坐标绘制 */
function scrollArea(ctx, rect, offset, fn) {
  ctx.save();
  draw.roundRect(ctx, rect.x, rect.y, rect.w, rect.h, 4);
  ctx.clip();
  ctx.translate(0, -offset);
  fn(rect.x, rect.y);
  ctx.restore();
}

function logPanel(ctx, L, s) {
  const u = s.ui;
  const dim = L.gameMain;
  ctx.fillStyle = 'rgba(6,10,16,0.55)';
  draw.roundRect(ctx, dim.x, dim.y, dim.w, dim.h, 6);
  ctx.fill();
  const cardW = Math.min(L.sw * 0.86, 560);
  const cardH = dim.h - 8;
  const cx = dim.x + (dim.w - cardW) / 2;
  const cy = dim.y + 4;
  u.logCard = { x: cx, y: cy, w: cardW, h: cardH };
  ctx.fillStyle = '#16332a';
  draw.roundRect(ctx, cx, cy, cardW, cardH, 10);
  ctx.fill();
  ctx.strokeStyle = C.layerBorder;
  ctx.stroke();
  draw.text(ctx, '操作记录', cx + 8, cy + 12, { size: 12, color: C.goldSoft, bold: true });
  const close = { x: cx + cardW - 8 - 22, y: cy + 4, w: 22, h: 22 };
  u.logClose = close;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  draw.roundRect(ctx, close.x, close.y, close.w, close.h, 4);
  ctx.fill();
  draw.icon(ctx, '✕', close.x + close.w / 2, close.y + close.h / 2, { size: 11, color: C.text });
  // 行区
  const body = { x: cx, y: cy + 26, w: cardW, h: cardH - 26 };
  u.logBody = body;
  const lineH = 15;
  const contentH = (s.logRows || []).length * lineH + 6;
  s.logScroll = Math.max(0, Math.min(contentH - body.h, s.logScroll || 0));
  scrollArea(ctx, body, s.logScroll, (bx) => {
    let y = body.y + 4;
    for (const row of s.logRows || []) {
      let x = bx + 8;
      x += draw.text(ctx, row.seatName, x, y + 7, { size: 10, color: C.muted, maxW: 56 }) + 6;
      const ac = row.actionClass === 'hu' ? '#e0a86a' : C.tag;
      x += draw.text(ctx, row.action, x, y + 7, { size: 10, color: ac }) + 4;
      if (row.tiles) x += draw.text(ctx, row.tiles, x, y + 7, { size: 10, color: C.goldSoft }) + 4;
      if (row.note) draw.text(ctx, row.note, x, y + 7, { size: 10, color: C.muted, maxW: bx + body.w - 8 - x });
      y += lineH;
    }
  });
}

function chatPanel(ctx, L, s) {
  const u = s.ui;
  const dim = L.gameMain;
  ctx.fillStyle = 'rgba(6,10,16,0.55)';
  draw.roundRect(ctx, dim.x, dim.y, dim.w, dim.h, 6);
  ctx.fill();
  const cardW = Math.min(L.sw * 0.78, 480);
  const cardH = dim.h - 8;
  const cx = dim.x + (dim.w - cardW) / 2;
  const cy = dim.y + 4;
  u.chatCard = { x: cx, y: cy, w: cardW, h: cardH };
  ctx.fillStyle = '#16332a';
  draw.roundRect(ctx, cx, cy, cardW, cardH, 10);
  ctx.fill();
  ctx.strokeStyle = C.layerBorder;
  ctx.stroke();
  draw.text(ctx, '聊天', cx + 8, cy + 12, { size: 12, color: C.goldSoft, bold: true });
  const close = { x: cx + cardW - 8 - 22, y: cy + 4, w: 22, h: 22 };
  u.chatClose = close;
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  draw.roundRect(ctx, close.x, close.y, close.w, close.h, 4);
  ctx.fill();
  draw.icon(ctx, '✕', close.x + close.w / 2, close.y + close.h / 2, { size: 11, color: C.text });

  // 弹出行（快捷语 / 表情）：在输入行上方，max-height 30vh
  const inputH = 36;
  // 键盘弹出且聊天输入框聚焦时：输入行（连同上方快捷/表情弹层）抬到键盘上沿，
  // 消息区相应缩短 —— 对位 <input adjust-position>（聊天输入行贴面板底，必被键盘盖住）
  const kb = input.kbH ? input.kbH() : 0;
  const kbLimit = L.sh - kb - 4;
  let inputY = cy + cardH - inputH;
  if (s.chatFocus && kb > 0 && inputY + inputH > kbLimit) {
    inputY = Math.max(cy + 26 + 40, kbLimit - inputH);
  }
  let popH = 0;
  if (s.quickShown || s.emojiShown) {
    const list = s.quickShown ? s.quickList : s.emojiList;
    const chipH = 26;
    const gap = 6;
    let px = cx + 8;
    let py = inputY - 6 - chipH;
    let rows = 1;
    for (const chip of list) {
      const w = draw.measure(ctx, chip, 11) + 18;
      if (px + w > cx + cardW - 8) {
        px = cx + 8;
        py -= chipH + gap;
        rows++;
      }
      px += w + gap;
    }
    popH = rows * (chipH + gap) + 6;
    const popTop = inputY - 6 - rows * (chipH + gap) - 2;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    draw.roundRect(ctx, cx + 4, popTop, cardW - 8, rows * (chipH + gap) + 6, 6);
    ctx.fill();
    px = cx + 8;
    py = popTop + 4;
    u.chatChips = [];
    for (const chip of list) {
      const w = draw.measure(ctx, chip, 11) + 18;
      if (px + w > cx + cardW - 8) {
        px = cx + 8;
        py += chipH + gap;
      }
      const r = { x: px, y: py, w, h: chipH };
      const isPressed = s.pressed === 'chip:' + chip;
      ctx.fillStyle = isPressed ? 'rgba(230,193,75,0.16)' : 'rgba(255,255,255,0.08)';
      draw.roundRect(ctx, r.x, r.y, r.w, r.h, 4);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.stroke();
      draw.text(ctx, chip, r.x + r.w / 2, r.y + r.h / 2, { size: 11, color: C.text, align: 'center' });
      u.chatChips.push({ rect: r, text: chip });
      px += w + gap;
    }
  }

  // 消息区（input 行与弹层之间）
  const logRect = { x: cx, y: cy + 26, w: cardW, h: inputY - (cy + 26) - popH };
  u.chatBody = logRect;
  const lineH = 16;
  const contentH = (s.chatMsgs || []).length * lineH + 6;
  // 默认跟随最新一条：未拖动过时夹到底部
  if (!s.chatScrollTouched) s.chatScroll = Math.max(0, contentH - logRect.h);
  s.chatScroll = Math.max(0, Math.min(Math.max(0, contentH - logRect.h), s.chatScroll || 0));
  scrollArea(ctx, logRect, s.chatScroll, (bx) => {
    let y = logRect.y + 4;
    for (const m of s.chatMsgs || []) {
      let x = bx + 8;
      x += draw.text(ctx, m.name + '：', x, y + 7.5, { size: 11, color: m.self ? C.goldSoft : C.muted }) + 2;
      draw.text(ctx, m.text, x, y + 7.5, { size: 11, color: C.text, maxW: bx + logRect.w - 8 - x });
      y += lineH;
    }
  });

  // 输入行：💬 😊 [输入框] 发送
  let ix = cx + 6;
  const iy = inputY + 4;
  u.chatQuick = { x: ix, y: iy, w: 28, h: 28 };
  drawChatIco(ctx, u.chatQuick, '💬', s.quickShown, s.pressed === 'chatQuick');
  ix += 32;
  u.chatEmoji = { x: ix, y: iy, w: 28, h: 28 };
  drawChatIco(ctx, u.chatEmoji, '😊', s.emojiShown, s.pressed === 'chatEmoji');
  ix += 32;
  const sendW = 48;
  const fieldW = cardW - (ix - cx) - sendW - 16;
  u.chatField = { x: ix, y: iy, w: fieldW, h: 28 };
  const focused = s.chatFocus;
  ctx.fillStyle = C.inputBg;
  draw.roundRect(ctx, u.chatField.x, u.chatField.y, u.chatField.w, u.chatField.h, 5);
  ctx.fill();
  ctx.strokeStyle = focused ? C.gold : C.inputBorder;
  ctx.stroke();
  const shown = s.chatInput || '';
  let disp = shown || '说点什么…';
  draw.text(ctx, disp, u.chatField.x + 8, iy + 14, {
    size: 11,
    color: shown ? C.text : 'rgba(232,239,233,0.35)',
    maxW: u.chatField.w - 16,
  });
  if (focused && shown && Math.floor(Date.now() / 500) % 2 === 0) {
    const cw = Math.min(draw.measure(ctx, shown, 11), u.chatField.w - 16);
    ctx.strokeStyle = C.goldSoft;
    ctx.beginPath();
    ctx.moveTo(u.chatField.x + 8 + cw, iy + 6);
    ctx.lineTo(u.chatField.x + 8 + cw, iy + 22);
    ctx.stroke();
  }
  u.chatSend = { x: u.chatField.x + u.chatField.w + 8, y: iy, w: sendW, h: 28 };
  btn.render(ctx, u.chatSend, { label: '发送', kind: 'primary', size: 11, pressed: s.pressed === 'chatSend' });
}

function drawChatIco(ctx, r, icon, on, pressed) {
  // on 0.22→0.45（2026-11-04，与 railBtn.on 同修）：激活金底在深色面板上要可辨
  ctx.fillStyle = pressed ? 'rgba(255,255,255,0.3)' : on ? 'rgba(230,193,75,0.45)' : 'rgba(255,255,255,0.08)';
  draw.roundRect(ctx, r.x, r.y, r.w, r.h, 4);
  ctx.fill();
  ctx.strokeStyle = on ? 'rgba(230,193,75,0.85)' : 'rgba(255,255,255,0.14)';
  ctx.stroke();
  draw.icon(ctx, icon, r.x + r.w / 2, r.y + r.h / 2, { size: 13, color: on ? '#f6e3a1' : C.text });
}

/* ---------------- 模态浮层 ---------------- */

function emoteLayer(ctx, L, s) {
  const u = s.ui;
  ctx.fillStyle = C.layerBg;
  ctx.fillRect(0, 0, L.sw, L.sh);
  const cardW = Math.min(L.sw * 0.88, 520);
  const cardH = Math.min(L.sh - 20, 340);
  const cx = (L.sw - cardW) / 2;
  const cy = (L.sh - cardH) / 2;
  ctx.fillStyle = C.layerCard;
  draw.roundRect(ctx, cx, cy, cardW, cardH, 8);
  ctx.fill();
  ctx.strokeStyle = C.layerBorder;
  ctx.stroke();
  u.emoteCard = { x: cx, y: cy, w: cardW, h: cardH };
  draw.text(ctx, '互动表情', cx + 16, cy + 18, { size: 15, color: C.goldSoft, bold: true });
  draw.text(ctx, '先点一位玩家，再点一个表情给他；所有玩家都能看到。', cx + 16, cy + 36, { size: 11, color: C.muted, maxW: cardW - 32 });
  // 目标行（4 选 1）
  let ty = cy + 50;
  let tx = cx + 16;
  u.emoteTargets = [];
  for (const t of s.emoteTargets || []) {
    const w = draw.measure(ctx, t.label, 11) + 18;
    if (tx + w > cx + cardW - 16) {
      tx = cx + 16;
      ty += 28;
    }
    const r = { x: tx, y: ty, w, h: 24 };
    const on = t.active;
    ctx.fillStyle = on ? C.gold : 'rgba(255,255,255,0.08)';
    draw.roundRect(ctx, r.x, r.y, r.w, r.h, 4);
    ctx.fill();
    ctx.strokeStyle = on ? C.goldSoft : 'rgba(255,255,255,0.14)';
    ctx.stroke();
    draw.text(ctx, t.label, r.x + r.w / 2, r.y + r.h / 2, { size: 11, color: on ? C.goldDark : C.text, align: 'center', bold: on });
    u.emoteTargets.push({ rect: r, seat: t.seat });
    tx += w + 6;
  }
  ty += 34;
  // 表情分组网格（卡片内裁剪，防极端矮屏溢出）
  const grid = { x: cx + 12, y: ty, w: cardW - 24, h: cy + cardH - 12 - 42 - ty };
  u.emoteGrid = grid;
  ctx.save();
  draw.roundRect(ctx, grid.x, grid.y, grid.w, grid.h, 4);
  ctx.clip();
  const cellH = 30;
  let gx = grid.x;
  let gy = grid.y;
  u.emoteCells = [];
  for (const g of s.emoteGroups || []) {
    draw.text(ctx, g.label, gx + 2, gy + 7, { size: 10, color: g.tone === 'good' ? C.green : C.red });
    gy += 16;
    gx = grid.x;
    for (const cell of g.cells) {
      const cw = draw.measure(ctx, cell.icon + cell.name, 11) + 16;
      if (gx + cw > grid.x + grid.w) {
        gx = grid.x;
        gy += cellH + 4;
      }
      if (gy + cellH > grid.y + grid.h) break;
      const r = { x: gx, y: gy, w: cw, h: cellH };
      ctx.fillStyle = s.pressed === 'emote:' + cell.id ? 'rgba(230,193,75,0.16)' : 'rgba(255,255,255,0.06)';
      draw.roundRect(ctx, r.x, r.y, r.w, r.h, 4);
      ctx.fill();
      draw.text(ctx, cell.icon + ' ' + cell.name, r.x + r.w / 2, r.y + r.h / 2, { size: 11, color: C.text, align: 'center', maxW: r.w - 8 });
      u.emoteCells.push({ rect: r, id: cell.id });
      gx += cw + 6;
    }
    gy += cellH + 4;
  }
  ctx.restore();
  // 关闭
  const bw = draw.measure(ctx, '关闭', 12) + 24;
  const br = { x: cx + cardW - 16 - bw, y: cy + cardH - 12 - 30, w: bw, h: 30 };
  btn.render(ctx, br, { label: '关闭', size: 12, pressed: s.pressed === 'emoteClose' });
  u.emoteClose = br;
}

function settleLayer(ctx, L, s) {
  const u = s.ui;
  ctx.fillStyle = C.layerBg;
  ctx.fillRect(0, 0, L.sw, L.sh);
  const cardW = Math.min(L.sw * 0.92, 700);
  const cardH = L.sh - 16;
  const cx = (L.sw - cardW) / 2;
  const cy = 8;
  u.settleCard = { x: cx, y: cy, w: cardW, h: cardH };
  ctx.fillStyle = C.layerCard;
  draw.roundRect(ctx, cx, cy, cardW, cardH, 10);
  ctx.fill();
  ctx.strokeStyle = C.layerBorder;
  ctx.stroke();
  let y = cy + 8;
  const artImg = s.settleArtKey ? s.artImages[s.settleArtKey] : null;
  if (artImg) {
    // .settle-art 320×178rpx → 160×89
    const aw = 132;
    const ah = 74;
    ctx.drawImage(artImg, cx + cardW / 2 - aw / 2, y, aw, ah);
    y += ah + 2;
  }
  draw.text(ctx, s.settleTitle, cx + cardW / 2, y + 8, { size: 15, color: C.goldSoft, bold: true, align: 'center' });
  y += 22;
  if (s.settleWinTile) {
    draw.text(ctx, s.settleWinTile, cx + cardW / 2, y + 7, { size: 12, color: C.goldSoft, align: 'center' });
    y += 18;
  }
  // 明细滚动区（.settle-body）：表 + notes
  const bodyTop = y + 2;
  const footH = 22 + 12 + 30 + 12;
  const body = { x: cx + 12, y: bodyTop, w: cardW - 24, h: Math.max(60, cy + cardH - footH - bodyTop) };
  u.settleBody = body;
  const head = s.settleHead || [];
  const rows = s.settleRows || [];
  const lineH = 20;
  const contentH = (rows.length + 1) * lineH + (s.settleNotes || []).length * 15 + 8;
  s.settleScroll = Math.max(0, Math.min(Math.max(0, contentH - body.h), s.settleScroll || 0));
  scrollArea(ctx, body, s.settleScroll, () => {
    let ry = body.y + 2;
    // 表头
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    draw.roundRect(ctx, body.x, ry, body.w, lineH, 4);
    ctx.fill();
    let colW = [];
    if (head.length) {
      const first = body.w * 0.16;
      const rest = (body.w - first) / (head.length - 1);
      colW = head.map((_, i) => (i === 0 ? first : rest));
      let x = body.x;
      head.forEach((h, i) => {
        draw.text(ctx, h, x + colW[i] / 2, ry + lineH / 2, { size: 10, color: C.muted, align: 'center', maxW: colW[i] - 4 });
        x += colW[i];
      });
    }
    ry += lineH;
    for (const row of rows) {
      if (row.me) {
        ctx.fillStyle = 'rgba(230,193,75,0.1)';
        ctx.fillRect(body.x, ry, body.w, lineH);
      }
      let x = body.x;
      row.cells.forEach((cell, i) => {
        const color = cell.cls && cell.cls.indexOf('pos') >= 0 ? C.green : cell.cls && cell.cls.indexOf('neg') >= 0 ? C.red : C.text;
        draw.text(ctx, cell.text, x + colW[i] / 2, ry + lineH / 2, {
          size: 11,
          color,
          align: 'center',
          maxW: colW[i] - 4,
          bold: !!(cell.cls && cell.cls.indexOf('total-col') >= 0),
        });
        x += colW[i];
      });
      ry += lineH;
    }
    for (const note of s.settleNotes || []) {
      draw.text(ctx, note, body.x + 4, ry + 8, { size: 10, color: C.muted, maxW: body.w - 8 });
      ry += 15;
    }
  });
  // 累计子行 + 按钮
  const totalsY = cy + cardH - footH + 6;
  draw.text(ctx, s.settleTotals, cx + 16, totalsY + 7, { size: 11, color: C.tag, maxW: cardW - 32 });
  const byy = cy + cardH - 12 - 30;
  // 「下一局」→「准备」（2026-11-05 用户）：与画布底部「准备」胶囊同一出口（nextRound）；
  // 点过之后显示「已准备」并置灰。
  const nextLabel = s.settleNextDisabled ? '已准备' : '准备';
  const nextW = draw.measure(ctx, nextLabel, 12) + 24;
  const hideW = draw.measure(ctx, '最小化', 12) + 24;
  const nextR = { x: cx + cardW - 16 - nextW, y: byy, w: nextW, h: 30 };
  const hideR = { x: nextR.x - 6 - hideW, y: byy, w: hideW, h: 30 };
  btn.render(ctx, hideR, { label: '最小化', size: 12, pressed: s.pressed === 'settleHide' });
  btn.render(ctx, nextR, { label: nextLabel, kind: 'primary', size: 12, disabled: s.settleNextDisabled, pressed: s.pressed === 'settleNext' });
  u.settleHide = hideR;
  u.settleNext = nextR;
}

/* ---------------- 汇总入口 ---------------- */

function render(ctx, L, s) {
  const u = (s.ui = s.ui || {});
  // 浮层按钮每帧重建（2026-11-04 审计 F1）：s.ui 在对局场景跨帧持久，而 layer.confirm/
  // scoreTable 只往 u.layerBtns 里 push 不清空 —— 浮层关掉后旧按钮矩形仍留在表里，
  // chrome.tap 第一段就消费它：「看不见的按钮」劫持后续点击（旧「解散」按钮曾把换位
  // 确认框的「同意」劫持成 abort，直接误解散对局）。与 lobby 场景每帧 u.layerBtns=[] 同口径。
  u.layerBtns = [];
  // 同理清空弹框矩形与「遮罩点击」处理：浮层关掉后不能让上一帧的矩形继续生效
  u.layerCard = null;
  u.layerDismiss = null;
  if (L.bannerRect) {
    ctx.fillStyle = 'rgba(224,122,106,0.16)';
    draw.roundRect(ctx, L.bannerRect.x, L.bannerRect.y, L.bannerRect.w, L.bannerRect.h, 5);
    ctx.fill();
    draw.text(ctx, s.netText, L.bannerRect.x + 10, L.bannerRect.y + L.bannerRect.h / 2, {
      size: 11,
      color: C.red,
      maxW: L.bannerRect.w - 20,
    });
  }
  topbar(ctx, L, s);
  const diceOpen = s.diceFx && s.diceFx.shown;
  if (!diceOpen) menu(ctx, L, s);
  actionBar(ctx, L, s);
  if (s.logOpen) logPanel(ctx, L, s);
  else if (s.chatOpen) chatPanel(ctx, L, s);
  // 模态浮层（同屏至多一个；骰子最后画，且盖过面板）
  if (s.emoteShown) emoteLayer(ctx, L, s);
  else if (s.settleShown) settleLayer(ctx, L, s);
  else if (s.quitAskShown) {
    layerUi.confirm(
      ctx,
      L,
      u,
      s.pressed,
      '退出本局',
      '只退出这一局：你的座位由托管代打至本局结束，牌局继续、不影响其他人。你回到房间，本局结束后可继续准备下一局。',
      [
        { label: '取消', fn: () => s.onQuitConfirm(false) },
        { label: '退出', kind: 'danger', fn: () => s.onQuitConfirm(true) },
      ],
    );
  } else if (s.swapAskShown) {
    layerUi.confirm(ctx, L, u, s.pressed, '换位请求', s.swapAskText, [
      { label: '拒绝', fn: () => s.onSwapRespond(false) },
      { label: '同意', kind: 'primary', fn: () => s.onSwapRespond(true) },
    ]);
  } else if (s.dissolvedShown) {
    layerUi.scoreTable(ctx, L, u, s.pressed, s.dissolvedTitle, s.dissolvedRows, () => s.onDissolvedOk());
  }
  if (diceOpen) s.diceFx.render(ctx, L);
}

/* ---------------- 触摸 ---------------- */

function down(x, y, s) {
  const u = s.ui;
  s.pressed = '';
  // 滚动区拖拽起点
  if (s.logOpen && u.logBody && draw.hit(u.logBody, x, y)) {
    s._scrollDrag = { which: 'log', lastY: y };
    return true;
  }
  if (s.chatOpen && u.chatBody && draw.hit(u.chatBody, x, y)) {
    s._scrollDrag = { which: 'chat', lastY: y };
    return true;
  }
  if (s.settleShown && u.settleBody && draw.hit(u.settleBody, x, y)) {
    s._scrollDrag = { which: 'settle', lastY: y };
    return true;
  }
  const zones = [
    u.backBtn && { id: 'back', rect: u.backBtn },
    u.menuToggle && { id: 'menuToggle', rect: u.menuToggle },
    // 房间语音双钮（常驻在 ☰ 下方，独立于 ☰ 菜单展开态）
    u.voiceBtn && { id: 'voiceBtn', rect: u.voiceBtn },
    u.voiceEarBtn && { id: 'voiceEarBtn', rect: u.voiceEarBtn },
    ...Object.keys(u.menuBtns || {}).map((k) => ({ id: k, rect: u.menuBtns[k] })),
    ...((u.actionBtns || []).map((b) => ({
      id: b.type === 'declare' ? 'declare' + b.tile : 'ctrl' + b.idx,
      rect: b.rect,
    }))),
    u.logClose && { id: 'logClose', rect: u.logClose },
    u.chatClose && { id: 'chatClose', rect: u.chatClose },
    u.chatQuick && { id: 'chatQuick', rect: u.chatQuick },
    u.chatEmoji && { id: 'chatEmoji', rect: u.chatEmoji },
    u.chatField && { id: 'chatField', rect: u.chatField },
    u.chatSend && { id: 'chatSend', rect: u.chatSend },
    ...((u.chatChips || []).map((c) => ({ id: 'chip:' + c.text, rect: c.rect }))),
    ...((u.emoteTargets || []).map((t) => ({ id: 'emoteTarget:' + t.seat, rect: t.rect }))),
    ...((u.emoteCells || []).map((c) => ({ id: 'emote:' + c.id, rect: c.rect }))),
    u.emoteClose && { id: 'emoteClose', rect: u.emoteClose },
    u.settleHide && { id: 'settleHide', rect: u.settleHide },
    u.settleNext && { id: 'settleNext', rect: u.settleNext },
    ...((u.layerBtns || []).map((b) => ({ id: b.id, rect: b.rect }))),
  ].filter(Boolean);
  for (const z of zones) {
    if (draw.hit(z.rect, x, y)) {
      s.pressed = z.id;
      return true;
    }
  }
  return false;
}

function move(x, y, s) {
  const d = s._scrollDrag;
  if (!d) return false;
  const dy = y - d.lastY;
  d.lastY = y;
  if (d.which === 'log') s.logScroll = Math.max(0, (s.logScroll || 0) - dy);
  else if (d.which === 'chat') {
    s.chatScrollTouched = true;
    s.chatScroll = Math.max(0, (s.chatScroll || 0) - dy);
  } else if (d.which === 'settle') s.settleScroll = Math.max(0, (s.settleScroll || 0) - dy);
  return Math.abs(dy) > 1;
}

function up(s) {
  s._scrollDrag = null;
  s.pressed = '';
}

/** chrome 层 tap 分发；返回 true = 已消费（不再给牌桌） */
function tap(x, y, s) {
  const u = s.ui;
  const hit = (r) => draw.hit(r, x, y);
  // 掷骰覆盖层：无按钮、全屏吞掉点击（对位 modalOpen 期间画布 display:none）
  if (s.diceFx && s.diceFx.shown) return true;
  // 确认类浮层：按钮可点；点弹框外（遮罩）= 取消/拒绝（layer.js 记的 layerDismiss）
  for (const b of u.layerBtns || []) {
    if (hit(b.rect)) {
      b.fn();
      return true;
    }
  }
  if (s.quitAskShown || s.swapAskShown || s.dissolvedShown) {
    if (u.layerDismiss && u.layerCard && !hit(u.layerCard)) u.layerDismiss();
    return true;
  }
  if (s.emoteShown) {
    for (const t of u.emoteTargets || []) if (hit(t.rect)) return s.onEmoteTarget(t.seat), true;
    for (const c of u.emoteCells || []) if (hit(c.rect)) return s.onEmoteCell(c.id), true;
    if (hit(u.emoteClose)) return s.onEmoteClose(), true;
    if (u.emoteCard && !hit(u.emoteCard)) return s.onEmoteClose(), true; // 点弹框外部 → 关闭
    return true; // 卡内空白不透给牌桌
  }
  if (s.settleShown) {
    if (hit(u.settleHide)) return s.onSettleHide(), true;
    if (hit(u.settleNext)) return s.onSettleNext(), true;
    if (u.settleCard && !hit(u.settleCard)) return s.onSettleHide(), true; // 点弹框外 → 隐藏结算
    return true;
  }
  // 面板
  if (s.logOpen) {
    if (hit(u.logClose)) return s.onToggleLog(), true;
    if (u.logCard && !hit(u.logCard)) return s.onToggleLog(), true; // 点弹框外 → 收起记录
    return true; // 面板内空白不透给牌桌（对位 .side-panel 挡层）
  }
  if (s.chatOpen) {
    if (hit(u.chatClose)) return s.onToggleChat(), true;
    if (hit(u.chatQuick)) return s.onTogglePop('quick'), true;
    if (hit(u.chatEmoji)) return s.onTogglePop('emoji'), true;
    for (const c of u.chatChips || []) {
      if (hit(c.rect)) return s.onChatChip(c.text), true;
    }
    // 点弹框外部（遮罩 / 露出的牌桌区）→ 自动最小化聊天（截图里的左右露白区）
    if (u.chatCard && !hit(u.chatCard)) return s.onToggleChat(), true;
    // 键盘弹出时点输入区以外（含消息列表）：先收键盘（原生语义），本次点击不再透传
    if (s.chatFocus && input.kbH() > 0 && !hit(u.chatField) && !hit(u.chatSend)) {
      s.blurChat();
      return true;
    }
    if (hit(u.chatField)) return s.onChatFieldTap(), true;
    if (hit(u.chatSend)) return s.onSendChat(), true;
    return true;
  }
  // 合并菜单（☰ 切换；展开时点外收起）。语音双钮在菜单逻辑**之前**判定：
  // 它们常驻在 ☰ 下方，菜单展开/收起都可点（点语音钮不算「点菜单外」，不收菜单）
  if (hit(u.voiceBtn)) return s.onVoiceTap(), true;
  if (hit(u.voiceEarBtn)) return s.onVoiceEar(), true;
  if (hit(u.menuToggle)) return (s.menuOpen = !s.menuOpen), true;
  if (s.menuOpen) {
    const mb = u.menuBtns || {};
    if (mb.menuLog && hit(mb.menuLog)) return s.onToggleLog(), true;
    if (mb.menuChat && hit(mb.menuChat)) return s.onToggleChat(), true;
    if (mb.menuAuto && hit(mb.menuAuto)) return s.onAuto(), true;
    if (mb.menuSettings && hit(mb.menuSettings)) return s.onSettingsOpen(), true;
    s.menuOpen = false; // 点菜单外：先收起，本次点击不再透传
    return true;
  }
  // 顶栏 / 操作带
  if (s.quitShown !== false && hit(u.backBtn)) return s.onQuit(), true;
  for (const b of u.actionBtns || []) {
    if (hit(b.rect)) {
      if (b.type === 'declare') s.onDeclareTap(b.tile);
      else s.onControl(b.idx);
      return true;
    }
  }
  return false;
}

module.exports = { render, down, move, up, tap };
