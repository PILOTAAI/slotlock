// The `slotlock` commands against real Postgres, through the entry point the executable calls: the
// schema owner migrates and grants a LOGIN role without BYPASSRLS, which then adds a resource and
// serves MCP on a real socket until its signal aborts. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import postgres from 'postgres';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION } from '../agent-server.js';
import { SLOTLOCK_DASHBOARD_FUNCTIONS } from '../ddl.js';
import { type SlotlockEnv, runSlotlockCli } from '../self-host.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const packageVersion = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

function output() {
  const chunks: string[] = [];
  return {
    write: (chunk: string) => chunks.push(chunk),
    text: () => chunks.join(''),
    events: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

/** The JSON-RPC `result` of an MCP response. */
async function rpcResult<T>(response: Response): Promise<T> {
  return ((await response.json()) as { result: T }).result;
}

async function eventually<T>(read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe.skipIf(!url)('slotlock command (real Postgres)', () => {
  const role = `slotlock_cli_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenantRef = `cli-tenant-${randomUUID()}`;
  const otherTenantRef = `cli-other-${randomUUID()}`;
  const token = randomBytes(32).toString('hex');
  const confirmationSecret = randomBytes(32).toString('hex');
  let admin: ReturnType<typeof postgres>;
  let env: SlotlockEnv;

  async function run(argv: string[], signal = new AbortController().signal) {
    const stdout = output();
    const stderr = output();
    const code = await runSlotlockCli(argv, { env, stdout, stderr, signal });
    return { code, stdout, stderr };
  }

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    const applicationUrl = new URL(url as string);
    applicationUrl.username = role;
    applicationUrl.password = password;
    env = {
      DATABASE_URL: applicationUrl.href,
      SLOTLOCK_MIGRATE_DATABASE_URL: url,
      SLOTLOCK_AUTH_TOKEN: token,
      // Opted into here (the default is none), so the confirmation round stays covered.
      SLOTLOCK_CONFIRM_WRITES: 'all',
      SLOTLOCK_CONFIRMATION_SECRET: confirmationSecret,
      SLOTLOCK_TENANT: tenantRef,
      HOST: '127.0.0.1',
      PORT: '0',
      SLOTLOCK_PUBLIC_URL: 'http://localhost:8080',
      SLOTLOCK_AVAILABILITY:
        '[{"rrule":"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR","startMinutes":540,"durationMinutes":480}]',
    };
  });

  afterAll(async () => {
    await admin`DELETE FROM slotlock.resources WHERE tenant_ref IN (${tenantRef}, ${otherTenantRef})`;
    await admin`DELETE FROM slotlock.api_keys WHERE tenant_ref IN (${tenantRef}, ${otherTenantRef}, 'github:4242', 'github:999', 'github-org:91', 'github-org:92')`;
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('migrates as the owner, grants the serving role, and manages resources as that role', async () => {
    const migrated = await run(['migrate']);
    expect(migrated.stderr.text()).toBe('');
    expect(migrated.code).toBe(0);
    expect(
      migrated.stdout.events().map(({ event, role: granted }) => ({ event, granted })),
    ).toEqual([
      { event: 'schema_applied', granted: undefined },
      { event: 'application_role_granted', granted: role },
    ]);

    const added = await run(['resource', 'add', 'vehicle-42', '--timezone', 'Europe/London']);
    expect(added.code).toBe(0);
    const resource = JSON.parse(added.stdout.text()) as Record<string, unknown>;
    expect(resource).toMatchObject({ external_ref: 'vehicle-42', timezone: 'Europe/London' });
    // Adding the same reference again is idempotent: the same resource, not a second one.
    const again = await run(['resource', 'add', 'vehicle-42', '--timezone', 'Europe/London']);
    expect(JSON.parse(again.stdout.text())).toEqual(resource);

    const listed = await run(['resource', 'list']);
    expect(listed.code).toBe(0);
    expect(listed.stdout.text()).toBe(`${JSON.stringify(resource)}\n`);

    const [row] = await admin<{ tenant_ref: string }[]>`
      SELECT tenant_ref FROM slotlock.resources WHERE id = ${resource.id as string}`;
    expect(row?.tenant_ref).toBe(tenantRef);
  });

  it("sets, shows and clears resources' bookable hours from the command line", async () => {
    const rules = [{ rrule: 'FREQ=WEEKLY;BYDAY=MO,TU', startMinutes: 540, durationMinutes: 480 }];
    expect((await run(['resource', 'add', 'hours-van'])).code).toBe(0);
    try {
      const lines = (text: string) =>
        text
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);

      const set = await run(['hours', 'set', JSON.stringify(rules), '--resource', 'hours-van']);
      expect(set.code).toBe(0);
      expect(lines(set.stdout.text())).toEqual([
        expect.objectContaining({ external_ref: 'hours-van', hours: rules }),
      ]);
      const shown = await run(['hours', 'show']);
      expect(lines(shown.stdout.text())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ external_ref: 'hours-van', hours: rules }),
          expect.objectContaining({ external_ref: 'vehicle-42', hours: null }),
        ]),
      );
      // By id as well as by reference.
      const id = lines(set.stdout.text())[0]?.id as string;
      expect(lines((await run(['hours', 'show', '--resource', id])).stdout.text())).toEqual([
        expect.objectContaining({ id, hours: rules }),
      ]);
      // An id wins over a reference that spells it: the decoy sorts first and must be left alone.
      const decoy = `00000000-0000-4000-8000-${randomBytes(6).toString('hex')}`;
      const named = `ffffffff-ffff-4fff-bfff-${randomBytes(6).toString('hex')}`;
      await admin`
        INSERT INTO slotlock.resources (id, tenant_ref, external_ref, timezone)
        VALUES (${decoy}, ${tenantRef}, ${named}, 'UTC'), (${named}, ${tenantRef}, 'hours-named', 'UTC')`;
      expect(lines((await run(['hours', 'set', '[]', '--resource', named])).stdout.text())).toEqual([
        expect.objectContaining({ id: named, hours: [] }),
      ]);
      expect(lines((await run(['hours', 'show', '--resource', decoy])).stdout.text())).toEqual([
        expect.objectContaining({ id: decoy, hours: null }),
      ]);

      const closedAll = await run(['hours', 'set', '[]', '--all']);
      expect(closedAll.code).toBe(0);
      const updated = lines(closedAll.stdout.text())[0]?.updated as number;
      expect(updated).toBeGreaterThanOrEqual(2);
      for (const line of lines((await run(['hours', 'show'])).stdout.text())) {
        expect(line.hours).toEqual([]);
      }

      expect((await run(['hours', 'clear', '--resource', 'hours-van'])).code).toBe(0);
      expect(
        lines((await run(['hours', 'show', '--resource', 'hours-van'])).stdout.text()),
      ).toEqual([expect.objectContaining({ hours: null })]);
      expect((await run(['hours', 'clear', '--all'])).code).toBe(0);
      for (const line of lines((await run(['hours', 'show'])).stdout.text())) {
        expect(line.hours).toBeNull();
      }

      const missing = await run(['hours', 'set', '[]', '--resource', 'no-such-van']);
      expect(missing.code).toBe(1);
      expect(missing.stderr.text()).toMatch(/no resource with that reference or id/);
    } finally {
      // Later tests list exactly the tenant's vehicle-42, with the server's hours.
      await admin`
        DELETE FROM slotlock.resources
         WHERE tenant_ref = ${tenantRef} AND external_ref IS DISTINCT FROM 'vehicle-42'`;
      await admin`UPDATE slotlock.resources SET availability_rules = NULL WHERE tenant_ref = ${tenantRef}`;
    }
  });

  it("sets and clears a resource's booking rules from the command line", async () => {
    const added = await run(['resource', 'add', 'rules-van']);
    expect(added.code).toBe(0);
    try {
      const rules = { minNoticeMinutes: 120, slotStepMinutes: 30, turnaroundMinutes: 15, enforceHours: true };
      const set = await run(['rules', 'set', JSON.stringify(rules), '--resource', 'rules-van']);
      expect(set.code).toBe(0);
      expect(JSON.parse(set.stdout.text())).toMatchObject({ external_ref: 'rules-van', booking_rules: rules });
      const cleared = await run(['rules', 'clear', '--resource', 'rules-van']);
      expect(JSON.parse(cleared.stdout.text())).toMatchObject({ booking_rules: null });
      // Outside their bounds, unknown, or without a resource: refused before anything is written.
      for (const args of [
        ['rules', 'set', '{"slotStepMinutes":0}', '--resource', 'rules-van'],
        ['rules', 'set', '{"leadMinutes":5}', '--resource', 'rules-van'],
        ['rules', 'set', '{}'],
      ]) {
        expect((await run(args)).code, args.join(' ')).toBe(2);
      }
      expect((await run(['rules', 'clear', '--resource', 'no-such-van'])).code).toBe(1);
    } finally {
      expect((await run(['resource', 'delete', 'rules-van'])).code).toBe(0);
    }
  });

  it('archives, restores and deletes resources, and suspends and erases a tenant, from the command line', async () => {
    const lifecycle = `cli-lifecycle-${randomUUID()}`;
    const runIn = async (argv: string[], overrides: SlotlockEnv = {}) => {
      const stdout = output();
      const stderr = output();
      const code = await runSlotlockCli(argv, {
        env: { ...env, SLOTLOCK_TENANT: lifecycle, ...overrides },
        stdout,
        stderr,
        signal: new AbortController().signal,
      });
      return { code, stdout, stderr, line: () => JSON.parse(stdout.text()) as Record<string, unknown> };
    };
    try {
      expect((await runIn(['resource', 'add', 'retired-van'])).code).toBe(0);
      const archived = await runIn(['resource', 'archive', 'retired-van']);
      expect(archived.code).toBe(0);
      expect(archived.line()).toMatchObject({
        external_ref: 'retired-van',
        visibility: 'shared',
        archived_at: expect.any(String),
      });
      expect((await runIn(['resource', 'list'])).stdout.text()).toBe('');
      // By id as well as by reference, archived ones included.
      const restored = await runIn(['resource', 'restore', archived.line().id as string]);
      expect(restored.line()).toMatchObject({ external_ref: 'retired-van', archived_at: null });
      expect((await runIn(['resource', 'list'])).stdout.text()).toContain('retired-van');

      // A live hold keeps a resource from being deleted; released, it goes.
      const id = restored.line().id as string;
      const store = createSlotlockStore(admin);
      const held = await store.withTenant(lifecycle, (tenant) =>
        tenant.acquireHold({
          tenantRef: lifecycle,
          resourceId: id,
          start: new Date(Date.now() + 86_400_000),
          end: new Date(Date.now() + 90_000_000),
          ttlMs: 600_000,
        }),
      );
      expect(held.ok).toBe(true);
      const inUse = await runIn(['resource', 'delete', 'retired-van']);
      expect(inUse.code).toBe(1);
      expect(inUse.stderr.text()).toMatch(/has not ended; cancel or move it first/);
      if (held.ok) {
        await store.withTenant(lifecycle, (tenant) => tenant.releaseHold(held.hold.id, { tenantRef: lifecycle }));
      }
      const deleted = await runIn(['resource', 'delete', 'retired-van']);
      expect(deleted.line()).toEqual({ id, external_ref: 'retired-van', deleted: true });
      const gone = await runIn(['resource', 'delete', 'retired-van']);
      expect(gone.code).toBe(1);
      expect(gone.stderr.text()).toMatch(/no resource with that reference or id/);

      expect((await runIn(['tenant', 'status'])).line()).toEqual({ tenant: lifecycle, suspended: false });
      // The serving role may not suspend: only the schema owner, SLOTLOCK_MIGRATE_DATABASE_URL's.
      const notOwner = await runIn(['tenant', 'suspend'], { SLOTLOCK_MIGRATE_DATABASE_URL: '' });
      expect(notOwner.code).toBe(1);
      expect(notOwner.stderr.text()).toMatch(/only the schema owner suspends/);
      const suspended = await runIn(['tenant', 'suspend', '--reason', 'chargeback review']);
      expect(suspended.line()).toEqual({ tenant: lifecycle, suspended: true, changed: true });
      expect((await runIn(['tenant', 'suspend'])).line()).toEqual({ tenant: lifecycle, suspended: true, changed: false });
      expect((await runIn(['tenant', 'status'])).line()).toEqual({ tenant: lifecycle, suspended: true });
      // Suspended, the tenant writes nothing, even from the command line.
      expect((await runIn(['resource', 'add', 'suspended-van'])).code).toBe(1);
      expect((await runIn(['tenant', 'unsuspend'])).line()).toEqual({
        tenant: lifecycle,
        suspended: false,
        changed: true,
      });

      expect((await runIn(['resource', 'add', 'erased-van'])).code).toBe(0);
      const unconfirmed = await runIn(['tenant', 'erase', '--confirm', tenantRef]);
      expect(unconfirmed.code).toBe(2);
      expect((await runIn(['resource', 'list'])).stdout.text()).toContain('erased-van');
      const erased = await runIn(['tenant', 'erase', '--confirm', lifecycle]);
      expect(erased.code).toBe(0);
      expect(erased.line()).toMatchObject({ tenant: lifecycle, rows: expect.objectContaining({ resources: 1 }) });
      expect((await runIn(['resource', 'list'])).stdout.text()).toBe('');
      expect((await runIn(['tenant', 'erase', '--confirm', lifecycle])).line()).toMatchObject({ total: 0 });
      // The command line's own tenant is as it was.
      expect((await run(['resource', 'list'])).stdout.text()).toContain('vehicle-42');
    } finally {
      await admin`DELETE FROM slotlock.tenant_suspensions WHERE tenant_ref = ${lifecycle}`;
      await admin`DELETE FROM slotlock.resources WHERE tenant_ref = ${lifecycle}`;
    }
  });

  it('serves MCP over HTTP as the granted role until its signal aborts', async () => {
    const shutdown = new AbortController();
    const stdout = output();
    const stderr = output();
    const serving = runSlotlockCli(['serve', '--migrate'], {
      env,
      stdout,
      stderr,
      signal: shutdown.signal,
    });
    try {
      const listening = await eventually(() =>
        stdout.events().find(({ event }) => event === 'listening'),
      );
      expect(listening).toMatchObject({
        mcp: 'http://localhost:8080/mcp',
        a2a: 'http://localhost:8080/a2a',
        tenant: tenantRef,
        confirm_writes: [
          'slotlock_create_event',
          'slotlock_book_together',
          'slotlock_book_pool',
          'slotlock_update_event',
          'slotlock_delete_event',
        ],
        availability_rules: 1,
        rest: 'http://localhost:8080/openapi.json',
        maintenance_interval_minutes: 60,
      });
      const origin = listening.address as string;

      // The server maintains its tenant as soon as it listens, and logs counts, never the tenant.
      const maintained = await eventually(() =>
        stdout.events().find(({ event }) => event === 'maintenance'),
      );
      expect(maintained).toEqual({
        level: expect.any(String),
        time: expect.any(String),
        event: 'maintenance',
        zoneShifts: 0,
        staleSources: 0,
        noShows: 0,
        waitlistOffers: 0,
        extended: 0,
        conflicts: 0,
        refused: 0,
        pruned: 0,
        capped: false,
        rollPending: false,
      });
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const health = await fetch(`${origin}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        status: 'ready',
        version: packageVersion,
        tzdata: process.versions.tz,
        checks: ['database'],
      });

      const mcp = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${origin}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: JSON.stringify(body),
        });
      const anonymous = await mcp(
        { jsonrpc: '2.0', id: 0, method: 'tools/list' },
        { Authorization: `Bearer ${randomBytes(32).toString('hex')}` },
      );
      expect(anonymous.status).toBe(401);

      const initialized = await mcp({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'slotlock-cli-test', version: '1.0.0' },
        },
      });
      expect(initialized.status).toBe(200);
      expect(await rpcResult(initialized)).toMatchObject({
        protocolVersion: SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
        serverInfo: { name: expect.any(String) },
      });

      const versioned = { 'MCP-Protocol-Version': SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION };
      const tools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, versioned);
      expect(tools.status).toBe(200);
      const toolNames = (await rpcResult<{ tools: { name: string }[] }>(tools)).tools.map(
        ({ name }) => name,
      );
      expect(toolNames.sort()).toEqual([
        'slotlock_book_pool',
        'slotlock_book_together',
        'slotlock_create_event',
        'slotlock_delete_event',
        'slotlock_find_available_slots',
        'slotlock_find_next_available',
        'slotlock_get_event',
        'slotlock_get_free_busy',
        'slotlock_get_pool_availability',
        'slotlock_hold_slots',
        'slotlock_list_events',
        'slotlock_list_resources',
        'slotlock_release_slots',
        'slotlock_update_event',
      ]);

      // The serving role reads through forced RLS, so the tenant's resource proves the grant.
      const resources = await mcp(
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'slotlock_list_resources', arguments: { limit: 10 } },
        },
        versioned,
      );
      const listed = (
        await rpcResult<{ structuredContent: { resources: { external_ref: string }[] } }>(resources)
      ).structuredContent.resources;
      expect(listed.map(({ external_ref }) => external_ref)).toEqual(['vehicle-42']);

      // Writes are guarded here, and a 2025 client cannot show the confirmation.
      const write = await mcp(
        {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'slotlock_create_event',
            arguments: {
              resource_id: randomUUID(),
              starts_at: '2027-03-29T09:00:00Z',
              ends_at: '2027-03-29T10:00:00Z',
              timezone: 'Europe/London',
              idempotency_key: 'cli-test-create',
            },
          },
        },
        versioned,
      );
      const refused = await rpcResult<{ isError: boolean; content: { text: string }[] }>(write);
      expect(refused.isError).toBe(true);
      expect(JSON.parse(refused.content[0]?.text ?? '')).toEqual({
        error: { code: 'confirmation_required' },
      });
    } finally {
      shutdown.abort();
    }
    expect(await serving).toBe(0);
    // A role that owns nothing serves without the schema owner's warning.
    expect(stderr.events().map(({ event }) => event)).not.toContain('serving_as_schema_owner');
    expect(stdout.events().map(({ event }) => event)).toEqual([
      'schema_applied',
      'application_role_granted',
      'listening',
      'maintenance',
      'call',
      'confirmation',
      'call',
      'stopping',
      // The anonymous call's 401, counted.
      'refusals',
      'stopped',
    ]);
    expect(stdout.events().find(({ event }) => event === 'refusals')).toMatchObject({
      auth_refused: 1,
      rate_limited: 0,
    });
    // Each tool call logs its operation, outcome and duration; never its arguments.
    expect(stdout.events().filter(({ event }) => event === 'call')).toEqual([
      {
        level: expect.any(String),
        time: expect.any(String),
        event: 'call',
        protocol: 'mcp',
        operation: 'slotlock_list_resources',
        outcome: 'ok',
        duration_ms: expect.any(Number),
      },
      {
        level: expect.any(String),
        time: expect.any(String),
        event: 'call',
        protocol: 'mcp',
        operation: 'slotlock_create_event',
        outcome: 'confirmation_required',
        duration_ms: expect.any(Number),
      },
    ]);
    expect(stdout.text()).not.toContain('cli-test-create');
    expect(stderr.text()).toBe('');
    for (const secret of [token, confirmationSecret, password]) {
      expect(stdout.text()).not.toContain(secret);
    }
  });

  it("manages API keys from the command line and serves each as its key's tenant and scopes", async () => {
    const created = await run(['key', 'create', 'Booking agent']);
    expect(created.code).toBe(0);
    expect(created.stderr.text()).toMatch(/shown once/);
    const writer = JSON.parse(created.stdout.text()) as Record<string, unknown>;
    expect(writer).toMatchObject({
      name: 'Booking agent',
      scopes: ['read', 'write'],
      expires_at: null,
      key: expect.stringMatching(/^slk_[0-9A-Za-z]{46}$/),
    });
    expect(writer.prefix).toBe((writer.key as string).slice(0, 12));

    const before = Date.now();
    const readerRun = await run(['key', 'create', 'Reader', '--scope', 'read', '--expires-in-days', '30']);
    expect(readerRun.code).toBe(0);
    const reader = JSON.parse(readerRun.stdout.text()) as Record<string, unknown>;
    expect(reader.scopes).toEqual(['read']);
    const expiresIn = Date.parse(reader.expires_at as string) - before;
    expect(expiresIn).toBeGreaterThan(30 * 86_400_000 - 60_000);
    expect(expiresIn).toBeLessThan(30 * 86_400_000 + 60_000);

    const listed = await run(['key', 'list']);
    expect(listed.code).toBe(0);
    const rows = listed.stdout.events();
    expect(rows.map(({ id }) => id)).toEqual([reader.id, writer.id]);
    expect(rows.every((row) => !('key' in row))).toBe(true);
    expect(listed.stdout.text()).not.toContain(writer.key as string);

    // A key made for another tenant reaches only that tenant's resources.
    const otherRun = await runSlotlockCli(['key', 'create', 'Other tenant'], {
      env: { ...env, SLOTLOCK_TENANT: otherTenantRef },
      stdout: output(),
      stderr: output(),
      signal: new AbortController().signal,
    });
    expect(otherRun).toBe(0);
    const [otherRow] = await admin<{ id: string }[]>`
      SELECT id FROM slotlock.api_keys WHERE tenant_ref = ${otherTenantRef}`;
    expect(otherRow).toBeDefined();

    const shutdown = new AbortController();
    const stdout = output();
    const stderr = output();
    const { SLOTLOCK_AUTH_TOKEN: _token, ...keysOnly } = env;
    const serving = runSlotlockCli(['serve'], {
      env: keysOnly,
      stdout,
      stderr,
      signal: shutdown.signal,
    });
    try {
      const listening = await eventually(() =>
        stdout.events().find(({ event }) => event === 'listening'),
      );
      expect(listening).toMatchObject({ auth: ['api_keys'] });
      const origin = listening.address as string;
      const versioned = { 'MCP-Protocol-Version': SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION };
      const call = async (bearer: string, name: string, args: Record<string, unknown>) => {
        const response = await fetch(`${origin}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${bearer}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...versioned,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        });
        return response;
      };
      const toolError = async (response: Response) => {
        const result = await rpcResult<{ isError: boolean; content: { text: string }[] }>(response);
        expect(result.isError).toBe(true);
        return (JSON.parse(result.content[0]?.text ?? '') as { error: { code: string } }).error.code;
      };
      const resourcesOf = async (bearer: string) => {
        const response = await call(bearer, 'slotlock_list_resources', { limit: 10 });
        expect(response.status).toBe(200);
        return (
          await rpcResult<{ structuredContent: { resources: { external_ref: string }[] } }>(response)
        ).structuredContent.resources.map(({ external_ref }) => external_ref);
      };
      const write = {
        resource_id: randomUUID(),
        starts_at: '2027-03-29T09:00:00Z',
        ends_at: '2027-03-29T10:00:00Z',
        timezone: 'Europe/London',
        idempotency_key: 'cli-key-test-create',
      };

      // The server token is not configured, so it no longer opens anything.
      expect((await call(token, 'slotlock_list_resources', { limit: 1 })).status).toBe(401);

      expect(await resourcesOf(reader.key as string)).toEqual(['vehicle-42']);
      expect(await resourcesOf(writer.key as string)).toEqual(['vehicle-42']);
      // A read key cannot write; a write key reaches the confirmation every write needs here.
      expect(await toolError(await call(reader.key as string, 'slotlock_create_event', write))).toBe(
        'forbidden',
      );
      expect(await toolError(await call(writer.key as string, 'slotlock_create_event', write))).toBe(
        'confirmation_required',
      );

      const revoked = await run(['key', 'revoke', reader.id as string]);
      expect(revoked.code).toBe(0);
      expect(JSON.parse(revoked.stdout.text())).toMatchObject({
        id: reader.id,
        revoked_at: expect.any(String),
      });
      expect((await call(reader.key as string, 'slotlock_list_resources', { limit: 1 })).status).toBe(
        401,
      );
      expect(await resourcesOf(writer.key as string)).toEqual(['vehicle-42']);

      // Rotating keeps the key (and what it booked) but swaps the secret at once.
      const rotatedRun = await run(['key', 'rotate', writer.id as string]);
      expect(rotatedRun.code).toBe(0);
      expect(rotatedRun.stderr.text()).toMatch(/shown once/);
      const rotated = JSON.parse(rotatedRun.stdout.text()) as Record<string, unknown>;
      expect(rotated).toMatchObject({ id: writer.id, key: expect.stringMatching(/^slk_/) });
      expect((await call(writer.key as string, 'slotlock_list_resources', { limit: 1 })).status).toBe(
        401,
      );
      expect(await resourcesOf(rotated.key as string)).toEqual(['vehicle-42']);
      const rotateRevoked = await run(['key', 'rotate', reader.id as string]);
      expect(rotateRevoked.code).toBe(1);
      expect(rotateRevoked.stderr.text()).toMatch(/no active API key with that id/);
    } finally {
      shutdown.abort();
    }
    expect(await serving).toBe(0);
    expect(stderr.text()).toBe('');
    for (const key of [writer.key, reader.key] as string[]) {
      expect(stdout.text()).not.toContain(key);
    }

    // Another tenant's key id is not found here, and nothing about it is revealed.
    const foreign = await run(['key', 'revoke', otherRow?.id as string]);
    expect(foreign.code).toBe(1);
    expect(foreign.stdout.text()).toBe('');
    expect(foreign.stderr.text()).toMatch(/no API key with that id/);
  });
  it('serves the application API over REST by default, to admin keys only, in their own tenant', async () => {
    const create = async (name: string, extra: string[], tenant = tenantRef) => {
      const stdout = output();
      const code = await runSlotlockCli(['key', 'create', name, ...extra], {
        env: { ...env, SLOTLOCK_TENANT: tenant },
        stdout,
        stderr: output(),
        signal: new AbortController().signal,
      });
      expect(code).toBe(0);
      return JSON.parse(stdout.text()) as { id: string; key: string; scopes: string[] };
    };
    const application = await create('Booking site', ['--scope', 'read,write,admin']);
    expect(application.scopes).toEqual(['read', 'write', 'admin']);
    const agent = await create('Booking agent', []);
    expect(agent.scopes).toEqual(['read', 'write']);
    const elsewhere = await create('Other site', ['--scope', 'admin'], otherTenantRef);
    expect(elsewhere.scopes).toEqual(['admin']);

    const shutdown = new AbortController();
    const stdout = output();
    const stderr = output();
    // SLOTLOCK_REST_API is not set: REST is on unless it says off.
    const serving = runSlotlockCli(['serve'], { env, stdout, stderr, signal: shutdown.signal });
    try {
      const listening = await eventually(() =>
        stdout.events().find(({ event }) => event === 'listening'),
      );
      expect(listening.rest).toBe('http://localhost:8080/openapi.json');
      const origin = listening.address as string;
      const rest = async (bearer: string, method: string, path: string, body?: unknown) => {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${bearer}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
      };

      const document = (await (await fetch(`${origin}/openapi.json`)).json()) as {
        tags: { name: string }[];
        paths: Record<string, unknown>;
      };
      expect(document.tags.map(({ name }) => name)).toEqual(['Agent tools', 'Application']);
      expect(document.paths).toHaveProperty(['/v1/holds/{hold_id}/confirm']);

      const created = await rest(application.key, 'POST', '/v1/resources', {
        external_ref: 'vehicle-app',
        timezone: 'Europe/London',
      });
      expect(created).toMatchObject({ status: 200, body: { resource: { external_ref: 'vehicle-app' } } });
      const resourceId = created.body.resource.id as string;
      expect(await rest(agent.key, 'POST', '/v1/resources', { external_ref: 'vehicle-agent' })).toEqual({
        status: 403,
        body: expect.objectContaining({ status: 403, code: 'forbidden', error: { code: 'forbidden' } }),
      });
      // The server token is what the docs give agents, so it reads and writes but is never admin:
      // the application API asks no person before it writes.
      expect(await rest(token, 'GET', `/v1/resources/${resourceId}`)).toEqual({
        status: 403,
        body: expect.objectContaining({ status: 403, code: 'forbidden', error: { code: 'forbidden' } }),
      });
      expect(await rest(token, 'PUT', '/v1/availability', { rules: [] })).toEqual({
        status: 403,
        body: expect.objectContaining({ status: 403, code: 'forbidden', error: { code: 'forbidden' } }),
      });

      const held = await rest(application.key, 'POST', '/v1/holds', {
        resource_id: resourceId,
        start: '2027-04-05T09:00:00Z',
        end: '2027-04-05T10:00:00Z',
        ttl_seconds: 600,
      });
      expect(held.status).toBe(200);
      const holdId = held.body.hold.id as string;
      // Another tenant's admin key, read through the serving role's row-level security as well.
      expect(await rest(elsewhere.key, 'GET', `/v1/resources/${resourceId}`)).toEqual({
        status: 404,
        body: expect.objectContaining({ status: 404, code: 'resource_not_found', error: { code: 'resource_not_found' } }),
      });
      expect(await rest(elsewhere.key, 'POST', `/v1/holds/${holdId}/confirm`, {})).toEqual({
        status: 404,
        body: expect.objectContaining({ status: 404, code: 'hold_not_found', error: { code: 'hold_not_found' } }),
      });
      expect(await rest(elsewhere.key, 'DELETE', `/v1/holds/${holdId}`)).toEqual({
        status: 200,
        body: { released: false },
      });
      expect((await rest(application.key, 'POST', `/v1/holds/${holdId}/confirm`, {})).body).toMatchObject({
        reservation: { id: holdId, resource_id: resourceId },
      });
      expect(await rest(application.key, 'POST', '/v1/maintenance', {})).toEqual({
        status: 200,
        body: { extended: 0, conflicts: 0, refused: 0, pruned: 0, zone_shifts: 0, stale_sources: 0, no_shows: 0, waitlist_offers: 0, capped: false },
      });

      expect((await run(['key', 'revoke', application.id])).code).toBe(0);
      expect((await rest(application.key, 'GET', `/v1/resources/${resourceId}`)).status).toBe(401);
    } finally {
      shutdown.abort();
      await admin`
        DELETE FROM slotlock.resources
         WHERE tenant_ref = ${tenantRef} AND external_ref IS DISTINCT FROM 'vehicle-42'`;
    }
    expect(await serving).toBe(0);
    expect(stderr.text()).toBe('');
    for (const key of [application.key, agent.key, elsewhere.key]) {
      expect(stdout.text()).not.toContain(key);
    }
  });

  it("delivers a tenant's changes to its webhook as the granted role, signed, and lists them", async () => {
    const made = await run(['key', 'create', 'Webhook site', '--scope', 'admin']);
    expect(made.code, made.stderr.text()).toBe(0);
    const { key } = JSON.parse(made.stdout.text()) as { key: string };
    const deliveries: { id: string; type: string }[] = [];
    let secret = '';
    const receiver = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        const event = new Webhook(secret).verify(body, request.headers as Record<string, string>) as { type: string };
        deliveries.push({ id: request.headers['webhook-id'] as string, type: event.type });
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    const hookUrl = `http://localhost:${(receiver.address() as AddressInfo).port}/hook`;
    const shutdown = new AbortController();
    const stdout = output();
    const stderr = output();
    const serving = runSlotlockCli(['serve'], {
      env: { ...env, SLOTLOCK_WEBHOOKS: 'private' },
      stdout,
      stderr,
      signal: shutdown.signal,
    });
    try {
      const listening = await eventually(() => stdout.events().find(({ event }) => event === 'listening'));
      expect(listening.webhooks).toBe('private');
      const origin = listening.address as string;
      const rest = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
      };
      const start = (await rest('GET', '/v1/changes')).body.next_cursor as string;
      const hook = await rest('POST', '/v1/webhooks', { url: hookUrl, event_types: ['hold.created'] });
      expect(hook.status).toBe(200);
      secret = hook.body.secret as string;
      const created = await rest('POST', '/v1/resources', { external_ref: 'webhook-van', timezone: 'UTC' });
      const resourceId = created.body.resource.id as string;
      const held = await rest('POST', '/v1/holds', {
        resource_id: resourceId,
        start: '2027-06-01T09:00:00Z',
        end: '2027-06-01T10:00:00Z',
        ttl_seconds: 600,
      });
      expect(held.status).toBe(200);
      const delivered = await eventually(() => deliveries[0], 15_000);
      expect(delivered.type).toBe('io.pylota.slotlock.hold.created');
      const listed = await rest('GET', `/v1/changes?cursor=${encodeURIComponent(start)}`);
      expect(listed.body.changes).toContainEqual(
        expect.objectContaining({ id: delivered.id, type: 'io.pylota.slotlock.hold.created', subject: held.body.hold.id }),
      );
      expect(await rest('GET', '/v1/changes?cursor=nope')).toMatchObject({ status: 400, body: { code: 'invalid_cursor' } });
      // A cursor a pruned change came after is gone, not a server fault.
      await admin`
        INSERT INTO slotlock.outbox_pruned (tenant_ref, txid, id) VALUES (${tenantRef}, '2', 0)
        ON CONFLICT (tenant_ref) DO NOTHING`;
      const old = Buffer.from(`1:1:1:${Date.now()}`).toString('base64url');
      expect(await rest('GET', `/v1/changes?cursor=${old}`)).toMatchObject({
        status: 410,
        body: { code: 'cursor_expired', title: 'Gone' },
      });
      expect((await rest('GET', '/v1/webhooks')).body.webhooks).toEqual([
        expect.objectContaining({ url: hookUrl, attempts: 0, disabled_at: null }),
      ]);
      expect(await rest('DELETE', `/v1/webhooks/${hook.body.webhook.id}`)).toEqual({ status: 200, body: { deleted: true } });
      expect(stdout.events().some(({ event, delivered: count }) => event === 'webhooks' && count === 1)).toBe(true);
      expect(stdout.text()).not.toContain(secret);
    } finally {
      shutdown.abort();
      await new Promise((resolve) => receiver.close(resolve));
      await admin`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef} AND external_ref = 'webhook-van'`;
    }
    expect(await serving, stderr.text()).toBe(0);
  });

  it("bounds what one tenant's application API can store: holds, reservations and coverage", async () => {
    const stdoutKey = output();
    expect(
      await runSlotlockCli(['key', 'create', 'Bulk site', '--scope', 'admin'], {
        env: { ...env, SLOTLOCK_TENANT: otherTenantRef },
        stdout: stdoutKey,
        stderr: output(),
        signal: new AbortController().signal,
      }),
    ).toBe(0);
    const { key } = JSON.parse(stdoutKey.text()) as { key: string };
    const shutdown = new AbortController();
    const stdout = output();
    const stderr = output();
    // Before, the server gave its store no tenant limits: an admin key could add holds,
    // reservations and coverage rows without end, and SLOTLOCK_LIMITS had no setting for them.
    const serving = runSlotlockCli(['serve'], {
      env: {
        ...env,
        SLOTLOCK_LIMITS: 'tenant_holds=2,tenant_reservations=1,tenant_coverage=1,tenant_events=5',
      },
      stdout,
      stderr,
      signal: shutdown.signal,
    });
    try {
      const listening = await eventually(() =>
        stdout.events().find(({ event }) => event === 'listening'),
      );
      expect(listening.limits).toMatchObject({
        tenant_holds: 2,
        tenant_reservations: 1,
        tenant_coverage: 1,
        tenant_events: 5,
      });
      const origin = listening.address as string;
      const rest = async (method: string, path: string, body: unknown) => {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as Record<string, any> };
      };
      const created = await rest('POST', '/v1/resources', { external_ref: 'vehicle-bulk' });
      expect(created.status).toBe(200);
      const resourceId = created.body.resource.id as string;
      const hour = (n: number) => ({
        start: new Date(Date.UTC(2027, 3, 5, n)).toISOString(),
        end: new Date(Date.UTC(2027, 3, 5, n + 1)).toISOString(),
      });

      for (const n of [0, 1]) {
        const held = await rest('POST', '/v1/holds', { resource_id: resourceId, ...hour(n), ttl_seconds: 600 });
        expect(held.status).toBe(200);
      }
      expect(
        await rest('POST', '/v1/holds', { resource_id: resourceId, ...hour(2), ttl_seconds: 600 }),
      ).toEqual({ status: 409, body: expect.objectContaining({ status: 409, code: 'hold_limit_reached', error: { code: 'hold_limit_reached' } }) });

      const booked = await rest('PUT', '/v1/reservations/booking-1', {
        resource_id: resourceId,
        ...hour(3),
        revision: 1,
      });
      expect(booked.status).toBe(200);
      expect(
        await rest('PUT', '/v1/reservations/booking-2', { resource_id: resourceId, ...hour(4), revision: 1 }),
      ).toEqual({ status: 409, body: expect.objectContaining({ status: 409, code: 'reservation_limit_reached', error: { code: 'reservation_limit_reached' } }) });

      const window = { start: '2027-04-01T00:00:00Z', end: '2027-05-01T00:00:00Z', revision: 1 };
      expect((await rest('PUT', `/v1/resources/${resourceId}/coverage/google:a`, window)).status).toBe(200);
      expect(await rest('PUT', `/v1/resources/${resourceId}/coverage/google:b`, window)).toEqual({
        status: 409,
        body: expect.objectContaining({ status: 409, code: 'coverage_limit_reached', error: { code: 'coverage_limit_reached' } }),
      });
    } finally {
      shutdown.abort();
    }
    expect(await serving).toBe(0);
    expect(stderr.text()).toBe('');
  });

  it('maintains the tenant from the command line, and leaves it to a server already doing so', async () => {
    const first = await run(['maintain']);
    expect(first.code).toBe(0);
    expect(first.stderr.text()).toBe('');
    expect(JSON.parse(first.stdout.text())).toEqual({
      zoneShifts: 0,
      staleSources: 0,
      noShows: 0,
      waitlistOffers: 0,
      extended: 0,
      conflicts: 0,
      refused: 0,
      pruned: 0,
      capped: false,
      passes: 1,
    });

    // Another server holding the tenant's lock: nothing runs, and that is not a failure.
    const holder = await admin.reserve();
    try {
      const key = `slotlock.maintenance:${tenantRef}`;
      const [locked] = await holder<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS locked`;
      expect(locked?.locked).toBe(true);
      const busy = await run(['maintain']);
      expect(busy.code).toBe(0);
      expect(busy.stdout.text()).toBe('');
      expect(busy.stderr.text()).toMatch(/another server is maintaining this tenant now/);
      await holder`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`;
    } finally {
      holder.release();
    }
  });

  it('refuses to serve as a role that bypasses row-level security, and says how to fix it', async (context) => {
    const [connecting] = await admin<{ rolsuper: boolean }[]>`
      SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user`;
    if (!connecting?.rolsuper) context.skip('needs a superuser DATABASE_URL to create a BYPASSRLS role');
    const bypassRole = `${role}_bypass`;
    const bypassPassword = randomBytes(24).toString('hex');
    await admin.unsafe(
      `CREATE ROLE ${bypassRole} LOGIN PASSWORD '${bypassPassword}' NOSUPERUSER BYPASSRLS`,
    );
    try {
      const bypassUrl = new URL(url as string);
      bypassUrl.username = bypassRole;
      bypassUrl.password = bypassPassword;
      for (const [databaseUrl, attribute, secret] of [
        [url as string, 'superuser', new URL(url as string).password],
        [bypassUrl.href, 'BYPASSRLS', bypassPassword],
      ] as const) {
        const stdout = output();
        const stderr = output();
        // A server that does start is stopped after 3 seconds, so the check fails on its exit code.
        const code = await runSlotlockCli(['serve'], {
          env: { ...env, DATABASE_URL: databaseUrl, SLOTLOCK_MIGRATE_DATABASE_URL: undefined },
          stdout,
          stderr,
          signal: AbortSignal.timeout(3_000),
        });
        expect(code, attribute).toBe(1);
        expect(stdout.events().find(({ event }) => event === 'listening'), attribute).toBeUndefined();
        const [failure] = stderr.events();
        expect(failure, attribute).toMatchObject({
          event: 'serve_failed',
          code: 'unsafe_serving_role',
        });
        expect(failure?.error, attribute).toContain(attribute);
        expect(failure?.error, attribute).toContain('SLOTLOCK_MIGRATE_DATABASE_URL');
        if (secret) expect(stderr.text() + stdout.text(), attribute).not.toContain(secret);
      }
    } finally {
      await admin.unsafe(`DROP ROLE IF EXISTS ${bypassRole}`);
    }
  });

  it("refuses migrate as the serving role with the fix first: the schema owner's URL", async () => {
    const stdout = output();
    const stderr = output();
    const code = await runSlotlockCli(['migrate'], {
      env: { ...env, SLOTLOCK_MIGRATE_DATABASE_URL: undefined },
      stdout,
      stderr,
      signal: new AbortController().signal,
    });
    expect(code).toBe(1);
    // A superuser owns this schema, so the serving role is refused a read, not a schema it controls.
    const [failure] = stderr.events();
    expect(failure).toMatchObject({ event: 'migrate_failed', code: '42501' });
    const [first, ...detail] = String(failure?.error).split('\n');
    expect(first).toMatch(/^set SLOTLOCK_MIGRATE_DATABASE_URL to the schema owner's URL: /);
    expect(first).toContain(`migrate connected as ${role}`);
    expect(first?.length).toBeLessThan(300);
    // The database's refusal still follows.
    expect(detail.join('\n')).toContain('permission denied');
    expect(stderr.text()).not.toContain(password);
  });

  it('serves as the schema owner, with one warning at startup', async () => {
    // A database of its own, migrated and served by one NOSUPERUSER role that owns the schema.
    const suffix = randomBytes(6).toString('hex');
    const database = `slotlock_owner_serve_${suffix}`;
    const ownerRole = `slotlock_owner_serve_${suffix}`;
    const ownerPassword = randomBytes(24).toString('hex');
    await admin.unsafe(
      `CREATE ROLE ${ownerRole} LOGIN PASSWORD '${ownerPassword}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await admin.unsafe(`CREATE DATABASE ${database} OWNER ${ownerRole}`);
    try {
      const ownerUrl = new URL(url as string);
      ownerUrl.username = ownerRole;
      ownerUrl.password = ownerPassword;
      ownerUrl.pathname = `/${database}`;
      const shutdown = new AbortController();
      const stdout = output();
      const stderr = output();
      const serving = runSlotlockCli(['serve', '--migrate'], {
        env: { ...env, DATABASE_URL: ownerUrl.href, SLOTLOCK_MIGRATE_DATABASE_URL: undefined },
        stdout,
        stderr,
        signal: shutdown.signal,
      });
      try {
        await eventually(() => stdout.events().find(({ event }) => event === 'listening'));
      } finally {
        shutdown.abort();
      }
      expect(await serving).toBe(0);
      const warnings = stderr.events().filter(({ event }) => event === 'serving_as_schema_owner');
      expect(warnings).toEqual([
        {
          level: 'warn',
          time: expect.any(String),
          event: 'serving_as_schema_owner',
          role: ownerRole,
          message: expect.stringContaining('SLOTLOCK_MIGRATE_DATABASE_URL'),
        },
      ]);
      expect(stderr.text() + stdout.text()).not.toContain(ownerPassword);

      // Migrate as another role, with no SLOTLOCK_MIGRATE_DATABASE_URL: the schema's owner is not a
      // superuser, so the deployment check refuses with a reason per object that role does not
      // own, thousands of characters of them. The fix comes first, on a line of its own.
      const appUrl = new URL(ownerUrl.href);
      appUrl.username = role;
      appUrl.password = password;
      const migrateOut = output();
      const migrateErr = output();
      const code = await runSlotlockCli(['migrate'], {
        env: { ...env, DATABASE_URL: appUrl.href, SLOTLOCK_MIGRATE_DATABASE_URL: undefined },
        stdout: migrateOut,
        stderr: migrateErr,
        signal: new AbortController().signal,
      });
      expect(code).toBe(1);
      const [failure] = migrateErr.events();
      expect(failure).toMatchObject({ event: 'migrate_failed', code: 'unsafe_slotlock_schema' });
      expect(failure?.reasons).toEqual(expect.arrayContaining([expect.any(String)]));
      const [first, ...detail] = String(failure?.error).split('\n');
      expect(first).toBe(
        `set SLOTLOCK_MIGRATE_DATABASE_URL to the schema owner's URL: migrate connected as ${role} (DATABASE_URL), but ${ownerRole} owns the slotlock schema, and only its owner can migrate it. DATABASE_URL stays the serving role's.`,
      );
      expect(detail.join('\n')).toMatch(/^Slotlock will not deploy into schema slotlock/);
      expect(migrateErr.text()).not.toContain(password);
    } finally {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${ownerRole}`);
    }
  });

  it('logs an operation that fails unexpectedly, while the agent learns only that it failed', async () => {
    // The serving role loses a grant migrate gave it: every resource read now fails in Postgres.
    await admin.unsafe(`REVOKE SELECT ON slotlock.resources FROM ${role}`);
    const shutdown = new AbortController();
    const stdout = output();
    const stderr = output();
    const serving = runSlotlockCli(['serve'], { env, stdout, stderr, signal: shutdown.signal });
    try {
      const listening = await eventually(() =>
        stdout.events().find(({ event }) => event === 'listening'),
      );
      const response = await fetch(`${listening.address as string}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'slotlock_list_resources', arguments: {} },
        }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32603, message: 'Internal error' },
      });
      // Serve's first maintenance pass, which starts with it, has finished one way or the other.
      await eventually(
        () =>
          stdout.events().find(({ event }) => event === 'maintenance') ??
          stderr.events().find(({ event }) => event === 'maintenance_failed'),
      );
    } finally {
      shutdown.abort();
      expect(await serving).toBe(0);
      expect((await run(['migrate'])).code).toBe(0);
    }
    // The maintenance pass reads resources too (its booking prune), and logs the same refusal.
    const failures = stderr.events();
    expect(failures.filter(({ event }) => event !== 'maintenance_failed')).toEqual([
      expect.objectContaining({
        level: 'error',
        event: 'agent_error',
        operation: 'slotlock_list_resources',
        code: '42501',
        error: expect.stringContaining('permission denied'),
      }),
    ]);
    for (const failure of failures.filter(({ event }) => event === 'maintenance_failed')) {
      expect(failure).toMatchObject({ level: 'error', code: '42501' });
    }
    for (const secret of [token, confirmationSecret, password]) {
      expect(stderr.text()).not.toContain(secret);
    }
  });

  it('refuses to serve while a tenant table is left without forced row-level security', async () => {
    // What an upgrade stopped part way, statement by statement, leaves until the next one runs.
    await admin.unsafe('ALTER TABLE slotlock.calendar_coverage NO FORCE ROW LEVEL SECURITY');
    try {
      const stdout = output();
      const stderr = output();
      const code = await runSlotlockCli(['serve'], {
        env: { ...env, SLOTLOCK_MIGRATE_DATABASE_URL: undefined },
        stdout,
        stderr,
        signal: AbortSignal.timeout(3_000),
      });
      expect(code).toBe(1);
      expect(stdout.events().find(({ event }) => event === 'listening')).toBeUndefined();
      const [failure] = stderr.events();
      expect(failure).toMatchObject({ event: 'serve_failed', code: 'row_security_lifted' });
      expect(failure?.error).toContain('slotlock.calendar_coverage');
      expect(failure?.error).toContain('slotlock migrate');
    } finally {
      await admin.unsafe('ALTER TABLE slotlock.calendar_coverage FORCE ROW LEVEL SECURITY');
    }
  });

  it('refuses to serve the dashboard until migrate has granted its functions', async () => {
    await admin.unsafe(
      `REVOKE EXECUTE ON FUNCTION ${SLOTLOCK_DASHBOARD_FUNCTIONS.join(', ')} FROM ${role}`,
    );
    try {
      const stdout = output();
      const stderr = output();
      // A server that does start is stopped after 3 seconds, so the check fails on its exit code.
      const code = await runSlotlockCli(['serve'], {
        env: {
          ...env,
          SLOTLOCK_GITHUB_CLIENT_ID: 'Ov23liIntegrationTest',
          SLOTLOCK_GITHUB_CLIENT_SECRET: randomBytes(20).toString('hex'),
          SLOTLOCK_SESSION_SECRET: randomBytes(32).toString('hex'),
          SLOTLOCK_DASHBOARD_USERS: '4242',
        },
        stdout,
        stderr,
        signal: AbortSignal.timeout(3_000),
      });
      expect(code).not.toBe(0);
      expect(stderr.text()).toMatch(/dashboard.*slotlock migrate/);
      expect(stdout.events().find(({ event }) => event === 'listening')).toBeUndefined();
    } finally {
      expect((await run(['migrate'])).code).toBe(0);
    }
  });

  it('refuses to confirm writes on a schema that cannot record an accepted confirmation', async () => {
    // As 0.3.0 left the table, which held no confirmations.
    await admin`DELETE FROM slotlock.dashboard_tokens WHERE kind = 'confirmation'`;
    await admin`ALTER TABLE slotlock.dashboard_tokens DROP CONSTRAINT slotlock_dashboard_tokens_kind_valid`;
    await admin`ALTER TABLE slotlock.dashboard_tokens ADD CONSTRAINT slotlock_dashboard_tokens_kind_valid
                  CHECK (kind IN ('sign_in', 'form', 'ended_session'))`;
    try {
      const stdout = output();
      const stderr = output();
      const code = await runSlotlockCli(['serve'], {
        env: {
          ...env,
          SLOTLOCK_CONFIRM_WRITES: 'all',
          SLOTLOCK_CONFIRMATION_SECRET: randomBytes(32).toString('hex'),
        },
        stdout,
        stderr,
        signal: AbortSignal.timeout(3_000),
      });
      expect(code).not.toBe(0);
      expect(stderr.text()).toMatch(/SLOTLOCK_CONFIRM_WRITES.*slotlock migrate/);
      expect(stdout.events().find(({ event }) => event === 'listening')).toBeUndefined();
    } finally {
      expect((await run(['migrate'])).code).toBe(0);
    }
  });

  it('serves the GitHub sign-in dashboard beside MCP when configured, and keeps its secrets out of the log', async () => {
    const clientSecret = randomBytes(20).toString('hex');
    const sessionSecret = randomBytes(32).toString('hex');
    const metricsToken = randomBytes(32).toString('hex');
    // Keys of a person still allowed, and of one removed from the allowlist.
    const keyFor = async (tenant: string) => {
      const out = output();
      const code = await runSlotlockCli(['key', 'create', 'Dashboard user', '--scope', 'read'], {
        env: { ...env, SLOTLOCK_TENANT: tenant },
        stdout: out,
        stderr: output(),
        signal: new AbortController().signal,
      });
      expect(code).toBe(0);
      return (JSON.parse(out.text()) as { key: string }).key;
    };
    const allowedKey = await keyFor('github:4242');
    const removedKey = await keyFor('github:999');
    // An organization's keys work while the dashboard serves it, and stop when it no longer does.
    const orgKey = await keyFor('github-org:91');
    const droppedOrgKey = await keyFor('github-org:92');
    const shutdown = new AbortController();
    const stdout = output();
    const stderr = output();
    const serving = runSlotlockCli(['serve'], {
      env: {
        ...env,
        SLOTLOCK_GITHUB_CLIENT_ID: 'Ov23liIntegrationTest',
        SLOTLOCK_GITHUB_CLIENT_SECRET: clientSecret,
        SLOTLOCK_SESSION_SECRET: sessionSecret,
        SLOTLOCK_DASHBOARD_USERS: '4242',
        SLOTLOCK_DASHBOARD_ORGS: '91',
        SLOTLOCK_LIMITS: 'sign_in=3/m:3',
        SLOTLOCK_METRICS_TOKEN: metricsToken,
      },
      stdout,
      stderr,
      signal: shutdown.signal,
    });
    try {
      const listening = await eventually(() =>
        stdout.events().find(({ event }) => event === 'listening'),
      );
      expect(listening).toMatchObject({ dashboard: 'http://localhost:8080/dashboard' });
      const origin = listening.address as string;

      const page = await fetch(`${origin}/dashboard`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(await page.text()).toContain('href="/dashboard/sign-in"');

      const signIn = await fetch(`${origin}/dashboard/sign-in`, { redirect: 'manual' });
      expect(signIn.status).toBe(302);
      const location = new URL(signIn.headers.get('location') ?? '');
      expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
      expect(location.searchParams.get('client_id')).toBe('Ov23liIntegrationTest');
      expect(location.searchParams.get('redirect_uri')).toBe(
        'http://localhost:8080/dashboard/callback',
      );
      expect(signIn.headers.get('set-cookie')).toMatch(/^__Host-slotlock-oauth=/);

      // Sign-ins, which write a record and ask GitHub, have a budget per client address of their
      // own (SEC-12); the dashboard's other pages do not count against it.
      const more = [];
      for (const path of ['/dashboard/sign-in', '/dashboard/callback/', '/dashboard/sign-in']) {
        more.push(await fetch(`${origin}${path}`, { redirect: 'manual' }));
      }
      expect(more.map(({ status }) => status)).toEqual([302, 400, 429]);
      expect(more[2]?.headers.get('retry-after')).toMatch(/^[1-9]\d*$/);
      expect(more[2]?.headers.get('ratelimit')).toMatch(/^"sign_in";r=0;t=\d+$/);
      expect((await fetch(`${origin}/dashboard`)).status).toBe(200);

      // MCP still answers beside it, and a person removed from the allowlist lost their keys.
      const mcp = (bearer?: string) =>
        fetch(`${origin}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION,
            ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'slotlock_list_resources', arguments: { limit: 1 } },
          }),
        });
      expect((await mcp()).status).toBe(401);
      expect((await mcp(allowedKey)).status).toBe(200);
      expect((await mcp(removedKey)).status).toBe(401);
      expect((await mcp(orgKey)).status).toBe(200);
      expect((await mcp(droppedOrgKey)).status).toBe(401);

      // Metrics: only to their own token, counting the calls above by operation and outcome.
      expect((await fetch(`${origin}/metrics`)).status).toBe(401);
      expect(
        (await fetch(`${origin}/metrics`, { headers: { Authorization: `Bearer ${sessionSecret}` } })).status,
      ).toBe(401);
      const scrape = await fetch(`${origin}/metrics`, { headers: { Authorization: `bearer  ${metricsToken}` } });
      expect(scrape.status).toBe(200);
      expect(scrape.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
      const text = await scrape.text();
      expect(text).toMatch(/^slotlock_calls_total\{protocol="mcp",operation="slotlock_list_resources",outcome="ok"\} 2$/m);
      expect(text).toMatch(/^slotlock_build_info\{version="\d+\.\d+\.\d+[^"]*",tzdata="[^"]+"\} 1$/m);
      expect(text).not.toContain('github');
      // The two refused scrapes above are counted, never with what they sent.
      expect(text).toMatch(/^slotlock_refusals_total\{reason="metrics_auth_refused"\} 2$/m);
    } finally {
      shutdown.abort();
    }
    expect(await serving).toBe(0);
    expect(stderr.text()).toBe('');
    for (const secretValue of [clientSecret, sessionSecret, metricsToken]) {
      expect(stdout.text()).not.toContain(secretValue);
    }
  });
});
