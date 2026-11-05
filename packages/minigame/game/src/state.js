/**
 * 全局共享状态（小程序端 app.js globalData 的对位物）。
 *
 * 小程序端页面跳转会重建 Page 实例，跨页共享量必须放 globalData；小游戏端场景切换
 * 同样会重建场景对象（与「导航重建页面」语义对齐，见 src/nav.js），所以这份模块级
 * 单例就是小游戏端的 globalData。字段与小程序端一一对应，改名会造成两端心智分叉。
 */

const sound = require('../utils/sound.js');

const state = {
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
  /** 音效模块（真机调试：state.sound.debug()） */
  sound,
  /** 自动回桌失败提示 {reason, room} | null（home 场景消费后清空） */
  resumeFail: null,
  /** 分享卡片 / 冷启动带入的房间码（home 场景消费后清空） */
  launchRoom: '',
  /**
   * 语音座位映射（2026-11-03 二期）：`{ [seat]: { openid, muted } }`。
   * nav.js 收 `voice` 广播时全量覆盖；与 voice.speakers() 求交得「哪个座位在说话」。
   */
  voiceMap: null,
};

module.exports = state;
