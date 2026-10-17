// One worker of createICalendarWorkerPool: reads the feeds it is sent with the ordinary parsers and
// posts back what they return, or the code of the CalendarContractError they throw.
import { parentPort } from 'node:worker_threads';
import type { ICalendarWorkerReply, ICalendarWorkerRequest } from './ical-worker.js';
import {
  CalendarContractError,
  CalendarExpansionLimitError,
  parseICalendarChanges,
  parseTrustedICalendarEvents,
} from './sync.js';

const port = parentPort;
if (!port) throw new Error('slotlock: ical-worker-thread runs only as a worker thread');

port.on('message', (request: ICalendarWorkerRequest) => {
  let reply: ICalendarWorkerReply;
  try {
    const value =
      request.op === 'changes'
        ? parseICalendarChanges(request.input, request.calendarTimezone, request.window)
        : parseTrustedICalendarEvents(request.input, request.calendarTimezone);
    reply = { id: request.id, ok: true, value };
  } catch (error) {
    // The parsers turn every failure into a CalendarContractError; anything else is a fault, and
    // ends this worker so the pool reports it.
    if (!(error instanceof CalendarContractError)) throw error;
    reply = {
      id: request.id,
      ok: false,
      code: error.code,
      limit: error instanceof CalendarExpansionLimitError,
    };
  }
  port.postMessage(reply);
});
