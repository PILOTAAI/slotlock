// Teams on Cloud, against real Postgres as the serving role: organizations an owner turns on and
// off, the check serve's keys pass through, and erasure of an organization's tenant. Skipped
// without DATABASE_URL.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockStore } from '../store.js';
import { createSlotlockDashboardTeams, createSlotlockOrganizationCheck } from '../teams.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('organizations turned on (real Postgres)', () => {
  const role = `slotlock_teams_${randomUUID().replaceAll('-', '').slice(0, 14)}`;
  const password = randomBytes(24).toString('hex');
  // Ids no real test shares: random, below GitHub's twenty digits.
  const acme = String(9_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
  const globex = String(Number(acme) + 1);
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;

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
      max: 2,
      onnotice: () => {},
    });
  });

  afterAll(async () => {
    await admin`DELETE FROM slotlock.dashboard_organizations WHERE org_id IN (${acme}, ${globex})`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('turns organizations on and off, for the serving role, through its functions only', async () => {
    const teams = createSlotlockDashboardTeams(application);
    expect(await teams.enabled([acme, globex])).toEqual(new Set());
    expect(await teams.enable({ id: acme, login: 'acme-fleet' }, 'github:4242')).toBe(true);
    expect(await teams.enable({ id: acme, login: 'acme-fleet' }, 'github:7')).toBe(false);
    expect(await teams.enabled([acme, globex, 'not-an-id'])).toEqual(new Set([acme]));
    // Who turned it on is kept until it is turned off.
    expect((await admin`SELECT changed_by FROM slotlock.dashboard_organizations WHERE org_id = ${acme}`)[0]).toEqual({
      changed_by: 'github:4242',
    });
    expect(await teams.disable(acme, 'github:4242')).toBe(true);
    expect(await teams.disable(acme, 'github:4242')).toBe(false);
    expect(await teams.enabled([acme])).toEqual(new Set());
    await expect(teams.enable({ id: acme, login: 'bad login!' }, 'github:4242')).rejects.toMatchObject({
      code: 'invalid_organization',
    });
    // The table itself is not the serving role's.
    await expect(application`SELECT * FROM slotlock.dashboard_organizations`).rejects.toMatchObject({ code: '42501' });
  });

  it("keeps serve's answer for a while, and asks again after", async () => {
    let clock = 0;
    const check = createSlotlockOrganizationCheck(application, { ttlMs: 1_000, now: () => clock });
    const teams = createSlotlockDashboardTeams(application);
    expect(await check(globex)).toBe(false);
    await teams.enable({ id: globex, login: 'globex' }, 'github:4242');
    expect(await check(globex)).toBe(false);
    clock += 1_001;
    expect(await check(globex)).toBe(true);
    expect(await check('not-an-id')).toBe(false);
  });

  it("erases an organization's record with its tenant", async () => {
    const teams = createSlotlockDashboardTeams(application);
    await teams.enable({ id: acme, login: 'acme-fleet' }, 'github:4242');
    const erased = await createSlotlockStore(application).eraseTenant({ tenantRef: `github-org:${acme}` });
    expect(erased.rows.dashboard_organizations).toBe(1);
    expect(await teams.enabled([acme])).toEqual(new Set());
  });

  it("erases a Google person's form records with their tenant, and no GitHub person's", async () => {
    const subject = String(Date.now());
    const owner = (who: string) => createHash('sha256').update(`slotlock-dashboard-owner.${who}`).digest();
    const record = (who: string) =>
      admin`SELECT slotlock.use_dashboard_token('form', ${randomBytes(32)}::bytea, now() + interval '1 hour', ${owner(who)}::bytea)`;
    await record(`google:${subject}`);
    // A GitHub person with the same digits keeps theirs.
    await record(subject);
    const erased = await createSlotlockStore(admin).eraseTenant({ tenantRef: `google:${subject}` });
    expect(erased.rows.dashboard_tokens).toBe(1);
    expect(
      (await admin`SELECT count(*)::int AS n FROM slotlock.dashboard_tokens WHERE owner_hash = ${owner(subject)}`)[0],
    ).toEqual({ n: 1 });
    await admin`DELETE FROM slotlock.dashboard_tokens WHERE owner_hash = ${owner(subject)}`;
  });
});
