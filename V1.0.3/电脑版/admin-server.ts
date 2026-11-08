/**
 * CyanQiuper 网页管理端
 * - 启动/停止/重启 WS 服务（子进程）
 * - 直接读取 logs/*.log 日志文件并实时推送到网页（SSE tail -f），不需要手动写日志
 * - 通过本机控制接口执行沙箱代码 / 发送原生命令
 * - 全黑白配色界面（admin/index.html）
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn, spawnSync, ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import * as readline from "node:readline";

const APP_NAME = "CyanQiuper";
const IS_WIN = process.platform === "win32";

/** 网易版（机器人事件桥）服务端口（仅本机） */
const NETEASE_PORT = Number(process.env.FB_NETEASE_PORT || 11454);

/** ===== 本机/网络信息（供后台展示） ===== */
const SYS = {
  hostname: os.hostname(),
  platform: `${os.platform()} ${os.release()} ${os.arch()}`,
  nodeVersion: process.version,
  cpus: os.cpus().length,
  memTotal: os.totalmem(),
  localIps: (() => {
    const out: string[] = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === "IPv4" && !ni.internal) out.push(ni.address);
      }
    }
    return out;
  })(),
  publicIp: "",
  publicIpAt: 0,
};

/** ===== 路径与端口 ===== */
const ROOT = (() => {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "main.ts"))) return cwd;
  return path.dirname(path.resolve(process.argv[1] ?? "."));
})();
const ADMIN_DIR = path.join(ROOT, "admin");
const LOG_DIR = path.join(ROOT, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const ADMIN_LOG = path.join(LOG_DIR, "admin.log");

const ADMIN_PORT = Number(process.env.FB_ADMIN_PORT ?? 11452);
const ADMIN_HOST = process.env.FB_ADMIN_HOST || "127.0.0.1";
const WS_PORT = Number(process.env.FB_WS_PORT ?? 11451);
const CONTROL_PORT = Number(process.env.FB_CONTROL_PORT ?? 11453);
const WS_VERSION = Number(process.env.FB_WS_VERSION ?? 17104896);
// 对外公布给游戏用的 WS 地址（留空则按页面访问的域名自动生成）
const PUBLIC_WS_URL = (process.env.FB_PUBLIC_WS_URL || "").trim().replace(/\/$/, "");
const WEB_STARTED_AT = Date.now();

/** ===== 登录口令（只保存哈希，不保存明文） =====
 *  admin/auth.json 存在则启用密码登录；不存在则无需登录（本机开发模式）
 *  格式：{ "passwordHash": "scrypt$N$r$p$saltB64$keyB64", "secret": "...", "sessionHours": 12 }
 */
const AUTH_FILE = path.join(ADMIN_DIR, "auth.json");
type AuthConfig = { passwordHash: string; secret: string; sessionHours?: number };
let auth: AuthConfig | null = null;
try {
  auth = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  if (!auth?.passwordHash || !auth?.secret) auth = null;
} catch {
  auth = null;
}

/** 本地版强制免登录：FB_ADMIN_NO_AUTH=1（即使存在 auth.json 也跳过登录，仅建议本机使用） */
const AUTH_DISABLED = ["1", "true", "yes", "on"].includes(String(process.env.FB_ADMIN_NO_AUTH || "").toLowerCase());
if (AUTH_DISABLED && auth) {
  auth = null;
  console.log("[管理端] 已通过 FB_ADMIN_NO_AUTH 关闭登录（本机模式）");
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 64);
  return `scrypt$16384$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, N, r, p, saltB64, keyB64] = parts;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(keyB64, "base64");
    const key = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
    });
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

const SESSION_SECONDS = () => Math.max(1, Number(auth?.sessionHours ?? 12)) * 3600;

function signSession(exp: number): string {
  const mac = crypto.createHmac("sha256", auth!.secret).update(String(exp)).digest("base64url");
  return `${exp}.${mac}`;
}

function isValidSession(raw: string | undefined): boolean {
  if (!auth || !raw) return false;
  const [expStr, mac] = raw.split(".");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now() || !mac) return false;
  const expected = crypto.createHmac("sha256", auth.secret).update(String(exp)).digest("base64url");
  try {
    return mac.length === expected.length && crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return false;
  }
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** 暴力破解防护：同一 IP 5 分钟内失败 8 次锁定 5 分钟 */
const loginFails = new Map<string, { count: number; firstAt: number; until: number }>();

function loginLockLeft(ip: string): number {
  const f = loginFails.get(ip);
  if (!f) return 0;
  if (f.until && Date.now() < f.until) return f.until - Date.now();
  if (Date.now() - f.firstAt > 5 * 60 * 1000) loginFails.delete(ip);
  return 0;
}

function recordLoginFail(ip: string) {
  const now = Date.now();
  const f = loginFails.get(ip) ?? { count: 0, firstAt: now, until: 0 };
  f.count += 1;
  if (f.count >= 8) {
    f.until = now + 5 * 60 * 1000;
    f.count = 0;
    f.firstAt = now;
  }
  loginFails.set(ip, f);
}

function clientIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}

/** ===== 时间：统一按 UTC+8 输出 ===== */
const TZ_OFFSET_MS = 8 * 3600 * 1000;
function isoUtc8(ms = Date.now()): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().replace("Z", "+08:00");
}
function clockUtc8(ms = Date.now()): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(11, 19);
}

/** ===== 管理端自身日志（直接写 logs/admin.log） ===== */
function log(text: string) {
  try {
    fs.appendFileSync(ADMIN_LOG, `[${isoUtc8()}] [admin] ${text}\n`);
  } catch {}
  console.log(`[${clockUtc8()}] ${text}`);
}

/** ===== 日志文件工具 ===== */
function listLogFiles(): { name: string; size: number; mtime: number }[] {
  try {
    return fs
      .readdirSync(LOG_DIR)
      .filter((f) => f.endsWith(".log"))
      .sort()
      .map((f) => {
        const st = fs.statSync(path.join(LOG_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      });
  } catch {
    return [];
  }
}

/** 读取文件末尾若干行（最多读 512KB） */
function readTailLines(file: string, maxLines: number): string[] {
  const full = path.join(LOG_DIR, file);
  let fd: number;
  try {
    const st = fs.statSync(full);
    fd = fs.openSync(full, "r");
    const maxBytes = 512 * 1024;
    const len = Math.min(st.size, maxBytes);
    if (len === 0) {
      fs.closeSync(fd);
      return [];
    }
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (len < st.size) lines.shift(); // 首行可能是半行
    return lines.filter((l) => l.trim().length > 0).slice(-maxLines);
  } catch {
    return [];
  }
}

type FileOffset = { size: number; partial: string };
type SseClient = { res: ServerResponse; source: string; offsets: Map<string, FileOffset> };

const sseClients = new Set<SseClient>();

/** 从上次偏移量继续读取新增内容，按行返回 */
function tailNew(file: string, offsets: Map<string, FileOffset>): string[] {
  const full = path.join(LOG_DIR, file);
  let st: fs.Stats;
  try {
    st = fs.statSync(full);
  } catch {
    return [];
  }
  let cur = offsets.get(file);
  if (!cur) {
    cur = { size: st.size, partial: "" };
    offsets.set(file, cur);
    return [];
  }
  if (st.size < cur.size) {
    // 文件被清空/轮转，从头再来
    cur.size = 0;
    cur.partial = "";
  }
  if (st.size === cur.size) return [];
  const len = st.size - cur.size;
  const buf = Buffer.alloc(len);
  let fd: number;
  try {
    fd = fs.openSync(full, "r");
    fs.readSync(fd, buf, 0, len, cur.size);
    fs.closeSync(fd);
  } catch {
    return [];
  }
  cur.size = st.size;
  const parts = (cur.partial + buf.toString("utf8")).split(/\r?\n/);
  cur.partial = parts.pop() ?? "";
  return parts.filter((l) => l.trim().length > 0);
}

/** 每 300ms 把日志文件的新增行推给所有 SSE 客户端 */
setInterval(() => {
  if (!sseClients.size) return;
  const files = listLogFiles().map((f) => f.name);
  for (const client of [...sseClients]) {
    const targets = client.source === "all" ? files : files.filter((f) => f === client.source);
    for (const file of targets) {
      for (const text of tailNew(file, client.offsets)) {
        try {
          client.res.write(`data: ${JSON.stringify({ file, text })}\n\n`);
        } catch {
          sseClients.delete(client);
          break;
        }
      }
    }
  }
}, 300);

/** ===== WS 子进程管理 ===== */
let wsChild: ChildProcess | null = null;
let wsStartedAt = 0;
let lastWsExit: { code: number | null; at: number } | null = null;

function pipeChild(d: Buffer, isErr: boolean) {
  // WS 服务自己会写 logs/ws.log，这里只负责把输出同步显示到控制台窗口
  const text = d.toString("utf8");
  process.stdout.write(isErr ? text : text);
}

function spawnWs(): boolean {
  if (wsChild) return false;
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsxCli)) {
    log(`[ERROR] 找不到 tsx：${tsxCli}，请先运行 npm install`);
    return false;
  }
  const child = spawn(process.execPath, [tsxCli, "main.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      FB_WS_PORT: String(WS_PORT),
      FB_CONTROL_PORT: String(CONTROL_PORT),
      FB_WS_VERSION: String(WS_VERSION),
    },
    windowsHide: true,
    detached: !IS_WIN, // Linux 下单独进程组，便于整组结束
    stdio: ["ignore", "pipe", "pipe"],
  });
  wsChild = child;
  wsStartedAt = Date.now();
  log(`启动 WS 服务（PID ${child.pid}）`);
  child.stdout?.on("data", (d: Buffer) => pipeChild(d, false));
  child.stderr?.on("data", (d: Buffer) => pipeChild(d, true));
  child.on("exit", (code) => {
    lastWsExit = { code, at: Date.now() };
    log(`WS 服务已退出（code=${code}）`);
    wsChild = null;
  });
  return true;
}

/** 结束进程（Windows 用 taskkill /T；Linux 用进程组） */
function killTree(pid: number) {
  if (IS_WIN) {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function stopWs(): boolean {
  if (!wsChild?.pid) return false;
  const pid = wsChild.pid;
  log(`停止 WS 服务（PID ${pid}）`);
  killTree(pid);
  wsChild = null;
  return true;
}

function killWsOnExit() {
  if (wsChild?.pid) {
    try {
      killTree(wsChild.pid);
    } catch {}
  }
}
process.on("exit", killWsOnExit);
process.on("SIGINT", () => {
  log("收到退出信号，正在关闭");
  killWsOnExit();
  process.exit(0);
});
process.on("SIGTERM", () => {
  killWsOnExit();
  process.exit(0);
});

/** ===== 与控制接口通信 ===== */
async function refreshPublicIp() {
  try {
    const res = await fetch("https://api.ipify.org", { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const ip = (await res.text()).trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        SYS.publicIp = ip;
        SYS.publicIpAt = Date.now();
      }
    }
  } catch {}
}

async function controlFetch(pathname: string, init?: RequestInit, timeout = 2500): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${CONTROL_PORT}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 反代到网易版服务（未启动时返回 null） */
async function neteaseFetch(pathname: string, init?: RequestInit, timeout = 60000): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${NETEASE_PORT}${pathname}`, {
      ...init,
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function wsStatus(): Promise<any | null> {
  const first = await controlFetch("/status", { method: "GET" }, 1500);
  if (first) return first;
  await new Promise((r) => setTimeout(r, 250));
  return controlFetch("/status", { method: "GET" }, 1500);
}

async function waitForWs(timeoutMs = 8000): Promise<any | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await wsStatus();
    if (s) return s;
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

/** ===== HTTP 工具 ===== */
function sendJson(res: ServerResponse, code: number, data: unknown) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  res.end(body);
}

function readJson(req: IncomingMessage, limit = 1 << 20): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("上传内容过大"));
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
      } catch (e) {
        reject(new Error(`JSON 解析失败: ${e}`));
      }
    });
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/** ===== 路由 ===== */
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const p = url.pathname;

  try {
    // ---- 登录校验（admin/auth.json 存在时启用；口令只存 scrypt 哈希） ----
    if (auth) {
      const authed = isValidSession(readCookie(req, "cq_session"));
      // 静态资源（logo / 图标）与登录页本身无需登录，否则登录页也加载不出图标
      const isPublic = p.startsWith("/assets/") || p === "/polish.css" || p === "/snowluma.css" || p === "/snowluma.js" || p === "/pixelart.js" || p === "/astrbot.css" || p === "/pixeltext.js" || p === "/midiplayer.js" || p === "/mp3tomidi.js" || p === "/favicon.ico";
      if (isPublic) {
        // 落到后面的静态资源处理
      } else if (req.method === "POST" && p === "/api/login") {
        const ip = clientIp(req);
        const left = loginLockLeft(ip);
        if (left > 0) {
          return sendJson(res, 429, {
            ok: false,
            error: `尝试次数过多，请 ${Math.ceil(left / 60000)} 分钟后再试`,
          });
        }
        const body = await readJson(req);
        const password = String(body.password ?? "");
        if (!verifyPassword(password, auth.passwordHash)) {
          recordLoginFail(ip);
          log(`[WARN] 管理页登录失败：${ip}`);
          return sendJson(res, 401, { ok: false, error: "密码错误" });
        }
        loginFails.delete(ip);
        const exp = Math.floor(Date.now() / 1000) + SESSION_SECONDS();
        res.setHeader(
          "set-cookie",
          `cq_session=${signSession(exp)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS()}`
        );
        log(`管理页登录成功：${ip}`);
        return sendJson(res, 200, { ok: true });
      }

      if (!isPublic) {
        if (req.method === "POST" && p === "/api/logout") {
          res.setHeader("set-cookie", "cq_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
          log(`管理页退出登录：${clientIp(req)}`);
          return sendJson(res, 200, { ok: true });
        }

        if (!authed) {
          if (p.startsWith("/api/")) return sendJson(res, 401, { ok: false, error: "未登录" });
          if (req.method === "GET" && (p === "/" || p === "/index.html" || p === "/login")) {
            try {
              const page = await fs.promises.readFile(path.join(ADMIN_DIR, "login.html"));
              res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
              return res.end(page);
            } catch {
              res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
              return res.end("缺少 admin/login.html");
            }
          }
          res.writeHead(302, { location: "/" });
          return res.end();
        }
      }
    }

    // ---- 静态页面 ----
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      const html = await fs.promises.readFile(path.join(ADMIN_DIR, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      return res.end(html);
    }
    if (req.method === "GET" && p === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET" && p === "/polish.css") {
      try {
        const css = await fs.promises.readFile(path.join(ADMIN_DIR, "polish.css"));
        res.writeHead(200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-store" });
        return res.end(css);
      } catch {
        res.writeHead(404);
        return res.end("missing admin/polish.css");
      }
    }
    if (req.method === "GET" && (p === "/snowluma.css" || p === "/snowluma.js" || p === "/pixelart.js" || p === "/astrbot.css" || p === "/pixeltext.js" || p === "/midiplayer.js" || p === "/mp3tomidi.js")) {
      try {
        const name = p.slice(1);
        const buf = await fs.promises.readFile(path.join(ADMIN_DIR, name));
        res.writeHead(200, {
          "content-type": name.endsWith(".css") ? "text/css; charset=utf-8" : "application/javascript; charset=utf-8",
          "cache-control": "no-store",
        });
        return res.end(buf);
      } catch {
        res.writeHead(404);
        return res.end("missing " + p);
      }
    }
    if (req.method === "GET" && p.startsWith("/assets/")) {
      const rel = path.normalize(p.replace(/^\/+/, "")).replace(/^([.][.][\\/])+/, "");
      const file = path.join(ADMIN_DIR, rel);
      if (!file.startsWith(ADMIN_DIR)) {
        res.writeHead(403);
        return res.end();
      }
      try {
        const data = await fs.promises.readFile(file);
        res.writeHead(200, {
          "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        return res.end(data);
      } catch {
        res.writeHead(404);
        return res.end();
      }
    }

    // ---- 状态 ----
    if (req.method === "GET" && p === "/api/status") {
      const ws = await wsStatus();
      return sendJson(res, 200, {
        app: APP_NAME,
        auth: !!auth,
        serverNow: Date.now(),
        web: {
          port: ADMIN_PORT,
          pid: process.pid,
          startedAt: WEB_STARTED_AT,
          uptime: Date.now() - WEB_STARTED_AT,
          ownsWs: !!wsChild,
          hostname: SYS.hostname,
          platform: SYS.platform,
          nodeVersion: SYS.nodeVersion,
          localIps: SYS.localIps,
          publicIp: SYS.publicIp,
          cpus: SYS.cpus,
          memTotal: SYS.memTotal,
        },
        ws: ws
          ? { ...ws, owned: !!wsChild, startedAt: wsStartedAt || ws.startedAt }
          : {
              running: false,
              port: WS_PORT,
              error: lastWsExit ? `WS 服务已退出（code=${lastWsExit.code}）` : "WS 服务未运行",
              owned: !!wsChild,
            },
        config: {
          wsPort: WS_PORT,
          controlPort: CONTROL_PORT,
          adminPort: ADMIN_PORT,
          wsVersion: WS_VERSION,
          publicWsUrl: PUBLIC_WS_URL,
        },
      });
    }

    // ---- 执行代码 ----
    if (req.method === "POST" && p === "/api/command") {
      const body = await readJson(req);
      const code = String(body.code ?? "").trim();
      if (!code) return sendJson(res, 400, { ok: false, error: "code 不能为空" });
      const r = await controlFetch("/eval", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行，无法执行" });
      return sendJson(res, 200, r);
    }

    // ---- 像素画：像素矩阵 → 结构 ----
    if (req.method === "POST" && p === "/api/pixelart/prepare") {
      const body = await readJson(req, 64 << 20);
      const r = await controlFetch("/pixelart/prepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行，无法生成像素画" });
      return sendJson(res, 200, r);
    }

    // ---- 结构导入（.mcstructure）----
    if (req.method === "POST" && p === "/api/structure/prepare") {
      const body = await readJson(req, 96 << 20);
      const name = String(body.name ?? "structure");
      const data = String(body.data ?? "");
      if (!data) return sendJson(res, 400, { ok: false, error: "缺少文件数据" });
      const r = await controlFetch(
        "/structure/prepare",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, data }) },
        60000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) log(`结构已解析：${r.structure?.name}（${r.structure?.total} 方块）`);
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && p === "/api/structure/build") {
      const body = await readJson(req);
      const offsetY = Number(body.offsetY ?? 0) || 0;
      const r = await controlFetch(
        "/structure/build",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ offsetY }) },
        15000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) log(`开始导入结构：${r.name}（${r.total} 方块 / ${r.commands} 条命令）`);
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && p === "/api/structure/verify") {
      const body = await readJson(req);
      const deep = !!body.deep;
      const r = await controlFetch(
        "/structure/verify",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deep }) },
        8000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) log(`开始完整性检查（${deep ? "深度" : "快速"}）`);
      return sendJson(res, 200, r);
    }
    if (req.method === "POST" && p === "/api/structure/rebuild") {
      const r = await controlFetch(
        "/structure/rebuild",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        15000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) log(`开始补建未完成方块：${r.commands} 条命令 / ${r.blocks} 方块`);
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && p === "/api/structure/cancel") {
      const r = await controlFetch(
        "/structure/cancel",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        8000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) log("已取消结构导入");
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && p === "/api/structure/repair") {
      const body = await readJson(req, 96 << 20);
      const name = String(body.name ?? "structure");
      const data = String(body.data ?? "");
      if (!data) return sendJson(res, 400, { ok: false, error: "缺少文件数据" });
      const r = await controlFetch(
        "/structure/repair",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, data }) },
        60000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.ok) {
        log(`结构修补完成：${r.structure?.name}（${r.fixed ? r.issues.length + " 处修复" : "无需修复"}）`);
      }
      return sendJson(res, 200, r);
    }

    if (req.method === "POST" && p === "/api/structure/clear") {
      const r = await controlFetch(
        "/structure/clear",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        8000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      if (r.removed) log(`已移除待生成的结构：${r.removed}`);
      return sendJson(res, 200, r);
    }

    // ---- 玩家信息（向游戏查询） ----
    if (req.method === "POST" && p === "/api/player") {
      const r = await controlFetch(
        "/player",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
        6000
      );
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      return sendJson(res, 200, r);
    }

    // ---- 发送原生命令 ----
    if (req.method === "POST" && p === "/api/send") {      const body = await readJson(req);
      const command = String(body.command ?? "").trim();
      if (!command) return sendJson(res, 400, { ok: false, error: "command 不能为空" });
      const r = await controlFetch("/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command }),
      });
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行，无法发送" });
      return sendJson(res, 200, r);
    }

    // ---- 设置默认方块 ----
    if (req.method === "POST" && p === "/api/setting") {
      const body = await readJson(req);
      const block = String(body.block ?? "").trim();
      if (!block) return sendJson(res, 400, { ok: false, error: "block 不能为空" });
      const r = await controlFetch("/block", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ block }),
      });
      if (!r) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
      return sendJson(res, 200, r);
    }

    // ---- WS 服务启停 ----
    if (req.method === "POST" && p === "/api/ws/action") {
      const body = await readJson(req);
      const action = String(body.action ?? "");
      const running = !!(await wsStatus());

      if (action === "start") {
        if (running) return sendJson(res, 200, { ok: false, error: "WS 服务已在运行" });
        spawnWs();
        const up = await waitForWs();
        return sendJson(res, 200, up ? { ok: true, running: true } : { ok: false, error: "WS 服务启动超时，请看日志" });
      }
      if (action === "stop") {
        if (!running && !wsChild) return sendJson(res, 200, { ok: false, error: "WS 服务未运行" });
        if (!stopWs()) {
          return sendJson(res, 200, {
            ok: false,
            error: "这个 WS 服务不是网页管理端启动的，请用 stop.bat 或关闭它的窗口",
          });
        }
        await new Promise((r) => setTimeout(r, 500));
        return sendJson(res, 200, { ok: true, running: !!(await wsStatus()) });
      }
      if (action === "restart") {
        const stopped = stopWs();
        if (!stopped && running) {
          return sendJson(res, 200, {
            ok: false,
            error: "这个 WS 服务不是网页管理端启动的，无法重启（请用 stop.bat 后重新启动）",
          });
        }
        await new Promise((r) => setTimeout(r, 700));
        spawnWs();
        const up = await waitForWs();
        return sendJson(res, 200, up ? { ok: true, running: true } : { ok: false, error: "WS 服务重启超时，请看日志" });
      }
      return sendJson(res, 400, { ok: false, error: `未知 action: ${action}` });
    }

    // ---- 日志文件列表 ----
    // ---- 网易版（机器人事件桥）反代 ----
    if (p.startsWith("/api/netease/")) {
      const sub = p.slice("/api/netease".length);
      if (req.method === "POST") {
        const body = await readJson(req, 96 << 20);
        const r = await neteaseFetch(sub, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r) return sendJson(res, 200, { ok: false, error: "网易版服务未启动（netease-service）" });
        return sendJson(res, 200, r);
      }
      const r = await neteaseFetch(sub, { method: "GET" }, 15000);
      if (!r) return sendJson(res, 200, { ok: false, error: "网易版服务未启动（netease-service）" });
      return sendJson(res, 200, r);
    }

    if (req.method === "GET" && p === "/api/logs/files") {
      return sendJson(res, 200, { ok: true, dir: LOG_DIR, files: listLogFiles() });
    }

    // ---- 日志文件内容（末尾 N 行） ----
    if (req.method === "GET" && p === "/api/logs/view") {
      const file = url.searchParams.get("file") ?? "ws.log";
      const lines = Math.min(Math.max(Number(url.searchParams.get("lines") ?? 400), 1), 3000);
      if (file === "all" || !listLogFiles().some((f) => f.name === file)) {
        return sendJson(res, 200, { ok: true, file: "all", lines: listLogFiles().flatMap((f) => readTailLines(f.name, lines)) });
      }
      return sendJson(res, 200, { ok: true, file, lines: readTailLines(file, lines) });
    }

    // ---- 实时日志（直接跟随日志文件） ----
    if (req.method === "GET" && p === "/api/logs/stream") {
      const source = url.searchParams.get("file") ?? "all";
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": connected\n\n");

      // 先补发最近的内容，再从文件末尾继续跟随
      const files = listLogFiles().map((f) => f.name).filter((f) => source === "all" || f === source);
      for (const file of files) {
        for (const text of readTailLines(file, 200)) {
          res.write(`data: ${JSON.stringify({ file, text })}\n\n`);
        }
      }
      const client: SseClient = { res, source, offsets: new Map() };
      for (const file of files) {
        try {
          const st = fs.statSync(path.join(LOG_DIR, file));
          client.offsets.set(file, { size: st.size, partial: "" });
        } catch {}
      }
      sseClients.add(client);

      const keepAlive = setInterval(() => {
        try {
          res.write(": ping\n\n");
        } catch {}
      }, 15000);
      req.on("close", () => {
        clearInterval(keepAlive);
        sseClients.delete(client);
      });
      return;
    }

    // ---- 下载日志文件 ----
    if (req.method === "GET" && p === "/api/logs/download") {
      const file = url.searchParams.get("file") ?? "all";
      if (file === "all") {
        const lines = listLogFiles().flatMap((f) => readTailLines(f.name, 100000));
        res.writeHead(200, {
          "content-type": "text/plain; charset=utf-8",
          "content-disposition": `attachment; filename="${APP_NAME}-all-${Date.now()}.log"`,
        });
        return res.end(lines.join("\n"));
      }
      if (!listLogFiles().some((f) => f.name === file)) {
        return sendJson(res, 404, { ok: false, error: "日志文件不存在" });
      }
      const full = path.join(LOG_DIR, file);
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${file}"`,
      });
      return fs.createReadStream(full).pipe(res);
    }

    // ---- 清空日志 ----
    if (req.method === "POST" && p === "/api/logs/clear") {
      const body = await readJson(req);
      const file = String(body.file ?? "all");
      const targets = file === "all" ? listLogFiles().map((f) => f.name) : [file];
      for (const name of targets) {
        if (!listLogFiles().some((f) => f.name === name)) continue;
        try {
          await fs.promises.writeFile(path.join(LOG_DIR, name), "");
        } catch {}
      }
      log(`日志已清空：${targets.join(", ")}`);
      return sendJson(res, 200, { ok: true, cleared: targets });
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e: any) {
    log(`[ERROR] 请求处理失败：${e?.message ?? e}`);
    try {
      sendJson(res, 500, { ok: false, error: String(e?.message ?? e) });
    } catch {}
  }
});


/** ===== 终端 REPL（MCSManager 终端 / 直接运行时可用） ===== */
async function controlPost(pathname: string, body: any): Promise<any> {
  return controlFetch(
    pathname,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    8000
  );
}

function tailLines(file: string, count: number): string[] {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-count);
  } catch {
    return [];
  }
}

const REPL_HELP = [
  "  CyanQiuper 终端命令：",
  "    help                 显示帮助",
  "    status               查看 WS 服务/游戏连接状态",
  "    player               读取游戏内玩家坐标与信息",
  "    say <文本>           以玩家身份在游戏里喊话",
  "    cmd <原版命令>       执行原版命令（可省略 /），如 cmd tp @s ~ ~10 ~",
  "    eval <JS 代码>       沙盒执行 JavaScript，如 eval 1+1、eval -pos()",
  "    start / stop / restart  启动 / 停止 / 重启 WS 服务",
  "    logs                 显示 WS 日志最后 20 行",
  "    exit                 退出并停止服务",
].join("\n");

function setupRepl() {
  // MCSManager 等网关以管道方式提供 stdin，这里不限制 isTTY；读不到 stdin 时静默跳过
  let rl: readline.Interface;
  try {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "cq> " });
  } catch {
    return;
  }
  rl.on("close", () => {});
  const print = (text: string) => process.stdout.write(text + "\n");
  print("");
  print("  ===== CyanQiuper 终端 =====（输入 help 查看命令）");
  try { rl.prompt(); } catch {}
  rl.on("line", async (line: string) => {
    const raw = line.trim();
    if (!raw) {
      try { rl.prompt(); } catch {}
      return;
    }
    const parts = raw.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = raw.slice(parts[0].length).trim();
    try {
      if (cmd === "help" || cmd === "?") {
        print(REPL_HELP);
      } else if (cmd === "status") {
        const s = await wsStatus();
        if (!s) {
          print("WS 服务未运行");
        } else {
          print(`WS 服务：${s.running ? "运行中" : "已停止"} · 端口 ${s.port} · 会话 ${s.sessionCount ?? 0} 个`);
          if (s.active) print(`当前游戏：${s.active.address ?? "—"} · 加密 ${s.active.encrypted ? "是" : "否"}`);
          const st = s.stats || {};
          print(`统计：命令 ${st.commands ?? 0} · 方块 ${st.setblocks ?? 0} · 聊天 ${st.messages ?? 0} · 错误 ${st.errors ?? 0}`);
        }
      } else if (cmd === "player" || cmd === "pos") {
        const r = await controlPost("/player", {});
        if (r && r.ok && r.players && r.players.length) {
          const p = r.players[0];
          print(`玩家：${p.name ?? "—"} @ ${p.x ?? "?"}, ${p.y ?? "?"}, ${p.z ?? "?"}（维度 ${p.dimension ?? "?"}，朝向 ${p.yRot ?? "?"}）`);
        } else {
          print("读取失败：" + ((r && r.error) || "没有已连接的游戏"));
        }
      } else if (cmd === "say") {
        if (!arg) print("用法：say <文本>");
        else {
          const r = await controlPost("/send", { command: `say ${arg}` });
          print(r && r.ok ? "已发送" : "发送失败：" + ((r && r.error) || "未知错误"));
        }
      } else if (cmd === "cmd") {
        if (!arg) print("用法：cmd <原版命令>");
        else {
          const command = arg.startsWith("/") ? arg.slice(1) : arg;
          const r = await controlPost("/send", { command });
          print(r && r.ok ? `已发送：${command}` : "发送失败：" + ((r && r.error) || "没有已连接的游戏"));
        }
      } else if (cmd === "eval") {
        if (!arg) print("用法：eval <JS 代码>");
        else {
          const r = await controlPost("/eval", { code: arg });
          print(r && r.ok ? `结果：${r.result === undefined ? "Success" : r.result}` : "执行失败：" + ((r && r.error) || "未知错误"));
        }
      } else if (cmd === "start") {
        print(spawnWs() ? "已启动 WS 服务" : "WS 服务已在运行或启动失败");
      } else if (cmd === "stop") {
        print(stopWs() ? "已停止 WS 服务" : "WS 服务未运行");
      } else if (cmd === "restart") {
        stopWs();
        await new Promise((r) => setTimeout(r, 800));
        print(spawnWs() ? "已重启 WS 服务" : "重启失败");
      } else if (cmd === "logs") {
        const lines = tailLines(path.join(ROOT, "logs", "ws.log"), 20);
        print(lines.length ? lines.join("\n") : "（暂无日志）");
      } else if (cmd === "exit") {
        print("正在停止服务…");
        stopWs();
        setTimeout(() => process.exit(0), 600);
        return;
      } else if (raw.startsWith("/")) {
        const r = await controlPost("/send", { command: raw.slice(1) });
        print(r && r.ok ? "已发送" : "发送失败：" + ((r && r.error) || "没有已连接的游戏"));
      } else {
        print(`未知命令：${cmd}（输入 help 查看命令）`);
      }
    } catch (e: any) {
      print("错误：" + (e?.message ?? e));
    }
    try { rl.prompt(); } catch {}
  });
}

server.listen(ADMIN_PORT, ADMIN_HOST, async () => {
  log(`===== ${APP_NAME} 管理端启动 =====`);
  log(`网页管理页：http://${ADMIN_HOST === "0.0.0.0" ? "0.0.0.0" : ADMIN_HOST}:${ADMIN_PORT}` +
    (auth ? "（已启用密码登录）" : "（未设置密码，本机开发模式）"));
  refreshPublicIp().then(() => {
    if (SYS.publicIp) log(`公网 IP：${SYS.publicIp}（本机地址：${SYS.localIps.join("，") || "—"}）`);
  });
  setInterval(refreshPublicIp, 10 * 60 * 1000);
  log(`WS 服务端口 ${WS_PORT}｜控制接口 ${CONTROL_PORT}｜协议版本 ${WS_VERSION}`);
  log(`日志目录：${LOG_DIR}`);
  const existing = await wsStatus();
  if (existing) {
    log("检测到已有 WS 服务在运行（外部启动），管理端仅做监控");
  } else {
    spawnWs();
  }
  log("游戏内输入：" + (PUBLIC_WS_URL ? `/connect ${PUBLIC_WS_URL}` : `/connect ws://127.0.0.1:${WS_PORT}`));
  if (process.env.FB_NO_OPEN !== "1") {
    setTimeout(() => {
      try {
        spawn("cmd", ["/c", "start", "", `http://127.0.0.1:${ADMIN_PORT}`], {
          windowsHide: true,
          detached: true,
          stdio: "ignore",
        }).unref();
      } catch {}
    }, 800);
  }
});

process.on("uncaughtException", (e) => {
  log(`[ERROR] 未捕获异常：${e?.message ?? e}`);
});

setupRepl();
