/**
 * 部署配置（小程序端唯一的「环境相关」常量）。
 *
 * 约束（见 docs/integration/wechat-miniprogram.md §2.3）：
 *   · 必须是 **wss** 协议 + 已 ICP 备案的域名，且不带端口（走 443）；
 *   · 域名须在小程序后台「开发管理 → 开发设置 → 服务器域名 → socket 合法域名」登记；
 *   · 不能用 IP / localhost（局域网 IP 仅开发期可用）。
 *
 * 上线前把 DEFAULT_WSS 改成真实地址即可：
 *   const DEFAULT_WSS = 'wss://mahjong.example.com/ws';
 *
 * 开发期覆盖方式（不改动代码）：在开发者工具勾选「不校验合法域名」后执行
 *   wx.setStorageSync('mj-wss', 'ws://192.168.1.10:3130/ws')
 * 即可连局域网服务端调试。
 */

const DEFAULT_WSS = 'wss://majiang.dwzynj.top/ws';

let override = '';

module.exports = {
  DEFAULT_WSS,
  /** 运行期覆盖（调试用） */
  setOverride(url) {
    override = url || '';
  },
  /** 取最终 wss 地址；未配置时返回空串，由调用方提示 */
  resolve() {
    if (override) return override;
    try {
      const saved = wx.getStorageSync('mj-wss');
      if (saved) return String(saved);
    } catch (e) {
      /* 存储不可用时忽略 */
    }
    return DEFAULT_WSS;
  },
  /**
   * 静态资源（牌面 CDN 清单）的接口地址：**由 wss 地址同域名推导**（ws→http、wss→https）。
   * 例：`wss://majiang.dwzynj.top/ws` → `https://majiang.dwzynj.top`（再拼 `/api/tiles`）。
   * CDN 是独立域名时，用 `wx.setStorageSync('mj-api', 'https://cdn.example.com')` 覆盖。
   *
   * ⚠️ 域名必须在小程序后台登记为 **request 合法域名**（拿清单）与 **downloadFile
   * 合法域名**（`<image>` 与 canvas `createImage` 下载图片），否则真机一律失败、只显示矢量牌面。
   */
  resolveApi() {
    try {
      const saved = wx.getStorageSync('mj-api');
      if (saved) return String(saved).replace(/\/+$/, '');
    } catch (e) {
      /* 存储不可用时忽略 */
    }
    const m = /^(wss?):\/\/([^/]+)/.exec(String(this.resolve() || ''));
    if (!m) return '';
    return (m[1] === 'wss' ? 'https' : 'http') + '://' + m[2];
  },
};
