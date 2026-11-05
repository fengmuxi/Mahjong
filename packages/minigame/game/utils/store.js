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
  /**
   * 玩家自选头像 id（如 'a05'；空串=未选，由服务端按 pid 确定性随机分配）。
   * 协议 key 与小程序/服务端约定一致（mj-avatar）：玩家本地存了 mj-avatar=a05，
   * 服务端据此回显；换设备/清房（clearRoom 只清 token/room）不动它，头像偏好长期稳定。
   */
  avatar: 'mj-avatar',
  /**
   * 本地稳定玩家 id（2026-10-23）：**跟随全局、跨房间/跨会话不变**。
   * 只用于「凭 id + 房间码 找回自己的座位」——掉线重进、换设备、令牌丢失都能回桌；
   * 不参与任何权限判断，也不上屏（隐藏 id）。
   */
  pid: 'mj-pid',
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
    // 防御：key 非法（undefined/null）时微信会报 setStorageSync:fail，且会让整段存储不可用。
    // 头像等偏好缺失不应阻断本局，直接跳过（2026-11-05 修：KEYS.avatar 漏定义曾导致首页选头像即崩）。
    if (typeof key !== 'string' || !key) return;
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

  /**
   * 取（必要时生成并持久化）本地昵称（2026-11-02，分享直进房的零输入兜底）。
   * 与 ensurePid 同构：生成后长期稳定 —— 同一个人多次进房名字不漂移；
   * 格式与服务端 cleanName 的兜底一致（玩家 + 4 位数字）。
   */
  ensureName() {
    const saved = String(this.get(KEYS.name, '') || '').trim();
    if (saved) return saved;
    const name = `玩家${1000 + Math.floor(Math.random() * 9000)}`;
    this.set(KEYS.name, name);
    return name;
  },

  /**
   * 取（必要时生成并持久化）本地玩家 id。
   * 格式与服务端 `cleanPid` 一致：`[A-Za-z0-9_-]{8,64}`。
   * 生成后**不会随房间/清房消失**（clearRoom 不动它）——它代表「这台设备上的人」。
   */
  ensurePid() {
    const saved = String(this.get(KEYS.pid, ''));
    if (/^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
    const pid = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    this.set(KEYS.pid, pid);
    return pid;
  },
};
