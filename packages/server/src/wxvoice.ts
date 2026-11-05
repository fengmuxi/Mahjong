/**
 * 微信实时语音（wx.joinVoIPChat）服务端支撑 —— 2026-11-03 新增。
 *
 * 为什么服务端要参与：VoIP 加入需要一份**用户级签名**，官方算法
 *   signature = hmac_sha256([appId, groupId, nonceStr, timeStamp].sort().join(''), sessionKey)
 * 其中 sessionKey 只能由服务端经 code2Session 换取，且**禁止下发到客户端**（微信安全红线）。
 * 所以客户端只拿 openid 与签名结果，sessionKey 全程留在服务端内存里。
 *
 * 三个端点（全部挂在本服务的既有 HTTP 端口上）：
 *   GET  /api/wx/voice    → 语音功能开关状态 { mg }（客户端据此显示/隐藏语音按钮）
 *   POST /api/wx/session  → { client, code }            换 { openid }（sessionKey 留存）
 *   POST /api/wx/voipsig  → { client, openid, group }   换 { groupId, appId, nonceStr, timeStamp, signature }
 *
 * 设计约束：
 *   · 纯内存、零新依赖（Node 22 原生 fetch + crypto）——与房间系统同寿命，服务重启即失效，
 *     客户端 wx.checkSession 失败会自动重新登录，无需持久化。
 *   · 只服务微信小游戏（mg）一个 appid，secret 走环境变量或 mahjong.config.json 注入
 *     （环境变量优先）：WX_MG_APPID / WX_MG_SECRET（文件键 wxMgAppid 等）。
 *     未配置 = 语音功能关闭（状态接口如实上报，客户端隐藏入口）。
 *   · groupId 规范：`mj-<房间码>`（如 mj-K7X2AB，8 字节 ≤ 官方 32 上限）。
 */
import { createHmac, randomBytes } from 'node:crypto';
import http from 'node:http';
import * as cfg from './config.ts';

interface WxApp {
  appid: string;
  secret: string;
}

/** 小游戏端 appid/secret；留空 = 未开通语音（环境变量 > mahjong.config.json > 空） */
const WX_APPS: Record<'mg', WxApp> = {
  mg: { appid: cfg.str('WX_MG_APPID', 'wxMgAppid', ''), secret: cfg.str('WX_MG_SECRET', 'wxMgSecret', '') },
};

/** sessionKey 内存账本：key = `${client}:${openid}`。24h 过期（微信 sessionKey 本身也会因重新 login 而轮换） */
const SESSION_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const sessionKeys = new Map<string, { key: string; ts: number }>();

/** 签名限流：同一用户两次签名至少间隔（join 一次签一次，正常使用远达不到） */
const SIG_MIN_GAP_MS = 1000;
const sigLast = new Map<string, number>();

/** 登录限流（2026-11-04 审计 D）：/api/wx/session 是公开端点、服务端拿自家 secret 转发
 *  微信 jscode2session —— 无频控时第三方可高频携带任意 code 刷微信侧配额（最坏触发
 *  45011 把真实玩家的语音登录也限掉）。与 voipsig 同款**全局**最小间隔：登录只发生在
 *  进房/重登，正常玩法远达不到；同 NAT 多人同时首登会串行（每人多等 ~1s，可接受）。 */
const SESSION_MIN_GAP_MS = 1000;
let sessionLast = 0;

/** 房间码格式（与服务端 genCode 的字符集一致）：签名端点只给合法房间码签名，防滥用 */
const GROUP_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/;

/** 语音 API 路径集合（index.ts 据此把请求转交本模块） */
export const WX_API_PATHS = new Set(['/api/wx/voice', '/api/wx/session', '/api/wx/voipsig']);

/** 某端语音功能是否已配置（appid+secret 齐全） */
export function voiceEnabled(client: 'mg'): boolean {
  const app = WX_APPS[client];
  return Boolean(app && app.appid && app.secret);
}

/** 统一 JSON 应答（全部 200 + ok 标志：wx.request 的 success 回调里直接读体，省掉 statusCode 分支） */
function reply(res: http.ServerResponse, body: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** 读 POST JSON body；超限/非 JSON 返回 null */
function readJsonBody(req: http.IncomingMessage, limit = 8192): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function cleanClient(v: unknown): 'mg' | '' {
  return v === 'mg' ? v : '';
}

/** 语音 API 入口：index.ts 在 createServer 回调里对 WX_API_PATHS 命中的请求转交至此 */
export async function handleWxApi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): Promise<void> {
  try {
    // 1) 功能开关状态：客户端进房前探测一次，决定是否渲染语音按钮
    if (req.method === 'GET' && pathname === '/api/wx/voice') {
      reply(res, { mg: voiceEnabled('mg') });
      return;
    }

    // 2) 登录：wx.login 的 code 换 openid（sessionKey 留存服务端，**绝不下发**）
    if (req.method === 'POST' && pathname === '/api/wx/session') {
      const body = await readJsonBody(req);
      const client = cleanClient(body?.client);
      const code = typeof body?.code === 'string' ? body.code : '';
      const app = WX_APPS[client as 'mg'];
      if (!client || !app || !voiceEnabled(client)) {
        reply(res, { ok: false, reason: 'voiceDisabled' });
        return;
      }
      if (!code) {
        reply(res, { ok: false, reason: 'badRequest' });
        return;
      }
      const nowMs = Date.now();
      if (nowMs - sessionLast < SESSION_MIN_GAP_MS) {
        reply(res, { ok: false, reason: 'rateLimited' });
        return;
      }
      sessionLast = nowMs;
      const u = new URL('https://api.weixin.qq.com/sns/jscode2session');
      u.searchParams.set('appid', app.appid);
      u.searchParams.set('secret', app.secret);
      u.searchParams.set('js_code', code);
      u.searchParams.set('grant_type', 'authorization_code');
      let wxRes: { openid?: string; session_key?: string; errcode?: number; errmsg?: string };
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
        wxRes = (await r.json()) as typeof wxRes;
      } catch {
        reply(res, { ok: false, reason: 'wxUnreachable' });
        return;
      }
      if (!wxRes.openid || !wxRes.session_key) {
        // 微信侧错误透传（如 code 已用/过期 40029、频率限制 45011），客户端提示后可重试
        reply(res, { ok: false, reason: `wx:${wxRes.errcode ?? '?'}:${wxRes.errmsg ?? 'no openid'}` });
        return;
      }
      sessionKeys.set(`${client}:${wxRes.openid}`, { key: wxRes.session_key, ts: Date.now() });
      reply(res, { ok: true, openid: wxRes.openid });
      return;
    }

    // 3) VoIP 签名：按官方算法以 sessionKey 作 HMAC 密钥
    if (req.method === 'POST' && pathname === '/api/wx/voipsig') {
      const body = await readJsonBody(req);
      const client = cleanClient(body?.client);
      const openid = typeof body?.openid === 'string' ? body.openid : '';
      const group = typeof body?.group === 'string' ? body.group : '';
      const app = WX_APPS[client as 'mg'];
      if (!client || !app || !voiceEnabled(client)) {
        reply(res, { ok: false, reason: 'voiceDisabled' });
        return;
      }
      if (!openid || !GROUP_RE.test(group)) {
        reply(res, { ok: false, reason: 'badRequest' });
        return;
      }
      const id = `${client}:${openid}`;
      const rec = sessionKeys.get(id);
      if (!rec || Date.now() - rec.ts > SESSION_KEY_TTL_MS) {
        sessionKeys.delete(id);
        // 客户端收到 relogin → 重新 wx.login 走一遍 session，再回来签名
        reply(res, { ok: false, reason: 'relogin' });
        return;
      }
      const now = Date.now();
      if (now - (sigLast.get(id) ?? 0) < SIG_MIN_GAP_MS) {
        reply(res, { ok: false, reason: 'rateLimited' });
        return;
      }
      sigLast.set(id, now);
      const groupId = `mj-${group}`;
      const nonceStr = randomBytes(8).toString('hex');
      // joinVoIPChat 的 timeStamp 是 Unix 秒的十进制字符串；签名也用同一字符串参与排序拼接。
      const timeStamp = String(Math.floor(now / 1000));
      const plain = [app.appid, groupId, nonceStr, timeStamp].sort().join('');
      const signature = createHmac('sha256', rec.key).update(plain).digest('hex');
      reply(res, { ok: true, groupId, appId: app.appid, nonceStr, timeStamp, signature });
      return;
    }

    reply(res, { ok: false, reason: 'notFound' });
  } catch {
    reply(res, { ok: false, reason: 'serverError' });
  }
}

/** 账本巡检：过期 sessionKey / 限流记录定期清掉（量小，10 分钟一次足够） */
const wxVoiceSweeper = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessionKeys) if (now - v.ts > SESSION_KEY_TTL_MS) sessionKeys.delete(k);
  for (const [k, t] of sigLast) if (now - t > 60_000) sigLast.delete(k);
}, 10 * 60 * 1000);
