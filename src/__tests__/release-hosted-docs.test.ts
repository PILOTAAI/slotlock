// The public paperwork of hosted Slotlock (P16/PROD-1/PROD-3/SEC-7, P18/PROD-15, PROD-4, PROD-25):
// a privacy notice with what UK GDPR Article 13 asks for, terms with the Article 28(3) processing
// terms, an acceptable-use policy, a hosted service page whose limits are the code's, a versioning
// policy for /v1, and a site that links them instead of saying there is no hosted service.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SLOTLOCK_DASHBOARD_MAX_RESOURCES } from '../dashboard.js';
import { SLOTLOCK_API_KEY_ACTIVE_LIMIT, SLOTLOCK_API_KEY_RETAINED_LIMIT } from '../ddl.js';
import { SLOTLOCK_API_KEY_MAX_LIFETIME_DAYS } from '../api-keys.js';
import { SLOTLOCK_CALENDAR_HORIZON_DAYS } from '../rules.js';
import { parseAvailabilityRules } from '../weekly-hours.js';
import {
  SLOTLOCK_AGENT_OWNER_COMMAND_QUOTA,
  SLOTLOCK_AGENT_OWNER_EVENT_QUOTA,
  SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS,
} from '../store.js';

const path = (file: string) => new URL(`../../${file}`, import.meta.url);
const read = (file: string) => (existsSync(path(file)) ? readFileSync(path(file), 'utf8') : '');
const flat = (text: string) => text.replace(/\s+/g, ' ');
const thousands = (value: number) => value.toLocaleString('en-GB');

/** A constant the package does not export, read from its one declaration; the match is a canary. */
function declared(file: string, pattern: RegExp): number {
  const match = pattern.exec(read(file));
  expect(match, `canary: ${pattern} in ${file}`).not.toBeNull();
  return (match?.[1] ?? '')
    .split('*')
    .map((part) => Number(part.trim().replace(/_/g, '')))
    .reduce((a, b) => a * b, 1);
}

const BANNER = '> **Draft — requires owner and legal review before the hosted service opens.**';

describe('the legal drafts', () => {
  it('each open with the owner-and-legal-review banner', () => {
    for (const file of ['PRIVACY.md', 'TERMS.md', 'ACCEPTABLE-USE.md']) {
      expect(read(file).split('\n').slice(0, 4), file).toContain(BANNER);
    }
  });

  it('give the privacy notice every item UK GDPR Article 13 asks for', () => {
    const privacy = flat(read('PRIVACY.md'));
    // 13(1)(a)-(b): the controller, its contact details, and the data protection officer.
    expect(privacy).toContain('TREFT LTD');
    expect(privacy).toContain('number 16211391');
    expect(privacy).toContain('20 Wenlock Road, London, England, N1 7GU');
    expect(privacy).toContain('privacy@pylota.io');
    expect(privacy).toContain('data protection officer');
    // 13(1)(c)-(d): purposes, lawful bases, and the legitimate interests relied on.
    for (const basis of ['(b) contract', '(f) legitimate interests', '(c) legal obligation']) {
      expect(privacy).toContain(basis);
    }
    // 13(1)(e)-(f): recipients and transfers.
    for (const recipient of ['OVHcloud', 'Cloudflare, Inc.', 'GitHub, Inc.']) {
      expect(privacy).toContain(recipient);
    }
    expect(privacy).toContain('## International transfers');
    expect(privacy).toContain('Data Privacy Framework');
    // 13(2)(a): retention, as the code keeps it.
    expect(privacy).toContain(`| ${SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS} days |`);
    const sessionHours =
      declared('src/dashboard.ts', /const SESSION_TTL_MS = ([0-9_ *]+);/) / 3_600_000;
    expect(privacy).toContain(`| ${sessionHours} hours |`);
    expect(privacy).toContain('at most 7 days');
    // 13(2)(b)-(f): rights, complaints, whether the data is required, automated decisions.
    for (const right of [
      'a copy of your data',
      'correct',
      'erase',
      'restrict',
      'object',
      'portable',
    ]) {
      expect(privacy).toContain(right);
    }
    expect(privacy).toContain("Information Commissioner's Office");
    expect(privacy).toContain('tell us first');
    expect(privacy).toContain('You do not have to give us any of this');
    expect(privacy).toContain('no decisions about you by automated means');
    // The people in a tenant's calendars, and how an account is erased.
    expect(privacy).toContain("attendees' names and email addresses");
    expect(privacy).toContain('we are your processor');
    expect(privacy).toContain('To erase your account and everything in it');
  });

  it('give the terms the processing terms UK GDPR Article 28(3) requires', () => {
    const terms = flat(read('TERMS.md'));
    expect(terms).toContain('## Data processing terms');
    for (const subject of [
      'Subject matter and duration',
      'Nature and purpose',
      'Types of personal data',
      'Categories of data subjects',
    ]) {
      expect(terms).toContain(subject);
    }
    // 28(3)(a) to (h), in order.
    const duties = [
      'only on your documented instructions',
      'bound to confidentiality',
      'keep it secure',
      'use only the subprocessors',
      'help you answer requests',
      'personal data breach',
      'erase your content when your account ends',
      'contribute to audits',
    ];
    const positions = duties.map((duty) => terms.indexOf(duty));
    for (const [index, position] of positions.entries()) {
      expect(position, duties[index]).toBeGreaterThan(0);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // (a) covers transfers to a third country, which the privacy notice says Cloudflare makes, and
    // (h) audits "including inspections" (legislation.gov.uk, UK GDPR Article 28(3), read 2026-10-24).
    const first = terms.slice(terms.indexOf('1. '), terms.indexOf('2. '));
    expect(first).toMatch(/including[^;]*transfers?[^;]*outside the United Kingdom/);
    expect(terms.slice(terms.indexOf('8. '))).toContain(
      'allow for and contribute to audits, including inspections, by you or an auditor you mandate',
    );
    expect(terms).toContain('free while it is offered as a preview');
    expect(terms).toContain('no service level agreement');
    expect(terms).toContain('law of England and Wales');
    expect(terms).toContain('[Acceptable Use Policy](ACCEPTABLE-USE.md)');
  });

  it('give the acceptable-use policy its rules, enforcement and abuse address', () => {
    const policy = flat(read('ACCEPTABLE-USE.md'));
    expect(policy).toContain('special category data');
    expect(policy).toContain('[SECURITY.md](SECURITY.md)');
    expect(policy).toContain('abuse@pylota.io');
    expect(policy).toContain('never a whole key');
  });
});

describe('the hosted service page', () => {
  const page = () => flat(read('docs/hosted/README.md'));

  it('names both addresses, the price, and that writes are not confirmed', () => {
    const text = page();
    expect(text).toContain('`https://slotlock-api.pylota.io`');
    expect(text).toContain('`https://app.slotlock.pylota.io`');
    expect(text).toContain('no service level agreement');
    expect(text).toContain('Writes take effect at once.');
    expect(text).toContain('**Not open yet.**');
  });

  it('publishes the limits the code enforces', () => {
    const text = page();
    const row = (what: string, limit: string) => expect(text).toContain(`| ${what} | ${limit}`);
    row(
      'Active API keys per account',
      `${SLOTLOCK_API_KEY_ACTIVE_LIMIT} (${thousands(SLOTLOCK_API_KEY_RETAINED_LIMIT)} kept in all`,
    );
    row('Resources added in the dashboard', `${SLOTLOCK_DASHBOARD_MAX_RESOURCES} |`);
    const serveResources = declared(
      'src/self-host.ts',
      /const SERVE_MAX_TENANT_RESOURCES = ([0-9_]+);/,
    );
    row('Resources per account through the application API', `${thousands(serveResources)} |`);
    row(
      'Events one key can hold, active and cancelled',
      `${thousands(SLOTLOCK_AGENT_OWNER_EVENT_QUOTA)} |`,
    );
    row(
      'Event writes one key can have on record',
      `${thousands(SLOTLOCK_AGENT_OWNER_COMMAND_QUOTA)}, each kept ${SLOTLOCK_EVENT_COMMAND_RETENTION_DAYS} days |`,
    );
    row('A free/busy or search window', `${SLOTLOCK_CALENDAR_HORIZON_DAYS} days |`);
    const holdDays = declared('src/store.ts', /const MAX_HOLD_TTL_MS = ([0-9_ *]+);/) / 86_400_000;
    row('A hold', `${holdDays} days |`);
    const body = declared('src/agent-server.ts', /options\.maxRequestBytes \?\? ([0-9_]+)/) / 1_024;
    row('A request body', `${body} KiB |`);
    const perKey = declared(
      'src/agent-server.ts',
      /bounded\('maxPerPrincipal', 1, 64, ([0-9_]+)\)/,
    );
    const minutes =
      declared('src/agent-server.ts', /bounded\('maxDurationMs', [0-9_]+, [0-9_]+, ([0-9_]+)\)/) /
      60_000;
    const watched = declared(
      'src/agent-server.ts',
      /const MAX_RESOURCE_SUBSCRIPTIONS = ([0-9_]+);/,
    );
    row(
      'Live-update streams',
      `${perKey} at once per key, each watching up to ${watched} resources for up to ${minutes} minutes |`,
    );
  });

  // Hosted serve logs the requests it refuses with each client address as a keyed pseudonym
  // (src/rate-limit.ts, from the hosted track). A pseudonymised address is still personal data, so
  // the privacy notice says so; the code it describes is checked once that file is in this tree.
  const PSEUDONYM =
    "each named only by a pseudonym: a hash of its IP address, keyed by a secret held only in the running server's memory and replaced when it restarts";
  // Every reason the server counts a refusal for, in the notice's words.
  const REFUSALS =
    'For each minute in which the server refused requests, they also record how many it refused (over a rate limit, while too busy, too large, or with a credential it did not accept)';
  it('tells the privacy notice how refused requests are logged', () => {
    const privacy = flat(read('PRIVACY.md'));
    expect(privacy).toContain(PSEUDONYM);
    expect(privacy).toContain(REFUSALS);
  });
  it.runIf(existsSync(path('src/rate-limit.ts')))(
    'logs refused requests as the privacy notice says',
    () => {
      const limits = read('src/rate-limit.ts');
      expect(limits).toContain('const pseudonymKey = randomBytes(32);');
      expect(limits).toContain("createHmac('sha256', pseudonymKey).update(address)");
      expect(limits).toMatch(/const MAX_LOGGED_CLIENTS = 10;/);
      expect(limits).toMatch(/const REFUSAL_LOG_INTERVAL_MS = 60_000;/);
      // The reasons REFUSALS names: a rate limit, three caps on work at once, size and credentials.
      const reasons = /export type SlotlockRefusalReason =([^;]*);/.exec(limits)?.[1] ?? '';
      expect([...reasons.matchAll(/'(\w+)'/g)].map(([, reason]) => reason).sort()).toEqual([
        'auth_refused',
        'lookup_overflow',
        'maintenance_busy',
        'rate_limited',
        'request_too_large',
        'series_writes_busy',
      ]);
    },
  );

  // The request rate limits are serve's own (src/rate-limit.ts, from the hosted track): checked
  // once that file is in this tree.
  it.runIf(existsSync(path('src/rate-limit.ts')))(
    'describes the rate-limit refusal serve sends',
    () => {
      expect(read('src/rate-limit.ts')).toContain('Retry-After');
      expect(page()).toContain('`429 rate_limited` with a `Retry-After` header');
    },
  );

  it('links the terms, the policies, the status and each contact', () => {
    const text = page();
    for (const link of [
      '(/TERMS.md)',
      '(/ACCEPTABLE-USE.md)',
      '(/PRIVACY.md)',
      '(/VERSIONING.md)',
      '(/docs/hosted/status.md)',
      'support@pylota.io',
      'abuse@pylota.io',
      'privacy@pylota.io',
      '(/SECURITY.md)',
    ]) {
      expect(text).toContain(link);
    }
  });
});

describe('the versioning policy', () => {
  it('says what /v1 guarantees, the notice before a hosted change, and where to follow it', () => {
    const policy = flat(read('VERSIONING.md'));
    expect(policy).toContain('**REST under `/v1`.**');
    expect(policy).toContain('`/v2`');
    expect(policy).toContain('at least **90 days**');
    expect(policy).toContain('https://github.com/PILOTAAI/slotlock/releases.atom');
    expect(policy).toContain('**Deprecated**');
  });
});

describe('the specification and the README', () => {
  it('describe the 0.2 surfaces, with the limits the code enforces', () => {
    const spec = flat(read('SPEC.md'));
    expect(spec).not.toContain('Slotlock 0.1');
    expect(spec).toContain('### Scopes, API keys and the application API');
    expect(spec).toContain('### Maintenance');
    expect(spec).toContain(`at most ${SLOTLOCK_API_KEY_ACTIVE_LIMIT} active keys and ${thousands(SLOTLOCK_API_KEY_RETAINED_LIMIT)} in all`);
    expect(spec).toContain(`(at most ${thousands(SLOTLOCK_API_KEY_MAX_LIFETIME_DAYS)} days)`);
    expect(spec).toContain(`resources (at most ${SLOTLOCK_DASHBOARD_MAX_RESOURCES})`);
    const holdDays = declared('src/store.ts', /const MAX_HOLD_TTL_MS = ([0-9_ *]+);/) / 86_400_000;
    expect(spec).toContain(`A hold lasts at most ${holdDays} days`);
    const bufferDays =
      declared('src/store.ts', /const MAX_BUFFER_AFTER_MS = ([0-9_ *]+);/) / 86_400_000;
    expect(spec).toContain(`It is at most ${bufferDays} days`);
    const status = flat(read('README.md').split('## Project status and boundaries\n')[1] ?? '');
    expect(status).not.toContain('0.1 is the core');
    for (const surface of ['application API', 'scoped API keys', 'dashboard', 'maintenance', 'five languages']) {
      expect(status).toContain(surface);
    }
  });
});

describe('availability rule spellings (W24)', () => {
  it('names the spelling each surface takes, as their parsers read it', () => {
    const readme = read('README.md');
    const rules = /slotlock hours set '(\[[^']+\])'/.exec(readme)?.[1];
    expect(rules, 'canary: the README hours set example').toBeDefined();
    // The CLI and SLOTLOCK_AVAILABILITY parse the README's camelCase example.
    expect(parseAvailabilityRules(JSON.parse(rules ?? '[]'))).toHaveLength(1);
    expect(() =>
      parseAvailabilityRules([{ rrule: 'FREQ=WEEKLY;BYDAY=SA', start_minutes: 600, duration_minutes: 240 }]),
    ).toThrow();
    // REST publishes snake_case in its OpenAPI document.
    const openApi = read('openapi.json');
    expect(openApi).toContain('"start_minutes"');
    expect(openApi).not.toContain('"startMinutes"');
    const said = flat(readme);
    expect(said).toContain('A rule is `rrule`, `startMinutes` and `durationMinutes` here and in `SLOTLOCK_AVAILABILITY`.');
    expect(said).toContain('`rrule`, `start_minutes` and `duration_minutes`.');
  });
});

describe('the site', () => {
  it('builds a page from each document and lists it in the sidebar', () => {
    const config = read('site/astro.config.mjs');
    for (const [page, include] of [
      ['hosted', 'docs/hosted/README.md'],
      ['status', 'docs/hosted/status.md'],
      ['privacy', 'PRIVACY.md'],
      ['terms', 'TERMS.md'],
      ['acceptable-use', 'ACCEPTABLE-USE.md'],
      ['versioning', 'VERSIONING.md'],
      ['clients', 'clients/python/README.md snippet'],
      ['clients', 'clients/dotnet/README.md snippet'],
      ['operations', 'README.md#operations body promote'],
    ]) {
      expect(read(`site/docs-src/${page}.md`), page).toContain(`<!-- include ${include} -->`);
      expect(config, page).toContain(`'docs/${page}'`);
    }
  });

  it('no longer says there is no hosted service, and links the hosted pages from every page footer', () => {
    const landing = read('site/src/data/landing.ts');
    expect(landing).not.toContain('There is no hosted service');
    expect(landing).not.toContain('Works once the first release is published');
    expect(landing).not.toContain('`Not yet.');
    for (const href of [
      '/docs/hosted/',
      '/docs/status/',
      '/docs/privacy/',
      '/docs/terms/',
      '/docs/acceptable-use/',
    ]) {
      expect(landing).toContain(`href: '${href}'`);
    }
  });

  it('is rebuilt when any document it includes changes', () => {
    const workflow = read('.github/workflows/site.yml');
    const filters = [...workflow.matchAll(/^ {6}- "([^"]+)"$/gm)].map(
      ([, filter]) => filter as string,
    );
    const covered = (file: string) =>
      filters.some((filter) =>
        filter.endsWith('/**') ? file.startsWith(filter.slice(0, -2)) : filter === file,
      );
    const pages = [
      'hosted',
      'status',
      'privacy',
      'terms',
      'acceptable-use',
      'versioning',
      'known-issues',
      'clients',
      'operations',
    ];
    const included = pages.flatMap((page) =>
      [...read(`site/docs-src/${page}.md`).matchAll(/<!-- (?:include|code) ([^#\s>]+)/g)].map(
        ([, file]) => file as string,
      ),
    );
    // Every page includes at least one document; the clients page one per language.
    expect(included.length).toBeGreaterThanOrEqual(pages.length);
    const examples = [...read('site/docs-src/library.md').matchAll(/<!-- code ([^#\s>]+)/g)].map(
      ([, file]) => file as string,
    );
    expect(examples.length, 'the library page shows the tested examples').toBeGreaterThan(0);
    for (const file of [...included, ...examples, 'openapi.json']) {
      expect(covered(file), file).toBe(true);
    }
  });

  it('tells agents in llms.txt about hosted Slotlock, and about 0.2 only while it is current', async () => {
    const { llmsDetails } = (await import(path('site/src/data/llms.mjs').href)) as {
      llmsDetails: (pages: string, version: string) => string;
    };
    const current = llmsDetails('- pages', '0.2.0');
    expect(current).not.toContain('no hosted service');
    expect(current).toContain('https://slotlock-api.pylota.io');
    expect(current).toContain('https://slotlock.pylota.io/docs/known-issues.md');
    expect(current).toContain('Event writes (`slotlock_create_event`');
    expect(current.endsWith('- pages')).toBe(true);
    expect(llmsDetails('- pages', '0.3.0')).not.toContain('known-issues');
  });
});
