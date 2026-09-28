# 运行、备份与迁移

## 运行方式

Windows 可在 PowerShell 启动并用 Ctrl+C 正常退出。真实任务固定使用 `danger-full-access`、approval `never`、network enabled 和实时 Web 搜索；不提供请求级权限切换。运行账户和容器拥有什么权限，由部署方决定。

需要登录认证时，在仓库根目录为服务使用专用 home：

```powershell
New-Item -ItemType Directory -Force .\data\codex-home | Out-Null
$env:CODEX_HOME = (Resolve-Path .\data\codex-home).Path
node node_modules/@openai/codex/bin/codex.js login
```

这只设置当前终端环境。最终目录必须与所选环境 YAML 中的 `codex.home` 一致：开发配置固定使用 `../data/codex-home`，生产配置必须显式设置 `CODEX_HOME`。使用 `CODEX_API_KEY` 时可按账户认证方式省略登录，且应将变量列入 `codex.envAllowlist`。不要把个人认证目录打包进镜像。

Linux 服务管理可使用 systemd，路径按部署实际调整：

```ini
[Unit]
Description=CodexMCP native task gateway
After=network-online.target

[Service]
Type=simple
User=codexmcp
WorkingDirectory=/opt/codex-mcp
EnvironmentFile=/etc/codex-mcp.env
ExecStart=/usr/bin/node /opt/codex-mcp/dist/main.js --config /opt/codex-mcp/config/production.yaml
KillMode=control-group
TimeoutStopSec=30
Restart=no

[Install]
WantedBy=multi-user.target
```

该示例不是 Linux 部署通过记录。环境文件仅向运行账户与管理员开放；单实例运行，不用 PM2 cluster 或多个服务共享 `dataDir`。修改 YAML 后重启，按实际原生配置规则应用 Codex home 配置变更。

## 数据布局

开发环境目录示例：

```text
data/native-logs-preview/
  instance.lock
  sessions/sess_<uuid>.json
  tasks/task_<uuid>.json
data/invocation-logs/
  YYYY-MM-DD/task_<uuid>.json
data/codex-home/
  config.toml
  sessions/...
  ...Codex 管理的认证与状态
```

开发配置指向现有 `data/native-logs-preview`，生产配置要求独立的 `CODEX_DATA_DIR`、`CODEX_INVOCATION_LOG_DIR` 和 `CODEX_HOME`；新任务和会话写入 `version: 2`。`codex.home` 保存原生线程和认证，任务 JSON 不是完整模型上下文的替代品。数据记录版本与 HTTP `/v1/` 路径无关。

问题、结果、原生日志和工具输出可能含敏感业务信息。限制运行目录权限，Windows 设置专用 ACL；备份按含凭据资料保护，不上传到公开仓库或文档。

## 备份与恢复

1. 停止接受新任务并正常关闭服务，确认所有 worker 已退出。
2. 备份完整 `dataDir`、专用 `codex.home`、服务 YAML，以及任务工作目录内的 `AGENTS.md`、`.agents/skills` 和必要证据。秘密单独受控保存。
3. 恢复时保持目录、原生配置和账户权限一致，再检查实例锁及记录版本。
4. 启动后核对历史查询、新任务与 v2 会话续接，记录实际结果。

不要只复制任务 JSON 而丢弃 Codex 线程文件。不要将目录或模型变更伪装成旧会话续接。单文件原子写入不提供多文件事务保证；损坏文件应从备份修复，不能静默跳过。

## 从旧 v1 升级

生产目录与开发数据隔离，不会自动删除、移动或汇总其他目录。迁移前以旧配置实际 `dataDir` 为准，不假设所有历史实例都使用同一路径。

| 记录 | 升级后的处理 |
| --- | --- |
| v1 任务与会话 | 保留查询和历史结果 |
| v1 会话追问 | 拒绝续接，改为创建新 v2 会话 |
| v1 queued | 不恢复执行、不自动重跑 |
| 遗留 running | 不重跑，按恢复规则记录中断 |
| 新任务和会话 | 写入 version 2 |
| v2 queued | 仅通过新版本恢复校验后可调度 |

需要查询旧历史时，先停旧实例并备份。由管理员明确让兼容读取逻辑加载包含 v1 记录的 `dataDir`；建议在停机备份副本上验收，再选择使用该存储。任何配置都不会跨目录读取历史。不要让两个进程共用目录，不手工拼接不同实例的记录或改写版本号。

旧 v1 queued 不会启动 worker；调度恢复检查将其标为 `failed`，记录 `LEGACY_SESSION` 错误并保留历史。如果排队截止时间已经过去，则先标记 `timed_out` / `QUEUE_EXPIRED`。旧会话续接请求返回 `LEGACY_SESSION`（HTTP 409）。需要重新执行的问题由调用方显式提交新任务，使用新会话和新幂等键；这可能产生新的模型费用。

旧会话不能通过复制 thread ID、换版本号、补目录字段等方式强行继续。保留旧原始备份，不执行清空数据目录或删除卷来解决兼容问题。

## 故障处理

- 正常停止：停止接收新任务，结束 worker，保留可恢复的 v2 排队记录；运行任务按关停规则中断，正常释放实例锁。
- 异常退出：先根据锁和 OS 进程信息确认原服务与全部子进程已退出，再备份并处理遗留锁。不能只按 PID 看起来不存在就忽略主机差异。
- 重启：不自动重跑 running，不调度 v1 queued；只有通过恢复校验的 v2 queued 可以继续。
- 存储失败：停止不安全的调度并拒绝新提交，处理磁盘、权限或损坏记录后再启动，不能伪报成功。
- 取消或超时：先中断 SDK，必要时终止进程树；无法确认退出时不能释放名额。
- 客户端断连：已接受任务继续存在，查询 taskId；重试提交保持原幂等键和参数。

v2 会话失败后可能保留部分原生上下文，后续追问不是精确断点恢复。服务不自动重试模型错误。

数据规模增长时监控文件数与内存。归档在停机后按完整会话及上下文进行，保留备份；移走历史记录也可能移走对应幂等去重记录，不能在线删除在用文件。

## 验收与排障

`npm run verify`、`npm run smoke`、`npm run smoke:demo` 和部署检查均需由执行者记录命令、环境及结果，不因文档列出命令而视为通过。真实 smoke 可能使用模型额度。

重点检查：四字段提交契约、模型继承与切换拒绝、六工具与 `/v1/info`、取消后无遗留进程、原生 skill 发现、本地命令和文件操作、网络、实时 Web 搜索、远端工具能力，以及 v1 查询和禁止重跑。

`--inline-example` 成功只能证明给定证据的分析链路，不能替代真实文件读取验收。Windows 的验证不能替代 Linux 宿主验收。Docker 尚未实跑，详细待验证项见 [验收记录](verification.md)。
