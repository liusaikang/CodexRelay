import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// Import this helper in a trusted backend. Never bundle its token into a browser app.
export function createCodexClient({ url, token }) {
  const base = new URL(url);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Use an HTTP(S) service URL without credentials, query or fragment');
  if (!token || token.length < 24) throw new Error('A service bearer token is required');
  async function request(path, { method = 'GET', body, signal } = {}) {
    const response = await fetch(new URL(path, base), {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json();
    if (!response.ok) {
      throw Object.assign(new Error(payload.error?.message ?? `HTTP ${response.status}`), { code: payload.error?.code, status: response.status });
    }
    return payload;
  }
  const taskPath = taskId => {
    if (!/^task_[0-9a-f-]{36}$/.test(taskId)) throw new Error('Invalid task ID');
    return `/v1/tasks/${taskId}`;
  };
  return {
    submit: (input, signal) => request('/v1/tasks', { method: 'POST', body: { ...input, idempotencyKey: input.idempotencyKey ?? randomUUID() }, signal }),
    getTask: (taskId, signal) => request(taskPath(taskId), { signal }),
    cancel: (taskId, signal) => request(`${taskPath(taskId)}/cancel`, { method: 'POST', signal }),
    async wait(taskId, { timeoutMs = 650000, pollMs = 2000, signal } = {}) {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(pollMs) || pollMs <= 0) throw new Error('Polling intervals and deadlines must be positive');
      const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      for (;;) {
        const task = await request(taskPath(taskId), { signal: deadline });
        if (!['queued', 'running'].includes(task.status)) return task;
        await delay(pollMs, undefined, { signal: deadline });
      }
    },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    question: { type: 'string', default: '请分析 logs/error.txt 中的错误，关联 info.txt 和源码，列出证据、根因及需要处理的问题。已知可忽略条件见 known-issues.md。' },
    context: { type: 'string' }, session: { type: 'string' },
    'inline-example': { type: 'boolean', default: false },
  } });
  const client = createCodexClient({ url: process.env.CODEX_MCP_URL || 'http://127.0.0.1:8787', token: process.env.CODEX_MCP_TOKEN });
  const idempotencyKey = randomUUID();
  const question = values.question;
  let context;
  if (values.context) {
    context = JSON.parse(values.context);
    if (!context || Array.isArray(context) || typeof context !== 'object') throw new Error('--context must contain a JSON object');
  }
  if (values['inline-example']) {
    const files = ['logs/error.txt', 'logs/info.txt', 'src/orders.mjs', 'known-issues.md'];
    const evidence = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(new URL(`workspace/${file}`, import.meta.url), 'utf8')])));
    context = { ...context, syntheticEvidence: evidence };
  }
  console.log(JSON.stringify({ idempotencyKey }));
  const task = await client.submit({ question, ...(context ? { context } : {}),
    ...(values.session ? { sessionId: values.session } : {}), idempotencyKey });
  console.log(JSON.stringify({ taskId: task.taskId, sessionId: task.sessionId }));
  const final = await client.wait(task.taskId);
  console.log(final.result?.markdown ?? JSON.stringify({ status: final.status, error: final.error }));
  if (final.status !== 'succeeded') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.code ?? error.name, error.message); process.exitCode = 1; });
}
