# 已知现象（合成示例）

`module=metrics` 且 `code=OPTIONAL_METRICS_TIMEOUT` 只在以下证据同时满足时不列为待修复问题：

- 同一 requestId 的后续记录明确显示重试成功。
- 仅失败一次且没有影响业务请求。

其他错误不能使用此规则忽略。仍需在报告中注明忽略的数量及依据。
