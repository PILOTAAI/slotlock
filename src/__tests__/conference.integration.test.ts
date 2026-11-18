// Meeting links on events (RFC 0007 3.1) against real Postgres: kept with the event's revision,
// replayed, kept or removed by an update, shared by a bundle, and bounded by the table itself.
// Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SlotlockAgentInvocationContext } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;
const LINK = 'https://meet.example.com/abc-defg-hij';
const EVERY_DAY: WeeklyAvailabilityRule[] = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 24 * 60 },
];

interface ToolEvent {
  id: string;
  revision: number;
  location: string | null;
  conference: { requested: string; provider: string; status: string; join_url: string } | null;
}

describe.skipIf(!url)('meeting links on events (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let backend: ReturnType<typeof createSlotlockStoreAgentBackend>;
  let resourceId: string;
  const tenantRef = `conference-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 5, 1, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR).toISOString();
  const context = (operation: string): SlotlockAgentInvocationContext => ({
    principal: { subject: 'conference-agent', tenantRef },
    operation: operation as SlotlockAgentInvocationContext['operation'],
    signal: new AbortController().signal,
  });
  const create = async (hour: number, extra: Record<string, unknown>, key = `c-${randomUUID()}`) =>
    (
      (await backend.createEvent(context('slotlock_create_event'), {
        resource_id: resourceId,
        starts_at: at(hour),
        ends_at: at(hour + 1),
        timezone: 'UTC',
        title: 'Handover call',
        transparency: 'opaque',
        status: 'confirmed',
        idempotency_key: key,
        ...extra,
      })) as { event: ToolEvent; replayed: boolean }
    );
  const update = async (event: ToolEvent, extra: Record<string, unknown>) =>
    (
      (await backend.updateEvent(context('slotlock_update_event'), {
        event_id: event.id,
        expected_revision: event.revision,
        idempotency_key: `u-${randomUUID()}`,
        ...extra,
      })) as { event: ToolEvent }
    ).event;
  const ready = (joinUrl: string) => ({
    requested: 'user_supplied',
    provider: 'user_supplied',
    status: 'ready',
    join_url: joinUrl,
  });

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    backend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => EVERY_DAY });
    resourceId = (await store.createResource({ tenantRef, externalRef: `r-${randomUUID()}`, timezone: 'UTC' })).id;
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('keeps the link with the event, replays it, and refuses the same key with another link', async () => {
    const key = `c-${randomUUID()}`;
    const first = await create(1, { conference_url: 'https://Meet.Example.com/abc-defg-hij' }, key);
    expect(first.event.conference).toEqual(ready(LINK));
    const [row] = await sql<{ conference: string; conference_url: string }[]>`
      SELECT conference, conference_url FROM slotlock.calendar_events
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${first.event.id}`;
    expect(row).toEqual({ conference: 'user_supplied', conference_url: LINK });

    const again = await create(1, { conference_url: 'https://Meet.Example.com/abc-defg-hij' }, key);
    expect(again).toEqual({ event: first.event, replayed: true });
    await expect(create(1, { conference_url: `${LINK}-x` }, key)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    });
    // A link is content: the same key without one is another request.
    await expect(create(1, {}, key)).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const read = (await backend.getEvent(context('slotlock_get_event'), { event_id: first.event.id })) as {
      event: ToolEvent;
    };
    expect(read.event.conference).toEqual(ready(LINK));
  });

  it('answers an event without a link with null, as before links', async () => {
    const plain = await create(3, {});
    expect(plain.event.conference).toBeNull();
    const none = await create(4, { conference: 'none' });
    expect(none.event.conference).toBeNull();
  });

  it('keeps the link through an update that names none, replaces it, and removes it with none', async () => {
    const { event } = await create(5, { conference_url: LINK, location: 'Depot 7' });
    const moved = await update(event, { starts_at: at(6), ends_at: at(7) });
    expect(moved.conference).toEqual(ready(LINK));
    const renamed = await update(moved, { location: null });
    expect([renamed.location, renamed.conference]).toEqual([null, ready(LINK)]);
    const replaced = await update(renamed, { conference_url: 'https://other.example/room' });
    expect(replaced.conference).toEqual(ready('https://other.example/room'));
    const removed = await update(replaced, { conference: 'none' });
    expect(removed.conference).toBeNull();
    const [row] = await sql<{ conference: string | null; conference_url: string | null }[]>`
      SELECT conference, conference_url FROM slotlock.calendar_events
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${event.id}`;
    expect(row).toEqual({ conference: null, conference_url: null });
  });

  it('refuses a link the store would not keep as invalid_event, and books nothing', async () => {
    for (const bad of [
      'https://user:secret@meet.example.com/abc',
      'https://meet.example.com/a\rMETHOD:CANCEL',
      'http://meet.example.com/abc',
    ]) {
      await expect(create(8, { conference_url: bad })).rejects.toMatchObject({ code: 'invalid_event', status: 400 });
    }
    await expect(create(8, { conference: 'user_supplied' })).rejects.toMatchObject({ code: 'invalid_event' });
    await expect(create(8, { conference: 'none', conference_url: LINK })).rejects.toMatchObject({
      code: 'invalid_event',
    });
    const rows = await sql`
      SELECT 1 FROM slotlock.calendar_events
       WHERE tenant_ref = ${tenantRef} AND starts_at = ${at(8)}`;
    expect(rows).toHaveLength(0);
  });

  it('gives every event booked together the same link', async () => {
    const other = (await store.createResource({ tenantRef, externalRef: `r-${randomUUID()}`, timezone: 'UTC' })).id;
    const booked = (await backend.bookTogether?.(context('slotlock_book_together'), {
      resource_ids: [resourceId, other],
      starts_at: at(10),
      ends_at: at(11),
      timezone: 'UTC',
      title: 'Handover with driver',
      idempotency_key: `b-${randomUUID()}`,
      conference_url: LINK,
    })) as { events: ToolEvent[] };
    expect(booked.events.map((event) => event.conference)).toEqual([ready(LINK), ready(LINK)]);
  });

  it('is bounded by the table: https, a provider name, and a link only with a provider', async () => {
    const { event } = await create(12, {});
    const write = (conference: string | null, link: string | null) =>
      sql`UPDATE slotlock.calendar_events SET conference = ${conference}, conference_url = ${link}
           WHERE tenant_ref = ${tenantRef} AND external_ref = ${event.id}`;
    for (const [conference, link] of [
      ['user_supplied', 'http://meet.example.com/abc'],
      ['user_supplied', `https://meet.example.com/${'a'.repeat(2_048)}`],
      [null, LINK],
      ['User Supplied', LINK],
    ] as const) {
      await expect(write(conference, link), `${conference} ${link.slice(0, 40)}`).rejects.toMatchObject({
        code: '23514',
      });
    }
    await write('user_supplied', LINK);
  });
});
