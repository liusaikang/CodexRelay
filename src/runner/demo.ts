import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import type { Runner } from '../types.js';

export class DemoRunner implements Runner {
  async run(execution: Parameters<Runner['run']>[0], signal: AbortSignal, emit: Parameters<Runner['run']>[2]) {
    await emit({ kind: 'thread', threadId: execution.threadId ?? `demo-${randomUUID()}` });
    await emit({ kind: 'progress', detail: 'demo.started' });
    await setTimeout(250, undefined, { signal });
    return { markdown: `演示任务完成。此结果未调用 Codex，也未分析任何项目或服务器。\n\n问题：${execution.question}\n\n${execution.threadId ? '已复用演示会话标识。' : '已创建演示会话标识。'}`, usage: null };
  }
}
