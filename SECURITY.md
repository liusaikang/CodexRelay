# 信任边界与凭据

## 产品信任模型

CodexMCP 是面向可信业务后端的原生 Codex SDK 任务网关。HTTP/MCP 使用单共享 Bearer Token，不提供复杂 RBAC 或多租户隔离。持有令牌的调用方可以选择任务的原生沙箱模式（包括完整权限），并访问实例中的全部任务和会话。

网关不判断用户问题是否允许修改文件、执行命令、访问网络或调用上游工具。业务后端负责用户身份、请求准入、问题与 `context` 过滤、结果授权和审计，不向普通用户浏览器分发服务 Token。

## 执行策略

默认配置保持既有行为：

```text
sandboxMode: danger-full-access
approvalPolicy: never
networkAccessEnabled: true
webSearchMode: live
```

调用方可通过请求的 `sandboxMode` 选择 `read-only`、`workspace-write` 或 `danger-full-access`；省略采用服务 YAML 的 `codex.sandboxMode` 默认值。它不是由管理员设置的权限上限。`approvalPolicy: never` 始终不等待人工审批，不会在失败后自动扩大权限。各选项范围见 [接口说明](docs/http-api.md#sandboxmode)。

`codex.defaultWorkingDirectory` 确定项目上下文和原生说明的发现起点；它不是读取范围或租户隔离边界。`workspace-write` 的可写范围由 Codex 沙箱结合原生配置决定，包括可能允许的临时目录。部署方应审查专用 Codex home 中的配置、插件和 MCP，不把 SDK 沙箱当作远端工具权限控制。

每个任务保存自己的权限模式，排队恢复和重试保留原值；会话追问可以显式选择本轮模式。只读模式不阻止服务写自己的任务、日志和 Codex 运行状态。沙箱范围以 Codex 原生实现为准，不代表进程外所有能力均被限制。

## 调用方与部署责任

调用方决定哪些用户可以提交任务、哪些问题和上下文可以进入网关，以及哪些结果可以返回给最终用户。需要隔离不同信任域时，应部署不同实例、令牌、运行账户和 Codex home，不依赖 `sessionId`、任务 ID 或工作目录实现隔离。

部署环境决定 Codex 最终可以操作的宿主目录、数据库、SSH 主机、云服务和内部 MCP。服务将枚举传给 Codex 原生沙箱，而不实现自有命令黑名单。需要进一步限制某类能力时，在运行账户、容器、网络、外部系统账号或上游工具本身实施。

原生 `AGENTS.md` 和 skills 是任务行为说明，不是权限控制。外部文件、网页、日志和工具结果可能包含不可信指令，调用方应按自己的业务规则决定是否允许相关数据进入任务。

## 接入与秘密管理

`server.tokenEnv` 只保存环境变量名。跨网络访问使用 HTTPS，并配置准确的 `allowedHosts` 和 `allowedOrigins`。网页控制台使用独立的账号密码和进程内会话 Cookie，不向浏览器返回服务令牌；`localConsole` 不再提供自动取令牌功能。仓库本机示例的 `admin/admin` 仅限临时回环调试，部署前必须换成强密码，Docker 配置要求环境变量提供密码。

模型认证、代理和上游工具凭据由部署环境或秘密管理系统注入，只将任务确实需要的变量列入 `codex.envAllowlist`。不要把网关共享 Token 传给 Codex 工具，也不要将真实凭据写入仓库、示例、问题或 `context`。

`.env`、本机私有 YAML、`data/`、认证文件和运行日志不提交版本库。专用 Codex home 包含认证与原生会话；问题、`context`、结果和工具输出都会持久化，也可能含业务数据。运行目录及备份的访问控制和保留周期由部署方管理。

## 数据与验证

新记录为 `version: 2`，开发目录固定为 `data/native-logs-preview`，生产由 `CODEX_DATA_DIR` 指定。旧 v1 记录可查询，旧会话不能续接，旧 queued 不重跑。新目录隔离不是数据擦除，旧数据和备份需要单独管理。

发布前执行 `npm run release:check` 并人工审查文档、skills、原生配置和样例。自动检查只覆盖部分秘密模式。真实完整权限仍需在目标宿主验证，包括命令执行、文件写入、网络、Web 搜索和上游 MCP；Docker 尚未实跑，不宣称容器部署已经验收。

CI 还使用 [Gitleaks](https://github.com/gitleaks/gitleaks) 扫描 checkout 可达的完整 Git 历史，输出做 redaction。普通修复提交不能擦除旧提交中的秘密；发现有效凭据泄露时先轮换凭据，再处理历史。自动扫描不识别所有业务隐私，公开截图必须使用合成数据。
