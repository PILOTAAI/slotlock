// slotlock_find_available_slots lists the slots a person can choose from, built from the backend's
// own next-available search, and writes are never callable from an MCP Apps view.
import { expect, it } from 'vitest';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentServerOptions,
  createSlotlockAgentServer,
} from '../agent-server.js';
import { findNextAvailable } from '../engine.js';

const unused = async () => ({});
const VAN = '0f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b';
const ROOM = '1f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b';
const at = (time: string) => new Date(`2027-03-01T${time}:00.000Z`);

/** Open 09:00 to 12:00, the van busy 10:00 to 11:00: the backend answers as the store does. */
function backend(uncertain: string[] = []) {
  const calls: string[] = [];
  const busy: Record<string, { start: Date; end: Date }[]> = {
    [VAN]: [{ start: at('10:00'), end: at('11:00') }],
    [ROOM]: [],
  };
  const findNext: SlotlockAgentCalendarBackend['findNextAvailable'] = async (_context, input) => {
    const [resourceId] = input.resource_ids as string[];
    calls.push(`${resourceId}@${new Date(input.start as string).toISOString().slice(11, 16)}`);
    const window = { start: new Date(input.start as string), end: new Date(input.end as string) };
    const coverage = {
      start: window.start.toISOString(),
      end: window.end.toISOString(),
      certainty: uncertain.includes(resourceId as string) ? 'uncertain' : 'certain',
      reason: uncertain.includes(resourceId as string) ? 'coverage_incomplete' : null,
    };
    const open = { start: at('09:00'), end: at('12:00') };
    const windows = [
      {
        start: new Date(Math.max(open.start.getTime(), window.start.getTime())),
        end: new Date(Math.min(open.end.getTime(), window.end.getTime())),
      },
    ].filter((w) => w.end > w.start);
    const slot = findNextAvailable({
      busy: busy[resourceId as string] ?? [],
      windows,
      durationMs: (input.duration_minutes as number) * 60_000,
    });
    return {
      resource_id: slot ? resourceId : null,
      start: slot?.start.toISOString() ?? null,
      end: slot?.end.toISOString() ?? null,
      coverage,
    };
  };
  return { calls, findNext };
}

function server(findNext: SlotlockAgentCalendarBackend['findNextAvailable']) {
  const options: SlotlockAgentServerOptions = {
    publicBaseUrl: 'http://localhost/slotlock',
    allowInsecureLocalhost: true,
    backend: {
      listResources: unused,
      getFreeBusy: unused,
      findNextAvailable: findNext,
      createEvent: unused,
      getEvent: unused,
      listEvents: unused,
      updateEvent: unused,
      deleteEvent: unused,
    },
    authenticate: async () => ({ subject: 'agent', tenantRef: 'tenant-a' }),
    authorize: async () => true,
    health: async () => ({ ready: true, checks: [] }),
  };
  return createSlotlockAgentServer(options);
}

async function rpc(
  target: ReturnType<typeof createSlotlockAgentServer>,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await target.fetch(
    new Request('http://localhost/slotlock/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return ((await response.json()) as { result: Record<string, unknown> }).result;
}

const slotsOf = async (
  target: ReturnType<typeof createSlotlockAgentServer>,
  args: Record<string, unknown>,
) => {
  const result = await rpc(target, 'tools/call', { name: 'slotlock_find_available_slots', arguments: args });
  return result.structuredContent as {
    slots: { resource_id: string; start: string; end: string }[];
    coverage: { certainty: string };
  };
};

const day = { start: '2027-03-01T00:00:00Z', end: '2027-03-02T00:00:00Z' };

it('lists slots earliest first across resources, inside hours and around busy time', async () => {
  const { calls, findNext } = backend();
  const answer = await slotsOf(server(findNext), {
    resource_ids: [VAN, ROOM],
    ...day,
    duration_minutes: 60,
  });
  expect(answer.coverage.certainty).toBe('certain');
  expect(answer.slots.map((slot) => `${slot.resource_id === VAN ? 'van' : 'room'} ${slot.start.slice(11, 16)}`)).toEqual([
    'van 09:00',
    'room 09:00',
    'room 10:00',
    'van 11:00',
    'room 11:00',
  ]);
  // One search per resource, then one after each listed slot that leaves room for another.
  expect(calls.length).toBeLessThanOrEqual(2 + answer.slots.length);
});

it('stops at the limit', async () => {
  const { calls, findNext } = backend();
  const answer = await slotsOf(server(findNext), {
    resource_ids: [VAN, ROOM],
    ...day,
    duration_minutes: 30,
    limit: 3,
  });
  expect(answer.slots.map((slot) => slot.start.slice(11, 16))).toEqual(['09:00', '09:00', '09:30']);
  expect(calls.length).toBeLessThanOrEqual(2 + 3);
});

it('lists nothing when any resource is uncertain, as a single answer does', async () => {
  const { findNext } = backend([ROOM]);
  const answer = await slotsOf(server(findNext), {
    resource_ids: [VAN, ROOM],
    ...day,
    duration_minutes: 60,
  });
  expect(answer).toMatchObject({ slots: [], coverage: { certainty: 'uncertain', reason: 'coverage_incomplete' } });
});

it('refuses more resources or slots than it bounds its searches to', async () => {
  const { findNext } = backend();
  const many = Array.from({ length: 21 }, (_, index) => `${String(index).padStart(8, '0')}-2d4a-4c7e-9b1a-3e5f7a9c2d4b`);
  for (const args of [
    { resource_ids: many, ...day, duration_minutes: 60 },
    { resource_ids: [VAN], ...day, duration_minutes: 60, limit: 51 },
  ]) {
    const result = await rpc(server(findNext), 'tools/call', {
      name: 'slotlock_find_available_slots',
      arguments: args,
    });
    expect(result).toMatchObject({ isError: true });
  }
});

it('lets a calendar view call reads, and only the model call writes', async () => {
  const { findNext } = backend();
  const { tools } = (await rpc(server(findNext), 'tools/list', {})) as {
    tools: { name: string; annotations: { readOnlyHint: boolean }; _meta: { ui: { visibility: string[] } } }[];
  };
  for (const tool of tools) {
    expect(tool._meta.ui.visibility, tool.name).toEqual(
      tool.annotations.readOnlyHint ? ['model', 'app'] : ['model'],
    );
  }
  expect(tools.filter((tool) => !tool.annotations.readOnlyHint).map((tool) => tool.name).sort()).toEqual([
    'slotlock_book_pool',
    'slotlock_book_together',
    'slotlock_create_event',
    'slotlock_delete_event',
    'slotlock_hold_slots',
    'slotlock_release_slots',
    'slotlock_update_event',
  ]);
});
