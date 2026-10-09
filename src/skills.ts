import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AppError } from './types.js';

const maxFiles = 2000;
const maxDepth = 12;
const maxPreviewBytes = 512 * 1024;
const textExtensions = new Set(['.md', '.txt', '.py', '.js', '.mjs', '.cjs', '.ts', '.json', '.yaml', '.yml', '.toml', '.sh', '.ps1', '.bat', '.cmd', '.sql', '.xml']);
const sensitiveName = /(^\.env(?:\.|$)|^auth\.json$|^id_(?:rsa|ed25519)|credential|secret|password|token|\.pem$|\.p12$|\.key$)/i;

export interface SkillTreeEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file';
  children?: SkillTreeEntry[];
  previewable?: boolean;
  size?: number;
}

export class SkillExplorer {
  constructor(private readonly workingDirectory: string) {}

  private async root() {
    const agents = join(this.workingDirectory, '.agents');
    const skills = join(agents, 'skills');
    try {
      for (const directory of [agents, skills]) {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new AppError('SKILL_ROOT_INVALID', 'Skill directory must be a real directory.', 409);
      }
      const canonical = await realpath(skills);
      const workspace = await realpath(this.workingDirectory);
      const rel = relative(workspace, canonical);
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new AppError('SKILL_ROOT_INVALID', 'Skill directory is outside the working directory.', 409);
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private previewable(name: string, size: number) {
    return !sensitiveName.test(name) && textExtensions.has(extname(name).toLowerCase()) && size <= maxPreviewBytes;
  }

  async tree() {
    const root = await this.root();
    if (!root) return { workingDirectory: this.workingDirectory, root: '.agents/skills', entries: [] as SkillTreeEntry[] };
    let count = 0;
    const walk = async (directory: string, parts: string[], depth: number): Promise<SkillTreeEntry[]> => {
      if (depth > maxDepth) throw new AppError('SKILL_TREE_TOO_DEEP', 'Skill directory nesting is too deep.', 409);
      const entries: SkillTreeEntry[] = [];
      const names = await readdir(directory);
      for (const name of names) {
        if (name.startsWith('.') || name === 'node_modules' || sensitiveName.test(name)) continue;
        if (++count > maxFiles) throw new AppError('SKILL_TREE_TOO_LARGE', 'Too many files in the Skill directory.', 409);
        const path = join(directory, name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) continue;
        const relativePath = [...parts, name].join('/');
        if (info.isDirectory()) {
          entries.push({ name, path: relativePath, kind: 'directory', children: await walk(path, [...parts, name], depth + 1) });
        } else if (info.isFile()) {
          entries.push({ name, path: relativePath, kind: 'file', size: info.size, previewable: this.previewable(name, info.size) });
        }
      }
      return entries.sort((a,b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name));
    };
    return { workingDirectory: this.workingDirectory, root: '.agents/skills', entries: await walk(root, [], 0) };
  }

  async file(rawPath: string) {
    if (typeof rawPath !== 'string' || rawPath.length > 2048) throw new AppError('INVALID_SKILL_PATH', 'Invalid Skill file path.', 400);
    const parts = rawPath.split('/');
    if (parts.length < 2 || parts.length > maxDepth || parts.some(part => !part || part.startsWith('.') || part === '..' || part === 'node_modules' || part.includes('\\') || part.includes(':') || part.includes('\0') || sensitiveName.test(part))) {
      throw new AppError('INVALID_SKILL_PATH', 'Invalid Skill file path.', 400);
    }
    const root = await this.root();
    if (!root) throw new AppError('NOT_FOUND', 'Skill directory does not exist.', 404);
    const target = resolve(root, ...parts);
    const rel = relative(root, target);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new AppError('INVALID_SKILL_PATH', 'Invalid Skill file path.', 400);
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND', 'Skill file not found.', 404);
        throw error;
      }
      if (info.isSymbolicLink()) throw new AppError('SKILL_LINK_DENIED', 'Linked Skill files and directories cannot be previewed.', 403);
    }
    const info = await lstat(target);
    if (!info.isFile()) throw new AppError('INVALID_SKILL_PATH', 'Skill path must point to a file.', 400);
    if (!this.previewable(basename(target), info.size)) throw new AppError('SKILL_FILE_UNSUPPORTED', 'This file cannot be previewed.', 415);
    const canonical = await realpath(target);
    const canonicalRel = relative(root, canonical);
    if (isAbsolute(canonicalRel) || canonicalRel === '..' || canonicalRel.startsWith(`..${sep}`)) throw new AppError('SKILL_LINK_DENIED', 'Skill file is outside the Skill directory.', 403);
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > maxPreviewBytes) throw new AppError('SKILL_FILE_UNSUPPORTED', 'This file cannot be previewed.', 415);
      const chunks: Buffer[] = [];
      let length = 0;
      while (length <= maxPreviewBytes) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxPreviewBytes + 1 - length));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, length);
        if (!bytesRead) break;
        chunks.push(buffer.subarray(0, bytesRead)); length += bytesRead;
      }
      if (length > maxPreviewBytes) throw new AppError('SKILL_FILE_UNSUPPORTED', 'This file cannot be previewed.', 415);
      let content: string;
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
      catch { throw new AppError('SKILL_FILE_UNSUPPORTED', 'Only UTF-8 text files can be previewed.', 415); }
      if (content.includes('\0')) throw new AppError('SKILL_FILE_UNSUPPORTED', 'Binary files cannot be previewed.', 415);
      return { path: rawPath, name: basename(target), content, size: length, modifiedAt: opened.mtime.toISOString() };
    } finally { await handle.close(); }
  }
}
