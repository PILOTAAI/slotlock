// slotlock_get_invitation against real Postgres (RFC 0007 4.1): the invitation names nothing the
// store keeps internally, its SEQUENCE follows the event's revision, and a cancellation read before
// slotlock_cancel carries the revision cancelling writes. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import ICAL from 'ical.js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockAgentServer } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'https://calendar.example.com';
const EVERY_DAY: WeeklyAvailabilityRule[] = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 24 * 60 },
];

describe.skipIf(!url)('slotlock_get_invitation (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  let resourceId: string;
  const tenantRef = `invitation-${randomUUID()}`;
  const start = Date.UTC(new Date().getUTCFullYear() + 1, 6, 1, 9);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: 'Bearer agent',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    resourceId = (await store.createResource({ tenantRef, externalRef: `r-${randomUUID()}`, timezone: 'UTC' })).id;
    server = createSlotlockAgentServer({
      publicBaseUrl: BASE,
      backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => EVERY_DAY }),
      authenticate: async (request) =>
        request.headers.get('authorization') === 'Bearer agent' ? { subject: 'invitation-agent', tenantRef } : null,
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
    });
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('names nothing the store keeps, follows the revision, and cancels at the revision cancelling writes', async () => {
    const created = await call('POST', '/v1/events', {
      resource_id: resourceId,
      starts_at: new Date(start).toISOString(),
      ends_at: new Date(start + 3_600_000).toISOString(),
      timezone: 'UTC',
      title: 'Handover call',
      organizer: { address: 'ana@example.com', name: 'Ana' },
      attendees: [{ address: 'ben@example.com', role: 'required', participation_status: 'needs_action', rsvp: true }],
      conference_url: 'https://meet.example.com/abc-defg-hij',
      idempotency_key: `i-${randomUUID()}`,
    });
    expect(created.status).toBe(200);
    const event = created.body.event as { id: string; revision: number };
    const [row] = await sql<{ id: string; owner_ref: string }[]>`
      SELECT id, owner_ref FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef} AND external_ref = ${event.id}`;
    const path = `/v1/events/${encodeURIComponent(event.id)}/invitation`;

    const request = await call('GET', path);
    expect(request.status).toBe(200);
    const written = JSON.stringify(request.body);
    for (const internal of [row?.id, row?.owner_ref, event.id, event.id.replace(/^agent:/, '')]) {
      expect(written, String(internal)).not.toContain(String(internal));
    }
    expect(request.body).toMatchObject({ sequence: event.revision, recipients: ['ben@example.com'] });
    const uid = request.body.ical_uid as string;
    const component = new ICAL.Component(ICAL.parse(request.body.ical as string)).getFirstSubcomponent('vevent');
    expect(component?.getFirstPropertyValue('uid')).toBe(uid);
    expect(component?.getFirstProperty('conference')?.getFirstValue()).toBe('https://meet.example.com/abc-defg-hij');

    const moved = await call('POST', `/v1/events/${encodeURIComponent(event.id)}/reschedule`, {
      expected_revision: event.revision,
      starts_at: new Date(start + 7_200_000).toISOString(),
      ends_at: new Date(start + 10_800_000).toISOString(),
    });
    expect(moved.status).toBe(200);
    const revision = (moved.body.event as { revision: number }).revision;
    expect(revision).toBeGreaterThan(event.revision);
    const update = await call('GET', path);
    expect(update.body).toMatchObject({ ical_uid: uid, sequence: revision });

    const cancellation = await call('GET', `${path}?method=cancel`);
    expect(cancellation.body).toMatchObject({ ical_uid: uid, sequence: revision + 1, subject: 'Cancelled: Handover call' });
    const cancelled = await call('POST', `/v1/events/${encodeURIComponent(event.id)}/cancel`, {
      expected_revision: revision,
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.revision).toBe(cancellation.body.sequence);
    // Once cancelled, the event is gone and has no invitation.
    expect((await call('GET', path)).status).toBe(404);
  });
});
