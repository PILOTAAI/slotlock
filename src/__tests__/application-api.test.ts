// The application API: what an application does over REST that the store does in process. It is
// served only with `rest`, needs the admin scope, is never an MCP tool or A2A skill, and the OpenAPI
// document describes it from the same schemas the server validates with.
import { Validator } from '@seriousme/openapi-schema-validator';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SlotlockAgentCalendarBackend,
  SlotlockAgentOperationError,
  type SlotlockAgentServerOptions,
  createSlotlockAgentServer,
  slotlockAgentTools,
} from '../agent-server.js';
import {
  SLOTLOCK_APPLICATION_OPERATIONS,
  SLOTLOCK_APPLICATION_SCOPE,
  type SlotlockApplicationBackend,
  isSlotlockApplicationOperation,
  slotlockApplicationOperation,
} from '../application-api.js';
import {
  SLOTLOCK_APPLICATION_REST_ROUTES,
  SLOTLOCK_REST_ROUTES,
  matchSlotlockRestRoute,
} from '../rest-api.js';

const BASE = 'https://calendar.example.com/slotlock';
const RESOURCE_ID = '0f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b';
const HOLD_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const EVENT_ID = '3d6f0a2b-8c4e-4f1a-9b7d-5e2c8a1f4b6d';
const RESOURCE = {
  id: RESOURCE_ID,
  external_ref: 'vehicle-42',
  timezone: 'Europe/London',
  availability: null,
  booking_rules: null,
  visibility: 'shared',
  archived_at: null,
  pool: null,
};
const HOLD = {
  id: HOLD_ID,
  resource_id: RESOURCE_ID,
  start: '2027-03-29T09:00:00.000Z',
  end: '2027-03-29T10:00:00.000Z',
  expires_at: '2027-03-29T08:10:00.000Z',
  source: 'checkout',
};
const TENANT_EVENT = {
  id: EVENT_ID,
  event_ref: 'agent:handover',
  owner_ref: `agent:${'a'.repeat(64)}`,
  resource_id: RESOURCE_ID,
  starts_at: '2027-03-02T09:00:00.000Z',
  ends_at: '2027-03-02T10:00:00.000Z',
  timezone: 'Europe/London',
  title: 'Handover',
  description: null,
  location: null,
  organizer: null,
  attendees: [],
  reminders: [],
  status: 'confirmed',
  transparency: 'opaque',
  sequence: 2,
  revision: 2,
  recurrence_rule: null,
  recurrence_exceptions: [],
  recurrence_id: null,
};
const RESERVATION = {
  id: HOLD_ID,
  resource_id: RESOURCE_ID,
  reservation_ref: 'booking-BK-42',
  start: '2027-03-29T09:00:00.000Z',
  end: '2027-03-31T09:00:00.000Z',
  buffer_after_minutes: 60,
  revision: 1,
  source: null,
};

const agentBackend = {
  listResources: vi.fn(),
  getFreeBusy: vi.fn(),
  findNextAvailable: vi.fn(),
  listEvents: vi.fn(),
  getEvent: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvent: vi.fn(),
} as unknown as SlotlockAgentCalendarBackend;

const backend = {
  createResource: vi.fn(),
  getResource: vi.fn(),
  archiveResource: vi.fn(),
  restoreResource: vi.fn(),
  deleteResource: vi.fn(),
  listBusy: vi.fn(),
  setResourceAvailability: vi.fn(),
  setTenantAvailability: vi.fn(),
  acquireHold: vi.fn(),
  getHold: vi.fn(),
  listHolds: vi.fn(),
  confirmHold: vi.fn(),
  releaseHold: vi.fn(),
  getReservation: vi.fn(),
  listReservations: vi.fn(),
  putReservation: vi.fn(),
  cancelReservation: vi.fn(),
  recordCoverage: vi.fn(),
  listTenantEvents: vi.fn(),
  getTenantEvent: vi.fn(),
  cancelTenantEvent: vi.fn(),
  getTenant: vi.fn(),
  eraseTenant: vi.fn(),
  runMaintenance: vi.fn(),
  setResourceBookingRules: vi.fn(),
  listChanges: vi.fn(),
  setResourcePool: vi.fn(),
  listPools: vi.fn(),
  createWebhook: vi.fn(),
  listWebhooks: vi.fn(),
  deleteWebhook: vi.fn(),
  enableWebhook: vi.fn(),
} satisfies Record<keyof SlotlockApplicationBackend, ReturnType<typeof vi.fn>>;
const authorizeApplication = vi.fn();
const consumeRateLimit = vi.fn();
const onError = vi.fn();
const onEvent = vi.fn();

const admin = { subject: 'app-1', tenantRef: 'tenant-a', scopes: ['read', 'write', 'admin'] };
const agent = { subject: 'agent-1', tenantRef: 'tenant-a', scopes: ['read', 'write'] };
const operator = { subject: 'operator', tenantRef: 'tenant-a' };

/** Options to change; `undefined` leaves an option out. */
type Overrides = { [Name in keyof SlotlockAgentServerOptions]?: SlotlockAgentServerOptions[Name] | undefined };

function buildServer(overrides: Overrides = {}) {
  return createSlotlockAgentServer({
    publicBaseUrl: BASE,
    backend: agentBackend,
    authenticate: async (request) => {
      const token = request.headers.get('authorization');
      if (token === 'Bearer admin') return admin;
      if (token === 'Bearer agent') return agent;
      if (token === 'Bearer operator') return operator;
      return null;
    },
    authorize: async () => true,
    health: async () => ({ ready: true, checks: [] }),
    consumeRateLimit,
    onError,
    onEvent,
    rest: true,
    application: {
      backend: backend as unknown as SlotlockApplicationBackend,
      authorize: authorizeApplication,
    },
    ...overrides,
  } as SlotlockAgentServerOptions);
}

function call(
  method: string,
  path: string,
  init: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
): Request {
  const { body, token = 'admin', headers = {} } = init;
  return new Request(`${BASE}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

/** A concrete path for a route: each `{name}` replaced by the operation example's value. */
function examplePath(path: string, example: Record<string, unknown>): string {
  return path.replace(/\{(\w+)\}/g, (_match, name: string) =>
    encodeURIComponent(String(example[name])),
  );
}

/** The REST request that carries an operation's example. */
function exampleRequest(name: string, token = 'admin'): Request {
  const definition = slotlockApplicationOperation(
    name as Parameters<typeof slotlockApplicationOperation>[0],
  );
  const pathNames = [...definition.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string);
  const rest = Object.fromEntries(
    Object.entries(definition.example).filter(([key]) => !pathNames.includes(key)),
  );
  const path = examplePath(definition.path, definition.example);
  if (definition.method === 'GET' || definition.method === 'DELETE') {
    const query = new URLSearchParams(
      Object.entries(rest).map(([key, value]) => [key, String(value)]),
    ).toString();
    return call(definition.method, query ? `${path}?${query}` : path, { token });
  }
  return call(definition.method, path, { body: rest, token });
}

const WEBHOOK = {
  id: '9b2f4c1e-6d3a-4e8b-a1c7-5f0e2d4b6a8c',
  url: 'https://example.com/slotlock-webhook',
  event_types: null,
  created_at: '2027-03-01T00:00:00.000Z',
  attempts: 0,
  failing_since: null,
  last_status: null,
  last_error: null,
  disabled_at: null,
  disabled_reason: null,
};

const OUTPUTS: Record<keyof SlotlockApplicationBackend, Record<string, unknown>> = {
  createResource: { resource: RESOURCE },
  getResource: { resource: RESOURCE },
  archiveResource: { resource: { ...RESOURCE, archived_at: '2027-03-01T00:00:00.000Z' } },
  restoreResource: { resource: RESOURCE },
  deleteResource: { deleted: true },
  listBusy: { busy: [{ start: '2027-03-29T09:00:00.000Z', end: '2027-03-29T10:00:00.000Z' }] },
  setResourceAvailability: { resource: RESOURCE },
  setTenantAvailability: { resources_updated: 3 },
  setResourceBookingRules: { resource: { ...RESOURCE, booking_rules: { min_notice_minutes: 120 } } },
  acquireHold: { hold: HOLD },
  getHold: { hold: HOLD },
  listHolds: { holds: [HOLD], next_cursor: null },
  confirmHold: { reservation: RESERVATION },
  releaseHold: { released: true },
  getReservation: { reservation: RESERVATION },
  listReservations: { reservations: [RESERVATION], next_cursor: 'eyJzdGFydCI6IjIwMjcifQ' },
  putReservation: { reservation: RESERVATION, replayed: false },
  cancelReservation: { cancelled: true, revision: 2 },
  recordCoverage: { revision: 7, replayed: false },
  listTenantEvents: { events: [TENANT_EVENT], next_cursor: null },
  getTenantEvent: { event: TENANT_EVENT },
  cancelTenantEvent: { event_id: EVENT_ID, revision: 3, cancelled: true, replayed: false },
  getTenant: { tenant: { ref: 'tenant-a', suspended: false } },
  eraseTenant: { total: 12, rows: { resources: 2, reservations: 10 } },
  runMaintenance: { extended: 0, conflicts: 0, refused: 0, pruned: 0, capped: false },
  listChanges: {
    changes: [
      {
        specversion: '1.0',
        id: 'msg_1',
        source: '/slotlock/resources/0f8b6c1e-2d4a-4c7e-9b1a-3e5f7a9c2d4b',
        type: 'io.pylota.slotlock.reservation.created',
        subject: 'BK-42',
        time: '2027-03-01T09:00:00.000Z',
        datacontenttype: 'application/json',
        data: { reference: 'BK-42' },
      },
    ],
    next_cursor: 'MToxOjE6MA',
  },
  createWebhook: { webhook: WEBHOOK, secret: `whsec_${'A'.repeat(43)}=` },
  listWebhooks: { webhooks: [WEBHOOK] },
  setResourcePool: { resource: { ...RESOURCE, pool: 'van' } },
  listPools: { pools: [{ pool: 'van', capacity: 5 }] },
  deleteWebhook: { deleted: true },
  enableWebhook: { webhook: WEBHOOK },
};

beforeEach(() => {
  vi.clearAllMocks();
  authorizeApplication.mockResolvedValue(true);
  consumeRateLimit.mockResolvedValue(true);
  for (const [method, output] of Object.entries(OUTPUTS)) {
    backend[method as keyof typeof backend].mockResolvedValue(output);
  }
});

describe('the application operations', () => {
  it('have unique names, none an agent tool, each with an example its own schema accepts', () => {
    const names = SLOTLOCK_APPLICATION_OPERATIONS.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    const tools = new Set<string>(slotlockAgentTools().map(({ name }) => name));
    for (const definition of SLOTLOCK_APPLICATION_OPERATIONS) {
      expect(tools.has(definition.name)).toBe(false);
      expect(isSlotlockApplicationOperation(definition.name)).toBe(true);
      expect(slotlockApplicationOperation(definition.name)).toBe(definition);
      const parsed = definition.input.safeParse(definition.example);
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(definition.output.safeParse(OUTPUTS[definition.invoke]).success).toBe(true);
      // Every path parameter is an input of the same name.
      for (const [, name] of definition.path.matchAll(/\{(\w+)\}/g)) {
        expect(definition.example).toHaveProperty(name as string);
      }
    }
    for (const name of [...tools, 'slotlock_unknown', '', 42, null, 'toString'] as unknown[]) {
      expect(isSlotlockApplicationOperation(name)).toBe(false);
    }
  });

  it('never share a method and path with each other or an agent route', () => {
    const routes = [...SLOTLOCK_REST_ROUTES, ...SLOTLOCK_APPLICATION_REST_ROUTES];
    for (const route of routes) {
      const concrete = route.path.replace(/\{(\w+)\}/g, 'x');
      const fits = routes.filter(
        (other) =>
          other.method === route.method &&
          matchSlotlockRestRoute(route.method, concrete, [other]) !== null &&
          'route' in (matchSlotlockRestRoute(route.method, concrete, [other]) ?? {}),
      );
      expect(fits).toEqual([route]);
    }
  });

  it('refuse a span that ends before it starts or lasts past 3,660 days, and identities with control characters', () => {
    const hold = slotlockApplicationOperation('slotlock_acquire_hold');
    const base = hold.example;
    expect(hold.input.safeParse({ ...base, end: base.start }).success).toBe(false);
    const start = Date.parse('2027-01-01T00:00:00Z');
    const longest = new Date(start + 3_660 * 86_400_000).toISOString();
    const tooLong = new Date(start + 3_660 * 86_400_000 + 1).toISOString();
    expect(hold.input.safeParse({ ...base, start: '2027-01-01T00:00:00Z', end: longest }).success).toBe(true);
    expect(hold.input.safeParse({ ...base, start: '2027-01-01T00:00:00Z', end: tooLong }).success).toBe(false);
    expect(hold.input.safeParse({ ...base, ttl_seconds: 0 }).success).toBe(false);
    expect(hold.input.safeParse({ ...base, ttl_seconds: 604_801 }).success).toBe(false);
    expect(hold.input.safeParse({ ...base, source: '   ' }).success).toBe(false);
    const put = slotlockApplicationOperation('slotlock_put_reservation');
    for (const reservation_ref of ['', '   ', 'a\nb', 'é'.repeat(251)]) {
      expect(put.input.safeParse({ ...put.example, reservation_ref }).success).toBe(false);
    }
    expect(put.input.safeParse({ ...put.example, reservation_ref: 'é'.repeat(250) }).success).toBe(true);
    expect(put.input.safeParse({ ...put.example, revision: 0 }).success).toBe(false);
    expect(put.input.safeParse({ ...put.example, buffer_after_minutes: 43_201 }).success).toBe(false);
    expect(put.input.parse({ ...put.example, buffer_after_minutes: undefined })).toMatchObject({
      buffer_after_minutes: 0,
    });
    const create = slotlockApplicationOperation('slotlock_create_resource');
    expect(create.input.parse({ external_ref: 'van-1' })).toEqual({ external_ref: 'van-1', timezone: 'UTC' });
    expect(create.input.safeParse({ external_ref: 'van-1', tenant_ref: 'other' }).success).toBe(false);
  });
});

describe('the application API over REST', () => {
  it('runs each operation for an admin key with the input its schema parsed, in the key\'s tenant', async () => {
    const server = buildServer();
    for (const definition of SLOTLOCK_APPLICATION_OPERATIONS) {
      const response = await server.fetch(exampleRequest(definition.name));
      expect({ name: definition.name, status: response.status }).toEqual({
        name: definition.name,
        status: 200,
      });
      expect(await response.json()).toEqual(OUTPUTS[definition.invoke]);
      const invoked = backend[definition.invoke];
      expect(invoked).toHaveBeenCalledTimes(1);
      const [context, input] = invoked.mock.calls[0] as [
        { principal: unknown; operation: string; signal: AbortSignal },
        Record<string, unknown>,
      ];
      expect(context.principal).toEqual(admin);
      expect(context.operation).toBe(definition.name);
      expect(context.signal).toBeInstanceOf(AbortSignal);
      expect(input).toEqual(definition.input.parse(definition.example));
      expect(authorizeApplication).toHaveBeenLastCalledWith({
        principal: admin,
        operation: definition.name,
        input,
      });
    }
    // Each call is charged once, as one protocol request; no agent tool ran.
    expect(consumeRateLimit).toHaveBeenCalledTimes(SLOTLOCK_APPLICATION_OPERATIONS.length);
    for (const [args] of consumeRateLimit.mock.calls) {
      expect(args).toEqual({ principal: admin, operation: 'protocol' });
    }
    for (const method of Object.values(agentBackend)) expect(method).not.toHaveBeenCalled();
  });

  it('refuses a key without the admin scope before reading the arguments', async () => {
    const server = buildServer();
    for (const definition of SLOTLOCK_APPLICATION_OPERATIONS) {
      const response = await server.fetch(exampleRequest(definition.name, 'agent'));
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('forbidden');
    }
    expect(authorizeApplication).not.toHaveBeenCalled();
    for (const method of Object.values(backend)) expect(method).not.toHaveBeenCalled();
    expect(SLOTLOCK_APPLICATION_SCOPE).toBe('admin');
  });

  it('leaves a principal without scopes to `authorize`, which can refuse it', async () => {
    authorizeApplication.mockResolvedValue(false);
    const refused = await buildServer().fetch(exampleRequest('slotlock_get_resource', 'operator'));
    expect(refused.status).toBe(403);
    expect(await errorCode(refused)).toBe('forbidden');
    expect(authorizeApplication).toHaveBeenCalledWith({
      principal: operator,
      operation: 'slotlock_get_resource',
      input: { resource_id: RESOURCE_ID },
    });
    expect(backend.getResource).not.toHaveBeenCalled();

    authorizeApplication.mockResolvedValue(true);
    const allowed = await buildServer().fetch(exampleRequest('slotlock_get_resource', 'operator'));
    expect(allowed.status).toBe(200);
  });

  it('answers 401 without a credential and 429 when the rate limit is spent, before anything runs', async () => {
    const server = buildServer();
    const anonymous = await server.fetch(exampleRequest('slotlock_run_maintenance', ''));
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('www-authenticate')).toBe('Bearer realm="slotlock"');
    consumeRateLimit.mockResolvedValue(false);
    const limited = await server.fetch(exampleRequest('slotlock_run_maintenance'));
    expect(limited.status).toBe(429);
    expect(await errorCode(limited)).toBe('rate_limited');
    expect(backend.runMaintenance).not.toHaveBeenCalled();
  });

  it('refuses arguments its schema does not accept, a path the body contradicts, and a body that is not JSON', async () => {
    const server = buildServer();
    const cases: Request[] = [
      call('POST', '/v1/holds', { body: { resource_id: RESOURCE_ID, start: 'tomorrow', end: 'later', ttl_seconds: 60 } }),
      call('POST', '/v1/resources', { body: { external_ref: 'van', tenant_ref: 'tenant-b' } }),
      call('PUT', `/v1/resources/${RESOURCE_ID}/availability`, {
        body: { resource_id: 'another', rules: null },
      }),
      call('PUT', `/v1/resources/${RESOURCE_ID}/availability`, {
        body: { rules: [{ rrule: 'FREQ=WEEKLY;BYDAY=MO', start_minutes: 1_440, duration_minutes: 60 }] },
      }),
      call('DELETE', '/v1/reservations/booking-1?revision=two'),
      call('DELETE', '/v1/reservations/booking-1'),
      call('GET', `/v1/resources/${RESOURCE_ID}?resource_id=another`),
      call('POST', '/v1/maintenance', { body: { tenant_ref: 'tenant-b' } }),
      call('POST', '/v1/maintenance', { body: [] }),
      call('PUT', '/v1/reservations/%E0%A4%A', { body: {} }),
    ];
    for (const request of cases) {
      const response = await server.fetch(request);
      expect({ url: request.url, status: response.status }).toEqual({ url: request.url, status: 400 });
      expect(await errorCode(response)).toBe('invalid_arguments');
    }
    const notJson = await server.fetch(call('POST', '/v1/maintenance', { body: '{' }));
    expect(notJson.status).toBe(400);
    expect(await errorCode(notJson)).toBe('invalid_json');
    const wrongType = await server.fetch(
      new Request(`${BASE}/v1/maintenance`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin', 'Content-Type': 'text/plain' },
        body: '{}',
      }),
    );
    expect(wrongType.status).toBe(415);
    for (const method of Object.values(backend)) expect(method).not.toHaveBeenCalled();
  });

  it('takes a retry identity from the Idempotency-Key header where the operation keeps one', async () => {
    const server = buildServer();
    const hold = {
      resource_id: RESOURCE_ID,
      start: '2027-03-29T09:00:00Z',
      end: '2027-03-29T10:00:00Z',
      ttl_seconds: 600,
    };
    const keyed = await server.fetch(
      call('POST', '/v1/holds', { body: hold, headers: { 'Idempotency-Key': 'checkout-1' } }),
    );
    expect(keyed.status).toBe(200);
    expect(backend.acquireHold.mock.calls[0]?.[1]).toEqual({ ...hold, idempotency_key: 'checkout-1' });
    // The same key in the header and the body is one key; two different ones are refused.
    const both = await server.fetch(
      call('POST', '/v1/holds', {
        body: { ...hold, idempotency_key: 'checkout-1' },
        headers: { 'Idempotency-Key': 'checkout-1' },
      }),
    );
    expect(both.status).toBe(200);
    const differing = await server.fetch(
      call('POST', '/v1/holds', {
        body: { ...hold, idempotency_key: 'checkout-1' },
        headers: { 'Idempotency-Key': 'checkout-2' },
      }),
    );
    expect(differing.status).toBe(400);
    expect(await errorCode(differing)).toBe('invalid_arguments');
    // A key the store could not keep (control characters, past 500 bytes) is refused like the field.
    const tooLong = await server.fetch(
      call('POST', '/v1/holds', { body: hold, headers: { 'Idempotency-Key': 'k'.repeat(501) } }),
    );
    expect(tooLong.status).toBe(400);
    // An operation that keeps no key refuses one rather than dropping it.
    const unkept = await server.fetch(
      call('POST', `/v1/holds/${HOLD_ID}/confirm`, { body: {}, headers: { 'Idempotency-Key': 'c-1' } }),
    );
    expect(unkept.status).toBe(400);
    expect(await errorCode(unkept)).toBe('idempotency_key_not_supported');
    expect(backend.acquireHold).toHaveBeenCalledTimes(2);
    expect(backend.confirmHold).not.toHaveBeenCalled();

    // Cancelling any event of the tenant needs a key, from the query or the header.
    const unkeyed = await server.fetch(call('DELETE', `/v1/tenant/events/${EVENT_ID}?expected_revision=2`));
    expect(unkeyed.status).toBe(400);
    expect(await errorCode(unkeyed)).toBe('idempotency_key_required');
    const headed = await server.fetch(
      call('DELETE', `/v1/tenant/events/${EVENT_ID}?expected_revision=2`, {
        headers: { 'Idempotency-Key': 'cancel-1' },
      }),
    );
    expect(headed.status).toBe(200);
    expect(backend.cancelTenantEvent.mock.calls[0]?.[1]).toEqual({
      event_id: EVENT_ID,
      expected_revision: 2,
      idempotency_key: 'cancel-1',
    });
  });

  it('documents the Idempotency-Key header on exactly the operations that keep a key', async () => {
    const document = (await (await buildServer().fetch(call('GET', '/openapi.json', { token: null }))).json()) as {
      paths: Record<string, Record<string, { operationId: string; parameters?: { name: string; in: string }[] }>>;
    };
    const headed = Object.values(document.paths)
      .flatMap((methods) => Object.values(methods))
      .filter((operation) => operation.parameters?.some((parameter) => parameter.in === 'header'))
      .map((operation) => operation.operationId)
      .sort();
    expect(headed).toEqual([
      'slotlock_acquire_hold',
      'slotlock_book_pool',
      'slotlock_book_together',
      'slotlock_cancel_tenant_event',
      'slotlock_create_event',
      'slotlock_delete_event',
      'slotlock_hold_slots',
      'slotlock_update_event',
    ]);
  });

  it('takes a visibility only at creation, and erases a tenant only with its reference', () => {
    const create = slotlockApplicationOperation('slotlock_create_resource');
    expect(create.input.parse({ external_ref: 'van-1', visibility: 'private' })).toEqual({
      external_ref: 'van-1',
      timezone: 'UTC',
      visibility: 'private',
    });
    // Left out, it is not defaulted: an existing resource is then answered as it is.
    expect(create.input.parse({ external_ref: 'van-1' })).not.toHaveProperty('visibility');
    expect(create.input.safeParse({ external_ref: 'van-1', visibility: 'hidden' }).success).toBe(false);
    const erase = slotlockApplicationOperation('slotlock_erase_tenant');
    expect(erase.input.safeParse({}).success).toBe(false);
    expect(erase.input.safeParse({ confirm_tenant_ref: '' }).success).toBe(false);
    expect(erase.input.safeParse({ confirm_tenant_ref: 'tenant-a', yes: true }).success).toBe(false);
    for (const name of ['slotlock_list_busy', 'slotlock_list_reservations', 'slotlock_list_tenant_events'] as const) {
      const list = slotlockApplicationOperation(name);
      const window = { start: '2027-01-01T00:00:00Z', end: '2028-01-03T00:00:00Z' };
      expect(list.input.safeParse({ ...list.example, ...window }).success).toBe(true);
      expect(list.input.safeParse({ ...list.example, ...window, end: '2028-01-03T00:00:00.001Z' }).success).toBe(false);
      expect(list.input.safeParse({ ...list.example, end: list.example.start }).success).toBe(false);
    }
    const holds = slotlockApplicationOperation('slotlock_list_holds');
    expect(holds.input.parse({ resource_id: RESOURCE_ID })).toEqual({ resource_id: RESOURCE_ID, limit: 50 });
    expect(holds.input.safeParse({ resource_id: RESOURCE_ID, limit: 101 }).success).toBe(false);
  });

  it('reads path parameters percent-decoded, so a reference may hold a slash', async () => {
    const response = await buildServer().fetch(
      call('PUT', `/v1/resources/${RESOURCE_ID}/coverage/${encodeURIComponent('ics:https://example.com/fleet.ics')}`, {
        body: { start: '2027-03-01T00:00:00Z', end: '2027-06-01T00:00:00Z', revision: 1 },
      }),
    );
    expect(response.status).toBe(200);
    expect(backend.recordCoverage.mock.calls[0]?.[1]).toMatchObject({
      resource_id: RESOURCE_ID,
      source: 'ics:https://example.com/fleet.ics',
    });
  });

  it("answers the backend's refusal as it was thrown, and anything else as internal_error", async () => {
    const server = buildServer();
    backend.acquireHold.mockRejectedValueOnce(new SlotlockAgentOperationError('overlap', 409));
    const taken = await server.fetch(exampleRequest('slotlock_acquire_hold'));
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe('overlap');

    backend.getResource.mockRejectedValueOnce(new SlotlockAgentOperationError('resource_not_found', 404));
    const missing = await server.fetch(exampleRequest('slotlock_get_resource'));
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('resource_not_found');
    expect(onError).not.toHaveBeenCalled();

    const failure = new Error('connection reset by peer at 10.0.0.7');
    backend.confirmHold.mockRejectedValueOnce(failure);
    const broken = await server.fetch(exampleRequest('slotlock_confirm_hold'));
    expect(broken.status).toBe(500);
    expect(await broken.json()).toEqual(expect.objectContaining({ status: 500, code: 'internal_error', error: { code: 'internal_error' } }));
    expect(onError).toHaveBeenCalledWith(failure, expect.objectContaining({ operation: 'slotlock_confirm_hold' }));
  });

  it('never returns what the output schema does not describe', async () => {
    backend.getResource.mockResolvedValueOnce({ resource: { ...RESOURCE, tenant_ref: 'tenant-b' } });
    const response = await buildServer().fetch(exampleRequest('slotlock_get_resource'));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('tenant-b');
    expect(JSON.parse(body)).toEqual(expect.objectContaining({ status: 500, code: 'internal_error', error: { code: 'internal_error' } }));
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'invalid_backend_result' }),
      expect.objectContaining({ operation: 'slotlock_get_resource' }),
    );
  });

  it('reports each call as a rest event with its operation and status, never its arguments', async () => {
    const server = buildServer();
    await server.fetch(exampleRequest('slotlock_put_reservation'));
    await server.fetch(exampleRequest('slotlock_put_reservation', 'agent'));
    const events = onEvent.mock.calls.map(([event]) => event).filter((event) => event.type === 'rest');
    expect(events).toEqual([
      { type: 'rest', operation: 'slotlock_put_reservation', status: 200, durationMs: expect.any(Number) },
      { type: 'rest', operation: 'slotlock_put_reservation', status: 403, durationMs: expect.any(Number) },
    ]);
    expect(JSON.stringify(onEvent.mock.calls)).not.toContain('booking-BK-42');
  });

  it('is served only when configured: without it, the routes are not there', async () => {
    const server = buildServer({ application: undefined });
    const create = await server.fetch(exampleRequest('slotlock_create_resource'));
    expect(create.status).toBe(405);
    expect(create.headers.get('allow')).toBe('GET');
    for (const name of ['slotlock_get_resource', 'slotlock_acquire_hold', 'slotlock_run_maintenance']) {
      const response = await server.fetch(exampleRequest(name));
      expect(response.status).toBe(404);
    }
    const combined = await buildServer().fetch(call('OPTIONS', '/v1/resources'));
    expect(combined.status).toBe(405);
    expect(combined.headers.get('allow')).toBe('GET, POST');
  });

  it('is refused at start-up without rest, an authorize function, or every backend method', () => {
    const application = {
      backend: backend as unknown as SlotlockApplicationBackend,
      authorize: authorizeApplication,
    };
    expect(() => buildServer({ rest: false, application })).toThrow(/application needs rest/);
    expect(() => buildServer({ rest: undefined, application })).toThrow(/application needs rest/);
    expect(() =>
      buildServer({ application: { ...application, authorize: undefined as never } }),
    ).toThrow(/authorize function and a backend with every application method/);
    for (const method of Object.keys(backend)) {
      const partial = { ...backend, [method]: undefined };
      expect(() =>
        buildServer({
          application: { ...application, backend: partial as unknown as SlotlockApplicationBackend },
        }),
      ).toThrow(/every application method/);
    }
    expect(() => buildServer({ application: null as never })).toThrow(/every application method/);
  });
});

describe('the application API and agents', () => {
  it('is never an MCP tool or an A2A skill', async () => {
    const server = buildServer();
    const listed = await server.fetch(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools;
    expect(tools.map(({ name }) => name).sort()).toEqual(
      slotlockAgentTools()
        .map(({ name }) => name)
        .sort(),
    );

    const card = (await (
      await server.fetch(new Request('https://calendar.example.com/.well-known/agent-card.json'))
    ).json()) as { skills: { id: string }[] };
    for (const definition of SLOTLOCK_APPLICATION_OPERATIONS) {
      expect(card.skills.map(({ id }) => id)).not.toContain(definition.name);
    }

    const called = await server.fetch(
      new Request(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer admin',
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'slotlock_run_maintenance', arguments: {} },
        }),
      }),
    );
    expect(JSON.stringify(await called.json())).toMatch(/unknown|not found|invalid/i);
    expect(backend.runMaintenance).not.toHaveBeenCalled();
  });
});

describe('the OpenAPI document with the application API', () => {
  it('validates as OpenAPI 3.1 and has every operation once, tagged with its scope', async () => {
    const response = await buildServer().fetch(call('GET', '/openapi.json', { token: null }));
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      paths: Record<string, Record<string, Record<string, unknown>>>;
      tags: { name: string }[];
    };
    const validator = new Validator();
    const result = await validator.validate(document);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(document.tags.map(({ name }) => name)).toEqual(['Agent tools', 'Application']);

    const operations = Object.values(document.paths).flatMap((methods) => Object.values(methods));
    const ids = operations.map((operation) => operation.operationId as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      [
        ...slotlockAgentTools().map(({ name }) => name),
        ...SLOTLOCK_APPLICATION_OPERATIONS.map(({ name }) => name),
      ].sort(),
    );
    for (const definition of SLOTLOCK_APPLICATION_OPERATIONS) {
      const operation = document.paths[definition.path]?.[definition.method.toLowerCase()] as Record<
        string,
        unknown
      >;
      expect(operation).toMatchObject({
        operationId: definition.name,
        summary: definition.title,
        tags: ['Application'],
        'x-slotlock-scope': 'admin',
      });
      const responses = operation.responses as Record<string, unknown>;
      expect(Object.keys(responses)).toEqual(
        expect.arrayContaining(['200', '400', '401', '403', '404', '429', 'default']),
      );
      expect('409' in responses).toBe(definition.method !== 'GET');
      expect('428' in responses).toBe(false);
      const pathNames = [...definition.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
      const parameters = (operation.parameters ?? []) as { name: string; in: string }[];
      expect(parameters.filter((parameter) => parameter.in === 'path').map(({ name }) => name)).toEqual(
        pathNames,
      );
      const body = (operation.requestBody as { content: Record<string, { schema: { properties?: object } }> } | undefined)
        ?.content['application/json']?.schema;
      if (definition.method === 'GET' || definition.method === 'DELETE') {
        expect(body).toBeUndefined();
      } else {
        for (const name of pathNames) expect(body?.properties ?? {}).not.toHaveProperty(name as string);
      }
    }
    for (const route of SLOTLOCK_REST_ROUTES) {
      const operation = document.paths[route.path]?.[route.method.toLowerCase()];
      expect(operation).toMatchObject({
        tags: ['Agent tools'],
        'x-slotlock-scope': route.method === 'GET' ? 'read' : 'write',
      });
    }
  });

  it('leaves the application API out when the server does not serve it', async () => {
    const document = (await (
      await buildServer({ application: undefined }).fetch(call('GET', '/openapi.json', { token: null }))
    ).json()) as { paths: Record<string, unknown>; tags: { name: string }[] };
    expect(document.tags.map(({ name }) => name)).toEqual(['Agent tools']);
    expect(Object.keys(document.paths).sort()).toEqual(
      [...new Set(SLOTLOCK_REST_ROUTES.map(({ path }) => path))].sort(),
    );
  });
});
