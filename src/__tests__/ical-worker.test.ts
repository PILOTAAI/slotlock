// createICalendarWorkerPool reads untrusted iCalendar on worker threads, so a feed that holds
// ical.js holds a worker, never the thread that asked. These tests run the pool against a stand-in
// worker (the real one is built JavaScript; verify-package runs it against real feeds): one that
// hangs as ical.js would, runs out of its heap, sleeps, or replies as the parsers do.
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ICalendarWorkerPool,
  type ICalendarWorkerPoolOptions,
  ICalendarWorkerBusyError,
  ICalendarWorkerPoolClosedError,
  createICalendarWorkerPool,
} from '../ical-worker.js';
import {
  CalendarContractError,
  CalendarExpansionLimitError,
  parseICalendarChanges,
} from '../sync.js';

const standIn = new URL('./helpers/icalendar-worker-stand-in.mjs', import.meta.url);
const open: ICalendarWorkerPool[] = [];
function pool(options: ICalendarWorkerPoolOptions = {}): ICalendarWorkerPool {
  const created = createICalendarWorkerPool({ entry: standIn, ...options });
  open.push(created);
  return created;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((created) => created.close()));
});

/** Run `work`, counting how often a 10 ms timer on this thread fires meanwhile. */
async function ticking<T>(
  work: () => Promise<T> | T,
): Promise<{ ticks: number; ms: number; outcome: unknown }> {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 10);
  const started = performance.now();
  let outcome: unknown;
  try {
    outcome = await work();
  } catch (error) {
    outcome = error;
  }
  const ms = performance.now() - started;
  clearInterval(timer);
  return { ticks, ms, outcome };
}

describe('reading iCalendar on worker threads', () => {
  it('keeps this thread free while a feed holds its worker, and refuses the feed at the deadline', async () => {
    const workers = pool({ deadlineMs: 500 });
    const { ticks, ms, outcome } = await ticking(() => workers.parseICalendarChanges('hang'));
    expect(outcome).toBeInstanceOf(CalendarExpansionLimitError);
    expect(ms).toBeGreaterThanOrEqual(490);
    expect(ms).toBeLessThan(3_000);
    // The timer kept firing the whole time the worker was held.
    expect(ticks).toBeGreaterThanOrEqual(20);
  });

  it('where a parse on this thread holds every timer until it ends', async () => {
    // What the pool avoids: one of the slow feeds the parser stops at its one-second limit.
    const slowZone = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Slotlock tests//EN',
      'BEGIN:VTIMEZONE',
      'TZID:Custom/Slow',
      'BEGIN:STANDARD',
      'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0100',
      'TZOFFSETTO:+0100',
      'RRULE:FREQ=DAILY;INTERVAL=36600;BYMONTH=2;BYMONTHDAY=30',
      'END:STANDARD',
      'END:VTIMEZONE',
      'BEGIN:VEVENT',
      'UID:slow',
      'DTSTAMP:20261010T000000Z',
      'DTSTART;TZID=Custom/Slow:20261102T090000',
      'DTEND;TZID=Custom/Slow:20261102T100000',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const { ticks, ms, outcome } = await ticking(() => parseICalendarChanges(slowZone, 'UTC'));
    expect(outcome).toBeInstanceOf(CalendarExpansionLimitError);
    expect(ms).toBeGreaterThanOrEqual(900);
    expect(ticks).toBe(0);
  });

  it('starts a new worker for the next feed after stopping one', async () => {
    const workers = pool({ deadlineMs: 200, size: 1 });
    await expect(workers.parseICalendarChanges('hang')).rejects.toBeInstanceOf(
      CalendarExpansionLimitError,
    );
    await expect(workers.parseICalendarChanges('next')).resolves.toMatchObject({
      echo: { op: 'changes', input: 'next' },
    });
  });

  it('ends a worker that runs out of its heap, and only that worker', async () => {
    const workers = pool({ maxHeapMb: 32, deadlineMs: 30_000 });
    await expect(workers.parseICalendarChanges('memory')).rejects.toBeInstanceOf(
      CalendarExpansionLimitError,
    );
    await expect(workers.parseTrustedICalendarEvents('after')).resolves.toMatchObject({
      echo: { op: 'trusted', input: 'after' },
    });
  });

  it('passes the feed, its zone and its window as given', async () => {
    const window = {
      start: new Date('2026-10-01T00:00:00Z'),
      end: new Date('2027-10-01T00:00:00Z'),
    };
    const reply = (await pool().parseICalendarChanges(
      'feed',
      'Europe/London',
      window,
    )) as unknown as {
      echo: {
        op: string;
        input: string;
        calendarTimezone: string;
        window: { start: Date; end: Date };
      };
    };
    expect(reply.echo).toMatchObject({
      op: 'changes',
      input: 'feed',
      calendarTimezone: 'Europe/London',
    });
    expect(reply.echo.window.start).toEqual(window.start);
    expect(reply.echo.window.end).toEqual(window.end);
  });

  it("gives the parsers' own refusals back as the same errors", async () => {
    const workers = pool();
    await expect(workers.parseICalendarChanges('limit')).rejects.toBeInstanceOf(
      CalendarExpansionLimitError,
    );
    const interval = await workers
      .parseICalendarChanges('interval')
      .catch((error: unknown) => error);
    expect(interval).toBeInstanceOf(CalendarContractError);
    expect(interval).not.toBeInstanceOf(CalendarExpansionLimitError);
    expect(interval).toMatchObject({ code: 'invalid_external_interval' });
  });

  it('reports a fault in a worker as a fault, not as a refused feed', async () => {
    const fault = await pool()
      .parseICalendarChanges('fault')
      .catch((error: unknown) => error);
    expect(fault).toBeInstanceOf(Error);
    expect(fault).not.toBeInstanceOf(CalendarContractError);
    expect((fault as Error).message).toBe('slotlock: an iCalendar worker failed');
  });

  it('fails clearly when its worker cannot start', async () => {
    const missing = createICalendarWorkerPool({
      entry: new URL('./helpers/no-such-worker.mjs', import.meta.url),
    });
    open.push(missing);
    const failure = await missing.parseICalendarChanges('feed').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(CalendarContractError);
  });

  it('queues past its size, and refuses at once when the queue is full', async () => {
    const workers = pool({ size: 1, maxQueue: 1 });
    const running = workers.parseICalendarChanges('sleep:300');
    const waiting = workers.parseICalendarChanges('sleep:10');
    const started = performance.now();
    await expect(workers.parseICalendarChanges('third')).rejects.toBeInstanceOf(
      ICalendarWorkerBusyError,
    );
    expect(performance.now() - started).toBeLessThan(200);
    await expect(running).resolves.toBe('slept');
    await expect(waiting).resolves.toBe('slept');
  });

  it('refuses a feed over the size limit without sending it to a worker', async () => {
    const missing = createICalendarWorkerPool({
      entry: new URL('./helpers/no-such-worker.mjs', import.meta.url),
    });
    open.push(missing);
    const refused = await missing
      .parseICalendarChanges('a'.repeat(2_000_001))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CalendarContractError);
    expect(refused).toMatchObject({ code: 'invalid_icalendar' });
  });

  it('refuses a window that is not two dates without sending it', async () => {
    const workers = pool();
    await expect(
      workers.parseICalendarChanges('feed', 'UTC', { start: 'soon', end: 'later' } as never),
    ).rejects.toMatchObject({ code: 'invalid_icalendar' });
  });

  it('refuses what waits, and everything after, once closed', async () => {
    const workers = createICalendarWorkerPool({ entry: standIn, size: 1 });
    const running = workers.parseICalendarChanges('sleep:500').catch((error: unknown) => error);
    const waiting = workers.parseICalendarChanges('sleep:10').catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await workers.close();
    expect(await running).toBeInstanceOf(ICalendarWorkerPoolClosedError);
    expect(await waiting).toBeInstanceOf(ICalendarWorkerPoolClosedError);
    await expect(workers.parseICalendarChanges('later')).rejects.toBeInstanceOf(
      ICalendarWorkerPoolClosedError,
    );
  });

  it.each<[string, ICalendarWorkerPoolOptions]>([
    ['no workers', { size: 0 }],
    ['a deadline under 100 ms', { deadlineMs: 50 }],
    ['a fractional queue', { maxQueue: 1.5 }],
    ['a heap under 16 MB', { maxHeapMb: 8 }],
  ])('refuses options for %s', (_name, options) => {
    expect(() => createICalendarWorkerPool({ entry: standIn, ...options })).toThrow(RangeError);
  });
});
