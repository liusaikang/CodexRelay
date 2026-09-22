import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore } from '../src/storage.js';
import { TaskService } from '../src/service.js';
import type { Execution, Runner, RuntimeConfig } from '../src/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function until(fn: () => boolean) {
  for (let i = 0; i < 200 && !fn(); i++) await tick();
  expect(fn()).toBe(true);
}

class ControlledRunner implements Runner {
  calls: Array<{ execution: Execution; finish: () => void }> = [];
  async run(execution: Execution, signal: AbortSignal, onEvent: Parameters<Runner['run']>[2]) {
    await onEvent({ kind: 'thread', threadId: execution.threadId ?? `thread-${this.calls.length}` });
    return new Promise<{ markdown: string; usage: null }>((resolve, reject) => {
      this.calls.push({ execution, finish: () => resolve({ markdown: 'Verified result', usage: null }) });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      if (signal.aborted) reject(new Error('aborted'));
    });
  }
}

async function fixture(maxConcurrent = 2, maxQueued = 2, timeoutSeconds = 30) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-mcp-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config: RuntimeConfig = {
    dataDir: dir, codexHome: join(dir, 'codex'), host: '127.0.0.1', port: 0,
    tokenEnv: 'CODEX_MCP_TOKEN', allowedHosts: ['127.0.0.1'], allowedOrigins: [],
    maxConcurrent, maxQueued, runner: 'codex', envAllowlist: [],
    timeoutSeconds, defaultWorkingDirectory: dir,
  };
  const runner = new ControlledRunner();
  const store = new FileStore(dir);
  const service = new TaskService(config, store, runner);
  await service.init();
  cleanup.push(() => service.close());
  return { service, store, runner, config, dir };
}
const input = { question: 'Why is this failing?' };

describe('durable task scheduling', () => {
  it('bounds global concurrency, rejects a full queue and does not create extra sessions', async () => {
    const { service, runner } = await fixture(2, 1);
    await Promise.all([service.submit(input), service.submit(input), service.submit(input)]);
    await until(() => runner.calls.length === 2);
    await expect(service.submit(input)).rejects.toMatchObject({ code: 'QUEUE_FULL' });
    expect(service.listSessions(0, 20).total).toBe(3);
    runner.calls[0]!.finish();
    await until(() => runner.calls.length === 3);
  });
  it('serializes a session while allowing an unrelated session to run, then resumes its thread', async () => {
    const { service, runner } = await fixture();
    const first = await service.submit(input);
    await until(() => runner.calls.length === 1);
    const second = await service.submit({ ...input, sessionId: first.sessionId, question: 'And its role?' });
    await service.submit(input);
    await until(() => runner.calls.length === 2);
    expect(service.getTask(second.taskId).status).toBe('queued');
    runner.calls[0]!.finish();
    await until(() => runner.calls.length === 3);
    expect(runner.calls[2]!.execution.threadId).toBe('thread-0');
  });
  it('returns the same task for retries and treats context as part of idempotency', async () => {
    const { service } = await fixture();
    const request = { ...input, context: { subject: { account: 'demo-user' } }, idempotencyKey: 'request-1' } as any;
    const a = await service.submit(request);
    const b = await service.submit(request);
    expect(a.taskId).toBe(b.taskId);
    await expect(service.submit({ ...request, context: { subject: { account: 'other' } } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('uses configured model settings and rejects caller execution overrides', async () => {
    const { service, runner } = await fixture();
    service.config.defaultModel = 'gpt-test';
    service.config.defaultReasoningEffort = 'high';
    await expect(service.submit({ ...input, model: 'caller-model' } as any)).rejects.toThrow();
    await expect(service.submit({ ...input, modelReasoningEffort: 'low' } as any)).rejects.toThrow();
    await expect(service.submit({ ...input, workingDirectory: process.cwd() } as any)).rejects.toThrow();
    const first = await service.submit(input);
    await until(() => runner.calls.length === 1);
    expect(runner.calls[0]!.execution.model).toBe('gpt-test');
    expect(runner.calls[0]!.execution.modelReasoningEffort).toBe('high');
    await service.submit({ ...input, sessionId: first.sessionId });
  });
  it('does not silently create a session for an unknown id', async () => {
    const { service } = await fixture();
    await expect(service.submit({ ...input, sessionId: 'sess_00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(service.listSessions(0, 20).total).toBe(0);
  });
  it('inherits omitted model settings for follow-ups, including after restart', async () => {
    const { service, runner, config, dir } = await fixture();
    config.defaultModel = 'gpt-test'; config.defaultReasoningEffort = 'high';
    const first = await service.submit(input);
    await until(() => runner.calls.length === 1);
    runner.calls[0]!.finish();
    await until(() => service.getTask(first.taskId).status === 'succeeded');
    await service.close();
    const nextRunner = new ControlledRunner();
    const next = new TaskService(config, new FileStore(dir), nextRunner);
    await next.init(); cleanup.push(() => next.close());
    const request = { ...input, sessionId: first.sessionId, idempotencyKey: 'follow-up' };
    const second = await next.submit(request);
    await until(() => nextRunner.calls.length === 1);
    expect(nextRunner.calls[0]!.execution).toMatchObject({ model: 'gpt-test', modelReasoningEffort: 'high', threadId: 'thread-0' });
    expect((await next.submit(request)).taskId).toBe(second.taskId);
    expect(next.getSession(first.sessionId, 0, 20)).toMatchObject({ model: 'gpt-test', modelReasoningEffort: 'high' });
  });
  it('cancels queued and running work, and releases the slot after the runner exits', async () => {
    const { service, runner } = await fixture(1);
    const a = await service.submit(input);
    const b = await service.submit(input);
    await until(() => runner.calls.length === 1);
    await service.cancel(b.taskId);
    expect(service.getTask(b.taskId).status).toBe('cancelled');
    await service.cancel(a.taskId);
    await until(() => service.getTask(a.taskId).status === 'cancelled');
    expect(runner.calls.length).toBe(1);
  });
  it('times out actual running work', async () => {
    const { service } = await fixture(1, 2, 0.03);
    const a = await service.submit(input);
    await until(() => service.getTask(a.taskId).status === 'timed_out');
  });
  it('persists results and session history across clean restart', async () => {
    const { service, runner, dir, config } = await fixture();
    const a = await service.submit(input);
    await until(() => runner.calls.length === 1);
    runner.calls[0]!.finish();
    await until(() => service.getTask(a.taskId).status === 'succeeded');
    await service.close();
    const next = new TaskService(config, new FileStore(dir), new ControlledRunner());
    await next.init();
    cleanup.push(() => next.close());
    expect(next.getTask(a.taskId).result?.markdown).toBe('Verified result');
    expect(next.getSession(a.sessionId, 0, 20).tasks.total).toBe(1);
    expect(JSON.stringify(next.getSession(a.sessionId, 0, 20))).not.toContain('thread-0');
  });
  it('fails closed when another instance uses the same data directory or storage is corrupt', async () => {
    const { dir } = await fixture();
    await expect(new FileStore(dir).open()).rejects.toMatchObject({ code: 'STORE_LOCKED' });
    const other = await mkdtemp(join(tmpdir(), 'codex-corrupt-'));
    cleanup.push(() => rm(other, { recursive: true, force: true }));
    const store = new FileStore(other);
    await store.open();
    await store.close();
    await writeFile(join(other, 'tasks', 'broken.json'), '{');
    await expect(store.open()).rejects.toThrow();
    await store.close();
  });
  it('blocks a resume after the native Codex home changes', async () => {
    const { service, config } = await fixture();
    const a = await service.submit(input);
    config.codexHome += '-other';
    await expect(service.submit({ ...input, sessionId: a.sessionId })).rejects.toMatchObject({ code: 'SESSION_CONFIG_CHANGED' });
  });
  it('rejects removed routing parameters and pins configured native session context', async () => {
    const { service, config, runner, dir } = await fixture();
    await expect(service.submit({ ...input, workingDirectory: 'relative' } as any)).rejects.toThrow();
    await expect(service.submit({ ...input, capability: 'general' } as any)).rejects.toThrow();
    const cwd = config.defaultWorkingDirectory;
    await writeFile(join(cwd, 'AGENTS.md'), 'Initial native rules');
    const first = await service.submit(input);
    await until(() => runner.calls.length === 1);
    runner.calls[0]!.finish();
    await until(() => service.getTask(first.taskId).status === 'succeeded');
    await writeFile(join(cwd, 'AGENTS.md'), 'Changed native rules are loaded by Codex, not the gateway');
    config.defaultWorkingDirectory = dir;
    config.defaultModel = 'changed-default';
    config.defaultReasoningEffort = 'high';
    await service.submit({ ...input, sessionId: first.sessionId });
    await until(() => runner.calls.length === 2);
    expect(runner.calls[1]!.execution.directory).toBe(await realpath(cwd));
    expect(runner.calls[1]!.execution.model).toBeUndefined();
    expect(runner.calls[1]!.execution.modelReasoningEffort).toBeUndefined();
    expect(service.getSession(first.sessionId, 0, 20).workingDirectory).toBe(await realpath(cwd));
  });
  it('keeps legacy history readable but rejects continuation and queued replay', async () => {
    const { service, runner, config, dir } = await fixture(1, 3);
    const first = await service.submit(input);
    await until(() => runner.calls.length === 1);
    const queued = await service.submit({ ...input, sessionId: first.sessionId });
    await service.close();
    const sessionFile = join(dir, 'sessions', `${first.sessionId}.json`);
    const legacySession = JSON.parse(await readFile(sessionFile, 'utf8'));
    legacySession.version = 1;
    legacySession.projectKey = 'demo'; legacySession.capability = 'general';
    delete legacySession.workingDirectory;
    await writeFile(sessionFile, JSON.stringify(legacySession));
    for (const task of [first, queued]) {
      const file = join(dir, 'tasks', `${task.taskId}.json`);
      const stored = JSON.parse(await readFile(file, 'utf8'));
      stored.version = 1; stored.request.projectKey = 'demo'; stored.request.capability = 'general';
      await writeFile(file, JSON.stringify(stored));
    }
    const nextRunner = new ControlledRunner();
    const next = new TaskService(config, new FileStore(dir), nextRunner);
    await next.init(); cleanup.push(() => next.close());
    expect(next.getSession(first.sessionId, 0, 20).tasks.total).toBe(2);
    expect(next.getTask(queued.taskId)).toMatchObject({ status: 'failed', error: { code: 'LEGACY_SESSION' } });
    await expect(next.submit({ ...input, sessionId: first.sessionId })).rejects.toMatchObject({ code: 'LEGACY_SESSION' });
    expect(nextRunner.calls).toHaveLength(0);
    await next.submit(input);
    await until(() => nextRunner.calls.length === 1);
  });
  it('restores queued tasks but never replays interrupted running tasks', async () => {
    const { service, runner, dir, config } = await fixture(1, 3);
    const a = await service.submit(input);
    const b = await service.submit(input);
    await until(() => runner.calls.length === 1);
    await service.close();
    const file = join(dir, 'tasks', `${a.taskId}.json`);
    const previous = JSON.parse(await readFile(file, 'utf8'));
    previous.status = 'running';
    delete previous.finishedAt;
    delete previous.stopReason;
    await writeFile(file, JSON.stringify(previous));
    const nextRunner = new ControlledRunner();
    const next = new TaskService(config, new FileStore(dir), nextRunner);
    await next.init(); cleanup.push(() => next.close());
    await until(() => nextRunner.calls.length === 1);
    expect(next.getTask(a.taskId).status).toBe('interrupted');
    expect(nextRunner.calls[0]!.execution.taskId).toBe(b.taskId);
  });
  it('does not expose a successful result if its final persistence failed', async () => {
    const { service, store, runner } = await fixture();
    const a = await service.submit(input);
    await until(() => runner.calls.length === 1);
    store.saveTask = async () => { throw Object.assign(new Error('Disk full'), { code: 'ENOSPC' }); };
    runner.calls[0]!.finish();
    await until(() => !service.health().ready);
    expect(() => service.getTask(a.taskId)).toThrowError(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }));
    await expect(service.submit(input)).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
  it('does not release a cancelled session until the runner has actually exited', async () => {
    const { service, runner } = await fixture(1, 3);
    let complete!: () => void;
    runner.run = async (_execution, _signal, onEvent) => {
      await onEvent({ kind: 'thread', threadId: 'slow-shutdown' });
      return new Promise(resolve => { complete = () => resolve({ markdown: 'Done', usage: null }); });
    };
    const a = await service.submit(input);
    await until(() => !!complete);
    await service.cancel(a.taskId);
    const b = await service.submit({ ...input, sessionId: a.sessionId });
    expect(service.getTask(a.taskId).status).toBe('running');
    expect(service.getTask(b.taskId).status).toBe('queued');
    const firstComplete = complete;
    firstComplete();
    await until(() => service.getTask(a.taskId).status === 'cancelled');
    await until(() => service.getTask(b.taskId).status === 'running' && complete !== firstComplete);
    complete();
    await until(() => service.getTask(b.taskId).status === 'succeeded');
  });
});
