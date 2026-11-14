// The colours the dashboard and the staff console share (src/design-tokens.ts): the dashboard keeps
// the values it rendered before the console's redesign, every text and control colour of the console
// passes WCAG 2.2 AA in both themes, and the console's typefaces are the ones the pinned packages hold.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderAdminFonts } from '../../scripts/admin-fonts.mjs';
import { SLOTLOCK_ADMIN_FONTS } from '../admin/fonts.js';
import { SLOTLOCK_CONSOLE_TOKENS, SLOTLOCK_DASHBOARD_TOKENS, type SlotlockTokenSet } from '../design-tokens.js';

// ---------- WCAG 2.2 contrast, as site/scripts/contrast.mjs works it out ----------
type Rgba = { r: number; g: number; b: number; a: number };
function parse(color: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = Number.parseInt(hex[1] as string, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (rgba) return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: Number(rgba[4]) };
  throw new Error(`cannot parse colour ${color}`);
}
/** Composite a stack of colours, bottom first. */
function over(...stack: string[]) {
  let out = { r: 0, g: 0, b: 0 };
  for (const layer of stack.map(parse)) {
    out = { r: layer.r * layer.a + out.r * (1 - layer.a), g: layer.g * layer.a + out.g * (1 - layer.a), b: layer.b * layer.a + out.b * (1 - layer.a) };
  }
  return out;
}
function luminance({ r, g, b }: { r: number; g: number; b: number }) {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(theme: SlotlockTokenSet, fg: string, stack: string[]): number {
  const layers = stack.map((name) => theme[name] as string).reverse();
  const a = over(...layers, theme[fg] as string);
  const b = over(...layers);
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Each pair the console draws: what, on what (top first; the last is opaque), and the minimum: 4.5
 * for text, 3 for large text (the 28px and 40px figures) and for controls, focus rings and bars.
 */
const PAIRS: [string, string[], number, string][] = [
  ['ink', ['page'], 4.5, 'sidebar text'],
  ['ink', ['card'], 4.5, 'body text'],
  ['ink-2', ['page'], 4.5, 'sidebar links, the member'],
  ['ink-2', ['card'], 4.5, 'secondary text, table headers, labels'],
  ['ink-2', ['fill', 'card'], 4.5, 'secondary text on a hovered row'],
  ['ink-2', ['fill-2', 'card'], 4.5, 'chips, counts, the current tab'],
  ['ink-2', ['raised'], 4.5, 'secondary text in drawers and popovers'],
  ['ink-3', ['card'], 4.5, 'placeholders, captions'],
  ['ink-3', ['page'], 4.5, 'captions on the page'],
  ['ink', ['fill-2', 'page'], 4.5, 'the current section in the sidebar'],
  ['accent-ink', ['card'], 4.5, 'links'],
  ['accent-ink', ['accent-tint', 'card'], 4.5, 'info pills, "Public"'],
  ['good-ink', ['good-tint', 'card'], 4.5, 'good pills, rising change'],
  ['warn-ink', ['warn-tint', 'card'], 4.5, 'warning pills'],
  ['bad-ink', ['bad-tint', 'card'], 4.5, 'bad pills, falling change, red menu items'],
  ['bad-ink', ['raised'], 4.5, 'a destructive item in a menu'],
  ['ink', ['warn-tint', 'card'], 4.5, 'a warning callout'],
  ['ink', ['bad-tint', 'card'], 4.5, 'a broken-chain callout'],
  ['on-primary', ['primary'], 4.5, 'primary buttons'],
  ['on-danger', ['danger'], 4.5, 'destructive buttons'],
  ['accent', ['card'], 3, 'focus ring, chart line'],
  ['good', ['card'], 3, 'status dots'],
  ['warn', ['card'], 3, 'status dots, meters at 80%'],
  ['bad', ['card'], 3, 'status dots, meters at 100%'],
  ['c1', ['card'], 3, 'chart series 1'],
  ['c2', ['card'], 3, 'chart series 2'],
  ['c3', ['card'], 3, 'chart series 3'],
  ['c4', ['card'], 3, 'chart series 4'],
];

describe('design tokens', () => {
  it('keeps the dashboard on the colours it rendered in 0.11.0', () => {
    expect(SLOTLOCK_DASHBOARD_TOKENS).toEqual({
      light: {
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
      },
      dark: {
        'logo-lock': '#d9ff43',
        canvas: '#0b0b0d', surface: '#111114', 'surface-2': '#141418', sunken: '#18181c', hover: '#1c1c21',
        line: '#26262c', 'line-strong': '#34343b', 'line-soft': '#1d1d22',
        ink: '#ededf0', 'ink-2': '#b4b4bc', 'ink-3': '#8e8e98',
        accent: '#7ea2ff', 'accent-wash': '#18203a', ring: 'rgba(126, 162, 255, 0.35)',
        button: '#ededf0', 'button-ink': '#0b0b0d', 'button-hover': '#ffffff',
        good: '#4fca8f', 'good-wash': '#0f2419', bad: '#ff7a6b', 'bad-ink': '#1a0806', 'bad-wash': '#2c1512', 'bad-line': '#5a2a24',
        warn: '#f4c25a', 'warn-wash': '#2a2210', 'warn-line': '#4d3d17',
        'pop-shadow': '0 0 0 1px #26262c, 0 16px 40px -8px rgba(0, 0, 0, 0.7)',
        field: '#18181d', 'field-line': '#2f2f36', 'field-line-hover': '#4a4a53', 'field-shadow': 'inset 0 1px 0 rgba(255, 255, 255, 0.02)',
        'card-shadow': 'none',
      },
    });
  });

  it('draws the console in the dashboard’s darks and accent', () => {
    for (const name of ['card', 'ink', 'ink-2', 'ink-3', 'accent', 'good', 'warn', 'bad'] as const) {
      const dashboard = { card: 'surface', ink: 'ink', 'ink-2': 'ink-2', 'ink-3': 'ink-3', accent: 'accent', good: 'good', warn: 'warn', bad: 'bad' }[name];
      expect(SLOTLOCK_CONSOLE_TOKENS.dark[name], name).toBe(SLOTLOCK_DASHBOARD_TOKENS.dark[dashboard as keyof typeof SLOTLOCK_DASHBOARD_TOKENS.dark]);
    }
    expect(SLOTLOCK_CONSOLE_TOKENS.dark.page).toBe(SLOTLOCK_DASHBOARD_TOKENS.dark.canvas);
  });

  for (const themeName of ['light', 'dark'] as const) {
    it(`passes WCAG 2.2 AA for every text and control colour of the console, ${themeName}`, () => {
      const theme = SLOTLOCK_CONSOLE_TOKENS[themeName];
      const failing = PAIRS.map(([fg, stack, min, what]) => ({ what, fg, on: stack.join(' over '), ratio: Number(ratio(theme, fg, stack).toFixed(2)), min }))
        .filter((pair) => pair.ratio < pair.min);
      expect(failing).toEqual([]);
    });
  }

  it('serves Inter and Geist Mono as the pinned packages hold them, with their licence', () => {
    for (const [path, text] of renderAdminFonts()) expect(readFileSync(path, 'utf8'), `${path}: run node scripts/admin-fonts.mjs`).toBe(text);
    expect(SLOTLOCK_ADMIN_FONTS.map((font) => font.family)).toEqual(['Inter', 'Geist Mono']);
    for (const font of SLOTLOCK_ADMIN_FONTS) {
      expect(font.path).toMatch(/^\/fonts\/[a-z-]+-[0-9a-f]{12}\.woff2$/);
      // woff2's signature, wOF2.
      expect(Buffer.from(font.base64, 'base64').subarray(0, 4).toString('latin1')).toBe('wOF2');
    }
    expect(readFileSync('src/admin/fonts/Inter-OFL.txt', 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(readFileSync('src/admin/fonts/GeistMono-OFL.txt', 'utf8')).toContain('SIL OPEN FONT LICENSE Version 1.1');
  });
});
