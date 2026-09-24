import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { TaskService } from '../src/service.js';
import { FileStore } from '../src/storage.js';
import { DemoRunner } from '../src/runner/demo.js';
import { createHttpApp } from '../src/api/http.js';
import type { AccountStatusProvider } from '../src/account.js';

let dir: string;
let service: TaskService;
let server: Server;
let base: string;
const token = 'test-token-with-at-least-24-characters';
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const accountStatus: AccountStatusProvider = {
  read: async force => ({
    available: true, authenticated: true, method: 'chatgpt', plan: 'pro', email: 'o******r@example.com',
    checkedAt: '2026-09-24T08:00:00.000Z',
    quota: { ordinaryUsageAllowed: true, primary: { usedPercent: force ? 41 : 40, remainingPercent: force ? 59 : 60, windowDurationMins: 10080, resetsAt: '2026-09-30T00:00:00.000Z' }, secondary: null },
    credits: { hasCredits: false, unlimited: false, balance: '0', availableResetCount: 2 },
    tokenUsage: { lifetimeTokens: 1000, peakDailyTokens: 500, longestRunningTurnSec: 20, currentStreakDays: 2, longestStreakDays: 3, daily: [] },
  }),
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-api-'));
  const config = await loadConfig(resolve('config/demo.yaml'));
  config.dataDir = dir;
  service = new TaskService(config, new FileStore(dir), new DemoRunner());
  await service.init();
  server = createHttpApp(service, token, accountStatus).listen(0, '127.0.0.1');
  await new Promise<void>(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

it('serves protected account status and supports a forced refresh', async () => {
  expect((await fetch(`${base}/v1/admin/account`)).status).toBe(401);
  const account = await (await fetch(`${base}/v1/admin/account`, { headers })).json();
  expect(account).toMatchObject({
    authenticated: true, plan: 'pro', quota: { primary: { remainingPercent: 60 } },
  });
  const refreshed = await (await fetch(`${base}/v1/admin/account/refresh`, { method: 'POST', headers, body: '{}' })).json();
  expect(refreshed.quota.primary.remainingPercent).toBe(59);
});
afterEach(async () => {
  await service.close();
  await new Promise<void>((resolve, reject) => { server.close(e => e ? reject(e) : resolve()); server.closeIdleConnections(); });
  await rm(dir, { recursive: true, force: true });
});

it('authenticates, validates inputs, rejects browser origins and supports an asynchronous HTTP task', async () => {
  expect((await fetch(`${base}/healthz`)).status).toBe(200);
  expect((await fetch(`${base}/v1/info`)).status).toBe(401);
  const info = await (await fetch(`${base}/v1/info`, { headers })).json();
  expect(info).toMatchObject({ accessMode: 'danger-full-access', readOnly: false, networkAccess: true, webSearch: 'live' });
  expect((await fetch(`${base}/v1/info`, { headers: { ...headers, Origin: 'https://untrusted.example' } })).status).toBe(403);
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: '{}' })).status).toBe(400);
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: '{' })).status).toBe(400);
  expect((await fetch(`${base}/v1/sessions?limit=999`, { headers })).status).toBe(400);
  const context = { subject: { account: 'demo-user', tenantId: 'tenant-demo-001' } };
  const response = await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ question: '查看日志', context }) });
  expect(response.status).toBe(202);
  const task = await response.json();
  expect(task.request.context).toEqual(context);
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ question: 'x', model: 'forbidden' }) })).status).toBe(400);
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ question: 'x', context: [] }) })).status).toBe(400);
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify({ question: 'x', context: { payload: 'x'.repeat(17 * 1024) } }) })).status).toBe(400);
  await new Promise(r => setTimeout(r, 350));
  const final = await (await fetch(`${base}/v1/tasks/${task.taskId}`, { headers })).json();
  expect(final.status).toBe('succeeded');
  expect(final.result.markdown).toContain('未调用 Codex');
});

it('serves a token-free console and accepts authenticated same-origin browser submissions', async () => {
  const page = await fetch(`${base}/`);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-type')).toContain('text/html');
  const html = await page.text();
  expect(html).toContain('CodexRelay');
  expect(html).toContain('账号额度');
  expect(html).not.toContain(token);
  const session = await fetch(`${base}/console/session`);
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ token, runner: 'demo' });
  expect((await fetch(`${base}/data/demo-access.json`)).status).toBe(401);
  const body = JSON.stringify({ question: 'Browser request' });
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...headers, Origin: base }, body })).status).toBe(202);
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body })).status).toBe(401);
});

it('serves discovery, submission, follow-up and errors to the official MCP client', async () => {
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(6);
    const submit = tools.tools.find(tool => tool.name === 'codex_submit_task')!;
    expect(Object.keys(submit.inputSchema.properties ?? {}).sort()).toEqual(['context', 'idempotencyKey', 'question', 'sessionId']);
    expect(submit.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(tools.tools.map(tool => tool.name)).toContain('codex_get_service_info');
    const first = await client.callTool({ name: 'codex_submit_task', arguments: { question: '为什么看不到数据' } });
    const task = (first.structuredContent as any).data;
    expect(task.sessionId).toMatch(/^sess_/);
    await new Promise(r => setTimeout(r, 350));
    const result = await client.callTool({ name: 'codex_get_task', arguments: { taskId: task.taskId } });
    expect((result.structuredContent as any).data.status).toBe('succeeded');
    const followup = await client.callTool({ name: 'codex_submit_task', arguments: { question: '角色有问题吗', sessionId: task.sessionId } });
    expect((followup.structuredContent as any).data.sessionId).toBe(task.sessionId);
    const missing = await client.callTool({ name: 'codex_get_task', arguments: { taskId: 'task_00000000-0000-4000-8000-000000000000' } });
    expect(missing.isError).toBe(true);
  } finally { await client.close(); }
});

it('does not disclose the service token when local console access is disabled or forwarded', async () => {
  for (const forwarded of [{ Forwarded: 'for=203.0.113.1' }, { 'X-Forwarded-For': '203.0.113.1' }]) {
    const response = await fetch(`${base}/console/session`, { headers: forwarded });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain(token);
  }
  Object.assign(service.config, { localConsole: false });
  const response = await fetch(`${base}/console/session`);
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain(token);
  expect((await fetch(`${base}/v1/health`, { headers })).status).toBe(200);
});

it('supports the backend integration example with a token, idempotency and follow-up', async () => {
  const { createCodexClient } = await import('../examples/backend-client.mjs');
  const client = createCodexClient({ url: base, token });
  const input = { question: 'Investigate', idempotencyKey: 'backend-example' };
  const first = await client.submit(input);
  expect((await client.submit(input)).taskId).toBe(first.taskId);
  expect((await client.wait(first.taskId, { timeoutMs: 5000, pollMs: 50 })).status).toBe('succeeded');
  const second = await client.submit({ ...input, sessionId: first.sessionId, idempotencyKey: 'backend-follow-up' });
  expect(second.sessionId).toBe(first.sessionId);
  await client.cancel(second.taskId);
  expect((await client.wait(second.taskId, { timeoutMs: 5000, pollMs: 50 })).status).toBe('cancelled');
  await expect(createCodexClient({ url: base, token: 'wrong-token-at-least-24-characters' }).getTask(first.taskId)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
});
