// Dry runs at the operation boundary (RFC 0004 A3): a dry run reaches the backend as one, is never
// put to a person to confirm, and is refused on a read. The store's rollback is in
// dry-run.integration.test.ts.
import { describe, expect, it, vi } from 'vitest';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentInvocationContext,
  SlotlockAgentOperationError,
  invokeSlotlockAgentOperation,
} from '../agent-server.js';

const principal = { subject: 'agent-1', tenantRef: 'tenant-1', scopes: ['read', 'write'] };
const input = {
  resource_id: 'van-1',
  starts_at: '2027-03-02T09:00:00Z',
  ends_at: '2027-03-02T10:00:00Z',
  timezone: 'UTC',
  idempotency_key: 'k-1',
};

function setup() {
  const seen: SlotlockAgentInvocationContext[] = [];
  const backend = {
    createEvent: vi.fn(async (context: SlotlockAgentInvocationContext) => {
      seen.push(context);
      throw new SlotlockAgentOperationError('revision_conflict', 409);
    }),
    listResources: vi.fn(async () => ({ resources: [], next_cursor: null })),
  } as unknown as SlotlockAgentCalendarBackend;
  const confirm = vi.fn(async () => ({ status: 428, code: 'confirmation_required' }));
  const options = {
    backend,
    authenticate: async () => principal,
    authorize: async () => true,
    confirm,
  };
  return { backend, confirm, options, seen };
}

describe('dry runs at the operation boundary', () => {
  it('hands the backend a dry run, never asks a person, and still asks for the real write', async () => {
    const { confirm, options, seen } = setup();
    const call = (extra: Record<string, unknown>) =>
      invokeSlotlockAgentOperation({
        operation: 'slotlock_create_event',
        input: { ...input, ...extra },
        request: new Request('https://example.com'),
        options: options as never,
      });
    expect(await call({ dry_run: true })).toMatchObject({ ok: false, code: 'revision_conflict' });
    expect(confirm).not.toHaveBeenCalled();
    expect(seen[0]?.dryRun).toBe(true);
    expect(await call({})).toMatchObject({ ok: false, code: 'confirmation_required' });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('refuses dry_run on a read, and one that is not a boolean', async () => {
    const { backend, options } = setup();
    for (const [operation, given] of [
      ['slotlock_list_resources', { dry_run: true }],
      ['slotlock_create_event', { ...input, dry_run: 'yes' }],
    ] as const) {
      expect(
        await invokeSlotlockAgentOperation({
          operation,
          input: given,
          request: new Request('https://example.com'),
          options: options as never,
        }),
      ).toMatchObject({ ok: false, status: 400, code: 'invalid_arguments' });
    }
    expect(backend.listResources).not.toHaveBeenCalled();
  });
});
