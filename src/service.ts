import { createHash, randomUUID } from 'node:crypto';
import { resolveWorkingDirectory } from './config.js';
import { InvocationLog, type InvocationTransport } from './invocations.js';
import { AppError, isTerminal, submitSchema, type Execution, type Runner, type RuntimeConfig, type Session, type Store, type SubmitInput, type Task } from './types.js';

const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const page = <T>(values: T[], offset: number, limit: number) => ({ total: values.length, offset, limit, items: values.slice(offset, offset + limit) });
const publicSession = ({ threadId: _threadId, configHash: _hash, ...session }: Session) => session;
const publicTask = ({ requestHash: _requestHash, configHash: _hash, ...task }: Task) => structuredClone(task);

export class TaskService {
  private tasks = new Map<string, Task>();
  private sessions = new Map<string, Session>();
  private active = new Map<string, { sessionId: string; controller: AbortController; done: Promise<void> }>();
  private serial: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closed = false;
  private fault = false;
  private initialized = false;
  readonly invocations: InvocationLog;
  constructor(readonly config: RuntimeConfig, private store: Store, private runner: Runner) {
    this.invocations = new InvocationLog(config.invocationLog);
  }
  private async saveTask(task: Task) {
    await this.persist(() => this.store.saveTask(task));
    await this.invocations.record(task);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn);
    this.serial = result.catch(() => {});
    return result;
  }
  private async persist(operation: () => Promise<void>) {
    try { await operation(); }
    catch (error) {
      this.fault = true;
      for (const running of this.active.values()) running.controller.abort();
      console.error('Storage failure; scheduler stopped. Inspect storage and restart.', (error as NodeJS.ErrnoException).code ?? 'IO_ERROR');
      throw new AppError('STORAGE_UNAVAILABLE', 'Storage unavailable; execution stopped. Administrator intervention required.', 503);
    }
  }
  async init() {
    const stored = await this.store.open();
    try {
      for (const session of stored.sessions) this.sessions.set(session.sessionId, session);
      for (const task of stored.tasks) {
        if (!this.sessions.has(task.sessionId)) throw new Error(`Task references missing session: ${task.taskId}`);
        if (task.status === 'running') {
          task.status = 'interrupted'; task.finishedAt = now();
          task.error = { code: 'PROCESS_INTERRUPTED', message: 'Previous execution stopped unexpectedly. Submit a new task to continue.' };
          await this.store.saveTask(task);
        }
        this.tasks.set(task.taskId, task);
      }
      await this.invocations.open([...this.tasks.values()]);
      this.initialized = true;
      await this.exclusive(() => this.drain());
    } catch (error) { await this.invocations.close(); await this.store.close(); throw error; }
  }
  private available() {
    if (!this.initialized || this.closing || this.fault) throw new AppError('SERVICE_UNAVAILABLE', 'Service is stopping or storage is unavailable.', 503);
  }
  private async context(session?: Session) {
    if (session && (session.version !== 2 || !session.workingDirectory)) {
      throw new AppError('LEGACY_SESSION', 'This legacy capability session is available for viewing only. Start a new native Codex session.', 409);
    }
    const runtime = {
      directory: await resolveWorkingDirectory(session?.workingDirectory ?? this.config.defaultWorkingDirectory),
      model: session ? session.model : this.config.defaultModel,
      modelReasoningEffort: session ? session.modelReasoningEffort : this.config.defaultReasoningEffort,
    };
    return { ...runtime, configHash: hash({ policy: 'native-full-access-v1', ...runtime, codexHome: this.config.codexHome, runner: this.config.runner, envAllowlist: this.config.envAllowlist, codexPath: this.config.codexPath }) };
  }
  async submit(raw: SubmitInput, transport: InvocationTransport = 'http') {
    const request = submitSchema.parse(raw);
    return this.exclusive(async () => {
      this.available();
      const requestHash = hash(request);
      if (request.idempotencyKey) {
        const previous = [...this.tasks.values()].find(task => task.request.idempotencyKey === request.idempotencyKey);
        if (previous) {
          if (previous.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key already used with different parameters.', 409);
          return publicTask(previous);
        }
      }
      const existing = request.sessionId ? this.sessions.get(request.sessionId) : undefined;
      if (request.sessionId && !existing) throw new AppError('NOT_FOUND', 'Session does not exist.', 404);
      const { configHash, directory, model, modelReasoningEffort } = await this.context(existing);
      let session: Session;
      if (request.sessionId) {
        if (existing!.configHash !== configHash) {
          throw new AppError('SESSION_CONFIG_CHANGED', 'Session directory, model, reasoning effort or execution configuration differs. Start a new session.', 409);
        }
        session = existing!;
      } else {
        session = { version: 2, sessionId: `sess_${randomUUID()}`, workingDirectory: directory, model, modelReasoningEffort, configHash, createdAt: now() };
      }
      const pending = [...this.tasks.values()].filter(task => task.status === 'queued');
      const sessionBusy = [...this.active.values()].some(active => active.sessionId === session.sessionId);
      const canStart = this.active.size < this.config.maxConcurrent && !sessionBusy && !pending.some(t => t.sessionId === session.sessionId);
      if (!canStart && pending.length >= this.config.maxQueued) throw new AppError('QUEUE_FULL', 'Task queue is full. Retry later with the same idempotencyKey.', 429);
      const task: Task = { version: 2, taskId: `task_${randomUUID()}`, sessionId: session.sessionId, request, requestHash, configHash, status: 'queued', createdAt: now(), progress: [] };
      if (this.invocations.enabled) task.invocationTransport = transport;
      if (!request.sessionId) {
        await this.persist(() => this.store.saveSession(session));
        this.sessions.set(session.sessionId, session);
      }
      await this.saveTask(task);
      this.tasks.set(task.taskId, task);
      await this.drain();
      return publicTask(task);
    });
  }
  private async drain() {
    if (this.closing || this.fault) return;
    const queued = [...this.tasks.values()].filter(task => task.status === 'queued').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const task of queued) {
      if (this.active.size >= this.config.maxConcurrent) break;
      if ([...this.active.values()].some(active => active.sessionId === task.sessionId)) continue;
      try {
        if (task.version !== 2) throw new AppError('LEGACY_SESSION', 'Legacy queued task requires a new native session.');
        if ((await this.context(this.sessions.get(task.sessionId))).configHash !== task.configHash) throw new Error('Configuration changed');
      } catch (error) {
        task.status = 'failed'; task.finishedAt = now();
        task.error = { code: error instanceof AppError ? error.code : 'CONFIG_CHANGED', message: 'Queued task cannot use its original execution context. Submit a new session.' };
        await this.saveTask(task);
        continue;
      }
      task.status = 'running'; task.startedAt = now();
      await this.saveTask(task);
      const controller = new AbortController();
      const active = { sessionId: task.sessionId, controller, done: Promise.resolve() };
      this.active.set(task.taskId, active);
      active.done = this.execute(task, controller).catch(() => { this.fault = true; });
    }
  }
  private execution(task: Task): Execution {
    const session = this.sessions.get(task.sessionId)!;
    const env: Record<string, string> = {};
    const permitted = ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL', ...this.config.envAllowlist];
    for (const key of permitted) if (process.env[key] !== undefined && key !== this.config.tokenEnv && key !== 'NODE_OPTIONS' && key !== 'CODEX_HOME') env[key] = process.env[key]!;
    env.CODEX_HOME = this.config.codexHome;
    return { taskId: task.taskId, question: task.request.question, context: task.request.context, directory: session.workingDirectory!,
      codexHome: this.config.codexHome, model: session.model, modelReasoningEffort: session.modelReasoningEffort, threadId: session.threadId,
      env, codexPath: this.config.codexPath };
  }
  private async execute(task: Task, controller: AbortController) {
    const timer = setTimeout(() => {
      void this.exclusive(async () => {
        if (!isTerminal(task) && !task.stopReason) {
          task.stopReason = 'timed_out';
          controller.abort();
          await this.persist(() => this.store.saveTask(task));
        }
      }).catch(() => {});
    }, this.config.timeoutSeconds * 1000);
    try {
      const result = await this.runner.run(this.execution(task), controller.signal, event => this.exclusive(async () => {
        if (this.fault) throw new Error('Storage unavailable');
        if (event.kind === 'thread') {
          const session = this.sessions.get(task.sessionId)!;
          if (session.threadId && session.threadId !== event.threadId) throw new Error('Runner changed the session thread');
          session.threadId = event.threadId;
          await this.persist(() => this.store.saveSession(session));
        } else {
          task.progress.push({ at: now(), kind: event.kind, detail: event.detail.slice(0, 200) });
          task.progress = task.progress.slice(-100);
          await this.persist(() => this.store.saveTask(task));
        }
      }));
      await this.exclusive(async () => {
        if (this.fault) return;
        const finished: Task = { ...task, status: task.stopReason ?? 'succeeded', finishedAt: now() };
        if (!task.stopReason) finished.result = result;
        await this.saveTask(finished);
        Object.assign(task, finished);
      });
    } catch (error) {
      await this.exclusive(async () => {
        if (this.fault) return;
        const finished: Task = { ...task, status: task.stopReason ?? 'failed', finishedAt: now() };
        finished.error = { code: task.stopReason?.toUpperCase() ?? (error instanceof AppError ? error.code : 'EXECUTION_FAILED'),
          message: task.stopReason ? `Task ${task.stopReason}.` : 'Codex execution failed. Check service diagnostics and model authentication; submit a follow-up when resolved.' };
        // Deliberately omit arbitrary CLI stderr, which can contain credentials or source data.
        console.error(JSON.stringify({ taskId: task.taskId, code: finished.error.code }));
        await this.saveTask(finished);
        Object.assign(task, finished);
      });
    } finally {
      clearTimeout(timer);
      await this.exclusive(async () => { this.active.delete(task.taskId); await this.drain(); });
    }
  }
  async cancel(taskId: string) {
    return this.exclusive(async () => {
      this.available();
      const task = this.findTask(taskId);
      if (isTerminal(task) || task.stopReason) return publicTask(task);
      task.stopReason = 'cancelled';
      if (task.status === 'queued') { task.status = 'cancelled'; task.finishedAt = now(); }
      else this.active.get(taskId)?.controller.abort();
      await this.saveTask(task);
      return publicTask(task);
    });
  }
  private findTask(id: string) {
    const task = this.tasks.get(id);
    if (!task) throw new AppError('NOT_FOUND', 'Task does not exist.', 404);
    return task;
  }
  private readable() {
    if (this.fault) throw new AppError('STORAGE_UNAVAILABLE', 'Task state is unavailable after a storage failure.', 503);
  }
  getTask(id: string) { this.readable(); return publicTask(this.findTask(id)); }
  listSessions(offset: number, limit: number) {
    this.readable();
    return page([...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicSession), offset, limit);
  }
  getSession(id: string, offset: number, limit: number) {
    this.readable();
    const session = this.sessions.get(id);
    if (!session) throw new AppError('NOT_FOUND', 'Session does not exist.', 404);
    const tasks = [...this.tasks.values()].filter(task => task.sessionId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { ...publicSession(session), tasks: page(tasks.map(t => ({ taskId: t.taskId, status: t.status, question: t.request.question, createdAt: t.createdAt })), offset, limit) };
  }
  info() {
    return { defaultWorkingDirectory: this.config.defaultWorkingDirectory, defaultModel: this.config.defaultModel,
      defaultReasoningEffort: this.config.defaultReasoningEffort, maxConcurrent: this.config.maxConcurrent, maxQueued: this.config.maxQueued,
      accessMode: 'danger-full-access', readOnly: false, networkAccess: true, webSearch: 'live', runner: this.config.runner };
  }
  health() { return { ready: this.initialized && !this.closing && !this.fault, running: this.active.size, queued: [...this.tasks.values()].filter(t => t.status === 'queued').length, runner: this.config.runner }; }
  async close() {
    if (this.closed) return;
    await this.exclusive(async () => {
      this.closing = true;
      for (const [id, running] of this.active) {
        const task = this.tasks.get(id)!;
        task.stopReason ??= 'interrupted';
        running.controller.abort();
      }
    });
    await Promise.all([...this.active.values()].map(r => r.done));
    await this.invocations.close();
    await this.store.close();
    this.closed = true;
  }
}
