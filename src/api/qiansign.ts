import crypto from "crypto";
import https from "https";

import _ from "lodash";

/**
 * qianwen.com 新版接口签名模块
 *
 * 流程：
 * 1. sec.qianwen.com/security/external/access/register 注册设备获取 actkn/dvidn/bacsft/snver
 * 2. sec.qianwen.com/api/calibration/getMillisTimeStamp 获取服务器校准时间
 * 3. HMAC-SHA256 双重签名 (clt-acs-sign + clt-acs-bfg)
 */

const SEC_HOST = "sec.qianwen.com";
const DEVICE_FINGERPRINT =
  "c8fd195b1f4a2e60d0b8a1e1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1";

interface BaxiaCredentials {
  dvidn: string;
  actkn: string;
  bacsft: string[];
  snver: string;
  utdid: string;
  registeredAt: number;
}

// 令牌 -> 凭据缓存（每个 ticket 一份设备身份）
const credentialsMap = new Map<string, BaxiaCredentials>();
// 凭据有效期：actkn-dl 约为 24h，提前 2 小时过期重注册
const CREDENTIALS_TTL = 22 * 3600 * 1000;

function httpsRequest(
  options: httpsRequestOptions
): Promise<{ status: number; data: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, data }));
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

interface httpsRequestOptions {
  host: string;
  path: string;
  method: string;
  headers: any;
  body?: string;
}

function hmacSHA256(data: string, key: string) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest("base64");
}

function hex32() {
  return crypto.randomBytes(16).toString("hex");
}

function nonce11() {
  const charset = "0123456789abcdefghijklmnopqrstuvwxyz";
  return Array(11)
    .fill("")
    .map(() => charset[Math.floor(Math.random() * charset.length)])
    .join("");
}

function generateUtid() {
  return "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === "x" ? r : (r & 3) | 8).toString(16);
  });
}

function commonHeaders(ticket: string) {
  return {
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    cookie: `tongyi_sso_ticket=${ticket}`,
    origin: "https://www.qianwen.com",
    referer: "https://www.qianwen.com/",
  };
}

/**
 * 注册设备获取baxia风控凭据
 */
async function registerDevice(ticket: string, utdid: string) {
  const chid = (Date.now() + Math.random().toString(36).substring(2, 12)).toString();
  const { data } = await httpsRequest({
    host: SEC_HOST,
    path: `/security/external/access/register?chid=${chid}`,
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...commonHeaders(ticket),
      "bx-umidtoken": "",
      "eo-clt-sftcnt": "100",
      "clt-acs-caer": "vrad",
      "eo-clt-acs-bx-intss": "2",
    },
    body: JSON.stringify({
      screenResolution: "1920x1080",
      cookieEnabled: true,
      localStorageEnabled: true,
      timezoneOffset: -480,
      fontList: ["Microsoft YaHei", "SimSun", "Arial"],
      pluginList: [],
      language: ["zh-CN", "zh"],
      unifyRelateGenerate: ["qwen_chat", "voice_command"],
      fingerprint: DEVICE_FINGERPRINT,
      businessScene: "qwen_web",
      chid,
    }),
  });
  const result = _.attempt(() => JSON.parse(data));
  if (_.isError(result) || result.status !== 0 || !result.data)
    throw new Error(
      `设备注册失败: ${_.isError(result) ? data.substring(0, 200) : result.msg}`
    );
  const qwenChatScene =
    result.data.unifyRelate?.find((s: any) => s.businessScene === "qwen_chat") ||
    result.data;
  return {
    dvidn: result.data["eo-clt-dvidn"],
    actkn: qwenChatScene["eo-clt-actkn"],
    bacsft: qwenChatScene["eo-clt-bacsft"] || result.data["eo-clt-bacsft"] || [],
    snver: result.data["eo-clt-snver"],
    utdid,
    registeredAt: Date.now(),
  } as BaxiaCredentials;
}

/**
 * 获取(或创建)baxia凭据，缓存有效期内复用
 */
export async function getCredentials(ticket: string) {
  const cached = credentialsMap.get(ticket);
  if (
    cached &&
    cached.bacsft.length > 20 &&
    Date.now() - cached.registeredAt < CREDENTIALS_TTL
  )
    return cached;
  const utdid = cached?.utdid || generateUtid();
  const credentials = await registerDevice(ticket, utdid);
  credentialsMap.set(ticket, credentials);
  return credentials;
}

/**
 * 获取服务器校准时间戳
 */
export async function getServerTime() {
  const { data } = await httpsRequest({
    host: SEC_HOST,
    path: `/api/calibration/getMillisTimeStamp?t=${Date.now()}`,
    method: "GET",
    headers: {
      accept: "application/json",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    },
  });
  const result = _.attempt(() => JSON.parse(data));
  if (_.isError(result) || !result.data)
    throw new Error(`获取服务器时间失败: ${data.substring(0, 200)}`);
  return String(result.data.millisTimeStamp);
}

/**
 * 对请求进行签名并返回完整请求参数
 */
export async function signChatRequest(ticket: string, body: object) {
  const credentials = await getCredentials(ticket);
  // bacsft为一次性盐池，按序消耗
  const sacsft = credentials.bacsft.pop();
  if (!sacsft) throw new Error("签名盐池已耗尽，请重新注册设备");
  const serverTime = await getServerTime();

  const query: Record<string, string> = {
    biz_id: "ai_qwen",
    fe_version: "1.0.0",
    chat_client: "h5",
    device: "pc",
    fr: "pc",
    pr: "qwen",
    ut: credentials.utdid,
    la: "zh-CN",
    tz: "Asia/Shanghai",
    wv: "4.6.4",
    ve: "4.6.4",
  };
  query.nonce = nonce11();
  query.timestamp = String(Date.now());

  const bodyStr = JSON.stringify(body);
  const requestParams = Object.keys(query).join(",");
  const requestValues = Object.keys(query)
    .map((k) => query[k])
    .join("");
  const salt = `${sacsft}:${serverTime}`;
  const bodySign = hmacSHA256(bodyStr, salt);
  const sign = hmacSHA256(
    `${credentials.dvidn}1.0.0${requestValues}${bodySign}`,
    salt
  );

  const qs = Object.entries(query)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");

  return {
    path: `/api/v2/chat?${qs}`,
    body: bodyStr,
    headers: {
      accept: "application/json, text/event-stream, text/plain, */*",
      "content-type": "application/json",
      ...commonHeaders(ticket),
      "x-csrf-token": "",
      "x-platform": "pc_tongyi",
      "x-device-id": credentials.utdid,
      "prod_id": "tongyi",
      "clt-acs-sign": sign,
      "clt-acs-reqt": serverTime,
      "clt-acs-request-params": requestParams,
      "eo-clt-dvidn": credentials.dvidn,
      "eo-clt-sacsft": sacsft,
      "eo-clt-snver": credentials.snver,
      "eo-clt-actkn": credentials.actkn,
      "eo-clt-acs-ve": "1.0.0",
      "clt-acs-caer": "vrad",
      "eo-clt-acs-kp": "",
      "clt-acs-bfg": bodySign,
    },
  };
}

/**
 * 随机生成请求与会话ID
 */
export function generateIds() {
  const reqId = hex32();
  return {
    reqId,
    sessionId: hex32(),
  };
}

export default {
  getCredentials,
  getServerTime,
  signChatRequest,
  generateIds,
};
