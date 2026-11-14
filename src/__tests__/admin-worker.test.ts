// workers/admin: the console's Worker wrapper refuses to serve half-configured, counts every request
// against its rate limit before any database client opens, closes each request's client, and its
// example configuration keeps the console off workers.dev and query strings out of the logs; and the
// CMS needs only the App's Client ID and a key, its installation found on the repository.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import { type SlotlockAdminWorkerEnv, cmsOf, createSlotlockAdminWorker } from '../../workers/admin/worker.js';

const AUD = 'a'.repeat(64);
const env = (overrides: Partial<SlotlockAdminWorkerEnv> = {}, allow = true): SlotlockAdminWorkerEnv => ({
  HYPERDRIVE: { connectionString: 'postgres://admin@hyperdrive/slotlock' },
  SLOTLOCK_ADMIN_RATE_LIMIT: { limit: async () => ({ success: allow }) },
  SLOTLOCK_ADMIN_PUBLIC_URL: 'https://admin.example.com',
  SLOTLOCK_ADMIN_ACCESS_TEAM_DOMAIN: 'https://example.cloudflareaccess.com/',
  SLOTLOCK_ADMIN_ACCESS_AUD: AUD,
  SLOTLOCK_ADMIN_GITHUB_CLIENT_ID: 'id',
  SLOTLOCK_ADMIN_GITHUB_CLIENT_SECRET: 'secret',
  SLOTLOCK_ADMIN_SESSION_SECRET: 's'.repeat(40),
  SLOTLOCK_ADMIN_CONSOLE_KEY: 'k'.repeat(64),
  ...overrides,
});

function harness() {
  const opened: string[] = [];
  const ended: unknown[] = [];
  const waits: Promise<unknown>[] = [];
  const worker = createSlotlockAdminWorker({
    connect: (connectionString) => {
      opened.push(connectionString);
      return { end: async (options: unknown) => void ended.push(options) } as unknown as Sql;
    },
    // Access's keys: none, so every token is refused.
    fetch: (async () => new Response('{"keys":[]}', { status: 200 })) as typeof fetch,
  });
  const ctx = { waitUntil: (promise: Promise<unknown>) => void waits.push(promise) };
  return { worker, opened, ended, waits, ctx };
}

describe('the admin console Worker', () => {
  it('answers 503 until every setting and binding is there, without opening a database client', async () => {
    const { worker, opened, ctx } = harness();
    for (const broken of [
      env({ SLOTLOCK_ADMIN_SESSION_SECRET: '' }),
      // The key `slotlock staff console-key` prints: without it the database opens no session.
      env({ SLOTLOCK_ADMIN_CONSOLE_KEY: undefined as never }),
      env({ SLOTLOCK_ADMIN_CONSOLE_KEY: 'too-short' }),
      env({ SLOTLOCK_ADMIN_CONSOLE_KEY: 's'.repeat(40) }),
      env({ SLOTLOCK_ADMIN_ACCESS_AUD: 'set-this-to-the-access-application-aud' }),
      env({ SLOTLOCK_ADMIN_PUBLIC_URL: 'http://admin.example.com' }),
      env({ SLOTLOCK_ADMIN_RATE_LIMIT: undefined as never }),
      env({ HYPERDRIVE: undefined as never }),
    ]) {
      const response = await worker.fetch(new Request('https://admin.example.com/'), broken, ctx);
      expect(response.status).toBe(503);
      expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    }
    expect(opened).toEqual([]);
  });

  it('counts a request before opening a database client', async () => {
    const { worker, opened, ctx } = harness();
    const response = await worker.fetch(new Request('https://admin.example.com/'), env({}, false), ctx);
    expect(response.status).toBe(429);
    expect(opened).toEqual([]);
  });

  it('refuses a request Cloudflare Access did not sign, and closes the request client', async () => {
    const { worker, opened, ended, waits, ctx } = harness();
    const response = await worker.fetch(
      new Request('https://admin.example.com/', { headers: { 'cf-access-jwt-assertion': 'not.a.token' } }),
      env(),
      ctx,
    );
    expect(response.status).toBe(403);
    await Promise.all(waits);
    expect(opened).toEqual(['postgres://admin@hyperdrive/slotlock']);
    expect(ended).toEqual([{ timeout: 5 }]);
  });

  it('ships an example configuration with no public workers.dev address and no query strings in logs', () => {
    const text = readFileSync(new URL('../../workers/admin/wrangler.jsonc', import.meta.url), 'utf8');
    expect(text).toMatch(/"workers_dev": false/);
    expect(text).toMatch(/"preview_urls": false/);
    expect(text).toMatch(/"redact_query_string": true/);
    expect(text).toMatch(/"name": "SLOTLOCK_ADMIN_RATE_LIMIT"/);
    // Its rate limit namespace is not one of the dashboard's.
    const dashboard = readFileSync(new URL('../../workers/dashboard/wrangler.jsonc', import.meta.url), 'utf8');
    const ids = (source: string) => [...source.matchAll(/"namespace_id": "(\d+)"/g)].map((m) => m[1]);
    for (const id of ids(text)) expect(ids(dashboard)).not.toContain(id);
  });

  it('turns the CMS on with the App\'s Client ID and its key alone, and still with an App ID and installation', () => {
    const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const quiet = console.error;
    console.error = () => {};
    try {
      expect(cmsOf(env({ SLOTLOCK_ADMIN_CMS_APP_ID: ' Iv23liReleaseApp ', SLOTLOCK_ADMIN_CMS_INSTALLATION: '', SLOTLOCK_ADMIN_CMS_APP_KEY: key }))).toEqual({
        cms: { appId: 'Iv23liReleaseApp', privateKey: key.trim(), repository: 'PILOTAAI/slotlock', siteUrl: 'https://slotlock.pylota.io' },
      });
      expect(cmsOf(env({ SLOTLOCK_ADMIN_CMS_APP_ID: '4242', SLOTLOCK_ADMIN_CMS_INSTALLATION: '7777', SLOTLOCK_ADMIN_CMS_APP_KEY: key }))).toMatchObject({
        cms: { appId: '4242', installationId: '7777' },
      });
      // Off, never half on: nothing set, no key, an id of neither shape, an installation that is not a number.
      for (const broken of [
        {},
        { SLOTLOCK_ADMIN_CMS_APP_ID: 'Iv23liReleaseApp' },
        { SLOTLOCK_ADMIN_CMS_APP_KEY: key },
        { SLOTLOCK_ADMIN_CMS_APP_ID: 'Ov23liAnOAuthApp', SLOTLOCK_ADMIN_CMS_APP_KEY: key },
        { SLOTLOCK_ADMIN_CMS_APP_ID: 'Iv23liReleaseApp', SLOTLOCK_ADMIN_CMS_INSTALLATION: 'abc', SLOTLOCK_ADMIN_CMS_APP_KEY: key },
      ]) {
        expect(cmsOf(env(broken)), JSON.stringify(Object.keys(broken))).toEqual({});
      }
    } finally {
      console.error = quiet;
    }
  });
});
