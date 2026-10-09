import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE,
  type SlotlockStore,
  createSlotlockStore,
} from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const d = (iso: string) => new Date(iso);

describe.skipIf(!url)('Slotlock calendar events (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let tenantRef: string;
  let resourceId: string;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    tenantRef = `event-tenant-${crypto.randomUUID()}`;
    resourceId = (
      await store.createResource({
        externalRef: `event-resource-${crypto.randomUUID()}`,
        tenantRef,
        timezone: 'Europe/London',
      })
    ).id;
  });

  afterAll(async () => {
    await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.calendar_event_occurrences WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.calendar_coverage WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.reservations WHERE tenant_ref = ${tenantRef}`;
    await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
    await sql.end();
  });

  it('creates, replays, revises and lists a recurrence through the reservation arbiter', async () => {
    const externalRef = `event-${crypto.randomUUID()}`;
    const command = {
      tenantRef,
      externalRef,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: d('2027-03-27T09:00:00Z'),
      end: d('2027-03-27T10:00:00Z'),
      timezone: 'Europe/London',
      summary: 'Vehicle handover',
      transparency: 'opaque' as const,
      organizer: { email: 'fleet@example.com', name: 'Fleet Desk' },
      attendees: [
        {
          email: 'agent@example.com',
          participationStatus: 'accepted' as const,
          rsvp: true,
        },
      ],
      reminders: [{ action: 'display' as const, minutesBeforeStart: 30 }],
      recurrence: { rrule: 'FREQ=DAILY;COUNT=2' },
      materializationWindow: {
        start: d('2027-03-27T00:00:00Z'),
        end: d('2027-03-30T00:00:00Z'),
      },
    };

    const created = await store.putCalendarEvent(command);
    const replay = await store.putCalendarEvent(command);
    expect(created).toMatchObject({ ok: true, revision: 1, idempotent: false, occurrenceCount: 2 });
    expect(replay).toEqual({ ...created, idempotent: true });

    const drift = await store.putCalendarEvent({ ...command, summary: 'Changed under replay key' });
    expect(drift).toEqual({ ok: false, code: 'idempotency_conflict' });

    const busy = await store.listBusy(resourceId, command.materializationWindow);
    expect(busy.map((interval) => interval.start.toISOString())).toEqual([
      '2027-03-27T09:00:00.000Z',
      '2027-03-28T08:00:00.000Z',
    ]);

    const fetched = await store.getCalendarEvent({ tenantRef, externalRef });
    expect(fetched).toMatchObject({
      externalRef,
      revision: 1,
      summary: 'Vehicle handover',
      organizer: { email: 'fleet@example.com', name: 'Fleet Desk' },
    });
    const listed = await store.listCalendarEvents({
      tenantRef,
      resourceId,
      window: command.materializationWindow,
    });
    expect(listed.map((event) => event.externalRef)).toContain(externalRef);
    const firstPage = listed[0];
    if (!firstPage) throw new Error('calendar list fixture failed');
    await expect(
      store.listCalendarEvents({
        tenantRef,
        resourceId,
        window: command.materializationWindow,
        limit: 1,
        after: { start: firstPage.start, id: firstPage.id },
      }),
    ).resolves.toEqual([]);

    const stale = await store.putCalendarEvent({
      ...command,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      summary: 'Stale update',
    });
    expect(stale).toEqual({ ok: false, code: 'revision_conflict', currentRevision: 1 });

    const madeTransparent = await store.putCalendarEvent({
      ...command,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 1,
      transparency: 'transparent',
    });
    expect(madeTransparent).toMatchObject({ ok: true, revision: 2, occurrenceCount: 2 });
    await expect(store.listBusy(resourceId, command.materializationWindow)).resolves.toEqual([]);
  });

  it('writes normalized attendee/reminder/exception children and reads them as canonical', async () => {
    const externalRef = `normalized-event-${crypto.randomUUID()}`;
    const window = {
      start: d('2027-07-01T00:00:00Z'),
      end: d('2027-07-05T00:00:00Z'),
    };
    const command = {
      tenantRef,
      externalRef,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: d('2027-07-01T09:00:00Z'),
      end: d('2027-07-01T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Normalized event',
      transparency: 'transparent' as const,
      attendees: [
        {
          email: 'renter@example.com',
          name: 'Renter',
          role: 'required' as const,
          participationStatus: 'accepted' as const,
          rsvp: true,
        },
      ],
      reminders: [{ action: 'email' as const, minutesBeforeStart: 45 }],
      recurrence: {
        rrule: 'FREQ=DAILY;COUNT=2',
        exceptions: [{ recurrenceId: d('2027-07-02T09:00:00Z'), cancelled: true }],
      },
      materializationWindow: window,
    };
    const created = await store.putCalendarEvent(command);
    if (!created.ok) throw new Error('normalized event fixture failed');

    const [counts] = await sql<{ attendees: number; reminders: number; exceptions: number }[]>`
      SELECT
        (SELECT count(*)::int FROM slotlock.calendar_event_attendees
          WHERE tenant_ref = ${tenantRef} AND event_id = ${created.eventId}) AS attendees,
        (SELECT count(*)::int FROM slotlock.calendar_event_reminders
          WHERE tenant_ref = ${tenantRef} AND event_id = ${created.eventId}) AS reminders,
        (SELECT count(*)::int FROM slotlock.calendar_event_exceptions
          WHERE tenant_ref = ${tenantRef} AND event_id = ${created.eventId}) AS exceptions`;
    expect(counts).toEqual({ attendees: 1, reminders: 1, exceptions: 1 });

    // Compatibility JSON is deliberately not the read authority once normalized rows exist.
    await sql`
      UPDATE slotlock.calendar_events
         SET attendees = '[{"email":"legacy@example.com"}]'::jsonb,
             reminders = '[{"action":"display","minutesBeforeStart":1}]'::jsonb,
             recurrence_exceptions = '[]'::jsonb
       WHERE id = ${created.eventId}`;
    await expect(store.getCalendarEvent({ tenantRef, externalRef })).resolves.toMatchObject({
      attendees: [
        {
          email: 'renter@example.com',
          name: 'Renter',
          role: 'required',
          participationStatus: 'accepted',
          rsvp: true,
        },
      ],
      reminders: [{ action: 'email', minutesBeforeStart: 45 }],
      recurrence: {
        exceptions: [{ recurrenceId: d('2027-07-02T09:00:00Z'), cancelled: true }],
      },
    });

    const revised = await store.putCalendarEvent({
      tenantRef,
      externalRef,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 1,
      resourceId,
      start: command.start,
      end: command.end,
      timezone: command.timezone,
      summary: command.summary,
      transparency: command.transparency,
      recurrence: { rrule: command.recurrence.rrule },
      materializationWindow: window,
    });
    expect(revised).toMatchObject({ ok: true, revision: 2 });
    const cleared = await store.getCalendarEvent({ tenantRef, externalRef });
    expect(cleared?.attendees).toBeUndefined();
    expect(cleared?.reminders).toBeUndefined();
    expect(cleared?.recurrence?.exceptions).toEqual([]);
  });

  it('rolls recurring coverage without changing semantic revision or leaving a visibility gap', async () => {
    const rollingTenant = `rolling-tenant-${crypto.randomUUID()}`;
    const rollingResource = await store.createResource({
      tenantRef: rollingTenant,
      externalRef: `rolling-resource-${crypto.randomUUID()}`,
    });
    const externalRef = `rolling-event-${crypto.randomUUID()}`;
    const initialWindow = {
      start: d('2027-08-01T00:00:00Z'),
      end: d('2027-08-03T00:00:00Z'),
    };
    const created = await store.putCalendarEvent({
      tenantRef: rollingTenant,
      externalRef,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId: rollingResource.id,
      start: d('2027-08-01T09:00:00Z'),
      end: d('2027-08-01T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Rolling recurrence',
      recurrence: { rrule: 'FREQ=DAILY;COUNT=10' },
      materializationWindow: initialWindow,
    });
    expect(created).toMatchObject({ ok: true, revision: 1, occurrenceCount: 2 });

    const rolledWindow = {
      start: d('2027-08-02T00:00:00Z'),
      end: d('2027-08-06T00:00:00Z'),
    };
    await expect(
      store.rollCalendarEventHorizon({ tenantRef: rollingTenant, window: rolledWindow }),
    ).resolves.toMatchObject({ examined: 1, extended: 1, conflicts: 0 });

    const event = await store.getCalendarEvent({ tenantRef: rollingTenant, externalRef });
    expect(event).toMatchObject({ revision: 1, materializationWindow: rolledWindow });
    const busy = await store.listBusy(rollingResource.id, {
      start: d('2027-08-01T00:00:00Z'),
      end: rolledWindow.end,
    });
    expect(busy.map((entry) => entry.start.toISOString())).toEqual([
      '2027-08-02T09:00:00.000Z',
      '2027-08-03T09:00:00.000Z',
      '2027-08-04T09:00:00.000Z',
      '2027-08-05T09:00:00.000Z',
    ]);
    await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${rollingTenant}`;
    await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${rollingTenant}`;
    await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${rollingTenant}`;
  });

  it('marks free/busy incomplete outside the local recurrence materialization horizon', async () => {
    const recurrenceTenant = `recurrence-coverage-tenant-${crypto.randomUUID()}`;
    const recurrenceResource = await store.createResource({
      tenantRef: recurrenceTenant,
      externalRef: `recurrence-coverage-resource-${crypto.randomUUID()}`,
    });
    const materializationWindow = {
      start: d('2027-08-01T00:00:00Z'),
      end: d('2027-08-03T00:00:00Z'),
    };
    const created = await store.putCalendarEvent({
      tenantRef: recurrenceTenant,
      externalRef: `recurrence-coverage-event-${crypto.randomUUID()}`,
      idempotencyKey: `recurrence-coverage-command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId: recurrenceResource.id,
      start: d('2027-08-01T09:00:00Z'),
      end: d('2027-08-01T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Bounded recurrence',
      recurrence: { rrule: 'FREQ=DAILY' },
      materializationWindow,
    });
    expect(created).toMatchObject({ ok: true });

    await expect(
      store.getFreeBusy({
        tenantRef: recurrenceTenant,
        resourceId: recurrenceResource.id,
        window: materializationWindow,
      }),
    ).resolves.toMatchObject({ coverage: { state: 'complete', missingSources: [] } });

    await expect(
      store.getFreeBusy({
        tenantRef: recurrenceTenant,
        resourceId: recurrenceResource.id,
        window: {
          start: d('2027-08-04T00:00:00Z'),
          end: d('2027-08-05T00:00:00Z'),
        },
      }),
    ).resolves.toMatchObject({
      busy: [],
      coverage: {
        state: 'unknown',
        missingSources: [SLOTLOCK_LOCAL_RECURRENCE_COVERAGE_SOURCE],
      },
    });

    await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${recurrenceTenant}`;
    await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${recurrenceTenant}`;
    await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${recurrenceTenant}`;
  });

  it('treats the time before a future recurring master starts as intrinsically covered', async () => {
    const futureTenant = `future-recurrence-tenant-${crypto.randomUUID()}`;
    const futureResource = await store.createResource({
      tenantRef: futureTenant,
      externalRef: `future-recurrence-resource-${crypto.randomUUID()}`,
    });
    const created = await store.putCalendarEvent({
      tenantRef: futureTenant,
      externalRef: `future-recurrence-event-${crypto.randomUUID()}`,
      idempotencyKey: `future-recurrence-command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId: futureResource.id,
      start: d('2027-08-10T09:00:00Z'),
      end: d('2027-08-10T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Future recurrence',
      recurrence: { rrule: 'FREQ=DAILY' },
      materializationWindow: {
        start: d('2027-08-10T00:00:00Z'),
        end: d('2027-08-20T00:00:00Z'),
      },
    });
    expect(created).toMatchObject({ ok: true });

    await expect(
      store.getFreeBusy({
        tenantRef: futureTenant,
        resourceId: futureResource.id,
        window: {
          start: d('2027-08-09T00:00:00Z'),
          end: d('2027-08-11T00:00:00Z'),
        },
      }),
    ).resolves.toMatchObject({
      busy: [{ start: d('2027-08-10T09:00:00Z'), end: d('2027-08-10T10:00:00Z') }],
      coverage: { state: 'complete', missingSources: [] },
    });

    await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${futureTenant}`;
    await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${futureTenant}`;
    await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${futureTenant}`;
  });

  it('keeps the prior recurrence coverage atomically when horizon extension conflicts', async () => {
    const rollingTenant = `rolling-conflict-tenant-${crypto.randomUUID()}`;
    const rollingResource = await store.createResource({
      tenantRef: rollingTenant,
      externalRef: `rolling-conflict-resource-${crypto.randomUUID()}`,
    });
    const externalRef = `rolling-conflict-${crypto.randomUUID()}`;
    const initialWindow = {
      start: d('2027-09-01T00:00:00Z'),
      end: d('2027-09-02T00:00:00Z'),
    };
    const created = await store.putCalendarEvent({
      tenantRef: rollingTenant,
      externalRef,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId: rollingResource.id,
      start: d('2027-09-01T09:00:00Z'),
      end: d('2027-09-01T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Conflict-safe recurrence',
      recurrence: { rrule: 'FREQ=DAILY;COUNT=10' },
      materializationWindow: initialWindow,
    });
    if (!created.ok) throw new Error('rolling conflict fixture failed');
    const blocker = await store.createExternalReservation({
      tenantRef: rollingTenant,
      externalRef: `rolling-blocker-${crypto.randomUUID()}`,
      resourceId: rollingResource.id,
      start: d('2027-09-03T09:30:00Z'),
      end: d('2027-09-03T10:30:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    if (!blocker.ok) throw new Error('rolling blocker fixture failed');

    await expect(
      store.rollCalendarEventHorizon({
        tenantRef: rollingTenant,
        window: {
          start: d('2027-09-02T00:00:00Z'),
          end: d('2027-09-05T00:00:00Z'),
        },
      }),
    ).resolves.toMatchObject({ examined: 1, extended: 0, conflicts: 1 });
    const unchanged = await store.getCalendarEvent({ tenantRef: rollingTenant, externalRef });
    expect(unchanged).toMatchObject({ revision: 1, materializationWindow: initialWindow });
    await expect(store.listBusy(rollingResource.id, initialWindow)).resolves.toContainEqual({
      start: d('2027-09-01T09:00:00Z'),
      end: d('2027-09-01T10:00:00Z'),
    });
    await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${rollingTenant}`;
    await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${rollingTenant}`;
    await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${rollingTenant}`;
  });

  it('gets and keyset-lists only resources owned by the requested tenant', async () => {
    const otherTenant = `resource-tenant-${crypto.randomUUID()}`;
    const otherResource = await store.createResource({
      tenantRef: otherTenant,
      externalRef: `resource-${crypto.randomUUID()}`,
      timezone: 'America/New_York',
    });
    try {
      await expect(store.getResource({ tenantRef, id: resourceId })).resolves.toMatchObject({
        id: resourceId,
        tenantRef,
        timezone: 'Europe/London',
      });
      await expect(store.getResource({ tenantRef, id: otherResource.id })).resolves.toBeNull();

      const firstPage = await store.listResources({ tenantRef, limit: 1 });
      expect(firstPage).toHaveLength(1);
      expect(firstPage[0]?.tenantRef).toBe(tenantRef);
      const cursor = firstPage[0];
      if (!cursor) throw new Error('resource list fixture failed');
      await expect(store.listResources({ tenantRef, limit: 1, after: cursor.id })).resolves.toEqual(
        [],
      );
      await expect(store.listResources({ tenantRef: otherTenant })).resolves.toEqual([
        otherResource,
      ]);
      await expect(store.listResources({ tenantRef, limit: 1_001 })).rejects.toMatchObject({
        code: 'invalid_limit',
      });
      await expect(store.listResources({ tenantRef, after: 'not-a-uuid' })).rejects.toMatchObject({
        code: 'invalid_cursor',
      });
    } finally {
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${otherTenant}`;
    }
  });

  it('materializes moved and cancelled recurrence exceptions into the shared busy set', async () => {
    const window = {
      start: d('2027-03-27T00:00:00Z'),
      end: d('2027-04-01T00:00:00Z'),
    };
    const result = await store.putCalendarEvent({
      tenantRef,
      externalRef: `exception-event-${crypto.randomUUID()}`,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: d('2027-03-27T13:00:00Z'),
      end: d('2027-03-27T14:00:00Z'),
      timezone: 'Europe/London',
      summary: 'Exception-aware event',
      recurrence: {
        rrule: 'FREQ=DAILY;COUNT=3',
        exceptions: [
          { recurrenceId: d('2027-03-28T12:00:00Z'), cancelled: true },
          {
            recurrenceId: d('2027-03-29T12:00:00Z'),
            start: d('2027-03-29T16:00:00Z'),
            end: d('2027-03-29T17:00:00Z'),
          },
        ],
      },
      materializationWindow: window,
    });
    expect(result).toMatchObject({ ok: true, occurrenceCount: 2 });
    const busy = await store.listBusy(resourceId, window);
    expect(busy).toEqual(
      expect.arrayContaining([
        { start: d('2027-03-27T13:00:00Z'), end: d('2027-03-27T14:00:00Z') },
        { start: d('2027-03-29T16:00:00Z'), end: d('2027-03-29T17:00:00Z') },
      ]),
    );
    expect(busy).not.toContainEqual({
      start: d('2027-03-28T12:00:00Z'),
      end: d('2027-03-28T13:00:00Z'),
    });
  });

  it('rejects a non-recurring event whose requested materialization window omits it', async () => {
    await expect(
      store.putCalendarEvent({
        tenantRef,
        externalRef: `unmaterialized-event-${crypto.randomUUID()}`,
        idempotencyKey: `command-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId,
        start: d('2027-03-20T09:00:00Z'),
        end: d('2027-03-20T10:00:00Z'),
        timezone: 'UTC',
        summary: 'Must remain conflict visible',
        materializationWindow: {
          start: d('2027-03-21T00:00:00Z'),
          end: d('2027-03-22T00:00:00Z'),
        },
      }),
    ).resolves.toEqual({ ok: false, code: 'invalid_event' });
  });

  it('stores a one-off event longer than the recurrence window, up to the 3,660-day ceiling', async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const leaseResource = (
      await store.createResource({
        externalRef: `lease-resource-${crypto.randomUUID()}`,
        tenantRef,
        timezone: 'Europe/London',
      })
    ).id;
    const externalRef = `lease-${crypto.randomUUID()}`;
    const lease = {
      tenantRef,
      externalRef,
      idempotencyKey: `lease-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId: leaseResource,
      start: d('2028-01-01T00:00:00Z'),
      end: d('2029-06-01T00:00:00Z'),
      timezone: 'Europe/London',
      summary: 'Seventeen-month lease',
      transparency: 'opaque' as const,
    };
    const created = await store.putCalendarEvent(lease);
    expect(created).toMatchObject({ ok: true, revision: 1, occurrenceCount: 1 });
    await expect(store.putCalendarEvent(lease)).resolves.toMatchObject({ idempotent: true });
    await expect(store.getCalendarEvent({ tenantRef, externalRef })).resolves.toMatchObject({
      start: lease.start,
      end: lease.end,
      materializationWindow: { start: lease.start, end: lease.end },
    });
    // Any window inside the lease sees the whole occupancy.
    await expect(
      store.listBusy(leaseResource, {
        start: d('2028-10-01T00:00:00Z'),
        end: d('2028-10-08T00:00:00Z'),
      }),
    ).resolves.toEqual([{ start: lease.start, end: lease.end }]);

    const ceiling = new Date(lease.start.getTime() + 3_660 * DAY);
    await expect(
      store.putCalendarEvent({
        ...lease,
        idempotencyKey: `lease-extend-${crypto.randomUUID()}`,
        expectedRevision: 1,
        end: ceiling,
      }),
    ).resolves.toMatchObject({ ok: true, revision: 2 });
    await expect(
      store.putCalendarEvent({
        ...lease,
        idempotencyKey: `lease-too-long-${crypto.randomUUID()}`,
        expectedRevision: 2,
        end: new Date(ceiling.getTime() + DAY),
      }),
    ).resolves.toEqual({ ok: false, code: 'invalid_event' });
    // A long window is admitted only as the event's own interval, by the database as well.
    await expect(
      sql`UPDATE slotlock.calendar_events
             SET materialized_starts_at = materialized_starts_at - interval '1 day'
           WHERE tenant_ref = ${tenantRef} AND external_ref = ${externalRef}`,
    ).rejects.toMatchObject({ code: '23514' });

    await expect(
      store.cancelCalendarEvent({
        tenantRef,
        externalRef,
        idempotencyKey: `lease-cancel-${crypto.randomUUID()}`,
        expectedRevision: 2,
      }),
    ).resolves.toMatchObject({ ok: true, revision: 3 });
    await expect(
      store.listBusy(leaseResource, { start: lease.start, end: d('2029-01-01T00:00:00Z') }),
    ).resolves.toEqual([]);

    // Recurrence keeps its 367-day materialization bound.
    await expect(
      store.putCalendarEvent({
        ...lease,
        externalRef: `series-${crypto.randomUUID()}`,
        idempotencyKey: `series-${crypto.randomUUID()}`,
        start: d('2028-01-01T09:00:00Z'),
        end: d('2028-01-01T10:00:00Z'),
        summary: 'Series',
        recurrence: { rrule: 'FREQ=WEEKLY;COUNT=2' },
        materializationWindow: {
          start: d('2028-01-01T00:00:00Z'),
          end: d('2029-01-04T00:00:00Z'),
        },
      }),
    ).resolves.toEqual({ ok: false, code: 'invalid_event' });
  });

  it('upgrades an installed 367-day window CHECK to the bounded one', async () => {
    await sql
      .begin(async (tx) => {
        await tx.unsafe(`
          ALTER TABLE slotlock.calendar_events
            DROP CONSTRAINT slotlock_calendar_events_materialization_window_bounded;
          ALTER TABLE slotlock.calendar_events
            ADD CONSTRAINT slotlock_calendar_events_materialization_window_valid CHECK (
              materialized_ends_at > materialized_starts_at
              AND materialized_ends_at - materialized_starts_at <= interval '367 days'
            );`);
        await createSlotlockStore(tx).applySchema();
        const constraints = await tx<{ conname: string }[]>`
          SELECT conname FROM pg_constraint
           WHERE conrelid = 'slotlock.calendar_events'::regclass
             AND conname LIKE 'slotlock_calendar_events_materialization_window%'
           ORDER BY conname`;
        expect(constraints.map((row) => row.conname)).toEqual([
          'slotlock_calendar_events_materialization_window_bounded',
        ]);
        throw new Error('rollback');
      })
      .catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== 'rollback') throw error;
      });
  });

  it('rolls an event mutation back when an occurrence loses the database overlap race', async () => {
    const start = d('2027-04-01T10:00:00Z');
    const end = d('2027-04-01T12:00:00Z');
    const [event, reservation] = await Promise.all([
      store.putCalendarEvent({
        tenantRef,
        externalRef: `race-event-${crypto.randomUUID()}`,
        idempotencyKey: `race-command-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId,
        start,
        end,
        timezone: 'UTC',
        summary: 'Race event',
        transparency: 'opaque',
      }),
      store.createExternalReservation({
        tenantRef,
        externalRef: `race-booking-${crypto.randomUUID()}`,
        resourceId,
        start,
        end,
        bufferAfterMs: 0,
        revision: 1,
      }),
    ]);

    expect([event.ok, reservation.ok].filter(Boolean)).toHaveLength(1);
    expect([event, reservation].filter((result) => !result.ok)[0]).toMatchObject({
      ok: false,
      code: 'overlap',
    });
  });

  it('preserves the prior revision and occupation when an event update conflicts', async () => {
    const externalRef = `rollback-event-${crypto.randomUUID()}`;
    const original = {
      start: d('2027-04-10T10:00:00Z'),
      end: d('2027-04-10T11:00:00Z'),
    };
    const created = await store.putCalendarEvent({
      tenantRef,
      externalRef,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      ...original,
      timezone: 'UTC',
      summary: 'Rollback event',
    });
    expect(created).toMatchObject({ ok: true, revision: 1 });
    const blocker = await store.createExternalReservation({
      tenantRef,
      externalRef: `rollback-blocker-${crypto.randomUUID()}`,
      resourceId,
      start: d('2027-04-10T15:00:00Z'),
      end: d('2027-04-10T16:00:00Z'),
      bufferAfterMs: 0,
      revision: 1,
    });
    expect(blocker.ok).toBe(true);

    const refused = await store.putCalendarEvent({
      tenantRef,
      externalRef,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 1,
      resourceId,
      start: d('2027-04-10T15:30:00Z'),
      end: d('2027-04-10T16:30:00Z'),
      timezone: 'UTC',
      summary: 'Conflicting update',
    });
    expect(refused).toMatchObject({ ok: false, code: 'overlap' });
    const unchanged = await store.getCalendarEvent({ tenantRef, externalRef });
    expect(unchanged).toMatchObject({ revision: 1, summary: 'Rollback event' });
    expect(unchanged?.start).toEqual(original.start);
    expect(unchanged?.end).toEqual(original.end);
    const busy = await store.listBusy(resourceId, {
      start: d('2027-04-10T09:00:00Z'),
      end: d('2027-04-10T12:00:00Z'),
    });
    expect(busy).toContainEqual(original);
  });

  it('scopes event identities and idempotency keys to the tenant', async () => {
    const otherTenant = `event-tenant-${crypto.randomUUID()}`;
    const otherResource = await store.createResource({
      tenantRef: otherTenant,
      externalRef: `event-resource-${crypto.randomUUID()}`,
    });
    const idempotencyKey = `shared-command-${crypto.randomUUID()}`;
    const externalRef = `shared-event-${crypto.randomUUID()}`;
    try {
      const [first, second] = await Promise.all([
        store.putCalendarEvent({
          tenantRef,
          externalRef,
          idempotencyKey,
          expectedRevision: 0,
          resourceId,
          start: d('2027-04-20T10:00:00Z'),
          end: d('2027-04-20T11:00:00Z'),
          timezone: 'UTC',
          summary: 'Tenant A event',
        }),
        store.putCalendarEvent({
          tenantRef: otherTenant,
          externalRef,
          idempotencyKey,
          expectedRevision: 0,
          resourceId: otherResource.id,
          start: d('2027-04-20T10:00:00Z'),
          end: d('2027-04-20T11:00:00Z'),
          timezone: 'UTC',
          summary: 'Tenant B event',
        }),
      ]);
      expect(first).toMatchObject({ ok: true, idempotent: false });
      expect(second).toMatchObject({ ok: true, idempotent: false });
      expect(first.ok && second.ok && first.eventId).not.toBe(second.ok && second.eventId);
      if (!first.ok || !second.ok) throw new Error('cross-tenant event fixtures failed');
      const foreignReservation = await store.createExternalReservation({
        tenantRef: otherTenant,
        externalRef: `foreign-reservation-${crypto.randomUUID()}`,
        resourceId: otherResource.id,
        start: d('2027-04-21T10:00:00Z'),
        end: d('2027-04-21T11:00:00Z'),
        bufferAfterMs: 0,
        revision: 1,
      });
      if (!foreignReservation.ok) throw new Error('cross-tenant reservation fixture failed');
      await expect(
        sql`
          UPDATE slotlock.calendar_event_occurrences
             SET reservation_id = ${foreignReservation.reservation.id}
           WHERE event_id = ${first.eventId}`,
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${otherTenant}`;
      await sql`DELETE FROM slotlock.reservations WHERE tenant_ref = ${otherTenant}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${otherTenant}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${otherTenant}`;
    }
  });

  it('database cascades derived reservations when an event row is administratively erased', async () => {
    const created = await store.putCalendarEvent({
      tenantRef,
      externalRef: `erasure-event-${crypto.randomUUID()}`,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: d('2027-04-25T10:00:00Z'),
      end: d('2027-04-25T11:00:00Z'),
      timezone: 'UTC',
      summary: 'Erasure cascade event',
    });
    if (!created.ok) throw new Error('event fixture failed');
    const derived = await sql<{ reservation_id: string }[]>`
      SELECT reservation_id FROM slotlock.calendar_event_occurrences
       WHERE event_id = ${created.eventId}`;
    expect(derived[0]?.reservation_id).toBeTruthy();

    await sql`DELETE FROM slotlock.calendar_events WHERE id = ${created.eventId}`;
    const counts = await sql<{ reservations: number; occurrences: number }[]>`
      SELECT
        (SELECT count(*)::int FROM slotlock.reservations
          WHERE calendar_event_id = ${created.eventId}) AS reservations,
        (SELECT count(*)::int FROM slotlock.calendar_event_occurrences
          WHERE event_id = ${created.eventId}) AS occurrences`;
    expect(counts[0]).toEqual({ reservations: 0, occurrences: 0 });
  });

  it('cancels with an expected revision, replays exactly and leaves a resurrection tombstone', async () => {
    const externalRef = `cancel-event-${crypto.randomUUID()}`;
    const create = await store.putCalendarEvent({
      tenantRef,
      externalRef,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 0,
      resourceId,
      start: d('2027-05-01T09:00:00Z'),
      end: d('2027-05-01T10:00:00Z'),
      timezone: 'UTC',
      summary: 'Cancelled handover',
      transparency: 'opaque',
    });
    if (!create.ok) throw new Error('event fixture failed');
    const cancelCommand = {
      tenantRef,
      externalRef,
      idempotencyKey: `command-${crypto.randomUUID()}`,
      expectedRevision: 1,
    };
    const cancelled = await store.cancelCalendarEvent(cancelCommand);
    const replay = await store.cancelCalendarEvent(cancelCommand);
    expect(cancelled).toMatchObject({ ok: true, revision: 2, idempotent: false });
    expect(replay).toEqual({ ...cancelled, idempotent: true });
    await expect(store.getCalendarEvent({ tenantRef, externalRef })).resolves.toBeNull();

    await expect(
      store.putCalendarEvent({
        tenantRef,
        externalRef,
        idempotencyKey: `command-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId,
        start: d('2027-05-01T09:00:00Z'),
        end: d('2027-05-01T10:00:00Z'),
        timezone: 'UTC',
        summary: 'Delayed create',
      }),
    ).resolves.toEqual({ ok: false, code: 'event_cancelled', currentRevision: 2 });

    const cancelBeforeCreateRef = `cancel-first-${crypto.randomUUID()}`;
    await expect(
      store.cancelCalendarEvent({
        tenantRef,
        externalRef: cancelBeforeCreateRef,
        idempotencyKey: `command-${crypto.randomUUID()}`,
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({ ok: true, revision: 1 });
    await expect(
      store.putCalendarEvent({
        tenantRef,
        externalRef: cancelBeforeCreateRef,
        idempotencyKey: `command-${crypto.randomUUID()}`,
        expectedRevision: 0,
        resourceId,
        start: d('2027-05-02T09:00:00Z'),
        end: d('2027-05-02T10:00:00Z'),
        timezone: 'UTC',
        summary: 'Out-of-order delayed create',
      }),
    ).resolves.toEqual({ ok: false, code: 'event_cancelled', currentRevision: 1 });
  });

  it('reports free/busy certainty from fresh, explicit rolling source coverage', async () => {
    const coverageResource = await store.createResource({
      tenantRef,
      externalRef: `provider-coverage-resource-${crypto.randomUUID()}`,
    });
    const window = { start: d('2027-06-01T00:00:00Z'), end: d('2027-06-08T00:00:00Z') };
    const source = `provider-${crypto.randomUUID()}`;
    const unknown = await store.getFreeBusy({
      tenantRef,
      resourceId: coverageResource.id,
      window,
      requiredSources: [source],
      coverageMaxAgeMs: 60_000,
    });
    expect(unknown.coverage).toEqual({ state: 'unknown', missingSources: [source] });

    await expect(
      store.recordCalendarCoverage({
        tenantRef,
        resourceId: coverageResource.id,
        source,
        window,
        revision: 1,
      }),
    ).resolves.toMatchObject({ ok: true, idempotent: false, revision: 1 });
    const complete = await store.getFreeBusy({
      tenantRef,
      resourceId: coverageResource.id,
      window,
      requiredSources: [source],
      coverageMaxAgeMs: 60_000,
    });
    expect(complete.coverage).toEqual({ state: 'complete', missingSources: [] });

    const partialWindow = {
      start: d('2027-05-31T00:00:00Z'),
      end: d('2027-06-08T00:00:00Z'),
    };
    const partial = await store.getFreeBusy({
      tenantRef,
      resourceId: coverageResource.id,
      window: partialWindow,
      requiredSources: [source],
      coverageMaxAgeMs: 60_000,
    });
    expect(partial.coverage).toEqual({ state: 'partial', missingSources: [source] });

    await sql`
      UPDATE slotlock.calendar_coverage
         SET observed_at = now() - interval '2 hours'
       WHERE tenant_ref = ${tenantRef}
         AND resource_id = ${coverageResource.id}
         AND source = ${source}`;
    const stale = await store.getFreeBusy({
      tenantRef,
      resourceId: coverageResource.id,
      window,
      requiredSources: [source],
      coverageMaxAgeMs: 60_000,
    });
    expect(stale.coverage).toEqual({ state: 'unknown', missingSources: [source] });
  });

  it('forces, fingerprints and enforces tenant RLS on every new event table', async () => {
    const role = 'slotlock_events_rls_probe';
    const tables = [
      'calendar_events',
      'calendar_event_attendees',
      'calendar_event_reminders',
      'calendar_event_exceptions',
      'calendar_event_occurrences',
      'calendar_event_tombstones',
      'calendar_event_commands',
      'calendar_coverage',
    ];
    await store.applyTenantRls();
    const policies = await sql<
      { tablename: string; live_fingerprint: string; contract_fingerprint: string }[]
    >`
      SELECT policy.tablename,
             encode(
               sha256(
                 convert_to(
                   concat_ws(
                     E'\\x1f', policy.policyname, policy.permissive, policy.roles::text,
                     policy.cmd, COALESCE(policy.qual, ''), COALESCE(policy.with_check, '')
                   ),
                   'UTF8'
                 )
               ),
               'hex'
             ) AS live_fingerprint,
             contract.policy_fingerprint AS contract_fingerprint
        FROM pg_policies policy
        JOIN slotlock.rls_policy_contracts contract ON contract.table_name = policy.tablename
       WHERE policy.schemaname = 'slotlock'
         AND policy.policyname = 'tenant_isolation_v1'
         AND policy.tablename IN ${sql(tables)}
       ORDER BY policy.tablename`;
    expect(policies).toHaveLength(tables.length);
    expect(
      policies.every((policy) => policy.live_fingerprint === policy.contract_fingerprint),
    ).toBe(true);

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
          {
            events: number;
            attendees: number;
            reminders: number;
            exceptions: number;
            occurrences: number;
            tombstones: number;
            commands: number;
            coverage: number;
          }[]
        >`
          SELECT
            (SELECT count(*)::int FROM slotlock.calendar_events) AS events,
            (SELECT count(*)::int FROM slotlock.calendar_event_attendees) AS attendees,
            (SELECT count(*)::int FROM slotlock.calendar_event_reminders) AS reminders,
            (SELECT count(*)::int FROM slotlock.calendar_event_exceptions) AS exceptions,
            (SELECT count(*)::int FROM slotlock.calendar_event_occurrences) AS occurrences,
            (SELECT count(*)::int FROM slotlock.calendar_event_tombstones) AS tombstones,
            (SELECT count(*)::int FROM slotlock.calendar_event_commands) AS commands,
            (SELECT count(*)::int FROM slotlock.calendar_coverage) AS coverage`;
        expect(unset[0]).toEqual({
          events: 0,
          attendees: 0,
          reminders: 0,
          exceptions: 0,
          occurrences: 0,
          tombstones: 0,
          commands: 0,
          coverage: 0,
        });
      });
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`SELECT set_config('slotlock.tenant_ref', ${tenantRef}, true)`;
        const tenantStore = createSlotlockStore(tx);
        const resources = await tenantStore.listResources({ tenantRef });
        expect(resources.map((resource) => resource.id)).toContain(resourceId);
        await expect(
          tenantStore.getResource({ tenantRef: 'another-tenant', id: resourceId }),
        ).resolves.toBeNull();
        await expect(tenantStore.listResources({ tenantRef: 'another-tenant' })).resolves.toEqual(
          [],
        );
        const visible = await tx<
          {
            events: number;
            attendees: number;
            reminders: number;
            exceptions: number;
            occurrences: number;
            tombstones: number;
            commands: number;
            coverage: number;
          }[]
        >`
          SELECT
            (SELECT count(*)::int FROM slotlock.calendar_events) AS events,
            (SELECT count(*)::int FROM slotlock.calendar_event_attendees) AS attendees,
            (SELECT count(*)::int FROM slotlock.calendar_event_reminders) AS reminders,
            (SELECT count(*)::int FROM slotlock.calendar_event_exceptions) AS exceptions,
            (SELECT count(*)::int FROM slotlock.calendar_event_occurrences) AS occurrences,
            (SELECT count(*)::int FROM slotlock.calendar_event_tombstones) AS tombstones,
            (SELECT count(*)::int FROM slotlock.calendar_event_commands) AS commands,
            (SELECT count(*)::int FROM slotlock.calendar_coverage) AS coverage`;
        expect(visible[0]?.events).toBeGreaterThan(0);
        expect(visible[0]?.occurrences).toBeGreaterThan(0);
        expect(visible[0]?.tombstones).toBeGreaterThan(0);
        expect(visible[0]?.commands).toBeGreaterThan(0);
        expect(visible[0]?.coverage).toBeGreaterThan(0);
      });

      const ownerA = `agent:${'a'.repeat(64)}`;
      const ownerB = `agent:${'b'.repeat(64)}`;
      const sharedExternalRef = `shared-owner-event-${crypto.randomUUID()}`;
      const sharedIdempotencyKey = `shared-owner-command-${crypto.randomUUID()}`;
      const ownerWindow = {
        start: d('2027-08-01T10:00:00Z'),
        end: d('2027-08-01T11:00:00Z'),
      };
      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`SELECT set_config('slotlock.tenant_ref', ${tenantRef}, true)`;
        const tenantStore = createSlotlockStore(tx);

        for (const unsafeOwnerRef of ['renter@example.com', 'raw-auth-subject-123']) {
          await expect(
            tenantStore.putCalendarEvent({
              tenantRef,
              ownerRef: unsafeOwnerRef,
              externalRef: `unsafe-owner-${crypto.randomUUID()}`,
              idempotencyKey: `unsafe-owner-command-${crypto.randomUUID()}`,
              expectedRevision: 0,
              resourceId,
              ...ownerWindow,
              timezone: 'UTC',
              summary: 'Must never persist',
              transparency: 'transparent',
            }),
          ).resolves.toEqual({ ok: false, code: 'invalid_identity' });
        }

        await expect(
          tx.savepoint(async (savepoint) => {
            await savepoint`
              INSERT INTO slotlock.calendar_event_tombstones (
                tenant_ref, owner_ref, external_ref, event_id, revision
              ) VALUES (
                ${tenantRef}, ${'renter@example.com'}, ${`unsafe-email-${crypto.randomUUID()}`},
                ${crypto.randomUUID()}, 1
              )`;
          }),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          tx.savepoint(async (savepoint) => {
            await savepoint`
              INSERT INTO slotlock.calendar_event_commands (
                tenant_ref, owner_ref, idempotency_key, operation, payload_hash, event_id,
                external_ref, result_revision, occurrence_count
              ) VALUES (
                ${tenantRef}, ${'raw-auth-subject-123'}, ${`unsafe-subject-${crypto.randomUUID()}`},
                'put', ${'0'.repeat(64)}, ${crypto.randomUUID()},
                ${`unsafe-subject-event-${crypto.randomUUID()}`}, 1, 0
              )`;
          }),
        ).rejects.toMatchObject({ code: '23514' });

        const ownerAEvent = await tenantStore.putCalendarEvent({
          tenantRef,
          ownerRef: ownerA,
          externalRef: sharedExternalRef,
          idempotencyKey: sharedIdempotencyKey,
          expectedRevision: 0,
          resourceId,
          ...ownerWindow,
          timezone: 'UTC',
          summary: 'Owner A private content',
          transparency: 'transparent',
        });
        expect(ownerAEvent).toMatchObject({ ok: true, idempotent: false });

        await expect(
          tenantStore.getCalendarEvent({
            tenantRef,
            ownerRef: ownerB,
            externalRef: sharedExternalRef,
          }),
        ).resolves.toBeNull();
        await expect(
          tenantStore.listCalendarEvents({
            tenantRef,
            ownerRef: ownerB,
            resourceId,
            window: {
              start: d('2027-08-01T00:00:00Z'),
              end: d('2027-08-02T00:00:00Z'),
            },
          }),
        ).resolves.toEqual([]);
        await expect(
          tenantStore.putCalendarEvent({
            tenantRef,
            ownerRef: ownerB,
            externalRef: sharedExternalRef,
            idempotencyKey: `foreign-update-${crypto.randomUUID()}`,
            expectedRevision: 1,
            resourceId,
            ...ownerWindow,
            timezone: 'UTC',
            summary: 'Cross-principal overwrite attempt',
            transparency: 'transparent',
          }),
        ).resolves.toEqual({ ok: false, code: 'revision_conflict', currentRevision: 0 });
        await expect(
          tenantStore.cancelCalendarEvent({
            tenantRef,
            ownerRef: ownerB,
            externalRef: sharedExternalRef,
            idempotencyKey: `foreign-delete-${crypto.randomUUID()}`,
            expectedRevision: 1,
          }),
        ).resolves.toEqual({ ok: false, code: 'event_not_found' });

        const ownerBEvent = await tenantStore.putCalendarEvent({
          tenantRef,
          ownerRef: ownerB,
          externalRef: sharedExternalRef,
          idempotencyKey: sharedIdempotencyKey,
          expectedRevision: 0,
          resourceId,
          ...ownerWindow,
          timezone: 'UTC',
          summary: 'Owner B private content',
          transparency: 'transparent',
        });
        expect(ownerBEvent).toMatchObject({ ok: true, idempotent: false });
        if (!ownerAEvent.ok || !ownerBEvent.ok) throw new Error('owner fixtures failed');
        expect(ownerAEvent.eventId).not.toBe(ownerBEvent.eventId);
        await expect(
          tenantStore.getCalendarEvent({
            tenantRef,
            ownerRef: ownerA,
            externalRef: sharedExternalRef,
          }),
        ).resolves.toMatchObject({ summary: 'Owner A private content', ownerRef: ownerA });
        await expect(
          tenantStore.getCalendarEvent({
            tenantRef,
            ownerRef: ownerB,
            externalRef: sharedExternalRef,
          }),
        ).resolves.toMatchObject({ summary: 'Owner B private content', ownerRef: ownerB });

        await expect(
          tx.savepoint(async (savepoint) => {
            await savepoint`
              UPDATE slotlock.calendar_events
                 SET owner_ref = ${ownerA}
               WHERE tenant_ref = ${tenantRef}
                 AND owner_ref = ${ownerB}
                 AND external_ref = ${sharedExternalRef}
            `;
          }),
        ).rejects.toMatchObject({ code: '23514' });

        const cancelled = await tenantStore.cancelCalendarEvent({
          tenantRef,
          ownerRef: ownerA,
          externalRef: sharedExternalRef,
          idempotencyKey: `owner-a-cancel-${crypto.randomUUID()}`,
          expectedRevision: 1,
        });
        expect(cancelled).toMatchObject({ ok: true, revision: 2 });
        await expect(
          tenantStore.getCalendarEvent({
            tenantRef,
            ownerRef: ownerB,
            externalRef: sharedExternalRef,
          }),
        ).resolves.toMatchObject({ summary: 'Owner B private content' });
      });

      const quotaOwner = `agent:${'c'.repeat(64)}`;
      const quotaClients = [
        postgres(url as string, { max: 1, onnotice: () => {} }),
        postgres(url as string, { max: 1, onnotice: () => {} }),
      ] as const;
      try {
        const quotaCommands = quotaClients.map((_, index) => ({
          externalRef: `quota-race-${index}-${crypto.randomUUID()}`,
          idempotencyKey: `quota-race-command-${index}-${crypto.randomUUID()}`,
        }));
        const quotaResults = await Promise.all(
          quotaClients.map((client, index) =>
            client.begin(async (tx) => {
              await tx.unsafe(`SET LOCAL ROLE ${role}`);
              await tx`SELECT set_config('slotlock.tenant_ref', ${tenantRef}, true)`;
              return createSlotlockStore(tx, { agentOwnerEventQuota: 1 }).putCalendarEvent({
                tenantRef,
                ownerRef: quotaOwner,
                externalRef: quotaCommands[index]?.externalRef as string,
                idempotencyKey: quotaCommands[index]?.idempotencyKey as string,
                expectedRevision: 0,
                resourceId,
                start: d(`2027-08-0${index + 2}T10:00:00Z`),
                end: d(`2027-08-0${index + 2}T11:00:00Z`),
                timezone: 'UTC',
                summary: `Quota race ${index}`,
                transparency: 'transparent',
              });
            }),
          ),
        );
        expect(quotaResults.filter((result) => result.ok)).toHaveLength(1);
        expect(quotaResults.filter((result) => !result.ok)).toEqual([
          { ok: false, code: 'owner_event_quota_exceeded', limit: 1 },
        ]);
        const winner = quotaResults.find((result) => result.ok);
        if (!winner) throw new Error('quota race produced no winner');
        await quotaClients[0].begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          await tx`SELECT set_config('slotlock.tenant_ref', ${tenantRef}, true)`;
          const tenantStore = createSlotlockStore(tx, { agentOwnerEventQuota: 1 });
          await expect(
            tenantStore.cancelCalendarEvent({
              tenantRef,
              ownerRef: quotaOwner,
              externalRef: winner.externalRef,
              idempotencyKey: `quota-winner-cancel-${crypto.randomUUID()}`,
              expectedRevision: 1,
            }),
          ).resolves.toMatchObject({ ok: true, revision: 2 });
          await expect(
            tenantStore.putCalendarEvent({
              tenantRef,
              ownerRef: quotaOwner,
              externalRef: `quota-churn-${crypto.randomUUID()}`,
              idempotencyKey: `quota-churn-command-${crypto.randomUUID()}`,
              expectedRevision: 0,
              resourceId,
              start: d('2027-08-09T10:00:00Z'),
              end: d('2027-08-09T11:00:00Z'),
              timezone: 'UTC',
              summary: 'Quota churn attempt',
              transparency: 'transparent',
            }),
          ).resolves.toEqual({
            ok: false,
            code: 'owner_event_quota_exceeded',
            limit: 1,
          });
        });
      } finally {
        await Promise.all(quotaClients.map((client) => client.end()));
      }

      await sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx`SELECT set_config('slotlock.tenant_ref', ${tenantRef}, true)`;
        const commandOwner = `agent:${'d'.repeat(64)}`;
        const commandStore = createSlotlockStore(tx, {
          agentOwnerEventQuota: 1,
          agentOwnerCommandQuota: 2,
        });
        const commandExternalRef = `command-cap-${crypto.randomUUID()}`;
        const commandCreate = await commandStore.putCalendarEvent({
          tenantRef,
          ownerRef: commandOwner,
          externalRef: commandExternalRef,
          idempotencyKey: `command-cap-create-${crypto.randomUUID()}`,
          expectedRevision: 0,
          resourceId,
          start: d('2027-08-10T10:00:00Z'),
          end: d('2027-08-10T11:00:00Z'),
          timezone: 'UTC',
          summary: 'Command cap event',
          transparency: 'transparent',
        });
        expect(commandCreate).toMatchObject({ ok: true, revision: 1 });
        await expect(
          commandStore.putCalendarEvent({
            tenantRef,
            ownerRef: commandOwner,
            externalRef: commandExternalRef,
            idempotencyKey: `command-cap-update-${crypto.randomUUID()}`,
            expectedRevision: 1,
            resourceId,
            start: d('2027-08-10T10:00:00Z'),
            end: d('2027-08-10T11:00:00Z'),
            timezone: 'UTC',
            summary: 'Rejected update churn',
            transparency: 'transparent',
          }),
        ).resolves.toEqual({
          ok: false,
          code: 'owner_command_quota_exceeded',
          limit: 2,
        });
        // The put ceiling reserves one final command for releasing the active identity.
        await expect(
          commandStore.cancelCalendarEvent({
            tenantRef,
            ownerRef: commandOwner,
            externalRef: commandExternalRef,
            idempotencyKey: `command-cap-cancel-${crypto.randomUUID()}`,
            expectedRevision: 1,
          }),
        ).resolves.toMatchObject({ ok: true, revision: 2 });
        const [commandCount] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count
            FROM slotlock.calendar_event_commands
           WHERE tenant_ref = ${tenantRef} AND owner_ref = ${commandOwner}`;
        expect(commandCount?.count).toBe(2);

        const tenantStore = createSlotlockStore(tx, { agentOwnerEventQuota: 1 });
        const internalResults = await Promise.all(
          [0, 1].map((index) =>
            tenantStore.putCalendarEvent({
              tenantRef,
              externalRef: `internal-uncapped-${index}-${crypto.randomUUID()}`,
              idempotencyKey: `internal-uncapped-command-${index}-${crypto.randomUUID()}`,
              expectedRevision: 0,
              resourceId,
              start: d(`2027-08-0${index + 4}T10:00:00Z`),
              end: d(`2027-08-0${index + 4}T11:00:00Z`),
              timezone: 'UTC',
              summary: `Trusted internal event ${index}`,
              transparency: 'transparent',
            }),
          ),
        );
        expect(internalResults.every((result) => result.ok)).toBe(true);
      });
    } finally {
      await sql.unsafe(`DROP OWNED BY ${role}`);
      await sql.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  });
});
