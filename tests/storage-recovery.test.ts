import { afterEach, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, inspectStoreLock, recoverStoreLock } from '../src/storage.js';

const folders: string[] = [];
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open) };
});
const originalFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
afterEach(async () => {
  vi.restoreAllMocks(); vi.mocked(open).mockImplementation(originalFs.open);
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function directory() { const dir = await mkdtemp(join(tmpdir(), 'relay-lock-')); folders.push(dir); return dir; }
it('never recovers a live instance or an unverified/foreign lock', async () => {
  const dir = await directory(), store = new FileStore(dir);
  await store.open();
  try {
    expect(await inspectStoreLock(dir)).toMatchObject({ state: 'active' });
    await expect(recoverStoreLock(dir, true)).rejects.toMatchObject({ code: 'LOCK_RECOVERY_REFUSED' });
  } finally { await store.close(); }
  for (const content of ['{', JSON.stringify({ pid: 1, hostname: 'other-host', createdAt: new Date().toISOString() })]) {
    await writeFile(join(dir, 'instance.lock'), content);
    await expect(recoverStoreLock(dir, true)).rejects.toMatchObject({ code: 'LOCK_RECOVERY_REFUSED' });
    expect(await readFile(join(dir, 'instance.lock'), 'utf8')).toBe(content);
  }
});
it('recovers a verified dead owner only after explicit worker cleanup confirmation, preserving a backup', async () => {
  const dir = await directory();
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  expect(child.status).toBe(0);
  const owner = { pid: child.pid, hostname: hostname(), createdAt: new Date().toISOString() };
  await writeFile(join(dir, 'instance.lock'), JSON.stringify(owner));
  expect(await inspectStoreLock(dir)).toMatchObject({ state: 'stale' });
  await expect(recoverStoreLock(dir, false)).rejects.toMatchObject({ code: 'WORKER_CONFIRMATION_REQUIRED' });
  const recovered = await recoverStoreLock(dir, true);
  expect(JSON.parse(await readFile(recovered.backupPath, 'utf8'))).toEqual(owner);
  expect(await inspectStoreLock(dir)).toMatchObject({ state: 'unlocked' });
  const store = new FileStore(dir); await store.open(); await store.close();
});
it('refuses recovery and startup while the maintenance gate is occupied', async () => {
  const dir = await directory();
  await writeFile(join(dir, 'instance.guard'), 'maintenance');
  await expect(new FileStore(dir).open()).rejects.toMatchObject({ code: 'STORE_BUSY' });
  await expect(recoverStoreLock(dir, true)).rejects.toMatchObject({ code: 'STORE_BUSY' });
});

it.each(['writeFile', 'sync'] as const)('cleans up its own newly-created lock if %s fails', async method => {
  const dir = await directory();
  let injected = false;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await originalFs.open(...args);
    if (!injected && String(args[0]).endsWith('instance.lock')) {
      injected = true;
      vi.spyOn(handle, method).mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }));
    }
    return handle;
  });
  await expect(new FileStore(dir).open()).rejects.toMatchObject({ code: 'EIO' });
  expect(await inspectStoreLock(dir)).toMatchObject({ state: 'unlocked' });
  const next = new FileStore(dir); await next.open(); await next.close();
});

it('refuses unverifiable process ownership and changed-owner cleanup', async () => {
  const dir = await directory(), store = new FileStore(dir);
  await store.open();
  const original = await readFile(join(dir, 'instance.lock'), 'utf8');
  const check = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }); });
  expect(await inspectStoreLock(dir)).toMatchObject({ state: 'unverifiable' });
  await expect(recoverStoreLock(dir, true)).rejects.toMatchObject({ code: 'LOCK_RECOVERY_REFUSED' });
  check.mockRestore();
  await writeFile(join(dir, 'instance.lock'), JSON.stringify({ ...JSON.parse(original), token: 'different-owner' }));
  await expect(store.close()).rejects.toMatchObject({ code: 'LOCK_OWNER_CHANGED' });
  await writeFile(join(dir, 'instance.lock'), original);
  await store.close();
});
