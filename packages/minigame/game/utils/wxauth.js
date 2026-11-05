/**
 * 微信登录态（2026-11-03，实时语音的前置基础设施）。
 *
 * 背景：wx.joinVoIPChat 的加入签名必须以**用户级 sessionKey** 作 HMAC 密钥计算，
 * 而 sessionKey 只能由服务端经 code2Session 换取、且禁止下发到客户端（微信安全红线）。
 * 因此本模块只做三件事：
 *   1. wx.login 拿 code → POST {api}/api/wx/session 换 openid（sessionKey 留在服务端）；
 *   2. openid 持久化到 storage（键 mj-openid），下次免登；
 *   3. wx.checkSession 失效（sessionKey 过期/被重新登录轮换）时自动重建登录态。
 *
 * 与对局身份的关系：**完全平行**。对局身份是匿名 token+pid（房间凭据），本模块的
 * openid 只服务于 VoIP 签名，不参与座位/权限判断。服务重启后 sessionKey 账本清空，
 * 表现为签名端点回 `relogin` → 调用方（voice.js）自动 force 重登一次，用户无感。
 *
 * 双端同构：本文件在小程序（utils/）与小游戏（utils/）**逐字节一致**，
 * 唯一差异是入口注入的 client 标识（'mp' / 'mg'），见 setClient。
 */

const config = require('./config.js');
const store = require('./store.js');

/** openid 持久化键（独立于 store.js 的 KEYS：登录态与房间状态生命周期不同） */
const KEY_OPENID = 'mj-openid';
const KEY_CLIENT = 'mj-client';

/** 'mp'（小程序）| 'mg'（小游戏），由各端入口处注入（app.js / main.js） */
let client = '';
/** 并发去重：多页面同 tick 调 ensureLogin 只发一次登录 */
let loginPromise = null;
/** 最近一次成功登录的 openid（含从 storage 恢复的），供 voice.js 过滤「自己在说话」 */
let lastOpenid = '';

function setClient(c) {
  client = c === 'mp' || c === 'mg' ? c : '';
  if (!lastOpenid) lastOpenid = getSavedOpenid();
}

function getClient() {
  return client;
}

/** 最近一次登录态对应的 openid（未登录过为空串；只读快照，不发起任何请求） */
function getOpenid() {
  return lastOpenid;
}

function getSavedOpenid() {
  const saved = String(store.get(KEY_OPENID, '') || '');
  return /^[A-Za-z0-9_-]{1,128}$/.test(saved) ? saved : '';
}

function wxLogin() {
  return new Promise((resolve) => {
    wx.login({
      success: (r) => resolve((r && r.code) || ''),
      fail: () => resolve(''),
    });
  });
}

/** checkSession 通过 = 微信侧 session_key 未过期（大概率服务端账本还有效） */
function wxCheckSession() {
  return new Promise((resolve) => {
    wx.checkSession({
      success: () => resolve(true),
      fail: () => resolve(false),
    });
  });
}

function postSession(code) {
  return new Promise((resolve) => {
    wx.request({
      url: `${config.resolveApi()}/api/wx/session`,
      method: 'POST',
      data: { client, code },
      timeout: 8000,
      success: (r) => resolve(r.data && typeof r.data === 'object' ? r.data : null),
      fail: () => resolve(null),
    });
  });
}

/**
 * 取（必要时重建）登录态。
 * @param {boolean} force 跳过缓存的 openid，强制重登（签名端点回 relogin 时用）
 * @returns {Promise<{ok:boolean,openid?:string,reason?:string}>}
 *   reason：noClient 未注入端标识 / loginFailed wx.login 失败 /
 *           voiceDisabled 服务端未配置该端 secret / wx:xxxx 微信侧错误透传 / network 请求失败
 */
function ensureLogin(force) {
  if (!client) return Promise.resolve({ ok: false, reason: 'noClient' });
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    try {
      const saved = getSavedOpenid();
      const savedClient = String(store.get(KEY_CLIENT, '') || '');
      if (saved && savedClient === client && !force && (await wxCheckSession())) {
        lastOpenid = saved;
        return { ok: true, openid: saved };
      }
      const code = await wxLogin();
      if (!code) return { ok: false, reason: 'loginFailed' };
      const r = await postSession(code);
      if (!r || !r.ok || !r.openid) {
        return { ok: false, reason: (r && r.reason) || 'sessionFailed' };
      }
      store.set(KEY_OPENID, r.openid);
      store.set(KEY_CLIENT, client);
      lastOpenid = r.openid;
      return { ok: true, openid: r.openid };
    } finally {
      loginPromise = null;
    }
  })();
  return loginPromise;
}

module.exports = {
  setClient,
  getClient,
  getOpenid,
  ensureLogin,
};
