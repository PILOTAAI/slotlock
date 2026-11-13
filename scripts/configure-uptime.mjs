#!/usr/bin/env node
// Sets up hosted Slotlock's external monitors on UptimeRobot (API v3), from the owner's machine. They
// watch from outside both GitHub and Cloudflare, every five minutes, and alert every contact on the
// UptimeRobot account (its sign-up email at least):
//   Slotlock API             a keyword monitor: https://slotlock-api.pylota.io/healthz must say
//                            "status":"ready", which needs the database
//   Slotlock dashboard       https://app.slotlock.pylota.io/dashboard answers 2xx
//   Slotlock site            https://slotlock.pylota.io/ answers 2xx
//   Slotlock status Worker   a heartbeat the status Worker (workers/status) pings every five
//                            minutes; it alerts when the pings stop. Its URL is stored, on stdin, as
//                            the SLOTLOCK_STATUS_HEARTBEAT_URL secret of the `site` environment, and
//                            the Status Worker workflow is started so the Worker gets it.
// It also publishes the public status page, "Slotlock status", from the three service monitors:
// uptime by day for each, incidents as they happen, and announcements people can subscribe to by
// email. It asks for the custom domain status.slotlock.pylota.io (a CNAME to stats.uptimerobot.com
// in Cloudflare, DNS only), and takes UptimeRobot's own address where the plan refuses one.
// A monitor or status page of the same name is kept as it is, so the script is safe to run again.
// UptimeRobot may keep heartbeat monitors and custom domains to paid plans; when it refuses one,
// the script says so and goes on.
//
//   UPTIMEROBOT_API_KEY=<key> node scripts/configure-uptime.mjs [--dry-run]
// The key: UptimeRobot > Integrations & API > API > Main API key. It is read from the environment
// and sent only to UptimeRobot. Needs gh, logged in as an owner of PILOTAAI, to store the heartbeat.
// Tests only: SLOTLOCK_UPTIMEROBOT_API replaces the API's address, SLOTLOCK_GH the gh command.
import { spawnSync } from 'node:child_process';

const API = (process.env.SLOTLOCK_UPTIMEROBOT_API ?? 'https://api.uptimerobot.com/v3').replace(/\/+$/, '');
const GH = process.env.SLOTLOCK_GH ?? 'gh';
const REPOSITORY = 'PILOTAAI/slotlock';
const INTERVAL = 300;
const STATUS_PAGE = 'Slotlock status';
const STATUS_DOMAIN = 'status.slotlock.pylota.io';
const dryRun = process.argv.includes('--dry-run');

const MONITORS = [
  {
    friendlyName: 'Slotlock API',
    type: 'KEYWORD',
    url: 'https://slotlock-api.pylota.io/healthz',
    httpMethodType: 'GET',
    keywordType: 'ALERT_NOT_EXISTS',
    keywordCaseType: 'CaseSensitive',
    keywordValue: '"status":"ready"',
    timeout: 30,
  },
  { friendlyName: 'Slotlock dashboard', type: 'HTTP', url: 'https://app.slotlock.pylota.io/dashboard', httpMethodType: 'GET', timeout: 30 },
  { friendlyName: 'Slotlock site', type: 'HTTP', url: 'https://slotlock.pylota.io/', httpMethodType: 'GET', timeout: 30 },
  { friendlyName: 'Slotlock status Worker', type: 'HEARTBEAT', gracePeriod: INTERVAL },
];

class Failure extends Error {}

const key = process.env.UPTIMEROBOT_API_KEY?.trim();
if (!key) {
  console.error('error: set UPTIMEROBOT_API_KEY to the account\'s main API key (UptimeRobot > Integrations & API > API).');
  process.exit(2);
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}

/** Every item of a listing (monitors, status pages), following the pages. */
async function list(start, what) {
  const found = [];
  let path = start;
  for (let page = 0; path && page < 20; page += 1) {
    const { status, json, text } = await api('GET', path);
    if (status === 401 || status === 403) throw new Failure('UptimeRobot refused the API key: use the main API key, not a read-only or monitor key.');
    if (status !== 200) throw new Failure(`UptimeRobot answered ${status} listing ${what}: ${text.slice(0, 200)}`);
    found.push(...(json?.data ?? []));
    const next = json?.nextLink;
    path = next ? next.replace(/^https?:\/\/[^/]+\/v3/, '') : '';
  }
  return found;
}

/** The public status page, from the service monitors: kept when it exists, else created. */
async function statusPage(before) {
  const pages = await list('/psps?limit=50', 'status pages');
  const kept = pages.find((page) => page.friendlyName === STATUS_PAGE);
  if (kept) {
    console.log(`kept:    ${STATUS_PAGE}: ${pageUrl(kept)}`);
    return;
  }
  if (dryRun) {
    console.log(`would create: ${STATUS_PAGE}, a public status page of the API, the dashboard and the site, at https://${STATUS_DOMAIN}`);
    return;
  }
  // The monitors as they are now, including any this run created.
  const now = await list('/monitors?limit=50', 'monitors');
  const ids = MONITORS.filter((spec) => spec.type !== 'HEARTBEAT')
    .map((spec) => now.find((monitor) => monitor.friendlyName === spec.friendlyName)?.id ?? before.find((m) => m.friendlyName === spec.friendlyName)?.id)
    .filter((id) => typeof id === 'number');
  const page = {
    friendlyName: STATUS_PAGE,
    monitorIds: ids,
    status: 'ENABLED',
    homepageLink: 'https://slotlock.pylota.io',
    subscription: true,
    noIndex: false,
    sort: 'friendlyName',
  };
  let answer = await api('POST', '/psps', { ...page, customDomain: STATUS_DOMAIN });
  let custom = true;
  if (answer.status !== 201 && answer.status !== 200) {
    console.log(`note:    UptimeRobot answered ${answer.status} to the custom domain (${(answer.json?.message ?? answer.text).toString().slice(0, 160)}); publishing at its own address instead.`);
    custom = false;
    answer = await api('POST', '/psps', page);
  }
  if (answer.status !== 201 && answer.status !== 200) {
    throw new Failure(`UptimeRobot answered ${answer.status} creating the status page: ${answer.text.slice(0, 300)}`);
  }
  console.log(`created: ${STATUS_PAGE} (status page ${answer.json?.id}): ${pageUrl(answer.json ?? {})}`);
  if (custom) {
    console.log(`         In Cloudflare, add the DNS record: ${STATUS_DOMAIN} CNAME stats.uptimerobot.com, DNS only (grey cloud).`);
  }
}

function pageUrl(page) {
  return page.customDomain ? `https://${page.customDomain}` : `https://stats.uptimerobot.com/${page.urlKey ?? '?'}`;
}

function gh(args, input) {
  return spawnSync(GH, args, { input: input ?? '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

async function main() {
  const existing = await list('/monitors?limit=50', 'monitors');
  const byName = new Map(existing.map((monitor) => [monitor.friendlyName, monitor]));
  const contacts = await api('GET', '/user/alert-contacts');
  if (contacts.status !== 200) throw new Failure(`UptimeRobot answered ${contacts.status} listing alert contacts: ${contacts.text.slice(0, 200)}`);
  const assignedAlertContacts = (Array.isArray(contacts.json) ? contacts.json : contacts.json?.data ?? [])
    .filter((contact) => typeof contact.id === 'number')
    .map((contact) => ({ alertContactId: contact.id, threshold: 0, recurrence: 0 }));
  if (assignedAlertContacts.length === 0) {
    console.log('warning: the account has no alert contact, so a monitor that fails tells nobody. Add one in UptimeRobot > Integrations, then run this again.');
  }

  let heartbeat;
  for (const spec of MONITORS) {
    const kept = byName.get(spec.friendlyName);
    if (kept) {
      console.log(`kept:    ${spec.friendlyName} (monitor ${kept.id})`);
      if (spec.type === 'HEARTBEAT') heartbeat = kept.heartbeatUrl ?? undefined;
      continue;
    }
    if (dryRun) {
      console.log(`would create: ${spec.friendlyName} (${spec.type}${spec.url ? ` ${spec.url}` : ''}), every ${INTERVAL / 60} minutes`);
      continue;
    }
    const { status, json, text } = await api('POST', '/monitors', { ...spec, interval: INTERVAL, assignedAlertContacts });
    if (status === 201 || status === 200) {
      console.log(`created: ${spec.friendlyName} (monitor ${json?.id})`);
      if (spec.type === 'HEARTBEAT') heartbeat = json?.heartbeatUrl ?? undefined;
    } else if (spec.type === 'HEARTBEAT') {
      console.log(
        `skipped: ${spec.friendlyName}: UptimeRobot answered ${status} (${(json?.message ?? text).toString().slice(0, 160)}). Heartbeat monitors may need a paid plan; the other monitors still watch the service.`,
      );
    } else {
      throw new Failure(`UptimeRobot answered ${status} creating ${spec.friendlyName}: ${text.slice(0, 300)}`);
    }
  }

  await statusPage(existing);
  if (dryRun) {
    console.log('\nNothing was changed.');
    return;
  }
  if (!heartbeat) return;
  // The heartbeat URL lets anyone report the Worker alive: keep it out of the output and arguments.
  const stored = gh(['secret', 'set', 'SLOTLOCK_STATUS_HEARTBEAT_URL', '--env', 'site', '--repo', REPOSITORY], heartbeat);
  if (stored.status !== 0) {
    console.log(
      `\nCould not store the heartbeat URL with gh (${(stored.stderr || stored.error?.message || '').trim().slice(0, 200)}). Copy it from the monitor in UptimeRobot, then:\n  gh secret set SLOTLOCK_STATUS_HEARTBEAT_URL --env site --repo ${REPOSITORY}`,
    );
    return;
  }
  console.log('\nStored the heartbeat URL as the site environment\'s SLOTLOCK_STATUS_HEARTBEAT_URL.');
  const started = gh(['workflow', 'run', 'status-worker.yml', '--ref', 'main', '--repo', REPOSITORY]);
  console.log(
    started.status === 0
      ? 'Started the Status Worker workflow, which gives the Worker the URL.'
      : `Start the Status Worker workflow to give the Worker the URL: gh workflow run status-worker.yml --ref main --repo ${REPOSITORY}`,
  );
}

main().catch((error) => {
  console.error(`error: ${error instanceof Failure ? error.message : error?.stack ?? error}`);
  process.exit(1);
});
