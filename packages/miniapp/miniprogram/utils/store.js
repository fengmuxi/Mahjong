/**
 * 本地存储（web 端 localStorage 的等价物）。
 * key 与 web 端保持完全一致：mj-token / mj-room / mj-name / mj-bg / mj-variant。
 */

const KEYS = {
  token: 'mj-token',
  room: 'mj-room',
  name: 'mj-name',
  bg: 'mj-bg',
  variant: 'mj-variant',
};

module.exports = {
  KEYS,
  get(key, fallback) {
    try {
      const v = wx.getStorageSync(key);
      return v === '' || v === undefined || v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      wx.setStorageSync(key, value);
    } catch (e) {
      /* 存储失败不影响本局 */
    }
  },
  remove(key) {
    try {
      wx.removeStorageSync(key);
    } catch (e) {
      /* ignore */
    }
  },
  clearRoom() {
    this.remove(KEYS.token);
    this.remove(KEYS.room);
  },
};
