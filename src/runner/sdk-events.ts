import { lstat, mkdir, open, readdir, stat, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { idSchema } from '../types.js';

const fileName = (taskId: string) => `${idSchema.parse(taskId)}.jsonl`;

export class SdkEventLog {
  private bytes = 0;
  private truncated = false;

  private constructor(private file: FileHandle, private taskId: string, private maxBytes: number) {}

  static async open(codexHome: string, taskId: string, maxBytes: number) {
    const directory = join(codexHome, 'sdk-events');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('SDK event log directory must not be a link');
    const file = await open(join(directory, fileName(taskId)), 'wx', 0o600);
    return new SdkEventLog(file, taskId, maxBytes);
  }

  async append(entry: { source: 'sdk'; event: unknown } | { source: 'runner'; error: { code?: string; message: string } }) {
    if (this.truncated) return;
    const line = Buffer.from(JSON.stringify({ at: new Date().toISOString(), taskId: this.taskId, ...entry }) + '\n');
    if (this.bytes + line.length > this.maxBytes) {
      const marker = Buffer.from(JSON.stringify({ at: new Date().toISOString(), taskId: this.taskId,
        source: 'runner', event: { type: 'diagnostic.truncated', maxBytesPerTask: this.maxBytes } }) + '\n');
      if (this.bytes + marker.length <= this.maxBytes) {
        await this.file.writeFile(marker);
        this.bytes += marker.length;
      }
      this.truncated = true;
      return;
    }
    await this.file.writeFile(line);
    this.bytes += line.length;
  }

  async close() { await this.file.close(); }
}

export async function pruneSdkEventLogs(codexHome: string, retentionDays: number, now = Date.now()) {
  const directory = join(codexHome, 'sdk-events');
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('SDK event log directory must not be a link');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const cutoff = now - retentionDays * 86_400_000;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^task_[0-9a-f-]{36}\.jsonl$/.test(entry.name)) continue;
    const path = join(directory, entry.name);
    if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
  }
}
