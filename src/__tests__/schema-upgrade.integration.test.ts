// Upgrading a database the previous release migrated: the schema changes this release makes are
// applied to a database of its own, shaped as 0.1 left it, so rewriting constraints never touches
// what other test files are reading. Skipped without DATABASE_URL; the role must create databases.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const HOUR = 3_600_000;

/** Put back the 0.1 overlap and scope constraints in place of this release's. */
async function shapeAsRelease01(sql: postgres.Sql) {
  await sql.unsafe(`
    ALTER TABLE slotlock.reservations DROP CONSTRAINT slotlock_reservations_no_overlap;
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_no_overlap EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(starts_at, ends_at, '[)') WITH &&
      );
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_buffered_no_overlap EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(starts_at, occupied_ends_at, '[)') WITH &&
      ) WHERE (tenant_ref IS NOT NULL);
    ALTER TABLE slotlock.api_keys DROP CONSTRAINT slotlock_api_keys_scopes_known;
    ALTER TABLE slotlock.api_keys
      ADD CONSTRAINT slotlock_api_keys_scopes_valid
      CHECK (scopes IN (ARRAY['read']::text[], ARRAY['write']::text[], ARRAY['read', 'write']::text[]));
  `);
}

async function constraintsOf(sql: postgres.Sql, table: string) {
  const rows = await sql<{ name: string; definition: string }[]>`
    SELECT conname AS name, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE conrelid = ${`slotlock.${table}`}::regclass AND contype IN ('x', 'c')
     ORDER BY conname`;
  return Object.fromEntries(rows.map(({ name, definition }) => [name, definition]));
}

describe.skipIf(!url)('upgrading a 0.1 database', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let store: SlotlockStore;
  const database = `slotlock_upgrade_${randomBytes(6).toString('hex')}`;
  const tenantRef = `upgrade-${randomUUID()}`;
  let resourceId: string;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    sql = postgres(target.href, { max: 2, onnotice: () => undefined });
    store = createSlotlockStore(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  beforeEach(async () => {
    await sql.unsafe('DROP SCHEMA IF EXISTS slotlock CASCADE');
    await store.applySchema();
    resourceId = (await store.createResource({ tenantRef, externalRef: 'van-1', timezone: 'UTC' })).id;
  });

  /** A booking on the resource tomorrow 09:00-10:00 that keeps it busy for an hour after. */
  async function bufferedBooking() {
    const start = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 24 * HOUR);
    const booked = await store.createExternalReservation({
      tenantRef,
      externalRef: `booking-${randomUUID()}`,
      resourceId,
      start,
      end: new Date(start.getTime() + HOUR),
      bufferAfterMs: HOUR,
      revision: 1,
    });
    if (!booked.ok) throw new Error(`expected a booking, got ${booked.code}`);
    return booked.reservation;
  }

  /** A hold 0.1 accepted inside a booking's buffer: 10:15-10:45, expiring in `expiresInMs`. */
  async function holdInBuffer(end: Date, expiresInMs: number) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, status, expires_at)
      VALUES (${resourceId}, ${new Date(end.getTime() + HOUR / 4)}, ${new Date(end.getTime() + (3 * HOUR) / 4)},
              'held', now() + ${expiresInMs} * interval '1 millisecond')
      RETURNING id`;
    return row?.id as string;
  }

  it('creates one overlap constraint over every row, buffer included, and re-applies as a no-op', async () => {
    const constraints = await constraintsOf(sql, 'reservations');
    expect(constraints.slotlock_reservations_no_overlap).toBe(
      "EXCLUDE USING gist (resource_id WITH =, tstzrange(starts_at, COALESCE(occupied_ends_at, ends_at), '[)'::text) WITH &&)",
    );
    expect(constraints).not.toHaveProperty('slotlock_reservations_buffered_no_overlap');
    await store.applySchema();
    expect(await constraintsOf(sql, 'reservations')).toEqual(constraints);

    // Holds and buffers now exclude each other both ways.
    const booking = await bufferedBooking();
    const inBuffer = await store.acquireHold({
      resourceId,
      start: new Date(booking.end.getTime() + HOUR / 4),
      end: new Date(booking.end.getTime() + HOUR / 2),
      ttlMs: 60_000,
    });
    expect(inBuffer).toMatchObject({ ok: false, code: 'overlap', conflictingReservationId: booking.id });
    const later = new Date(booking.end.getTime() + 5 * HOUR);
    const held = await store.acquireHold({ resourceId, start: later, end: new Date(later.getTime() + HOUR), ttlMs: 60_000 });
    expect(held.ok).toBe(true);
    const over = await store.createExternalReservation({
      tenantRef,
      externalRef: `booking-${randomUUID()}`,
      resourceId,
      start: new Date(later.getTime() - 2 * HOUR),
      end: new Date(later.getTime() - HOUR / 2),
      bufferAfterMs: HOUR,
      revision: 1,
    });
    expect(over).toMatchObject({ ok: false, code: 'overlap' });
  });

  it('reaps an expired hold in a buffer, keeps every live row, and replaces the 0.1 constraints', async () => {
    await shapeAsRelease01(sql);
    const booking = await bufferedBooking();
    const expired = await holdInBuffer(booking.end, -60_000);
    const later = new Date(booking.end.getTime() + 5 * HOUR);
    const live = await store.acquireHold({ resourceId, start: later, end: new Date(later.getTime() + HOUR), ttlMs: 600_000 });
    if (!live.ok) throw new Error('expected a live hold');
    // 0.1 refuses an admin key.
    await expect(
      createSlotlockApiKeyStore(sql).create({ tenantRef, name: 'Application', scopes: ['read', 'write', 'admin'] }),
    ).rejects.toThrow();

    await store.applySchema();

    const ids = (await sql<{ id: string }[]>`SELECT id FROM slotlock.reservations ORDER BY id`).map(({ id }) => id);
    expect(ids).toEqual([booking.id, live.hold.id].sort());
    expect(ids).not.toContain(expired);
    const constraints = await constraintsOf(sql, 'reservations');
    expect(constraints.slotlock_reservations_no_overlap).toContain('COALESCE(occupied_ends_at, ends_at)');
    expect(constraints).not.toHaveProperty('slotlock_reservations_buffered_no_overlap');
    const keys = await constraintsOf(sql, 'api_keys');
    expect(keys).not.toHaveProperty('slotlock_api_keys_scopes_valid');
    expect(keys.slotlock_api_keys_scopes_known).toContain("ARRAY['read'::text, 'write'::text, 'admin'::text]");
    await expect(
      createSlotlockApiKeyStore(sql).create({ tenantRef, name: 'Application', scopes: ['read', 'write', 'admin'] }),
    ).resolves.toMatchObject({ apiKey: { scopes: ['read', 'write', 'admin'] } });
    expect(
      await store.acquireHold({
        resourceId,
        start: new Date(booking.end.getTime() + HOUR / 4),
        end: new Date(booking.end.getTime() + HOUR / 2),
        ttlMs: 60_000,
      }),
    ).toMatchObject({ ok: false, code: 'overlap' });
  });

  it('stops, changing nothing, while a live hold is in a buffer, and goes on once it is released', async () => {
    await shapeAsRelease01(sql);
    const booking = await bufferedBooking();
    const live = await holdInBuffer(booking.end, 600_000);
    const before = { reservations: await constraintsOf(sql, 'reservations'), keys: await constraintsOf(sql, 'api_keys') };

    const refused = await store.applySchema().then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string; detail?: string; hint?: string },
    );
    expect(refused).toMatchObject({
      code: '23P01',
      message: "Slotlock cannot upgrade: 1 reservations or holds overlap another's turnaround buffer",
      detail: `Reservation ids, in pairs: ${booking.id} and ${live}`,
      hint: expect.stringMatching(/then migrate again/),
    });
    // The whole schema is one transaction: nothing changed, the 0.1 scope constraint included.
    expect(await constraintsOf(sql, 'reservations')).toEqual(before.reservations);
    expect(await constraintsOf(sql, 'api_keys')).toEqual(before.keys);
    expect((await sql`SELECT id FROM slotlock.reservations`).length).toBe(2);

    expect(await store.releaseHold(live)).toEqual({ ok: true, released: true });
    await store.applySchema();
    expect((await constraintsOf(sql, 'reservations')).slotlock_reservations_no_overlap).toContain('occupied_ends_at');
  });
});
