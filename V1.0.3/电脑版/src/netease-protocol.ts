/**
 * 网易版（基岩互通服）协议基线
 *
 * 参考实现：lurete-cn/NTvector（C++ 网易版基岩机器人客户端）
 *   application/application.cpp:
 *     unsigned int MinecraftBedrockProtocolVersion = 898;
 *     std::string  MinecraftBedrockGameVersion   = "1.21.130";
 *   --protocol <ver> 可在启动时覆盖
 *   docs/wiki.md: 1.21.120 协议改动记录（ProtocolVersion=860 时期）
 *
 * 说明：本项目的网易版导入走「机器人事件桥」，真正的封包编解码在机器人端完成；
 *      这里维护的是「协议基线 / 版本兼容判断 / 界面展示」，用于：
 *        1. 启动时打印当前要求的协议版本
 *        2. 和机器人上报的协议版本做兼容检查
 *        3. 控制台展示，版本不匹配时给出明确提示
 */

export const NETEASE_PROTOCOL = {
  /** 目标协议版本（与 NTvector 默认一致） */
  protocolVersion: 898,
  /** 目标游戏版本 */
  gameVersion: "1.21.130",
  /** 仍然允许连接的最低协议（1.21.120） */
  minSupportedProtocol: 860,
  /** 协议参考来源 */
  source: "lurete-cn/NTvector",
} as const;

/** 已知的协议号 → 游戏版本对应关系（NTvector wiki / minecraft-data） */
export const PROTOCOL_VERSION_TABLE: Record<number, string> = {
  860: "1.21.120",
  898: "1.21.130",
};

/** 允许用环境变量覆盖目标协议号（调试/降级用） */
export function effectiveProtocolVersion(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.FB_NETEASE_PROTOCOL || 0);
  if (Number.isFinite(raw) && raw > 0) return Math.trunc(raw);
  return NETEASE_PROTOCOL.protocolVersion;
}

export function gameVersionFor(protocol: number): string {
  return PROTOCOL_VERSION_TABLE[protocol] || NETEASE_PROTOCOL.gameVersion;
}

export type ProtocolCheck = {
  /** ok = 完全匹配；warn = 低于目标但仍在支持范围；error = 过低或未上报 */
  level: "ok" | "warn" | "error";
  expected: number;
  bot: number | null;
  botGameVersion: string | null;
  targetGameVersion: string;
  message: string;
};

/**
 * 检查机器人上报的协议版本是否与基线兼容
 * @param botProtocol 机器人端上报的协议号（没有则为 null）
 * @param botGameVersion 机器人端上报的游戏版本（可选）
 */
export function checkBotProtocol(botProtocol?: number | null, botGameVersion?: string | null): ProtocolCheck {
  const expected = effectiveProtocolVersion();
  const targetGameVersion = gameVersionFor(expected);
  const bot = botProtocol && Number.isFinite(botProtocol) ? Math.trunc(botProtocol) : null;

  if (bot === null) {
    return {
      level: "warn",
      expected,
      bot: null,
      botGameVersion: botGameVersion ?? null,
      targetGameVersion,
      message: `机器人未上报协议版本；本项目基线为 MCBE ${targetGameVersion}（协议 ${expected}，参考 NTvector）`,
    };
  }
  if (bot === expected) {
    return {
      level: "ok",
      expected,
      bot,
      botGameVersion: botGameVersion ?? gameVersionFor(bot),
      targetGameVersion,
      message: `协议匹配：MCBE ${botGameVersion || gameVersionFor(bot)}（协议 ${bot}）`,
    };
  }
  if (bot >= NETEASE_PROTOCOL.minSupportedProtocol) {
    return {
      level: "warn",
      expected,
      bot,
      botGameVersion: botGameVersion ?? gameVersionFor(bot),
      targetGameVersion,
      message:
        `机器人协议 ${bot}（MCBE ${botGameVersion || gameVersionFor(bot)}）低于目标 ${expected}（${targetGameVersion}），` +
        `可能缺少新字段导致被踢；建议把机器人升级到 NTvector 最新版`,
    };
  }
  return {
    level: "error",
    expected,
    bot,
    botGameVersion: botGameVersion ?? null,
    targetGameVersion,
    message:
      `机器人协议 ${bot} 低于最低支持 ${NETEASE_PROTOCOL.minSupportedProtocol}，` +
      `请升级机器人到 MCBE ${targetGameVersion}（协议 ${expected}）`,
  };
}

/** 启动时打印的基线描述 */
export function describeBaseline(): string {
  const v = effectiveProtocolVersion();
  const tag = v === NETEASE_PROTOCOL.protocolVersion ? "" : "（已被 FB_NETEASE_PROTOCOL 覆盖）";
  return `网易协议基线：MCBE ${gameVersionFor(v)} · 协议 ${v}${tag} · 参考 ${NETEASE_PROTOCOL.source}`;
}
