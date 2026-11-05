/**
 * CDN 资源预热（对位小程序端各场景 onShow 里分散的 ensure/preload）。
 *
 * 小程序端清单请求发生在「进对局页」时——用户在首页/大厅的那几秒是空转的；
 * 小游戏端把这些全部提前到**冷启动**：main.js 引导时调 warmup()，三份清单并发拉，
 * 位图拿到清单后立即预解码。等玩家点「创建/加入」进对局时，资源九成已在缓存里，
 * 牌桌首帧就是贴图，不再「先兜底样式、资源到位闪回来」。
 *
 * 幂等：tileimg/uiart/sound 的 ensure 内部自带 inflight/netSettled 去重，重复调用
 * 只挂监听不重发请求；本模块只负责「尽早触发一次」+ 暴露就绪度。
 *
 * 就绪度（progress）：供以后做加载进度条；当前 UI 不阻塞进入（预热全部后台化）。
 */

const tileimg = require('../utils/tileimg.js');
const uiart = require('../utils/uiart.js');
const sound = require('../utils/sound.js');
const avatarart = require('../utils/avatarart.js');
const app = require('./app.js');

let started = false;
/** 三通道各段就绪标志（音频就绪 = 清单 + 首次实例化成功） */
const done = { tilesList: false, tilesBmp: false, uiList: false, uiBmp: false, sound: false, avatarList: false, avatarBmp: false };

/**
 * 启动预热。在 main.js 创建画布之后、boot 首场景之前调用一次。
 * 拿不到画布宿主（极端环境）也安全：各 ensure 会走各自的失败兜底。
 */
function warmup() {
  if (started) return;
  started = true;
  const host = imageHost();
  // ①/② 牌面清单 + 位图（ensure 幂等；回调可能因「先缓存后网络」触发多次，位图去重）
  tileimg.ensure((ok) => {
    done.tilesList = ok;
    if (ok && host) {
      tileimg.preload(host, (got) => {
        done.tilesBmp = !!got;
      });
    }
  });
  // ③/④ UI 清单 + 画布消费的位图（与 game.js loadUiArt 同一份关键键位表）
  uiart.ensure((ok) => {
    done.uiList = ok;
    if (ok && host) {
      const keys = [
        'back', 'back_op', 'inhand_l', 'inhand_r', 'banker', 'table',
        'd0', 'd1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9',
        'chi', 'peng', 'gang', 'hu', 'guo', 'win', 'lost', 'draw',
      ];
      uiart.preload(host, keys, () => {
        done.uiBmp = keys.every((k) => uiart.art(k));
      });
    }
  });
  // ⑤ 音效清单（InnerAudioContext 的创建/首播预热由 sound.ensure 内部管）
  sound.ensure(() => {
    done.sound = sound.ready();
  });
  // ⑥ 头像清单 + 全部位图预解码（选择器网格 / 铭牌 / 大厅座位卡共用；27 张 ~1MB，与牌面同量级）
  avatarart.ensure((ok) => {
    done.avatarList = ok;
    if (ok && host) {
      avatarart.preload(host, avatarart.list(), () => {
        done.avatarBmp = true;
      });
    }
  });
}

/**
 * 图片预解码宿主：与 GameScene 的 imageHost 同一适配（画布自带 createImage 优先，
 * 退全局 wx.createImage）。两处必须保持一致 —— 抽成一份放这里，GameScene 引用。
 */
function imageHost(canvasNode) {
  if (canvasNode && typeof canvasNode.createImage === 'function') return canvasNode;
  try {
    if (typeof wx !== 'undefined' && typeof wx.createImage === 'function') {
      return { createImage: () => wx.createImage() };
    }
  } catch (e) {
    /* 落 null */
  }
  return null;
}

/** 就绪度快照（排查 / 未来进度条用）：{ tiles: 'list+bmp'|'list'|'no', ui: 同, sound: bool } */
function progress() {
  return {
    tiles: done.tilesBmp ? 'list+bmp' : done.tilesList ? 'list' : 'no',
    ui: done.uiBmp ? 'list+bmp' : done.uiList ? 'list' : 'no',
    sound: done.sound,
  };
}

module.exports = { warmup, progress, imageHost };
