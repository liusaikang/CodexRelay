import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicJson } from './storage.js';
import { AppError, modelReasoningEffortSchema, type ModelProvider, type RuntimeConfig } from './types.js';

export const runtimeSettingsSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(64),
  maxQueued: z.number().int().min(0).max(10000),
  timeoutSeconds: z.number().int().min(1).max(86400),
  queueTimeoutSeconds: z.number().int().min(1).max(604800),
  activeProvider: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
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

const isQwenFlash = (providerId: string, model: string | null) => providerId === 'model_studio' && model === 'qwen3.7-flash';
const isGlm53 = (providerId: string, model: string | null) => providerId === 'model_studio' && model === 'glm-5.3';
const flashEffortSupported = (effort: string) => effort === 'low' || effort === 'medium';
const glm53EffortSupported = (effort: string) => effort === 'low' || effort === 'high' || effort === 'max';
const normalizeEffort = (providerId: string, model: string | null, effort: RuntimeSettings['defaultReasoningEffort']) =>
  isQwenFlash(providerId, model) && (!effort || !flashEffortSupported(effort)) ? 'medium'
    : isGlm53(providerId, model) && (!effort || !glm53EffortSupported(effort)) ? 'high'
      : effort ?? 'high';

const fromConfig = (config: RuntimeConfig): RuntimeSettings => {
  const activeProvider = config.activeProvider ?? 'openai';
  const defaultModel = config.defaultModel ?? config.modelProviders?.find(provider => provider.id === activeProvider)?.defaultModel ?? null;
  return {
    maxConcurrent: config.maxConcurrent, maxQueued: config.maxQueued,
    timeoutSeconds: config.timeoutSeconds, queueTimeoutSeconds: config.queueTimeoutSeconds ?? 1800,
    activeProvider, defaultModel,
    defaultReasoningEffort: normalizeEffort(activeProvider, defaultModel, config.defaultReasoningEffort ?? null),
    invocationLog: { enabled: config.invocationLog?.enabled ?? false, retentionDays: config.invocationLog?.retentionDays ?? 30 },
  };
};

export class RuntimeSettingsStore {
  private readonly file: string;
  private readonly defaults: RuntimeSettings;
  private revision = 0;
  private updatedAt: string | null = null;
  private updatedBy: string | null = null;

  constructor(private readonly config: RuntimeConfig) {
    this.file = join(config.dataDir, 'runtime-settings.json');
    this.defaults = fromConfig(config);
    this.config.defaultReasoningEffort = this.defaults.defaultReasoningEffort ?? 'high';
  }

  private apply(settings: RuntimeSettings) {
    this.config.maxConcurrent = settings.maxConcurrent;
    this.config.maxQueued = settings.maxQueued;
    this.config.timeoutSeconds = settings.timeoutSeconds;
    this.config.queueTimeoutSeconds = settings.queueTimeoutSeconds;
    this.config.activeProvider = settings.activeProvider;
    this.config.defaultModel = settings.defaultModel ?? undefined;
    this.config.defaultReasoningEffort = settings.defaultReasoningEffort ?? 'high';
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
    const raw = JSON.parse(content);
    const saved = savedSchema.parse({ ...raw, settings: {
      ...raw.settings, activeProvider: raw.settings?.activeProvider ?? this.config.activeProvider ?? 'openai',
    } });
    if (saved.settings.invocationLog.enabled && !this.config.invocationLog) throw new Error('Invocation log directory is not configured');
    if (!(this.config.modelProviders ?? [{ id: 'openai' }]).some(provider => provider.id === saved.settings.activeProvider)) {
      throw new Error(`Configured provider ${saved.settings.activeProvider} is no longer available`);
    }
    const provider = this.config.modelProviders?.find(item => item.id === saved.settings.activeProvider);
    const defaultModel = saved.settings.defaultModel && (!provider?.models || provider.models.includes(saved.settings.defaultModel))
      ? saved.settings.defaultModel : provider?.defaultModel ?? null;
    this.apply({ ...saved.settings, defaultModel,
      defaultReasoningEffort: normalizeEffort(saved.settings.activeProvider, defaultModel,
        saved.settings.defaultReasoningEffort ?? this.defaults.defaultReasoningEffort) });
    this.revision = saved.revision;
    this.updatedAt = saved.updatedAt;
    this.updatedBy = saved.updatedBy;
  }

  snapshot() {
    return { revision: this.revision, settings: structuredClone(fromConfig(this.config)),
      defaults: structuredClone(this.defaults), updatedAt: this.updatedAt, updatedBy: this.updatedBy,
      providers: (this.config.modelProviders ?? [{ id: 'openai', label: 'OpenAI / Codex' }]).map(provider => ({
        id: provider.id, label: provider.label, defaultModel: provider.defaultModel ?? null,
        models: [...new Set(provider.models ?? [])],
        baseUrl: provider.baseUrl ?? null,
        credentialConfigured: provider.id === 'openai'
          ? !!process.env.CODEX_API_KEY || existsSync(join(this.config.codexHome, 'auth.json'))
          : !!(provider.envKey && process.env[provider.envKey]),
      })) };
  }

  async update(raw: unknown, actor: string) {
    const input = settingsUpdateSchema.parse(raw);
    if (input.revision !== this.revision) throw new AppError('SETTINGS_CONFLICT', 'Settings changed. Reload before saving.', 409);
    const providers: ModelProvider[] = this.config.modelProviders ?? [{ id: 'openai', label: 'OpenAI / Codex' }];
    const provider = providers.find(item => item.id === input.settings.activeProvider);
    if (!provider) {
      throw new AppError('INVALID_PROVIDER', 'Selected model provider is not configured on this server.', 400);
    }
    if (provider.models && input.settings.defaultModel && !provider.models.includes(input.settings.defaultModel)) {
      throw new AppError('INVALID_MODEL', 'Selected model is not configured for this provider.', 400);
    }
    if (input.settings.invocationLog.enabled && !this.config.invocationLog) throw new AppError('INVALID_SETTINGS', 'Invocation log directory is not configured.', 400);
    const defaultModel = input.settings.defaultModel ?? provider.defaultModel ?? null;
    const effort = input.settings.defaultReasoningEffort ?? (isQwenFlash(input.settings.activeProvider, defaultModel)
      ? 'medium' : isGlm53(input.settings.activeProvider, defaultModel) ? 'high' : this.defaults.defaultReasoningEffort ?? 'high');
    if (isQwenFlash(input.settings.activeProvider, defaultModel) && !flashEffortSupported(effort)) {
      throw new AppError('INVALID_REASONING_EFFORT', 'qwen3.7-flash supports only low or medium reasoning effort.', 400);
    }
    if (isGlm53(input.settings.activeProvider, defaultModel) && !glm53EffortSupported(effort)) {
      throw new AppError('INVALID_REASONING_EFFORT', 'glm-5.3 supports only low, high or max reasoning effort.', 400);
    }
    const settings = { ...input.settings, defaultModel, defaultReasoningEffort: effort };
    const saved = { version: 1 as const, revision: this.revision + 1, settings,
      updatedAt: new Date().toISOString(), updatedBy: actor.slice(0, 100) };
    await atomicJson(this.file, saved);
    this.apply(saved.settings);
    this.revision = saved.revision;
    this.updatedAt = saved.updatedAt;
    this.updatedBy = saved.updatedBy;
    return this.snapshot();
  }
}
