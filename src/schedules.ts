import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from './storage.js';
import { TaskService } from './service.js';
import { AppError, idSchema, sandboxModeSchema, submitSchema } from './types.js';

const lanes = 4;
const interval = 60_000;
const maxWaitingPerRule = 1000;
const scheduleId = z.string().regex(/^sched_[0-9a-f-]{36}$/);
const runId = z.string().regex(/^run_[0-9a-f-]{36}$/);
const inputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  question: submitSchema.shape.question,
  systemPrompt: submitSchema.shape.systemPrompt,
  intervalMinutes: z.number().int().min(1).max(10080),
  enabled: z.boolean(),
  sandboxMode: sandboxModeSchema.optional(),
}).strict();
const scheduleSchema = inputSchema.extend({
  version: z.literal(1), id: scheduleId, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  nextRunAt: z.iso.datetime(), sessions: z.array(idSchema.nullable()).length(lanes),
});
const runSchema = z.object({
  version: z.literal(1), id: runId, scheduleId, scheduledAt: z.iso.datetime(), createdAt: z.iso.datetime(),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  question: submitSchema.shape.question, systemPrompt: submitSchema.shape.systemPrompt, sandboxMode: sandboxModeSchema.optional(),
  state: z.enum(['waiting', 'submitted', 'finished', 'failed']), laneIndex: z.number().int().min(0).max(lanes - 1).optional(),
  taskId: idSchema.optional(), sessionId: idSchema.optional(), taskStatus: z.string().optional(),
  completedAt: z.iso.datetime().optional(), error: z.string().optional(),
});
export type ScheduledRule = z.infer<typeof scheduleSchema>;
export type ScheduledRun = z.infer<typeof runSchema>;
export type ScheduleInput = z.infer<typeof inputSchema>;

const active = (run: ScheduledRun) => run.state === 'submitted';
const isTerminal = (status: string) => status !== 'queued' && status !== 'running';
const dueRunId = (id: string, time: string) => {
  const hex = createHash('sha256').update(`${id}:${time}`).digest('hex');
  return `run_${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
};

export class ScheduleService {
  private rules = new Map<string, ScheduledRule>();
  private records = new Map<string, ScheduledRun>();
  private serial: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private initialized = false;
  private closed = false;
  private fault = false;
  private sequence = 0;
  private readonly root: string;
  constructor(private tasks: TaskService, private options: { autoStart?: boolean } = {}) {
    this.root = join(tasks.config.dataDir, 'schedules');
  }
  private exclusive<T>(action: () => Promise<T>) {
    const result = this.serial.then(action);
    this.serial = result.catch(() => {});
    return result;
  }
  private ensureOpen() {
    if (!this.initialized || this.closed || this.fault) throw new AppError('SCHEDULES_UNAVAILABLE', 'Scheduled tasks are unavailable.', 503);
  }
  private async save(path: string, value: unknown) {
    try { await atomicJson(path, value); }
    catch {
      this.fault = true;
      clearInterval(this.timer);
      throw new AppError('SCHEDULE_STORAGE_UNAVAILABLE', 'Scheduled task storage is unavailable; inspect the directory and restart.', 503);
    }
  }
  private async saveRule(rule: ScheduledRule) { await this.save(join(this.root, 'definitions', `${rule.id}.json`), rule); }
  private async saveRun(run: ScheduledRun) { await this.save(join(this.root, 'runs', `${run.id}.json`), run); }
  private async remove(path: string) {
    try { await unlink(path); }
    catch {
      this.fault = true;
      clearInterval(this.timer);
      throw new AppError('SCHEDULE_STORAGE_UNAVAILABLE', 'Scheduled task storage is unavailable; inspect the directory and restart.', 503);
    }
  }
  private async read<T>(folder: string, schema: z.ZodType<T>): Promise<T[]> {
    const result: T[] = [];
    for (const file of await readdir(join(this.root, folder))) {
      if (file.endsWith('.json')) result.push(schema.parse(JSON.parse(await readFile(join(this.root, folder, file), 'utf8'))));
    }
    return result;
  }
  async init() {
    if (this.initialized) return;
    await mkdir(join(this.root, 'definitions'), { recursive: true, mode: 0o700 });
    await mkdir(join(this.root, 'runs'), { recursive: true, mode: 0o700 });
    for (const rule of await this.read('definitions', scheduleSchema)) {
      if (this.rules.has(rule.id)) throw new Error('Duplicate schedule ID');
      this.rules.set(rule.id, rule);
    }
    for (const run of await this.read('runs', runSchema)) {
      if (!this.rules.has(run.scheduleId) || this.records.has(run.id)) throw new Error('Invalid stored scheduled run');
      this.records.set(run.id, run);
    }
    const sequences = new Set<number>();
    for (const run of this.records.values()) {
      if (sequences.has(run.sequence)) throw new Error('Duplicate scheduled run sequence');
      sequences.add(run.sequence);
      this.sequence = Math.max(this.sequence, run.sequence);
    }
    for (const rule of this.rules.values()) {
      const sessions = [...rule.sessions];
      const history = [...this.records.values()].filter(run => run.scheduleId === rule.id && run.laneIndex !== undefined && run.sessionId)
        .sort((a,b) => a.sequence - b.sequence);
      for (const run of history) sessions[run.laneIndex!] = run.sessionId!;
      if (sessions.some((session,i) => session !== rule.sessions[i])) {
        const recovered = { ...rule, sessions };
        await this.saveRule(recovered); this.rules.set(rule.id, recovered);
      }
    }
    this.initialized = true;
    await this.tick();
    if (this.options.autoStart !== false) {
      this.timer = setInterval(() => { void this.tick().catch(error => {
        console.error('Scheduled task polling failed; inspect schedule storage.', error);
      }); }, 1000);
      this.timer.unref();
    }
  }
  list() {
    this.ensureOpen();
    return [...this.rules.values()].sort((a,b) => a.createdAt.localeCompare(b.createdAt)).map(rule => ({
      ...structuredClone(rule),
      running: this.runs(rule.id).filter(run => active(run)).length,
      waiting: this.runs(rule.id).filter(run => run.state === 'waiting').length,
      laneLimit: lanes,
    }));
  }
  get(id: string) {
    this.ensureOpen();
    const rule = this.rules.get(scheduleId.parse(id));
    if (!rule) throw new AppError('NOT_FOUND', 'Scheduled rule not found.', 404);
    return structuredClone(rule);
  }
  runs(id: string) {
    this.get(id);
    return [...this.records.values()].filter(run => run.scheduleId === id)
      .sort((a,b) => a.sequence - b.sequence)
      .map(run => ({ ...structuredClone(run), taskStatus: run.state === 'submitted' ? this.tasks.getTask(run.taskId!).status : run.taskStatus }));
  }
  async create(raw: ScheduleInput) {
    this.ensureOpen();
    const input = inputSchema.parse(raw);
    input.systemPrompt = input.systemPrompt?.trim() || undefined;
    return this.exclusive(async () => {
      this.ensureOpen();
      const now = new Date();
      const rule: ScheduledRule = { ...input, version: 1, id: `sched_${randomUUID()}`, createdAt: now.toISOString(),
        updatedAt: now.toISOString(), nextRunAt: new Date(now.getTime() + input.intervalMinutes * interval).toISOString(),
        sessions: Array(lanes).fill(null) };
      await this.saveRule(rule); this.rules.set(rule.id, rule);
      return structuredClone(rule);
    });
  }
  async setEnabled(id: string, enabled: boolean) {
    this.ensureOpen();
    return this.exclusive(async () => {
      this.ensureOpen();
      const previous = this.get(id);
      const updated = { ...previous, enabled, updatedAt: new Date().toISOString(),
        nextRunAt: enabled && !previous.enabled ? new Date(Date.now() + previous.intervalMinutes * interval).toISOString() : previous.nextRunAt };
      await this.saveRule(updated); this.rules.set(id, updated);
      return structuredClone(updated);
    });
  }
  async delete(id: string) {
    this.ensureOpen();
    return this.exclusive(async () => {
      this.ensureOpen();
      const rule = this.get(id);
      const runs = [...this.records.values()].filter(run => run.scheduleId === rule.id);
      if (runs.some(active)) {
        throw new AppError('SCHEDULE_ACTIVE', 'Wait for submitted runs to finish before deleting this schedule.', 409);
      }
      for (const run of runs) {
        await this.remove(join(this.root, 'runs', `${run.id}.json`));
        this.records.delete(run.id);
      }
      await this.remove(join(this.root, 'definitions', `${rule.id}.json`));
      this.rules.delete(rule.id);
    });
  }
  async deleteSession(id: string) {
    this.ensureOpen();
    return this.exclusive(async () => {
      this.ensureOpen();
      if ([...this.rules.values()].some(rule => rule.sessions.includes(id))
        || [...this.records.values()].some(run => run.sessionId === id)) {
        throw new AppError('SESSION_SCHEDULED', 'This session is linked to a scheduled rule. Delete that rule first.', 409);
      }
      return this.tasks.deleteSession(id);
    });
  }
  private async addRun(rule: ScheduledRule, id: string, scheduledAt: string) {
    const existing = this.records.get(id);
    if (existing) return existing;
    if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new AppError('SEQUENCE_EXHAUSTED', 'Scheduled run sequence exhausted.', 503);
    const run: ScheduledRun = { version: 1, id, scheduleId: rule.id, scheduledAt, createdAt: new Date().toISOString(), sequence: ++this.sequence,
      question: rule.question, systemPrompt: rule.systemPrompt, sandboxMode: rule.sandboxMode, state: 'waiting' };
    await this.saveRun(run); this.records.set(id, run);
    return run;
  }
  async runNow(id: string) {
    this.ensureOpen();
    return this.exclusive(async () => {
      this.ensureOpen();
      const rule = this.get(id);
      if (this.runs(id).filter(run => run.state === 'waiting').length >= maxWaitingPerRule) {
        throw new AppError('SCHEDULE_BACKLOG_FULL', 'Scheduled rule waiting capacity is full.', 429);
      }
      const run = await this.addRun(rule, `run_${randomUUID()}`, new Date().toISOString());
      await this.reconcile();
      return structuredClone(this.records.get(run.id)!);
    });
  }
  async tick(time = Date.now()) {
    this.ensureOpen();
    return this.exclusive(async () => {
      this.ensureOpen();
      for (const rule of this.rules.values()) {
        if (!rule.enabled || Date.parse(rule.nextRunAt) > time) continue;
        const frequency = rule.intervalMinutes * interval;
        const due = Date.parse(rule.nextRunAt) + Math.floor((time - Date.parse(rule.nextRunAt)) / frequency) * frequency;
        const at = new Date(due).toISOString();
        const waiting = [...this.records.values()].filter(run => run.scheduleId === rule.id && run.state === 'waiting').length;
        if (waiting >= maxWaitingPerRule) {
          if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new AppError('SEQUENCE_EXHAUSTED', 'Scheduled run sequence exhausted.', 503);
          const failed: ScheduledRun = { version: 1, id: dueRunId(rule.id, at), scheduleId: rule.id, scheduledAt: at,
            createdAt: new Date().toISOString(), sequence: ++this.sequence, question: rule.question,
            systemPrompt: rule.systemPrompt, sandboxMode: rule.sandboxMode,
            state: 'failed', error: 'SCHEDULE_BACKLOG_FULL', completedAt: new Date().toISOString() };
          if (!this.records.has(failed.id)) { await this.saveRun(failed); this.records.set(failed.id, failed); }
        } else await this.addRun(rule, dueRunId(rule.id, at), at);
        const updated = { ...rule, nextRunAt: new Date(due + frequency).toISOString() };
        await this.saveRule(updated); this.rules.set(rule.id, updated);
      }
      await this.reconcile();
    });
  }
  private async reconcile() {
    for (const run of this.records.values()) {
      if (!active(run)) continue;
      const task = this.tasks.getTask(run.taskId!);
      if (!isTerminal(task.status)) continue;
      const updated: ScheduledRun = { ...run, state: 'finished', taskStatus: task.status, completedAt: task.finishedAt ?? new Date().toISOString() };
      await this.saveRun(updated); this.records.set(run.id, updated);
    }
    for (let rule of this.rules.values()) {
      const runs = [...this.records.values()].filter(run => run.scheduleId === rule.id);
      const used = new Set(runs.filter(active).map(run => run.laneIndex));
      const waiting = runs.filter(run => run.state === 'waiting').sort((a,b) => a.sequence - b.sequence);
      for (const run of waiting) {
        const laneIndex = Array.from({ length: lanes }, (_,i) => i).find(i => !used.has(i));
        if (laneIndex === undefined) break;
        const sessionId = rule.sessions[laneIndex] ?? undefined;
        const request = { question: run.question, systemPrompt: run.systemPrompt, sandboxMode: run.sandboxMode, sessionId,
          idempotencyKey: `schedule:${run.id}` };
        try {
          const task = await this.tasks.submit(request, 'scheduled');
          const updated: ScheduledRun = { ...run, state: 'submitted', laneIndex, taskId: task.taskId, sessionId: task.sessionId };
          await this.saveRun(updated); this.records.set(run.id, updated); used.add(laneIndex);
          if (rule.sessions[laneIndex] !== task.sessionId) {
            const changed = { ...rule, sessions: rule.sessions.map((value,i) => i === laneIndex ? task.sessionId : value) };
            await this.saveRule(changed); this.rules.set(rule.id, changed); rule = changed;
          }
        } catch (error) {
          if (error instanceof AppError && ['QUEUE_FULL', 'ADMISSION_FULL'].includes(error.code)) break;
          if (error instanceof AppError && error.code === 'SESSION_CONFIG_CHANGED' && sessionId) {
            const changed = { ...rule, sessions: rule.sessions.map((value,i) => i === laneIndex ? null : value) };
            await this.saveRule(changed); this.rules.set(rule.id, changed); rule = changed;
            break;
          }
          const failed: ScheduledRun = { ...run, state: 'failed', error: error instanceof Error ? error.message : String(error), completedAt: new Date().toISOString() };
          await this.saveRun(failed); this.records.set(run.id, failed);
        }
      }
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    await this.serial;
  }
}
