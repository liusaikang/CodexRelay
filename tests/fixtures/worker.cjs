const acknowledgements = new Map();
let id = 0;
let mode;
const send = async (payload) => {
  const key = ++id;
  await new Promise(resolve => { acknowledgements.set(key, resolve); process.send({ ...payload, id: key }); });
};
process.on('message', async (message) => {
  if (message.type === 'ack') { acknowledgements.get(message.id)?.(); return; }
  if (message.type === 'cancel') {
    if (mode !== 'stubborn') process.exit(0);
    return;
  }
  if (message.type === 'run') {
    mode = message.execution.question;
    await send({ type: 'event', event: { kind: 'thread', threadId: 'fixture-thread' } });
    if (mode === 'stubborn') return;
    await send({ type: 'result', result: { markdown: 'fixture result', usage: null } });
    process.exit(0);
  }
});
