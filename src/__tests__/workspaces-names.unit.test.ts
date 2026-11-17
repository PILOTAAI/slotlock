// A person's name, as the dashboard keeps it for the staff console: the dashboard's cleaning
// (slotlockPersonName) and the database's check (SLOTLOCK_NAME_UNSHOWN_PATTERN, ddl.ts) refuse the
// same characters, so a name the one keeps the other never refuses.
import { describe, expect, it } from 'vitest';
import { SLOTLOCK_NAME_UNSHOWN_PATTERN } from '../ddl.js';
import { slotlockPersonName } from '../workspaces.js';

/** The database's pattern as a JavaScript one: \uXXXX and \UXXXXXXXX as code points. */
const database = new RegExp(
  SLOTLOCK_NAME_UNSHOWN_PATTERN.replace(/\\U([0-9A-F]{8})|\\u([0-9A-F]{4})/g, (_, wide: string | undefined, narrow: string | undefined) => `\\u{${(wide ?? narrow ?? '').replace(/^0+(?=.)/, '')}}`),
  'u',
);

describe("a person's name", () => {
  it('loses control, format, bidirectional and separator characters, is trimmed and kept to 80', () => {
    expect(slotlockPersonName('  Ada\u200B \u00ADLove\u2060lace\uFEFF\u{E0041}\u2028\u202E\u0085\u0007 ')).toBe('Ada Lovelace');
    expect(slotlockPersonName('Zoë Ōkubo 日本語')).toBe('Zoë Ōkubo 日本語');
    expect(slotlockPersonName(`${'é'.repeat(79)}😀😀`)).toBe(`${'é'.repeat(79)}😀`);
    expect(slotlockPersonName('\u200B\u2029 ')).toBeNull();
    expect(slotlockPersonName({ name: 'x' })).toBeNull();
  });

  it('is refused by the database for exactly the characters the dashboard removes, beyond ASCII', () => {
    const removed = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
    const differ: string[] = [];
    for (let point = 0x80; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) continue;
      const character = String.fromCodePoint(point);
      if (removed.test(character) !== database.test(character)) differ.push(point.toString(16));
    }
    expect(differ).toEqual([]);
  });
});
