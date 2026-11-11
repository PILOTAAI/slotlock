// The admin console's database layer (RFC 0006) against real PostgreSQL: the console's role reaches
// accounts only through the admin functions, each checks the staff role and writes the chained
// staff log, staff are managed only by the deployment role, and nothing returns booking content.
// Needs a role that creates databases and roles; skipped without DATABASE_URL.
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSlotlockCli } from '../self-host.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim();
const sha = (text: string) => createHash('sha256').update(text).digest();

describe.skipIf(!url)('admin console database layer (real Postgres)', () => {
  const suffix = randomBytes(6).toString('hex');
  const database = `slotlock_staff_${suffix}`;
  const owner = `slotlock_owner_${suffix}`;
  const serving = `slotlock_app_${suffix}`;
  const adminRole = `slotlock_admin_${suffix}`;
  const unsafe = `slotlock_bypass_${suffix}`;
  const password = randomBytes(24).toString('hex');
  let root: postgres.Sql;
  let superuser: postgres.Sql;
  let application: postgres.Sql;
  let adminSql: postgres.Sql;
  let app: SlotlockStore;
  let databaseUrls: { superuser: string; serving: string };

  const OWNER = 'github:1001';
  const SUPPORT = 'github:1002';
  const VIEWER = 'github:1003';
  const STRANGER = 'github:9999';
  const PERSON = 'github:424242';
  const OTHER = 'github:515151';
  const CODE = 'enrollment-code-1';

  async function asOwner<T>(work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    return (await superuser.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${owner}`);
      return work(tx);
    })) as T;
  }

  beforeAll(async () => {
    root = postgres(url as string, { max: 1, onnotice: () => undefined });
    await root.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`);
    await root.unsafe(
      `CREATE ROLE ${serving} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await root.unsafe(
      `CREATE ROLE ${adminRole} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await root.unsafe(`CREATE ROLE ${unsafe} LOGIN PASSWORD '${password}' BYPASSRLS`);
    await root.unsafe(`CREATE DATABASE ${database}`);
    await root.unsafe(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    const target = new URL(url as string);
    target.pathname = `/${database}`;
    superuser = postgres(target.href, { max: 2, onnotice: () => undefined });
    await asOwner(async (tx) => {
      const store = createSlotlockStore(tx);
      await store.applySchema();
      await store.applyTenantRls();
      await store.grantApplicationRole(serving);
      await store.grantAdminRole(adminRole);
    });
    const as = (role: string) => {
      const u = new URL(target.href);
      u.username = role;
      u.password = password;
      return u.href;
    };
    databaseUrls = { superuser: target.href, serving: as(serving) };
    application = postgres(as(serving), { max: 4, onnotice: () => undefined });
    adminSql = postgres(as(adminRole), { max: 4, onnotice: () => undefined });
    app = createSlotlockStore(application);

    // Staff, added the only way staff are added: by the deployment role.
    await asOwner(async (tx) => {
      const expires = new Date(Date.now() + 86_400_000);
      await tx`SELECT slotlock.staff_add(${OWNER}, 'owner', 'cli:ops', ${sha(CODE)}, ${expires})`;
      await tx`SELECT slotlock.staff_add(${SUPPORT}, 'support', 'cli:ops', NULL, NULL)`;
      await tx`SELECT slotlock.staff_add(${VIEWER}, 'viewer', 'cli:ops', NULL, NULL)`;
    });

    // Two accounts with data: a person with a key, a paid plan, use this month and a resource; and
    // another, suspended.
    await superuser`INSERT INTO slotlock.dashboard_people (person_ref) VALUES (${PERSON}), (${OTHER})`;
    await superuser`
      INSERT INTO slotlock.api_keys (tenant_ref, name, prefix, secret_hash, scopes)
      VALUES (${PERSON}, 'booking-agent', 'slk_AbCd1234', ${sha('secret')}, ARRAY['read', 'write'])`;
    await superuser`
      INSERT INTO slotlock.tenant_plans (tenant_ref, plan, status, max_resources, max_api_keys,
                                         max_webhook_endpoints, stripe_customer)
      VALUES (${PERSON}, 'developer', 'active', 100, 100, 10, 'cus_TEST123')`;
    const today = new Date().toISOString().slice(0, 10);
    await superuser`
      INSERT INTO slotlock.usage_daily (tenant_ref, day, metric, origin, count)
      VALUES (${PERSON}, ${today}, 'operations', 'mcp', 40), (${PERSON}, ${today}, 'bookings', 'mcp', 3)`;
    await app.withTenant(PERSON, (tenant) =>
      tenant.createResource({ tenantRef: PERSON, externalRef: 'van-1', timezone: 'UTC' }),
    );
    await asOwner(async (tx) => {
      await tx`SELECT slotlock.suspend_tenant(${OTHER}, 'abuse case 1')`;
    });
  });

  afterAll(async () => {
    await application?.end({ timeout: 5 });
    await adminSql?.end({ timeout: 5 });
    await superuser?.end();
    await root?.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    for (const role of [serving, adminRole, unsafe, owner]) await root?.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await root?.end();
  });

  it('gives the console role no table at all, only the admin functions', async () => {
    for (const table of ['staff_members', 'staff_audit_events', 'api_keys', 'dashboard_people', 'resources']) {
      await expect(adminSql.unsafe(`SELECT 1 FROM slotlock.${table} LIMIT 1`)).rejects.toMatchObject({
        code: '42501',
      });
    }
    // Nor the deployment role's staff functions, nor the serving role's.
    await expect(
      adminSql`SELECT slotlock.staff_add('github:5', 'owner', 'github:5', NULL, NULL)`,
    ).rejects.toMatchObject({ code: '42501' });
    await expect(adminSql`SELECT slotlock.tenant_suspended(${PERSON})`).rejects.toMatchObject({ code: '42501' });
  });

  it('keeps the admin functions from the serving role', async () => {
    await expect(application`SELECT slotlock.admin_sign_in(${OWNER})`).rejects.toMatchObject({ code: '42501' });
    await expect(application`SELECT slotlock.admin_home(${OWNER})`).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses to grant the console role to a role that bypasses row security', async () => {
    await expect(
      asOwner((tx) => createSlotlockStore(tx).grantAdminRole(unsafe)),
    ).rejects.toMatchObject({ code: 'unsafe_application_role' });
  });

  it('signs in staff by role, refuses everyone else, and records both', async () => {
    const [ok] = await adminSql<{ role: string | null }[]>`SELECT slotlock.admin_sign_in(${OWNER}) AS role`;
    expect(ok?.role).toBe('owner');
    const [no] = await adminSql<{ role: string | null }[]>`SELECT slotlock.admin_sign_in(${STRANGER}) AS role`;
    expect(no?.role).toBeNull();
    const log = await adminSql<{ staff_ref: string; action: string }[]>`
      SELECT staff_ref, action FROM slotlock.admin_staff_log(${OWNER}, NULL, 20)`;
    expect(log).toEqual(
      expect.arrayContaining([
        { staff_ref: OWNER, action: 'staff.signed_in' },
        { staff_ref: STRANGER, action: 'staff.sign_in_refused' },
      ]),
    );
  });

  it('checks the capability in the database, whatever the console asks', async () => {
    await expect(adminSql`SELECT * FROM slotlock.admin_staff(${SUPPORT})`).rejects.toMatchObject({ code: '42501' });
    await expect(
      adminSql`SELECT * FROM slotlock.admin_accounts(${VIEWER}, NULL, NULL, NULL, NULL, 10)`,
    ).rejects.toMatchObject({ code: '42501' });
    await expect(adminSql`SELECT slotlock.admin_home(${STRANGER})`).rejects.toMatchObject({ code: '42501' });
    // A viewer sees the home numbers.
    const [home] = await adminSql<{ home: Record<string, unknown> }[]>`SELECT slotlock.admin_home(${VIEWER}) AS home`;
    expect(home?.home).toMatchObject({ accounts: 2, people: 2, paying: 1, suspended: 1, operations_month: 40, bookings_month: 3 });
  });

  it('finds accounts by key, Stripe customer, GitHub id and reference, recording only a key prefix', async () => {
    const search = (query: string | null) =>
      adminSql<{ account_ref: string; plan: string; suspended: boolean; operations_month: string }[]>`
        SELECT * FROM slotlock.admin_accounts(${SUPPORT}, ${query}, NULL, NULL, NULL, 10)`;
    expect((await search('slk_AbCd1234-and-the-rest-of-a-pasted-secret')).map((r) => r.account_ref)).toEqual([PERSON]);
    expect((await search('cus_TEST123')).map((r) => r.account_ref)).toEqual([PERSON]);
    expect((await search('424242')).map((r) => r.account_ref)).toEqual([PERSON]);
    expect((await search('github:51')).map((r) => r.account_ref)).toEqual([OTHER]);
    const all = await search(null);
    expect(all.map((r) => r.account_ref)).toEqual([PERSON, OTHER].sort());
    const person = all.find((r) => r.account_ref === PERSON);
    expect(person).toMatchObject({ plan: 'developer', suspended: false });
    expect(Number(person?.operations_month)).toBe(40);
    const suspended = await adminSql<{ account_ref: string }[]>`
      SELECT account_ref FROM slotlock.admin_accounts(${SUPPORT}, NULL, NULL, 'suspended', NULL, 10)`;
    expect(suspended.map((r) => r.account_ref)).toEqual([OTHER]);
    const [logged] = await superuser<{ metadata: Record<string, string> }[]>`
      SELECT metadata FROM slotlock.staff_audit_events
       WHERE action = 'accounts.searched' AND metadata->>'query' LIKE 'slk_%' ORDER BY id DESC LIMIT 1`;
    expect(logged?.metadata.query).toBe('slk_AbCd1234');
  });

  it('shows one account with its counts read under its own row security, then puts the setting back', async () => {
    const result = await adminSql.begin(async (tx) => {
      const [row] = await tx<{ account: Record<string, unknown> }[]>`SELECT slotlock.admin_account(${SUPPORT}, ${PERSON}) AS account`;
      const [setting] = await tx<{ value: string | null }[]>`SELECT current_setting('slotlock.tenant_ref', true) AS value`;
      return { account: row?.account, setting: setting?.value };
    });
    expect(result.account).toMatchObject({
      account_ref: PERSON,
      kind: 'person',
      plan: 'developer',
      stripe_customer: 'cus_TEST123',
      resources: 1,
      api_keys_active: 1,
      suspended: false,
      usage_month: { operations: 40, bookings: 3 },
    });
    expect(result.setting ?? '').toBe('');
    const [missing] = await adminSql<{ account: unknown }[]>`SELECT slotlock.admin_account(${SUPPORT}, 'github:1') AS account`;
    expect(missing?.account).toBeNull();
    const keys = await adminSql<{ prefix: string; name: string }[]>`SELECT * FROM slotlock.admin_account_keys(${SUPPORT}, ${PERSON})`;
    expect(keys).toEqual([expect.objectContaining({ prefix: 'slk_AbCd1234', name: 'booking-agent' })]);
    expect(Object.keys(keys[0] ?? {})).not.toContain('secret_hash');
  });

  it('keeps a chained staff log that no role can change, and that erasing an account leaves', async () => {
    const rows = await superuser<{ chain_index: string; prev_hash: Buffer | null; hash: Buffer; text: string }[]>`
      SELECT event.chain_index, event.prev_hash, event.hash, slotlock.staff_audit_event_text(event) AS text
        FROM slotlock.staff_audit_events event ORDER BY event.chain_index`;
    expect(rows.length).toBeGreaterThan(5);
    let previous: Buffer | null = null;
    rows.forEach((row, index) => {
      expect(Number(row.chain_index)).toBe(index + 1);
      expect(row.prev_hash ?? null).toEqual(previous);
      const expected = createHash('sha256').update(Buffer.concat([previous ?? Buffer.alloc(0), Buffer.from(row.text, 'utf8')])).digest();
      expect(Buffer.from(row.hash)).toEqual(expected);
      previous = Buffer.from(row.hash);
    });
    await expect(
      asOwner((tx) => tx`UPDATE slotlock.staff_audit_events SET reason = 'edited'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(asOwner((tx) => tx`DELETE FROM slotlock.staff_audit_events`)).rejects.toMatchObject({ code: '42501' });
    const columns = await superuser<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'slotlock' AND table_name = 'staff_audit_events'`;
    expect(columns.map((c) => c.column_name)).not.toContain('tenant_ref');
  });

  it('enrolls a first passkey only with the one-time code, and refuses a counter that goes back', async () => {
    const credential = randomBytes(32);
    const key = randomBytes(77);
    const enroll = (code: Buffer | null, id: Buffer) =>
      adminSql<{ ok: boolean }[]>`SELECT slotlock.admin_passkey_enroll(${OWNER}, ${code}, ${id}, ${key}, -7, 0, 'Laptop') AS ok`;
    expect((await enroll(sha('wrong'), credential))[0]?.ok).toBe(false);
    expect((await enroll(null, credential))[0]?.ok).toBe(false);
    expect((await enroll(sha(CODE), credential))[0]?.ok).toBe(true);
    // The code is spent; a second passkey needs none (the console asks for a passkey first).
    expect((await enroll(sha(CODE), randomBytes(32)))[0]?.ok).toBe(false);
    expect((await enroll(null, randomBytes(32)))[0]?.ok).toBe(true);
    const used = (counter: number) =>
      adminSql<{ ok: boolean }[]>`SELECT slotlock.admin_passkey_used(${OWNER}, ${credential}, ${counter}) AS ok`;
    expect((await used(5))[0]?.ok).toBe(true);
    expect((await used(5))[0]?.ok).toBe(false);
    expect((await used(3))[0]?.ok).toBe(false);
    expect((await used(6))[0]?.ok).toBe(true);
    const keys = await adminSql<{ name: string }[]>`SELECT name FROM slotlock.admin_passkeys(${OWNER})`;
    expect(keys).toHaveLength(2);
    // Someone else's passkey is not theirs to use.
    expect(
      (await adminSql<{ ok: boolean }[]>`SELECT slotlock.admin_passkey_used(${SUPPORT}, ${credential}, 99) AS ok`)[0]?.ok,
    ).toBe(false);
  });

  /** Run `slotlock …` against this database, as the schema owner unless `serving`. */
  async function cli(argv: string[], serving = false) {
    const chunks = { out: [] as string[], err: [] as string[] };
    const env = {
      DATABASE_URL: databaseUrls.serving,
      ...(serving ? {} : { SLOTLOCK_MIGRATE_DATABASE_URL: databaseUrls.superuser }),
    };
    const code = await runSlotlockCli(argv, {
      env,
      stdout: { write: (chunk: string) => chunks.out.push(chunk) },
      stderr: { write: (chunk: string) => chunks.err.push(chunk) },
      signal: new AbortController().signal,
    });
    const lines = chunks.out.join('').split('\n').filter((line) => line.startsWith('{'));
    return { code, lines: lines.map((line) => JSON.parse(line) as Record<string, unknown>), err: chunks.err.join('') };
  }

  it('manages staff from the command line, as the schema owner only', async () => {
    const added = await cli(['staff', 'add', '2001', 'editor']);
    expect(added.code).toBe(0);
    expect(added.lines[0]).toMatchObject({ staff: 'github:2001', role: 'editor' });
    const code = String(added.lines[0]?.enrollment_code);
    expect(code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // Only the code's hash is stored.
    const [stored] = await superuser<{ hash: Buffer }[]>`
      SELECT enrollment_hash AS hash FROM slotlock.staff_members WHERE staff_ref = 'github:2001'`;
    expect(Buffer.from(stored?.hash ?? [])).toEqual(sha(code));
    expect((await cli(['staff', 'role', 'github:2001', 'support'])).code).toBe(0);
    const listed = await cli(['staff', 'list']);
    expect(listed.lines).toEqual(expect.arrayContaining([expect.objectContaining({ staff_ref: 'github:2001', role: 'support' })]));
    expect((await cli(['staff', 'reset', '2001'])).lines[0]?.enrollment_code).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect((await cli(['staff', 'remove', '2001'])).code).toBe(0);
    expect((await cli(['staff', 'remove', '2001'])).code).toBe(1);
    // Mistakes are refused before anything is written.
    expect((await cli(['staff', 'add', 'octocat', 'owner'])).code).toBe(2);
    expect((await cli(['staff', 'add', '2002', 'root'])).code).toBe(2);
    // The serving role cannot add staff, whatever its URL says.
    const refused = await cli(['staff', 'add', '2003', 'owner'], true);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('only the schema owner manages staff');
    const log = await superuser<{ staff_ref: string; action: string; target: string }[]>`
      SELECT staff_ref, action, target FROM slotlock.staff_audit_events WHERE target = 'github:2001' ORDER BY chain_index`;
    expect(log.map((row) => row.action)).toEqual(['staff.added', 'staff.role_changed', 'staff.passkeys_reset', 'staff.removed']);
    expect(log.every((row) => row.staff_ref.startsWith('cli:'))).toBe(true);
  });

  it('removes staff and their passkeys, never the last owner', async () => {
    await expect(asOwner((tx) => tx`SELECT slotlock.staff_remove(${OWNER}, 'cli:ops')`)).rejects.toMatchObject({
      code: '23514',
    });
    await asOwner((tx) => tx`SELECT slotlock.staff_remove(${VIEWER}, 'cli:ops')`);
    const [gone] = await adminSql<{ role: string | null }[]>`SELECT slotlock.admin_sign_in(${VIEWER}) AS role`;
    expect(gone?.role).toBeNull();
    await asOwner((tx) => tx`SELECT slotlock.staff_set_role(${SUPPORT}, 'billing', 'cli:ops')`);
    const staff = await adminSql<{ staff_ref: string; role: string; status: string }[]>`
      SELECT staff_ref, role, status FROM slotlock.admin_staff(${OWNER})`;
    expect(staff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ staff_ref: SUPPORT, role: 'billing', status: 'active' }),
        expect.objectContaining({ staff_ref: VIEWER, status: 'removed' }),
      ]),
    );
  });
});
