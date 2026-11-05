/**
 * 场景基类：nav.js 的钩子契约。
 *
 * 场景对象每次导航都**新建**（对位小程序端「导航重建 Page 实例」—— 内部状态不跨场景
 * 残留，跨场景共享量一律走 src/state.js）。子类必须：
 *   · enter()：nav.attach('<场景名>', this) + 自己的初始化；
 *   · exit()：nav.detach(this) + 清定时器 / 收键盘；
 *   · render(ctx, L)：把整个屏幕画出来（没有 WXML，全靠这里）；
 *   · 触摸按需覆写 onTouchDown/Move/Up/Cancel/onTap（x,y 为屏幕坐标 px）；
 *   · 服务端消息钩子按需覆写：onState / onGame / onChat / onEmote / onSwapAsk /
 *     onSettle / onDissolved / onVariant / onEvent / onError / onNetStatus / onResumeFail。
 */

class Scene {
  constructor() {
    /** 运行时资源（画布 / dpr / 离屏宿主） */
    this.app = require('../app.js');
  }

  enter() {}
  exit() {}

  /* 触摸（默认空实现，子类按需覆写） */
  onTouchDown() {}
  onTouchMove() {}
  onTouchUp() {}
  onTouchCancel() {}
  onTap() {}

  /* 服务端消息钩子（默认空实现） */
  onState() {}
  onGame() {}
  onChat() {}
  onEmote() {}
  onSwapAsk() {}
  onSettle() {}
  onDissolved() {}
  onVariant() {}
  onEvent() {}
  onError() {}
  onNetStatus() {}
  onResumeFail() {}
}

module.exports = Scene;
