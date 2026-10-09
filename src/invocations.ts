import { lstat, mkdir, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { atomicJson } from './storage.js';
import { canonicalStoragePath } from './paths.js';
import { AppError, contextSchema, idSchema, statusSchema, type Task } from './types.js';

export type InvocationConfig = { enabled: boolean; directory: string; retentionDays: number };
export type InvocationTransport = 'http' | 'mcp' | 'stdio' | 'scheduled';
export const invocationQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  status: statusSchema.optional(), keyword: z.string().trim().max(200).optional(),
  offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict().refine(q => !q.from || !q.to || Date.parse(q.from) <= Date.parse(q.to), 'from must not exceed to');
type Query = z.infer<typeof invocationQuerySchema>;
const recordSchema = z.object({
  version: z.literal(1), taskId: idSchema, sessionId: idSchema,
  transport: z.enum(['http', 'mcp', 'stdio', 'scheduled']), question: z.string(), context: contextSchema.optional(),
  status: statusSchema, receivedAt: z.iso.datetime({ offset: true }),
  startedAt: z.iso.datetime({ offset: true }).optional(), finishedAt: z.iso.datetime({ offset: true }).optional(),
  durationMs: z.number().nonnegative().nullable(), usage: z.record(z.string(), z.number()).nullable(),
  resultMarkdown: z.string().nullable(), error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
type Invocation = z.infer<typeof recordSchema>;
const finished = (row: Invocation) => row.status !== 'queued' && row.status !== 'running';
const tokens = (row: Invocation) => row.usage ? Math.max(0, row.usage.input_tokens ?? 0) + Math.max(0, row.usage.output_tokens ?? 0) : null;

export class InvocationLog {
  private rows = new Map<string, Invocation>();
  private serial: Promise<void> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private healthy = true;
  private canonicalRoot?: string;
  private config?: InvocationConfig;
  constructor(config?: InvocationConfig) { this.config = config ? { ...config } : undefined; }
  setConfigBeforeOpen(config?: InvocationConfig) { this.config = config ? { ...config } : undefined; }
  get enabled() { return this.config?.enabled === true; }
  status() { return { enabled: this.enabled, healthy: this.healthy, retentionDays: this.config?.retentionDays ?? 30 }; }
  private async guarded(operation: () => Promise<void>) {
    if (!this.enabled) return;
    const next = this.serial.then(operation).catch(() => {
      if (this.healthy) console.error('Invocation log unavailable; task execution continues. Inspect log storage and restart.');
      this.healthy = false;
    });
    this.serial = next; await next;
  }
  private async safeDirectory(directory: string) {
    const root = resolve(this.config!.directory);
    const rel = relative(root, resolve(directory));
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Log directory is outside its root');
    // Trust configured ancestors (e.g. macOS /var), but never links inside the log root.
    for (let path = resolve(directory); ; path = dirname(path)) {
      try { if ((await lstat(path)).isSymbolicLink()) throw new Error('Invocation log directory must not contain links'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (path === root) break;
    }
    if (this.canonicalRoot && await realpath(root) !== this.canonicalRoot) throw new Error('Log root changed');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    this.canonicalRoot ??= await realpath(root);
  }
  private expired(row: Invocation) {
    return finished(row) && Date.parse(row.receivedAt) < Date.now() - this.config!.retentionDays * 86_400_000;
  }
  private file(row: Invocation) { return join(this.config!.directory, row.receivedAt.slice(0, 10), `${row.taskId}.json`); }
  async open(tasks: Task[]) {
    await this.guarded(async () => {
      const root = resolve(this.config!.directory);
      // Pin trusted ancestors to their physical location, preserving the root link check.
      this.config = { ...this.config!, directory: join(await canonicalStoragePath(dirname(root)), basename(root)) };
      await this.safeDirectory(this.config!.directory);
      for (const day of await readdir(this.config!.directory, { withFileTypes: true })) {
        if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
        for (const file of await readdir(join(this.config!.directory, day.name), { withFileTypes: true })) {
          if (!file.isFile() || !/^task_[0-9a-f-]{36}\.json$/.test(file.name)) continue;
          try {
            const row = recordSchema.parse(JSON.parse(await readFile(join(this.config!.directory, day.name, file.name), 'utf8')));
            if (row.receivedAt.slice(0, 10) !== day.name || `${row.taskId}.json` !== file.name) throw new Error('Record path mismatch');
            this.rows.set(row.taskId, row);
          } catch { this.healthy = false; }
        }
      }
    });
    // Only tasks accepted while logging was enabled are reconciled after a restart.
    for (const task of tasks) await this.record(task);
    await this.prune();
    if (this.enabled) { clearInterval(this.timer); this.timer = setInterval(() => { void this.prune(); }, 3_600_000); this.timer.unref(); }
  }
  async reconfigure(settings: Pick<InvocationConfig, 'enabled' | 'retentionDays'>, tasks: Task[]) {
    const wasEnabled = this.enabled;
    if (wasEnabled && !settings.enabled) {
      await this.serial;
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.config = { ...this.config!, ...settings };
    if (!wasEnabled && settings.enabled) await this.open(tasks);
    else if (settings.enabled) await this.prune();
    return this.status();
  }
  async record(task: Task) {
    if (!this.enabled || !task.invocationTransport) return;
    const snapshot = structuredClone(task);
    await this.guarded(async () => {
      const task = snapshot;
      const row = recordSchema.parse({
        version: 1, taskId: task.taskId, sessionId: task.sessionId, transport: task.invocationTransport,
        question: task.request.question, context: task.request.context, status: task.status,
        receivedAt: task.createdAt, startedAt: task.startedAt, finishedAt: task.finishedAt,
        durationMs: task.startedAt && task.finishedAt ? Math.max(0, Date.parse(task.finishedAt) - Date.parse(task.startedAt)) : null,
        usage: task.result?.usage ?? null, resultMarkdown: task.result?.markdown ?? null, error: task.error ?? null,
      });
      if (this.expired(row)) {
        if (this.rows.has(row.taskId)) {
          await this.safeDirectory(join(this.config!.directory, row.receivedAt.slice(0, 10)));
          await unlink(this.file(row)).catch(error => { if (error.code !== 'ENOENT') throw error; });
          this.rows.delete(row.taskId);
        }
        return;
      }
      await this.safeDirectory(join(this.config!.directory, row.receivedAt.slice(0, 10)));
      await atomicJson(this.file(row), row);
      this.rows.set(row.taskId, row);
    });
  }
  async prune() {
    await this.guarded(async () => {
      await this.safeDirectory(this.config!.directory);
      for (const [id, row] of this.rows) {
        if (!this.expired(row)) continue;
        const path = this.file(row);
        await this.safeDirectory(join(this.config!.directory, row.receivedAt.slice(0, 10)));
        try { if (!(await lstat(path)).isFile()) throw new Error('Not a regular log file'); await unlink(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.rows.delete(id);
      }
    });
  }
  private matching(query: Query) {
    if (!this.enabled) return [];
    const keyword = query.keyword?.toLocaleLowerCase();
    return [...this.rows.values()].filter(row => !this.expired(row)
      && (!query.from || Date.parse(row.receivedAt) >= Date.parse(query.from))
      && (!query.to || Date.parse(row.receivedAt) <= Date.parse(query.to))
      && (!query.status || row.status === query.status)
      && (!keyword || row.question.toLocaleLowerCase().includes(keyword)))
      .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt) || b.taskId.localeCompare(a.taskId));
  }
  list(query: Query) {
    const rows = this.matching(query);
    return { ...this.status(), total: rows.length, offset: query.offset, limit: query.limit,
      items: rows.slice(query.offset, query.offset + query.limit).map(row => ({
        taskId: row.taskId, sessionId: row.sessionId, transport: row.transport, status: row.status,
        receivedAt: row.receivedAt, durationMs: row.durationMs, totalTokens: tokens(row),
        questionPreview: row.question.slice(0, 160), resultPreview: (row.resultMarkdown ?? row.error?.message ?? '').slice(0, 160),
      })) };
  }
  summary(query: Query) {
    const rows = this.matching(query), completed = rows.filter(finished);
    const succeeded = rows.filter(row => row.status === 'succeeded').length;
    const durations = completed.map(row => row.durationMs).filter((n): n is number => n !== null);
    return { ...this.status(), total: rows.length, succeeded,
      failed: rows.filter(row => ['failed', 'timed_out', 'interrupted'].includes(row.status)).length,
      cancelled: rows.filter(row => row.status === 'cancelled').length,
      running: rows.filter(row => row.status === 'running').length, queued: rows.filter(row => row.status === 'queued').length,
      successRate: completed.length ? succeeded * 100 / completed.length : null,
      averageDurationMs: durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null,
      totalTokens: rows.reduce((sum, row) => sum + (tokens(row) ?? 0), 0),
      usageKnownTasks: rows.filter(row => row.usage !== null).length };
  }
  detail(id: string) {
    if (!this.enabled) throw new AppError('INVOCATION_LOG_DISABLED', 'Invocation logging is disabled.', 409);
    const row = this.rows.get(id);
    if (!row || this.expired(row)) throw new AppError('NOT_FOUND', 'Invocation log does not exist.', 404);
    return structuredClone(row);
  }
  async close() { clearInterval(this.timer); await this.serial; }
}
