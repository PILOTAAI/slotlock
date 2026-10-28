// The dashboard assistant without a database: an organization's owner connects a model, and its
// members chat with it. The model is a real HTTP server on a loopback port speaking the Anthropic
// Messages API or OpenAI-compatible chat completions; GitHub is a fake `fetch`; the agent backend
// records what runs. Reads run, writes wait for the member's approval and run once, a tool outside
// the list is refused, the key is never rendered, a member cannot change the settings, one
// organization never sees another's, provider failures read plainly, and a message is bounded.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SlotlockAgentCalendarBackend,
  SlotlockAgentInvocationContext,
} from '../agent-server.js';
import type { SlotlockApiKeyStore } from '../api-keys.js';
import {
  SLOTLOCK_ASSISTANT_MAX_STORED_BYTES,
  SLOTLOCK_ASSISTANT_TOOL_USE,
  type SlotlockAssistantEntry,
  type SlotlockAssistantStore,
  boundSlotlockAssistantEntries,
  pruneSlotlockAssistantActions,
  createSlotlockMemoryAssistantStore,
  openSlotlockAssistantKey,
  readSlotlockAssistantBaseUrl,
  sealSlotlockAssistantKey,
  slotlockAssistantTools,
} from '../assistant.js';
import {
  type SlotlockDashboardOptions,
  type SlotlockDashboardResources,
  createSlotlockDashboard,
  createSlotlockMemoryDashboardState,
} from '../dashboard.js';
import { createSlotlockGuardedFetch } from '../webhooks.js';
import { SLOTLOCK_DEFAULT_LIMITS } from '../config.js';
import { createSlotlockRequestLimits } from '../rate-limit.js';
import {
  SLOTLOCK_WORKER_AGENT_CALLS_PER_REQUEST,
  createSlotlockWorkerAgentLimiter,
} from '../../workers/dashboard/worker.js';
import {
  type FakeModel,
  type FakeModelFormat,
  startFakeModel,
  toolResultsSent,
  toolsOffered,
} from './helpers/fake-model.js';

const ORIGIN = 'https://slotlock.example.com';
const ACME = { id: 91, login: 'acme-fleet' };
const GLOBEX = { id: 92, login: 'globex' };
const PEOPLE = {
  alice: { id: 11, login: 'alice', orgs: [{ ...ACME, role: 'admin' }] },
  bob: { id: 12, login: 'bob', orgs: [{ ...ACME, role: 'member' }] },
  carol: { id: 13, login: 'carol', orgs: [{ ...GLOBEX, role: 'admin' }] },
} as const;
type Person = keyof typeof PEOPLE;
const API_KEY = 'sk-test-0123456789abcdefSECRET-wxyz';
const ASSISTANT_SECRET = 'c4f1e9a27b3d5f80a6c2e4b8d0f1a3c5e7b9d2f4a6c8e0b1d3f5a7c9e2b4d6f8';

/** GitHub: the code names the person; their token reads their profile and memberships. */
const github = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = String(input);
  if (url.endsWith('/access_token')) {
    const code = new URLSearchParams(String(init.body)).get('code') as string;
    return Response.json({ access_token: `gho_${code}` });
  }
  const who = PEOPLE[new Headers(init.headers).get('authorization')?.slice(11) as Person];
  if (url === 'https://api.github.com/user') return Response.json({ id: who.id, login: who.login });
  return Response.json(
    who.orgs.map(({ role, ...organization }) => ({ state: 'active', role, organization })),
  );
});

const RESOURCE = { id: 'resource-1', external_ref: 'vehicle-1', timezone: 'Europe/London' };

function fakeBackend() {
  const seen = new Set<string>();
  return {
    listResources: vi.fn(async (_context: SlotlockAgentInvocationContext) => ({
      resources: [RESOURCE],
      next_cursor: null,
    })),
    getFreeBusy: vi.fn(async () => ({})),
    findNextAvailable: vi.fn(async () => ({})),
    createEvent: vi.fn(async () => ({})),
    // The event a change or cancellation names, as the store reads it back.
    getEvent: vi.fn(async (_context: SlotlockAgentInvocationContext, input: Record<string, unknown>) => ({
      event: {
        event_id: String(input.event_id),
        resource_id: RESOURCE.id,
        starts_at: '2027-03-02T10:00:00Z',
        ends_at: '2027-03-02T11:00:00Z',
        timezone: 'Europe/London',
        title: 'Ana pickup',
        revision: 1,
      },
    })),
    describeResource: vi.fn(async () => ({ name: RESOURCE.external_ref, timezone: RESOURCE.timezone })),
    listEvents: vi.fn(async () => ({ events: [], next_cursor: null })),
    updateEvent: vi.fn(async () => ({})),
    // Idempotent by key, like the store: a repeat answers `replayed`.
    deleteEvent: vi.fn(async (_context: SlotlockAgentInvocationContext, input: Record<string, unknown>) => {
      const key = String(input.idempotency_key);
      const replayed = seen.has(key);
      seen.add(key);
      return { event_id: String(input.event_id), revision: 2, deleted: true as const, replayed };
    }),
  } satisfies SlotlockAgentCalendarBackend;
}

const noKeys: SlotlockApiKeyStore = {
  create: async () => {
    throw new Error('unused');
  },
  list: async () => [],
  rotate: async () => null,
  revoke: async () => null,
  authenticate: async () => null,
  erase: async () => 0,
};

let backend: ReturnType<typeof fakeBackend>;
let assistantStore: SlotlockAssistantStore;
let reported: unknown[];

function dashboard(
  overrides: Partial<SlotlockDashboardOptions['assistant']> = {},
  resourceOverrides: Partial<SlotlockDashboardResources> = {},
) {
  return createSlotlockDashboard({
    publicUrl: ORIGIN,
    github: { clientId: 'Ov23liAssistant', clientSecret: 'f'.repeat(20) + '0123456789abcdef0123' },
    sessionSecret: '7f3c9a1e5b2d8f604a9c1e7b3d5f2a8c6e0b4d9f1a3c5e7b9d2f4a6c8e0b1d3f',
    allowedUsers: '*',
    organizations: [String(ACME.id), String(GLOBEX.id)],
    keys: noKeys,
    resources: {
      list: async () => [],
      add: async () => {
        throw new Error('unused');
      },
      setHours: async () => 0,
      assistant: assistantStore,
      ...resourceOverrides,
    },
    state: createSlotlockMemoryDashboardState(),
    fetch: github,
    onError: (error) => {
      reported.push(error);
    },
    // The fake model listens on 127.0.0.1: these tests run with SLOTLOCK_ASSISTANT_PRIVATE_URLS on,
    // and the private-address tests below turn it off.
    assistant: { secret: ASSISTANT_SECRET, backend, timeoutMs: 5_000, privateUrls: true, ...overrides },
  });
}

type Dashboard = ReturnType<typeof dashboard>;

const get = (target: Dashboard, path: string, cookie: string) =>
  target.fetch(new Request(`${ORIGIN}${path}`, { headers: { cookie } }));

async function signIn(target: Dashboard, person: Person): Promise<string> {
  const start = await target.fetch(new Request(`${ORIGIN}/dashboard/sign-in`));
  const state = new URL(start.headers.get('location') as string).searchParams.get('state');
  const pending = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
  const callback = await get(target, `/dashboard/callback?code=${person}&state=${state}`, pending);
  return callback.headers
    .getSetCookie()
    .find((value) => value.startsWith('__Host-slotlock-session='))
    ?.split('; ')[0] as string;
}

/** Send a form from the dashboard, with the page's CSRF token and a fresh single-use value. */
async function post(target: Dashboard, path: string, fields: Record<string, string>, cookie: string) {
  const page = await (await get(target, '/dashboard/keys', cookie)).text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(page)?.[1] as string;
  const once = /name="once" value="([^"]+)"/.exec(page)?.[1] as string;
  return target.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, once, ...fields }).toString(),
    }),
  );
}

async function connect(target: Dashboard, admin: string, model: FakeModel, format: FakeModelFormat) {
  const saved = await post(
    target,
    '/dashboard/settings/assistant',
    { provider: format, base_url: model.baseUrl, model: 'your-model', api_key: API_KEY },
    admin,
  );
  expect(saved.status).toBe(303);
}

const chat = (target: Dashboard, cookie: string, message: string) =>
  post(target, '/dashboard/assistant', { message }, cookie);
const page = async (target: Dashboard, cookie: string) =>
  (await get(target, '/dashboard/assistant', cookie)).text();

beforeEach(() => {
  backend = fakeBackend();
  assistantStore = createSlotlockMemoryAssistantStore();
  reported = [];
  github.mockClear();
});

describe.each(['anthropic', 'openai'] as const)('the assistant over %s', (format) => {
  let model: FakeModel;
  beforeAll(async () => {
    model = await startFakeModel(format);
  });
  afterAll(() => model.close());
  beforeEach(() => {
    model.requests.length = 0;
  });

  it("runs a read the model asks for, in the member's tenant, and shows its answer", async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, format);
    const bob = await signIn(target, 'bob');
    model.script(
      { text: 'Looking.', calls: [{ name: 'slotlock_list_resources', input: {} }] },
      { text: 'You have vehicle-1, in London.' },
    );
    expect((await chat(target, bob, 'What can we book?')).status).toBe(303);

    expect(backend.listResources).toHaveBeenCalledTimes(1);
    const context = backend.listResources.mock.calls[0]?.[0] as SlotlockAgentInvocationContext;
    expect(context.principal).toMatchObject({ tenantRef: 'github-org:91', subject: 'dashboard-assistant:github:12' });
    // Its changes are recorded as the assistant's, beside the member it acts for.
    expect(context.origin).toBe('dashboard-assistant');
    expect(model.requests).toHaveLength(2);
    const [first, second] = model.requests;
    // The vendor's request format, with the key where the vendor expects it.
    if (format === 'anthropic') {
      expect(first?.path).toBe('/v1/messages');
      expect(first?.headers['x-api-key']).toBe(API_KEY);
      expect(first?.headers['anthropic-version']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof first?.body.system).toBe('string');
      expect(first?.body.max_tokens).toBeGreaterThan(0);
    } else {
      expect(first?.path).toBe('/v1/chat/completions');
      expect(first?.headers.authorization).toBe(`Bearer ${API_KEY}`);
      expect((first?.body.messages as Array<{ role: string }>)[0]?.role).toBe('system');
    }
    expect(first?.body.model).toBe('your-model');
    // The fixed list: every read and write agent tool, no idempotency key for the model to choose.
    expect(toolsOffered(format, first).sort()).toEqual(Object.keys(SLOTLOCK_ASSISTANT_TOOL_USE).sort());
    for (const tool of first?.body.tools as Array<Record<string, Record<string, unknown>>>) {
      const schema = format === 'anthropic' ? tool.input_schema : tool.function?.parameters;
      expect(JSON.stringify(schema)).not.toContain('idempotency_key');
    }
    expect(toolResultsSent(format, second)).toEqual([JSON.stringify({ resources: [RESOURCE], next_cursor: null })]);

    const html = await page(target, bob);
    expect(html).toContain('What can we book?');
    expect(html).toContain('You have vehicle-1, in London.');
    expect(html).toContain('Read: List calendar resources');
  });

  it('proposes a write without running it, runs it once on approval, and never twice', async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, format);
    const bob = await signIn(target, 'bob');
    model.script(
      {
        calls: [
          {
            name: 'slotlock_delete_event',
            input: { event_id: 'agent:abc', expected_revision: 1, idempotency_key: 'model-chosen' },
          },
        ],
      },
      { text: 'I proposed cancelling it. Approve it to go ahead.' },
    );
    await chat(target, bob, 'Cancel that booking');
    expect(backend.deleteEvent).not.toHaveBeenCalled();
    const told = toolResultsSent(format, model.requests[1]);
    expect(JSON.parse(told[0] as string)).toMatchObject({ status: 'proposed' });

    const proposed = await page(target, bob);
    expect(proposed).toContain('Delete resource event');
    expect(proposed).toContain('Waiting for you');
    const actionId = /name="action" value="([A-Za-z0-9_-]{16})"/.exec(proposed)?.[1] as string;
    expect(actionId).toBeDefined();

    // Another member of the same organization cannot approve bob's change.
    const alice = await signIn(target, 'alice');
    expect((await post(target, '/dashboard/assistant/approve', { action: actionId }, alice)).status).toBe(409);
    expect(backend.deleteEvent).not.toHaveBeenCalled();

    const approved = await post(target, '/dashboard/assistant/approve', { action: actionId }, bob);
    expect(approved.status).toBe(303);
    expect(backend.deleteEvent).toHaveBeenCalledTimes(1);
    const [context, input] = backend.deleteEvent.mock.calls[0] as unknown as [
      SlotlockAgentInvocationContext,
      Record<string, unknown>,
    ];
    expect(context.principal.subject).toBe('dashboard-assistant:github:12');
    // The dashboard's key, from the action: the model's own does not count.
    expect(input).toEqual({
      event_id: 'agent:abc',
      expected_revision: 1,
      idempotency_key: `dashboard-assistant.${actionId}`,
    });
    expect(await page(target, bob)).toContain('Done');

    // Sent again, with a fresh form: already approved, nothing runs.
    const again = await post(target, '/dashboard/assistant/approve', { action: actionId }, bob);
    expect(again.status).toBe(409);
    expect(await again.text()).toContain('already approved or dismissed');
    expect(backend.deleteEvent).toHaveBeenCalledTimes(1);

    // The model hears the outcome on the next message.
    model.script({ text: 'Done.' });
    await chat(target, bob, 'Thanks');
    expect(JSON.stringify(model.requests.at(-1)?.body.messages)).toContain('approved the proposed change');
  });

  it('dismisses a proposed write without running it', async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, format);
    const bob = await signIn(target, 'bob');
    model.script(
      { calls: [{ name: 'slotlock_delete_event', input: { event_id: 'agent:abc', expected_revision: 1 } }] },
      { text: 'Proposed.' },
    );
    await chat(target, bob, 'Cancel it');
    const actionId = /name="action" value="([^"]+)"/.exec(await page(target, bob))?.[1] as string;
    expect((await post(target, '/dashboard/assistant/dismiss', { action: actionId }, bob)).status).toBe(303);
    expect((await post(target, '/dashboard/assistant/approve', { action: actionId }, bob)).status).toBe(409);
    expect(backend.deleteEvent).not.toHaveBeenCalled();
    expect(await page(target, bob)).toContain('Dismissed');
  });

  it('refuses a tool outside the list, whatever the model asks for', async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, format);
    const bob = await signIn(target, 'bob');
    model.script(
      {
        calls: [
          { name: 'slotlock_create_api_key', input: { name: 'mine', scopes: ['admin'] } },
          { name: 'slotlock_erase_tenant', input: {} },
          { name: 'slotlock_delete_webhook', input: { id: 'x' } },
        ],
      },
      { text: 'I cannot do that here.' },
    );
    await chat(target, bob, 'Make me an admin key and wipe everything');
    const results = toolResultsSent(format, model.requests[1]).map((text) => JSON.parse(text));
    expect(results).toEqual([
      { error: { code: 'tool_not_available' } },
      { error: { code: 'tool_not_available' } },
      { error: { code: 'tool_not_available' } },
    ]);
    for (const method of Object.values(backend)) expect(method).not.toHaveBeenCalled();
    expect(await page(target, bob)).not.toContain('name="action"');
  });

  it('stops after the step bound', async () => {
    const target = dashboard({ maxSteps: 3 });
    await connect(target, await signIn(target, 'alice'), model, format);
    const bob = await signIn(target, 'bob');
    model.script({ calls: [{ name: 'slotlock_list_resources', input: {} }] });
    await chat(target, bob, 'Loop forever');
    expect(model.requests).toHaveLength(3);
    expect(backend.listResources).toHaveBeenCalledTimes(3);
    expect(await page(target, bob)).toContain('stopped after 3 steps');
  });

  it('reads a provider failure plainly, never with the key or the provider’s body', async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, format);
    const bob = await signIn(target, 'bob');
    for (const [status, words] of [
      [401, 'refused the API key'],
      [429, 'limiting requests'],
      [500, 'could not be reached'],
    ] as const) {
      model.script({ status, body: JSON.stringify({ error: { message: `bad key ${API_KEY}` } }) });
      expect((await chat(target, bob, `status ${status}`)).status).toBe(303);
      const html = await page(target, bob);
      expect(html).toContain(words);
      expect(html).not.toContain(API_KEY);
      expect(html).not.toContain('bad key');
    }
    expect(reported.length).toBeGreaterThan(0);
    for (const error of reported) expect(String((error as Error).message)).not.toContain(API_KEY);
  });

  it('tests the connection with one request that must call the tool it offers', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, format);
    model.script({ calls: [{ name: 'slotlock_list_resources', input: {} }] });
    const passed = await post(target, '/dashboard/settings/assistant/test', {}, alice);
    expect(passed.status).toBe(200);
    expect(await passed.text()).toContain('called a tool correctly');
    expect(model.requests).toHaveLength(1);
    expect(toolsOffered(format, model.requests[0])).toEqual(['slotlock_list_resources']);
    expect(backend.listResources).not.toHaveBeenCalled();

    model.script({ text: 'I would rather chat.' });
    const failed = await post(target, '/dashboard/settings/assistant/test', {}, alice);
    expect(failed.status).toBe(502);
    expect(await failed.text()).toContain('did not call the tool');
  });
});

describe('assistant settings', () => {
  let model: FakeModel;
  beforeAll(async () => {
    model = await startFakeModel('openai');
  });
  afterAll(() => model.close());

  it('never renders the key: only that it is set, and its last four characters', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, 'openai');
    const settings = await (await get(target, '/dashboard/settings', alice)).text();
    expect(settings).toContain('set, ending in <code>wxyz</code>');
    expect(settings).toContain('are sent to this provider');
    for (const path of ['/dashboard', '/dashboard/settings', '/dashboard/assistant']) {
      expect(await (await get(target, path, alice)).text()).not.toContain(API_KEY);
    }
    const stored = await assistantStore.getSettings('github-org:91');
    expect(stored?.sealedKey).not.toContain(API_KEY);
    expect(stored?.keyHint).toBe('wxyz');

    // Saved again without a key: the key stays; with "remove", it goes.
    await post(target, '/dashboard/settings/assistant', { provider: 'openai', base_url: model.baseUrl, model: 'other-model', api_key: '' }, alice);
    expect((await assistantStore.getSettings('github-org:91'))?.keyHint).toBe('wxyz');
    await post(target, '/dashboard/settings/assistant', { provider: 'openai', base_url: model.baseUrl, model: 'other-model', clear_key: '1' }, alice);
    expect(await assistantStore.getSettings('github-org:91')).toMatchObject({ sealedKey: null, keyHint: null });
  });

  it('lets only an owner change them; a member sees them and may chat', async () => {
    const target = dashboard();
    const bob = await signIn(target, 'bob');
    const settings = await (await get(target, '/dashboard/settings', bob)).text();
    expect(settings).not.toContain('action="/dashboard/settings/assistant"');
    for (const path of ['/dashboard/settings/assistant', '/dashboard/settings/assistant/test', '/dashboard/settings/assistant/remove']) {
      const refused = await post(target, path, { provider: 'openai', base_url: model.baseUrl, model: 'x', api_key: 'stolen-key' }, bob);
      expect(refused.status, path).toBe(403);
    }
    expect(await assistantStore.getSettings('github-org:91')).toBeNull();
    const nav = await (await get(target, '/dashboard', bob)).text();
    expect(nav).toContain('href="/dashboard/assistant"');
    expect(await page(target, bob)).toContain('An admin of this organization can connect one');
  });

  it('accepts an https base URL, or http on this machine only with private URLs allowed', () => {
    const allowed = { privateUrls: true };
    expect(readSlotlockAssistantBaseUrl('https://api.example.com/v1/')).toEqual({ ok: true, url: 'https://api.example.com/v1' });
    expect(readSlotlockAssistantBaseUrl('http://localhost:11434/v1', allowed)).toEqual({ ok: true, url: 'http://localhost:11434/v1' });
    expect(readSlotlockAssistantBaseUrl('http://127.0.0.1:1234/v1', allowed)).toEqual({ ok: true, url: 'http://127.0.0.1:1234/v1' });
    for (const refused of ['http://models.internal/v1', 'https://user:pw@api.example.com', 'https://api.example.com/?x=1', 'ftp://x', 'nope']) {
      expect(readSlotlockAssistantBaseUrl(refused, allowed), refused).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses a base URL that is not https from the form', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    const refused = await post(target, '/dashboard/settings/assistant', { provider: 'openai', base_url: 'http://10.0.0.5/v1', model: 'm' }, alice);
    expect(refused.status).toBe(400);
    expect(await assistantStore.getSettings('github-org:91')).toBeNull();
  });

  it('seals the key for one tenant under one secret', async () => {
    const sealed = await sealSlotlockAssistantKey(ASSISTANT_SECRET, 'github-org:91', API_KEY);
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(API_KEY);
    await expect(openSlotlockAssistantKey(ASSISTANT_SECRET, 'github-org:91', sealed)).resolves.toBe(API_KEY);
    await expect(openSlotlockAssistantKey(ASSISTANT_SECRET, 'github-org:92', sealed)).resolves.toBeNull();
    await expect(openSlotlockAssistantKey(`${ASSISTANT_SECRET}x`, 'github-org:91', sealed)).resolves.toBeNull();
  });

  it('offers reads to run and writes to propose, and nothing else', () => {
    const tools = slotlockAssistantTools();
    expect(tools.filter((tool) => tool.use === 'read').map((tool) => tool.name).sort()).toEqual([
      'slotlock_find_available_slots',
      'slotlock_find_next_available',
      'slotlock_get_event',
      'slotlock_get_free_busy',
      'slotlock_get_pool_availability',
      'slotlock_list_events',
      'slotlock_list_resources',
    ]);
    for (const tool of tools) expect(tool.name).toMatch(/^slotlock_/);
    expect(tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/key|webhook|rule|pool_member|erase|coverage/)]),
    );
  });
});

describe('the assistant across organizations', () => {
  let model: FakeModel;
  beforeAll(async () => {
    model = await startFakeModel('anthropic');
  });
  afterAll(() => model.close());

  it("shows one organization nothing of another's model, conversation or proposed changes", async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, 'anthropic');
    const bob = await signIn(target, 'bob');
    model.script(
      { calls: [{ name: 'slotlock_delete_event', input: { event_id: 'agent:acme', expected_revision: 1 } }] },
      { text: 'Proposed the acme change.' },
    );
    await chat(target, bob, 'Cancel the acme booking');
    const actionId = /name="action" value="([^"]+)"/.exec(await page(target, bob))?.[1] as string;

    const carol = await signIn(target, 'carol');
    const theirs = await page(target, carol);
    expect(theirs).not.toContain('acme');
    expect(theirs).toContain('No model is connected');
    expect((await chat(target, carol, 'hello')).status).toBe(409);
    expect((await post(target, '/dashboard/assistant/approve', { action: actionId }, carol)).status).toBe(409);
    expect(backend.deleteEvent).not.toHaveBeenCalled();
    expect(await (await get(target, '/dashboard/settings', carol)).text()).not.toContain(model.baseUrl);
  });

  it('limits how fast one member sends', async () => {
    const target = dashboard({ rate: { perSecond: 1 / 60, burst: 2 } });
    await connect(target, await signIn(target, 'alice'), model, 'anthropic');
    const bob = await signIn(target, 'bob');
    model.script({ text: 'Hi.' });
    expect((await chat(target, bob, 'one')).status).toBe(303);
    expect((await chat(target, bob, 'two')).status).toBe(303);
    const limited = await chat(target, bob, 'three');
    expect(limited.status).toBe(429);
    // Another member has a budget of their own.
    expect((await chat(target, await signIn(target, 'alice'), 'mine')).status).toBe(303);
  });
});

describe('private model addresses (SLOTLOCK_ASSISTANT_PRIVATE_URLS)', () => {
  let model: FakeModel;
  beforeAll(async () => {
    model = await startFakeModel('openai');
  });
  afterAll(() => model.close());
  beforeEach(() => {
    model.requests.length = 0;
  });

  /** A resolver that answers every name with these addresses, as dns.lookup would. */
  const resolvingTo =
    (...addresses: string[]): typeof import('node:dns').lookup =>
      ((_hostname: string, _options: object, callback: (error: null, list: { address: string; family: number }[]) => void) =>
        callback(null, addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })))) as never;

  it('refuses loopback, private, link-local, shared, unique-local and metadata URLs by default', () => {
    for (const url of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://[::1]:8000/v1',
      'https://10.0.0.5/v1',
      'https://192.168.1.20/v1',
      'https://172.16.4.4/v1',
      'https://169.254.169.254/latest',
      'https://100.64.0.1/v1',
      'https://[fd00::1]/v1',
      'https://[fe80::1]/v1',
      'https://[::ffff:127.0.0.1]/v1',
      'https://models.localhost/v1',
    ]) {
      expect(readSlotlockAssistantBaseUrl(url), url).toEqual({ ok: false, reason: 'private' });
      expect(readSlotlockAssistantBaseUrl(url, { privateUrls: true }).ok, url).toBe(true);
    }
    expect(readSlotlockAssistantBaseUrl('https://93.184.215.14/v1').ok).toBe(true);
  });

  it('says why a loopback or private URL is refused when an owner saves it, and stores nothing', async () => {
    const target = dashboard({ privateUrls: false });
    const alice = await signIn(target, 'alice');
    for (const url of [model.baseUrl, 'https://10.1.2.3/v1', 'https://169.254.169.254/v1']) {
      const refused = await post(target, '/dashboard/settings/assistant', { provider: 'openai', base_url: url, model: 'your-model' }, alice);
      expect(refused.status, url).toBe(400);
      const html = await refused.text();
      expect(html).toContain('local or private network address');
      expect(html).toContain('SLOTLOCK_ASSISTANT_PRIVATE_URLS=on');
    }
    expect(await assistantStore.getSettings('github-org:91')).toBeNull();
  });

  it('refuses a name that resolves to a private address when saved', async () => {
    const target = dashboard({ privateUrls: false, resolve: async () => ['127.0.0.1'] });
    const alice = await signIn(target, 'alice');
    const refused = await post(target, '/dashboard/settings/assistant', { provider: 'openai', base_url: 'https://model.example.test/v1', model: 'your-model' }, alice);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('local or private network address');
    expect(await assistantStore.getSettings('github-org:91')).toBeNull();
  });

  it('refuses at call time a name that resolves to 127.0.0.1 as the connection is made (DNS rebinding)', async () => {
    const port = new URL(model.baseUrl).port;
    // Public when saved; rebound to loopback by the time the dashboard connects.
    const target = dashboard({
      privateUrls: false,
      resolve: async () => ['93.184.215.14'],
      fetch: createSlotlockGuardedFetch({ resolve: resolvingTo('127.0.0.1') }),
    });
    const alice = await signIn(target, 'alice');
    const saved = await post(target, '/dashboard/settings/assistant', { provider: 'openai', base_url: `https://model.example.test:${port}/v1`, model: 'your-model', api_key: API_KEY }, alice);
    expect(saved.status).toBe(303);
    const bob = await signIn(target, 'bob');
    expect((await chat(target, bob, 'hello')).status).toBe(303);
    const html = await page(target, bob);
    expect(html).toContain('resolves to, a local or private network address');
    expect(model.requests).toHaveLength(0);
    expect((await post(target, '/dashboard/settings/assistant/test', {}, alice)).status).toBe(502);
    expect(model.requests).toHaveLength(0);
  });

  it('checks the resolved address when it connects, and reaches it with the switch on', async () => {
    const port = new URL(model.baseUrl).port;
    const url = `http://model.example.test:${port}/v1/chat/completions`;
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' };
    await expect(createSlotlockGuardedFetch({ resolve: resolvingTo('127.0.0.1') })(url, init)).rejects.toMatchObject({ code: 'private_address' });
    await expect(createSlotlockGuardedFetch({ resolve: resolvingTo('93.184.215.14', '10.0.0.1') })(url, init)).rejects.toMatchObject({ code: 'private_address' });
    await expect(createSlotlockGuardedFetch()(`http://127.0.0.1:${port}/v1/chat/completions`, init)).rejects.toMatchObject({ code: 'private_address' });
    expect(model.requests).toHaveLength(0);
    model.script({ text: 'Hello from the box.' });
    const reached = await createSlotlockGuardedFetch({ allowPrivateNetworks: true, resolve: resolvingTo('127.0.0.1') })(url, init);
    expect(reached.status).toBe(200);
    expect(JSON.stringify(await reached.json())).toContain('Hello from the box.');
    expect(model.requests).toHaveLength(1);
  });

  it('refuses a stored private URL at call time once the switch is off', async () => {
    const open = dashboard({ privateUrls: true });
    await connect(open, await signIn(open, 'alice'), model, 'openai');
    const closed = dashboard({ privateUrls: false });
    const bob = await signIn(closed, 'bob');
    expect((await chat(closed, bob, 'hello')).status).toBe(409);
    expect(model.requests).toHaveLength(0);
  });
});

describe('security review fixes', () => {
  let model: FakeModel;
  beforeAll(async () => {
    model = await startFakeModel('openai');
  });
  afterAll(() => model.close());
  beforeEach(() => {
    model.requests.length = 0;
  });

  const proposeAndShow = async (target: Dashboard, bob: string, name: string, input: Record<string, unknown>) => {
    model.script({ calls: [{ name, input }] }, { text: 'Proposed.' });
    await chat(target, bob, 'Please');
    return page(target, bob);
  };

  // M1: the card is the whole action; ids are resolved; what cannot be shown is not proposed.
  it('M1: shows every one of 100 attendees on the card it asks the member to approve', async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, 'openai');
    const bob = await signIn(target, 'bob');
    const attendees = Array.from({ length: 100 }, (_, index) => ({
      address: `guest-${String(index).padStart(3, '0')}@example.com`,
      role: 'required',
      participation_status: 'needs_action',
    }));
    const html = await proposeAndShow(target, bob, 'slotlock_create_event', {
      resource_id: RESOURCE.id,
      starts_at: '2027-03-02T10:00:00Z',
      ends_at: '2027-03-02T11:00:00Z',
      timezone: 'Europe/London',
      title: 'Ana pickup',
      description: `Long notes ${'x'.repeat(5_000)} END-OF-DESCRIPTION`,
      attendees,
    });
    expect(html).toContain('Waiting for you');
    for (const { address } of attendees) expect(html, address).toContain(address);
    expect(html).toContain('END-OF-DESCRIPTION');
    // The resource by name, from the confirmation question.
    expect(html).toContain('vehicle-1');
    expect(html).not.toContain('…</');
  });

  it.each([
    ['slotlock_update_event', { event_id: 'agent:abc', expected_revision: 1, title: 'Moved pickup' }],
    ['slotlock_delete_event', { event_id: 'agent:abc', expected_revision: 1 }],
  ])('M1: names the event %s changes by its title, resource and time', async (name, input) => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, 'openai');
    const bob = await signIn(target, 'bob');
    const html = await proposeAndShow(target, bob, name, input);
    const summary = /<p class="action-summary">([^<]+)<\/p>/.exec(html)?.[1] ?? '';
    expect(summary).toContain('vehicle-1');
    expect(summary).toContain('Ana pickup');
    expect(summary).toMatch(/10:00/);
    expect(summary).toMatch(/2 Mar|Mar 2|2027-03-02/);
    expect(backend.getEvent).toHaveBeenCalled();
  });

  it('M1: refuses to propose a change too large to show in full', async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, 'openai');
    const bob = await signIn(target, 'bob');
    const attendees = Array.from({ length: 100 }, (_, index) => ({
      address: `guest-${index}@example.com`,
      name: `Guest ${index} ${'n'.repeat(150)}`,
      role: 'required',
      participation_status: 'needs_action',
    }));
    const html = await proposeAndShow(target, bob, 'slotlock_create_event', {
      resource_id: RESOURCE.id,
      starts_at: '2027-03-02T10:00:00Z',
      ends_at: '2027-03-02T11:00:00Z',
      timezone: 'Europe/London',
      attendees,
    });
    expect(html).not.toContain('name="action"');
    expect(toolResultsSent('openai', model.requests[1])).toEqual([JSON.stringify({ error: { code: 'change_too_large_to_show' } })]);
  });

  // M2: a proposal holds no series-write slot: another tenant's series write runs meanwhile.
  it("M2: lets another tenant's update_event through while a proposed one waits in a running turn", async () => {
    const limits = createSlotlockRequestLimits({
      limits: SLOTLOCK_DEFAULT_LIMITS,
      basePath: '',
      authenticate: async () => null,
    });
    const admitted: string[] = [];
    const target = dashboard({
      authorize: async () => true,
      admit: async (args) => {
        admitted.push(args.operation);
        await limits.admit(args);
      },
      consumeRateLimit: limits.consumeRateLimit,
    });
    const served = limits.serve({
      fetch: async (request) => {
        if (new URL(request.url).pathname !== '/agent') return target.fetch(request);
        try {
          await limits.admit({
            principal: { subject: 'agent:other', tenantRef: 'github-org:92', scopes: ['read', 'write'] },
            operation: 'slotlock_update_event',
            input: { event_id: 'agent:theirs', expected_revision: 1 },
          });
          return new Response('admitted');
        } catch (error) {
          return new Response((error as { code: string }).code, { status: (error as { status: number }).status });
        }
      },
    });
    const via = async (path: string, fields: Record<string, string>, cookie: string) => {
      const form = await (await get(target, '/dashboard/keys', cookie)).text();
      const csrf = /name="csrf" value="([^"]+)"/.exec(form)?.[1] as string;
      const once = /name="once" value="([^"]+)"/.exec(form)?.[1] as string;
      return served.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, once, ...fields }).toString(),
        }),
        { remoteAddress: '127.0.0.1' },
      );
    };
    try {
      await connect(target, await signIn(target, 'alice'), model, 'openai');
      const bob = await signIn(target, 'bob');
      let other: { status: number; text: string } | undefined;
      model.script(
        { calls: [{ name: 'slotlock_update_event', input: { event_id: 'agent:abc', expected_revision: 1, title: 'Moved' } }] },
        async () => {
          // The turn is still running: the proposal must not be holding the series-write slot.
          const answer = await served.fetch(new Request(`${ORIGIN}/agent`), { remoteAddress: '127.0.0.2' });
          other = { status: answer.status, text: await answer.text() };
          return { text: 'Proposed the move.' };
        },
      );
      expect((await via('/dashboard/assistant', { message: 'Move it' }, bob)).status).toBe(303);
      expect(other).toEqual({ status: 200, text: 'admitted' });
      expect(admitted).toEqual([]);
      const actionId = /name="action" value="([^"]+)"/.exec(await page(target, bob))?.[1] as string;
      expect((await via('/dashboard/assistant/approve', { action: actionId }, bob)).status).toBe(303);
      // The slot and the write token are taken when the approved change runs.
      expect(admitted).toEqual(['slotlock_update_event']);
      expect(backend.updateEvent).toHaveBeenCalledTimes(1);
    } finally {
      limits.close();
    }
  });

  // L1: the principal and actor are the member's GitHub user id; the login is only shown.
  it('L1: acts as dashboard-assistant:github:<uid> and shows it as the assistant for @login', async () => {
    const changes = [
      { id: 'seq:2', type: 'event.created', actor: 'dashboard-assistant:github:12', resourceId: null, occurredAt: new Date() },
      { id: 'seq:1', type: 'event.created', actor: 'dashboard-assistant:github:11', resourceId: null, occurredAt: new Date() },
    ];
    const target = dashboard({}, { recentChanges: async () => changes as never });
    await connect(target, await signIn(target, 'alice'), model, 'openai');
    const bob = await signIn(target, 'bob');
    model.script({ calls: [{ name: 'slotlock_list_resources', input: {} }] }, { text: 'One.' });
    await chat(target, bob, 'List');
    expect((backend.listResources.mock.calls[0]?.[0] as SlotlockAgentInvocationContext).principal.subject).toBe(
      'dashboard-assistant:github:12',
    );
    const overview = await (await get(target, '/dashboard', bob)).text();
    expect(overview).toContain('Assistant for @bob');
    expect(overview).toContain('Assistant for GitHub user 11');
  });

  // L2: bounded in UTF-8 bytes, whatever the script; actions pruned with their messages.
  it('L2: keeps a conversation of long CJK messages under the stored byte bound', () => {
    const cjk = '予約可能な時間帯を確認してください。'.repeat(220);
    let entries: SlotlockAssistantEntry[] = [];
    for (let turn = 0; turn < 40; turn += 1) {
      entries = boundSlotlockAssistantEntries([
        ...entries,
        { role: 'user', text: cjk.slice(0, 2_000) },
        { role: 'assistant', text: '', calls: [{ id: `c${turn}`, name: 'slotlock_list_resources', input: {} }] },
        { role: 'tool', results: [{ id: `c${turn}`, name: 'slotlock_list_resources', content: cjk.slice(0, 4_000), error: false }] },
        { role: 'assistant', text: cjk.slice(0, 8_000), calls: [] },
      ]);
      expect(Buffer.byteLength(JSON.stringify(entries), 'utf8')).toBeLessThanOrEqual(SLOTLOCK_ASSISTANT_MAX_STORED_BYTES);
      expect(entries[0]?.role).toBe('user');
    }
    // One exchange alone over the bound is cut down, not dropped: the message and answer stay.
    const huge = boundSlotlockAssistantEntries([
      { role: 'user', text: 'Find everything' },
      ...Array.from({ length: 8 }, (_, step): SlotlockAssistantEntry[] => [
        { role: 'assistant', text: cjk.slice(0, 8_000), calls: [{ id: `s${step}`, name: 'slotlock_list_events', input: {} }] },
        { role: 'tool', results: [{ id: `s${step}`, name: 'slotlock_list_events', content: cjk.slice(0, 8_000), error: false }] },
      ]).flat(),
      { role: 'assistant', text: 'Done.', calls: [] },
    ]);
    expect(huge[0]).toEqual({ role: 'user', text: 'Find everything' });
    expect(huge.at(-1)).toEqual({ role: 'assistant', text: 'Done.', calls: [] });
    expect(Buffer.byteLength(JSON.stringify(huge), 'utf8')).toBeLessThanOrEqual(SLOTLOCK_ASSISTANT_MAX_STORED_BYTES);
    // NUL, which jsonb refuses, is dropped.
    expect(boundSlotlockAssistantEntries([{ role: 'user', text: 'a\u0000b' }])).toEqual([{ role: 'user', text: 'ab' }]);
  });

  it('L2: drops the actions whose messages were dropped', () => {
    const entries: SlotlockAssistantEntry[] = [
      { role: 'user', text: 'x' },
      { role: 'tool', results: [{ id: 'c', name: 'slotlock_delete_event', content: '{}', error: false, action: 'kept' }] },
    ];
    expect(
      Object.keys(
        pruneSlotlockAssistantActions(entries, {
          kept: { status: 'pending', operation: 'slotlock_delete_event' },
          gone: { status: 'pending', operation: 'slotlock_delete_event' },
        }),
      ),
    ).toEqual(['kept']);
  });

  it('L2: answers every message of a long CJK conversation, never an error page', async () => {
    const target = dashboard({ rate: { perSecond: 100, burst: 100 } });
    await connect(target, await signIn(target, 'alice'), model, 'openai');
    const bob = await signIn(target, 'bob');
    const cjk = '明日の午前中に空いている車を探して予約してください。'.repeat(160);
    model.script({ text: cjk.slice(0, 8_000) });
    for (let turn = 0; turn < 25; turn += 1) {
      expect((await chat(target, bob, cjk.slice(0, 2_000))).status, `turn ${turn}`).toBe(303);
    }
    const stored = await assistantStore.getConversation('github-org:91', 'github:12');
    expect(Buffer.byteLength(JSON.stringify(stored?.messages), 'utf8')).toBeLessThanOrEqual(SLOTLOCK_ASSISTANT_MAX_STORED_BYTES);
  });

  // L4: reads share one budget a turn; the Worker caps agent calls a request and per tenant.
  it("L4: refuses a turn's reads past its budget of resource-days, on every path", async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, 'openai');
    const bob = await signIn(target, 'bob');
    const wide = {
      resource_ids: Array.from({ length: 50 }, (_, index) => `resource-${index}`),
      start: '2027-03-01T00:00:00Z',
      end: '2027-03-31T00:00:00Z',
    };
    model.script({ calls: [{ name: 'slotlock_list_events', input: wide }] }, { text: 'Too wide.' });
    await chat(target, bob, 'Everything this month');
    expect(backend.listEvents).not.toHaveBeenCalled();
    expect(toolResultsSent('openai', model.requests[1])).toEqual([JSON.stringify({ error: { code: 'turn_read_budget_exceeded' } })]);
    model.requests.length = 0;
    model.script({ calls: Array.from({ length: 8 }, () => ({ name: 'slotlock_list_resources', input: {} })) });
    await chat(target, bob, 'Loop');
    // 16 reads run, then the turn's budget is spent.
    expect(backend.listResources).toHaveBeenCalledTimes(16);
  });

  it('L4: limits the Worker assistant’s agent calls per request and per tenant', () => {
    const limiter = createSlotlockWorkerAgentLimiter({ SLOTLOCK_LIMITS: 'tenant_write=1/m:2' });
    const write = { principal: { subject: 's', tenantRef: 'github-org:1' }, operation: 'slotlock_update_event' as const };
    expect(limiter({ count: 0 }, write)).toBe(true);
    expect(limiter({ count: 0 }, write)).toBe(true);
    expect(limiter({ count: 0 }, write)).toBe(false);
    expect(limiter({ count: 0 }, { ...write, principal: { subject: 's', tenantRef: 'github-org:2' } })).toBe(true);
    const calls = { count: 0 };
    const read = { principal: { subject: 's', tenantRef: 'github-org:3' }, operation: 'slotlock_list_resources' as const };
    for (let index = 0; index < SLOTLOCK_WORKER_AGENT_CALLS_PER_REQUEST; index += 1) expect(limiter(calls, read)).toBe(true);
    expect(limiter(calls, read)).toBe(false);
  });

  // L5: a new provider or origin takes the key again.
  it('L5: makes the owner enter the key again when the provider or origin changes', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, 'openai');
    const save = (fields: Record<string, string>) =>
      post(target, '/dashboard/settings/assistant', { model: 'your-model', api_key: '', ...fields }, alice);
    const elsewhere = await save({ provider: 'openai', base_url: 'https://attacker.example.com/v1' });
    expect(elsewhere.status).toBe(400);
    expect(await elsewhere.text()).toContain('Enter the API key again');
    expect((await save({ provider: 'anthropic', base_url: model.baseUrl })).status).toBe(400);
    expect((await assistantStore.getSettings('github-org:91'))?.baseUrl).toBe(model.baseUrl);
    // The same origin, another path: a shared origin may serve another account's API there.
    expect((await save({ provider: 'openai', base_url: `${model.baseUrl}/other` })).status).toBe(400);
    expect((await assistantStore.getSettings('github-org:91'))?.baseUrl).toBe(model.baseUrl);
    // The same URL (a trailing slash is not another one) and another model: the key stays.
    expect((await save({ provider: 'openai', base_url: `${model.baseUrl}/`, model: 'other-model' })).status).toBe(303);
    expect(await assistantStore.getSettings('github-org:91')).toMatchObject({ model: 'other-model', keyHint: 'wxyz' });
    // A new key, or none, may go anywhere allowed.
    expect((await save({ provider: 'openai', base_url: 'https://api.example.com/v1', api_key: 'sk-new-0000' })).status).toBe(303);
    expect((await save({ provider: 'anthropic', base_url: 'https://api.example.org', clear_key: '1' })).status).toBe(303);
  });
});

describe('re-review fixes', () => {
  let model: FakeModel;
  beforeAll(async () => {
    model = await startFakeModel('openai');
  });
  afterAll(() => model.close());

  it('never puts back as pending a change approved, then reset, while a turn ran', async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, 'openai');
    const bob = await signIn(target, 'bob');
    model.script(
      { calls: [{ name: 'slotlock_delete_event', input: { event_id: 'agent:abc', expected_revision: 1 } }] },
      { text: 'Proposed.' },
    );
    await chat(target, bob, 'Cancel it');
    const actionId = /name="action" value="([^"]+)"/.exec(await page(target, bob))?.[1] as string;
    model.script(async () => {
      // While this turn runs: the member approves the change, then starts a new conversation.
      expect((await post(target, '/dashboard/assistant/approve', { action: actionId }, bob)).status).toBe(303);
      expect((await post(target, '/dashboard/assistant/reset', {}, bob)).status).toBe(303);
      return { text: 'Anything else?' };
    });
    expect((await chat(target, bob, 'And now?')).status).toBe(303);
    expect(backend.deleteEvent).toHaveBeenCalledTimes(1);
    const stored = await assistantStore.getConversation('github-org:91', 'github:12');
    expect(stored?.actions[actionId]).toBeUndefined();
    expect(await page(target, bob)).not.toContain('name="action"');
    expect((await post(target, '/dashboard/assistant/approve', { action: actionId }, bob)).status).toBe(409);
    expect(backend.deleteEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps a change approved while a turn ran as approved, not pending', async () => {
    const target = dashboard();
    await connect(target, await signIn(target, 'alice'), model, 'openai');
    const bob = await signIn(target, 'bob');
    model.script(
      { calls: [{ name: 'slotlock_delete_event', input: { event_id: 'agent:abc', expected_revision: 1 } }] },
      { text: 'Proposed.' },
    );
    await chat(target, bob, 'Cancel it');
    const actionId = /name="action" value="([^"]+)"/.exec(await page(target, bob))?.[1] as string;
    model.script(async () => {
      expect((await post(target, '/dashboard/assistant/approve', { action: actionId }, bob)).status).toBe(303);
      return { text: 'Anything else?' };
    });
    await chat(target, bob, 'And now?');
    expect((await assistantStore.getConversation('github-org:91', 'github:12'))?.actions[actionId]?.status).toBe('done');
  });
});
