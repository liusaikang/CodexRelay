import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
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

export class FileStore implements Store {
  private owned = false;
  constructor(private directory: string) {}
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let lock;
    try { lock = await open(join(this.directory, 'instance.lock'), 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new AppError('STORE_LOCKED', 'Data directory is locked. Stop the other instance; after a crash verify its PID is gone before removing instance.lock.', 503);
      }
      throw error;
    }
    this.owned = true;
    try {
      try { await lock.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString() })); await lock.sync(); }
      finally { await lock.close(); }
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
  private assertOwned() { if (!this.owned) throw new Error('Store is not open'); }
  async close() {
    if (!this.owned) return;
    await unlink(join(this.directory, 'instance.lock'));
    this.owned = false;
  }
}
