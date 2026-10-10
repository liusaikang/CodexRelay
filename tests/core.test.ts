import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { FileStore } from '../src/storage.js';
import { TaskService } from '../src/service.js';
import { AppError, type Execution, type Runner, type RuntimeConfig } from '../src/types.js';
import { CodexDiagnosticError } from '../src/runner/diagnostics.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 15));
async function until(fn: () => boolean) {
  for (let i = 0; i < 200 && !fn(); i++) await tick();
  expect(fn()).toBe(true);
}

class ControlledRunner implements Runner {
  calls: Array<{ execution: Execution; finish: () => void; fail: (error: Error) => void; report: Parameters<Runner['run']>[2] }> = [];
  async run(execution: Execution, signal: AbortSignal, onEvent: Parameters<Runner['run']>[2]) {
    await onEvent({ kind: 'thread', threadId: execution.threadId ?? `thread-${this.calls.length}` });
    return new Promise<{ markdown: string; usage: null }>((resolve, reject) => {
      this.calls.push({ execution, finish: () => resolve({ markdown: 'Verified result', usage: null }), fail: reject, report: onEvent });
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
  it('deletes a completed session and its tasks durably but rejects active work', async () => {
    const { service, runner, config, dir } = await fixture();
    const first = await service.submit({ ...input, idempotencyKey: 'delete-session-first' });
    await expect(service.deleteSession(first.sessionId)).rejects.toMatchObject({ code: 'SESSION_ACTIVE', httpStatus: 409 });
    runner.calls[0]!.finish();
    await until(() => service.getTask(first.taskId).status === 'succeeded');
    const second = await service.submit({ question: 'Follow-up', sessionId: first.sessionId });
    await until(() => runner.calls.length === 2);
    runner.calls[1]!.finish();
    await until(() => service.getTask(second.taskId).status === 'succeeded');
    const deleted = await service.deleteSession(first.sessionId);
    expect(deleted).toEqual({ deleted: true, deletedTasks: 2 });
    expect(service.listSessions(0,20).total).toBe(0);
    expect(service.listTasks({status:'all'}).total).toBe(0);
    await expect(access(join(dir,'sessions',`${first.sessionId}.json`))).rejects.toMatchObject({ code:'ENOENT' });
    for (const task of [first,second]) await expect(access(join(dir,'tasks',`${task.taskId}.json`))).rejects.toMatchObject({ code:'ENOENT' });
    await service.close();
    const restored = new TaskService(config,new FileStore(dir),new ControlledRunner());
    await restored.init(); cleanup.push(() => restored.close());
    expect(restored.listSessions(0,20).total).toBe(0);
    expect(restored.listTasks({status:'all'}).total).toBe(0);
  });
  it('selects developer instructions per turn, including queued defaults and resumed sessions', async () => {
    const { service, runner, config, dir } = await fixture(1, 3);
    const file = join(dir, 'default-developer-instructions.md');
    config.defaultDeveloperInstructionsFile = file;
    await writeFile(file, 'First default');
    const first = await service.submit(input);
    await until(() => runner.calls.length === 1);
    expect(runner.calls[0]!.execution.developerInstructions).toBe('First default');
    const queued = await service.submit({ ...input, sessionId: first.sessionId, systemPrompt: '  Custom turn  ' });
    expect(service.getTask(queued.taskId).status).toBe('queued');
    runner.calls[0]!.finish();
    await until(() => runner.calls.length === 2);
    expect(runner.calls[1]!.execution).toMatchObject({ threadId: 'thread-0', developerInstructions: 'Custom turn' });
    runner.calls[1]!.finish();
    await until(() => service.getTask(queued.taskId).status === 'succeeded');
    const waiting = await service.submit(input);
    await until(() => runner.calls.length === 3);
    const followUp = await service.submit({ ...input, sessionId: first.sessionId, systemPrompt: '   ' });
    await writeFile(file, 'Updated default');
    runner.calls[2]!.finish();
    await until(() => runner.calls.length === 4);
    expect(runner.calls[3]!.execution).toMatchObject({ taskId: followUp.taskId, threadId: 'thread-0', developerInstructions: 'Updated default' });
    expect(service.getTask(waiting.taskId).status).toBe('succeeded');
  });

  it('keeps an explicit prompt in idempotent submissions and task retries', async () => {
    const { service, runner } = await fixture(1);
    const request = { ...input, systemPrompt: 'Custom instruction', idempotencyKey: 'prompt-request' };
    const original = await service.submit(request);
    expect((await service.submit(request)).taskId).toBe(original.taskId);
    await expect(service.submit({ ...request, systemPrompt: 'Different instruction' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await until(() => runner.calls.length === 1);
    await service.cancel(original.taskId);
    await until(() => service.getTask(original.taskId).status === 'cancelled');
    await service.retry(original.taskId, 'retry-prompt');
    await until(() => runner.calls.length === 2);
    expect(runner.calls[1]!.execution.developerInstructions).toBe('Custom instruction');
  });

  it('returns a specific safe error when the model credential is missing', async () => {
    const { service, runner } = await fixture(1);
    const submitted = await service.submit(input);
    await until(() => runner.calls.length === 1);
    runner.calls[0]!.fail(new AppError('MODEL_CREDENTIAL_MISSING', 'private credential detail'));
    await until(() => service.getTask(submitted.taskId).status === 'failed');
    expect(service.getTask(submitted.taskId).error).toEqual({
      code: 'MODEL_CREDENTIAL_MISSING',
      message: 'Model provider credential is not configured in the service process. Set the provider API key and restart the service.',
    });
  });
  it('shows a safe SDK cause in task details but never stores the raw provider message', async () => {
    const { service, runner } = await fixture(1);
    const submitted = await service.submit(input);
    await until(() => runner.calls.length === 1);
    runner.calls[0]!.fail(new CodexDiagnosticError('CODEX_NETWORK_ERROR', 'stream.error'));
    await until(() => service.getTask(submitted.taskId).status === 'failed');
    expect(service.getTask(submitted.taskId).error).toMatchObject({ code: 'CODEX_NETWORK_ERROR' });
    expect(service.getTask(submitted.taskId).error?.message).toContain('stream.error');
  });
  it('persists the execution deadline and safe step metadata with running tasks', async () => {
    const { service, runner } = await fixture(1, 2, 5);
    const submitted = await service.submit(input);
    await until(() => runner.calls.length === 1);
    expect(service.getTask(submitted.taskId).timeoutSeconds).toBe(5);
    await runner.calls[0]!.report({ kind: 'progress', detail: 'command_execution', state: 'completed', durationMs: 120 });
    expect(service.getTask(submitted.taskId).progress).toContainEqual(expect.objectContaining({
      kind: 'progress', detail: 'command_execution', state: 'completed', durationMs: 120,
    }));
    runner.calls[0]!.finish();
    await until(() => service.getTask(submitted.taskId).status === 'succeeded');
  });
  it('pins each task sandbox across queuing and restart while preserving old session hashes', async () => {
    const { service, runner, config, dir } = await fixture(1);
    const first = await service.submit(input);
    await until(() => runner.calls.length === 1);
    const savedSession = JSON.parse(await readFile(join(dir, 'sessions', `${first.sessionId}.json`), 'utf8'));
    const oldHash = createHash('sha256').update(JSON.stringify({ policy: 'native-full-access-v1',
      directory: await realpath(config.defaultWorkingDirectory), model: config.defaultModel,
      modelReasoningEffort: config.defaultReasoningEffort, providerId: 'openai', codexHome: config.codexHome,
      runner: config.runner, envAllowlist: config.envAllowlist, codexPath: config.codexPath })).digest('hex');
    expect(savedSession.configHash).toBe(oldHash);
    runner.calls[0]!.finish();
    await until(() => service.getTask(first.taskId).status === 'succeeded');
    config.sandboxMode = 'danger-full-access';
    await service.submit({ ...input, sessionId: first.sessionId, sandboxMode: 'workspace-write' });
    await until(() => runner.calls.length === 2);
    expect(runner.calls[1]!.execution).toMatchObject({ sandboxMode: 'workspace-write', threadId: 'thread-0' });
    const queued = await service.submit(input);
    await service.close();
    const nextRunner = new ControlledRunner();
    const next = new TaskService({ ...config, sandboxMode: 'read-only' }, new FileStore(dir), nextRunner);
    await next.init(); cleanup.push(() => next.close());
    await until(() => nextRunner.calls.length === 1);
    expect(nextRunner.calls[0]!.execution).toMatchObject({ taskId: queued.taskId, sandboxMode: 'danger-full-access' });
    expect(next.getTask(first.taskId).result?.markdown).toBe('Verified result');
    expect(next.info()).toMatchObject({ accessMode: 'read-only', readOnly: true, networkAccess: false });
    await expect(next.submit({ ...input, sandboxMode: 'invented' } as any)).rejects.toThrow();
    await next.submit({ ...input, sessionId: first.sessionId });
    nextRunner.calls[0]!.finish();
    await until(() => nextRunner.calls.length === 2);
    expect(nextRunner.calls[1]!.execution).toMatchObject({ sandboxMode: 'read-only', threadId: 'thread-0' });
  });

  it('keeps permission selection in idempotency and retries without upgrading a task', async () => {
    const { service, runner, config } = await fixture();
    const request = { ...input, sandboxMode: 'read-only' as const, idempotencyKey: 'sandbox-request' };
    const original = await service.submit(request);
    expect((await service.submit(request)).taskId).toBe(original.taskId);
    await expect(service.submit({ ...request, sandboxMode: 'danger-full-access' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await until(() => runner.calls.length === 1);
    await service.cancel(original.taskId);
    await until(() => service.getTask(original.taskId).status === 'cancelled');
    config.sandboxMode = 'danger-full-access';
    const retried = await service.retry(original.taskId, 'retry-sandbox');
    await until(() => runner.calls.length === 2);
    expect(retried.sandboxMode).toBe('read-only');
    expect(runner.calls[1]!.execution.sandboxMode).toBe('read-only');
  });

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
  it('applies a global provider switch only to new submissions while preserving queued and running work', async () => {
    const { service, runner, config } = await fixture(1, 3);
    config.modelProviders = [
      { id: 'openai', label: 'OpenAI / Codex' },
      { id: 'model_studio', label: 'Model Studio', baseUrl: 'https://dashscope.example.test/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY', defaultModel: 'qwen-test' },
    ];
    config.activeProvider = 'openai';
    config.envAllowlist.push('DASHSCOPE_API_KEY');
    const running = await service.submit({ question: 'old running' });
    const queued = await service.submit({ question: 'old queued' });
    await until(() => runner.calls.length === 1);
    const original = service.getSettings();
    await service.updateSettings({ revision: original.revision, settings: {
      ...original.settings, activeProvider: 'model_studio', defaultModel: 'qwen-test', defaultReasoningEffort: null,
    } }, 'admin');
    expect(runner.calls[0]!.execution.providerId).toBe('openai');
    expect(service.getTask(queued.taskId).status).toBe('queued');
    await expect(service.submit({ question: 'follow-up', sessionId: running.sessionId })).rejects.toMatchObject({ code: 'SESSION_CONFIG_CHANGED' });
    const newTask = await service.submit({ question: 'new provider' });
    runner.calls[0]!.finish();
    await until(() => runner.calls.length === 2);
    expect(runner.calls[1]!.execution).toMatchObject({ taskId: queued.taskId, providerId: 'openai' });
    runner.calls[1]!.finish();
    await until(() => runner.calls.length === 3);
    expect(runner.calls[2]!.execution).toMatchObject({ taskId: newTask.taskId, providerId: 'model_studio',
      providerBaseUrl: 'https://dashscope.example.test/compatible-mode/v1', providerEnvKey: 'DASHSCOPE_API_KEY', model: 'qwen-test' });
  });
  it('restores the global provider after restart without migrating previously queued tasks', async () => {
    const { service, runner, config, dir } = await fixture(1, 2);
    config.modelProviders = [
      { id: 'openai', label: 'OpenAI / Codex' },
      { id: 'model_studio', label: 'Model Studio', baseUrl: 'https://dashscope.example.test/v1', envKey: 'DASHSCOPE_API_KEY', defaultModel: 'qwen-test' },
    ];
    const running = await service.submit({ question: 'old running' });
    const queued = await service.submit({ question: 'old queued' });
    await until(() => runner.calls.length === 1);
    const current = service.getSettings();
    await service.updateSettings({ revision: current.revision, settings: {
      ...current.settings, activeProvider: 'model_studio', defaultModel: 'qwen-test',
    } }, 'admin');
    await service.close();
    expect(service.getTask(running.taskId).status).toBe('interrupted');
    const resumedRunner = new ControlledRunner();
    const resumed = new TaskService({ ...config, activeProvider: 'openai', defaultModel: undefined }, new FileStore(dir), resumedRunner);
    await resumed.init(); cleanup.push(() => resumed.close());
    expect(resumed.getSettings().settings).toMatchObject({ activeProvider: 'model_studio', defaultModel: 'qwen-test' });
    await until(() => resumedRunner.calls.length === 1);
    expect(resumedRunner.calls[0]!.execution).toMatchObject({ taskId: queued.taskId, providerId: 'openai' });
    const fresh = await resumed.submit({ question: 'new after restart' });
    resumedRunner.calls[0]!.finish();
    await until(() => resumedRunner.calls.length === 2);
    expect(resumedRunner.calls[1]!.execution).toMatchObject({ taskId: fresh.taskId, providerId: 'model_studio', model: 'qwen-test' });
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
    await expect(service.submit({ ...input, sessionId: first.sessionId })).rejects.toMatchObject({ code: 'SESSION_CONFIG_CHANGED' });
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
    expect(service.getTask(b.taskId)).toMatchObject({ status: 'queued', scheduling: { reason: 'previous_task_failed' } });
    await service.resumeSession(a.sessionId, a.taskId);
    await until(() => service.getTask(b.taskId).status === 'running' && complete !== firstComplete);
    complete();
    await until(() => service.getTask(b.taskId).status === 'succeeded');
  });
});
