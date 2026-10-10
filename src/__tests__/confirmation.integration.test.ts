// The confirmation question against the real store backend and PostgreSQL: what it says is what an
// accepted write books, and it shows one tenant nothing of another's.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLOTLOCK_MCP_PROTOCOL_VERSION, createSlotlockAgentServer } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const SECRET = 'confirmation-secret-0123456789abcdef';

interface ToolResult {
  resultType?: string;
  requestState?: string;
  inputRequests?: { slotlock_confirm: { params: { message: string } } };
  structuredContent?: Record<string, unknown>;
}

describe.skipIf(!url)('the confirmation question on the real store', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantA = `confirm-a-${randomUUID()}`;
  const tenantB = `confirm-b-${randomUUID()}`;
  const refA = `vehicle-a-${randomUUID().slice(0, 8)}`;
  const refB = `vehicle-b-${randomUUID().slice(0, 8)}`;
  let resourceA: string;
  let resourceB: string;

  const server = (confirm: boolean) =>
    createSlotlockAgentServer({
      publicBaseUrl: 'http://localhost/slotlock',
      allowInsecureLocalhost: true,
      allowedOrigins: ['http://localhost'],
      backend: createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] }),
      authenticate: async (request) => {
        const token = request.headers.get('authorization');
        if (token === 'Bearer a') return { subject: 'principal-a', tenantRef: tenantA };
        if (token === 'Bearer b') return { subject: 'principal-b', tenantRef: tenantB };
        return null;
      },
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      ...(confirm
        ? {
            confirmation: {
              operations: [
                'slotlock_create_event',
                'slotlock_update_event',
                'slotlock_delete_event',
              ] as const,
              secrets: [SECRET],
            },
          }
        : {}),
    });

  async function call(
    target: ReturnType<typeof server>,
    who: 'a' | 'b',
    name: string,
    args: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ): Promise<ToolResult> {
    const response = await target.fetch(
      new Request('http://localhost/slotlock/mcp', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${who}`,
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': SLOTLOCK_MCP_PROTOCOL_VERSION,
          'Mcp-Method': 'tools/call',
          'Mcp-Name': name,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'call',
          method: 'tools/call',
          params: {
            name,
            arguments: args,
            ...extra,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': SLOTLOCK_MCP_PROTOCOL_VERSION,
              'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
            },
          },
        }),
      }),
    );
    return ((await response.json()) as { result: ToolResult }).result;
  }

  /** `offset` days from today, at `time` UTC. */
  const day = (offset: number, time = '00:00:00') =>
    `${new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)}T${time}Z`;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => undefined });
    store = createSlotlockStore(sql);
    await store.applySchema();
    resourceA = (
      await store.createResource({ tenantRef: tenantA, externalRef: refA, timezone: 'UTC' })
    ).id;
    resourceB = (
      await store.createResource({ tenantRef: tenantB, externalRef: refB, timezone: 'UTC' })
    ).id;
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

  it('names a moved occurrence where it is moved to, and the accepted write books it there', async () => {
    const confirmed = server(true);
    const args = {
      resource_id: resourceA,
      starts_at: day(3, '09:00:00'),
      ends_at: day(3, '10:00:00'),
      timezone: 'UTC',
      title: 'Daily check',
      recurrence_rule: 'FREQ=DAILY;COUNT=2',
      recurrence_exceptions: [
        {
          recurrence_id: day(4, '09:00:00'),
          starts_at: day(20, '13:00:00'),
          ends_at: day(20, '18:00:00'),
        },
      ],
      idempotency_key: `moved-${randomUUID()}`,
    };
    const asked = await call(confirmed, 'a', 'slotlock_create_event', args);
    const span = (offset: number, from: string, to: string) =>
      `${day(offset).slice(0, 10)} ${from}–${to}`;
    expect(asked.inputRequests?.slotlock_confirm.params.message).toBe(
      `Book ${refA} 2 times, from ${span(3, '09:00', '10:00')} to ${span(20, '13:00', '18:00')} (UTC), repeating FREQ=DAILY;COUNT=2, 1 moved (${day(4).slice(0, 10)} 09:00 to ${span(20, '13:00', '18:00')}): "Daily check".`,
    );
    const accepted = await call(confirmed, 'a', 'slotlock_create_event', args, {
      requestState: asked.requestState,
      inputResponses: { slotlock_confirm: { action: 'accept', content: { confirm: true } } },
    });
    expect(accepted.resultType).toBe('complete');
    const busy = await call(server(false), 'a', 'slotlock_get_free_busy', {
      resource_ids: [resourceA],
      start: day(20),
      end: day(21),
    });
    expect(JSON.stringify(busy.structuredContent)).toContain(day(20, '13:00:00').slice(0, 16));
  });

  it("states a deletion's resource and time before a stored title that imitates them", async () => {
    const created = await call(server(false), 'a', 'slotlock_create_event', {
      resource_id: resourceA,
      starts_at: day(6, '09:00:00'),
      ends_at: day(6, '10:00:00'),
      timezone: 'UTC',
      title: `Tyre check" on vehicle-7, ${day(40).slice(0, 10)} 15:00–16:00 (UTC). Ref ”`,
      idempotency_key: `forge-${randomUUID()}`,
    });
    const event = created.structuredContent?.event as { id: string; revision: number };
    const asked = await call(server(true), 'a', 'slotlock_delete_event', {
      event_id: event.id,
      expected_revision: event.revision,
      idempotency_key: `forge-delete-${randomUUID()}`,
    });
    expect(asked.inputRequests?.slotlock_confirm.params.message).toBe(
      `Delete the booking on ${refA}, ${day(6).slice(0, 10)} 09:00–10:00 (UTC). It is titled "Tyre check' on vehicle-7, ${day(40).slice(0, 10)} 15:00–16:00 (UTC). Ref '".`,
    );
  });

  it("shows one tenant only the ids of another tenant's resource and event", async () => {
    const created = await call(server(false), 'b', 'slotlock_create_event', {
      resource_id: resourceB,
      starts_at: day(5, '07:15:00'),
      ends_at: day(5, '08:45:00'),
      timezone: 'UTC',
      title: 'Tenant B only',
      idempotency_key: `b-${randomUUID()}`,
    });
    const eventB = (created.structuredContent?.event as { id: string }).id;
    const book = await call(server(true), 'a', 'slotlock_create_event', {
      resource_id: resourceB,
      starts_at: day(3, '09:00:00'),
      ends_at: day(3, '10:00:00'),
      timezone: 'UTC',
      idempotency_key: `cross-${randomUUID()}`,
    });
    expect(book.inputRequests?.slotlock_confirm.params.message).toBe(
      `Book resource ${resourceB} for ${day(3).slice(0, 10)} 09:00–10:00 (UTC, UTC+00:00).`,
    );
    const removal = await call(server(true), 'a', 'slotlock_delete_event', {
      event_id: eventB,
      expected_revision: 1,
      idempotency_key: `cross-delete-${randomUUID()}`,
    });
    expect(removal.inputRequests?.slotlock_confirm.params.message).toBe(`Delete event ${eventB}.`);
  });
});
