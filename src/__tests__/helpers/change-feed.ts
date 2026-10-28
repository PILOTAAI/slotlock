// An in-memory change feed for live-update tests: each tenant's changes in order, a position that is
// the count read so far, a wake-up per tenant like LISTEN/NOTIFY, and an expired cursor on demand.
import { vi } from 'vitest';
import type { SlotlockAgentChangeSource } from '../../change-watch.js';

export function createFakeChangeFeed(options: { wakes?: boolean } = {}) {
  const logs = new Map<string, { resourceId: string | null }[]>();
  const listeners = new Map<string, () => void>();
  const expired = new Set<string>();
  const stopped: string[] = [];
  const log = (tenantRef: string) => {
    let entries = logs.get(tenantRef);
    if (!entries) logs.set(tenantRef, (entries = []));
    return entries;
  };
  const source = {
    head: vi.fn(async (tenantRef: string) => String(log(tenantRef).length)),
    listChanges: vi.fn<SlotlockAgentChangeSource['listChanges']>(async ({ tenantRef, after }) => {
      if (expired.delete(tenantRef)) return { ok: false, code: 'cursor_expired' };
      const entries = log(tenantRef);
      return { ok: true, changes: entries.slice(Number(after)), next: String(entries.length) };
    }),
    ...(options.wakes === false
      ? {}
      : {
          watch: vi.fn(async (tenantRef: string, wake: () => void) => {
            listeners.set(tenantRef, wake);
            return () => {
              stopped.push(tenantRef);
              listeners.delete(tenantRef);
            };
          }),
        }),
  } satisfies SlotlockAgentChangeSource;
  return {
    source,
    /** Append a change for the tenant and wake its listener, as a commit's NOTIFY would. */
    publish(tenantRef: string, resourceId: string | null) {
      log(tenantRef).push({ resourceId });
      listeners.get(tenantRef)?.();
    },
    /** The tenant's next read answers cursor_expired, as after a prune past its position. */
    expire(tenantRef: string) {
      expired.add(tenantRef);
      listeners.get(tenantRef)?.();
    },
    listening: () => [...listeners.keys()],
    stopped,
  };
}
