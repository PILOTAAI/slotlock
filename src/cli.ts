#!/usr/bin/env node
// The `slotlock` executable: process wiring only (arguments, environment, output streams, signals
// and the exit code). The commands and their configuration live in self-host.ts.
import { runSlotlockCli } from './self-host.js';

const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    // The first signal drains gracefully; a second one stops waiting for the drain.
    if (shutdown.signal.aborted) process.exit(1);
    shutdown.abort();
  });
}

process.exitCode = await runSlotlockCli(process.argv.slice(2), {
  env: process.env,
  stdout: process.stdout,
  stderr: process.stderr,
  signal: shutdown.signal,
});
// Everything is closed by now, so the process ends on its own. Should a stray handle (a socket or
// timer something else left open) keep it alive, exit anyway rather than hang a container stop.
setTimeout(() => process.exit(), 5_000).unref();
