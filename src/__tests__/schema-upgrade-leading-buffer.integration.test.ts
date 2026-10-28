// Upgrading a database the release before leading buffers migrated, in a database of its own: the
// columns, trigger, checks, overlap constraint and defaults table this release adds are put in place
// and every booking keeps exactly the time it held. Skipped without DATABASE_URL; the role must
// create databases.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const HOUR = 3_600_000;

/** Take out what this release adds, leaving the schema as the release before left it. */
async function shapeAsBeforeLeadingBuffers(sql: postgres.Sql) {
  await sql.unsafe(`
    ALTER TABLE slotlock.reservations DROP CONSTRAINT slotlock_reservations_no_overlap;
    DROP TRIGGER slotlock_reservations_set_occupied_start ON slotlock.reservations;
    DROP FUNCTION slotlock.set_reservation_occupied_start();
    ALTER TABLE slotlock.reservations DROP COLUMN occupied_starts_at, DROP COLUMN buffer_before_ms;
    ALTER TABLE slotlock.reservations
      ADD CONSTRAINT slotlock_reservations_no_overlap EXCLUDE USING gist (
        resource_id WITH =,
        tstzrange(starts_at, COALESCE(occupied_ends_at, ends_at), '[)') WITH &&
      );
    ALTER TABLE slotlock.calendar_events DROP COLUMN buffer_before_ms;
    DROP TABLE slotlock.booking_rule_defaults;
  `);
}

describe.skipIf(!url)('upgrading a database from before leading buffers', () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  let store: SlotlockStore;
  const database = `slotlock_upgrade_${randomBytes(6).toString('hex')}`;
  const tenantRef = `upgrade-${randomUUID()}`;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => undefined });
    await admin.unsafe(`CREATE DATABASE ${database}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    sql = postgres(target.href, { max: 2, onnotice: () => undefined });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await admin?.end();
  });

  it('adds the occupied start and its constraint, and changes no booking', async () => {
    await shapeAsBeforeLeadingBuffers(sql);
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO slotlock.resources (tenant_ref, external_ref, timezone, booking_rules)
      VALUES (${tenantRef}, 'van-1', 'UTC', '{"turnaroundMinutes": 30}'::jsonb)
      RETURNING id`;
    const resourceId = resource?.id as string;
    const start = new Date(Math.ceil(Date.now() / HOUR) * HOUR + 48 * HOUR);
    const at = (hours: number) => new Date(start.getTime() + hours * HOUR);
    // As the release before wrote them: a buffered booking, one abutting its buffer, a live hold.
    await sql`
      INSERT INTO slotlock.reservations (resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms)
      VALUES (${resourceId}, ${tenantRef}, 'b-1', ${at(0)}, ${at(1)}, ${HOUR / 2}),
             (${resourceId}, ${tenantRef}, 'b-2', ${at(1.5)}, ${at(2.5)}, 0)`;
    await sql`
      INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, status, expires_at)
      VALUES (${resourceId}, ${at(4)}, ${at(5)}, 'held', now() + interval '1 hour')`;
    const rows = () => sql`
      SELECT id, resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms,
             occupied_ends_at, status, expires_at, revision, source, created_at
        FROM slotlock.reservations ORDER BY id`;
    const before = await rows();
    const feed = async () => Number((await sql<{ count: string }[]>`SELECT count(*) AS count FROM slotlock.outbox`)[0]?.count);
    const feedBefore = await feed();

    await store.applySchema();

    expect(await rows()).toEqual(before);
    expect(await feed()).toBe(feedBefore);
    const added = await sql<{ buffer_before_ms: string; occupied_starts_at: Date | null }[]>`
      SELECT buffer_before_ms, occupied_starts_at FROM slotlock.reservations`;
    // No row is rewritten: none has a leading buffer, and none an occupied start of its own.
    expect(added.map((row) => [Number(row.buffer_before_ms), row.occupied_starts_at])).toEqual([
      [0, null],
      [0, null],
      [0, null],
    ]);
    const [overlap] = await sql<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE conname = 'slotlock_reservations_no_overlap'`;
    expect(overlap?.definition).toContain('COALESCE(occupied_starts_at, starts_at)');
    // Every check was validated after the migration: the old rows keep them.
    expect(
      await sql`
        SELECT conname FROM pg_constraint
         WHERE connamespace = 'slotlock'::regnamespace AND NOT convalidated`,
    ).toEqual([]);
    expect(
      await sql`SELECT 1 FROM pg_tables WHERE schemaname = 'slotlock' AND tablename = 'booking_rule_defaults'`,
    ).toHaveLength(1);
    // The time each occupies is what it was (free/busy merges touching time).
    expect((await store.getFreeBusy({ tenantRef, resourceId, window: { start: at(-1), end: at(6) } })).busy).toEqual([
      { start: at(0), end: at(2.5) },
      { start: at(4), end: at(5) },
    ]);
    // A second migration changes nothing.
    const constraints = await sql`
      SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
       WHERE conrelid = 'slotlock.reservations'::regclass ORDER BY conname`;
    await store.applySchema();
    expect(
      await sql`
        SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
         WHERE conrelid = 'slotlock.reservations'::regclass ORDER BY conname`,
    ).toEqual(constraints);

    // New bookings keep a leading buffer against the old ones.
    await store.setResourceBookingRules({ tenantRef, id: resourceId, rules: { bufferBeforeMinutes: 30 } });
    const book = (from: Date, to: Date) =>
      store.createExternalReservation({
        tenantRef,
        externalRef: `b-${randomUUID()}`,
        resourceId,
        start: from,
        end: to,
        bufferAfterMs: 0,
        revision: 1,
      });
    expect(await book(at(2.5), at(3.5))).toMatchObject({ ok: false, code: 'overlap' });
    expect(await book(at(3), at(3.5))).toMatchObject({ ok: true });
  });
});
