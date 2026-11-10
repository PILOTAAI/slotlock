// Where resources are, and the sets they are in (RFC 0003 G2, G3), against real Postgres as the
// LOGIN role grantApplicationRole grants: a location tree held to its depth, free of loops and kept
// while in use; a resource taking its location's time zone and found under any location above it;
// groups and their members, held to their counts; each tenant seeing only its own; all erased with
// it. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreApplicationBackend,
} from '../agent-store-backend.js';
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
