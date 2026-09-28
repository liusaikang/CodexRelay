# 实现范围与验收要求

原生 Codex SDK 任务网关的主逻辑、配置、客户端与原生样例迁移已完成。本文列出当前实现范围和持续验收要求；运行验证证据见 [验收记录](verification.md)。

## 配置与执行

- 服务配置为 `dataDir`、`server`、`tasks`、`runner`、`codex`，已移除旧项目、能力、提示文件和 skillFiles 路由结构。
- 开发数据目录为 `../data/native-logs-preview`，生产数据目录由 `CODEX_DATA_DIR` 指定；tasks 默认队列 100、超时 600 秒，开发并发 10、生产并发 3。
- `codex` 包含专用 home、默认工作目录、默认模型、默认推理强度、环境白名单和可选 CLI 路径；CLI 相对路径以配置文件目录为基准解析。
- 执行固定 `danger-full-access`、approval never、network enabled、实时 Web 搜索开启，不开放请求级 sandbox 覆盖。
- Runner 在完成、取消或超时时，均等待执行进程真正退出后才释放并发名额。

## 原生上下文

项目说明位于 `examples/workspace/AGENTS.md`，原生 skill 位于 `examples/workspace/.agents/skills/log-evidence/SKILL.md`。新增 skill 使用服务默认工作目录下的 `.agents/skills`；service 不扫描、拼接、注册或路由 skill。

仓库级发现从任务工作目录向上至仓库根目录，不是任意 service 源目录；目录名为 `.agents`，不是 `.agent`。原生 skill 不是强制工具调用机制或安全边界，发现与装载不能证明某个工具实际执行。

上游 MCP 使用专用 Codex home 的 `config.toml`，不通过服务 YAML 或任务请求注入。网关不限制远端 MCP 的能力，实际权限由调用方和部署环境配置。

## 接口与客户端

- 提交严格限定为必填 `question`，以及可选 `context`、`sessionId`、`idempotencyKey`；`context` 必须是最多 16 KiB 的 JSON 对象。
- 新会话从服务配置解析工作目录、模型和推理强度；调用方不能覆盖，重启后保持会话设置。
- `/v1/info` 替代旧能力发现接口，`codex_get_service_info` 替代旧能力工具，MCP 保持六工具。
- HTTP/MCP/stdio 使用相同任务语义；共享 Token 仅供可信后端，不提供复杂 RBAC 或多租户隔离。
- 客户端使用可选 `--context`，保留 `--inline-example`；真实文件读取与上下文直传是不同的验证链路。

## 存储兼容

新任务和会话为 `version: 2`，默认使用独立数据目录，不删除旧数据。v1 记录可查询，v1 会话不能继续，v1 queued 不恢复执行；遗留 running 不自动重跑。实际迁移状态和错误码见 [运维说明](operations.md)。

存储和调度变更需持续覆盖 v2 queued 恢复、实例锁、损坏文件、磁盘失败、幂等冲突、队列满无孤立会话、同会话串行及取消与追问不重叠。这些机制不保证上游计费全链路 exactly-once。

## 验收范围

`npm run verify` 已通过 34 项测试，覆盖 SDK 替身、HTTP、MCP、stdio、四字段提交契约和旧记录兼容。后续变更仍需重新执行类型检查、测试和构建，发布前另行执行 `npm run release:check` 并审查输出。

真实 SDK、原生上下文装载、shell 文件读取和会话续接需按各自证据判断，不能用替身测试相互代替。Harness 原生装载 skill 正文与 shell 读取 SKILL.md 是不同路径；原生装载成功不能据此推断 shell 读取策略放行。

目标 OS 的命令执行、文件修改、网络和远端工具能力必须独立验收。Docker 文件与配置已迁移，但镜像构建、启动、卷持久化和进程树终止尚未实跑验证。部署记录应包含环境、命令、结果、证据及限制，不把代码已实现等同于所有环境已验收。
