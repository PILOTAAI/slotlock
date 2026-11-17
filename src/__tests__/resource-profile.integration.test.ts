// A resource's profile (RFC 0003 G1) against real Postgres, as the LOGIN role grantApplicationRole
// grants: set when created, changed field by field, read back, filtered on, held to its bounds by
// the database too, and named on the feed by field only. Skipped without DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSlotlockStoreAgentBackend,
  createSlotlockStoreApplicationBackend,
} from '../agent-store-backend.js';
import { type SlotlockStore, createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();

describe.skipIf(!url)('resource profiles (real Postgres, application role)', () => {
  const role = `slotlock_profile_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const tenants: string[] = [];
  const tenant = (name: string) => {
    const ref = `profile-${name}-${randomUUID()}`;
    tenants.push(ref);
    return ref;
  };
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;
  let store: SlotlockStore;

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

  const feed = (tenantRef: string) =>
    admin<{ type: string; data: Record<string, unknown> }[]>`
      SELECT type, data FROM slotlock.outbox WHERE tenant_ref = ${tenantRef} ORDER BY txid, id`;

  it('sets a profile when a resource is created, and keeps the fields a repeat leaves out', async () => {
    const acme = tenant('create');
    const created = await store.withTenant(acme, (scoped) =>
      scoped.createResource({
        tenantRef: acme,
        externalRef: 'room-3',
        timezone: 'Europe/London',
        profile: {
          name: '  Room 3 ',
          description: 'Third floor, by the lifts.\nSeats ten.',
          kind: 'room',
          capacity: 10,
          labels: ['video', 'whiteboard', 'video'],
          attributes: { floor: 3, accessible: true, plan: 'https://example.com/3' },
        },
      }),
    );
    expect(created).toMatchObject({
      externalRef: 'room-3',
      name: 'Room 3',
      description: 'Third floor, by the lifts.\nSeats ten.',
      kind: 'room',
      capacity: 10,
      labels: ['video', 'whiteboard'],
      attributes: { floor: 3, accessible: true, plan: 'https://example.com/3' },
    });
    // Created again with a new name only: the rest stays.
    const again = await store.withTenant(acme, (scoped) =>
      scoped.createResource({
        tenantRef: acme,
        externalRef: 'room-3',
        timezone: 'Europe/London',
        profile: { name: 'Board room' },
      }),
    );
    expect(again).toMatchObject({ id: created.id, name: 'Board room', kind: 'room', capacity: 10 });
    expect(await store.withTenant(acme, (scoped) => scoped.getResource({ tenantRef: acme, id: created.id }))).toEqual(
      again,
    );
    // Created with none, a resource says nothing: no profile fields at all.
    const plain = await store.withTenant(acme, (scoped) =>
      scoped.createResource({ tenantRef: acme, externalRef: 'van-1', timezone: 'UTC' }),
    );
    for (const field of ['name', 'description', 'kind', 'capacity', 'labels', 'attributes']) {
      expect(plain, field).not.toHaveProperty(field);
    }
  });

  it('changes the fields given, clears with null, and names them on the feed without their values', async () => {
    const acme = tenant('update');
    const resource = await store.withTenant(acme, (scoped) =>
      scoped.createResource({
        tenantRef: acme,
        externalRef: 'dr-patel',
        profile: { name: 'Dr Asha Patel', kind: 'person', labels: ['physio'] },
      }),
    );
    const update = (profile: Parameters<SlotlockStore['updateResourceProfile']>[0]['profile']) =>
      store.withTenant(acme, (scoped) => scoped.updateResourceProfile({ tenantRef: acme, id: resource.id, profile }));
    expect(await update({ labels: ['physio', 'sports'], capacity: 1 })).toMatchObject({
      name: 'Dr Asha Patel',
      kind: 'person',
      capacity: 1,
      labels: ['physio', 'sports'],
    });
    const cleared = await update({ name: null, capacity: null, labels: [], kind: 'other' });
    for (const field of ['name', 'capacity', 'labels', 'kind']) expect(cleared, field).not.toHaveProperty(field);
    // The same values again change nothing, so the feed records nothing.
    await update({ name: null, labels: [] });
    const updates = (await feed(acme)).filter((row) => row.type === 'resource.updated');
    expect(updates.map((row) => row.data.profile_changed)).toEqual([
      ['capacity', 'labels'],
      ['name', 'kind', 'capacity', 'labels'],
    ]);
    // Never the values: a name names a person.
    expect(JSON.stringify(await feed(acme))).not.toContain('Asha');
    // Another tenant's resource is not found.
    expect(
      await store.withTenant(tenant('other'), (scoped) =>
        scoped.updateResourceProfile({ tenantRef: 'someone-else', id: resource.id, profile: { name: 'x' } }),
      ),
    ).toBeNull();
  });

  it('lists by kind and by labels, every label given', async () => {
    const acme = tenant('list');
    const make = (externalRef: string, profile: Parameters<SlotlockStore['createResource']>[0]['profile']) =>
      store.withTenant(acme, (scoped) => scoped.createResource({ tenantRef: acme, externalRef, ...(profile ? { profile } : {}) }));
    await make('van-ev', { kind: 'vehicle', labels: ['ev', 'lhr'] });
    await make('van-diesel', { kind: 'vehicle', labels: ['lhr'] });
    await make('room-1', { kind: 'room', labels: ['ev'] });
    await make('thing', undefined);
    const list = (filter: { kind?: 'vehicle' | 'room' | 'other'; labels?: string[] }) =>
      store
        .withTenant(acme, (scoped) => scoped.listResources({ tenantRef: acme, ...filter }))
        .then((resources) => resources.map((resource) => resource.externalRef).sort());
    expect(await list({ kind: 'vehicle' })).toEqual(['van-diesel', 'van-ev']);
    expect(await list({ labels: ['lhr'] })).toEqual(['van-diesel', 'van-ev']);
    expect(await list({ labels: ['ev', 'lhr'] })).toEqual(['van-ev']);
    expect(await list({ kind: 'room', labels: ['lhr'] })).toEqual([]);
    expect(await list({ kind: 'other' })).toEqual(['thing']);
    expect(await list({ labels: [] })).toHaveLength(4);
    await expect(list({ labels: ['Not A Label'] })).rejects.toMatchObject({ code: 'invalid_resource_profile' });
  });

  it('lets an agent find a resource by what a person calls it, and names candidates for a name given as an id', async () => {
    const acme = tenant('search');
    const make = (externalRef: string, name?: string, visibility: 'shared' | 'private' = 'shared') =>
      store.withTenant(acme, (scoped) =>
        scoped.createResource({ tenantRef: acme, externalRef, visibility, ...(name ? { profile: { name } } : {}) }),
      );
    const benz = await make('car-17', 'Mercedes-Benz 2025');
    await make('car-18', 'Mercedes-Benz 2019');
    await make('phase-b-exit-20261108T142642Z-3444');
    await make('car-99', 'Mercedes-Benz 2025 (owner only)', 'private');
    // Another tenant's resource of the same name is never found or named.
    const other = tenant('search-other');
    await store.withTenant(other, (scoped) =>
      scoped.createResource({ tenantRef: other, externalRef: 'theirs', profile: { name: 'Mercedes-Benz 2025' } }),
    );
    const agents = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] });
    const as = <T extends string>(operation: T) => ({
      principal: { subject: 'key:agent', tenantRef: acme, scopes: ['read'] },
      operation,
      signal: new AbortController().signal,
    });
    const search = async (query: string, filter: Record<string, unknown> = {}) =>
      (
        (await agents.listResources(as('slotlock_list_resources'), { limit: 50, query, ...filter })) as {
          resources: { id: string; name?: string; external_ref: string | null }[];
          next_cursor: string | null;
        }
      );
    const found = await search('mercedez benz 2025');
    expect(found.resources.map((resource) => resource.name)).toEqual(['Mercedes-Benz 2025', 'Mercedes-Benz 2019']);
    expect(found.resources[0]?.id).toBe(benz.id);
    expect(found.next_cursor).toBeNull();
    expect((await search('phase-b-exit')).resources.map((resource) => resource.external_ref)).toEqual([
      'phase-b-exit-20261108T142642Z-3444',
    ]);
    // A filter the resource does not state leaves it out; the search without it finds it.
    expect((await search('mercedes 2025', { kind: 'vehicle' })).resources).toEqual([]);
    expect((await search('tesla')).resources).toEqual([]);
    await expect(search('a b c d e f g h i j k l m')).rejects.toMatchObject({ code: 'invalid_arguments' });
    // A name or reference passed where an id belongs is refused, naming the likely resources.
    const window = { start: '2026-11-12T08:00:00Z', end: '2026-11-12T12:00:00Z' };
    await expect(
      agents.getFreeBusy(as('slotlock_get_free_busy'), { resource_ids: ['Mercedes-Benz 2025'], ...window }),
    ).rejects.toMatchObject({
      code: 'resource_not_found',
      details: { candidate_1: `${benz.id} Mercedes-Benz 2025`, candidate_2: expect.stringContaining('Mercedes-Benz 2019') },
    });
    const byRef = agents.getFreeBusy(as('slotlock_get_free_busy'), { resource_ids: ['phase-b-exit-20261108T142642Z-3444'], ...window });
    await expect(byRef).rejects.toMatchObject({ code: 'resource_not_found', details: { candidate_1: expect.stringContaining('phase-b-exit') } });
    // An id that names nothing (another tenant's, a deleted one) gets no candidates.
    await expect(
      agents.getFreeBusy(as('slotlock_get_free_busy'), { resource_ids: [randomUUID()], ...window }),
    ).rejects.toSatisfy((error: { code: string; details?: unknown }) => error.code === 'resource_not_found' && error.details === undefined);
  });

  it('takes a profile over the application API, and shows agents what they need to choose', async () => {
    const acme = tenant('api');
    const application = createSlotlockStoreApplicationBackend(store);
    const agents = createSlotlockStoreAgentBackend(store, { availabilityRules: async () => [] });
    const as = <T extends string>(operation: T) => ({
      principal: { subject: 'key:app', tenantRef: acme, scopes: ['read', 'write', 'admin'] },
      operation,
      signal: new AbortController().signal,
    });
    const created = (await application.createResource(as('slotlock_create_resource'), {
      external_ref: 'clinic-room-2',
      timezone: 'Europe/London',
      name: 'Treatment room 2',
      description: `${'Long. '.repeat(100)}end`,
      kind: 'room',
      capacity: 2,
      labels: ['physio', 'accessible'],
      attributes: { floor: 1, booking_code: 'TR2' },
    })) as { resource: Record<string, unknown> };
    expect(created.resource).toMatchObject({
      name: 'Treatment room 2',
      kind: 'room',
      capacity: 2,
      labels: ['accessible', 'physio'],
      attributes: { floor: 1, booking_code: 'TR2' },
    });
    const id = created.resource.id as string;
    await application.createResource(as('slotlock_create_resource'), { external_ref: 'plain', timezone: 'UTC' });
    const updated = (await application.updateResource(as('slotlock_update_resource'), {
      resource_id: id,
      capacity: null,
      labels: ['physio'],
    })) as { resource: Record<string, unknown> };
    expect(updated.resource).toMatchObject({ name: 'Treatment room 2', capacity: null, labels: ['physio'] });
    await expect(
      application.updateResource(as('slotlock_update_resource'), { resource_id: id, labels: ['No Good'] }),
    ).rejects.toMatchObject({ code: 'invalid_resource_profile', status: 400, details: { field: 'labels' } });
    await expect(
      application.updateResource(as('slotlock_update_resource'), { resource_id: randomUUID(), name: 'x' }),
    ).rejects.toMatchObject({ code: 'resource_not_found', status: 404 });
    // Agents see the name, kind, capacity and labels, a description cut at 500, and no attributes.
    const listed = (await agents.listResources(as('slotlock_list_resources'), { limit: 50 })) as {
      resources: Record<string, unknown>[];
    };
    const room = listed.resources.find((resource) => resource.id === id);
    expect(room).toMatchObject({ name: 'Treatment room 2', kind: 'room', labels: ['physio'] });
    expect(room).not.toHaveProperty('attributes');
    expect(room).not.toHaveProperty('capacity');
    expect([...(room?.description as string)].length).toBe(501);
    expect(listed.resources.find((resource) => resource.external_ref === 'plain')).toEqual({
      id: expect.any(String),
      external_ref: 'plain',
      timezone: 'UTC',
    });
    const filtered = (await agents.listResources(as('slotlock_list_resources'), {
      limit: 50,
      kind: 'room',
      labels: ['physio'],
    })) as { resources: { id: string }[] };
    expect(filtered.resources.map((resource) => resource.id)).toEqual([id]);
    // A confirmation names it as people know it.
    expect(await agents.describeResource?.(as('slotlock_list_resources'), id)).toEqual({
      name: 'Treatment room 2',
      timezone: 'Europe/London',
    });
  });

  it('refuses a profile outside its bounds, in the store and in the database', async () => {
    const acme = tenant('bounds');
    const resource = await store.withTenant(acme, (scoped) =>
      scoped.createResource({ tenantRef: acme, externalRef: 'press-1', profile: { kind: 'machine' } }),
    );
    for (const profile of [
      { name: '   ' },
      { name: 'x'.repeat(201) },
      { name: 'line\nbreak' },
      { description: 'x'.repeat(2_001) },
      { kind: 'spaceship' },
      { capacity: 0 },
      { capacity: 1.5 },
      { labels: ['UPPER'] },
      { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) },
      { attributes: [] },
      { attributes: { nested: { no: true } } },
      { attributes: Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, i])) },
      { attributes: { big: 'x'.repeat(1_000), more: 'x'.repeat(1_000), most: 'x'.repeat(1_000), all: 'x'.repeat(1_000), over: 'x'.repeat(100) } },
    ]) {
      await expect(
        store.withTenant(acme, (scoped) =>
          scoped.updateResourceProfile({ tenantRef: acme, id: resource.id, profile: profile as never }),
        ),
        JSON.stringify(profile).slice(0, 80),
      ).rejects.toMatchObject({ code: 'invalid_resource_profile' });
    }
    // A write that goes around the store meets the same bounds in the database.
    for (const change of [
      admin`UPDATE slotlock.resources SET kind = 'spaceship' WHERE id = ${resource.id}`,
      admin`UPDATE slotlock.resources SET labels = ARRAY['Bad Label'] WHERE id = ${resource.id}`,
      admin`UPDATE slotlock.resources SET capacity = 0 WHERE id = ${resource.id}`,
      admin`UPDATE slotlock.resources SET attributes = '[]'::jsonb WHERE id = ${resource.id}`,
      admin`UPDATE slotlock.resources SET name = '' WHERE id = ${resource.id}`,
    ]) {
      await expect(change).rejects.toMatchObject({ code: '23514' });
    }
    // A resource with no tenant takes no profile.
    await expect(store.createResource({ externalRef: `legacy-${randomUUID()}`, profile: { name: 'x' } })).rejects.toMatchObject({
      code: 'invalid_resource_profile',
    });
  });
});
