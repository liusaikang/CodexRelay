import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const demo = process.argv.includes('--demo');
const access = demo ? JSON.parse(await readFile(new URL('../data/demo-access.json', import.meta.url), 'utf8')) : undefined;
const base = access?.url ?? process.env.CODEX_MCP_URL ?? 'http://127.0.0.1:8787';
const token = access?.token ?? process.env.CODEX_MCP_TOKEN;
if (demo && base !== 'http://127.0.0.1:8787') throw new Error('Demo smoke only supports loopback');
if (!token) throw new Error('Set CODEX_MCP_TOKEN before running smoke test');
const client = new Client({ name: 'codex-mcp-smoke', version: '0.1.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal((await client.listTools()).tools.length, 6);
  const submit = await client.callTool({ name: 'codex_submit_task', arguments: {
    question: '请只读查看 application.log，分析示例账号为什么看不到订单，并给出证据。', idempotencyKey: randomUUID(),
  } });
  assert.ok(!submit.isError, JSON.stringify(submit.content));
  const first = submit.structuredContent.data;
  console.log(JSON.stringify({ taskId: first.taskId, sessionId: first.sessionId }));
  const deadline = Date.now() + 650000;
  let finished = false;
  while (Date.now() < deadline) {
    const queried = await client.callTool({ name: 'codex_get_task', arguments: { taskId: first.taskId } });
    assert.ok(!queried.isError, JSON.stringify(queried.content));
    const task = queried.structuredContent.data;
    if (!['queued', 'running'].includes(task.status)) {
      console.log(JSON.stringify({ status: task.status, result: task.result, error: task.error }, null, 2));
      assert.equal(task.status, 'succeeded'); finished = true; break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(finished, 'Smoke deadline exceeded; query or cancel the returned taskId');
} finally { await client.close(); }
