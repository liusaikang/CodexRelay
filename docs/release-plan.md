# Open-source readiness checklist

Scope: preserve existing task fields and add optional native SDK sandboxMode, while keeping development storage and the single-instance scheduler. Package the service for other operators, document its actual behavior, and expose queue operations in the console.

- [x] Docker and environment setup: production config in image, bundled CLI login, persistent state, container smoke test. Image execution awaits Docker-enabled CI.
- [x] Neutral README and public examples: no organization-specific paths, accounts, endpoints or operational records.
- [x] Separate MCP connection and HTTP API guides with executable examples.
- [x] Architecture diagram and console screenshots generated only from synthetic fixtures.
- [x] Cross-platform CI, container validation and history-aware secret scanning.
- [x] Queue browser, task cancellation and explicit retry with regression tests, including reload deduplication and late-response handling.

Retry creates a new session with the original question/context, a new task ID and a link to the original failed task. Original records and their idempotency keys remain unchanged. It does not release blocked follow-ups in the original session. Repeating the same retry request uses a dedicated idempotency key.

Verification: typecheck, unit/integration tests, browser tests at desktop/mobile sizes, release scan and container build/smoke when Docker is available. Report unavailable checks explicitly. Do not publish, push, or run real Codex tasks as part of screenshots or CI.
