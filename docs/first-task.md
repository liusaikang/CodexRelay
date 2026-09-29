# 从提交问题到继续追问

这个例子使用仓库里的合成订单源码和日志，不连接任何真实业务系统。真实运行仍会消耗模型额度。

## 1. 启动并检查账号

按照 [README](../README.md#本地运行) 启动开发服务，打开控制台确认“账号额度”显示期望的账号。默认工作目录为 `examples/workspace`，其中已经包含 `AGENTS.md` 和 `log-evidence` Skill。

## 2. 在平台后端提交任务

已有 `examples/backend-client.mjs` 提供提交、查询、等待和取消方法。下面的代码应在可信后端执行，不要将服务 Token 放入浏览器源码：

```js
import { randomUUID } from 'node:crypto';
import { createCodexClient } from './examples/backend-client.mjs';

const client = createCodexClient({
  url: process.env.CODEX_MCP_URL || 'http://127.0.0.1:8787',
  token: process.env.CODEX_MCP_TOKEN,
});

const input = {
  question: '请使用 log-evidence Skill 分析示例订单错误，关联日志与源码，并说明哪些现象可忽略。',
  context: { subject: { account: 'demo-reader' }, requestId: 'sample-002' },
  sandboxMode: 'read-only',
  idempotencyKey: randomUUID(),
};
// 网络失败后重发时复用 input，尤其是同一个 idempotencyKey。
const accepted = await client.submit(input);
console.log(accepted.taskId, accepted.sessionId, accepted.status);
const result = await client.wait(accepted.taskId);
if (result.status === 'succeeded') console.log(result.result.markdown);
else console.error(result.status, result.error);
```

平台保存 `taskId` 后即可向用户返回“已接收”，由后台或页面轮询查询。`client.wait` 是演示中的便利方法；等待超时不会取消服务端任务，再查原任务即可。任务正在排队或运行时不要再次提交不同幂等键的同一个问题。

也可以直接运行随仓库提供的客户端：

```sh
npm run example:diagnose
```

该命令使用服务默认权限；上面的 HTTP 示例显式选择只读。CLI 输出本次生成的幂等键、任务 ID、会话 ID 和最终结果。重新执行 CLI 会创建新请求，不是原请求的网络重试。

## 3. 核对证据，而不只看“成功”

示例中 `src/orders.mjs` 读取空的 membership，错误日志有两次订单失败；info 日志提供同 requestId 的查询结果。另有一次指标超时，只有同时满足 `known-issues.md` 中的恢复条件才能忽略。

回答应引用相关文件、关联信息和缺失判断的代码；对不知道的业务原因明确说明。`succeeded` 表示收到完整模型回答，不表示结论已经经过人工验证。使用 `--inline-example` 只验证传入上下文，不能替代文件读取与 Skill 发现验证。

## 4. 继续追问

使用第一次返回的 `sessionId`，为新问题生成新的幂等键：

```js
const followup = await client.submit({
  question: '这两次订单失败是否同一根因？请给出依据。',
  sessionId: accepted.sessionId,
  sandboxMode: 'read-only',
  idempotencyKey: randomUUID(),
});
```

`sessionId` 是 CodexRelay 的会话标识，平台无需管理 SDK thread ID。同一会话自动串行。每一轮可显式传 `sandboxMode`；省略时采用服务默认值，不从上一轮继承。

## 5. 运维在哪里看

| 控制台标签页 | 能回答的问题 |
| --- | --- |
| Codex 调用 | 这个会话每轮问了什么、返回什么、是否有结果 |
| 任务队列 | 为什么还没执行、是否被前序失败阻塞、能否取消 |
| 调用日志 | 在启用记录时，已记录请求的时间、参数与执行结果 |
| 运行配置 | 当前并发、容量、排队期限和日志设置 |

没有任务记录时先查调用方、网络、鉴权和接收响应，不能仅凭空日志判断模型没响应。具体步骤见 [排障手册](troubleshooting.md)。MCP 接入走同一个调度器，工具调用示例见 [MCP 文档](mcp.md)。
