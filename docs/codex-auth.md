# Codex 登录与额度

## 三种认证各管什么

| 认证 | 使用方 | 配置位置 |
| --- | --- | --- |
| 控制台用户名和密码 | 运维人员登录网页 | 开发 YAML / 生产环境变量 |
| 服务 Bearer Token | 应用后端或 MCP 客户端 | `CODEX_MCP_TOKEN` |
| Codex 模型认证 | 执行任务的 Codex CLI / SDK | 配置中的 `codex.home` 或 `CODEX_API_KEY` |

控制台显示“已连接”只说明连接了 CodexRelay；模型是否已登录要看“账号额度”。浏览器登录不会替服务器完成 Codex 登录。

ChatGPT 账号登录和 API Key 是 Codex 支持的两种方式。账号登录是否可用取决于账号权限；没有 API Key 时可使用设备码登录。认证缓存位置由 Codex 的 `cli_auth_credentials_store` 决定：文件方式保存在 `CODEX_HOME/auth.json`，也支持系统凭据存储。参考 [OpenAI 官方认证说明](https://developers.openai.com/codex/auth/)。

## 本机开发

先完成 `npm ci`、`npm run init:env`、`npm run build`。以下命令适用于 Windows PowerShell、macOS 和 Linux：

```sh
npm run codex:auth -- login
npm run codex:auth -- status
```

命令读取 `config/development.yaml`，在终端显示解析后的配置文件和 Codex home 路径，再启动项目依赖中自带的 CLI。登录使用设备码；在浏览器打开 CLI 显示的地址完成授权。命令不会启动 CodexRelay，也不会提交模型任务。

默认开发 home 是仓库下 `data/codex-home`。已在个人桌面客户端登录，不代表这个目录也已经登录。无需将个人 home 整体复制进项目。

如果设备码登录不可用，按官方文档检查账号设置；也可在同一个 home 下使用原生 `codex login` 的浏览器登录方式。不要登录其他 home 后误以为服务已经认证。

## Node.js 生产部署

先按 [部署文档](deployment.md#原生生产环境) 补全生产环境变量，然后执行：

```sh
npm run codex:auth -- login --config config/production.yaml
npm run codex:auth -- status --config config/production.yaml
npm run check:prod
npm run start:prod
```

`codex:auth` 与服务共用配置解析器，遵循自定义 `codex.path`。它不会读取任务数据或更改队列，配置错误会先报告错误，不会退回个人默认目录。`status` 返回 CLI 的退出码：未登录时非零属于正常诊断结果。

## Docker Compose

```sh
docker compose build
docker compose run --rm codex-mcp node dist/cli/auth.js login --config config/production.yaml
docker compose run --rm codex-mcp node dist/cli/auth.js status --config config/production.yaml
docker compose up -d
```

容器的 home 是 `/data/codex-home`，位于 `codex-state` 持久卷中。无需把电脑上的认证文件放入镜像。已有容器运行时，可用 `docker compose exec codex-mcp node dist/cli/auth.js status --config config/production.yaml` 查看状态。

如果自定义 `config.toml` 使用系统 keyring，而容器没有该设施，按官方说明选择文件凭据存储，并在登录和执行期间保持一致。不要将 `auth.json`、卷备份或设备码提交到仓库。

## 查看额度

登录控制台后打开“账号额度”。本项目通过本地 Codex app-server 查询当前账号及上游返回的限额，不从密码文件中推算额度。

| 字段 | 解读 |
| --- | --- |
| 账号 / 套餐 | 当前服务使用的模型身份，邮箱经过遮蔽 |
| 剩余百分比 | 上游已用比例的补数，限定在 0–100% |
| 重置时间 | 上游返回的窗口重置时间 |
| `—` / 状态不可用 | 上游没有返回或查询失败，不等于额度为零 |
| 任务 Token 用量 | 单次执行的 SDK 用量，不等于账号剩余额度 |

普通查询缓存 30 秒；点击刷新会主动查询。账号查询中的任一上游请求失败时，本版本可能整体显示不可用，此时先检查同一 home 的 `status`、服务网络和 CLI 版本。额度面板失败不能单独证明模型无法执行。

这些额度属于账号，可能与其他设备和任务共享。API Key 身份不应被当作 ChatGPT 订阅额度展示。面板仅供查看，不自动切换账号、购买额度或调整并发；并发设为 30 也不意味着账号能同时处理 30 个请求。

## 重建和迁移

任务目录和 Codex home 要一起备份：前者保存任务与会话映射，后者保存原生线程及认证。仅恢复任务 JSON 可能能看历史回答，却无法续接原生会话。

更换账号或凭据后，在任务空闲时重启服务，再刷新账号面板，避免复用旧 app-server 的内存状态。容器正常重建保留命名卷；不要用删除卷来解决登录问题。
