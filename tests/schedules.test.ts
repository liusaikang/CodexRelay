import { afterEach, expect, it } from 'vitest';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskService } from '../src/service.js';
import { FileStore } from '../src/storage.js';
import { ScheduleService } from '../src/schedules.js';
import type { Execution, Runner, RuntimeConfig } from '../src/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

class ControlledRunner implements Runner {
  calls: Array<{ execution: Execution; finish: () => void; fail: () => void }> = [];
  async run(execution: Execution, signal: AbortSignal, emit: Parameters<Runner['run']>[2]) {
    await emit({ kind: 'thread', threadId: execution.threadId ?? `thread-${execution.taskId}` });
    return await new Promise<{ markdown: string; usage: null }>((resolve, reject) => {
      this.calls.push({ execution, finish: () => resolve({ markdown: 'done', usage: null }), fail: () => reject(new Error('test failure')) });
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'relay-recurring-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const config: RuntimeConfig = { dataDir: dir, codexHome: join(dir, 'codex'), host: '127.0.0.1', port: 0,
    tokenEnv: 'CODEX_MCP_TOKEN', allowedHosts: ['localhost'], allowedOrigins: [], maxConcurrent: 4, maxQueued: 8,
    timeoutSeconds: 30, queueTimeoutSeconds: 1800, defaultWorkingDirectory: dir, runner: 'codex', envAllowlist: [] };
  const runner = new ControlledRunner();
  const service = new TaskService(config, new FileStore(dir), runner);
  await service.init(); cleanup.push(() => service.close());
  const schedules = new ScheduleService(service, { autoStart: false });
  await schedules.init(); cleanup.push(() => schedules.close());
  return { dir, runner, service, schedules };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

it('runs four independent lanes and dispatches the fifth waiting run when one finishes', async () => {
  const { schedules, runner, service } = await fixture();
  const schedule = await schedules.create({ name: 'Classification audit', question: 'Analyze pending goods', intervalMinutes: 5, enabled: false });
  for (let i = 0; i < 5; i++) await schedules.runNow(schedule.id);
  expect(runner.calls).toHaveLength(4);
  expect(new Set(runner.calls.map(call => call.execution.taskId)).size).toBe(4);
  expect(new Set(schedules.runs(schedule.id).filter(run => run.taskId).map(run => run.sessionId)).size).toBe(4);
  expect(schedules.runs(schedule.id).filter(run => run.state === 'waiting')).toHaveLength(1);
  runner.calls[0]!.finish();
  await until(() => service.getTask(runner.calls[0]!.execution.taskId).status === 'succeeded');
  await schedules.tick();
  await until(() => runner.calls.length === 5);
  expect(runner.calls[4]!.execution.threadId).toBe(`thread-${runner.calls[0]!.execution.taskId}`);
  expect(schedules.runs(schedule.id).filter(run => run.state === 'waiting')).toHaveLength(0);
});

it('persists waiting runs and reuses accepted task ids after scheduler restart', async () => {
  const { schedules, runner, service } = await fixture();
  const schedule = await schedules.create({ name: 'Audit', question: 'Analyze', intervalMinutes: 5, enabled: false });
  for (let i = 0; i < 5; i++) await schedules.runNow(schedule.id);
  await schedules.close();
  const restored = new ScheduleService(service, { autoStart: false });
  await restored.init(); cleanup.push(() => restored.close());
  expect(restored.runs(schedule.id).filter(run => run.state === 'waiting')).toHaveLength(1);
  expect(restored.runs(schedule.id).filter(run => run.taskId)).toHaveLength(4);
  runner.calls[1]!.fail();
  await until(() => service.getTask(runner.calls[1]!.execution.taskId).status === 'failed');
  await restored.tick();
  await until(() => runner.calls.length === 5);
  expect(restored.runs(schedule.id).filter(run => run.state === 'waiting')).toHaveLength(0);
});

it('keeps all four lane sessions when several waiting rounds are dispatched in one pass', async () => {
  const { schedules, runner, service } = await fixture();
  const rule = await schedules.create({ name: 'Four lanes', question: 'Analyze', intervalMinutes: 5, enabled: false });
  for (let i = 0; i < 8; i++) await schedules.runNow(rule.id);
  expect(schedules.runs(rule.id).filter(run => run.state === 'waiting')).toHaveLength(4);
  const original = runner.calls.slice(0,4).map(call => call.execution.taskId);
  for (const call of runner.calls.slice(0,4)) call.finish();
  await until(() => original.every(id => service.getTask(id).status === 'succeeded'));
  await schedules.tick();
  await until(() => runner.calls.length === 8);
  expect(new Set(schedules.get(rule.id).sessions).size).toBe(4);
  expect(new Set(runner.calls.slice(4).map(call => call.execution.threadId))).toEqual(new Set(original.map(id => `thread-${id}`)));
});

it('recovers waiting rounds after a full service restart without replaying interrupted work', async () => {
  const { dir, schedules, service } = await fixture();
  const rule = await schedules.create({ name: 'Restart', question: 'Analyze', intervalMinutes: 5, enabled: false });
  for (let i = 0; i < 5; i++) await schedules.runNow(rule.id);
  const oldTaskIds = schedules.runs(rule.id).filter(run => run.taskId).map(run => run.taskId!);
  await schedules.close(); await service.close();
  const runner = new ControlledRunner();
  const restoredService = new TaskService(service.config, new FileStore(dir), runner);
  await restoredService.init(); cleanup.push(() => restoredService.close());
  const restoredSchedules = new ScheduleService(restoredService, { autoStart: false });
  await restoredSchedules.init(); cleanup.push(() => restoredSchedules.close());
  expect(oldTaskIds.every(id => restoredService.getTask(id).status === 'interrupted')).toBe(true);
  expect(restoredSchedules.runs(rule.id)).toHaveLength(5);
  expect(restoredSchedules.runs(rule.id).filter(run => run.state === 'waiting')).toHaveLength(0);
  await until(() => runner.calls.length === 1);
  expect(runner.calls).toHaveLength(1);
  expect(oldTaskIds).not.toContain(runner.calls[0]!.execution.taskId);
});

it('creates a due run once and records a catch-up after downtime without an unbounded burst', async () => {
  const { schedules, runner } = await fixture();
  const schedule = await schedules.create({ name: 'Timed audit', question: 'Analyze', intervalMinutes: 5, enabled: true });
  const due = Date.parse(schedule.nextRunAt);
  await schedules.tick(due + 5);
  await schedules.tick(due + 5);
  expect(schedules.runs(schedule.id)).toHaveLength(1);
  expect(runner.calls).toHaveLength(1);
  await schedules.tick(due + 65 * 60 * 1000);
  expect(schedules.runs(schedule.id)).toHaveLength(2);
  expect(schedules.get(schedule.id).nextRunAt).toBe(new Date(due + 70 * 60 * 1000).toISOString());
});

it('passes a custom system prompt to every run and uses the default file for blank prompts', async () => {
  const { dir, schedules, runner, service } = await fixture();
  const defaultFile = join(dir, 'default-instructions.md');
  await writeFile(defaultFile, 'Default instructions', 'utf8');
  service.config.defaultDeveloperInstructionsFile = defaultFile;
  const custom = await schedules.create({ name: 'Custom', question: 'Analyze', systemPrompt: '  Custom instructions  ', intervalMinutes: 5, enabled: false });
  expect(custom.systemPrompt).toBe('Custom instructions');
  const customRun = await schedules.runNow(custom.id);
  expect(customRun.systemPrompt).toBe('Custom instructions');
  expect(service.getTask(customRun.taskId!).request.systemPrompt).toBe('Custom instructions');
  expect(runner.calls[0]!.execution.developerInstructions).toBe('Custom instructions');

  const blank = await schedules.create({ name: 'Default', question: 'Analyze', systemPrompt: '   ', intervalMinutes: 5, enabled: false });
  expect(blank.systemPrompt).toBeUndefined();
  const blankRun = await schedules.runNow(blank.id);
  expect(blankRun.systemPrompt).toBeUndefined();
  expect(service.getTask(blankRun.taskId!).request.systemPrompt).toBeUndefined();
  expect(runner.calls[1]!.execution.developerInstructions).toBe('Default instructions');
});

it('deletes a completed schedule and its run files without deleting the task result', async () => {
  const { dir, schedules, runner, service } = await fixture();
  const rule = await schedules.create({ name: 'Remove me', question: 'Analyze', intervalMinutes: 5, enabled: false });
  const run = await schedules.runNow(rule.id);
  await expect(schedules.delete(rule.id)).rejects.toMatchObject({ code: 'SCHEDULE_ACTIVE', httpStatus: 409 });
  runner.calls[0]!.finish();
  await until(() => service.getTask(run.taskId!).status === 'succeeded');
  await schedules.tick();
  await schedules.delete(rule.id);
  expect(schedules.list()).toHaveLength(0);
  await expect(access(join(dir, 'schedules', 'definitions', `${rule.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(access(join(dir, 'schedules', 'runs', `${run.id}.json`))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(service.getTask(run.taskId!).status).toBe('succeeded');
  await schedules.close();
  const restored = new ScheduleService(service, { autoStart: false });
  await restored.init(); cleanup.push(() => restored.close());
  expect(restored.list()).toHaveLength(0);
});

it('protects sessions referenced by scheduled rules until the rule is deleted', async () => {
  const { schedules, runner, service } = await fixture();
  const rule = await schedules.create({ name: 'Scheduled', question: 'Analyze', intervalMinutes: 5, enabled: false });
  const run = await schedules.runNow(rule.id);
  runner.calls[0]!.finish();
  await until(() => service.getTask(run.taskId!).status === 'succeeded');
  await schedules.tick();
  await expect(schedules.deleteSession(run.sessionId!)).rejects.toMatchObject({ code: 'SESSION_SCHEDULED', httpStatus: 409 });
  await schedules.delete(rule.id);
  expect(await schedules.deleteSession(run.sessionId!)).toEqual({ deleted: true, deletedTasks: 1 });
});
