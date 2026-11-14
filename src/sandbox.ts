// The sandbox (RFC 0004 A6): a test environment (a tenant ending ~test) filled with a scenario an
// agent can be tried against, emptied again, moved forward so what would lapse lapses, and raced.
// None of it touches a live tenant: each refuses one (`sandbox_test_only`), and the database's
// reset does too.
import { randomUUID } from 'node:crypto';
import {
  type SlotlockAgentCalendarBackend,
  type SlotlockAgentOperationDispatchResult,
  invokeSlotlockAgentOperation,
} from './agent-server.js';
import { SLOTLOCK_TEST_TENANT_SUFFIX } from './api-keys.js';
import type { SlotlockBookingRules } from './booking-rules.js';
import { type SlotlockMaintenanceResult, maintainSlotlockTenant } from './maintenance.js';
import type { SlotlockResourceKind } from './resource-profile.js';
import type { SlotlockStore, SlotlockTenantStore } from './store.js';
import type { WeeklyAvailabilityRule } from './types.js';

export const SLOTLOCK_SANDBOX_SCENARIOS = Object.freeze(['car-rental', 'clinic', 'desks'] as const);
export type SlotlockSandboxScenario = (typeof SLOTLOCK_SANDBOX_SCENARIOS)[number];

/** Agents one race runs at most, so a race stays a test of the server and not a load on it. */
export const SLOTLOCK_SANDBOX_MAX_RACERS = 200;
/** Agents a race runs when it names no number. */
export const SLOTLOCK_SANDBOX_DEFAULT_RACERS = 100;

/** Refused outside a test environment. */
export class SlotlockSandboxError extends Error {
  readonly code: 'sandbox_test_only' | 'sandbox_not_empty';
  constructor(code: 'sandbox_test_only' | 'sandbox_not_empty', message: string) {
    super(message);
    this.code = code;
  }
}

function assertTestTenant(tenantRef: string): void {
  if (!tenantRef.endsWith(SLOTLOCK_TEST_TENANT_SUFFIX)) {
    throw new SlotlockSandboxError(
      'sandbox_test_only',
      `Slotlock's sandbox works only in a test environment (a tenant ending ${SLOTLOCK_TEST_TENANT_SUFFIX})`,
    );
  }
}

const EVERY_DAY = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU';
const WEEKDAYS = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
const hours = (rrule: string, from: number, to: number): WeeklyAvailabilityRule[] => [
  { rrule, startMinutes: from * 60, durationMinutes: (to - from) * 60 },
];

interface ScenarioResource {
  ref: string;
  name: string;
  kind: SlotlockResourceKind;
  capacity?: number;
  labels?: string[];
  location?: string;
  pool?: string;
  groups?: string[];
  parent?: string;
}

interface Scenario {
  timezone: string;
  locations: { ref: string; name: string; parent?: string }[];
  groups: { ref: string; name: string }[];
  resources: ScenarioResource[];
  hours: WeeklyAvailabilityRule[];
  rules?: SlotlockBookingRules;
  /** Bookings tomorrow, local time: resource, start hour, hours long. */
  bookings: { resource: string; hour: number; length: number }[];
}

const SCENARIOS: Record<SlotlockSandboxScenario, Scenario> = {
  // A rental desk at two branches: cars and vans in pools, booked by the day or the hour, with
  // time to clean each between hires.
  'car-rental': {
    timezone: 'Europe/London',
    locations: [
      { ref: 'airport', name: 'Airport branch' },
      { ref: 'city', name: 'City branch' },
    ],
    groups: [{ ref: 'electric', name: 'Electric' }],
    resources: [
      { ref: 'car-1', name: 'Compact 1', kind: 'vehicle', capacity: 5, location: 'airport', pool: 'compact', labels: ['automatic'] },
      { ref: 'car-2', name: 'Compact 2', kind: 'vehicle', capacity: 5, location: 'airport', pool: 'compact' },
      { ref: 'car-3', name: 'Compact 3 (EV)', kind: 'vehicle', capacity: 5, location: 'city', pool: 'compact', groups: ['electric'] },
      { ref: 'van-1', name: 'Van 1', kind: 'vehicle', capacity: 3, location: 'city', pool: 'van' },
      { ref: 'van-2', name: 'Van 2 (EV)', kind: 'vehicle', capacity: 3, location: 'airport', pool: 'van', groups: ['electric'] },
    ],
    hours: hours(EVERY_DAY, 7, 21),
    rules: { minNoticeMinutes: 60, turnaroundMinutes: 30, slotStepMinutes: 30 },
    bookings: [
      { resource: 'car-1', hour: 9, length: 4 },
      { resource: 'car-2', hour: 10, length: 2 },
      { resource: 'van-1', hour: 8, length: 9 },
    ],
  },
  // A physiotherapy clinic: practitioners and treatment rooms on weekdays, half-hour slots.
  clinic: {
    timezone: 'America/New_York',
    locations: [{ ref: 'main-street', name: 'Main Street clinic' }],
    groups: [{ ref: 'physio', name: 'Physiotherapists' }],
    resources: [
      { ref: 'dr-adams', name: 'Dr Adams', kind: 'person', location: 'main-street', groups: ['physio'] },
      { ref: 'dr-baker', name: 'Dr Baker', kind: 'person', location: 'main-street', groups: ['physio'] },
      { ref: 'room-1', name: 'Treatment room 1', kind: 'room', capacity: 2, location: 'main-street', pool: 'treatment-room' },
      { ref: 'room-2', name: 'Treatment room 2', kind: 'room', capacity: 2, location: 'main-street', pool: 'treatment-room' },
    ],
    hours: hours(WEEKDAYS, 9, 17),
    rules: { slotStepMinutes: 30, minNoticeMinutes: 120 },
    bookings: [
      { resource: 'dr-adams', hour: 9, length: 1 },
      { resource: 'dr-baker', hour: 11, length: 1 },
      { resource: 'room-1', hour: 9, length: 1 },
    ],
  },
  // An office: desks on two floors, booked by the day, and a hall that splits into two rooms.
  desks: {
    timezone: 'Europe/Berlin',
    locations: [
      { ref: 'hq', name: 'Headquarters' },
      { ref: 'floor-1', name: 'Floor 1', parent: 'hq' },
      { ref: 'floor-2', name: 'Floor 2', parent: 'hq' },
    ],
    groups: [{ ref: 'standing', name: 'Standing desks' }],
    resources: [
      ...Array.from({ length: 6 }, (_, index) => ({
        ref: `desk-${index + 1}`,
        name: `Desk ${index + 1}`,
        kind: 'desk' as const,
        location: index < 3 ? 'floor-1' : 'floor-2',
        pool: 'desk',
        ...(index % 3 === 0 ? { groups: ['standing'] } : {}),
      })),
      { ref: 'hall', name: 'Event hall', kind: 'room', capacity: 80, location: 'floor-1' },
      { ref: 'hall-east', name: 'Event hall, east', kind: 'room', capacity: 40, location: 'floor-1', parent: 'hall' },
      { ref: 'hall-west', name: 'Event hall, west', kind: 'room', capacity: 40, location: 'floor-1', parent: 'hall' },
    ],
    hours: hours(WEEKDAYS, 8, 18),
    bookings: [
      { resource: 'desk-1', hour: 8, length: 10 },
      { resource: 'desk-4', hour: 8, length: 10 },
      { resource: 'hall-east', hour: 14, length: 2 },
    ],
  },
};

export interface SlotlockSandboxSeedResult {
  scenario: SlotlockSandboxScenario;
  resources: number;
  locations: number;
  groups: number;
  pools: number;
  bookings: number;
}

/** The time `hour` o'clock local time falls on tomorrow, in `timezone`, as UTC. */
function tomorrowAt(now: Date, timezone: string, hour: number): Date {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(now.getTime() + 86_400_000))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]),
  ) as { year: number; month: number; day: number };
  // The zone's offset at that wall time, found by asking what the guess reads as there.
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, hour);
  const local = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(new Date(guess))
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]),
  ) as { year: number; month: number; day: number; hour: number; minute: number };
  const shown = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  return new Date(guess - (shown - guess));
}

/**
 * Fill an empty test environment with a scenario, in one transaction: its locations, groups,
 * resources (with profiles, pools and a composite where it has one), their hours and booking
 * rules, and a few bookings tomorrow. Refused (`sandbox_not_empty`) where it has resources already:
 * reset it first.
 */
export async function seedSlotlockSandbox(
  store: SlotlockStore,
  tenantRef: string,
  scenario: SlotlockSandboxScenario,
  options: { now?: Date } = {},
): Promise<SlotlockSandboxSeedResult> {
  assertTestTenant(tenantRef);
  const plan = SCENARIOS[scenario];
  if (!plan) throw new RangeError(`Slotlock knows the scenarios ${SLOTLOCK_SANDBOX_SCENARIOS.join(', ')}`);
  const now = options.now ?? new Date();
  return store.withTenant(
    tenantRef,
    async (tenant: SlotlockTenantStore) => {
      if ((await tenant.countResources({ tenantRef })) > 0) {
        throw new SlotlockSandboxError('sandbox_not_empty', 'Slotlock seeds an empty test environment: reset it first');
      }
      for (const location of plan.locations) {
        await tenant.putLocation({
          tenantRef,
          ref: location.ref,
          name: location.name,
          ...(location.parent ? { parentRef: location.parent } : { timezone: plan.timezone }),
        });
      }
      for (const group of plan.groups) await tenant.putGroup({ tenantRef, ref: group.ref, name: group.name });
      const ids = new Map<string, string>();
      for (const resource of plan.resources) {
        const created = await tenant.createResource({
          tenantRef,
          externalRef: resource.ref,
          timezone: plan.timezone,
          profile: {
            name: resource.name,
            kind: resource.kind,
            ...(resource.capacity !== undefined ? { capacity: resource.capacity } : {}),
            ...(resource.labels ? { labels: resource.labels } : {}),
          },
          ...(resource.location ? { location: resource.location } : {}),
        });
        ids.set(resource.ref, created.id);
        await tenant.setResourceAvailability({ tenantRef, id: created.id, rules: plan.hours });
        if (plan.rules) await tenant.setResourceBookingRules({ tenantRef, id: created.id, rules: plan.rules });
        if (resource.pool) await tenant.setResourcePool({ tenantRef, id: created.id, pool: resource.pool });
        for (const group of resource.groups ?? []) {
          await tenant.addGroupMember({ tenantRef, group, resourceId: created.id });
        }
      }
      for (const resource of plan.resources) {
        if (resource.parent) {
          await tenant.setResourceParent({
            tenantRef,
            id: ids.get(resource.ref) as string,
            parentId: ids.get(resource.parent) as string,
          });
        }
      }
      let bookings = 0;
      for (const [index, booking] of plan.bookings.entries()) {
        const start = tomorrowAt(now, plan.timezone, booking.hour);
        const made = await tenant.createExternalReservation({
          tenantRef,
          externalRef: `sandbox-${scenario}-${index + 1}`,
          resourceId: ids.get(booking.resource) as string,
          start,
          end: new Date(start.getTime() + booking.length * 3_600_000),
          bufferAfterMs: 0,
          revision: 1,
          source: 'sandbox',
        });
        if (made.ok) bookings += 1;
      }
      return {
        scenario,
        resources: plan.resources.length,
        locations: plan.locations.length,
        groups: plan.groups.length,
        pools: new Set(plan.resources.flatMap((resource) => (resource.pool ? [resource.pool] : []))).size,
        bookings,
      };
    },
    { origin: 'maintenance', actor: 'slotlock:sandbox', isolation: 'read committed' },
  );
}

/** Empty a test environment: what seeding made, and every booking since. Keys, webhooks and plan stay. */
export async function resetSlotlockSandbox(store: SlotlockStore, tenantRef: string): Promise<Record<string, number>> {
  assertTestTenant(tenantRef);
  return store.withTenant(tenantRef, (tenant) => tenant.resetTestTenant({ tenantRef }), {
    origin: 'maintenance',
    actor: 'slotlock:sandbox',
  });
}

export interface SlotlockSandboxFastForwardResult {
  minutes: number;
  /** Holds (a waitlist offer's and an approval's among them) and approvals that lapsed now. */
  holds: number;
  approvals: number;
  /** The maintenance pass that then reaped them, as it would have. */
  maintenance: SlotlockMaintenanceResult;
}

/**
 * Move a test environment's waiting forward: what would lapse within `minutes` lapses now, then a
 * maintenance pass reaps it as it would have (holds released, waitlist offers passed on, approvals
 * expired). Bookings and events keep their times; no-shows and series rolls follow the real clock.
 */
export async function fastForwardSlotlockSandbox(
  store: SlotlockStore,
  tenantRef: string,
  minutes: number,
): Promise<SlotlockSandboxFastForwardResult> {
  assertTestTenant(tenantRef);
  const lapsed = await store.withTenant(tenantRef, (tenant) => tenant.fastForwardTestTenant({ tenantRef, minutes }), {
    origin: 'maintenance',
    actor: 'slotlock:sandbox',
  });
  const maintenance = await maintainSlotlockTenant(store, tenantRef);
  return { minutes, ...lapsed, maintenance };
}

export interface SlotlockSandboxRaceResult {
  agents: number;
  booked: number;
  /** Refusals by code. */
  refused: Record<string, number>;
  /** Refusals that came with alternatives. */
  withAlternatives: number;
  serverErrors: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

/**
 * Race `agents` agents (2-200), each its own principal, for one time on one resource of a test
 * environment, through the same operation boundary MCP, A2A and REST use: who booked, who was
 * refused and why, and how long each answer took. With `signal`, the race ends with the request
 * that asked for it: each racer's call carries the signal, so a racer still waiting its turn for
 * the tenant's transactions leaves the line when it aborts, and the race then rejects with its
 * reason once the racers already running have finished.
 */
export async function raceSlotlockSandbox(params: {
  backend: SlotlockAgentCalendarBackend;
  tenantRef: string;
  resourceId: string;
  start: Date;
  end: Date;
  agents?: number;
  /** The asking request's signal. */
  signal?: AbortSignal;
}): Promise<SlotlockSandboxRaceResult> {
  assertTestTenant(params.tenantRef);
  const agents = params.agents ?? SLOTLOCK_SANDBOX_DEFAULT_RACERS;
  if (!Number.isSafeInteger(agents) || agents < 2 || agents > SLOTLOCK_SANDBOX_MAX_RACERS) {
    throw new RangeError(`A sandbox race runs 2 to ${SLOTLOCK_SANDBOX_MAX_RACERS} agents`);
  }
  params.signal?.throwIfAborted();
  const race = randomUUID().slice(0, 8);
  const answers = await Promise.all(
    Array.from({ length: agents }, async (_, index) => {
      const started = performance.now();
      const answer: SlotlockAgentOperationDispatchResult = await invokeSlotlockAgentOperation({
        operation: 'slotlock_create_event',
        input: {
          resource_id: params.resourceId,
          starts_at: params.start.toISOString(),
          ends_at: params.end.toISOString(),
          timezone: 'UTC',
          title: `Sandbox racer ${index + 1}`,
          idempotency_key: `sandbox-race-${race}-${index}`,
        },
        request: new Request('https://sandbox.slotlock.invalid/race', params.signal ? { signal: params.signal } : {}),
        options: {
          backend: params.backend,
          authenticate: async () => ({
            subject: `sandbox-racer-${race}-${index + 1}`,
            tenantRef: params.tenantRef,
            scopes: ['read', 'write'],
          }),
          authorize: async () => true,
        },
      });
      return { answer, ms: performance.now() - started };
    }),
  );
  // The racers that left the line answered request_aborted: the race was not run, not refused.
  params.signal?.throwIfAborted();
  const refused: Record<string, number> = {};
  let withAlternatives = 0;
  let serverErrors = 0;
  for (const { answer } of answers) {
    if (answer.ok) continue;
    if (answer.status >= 500) serverErrors += 1;
    refused[answer.code] = (refused[answer.code] ?? 0) + 1;
    if (answer.alternatives?.length) withAlternatives += 1;
  }
  const times = answers.map(({ ms }) => ms).sort((a, b) => a - b);
  const at = (share: number) => Math.round(times[Math.min(times.length - 1, Math.ceil(times.length * share) - 1)] as number);
  return {
    agents,
    booked: answers.filter(({ answer }) => answer.ok).length,
    refused,
    withAlternatives,
    serverErrors,
    p50Ms: at(0.5),
    p99Ms: at(0.99),
    maxMs: Math.round(times.at(-1) as number),
  };
}
