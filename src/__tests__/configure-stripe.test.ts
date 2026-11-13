// scripts/configure-stripe.mjs against a stand-in for Stripe's API: it creates the two products, the
// four GBP prices by lookup key, the webhook and the portal settings once; moves a lookup key off a
// price of the old amount and archives that price; keeps everything on a second run; changes nothing
// on --dry-run; and never prints the webhook's signing secret.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'configure-stripe.mjs');
const KEY = 'sk_test_configure';
const SIGNING_SECRET = 'whsec_test_secret_value';

interface Price {
  id: string;
  product: string;
  unit_amount: number;
  currency: string;
  recurring: { interval: string; usage_type: string };
  lookup_key: string | null;
  active: boolean;
}
let products: { id: string; name: string; tax_code: string | null; metadata: Record<string, string> }[] = [];
let prices: Price[] = [];
let endpoints: { id: string; url: string; status: string; enabled_events: string[] }[] = [];
let portals: { id: string; is_default: boolean; body?: Record<string, string> }[] = [];
const writes: { path: string; body: Record<string, string> }[] = [];
let server: Server;
let base = '';
const scratch: string[] = [];

async function body(request: IncomingMessage) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return Object.fromEntries(new URLSearchParams(text));
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const send = (status: number, payload: unknown) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    if (request.headers.authorization !== `Bearer ${KEY}`) return send(401, { error: { message: 'Invalid API Key provided' } });
    const url = new URL(request.url ?? '/', 'http://stub');
    const path = url.pathname.replace(/^\/v1\//, '');
    if (request.method === 'GET') {
      if (path === 'balance') return send(200, { object: 'balance', livemode: false });
      if (path === 'products') return send(200, { data: products.filter(() => true) });
      if (path === 'prices') {
        const keys = url.searchParams.getAll('lookup_keys[]');
        return send(200, { data: prices.filter((price) => price.lookup_key && keys.includes(price.lookup_key)) });
      }
      if (path === 'webhook_endpoints') return send(200, { data: endpoints });
      if (path === 'billing_portal/configurations') return send(200, { data: portals });
      return send(404, { error: { message: 'unknown' } });
    }
    const fields = await body(request);
    writes.push({ path, body: fields });
    if (path === 'products') {
      const product = { id: `prod_${products.length + 1}`, name: fields.name ?? '', tax_code: fields.tax_code ?? null, metadata: { slotlock_plan: fields['metadata[slotlock_plan]'] ?? '' } };
      products.push(product);
      return send(200, product);
    }
    if (path.startsWith('products/')) {
      const product = products.find((item) => item.id === path.split('/')[1]);
      if (product) {
        product.tax_code = fields.tax_code ?? product.tax_code;
        if (fields['metadata[slotlock_plan]']) product.metadata = { slotlock_plan: fields['metadata[slotlock_plan]'] };
      }
      return send(200, product ?? {});
    }
    if (path === 'prices') {
      if (fields.transfer_lookup_key === 'true') for (const price of prices) if (price.lookup_key === fields.lookup_key) price.lookup_key = null;
      const price: Price = {
        id: `price_${prices.length + 1}`,
        product: fields.product ?? '',
        unit_amount: Number(fields.unit_amount),
        currency: fields.currency ?? '',
        recurring: { interval: fields['recurring[interval]'] ?? '', usage_type: 'licensed' },
        lookup_key: fields.lookup_key ?? null,
        active: true,
      };
      prices.push(price);
      return send(200, price);
    }
    if (path.startsWith('prices/')) {
      const price = prices.find((item) => item.id === path.split('/')[1]);
      if (price && fields.active === 'false') price.active = false;
      return send(200, price ?? {});
    }
    if (path === 'webhook_endpoints') {
      const events = Object.entries(fields).filter(([name]) => name.startsWith('enabled_events')).map(([, value]) => value);
      const endpoint = { id: `we_${endpoints.length + 1}`, url: fields.url ?? '', status: 'enabled', enabled_events: events };
      endpoints.push(endpoint);
      return send(200, { ...endpoint, secret: SIGNING_SECRET });
    }
    if (path.startsWith('webhook_endpoints/')) return send(200, {});
    if (path.startsWith('billing_portal/configurations')) {
      const id = path.split('/')[2];
      const portal = portals.find((item) => item.id === id);
      if (portal) portal.body = fields;
      return send(200, portal ?? {});
    }
    return send(404, { error: { message: 'unknown' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => {
  server.close();
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  // As the sandbox stood on 13 November 2026: Developer in dollars, no Team, no webhook.
  products = [{ id: 'prod_dev', name: 'Slotlock Developer', tax_code: 'txcd_10103001', metadata: {} }];
  prices = [
    { id: 'price_usd_m', product: 'prod_dev', unit_amount: 1000, currency: 'usd', recurring: { interval: 'month', usage_type: 'licensed' }, lookup_key: 'slotlock_developer_monthly', active: true },
    { id: 'price_usd_y', product: 'prod_dev', unit_amount: 10000, currency: 'usd', recurring: { interval: 'year', usage_type: 'licensed' }, lookup_key: 'slotlock_developer_yearly', active: true },
  ];
  endpoints = [];
  portals = [{ id: 'bpc_1', is_default: true }];
  writes.length = 0;
});

/** A wrangler that records its arguments and stdin. */
function fakeWrangler() {
  const dir = mkdtempSync(join(tmpdir(), 'slotlock-stripe-'));
  scratch.push(dir);
  const wrangler = join(dir, 'wrangler');
  writeFileSync(
    wrangler,
    `#!${process.execPath}\nconst fs = require('node:fs');\nlet input = '';\nprocess.stdin.on('data', (d) => (input += d)).on('end', () => fs.writeFileSync(${JSON.stringify(join(dir, 'call.json'))}, JSON.stringify({ args: process.argv.slice(2), input })));\n`,
    { mode: 0o755 },
  );
  return { wrangler, call: () => JSON.parse(readFileSync(join(dir, 'call.json'), 'utf8')) as { args: string[]; input: string } };
}

function run(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH ?? '', SLOTLOCK_STRIPE_API: base, STRIPE_SECRET_KEY: KEY, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return new Promise<{ code: number | null; output: string }>((resolve) => child.on('close', (code) => resolve({ code, output })));
}

describe('configure-stripe.mjs', () => {
  it('sets up both plans in pounds, the webhook and the portal, and archives the dollar prices', async () => {
    const { wrangler, call } = fakeWrangler();
    const result = await run(['--dashboard-worker', 'slotlock-dashboard'], { SLOTLOCK_WRANGLER: wrangler });
    expect(result.code, result.output).toBe(0);
    // Developer kept and tagged; Team created with the SaaS tax code.
    expect(products.map((product) => [product.name, product.tax_code])).toEqual([
      ['Slotlock Developer', 'txcd_10103001'],
      ['Slotlock Team', 'txcd_10103001'],
    ]);
    const active = prices.filter((price) => price.active).map((price) => [price.lookup_key, price.unit_amount, price.currency, price.recurring.interval]);
    expect(active).toEqual([
      ['slotlock_developer_monthly', 500, 'gbp', 'month'],
      ['slotlock_developer_yearly', 5000, 'gbp', 'year'],
      ['slotlock_team_monthly', 1500, 'gbp', 'month'],
      ['slotlock_team_yearly', 15000, 'gbp', 'year'],
    ]);
    // The dollar prices lost their lookup keys and were archived, not deleted.
    expect(prices.filter((price) => price.currency === 'usd').map((price) => [price.id, price.lookup_key, price.active])).toEqual([
      ['price_usd_m', null, false],
      ['price_usd_y', null, false],
    ]);
    expect(endpoints).toEqual([
      {
        id: 'we_1',
        url: 'https://app.slotlock.pylota.io/stripe/webhook',
        status: 'enabled',
        enabled_events: [
          'checkout.session.completed',
          'customer.subscription.created',
          'customer.subscription.updated',
          'customer.subscription.deleted',
          'invoice.paid',
          'invoice.payment_failed',
        ],
      },
    ]);
    // The signing secret goes to the dashboard Worker on stdin, and is never printed.
    expect(call()).toEqual({ args: ['secret', 'put', 'STRIPE_WEBHOOK_SECRET', '--name', 'slotlock-dashboard'], input: SIGNING_SECRET });
    expect(result.output).not.toContain(SIGNING_SECRET);
    expect(result.output).not.toContain(KEY);
    expect(portals[0]?.body).toMatchObject({
      default_return_url: 'https://app.slotlock.pylota.io/dashboard',
      'features[subscription_cancel][mode]': 'at_period_end',
      'features[invoice_history][enabled]': 'true',
    });
    // The variables the dashboard Worker needs.
    for (const line of [
      'SLOTLOCK_STRIPE_PRICE_MONTHLY=price_3',
      'SLOTLOCK_STRIPE_PRICE_YEARLY=price_4',
      'SLOTLOCK_STRIPE_PRICE_TEAM_MONTHLY=price_5',
      'SLOTLOCK_STRIPE_PRICE_TEAM_YEARLY=price_6',
    ]) {
      expect(result.output).toContain(line);
    }
  });

  it('keeps everything on a second run', async () => {
    await run([]);
    writes.length = 0;
    const again = await run([]);
    expect(again.code, again.output).toBe(0);
    // Only the portal is written again; no product, price or webhook.
    expect(writes.map((write) => write.path)).toEqual(['billing_portal/configurations/bpc_1']);
    expect(again.output).toContain('kept the price slotlock_team_yearly (price_6): £150 a year');
    expect(again.output).toContain('kept the webhook endpoint https://app.slotlock.pylota.io/stripe/webhook (we_1)');
  });

  it('changes nothing on --dry-run, and says where the secret is without a dashboard Worker', async () => {
    const dry = await run(['--dry-run']);
    expect(dry.code, dry.output).toBe(0);
    expect(dry.output).toContain('would create the price slotlock_developer_monthly: £5 a month, moving its lookup key from price_usd_m (10 USD), which is archived');
    expect(dry.output).toContain('would create the product Slotlock Team');
    expect(dry.output).toContain('Nothing was changed.');
    expect(writes).toEqual([]);
    const real = await run([]);
    expect(real.output).toContain('Signing secret. Set it as the dashboard Worker\'s STRIPE_WEBHOOK_SECRET');
    expect(real.output).not.toContain(SIGNING_SECRET);
  });

  it('adds missing events to a webhook endpoint that exists, and refuses to start without a key', async () => {
    endpoints = [{ id: 'we_9', url: 'https://app.slotlock.pylota.io/stripe/webhook', status: 'enabled', enabled_events: ['checkout.session.completed'] }];
    const result = await run([]);
    expect(result.output).toContain('update the webhook endpoint https://app.slotlock.pylota.io/stripe/webhook (we_9): add customer.subscription.created');
    expect(writes.some((write) => write.path === 'webhook_endpoints/we_9')).toBe(true);
    expect((await run([], { STRIPE_SECRET_KEY: '' })).code).toBe(2);
    expect((await run([], { STRIPE_SECRET_KEY: 'sk_test_wrong' })).code).toBe(1);
  });
});
