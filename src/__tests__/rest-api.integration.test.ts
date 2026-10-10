// The REST API on the real store backend and PostgreSQL: a tenant reads and writes its own calendar
// and gets 404 for another tenant's, as over MCP and A2A.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockAgentServer } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const BASE = 'http://localhost/slotlock';

describe.skipIf(!url)('the REST API on the real store', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantA = `rest-a-${randomUUID()}`;
  const tenantB = `rest-b-${randomUUID()}`;
  const refA = `vehicle-a-${randomUUID().slice(0, 8)}`;
  let resourceA: string;

  const server = () =>
    createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] }),
      authenticate: async (request) => {
        const token = request.headers.get('authorization');
        if (token === 'Bearer a') return { subject: 'principal-a', tenantRef: tenantA };
        if (token === 'Bearer b') return { subject: 'principal-b', tenantRef: tenantB };
        return null;
      },
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
    });

  const call = (who: 'a' | 'b', method: string, path: string, body?: unknown) =>
    server().fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${who}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  const day = (offset: number, time = '00:00:00') =>
    `${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T${time}Z`;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => undefined });
    store = createSlotlockStore(sql);
    await store.applySchema();
    resourceA = (
      await store.createResource({ tenantRef: tenantA, externalRef: refA, timezone: 'UTC' })
    ).id;
  });

  afterAll(async () => {
    for (const tenant of [tenantA, tenantB]) {
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_event_occurrences WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_coverage WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.reservations WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenant}`;
    }
    await sql.end();
  });

  it('books, reads, moves and deletes in one tenant, and shows another tenant none of it', async () => {
    const created = await call('a', 'POST', '/v1/events', {
      resource_id: resourceA,
      starts_at: day(4, '09:00:00'),
      ends_at: day(4, '10:00:00'),
      timezone: 'UTC',
      title: 'Handover',
      idempotency_key: `rest-${randomUUID()}`,
    });
    expect(created.status).toBe(200);
    const { event } = (await created.json()) as { event: { id: string; revision: number } };
    const path = `/v1/events/${encodeURIComponent(event.id)}`;

    const overlap = await call('a', 'POST', '/v1/events', {
      resource_id: resourceA,
      starts_at: day(4, '09:30:00'),
      ends_at: day(4, '10:30:00'),
      timezone: 'UTC',
      idempotency_key: `rest-${randomUUID()}`,
    });
    expect(overlap.status).toBe(409);
    expect(await overlap.json()).toMatchObject({ error: { code: expect.any(String) } });

    expect((await call('a', 'GET', path)).status).toBe(200);
    const listed = await call('a', 'GET', '/v1/resources');
    expect(((await listed.json()) as { resources: { id: string }[] }).resources).toEqual([
      { id: resourceA, external_ref: refA, timezone: 'UTC' },
    ]);

    const elsewhere = await call('b', 'GET', '/v1/resources');
    expect(await elsewhere.json()).toEqual({ resources: [], next_cursor: null });
    expect((await call('b', 'GET', path)).status).toBe(404);
    const moved = await call('b', 'PATCH', path, {
      expected_revision: event.revision,
      title: 'Taken',
      idempotency_key: `steal-${randomUUID()}`,
    });
    expect(moved.status).toBe(404);
    const removed = await call(
      'b',
      'DELETE',
      `${path}?expected_revision=${event.revision}&idempotency_key=steal-${randomUUID()}`,
    );
    expect(removed.status).toBe(404);

    const changed = await call('a', 'PATCH', path, {
      expected_revision: event.revision,
      starts_at: day(5, '09:00:00'),
      ends_at: day(5, '10:00:00'),
      idempotency_key: `move-${randomUUID()}`,
    });
    expect(changed.status).toBe(200);
    const after = ((await changed.json()) as { event: { revision: number; starts_at: string } })
      .event;
    expect(Date.parse(after.starts_at)).toBe(Date.parse(day(5, '09:00:00')));
    const deleted = await call(
      'a',
      'DELETE',
      `${path}?expected_revision=${after.revision}&idempotency_key=delete-${randomUUID()}`,
    );
    expect(deleted.status).toBe(200);
    expect((await call('a', 'GET', path)).status).toBe(404);
  });
});
