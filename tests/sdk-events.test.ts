import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SdkEventLog, pruneSdkEventLogs } from '../src/runner/sdk-events.js';

it('caps one task journal and leaves a truncation marker', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sdk-events-limit-'));
  const taskId = 'task_22222222-2222-4222-8222-222222222222';
  try {
    const journal = await SdkEventLog.open(home, taskId, 1024);
    await journal.append({ source: 'sdk', event: { type: 'turn.started' } });
    await journal.append({ source: 'sdk', event: { type: 'item.completed', item: { text: 'x'.repeat(2000) } } });
    await journal.append({ source: 'sdk', event: { type: 'turn.completed' } });
    await journal.close();
    const file = join(home, 'sdk-events', `${taskId}.jsonl`);
    expect((await stat(file)).size).toBeLessThanOrEqual(1024);
    const rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.event.type)).toEqual(['turn.started', 'diagnostic.truncated']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('prunes only expired task journals', async () => {
  const home = await mkdtemp(join(tmpdir(), 'sdk-events-prune-'));
  const oldId = 'task_33333333-3333-4333-8333-333333333333';
  const newId = 'task_44444444-4444-4444-8444-444444444444';
  try {
    for (const id of [oldId, newId]) {
      const journal = await SdkEventLog.open(home, id, 1024);
      await journal.close();
    }
    const oldFile = join(home, 'sdk-events', `${oldId}.jsonl`);
    const unrelated = join(home, 'sdk-events', 'other.jsonl');
    await writeFile(unrelated, 'keep');
    const now = Date.now();
    await utimes(oldFile, new Date(now - 3 * 86_400_000), new Date(now - 3 * 86_400_000));
    await utimes(unrelated, new Date(now - 3 * 86_400_000), new Date(now - 3 * 86_400_000));
    await pruneSdkEventLogs(home, 2, now);
    await expect(stat(oldFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await stat(join(home, 'sdk-events', `${newId}.jsonl`))).isFile()).toBe(true);
    expect((await readFile(unrelated, 'utf8'))).toBe('keep');
  } finally { await rm(home, { recursive: true, force: true }); }
});
