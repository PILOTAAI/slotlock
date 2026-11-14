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
//      (transfer_lookup_key). Each product's default price becomes its monthly one, and every other
//      licensed price of the product is archived: subscriptions on it carry on, and no one new can
//      buy it. Metered prices (overage) are left alone.
//   3. The webhook endpoint at <dashboard>/stripe/webhook, with every event the dashboard acts on.
//      Its signing secret exists only when Stripe creates the endpoint: with --dashboard-worker
//      <name>, it goes to that Worker as STRIPE_WEBHOOK_SECRET through `wrangler secret put`, on
//      stdin; without, the script says where Stripe shows it. It is never printed.
//   4. The customer portal. One configuration for each plan, found by its `slotlock_plan` metadata:
//      invoices, payment methods, cancelling at the end of the period, and switching between that
//      plan's own monthly and yearly prices, never to the other plan (a Team is a shared
//      workspace's, Developer a person's). Monthly to yearly is charged at once, less the unused
//      part of the month; yearly to monthly waits for the end of the year paid for (TERMS.md: no
//      refunds for part of a period). The account's default configuration, used by any session that
//      names none, offers no switching at all.
// Then it prints the dashboard Worker's variables: the four SLOTLOCK_STRIPE_PRICE_* price ids and
// the two SLOTLOCK_STRIPE_PORTAL_* configuration ids.
//
// With --dashboard-worker <name>, it also stores them on that Worker, in one `wrangler secret bulk`
// (one new version, so billing never runs half set up; secrets, so a deploy keeps them), with:
//   - the webhook endpoint's signing secret, when Stripe has just made the endpoint;
//   - SLOTLOCK_WORKER_STRIPE_KEY as STRIPE_SECRET_KEY: the dashboard's restricted key (rk_…), with
//     Write on Checkout Sessions and Customer portal and Read on Subscriptions and Prices (the
//     Usage page shows Stripe's own amounts; without Prices, its labels). It is checked
//     first: it reads a subscription and the portal, and opens a Checkout Session with Managed
//     Payments and expires it at once (nothing is charged), which also shows Managed Payments is
//     on. It is stored only if the Worker has, or is given, STRIPE_WEBHOOK_SECRET: without one the
//     Worker refuses billing (503). Then the script asks the dashboard whether it now sells.
// SLOTLOCK_CHECK_STRIPE_KEY, a restricted live key with Read on Products, Prices, Webhook Endpoints
// and Events, goes to GitHub as the launch check's secret (`gh secret set`, on stdin), once
// checked. Run in a terminal, the script asks for any key not set, without showing it.
//
//   node scripts/configure-stripe.mjs [--dry-run] [--dashboard https://app.slotlock.pylota.io]
//     [--dashboard-worker slotlock-dashboard] [--github-repo PILOTAAI/slotlock]
// STRIPE_SECRET_KEY, the key it sets Stripe up with, needs Write on Products, Prices, Webhook
// Endpoints and Customer portal and Read on Balance: the account's secret key, or a restricted
// key with those. Every key goes only to Stripe and where it is stored, and is never printed.
// Tests only: SLOTLOCK_STRIPE_API replaces Stripe's address, SLOTLOCK_WRANGLER the wrangler
// command and SLOTLOCK_GH the gh command.
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

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
const githubRepo = option('--github-repo') ?? 'PILOTAAI/slotlock';
const WRANGLER = process.env.SLOTLOCK_WRANGLER ?? 'npx';
const GH = process.env.SLOTLOCK_GH ?? 'gh';

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
/** The reasons the cancellation survey offers (Stripe's own list). */
const CANCEL_REASONS = ['customer_service', 'low_quality', 'missing_features', 'other', 'switched_service', 'too_complex', 'too_expensive', 'unused'];
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

let key = process.env.STRIPE_SECRET_KEY?.trim();

/** Asks for a key in a terminal, without showing what is typed; '' when not in a terminal. */
async function askSecret(question) {
  if (!process.stdin.isTTY) return '';
  const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Echo the question only, never the key.
  prompt._writeToOutput = (text) => {
    if (text.includes(question)) process.stdout.write(question);
  };
  const answer = await new Promise((resolve) => prompt.question(question, resolve));
  prompt.close();
  process.stdout.write('\n');
  return answer.trim();
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
  const { status, json } = await probe(key, method, path, body);
  if (status < 200 || status > 299) {
    throw new Failure(`Stripe answered ${status} to ${method} /v1/${path.split('?')[0]}: ${json?.error?.message ?? ''}`);
  }
  return json;
}

/** A request with the given key; its status and body, whatever Stripe answers. */
async function probe(withKey, method, path, body) {
  const response = await fetch(`${API}/v1/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${withKey}`,
      'stripe-version': VERSION,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(body ? { body: form(body).toString() } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) };
}

const changes = [];
/** Records a change, and makes it unless this is a dry run. */
async function change(what, run) {
  changes.push(what);
  console.log(`${dryRun ? 'would ' : ''}${what}`);
  return dryRun ? undefined : run();
}

async function main() {
  key ||= await askSecret('Stripe key to set the account up with (sk_… or rk_…): ');
  if (!key) {
    console.error('error: set STRIPE_SECRET_KEY to the account\'s secret key, or a restricted key (…_test_… for the sandbox, …_live_… for live).');
    process.exit(2);
  }
  const account = await stripe('GET', 'balance');
  const mode = account.livemode ? 'LIVE' : 'sandbox (test mode)';
  console.log(`Stripe account: ${mode}${dryRun ? ', dry run' : ''}\n`);

  const products = (await stripe('GET', 'products?limit=100&active=true')).data ?? [];
  const ids = {};
  /** Each plan's product id, and its prices' ids by interval, for the portal configurations. */
  const catalog = {};
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
        `create the price ${price.lookup}: £${price.amount / 100} a ${price.interval}${held ? `, moving its lookup key from ${held.id} (${held.unit_amount / 100} ${held.currency.toUpperCase()})` : ''}`,
        () =>
          stripe('POST', 'prices', {
            product: product.id,
            currency: CURRENCY,
            unit_amount: price.amount,
            recurring: { interval: price.interval },
            tax_behavior: 'exclusive',
            lookup_key: price.lookup,
            transfer_lookup_key: true,
            nickname: price.nickname,
            metadata: { slotlock_plan: spec.plan },
          }),
      );
      ids[price.variable] = created?.id ?? `(new ${price.lookup})`;
    }
    if (product) {
      // Stripe archives no product's default price: the monthly one becomes the default first.
      const monthly = ids[spec.prices[0].variable];
      const current = typeof product.default_price === 'string' ? product.default_price : product.default_price?.id;
      if (current !== monthly) {
        await change(`make ${spec.prices[0].lookup} the default price of ${spec.name}`, () =>
          stripe('POST', `products/${product.id}`, { default_price: monthly }),
        );
      }
      const wantedIds = spec.prices.map((price) => ids[price.variable]);
      const others = (await stripe('GET', `prices?product=${encodeURIComponent(product.id)}&active=true&limit=100`)).data ?? [];
      for (const old of others) {
        if (wantedIds.includes(old.id) || !old.recurring || old.recurring.usage_type === 'metered') continue;
        await change(
          `archive the price ${old.id} of ${spec.name} (${old.unit_amount / 100} ${old.currency.toUpperCase()} a ${old.recurring.interval}): subscriptions on it carry on`,
          () => stripe('POST', `prices/${old.id}`, { active: false }),
        );
      }
    }
    catalog[spec.plan] = {
      product: product?.id ?? `(new ${spec.name})`,
      prices: spec.prices.map((price) => ids[price.variable]),
    };
  }

  // The webhook endpoint. Stripe gives its signing secret only when it makes one.
  let webhookSecret = null;
  const url = `${dashboard}/stripe/webhook`;
  const endpoints = (await stripe('GET', 'webhook_endpoints?limit=100')).data ?? [];
  const endpoint = endpoints.find((item) => item.url === url);
  if (!endpoint) {
    const made = await change(`create the webhook endpoint ${url} for ${EVENTS.length} events`, () =>
      stripe('POST', 'webhook_endpoints', { url, enabled_events: EVENTS, description: 'Slotlock Cloud dashboard', api_version: VERSION }),
    );
    if (made?.secret) webhookSecret = made.secret;
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

  const portalIds = await portals(catalog);

  console.log(`\n${dryRun ? 'Nothing was changed.' : `${changes.length ? 'Done.' : 'Everything was already set.'}`} The dashboard Worker's variables (${mode}):`);
  const values = {};
  for (const spec of PLANS) for (const price of spec.prices) values[price.variable] = ids[price.variable];
  for (const spec of PLANS) values[portalVariable(spec.plan)] = portalIds[spec.plan];
  for (const [name, value] of Object.entries(values)) console.log(`  ${name}=${value}`);

  const live = Boolean(account.livemode);
  if (dashboardWorker) await storeOnWorker({ values, webhookSecret, live, checkoutPrice: values.SLOTLOCK_STRIPE_PRICE_MONTHLY });
  else if (webhookSecret) {
    console.log(
      `\nStripe shows the new webhook endpoint's signing secret at Developers > Webhooks > ${url} > Signing secret. Set it as the dashboard Worker's STRIPE_WEBHOOK_SECRET.`,
    );
  }
  await storeCheckKey(live);
}

const portalVariable = (plan) => `SLOTLOCK_STRIPE_PORTAL_${plan.toUpperCase()}`;

/** A portal configuration: everything but switching, which only a plan's own configuration offers. */
function portalConfiguration(headline, subscriptionUpdate) {
  return {
    business_profile: { headline },
    default_return_url: `${dashboard}/dashboard`,
    features: {
      customer_update: { enabled: true, allowed_updates: ['address', 'email', 'tax_id'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: {
        enabled: true,
        mode: 'at_period_end',
        proration_behavior: 'none',
        cancellation_reason: { enabled: true, options: CANCEL_REASONS },
      },
      subscription_update: subscriptionUpdate,
    },
  };
}

/** What a configuration does, in a form that compares equal however Stripe orders it. */
function portalShape(configuration) {
  const features = configuration?.features ?? {};
  const update = features.subscription_update ?? {};
  const cancel = features.subscription_cancel ?? {};
  return JSON.stringify({
    headline: configuration?.business_profile?.headline ?? null,
    returnUrl: configuration?.default_return_url ?? null,
    customer: features.customer_update?.enabled ? [...(features.customer_update.allowed_updates ?? [])].sort() : null,
    invoices: Boolean(features.invoice_history?.enabled),
    paymentMethods: Boolean(features.payment_method_update?.enabled),
    cancel: cancel.enabled ? [cancel.mode, cancel.proration_behavior] : null,
    survey: cancel.cancellation_reason?.enabled ? [...(cancel.cancellation_reason.options ?? [])].sort() : null,
    update: update.enabled
      ? {
          allowed: [...(update.default_allowed_updates ?? [])].sort(),
          proration: update.proration_behavior ?? null,
          products: (update.products ?? []).map((item) => [item.product, [...(item.prices ?? [])].sort(), Boolean(item.adjustable_quantity?.enabled)]),
          atPeriodEnd: (update.schedule_at_period_end?.conditions ?? []).map((condition) => condition.type).sort(),
        }
      : null,
  });
}

/**
 * The customer portal: the account's default configuration, without switching, and one
 * configuration for each plan that switches between that plan's prices only. Returns each plan's
 * configuration id.
 */
async function portals(catalog) {
  // Stripe leaves out each configuration's products unless asked for them.
  const configurations =
    (await stripe('GET', 'billing_portal/configurations?limit=100&active=true&expand[]=data.features.subscription_update.products')).data ?? [];
  const wanted = [
    {
      what: 'the default customer portal configuration',
      current: configurations.find((item) => item.is_default),
      // Only a session that names no configuration gets it: one the dashboard did not open.
      // An empty `products` clears any list it had: Stripe checks one even when switching is off.
      body: portalConfiguration('Slotlock Cloud: your plan and invoices', { enabled: false, products: '' }),
    },
    ...PLANS.map((spec) => ({
      plan: spec.plan,
      what: `the ${spec.name} customer portal configuration`,
      current: configurations.find((item) => item.metadata?.slotlock_plan === spec.plan),
      body: {
        ...portalConfiguration(`${spec.name}: your plan and invoices`, {
          enabled: true,
          default_allowed_updates: ['price'],
          // One of a plan, not two: Stripe offers the quantity unless told not to.
          products: [{ product: catalog[spec.plan].product, prices: catalog[spec.plan].prices, adjustable_quantity: { enabled: false } }],
          // Monthly to yearly is charged at once, less what is left of the month.
          proration_behavior: 'always_invoice',
          // Yearly to monthly waits for the end of the year paid for: nothing is refunded.
          schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }, { type: 'shortening_interval' }] },
        }),
        metadata: { slotlock_plan: spec.plan },
      },
    })),
  ];
  const ids = {};
  for (const { plan, what, current, body } of wanted) {
    if (!current && !plan) {
      // Only the Dashboard makes the default: one created here would not be, and the next run
      // would create another. The dashboard's sessions name a plan's configuration, so this is
      // only for sessions that name none.
      console.log(
        `note: the account has no default customer portal configuration. Save the portal settings once in Stripe (Settings > Billing > Customer portal), with switching plans off, and run this again.`,
      );
      continue;
    }
    if (!current) {
      const made = await change(`create ${what}`, () => stripe('POST', 'billing_portal/configurations', body));
      if (plan) ids[plan] = made?.id ?? `(new ${plan} configuration)`;
      continue;
    }
    if (plan) ids[plan] = current.id;
    if (portalShape(current) === portalShape(body)) {
      console.log(`kept ${what} (${current.id})`);
      continue;
    }
    await change(`update ${what} (${current.id})`, () => stripe('POST', `billing_portal/configurations/${current.id}`, body));
  }
  return ids;
}

/** Runs wrangler (through npx unless SLOTLOCK_WRANGLER names it), with `input` on stdin. */
function wrangler(args, input) {
  return spawnSync(WRANGLER, [...(WRANGLER === 'npx' ? ['wrangler'] : []), ...args], {
    input: input ?? '',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** What a tool said, short and on one line, with no key in it. */
function said(result, ...secrets) {
  let text = `${result.stderr || ''} ${result.stdout || ''}`.replace(/\s+/g, ' ').trim();
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '…');
  return text.slice(0, 300) || `exit ${result.status}`;
}

/** Whether a key is a restricted key of the account's mode, or why not. */
function restrictedKeyProblem(value, name, live) {
  if (!/^rk_(live|test)_[A-Za-z0-9]+$/.test(value)) return `${name} must be a restricted key (rk_live_… or rk_test_…), not the account's secret key`;
  if (value.startsWith('rk_live_') !== live) return `${name} is a ${live ? 'test-mode' : 'live'} key, and this account is ${live ? 'live' : 'a sandbox'}`;
  return null;
}

/**
 * Stores the dashboard's Stripe settings on its Worker in one version: the new webhook secret, the
 * price and portal ids, and the dashboard's own restricted key once it has passed its checks.
 */
async function storeOnWorker({ values, webhookSecret, live, checkoutPrice }) {
  let workerKey = process.env.SLOTLOCK_WORKER_STRIPE_KEY?.trim();
  if (!workerKey && !dryRun) workerKey = await askSecret(`The dashboard's restricted key, for ${dashboardWorker}'s STRIPE_SECRET_KEY (rk_…; Enter to skip): `);
  const bundle = { ...values };
  if (webhookSecret) bundle.STRIPE_WEBHOOK_SECRET = webhookSecret;
  if (workerKey) {
    const problem = restrictedKeyProblem(workerKey, 'SLOTLOCK_WORKER_STRIPE_KEY', live);
    if (problem) throw new Failure(problem);
    if (!dryRun) await checkWorkerKey(workerKey, checkoutPrice);
    if (!webhookSecret) {
      // Without the webhook's secret the Worker refuses billing: the key waits for it.
      const listed = wrangler(['secret', 'list', '--name', dashboardWorker, '--format', 'json']);
      let names = null;
      try {
        names = JSON.parse(listed.stdout).map((item) => item.name);
      } catch {}
      if (listed.status !== 0 || !Array.isArray(names)) throw new Failure(`wrangler could not list ${dashboardWorker}'s secrets: ${said(listed)}`);
      if (!names.includes('STRIPE_WEBHOOK_SECRET')) {
        throw new Failure(
          `${dashboardWorker} has no STRIPE_WEBHOOK_SECRET, and Stripe gives an endpoint's signing secret only when it makes the endpoint. Copy it from Stripe (Developers > Webhooks > ${dashboard}/stripe/webhook > Signing secret) with \`npx wrangler secret put STRIPE_WEBHOOK_SECRET --name ${dashboardWorker}\`, then run this again. Nothing was stored.`,
        );
      }
    }
    bundle.STRIPE_SECRET_KEY = workerKey;
  }
  const names = Object.keys(bundle).sort();
  if (dryRun) {
    console.log(`\nwould store on ${dashboardWorker}, as secrets: ${names.join(', ')}`);
    return;
  }
  const stored = wrangler(['secret', 'bulk', '--name', dashboardWorker], JSON.stringify(bundle));
  if (stored.status !== 0) {
    throw new Failure(`wrangler could not store the secrets on ${dashboardWorker}: ${said(stored, webhookSecret, workerKey)}`);
  }
  console.log(`\nStored on ${dashboardWorker}, as secrets (a deploy keeps them): ${names.join(', ')}`);
  if (!workerKey) {
    console.log(`  Billing starts once ${dashboardWorker} has STRIPE_SECRET_KEY: run this again with SLOTLOCK_WORKER_STRIPE_KEY.`);
    return;
  }
  // The new version takes a few seconds to reach every location: ask until the dashboard sells.
  const started = Date.now();
  let answer = 0;
  while (Date.now() - started < Number(process.env.SLOTLOCK_STORE_WAIT_MS ?? 60_000)) {
    answer = await fetch(`${dashboard}/stripe/webhook`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(15_000) })
      .then((response) => response.status)
      .catch(() => 0);
    // An unsigned delivery is refused (400) only once billing is on.
    if (answer === 400 || answer === 503) break;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  if (answer === 400) console.log(`  The dashboard sells now: ${dashboard}/stripe/webhook takes only Stripe's signed events.`);
  else if (answer === 503) throw new Failure(`${dashboard} answers 503: see ${dashboardWorker}'s logs (npx wrangler tail ${dashboardWorker}) for the setting it refuses.`);
  else console.log(`  ${dashboard}/stripe/webhook still answers ${answer || 'nothing'}: check that ${dashboard} is ${dashboardWorker}, then look again in a minute.`);
}

/** That the dashboard's key does what the dashboard does with it, and that Managed Payments is on. */
async function checkWorkerKey(workerKey, price) {
  const need = async (what, method, path, body) => {
    const { status, json } = await probe(workerKey, method, path, body);
    if (status < 200 || status > 299) {
      throw new Failure(`SLOTLOCK_WORKER_STRIPE_KEY cannot ${what} (Stripe answered ${status}: ${json?.error?.message ?? ''}). Nothing was stored.`);
    }
    return json;
  };
  await need('read subscriptions (Read on Subscriptions)', 'GET', 'subscriptions?limit=1');
  await need('read the customer portal (Write on Customer portal)', 'GET', 'billing_portal/configurations?limit=1');
  const session = await need('open a Checkout Session with Managed Payments (Write on Checkout Sessions, and Managed Payments activated)', 'POST', 'checkout/sessions', {
    mode: 'subscription',
    line_items: [{ price, quantity: 1 }],
    managed_payments: { enabled: true },
    success_url: `${dashboard}/dashboard/plan`,
    cancel_url: `${dashboard}/dashboard/plan`,
    metadata: { slotlock_check: 'configure-stripe' },
  });
  await need('expire the Checkout Session it opened', 'POST', `checkout/sessions/${session.id}/expire`);
  // The Usage page shows Stripe's own amounts when the key may read them; else its configured labels.
  const prices = await probe(workerKey, 'GET', `prices/${encodeURIComponent(price)}`);
  if (prices.status !== 200) {
    console.log(
      "\nnote: the dashboard's key cannot read Prices, so its Usage page shows the labels it is configured with (SLOTLOCK_PLAN_PRICE_*, else £5 and £50), not Stripe's amounts. Give the key Read on Prices.",
    );
  }
  console.log('\nThe dashboard\'s key reads subscriptions and the portal, and opened (then expired) a Checkout Session with Managed Payments.');
}

/** Stores the launch check's read-only key as a GitHub Actions secret, once it reads what the check reads. */
async function storeCheckKey(live) {
  let checkKey = process.env.SLOTLOCK_CHECK_STRIPE_KEY?.trim();
  if (!checkKey && !dryRun && live) checkKey = await askSecret(`The launch check's read-only key, for ${githubRepo}'s SLOTLOCK_CHECK_STRIPE_KEY (rk_live_…; Enter to skip): `);
  if (!checkKey) return;
  if (!live) throw new Failure('SLOTLOCK_CHECK_STRIPE_KEY is for the launch check, which reads live mode: run this with the live account\'s keys.');
  const problem = restrictedKeyProblem(checkKey, 'SLOTLOCK_CHECK_STRIPE_KEY', live);
  if (problem) throw new Failure(problem);
  for (const [what, path] of [
    ['Products', 'products?limit=1'],
    ['Prices', 'prices?limit=1'],
    ['Webhook Endpoints', 'webhook_endpoints?limit=1'],
    ['Events', 'events?limit=1'],
  ]) {
    const { status } = await probe(checkKey, 'GET', path);
    if (status !== 200) throw new Failure(`SLOTLOCK_CHECK_STRIPE_KEY cannot read ${what} (Stripe answered ${status}): give it Read on ${what}. It was not stored.`);
  }
  if (dryRun) {
    console.log(`would store SLOTLOCK_CHECK_STRIPE_KEY as a GitHub Actions secret of ${githubRepo}`);
    return;
  }
  const stored = spawnSync(GH, ['secret', 'set', 'SLOTLOCK_CHECK_STRIPE_KEY', '--repo', githubRepo], {
    input: checkKey,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (stored.status !== 0) throw new Failure(`gh could not store SLOTLOCK_CHECK_STRIPE_KEY on ${githubRepo}: ${said(stored, checkKey)}`);
  console.log(`Stored SLOTLOCK_CHECK_STRIPE_KEY on ${githubRepo}: the launch check now reads Stripe's live prices, webhook and deliveries.`);
}

main().catch((error) => {
  console.error(`error: ${error instanceof Failure ? error.message : error?.stack ?? error}`);
  process.exit(1);
});
