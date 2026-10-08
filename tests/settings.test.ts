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
    expect(initial.providers.find(provider => provider.id === 'model_studio')?.models).toContain('glm-5.3');
    await expect(store.update({ revision: 0, settings: { ...initial.settings,
      activeProvider: 'model_studio', defaultModel: 'gpt-6-sol' } }, 'test')).rejects.toMatchObject({ code: 'INVALID_MODEL' });
    const saved = await store.update({ revision: 0, settings: { ...initial.settings,
      activeProvider: 'model_studio', defaultModel: 'qwen3.7-plus' } }, 'test');
    expect(saved.settings).toMatchObject({ activeProvider: 'model_studio', defaultModel: 'qwen3.7-plus' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('replaces a retired persisted model with the provider default and rejects new selections of it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-retired-model-'));
  try {
    const config = await loadConfig(resolve('config/development.yaml'));
    config.dataDir = dir;
    const store = new RuntimeSettingsStore(config);
    const settings = { ...store.snapshot().settings, activeProvider: 'model_studio', defaultModel: 'retired-model' };
    await writeFile(join(dir, 'runtime-settings.json'), JSON.stringify({ version: 1, revision: 2,
      settings, updatedAt: new Date().toISOString(), updatedBy: 'test' }));
    await store.load();
    const snapshot = store.snapshot();
    expect(snapshot.settings.defaultModel).toBe('qwen3.7-max');
    expect(snapshot.providers.find(provider => provider.id === 'model_studio')?.models).not.toContain('retired-model');
    await expect(store.update({ revision: snapshot.revision, settings: { ...snapshot.settings,
      defaultModel: 'retired-model' } }, 'test')).rejects.toMatchObject({ code: 'INVALID_MODEL' });
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

it('rejects unsupported reasoning effort for Qwen flash through the settings API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-flash-settings-'));
  try {
    const config = await loadConfig(resolve('config/development.yaml'));
    config.dataDir = dir;
    const store = new RuntimeSettingsStore(config);
    const initial = store.snapshot();
    await expect(store.update({ revision: 0, settings: { ...initial.settings,
      activeProvider: 'model_studio', defaultModel: 'qwen3.7-flash', defaultReasoningEffort: 'high' } }, 'test'))
      .rejects.toMatchObject({ code: 'INVALID_REASONING_EFFORT' });
    const saved = await store.update({ revision: 0, settings: { ...initial.settings,
      activeProvider: 'model_studio', defaultModel: 'qwen3.7-flash', defaultReasoningEffort: 'medium' } }, 'test');
    expect(saved.settings.defaultReasoningEffort).toBe('medium');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('normalizes an existing Qwen flash high setting on startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-flash-migration-'));
  try {
    const config = await loadConfig(resolve('config/development.yaml'));
    config.dataDir = dir;
    const store = new RuntimeSettingsStore(config);
    const settings = { ...store.snapshot().settings, activeProvider: 'model_studio',
      defaultModel: 'qwen3.7-flash', defaultReasoningEffort: 'high' };
    await writeFile(join(dir, 'runtime-settings.json'), JSON.stringify({ version: 1, revision: 2,
      settings, updatedAt: new Date().toISOString(), updatedBy: 'test' }));
    await store.load();
    expect(store.snapshot().settings.defaultReasoningEffort).toBe('medium');
    expect(config.defaultReasoningEffort).toBe('medium');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('uses medium for Qwen flash when it is selected in the base configuration', async () => {
  const config = await loadConfig(resolve('config/development.yaml'));
  config.activeProvider = 'model_studio';
  config.defaultModel = 'qwen3.7-flash';
  config.defaultReasoningEffort = 'high';
  const store = new RuntimeSettingsStore(config);
  expect(store.snapshot().settings.defaultReasoningEffort).toBe('medium');
  expect(config.defaultReasoningEffort).toBe('medium');
});

it('accepts only documented reasoning efforts for GLM and normalizes a persisted unsupported value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-glm-settings-'));
  try {
    const config = await loadConfig(resolve('config/development.yaml'));
    config.dataDir = dir;
    const store = new RuntimeSettingsStore(config);
    const initial = store.snapshot();
    await expect(store.update({ revision: 0, settings: { ...initial.settings,
      activeProvider: 'model_studio', defaultModel: 'glm-5.3', defaultReasoningEffort: 'medium' } }, 'test'))
      .rejects.toMatchObject({ code: 'INVALID_REASONING_EFFORT' });
    const saved = await store.update({ revision: 0, settings: { ...initial.settings,
      activeProvider: 'model_studio', defaultModel: 'glm-5.3', defaultReasoningEffort: 'max' } }, 'test');
    expect(saved.settings).toMatchObject({ defaultModel: 'glm-5.3', defaultReasoningEffort: 'max' });
    const persisted = { ...saved.settings, defaultReasoningEffort: 'medium' };
    await writeFile(join(dir, 'runtime-settings.json'), JSON.stringify({ version: 1, revision: 2,
      settings: persisted, updatedAt: new Date().toISOString(), updatedBy: 'test' }));
    const reloaded = new RuntimeSettingsStore(config);
    await reloaded.load();
    expect(reloaded.snapshot().settings.defaultReasoningEffort).toBe('high');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
