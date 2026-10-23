// Scheduled maintenance: run at least daily for every tenant, as the application role. `slotlock
// serve` does this for the tenants it serves; a process of your own calls maintainSlotlockTenant.
// #region maintenance
import { type SlotlockStore, maintainSlotlockTenant } from 'slotlock';

export async function maintainTenant(store: SlotlockStore, tenantRef: string) {
  // Extends recurring events to the rolling horizon, then prunes past the retention window, each in
  // at most ten batches. `capped: true` means work was left: run another pass.
  return maintainSlotlockTenant(store, tenantRef, { batches: 10 });
}
// #endregion maintenance
