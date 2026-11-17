// Draws the link-preview images (public/og/*.png, 1200 × 630) with Chromium, from the logo in
// src/components/Lockup.astro (its light-surface inks), the colour tokens and the self-hosted fonts.
// A blog post's image comes from its file's frontmatter (content/blog/<slug>.md: title, image and
// eyebrow), so a post written in the admin console needs nobody to draw it: the site's CI runs
// `node scripts/og-images.mjs --missing`, which draws only images that do not exist yet, before it
// builds. The others are committed, like public/fonts; run this after changing a title below or the
// logo, then `npm run build && npm run check:seo`, which fails on a page whose og:image is missing or
// the wrong size.
//
//   node scripts/og-images.mjs --missing --list   prints the images missing, one per line, and exits The touch icon (public/apple-touch-icon.png, 180 × 180), the logo for structured data
// (public/brand/slotlock-512.png) and public/favicon.svg are the Slotlock design system's own icon
// files (Icons: apple-touch-icon-180, slotlock-icon-ink-512w, favicon), copied, never redrawn.
//
//   node scripts/og-images.mjs            needs Playwright and Chromium (not a site dependency:
//                                         `npx -y playwright@1 install chromium` once, or set
//                                         PLAYWRIGHT_CHROMIUM to a Chromium binary)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { light } from '../src/styles/tokens.mjs';

const SITE = new URL('../', import.meta.url);
const at = (path) => fileURLToPath(new URL(path, SITE));

/** A value of a post's frontmatter: the text after `key: `, JSON-unquoted when quoted. */
function frontValue(front, key) {
  const raw = new RegExp(`^${key}: (.+)$`, 'm').exec(front)?.[1]?.trim();
  if (raw === undefined) return undefined;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Each published post's image, from its frontmatter (site/src/lib/post-format.ts reads the same). */
function postImages() {
  const directory = fileURLToPath(new URL('content/blog/', SITE));
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .sort()
    .map((file) => {
      const front = readFileSync(join(directory, file), 'utf8').split(/^---$/m)[1] ?? '';
      return {
        name: frontValue(front, 'image') ?? `blog-${file.slice(0, -3)}`,
        eyebrow: frontValue(front, 'eyebrow') ?? 'Blog',
        title: frontValue(front, 'title') ?? file.slice(0, -3),
        status: frontValue(front, 'status') ?? 'draft',
      };
    })
    .filter((image) => image.status === 'published')
    .map(({ status: _, ...image }) => image);
}

/** One image per page, or per kind of page. `name` is the file in public/og/. */
export const IMAGES = [
  { name: 'default', eyebrow: 'Slotlock', title: 'The booking API and calendar for AI agents' },
  { name: 'landing', eyebrow: 'Booking API and calendar for AI agents', title: 'Two agents, one slot, one booking.' },
  { name: 'docs', eyebrow: 'Documentation', title: 'Slotlock docs: the booking engine for AI agents' },
  { name: 'docs-api', eyebrow: 'REST API reference', title: 'Every Slotlock route, with fields, errors and an example' },
  { name: 'pricing', eyebrow: 'Pricing', title: 'Start free on Slotlock Cloud, or run it yourself' },
  { name: 'about', eyebrow: 'About', title: 'Who builds Slotlock, and how to reach us' },
  { name: 'mcp-server', eyebrow: 'MCP server', title: 'A booking and calendar MCP server for AI agents' },
  { name: 'booking-api', eyebrow: 'Booking API', title: 'One booking API over REST, MCP and A2A' },
  { name: 'open-source', eyebrow: 'Open source', title: 'An open-source booking engine on PostgreSQL' },
  { name: 'use-cases', eyebrow: 'Use cases', title: 'Anything booked by the hour or the day' },
  { name: 'use-case-car-rental', eyebrow: 'Car and van rental', title: 'Every vehicle a calendar. A second booking is refused.' },
  { name: 'use-case-equipment-hire', eyebrow: 'Equipment hire', title: 'Machines booked by the day, with inspection time kept' },
  { name: 'use-case-clinics', eyebrow: 'Clinics', title: 'Room, clinician and equipment booked together, or not at all' },
  { name: 'use-case-courts', eyebrow: 'Courts', title: 'Padel and tennis courts on fixed starts, with no-shows offered on' },
  { name: 'use-case-garage-service-bays', eyebrow: 'Garage service bays', title: 'Bay, technician and courtesy car in one booking' },
  { name: 'use-case-salons-and-spas', eyebrow: 'Salons and spas', title: 'Rooms and therapists, with cleaning time built in' },
  { name: 'use-case-rooms-and-desks', eyebrow: 'Rooms and desks', title: 'Rooms nobody checks in to go back on offer' },
  { name: 'use-case-field-service', eyebrow: 'Field service', title: 'Technician and van, held while the customer chooses' },
  { name: 'compare', eyebrow: 'Compare', title: 'Slotlock and the other ways to book' },
  { name: 'compare-diy', eyebrow: 'Compare', title: 'Slotlock or a bookings table and a cron job' },
  { name: 'compare-cal-com', eyebrow: 'Compare', title: 'Slotlock and Cal.com' },
  { name: 'compare-cronofy', eyebrow: 'Compare', title: 'Slotlock and Cronofy' },
  { name: 'compare-nylas', eyebrow: 'Compare', title: 'Slotlock and Nylas' },
  { name: 'compare-google-calendar-api', eyebrow: 'Compare', title: 'Slotlock and the Google Calendar API' },
  { name: 'blog', eyebrow: 'Blog', title: 'Notes on booking, calendars and AI agents' },
  ...postImages(),
];

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function logo() {
  const source = await readFile(at('src/components/Lockup.astro'), 'utf8');
  const svg = /<svg[\s\S]*<\/svg>/.exec(source)?.[0];
  if (!svg) throw new Error('og-images: no <svg> in src/components/Lockup.astro');
  return svg;
}

const fontFaces = () => `
  @font-face { font-family: 'Inter'; src: url('${new URL('public/fonts/inter.woff2', SITE)}'); font-weight: 400 700; }
  @font-face { font-family: 'Inter Tight'; src: url('${new URL('public/fonts/inter-tight.woff2', SITE)}'); }
  @font-face { font-family: 'JetBrains Mono'; src: url('${new URL('public/fonts/jetbrains-mono.woff2', SITE)}'); font-weight: 400 600; }`;

function card(svg, { eyebrow, title }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  ${fontFaces()}
  * { box-sizing: border-box; margin: 0; }
  html, body { width: 1200px; height: 630px; }
  body { background: ${light.canvas}; color: ${light.ink}; font-family: 'Inter', sans-serif;
    display: flex; flex-direction: column; justify-content: space-between; padding: 72px 80px; }
  .lockup__logo { height: 48px; width: auto; align-self: flex-start; }
  .lockup__shackle { fill: none; stroke: #0a0b0d; stroke-width: 7; }
  .lockup__body, .lockup__word { fill: #0a0b0d; }
  .lockup__cut { display: none; }
  .lockup__slot { fill: #d9ff43; }
  .eyebrow { font-family: 'JetBrains Mono', monospace; font-size: 24px; letter-spacing: 0.08em;
    text-transform: uppercase; color: ${light['ink-3']}; margin-bottom: 22px; }
  h1 { font-family: 'Inter Tight', 'Inter', sans-serif; font-weight: 400; font-size: 68px;
    line-height: 1.06; letter-spacing: -0.02em; max-width: 1000px; text-wrap: balance; }
  .foot { display: flex; justify-content: space-between; align-items: center;
    font-family: 'JetBrains Mono', monospace; font-size: 22px; color: ${light['ink-2']}; }
  .slot { display: inline-block; width: 160px; height: 14px; border-radius: 7px; background: ${light.confirmed}; }
  </style></head><body>
  ${svg}
  <div><p class="eyebrow">${escape(eyebrow)}</p><h1>${escape(title)}</h1></div>
  <div class="foot"><span>slotlock.pylota.io</span><span class="slot"></span></div>
  </body></html>`;
}

async function main() {
  const missingOnly = process.argv.includes('--missing');
  const wanted = missingOnly ? IMAGES.filter((image) => !existsSync(at(`public/og/${image.name}.png`))) : IMAGES;
  if (process.argv.includes('--list')) {
    for (const image of wanted) console.log(image.name);
    return;
  }
  if (missingOnly && wanted.length === 0) {
    console.log('og-images: none missing');
    return;
  }
  const require = createRequire(import.meta.url);
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    console.error('og-images: install Playwright first (see the header of this file).');
    process.exit(1);
  }
  const browser = await playwright.chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
  );
  const svg = await logo();
  // A file:// page, so it may load the fonts from public/fonts.
  const scratch = await mkdtemp(join(tmpdir(), 'slotlock-og-'));
  const shoot = async (html, width, height, path) => {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const file = join(scratch, 'card.html');
    await writeFile(file, html);
    await page.goto(pathToFileURL(file).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    await writeFile(at(path), await page.screenshot({ type: 'png' }));
    await page.close();
  };
  for (const image of wanted) await shoot(card(svg, image), 1200, 630, `public/og/${image.name}.png`);
  await browser.close();
  await rm(scratch, { recursive: true, force: true });
  console.log(`og-images: ${wanted.length} previews`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
