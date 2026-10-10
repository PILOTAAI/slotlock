// Scheduled maintenance: run at least daily for every tenant, as the application role.
// #region maintenance
import { type SlotlockStore, calendarEventRollingHorizon } from 'slotlock';

const MAX_BATCHES = 10;

export async function maintainTenant(store: SlotlockStore, tenantRef: string) {
  const window = calendarEventRollingHorizon();
  let extended = 0;
  let conflicts = 0;
  let horizonCapped = true;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const roll = await store.withTenant(tenantRef, (tenant) =>
      tenant.rollCalendarEventHorizon({ tenantRef, window }),
    );
    extended += roll.extended;
    conflicts += roll.conflicts;
    if (!roll.hasMore) {
      horizonCapped = false;
      break;
    }
  }

  let pruned = 0;
  let retentionCapped = true;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const prune = await store.withTenant(tenantRef, (tenant) =>
      tenant.pruneCalendarEventRetention({ tenantRef }),
    );
    pruned += prune.commandsDeleted + prune.tombstonesDeleted;
    if (!prune.hasMore) {
      retentionCapped = false;
      break;
    }
  }
  return { extended, conflicts, pruned, capped: horizonCapped || retentionCapped };
}
// #endregion maintenance
