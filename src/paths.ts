import { realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

// Resolve existing ancestors even when the storage directory has not been created yet.
export async function canonicalStoragePath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return resolve(await canonicalStoragePath(dirname(path)), basename(path));
  }
}
