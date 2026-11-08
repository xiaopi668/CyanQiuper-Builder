# CyanQiuper 开发文档

本文档面向二次开发/维护者，说明项目结构、运行时架构、数据模型、HTTP 接口与关键设计决策。

## 1. 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Node.js ≥ 20（ESM，`tsx` 直接跑 TS，无构建步骤） |
| 协议 | 基岩版 WebSocket（`mcpews` 4.x，协议版本 `FB_WS_VERSION`，默认 17104896 = 1.21.x） |
| HTTP | 原生 `node:http`，无框架（`site-server.ts` / `admin-server.ts`） |
| 存储 | JSON 文件（`site-data/*.json`），无数据库 |
| 前端 | 原生 HTML/CSS/JS，无构建（`site/`、`admin/`） |
| 进程 | 每用户独立 `main.ts` 实例（`systemd-run --scope`，Windows/无 systemd 时直接 spawn） |

## 2. 目录结构

```
main.ts              WS 服务：连接、结构导入、校验补建、HUD
site-server.ts       官网 + 用户中心 + 终端 + 计费 + 插件市场（HTTPS 反代后端）
admin-server.ts      本地管理面板（单实例模式）
netease-service.ts   网易版导入服务（可选，依赖外部机器人事件桥）
src/
  session.ts         会话、--login 认证、连接限流
  structure.ts       结构解析/命令生成
  structure-repair.ts 损坏 .mcstructure 修补
  formats.ts         多格式识别
  nbt.ts / nbt-write.ts / java-nbt.ts  NBT 读写
  sandbox.ts         eval 沙箱
  effect.ts / utils.ts
admin/  site/        前端静态资源
tools/               部署/测试/补丁脚本（开发用，不参与运行）
site-data/           运行时数据（用户、订单、实例、日志、市场、密钥）
logs/                运行日志
```

## 3. 运行时架构

```
浏览器 ──HTTPS──> nginx ──> site-server (11455)
                               │  spawn / systemd-run --scope
                               ▼
                         main.ts 实例（每用户）
                          WS 端口 12000+idx（玩家 /connect）
                          控制端口 13000+idx（仅本机 HTTP，site-server 调用）
玩家 ──/connect ws──> main.ts ──命令流──> 游戏服务器
```

- **控制接口**：`main.ts` 在本机暴露 `/status`、`/structure/prepare|build|cancel|verify|clear` 等，仅 `127.0.0.1`。
- **实例隔离**：Linux 用 `systemd-run --scope --unit=cq-inst-<uid8>`，站点重启不会杀掉进行中的导入；无 systemd 平台直接 `spawn(detached)`。
- **会话认证**：玩家连接后在聊天栏发 `--login <终端令牌>`；令牌 12 小时有效，随实例启动生成，过期自动断开。
- **限流**：同一 IP 每分钟 5 次 WS 连接，超限封 10 小时。
- **导入队列**：全局 `FB_IMPORT_LIMIT`（默认 3）并发；订阅用户优先级高可插队，不抢占进行中任务；每 3 秒轮询实例状态释放名额。

## 4. 数据模型（site-data/）

| 文件 | 内容 |
|---|---|
| `users.json` | 用户（scrypt 密码、订阅、额度、订单、网易账号密文、已购插件） |
| `secret` | 站点密钥（Cookie 签名、AES 密钥派生），自动生成 |
| `instances.json` | 用户 → 实例端口/PID/unit |
| `market.json` | 插件市场（名称/价格/状态/作者/销量） |
| `plugins/<id>.lua` | 插件代码（0600） |
| `pay.json` | 易支付配置（pid/key/api），可选 |
| `smtp.json` | QQ 邮箱 SMTP 配置，可选 |
| `users/<uid>/logs/` | 每用户实例日志 |
| `users/<uid>/structure/` | 上次准备的结构 |

规则：任何凭据（支付密钥、SMTP 授权码、网易 cookie）只存本机，权限 600，不写日志。

## 5. HTTP 接口（site-server）

公开：
- `GET /api/site/status`、`GET /api/site/config`（邮箱验证/支付开关）
- `POST /api/auth/register|login|logout|send-code`，`POST /api/auth/password`
- `GET /api/pay/plans`、`GET /api/market/list`

登录后（`cq_user` Cookie，7 天）：
- `GET /api/my/status`（实例/队列/面板令牌/网易账号）
- `POST /api/my/instance` / `POST /api/my/instance/stop`
- `POST /api/my/panel-unlock`（密码解锁面板，12 小时 `cq_panel` Cookie）、`GET /api/my/panel-auth`、`POST /api/my/panel-lock`
- `GET|POST|DELETE /api/my/netease`（网易账号密文存储，AES-256-GCM）
- `POST /api/my/structure/prepare|build|cancel|clear|verify`（build 满员返回 `queued`）
- `GET /api/my/queue`、`GET /api/my/logs`
- `GET|POST|DELETE /api/market/mine|upload|buy|download`
- 支付：`POST /api/pay/create`、`GET /api/pay/return`（302 到 /pay）、`POST /api/pay/notify`（异步回调，验签后发放订阅/额度/插件）

管理（`FB_MARKET_ADMIN_TOKEN`）：
- `GET /api/market/admin/list?token=`
- `POST /api/market/admin/review?token=`（approve/reject）

## 6. 关键设计

- **面板二次验证**：进 `/import` 需账户密码（scrypt 校验），通过后发 12 小时 HttpOnly `cq_panel`；游戏内仍用终端令牌。
- **配额**：免费导入 10 次（终身）；订阅期内不限次；额度包累加。
- **计费**：16 个套餐（PRO/Plus/MAX/ULTRA × 1/3/6/12 月）+ 额度包；订阅按 `subExpiresAt` 续期。
- **插件市场**：上传即待审，审核通过才公开；价格 0~500；付费订单复用支付回调（`planId=plugin:<id>`）；下载鉴权=已购/作者/免费。
- **网易账号**：只存用户自己的 cookie（加密），账号市场不做；每用户实例隔离。

## 7. 本地开发

```bash
npm install
npm run site       # 站点（默认 127.0.0.1:11455）
npm run ws         # 单独跑一个 WS 实例（调试）
npm run admin      # 本地管理面板
FB_EMAIL_VERIFY=0 npm run site   # 免邮箱验证注册（本地调试）
```

调试技巧：
- `tools/cdp-*.mjs`：headless Chrome 截图/点检页面
- `tools/patch-*.mjs`：幂等补丁脚本（改代码/页面）
- 站点日志：`logs/site.log`；实例日志：`site-data/users/<uid>/logs/`

## 8. 部署

- systemd：`cyanqiuper-site.service`（站点）、`cyanqiuper.service`（WS 单实例）、`cyanqiuper-netease.service`（可选）
- nginx：443 → `127.0.0.1:11455`；WS 端口直连玩家（需安全组/防火墙放行）
- 环境变量：`FB_SITE_PORT/HOST`、`FB_LOG_DIR`、`FB_CONTROL_PORT`、`FB_EMAIL_VERIFY`、`FB_IMPORT_LIMIT`、`FB_MARKET_ADMIN_TOKEN`、`FB_NETEASE_*`

## 9. 代码约定

- 所有改动优先“打补丁脚本 + 语法检查”（`esbuild transformSync`）后再部署
- 页面统一 `style-v2.css` + `align.css`（主题/间距 token），新增页面必须包含主题初始化脚本与主题切换按钮
- 图标一律内联 SVG（不用 emoji），颜色使用 CSS 变量
- 任何新增接口先鉴权（`currentUser`）再处理；管理接口单独 token
- 数据写入统一 `writeJson`（原子写 + 0600）

## 10. 扩展建议

- 插件执行沙箱：在 `src/sandbox.ts` 增加只读 API 白名单，禁止 `network/fs/process`
- 订单/提现：可新增 `site-data/payouts.json` 与后台结算页
- 队列持久化：将 `IMPORT_QUEUE` 落盘，站点重启后恢复
- 网易多账号：每账号独立机器人目录 + 独立 `netease-service` 端口（124xx）
