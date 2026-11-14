// scripts/check-launch.mjs against a stand-in for every service it asks: it passes when all agree
// with the release, and names each thing that does not.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'check-launch.mjs');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
const EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'charge.refunded',
];

interface World {
  cloudVersion: string;
  mavenHas: boolean;
  topics: string[];
  mcpOpen: boolean;
  probeSkipped: boolean;
  incidents: number;
  incidentTitle: string;
  livemode: boolean;
  events: string[];
  /** Events Stripe has not delivered to every endpoint: type, and age in minutes. */
  undelivered: { type: string; minutes: number }[];
  rejectToken: boolean;
}
const healthy = (): World => ({
  cloudVersion: version,
  mavenHas: true,
  topics: ['mcp', 'mcp-server', 'model-context-protocol', 'ai-agents', 'booking-api', 'scheduling-api'],
  mcpOpen: false,
  probeSkipped: false,
  incidents: 0,
  incidentTitle: 'Hosted Slotlock API is down',
  livemode: true,
  events: EVENTS,
  // Still within Stripe's retries, and not a payment event: neither counts.
  undelivered: [
    { type: 'invoice.paid', minutes: 3 },
    { type: 'customer.created', minutes: 600 },
  ],
  rejectToken: false,
});
let world = healthy();
let server: Server;
let base = '';

function answer(request: IncomingMessage): [number, unknown] {
  const url = new URL(request.url ?? '/', 'http://stub');
  const [, service = '', ...rest] = url.pathname.split('/');
  const path = `/${rest.join('/')}`;
  const authorized = Boolean(request.headers.authorization);
  switch (service) {
    case 'site':
    case 'dash':
      return [200, ''];
    case 'api':
      if (path === '/healthz') return [200, { status: 'ready', version: world.cloudVersion }];
      if (path === '/mcp') return [world.mcpOpen ? 200 : 401, {}];
      return [200, {}];
    case 'npm':
      return [200, { 'dist-tags': { latest: version } }];
    case 'pypi':
      return [200, { info: { version } }];
    case 'crates':
      return [200, { crate: { max_version: version } }];
    case 'nuget':
      return [200, { versions: ['0.1.0', version] }];
    case 'goproxy':
      return [path === `/github.com/!p!i!l!o!t!a!a!i/slotlock/clients/go/@v/v${version}.info` ? 200 : 404, {}];
    case 'maven':
      return [world.mavenHas ? 200 : 404, ''];
    case 'mcp':
      return [
        200,
        {
          servers: [
            {
              server: { name: 'io.github.PILOTAAI/slotlock', version },
              _meta: { 'io.modelcontextprotocol.registry/official': { status: 'active' } },
            },
          ],
        },
      ];
    case 'ghcr':
      if (path === '/token') return [200, { token: 'anonymous' }];
      return [path === `/v2/pilotaai/slotlock/manifests/${version}` && authorized ? 200 : 404, ''];
    case 'github':
      if (world.rejectToken && authorized) return [401, { message: 'Bad credentials' }];
      if (path.endsWith('/topics')) return [200, { names: world.topics }];
      if (path.includes('/actions/workflows/status.yml/runs')) {
        return [200, { workflow_runs: [{ id: 9, conclusion: 'success', created_at: new Date().toISOString() }] }];
      }
      if (path.endsWith('/actions/runs/9/jobs')) return [200, { jobs: [{ conclusion: world.probeSkipped ? 'skipped' : 'success' }] }];
      if (path.endsWith('/issues')) {
        return [200, Array.from({ length: world.incidents }, (_, index) => ({ number: 100 + index, title: world.incidentTitle }))];
      }
      return [404, {}];
    case 'stripe':
      if (request.headers.authorization !== 'Bearer rk_live_check') return [401, { error: { message: 'Invalid API Key' } }];
      if (path === '/v1/prices') {
        const price = (id: string, amount: number, interval: string) => ({
          id,
          livemode: world.livemode,
          unit_amount: amount,
          currency: 'gbp',
          recurring: { interval },
        });
        return [
          200,
          {
            data: [price('price_dm', 500, 'month'), price('price_dy', 5000, 'year'), price('price_tm', 1500, 'month'), price('price_ty', 15000, 'year')],
          },
        ];
      }
      if (path === '/v1/webhook_endpoints') {
        return [200, { data: [{ url: `${base}/dash/stripe/webhook`, status: 'enabled', enabled_events: world.events }] }];
      }
      if (path === '/v1/events') {
        const query = new URL(request.url ?? '/', base).searchParams;
        if (query.get('delivery_success') !== 'false') return [400, { error: { message: 'expected delivery_success=false' } }];
        const now = Math.floor(Date.now() / 1000);
        return [200, { data: world.undelivered.map(({ type, minutes }) => ({ type, created: now - minutes * 60 })) }];
      }
      return [404, {}];
    default:
      return [404, {}];
  }
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const [status, body] = answer(request);
    response.writeHead(status, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
afterAll(() => server.close());

function run(env: Record<string, string> = {}) {
  const urls = Object.fromEntries(
    ['site', 'api', 'npm', 'pypi', 'crates', 'nuget', 'goproxy', 'maven', 'mcp', 'ghcr', 'github', 'stripe'].map((name) => [name, `${base}/${name}`]),
  );
  const child = spawn(process.execPath, [script], {
    env: {
      PATH: process.env.PATH ?? '',
      SLOTLOCK_CHECK_URLS: JSON.stringify({ ...urls, dashboard: `${base}/dash` }),
      SLOTLOCK_CHECK_STRIPE_KEY: 'rk_live_check',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return new Promise<{ code: number | null; output: string }>((resolve) => child.on('close', (code) => resolve({ code, output })));
}

describe('check-launch.mjs', () => {
  it('passes when everything is live, at the release, with Stripe ready', async () => {
    world = healthy();
    const result = await run();
    expect(result.output).not.toContain('FAIL');
    expect(result.code, result.output).toBe(0);
    for (const line of [
      `ok   api: /healthz is ready, on ${version}`,
      'ok   api: /mcp refuses a call without a key (401)',
      `ok   Maven Central: has ${version}`,
      `ok   Go: has ${version}`,
      `ok   ghcr.io: has ${version}`,
      'ok   GitHub: the repository has its search topics',
      'ok   status: no open incident',
      'ok   Stripe: Team yearly: price_ty',
      `ok   Stripe: the webhook at ${base}/dash/stripe/webhook gets every event it needs`,
      'ok   Stripe: every payment event of the last three days reached the webhook',
    ]) {
      expect(result.output).toContain(line);
    }
  });

  it('fails on each thing that is wrong, and says what to do', async () => {
    world = {
      ...healthy(),
      mavenHas: false,
      topics: ['mcp'],
      mcpOpen: true,
      probeSkipped: true,
      // An endpoint made before refunds were noted, and short of another event.
      events: EVENTS.filter((event) => event !== 'invoice.paid' && event !== 'charge.refunded'),
      undelivered: [
        { type: 'checkout.session.completed', minutes: 120 },
        { type: 'invoice.paid', minutes: 30 },
      ],
    };
    const result = await run();
    expect(result.code).toBe(1);
    for (const line of [
      `FAIL Maven Central: has no ${version} (404): publish its deployment in the Central Portal, or release the next version`,
      'FAIL GitHub: topics missing: mcp-server, model-context-protocol, ai-agents, booking-api, scheduling-api (run scripts/configure-github.sh)',
      'FAIL api: /mcp answers 200 to a call without a key, not 401',
      'FAIL status: the status probe is off: set SLOTLOCK_STATUS_PROBE to on',
      `FAIL Stripe: the webhook at ${base}/dash/stripe/webhook does not get: invoice.paid, charge.refunded`,
      'FAIL Stripe: 2 payment event(s) of the last three days did not reach the webhook, the oldest a checkout.session.completed 2 hour(s) ago',
    ]) {
      expect(result.output).toContain(line);
    }
  });

  it('refuses a test-mode Stripe key, and only warns about a Cloud behind the release or an incident', async () => {
    world = { ...healthy(), livemode: false, cloudVersion: '0.0.1', incidents: 1 };
    const result = await run();
    expect(result.output).toContain('FAIL Stripe: the key is a test-mode key: the check needs a live one');
    expect(result.output).toContain(`WARN api: Slotlock Cloud runs 0.0.1; the latest release is ${version}`);
    expect(result.output).toContain('WARN status: open incidents: #100 Hosted Slotlock API is down');
    expect(result.code).toBe(1);
  });

  it('writes the run summary as one plain line a check, whatever the network said', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slotlock-launch-check-'));
    try {
      const summary = join(dir, 'summary.md');
      world = { ...healthy(), incidents: 1, incidentTitle: 'Down\n| x | ![beacon](https://evil.test/p.png) <b>' };
      await run({ GITHUB_STEP_SUMMARY: summary });
      const text = readFileSync(summary, 'utf8');
      const line = text.split('\n').find((row) => row.startsWith('| WARN | status |')) ?? '';
      expect(line).toContain('Down \\| x \\| \\!\\[beacon\\]\\(https://evil.test/p.png\\) \\<b\\>');
      expect(text).not.toContain('![beacon]');
      expect(text).not.toContain('<b>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips Stripe without a key, and reads GitHub without a token GitHub refuses', async () => {
    world = { ...healthy(), rejectToken: true };
    const result = await run({ SLOTLOCK_CHECK_STRIPE_KEY: '', GITHUB_TOKEN: 'stale' });
    expect(result.output).toContain('WARN Stripe: skipped: set SLOTLOCK_CHECK_STRIPE_KEY');
    expect(result.output).toContain('ok   GitHub: the repository has its search topics');
    expect(result.code, result.output).toBe(0);
  });
});

describe('launch-check.yml', () => {
  const workflow = readFileSync(join(root, '.github', 'workflows', 'launch-check.yml'), 'utf8');

  it('runs the check on main every three hours, reading only', () => {
    expect(workflow).toMatch(/^ {4}- cron: "23 \*\/3 \* \* \*"$/m);
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow).toMatch(/^ {4}permissions:\n {6}contents: read\n {6}actions: read\n {6}issues: read\n/m);
    expect(workflow).not.toMatch(/: write/);
    expect(workflow).toContain('run: node scripts/check-launch.mjs');
    // The only secret is the read-only Stripe key, and only the check's step sees it.
    expect([...workflow.matchAll(/secrets\.(\w+)/g)].map(([, name]) => name)).toEqual(['SLOTLOCK_CHECK_STRIPE_KEY']);
  });
});
