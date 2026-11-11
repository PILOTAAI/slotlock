// The locations and groups the person signed in to the dashboard is limited to (RFC 0004 D1), for
// the request being served. The dashboard sets it once it has read the person's standing; the
// store its resources read through (createSlotlockDashboardResources) runs each transaction with it
// as its resource scope, so the database's resource_scope_v1 policies keep every read and write to
// those resources, as they do for a key limited to them.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SlotlockResourceScope } from './resource-profile.js';

const requests = new AsyncLocalStorage<{ scope: SlotlockResourceScope | null }>();

/** Serve one dashboard request with a scope of its own, none until the person's is read. */
export function runSlotlockDashboardRequest<T>(serve: () => T): T {
  return requests.run({ scope: null }, serve);
}

/** The request's person is limited to `scope`: what is read for them from now on keeps to it. */
export function setSlotlockDashboardRequestScope(scope: SlotlockResourceScope | null): void {
  const request = requests.getStore();
  if (request) request.scope = scope;
}

/** The scope of the dashboard request being served, or null for none (or outside a request). */
export function slotlockDashboardRequestScope(): SlotlockResourceScope | null {
  return requests.getStore()?.scope ?? null;
}
