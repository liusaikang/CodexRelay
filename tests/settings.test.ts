import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { RuntimeSettingsStore } from '../src/settings.js';

it('exposes provider-specific model choices and rejects a model from another provider', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-model-settings-'));
  try {
    const config = await loadConfig(resolve('config/development.yaml'));
    config.dataDir = dir;
    const store = new RuntimeSettingsStore(config);
    const initial = store.snapshot();
    expect(initial.providers.find(provider => provider.id === 'openai')?.models).toContain('gpt-6-sol');
    expect(initial.settings.defaultModel).toBe('gpt-6-sol');
    expect(initial.settings.defaultReasoningEffort).toBe('high');
    expect(initial.providers.find(provider => provider.id === 'model_studio')?.models).toContain('qwen3.7-max');
    await expect(store.update({ revision: 0, settings: { ...initial.settings,
      activeProvider: 'model_studio', defaultModel: 'gpt-6-sol' } }, 'test')).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    const saved = await store.update({ revision: 0, settings: { ...initial.settings,
      activeProvider: 'model_studio', defaultModel: 'qwen3.7-plus' } }, 'test');
    expect(saved.settings).toMatchObject({ activeProvider: 'model_studio', defaultModel: 'qwen3.7-plus' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('resolves a persisted empty model to the active provider model on startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-model-migration-'));
  try {
    const config = await loadConfig(resolve('config/development.yaml'));
    config.dataDir = dir;
    const store = new RuntimeSettingsStore(config);
    const settings = { ...store.snapshot().settings, defaultModel: null, defaultReasoningEffort: null };
    await writeFile(join(dir, 'runtime-settings.json'), JSON.stringify({ version: 1, revision: 2,
      settings, updatedAt: new Date().toISOString(), updatedBy: 'test' }));
    await store.load();
    expect(store.snapshot().settings.defaultModel).toBe('gpt-6-sol');
    expect(store.snapshot().settings.defaultReasoningEffort).toBe('high');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('normalizes an empty API reasoning effort to high', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-effort-settings-'));
  try {
    const config = await loadConfig(resolve('config/development.yaml'));
    config.dataDir = dir;
    const store = new RuntimeSettingsStore(config);
    const initial = store.snapshot();
    const saved = await store.update({ revision: 0, settings: { ...initial.settings,
      defaultReasoningEffort: null } }, 'test');
    expect(saved.settings.defaultReasoningEffort).toBe('high');
    expect(config.defaultReasoningEffort).toBe('high');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
