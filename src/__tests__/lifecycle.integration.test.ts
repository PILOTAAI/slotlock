// The booking lifecycle against the store (RFC 0004 B4, B5): each move writes the change the table
// says and refuses as it says; tombstones keep why a booking ended; maintenance says when one ends;
// cancel and reschedule cutoffs refuse writes past them unless an admin gives a reason, and a late
// cancellation records its fee. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type SlotlockAgentPrincipal,
  createSlotlockAgentServer,
  invokeSlotlockAgentOperation,
} from '../agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { slotlockBookingNext } from '../lifecycle.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const ALL_DAY = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 1_440 }];

describe.skipIf(!url)('the booking lifecycle (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  let agentBackend: ReturnType<typeof createSlotlockStoreAgentBackend>;
  const tenantRef = `lifecycle-${randomUUID()}`;
  const principals: Record<string, SlotlockAgentPrincipal> = {
    admin: { subject: 'person-admin', tenantRef, scopes: ['read', 'write', 'admin'] },
  };
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: 'Bearer admin', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const agent = (operation: string, input: Record<string, unknown>) =>
    invokeSlotlockAgentOperation({
      operation: operation as never,
      input,
      request: new Request(BASE),
      options: {
        backend: agentBackend,
        authenticate: async () => ({ subject: 'agent-a', tenantRef, scopes: ['read', 'write'] }),
        authorize: async () => true,
      },
    }) as Promise<{ ok: boolean; code?: string; data?: Record<string, unknown> }>;
  const changes = async (subject: string) =>
    (
      await sql<{ type: string; data: Record<string, unknown> }[]>`
        SELECT type, data FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} AND subject = ${subject} ORDER BY id`
    ).map((row) => row.type);
  const resource = async (ref: string) =>
    (await store.withTenant(tenantRef, (tenant) => tenant.createResource({ tenantRef, externalRef: ref, timezone: 'UTC' }))).id;
  const reserve = (resourceId: string, ref: string, start: number, end: number, revision = 1, overrideReason?: string) =>
    store.withTenant(tenantRef, (tenant) =>
      (revision === 1 ? tenant.createExternalReservation : tenant.rescheduleExternalReservation)({
        tenantRef,
        externalRef: ref,
        resourceId,
        start: new Date(start),
        end: new Date(end),
        bufferAfterMs: 0,
        revision,
        ...(overrideReason ? { overrideReason } : {}),
      }),
    );
  const tombstone = async (ref: string) =>
    (
      await sql<{ end_reason: string; cancellation_fee: unknown; override_reason: string | null }[]>`
        SELECT end_reason, cancellation_fee, override_reason FROM slotlock.reservation_tombstones
         WHERE tenant_ref = ${tenantRef} AND external_ref = ${ref}`
    )[0];

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql, { defaultAvailabilityRules: ALL_DAY });
    await store.applySchema();
    agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => ALL_DAY });
    server = createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: agentBackend,
      authenticate: async (request) => principals[request.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
      application: {
        backend: createSlotlockStoreApplicationBackend(store, { agentBackend }),
        authorize: async ({ principal }) => principal.scopes?.includes('admin') === true,
      },
    });
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('moves a booking as the table says, writing its changes, and keeps why it ended', async () => {
    const room = await resource('room-1');
    const start = Date.now() + 2 * HOUR;
    expect(await reserve(room, 'bk-1', start, start + HOUR)).toMatchObject({ ok: true });
    expect(await reserve(room, 'bk-1', start + HOUR, start + 2 * HOUR, 2)).toMatchObject({ ok: true });
    const moved = slotlockBookingNext('confirmed', 'reschedule');
    expect(await changes('bk-1')).toEqual(['reservation.created', ...(moved.ok ? moved.changes : [])]);
    const cancelled = await store.withTenant(tenantRef, (tenant) =>
      tenant.cancelExternalReservation({ tenantRef, externalRef: 'bk-1', revision: 3 }),
    );
    expect(cancelled).toEqual({ ok: true, cancelled: true, revision: 3 });
    expect((await changes('bk-1')).at(-1)).toBe('reservation.cancelled');
    expect(await tombstone('bk-1')).toEqual({ end_reason: 'cancelled', cancellation_fee: null, override_reason: null });
    // The table's refusals for a cancelled booking, as the store answers them.
    expect(await reserve(room, 'bk-1', start, start + HOUR, 4)).toMatchObject({
      ok: false,
      code: slotlockBookingNext('cancelled', 'reschedule').ok ? 'unexpected' : 'reservation_cancelled',
    });
    expect(
      await store.withTenant(tenantRef, (tenant) => tenant.checkInReservation({ tenantRef, externalRef: 'bk-1' })),
    ).toMatchObject({ ok: false, code: 'reservation_not_found' });
  });

  it('says on the feed once that a booking ended, and refuses to check it in', async () => {
    const desk = await resource('desk-1');
    const ended = Date.now() - HOUR;
    expect(await reserve(desk, 'bk-past', ended - HOUR, ended)).toMatchObject({ ok: true });
    const first = await store.withTenant(tenantRef, (tenant) => tenant.completeEndedBookings({ tenantRef }));
    expect(first).toBeGreaterThanOrEqual(1);
    expect(await store.withTenant(tenantRef, (tenant) => tenant.completeEndedBookings({ tenantRef }))).toBe(0);
    expect(await changes('bk-past')).toEqual(['reservation.created', 'reservation.completed']);
    expect(
      await store.withTenant(tenantRef, (tenant) => tenant.checkInReservation({ tenantRef, externalRef: 'bk-past' })),
    ).toMatchObject({ ok: false, code: slotlockBookingNext('completed', 'check_in').ok ? 'unexpected' : 'reservation_ended' });
    // Maintenance reports them.
    expect((await call('POST', '/v1/maintenance', {})).body).toMatchObject({ bookings_completed: 0 });
  });

  it('releases a no-show and keeps that as its end', async () => {
    const bay = await resource('bay-1');
    await store.withTenant(tenantRef, (tenant) => tenant.setResourceBookingRules({ tenantRef, id: bay, rules: { checkInMinutes: 1 } }));
    const started = Date.now() - 10 * MINUTE;
    expect(await reserve(bay, 'bk-walkout', started, started + 2 * HOUR)).toMatchObject({ ok: true });
    // Made now, after its start: its window runs from when it was made.
    await sql`UPDATE slotlock.resources SET check_in_since = check_in_since - interval '10 minutes' WHERE id = ${bay}`;
    await sql`UPDATE slotlock.reservations SET created_at = created_at - interval '5 minutes'
               WHERE tenant_ref = ${tenantRef} AND external_ref = 'bk-walkout'`;
    expect(await store.withTenant(tenantRef, (tenant) => tenant.releaseNoShows({ tenantRef }))).toBe(1);
    expect((await changes('bk-walkout')).at(-1)).toBe('reservation.no_show');
    expect((await tombstone('bk-walkout'))?.end_reason).toBe('no_show');
  });

  it('refuses cancels and moves past their cutoffs unless an admin says why, and records the fee', async () => {
    const van = await resource('van-1');
    expect(
      (
        await call('PUT', `/v1/resources/${van}/booking-rules`, {
          rules: {
            cancel_cutoff_minutes: 60,
            reschedule_cutoff_minutes: 60,
            cancellation_fee: { amount_minor: 2_500, currency: 'EUR', within_minutes: 1_440 },
          },
        })
      ).status,
    ).toBe(200);
    const soon = Date.now() + 30 * MINUTE;
    expect(await reserve(van, 'bk-soon', soon, soon + HOUR)).toMatchObject({ ok: true });
    expect(await reserve(van, 'bk-soon', soon + HOUR, soon + 2 * HOUR, 2)).toMatchObject({
      ok: false,
      code: 'booking_rule_violated',
      rule: 'reschedule_cutoff',
    });
    // Moved, with a reason, to ten minutes later: still inside the cancel cutoff.
    expect(await reserve(van, 'bk-soon', soon + 10 * MINUTE, soon + HOUR, 2, 'Customer asked by phone')).toMatchObject({
      ok: true,
    });
    const refused = await call('DELETE', '/v1/reservations/bk-soon?revision=3');
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'booking_rule_cancel_cutoff' } } });
    const overridden = await call('DELETE', `/v1/reservations/bk-soon?revision=3&override_reason=${encodeURIComponent('Vehicle broke down')}`);
    expect(overridden.body).toEqual({
      cancelled: true,
      revision: 3,
      cancellation_fee: { amount_minor: 2_500, currency: 'EUR' },
    });
    expect(await tombstone('bk-soon')).toEqual({
      end_reason: 'cancelled',
      cancellation_fee: { amount_minor: 2_500, currency: 'EUR' },
      override_reason: 'Vehicle broke down',
    });
    const [cancelledChange] = await sql<{ data: Record<string, unknown> }[]>`
      SELECT data FROM slotlock.outbox
       WHERE tenant_ref = ${tenantRef} AND subject = 'bk-soon' AND type = 'reservation.cancelled'`;
    expect(cancelledChange?.data).toMatchObject({
      cancellation_fee: { amount_minor: 2_500, currency: 'EUR' },
      override_reason: 'Vehicle broke down',
    });
    // The reschedule's reason is on its change too.
    const [movedChange] = await sql<{ data: Record<string, unknown> }[]>`
      SELECT data FROM slotlock.outbox
       WHERE tenant_ref = ${tenantRef} AND subject = 'bk-soon' AND type = 'reservation.rescheduled'`;
    expect(movedChange?.data).toMatchObject({ override_reason: 'Customer asked by phone' });

    // An agent is held to the cutoff, with no override; an admin cancels with a reason.
    const event = await agent('slotlock_create_event', {
      resource_id: van,
      starts_at: new Date(soon + 3 * HOUR - (soon % MINUTE)).toISOString(),
      ends_at: new Date(soon + 4 * HOUR - (soon % MINUTE)).toISOString(),
      timezone: 'UTC',
      idempotency_key: 'late',
    });
    expect(event.ok).toBe(true);
    const created = event.data?.event as { id: string; revision: number };
    // Three hours ahead is outside the hour's cutoff: an agent may cancel it. A closer one may not.
    const close = await agent('slotlock_create_event', {
      resource_id: van,
      // Forty minutes ahead: inside the hour's cutoff.
      starts_at: new Date(soon + 10 * MINUTE - (soon % MINUTE)).toISOString(),
      ends_at: new Date(soon + 40 * MINUTE - (soon % MINUTE)).toISOString(),
      timezone: 'UTC',
      idempotency_key: 'close',
    });
    expect(close.ok).toBe(true);
    const closeEvent = close.data?.event as { id: string; revision: number };
    expect(
      await agent('slotlock_delete_event', { event_id: closeEvent.id, expected_revision: closeEvent.revision, idempotency_key: 'd1' }),
    ).toMatchObject({ ok: false, code: 'booking_rule_cancel_cutoff' });
    expect(
      await agent('slotlock_delete_event', { event_id: created.id, expected_revision: created.revision, idempotency_key: 'd2' }),
    ).toMatchObject({ ok: true });
  });
});
