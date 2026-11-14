// The admin console's database layer (RFC 0006) against real PostgreSQL: the console's role reaches
// accounts only through the admin functions, each checks the staff role and writes the chained
// staff log, staff are managed only by the deployment role, and nothing returns booking content.
// Needs a role that creates databases and roles; skipped without DATABASE_URL.
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockAdmin } from '../admin/app.js';
import { putSlotlockPartner } from '../partners.js';
import { runSlotlockCli } from '../self-host.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import { CONSOLE_KEY, staffSession } from './helpers/admin-browser.js';

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

  /** A fresh session of a member, as if they had signed in with GitHub and a passkey. */
  const as = (staffRef: string) => staffSession(superuser, staffRef);
  /** A passkey challenge kept on a session, as the console makes one; its SHA-256. */
  async function challengeFor(session: string, purpose: 'create' | 'get') {
    const hash = createHash('sha256').update(randomBytes(32)).digest();
    await adminSql`SELECT slotlock.admin_passkey_challenge(${session}, ${purpose}, ${hash})`;
    return hash;
  }

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

    // Staff, added the only way staff are added: by the deployment role, with the console's key.
    await asOwner(async (tx) => {
      await tx`SELECT slotlock.staff_console_key(${sha(CONSOLE_KEY)}, 'cli:ops')`;
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
    await expect(application`SELECT slotlock.admin_sign_in(${OWNER}, ${CONSOLE_KEY})`).rejects.toMatchObject({ code: '42501' });
    await expect(application`SELECT slotlock.admin_home(${await as(OWNER)})`).rejects.toMatchObject({ code: '42501' });
  });

  it('refuses to grant the console role to a role that bypasses row security', async () => {
    await expect(
      asOwner((tx) => createSlotlockStore(tx).grantAdminRole(unsafe)),
    ).rejects.toMatchObject({ code: 'unsafe_application_role' });
  });

  it('keeps the console role and the serving role apart: no table rights for the one, no admin function for the other', async () => {
    const refusal = (work: () => Promise<unknown>) =>
      work().then(() => [] as string[], (error: { code?: string; reasons?: string[] }) => {
        expect(error.code).toBe('unsafe_application_role');
        return error.reasons ?? [];
      });
    // A console role inside the serving role would hold its table rights.
    await root.unsafe(`GRANT ${serving} TO ${adminRole}`);
    try {
      const reasons = await refusal(() => asOwner((tx) => createSlotlockStore(tx).grantAdminRole(adminRole)));
      expect(reasons).toEqual(expect.arrayContaining([expect.stringMatching(/^a right on slotlock table /)]));
      expect(reasons.some((reason) => reason.startsWith('EXECUTE on slotlock.'))).toBe(true);
    } finally {
      await root.unsafe(`REVOKE ${serving} FROM ${adminRole}`);
    }
    // A serving role inside the console role could call the admin functions.
    await root.unsafe(`GRANT ${adminRole} TO ${serving}`);
    try {
      const reasons = await refusal(() => asOwner((tx) => createSlotlockStore(tx).grantApplicationRole(serving)));
      expect(reasons).toEqual(expect.arrayContaining(['EXECUTE on slotlock.admin_home(text)']));
    } finally {
      await root.unsafe(`REVOKE ${adminRole} FROM ${serving}`);
    }
    // A table granted to the console role outright.
    await asOwner((tx) => tx.unsafe(`GRANT SELECT ON slotlock.api_keys TO ${adminRole}`));
    try {
      expect(await refusal(() => asOwner((tx) => createSlotlockStore(tx).grantAdminRole(adminRole)))).toEqual(['a right on slotlock table api_keys']);
    } finally {
      await asOwner((tx) => tx.unsafe(`REVOKE SELECT ON slotlock.api_keys FROM ${adminRole}`));
    }
    // Apart again, both grants go through.
    await asOwner((tx) => createSlotlockStore(tx).grantAdminRole(adminRole));
    await asOwner((tx) => createSlotlockStore(tx).grantApplicationRole(serving));
  });

  it('serves nothing when its own database role is not safe to serve with', async () => {
    const bypass = new URL(databaseUrls.superuser);
    bypass.username = unsafe;
    bypass.password = password;
    const unsafeSql = postgres(bypass.href, { max: 1, onnotice: () => undefined });
    try {
      const make = (sql: postgres.Sql) =>
        createSlotlockAdmin({
          sql: () => sql, publicUrl: 'https://admin.slotlock.test', sessionSecret: 'a-test-session-secret-of-forty-characters',
          consoleKey: CONSOLE_KEY, github: { clientId: 'a', clientSecret: 'b' }, access: null, insecureWithoutAccess: true,
        });
      const refused = await make(unsafeSql).fetch(new Request('https://admin.slotlock.test/sign-in'));
      expect(refused.status).toBe(503);
      expect((await make(adminSql).fetch(new Request('https://admin.slotlock.test/sign-in'))).status).toBe(200);
    } finally {
      await unsafeSql.end({ timeout: 5 });
    }
  });

  it("signs in staff by role with the console's key, refuses everyone else, and records both", async () => {
    const [ok] = await adminSql<{ opened: { role: string; session: string } | null }[]>`SELECT slotlock.admin_sign_in(${OWNER}, ${CONSOLE_KEY}) AS opened`;
    expect(ok?.opened?.role).toBe('owner');
    expect(ok?.opened?.session).toMatch(/^stf_[0-9a-f]{64}$/);
    const [no] = await adminSql<{ opened: unknown }[]>`SELECT slotlock.admin_sign_in(${STRANGER}, ${CONSOLE_KEY}) AS opened`;
    expect(no?.opened).toBeNull();
    const log = await adminSql<{ staff_ref: string; action: string }[]>`
      SELECT staff_ref, action FROM slotlock.admin_staff_log(${await as(OWNER)}, NULL, 20, NULL, NULL, NULL, NULL, NULL, true)`;
    expect(log).toEqual(
      expect.arrayContaining([
        { staff_ref: OWNER, action: 'staff.signed_in' },
        { staff_ref: STRANGER, action: 'staff.sign_in_refused' },
      ]),
    );
    // Only the digest of a session's token is kept.
    expect(await superuser`SELECT 1 FROM slotlock.staff_sessions WHERE token_digest = ${sha(ok?.opened?.session ?? '')}`).toHaveLength(1);
  });

  it("acts as no one with the console's database credential alone: no key, no session, no staff", async () => {
    // Without the key: no session, and no word on who is staff.
    for (const key of [null, 'a-guess-at-the-console-key-0123456789abcdef']) {
      await expect(adminSql`SELECT slotlock.admin_sign_in(${OWNER}, ${key})`).rejects.toMatchObject({ code: '42501' });
    }
    // A member's reference, or a made-up token, is no session.
    for (const actor of [OWNER, `stf_${'0'.repeat(64)}`, `${await as(OWNER)}x`]) {
      await expect(adminSql`SELECT slotlock.admin_home(${actor})`).rejects.toMatchObject({ code: '42501' });
      await expect(adminSql`SELECT slotlock.admin_suspend(${actor}, ${PERSON}, 'No', NULL, NULL)`).rejects.toMatchObject({ code: '42501' });
      await expect(adminSql`SELECT * FROM slotlock.admin_passkeys(${actor})`).rejects.toMatchObject({ code: '42501' });
    }
    // The key itself is out of the console role's reach.
    await expect(adminSql`SELECT key_digest FROM slotlock.staff_console_keys`).rejects.toMatchObject({ code: '42501' });
    await expect(adminSql`SELECT slotlock.staff_console_key(${sha('mine')}, 'cli:me')`).rejects.toMatchObject({ code: '42501' });
    // A session only signed in with GitHub reaches its passkeys, never data.
    const [half] = await adminSql<{ opened: { session: string } }[]>`SELECT slotlock.admin_sign_in(${OWNER}, ${CONSOLE_KEY}) AS opened`;
    const github = String(half?.opened.session);
    await adminSql`SELECT * FROM slotlock.admin_passkeys(${github})`;
    await expect(adminSql`SELECT slotlock.admin_home(${github})`).rejects.toMatchObject({ code: '42501' });
  });

  it('ends sessions on sign-out, a reset, a role change, a removal and a new console key, wherever their tokens went', async () => {
    const live = async (session: string) =>
      adminSql`SELECT slotlock.admin_home(${session})`.then(() => true, (error: { code?: string }) => {
        expect(error.code).toBe('42501');
        return false;
      });
    const signedOut = await as(OWNER);
    expect(await live(signedOut)).toBe(true);
    await adminSql`SELECT slotlock.admin_sign_out(${signedOut})`;
    expect(await live(signedOut)).toBe(false);

    await asOwner((tx) => tx`SELECT slotlock.staff_add('github:3001', 'support', 'cli:ops', NULL, NULL)`);
    for (const end of [
      () => asOwner((tx) => tx`SELECT slotlock.staff_reset('github:3001', 'cli:ops', ${sha('new-code')}, ${new Date(Date.now() + 86_400_000)})`),
      () => asOwner((tx) => tx`SELECT slotlock.staff_set_role('github:3001', 'billing', 'cli:ops')`),
      () => asOwner((tx) => tx`SELECT slotlock.staff_remove('github:3001', 'cli:ops')`),
    ]) {
      const session = await as('github:3001');
      const other = await as(OWNER);
      expect(await live(session)).toBe(true);
      await end();
      expect(await live(session)).toBe(false);
      // Only that member's sessions.
      expect(await live(other)).toBe(true);
    }
    // A new console key ends every session; the new key opens new ones.
    const before = await as(OWNER);
    await asOwner((tx) => tx`SELECT slotlock.staff_console_key(${sha(CONSOLE_KEY)}, 'cli:ops')`);
    expect(await live(before)).toBe(false);
    // Idle for 30 minutes, or past its end: over.
    const idle = await as(OWNER);
    await superuser`UPDATE slotlock.staff_sessions SET last_seen_at = now() - interval '31 minutes' WHERE token_digest = ${sha(idle)}`;
    expect(await live(idle)).toBe(false);
    const over = await as(OWNER);
    await superuser`UPDATE slotlock.staff_sessions SET created_at = now() - interval '9 hours', expires_at = now() - interval '1 minute' WHERE token_digest = ${sha(over)}`;
    expect(await live(over)).toBe(false);
  });

  it('checks the capability in the database, whatever the console asks', async () => {
    await expect(adminSql`SELECT * FROM slotlock.admin_staff(${await as(SUPPORT)})`).rejects.toMatchObject({ code: '42501' });
    await expect(
      adminSql`SELECT * FROM slotlock.admin_accounts(${await as(VIEWER)}, NULL, NULL, NULL, NULL, 10)`,
    ).rejects.toMatchObject({ code: '42501' });
    await expect(adminSql`SELECT slotlock.admin_home(${STRANGER})`).rejects.toMatchObject({ code: '42501' });
    // A viewer sees the home numbers.
    const [home] = await adminSql<{ home: Record<string, unknown> }[]>`SELECT slotlock.admin_home(${await as(VIEWER)}) AS home`;
    // The person's Developer plan names no subscription (as the default plan, or an override, gives
    // one), so it is not paying (staff_subscribed_plans).
    expect(home?.home).toMatchObject({ accounts: 2, people: 2, paying: 0, suspended: 1, operations_month: 40, bookings_month: 3 });
  });

  it('finds accounts by key, Stripe customer, GitHub id and reference, recording only a key prefix', async () => {
    const support = await as(SUPPORT);
    const search = (query: string | null) =>
      adminSql<{ account_ref: string; plan: string; suspended: boolean; operations_month: string }[]>`
        SELECT * FROM slotlock.admin_accounts(${support}, ${query}, NULL, NULL, NULL, 10)`;
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
      SELECT account_ref FROM slotlock.admin_accounts(${await as(SUPPORT)}, NULL, NULL, 'suspended', NULL, 10)`;
    expect(suspended.map((r) => r.account_ref)).toEqual([OTHER]);
    const [logged] = await superuser<{ metadata: Record<string, string> }[]>`
      SELECT metadata FROM slotlock.staff_audit_events
       WHERE action = 'accounts.searched' AND metadata->>'query' LIKE 'slk_%' ORDER BY id DESC LIMIT 1`;
    expect(logged?.metadata.query).toBe('slk_AbCd1234');

    // The staff log is kept six years, past any erasure: a search is kept as typed only when it is
    // a reference, an id, a key prefix or a customer; a name, a login or an email only as a digest
    // keyed with the deployment's secret, which shows two searches were the same and nothing more.
    const logOf = async (query: string) => {
      await search(query);
      const [row] = await superuser<{ metadata: Record<string, string> }[]>`
        SELECT metadata FROM slotlock.staff_audit_events WHERE action = 'accounts.searched' ORDER BY id DESC LIMIT 1`;
      return row?.metadata;
    };
    for (const query of ['cus_TEST123', '424242', 'github:51', 'google:1234567', 'team:0b9e', 'github-org:77~test']) {
      expect(await logOf(query), query).toEqual({ query });
    }
    const [digest] = await superuser<{ ada: string }[]>`SELECT slotlock.privacy_digest('ada lovelace') AS ada`;
    for (const query of ['Ada Lovelace', 'ada LOVELACE']) {
      expect(await logOf(query), query).toEqual({ query_digest: digest?.ada, query_kind: 'text' });
    }
    for (const query of ['ada@example.com', '@ada', 'octocat', 'Acme Rentals']) {
      const kept = await logOf(query);
      expect(kept?.query_kind, query).toBe('text');
      expect(kept?.query_digest, query).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(kept)).not.toContain(query.slice(1, 4));
    }
    // The console's own record of a search: the same rule.
    const support2 = await as(SUPPORT);
    await adminSql`SELECT slotlock.admin_record(${support2}, 'search.github_lookup', NULL, 'octocat', NULL, '{}'::jsonb)`;
    const [lookup] = await superuser<{ target: string | null; metadata: Record<string, string> }[]>`
      SELECT target, metadata FROM slotlock.staff_audit_events WHERE action = 'search.github_lookup' ORDER BY id DESC LIMIT 1`;
    const [octocat] = await superuser<{ digest: string }[]>`SELECT slotlock.privacy_digest('octocat') AS digest`;
    expect(lookup).toEqual({ target: null, metadata: { query_digest: octocat?.digest, query_kind: 'text' } });
  });

  it('shows one account with its counts read under its own row security, then puts the setting back', async () => {
    const result = await adminSql.begin(async (tx) => {
      const [row] = await tx<{ account: Record<string, unknown> }[]>`SELECT slotlock.admin_account(${await as(SUPPORT)}, ${PERSON}) AS account`;
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
    const [missing] = await adminSql<{ account: unknown }[]>`SELECT slotlock.admin_account(${await as(SUPPORT)}, 'github:1') AS account`;
    expect(missing?.account).toBeNull();
    const keys = await adminSql<{ prefix: string; name: string }[]>`SELECT * FROM slotlock.admin_account_keys(${await as(SUPPORT)}, ${PERSON})`;
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
    await expect(asOwner((tx) => tx`TRUNCATE slotlock.staff_audit_events`)).rejects.toMatchObject({ code: '42501' });
    // The chain checks out, and its head is there to record; a rewrite with the triggers off shows.
    const [chain] = await adminSql<{ chain: { checked: number; broken_at: number | null; head_index: number; head_hash: string } }[]>`
      SELECT slotlock.admin_staff_log_chain(${await as(OWNER)}) AS chain`;
    expect(chain?.chain).toMatchObject({ checked: rows.length, broken_at: null, head_index: rows.length });
    expect(chain?.chain.head_hash).toBe(Buffer.from(rows.at(-1)?.hash ?? []).toString('hex'));
    const verified = await cli(['staff', 'verify-log']);
    expect(verified.code).toBe(0);
    expect(verified.lines[0]).toMatchObject({ broken_at: null });
    await asOwner(async (tx) => {
      await tx`ALTER TABLE slotlock.staff_audit_events DISABLE TRIGGER slotlock_staff_audit_events_frozen`;
      await tx`UPDATE slotlock.staff_audit_events SET reason = 'rewritten' WHERE chain_index = 2`;
      await tx`ALTER TABLE slotlock.staff_audit_events ENABLE TRIGGER slotlock_staff_audit_events_frozen`;
    });
    const broken = await cli(['staff', 'verify-log']);
    expect(broken.code).toBe(1);
    expect(broken.lines[0]).toMatchObject({ broken_at: 2 });
    await asOwner(async (tx) => {
      await tx`ALTER TABLE slotlock.staff_audit_events DISABLE TRIGGER slotlock_staff_audit_events_frozen`;
      await tx`UPDATE slotlock.staff_audit_events SET reason = ${null} WHERE chain_index = 2`;
      await tx`ALTER TABLE slotlock.staff_audit_events ENABLE TRIGGER slotlock_staff_audit_events_frozen`;
    });
    const columns = await superuser<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'slotlock' AND table_name = 'staff_audit_events'`;
    expect(columns.map((c) => c.column_name)).not.toContain('tenant_ref');
  });

  it('enrolls a first passkey only with the one-time code, and refuses a counter that goes back', async () => {
    const credential = randomBytes(32);
    const key = randomBytes(77);
    const session = await as(OWNER);
    const enroll = async (code: Buffer | null, id: Buffer, challenge?: Buffer) =>
      (await adminSql<{ ok: boolean }[]>`
        SELECT slotlock.admin_passkey_enroll(${session}, ${code}, ${id}, ${key}, -7, 0, 'Laptop',
          ${challenge ?? (await challengeFor(session, 'create'))}) AS ok`)[0]?.ok;
    expect(await enroll(sha('wrong'), credential)).toBe(false);
    expect(await enroll(null, credential)).toBe(false);
    // A challenge this session did not make is refused, even with the right code.
    expect(await enroll(sha(CODE), credential, sha('a challenge from nowhere'))).toBe(false);
    expect(await enroll(sha(CODE), credential)).toBe(true);
    // The code is spent; a second passkey needs none, but a passkey sign-in in the last 15 minutes.
    expect(await enroll(sha(CODE), randomBytes(32))).toBe(false);
    expect(await enroll(null, randomBytes(32))).toBe(true);
    const stale = await as(OWNER);
    await superuser`UPDATE slotlock.staff_sessions SET passkey_at = now() - interval '20 minutes' WHERE token_digest = ${sha(stale)}`;
    const [late] = await adminSql<{ ok: boolean }[]>`
      SELECT slotlock.admin_passkey_enroll(${stale}, NULL, ${randomBytes(32)}, ${key}, -7, 0, 'Laptop', ${await challengeFor(stale, 'create')}) AS ok`;
    expect(late?.ok).toBe(false);

    const used = async (counter: number, on = session, challenge?: Buffer) =>
      (await adminSql<{ ok: boolean }[]>`
        SELECT slotlock.admin_passkey_used(${on}, ${credential}, ${counter}, ${challenge ?? (await challengeFor(on, 'get'))}) AS ok`)[0]?.ok;
    expect(await used(5)).toBe(true);
    expect(await used(5)).toBe(false);
    expect(await used(3)).toBe(false);
    expect(await used(6)).toBe(true);
    // A challenge is used once, and only by the session that asked for it.
    const once = await challengeFor(session, 'get');
    expect(await used(7, session, once)).toBe(true);
    expect(await used(8, session, once)).toBe(false);
    const other = await as(OWNER);
    const theirs = await challengeFor(other, 'get');
    expect(await used(9, session, theirs)).toBe(false);
    expect(await used(9, other, theirs)).toBe(true);
    const keys = await adminSql<{ name: string }[]>`SELECT name FROM slotlock.admin_passkeys(${session})`;
    expect(keys).toHaveLength(2);
    // Someone else's passkey is not theirs to use.
    expect(await used(99, await as(SUPPORT))).toBe(false);
    // A passkey raises a GitHub-only session to one that reaches data.
    const [half] = await adminSql<{ opened: { session: string } }[]>`SELECT slotlock.admin_sign_in(${OWNER}, ${CONSOLE_KEY}) AS opened`;
    const github = String(half?.opened.session);
    await expect(adminSql`SELECT slotlock.admin_home(${github})`).rejects.toMatchObject({ code: '42501' });
    expect(await used(10, github)).toBe(true);
    await adminSql`SELECT slotlock.admin_home(${github})`;
  });

  it('links a suspension only to an open case about that account, and treats a person a provider made as a person', async () => {
    const support = await as(SUPPORT);
    const cases = await superuser<{ id: string }[]>`
      INSERT INTO slotlock.abuse_cases (account_ref, source, summary, opened_by, status, closed_by, closed_at)
      VALUES (${OTHER}, 'report', 'About another account', ${SUPPORT}, 'open', NULL, NULL),
             (${PERSON}, 'report', 'Closed already', ${SUPPORT}, 'closed', ${SUPPORT}, now())
      RETURNING id`;
    for (const { id } of cases) {
      await expect(adminSql`SELECT slotlock.admin_suspend(${support}, ${PERSON}, 'Spam bookings', NULL, ${id}::bigint)`).rejects.toMatchObject({ code: '22023' });
    }
    expect((await superuser<{ action_taken: string }[]>`SELECT action_taken FROM slotlock.abuse_cases WHERE id IN ${superuser(cases.map((row) => row.id))}`).map((row) => row.action_taken)).toEqual(['none', 'none']);
    expect(await superuser`SELECT 1 FROM slotlock.tenant_suspensions WHERE tenant_ref = ${PERSON}`).toHaveLength(0);

    const sso = 'sso:0b9d0000-0000-4000-8000-000000006666';
    await superuser`INSERT INTO slotlock.dashboard_people (person_ref) VALUES (${sso})`;
    const [listed] = await adminSql<{ kind: string }[]>`SELECT kind FROM slotlock.admin_accounts(${support}, ${sso}, NULL, NULL, NULL, 10)`;
    expect(listed?.kind).toBe('person');
    const [ended] = await adminSql<{ n: number }[]>`SELECT slotlock.admin_end_sessions(${support}, ${sso}, NULL, 'Compromised laptop') AS n`;
    expect(Number(ended?.n)).toBe(0);

    // However an account is erased, staff's notes about it go and its cases stay, unlinked.
    const gone = 'github:9090909';
    await superuser`INSERT INTO slotlock.dashboard_people (person_ref) VALUES (${gone})`;
    await superuser`INSERT INTO slotlock.account_notes (account_ref, staff_ref, body) VALUES (${gone}, ${SUPPORT}, 'Asked about invoices.')`;
    const [linked] = await superuser<{ id: string }[]>`
      INSERT INTO slotlock.abuse_cases (account_ref, source, summary, opened_by) VALUES (${gone}, 'report', 'Spam', ${SUPPORT}) RETURNING id`;
    await app.eraseTenant({ tenantRef: gone });
    expect(await superuser`SELECT 1 FROM slotlock.account_notes WHERE account_ref = ${gone}`).toHaveLength(0);
    expect((await superuser<{ account_ref: string | null }[]>`SELECT account_ref FROM slotlock.abuse_cases WHERE id = ${linked?.id ?? '0'}`)[0]?.account_ref).toBeNull();
  });

  it("takes over a partner's suspension, as staff or the operator, and the partner cannot lift it then", async () => {
    const partner = `held-${suffix}`;
    await asOwner((tx) => putSlotlockPartner(tx as unknown as postgres.Sql, {
      id: partner,
      name: 'Held',
      contract: { plans: { basic: { resources: 5, api_keys: 2, webhook_endpoints: 1, operations: 1000, bookings: 100 } } },
    }));
    const byStaff = `partner:${partner}:by-staff`;
    const byOperator = `partner:${partner}:by-operator`;
    /** What the partner API does to one of its accounts: true when it changed something. */
    const asPartner = async (account: string, suspended: boolean) => {
      const [row] = await application<{ changed: boolean }[]>`
        SELECT slotlock.set_partner_account_suspended(${partner}, ${account}, ${suspended}, 'unpaid') AS changed`;
      return row?.changed;
    };
    const held = async (tenantRef: string) =>
      (await superuser<{ source: string; reason: string; customer_message: string | null; suspended_by: string | null }[]>`
        SELECT source, reason, customer_message, suspended_by FROM slotlock.tenant_suspensions WHERE tenant_ref = ${tenantRef}`)[0];
    try {
      for (const account of ['by-staff', 'by-operator']) {
        await application`SELECT * FROM slotlock.put_partner_account(${partner}, ${account}, 'basic')`;
        expect(await asPartner(account, true)).toBe(true);
      }
      expect(await held(byStaff)).toMatchObject({ source: 'partner', reason: 'partner: unpaid', suspended_by: null });

      // Staff: theirs now, in the staff log and the customer's audit log as any suspension.
      const support = await as(SUPPORT);
      const suspend = async () =>
        (await adminSql<{ ok: boolean }[]>`
          SELECT slotlock.admin_suspend(${support}, ${byStaff}, 'Card testing', 'Write to support.', NULL) AS ok`)[0]?.ok;
      expect(await suspend()).toBe(true);
      expect(await held(byStaff)).toEqual({
        source: 'staff',
        reason: 'Card testing',
        customer_message: 'Write to support.',
        suspended_by: SUPPORT,
      });
      expect(await superuser`
        SELECT action, metadata FROM slotlock.staff_audit_events WHERE account_ref = ${byStaff}`).toEqual([
        { action: 'account.suspended', metadata: { message: true, took_over: 'partner' } },
      ]);
      expect(await superuser`SELECT action, reason FROM slotlock.audit_events WHERE tenant_ref = ${byStaff}`).toEqual([
        { action: 'staff.account_suspended', reason: 'Card testing' },
      ]);
      expect(await suspend()).toBe(false);
      expect(await asPartner('by-staff', false)).toBe(false);
      expect(await app.isTenantSuspended({ tenantRef: byStaff })).toBe(true);

      // The operator (slotlock tenant suspend): the same, recorded by cli:<user>.
      const command = await cli(['tenant', 'suspend', '--reason', 'Chargeback review'], false, { SLOTLOCK_TENANT: byOperator });
      expect(command.lines[0]).toMatchObject({ suspended: true, changed: true });
      expect(await held(byOperator)).toMatchObject({ source: 'operator', reason: 'Chargeback review', suspended_by: expect.stringMatching(/^cli:/) });
      expect(await superuser`
        SELECT action, reason FROM slotlock.staff_audit_events WHERE account_ref = ${byOperator}`).toEqual([
        { action: 'account.suspended', reason: 'Chargeback review' },
      ]);
      expect(await asPartner('by-operator', false)).toBe(false);
      expect(await app.isTenantSuspended({ tenantRef: byOperator })).toBe(true);
    } finally {
      // Left out of the billing run a later test makes.
      for (const tenantRef of [byStaff, byOperator]) await app.eraseTenant({ tenantRef });
      await superuser`DELETE FROM slotlock.tenant_suspensions WHERE tenant_ref IN ${superuser([byStaff, byOperator])}`;
      await superuser`DELETE FROM slotlock.partner_erased_usage WHERE partner_id = ${partner}`;
      await superuser`DELETE FROM slotlock.partners WHERE id = ${partner}`;
    }
  });

  /** Run `slotlock …` against this database, as the schema owner unless `serving`. */
  async function cli(argv: string[], serving = false, extra: Record<string, string> = {}) {
    const chunks = { out: [] as string[], err: [] as string[] };
    const env = {
      DATABASE_URL: databaseUrls.serving,
      ...(serving ? {} : { SLOTLOCK_MIGRATE_DATABASE_URL: databaseUrls.superuser }),
      ...extra,
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
    // The console's key: printed once, only its digest kept.
    const keyed = await cli(['staff', 'console-key']);
    expect(keyed.code).toBe(0);
    const printed = String(keyed.lines[0]?.console_key);
    expect(printed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [digest] = await superuser<{ key: Buffer }[]>`SELECT key_digest AS key FROM slotlock.staff_console_keys`;
    expect(Buffer.from(digest?.key ?? [])).toEqual(sha(printed));
    await asOwner((tx) => tx`SELECT slotlock.staff_console_key(${sha(CONSOLE_KEY)}, 'cli:ops')`);
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
    const [gone] = await adminSql<{ opened: unknown }[]>`SELECT slotlock.admin_sign_in(${VIEWER}, ${CONSOLE_KEY}) AS opened`;
    expect(gone?.opened).toBeNull();
    await asOwner((tx) => tx`SELECT slotlock.staff_set_role(${SUPPORT}, 'billing', 'cli:ops')`);
    const staff = await adminSql<{ staff_ref: string; role: string; status: string }[]>`
      SELECT staff_ref, role, status FROM slotlock.admin_staff(${await as(OWNER)})`;
    expect(staff).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ staff_ref: SUPPORT, role: 'billing', status: 'active' }),
        expect.objectContaining({ staff_ref: VIEWER, status: 'removed' }),
      ]),
    );
  });
  it('records what deployment-role commands do to an account, by cli:<user>, for staff and the customer', async () => {
    const onOther = { SLOTLOCK_TENANT: OTHER };
    expect((await cli(['tenant', 'unsuspend'], false, onOther)).lines[0]).toMatchObject({ changed: true });
    expect((await cli(['tenant', 'suspend', '--reason', 'Chargeback review'], false, onOther)).lines[0]).toMatchObject({ changed: true });
    // Nothing changed, nothing recorded.
    expect((await cli(['tenant', 'suspend'], false, onOther)).lines[0]).toMatchObject({ changed: false });
    const staffLog = await superuser<{ staff_ref: string; action: string; reason: string | null }[]>`
      SELECT staff_ref, action, reason FROM slotlock.staff_audit_events
       WHERE account_ref = ${OTHER} AND staff_ref LIKE 'cli:%' ORDER BY chain_index`;
    expect(staffLog.map((row) => [row.action, row.reason])).toEqual([
      ['account.unsuspended', null],
      ['account.suspended', 'Chargeback review'],
    ]);
    const [held] = await superuser<{ suspended_by: string }[]>`
      SELECT suspended_by FROM slotlock.tenant_suspensions WHERE tenant_ref = ${OTHER}`;
    expect(held?.suspended_by).toMatch(/^cli:/);
    const customer = await superuser<{ action: string; actor_ref: string; reason: string | null }[]>`
      SELECT action, actor_ref, reason FROM slotlock.audit_events WHERE tenant_ref = ${OTHER} ORDER BY chain_index`;
    expect(customer.slice(-2)).toEqual([
      { action: 'staff.account_unsuspended', actor_ref: 'slotlock-staff:operator', reason: null },
      { action: 'staff.account_suspended', actor_ref: 'slotlock-staff:operator', reason: 'Chargeback review' },
    ]);

    // Erasure runs as the serving role; it is recorded with the deployment role's URL.
    const gone = 'github:8080808';
    await superuser`INSERT INTO slotlock.dashboard_people (person_ref) VALUES (${gone})`;
    expect((await cli(['tenant', 'erase', '--confirm', gone], false, { SLOTLOCK_TENANT: gone })).code).toBe(0);
    expect(await superuser`
      SELECT 1 FROM slotlock.staff_audit_events WHERE account_ref = ${gone} AND action = 'account.erased'`).toHaveLength(1);

    expect((await cli(['plan', 'default', 'free', '--from', '2000-01-01'], false, onOther)).code).toBe(0);
    expect((await cli(['plan', 'default', 'none'], false, onOther)).code).toBe(0);
    const plans = await superuser<{ action: string; reason: string | null }[]>`
      SELECT action, reason FROM slotlock.staff_audit_events WHERE action LIKE 'plan.%' ORDER BY chain_index`;
    expect(plans).toEqual([
      { action: 'plan.default_set', reason: 'free from 2000-01-01' },
      { action: 'plan.default_removed', reason: null },
    ]);
    // Only a deployment-role command may be recorded this way, and only these.
    await expect(asOwner((tx) => tx`SELECT slotlock.staff_operator_record('github:1', 'account.suspended', ${OTHER}, NULL)`)).rejects.toMatchObject({ code: '22023' });
    await expect(asOwner((tx) => tx`SELECT slotlock.staff_operator_record('cli:ops', 'staff.added', NULL, NULL)`)).rejects.toMatchObject({ code: '22023' });
    await expect(adminSql`SELECT slotlock.staff_operator_record('cli:ops', 'account.erased', ${OTHER}, NULL)`).rejects.toMatchObject({ code: '42501' });
  });
  it('records each run of a billing job for the console, by cli:<user>', async () => {
    const [before] = await adminSql<{ home: { billing_daily: unknown } }[]>`SELECT slotlock.admin_home(${await as(OWNER)}) AS home`;
    expect(before?.home.billing_daily).toBeNull();
    const run = await cli(['billing', 'daily']);
    expect(run.code).toBe(0);
    const [recorded] = await superuser<{ actor: string; attention: boolean; summary: { lines: { job: string }[] } }[]>`
      SELECT actor, attention, summary FROM slotlock.maintenance_runs WHERE job = 'billing_daily' ORDER BY id DESC LIMIT 1`;
    expect(recorded?.actor).toMatch(/^cli:/);
    expect(recorded?.attention).toBe(false);
    expect(recorded?.summary.lines.at(-1)).toMatchObject({ job: 'done', attention: false });
    const [after] = await adminSql<{ home: { billing_daily: { attention: boolean } } }[]>`SELECT slotlock.admin_home(${await as(OWNER)}) AS home`;
    expect(after?.home.billing_daily).toMatchObject({ attention: false });
    const [billing] = await adminSql<{ billing: { runs: Record<string, unknown> } }[]>`SELECT slotlock.admin_billing(${await as(OWNER)}) AS billing`;
    expect(Object.keys(billing?.billing.runs ?? {})).toEqual(['billing_daily']);
    // Only the deployment role records a run.
    await expect(adminSql`SELECT slotlock.record_maintenance_run('billing_daily', 'cli:x', now(), false, '{}')`).rejects.toMatchObject({ code: '42501' });

    // With overage on, billing daily reports it, and records that as the overage report's run too,
    // so the console's Billing jobs never says that one has never run.
    const daily = await cli(['billing', 'daily'], false, { SLOTLOCK_OVERAGE: 'on', STRIPE_SECRET_KEY: 'sk_test_billing_daily' });
    expect(daily.code).toBe(0);
    const [overage] = await superuser<{ actor: string; attention: boolean; summary: { months: { month: string; sent: number; failed: number }[] } }[]>`
      SELECT actor, attention, summary FROM slotlock.maintenance_runs WHERE job = 'overage_report' ORDER BY id DESC LIMIT 1`;
    expect(overage?.actor).toMatch(/^cli:/);
    expect(overage?.attention).toBe(false);
    expect(overage?.summary.months.map((month) => month.month)).toEqual(daily.lines.filter((line) => line.job === 'overage').map((line) => line.month));
    const [both] = await adminSql<{ billing: { runs: Record<string, unknown> } }[]>`SELECT slotlock.admin_billing(${await as(OWNER)}) AS billing`;
    expect(Object.keys(both?.billing.runs ?? {}).sort()).toEqual(['billing_daily', 'overage_report']);
    // Without overage, nothing is reported, and no overage run is recorded.
    const runs = async () => (await superuser`SELECT 1 FROM slotlock.maintenance_runs WHERE job = 'overage_report'`).length;
    const reported = await runs();
    expect((await cli(['billing', 'daily'])).code).toBe(0);
    expect(await runs()).toBe(reported);
  });
});
