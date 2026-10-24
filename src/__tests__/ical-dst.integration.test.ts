// The daylight-saving corpus (helpers/dst-corpus.ts) in PostgreSQL: each stored series, and each
// feed series the trusted importer stores, is written with putCalendarEvent and occupies exactly the
// corpus's answer, and a booking into the first or last minute of any of it is refused. A case the
// engine refuses is refused by the write too, and leaves nothing behind.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { CalendarContractError, parseTrustedICalendarEvents } from '../sync.js';
import type { CalendarEventContent } from '../types.js';
import {
  CASES,
  type FeedCase,
  STORE_WINDOW,
  type Span,
  type StoreCase,
} from './helpers/dst-corpus.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const minute = (date: Date) => `${date.toISOString().slice(0, 16)}Z`;
const sorted = (spans: Span[]) => [...spans].sort((a, b) => a[0].localeCompare(b[0]));
const at = (iso: string) => new Date(iso.replace('Z', ':00Z'));

const storeCases = CASES.filter((c): c is StoreCase => c.kind === 'store');
/** Feed cases the trusted importer stores (the corpus test says which it refuses). */
const importedCases = CASES.filter((c): c is FeedCase => {
  if (c.kind !== 'feed' || c.expected === 'refuse') return false;
  try {
    parseTrustedICalendarEvents(c.ics);
    return true;
  } catch (error) {
    if (error instanceof CalendarContractError) return false;
    throw error;
  }
});

describe.skipIf(!url)('the daylight-saving corpus in PostgreSQL', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantRef = `dst-${randomUUID()}`;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    await sql.end();
  });

  /** A resource of its own for each case, so no two cases' occupation meets. */
  async function resource(): Promise<string> {
    return (
      await store.createResource({ externalRef: `van-${randomUUID()}`, tenantRef, timezone: 'UTC' })
    ).id;
  }

  async function write(resourceId: string, content: CalendarEventContent) {
    return store.putCalendarEvent({
      tenantRef,
      externalRef: `event-${randomUUID()}`,
      idempotencyKey: `put-${randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      ...content,
      ...(content.recurrence ? { materializationWindow: STORE_WINDOW } : {}),
    });
  }

  /** The store's busy time, and whether a booking into each span's first and last minute is refused. */
  async function occupied(resourceId: string, expected: Span[]) {
    const busy = sorted(
      (await store.listBusy(resourceId, STORE_WINDOW)).map(
        (interval): Span => [minute(interval.start), minute(interval.end)],
      ),
    );
    const bookable: string[] = [];
    for (const [from, to] of expected) {
      const first = at(from);
      const last = new Date(at(to).getTime() - 60_000);
      for (const start of [first, last]) {
        const booking = await store.createReservation({
          resourceId,
          start,
          end: new Date(start.getTime() + 60_000),
        });
        if (booking.ok || booking.code !== 'overlap') bookable.push(start.toISOString());
      }
    }
    return { busy, bookable };
  }

  it.each(storeCases.map((c) => [c.id, c] as const))('%s', async (_id, c) => {
    const resourceId = await resource();
    const content: CalendarEventContent = {
      start: new Date(c.content.start),
      end: new Date(c.content.end),
      timezone: c.content.timezone,
      summary: 'corpus',
    };
    if (c.content.rrule) {
      content.recurrence = { rrule: c.content.rrule };
      if (c.content.exceptions) {
        content.recurrence.exceptions = c.content.exceptions.map((exception) => ({
          recurrenceId: new Date(exception.recurrenceId),
          ...(exception.cancelled ? { cancelled: true } : {}),
          ...(exception.start ? { start: new Date(exception.start) } : {}),
          ...(exception.end ? { end: new Date(exception.end) } : {}),
        }));
      }
    }
    const written = await write(resourceId, content);
    if (c.expected === 'refuse') {
      expect(written).toMatchObject({ ok: false });
      expect(await store.listBusy(resourceId, STORE_WINDOW)).toEqual([]);
      return;
    }
    expect(written).toMatchObject({ ok: true });
    expect(await occupied(resourceId, c.expected)).toEqual({
      busy: sorted(c.expected),
      bookable: [],
    });
  });

  it.each(importedCases.map((c) => [c.id, c] as const))(
    'imported and stored: %s',
    async (_id, c) => {
      const resourceId = await resource();
      for (const event of parseTrustedICalendarEvents(c.ics)) {
        if (event.status === 'cancelled') continue;
        const content: CalendarEventContent = {
          start: event.start,
          end: event.end,
          timezone: event.timezone,
          summary: event.summary,
        };
        if (event.status) content.status = event.status;
        if (event.transparency) content.transparency = event.transparency;
        if (event.recurrence) content.recurrence = event.recurrence;
        expect(await write(resourceId, content)).toMatchObject({ ok: true });
      }
      const expected = c.expected as Span[];
      expect(await occupied(resourceId, expected)).toEqual({
        busy: sorted(expected),
        bookable: [],
      });
    },
  );

  it('stores most of the corpus, so the comparison above is not vacuous', () => {
    expect(storeCases.length).toBeGreaterThanOrEqual(10);
    expect(importedCases.length).toBeGreaterThanOrEqual(20);
  });
});
