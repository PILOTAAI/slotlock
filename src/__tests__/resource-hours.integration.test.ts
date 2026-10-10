// A resource's own bookable hours, as the serving role (LOGIN, NOBYPASSRLS, granted by
// grantApplicationRole) stores and reads them under each tenant's row-level security, and as the
// agent backend answers slotlock_find_next_available with them. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SlotlockAgentInvocationContext } from '../agent-server.js';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { createSlotlockStore } from '../store.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

const WEEKDAYS: WeeklyAvailabilityRule[] = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 540, durationMinutes: 480 },
];
const AFTERNOONS: WeeklyAvailabilityRule[] = [
  { rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 780, durationMinutes: 120 },
];

describe.skipIf(!url)('per-resource bookable hours (real Postgres)', () => {
  const role = `slotlock_hours_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenantA = `hours-a-${randomUUID()}`;
  const tenantB = `hours-b-${randomUUID()}`;
  let admin: ReturnType<typeof postgres>;
  let app: ReturnType<typeof postgres>;

  const store = () => createSlotlockStore(app);
  const add = (tenantRef: string, externalRef: string, timezone = 'UTC') =>
    store().withTenant(tenantRef, (tenant) =>
      tenant.createResource({ tenantRef, externalRef, timezone }),
    );
  const setHours = (tenantRef: string, id: string, rules: WeeklyAvailabilityRule[] | null) =>
    store().withTenant(tenantRef, (tenant) =>
      tenant.setResourceAvailability({ tenantRef, id, rules }),
    );
  const get = (tenantRef: string, id: string) =>
    store().withTenant(tenantRef, (tenant) => tenant.getResource({ tenantRef, id }));

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    app = postgres(Object.assign(new URL(url as string), { username: role, password }).href, {
      max: 4,
      onnotice: () => {},
    });
  });

  afterAll(async () => {
    await admin`DELETE FROM slotlock.resources WHERE tenant_ref IN (${tenantA}, ${tenantB})`;
    await app?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it("stores a resource's own hours, reads them everywhere, closes it, and clears them", async () => {
    const car = await add(tenantA, 'car-1', 'Europe/London');
    expect(car).not.toHaveProperty('availabilityRules');

    const set = await setHours(tenantA, car.id, WEEKDAYS);
    expect(set).toMatchObject({ id: car.id, availabilityRules: WEEKDAYS });
    expect(await get(tenantA, car.id)).toMatchObject({ availabilityRules: WEEKDAYS });
    const listed = await store().withTenant(tenantA, (tenant) =>
      tenant.listResources({ tenantRef: tenantA }),
    );
    expect(listed.find(({ id }) => id === car.id)).toMatchObject({ availabilityRules: WEEKDAYS });
    // Re-zoning an existing reference keeps its hours.
    expect(await add(tenantA, 'car-1', 'Europe/Paris')).toMatchObject({
      timezone: 'Europe/Paris',
      availabilityRules: WEEKDAYS,
    });

    expect(await setHours(tenantA, car.id, [])).toMatchObject({ availabilityRules: [] });
    const cleared = await setHours(tenantA, car.id, null);
    expect(cleared).not.toHaveProperty('availabilityRules');
    expect(await get(tenantA, car.id)).not.toHaveProperty('availabilityRules');
  });

  it('refuses hours Slotlock cannot evaluate, and leaves the stored ones', async () => {
    const car = await add(tenantA, 'car-refuse');
    await setHours(tenantA, car.id, WEEKDAYS);
    for (const rules of [
      [{ rrule: 'FREQ=DAILY', startMinutes: 540, durationMinutes: 60 }],
      [{ rrule: 'FREQ=WEEKLY;BYDAY=MO', startMinutes: 1_440, durationMinutes: 60 }],
      Array(51).fill(WEEKDAYS[0]),
      'MO' as unknown as WeeklyAvailabilityRule[],
    ]) {
      await expect(setHours(tenantA, car.id, rules)).rejects.toMatchObject({
        code: 'invalid_availability',
      });
    }
    await expect(setHours(tenantA, 'not-a-uuid', WEEKDAYS)).rejects.toMatchObject({
      code: 'invalid_identity',
    });
    expect(await get(tenantA, car.id)).toMatchObject({ availabilityRules: WEEKDAYS });
  });

  it("keeps one tenant's hours out of another tenant's reach", async () => {
    const mine = await add(tenantA, 'car-mine');
    await setHours(tenantA, mine.id, WEEKDAYS);
    const theirs = await add(tenantB, 'car-theirs');

    expect(await setHours(tenantB, mine.id, [])).toBeNull();
    expect(await get(tenantB, mine.id)).toBeNull();
    // Even naming tenant A while running in tenant B's context, row-level security hides the row.
    expect(
      await store().withTenant(tenantB, (tenant) =>
        tenant.setResourceAvailability({ tenantRef: tenantA, id: mine.id, rules: [] }),
      ),
    ).toBeNull();
    const updatedForB = await store().withTenant(tenantB, (tenant) =>
      tenant.setTenantAvailability({ tenantRef: tenantB, rules: AFTERNOONS }),
    );
    expect(updatedForB).toBe(1);
    expect(await get(tenantA, mine.id)).toMatchObject({ availabilityRules: WEEKDAYS });
    expect(await get(tenantB, theirs.id)).toMatchObject({ availabilityRules: AFTERNOONS });
  });

  it('names the tenant in every write, so a store that bypasses row-level security stays in it', async () => {
    // The owner (a superuser here) is not bound by RLS: only the store's own tenant filter holds.
    const owner = createSlotlockStore(admin);
    const mine = await add(tenantA, 'car-owner-path');
    await setHours(tenantA, mine.id, WEEKDAYS);
    expect(await owner.setResourceAvailability({ tenantRef: tenantB, id: mine.id, rules: [] })).toBeNull();
    const before = await owner.setTenantAvailability({ tenantRef: tenantB, rules: AFTERNOONS });
    const [countB] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM slotlock.resources WHERE tenant_ref = ${tenantB}`;
    expect(before).toBe(countB?.n);
    expect(await get(tenantA, mine.id)).toMatchObject({ availabilityRules: WEEKDAYS });
  });

  it("sets every one of a tenant's resources at once", async () => {
    const tenant = `hours-all-${randomUUID()}`;
    try {
      const ids = [];
      for (const ref of ['a', 'b', 'c']) ids.push((await add(tenant, ref)).id);
      expect(
        await store().withTenant(tenant, (scoped) =>
          scoped.setTenantAvailability({ tenantRef: tenant, rules: WEEKDAYS }),
        ),
      ).toBe(3);
      for (const id of ids)
        expect(await get(tenant, id)).toMatchObject({ availabilityRules: WEEKDAYS });
      await store().withTenant(tenant, (scoped) =>
        scoped.setTenantAvailability({ tenantRef: tenant, rules: null }),
      );
      for (const id of ids) expect(await get(tenant, id)).not.toHaveProperty('availabilityRules');
      await expect(
        store().withTenant(tenant, (scoped) =>
          scoped.setTenantAvailability({
            tenantRef: tenant,
            rules: [{ rrule: 'FREQ=DAILY', startMinutes: 0, durationMinutes: 60 }],
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_availability' });
    } finally {
      await admin`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenant}`;
    }
  });

  it('refuses, in the database, hours that are not a list of at most 50 rules', async () => {
    const car = await add(tenantA, 'car-check');
    for (const value of ['{}', '"MO"', JSON.stringify(Array(51).fill(WEEKDAYS[0]))]) {
      await expect(
        admin`UPDATE slotlock.resources SET availability_rules = ${value}::jsonb WHERE id = ${car.id}`,
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('reads stored hours it cannot evaluate as closed, never as open', async () => {
    const car = await add(tenantA, 'car-tampered');
    await admin`
      UPDATE slotlock.resources
         SET availability_rules = '[{"rrule":"FREQ=DAILY","startMinutes":0,"durationMinutes":1440}]'::jsonb
       WHERE id = ${car.id}`;
    expect(await get(tenantA, car.id)).toMatchObject({ availabilityRules: [] });
  });

  it("answers slotlock_find_next_available from a resource's own hours, else the default", async () => {
    const car = await add(tenantA, 'car-find');
    const serverDefault = vi.fn(async () => WEEKDAYS.map((rule) => ({ ...rule })));
    const backend = createSlotlockStoreAgentBackend(store(), { availabilityRules: serverDefault });
    const context: SlotlockAgentInvocationContext = {
      principal: { subject: 'hours-agent', tenantRef: tenantA },
      operation: 'slotlock_find_next_available',
      signal: new AbortController().signal,
    };
    // Monday 11 January 2027, UTC.
    const find = async () =>
      (await backend.findNextAvailable(context, {
        resource_ids: [car.id],
        start: '2027-01-11T00:00:00.000Z',
        end: '2027-01-12T00:00:00.000Z',
        duration_minutes: 60,
      })) as { start: string | null; coverage: { certainty: string } };

    expect((await find()).start).toBe('2027-01-11T09:00:00.000Z');
    expect(serverDefault).toHaveBeenCalledTimes(1);

    await setHours(tenantA, car.id, AFTERNOONS);
    expect((await find()).start).toBe('2027-01-11T13:00:00.000Z');
    expect(serverDefault).toHaveBeenCalledTimes(1);

    await setHours(tenantA, car.id, []);
    const closed = await find();
    expect(closed.start).toBeNull();
    expect(closed.coverage.certainty).toBe('certain');

    await setHours(tenantA, car.id, null);
    expect((await find()).start).toBe('2027-01-11T09:00:00.000Z');
  });
});
