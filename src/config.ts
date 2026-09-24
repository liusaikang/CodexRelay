import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import { z } from 'zod';
import { parse } from 'yaml';
import { AppError, modelReasoningEffortSchema, type RuntimeConfig } from './types.js';
import { canonicalStoragePath } from './paths.js';

const expandEnv = (value: string) => value.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_match, key: string, fallback?: string) => {
  const envValue = process.env[key];
  if (envValue) return envValue;
  if (fallback !== undefined) return fallback;
  throw new Error(`Environment variable ${key} is required by configuration`);
});
const optionalExpanded = (value?: string) => value === undefined ? undefined : expandEnv(value).trim() || undefined;
const serverSchema = z.object({
  host: z.string().default('127.0.0.1'), port: z.number().int().min(0).max(65535).default(8787),
  tokenEnv: z.string().default('CODEX_MCP_TOKEN'), localConsole: z.boolean().default(false),
  allowedHosts: z.array(z.string()).min(1).default(['localhost', '127.0.0.1', '[::1]']),
  allowedOrigins: z.array(z.string().url()).default([]),
}).strict();
const tasksSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(64).default(10),
  maxQueued: z.number().int().min(0).max(10000).default(100),
  timeoutSeconds: z.number().int().min(1).max(86400).default(600),
  queueTimeoutSeconds: z.number().int().min(1).max(604800).default(1800),
}).strict();
const codexSchema = z.object({
  home: z.string().default('../data/codex-home'),
  defaultWorkingDirectory: z.string().default('../examples/workspace'),
  defaultModel: z.string().optional(), defaultReasoningEffort: z.string().optional(),
  path: z.string().optional(),
  envAllowlist: z.array(z.string()).default(['CODEX_API_KEY', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY']),
}).strict();
const configSchema = z.object({
  invocationLog: z.object({
    enabled: z.boolean().default(false), directory: z.string().min(1).default('../data/invocation-logs'),
    retentionDays: z.number().int().min(1).max(3650).default(30),
  }).strict().prefault({}),
  dataDir: z.string().default('../data/native-service'),
  server: serverSchema.prefault({}), tasks: tasksSchema.prefault({}),
  runner: z.enum(['codex', 'demo']).default('codex'), codex: codexSchema.prefault({}),
}).strict();

export async function resolveWorkingDirectory(directory: string): Promise<string> {
  if (!isAbsolute(directory)) throw new AppError('INVALID_WORKING_DIRECTORY', 'codex.defaultWorkingDirectory must resolve to an absolute server-side path.');
  try {
    const canonical = await realpath(directory);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Not a directory');
    return canonical;
  } catch { throw new AppError('INVALID_WORKING_DIRECTORY', 'Working directory does not exist or is not accessible.'); }
}

export async function loadConfig(file: string): Promise<RuntimeConfig> {
  const base = dirname(resolve(file));
  const raw = parse(await readFile(file, 'utf8'));
  if (raw && typeof raw === 'object' && ['projects', 'capabilities', 'codexHome', 'execution'].some(key => key in raw)) {
    throw new Error('Legacy capability configuration is no longer supported. Use codex.defaultWorkingDirectory and native .agents/skills; see docs/configuration.md.');
  }
  const config = configSchema.parse(raw);
  if (config.server.localConsole && !['127.0.0.1', '::1'].includes(config.server.host)) {
    throw new Error('server.localConsole requires a loopback-only listener (127.0.0.1 or ::1)');
  }
  const effort = optionalExpanded(config.codex.defaultReasoningEffort);
  const logDirectory = resolve(base, expandEnv(config.invocationLog.directory));
  const contains = (parent: string, child: string) => { const rel = relative(parent, child); return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
  if (config.invocationLog.enabled) {
    const canonicalLog = await canonicalStoragePath(logDirectory);
    for (const protectedPath of [config.dataDir, config.codex.home]) {
      const protectedDirectory = await canonicalStoragePath(resolve(base, expandEnv(protectedPath)));
      if (contains(canonicalLog, protectedDirectory) || contains(protectedDirectory, canonicalLog)) {
        throw new Error('invocationLog.directory must be separate from dataDir and codex.home');
      }
    }
  }
  return {
    invocationLog: { ...config.invocationLog, directory: logDirectory },
    ...config.server, ...config.tasks, runner: config.runner,
    dataDir: resolve(base, expandEnv(config.dataDir)), codexHome: resolve(base, expandEnv(config.codex.home)),
    defaultWorkingDirectory: await resolveWorkingDirectory(resolve(base, expandEnv(config.codex.defaultWorkingDirectory))),
    defaultModel: optionalExpanded(config.codex.defaultModel),
    defaultReasoningEffort: effort ? modelReasoningEffortSchema.parse(effort) : undefined,
    codexPath: config.codex.path ? resolve(base, expandEnv(config.codex.path)) : undefined,
    envAllowlist: config.codex.envAllowlist,
  };
}
