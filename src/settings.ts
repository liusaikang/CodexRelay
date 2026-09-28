import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from './storage.js';
import { AppError, modelReasoningEffortSchema, type RuntimeConfig } from './types.js';

export const runtimeSettingsSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(64),
  maxQueued: z.number().int().min(0).max(10000),
  timeoutSeconds: z.number().int().min(1).max(86400),
  queueTimeoutSeconds: z.number().int().min(1).max(604800),
  defaultModel: z.string().trim().min(1).max(120).nullable(),
  defaultReasoningEffort: modelReasoningEffortSchema.nullable(),
  invocationLog: z.object({ enabled: z.boolean(), retentionDays: z.number().int().min(1).max(3650) }).strict(),
}).strict();
export const settingsUpdateSchema = z.object({
  revision: z.number().int().nonnegative(), settings: runtimeSettingsSchema,
}).strict();
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
const savedSchema = settingsUpdateSchema.extend({
  version: z.literal(1), updatedAt: z.iso.datetime({ offset: true }), updatedBy: z.string().min(1).max(100),
}).strict();

const fromConfig = (config: RuntimeConfig): RuntimeSettings => ({
  maxConcurrent: config.maxConcurrent, maxQueued: config.maxQueued,
  timeoutSeconds: config.timeoutSeconds, queueTimeoutSeconds: config.queueTimeoutSeconds ?? 1800,
  defaultModel: config.defaultModel ?? null, defaultReasoningEffort: config.defaultReasoningEffort ?? null,
  invocationLog: { enabled: config.invocationLog?.enabled ?? false, retentionDays: config.invocationLog?.retentionDays ?? 30 },
});

export class RuntimeSettingsStore {
  private readonly file: string;
  private readonly defaults: RuntimeSettings;
  private revision = 0;
  private updatedAt: string | null = null;
  private updatedBy: string | null = null;

  constructor(private readonly config: RuntimeConfig) {
    this.file = join(config.dataDir, 'runtime-settings.json');
    this.defaults = fromConfig(config);
  }

  private apply(settings: RuntimeSettings) {
    this.config.maxConcurrent = settings.maxConcurrent;
    this.config.maxQueued = settings.maxQueued;
    this.config.timeoutSeconds = settings.timeoutSeconds;
    this.config.queueTimeoutSeconds = settings.queueTimeoutSeconds;
    this.config.defaultModel = settings.defaultModel ?? undefined;
    this.config.defaultReasoningEffort = settings.defaultReasoningEffort ?? undefined;
    if (this.config.invocationLog) {
      this.config.invocationLog.enabled = settings.invocationLog.enabled;
      this.config.invocationLog.retentionDays = settings.invocationLog.retentionDays;
    }
  }

  async load() {
    let content: string;
    try { content = await readFile(this.file, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const saved = savedSchema.parse(JSON.parse(content));
    if (saved.settings.invocationLog.enabled && !this.config.invocationLog) throw new Error('Invocation log directory is not configured');
    this.apply(saved.settings);
    this.revision = saved.revision;
    this.updatedAt = saved.updatedAt;
    this.updatedBy = saved.updatedBy;
  }

  snapshot() {
    return { revision: this.revision, settings: structuredClone(fromConfig(this.config)),
      defaults: structuredClone(this.defaults), updatedAt: this.updatedAt, updatedBy: this.updatedBy };
  }

  async update(raw: unknown, actor: string) {
    const input = settingsUpdateSchema.parse(raw);
    if (input.revision !== this.revision) throw new AppError('SETTINGS_CONFLICT', 'Settings changed. Reload before saving.', 409);
    if (input.settings.invocationLog.enabled && !this.config.invocationLog) throw new AppError('INVALID_SETTINGS', 'Invocation log directory is not configured.', 400);
    const saved = { version: 1 as const, revision: this.revision + 1, settings: input.settings,
      updatedAt: new Date().toISOString(), updatedBy: actor.slice(0, 100) };
    await atomicJson(this.file, saved);
    this.apply(saved.settings);
    this.revision = saved.revision;
    this.updatedAt = saved.updatedAt;
    this.updatedBy = saved.updatedBy;
    return this.snapshot();
  }
}
