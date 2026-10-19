// A resource id that names no resource of the caller's tenant answers `resource_not_found` on every
// surface (MCP 2025 and 2026-07-28, REST, A2A), on the real store and PostgreSQL, and never a server
// error. Ids the store never issues (an external reference such as the quickstart's `vehicle-42`,
// the nil UUID, a version 7 UUID) are not found, exactly like a version 4 UUID that names nothing or
// another tenant's resource: refusing them as not found widens nothing. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_A2A_PROTOCOL_VERSION,
  SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
  type SlotlockAgentOperation,
  createSlotlockAgentServer,
  slotlockCalendarResourceUri,
} from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { modernRequest, rpc } from './helpers/modern-mcp.js';

const url = process.env.DATABASE_URL?.trim();
const BASE = 'http://localhost/slotlock';
const TOKEN = 'Bearer tenant-a';

describe.skipIf(!url)('a resource id that names no resource, on the real store', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantA = `missing-a-${randomUUID()}`;
  const tenantB = `missing-b-${randomUUID()}`;
  const onError = vi.fn();
  let resourceA: string;
  let foreignResource: string;
  let event: { id: string; revision: number };

  const server = () =>
    createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: createSlotlockStoreAgentBackend(store, {
        availabilityRules: async () => [
          {
            rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
            startMinutes: 0,
            durationMinutes: 1440,
          },
        ],
      }),
      authenticate: async (request) =>
        request.headers.get('authorization') === TOKEN
          ? { subject: 'principal-a', tenantRef: tenantA }
          : null,
      authorize: async () => true,
      health: async () => ({ ready: true, checks: ['database'] }),
      rest: true,
      onError,
    });

  const day = (offset: number, time = '00:00:00') =>
    `${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T${time}Z`;
  const window = () => ({ start: day(1), end: day(8) });

  /** The arguments of each operation that names a resource, naming `id`. */
  const callsNaming = (id: string): [SlotlockAgentOperation, Record<string, unknown>][] => [
    ['slotlock_get_free_busy', { resource_ids: [id], ...window() }],
    ['slotlock_find_next_available', { resource_ids: [id], ...window(), duration_minutes: 60 }],
    ['slotlock_list_events', { resource_ids: [id], ...window() }],
    [
      'slotlock_create_event',
      {
        resource_id: id,
        starts_at: day(3, '09:00:00'),
        ends_at: day(3, '10:00:00'),
        timezone: 'UTC',
        idempotency_key: `create-${randomUUID()}`,
      },
    ],
    [
      'slotlock_update_event',
      {
        event_id: event.id,
        resource_id: id,
        expected_revision: event.revision,
        idempotency_key: `move-${randomUUID()}`,
      },
    ],
  ];

  /** The REST request for one of those calls. */
  function restRequest(operation: SlotlockAgentOperation, input: Record<string, unknown>): Request {
    const headers = { Authorization: TOKEN };
    const query = (path: string) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(input)) {
        for (const item of Array.isArray(value) ? value : [value]) params.append(key, String(item));
      }
      return new Request(`${BASE}${path}?${params}`, { headers });
    };
    const body = (method: string, path: string, value: Record<string, unknown>) =>
      new Request(`${BASE}${path}`, {
        method,
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
    switch (operation) {
      case 'slotlock_get_free_busy':
        return query('/v1/free-busy');
      case 'slotlock_find_next_available':
        return query('/v1/next-available');
      case 'slotlock_list_events':
        return query('/v1/events');
      case 'slotlock_create_event':
        return body('POST', '/v1/events', input);
      default: {
        const { event_id, ...rest } = input;
        return body('PATCH', `/v1/events/${encodeURIComponent(String(event_id))}`, rest);
      }
    }
  }

  const legacyMcp = (name: string, args: Record<string, unknown>) =>
    new Request(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: TOKEN,
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

  const a2a = (skill: string, args: Record<string, unknown>) =>
    new Request(`${BASE}/a2a`, {
      method: 'POST',
      headers: {
        Authorization: TOKEN,
        'Content-Type': 'application/json',
        'A2A-Version': SLOTLOCK_A2A_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'a2a-1',
        method: 'SendMessage',
        params: {
          message: {
            messageId: `message-${randomUUID()}`,
            role: 'ROLE_USER',
            parts: [{ data: { skill, arguments: args }, mediaType: 'application/json' }],
          },
        },
      }),
    });

  const notFoundResult = {
    content: [{ type: 'text', text: '{"error":{"code":"resource_not_found"}}' }],
    isError: true,
  };

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => undefined });
    store = createSlotlockStore(sql);
    await store.applySchema();
    // The quickstart's resource, so `vehicle-42` is its external reference here, not a made-up id.
    resourceA = (
      await store.createResource({ tenantRef: tenantA, externalRef: 'vehicle-42', timezone: 'UTC' })
    ).id;
    foreignResource = (
      await store.createResource({ tenantRef: tenantB, externalRef: 'vehicle-42', timezone: 'UTC' })
    ).id;
    const created = await server().fetch(
      restRequest('slotlock_create_event', {
        resource_id: resourceA,
        starts_at: day(2, '09:00:00'),
        ends_at: day(2, '10:00:00'),
        timezone: 'UTC',
        idempotency_key: `seed-${randomUUID()}`,
      }),
    );
    expect(created.status).toBe(200);
    event = ((await created.json()) as { event: { id: string; revision: number } }).event;
  });

  afterAll(async () => {
    for (const tenant of [tenantA, tenantB]) {
      await sql`DELETE FROM slotlock.calendar_event_commands WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_event_occurrences WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_coverage WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_events WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.calendar_event_tombstones WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.reservations WHERE tenant_ref = ${tenant}`;
      await sql`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenant}`;
    }
    await sql.end();
  });

  const unknownIds = (): [string, string][] => [
    ['an external reference (the quickstart passes vehicle-42)', 'vehicle-42'],
    ['the nil UUID', '00000000-0000-0000-0000-000000000000'],
    ['a version 7 UUID', '01928f3a-5b6c-7d8e-9f01-23456789abcd'],
    ['a version 4 UUID that names nothing', randomUUID()],
    ["another tenant's resource", foreignResource],
  ];

  it('answers resource_not_found over MCP 2025-11-25, MCP 2026-07-28, REST and A2A', async () => {
    const failures: string[] = [];
    for (const [what, id] of unknownIds()) {
      for (const [operation, input] of callsNaming(id)) {
        const where = `${operation} with ${what}`;
        const legacy = await server().fetch(legacyMcp(operation, input));
        const legacyBody = (await legacy.json()) as Record<string, unknown>;
        if (legacy.status !== 200 || !isEqual(legacyBody.result, notFoundResult)) {
          failures.push(`${where} over MCP 2025: ${legacy.status} ${JSON.stringify(legacyBody)}`);
        }

        const modern = await server().fetch(
          modernRequest(
            'tools/call',
            { name: operation, arguments: input },
            { headers: { Authorization: TOKEN } },
          ),
        );
        const modernBody = await rpc(modern);
        const modernResult = modernBody.result as Record<string, unknown> | undefined;
        if (
          modern.status !== 200 ||
          !isEqual(modernResult?.content, notFoundResult.content) ||
          modernResult?.isError !== true
        ) {
          failures.push(`${where} over MCP 2026: ${modern.status} ${JSON.stringify(modernBody)}`);
        }

        const rest = await server().fetch(restRequest(operation, input));
        const restBody = await rest.json();
        if (rest.status !== 404 || !isEqual(restBody, { error: { code: 'resource_not_found' } })) {
          failures.push(`${where} over REST: ${rest.status} ${JSON.stringify(restBody)}`);
        }

        const agent = await server().fetch(a2a(operation, input));
        const agentBody = (await agent.json()) as {
          result?: { message?: { parts?: { data?: unknown }[] } };
        };
        if (
          agent.status !== 200 ||
          !isEqual(agentBody.result?.message?.parts?.[0]?.data, {
            error: { code: 'resource_not_found' },
          })
        ) {
          failures.push(`${where} over A2A: ${agent.status} ${JSON.stringify(agentBody)}`);
        }
      }
    }
    expect(failures).toEqual([]);
    // None of these is a server fault, so none is reported as one.
    expect(onError).not.toHaveBeenCalled();
  });

  it('reads none of them as an MCP calendar resource, without a server error', async () => {
    for (const [what, id] of unknownIds()) {
      const uri = slotlockCalendarResourceUri(id);
      const response = await server().fetch(
        modernRequest('resources/read', { uri }, { headers: { Authorization: TOKEN } }),
      );
      expect(response.status, what).toBe(200);
      expect((await rpc(response)).error, what).toMatchObject({
        code: -32602,
        message: 'Resource not found',
      });
    }
    expect(onError).not.toHaveBeenCalled();
  });

  it('still answers for the resource the id does name, and left the event where it was', async () => {
    const found = await server().fetch(
      restRequest('slotlock_get_free_busy', { resource_ids: [resourceA], ...window() }),
    );
    expect(found.status).toBe(200);
    const read = await server().fetch(
      new Request(`${BASE}/v1/events/${encodeURIComponent(event.id)}`, {
        headers: { Authorization: TOKEN },
      }),
    );
    expect(((await read.json()) as { event: unknown }).event).toMatchObject({
      resource_id: resourceA,
      revision: event.revision,
    });
  });
});

function isEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
