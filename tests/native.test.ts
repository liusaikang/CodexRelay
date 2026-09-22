import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { loadConfig } from '../src/config.js';
import { TaskService } from '../src/service.js';
import { FileStore } from '../src/storage.js';
import type { Execution, Runner } from '../src/types.js';

it('uses a native workspace without reading or expanding skill bodies into gateway configuration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'native-skills-'));
  let service: TaskService | undefined;
  try {
    const skillDir = join(dir, '.agents', 'skills', 'sample');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: sample\ndescription: Native skill example\n---\nPRIVATE_SKILL_BODY_MARKER');
    await writeFile(join(dir, 'AGENTS.md'), 'NATIVE_PROJECT_RULE_MARKER');
    const file = join(dir, 'service.yaml');
    await writeFile(file, stringify({ tasks: { maxConcurrent: 2, maxQueued: 4 }, dataDir: './state', codex: { home: './home', defaultWorkingDirectory: '.' } }));
    const config = await loadConfig(file);
    expect(JSON.stringify(config)).not.toContain('PRIVATE_SKILL_BODY_MARKER');
    expect(JSON.stringify(config)).not.toContain('NATIVE_PROJECT_RULE_MARKER');
    let execution: Execution | undefined;
    const runner: Runner = { async run(value) { execution = value; return { markdown: 'Done', usage: null }; } };
    service = new TaskService(config, new FileStore(config.dataDir), runner);
    await service.init();
    const context = { subject: { account: 'demo-user', tenantId: 'tenant-demo-001' }, request: { module: 'orders' } };
    const task = await service.submit({ question: '  Please use $sample exactly as written.\n', context } as any);
    for (let i = 0; i < 50 && !execution; i++) await new Promise(r => setTimeout(r, 10));
    expect(execution?.question).toBe('  Please use $sample exactly as written.\n');
    expect(execution?.context).toEqual(context);
    expect(execution?.directory).toBe(config.defaultWorkingDirectory);
    expect(execution).not.toHaveProperty('instructions');
    expect(execution).not.toHaveProperty('mcpServers');
    expect(task.version).toBe(2);
  } finally { await service?.close(); await rm(dir, { recursive: true, force: true }); }
});
