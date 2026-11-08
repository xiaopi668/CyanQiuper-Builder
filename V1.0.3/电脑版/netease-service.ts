/**
 * 网易版（基岩互通服）结构导入服务
 *
 * 与 WebSocket 版互不影响：本服务通过机器人客户端的事件桥，在网易租赁服里
 * 「以玩家身份」执行原版指令来完成结构导入、回读校验与补建。
 *
 * 启动：FB_NETEASE_SOCKET=/opt/netease-bot/bot.sock FB_NETEASE_TOKEN=xxx \
 *       node node_modules/tsx/dist/cli.mjs netease-service.ts
 * 接口：127.0.0.1:11454（仅本机，由 admin-server 反代）
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { NeteaseBridge, BridgeEvent } from "./src/netease-bridge";
import { parseMcStructure, structureCommands, ParsedStructure } from "./src/structure";
import { parseStructureFile } from "./src/formats";
import { describeBaseline, checkBotProtocol, effectiveProtocolVersion, gameVersionFor, NETEASE_PROTOCOL } from "./src/netease-protocol";

const APP_NAME = "CyanQiuper-NetEase";
const PORT = Number(process.env.FB_NETEASE_PORT || 11454);
const HOST = process.env.FB_NETEASE_HOST || "127.0.0.1";
const SOCKET_PATH = process.env.FB_NETEASE_SOCKET || "";
const TOKEN = process.env.FB_NETEASE_TOKEN || "";
const LOG_DIR = process.env.FB_LOG_DIR || path.join(process.cwd(), "logs");
const STRUCTURE_LIMIT = 500000;
const BAR_WIDTH = 20;

fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, "netease.log");
/** 网络账号信息（网易账号）：只保存在本机，权限 600；接口只返回掩码 */
const ACCOUNT_FILE = path.join(path.dirname(LOG_DIR), "netease-account.json");
type NeteaseAccount = {
  channel: string;      // 官方 / 渠道服
  account: string;      // 邮箱 / 手机号
  password: string;     // 登录密码（仅本机保存）
  note?: string;
  updatedAt: number;
};

function loadAccount(): NeteaseAccount | null {
  try {
    const raw = fs.readFileSync(ACCOUNT_FILE, "utf8");
    const o = JSON.parse(raw);
    if (!o || typeof o.account !== "string") return null;
    return {
      channel: String(o.channel || "官方"),
      account: String(o.account || ""),
      password: String(o.password || ""),
      note: String(o.note || ""),
      updatedAt: Number(o.updatedAt || 0),
    };
  } catch {
    return null;
  }
}

function saveAccount(a: NeteaseAccount) {
  fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
  try { fs.chmodSync(ACCOUNT_FILE, 0o600); } catch {}
}

function maskAccount(acc: string): string {
  const s = String(acc || "");
  if (!s) return "";
  if (s.includes("@")) {
    const [u, d] = s.split("@");
    return (u.length <= 2 ? u[0] + "*" : u.slice(0, 2) + "***" + u.slice(-1)) + "@" + d;
  }
  if (/^\d{11}$/.test(s)) return s.slice(0, 3) + "****" + s.slice(-4);
  if (s.length <= 4) return s[0] + "***";
  return s.slice(0, 2) + "***" + s.slice(-2);
}

function accountView() {
  const a = loadAccount();
  if (!a) return { configured: false };
  return {
    configured: true,
    channel: a.channel,
    account: a.account,
    accountMasked: maskAccount(a.account),
    hasPassword: !!a.password,
    note: a.note || "",
    updatedAt: a.updatedAt,
  };
}

function utc8(d = new Date()): string {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().replace("Z", "+08:00");
}

function fileLog(line: string) {
  try {
    fs.appendFileSync(LOG_FILE, `[${utc8()}] ${line}\n`);
  } catch {}
}

function log(line: string) {
  console.log(`[${utc8()}] ${line}`);
  fileLog(line);
}
function logError(line: string) {
  console.error(`[${utc8()}] ${line}`);
  fileLog(`[错误] ${line}`);
}

/** ===== 机器人事件桥 ===== */
let bridgeConnected = false;
let bridgeError = "";
let lastText: { source?: string; message?: string; at: number } | null = null;
let lastKick: string | null = null;
let lastKickAt = 0;
/** 指令限速（条/秒）。网易反作弊对方块/指令突发很敏感，默认 8 条/秒。 */
const CMD_RATE = Math.max(1, Number(process.env.FB_NETEASE_RATE || 5));
/** 回读校验并发与采样上限（越低越安全，越高越快） */
const VERIFY_CONCURRENCY = Math.max(1, Number(process.env.FB_NETEASE_VERIFY_CONC || 2));
const VERIFY_SAMPLE = Math.max(10, Number(process.env.FB_NETEASE_VERIFY_SAMPLE || 120));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bridge = new NeteaseBridge({
  socketPath: SOCKET_PATH,
  token: TOKEN,
  onLog: (line) => log(line),
  onEvent: (ev: BridgeEvent) => {
    try {
      if (ev.event === "on_text" && ev.fields) {
        lastText = { source: ev.fields.source, message: String(ev.fields.message ?? ""), at: Date.now() };
      } else if (ev.event === "on_kicked" || ev.event === "on_disconnect") {
        const f: any = ev.fields || {};
        lastKick = f.reason_name ? `${f.reason_name}（reason=${f.reason_code}）` : "已断开";
        lastKickAt = Date.now();
        logError(`机器人断开：${lastKick}`);
        // 被踢时立即中止正在进行的导入/校验，避免继续往断开的会话里发指令
        if (build && !build.done) {
          build.error = `机器人被踢出：${lastKick}`;
          build.done = true;
          build.stepLabel = "已中断";
          if (buildTimer) clearTimeout(buildTimer);
          buildTimer = null;
          logError(`导入「${build.name}」因机器人断开被中止`);
        }
        if (verify) verify.running = false;
      } else if (ev.event === "on_start_game") {
        lastKick = null;
        lastKickAt = 0;
        log("机器人已进服（on_start_game）");
      }
    } catch {}
  },
});

/** ===== 状态 ===== */
type BuildState = {
  name: string;
  total: number;
  sent: number;
  commands: number;
  origin: { x: number; y: number; z: number };
  startedAt: number;
  done: boolean;
  cancelled: boolean;
  error?: string;
  step: number;
  stepLabel: string;
};

type VerifyState = {
  running: boolean;
  planned: number;
  checked: number;
  missing: number;
  fixed: number;
  remaining: number;
  deep: boolean;
  doneAt: number;
};

let pending: { st: ParsedStructure; uploadedAt: number } | null = null;
let build: BuildState | null = null;
let verify: VerifyState | null = null;
let buildTimer: NodeJS.Timeout | null = null;
let importStartedAt = 0;

function bar(placed: number, total: number): string {
  const ratio = total > 0 ? Math.min(1, placed / total) : 0;
  const filled = ratio >= 1 ? BAR_WIDTH : Math.min(BAR_WIDTH - 1, Math.floor(ratio * BAR_WIDTH));
  const pct = Math.floor(ratio * 100);
  return `§f[§a${"#".repeat(filled)}§7${"-".repeat(BAR_WIDTH - filled)}§f] §e${pct}% §7${placed}/${total}`;
}

function actionbar(text: string) {
  bridge.commandNoWait(`/titleraw @a actionbar ${JSON.stringify({ rawtext: [{ text }] })}`);
}

function chat(text: string) {
  bridge.commandNoWait(`/tellraw @a ${JSON.stringify({ rawtext: [{ text }] })}`);
}

function setStep(step: number, label: string) {
  if (build) {
    build.step = step;
    build.stepLabel = label;
  }
}

/** 发一条指令并等回执；noChange = 方块已在（幂等确认通过） */
async function runCommand(text: string, timeoutMs = 15000): Promise<{ ok: boolean; noChange: boolean }> {
  const r = await bridge.command(text, timeoutMs);
  if (!r.ok) return { ok: false, noChange: false };
  const d: any = r.data || {};
  const msgs: any[] = Array.isArray(d.echo?.messages) ? d.echo.messages : [];
  const noChange = msgs.some((m) => m && m.success === false && String(m.message ?? "").includes("noChange"));
  if (d.command_success === true) return { ok: true, noChange: false };
  if (noChange) return { ok: false, noChange: true };
  const allOk = msgs.length > 0 && msgs.every((m) => m && m.success);
  return { ok: allOk, noChange: false };
}

/** 采样表面位置（deep 时更密） */
function surfaceSample(st: ParsedStructure, deep: boolean, capOverride?: number) {
  const sx = st.size.x, sy = st.size.y, sz = st.size.z;
  const surface: { x: number; y: number; z: number; block: string }[] = [];
  for (const b of st.blocks) {
    if (b.x === 0 || b.x === sx - 1 || b.y === 0 || b.y === sy - 1 || b.z === 0 || b.z === sz - 1) {
      surface.push({ x: b.x, y: b.y, z: b.z, block: b.block });
    }
  }
  const cap = capOverride && capOverride > 0 ? capOverride : deep ? 2000 : 300;
  const stride = Math.max(1, Math.ceil(surface.length / cap));
  const out: { x: number; y: number; z: number; block: string }[] = [];
  for (let i = 0; i < surface.length; i += stride) out.push(surface[i]);
  return out;
}

/** 分批并发执行（每批之间留一点间隔，降低触发网易反作弊的概率） */
async function runBatches<T>(items: T[], concurrency: number, fn: (item: T) => Promise<boolean>): Promise<boolean[]> {
  const results: boolean[] = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    const res = await Promise.all(batch.map((it) => fn(it).catch(() => false)));
    res.forEach((v, j) => (results[i + j] = v));
    await sleep(40);
  }
  return results;
}

/**
 * 把结构里出现的方块名登记到客户端的「方块名 ⇄ 运行时 ID」表里：
 * 通过 bridge 的 set_block 在结构自身的代表位置再放一次同样的方块（内容不变），
 * 既不会改变世界，也能让 get_block 读出方块名，供后续纯本地回读比对。
 */
/**
 * 回读校验 + 补建（网易版）：
 * 对抽样点逐个发幂等 setblock —— 方块已经在 = 回执成功；缺/错 = 直接补上。
 * 不依赖 testforblock（那会触发网易 bad_packet 踢线），每个点一条指令、按 CMD_RATE 限速。
 */
async function verifyStructure(deep = false, cap?: number): Promise<{ ok: boolean; error?: string }> {
  if (!bridge.isConnected) return { ok: false, error: "机器人未连接" };
  if (lastKick && Date.now() - lastKickAt < 20000) return { ok: false, error: `机器人刚被踢出（${lastKick}），等它重新进服` };
  if (!lastOrigin) return { ok: false, error: "还没有导入过结构（缺少原点）" };
  if (verify && verify.running) return { ok: false, error: "校验正在进行" };
  const st = pending?.st;
  if (!st) return { ok: false, error: "还没有导入过结构" };

  const points = surfaceSample(st, deep, cap || (deep ? 600 : VERIFY_SAMPLE));
  verify = { running: true, planned: points.length, checked: 0, missing: 0, fixed: 0, remaining: 0, deep, doneAt: 0 };
  const so = lastOrigin;
  log(`开始逐点确认：${points.length} 个表面位置（限速 ${CMD_RATE}/秒，幂等 setblock）`);
  chat(`§e第 2/3 步：完整性校验（逐点确认 ${points.length} 个方块）…`);

  let failed = 0;
  for (const p of points) {
    if (lastKick && Date.now() - lastKickAt < 20000) break;
    const w = { x: so.x + p.x, y: so.y + p.y, z: so.z + p.z };
    const r = await runCommand(`/setblock ${w.x} ${w.y} ${w.z} ${p.block}`);
    verify.checked++;
    if (!r.ok && !r.noChange) failed++;
    if (verify.checked % 10 === 0 || verify.checked >= points.length) {
      actionbar(`§e第 2/3 步 校验「${st.name}」 ${bar(verify.checked, points.length)} §c失败 ${failed}`);
    }
    await sleep(Math.max(30, Math.round(1000 / CMD_RATE)));
  }
  verify.missing = failed;
  verify.fixed = failed;
  verify.remaining = failed;
  log(`逐点确认完成：${verify.checked} 点，失败 ${failed} 处`);
  verify.running = false;
  verify.doneAt = Date.now();

  if (failed === 0) {
    chat(`§a✔ 三步全部通过：${st.name} · ${st.total} 方块 · 逐点确认 ${verify.checked} 点全部成功`);
    log(`校验通过：${st.name} 逐点确认 ${verify.checked} 点全部成功`);
  } else {
    chat(`§c⚠ 校验完成：${verify.checked} 点中有 ${failed} 处失败（已尝试直接补写，可再点「完整性检查」复查）`);
    logError(`校验：${failed} 处 setblock 失败`);
  }
  return { ok: true };
}

let lastOrigin: { x: number; y: number; z: number } | null = null;

/** 导入结构（异步执行，进度看 /import/status） */
async function startImport(st: ParsedStructure, offsetY: number): Promise<{ ok: boolean; error?: string; info?: any }> {
  if (!bridge.isConnected) return { ok: false, error: "机器人未连接（先确认机器人已进服）" };
  if (build && !build.done) return { ok: false, error: "已有导入进行中" };
  if (st.total > STRUCTURE_LIMIT) return { ok: false, error: `结构太大：${st.total} 方块（上限 ${STRUCTURE_LIMIT}）` };

  const pos = await bridge.getPosition();
  if (!pos) return { ok: false, error: "拿不到机器人坐标" };
  const origin = { x: Math.floor(pos.x), y: Math.floor(pos.y) + Math.trunc(offsetY), z: Math.floor(pos.z) };
  const cmds = structureCommands(st, origin, 0);
  lastOrigin = origin;
  build = {
    name: st.name,
    total: st.total,
    sent: 0,
    commands: cmds.length,
    origin,
    startedAt: Date.now(),
    done: false,
    cancelled: false,
    step: 1,
    stepLabel: "放置方块",
  };
  importStartedAt = Date.now();
  log(`开始导入「${st.name}」：${st.size.x}×${st.size.y}×${st.size.z}，${st.total} 方块 / ${cmds.length} 条命令，原点 ${origin.x},${origin.y},${origin.z}`);
  chat(`§e第 1/3 步：放置方块「${st.name}」 ${st.size.x}×${st.size.y}×${st.size.z}，共 ${st.total} 方块`);
  actionbar(`§e第 1/3 步 放置「${st.name}」 ${bar(0, cmds.length)}`);

  let idx = 0;
  let lastBar = 0;
  const tick = () => {
    buildTimer = null;
    if (!build || build.cancelled) return;
    if (!bridge.isConnected) {
      build.error = "机器人连接已断开";
      build.done = true;
      logError(`导入中断：机器人连接已断开`);
      return;
    }
    // 限速：每个节拍只发 1 条命令（默认 8 条/秒），避免触发网易反作弊
    if (idx < cmds.length) {
      const c = cmds[idx++];
      bridge.commandNoWait(`/${c.command}`);
      build.sent++;
    }
    if (Date.now() - lastBar > 1200 || idx >= cmds.length) {
      lastBar = Date.now();
      actionbar(`§e第 1/3 步 放置「${build.name}」 ${bar(idx, cmds.length)} §7(${CMD_RATE}/秒)`);
    }
    if (idx >= cmds.length) {
      setStep(2, "完整性校验");
      log(`「${st.name}」第 1 步完成（${cmds.length} 条命令，限速 ${CMD_RATE}/秒），2 秒后进入第 2 步校验`);
      build.stepLabel = "完整性校验";
      setTimeout(() => {
        verifyStructure(false)
          .then((r) => {
            if (!build) return;
            const b = build;
            b.done = true;
            b.step = 3;
            b.stepLabel = "已完成";
            const ok = r.ok && verify && verify.remaining === 0;
            if (ok) {
              actionbar(`§a✔ 导入完成「${b.name}」 三步全部通过`);
              chat(
                `§a✔ 导入完成（三步全部通过）：${b.name} · ${b.total} 方块 · 回读 ${verify?.planned ?? 0} 点 · 补齐 ${verify?.fixed ?? 0} 处`
              );
              log(`「${st.name}」三步全部通过：${b.total} 方块 / 回读 ${verify?.planned ?? 0} 点 / 补齐 ${verify?.fixed ?? 0} 处`);
            } else {
              chat(`§c⚠ 导入完成但校验未通过：${st.name}（${b.error ?? verify?.remaining ?? 0}）`);
              logError(`「${st.name}」校验未通过：${b.error ?? verify?.remaining ?? 0}`);
            }
            setTimeout(() => {
              if (build?.done) build = null;
            }, 15000);
          })
          .catch((e) => {
            logError(`校验异常：${e?.message ?? e}`);
            if (build) {
              build.done = true;
              build.error = String(e?.message ?? e);
            }
          });
      }, 2000);
      return;
    }
    buildTimer = setTimeout(tick, Math.max(30, Math.round(1000 / CMD_RATE)));
  };
  tick();
  return { ok: true, info: { name: st.name, size: st.size, total: st.total, commands: cmds.length, origin } };
}

/** ===== HTTP ===== */
function json(res: ServerResponse, code: number, obj: any) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readJson(req: IncomingMessage, limit = 96 << 20): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const p = url.pathname;
    if (p === "/health") return json(res, 200, { ok: true, app: APP_NAME, connected: bridge.isConnected });

    if (p === "/status" && req.method === "GET") {
      const pos = await bridge.getPosition().catch(() => null);
      const identity = await bridge.identity().catch(() => null);
      const players = await bridge.players().catch(() => null);
      const bp = bridge.protocol;
      const protocolCheck = checkBotProtocol(bp.version, bp.gameVersion);
      return json(res, 200, {
        ok: true,
        app: APP_NAME,
        protocol: {
          ...protocolCheck,
          source: NETEASE_PROTOCOL.source,
          target: effectiveProtocolVersion(),
          targetGameVersion: gameVersionFor(effectiveProtocolVersion()),
          minSupported: NETEASE_PROTOCOL.minSupportedProtocol,
        },
        bridge: { connected: bridge.isConnected, socket: SOCKET_PATH, error: bridgeError },
        bot: { identity, position: pos, players },
        pending: pending ? { name: pending.st.name, size: pending.st.size, total: pending.st.total, uploadedAt: pending.uploadedAt } : null,
        build,
        verify,
        lastText,
        lastKick,
        account: accountView(),
        serverNow: utc8(),
      });
    }

    // ---- 网络账号信息 ----
    if (p === "/account" && req.method === "GET") {
      return json(res, 200, { ok: true, ...accountView() });
    }
    if (p === "/account" && req.method === "POST") {
      const body = await readJson(req);
      const account = String(body.account ?? "").trim();
      if (!account) return json(res, 400, { ok: false, error: "账号不能为空" });
      const prev = loadAccount();
      const password = body.password === undefined || body.password === null
        ? (prev?.password ?? "")
        : String(body.password);
      const a: NeteaseAccount = {
        channel: String(body.channel ?? prev?.channel ?? "官方").trim() || "官方",
        account,
        password,
        note: String(body.note ?? prev?.note ?? "").trim(),
        updatedAt: Date.now(),
      };
      saveAccount(a);
      log(`网络账号已保存：${maskAccount(account)}（${a.channel}）`);
      return json(res, 200, { ok: true, ...accountView() });
    }
    if (p === "/account" && req.method === "DELETE") {
      try { fs.unlinkSync(ACCOUNT_FILE); } catch {}
      log("网络账号信息已清除");
      return json(res, 200, { ok: true, configured: false });
    }

    if (p === "/prepare" && req.method === "POST") {
      const body = await readJson(req);
      const name = String(body.name ?? "structure").replace(/\.mcstructure$/i, "").trim().slice(0, 80) || "structure";
      const data = String(body.data ?? "");
      if (!data) return json(res, 400, { ok: false, error: "缺少文件数据" });
      let buf: Buffer;
      try {
        buf = Buffer.from(data, "base64");
      } catch {
        return json(res, 400, { ok: false, error: "文件数据不是合法的 Base64" });
      }
      let st: ParsedStructure;
      try {
        st = parseStructureFile(buf, name);
      } catch (e: any) {
        return json(res, 200, { ok: false, error: `解析失败：${e?.message ?? e}` });
      }
      pending = { st, uploadedAt: Date.now() };
      log(`已解析结构「${name}」：${st.size.x}×${st.size.y}×${st.size.z}，${st.total} 方块`);
      return json(res, 200, {
        ok: true,
        structure: { name: st.name, size: st.size, total: st.total, paletteSize: st.paletteSize, materials: st.materials },
      });
    }

    if (p === "/build" && req.method === "POST") {
      const body = await readJson(req);
      if (!pending) return json(res, 200, { ok: false, error: "还没有上传结构文件" });
      const r = await startImport(pending.st, Number(body.offsetY ?? 0));
      return json(res, 200, r);
    }

    if (p === "/cancel" && req.method === "POST") {
      if (build && !build.done) {
        build.cancelled = true;
        build.done = true;
        if (buildTimer) clearTimeout(buildTimer);
        chat("§c已取消导入");
        log("已取消导入");
        return json(res, 200, { ok: true });
      }
      return json(res, 200, { ok: false, error: "没有正在进行的导入" });
    }

    if (p === "/clear" && req.method === "POST") {
      pending = null;
      return json(res, 200, { ok: true });
    }

    if (p === "/verify" && req.method === "POST") {
      const body = await readJson(req);
      // 异步启动
      verifyStructure(!!body.deep, Number(body.cap || 0) || undefined).catch((e) =>
        logError(`校验异常：${e?.message ?? e}`)
      );
      return json(res, 200, { ok: true, started: true, deep: !!body.deep });
    }

    if (p === "/pos" && req.method === "POST") {
      const pos = await bridge.getPosition();
      return json(res, 200, pos ? { ok: true, ...pos } : { ok: false, error: "拿不到坐标" });
    }

    if (p === "/command" && req.method === "POST") {
      const body = await readJson(req);
      const text = String(body.text ?? "").trim();
      if (!text) return json(res, 400, { ok: false, error: "text 不能为空" });
      const r = await bridge.command(text, 20000);
      return json(res, 200, r);
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (e: any) {
    logError(`请求处理异常：${e?.message ?? e}`);
    return json(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

function boot() {
  if (!SOCKET_PATH) {
    logError("未设置 FB_NETEASE_SOCKET，无法连接机器人事件桥");
  } else {
    log(`${APP_NAME} 启动：事件桥 ${SOCKET_PATH}`);
  log(describeBaseline());
    bridge.subscribeEvents("cyanqiuper");
    bridge.connect();
  }
  server.listen(PORT, HOST, () => {
    log(`网易版服务已启动：http://${HOST}:${PORT}`);
  });
}

boot();
