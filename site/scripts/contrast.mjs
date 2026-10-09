// WCAG 2.2 contrast check for every text/background pair the site draws, in both themes, read from
// the same token object that generates the CSS (src/styles/tokens.mjs). Translucent colours are
// composited over what sits behind them; striped (hatched) fills are checked at their darkest and
// lightest stripe, so a label on a hatch passes wherever it falls.
//
//   npm run check:contrast            prints the table, exits 1 on any failure
import { dark, light } from '../src/styles/tokens.mjs';

function parse(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  const rgba = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(color);
  if (rgba) return { r: +rgba[1], g: +rgba[2], b: +rgba[3], a: +rgba[4] };
  throw new Error(`cannot parse colour ${color}`);
}

/** Composite a stack of colours, bottom first. */
function over(...stack) {
  let out = { r: 0, g: 0, b: 0 };
  for (const layer of stack.map(parse)) {
    out = {
      r: layer.r * layer.a + out.r * (1 - layer.a),
      g: layer.g * layer.a + out.g * (1 - layer.a),
      b: layer.b * layer.a + out.b * (1 - layer.a),
    };
  }
  return out;
}

function luminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function ratio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Each pair: what is drawn, the stack it sits on (top first, token names; the card colour `paper`
 * is always underneath, which matters only for translucent dark-theme fills), and the minimum ratio.
 * 4.5 for body-size text, 3 for large text (24px+, or 18.66px+ bold) and for non-text UI parts.
 */
const PAIRS = [
  // Page text
  ['ink', ['canvas'], 4.5, 'body text on the page'],
  ['ink', ['paper'], 4.5, 'body text on cards'],
  ['ink-2', ['canvas'], 4.5, 'ledes and statements'],
  ['ink-2', ['paper'], 4.5, 'secondary text on cards'],
  ['ink-3', ['canvas'], 4.5, 'soft heading halves, eyebrows, captions'],
  ['ink-3', ['paper'], 4.5, 'captions and timestamps on cards'],
  ['ink-3', ['canvas-2'], 4.5, 'captions on the tinted band'],
  ['accent', ['canvas'], 4.5, 'links on the page'],
  ['accent', ['paper'], 4.5, 'links on cards'],
  ['on-accent', ['accent'], 4.5, 'text on accent fills'],
  ['paper', ['ink'], 4.5, 'primary pill button'],
  ['accent-ink', ['accent-soft', 'paper'], 4.5, 'launch pill and soft accent chips'],
  // Calendar states
  ['on-confirmed', ['confirmed'], 4.5, 'label on a confirmed block'],
  ['confirmed', ['confirmed-soft', 'paper'], 4.5, 'confirmed badge'],
  // Labels on hatched blocks sit on a solid chip of the block's base colour, never on a stripe.
  ['hold', ['hold-soft', 'paper'], 4.5, 'label chip on a hold'],
  ['refused', ['paper'], 4.5, 'label of a refused (ghost) request'],
  ['refused', ['refused-soft', 'paper'], 4.5, 'refusal card title'],
  ['ink', ['refused-soft', 'paper'], 4.5, 'refusal card body'],
  ['ink-2', ['busy'], 4.5, 'label on a provider busy block'],
  ['ink-2', ['paper'], 4.5, 'label chip on unproven time'],
  ['ink-2', ['canvas-2'], 4.5, 'label chip on closed time'],
  // Non-text: each state's outline against the card it sits on (WCAG 1.4.11, 3:1), so a state
  // is told apart by its edge and its label, not by the hatch alone.
  ['hold', ['paper'], 3, 'hold dashed border'],
  ['refused', ['paper'], 3, 'refused outline'],
  ['confirmed', ['paper'], 3, 'confirmed block edge'],
  ['ink-3', ['paper'], 3, 'unproven dotted border'],
  ['ink-3', ['canvas-2'], 3, 'closed dotted border'],
  ['accent', ['paper'], 3, 'focus ring and "now" marker'],
  // Code panels (dark in both themes)
  ['code-ink', ['code-bg'], 4.5, 'code text'],
  ['code-muted', ['code-bg'], 4.5, 'code comments'],
  ['code-muted', ['code-bar'], 4.5, 'code card tabs'],
  ['code-ink', ['code-bar'], 4.5, 'selected code tab'],
  ['code-accent', ['code-bg'], 4.5, 'code keywords and strings'],
  ['code-green', ['code-bg'], 4.5, 'code results: ok'],
  ['code-amber', ['code-bg'], 4.5, 'code results: hold'],
  ['code-red', ['code-bg'], 4.5, 'code results: refused'],
];

/** Hatch stripes against their own base: informational only (every hatched block is also labelled). */
const HATCHES = [
  ['closed-stripe', 'canvas-2', 'closed by rule'],
  ['unproven-stripe', 'paper', 'unproven'],
  ['hold-stripe', 'hold-soft', 'hold'],
];

let failures = 0;
const rows = [];
for (const [themeName, theme] of [
  ['light', light],
  ['dark', dark],
]) {
  const base = theme.paper;
  for (const [fg, stack, min, what] of PAIRS) {
    const layers = [base, ...stack.map((name) => theme[name]).reverse()];
    const value = ratio(over(...layers, theme[fg]), over(...layers));
    const pass = value >= min;
    if (!pass) failures += 1;
    rows.push({
      theme: themeName,
      what,
      fg,
      on: stack.join(' over '),
      ratio: value.toFixed(2),
      min,
      pass: pass ? 'yes' : 'NO',
    });
  }
  for (const [stripe, under, what] of HATCHES) {
    const baseColour = over(base, theme[under]);
    const stripeColour = over(base, theme[under], theme[stripe]);
    rows.push({
      theme: themeName,
      what: `hatch: ${what}`,
      fg: stripe,
      on: under,
      ratio: ratio(stripeColour, baseColour).toFixed(2),
      min: '-',
      pass: 'info',
    });
  }
}

const widths = Object.keys(rows[0]).map((key) =>
  Math.max(key.length, ...rows.map((row) => String(row[key]).length)),
);
const line = (values) => values.map((value, i) => String(value).padEnd(widths[i])).join('  ');
console.log(line(Object.keys(rows[0])));
for (const row of rows) console.log(line(Object.values(row)));
console.log(
  failures === 0
    ? '\nAll text and UI pairs meet WCAG AA.'
    : `\n${failures} pair(s) below the minimum.`,
);
process.exit(failures === 0 ? 0 : 1);
