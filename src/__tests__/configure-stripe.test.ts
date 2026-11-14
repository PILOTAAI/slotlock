// scripts/configure-stripe.mjs against a stand-in for Stripe's API: it creates the two products, the
// four GBP prices by lookup key, the webhook and a portal configuration for each plan once; moves a
// lookup key off a price of the old amount and archives that price; keeps everything on a second
// run; changes nothing on --dry-run; and never prints the webhook's signing secret. With
// --dashboard-worker it stores everything on the Worker in one `wrangler secret bulk`, the
// dashboard's key only once that key has done what the dashboard does and the Worker has the
// webhook's secret, and the launch check's key on GitHub once it reads what the check reads.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'configure-stripe.mjs');
const KEY = 'sk_test_configure';
/** Restricted keys, each allowed what its name says (paths below). */
const WORKER_KEY = 'rk_live_worker';
const CHECK_KEY = 'rk_live_check';
const ALLOWED: Record<string, string[]> = {
  [WORKER_KEY]: ['GET subscriptions', 'GET billing_portal/configurations', 'POST checkout/sessions', 'GET prices'],
  rk_live_noprices: ['GET subscriptions', 'GET billing_portal/configurations', 'POST checkout/sessions'],
  rk_live_nocheckout: ['GET subscriptions', 'GET billing_portal/configurations'],
  [CHECK_KEY]: ['GET products', 'GET prices', 'GET webhook_endpoints', 'GET events'],
  rk_live_noevents: ['GET products', 'GET prices', 'GET webhook_endpoints'],
};
let livemode = false;
/** What the dashboard answers an unsigned delivery: 404 with billing off, 400 with it on. */
let dashboardAnswer = 400;
const checkouts: { body: Record<string, string>; expired: boolean }[] = [];
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
let products: { id: string; name: string; tax_code: string | null; metadata: Record<string, string>; default_price?: string | null | undefined }[] = [];
let prices: Price[] = [];
let endpoints: { id: string; url: string; status: string; enabled_events: string[] }[] = [];
interface Portal {
  id: string;
  is_default: boolean;
  metadata?: Record<string, string>;
  features?: {
    subscription_update?: {
      enabled?: boolean;
      products?: { product: string; prices: string[]; adjustable_quantity?: { enabled: boolean } }[];
      proration_behavior?: string;
    };
    subscription_cancel?: { mode?: string };
    invoice_history?: { enabled?: boolean };
  };
  [field: string]: unknown;
}
let portals: Portal[] = [];
const writes: { path: string; body: Record<string, string> }[] = [];
let server: Server;
let base = '';
const scratch: string[] = [];

async function body(request: IncomingMessage) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return Object.fromEntries(new URLSearchParams(text));
}

/** Stripe's form fields (a[b][0][c]=…) as the nested object Stripe stores and returns. */
function nested(fields: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(fields)) {
    const keys = name.replace(/\]/g, '').split('[');
    let node = out as Record<string, unknown>;
    keys.forEach((key, index) => {
      const next = keys[index + 1];
      if (next === undefined) node[key] = raw === 'true' ? true : raw === 'false' ? false : raw;
      else node = (node[key] ??= /^\d+$/.test(next) ? [] : {}) as Record<string, unknown>;
    });
  }
  return out;
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const send = (status: number, payload: unknown) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    const url = new URL(request.url ?? '/', 'http://stub');
    // The dashboard itself, when --dashboard points here.
    if (url.pathname === '/stripe/webhook') return response.writeHead(dashboardAnswer).end('Bad signature.');
    const path = url.pathname.replace(/^\/v1\//, '');
    const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const allowed = ALLOWED[bearer];
    if (allowed) {
      if (!allowed.some((grant) => `${request.method} ${path}`.startsWith(grant))) {
        return send(403, { error: { message: 'The provided key does not have the required permissions for this endpoint.' } });
      }
      if (request.method === 'POST' && path === 'checkout/sessions') {
        checkouts.push({ body: await body(request), expired: false });
        return send(200, { id: `cs_live_${checkouts.length}`, url: 'https://checkout.stripe.com/c/pay/cs_live' });
      }
      if (request.method === 'POST' && path.endsWith('/expire')) {
        const session = checkouts[Number(path.split('/')[2]?.split('_')[2]) - 1];
        if (session) session.expired = true;
        return send(200, { status: 'expired' });
      }
      return send(200, { data: [] });
    }
    if (bearer !== KEY) return send(401, { error: { message: 'Invalid API Key provided' } });
    if (request.method === 'GET') {
      if (path === 'balance') return send(200, { object: 'balance', livemode });
      if (path === 'products') return send(200, { data: products.filter(() => true) });
      if (path === 'prices' && url.searchParams.has('product')) {
        const product = url.searchParams.get('product');
        return send(200, { data: prices.filter((price) => price.product === product && price.active) });
      }
      if (path === 'prices') {
        const keys = url.searchParams.getAll('lookup_keys[]');
        return send(200, { data: prices.filter((price) => price.lookup_key && keys.includes(price.lookup_key)) });
      }
      if (path === 'webhook_endpoints') return send(200, { data: endpoints });
      if (path === 'billing_portal/configurations') {
        // As Stripe: a configuration's products only when expanded.
        if (url.searchParams.getAll('expand[]').includes('data.features.subscription_update.products')) return send(200, { data: portals });
        const bare = structuredClone(portals);
        for (const portal of bare) delete portal.features?.subscription_update?.products;
        return send(200, { data: bare });
      }
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
        product.default_price = fields.default_price ?? product.default_price;
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
      // As Stripe: a product's default price cannot be archived.
      if (price && fields.active === 'false' && products.some((product) => product.default_price === price.id)) {
        return send(400, { error: { message: 'This price cannot be archived because it is the default price of its product.' } });
      }
      if (price && fields.active === 'false') price.active = false;
      return send(200, price ?? {});
    }
    if (path === 'webhook_endpoints') {
      const events = Object.entries(fields).filter(([name]) => name.startsWith('enabled_events')).map(([, value]) => value);
      const endpoint = { id: `we_${endpoints.length + 1}`, url: fields.url ?? '', status: 'enabled', enabled_events: events };
      endpoints.push(endpoint);
      return send(200, { ...endpoint, secret: SIGNING_SECRET });
    }
    if (path.startsWith('webhook_endpoints/')) {
      // As Stripe: enabled_events replaces the list.
      const endpoint = endpoints.find((item) => item.id === path.split('/')[1]);
      const events = Object.entries(fields).filter(([name]) => name.startsWith('enabled_events')).map(([, value]) => value);
      if (endpoint && events.length) endpoint.enabled_events = events;
      if (endpoint && fields.disabled === 'false') endpoint.status = 'enabled';
      return send(200, endpoint ?? {});
    }
    if (path === 'billing_portal/configurations') {
      // Made through the API, a configuration is never the default.
      const portal: Portal = { id: `bpc_${portals.length + 1}`, is_default: false, ...nested(fields) };
      portals.push(portal);
      return send(200, portal);
    }
    if (path.startsWith('billing_portal/configurations/')) {
      const portal = portals.find((item) => item.id === path.split('/')[2]);
      if (portal) {
        const changed = nested(fields) as Partial<Portal>;
        Object.assign(portal, changed, { metadata: { ...portal.metadata, ...changed.metadata } });
      }
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
  // The monthly dollar price is the product's default, and an overage price is metered.
  products = [{ id: 'prod_dev', name: 'Slotlock Developer', tax_code: 'txcd_10103001', metadata: {}, default_price: 'price_usd_m' }];
  prices = [
    { id: 'price_usd_m', product: 'prod_dev', unit_amount: 1000, currency: 'usd', recurring: { interval: 'month', usage_type: 'licensed' }, lookup_key: 'slotlock_developer_monthly', active: true },
    { id: 'price_usd_y', product: 'prod_dev', unit_amount: 10000, currency: 'usd', recurring: { interval: 'year', usage_type: 'licensed' }, lookup_key: 'slotlock_developer_yearly', active: true },
    { id: 'price_overage', product: 'prod_dev', unit_amount: 0, currency: 'usd', recurring: { interval: 'month', usage_type: 'metered' }, lookup_key: null, active: true },
  ];
  endpoints = [];
  portals = [{ id: 'bpc_1', is_default: true }];
  writes.length = 0;
  livemode = false;
  dashboardAnswer = 400;
  checkouts.length = 0;
});

/**
 * A command that records its arguments and stdin. As wrangler, `secret list` prints the Worker's
 * secret names and `secret bulk` adds the keys of the JSON it is given.
 */
function fakeTool(secrets: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'slotlock-stripe-'));
  scratch.push(dir);
  const tool = join(dir, 'tool');
  const store = join(dir, 'secrets.json');
  writeFileSync(store, JSON.stringify(secrets));
  writeFileSync(
    tool,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      'const args = process.argv.slice(2);',
      "let input = '';",
      "process.stdin.on('data', (d) => (input += d)).on('end', () => {",
      `  fs.appendFileSync(${JSON.stringify(join(dir, 'calls.jsonl'))}, JSON.stringify({ args, input }) + '\\n');`,
      `  const names = JSON.parse(fs.readFileSync(${JSON.stringify(store)}, 'utf8'));`,
      "  if (args[1] === 'list') process.stdout.write(JSON.stringify(names.map((name) => ({ name, type: 'secret_text' }))));",
      `  if (args[1] === 'bulk') fs.writeFileSync(${JSON.stringify(store)}, JSON.stringify([...names, ...Object.keys(JSON.parse(input))]));`,
      '});',
    ].join('\n'),
    { mode: 0o755 },
  );
  const calls = () => {
    const file = join(dir, 'calls.jsonl');
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { args: string[]; input: string });
  };
  return { tool, calls };
}

function run(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH ?? '', SLOTLOCK_STRIPE_API: base, STRIPE_SECRET_KEY: KEY, SLOTLOCK_STORE_WAIT_MS: '1500', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return new Promise<{ code: number | null; output: string }>((resolve) => child.on('close', (code) => resolve({ code, output })));
}

describe('configure-stripe.mjs', () => {
  it('sets up both plans in pounds, the webhook and the portal, and archives the dollar prices', async () => {
    const { tool: wrangler, calls } = fakeTool();
    const result = await run(['--dashboard-worker', 'slotlock-dashboard'], { SLOTLOCK_WRANGLER: wrangler });
    expect(result.code, result.output).toBe(0);
    // Developer kept and tagged; Team created with the SaaS tax code.
    // Each product's default price is its monthly one.
    expect(products.map((product) => [product.name, product.tax_code, product.default_price])).toEqual([
      ['Slotlock Developer', 'txcd_10103001', 'price_4'],
      ['Slotlock Team', 'txcd_10103001', 'price_6'],
    ]);
    const active = prices
      .filter((price) => price.active && price.recurring.usage_type === 'licensed')
      .map((price) => [price.lookup_key, price.unit_amount, price.currency, price.recurring.interval]);
    expect(active).toEqual([
      ['slotlock_developer_monthly', 500, 'gbp', 'month'],
      ['slotlock_developer_yearly', 5000, 'gbp', 'year'],
      ['slotlock_team_monthly', 1500, 'gbp', 'month'],
      ['slotlock_team_yearly', 15000, 'gbp', 'year'],
    ]);
    // The dollar prices lost their lookup keys and were archived, not deleted.
    // The metered overage price is left alone.
    expect(prices.filter((price) => price.currency === 'usd').map((price) => [price.id, price.lookup_key, price.active])).toEqual([
      ['price_usd_m', null, false],
      ['price_usd_y', null, false],
      ['price_overage', null, true],
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
          'charge.refunded',
        ],
      },
    ]);
    // The signing secret goes to the dashboard Worker on stdin, and is never printed.
    // The signing secret and the six ids go to the dashboard Worker in one bulk, on stdin; without the
    // dashboard's own key, billing stays off.
    expect(calls().map((call) => call.args)).toEqual([['secret', 'bulk', '--name', 'slotlock-dashboard']]);
    expect(JSON.parse(calls()[0]?.input ?? '{}')).toEqual({
      STRIPE_WEBHOOK_SECRET: SIGNING_SECRET,
      SLOTLOCK_STRIPE_PRICE_MONTHLY: 'price_4',
      SLOTLOCK_STRIPE_PRICE_YEARLY: 'price_5',
      SLOTLOCK_STRIPE_PRICE_TEAM_MONTHLY: 'price_6',
      SLOTLOCK_STRIPE_PRICE_TEAM_YEARLY: 'price_7',
      SLOTLOCK_STRIPE_PORTAL_DEVELOPER: 'bpc_2',
      SLOTLOCK_STRIPE_PORTAL_TEAM: 'bpc_3',
    });
    expect(result.output).toContain('Billing starts once slotlock-dashboard has STRIPE_SECRET_KEY');
    expect(result.output).not.toContain(SIGNING_SECRET);
    expect(result.output).not.toContain(KEY);
    // The default configuration offers no switching; each plan's switches between its own prices
    // only: Developer never to Team, nor Team to Developer.
    expect(portals.map((portal) => [portal.id, portal.is_default, portal.metadata?.slotlock_plan, portal.features?.subscription_update])).toEqual([
      ['bpc_1', true, undefined, { enabled: false, products: '' }],
      [
        'bpc_2',
        false,
        'developer',
        expect.objectContaining({
          enabled: true,
          products: [{ product: 'prod_dev', prices: ['price_4', 'price_5'], adjustable_quantity: { enabled: false } }],
          proration_behavior: 'always_invoice',
        }),
      ],
      [
        'bpc_3',
        false,
        'team',
        expect.objectContaining({
          enabled: true,
          products: [{ product: 'prod_2', prices: ['price_6', 'price_7'], adjustable_quantity: { enabled: false } }],
          proration_behavior: 'always_invoice',
        }),
      ],
    ]);
    for (const portal of portals) {
      expect(portal).toMatchObject({
        default_return_url: 'https://app.slotlock.pylota.io/dashboard',
        // With the survey the owner turned on, in every configuration.
        features: {
          subscription_cancel: { mode: 'at_period_end', cancellation_reason: { enabled: true, options: expect.arrayContaining(['too_expensive', 'other']) } },
          invoice_history: { enabled: true },
        },
      });
    }
    // Yearly to monthly waits for the end of the year paid for.
    expect(portals[1]?.features?.subscription_update).toMatchObject({
      schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }, { type: 'shortening_interval' }] },
    });
    // The variables the dashboard Worker needs.
    for (const line of [
      'SLOTLOCK_STRIPE_PRICE_MONTHLY=price_4',
      'SLOTLOCK_STRIPE_PRICE_YEARLY=price_5',
      'SLOTLOCK_STRIPE_PRICE_TEAM_MONTHLY=price_6',
      'SLOTLOCK_STRIPE_PRICE_TEAM_YEARLY=price_7',
      'SLOTLOCK_STRIPE_PORTAL_DEVELOPER=bpc_2',
      'SLOTLOCK_STRIPE_PORTAL_TEAM=bpc_3',
    ]) {
      expect(result.output).toContain(line);
    }
  });

  it('keeps everything on a second run', async () => {
    await run([]);
    writes.length = 0;
    const again = await run([]);
    expect(again.code, again.output).toBe(0);
    expect(writes).toEqual([]);
    expect(again.output).toContain('kept the price slotlock_team_yearly (price_7): £150 a year');
    expect(again.output).toContain('kept the webhook endpoint https://app.slotlock.pylota.io/stripe/webhook (we_1)');
    expect(again.output).toContain('kept the Slotlock Team customer portal configuration (bpc_3)');
    expect(again.output).toContain('Everything was already set.');
    expect(again.output).toContain('SLOTLOCK_STRIPE_PORTAL_TEAM=bpc_3');
  });

  it('puts a plan\'s portal back to its own prices when they change, and never makes a default', async () => {
    portals = [];
    await run([]);
    // Only the Dashboard makes the default: the script says so rather than adding one each run.
    expect(portals.map((portal) => portal.metadata?.slotlock_plan)).toEqual(['developer', 'team']);
    // Someone offers Team in the Developer portal by hand: the next run takes it out again.
    const developer = portals[0] as Portal;
    developer.features = { ...developer.features, subscription_update: { enabled: true, products: [{ product: 'prod_2', prices: ['price_6'] }] } };
    writes.length = 0;
    const again = await run([]);
    expect(again.output).toContain('note: the account has no default customer portal configuration');
    expect(again.output).toContain(`update the Slotlock Developer customer portal configuration (${developer.id})`);
    expect(writes.map((write) => write.path)).toEqual([`billing_portal/configurations/${developer.id}`]);
    expect(developer.features?.subscription_update?.products).toEqual([
      { product: 'prod_dev', prices: ['price_4', 'price_5'], adjustable_quantity: { enabled: false } },
    ]);
  });

  it('changes nothing on --dry-run, and says where the secret is without a dashboard Worker', async () => {
    const dry = await run(['--dry-run']);
    expect(dry.code, dry.output).toBe(0);
    expect(dry.output).toContain('would create the price slotlock_developer_monthly: £5 a month, moving its lookup key from price_usd_m (10 USD)');
    expect(dry.output).toContain('would archive the price price_usd_m of Slotlock Developer (10 USD a month)');
    expect(dry.output).not.toContain('price_overage');
    expect(dry.output).toContain('would create the product Slotlock Team');
    expect(dry.output).toContain('would create the Slotlock Team customer portal configuration');
    expect(dry.output).toContain('Nothing was changed.');
    expect(writes).toEqual([]);
    const real = await run([]);
    expect(real.output).toContain('Signing secret. Set it as the dashboard Worker\'s STRIPE_WEBHOOK_SECRET');
    expect(real.output).not.toContain(SIGNING_SECRET);
  });

  it('adds charge.refunded to an endpoint made before it, keeping its other events, once', async () => {
    const before = [
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.updated',
      'customer.subscription.deleted',
      'invoice.paid',
      'invoice.payment_failed',
      'customer.updated',
    ];
    endpoints = [{ id: 'we_7', url: 'https://app.slotlock.pylota.io/stripe/webhook', status: 'enabled', enabled_events: [...before] }];
    const first = await run([]);
    expect(first.code).toBe(0);
    expect(first.output).toContain('update the webhook endpoint https://app.slotlock.pylota.io/stripe/webhook (we_7): add charge.refunded');
    expect(endpoints[0]?.enabled_events).toEqual([...before, 'charge.refunded']);
    const second = await run([]);
    expect(second.output).toContain('kept the webhook endpoint https://app.slotlock.pylota.io/stripe/webhook (we_7)');
    expect(writes.filter((write) => write.path === 'webhook_endpoints/we_7')).toHaveLength(1);
  });

  it('adds missing events to a webhook endpoint that exists, and refuses to start without a key', async () => {
    endpoints = [{ id: 'we_9', url: 'https://app.slotlock.pylota.io/stripe/webhook', status: 'enabled', enabled_events: ['checkout.session.completed'] }];
    const result = await run([]);
    expect(result.output).toContain('update the webhook endpoint https://app.slotlock.pylota.io/stripe/webhook (we_9): add customer.subscription.created');
    expect(writes.some((write) => write.path === 'webhook_endpoints/we_9')).toBe(true);
    expect((await run([], { STRIPE_SECRET_KEY: '' })).code).toBe(2);
    expect((await run([], { STRIPE_SECRET_KEY: 'sk_test_wrong' })).code).toBe(1);
  });

  it('stores the dashboard\'s key and the launch check\'s once each does its job, and asks the dashboard whether it sells', async () => {
    livemode = true;
    // A run before made the endpoint; the Worker kept its signing secret.
    endpoints = [{ id: 'we_1', url: `${base}/stripe/webhook`, status: 'enabled', enabled_events: ['*'] }];
    const wrangler = fakeTool(['STRIPE_WEBHOOK_SECRET']);
    const gh = fakeTool();
    const result = await run(['--dashboard', base, '--dashboard-worker', 'slotlock-dashboard'], {
      SLOTLOCK_WRANGLER: wrangler.tool,
      SLOTLOCK_GH: gh.tool,
      SLOTLOCK_WORKER_STRIPE_KEY: WORKER_KEY,
      SLOTLOCK_CHECK_STRIPE_KEY: CHECK_KEY,
    });
    expect(result.code, result.output).toBe(0);
    // The dashboard's key opened a Checkout Session with Managed Payments, and expired it.
    expect(checkouts).toEqual([
      { body: expect.objectContaining({ mode: 'subscription', 'line_items[0][price]': 'price_4', 'managed_payments[enabled]': 'true' }), expired: true },
    ]);
    // Then the key and the ids went to the Worker in one version, after it was seen to have the
    // webhook's secret.
    expect(wrangler.calls().map((call) => call.args)).toEqual([
      ['secret', 'list', '--name', 'slotlock-dashboard', '--format', 'json'],
      ['secret', 'bulk', '--name', 'slotlock-dashboard'],
    ]);
    const bundle = JSON.parse(wrangler.calls()[1]?.input ?? '{}') as Record<string, string>;
    expect(bundle).toMatchObject({ STRIPE_SECRET_KEY: WORKER_KEY, SLOTLOCK_STRIPE_PRICE_MONTHLY: 'price_4', SLOTLOCK_STRIPE_PORTAL_TEAM: 'bpc_3' });
    expect(Object.keys(bundle)).toHaveLength(7);
    expect(result.output).toContain('The dashboard sells now');
    expect(result.output).not.toContain('cannot read Prices');
    // The check's key went to GitHub, on stdin.
    expect(gh.calls()).toEqual([{ args: ['secret', 'set', 'SLOTLOCK_CHECK_STRIPE_KEY', '--repo', 'PILOTAAI/slotlock'], input: CHECK_KEY }]);
    for (const secret of [KEY, WORKER_KEY, CHECK_KEY]) expect(result.output).not.toContain(secret);
  });

  it('stores no key that cannot do its job, nor one the Worker could not use, and notes one that cannot read Prices', async () => {
    livemode = true;
    endpoints = [{ id: 'we_1', url: `${base}/stripe/webhook`, status: 'enabled', enabled_events: ['*'] }];
    const attempt = async (env: Record<string, string>, secrets = ['STRIPE_WEBHOOK_SECRET']) => {
      const wrangler = fakeTool(secrets);
      const gh = fakeTool();
      const result = await run(['--dashboard', base, '--dashboard-worker', 'slotlock-dashboard'], { SLOTLOCK_WRANGLER: wrangler.tool, SLOTLOCK_GH: gh.tool, ...env });
      const stored = wrangler.calls().filter((call) => call.args[1] === 'bulk').length + gh.calls().length;
      return { ...result, stored };
    };
    // The account's own secret key, or a test key against live: refused before anything is sent.
    expect(await attempt({ SLOTLOCK_WORKER_STRIPE_KEY: 'sk_live_everything' })).toMatchObject({ code: 1, stored: 0, output: expect.stringContaining('must be a restricted key') });
    expect(await attempt({ SLOTLOCK_WORKER_STRIPE_KEY: 'rk_test_worker' })).toMatchObject({ code: 1, stored: 0, output: expect.stringContaining('is a test-mode key') });
    // A key that cannot open a Checkout Session (or Managed Payments is off).
    expect(await attempt({ SLOTLOCK_WORKER_STRIPE_KEY: 'rk_live_nocheckout' })).toMatchObject({
      code: 1,
      stored: 0,
      output: expect.stringContaining('cannot open a Checkout Session with Managed Payments'),
    });
    // A Worker without the webhook's secret would refuse billing: nothing is stored.
    expect(await attempt({ SLOTLOCK_WORKER_STRIPE_KEY: WORKER_KEY }, [])).toMatchObject({ code: 1, stored: 0, output: expect.stringContaining('has no STRIPE_WEBHOOK_SECRET') });
    // A dashboard that answers 503 once the key is on: said, and the run fails.
    dashboardAnswer = 503;
    expect(await attempt({ SLOTLOCK_WORKER_STRIPE_KEY: WORKER_KEY })).toMatchObject({ code: 1, output: expect.stringContaining('answers 503') });
    // A key that cannot read Prices is stored, with a note: the page then shows its labels.
    dashboardAnswer = 400;
    const noPrices = await attempt({ SLOTLOCK_WORKER_STRIPE_KEY: 'rk_live_noprices' });
    expect(noPrices).toMatchObject({ code: 0, stored: 1 });
    expect(noPrices.output).toContain("note: the dashboard's key cannot read Prices");
    // A check key that cannot read events stays off GitHub.
    dashboardAnswer = 400;
    expect(await attempt({ SLOTLOCK_CHECK_STRIPE_KEY: 'rk_live_noevents' })).toMatchObject({ code: 1, output: expect.stringContaining('cannot read Events') });
    livemode = false;
    expect(await attempt({ SLOTLOCK_CHECK_STRIPE_KEY: CHECK_KEY })).toMatchObject({ code: 1, output: expect.stringContaining('reads live mode') });
  });
});
