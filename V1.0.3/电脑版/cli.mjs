#!/usr/bin/env node
/* ============================================================
 * CyanQiuper CLI（终端交互版）
 *  - 启动/重启 WS 服务
 *  - 导入结构（.mcstructure / .litematic / .schem / .schematic / .nbt）
 *  - 完整性检查 / 补建 / 取消
 *  - 游戏指令、沙箱代码、状态、日志
 * 用法：node cli.mjs  或双击 qiuper-cli.bat
 * ============================================================ */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CFG_FILE = path.join(ROOT, "qiuper-cli.json");

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  cyan: "\x1b[36m", blue: "\x1b[94m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", gray: "\x1b[90m",
};

const DEFAULT_CFG = {
  wsPort: Number(process.env.FB_WS_PORT || 11451),
  adminPort: Number(process.env.FB_ADMIN_PORT || 11452),
  controlPort: Number(process.env.FB_CONTROL_PORT || 11453),
  offsetY: 0,
  lastFile: "",
};

let cfg = { ...DEFAULT_CFG };
try { cfg = { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(CFG_FILE, "utf8")) }; } catch {}
const saveCfg = () => { try { fs.writeFileSync(CFG_FILE, JSON.stringify(cfg, null, 2)); } catch {} };

const base = () => `http://127.0.0.1:${cfg.controlPort}`;
let child = null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, body) {
  try {
    const r = await fetch(base() + pathname, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    return await r.json().catch(() => ({ ok: false, error: "响应不是 JSON" }));
  } catch (e) {
    return { ok: false, error: "控制接口不可用（WS 服务未启动？）: " + (e && e.message ? e.message : e) };
  }
}

function title() {
  const line = "═".repeat(56);
  console.log(`\n${C.blue}${line}${C.reset}`);
  console.log(`${C.bold}${C.cyan}   CyanQiuper CLI${C.reset} ${C.gray}v1.0 · 基岩版结构导入${C.reset}`);
  console.log(`${C.blue}${line}${C.reset}`);
}

function tip(text) { console.log(`${C.gray}${text}${C.reset}`); }
function ok(text) { console.log(`${C.green}✔ ${text}${C.reset}`); }
function warn(text) { console.log(`${C.yellow}⚠ ${text}${C.reset}`); }
function bad(text) { console.log(`${C.red}✘ ${text}${C.reset}`); }

function hr() { console.log(`${C.gray}${"─".repeat(56)}${C.reset}`); }

/* ---------------- 服务管理 ---------------- */
async function ping() {
  const r = await api("/ping");
  return !r.error;
}

async function startService() {
  if (await ping()) { ok(`WS 服务已在运行（控制端口 ${cfg.controlPort}）`); return true; }
  const tsx = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  if (!fs.existsSync(tsx)) { bad("找不到 tsx（node_modules/tsx），请先 npm install"); return false; }
  tip("启动中…");
  child = spawn(process.execPath, [tsx, path.join(ROOT, "main.ts")], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, FB_WS_PORT: String(cfg.wsPort), FB_CONTROL_PORT: String(cfg.controlPort) },
  });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (await ping()) { ok(`WS 服务已启动：ws://127.0.0.1:${cfg.wsPort}`); return true; }
  }
  bad("启动超时，请看 logs 目录或手动运行");
  return false;
}

async function stopService() {
  if (!(await ping())) { warn("WS 服务未运行"); return; }
  // 通过 eval 结束进程（沙箱里调用 process.exit）
  await api("/eval", { code: "process.exit(0)" });
  await sleep(800);
  ok("已发送停止指令");
}

/* ---------------- 状态 ---------------- */
async function showStatus() {
  const r = await api("/status");
  if (r.error) return bad(r.error);
  hr();
  console.log(`${C.bold}运行状态${C.reset}`);
  console.log(`   WS 端口        ${C.cyan}${r.port}${C.reset}`);
  console.log(`   连接数         ${r.totalConnections ?? 0}（会话 ${r.sessionCount ?? 0}）`);
  console.log(`   当前玩家       ${r.active ? (r.active.username || "未登录") + " · " + r.active.address : C.gray + "无" + C.reset}`);
  if (r.structure?.pending) {
    const p = r.structure.pending;
    console.log(`   已解析结构     ${C.green}${p.name}${C.reset}  ${p.total} 方块 / ${p.size} 字节`);
  } else {
    console.log(`   已解析结构     ${C.gray}未上传${C.reset}`);
  }
  if (r.structure?.build) {
    const b = r.structure.build;
    const pct = b.total ? Math.floor((b.placed / b.total) * 100) : 0;
    const state = b.cancelled ? "已取消" : b.done ? (b.verified ? "已完成" : "已结束（未全部通过）") : "进行中";
    console.log(`   当前导入       ${b.name}  ${b.placed}/${b.total} 方块（${pct}%）`);
    console.log(`   阶段           ${b.stepLabel || "-"}   状态 ${state}`);
    if (b.error) console.log(`   ${C.red}错误           ${b.error}${C.reset}`);
  }
  if (r.structure?.rebuild?.commands) {
    console.log(`   待补建         ${r.structure.rebuild.commands} 条 / ${r.structure.rebuild.blocks} 方块`);
  }
  hr();
}

async function waitBuild() {
  tip("等待导入完成（Ctrl+C 可中断，不会停止游戏内任务）");
  let last = -1;
  for (;;) {
    const r = await api("/status");
    if (r.error) return bad(r.error);
    const b = r.structure?.build;
    if (!b) { warn("没有正在进行的导入"); return; }
    const pct = b.total ? Math.floor((b.placed / b.total) * 100) : 0;
    if (pct !== last) {
      process.stdout.write(`\r   ${C.cyan}${pct}%${C.reset}  ${b.placed}/${b.total} 方块  ${C.gray}${b.stepLabel || ""}${C.reset}    `);
      last = pct;
    }
    if (b.done || b.cancelled) {
      console.log("");
      if (b.verified) ok(`导入完成：${b.name} · ${b.total} 方块`);
      else warn(`导入结束：失败 ${b.failed} 条命令 / ${b.failedBlocks} 方块${b.error ? " · " + b.error : ""}`);
      return;
    }
    await sleep(1000);
  }
}

/* ---------------- 导入 ---------------- */
async function importStructure() {
  if (!(await ping())) { warn("WS 服务未运行，先选 1 启动服务"); return; }
  const def = cfg.lastFile || "";
  const input = await ask(`结构文件路径${def ? `（回车使用 ${def}）` : ""}: `);
  let file = (input || def).trim().replace(/^"|"$/g, "");
  if (!file) return warn("已取消");
  if (!fs.existsSync(file)) return bad(`文件不存在：${file}`);
  const ext = path.extname(file).toLowerCase();
  if (![".mcstructure", ".litematic", ".schem", ".schematic", ".nbt"].includes(ext)) {
    return bad(`不支持的格式：${ext}`);
  }
  cfg.lastFile = file; saveCfg();

  const buf = fs.readFileSync(file);
  const name = path.basename(file);
  tip(`读取 ${name}（${(buf.length / 1024 / 1024).toFixed(2)} MB），上传解析…`);
  const prep = await api("/structure/prepare", { name, data: buf.toString("base64") });
  if (!prep.ok) return bad("解析失败：" + (prep.error || "未知错误"));
  ok(`解析成功：${prep.name} · ${prep.total} 方块 · ${prep.commands ?? "?"} 条命令`);

  const offInput = await ask(`Y 偏移（回车默认 ${cfg.offsetY}）: `);
  const offsetY = Number(offInput || cfg.offsetY) || 0;
  cfg.offsetY = offsetY; saveCfg();

  const build = await api("/structure/build", { offsetY });
  if (!build.ok) return bad("开始导入失败：" + (build.error || "未知错误"));
  ok(`已经开始导入：原点 ${build.origin?.x},${build.origin?.y},${build.origin?.z}`);
  await waitBuild();
}

async function verifyStructure(deep) {
  if (!(await ping())) return warn("WS 服务未运行");
  const r = await api("/structure/verify", { deep });
  r.ok ? ok(`完整性检查已开始${deep ? "（深度）" : ""}：抽查 ${r.planned ?? "?"} 个位置`) : bad("失败：" + (r.error || ""));
}

/* ---------------- 输入 ---------------- */
let rl = null;
let eof = false;
function ask(q) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on("close", () => { eof = true; });
  }
  if (eof) return "";
  return new Promise((res) => rl.question(`${C.gray}${q}${C.reset}`, res));
}

function menu() {
  console.log(`${C.bold}主菜单${C.reset}`);
  const items = [
    ["1", "启动 / 重启 WS 服务"],
    ["2", "导入结构文件"],
    ["3", "查看运行状态"],
    ["4", "完整性检查（快速）"],
    ["5", "完整性检查（深度）"],
    ["6", "补建缺失方块"],
    ["7", "取消当前导入"],
    ["8", "发送游戏指令"],
    ["9", "执行沙箱代码"],
    ["10", "查看最近日志"],
    ["11", "停止 WS 服务"],
    ["0", "退出"],
  ];
  for (const [k, v] of items) console.log(`  ${C.cyan}${k.padStart(2)}${C.reset}. ${v}`);
  hr();
}

async function tailLogs() {
  const dir = path.join(ROOT, "logs");
  if (!fs.existsSync(dir)) return warn("logs 目录不存在");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".log"));
  if (!files.length) return warn("没有日志文件");
  files.sort((a, b) => fs.statSync(path.join(dir, b)).mtimeMs - fs.statSync(path.join(dir, a)).mtimeMs);
  const file = path.join(dir, files[0]);
  const lines = fs.readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
  hr();
  console.log(`${C.gray}${files[0]}（最后 25 行）${C.reset}`);
  console.log(lines.slice(-25).join("\n"));
  hr();
}

/* ---------------- 主循环 ---------------- */
async function main() {
  title();
  menu();
  for (;;) {
    const answer = await ask("请选择: ");
    if (eof && !answer) {
      console.log("\n" + C.gray + "输入结束，退出。" + C.reset);
      return;
    }
    const choice = answer.trim();
    switch (choice) {
      case "1": await startService(); break;
      case "2": await importStructure(); break;
      case "3": await showStatus(); break;
      case "4": await verifyStructure(false); break;
      case "5": await verifyStructure(true); break;
      case "6": {
        const r = await api("/structure/rebuild", {});
        r.ok ? ok("补建已开始") : bad("失败：" + (r.error || ""));
        break;
      }
      case "7": {
        const r = await api("/structure/cancel", {});
        r.ok ? ok("已取消") : bad("失败：" + (r.error || ""));
        break;
      }
      case "8": {
        const cmd = (await ask("游戏指令（可带 /）: ")).trim().replace(/^\//, "");
        if (!cmd) break;
        const r = await api("/send", { command: cmd });
        r.ok ? ok("已发送：" + cmd) : bad("失败：" + (r.error || ""));
        break;
      }
      case "9": {
        const code = (await ask("JS 代码（沙箱）: ")).trim();
        if (!code) break;
        const r = await api("/eval", { code });
        console.log(`${C.gray}${JSON.stringify(r).slice(0, 800)}${C.reset}`);
        break;
      }
      case "10": await tailLogs(); break;
      case "11": await stopService(); break;
      case "0":
      case "q":
        if (rl) rl.close();
        console.log(`${C.gray}再见。${C.reset}`);
        return;
      default:
        warn("无效选项");
    }
    menu();
  }
}

process.on("SIGINT", () => {
  console.log("\n" + C.gray + "已退出（WS 服务如由本程序启动会继续在后台运行）" + C.reset);
  process.exit(0);
});

main().catch((e) => { bad(String(e && e.message ? e.message : e)); process.exit(1); });
