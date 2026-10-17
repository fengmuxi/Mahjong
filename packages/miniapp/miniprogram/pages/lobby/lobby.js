/**
 * 大厅（房间）：座位卡 / 准备 / 换位 / 加机器人 / 首局定庄掷骰 / 玩法切换 / 分享。
 *
 * 逻辑与 web 端 `renderLobby()` 一一对应；风位一律走 `seatWind(seat, dealer)`（**风位随庄**），
 * 不直接用座位基准序。协议字段不变（`state` 消息的 you / players / totals / dealerRolls / …）。
 */

const { seatWind } = require('../../lib/shared/tiles.js');
const { VARIANT_LIST, variantName, getRules } = require('../../lib/shared/rules/index.js');
const room = require('../../utils/room.js');
const net = require('../../utils/net.js');
const ui = require('../../utils/ui.js');
const diceUtil = require('../../utils/dice.js');

const FEED_MAX = 200;

Page({
  data: {
    code: '',
    // 页面切换转场：room.js 跳转前置 true → 根节点 .page-leaving 淡出后再 redirectTo
    pageLeaving: false,
    variantLabel: '',
    meText: '',
    seats: [],
    readyText: '准备',
    allReady: false,
    showDissolve: false,
    showAddBot: false,
    drShown: false,
    drText: '打骰子',
    drDisabled: false,
    variantSwitchShown: false,
    variantOpts: [],
    variantCurrent: '',
    feed: [],
    swapAskShown: false,
    swapAskText: '',
    dissolveAskShown: false,
    variantConfirmShown: false,
    variantConfirmText: '',
    diceShown: false,
    diceMsg: '',
    // 两枚骰子：{ idx, rows(3×3 点子网格), tumbling, land }（与对局页共用 utils/dice.js）
    dice: diceUtil.pair(1, 1, false, false),
    netShown: false,
    netText: '',
    toastShown: false,
    toastText: '',
  },

  onShow() {
    room.attach('lobby', this);
    const g = getApp().globalData;
    if (g.lastState) this.renderLobby(g.lastState);
    this.syncNet();
  },

  onHide() {
    room.detach(this);
  },

  onUnload() {
    room.detach(this);
  },

  onNetStatus(s) {
    const text = net.describe(s);
    this.setData({ netText: text, netShown: !!text });
  },

  syncNet() {
    this.onNetStatus({
      state: net.getState(),
      inRoom: true,
      everConnected: net.hasConnected(),
      error: net.getLastError(),
      url: net.getUrl(),
    });
  },

  wind(seat) {
    return seatWind(seat, getApp().globalData.dealer || 0);
  },

  // ---------- 大厅渲染 ----------

  onState(s) {
    this.renderLobby(s);
  },

  renderLobby(s) {
    const g = getApp().globalData;
    g.lastState = s;
    // 风位随庄：大厅的一切风位显示都按当前庄家换算（与 web 端 curDealer 同一来源）
    g.dealer = s.dealer || 0;
    g.mySeat = s.you;
    const dealerRolls = s.dealerRolls || [];
    const dealerDecided = !!s.dealerDecided;
    const needRoll = getRules(s.variant).flow.firstDealerRoll === true;
    const inDealerRoll = needRoll && !dealerDecided;
    const me = (s.players || []).find((p) => p.seat === s.you);
    const meScore = (s.totals && s.totals[s.you]) || 0;

    const seats = [];
    for (let seat = 0; seat < 4; seat++) {
      const p = (s.players || []).find((x) => x.seat === seat);
      const isSelf = seat === s.you;
      const offline = !!p && p.connected === false;
      const tv = (s.totals && s.totals[seat]) || 0;
      const roll = needRoll ? dealerRolls.find((r) => r.seat === seat) : null;
      let state = '';
      if (!p) state = '';
      else if (p.isBot) state = '机器人 · 托管中';
      else if (offline) state = '掉线 · 等待重连';
      else if (p.ready) state = '已准备';
      else state = '未准备';
      const ps = s.pendingSwap;
      let tip = '';
      let tipClass = '';
      if (ps && ps.from === seat) {
        tip = `请求换到 ${this.wind(ps.to)}家…`;
        tipClass = 'pending';
      } else if (ps && ps.to === seat) {
        tip = '收到换位请求';
        tipClass = 'ask';
      } else if (!isSelf && !(p && p.isBot)) {
        tip = p ? '点击换位' : '空位 · 点此换入';
        tipClass = '';
      }
      seats.push({
        seat,
        wind: this.wind(seat),
        host: !!(p && p.isHost),
        empty: !p,
        self: isSelf,
        bot: !!(p && p.isBot),
        name: p ? p.name : '等待加入…',
        score: tv > 0 ? `+${tv}` : `${tv}`,
        scoreClass: tv > 0 ? 'pos' : tv < 0 ? 'neg' : 'zero',
        rollText: roll ? `${roll.dice[0]} + ${roll.dice[1]} = ${roll.sum} 点` : '',
        state,
        offline,
        ready: !!(p && p.ready),
        kickable: !!(p && p.isBot && me && me.isHost),
        tip,
        tipClass,
        swappable: !isSelf && !(p && p.isBot),
      });
    }

    const patch = {
      code: s.code,
      variantLabel: variantName(s.variant),
      variantCurrent: s.variant,
      meText: me ? `${this.wind(s.you)}家 · ${me.name} · ${meScore > 0 ? '+' : ''}${meScore}分` : '',
      seats,
      readyText: me && me.ready ? '取消准备' : '准备',
      allReady: !!s.allReady,
      showDissolve: !!(me && me.isHost),
      showAddBot: !!(me && me.isHost) && (s.players || []).length < 4,
      drShown: inDealerRoll,
      drDisabled: !!dealerRolls.find((r) => r.seat === s.you) || !me || (s.players || []).length < 4,
      drText: dealerRolls.find((r) => r.seat === s.you)
        ? `已掷出 ${dealerRolls.find((r) => r.seat === s.you).sum} 点`
        : '打骰子',
    };
    this.setData(patch);
    this.buildVariantSwitch(s.variant, !!(me && me.isHost));

    // 定庄掷骰的**覆盖层动画只在自己掷骰时播**（2026-10-17 用户要求）：
    // 四人各掷一次定庄，别人（含机器人）掷骰只需要事件流里那行文字，
    // 不该在别人屏幕上弹一次「自己掷骰」的骰子动画。
    // 首帧（刚进大厅 / 对局解散后回大厅）一律只登记 key、不播 —— 定庄记录是房间持久状态，
    // 重播历史会让人误以为「又在开局」。
    if (needRoll && dealerRolls.length > 0) {
      const latest = dealerRolls[dealerRolls.length - 1];
      const key = `${dealerRolls.length}-${latest.seat}-${latest.sum}`;
      const mine = latest.seat === s.you;
      if (this.diceKey === key) {
        // 已处理过
      } else if (this.diceKey === undefined || !mine) {
        this.diceKey = key; // 首帧 / 别人掷骰：静默登记，动画交给事件流文字
      } else {
        const who =
          ((s.players || []).find((p) => p.seat === latest.seat) || {}).name ||
          `${this.wind(latest.seat)}家`;
        this.runDiceAnim(
          latest.dice,
          key,
          `${who} 掷骰…`,
          `${who} 掷出 ${latest.dice[0]} + ${latest.dice[1]} = ${latest.sum} 点`,
          1200,
          2600,
        );
      }
    }
  },

  /** 玩法切换器：仅房主可见可点（与 web 端 buildVariantSwitch 一致） */
  buildVariantSwitch(current, editable) {
    if (!editable) {
      this.setData({ variantSwitchShown: false, variantOpts: [] });
      return;
    }
    this.setData({
      variantSwitchShown: true,
      variantOpts: VARIANT_LIST.map((v) => ({ id: v.id, name: v.name, active: v.id === current })),
    });
  },

  onPickVariant(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.variantCurrent) return;
    this.pendingVariant = id;
    this.setData({
      variantConfirmShown: true,
      variantConfirmText: `切换为「${variantName(id)}」。是否清除此前的累计积分？`,
    });
  },

  onVariantKeep() {
    this.submitVariantSwitch(false);
  },

  onVariantClear() {
    this.submitVariantSwitch(true);
  },

  onVariantCancel() {
    this.pendingVariant = '';
    this.setData({ variantConfirmShown: false });
  },

  submitVariantSwitch(clearScores) {
    const v = this.pendingVariant;
    this.pendingVariant = '';
    this.setData({ variantConfirmShown: false });
    if (!v) return;
    room.send({ t: 'setVariant', variant: v, clearScores });
  },

  // ---------- 掷骰覆盖层 ----------

  runDiceAnim(dice, key, rollingMsg, landMsg, tumbleMs, hideMs) {
    if (this.diceKey === key) return;
    this.diceKey = key;
    this.clearDice();
    // 与对局页同一套：九宫格点子 + 翻滚关键帧 + 定格回弹（utils/dice.js + app.wxss）
    this.setData({
      diceShown: true,
      diceMsg: rollingMsg,
      dice: diceUtil.pair(diceUtil.randFace(), diceUtil.randFace(), true, false),
    });
    this.scrambleTimer = setInterval(() => {
      this.setData({ dice: diceUtil.pair(diceUtil.randFace(), diceUtil.randFace(), true, false) });
    }, 100);
    this.landTimer = setTimeout(() => {
      if (this.scrambleTimer) {
        clearInterval(this.scrambleTimer);
        this.scrambleTimer = null;
      }
      this.setData({ diceMsg: landMsg, dice: diceUtil.pair(dice[0], dice[1], false, true) });
    }, tumbleMs);
    if (hideMs !== undefined) {
      this.hideTimer = setTimeout(() => this.clearDice(), hideMs);
    }
  },

  clearDice() {
    if (this.scrambleTimer) clearInterval(this.scrambleTimer);
    if (this.landTimer) clearTimeout(this.landTimer);
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.scrambleTimer = this.landTimer = this.hideTimer = null;
    this.setData({ diceShown: false });
  },

  // ---------- 交互 ----------

  /**
   * 「准备 / 取消准备」按钮。
   * 注意方法名**不能叫 onReady**：那是 Page 的生命周期（页面首次渲染完成时框架会自动调用），
   * 同名会让玩家一进大厅就被自动置为「已准备」—— 机器人恒就绪 + 首局已定庄时 `canStart`
   * 立即成立，于是「解散对局回大厅后马上又开一局」。2026-10-17 用户报的就是这个。
   */
  onToggleReady() {
    if (!net.isOpen()) return;
    const cancelling = this.data.readyText === '取消准备';
    room.send({ t: 'ready', ready: !cancelling });
  },

  onLeave() {
    room.leaveRoom();
    wx.reLaunch({ url: '/pages/home/home' });
  },

  /**
   * 解散牌桌：开页内确认浮层，不用 wx.showModal（原生弹窗在该环境下点了没反应，
   * 与 game 页「解散对局」同一问题——服务端链路本身已验证正常）。
   */
  onDissolve() {
    this.setData({ dissolveAskShown: true });
  },

  onDissolveConfirm(e) {
    const accept = e.currentTarget.dataset.accept === '1';
    this.setData({ dissolveAskShown: false });
    if (!accept) return;
    if (!net.isOpen()) {
      ui.showToast(this, '连接已断开，无法解散牌桌：请返回首页重连', 3000);
      return;
    }
    room.send({ t: 'dissolve' });
  },

  onAddBot() {
    if (!net.isOpen()) return;
    room.send({ t: 'addBot' });
  },

  onRollDealer() {
    if (!net.isOpen()) return;
    room.send({ t: 'rollDealer' });
  },

  onSeatTap(e) {
    const seat = Number(e.currentTarget.dataset.seat);
    const s = getApp().globalData.lastState;
    if (!s) return;
    const ps = s.pendingSwap;
    if (ps) {
      ui.showToast(
        this,
        ps.from === s.you ? `换位请求处理中：等待 ${this.wind(ps.to)}家同意` : '房间内已有换位请求在处理，请稍候',
      );
      return;
    }
    room.send({ t: 'swap', toSeat: seat });
  },

  onRemoveBot(e) {
    const seat = Number(e.currentTarget.dataset.seat);
    room.send({ t: 'removeBot', seat });
  },

  onShare() {
    const code = this.data.code;
    if (!code) return;
    // 小程序没有「复制链接」：转发卡片自带房间码（path 带 ?room=），另附一份可复制文本
    wx.setClipboardData({
      data: `房间码：${code}（在小程序首页填房间码加入）`,
      success: () => ui.showToast(this, `房间码已复制：${code}；也可直接右上角转发给朋友`),
    });
  },

  // ---------- 路由回调 ----------

  onEvent(msg) {
    const feed = [msg.text].concat(this.data.feed);
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
    this.setData({ feed });
  },

  onError(reason) {
    // 「对局进行中」= 服务端已经坐在牌桌上，而人还停在大厅（路由竞态的遗留状态）。
    // 这是权威信号，直接回牌桌并 resync；否则点多少次都只会再刷一条同样的错误。
    if (String(reason || '').indexOf('对局进行中') >= 0) {
      room.recoverGame();
      return;
    }
    const feed = [`⚠ ${reason}`].concat(this.data.feed);
    if (feed.length > FEED_MAX) feed.length = FEED_MAX;
    this.setData({ feed });
  },

  onSwapAsk(msg) {
    this.setData({
      swapAskShown: true,
      swapAskText: `${this.wind(msg.from)}家「${msg.fromName}」想与你交换座位，是否同意？`,
    });
  },

  onSwapRespond(e) {
    const accept = e.currentTarget.dataset.accept === '1';
    this.setData({ swapAskShown: false });
    room.send({ t: 'swapRespond', accept });
  },

  onVariant(msg) {
    const s = getApp().globalData.lastState;
    if (s) {
      const me = (s.players || []).find((p) => p.seat === s.you);
      this.buildVariantSwitch(msg.variant, !!(me && me.isHost));
    }
    if (msg.totals && s) {
      const next = Object.assign({}, s, { totals: msg.totals });
      getApp().globalData.lastState = next;
      this.renderLobby(next);
    }
    ui.showToast(this, `玩法已切换为「${variantName(msg.variant)}」${msg.cleared ? '，积分已清零' : ''}`);
  },

  onDissolved(msg) {
    this.setData({
      dissolvedShown: true,
      dissolvedTitle: msg.title,
      dissolvedRows: (msg.rows || []).map((r) => ({ name: r.name, value: r.value })),
    });
  },

  onDissolvedOk() {
    this.setData({ dissolvedShown: false });
    room.resetChat();
    net.closeSocket();
    wx.reLaunch({ url: '/pages/home/home' });
  },

  onShareAppMessage() {
    return {
      title: `来一局麻将（房间 ${this.data.code}）`,
      path: `/pages/home/home?room=${this.data.code}`,
    };
  },
});
