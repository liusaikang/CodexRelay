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
import type { AccountStatusProvider, CodexLoginProvider } from '../src/account.js';

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
const codexLogin: CodexLoginProvider = {
  status: () => ({ status: 'idle' }),
  start: async () => ({ status: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' }),
  cancel: async () => ({ status: 'idle' }),
};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'codex-api-'));
  const config = await loadConfig(resolve('config/demo.yaml'));
  config.dataDir = join(dir, 'core');
  config.invocationLog = { enabled: true, directory: join(dir, 'logs'), retentionDays: 30 };
  service = new TaskService(config, new FileStore(config.dataDir), new DemoRunner());
  await service.init();
  server = createHttpApp(service, token, accountStatus, codexLogin).listen(0, '127.0.0.1');
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

it('allows Codex login only from an authenticated same-origin console session', async () => {
  const path = `${base}/console/codex-login`;
  expect((await fetch(path)).status).toBe(401);
  expect((await fetch(`${path}/start`, { method: 'POST', headers })).status).toBe(403);
  const login = await fetch(`${base}/console/login`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect((await fetch(path, { headers: { Cookie: cookie } })).status).toBe(200);
  expect((await fetch(`${path}/start`, { method: 'POST', headers: { Cookie: cookie } })).status).toBe(403);
  const browserHeaders = { Cookie: cookie, Origin: base };
  expect(await (await fetch(`${path}/start`, { method: 'POST', headers: browserHeaders })).json()).toMatchObject({ status: 'pending', userCode: 'ABCD-EFGH' });
  expect(await (await fetch(`${path}/cancel`, { method: 'POST', headers: browserHeaders })).json()).toMatchObject({ status: 'idle' });
});

it('accepts native sandbox modes over HTTP and MCP and rejects unknown values', async () => {
  service.config.sandboxMode = 'read-only';
  expect(await (await fetch(`${base}/v1/info`, { headers })).json()).toMatchObject({ accessMode: 'read-only', readOnly: true });
  const accepted = await fetch(`${base}/v1/tasks`, { method: 'POST', headers,
    body: JSON.stringify({ question: 'Analyze', sandboxMode: 'danger-full-access' }) });
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({ sandboxMode: 'danger-full-access', request: { sandboxMode: 'danger-full-access' } });
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers,
    body: JSON.stringify({ question: 'Analyze', sandboxMode: 'readonly' }) })).status).toBe(400);
  const client = new Client({ name: 'sandbox-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    const info = await client.callTool({ name: 'codex_get_service_info', arguments: {} });
    expect(info.structuredContent).toMatchObject({ data: { accessMode: 'read-only', readOnly: true } });
    const allowed = await client.callTool({ name: 'codex_submit_task', arguments: { question: 'Analyze', sandboxMode: 'workspace-write' } });
    expect(allowed.structuredContent).toMatchObject({ data: { sandboxMode: 'workspace-write' } });
    const rejected = await client.callTool({ name: 'codex_submit_task', arguments: { question: 'Analyze', sandboxMode: 'invented' } });
    expect(rejected.isError).toBe(true);
    expect(service.listSessions(0, 20).total).toBe(2);
  } finally { await client.close(); }
});

it('accepts optional per-turn system prompts over HTTP and MCP', async () => {
  const posted = await fetch(`${base}/v1/tasks`, { method: 'POST', headers,
    body: JSON.stringify({ question: 'Inspect this issue', systemPrompt: 'Cite evidence' }) });
  expect(posted.status).toBe(202);
  expect(await posted.json()).toMatchObject({ request: { systemPrompt: 'Cite evidence' } });
  const empty = await fetch(`${base}/v1/tasks`, { method: 'POST', headers,
    body: JSON.stringify({ question: 'Inspect another issue', systemPrompt: null }) });
  expect(empty.status).toBe(202);
  expect((await empty.json()).request).not.toHaveProperty('systemPrompt');
  const client = new Client({ name: 'prompt-test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } }));
    const submitted = await client.callTool({ name: 'codex_submit_task', arguments: { question: 'Inspect via MCP', systemPrompt: 'Report uncertainty' } });
    expect(submitted.structuredContent).toMatchObject({ data: { request: { systemPrompt: 'Report uncertainty' } } });
  } finally { await client.close(); }
});

it('protects task listing and validates retry requests without widening submission fields', async () => {
  expect((await fetch(`${base}/v1/tasks`)).status).toBe(401);
  expect((await fetch(`${base}/assets/queue.js`)).status).toBe(401);
  expect((await fetch(`${base}/v1/tasks?status=invalid`, {headers})).status).toBe(400);
  expect((await fetch(`${base}/v1/tasks?limit=101`, {headers})).status).toBe(400);
  const task = await service.submit({question:'retry fixture'});
  await service.cancel(task.taskId);
  for (let i = 0; i < 100 && service.getTask(task.taskId).status === 'running'; i++) await new Promise(resolve => setTimeout(resolve,10));
  const url = `${base}/v1/tasks/${task.taskId}/retry`;
  expect((await fetch(url,{method:'POST'})).status).toBe(401);
  expect((await fetch(url,{method:'POST',headers,body:'{}'})).status).toBe(400);
  const body = JSON.stringify({idempotencyKey:'test-retry'});
  const first = await fetch(url,{method:'POST',headers,body});
  expect(first.status).toBe(202);
  const retried = await first.json();
  expect(retried.retryOfTaskId).toBe(task.taskId);
  expect((await (await fetch(url,{method:'POST',headers,body})).json()).taskId).toBe(retried.taskId);
  const listing = await (await fetch(`${base}/v1/tasks?status=all&keyword=${task.taskId}`,{headers})).json();
  expect(listing.total).toBe(1);
  expect(listing.items[0].request).toBeUndefined();
});

it('limits live settings to the console session and applies validated changes', async () => {
  const url = `${base}/console/settings`;
  expect((await fetch(url)).status).toBe(401);
  expect((await fetch(`${base}/assets/settings.js`)).status).toBe(401);
  expect((await fetch(url, { headers })).status).toBe(403);
  const login = await fetch(`${base}/console/login`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  expect((await fetch(`${base}/assets/settings.js`, { headers: { Cookie: cookie } })).status).toBe(200);
  const browserHeaders = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
  const original = await (await fetch(url, { headers: browserHeaders })).json();
  expect(original).toMatchObject({ revision: 0, settings: { invocationLog: { enabled: true } } });
  expect(original.settings.activeProvider).toBe('openai');
  expect(original.providers).toMatchObject([{ id: 'openai', label: 'OpenAI / Codex', defaultModel: null, baseUrl: null }]);
  expect(JSON.stringify(original)).not.toContain(token);
  const settings = { ...original.settings, maxConcurrent: 3 };
  expect((await fetch(url, { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: 0, settings }) })).status).toBe(403);
  expect((await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ revision: 0, settings }) })).status).toBe(403);
  expect((await fetch(url, { method: 'PUT', headers: browserHeaders,
    body: JSON.stringify({ revision: 0, settings: { ...settings, dataDir: '/secret' } }) })).status).toBe(400);
  expect((await fetch(url, { method: 'PUT', headers: browserHeaders,
    body: JSON.stringify({ revision: 0, settings: { ...settings, activeProvider: 'unconfigured' } }) })).status).toBe(400);
  const saved = await fetch(url, { method: 'PUT', headers: browserHeaders, body: JSON.stringify({ revision: 0, settings }) });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ revision: 1, settings: { maxConcurrent: 3 } });
  expect(service.info().maxConcurrent).toBe(3);
  expect((await fetch(url, { method: 'PUT', headers: browserHeaders,
    body: JSON.stringify({ revision: 0, settings }) })).status).toBe(409);
});

it('requires authentication and an explicit predecessor when resuming a blocked session', async () => {
  const sessionId = 'sess_00000000-0000-4000-8000-000000000000';
  const url = `${base}/v1/sessions/${sessionId}/resume`;
  expect((await fetch(url, { method: 'POST' })).status).toBe(401);
  expect((await fetch(url, { method: 'POST', headers, body: '{}' })).status).toBe(400);
  let received: string[] = [];
  service.resumeSession = async (session, blocker) => { received = [session, blocker]; return { sessionId: session, blockedByTaskId: blocker, resumed: 1 }; };
  const blockedByTaskId = 'task_00000000-0000-4000-8000-000000000001';
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ blockedByTaskId }) });
  expect(response.status).toBe(200);
  expect(received).toEqual([sessionId, blockedByTaskId]);
});

it('protects invocation records and exposes filtered summaries without duplicating retries', async () => {
  expect((await fetch(`${base}/v1/admin/invocations`)).status).toBe(401);
  const request = { question: 'log-panel-test', context: { account: 'demo-user' }, idempotencyKey: 'log-test' };
  const submitted = await (await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify(request) })).json();
  await fetch(`${base}/v1/tasks`, { method: 'POST', headers, body: JSON.stringify(request) });
  await expect.poll(() => service.getTask(submitted.taskId).status).toBe('succeeded');
  const list = await (await fetch(`${base}/v1/admin/invocations?keyword=log-panel&status=succeeded&limit=1`, { headers })).json();
  expect(list).toMatchObject({ enabled: true, healthy: true, total: 1 });
  expect(list.items[0]).toMatchObject({ transport: 'http', questionPreview: request.question });
  expect(list.items[0]).not.toHaveProperty('context');
  const detail = await (await fetch(`${base}/v1/admin/invocations/${submitted.taskId}`, { headers })).json();
  expect(detail.context).toEqual(request.context);
  expect(detail.resultMarkdown).toContain('未调用 Codex');
  expect(JSON.stringify(detail)).not.toContain(token);
  const summary = await (await fetch(`${base}/v1/admin/invocations/summary`, { headers })).json();
  expect(summary).toMatchObject({ total: 1, succeeded: 1, successRate: 100 });
  for (const query of ['limit=101', 'status=oops', 'from=invalid', 'offset=-1']) {
    expect((await fetch(`${base}/v1/admin/invocations?${query}`, { headers })).status).toBe(400);
  }
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

it('deletes completed sessions only for an authenticated same-origin console request', async () => {
  const created = await (await fetch(`${base}/v1/tasks`, { method:'POST', headers,
    body:JSON.stringify({question:'Remove this conversation'}) })).json();
  for (let i = 0; i < 100 && ['queued','running'].includes(service.getTask(created.taskId).status); i++) {
    await new Promise(resolve => setTimeout(resolve,10));
  }
  expect(service.getTask(created.taskId).status).toBe('succeeded');
  const login = await fetch(`${base}/console/login`, { method:'POST', headers:{Origin:base,'Content-Type':'application/json'},
    body:JSON.stringify({username:'admin',password:'admin'}) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const url = `${base}/console/sessions/${created.sessionId}`;
  expect((await fetch(url,{method:'DELETE',headers})).status).toBe(403);
  expect((await fetch(url,{method:'DELETE',headers:{Cookie:cookie}})).status).toBe(403);
  const deleted = await fetch(url,{method:'DELETE',headers:{Cookie:cookie,Origin:base}});
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({deleted:true,deletedTasks:1});
  expect((await fetch(`${base}/v1/sessions/${created.sessionId}`,{headers})).status).toBe(404);
  expect((await fetch(`${base}/v1/tasks/${created.taskId}`,{headers})).status).toBe(404);
});

it('requires a console login, keeps the service token out of browser responses, and revokes logout', async () => {
  const page = await fetch(`${base}/`, { redirect: 'manual' });
  expect(page.status).toBe(302);
  expect(page.headers.get('location')).toBe('/login');
  const loginPage = await fetch(`${base}/login`);
  expect(loginPage.status).toBe(200);
  expect(await loginPage.text()).toContain('登录');
  expect((await fetch(`${base}/assets/invocations.js`)).status).toBe(401);
  expect((await fetch(`${base}/assets/task.js`)).status).toBe(401);
  expect((await fetch(`${base}/assets/account.js`)).status).toBe(401);
  expect((await fetch(`${base}/assets/app.css`)).status).toBe(401);
  expect((await fetch(`${base}/views/task.html`)).status).toBe(401);
  expect((await fetch(`${base}/console/session`)).status).toBe(401);
  const login = async (password: string) => fetch(`${base}/console/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'admin', password }),
  });
  expect((await fetch(`${base}/console/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin' }),
  })).status).toBe(403);
  expect((await login('wrong')).status).toBe(401);
  const signedIn = await login('admin');
  expect(signedIn.status).toBe(200);
  const cookie = signedIn.headers.get('set-cookie')!.split(';')[0];
  expect(cookie).toMatch(/^codex_console=/);
  expect(signedIn.headers.get('set-cookie')).toContain('HttpOnly');
  expect(signedIn.headers.get('set-cookie')).toContain('SameSite=Strict');
  const consoleHeaders = { Cookie: cookie };
  expect((await fetch(`${base}/mcp`, { method: 'POST', headers: consoleHeaders, body: '{}' })).status).toBe(401);
  const consolePage = await fetch(`${base}/`, { headers: consoleHeaders });
  expect(consolePage.status).toBe(200);
  const html = await consolePage.text();
  expect(html).toContain('CodexRelay');
  expect(html).toContain('账号额度');
  expect(html).not.toContain('id="task-form"');
  expect(html).not.toContain(token);
  for (const view of ['account','task','queue','schedules','skills','logs','settings']) {
    const fragment = await fetch(`${base}/views/${view}.html`, { headers: consoleHeaders });
    expect(fragment.status).toBe(200);
    expect(fragment.headers.get('content-type')).toContain('text/html');
    expect(await fragment.text()).toContain(`id="${view}-view"`);
  }
  expect((await fetch(`${base}/views/unknown.html`, { headers: consoleHeaders })).status).toBe(404);
  const logScript = await fetch(`${base}/assets/invocations.js`, { headers: consoleHeaders });
  expect(logScript.status).toBe(200);
  expect(logScript.headers.get('content-type')).toContain('javascript');
  expect(await logScript.text()).not.toContain(token);
  const stylesheet = await fetch(`${base}/assets/app.css`, { headers: consoleHeaders });
  expect(stylesheet.status).toBe(200);
  expect(stylesheet.headers.get('content-type')).toContain('text/css');
  const session = await fetch(`${base}/console/session`, { headers: consoleHeaders });
  expect(session.status).toBe(200);
  expect(await session.json()).toMatchObject({ username: 'admin', runner: 'demo' });
  expect(await (await fetch(`${base}/console/session`, { headers: consoleHeaders })).text()).not.toContain(token);
  expect((await fetch(`${base}/data/demo-access.json`)).status).toBe(401);
  const body = JSON.stringify({ question: 'Browser request' });
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...headers, Origin: base }, body })).status).toBe(202);
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body })).status).toBe(401);
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...consoleHeaders, Origin: 'https://untrusted.example', 'Content-Type': 'application/json' }, body })).status).toBe(403);
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...consoleHeaders, 'Content-Type': 'application/json' }, body })).status).toBe(403);
  expect((await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...consoleHeaders, Origin: base, 'Content-Type': 'application/json' }, body })).status).toBe(202);
  const logout = await fetch(`${base}/console/logout`, { method: 'POST', headers: { ...consoleHeaders, Origin: base } });
  expect(logout.status).toBe(204);
  expect((await fetch(`${base}/console/session`, { headers: consoleHeaders })).status).toBe(401);
});

it('serves discovery, submission, follow-up and errors to the official MCP client', async () => {
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const invalid = await client.callTool({name:'codex_submit_task',arguments:{question:'must reject',workingDirectory:'/not-allowed',model:'not-allowed'}});
    expect(invalid.isError).toBe(true);
    expect(service.listSessions(0,20).total).toBe(0);
    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(6);
    const submit = tools.tools.find(tool => tool.name === 'codex_submit_task')!;
    expect(Object.keys(submit.inputSchema.properties ?? {}).sort()).toEqual(['context', 'idempotencyKey', 'question', 'sandboxMode', 'sessionId', 'systemPrompt']);
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

it('does not disclose the service token through console routes', async () => {
  for (const forwarded of [{ Forwarded: 'for=203.0.113.1' }, { 'X-Forwarded-For': '203.0.113.1' }]) {
    const response = await fetch(`${base}/console/session`, { headers: forwarded });
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(token);
  }
  Object.assign(service.config, { localConsole: false });
  const response = await fetch(`${base}/console/session`);
  expect(response.status).toBe(401);
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
