// A sandbox race without a database: its racers end with the request that asked for it.
import { describe, expect, it } from 'vitest';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentInvocationContext,
  SlotlockAgentOperationError,
} from '../agent-server.js';
import { raceSlotlockSandbox } from '../sandbox.js';
import { createTenantSlots } from '../store.js';

const TENANT = 'fleet-7~test';
const RESOURCE_ID = '00000000-0000-4000-8000-000000000001';
const START = new Date('2029-03-02T10:00:00Z');
const END = new Date('2029-03-02T11:00:00Z');

const BOOKED = {
  event: {
    id: 'e1',
    resource_id: RESOURCE_ID,
    starts_at: START.toISOString(),
    ends_at: END.toISOString(),
    timezone: 'UTC',
    title: 'Sandbox racer 1',
    description: null,
    location: null,
    organizer: null,
    attendees: [],
    reminders: [],
    status: 'confirmed',
    transparency: 'opaque',
    sequence: 0,
    revision: 1,
    recurrence_rule: null,
    recurrence_exceptions: [],
    recurrence_id: null,
  },
  replayed: false,
};

/**
 * A backend that books as the store's does with one of the tenant's transactions at a time: a
 * racer whose request is gone is refused, and one waiting its turn leaves the line when it goes.
 * The first to begin books and holds its transaction until `finishFirst`; the rest overlap.
 */
function racingBackend() {
  const slots = createTenantSlots(1);
  const begun: string[] = [];
  let finishFirst: () => void = () => {};
  const firstHolds = new Promise<void>((resolve) => (finishFirst = resolve));
  const backend = {
    async createEvent(context: SlotlockAgentInvocationContext, input: Record<string, unknown>) {
      if (context.signal.aborted) throw new SlotlockAgentOperationError('request_aborted', 503);
      let release: () => void;
      try {
        release = await slots(context.principal.tenantRef, context.signal);
      } catch {
        throw new SlotlockAgentOperationError('request_aborted', 503);
      }
      try {
        begun.push(input.title as string);
        if (begun.length > 1) throw new SlotlockAgentOperationError('overlap', 409);
        await firstHolds;
        return BOOKED;
      } finally {
        release();
      }
    },
  } as unknown as SlotlockAgentCalendarBackend;
  return { backend, begun, finishFirst: () => finishFirst() };
}

async function until(done: () => boolean): Promise<void> {
  for (let turns = 0; !done(); turns++) {
    if (turns > 1_000) throw new Error('timed out waiting');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('a sandbox race', () => {
  it('runs every agent while its request is there', async () => {
    const { backend, begun, finishFirst } = racingBackend();
    const race = raceSlotlockSandbox({
      backend,
      tenantRef: TENANT,
      resourceId: RESOURCE_ID,
      start: START,
      end: END,
      agents: 6,
      signal: new AbortController().signal,
    });
    await until(() => begun.length === 1);
    finishFirst();
    expect(await race).toMatchObject({ agents: 6, booked: 1, refused: { overlap: 5 }, serverErrors: 0 });
    expect(begun).toHaveLength(6);
  });

  it('ends with its request: once it is gone, no racer still waiting begins, and the race rejects', async () => {
    // A 60-agent race whose client left after 43 ms still ran all 60 bookings when the racers'
    // requests never aborted.
    const { backend, begun, finishFirst } = racingBackend();
    const controller = new AbortController();
    const race = raceSlotlockSandbox({
      backend,
      tenantRef: TENANT,
      resourceId: RESOURCE_ID,
      start: START,
      end: END,
      agents: 6,
      signal: controller.signal,
    });
    const settled = race.then(
      () => 'resolved',
      (error: unknown) => error,
    );
    await until(() => begun.length === 1);
    controller.abort();
    finishFirst();
    expect(await settled).toMatchObject({ name: 'AbortError' });
    expect(begun).toEqual(['Sandbox racer 1']);
  });

  it('runs no agent for a request already gone', async () => {
    const { backend, begun } = racingBackend();
    const race = raceSlotlockSandbox({
      backend,
      tenantRef: TENANT,
      resourceId: RESOURCE_ID,
      start: START,
      end: END,
      agents: 6,
      signal: AbortSignal.abort(),
    });
    await expect(race).rejects.toMatchObject({ name: 'AbortError' });
    expect(begun).toEqual([]);
  });
});
