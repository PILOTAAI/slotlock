// /about/: who builds Slotlock and how to reach them, from MAINTAINERS.md, GOVERNANCE.md,
// docs/hosted/README.md (Help) and PRIVACY.md (the controller).
import facts from '../../generated/facts.json';
import type { MarketingPage } from '../../lib/page';
import { PYLOTA_URL, REPO_URL } from '../landing';

export const aboutPage: MarketingPage = {
  path: '/about/',
  title: 'About Slotlock: who builds it, and how to reach us',
  description:
    'Slotlock is an open-source booking engine for AI agents, built by TREFT LTD as part of Pylota. Who maintains it, how it is governed, and every contact address.',
  image: 'about',
  imageAlt: 'About Slotlock: who builds it, and how to reach us.',
  crumbs: [{ name: 'About', path: '/about/' }],
  pageType: 'AboutPage',
  hero: {
    topic: 'About',
    heading: { soft: 'A booking engine built for one fleet,', strong: 'opened up for every agent.' },
    lede: `Slotlock started as the booking engine inside [Pylota](${PYLOTA_URL}), the AI fleet manager for independent car rental operators. It is now its own ${facts.license} project, with a hosted service, Slotlock Cloud, run by the same company.`,
    actions: [
      { label: 'Source on GitHub', href: REPO_URL },
      { label: 'Read the docs', href: '/docs/' },
    ],
  },
  sections: [
    {
      id: 'story',
      topic: 'Why it exists',
      heading: { soft: 'Agents book at machine speed.', strong: 'The calendar has to refuse for them.' },
      blocks: [
        {
          kind: 'text',
          paragraphs: [
            'At Pylota, agents quote rental cars to renters and book them. Two can ask for the same car at the same moment, a renter can stop halfway through paying, and a marketplace can publish a booking late. A check in application code can pass for both writers in a race, so every booking at Pylota goes through a store where PostgreSQL itself refuses the second one.',
            'That store became Slotlock: a calendar per resource, holds that expire on the database clock, time that no feed has proven treated as unknown, and the same operations over MCP, A2A and REST. Pylota still runs it as a library inside its own database, and checks every booking with it.',
          ],
        },
        { kind: 'links', items: [{ label: 'How Pylota uses Slotlock', href: '/blog/pylota-car-rental-case-study/' }] },
      ],
    },
    {
      id: 'company',
      topic: 'Company',
      heading: { soft: 'Built by TREFT LTD,', strong: 'as a Pylota project.' },
      blocks: [
        {
          kind: 'list',
          items: [
            'TREFT LTD (company number 16211391), registered office 20 Wenlock Road, London, England, N1 7GU, builds Slotlock and runs Slotlock Cloud. It is the controller of the data Slotlock Cloud keeps ([privacy notice](/docs/privacy/)).',
            `The code is ${facts.license}. GOVERNANCE.md commits to keeping it under an OSI-approved licence.`,
            'Slotlock Cloud runs in the United Kingdom, on OVHcloud\'s London servers behind Cloudflare.',
          ],
        },
      ],
    },
    {
      id: 'maintainers',
      topic: 'Maintainers and governance',
      heading: { soft: 'Every change reviewed.', strong: 'Security changes reviewed twice.' },
      blocks: [
        {
          kind: 'text',
          paragraphs: [
            '[@cleverom](https://github.com/cleverom) maintains Slotlock: all areas, security, releases and conduct reports. Routine changes need a maintainer\'s approval and green checks. Changes to the public API, the data model, scheduling semantics, tenancy or security boundaries need an RFC or an issue, and, while there is one maintainer, an independent security review by someone other than the author.',
            'Releases follow semantic versioning from a single version across the server and every client, and Slotlock Cloud gives 90 days\' notice before anything under `/v1` changes.',
          ],
        },
        {
          kind: 'links',
          items: [
            { label: 'Governance', href: `${REPO_URL}/blob/main/GOVERNANCE.md` },
            { label: 'Maintainers', href: `${REPO_URL}/blob/main/MAINTAINERS.md` },
            { label: 'Versions and stability', href: '/docs/versioning/' },
          ],
        },
      ],
    },
    {
      id: 'contact',
      topic: 'Contact',
      heading: { soft: 'Write to a person.', strong: 'Report security issues privately.' },
      blocks: [
        {
          kind: 'table',
          caption: 'Where to write for each kind of question',
          columns: ['What', 'Where'],
          rows: [
            ['Questions and account help on Slotlock Cloud', '`support@pylota.io`'],
            ['Abuse of the service', '`abuse@pylota.io`'],
            ['Your data: a copy, a correction or erasure', '`privacy@pylota.io`'],
            ['Paid plans on your own servers, with support and a contract', '`support@pylota.io`, or [the hosted service page](/docs/hosted/#plans)'],
            ['Security vulnerabilities', `GitHub private vulnerability reporting ([security policy](${REPO_URL}/blob/main/SECURITY.md)), never a public issue`],
            ['Bugs and ideas', `An issue on [GitHub](${REPO_URL}/issues)`],
          ],
        },
      ],
    },
  ],
  closing: {
    heading: { soft: 'Read the code before you trust it.', strong: 'Then let your agents book.' },
    actions: [
      { label: 'Source on GitHub', href: REPO_URL },
      { label: 'Pricing', href: '/pricing/' },
    ],
  },
};
