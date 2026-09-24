import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, access, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stringify } from 'yaml';
import { ProcessRunner } from '../src/runner/process.js';

it('validates deployment configuration without starting workers or creating state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-check-'));
  try {
    const file = join(dir, 'config.yaml');
    await writeFile(file, stringify({
      dataDir: join(dir, 'state'), codex: { home: join(dir, 'home'), defaultWorkingDirectory: dir },
      tasks: { maxConcurrent: 4, maxQueued: 10 },
    }));
    const token = 'check-only-test-token-with-24-characters';
    const { stdout } = await promisify(execFile)(process.execPath, [resolve('dist/main.js'), '--config', file, '--check'], { env: { ...process.env, CODEX_MCP_TOKEN: token } });
    expect(JSON.parse(stdout)).toMatchObject({ valid: true, runner: 'codex', maxConcurrent: 4, localConsole: false });
    expect(stdout).not.toContain(token);
    await expect(access(join(dir, 'state'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(dir, 'home'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('runs the compiled stdio entry point through the official MCP transport', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-stdio-'));
  const file = join(dir, 'config.yaml');
  await writeFile(file, stringify({
    dataDir: join(dir, 'state'), codex: { home: join(dir, 'home'), defaultWorkingDirectory: dir },
    tasks: { maxConcurrent: 1, maxQueued: 2 }, runner: 'demo',
    invocationLog: { enabled: true, directory: join(dir, 'logs') },
  }));
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/main.js'), '--transport', 'stdio', '--config', file], stderr: 'pipe' });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(6);
    const result = await client.callTool({ name: 'codex_submit_task', arguments: { question: 'hello' } });
    const task = (result.structuredContent as any).data;
    await new Promise(r => setTimeout(r, 400));
    const finished = await client.callTool({ name: 'codex_get_task', arguments: { taskId: task.taskId } });
    expect((finished.structuredContent as any).data.status).toBe('succeeded');
    const stored = JSON.parse(await readFile(join(dir, 'logs', task.createdAt.slice(0, 10), `${task.taskId}.json`), 'utf8'));
    expect(stored).toMatchObject({ transport: 'stdio', status: 'succeeded', question: 'hello' });
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

it('surfaces a genuine SDK CLI spawn failure through the compiled worker without hanging', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-sdk-fail-'));
  try {
    const runner = new ProcessRunner(resolve('dist/runner/worker.js'));
    const result = runner.run({ taskId: 'fixture', question: 'hello', directory: dir, codexHome: dir, codexPath: join(dir, 'nonexistent-codex'), env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', CODEX_HOME: dir } }, AbortSignal.timeout(5000), async () => {});
    await expect(result).rejects.toMatchObject({ code: 'CODEX_EXEC_FAILED' });
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 10000);
