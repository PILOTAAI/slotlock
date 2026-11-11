// Verified domains (teams phase 5): a team proves it controls a domain with a TXT record at
// _slotlock-challenge.<domain> holding slotlock-verification=<token>, a token of 128 random bits
// drawn for that one claim. Slotlock looks the record up again every day: a domain stays verified
// only while its record stays (Atlassian's rule, support.atlassian.com "Verify a domain", read
// 2026-11-11), so a domain that changes hands lapses instead of handing its new owner the team.
//
// This module is what both runtimes share: the one normaliser every domain a person types and every
// email's domain go through, the refusals (public suffixes, consumer mail, special-use names), the
// token, and the lookups. A Worker has no UDP or TCP to DNS servers, so the lookup there is
// DNS-over-HTTPS JSON (Cloudflare's, cross-checked by Google's); a self-hosted server may use the
// system's resolver instead, which follows split-horizon corporate DNS.
import { parse } from 'tldts';

/** The label the record lives under: `_slotlock-challenge.<domain>`. */
export const SLOTLOCK_DOMAIN_RECORD_LABEL = '_slotlock-challenge';
/** What the record's value starts with, before the token. */
export const SLOTLOCK_DOMAIN_RECORD_PREFIX = 'slotlock-verification=';
/** A token: 128 random bits in RFC 4648 base32, lowercase, unpadded (26 characters). */
export const SLOTLOCK_DOMAIN_TOKEN = /^[a-z2-7]{26}$/;

/** Why a domain cannot be claimed. */
export type SlotlockDomainRefusal = 'invalid_domain' | 'public_suffix' | 'consumer_domain';

/** A domain as Slotlock keys it (ASCII, lowercase, punycode) and as people read it. */
export interface SlotlockDomain {
  ascii: string;
  unicode: string;
}

/**
 * Domains whose addresses anyone can get: a team cannot claim them, so their addresses never join
 * a team by domain. The large providers only (Atlassian, Notion and WorkOS refuse the same).
 */
export const SLOTLOCK_CONSUMER_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '126.com', '163.com', 'aim.com', 'aol.com', 'att.net', 'btinternet.com', 'comcast.net', 'duck.com',
  'fastmail.com', 'free.fr', 'gmail.com', 'gmx.com', 'gmx.de', 'gmx.net', 'googlemail.com', 'hey.com',
  'hotmail.co.uk', 'hotmail.com', 'hotmail.fr', 'hushmail.com', 'icloud.com', 'inbox.com', 'laposte.net',
  'libero.it', 'live.com', 'mac.com', 'mail.com', 'mail.ru', 'mailinator.com', 'me.com', 'msn.com',
  'naver.com', 'orange.fr', 'outlook.com', 'pm.me', 'proton.me', 'protonmail.com', 'qq.com', 'rediffmail.com',
  'rocketmail.com', 't-online.de', 'tuta.io', 'tutanota.com', 'verizon.net', 'web.de', 'yahoo.co.uk',
  'yahoo.com', 'yahoo.fr', 'yandex.com', 'yandex.ru', 'ymail.com', 'zoho.com',
]);

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The domain someone typed, as Slotlock keys it, or why it cannot be claimed: lowercased, mapped
 * and punycoded as a URL host is (so `BÜCHER.de` is `xn--bcher-kva.de`), one trailing dot dropped;
 * never an IP, a single label, an empty label, a special-use name (RFC 6761: example, test,
 * localhost, …), a top-level domain the Public Suffix List does not know, or a public suffix
 * itself, ICANN's (`co.uk`) or a private one (`github.io`, `workers.dev`).
 */
export function normalizeSlotlockDomain(input: string): SlotlockDomain | { refusal: SlotlockDomainRefusal } {
  const typed = input.trim();
  if (typed === '' || typed.length > 300 || /[@/\\:*?#\s[\]%]/.test(typed)) return { refusal: 'invalid_domain' };
  let host: string;
  try {
    host = new URL(`http://${typed}`).hostname;
  } catch {
    return { refusal: 'invalid_domain' };
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length > 253 || IPV4.test(host) || host.startsWith('[')) return { refusal: 'invalid_domain' };
  const labels = host.split('.');
  // The URL parser keeps `example..com` as it is: an empty label is refused here.
  if (labels.length < 2 || !labels.every((label) => LABEL.test(label))) return { refusal: 'invalid_domain' };
  const found = parse(host, { allowPrivateDomains: true, detectIp: true, detectSpecialUse: true, extractHostname: false });
  if (found.isIp || found.isSpecialUse) return { refusal: 'invalid_domain' };
  if (!found.isIcann && !found.isPrivate) return { refusal: 'invalid_domain' };
  if (found.domain === null || found.publicSuffix === host) return { refusal: 'public_suffix' };
  if (SLOTLOCK_CONSUMER_EMAIL_DOMAINS.has(host)) return { refusal: 'consumer_domain' };
  const unicode = labels.map((label) => (label.startsWith('xn--') ? decodePunycode(label.slice(4)) : label));
  if (unicode.some((label) => label === null)) return { refusal: 'invalid_domain' };
  return { ascii: host, unicode: unicode.join('.') };
}

/**
 * The domain of an email address as normalizeSlotlockDomain keys it, or null: what a verified
 * address is matched on (exactly: `a@sub.example.org` is not at `example.org`).
 */
export function slotlockEmailDomain(email: string): string | null {
  const at = email.lastIndexOf('@');
  if (at < 1 || at === email.length - 1) return null;
  const domain = normalizeSlotlockDomain(email.slice(at + 1));
  return 'ascii' in domain ? domain.ascii : null;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A new token for one claim: 128 bits from the platform's CSPRNG, never derived from the domain. */
export function slotlockDomainToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let bits = 0;
  let value = 0;
  let token = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      token += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) token += BASE32[(value << (5 - bits)) & 31];
  return token;
}

/** The record a team publishes for a claim. */
export function slotlockDomainRecord(domain: string, token: string): { name: string; value: string } {
  return { name: `${SLOTLOCK_DOMAIN_RECORD_LABEL}.${domain}`, value: `${SLOTLOCK_DOMAIN_RECORD_PREFIX}${token}` };
}

/** What one resolver said about a name's TXT records. */
export type SlotlockTxtAnswer =
  /** The name exists: its TXT values (none when it has other records only). */
  | { status: 'ok'; values: string[]; ad: boolean; ttl: number | null }
  /** The name does not exist (NXDOMAIN). */
  | { status: 'nxdomain'; ad: boolean }
  /** No answer worth acting on: SERVFAIL, refused, a timeout, an HTTP error, a malformed body. */
  | { status: 'error'; reason: string };

/** A resolver: asked for a name's TXT records, it answers, never throws. */
export interface SlotlockDnsResolver {
  readonly name: string;
  txt(name: string): Promise<SlotlockTxtAnswer>;
}

/** Whether the record a claim needs is there: `present`, `absent`, or `error` (decides nothing). */
export type SlotlockRecordVerdict = 'present' | 'absent' | 'error';

/**
 * A TXT record's text from its presentation form: the quoted character-strings joined (`"a" "b"`
 * is `ab`, with `\"` and `\\` unescaped), or the text as it is when it is not quoted. Cloudflare's
 * JSON quotes TXT data and Google's does not (live queries, 2026-11-11): both read the same here.
 */
export function slotlockTxtText(data: string): string {
  const trimmed = data.trim();
  if (!trimmed.startsWith('"')) return trimmed;
  let text = '';
  let inside = false;
  for (let index = 0; index < trimmed.length; index++) {
    const character = trimmed[index] as string;
    if (!inside) {
      if (character === '"') inside = true;
      continue;
    }
    if (character === '\\' && index + 1 < trimmed.length) {
      const next = trimmed[index + 1] as string;
      // \DDD is a decimal octet (RFC 1035 5.1).
      const octet = /^\d{3}$/.test(trimmed.slice(index + 1, index + 4)) ? Number(trimmed.slice(index + 1, index + 4)) : null;
      if (octet !== null && octet <= 255) {
        text += String.fromCharCode(octet);
        index += 3;
      } else {
        text += next;
        index += 1;
      }
      continue;
    }
    if (character === '"') {
      inside = false;
      continue;
    }
    text += character;
  }
  return text;
}

/** A DNS name as answers spell it, compared: lowercase, without its trailing dot. */
const dnsName = (value: unknown) => (typeof value === 'string' ? value.toLowerCase().replace(/\.$/, '') : null);

/**
 * A DNS-over-HTTPS JSON answer (Cloudflare's application/dns-json, Google's /resolve) as an answer:
 * Status 0 with the type-16 records of the name asked for (none is NODATA), 3 as NXDOMAIN, anything
 * else an error. A name that is an alias (a CNAME or DNAME in the answer) holds no record of its
 * own: a wildcard CNAME to a host someone else controls must not let them prove the domain.
 */
export function slotlockDohTxtAnswer(body: unknown, asked?: string): SlotlockTxtAnswer {
  if (typeof body !== 'object' || body === null) return { status: 'error', reason: 'malformed' };
  const answer = body as { Status?: unknown; AD?: unknown; Answer?: unknown };
  const ad = answer.AD === true;
  if (answer.Status === 3) return { status: 'nxdomain', ad };
  if (answer.Status !== 0) return { status: 'error', reason: `status ${String(answer.Status)}` };
  if (answer.Answer !== undefined && !Array.isArray(answer.Answer)) return { status: 'error', reason: 'malformed' };
  const values: string[] = [];
  let ttl: number | null = null;
  const records = (answer.Answer ?? []) as unknown[];
  if (records.some((record) => typeof record !== 'object' || record === null)) return { status: 'error', reason: 'malformed' };
  if (records.some((record) => (record as { type?: unknown }).type === 5 || (record as { type?: unknown }).type === 39)) {
    return { status: 'ok', values: [], ad, ttl: null };
  }
  for (const record of records) {
    const { type, data, TTL, name } = record as { type?: unknown; data?: unknown; TTL?: unknown; name?: unknown };
    if (type !== 16) continue;
    if (asked !== undefined && dnsName(name) !== dnsName(asked)) continue;
    if (typeof data !== 'string') return { status: 'error', reason: 'malformed' };
    values.push(slotlockTxtText(data));
    if (typeof TTL === 'number' && Number.isFinite(TTL)) ttl = ttl === null ? TTL : Math.min(ttl, TTL);
  }
  return { status: 'ok', values, ad, ttl };
}

/** The public DNS-over-HTTPS JSON endpoints Slotlock asks (their docs, read 2026-11-11). */
export const SLOTLOCK_DOH_ENDPOINTS = Object.freeze({
  cloudflare: 'https://cloudflare-dns.com/dns-query',
  google: 'https://dns.google/resolve',
});

/** A DNS-over-HTTPS resolver: Cloudflare's or Google's JSON API, through fetch. */
export function createSlotlockDohResolver(
  name: keyof typeof SLOTLOCK_DOH_ENDPOINTS,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): SlotlockDnsResolver {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    name,
    async txt(host) {
      const url = new URL(SLOTLOCK_DOH_ENDPOINTS[name]);
      url.search = new URLSearchParams({ name: host, type: 'TXT' }).toString();
      try {
        const response = await fetchImpl(url.href, {
          headers: { accept: 'application/dns-json', 'cache-control': 'no-cache' },
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) return { status: 'error', reason: `HTTP ${response.status}` };
        const text = await response.text();
        if (text.length > 65_536) return { status: 'error', reason: 'too large' };
        return slotlockDohTxtAnswer(JSON.parse(text), host);
      } catch (error) {
        return { status: 'error', reason: error instanceof Error ? error.name : 'failed' };
      }
    },
  };
}

/** The system's resolver (node:dns), for a self-hosted server: loaded only when asked for. */
export function createSlotlockSystemResolver(options: { timeoutMs?: number } = {}): SlotlockDnsResolver {
  const timeoutMs = options.timeoutMs ?? 5_000;
  return {
    name: 'system',
    async txt(host) {
      try {
        const { Resolver } = await import('node:dns/promises');
        const resolver = new Resolver({ timeout: timeoutMs, tries: 2 });
        // An alias holds no record of its own (see slotlockDohTxtAnswer).
        const aliases = await resolver.resolveCname(host).catch((error: { code?: unknown }) => {
          if (error.code === 'ENODATA' || error.code === 'ENOTFOUND') return [];
          throw error;
        });
        if (aliases.length > 0) return { status: 'ok', values: [], ad: false, ttl: null };
        const records = await resolver.resolveTxt(host);
        // Each record arrives as its character-strings: joined, as DNS-over-HTTPS joins them.
        return { status: 'ok', values: records.map((chunks) => chunks.join('')), ad: false, ttl: null };
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        if (code === 'ENOTFOUND') return { status: 'nxdomain', ad: false };
        if (code === 'ENODATA') return { status: 'ok', values: [], ad: false, ttl: null };
        return { status: 'error', reason: typeof code === 'string' ? code : 'failed' };
      }
    },
  };
}

/** Whether an answer holds exactly the value expected (never a substring of another). */
export function slotlockRecordVerdict(answer: SlotlockTxtAnswer, expected: string): SlotlockRecordVerdict {
  if (answer.status === 'error') return 'error';
  if (answer.status === 'nxdomain') return 'absent';
  return answer.values.includes(expected) ? 'present' : 'absent';
}

/** What a check of one claim found, for record_domain_check and the audit log. */
export interface SlotlockDomainCheck {
  /** The first resolver's verdict: verifying needs `present` from it. */
  primary: SlotlockRecordVerdict;
  /** The second's, or null with one resolver: lapsing needs `absent` from both. */
  secondary: SlotlockRecordVerdict | null;
  /** Per resolver: what it said, for the audit log (the values are public DNS data). */
  detail: { resolver: string; verdict: SlotlockRecordVerdict; ad: boolean | null; ttl: number | null; values: string[]; reason: string | null }[];
}

/** Ask each resolver (at most two) for a claim's record. */
export async function checkSlotlockDomain(
  resolvers: readonly SlotlockDnsResolver[],
  domain: string,
  token: string,
): Promise<SlotlockDomainCheck> {
  const { name, value } = slotlockDomainRecord(domain, token);
  const asked = await Promise.all(resolvers.slice(0, 2).map(async (resolver) => ({ resolver, answer: await resolver.txt(name) })));
  const detail = asked.map(({ resolver, answer }) => ({
    resolver: resolver.name,
    verdict: slotlockRecordVerdict(answer, value),
    ad: answer.status === 'error' ? null : answer.ad,
    ttl: answer.status === 'ok' ? answer.ttl : null,
    // What else sits at the label, cut short: enough to see a typo, never a page of it.
    values: answer.status === 'ok' ? answer.values.slice(0, 5).map((text) => text.slice(0, 120)) : [],
    reason: answer.status === 'error' ? answer.reason.slice(0, 60) : null,
  }));
  return { primary: detail[0]?.verdict ?? 'error', secondary: detail[1]?.verdict ?? null, detail };
}

/** The resolvers for SLOTLOCK_DNS_RESOLVER: DNS-over-HTTPS (Cloudflare, then Google), or the system's. */
export function slotlockDomainResolvers(
  mode: 'doh' | 'system',
  options: { fetch?: typeof fetch } = {},
): SlotlockDnsResolver[] {
  if (mode === 'system') return [createSlotlockSystemResolver()];
  return [createSlotlockDohResolver('cloudflare', options), createSlotlockDohResolver('google', options)];
}

// RFC 3492 (Punycode) decoding, for showing a domain as people read it beside its ASCII form.
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;

function adapt(delta: number, points: number, first: boolean): number {
  let scaled = first ? Math.floor(delta / 700) : delta >> 1;
  scaled += Math.floor(scaled / points);
  let k = 0;
  while (scaled > ((BASE - T_MIN) * T_MAX) >> 1) {
    scaled = Math.floor(scaled / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * scaled) / (scaled + 38));
}

function digitOf(code: number): number {
  if (code >= 48 && code <= 57) return code - 22;
  if (code >= 65 && code <= 90) return code - 65;
  if (code >= 97 && code <= 122) return code - 97;
  return BASE;
}

/** A punycode label's Unicode, or null when it is not valid punycode. */
function decodePunycode(input: string): string | null {
  const output: number[] = [];
  const basic = input.lastIndexOf('-');
  for (let index = 0; index < basic; index++) output.push(input.charCodeAt(index));
  let n = 128;
  let bias = 72;
  let i = 0;
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length; ) {
    const before = i;
    let weight = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitOf(input.charCodeAt(index++));
      if (digit >= BASE) return null;
      i += digit * weight;
      const threshold = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < threshold) break;
      weight *= BASE - threshold;
      if (!Number.isSafeInteger(i) || weight > 2 ** 40) return null;
    }
    bias = adapt(i - before, output.length + 1, before === 0);
    n += Math.floor(i / (output.length + 1));
    i %= output.length + 1;
    if (n > 0x10ffff) return null;
    output.splice(i++, 0, n);
  }
  return String.fromCodePoint(...output);
}
