// Where people go for help (PROD-4, W18): Discussions are off, so nothing may send questions there;
// support, abuse, privacy and security each have a published route, and GitHub's issue form offers
// the private ones before a public issue.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const path = (file: string) => new URL(`../../${file}`, import.meta.url);
const read = (file: string) => (existsSync(path(file)) ? readFileSync(path(file), 'utf8') : '');
const flat = (text: string) => text.replace(/\s+/g, ' ');

describe('support routes', () => {
  it('sends questions to issues or support, not to Discussions, which are off', () => {
    const maintainers = flat(read('MAINTAINERS.md'));
    expect(maintainers).toContain('[.github/SUPPORT.md](.github/SUPPORT.md)');
    expect(maintainers.toLowerCase()).not.toContain('discussion');
    // configure-github.sh leaves Discussions off and says these two files route questions.
    expect(read('scripts/configure-github.sh')).toContain(
      'MAINTAINERS.md and .github/SUPPORT.md send questions to issues',
    );
  });

  it('publishes a route for help, abuse, privacy, security and status', () => {
    const support = flat(read('.github/SUPPORT.md'));
    for (const route of [
      'https://github.com/PILOTAAI/slotlock/issues',
      'support@pylota.io',
      'abuse@pylota.io',
      'privacy@pylota.io',
      'https://github.com/PILOTAAI/slotlock/security/advisories/new',
      'label%3Astatus',
    ]) {
      expect(support, route).toContain(route);
    }
    expect(support.toLowerCase()).not.toContain('discussion');
  });

  it('says in SECURITY.md that the hosted service is not open, and invites no testing of it', () => {
    const security = flat(read('SECURITY.md'));
    expect(security).toContain('## Hosted Slotlock');
    expect(security).toContain(
      'The hosted service is not open; self-hosting is the only supported path today.',
    );
    expect(security).toContain('Do not test `slotlock-api.pylota.io` or `app.slotlock.pylota.io`');
    expect(security).not.toContain('## Testing hosted Slotlock');
    expect(security).not.toMatch(/is in scope/);
    // TERMS.md and ACCEPTABLE-USE.md send researchers here.
    for (const file of ['TERMS.md', 'ACCEPTABLE-USE.md']) {
      expect(flat(read(file)), file).toContain('as [SECURITY.md](SECURITY.md) describes');
    }
  });

  it('offers the private routes on the new-issue page', () => {
    const config = read('.github/ISSUE_TEMPLATE/config.yml');
    expect(config).toMatch(/^blank_issues_enabled: true$/m);
    const links = [...config.matchAll(/^ {4}url: (\S+)$/gm)].map(([, url]) => url as string);
    expect(links).toEqual([
      'https://github.com/PILOTAAI/slotlock/security/advisories/new',
      'https://slotlock.pylota.io/docs/hosted/#help',
      'https://github.com/PILOTAAI/slotlock/issues?q=is%3Aissue%20label%3Astatus%20is%3Aopen',
    ]);
    // The hosted page has the Help section the link points at.
    expect(read('docs/hosted/README.md')).toMatch(/^## Help$/m);
  });
});
