# 开发与扩展

CodexRelay 是面向可信业务后端的原生 Codex SDK 任务网关。网关负责认证、调度、会话和持久化，Codex 负责原生项目上下文与工具使用；不要在核心执行器中加入企业业务规则或自建 skill 路由。

## 接入新场景

在服务配置的默认工作目录中维护项目说明 `AGENTS.md`，新增原生 skill 放在 `.agents/skills/<名称>/SKILL.md`。示例为 `examples/workspace/AGENTS.md` 和 `examples/workspace/.agents/skills/log-evidence/SKILL.md`。

目录是 `.agents`，不是 `.agent`。仓库级 skill 发现沿任务工作目录向上到仓库根目录，不是任意 service 源目录。service 不扫描、拼接、注册或路由 skill，不把其正文合并成自制 developer instructions。

原生 skill 是供模型使用的工作流说明，不是强制工具调用机制，也不是安全边界。安装、发现或显式提及 skill，都不能作为指定工具必定执行、证据已经读取或权限已限制的证明。需要确定性执行或强制校验的环节，应由受控程序或工具服务实现并验证，不能仅依赖 skill 文本。

新数据源按 Codex 原生方式在专用 `codex.home/config.toml` 配置 MCP，必要凭据变量加入 `codex.envAllowlist`，值由部署环境注入。上游 MCP 的能力与权限由接入方和部署环境负责。详细边界见 [SECURITY.md](SECURITY.md)。

## 保持接口契约

服务 YAML 使用 `dataDir`、`server`、`tasks`、顶层 `runner` 和 `codex`。不恢复旧 `projects`、`capabilities`、`promptFile`、`skillFiles` 或 `mcpServers` 配置；迁移后的结构见 [配置文档](docs/configuration.md)。

提交契约严格限定为必填 `question`，以及可选 `context`、`sessionId`、`idempotencyKey`、`sandboxMode`。`context` 必须是最多 16 KiB 的 JSON 对象；工作目录、模型和推理强度只能由服务配置决定。`sandboxMode` 使用 SDK 原生枚举，请求省略时采用服务默认值，任务接收后固定，重试保留原值。审批保持 `never`，权限范围见 [接口说明](docs/http-api.md#sandboxmode)。

HTTP 与 MCP 共享任务语义，服务信息使用 `/v1/info` 和 `codex_get_service_info`，MCP 保持六个工具。共享 Token 只面向可信后端，不把目录参数或会话 ID 当作用户授权，不宣称复杂 RBAC 或多租户隔离。

## 调度与数据兼容

默认全局并发 10、等待队列 100、执行超时 600 秒。同一会话始终串行；Runner 只能在执行进程真正退出后释放名额，取消和超时也不能例外。调整调度时覆盖队列满、幂等冲突、同会话追问和进程慢退出。

新任务及会话写入 `version: 2`，默认 `data/native-service`。保留 v1 记录查询，但不继续旧会话、不重跑旧 queued，不删除旧数据。存储变更需验证重启、遗留 running 中断、v2 排队恢复、实例锁、损坏文件与写入失败，不靠清空数据规避兼容问题。

## 开发验证

在仓库根目录执行，Windows 可使用 `npm.cmd`：

```sh
npm ci
npm run verify
npm run release:check
```

单元和集成测试使用合成日志、假账号与受控替身，不依赖私人认证或外部付费模型。协议变更覆盖实际 HTTP/MCP 调用；原生 skill 发现、真实文件读取、SDK 会话续接和目标宿主权限另做验收，不能用替身或 demo 测试代替。

客户端使用可选 `--context`，保留 `--inline-example`；上下文直传成功不代表 Codex 自动读取文件或使用 skill 成功。新增验证记录到 [verification.md](docs/verification.md)，注明执行环境、命令、证据来源及未覆盖项，不重复沿用旧方案的通过次数。

测试覆盖 SDK 替身、HTTP、MCP、stdio、请求参数与权限枚举、登录目录隔离和旧记录兼容。每次修改后重新执行检查；当前结果统一维护在 [验证说明](docs/verification.md)。容器检查脚本不调用真实模型，不能代替目标部署环境的真实认证与执行验证。

公开截图通过 `npm run docs:screenshots` 生成，使用受控合成数据，不连接真实服务。浏览器脚本默认使用 Chromium；本机可设置 `BROWSER_CHANNEL=msedge`。图像直接提交到 `docs/images`，不走 Git LFS。

## 发布要求

检查文档示例、原生配置和 skills 中的敏感数据；不要提交 `.env`、认证资料或业务日志。发布前检查不保证检出所有秘密，仍需人工审查。

本项目使用 [MIT 许可证](LICENSE)。`private: true` 用于防止误发 npm；添加依赖时仍应检查其许可证与分发要求。发布前按 [检查表](docs/release-plan.md) 记录实际验收结果。
