// Approval policies (RFC 0004 A4) against real Postgres, over REST as an agent and an admin would
// use them: a booking a policy covers waits for a person with its time held, a retry answers as it
// stands, a grant makes it as the agent asked, a decline or expiry frees the time. Skipped without
// DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, createSlotlockAgentServer } from '../agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
// 08:00-18:00 every day.
const HOURS: WeeklyAvailabilityRule[] = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 8 * 60, durationMinutes: 10 * 60 },
];

type Answer = { status: number; body: Record<string, unknown> };

describe.skipIf(!url)('approval policies (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  const tenantRef = `approvals-${randomUUID()}`;
  // A day well ahead, so no policy's wait is cut short by the start.
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 5, 7, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR).toISOString();
  const principals: Record<string, SlotlockAgentPrincipal> = {
    agent: { subject: 'agent-a', tenantRef, scopes: ['read', 'write'] },
    other: { subject: 'agent-b', tenantRef, scopes: ['read', 'write'] },
    admin: { subject: 'person-admin', tenantRef, scopes: ['read', 'write', 'admin'] },
  };
  const call = async (who: keyof typeof principals, method: string, path: string, body?: unknown): Promise<Answer> => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const book = (who: keyof typeof principals, resourceId: string, start: number, end: number, key = `k-${randomUUID()}`) =>
    call(who, 'POST', '/v1/events', {
      resource_id: resourceId,
      starts_at: at(start),
      ends_at: at(end),
      timezone: 'UTC',
      title: 'Handover',
      idempotency_key: key,
    });
  const policy = (ref: string, body: Record<string, unknown>) =>
    call('admin', 'PUT', `/v1/approval-policies/${ref}`, { name: ref, outcome: 'require_approval', ...body });
  const decide = (id: string, decision: 'grant' | 'decline', reason?: string) =>
    call('admin', 'POST', `/v1/approvals/${id}/decision`, { decision, ...(reason ? { reason } : {}) });
  const resource = async (pool?: string) => {
    const created = await store.createResource({ tenantRef, externalRef: `r-${randomUUID()}`, timezone: 'UTC' });
    if (pool) await store.setResourcePool({ tenantRef, id: created.id, pool });
    return created.id;
  };
  const held = async (approvalId: string) =>
    Number(
      (
        await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM slotlock.reservations
                                   WHERE holder_ref = ${`approval:${approvalId}`} AND status = 'held'`
      )[0]?.n,
    );

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    const agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => HOURS });
    server = createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: agentBackend,
      authenticate: async (request) => {
        const who = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
        return principals[who] ?? null;
      },
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

  it('keeps policies by reference, checks them, and lists them', async () => {
    const put = await policy('night-vans', {
      name: 'Vans out of hours',
      applies_to: { pools: ['night-van'] },
      conditions: { outside_hours: true, kinds: ['pool', 'single'] },
      approval_ttl_minutes: 120,
      lead_minutes: 30,
    });
    expect(put.status).toBe(200);
    expect(put.body.policy).toMatchObject({
      policy_ref: 'night-vans',
      name: 'Vans out of hours',
      applies_to: { pools: ['night-van'] },
      conditions: { outside_hours: true, kinds: ['pool', 'single'] },
      approval_ttl_minutes: 120,
      lead_minutes: 30,
    });
    expect((await call('admin', 'GET', '/v1/approval-policies')).body.policies).toEqual([put.body.policy]);
    expect((await policy('Bad Ref', {})).status).toBe(400);
    expect((await policy('too-long', { approval_ttl_minutes: 43_201 })).status).toBe(400);
    // An agent key cannot see or change them.
    expect((await call('agent', 'GET', '/v1/approval-policies')).status).toBe(403);
    expect((await call('admin', 'DELETE', '/v1/approval-policies/night-vans')).body).toEqual({ deleted: true });
    expect((await call('admin', 'DELETE', '/v1/approval-policies/night-vans')).body).toEqual({ deleted: false });
  });

  it('holds a covered booking for a person, answers its retry as it stands, and books it when granted', async () => {
    const van = await resource();
    await policy('van-gate', { applies_to: { resource_ids: [van] }, approval_ttl_minutes: 240 });
    const key = `gate-${randomUUID()}`;
    const asked = await book('agent', van, 9, 10, key);
    expect(asked.status).toBe(409);
    expect(asked.body).toMatchObject({ code: 'approval_pending', policy_ref: 'van-gate' });
    const approvalId = asked.body.approval_id as string;
    const expires = new Date(asked.body.expires_at as string).getTime();
    expect(Math.abs(expires - (Date.now() + 240 * 60_000))).toBeLessThan(60_000);
    // Its time is held: no one else takes it while a person decides.
    expect(await held(approvalId)).toBe(1);
    const taken = await book('other', van, 9, 10);
    expect(taken.status).toBe(409);
    expect(taken.body).toMatchObject({ code: 'overlap' });
    // A retry answers the same approval; another request with the key is a conflict.
    expect((await book('agent', van, 9, 10, key)).body).toMatchObject({ code: 'approval_pending', approval_id: approvalId });
    expect((await book('agent', van, 11, 12, key)).body).toMatchObject({ code: 'idempotency_conflict' });

    const listed = await call('admin', 'GET', '/v1/approvals?status=pending');
    expect((listed.body.approvals as { approval_id: string }[]).map(({ approval_id }) => approval_id)).toContain(approvalId);
    const one = (await call('admin', 'GET', `/v1/approvals/${approvalId}`)).body.approval as Record<string, unknown>;
    expect(one).toMatchObject({
      status: 'pending',
      operation: 'slotlock_create_event',
      requested_by: 'agent-a',
      resource_ids: [van],
      starts_at: at(9),
      ends_at: at(10),
      request: { resource_id: van, starts_at: at(9), title: 'Handover' },
    });

    const granted = await decide(approvalId, 'grant');
    expect(granted.status).toBe(200);
    expect(granted.body.approval).toMatchObject({ status: 'granted', decided_by: 'person-admin' });
    const event = (granted.body.booking as { event: { id: string; starts_at: string } }).event;
    expect(event.starts_at).toBe(at(9));
    expect(await held(approvalId)).toBe(0);
    // The agent's retry answers the booking it asked for, made as its own.
    const retried = await book('agent', van, 9, 10, key);
    expect(retried.status).toBe(200);
    expect(retried.body).toMatchObject({ replayed: true, event: { id: event.id } });
    expect((await call('agent', 'GET', `/v1/events/${encodeURIComponent(event.id)}`)).status).toBe(200);
    expect((await decide(approvalId, 'grant')).body).toMatchObject({ code: 'approval_not_pending' });
    // The feed tells what happened.
    const types = (
      await sql<{ type: string }[]>`SELECT type FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} AND subject = ${approvalId} ORDER BY id`
    ).map(({ type }) => type);
    expect(types).toEqual(['approval.requested', 'approval.granted']);
  });

  it('frees the time when declined, and the retry says why', async () => {
    const van = await resource();
    await policy('decline-gate', { applies_to: { resource_ids: [van] } });
    const key = `decline-${randomUUID()}`;
    const asked = await book('agent', van, 9, 10, key);
    const approvalId = asked.body.approval_id as string;
    const declined = await decide(approvalId, 'decline', 'The van is in for service');
    expect(declined.body).toMatchObject({ booking: null, approval: { status: 'declined', reason: 'The van is in for service' } });
    expect(await held(approvalId)).toBe(0);
    expect((await book('agent', van, 9, 10, key))).toMatchObject({
      status: 403,
      body: { code: 'approval_declined', approval_id: approvalId, reason: 'The van is in for service' },
    });
    await call('admin', 'DELETE', '/v1/approval-policies/decline-gate');
    expect((await book('other', van, 9, 10)).status).toBe(200);
  });

  it('refuses what a refuse policy names, and passes what no condition meets', async () => {
    const van = await resource();
    await policy('no-long', { applies_to: { resource_ids: [van] }, outcome: 'refuse', conditions: { longer_than_minutes: 120 } });
    await policy('nights', { applies_to: { resource_ids: [van] }, conditions: { outside_hours: true } });
    expect(await book('agent', van, 9, 13)).toMatchObject({ status: 403, body: { code: 'approval_policy_refused', policy_ref: 'no-long' } });
    // Short and in hours: neither applies.
    expect((await book('agent', van, 9, 10)).status).toBe(200);
    // Out of hours: held for a person.
    expect((await book('agent', van, 19, 20)).body).toMatchObject({ code: 'approval_pending', policy_ref: 'nights' });
    await call('admin', 'DELETE', '/v1/approval-policies/no-long');
    await call('admin', 'DELETE', '/v1/approval-policies/nights');
  });

  it('answers a dry run with approval_required and keeps nothing', async () => {
    const van = await resource();
    await policy('dry-gate', { applies_to: { resource_ids: [van] } });
    const dry = await call('agent', 'POST', '/v1/events', {
      resource_id: van,
      starts_at: at(9),
      ends_at: at(10),
      timezone: 'UTC',
      idempotency_key: `d-${randomUUID()}`,
      dry_run: true,
    });
    expect(dry).toMatchObject({ status: 409, body: { code: 'approval_required', policy_ref: 'dry-gate' } });
    expect((await call('admin', 'GET', '/v1/approvals?status=pending')).body.approvals).not.toContainEqual(
      expect.objectContaining({ resource_ids: [van] }),
    );
    await call('admin', 'DELETE', '/v1/approval-policies/dry-gate');
    expect((await book('other', van, 9, 10)).status).toBe(200);
  });

  it('refuses a wait that cannot end before the start less its lead', async () => {
    const van = await resource();
    await policy('lead-gate', { applies_to: { resource_ids: [van] }, lead_minutes: 60 });
    const soon = Math.ceil((Date.now() + 30 * 60_000) / 60_000) * 60_000;
    const refused = await call('agent', 'POST', '/v1/events', {
      resource_id: van,
      starts_at: new Date(soon).toISOString(),
      ends_at: new Date(soon + HOUR).toISOString(),
      timezone: 'UTC',
      idempotency_key: `l-${randomUUID()}`,
    });
    expect(refused.body).toMatchObject({ code: 'approval_too_late', policy_ref: 'lead-gate' });
    await call('admin', 'DELETE', '/v1/approval-policies/lead-gate');
  });

  it('holds a confirmed hold for a person in place of the agent hold, and books it when granted', async () => {
    const van = await resource();
    const hold = await call('agent', 'POST', '/v1/slot-holds', {
      slots: [{ resource_id: van, start: at(9), end: at(10) }],
      ttl_seconds: 300,
      idempotency_key: `h-${randomUUID()}`,
    });
    const holdId = (hold.body.holds as { hold_id: string }[])[0]?.hold_id as string;
    await policy('confirm-gate', { applies_to: { resource_ids: [van] } });
    const asked = await call('agent', 'POST', `/v1/slot-holds/${holdId}/confirm`, { title: 'Handover' });
    expect(asked.body).toMatchObject({ code: 'approval_pending' });
    const approvalId = asked.body.approval_id as string;
    // The agent's own hold gave way to the approval's, over the same time.
    expect((await sql`SELECT 1 FROM slotlock.reservations WHERE id = ${holdId}`).length).toBe(0);
    expect(await held(approvalId)).toBe(1);
    expect((await call('agent', 'POST', `/v1/slot-holds/${holdId}/confirm`, { title: 'Handover' })).body).toMatchObject({
      code: 'approval_pending',
      approval_id: approvalId,
    });
    const granted = await decide(approvalId, 'grant');
    const event = (granted.body.booking as { event: { id: string } }).event;
    const retried = await call('agent', 'POST', `/v1/slot-holds/${holdId}/confirm`, { title: 'Handover' });
    expect(retried).toMatchObject({ status: 200, body: { replayed: true, event: { id: event.id, starts_at: at(9) } } });
    await call('admin', 'DELETE', '/v1/approval-policies/confirm-gate');
  });

  it('holds a move only where the event is not already, and moves it when granted', async () => {
    const van = await resource();
    const created = (await book('agent', van, 9, 10)).body.event as { id: string; revision: number };
    await policy('moves', { applies_to: { resource_ids: [van] }, conditions: { kinds: ['move'] } });
    // A new booking is not a move: it goes through.
    expect((await book('agent', van, 14, 15)).status).toBe(200);
    const move = { expected_revision: created.revision, starts_at: at(9.5), ends_at: at(10.5) };
    const asked = await call('agent', 'POST', `/v1/events/${encodeURIComponent(created.id)}/reschedule`, move);
    expect(asked.body).toMatchObject({ code: 'approval_pending', policy_ref: 'moves' });
    const approvalId = asked.body.approval_id as string;
    // Only 10:00-10:30 is held: 9:30-10:00 is the event's own.
    const [piece] = await sql<{ starts_at: Date; ends_at: Date }[]>`
      SELECT starts_at, ends_at FROM slotlock.reservations WHERE holder_ref = ${`approval:${approvalId}`}`;
    expect(piece?.starts_at.toISOString()).toBe(at(10));
    expect(piece?.ends_at.toISOString()).toBe(at(10.5));
    const granted = await decide(approvalId, 'grant');
    expect(granted.status).toBe(200);
    expect((granted.body.booking as { event: Record<string, unknown> }).event).toMatchObject({
      starts_at: at(9.5),
      revision: created.revision + 1,
    });
    // A change that is not a move needs no one.
    expect(
      (
        await call('agent', 'PATCH', `/v1/events/${encodeURIComponent(created.id)}`, {
          expected_revision: created.revision + 1,
          title: 'Renamed',
          idempotency_key: `t-${randomUUID()}`,
        })
      ).status,
    ).toBe(200);
    await call('admin', 'DELETE', '/v1/approval-policies/moves');
  });

  it('holds the pool member a pool booking would take, and books that member when granted', async () => {
    const pool = `van-${randomUUID().slice(0, 8)}`;
    const first = await resource(pool);
    const second = await resource(pool);
    await book('other', first, 9, 10);
    await policy('pool-gate', { applies_to: { pools: [pool] } });
    const key = `p-${randomUUID()}`;
    const ask = { pool, starts_at: at(9), ends_at: at(10), timezone: 'UTC', idempotency_key: key };
    const asked = await call('agent', 'POST', '/v1/pool-bookings', ask);
    expect(asked.body).toMatchObject({ code: 'approval_pending' });
    const approvalId = asked.body.approval_id as string;
    const one = (await call('admin', 'GET', `/v1/approvals/${approvalId}`)).body.approval as Record<string, unknown>;
    expect(one).toMatchObject({ resource_ids: [second], request: { pool, resource_id: second } });
    const granted = await decide(approvalId, 'grant');
    expect((granted.body.booking as { event: { resource_id: string } }).event.resource_id).toBe(second);
    expect((await call('agent', 'POST', '/v1/pool-bookings', ask)).body).toMatchObject({ replayed: true });
    await call('admin', 'DELETE', '/v1/approval-policies/pool-gate');
  });

  it('holds every resource of a bundle, and books them together when granted', async () => {
    const car = await resource();
    const driver = await resource();
    await policy('bundles', { conditions: { kinds: ['bundle'] } });
    const asked = await call('agent', 'POST', '/v1/bundles', {
      resource_ids: [car, driver],
      starts_at: at(9),
      ends_at: at(10),
      timezone: 'UTC',
      idempotency_key: `b-${randomUUID()}`,
    });
    expect(asked.body).toMatchObject({ code: 'approval_pending', policy_ref: 'bundles' });
    const approvalId = asked.body.approval_id as string;
    expect(await held(approvalId)).toBe(2);
    const granted = await decide(approvalId, 'grant');
    expect((granted.body.booking as { events: unknown[] }).events).toHaveLength(2);
    await call('admin', 'DELETE', '/v1/approval-policies/bundles');
  });

  it('expires what no one decides in time, freeing the time, and the retry says so', async () => {
    const van = await resource();
    await policy('slow', { applies_to: { resource_ids: [van] } });
    const key = `e-${randomUUID()}`;
    const approvalId = (await book('agent', van, 9, 10, key)).body.approval_id as string;
    await sql`UPDATE slotlock.approvals SET expires_at = now() - interval '1 second' WHERE id = ${approvalId}`;
    await sql`UPDATE slotlock.reservations SET expires_at = now() - interval '1 second'
               WHERE holder_ref = ${`approval:${approvalId}`}`;
    expect((await decide(approvalId, 'grant')).body).toMatchObject({ code: 'approval_expired' });
    const maintained = await call('admin', 'POST', '/v1/maintenance', {});
    expect(maintained.body.approvals_expired).toBeGreaterThanOrEqual(1);
    expect(((await call('admin', 'GET', `/v1/approvals/${approvalId}`)).body.approval as { status: string }).status).toBe('expired');
    expect(await held(approvalId)).toBe(0);
    expect((await book('agent', van, 9, 10, key)).body).toMatchObject({ code: 'approval_expired', approval_id: approvalId });
    await call('admin', 'DELETE', '/v1/approval-policies/slow');
  });

  it("books the tenant's own bundles and pool bookings as the tenant's, held only by policies that include the application", async () => {
    const car = await resource();
    const driver = await resource();
    const vans = [await resource('tenant-vans'), await resource('tenant-vans')];
    const owners = async (ids: string[]) =>
      (
        await sql<{ owner_ref: string }[]>`
          SELECT DISTINCT owner_ref FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef} AND resource_id = ANY(${ids}::uuid[])`
      ).map((row) => row.owner_ref);
    const bundle = (key: string, hour: number) =>
      call('admin', 'POST', '/v1/tenant/bundles', {
        resource_ids: [car, driver],
        starts_at: at(hour),
        ends_at: at(hour + 1),
        timezone: 'UTC',
        idempotency_key: key,
      });
    // A policy over these resources holds an agent's bundle, but not the tenant's own.
    const agentsOnly = await policy('staff-free', { applies_to: { resource_ids: [car, driver, ...vans] } });
    expect(agentsOnly.body.policy).toMatchObject({ include_application: false });
    expect((await call('agent', 'POST', '/v1/bundles', {
      resource_ids: [car, driver],
      starts_at: at(14),
      ends_at: at(15),
      timezone: 'UTC',
      idempotency_key: `ab-${randomUUID()}`,
    })).body).toMatchObject({ code: 'approval_pending', policy_ref: 'staff-free' });
    const own = await bundle(`tb-${randomUUID()}`, 9);
    expect(own.status).toBe(200);
    const pooled = await call('admin', 'POST', '/v1/tenant/pool-bookings', {
      pool: 'tenant-vans',
      starts_at: at(9),
      ends_at: at(10),
      timezone: 'UTC',
      idempotency_key: `tp-${randomUUID()}`,
    });
    expect(pooled.status).toBe(200);
    // The tenant's, not the key's: no agent's quota counts them, and revoking the key leaves them.
    expect(await owners([car, driver, ...vans])).toEqual(['internal']);

    // A policy that includes the application holds the tenant's bundle for a person, and the grant
    // books it as the tenant's again.
    const including = await policy('staff-free', { applies_to: { resource_ids: [car, driver] }, include_application: true });
    expect(including.body.policy).toMatchObject({ policy_ref: 'staff-free', include_application: true });
    const key = `tb-${randomUUID()}`;
    const asked = await bundle(key, 11);
    expect(asked.body).toMatchObject({ code: 'approval_pending', policy_ref: 'staff-free' });
    const approvalId = asked.body.approval_id as string;
    expect(await held(approvalId)).toBe(2);
    expect((await bundle(key, 11)).body).toMatchObject({ code: 'approval_pending', approval_id: approvalId });
    const granted = await decide(approvalId, 'grant');
    expect((granted.body.booking as { events: unknown[] }).events).toHaveLength(2);
    expect(await owners([car, driver])).toEqual(['internal']);
    // The retry answers what the grant booked.
    const retried = await bundle(key, 11);
    expect(retried).toMatchObject({ status: 200, body: { replayed: true } });
    await call('admin', 'DELETE', '/v1/approval-policies/staff-free');
  });

  it('refuses a series under a policy, which cannot hold every occurrence', async () => {
    const van = await resource();
    await policy('series-gate', { applies_to: { resource_ids: [van] } });
    const refused = await call('agent', 'POST', '/v1/events', {
      resource_id: van,
      starts_at: at(9),
      ends_at: at(10),
      timezone: 'UTC',
      recurrence_rule: 'FREQ=DAILY;COUNT=3',
      idempotency_key: `s-${randomUUID()}`,
    });
    expect(refused.body).toMatchObject({ code: 'approval_series_unsupported', policy_ref: 'series-gate' });
    await call('admin', 'DELETE', '/v1/approval-policies/series-gate');
  });
});
