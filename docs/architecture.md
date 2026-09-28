# 架构与任务生命周期

```mermaid
flowchart TB
  A[业务平台 / MCP 客户端] -->|Bearer Token| B[HTTP API / MCP 六工具]
  C[运维控制台] -->|登录 Cookie| B
  B --> D[参数校验与幂等去重]
  D --> E[持久化任务与会话]
  E --> F[有界队列]
  F --> G[全局并发 + 同会话串行]
  G --> H[独立执行进程 / Codex SDK]
  H --> I[工作目录 / AGENTS.md / 原生 Skills]
  H --> J[Codex 认证与原生线程]
  H --> K[按部署凭据访问文件及外部工具]
  H --> L[进度 / 结果 / 错误 / 用量]
  L --> E
  L --> M[可选调用日志]
  E --> C
  C --> N[热更新调度参数]
  N --> F
```

服务层 `src/service.ts` 统一处理 HTTP 与 MCP 提交。`src/storage.ts` 以原子 JSON 写入保存任务与会话，并阻止两个实例共享同一存储目录。

```mermaid
stateDiagram-v2
  [*] --> queued: 校验并落盘
  queued --> running: 容量可用且前序允许
  queued --> timed_out: 排队期限到达
  queued --> cancelled: 取消
  running --> succeeded: 获得完整回答
  running --> failed: 执行失败
  running --> cancelled: 取消并确认进程退出
  running --> timed_out: 超时并确认进程退出
  running --> interrupted: 关闭或恢复遗留任务
```

失败前序会阻塞同会话后续任务，其他可运行会话仍可使用空闲名额。运维确认继续只放行后续任务；“新会话重试”会新建任务并记录 `retryOfTaskId`。

| 目录 | 内容 | 保留方式 |
| --- | --- | --- |
| `dataDir` | 任务、会话、实例锁、运行配置覆盖 | 持久保存；管理员备份与归档 |
| `invocationLog.directory` | 按日期和任务组织的调用日志 | 开关与保留天数可热更新 |
| `codex.home` | 模型认证、原生线程、原生配置 | 独立持久保存，不纳入版本库 |
| 工作目录 | 项目源码、AGENTS.md、Skills | 由部署者挂载或配置 |

当前是单实例架构：不要求 Redis 或数据库，也不支持跨实例共享队列。额度面板读取的是当前 Codex 账号共享额度，不能视为某个实例独享的预算。
