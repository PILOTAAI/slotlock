// Slotlock core against real Postgres (RFC-0001 spike criteria a + c).
//
// The EXCLUDE constraint — not application code — is the final double-booking arbiter, proven
// here with a genuine concurrent race. Slotlock owns its DDL in a dedicated `slotlock` schema on the
// target DB, applied by `applySchema` rather than by an embedding application's migrations.
//
// Skipped without DATABASE_URL; runs in CI's DB lane and locally against a throwaway DB.
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findNextAvailable } from '../engine.js';
import { expandRules } from '../rules.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

const d = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;

describe.skipIf(!url)('slotlock core (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let resourceId: string;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    const res = await store.createResource({ externalRef: 'spike-vehicle-1' });
    resourceId = res.id;
  });

  afterAll(async () => {
    await sql`DELETE FROM slotlock.reservations`;
    await sql`DELETE FROM slotlock.reservation_tombstones`;
    await sql`DELETE FROM slotlock.resources`;
    await sql.end();
  });

  it('serializes concurrent schema bootstrap across independent application instances', async () => {
    await sql`DROP SCHEMA slotlock CASCADE`;
    const siblingSql = postgres(url as string, { max: 1, onnotice: () => {} });
    try {
      await Promise.all([store.applySchema(), createSlotlockStore(siblingSql).applySchema()]);
    } finally {
      await siblingSql.end();
    }
    const [schema] = await sql<{ name: string | null }[]>`
      SELECT to_regclass('slotlock.reservations')::text AS name`;
    expect(schema?.name).toBe('slotlock.reservations');
    resourceId = (
      await store.createResource({ externalRef: 'spike-vehicle-1-after-bootstrap-race' })
    ).id;
  });

  it('upgrades the legacy schema with legacy rows and reruns without lock-heavy trigger churn', async () => {
    await sql`DROP SCHEMA slotlock CASCADE`;
    await sql`CREATE SCHEMA slotlock`;
    // The legacy schema kept btree_gist in its own schema, and dropping the schema dropped it. The
    // GiST exclusion below needs its uuid operator class; without this line the fixture only built on
    // a database that happened to have btree_gist installed elsewhere.
    await sql`CREATE EXTENSION IF NOT EXISTS btree_gist SCHEMA slotlock`;
    await sql`
      CREATE TABLE slotlock.resources (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        external_ref text,
        timezone text NOT NULL DEFAULT 'UTC',
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
    await sql`
      CREATE TABLE slotlock.reservations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        resource_id uuid NOT NULL REFERENCES slotlock.resources(id) ON DELETE CASCADE,
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        status text NOT NULL DEFAULT 'confirmed',
        expires_at timestamptz,
        source text,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT slotlock_reservations_window_valid CHECK (ends_at > starts_at),
        CONSTRAINT slotlock_reservations_no_overlap EXCLUDE USING gist (
          resource_id WITH =,
          tstzrange(starts_at, ends_at, '[)') WITH &&
        )
      )`;
    const legacy = await sql<{ id: string }[]>`
      INSERT INTO slotlock.resources (external_ref) VALUES ('legacy-upgrade-resource') RETURNING id`;
    const legacyResourceId = legacy[0]?.id;
    if (!legacyResourceId) throw new Error('legacy resource fixture failed');
    await sql`
      INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, source)
      VALUES (
        ${legacyResourceId}, ${d('2027-01-20T10:00:00Z')},
        ${d('2027-01-20T12:00:00Z')}, 'legacy-before-upgrade'
      )`;

    await store.applySchema();
    const upgraded = await sql<
      { occupied_ends_at: Date | null; revision: number; trigger_count: number }[]
    >`
      SELECT r.occupied_ends_at, r.revision::int AS revision,
             (SELECT count(*)::int FROM pg_trigger
               WHERE tgname = 'slotlock_reservations_set_occupied_end'
                 AND tgrelid = 'slotlock.reservations'::regclass
                 AND NOT tgisinternal) AS trigger_count
        FROM slotlock.reservations r WHERE r.resource_id = ${legacyResourceId}`;
    expect(upgraded[0]).toEqual({ occupied_ends_at: null, revision: 1, trigger_count: 1 });
    await expect(
      store.listBusy(legacyResourceId, {
        start: d('2027-01-20T00:00:00Z'),
        end: d('2027-01-21T00:00:00Z'),
      }),
    ).resolves.toEqual([{ start: d('2027-01-20T10:00:00Z'), end: d('2027-01-20T12:00:00Z') }]);

    await store.applySchema();
    const triggers = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM pg_trigger
       WHERE tgname = 'slotlock_reservations_set_occupied_end'
         AND tgrelid = 'slotlock.reservations'::regclass
         AND NOT tgisinternal`;
    expect(triggers[0]?.count).toBe(1);
    resourceId = (
      await store.createResource({ externalRef: 'spike-vehicle-1-after-legacy-upgrade' })
    ).id;
  });

  it('adopts legacy calendar identities into internal ownership without breaking tenant child keys', async () => {
    const tenantRef = `legacy-calendar-owner-${crypto.randomUUID()}`;
    const resource = await store.createResource({
      tenantRef,
      externalRef: `legacy-calendar-resource-${crypto.randomUUID()}`,
    });
    const activeExternalRef = `legacy-active-${crypto.randomUUID()}`;
    const cancelledExternalRef = `legacy-cancelled-${crypto.randomUUID()}`;
    const eventInput = {
      tenantRef,
      resourceId: resource.id,
      expectedRevision: 0,
      start: d('2027-02-10T10:00:00Z'),
      end: d('2027-02-10T11:00:00Z'),
      timezone: 'UTC',
      summary: 'Legacy owner upgrade fixture',
      transparency: 'transparent' as const,
    };

    try {
      await expect(
        store.putCalendarEvent({
          ...eventInput,
          externalRef: activeExternalRef,
          idempotencyKey: `legacy-active-command-${crypto.randomUUID()}`,
        }),
      ).resolves.toMatchObject({ ok: true, revision: 1 });
      await expect(
        store.putCalendarEvent({
          ...eventInput,
          externalRef: cancelledExternalRef,
          idempotencyKey: `legacy-cancelled-command-${crypto.randomUUID()}`,
        }),
      ).resolves.toMatchObject({ ok: true, revision: 1 });
      await expect(
        store.cancelCalendarEvent({
          tenantRef,
          externalRef: cancelledExternalRef,
          idempotencyKey: `legacy-cancel-command-${crypto.randomUUID()}`,
          expectedRevision: 1,
        }),
      ).resolves.toMatchObject({ ok: true, revision: 2 });

      await sql`DROP TRIGGER IF EXISTS slotlock_calendar_events_owner_immutable
                  ON slotlock.calendar_events`;
      await sql`DROP INDEX IF EXISTS slotlock.slotlock_calendar_events_owner_resource_time_idx`;
      await sql`DROP INDEX IF EXISTS slotlock.slotlock_calendar_event_commands_retention_idx`;
      await sql`DROP INDEX IF EXISTS slotlock.slotlock_calendar_event_commands_authority_idx`;
      await sql`DROP INDEX IF EXISTS slotlock.slotlock_calendar_event_tombstones_agent_retention_idx`;

      await sql`ALTER TABLE slotlock.calendar_events
                  DROP CONSTRAINT slotlock_calendar_events_owner_external_key,
                  DROP CONSTRAINT slotlock_calendar_events_owner_identity_valid,
                  DROP COLUMN owner_ref,
                  ADD CONSTRAINT slotlock_calendar_events_tenant_external_key
                    UNIQUE (tenant_ref, external_ref),
                  ADD CONSTRAINT slotlock_calendar_events_identity_valid CHECK (
                    octet_length(tenant_ref) BETWEEN 1 AND 500
                    AND octet_length(external_ref) BETWEEN 1 AND 500
                  )`;
      await sql`ALTER TABLE slotlock.calendar_event_tombstones
                  DROP CONSTRAINT slotlock_calendar_event_tombstones_owner_key,
                  DROP CONSTRAINT slotlock_calendar_event_tombstones_owner_identity_valid,
                  DROP COLUMN owner_ref,
                  ADD CONSTRAINT calendar_event_tombstones_pkey
                    PRIMARY KEY (tenant_ref, external_ref),
                  ADD CONSTRAINT slotlock_calendar_event_tombstones_identity_valid CHECK (
                    octet_length(tenant_ref) BETWEEN 1 AND 500
                    AND octet_length(external_ref) BETWEEN 1 AND 500
                  )`;
      await sql`ALTER TABLE slotlock.calendar_event_commands
                  DROP CONSTRAINT slotlock_calendar_event_commands_owner_key,
                  DROP CONSTRAINT slotlock_calendar_event_commands_owner_identity_valid,
                  DROP COLUMN owner_ref,
                  ADD CONSTRAINT calendar_event_commands_pkey
                    PRIMARY KEY (tenant_ref, idempotency_key),
                  ADD CONSTRAINT slotlock_calendar_event_commands_identity_valid CHECK (
                    octet_length(tenant_ref) BETWEEN 1 AND 500
                    AND octet_length(idempotency_key) BETWEEN 1 AND 500
                    AND octet_length(external_ref) BETWEEN 1 AND 500
                    AND octet_length(payload_hash) = 64
                  )`;

      await store.applySchema();
      const [adopted] = await sql<
        {
          active_owner: string;
          command_owners: string[];
          tombstone_owner: string;
          event_children: number;
          owner_trigger_count: number;
        }[]
      >`
        SELECT
          (SELECT owner_ref FROM slotlock.calendar_events
            WHERE tenant_ref = ${tenantRef} AND external_ref = ${activeExternalRef}) AS active_owner,
          (SELECT array_agg(DISTINCT owner_ref ORDER BY owner_ref)
             FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenantRef}) AS command_owners,
          (SELECT owner_ref FROM slotlock.calendar_event_tombstones
            WHERE tenant_ref = ${tenantRef} AND external_ref = ${cancelledExternalRef}) AS tombstone_owner,
          (SELECT count(*)::int FROM slotlock.calendar_event_occurrences occurrence
             JOIN slotlock.calendar_events event ON event.id = occurrence.event_id
            WHERE event.tenant_ref = ${tenantRef}) AS event_children,
          (SELECT count(*)::int FROM pg_trigger
            WHERE tgname = 'slotlock_calendar_events_owner_immutable'
              AND tgrelid = 'slotlock.calendar_events'::regclass
              AND NOT tgisinternal) AS owner_trigger_count`;
      expect(adopted).toEqual({
        active_owner: 'internal',
        command_owners: ['internal'],
        tombstone_owner: 'internal',
        event_children: 1,
        owner_trigger_count: 1,
      });
      await expect(
        store.getCalendarEvent({ tenantRef, externalRef: activeExternalRef }),
      ).resolves.toMatchObject({ ownerRef: 'internal', externalRef: activeExternalRef });

      const constraints = await sql<{ conname: string; definition: string }[]>`
        SELECT conname, pg_get_constraintdef(oid) AS definition
          FROM pg_constraint
         WHERE conrelid IN (
           'slotlock.calendar_events'::regclass,
           'slotlock.calendar_event_tombstones'::regclass,
           'slotlock.calendar_event_commands'::regclass
         )
           AND conname IN (
             'slotlock_calendar_events_owner_external_key',
             'slotlock_calendar_event_tombstones_owner_key',
             'slotlock_calendar_event_commands_owner_key'
           )
         ORDER BY conname`;
      expect(constraints).toHaveLength(3);
      expect(constraints.every(({ definition }) => definition.includes('owner_ref'))).toBe(true);

      await store.applySchema();
      const [rerun] = await sql<{ trigger_count: number }[]>`
        SELECT count(*)::int AS trigger_count FROM pg_trigger
         WHERE tgname = 'slotlock_calendar_events_owner_immutable'
           AND tgrelid = 'slotlock.calendar_events'::regclass
           AND NOT tgisinternal`;
      expect(rerun?.trigger_count).toBe(1);
    } finally {
      await store.applySchema();
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.reservations WHERE tenant_ref = ${tenantRef}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
    }
  });

  it('heals duplicate legacy resources without losing conflicting reservation evidence', async () => {
    const externalRef = `legacy-duplicate-${crypto.randomUUID()}`;
    await sql`DROP INDEX IF EXISTS slotlock.slotlock_resources_tenant_external_ref_key`;
    await sql`DROP INDEX IF EXISTS slotlock.slotlock_resources_legacy_external_ref_key`;
    const resources = await sql<{ id: string }[]>`
      INSERT INTO slotlock.resources (external_ref)
      VALUES (${externalRef}), (${externalRef})
      RETURNING id`;
    const firstId = resources[0]?.id;
    const secondId = resources[1]?.id;
    if (!firstId || !secondId) throw new Error('duplicate fixture insert failed');
    const reservationIds: [string, string] = [crypto.randomUUID(), crypto.randomUUID()];
    await sql`
      INSERT INTO slotlock.reservations (id, resource_id, starts_at, ends_at, source)
      VALUES
        (${reservationIds[0]}, ${firstId}, ${d('2027-01-10T10:00:00Z')}, ${d('2027-01-10T12:00:00Z')}, 'legacy-a'),
        (${reservationIds[1]}, ${secondId}, ${d('2027-01-10T11:00:00Z')}, ${d('2027-01-10T13:00:00Z')}, 'legacy-b')`;

    try {
      await store.applySchema();
      const survivingResources = await sql<{ id: string }[]>`
        SELECT id FROM slotlock.resources WHERE external_ref = ${externalRef}`;
      expect(survivingResources).toHaveLength(1);

      const survivingReservations = await sql<{ id: string }[]>`
        SELECT id FROM slotlock.reservations
         WHERE id IN ${sql(reservationIds)}`;
      expect(survivingReservations).toHaveLength(1);
      const archived = await sql<{ original_reservation_id: string; reason: string }[]>`
        SELECT original_reservation_id, reason
          FROM slotlock.reservation_conflict_archive
         WHERE original_reservation_id IN ${sql(reservationIds)}`;
      expect(archived).toHaveLength(1);
      expect(archived[0]?.reason).toBe('overlap_conflict');
    } finally {
      await sql`DELETE FROM slotlock.reservation_conflict_archive
                 WHERE original_reservation_id IN ${sql(reservationIds)}`.catch(() => undefined);
      await sql`DELETE FROM slotlock.reservations WHERE id IN ${sql(reservationIds)}`;
      await sql`DELETE FROM slotlock.resources WHERE external_ref = ${externalRef}`;
      await store.applySchema();
    }
  });

  it('concurrent resource creates with the same external reference converge on one row', async () => {
    const externalRef = `resource-replay-${crypto.randomUUID()}`;
    const [first, second] = await Promise.all([
      store.createResource({ externalRef, timezone: 'Europe/London' }),
      store.createResource({ externalRef, timezone: 'Europe/London' }),
    ]);
    expect(first.id).toBe(second.id);
    const count = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.resources WHERE external_ref = ${externalRef}`;
    expect(count[0]?.count).toBe(1);
  });

  it('namespaces an external resource reference independently for every tenant', async () => {
    const externalRef = `tenant-resource-${crypto.randomUUID()}`;
    const first = await store.createResource({
      externalRef,
      tenantRef: 'operator-a',
      timezone: 'Europe/London',
    });
    expect(first.tenantRef).toBe('operator-a');

    const second = await store.createResource({
      externalRef,
      tenantRef: 'operator-b',
      timezone: 'Europe/Paris',
    });
    expect(second).toMatchObject({ tenantRef: 'operator-b', timezone: 'Europe/Paris' });
    expect(second.id).not.toBe(first.id);

    const owners = await sql<{ tenant_ref: string; timezone: string }[]>`
      SELECT tenant_ref, timezone FROM slotlock.resources
       WHERE external_ref = ${externalRef}
       ORDER BY tenant_ref`;
    expect(owners).toEqual([
      { tenant_ref: 'operator-a', timezone: 'Europe/London' },
      { tenant_ref: 'operator-b', timezone: 'Europe/Paris' },
    ]);

    await expect(store.createResource({ tenantRef: 'operator-a' })).rejects.toMatchObject({
      code: 'invalid_external_ref',
    });
  });

  it('replays one external reservation exactly and enforces its trailing turnaround buffer', async () => {
    const tenantRef = `operator-${crypto.randomUUID()}`;
    const resource = await store.createResource({
      externalRef: `buffered-resource-${crypto.randomUUID()}`,
      tenantRef,
    });
    const externalRef = `booking-${crypto.randomUUID()}`;
    const command = {
      tenantRef,
      externalRef,
      resourceId: resource.id,
      start: d('2027-06-01T10:00:00Z'),
      end: d('2027-06-01T12:00:00Z'),
      bufferAfterMs: 2 * HOUR,
      revision: 1,
      source: 'host-booking',
    };

    const [first, replay] = await Promise.all([
      store.createExternalReservation(command),
      store.createExternalReservation(command),
    ]);
    expect(first.ok).toBe(true);
    expect(replay.ok).toBe(true);
    if (!first.ok || !replay.ok) throw new Error('expected external reservation success');
    expect([first.idempotent, replay.idempotent].sort()).toEqual([false, true]);
    expect(replay.reservation.id).toBe(first.reservation.id);

    const count = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM slotlock.reservations
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${externalRef}`;
    expect(count[0]?.count).toBe(1);

    const insideBuffer = await store.createExternalReservation({
      tenantRef,
      externalRef: `booking-${crypto.randomUUID()}`,
      resourceId: resource.id,
      start: d('2027-06-01T13:00:00Z'),
      end: d('2027-06-01T14:00:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    expect(insideBuffer).toMatchObject({ ok: false, code: 'overlap' });

    const exactBoundary = await store.createExternalReservation({
      tenantRef,
      externalRef: `booking-${crypto.randomUUID()}`,
      resourceId: resource.id,
      start: d('2027-06-01T14:00:00Z'),
      end: d('2027-06-01T15:00:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    expect(exactBoundary.ok).toBe(true);
  });

  it('rejects external-key payload drift and rolls a conflicting reschedule back', async () => {
    const tenantRef = `operator-${crypto.randomUUID()}`;
    const resource = await store.createResource({
      externalRef: `reschedule-resource-${crypto.randomUUID()}`,
      tenantRef,
    });
    const externalRef = `booking-${crypto.randomUUID()}`;
    const created = await store.createExternalReservation({
      tenantRef,
      externalRef,
      resourceId: resource.id,
      start: d('2027-07-01T10:00:00Z'),
      end: d('2027-07-01T12:00:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    expect(created.ok).toBe(true);
    const blocker = await store.createExternalReservation({
      tenantRef,
      externalRef: `booking-${crypto.randomUUID()}`,
      resourceId: resource.id,
      start: d('2027-07-01T16:00:00Z'),
      end: d('2027-07-01T18:00:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    expect(blocker.ok).toBe(true);

    const drift = await store.createExternalReservation({
      tenantRef,
      externalRef,
      resourceId: resource.id,
      start: d('2027-07-01T11:00:00Z'),
      end: d('2027-07-01T13:00:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    expect(drift).toMatchObject({ ok: false, code: 'idempotency_conflict' });

    const refused = await store.rescheduleExternalReservation({
      tenantRef,
      externalRef,
      resourceId: resource.id,
      start: d('2027-07-01T17:00:00Z'),
      end: d('2027-07-01T19:00:00Z'),
      bufferAfterMs: 0,
      revision: 2,
    });
    expect(refused).toMatchObject({ ok: false, code: 'overlap' });
    const unchanged = await sql<{ starts_at: Date; ends_at: Date }[]>`
      SELECT starts_at, ends_at FROM slotlock.reservations
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${externalRef}`;
    expect(unchanged[0]?.starts_at.toISOString()).toBe('2027-07-01T10:00:00.000Z');
    expect(unchanged[0]?.ends_at.toISOString()).toBe('2027-07-01T12:00:00.000Z');

    const moved = await store.rescheduleExternalReservation({
      tenantRef,
      externalRef,
      resourceId: resource.id,
      start: d('2027-07-01T12:00:00Z'),
      end: d('2027-07-01T14:00:00Z'),
      bufferAfterMs: HOUR,
      revision: 2,
    });
    const replay = await store.rescheduleExternalReservation({
      tenantRef,
      externalRef,
      resourceId: resource.id,
      start: d('2027-07-01T12:00:00Z'),
      end: d('2027-07-01T14:00:00Z'),
      bufferAfterMs: HOUR,
      revision: 2,
    });
    expect(moved).toMatchObject({ ok: true, idempotent: false });
    expect(replay).toMatchObject({ ok: true, idempotent: true });

    const movedAgain = await store.rescheduleExternalReservation({
      tenantRef,
      externalRef,
      resourceId: resource.id,
      start: d('2027-07-01T13:00:00Z'),
      end: d('2027-07-01T15:00:00Z'),
      bufferAfterMs: 0,
      revision: 3,
    });
    expect(movedAgain).toMatchObject({ ok: true, idempotent: false });
    const delayedMove = await store.rescheduleExternalReservation({
      tenantRef,
      externalRef,
      resourceId: resource.id,
      start: d('2027-07-01T12:00:00Z'),
      end: d('2027-07-01T14:00:00Z'),
      bufferAfterMs: HOUR,
      revision: 2,
    });
    expect(delayedMove).toEqual({ ok: false, code: 'stale_revision' });
    const latest = await sql<{ starts_at: Date; ends_at: Date; revision: number }[]>`
      SELECT starts_at, ends_at, revision::int AS revision FROM slotlock.reservations
       WHERE tenant_ref = ${tenantRef} AND external_ref = ${externalRef}`;
    expect(latest[0]).toMatchObject({ revision: 3 });
    expect(latest[0]?.starts_at.toISOString()).toBe('2027-07-01T13:00:00.000Z');
    expect(latest[0]?.ends_at.toISOString()).toBe('2027-07-01T15:00:00.000Z');
  });

  it('serializes competing reschedules at one revision so exactly one command wins', async () => {
    const tenantRef = `operator-${crypto.randomUUID()}`;
    const resource = await store.createResource({
      externalRef: `revision-race-resource-${crypto.randomUUID()}`,
      tenantRef,
    });
    const externalRef = `booking-${crypto.randomUUID()}`;
    expect(
      await store.createExternalReservation({
        tenantRef,
        externalRef,
        resourceId: resource.id,
        start: d('2027-07-10T10:00:00Z'),
        end: d('2027-07-10T11:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      }),
    ).toMatchObject({ ok: true });

    const results = await Promise.all([
      store.rescheduleExternalReservation({
        tenantRef,
        externalRef,
        resourceId: resource.id,
        start: d('2027-07-10T12:00:00Z'),
        end: d('2027-07-10T13:00:00Z'),
        bufferAfterMs: 0,
        revision: 2,
      }),
      store.rescheduleExternalReservation({
        tenantRef,
        externalRef,
        resourceId: resource.id,
        start: d('2027-07-10T14:00:00Z'),
        end: d('2027-07-10T15:00:00Z'),
        bufferAfterMs: 0,
        revision: 2,
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, code: 'idempotency_conflict' },
    ]);
  });

  it('cancels an external reservation only inside its owning tenant', async () => {
    const tenantRef = `operator-${crypto.randomUUID()}`;
    const resource = await store.createResource({
      externalRef: `cancel-resource-${crypto.randomUUID()}`,
      tenantRef,
    });
    const externalRef = `booking-${crypto.randomUUID()}`;
    expect(
      await store.createExternalReservation({
        tenantRef,
        externalRef,
        resourceId: resource.id,
        start: d('2027-08-01T10:00:00Z'),
        end: d('2027-08-01T12:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      }),
    ).toMatchObject({ ok: true });

    await expect(
      store.rescheduleExternalReservation({
        tenantRef: 'another-operator',
        externalRef,
        resourceId: resource.id,
        start: d('2027-08-01T12:00:00Z'),
        end: d('2027-08-01T14:00:00Z'),
        bufferAfterMs: 0,
        revision: 2,
      }),
    ).resolves.toEqual({ ok: false, code: 'reservation_not_found' });

    await expect(
      store.cancelExternalReservation({
        tenantRef: 'another-operator',
        externalRef,
        revision: 2,
      }),
    ).resolves.toEqual({ ok: true, cancelled: false, revision: 2 });
    await expect(
      store.cancelExternalReservation({ tenantRef, externalRef, revision: 2 }),
    ).resolves.toEqual({ ok: true, cancelled: true, revision: 2 });
    await expect(
      store.cancelExternalReservation({ tenantRef, externalRef, revision: 2 }),
    ).resolves.toEqual({ ok: true, cancelled: false, revision: 2 });

    await expect(
      store.createExternalReservation({
        tenantRef,
        externalRef,
        resourceId: resource.id,
        start: d('2027-08-01T10:00:00Z'),
        end: d('2027-08-01T12:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      }),
    ).resolves.toEqual({ ok: false, code: 'reservation_cancelled' });
  });

  it('serializes create against cancellation and always leaves a terminal tombstone', async () => {
    const tenantRef = `operator-${crypto.randomUUID()}`;
    const resource = await store.createResource({
      externalRef: `cancel-race-resource-${crypto.randomUUID()}`,
      tenantRef,
    });
    const externalRef = `booking-${crypto.randomUUID()}`;
    const [createResult, cancelResult] = await Promise.all([
      store.createExternalReservation({
        tenantRef,
        externalRef,
        resourceId: resource.id,
        start: d('2027-08-10T10:00:00Z'),
        end: d('2027-08-10T12:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      }),
      store.cancelExternalReservation({ tenantRef, externalRef, revision: 2 }),
    ]);
    expect(cancelResult.ok).toBe(true);
    expect(
      createResult.ok || createResult.code === 'reservation_cancelled',
      JSON.stringify(createResult),
    ).toBe(true);
    const state = await sql<{ reservations: number; tombstones: number }[]>`
      SELECT
        (SELECT count(*)::int FROM slotlock.reservations
          WHERE tenant_ref = ${tenantRef} AND external_ref = ${externalRef}) AS reservations,
        (SELECT count(*)::int FROM slotlock.reservation_tombstones
          WHERE tenant_ref = ${tenantRef} AND external_ref = ${externalRef}) AS tombstones`;
    expect(state[0]).toEqual({ reservations: 0, tombstones: 1 });
  });

  it('strict tenant RLS hides every foreign and unset-context core row from a non-owner role', async () => {
    const role = 'slotlock_core_rls_probe';
    const tenantA = `operator-${crypto.randomUUID()}`;
    const tenantB = `operator-${crypto.randomUUID()}`;
    const resourceA = await store.createResource({
      externalRef: `rls-a-${crypto.randomUUID()}`,
      tenantRef: tenantA,
    });
    const resourceB = await store.createResource({
      externalRef: `rls-b-${crypto.randomUUID()}`,
      tenantRef: tenantB,
    });
    await store.createExternalReservation({
      tenantRef: tenantA,
      externalRef: `booking-${crypto.randomUUID()}`,
      resourceId: resourceA.id,
      start: d('2027-08-24T10:00:00Z'),
      end: d('2027-08-24T12:00:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    await store.createExternalReservation({
      tenantRef: tenantB,
      externalRef: `booking-${crypto.randomUUID()}`,
      resourceId: resourceB.id,
      start: d('2027-08-25T10:00:00Z'),
      end: d('2027-08-25T12:00:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    const cancelledA = `cancelled-${crypto.randomUUID()}`;
    const cancelledB = `cancelled-${crypto.randomUUID()}`;
    for (const [tenantRef, externalRef, resourceId, day] of [
      [tenantA, cancelledA, resourceA.id, '26'],
      [tenantB, cancelledB, resourceB.id, '27'],
    ] as const) {
      await store.createExternalReservation({
        tenantRef,
        externalRef,
        resourceId,
        start: d(`2027-08-${day}T10:00:00Z`),
        end: d(`2027-08-${day}T12:00:00Z`),
        bufferAfterMs: 0,
        revision: 1,
      });
      await store.cancelExternalReservation({ tenantRef, externalRef, revision: 2 });
    }
    const archiveA = crypto.randomUUID();
    const archiveB = crypto.randomUUID();
    await sql`
      INSERT INTO slotlock.reservation_conflict_archive
        (archive_id, tenant_ref, original_reservation_id, original_resource_id, keeper_resource_id,
         external_ref, starts_at, ends_at, status, original_created_at, reason)
      VALUES
        (${archiveA}::uuid, ${tenantA}, ${crypto.randomUUID()}::uuid, ${crypto.randomUUID()}::uuid,
         ${resourceA.id}::uuid, ${resourceA.externalRef}, '2027-08-28T10:00:00Z',
         '2027-08-28T12:00:00Z', 'held', now(), 'rls-a'),
        (${archiveB}::uuid, ${tenantB}, ${crypto.randomUUID()}::uuid, ${crypto.randomUUID()}::uuid,
         ${resourceB.id}::uuid, ${resourceB.externalRef}, '2027-08-28T10:00:00Z',
         '2027-08-28T12:00:00Z', 'held', now(), 'rls-b')`;

    await store.applyTenantRls();
    await sql.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await sql.unsafe(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA slotlock TO ${role}`);
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA slotlock TO ${role}`,
    );

    try {
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        const unset = await tx<
          { resources: number; reservations: number; tombstones: number; archives: number }[]
        >`
          SELECT
            (SELECT count(*)::int FROM slotlock.resources) AS resources,
            (SELECT count(*)::int FROM slotlock.reservations) AS reservations,
            (SELECT count(*)::int FROM slotlock.reservation_tombstones) AS tombstones,
            (SELECT count(*)::int FROM slotlock.reservation_conflict_archive) AS archives`;
        expect(unset[0]).toEqual({ resources: 0, reservations: 0, tombstones: 0, archives: 0 });
      });

      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`SELECT set_config('slotlock.tenant_ref', ${tenantA}, true)`;
        const visible = await tx<{ id: string }[]>`
          SELECT id FROM slotlock.resources ORDER BY id`;
        expect(visible).toEqual([{ id: resourceA.id }]);
        const owned = await tx<{ reservations: number; tombstones: number; archives: number }[]>`
          SELECT
            (SELECT count(*)::int FROM slotlock.reservations) AS reservations,
            (SELECT count(*)::int FROM slotlock.reservation_tombstones) AS tombstones,
            (SELECT count(*)::int FROM slotlock.reservation_conflict_archive) AS archives`;
        expect(owned[0]).toEqual({ reservations: 1, tombstones: 1, archives: 1 });
        const foreignWrite = await tx<{ id: string }[]>`
          UPDATE slotlock.resources SET timezone = 'Europe/Paris'
           WHERE id = ${resourceB.id} RETURNING id`;
        expect(foreignWrite).toEqual([]);
        const foreignTombstoneDelete = await tx<{ external_ref: string }[]>`
          DELETE FROM slotlock.reservation_tombstones
           WHERE external_ref = ${cancelledB} RETURNING external_ref`;
        expect(foreignTombstoneDelete).toEqual([]);
        const foreignArchiveDelete = await tx<{ archive_id: string }[]>`
          DELETE FROM slotlock.reservation_conflict_archive
           WHERE archive_id = ${archiveB}::uuid RETURNING archive_id`;
        expect(foreignArchiveDelete).toEqual([]);
      });

      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        const scopedStore = createSlotlockStore(tx);
        const busy = await scopedStore.withTenant(tenantA, (tenantStore) =>
          tenantStore.listBusy(resourceA.id, {
            start: d('2027-08-24T00:00:00Z'),
            end: d('2027-08-25T00:00:00Z'),
          }),
        );
        expect(busy).toEqual([
          { start: d('2027-08-24T10:00:00Z'), end: d('2027-08-24T12:00:00Z') },
        ]);
        const restored = await tx<{ value: string | null }[]>`
          SELECT current_setting('slotlock.tenant_ref', true) AS value`;
        expect(restored[0]?.value ?? '').toBe('');
      });

      const sharedExternalRef = `shared-resource-${crypto.randomUUID()}`;
      const createRestrictedResource = async (tenantRef: string, timezone: string) =>
        sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          await tx`SELECT set_config('slotlock.tenant_ref', ${tenantRef}, true)`;
          return createSlotlockStore(tx).createResource({
            tenantRef,
            externalRef: sharedExternalRef,
            timezone,
          });
        });
      const sharedA = await createRestrictedResource(tenantA, 'Europe/London');
      const sharedB = await createRestrictedResource(tenantB, 'Europe/Paris');
      expect(sharedA.id).not.toBe(sharedB.id);
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`SELECT set_config('slotlock.tenant_ref', ${tenantA}, true)`;
        const visible = await tx<{ id: string; timezone: string }[]>`
          SELECT id, timezone FROM slotlock.resources
           WHERE external_ref = ${sharedExternalRef}`;
        expect(visible).toEqual([{ id: sharedA.id, timezone: 'Europe/London' }]);
      });
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`SELECT set_config('slotlock.tenant_ref', ${tenantB}, true)`;
        const visible = await tx<{ id: string; timezone: string }[]>`
          SELECT id, timezone FROM slotlock.resources
           WHERE external_ref = ${sharedExternalRef}`;
        expect(visible).toEqual([{ id: sharedB.id, timezone: 'Europe/Paris' }]);
      });
    } finally {
      await sql.unsafe(`DROP OWNED BY ${role}`);
      await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  });

  it('rejects an accidental tenant-context rebind but permits an explicit migration', async () => {
    const otherContextStore = createSlotlockStore(sql, {
      tenantContextSetting: 'app.other_tenant',
    });
    await expect(otherContextStore.applyTenantRls()).rejects.toMatchObject({
      code: 'tenant_context_conflict',
    });
    await expect(otherContextStore.applyTenantRls({ allowRebind: true })).resolves.toBeUndefined();
    await expect(store.applyTenantRls()).rejects.toMatchObject({
      code: 'tenant_context_conflict',
    });
    await expect(store.applyTenantRls({ allowRebind: true })).resolves.toBeUndefined();
  });

  it('database backstops tenant ownership and the materialized occupied end', async () => {
    const tenantRef = `operator-${crypto.randomUUID()}`;
    const resource = await store.createResource({
      externalRef: `backstop-resource-${crypto.randomUUID()}`,
      tenantRef,
    });

    await expect(
      sql`
        INSERT INTO slotlock.reservations (
          resource_id, tenant_ref, external_ref, starts_at, ends_at, buffer_after_ms
        ) VALUES (
          ${resource.id}, 'another-operator', ${`booking-${crypto.randomUUID()}`},
          ${d('2027-09-01T10:00:00Z')}, ${d('2027-09-01T12:00:00Z')}, 0
        )`,
    ).rejects.toMatchObject({ code: '23503' });

    const created = await store.createExternalReservation({
      tenantRef,
      externalRef: `booking-${crypto.randomUUID()}`,
      resourceId: resource.id,
      start: d('2027-09-02T10:00:00Z'),
      end: d('2027-09-02T12:00:00Z'),
      bufferAfterMs: HOUR,
      revision: 1,
    });
    if (!created.ok) throw new Error('expected external reservation success');
    await expect(
      sql`
        UPDATE slotlock.reservations
           SET occupied_ends_at = ends_at
         WHERE id = ${created.reservation.id}`,
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      sql`
        UPDATE slotlock.reservations
           SET occupied_ends_at = NULL
         WHERE id = ${created.reservation.id}`,
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects invalid resource timezones before persisting them', async () => {
    await expect(
      store.createResource({
        externalRef: `bad-zone-${crypto.randomUUID()}`,
        timezone: 'Mars/Olympus',
      }),
    ).rejects.toMatchObject({ code: 'invalid_timezone' });
  });

  it('creates a reservation and rejects an overlapping one with a structured conflict', async () => {
    const first = await store.createReservation({
      resourceId,
      start: d('2027-02-01T10:00:00Z'),
      end: d('2027-02-01T14:00:00Z'),
      source: 'spike',
    });
    expect(first.ok).toBe(true);

    const clash = await store.createReservation({
      resourceId,
      start: d('2027-02-01T12:00:00Z'),
      end: d('2027-02-01T16:00:00Z'),
    });
    expect(clash.ok).toBe(false);
    if (clash.ok) throw new Error('expected conflict');
    expect(clash.code).toBe('overlap');
    if (clash.code !== 'overlap') throw new Error('expected overlap code');
    expect(clash.conflictingReservationId).toBe(first.ok ? first.reservation.id : null);
  });

  it('back-to-back reservations are accepted (half-open [) — the Phase-0 canon)', async () => {
    const second = await store.createReservation({
      resourceId,
      start: d('2027-02-01T14:00:00Z'), // exactly at the first one's end
      end: d('2027-02-01T15:00:00Z'),
    });
    expect(second.ok).toBe(true);
  });

  it('rejects an inverted or zero-length window before touching the table', async () => {
    const inverted = await store.createReservation({
      resourceId,
      start: d('2027-02-02T14:00:00Z'),
      end: d('2027-02-02T10:00:00Z'),
    });
    expect(inverted).toEqual({ ok: false, code: 'invalid_window' });
    const zero = await store.createReservation({
      resourceId,
      start: d('2027-02-02T10:00:00Z'),
      end: d('2027-02-02T10:00:00Z'),
    });
    expect(zero).toEqual({ ok: false, code: 'invalid_window' });
  });

  it('rejects non-finite dates at every store boundary before the database driver sees them', async () => {
    const invalid = new Date(Number.NaN);
    await expect(
      store.createReservation({
        resourceId,
        start: invalid,
        end: d('2027-02-02T12:00:00Z'),
      }),
    ).resolves.toEqual({ ok: false, code: 'invalid_window' });
    await expect(
      store.acquireHold({
        resourceId,
        start: d('2027-02-02T10:00:00Z'),
        end: invalid,
        ttlMs: 60_000,
      }),
    ).resolves.toEqual({ ok: false, code: 'invalid_window' });
    await expect(
      store.listBusy(resourceId, { start: invalid, end: d('2027-02-02T12:00:00Z') }),
    ).rejects.toMatchObject({ code: 'invalid_window' });
    await expect(
      store.findNextAvailableFor({
        resourceId,
        rules: [],
        searchWindow: { start: d('2027-02-02T10:00:00Z'), end: invalid },
        durationMs: HOUR,
      }),
    ).rejects.toMatchObject({ code: 'invalid_window' });
  });

  it('CONCURRENT race: two parallel overlapping inserts — exactly one wins (the DB arbiter)', async () => {
    const race = await Promise.all([
      store.createReservation({
        resourceId,
        start: d('2027-03-01T09:00:00Z'),
        end: d('2027-03-01T12:00:00Z'),
        source: 'racer-a',
      }),
      store.createReservation({
        resourceId,
        start: d('2027-03-01T10:00:00Z'),
        end: d('2027-03-01T13:00:00Z'),
        source: 'racer-b',
      }),
    ]);
    const winners = race.filter((r) => r.ok);
    const losers = race.filter((r) => !r.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0] && !losers[0].ok && losers[0].code).toBe('overlap');
  });

  it('reservations on ANOTHER resource never conflict (per-resource isolation)', async () => {
    const other = await store.createResource({ externalRef: 'spike-vehicle-2' });
    const r = await store.createReservation({
      resourceId: other.id,
      start: d('2027-02-01T10:00:00Z'), // same window as vehicle-1's first reservation
      end: d('2027-02-01T14:00:00Z'),
    });
    expect(r.ok).toBe(true);
  });

  it('findNextAvailable E2E: rules × live busy → the first real gap', async () => {
    // Fresh resource, bookable Mon-Fri 08:00-18:00 UTC; busy Mon 08:00-10:00 and 11:00-16:00.
    const res = await store.createResource({ externalRef: 'spike-vehicle-3' });
    await store.createReservation({
      resourceId: res.id,
      start: d('2027-01-04T08:00:00Z'),
      end: d('2027-01-04T10:00:00Z'),
    });
    await store.createReservation({
      resourceId: res.id,
      start: d('2027-01-04T11:00:00Z'),
      end: d('2027-01-04T16:00:00Z'),
    });
    const searchWindow = { start: d('2027-01-04T00:00:00Z'), end: d('2027-01-11T00:00:00Z') };
    const rules = [
      { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 8 * 60, durationMinutes: 10 * 60 },
    ];

    // 1h fits the 10:00-11:00 gap; 3h must roll past it to 16:00 (only 2h left Monday? 16-18 is
    // 2h — so 3h rolls to Tuesday 08:00).
    const busy = await store.listBusy(res.id, searchWindow);
    const windows = expandRules(rules, searchWindow);

    expect(findNextAvailable({ busy, windows, durationMs: 1 * HOUR })).toEqual({
      start: d('2027-01-04T10:00:00Z'),
      end: d('2027-01-04T11:00:00Z'),
    });
    expect(findNextAvailable({ busy, windows, durationMs: 3 * HOUR })).toEqual({
      start: d('2027-01-05T08:00:00Z'),
      end: d('2027-01-05T11:00:00Z'),
    });

    // The convenience wrapper agrees with the composed pure calls.
    const viaStore = await store.findNextAvailableFor({
      resourceId: res.id,
      rules,
      searchWindow,
      durationMs: 3 * HOUR,
    });
    expect(viaStore).toEqual({
      start: d('2027-01-05T08:00:00Z'),
      end: d('2027-01-05T11:00:00Z'),
    });
  });

  it('empty rules → findNextAvailableFor suggests nothing', async () => {
    const viaStore = await store.findNextAvailableFor({
      resourceId,
      rules: [],
      searchWindow: { start: d('2027-01-04T00:00:00Z'), end: d('2027-01-11T00:00:00Z') },
      durationMs: HOUR,
    });
    expect(viaStore).toBeNull();
  });

  // ── Atomic holds with intrinsic expiry (Phase 1, slice 2) ─────────────────────
  // A hold OCCUPIES under the same EXCLUDE arbiter until its DB-clock expiry; expired holds are
  // lazily reaped inside the very transaction that wants their space — no cron, and an
  // expired-but-unpurged hold can never block (the P1·5 lesson, made intrinsic).

  describe('atomic holds', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('a live hold blocks a rival reservation, back-to-back beside it is fine', async () => {
      const res = await store.createResource({ externalRef: 'holds-vehicle-1' });
      const hold = await store.acquireHold({
        resourceId: res.id,
        start: d('2027-04-01T10:00:00Z'),
        end: d('2027-04-01T12:00:00Z'),
        ttlMs: 60_000,
        source: 'agent-negotiation',
      });
      expect(hold.ok).toBe(true);
      if (!hold.ok) throw new Error('hold failed');
      expect(hold.hold.expiresAt.getTime()).toBeGreaterThan(Date.now());

      const rival = await store.createReservation({
        resourceId: res.id,
        start: d('2027-04-01T11:00:00Z'),
        end: d('2027-04-01T13:00:00Z'),
      });
      expect(rival.ok).toBe(false);
      if (rival.ok) throw new Error('expected refusal');
      expect(rival.code).toBe('overlap');
      if (rival.code === 'overlap') {
        expect(rival.conflictingReservationId).toBe(hold.hold.id);
      }

      const backToBack = await store.createReservation({
        resourceId: res.id,
        start: d('2027-04-01T12:00:00Z'),
        end: d('2027-04-01T13:00:00Z'),
      });
      expect(backToBack.ok).toBe(true);
    });

    it('confirmHold before expiry → confirmed reservation that keeps blocking', async () => {
      const res = await store.createResource({ externalRef: 'holds-vehicle-2' });
      const hold = await store.acquireHold({
        resourceId: res.id,
        start: d('2027-04-02T10:00:00Z'),
        end: d('2027-04-02T12:00:00Z'),
        ttlMs: 60_000,
      });
      if (!hold.ok) throw new Error('hold failed');

      const confirmed = await store.confirmHold(hold.hold.id);
      expect(confirmed.ok).toBe(true);
      if (!confirmed.ok) throw new Error('confirm failed');
      expect(confirmed.reservation.id).toBe(hold.hold.id);

      const row = await sql<{ status: string; expires_at: Date | null }[]>`
        SELECT status, expires_at FROM slotlock.reservations WHERE id = ${hold.hold.id}`;
      expect(row[0]?.status).toBe('confirmed');
      expect(row[0]?.expires_at).toBeNull();

      const rival = await store.createReservation({
        resourceId: res.id,
        start: d('2027-04-02T11:00:00Z'),
        end: d('2027-04-02T12:30:00Z'),
      });
      expect(rival.ok).toBe(false);
    });

    it('an EXPIRED hold is reaped by the rival that wants its space (no cron)', async () => {
      const res = await store.createResource({ externalRef: 'holds-vehicle-3' });
      const hold = await store.acquireHold({
        resourceId: res.id,
        start: d('2027-04-03T10:00:00Z'),
        end: d('2027-04-03T12:00:00Z'),
        ttlMs: 100,
      });
      if (!hold.ok) throw new Error('hold failed');
      await sleep(200);

      const rival = await store.createReservation({
        resourceId: res.id,
        start: d('2027-04-03T11:00:00Z'),
        end: d('2027-04-03T13:00:00Z'),
      });
      expect(rival.ok).toBe(true);

      const gone = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM slotlock.reservations WHERE id = ${hold.hold.id}`;
      expect(gone[0]?.n).toBe(0);
    });

    it('confirmHold classifies: present-but-expired → hold_expired; absent → hold_not_found', async () => {
      const res = await store.createResource({ externalRef: 'holds-vehicle-4' });
      const hold = await store.acquireHold({
        resourceId: res.id,
        start: d('2027-04-04T10:00:00Z'),
        end: d('2027-04-04T12:00:00Z'),
        ttlMs: 100,
      });
      if (!hold.ok) throw new Error('hold failed');
      await sleep(200);

      const expired = await store.confirmHold(hold.hold.id);
      expect(expired).toEqual({ ok: false, code: 'hold_expired' });

      const missing = await store.confirmHold('00000000-0000-0000-0000-000000000000');
      expect(missing).toEqual({ ok: false, code: 'hold_not_found' });
    });

    it('releaseHold frees the window immediately', async () => {
      const res = await store.createResource({ externalRef: 'holds-vehicle-5' });
      const hold = await store.acquireHold({
        resourceId: res.id,
        start: d('2027-04-05T10:00:00Z'),
        end: d('2027-04-05T12:00:00Z'),
        ttlMs: 60_000,
      });
      if (!hold.ok) throw new Error('hold failed');
      const released = await store.releaseHold(hold.hold.id);
      expect(released).toEqual({ ok: true, released: true });

      const rival = await store.createReservation({
        resourceId: res.id,
        start: d('2027-04-05T10:00:00Z'),
        end: d('2027-04-05T12:00:00Z'),
      });
      expect(rival.ok).toBe(true);

      const again = await store.releaseHold(hold.hold.id);
      expect(again).toEqual({ ok: true, released: false });
    });

    it('RACE: two parallel holds on one window — exactly one wins', async () => {
      const res = await store.createResource({ externalRef: 'holds-vehicle-6' });
      const race = await Promise.all([
        store.acquireHold({
          resourceId: res.id,
          start: d('2027-04-06T10:00:00Z'),
          end: d('2027-04-06T12:00:00Z'),
          ttlMs: 60_000,
          source: 'racer-a',
        }),
        store.acquireHold({
          resourceId: res.id,
          start: d('2027-04-06T11:00:00Z'),
          end: d('2027-04-06T13:00:00Z'),
          ttlMs: 60_000,
          source: 'racer-b',
        }),
      ]);
      expect(race.filter((r) => r.ok)).toHaveLength(1);
      const loser = race.find((r) => !r.ok);
      expect(loser && !loser.ok && loser.code).toBe('overlap');
    });

    it('non-positive / non-finite / absurd ttl is refused before touching the table', async () => {
      for (const ttlMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e15]) {
        const bad = await store.acquireHold({
          resourceId,
          start: d('2027-04-07T10:00:00Z'),
          end: d('2027-04-07T12:00:00Z'),
          ttlMs,
        });
        expect(bad, `ttlMs=${ttlMs}`).toEqual({ ok: false, code: 'invalid_ttl' });
      }
    });

    it('confirmHold is idempotent: a retried confirm of a confirmed hold is SUCCESS', async () => {
      const res = await store.createResource({ externalRef: 'holds-vehicle-9' });
      const hold = await store.acquireHold({
        resourceId: res.id,
        start: d('2027-04-09T10:00:00Z'),
        end: d('2027-04-09T12:00:00Z'),
        ttlMs: 60_000,
      });
      if (!hold.ok) throw new Error('hold failed');
      const first = await store.confirmHold(hold.hold.id);
      expect(first.ok).toBe(true);
      const replay = await store.confirmHold(hold.hold.id);
      expect(replay.ok).toBe(true);
      if (!replay.ok) throw new Error('replay failed');
      expect(replay.reservation.id).toBe(hold.hold.id);
    });

    it("findNextAvailableFor treats a live hold as busy and an expired hold's window as free", async () => {
      const res = await store.createResource({ externalRef: 'holds-vehicle-7' });
      const searchWindow = { start: d('2027-01-04T00:00:00Z'), end: d('2027-01-05T00:00:00Z') };
      const rules = [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 8 * 60, durationMinutes: 4 * 60 }, // 08-12
      ];
      const live = await store.acquireHold({
        resourceId: res.id,
        start: d('2027-01-04T08:00:00Z'),
        end: d('2027-01-04T10:00:00Z'),
        ttlMs: 60_000,
      });
      if (!live.ok) throw new Error('hold failed');

      const withLive = await store.findNextAvailableFor({
        resourceId: res.id,
        rules,
        searchWindow,
        durationMs: 2 * HOUR,
      });
      expect(withLive).toEqual({
        start: d('2027-01-04T10:00:00Z'),
        end: d('2027-01-04T12:00:00Z'),
      });

      await store.releaseHold(live.hold.id);
      const expiring = await store.acquireHold({
        resourceId: res.id,
        start: d('2027-01-04T08:00:00Z'),
        end: d('2027-01-04T10:00:00Z'),
        ttlMs: 100,
      });
      if (!expiring.ok) throw new Error('hold failed');
      await sleep(200);

      const afterExpiry = await store.findNextAvailableFor({
        resourceId: res.id,
        rules,
        searchWindow,
        durationMs: 2 * HOUR,
      });
      expect(afterExpiry).toEqual({
        start: d('2027-01-04T08:00:00Z'),
        end: d('2027-01-04T10:00:00Z'),
      });
    });

    it('the CHECK backstop rejects a held row without expiry inserted around the store (23514)', async () => {
      const res = await store.createResource({ externalRef: 'holds-vehicle-8' });
      let code: string | undefined;
      try {
        await sql`
          INSERT INTO slotlock.reservations (resource_id, starts_at, ends_at, status, expires_at)
          VALUES (${res.id}, ${d('2027-04-08T10:00:00Z')}, ${d('2027-04-08T12:00:00Z')}, 'held', NULL)`;
      } catch (err) {
        let cur = err as { code?: string; cause?: unknown } | undefined;
        while (cur && typeof cur === 'object') {
          if (typeof cur.code === 'string') {
            code = cur.code;
            break;
          }
          cur = cur.cause as typeof cur;
        }
      }
      expect(code).toBe('23514');
    });
  });

  it("findNextAvailableFor expands rules in the RESOURCE'S stored timezone", async () => {
    // Auckland winter = NZST (UTC+12): local Monday 09:00 is Sunday 21:00Z. A search window
    // ending at UTC Monday 00:00 contains NO UTC-frame Monday — only the zone-aware expansion
    // finds the slot.
    const resource = await store.createResource({ timezone: 'Pacific/Auckland' });
    const slot = await store.findNextAvailableFor({
      resourceId: resource.id,
      rules: [{ rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 9 * 60, durationMinutes: 120 }],
      searchWindow: {
        start: new Date('2027-07-04T00:00:00Z'),
        end: new Date('2027-07-05T00:00:00Z'),
      },
      durationMs: 60 * 60 * 1000,
    });
    expect(slot).toEqual({
      start: new Date('2027-07-04T21:00:00.000Z'),
      end: new Date('2027-07-04T22:00:00.000Z'),
    });
  });
});
