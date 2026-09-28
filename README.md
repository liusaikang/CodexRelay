# CodexRelay

A self-hosted Codex task gateway with MCP tools, HTTP APIs, persistent sessions, bounded concurrency, and an operator console.

将 Codex 接入你的应用：提交问题后立即获得任务 ID，由服务负责排队、执行、会话续接和结果保存。项目说明与 Skills 由 Codex 原生加载，适合代码分析、日志诊断以及可扩展的运维工作流。

## 能做什么

- **接入简单**：`question` 必填，`context`、`sessionId`、`idempotencyKey` 可选。
- **可控执行**：全局并发、等待容量、排队期限、执行超时，同一会话串行。
- **保留记录**：任务、会话、运行配置和可选调用日志保存在文件中，无需外部数据库。
- **便于运维**：账号额度、会话历史、队列、取消、失败重试、调用日志及配置热更新。
- **两种调用方式**：MCP Streamable HTTP / stdio，或普通 HTTP API。

当前面向**单实例、可信调用方**。提交任务时可通过 `sandboxMode` 选择 Codex SDK 原生的 `read-only`、`workspace-write`、`danger-full-access`；省略采用服务默认值，兼容默认值为完整权限。Skills 是行为说明，不是权限隔离。详见 [权限参数](docs/http-api.md#sandboxmode) 与 [安全边界](SECURITY.md)。

## 控制台预览

下图来自真实控制台界面与合成测试数据，不包含真实账号、认证文件或业务记录。

![任务队列](docs/images/console-queue.png)
![会话排查](docs/images/console-conversation.png)

## 本地运行

需要 Node.js 22.12+、Git，以及可用的 Codex 账号或 API 认证。

```sh
npm ci
npm run init:env
npm run build
npm run check:dev
npm run start:dev
```

打开 <http://127.0.0.1:8787/>，开发控制台使用 `admin/admin`。模型认证与控制台登录相互独立，需按 [部署文档](docs/deployment.md) 登录专用 Codex home。`init:env` 创建随机服务 Token 和生产控制台密码，已有 `.env` 不会被覆盖。

开发与生产分别使用 `config/development.yaml` 和 `config/production.yaml`，启动命令为 `npm run start:dev` / `npm run start:prod`。开发数据目录保持固定；生产目录由环境变量指定。配置热更新不改变数据目录。

## Docker Compose

安装 Docker Engine / Docker Desktop（Linux 容器）与 Compose v2。生成 `.env` 后可先使用内置样例工作目录：

```sh
docker compose build
docker compose run --rm codex-mcp codex login --device-auth
docker compose run --rm codex-mcp codex login status
docker compose up -d
```

地址仍为 <http://127.0.0.1:8787/>；控制台密码取自 `.env` 的 `CODEX_CONSOLE_PASSWORD`。容器认证、线程和任务持久化在 `codex-state` 卷中。配置 `CODEX_WORKSPACE_HOST` 可挂载自己的项目与 Skills。远程访问、升级、容器检查和异常恢复见 [部署文档](docs/deployment.md)。

## HTTP 调用

平台后端将环境变量中的服务 Token 放到 `Authorization: Bearer ...` 请求头，向 `POST /v1/tasks` 提交：

```json
{
  "question": "为什么这个示例账号看不到订单？",
  "context": {
    "subject": { "account": "demo-user", "tenantId": "tenant-demo-001" }
  },
  "idempotencyKey": "feedback-demo-001"
}
```

返回 `taskId`、`sessionId`、`status`，每隔 2–5 秒查询 `GET /v1/tasks/{taskId}`。追问携带 `sessionId`；同一次网络请求重发复用原幂等键，新问题使用新键。完整示例见 [HTTP API](docs/http-api.md)。

## MCP 调用

远程地址为 `http://127.0.0.1:8787/mcp`，客户端设置 Bearer Token。先调用 `codex_submit_task`，再使用 `codex_get_task` 查询结果。

| 工具 | 用途 |
| --- | --- |
| `codex_get_service_info` | 执行器、模型和调度参数 |
| `codex_submit_task` | 提交问题或追问 |
| `codex_get_task` | 查询状态、进度及结果 |
| `codex_cancel_task` | 取消排队中或运行中的任务 |
| `codex_list_sessions` | 分页查看会话 |
| `codex_get_session` | 查看会话和任务摘要 |

[MCP 接入指南](docs/mcp.md) 提供客户端代码、stdio 设置和错误处理。

## 扩展到自己的项目

在服务工作目录中放置 `AGENTS.md` 和 `.agents/skills/<name>/SKILL.md`，按 Codex 原生方式配置上游 MCP 工具。调用方不需要传工作目录或模型参数。

```text
your-workspace/
  AGENTS.md
  .agents/skills/log-evidence/SKILL.md
  src/
```

部署设置、模型与推理强度见 [配置说明](docs/configuration.md)。示例目录 `examples/workspace` 只包含合成证据。

## 开发与验证

```sh
npm run verify
npm run release:check
npx playwright install chromium
npm run smoke:browser
```

CI 配置涵盖 Windows、macOS、Linux，以及容器构建检查和 Git 历史秘密扫描。测试使用受控执行器，不消耗真实模型额度。实际验证范围记录在 [验证说明](docs/verification.md)。

## 文档与边界

- [部署与登录](docs/deployment.md) · [MCP](docs/mcp.md) · [HTTP API](docs/http-api.md)
- [架构图](docs/architecture.md) · [调度与恢复](docs/scheduling.md) · [配置](docs/configuration.md)
- [贡献指南](CONTRIBUTING.md) · [安全说明](SECURITY.md)

一个数据目录只能由一个服务实例占用。取消不会撤销已发生的外部操作；重试创建新会话并保留原失败记录。调用日志保留期不负责删除任务历史与 Codex 原生线程。

源码发布前仍需由维护者选择并添加项目许可证；当前 `private: true` 仅防止误发 npm，不代表已经授予开源许可。
