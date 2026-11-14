// The colour tokens the customer dashboard (src/dashboard.ts) and the staff console
// (src/admin/ui.ts) draw with, in one place, so the two read as one product. Both start from the
// same zinc darks and the same accent; the dashboard keeps exactly the values it has always rendered
// (src/__tests__/design-tokens.unit.test.ts holds them), and the console adds the denser set its
// tables and charts need. src/__tests__/design-tokens.unit.test.ts checks every text and control pair
// against WCAG 2.2 AA in both themes.
//
// Also here: the dashboard's announcement banner, its markup and its CSS, which the console's
// Communications page previews exactly as a customer sees it.
import type { SlotlockAnnouncementKind } from './staff-ddl.js';

/** The zinc darks, the accent and the status colours both surfaces use in the dark. */
export const SLOTLOCK_ZINC_DARK = Object.freeze({
  page: '#0b0b0d',
  card: '#111114',
  raised: '#18181c',
  ink: '#ededf0',
  ink2: '#b4b4bc',
  ink3: '#8e8e98',
  accent: '#7ea2ff',
  good: '#4fca8f',
  warn: '#f4c25a',
  bad: '#ff7a6b',
});

/** The customer dashboard's colours, light and dark, as DASHBOARD_CSS declares them on :root. */
export const SLOTLOCK_DASHBOARD_TOKENS = Object.freeze({
  light: Object.freeze({
    canvas: '#f7f7f8', surface: '#ffffff', 'surface-2': '#fafafa', sunken: '#f2f2f4', hover: '#f0f0f2',
    line: '#e6e6e9', 'line-strong': '#d4d4d8', 'line-soft': '#efeff1',
    ink: '#18181b', 'ink-2': '#52525b', 'ink-3': '#6b6b74',
    accent: '#2456e6', 'accent-wash': '#eef2fe', ring: 'rgba(36, 86, 230, 0.28)',
    button: '#18181b', 'button-ink': '#ffffff', 'button-hover': '#2e2e33',
    good: '#11764c', 'good-wash': '#e9f6ef', bad: '#c42b1c', 'bad-ink': '#ffffff', 'bad-wash': '#fdeeec', 'bad-line': '#f5c9c3',
    warn: '#8a5300', 'warn-wash': '#fff5e1', 'warn-line': '#f3dcae',
    'logo-lock': '#0a0b0d', 'logo-slot': '#d9ff43',
    'pop-shadow': '0 1px 2px rgba(24, 24, 27, 0.06), 0 12px 32px -8px rgba(24, 24, 27, 0.18)',
    field: '#ffffff', 'field-line': '#d4d4d8', 'field-line-hover': '#a1a1aa', 'field-shadow': '0 1px 2px rgba(24, 24, 27, 0.05)',
    'card-shadow': '0 1px 2px rgba(24, 24, 27, 0.04)',
  }),
  dark: Object.freeze({
    'logo-lock': '#d9ff43',
    canvas: SLOTLOCK_ZINC_DARK.page, surface: SLOTLOCK_ZINC_DARK.card, 'surface-2': '#141418', sunken: SLOTLOCK_ZINC_DARK.raised, hover: '#1c1c21',
    line: '#26262c', 'line-strong': '#34343b', 'line-soft': '#1d1d22',
    ink: SLOTLOCK_ZINC_DARK.ink, 'ink-2': SLOTLOCK_ZINC_DARK.ink2, 'ink-3': SLOTLOCK_ZINC_DARK.ink3,
    accent: SLOTLOCK_ZINC_DARK.accent, 'accent-wash': '#18203a', ring: 'rgba(126, 162, 255, 0.35)',
    button: SLOTLOCK_ZINC_DARK.ink, 'button-ink': SLOTLOCK_ZINC_DARK.page, 'button-hover': '#ffffff',
    good: SLOTLOCK_ZINC_DARK.good, 'good-wash': '#0f2419', bad: SLOTLOCK_ZINC_DARK.bad, 'bad-ink': '#1a0806', 'bad-wash': '#2c1512', 'bad-line': '#5a2a24',
    warn: SLOTLOCK_ZINC_DARK.warn, 'warn-wash': '#2a2210', 'warn-line': '#4d3d17',
    'pop-shadow': '0 0 0 1px #26262c, 0 16px 40px -8px rgba(0, 0, 0, 0.7)',
    field: '#18181d', 'field-line': '#2f2f36', 'field-line-hover': '#4a4a53', 'field-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.02)',
    'card-shadow': 'none',
  }),
});

/**
 * The staff console's colours. Lines and fills are white (dark) or black (light) at a fixed opacity
 * over whatever they sit on; tints are a status colour at 12%. Each status has a fill colour (dots,
 * bars, charts, focus) and an ink for text, which in the light theme is darker so it passes AA on
 * its tint.
 */
export const SLOTLOCK_CONSOLE_TOKENS = Object.freeze({
  light: Object.freeze({
    page: '#f8f8f8', card: '#ffffff', raised: '#ffffff', sunken: '#f3f3f3',
    line: 'rgba(0,0,0,0.08)', 'line-2': 'rgba(0,0,0,0.06)', fill: 'rgba(0,0,0,0.04)', 'fill-2': 'rgba(0,0,0,0.07)',
    ink: '#191919', 'ink-2': 'rgba(25,25,25,0.70)', 'ink-3': 'rgba(25,25,25,0.62)',
    accent: '#317cff', 'accent-ink': '#005fcc', 'accent-tint': 'rgba(49,124,255,0.12)',
    good: '#00a558', 'good-ink': '#00703c', 'good-tint': 'rgba(0,165,88,0.12)',
    warn: '#b35f1b', 'warn-ink': '#8f4a12', 'warn-tint': 'rgba(179,95,27,0.12)',
    bad: '#f53b3a', 'bad-ink': '#c01a19', 'bad-tint': 'rgba(245,59,58,0.12)',
    primary: '#191919', 'on-primary': '#ffffff', 'primary-hover': '#363636',
    danger: '#d42625', 'on-danger': '#ffffff',
    c1: '#317cff', c2: '#00a596', c3: '#956cde', c4: '#b35f1b', c5: '#8c8c8c',
    'card-shadow': '0 0 0 1px rgba(0,0,0,0.06), 0 1px 3px rgba(0,0,0,0.04)',
    'pop-shadow': '0 0 0 1px rgba(0,0,0,0.08), 0 16px 40px -8px rgba(0,0,0,0.18)',
    'logo-ink': '#0a0b0d', 'logo-slot': '#d9ff43',
  }),
  dark: Object.freeze({
    page: SLOTLOCK_ZINC_DARK.page, card: SLOTLOCK_ZINC_DARK.card, raised: SLOTLOCK_ZINC_DARK.raised, sunken: '#0e0e11',
    line: 'rgba(255,255,255,0.08)', 'line-2': 'rgba(255,255,255,0.05)', fill: 'rgba(255,255,255,0.04)', 'fill-2': 'rgba(255,255,255,0.07)',
    ink: SLOTLOCK_ZINC_DARK.ink, 'ink-2': SLOTLOCK_ZINC_DARK.ink2, 'ink-3': SLOTLOCK_ZINC_DARK.ink3,
    accent: SLOTLOCK_ZINC_DARK.accent, 'accent-ink': SLOTLOCK_ZINC_DARK.accent, 'accent-tint': 'rgba(126,162,255,0.12)',
    good: SLOTLOCK_ZINC_DARK.good, 'good-ink': SLOTLOCK_ZINC_DARK.good, 'good-tint': 'rgba(79,202,143,0.12)',
    warn: SLOTLOCK_ZINC_DARK.warn, 'warn-ink': SLOTLOCK_ZINC_DARK.warn, 'warn-tint': 'rgba(244,194,90,0.12)',
    bad: SLOTLOCK_ZINC_DARK.bad, 'bad-ink': SLOTLOCK_ZINC_DARK.bad, 'bad-tint': 'rgba(255,122,107,0.12)',
    primary: SLOTLOCK_ZINC_DARK.ink, 'on-primary': SLOTLOCK_ZINC_DARK.page, 'primary-hover': '#ffffff',
    danger: SLOTLOCK_ZINC_DARK.bad, 'on-danger': '#1a0806',
    c1: SLOTLOCK_ZINC_DARK.accent, c2: '#3fc7b8', c3: '#b79cff', c4: SLOTLOCK_ZINC_DARK.warn, c5: '#6e6e78',
    'card-shadow': '0 0 0 1px rgba(255,255,255,0.08), 0 1px 3px rgba(0,0,0,0.5)',
    'pop-shadow': '0 0 0 1px rgba(255,255,255,0.08), 0 16px 40px -8px rgba(0,0,0,0.6)',
    'logo-ink': '#f4f3ee', 'logo-slot': '#d9ff43',
  }),
});

export type SlotlockTokenSet = Readonly<Record<string, string>>;

/** A token set as CSS custom properties, `--name: value;` each. */
export function slotlockCssVars(set: SlotlockTokenSet, separator = ' '): string {
  return Object.entries(set)
    .map(([name, value]) => `--${name}: ${value};`)
    .join(separator);
}

/** How a dashboard's banner names an announcement's kind (RFC 0006, M10). */
export const SLOTLOCK_ANNOUNCEMENT_LABELS: Readonly<Record<SlotlockAnnouncementKind, string>> = Object.freeze({
  maintenance: 'Planned maintenance',
  change: 'A change to Slotlock',
  incident: 'Incident',
  notice: 'Notice',
});

/** The dashboard's banner line (the test-environment, suspension and announcement banners). */
export const SLOTLOCK_BANNER_CSS = `.test-banner { margin: 0 0 var(--space-4); padding: var(--space-2) var(--space-3); border: 1px dashed var(--warn-line); border-radius: var(--radius); background: var(--warn-wash); color: var(--warn); font-size: var(--text-md); }
.test-banner code { background: none; padding: 0; }`;

/** An announcement's banner, over the banner line. */
export const SLOTLOCK_ANNOUNCEMENT_BANNER_CSS = `.announcement-banner { border-style: solid; border-color: var(--line-strong); background: var(--accent-wash); color: var(--ink); }
.announcement-banner strong { color: var(--ink); }
.announcement-banner a { color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
.announcement-incident { border-color: var(--warn-line); background: var(--warn-wash); }`;

/** The pieces of an announcement's banner, before escaping: the dashboard and the console's preview build it from these. */
export function slotlockAnnouncementBannerParts(kind: SlotlockAnnouncementKind): { className: string; label: string; more: string } {
  return { className: `test-banner announcement-banner announcement-${kind}`, label: `${SLOTLOCK_ANNOUNCEMENT_LABELS[kind]}.`, more: 'More about this' };
}
