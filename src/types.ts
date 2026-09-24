import { z } from 'zod';

export const idSchema = z.string().regex(/^(?:task|sess)_[0-9a-f-]{36}$/);
export const modelReasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
export const contextSchema = z.record(z.string().min(1).max(128), z.json())
  .refine(value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 16 * 1024, 'Context must not exceed 16 KiB');
export const submitSchema = z.object({
  question: z.string().min(1).max(32000).refine(value => value.trim().length > 0, 'Question must not be blank'),
  context: contextSchema.optional(),
  sessionId: idSchema.optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
}).strict();
export type SubmitInput = z.infer<typeof submitSchema>;
export const pageSchema = z.object({
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(20),
});
export const statusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);
export const progressSchema = z.object({ at: z.string(), kind: z.string(), detail: z.string() });
export const resultSchema = z.object({ markdown: z.string(), usage: z.record(z.string(), z.number()).nullable() });
// Legacy routing fields are accepted only from persisted records, never from submissions.
const storedRequestSchema = submitSchema.extend({
  projectKey: z.string().optional(), capability: z.string().optional(),
  workingDirectory: z.string().optional(), model: z.string().optional(), modelReasoningEffort: modelReasoningEffortSchema.optional(),
});
export const taskSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), taskId: idSchema, sessionId: idSchema,
  request: storedRequestSchema, requestHash: z.string(), configHash: z.string(),
  status: statusSchema, createdAt: z.string(), startedAt: z.string().optional(), finishedAt: z.string().optional(),
  invocationTransport: z.enum(['http', 'mcp', 'stdio']).optional(),
  stopReason: z.enum(['cancelled', 'timed_out', 'interrupted']).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  result: resultSchema.optional(), progress: z.array(progressSchema),
}).refine(value => value.version === 1 || (value.request.projectKey === undefined && value.request.capability === undefined), 'Native tasks cannot contain legacy routing fields');
export const sessionSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]), sessionId: idSchema,
  workingDirectory: z.string().optional(), model: z.string().optional(), modelReasoningEffort: modelReasoningEffortSchema.optional(),
  projectKey: z.string().optional(), capability: z.string().optional(),
  configHash: z.string(), createdAt: z.string(), threadId: z.string().optional(),
}).refine(value => value.version === 1 || (!!value.workingDirectory && value.projectKey === undefined && value.capability === undefined), 'Native sessions require a working directory and no legacy routing fields');
export type Task = z.infer<typeof taskSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type RunResult = z.infer<typeof resultSchema>;
export interface RuntimeConfig {
  invocationLog?: { enabled: boolean; directory: string; retentionDays: number };
  dataDir: string; codexHome: string; host: string; port: number;
  tokenEnv: string; localConsole?: boolean; allowedHosts: string[]; allowedOrigins: string[];
  maxConcurrent: number; maxQueued: number; runner: 'codex' | 'demo';
  envAllowlist: string[]; codexPath?: string;
  timeoutSeconds: number; defaultWorkingDirectory: string;
  defaultModel?: string; defaultReasoningEffort?: z.infer<typeof modelReasoningEffortSchema>;
}
export interface Execution {
  taskId: string; question: string; context?: z.infer<typeof contextSchema>; directory: string;
  codexHome: string; threadId?: string; model?: string; modelReasoningEffort?: z.infer<typeof modelReasoningEffortSchema>; codexPath?: string;
  env: Record<string, string>;
}
export type RunEvent = { kind: 'thread'; threadId: string } | { kind: 'progress'; detail: string };
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
