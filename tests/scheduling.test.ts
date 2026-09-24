import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskService } from '../src/service.js';
import { FileStore } from '../src/storage.js';
import type { Runner, RuntimeConfig, Store } from '../src/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}
class ControlledRunner implements Runner {
  calls: Array<{ id: string; finish: () => void; fail: () => void }> = [];
  running = 0;
  peak = 0;
  async run(execution: Parameters<Runner['run']>[0], signal: AbortSignal) {
    this.running++; this.peak = Math.max(this.peak, this.running);
    try {
      return await new Promise<{ markdown: string; usage: null }>((resolve, reject) => {
        this.calls.push({ id: execution.taskId, finish: () => resolve({ markdown: 'Done', usage: null }), fail: () => reject(new Error('fixture failure')) });
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        if (signal.aborted) reject(new Error('cancelled'));
      });
    } finally { this.running--; }
  }
}
async function fixture(overrides: Partial<RuntimeConfig> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-scheduler-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config: RuntimeConfig = { dataDir: dir, codexHome: join(dir, 'home'), host: '127.0.0.1', port: 0,
    tokenEnv: 'CODEX_MCP_TOKEN', allowedHosts: ['localhost'], allowedOrigins: [], maxConcurrent: 2, maxQueued: 3,
    timeoutSeconds: 30, defaultWorkingDirectory: dir, runner: 'codex', envAllowlist: [], ...overrides };
  const runner = new ControlledRunner(), store = new FileStore(dir), service = new TaskService(config, store, runner);
  await service.init(); cleanup.push(() => service.close());
  return { config, runner, store, service, dir };
}

it('bounds admission before slow persistence and coalesces simultaneous idempotent requests', async () => {
  const { service, store } = await fixture({ maxConcurrent: 1, maxQueued: 2 });
  const save = store.saveSession.bind(store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  store.saveSession = async session => { await gate; await save(session); };
  try {
    const first = service.submit({ question: 'first', idempotencyKey: 'same' });
    const duplicate = service.submit({ question: 'first', idempotencyKey: 'same' });
    const second = service.submit({ question: 'second' });
    let rejection = '';
    const excess = service.submit({ question: 'excess' }).catch(error => { rejection = error.code; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(rejection).toBe('ADMISSION_FULL');
    expect(service.health()).toMatchObject({ receiving: 3, admissionLimit: 3 });
    release();
    const [a, b] = await Promise.all([first, duplicate, second, excess]);
    expect(a!.taskId).toBe(b!.taskId);
    expect(service.listSessions(0, 20).total).toBe(2);
  } finally { release(); }
});

it('does not allow a flood of duplicate waiters to bypass the admission bound', async () => {
  const { service, store } = await fixture({ maxConcurrent: 1, maxQueued: 1 });
  const save = store.saveSession.bind(store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  store.saveSession = async session => { await gate; await save(session); };
  const request = { question: 'same', idempotencyKey: 'duplicates' };
  const responses = Array.from({ length: 100 }, () => service.submit(request));
  const all = Promise.allSettled(responses);
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(service.health().receiving).toBe(2);
  } finally { release(); }
  const results = await all;
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(2);
  expect(service.listSessions(0, 20).total).toBe(1);
});

it('never starts work whose queue deadline elapsed during persistence', async () => {
  const { service, store, runner } = await fixture({ maxConcurrent: 1, queueTimeoutSeconds: 0.05 });
  const save = store.saveTask.bind(store);
  store.saveTask = async task => {
    if (task.status === 'running') await new Promise(resolve => setTimeout(resolve, 80));
    await save(task);
  };
  const task = await service.submit({ question: 'slow disk' });
  expect(task).toMatchObject({ status: 'timed_out', error: { code: 'QUEUE_EXPIRED' } });
  expect(task.startedAt).toBeUndefined();
  expect(runner.calls).toHaveLength(0);
});

it('survives a 100-request burst without exceeding execution or waiting limits', async () => {
  const { service, runner } = await fixture({ maxConcurrent: 3, maxQueued: 7 });
  const results = await Promise.allSettled(Array.from({ length: 100 }, (_, i) => service.submit({ question: `Task ${i}` })));
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(10);
  expect(results.filter(r => r.status === 'rejected')).toHaveLength(90);
  expect(service.health()).toMatchObject({ running: 3, queued: 7, receiving: 0 });
  for (let i = 0; i < 10; i++) { await until(() => runner.calls.length > i); runner.calls[i]!.finish(); }
  await until(() => service.health().running === 0);
  expect(runner.peak).toBeLessThanOrEqual(3);
  expect(new Set(runner.calls.map(c => c.id)).size).toBe(10);
});

it('expires queued tasks without running them and reports the capacity reason', async () => {
  const { service, runner } = await fixture({ maxConcurrent: 1, queueTimeoutSeconds: 0.08 });
  await service.submit({ question: 'running' });
  const waiting = await service.submit({ question: 'waiting' });
  expect(service.getTask(waiting.taskId)).toMatchObject({ scheduling: { reason: 'capacity' } });
  await until(() => service.getTask(waiting.taskId).status === 'timed_out');
  expect(service.getTask(waiting.taskId)).toMatchObject({ error: { code: 'QUEUE_EXPIRED' } });
  expect(service.getTask(waiting.taskId).startedAt).toBeUndefined();
  expect(runner.calls).toHaveLength(1);
});

it('blocks dependent turns after failure, permits other sessions, and resumes only with the expected blocker', async () => {
  const { service, runner } = await fixture();
  const a = await service.submit({ question: 'first' });
  const b = await service.submit({ question: 'second', sessionId: a.sessionId });
  const c = await service.submit({ question: 'third', sessionId: a.sessionId });
  expect(service.getTask(b.taskId)).toMatchObject({ scheduling: { reason: 'session_active', blockedByTaskId: a.taskId } });
  runner.calls[0]!.fail();
  await until(() => service.getTask(a.taskId).status === 'failed');
  const independent = await service.submit({ question: 'independent' });
  expect(runner.calls.map(c => c.id)).toContain(independent.taskId);
  for (const task of [b, c]) expect(service.getTask(task.taskId)).toMatchObject({ status: 'queued', scheduling: { reason: 'previous_task_failed', blockedByTaskId: a.taskId } });
  await expect(service.resumeSession(a.sessionId, independent.taskId)).rejects.toMatchObject({ code: 'BLOCKER_CHANGED' });
  await service.resumeSession(a.sessionId, a.taskId);
  await until(() => runner.calls.some(call => call.id === b.taskId));
  expect(service.getTask(c.taskId).status).toBe('queued');
  runner.calls.find(call => call.id === b.taskId)!.finish();
  await until(() => runner.calls.some(call => call.id === c.taskId));
});

it('preserves accepted ordering across restart even if timestamps and file order disagree', async () => {
  const { service, config, runner, store } = await fixture({ maxConcurrent: 1 });
  const first = await service.submit({ question: 'first' });
  const second = await service.submit({ question: 'second' });
  const third = await service.submit({ question: 'third' });
  expect(service.getTask(second.taskId).enqueueSequence).toBeLessThan(service.getTask(third.taskId).enqueueSequence!);
  await service.close();
  const stored = await store.open(); await store.close();
  for (const task of stored.tasks) task.createdAt = '2026-01-01T00:00:00.000Z';
  stored.tasks.reverse();
  const memoryStore: Store = { open: async () => stored, saveTask: async () => {}, saveSession: async () => {}, close: async () => {} };
  const nextRunner = new ControlledRunner(), next = new TaskService(config, memoryStore, nextRunner);
  await next.init(); cleanup.push(() => next.close());
  expect(nextRunner.calls[0]!.id).toBe(second.taskId);
  nextRunner.calls[0]!.finish();
  await until(() => nextRunner.calls.length === 2);
  expect(nextRunner.calls[1]!.id).toBe(third.taskId);
  expect(runner.calls).toHaveLength(1);
  expect(next.getTask(first.taskId).status).toBe('interrupted');
});

it('keeps dependent queued turns blocked after restart instead of replaying an interrupted predecessor', async () => {
  const { service, config, dir } = await fixture({ maxConcurrent: 1 });
  const first = await service.submit({ question: 'first' });
  const second = await service.submit({ question: 'second', sessionId: first.sessionId });
  await service.close();
  const runner = new ControlledRunner(), next = new TaskService(config, new FileStore(dir), runner);
  await next.init(); cleanup.push(() => next.close());
  expect(runner.calls).toHaveLength(0);
  expect(next.getTask(second.taskId)).toMatchObject({ scheduling: { reason: 'previous_task_failed', blockedByTaskId: first.taskId } });
  await next.resumeSession(first.sessionId, first.taskId);
  expect(runner.calls[0]!.id).toBe(second.taskId);
});

it('rejects a stale resume confirmation after a different predecessor has failed', async () => {
  const { service, runner } = await fixture();
  const a = await service.submit({ question: 'a' });
  const b = await service.submit({ question: 'b', sessionId: a.sessionId });
  const c = await service.submit({ question: 'c', sessionId: a.sessionId });
  runner.calls[0]!.fail();
  await until(() => service.getTask(a.taskId).status === 'failed');
  await service.resumeSession(a.sessionId, a.taskId);
  await until(() => runner.calls.length === 2);
  runner.calls[1]!.fail();
  await until(() => service.getTask(b.taskId).status === 'failed');
  await expect(service.resumeSession(a.sessionId, a.taskId)).rejects.toMatchObject({ code: 'BLOCKER_CHANGED' });
  expect(service.getTask(c.taskId)).toMatchObject({ status: 'queued', scheduling: { blockedByTaskId: b.taskId } });
});

it('preserves expired waiting deadlines across restart', async () => {
  const { service, config, dir } = await fixture({ maxConcurrent: 1, queueTimeoutSeconds: 0.06 });
  await service.submit({ question: 'a' });
  const queued = await service.submit({ question: 'b' });
  await service.close();
  await new Promise(resolve => setTimeout(resolve, 90));
  const runner = new ControlledRunner(), next = new TaskService(config, new FileStore(dir), runner);
  await next.init(); cleanup.push(() => next.close());
  expect(runner.calls).toHaveLength(0);
  expect(next.getTask(queued.taskId)).toMatchObject({ status: 'timed_out', error: { code: 'QUEUE_EXPIRED' } });
});

it('stops admission immediately and does not launch a worker while shutting down during persistence', async () => {
  const { service, store, runner } = await fixture();
  const save = store.saveTask.bind(store);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let saving = false;
  store.saveTask = async task => { if (task.status === 'running') { saving = true; await gate; } await save(task); };
  const submission = service.submit({ question: 'stop during write' });
  await until(() => saving);
  const close = service.close();
  const rejection = service.submit({ question: 'too late' });
  release();
  await expect(rejection).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  const task = await submission;
  await close;
  expect(task.status).toBe('queued');
  expect(runner.calls).toHaveLength(0);
});

it('does not let cancelling the latest queued turn bypass earlier session work', async () => {
  const { service, runner } = await fixture({ maxConcurrent: 2, maxQueued: 4 });
  const a = await service.submit({ question: 'a' });
  const b = await service.submit({ question: 'b', sessionId: a.sessionId });
  const c = await service.submit({ question: 'c', sessionId: a.sessionId });
  await service.cancel(c.taskId);
  const d = await service.submit({ question: 'd', sessionId: a.sessionId });
  runner.calls[0]!.finish();
  await until(() => runner.calls.length === 2);
  expect(runner.calls[1]!.id).toBe(b.taskId);
  expect(service.getTask(d.taskId).status).toBe('queued');
});

it('does not resume a cancelled middle turn past an earlier unacknowledged failure', async () => {
  const { service, runner } = await fixture({ maxQueued: 4 });
  const a = await service.submit({ question: 'a' });
  const b = await service.submit({ question: 'b', sessionId: a.sessionId });
  const c = await service.submit({ question: 'c', sessionId: a.sessionId });
  const d = await service.submit({ question: 'd', sessionId: a.sessionId });
  runner.calls[0]!.fail();
  await until(() => service.getTask(a.taskId).status === 'failed' && service.health().running === 0);
  await service.cancel(c.taskId);
  await expect(service.resumeSession(a.sessionId, c.taskId)).rejects.toMatchObject({ code: 'BLOCKER_CHANGED' });
  expect(runner.calls).toHaveLength(1);
  await service.resumeSession(a.sessionId, a.taskId);
  await until(() => runner.calls.length === 2);
  expect(runner.calls[1]!.id).toBe(b.taskId);
  runner.calls[1]!.finish();
  await until(() => service.health().running === 0);
  expect(service.getTask(d.taskId)).toMatchObject({ scheduling: { blockedByTaskId: c.taskId } });
  await service.resumeSession(a.sessionId, c.taskId);
  expect(runner.calls[2]!.id).toBe(d.taskId);
});

it('migrates unsequenced timestamp ties without running a queued turn before its interrupted predecessor', async () => {
  const { service, config, store } = await fixture();
  const first = await service.submit({ question: 'first' });
  await service.submit({ question: 'second', sessionId: first.sessionId });
  await service.close();
  const stored = await store.open(); await store.close();
  const a = stored.tasks.find(task => task.request.question === 'first')!;
  const b = stored.tasks.find(task => task.request.question === 'second')!;
  a.taskId = 'task_ffffffff-ffff-4fff-8fff-ffffffffffff'; a.status = 'running';
  b.taskId = 'task_00000000-0000-4000-8000-000000000000';
  for (const task of [a, b]) {
    delete task.enqueueSequence; delete task.dependsOnTaskId; delete task.queueExpiresAt;
    task.createdAt = new Date().toISOString();
  }
  b.createdAt = a.createdAt;
  const memoryStore: Store = { open: async () => stored, saveTask: async () => {}, saveSession: async () => {}, close: async () => {} };
  const runner = new ControlledRunner(), next = new TaskService(config, memoryStore, runner);
  await next.init(); cleanup.push(() => next.close());
  expect(runner.calls).toHaveLength(0);
  expect(next.getTask(b.taskId)).toMatchObject({ scheduling: { blockedByTaskId: a.taskId, reason: 'previous_task_failed' } });
});
