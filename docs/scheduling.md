# 任务调度与故障恢复

本版本使用单实例调度器和本地文件，不依赖外部数据库。一个数据目录只能由一个实例使用，并发限制仅在该实例内生效，不能启动多个容器共享目录扩容。HTTP 与 MCP 共用调度器。

## 接收与排队

认证与校验 -> 幂等检查及有界接收 -> 确认队列容量 -> 持久化序号与任务 -> 返回任务 ID / 调度可执行任务 -> 执行进程 -> 保存终态 -> 进程退出后释放名额。

- `maxConcurrent`：执行并发上限。
- `maxQueued`：等待任务上限，包括会话依赖阻塞。0 表示不能立即运行就拒绝。
- 接收容量自动取两者之和。等待持久化的请求及等待相同幂等结果的重复请求均计入；已接受任务的幂等查询不重复入队。
- 接收满返回 `ADMISSION_FULL`，队列满返回 `QUEUE_FULL`，HTTP 均为 429，附带 `Retry-After: 5`。调用方应退避、加入抖动并保留原幂等键。
- 四个提交参数不变。幂等键作用域为整个共享实例。
- 202 不代表执行成功。断网、超时或 5xx 时接收结果可能未知，不应换幂等键盲目重试。

接收有界不是公网防护；反向代理仍需限制连接数、请求速率及请求体。

## 顺序与会话

新任务持久化递增的 `enqueueSequence`。调度选择最早且可执行的任务；同一会话最多运行一个任务，阻塞会话不挡住其他会话。

例如 A1、A2、B1、C1 中 A1/A2 属于同一会话，并发为 3 时运行 A1、B1、C1，A2 等待 A1。

在前序尚未结束时提交的追问保存 `dependsOnTaskId`。前序失败、取消、超时或中断，依赖任务不自动运行，不占执行名额。会话已经没有运行或排队任务时，新提交的追问视为调用方主动继续，不重跑旧任务。

运维可取消后续任务，或确认缺失上下文的风险后请求：

```http
POST /v1/sessions/{sessionId}/resume
Authorization: Bearer <service-token>
Content-Type: application/json

{"blockedByTaskId":"task_<失败的前序任务ID>"}
```

只解除指定失败前序的阻塞，不重试失败任务，不延长排队期限。确认写入 `dependencyApprovedAt` 和 `queue_resumed` 事件。重复请求不会重复启动任务；不匹配的前序被拒绝。控制台有二次确认按钮；MCP 保持原有六工具，恢复使用 HTTP。

## 超时与观测

`timeoutSeconds` 默认 600 秒，控制执行超时；发起停止后仍占用名额直到进程退出。`queueTimeoutSeconds` 默认 1800 秒，可设 1 秒到 7 天，覆盖等待名额和等待会话确认。

排队截止写入 `queueExpiresAt`，停机时间计入，改配置只影响新任务。过期任务为 `timed_out`，错误码 `QUEUE_EXPIRED`，没有 `startedAt`，不调用 Codex。启动前复查期限，避免慢磁盘使已过期任务启动。

健康接口增加 `receiving`、`blocked`、`admissionLimit`。`blocked` 是 `queued` 的子集，不能再次相加。queued 任务返回 `scheduling`：

| reason | 含义 |
| --- | --- |
| capacity | 等待全局并发名额 |
| session_active | 等待同会话运行任务 |
| session_predecessor | 等待同会话较早的排队任务 |
| previous_task_failed | 前序未成功，需要确认或取消 |
| ready | 等待调度 |
| service_stopping | 服务正在停止 |
| storage_unavailable | 存储异常，调度停止 |

依赖阻塞包含 `blockedByTaskId`。这些状态不代表预计完成时间；存储故障时任务读取可能直接返回 503。

## 升级和恢复

升级前停止实例并备份 `dataDir`、`codex.home`。旧记录按创建时间确定性补齐序号；时间相同时先处理非 queued，再按任务 ID 排序，防止追问越过遗留 running。无法还原同毫秒旧记录的精确接收顺序。旧 queued 补齐依赖和截止时间，可能立即过期或等待确认，不会静默删除。

重启恢复 queued；遗留 running 标记 interrupted，不自动重放。不能承诺外部操作恰好一次，中断前可能已产生副作用，需业务侧幂等及人工判断。

异常退出先只读检查：

```sh
node dist/main.js --config config/development.yaml --inspect-lock
```

确认旧主进程、worker 及其子进程都停止后，才能执行：

```sh
node dist/main.js --config config/development.yaml --recover-lock --confirm-workers-stopped
```

恢复只接受同主机且 PID 确认不存在的锁，备份后移除，不删除任务、会话或 Codex 数据。活跃进程、其他主机、损坏锁、无法确认的 PID 均拒绝。容器主机名或 PID 命名空间变化需管理员在宿主机核实，不可强制绕过。

启动与恢复共享短时 `instance.guard`。该步骤崩溃后的残留 guard 同样阻止启动；管理员需检查所有者、停止维护进程并备份后手工处理，不会自动清除。不要混用旧版和新版程序访问同一目录。

## 验证边界

回归使用合成任务，覆盖 100 请求突发、幂等突发、容量、慢磁盘、排队过期、会话依赖、确认继续、持久化顺序、重启恢复及锁检查，不消耗模型额度。另有磁盘故障、执行超时、取消和强制停止执行进程的测试。

这不是生产吞吐承诺，实际吞吐受模型耗时、账号限额、主机和外部工具影响。历史记录仍加载到内存，热路径索引不代表存储可无限增长。长期压测、容器整机故障演练及目标操作系统实跑需单独验收。
