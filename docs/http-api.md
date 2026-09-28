# HTTP API

## 认证与提交

除 `GET /healthz` 外，下列接口需要 `Authorization: Bearer <CODEX_MCP_TOKEN>`。控制台可通过同源会话 Cookie 调用，普通业务前端不要保存共享 Token。

`POST /v1/tasks` 接收 JSON，返回 HTTP 202 和任务对象。

| 字段 | 要求 |
| --- | --- |
| `question` | 必填，1–32000 字符，不可全为空白 |
| `context` | 可选 JSON 对象，UTF-8 序列化后最多 16 KiB |
| `sessionId` | 可选，续接已有会话；省略创建新会话 |
| `idempotencyKey` | 可选，1–128 字符，同次提交重发时保持一致 |
| `sandboxMode` | 可选，Codex SDK 原生沙箱枚举，控制本次任务的权限范围，见下表 |

拒绝其他字段。请求体最多 128 KiB。模型、目录、推理强度由服务配置控制。

### sandboxMode

直接对应 `@openai/codex-sdk` 导出的 `SandboxMode`，不是本项目自定义的权限名称：

| 值 | 权限范围 |
| --- | --- |
| `read-only` | 只读沙箱：允许读取文件和运行沙箱允许的查询命令，不允许写入项目文件 |
| `workspace-write` | 工作目录可写沙箱：允许读文件、执行命令并写入工作目录及原生沙箱允许的临时目录，其他位置的写入受限 |
| `danger-full-access` | 关闭 Codex 沙箱限制，仍受运行账号与宿主环境权限约束 |

省略时使用服务 `codex.sandboxMode` 默认值（未配置时为 `danger-full-access`）。每次提交独立选择，包括携带 `sessionId` 的追问；省略不代表继承上一轮权限。接收时保存实际选定值，响应顶层 `sandboxMode` 可用于核对；已排队任务及失败重试保留原选定值，不随后续默认配置变化而改变。

```json
{ "question": "请分析项目结构", "sandboxMode": "read-only" }
```

非法枚举值返回参数错误；同一幂等键更换 `sandboxMode` 会返回 `IDEMPOTENCY_CONFLICT`。本参数只设置 SDK 沙箱，不调整 `approvalPolicy: never`；权限不足不等待人工批准、不自动扩大权限。工作目录可写模式启用命令网络访问，只读模式遵循原生只读沙箱限制；实时 Web 搜索保持开启。具体限制由目标平台的 Codex 沙箱执行，不是提示词约定。

```js
const base = process.env.CODEX_MCP_URL || 'http://127.0.0.1:8787';
const headers = { Authorization: `Bearer ${process.env.CODEX_MCP_TOKEN}`, 'Content-Type': 'application/json' };
const response = await fetch(`${base}/v1/tasks`, {
  method: 'POST', headers,
  body: JSON.stringify({ question: '分析示例账号的数据可见性', context: { account: 'demo-user' }, idempotencyKey: 'request-demo-001' }),
});
const task = await response.json();
if (!response.ok) throw new Error(task.error.message);
console.log(task.taskId, task.sessionId);
```

之后查询 `GET /v1/tasks/{taskId}`。`queued/running` 为非终态，`succeeded/failed/cancelled/timed_out/interrupted` 为终态。成功结果在 `result.markdown`，用量在 `result.usage`；用量未知是 `null`，不是零。

## 路由

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/healthz` | 公开就绪检查，未就绪返回 503 |
| GET | `/v1/health` | 运行、排队、接收中、前序阻塞数量 |
| GET | `/v1/info` | 当前模型与调度配置 |
| POST | `/v1/tasks` | 提交任务 |
| GET | `/v1/tasks` | 全局任务摘要、状态/关键字筛选 |
| GET | `/v1/tasks/{taskId}` | 任务详情 |
| POST | `/v1/tasks/{taskId}/cancel` | 请求取消，重复操作安全 |
| POST | `/v1/tasks/{taskId}/retry` | 新会话重试失败任务，HTTP 202 |
| GET | `/v1/sessions` | 会话分页，按创建时间倒序 |
| GET | `/v1/sessions/{sessionId}` | 会话信息与任务摘要，按接收顺序 |
| POST | `/v1/sessions/{sessionId}/resume` | 确认继续受前序失败阻塞的任务 |
| GET | `/v1/admin/account` | 脱敏账号及额度，缓存 30 秒 |
| POST | `/v1/admin/account/refresh` | 刷新账号及额度 |
| GET | `/v1/admin/invocations` | 调用日志摘要 |
| GET | `/v1/admin/invocations/summary` | 调用日志统计 |
| GET | `/v1/admin/invocations/{taskId}` | 调用日志详情 |

分页使用 `offset=0&limit=20`，limit 为 1–100。列表返回 `{total, offset, limit, items}`；会话详情中的分页对象位于 `tasks`。

## 队列、取消与重试

`GET /v1/tasks?status=active&offset=0&limit=20&keyword=example`

- `status`：默认 `active`（queued/running），或 `all`、任一任务状态。
- `keyword`：问题、任务 ID、会话 ID 的大小写不敏感子串，最多 200 字符。
- `active/queued` 按接收顺序，其余筛选按接收顺序倒序。
- 摘要含 `questionPreview`、状态、时间、`queuePosition` 和 `scheduling`，不返回完整上下文/结果。
- `queuePosition` 是当前所有等待任务中的接收序号，不是预计执行次序；同会话阻塞任务可被其他可运行会话跳过。

取消运行任务后，可能返回 `status: running, stopReason: cancelled`。直到进程真正退出才释放并发名额。取消不能撤销已完成的外部操作。

失败、超时、取消、中断任务可以重试，body 必须为：

```json
{ "idempotencyKey": "retry-attempt-demo-001" }
```

重试使用原问题、`context` 和原任务实际 `sandboxMode`，其余执行默认值取当前配置，创建**新会话**；响应含 `retryOfTaskId`。旧记录保持不变，不继承旧线程历史，也不自动放行原会话后续任务。相同来源任务和相同重试键返回同一个新任务；不同重试键代表新的一次执行。操作结果未知时必须复用原重试键。

控制台将未确认的重试键存放于当前标签页的 sessionStorage，页面刷新后可以继续去重；关闭标签页或清除浏览器存储后，应先查询已有任务再决定是否重新执行。此存储不包含问题、上下文或认证令牌。

继续原会话排队使用 resume，body 为 `{ "blockedByTaskId": "task_<失败任务ID>" }`。它不重跑失败任务，不延长排队期限。

## 错误格式

```json
{ "error": { "code": "QUEUE_FULL", "message": "Task queue is full. Retry later with the same idempotencyKey." } }
```

| HTTP | 常见 code | 调用方处理 |
| --- | --- | --- |
| 400 / 413 | `INVALID_INPUT` | 检查字段、大小和 JSON 类型 |
| 401 | `UNAUTHORIZED` | 核对令牌 |
| 403 | `HOST_DENIED`, `ORIGIN_DENIED` | 核对访问域名与来源配置 |
| 404 | `NOT_FOUND` | 核对实例、任务或会话 ID |
| 409 | `IDEMPOTENCY_CONFLICT`, `TASK_NOT_RETRYABLE`, `BLOCKER_CHANGED`, `SESSION_CONFIG_CHANGED` | 刷新状态后按业务含义处理 |
| 429 | `QUEUE_FULL`, `ADMISSION_FULL` | 遵循 `Retry-After: 5`，复用原提交幂等键 |
| 503 | `SERVICE_UNAVAILABLE`, `STORAGE_UNAVAILABLE` | 检查服务及存储 |

排队过期是任务终态 `timed_out` + `error.code: QUEUE_EXPIRED`，不是 HTTP 请求超时。客户端断开不会取消已接收任务。

调用日志筛选、Cookie 登录与运行配置接口的详细约定见 [完整接口补充](api.md)。登录接口为 `POST /console/login`，运行配置 GET/PUT `/console/settings` 仅允许控制台会话，写入需同源 Origin；配置提交携带 `revision` 防止覆盖他人修改。
