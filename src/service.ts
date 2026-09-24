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
  private pending = new Map<string, Task>();
  private sessionTasks = new Map<string, Task[]>();
  private idempotency = new Map<string, Task>();
  private admissions = new Map<string, { hash: string; promise: Promise<ReturnType<TaskService['viewTask']>> }>();
  private receiving = 0;
  private sequence = 0;
  private queueTimer?: NodeJS.Timeout;
  private activeSessions = new Map<string, string>();
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
  private get admissionLimit() { return this.config.maxConcurrent + this.config.maxQueued; }
  private reserveAdmission() {
    if (this.receiving >= this.admissionLimit) throw new AppError('ADMISSION_FULL', 'Submission capacity is full. Retry later with the same idempotencyKey.', 429);
    this.receiving++;
  }
  private indexTask(task: Task) {
    this.tasks.set(task.taskId, task);
    const history = this.sessionTasks.get(task.sessionId) ?? [];
    history.push(task); this.sessionTasks.set(task.sessionId, history);
    if (task.status === 'queued') this.pending.set(task.taskId, task);
    if (task.request.idempotencyKey) {
      if (this.idempotency.has(task.request.idempotencyKey)) throw new Error('Duplicate persisted idempotency key');
      this.idempotency.set(task.request.idempotencyKey, task);
    }
  }
  private blocker(task: Task): { reason: string; blockedByTaskId?: string } | undefined {
    const head = [...this.pending.values()].find(queued => queued.sessionId === task.sessionId);
    if (head && head.taskId !== task.taskId) {
      return this.blocker(head) ?? { reason: 'session_predecessor', blockedByTaskId: head.taskId };
    }
    let current = task;
    // Dependencies always point backwards in this session's accepted order.
    while (current.dependsOnTaskId && !current.dependencyApprovedAt) {
      const previous = this.tasks.get(current.dependsOnTaskId)!;
      if (isTerminal(previous)) {
        if (previous.status !== 'succeeded') return { reason: 'previous_task_failed', blockedByTaskId: previous.taskId };
        break;
      }
      if (previous.status === 'running') return { reason: 'session_active', blockedByTaskId: previous.taskId };
      current = previous;
    }
    const active = this.activeSessions.get(task.sessionId);
    if (active) return { reason: 'session_active', blockedByTaskId: active };
    if (current !== task) return { reason: 'session_predecessor', blockedByTaskId: task.dependsOnTaskId };
    return undefined;
  }
  private viewTask(task: Task) {
    const scheduling = task.status === 'queued' ? {
      ...(this.closing ? { reason: 'service_stopping' } : this.fault ? { reason: 'storage_unavailable' } : this.blocker(task)
        ?? { reason: this.active.size >= this.config.maxConcurrent ? 'capacity' : 'ready' }),
      queueExpiresAt: task.queueExpiresAt,
    } : undefined;
    return { ...publicTask(task), ...(scheduling ? { scheduling } : {}) };
  }
  private armQueueTimer() {
    clearTimeout(this.queueTimer);
    if (this.closing || this.fault || !this.pending.size) return;
    const deadline = Math.min(...[...this.pending.values()].map(task => Date.parse(task.queueExpiresAt!)));
    this.queueTimer = setTimeout(() => {
      void this.exclusive(() => this.drain()).catch(() => { this.fault = true; });
    }, Math.max(1, Math.min(2147483647, deadline - Date.now())));
    this.queueTimer.unref();
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
      clearTimeout(this.queueTimer);
      for (const running of this.active.values()) running.controller.abort();
      console.error('Storage failure; scheduler stopped. Inspect storage and restart.', (error as NodeJS.ErrnoException).code ?? 'IO_ERROR');
      throw new AppError('STORAGE_UNAVAILABLE', 'Storage unavailable; execution stopped. Administrator intervention required.', 503);
    }
  }
  async init() {
    const stored = await this.store.open();
    try {
      for (const session of stored.sessions) this.sessions.set(session.sessionId, session);
      // Migrate legacy tasks once in a deterministic order; new work uses persisted sequence numbers.
      const sequenced = stored.tasks.filter(task => task.enqueueSequence !== undefined);
      if (new Set(sequenced.map(task => task.enqueueSequence)).size !== sequenced.length) throw new Error('Duplicate task sequence');
      this.sequence = sequenced.reduce((max, task) => Math.max(max, task.enqueueSequence!), 0);
      const lastBySession = new Map<string, Task>();
      for (const task of sequenced.sort((a,b) => a.enqueueSequence! - b.enqueueSequence!)) lastBySession.set(task.sessionId, task);
      for (const task of stored.tasks.filter(task => task.enqueueSequence === undefined).sort((a,b) => a.createdAt.localeCompare(b.createdAt)
        || Number(a.status === 'queued') - Number(b.status === 'queued') || a.taskId.localeCompare(b.taskId))) {
        if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Task sequence exhausted');
        task.enqueueSequence = ++this.sequence;
        if (task.status === 'queued') {
          task.dependsOnTaskId ??= lastBySession.get(task.sessionId)?.taskId;
        }
        await this.store.saveTask(task);
        lastBySession.set(task.sessionId, task);
      }
      for (const task of stored.tasks.sort((a,b) => a.enqueueSequence! - b.enqueueSequence!)) {
        if (!this.sessions.has(task.sessionId)) throw new Error(`Task references missing session: ${task.taskId}`);
        if (task.dependsOnTaskId) {
          const previous = this.tasks.get(task.dependsOnTaskId);
          if (!previous || previous.sessionId !== task.sessionId) throw new Error('Invalid task dependency');
        }
        if (task.status === 'queued' && !task.queueExpiresAt) {
          task.queueExpiresAt = new Date(Date.parse(task.createdAt) + (this.config.queueTimeoutSeconds ?? 1800) * 1000).toISOString();
          await this.store.saveTask(task);
        }
        if (task.status === 'running') {
          task.status = 'interrupted'; task.finishedAt = now();
          task.error = { code: 'PROCESS_INTERRUPTED', message: 'Previous execution stopped unexpectedly. Submit a new task to continue.' };
          await this.store.saveTask(task);
        }
        this.indexTask(task);
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
    this.available();
    const requestHash = hash(request), key = request.idempotencyKey;
    if (key) {
      const inFlight = this.admissions.get(key);
      if (inFlight) {
        if (inFlight.hash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key already used with different parameters.', 409);
        this.reserveAdmission();
        try { return structuredClone(await inFlight.promise); }
        finally { this.receiving--; }
      }
      const previous = this.idempotency.get(key);
      if (previous) {
        if (previous.requestHash !== requestHash) throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key already used with different parameters.', 409);
        return this.viewTask(previous);
      }
    }
    this.reserveAdmission();
    const operation = this.exclusive(async () => {
      this.available();
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
      const previous = [...this.pending.values()].findLast(task => task.sessionId === session.sessionId)
        ?? this.tasks.get(this.activeSessions.get(session.sessionId) ?? '');
      const sessionBusy = !!previous;
      const canStart = this.active.size < this.config.maxConcurrent && !sessionBusy;
      if (!canStart && this.pending.size >= this.config.maxQueued) throw new AppError('QUEUE_FULL', 'Task queue is full. Retry later with the same idempotencyKey.', 429);
      if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new AppError('SEQUENCE_EXHAUSTED', 'Task sequence exhausted.', 503);
      const task: Task = { version: 2, taskId: `task_${randomUUID()}`, sessionId: session.sessionId, request, requestHash, configHash, status: 'queued', createdAt: now(), progress: [],
        enqueueSequence: ++this.sequence, queueExpiresAt: new Date(Date.now() + (this.config.queueTimeoutSeconds ?? 1800) * 1000).toISOString(),
        dependsOnTaskId: previous && !isTerminal(previous) ? previous.taskId : undefined };
      if (this.invocations.enabled) task.invocationTransport = transport;
      if (!request.sessionId) {
        await this.persist(() => this.store.saveSession(session));
        this.sessions.set(session.sessionId, session);
      }
      await this.saveTask(task);
      this.indexTask(task);
      await this.drain();
      return this.viewTask(task);
    });
    if (key) this.admissions.set(key, { hash: requestHash, promise: operation });
    try { return await operation; }
    finally { this.receiving--; if (key) this.admissions.delete(key); }
  }
  private async expireQueuedTask(task: Task) {
    if (Date.parse(task.queueExpiresAt!) > Date.now()) return false;
    const expired: Task = { ...task, status: 'timed_out', finishedAt: now(), error: { code: 'QUEUE_EXPIRED', message: 'Queue waiting deadline exceeded; execution did not start.' } };
    await this.saveTask(expired); Object.assign(task, expired); this.pending.delete(task.taskId);
    return true;
  }
  private async drain() {
    if (this.closing || this.fault) return;
    for (const task of this.pending.values()) await this.expireQueuedTask(task);
    for (const task of this.pending.values()) {
      if (this.closing || this.fault) break;
      if (this.active.size >= this.config.maxConcurrent) break;
      try {
        if (task.version !== 2) throw new AppError('LEGACY_SESSION', 'Legacy queued task requires a new native session.');
        if ((await this.context(this.sessions.get(task.sessionId))).configHash !== task.configHash) throw new Error('Configuration changed');
      } catch (error) {
        task.status = 'failed'; task.finishedAt = now();
        task.error = { code: error instanceof AppError ? error.code : 'CONFIG_CHANGED', message: 'Queued task cannot use its original execution context. Submit a new session.' };
        await this.saveTask(task);
        this.pending.delete(task.taskId);
        continue;
      }
      if (this.blocker(task)) continue;
      if (this.closing || this.fault) break;
      if (await this.expireQueuedTask(task)) continue;
      const starting: Task = { ...task, status: 'running', startedAt: now() };
      await this.saveTask(starting);
      // Persistence may be slow; do not launch work that expired or was stopped during the write.
      if (this.closing) { await this.saveTask(task); break; }
      if (await this.expireQueuedTask(task)) continue;
      Object.assign(task, starting);
      this.pending.delete(task.taskId);
      const controller = new AbortController();
      const active = { sessionId: task.sessionId, controller, done: Promise.resolve() };
      this.active.set(task.taskId, active);
      this.activeSessions.set(task.sessionId, task.taskId);
      active.done = this.execute(task, controller).catch(() => { this.fault = true; });
    }
    this.armQueueTimer();
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
      await this.exclusive(async () => { this.active.delete(task.taskId); this.activeSessions.delete(task.sessionId); await this.drain(); });
    }
  }
  async cancel(taskId: string) {
    return this.exclusive(async () => {
      this.available();
      const task = this.findTask(taskId);
      if (isTerminal(task) || task.stopReason) return this.viewTask(task);
      task.stopReason = 'cancelled';
      if (task.status === 'queued') { task.status = 'cancelled'; task.finishedAt = now(); }
      else this.active.get(taskId)?.controller.abort();
      await this.saveTask(task);
      if (task.status === 'cancelled') this.pending.delete(task.taskId);
      await this.drain();
      return this.viewTask(task);
    });
  }
  async resumeSession(sessionId: string, blockedByTaskId: string) {
    return this.exclusive(async () => {
      this.available();
      if (!this.sessions.has(sessionId)) throw new AppError('NOT_FOUND', 'Session does not exist.', 404);
      const candidates = [...this.pending.values()].filter(task => task.sessionId === sessionId && task.dependsOnTaskId === blockedByTaskId && !task.dependencyApprovedAt);
      const blocker = this.tasks.get(blockedByTaskId);
      if (!blocker || blocker.sessionId !== sessionId || !isTerminal(blocker) || blocker.status === 'succeeded') throw new AppError('BLOCKER_CHANGED', 'Failure no longer matches. Refresh before confirming.', 409);
      const failures = [...this.pending.values()].filter(task => task.sessionId === sessionId).map(task => this.blocker(task)).filter(wait => wait?.reason === 'previous_task_failed');
      if (failures.length && !failures.some(wait => wait!.blockedByTaskId === blockedByTaskId)) throw new AppError('BLOCKER_CHANGED', 'A different predecessor now blocks this session. Refresh before confirming.', 409);
      let resumed = 0;
      for (const task of candidates) {
        const approved = { ...task, dependencyApprovedAt: now(), progress: [...task.progress, { at: now(), kind: 'queue_resumed', detail: `Acknowledged predecessor ${blockedByTaskId}` }].slice(-100) };
        await this.saveTask(approved); Object.assign(task, approved); resumed++;
      }
      await this.drain();
      return { sessionId, blockedByTaskId, resumed };
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
  getTask(id: string) { this.readable(); return this.viewTask(this.findTask(id)); }
  listSessions(offset: number, limit: number) {
    this.readable();
    return page([...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicSession), offset, limit);
  }
  getSession(id: string, offset: number, limit: number) {
    this.readable();
    const session = this.sessions.get(id);
    if (!session) throw new AppError('NOT_FOUND', 'Session does not exist.', 404);
    const tasks = this.sessionTasks.get(id) ?? [];
    const result = page(tasks, offset, limit);
    return { ...publicSession(session), tasks: { ...result, items: result.items.map(t => ({ taskId: t.taskId, status: t.status, question: t.request.question, createdAt: t.createdAt })) } };
  }
  info() {
    return { defaultWorkingDirectory: this.config.defaultWorkingDirectory, defaultModel: this.config.defaultModel,
      defaultReasoningEffort: this.config.defaultReasoningEffort, maxConcurrent: this.config.maxConcurrent, maxQueued: this.config.maxQueued,
      queueTimeoutSeconds: this.config.queueTimeoutSeconds ?? 1800, timeoutSeconds: this.config.timeoutSeconds, admissionLimit: this.admissionLimit,
      accessMode: 'danger-full-access', readOnly: false, networkAccess: true, webSearch: 'live', runner: this.config.runner };
  }
  health() { return { ready: this.initialized && !this.closing && !this.fault, running: this.active.size, queued: this.pending.size,
    receiving: this.receiving, admissionLimit: this.admissionLimit, blocked: [...this.pending.values()].filter(task => this.blocker(task)?.reason === 'previous_task_failed').length, runner: this.config.runner }; }
  async close() {
    if (this.closed) return;
    this.closing = true;
    clearTimeout(this.queueTimer);
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
