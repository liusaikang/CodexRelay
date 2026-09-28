# MCP 接入

## 远程连接

传输方式为 Streamable HTTP，地址 `/mcp`。每次请求必须有 `Authorization: Bearer <CODEX_MCP_TOKEN>`。控制台 Cookie 不能用于 MCP。服务不提供 OAuth 授权页面，接入客户端需要支持自定义 Bearer 请求头。

业务会话通过工具参数 `sessionId` 维护，不使用 MCP transport session ID。服务采用无状态 HTTP transport，不要求客户端维持长连接。

安装了本项目依赖后可运行 [MCP 客户端示例](../examples/mcp-client.mjs)：

```sh
node --env-file=.env examples/mcp-client.mjs
```

默认只列出工具，不调用模型。显式传入 `--question "分析样例日志"` 才会提交真实任务并轮询；`CODEX_MCP_URL` 为服务根地址，不带 `/mcp`。

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'example-platform', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL('/mcp', process.env.CODEX_MCP_URL),
  { requestInit: { headers: { Authorization: `Bearer ${process.env.CODEX_MCP_TOKEN}` } } },
));
try {
  const response = await client.callTool({
    name: 'codex_submit_task',
    arguments: { question: '分析示例日志', sandboxMode: 'read-only', idempotencyKey: 'example-request-001' },
  });
  if (response.isError) throw new Error(JSON.stringify(response.content));
  const task = response.structuredContent.data;
  console.log(task.taskId, task.sessionId, task.status);
} finally {
  await client.close();
}
```

## 工具契约

| 工具 | 参数 | 结果 |
| --- | --- | --- |
| `codex_get_service_info` | `{}` | 模型默认值、执行目录、队列容量、执行策略 |
| `codex_submit_task` | `question`, `context?`, `sessionId?`, `idempotencyKey?`, `sandboxMode?` | 任务对象，通常为 `queued` 或 `running` |
| `codex_get_task` | `taskId` | 任务状态、结果、错误、调度原因 |
| `codex_cancel_task` | `taskId` | 取消请求后的任务状态 |
| `codex_list_sessions` | `offset?`, `limit?` | `{ total, offset, limit, items }` |
| `codex_get_session` | `sessionId`, `offset?`, `limit?` | 会话与分页任务摘要 |

成功返回 `structuredContent: { data: ... }`，同时提供 JSON 文本 `content`；业务错误返回 `isError: true` 和含 `code/message` 的文本。HTTP 200 不代表工具执行成功。参数校验错误由 MCP SDK 返回。

提交只接受上述五个字段。`sandboxMode` 使用 SDK 原生的 `read-only`、`workspace-write`、`danger-full-access`，权限范围和默认行为见 [HTTP 请求契约](http-api.md#sandboxmode)。同会话连续追问会串行执行；模型结束前工具调用就已返回任务标识。轮询间隔建议 2–5 秒，不要紧密循环。

网络中断时复用原幂等键提交相同参数；模型已经失败时不能用旧幂等键要求重跑。控制台和 HTTP 的 `/retry` 是新会话重试操作，不新增 MCP 工具。MCP 调用方可使用新的 `codex_submit_task` 创建独立任务。

`previous_task_failed` 表示前序失败阻塞后续任务，需要运维人员在控制台确认继续，或通过 HTTP session resume 接口处理。

## stdio

适用于在同一主机上启动服务进程的 MCP 客户端。示例客户端配置结构（具体字段依客户端而定）：

```json
{
  "mcpServers": {
    "codexrelay": {
      "command": "node",
      "args": [
        "/opt/codexrelay/dist/main.js",
        "--transport", "stdio",
        "--config", "/opt/codexrelay/config/production.yaml"
      ]
    }
  }
}
```

通过客户端环境设置传入生产配置所需环境变量，勿把真实秘密写入示例文件。Windows 使用实际绝对路径。stdio 依赖进程权限而非 HTTP Token；stdout 是协议，诊断写 stderr。每个 stdio 实例使用独立 dataDir；多个客户端共享服务时推荐 HTTP。
