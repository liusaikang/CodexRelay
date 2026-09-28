# 单机部署与接入

并发、排队、升级迁移和异常实例锁处理见 [任务调度与故障恢复](scheduling.md)。同一数据目录禁止多个实例共同执行任务。

原生任务网关面向同一可信后端域，使用单共享 Token。以下说明当前实现的部署与客户端用法。Docker 文件与配置已迁移，但尚未实跑；验证范围与限制见 [验收记录](verification.md)。

## 本机启动

文件读写使用 Node.js 跨平台 API，配置中的相对路径按 YAML 所在目录解析；Windows、Linux、macOS 均不需要通过 PowerShell 或 shell 命令读取调用日志。Linux/macOS 使用文件权限，Windows 需为部署账户配置目录 ACL。

浏览器回归测试默认使用 Playwright Chromium，先执行 `npx playwright install chromium`；Linux CI 可使用 `npx playwright install --with-deps chromium`。仅在需要已有浏览器时设置 `BROWSER_CHANNEL=msedge` 或 `chrome`。CI 配置覆盖三个操作系统和 Node.js 22/24；新增矩阵不代表尚未运行的平台已经通过验证。

在仓库根目录执行，Windows PowerShell 可将 `npm` 替换为 `npm.cmd`：

```sh
npm ci
npm run init:env
npm run build
npm run check:dev
npm run start:dev
```

开发环境固定加载 `config/development.yaml`，继续读取 `data/native-logs-preview` 中的已有会话和 `data/invocation-logs` 中的调用日志。`npm start` 和旧的 `npm run start:env` 也启动开发环境。配置检查只做预检查，不代表模型认证、skill 发现或实际沙箱权限已经通过。

`init:env` 生成随机服务令牌和生产控制台密码到 `.env`，不会覆盖已有文件。服务 Token 与模型认证不同。开发环境登录专用 home：Linux/macOS 使用 `CODEX_HOME="$PWD/data/codex-home" npx --no-install codex login --device-auth`；PowerShell 使用 `$env:CODEX_HOME = Join-Path (Get-Location) 'data/codex-home'` 后执行 `npx --no-install codex login --device-auth`。生产使用各自的 `CODEX_HOME`，也可提供 `CODEX_API_KEY`。`CODEX_MODEL` 和 `CODEX_MODEL_REASONING_EFFORT` 可留空，或作为新会话默认值。

需要代理时配置 `HTTPS_PROXY` / `HTTP_PROXY`，并在 `codex.envAllowlist` 中允许必要变量。`NO_PROXY` 应包含本机服务地址。不要假定 CLI 自动继承桌面应用或系统代理；Node 环境文件也不会覆盖终端已存在的同名环境变量。

本机调试页面为 `http://127.0.0.1:8787/`。未登录会跳转 `/login`；开发环境示例账号密码为 `admin/admin`，不可对外使用。网页登录不返回服务令牌，后端与 MCP 继续使用 Bearer Token。

## 原生生产环境

生产环境固定加载 `config/production.yaml`，必须使用独立持久化路径。先在未提交的 `.env` 中提供 `CODEX_DATA_DIR`、`CODEX_INVOCATION_LOG_DIR`、`CODEX_HOME`、`CODEX_WORKSPACE`、`CODEX_CONSOLE_USERNAME`、`CODEX_CONSOLE_PASSWORD`、`CODEX_PUBLIC_HOST`（域名，不含协议/端口）和 `CODEX_PUBLIC_ORIGIN`（完整来源，如 `https://codex.example.com`）。服务访问令牌仍由 `init:env` 初始化的 `CODEX_MCP_TOKEN` 提供。工作目录需预先存在；三个数据目录不得重叠，也不得与开发环境目录重叠。然后运行：

```sh
npm run build
npm run check:prod
npm run start:prod
```

生产环境默认只监听 `127.0.0.1:8787`，由 HTTPS 反向代理对外提供访问；仅在有受控网络边界时设置 `CODEX_BIND_HOST=0.0.0.0`。开发与生产的 `CODEX_HOME` 必须分开，否则模型线程及认证会混用。不要在同一端口同时启动两套环境。

离线演示使用 demo 配置：

```sh
node --env-file=.env dist/main.js --config config/demo.yaml
```

其中 `runner: demo` 不调用模型，不验证真实数据源或原生 skills。真实模型 smoke 会消耗额度，必须单独授权部署凭据并记录结果。

## 接入工作目录

开发环境默认目录是相对配置文件的 `../examples/workspace`。生产环境由管理员设置 `CODEX_WORKSPACE`；调用方不能通过请求切换工作目录，也不再注册项目名或能力名。

在目标目录准备 `AGENTS.md` 和 `.agents/skills/<名称>/SKILL.md`。示例约定为 `examples/workspace/AGENTS.md` 与 `examples/workspace/.agents/skills/log-evidence/SKILL.md`。技能由 Codex 原生发现，service 不扫描或拼接内容。不要将 skill 仅放到与任务工作目录无关的 service 源目录并期待生效。

远端数据源在专用 Codex home 的 `config.toml` 配置；认证变量按需加入 `codex.envAllowlist`。工具和账户权限由部署环境决定，详见 [安全说明](../SECURITY.md)。

## Docker 部署

Dockerfile、Compose 使用 `config/production.yaml`，生产配置和当前 SDK 绑定的 Codex CLI 一起打包。需要 Docker Compose v2、Linux 容器。CI 负责镜像构建与无模型调用的启动检查；本机实际验证范围见 [verification.md](verification.md)。

先执行 `npm run init:env` 生成 `.env`。无 Node.js 的部署机可复制 `.env.example` 为 `.env`，自行设置至少 24 字符随机 `CODEX_MCP_TOKEN` 和强控制台密码。既有 `.env` 不会被生成器更新，需手工补齐空值。默认工作目录为合成样例；正式接入时设置 `CODEX_WORKSPACE_HOST` 为宿主机实际项目路径。Windows 路径使用正斜杠，如 `C:/projects/example`。

```sh
docker compose build
docker compose run --rm codex-mcp codex login --device-auth
docker compose run --rm codex-mcp codex login status
docker compose run --rm codex-mcp node dist/main.js --config config/production.yaml --check
docker compose up -d
docker compose ps
docker compose logs --tail=100 codex-mcp
```

账号登录按终端给出的地址与验证码在浏览器完成。如账号尚未启用设备码登录，先按 CLI 提示处理账号设置；也可配置 API Key。登录状态保存在卷中，可随容器重建保留。网页控制台登录使用 `.env` 中的用户名/密码，不是 ChatGPT 密码。

本机访问 `http://127.0.0.1:8787/`，MCP 地址追加 `/mcp`。修改宿主端口用 `CODEX_MCP_PORT`；若显式设置了 `CODEX_PUBLIC_ORIGIN`，同步修改其中端口。当前 Compose 只发布回环端口。远程浏览器通过 HTTPS 代理或 SSH 本地端口转发访问；服务器监听非回环时 Cookie 带 Secure，不能直接用普通远程 HTTP 登录。不要仅靠放开端口暴露控制台。

无模型调用的容器检查（使用临时目录，不接触业务任务）：

```sh
docker compose run --rm codex-mcp node scripts/container-smoke.mjs
```

镜像以 `node` 用户运行；Linux bind mount 应保证 UID 1000 有所需读写权限。文件变更能力还受挂载、宿主 ACL 和所选 Codex 沙箱约束。`.env` 中 `CODEX_SANDBOX_MODE` 支持 `read-only`、`workspace-write`、`danger-full-access`（兼容默认值），修改后重建容器使环境变量生效。只读业务可额外将工作目录挂载设为 `read_only: true`，但 `/data` 仍需写入运行状态。默认不挂载 Docker socket，不内置 SSH 私钥。沙箱模式与远端权限边界见 [配置说明](configuration.md#执行权限)。

正常升级使用 `docker compose stop`、`docker compose build`、`docker compose up -d`。Compose 保留 `restart: "no"`，因为当前异常实例锁需人工检查；强制结束后不要自动删除锁。若锁的 hostname 属于旧容器，先确认旧容器和全部执行进程已停止、备份卷，再由管理员处理旧锁；不能将仍在运行的副本强行解锁。普通升级不要使用 `down -v`。

容器内通过 Compose 环境变量指定 `CODEX_DATA_DIR=/data/production-service`、`CODEX_INVOCATION_LOG_DIR=/data/production-invocation-logs`、`CODEX_HOME=/data/codex-home` 和 `CODEX_WORKSPACE=/workspace`。调用请求不接受工作目录，不要把宿主 Windows 路径写入 Linux 容器配置。

部署账户、宿主挂载、Docker socket、SSH 凭据和网络由调用方按所需能力配置。容器自身的回环地址不是宿主代理地址，代理和远端 MCP 可达性需独立配置。

远程接入使用 HTTPS 反向代理，保留 Host 和 Authorization，配置真实 `allowedHosts` 与必要 `allowedOrigins`，关闭 `localConsole`。只有健康检查和静态入口公开，业务 API 仍须认证。

真实任务固定使用 full access。异常退出先检查进程与实例锁，不盲目重启；`docker compose down -v` 会删除卷，不用于普通升级。

## 业务后端调用

客户端入口为 `examples/backend-client.mjs`，可直接导入 `createCodexClient`：

```js
import { createCodexClient } from './examples/backend-client.mjs';

const client = createCodexClient({
  url: process.env.CODEX_MCP_URL,
  token: process.env.CODEX_MCP_TOKEN,
});
const task = await client.submit({
  question: '请分析样例日志中的订单查询失败，并关联源码。',
  context: {
    user: { account: 'demo-user', tenantId: 'demo-tenant' },
    requestId: 'req-20260922-001',
  },
  idempotencyKey: 'feedback-demo-001',
});
const result = await client.wait(task.taskId);
if (result.status === 'succeeded') {
  console.log(result.result.markdown);
}
```

`context` 可省略；存在时必须是 JSON 对象且不超过 16 KiB，用于提供账号、租户、请求标识等排查参考，不能包含密码、Token 或无关个人信息。提交后保存 `taskId` 和 `sessionId`，前端无需阻塞等待整个任务。客户端等待超时或断网不会自动取消后台任务；使用原 taskId 查询，或明确请求取消。重试提交使用相同幂等键及参数。

示例 CLI 使用 `--context` 传入可选 JSON 对象；执行目录和模型设置始终来自服务配置：

```sh
npm run example:diagnose -- --context '{"user":{"account":"demo-user"}}'
npm run example:diagnose -- --inline-example
```

`--inline-example` 会把固定合成证据放入 `context.syntheticEvidence`，用于验证上下文直传链路；这不能证明 Codex 自行读取文件或原生 skill 发现成功，也不应据此宣称完整诊断验收通过。

## MCP 与会话

远程客户端使用 `https://<服务域名>/mcp`，请求头携带共享服务令牌。先调用 `codex_get_service_info`，再调用 `codex_submit_task`，用 `codex_get_task` 轮询；工具总数仍为六个。

首次不传 `sessionId`。追问传入新问题与返回的 `sessionId`；每次请求都可按需传入本次问题的 `context`。工作目录、模型和推理强度不能由调用方覆盖。任务记录和 Codex home 都需持久化。

升级前备份旧数据。新默认 `native-service` 不会删除或自动合并旧目录；v1 可查询但会话不可继续，旧 queued 不重跑。具体操作见 [数据迁移](operations.md)。
