import { z } from 'zod';
import type { SandboxMode } from '@openai/codex-sdk';

export const idSchema = z.string().regex(/^(?:task|sess)_[0-9a-f-]{36}$/);
const sandboxModes = ['read-only', 'workspace-write', 'danger-full-access'] as const satisfies readonly SandboxMode[];
export const sandboxModeSchema = z.enum(sandboxModes);
export const modelReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
export const contextSchema = z.record(z.string().min(1).max(128), z.json())
  .refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16 * 1024, 'Context must not exceed 16 KiB');
export const submitSchema = z.object({
  question: z.string().min(1).max(32000).refine(value => value.trim().length > 0, 'Question must not be blank'),
  context: contextSchema.optional(),
  sandboxMode: sandboxModeSchema.optional(),
  sessionId: idSchema.optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();
export type SubmitInput = z.infer<typeof submitSchema>;
export const pageSchema = z.object({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});
export const statusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
export const taskListSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['active', 'all', ...statusSchema.options]).default('active'),
  keyword: z.string().max(200).default(''),
}).strict();
export const retrySchema = z.object({ idempotencyKey: z.string().min(1).max(128) }).strict();
export const progressSchema = z.object({
  at: z.string(), kind: z.string(), detail: z.string(),
  state: z.enum(['started', 'completed', 'failed']).optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export const resultSchema = z.object({ markdown: z.string(), usage: z.record(z.string(), z.number()).nullable() });
// Legacy routing fields are accepted only from persisted records, never from submissions.
const storedRequestSchema = submitSchema.extend({
  projectKey: z.string().optional(), capability: z.string().optional(),
  workingDirectory: z.string().optional(), model: z.string().optional(), modelReasoningEffort: modelReasoningEffortSchema.optional(),
});
export const taskSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), taskId: idSchema, sessionId: idSchema,
  request: storedRequestSchema, requestHash: z.string(), configHash: z.string(),
  sandboxMode: sandboxModeSchema.optional(),
  status: statusSchema, createdAt: z.string(), startedAt: z.string().optional(), finishedAt: z.string().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  enqueueSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  queueExpiresAt: z.string().datetime().optional(),
  dependsOnTaskId: idSchema.optional(), dependencyApprovedAt: z.string().datetime().optional(),
  retryOfTaskId: idSchema.optional(),
  invocationTransport: z.enum(['http', 'mcp', 'stdio', 'scheduled']).optional(),
  stopReason: z.enum(['cancelled', 'timed_out', 'interrupted']).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  result: resultSchema.optional(), progress: z.array(progressSchema),
}).refine(value => value.version === 1 || (value.request.projectKey === undefined && value.request.capability === undefined), 'Native tasks cannot contain legacy routing fields');
export const sessionSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), sessionId: idSchema,
  workingDirectory: z.string().optional(), model: z.string().optional(), modelReasoningEffort: modelReasoningEffortSchema.optional(),
  providerId: z.string().optional(),
  projectKey: z.string().optional(), capability: z.string().optional(),
  configHash: z.string(), createdAt: z.string(), threadId: z.string().optional(),
}).refine(value => value.version === 1 || (!!value.workingDirectory && value.projectKey === undefined && value.capability === undefined), 'Native sessions require a working directory and no legacy routing fields');
export type Task = z.infer<typeof taskSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type RunResult = z.infer<typeof resultSchema>;
export interface ModelProvider {
  id: string; label: string; defaultModel?: string; models?: string[]; baseUrl?: string; envKey?: string;
}
export interface RuntimeConfig {
  sandboxMode?: z.infer<typeof sandboxModeSchema>;
  invocationLog?: { enabled: boolean; directory: string; retentionDays: number };
  dataDir: string; codexHome: string; host: string; port: number;
  tokenEnv: string; localConsole?: boolean; allowedHosts: string[]; allowedOrigins: string[];
  consoleAuth?: { username: string; password: string };
  maxConcurrent: number; maxQueued: number; runner: 'codex' | 'demo';
  envAllowlist: string[]; codexPath?: string;
  timeoutSeconds: number; queueTimeoutSeconds?: number; defaultWorkingDirectory: string;
  defaultModel?: string; defaultReasoningEffort?: z.infer<typeof modelReasoningEffortSchema>;
  activeProvider?: string; modelProviders?: ModelProvider[];
}
export interface Execution {
  sandboxMode?: z.infer<typeof sandboxModeSchema>;
  taskId: string; question: string; context?: z.infer<typeof contextSchema>; directory: string;
  codexHome: string; threadId?: string; model?: string; modelReasoningEffort?: z.infer<typeof modelReasoningEffortSchema>; codexPath?: string;
  providerId?: string; providerBaseUrl?: string; providerEnvKey?: string;
  env: Record<string, string>;
}
export type RunEvent = { kind: 'thread'; threadId: string }
  | { kind: 'progress'; detail: string; state?: 'started' | 'completed' | 'failed'; durationMs?: number };
export interface Runner {
  // Must settle only after the execution process has exited, including on cancellation.
  run(execution: Execution, signal: AbortSignal, onEvent: (event: RunEvent) => Promise<void>): Promise<RunResult>;
}
export interface Store {
  open(): Promise<{ tasks: Task[]; sessions: Session[] }>;
  saveTask(task: Task): Promise<void>;
  saveSession(session: Session): Promise<void>;
  close(): Promise<void>;
}
export class AppError extends Error {
  constructor(public code: string, message: string, public httpStatus = 400) { super(message); }
}
export const isTerminal = (task: Task) => task.status !== 'queued' && task.status !== 'running';
