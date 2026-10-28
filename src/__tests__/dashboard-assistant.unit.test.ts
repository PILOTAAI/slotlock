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
  SLOTLOCK_ASSISTANT_TOOL_USE,
  type SlotlockAssistantStore,
  createSlotlockMemoryAssistantStore,
  openSlotlockAssistantKey,
  readSlotlockAssistantBaseUrl,
  sealSlotlockAssistantKey,
  slotlockAssistantTools,
} from '../assistant.js';
import {
  type SlotlockDashboardOptions,
  createSlotlockDashboard,
  createSlotlockMemoryDashboardState,
} from '../dashboard.js';
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
    listResources: vi.fn(async () => ({ resources: [RESOURCE], next_cursor: null })),
    getFreeBusy: vi.fn(async () => ({})),
    findNextAvailable: vi.fn(async () => ({})),
    createEvent: vi.fn(async () => ({})),
    getEvent: vi.fn(async () => ({})),
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

function dashboard(overrides: Partial<SlotlockDashboardOptions['assistant']> = {}) {
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
    },
    state: createSlotlockMemoryDashboardState(),
    fetch: github,
    onError: (error) => {
      reported.push(error);
    },
    assistant: { secret: ASSISTANT_SECRET, backend, timeoutMs: 5_000, ...overrides },
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
    const context = backend.listResources.mock.calls[0]?.[0] as unknown as SlotlockAgentInvocationContext;
    expect(context.principal).toMatchObject({ tenantRef: 'github-org:91', subject: 'dashboard-assistant:bob' });
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
    expect(context.principal.subject).toBe('dashboard-assistant:bob');
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

  it('accepts an https base URL, or http on this machine only', () => {
    expect(readSlotlockAssistantBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
    expect(readSlotlockAssistantBaseUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1');
    expect(readSlotlockAssistantBaseUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
    for (const refused of ['http://models.internal/v1', 'https://user:pw@api.example.com', 'https://api.example.com/?x=1', 'ftp://x', 'nope']) {
      expect(readSlotlockAssistantBaseUrl(refused), refused).toBeNull();
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
