import * as V from "@pureeval/voxel-geometry";
import { Space, setBlocks, Vec3, lift } from "./effect";
import { Sandbox } from "./sandbox";
import { tell_raw } from "./utils";
import { ServerSession } from "mcpews";
import * as fs from "node:fs";
import * as crypto from "node:crypto";

/** UTC+8 时钟（HH:mm:ss） */
function clockUtc8(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(11, 19);
}

type Setting = {
  block: string;
  origin: V.Vec3;
  particle: string;
};

export default class Session {
  session: ServerSession;
  history: Array<string> = [];
  sandbox: Sandbox = new Sandbox({});
  setting: Setting;
  callbacks: { [key: string]: (arg: any) => void } = {};
  /** 运行统计，供网页管理端展示 */
  stats = { messages: 0, commands: 0, setblocks: 0, errors: 0 };
  lastActivity = 0;
  connectedAt = Date.now();
  address = "";
  /** 游戏上报的玩家/设备/版本信息（来自 PlayerMessage / PlayerTravelled 事件） */
  gameProps: any = null;
  gamePropsAt = 0;
  private capturedOnce = false;
  /** 游戏内登录认证：连接后必须 --login 终端令牌 验证 */
  authUser: { id: string; username: string } | null = null;
  authAttempts = 0;
  readonly requireAuth = !!process.env.FB_USERS_FILE;
  readonly ownerUid = process.env.FB_OWNER_UID || "";
  private authTimer: NodeJS.Timeout | null = null;
  constructor(session: ServerSession) {
    this.session = session;
    this.setting = {
      block: "minecraft:iron_block",
      origin: Vec3(0, 0, 0),
      particle: "minecraft:explosion",
    };
    // 新版基岩版要求会话加密完成后才受理任何命令（否则返回「需要加密的会话」），
    // 所以欢迎语、事件订阅、函数加载都必须等加密握手回调后再做。
    const ready = () => {
      this.welcome();
      this.bind_user();
      this.bind_game_info();
      this.load_pure_functions();
      this.load_effect_functions();
      this.startAuth();
    };
    const handshaking = session.enableEncryption(ready);
    if (!handshaking) ready();
  }

  static create(session: ServerSession) {
    return new Session(session);
  }

  welcome() {
    if (this.requireAuth) {
      this.broadcast("欢迎使用 CyanQiuper！请先在聊天框发送 --login 终端令牌 完成验证");
    } else {
      this.broadcast("欢迎使用 CyanQiuper！输入 --help 查看命令，-pos() 定位，-plot(sphere(3,0)) 生成");
    }
  }

  load_pure_functions() {
    this.sandbox.updateEnv({
      ...V.Generator,
      ...V.Exp,
      ...V.Transform,
      ...V.LSystem,
      ...V.IFS,
      ...V.DLA,
      Turtle2D: V.Turtle2D,
      Turtle3D: V.Turtle3D,
      vec3: Vec3,
    });
  }

  load_effect_functions() {
    this.sandbox.updateEnv({
      session: this.session,
      // 方法必须绑定 this：沙箱里是当普通函数调用的，否则 this 为 undefined
      plot: this.plot.bind(this),
      pos: () => {
        this.session.sendCommand("testforblock ~ ~ ~ air", ({ body }) => {
          this.setting.origin = body.position as V.Vec3;
          this.tell_raw(
            `位置已记录：${this.setting.origin.x}, ${this.setting.origin.y}, ${this.setting.origin.z}`
          );
        });
      },
      setBlocks,
      tell_raw: (...message: string[]) => this.tell_raw(...message),
    });
  }

  plot(space: Space, o = this.setting.origin, block = this.setting.block) {
    this.stats.setblocks += space.length;
    this.lastActivity = Date.now();
    return setBlocks(this.session)(block)(V.Transform.move(space, lift(o)));
  }

  /** 执行一段沙箱脚本（聊天命令和控制台共用） */
  run(script: string): { ok: true; result: unknown } | { ok: false; error: string } {
    this.exports();
    this.lastActivity = Date.now();
    try {
      const result = this.sandbox.eval(script);
      this.stats.commands++;
      return { ok: true, result };
    } catch (e) {
      this.stats.errors++;
      return { ok: false, error: String(e) };
    }
  }

  /** 直接向游戏发送原生命令 */
  sendRaw(command: string) {
    this.lastActivity = Date.now();
    return this.session.sendCommand(command);
  }

  info() {
    return {
      address: this.address,
      encrypted: this.session.isEncrypted(),
      connectedAt: this.connectedAt,
      stats: { ...this.stats },
      lastActivity: this.lastActivity,
      game: this.gameInfo(),
      setting: {
        block: this.setting.block,
        origin: {
          x: this.setting.origin?.x ?? 0,
          y: this.setting.origin?.y ?? 0,
          z: this.setting.origin?.z ?? 0,
        },
      },
    };
  }

  /** 记录游戏上报的玩家/设备信息 */
  private captureProps(body: any) {
    const props = body?.properties ?? (body && typeof body === "object" ? body : null);
    if (!props || typeof props !== "object") return;
    // 只认带设备特征的属性，避免把普通聊天内容塞进来
    if (!("Build" in props) && !("Plat" in props) && !("BuildPlat" in props) && !("editionType" in props)) return;
    this.gameProps = props;
    this.gamePropsAt = Date.now();
    this.capturedOnce = true;
  }

  /** 玩家/设备/版本信息（把能读到的字段都整理出来） */
  gameInfo() {
    const p = this.gameProps;
    if (!p) return null;
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        if (p[k] !== undefined && p[k] !== null) return p[k];
        if (p[k.toLowerCase()] !== undefined) return p[k.toLowerCase()];
      }
      return null;
    };
    return {
      name: pick("Sender", "sender"),
      build: pick("Build"),
      platform: pick("Plat"),
      buildPlatform: pick("BuildPlat"),
      edition: pick("editionType"),
      locale: pick("locale"),
      gameMode: pick("PlayerGameMode"),
      dimension: pick("Dim"),
      accountType: pick("AccountType"),
      isTrial: pick("isTrial"),
      vrMode: pick("vrMode"),
      userId: pick("UserId"),
      clientId: pick("ClientId"),
      serverId: pick("ServerId"),
      deviceSessionId: pick("DeviceSessionId"),
      worldSessionId: pick("WorldSessionId"),
      activeSessionId: pick("ActiveSessionID"),
      appSessionId: pick("AppSessionID"),
      multiplayerId: pick("MultiplayerCorrelationId"),
      biome: pick("Biome"),
      networkType: pick("NetworkType"),
      mode: pick("Mode"),
      schemaHash: pick("SchemaCommitHash"),
      treatments: pick("Treatments"),
      updatedAt: this.gamePropsAt,
      raw: p,
    };
  }

  /** 主动抓一次游戏信息：订阅 PlayerTravelled，收到第一个事件就取消订阅 */
  private bind_game_info() {
    const handler = (frame: any) => {
      this.captureProps(frame?.body);
      if (this.capturedOnce) {
        try {
          this.session.unsubscribe("PlayerTravelled", handler);
        } catch {}
      }
    };
    try {
      this.session.subscribe("PlayerTravelled", handler);
    } catch {}
  }


  setBlock(block: string) {
    this.setting.block = block;
  }

  exports() {
    this.sandbox.updateEnv({
      session: this.session,
      setting: this.setting,
    });
  }

  bind_user() {
    let t = this;
    this.session.subscribe("PlayerMessage", ({ body }) => {
      // 旧协议(<=1.0)在 body.message，新协议在 body.properties.Message，两种都兼容
      const b = body as any;
      const message: string = b.message ?? b.properties?.Message;
      if (typeof message !== "string") return;
      this.captureProps(b);
      this.stats.messages++;
      // 实时输出到控制台（MCSManager 终端里能直接看到游戏聊天）
      // 过滤掉我们自己发的 titleraw/actionbar 回显（游戏会把它们当 PlayerMessage 回来）
      const plain = String(message).replace(/§[0-9a-fk-or]/gi, "");
      const isRawText = plain.trim().startsWith("{\"rawtext\"") || plain.trim().startsWith("{ \"rawtext\"");
      // 我们自己发的 tellraw / actionbar 会被游戏回显成 PlayerMessage，直接忽略，避免自触发死循环
      if (isRawText) return;
      if (!isRawText) {
        const sender = String((b.properties?.Sender ?? b.Sender ?? "玩家")).replace(/^§./g, "");
        const masked = /^\s*--login\b/i.test(plain) ? '--login ***' : plain;
        console.log(`[${clockUtc8()}] [聊天] ${sender}: ${masked}`);
      }
      const text = message.trim();

      // ---- 双横线：会话命令（和 - 开头的 JavaScript 区分开）----
      if (text.startsWith("--")) {
        const rawCmd = text.slice(2).trim();
        const cmdParts = rawCmd.split(/\s+/);
        const firstWord = (cmdParts[0] || "").toLowerCase();
        // 先处理登录：未验证前不允许其它命令
        if (firstWord === "login") {
          this.tryLogin(cmdParts.slice(1));
          return;
        }
        if (this.requireAuth && !this.authUser) {
          this.chat("§c请先验证身份：发送 §f--login 终端令牌");
          return;
        }
        const cmd = rawCmd.toLowerCase();
        if (cmd === "stop") {
          this.lastActivity = Date.now();
          this.chat("§e正在断开与 CyanQiuper 的连接…");
          this.chat("§7世界不会受影响，重新 /connect 即可恢复");
          setTimeout(() => {
            try {
              this.session.disconnect();
            } catch {}
          }, 500);
          return;
        }
        if (cmd === "help" || cmd === "?") {
          this.showHelp();
          this.lastActivity = Date.now();
          return;
        }
        this.chat(`§c未知命令：--${cmd || "（空）"}，输入 §f--help §c查看可用命令`);
        return;
      }

      if (this.requireAuth && !this.authUser) {
        this.chat("§c请先验证身份：发送 §f--login 终端令牌");
        return;
      }

      if (text.startsWith("-")) {
        const script = text.substring(1).trim();
        const r = t.run(script);
        if (!r.ok) {
          t.tell_raw(`>> 错误：${r.error}`);
        } else if (r.result === undefined) {
          t.tell_raw(`>> 已执行`);
        } else {
          t.tell_raw(`>> 结果：${r.result}`);
        }
      }
    });
  }

  /** ===== 游戏内登录验证 ===== */
  private authReminder: NodeJS.Timeout | null = null;

  private startAuth() {
    if (!this.requireAuth) {
      this.authUser = { id: this.ownerUid || "local", username: "local" };
      return;
    }
    const prompt = () => {
      if (!this.authUser) {
        this.chat("§e请发送 §f--login 终端令牌 §e完成验证（令牌在用户中心「结构导入终端」里，12 小时有效）");
      }
    };
    prompt();
    // 每 30 秒提示一次，直到验证成功
    this.authReminder = setInterval(prompt, 30000);
    this.authTimer = setTimeout(() => {
      if (!this.authUser) {
        this.chat("§c验证超时，连接已断开。请重新 /connect 后再验证。");
        try { this.session.disconnect(); } catch {}
      }
    }, 10 * 60 * 1000);
  }

  private tryLogin(args: string[]) {
    if (!this.requireAuth) {
      this.chat("§a当前为本地模式，无需验证");
      return;
    }
    if (this.authUser) {
      this.chat("§a你已经验证过了");
      return;
    }
    const token = args.join(" ").trim();
    if (!token) {
      this.chat("§c用法：--login 终端令牌");
      return;
    }
    let users: any[] = [];
    try {
      users = JSON.parse(fs.readFileSync(process.env.FB_USERS_FILE || "", "utf8")).users || [];
    } catch {
      users = [];
    }
    const owner = this.ownerUid ? users.find((u) => u.id === this.ownerUid) : null;
    const matched = users.find((u) => u.panelToken === token);
    let ok = false;
    if (owner && matched && owner.id === matched.id) {
      ok = true;
    } else if (owner && owner.panelToken === token) {
      ok = true;
    }
    if (!ok) {
      this.authAttempts++;
      const left = Math.max(0, 5 - this.authAttempts);
      this.chat(`§c终端令牌无效（还可尝试 ${left} 次），请到用户中心复制最新令牌`);
      if (this.authAttempts >= 5) {
        this.chat("§c错误次数过多，连接已断开");
        try { this.session.disconnect(); } catch {}
      }
      return;
    }
    const ownerUser = owner!;
    if (!ownerUser.panelTokenExp || ownerUser.panelTokenExp < Date.now()) {
      this.chat("§c终端令牌已过期（12 小时有效），请在用户中心刷新令牌");
      return;
    }
    this.authUser = { id: ownerUser.id, username: ownerUser.username };
    if (this.authTimer) { clearTimeout(this.authTimer); this.authTimer = null; }
    if (this.authReminder) { clearInterval(this.authReminder); this.authReminder = null; }
    this.chat(`§a验证成功，欢迎 ${ownerUser.username}！现在可以上传结构并开始导入了。`);
    console.log(`[${clockUtc8()}] [认证] 会话已绑定用户 ${ownerUser.username}（终端令牌）`);
  }

  /** 发送一条不带时间戳的聊天消息 */
  chat(message: string) {
    const rawtext = JSON.stringify({ rawtext: [{ text: message }] });
    this.session.sendCommand(`tellraw @s ${rawtext}`);
  }

  /** --help 帮助 */
  showHelp() {
    const lines = [
      "§e§lCyanQiuper 帮助",
      "§7· §f-<代码> §7— 执行 JavaScript，例如 §f-1+1 §7、§f-Date.now()",
      "§7· §f-pos() §7— 记录当前位置作为原点",
      "§7· §f-plot(sphere(3,0)) §7— 生成半径 3 的球（默认铁块）",
      "§7· §f-plot(sphere(3,0), undefined, \"minecraft:gold_block\") §7— 指定方块",
      "§7· §f-setting.block = \"minecraft:quartz_block\" §7— 改默认方块",
      "§7· §f--stop §7— 断开与本服务器的连接",
      "§7· §f--help §7— 显示这条帮助",
      "§7· §f导入 .mcstructure §7— 在后台管理页「导入结构」上传，进度显示在物品栏上方",
      "§7· 其它可用：§fcircle/torus/lsystem/simple_equation/array_gen/move/scale/Turtle2D §7…",
    ];
    for (const line of lines) this.chat(`  ${line}`);
  }

  tell_raw(...message: string[]) {
    this.session.sendCommand(tell_raw("@s", ...message.map((m) => `§e${m}`)));
  }

  broadcast(...message: string[]) {
    this.session.sendCommand(tell_raw("@a", ...message.map((m) => `§e${m}`)));
  }
}
