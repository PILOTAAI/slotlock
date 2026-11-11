// The pages outside the docs, each written for one thing people search for (docs/rfc/0005-search.md,
// Phase 2): the words live in src/data/pages/*.ts as data of this shape, so the HTML page
// (src/components/marketing/Page.astro) and its Markdown twin (pageMarkdown below) cannot say
// different things, as with the landing page and /index.md.
import type { Heading } from '../data/landing';
import { absolute, breadcrumb, graph, ogImage, type Seo, webPage } from './seo';

export interface PageLink {
  label: string;
  href: string;
}

/** A block of a section. Text takes `code` and [links](/path) (src/lib/rich.ts). */
export type Block =
  | { kind: 'text'; paragraphs: string[] }
  | { kind: 'list'; items: string[] }
  | { kind: 'cards'; items: { title: string; body: string; href?: string }[] }
  | { kind: 'steps'; items: { title: string; body: string }[] }
  | { kind: 'table'; caption: string; columns: string[]; rows: string[][]; highlight?: number }
  | { kind: 'code'; caption: string; code: string }
  | { kind: 'faq'; items: { q: string; a: string }[] }
  | { kind: 'links'; items: PageLink[] }
  | { kind: 'sources'; checked: string; items: PageLink[] };

export interface Section {
  id: string;
  /** The topic in plain words, set small inside the h2. */
  topic: string;
  heading: Heading;
  lede?: string;
  blocks: Block[];
}

export interface MarketingPage {
  /** Site path with a trailing slash. */
  path: string;
  title: string;
  description: string;
  /** Name of the image in public/og/ (scripts/og-images.mjs). */
  image: string;
  imageAlt: string;
  /** The trail above the heading, after "Slotlock"; the last is this page. */
  crumbs: { name: string; path: string }[];
  hero: { topic: string; heading: Heading; lede: string; actions?: PageLink[] };
  sections: Section[];
  closing?: { heading: Heading; actions: PageLink[] };
  /** Structured data beyond the page and its breadcrumb (SoftwareApplication, Offer, …). */
  jsonLd?: object[];
  /** schema.org type of the page itself. */
  pageType?: 'WebPage' | 'AboutPage' | 'CollectionPage' | 'ItemPage';
}

/** `/pricing/` → `/pricing.md`, `/use-cases/car-rental/` → `/use-cases/car-rental.md`. */
export const markdownPath = (path: string) => `${path.replace(/\/$/, '')}.md`;

export function pageSeo(page: MarketingPage): Seo {
  const crumbs = [{ name: 'Slotlock', path: '/' }, ...page.crumbs];
  return {
    title: page.title,
    description: page.description,
    path: page.path,
    image: ogImage(page.image),
    imageAlt: page.imageAlt,
    markdown: markdownPath(page.path),
    jsonLd: [
      graph(
        webPage({ title: page.title, description: page.description, path: page.path }, page.pageType),
        breadcrumb(crumbs),
        ...(page.jsonLd ?? []),
      ),
    ],
  };
}

const SITE_LINK = /\]\(\//g;
const md = (text: string) => text.replace(SITE_LINK, `](${absolute('/')}`);
const link = (l: PageLink) => `[${l.label}](${l.href.startsWith('/') ? absolute(l.href) : l.href})`;
const heading = (level: string, h: Heading, topic?: string) =>
  `${level} ${topic ? `${topic}: ` : ''}${h.soft} ${h.strong}`;
/** A Markdown table cell: backslashes first, so an escaped pipe in the text stays one. */
const cell = (text: string) => md(text).replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

function blockMarkdown(block: Block): string {
  switch (block.kind) {
    case 'text':
      return block.paragraphs.map(md).join('\n\n');
    case 'list':
      return block.items.map((item) => `- ${md(item)}`).join('\n');
    case 'cards':
      return block.items
        .map((item) => `- **${item.href ? link({ label: item.title, href: item.href }) : item.title}.** ${md(item.body)}`)
        .join('\n');
    case 'steps':
      return block.items.map((item, i) => `${i + 1}. **${item.title}.** ${md(item.body)}`).join('\n');
    case 'table':
      return [
        `| ${block.columns.map(cell).join(' | ')} |`,
        `| ${block.columns.map(() => '---').join(' | ')} |`,
        ...block.rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
      ].join('\n');
    case 'code':
      return `${block.caption}:\n\n\`\`\`\n${block.code}\n\`\`\``;
    case 'faq':
      return block.items.map((item) => `**${item.q}** ${md(item.a)}`).join('\n\n');
    case 'links':
      return block.items.map(link).join(' · ');
    case 'sources':
      return `Sources, checked ${block.checked}:\n\n${block.items.map((item) => `- ${link(item)}`).join('\n')}`;
  }
}

/** The page as Markdown, for agents: the same words, one heading per section. */
export function pageMarkdown(page: MarketingPage): string {
  const parts = [
    `# ${page.title}`,
    `> ${page.description}`,
    heading('##', page.hero.heading, page.hero.topic),
    md(page.hero.lede),
    ...(page.hero.actions?.length ? [page.hero.actions.map(link).join(' · ')] : []),
  ];
  for (const section of page.sections) {
    parts.push(heading('##', section.heading, section.topic));
    if (section.lede) parts.push(md(section.lede));
    for (const block of section.blocks) parts.push(blockMarkdown(block));
  }
  if (page.closing) {
    parts.push(heading('##', page.closing.heading), page.closing.actions.map(link).join(' · '));
  }
  parts.push(`Page: ${absolute(page.path)} · [llms.txt](${absolute('/llms.txt')})`);
  return `${parts.join('\n\n')}\n`;
}
