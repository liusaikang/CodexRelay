import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { InvocationLog, invocationQuerySchema } from '../src/invocations.js';
import { TaskService } from '../src/service.js';
import { FileStore } from '../src/storage.js';
import type { Task, RuntimeConfig } from '../src/types.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'relay-invocations-'));
  const directory = join(root, 'logs');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const log = new InvocationLog({ enabled, directory, retentionDays: 30 });
  await log.open([]);
  cleanups.push(() => log.close());
  return { root, directory, log };
}
function task(status: Task['status'] = 'succeeded', createdAt = new Date().toISOString()): Task {
  return { version: 2, taskId: `task_${randomUUID()}`, sessionId: `sess_${randomUUID()}`,
    invocationTransport: 'http', request: { question: '调查订单', context: { account: 'demo-user' } },
    requestHash: 'internal-hash', configHash: 'internal-config', status, createdAt, startedAt: createdAt,
    ...(status === 'running' ? {} : { finishedAt: new Date(Date.parse(createdAt) + 2000).toISOString() }),
    result: { markdown: '<script>example</script> 完整结果', usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 40 } }, progress: [] };
}
const query = () => invocationQuerySchema.parse({});

it('atomically upserts concurrent task logs, filters summaries and reloads complete details', async () => {
  const { log, directory } = await fixture();
  const a = task(), b = task('failed');
  await Promise.all([log.record(a), log.record(b), log.record(a)]);
  const listed = log.list(query());
  expect(listed.total).toBe(2);
  expect(listed.items[0]).not.toHaveProperty('context');
  expect(log.summary(query())).toMatchObject({ total: 2, succeeded: 1, failed: 1, successRate: 50, averageDurationMs: 2000, totalTokens: 240 });
  expect(log.list(invocationQuerySchema.parse({ status: 'failed', keyword: '订单', limit: 1 })).total).toBe(1);
  expect(log.list(invocationQuerySchema.parse({ from: '2099-01-01T00:00:00Z' })).total).toBe(0);
  const file = join(directory, a.createdAt.slice(0, 10), `${a.taskId}.json`);
  const raw = await readFile(file, 'utf8');
  expect(raw).not.toContain('internal-hash');
  expect(JSON.parse(raw)).toMatchObject({ question: a.request.question, resultMarkdown: a.result!.markdown, transport: 'http' });
  await log.close();
  const restored = new InvocationLog({ enabled: true, directory, retentionDays: 30 });
  cleanups.push(() => restored.close());
  await restored.open([]);
  expect(restored.detail(a.taskId).context).toEqual(a.request.context);
});

it('disabled logging does not create files or expose stored records', async () => {
  const { root, log } = await fixture(false);
  await log.record(task());
  expect(await readdir(root)).toEqual([]);
  expect(log.list(query())).toMatchObject({ enabled: false, total: 0 });
  expect(() => log.detail(task().taskId)).toThrow('disabled');
});

it('supports Unicode paths and trusted linked parents without following log directory links', async () => {
  const { root } = await fixture(false);
  const target = join(root, '真实目录 with spaces');
  await mkdir(target);
  const alias = join(root, 'parent-link');
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const directory = join(alias, 'logs');
  const log = new InvocationLog({ enabled: true, directory, retentionDays: 30 });
  cleanups.push(() => log.close());
  await log.open([]);
  const a = task();
  await log.record(a);
  expect(log.status().healthy).toBe(true);
  const file = join(target, 'logs', a.createdAt.slice(0, 10), `${a.taskId}.json`);
  expect(JSON.parse(await readFile(file, 'utf8')).question).toBe(a.request.question);
  if (process.platform !== 'win32') {
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  }
  const linkedRoot = join(root, 'linked-logs');
  await symlink(directory, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const rejected = new InvocationLog({ enabled: true, directory: linkedRoot, retentionDays: 30 });
  cleanups.push(() => rejected.close());
  await rejected.open([]);
  expect(rejected.status().healthy).toBe(false);
  expect(rejected.list(query()).total).toBe(0);
});

it('does not write through linked date directories', async () => {
  const { root, directory, log } = await fixture();
  const external = join(root, 'external');
  await mkdir(external);
  const a = task();
  await symlink(external, join(directory, a.createdAt.slice(0, 10)), process.platform === 'win32' ? 'junction' : 'dir');
  await log.record(a);
  expect(log.status().healthy).toBe(false);
  expect(await readdir(external)).toEqual([]);
});

it('expires only terminal log files and never backfills tasks without opt-in', async () => {
  const { log, directory } = await fixture();
  const old = task('succeeded', '2000-01-01T00:00:00Z');
  await log.record(old);
  expect(log.list(query()).total).toBe(0);
  const running = task('running', '2000-01-01T00:00:00Z');
  await log.record(running);
  await writeFile(join(directory, '2000-01-01', 'keep.txt'), 'unrelated');
  await log.prune();
  expect(log.list(query()).total).toBe(1);
  expect(await readFile(join(directory, '2000-01-01', 'keep.txt'), 'utf8')).toBe('unrelated');
  const untracked = task(); delete untracked.invocationTransport;
  await log.record(untracked);
  expect(log.list(query()).total).toBe(1);
});

it('recovers an interrupted task log from durable task state on restart', async () => {
  const { log, directory } = await fixture();
  const a = task('running'); await log.record(a); await log.close();
  a.status = 'interrupted'; a.finishedAt = new Date().toISOString(); delete a.result;
  const restored = new InvocationLog({ enabled: true, directory, retentionDays: 30 });
  cleanups.push(() => restored.close()); await restored.open([a]);
  expect(restored.detail(a.taskId).status).toBe('interrupted');
});

it('removes expired terminal files without deleting active tasks or unrelated files', async () => {
  const { log, directory } = await fixture();
  const complete = task(), active = task('running');
  await log.record(complete); await log.record(active);
  const day = join(directory, complete.createdAt.slice(0, 10));
  await writeFile(join(day, 'keep.txt'), 'keep');
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 86_400_000);
  await log.prune();
  expect(await readdir(day)).toEqual(expect.arrayContaining([`${active.taskId}.json`, 'keep.txt']));
  expect(await readdir(day)).not.toContain(`${complete.taskId}.json`);
  expect(log.list(query()).total).toBe(1);
});

it('rejects invalid pagination, timestamps, and reversed date ranges', () => {
  for (const input of [{ limit: 101 }, { offset: -1 }, { status: 'other' }, { from: 'yesterday' }, { from: '2026-09-25T00:00:00Z', to: '2026-09-24T00:00:00Z' }]) {
    expect(() => invocationQuerySchema.parse(input)).toThrow();
  }
});

it('isolates log disk failures from successful task execution and core storage', async () => {
  const { root } = await fixture(false);
  const blocked = join(root, 'blocked'); await writeFile(blocked, 'file instead of directory');
  const config: RuntimeConfig = { dataDir: join(root, 'tasks'), codexHome: join(root, 'codex'), host: '127.0.0.1', port: 0,
    tokenEnv: 'CODEX_MCP_TOKEN', allowedHosts: ['localhost'], allowedOrigins: [], maxConcurrent: 2, maxQueued: 10,
    timeoutSeconds: 30, defaultWorkingDirectory: root, runner: 'demo', envAllowlist: [],
    invocationLog: { enabled: true, directory: blocked, retentionDays: 30 } };
  const service = new TaskService(config, new FileStore(config.dataDir), { run: async () => ({ markdown: 'done', usage: null }) });
  await service.init(); cleanups.push(() => service.close());
  const request = { question: 'test', idempotencyKey: 'same-request' };
  const first = await service.submit(request, 'mcp');
  expect((await service.submit(request, 'http')).taskId).toBe(first.taskId);
  await expect.poll(() => service.getTask(first.taskId).status).toBe('succeeded');
  expect(service.invocations.status()).toMatchObject({ enabled: true, healthy: false });
  expect(JSON.parse(await readFile(join(config.dataDir, 'tasks', `${first.taskId}.json`), 'utf8')).result.markdown).toBe('done');
});

it.each(['succeeded', 'failed', 'cancelled', 'timed_out'] as const)('persists the terminal %s lifecycle through the service', async expected => {
  const { root } = await fixture(false);
  const config: RuntimeConfig = { dataDir: join(root, 'core'), codexHome: join(root, 'codex'), host: '127.0.0.1', port: 0,
    tokenEnv: 'CODEX_MCP_TOKEN', allowedHosts: ['localhost'], allowedOrigins: [], maxConcurrent: 2, maxQueued: 10,
    timeoutSeconds: 1, defaultWorkingDirectory: root, runner: 'demo', envAllowlist: [],
    invocationLog: { enabled: true, directory: join(root, 'audit'), retentionDays: 30 } };
  const service = new TaskService(config, new FileStore(config.dataDir), { run: async (_execution, signal) => {
    if (expected === 'failed') throw new Error('upstream private error');
    if (expected === 'succeeded') return { markdown: 'answer', usage: { input_tokens: 3, output_tokens: 2 } };
    return await new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      if (signal.aborted) reject(new Error('aborted'));
    });
  } });
  await service.init(); cleanups.push(() => service.close());
  const request = { question: 'lifecycle', idempotencyKey: 'one-task' };
  const accepted = await service.submit(request, 'mcp');
  if (expected === 'cancelled') await service.cancel(accepted.taskId);
  await expect.poll(() => service.getTask(accepted.taskId).status, { timeout: 4000 }).toBe(expected);
  expect(service.invocations.detail(accepted.taskId)).toMatchObject({ status: expected, transport: 'mcp' });
  expect(JSON.stringify(service.invocations.detail(accepted.taskId))).not.toContain('upstream private error');
  await service.submit(request, 'http');
  expect(service.invocations.list(query()).total).toBe(1);
});
