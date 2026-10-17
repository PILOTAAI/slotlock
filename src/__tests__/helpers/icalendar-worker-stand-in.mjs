// A stand-in for ical-worker-thread.js, which only the built package can start: it speaks the same
// protocol, and the input names what it does, so the pool can be tested against a worker that hangs
// as ical.js might, runs out of its heap, or replies as the parsers do.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (request) => {
  const { id, input } = request;
  if (input === 'hang') {
    // As a loop in ical.js would: nothing on this thread runs again.
    for (;;) {}
  }
  if (input === 'memory') {
    const hoard = [];
    for (;;) hoard.push(new Array(1_000_000).fill(id));
  }
  if (input === 'fault') throw new Error('stand-in fault');
  if (input.startsWith('sleep:')) {
    setTimeout(
      () => parentPort.postMessage({ id, ok: true, value: 'slept' }),
      Number(input.slice(6)),
    );
    return;
  }
  if (input === 'limit') {
    parentPort.postMessage({ id, ok: false, code: 'invalid_icalendar', limit: true });
    return;
  }
  if (input === 'interval') {
    parentPort.postMessage({ id, ok: false, code: 'invalid_external_interval', limit: false });
    return;
  }
  parentPort.postMessage({ id, ok: true, value: { echo: request } });
});
