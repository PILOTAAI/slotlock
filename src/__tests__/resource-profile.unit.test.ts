// A resource's profile (resource-profile.ts): what passes, how it is put, what is refused and why;
// and the agent tools' copy of its kinds and bounds, which the site reads as text.
import { describe, expect, it } from 'vitest';
import { SLOTLOCK_AGENT_RESOURCE_PROFILE } from '../agent-server.js';
import {
  SLOTLOCK_GROUPING_REF,
  SLOTLOCK_MAX_GROUPS_PER_RESOURCE,
  SLOTLOCK_RESOURCE_KINDS,
  SLOTLOCK_RESOURCE_LABEL,
  SLOTLOCK_RESOURCE_PROFILE_LIMITS,
  parseSlotlockResourceProfile,
  slotlockResourceHasLabels,
} from '../resource-profile.js';

describe('resource profiles', () => {
  it('trims names, sorts labels without repeats, and keeps what is left out unsaid', () => {
    expect(
      parseSlotlockResourceProfile({
        name: '  Room 3 ',
        description: ' Seats ten.\nBy the lifts. ',
        kind: 'room',
        capacity: 10,
        labels: ['video', 'accessible', 'video'],
        attributes: { floor: 3, quiet: true, code: 'R3' },
      }),
    ).toEqual({
      name: 'Room 3',
      description: 'Seats ten.\nBy the lifts.',
      kind: 'room',
      capacity: 10,
      labels: ['accessible', 'video'],
      attributes: { floor: 3, quiet: true, code: 'R3' },
    });
    expect(parseSlotlockResourceProfile({})).toEqual({});
    expect(parseSlotlockResourceProfile({ name: null, capacity: null, labels: [], attributes: {} })).toEqual({
      name: null,
      capacity: null,
      labels: [],
      attributes: {},
    });
  });

  it('refuses each field outside its bounds, naming it', () => {
    const refused = (input: unknown, field: string) =>
      expect(() => parseSlotlockResourceProfile(input as never), JSON.stringify(input).slice(0, 60)).toThrow(
        expect.objectContaining({ code: 'invalid_resource_profile', field }),
      );
    refused({ name: '' }, 'name');
    refused({ name: 'a\tb' }, 'name');
    refused({ name: '😀'.repeat(201) }, 'name');
    refused({ description: 'x'.repeat(2_001) }, 'description');
    refused({ description: 'bell\u0007' }, 'description');
    refused({ kind: 'Room' }, 'kind');
    refused({ capacity: 100_001 }, 'capacity');
    refused({ capacity: '3' }, 'capacity');
    refused({ labels: 'ev' }, 'labels');
    refused({ labels: ['-ev'] }, 'labels');
    refused({ labels: ['x'.repeat(65)] }, 'labels');
    refused({ attributes: null }, 'attributes');
    refused({ attributes: { n: Number.NaN } }, 'attributes');
    refused({ attributes: { list: [1] } }, 'attributes');
    refused({ attributes: { ['k'.repeat(65)]: 1 } }, 'attributes');
    refused({ attributes: { long: 'x'.repeat(1_001) } }, 'attributes');
    // 200 code points is fine, however many UTF-16 units: PostgreSQL counts the same way.
    expect(parseSlotlockResourceProfile({ name: '😀'.repeat(200) }).name).toHaveLength(400);
  });

  it('matches labels only when every one is there', () => {
    expect(slotlockResourceHasLabels(['ev', 'lhr'], ['lhr'])).toBe(true);
    expect(slotlockResourceHasLabels(['ev'], ['ev', 'lhr'])).toBe(false);
    expect(slotlockResourceHasLabels(undefined, [])).toBe(true);
    expect(slotlockResourceHasLabels(undefined, ['ev'])).toBe(false);
  });

  it("gives the agent tools the profile's own kinds and bounds", () => {
    expect(SLOTLOCK_AGENT_RESOURCE_PROFILE.kinds).toEqual([...SLOTLOCK_RESOURCE_KINDS]);
    expect(SLOTLOCK_AGENT_RESOURCE_PROFILE.labels).toBe(SLOTLOCK_RESOURCE_PROFILE_LIMITS.labels);
    expect(SLOTLOCK_AGENT_RESOURCE_PROFILE.name).toBe(SLOTLOCK_RESOURCE_PROFILE_LIMITS.name);
    expect(SLOTLOCK_AGENT_RESOURCE_PROFILE.groups).toBe(SLOTLOCK_MAX_GROUPS_PER_RESOURCE);
    for (const ref of ['leeds', 'a.b-c_d', 'x'.repeat(100), 'Leeds', '.x', 'x'.repeat(101)]) {
      expect(SLOTLOCK_AGENT_RESOURCE_PROFILE.groupingRef.safeParse(ref).success, ref).toBe(SLOTLOCK_GROUPING_REF.test(ref));
    }
    for (const label of ['ev', 'a.b-c_d', 'x'.repeat(64), 'EV', '-x', 'x'.repeat(65), '']) {
      expect(SLOTLOCK_AGENT_RESOURCE_PROFILE.label.safeParse(label).success, label).toBe(
        SLOTLOCK_RESOURCE_LABEL.test(label),
      );
    }
  });
});
