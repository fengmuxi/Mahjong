/**
 * 小程序入口。
 *
 * 只做三件事：① 全局共享状态；② 把 web 端的页面间共享量（座位 / 庄家 / 视图 / 聊天历史）
 * 挂到 globalData（页面跳转会重建 Page 实例，模块级变量不可靠）；③ 前后台切换时提示网络层。
 * 规则与协议一律来自 lib/shared（与 web 端同一份源码编译产物），这里不持有任何规则逻辑。
 */

const net = require('./utils/net.js');

App({
  globalData: {
    /** 我的座位号（-1 = 未在房间内） */
    mySeat: -1,
    /** 当前庄家座位：**风位随庄**，大厅与牌桌的一切风位显示都按它换算 */
    dealer: 0,
    /** 最近一次大厅 state 消息 */
    lastState: null,
    /** 最近一次 GameView */
    lastGameView: null,
    /** 房间码（分享用） */
    roomCode: '',
    /** 房间聊天历史（离房清空；跨小局保留） */
    chatHistory: [],
    /** 聊天面板收起态下的未读数 */
    chatUnread: 0,
    /** 当前玩法 id */
    variant: '',
  },

  onLaunch() {
    net.setStatusHandler(() => {});
  },

  onShow() {
    // 切回前台：若连接已断（小程序切后台后 socket 可能被系统回收），立刻补一次重连
    net.onAppShow();
  },

  onHide() {
    net.onAppHide();
  },
});
