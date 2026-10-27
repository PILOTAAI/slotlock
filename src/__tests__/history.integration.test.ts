// History against real Postgres: each change to a booking or event is recorded with who made it
// (the API key or agent) and what it was before, and read per resource or per record, newest
// first. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;

interface Entry {
  id: string;
  type: string;
  actor: string | null;
  data: Record<string, unknown> & { before?: Record<string, unknown> };
}

describe.skipIf(!url)('history (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantRef = `history-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 7, 1, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR).toISOString();
  const as = (subject: string) => ({
    principal: { subject, tenantRef, scopes: ['admin'] },
    operation: 'slotlock_get_resource_history' as never,
    signal: new AbortController().signal,
  });

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('records who booked, moved and cancelled, and what it was before, newest first', async () => {
    const app = createSlotlockStoreApplicationBackend(store);
    const { resource } = (await app.createResource(as('api_key:site'), { external_ref: 'van', timezone: 'UTC' })) as {
      resource: { id: string };
    };
    const put = (subject: string, start: number, revision: number) =>
      app.putReservation(as(subject), {
        reservation_ref: 'BK-7',
        resource_id: resource.id,
        start: at(start),
        end: at(start + 1),
        buffer_after_minutes: 0,
        revision,
      });
    await put('api_key:site', 1, 1);
    await put('api_key:desk', 3, 2);
    await app.cancelReservation(as('api_key:desk'), { reservation_ref: 'BK-7', revision: 3 });

    const { history } = (await app.getReservationHistory(as('api_key:auditor'), { reservation_ref: 'BK-7', limit: 50 })) as {
      history: Entry[];
    };
    expect(history.map(({ type, actor }) => [type, actor])).toEqual([
      ['reservation.cancelled', 'api_key:desk'],
      ['reservation.updated', 'api_key:desk'],
      ['reservation.created', 'api_key:site'],
    ]);
    expect(history[1]?.data).toMatchObject({ start: expect.any(String), before: { revision: 1 } });
    expect(Date.parse(history[1]?.data.before?.start as string)).toBe(Date.parse(at(1)));

    // The resource's history has the same, and pages by `before`.
    const first = (await app.getResourceHistory(as('api_key:auditor'), { resource_id: resource.id, limit: 2 })) as {
      history: Entry[];
      next_before: string | null;
    };
    expect(first.history).toHaveLength(2);
    expect(first.next_before).toBe(first.history[1]?.id);
    const rest = (await app.getResourceHistory(as('api_key:auditor'), {
      resource_id: resource.id,
      limit: 2,
      before: first.next_before,
    })) as { history: Entry[] };
    expect(rest.history.map(({ type }) => type)).toEqual(['reservation.created']);
  });

  it("records an event's update and cancel by the key that made them", async () => {
    const resource = await store.createResource({ tenantRef, externalRef: `room-${randomUUID()}`, timezone: 'UTC' });
    const write = (actor: string, revision: number, start: number) =>
      store.withTenant(
        tenantRef,
        (tenant) =>
          tenant.putCalendarEvent({
            tenantRef,
            externalRef: 'ev-history',
            resourceId: resource.id,
            expectedRevision: revision,
            idempotencyKey: `ev-${revision}`,
            start: new Date(at(start)),
            end: new Date(at(start + 1)),
            timezone: 'UTC',
            summary: 'Standup',
          }),
        { actor },
      );
    const created = await write('api_key:one', 0, 10);
    if (!created.ok) throw new Error(created.code);
    await write('api_key:two', 1, 12);
    const event = await store.getCalendarEvent({ tenantRef, externalRef: 'ev-history' });
    await store.withTenant(
      tenantRef,
      (tenant) =>
        tenant.cancelCalendarEvent({ tenantRef, externalRef: 'ev-history', idempotencyKey: 'ev-cancel', expectedRevision: 2 }),
      { actor: 'api_key:two' },
    );
    const history = await store.listHistory({ tenantRef, subject: event?.id as string });
    expect(history.map(({ type, actor }) => [type, actor])).toEqual([
      ['event.cancelled', 'api_key:two'],
      ['event.updated', 'api_key:two'],
      ['event.created', 'api_key:one'],
    ]);
    // No titles in history either.
    expect(JSON.stringify(history)).not.toContain('Standup');
    await expect(store.withTenant(tenantRef, async () => 1, { actor: 'bad\nactor' })).rejects.toMatchObject({
      code: 'invalid_identity',
    });
  });
});
