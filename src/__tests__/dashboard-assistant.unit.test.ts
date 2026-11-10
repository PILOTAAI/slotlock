// The dashboard assistant without a database: the model is a real HTTP server on loopback, GitHub a
// fake `fetch`.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  SlotlockAgentCalendarBackend,
  SlotlockAgentInvocationContext,
} from '../agent-server.js';
import type { SlotlockApiKeyStore } from '../api-keys.js';
import {
  SLOTLOCK_ASSISTANT_MAX_STORED_BYTES,
  SLOTLOCK_ASSISTANT_PRESETS,
  SLOTLOCK_ASSISTANT_TOOL_USE,
  type SlotlockAssistantEntry,
  type SlotlockAssistantStore,
  boundSlotlockAssistantEntries,
  pruneSlotlockAssistantActions,
  createSlotlockMemoryAssistantStore,
  listSlotlockAssistantModels,
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
  setLimits: async () => false,
};

let backend: ReturnType<typeof fakeBackend>;
let assistantStore: SlotlockAssistantStore;
let reported: unknown[];

function dashboard(
  overrides: Partial<SlotlockDashboardOptions['assistant']> = {},
  resourceOverrides: Partial<SlotlockDashboardResources> = {},
  serviceUrl?: string,
) {
  return createSlotlockDashboard({
    publicUrl: ORIGIN,
    ...(serviceUrl !== undefined ? { serviceUrl } : {}),
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
    // The read is one step, folded under the reply, in words.
    expect(html).toMatch(/<details class="steps"><summary>Read resources<\/summary>/);
    expect(html).not.toContain('Read: List calendar resources');
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
    // A card to decide on, named by what it does: the verb approves it, Decline drops it.
    expect(proposed).toContain('<div class="change">');
    expect(proposed).toMatch(/<button class="danger" type="submit" data-busy="Deleting…">Delete booking<\/button>/);
    expect(proposed).toContain('>Decline</button>');
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
    // Decided, the card folds into a receipt that says what happened.
    expect(await page(target, bob)).toMatch(/<p class="receipt ok"><span>[^<]*<\/span><span class="why">Deleted<\/span><\/p>/);

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
    expect(await page(target, bob)).toMatch(/<p class="receipt "><span>[^<]*<\/span><span class="why">Declined<\/span><\/p>/);
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
    const passedPage = await passed.text();
    expect(passedPage).toContain('called a tool correctly');
    // A success is a status, never the red alert a failure is.
    expect(passedPage).toMatch(/<p class="notice[^"]*" role="status">Connected: /);
    expect(passedPage).not.toContain('role="alert">Connected');
    expect(model.requests).toHaveLength(1);
    expect(toolsOffered(format, model.requests[0])).toEqual(['slotlock_list_resources']);
    expect(backend.listResources).not.toHaveBeenCalled();

    model.script({ text: 'I would rather chat.' });
    const failed = await post(target, '/dashboard/settings/assistant/test', {}, alice);
    expect(failed.status).toBe(502);
    expect(await failed.text()).toMatch(/role="alert">[^<]*did not call the tool/);
  });
});

describe.each(['anthropic', 'openai'] as const)('the chat over %s', (format) => {
  let model: FakeModel;
  beforeAll(async () => {
    model = await startFakeModel(format);
  });
  afterAll(() => model.close());
  beforeEach(() => {
    model.requests.length = 0;
  });

  it('renders a reply as Markdown, never as the raw asterisks it was written in', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, format);
    model.script({ text: 'There are **no vans**.\n\n- Add one\n- Or rename one\n\n<b>not markup</b>' });
    expect((await chat(target, alice, 'Find a van')).status).toBe(303);
    const html = await page(target, alice);
    expect(html).toContain('<li class="turn mine"><div class="bubble">Find a van</div></li>');
    expect(html).toContain(
      '<div class="prose"><p>There are <strong>no vans</strong>.</p><ul><li>Add one</li><li>Or rename one</li></ul><p>&lt;b&gt;not markup&lt;/b&gt;</p></div>',
    );
    expect(html).not.toContain('**no vans**');
  });

  it('lands a message sent twice on the conversation, run once, never on an error', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, format);
    model.script({ text: 'Hello.' });
    const shown = await page(target, alice);
    const csrf = /name="csrf" value="([^"]+)"/.exec(shown)?.[1] as string;
    const once = /name="once" value="([^"]+)"/.exec(shown)?.[1] as string;
    const send = () =>
      target.fetch(
        new Request(`${ORIGIN}/dashboard/assistant`, {
          method: 'POST',
          headers: { cookie: alice, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ csrf, once, message: 'hi' }).toString(),
        }),
      );
    const first = await send();
    const second = await send();
    expect(first.status).toBe(303);
    expect(second.status).toBe(303);
    expect(second.headers.get('location')).toBe('/dashboard/assistant#latest');
    expect(model.requests).toHaveLength(1);
    expect((await page(target, alice)).match(/class="bubble">hi</g)).toHaveLength(1);
  });

  it('offers to send a failed message again, saying why it failed', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, format);
    model.script({ status: 500, body: '{}' });
    await chat(target, alice, 'Find a van tomorrow');
    const html = await page(target, alice);
    const failure = /<li class="turn error" role="alert"><span>([^<]+)<\/span><form method="post" action="\/dashboard\/assistant">.*?<\/form><\/li>/.exec(html);
    expect(failure?.[1]).toContain('could not be reached');
    expect(failure?.[0]).toContain('name="message" value="Find a van tomorrow"');
    expect(failure?.[0]).toContain('>Retry</button>');
    // A later reply ends the failure: only the last one offers to send again.
    model.script({ text: 'Van 1 is free.' });
    await chat(target, alice, 'Find a van tomorrow');
    const after = await page(target, alice);
    expect(after).not.toContain('>Retry</button>');
    expect(after).toContain('<li class="turn note">');
  });

  it('streams a turn as it happens, one JSON line an event, ending with the turn as the page shows it', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, format);
    model.script({ text: 'Checking.', calls: [{ name: 'slotlock_list_resources', input: {} }] }, { text: 'You have **vehicle-1**.' });
    const shown = await page(target, alice);
    const csrf = /name="csrf" value="([^"]+)"/.exec(shown)?.[1] as string;
    const once = /name="once" value="([^"]+)"/.exec(shown)?.[1] as string;
    const response = await target.fetch(
      new Request(`${ORIGIN}/dashboard/assistant/stream`, {
        method: 'POST',
        headers: { cookie: alice, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/x-ndjson' },
        body: new URLSearchParams({ csrf, once, message: 'What do I have?' }).toString(),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson; charset=utf-8');
    expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
    expect(response.headers.get('cache-control')).toBe('no-store');
    const events = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, string>);
    expect(events.map((event) => event.t)).toEqual(['text', 'step', 'step', 'text', 'done']);
    expect(events[0]).toEqual({ t: 'text', d: 'Checking.' });
    expect(events[1]).toMatchObject({ t: 'step', s: 'run', label: 'Reading resources…' });
    expect(events[2]).toMatchObject({ t: 'step', s: 'ok', label: 'Read resources', id: events[1]?.id });
    expect(events[3]).toEqual({ t: 'text', d: 'You have **vehicle-1**.' });
    const done = events[4] as { html: string; once: string };
    // The turn as a reload would render it, from the member's message on, with a fresh form value.
    expect(done.html.startsWith('<li class="turn mine"><div class="bubble">What do I have?</div></li>')).toBe(true);
    expect(done.html).toContain('<div class="prose"><p>You have <strong>vehicle-1</strong>.</p></div>');
    expect(done.html).toContain('<summary>Read resources</summary>');
    expect(done.once).toMatch(/^[A-Za-z0-9_-]{24}\.[A-Za-z0-9_-]{43}$/);
    expect(done.once).not.toBe(once);
    // Kept, as the form's way keeps it.
    expect(await page(target, alice)).toContain('<p>You have <strong>vehicle-1</strong>.</p>');
  });

  it('answers a refused stream with one error line and a fresh form value', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, format);
    const shown = await page(target, alice);
    const csrf = /name="csrf" value="([^"]+)"/.exec(shown)?.[1] as string;
    const once = /name="once" value="([^"]+)"/.exec(shown)?.[1] as string;
    const response = await target.fetch(
      new Request(`${ORIGIN}/dashboard/assistant/stream`, {
        method: 'POST',
        headers: { cookie: alice, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ csrf, once, message: 'x'.repeat(2_001) }).toString(),
      }),
    );
    const [event, ...rest] = (await response.text()).trim().split('\n').map((line) => JSON.parse(line) as Record<string, string>);
    expect(rest).toEqual([]);
    expect(event?.t).toBe('error');
    expect(event?.html).toContain('Write a message of 1 to 2,000 characters.');
    expect(event?.once).toMatch(/\./);
    expect(model.requests).toHaveLength(0);
  });

  it('starts with the box and a few things to ask; a write only fills the box', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, format);
    const html = await page(target, alice);
    expect(html).toMatch(/<div class="assistant" data-assistant data-stream="\/dashboard\/assistant\/stream" data-page="\/dashboard\/assistant" data-empty>/);
    const chips = [...html.matchAll(/<button class="chip" type="submit" name="message" value="([^"]+)"( data-fill="[^"]+")?>([^<]+)<\/button>/g)];
    expect(chips.map((chip) => chip[3])).toEqual(['What&#39;s on today', 'Find free time', 'Book', 'Move a booking', 'Cancel a booking']);
    expect(chips.map((chip) => Boolean(chip[2]))).toEqual([false, false, true, true, true]);
    // With no resource yet, it asks in general; with one, it asks by that resource's name.
    expect(chips[1]?.[1]).toBe('What is free tomorrow morning?');
    const named = dashboard({}, { list: async () => [{ id: RESOURCE.id, externalRef: RESOURCE.external_ref, timezone: RESOURCE.timezone } as never] });
    const bob = await signIn(named, 'bob');
    await connect(named, await signIn(named, 'alice'), model, format);
    expect(await page(named, bob)).toContain('value="When is vehicle-1 free tomorrow morning?"');
    // Each one its own form, so it works with no script.
    expect(html.match(/<form method="post" action="\/dashboard\/assistant"><input type="hidden" name="csrf"/g)).toHaveLength(5);
    expect(html).toContain('<form class="composer" method="post" action="/dashboard/assistant"><input type="hidden" name="csrf"');
    expect(html).not.toContain('Ask about bookings and free time. Changes wait for your approval.');
  });

  it('folds a turn’s steps into one line, and says plainly which could not run and why', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, format);
    model.script(
      { calls: [{ name: 'slotlock_list_resources', input: {} }, { name: 'slotlock_find_available_slots', input: { nonsense: true } }] },
      { text: 'Done.' },
    );
    await chat(target, alice, 'Find a slot');
    const html = await page(target, alice);
    const steps = /<details class="steps has-bad"><summary>([^<]+)<\/summary><ul class="step-list">(.*?)<\/ul><\/details>/.exec(html);
    expect(steps?.[1]).toBe('Read resources, couldn&#39;t check availability');
    expect(steps?.[2]).toContain('<li class="step ok">Read resources</li>');
    expect(steps?.[2]).toMatch(/<li class="step bad">Couldn&#39;t check availability <span class="why">[^<]+<\/span><\/li>/);
    expect(html).not.toContain('Could not run');
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
    // The key's last four, masked, with Replace: never the key, never a placeholder that hides it.
    expect(settings).toContain('<div class="key-set"><code>•••• wxyz</code><details><summary>Replace</summary>');
    expect(settings).toMatch(/are sent to 127\.0\.0\.1:\d+\./);
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
    for (const path of ['/dashboard/settings/assistant', '/dashboard/settings/assistant/test', '/dashboard/settings/assistant/models', '/dashboard/settings/assistant/remove']) {
      const refused = await post(target, path, { provider: 'openai', base_url: model.baseUrl, model: 'x', api_key: 'stolen-key' }, bob);
      expect(refused.status, path).toBe(403);
    }
    expect(await assistantStore.getSettings('github-org:91')).toBeNull();
    const nav = await (await get(target, '/dashboard', bob)).text();
    expect(nav).toContain('href="/dashboard/assistant"');
    expect(await page(target, bob)).toContain('An admin of this organization connects a model in Settings.');
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

  it('rotates the secret: a key sealed under a previous one opens, and is sealed again under the new one', async () => {
    const NEW_SECRET = 'e8b2d4f6a1c3e5b7d9f0a2c4e6b8d1f3a5c7e9b0d2f4a6c8e1b3d5f7a9c0e2b4';
    const before = dashboard();
    await connect(before, await signIn(before, 'alice'), model, 'openai');
    const sealedBefore = (await assistantStore.getSettings('github-org:91'))?.sealedKey as string;
    await expect(openSlotlockAssistantKey(ASSISTANT_SECRET, 'github-org:91', sealedBefore)).resolves.toBe(API_KEY);

    // The secret changed with no previous one listed: the key cannot be opened, and the page says so.
    const lost = dashboard({ secret: NEW_SECRET });
    const lostAlice = await signIn(lost, 'alice');
    const refused = await chat(lost, lostAlice, 'Hello?');
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('The stored API key cannot be opened');
    expect((await assistantStore.getSettings('github-org:91'))?.sealedKey).toBe(sealedBefore);

    // Listed as previous: the key opens, the model gets it, and it is sealed again under the new one.
    const rotated = dashboard({ secret: NEW_SECRET, previousSecrets: [ASSISTANT_SECRET] });
    const alice = await signIn(rotated, 'alice');
    model.requests.length = 0;
    model.script({ text: 'Hello.' });
    expect((await chat(rotated, alice, 'Hello?')).status).toBe(303);
    expect(model.requests[0]?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(await page(rotated, alice)).toContain('Hello.');
    const resealed = await assistantStore.getSettings('github-org:91');
    expect(resealed?.sealedKey).not.toBe(sealedBefore);
    expect(resealed?.keyHint).toBe('wxyz');
    await expect(openSlotlockAssistantKey(NEW_SECRET, 'github-org:91', resealed?.sealedKey as string)).resolves.toBe(API_KEY);
    await expect(openSlotlockAssistantKey(ASSISTANT_SECRET, 'github-org:91', resealed?.sealedKey as string)).resolves.toBeNull();
    // So the new secret alone opens it from now on.
    const after = dashboard({ secret: NEW_SECRET });
    const afterAlice = await signIn(after, 'alice');
    model.script({ text: 'Still here.' });
    await chat(after, afterAlice, 'Again?');
    expect(await page(after, afterAlice)).toContain('Still here.');

    // A re-seal never overwrites a key an owner saved since the old one was read.
    expect(await assistantStore.resealKey?.('github-org:91', sealedBefore, 'v1.stale.stale')).toBe(false);
    expect((await assistantStore.getSettings('github-org:91'))?.sealedKey).toBe(resealed?.sealedKey);
    expect(reported).toEqual([]);
  });

  it('reports each message the assistant answers for usage, and none it refuses', async () => {
    const messages: string[] = [];
    const usage: string[] = [];
    const target = dashboard({
      onMessage: (tenantRef) => {
        messages.push(tenantRef);
      },
      onUsage: ({ principal, operation }) => {
        usage.push(`${principal.tenantRef} ${operation}`);
      },
    });
    const alice = await signIn(target, 'alice');
    // No model yet: refused, not counted.
    expect((await chat(target, alice, 'Hello?')).status).toBe(409);
    expect(messages).toEqual([]);
    await connect(target, alice, model, 'openai');
    model.script({ text: 'Looking.', calls: [{ name: 'slotlock_list_resources', input: {} }] }, { text: 'One van.' });
    expect((await chat(target, alice, 'What is there?')).status).toBe(303);
    expect(messages).toEqual(['github-org:91']);
    expect(usage).toEqual(['github-org:91 slotlock_list_resources']);
  });

  it('refuses previous secrets that are short, repeated, the current one, or too many', () => {
    const other = (n: number) => `${String(n)}d4f6a1c3e5b7d9f0a2c4e6b8d1f3a5c7e9b0d2f4a6c8e1b3d5f7a9c0e2b4`;
    expect(() => dashboard({ previousSecrets: [ASSISTANT_SECRET] })).toThrow('must differ');
    expect(() => dashboard({ previousSecrets: ['too-short'] })).toThrow('at least 32 bytes');
    expect(() => dashboard({ previousSecrets: [other(1), other(1)] })).toThrow('differ from each other');
    expect(() => dashboard({ previousSecrets: [other(1), other(2), other(3), other(4)] })).toThrow('at most 3');
    expect(() => dashboard({ previousSecrets: [other(1), other(2), other(3)] })).not.toThrow();
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

describe('provider presets and model lists (RFC 0003 A4)', () => {
  let model: FakeModel;
  beforeAll(async () => {
    model = await startFakeModel('openai');
  });
  afterAll(() => model.close());
  beforeEach(() => {
    model.requests.length = 0;
    model.models(['your-model']);
  });

  const loadModels = (target: Dashboard, cookie: string, fields: Record<string, string>) =>
    post(target, '/dashboard/settings/assistant/models', { provider: 'openai', base_url: model.baseUrl, model: '', api_key: '', ...fields }, cookie);

  it('offers presets whose URLs saving accepts, each with its API', () => {
    expect(SLOTLOCK_ASSISTANT_PRESETS.map((preset) => preset.id)).toEqual([
      'anthropic', 'openai', 'openrouter', 'google', 'mistral', 'groq', 'together', 'custom',
    ]);
    for (const preset of SLOTLOCK_ASSISTANT_PRESETS) {
      if (preset.id === 'custom') {
        expect(preset.baseUrl).toBe('');
        continue;
      }
      expect(readSlotlockAssistantBaseUrl(preset.baseUrl), preset.id).toEqual({ ok: true, url: preset.baseUrl });
      expect(preset.provider, preset.id).toBe(preset.id === 'anthropic' ? 'anthropic' : 'openai');
    }
  });

  it('fills the form from a preset and saves nothing; an unknown preset fills nothing', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    const settings = await (await get(target, '/dashboard/settings', alice)).text();
    // One tile a provider, in the form Save sends.
    expect(settings).toContain('<label class="tile"><input type="radio" name="preset" value="openrouter">');
    const filled = await (await get(target, '/dashboard/settings?preset=openrouter', alice)).text();
    expect(filled).toContain('<input type="radio" name="preset" value="openrouter" checked>');
    expect(filled).toContain('name="base_url" maxlength="2048" value="https://openrouter.ai/api/v1"');
    expect(filled).toContain('<input type="radio" name="provider" value="openai" checked>');
    const anthropic = await (await get(target, '/dashboard/settings?preset=anthropic', alice)).text();
    expect(anthropic).toContain('value="https://api.anthropic.com"');
    expect(anthropic).toContain('<input type="radio" name="preset" value="anthropic" checked>');
    const unknown = await (await get(target, '/dashboard/settings?preset=%3Cscript%3E', alice)).text();
    expect(unknown).toContain('name="base_url" maxlength="2048" value=""');
    expect(unknown).not.toContain('<script>');
    expect(await assistantStore.getSettings('github-org:91')).toBeNull();
  });

  it("saves a named provider's own URL and format, whatever a hidden Custom field still holds", async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    const saved = await post(
      target,
      '/dashboard/settings/assistant',
      { preset: 'openrouter', provider: 'anthropic', base_url: 'https://elsewhere.example/v1', model: 'anthropic/claude-sonnet-4.6', api_key: API_KEY },
      alice,
    );
    expect(saved.status).toBe(303);
    expect(await assistantStore.getSettings('github-org:91')).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
    });
    const page = await (await get(target, '/dashboard/settings', alice)).text();
    expect(page).toContain('<input type="radio" name="preset" value="openrouter" checked>');
    expect(page).toMatch(/<div class="status-name"><strong>OpenRouter<\/strong><code>anthropic\/claude-sonnet-4\.6<\/code><\/div><span class="badge ok">Set up<\/span>/);
    expect(page).toContain('are sent to OpenRouter.');
  });

  it('shows a connection test in the status card: Connected, or Failing with why', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, 'openai');
    model.script({ calls: [{ name: 'slotlock_list_resources', input: {} }] });
    const passed = await (await post(target, '/dashboard/settings/assistant/test', {}, alice)).text();
    expect(passed).toMatch(/<span class="badge ok">Connected<\/span>.*?<p class="notice done" role="status">Connected: /s);
    model.script({ status: 401, body: '{}' });
    const failed = await (await post(target, '/dashboard/settings/assistant/test', {}, alice)).text();
    expect(failed).toMatch(/<span class="badge bad">Failing<\/span>.*?<p class="notice" role="alert">[^<]*refused the API key/s);
  });

  it('gives each Settings section its own page, marked in the section list', async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    for (const [path, label] of [
      ['/dashboard/settings', 'Assistant'],
      ['/dashboard/settings/endpoints', 'Endpoints'],
      ['/dashboard/settings/hours', 'Hours'],
      ['/dashboard/settings/account', 'Account'],
    ] as const) {
      const html = await (await get(target, path, alice)).text();
      expect(html, path).toMatch(new RegExp(`<a href="${path}" aria-current="page">${label}`));
      expect(html.match(/aria-current="page"/g)?.length, path).toBe(2);
    }
  });

  it("lists the provider's models for the Model field, with the saved key only for its own provider and URL", async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    await connect(target, alice, model, 'openai');
    model.models(['b-model', 'a-model', 'a-model', 'not a model name', 'c/model:latest']);
    const listed = await loadModels(target, alice, {});
    expect(listed.status).toBe(200);
    const html = await listed.text();
    expect(html).toContain('3 models listed: choose one for Model, then Save.');
    expect(html).toContain('list="assistant-models"');
    const options = [...html.matchAll(/<option value="([^"]+)"><\/option>/g)].map((match) => match[1]);
    expect(options).toEqual(['a-model', 'b-model', 'c/model:latest']);
    expect(html).not.toContain(API_KEY);
    expect(model.requests.at(-1)).toMatchObject({ path: '/v1/models', headers: { authorization: `Bearer ${API_KEY}` } });

    // Another URL for the same server: the saved key is not sent there.
    const elsewhere = model.baseUrl.replace('127.0.0.1', 'localhost');
    expect((await loadModels(target, alice, { base_url: elsewhere })).status).toBe(200);
    expect(model.requests.at(-1)?.headers.authorization).toBeUndefined();
    // Another provider: not sent either. A key typed in the form is sent, and asked for again on Save.
    expect((await loadModels(target, alice, { provider: 'anthropic' })).status).toBe(502);
    expect(model.requests.at(-1)?.headers['x-api-key']).toBeUndefined();
    const typed = await loadModels(target, alice, { base_url: elsewhere, api_key: 'sk-typed-key-0000' });
    expect(await typed.text()).toContain('Enter the API key again when you save.');
    expect(model.requests.at(-1)?.headers.authorization).toBe('Bearer sk-typed-key-0000');

    // Nothing was saved by listing.
    expect(await assistantStore.getSettings('github-org:91')).toMatchObject({ baseUrl: model.baseUrl, model: 'your-model', keyHint: 'wxyz' });
  });

  it("keeps the form's values and reads a refused list plainly, never with the key or the provider's body", async () => {
    const target = dashboard();
    const alice = await signIn(target, 'alice');
    model.models({ status: 401, body: '{"error":"invalid key sk-leaked-SECRET"}' });
    const refused = await loadModels(target, alice, { model: 'kept-model', api_key: API_KEY });
    expect(refused.status).toBe(502);
    const html = await refused.text();
    expect(html).toContain('The model provider refused the API key.');
    expect(html).toContain('value="kept-model"');
    expect(html).not.toContain(API_KEY);
    expect(html).not.toContain('sk-leaked-SECRET');
    model.models([]);
    const none = await loadModels(target, alice, { api_key: API_KEY });
    expect(await none.text()).toContain('The provider listed no models. Type the model name.');
    expect(await assistantStore.getSettings('github-org:91')).toBeNull();
  });

  it('checks the URL as saving does, and counts each list as a message', async () => {
    const closed = dashboard({ privateUrls: false });
    const alice = await signIn(closed, 'alice');
    const refused = await loadModels(closed, alice, {});
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain('local or private network address');
    const invalid = await loadModels(closed, alice, { base_url: 'http://models.example.com/v1' });
    expect(invalid.status).toBe(400);
    expect((await loadModels(closed, alice, { provider: 'other' })).status).toBe(400);
    expect(model.requests).toHaveLength(0);

    const limited = dashboard({ rate: { perSecond: 1 / 60, burst: 2 } });
    const owner = await signIn(limited, 'alice');
    expect((await loadModels(limited, owner, {})).status).toBe(200);
    expect((await loadModels(limited, owner, {})).status).toBe(200);
    expect((await loadModels(limited, owner, {})).status).toBe(429);
    expect(model.requests).toHaveLength(2);
  });

  it('asks the Anthropic API for its models with its version and the key, never following a redirect', async () => {
    const anthropic = await startFakeModel('anthropic');
    try {
      anthropic.models(['claude-model-b', 'claude-model-a']);
      const listed = await listSlotlockAssistantModels({
        provider: 'anthropic',
        baseUrl: anthropic.baseUrl,
        apiKey: API_KEY,
        fetch,
        timeoutMs: 5_000,
      });
      expect(listed).toEqual(['claude-model-a', 'claude-model-b']);
      expect(anthropic.requests[0]).toMatchObject({
        path: '/v1/models?limit=1000',
        headers: { 'x-api-key': API_KEY, 'anthropic-version': expect.any(String) },
      });
      expect(anthropic.requests[0]?.headers.authorization).toBeUndefined();
    } finally {
      await anthropic.close();
    }
    // Together answers a bare array, not { data: [...] }; anything else is not a list.
    const bare = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json([
        { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', object: 'model', type: 'chat' },
        { id: 'mistralai/Mixtral-8x7B-Instruct-v0.1', object: 'model', type: 'chat' },
      ]),
    );
    expect(
      await listSlotlockAssistantModels({ provider: 'openai', baseUrl: 'https://api.together.xyz/v1', apiKey: API_KEY, fetch: bare, timeoutMs: 5_000 }),
    ).toEqual(['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'mistralai/Mixtral-8x7B-Instruct-v0.1']);
    expect(bare.mock.calls[0]?.[0]).toBe('https://api.together.xyz/v1/models');
    for (const answer of [{ models: [] }, 'models', null]) {
      await expect(
        listSlotlockAssistantModels({ provider: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: API_KEY, fetch: vi.fn(async () => Response.json(answer)), timeoutMs: 5_000 }),
        JSON.stringify(answer),
      ).rejects.toMatchObject({ reason: 'bad_answer' });
    }
    const redirecting = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example.com/' } }));
    await expect(
      listSlotlockAssistantModels({ provider: 'openai', baseUrl: 'https://api.example.com/v1', apiKey: API_KEY, fetch: redirecting, timeoutMs: 5_000 }),
    ).rejects.toMatchObject({ reason: 'unavailable' });
    expect(redirecting).toHaveBeenCalledTimes(1);
    expect(redirecting.mock.calls[0]).toMatchObject([expect.any(String), { redirect: 'manual' }]);
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
    expect(theirs).toContain('Connect a model to use the assistant.');
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

  it("refuses the dashboard's own host or the server's as the model URL, when saved and when called", async () => {
    const target = dashboard({}, {}, 'https://slotlock-api.example.com');
    const alice = await signIn(target, 'alice');
    for (const url of ['https://slotlock.example.com/v1', 'https://SLOTLOCK.example.com:8443/v1', 'https://slotlock-api.example.com']) {
      const refused = await post(target, '/dashboard/settings/assistant', { provider: 'openai', base_url: url, model: 'your-model', api_key: API_KEY }, alice);
      expect(refused.status, url).toBe(400);
      expect(await refused.text(), url).toContain('this Slotlock deployment’s own address');
    }
    expect(await assistantStore.getSettings('github-org:91')).toBeNull();
    // Saved where the API was elsewhere, then served from there: refused before any request.
    const before = dashboard({}, {}, 'https://elsewhere.example.com');
    const saved = await post(before, '/dashboard/settings/assistant', { provider: 'openai', base_url: 'https://slotlock-api.example.com/v1', model: 'your-model', api_key: API_KEY }, await signIn(before, 'alice'));
    expect(saved.status).toBe(303);
    const bob = await signIn(target, 'bob');
    const refused = await chat(target, bob, 'hello');
    expect(refused.status).toBe(409);
    expect(await refused.text()).toContain('this Slotlock deployment’s own address');
    expect(model.requests).toHaveLength(0);
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
    expect(html).toContain('<div class="change">');
    expect(html).toContain('>Book</button>');
    // When, in the time zone the change gives.
    expect(html).toContain('<dt>When</dt><dd>Tue 2 Mar, 10:00–11:00 Europe/London</dd>');
    for (const { address } of attendees) expect(html, address).toContain(address);
    expect(html).toContain('END-OF-DESCRIPTION');
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
    const summary = /<p class="change-title">([^<]+)<\/p>/.exec(html)?.[1] ?? '';
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

  // The Worker caps agent calls per request and per tenant.
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
