// What the documentation promises about the hosted service's safety must match the code: the
// request limits serve applies (SEC-1/SURF-1: the README's production checklist and SECURITY.md name
// them), and what write confirmation is (SEC-17: the client asks its person, so a key holder's own
// client can say yes; it is not an authorization boundary).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const flat = (text: string) => text.replace(/\s+/g, ' ');

/** A section of a Markdown document: from its heading to the next heading of its level or above. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`${heading}\n`);
  expect(start, `canary: ${heading} exists`).toBeGreaterThanOrEqual(0);
  const level = /^#+/.exec(heading)?.[0].length ?? 2;
  const rest = markdown.slice(start + heading.length);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end === -1 ? rest : rest.slice(0, end);
}

describe('hosted safety in the documentation', () => {
  const readme = read('README.md');
  const security = read('SECURITY.md');

  it('names the request limits in the production checklist and the security model', () => {
    const checklist = flat(section(readme, '### Production checklist'));
    expect(checklist).toContain('SLOTLOCK_LIMITS');
    expect(checklist).toContain('SLOTLOCK_TRUSTED_PROXY_HEADER');
    expect(checklist).toContain('consumeRateLimit');
    const model = flat(section(security, '## Security model'));
    expect(model).toMatch(/`slotlock serve`[^.]*limits requests per client address/);
  });

  it('says confirmation is attested by the client, not an authorization boundary', () => {
    const confirm = flat(section(readme, '### Confirm before writing'));
    expect(confirm).toContain('not an authorization boundary');
    expect(flat(security)).toContain('not an authorization boundary');
    // The security page includes that README section and must not promise more in its summary.
    const page = read('site/docs-src/security.md');
    expect(page).toContain('<!-- include README.md#confirm-before-writing body -->');
    expect(page).not.toMatch(/A person can confirm each one/);
  });
});
