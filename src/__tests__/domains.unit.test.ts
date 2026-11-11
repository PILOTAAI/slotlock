// The DNS side of verified domains (domains.ts): one normaliser for every domain and address, the
// refusals, the token, the TXT parser for both DNS-over-HTTPS dialects (Cloudflare quotes TXT data,
// Google does not: live queries 2026-11-11), and the verdicts. The Public Suffix List is tldts's
// (pinned 7.4.19), run for real. SLOTLOCK_LIVE_DNS=1 also asks both public resolvers.
import { domainToUnicode } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  SLOTLOCK_DOH_ENDPOINTS,
  checkSlotlockDomain,
  createSlotlockDohResolver,
  normalizeSlotlockDomain,
  slotlockDohTxtAnswer,
  slotlockDomainRecord,
  slotlockDomainToken,
  slotlockEmailDomain,
  slotlockRecordVerdict,
  slotlockTxtText,
} from '../domains.js';
import { slotlockMatchableEmails } from '../workspace-domains.js';

describe('normalizeSlotlockDomain', () => {
  it('keys a domain as a URL host would, and shows it as people read it', () => {
    expect(normalizeSlotlockDomain('Acme-Rentals.COM.')).toEqual({ ascii: 'acme-rentals.com', unicode: 'acme-rentals.com' });
    expect(normalizeSlotlockDomain('BÜCHER.de')).toEqual({ ascii: 'xn--bcher-kva.de', unicode: 'bücher.de' });
    expect(normalizeSlotlockDomain('ＡＣＭＥ－ＲＥＮＴＡＬＳ．ｃｏｍ')).toEqual({ ascii: 'acme-rentals.com', unicode: 'acme-rentals.com' });
    expect(normalizeSlotlockDomain('xn--bcher-kva.de')).toEqual({ ascii: 'xn--bcher-kva.de', unicode: 'bücher.de' });
    expect(normalizeSlotlockDomain('  clinic.co.uk ')).toEqual({ ascii: 'clinic.co.uk', unicode: 'clinic.co.uk' });
    expect(normalizeSlotlockDomain('www.ck')).toEqual({ ascii: 'www.ck', unicode: 'www.ck' });
  });

  it('refuses what is not a domain one can own', () => {
    const long = `${'a'.repeat(63)}.`.repeat(4).concat('com');
    for (const typed of [
      '', 'example..com', 'exa mple.com', '1.2.3.4', '[::1]', 'localhost', 'foo.test', 'example.com', 'a@b.com',
      'http://acme.com/x', 'acme.com:443', '*.acme.com', `${'a'.repeat(64)}.com`, long, 'acme', '-acme.com', 'acme-.com',
      'acme.corp', 'xn--zz.com',
    ]) {
      expect(normalizeSlotlockDomain(typed), typed).toEqual({ refusal: 'invalid_domain' });
    }
  });

  it("refuses public suffixes, ICANN's and private ones, and consumer mail", () => {
    for (const typed of ['com', 'co.uk', 'github.io', 'vercel.app', 'workers.dev', 'anything.ck', 'pages.dev']) {
      expect(normalizeSlotlockDomain(typed), typed).toEqual({ refusal: typed === 'com' ? 'invalid_domain' : 'public_suffix' });
    }
    for (const typed of ['gmail.com', 'GMAIL.COM', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'icloud.com', 'proton.me']) {
      expect(normalizeSlotlockDomain(typed), typed).toEqual({ refusal: 'consumer_domain' });
    }
    // A team's own subdomain of a private suffix is its to claim.
    expect(normalizeSlotlockDomain('acme.github.io')).toEqual({ ascii: 'acme.github.io', unicode: 'acme.github.io' });
  });

  it('decodes punycode as Node does', () => {
    for (const ascii of ['xn--bcher-kva.de', 'xn--mnchen-3ya.de', 'xn--fiqs8s.cn', 'xn--80ak6aa92e.com', 'xn--r8jz45g.jp']) {
      const normalized = normalizeSlotlockDomain(ascii);
      expect(normalized, ascii).toEqual({ ascii, unicode: domainToUnicode(ascii) });
    }
  });
});

describe('addresses', () => {
  it('matches an address on its domain exactly, in its ASCII form', () => {
    expect(slotlockEmailDomain('Desk@Acme-Rentals.com')).toBe('acme-rentals.com');
    expect(slotlockEmailDomain('desk@bücher.de')).toBe('xn--bcher-kva.de');
    expect(slotlockEmailDomain('desk@gmail.com')).toBeNull();
    expect(slotlockEmailDomain('nobody')).toBeNull();
    expect(slotlockMatchableEmails(['Desk@Acme-Rentals.com', 'me@gmail.com', 'x@bücher.de'])).toEqual([
      'desk@acme-rentals.com',
      'x@xn--bcher-kva.de',
    ]);
  });
});

describe('tokens and records', () => {
  it('draws 128 random bits per claim', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => slotlockDomainToken()));
    expect(tokens.size).toBe(200);
    for (const token of tokens) expect(token).toMatch(/^[a-z2-7]{26}$/);
    expect(slotlockDomainRecord('acme-rentals.com', 'abc')).toEqual({
      name: '_slotlock-challenge.acme-rentals.com',
      value: 'slotlock-verification=abc',
    });
  });
});

describe('TXT answers', () => {
  it('reads both DNS-over-HTTPS dialects the same', () => {
    const cloudflare = { Status: 0, AD: true, Answer: [{ name: 'acme.com', type: 16, TTL: 212, data: '"v=spf1 -all"' }] };
    const google = { Status: 0, AD: false, Answer: [{ name: 'acme.com.', type: 16, TTL: 300, data: 'v=spf1 -all' }] };
    expect(slotlockDohTxtAnswer(cloudflare)).toEqual({ status: 'ok', values: ['v=spf1 -all'], ad: true, ttl: 212 });
    expect(slotlockDohTxtAnswer(google)).toEqual({ status: 'ok', values: ['v=spf1 -all'], ad: false, ttl: 300 });
  });

  it('joins character-strings and unescapes, keeps TXT records only, and tells NXDOMAIN, NODATA and errors apart', () => {
    expect(slotlockTxtText('"slotlock-verification=" "abc"')).toBe('slotlock-verification=abc');
    expect(slotlockTxtText('"say \\"hi\\" \\\\ \\065"')).toBe('say "hi" \\ A');
    const mixed = {
      Status: 0,
      Answer: [
        { name: 'x', type: 5, TTL: 60, data: 'target.example.net.' },
        { name: 'target', type: 16, TTL: 60, data: '"a"' },
      ],
    };
    // A name that is an alias holds no record of its own, whatever its target holds.
    expect(slotlockDohTxtAnswer(mixed)).toEqual({ status: 'ok', values: [], ad: false, ttl: null });
    const plain = { Status: 0, Answer: [{ name: 'x', type: 16, TTL: 60, data: '"a"' }, { name: 'x', type: 6, TTL: 60, data: 'soa' }] };
    expect(slotlockDohTxtAnswer(plain)).toEqual({ status: 'ok', values: ['a'], ad: false, ttl: 60 });
    expect(slotlockDohTxtAnswer({ Status: 0, Authority: [{ type: 6 }] })).toEqual({ status: 'ok', values: [], ad: false, ttl: null });
    expect(slotlockDohTxtAnswer({ Status: 3, AD: true })).toEqual({ status: 'nxdomain', ad: true });
    expect(slotlockDohTxtAnswer({ Status: 2 })).toEqual({ status: 'error', reason: 'status 2' });
    expect(slotlockDohTxtAnswer(null)).toEqual({ status: 'error', reason: 'malformed' });
    expect(slotlockDohTxtAnswer({ Status: 0, Answer: 'x' })).toEqual({ status: 'error', reason: 'malformed' });
    expect(slotlockDohTxtAnswer({ Status: 0, Answer: [{ type: 16, data: 7 }] })).toEqual({ status: 'error', reason: 'malformed' });
  });

  it("counts only the name's own records: an alias (CNAME, DNAME) holds none, and another name's records are not its", () => {
    const asked = '_slotlock-challenge.acme-rentals.com';
    const aliased = {
      Status: 0,
      Answer: [
        { name: asked, type: 5, TTL: 60, data: 'acme.some-saas.net.' },
        { name: 'acme.some-saas.net.', type: 16, TTL: 60, data: '"slotlock-verification=tok"' },
      ],
    };
    expect(slotlockDohTxtAnswer(aliased, asked)).toEqual({ status: 'ok', values: [], ad: false, ttl: null });
    const dname = { Status: 0, Answer: [{ name: 'acme-rentals.com', type: 39, TTL: 60, data: 'evil.example.' }, { name: asked, type: 16, TTL: 60, data: '"x"' }] };
    expect(slotlockDohTxtAnswer(dname, asked)).toEqual({ status: 'ok', values: [], ad: false, ttl: null });
    const other = { Status: 0, Answer: [{ name: 'elsewhere.example.', type: 16, TTL: 60, data: '"slotlock-verification=tok"' }] };
    expect(slotlockDohTxtAnswer(other, asked)).toEqual({ status: 'ok', values: [], ad: false, ttl: null });
    const own = { Status: 0, Answer: [{ name: `${asked.toUpperCase()}.`, type: 16, TTL: 60, data: '"slotlock-verification=tok"' }] };
    expect(slotlockDohTxtAnswer(own, asked)).toEqual({ status: 'ok', values: ['slotlock-verification=tok'], ad: false, ttl: 60 });
  });

  it('finds the record only by its exact value', () => {
    const value = 'slotlock-verification=abc';
    const answer = (values: string[]) => ({ status: 'ok' as const, values, ad: false, ttl: 1 });
    expect(slotlockRecordVerdict(answer([value]), value)).toBe('present');
    for (const near of [`${value}x`, `x${value}`, `v=spf1 include:${value} -all`, value.toUpperCase()]) {
      expect(slotlockRecordVerdict(answer([near]), value), near).toBe('absent');
    }
    expect(slotlockRecordVerdict({ status: 'nxdomain', ad: false }, value)).toBe('absent');
    expect(slotlockRecordVerdict({ status: 'error', reason: 'x' }, value)).toBe('error');
  });
});

describe('DNS-over-HTTPS resolvers', () => {
  it('asks the documented JSON endpoints for TXT, uncached, without following redirects', async () => {
    const fetch = vi.fn(async (url: string | URL | Request) =>
      Response.json({ Status: 0, Answer: [{ name: new URL(String(url)).searchParams.get('name'), type: 16, TTL: 5, data: '"slotlock-verification=tok"' }] }),
    );
    const check = await checkSlotlockDomain(
      [createSlotlockDohResolver('cloudflare', { fetch }), createSlotlockDohResolver('google', { fetch })],
      'acme-rentals.com',
      'tok',
    );
    expect(check.primary).toBe('present');
    expect(check.secondary).toBe('present');
    const [cloudflareUrl, cloudflareInit] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const [googleUrl] = fetch.mock.calls[1] as unknown as [string, RequestInit];
    expect(cloudflareUrl).toBe(`${SLOTLOCK_DOH_ENDPOINTS.cloudflare}?name=_slotlock-challenge.acme-rentals.com&type=TXT`);
    expect(googleUrl).toBe(`${SLOTLOCK_DOH_ENDPOINTS.google}?name=_slotlock-challenge.acme-rentals.com&type=TXT`);
    expect(cloudflareInit.headers).toMatchObject({ accept: 'application/dns-json', 'cache-control': 'no-cache' });
    expect(cloudflareInit.redirect).toBe('error');
  });

  it('answers an error, never throws, on HTTP errors, bad bodies and timeouts', async () => {
    const fails = [
      async () => new Response('nope', { status: 400 }),
      async () => new Response('not json'),
      async () => {
        throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
      },
      async () => new Response('x'.repeat(70_000)),
    ];
    for (const fail of fails) {
      const resolver = createSlotlockDohResolver('cloudflare', { fetch: vi.fn(fail) as unknown as typeof fetch });
      expect((await resolver.txt('acme.com')).status).toBe('error');
    }
  });
});

describe.skipIf(process.env.SLOTLOCK_LIVE_DNS !== '1')('the public resolvers, live', () => {
  it("both return example.com's SPF record", async () => {
    for (const name of ['cloudflare', 'google'] as const) {
      const answer = await createSlotlockDohResolver(name).txt('example.com');
      expect(answer.status, name).toBe('ok');
      expect(answer.status === 'ok' && answer.values, name).toContain('v=spf1 -all');
    }
  });
});

describe('SLOTLOCK_VERIFIED_DOMAINS', () => {
  it('is off unless on, needs team workspaces, and looks domains up over DNS-over-HTTPS unless told system', async () => {
    const { readDashboardConfig, readVerifiedDomains } = await import('../config.js');
    const base = {
      SLOTLOCK_GITHUB_CLIENT_ID: 'Ov23liAbCdEfGhIjKlMn',
      SLOTLOCK_GITHUB_CLIENT_SECRET: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      SLOTLOCK_SESSION_SECRET: 'Zq8vN2kLp4Rt6Wx9Yb3Cd5Fg7Hj1Mn0Ps2Uv4Xy6Az8Bc',
      SLOTLOCK_DASHBOARD_USERS: '*',
      SLOTLOCK_DASHBOARD_TEAM_WORKSPACES: 'on',
    };
    expect(readDashboardConfig(base)?.verifiedDomains).toBeUndefined();
    expect(readDashboardConfig({ ...base, SLOTLOCK_VERIFIED_DOMAINS: 'on' })?.verifiedDomains).toEqual({ resolver: 'doh' });
    expect(readVerifiedDomains({ ...base, SLOTLOCK_VERIFIED_DOMAINS: 'on', SLOTLOCK_DNS_RESOLVER: 'system' })).toEqual({ resolver: 'system' });
    expect(() => readVerifiedDomains({ SLOTLOCK_VERIFIED_DOMAINS: 'on' })).toThrow('needs SLOTLOCK_DASHBOARD_TEAM_WORKSPACES=on');
    expect(() => readVerifiedDomains({ ...base, SLOTLOCK_VERIFIED_DOMAINS: 'yes' })).toThrow('on or off');
    expect(() => readVerifiedDomains({ ...base, SLOTLOCK_VERIFIED_DOMAINS: 'on', SLOTLOCK_DNS_RESOLVER: 'udp' })).toThrow('doh or system');
    expect(() => readVerifiedDomains({ ...base, SLOTLOCK_DNS_RESOLVER: 'doh' })).toThrow('needs SLOTLOCK_VERIFIED_DOMAINS=on');
  });
});
