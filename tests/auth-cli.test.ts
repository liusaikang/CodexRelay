import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stringify } from 'yaml';

const exec = promisify(execFile);
const cli = resolve('dist/cli/auth.js');

it('checks the configured Codex home instead of an inherited personal home', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-auth-'));
  try {
    const personal = join(directory, 'personal');
    const selected = join(directory, 'service home');
    await mkdir(personal);
    await writeFile(join(personal, 'auth.json'), 'personal-cache-sentinel');
    const config = join(directory, 'config.yaml');
    await writeFile(config, stringify({ dataDir: './tasks', codex: { home: './service home', defaultWorkingDirectory: '.' } }));
    const result = await exec(process.execPath, [cli, 'status', '--config', config], {
      env: { ...process.env, CODEX_HOME: personal, CODEX_API_KEY: '', OPENAI_API_KEY: '' },
      timeout: 15000,
    }).then(value => ({ ...value, code: 0 }), error => error);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(selected);
    expect(result.stderr).toMatch(/not logged in/i);
    expect(result.stdout + result.stderr).not.toContain('personal-cache-sentinel');
    expect(await readFile(join(personal, 'auth.json'), 'utf8')).toBe('personal-cache-sentinel');
    await expect(access(join(selected, 'auth.json'))).rejects.toThrow();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it('rejects unsupported auth actions before loading configuration or invoking Codex', async () => {
  const result = await exec(process.execPath, [cli, 'logout', '--config', 'missing-config.yaml'])
    .then(value => ({ ...value, code: 0 }), error => error);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('Use login or status');
  expect(result.stderr).not.toContain('ENOENT');
});
