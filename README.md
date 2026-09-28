# CodexRelay

面向可信业务后端的**原生 Codex SDK 任务网关**。通过 HTTP 或 MCP 提交问题，网关负责认证、排队、并发、会话、取消、超时和结果持久化；Codex 以完整本地执行、网络和实时 Web 搜索能力处理任务，并按原生规则使用项目说明、skills 和 MCP 工具。

网关不维护 capability 路由，不扫描或拼接 skill 内容，也不按问题选择 skill。一个实例使用一个共享 Token，面向同一可信后端域，不提供复杂 RBAC 或多租户隔离。

当前实现包括原生 SDK 执行、HTTP/MCP/stdio 接入和示例客户端。测试覆盖 SDK 替身、HTTP、MCP、stdio、控制台登录与调度恢复；部署与真实执行的证据及限制见 [验收记录](docs/verification.md)。

## 核心约定

- 请求只必填 `question`；可选 `context`、`sessionId`、`idempotencyKey`。
- 工作目录、模型和推理强度由服务配置统一控制，不接受调用方覆盖。`context` 是最大 16 KiB 的 JSON 对象，作为本次任务的参考数据保存并交给 Codex。
- 默认最多并发 10 个任务、等待 100 个任务，执行超时 600 秒；同会话始终串行。
- 执行固定 `danger-full-access`、approval `never`、network enabled、实时 Web 搜索开启。API 不能覆盖；调用方通过接入鉴权、部署账户、容器和外部系统凭据控制实际边界。
- 新任务和会话记录使用 `version: 2`。开发环境固定保存在 `data/native-logs-preview`，生产环境由 `CODEX_DATA_DIR` 指定独立目录；切换环境不会搬迁数据。
- HTTP、MCP Streamable HTTP 与 stdio 共享任务语义。HTTP/MCP 使用 Bearer Token，stdio 依赖本机进程权限。

## 启动

需要 Node.js 22.12+。在仓库根目录执行，Windows PowerShell 可使用 `npm.cmd`：

```sh
npm ci
npm run init:env
npm run build
npm run check:dev
npm run start:dev
```

`npm start` 和旧命令 `npm run start:env` 均等同于 `npm run start:dev`。生产环境先在 `.env` 中设置独立的 `CODEX_DATA_DIR`、`CODEX_INVOCATION_LOG_DIR`、`CODEX_HOME`、`CODEX_WORKSPACE`、`CODEX_CONSOLE_USERNAME`、`CODEX_CONSOLE_PASSWORD`、`CODEX_PUBLIC_HOST` 和 `CODEX_PUBLIC_ORIGIN`，然后运行 `npm run check:prod` 与 `npm run start:prod`；Docker 使用同一份生产配置。不要同时启动共用同一目录的实例。详见 [部署说明](docs/deployment.md)。`init:env` 生成服务访问令牌；模型认证另用 `CODEX_API_KEY` 或专用 Codex home 登录。API Key、代理和远端工具凭据只由部署环境注入，不写入仓库。

`runner: codex` 使用真实模型并消耗额度；`runner: demo` 仅用于离线链路演示，不验证真实模型、原生 skill 发现或沙箱权限。可使用 `config/demo.yaml` 启动 demo。安装依赖不要省略 SDK 所需的平台可选依赖。

开发环境默认地址：控制台 `http://127.0.0.1:8787/`，HTTP API `http://127.0.0.1:8787/v1/`，MCP `http://127.0.0.1:8787/mcp`，健康检查 `http://127.0.0.1:8787/healthz`。控制台首次访问跳转登录页；开发环境示例账号为 `admin/admin`，由 `config/development.yaml` 的 `server.consoleAuth` 配置，不能对外使用。生产环境账号密码必须从环境变量提供。登录后可查看额度、提交任务、分析调用日志并调整可热更新的运行参数；覆盖值持久化在 `dataDir/runtime-settings.json`。端口、目录和凭证仍只通过部署配置调整，详见 [控制台运行配置](docs/configuration.md#控制台运行配置)。浏览器使用独立会话 Cookie，不接收服务 Bearer Token。平台后端及 MCP 仍使用 Bearer Token。

两套固定配置均启用调用日志，按日期和任务保存 JSON，保留 30 天。关闭日志不影响核心任务持久化。配置、统计口径及数据保留规则见 [调用日志配置](docs/configuration.md#调用日志)。

## 提交与追问

最小请求，发送到 `POST /v1/tasks`，请求头使用 `Authorization: Bearer <服务令牌>`：

```json
{
  "question": "请分析样例日志中的订单查询失败，给出证据和不确定性。"
}
```

可信后端可以附加结构化业务上下文：

```json
{
  "question": "为什么这个账号看不到订单？",
  "context": {
    "subject": {
      "account": "demo-user",
      "tenantId": "tenant-demo-001"
    }
  },
  "idempotencyKey": "feedback-demo-001"
}
```

返回 `taskId` 用来查询结果，`sessionId` 用来追问。追问提交新问题及已有 `sessionId`；新问题使用新幂等键，重试同一次提交复用原键及参数。不要向普通用户浏览器暴露共享服务 Token。

服务信息入口为 `GET /v1/info` 和 `codex_get_service_info`，不是项目或 skill 清单。MCP 保持六个工具，完整字段见 [接口文档](docs/api.md)。

调度采用有界接收、持久化队列、全局并发和同会话串行。支持排队过期、前序失败后的确认继续及异常锁检查，详见 [任务调度与恢复](docs/scheduling.md)。当前为单实例产品，不支持共享数据目录的多副本部署。

## 原生项目说明与 Skills

示例工作目录约定：

```text
examples/workspace/
  AGENTS.md
  .agents/skills/
    log-evidence/
      SKILL.md
```

项目说明放在配置项 `codex.defaultWorkingDirectory` 对应目录的 `AGENTS.md`，原生 skill 放在其 `.agents/skills/<名称>/SKILL.md`，无需网关注册。仓库示例分别位于 `examples/workspace/AGENTS.md` 和 `examples/workspace/.agents/skills/log-evidence/SKILL.md`。

目录名是 `.agents`，不是 `.agent`。仓库级发现以任务工作目录及其到仓库根目录的祖先路径为范围，不会因为某个目录位于 service 源码树里就任意遍历它。详见 [官方 Build skills](https://learn.chatgpt.com/docs/build-skills)。

上游 MCP 由管理员在专用 `codex.home/config.toml` 中按 Codex 原生方式配置。服务 YAML 不承载上游 MCP 定义；上游工具和凭据具有什么权限，由调用方及部署管理员决定，网关不再裁剪。

## 部署与迁移

新配置只围绕 `dataDir`、`server`、`tasks`、`runner`、`codex` 组织，不再使用 `projects`、`capabilities`、`promptFile`、`skillFiles` 或 `mcpServers`。完整样例见 [配置文档](docs/configuration.md)。

默认新目录不会自动汇总旧数据目录。需要查询旧 v1 数据时，按 [运维与迁移](docs/operations.md) 保留并接入旧存储；不得将旧 queued 当作新任务恢复执行。

示例客户端使用 `--context` 传入可选 JSON 对象，保留 `--inline-example` 用于合成证据直传；完整调用方式见 [部署与接入](docs/deployment.md)。

Docker 文件与配置已迁移，但尚未实跑；镜像、挂载、网络和目标宿主能力需单独验收。发布前还应执行 `npm run release:check` 并审查实际输出，不能以测试通过代替部署验收。

进一步阅读：[架构](docs/design.md)、[实施与验收计划](docs/implementation-plan.md)、[安全边界](SECURITY.md)、[贡献指南](CONTRIBUTING.md)。原生线程执行依据 [官方 Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)。
