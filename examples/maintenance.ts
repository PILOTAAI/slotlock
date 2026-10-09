// Scheduled maintenance: run at least daily for every tenant, as the application role.
// #region maintenance
import { type SlotlockStore, calendarEventRollingHorizon } from 'slotlock';

const MAX_BATCHES = 10;

export async function maintainTenant(store: SlotlockStore, tenantRef: string) {
  // 1. Keep recurring events materialized across the rolling 367-day horizon. Beyond it, free/busy
  //    reports the time as unproven rather than free.
  const window = calendarEventRollingHorizon();
  let extended = 0;
  let conflicts = 0;
  let horizonCapped = true;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const roll = await store.withTenant(tenantRef, (tenant) =>
      tenant.rollCalendarEventHorizon({ tenantRef, window }),
    );
    extended += roll.extended;
    conflicts += roll.conflicts; // a colliding occurrence keeps its previous horizon
    if (!roll.hasMore) {
      horizonCapped = false;
      break;
    }
  }

  // 2. Release agent quota: idempotency commands and agent tombstones past the 30-day replay window.
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
  // A capped run finishes on the next one; alert if it stays capped.
  return { extended, conflicts, pruned, capped: horizonCapped || retentionCapped };
}
// #endregion maintenance
