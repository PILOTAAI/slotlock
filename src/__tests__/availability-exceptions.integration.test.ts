// Stored hours that inherit, and closures and special days (RFC 0004 B1, B2), against real
// Postgres over REST as an admin would set them and through the agent operations as an agent would
// search and book. Skipped without DATABASE_URL.
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type SlotlockAgentPrincipal,
  createSlotlockAgentServer,
  invokeSlotlockAgentOperation,
} from '../agent-server.js';
import { createSlotlockStoreAgentBackend, createSlotlockStoreApplicationBackend } from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';
import type { WeeklyAvailabilityRule } from '../types.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const BASE = 'http://localhost/slotlock';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EVERY_DAY = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU';
const SERVER_HOURS: WeeklyAvailabilityRule[] = [{ rrule: EVERY_DAY, startMinutes: 8 * 60, durationMinutes: 10 * 60 }];
const rules = (from: number, to: number) => [{ rrule: EVERY_DAY, start_minutes: from * 60, duration_minutes: (to - from) * 60 }];

const HOLIDAYS = (year: number) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Test//Holidays//EN',
    'BEGIN:VEVENT',
    'UID:new-year',
    `DTSTART;VALUE=DATE:${year}0101`,
    `DTEND;VALUE=DATE:${year}0102`,
    'RRULE:FREQ=YEARLY',
    "SUMMARY:New Year's Day",
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:summer-shutdown',
    `DTSTART;VALUE=DATE:${year}0803`,
    `DTEND;VALUE=DATE:${year}0808`,
    'SUMMARY:Summer shutdown',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:all-hands',
    `DTSTART:${year}0910T100000Z`,
    `DTEND:${year}0910T110000Z`,
    'SUMMARY:All hands',
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n');

type Answer = { status: number; body: Record<string, unknown> };

describe.skipIf(!url)('stored hours and closures (real Postgres)', () => {
  let sql: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  let server: ReturnType<typeof createSlotlockAgentServer>;
  let agentBackend: ReturnType<typeof createSlotlockStoreAgentBackend>;
  const tenantRef = `hours-${randomUUID()}`;
  const otherTenant = `hours-other-${randomUUID()}`;
  // A Wednesday well ahead, in UTC.
  const year = new Date().getUTCFullYear() + 1;
  const wednesday = (() => {
    const day = Date.UTC(year, 5, 1);
    return day + (((3 - new Date(day).getUTCDay()) + 7) % 7) * DAY;
  })();
  const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const D = date(wednesday);
  const principals: Record<string, SlotlockAgentPrincipal> = {
    admin: { subject: 'person-admin', tenantRef, scopes: ['read', 'write', 'admin'] },
    other: { subject: 'other-admin', tenantRef: otherTenant, scopes: ['read', 'write', 'admin'] },
  };
  const fetched: string[] = [];
  const call = async (who: keyof typeof principals, method: string, path: string, body?: unknown): Promise<Answer> => {
    const response = await server.fetch(
      new Request(`${BASE}${path}`, {
        method,
        headers: { authorization: `Bearer ${who}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const agent = (operation: string, input: Record<string, unknown>) =>
    invokeSlotlockAgentOperation({
      operation: operation as never,
      input,
      request: new Request(BASE),
      options: {
        backend: agentBackend,
        authenticate: async () => ({ subject: 'agent-a', tenantRef, scopes: ['read', 'write'] }),
        authorize: async () => true,
      },
    }) as Promise<{ ok: boolean; code?: string; details?: Record<string, unknown>; data?: Record<string, unknown> }>;
  const slots = async (resourceId: string, from: number, to: number, minutes = 60) => {
    const answer = await agent('slotlock_find_available_slots', {
      resource_ids: [resourceId],
      start: new Date(from).toISOString(),
      end: new Date(to).toISOString(),
      duration_minutes: minutes,
      limit: 50,
    });
    expect(answer.ok).toBe(true);
    return ((answer.data?.slots ?? []) as { start: string; end: string }[]).map((slot) => [slot.start.slice(11, 16), slot.end.slice(11, 16)]);
  };
  const resource = async (ref: string, place?: { location?: string; timezone?: string }) =>
    (
      await store.withTenant(tenantRef, (tenant) =>
        tenant.createResource({
          tenantRef,
          externalRef: ref,
          timezone: place?.timezone ?? 'UTC',
          ...(place?.location ? { location: place.location } : {}),
        }),
      )
    ).id;
  const resourceOf = async (id: string) => (await call('admin', 'GET', `/v1/resources/${id}`)).body.resource as Record<string, unknown>;

  beforeAll(async () => {
    sql = postgres(url as string, { max: 8, onnotice: () => {} });
    store = createSlotlockStore(sql);
    await store.applySchema();
    agentBackend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => SERVER_HOURS });
    server = createSlotlockAgentServer({
      publicBaseUrl: BASE,
      allowInsecureLocalhost: true,
      backend: agentBackend,
      authenticate: async (request) => principals[request.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
      authorize: async () => true,
      health: async () => ({ ready: true, checks: [] }),
      rest: true,
      application: {
        backend: createSlotlockStoreApplicationBackend(store, {
          agentBackend,
          holidayFetch: async (input) => {
            fetched.push(String(input));
            return new Response(HOLIDAYS(year), { headers: { 'content-type': 'text/calendar' } });
          },
        }),
        authorize: async ({ principal }) => principal.scopes?.includes('admin') === true,
      },
    });
    await store.withTenant(tenantRef, async (tenant) => {
      await tenant.putLocation({ tenantRef, ref: 'region', name: 'Region' });
      await tenant.putLocation({ tenantRef, ref: 'depot', name: 'Depot', parentRef: 'region' });
    });
  });

  afterAll(async () => {
    await sql`SELECT * FROM slotlock.erase_tenant(${tenantRef}::text)`;
    await sql`SELECT * FROM slotlock.erase_tenant(${otherTenant}::text)`;
    await sql.end();
  });

  it('stores hours for the tenant and its locations, and resources inherit the nearest (B2)', async () => {
    const loose = await resource('loose');
    const atDepot = await resource('at-depot', { location: 'depot' });
    const own = await resource('own-hours', { location: 'depot' });
    await call('admin', 'PUT', `/v1/resources/${own}/availability`, { rules: rules(6, 7) });
    // Nothing stored: the server's hours.
    expect((await resourceOf(loose)).inherited_availability).toBeNull();
    expect(await slots(loose, wednesday + 7 * HOUR, wednesday + 10 * HOUR)).toEqual([['08:00', '09:00'], ['09:00', '10:00']]);

    const tenantHours = await call('admin', 'PUT', '/v1/availability', { rules: rules(9, 17) });
    expect(tenantHours.body).toEqual({ resources_updated: 2, resources_with_own_hours: 1 });
    expect(await resourceOf(loose)).toMatchObject({
      availability: null,
      inherited_availability: { source: 'tenant', location: null, rules: rules(9, 17) },
    });
    // Nothing was copied: a resource's own hours stay its own.
    expect((await resourceOf(own)).availability).toEqual(rules(6, 7));

    const region = await call('admin', 'PUT', '/v1/locations/region/availability', { rules: rules(10, 14) });
    expect(region.body).toEqual({ location: 'region', resources_updated: 1, resources_with_own_hours: 1 });
    expect((await resourceOf(atDepot)).inherited_availability).toMatchObject({ source: 'location', location: 'region' });
    expect((await resourceOf(loose)).inherited_availability).toMatchObject({ source: 'tenant' });
    // A resource added later inherits too.
    const later = await resource('later', { location: 'depot' });
    expect((await resourceOf(later)).inherited_availability).toMatchObject({ source: 'location', location: 'region', rules: rules(10, 14) });
    expect(await slots(later, wednesday, wednesday + DAY, 120)).toEqual([['10:00', '12:00'], ['12:00', '14:00']]);

    // The nearer location wins; cleared, it falls back up the chain.
    await call('admin', 'PUT', '/v1/locations/depot/availability', { rules: rules(11, 12) });
    expect((await resourceOf(later)).inherited_availability).toMatchObject({ location: 'depot', rules: rules(11, 12) });
    await call('admin', 'PUT', '/v1/locations/depot/availability', { rules: null });
    expect((await resourceOf(later)).inherited_availability).toMatchObject({ location: 'region' });
    expect((await call('admin', 'PUT', '/v1/locations/nowhere/availability', { rules: null })).body).toMatchObject({
      error: { code: 'location_not_found' },
    });

    expect((await call('admin', 'GET', '/v1/availability')).body).toEqual({
      tenant: rules(9, 17),
      locations: [{ location: 'region', rules: rules(10, 14) }],
    });
    // Override hands every resource to what it inherits.
    const override = await call('admin', 'PUT', '/v1/availability', { rules: rules(9, 17), override_resources: true });
    expect(override.body).toEqual({ resources_updated: 1, resources_with_own_hours: 0 });
    expect(await resourceOf(own)).toMatchObject({ availability: null, inherited_availability: { location: 'region' } });
    // Another tenant sees none of it.
    expect((await call('other', 'GET', '/v1/availability')).body).toEqual({ tenant: null, locations: [] });
  });

  it('closes days and gives them special hours, the nearest scope winning, in each resource zone (B1)', async () => {
    const loose = await resource('closure-loose');
    const atDepot = await resource('closure-depot', { location: 'depot' });
    const newYork = await resource('closure-ny', { timezone: 'America/New_York' });
    const add = (body: Record<string, unknown>) => call('admin', 'POST', '/v1/availability/exceptions', body);

    const closed = await add({ starts_on: D, outcome: 'closed', label: 'Stocktake' });
    expect(closed.status).toBe(200);
    expect(closed.body.exception).toMatchObject({ starts_on: D, ends_on: D, outcome: 'closed', hours: null, location: null, resource_id: null });
    expect(await slots(loose, wednesday, wednesday + DAY)).toEqual([]);
    const next = await agent('slotlock_find_next_available', {
      resource_ids: [loose],
      start: new Date(wednesday).toISOString(),
      end: new Date(wednesday + 3 * DAY).toISOString(),
      duration_minutes: 60,
    });
    expect(next.data?.start).toBe(new Date(wednesday + DAY + 9 * HOUR).toISOString());
    // The day is the resource's own: New York's Wednesday runs 04:00 UTC Wednesday to 04:00 Thursday.
    const nyNext = await agent('slotlock_find_next_available', {
      resource_ids: [newYork],
      start: new Date(wednesday).toISOString(),
      end: new Date(wednesday + 3 * DAY).toISOString(),
      duration_minutes: 60,
    });
    expect(nyNext.data?.start).toBe(new Date(wednesday + DAY + 13 * HOUR).toISOString());

    // A location opens the day for its own, from the outermost in; a resource's own beats both.
    const special = await add({
      location: 'depot',
      starts_on: D,
      outcome: 'open',
      hours: [{ start_minutes: 12 * 60, duration_minutes: 60 }],
      label: 'Half day',
    });
    expect(special.status).toBe(200);
    expect(await slots(atDepot, wednesday, wednesday + DAY)).toEqual([['12:00', '13:00']]);
    expect(await slots(loose, wednesday, wednesday + DAY)).toEqual([]);
    const own = await add({ resource_id: atDepot, starts_on: D, outcome: 'closed', label: 'Serviced' });
    expect(await slots(atDepot, wednesday, wednesday + DAY)).toEqual([]);
    const listed = await call('admin', 'GET', `/v1/availability/exceptions?resource_id=${atDepot}`);
    expect((listed.body.exceptions as { label: string }[]).map((exception) => exception.label).sort()).toEqual([
      'Half day',
      'Serviced',
      'Stocktake',
    ]);
    expect((await call('admin', 'GET', '/v1/availability/exceptions?location=depot')).body.exceptions).toHaveLength(1);
    expect((await call('other', 'GET', '/v1/availability/exceptions')).body.exceptions).toEqual([]);

    // Writes are judged by the same evaluator under enforce_hours.
    await call('admin', 'PUT', `/v1/resources/${loose}/booking-rules`, { rules: { enforce_hours: true } });
    const book = (start: number, key: string) =>
      agent('slotlock_create_event', {
        resource_id: loose,
        starts_at: new Date(start).toISOString(),
        ends_at: new Date(start + HOUR).toISOString(),
        timezone: 'UTC',
        idempotency_key: key,
      });
    const refused = await book(wednesday + 10 * HOUR, 'closed-day');
    expect(refused).toMatchObject({ ok: false, code: 'booking_rule_outside_hours' });
    expect(
      (await call('admin', 'DELETE', `/v1/availability/exceptions/${(closed.body.exception as { id: string }).id}`)).body,
    ).toEqual({ deleted: true });
    expect(await book(wednesday + 10 * HOUR, 'open-again')).toMatchObject({ ok: true });
    expect((await call('admin', 'DELETE', `/v1/availability/exceptions/${(own.body.exception as { id: string }).id}`)).status).toBe(200);
    expect((await call('admin', 'DELETE', `/v1/availability/exceptions/${randomUUID()}`)).body).toMatchObject({
      error: { code: 'availability_exception_not_found' },
    });

    // Refused shapes.
    expect((await add({ starts_on: D, ends_on: date(wednesday - DAY), outcome: 'closed', label: 'Backwards' })).status).toBe(400);
    expect((await add({ starts_on: D, outcome: 'open', label: 'No hours' })).body).toMatchObject({
      error: { code: 'invalid_availability_exception' },
    });
    expect((await add({ starts_on: '2027-02-30', outcome: 'closed', label: 'Not a day' })).status).toBe(400);
    expect((await add({ location: 'nowhere', starts_on: D, outcome: 'closed', label: 'Nowhere' })).body).toMatchObject({
      error: { code: 'location_not_found' },
    });
  });

  it('imports a holiday calendar as closures, again without adding more (B1)', async () => {
    const icalendar = HOLIDAYS(year);
    const span = { from: `${year}-01-01`, to: `${year + 1}-12-31` };
    const first = await call('admin', 'POST', '/v1/availability/holidays', { icalendar, location: 'region', ...span });
    expect(first.body).toEqual({ imported: 3, skipped: 1 });
    const again = await call('admin', 'POST', '/v1/availability/holidays', { url: 'https://example.com/holidays.ics', location: 'region', ...span });
    expect(again.body).toEqual({ imported: 3, skipped: 1 });
    expect(fetched).toEqual(['https://example.com/holidays.ics']);
    const imported = (await call('admin', 'GET', '/v1/availability/exceptions?location=region')).body.exceptions as Record<string, unknown>[];
    expect(imported.map((exception) => [exception.starts_on, exception.ends_on, exception.label, exception.source])).toEqual([
      [`${year}-01-01`, `${year}-01-01`, "New Year's Day", 'ics'],
      [`${year}-08-03`, `${year}-08-07`, 'Summer shutdown', 'ics'],
      [`${year + 1}-01-01`, `${year + 1}-01-01`, "New Year's Day", 'ics'],
    ]);
    expect((await call('admin', 'POST', '/v1/availability/holidays', { icalendar: 'not a calendar' })).body).toMatchObject({
      error: { code: 'invalid_holiday_calendar' },
    });
    expect((await call('admin', 'POST', '/v1/availability/holidays', { url: 'http://example.com/h.ics' })).body).toMatchObject({
      error: { code: 'invalid_holiday_calendar' },
    });
  });

  it('exports closures as EXDATE and RDATE, and imports them back as the resource own (B1)', async () => {
    const id = await resource('ical');
    const day = wednesday + 14 * DAY;
    const nextDay = date(day + DAY);
    await call('admin', 'PUT', `/v1/resources/${id}/availability`, { rules: rules(9, 17) });
    await call('admin', 'POST', '/v1/availability/exceptions', { resource_id: id, starts_on: date(day), outcome: 'closed', label: 'Off' });
    await call('admin', 'POST', '/v1/availability/exceptions', {
      resource_id: id,
      starts_on: nextDay,
      outcome: 'open',
      hours: [{ start_minutes: 600, duration_minutes: 120 }],
      label: 'Short',
    });
    const exported = (await call('admin', 'GET', `/v1/resources/${id}/availability/ical`)).body.icalendar as string;
    const compact = (ms: number) => date(ms).replaceAll('-', '');
    expect(exported).toContain(`EXDATE;TZID=UTC:${compact(day)}T090000,${compact(day + DAY)}T090000`);
    expect(exported).toContain(`DTSTART;TZID=UTC:${compact(day + DAY)}T100000\r\nDURATION:PT120M`);

    // Imported elsewhere, the days come back as that resource's own exceptions.
    const copy = await resource('ical-copy');
    const imported = await call('admin', 'PUT', `/v1/resources/${copy}/availability/ical`, { icalendar: exported });
    expect(imported.status).toBe(200);
    expect(await slots(copy, day, day + DAY)).toEqual([]);
    expect(await slots(copy, day + DAY, day + 2 * DAY, 120)).toEqual([['10:00', '12:00']]);
    const own = (await call('admin', 'GET', `/v1/availability/exceptions?resource_id=${copy}`)).body.exceptions as Record<string, unknown>[];
    expect(own.map((exception) => [exception.outcome, exception.source])).toEqual([
      ['closed', 'vavailability'],
      ['open', 'vavailability'],
    ]);
    // Importing plain weekly hours again replaces what the last import made.
    const plain = exported.replace(/EXDATE[^\r]*\r\n/, '').replace(/BEGIN:AVAILABLE\r\nUID:[^\r]*-day-0[\s\S]*?END:AVAILABLE\r\n/, '');
    expect((await call('admin', 'PUT', `/v1/resources/${copy}/availability/ical`, { icalendar: plain })).status).toBe(200);
    expect((await call('admin', 'GET', `/v1/availability/exceptions?resource_id=${copy}`)).body.exceptions).toEqual([]);
  });
});
