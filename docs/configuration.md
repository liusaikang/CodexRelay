# 配置与原生扩展

基础配置在启动时加载，修改服务 YAML 后需重启。固定使用 `config/development.yaml` 与 `config/production.yaml`；`npm run start:dev` 和 `npm run start:prod` 分别加载对应文件，`npm start` 也指向开发环境。配置中的相对路径以 YAML 所在目录为基准。工作目录始终只由服务 YAML 控制；模型和推理强度由 YAML 基础值或管理员保存的运行配置控制，任务请求不能覆盖。

## 控制台运行配置

登录网页控制台的“运行配置”页，可编辑并保存以下两类参数，无需重启：

- 即时应用：`maxConcurrent`、`maxQueued`、`timeoutSeconds`、`queueTimeoutSeconds`，以及新会话的默认模型和推理强度。提高并发上限会立即调度等待任务；降低并发上限不终止运行中的任务。已接收任务的队列期限、已运行任务的超时计时器、已有会话的模型和推理强度不会追溯修改。
- 专门处理：调用日志的 `enabled` 和 `retentionDays`。保存时切换日志记录状态并按新保留期清理；关闭日志不删除旧文件，重新开启不会补录关闭期间的调用。缩短保留期可能删除超期记录，界面会先确认。

控制台仅能通过登录会话修改这些白名单字段；服务 Bearer Token 不能用于配置接口。保存使用版本号防止覆盖其他管理员的修改。调整结果以原子写入方式保存在 `dataDir/runtime-settings.json`，重启后自动加载，独立于开发和生产两套数据目录。YAML 始终是基础值；控制台保存的运行配置优先生效。页面的“恢复基础值”只把表单填回当前 YAML 基础值，仍须点击保存。若要让重启后重新完全依照 YAML，停服后移除对应数据目录中的运行配置覆盖文件。

服务地址、端口、目录、工作目录、认证、凭证、执行策略等不在控制台展示或编辑，仍通过部署配置管理。运行配置文件与任务数据同样敏感，不应公开或提交仓库。单实例独占数据目录，不支持多个实例同时改写此文件。

## 服务配置

以下样例假定 YAML 位于仓库 `config/` 目录：

```yaml
dataDir: ../data/native-logs-preview
server:
  host: 127.0.0.1
  port: 8787
  tokenEnv: CODEX_MCP_TOKEN
  localConsole: true
  consoleAuth:
    username: admin
    password: admin
  allowedHosts: [localhost, 127.0.0.1, "[::1]"]
  allowedOrigins: []
tasks:
  maxConcurrent: 10
  maxQueued: 100
  timeoutSeconds: 600
  queueTimeoutSeconds: 1800
runner: codex
codex:
  home: ../data/codex-home
  defaultWorkingDirectory: ../examples/workspace
  defaultModel: ${CODEX_MODEL:-}
  defaultReasoningEffort: ${CODEX_MODEL_REASONING_EFFORT:-}
  # path: /absolute/path/to/codex
```

`runner` 只能选择 `codex` 或 `demo`。`codex.path` 可选，接受 CLI 可执行文件的绝对路径，也接受相对于 YAML 配置文件所在目录的路径，加载时通过 `resolve` 转为绝对路径；省略时使用 SDK 配套 CLI。Windows 指向真实可执行文件，不使用 `.ps1` 包装脚本。

`maxConcurrent` 控制全局执行名额，`maxQueued` 控制额外等待任务数；`maxQueued: 0` 表示只接收可立即运行的任务。`timeoutSeconds` 是服务端执行超时，不是客户端轮询超时。同一会话即使有空闲名额也只能串行，模型账号额度仍可能限制实际吞吐量。

`queueTimeoutSeconds` 控制等待期限，默认 1800 秒，范围 1 到 604800 秒。会话依赖等待、人工确认等待、停机时间均计入；修改配置不延长已接受任务的期限。接收阶段容量自动取 `maxConcurrent + maxQueued`，无需新增容量参数。详细状态与恢复策略见 [任务调度](scheduling.md)。

以上是开发环境示意，仅可在本机使用。生产配置要求环境变量明确指定任务目录、调用日志目录、Codex home、工作目录、控制台账号密码和公开访问来源。`codex.home` 是专用持久化目录，保存认证、原生配置和线程状态，不应直接使用开发者个人日常 home。`${VARIABLE}` 缺失时应报错；`${VARIABLE:-fallback}` 使用回退值。默认模型和推理强度展开为空表示未指定，由 Codex 采用原生默认值，不绑定某个模型名称。

新配置不存在 `projects`、`capabilities`、`promptFile`、`skillFiles`、`mcpServers`，也不再使用顶层 `codexHome` 或 `execution`。这些旧字段不是新结构的别名，应删除并迁移，不要混用。

## 调用日志

```yaml
invocationLog:
  enabled: true
  directory: ../data/invocation-logs
  retentionDays: 30
```

未显式配置时 `enabled` 默认关闭；固定的开发和生产配置都设置为 `true`。启用后，所有入口成功接受的新分析任务都会记录，来源为 `http`、`mcp` 或 `stdio`。`directory` 相对于 YAML 文件解析，支持环境变量；解析真实路径后必须与 `dataDir`、`codex.home` 分离。日志根目录及其内部不能是符号链接或目录联接；允许受信任的父级路径包含系统链接（如 macOS 临时目录），启动时固定父级的真实位置，后续不随别名改变而切换日志位置。`retentionDays` 取值 1–3650，默认 30 天。

日志以 UTC 提交日期分目录，每个任务一个 JSON 文件：`data/invocation-logs/YYYY-MM-DD/task_<uuid>.json`。记录用户提交的 `question`、可选 `context`、会话和任务 ID、来源、各阶段时间、状态、耗时、结果、用量及安全化错误。它不是 Codex 完整内部提示词、系统提示词或原生线程事件日志。幂等重试返回原任务，统计不会重复计数；轮询、鉴权失败、参数错误和队列满等未接受的请求不计入。

关闭后不新增、不读取、不清理调用日志，旧文件保留，控制台显示未启用。开关只影响这份可选日志；核心任务 JSON 和 Codex 线程依然保存问题与结果，用于恢复、查询和上下文。重新开启不补录关闭期间的新任务，只恢复曾标记记录的任务。启动及每小时清理超过保留天数的已结束日志文件，时间以任务提交时间为准，正在运行或排队的任务保留。核心任务和原生线程不参与此清理。

日志不收集认证请求头、服务令牌、认证文件或环境变量。用户主动传入问题/上下文或 Codex 回答中的敏感内容仍会原样保存，调用方应在提交前脱敏。默认 `data/` 已被 Git 忽略；自定义目录也应排除在提交和公开静态目录之外。Unix 新文件使用 `0600`、新目录使用 `0700`，Windows 使用部署账户的文件 ACL。

日志写入失败不会把成功任务改成失败，控制台通过 `healthy: false` 标记记录可能不完整，修复目录并重启后从核心任务恢复尚在保留期的已标记记录。单实例文件存储会加载保留期内的记录到内存，保留天数应结合调用量配置；不支持多个实例共用日志目录。

## 请求与默认值

新会话始终使用 `codex.defaultWorkingDirectory`、`codex.defaultModel` 和 `codex.defaultReasoningEffort`。默认工作目录必须存在并且运行账户可访问。

已有会话使用创建时保存的目录、模型和推理强度，服务默认值后续变化不会悄悄改写旧会话。需要采用新执行配置时创建新会话。

请求只接受 `question`、`context`、`sessionId`、`idempotencyKey`，不接受超时、执行目录、模型、推理强度、环境变量、CLI 路径、Codex home、原生配置或 sandbox 覆盖。执行策略固定为 `danger-full-access`、approval `never`、network enabled、实时 Web 搜索开启；服务 YAML 不提供权限裁剪选项。

## 原生 Skills 与项目说明

原生示例位于 `examples/workspace/.agents/skills/log-evidence/SKILL.md`，项目说明位于 `examples/workspace/AGENTS.md`。接入新工作目录时，在该目录内维护 `AGENTS.md` 与 `.agents/skills/<名称>/SKILL.md`。

最小 skill 文件示意：

```markdown
---
name: log-evidence
description: 分析日志问题时关联源码与请求上下文，输出证据及不确定性。
---

先确认日志时间和请求标识，再关联源码。区分事实、推断与缺失证据。
```

网关不读取、扫描、拼接、注册或路由这些 skill。Codex 负责原生发现和使用；不要把 skill 正文重新合并为网关 developer instructions。目录必须是 `.agents`，不是 `.agent`。仓库级发现沿任务工作目录向上到仓库根目录，不会递归发现任意 service 源目录中的 skill。格式与发现规则以 [官方 Build skills](https://learn.chatgpt.com/docs/build-skills) 为准。

原生 skill 不是强制工具调用机制或安全边界；发现或装载成功不等于指定工具必定执行。网关给予 Codex 完整执行能力，上游 MCP 权限由接入方和部署环境决定，详见 [安全说明](../SECURITY.md)。

## 原生 MCP 与环境

管理员在专用 `codex.home` 下的 `config.toml` 中配置上游 MCP，而不是在服务 YAML 或请求中传入。下面是原生 TOML 片段，工具名称与地址需按实际服务替换：

```toml
[mcp_servers.evidence]
url = "https://evidence.example.internal/mcp"
bearer_token_env_var = "EVIDENCE_MCP_TOKEN"
enabled_tools = ["query", "search_logs", "manage_service"]
```

默认会向 Codex 运行环境传递 `CODEX_API_KEY`、`HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY`。将 `EVIDENCE_MCP_TOKEN` 这类额外变量加入 `codex.envAllowlist`，并由秘密管理系统或部署环境提供值。白名单还可按需加入其他明确需要的模型、代理或工具变量；不要通配继承业务后端环境，更不要把网关共享 Token 传给模型工具。`CODEX_API_KEY` 与 `server.tokenEnv` 指向的服务访问令牌用途不同。

任务允许本地命令联网并启用实时 Web 搜索。模型传输、代理、上游 MCP、SQL、日志和 SSH 的认证与可达性仍由部署环境配置；网关不对这些能力追加只读过滤。

管理员需维护专用 home、默认工作目录及可生效的原生配置、skills、插件和工具。默认工作目录用于项目上下文，不限制 Codex 对宿主机其他路径和命令的访问；真实范围由服务进程所在的运行环境决定。

## HTTP 接入边界

`server.consoleAuth` 配置网页控制台用户名和密码，密码可使用环境变量占位符；缺省时不允许网页登录。开发配置仅供本机使用 `admin/admin`，生产配置要求环境变量提供独立账号密码，不要将开发密码用于对外服务。网页登录会话保存在进程内，8 小时后失效，重启也会失效；退出登录立即撤销当前会话。跨网络部署使用 HTTPS 反向代理，并将实际域名和必要的准确 Origin 加入相应白名单。

`localConsole` 是旧配置兼容字段，不再提供自动取令牌功能。网页使用 HttpOnly、SameSite=Strict Cookie，写请求还要求同源 Origin；业务 HTTP/MCP 不接受网页 Cookie 代替其 Bearer Token。Origin 校验不是用户授权，也不代表提供任意跨域 CORS 接入。

该网关使用单共享 Token，不提供复杂 RBAC、目录级授权或多租户隔离。可信后端负责访问任务结果的权限、`context` 数据最小化及敏感信息脱敏。
