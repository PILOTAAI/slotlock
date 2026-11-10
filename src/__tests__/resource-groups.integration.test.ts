// Where resources are, and the sets they are in (RFC 0003 G2, G3), against real Postgres as the
// LOGIN role grantApplicationRole grants: a location tree held to its depth, free of loops and kept
// while in use; a resource taking its location's time zone and found under any location above it;
// groups and their members, held to their counts; each tenant seeing only its own; all erased with
// it. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invokeSlotlockAgentOperation } from '../agent-server.js';
import {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreApplicationBackend,
} from '../agent-store-backend.js';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import { type SlotlockStore, type SlotlockTenantStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('locations and groups (real Postgres, application role)', () => {
  const role = `slotlock_groups_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenants: string[] = [];
  const tenant = (name: string) => {
    const ref = `groups-${name}-${randomUUID()}`;
    tenants.push(ref);
    return ref;
  };
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;
  const as = <T,>(tenantRef: string, work: (scoped: SlotlockTenantStore) => Promise<T>) => store.withTenant(tenantRef, work);

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
      max: 4,
      onnotice: () => {},
    });
    store = createSlotlockStore(application);
  });

  afterAll(async () => {
    for (const ref of tenants) await admin`SELECT * FROM slotlock.erase_tenant(${ref}::text)`;
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('keeps a location tree at most five deep, free of loops, and lists it depth first', async () => {
    const acme = tenant('tree');
    const put = (ref: string, name: string, parentRef?: string | null, timezone?: string | null) =>
      as(acme, (scoped) =>
        scoped.putLocation({
          tenantRef: acme,
          ref,
          name,
          ...(parentRef !== undefined ? { parentRef } : {}),
          ...(timezone !== undefined ? { timezone } : {}),
        }),
      );
    expect(await put('uk', 'United Kingdom', null, 'Europe/London')).toEqual({
      ref: 'uk',
      name: 'United Kingdom',
      parentRef: null,
      timezone: 'Europe/London',
      resources: 0,
    });
    await put('leeds', 'Leeds clinic', 'uk');
    await put('leeds.b', 'Building B', 'leeds');
    await put('leeds.b.2', 'Floor 2', 'leeds.b');
    await put('leeds.b.2.east', 'East wing', 'leeds.b.2');
    await put('ireland', 'Ireland', null, 'Europe/Dublin');
    await expect(put('leeds.b.2.east.desk', 'Too deep', 'leeds.b.2.east')).rejects.toMatchObject({
      code: 'location_too_deep',
    });
    await expect(put('nowhere', 'Nowhere', 'missing')).rejects.toMatchObject({ code: 'location_not_found' });
    // A location cannot go under itself or anything under it, and a move keeps the tree at five.
    await expect(put('leeds', 'Leeds clinic', 'leeds.b.2')).rejects.toMatchObject({ code: 'location_cycle' });
    await expect(put('ireland', 'Ireland', 'leeds.b.2.east')).rejects.toMatchObject({ code: 'location_too_deep' });
    // Five levels exactly is allowed: Leeds and the three levels under it, under Ireland. Moved back.
    await expect(put('leeds', 'Leeds clinic', 'ireland')).resolves.toMatchObject({ parentRef: 'ireland' });
    await put('leeds', 'Leeds clinic', 'uk');
    await expect(
      as(acme, (scoped) => scoped.updateLocation({ tenantRef: acme, ref: 'leeds.b', parentRef: 'ireland' })),
    ).resolves.toMatchObject({ ref: 'leeds.b', parentRef: 'ireland' });
    // Created again with a new name only, it keeps its parent and time zone.
    expect(await put('uk', 'Great Britain')).toMatchObject({ name: 'Great Britain', timezone: 'Europe/London' });
    const listed = await as(acme, (scoped) => scoped.listLocations({ tenantRef: acme }));
    expect(listed.map((location) => location.ref)).toEqual([
      'ireland',
      'leeds.b',
      'leeds.b.2',
      'leeds.b.2.east',
      'uk',
      'leeds',
    ]);
    for (const bad of [
      { ref: 'Bad Ref', name: 'x' },
      { ref: 'ok', name: '   ' },
      { ref: 'ok', name: 'x', timezone: 'Mars/Olympus' },
      { ref: 'ok', name: 'x', parentRef: 'ok' },
    ]) {
      await expect(as(acme, (scoped) => scoped.putLocation({ tenantRef: acme, ...bad })), JSON.stringify(bad)).rejects.toMatchObject({
        code: 'invalid_location',
      });
    }
    expect(await as(acme, (scoped) => scoped.updateLocation({ tenantRef: acme, ref: 'missing', name: 'x' }))).toBeNull();
  });

  it("puts a resource at a location, in that location's time zone, found under any location above", async () => {
    const acme = tenant('placed');
    await as(acme, (scoped) => scoped.putLocation({ tenantRef: acme, ref: 'north', name: 'North', timezone: 'Europe/London' }));
    await as(acme, (scoped) => scoped.putLocation({ tenantRef: acme, ref: 'leeds', name: 'Leeds', parentRef: 'north' }));
    await as(acme, (scoped) => scoped.putLocation({ tenantRef: acme, ref: 'south', name: 'South' }));
    const room = await as(acme, (scoped) =>
      scoped.createResource({ tenantRef: acme, externalRef: 'room-1', location: 'leeds' }),
    );
    expect(room).toMatchObject({ location: 'leeds', locationName: 'Leeds', timezone: 'Europe/London' });
    // A time zone given wins over the location's.
    expect(
      await as(acme, (scoped) =>
        scoped.createResource({ tenantRef: acme, externalRef: 'room-2', location: 'leeds', timezone: 'Asia/Tokyo' }),
      ),
    ).toMatchObject({ timezone: 'Asia/Tokyo' });
    const van = await as(acme, (scoped) => scoped.createResource({ tenantRef: acme, externalRef: 'van', timezone: 'UTC' }));
    expect(van).not.toHaveProperty('location');
    await expect(
      as(acme, (scoped) => scoped.createResource({ tenantRef: acme, externalRef: 'x', location: 'missing' })),
    ).rejects.toMatchObject({ code: 'location_not_found' });
    const list = (location: string) =>
      as(acme, (scoped) => scoped.listResources({ tenantRef: acme, location })).then((resources) =>
        resources.map((resource) => resource.externalRef).sort(),
      );
    expect(await list('north')).toEqual(['room-1', 'room-2']);
    expect(await list('leeds')).toEqual(['room-1', 'room-2']);
    expect(await list('south')).toEqual([]);
    // Moved, and moved off: the feed says where it was and where it went.
    expect(
      await as(acme, (scoped) => scoped.updateResourceProfile({ tenantRef: acme, id: van.id, profile: {}, location: 'south' })),
    ).toMatchObject({ location: 'south', locationName: 'South' });
    expect(await list('south')).toEqual(['van']);
    await expect(
      as(acme, (scoped) => scoped.updateResourceProfile({ tenantRef: acme, id: van.id, profile: {}, location: 'missing' })),
    ).rejects.toMatchObject({ code: 'location_not_found' });
    const moved = await as(acme, (scoped) =>
      scoped.updateResourceProfile({ tenantRef: acme, id: van.id, profile: {}, location: null }),
    );
    expect(moved).not.toHaveProperty('location');
    const feed = await admin<{ data: { before?: unknown; after?: unknown } }[]>`
      SELECT data FROM slotlock.outbox
       WHERE tenant_ref = ${acme} AND resource_id = ${van.id} AND type = 'resource.updated' ORDER BY txid, id`;
    expect(feed.map((row) => [row.data.before, row.data.after])).toEqual([
      [{ location: null }, { location: 'south' }],
      [{ location: 'south' }, { location: null }],
    ]);
    // In use: neither the location a resource is at, nor one with a location under it, goes.
    await expect(as(acme, (scoped) => scoped.deleteLocation({ tenantRef: acme, ref: 'leeds' }))).rejects.toMatchObject({
      code: 'location_in_use',
    });
    await expect(as(acme, (scoped) => scoped.deleteLocation({ tenantRef: acme, ref: 'north' }))).rejects.toMatchObject({
      code: 'location_in_use',
    });
    expect(await as(acme, (scoped) => scoped.deleteLocation({ tenantRef: acme, ref: 'south' }))).toBe(true);
    expect(await as(acme, (scoped) => scoped.deleteLocation({ tenantRef: acme, ref: 'south' }))).toBe(false);
    expect((await as(acme, (scoped) => scoped.listLocations({ tenantRef: acme }))).find((place) => place.ref === 'leeds')).toMatchObject({
      resources: 2,
    });
  });

  it('keeps groups and their members, at most 20 groups a resource', async () => {
    const acme = tenant('sets');
    const [a, b] = await Promise.all(
      ['dr-a', 'dr-b'].map((externalRef) => as(acme, (scoped) => scoped.createResource({ tenantRef: acme, externalRef }))),
    );
    if (!a || !b) throw new Error('resources');
    expect(
      await as(acme, (scoped) =>
        scoped.putGroup({ tenantRef: acme, ref: 'physio', name: 'Physiotherapy', description: 'The physio team' }),
      ),
    ).toEqual({ ref: 'physio', name: 'Physiotherapy', description: 'The physio team', members: 0 });
    await as(acme, (scoped) => scoped.putGroup({ tenantRef: acme, ref: 'saturday', name: 'Saturday clinic' }));
    const add = (group: string, resourceId: string) =>
      as(acme, (scoped) => scoped.addGroupMember({ tenantRef: acme, group, resourceId }));
    expect(await add('physio', a.id)).toBe(true);
    expect(await add('physio', a.id)).toBe(false);
    expect(await add('physio', b.id)).toBe(true);
    expect(await add('saturday', a.id)).toBe(true);
    expect(await as(acme, (scoped) => scoped.getResource({ tenantRef: acme, id: a.id }))).toMatchObject({
      groups: ['physio', 'saturday'],
    });
    const list = (group: string) =>
      as(acme, (scoped) => scoped.listResources({ tenantRef: acme, group })).then((resources) =>
        resources.map((resource) => resource.externalRef).sort(),
      );
    expect(await list('physio')).toEqual(['dr-a', 'dr-b']);
    expect(await list('saturday')).toEqual(['dr-a']);
    expect(await as(acme, (scoped) => scoped.listGroups({ tenantRef: acme }))).toEqual([
      { ref: 'physio', name: 'Physiotherapy', description: 'The physio team', members: 2 },
      { ref: 'saturday', name: 'Saturday clinic', description: null, members: 1 },
    ]);
    // Renamed, its description kept.
    expect(await as(acme, (scoped) => scoped.putGroup({ tenantRef: acme, ref: 'physio', name: 'Physio' }))).toMatchObject({
      name: 'Physio',
      description: 'The physio team',
      members: 2,
    });
    expect(await as(acme, (scoped) => scoped.removeGroupMember({ tenantRef: acme, group: 'saturday', resourceId: a.id }))).toBe(true);
    expect(await as(acme, (scoped) => scoped.removeGroupMember({ tenantRef: acme, group: 'saturday', resourceId: a.id }))).toBe(false);
    await expect(add('missing', a.id)).rejects.toMatchObject({ code: 'group_not_found' });
    await expect(add('physio', randomUUID())).rejects.toMatchObject({ code: 'resource_not_found' });
    // Another tenant's resource is not one this tenant can add.
    const other = tenant('other');
    const theirs = await as(other, (scoped) => scoped.createResource({ tenantRef: other, externalRef: 'theirs' }));
    await expect(add('physio', theirs.id)).rejects.toMatchObject({ code: 'resource_not_found' });
    expect(await as(other, (scoped) => scoped.listGroups({ tenantRef: other }))).toEqual([]);
    // Twenty groups a resource; the twenty-first is refused, and adding it again to one it is in is not.
    for (let i = 1; i <= 19; i += 1) {
      await as(acme, (scoped) => scoped.putGroup({ tenantRef: acme, ref: `g${i}`, name: `Group ${i}` }));
      await add(`g${i}`, b.id);
    }
    await as(acme, (scoped) => scoped.putGroup({ tenantRef: acme, ref: 'g20', name: 'Group 20' }));
    await expect(add('g20', b.id)).rejects.toMatchObject({ code: 'resource_group_limit_reached' });
    expect(await add('g19', b.id)).toBe(false);
    // A group deleted leaves its resources as they were.
    expect(await as(acme, (scoped) => scoped.deleteGroup({ tenantRef: acme, ref: 'physio' }))).toBe(true);
    expect(await as(acme, (scoped) => scoped.getResource({ tenantRef: acme, id: a.id }))).not.toHaveProperty('groups');
    expect(await as(acme, (scoped) => scoped.deleteGroup({ tenantRef: acme, ref: 'physio' }))).toBe(false);
    // A resource deleted leaves its groups.
    await as(acme, (scoped) => scoped.deleteResource({ tenantRef: acme, id: b.id }));
    expect((await as(acme, (scoped) => scoped.listGroups({ tenantRef: acme }))).find((group) => group.ref === 'g1')).toMatchObject({
      members: 0,
    });
    await expect(as(acme, (scoped) => scoped.putGroup({ tenantRef: acme, ref: 'Bad', name: 'x' }))).rejects.toMatchObject({
      code: 'invalid_group',
    });
  });

  it('serves locations and groups over the application API, and lets agents find resources by them', async () => {
    const acme = tenant('api');
    const application = createSlotlockStoreApplicationBackend(store);
    const agents = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] });
    const as_ = <T extends string>(operation: T) => ({
      principal: { subject: 'key:app', tenantRef: acme, scopes: ['read', 'write', 'admin'] },
      operation,
      signal: new AbortController().signal,
    });
    expect(
      await application.createLocation(as_('slotlock_create_location'), {
        ref: 'heathrow',
        name: 'Heathrow branch',
        timezone: 'Europe/London',
      }),
    ).toEqual({
      location: { ref: 'heathrow', name: 'Heathrow branch', parent_ref: null, timezone: 'Europe/London', resources: 0 },
    });
    await application.createLocation(as_('slotlock_create_location'), { ref: 'heathrow.t5', name: 'Terminal 5', parent_ref: 'heathrow' });
    const van = (await application.createResource(as_('slotlock_create_resource'), {
      external_ref: 'van-ev-1',
      location: 'heathrow.t5',
      kind: 'vehicle',
      labels: ['ev'],
    })) as { resource: { id: string; timezone: string; location: string } };
    // No time zone given: the nearest its location, or one above it, has.
    expect(van.resource).toMatchObject({ timezone: 'Europe/London', location: 'heathrow.t5', groups: [] });
    await application.createResource(as_('slotlock_create_resource'), { external_ref: 'van-diesel', timezone: 'UTC' });
    await application.createGroup(as_('slotlock_create_group'), { ref: 'airport-vans', name: 'Airport vans' });
    expect(
      await application.addGroupMember(as_('slotlock_add_group_member'), { group_ref: 'airport-vans', resource_id: van.resource.id }),
    ).toEqual({ added: true });
    expect(await application.listGroups(as_('slotlock_list_groups'), {})).toEqual({
      groups: [{ ref: 'airport-vans', name: 'Airport vans', description: null, members: 1 }],
    });
    expect(await application.listLocations(as_('slotlock_list_locations'), {})).toMatchObject({
      locations: [
        { ref: 'heathrow', resources: 0 },
        { ref: 'heathrow.t5', parent_ref: 'heathrow', resources: 1 },
      ],
    });
    const find = async (input: Record<string, unknown>) =>
      (
        (await agents.listResources(as_('slotlock_list_resources'), { limit: 50, ...input })) as {
          resources: { external_ref: string; location?: unknown; groups?: unknown }[];
        }
      ).resources;
    expect(await find({ location: 'heathrow' })).toEqual([
      expect.objectContaining({
        external_ref: 'van-ev-1',
        location: { ref: 'heathrow.t5', name: 'Terminal 5' },
        groups: ['airport-vans'],
      }),
    ]);
    expect((await find({ group: 'airport-vans', labels: ['ev'] })).map((resource) => resource.external_ref)).toEqual(['van-ev-1']);
    expect(await find({ location: 'nowhere' })).toEqual([]);
    // In a pool, the same filters apply.
    await application.setResourcePool(as_('slotlock_set_resource_pool'), { resource_id: van.resource.id, pool: 'van' });
    expect((await find({ pool: 'van', location: 'heathrow' })).map((resource) => resource.external_ref)).toEqual(['van-ev-1']);
    expect(await find({ pool: 'van', group: 'missing' })).toEqual([]);
    // Refusals, with their status.
    await expect(
      application.deleteLocation(as_('slotlock_delete_location'), { location_ref: 'heathrow' }),
    ).rejects.toMatchObject({ code: 'location_in_use', status: 409 });
    await expect(
      application.updateLocation(as_('slotlock_update_location'), { location_ref: 'heathrow', parent_ref: 'heathrow.t5' }),
    ).rejects.toMatchObject({ code: 'location_cycle', status: 409 });
    await expect(
      application.updateLocation(as_('slotlock_update_location'), { location_ref: 'missing', name: 'x' }),
    ).rejects.toMatchObject({ code: 'location_not_found', status: 404 });
    await expect(
      application.createResource(as_('slotlock_create_resource'), { external_ref: 'x', location: 'missing' }),
    ).rejects.toMatchObject({ code: 'location_not_found', status: 404 });
    await expect(
      application.addGroupMember(as_('slotlock_add_group_member'), { group_ref: 'missing', resource_id: van.resource.id }),
    ).rejects.toMatchObject({ code: 'group_not_found', status: 404 });
    await expect(
      application.createLocation(as_('slotlock_create_location'), { ref: 'x', name: 'x', timezone: 'Mars/Base' }),
    ).rejects.toMatchObject({ code: 'invalid_location', status: 400, details: { field: 'timezone' } });
    // Moved off its location, it can go.
    expect(
      await application.updateResource(as_('slotlock_update_resource'), { resource_id: van.resource.id, location: null }),
    ).toMatchObject({ resource: { location: null } });
    expect(await application.deleteLocation(as_('slotlock_delete_location'), { location_ref: 'heathrow.t5' })).toEqual({ deleted: true });
    expect(
      await application.removeGroupMember(as_('slotlock_remove_group_member'), { group_ref: 'airport-vans', resource_id: van.resource.id }),
    ).toEqual({ removed: true });
    expect(await application.deleteGroup(as_('slotlock_delete_group'), { group_ref: 'airport-vans' })).toEqual({ deleted: true });
  });

  it('searches the resources a selection names, by location, group, labels, kind or pool, never partially', async () => {
    const acme = tenant('select');
    const make = (externalRef: string, extra: Record<string, unknown> = {}) =>
      as(acme, (scoped) => scoped.createResource({ tenantRef: acme, externalRef, timezone: 'UTC', ...extra }));
    await as(acme, (scoped) => scoped.putLocation({ tenantRef: acme, ref: 'leeds', name: 'Leeds' }));
    await as(acme, (scoped) => scoped.putLocation({ tenantRef: acme, ref: 'leeds.2', name: 'Floor 2', parentRef: 'leeds' }));
    await as(acme, (scoped) => scoped.putGroup({ tenantRef: acme, ref: 'physio', name: 'Physio' }));
    const a = await make('room-a', { location: 'leeds.2', profile: { kind: 'room', labels: ['video'] } });
    const b = await make('room-b', { location: 'leeds', profile: { kind: 'room' } });
    const c = await make('dr-c', { profile: { kind: 'person' } });
    await make('private-room', { location: 'leeds', visibility: 'private', profile: { kind: 'room' } });
    const archived = await make('old-room', { location: 'leeds', profile: { kind: 'room' } });
    await as(acme, (scoped) => scoped.archiveResource({ tenantRef: acme, id: archived.id }));
    await as(acme, (scoped) => scoped.addGroupMember({ tenantRef: acme, group: 'physio', resourceId: c.id }));
    await as(acme, (scoped) => scoped.setResourcePool({ tenantRef: acme, id: b.id, pool: 'rooms' }));
    const backend = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] });
    const principal = { subject: 'agent', tenantRef: acme, scopes: ['read', 'write'] };
    const call = (operation: string, input: Record<string, unknown>) =>
      invokeSlotlockAgentOperation({
        operation,
        input,
        request: new Request('http://localhost/mcp'),
        options: { backend, authenticate: async () => principal, authorize: async () => true },
      });
    const start = new Date(Date.now() + 86_400_000);
    start.setUTCHours(0, 0, 0, 0);
    const window = { start: start.toISOString(), end: new Date(start.getTime() + 86_400_000).toISOString() };
    const sorted = (ids: string[]) => [...ids].sort();
    // Every location in Leeds; never a private or archived one.
    const busy = await call('slotlock_get_free_busy', { location: 'leeds', ...window });
    expect(busy).toMatchObject({ ok: true });
    const data = (busy as unknown as { data: { resources: { resource_id: string }[]; selected_resource_ids: string[] } }).data;
    expect(data.selected_resource_ids).toEqual(sorted([a.id, b.id]));
    expect(data.resources.map((resource) => resource.resource_id)).toEqual(data.selected_resource_ids);
    // By kind and labels, group and pool, each alone or together.
    const selected = async (input: Record<string, unknown>) =>
      ((await call('slotlock_get_free_busy', { ...input, ...window })) as unknown as { data?: { selected_resource_ids: string[] } }).data
        ?.selected_resource_ids;
    expect(await selected({ kind: 'room', labels: ['video'] })).toEqual([a.id]);
    expect(await selected({ group: 'physio' })).toEqual([c.id]);
    expect(await selected({ pool: 'rooms' })).toEqual([b.id]);
    expect(await selected({ kind: 'room', location: 'leeds.2' })).toEqual([a.id]);
    // The other two searches take it too, and say what they covered.
    const next = await call('slotlock_find_next_available', { kind: 'room', ...window, duration_minutes: 60 });
    expect(next).toMatchObject({ ok: true, data: { selected_resource_ids: sorted([a.id, b.id]) } });
    const slots = await call('slotlock_find_available_slots', { group: 'physio', ...window, duration_minutes: 60 });
    expect(slots).toMatchObject({ ok: true, data: { selected_resource_ids: [c.id] } });
    // None selected; both or neither of names and a selection; a bad criterion.
    expect(await call('slotlock_get_free_busy', { group: 'nobody', ...window })).toMatchObject({
      ok: false,
      status: 404,
      code: 'selection_empty',
    });
    for (const input of [{ resource_ids: [a.id], kind: 'room' }, {}]) {
      expect(await call('slotlock_get_free_busy', { ...input, ...window }), JSON.stringify(input)).toMatchObject({
        ok: false,
        code: 'invalid_arguments',
      });
    }
    expect(await call('slotlock_get_free_busy', { kind: 'spaceship', ...window })).toMatchObject({
      ok: false,
      code: 'invalid_arguments',
    });
    // Past an operation's limit, refused whole: slots search at most 20.
    for (let i = 0; i < 20; i += 1) await make(`desk-${i}`, { profile: { kind: 'desk' } });
    expect(await selected({ kind: 'desk' })).toHaveLength(20);
    await make('desk-20', { profile: { kind: 'desk' } });
    expect(await call('slotlock_find_available_slots', { kind: 'desk', ...window, duration_minutes: 60 })).toMatchObject({
      ok: false,
      status: 400,
      code: 'selection_too_large',
      details: { limit: '20' },
    });
    expect(await selected({ kind: 'desk' })).toHaveLength(21);
    // A backend that cannot select says so.
    const { selectResources: _unused, ...plain } = backend;
    expect(
      await invokeSlotlockAgentOperation({
        operation: 'slotlock_get_free_busy',
        input: { kind: 'room', ...window },
        request: new Request('http://localhost/mcp'),
        options: { backend: plain, authenticate: async () => principal, authorize: async () => true },
      }),
    ).toMatchObject({ ok: false, code: 'selection_not_supported' });
  });

  it('sends a filtered webhook only the changes about the resources it names, by id, pool, location or group', async () => {
    const acme = tenant('hooks');
    await as(acme, (scoped) => scoped.putLocation({ tenantRef: acme, ref: 'north', name: 'North' }));
    await as(acme, (scoped) => scoped.putLocation({ tenantRef: acme, ref: 'leeds', name: 'Leeds', parentRef: 'north' }));
    await as(acme, (scoped) => scoped.putGroup({ tenantRef: acme, ref: 'team', name: 'Team' }));
    const make = (externalRef: string, extra: Record<string, unknown> = {}) =>
      as(acme, (scoped) => scoped.createResource({ tenantRef: acme, externalRef, timezone: 'UTC', ...extra }));
    const placed = await make('at-leeds', { location: 'leeds' });
    const pooled = await make('in-vans');
    await as(acme, (scoped) => scoped.setResourcePool({ tenantRef: acme, id: pooled.id, pool: 'vans' }));
    const grouped = await make('in-team');
    await as(acme, (scoped) => scoped.addGroupMember({ tenantRef: acme, group: 'team', resourceId: grouped.id }));
    const named = await make('named');
    const create = (url: string, extra: Record<string, unknown>) =>
      as(acme, (scoped) => scoped.createWebhookEndpoint({ tenantRef: acme, url, ...extra }));
    const endpoint = async (url: string, extra: Record<string, unknown>) => {
      const created = await create(url, extra);
      if (!created.ok) throw new Error(created.code);
      return created.endpoint;
    };
    const byLocation = await endpoint('https://example.com/north', { filter: { locations: ['north'] } });
    const byPool = await endpoint('https://example.com/vans', { filter: { pools: ['vans'] } });
    const byGroup = await endpoint('https://example.com/team', { filter: { groups: ['team'] } });
    const byId = await endpoint('https://example.com/named', {
      filter: { resourceIds: [named.id.toUpperCase()] },
      eventTypes: ['resource.updated'],
    });
    const everything = await endpoint('https://example.com/all', {});
    expect(byLocation.filter).toEqual({ locations: ['north'] });
    expect(byId.filter).toEqual({ resourceIds: [named.id] });
    expect(everything).not.toHaveProperty('filter');
    // From now on: a change about each resource, and one about none (a key).
    for (const resource of [placed, pooled, grouped, named]) {
      await as(acme, (scoped) =>
        scoped.updateResourceProfile({ tenantRef: acme, id: resource.id, profile: { name: `Name of ${resource.externalRef}` } }),
      );
    }
    await createSlotlockApiKeyStore(application).create({ tenantRef: acme, name: 'agent', scopes: ['read'] });
    const claims = await as(acme, (scoped) => scoped.claimWebhookDeliveries({ tenantRef: acme, leaseMs: 30_000, batch: 100 }));
    const delivered = (id: string) =>
      claims
        .find((claim) => claim.endpoint.id === id)
        ?.changes.map((change) => `${change.type} ${change.resourceId ?? '-'}`) ?? [];
    expect(delivered(byLocation.id)).toEqual([`resource.updated ${placed.id}`]);
    expect(delivered(byPool.id)).toEqual([`resource.updated ${pooled.id}`]);
    expect(delivered(byGroup.id)).toEqual([`resource.updated ${grouped.id}`]);
    expect(delivered(byId.id)).toEqual([`resource.updated ${named.id}`]);
    // Unfiltered, it gets everything from its own creation on.
    expect(delivered(everything.id)).toEqual([
      'webhook.created -',
      `resource.updated ${placed.id}`,
      `resource.updated ${pooled.id}`,
      `resource.updated ${grouped.id}`,
      `resource.updated ${named.id}`,
      'key.created -',
    ]);
    // Listed with the filter, and the feed says what each was made to receive.
    const listed = await as(acme, (scoped) => scoped.listWebhookEndpoints({ tenantRef: acme }));
    expect(listed.find((hook) => hook.id === byPool.id)?.filter).toEqual({ pools: ['vans'] });
    const [created] = await admin<{ data: Record<string, unknown> }[]>`
      SELECT data FROM slotlock.outbox WHERE tenant_ref = ${acme} AND type = 'webhook.created' AND subject = ${byGroup.id}`;
    expect(created?.data).toMatchObject({ filter: { groups: ['team'] } });
    // Out of bounds: refused whole.
    for (const filter of [
      { resourceIds: ['not-a-uuid'] },
      { pools: ['Bad Pool'] },
      { locations: Array.from({ length: 21 }, (_, i) => `l${i}`) },
      { groups: 'team' },
    ]) {
      expect(await create('https://example.com/bad', { filter }), JSON.stringify(filter)).toEqual({
        ok: false,
        code: 'invalid_webhook_filter',
      });
    }
  });

  it('records a resource joining or leaving a group on the feed, with its groups before and after', async () => {
    const acme = tenant('membership');
    for (const ref of ['quiet', 'team', 'video']) {
      await as(acme, (scoped) => scoped.putGroup({ tenantRef: acme, ref, name: ref }));
    }
    const make = (externalRef: string) =>
      as(acme, (scoped) => scoped.createResource({ tenantRef: acme, externalRef, timezone: 'UTC' }));
    const room = await make('room-1');
    const other = await make('room-2');
    const quietOnly = await as(acme, (scoped) =>
      scoped.createWebhookEndpoint({ tenantRef: acme, url: 'https://example.com/quiet', filter: { groups: ['quiet'] } }),
    );
    if (!quietOnly.ok) throw new Error(quietOnly.code);
    // As an API key would, so the change names who made it.
    const member = (change: 'add' | 'remove', group: string, resourceId: string) =>
      store.withTenant(
        acme,
        (scoped) =>
          change === 'add'
            ? scoped.addGroupMember({ tenantRef: acme, group, resourceId })
            : scoped.removeGroupMember({ tenantRef: acme, group, resourceId }),
        { origin: 'application', actor: 'key:membership' },
      );
    const changes = async () =>
      (
        await admin<{ resource_id: string; data: { reference: string; before: unknown; after: unknown }; actor: string | null; origin: string }[]>`
          SELECT resource_id::text, data, actor, origin FROM slotlock.outbox
           WHERE tenant_ref = ${acme} AND type = 'resource.updated' ORDER BY id`
      ).map((row) => ({ ...row.data, resource: row.resource_id, actor: row.actor, origin: row.origin }));

    expect(await member('add', 'team', room.id)).toBe(true);
    expect(await member('add', 'video', room.id)).toBe(true);
    // Already in it: no row changes, and nothing is recorded.
    expect(await member('add', 'team', room.id)).toBe(false);
    await member('add', 'team', other.id);
    await member('add', 'video', other.id);
    expect(await member('remove', 'team', room.id)).toBe(true);
    expect(await member('remove', 'team', room.id)).toBe(false);
    expect(await changes()).toEqual([
      { id: room.id, reference: 'room-1', before: { groups: [] }, after: { groups: ['team'] }, resource: room.id, actor: 'key:membership', origin: 'application' },
      { id: room.id, reference: 'room-1', before: { groups: ['team'] }, after: { groups: ['team', 'video'] }, resource: room.id, actor: 'key:membership', origin: 'application' },
      { id: other.id, reference: 'room-2', before: { groups: [] }, after: { groups: ['team'] }, resource: other.id, actor: 'key:membership', origin: 'application' },
      { id: other.id, reference: 'room-2', before: { groups: ['team'] }, after: { groups: ['team', 'video'] }, resource: other.id, actor: 'key:membership', origin: 'application' },
      { id: room.id, reference: 'room-1', before: { groups: ['team', 'video'] }, after: { groups: ['video'] }, resource: room.id, actor: 'key:membership', origin: 'application' },
    ]);

    // A group deleted takes each of its resources out of it: one change for each, in one statement.
    const seen = (await changes()).length;
    expect(await as(acme, (scoped) => scoped.deleteGroup({ tenantRef: acme, ref: 'video' }))).toBe(true);
    const afterDelete = (await changes()).slice(seen);
    expect(afterDelete.map(({ resource, before, after }) => ({ resource, before, after }))).toEqual(
      [
        { resource: room.id, before: { groups: ['video'] }, after: { groups: [] } },
        { resource: other.id, before: { groups: ['team', 'video'] }, after: { groups: ['team'] } },
      ].sort((a, b) => (a.resource < b.resource ? -1 : 1)),
    );
    // A resource deleted leaves its groups without a change of its own: resource.deleted says it.
    const before = (await changes()).length;
    expect(await as(acme, (scoped) => scoped.deleteResource({ tenantRef: acme, id: other.id }))).toMatchObject({ ok: true });
    expect(await changes()).toHaveLength(before);

    // A webhook filtered by a group gets a resource joining it, delivered while it is in it. (A
    // filter matches a resource as it is when the change is delivered, so a resource that has left
    // the group by then is not sent its leaving, or a joining it has since undone.)
    await member('add', 'quiet', room.id);
    const claims = await as(acme, (scoped) => scoped.claimWebhookDeliveries({ tenantRef: acme, leaseMs: 30_000, batch: 100 }));
    const delivered = claims.find((claim) => claim.endpoint.id === quietOnly.endpoint.id)?.changes ?? [];
    // Every change about the room since the endpoint was made, the room being in the group now;
    // none about the deleted resource, which is in no group.
    expect(delivered.every((change) => change.resourceId === room.id)).toBe(true);
    expect(delivered.at(-1)?.data).toMatchObject({ before: { groups: [] }, after: { groups: ['quiet'] } });

    // Made as the schema owner too, as a cascade's trigger runs on PostgreSQL 18, outside erasure.
    const owner = createSlotlockStore(admin);
    const recorded = (await changes()).length;
    await owner.withTenant(acme, (scoped) => scoped.addGroupMember({ tenantRef: acme, group: 'team', resourceId: room.id }));
    await owner.withTenant(acme, (scoped) => scoped.deleteGroup({ tenantRef: acme, ref: 'team' }));
    expect((await changes()).slice(recorded).map(({ before, after }) => ({ before, after }))).toEqual([
      { before: { groups: ['quiet'] }, after: { groups: ['quiet', 'team'] } },
      { before: { groups: ['quiet', 'team'] }, after: { groups: ['quiet'] } },
    ]);
  });

  it("erases a tenant's locations, groups and memberships with it, and keeps them from other tenants", async () => {
    const acme = tenant('erased');
    await as(acme, (scoped) => scoped.putLocation({ tenantRef: acme, ref: 'site', name: 'Site' }));
    await as(acme, (scoped) => scoped.putLocation({ tenantRef: acme, ref: 'site.1', name: 'Floor 1', parentRef: 'site' }));
    const room = await as(acme, (scoped) => scoped.createResource({ tenantRef: acme, externalRef: 'r', location: 'site.1' }));
    await as(acme, (scoped) => scoped.putGroup({ tenantRef: acme, ref: 'team', name: 'Team' }));
    await as(acme, (scoped) => scoped.addGroupMember({ tenantRef: acme, group: 'team', resourceId: room.id }));
    for (const table of ['locations', 'resource_groups', 'resource_group_members']) {
      expect(await application.unsafe(`SELECT * FROM slotlock.${table}`), `${table} without a tenant`).toEqual([]);
    }
    const erased = await store.eraseTenant({ tenantRef: acme });
    expect(erased.rows).toMatchObject({ locations: 2, resource_groups: 1, resource_group_members: 1, resources: 1 });
    const [left] = await admin<{ count: number }[]>`
      SELECT (SELECT count(*) FROM slotlock.locations WHERE tenant_ref = ${acme})
           + (SELECT count(*) FROM slotlock.resource_groups WHERE tenant_ref = ${acme})::int AS count`;
    expect(Number(left?.count)).toBe(0);
  });
});
