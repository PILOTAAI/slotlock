// The dashboard assistant end to end, in a real browser: the dashboard on a loopback port over real
// Postgres (as a LOGIN role without BYPASSRLS), GitHub faked behind its own authorize page, and a
// model server speaking OpenAI-compatible chat completions or the Anthropic Messages API. An owner
// connects the model in Settings and tests it; a member (not an owner) asks what is free, then asks
// for a booking, approves the proposed change, and finds it on the overview and in agent activity
// as the assistant's; a member of another organization sees none of it; the key is in no page.
// The OpenAI-compatible run has JavaScript off (the dashboard works as plain forms); the Anthropic
// run has it on. Skipped without DATABASE_URL or Playwright (`require('playwright')`), whose
// screenshots go to SLOTLOCK_E2E_SCREENSHOTS when it is set.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockStoreAgentBackend } from '../agent-store-backend.js';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import {
  type SlotlockDashboard,
  createSlotlockDashboard,
  createSlotlockDashboardResources,
  createSlotlockDashboardState,
} from '../dashboard.js';
import { createSlotlockNodeServer } from '../node-server.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import {
  type FakeModel,
  type FakeModelFormat,
  type FakeModelRequest,
  startFakeModel,
  toolResultsSent,
} from './helpers/fake-model.js';

const url = process.env.DATABASE_URL?.trim();
const screenshots = process.env.SLOTLOCK_E2E_SCREENSHOTS?.trim();

interface Playwright {
  chromium: {
    launch(): Promise<{
      newContext(options: { javaScriptEnabled: boolean }): Promise<BrowserContext>;
      close(): Promise<void>;
    }>;
  };
}
interface BrowserContext {
  newPage(): Promise<Page>;
  close(): Promise<void>;
}
interface Page {
  goto(url: string): Promise<unknown>;
  content(): Promise<string>;
  fill(selector: string, value: string): Promise<void>;
  selectOption(selector: string, value: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  textContent(selector: string): Promise<string | null>;
  screenshot(options: { path: string; fullPage: boolean }): Promise<unknown>;
  url(): string;
}

function loadPlaywright(): Playwright | null {
  try {
    return createRequire(import.meta.url)('playwright') as Playwright;
  } catch {
    return null;
  }
}
const playwright = url ? loadPlaywright() : null;

const API_KEY = `sk-e2e-${randomBytes(12).toString('hex')}-tail`;
const DAY = 86_400_000;

describe.skipIf(!url || !playwright)('the dashboard assistant in a browser (real Postgres)', () => {
  const role = `slotlock_e2e_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let browser: Awaited<ReturnType<Playwright['chromium']['launch']>>;
  const tenants: string[] = [];

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
      max: 6,
      onnotice: () => {},
    });
    store = createSlotlockStore(application);
    browser = await (playwright as Playwright).chromium.launch();
    if (screenshots) mkdirSync(screenshots, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    for (const ref of tenants) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it.each([
    { format: 'openai' as FakeModelFormat, javaScript: false },
    { format: 'anthropic' as FakeModelFormat, javaScript: true },
  ])('runs the whole flow over $format (JavaScript $javaScript)', async ({ format, javaScript }) => {
    const id = () => 100_000_000 + Math.floor(Math.random() * 899_999_999);
    const fleet = { id: id(), login: `fleet-${format}` };
    const rival = { id: id(), login: `rival-${format}` };
    const people: Record<string, { id: number; login: string; org: typeof fleet; role: string }> = {
      owner: { id: id(), login: `owner-${format}`, org: fleet, role: 'admin' },
      member: { id: id(), login: `member-${format}`, org: fleet, role: 'member' },
      outsider: { id: id(), login: `outsider-${format}`, org: rival, role: 'member' },
    };
    const fleetTenant = `github-org:${fleet.id}`;
    const rivalTenant = `github-org:${rival.id}`;
    tenants.push(fleetTenant, rivalTenant);
    const van = await store.withTenant(fleetTenant, (tenant) =>
      tenant.createResource({ tenantRef: fleetTenant, externalRef: `van-${format}`, timezone: 'UTC' }),
    );
    await store.withTenant(rivalTenant, (tenant) =>
      tenant.createResource({ tenantRef: rivalTenant, externalRef: `rival-truck-${format}`, timezone: 'UTC' }),
    );

    const model: FakeModel = await startFakeModel(format);
    const tomorrow = new Date(Math.floor(Date.now() / DAY) * DAY + DAY);
    const at = (hours: number) => new Date(tomorrow.getTime() + hours * 3_600_000).toISOString();
    const lastResult = (request: FakeModelRequest) => toolResultsSent(format, request).at(-1) ?? '{}';

    // Who signs in next: the fake authorize page sends them straight back with their code.
    let signingIn = 'owner';
    let dashboard: SlotlockDashboard | undefined;
    let origin = '';
    const server = createSlotlockNodeServer(
      {
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === '/fake-github/authorize') {
            const query = new URL(request.url).searchParams;
            const back = new URL(query.get('redirect_uri') as string);
            back.search = new URLSearchParams({ code: signingIn, state: query.get('state') as string }).toString();
            return Response.redirect(back.href, 302);
          }
          return (dashboard as SlotlockDashboard).fetch(request);
        },
      },
      { requestOrigin: 'http://localhost' },
    );
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    origin = `http://localhost:${address.port}`;
    const githubFetch = async (input: string | URL | Request, init: RequestInit = {}) => {
      const target = String(input);
      if (target.endsWith('/access_token')) {
        return Response.json({ access_token: `gho_${new URLSearchParams(String(init.body)).get('code')}` });
      }
      const who = people[new Headers(init.headers).get('authorization')?.slice(11) ?? ''];
      if (!who) return new Response('no', { status: 401 });
      if (target === 'https://api.github.com/user') return Response.json({ id: who.id, login: who.login });
      return Response.json([{ state: 'active', role: who.role, organization: who.org }]);
    };
    dashboard = createSlotlockDashboard({
      publicUrl: origin,
      github: {
        clientId: 'Ov23liE2E',
        clientSecret: randomBytes(20).toString('hex'),
        authorizeUrl: `${origin}/fake-github/authorize`,
      },
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: '*',
      organizations: [String(fleet.id), String(rival.id)],
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      fetch: githubFetch,
      assistant: {
        secret: randomBytes(32).toString('hex'),
        // The fake model is on this machine, as a self-hosted one would be.
        privateUrls: true,
        backend: createSlotlockStoreAgentBackend(store, {
          availabilityRules: async () => [
            { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU', startMinutes: 480, durationMinutes: 600 },
          ],
        }),
      },
    });

    const seen: string[] = [];
    const shot = async (page: Page, name: string) => {
      seen.push(await page.content());
      if (screenshots) await page.screenshot({ path: join(screenshots, `${format}-${name}.png`), fullPage: true });
    };
    const session = async (who: string) => {
      const context = await browser.newContext({ javaScriptEnabled: javaScript });
      const page = await context.newPage();
      signingIn = who;
      await page.goto(`${origin}/dashboard/sign-in`);
      expect(page.url()).toBe(`${origin}/dashboard`);
      return { context, page };
    };

    try {
      // 1. The owner connects the model in Settings and tests the connection.
      const owner = await session('owner');
      await owner.page.goto(`${origin}/dashboard/settings`);
      await owner.page.selectOption('select[name="provider"]', format);
      await owner.page.fill('input[name="base_url"]', model.baseUrl);
      await owner.page.fill('input[name="model"]', 'your-model');
      await owner.page.fill('input[name="api_key"]', API_KEY);
      await owner.page.click('#assistant button.primary');
      expect(await owner.page.content()).toContain('set, ending in <code>tail</code>');
      model.script({ calls: [{ name: 'slotlock_list_resources', input: {} }] });
      await owner.page.click('text=Test connection');
      expect(await owner.page.content()).toContain('called a tool correctly');
      expect(model.requests.at(-1)?.headers[format === 'anthropic' ? 'x-api-key' : 'authorization']).toContain(API_KEY);
      await shot(owner.page, '1-settings');

      // 2. A member, not an owner, asks what is free tomorrow: a read, answered from real data.
      const member = await session('member');
      await member.page.goto(`${origin}/dashboard/settings`);
      expect(await member.page.content()).not.toContain('name="api_key"');
      await member.page.goto(`${origin}/dashboard/assistant`);
      model.script(
        {
          calls: [
            {
              name: 'slotlock_find_next_available',
              input: { resource_ids: [van.id], start: at(0), end: at(24), duration_minutes: 60 },
            },
          ],
        },
        (request) => {
          const found = JSON.parse(lastResult(request)) as { start?: string | null };
          return { text: `Tomorrow van-${format} is first free at ${found.start ?? 'no time'}.` };
        },
      );
      await member.page.fill('textarea[name="message"]', `What's free tomorrow on van-${format}?`);
      await member.page.click('.composer button');
      const answered = await member.page.content();
      expect(answered).toContain(`Tomorrow van-${format} is first free at ${at(8).replace('.000Z', '')}`);
      expect(answered).toContain('Read: Find next available interval');
      await shot(member.page, '2-read');

      // 3. The member asks for a booking: a proposed change, approved, then on the overview.
      model.script(
        {
          calls: [
            {
              name: 'slotlock_create_event',
              input: { resource_id: van.id, starts_at: at(10), ends_at: at(11), timezone: 'UTC', title: 'Ana pickup' },
            },
          ],
        },
        { text: 'I proposed booking 10:00 to 11:00 for Ana. Approve it to book.' },
      );
      await member.page.fill('textarea[name="message"]', 'Book 10 to 11 for Ana pickup');
      await member.page.click('.composer button');
      const proposed = await member.page.content();
      expect(proposed).toContain('Create resource event');
      expect(proposed).toContain('Waiting for you');
      expect(proposed).toContain(`van-${format}`);
      await shot(member.page, '3-proposed');
      const before = await store.withTenant(fleetTenant, (tenant) =>
        tenant.listAgenda({ tenantRef: fleetTenant, window: { start: tomorrow, end: new Date(tomorrow.getTime() + DAY) }, limit: 10 }),
      );
      expect(before).toEqual([]);
      model.script({ text: 'Booked.' });
      await member.page.click('.action-card button.primary');
      expect(await member.page.textContent('.action-card .pill')).toBe('Done');
      await shot(member.page, '3-approved');
      await member.page.goto(`${origin}/dashboard`);
      const overview = await member.page.content();
      expect(overview).toContain('Ana pickup');
      expect(overview).toContain(`Assistant for @member-${format}`);
      await shot(member.page, '3-overview');
      const history = await admin<{ actor: string }[]>`
        SELECT actor FROM slotlock.outbox WHERE tenant_ref = ${fleetTenant} AND type = 'event.created'`;
      expect(history.map(({ actor }) => actor)).toEqual([`dashboard-assistant:member-${format}`]);

      // 4. A member of another organization sees nothing of the first one's.
      const outsider = await session('outsider');
      await outsider.page.goto(`${origin}/dashboard/assistant`);
      const theirs = await outsider.page.content();
      expect(theirs).toContain('No model is connected');
      expect(theirs).not.toContain('Ana');
      await outsider.page.goto(`${origin}/dashboard`);
      const theirOverview = await outsider.page.content();
      expect(theirOverview).not.toContain('Ana pickup');
      expect(theirOverview).not.toContain(`van-${format}`);
      await outsider.page.goto(`${origin}/dashboard/resources`);
      expect(await outsider.page.content()).toContain(`rival-truck-${format}`);
      await shot(outsider.page, '4-other-org');

      // 5. The key is in no page anyone saw.
      for (const html of seen) expect(html).not.toContain(API_KEY);
      for (const { context } of [owner, member, outsider]) await context.close();
    } finally {
      await server.close();
      await model.close();
    }
  }, 120_000);
});
