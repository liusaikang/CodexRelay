---
name: log-evidence
description: Investigate application errors, correlate error and info logs with source code, and report evidence-backed root causes within a bounded time window.
---

检索日志时避免读取整个大型文件；优先按时间、模块、请求 ID 和异常关键词定位。
保留异常堆栈的多行上下文。需要 info 日志时使用同一时间窗口和关联 ID。
引用文件名、时间及可用行号。扫描截断、轮转缺失、时区不明时明确声明覆盖范围。
数据库和 SSH 工具由部署管理员提供，本 skill 不携带连接信息或凭据。

按根因合并重复异常，保留发生次数、首次/末次时间、证据位置和影响范围。
已知可忽略规则必须匹配具体条件；对新现象、影响扩大或证据不足的问题保留说明。
输出结论、证据、可能原因、影响、建议和待核实事项，区分事实和推测。
