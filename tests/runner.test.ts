import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { ProcessRunner } from '../src/runner/process.js';
import type { Execution } from '../src/types.js';

function execution(question: string): Execution {
  return { taskId: 'fixture', question, directory: process.cwd(), codexHome: 'unused', env: Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined)) };
}
it('waits for persisted event acknowledgement before accepting a worker result', async () => {
  const events: string[] = [];
  const runner = new ProcessRunner(resolve('tests/fixtures/worker.cjs'));
  const result = await runner.run(execution('success'), new AbortController().signal, async event => { events.push(event.kind); });
  expect(events).toEqual(['thread']);
  expect(result.markdown).toBe('fixture result');
});
it('forcibly stops an unresponsive worker on cancellation and only then rejects', async () => {
  const runner = new ProcessRunner(resolve('tests/fixtures/worker.cjs'));
  const controller = new AbortController();
  const start = Date.now();
  const promise = runner.run(execution('stubborn'), controller.signal, async () => { controller.abort(); });
  await expect(promise).rejects.toMatchObject({ code: 'CANCELLED' });
  expect(Date.now() - start).toBeGreaterThan(2900);
}, 15000);
it('passes a safe SDK diagnostic from the worker to the parent', async () => {
  const runner = new ProcessRunner(resolve('tests/fixtures/worker.cjs'));
  await expect(runner.run(execution('diagnostic'), new AbortController().signal, async () => {}))
    .rejects.toMatchObject({ code: 'CODEX_NETWORK_ERROR', origin: 'stream.error' });
});
it('reports an unexpected worker exit code instead of an opaque failure', async () => {
  const runner = new ProcessRunner(resolve('tests/fixtures/worker.cjs'));
  await expect(runner.run(execution('exit'), new AbortController().signal, async () => {}))
    .rejects.toMatchObject({ code: 'WORKER_EXITED', origin: 'worker.exit', exitCode: 7 });
});
