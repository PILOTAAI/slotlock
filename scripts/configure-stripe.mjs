#!/usr/bin/env node
// Sets up Slotlock Cloud's Stripe account for the dashboard's paid plans, in the sandbox or in live
// mode, so live matches what was tested. It is safe to run again: it finds what exists and changes
// only what differs.
//   1. Products: "Slotlock Developer" and "Slotlock Team", with the SaaS (business use) tax code
//      Managed Payments needs, found by their `slotlock_plan` metadata.
//   2. Prices, in pounds, found by lookup key (docs/hosted/README.md, Plans):
//        slotlock_developer_monthly  £5 a month    slotlock_team_monthly  £15 a month
//        slotlock_developer_yearly   £50 a year    slotlock_team_yearly   £150 a year
//      A lookup key held by a price of another amount or currency moves to a new price
//      (transfer_lookup_key), and the old price is archived: subscriptions on it carry on, and no
//      one new can buy it.
//   3. The webhook endpoint at <dashboard>/stripe/webhook, with every event the dashboard acts on.
//      Its signing secret exists only when Stripe creates the endpoint: with --dashboard-worker
//      <name>, it goes to that Worker as STRIPE_WEBHOOK_SECRET through `wrangler secret put`, on
//      stdin; without, the script says where Stripe shows it. It is never printed.
//   4. The customer portal's default configuration: invoices, payment methods and cancelling at the
//      end of the period. Changing plan stays on the dashboard's Plan page.
// Then it prints the four price ids for the dashboard Worker's SLOTLOCK_STRIPE_PRICE_* variables.
//
//   STRIPE_SECRET_KEY=<sk_test_… or sk_live_…> node scripts/configure-stripe.mjs [--dry-run]
//     [--dashboard https://app.slotlock.pylota.io] [--dashboard-worker slotlock-dashboard]
// The key needs write access to Products, Prices, Webhook Endpoints and the customer portal; use
// the account's secret key, or a restricted key with those. It goes only to Stripe.
// Tests only: SLOTLOCK_STRIPE_API replaces Stripe's address, SLOTLOCK_WRANGLER the wrangler command.
import { spawnSync } from 'node:child_process';

const API = (process.env.SLOTLOCK_STRIPE_API ?? 'https://api.stripe.com').replace(/\/+$/, '');
const VERSION = '2026-04-22.dahlia';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dashboard = (option('--dashboard') ?? 'https://app.slotlock.pylota.io').replace(/\/+$/, '');
const dashboardWorker = option('--dashboard-worker');
const WRANGLER = process.env.SLOTLOCK_WRANGLER ?? 'npx';

/** The SaaS, business use tax code: Managed Payments sells only eligible products. */
const TAX_CODE = 'txcd_10103001';
const PLANS = [
  {
    plan: 'developer',
    name: 'Slotlock Developer',
    description: 'Slotlock Cloud for agents in production: 100 resources, 100 API keys, 10 webhook endpoints.',
    prices: [
      { lookup: 'slotlock_developer_monthly', nickname: 'Developer monthly', amount: 500, interval: 'month', variable: 'SLOTLOCK_STRIPE_PRICE_MONTHLY' },
      { lookup: 'slotlock_developer_yearly', nickname: 'Developer yearly', amount: 5000, interval: 'year', variable: 'SLOTLOCK_STRIPE_PRICE_YEARLY' },
    ],
  },
  {
    plan: 'team',
    name: 'Slotlock Team',
    description: 'Slotlock Cloud for a whole team workspace: 500 resources, 100 API keys, 25 webhook endpoints.',
    prices: [
      { lookup: 'slotlock_team_monthly', nickname: 'Team monthly', amount: 1500, interval: 'month', variable: 'SLOTLOCK_STRIPE_PRICE_TEAM_MONTHLY' },
      { lookup: 'slotlock_team_yearly', nickname: 'Team yearly', amount: 15000, interval: 'year', variable: 'SLOTLOCK_STRIPE_PRICE_TEAM_YEARLY' },
    ],
  },
];
const CURRENCY = 'gbp';
/** What the dashboard's webhook acts on (src/billing.ts). */
const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
];

class Failure extends Error {}

const key = process.env.STRIPE_SECRET_KEY?.trim();
if (!key) {
  console.error('error: set STRIPE_SECRET_KEY to the account\'s secret key (sk_test_… for the sandbox, sk_live_… for live).');
  process.exit(2);
}

/** Stripe's form encoding, nested keys included: a[b][0][c]=… */
function form(value, prefix = '', out = new URLSearchParams()) {
  if (Array.isArray(value)) value.forEach((item, index) => form(item, `${prefix}[${index}]`, out));
  else if (value !== null && typeof value === 'object') {
    for (const [name, item] of Object.entries(value)) form(item, prefix ? `${prefix}[${name}]` : name, out);
  } else if (value !== undefined) out.append(prefix, String(value));
  return out;
}

async function stripe(method, path, body) {
  const response = await fetch(`${API}/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      'stripe-version': VERSION,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: form(body).toString() } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Failure(`Stripe answered ${response.status} to ${method} /v1/${path.split('?')[0]}: ${json?.error?.message ?? ''}`);
  }
  return json;
}

const changes = [];
/** Records a change, and makes it unless this is a dry run. */
async function change(what, run) {
  changes.push(what);
  console.log(`${dryRun ? 'would ' : ''}${what}`);
  return dryRun ? undefined : run();
}

async function main() {
  const account = await stripe('GET', 'balance');
  const mode = account.livemode ? 'LIVE' : 'sandbox (test mode)';
  console.log(`Stripe account: ${mode}${dryRun ? ', dry run' : ''}\n`);

  const products = (await stripe('GET', 'products?limit=100&active=true')).data ?? [];
  const ids = {};
  for (const spec of PLANS) {
    let product =
      products.find((item) => item.metadata?.slotlock_plan === spec.plan) ?? products.find((item) => item.name === spec.name);
    if (!product) {
      product = await change(`create the product ${spec.name}`, () =>
        stripe('POST', 'products', {
          name: spec.name,
          description: spec.description,
          tax_code: TAX_CODE,
          metadata: { slotlock_plan: spec.plan },
        }),
      );
    } else {
      const wanted = { tax_code: TAX_CODE, metadata: { slotlock_plan: spec.plan } };
      const taxCode = typeof product.tax_code === 'string' ? product.tax_code : product.tax_code?.id;
      if (taxCode !== TAX_CODE || product.metadata?.slotlock_plan !== spec.plan) {
        await change(`update the product ${spec.name} (${product.id}): tax code and plan metadata`, () =>
          stripe('POST', `products/${product.id}`, wanted),
        );
      } else {
        console.log(`kept the product ${spec.name} (${product.id})`);
      }
    }

    const found = await stripe(
      'GET',
      `prices?limit=10&${spec.prices.map((price) => `lookup_keys[]=${encodeURIComponent(price.lookup)}`).join('&')}`,
    );
    for (const price of spec.prices) {
      const held = (found.data ?? []).find((item) => item.lookup_key === price.lookup);
      const right =
        held &&
        held.active &&
        held.unit_amount === price.amount &&
        held.currency === CURRENCY &&
        held.recurring?.interval === price.interval &&
        held.recurring?.usage_type !== 'metered' &&
        (product === undefined || held.product === product.id);
      if (right) {
        console.log(`kept the price ${price.lookup} (${held.id}): £${price.amount / 100} a ${price.interval}`);
        ids[price.variable] = held.id;
        continue;
      }
      const created = await change(
        `create the price ${price.lookup}: £${price.amount / 100} a ${price.interval}${held ? `, moving its lookup key from ${held.id} (${held.unit_amount / 100} ${held.currency.toUpperCase()}), which is archived` : ''}`,
        async () => {
          const made = await stripe('POST', 'prices', {
            product: product.id,
            currency: CURRENCY,
            unit_amount: price.amount,
            recurring: { interval: price.interval },
            tax_behavior: 'exclusive',
            lookup_key: price.lookup,
            transfer_lookup_key: true,
            nickname: price.nickname,
            metadata: { slotlock_plan: spec.plan },
          });
          if (held?.active) await stripe('POST', `prices/${held.id}`, { active: false });
          return made;
        },
      );
      ids[price.variable] = created?.id ?? `(new ${price.lookup})`;
    }
  }

  // The webhook endpoint.
  const url = `${dashboard}/stripe/webhook`;
  const endpoints = (await stripe('GET', 'webhook_endpoints?limit=100')).data ?? [];
  const endpoint = endpoints.find((item) => item.url === url);
  if (!endpoint) {
    const made = await change(`create the webhook endpoint ${url} for ${EVENTS.length} events`, () =>
      stripe('POST', 'webhook_endpoints', { url, enabled_events: EVENTS, description: 'Slotlock Cloud dashboard', api_version: VERSION }),
    );
    if (made?.secret) storeSecret(made.secret);
  } else {
    const events = endpoint.enabled_events ?? [];
    const missing = events.includes('*') ? [] : EVENTS.filter((event) => !events.includes(event));
    if (endpoint.status !== 'enabled' || missing.length > 0) {
      await change(
        `update the webhook endpoint ${url} (${endpoint.id}): ${[endpoint.status !== 'enabled' ? 'enable it' : '', missing.length ? `add ${missing.join(', ')}` : ''].filter(Boolean).join('; ')}`,
        () => stripe('POST', `webhook_endpoints/${endpoint.id}`, { disabled: false, enabled_events: [...new Set([...events, ...EVENTS])] }),
      );
    } else {
      console.log(`kept the webhook endpoint ${url} (${endpoint.id})`);
    }
  }

  await portal();

  console.log(`\n${dryRun ? 'Nothing was changed.' : `${changes.length ? 'Done.' : 'Everything was already set.'}`} The dashboard Worker's variables (${mode}):`);
  for (const spec of PLANS) for (const price of spec.prices) console.log(`  ${price.variable}=${ids[price.variable]}`);
}

/** The customer portal's default configuration. */
async function portal() {
  const configurations = (await stripe('GET', 'billing_portal/configurations?limit=10')).data ?? [];
  const current = configurations.find((item) => item.is_default) ?? configurations[0];
  const wanted = {
    business_profile: { headline: 'Slotlock Cloud: your plan and invoices' },
    default_return_url: `${dashboard}/dashboard`,
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address', 'tax_id'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end', proration_behavior: 'none' },
      // Plan changes stay on the dashboard's Plan page, which knows whose workspace each plan is
      // for; the portal does not offer them.
      subscription_update: { enabled: false },
    },
  };
  if (!current) {
    await change('create the customer portal configuration', () => stripe('POST', 'billing_portal/configurations', wanted));
    return;
  }
  await change(`update the customer portal configuration (${current.id})`, () =>
    stripe('POST', `billing_portal/configurations/${current.id}`, wanted),
  );
}

function storeSecret(secret) {
  if (!dashboardWorker) {
    console.log(
      `  Its signing secret is shown once, in Stripe: Developers > Webhooks > ${dashboard}/stripe/webhook > Signing secret. Set it as the dashboard Worker's STRIPE_WEBHOOK_SECRET.`,
    );
    return;
  }
  const result = spawnSync(WRANGLER, [...(WRANGLER === 'npx' ? ['wrangler'] : []), 'secret', 'put', 'STRIPE_WEBHOOK_SECRET', '--name', dashboardWorker], {
    input: secret,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  console.log(
    result.status === 0
      ? `  Stored its signing secret as ${dashboardWorker}'s STRIPE_WEBHOOK_SECRET.`
      : `  Could not store the signing secret with wrangler (${(result.stderr || '').trim().slice(0, 200)}): copy it from Stripe, Developers > Webhooks, into ${dashboardWorker}'s STRIPE_WEBHOOK_SECRET.`,
  );
}

main().catch((error) => {
  console.error(`error: ${error instanceof Failure ? error.message : error?.stack ?? error}`);
  process.exit(1);
});
