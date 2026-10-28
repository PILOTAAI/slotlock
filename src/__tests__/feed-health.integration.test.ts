// Feed health against real Postgres: a source's last error is kept beside its coverage, a source
// that goes stale is shown stale and put on the change feed once until it is read again, and a
// source that never recorded coverage cannot record a failure. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('feed health (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const tenantRef = `feeds-${randomUUID()}`;
  const as = { principal: { subject: 'api_key:sync', tenantRef, scopes: ['admin'] }, operation: 'x' as never, signal: new AbortController().signal };

  beforeAll(async () => {
    sql = postgres(url as string, { max: 4, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql.end();
  });

  it('keeps a failed read, shows a stale source, reports it once, and clears it on the next read', async () => {
    const app = createSlotlockStoreApplicationBackend(store);
    const { resource } = (await app.createResource(as, { external_ref: 'van', timezone: 'UTC' })) as { resource: { id: string } };
    const window = { start: '2027-01-01T00:00:00Z', end: '2027-03-01T00:00:00Z' };
    await app.recordCoverage(as, { resource_id: resource.id, source: 'google:fleet', ...window, revision: 1 });
    await expect(
      app.recordCoverageFailure(as, { resource_id: resource.id, source: 'ics:never', error: 'HTTP 500' }),
    ).rejects.toMatchObject({ code: 'coverage_not_found', status: 404 });
    expect(
      await app.recordCoverageFailure(as, { resource_id: resource.id, source: 'google:fleet', error: 'HTTP 401: token expired' }),
    ).toEqual({ recorded: true });
    const fresh = (await app.getCoverage(as, { resource_id: resource.id })) as { sources: Record<string, unknown>[] };
    expect(fresh.sources).toEqual([
      expect.objectContaining({ source: 'google:fleet', revision: 1, last_error: 'HTTP 401: token expired', stale: false }),
    ]);

    // Not read for two days: stale, and on the feed once.
    await sql`UPDATE slotlock.calendar_coverage SET observed_at = now() - interval '2 days' WHERE tenant_ref = ${tenantRef}`;
    expect(((await app.getCoverage(as, { resource_id: resource.id })) as { sources: { stale: boolean }[] }).sources[0]?.stale).toBe(true);
    const report = () => store.withTenant(tenantRef, (tenant) => tenant.reportStaleCoverage({ tenantRef }));
    expect(await report()).toBe(1);
    expect(await report()).toBe(0);
    // Named by its digest, as slotlock_get_coverage gives it; the source and its error stay off the feed.
    const sourceId = (fresh.sources[0] as { source_id: string }).source_id;
    const [stale] = await store.listHistory({ tenantRef, subject: sourceId, limit: 1 });
    expect(stale).toMatchObject({ type: 'coverage.stale', data: { resource_id: resource.id, source_id: sourceId } });
    expect(JSON.stringify(stale)).not.toMatch(/google:fleet|token expired/);

    // Read again, then stale again: reported again.
    await app.recordCoverage(as, { resource_id: resource.id, source: 'google:fleet', ...window, revision: 2 });
    expect(((await app.getCoverage(as, { resource_id: resource.id })) as { sources: { stale: boolean }[] }).sources[0]?.stale).toBe(false);
    await sql`UPDATE slotlock.calendar_coverage SET observed_at = now() - interval '2 days' WHERE tenant_ref = ${tenantRef}`;
    expect(await report()).toBe(1);
  });
});
