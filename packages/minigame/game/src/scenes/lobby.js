/**
 * 大厅（房间）：座位卡 / 准备 / 换位 / 加机器人 / 首局定庄掷骰 / 玩法切换 / 分享。
 *
 * pages/lobby/lobby.js + lobby.wxml + lobby.wxss（紧凑档）的画布移植，逻辑逐行对照：
 *   · 风位一律 seatWind(seat, dealer)（**风位随庄**，不直接用座位基准序）；
 *   · 定庄骰子动画只在自己掷骰时播（首帧 / 别人掷骰只登记 key，交给事件流文字）；
 *   · 「加机器人」房主恒在 + 满员置灰（按钮不消失 → 右侧按钮不跳位）；
 *   · 「离开房间」二次确认（页内 layer，不用原生弹层）。
 *
 * 小游戏端差异：wx.reLaunch → nav.navigate；feed scroll-view → 触摸拖拽自绘滚动；
 * 掷骰覆盖层 → src/ui/dicefx.js（同一套 utils/dice.js 数据）。
 */

const { seatWind } = require('../../lib/shared/tiles.js');
const { VARIANT_LIST, variantName, getRules } = require('../../lib/shared/rules/index.js');
const nav = require('../nav.js');
const net = require('../../utils/net.js');
const state = require('../state.js');
const voice = require('../../utils/voice.js');
/** 头像资源（2026-11-04）：座位卡头像；缺图回退空心圆 */
const avatarart = require('../../utils/avatarart.js');
/** 图片预解码宿主（app.canvas.createImage / wx.createImage 适配） */
const preload = require('../preload.js');
const privacy = require('../../utils/privacy.js');
const layout = require('../layout.js');
const draw = require('../ui/draw.js');
const btn = require('../ui/btn.js');
const toast = require('../ui/toast.js');
const DiceFx = require('../ui/dicefx.js');
/** 声音设置面板（2026-11-04）：画布版，game/lobby/home 共用 */
const sound = require('../../utils/sound.js');
const settingsPanel = require('../ui/settingspanel.js');
const Scene = require('./scene.js');

const FEED_MAX = 200;
const { C } = draw;

class LobbyScene extends Scene {
  constructor() {
    super();
    this.code = '';
    this.variantLabel = '';
    this.meText = '';
    this.seats = [];
    this.readyText = '准备';
    // 房间正处在对局进行中（2026-11-05）：只会出现在「局内退出回房间」的人身上 ——
    // 此时本局还在别人手里打着，准备/换位都得等本局结束，底部准备按钮置灰。
    this.playing = false;
    this.allReady = false;
    this.isHost = false;
    this.botFull = false;
    this.drShown = false;
    this.drDisabled = false;
    this.drText = '打骰子';
    this.variantSwitchShown = false;
    this.variantOpts = [];
    this.variantCurrent = '';
    this.feed = [];
    this.feedOffset = 0; // 自绘滚动偏移（px，0 = 顶）
    this.feedDrag = null; // { lastY }
    // 声音设置面板（2026-11-04）：表头 ⚙️ 打开；在屏时吞掉全部触摸
    this.settingsShown = false;
    this.setPressed = '';
    this._setDrag = null;
    // 弹层
    this.swapAskShown = false;
    this.swapAskText = '';
    this.leaveAskShown = false;
    this.dissolveAskShown = false;
    this.variantConfirmShown = false;
    this.variantConfirmText = '';
    this.pendingVariant = '';
    this.dissolvedShown = false;
    this.dissolvedTitle = '';
    this.dissolvedRows = [];
    this.dice = new DiceFx();
    this.diceKey = undefined; // 与 lobby.js 同名同语义：undefined = 首帧只登记不播
    this.netShown = false;
    this.netText = '';
    // 房间语音（2026-11-03 反馈：可选开启 + 麦克风/扬声器双开关）：表头双 chip 渲染态样
    this.voiceAvailable = true;
    this.voiceOn = false;
    this.voiceMuted = false;
    this.voiceEar = false;
    this.voiceSpeaking = false;
    this.voiceBusy = false;
    this.ui = {};
    this.pressed = '';
    this._botAt = 0;
  }

  enter() {
    nav.attach('lobby', this);
    // 局外背景音乐（2026-11-04）：大厅也是「局外」，与对局页的局内 BGM 互斥
    sound.outBgmStart();
    if (state.lastState) this.renderLobby(state.lastState);
    this.syncNet();
    this.initVoice();
    // 头像（2026-11-04）：座位卡要画头像，提前确保清单并预解码
    avatarart.ensure(() => {});
    avatarart.preload(preload.imageHost(), avatarart.list());
  }

  exit() {
    // 定庄掷骰动画有 100ms 轮询 + 定时器，离开场景必须一并清掉（对位 onHide/onUnload）
    this.dice.dispose();
    voice.setListener(null); // 监听是模块级单槽：本场景退出即摘除，新场景 enter 重新挂
    sound.outBgmStop(); // 离开局外：停掉局外 BGM（进对局页时由 game.enter 起局内 BGM）
    nav.detach(this);
  }

  onNetStatus(s) {
    const text = net.describe(s);
    this.netText = text;
    this.netShown = !!text;
  }

  syncNet() {
    this.onNetStatus({
      state: net.getState(),
      inRoom: true,
      everConnected: net.hasConnected(),
      error: net.getLastError(),
      url: net.getUrl(),
    });
  }

  /* ---------------- 房间语音（2026-11-03，对位 lobby.js initVoice 一节） ---------------- */

  /** 进场景挂语音监听 + 刷新开关探测。监听是模块级单槽：本场景覆盖旧场景的。 */
  initVoice() {
    voice.setListener((st) => this.applyVoice(st));
    this.applyVoice(voice.status());
    voice.probe().then((v) => {
      this.voiceAvailable = v !== false;
    });
  }

  applyVoice(st) {
    this.voiceOn = st.state === 'joined';
    this.voiceMuted = st.micMuted;
    this.voiceEar = st.earMuted;
    this.voiceSpeaking = st.othersSpeaking;
    this.voiceBusy = st.state === 'joining';
    this.voiceAvailable = voice.available() !== false;
    // 麦克风权限被拒：只提示一次（每场景实例），去开启走语音钮（tap 手势里调 openSetting）
    if (st.state === 'idle' && st.reason === 'micDenied' && !this.voiceAskSeen) {
      this.voiceAskSeen = true;
      toast.push('需要麦克风权限：点语音钮去开启', 2200);
    }
    // 其它加入失败（joinFailed: 开通未生效/工具端不支持/签名失效…）：透出真实原因，
    // 别让用户对着授权页打转。lastVoiceToastErr 去重：error 留在语音模块状态里，
    // 后续 notify 不能反复弹同一条；每次进入 joining 都重置，重试同一失败也会再提示。
    else if (st.state === 'joining') {
      this.lastVoiceToastErr = '';
    } else if (st.state === 'idle' && st.error && st.error !== this.lastVoiceToastErr) {
      this.lastVoiceToastErr = st.error;
      toast.push(st.error, 3200);
    } else if (st.state === 'idle' && !st.error) {
      this.lastVoiceToastErr = ''; // 新一次尝试已把 error 清空：重试再失败要能再次提示
    }
  }

  /** 扬声器开关（听不听得到别人）：任意状态可切——未加入语音时设偏好（入会生效） */
  onVoiceEar() {
    // 联动（2026-11-04）：会中关扬声器 = 同步退出语音，toast 告知而非无声退出
    voice.toggleEar().then((r) => {
      if (r && r.voiceLeft) toast.push('扬声器已静音，已退出房间语音', 2400);
    });
  }

  /** 语音 chip：joined=开/闭麦切换；idle 且权限被拒=先引导去设置；否则（重新）加入 */
  onVoiceTap() {
    const st = voice.status();
    if (st.state === 'joined') {
      voice.toggleMic();
      return;
    }
    if (st.state === 'joining') return;
    const go = () => voice.join(this.code || state.roomCode || '').catch(() => {});
    if (st.reason === 'micDenied') {
      // wx.openSetting 必须由用户手势触发 —— 此处是 tap 回调，满足
      voice.openMicSetting().then((granted) => {
        if (granted) go();
      });
      return;
    }
    go();
  }

  wind(seat) {
    return seatWind(seat, state.dealer || 0);
  }

  /* ---------------- 大厅渲染（renderLobby 逐行移植） ---------------- */

  onState(s) {
    this.renderLobby(s);
  }

  /** 服务端 voice 座位映射广播（nav.js 路由）：重渲染座位卡上的说话/闭麦标 */
  onVoice() {
    if (state.lastState) this.renderLobby(state.lastState);
  }

  renderLobby(s) {
    state.lastState = s;
    state.dealer = s.dealer || 0;
    state.mySeat = s.you;
    const dealerRolls = s.dealerRolls || [];
    const dealerDecided = !!s.dealerDecided;
    const needRoll = getRules(s.variant).flow.firstDealerRoll === true;
    const inDealerRoll = needRoll && !dealerDecided;
    const me = (s.players || []).find((p) => p.seat === s.you);
    const meScore = (s.totals && s.totals[s.you]) || 0;
    // 座位级语音指示（2026-11-03 二期，对位 lobby.js renderLobby）：服务端映射 × 说话人求交。
    // reactive = 说话人事件有数据（呼吸=正在说）；false = 降级「开麦即亮」（常亮）——
    // 每帧现取 hasSpeakerData()：事件哪天开始触发，指示自动升级回呼吸模式。
    const vmap = state.voiceMap || {};
    const speakers = voice.speakers();
    const reactive = voice.hasSpeakerData();

    const seats = [];
    for (let seat = 0; seat < 4; seat++) {
      const p = (s.players || []).find((x) => x.seat === seat);
      const isSelf = seat === s.you;
      const offline = !!p && p.connected === false;
      const tv = (s.totals && s.totals[seat]) || 0;
      const roll = needRoll ? dealerRolls.find((r) => r.seat === seat) : null;
      let st = '';
      if (!p) st = '';
      else if (p.isBot) st = '机器人 · 托管中';
      else if (offline) st = '掉线 · 等待重连';
      else if (p.away) st = '已退出本局 · 托管代打';
      else if (p.ready) st = '已准备';
      else st = '未准备';
      const ps = s.pendingSwap;
      let tip = '';
      let tipClass = '';
      if (ps && ps.from === seat) {
        tip = '请求换到 ' + this.wind(ps.to) + '家…';
        tipClass = 'pending';
      } else if (ps && ps.to === seat) {
        tip = '收到换位请求';
        tipClass = 'ask';
      } else if (!isSelf && !(p && p.isBot) && !s.playing) {
        // 对局进行中（局内退出回房间）→ 不给「点击换位/换入」提示：服务端此时会拒
        tip = p ? '点击换位' : '空位 · 点此换入';
        tipClass = '';
      } else if (isSelf && s.playing) {
        tip = '本局托管中，结束后可准备下一局';
        tipClass = 'pending';
      }
      // 该座位的语音态：映射里有 openid 且在最近说话人列表 = 正在说。
      // 双模式（2026-11-05 B 方案）：说话人事件从不触发的真机上降级为「开麦即亮」
      // （映射有条目且未闭麦），语义与铭牌光环一致 —— 详见 game 场景 computeVoiceSeats。
      const vInfo = vmap[seat] || null;
      seats.push({
        seat,
        wind: this.wind(seat),
        host: !!(p && p.isHost),
        empty: !p,
        self: isSelf,
        bot: !!(p && p.isBot),
        name: p ? p.name : '等待加入…',
        avatar: p ? p.avatar || '' : '',
        score: tv > 0 ? '+' + tv : String(tv),
        scoreClass: tv > 0 ? 'pos' : tv < 0 ? 'neg' : 'zero',
        rollText: roll ? roll.dice[0] + ' + ' + roll.dice[1] + ' = ' + roll.sum + ' 点' : '',
        state: st,
        offline,
        ready: !!(p && p.ready),
        voiceSpeaking: !!(vInfo && (reactive ? speakers.indexOf(vInfo.openid) >= 0 : !vInfo.muted)),
        voiceMuted: !!(vInfo && vInfo.muted),
        voiceEar: !!(vInfo && vInfo.ear),
        kickable: !!(p && me && me.isHost && !isSelf),
        kickLabel: p && p.isBot ? '移除' : '踢出',
        tip,
        tipClass,
        swappable: !isSelf && !(p && p.isBot),
      });
    }

    this.code = s.code;
    this.variantLabel = variantName(s.variant);
    this.variantCurrent = s.variant;
    this.meText = me
      ? this.wind(s.you) + '家 · ' + me.name + ' · ' + (meScore > 0 ? '+' : '') + meScore + '分'
      : '';
    this.seats = seats;
    this.playing = !!s.playing;
    // 对局进行中（本页只可能是「局内退出」的人）：准备按钮改文案 + 置灰，
    // 别让他点了才收到「本局还在进行」的错误提示（服务端同样会拒）。
    this.readyText = this.playing ? '本局进行中' : me && me.ready ? '取消准备' : '准备';
    this.allReady = !!s.allReady;
    this.isHost = !!(me && me.isHost);
    this.botFull = (s.players || []).length >= 4;
    this.drShown = inDealerRoll;
    const mineRoll = dealerRolls.find((r) => r.seat === s.you);
    this.drDisabled = !!mineRoll || !me || (s.players || []).length < 4;
    this.drText = mineRoll ? '已掷出 ' + mineRoll.sum + ' 点' : '打骰子';
    this.buildVariantSwitch(s.variant, !!(me && me.isHost));

    // 定庄掷骰的覆盖层动画只在自己掷骰时播（见 lobby.js 注释）；首帧只登记 key
    if (needRoll && dealerRolls.length > 0) {
      const latest = dealerRolls[dealerRolls.length - 1];
      const key = dealerRolls.length + '-' + latest.seat + '-' + latest.sum;
      const mine = latest.seat === s.you;
      if (this.diceKey === key) {
        // 已处理过
      } else if (this.diceKey === undefined || !mine) {
        this.diceKey = key; // 首帧 / 别人掷骰：静默登记
      } else {
        const who = ((s.players || []).find((p) => p.seat === latest.seat) || {}).name || this.wind(latest.seat) + '家';
        this.dice.run(
          latest.dice,
          who + ' 掷骰…',
          who + ' 掷出 ' + latest.dice[0] + ' + ' + latest.dice[1] + ' = ' + latest.sum + ' 点',
          1200,
          2600,
        );
        this.diceKey = key;
      }
    }
  }

  buildVariantSwitch(current, editable) {
    if (!editable) {
      this.variantSwitchShown = false;
      this.variantOpts = [];
      return;
    }
    this.variantSwitchShown = true;
    this.variantOpts = VARIANT_LIST.map((v) => ({ id: v.id, name: v.name, active: v.id === current }));
  }

  /* ---------------- 交互（onXxx 逐行移植） ---------------- */

  onPickVariant(id) {
    if (id === this.variantCurrent) return;
    this.pendingVariant = id;
    this.variantConfirmShown = true;
    this.variantConfirmText = '切换为「' + variantName(id) + '」。是否清除此前的累计积分？';
  }

  onVariantKeep() {
    this.submitVariantSwitch(false);
  }

  onVariantClear() {
    this.submitVariantSwitch(true);
  }

  onVariantCancel() {
    this.pendingVariant = '';
    this.variantConfirmShown = false;
  }

  submitVariantSwitch(clearScores) {
    const v = this.pendingVariant;
    this.pendingVariant = '';
    this.variantConfirmShown = false;
    if (!v) return;
    nav.send({ t: 'setVariant', variant: v, clearScores });
  }

  onToggleReady() {
    if (!net.isOpen()) return;
    if (this.playing) {
      toast.push('本局还在进行，结束后就能准备下一局', 1800);
      return;
    }
    const cancelling = this.readyText === '取消准备';
    nav.send({ t: 'ready', ready: !cancelling });
  }

  onLeave() {
    this.leaveAskShown = true;
  }

  onLeaveConfirm(accept) {
    this.leaveAskShown = false;
    if (!accept) return;
    nav.leaveRoom();
    nav.navigate('home');
  }

  onDissolve() {
    this.dissolveAskShown = true;
  }

  onDissolveConfirm(accept) {
    this.dissolveAskShown = false;
    if (!accept) return;
    if (!net.isOpen()) {
      toast.push('连接已断开，无法解散牌桌：请返回首页重连', 3000);
      return;
    }
    nav.send({ t: 'dissolve' });
  }

  onAddBot() {
    if (!net.isOpen()) return;
    // 连点节流：400ms 内只认第一下（对位 lobby.js onAddBot）
    const now = Date.now();
    if (now - (this._botAt || 0) < 400) return;
    this._botAt = now;
    nav.send({ t: 'addBot' });
  }

  onRollDealer() {
    if (!net.isOpen()) return;
    nav.send({ t: 'rollDealer' });
  }

  onSeatTap(seat) {
    const s = state.lastState;
    if (!s) return;
    const ps = s.pendingSwap;
    if (ps) {
      toast.push(
        ps.from === s.you ? '换位请求处理中：等待 ' + this.wind(ps.to) + '家同意' : '房间内已有换位请求在处理，请稍候',
      );
      return;
    }
    nav.send({ t: 'swap', toSeat: seat });
  }

  /** 房主请人出房间：机器人走 removeBot，真人走 kick（对位 onSeatKick 的 dataset.bot 分支） */
  onSeatKick(seat, isBot) {
    if (!Number.isInteger(seat)) return;
    if (isBot) nav.send({ t: 'removeBot', seat });
    else nav.send({ t: 'kick', seat });
  }

  onShare() {
    const code = this.code;
    console.info('[share] onShare 触发，房间码 =', code);
    if (!code) return;
    /**
     * 时序（2026-11-04 修复）：**先完成剪贴板写入（含必要的隐私授权弹窗），再拉起
     * 转发面板**。之前 write() 与 shareAppMessage 同步并发 —— 剪贴板被隐私 API 拦下
     * 时授权弹窗和转发面板叠在一起，用户既点不了弹窗也关不掉面板（报障：
     * "还没同意/拒绝就弹出分享弹框"）。授权弹窗必须独占交互，序列化后互不干扰。
     * @param {string} ok '' = 首次；'retry' = 隐私授权后的重试
     */
    const write = (ok, onDone) => {
      wx.setClipboardData({
        data: '来一起打麻将！房间码 ' + code + '，进入小游戏后输入房间码加入。',
        success: () => {
          console.info('[share] 邀请文案已写入剪贴板' + (ok === 'retry' ? '（授权后重试成功）' : ''));
          onDone();
        },
        fail: (e) => {
          const msg = (e && e.errMsg) || '';
          console.warn('[share] 剪贴板写入失败：', msg);
          if (ok !== 'retry' && /privacy|privacy agreement/i.test(msg)) {
            privacy.authorize((granted) => {
              if (granted) {
                console.info('[share] 隐私授权通过，重试剪贴板写入');
                write('retry', onDone);
              } else {
                toast.push('需同意《用户隐私保护指引》才能复制邀请文案', 2400);
                onDone(); // 拒绝授权也继续分享：剪贴板兜底失效但不阻断主流程
              }
            });
            return;
          }
          onDone(); // 非 privacy 类失败：照常继续
        },
      });
    };
    write('', () => {
      // 剪贴板就绪（或已放弃）后拉起转发面板（对位小程序大厅 <button open-type="share">）：
      // 卡片 query 带 room=<码>，对方点开由 home 场景自动进房，不用再手填。
      if (wx.shareAppMessage) {
        console.info('[share] 调用 wx.shareAppMessage 拉起转发面板');
        wx.shareAppMessage({ title: '来一局麻将（房间 ' + code + '）', query: 'room=' + code });
        return;
      }
      // 老基础库没有主动转发：文案已在剪贴板，提示用户直接粘给朋友
      toast.push('邀请文案已复制，可直接粘贴发给朋友；房间码 ' + code, 2600);
    });
  }

  /* ---------------- 路由回调 ---------------- */

  onEvent(msg) {
    this.feed = [msg.text].concat(this.feed);
    if (this.feed.length > FEED_MAX) this.feed.length = FEED_MAX;
  }

  onError(reason) {
    // 「对局进行中」= 服务端已坐上牌桌而人还停在大厅：直接回牌桌并 resync
    if (String(reason || '').indexOf('对局进行中') >= 0) {
      nav.recoverGame();
      return;
    }
    this.feed = ['⚠ ' + reason].concat(this.feed);
    if (this.feed.length > FEED_MAX) this.feed.length = FEED_MAX;
  }

  onSwapAsk(msg) {
    this.swapAskShown = true;
    this.swapAskText = this.wind(msg.from) + '家「' + msg.fromName + '」想与你交换座位，是否同意？';
  }

  onSwapRespond(accept) {
    this.swapAskShown = false;
    nav.send({ t: 'swapRespond', accept });
  }

  onVariant(msg) {
    const s = state.lastState;
    if (s) {
      const me = (s.players || []).find((p) => p.seat === s.you);
      this.buildVariantSwitch(msg.variant, !!(me && me.isHost));
    }
    if (msg.totals && s) {
      const next = Object.assign({}, s, { totals: msg.totals });
      state.lastState = next;
      this.renderLobby(next);
    }
    toast.push('玩法已切换为「' + variantName(msg.variant) + '」' + (msg.cleared ? '，积分已清零' : ''));
  }

  onDissolved(msg) {
    this.dissolvedShown = true;
    this.dissolvedTitle = msg.title;
    this.dissolvedRows = (msg.rows || []).map((r) => ({ name: r.name, value: r.value }));
  }

  onDissolvedOk() {
    this.dissolvedShown = false;
    nav.resetChat();
    net.closeSocket();
    nav.navigate('home');
  }

  /* ---------------- 触摸 ---------------- */

  onTouchDown(x, y) {
    const u = this.ui;
    this.pressed = '';
    // 设置面板在最上层：在屏时吞掉一切触摸（含面板内空白）
    if (settingsPanel.down(x, y, this)) return;
    // 与 onTap 的 dice.shown 守卫同口径：覆盖层下不进按压态（否则抬手前按钮闪一下按压框）
    if (this.dice.shown) return;
    // feed 拖拽起点（scroll-view 语义）
    if (u.feedRect && draw.hit(u.feedRect, x, y)) {
      this.feedDrag = { lastY: y, moved: false };
      return;
    }
    const zones = [
      ...(u.variantOpts || []),
      u.btnSettings ? { id: 'settings', rect: u.btnSettings } : null,
      u.btnShare,
      u.btnVoice ? { id: 'voice', rect: u.btnVoice } : null,
      u.btnVoiceEar ? { id: 'voiceEar', rect: u.btnVoiceEar } : null,
      u.btnRoll,
      ...(u.seatKick || []),
      ...((u.seatRects || []).map((s) => ({ id: 'seat' + s.seat, rect: s }))),
      u.btnReady,
      u.btnBot,
      u.btnDissolve,
      u.btnLeave,
      ...((u.layerBtns || [])),
    ].filter(Boolean);
    for (const z of zones) {
      if (draw.hit(z.rect || z, x, y)) {
        this.pressed = z.id || '';
        break;
      }
    }
  }

  onTouchMove(x, y) {
    if (settingsPanel.move(x, y, this)) return; // 面板拖动滑条
    if (this.feedDrag && this.ui.feedRect) {
      const dy = y - this.feedDrag.lastY;
      this.feedDrag.lastY = y;
      if (Math.abs(dy) > 2) this.feedDrag.moved = true;
      this.feedOffset = Math.max(0, Math.min(this.feedMax || 0, this.feedOffset - dy));
    }
  }

  onTouchUp() {
    if (settingsPanel.up(this)) return; // 抬起即落盘滑条值
    // feed 内的拖拽若位移极小不视为点击（无 feed 内点击交互，直接清即可）
    this.feedDrag = null;
    this.pressed = '';
  }

  onTouchCancel() {
    if (settingsPanel.up(this)) return;
    this.feedDrag = null;
    this.pressed = '';
  }

  onTap(x, y) {
    // 设置面板在屏：只走面板（且必须先于掷骰覆盖层的吞点判断 —— 面板画在覆盖层之上）
    if (settingsPanel.tap(x, y, this)) return;
    // 掷骰覆盖层在屏时全吞点击（2026-11-04 审计 F3）：小程序端覆盖层是全屏 .layer
    // （盖住下层全部按钮），对局场景 chrome.tap 也有同款 `diceFx.shown → return true`；
    // 这里漏了 —— 动画期间能隔着一层动画点「准备/加机器人/解散/离开」改变房间状态。
    if (this.dice.shown) {
      this.feedDrag = null;
      this.pressed = '';
      return;
    }
    if (this.feedDrag && this.feedDrag.moved) {
      this.feedDrag = null;
      return;
    }
    this.feedDrag = null;
    const u = this.ui;
    for (const o of u.variantOpts || []) {
      if (draw.hit(o.rect, x, y)) return this.onPickVariant(o.id);
    }
    if (u.btnSettings && draw.hit(u.btnSettings, x, y)) return settingsPanel.open(this);
    if (draw.hit(u.btnShare, x, y)) return this.onShare();
    if (u.btnVoiceEar && draw.hit(u.btnVoiceEar, x, y)) return this.onVoiceEar();
    if (u.btnVoice && draw.hit(u.btnVoice, x, y)) return this.onVoiceTap();
    if (draw.hit(u.btnRoll, x, y)) return this.onRollDealer();
    for (const k of u.seatKick || []) {
      if (draw.hit(k.rect, x, y)) return this.onSeatKick(k.seat, k.isBot);
    }
    if (draw.hit(u.btnReady, x, y)) return this.onToggleReady();
    if (draw.hit(u.btnBot, x, y)) return this.onAddBot();
    if (draw.hit(u.btnDissolve, x, y)) return this.onDissolve();
    if (draw.hit(u.btnLeave, x, y)) return this.onLeave();
    for (const b of u.layerBtns || []) {
      if (draw.hit(b.rect, x, y)) return b.fn();
    }
    // 点弹框外（遮罩）→ 关闭（取消/拒绝，或解散表的「关闭」）
    if (u.layerDismiss && u.layerCard && !draw.hit(u.layerCard, x, y)) {
      u.layerDismiss();
      return;
    }
    // 点座位卡（弹层未开时才有效，对位 layer 挡住下层点击）
    if (!this.anyLayer()) {
      for (const s of u.seatRects || []) {
        if (draw.hit(s, x, y)) return this.onSeatTap(s.seat);
      }
    }
  }

  anyLayer() {
    return (
      this.swapAskShown ||
      this.leaveAskShown ||
      this.dissolveAskShown ||
      this.variantConfirmShown ||
      this.dissolvedShown ||
      this.dice.shown
    );
  }

  /* ---------------- 渲染（lobby.wxss 紧凑档逐项对照） ---------------- */

  render(ctx, L) {
    this.ui = {};
    const u = this.ui;
    const padL = L.safe.l + 12;
    const padR = L.safe.r + 12;
    const padT = L.safe.t + 8;
    const padB = 8;
    draw.pageBg(ctx, L, 'cloud');

    let y = padT;
    const contentW = L.sw - padL - padR;
    if (this.netShown) {
      const bh = 19;
      ctx.fillStyle = 'rgba(224,122,106,0.16)';
      draw.roundRect(ctx, padL, y, contentW, bh, 5);
      ctx.fill();
      draw.text(ctx, this.netText, padL + 10, y + bh / 2, { size: 11, color: C.red, maxW: contentW - 20 });
      y += bh + 6;
    }

    // —— 表头：房间码 + 徽章 | 我的信息 + 分享 ——
    draw.text(ctx, '房间码', padL, y + 9, { size: 12, color: C.muted });
    const codeX = padL + 40;
    draw.text(ctx, this.code, codeX, y + 9, { size: 12, color: C.goldSoft, bold: true });
    let hx = codeX + draw.measure(ctx, this.code, 12, true) + 6;
    if (this.variantLabel) {
      const bw = draw.measure(ctx, this.variantLabel, 10) + 16;
      ctx.fillStyle = 'rgba(230,193,75,0.16)';
      draw.roundRect(ctx, hx, y + 1, bw, 16, 8);
      ctx.fill();
      draw.text(ctx, this.variantLabel, hx + bw / 2, y + 9.5, { size: 10, color: C.goldSoft, align: 'center' });
      hx += bw + 6;
    }
    /*
     * 声音设置入口（2026-11-04）：放在**房间码/玩法徽章右侧**，不占右侧胶囊带 ——
     * 右侧已被「分享房间码 + 麦克风/扬声器」占满，且必须避让胶囊（见下段注释）。
     * 26×26 与表头行同高，点开画布版设置面板。
     */
    const setW = 26;
    u.btnSettings = { x: hx, y, w: setW, h: 26 };
    btn.icon(ctx, u.btnSettings, { label: '⚙️', vec: 'gear', size: 12, pressed: this.pressed === 'settings' }); // ⚙️ 带 VS16 真机不居中 → 矢量齿轮
    hx += setW + 6;
    /*
     * 胶囊避让（2026-11-02，用户报「分享房间码被胶囊压住点不到」）：表头右侧的
     * 可点控件以**胶囊左缘 − 8** 为右界 —— 分享钮贴着胶囊左侧收排，「我的信息」
     * 文本让位到分享钮左侧。拿不到胶囊（API 特性检测失败）退 padR（旧行为）。
     * 胶囊高 32、顶 ~6：表头行（y..y+26）纵向在胶囊带内，横向必须避让。
     */
    const cap = L.cap || layout.capsuleRect();
    const headerRight = cap && cap.left > 0 ? Math.round(cap.left) - 8 : padL + contentW;
    const shareW = 92;
    u.btnShare = { x: headerRight - shareW, y, w: shareW, h: 26 };
    btn.render(ctx, u.btnShare, { label: '分享房间码', kind: 'ghost', size: 11, pressed: this.pressed === 'share' });
    // 房间语音 chip（2026-11-03 反馈：可选开启 + 麦克风/扬声器双开关，对位 lobby.wxml 双 chip）：
    // 麦克风 chip（未开启=「开语音」入口）贴分享钮左侧；扬声器 chip（开启后出现）在其左
    if (this.voiceAvailable) {
      const micLabel = this.voiceBusy
        ? '语音…'
        : this.voiceOn
          ? this.voiceMuted
            ? '已闭麦'
            : '麦克风'
          : '开语音';
      const micIco = this.voiceBusy ? '…' : this.voiceOn ? (this.voiceMuted && this.voiceEar ? '🔇' : '🎤') : '🎤'; // 🎤 无 VS16（🎙️ 真机不居中，2026-11-05 换）
      const micOn = this.voiceOn && !this.voiceMuted;
      const micW = draw.measure(ctx, micLabel, 10) + 30;
      const micRect = { x: headerRight - shareW - 6 - micW, y, w: micW, h: 26 };
      u.btnVoice = micRect;
      let leftX = micRect.x;
      // 扬声器 chip：**常驻**（2026-11-03 反馈）——未加入语音时也可设偏好（入会时生效）
      {
        const earLabel = this.voiceEar ? '已静音' : '扬声器';
        const earW = draw.measure(ctx, earLabel, 10) + 30;
        const earRect = { x: micRect.x - 6 - earW, y, w: earW, h: 26 };
        u.btnVoiceEar = earRect;
        const earPressed = this.pressed === 'voiceEar';
        ctx.fillStyle = earPressed ? 'rgba(255,255,255,0.3)' : this.voiceEar ? 'rgba(255,255,255,0.06)' : 'rgba(230,193,75,0.16)';
        draw.roundRect(ctx, earRect.x, earRect.y, earRect.w, earRect.h, 13);
        ctx.fill();
        ctx.strokeStyle = earPressed ? C.gold : this.voiceEar ? 'rgba(255,255,255,0.1)' : 'rgba(246,227,161,0.4)';
        ctx.stroke();
        draw.icon(ctx, this.voiceEar ? '🔕' : '🔊', earRect.x + 14, earRect.y + 13.5, { size: 11, color: this.voiceEar ? C.muted : C.goldSoft });
        draw.text(ctx, earLabel, earRect.x + 26, earRect.y + 13.5, { size: 10, color: this.voiceEar ? C.muted : C.goldSoft });
        leftX = earRect.x;
      }
      // micOn 激活底色 0.16→0.38（2026-11-04，与 app.wxss .voice-chip.on 同修）：
      // 16% 金叠绿桌合成后与背景同色，激活态看着像空心金圈（用户报障）
      ctx.fillStyle = this.pressed === 'voice' ? 'rgba(255,255,255,0.3)' : micOn ? 'rgba(230,193,75,0.38)' : 'rgba(255,255,255,0.08)';
      draw.roundRect(ctx, micRect.x, micRect.y, micRect.w, micRect.h, 13);
      ctx.fill();
      ctx.strokeStyle = this.pressed === 'voice' ? C.gold : micOn ? 'rgba(246,227,161,0.55)' : 'rgba(255,255,255,0.14)';
      ctx.stroke();
      // 有人说话：金色呼吸光环（正弦调 alpha，对位 .voice-chip.speaking 的 keyframes）
      if (this.voiceSpeaking && micOn) {
        ctx.save();
        ctx.globalAlpha = 0.3 + 0.3 * Math.sin(Date.now() / 300);
        ctx.strokeStyle = 'rgba(246,227,161,0.8)';
        ctx.lineWidth = 2;
        draw.roundRect(ctx, micRect.x - 2, micRect.y - 2, micRect.w + 4, micRect.h + 4, 15);
        ctx.stroke();
        ctx.restore();
      }
      draw.icon(ctx, micIco, micRect.x + 14, micRect.y + 13.5, { size: 11, color: micOn ? C.goldSoft : this.voiceMuted && this.voiceOn ? C.muted : C.text });
      draw.text(ctx, micLabel, micRect.x + 26, micRect.y + 13.5, { size: 10, color: micOn ? C.goldSoft : this.voiceOn && this.voiceMuted ? C.muted : C.text });
      u.voiceClusterLeft = leftX;
    }
    const meRight = u.voiceClusterLeft ? u.voiceClusterLeft - 12 : headerRight - shareW - 12;
    const meW = meRight - hx - 6;
    if (meW > 40) draw.text(ctx, this.meText, meRight, y + 13, { size: 11, color: C.tag, align: 'right', maxW: meW });
    y += 26 + 6;

    // —— 主体左右分栏：左 = 定庄 + 座位；右 = 玩法切换 + 事件流（300px）——
    const actionsH = 30 + 6; // 底部按钮行预留
    const sideW = 300;
    const mainW = contentW - sideW - 10;
    const bodyH = L.sh - padB - y - actionsH;

    // 左栏
    if (this.drShown) {
      // .dealer-dice：金底面板：说明文字 + 打骰子按钮
      const dh = 40;
      ctx.fillStyle = 'rgba(230,193,75,0.1)';
      draw.roundRect(ctx, padL, y, mainW, dh, 8);
      ctx.fill();
      ctx.strokeStyle = 'rgba(230,193,75,0.3)';
      ctx.stroke();
      draw.text(ctx, '首局定庄：四人各掷一次，点数最大者坐庄（并列重掷）', padL + 8, y + 15, {
        size: 11,
        color: C.goldSoft,
        maxW: mainW - 16 - 80,
      });
      u.btnRoll = { x: padL + mainW - 8 - 80, y: y + 6, w: 80, h: 28 };
      btn.render(ctx, u.btnRoll, {
        label: this.drText,
        kind: 'primary',
        disabled: this.drDisabled,
        size: 11,
        pressed: this.pressed === 'roll',
      });
      y += dh + 6;
    }

    // 座位：一排 4 张卡
    const seatsH = Math.max(84, Math.min(104, bodyH - 24 - 6 - (this.allReady ? 24 : 0)));
    const seatW = (mainW - 6 * 3) / 4;
    u.seatRects = [];
    this.seats.forEach((seat, i) => {
      const r = { x: padL + i * (seatW + 6), y, w: seatW, h: seatsH };
      u.seatRects.push(Object.assign({ seat: seat.seat }, r));
      ctx.save();
      if (this.pressed === 'seat' + seat.seat) {
        ctx.translate(r.x + r.w / 2, r.y + r.h / 2);
        ctx.scale(0.97, 0.97);
        ctx.translate(-(r.x + r.w / 2), -(r.y + r.h / 2));
      }
      ctx.fillStyle = 'rgba(255,255,255,0.03)';
      draw.roundRect(ctx, r.x, r.y, r.w, r.h, 8);
      ctx.fill();
      ctx.strokeStyle = seat.self ? 'rgba(230,193,75,0.6)' : seat.ready ? 'rgba(67,192,124,0.5)' : C.cardBorder;
      ctx.stroke();
      // 座位级语音指示（2026-11-03 二期）：正在说话=绿环呼吸；降级（说话人事件
      // 从不触发，2026-11-05 B 方案）=「开麦即亮」**常亮**绿环，与呼吸模式可辨；
      // 闭麦且关扬声器=右上角 🔇（对位 lobby.wxml 的 .seat-voice 角标）
      if (seat.voiceSpeaking) {
        ctx.save();
        ctx.globalAlpha = reactive ? 0.45 + 0.4 * Math.sin(Date.now() / 300) : 0.85;
        ctx.strokeStyle = 'rgba(67,192,124,0.9)';
        ctx.lineWidth = 2;
        draw.roundRect(ctx, r.x - 2, r.y - 2, r.w + 4, r.h + 4, 10);
        ctx.stroke();
        ctx.restore();
      }
      // 闭麦角标挪到头像右下角（2026-11-05）：原画在首行文字带（x+w-38, y+13）与
      // 「X家 · 房主」重叠 —— 首行 maxW 没给它留位。见下方头像之后的徽章绘制。
      const ix = r.x + 8;
      let sy = r.y + 12;
      draw.text(ctx, seat.wind + '家' + (seat.host ? ' · 房主' : ''), ix, sy, { size: 11, color: C.muted, maxW: r.w - 16 });
      sy += 16;
      // 头像（2026-11-04）：卡片右上角圆形头像；空位/未选画空心圆占位
      const avR = 13;
      const avCx = r.x + r.w - 8 - avR;
      const avCy = r.y + 8 + avR;
      this.drawSeatAvatar(ctx, seat.avatar, avCx, avCy, avR);
      // 2026-11-05：🔇 角标 = 闭麦 且 关扬声器；单独闭麦不画 🔇（对位 lobby.wxml 的 .seat-voice 角标）
      if (seat.voiceMuted && seat.voiceEar) {
        const bx = avCx + 11 - 8.5;
        const by = avCy + 11 - 8.5;
        ctx.fillStyle = 'rgba(8,12,18,0.78)';
        draw.roundRect(ctx, bx, by, 17, 17, 8.5);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.stroke();
        draw.text(ctx, '🔇', bx + 8.5, by + 9, { size: 10, color: '#c9d2cc', align: 'center' });
      }
      const nameW = r.w - 16 - (seat.avatar ? 32 : 0);
      draw.text(ctx, seat.name, ix, sy, { size: 12, color: C.text, bold: true, maxW: nameW });
      if (!seat.empty) {
        const nw = Math.min(draw.measure(ctx, seat.name, 12, true), nameW);
        const scColor = seat.scoreClass === 'pos' ? C.green : seat.scoreClass === 'neg' ? C.red : C.muted;
        draw.text(ctx, ' ' + seat.score, ix + nw, sy, { size: 11, color: scColor, maxW: nameW - nw });
      }
      sy += 16;
      if (seat.rollText) {
        draw.text(ctx, seat.rollText, ix, sy, { size: 10, color: C.goldSoft, maxW: nameW });
        sy += 13;
      }
      draw.text(ctx, seat.state, ix, sy + 1, { size: 11, color: seat.offline ? C.red : C.muted, maxW: nameW });
      sy += 15;
      if (seat.tip) {
        const tc = seat.tipClass === 'pending' ? C.gold : seat.tipClass === 'ask' ? C.goldSoft : C.muted;
        draw.text(ctx, seat.tip, ix, sy, { size: 10, color: tc, maxW: nameW });
        sy += 14;
      }
      if (seat.kickable) {
        const kw = 40;
        const kr = { x: r.x + r.w - 8 - kw, y: r.y + r.h - 8 - 22, w: kw, h: 22 };
        btn.render(ctx, kr, { label: seat.kickLabel, size: 10, pressed: this.pressed === 'kick' + seat.seat });
        (u.seatKick = u.seatKick || []).push({ id: 'kick' + seat.seat, rect: kr, seat: seat.seat, isBot: seat.bot });
      }
      ctx.restore();
    });
    y += seatsH + 6;

    draw.text(ctx, '点其他座位可换位：空位直接换；有人则向对方发起请求，等对方同意。', padL, y + 8, {
      size: 11,
      color: C.muted,
      maxW: mainW,
    });
    y += 22;
    if (this.allReady) {
      const gw = draw.measure(ctx, '4 人已全部准备', 11) + 16;
      ctx.fillStyle = 'rgba(67,192,124,0.16)';
      draw.roundRect(ctx, padL, y, Math.max(gw, 110), 22, 8);
      ctx.fill();
      draw.text(ctx, '4 人已全部准备', padL + Math.max(gw, 110) / 2, y + 11, { size: 11, color: C.green, align: 'center' });
    }

    // 右栏：玩法切换（仅房主）+ 事件流
    const sideX = padL + mainW + 10;
    let sy2 = padT + (this.netShown ? 25 : 0) + 32;
    if (this.variantSwitchShown) {
      draw.text(ctx, '玩法', sideX, sy2 + 13, { size: 11, color: C.muted });
      let vx = sideX + 26;
      u.variantOpts = this.variantOpts.map((o) => {
        const w = draw.measure(ctx, o.name, 11) + 16;
        const r = { x: vx, y: sy2, w, h: 26 };
        vx += w + 6;
        return { id: o.id, rect: r, name: o.name, active: o.active };
      });
      for (const o of u.variantOpts) {
        if (o.active) {
          // on 态：金底深字（button.on）
          ctx.fillStyle = C.gold;
          draw.roundRect(ctx, o.rect.x, o.rect.y, o.rect.w, o.rect.h, 5);
          ctx.fill();
          ctx.strokeStyle = C.goldSoft;
          ctx.stroke();
          draw.text(ctx, o.name, o.rect.x + o.rect.w / 2, o.rect.y + o.rect.h / 2, {
            size: 11,
            color: C.goldDark,
            align: 'center',
            bold: true,
          });
        } else {
          btn.render(ctx, o.rect, { label: o.name, size: 11, pressed: this.pressed === o.id });
        }
      }
      sy2 += 26 + 8;
    }
    // feed（触摸拖拽滚动；最新在上，对位 scroll-view 顶部对齐）
    const feedRect = { x: sideX, y: sy2, w: sideW, h: L.sh - padB - actionsH - sy2 };
    u.feedRect = feedRect;
    ctx.save();
    draw.roundRect(ctx, feedRect.x, feedRect.y, feedRect.w, feedRect.h, 6);
    ctx.clip();
    const lineH = 15;
    const contentH = this.feed.length * lineH;
    this.feedMax = Math.max(0, contentH - feedRect.h);
    this.feedOffset = Math.max(0, Math.min(this.feedMax, this.feedOffset));
    let fy = feedRect.y - this.feedOffset + 6;
    for (const item of this.feed) {
      if (fy > feedRect.y + feedRect.h) break;
      if (fy + lineH >= feedRect.y) {
        draw.text(ctx, item, feedRect.x + 2, fy + lineH / 2, { size: 11, color: C.tag, maxW: feedRect.w - 4 });
      }
      fy += lineH;
    }
    ctx.restore();

    // —— 底部动作行（按钮恒在：加机器人满员置灰不消失，位置钉死） ——
    const ay = L.sh - padB - 30;
    let ax = padL;
    const readyW = draw.measure(ctx, this.readyText, 12) + 24;
    u.btnReady = { x: ax, y: ay, w: Math.max(64, readyW), h: 30 };
    btn.render(ctx, u.btnReady, { label: this.readyText, kind: 'primary', size: 12, disabled: this.playing, pressed: this.pressed === 'ready' });
    ax += u.btnReady.w + 6;
    if (this.isHost) {
      const bw = draw.measure(ctx, '加机器人', 12) + 24;
      u.btnBot = { x: ax, y: ay, w: Math.max(64, bw), h: 30 };
      btn.render(ctx, u.btnBot, {
        label: this.botFull ? '已满4人' : '加机器人',
        disabled: this.botFull,
        size: 12,
        pressed: this.pressed === 'bot',
      });
      ax += u.btnBot.w + 6;
    }
    if (this.isHost) {
      const bw = draw.measure(ctx, '解散牌桌', 12) + 24;
      u.btnDissolve = { x: ax, y: ay, w: Math.max(64, bw), h: 30 };
      btn.render(ctx, u.btnDissolve, { label: '解散牌桌', kind: 'danger', size: 12, pressed: this.pressed === 'dissolve' });
      ax += u.btnDissolve.w + 6;
    }
    const lw = draw.measure(ctx, '离开房间', 12) + 24;
    u.btnLeave = { x: padL + contentW - lw, y: ay, w: Math.max(64, lw), h: 30 };
    btn.render(ctx, u.btnLeave, { label: '离开房间', size: 12, pressed: this.pressed === 'leave' });

    // —— 弹层（无遮罩点击关闭，只能点按钮，对位 .layer） ——
    u.layerBtns = [];
    if (this.dice.shown) this.dice.render(ctx, L);
    if (this.swapAskShown) {
      this.layer(ctx, L, '换位请求', this.swapAskText, [
        { label: '拒绝', fn: () => this.onSwapRespond(false) },
        { label: '同意', kind: 'primary', fn: () => this.onSwapRespond(true) },
      ]);
    } else if (this.leaveAskShown) {
      this.layer(ctx, L, '离开房间', '离开后座位会释放，再回来需要重新输入房间码。', [
        { label: '再等等', fn: () => this.onLeaveConfirm(false) },
        { label: '离开', kind: 'danger', fn: () => this.onLeaveConfirm(true) },
      ]);
    } else if (this.dissolveAskShown) {
      this.layer(ctx, L, '解散牌桌', '所有玩家将退出房间，并弹出最终积分。此操作不可撤销。', [
        { label: '取消', fn: () => this.onDissolveConfirm(false) },
        { label: '解散', kind: 'primary', fn: () => this.onDissolveConfirm(true) },
      ]);
    } else if (this.variantConfirmShown) {
      this.layer(ctx, L, '切换玩法', this.variantConfirmText, [
        { label: '取消', fn: () => this.onVariantCancel() },
        { label: '保留积分', fn: () => this.onVariantKeep() },
        { label: '清除积分', kind: 'primary', fn: () => this.onVariantClear() },
      ]);
    } else if (this.dissolvedShown) {
      this.dissolvedLayer(ctx, L);
    }
    // 设置面板最后画（在掷骰覆盖层与各类弹层之上）—— 与 onTap 里「面板最先判定」对称，
    // 否则会出现「点得到但看不见 / 看得见点不到」的错位
    settingsPanel.render(ctx, L, this);
  }

  /** 通用确认浮层（.layer / .layer-card）：标题 + 文本 + 右对齐按钮行 */
  layer(ctx, L, title, body, actions) {
    ctx.fillStyle = C.layerBg;
    ctx.fillRect(0, 0, L.sw, L.sh);
    const cardW = Math.min(L.sw * 0.88, 460);
    const cardH = 132;
    const cx = (L.sw - cardW) / 2;
    const cy = (L.sh - cardH) / 2;
    ctx.fillStyle = C.layerCard;
    draw.roundRect(ctx, cx, cy, cardW, cardH, 8);
    ctx.fill();
    ctx.strokeStyle = C.layerBorder;
    ctx.stroke();
    draw.text(ctx, title, cx + 16, cy + 20, { size: 15, color: C.goldSoft, bold: true });
    draw.text(ctx, body, cx + 16, cy + 44, { size: 12, color: C.text, maxW: cardW - 32 });
    const u = this.ui;
    // 弹框外（遮罩）点击 = 第一个动作（拒绝/再等等/取消）：唯一安全的默认项
    u.layerCard = { x: cx, y: cy, w: cardW, h: cardH };
    u.layerDismiss = actions[0] ? actions[0].fn : null;
    let bx = cx + cardW - 16;
    const by = cy + cardH - 14 - 30;
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      const w = draw.measure(ctx, a.label, 12) + 24;
      bx -= w;
      const r = { x: bx, y: by, w, h: 30 };
      btn.render(ctx, r, { label: a.label, kind: a.kind, size: 12, pressed: this.pressed === 'layer' + i });
      u.layerBtns.push({ id: 'layer' + i, rect: r, fn: a.fn });
      bx -= 6;
    }
  }

  /** 解散最终积分浮层（.tbl 两列表） */
  dissolvedLayer(ctx, L) {
    ctx.fillStyle = C.layerBg;
    ctx.fillRect(0, 0, L.sw, L.sh);
    const cardW = Math.min(L.sw * 0.88, 380);
    const rows = this.dissolvedRows.length + 1;
    const cardH = 60 + rows * 22 + 14 + 30 + 14;
    const cx = (L.sw - cardW) / 2;
    const cy = Math.max(10, (L.sh - cardH) / 2);
    // 弹框外（遮罩）点击 = 「关闭」
    this.ui.layerCard = { x: cx, y: cy, w: cardW, h: cardH };
    this.ui.layerDismiss = () => this.onDissolvedOk();
    ctx.fillStyle = C.layerCard;
    draw.roundRect(ctx, cx, cy, cardW, cardH, 8);
    ctx.fill();
    ctx.strokeStyle = C.layerBorder;
    ctx.stroke();
    draw.text(ctx, this.dissolvedTitle, cx + 16, cy + 20, { size: 15, color: C.goldSoft, bold: true });
    // 表格
    const tx = cx + 16;
    const tw = cardW - 32;
    let ty = cy + 38;
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(tx, ty, tw, 22);
    draw.text(ctx, '玩家', tx + tw * 0.25, ty + 11, { size: 12, color: C.muted, align: 'center' });
    draw.text(ctx, '总积分', tx + tw * 0.75, ty + 11, { size: 12, color: C.muted, align: 'center' });
    ty += 22;
    for (const r of this.dissolvedRows) {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath();
      ctx.moveTo(tx, ty + 0.5);
      ctx.lineTo(tx + tw, ty + 0.5);
      ctx.stroke();
      draw.text(ctx, r.name, tx + tw * 0.25, ty + 12, { size: 12, color: C.text, align: 'center', maxW: tw * 0.5 });
      const vc = r.value > 0 ? C.green : r.value < 0 ? C.red : C.text;
      draw.text(ctx, (r.value > 0 ? '+' : '') + r.value, tx + tw * 0.75, ty + 12, {
        size: 12,
        color: vc,
        align: 'center',
        bold: true,
      });
      ty += 22;
    }
    const bw = draw.measure(ctx, '关闭', 12) + 24;
    const br = { x: cx + cardW - 16 - bw, y: cy + cardH - 14 - 30, w: bw, h: 30 };
    btn.render(ctx, br, { label: '关闭', kind: 'primary', size: 12, pressed: this.pressed === 'dissolvedOk' });
    this.ui.layerBtns.push({ id: 'dissolvedOk', rect: br, fn: () => this.onDissolvedOk() });
  }

  /**
   * 座位卡头像（2026-11-04）：圆形裁剪绘制玩家头像；没头像（空位/未选/未解码）画空心圆占位。
   */
  drawSeatAvatar(ctx, id, cx, cy, r) {
    const img = id ? avatarart.art(id) : null;
    if (!img) {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 1;
      ctx.stroke();
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    try {
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    } catch (e) {
      /* 解码中跳过 */
    }
    ctx.restore();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

module.exports = LobbyScene;
