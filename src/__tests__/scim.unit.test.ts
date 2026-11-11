// SCIM requests as Okta and Microsoft Entra send them (scim.ts), normalised before anything is
// applied. The payloads are the vendors' own (Microsoft Learn "Known issues and resolutions with
// SCIM 2.0 protocol compliance", updated 2025-08-25; Okta SCIM 2.0 reference; both read 2026-11-11).
import { describe, expect, it } from 'vitest';
import {
  SCIM_PATCH_SCHEMA,
  type SlotlockScimUserAttributes,
  slotlockScimFilter,
  slotlockScimGroupFromBody,
  slotlockScimList,
  slotlockScimPage,
  slotlockScimPatchGroup,
  slotlockScimPatchOperations,
  slotlockScimPatchUser,
  slotlockScimUserFromBody,
  slotlockScimUserResource,
} from '../scim.js';

const patch = (...Operations: unknown[]) => ({ schemas: [SCIM_PATCH_SCHEMA], Operations });
const alice: SlotlockScimUserAttributes = {
  userName: 'Alice@Acme-Test.com',
  externalId: 'ext-1',
  active: true,
  givenName: 'Alice',
  familyName: 'Doe',
  displayName: 'Alice Doe',
  workEmail: 'alice@acme-test.com',
};
const apply = (body: unknown, user = alice) => slotlockScimPatchUser(user, 'u-1', slotlockScimPatchOperations(body));

describe('users', () => {
  it("reads Microsoft's sample create, keeping what Slotlock keeps and ignoring the enterprise extension", () => {
    const user = slotlockScimUserFromBody({
      schemas: [
        'urn:ietf:params:scim:schemas:core:2.0:User',
        'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
      ],
      externalId: '0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef',
      userName: 'Test_User_ab6490ee-1e48-479e-a20b-2d77186b5dd1',
      active: true,
      emails: [{ primary: true, type: 'work', value: 'Test_User_fd0ea19b-0777-472c-9f96-4f70d2226f2e@testuser.com' }],
      meta: { resourceType: 'User' },
      name: { formatted: 'givenName familyName', familyName: 'familyName', givenName: 'givenName' },
      roles: [],
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': { employeeNumber: '2' },
    });
    expect(user).toEqual({
      userName: 'Test_User_ab6490ee-1e48-479e-a20b-2d77186b5dd1',
      externalId: '0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef',
      active: true,
      givenName: 'givenName',
      familyName: 'familyName',
      displayName: null,
      workEmail: 'test_user_fd0ea19b-0777-472c-9f96-4f70d2226f2e@testuser.com',
    });
    expect(() => slotlockScimUserFromBody({ emails: [] })).toThrow('userName is required');
    expect(() => slotlockScimUserFromBody({ userName: 'x', active: 'maybe' })).toThrow('true or false');
  });

  it('deactivates by every shape the providers send', () => {
    // Entra without the flag: capitalised op, the string "False".
    expect(apply(patch({ op: 'Replace', path: 'active', value: 'False' })).active).toBe(false);
    // Entra with the flag.
    expect(apply(patch({ op: 'replace', path: 'active', value: false })).active).toBe(false);
    // Okta: a replace with no path.
    expect(apply(patch({ op: 'replace', value: { active: false } })).active).toBe(false);
    // Reactivated with "True".
    expect(apply(patch({ op: 'Replace', path: 'active', value: 'True' }), { ...alice, active: false }).active).toBe(true);
  });

  it("expands Entra's path-less replace of dotted and URN-qualified keys, and ignores the extension", () => {
    const changed = apply(
      patch({
        op: 'replace',
        value: {
          displayName: 'Bjfe',
          'name.givenName': 'Kkom',
          'name.familyName': 'Unua',
          'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber': 'Aklq',
        },
      }),
    );
    expect(changed).toEqual({ ...alice, displayName: 'Bjfe', givenName: 'Kkom', familyName: 'Unua' });
    expect(changed).not.toHaveProperty('name.givenName');
  });

  it('changes the work email by its filter path, and only that', () => {
    expect(apply(patch({ op: 'Replace', path: 'emails[type eq "work"].value', value: 'New@Acme-Test.com' })).workEmail).toBe('new@acme-test.com');
    expect(apply(patch({ op: 'replace', path: 'urn:ietf:params:scim:schemas:core:2.0:User:userName', value: 'renamed@acme-test.com' })).userName).toBe('renamed@acme-test.com');
    expect(apply(patch({ op: 'replace', path: 'phoneNumbers[type eq "work"].value', value: '+44' }))).toEqual(alice);
  });

  it('refuses a remove without a path, in any case, a changed id, and is all or nothing', () => {
    for (const op of ['remove', 'Remove']) {
      expect(() => slotlockScimPatchOperations(patch({ op }))).toThrow(expect.objectContaining({ status: 400, scimType: 'noTarget' }));
    }
    expect(() => apply(patch({ op: 'replace', value: { id: 'other' } }))).toThrow(expect.objectContaining({ scimType: 'mutability' }));
    expect(apply(patch({ op: 'replace', value: { id: 'u-1', displayName: 'Same id' } })).displayName).toBe('Same id');
    // The second operation is bad: the first is not applied either (the caller keeps `alice`).
    expect(() => apply(patch({ op: 'replace', path: 'displayName', value: 'X' }, { op: 'replace', path: 'active', value: 'nope' }))).toThrow();
    expect(() => slotlockScimPatchOperations({ Operations: [] })).toThrow(expect.objectContaining({ scimType: 'invalidSyntax' }));
    expect(() => slotlockScimPatchOperations(patch({ op: 'move', path: 'x' }))).toThrow(expect.objectContaining({ scimType: 'invalidSyntax' }));
  });

  it('answers every attribute it keeps, so a GET then PUT loses nothing', () => {
    const meta = { created: new Date('2026-11-11T00:00:00Z'), lastModified: new Date('2026-11-11T01:00:00Z'), location: 'https://x/scim/v2/t/Users/u-1' };
    const resource = slotlockScimUserResource('u-1', alice, meta);
    expect(resource).toMatchObject({ id: 'u-1', userName: 'Alice@Acme-Test.com', active: true, externalId: 'ext-1' });
    expect(slotlockScimUserFromBody(resource)).toEqual(alice);
  });
});

describe('groups', () => {
  const group = { displayName: 'slotlock-role-admin', externalId: null, members: ['u1', 'u2', 'u3'] };
  const applyGroup = (body: unknown) => slotlockScimPatchGroup(group, 'g-1', slotlockScimPatchOperations(body));

  it("removes only the members named, whether by Entra's unflagged shape or by filter", () => {
    expect(applyGroup(patch({ op: 'Remove', path: 'members', value: [{ value: 'u1' }] })).members).toEqual(['u2', 'u3']);
    expect(applyGroup(patch({ op: 'remove', path: 'members[value eq "u2"]' })).members).toEqual(['u1', 'u3']);
    expect(applyGroup(patch({ op: 'remove', path: 'members' })).members).toEqual([]);
    expect(applyGroup(patch({ op: 'add', path: 'members', value: [{ value: 'u4' }, { value: 'u1' }] })).members).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(applyGroup(patch({ op: 'replace', path: 'members', value: [{ value: 'u9' }] })).members).toEqual(['u9']);
  });

  it("accepts Okta's rename, which carries the group's own id", () => {
    expect(applyGroup(patch({ op: 'replace', value: { id: 'g-1', displayName: 'Test SCIMv2' } })).displayName).toBe('Test SCIMv2');
    expect(() => applyGroup(patch({ op: 'replace', value: { id: 'g-2', displayName: 'x' } }))).toThrow(expect.objectContaining({ scimType: 'mutability' }));
    expect(slotlockScimGroupFromBody({ displayName: 'eng', members: [{ value: 'u1', display: 'a@b' }] })).toEqual({ displayName: 'eng', externalId: null, members: ['u1'] });
  });
});

describe('filters and pages', () => {
  const users = ['username', 'externalid', 'id', 'emails[type eq "work"].value', 'emails.value'];

  it('answers eq joined by and, on the attributes allowed, case-insensitively by name', () => {
    expect(slotlockScimFilter('userName eq "Test_User_dfeef4c5-5681-4387-b016-bdf221e82081"', users)).toEqual([
      { attribute: 'username', value: 'Test_User_dfeef4c5-5681-4387-b016-bdf221e82081' },
    ]);
    expect(slotlockScimFilter('userName Eq "X@ACME.TEST"', users)).toEqual([{ attribute: 'username', value: 'X@ACME.TEST' }]);
    expect(slotlockScimFilter('externalId eq "e1" and emails[type eq "work"].value eq "a@b.c"', users)).toEqual([
      { attribute: 'externalid', value: 'e1' },
      { attribute: 'emails[type eq "work"].value', value: 'a@b.c' },
    ]);
    expect(slotlockScimFilter('userName eq "quote\\"inside"', users)).toEqual([{ attribute: 'username', value: 'quote"inside' }]);
    for (const filter of ['userName co "x"', 'userName eq "x" or externalId eq "y"', 'title eq "x"', 'userName eq x', '']) {
      expect(() => slotlockScimFilter(filter, users), filter).toThrow(expect.objectContaining({ scimType: 'invalidFilter' }));
    }
  });

  it('pages from 1, at most 100, and lists nothing with integer counts', () => {
    expect(slotlockScimPage(new URLSearchParams('startIndex=0&count=500'))).toEqual({ startIndex: 1, count: 100 });
    expect(slotlockScimPage(new URLSearchParams('count=0'))).toEqual({ startIndex: 1, count: 0 });
    expect(slotlockScimList([], 0, 1)).toEqual({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 0,
      startIndex: 1,
      itemsPerPage: 0,
      Resources: [],
    });
  });
});
