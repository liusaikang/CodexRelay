import { execFile, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { AppError, resultSchema, type Execution, type RunEvent, type Runner, type RunResult } from '../types.js';

export async function terminateTree(pid: number) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid worker PID');
  if (process.platform === 'win32') {
    await promisify(execFile)('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(error => {
      try { process.kill(pid, 0); } catch { return; }
      throw error;
    });
  } else {
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
}

export class ProcessRunner implements Runner {
  constructor(private workerPath = fileURLToPath(new URL('./worker.js', import.meta.url))) {}
  async run(execution: Execution, signal: AbortSignal, onEvent: (event: RunEvent) => Promise<void>): Promise<RunResult> {
    if (signal.aborted) throw new AppError('CANCELLED', 'Cancelled before worker start');
    return new Promise((resolve, reject) => {
      const child = fork(this.workerPath, [], {
        detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: execution.env, execArgv: [],
      });
      let result: RunResult | undefined;
      let failure: Error | undefined;
      let forceTimer: NodeJS.Timeout | undefined;
      let handling = Promise.resolve();
      let closed = false;
      const send = (message: unknown) => {
        if (child.connected) child.send(message as object, error => { if (error) stop(); });
      };
      const stop = () => {
        if (closed || forceTimer) return;
        send({ type: 'cancel' });
        forceTimer = setTimeout(() => {
          if (child.pid) void terminateTree(child.pid).catch(() => {
            // Keep the slot occupied if termination could not be confirmed.
            failure = new AppError('WORKER_STOP_FAILED', 'Unable to terminate worker; inspect OS permissions.');
          });
        }, 3000);
      };
      signal.addEventListener('abort', stop, { once: true });
      child.on('error', () => { failure = new AppError('WORKER_START_FAILED', 'Worker process could not start.'); stop(); });
      child.on('message', (raw: unknown) => {
        handling = handling.then(async () => {
          const message = raw as { type: string; id: number; event?: RunEvent; result?: unknown; code?: string };
          if (message.type === 'event' && message.event) await onEvent(message.event);
          else if (message.type === 'result') result = resultSchema.parse(message.result);
          else if (message.type === 'error') failure = new AppError(message.code ?? 'CODEX_FAILED', 'Codex worker failed.');
          send({ type: 'ack', id: message.id });
        }).catch(() => { failure = new AppError('WORKER_EVENT_FAILED', 'Unable to persist worker event.'); stop(); });
      });
      child.on('close', () => {
        closed = true;
        clearTimeout(forceTimer);
        signal.removeEventListener('abort', stop);
        void handling.then(() => {
          if (signal.aborted) reject(new AppError('CANCELLED', 'Execution cancelled'));
          else if (failure) reject(failure);
          else if (!result) reject(new AppError('WORKER_EXITED', 'Worker exited without a result.'));
          else resolve(result);
        });
      });
      send({ type: 'run', execution });
      if (signal.aborted) stop();
    });
  }
}
