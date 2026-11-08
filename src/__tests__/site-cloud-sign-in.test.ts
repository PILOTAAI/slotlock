// The site's Slotlock Cloud claims (site/src/data/landing.ts, the docs header): every sign-in button
// goes to the hosted dashboard, the policies named beside it are pages the site builds, and the
// endpoints the landing page lists are the ones docs/hosted/README.md publishes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const path = (file: string) => new URL(`../../${file}`, import.meta.url);
const read = (file: string) => readFileSync(path(file), 'utf8');

const DASHBOARD = 'https://app.slotlock.pylota.io/dashboard';
const API = 'https://slotlock-api.pylota.io';
const POLICIES = ['terms', 'acceptable-use', 'privacy'];

describe('the site signs people in to Slotlock Cloud', () => {
  const landing = read('site/src/data/landing.ts');

  it('sends every sign-in button to the hosted dashboard', () => {
    expect(landing).toContain(`export const SIGN_IN_URL = '${DASHBOARD}';`);
    expect(landing).toContain(`export const CLOUD_API_URL = '${API}';`);
    expect(landing).toMatch(/export const signIn = \{\n {2}label: 'Sign in',[^}]*href: SIGN_IN_URL,/);
    const page = read('site/src/pages/index.astro');
    // The header, the hero, the Cloud section and the closing band.
    expect(page.match(/href=\{signIn\.href\}/g)?.length).toBe(4);
    expect(page).not.toMatch(/target="_blank"/);
    // The docs: beside GitHub in the wide header and the menu (Starlight's SocialIcons), and beside
    // the menu button in the narrow header (Header).
    const config = read('site/astro.config.mjs');
    for (const component of ['SocialIcons', 'Header']) {
      expect(config).toContain(`${component}: './src/components/docs/${component}.astro'`);
      expect(read(`site/src/components/docs/${component}.astro`)).toContain('href={signIn.href}');
    }
  });

  it('names the policies beside the button, each a page the site builds', () => {
    const terms = /terms:\n\s+'([^']+)'/.exec(landing)?.[1] ?? '';
    expect(terms).toMatch(/^By signing in you agree to the /);
    const docs = readdirSync(path('site/docs-src')).map((file) => file.replace(/\.md$/, ''));
    const config = read('site/astro.config.mjs');
    for (const policy of POLICIES) {
      expect(terms).toContain(`](/docs/${policy}/)`);
      expect(docs, policy).toContain(policy);
      expect(config, policy).toContain(`'docs/${policy}'`);
    }
  });

  it('lists the endpoints the hosted service page publishes', () => {
    const hosted = read('docs/hosted/README.md');
    for (const [suffix, published] of [
      ['/mcp', `\`${API}/mcp\``],
      ['/a2a', `\`${API}/a2a\``],
      ['/v1', `\`${API}/v1\``],
      ['/openapi.json', '`/openapi.json`'],
      ['/.well-known/agent-card.json', '`/.well-known/agent-card.json`'],
    ]) {
      expect(landing).toContain(`value: \`\${CLOUD_API_URL}${suffix}\``);
      expect(hosted).toContain(published);
    }
    expect(hosted).toContain(`\`${DASHBOARD}\``);
    expect(read('site/src/data/llms.mjs')).toContain(DASHBOARD);
  });

  // After `npm run build` in site/: what a visitor gets, on the landing page and every docs page.
  it.runIf(existsSync(path('site/dist/index.html')))('puts the button on every built page', () => {
    const signIn = `href="${DASHBOARD}"`;
    const landingHtml = read('site/dist/index.html');
    expect(landingHtml.split(signIn).length - 1).toBeGreaterThanOrEqual(4);
    for (const policy of POLICIES) {
      expect(landingHtml).toContain(`href="/docs/${policy}/"`);
      expect(existsSync(path(`site/dist/docs/${policy}/index.html`)), policy).toBe(true);
    }
    for (const page of ['docs/index.html', 'docs/hosted/index.html', 'docs/quickstart/index.html']) {
      // The wide header, the narrow header and the narrow-screen menu.
      expect(read(`site/dist/${page}`).split(signIn).length - 1, page).toBe(3);
    }
    // The not-found page has no sidebar, so no menu: the two headers only.
    expect(read('site/dist/404.html').split(signIn).length - 1).toBe(2);
  });
});
