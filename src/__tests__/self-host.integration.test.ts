// The `slotlock` commands against real Postgres, through the entry point the executable calls: the
// schema owner migrates and grants a LOGIN role without BYPASSRLS, which then adds a resource and
// serves MCP on a real socket until its signal aborts. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SLOTLOCK_MCP_LEGACY_PROTOCOL_VERSION } from '../agent-server.js';
import { type SlotlockEnv, runSlotlockCli } from '../self-host.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

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
    await admin`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenantRef}`;
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
        confirm_writes: ['slotlock_create_event', 'slotlock_update_event', 'slotlock_delete_event'],
        availability_rules: 1,
      });
      const origin = listening.address as string;
      expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

      const health = await fetch(`${origin}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({
        status: 'ready',
        version: '1.0.0',
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
        'slotlock_create_event',
        'slotlock_delete_event',
        'slotlock_find_next_available',
        'slotlock_get_event',
        'slotlock_get_free_busy',
        'slotlock_list_events',
        'slotlock_list_resources',
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

      // Writes are guarded by default, and a 2025 client cannot show the confirmation.
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
    expect(stdout.events().map(({ event }) => event)).toEqual([
      'schema_applied',
      'application_role_granted',
      'listening',
      'confirmation',
      'stopping',
      'stopped',
    ]);
    expect(stderr.text()).toBe('');
    for (const secret of [token, confirmationSecret, password]) {
      expect(stdout.text()).not.toContain(secret);
    }
  });
});
