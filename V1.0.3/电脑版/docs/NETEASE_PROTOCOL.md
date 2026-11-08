# 网易版协议基线（对齐 NTvector）

> 参考项目：[lurete-cn/NTvector](https://github.com/lurete-cn/NTvector)（C++17，网易版基岩机器人客户端）
> 更新日期：2026-11-07

## 1. 基线版本

NTvector 的默认协议常量（`application/application.cpp`）：

```cpp
unsigned int MinecraftBedrockProtocolVersion = 898;
std::string  MinecraftBedrockGameVersion     = "1.21.130";
```

启动时可用 `--protocol <ver>` 覆盖。

所以本项目网易版侧的基线同步为：

| 项 | 值 |
|---|---|
| 目标游戏版本 | **MCBE 1.21.130** |
| 目标协议号 | **898** |
| 最低兼容协议 | 860（1.21.120） |
| 参考来源 | `lurete-cn/NTvector` |

## 2. 本项目里的落地

### 2.1 协议常量模块
新增 `src/netease-protocol.ts`：

- `NETEASE_PROTOCOL`：协议号、游戏版本、最低兼容版本、来源
- `PROTOCOL_VERSION_TABLE`：860 → 1.21.120，898 → 1.21.130
- `effectiveProtocolVersion()`：读取 `FB_NETEASE_PROTOCOL` 环境变量覆盖
- `checkBotProtocol(botProtocol, botGameVersion)`：返回 `ok / warn / error` 与提示文案
- `describeBaseline()`：启动日志用

### 2.2 事件桥握手带版本信息
`src/netease-bridge.ts` 鉴权帧现在是：

```json
{
  "type": "auth",
  "token": "...",
  "client": "CyanQiuper",
  "protocolVersion": 898,
  "gameVersion": "1.21.130"
}
```

- 老版本机器人忽略未知字段即可，向后兼容
- 机器人若在 `hello` / `auth_ok` 里回报 `protocolVersion` / `gameVersion`，桥会记录并在控制台展示

### 2.3 服务端状态与日志
`netease-service.ts`：

- 启动日志：`网易协议基线：MCBE 1.21.130 · 协议 898 · 参考 lurete-cn/NTvector`
- `GET /status` 新增 `protocol` 字段：

```json
{
  "level": "ok | warn | error",
  "expected": 898,
  "bot": 898,
  "botGameVersion": "1.21.130",
  "targetGameVersion": "1.21.130",
  "minSupported": 860,
  "source": "lurete-cn/NTvector",
  "message": "协议匹配：MCBE 1.21.130（协议 898）"
}
```

### 2.4 控制台展示
网易版页面状态行会显示：

```
事件桥已连接 · 机器人 xxx · 服务器 x.x.x.x:xxxx · 协议 898（1.21.130）
事件桥未连接 · 协议基线 898（1.21.130）
```

版本偏低时追加 `⚠ 协议偏低`，过低时 `⚠ 协议过低`。

## 3. 与 NTvector 的下游字段变化（记录）

NTvector 的 `docs/wiki.md` 记录了 1.21.120 起的协议字段变化，其中对「指令/命令方块」相关最影响自动化的是：

- **CommandBlockUpdate 必须带 `filtered_name`**，位置在 `name` 之后、`should_track_output` 之前
  - 缺失 → 服务端解析越界 → 踢出
- 结构化协议事件：`engine.register_protocol_event(id, cb, False)`
- `CorrectPlayerMovePrediction`（1.21.120）字段顺序有变化

本项目通过机器人事件桥执行**原版指令**（`/fill`、`/setblock`、`/tp` 等），不自行封包，所以上述变化由**机器人端**承担；我们要保证的是：
1. 机器人端为支持 1.21.130 / 898 的版本（建议直接使用 NTvector 最新 Release）
2. 本服务基线与之匹配（默认已匹配）

## 4. 环境变量

| 变量 | 说明 |
|---|---|
| `FB_NETEASE_PROTOCOL` | 覆盖目标协议号（调试/降级用），如 `860` |
| `FB_NETEASE_SOCKET` | 机器人事件桥 socket 路径 |
| `FB_NETEASE_TOKEN` | 事件桥 token |
| `FB_NETEASE_RATE` | 指令限速（条/秒），默认 5 |
| `FB_NETEASE_VERIFY_SAMPLE` | 回读采样点数，默认 120 |

## 5. 升级检查清单

1. 机器人端升级到支持 **MCBE 1.21.130（协议 898）**
2. 启动后看日志：`网易协议基线：MCBE 1.21.130 · 协议 898`
3. 控制台「网易版」页状态行确认协议显示
4. 若显示 `⚠ 协议偏低/过低`：升级机器人端，或临时 `FB_NETEASE_PROTOCOL=860` 降级排查
