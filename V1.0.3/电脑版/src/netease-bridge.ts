/**
 * 网易版（基岩互通服）事件桥客户端
 *
 * 通过 UNIX 域套接字连接网易机器人客户端（libclient.so + main.py）的事件桥：
 * - NDJSON 协议，一行一条 JSON
 * - 首帧鉴权：{"type":"auth","token":"..."}
 * - 指令：{"type":"command","cmd":"command","args":{"text":"/list"},"id":"..."}
 * - 事件：{"type":"event","event":"on_text","fields":{...}}
 *
 * 只依赖 Node 内置模块。
 */
import * as net from "node:net";
import { NETEASE_PROTOCOL, effectiveProtocolVersion, gameVersionFor } from "./netease-protocol";
import * as fs from "node:fs";
import * as path from "node:path";

export type BridgeResult = {
  ok: boolean;
  data?: any;
  error?: string;
  error_code?: string;
};

export type BridgeEvent = {
  type: "event";
  event: string;
  fields?: Record<string, any>;
  ts?: number;
};

export type NeteaseBridgeOptions = {
  socketPath: string;
  token?: string;
  onEvent?: (ev: BridgeEvent) => void;
  onLog?: (line: string) => void;
};

export class NeteaseBridge {
  private opts: NeteaseBridgeOptions;
  private sock: net.Socket | null = null;
  private buf = "";
  private seq = 0;
  private pending = new Map<string, { resolve: (r: BridgeResult) => void; timer: NodeJS.Timeout }>();
  private authed = false;
  private connected = false;
  private closing = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private subscribed = new Set<string>();
  private lastError = "";
  /** 机器人上报的协议版本 / 游戏版本（用于兼容检查） */
  private botProtocol: number | null = null;
  private botGameVersion: string | null = null;

  constructor(opts: NeteaseBridgeOptions) {
    this.opts = opts;
  }

  get isConnected(): boolean {
    return this.connected && this.authed;
  }

  get error(): string {
    return this.lastError;
  }

  /** 机器人上报的协议信息 */
  get protocol(): { version: number | null; gameVersion: string | null; expected: number } {
    return {
      version: this.botProtocol,
      gameVersion: this.botGameVersion,
      expected: effectiveProtocolVersion(),
    };
  }

  connect(): void {
    if (this.closing) return;
    const s = net.connect({ path: this.opts.socketPath });
    this.sock = s;
    s.setEncoding("utf8");
    s.on("connect", () => {
      this.connected = true;
      this.buf = "";
      this.log(`已连接事件桥：${this.opts.socketPath}`);
    });
    s.on("data", (chunk: string) => {
      this.buf += chunk;
      let idx: number;
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (line) this.handleLine(line);
      }
    });
    s.on("error", (e: any) => {
      this.lastError = String(e?.message ?? e);
      this.log(`事件桥错误：${this.lastError}`);
    });
    s.on("close", () => {
      this.connected = false;
      this.authed = false;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, error: "事件桥已断开" });
      }
      this.pending.clear();
      if (!this.closing) {
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    });
  }

  close(): void {
    this.closing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.sock?.destroy();
    } catch {}
  }

  private log(msg: string) {
    this.opts.onLog?.(msg);
  }

  private handleLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.type === "hello" || msg.type === "auth") {
      if (typeof msg.protocolVersion === "number" || typeof msg.protocol === "number") {
        this.botProtocol = Number(msg.protocolVersion ?? msg.protocol);
        this.botGameVersion = typeof msg.gameVersion === "string" ? msg.gameVersion : gameVersionFor(this.botProtocol);
        this.log(`机器人协议：${this.botProtocol}（MCBE ${this.botGameVersion}）`);
      }
      if (msg.type === "auth") {
        this.send({
        type: "auth",
        token: this.opts.token ?? "",
        client: "CyanQiuper",
        // 协议基线（参考 NTvector：898 / 1.21.130）；老版本机器人可忽略这两个字段
        protocolVersion: effectiveProtocolVersion(),
        gameVersion: gameVersionFor(effectiveProtocolVersion()),
      });
      }
      // 已订阅的事件重新订阅
      for (const id of this.subscribed) {
        this.send({ type: "subscribe", events: ["*"], id });
      }
      return;
    }
    if (msg.type === "auth_ok") {
      this.authed = true;
      if (typeof msg.protocolVersion === "number" || typeof msg.protocol === "number") {
        this.botProtocol = Number(msg.protocolVersion ?? msg.protocol);
        this.botGameVersion = typeof msg.gameVersion === "string" ? msg.gameVersion : gameVersionFor(this.botProtocol);
        this.log(`机器人协议：${this.botProtocol}（MCBE ${this.botGameVersion}）`);
      }
      this.log("事件桥鉴权通过");
      for (const id of this.subscribed) {
        this.send({ type: "subscribe", events: ["*"], id });
      }
      return;
    }
    if (msg.type === "auth_fail") {
      this.lastError = "事件桥 token 无效";
      this.log(this.lastError);
      try {
        this.sock?.destroy();
      } catch {}
      return;
    }
    if (msg.type === "event") {
      this.opts.onEvent?.(msg as BridgeEvent);
      return;
    }
    // 指令回执
    const id = msg.id;
    if (id && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(msg as BridgeResult);
    }
  }

  private send(obj: any) {
    try {
      this.sock?.write(JSON.stringify(obj) + "\n");
    } catch {}
  }

  /** 发一条指令并等待回执 */
  request(cmd: string, args: Record<string, any> = {}, timeoutMs = 15000): Promise<BridgeResult> {
    if (!this.sock || !this.authed) return Promise.resolve({ ok: false, error: "事件桥未连接" });
    const id = `c${++this.seq}`;
    return new Promise<BridgeResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `指令超时：${cmd}` });
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send({ type: "command", cmd, args, id });
    });
  }

  /** 发指令不等待回执（异步通道） */
  requestNoWait(cmd: string, args: Record<string, any> = {}): void {
    this.send({ type: "command", cmd, args, id: `n${++this.seq}` });
  }

  /** 订阅事件（重连后自动恢复） */
  subscribeEvents(id = "sub-all"): void {
    this.subscribed.add(id);
    if (this.authed) this.send({ type: "subscribe", events: ["*"], id });
  }

  /** 执行一条原版指令（前面自动补 /），等回执 */
  async command(text: string, timeoutMs = 15000): Promise<BridgeResult> {
    return this.request("command", { text: text.startsWith("/") ? text : `/${text}` }, timeoutMs);
  }

  /** 执行原版指令，不等回执 */
  commandNoWait(text: string): void {
    this.requestNoWait("command_nowait", { text: text.startsWith("/") ? text : `/${text}` });
  }

  /** 机器人已确认的坐标 */
  async getPosition(): Promise<{ x: number; y: number; z: number } | null> {
    const r = await this.request("pos", {}, 6000);
    const d = r.ok ? r.data : null;
    if (!d || typeof d.x !== "number") return null;
    return { x: d.x, y: d.y, z: d.z };
  }

  async identity(): Promise<any | null> {
    const r = await this.request("identity", {}, 6000);
    return r.ok ? r.data : null;
  }

  async players(): Promise<any | null> {
    const r = await this.request("players", {}, 6000);
    return r.ok ? r.data : null;
  }

  /** 读某个位置的方块（本地缓存，仅对本客户端 set_block 过的方块有名字） */
  async getBlock(x: number, y: number, z: number): Promise<any | null> {
    const r = await this.request("get_block", { x, y, z }, 6000);
    return r.ok ? r.data : null;
  }

  /** 健康检查：socket 文件是否存在且可连 */
  static socketExists(p: string): boolean {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  }
}

/** 读取配置里的桥接参数（环境变量优先） */
export function resolveBridgeOptions(): { socketPath: string; token: string } | null {
  const socketPath = process.env.FB_NETEASE_SOCKET || "";
  if (!socketPath) return null;
  const token = process.env.FB_NETEASE_TOKEN || "";
  return { socketPath, token };
}
