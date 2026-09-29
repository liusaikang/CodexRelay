# HTTP 与原生 Skills 真实验收

日期：2026-09-29。运行环境：Windows，本机已启动且已认证的 CodexRelay。通过 Node.js `fetch` 直接访问 HTTP API，没有通过控制台提交，没有替换执行器或模拟模型。原生线程记录中的模型为 `gpt-6-astra`。

本轮执行 7 个真实模型任务，使用合成账号、随机会话口令和仓库示例文件。结果证明本机现有环境的行为，不代表全新安装、其他操作系统或容器环境已通过。

## 结论

| 验收项 | 实际结果 |
| --- | --- |
| 无 Bearer Token | HTTP 401，`UNAUTHORIZED` |
| 空白问题 | HTTP 400，`INVALID_INPUT` |
| 首次提交及 `context` | HTTP 202；最终回答准确返回问题里的随机口令和 context 里的合成账号 |
| 按任务 ID 查询 | HTTP 200；实际观察到 `running`、进度事件、`succeeded` 与最终结果 |
| 幂等请求 | 重复提交同一请求和幂等键，返回相同任务 ID |
| 幂等冲突 | 同一幂等键更换问题，HTTP 409 |
| 带会话 ID 追问 | 不重传 context 和口令，仍能准确复述首轮信息；两轮对应同一原生线程 |
| 不带会话 ID 对照 | 创建不同会话和线程，回答 `UNKNOWN`；没有混入前一个会话的信息 |
| 明确指定 Skill，服务默认完整权限 | 通过；实际读取 Skill、证据及源码，输出预期根因和证据标记 |
| 按场景自动匹配 Skill，服务默认完整权限 | 本次通过；没有在问题中写 Skill 名称，仍实际读取并执行其流程 |
| Skill 文件读取，显式只读权限 | 两次未通过：读取 Skill 的 PowerShell 命令被执行策略拒绝 |

本轮没有重启服务，没有更改现有服务配置。示例工作目录的 11 个文件在模型任务执行前后 SHA-256 一致。该检查证明本轮文件内容未变化，不是对所有外部副作用的完整审计。

## 首次提交的返回格式

`POST /v1/tasks` 的 HTTP 202 表示任务已接收，不表示答案已经生成。本次首次提交的返回状态已经是 `running`，并非一定先返回 `queued`。

以下是实测响应的字段节选，ID、问题和日期已替换为示例；完整响应还包含 request、时间和调度字段：

```json
{
  "version": 2,
  "taskId": "task_11111111-1111-4111-8111-111111111111",
  "sessionId": "sess_22222222-2222-4222-8222-222222222222",
  "status": "running",
  "progress": [],
  "sandboxMode": "read-only",
  "invocationTransport": "http"
}
```

调用方应保存 taskId 和 sessionId，然后用同一个 Bearer Token 查询 `GET /v1/tasks/{taskId}`。

## 进度与最终答案

本次完整权限 Skill 任务返回了 `agent_message` 和 `command_execution` 进度事件。例如以下字段节选：

```json
{
  "status": "running",
  "progress": [
    { "at": "2026-09-29T09:12:24.568Z", "kind": "progress", "detail": "agent_message" },
    { "at": "2026-09-29T09:12:26.889Z", "kind": "progress", "detail": "command_execution" }
  ]
}
```

progress 是事件类型和发生时间，不是完成百分比，也不包含每条命令、日志输出或中间回答全文。

任务完成后，答案位于 `result.markdown`，SDK 返回的用量位于 `result.usage`。首次记忆任务实际返回的用量字段为：

```json
{
  "status": "succeeded",
  "result": {
    "markdown": "这里是任务最终回答",
    "usage": {
      "input_tokens": 17942,
      "cached_input_tokens": 12416,
      "cache_write_input_tokens": 0,
      "output_tokens": 35,
      "reasoning_output_tokens": 0
    }
  }
}
```

这是一个样本，不代表每次都有相同字段或数值，也不能用它推算账号剩余额度。

## 会话记忆的验证方法

首轮只在请求中提供随机口令，并在 context 中提供随机合成账号。追问只包含新问题、第一次返回的 sessionId、权限与新的幂等键，没有再次发送口令或账号。

两轮都准确返回相同信息。检查原生线程记录确认：两轮复用了同一个 threadId，而且没有调用工具或读取文件。另一个未携带 sessionId 的对照任务创建了新线程，返回 `UNKNOWN`，同样没有工具调用。

这证明本轮真实请求发生了上下文续接。尚未验证服务重启、容器重建或历史压缩后的续接行为，也不意味着模型能永久逐字记住任意长历史。

## Skill 与项目证据的验证方法

新增的测试 Skill 位于：

```text
examples/workspace/.agents/skills/acceptance-ledger-check/
  SKILL.md
  references/evidence.json
  references/visibility.mjs
```

请求只提供 `ledger-demo-reader` 账号和问题，没有传入文件内容、根因或证据标记。Skill 要求按账号读取合成日志，再关联源码，并使用指定报告格式。

在服务默认 `danger-full-access` 权限下，明确指定和自动匹配两种请求均实际读取这三个文件，得到：

- 账号成员资格 `membership.enabled=false`。
- 账本有 3 条数据，接口返回 0 条。
- 源码在成员资格无效时返回 `MEMBERSHIP_INACTIVE`。
- 回答包含文件内独有标记 `LEDGER-PROOF-7E93C1`、匹配的请求编号及规定标题。

自动匹配通过的是本次明确的 ledger-demo 场景，不代表所有模糊问题都必然选中该 Skill。

## 未通过项：只读模式文件访问

显式 `sandboxMode: read-only` 的两次 Skill 请求都尝试读取正确的 SKILL.md，但原生执行记录显示命令遭到 `blocked by policy` 拒绝，未读到正文、证据或源码。本轮未确定执行策略拒绝的更深层原因，也未更改策略。

模型如实回答“无法读取文件”，Relay 将收到完整回答的任务标为 `succeeded`。因此必须分别判断：

- 执行状态：是否获得了完整模型回答。
- 业务完成度：是否真正完成调查、有足够证据支持结论。

这一问题仍需单独排查；本轮只读模式的纯对话和会话续接通过，不代表只读文件工具可用。

## 验证边界

本轮没有验证新账号登录、MCP 客户端、排队压力、服务重启恢复、Docker Compose、Linux 或 macOS。当前服务沿用已有认证和运行环境，不能替代从干净环境严格执行安装文档的验收。

原始请求响应和原生执行摘要存放在本地忽略目录 `data/http-acceptance/`，不包含服务请求头或认证文件。原始结果可能包含本机路径，因此不随公开文档提交；本文只保留合成数据和去除本机路径后的结论。
