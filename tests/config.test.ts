import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../src/config.js';

it('validates sandbox modes and expands their environment configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-sandbox-config-'));
  const previous = process.env.RELAY_TEST_SANDBOX;
  try {
    const file = join(dir, 'config.yaml');
    const save = async (sandboxMode?: unknown) => writeFile(file, stringify({ codex: { defaultWorkingDirectory: '.', sandboxMode } }));
    await save();
    expect((await loadConfig(file)).sandboxMode).toBe('danger-full-access');
    for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
      await save(mode);
      expect((await loadConfig(file)).sandboxMode).toBe(mode);
      process.env.RELAY_TEST_SANDBOX = mode;
      await save('${RELAY_TEST_SANDBOX}');
      expect((await loadConfig(file)).sandboxMode).toBe(mode);
    }
    for (const mode of ['readonly', '', 'full', false]) {
      await save(mode);
      await expect(loadConfig(file)).rejects.toThrow();
    }
    process.env.RELAY_TEST_SANDBOX = 'invalid';
    await save('${RELAY_TEST_SANDBOX}');
    await expect(loadConfig(file)).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.RELAY_TEST_SANDBOX;
    else process.env.RELAY_TEST_SANDBOX = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

it('loads the development environment with its existing history and invocation log', async () => {
  const config = await loadConfig(resolve('config/development.yaml'));
  expect(config.defaultWorkingDirectory).toBe(await realpath('examples/workspace'));
  expect(config).not.toHaveProperty('capabilities');
  expect(config).not.toHaveProperty('projects');
  expect(config.dataDir).toBe(resolve('data/native-logs-preview'));
  expect(config.codexHome).toBe(resolve('data/codex-home'));
  expect(config.invocationLog).toMatchObject({ enabled: true, directory: resolve('data/invocation-logs'), retentionDays: 30 });
  expect(config.queueTimeoutSeconds).toBe(1800);
  expect(config.consoleAuth).toEqual({ username: 'admin', password: 'admin' });
  expect(config.maxConcurrent).toBe(parse(await readFile('config/development.yaml', 'utf8')).tasks.maxConcurrent);
  expect(config.activeProvider).toBe('openai');
  expect(config.modelProviders?.map(provider => provider.id)).toEqual(['openai', 'model_studio']);
  expect(config.modelProviders?.[1]).toMatchObject({ envKey: 'DASHSCOPE_API_KEY', defaultModel: 'qwen3.7-max' });
  expect(config.modelProviders?.[0]?.models).toContain('gpt-6-sol');
  expect(config.modelProviders?.[0]?.defaultModel).toBe('gpt-6-sol');
  expect(config.defaultReasoningEffort).toBe('high');
  expect(config.modelProviders?.[1]?.models).toContain('qwen3.7-plus');
});

it('validates configured model providers and never accepts a credential value in place of an environment variable name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-providers-'));
  try {
    const file = join(dir, 'config.yaml');
    const base = { codex: { defaultWorkingDirectory: '.', activeProvider: 'openai', envAllowlist: ['DASHSCOPE_API_KEY'],
      providers: [{ id: 'openai', label: 'OpenAI' }, { id: 'model_studio', label: 'Model Studio',
        baseUrl: 'https://dashscope.example.test/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY', defaultModel: 'qwen-test' }] } };
    await writeFile(file, stringify(base));
    expect((await loadConfig(file)).modelProviders?.[1]).toMatchObject({ id: 'model_studio', envKey: 'DASHSCOPE_API_KEY' });
    for (const override of [
      { activeProvider: 'missing' },
      { providers: [base.codex.providers[0], { ...base.codex.providers[1], baseUrl: 'http://untrusted.example.test/v1' }] },
      { providers: [base.codex.providers[0], { ...base.codex.providers[1], envKey: 'secret-value!' }] },
      { providers: [{ ...base.codex.providers[0], models: ['same', 'same'] }, base.codex.providers[1]] },
    ]) {
      await writeFile(file, stringify({ ...base, codex: { ...base.codex, ...override } }));
      await expect(loadConfig(file)).rejects.toThrow();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('requires separate production paths and credentials', async () => {
  const names = ['CODEX_DATA_DIR', 'CODEX_INVOCATION_LOG_DIR', 'CODEX_HOME', 'CODEX_WORKSPACE', 'CODEX_CONSOLE_USERNAME', 'CODEX_CONSOLE_PASSWORD', 'CODEX_BIND_HOST', 'CODEX_PUBLIC_HOST', 'CODEX_PUBLIC_ORIGIN'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const dir = await mkdtemp(join(tmpdir(), 'relay-production-config-'));
  try {
    for (const name of names) delete process.env[name];
    await expect(loadConfig(resolve('config/production.yaml'))).rejects.toThrow();
    Object.assign(process.env, {
      CODEX_DATA_DIR: join(dir, 'state'), CODEX_INVOCATION_LOG_DIR: join(dir, 'logs'), CODEX_HOME: join(dir, 'home'), CODEX_WORKSPACE: dir,
      CODEX_CONSOLE_USERNAME: 'operator', CODEX_CONSOLE_PASSWORD: 'test-only-password', CODEX_BIND_HOST: '127.0.0.1',
      CODEX_PUBLIC_HOST: 'relay.example.test', CODEX_PUBLIC_ORIGIN: 'https://relay.example.test',
    });
    expect(await loadConfig(resolve('config/production.yaml'))).toMatchObject({
      dataDir: join(dir, 'state'), invocationLog: { enabled: true, directory: join(dir, 'logs') },
      codexHome: join(dir, 'home'), defaultWorkingDirectory: await realpath(dir),
      host: '127.0.0.1', consoleAuth: { username: 'operator', password: 'test-only-password' },
      allowedHosts: expect.arrayContaining(['relay.example.test']), allowedOrigins: ['https://relay.example.test'],
    });
  } finally {
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name]; else process.env[name] = original[name];
    }
    await rm(dir, { recursive: true, force: true });
  }
});

it('validates invocation retention and keeps its directory separate from runtime state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-log-config-'));
  try {
    const file = join(dir, 'config.yaml');
    const base = { dataDir: './state', codex: { home: './home', defaultWorkingDirectory: '.' } };
    await writeFile(file, stringify({ ...base, invocationLog: { enabled: true, directory: './logs', retentionDays: 7 } }));
    expect((await loadConfig(file)).invocationLog).toEqual({ enabled: true, directory: join(dir, 'logs'), retentionDays: 7 });
    for (const invocationLog of [{ retentionDays: 0 }, { enabled: 'true' }, { directory: './state/tasks' }, { directory: './home' }, { directory: '.' }]) {
      await writeFile(file, stringify({ ...base, invocationLog: { enabled: true, ...invocationLog } }));
      await expect(loadConfig(file)).rejects.toThrow();
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('checks real storage locations through linked parents and dot-prefixed children', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-log-paths-'));
  try {
    const file = join(dir, 'config.yaml');
    const state = join(dir, 'state');
    await mkdir(state);
    await symlink(state, join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    const base = { dataDir: './state', codex: { home: './home', defaultWorkingDirectory: '.' } };
    for (const directory of ['./alias/logs', './state/..logs']) {
      await writeFile(file, stringify({ ...base, invocationLog: { enabled: true, directory } }));
      await expect(loadConfig(file)).rejects.toThrow('must be separate');
    }
    await writeFile(file, stringify({ ...base, invocationLog: { enabled: true, directory: './..logs' } }));
    await expect(loadConfig(file)).resolves.toMatchObject({ invocationLog: { enabled: true } });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('expands environment variables in runtime paths without hardcoding local secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-config-env-'));
  const previous = process.env.CODEX_TEST_DIR;
  try {
    process.env.CODEX_TEST_DIR = dir;
    const file = join(dir, 'config.yaml');
    await writeFile(file, stringify({
      dataDir: './data', codex: { home: '${CODEX_TEST_DIR}/codex-home', defaultWorkingDirectory: '${CODEX_TEST_DIR}' },
    }));
    const config = await loadConfig(file);
    expect(config.codexHome).toBe(join(dir, 'codex-home'));
    expect(config.defaultWorkingDirectory).toBe(await realpath(dir));
    expect(config).toMatchObject({ maxConcurrent: 10, maxQueued: 100, timeoutSeconds: 600 });
  } finally {
    if (previous === undefined) delete process.env.CODEX_TEST_DIR;
    else process.env.CODEX_TEST_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

it('rejects legacy capability configuration and unsupported policy overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-config-'));
  try {
    const file = join(dir, 'config.yaml');
    await writeFile(file, stringify({ capabilities: {} }));
    await expect(loadConfig(file)).rejects.toThrow('Legacy capability');
    await writeFile(file, stringify({ codex: { defaultWorkingDirectory: '.', sandbox: 'danger-full-access' } }));
    await expect(loadConfig(file)).rejects.toThrow();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('requires explicit loopback-only configuration for automatic console authentication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-console-config-'));
  try {
    const file = join(dir, 'config.yaml');
    const config = { codex: { defaultWorkingDirectory: '.' } };
    await writeFile(file, stringify(config));
    expect(await loadConfig(file)).toMatchObject({ localConsole: false });
    await writeFile(file, stringify({ ...config, server: { host: '0.0.0.0', localConsole: true } }));
    await expect(loadConfig(file)).rejects.toThrow('localConsole');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
