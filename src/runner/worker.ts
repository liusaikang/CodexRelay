import { runCodex } from './codex.js';
import { terminateTree } from './process.js';
import { AppError, type Execution } from '../types.js';

const controller = new AbortController();
const acknowledgements = new Map<number, () => void>();
let nextId = 0;
let started = false;
async function send(payload: Record<string, unknown>) {
  const id = ++nextId;
  await new Promise<void>((resolve, reject) => {
    acknowledgements.set(id, resolve);
    process.send?.({ ...payload, id }, error => { if (error) { acknowledgements.delete(id); reject(error); } });
  });
}
process.on('disconnect', () => {
  controller.abort();
  // Parent crash: terminate this worker and all descendants, even if SDK cancellation stalls.
  void terminateTree(process.pid).catch(() => process.exit(1));
});
process.on('message', (message: { type: string; id?: number; execution?: Execution }) => {
  if (message.type === 'ack' && message.id !== undefined) {
    acknowledgements.get(message.id)?.(); acknowledgements.delete(message.id);
  } else if (message.type === 'cancel') controller.abort();
  else if (message.type === 'run' && message.execution && !started) {
    started = true;
    void (async () => {
      try {
        const result = await runCodex(message.execution!, controller.signal, event => send({ type: 'event', event }));
        await send({ type: 'result', result });
      } catch (error) {
        await send({ type: 'error', code: error instanceof AppError ? error.code : 'CODEX_EXEC_FAILED' });
      } finally { process.exit(0); }
    })();
  }
});
