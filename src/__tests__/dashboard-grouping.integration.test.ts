// Locations and groups in the dashboard (RFC 0003 G2, G3), as the LOGIN role grantApplicationRole
// grants, through createSlotlockDashboardResources; GitHub is a fake `fetch`. Skipped without
// DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSlotlockApiKeyStore } from '../api-keys.js';
import {
  createSlotlockDashboard,
  createSlotlockDashboardResources,
  createSlotlockDashboardState,
} from '../dashboard.js';
import { createSlotlockStore } from '../store.js';

const url = process.env.DATABASE_URL?.trim() || process.env.DATABASE_URL_DIRECT?.trim();
const ORIGIN = 'https://slotlock.example.com';

describe.skipIf(!url)('dashboard locations and groups (real Postgres)', () => {
  const role = `slotlock_dgrp_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const password = randomBytes(24).toString('hex');
  const githubId = 900_000 + Math.floor(Math.random() * 99_999);
  const tenantRef = `github:${githubId}`;
  const otherTenant = `github:${githubId + 1}`;
  let admin: ReturnType<typeof postgres>;
  let application: ReturnType<typeof postgres>;

  beforeAll(async () => {
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const owner = createSlotlockStore(admin);
    await owner.applySchema();
    await owner.applyTenantRls();
    await admin.unsafe(
      `CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    );
    await owner.grantApplicationRole(role);
    application = postgres(
      Object.assign(new URL(url as string), { username: role, password }).href,
      { max: 2, onnotice: () => {} },
    );
  });

  afterAll(async () => {
    for (const tenant of [tenantRef, otherTenant]) {
      await admin`DELETE FROM slotlock.resource_group_members WHERE tenant_ref = ${tenant}`;
      await admin`DELETE FROM slotlock.resource_groups WHERE tenant_ref = ${tenant}`;
      await admin`DELETE FROM slotlock.resources WHERE tenant_ref = ${tenant}`;
      await admin`DELETE FROM slotlock.locations WHERE tenant_ref = ${tenant} AND parent_ref IS NOT NULL`;
      await admin`DELETE FROM slotlock.locations WHERE tenant_ref = ${tenant}`;
      await admin`DELETE FROM slotlock.outbox WHERE tenant_ref = ${tenant}`;
    }
    await application?.end({ timeout: 5 });
    await admin.unsafe(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end();
  });

  it('adds, moves and deletes locations and groups, and puts a resource in them, in one transaction', async () => {
    const store = createSlotlockStore(application);
    const dashboard = createSlotlockDashboard({
      publicUrl: ORIGIN,
      github: { clientId: 'Ov23liGrouping', clientSecret: randomBytes(20).toString('hex') },
      sessionSecret: randomBytes(32).toString('hex'),
      allowedUsers: [String(githubId)],
      keys: createSlotlockApiKeyStore(application),
      resources: createSlotlockDashboardResources(store),
      state: createSlotlockDashboardState(application),
      fetch: async (input) =>
        String(input).endsWith('/access_token')
          ? Response.json({ access_token: 'gho_fake' })
          : Response.json({ id: githubId, login: 'site-owner' }),
    });
    const get = (path: string, cookie?: string) =>
      dashboard.fetch(new Request(`${ORIGIN}${path}`, cookie ? { headers: { cookie } } : {}));
    const post = async (path: string, fields: Record<string, string> | URLSearchParams, cookie: string) => {
      const sent = new URLSearchParams(fields);
      const page = await (await get('/dashboard/keys', cookie)).text();
      sent.set('csrf', /name="csrf" value="([^"]+)"/.exec(page)?.[1] as string);
      sent.set('once', /name="once" value="([^"]+)"/.exec(page)?.[1] as string);
      return dashboard.fetch(
        new Request(`${ORIGIN}${path}`, {
          method: 'POST',
          headers: { cookie, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
          body: sent.toString(),
        }),
      );
    };
    const start = await get('/dashboard/sign-in');
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const pending = start.headers.getSetCookie()[0]?.split('; ')[0] as string;
    const callback = await get(`/dashboard/callback?code=c&state=${state}`, pending);
    const session = callback.headers
      .getSetCookie()
      .find((value) => value.startsWith('__Host-slotlock-session='))
      ?.split('; ')[0] as string;
    const page = async (path: string) => (await get(path, session)).text();
    const read = <T>(work: (tenant: Parameters<Parameters<typeof store.withTenant>[1]>[0]) => Promise<T>) =>
      store.withTenant(tenantRef, work);

    expect((await post('/dashboard/resources', { reference: 'room-1', timezone: 'UTC' }, session)).status).toBe(303);
    const [room] = await read((tenant) => tenant.listResources({ tenantRef, limit: 10 }));
    const id = room?.id as string;
    expect(await page('/dashboard/resources')).toContain('href="/dashboard/locations">Locations and groups</a>');
    // Nothing to choose yet: the resource page says where to add them.
    expect(await page(`/dashboard/resources/${id}`)).toContain('No locations or groups yet. <a href="/dashboard/locations">Add them</a>');

    // Locations: one at the top with a time zone, one inside it (its reference typed in capitals).
    expect((await post('/dashboard/locations', { ref: 'london', name: 'London', parent: '', timezone: 'Europe/London' }, session)).status).toBe(303);
    expect((await post('/dashboard/locations', { ref: 'FLOOR-3', name: 'Floor 3', parent: 'london', timezone: '' }, session)).status).toBe(303);
    expect(await read((tenant) => tenant.listLocations({ tenantRef }))).toEqual([
      { ref: 'london', name: 'London', parentRef: null, timezone: 'Europe/London', resources: 0 },
      { ref: 'floor-3', name: 'Floor 3', parentRef: 'london', timezone: null, resources: 0 },
    ]);
    const listed = await page('/dashboard/locations');
    expect(listed).toContain('<span class="meta">floor-3 · in London</span>');
    expect(listed).toContain('<span>Europe/London</span><span class="meta">from London</span>');
    // London's own edit form does not offer London, or Floor 3 inside it, as where London is.
    const londonEdit = listed.slice(listed.indexOf('name="ref" value="london"'), listed.indexOf('Save location'));
    expect(londonEdit).not.toContain('<option value="floor-3"');
    expect(londonEdit).not.toContain('<option value="london"');

    // Refused, in a person's words, changing nothing.
    const cycle = await post('/dashboard/locations', { ref: 'london', name: 'London', parent: 'floor-3', timezone: 'Europe/London' }, session);
    expect(cycle.status).toBe(409);
    expect(await cycle.text()).toContain('A location cannot be inside itself, or inside a location that is inside it.');
    const badRef = await post('/dashboard/locations', { ref: 'floor 4!', name: 'Floor 4', parent: '' }, session);
    expect(badRef.status).toBe(400);
    expect(await badRef.text()).toContain('A reference is 1 to 100 lowercase letters');
    const badZone = await post('/dashboard/locations', { ref: 'paris', name: 'Paris', parent: '', timezone: 'Mars/Olympus' }, session);
    expect(badZone.status).toBe(400);
    expect(await badZone.text()).toContain('A time zone is a name such as Europe/London.');
    const noParent = await post('/dashboard/locations', { ref: 'annex', name: 'Annex', parent: 'nowhere' }, session);
    expect(noParent.status).toBe(404);
    expect(await noParent.text()).toContain('That location is not one of yours.');
    expect(await read((tenant) => tenant.listLocations({ tenantRef }))).toHaveLength(2);

    // Groups.
    expect((await post('/dashboard/groups', { ref: 'video-rooms', name: 'Rooms with video', description: '' }, session)).status).toBe(303);
    expect((await post('/dashboard/groups', { ref: 'quiet', name: 'Quiet', description: 'No calls.' }, session)).status).toBe(303);
    expect(await page('/dashboard/locations')).toContain('<td data-label="Description" class="wrap">No calls.</td>');

    // The resource page puts the room on Floor 3 and in both groups, in one form.
    const detail = await page(`/dashboard/resources/${id}`);
    expect(detail).toContain('<option value="floor-3">London › Floor 3</option>');
    expect(detail).toContain('<input type="checkbox" name="group" value="video-rooms"> Rooms with video</label>');
    const placed = await post(
      '/dashboard/resources/place',
      new URLSearchParams([['id', id], ['location', 'floor-3'], ['group', 'video-rooms'], ['group', 'quiet']]),
      session,
    );
    expect(placed.status).toBe(303);
    const where = () => read((tenant) => tenant.getResource({ tenantRef, id }));
    expect(await where()).toMatchObject({ location: 'floor-3', groups: ['quiet', 'video-rooms'] });
    const shown = await page(`/dashboard/resources/${id}`);
    expect(shown).toContain('<dt>Location</dt><dd>London › Floor 3</dd><dt>Groups</dt><dd>Quiet, Rooms with video</dd>');
    expect(shown).toContain('<option value="floor-3" selected>');
    expect(shown).toContain('value="quiet" checked>');
    // Recorded as the person, on the feed: the move, then each group it joined, newest first.
    const changes = await read((tenant) => tenant.listRecentChanges({ tenantRef, limit: 20 }));
    expect(
      changes
        .filter((change) => change.type === 'resource.updated' && change.resourceId === id)
        .slice(0, 3)
        .map(({ actor, origin, data }) => ({ actor, origin, after: data.after })),
    ).toEqual([
      { actor: tenantRef, origin: 'dashboard', after: { groups: ['quiet', 'video-rooms'] } },
      { actor: tenantRef, origin: 'dashboard', after: { groups: ['video-rooms'] } },
      { actor: tenantRef, origin: 'dashboard', after: { location: 'floor-3' } },
    ]);

    // A group that is not the tenant's refuses the whole form: the location stays.
    const unknown = await post(
      '/dashboard/resources/place',
      new URLSearchParams([['id', id], ['location', ''], ['group', 'nope']]),
      session,
    );
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('That group is not one of yours.');
    expect(await where()).toMatchObject({ location: 'floor-3', groups: ['quiet', 'video-rooms'] });
    // Another tenant's location is not one of this tenant's.
    await store.withTenant(otherTenant, (tenant) =>
      tenant.putLocation({ tenantRef: otherTenant, ref: 'their-site', name: 'Their site' }),
    );
    const theirs = await post('/dashboard/resources/place', { id, location: 'their-site' }, session);
    expect(theirs.status).toBe(404);
    expect(await theirs.text()).toContain('That location is not one of yours.');
    // More groups than a resource may be in, refused before the store is asked.
    const many = new URLSearchParams([['id', id]]);
    for (let n = 0; n < 21; n += 1) many.append('group', `g-${n}`);
    const tooMany = await post('/dashboard/resources/place', many, session);
    expect(tooMany.status).toBe(409);
    expect(await tooMany.text()).toContain('A resource is in 20 groups at most.');

    // A location in use, or with one inside it, is not deleted.
    const inUse = await post('/dashboard/locations/delete', { ref: 'floor-3' }, session);
    expect(inUse.status).toBe(409);
    expect(await inUse.text()).toContain('Move its resources, and the locations inside it, somewhere else first.');
    expect((await post('/dashboard/locations/delete', { ref: 'london' }, session)).status).toBe(409);

    // Moved out, and out of every group: then both go.
    expect((await post('/dashboard/resources/place', { id, location: '' }, session)).status).toBe(303);
    const cleared = await where();
    expect(cleared).not.toHaveProperty('location');
    expect(cleared).not.toHaveProperty('groups');
    expect((await post('/dashboard/locations/delete', { ref: 'floor-3' }, session)).status).toBe(303);
    expect((await post('/dashboard/locations/delete', { ref: 'london' }, session)).status).toBe(303);
    const gone = await post('/dashboard/locations/delete', { ref: 'london' }, session);
    expect(gone.status).toBe(404);
    expect(await read((tenant) => tenant.listLocations({ tenantRef }))).toEqual([]);

    // Renamed, then deleted, its resources left as they are.
    expect((await post('/dashboard/resources/place', new URLSearchParams([['id', id], ['group', 'quiet']]), session)).status).toBe(303);
    expect((await post('/dashboard/groups', { ref: 'quiet', name: 'Quiet rooms', description: '' }, session)).status).toBe(303);
    expect(await read((tenant) => tenant.listGroups({ tenantRef }))).toContainEqual({
      ref: 'quiet',
      name: 'Quiet rooms',
      description: null,
      members: 1,
    });
    expect((await post('/dashboard/groups/delete', { ref: 'quiet' }, session)).status).toBe(303);
    expect(await where()).not.toHaveProperty('groups');
    expect((await post('/dashboard/groups/delete', { ref: 'quiet' }, session)).status).toBe(404);
    expect(await read((tenant) => tenant.listResources({ tenantRef, limit: 10 }))).toHaveLength(1);
  });
});
