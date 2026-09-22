# 示例项目

这是用于验证分析链路的公开示例，没有真实客户、服务器或密码。
`application.log` 中演示了租户筛选导致账号查询结果为空的请求。

`AGENTS.md` 提供原生项目分析约定，`.agents/skills/log-evidence/SKILL.md`
提供原生日志分析技能。将本目录用作任务工作目录后，由 Codex 自行发现它们，
无需在网关 YAML 中注册或读取 Skill 正文。问题中可显式写 `$log-evidence`。
