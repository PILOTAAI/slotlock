// How the staff console shows an account or a staff member: by the name their provider gave, else
// their display (a GitHub login or verified email), else their reference; with a muted second line
// that keeps the rest, and initials on a colour picked from the reference, so the same account
// always looks the same. Colour is a class, never a style attribute: the console's CSP forbids
// inline styles. The shaping is here; ui.ts draws it (accountCell, avatar), and the colours are
// tokens (design-tokens.ts av0 to av7).
/** How many avatar colours there are: classes avatar-t0 to avatar-t7, tokens av0 to av7. */
export const SLOTLOCK_AVATAR_TONES = 8;

export interface SlotlockShownPerson {
  /** What the account is called on the page. */
  primary: string;
  /** The rest, muted: the display when the name leads, and the reference; null when nothing is left. */
  secondary: string | null;
  /** One or two letters for the avatar. */
  initials: string;
  /** The avatar's colour class number, from the reference alone. */
  tone: number;
}

/** A stable 32-bit hash (FNV-1a), so a reference picks the same colour on every server. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The first letter or digit of a word, as people read it (a whole character, never half of one). */
const firstOf = (word: string) => Array.from(word).find((character) => /[\p{L}\p{N}]/u.test(character)) ?? '';

/** Initials: the first and last words' first letters, of a login without its @, an email's local part. */
export function slotlockInitials(text: string): string {
  const base = text.replace(/^@/, '').replace(/@.*$/, '').replace(/^[a-z-]+:/, '');
  const words = base.split(/[\s._-]+/u).filter((word) => firstOf(word) !== '');
  const letters = words.length > 1 ? `${firstOf(words[0] as string)}${firstOf(words.at(-1) as string)}` : firstOf(words[0] ?? '');
  return letters.toLocaleUpperCase('en-GB') || '?';
}

/** The account or member as the console names it. */
export function slotlockShownPerson(input: { ref: string; name?: string | null; display?: string | null }): SlotlockShownPerson {
  const name = input.name?.trim() || null;
  const display = input.display?.trim() || null;
  const primary = name ?? display ?? input.ref;
  const rest = [name ? display : null, primary === input.ref ? null : input.ref].filter((part): part is string => Boolean(part));
  return {
    primary,
    secondary: rest.length ? rest.join(' · ') : null,
    initials: slotlockInitials(primary),
    tone: hashOf(input.ref) % SLOTLOCK_AVATAR_TONES,
  };
}
