// How the staff console shows an account or a staff member: by the name their provider gave, else
// their display (a GitHub login or verified email), else their reference; with a muted second line
// that keeps the rest, and initials on a colour picked from the reference, so the same account
// always looks the same. Colour is a class, never a style attribute: the console's CSP forbids
// inline styles. The data shaping here is the page markup's, whatever the pages look like.
import { type Html, html } from './ui.js';

/** How many avatar colours there are: classes avatar-t0 to avatar-t7. */
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

/** The avatar alone: initials on the reference's colour, hidden from screen readers (the name is read). */
export function slotlockAvatar(shown: SlotlockShownPerson): Html {
  return html`<span class="avatar avatar-t${shown.tone}" aria-hidden="true">${shown.initials}</span>`;
}

/** A table cell: avatar, the name (a link when `href`), and the muted second line. */
export function slotlockPersonCell(shown: SlotlockShownPerson, href?: string, extra?: Html): Html {
  return html`<span class="person">${slotlockAvatar(shown)}<span class="person-text">${href ? html`<a href="${href}">${shown.primary}</a>` : shown.primary}${shown.secondary || extra ? html`<span class="sub">${shown.secondary ?? ''}${extra ?? ''}</span>` : ''}</span></span>`;
}

/**
 * The avatar's styles, served after the console's stylesheet: eight colours that read in light and
 * dark, each a class.
 */
const TONES: readonly (readonly [string, string, string, string])[] = [
  // [light background, light ink, dark background, dark ink]
  ['#E8EDFF', '#0E2D9E', '#141B33', '#AAC0FF'],
  ['#E4F3EC', '#145C45', '#0F2A21', '#7DD8B4'],
  ['#F7EBD6', '#7A4B0C', '#2D2312', '#E8B76B'],
  ['#F4E0DF', '#8C2626', '#2F1717', '#F09A9A'],
  ['#EEE4F8', '#5B2A8C', '#24173A', '#C9A6F0'],
  ['#DFF1F5', '#145866', '#10272D', '#7FCFE0'],
  ['#F5E3EF', '#86245F', '#2E1626', '#EBA0CC'],
  ['#ECEBE6', '#45433E', '#1F1F1D', '#CFCDC6'],
];
export const SLOTLOCK_ADMIN_PEOPLE_CSS = `
.person{display:flex;gap:10px;align-items:center;min-width:0}.person-text{display:grid;min-width:0}
.avatar{flex:none;display:inline-grid;place-items:center;width:28px;height:28px;border-radius:999px;font:600 11px/1 var(--font,system-ui,sans-serif);letter-spacing:.02em}
${TONES.map(([background, ink], tone) => `.avatar-t${tone}{background:${background};color:${ink}}`).join('\n')}
@media (prefers-color-scheme:dark){${TONES.map(([, , background, ink], tone) => `.avatar-t${tone}{background:${background};color:${ink}}`).join('')}}
`;
