import { WSServer, Version } from "mcpews";
import { WebSocketServer as JWS } from "ws";
import Session from "./src/session";
import { parseMcStructure, structureCommands, ParsedStructure } from "./src/structure";
import { parseStructureFile } from "./src/formats";
import { repairMcStructure } from "./src/structure-repair";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";

/** ===== 配置（可用环境变量覆盖） ===== */
const WS_PORT = Number(process.env.FB_WS_PORT ?? 11451);
const CONTROL_PORT = Number(process.env.FB_CONTROL_PORT ?? 11453);
// 新版基岩版(1.21+)的 WebSocket 协议版本；老版本(1)会被拒收（EncryptionRequired）
const WS_VERSION = Number(process.env.FB_WS_VERSION ?? 17104896);
const APP_NAME = "CyanQiuper";
const STARTED_AT = Date.now();

/** ===== 时间：统一按 UTC+8 输出 ===== */
const TZ_OFFSET_MS = 8 * 3600 * 1000;
function isoUtc8(ms = Date.now()): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().replace("Z", "+08:00");
}
function clockUtc8(ms = Date.now()): string {
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(11, 19);
}

/** ===== 日志：自己写文件，网页直接读文件 ===== */
const LOG_DIR = process.env.FB_LOG_DIR ? path.resolve(process.env.FB_LOG_DIR) : path.resolve(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "ws.log");
fs.mkdirSync(LOG_DIR, { recursive: true });

function log(text: string) {
  const line = `[${isoUtc8()}] [ws] ${text}`;
  try {
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
  console.log(`[${clockUtc8()}] ${text}`);
}
function logError(text: string) {
  try {
    fs.appendFileSync(LOG_FILE, `[${isoUtc8()}] [ws] [错误] ${text}\n`);
  } catch {}
  console.error(`[${clockUtc8()}] ${text}`);
}

/** ===== 会话表 ===== */
const sessions = new Map<Session, { address: string; connectedAt: number }>();

/** ===== 连接限流：同一 IP 每分钟最多 5 次连接，超限封禁 10 小时 ===== */
const CONN_WINDOW_MS = 60_000;
const CONN_MAX = 5;
const CONN_BLOCK_MS = 10 * 60 * 60 * 1000;
const connRate = new Map<string, { times: number[]; blockedUntil: number }>();
const retired = { commands: 0, setblocks: 0, messages: 0, errors: 0 };
let totalConnections = 0;

function activeSession(): Session | null {
  let last: Session | null = null;
  for (const s of sessions.keys()) last = s;
  return last;
}

/** 只有已通过 --login 验证的会话才允许操作 */
function authedSession(): Session | null {
  const s = activeSession();
  return s && s.authUser ? s : null;
}

/** ===== 结构导入（.mcstructure）===== */
const STRUCTURE_LIMIT_BLOCKS = 500000;
let pendingStructure: ParsedStructure | null = null;
let pendingUploadedAt = 0;
/** 最近上传的结构文件格式（用于 HUD 显示） */
let pendingFormat = ".mcstructure";

type BuildState = {
  name: string;
  total: number;
  placed: number;
  commands: number;
  startedAt: number;
  done: boolean;
  cancelled: boolean;
  error?: string;
  /** 已发送命令数 */
  sent: number;
  /** 游戏回执确认成功的命令数 */
  confirmed: number;
  /** 已补建轮次 */
  retryRound: number;
  /** 补建过的命令数 */
  retried: number;
  /** 最终仍失败的命令数 */
  failed: number;
  /** 最终仍失败的方块数 */
  failedBlocks: number;
  /** 校验是否通过 */
  verified: boolean;
  /** 当前步骤：1 放置 / 2 校验 / 3 补建 */
  step: number;
  /** 当前步骤名 */
  stepLabel: string;
};
let build: BuildState | null = null;
let buildTimer: NodeJS.Timeout | null = null;

const MAX_RETRY_ROUNDS = 3;

/** ===== 顶部 HUD：仿 PasteCraft-Builder 的多行 actionbar ===== */
const HUD_BAR = 16;

/** ===== 导入速度/稳定性参数（可用环境变量覆盖） ===== */
const SEND_WINDOW_MAX = Math.max(4, Number(process.env.FB_SEND_WINDOW ?? 48));
const SEND_WINDOW_MIN = Math.max(1, Number(process.env.FB_SEND_WINDOW_MIN ?? 8));
const SEND_TICK_MS = Math.max(4, Number(process.env.FB_SEND_TICK ?? 12));
const SEND_SAMPLE_MS = Math.max(100, Number(process.env.FB_SEND_SAMPLE ?? 400));
const SEND_FAIL_RATIO = Math.min(1, Math.max(0.01, Number(process.env.FB_SEND_FAIL_RATIO ?? 0.05)));
type HudState = {
  active: boolean;
  name: string;
  format: string;
  phase: string;
  total: number;
  placed: number;
  bar2Label: string;
  bar2: number;
  bar2Total: number;
  suffix: string;
  startedAt: number;
  until: number;
  chunkEnds: number[] | null;
  chunkCacheFor: ParsedStructure | null;
};
let hud: HudState | null = null;

function hudDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function hudBar(value: number, total: number): string {
  const ratio = total > 0 ? Math.min(1, value / total) : 0;
  const filled = ratio >= 1 ? HUD_BAR : Math.min(HUD_BAR - 1, Math.floor(ratio * HUD_BAR));
  return `§e[§e${"█".repeat(filled)}§8${"░".repeat(HUD_BAR - filled)}§e]`;
}

function hudChunkEnds(): number[] | null {
  const st = pendingStructure;
  if (!st) return null;
  if (hud && hud.chunkCacheFor === st && hud.chunkEnds) return hud.chunkEnds;
  const ends: number[] = [];
  let prevKey = "";
  let acc = 0;
  for (const b of st.blocks) {
    const key = `${b.x >> 4},${b.y >> 4},${b.z >> 4}`;
    if (key !== prevKey) {
      if (acc > 0) ends.push(acc);
      prevKey = key;
    }
    acc++;
  }
  ends.push(acc);
  if (hud) {
    hud.chunkEnds = ends;
    hud.chunkCacheFor = st;
  }
  return ends;
}

function hudStart(name: string, total: number, format: string) {
  hud = {
    active: true,
    name,
    format,
    phase: "放置方块",
    total,
    placed: 0,
    bar2Label: "区块进度",
    bar2: 0,
    bar2Total: 1,
    suffix: "",
    startedAt: Date.now(),
    until: Infinity,
    chunkEnds: null,
    chunkCacheFor: null,
  };
  hudChunkEnds();
  hudRender();
}

function hudSetPhase(phase: string, bar2Label: string, bar2: number, bar2Total: number, suffix = "") {
  if (!hud) return;
  hud.phase = phase;
  hud.bar2Label = bar2Label;
  hud.bar2 = bar2;
  hud.bar2Total = bar2Total;
  hud.suffix = suffix;
  hudRender();
}

let lastHudRender = 0;
function hudRender(force = false) {
  if (!hud || !hud.active) return;
  const busy = !!(build && !build.done);
  if (!force && busy && Date.now() - lastHudRender < 1000) return;
  lastHudRender = Date.now();
  const s = activeSession();
  if (!s) return;
  const ratio = hud.total > 0 ? Math.min(1, hud.placed / hud.total) : 0;
  const elapsed = Date.now() - hud.startedAt;
  const eta = ratio > 0.02 ? (elapsed * (1 - ratio)) / ratio : 0;
  const bar2ratio = hud.bar2Total > 0 ? Math.min(1, hud.bar2 / hud.bar2Total) : 0;
  const lines = [
    `§l§eCyanQiuper-Builder §r§7${hud.phase}`,
    `§f总体进度 ${hudBar(hud.placed, hud.total)} §e${Math.floor(ratio * 100)}%`,
    `§f${hud.bar2Label} ${hudBar(hud.bar2, hud.bar2Total)} §e${Math.floor(bar2ratio * 100)}%`,
    `§f文件名称 §a${hud.name}`,
    `§f文件格式 §b${hud.format}`,
    `§f已用时 §b${hudDuration(elapsed)}   §f剩余时间 §e${ratio > 0.02 ? hudDuration(eta) : "--:--"}${hud.suffix ? `  §7${hud.suffix}` : ""}`,
  ];
  try {
    s.sendRaw(`titleraw @s actionbar ${JSON.stringify({ rawtext: [{ text: lines.join("\n") }] })}`);
  } catch {}
}

/** 任务结束后保留 8 秒再停止刷新（期间仍每秒重发，避免 actionbar 消失） */
function hudEnd(finalText?: string) {
  if (!hud) return;
  hud.until = Date.now() + 8000;
  if (finalText) {
    try {
      const s = activeSession();
      s && s.sendRaw(`titleraw @s actionbar ${JSON.stringify({ rawtext: [{ text: finalText }] })}`);
    } catch {}
  }
}

function hudStop() {
  hud = null;
}

// 任务进行期间每 500ms 重发一次 HUD：防止被游戏其它 actionbar 覆盖/超时消失
setInterval(() => {
  if (!hud || !hud.active) return;
  if (Date.now() > hud.until) {
    hudStop();
    return;
  }
  hudRender();
}, 500);

/** 兼容旧调用：更新总体进度（同时按 16³ 区块计算「区块进度」） */
function actionbarProgress(name: string, placed: number, total: number, suffix = "") {
  if (!hud || !hud.active) hudStart(name, total, pendingFormat);
  hud!.placed = placed;
  hud!.total = total;
  hud!.suffix = suffix;
  const ends = hudChunkEnds();
  if (ends && ends.length) {
    let idx = 0;
    while (idx < ends.length - 1 && placed >= ends[idx]) idx++;
    const start = idx === 0 ? 0 : ends[idx - 1];
    const end = ends[idx];
    const intra = end > start ? Math.min(1, Math.max(0, (placed - start) / (end - start))) : 1;
    hudSetPhase(`放置方块（区块 ${idx + 1}/${ends.length}）`, "区块进度", intra, 1, suffix);
  } else {
    hudRender();
  }
}

/** 文字提示（不带进度条） */
function actionbarText(text: string) {
  try {
    const s = activeSession();
    s && s.sendRaw(`titleraw @s actionbar ${JSON.stringify({ rawtext: [{ text }] })}`);
  } catch {}
}

function sendActionbar(parts: { text: string }[]) {
  const s = activeSession();
  if (!s) return;
  try {
    s.sendRaw(`titleraw @s actionbar ${JSON.stringify({ rawtext: parts })}`);
  } catch {}
}

type StructureCmd = { command: string; count: number };

/**
 * 导入结构：分批发送命令，并逐条等游戏回执校验。
 * 失败的命令自动补建（最多 MAX_RETRY_ROUNDS 轮），最后报告校验结果。
 */
function startStructureBuild(offsetY: number) {
  const s = authedSession();
  if (!s) return { ok: false, error: "游戏会话未验证身份，请先在游戏里发送 --login 终端令牌" };
  if (build && !build.done) return { ok: false, error: "已有结构正在导入，先取消或等它完成" };
  if (!pendingStructure) return { ok: false, error: "还没有上传结构文件" };
  const st = pendingStructure;
  if (st.total > STRUCTURE_LIMIT_BLOCKS) {
    return { ok: false, error: `结构太大：${st.total} 方块（上限 ${STRUCTURE_LIMIT_BLOCKS}）` };
  }

  const origin = {
    x: Math.round(s.setting.origin?.x ?? 0),
    y: Math.round(s.setting.origin?.y ?? 0),
    z: Math.round(s.setting.origin?.z ?? 0),
  };
  const cmds: StructureCmd[] = structureCommands(st, origin, Math.trunc(offsetY) || 0);
  lastBuild = { st, origin, offsetY: Math.trunc(offsetY) || 0 };

  build = {
    name: st.name,
    total: st.total,
    placed: 0,
    commands: cmds.length,
    startedAt: Date.now(),
    done: false,
    cancelled: false,
    sent: 0,
    confirmed: 0,
    retryRound: 0,
    retried: 0,
    failed: 0,
    failedBlocks: 0,
    verified: false,
    step: 1,
    stepLabel: "放置方块",
  };
  log(
    `开始导入结构「${st.name}」：${st.size.x}×${st.size.y}×${st.size.z}，${st.total} 方块 / ${cmds.length} 条命令，原点 ${origin.x},${origin.y},${origin.z}`
  );
  s.chat(`§e开始导入结构「${st.name}」：${st.size.x}×${st.size.y}×${st.size.z}，共 ${st.total} 方块`);
  actionbarProgress(st.name, 0, st.total);

  let inFlight = 0;
  let failedQueue: StructureCmd[] = [];

  /** 等当前批次的回执全部回来（最多 8 秒，超时按未确认处理） */
  const waitIdle = (cb: () => void) => {
    const started = Date.now();
    const check = () => {
      if (!build || build.cancelled) return;
      if (inFlight <= 0) return cb();
      if (Date.now() - started > 8000) {
        logError(`等待游戏回执超时（还有 ${inFlight} 条未响应），按未确认处理`);
        return cb();
      }
      setTimeout(check, 80);
    };
    setTimeout(check, 120);
  };

  const sendBatch = (list: StructureCmd[], onDone: () => void, isRetry: boolean) => {
    let idx = 0;
    let lastBar = 0;
    // 初速：首轮全速；补建轮从半速开始，避免再次过载
    let window = isRetry ? Math.max(SEND_WINDOW_MIN, Math.floor(SEND_WINDOW_MAX / 3)) : SEND_WINDOW_MAX;
    let sentSinceSample = 0;
    let failedSinceSample = 0;
    let lastSample = Date.now();

    const pump = () => {
      buildTimer = null;
      if (!build || build.cancelled) return;
      const sess = activeSession();
      if (!sess) {
        if (build) {
          build.error = "游戏连接已断开";
          build.done = true;
        }
        logError(`结构「${st.name}」导入中断：游戏连接已断开`);
        return;
      }

      // 以「在途命令数」为闸门：窗口没满就继续发，把管道喂饱
      while (idx < list.length && inFlight < window) {
        const c = list[idx++];
        inFlight++;
        build.sent++;
        sentSinceSample++;
        if (isRetry) {
          build.retried++;
        } else {
          build.placed += c.count;
          sess.stats.setblocks += c.count;
        }
        try {
          sess.session.sendCommand(c.command, ({ body }: any) => {
            inFlight = Math.max(0, inFlight - 1);
            if (!build) return;
            if (body && body.statusCode === 0) build.confirmed++;
            else {
              failedSinceSample++;
              failedQueue.push(c);
            }
          });
        } catch {
          inFlight = Math.max(0, inFlight - 1);
          failedSinceSample++;
          failedQueue.push(c);
        }
      }

      const now = Date.now();
      // 每 400ms 采样一次：失败率高就收窗口，稳定就逐步放大
      if (now - lastSample >= SEND_SAMPLE_MS) {
        const ratio = sentSinceSample > 0 ? failedSinceSample / sentSinceSample : 0;
        if (ratio > SEND_FAIL_RATIO) {
          window = Math.max(SEND_WINDOW_MIN, Math.floor(window * 0.7));
          logError(`发送失败率 ${(ratio * 100).toFixed(1)}%，降速：窗口 ${window}`);
        } else if (window < SEND_WINDOW_MAX && inFlight < window * 0.6) {
          window = Math.min(SEND_WINDOW_MAX, window + 4);
        }
        sentSinceSample = 0;
        failedSinceSample = 0;
        lastSample = now;
      }

      if (now - lastBar > 250 || idx >= list.length) {
        lastBar = now;
        if (build) {
          const suffix = isRetry ? ` §c补建第 ${build.retryRound} 轮` : "";
          actionbarProgress(build.name, build.placed, build.total, suffix);
        }
      }

      if (idx >= list.length) {
        waitIdle(onDone);
        return;
      }
      buildTimer = setTimeout(pump, SEND_TICK_MS);
    };
    pump();
  };

  /** 第 1 步结束 → 强制进入第 2、3 步（校验 + 补建） */
  const finish = () => {
    if (!build) return;
    const b = build;
    b.failed = failedQueue.length;
    b.failedBlocks = failedQueue.reduce((sum, c) => sum + c.count, 0);
    lastFailed = failedQueue.slice();
    lastFailedName = b.name;
    b.step = 2;
    b.stepLabel = "完整性校验";
    const badCommands = b.failed;
    const badBlocks = b.failedBlocks;
    log(`「${b.name}」第 1 步完成：${b.placed}/${b.total} 方块，命令失败 ${badCommands} 条；进入第 2 步校验`);
    s.chat(
      `§e第 1/3 步完成（放置方块）${badCommands ? "，有 " + badCommands + " 条命令未成功" : ""}；开始第 2/3 步：完整性校验…`
    );
    actionbarProgress(b.name, b.placed, b.total);
    verifyStructure(false, { pipeline: true, cap: 40000 })
      .then((r: any) => {
        if (!build) return;
        const bb = build;
        const v = r && r.ok ? r.verify : null;
        bb.step = 3;
        bb.stepLabel = "补建缺失";
        const passed = !!(v && v.remaining === 0);
        bb.done = true;
        bb.verified = passed && badCommands === 0;
        bb.failed = badCommands;
        bb.failedBlocks = Math.max(badBlocks, v ? v.remaining : badBlocks);
        if (bb.verified) {
          hudSetPhase("✔ 三步全部通过", "补建进度", 1, 1);
          hudEnd();
          s.chat(
            `§a✔ 导入完成（三步全部通过）：${bb.name} · ${bb.total} 方块 · 命令 ${bb.commands} 条 · 回读抽查 ${v ? v.planned : 0} 点 · 补齐 ${v ? v.fixed : 0} 处`
          );
          log(
            `「${bb.name}」三步全部通过：${bb.total} 方块 / ${bb.commands} 条命令 / 抽查 ${v ? v.planned : 0} 点 / 补齐 ${v ? v.fixed : 0} 处`
          );
        } else {
          hudSetPhase("⚠ 校验未通过", "缺失方块", bb.failedBlocks, Math.max(1, bb.failedBlocks));
          hudEnd();
          s.chat(
            `§c⚠ 三步未全部通过：${bb.name} · 命令失败 ${badCommands} 条 / ${badBlocks} 方块 · 回读缺失 ${v ? v.remaining : "?"} 处（靠近结构后再点「完整性检查」）`
          );
          logError(
            `「${bb.name}」三步未全部通过：命令失败 ${badCommands} 条 / 回读缺失 ${v ? v.remaining : "?"} 处`
          );
        }
        setTimeout(() => {
          if (build?.done) build = null;
        }, 12000);
      })
      .catch((e: any) => {
        logError(`完整性校验异常：${e?.message ?? e}`);
        if (build) {
          build.done = true;
          build.verified = false;
          build.error = String(e?.message ?? e);
          hudSetPhase("⚠ 校验异常", "回读进度", 0, 1);
          hudEnd();
        }
      });
  };
  const onRoundDone = () => {
    if (!build || build.cancelled) return;
    if (failedQueue.length === 0) return finish();
    if (build.retryRound >= MAX_RETRY_ROUNDS) return finish();
    build.retryRound++;
    const retryList = failedQueue;
    failedQueue = [];
    log(
      `补建第 ${build.retryRound} 轮：${retryList.length} 条命令（${retryList.reduce((a, c) => a + c.count, 0)} 方块）`
    );
    s.chat(`§e有 ${retryList.length} 条命令未成功，开始第 ${build.retryRound} 轮补建…`);
    const backoff = Math.min(2000, 400 * build.retryRound);
    setTimeout(() => {
      if (!build || build.cancelled) return;
      sendBatch(retryList, onRoundDone, true);
    }, backoff);
  };

  // 第一轮：全部命令
  sendBatch(cmds.slice(), onRoundDone, false);

  return { ok: true, name: st.name, size: st.size, total: st.total, commands: cmds.length, origin };
}

/** 上一次导入/补建后仍失败的方块命令（用于「补建未完成方块」） */
type VerifyPoint = { x: number; y: number; z: number; block: string };

/** 最近一次导入的结构信息（用于回读检查） */
let lastBuild: { st: ParsedStructure; origin: { x: number; y: number; z: number }; offsetY: number } | null = null;

type VerifyState = {
  running: boolean;
  planned: number;
  checked: number;
  missing: number;
  fixed: number;
  remaining: number;
  deep: boolean;
  startedAt: number;
  doneAt: number;
  error?: string;
};
let buildVerify: VerifyState | null = null;

/** 采样要检查的表面位置（deep=true 时更密） */
function surfaceSamplePoints(st: ParsedStructure, deep: boolean, capOverride?: number): VerifyPoint[] {
  const sx = st.size.x, sy = st.size.y, sz = st.size.z;
  const surface: VerifyPoint[] = [];
  for (const b of st.blocks) {
    const onSurface = b.x === 0 || b.x === sx - 1 || b.y === 0 || b.y === sy - 1 || b.z === 0 || b.z === sz - 1;
    if (!onSurface) continue;
    surface.push({ x: b.x, y: b.y, z: b.z, block: b.block });
  }
  const cap = capOverride && capOverride > 0 ? capOverride : deep ? 30000 : 3000;
  const stride = Math.max(1, Math.ceil(surface.length / cap));
  const out: VerifyPoint[] = [];
  for (let i = 0; i < surface.length; i += stride) out.push(surface[i]);
  return out;
}

/** 发一条命令并等回执（超时返回 null） */
function commandResult(sess: Session, command: string, timeoutMs = 4000): Promise<any> {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    try {
      sess.session.sendCommand(command, ({ body }: any) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(body);
      });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

/**
 * 导入后回读完整性检查：
 * 用 testforblock 抽查结构表面位置，发现缺失就用 setblock 补上，再复检一次。
 */
async function verifyStructure(deep = false, opts: { pipeline?: boolean; cap?: number } = {}) {
  const pipeline = !!opts.pipeline;
  const s = authedSession();
  if (!s) return { ok: false, error: "游戏会话未验证身份，请先在游戏里发送 --login 终端令牌" };
  if (!lastBuild) return { ok: false, error: "还没有导入过结构" };
  if (buildVerify && buildVerify.running) return { ok: false, error: "完整性检查正在进行" };
  if (!pipeline && build && !build.done) return { ok: false, error: "导入/补建还在进行，先等它完成" };

  const { st, origin, offsetY } = lastBuild;
  const points = surfaceSamplePoints(st, deep, opts.cap);
  if (!points.length) return { ok: false, error: "结构没有可检查的方块" };
  buildVerify = {
    running: true,
    planned: points.length,
    checked: 0,
    missing: 0,
    fixed: 0,
    remaining: 0,
    deep,
    startedAt: Date.now(),
    doneAt: 0,
  };
  if (pipeline) {
    s.chat(`§e第 2/3 步：完整性校验（回读 ${points.length} 个表面方块）…`);
    log(`第 2/3 步校验「${st.name}」：回读 ${points.length} 个表面位置`);
  } else {
    s.chat(`§e开始完整性检查：抽查 ${points.length} 个位置…`);
    log(`开始完整性检查「${st.name}」：抽查 ${points.length} 个表面位置（${deep ? "深度" : "快速"}）`);
  }

  const missing: VerifyPoint[] = [];
  const world = (p: VerifyPoint) => ({ x: origin.x + p.x, y: origin.y + p.y + offsetY, z: origin.z + p.z });
  if (!hud || !hud.active) hudStart(st.name, st.total, pendingFormat);
  if (pipeline && build) hud.placed = build.placed;
  hudSetPhase(pipeline ? "第 2/3 步 完整性校验" : "完整性检查", "回读进度", 0, points.length);
  const aborted = () => pipeline && (!build || build.cancelled);

  // 第 2 步：回读抽查（testforblock）
  const batchSize = Math.max(10, Number(process.env.FB_VERIFY_BATCH ?? 100));
  for (let i = 0; i < points.length; i += batchSize) {
    if (aborted()) { buildVerify.running = false; return { ok: false, error: "已取消" }; }
    const sess = activeSession();
    if (!sess) { buildVerify.running = false; buildVerify.error = "游戏连接已断开"; return { ok: false, error: "游戏连接已断开" }; }
    const batch = points.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map((p) => {
        const w = world(p);
        return commandResult(sess, `testforblock ${w.x} ${w.y} ${w.z} ${p.block}`);
      })
    );
    results.forEach((body, idx) => {
      if (!body || body.statusCode !== 0) missing.push(batch[idx]);
    });
    buildVerify.checked += batch.length;
    hudSetPhase(
      pipeline ? "第 2/3 步 完整性校验" : "完整性检查",
      "回读进度",
      buildVerify.checked,
      points.length,
      `缺失 ${missing.length}`
    );
  }
  buildVerify.missing = missing.length;

  // 第 3 步：补建缺失 + 复检
  if (missing.length) {
    if (pipeline && build) {
      build.step = 3;
      build.stepLabel = "补建缺失";
    }
    if (pipeline) s.chat(`§e第 3/3 步：补建 ${missing.length} 处缺失…`);
    else s.chat(`§e抽查发现 ${missing.length} 处缺失，正在补建…`);
    log(`校验发现 ${missing.length} 处缺失，开始补建「${st.name}」`);
    for (let i = 0; i < missing.length; i += batchSize) {
      if (aborted()) { buildVerify.running = false; return { ok: false, error: "已取消" }; }
      const sess = activeSession();
      if (!sess) break;
      const batch = missing.slice(i, i + batchSize);
      await Promise.all(
        batch.map((p) => {
          const w = world(p);
          return commandResult(sess, `setblock ${w.x} ${w.y} ${w.z} ${p.block}`);
        })
      );
      hudSetPhase(
        pipeline ? "第 3/3 步 补建缺失" : "补建缺失",
        "补建进度",
        i + batch.length,
        missing.length
      );
    }

    // 复检
    const stillMissing: VerifyPoint[] = [];
    for (let i = 0; i < missing.length; i += batchSize) {
      if (aborted()) break;
      const sess = activeSession();
      if (!sess) break;
      const batch = missing.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((p) => {
          const w = world(p);
          return commandResult(sess, `testforblock ${w.x} ${w.y} ${w.z} ${p.block}`);
        })
      );
      results.forEach((body, idx) => {
        if (!body || body.statusCode !== 0) stillMissing.push(batch[idx]);
      });
    }
    buildVerify.fixed = missing.length - stillMissing.length;
    buildVerify.remaining = stillMissing.length;
  }
  buildVerify.running = false;
  buildVerify.doneAt = Date.now();

  const v = buildVerify;
  if (!pipeline) {
    hudSetPhase("✔ 检查完成", "回读进度", v.planned, v.planned);
    if (v.remaining === 0) {
      const msg =
        v.missing === 0
          ? `§a完整性检查通过：抽查 ${v.planned} 点，全部存在`
          : `§a完整性检查完成：抽查 ${v.planned} 点，发现 ${v.missing} 处缺失，已全部补齐`;
      s.chat(msg);
      log(msg.replace(/§[a-f0-9]/g, ""));
    } else {
      const msg = `§c完整性检查：抽查 ${v.planned} 点，${v.missing} 处缺失，补建后仍有 ${v.remaining} 处缺失（可能区块未加载）`;
      s.chat(msg);
      logError(msg.replace(/§[a-f0-9]/g, ""));
    }
    hudEnd();
  }
  return { ok: true, verify: v };
}

let lastFailed: StructureCmd[] = [];
let lastFailedName = "";

/** 只重发上次失败的方块命令（补建不完整的地方），完成后更新失败清单 */
function rebuildFailedBlocks() {
  const s = authedSession();
  if (!s) return { ok: false, error: "游戏会话未验证身份，请先在游戏里发送 --login 终端令牌" };
  if (build && !build.done) return { ok: false, error: "已有导入/补建正在进行" };
  if (!lastFailed.length) return { ok: false, error: "没有需要补建的方块（上次导入校验通过）" };
  const list = lastFailed.slice();
  const totalBlocks = list.reduce((a, c) => a + c.count, 0);
  const name = lastFailedName || "补建";
  build = {
    name,
    total: totalBlocks,
    placed: 0,
    commands: list.length,
    startedAt: Date.now(),
    done: false,
    cancelled: false,
    sent: 0,
    confirmed: 0,
    retryRound: 0,
    retried: 0,
    failed: 0,
    failedBlocks: 0,
    verified: false,
    step: 1,
    stepLabel: "放置方块",
  };
  log(`开始补建「${name}」：${list.length} 条命令 / ${totalBlocks} 方块`);
  s.chat(`§e开始补建上次未完成的 ${list.length} 条命令（${totalBlocks} 方块）…`);
  actionbarProgress(name, 0, totalBlocks);

  let inFlight = 0;
  let failed: StructureCmd[] = [];
  let idx = 0;
  let lastBar = 0;
  const step = () => {
    buildTimer = null;
    if (!build || build.cancelled) return;
    const sess = activeSession();
    if (!sess) {
      if (build) { build.error = "游戏连接已断开"; build.done = true; }
      logError("补建中断：游戏连接已断开");
      return;
    }
    let n = 0;
    while (idx < list.length && n < 28) {
      const c = list[idx++];
      inFlight++;
      build.sent++;
      build.placed += c.count;
      sess.stats.setblocks += c.count;
      try {
        sess.session.sendCommand(c.command, ({ body }: any) => {
          inFlight = Math.max(0, inFlight - 1);
          if (!build) return;
          if (body && body.statusCode === 0) build.confirmed++;
          else failed.push(c);
        });
      } catch {
        inFlight = Math.max(0, inFlight - 1);
        failed.push(c);
      }
      n++;
    }
    if (Date.now() - lastBar > 250 || idx >= list.length) {
      lastBar = Date.now();
      if (build) actionbarProgress(build.name, build.placed, build.total, " §c补建");
    }
    if (idx >= list.length) {
      const started = Date.now();
      const wait = () => {
        if (!build || build.cancelled) return;
        if (inFlight > 0 && Date.now() - started < 8000) {
          setTimeout(wait, 80);
          return;
        }
        lastFailed = failed.slice();
        const b = build;
        b.done = true;
        b.verified = failed.length === 0;
        b.failed = failed.length;
        b.failedBlocks = failed.reduce((a, c) => a + c.count, 0);
        if (b.verified) {
          hudSetPhase("✔ 补建完成", "补建进度", 1, 1);
          hudEnd();
          s.chat(`§a补建完成：${totalBlocks} 方块已全部补齐`);
          log(`补建完成「${name}」：${totalBlocks} 方块全部成功`);
        } else {
          hudSetPhase("⚠ 补建未通过", "缺失方块", b.failedBlocks, Math.max(1, b.failedBlocks));
          hudEnd();
          s.chat(`§c补建后仍有 ${b.failed} 条命令 / ${b.failedBlocks} 方块失败（可能区块未加载，靠近结构后再点一次）`);
          logError(`补建后「${name}」仍有 ${b.failed} 条命令失败`);
        }
        setTimeout(() => { if (build?.done) build = null; }, 10000);
      };
      setTimeout(wait, 120);
      return;
    }
    buildTimer = setTimeout(step, 90);
  };
  step();
  return { ok: true, name, commands: list.length, blocks: totalBlocks };
}

function cancelStructureBuild() {
  if (!build || build.done) return { ok: false, error: "当前没有正在导入的结构" };
  build.cancelled = true;
  if (buildTimer) clearTimeout(buildTimer);
  buildTimer = null;
  hudSetPhase("已取消", "放置进度", build.placed, Math.max(1, build.total));
  hudEnd();
  activeSession()?.chat(`§c已取消结构导入「${build.name}」`);
  log(`已取消结构导入「${build.name}」：${build.placed}/${build.total}`);
  build = null;
  return { ok: true };
}

function aggregatedStats() {
  const total = { ...retired };
  for (const s of sessions.keys()) {
    total.commands += s.stats.commands;
    total.setblocks += s.stats.setblocks;
    total.messages += s.stats.messages;
    total.errors += s.stats.errors;
  }
  return total;
}

/** 把任意返回值安全地转成可展示的文本 */
function preview(value: unknown): { type: string; text: string } {
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  let text: string;
  if (value === undefined) text = "undefined";
  else if (typeof value === "string") text = value;
  else if (type === "null" || type === "number" || type === "boolean") text = String(value);
  else if (type === "function") text = "[function]";
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > 800) text = `${text.slice(0, 800)}…`;
  return { type, text };
}

/** ===== WebSocket 服务（给 Minecraft 客户端连） ===== */
log(`===== ${APP_NAME} WS 服务启动 =====`);
log(`端口 ${WS_PORT}｜控制接口 ${CONTROL_PORT}｜协议版本 ${WS_VERSION}`);

let server: WSServer;
try {
  server = new WSServer(WS_PORT);
} catch (e) {
  logError(`WS 服务启动失败（端口 ${WS_PORT} 可能被占用）：${e}`);
  process.exit(1);
}
server.version = WS_VERSION as Version;

/** ===== 终端令牌到期 → 自动关闭导入器 ===== */
if (process.env.FB_USERS_FILE && process.env.FB_OWNER_UID) {
  setInterval(() => {
    try {
      const db = JSON.parse(fs.readFileSync(process.env.FB_USERS_FILE as string, "utf8"));
      const u = (db.users || []).find((x: any) => x.id === process.env.FB_OWNER_UID);
      const exp = Number(u?.panelTokenExp || 0);
      if (!exp || Date.now() > exp) {
        log("终端令牌已过期，导入器自动关闭");
        for (const s of sessions.keys()) {
          try {
            s.chat("§c终端令牌已过期，导入器已自动关闭。请回到终端重新开启获取新令牌。");
            s.session.disconnect();
          } catch {}
        }
        setTimeout(() => process.exit(0), 800);
      }
    } catch {}
  }, 60_000);
}
log(`WS 服务已启动：ws://127.0.0.1:${WS_PORT}（协议版本 ${WS_VERSION}）`);

server.on("client", ({ session, request }) => {
  const address = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  // ---- 连接限流：同一 IP 每分钟最多 5 次，超限封 10 小时 ----
  const ip = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const rec = connRate.get(ip) ?? { times: [], blockedUntil: 0 };
  if (rec.blockedUntil > now) {
    log(`[限流] ${ip} 处于封禁中（剩余 ${Math.ceil((rec.blockedUntil - now) / 60000)} 分钟），拒绝连接`);
    try { session.socket.close(1008, "rate limited"); } catch {}
    return;
  }
  rec.times = rec.times.filter((t) => now - t < CONN_WINDOW_MS);
  rec.times.push(now);
  if (rec.times.length > CONN_MAX) {
    rec.blockedUntil = now + CONN_BLOCK_MS;
    connRate.set(ip, rec);
    log(`[限流] ${ip} 1 分钟内连接 ${rec.times.length} 次，封禁 10 小时`);
    try { session.socket.close(1008, "too many connections"); } catch {}
    return;
  }
  connRate.set(ip, rec);
  totalConnections++;
  const s = Session.create(session);
  s.address = address;
  sessions.set(s, { address, connectedAt: Date.now() });
  log(`游戏已连接：${address}（当前会话 ${sessions.size} 个）`);
  session.socket.on("close", (code: number) => {
    const st = s.stats;
    retired.commands += st.commands;
    retired.setblocks += st.setblocks;
    retired.messages += st.messages;
    retired.errors += st.errors;
    sessions.delete(s);
    log(`游戏已断开：${address}（code=${code}，本会话命令 ${st.commands} / 方块 ${st.setblocks}）`);
  });
  session.on("error", (e: any) => logError(`会话错误：${e?.message ?? e}`));
});


/** ===== Java 版通道（供 Fabric mod 连接，纯 JSON，不走基岩加密协议） ===== */
const JAVA_PORT = Number(process.env.FB_JAVA_PORT ?? 0);

class JavaConn {
  stats = { messages: 0, commands: 0, setblocks: 0, errors: 0 };
  authUser: any = null;
  address = "";
  connectedAt = Date.now();
  setting: any = { origin: { x: 0, y: 0, z: 0 }, block: "minecraft:iron_block" };
  session: any;
  gameProps: any = null;
  java = true;
  private pending = new Map<string, (r: any) => void>();
  private seq = 0;

  constructor(private ws: any, user: any) {
    this.authUser = { id: user.id, username: user.username };
    this.session = {
      sendCommand: (cmd: string, cb?: any) => {
        this.sendCommand(cmd).then((r) => {
          if (cb) cb({ body: r });
          return r;
        });
      },
      subscribe: () => {},
      unsubscribe: () => {},
      disconnect: () => { try { this.ws.close(); } catch {} },
    };
    ws.on("message", (data: any) => this.onMessage(data));
    ws.on("close", () => {
      sessions.delete(this as any);
      log(`Java 客户端已断开：${this.address}`);
    });
    ws.on("error", () => {});
  }

  private raw(command: string): Promise<{ statusCode: number; message?: string }> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== 1) return resolve({ statusCode: 1, message: "not connected" });
      const id = "c" + (++this.seq);
      this.stats.commands++;
      const done = (r: any) => {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(r);
      };
      const timer = setTimeout(() => {
        this.stats.errors++;
        done({ statusCode: 1, message: "timeout" });
      }, 8000);
      this.pending.set(id, done);
      try {
        this.ws.send(JSON.stringify({ type: "command", id, command }));
      } catch {
        done({ statusCode: 1, message: "send failed" });
      }
    });
  }

  async sendCommand(command: string): Promise<any> {
    const cmd = String(command).trim();
    if (cmd.startsWith("titleraw") || cmd.startsWith("title ") || cmd.startsWith("tellraw @a")) {
      return { statusCode: 0 };
    }
    if (cmd.startsWith("testforblock ")) {
      const m = cmd.split(/\s+/);
      if (m.length >= 5 && !m[1].startsWith("~")) {
        const r = await this.raw(`execute if block ${m[1]} ${m[2]} ${m[3]} ${m[4]}`);
        return { statusCode: r.statusCode === 0 ? 0 : 1 };
      }
      return { statusCode: 0, position: this.setting.origin };
    }
    const r = await this.raw(cmd);
    if (cmd.startsWith("setblock ")) {
      this.stats.setblocks++;
    }
    return { statusCode: r.statusCode, message: r.message };
  }

  private onMessage(data: any) {
    let msg: any;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    this.stats.messages++;
    if (msg.type === "result" && msg.id) {
      const cb = this.pending.get(String(msg.id));
      if (cb) cb({ statusCode: Number(msg.statusCode ?? 1), message: msg.message });
    } else if (msg.type === "pos") {
      this.setting.origin = {
        x: Math.round(Number(msg.x) || 0),
        y: Math.round(Number(msg.y) || 0),
        z: Math.round(Number(msg.z) || 0),
      };
      this.chat(`§a位置已记录：${this.setting.origin.x}, ${this.setting.origin.y}, ${this.setting.origin.z}`);
    }
  }

  chat(text: string) {
    const clean = String(text).replace(/§[0-9a-fk-or]/gi, "");
    this.raw(`tellraw @s ${JSON.stringify({ text: clean })}`).catch(() => {});
  }

  sendRaw(command: string) {
    this.sendCommand(command).catch(() => {});
  }

  info() {
    return {
      address: this.address,
      connectedAt: this.connectedAt,
      stats: this.stats,
      user: this.authUser?.username,
      java: true,
      gameProps: null,
    };
  }

  run() {
    return { ok: false, error: "Java 通道不支持脚本命令" };
  }

  disconnect() {
    try {
      this.ws.close();
    } catch {}
  }
}

if (JAVA_PORT) {
  const javaServer = new JWS({ port: JAVA_PORT });
  javaServer.on("connection", (ws: any, req: any) => {
    const u = new URL(req.url || "/", "http://localhost");
    const token = u.searchParams.get("token") || "";
    let user: any = null;
    try {
      const db = JSON.parse(fs.readFileSync(process.env.FB_USERS_FILE || "", "utf8"));
      const owner = (db.users || []).find((x: any) => x.id === process.env.FB_OWNER_UID);
      if (owner && owner.panelToken === token && Number(owner.panelTokenExp) > Date.now()) user = owner;
    } catch {}
    if (!user) {
      try { ws.send(JSON.stringify({ type: "error", message: "令牌无效或已过期" })); } catch {}
      ws.close(1008, "unauthorized");
      return;
    }
    const conn = new JavaConn(ws, user);
    conn.address = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    sessions.set(conn as any, { address: conn.address, connectedAt: conn.connectedAt });
    log(`Java 客户端已连接：${conn.address}（用户 ${user.username}）`);
    try { ws.send(JSON.stringify({ type: "ready" })); } catch {}
    conn.chat("§aJava 通道已连接，验证通过。现在可以在网页端开始导入。");
  });
  log(`Java 通道已启动：ws://127.0.0.1:${JAVA_PORT}`);
}

/** ===== 本机控制接口（只监听 127.0.0.1，给网页管理端用） ===== */
function json(res: ServerResponse, code: number, data: unknown) {
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

const control = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname;
  try {
    if (req.method === "GET" && pathname === "/status") {
      const active = activeSession();
      return json(res, 200, {
        app: APP_NAME,
        running: true,
        port: WS_PORT,
        javaPort: JAVA_PORT || null,
        version: WS_VERSION,
        startedAt: STARTED_AT,
        logFile: LOG_FILE,
        totalConnections,
        sessionCount: sessions.size,
        authenticatedSessionCount: [...sessions.keys()].filter((x) => !!x.authUser).length,
        active: active ? { ...active.info(), authenticated: !!active.authUser, username: active.authUser?.username || null } : null,
        sessions: [...sessions.values()].map((meta, i) => {
          const s = [...sessions.keys()][i];
          return { address: meta.address, connectedAt: meta.connectedAt, ...s.info(), authenticated: !!s.authUser, username: s.authUser?.username || null };
        }),
        stats: aggregatedStats(),
        structure: {
          pending: pendingStructure
            ? {
                name: pendingStructure.name,
                size: pendingStructure.size,
                total: pendingStructure.total,
                paletteSize: pendingStructure.paletteSize,
                materials: pendingStructure.materials,
                uploadedAt: pendingUploadedAt,
              }
            : null,
          build: build
            ? {
                name: build.name,
                total: build.total,
                placed: build.placed,
                commands: build.commands,
                startedAt: build.startedAt,
                done: build.done,
                cancelled: build.cancelled,
                verified: build.verified,
                step: build.step,
                stepLabel: build.stepLabel,
                sent: build.sent,
                confirmed: build.confirmed,
                retryRound: build.retryRound,
                retried: build.retried,
                failed: build.failed,
                failedBlocks: build.failedBlocks,
                error: build.error ?? null,
              }
            : null,
          rebuild: { commands: lastFailed.length, blocks: lastFailed.reduce((a, c) => a + c.count, 0) },
          verify: buildVerify,
        },
      });
    }

    if (req.method === "POST" && pathname === "/eval") {
      const body = await readJson(req);
      const code = String(body.code ?? "").trim();
      if (!code) return json(res, 400, { ok: false, error: "code 不能为空" });
      const s = activeSession();
      if (!s) {
        log(`控制台执行失败：没有已连接的游戏（${code}）`);
        return json(res, 200, { ok: false, error: "没有已连接的游戏，先在游戏里 /connect" });
      }
      const t0 = Date.now();
      const r = s.run(code);
      const elapsed = Date.now() - t0;
      if (!r.ok) {
        log(`控制台执行出错：${code} → ${r.error}`);
        return json(res, 200, { ok: false, error: r.error, elapsed, stats: s.stats });
      }
      const p = preview(r.result);
      log(`控制台执行：${code} → ${p.text === "undefined" ? "Success" : p.text}`);
      return json(res, 200, { ok: true, result: p, elapsed, stats: s.stats });
    }

    if (req.method === "POST" && pathname === "/send") {
      const body = await readJson(req);
      const command = String(body.command ?? "").trim();
      if (!command) return json(res, 400, { ok: false, error: "command 不能为空" });
      const s = activeSession();
      if (!s) {
        log(`发送原生命令失败：没有已连接的游戏（${command}）`);
        return json(res, 200, { ok: false, error: "没有已连接的游戏" });
      }
      const requestId = s.sendRaw(command);
      log(`发送原生命令：${command}`);
      return json(res, 200, { ok: true, requestId });
    }

    if (req.method === "POST" && pathname === "/block") {
      const body = await readJson(req);
      const block = String(body.block ?? "").trim();
      if (!block) return json(res, 400, { ok: false, error: "block 不能为空" });
      const s = activeSession();
      if (!s) {
        log(`设置默认方块失败：没有已连接的游戏（${block}）`);
        return json(res, 200, { ok: false, error: "没有已连接的游戏" });
      }
      s.setBlock(block);
      log(`默认方块已改为：${block}`);
      return json(res, 200, { ok: true, block });
    }

    if (req.method === "GET" && pathname === "/ping") {
      return json(res, 200, { ok: true, pid: process.pid, app: APP_NAME });
    }

    // ---- 结构导入：上传解析 ----
    // ---- 像素画：像素矩阵 → 结构（由 /structure/build 直接导入） ----
    if (req.method === "POST" && pathname === "/pixelart/prepare") {
      const body = await readJson(req, 64 << 20);
      const name = String(body.name ?? "pixelart").slice(0, 80) || "pixelart";
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) return json(res, 400, { ok: false, error: "缺少像素数据" });
      const h = rows.length;
      const w = rows.reduce((m: number, r: any) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
      if (!w || !h) return json(res, 400, { ok: false, error: "像素数据为空" });
      if (w > 512 || h > 512) return json(res, 400, { ok: false, error: "像素画尺寸上限 512×512" });
      const blocks: any[] = [];
      const matSet = new Set<string>();
      for (let z = 0; z < h; z++) {
        const row: any[] = Array.isArray(rows[z]) ? rows[z] : [];
        for (let x = 0; x < row.length; x++) {
          const b = row[x];
          if (!b) continue;
          const nameB = String(b);
          blocks.push({ x, y: h - 1 - z, z: 0, block: nameB });
          matSet.add(nameB);
        }
      }
      if (!blocks.length) return json(res, 400, { ok: false, error: "没有可放置的方块" });
      if (blocks.length > STRUCTURE_LIMIT_BLOCKS) {
        return json(res, 200, {
          ok: false,
          error: `像素画太大：${blocks.length} 方块（上限 ${STRUCTURE_LIMIT_BLOCKS}），请减小宽度`,
        });
      }
      pendingStructure = {
        name,
        size: { x: w, y: h, z: 1 },
        blocks,
        total: blocks.length,
        paletteSize: matSet.size,
        skippedAir: w * h - blocks.length,
        materials: [...matSet],
      } as any;
      pendingFormat = ".pixelart";
      pendingUploadedAt = Date.now();
      log(`像素画已生成「${name}」：${w}×${h}，${blocks.length} 方块，${matSet.size} 种`);
      return json(res, 200, {
        ok: true,
        structure: {
          name,
          size: { x: w, y: h, z: 1 },
          total: blocks.length,
          paletteSize: matSet.size,
          materials: [...matSet],
        },
      });
    }

    if (req.method === "POST" && pathname === "/structure/prepare") {
      const body = await readJson(req, 64 << 20);
      const rawFile = String(body.name ?? "structure");
      const extMatch = rawFile.match(/\.(mcstructure|litematic|schem|schematic|nbt)$/i);
      pendingFormat = extMatch ? `.${extMatch[1].toLowerCase()}` : ".mcstructure";
      const rawName = rawFile.replace(/\.(mcstructure|litematic|schem|schematic|nbt)$/i, "").trim();
      const name = (rawName || "structure").slice(0, 80);
      const data = String(body.data ?? "");
      if (!data) return json(res, 400, { ok: false, error: "缺少文件数据" });
      let buf: Buffer;
      try {
        buf = Buffer.from(data, "base64");
      } catch {
        return json(res, 400, { ok: false, error: "文件数据不是合法的 Base64" });
      }
      if (!buf.length) return json(res, 400, { ok: false, error: "文件为空" });
      try {
        const st = parseStructureFile(buf, name);
        if (st.total > STRUCTURE_LIMIT_BLOCKS) {
          return json(res, 200, {
            ok: false,
            error: `结构太大：${st.total} 方块（上限 ${STRUCTURE_LIMIT_BLOCKS}）`,
          });
        }
        pendingStructure = st;
        pendingUploadedAt = Date.now();
        log(
          `已解析结构「${name}」：${st.size.x}×${st.size.y}×${st.size.z}，${st.total} 方块，调色板 ${st.paletteSize}，忽略空气 ${st.skippedAir}`
        );
        return json(res, 200, {
          ok: true,
          structure: {
            name: st.name,
            size: st.size,
            total: st.total,
            paletteSize: st.paletteSize,
            skippedAir: st.skippedAir,
            materials: st.materials,
            bytes: buf.length,
          },
        });
      } catch (e: any) {
        logError(`结构解析失败：${e?.message ?? e}`);
        return json(res, 200, { ok: false, error: `结构解析失败：${e?.message ?? e}` });
      }
    }

    // ---- 结构导入：修补损坏的 .mcstructure ----
    if (req.method === "POST" && pathname === "/structure/repair") {
      const body = await readJson(req, 96 << 20);
      const rawName = String(body.name ?? "structure").replace(/\.mcstructure$/i, "").trim();
      const name = (rawName || "structure").slice(0, 80);
      const data = String(body.data ?? "");
      if (!data) return json(res, 400, { ok: false, error: "缺少文件数据" });
      let buf: Buffer;
      try {
        buf = Buffer.from(data, "base64");
      } catch {
        return json(res, 400, { ok: false, error: "文件数据不是合法的 Base64" });
      }
      if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        return json(res, 200, { ok: false, fixed: false, issues: [], error: "修补功能仅支持 .mcstructure（投影文件本身就是标准格式，不需要修补）" });
      }
      const r = repairMcStructure(buf, name);
      if (!r.ok || !r.parsed || !r.data) {
        logError(`修补结构「${name}」失败：${r.error ?? "未知错误"}${r.issues.length ? `（${r.issues.join("；")}）` : ""}`);
        return json(res, 200, { ok: false, fixed: r.fixed, issues: r.issues, error: r.error ?? "修补失败" });
      }
      pendingStructure = r.parsed;
      pendingUploadedAt = Date.now();
      log(
        `修补结构「${name}」：${r.fixed ? `修复 ${r.issues.length} 处问题` : "文件本来就规范"}，` +
          `尺寸 ${r.parsed.size.x}×${r.parsed.size.y}×${r.parsed.size.z}，${r.parsed.total} 方块`
      );
      return json(res, 200, {
        ok: true,
        fixed: r.fixed,
        issues: r.issues,
        structure: {
          name: r.parsed.name,
          size: r.parsed.size,
          total: r.parsed.total,
          paletteSize: r.parsed.paletteSize,
          skippedAir: r.parsed.skippedAir,
          materials: r.parsed.materials,
          bytes: r.data.length,
        },
        data: r.data.toString("base64"),
      });
    }

    // ---- 结构导入：回读完整性检查（deep=true 更密） ----
    if (req.method === "POST" && pathname === "/structure/verify") {
      const body = await readJson(req);
      const deep = !!body.deep;
      if (!authedSession()) return json(res, 200, { ok: false, error: "游戏会话未验证身份，请先在游戏里发送 --login 终端令牌" });
      if (!lastBuild) return json(res, 200, { ok: false, error: "还没有导入过结构，先导入一次" });
      if (buildVerify && buildVerify.running) return json(res, 200, { ok: false, error: "完整性检查正在进行" });
      if (build && !build.done) return json(res, 200, { ok: false, error: "导入/补建还在进行，先等它完成" });
      verifyStructure(deep).catch((e) => logError(`完整性检查异常：${e?.message ?? e}`));
      return json(res, 200, { ok: true, started: true, deep });
    }

    // ---- 结构导入：只补建上次失败的方块 ----
    if (req.method === "POST" && pathname === "/structure/rebuild") {
      return json(res, 200, rebuildFailedBlocks());
    }

    // ---- 结构导入：移除已解析的结构 ----
    if (req.method === "POST" && pathname === "/structure/clear") {
      const name = pendingStructure?.name;
      pendingStructure = null;
      pendingUploadedAt = 0;
      if (name) log(`已移除待生成的结构「${name}」`);
      return json(res, 200, { ok: true, removed: name ?? null });
    }

    // ---- 结构导入：开始生成 ----
    if (req.method === "POST" && pathname === "/structure/build") {
      const body = await readJson(req);
      return json(res, 200, startStructureBuild(Number(body.offsetY ?? 0)));
    }

    // ---- 结构导入：取消 ----
    if (req.method === "POST" && pathname === "/structure/cancel") {
      return json(res, 200, cancelStructureBuild());
    }

    // 查询玩家：只用无副作用的 querytarget（数据在 body.details 字符串里）
    // 注意：绝对不能用 tp @s ~ ~ ~ 之类兜底——那会把玩家传送一次
    if (req.method === "POST" && pathname === "/player") {
      const s = authedSession();
      if (!s) {
        return json(res, 200, { ok: false, error: "游戏会话未验证身份，请先在游戏里发送 --login 终端令牌" });
      }

      const sendAndWait = (commandLine: string, timeoutMs = 3000): Promise<any> =>
        new Promise((resolve) => {
          let done = false;
          let timer: NodeJS.Timeout;
          const finish = (v: any) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(v);
          };
          timer = setTimeout(() => finish(null), timeoutMs);
          try {
            s.session.sendCommand(commandLine, ({ body }: any) => finish(body));
          } catch {
            finish(null);
          }
        });

      // 解析 querytarget：新版 body.details 是 JSON 字符串，旧版是 body.victim 数组
      const parseTargets = (body: any): any[] => {
        if (!body) return [];
        if (typeof body.details === "string") {
          try {
            const arr = JSON.parse(body.details);
            if (Array.isArray(arr)) return arr;
          } catch {}
        }
        if (Array.isArray(body.victim)) {
          return body.victim.map((v: any) => (typeof v === "object" ? v : { name: String(v) }));
        }
        return [];
      };

      const rawQuery = await sendAndWait("querytarget @p");
      const targets = parseTargets(rawQuery);
      log(
        `querytarget：${targets.length} 个目标` +
          (targets.length ? `，位置 ${JSON.stringify(targets[0]?.position ?? {})}` : `（原始返回：${JSON.stringify(rawQuery)?.slice(0, 200)}）`)
      );
      if (!targets.length) {
        return json(res, 200, { ok: false, error: "游戏没有返回玩家位置" });
      }

      const t = targets[0] ?? {};
      const pos = t.position ?? t.pos ?? {};
      // 玩家名：list 命令无副作用，可取当前玩家名
      let name = "";
      const listBody = await sendAndWait("list");
      if (listBody && typeof listBody.players === "string") {
        name = listBody.players.split(/[,，]/)[0].trim();
      }

      const player = {
        name,
        x: pos.x ?? null,
        y: pos.y ?? null,
        z: pos.z ?? null,
        yRot: t.yRot ?? null,
        dimension: t.dimension ?? null,
        uniqueId: t.uniqueId ?? null,
        entityId: t.id ?? null,
      };
      log(`查询玩家：${player.name || "当前玩家"} @ ${player.x}, ${player.y}, ${player.z}`);
      return json(res, 200, { ok: true, players: [player] });
    }

    return json(res, 404, { ok: false, error: "not found" });
  } catch (e: any) {
    logError(`控制接口错误：${e?.message ?? e}`);
    return json(res, 500, { ok: false, error: String(e?.message ?? e) });
  }
});

control.listen(CONTROL_PORT, "127.0.0.1", () => {
  log(`控制接口已启动：http://127.0.0.1:${CONTROL_PORT}（仅本机）`);
});

process.on("SIGINT", () => {
  log("收到退出信号，关闭服务");
  process.exit(0);
});
