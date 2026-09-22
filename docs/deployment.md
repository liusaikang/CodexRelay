# 单机部署与接入

原生任务网关面向同一可信后端域，使用单共享 Token。以下说明当前实现的部署与客户端用法。Docker 文件与配置已迁移，但尚未实跑；验证范围与限制见 [验收记录](verification.md)。

## 本机启动

在仓库根目录执行，Windows PowerShell 可将 `npm` 替换为 `npm.cmd`：

```sh
npm ci
npm run init:env
npm run build
npm run config:check
npm run start:env
```

启动前核对 YAML 使用 [新配置结构](configuration.md)：`dataDir: ../data/native-service`，顶层 `runner: codex`，以及 `server`、`tasks`、`codex`。不要继续加载旧项目/能力配置。配置检查只做预检查，不代表模型认证、skill 发现或实际沙箱权限已经通过。

`init:env` 生成随机服务令牌到 `.env`，不要提交该文件。服务 Token 与模型认证不同：使用 `CODEX_API_KEY`，或按 [运维说明](operations.md) 在专用 `codex.home` 登录。`CODEX_MODEL` 和 `CODEX_MODEL_REASONING_EFFORT` 可留空，或作为新会话默认值。

需要代理时配置 `HTTPS_PROXY` / `HTTP_PROXY`，并在 `codex.envAllowlist` 中允许必要变量。`NO_PROXY` 应包含本机服务地址。不要假定 CLI 自动继承桌面应用或系统代理；Node 环境文件也不会覆盖终端已存在的同名环境变量。

本机调试页面为 `http://127.0.0.1:8787/`。只有显式启用 `server.localConsole: true` 的直接回环连接可自动取得令牌；服务器部署关闭此项，不要将自动登录入口通过代理公开。

离线演示使用 demo 配置：

```sh
npm run start:env -- --config config/demo.yaml
```

其中 `runner: demo` 不调用模型，不验证真实数据源或原生 skills。真实模型 smoke 会消耗额度，必须单独授权部署凭据并记录结果。

## 接入工作目录

服务默认目录是相对配置文件的 `../examples/workspace`。部署自有项目时由管理员设置 `codex.defaultWorkingDirectory`；调用方不能通过请求切换工作目录，也不再注册项目名或能力名。

在目标目录准备 `AGENTS.md` 和 `.agents/skills/<名称>/SKILL.md`。示例约定为 `examples/workspace/AGENTS.md` 与 `examples/workspace/.agents/skills/log-evidence/SKILL.md`。技能由 Codex 原生发现，service 不扫描或拼接内容。不要将 skill 仅放到与任务工作目录无关的 service 源目录并期待生效。

远端数据源在专用 Codex home 的 `config.toml` 配置；认证变量按需加入 `codex.envAllowlist`。工具和账户权限由部署环境决定，详见 [安全说明](../SECURITY.md)。

## Docker 部署

Dockerfile、Compose 和容器配置已适配原生任务网关结构，尚未进行实际构建与运行验收。部署前按目标宿主核对挂载路径、默认工作目录、认证及代理；从旧版本升级时不要继续加载旧项目/能力配置。

在已配置模型认证和服务 Token 的部署环境中执行：

```sh
docker compose build
docker compose run --rm codex-mcp node dist/main.js --config config/docker.yaml --check
docker compose up -d
docker compose ps
docker compose logs --tail=100 codex-mcp
```

容器内建议明确配置 `dataDir: /data/native-service` 与 `codex.home: /data/codex-home`，并持久化这两个目录。把宿主项目挂载到 `/workspace` 后，由管理员设置 `codex.defaultWorkingDirectory: /workspace`。调用请求不接受工作目录，不要把宿主 Windows 路径写入 Linux 容器配置。

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
