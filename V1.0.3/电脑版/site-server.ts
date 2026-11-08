/**
 * CyanQiuper 官网 + 用户中心
 *
 * 独立 Node 服务（无第三方依赖），监听 127.0.0.1:11455，由 nginx 443 反代。
 * - 官网静态页：site/
 * - 用户中心：注册 / 登录 / 改密 / 个人资料 / 登录记录 / 最近导入记录
 * - 公开状态接口：从本机 WS 控制接口（11453）读取运行状态与最近导入
 *
 * 数据：site-data/users.json（scrypt 哈希） + site-data/secret（会话签名密钥）
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as tls from "node:tls";
import { execFileSync, spawn } from "node:child_process";
import * as os from "node:os";

const APP_NAME = "CyanQiuper";
/** 本地部署可用 FB_EMAIL_VERIFY=0 关闭邮箱验证码 */
const EMAIL_VERIFY = process.env.FB_EMAIL_VERIFY !== "0";
const PORT = Number(process.env.FB_SITE_PORT || 11455);
const HOST = process.env.FB_SITE_HOST || "127.0.0.1";
const ROOT = process.cwd();
const SITE_DIR = path.join(ROOT, "site");
const DATA_DIR = path.join(ROOT, "site-data");
const LOG_DIR = process.env.FB_LOG_DIR || path.join(ROOT, "logs");
const CONTROL_PORT = Number(process.env.FB_CONTROL_PORT || 11453);
const WS_PORT = Number(process.env.FB_WS_PORT || 11451);

fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SECRET_FILE = path.join(DATA_DIR, "secret");
const LOG_FILE = path.join(LOG_DIR, "site.log");

function utc8(d = new Date()): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00");
}
function log(line: string) {
  const text = `[${utc8()}] ${line}`;
  console.log(text);
  try {
    fs.appendFileSync(LOG_FILE, text + "\n");
  } catch {}
}

/** ===== 存储 ===== */
type LoginRecord = { at: number; ip: string };
type User = {
  id: string;
  username: string;
  salt: string;
  hash: string;
  createdAt: number;
  lastLoginAt: number;
  logins: LoginRecord[];
};
type DB = { users: User[] };

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function writeJson(file: string, data: unknown) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
let db: DB = readJson<DB>(USERS_FILE, { users: [] });

const secret: Buffer = (() => {
  try {
    const s = fs.readFileSync(SECRET_FILE);
    if (s.length >= 32) return s;
  } catch {}
  const s = crypto.randomBytes(32);
  fs.writeFileSync(SECRET_FILE, s, { mode: 0o600 });
  return s;
})();

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function makeUser(username: string, password: string): User {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    id: crypto.randomUUID(),
    username,
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now(),
    lastLoginAt: 0,
    logins: [],
  };
}
function verifyPassword(user: User, password: string): boolean {
  const h = Buffer.from(user.hash, "hex");
  const c = Buffer.from(hashPassword(password, user.salt), "hex");
  return h.length === c.length && crypto.timingSafeEqual(h, c);
}

/** ===== 会话 ===== */
const SESSION_HOURS = 24 * 7;
function sign(payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}
function makeSession(uid: string): string {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + SESSION_HOURS * 3600 * 1000 })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}
function readSession(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)cq_user=([^;]+)/);
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sign(payload)), Buffer.from(sig))) return null;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.uid || data.exp < Date.now()) return null;
    return String(data.uid);
  } catch {
    return null;
  }
}
/** ===== 插件市场（Lua） ===== */
const MARKET_FILE = path.join(DATA_DIR, "market.json");
const PLUGIN_DIR = path.join(DATA_DIR, "plugins");
const MARKET_PRICE_MAX = 500;
const MARKET_ADMIN_TOKEN = process.env.FB_MARKET_ADMIN_TOKEN || "";
fs.mkdirSync(PLUGIN_DIR, { recursive: true });

type MarketPlugin = {
  id: string;
  name: string;
  desc: string;
  version: string;
  price: number;
  file: string;
  creatorUid: string;
  creatorName: string;
  status: "pending" | "approved" | "rejected";
  rejectReason?: string;
  sales?: number;
  createdAt: number;
  approvedAt?: number;
};
let market: { plugins: MarketPlugin[] } = readJson(MARKET_FILE, { plugins: [] });

function saveMarket() {
  writeJson(MARKET_FILE, market);
}
function marketPublic(p: MarketPlugin, user: any) {
  const owns = user && Array.isArray(user.pluginOwns) && user.pluginOwns.includes(p.id);
  const mine = user && p.creatorUid === user.id;
  return {
    id: p.id,
    name: p.name,
    desc: p.desc,
    version: p.version,
    price: p.price,
    creator: p.creatorName,
    status: p.status,
    sales: p.sales || 0,
    createdAt: p.createdAt,
    owned: !!owns,
    mine: !!mine,
    rejectReason: p.rejectReason || "",
  };
}
function checkAdminToken(req: IncomingMessage, url: URL): boolean {
  const token = String(req.headers["x-market-token"] || "");
  const cu = currentUser(req);
  return !!MARKET_ADMIN_TOKEN && token === MARKET_ADMIN_TOKEN && !!cu && cu.username === ABADMIN_USER;
}

/** ===== 导入排队（全局 3 并发，付费插队，不抢占） ===== */
const IMPORT_LIMIT = Math.max(1, Number(process.env.FB_IMPORT_LIMIT || 3));
const IMPORT_ACTIVE = new Map<string, { startedAt: number }>();
let IMPORT_QUEUE: { uid: string; offsetY: number; priority: number; at: number }[] = [];

function tierPriority(user: any): number {
  const exp = Number(user.subExpiresAt || 0);
  if (exp < Date.now()) return 0;
  const p = String(user.subPlan || "");
  if (p.startsWith("ultra")) return 4;
  if (p.startsWith("max")) return 3;
  if (p.startsWith("plus")) return 2;
  if (p.startsWith("pro")) return 1;
  return 1;
}

function findUser(uid: string) {
  return db.users.find((u) => u.id === uid) as any;
}

function startQueuedBuild(item: { uid: string; offsetY: number }) {
  const u = findUser(item.uid);
  if (!u) return;
  if (IMPORT_ACTIVE.has(u.id) || IMPORT_ACTIVE.size >= IMPORT_LIMIT) {
    IMPORT_QUEUE.push({ uid: u.id, offsetY: item.offsetY, priority: 0, at: Date.now() });
    return;
  }
  try {
    const ctrlPort = ensureInstance(u).ctrlPort;
    IMPORT_ACTIVE.set(u.id, { startedAt: Date.now() });
    const r = ctrlPost(ctrlPort, "/structure/build", { offsetY: item.offsetY }, 30000);
    if (r && (r as any).ok) {
      consumeQuota(u);
      log(`用户 ${u.username} 开始导入（队列调度）`);
    } else {
      IMPORT_ACTIVE.delete(u.id);
    }
  } catch {
    IMPORT_ACTIVE.delete(u.id);
  }
}

function dispatchImportQueue() {
  while (IMPORT_ACTIVE.size < IMPORT_LIMIT && IMPORT_QUEUE.length) {
    IMPORT_QUEUE.sort((a, b) => b.priority - a.priority || a.at - b.at);
    const next = IMPORT_QUEUE.shift();
    if (!next) break;
    startQueuedBuild(next);
  }
}

// 每 3 秒检查进行中的导入是否结束（任务结束即释放名额；不中断任何任务）
setInterval(() => {
  let released = false;
  for (const [uid] of IMPORT_ACTIVE) {
    const u = findUser(uid);
    if (!u) { IMPORT_ACTIVE.delete(uid); released = true; continue; }
    const rec = IMPORT_ACTIVE.get(uid)!;
    try {
      const ctrl = ensureInstance(u).ctrlPort;
      const st: any = ctrlGet(ctrl, "/status");
      const building = st && st.structure && st.structure.build;
      if (!building && Date.now() - rec.startedAt > 30000) {
        IMPORT_ACTIVE.delete(uid);
        released = true;
        log(`用户 ${u.username} 的导入已结束，释放队列名额`);
      }
    } catch {
      if (Date.now() - rec.startedAt > 30000) {
        IMPORT_ACTIVE.delete(uid);
        released = true;
      }
    }
  }
  if (released) dispatchImportQueue();
}, 3000).unref();

/** ===== 网易版多账号 ===== */
const NETEASE_TEMPLATE = process.env.FB_NETEASE_BOT_TEMPLATE || "/opt/netease-bot";
const NETEASE_USER_BASE = Number(process.env.FB_NETEASE_USER_BASE || 12400);
const NETEASE_SKIP = new Set(["config.json", "mc.cfg", "key.json", "bot.sock", "debug.log", "run.log", "__pycache__"]);
function neteasePort(user: any) {
  const idx = db.users.findIndex((x: any) => x.id === user.id);
  return NETEASE_USER_BASE + Math.max(0, idx);
}
function prepareNeteaseBot(user: any): any {
  const ne = user.netease;
  if (!ne) return { ok: false, error: "请先在第三方账号里导入网易账号信息" };
  const dir = path.join(DATA_DIR, "users", user.id, "netease-bot");
  fs.mkdirSync(dir, { recursive: true });
  try {
    for (const f of fs.readdirSync(NETEASE_TEMPLATE)) {
      if (NETEASE_SKIP.has(f)) continue;
      const src = path.join(NETEASE_TEMPLATE, f);
      const dst = path.join(dir, f);
      if (!fs.existsSync(dst)) { try { fs.symlinkSync(src, dst); } catch {} }
    }
  } catch (e: any) { return { ok: false, error: "机器人模板缺失：" + String(e?.message ?? e) }; }
  const token = crypto.randomBytes(16).toString("hex");
  const sock = path.join(dir, "bot.sock");
  try { fs.unlinkSync(sock); } catch {}
  const cfg = { mode: ne.mode || "server", id: decryptSecret(ne.roomIdEnc || ""), password: decryptSecret(ne.passwordEnc || ""), cookie_file: "mc.cfg", key_file: "", proxy: { enabled: false }, unix_sockets: [{ socket: sock, token }] };
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "mc.cfg"), decryptSecret(ne.cookieEnc || ""), { mode: 0o600 });
  return { ok: true, dir, sock, token };
}
function neteaseLive(port: number) { try { return !!(ctrlGet(port, "/status") as any)?.ok; } catch { return false; } }
async function neteaseStartFor(user: any) {
  const old = user.neteaseRuntime || {};
  if (old.pid && old.port && neteaseLive(old.port)) return { ok: true, already: true, port: old.port };
  if (old.pid) neteaseStopFor(user);
  const prep = prepareNeteaseBot(user);
  if (!prep.ok) return prep;
  const port = neteasePort(user);
  const userLogs = path.join(DATA_DIR, "users", user.id, "logs");
  fs.mkdirSync(userLogs, { recursive: true });
  const bot = spawn("python3", ["main.py", "-c", "config.json"], { cwd: prep.dir, detached: true, stdio: "ignore" });
  bot.unref();
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const svc = spawn(process.execPath, [tsxCli, "netease-service.ts"], { cwd: ROOT, detached: true, stdio: "ignore", env: Object.assign({}, process.env, { FB_NETEASE_SOCKET: prep.sock, FB_NETEASE_TOKEN: prep.token, FB_NETEASE_PORT: String(port), FB_LOG_DIR: userLogs }) });
  svc.unref();
  user.neteaseRuntime = { pid: bot.pid || 0, svcPid: svc.pid || 0, port, sock: prep.sock, startedAt: Date.now() };
  writeJson(USERS_FILE, db);
  return { ok: true, starting: true, port, botPid: bot.pid || 0, svcPid: svc.pid || 0 };
}
function neteaseStopFor(user: any) {
  const rt = user.neteaseRuntime;
  if (!rt) return { ok: true };
  for (const pid of [rt.pid, rt.svcPid]) { if (pid) { try { process.kill(pid); } catch {} } }
  try { if (rt.sock) fs.unlinkSync(rt.sock); } catch {}
  user.neteaseRuntime = null;
  writeJson(USERS_FILE, db);
  return { ok: true };
}

/** ===== 兑换码 + 管理后台 ===== */
const CODES_FILE = path.join(DATA_DIR, "codes.json");
const ABADMIN_TOKEN = process.env.FB_ABADMIN_TOKEN || process.env.FB_MARKET_ADMIN_TOKEN || "";
const ABADMIN_USER = process.env.FB_ABADMIN_USER || "Diamond";
type RedeemCode = { code: string; planId: string; createdAt: number; createdBy?: string; usedBy?: string; usedByName?: string; usedAt?: number };
let codes: { list: RedeemCode[] } = readJson(CODES_FILE, { list: [] });
function saveCodes() { writeJson(CODES_FILE, codes); }
function abOk(req: IncomingMessage, url: URL) {
  const tk = String(req.headers["x-admin-token"] || "");
  const cu = currentUser(req);
  return !!ABADMIN_TOKEN && tk === ABADMIN_TOKEN && !!cu && cu.username === ABADMIN_USER;
}
function abUserView(u: any) {
  const b = billingView(u);
  return { id: u.id, username: u.username, verified: !!u.emailVerified, createdAt: u.createdAt || 0, plan: u.subPlan || "", expiresAt: u.subExpiresAt || 0, freeUsed: b.freeUsed, freeLimit: b.freeLimit, quota: b.quota, netease: !!u.netease, neteaseRoom: u.netease ? u.netease.roomIdMasked || "" : "", neteaseMode: u.netease ? u.netease.mode : "", owns: (u.pluginOwns || []).length };
}

/** ===== 第三方账号（网易版）：AES-256-GCM 加密存储 ===== */
const ACCOUNT_KEY = crypto.createHash("sha256").update(secret).digest();

function encryptSecret(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ACCOUNT_KEY, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64url"), tag.toString("base64url"), enc.toString("base64url")].join(".");
}

function decryptSecret(payload: string): string {
  try {
    const [ivB, tagB, dataB] = String(payload).split(".");
    if (!ivB || !tagB || !dataB) return "";
    const decipher = crypto.createDecipheriv("aes-256-gcm", ACCOUNT_KEY, Buffer.from(ivB, "base64url"));
    decipher.setAuthTag(Buffer.from(tagB, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(dataB, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

function neteaseView(user: any) {
  const ne = user.netease;
  if (!ne) return { configured: false };
  return {
    configured: true,
    mode: ne.mode || "server",
    roomId: ne.roomIdMasked || "",
    hasPassword: !!ne.passwordEnc,
    updatedAt: ne.updatedAt || 0,
  };
}

/** ===== 导入面板：密码解锁（12 小时） ===== */
const PANEL_UNLOCK_HOURS = 12;

function panelUnlockValue(uid: string): string {
  const payload = Buffer.from(JSON.stringify({ uid, exp: Date.now() + PANEL_UNLOCK_HOURS * 3600 * 1000, t: "panel" })).toString("base64url");
  return payload + "." + sign(payload);
}

function isPanelUnlocked(req: IncomingMessage, user: User): boolean {
  const raw = req.headers.cookie || "";
  const m = raw.match(/(?:^|;\s*)cq_panel=([^;]+)/);
  if (!m) return false;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return false;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sign(payload)), Buffer.from(sig))) return false;
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data?.uid === user.id && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function currentUser(req: IncomingMessage): User | null {
  const uid = readSession(req.headers.cookie);
  if (!uid) return null;
  return db.users.find((u) => u.id === uid) ?? null;
}

/** ===== 邮箱验证（QQ 邮箱 SMTP） ===== */
type SmtpConfig = { host: string; port: number; secure: boolean; user: string; pass: string; from: string };
const SMTP_FILE = path.join(DATA_DIR, "smtp.json");
const smtp: SmtpConfig | null = (() => {
  if (process.env.FB_SMTP_USER && process.env.FB_SMTP_PASS) {
    const user = process.env.FB_SMTP_USER;
    return { host: process.env.FB_SMTP_HOST || "smtp.qq.com", port: Number(process.env.FB_SMTP_PORT || 465), secure: true, user, pass: process.env.FB_SMTP_PASS, from: user };
  }
  try {
    const c = JSON.parse(fs.readFileSync(SMTP_FILE, "utf8"));
    if (c && c.user && c.pass) {
      return { host: c.host || "smtp.qq.com", port: Number(c.port || 465), secure: c.secure !== false, user: c.user, pass: c.pass, from: c.from || c.user };
    }
  } catch {}
  return null;
})();

function smtpCommand(sock: tls.TLSSocket, expect: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      sock.removeAllListeners("data");
      reject(new Error("SMTP 超时"));
    }, 12000);
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      // 多行响应：直到出现 "250 xxx"（最后一行）且行数匹配
      const lines = buf.split("\r\n").filter(Boolean);
      const last = lines[lines.length - 1] || "";
      if (/^\d{3} /.test(last)) {
        clearTimeout(timer);
        sock.removeListener("data", onData);
        const code = Number(last.slice(0, 3));
        if (code !== expect) reject(new Error(`SMTP 期望 ${expect}，实际 ${code}: ${last}`));
        else resolve(buf);
      }
    };
    sock.on("data", onData);
    try {
      if (payload !== "") sock.write(payload + "\r\n");
    } catch (e: any) {
      clearTimeout(timer);
      sock.removeListener("data", onData);
      reject(e);
    }
  });
}

/** 通过 QQ 邮箱 SMTP 发信（tls 465） */
async function sendMail(to: string, subject: string, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!smtp) return { ok: false, error: "未配置发件邮箱（site-data/smtp.json）" };
  return new Promise((resolve) => {
    const sock = tls.connect({ host: smtp.host, port: smtp.port, servername: smtp.host }, async () => {
      try {
        await smtpCommand(sock, 220, "");
        await smtpCommand(sock, 250, "EHLO cyanqiuper.local");
        await smtpCommand(sock, 334, "AUTH LOGIN");
        await smtpCommand(sock, 334, Buffer.from(smtp.user, "utf8").toString("base64"));
        await smtpCommand(sock, 235, Buffer.from(smtp.pass, "utf8").toString("base64"));
        await smtpCommand(sock, 250, `MAIL FROM:<${smtp.from}>`);
        await smtpCommand(sock, 250, `RCPT TO:<${to}>`);
        await smtpCommand(sock, 354, "DATA");
        const body = [
          `From: ${smtp.from}`,
          `To: ${to}`,
          `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=UTF-8",
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
        ].join("\r\n");
        await smtpCommand(sock, 250, body + "\r\n.");
        await smtpCommand(sock, 221, "QUIT");
        sock.end();
        resolve({ ok: true });
      } catch (e: any) {
        try { sock.destroy(); } catch {}
        resolve({ ok: false, error: String(e?.message ?? e) });
      }
    });
    sock.on("error", (e: any) => resolve({ ok: false, error: String(e?.message ?? e) }));
    sock.setTimeout(15000, () => {
      try { sock.destroy(); } catch {}
      resolve({ ok: false, error: "SMTP 连接超时" });
    });
  });
}

type EmailCode = { code: string; exp: number; tries: number };
const emailCodes = new Map<string, EmailCode>();
const sendCooldown = new Map<string, number>();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of emailCodes) if (v.exp < now) emailCodes.delete(k);
  for (const [k, v] of sendCooldown) if (v < now) sendCooldown.delete(k);
}, 60_000).unref();

/** ===== 登录/注册限速 ===== */
const attempts = new Map<string, { count: number; resetAt: number }>();
function tooMany(ip: string): boolean {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || now > rec.resetAt) {
    attempts.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return false;
  }
  rec.count++;
  return rec.count > 12;
}

/** ===== WS 状态 / 最近导入 ===== */
import * as http from "node:http";

function controlStatus(): Promise<any | null> {
  // 用 curl 子进程读取本机控制接口（Node 内置 http 在该进程里会超时，实测 curl 稳定）
  try {
    const out = execFileSync("/usr/bin/curl", ["-s", "--max-time", "3", `http://127.0.0.1:${CONTROL_PORT}/status`], {
      timeout: 4000,
      encoding: "utf8",
    });
    return Promise.resolve(JSON.parse(out));
  } catch {
    return Promise.resolve(null);
  }
}
function recentImports(): { at: string; name: string; result: string }[] {
  try {
    const lines = fs.readFileSync(path.join(LOG_DIR, "ws.log"), "utf8").trimEnd().split("\n");
    const out: { at: string; name: string; result: string }[] = [];
    for (let i = lines.length - 1; i >= 0 && out.length < 10; i--) {
      const line = lines[i];
      const m = line.match(/^\[([^\]]+)\]/);
      const at = m ? m[1] : "";
      if (line.includes("三步全部通过")) {
        const nm = line.match(/「([^」]+)」/);
        out.push({ at, name: nm ? nm[1] : "结构", result: "通过" });
      } else if (line.includes("校验未通过")) {
        const nm = line.match(/「([^」]+)」/);
        out.push({ at, name: nm ? nm[1] : "结构", result: "未通过" });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** ===== 计费：免费额度 / 订阅 / 支付 ===== */
const FREE_IMPORT_LIMIT = 10;
type Plan = { kind: "sub" | "quota"; tier?: string; days?: number; count?: number; money: string; name: string; desc?: string };
const TIERS: { id: string; name: string; mult: number; desc: string }[] = [
  { id: "pro", name: "PRO", mult: 1, desc: "基础个人版 · 订阅期内不限次导入" },
  { id: "plus", name: "Plus", mult: 1.5, desc: "进阶个人版 · 订阅期内不限次导入" },
  { id: "max", name: "MAX", mult: 2, desc: "高阶个人版 · 订阅期内不限次导入" },
  { id: "ultra", name: "ULTRA", mult: 3, desc: "顶级个人版 · 订阅期内不限次导入" },
];
const DURATIONS: { id: string; name: string; days: number; base: number }[] = [
  { id: "1m", name: "1 个月", days: 30, base: 5 },
  { id: "3m", name: "3 个月", days: 90, base: 15 },
  { id: "6m", name: "6 个月", days: 180, base: 25 },
  { id: "12m", name: "12 个月", days: 365, base: 50 },
];
const PLANS: Record<string, Plan> = {};
for (const t of TIERS) {
  for (const d of DURATIONS) {
    PLANS[`${t.id}_${d.id}`] = {
      kind: "sub",
      tier: t.name,
      days: d.days,
      money: (d.base * t.mult).toFixed(2),
      name: `${t.name} · ${d.name}`,
      desc: t.desc,
    };
  }
}
PLANS.quota10 = { kind: "quota", count: 10, money: "3.00", name: "导入额度 · 10 次" };
PLANS.quota50 = { kind: "quota", count: 50, money: "12.00", name: "导入额度 · 50 次" };
PLANS.quota200 = { kind: "quota", count: 200, money: "40.00", name: "导入额度 · 200 次" };

type PayConfig = { api: string; pid: string; key: string };
const PAY_FILE = path.join(DATA_DIR, "pay.json");
const payConfig: PayConfig | null = (() => {
  if (process.env.FB_PAY_KEY && process.env.FB_PAY_PID) {
    return {
      api: process.env.FB_PAY_API || "https://pays.1660.net.cn",
      pid: process.env.FB_PAY_PID,
      key: process.env.FB_PAY_KEY,
    };
  }
  try {
    const c = JSON.parse(fs.readFileSync(PAY_FILE, "utf8"));
    if (c && c.pid && c.key) return { api: c.api || "https://pays.1660.net.cn", pid: String(c.pid), key: String(c.key) };
  } catch {}
  return null;
})();

function ensureBilling(user: any) {
  if (typeof user.freeUsed !== "number") user.freeUsed = 0;
  if (typeof user.quota !== "number") user.quota = 0;
  if (typeof user.subExpiresAt !== "number") user.subExpiresAt = 0;
  if (!Array.isArray(user.orders)) user.orders = [];
}

function billingView(user: any) {
  ensureBilling(user);
  const subActive = user.subExpiresAt > Date.now();
  return {
    freeUsed: user.freeUsed,
    freeLimit: FREE_IMPORT_LIMIT,
    quota: user.quota,
    subExpiresAt: user.subExpiresAt,
    subActive,
    subPlan: user.subPlan || "",
    subPlanName: subActive ? user.subPlan || "PRO" : "",
    canImport: subActive || user.quota > 0 || user.freeUsed < FREE_IMPORT_LIMIT,
  };
}

function consumeQuota(user: any) {
  ensureBilling(user);
  if (user.subExpiresAt > Date.now()) return;
  if (user.quota > 0) user.quota--;
  else user.freeUsed++;
  writeJson(USERS_FILE, db);
}

function paySign(params: Record<string, string>): string {
  if (!payConfig) return "";
  const keys = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type" && params[k] !== "" && params[k] != null)
    .sort();
  const str = keys.map((k) => k + "=" + params[k]).join("&") + payConfig.key;
  return crypto.createHash("md5").update(str, "utf8").digest("hex").toLowerCase();
}

function grantPlan(user: any, plan: Plan) {
  ensureBilling(user);
  if (plan.kind === "sub") {
    user.subPlan = plan.tier || plan.name.split(" · ")[0];
    user.subExpiresAt = Math.max(Date.now(), user.subExpiresAt) + (plan.days || 30) * 86400000;
  } else {
    user.quota += plan.count || 0;
  }
  writeJson(USERS_FILE, db);
}

/** 确保用户有终端令牌（用于独立导入面板的鉴权） */
const PANEL_TOKEN_HOURS = 12;

/** 生成/续期终端令牌：开启终端或主动刷新时生成，12 小时有效 */
function ensurePanelToken(user: any, force = false): { token: string; expiresAt: number } {
  const now = Date.now();
  if (force || !user.panelToken || !user.panelTokenExp || user.panelTokenExp < now) {
    user.panelToken = crypto.randomBytes(24).toString("hex");
    user.panelTokenExp = now + PANEL_TOKEN_HOURS * 3600 * 1000;
    writeJson(USERS_FILE, db);
    log(`已为用户 ${user.username} 生成终端令牌（12 小时有效）`);
  }
  return { token: user.panelToken, expiresAt: user.panelTokenExp };
}

/** ===== 每用户独立导入器实例 ===== */
type InstRec = { uid: string; index: number; pid: number; startedAt: number; lastActive: number };
const INST_FILE = path.join(DATA_DIR, "instances.json");
let instRecs: Record<string, InstRec> = readJson(INST_FILE, {});
const MAX_INSTANCES = Number(process.env.FB_MAX_INSTANCES || 20);
const USER_WS_BASE = Number(process.env.FB_USER_WS_BASE || 12000);
const USER_CTRL_BASE = Number(process.env.FB_USER_CTRL_BASE || 13000);
const USER_JAVA_BASE = Number(process.env.FB_USER_JAVA_BASE || 12200);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function allocIndex(uid: string): number {
  if (instRecs[uid]) return instRecs[uid].index;
  const used = new Set(Object.values(instRecs).map((r) => r.index));
  for (let i = 0; i < MAX_INSTANCES; i++) if (!used.has(i)) return i;
  throw new Error("当前使用人数较多，请稍后再试");
}

function ctrlGet(ctrlPort: number, p: string): any | null {
  try {
    const out = execFileSync("/usr/bin/curl", ["-s", "--max-time", "3", `http://127.0.0.1:${ctrlPort}${p}`], {
      encoding: "utf8",
      timeout: 4000,
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function ctrlPost(ctrlPort: number, p: string, body: any, timeoutMs = 90000): any | null {
  const tmp = path.join(os.tmpdir(), `cq-${crypto.randomUUID()}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(body ?? {}));
    const out = execFileSync(
      "/usr/bin/curl",
      [
        "-s",
        "--max-time",
        String(Math.max(5, Math.round(timeoutMs / 1000))),
        "-X",
        "POST",
        "-H",
        "content-type: application/json",
        "--data-binary",
        `@${tmp}`,
        `http://127.0.0.1:${ctrlPort}${p}`,
      ],
      { encoding: "utf8", timeout: timeoutMs + 5000 }
    );
    return JSON.parse(out);
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

/** 启动（或复用）该用户的独立导入器实例 */
async function ensureInstance(uid: string): Promise<{ wsPort: number; ctrlPort: number; started: boolean }> {
  const idx = allocIndex(uid);
  const wsPort = USER_WS_BASE + idx;
  const ctrlPort = USER_CTRL_BASE + idx;
  const rec: InstRec = instRecs[uid] ?? { uid, index: idx, pid: 0, startedAt: 0, lastActive: 0 };
  rec.index = idx;
  rec.lastActive = Date.now();
  instRecs[uid] = rec;
  writeJson(INST_FILE, instRecs);
  if (ctrlGet(ctrlPort, "/ping")) return { wsPort, ctrlPort, started: false };

  const userLogs = path.join(DATA_DIR, "users", uid, "logs");
  fs.mkdirSync(userLogs, { recursive: true });
  // 用 systemd-run --scope 启动：实例属于独立的 transient scope，
  // 这样重启 / 部署 cyanqiuper-site 时不会把正在导入的实例一起杀掉。
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const unit = `cq-inst-${uid.slice(0, 8)}`;
  const isLinux = process.platform === "linux";
  const instEnv = {
    ...process.env,
    FB_WS_PORT: String(wsPort),
    FB_CONTROL_PORT: String(ctrlPort),
    FB_LOG_DIR: userLogs,
    FB_USERS_FILE: path.join(DATA_DIR, "users.json"),
    FB_OWNER_UID: uid,
    FB_USER_ID: uid,
  };
  const child = isLinux
    ? spawn(
        "systemd-run",
        [
          "--scope",
          "--quiet",
          "--collect",
          `--unit=${unit}`,
          `--working-directory=${ROOT}`,
          `--setenv=FB_WS_PORT=${wsPort}`,
          `--setenv=FB_CONTROL_PORT=${ctrlPort}`,
          `--setenv=FB_LOG_DIR=${userLogs}`,
          `--setenv=FB_USERS_FILE=${path.join(DATA_DIR, "users.json")}`,
          `--setenv=FB_OWNER_UID=${uid}`,
          `--setenv=FB_USER_ID=${uid}`,
          process.execPath,
          tsxCli,
          "main.ts",
        ],
        { cwd: ROOT, detached: true, stdio: "ignore" }
      )
    : spawn(process.execPath, [tsxCli, "main.ts"], { cwd: ROOT, env: instEnv, detached: true, stdio: "ignore" });
  child.unref();
  rec.pid = child.pid ?? 0;
  (rec as any).unit = unit;
  rec.startedAt = Date.now();
  writeJson(INST_FILE, instRecs);
  log(`为用户 ${uid.slice(0, 8)} 启动独立导入器：WS ${wsPort} / 控制 ${ctrlPort}（pid ${child.pid}）`);
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    if (ctrlGet(ctrlPort, "/ping")) break;
  }
  return { wsPort, ctrlPort, started: true };
}

/** ===== HTTP 工具 ===== */
function json(res: ServerResponse, code: number, data: unknown) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

function readFileSafe(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function validName(name: string): boolean {
  return /^[A-Za-z0-9_\u4e00-\u9fa5-]{2,20}$/.test(name);
}

/** ===== 路由 ===== */
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const p = url.pathname;
    const ip = (req.headers["x-real-ip"] as string) || req.socket.remoteAddress || "";

    // ---- 公开接口 ----
    if (p === "/pay/return") {
      // 支付完成返回页：真实到账以异步 notify 为准，这里只做跳转
      res.writeHead(302, { location: "/pay?paid=1" });
      return res.end();
    }
    if (p === "/api/site/status") {
      const s = await controlStatus();
      // 11453 控制接口返回的是扁平对象（running/port/sessionCount/stats…）
      const ws = s ?? null;
      return json(res, 200, {
        ok: true,
        ws: ws
          ? {
              running: !!ws.running,
              port: ws.port,
              sessionCount: ws.sessionCount ?? 0,
              active: ws.active ? { address: ws.active.address, encrypted: !!ws.active.encrypted } : null,
              stats: ws.stats ?? {},
            }
          : null,
        recent: recentImports(),
        serverNow: utc8(),
      });
    }

    if (p === "/api/site/usage") {
      return json(res, 200, { ok: true, recent: recentImports() });
    }

    // ---- 发送邮箱验证码（QQ 邮箱） ----
    if (p === "/api/auth/send-code" && req.method === "POST") {
      if (!EMAIL_VERIFY) return json(res, 200, { ok: false, error: "当前部署未开启邮箱验证，直接注册即可" });
      const body = await readBody(req);
      const qq = String(body.qq ?? "").trim();
      if (!/^[1-9][0-9]{4,11}$/.test(qq)) return json(res, 400, { ok: false, error: "请填写正确的 QQ 号" });
      const now = Date.now();
      const last = sendCooldown.get(qq) ?? 0;
      if (now - last < 60_000) return json(res, 429, { ok: false, error: "发送太频繁，请 60 秒后再试" });
      if (!smtp) return json(res, 500, { ok: false, error: "服务端未配置发件邮箱，请联系管理员" });
      const ipLast = sendCooldown.get("ip:" + ip) ?? 0;
      if (now - ipLast < 30_000) return json(res, 429, { ok: false, error: "发送太频繁，请稍后再试" });
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const mail = await sendMail(
        (process.env.FB_SMTP_TO_OVERRIDE || qq + "@qq.com") as string,
        "CyanQiuper 注册验证码",
        `你的 CyanQiuper 注册验证码是：${code}\n\n10 分钟内有效。如果不是你本人操作，请忽略本邮件。`
      );
      if (!mail.ok) {
        log(`发送验证码失败（QQ ${qq.slice(0, 3)}***）：${mail.error}`);
        return json(res, 500, { ok: false, error: "验证码发送失败，请稍后再试" });
      }
      emailCodes.set(qq, { code, exp: now + 10 * 60 * 1000, tries: 0 });
      sendCooldown.set(qq, now);
      sendCooldown.set("ip:" + ip, now);
      log(`发送注册验证码到 ${qq.slice(0, 3)}***@qq.com（${ip}）`);
      return json(res, 200, { ok: true, ...(process.env.FB_EMAIL_DEBUG === "1" ? { code } : {}) });
    }

    // ---- 注册 ----
    if (p === "/api/auth/register" && req.method === "POST") {
      if (tooMany(ip)) return json(res, 429, { ok: false, error: "尝试次数过多，请稍后再试" });
      const body = await readBody(req);
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      const qq = String(body.qq ?? "").trim();
      const code = String(body.code ?? "").trim();
      if (!EMAIL_VERIFY) {
        if (!validName(username)) return json(res, 400, { ok: false, error: "用户名需 2-20 位（字母/数字/下划线/中文）" });
        if (password.length < 6) return json(res, 400, { ok: false, error: "密码至少 6 位" });
        if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
          return json(res, 400, { ok: false, error: "用户名已被注册" });
        }
        const nu = makeUser(username, password);
        (nu as any).emailVerified = false;
        db.users.push(nu);
        writeJson(USERS_FILE, db);
        log(`新用户注册（免验证）：${username}（${ip}）`);
        res.setHeader("set-cookie", `cq_user=${makeSession(nu.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`);
        return json(res, 200, { ok: true, user: { username: nu.username } });
      }
      if (!validName(username)) return json(res, 400, { ok: false, error: "用户名需 2-20 位（字母/数字/下划线/中文）" });
      if (password.length < 6) return json(res, 400, { ok: false, error: "密码至少 6 位" });
      if (!/^[1-9][0-9]{4,11}$/.test(qq)) return json(res, 400, { ok: false, error: "请填写正确的 QQ 号" });
      const pending = emailCodes.get(qq);
      if (!pending) return json(res, 400, { ok: false, error: "请先获取邮箱验证码" });
      if (pending.exp < Date.now()) {
        emailCodes.delete(qq);
        return json(res, 400, { ok: false, error: "验证码已过期，请重新获取" });
      }
      if (pending.code !== code) {
        pending.tries++;
        if (pending.tries >= 5) emailCodes.delete(qq);
        return json(res, 400, { ok: false, error: "验证码不正确" });
      }
      emailCodes.delete(qq);
      if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
        return json(res, 400, { ok: false, error: "用户名已被注册" });
      }
      const user = makeUser(username, password);
      (user as any).qq = qq;
      (user as any).email = qq + "@qq.com";
      (user as any).emailVerified = true;
      db.users.push(user);
      writeJson(USERS_FILE, db);
      log(`新用户注册：${username}（${ip}）`);
      res.setHeader("set-cookie", `cq_user=${makeSession(user.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`);
      return json(res, 200, { ok: true, user: { username: user.username } });
    }

    // ---- 登录 ----
    if (p === "/api/auth/login" && req.method === "POST") {
      if (tooMany(ip)) return json(res, 429, { ok: false, error: "尝试次数过多，请稍后再试" });
      const body = await readBody(req);
      const username = String(body.username ?? "").trim();
      const password = String(body.password ?? "");
      const user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
      if (!user || !verifyPassword(user, password)) {
        return json(res, 401, { ok: false, error: "用户名或密码错误" });
      }
      user.lastLoginAt = Date.now();
      user.logins.push({ at: Date.now(), ip });
      user.logins = user.logins.slice(-30);
      writeJson(USERS_FILE, db);
      log(`用户登录：${user.username}（${ip}）`);
      res.setHeader("set-cookie", `cq_user=${makeSession(user.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`);
      return json(res, 200, { ok: true, user: { username: user.username } });
    }

    // ---- 当前用户 ----
    if (p === "/api/me") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { ok: false, error: "未登录" });
      return json(res, 200, {
        ok: true,
        user: {
          username: user.username,
          qq: (user as any).qq || "",
          email: (user as any).email || "",
          createdAt: user.createdAt,
          lastLoginAt: user.lastLoginAt,
          logins: user.logins.slice(-10).reverse(),
        },
        recent: recentImports(),
      });
    }

    if (p === "/api/auth/me") {
      const u = currentUser(req);
      return json(res, 200, { ok: true, user: u ? { username: u.username } : null });
    }
    if (p === "/api/auth/logout" && req.method === "POST") {
      res.setHeader("set-cookie", "cq_user=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
      return json(res, 200, { ok: true });
    }

    // ---- 修改密码 ----
    if (p === "/api/auth/password" && req.method === "POST") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { ok: false, error: "未登录" });
      const body = await readBody(req);
      const oldPassword = String(body.oldPassword ?? "");
      const newPassword = String(body.newPassword ?? "");
      if (!verifyPassword(user, oldPassword)) return json(res, 400, { ok: false, error: "原密码错误" });
      if (newPassword.length < 6) return json(res, 400, { ok: false, error: "新密码至少 6 位" });
      user.salt = crypto.randomBytes(16).toString("hex");
      user.hash = hashPassword(newPassword, user.salt);
      writeJson(USERS_FILE, db);
      log(`用户改密：${user.username}（${ip}）`);
      return json(res, 200, { ok: true });
    }

    // ---- 导入队列 ----
    if (p === "/api/my/queue") {
      const qu = currentUser(req);
      if (!qu) return json(res, 401, { ok: false, error: "未登录" });
      return json(res, 200, {
        ok: true,
        limit: IMPORT_LIMIT,
        active: IMPORT_ACTIVE.size,
        queued: IMPORT_QUEUE.length,
        myPosition: IMPORT_QUEUE.findIndex((q) => q.uid === qu.id) + 1,
        myActive: IMPORT_ACTIVE.has(qu.id),
      });
    }

    // ---- 兑换码 / 管理后台 ----
    if (p === "/api/my/redeem" && req.method === "POST") {
      const u = currentUser(req);
      if (!u) return json(res, 401, { ok: false, error: "请先登录" });
      const body = await readBody(req);
      const code = String(body.code || "").trim().toUpperCase();
      const item = codes.list.find((x) => x.code === code);
      if (!item) return json(res, 200, { ok: false, error: "兑换码不存在" });
      if (item.usedBy) return json(res, 200, { ok: false, error: "兑换码已被使用" });
      const plan: any = (PLANS as any)[item.planId];
      if (!plan) return json(res, 200, { ok: false, error: "兑换码对应的套餐已下架，请联系管理员" });
      grantPlan(u, plan);
      item.usedBy = u.id; item.usedByName = u.username; item.usedAt = Date.now();
      saveCodes(); writeJson(USERS_FILE, db);
      log("兑换码使用：" + u.username + " 兑换 " + item.planId);
      return json(res, 200, { ok: true, planId: item.planId });
    }
    if (p.startsWith("/api/abadmin/")) {
      if (!abOk(req, url)) return json(res, 403, { ok: false, error: "管理员令牌无效" });
      if (p === "/api/abadmin/users") {
        return json(res, 200, { ok: true, users: db.users.map(abUserView) });
      }
      if (p === "/api/abadmin/user") {
        const id = String(url.searchParams.get("id") || "");
        const u: any = db.users.find((x) => x.id === id);
        if (!u) return json(res, 404, { ok: false, error: "用户不存在" });
        return json(res, 200, { ok: true, user: abUserView(u), detail: { netease: u.netease ? { mode: u.netease.mode, roomId: u.netease.roomIdMasked, hasCookie: !!u.netease.cookieEnc, hasPassword: !!u.netease.passwordEnc, updatedAt: u.netease.updatedAt } : null, orders: (u.orders || []).slice(-20).reverse(), pluginOwns: u.pluginOwns || [], lastLoginAt: u.lastLoginAt || 0 } });
      }
      if (p === "/api/abadmin/codes" && req.method === "GET") {
        return json(res, 200, { ok: true, codes: codes.list.slice().reverse() });
      }
      if (p === "/api/abadmin/codes" && req.method === "POST") {
        const body = await readBody(req);
        const planId = String(body.planId || "");
        const count = Math.min(200, Math.max(1, Number(body.count || 1)));
        if (!(PLANS as any)[planId]) return json(res, 400, { ok: false, error: "套餐不存在" });
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
          const code = "CQ" + crypto.randomBytes(4).toString("hex").toUpperCase() + crypto.randomBytes(2).toString("hex").toUpperCase();
          codes.list.push({ code, planId, createdAt: Date.now() });
          out.push(code);
        }
        saveCodes();
        log("生成兑换码 " + count + " 个：" + planId);
        return json(res, 200, { ok: true, codes: out });
      }
      if (p === "/api/abadmin/grant" && req.method === "POST") {
        const body = await readBody(req);
        const name = String(body.username || "");
        const u: any = db.users.find((x) => x.username === name);
        if (!u) return json(res, 404, { ok: false, error: "用户不存在" });
        if (body.quota) { ensureBilling(u); u.quota = (u.quota || 0) + Math.max(0, Number(body.quota)); }
        if (body.planId) { const plan: any = (PLANS as any)[body.planId]; if (!plan) return json(res, 400, { ok: false, error: "套餐不存在" }); grantPlan(u, plan); }
        writeJson(USERS_FILE, db);
        return json(res, 200, { ok: true, user: abUserView(u) });
      }
      if (p === "/api/abadmin/password" && req.method === "POST") {
        const body = await readBody(req);
        const u: any = db.users.find((x) => x.username === String(body.username || ""));
        const np = String(body.newPassword || "");
        if (!u) return json(res, 404, { ok: false, error: "用户不存在" });
        if (np.length < 6) return json(res, 400, { ok: false, error: "密码至少 6 位" });
        u.salt = crypto.randomBytes(16).toString("hex");
        u.hash = hashPassword(np, u.salt);
        writeJson(USERS_FILE, db);
        log("管理员重置密码：" + u.username);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { ok: false, error: "not found" });
    }

    // ---- 插件市场 ----
    if (p.startsWith("/api/market/")) {
      const user = currentUser(req);
      if (p === "/api/market/list") {
        return json(res, 200, {
          ok: true,
          plugins: market.plugins
            .filter((x) => x.status === "approved" || (user && x.creatorUid === user.id && x.status !== "rejected"))
            .sort((a, b) => (b.approvedAt || b.createdAt) - (a.approvedAt || a.createdAt))
            .map((x) => marketPublic(x, user)),
          priceMax: MARKET_PRICE_MAX,
        });
      }
      if (!user) return json(res, 401, { ok: false, error: "请先登录" });
      if (p === "/api/market/mine") {
        const owns = (user as any).pluginOwns || [];
        return json(res, 200, {
          ok: true,
          mine: market.plugins.filter((x) => x.creatorUid === user.id).map((x) => marketPublic(x, user)),
          owned: market.plugins.filter((x) => owns.includes(x.id) && x.status === "approved").map((x) => marketPublic(x, user)),
        });
      }
      if (p === "/api/market/upload" && req.method === "POST") {
        const body = await readBody(req, 512 * 1024);
        const name = String(body.name || "").trim().slice(0, 40);
        const desc = String(body.desc || "").trim().slice(0, 800);
        const version = String(body.version || "1.0.0").trim().slice(0, 20);
        const price = Number(body.price || 0);
        const code = String(body.code || "");
        if (!name) return json(res, 400, { ok: false, error: "请填写插件名称" });
        if (!Number.isFinite(price) || price < 0 || price > MARKET_PRICE_MAX) {
          return json(res, 400, { ok: false, error: "价格需在 0 ~ " + MARKET_PRICE_MAX + " 元之间" });
        }
        if (!code.trim() || code.length > 400000) return json(res, 400, { ok: false, error: "插件代码为空或过大" });
        const existed = market.plugins.find((x) => x.creatorUid === user.id && x.name === name && x.status !== "rejected");
        if (existed) return json(res, 400, { ok: false, error: "你已上传过同名插件" });
        const id = "pl_" + crypto.randomBytes(8).toString("hex");
        const file = path.join(PLUGIN_DIR, id + ".lua");
        fs.writeFileSync(file, code, { mode: 0o600 });
        const plugin: MarketPlugin = {
          id,
          name,
          desc,
          version,
          price: Math.round(price * 100) / 100,
          file,
          creatorUid: user.id,
          creatorName: user.username,
          status: "pending",
          sales: 0,
          createdAt: Date.now(),
        };
        market.plugins.push(plugin);
        saveMarket();
        log(`插件上传：${user.username} 上传「${name}」¥${plugin.price}（待审核）`);
        return json(res, 200, { ok: true, plugin: marketPublic(plugin, user) });
      }
      if (p === "/api/market/buy" && req.method === "POST") {
        const body = await readBody(req);
        const id = String(body.id || "");
        const pl = market.plugins.find((x) => x.id === id && x.status === "approved");
        if (!pl) return json(res, 404, { ok: false, error: "插件不存在或未上架" });
        (user as any).pluginOwns = (user as any).pluginOwns || [];
        if ((user as any).pluginOwns.includes(pl.id) || pl.creatorUid === user.id) {
          return json(res, 200, { ok: true, alreadyOwned: true });
        }
        if (pl.price <= 0) {
          (user as any).pluginOwns.push(pl.id);
          pl.sales = (pl.sales || 0) + 1;
          writeJson(USERS_FILE, db);
          saveMarket();
          return json(res, 200, { ok: true, free: true });
        }
        if (!payConfig) return json(res, 200, { ok: false, error: "支付通道未配置，暂时无法购买付费插件" });
        ensureBilling(user);
        const orderNo = "MK" + Date.now() + Math.floor(1000 + Math.random() * 9000);
        const host = String(req.headers["x-forwarded-host"] || req.headers.host || "localhost").split(":")[0];
        const proto = String(req.headers["x-forwarded-proto"] || "https");
        const params: Record<string, string> = {
          pid: payConfig.pid,
          type: "alipay",
          out_trade_no: orderNo,
          notify_url: `${proto}://${host}/api/pay/notify`,
          return_url: `${proto}://${host}/pay/return`,
          name: "插件：" + pl.name,
          money: pl.price.toFixed(2),
          clientip: ip,
          device: "pc",
          param: "",
          sign_type: "MD5",
        };
        params.sign = paySign(params);
        const order: any = { no: orderNo, planId: "plugin:" + pl.id, name: "插件：" + pl.name, money: pl.price.toFixed(2), status: "paying", createdAt: Date.now() };
        user.orders.push(order);
        writeJson(USERS_FILE, db);
        let gateway: any = null;
        try {
          const res2 = await fetch(payConfig.api + "/mapi.php", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(params).toString(),
            signal: AbortSignal.timeout(15000),
          });
          gateway = await res2.json();
        } catch (e: any) {
          gateway = { code: 0, msg: String(e?.message ?? e) };
        }
        if (!gateway || Number(gateway.code) !== 1) {
          order.status = "failed";
          writeJson(USERS_FILE, db);
          return json(res, 200, { ok: false, error: "支付创建失败：" + (gateway?.msg || "网关无响应") });
        }
        order.tradeNo = gateway.trade_no || "";
        writeJson(USERS_FILE, db);
        return json(res, 200, { ok: true, orderNo, payurl: gateway.payurl || null, qrcode: gateway.qrcode || null, urlscheme: gateway.urlscheme || null });
      }
      if (p === "/api/market/download") {
        const id = String(url.searchParams.get("id") || "");
        const pl = market.plugins.find((x) => x.id === id);
        if (!pl || pl.status !== "approved") return json(res, 404, { ok: false, error: "插件不存在" });
        const owns = ((user as any).pluginOwns || []).includes(pl.id) || pl.creatorUid === user.id || pl.price <= 0;
        if (!owns) return json(res, 403, { ok: false, error: "请先购买该插件" });
        try {
          const content = fs.readFileSync(pl.file, "utf8");
          res.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": `attachment; filename="${encodeURIComponent(pl.name)}.lua"`,
            "cache-control": "no-store",
          });
          return res.end(content);
        } catch {
          return json(res, 404, { ok: false, error: "文件不存在" });
        }
      }
      if (p === "/api/market/admin/list") {
        if (!checkAdminToken(req, url)) return json(res, 403, { ok: false, error: "管理员令牌无效" });
        return json(res, 200, { ok: true, plugins: market.plugins.map((x) => { let code = ""; try { code = fs.readFileSync(x.file, "utf8"); } catch {} return { ...marketPublic(x, null), code }; }) });
      }
      if (p === "/api/market/admin/review" && req.method === "POST") {
        if (!checkAdminToken(req, url)) return json(res, 403, { ok: false, error: "管理员令牌无效" });
        const body = await readBody(req);
        const id = String(body.id || "");
        const action = String(body.action || "");
        const pl = market.plugins.find((x) => x.id === id);
        if (!pl) return json(res, 404, { ok: false, error: "插件不存在" });
        if (action === "approve") {
          pl.status = "approved";
          pl.approvedAt = Date.now();
          pl.rejectReason = "";
        } else if (action === "reject") {
          pl.status = "rejected";
          pl.rejectReason = String(body.reason || "未通过审核").slice(0, 200);
        } else {
          return json(res, 400, { ok: false, error: "action 只能是 approve 或 reject" });
        }
        saveMarket();
        log(`插件审核：${pl.name} → ${pl.status}`);
        return json(res, 200, { ok: true, plugin: marketPublic(pl, null) });
      }
      return json(res, 404, { ok: false, error: "not found" });
    }

    // ---- 计费 / 支付 ----
    if (p === "/api/site/config") {
      return json(res, 200, {
        ok: true,
        app: APP_NAME,
        emailVerify: EMAIL_VERIFY,
        payEnabled: !!payConfig,
      });
    }
    if (p === "/api/pay/plans") {
      return json(res, 200, {
        ok: true,
        plans: Object.entries(PLANS).map(([id, x]) => ({ id, ...x })),
        tiers: TIERS,
        durations: DURATIONS,
        freeLimit: FREE_IMPORT_LIMIT,
      });
    }
    if (p === "/api/my/billing") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { ok: false, error: "未登录" });
      return json(res, 200, { ok: true, billing: billingView(user), orders: (user.orders || []).slice(-10).reverse() });
    }
    if (p === "/api/pay/create" && req.method === "POST") {
      const user = currentUser(req);
      if (!user) return json(res, 401, { ok: false, error: "未登录" });
      if (!payConfig) return json(res, 200, { ok: false, error: "支付通道未配置" });
      const body = await readBody(req);
      const planId = String(body.planId || "");
      const plan = PLANS[planId];
      if (!plan) return json(res, 400, { ok: false, error: "套餐不存在" });
      ensureBilling(user);
      const orderNo = "CQ" + Date.now() + Math.floor(1000 + Math.random() * 9000);
      const host = String(req.headers["x-forwarded-host"] || req.headers.host || "qiuper.blueworkshop.top").split(":")[0];
      const proto = String(req.headers["x-forwarded-proto"] || "https");
      const params: Record<string, string> = {
        pid: payConfig.pid,
        type: String(body.type || "alipay"),
        out_trade_no: orderNo,
        notify_url: `${proto}://${host}/api/pay/notify`,
        return_url: `${proto}://${host}/pay/return`,
        name: plan.name,
        money: plan.money,
        clientip: ip,
        device: "pc",
        param: "",
        sign_type: "MD5",
      };
      params.sign = paySign(params);
      const order: any = {
        no: orderNo,
        planId,
        name: plan.name,
        money: plan.money,
        status: "pending",
        createdAt: Date.now(),
      };
      user.orders.push(order);
      writeJson(USERS_FILE, db);
      let gateway: any = null;
      try {
        const res2 = await fetch(payConfig.api + "/mapi.php", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(params).toString(),
          signal: AbortSignal.timeout(15000),
        });
        gateway = await res2.json();
      } catch (e: any) {
        gateway = { code: 0, msg: String(e?.message ?? e) };
      }
      if (!gateway || Number(gateway.code) !== 1) {
        order.status = "failed";
        writeJson(USERS_FILE, db);
        log(`创建支付失败 ${orderNo}：${gateway?.msg ?? "unknown"}`);
        return json(res, 200, { ok: false, error: `支付创建失败：${gateway?.msg ?? "网关无响应"}` });
      }
      order.status = "paying";
      order.tradeNo = gateway.trade_no || "";
      writeJson(USERS_FILE, db);
      log(`创建支付订单 ${orderNo}（${plan.name} ¥${plan.money}）`);
      return json(res, 200, {
        ok: true,
        orderNo,
        payurl: gateway.payurl || null,
        qrcode: gateway.qrcode || null,
        urlscheme: gateway.urlscheme || null,
      });
    }
    if (p === "/api/pay/notify") {
      if (!payConfig) {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("fail");
      }
      const q: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { q[k] = v; });
      const sign = q.sign || "";
      const expect = paySign(q);
      if (!sign || sign !== expect) {
        log(`支付回调签名失败：${q.out_trade_no ?? "?"}`);
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("fail");
      }
      if (q.trade_status !== "TRADE_SUCCESS") {
        res.writeHead(200, { "content-type": "text/plain" });
        return res.end("success");
      }
      const orderNo = String(q.out_trade_no || "");
      const owner = db.users.find((u: any) => (u.orders || []).some((o: any) => o.no === orderNo));
      const order = owner ? owner.orders.find((o: any) => o.no === orderNo) : null;
      if (owner && order) {
        if (order.status !== "paid") {
          if (String(order.planId).startsWith("plugin:")) {
            const pid = String(order.planId).slice("plugin:".length);
            (owner as any).pluginOwns = (owner as any).pluginOwns || [];
            if (!(owner as any).pluginOwns.includes(pid)) (owner as any).pluginOwns.push(pid);
            const pl = market.plugins.find((x) => x.id === pid);
            if (pl) pl.sales = (pl.sales || 0) + 1;
            saveMarket();
          } else {
            grantPlan(owner, PLANS[order.planId] || { kind: "quota", count: 0, money: "0", name: "未知" });
          }
          order.status = "paid";
          order.paidAt = Date.now();
          order.tradeNo = q.trade_no || order.tradeNo || "";
          writeJson(USERS_FILE, db);
          log(`支付成功：${owner.username} 购买 ${order.name} ¥${order.money}（${orderNo}）`);
        }
      } else {
        log(`支付回调：找不到订单 ${orderNo}`);
      }
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("success");
    }

    // ---- 我的导入器（每用户独立实例） ----
    if (p.startsWith("/api/my/")) {
      const user = currentUser(req);
      if (!user) return json(res, 401, { ok: false, error: "未登录" });
      const host = String(req.headers["x-forwarded-host"] || req.headers.host || "qiuper.blueworkshop.top")
        .split(":")[0];
      if (p === "/api/my/instance/stop" && req.method === "POST") {
        const rec = instRecs[user.id];
        if (!rec) return json(res, 200, { ok: true, stopped: false });
        const unit = (rec as any).unit || `cq-inst-${user.id.slice(0, 8)}`;
        try {
          execFileSync("systemctl", ["stop", unit + ".scope"], { encoding: "utf8", timeout: 10000 });
        } catch {}
        try {
          if (rec.pid) process.kill(rec.pid, "SIGTERM");
        } catch {}
        delete instRecs[user.id];
        writeJson(INST_FILE, instRecs);
        log(`用户 ${user.username} 关闭了导入器（${unit}）`);
        return json(res, 200, { ok: true, stopped: true });
      }
      if (p === "/api/my/instance" && req.method === "POST") {
        try {
          // 每次开启导入器都生成全新的令牌
          ensurePanelToken(user, true);
          const inst = await ensureInstance(user.id);
          const st = ctrlGet(inst.ctrlPort, "/status");
          return json(res, 200, {
            ok: true,
            wsUrl: `ws://${host}:${inst.wsPort}`,
            wsPort: inst.wsPort,
            connectCommand: `/connect ws://${host}:${inst.wsPort}`,
            running: !!st?.running,
            sessionCount: st?.sessionCount ?? 0,
          authenticatedSessionCount: st?.authenticatedSessionCount ?? 0,
          });
        } catch (e: any) {
          return json(res, 200, { ok: false, error: String(e?.message ?? e) });
        }
      }
      if (p === "/api/my/panel-token" && req.method === "GET") {
        if (!user.panelToken || !user.panelTokenExp || user.panelTokenExp < Date.now()) {
          return json(res, 200, { ok: false, error: "终端令牌未生成或已过期，请在导入终端开启导入器" });
        }
        return json(res, 200, { ok: true, token: user.panelToken, expiresAt: user.panelTokenExp, url: "/import?token=" + user.panelToken });
      }
      if (p === "/api/my/panel-token/refresh" && req.method === "POST") {
        const rec = instRecs[user.id];
        if (!rec || !ctrlGet(USER_CTRL_BASE + rec.index, "/ping")) {
          return json(res, 200, { ok: false, error: "请先在导入终端开启导入器，令牌会随开启自动生成" });
        }
        const t = ensurePanelToken(user, true);
        return json(res, 200, { ok: true, token: t.token, expiresAt: t.expiresAt, url: "/import?token=" + t.token });
      }
      if (p === "/api/my/panel-auth") {
        if (isPanelUnlocked(req, user)) {
          return json(res, 200, { ok: true, username: user.username, via: "password" });
        }
        const token = String(url.searchParams.get("token") || "");
        if (!token) return json(res, 401, { ok: false, error: "未授权面板：请输入账户密码" });
        if (token !== (user as any).panelToken) return json(res, 401, { ok: false, error: "未授权面板：令牌不匹配" });
        if (!(user as any).panelTokenExp || (user as any).panelTokenExp < Date.now()) {
          return json(res, 401, { ok: false, error: "未授权面板：令牌已过期，请在用户中心刷新令牌" });
        }
        return json(res, 200, { ok: true, username: user.username, via: "token" });
      }
      if (p === "/api/my/panel-unlock" && req.method === "POST") {
        const body = await readBody(req);
        const password = String(body.password || "");
        if (!password) return json(res, 400, { ok: false, error: "请输入账户密码" });
        if (!verifyPassword(user, password)) {
          log(`面板密码错误：${user.username}（${ip}）`);
          return json(res, 401, { ok: false, error: "密码错误" });
        }
        res.setHeader(
          "set-cookie",
          `cq_panel=${panelUnlockValue(user.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${PANEL_UNLOCK_HOURS * 3600}`
        );
        log(`面板密码验证通过：${user.username}（${ip}）`);
        return json(res, 200, { ok: true, username: user.username, expiresInHours: PANEL_UNLOCK_HOURS });
      }
      if (p === "/api/my/netease/start" && req.method === "POST") return json(res, 200, await neteaseStartFor(user));
      if (p === "/api/my/netease/stop" && req.method === "POST") return json(res, 200, neteaseStopFor(user));
      if (p === "/api/my/netease/status") {
        const rt = user.neteaseRuntime || {};
        let svc: any = null;
        if (rt.port && neteaseLive(rt.port)) svc = ctrlGet(rt.port, "/status");
        return json(res, 200, { ok: true, configured: !!user.netease, running: !!(rt.port && svc && svc.ok), port: rt.port || 0, botPid: rt.pid || 0, startedAt: rt.startedAt || 0, service: svc });
      }
      if (p === "/api/my/netease") {
        if (req.method === "GET") {
          return json(res, 200, { ok: true, netease: neteaseView(user) });
        }
        if (req.method === "DELETE") {
          delete (user as any).netease;
          writeJson(USERS_FILE, db);
          log(`用户 ${user.username} 删除了网易版账号信息`);
          return json(res, 200, { ok: true, netease: { configured: false } });
        }
        if (req.method === "POST") {
          const body = await readBody(req, 256 * 1024);
          const cookie = String(body.cookie || "").trim();
          const mode = String(body.mode || "server").trim();
          const roomId = String(body.id || "").trim();
          const password = String(body.password || "");
          if (cookie.length < 40) {
            return json(res, 400, { ok: false, error: "cookie/sauth 内容太短，请粘贴完整文本" });
          }
          if (!/^(server|lobby|domain|nethernet)$/.test(mode)) {
            return json(res, 400, { ok: false, error: "房间模式无效" });
          }
          const oldNe = (user as any).netease || {};
          if (!roomId && !oldNe.roomIdEnc) {
            return json(res, 400, { ok: false, error: "请填写房间号/短号" });
          }
          (user as any).netease = {
            cookieEnc: encryptSecret(cookie),
            mode,
            roomIdEnc: roomId ? encryptSecret(roomId) : oldNe.roomIdEnc,
            roomIdMasked: roomId
              ? roomId.length <= 4
                ? roomId
                : roomId.slice(0, 2) + "***" + roomId.slice(-2)
              : oldNe.roomIdMasked,
            passwordEnc: password ? encryptSecret(password) : oldNe.passwordEnc || "",
            updatedAt: Date.now(),
          };
          writeJson(USERS_FILE, db);
          log(`用户 ${user.username} 导入了网易版账号信息（mode=${mode}）`);
          return json(res, 200, { ok: true, netease: neteaseView(user) });
        }
      }
      if (p === "/api/my/panel-lock" && req.method === "POST") {
        res.setHeader("set-cookie", "cq_panel=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
        return json(res, 200, { ok: true });
      }
      const rec = instRecs[user.id];
      if (!rec) return json(res, 200, { ok: false, error: "导入器尚未启动，请先点「获取连接地址」" });
      const wsPort = USER_WS_BASE + rec.index;
      const ctrlPort = USER_CTRL_BASE + rec.index;
      if (p === "/api/my/status") {
        const st = ctrlGet(ctrlPort, "/status");
        return json(res, 200, {
          ok: !!st,
          running: !!st?.running,
          wsUrl: `ws://${host}:${wsPort}`,
          connectCommand: `/connect ws://${host}:${wsPort}`,
          sessionCount: st?.sessionCount ?? 0,
          authenticatedSessionCount: st?.authenticatedSessionCount ?? 0,
          stats: st?.stats ?? {},
          structure: st?.structure ?? null,
          panelToken: user.panelToken || null,
          panelTokenExp: user.panelTokenExp || null,
          netease: neteaseView(user),
          queue: {
            limit: IMPORT_LIMIT,
            active: IMPORT_ACTIVE.size,
            queued: IMPORT_QUEUE.length,
            position: IMPORT_QUEUE.findIndex((q) => q.uid === user.id) + 1,
            mine: IMPORT_ACTIVE.has(user.id),
          },
        });
      }
      if (p === "/api/my/structure/prepare" && req.method === "POST") {
        const body = await readBody(req, 96 * 1024 * 1024);
        const r = ctrlPost(ctrlPort, "/structure/prepare", { name: body.name, data: body.data }, 150000);
        return json(res, 200, r ?? { ok: false, error: "解析超时或实例无响应" });
      }
      if (p === "/api/my/structure/build" && req.method === "POST") {
        const billing = billingView(user);
        if (!billing.canImport) {
          return json(res, 200, {
            ok: false,
            error: "免费导入次数已用完（" + FREE_IMPORT_LIMIT + " 次），请充值额度或订阅个人版",
            needPay: true,
          });
        }
        const body = await readBody(req);
        const offsetY = Number(body.offsetY || 0);
        if (IMPORT_ACTIVE.has(user.id)) {
          return json(res, 200, { ok: false, error: "你已有导入任务进行中，等它结束再开新的" });
        }
        const priority = tierPriority(user);
        const maxQueued = IMPORT_QUEUE.length ? Math.max(...IMPORT_QUEUE.map((q) => q.priority)) : -1;
        const canStart = IMPORT_ACTIVE.size < IMPORT_LIMIT && (IMPORT_QUEUE.length === 0 || priority > maxQueued);
        if (!canStart) {
          if (!IMPORT_QUEUE.some((q) => q.uid === user.id)) {
            IMPORT_QUEUE.push({ uid: user.id, offsetY, priority, at: Date.now() });
          }
          IMPORT_QUEUE.sort((a, b) => b.priority - a.priority || a.at - b.at);
          const pos = IMPORT_QUEUE.findIndex((q) => q.uid === user.id) + 1;
          log(`用户 ${user.username} 进入导入队列（第 ${pos} 位，进行中 ${IMPORT_ACTIVE.size}/${IMPORT_LIMIT}）`);
          return json(res, 200, {
            ok: true,
            queued: true,
            position: pos,
            active: IMPORT_ACTIVE.size,
            limit: IMPORT_LIMIT,
            error: `当前有 ${IMPORT_ACTIVE.size} 人正在导入，你排在第 ${pos} 位` + (priority > 0 ? "（订阅用户可插队）" : ""),
          });
        }
        IMPORT_ACTIVE.set(user.id, { startedAt: Date.now() });
        const r = ctrlPost(ctrlPort, "/structure/build", { offsetY }, 30000);
        if (r && r.ok) {
          consumeQuota(user);
          log(`用户 ${user.username} 开始导入（剩余免费 ${billingView(user).freeLimit - billingView(user).freeUsed} / 额度 ${billingView(user).quota}）`);
        } else {
          IMPORT_ACTIVE.delete(user.id);
          dispatchImportQueue();
        }
        return json(res, 200, r ?? { ok: false, error: "启动失败" });
      }
      if (p === "/api/my/structure/cancel" && req.method === "POST") {
        IMPORT_ACTIVE.delete(user.id);
        IMPORT_QUEUE = IMPORT_QUEUE.filter((q) => q.uid !== user.id);
        const r = ctrlPost(ctrlPort, "/structure/cancel", {}, 15000);
        dispatchImportQueue();
        return json(res, 200, r ?? { ok: false, error: "取消失败" });
      }
      if (p === "/api/my/structure/clear" && req.method === "POST") {
        const r = ctrlPost(ctrlPort, "/structure/clear", {}, 15000);
        return json(res, 200, r ?? { ok: false, error: "清除失败" });
      }
      if (p === "/api/my/structure/verify" && req.method === "POST") {
        const body = await readBody(req);
        const r = ctrlPost(ctrlPort, "/structure/verify", { deep: !!body.deep }, 30000);
        return json(res, 200, r ?? { ok: false, error: "启动校验失败" });
      }
      if (p === "/api/my/logs") {
        const lines = Number(url.searchParams.get("lines") || 40);
        try {
          const f = path.join(DATA_DIR, "users", user.id, "logs", "ws.log");
          const all = fs.readFileSync(f, "utf8").trimEnd().split("\n");
          return json(res, 200, { ok: true, lines: all.slice(-lines) });
        } catch {
          return json(res, 200, { ok: true, lines: [] });
        }
      }
      return json(res, 404, { ok: false, error: "not found" });
    }

    // ---- 静态页 ----
    let filePath: string;
    if (p === "/" || p === "") filePath = path.join(SITE_DIR, "index.html");
    else if (p === "/login") filePath = path.join(SITE_DIR, "login.html");
    else if (p === "/register") filePath = path.join(SITE_DIR, "register.html");
    else if (p === "/user") filePath = path.join(SITE_DIR, "user.html");
    else if (p === "/import") filePath = path.join(SITE_DIR, "import.html");
    else if (p === "/legal" || p === "/legal/terms") filePath = path.join(SITE_DIR, "legal-terms.html");
    else if (p === "/legal/privacy") filePath = path.join(SITE_DIR, "legal-privacy.html");
    else if (p === "/guide/netease") filePath = path.join(SITE_DIR, "guide-netease.html");
    else if (p === "/guide/proxypin") filePath = path.join(SITE_DIR, "guide-proxypin.html");
    else if (p === "/market") filePath = path.join(SITE_DIR, "market.html");
    else if (p === "/market-admin") filePath = path.join(SITE_DIR, "market-admin.html");
    else if (p === "/abadmin") filePath = path.join(SITE_DIR, "abadmin.html");
    else if (p === "/guide/lua") filePath = path.join(SITE_DIR, "guide-lua.html");
    else if (p === "/pay") filePath = path.join(SITE_DIR, "pay.html");
    else filePath = path.join(SITE_DIR, path.normalize(p).replace(/^([/\\])+/, ""));

    if (!filePath.startsWith(SITE_DIR)) return json(res, 404, { ok: false, error: "not found" });
    const data = readFileSafe(filePath);
    if (!data) return json(res, 404, { ok: false, error: "页面不存在" });
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(data);
  } catch (e: any) {
    log(`请求异常：${e?.message ?? e}`);
    json(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

server.listen(PORT, HOST, () => {
  log(`${APP_NAME} 官网/用户中心已启动：http://${HOST}:${PORT}（WS ${WS_PORT}，控制接口 ${CONTROL_PORT}）`);
});
