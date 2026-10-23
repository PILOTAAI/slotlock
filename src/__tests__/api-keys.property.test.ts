// Properties of API key strings: every generated key verifies offline, one changed character makes
// it fail (always in the checksum; but for a 1 in 2^32 chance in the random part), and nothing
// thrown at the check makes it throw.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  SLOTLOCK_API_KEY_PREFIX,
  generateSlotlockApiKey,
  isSlotlockApiKey,
  slotlockApiKeyDigest,
} from '../api-keys.js';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

describe('API key strings', () => {
  it('verify when generated, and stop verifying when one character changes', () => {
    fc.assert(
      fc.property(fc.nat({ max: 45 }), fc.nat({ max: 60 }), (position, shift) => {
        const { key, prefix, digest } = generateSlotlockApiKey();
        expect(key).toMatch(/^slk_[0-9A-Za-z]{46}$/);
        expect(isSlotlockApiKey(key)).toBe(true);
        expect(prefix).toBe(key.slice(0, 12));
        expect(digest).toEqual(createHash('sha256').update(key, 'utf8').digest());
        expect(slotlockApiKeyDigest(key)).toEqual(digest);
        const index = SLOTLOCK_API_KEY_PREFIX.length + position;
        const current = BASE62.indexOf(key[index] as string);
        const changed = BASE62[(current + 1 + shift) % 62] as string;
        expect(isSlotlockApiKey(`${key.slice(0, index)}${changed}${key.slice(index + 1)}`)).toBe(false);
      }),
      { numRuns: 1_000 },
    );
  });

  it('answers false, never throws, for anything that is not a key', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.string(),
          fc.string({ minLength: 46, maxLength: 46 }).map((rest) => `slk_${rest}`),
          fc.constantFrom('', 'slk_', `slk_${'0'.repeat(46)}`, `SLK_${'a'.repeat(46)}`, `slk_${'a'.repeat(47)}`),
        ),
        (value) => {
          expect(isSlotlockApiKey(value as string)).toBe(false);
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
