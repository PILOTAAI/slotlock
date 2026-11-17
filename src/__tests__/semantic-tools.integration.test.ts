// The named booking tools (RFC 0004 A2): confirm a hold, reschedule, cancel, through the operation
// boundary every protocol shares, against real Postgres. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockAgentPrincipal, invokeSlotlockAgentOperation } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const HOUR = 3_600_000;
const EVERY_DAY: WeeklyAvailabilityRule[] = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 8 * 60, durationMinutes: 10 * 60 },
];

type Outcome =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; code: string; status: number; alternatives?: { start: string }[] };

describe.skipIf(!url)('confirm, reschedule and cancel (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let backend: ReturnType<typeof createSlotlockStoreAgentBackend>;
  const tenantRef = `semantic-${randomUUID()}`;
  const base = Date.UTC(new Date().getUTCFullYear() + 1, 3, 6, 0, 0, 0);
  const at = (hour: number) => new Date(base + hour * HOUR).toISOString();
  const principal = (subject = 'tool-agent'): SlotlockAgentPrincipal => ({ subject, tenantRef, scopes: ['read', 'write'] });
  const call = (operation: string, input: Record<string, unknown>, subject?: string) =>
    invokeSlotlockAgentOperation({
      operation,
      input,
      request: new Request('https://example.com'),
      options: { backend, authenticate: async () => principal(subject), authorize: async () => true },
    }) as Promise<Outcome>;
  const data = (outcome: Outcome) => {
    if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
    return outcome.data;
  };
  const resource = async () =>
    (await store.createResource({ tenantRef, externalRef: `r-${randomUUID()}`, timezone: 'Europe/London' })).id;
  const hold = async (resourceId: string, start: number, end: number, subject?: string) =>
    (
      data(
        await call(
          'slotlock_hold_slots',
          { slots: [{ resource_id: resourceId, start: at(start), end: at(end) }], ttl_seconds: 120, idempotency_key: `h-${randomUUID()}` },
          subject,
        ),
      ).holds as { hold_id: string }[]
    )[0]?.hold_id as string;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    backend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => EVERY_DAY });
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('confirms a held time exactly, in the resource zone, and answers a retry with the same event', async () => {
    const van = await resource();
    const holdId = await hold(van, 9, 10);
    const first = data(await call('slotlock_confirm_slot', { hold_id: holdId, title: 'Handover with Ana' }));
    const event = first.event as { id: string; resource_id: string; starts_at: string; ends_at: string; timezone: string; title: string };
    expect(event).toMatchObject({ resource_id: van, starts_at: at(9), ends_at: at(10), timezone: 'Europe/London', title: 'Handover with Ana' });
    expect(first.replayed).toBe(false);
    const again = data(await call('slotlock_confirm_slot', { hold_id: holdId, title: 'Handover with Ana' }));
    expect(again).toEqual({ ...first, replayed: true });
  });

  it("says hold_expired for its own lapsed hold, and hold_not_found for another's", async () => {
    const van = await resource();
    const holdId = await hold(van, 11, 12);
    expect(await call('slotlock_confirm_slot', { hold_id: holdId }, 'someone-else')).toMatchObject({
      ok: false,
      code: 'hold_not_found',
      status: 404,
    });
    await sql`UPDATE slotlock.reservations SET expires_at = now() - interval '1 second' WHERE id = ${holdId}`;
    expect(await call('slotlock_confirm_slot', { hold_id: holdId })).toMatchObject({
      ok: false,
      code: 'hold_expired',
      status: 409,
    });
  });

  it('reschedules at the revision read, answers a retry, and refuses another move from that revision', async () => {
    const room = await resource();
    const created = data(
      await call('slotlock_create_event', {
        resource_id: room,
        starts_at: at(9),
        ends_at: at(10),
        timezone: 'UTC',
        idempotency_key: `e-${randomUUID()}`,
      }),
    ).event as { id: string; revision: number };
    const move = { event_id: created.id, expected_revision: created.revision, starts_at: at(13), ends_at: at(14) };
    const moved = data(await call('slotlock_reschedule', move));
    expect(moved.event).toMatchObject({ starts_at: at(13), ends_at: at(14), revision: created.revision + 1 });
    expect(moved.replayed).toBe(false);
    expect(data(await call('slotlock_reschedule', move))).toEqual({ ...moved, replayed: true });
    expect(
      await call('slotlock_reschedule', { ...move, starts_at: at(15), ends_at: at(16) }),
    ).toMatchObject({ ok: false, code: 'revision_conflict' });
  });

  it('answers a move into a taken time with overlap and alternatives', async () => {
    const room = await resource();
    data(await call('slotlock_create_event', { resource_id: room, starts_at: at(9), ends_at: at(10), timezone: 'UTC', idempotency_key: `x-${randomUUID()}` }, 'other'));
    const mine = data(
      await call('slotlock_create_event', { resource_id: room, starts_at: at(12), ends_at: at(13), timezone: 'UTC', idempotency_key: `m-${randomUUID()}` }),
    ).event as { id: string; revision: number };
    const refused = await call('slotlock_reschedule', {
      event_id: mine.id,
      expected_revision: mine.revision,
      starts_at: at(9),
      ends_at: at(10),
    });
    expect(refused).toMatchObject({ ok: false, code: 'overlap' });
    if (refused.ok) return;
    expect(refused.alternatives?.[0]?.start).toBe(at(10));
  });

  it('cancels at the revision read, frees the time, and answers a retry', async () => {
    const room = await resource();
    const created = data(
      await call('slotlock_create_event', { resource_id: room, starts_at: at(9), ends_at: at(10), timezone: 'UTC', idempotency_key: `c-${randomUUID()}` }),
    ).event as { id: string; revision: number };
    const cancel = { event_id: created.id, expected_revision: created.revision };
    const first = data(await call('slotlock_cancel', cancel));
    expect(first).toMatchObject({ event_id: created.id, deleted: true, replayed: false });
    expect(data(await call('slotlock_cancel', cancel))).toEqual({ ...first, replayed: true });
    // The time is free for anyone at once.
    expect(
      (await call('slotlock_create_event', { resource_id: room, starts_at: at(9), ends_at: at(10), timezone: 'UTC', idempotency_key: `n-${randomUUID()}` }, 'other')).ok,
    ).toBe(true);
  });
});
