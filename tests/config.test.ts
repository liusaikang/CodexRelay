import { expect, it } from 'vitest';
import { mkdtemp, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { loadConfig } from '../src/config.js';

it('loads native Codex defaults without importing skill or prompt contents', async () => {
  const config = await loadConfig(resolve('config/default.yaml'));
  expect(config.defaultWorkingDirectory).toBe(await realpath('examples/workspace'));
  expect(config).not.toHaveProperty('capabilities');
  expect(config).not.toHaveProperty('projects');
  expect(config.maxConcurrent).toBe(parse(await readFile('config/default.yaml', 'utf8')).tasks.maxConcurrent);
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
