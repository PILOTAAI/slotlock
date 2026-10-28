// Default booking rules for a tenant and its pools, against real Postgres as a LOGIN role without
// BYPASSRLS that grantApplicationRole granted: a resource's rules are the tenant's defaults,
// overlaid by its pool's, overlaid by its own, on writes, searches and what the API returns; the
// defaults table is under forced row-level security; erase_tenant deletes it. Skipped without
// DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import type { SlotlockApplicationInvocationContext } from '../application-api.js';
import { type SlotlockStore, type SlotlockTenantStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe.skipIf(!url)('default booking rules (real Postgres, application role)', () => {
  const role = `slotlock_rules_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenant = `rules-defaults-${randomUUID()}`;
  const other = `rules-defaults-${randomUUID()}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  // Two weeks ahead, on the hour.
  const base = new Date(Math.ceil((Date.now() + 14 * DAY) / HOUR) * HOUR);
  const at = (hours: number, minutes = 0) => new Date(base.getTime() + hours * HOUR + minutes * MINUTE);

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    application = postgres(Object.assign(new URL(url as string), { username: role, password }).href, {
      max: 4,
      onnotice: () => {},
    });
    store = createSlotlockStore(application);
  });

  afterAll(async () => {
    for (const ref of [tenant, other]) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  const as = <T>(tenantRef: string, run: (scoped: SlotlockTenantStore) => Promise<T>) =>
    store.withTenant(tenantRef, run, { isolation: 'read committed' });

  async function resource(tenantRef: string, pool: string | null) {
    return as(tenantRef, async (scoped) => {
      const created = await scoped.createResource({ tenantRef, externalRef: `van-${randomUUID()}`, timezone: 'UTC' });
      if (pool !== null) await scoped.setResourcePool({ tenantRef, id: created.id, pool });
      return created.id;
    });
  }

  const book = (resourceId: string, start: Date, end: Date) =>
    as(tenant, (scoped) =>
      scoped.createExternalReservation({
        tenantRef: tenant,
        externalRef: `b-${randomUUID()}`,
        resourceId,
        start,
        end,
        bufferAfterMs: 0,
        revision: 1,
      }),
    );

  it('keeps the defaults table under forced row-level security', async () => {
    const [table] = await admin<{ enabled: boolean; forced: boolean }[]>`
      SELECT c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'slotlock' AND c.relname = 'booking_rule_defaults'`;
    expect(table).toEqual({ enabled: true, forced: true });
  });

  it('applies tenant defaults, overlaid by the pool’s, overlaid by the resource’s own', async () => {
    const plain = await resource(tenant, null);
    const member = await resource(tenant, 'van');
    const own = await resource(tenant, 'van');
    await as(tenant, async (scoped) => {
      expect(
        await scoped.setBookingRuleDefaults({
          tenantRef: tenant,
          pool: null,
          rules: { minNoticeMinutes: 60 * 24 * 365, turnaroundMinutes: 30, enforceHours: false },
        }),
      ).toEqual({ minNoticeMinutes: 525_600, turnaroundMinutes: 30, enforceHours: false });
      await scoped.setBookingRuleDefaults({
        tenantRef: tenant,
        pool: 'van',
        rules: { minNoticeMinutes: 0, bufferBeforeMinutes: 15 },
      });
      await scoped.setResourceBookingRules({ tenantRef: tenant, id: own, rules: { turnaroundMinutes: 0 } });
    });
    const effective = async (id: string) =>
      as(tenant, async (scoped) => (await scoped.getResource({ tenantRef: tenant, id }))?.effectiveBookingRules);
    expect(await effective(plain)).toEqual({ minNoticeMinutes: 525_600, turnaroundMinutes: 30, enforceHours: false });
    // The pool's notice wins over the tenant's; its lead buffer is added.
    expect(await effective(member)).toEqual({
      minNoticeMinutes: 0,
      turnaroundMinutes: 30,
      enforceHours: false,
      bufferBeforeMinutes: 15,
    });
    // The resource's own turnaround wins over both; its own rules are reported apart.
    expect(await effective(own)).toEqual({
      minNoticeMinutes: 0,
      turnaroundMinutes: 0,
      enforceHours: false,
      bufferBeforeMinutes: 15,
    });
    expect(await as(tenant, async (scoped) => (await scoped.getResource({ tenantRef: tenant, id: own }))?.bookingRules)).toEqual({
      turnaroundMinutes: 0,
    });

    // Writes follow them: the tenant's year of notice, the pool's buffers.
    expect(await book(plain, at(10), at(11))).toMatchObject({ ok: false, rule: 'min_notice' });
    const first = await book(member, at(10), at(11));
    if (!first.ok) throw new Error(first.code);
    expect(first.reservation.bufferAfterMs).toBe(30 * MINUTE);
    expect(await book(member, at(11, 30), at(12))).toMatchObject({ ok: false, code: 'overlap' });
    expect(await book(member, at(11, 45), at(12, 45))).toMatchObject({ ok: true });
    expect(await book(own, at(10), at(11))).toMatchObject({ ok: true });
    expect(await book(own, at(11, 15), at(12))).toMatchObject({ ok: true });
    // So do searches: 11:00 + 30 minutes after, + 15 before the next.
    const slot = await as(tenant, (scoped) =>
      scoped.findNextAvailableFor({
        tenantRef: tenant,
        resourceId: member,
        searchWindow: { start: at(10), end: at(18) },
        durationMs: HOUR,
        rules: [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 0, durationMinutes: 24 * 60 }],
      }),
    );
    // 10:00-11:00 and 11:45-12:45 each keep 15 before and 30 after: 13:15 + 15 = 13:30.
    expect(slot).toEqual({ start: at(13, 30), end: at(14, 30) });

    // A resource leaving the pool keeps only the tenant's; clearing them leaves its own.
    await as(tenant, (scoped) => scoped.setResourcePool({ tenantRef: tenant, id: own, pool: null }));
    expect(await effective(own)).toEqual({ minNoticeMinutes: 525_600, turnaroundMinutes: 0, enforceHours: false });
    await as(tenant, (scoped) => scoped.setBookingRuleDefaults({ tenantRef: tenant, pool: null, rules: null }));
    expect(await effective(own)).toEqual({ turnaroundMinutes: 0 });
    expect(await effective(plain)).toBeUndefined();
    expect(await book(plain, at(20), at(21))).toMatchObject({ ok: true });
    expect(await as(tenant, (scoped) => scoped.getBookingRuleDefaults({ tenantRef: tenant }))).toEqual({
      tenant: null,
      pools: { van: { minNoticeMinutes: 0, bufferBeforeMinutes: 15 } },
    });
  });

  it('refuses check-in, unknown rules and bad pool names as defaults', async () => {
    await as(tenant, async (scoped) => {
      await expect(
        scoped.setBookingRuleDefaults({ tenantRef: tenant, pool: null, rules: { checkInMinutes: 10 } }),
      ).rejects.toMatchObject({ code: 'invalid_booking_rules' });
      await expect(
        scoped.setBookingRuleDefaults({ tenantRef: tenant, pool: 'Bad Pool', rules: { minNoticeMinutes: 1 } }),
      ).rejects.toMatchObject({ code: 'invalid_pool' });
      await expect(
        scoped.setBookingRuleDefaults({
          tenantRef: tenant,
          pool: null,
          rules: { slotStepMinutes: 30, stepOffsetMinutes: 45 },
        }),
      ).rejects.toMatchObject({ code: 'invalid_booking_rules' });
    });
  });

  it('keeps each tenant’s defaults its own, and erase_tenant deletes them', async () => {
    await as(other, (scoped) =>
      scoped.setBookingRuleDefaults({ tenantRef: other, pool: null, rules: { minNoticeMinutes: 5 } }),
    );
    // Another tenant's context reads none of them, and cannot write a row for it.
    expect(await as(tenant, (scoped) => scoped.getBookingRuleDefaults({ tenantRef: other }))).toEqual({
      tenant: null,
      pools: {},
    });
    await expect(
      as(tenant, (scoped) => scoped.setBookingRuleDefaults({ tenantRef: other, pool: 'van', rules: { minNoticeMinutes: 1 } })),
    ).rejects.toMatchObject({ code: '42501' });
    // A resource of one tenant never takes another's defaults.
    const theirs = await resource(other, 'van');
    expect(
      await as(other, async (scoped) => (await scoped.getResource({ tenantRef: other, id: theirs }))?.effectiveBookingRules),
    ).toEqual({ minNoticeMinutes: 5 });

    const count = async (tenantRef: string) =>
      Number(
        (
          await admin<{ count: string }[]>`
            SELECT count(*) AS count FROM slotlock.booking_rule_defaults WHERE tenant_ref = ${tenantRef}`
        )[0]?.count,
      );
    expect(await count(other)).toBe(1);
    const erased = await admin<{ erased_table: string; erased_rows: string }[]>`
      SELECT * FROM slotlock.erase_tenant(${other}::text)`;
    expect(Number(erased.find((row) => row.erased_table === 'booking_rule_defaults')?.erased_rows)).toBe(1);
    expect(await count(other)).toBe(0);
    expect(await count(tenant)).toBe(1);
  });

  it('serves them over the application API', async () => {
    const backend = createSlotlockStoreApplicationBackend(store);
    const context = (operation: string): SlotlockApplicationInvocationContext => ({
      principal: { subject: 'app', tenantRef: tenant },
      operation: operation as SlotlockApplicationInvocationContext['operation'],
      signal: new AbortController().signal,
    });
    expect(
      await backend.setTenantBookingRules(context('slotlock_set_tenant_booking_rules'), {
        rules: { min_notice_minutes: 30, buffer_before_minutes: 10 },
      }),
    ).toEqual({ rules: { min_notice_minutes: 30, buffer_before_minutes: 10 } });
    expect(
      await backend.setPoolBookingRules(context('slotlock_set_pool_booking_rules'), {
        pool: 'suv',
        rules: { slot_step_minutes: 30, step_offset_minutes: 15 },
      }),
    ).toEqual({ pool: 'suv', rules: { slot_step_minutes: 30, step_offset_minutes: 15 } });
    const defaults = await backend.getBookingRuleDefaults(context('slotlock_get_booking_rule_defaults'), {});
    expect(defaults).toEqual({
      tenant: { min_notice_minutes: 30, buffer_before_minutes: 10 },
      pools: [
        { pool: 'suv', rules: { slot_step_minutes: 30, step_offset_minutes: 15 } },
        { pool: 'van', rules: { min_notice_minutes: 0, buffer_before_minutes: 15 } },
      ],
    });
    const id = await resource(tenant, 'suv');
    const shown = (await backend.getResource(context('slotlock_get_resource'), { resource_id: id })) as {
      resource: { booking_rules: unknown; effective_booking_rules: unknown };
    };
    expect(shown.resource.booking_rules).toBeNull();
    expect(shown.resource.effective_booking_rules).toEqual({
      min_notice_minutes: 30,
      buffer_before_minutes: 10,
      slot_step_minutes: 30,
      step_offset_minutes: 15,
    });
    await expect(
      backend.setPoolBookingRules(context('slotlock_set_pool_booking_rules'), { pool: 'suv', rules: { check_in_minutes: 5 } }),
    ).rejects.toMatchObject({ code: 'invalid_booking_rules', status: 400 });
  });
});
