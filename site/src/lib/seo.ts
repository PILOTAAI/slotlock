// What search engines and link previews read: absolute URLs, Open Graph images, and the JSON-LD
// (schema.org) graph. The landing page and the marketing pages pass these to SeoHead.astro; the docs
// get the same through src/routeData.ts. Prices and versions come from facts.json, so the
// structured data cannot claim what the page does not.
//
// Rules this follows (docs/rfc/0005-search.md, Part 4, checked by scripts/seo-check.mjs):
// - titles at most 65 characters, descriptions 70 to 160, both unique across the site;
// - one canonical per page: absolute, https://slotlock.pylota.io, with a trailing slash;
// - every og:image a 1200 × 630 PNG in public/og/;
// - no ratings or reviews in the structured data: there are none.
import facts from '../generated/facts.json';

export const SITE = 'https://slotlock.pylota.io';
export const REPO = 'https://github.com/PILOTAAI/slotlock';
export const LOCALE = 'en-GB';
export const OG_LOCALE = 'en_GB';
export const OG_SIZE = { width: 1200, height: 630 } as const;
export const LOGO = `${SITE}/brand/slotlock-512.png`;

/** An absolute URL on this site: `/pricing/` → `https://slotlock.pylota.io/pricing/`. */
export const absolute = (path: string) => (path.startsWith('http') ? path : `${SITE}${path}`);

/** The Open Graph image for a page: `/og/<name>.png`, drawn by scripts/og-images.mjs. */
export const ogImage = (name: string) => `/og/${name}.png`;

export interface Seo {
  title: string;
  description: string;
  /** Site path with a trailing slash, for example `/pricing/`. */
  path: string;
  /** `/og/<name>.png`; see ogImage(). */
  image: string;
  imageAlt: string;
  /** `website` for the landing page, `article` for posts, `website` otherwise. */
  type?: 'website' | 'article';
  /** The page's Markdown twin, for agents. */
  markdown?: string;
  jsonLd?: object[];
  noindex?: boolean;
}

/**
 * Cut a description to at most `max` characters at a word boundary, keeping whole sentences when
 * the first one fits: search results show about 155 characters.
 */
export function clampDescription(text: string, max = 155): string {
  const flat = text.replace(/\s+/g, ' ').replace(/`/g, '').trim();
  if (flat.length <= max) return flat;
  const sentences = flat.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [];
  let out = '';
  for (const sentence of sentences) {
    if ((out + sentence).trim().length > max) break;
    out += sentence;
  }
  if (out.trim().length >= 70) return out.trim();
  const cut = flat.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:(]$/, '')}…`;
}

/** JSON for a `<script type="application/ld+json">` block; `<` is escaped so no text can end it. */
export const jsonLdText = (data: object) => JSON.stringify(data).replace(/</g, '\\u003c');

const ORG_ID = `${SITE}/#organization`;
const WEBSITE_ID = `${SITE}/#website`;
const SOFTWARE_ID = `${SITE}/#software`;

/** Pylota, the publisher: the footer's "A Pylota project · © 2026 TREFT LTD". */
export const organization = {
  '@type': 'Organization',
  '@id': ORG_ID,
  name: 'Pylota',
  legalName: 'TREFT LTD',
  url: 'https://pylota.io',
  email: 'support@pylota.io',
  sameAs: ['https://github.com/PILOTAAI'],
};

export const website = {
  '@type': 'WebSite',
  '@id': WEBSITE_ID,
  name: 'Slotlock',
  alternateName: 'Slotlock booking API',
  url: `${SITE}/`,
  inLanguage: LOCALE,
  publisher: { '@id': ORG_ID },
};

interface HostedPlan {
  id: string;
  monthly: number;
  yearly: number;
}

const PLAN_NAMES: Record<string, string> = { free: 'Free', developer: 'Developer', team: 'Team' };
const plans = ((facts as { plans?: HostedPlan[] | null }).plans ?? []) as HostedPlan[];

/** One Offer per hosted plan (monthly price, USD), plus self-hosting at no charge. */
export function offers() {
  const hosted = plans.map((plan) => ({
    '@type': 'Offer',
    name: `Slotlock Cloud ${PLAN_NAMES[plan.id] ?? plan.id}`,
    price: String(plan.monthly),
    priceCurrency: 'USD',
    url: `${SITE}/pricing/`,
    ...(plan.monthly > 0
      ? {
          priceSpecification: {
            '@type': 'UnitPriceSpecification',
            price: String(plan.monthly),
            priceCurrency: 'USD',
            unitText: 'MONTH',
          },
        }
      : {}),
  }));
  return [
    ...hosted,
    {
      '@type': 'Offer',
      name: 'Self-hosted (Apache-2.0)',
      price: '0',
      priceCurrency: 'USD',
      url: `${SITE}/open-source/`,
    },
  ];
}

export const softwareApplication = (description: string) => ({
  '@type': 'SoftwareApplication',
  '@id': SOFTWARE_ID,
  name: 'Slotlock',
  description,
  url: `${SITE}/`,
  image: LOGO,
  applicationCategory: 'DeveloperApplication',
  applicationSubCategory: 'Booking and scheduling API',
  operatingSystem: 'Any (hosted); Linux containers (self-hosted)',
  softwareVersion: facts.version,
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  offers: offers(),
  publisher: { '@id': ORG_ID },
  sameAs: [REPO],
});

export const softwareSourceCode = {
  '@type': 'SoftwareSourceCode',
  name: 'Slotlock',
  codeRepository: REPO,
  license: 'https://www.apache.org/licenses/LICENSE-2.0',
  programmingLanguage: 'TypeScript',
  runtimePlatform: 'Node.js',
  targetProduct: { '@id': SOFTWARE_ID },
};

/** Home › … › page, for the breadcrumb Google shows above a result. */
export function breadcrumb(items: { name: string; path: string }[]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: absolute(item.path),
    })),
  };
}

/** A page's JSON-LD as one graph, with the site and its publisher. */
export function graph(...nodes: object[]) {
  return { '@context': 'https://schema.org', '@graph': [organization, website, ...nodes] };
}

export function webPage(seo: { title: string; description: string; path: string }, type = 'WebPage') {
  return {
    '@type': type,
    '@id': `${absolute(seo.path)}#webpage`,
    url: absolute(seo.path),
    name: seo.title,
    description: seo.description,
    inLanguage: LOCALE,
    isPartOf: { '@id': WEBSITE_ID },
    about: { '@id': SOFTWARE_ID },
  };
}

export function article(
  seo: { title: string; description: string; path: string; image: string },
  options: { type: 'TechArticle' | 'BlogPosting'; published?: string; modified?: string; author?: object },
) {
  return {
    '@type': options.type,
    '@id': `${absolute(seo.path)}#article`,
    headline: seo.title.replace(/ \| Slotlock$/, ''),
    description: seo.description,
    url: absolute(seo.path),
    mainEntityOfPage: absolute(seo.path),
    image: absolute(seo.image),
    inLanguage: LOCALE,
    ...(options.published ? { datePublished: options.published } : {}),
    ...(options.modified ? { dateModified: options.modified } : {}),
    author: options.author ?? { '@id': ORG_ID },
    publisher: { '@id': ORG_ID },
    isPartOf: { '@id': WEBSITE_ID },
    about: { '@id': SOFTWARE_ID },
  };
}

export const SOFTWARE_REF = { '@id': SOFTWARE_ID };
