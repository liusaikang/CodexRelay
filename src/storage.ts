import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, idSchema, sessionSchema, taskSchema, type Session, type Store, type Task } from './types.js';

export async function atomicJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
    // fsync the directory where supported so the rename survives a power loss.
    if (process.platform !== 'win32') {
      const directory = await open(join(path, '..'), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

const ownerSchema = z.object({ pid: z.number().int().positive(), hostname: z.string().min(1), createdAt: z.string(), token: z.string().optional() });
export async function inspectStoreLock(directory: string) {
  let owner: z.infer<typeof ownerSchema>;
  try { owner = ownerSchema.parse(JSON.parse(await readFile(join(directory, 'instance.lock'), 'utf8'))); }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unlocked' : 'unverifiable' }; }
  if (owner.hostname !== hostname()) return { state: 'foreign', owner };
  try { process.kill(owner.pid, 0); return { state: 'active', owner }; }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stale' : 'unverifiable', owner }; }
}

// Startup and explicit recovery share a short exclusive gate. Never auto-delete a stale gate.
async function withStoreGate<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const path = join(directory, 'instance.guard');
  let gate;
  try { gate = await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new AppError('STORE_BUSY', 'Storage startup/recovery gate exists. Inspect its owner; do not remove it while maintenance is active.', 503);
    throw error;
  }
  try {
    await gate.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() }));
    await gate.sync();
    return await operation();
  } finally { await gate.close(); await unlink(path); }
}

export async function recoverStoreLock(directory: string, workersStopped: boolean) {
  if (!workersStopped) throw new AppError('WORKER_CONFIRMATION_REQUIRED', 'Confirm that the old worker processes and descendants have stopped before recovery.', 409);
  return withStoreGate(directory, async () => {
    const inspection = await inspectStoreLock(directory);
    if (inspection.state !== 'stale') throw new AppError('LOCK_RECOVERY_REFUSED', `Lock owner is ${inspection.state}; refusing recovery.`, 409);
    const backupPath = join(directory, `instance.lock.recovered-${Date.now()}-${randomUUID()}.json`);
    await atomicJson(backupPath, inspection.owner);
    await unlink(join(directory, 'instance.lock'));
    return { recovered: true, backupPath };
  });
}

export class FileStore implements Store {
  private owned = false;
  private ownerToken = randomUUID();
  constructor(private directory: string) {}
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await withStoreGate(this.directory, async () => {
      let lock;
      try { lock = await open(join(this.directory, 'instance.lock'), 'wx', 0o600); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const inspection = await inspectStoreLock(this.directory);
          throw new AppError('STORE_LOCKED', `Data directory is locked (owner: ${inspection.state}). Use --inspect-lock; recovery is explicit and requires confirming old workers have stopped.`, 503);
        }
        throw error;
      }
      try {
        try {
          await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), token: this.ownerToken }));
          await lock.sync();
        } finally { await lock.close(); }
        this.owned = true;
      } catch (error) {
        // Still holding the gate: this is the file we exclusively created, not another owner's lock.
        try { await unlink(join(this.directory, 'instance.lock')); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Lock initialization and cleanup failed; inspect storage before restart.'); }
        throw error;
      }
    });
    try {
      await mkdir(join(this.directory, 'tasks'), { recursive: true });
      await mkdir(join(this.directory, 'sessions'), { recursive: true });
      const read = async (folder: string) => {
        const values: unknown[] = [];
        for (const file of await readdir(join(this.directory, folder))) {
          if (file.endsWith('.json')) values.push(JSON.parse(await readFile(join(this.directory, folder, file), 'utf8')));
        }
        return values;
      };
      const tasks = (await read('tasks')).map(value => taskSchema.parse(value));
      const sessions = (await read('sessions')).map(value => sessionSchema.parse(value));
      if (new Set(tasks.map(t => t.taskId)).size !== tasks.length || new Set(sessions.map(s => s.sessionId)).size !== sessions.length) throw new Error('Duplicate stored IDs');
      return { tasks, sessions };
    } catch (error) { await this.close(); throw error; }
  }
  async saveTask(task: Task) { this.assertOwned(); await atomicJson(join(this.directory, 'tasks', `${idSchema.parse(task.taskId)}.json`), task); }
  async saveSession(session: Session) { this.assertOwned(); await atomicJson(join(this.directory, 'sessions', `${idSchema.parse(session.sessionId)}.json`), session); }
  async deleteSession(sessionId: string, taskIds: string[]) {
    this.assertOwned();
    for (const id of taskIds) await unlink(join(this.directory, 'tasks', `${idSchema.parse(id)}.json`));
    await unlink(join(this.directory, 'sessions', `${idSchema.parse(sessionId)}.json`));
  }
  private assertOwned() { if (!this.owned) throw new Error('Store is not open'); }
  async close() {
    if (!this.owned) return;
    const inspection = await inspectStoreLock(this.directory);
    if (inspection.owner?.token !== this.ownerToken) throw new AppError('LOCK_OWNER_CHANGED', 'Storage lock ownership changed; refusing to remove it.', 503);
    await unlink(join(this.directory, 'instance.lock'));
    this.owned = false;
  }
}
