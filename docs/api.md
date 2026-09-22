# MCP 与 HTTP 接口

本文描述原生 Codex SDK 任务网关的新接口契约；迁移验证见 [验收记录](verification.md)。业务 HTTP API 与 `/mcp` 使用 `Authorization: Bearer <CODEX_MCP_TOKEN>`。同一实例的共享 Token 可以访问全部任务和会话，不提供复杂 RBAC；业务后端负责用户授权。

## 提交字段

HTTP `POST /v1/tasks` 与 MCP `codex_submit_task` 使用同一输入：

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| question | 是 | 本次问题，非空字符串 |
| context | 否 | 本次任务的结构化参考数据，必须是 JSON 对象，UTF-8 序列化后不超过 16 KiB |
| sessionId | 否 | 续接已有 v2 会话；省略则创建会话 |
| idempotencyKey | 否 | 同一次提交的重试去重键 |

只有上述四个字段属于提交契约。不要提交 `workingDirectory`、`model`、`modelReasoningEffort`、旧 `projectKey`、`capability`，也不能传 skill 列表、MCP 定义、环境变量、CLI 参数、凭据或 sandbox 设置。执行目录、模型、推理强度及 `danger-full-access`、approval `never`、network enabled、实时 Web 搜索策略由服务固定。

`context` 会随任务记录持久化并进入 Codex 会话。它是参考数据，不是系统指令；调用方应只传排查所需的最少信息，不传密码、Token、Cookie 或其他秘密。追问未传 `context` 时不会自动复制上一任务的对象，但原生 Codex 线程仍保留已有对话上下文。

## 会话与幂等

- 不传 `sessionId` 时创建新会话，响应包含 `taskId`、`sessionId` 和任务状态。
- 会话的工作目录、模型和推理强度在首次创建时取服务配置并保存，重启后保持；调用方不能覆盖。
- 无效会话不静默新建。v1 历史会话可以查询，但不能继续执行。
- 相同幂等键与相同参数返回原任务；参数变化报冲突。网络超时后重试原提交须保留相同键，新追问用新键。
- 业务 `sessionId` 与 MCP 连接标识、内部 Codex thread ID 不同，调用方不能提交原生 thread ID。

## MCP 六工具

远程入口 `/mcp` 使用 Streamable HTTP。业务上下文由显式 `sessionId` 维护，不依赖连接级会话。

| 工具 | 输入 | 返回用途 |
| --- | --- | --- |
| codex_get_service_info | 无 | 服务信息、默认设置与固定执行边界，不是 skill 清单 |
| codex_submit_task | question，context?，sessionId?，idempotencyKey? | 提交任务并返回任务标识和状态 |
| codex_get_task | taskId | 状态、最近进度、结果与错误 |
| codex_cancel_task | taskId | 请求取消后的当前状态 |
| codex_list_sessions | offset?, limit? | 会话分页 |
| codex_get_session | sessionId, offset?, limit? | 会话及任务摘要分页 |

`codex_get_service_info` 替代旧 `codex_get_capabilities`，工具总数仍为六个，不保留旧能力发现作为第七个工具。信息接口不承诺枚举 Codex 原生发现的 skills 或远端 MCP 工具，也不能用作权限清单。

成功工具响应提供文本 JSON 与 `structuredContent: { data: ... }`；业务错误以 `isError: true` 返回 `code` 和 `message`。协议参数错误由 MCP SDK 处理。

本机 stdio 启动命令：

```sh
node dist/main.js --transport stdio --config config/default.yaml
```

stdio 依赖本机操作系统权限，日志写 stderr，stdout 留给协议。HTTP 和 stdio 实例不得同时占用同一个数据目录；多个客户端共享一个 HTTP 服务即可。

## HTTP

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | /healthz | 公开健康检查 |
| GET | /v1/health | 认证后的调度健康状态 |
| GET | /v1/info | 服务信息，替代旧能力发现接口 |
| POST | /v1/tasks | 提交任务，HTTP 202 |
| GET | /v1/tasks/:taskId | 查询任务 |
| POST | /v1/tasks/:taskId/cancel | 请求取消 |
| GET | /v1/sessions?offset=0&limit=20 | 会话分页 |
| GET | /v1/sessions/:sessionId?offset=0&limit=20 | 会话及任务摘要 |

`/v1/info` 替代 `/v1/capabilities`，不是兼容别名。URL 中的 `/v1/` 是 HTTP API 路径，与新存储记录的 `version: 2` 无关，不应改成 `/v2/`。

最小提交及查询示例：

```powershell
$headers = @{ Authorization = "Bearer $env:CODEX_MCP_TOKEN" }
Invoke-RestMethod 'http://127.0.0.1:8787/v1/info' -Headers $headers
$body = @{
  question = '请分析样例日志中的订单查询失败，给出证据。'
  context = @{ subject = @{ account = 'demo-user'; tenantId = 'tenant-demo-001' } }
  idempotencyKey = [guid]::NewGuid().ToString()
} | ConvertTo-Json -Depth 6
$task = Invoke-RestMethod 'http://127.0.0.1:8787/v1/tasks' -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body))
Invoke-RestMethod "http://127.0.0.1:8787/v1/tasks/$($task.taskId)" -Headers $headers
```

追问示例请求体如下，其中 ID 用实际返回值替换：

```json
{
  "question": "请列出仍缺少的证据。",
  "sessionId": "sess_<返回的会话标识>",
  "idempotencyKey": "feedback-demo-001-followup"
}
```

## 状态与结果

每 2-5 秒轮询一次即可。`queued` 与 `running` 是非终态；终态为 `succeeded`、`failed`、`cancelled`、`timed_out`、`interrupted`。取消运行任务时可暂时仍为 `running`，但带 `stopReason: cancelled`，直到执行进程退出才释放名额。

成功任务含 `result.markdown` 与 `result.usage`。`succeeded` 只表示模型执行完成，不保证证据完整或业务结论正确；必须保留模型报告中的不确定性，不能将自然语言直接当数据库指令执行。

HTTP 断连或客户端等待超时不会取消已接受的任务。服务不自动重试模型错误；v2 会话后续任务可能继承失败前产生的部分原生上下文。v1 会话则仅保留查询，不允许续接；v1 queued 不会在升级后重跑。

## 错误与限制

| 错误码 | HTTP | 处理 |
| --- | --- | --- |
| INVALID_INPUT | 400 / 413 | 检查字段、类型与请求大小 |
| INVALID_WORKING_DIRECTORY | 400 | 服务配置的默认工作目录不存在或不可访问；由管理员修复配置或挂载 |
| UNAUTHORIZED | 401 | 检查共享服务 Token |
| HOST_DENIED / ORIGIN_DENIED | 403 | 检查域名或来源白名单 |
| NOT_FOUND | 404 | 检查 taskId / sessionId |
| IDEMPOTENCY_CONFLICT | 409 | 不得用同一幂等键提交不同参数 |
| SESSION_CONFIG_CHANGED | 409 | 会话对应的服务执行配置已变化，创建新会话 |
| LEGACY_SESSION | 409 | v1 历史会话不能续接；保留历史查询，创建新 v2 会话 |
| QUEUE_FULL | 429 | 延迟后以原幂等键重试 |
| SERVICE_UNAVAILABLE / STORAGE_UNAVAILABLE | 503 | 等待恢复或处理存储故障 |

旧会话续接返回 `LEGACY_SESSION`（HTTP 409）。历史记录版本不改变任务查询用途；不要通过改写版本号或目录字段绕过旧会话限制。

问题最多 32000 字符，`context` 最多 16 KiB，请求体最多 128 KiB，分页 limit 为 1-100；任务查询保留最近 100 条进度，最终回答最多 1 MiB，每任务最多 10000 个 SDK 事件。问题、上下文、结果和原生历史可能含敏感信息，调用方应先脱敏。

静态调试入口 `/`、`/console` 不等于业务接口免认证。`GET /console/session` 仅供 `server.localConsole: true` 下的直接本机调试连接取得令牌；生产必须关闭，不能代理公开。
