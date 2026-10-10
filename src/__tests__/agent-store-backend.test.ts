import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SlotlockAgentInvocationContext,
  invokeSlotlockAgentOperation,
} from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import type { SlotlockStore, SlotlockTenantStore } from '../store.js';

const tenantRef = 'tenant-a';
const context: SlotlockAgentInvocationContext = {
  principal: { subject: 'principal-a', tenantRef },
  operation: 'slotlock_create_event',
  signal: new AbortController().signal,
};

const resource = {
  id: '11111111-1111-4111-8111-111111111111',
  externalRef: 'vehicle-1',
  tenantRef,
  timezone: 'Europe/London',
};

function event(externalRef = 'agent:event-1') {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    externalRef,
    tenantRef,
    ownerRef: `agent:${'a'.repeat(64)}`,
    resourceId: resource.id,
    start: new Date('2027-01-10T09:00:00.000Z'),
    end: new Date('2027-01-10T10:00:00.000Z'),
    timezone: 'Europe/London',
    summary: 'Collection',
    status: 'confirmed' as const,
    transparency: 'opaque' as const,
    revision: 1,
    source: 'agent-server',
    materializationWindow: {
      start: new Date('2027-01-10T09:00:00.000Z'),
      end: new Date('2027-01-10T10:00:00.000Z'),
    },
    createdAt: new Date('2027-01-01T00:00:00.000Z'),
    updatedAt: new Date('2027-01-01T00:00:00.000Z'),
  };
}

describe('Slotlock store-backed agent server adapter', () => {
  const listResources = vi.fn();
  const getResource = vi.fn();
  const getFreeBusy = vi.fn();
  const putCalendarEvent = vi.fn();
  const getCalendarEvent = vi.fn();
  const listCalendarEvents = vi.fn();
  const cancelCalendarEvent = vi.fn();
  const withTenant = vi.fn();
  const availabilityRules = vi.fn();

  const tenantStore = {
    listResources,
    getResource,
    getFreeBusy,
    putCalendarEvent,
    getCalendarEvent,
    listCalendarEvents,
    cancelCalendarEvent,
  } as unknown as SlotlockTenantStore;
  const store = { withTenant } as unknown as SlotlockStore;

  beforeEach(() => {
    vi.clearAllMocks();
    withTenant.mockImplementation(
      async (requestedTenant: string, callback: (s: unknown) => unknown) => {
        expect(requestedTenant).toBe(tenantRef);
        return callback(tenantStore);
      },
    );
    listResources.mockResolvedValue([resource]);
    getResource.mockResolvedValue(resource);
    getFreeBusy.mockResolvedValue({
      busy: [],
      coverage: { state: 'complete', missingSources: [] },
    });
    putCalendarEvent.mockResolvedValue({
      ok: true,
      eventId: event().id,
      externalRef: event().externalRef,
      revision: 1,
      occurrenceCount: 1,
      idempotent: false,
    });
    getCalendarEvent.mockResolvedValue(event());
    listCalendarEvents.mockResolvedValue([event()]);
    cancelCalendarEvent.mockResolvedValue({
      ok: true,
      eventId: event().id,
      externalRef: event().externalRef,
      revision: 2,
      idempotent: false,
    });
    availabilityRules.mockResolvedValue([
      { rrule: 'FREQ=WEEKLY;BYDAY=SU', startMinutes: 0, durationMinutes: 1_440 },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // A resource cursor is a resource id. The store refuses anything else with a plain error, which
  // the dispatcher reports as internal_error (HTTP 500) unless the backend refuses it first.
  it('refuses a resource cursor that is not a resource id as invalid_cursor, without a query', async () => {
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules });
    listResources.mockRejectedValue(
      Object.assign(new Error('Slotlock resource cursor is invalid'), { code: 'invalid_cursor' }),
    );
    for (const cursor of ['not-a-cursor', '', 'x'.repeat(600), 42, resource.id.toUpperCase().replace('4', 'Z')]) {
      await expect(backend.listResources(context, { limit: 5, cursor })).rejects.toMatchObject({
        code: 'invalid_cursor',
        status: 400,
      });
    }
    expect(listResources).not.toHaveBeenCalled();

    const outcome = await invokeSlotlockAgentOperation({
      operation: 'slotlock_list_resources',
      input: { limit: 5, cursor: 'not-a-cursor' },
      request: new Request('http://localhost/mcp'),
      options: {
        backend,
        authenticate: async () => context.principal,
        authorize: async () => true,
      },
    });
    expect(outcome).toEqual({ ok: false, status: 400, code: 'invalid_cursor' });
    // Refused before a tenant transaction is opened.
    expect(withTenant).not.toHaveBeenCalled();

    listResources.mockResolvedValue([resource]);
    await expect(backend.listResources(context, { limit: 5, cursor: resource.id })).resolves.toMatchObject({
      next_cursor: null,
    });
    expect(listResources).toHaveBeenCalledWith(expect.objectContaining({ after: resource.id }));
  });

  it('binds every store call to the authenticated tenant and derives a private event identity', async () => {
    const backend = createSlotlockStoreAgentBackend(store, {
      availabilityRules,
      requiredCoverageSources: async () => ['provider:primary'],
    });

    const result = await backend.createEvent(context, {
      resource_id: resource.id,
      starts_at: '2027-01-10T09:00:00.000Z',
      ends_at: '2027-01-10T10:00:00.000Z',
      timezone: 'Europe/London',
      title: 'Collection',
      status: 'confirmed',
      transparency: 'opaque',
      attendees: [
        {
          address: 'renter@example.com',
          role: 'required',
          participation_status: 'needs_action',
        },
      ],
      reminders: [{ minutes_before: 30, channel: 'email' }],
      idempotency_key: 'create-1',
    });

    expect(withTenant).toHaveBeenCalledOnce();
    expect(putCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantRef,
        ownerRef: expect.stringMatching(/^agent:[a-f0-9]{64}$/),
        resourceId: resource.id,
        expectedRevision: 0,
        idempotencyKey: expect.stringMatching(/^agent-command:[a-f0-9]{64}$/),
        externalRef: expect.stringMatching(/^agent:[a-f0-9]{64}$/),
        attendees: [
          {
            email: 'renter@example.com',
            role: 'required',
            participationStatus: 'needs_action',
          },
        ],
        reminders: [{ minutesBeforeStart: 30, action: 'email' }],
      }),
    );
    const write = putCalendarEvent.mock.calls[0]?.[0] as {
      externalRef: string;
      ownerRef: string;
    };
    expect(write.externalRef).not.toContain('principal-a');
    expect(write.ownerRef).not.toContain('principal-a');
    expect(getCalendarEvent).toHaveBeenCalledWith({
      tenantRef,
      ownerRef: write.ownerRef,
      externalRef: event().externalRef,
    });
    expect(result).toEqual({
      event: expect.objectContaining({
        id: event().externalRef,
        resource_id: resource.id,
        starts_at: '2027-01-10T09:00:00.000Z',
        revision: 1,
      }),
      replayed: false,
    });
  });

  it('namespaces command idempotency by authenticated principal while preserving same-principal retries', async () => {
    const seenCommands = new Map<string, string>();
    putCalendarEvent.mockImplementation(async (input) => {
      const previousExternalRef = seenCommands.get(input.idempotencyKey);
      if (previousExternalRef !== undefined && previousExternalRef !== input.externalRef) {
        return { ok: false, code: 'idempotency_conflict' as const };
      }
      const idempotent = previousExternalRef !== undefined;
      seenCommands.set(input.idempotencyKey, input.externalRef);
      return {
        ok: true,
        eventId: event(input.externalRef).id,
        externalRef: input.externalRef,
        revision: 1,
        occurrenceCount: 1,
        idempotent,
      };
    });
    getCalendarEvent.mockImplementation(async (input) => event(input.externalRef));
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules });
    const createInput = {
      resource_id: resource.id,
      starts_at: '2027-01-10T09:00:00.000Z',
      ends_at: '2027-01-10T10:00:00.000Z',
      timezone: 'Europe/London',
      idempotency_key: 'shared-client-retry-key',
    };
    const otherPrincipalContext: SlotlockAgentInvocationContext = {
      ...context,
      principal: { ...context.principal, subject: 'principal-b' },
    };

    const first = await backend.createEvent(context, createInput);
    const replay = await backend.createEvent(context, createInput);
    const otherPrincipal = await backend.createEvent(otherPrincipalContext, createInput);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(otherPrincipal.replayed).toBe(false);
    const writes = putCalendarEvent.mock.calls.map(([input]) => input);
    expect(writes[0]?.ownerRef).toMatch(/^agent:[a-f0-9]{64}$/);
    expect(writes[1]?.ownerRef).toBe(writes[0]?.ownerRef);
    expect(writes[2]?.ownerRef).not.toBe(writes[0]?.ownerRef);
    expect(writes[0]?.idempotencyKey).toMatch(/^agent-command:[a-f0-9]{64}$/);
    expect(writes[1]?.idempotencyKey).toBe(writes[0]?.idempotencyKey);
    expect(writes[2]?.idempotencyKey).not.toBe(writes[0]?.idempotencyKey);
    expect(writes[0]?.externalRef).toBe(writes[1]?.externalRef);
    expect(writes[2]?.externalRef).not.toBe(writes[0]?.externalRef);
    expect(JSON.stringify(writes)).not.toContain('shared-client-retry-key');
    expect(JSON.stringify(writes)).not.toContain('principal-a');
    expect(JSON.stringify(writes)).not.toContain('principal-b');
  });

  it('threads one opaque principal owner through every event lookup and mutation', async () => {
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules });
    const readContext = { ...context, operation: 'slotlock_get_event' as const };
    const listContext = { ...context, operation: 'slotlock_list_events' as const };
    const updateContext = { ...context, operation: 'slotlock_update_event' as const };
    const deleteContext = { ...context, operation: 'slotlock_delete_event' as const };

    await backend.getEvent(readContext, { event_id: event().externalRef });
    await backend.listEvents(listContext, {
      resource_ids: [resource.id],
      start: '2027-01-10T00:00:00.000Z',
      end: '2027-01-11T00:00:00.000Z',
      limit: 10,
    });
    await backend.updateEvent(updateContext, {
      event_id: event().externalRef,
      expected_revision: 1,
      title: 'Revised',
      idempotency_key: 'update-owned-event',
    });
    await backend.deleteEvent(deleteContext, {
      event_id: event().externalRef,
      expected_revision: 1,
      idempotency_key: 'delete-owned-event',
    });

    const ownerRefs = [
      ...getCalendarEvent.mock.calls.map(([input]) => input.ownerRef),
      ...listCalendarEvents.mock.calls.map(([input]) => input.ownerRef),
      ...putCalendarEvent.mock.calls.map(([input]) => input.ownerRef),
      ...cancelCalendarEvent.mock.calls.map(([input]) => input.ownerRef),
    ];
    expect(ownerRefs.length).toBeGreaterThanOrEqual(6);
    expect(new Set(ownerRefs).size).toBe(1);
    expect(ownerRefs[0]).toMatch(/^agent:[a-f0-9]{64}$/);
    expect(
      JSON.stringify({
        gets: getCalendarEvent.mock.calls,
        lists: listCalendarEvents.mock.calls,
        puts: putCalendarEvent.mock.calls,
        cancels: cancelCalendarEvent.mock.calls,
      }),
    ).not.toContain('principal-a');
  });

  it('uses a privacy-safe title and a rolling recurrence horizon for old series', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-10T12:00:00.000Z'));
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules });

    await backend.createEvent(context, {
      resource_id: resource.id,
      starts_at: '2020-01-06T09:00:00.000Z',
      ends_at: '2020-01-06T10:00:00.000Z',
      timezone: 'Europe/London',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      idempotency_key: 'create-old-series',
    });

    expect(putCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Busy',
        materializationWindow: {
          start: new Date('2027-01-09T00:00:00.000Z'),
          end: new Date('2028-01-11T00:00:00.000Z'),
        },
      }),
    );
  });

  it('materializes future recurring series over the same rolling horizon readiness verifies', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-10T12:00:00.000Z'));
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules });

    await backend.createEvent(context, {
      resource_id: resource.id,
      starts_at: '2027-09-06T09:00:00.000Z',
      ends_at: '2027-09-06T10:00:00.000Z',
      timezone: 'Europe/London',
      recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO',
      idempotency_key: 'create-future-series',
    });

    expect(putCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        materializationWindow: {
          start: new Date('2027-01-09T00:00:00.000Z'),
          end: new Date('2028-01-11T00:00:00.000Z'),
        },
      }),
    );
  });

  it('moves an event to another tenant-owned resource under the same revision fence', async () => {
    const replacement = {
      ...resource,
      id: '33333333-3333-4333-8333-333333333333',
      externalRef: 'vehicle-2',
    };
    getResource.mockImplementation(async ({ id }: { id: string }) =>
      id === replacement.id ? replacement : resource,
    );
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules });

    await backend.updateEvent(
      { ...context, operation: 'slotlock_update_event' },
      {
        event_id: event().externalRef,
        expected_revision: 1,
        resource_id: replacement.id,
        idempotency_key: 'move-event',
      },
    );

    expect(getResource).toHaveBeenCalledWith({ tenantRef, id: replacement.id });
    expect(putCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRef: event().externalRef,
        resourceId: replacement.id,
        expectedRevision: 1,
      }),
    );
  });

  it("answers from a resource's own hours before the default, and its [] as closed", async () => {
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules });
    const find = () =>
      backend.findNextAvailable(
        { ...context, operation: 'slotlock_find_next_available' },
        {
          resource_ids: [resource.id],
          start: '2027-01-10T00:00:00.000Z',
          end: '2027-01-11T00:00:00.000Z',
          duration_minutes: 60,
        },
      ) as Promise<{ start: string | null }>;
    // 10 January 2027 is a Sunday; the default (all day Sunday) would answer midnight.
    getResource.mockResolvedValueOnce({
      ...resource,
      timezone: 'UTC',
      availabilityRules: [{ rrule: 'FREQ=WEEKLY;BYDAY=SU', startMinutes: 600, durationMinutes: 60 }],
    });
    expect((await find()).start).toBe('2027-01-10T10:00:00.000Z');
    expect(availabilityRules).not.toHaveBeenCalled();

    getResource.mockResolvedValueOnce({ ...resource, timezone: 'UTC', availabilityRules: [] });
    expect((await find()).start).toBeNull();
    expect(availabilityRules).not.toHaveBeenCalled();

    getResource.mockResolvedValueOnce({ ...resource, timezone: 'UTC' });
    expect((await find()).start).toBe('2027-01-10T00:00:00.000Z');
    expect(availabilityRules).toHaveBeenCalledOnce();
  });

  it('never manufactures availability beyond complete required provider coverage', async () => {
    getFreeBusy.mockResolvedValueOnce({
      busy: [],
      coverage: { state: 'partial', missingSources: ['provider:primary'] },
    });
    const backend = createSlotlockStoreAgentBackend(store, {
      availabilityRules,
      requiredCoverageSources: async () => ['provider:primary'],
    });
    const result = await backend.findNextAvailable(
      { ...context, operation: 'slotlock_find_next_available' },
      {
        resource_ids: [resource.id],
        start: '2027-01-10T00:00:00.000Z',
        end: '2027-01-11T00:00:00.000Z',
        duration_minutes: 60,
      },
    );

    expect(result).toEqual({
      resource_id: null,
      start: null,
      end: null,
      coverage: {
        start: '2027-01-10T00:00:00.000Z',
        end: '2027-01-11T00:00:00.000Z',
        certainty: 'uncertain',
        reason: 'coverage_incomplete',
      },
    });
    expect(availabilityRules).not.toHaveBeenCalled();
  });

  it('fails the whole multi-resource search closed when any resource coverage is incomplete', async () => {
    const secondResource = {
      ...resource,
      id: '33333333-3333-4333-8333-333333333333',
      externalRef: 'vehicle-2',
    };
    getResource.mockImplementation(async ({ id }: { id: string }) =>
      id === secondResource.id ? secondResource : resource,
    );
    getFreeBusy
      .mockResolvedValueOnce({
        busy: [],
        coverage: { state: 'complete', missingSources: [] },
      })
      .mockResolvedValueOnce({
        busy: [],
        coverage: {
          state: 'partial',
          missingSources: ['slotlock:local-recurrence-materialization'],
        },
      });
    const backend = createSlotlockStoreAgentBackend(store, {
      availabilityRules,
      requiredCoverageSources: async () => ['provider:primary'],
    });

    const result = await backend.findNextAvailable(
      { ...context, operation: 'slotlock_find_next_available' },
      {
        resource_ids: [resource.id, secondResource.id],
        start: '2027-01-10T00:00:00.000Z',
        end: '2027-01-11T00:00:00.000Z',
        duration_minutes: 60,
      },
    );

    expect(result).toEqual({
      resource_id: null,
      start: null,
      end: null,
      coverage: {
        start: '2027-01-10T00:00:00.000Z',
        end: '2027-01-11T00:00:00.000Z',
        certainty: 'uncertain',
        reason: 'coverage_incomplete',
      },
    });
    expect(availabilityRules).toHaveBeenCalledOnce();
  });

  it('maps missing and conflicting store outcomes to bounded protocol-safe errors', async () => {
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules });
    getCalendarEvent.mockResolvedValueOnce(null);
    await expect(
      backend.getEvent(
        { ...context, operation: 'slotlock_get_event' },
        { event_id: 'unknown-event' },
      ),
    ).rejects.toMatchObject({ code: 'event_not_found', status: 404 });

    putCalendarEvent.mockResolvedValueOnce({
      ok: false,
      code: 'revision_conflict',
      currentRevision: 3,
    });
    await expect(
      backend.updateEvent(
        { ...context, operation: 'slotlock_update_event' },
        {
          event_id: event().externalRef,
          expected_revision: 1,
          title: 'Changed',
          idempotency_key: 'update-1',
        },
      ),
    ).rejects.toMatchObject({ code: 'revision_conflict', status: 409 });

    putCalendarEvent.mockResolvedValueOnce({
      ok: false,
      code: 'owner_command_quota_exceeded',
      limit: 10_000,
    });
    await expect(
      backend.createEvent(context, {
        resource_id: resource.id,
        starts_at: '2027-01-10T09:00:00.000Z',
        ends_at: '2027-01-10T10:00:00.000Z',
        timezone: 'Europe/London',
        idempotency_key: 'quota-refusal',
      }),
    ).rejects.toMatchObject({ code: 'owner_command_quota_exceeded', status: 429 });
  });
});
