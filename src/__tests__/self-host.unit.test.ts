// The `slotlock` command's configuration: defaults, every refusal, and that no refusal or usage error
// echoes a secret. Nothing here connects to a database; a refused configuration never gets that far.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SLOTLOCK_CLI_HELP,
  SLOTLOCK_ENVIRONMENT_VARIABLES,
  SlotlockConfigError,
  type SlotlockEnv,
  createSlotlockTokenAuthenticator,
  readSlotlockDatabaseConfig,
  readSlotlockServeConfig,
  runSlotlockCli,
  slotlockHealthcheckUrl,
} from '../self-host.js';

const secret = () => randomBytes(32).toString('hex');
const DATABASE_URL = 'postgresql://slotlock_app:s3cr3t-db-pass@db.internal:5432/slotlock';
const WEEKDAYS =
  '[{"rrule":"FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR","startMinutes":540,"durationMinutes":480}]';

function serveEnv(overrides: Record<string, string | undefined> = {}): SlotlockEnv {
  return {
    DATABASE_URL,
    SLOTLOCK_AUTH_TOKEN: secret(),
    SLOTLOCK_CONFIRMATION_SECRET: secret(),
    ...overrides,
  };
}

function refusal(env: SlotlockEnv): SlotlockConfigError {
  try {
    readSlotlockServeConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(SlotlockConfigError);
    return error as SlotlockConfigError;
  }
  throw new Error('expected the configuration to be refused');
}

async function run(argv: string[], env: SlotlockEnv = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runSlotlockCli(argv, {
    env,
    stdout: { write: (chunk: string) => stdout.push(chunk) },
    stderr: { write: (chunk: string) => stderr.push(chunk) },
    signal: AbortSignal.abort(),
  });
  return { code, stdout: stdout.join(''), stderr: stderr.join('') };
}

describe('slotlock serve configuration', () => {
  it('defaults to loopback, port 8080, one tenant, confirmation on every write and REST on', () => {
    const env = serveEnv();
    const config = readSlotlockServeConfig(env);
    expect(config).toEqual({
      databaseUrl: DATABASE_URL,
      tenantRef: 'default',
      host: '127.0.0.1',
      port: 8080,
      publicUrl: 'http://localhost:8080',
      authToken: env.SLOTLOCK_AUTH_TOKEN,
      confirmWrites: ['slotlock_create_event', 'slotlock_update_event', 'slotlock_delete_event'],
      confirmationSecret: env.SLOTLOCK_CONFIRMATION_SECRET,
      availability: [],
      restApi: true,
    });
  });

  it('reads every optional setting', () => {
    const config = readSlotlockServeConfig(
      serveEnv({
        SLOTLOCK_MIGRATE_DATABASE_URL: 'postgres://owner:pw@db.internal/slotlock',
        HOST: '0.0.0.0',
        PORT: '3000',
        SLOTLOCK_PUBLIC_URL: 'https://calendar.example.com/slotlock/',
        SLOTLOCK_TENANT: ' fleet-7 ',
        SLOTLOCK_CONFIRM_WRITES: 'slotlock_delete_event, slotlock_create_event',
        SLOTLOCK_AVAILABILITY: WEEKDAYS,
        SLOTLOCK_REST_API: 'off',
      }),
    );
    expect(config).toMatchObject({
      restApi: false,
      migrateDatabaseUrl: 'postgres://owner:pw@db.internal/slotlock',
      host: '0.0.0.0',
      port: 3000,
      publicUrl: 'https://calendar.example.com/slotlock',
      tenantRef: 'fleet-7',
      confirmWrites: ['slotlock_delete_event', 'slotlock_create_event'],
      availability: [
        { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', startMinutes: 540, durationMinutes: 480 },
      ],
    });
  });

  it('treats an empty variable as unset, the way an env file writes FOO=', () => {
    const config = readSlotlockServeConfig(
      serveEnv({ HOST: '', PORT: ' ', SLOTLOCK_TENANT: '', SLOTLOCK_PUBLIC_URL: '' }),
    );
    expect(config).toMatchObject({ host: '127.0.0.1', port: 8080, tenantRef: 'default' });
  });

  it('needs no confirmation secret once writes are not guarded, and drops one that is set', () => {
    const withoutSecret = readSlotlockServeConfig(
      serveEnv({ SLOTLOCK_CONFIRM_WRITES: 'none', SLOTLOCK_CONFIRMATION_SECRET: undefined }),
    );
    expect(withoutSecret.confirmWrites).toEqual([]);
    expect('confirmationSecret' in withoutSecret).toBe(false);
    const withSecret = readSlotlockServeConfig(serveEnv({ SLOTLOCK_CONFIRM_WRITES: 'none' }));
    expect('confirmationSecret' in withSecret).toBe(false);
  });

  it.each([
    ['DATABASE_URL is missing', { DATABASE_URL: undefined }, /DATABASE_URL is required/],
    ['DATABASE_URL is not postgres', { DATABASE_URL: 'mysql://u:p@h/db' }, /DATABASE_URL must be/],
    ['DATABASE_URL is not a URL', { DATABASE_URL: 'host=db user=app' }, /DATABASE_URL must be/],
    [
      'the migration URL is not postgres',
      { SLOTLOCK_MIGRATE_DATABASE_URL: 'https://db' },
      /SLOTLOCK_MIGRATE_DATABASE_URL must be/,
    ],
    ['the token is short', { SLOTLOCK_AUTH_TOKEN: 'abcdef0123456789' }, /too weak/],
    ['the token repeats', { SLOTLOCK_AUTH_TOKEN: 'ab'.repeat(32) }, /too weak/],
    [
      'the token is a placeholder',
      { SLOTLOCK_AUTH_TOKEN: 'change-me-to-a-long-random-value-1234567890' },
      /too weak/,
    ],
    [
      'the token has a trailing newline',
      { SLOTLOCK_AUTH_TOKEN: `${secret()}\n` },
      /printable ASCII without spaces or line breaks/,
    ],
    [
      'the confirmation secret is missing while writes are guarded',
      { SLOTLOCK_CONFIRMATION_SECRET: undefined },
      /SLOTLOCK_CONFIRMATION_SECRET is required/,
    ],
    [
      'the confirmation secret is weak',
      { SLOTLOCK_CONFIRMATION_SECRET: 'x'.repeat(40) },
      /SLOTLOCK_CONFIRMATION_SECRET is too weak/,
    ],
    [
      'a confirmed write is not a write tool',
      { SLOTLOCK_CONFIRM_WRITES: 'slotlock_list_events' },
      /SLOTLOCK_CONFIRM_WRITES must be all, none/,
    ],
    ['the REST switch is neither on nor off', { SLOTLOCK_REST_API: 'yes' }, /SLOTLOCK_REST_API must be on or off/],
    ['PORT is not a number', { PORT: 'http' }, /PORT must be an integer/],
    ['PORT is out of range', { PORT: '65536' }, /PORT must be an integer/],
    ['PORT is fractional', { PORT: '80.5' }, /PORT must be an integer/],
    ['HOST has whitespace', { HOST: 'local host' }, /HOST must be/],
    [
      'the public URL is plain HTTP off loopback',
      { SLOTLOCK_PUBLIC_URL: 'http://calendar.example.com' },
      /must use https:\/\//,
    ],
    [
      'the public URL has a query',
      { SLOTLOCK_PUBLIC_URL: 'https://calendar.example.com/?x=1' },
      /without credentials, query or fragment/,
    ],
    [
      'the public URL has credentials',
      { SLOTLOCK_PUBLIC_URL: 'https://user:pw@calendar.example.com' },
      /without credentials, query or fragment/,
    ],
    ['the tenant has a control character', { SLOTLOCK_TENANT: 'a\u0007b' }, /SLOTLOCK_TENANT/],
    ['the tenant is too long', { SLOTLOCK_TENANT: 't'.repeat(201) }, /SLOTLOCK_TENANT/],
    ['availability is not JSON', { SLOTLOCK_AVAILABILITY: '{oops' }, /not valid JSON/],
    ['availability is an object', { SLOTLOCK_AVAILABILITY: '{}' }, /not an array/],
    [
      'an availability rule has an unknown key',
      {
        SLOTLOCK_AVAILABILITY:
          '[{"rrule":"FREQ=WEEKLY;BYDAY=MO","startMinutes":0,"durationMinutes":60,"tz":"UTC"}]',
      },
      /rule 0 needs/,
    ],
    [
      'an availability rule starts after midnight',
      {
        SLOTLOCK_AVAILABILITY:
          '[{"rrule":"FREQ=WEEKLY;BYDAY=MO","startMinutes":1440,"durationMinutes":60}]',
      },
      /rule 0 needs/,
    ],
    [
      'an availability rule is one expandRules cannot evaluate',
      {
        SLOTLOCK_AVAILABILITY: '[{"rrule":"FREQ=DAILY","startMinutes":540,"durationMinutes":60}]',
      },
      /rule 0 is not a weekly rule/,
    ],
  ])('refuses to start when %s', (_case, overrides, message) => {
    expect(refusal(serveEnv(overrides)).message).toMatch(message);
  });

  it('serves API keys alone when no token is set', () => {
    for (const token of [undefined, '', '   ']) {
      const config = readSlotlockServeConfig(serveEnv({ SLOTLOCK_AUTH_TOKEN: token }));
      expect('authToken' in config).toBe(false);
    }
  });

  it('refuses one value as both the token and the confirmation secret', () => {
    const shared = secret();
    expect(
      refusal(serveEnv({ SLOTLOCK_AUTH_TOKEN: shared, SLOTLOCK_CONFIRMATION_SECRET: shared }))
        .message,
    ).toMatch(/must differ/);
  });

  it('never repeats a secret or a database password in a refusal', () => {
    const weak = 'change-me-please-0123456789abcdef';
    const cases: SlotlockEnv[] = [
      serveEnv({ SLOTLOCK_AUTH_TOKEN: weak }),
      serveEnv({ SLOTLOCK_CONFIRMATION_SECRET: weak }),
      serveEnv({ SLOTLOCK_AUTH_TOKEN: `${weak} ` }),
      serveEnv({ DATABASE_URL: 'mysql://app:change-me-please-0123456789abcdef@db/x' }),
    ];
    for (const env of cases) expect(refusal(env).message).not.toContain(weak);
  });

  describe('dashboard', () => {
    const dashboardEnv = (overrides: Record<string, string | undefined> = {}) =>
      serveEnv({
        SLOTLOCK_GITHUB_CLIENT_ID: 'Ov23liAbCdEfGhIjKlMn',
        SLOTLOCK_GITHUB_CLIENT_SECRET: secret(),
        SLOTLOCK_SESSION_SECRET: secret(),
        SLOTLOCK_DASHBOARD_USERS: '4242, 7,4242',
        ...overrides,
      });

    it('is off unless configured, and reads every setting when it is', () => {
      expect('dashboard' in readSlotlockServeConfig(serveEnv())).toBe(false);
      // docker-compose passes each one as `${NAME:-}`, so an .env without them sets them empty.
      const empty = serveEnv({
        SLOTLOCK_GITHUB_CLIENT_ID: '',
        SLOTLOCK_GITHUB_CLIENT_SECRET: '',
        SLOTLOCK_SESSION_SECRET: '',
        SLOTLOCK_DASHBOARD_USERS: '',
      });
      expect('dashboard' in readSlotlockServeConfig(empty)).toBe(false);
      const env = dashboardEnv();
      expect(readSlotlockServeConfig(env).dashboard).toEqual({
        githubClientId: 'Ov23liAbCdEfGhIjKlMn',
        githubClientSecret: env.SLOTLOCK_GITHUB_CLIENT_SECRET,
        sessionSecret: env.SLOTLOCK_SESSION_SECRET,
        allowedUsers: ['4242', '7'],
      });
      expect(
        readSlotlockServeConfig(dashboardEnv({ SLOTLOCK_DASHBOARD_USERS: '*' })).dashboard
          ?.allowedUsers,
      ).toBe('*');
    });

    it.each([
      ['the client id is missing', { SLOTLOCK_GITHUB_CLIENT_ID: undefined }, /SLOTLOCK_GITHUB_CLIENT_ID is required/],
      ['the client id has a space', { SLOTLOCK_GITHUB_CLIENT_ID: 'a b' }, /SLOTLOCK_GITHUB_CLIENT_ID is required/],
      ['the client secret is missing', { SLOTLOCK_GITHUB_CLIENT_SECRET: undefined }, /SLOTLOCK_GITHUB_CLIENT_SECRET is required/],
      ['the session secret is missing', { SLOTLOCK_SESSION_SECRET: undefined }, /SLOTLOCK_SESSION_SECRET is required/],
      ['the session secret is weak', { SLOTLOCK_SESSION_SECRET: 'z'.repeat(40) }, /SLOTLOCK_SESSION_SECRET is too weak/],
      ['no one is allowed', { SLOTLOCK_DASHBOARD_USERS: undefined }, /SLOTLOCK_DASHBOARD_USERS is required/],
      ['users are logins, not ids', { SLOTLOCK_DASHBOARD_USERS: 'octocat' }, /SLOTLOCK_DASHBOARD_USERS is required/],
      ['only the users are set', { SLOTLOCK_GITHUB_CLIENT_ID: undefined, SLOTLOCK_GITHUB_CLIENT_SECRET: undefined, SLOTLOCK_SESSION_SECRET: undefined }, /SLOTLOCK_GITHUB_CLIENT_ID is required/],
    ])('refuses to start when %s', (_case, overrides, message) => {
      expect(refusal(dashboardEnv(overrides)).message).toMatch(message);
    });

    it('refuses a session secret that is another secret, without printing it', () => {
      const shared = secret();
      for (const env of [
        dashboardEnv({ SLOTLOCK_SESSION_SECRET: shared, SLOTLOCK_GITHUB_CLIENT_SECRET: shared }),
        dashboardEnv({ SLOTLOCK_SESSION_SECRET: shared, SLOTLOCK_AUTH_TOKEN: shared }),
      ]) {
        const message = refusal(env).message;
        expect(message).toMatch(/SLOTLOCK_SESSION_SECRET must differ/);
        expect(message).not.toContain(shared);
      }
    });
  });

  it('reads the database settings alone for migrate and resource', () => {
    expect(readSlotlockDatabaseConfig({ DATABASE_URL, SLOTLOCK_TENANT: 'fleet-7' })).toEqual({
      databaseUrl: DATABASE_URL,
      tenantRef: 'fleet-7',
    });
  });
});

describe('slotlock token authentication', () => {
  const token = secret();
  const authenticate = createSlotlockTokenAuthenticator(token, {
    subject: 'self-host',
    tenantRef: 'default',
  });
  const request = (authorization?: string) =>
    new Request('http://localhost/mcp', authorization ? { headers: { authorization } } : {});

  it('resolves exactly the configured token to the one principal', async () => {
    await expect(authenticate(request(`Bearer ${token}`))).resolves.toEqual({
      subject: 'self-host',
      tenantRef: 'default',
    });
    // The scheme is case-insensitive (RFC 9110 §11.1).
    await expect(authenticate(request(`bearer ${token}`))).resolves.not.toBeNull();
  });

  it.each([
    ['no header', undefined],
    ['another token', `Bearer ${secret()}`],
    ['a prefix of the token', `Bearer ${token.slice(0, 32)}`],
    ['the token with a suffix', `Bearer ${token}x`],
    ['another scheme', `Basic ${token}`],
    ['two tokens', `Bearer ${token}, Bearer ${token}`],
  ])('is anonymous with %s', async (_case, authorization) => {
    await expect(authenticate(request(authorization))).resolves.toBeNull();
  });
});

describe('slotlock healthcheck target', () => {
  it('probes a wildcard listener on loopback, under the public path', () => {
    expect(slotlockHealthcheckUrl({ HOST: '0.0.0.0', PORT: '8080' })).toBe(
      'http://127.0.0.1:8080/healthz',
    );
    expect(
      slotlockHealthcheckUrl({
        HOST: '::',
        PORT: '9000',
        SLOTLOCK_PUBLIC_URL: 'https://calendar.example.com/slotlock',
      }),
    ).toBe('http://[::1]:9000/slotlock/healthz');
    expect(slotlockHealthcheckUrl({})).toBe('http://127.0.0.1:8080/healthz');
  });

  it('needs a fixed port', () => {
    expect(() => slotlockHealthcheckUrl({ PORT: '0' })).toThrow(SlotlockConfigError);
  });
});

describe('slotlock command line', () => {
  it('prints help and the version', async () => {
    expect(await run(['--help'])).toEqual({ code: 0, stdout: SLOTLOCK_CLI_HELP, stderr: '' });
    const version = await run(['--version']);
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
  });

  it('describes the server token as read and write, never as every scope (SEC-16)', () => {
    // The token is granted SLOTLOCK_API_KEY_DEFAULT_SCOPES: an operator reading "every scope" would
    // believe it reaches the application API, which needs admin.
    const entry = /^ {2}SLOTLOCK_AUTH_TOKEN +([\s\S]*?)\n {2}[A-Z]/m.exec(SLOTLOCK_CLI_HELP)?.[1];
    expect(entry, 'canary: the token is listed in --help').toBeDefined();
    expect(entry?.replace(/\s+/g, ' ')).toMatch(/with read and write access/);
    const source = readFileSync(new URL('../self-host.ts', import.meta.url), 'utf8');
    expect(source).toContain('SLOTLOCK_AUTH_TOKEN');
    expect(source).not.toMatch(/every\s+scope/);
  });

  it('lists every variable the commands read in --help', () => {
    // Every variable set, so each reader takes the branch that reads the most; the proxy records
    // what the code asks for, including any name this test has never heard of.
    const asked = new Set<string>();
    const env = new Proxy<SlotlockEnv>(
      serveEnv({
        SLOTLOCK_MIGRATE_DATABASE_URL: 'postgresql://owner:0wner-pass-word@db.internal/slotlock',
        SLOTLOCK_CONFIRM_WRITES: 'all',
        SLOTLOCK_PUBLIC_URL: 'https://calendar.example.com',
        SLOTLOCK_TENANT: 'fleet',
        SLOTLOCK_AVAILABILITY: WEEKDAYS,
        SLOTLOCK_REST_API: 'on',
        SLOTLOCK_GITHUB_CLIENT_ID: 'Ov23liAbCdEfGhIjKlMn',
        SLOTLOCK_GITHUB_CLIENT_SECRET: secret(),
        SLOTLOCK_SESSION_SECRET: secret(),
        SLOTLOCK_DASHBOARD_USERS: '4242',
        HOST: '0.0.0.0',
        PORT: '8080',
      }),
      {
        get(target, name, receiver) {
          if (typeof name === 'string') asked.add(name);
          return Reflect.get(target, name, receiver);
        },
      },
    );
    readSlotlockServeConfig(env);
    readSlotlockDatabaseConfig(env);
    slotlockHealthcheckUrl(env);
    // Canary: the proxy saw the readers at work.
    expect(asked).toContain('DATABASE_URL');
    expect(asked).toContain('SLOTLOCK_DASHBOARD_USERS');

    const environment = SLOTLOCK_CLI_HELP.slice(SLOTLOCK_CLI_HELP.indexOf('\nEnvironment:\n'));
    const listed = new Set(
      [...environment.matchAll(/^ {2}([A-Z][A-Z0-9_]*) /gm)].map(([, name]) => name as string),
    );
    expect([...asked].filter((name) => !listed.has(name))).toEqual([]);
    // SLOTLOCK_ENVIRONMENT_VARIABLES (which server.json is checked against) is exactly what is read.
    const known: readonly string[] = SLOTLOCK_ENVIRONMENT_VARIABLES;
    expect([...asked].filter((name) => !known.includes(name))).toEqual([]);
    expect(known.filter((name) => !asked.has(name))).toEqual([]);
    expect([...listed].filter((name) => !known.includes(name))).toEqual([]);
  });

  it.each([
    [[], /^Usage: slotlock/],
    [['deploy'], /unknown command "deploy"/],
    [['resource'], /unknown command "resource"/],
    [['resource', 'add'], /wrong number of arguments for "resource add"/],
    [['migrate', 'now'], /wrong number of arguments for "migrate"/],
    [['migrate', '--migrate'], /--migrate applies only to serve/],
    [['serve', '--timezone', 'UTC'], /--timezone applies only to resource add/],
    [['serve', '--port', '1'], /Unknown option '--port'/],
    [['key'], /unknown command "key"/],
    [['key', 'delete'], /unknown command "key delete"/],
    [['key', 'rotate'], /wrong number of arguments for "key rotate"/],
    [['key', 'create'], /wrong number of arguments for "key create"/],
    [['key', 'revoke'], /wrong number of arguments for "key revoke"/],
    [['key', 'list', 'all'], /wrong number of arguments for "key list"/],
    [['serve', '--scope', 'read'], /--scope applies only to key create/],
    [['key', 'list', '--expires-in-days', '30'], /--expires-in-days applies only to key create/],
    [['key', 'create', 'agent', '--scope', 'owner'], /--scope must be a comma-separated list of read, write and admin/],
    [['key', 'create', 'agent', '--scope', 'read,'], /--scope must be a comma-separated list of read, write and admin/],
    [['key', 'create', 'agent', '--scope', ''], /--scope must be a comma-separated list of read, write and admin/],
    [['maintain', 'now'], /wrong number of arguments for "maintain"/],
    [['key', 'create', 'agent', '--expires-in-days', '0'], /--expires-in-days must be/],
    [['key', 'create', 'agent', '--expires-in-days', '3651'], /--expires-in-days must be/],
    [['key', 'create', 'agent', '--expires-in-days', '7.5'], /--expires-in-days must be/],
    [['hours'], /unknown command "hours"/],
    [['hours', 'delete'], /unknown command "hours delete"/],
    [['hours', 'set', '--all'], /wrong number of arguments for "hours set"/],
    [['hours', 'show', 'van'], /wrong number of arguments for "hours show"/],
    [['hours', 'set', '[]'], /hours set needs --resource <ref> or --all/],
    [['hours', 'clear', '--resource', 'van', '--all'], /hours clear needs --resource <ref> or --all/],
    [['hours', 'show', '--all'], /--all applies only to hours set and hours clear/],
    [['resource', 'list', '--resource', 'van'], /--resource applies only to hours commands/],
    [['hours', 'set', 'Mon 9-5', '--all'], /hours must be a JSON array of weekly rules/],
    [
      ['hours', 'set', '[{"rrule":"FREQ=DAILY","startMinutes":540,"durationMinutes":60}]', '--all'],
      /Rule 0 is not a weekly rule/,
    ],
  ])('refuses %j as a usage error', async (argv, message) => {
    const result = await run(argv, serveEnv());
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(message);
  });

  it('refuses to start serve without configuration, before connecting to anything', async () => {
    const result = await run(['serve']);
    expect(result).toEqual({
      code: 2,
      stdout: '',
      stderr:
        'slotlock: DATABASE_URL is required: the postgres:// URL of the role Slotlock serves as\n',
    });
  });

  it('refuses a weak token without printing it', async () => {
    const weak = 'aaaaaaaabbbbbbbbccccccccdddddddd';
    const result = await run(['serve'], serveEnv({ SLOTLOCK_AUTH_TOKEN: weak }));
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/SLOTLOCK_AUTH_TOKEN is too weak/);
    expect(result.stderr).not.toContain(weak);
  });
});
