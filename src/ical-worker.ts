// Untrusted iCalendar read on worker threads. The parsers bound ical.js with a step budget and caps
// on what a feed may carry, but they still run on the thread that called them: a feed can hold that
// thread for about half a second, and a loop in ical.js nobody has found yet would hold it for
// good. Here the main thread never runs ical.js on the feed. A worker that runs past its deadline
// is stopped, one that runs out of its heap ends alone, and either way the feed is refused.
import type { Worker } from 'node:worker_threads';
import {
  CalendarContractError,
  CalendarExpansionLimitError,
  type ExternalCalendarChange,
  type ICalendarExpansionWindow,
  MAX_ICAL_INPUT_BYTES,
} from './sync.js';
import type { TrustedICalendarEvent } from './types.js';

/** What the pool posts to a worker. */
export type ICalendarWorkerRequest =
  | {
      id: number;
      op: 'changes';
      input: string;
      calendarTimezone: string | undefined;
      window: ICalendarExpansionWindow | undefined;
    }
  | { id: number; op: 'trusted'; input: string; calendarTimezone: string | undefined };

/** What a worker posts back: the parser's result, or the code of the error it threw. */
export type ICalendarWorkerReply =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; code: CalendarContractError['code']; limit: boolean };

type Job = {
  request: DistributiveOmit<ICalendarWorkerRequest, 'id'>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Slot {
  worker: Worker;
  job: Job | null;
  id: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface ICalendarWorkerPoolOptions {
  /** Workers that may run at once, 1-64. Defaults to 2. */
  size?: number;
  /**
   * How long one parse may run on its worker, in ms, before the worker is stopped and the feed
   * refused (CalendarExpansionLimitError), 100-60,000. Defaults to 3,000: several times what the
   * parser's step budget takes, with room for a new worker to start.
   */
  deadlineMs?: number;
  /** Parses that may wait for a worker, 0-10,000; more are refused at once. Defaults to 64. */
  maxQueue?: number;
  /** The heap one worker may use, in MB, 16-4,096. Defaults to 128. */
  maxHeapMb?: number;
  /**
   * The module each worker runs. Defaults to `ical-worker-thread.js` beside this module, which the
   * built package ships; Slotlock's own TypeScript sources cannot start it (tests pass a stand-in).
   */
  entry?: URL;
}

export interface ICalendarWorkerPool {
  /** `parseICalendarChanges`, run on a worker. */
  parseICalendarChanges(
    input: string,
    calendarTimezone?: string,
    expansionWindow?: ICalendarExpansionWindow,
  ): Promise<ExternalCalendarChange[]>;
  /** `parseTrustedICalendarEvents`, run on a worker. */
  parseTrustedICalendarEvents(
    input: string,
    calendarTimezone?: string,
  ): Promise<TrustedICalendarEvent[]>;
  /** Refuse waiting parses and stop every worker. */
  close(): Promise<void>;
}

/** Every worker is busy and the queue is full: try the feed again later. */
export class ICalendarWorkerBusyError extends Error {
  readonly code = 'icalendar_workers_busy' as const;

  constructor() {
    super('icalendar_workers_busy');
    this.name = 'ICalendarWorkerBusyError';
  }
}

/** The pool was closed before the parse ran. */
export class ICalendarWorkerPoolClosedError extends Error {
  readonly code = 'icalendar_workers_closed' as const;

  constructor() {
    super('icalendar_workers_closed');
    this.name = 'ICalendarWorkerPoolClosedError';
  }
}

function bounded(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
    throw new RangeError(`slotlock: ICalendarWorkerPool ${name} must be an integer ${min}-${max}`);
  }
  return resolved;
}

/** Why a worker ended: out of its heap is the feed's doing; anything else is a fault to surface. */
function workerFailure(error: unknown): Error {
  if ((error as { code?: unknown } | null)?.code === 'ERR_WORKER_OUT_OF_MEMORY') {
    return new CalendarExpansionLimitError();
  }
  return new Error('slotlock: an iCalendar worker failed', { cause: error });
}

/**
 * A pool of worker threads that read untrusted iCalendar for the calling thread. Results and
 * errors are those of `parseICalendarChanges` and `parseTrustedICalendarEvents` (the same
 * `CalendarContractError` codes), plus CalendarExpansionLimitError when a worker passes its
 * deadline or its heap, ICalendarWorkerBusyError when the queue is full, and
 * ICalendarWorkerPoolClosedError after `close()`. Idle workers do not keep the process alive.
 */
export function createICalendarWorkerPool(
  options: ICalendarWorkerPoolOptions = {},
): ICalendarWorkerPool {
  const size = bounded(options.size, 2, 1, 64, 'size');
  const deadlineMs = bounded(options.deadlineMs, 3_000, 100, 60_000, 'deadlineMs');
  const maxQueue = bounded(options.maxQueue, 64, 0, 10_000, 'maxQueue');
  const maxHeapMb = bounded(options.maxHeapMb, 128, 16, 4_096, 'maxHeapMb');
  const entry = options.entry ?? new URL('./ical-worker-thread.js', import.meta.url);
  const slots = new Set<Slot>();
  const queue: Job[] = [];
  let closed = false;
  let nextId = 0;
  // Loaded on first use, so importing Slotlock never loads worker_threads where it is absent.
  let threads: Promise<typeof import('node:worker_threads')> | undefined;
  let WorkerClass: typeof Worker | undefined;

  function settle(slot: Slot, outcome: (job: Job) => void): void {
    const job = slot.job;
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = null;
    slot.job = null;
    if (job) outcome(job);
  }

  /** Take a worker out of the pool for good, failing its parse with `error`. */
  function retire(slot: Slot, error: Error): void {
    if (!slots.delete(slot)) return;
    settle(slot, (job) => job.reject(error));
    void slot.worker.terminate();
    pump();
  }

  function spawn(Constructor: typeof Worker): Slot {
    const worker = new Constructor(entry, {
      name: 'slotlock-icalendar',
      resourceLimits: {
        maxOldGenerationSizeMb: maxHeapMb,
        maxYoungGenerationSizeMb: Math.max(4, Math.floor(maxHeapMb / 8)),
        stackSizeMb: 4,
      },
    });
    const slot: Slot = { worker, job: null, id: 0, timer: null };
    worker.on('message', (reply: ICalendarWorkerReply) => {
      if (!slot.job || reply?.id !== slot.id) return;
      settle(slot, (job) => {
        if (reply.ok) job.resolve(reply.value);
        else
          job.reject(
            reply.limit ? new CalendarExpansionLimitError() : new CalendarContractError(reply.code),
          );
      });
      slot.worker.unref();
      pump();
    });
    worker.on('error', (error) => retire(slot, workerFailure(error)));
    worker.on('exit', () => retire(slot, new CalendarExpansionLimitError()));
    worker.unref();
    slots.add(slot);
    return slot;
  }

  function assign(slot: Slot, job: Job): void {
    slot.job = job;
    nextId += 1;
    slot.id = nextId;
    slot.worker.ref();
    // Past its deadline the feed is refused and its worker stopped: whatever ical.js is doing,
    // terminate() ends it, and the next parse gets a new worker.
    slot.timer = setTimeout(() => retire(slot, new CalendarExpansionLimitError()), deadlineMs);
    slot.worker.postMessage({ ...job.request, id: slot.id } satisfies ICalendarWorkerRequest);
  }

  function pump(): void {
    if (closed || !WorkerClass) return;
    while (queue.length > 0) {
      let slot: Slot | undefined;
      for (const candidate of slots) {
        if (!candidate.job) {
          slot = candidate;
          break;
        }
      }
      if (!slot) {
        if (slots.size >= size) return;
        slot = spawn(WorkerClass);
      }
      assign(slot, queue.shift() as Job);
    }
  }

  async function run(request: Job['request']): Promise<unknown> {
    if (closed) throw new ICalendarWorkerPoolClosedError();
    // The parser refuses these too; refusing here keeps them off the queue and out of the copy.
    if (
      typeof request.input !== 'string' ||
      Buffer.byteLength(request.input, 'utf8') > MAX_ICAL_INPUT_BYTES
    ) {
      throw new CalendarContractError('invalid_icalendar');
    }
    if (request.calendarTimezone !== undefined && typeof request.calendarTimezone !== 'string') {
      throw new CalendarContractError('invalid_icalendar');
    }
    if (
      request.op === 'changes' &&
      request.window !== undefined &&
      !(request.window?.start instanceof Date && request.window.end instanceof Date)
    ) {
      throw new CalendarContractError('invalid_icalendar');
    }
    threads ??= import('node:worker_threads');
    WorkerClass ??= (await threads).Worker;
    if (closed) throw new ICalendarWorkerPoolClosedError();
    // After the await: parses that arrived together resume in order, each seeing the queue as the
    // ones before it left it.
    if (queue.length >= maxQueue && !hasIdleCapacity()) throw new ICalendarWorkerBusyError();
    return new Promise((resolve, reject) => {
      queue.push({ request, resolve, reject });
      pump();
    });
  }

  function hasIdleCapacity(): boolean {
    if (slots.size < size) return true;
    for (const slot of slots) if (!slot.job) return true;
    return false;
  }

  return {
    async parseICalendarChanges(input, calendarTimezone, expansionWindow) {
      const window = expansionWindow
        ? { start: expansionWindow.start, end: expansionWindow.end }
        : undefined;
      return (await run({
        op: 'changes',
        input,
        calendarTimezone,
        window,
      })) as ExternalCalendarChange[];
    },
    async parseTrustedICalendarEvents(input, calendarTimezone) {
      return (await run({ op: 'trusted', input, calendarTimezone })) as TrustedICalendarEvent[];
    },
    async close() {
      closed = true;
      const error = new ICalendarWorkerPoolClosedError();
      for (const job of queue.splice(0)) job.reject(error);
      const ending = [...slots].map((slot) => {
        slots.delete(slot);
        settle(slot, (job) => job.reject(error));
        return slot.worker.terminate();
      });
      await Promise.all(ending);
    },
  };
}
