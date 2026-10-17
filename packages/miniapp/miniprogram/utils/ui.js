/**
 * 轻量 UI 助手：toast / confirm / 数字格式化。
 * 对应 web 端的 showToast / window.confirm（小程序没有 window.confirm）。
 */

let toastTimer = null;

module.exports = {
  /**
   * 提示（由调用方把 text 写进 data 再渲染，避免模块持有页面状态）
   * 用法：showToast(page, '文本')
   */
  showToast(ctx, text, ms = 3000) {
    if (!ctx) return;
    ctx.setData({ toastText: text, toastShown: true });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      ctx.setData({ toastShown: false });
    }, ms);
  },

  /** 确认框：web 端 window.confirm 的等价物 */
  confirm(content, title = '确认') {
    return new Promise((resolve) => {
      wx.showModal({
        title,
        content,
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false),
      });
    });
  },

  /** 分行提示（错误态） */
  fmtDelta(v) {
    if (v === 0) return '0';
    return v > 0 ? `+${v}` : `${v}`;
  },
  fmtIn(v) {
    return v > 0 ? `+${v}` : '—';
  },
  fmtOut(v) {
    return v > 0 ? `−${v}` : '—';
  },
};
