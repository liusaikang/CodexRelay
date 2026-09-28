import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { TaskService } from '../service.js';
import { AppError, idSchema, pageSchema, submitSchema } from '../types.js';

export function createMcpServer(service: TaskService, transport: 'mcp' | 'stdio' = 'mcp') {
  const server = new McpServer({ name: 'codex-task-mcp', version: '0.1.0' });
  const outputSchema = { data: z.unknown() };
  async function respond(operation: () => unknown | Promise<unknown>) {
    try {
      const data = await operation();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: { data } };
    } catch (error) {
      const detail = error instanceof AppError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: 'Request failed. Check configuration or service health.' };
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(detail) }] };
    }
  }
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  server.registerTool('codex_submit_task', {
    title: '提交 Codex 分析任务',
    description: 'Submit a question and optional structured context to the native Codex Harness, then immediately return taskId/sessionId/status. Optional sandboxMode uses native Codex values: read-only, workspace-write, danger-full-access; omission uses the service default for this task. Poll codex_get_task. The service uses its configured working directory, model and reasoning effort. Omit sessionId for a new task; pass it to continue the same Codex thread. Reuse idempotencyKey only when retrying identical parameters, including sandboxMode.',
    inputSchema: submitSchema, outputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, input => respond(() => service.submit(input, transport)));
  server.registerTool('codex_get_task', {
    title: '查询分析任务', description: 'Get task status, scheduling reason and blocking task, last 100 progress events, result, usage and error code. Terminal statuses: succeeded, failed, cancelled, timed_out, interrupted. QUEUE_EXPIRED means execution never started. previous_task_failed requires operator acknowledgement via the session resume HTTP endpoint or cancellation. Poll every 2-5 seconds.',
    inputSchema: { taskId: idSchema }, outputSchema, annotations: read,
  }, ({ taskId }) => respond(() => service.getTask(taskId)));
  server.registerTool('codex_cancel_task', {
    title: '取消分析任务', description: 'Request cancellation. A running task remains running with stopReason until its process exits. Repeated cancellation is safe.',
    inputSchema: { taskId: idSchema }, outputSchema, annotations: { ...read, readOnlyHint: false },
  }, ({ taskId }) => respond(() => service.cancel(taskId)));
  server.registerTool('codex_list_sessions', {
    title: '列出会话', description: 'List sessions with offset pagination, newest first. Sessions belong to the shared trusted service instance.',
    inputSchema: pageSchema.shape, outputSchema, annotations: read,
  }, ({ offset, limit }) => respond(() => service.listSessions(offset, limit)));
  server.registerTool('codex_get_session', {
    title: '查看会话历史', description: 'Get a session and paginated task summaries. Use codex_get_task to read each answer. Does not expose raw Codex thread history or internal thread IDs.',
    inputSchema: { sessionId: idSchema, ...pageSchema.shape }, outputSchema, annotations: read,
  }, ({ sessionId, offset, limit }) => respond(() => service.getSession(sessionId, offset, limit)));
  server.registerTool('codex_get_service_info', {
    title: '查看任务服务配置', description: 'Get the default sandbox policy, default working directory, model settings and queue limits. Individual tasks may specify sandboxMode. Skills are managed by the native Codex Harness, not a service capability registry.',
    inputSchema: {}, outputSchema, annotations: read,
  }, () => respond(() => service.info()));
  return server;
}
