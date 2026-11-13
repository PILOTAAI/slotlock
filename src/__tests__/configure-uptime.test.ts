// scripts/configure-uptime.mjs against a stand-in for UptimeRobot's v3 API and for gh: it creates the
// four monitors once, keeps them on a second run, stores the heartbeat URL without printing it, and
// goes on without the heartbeat where the plan refuses one.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(root, 'scripts', 'configure-uptime.mjs');
const KEY = 'u1234567-test-key';
const HEARTBEAT = 'https://heartbeat.uptimerobot.test/abc123secret';

interface Monitor {
  id: number;
  friendlyName: string;
  heartbeatUrl?: string | null;
}
let monitors: Monitor[] = [];
let created: Record<string, unknown>[] = [];
let refuseHeartbeat = false;
let refuseCustomDomain = false;
let pages: { id: number; friendlyName: string; customDomain: string | null; urlKey: string; monitorIds: number[] }[] = [];
let server: Server;
let base = '';
const scratch: string[] = [];

async function body(request: IncomingMessage) {
  let text = '';
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : undefined;
}

beforeAll(async () => {
  server = createServer(async (request, response) => {
    const send = (status: number, payload: unknown) =>
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
    if (request.headers.authorization !== `Bearer ${KEY}`) return send(401, { message: 'Unauthorized' });
    const url = new URL(request.url ?? '/', 'http://stub');
    if (request.method === 'GET' && url.pathname === '/v3/monitors') return send(200, { data: monitors, nextLink: null });
    if (request.method === 'GET' && url.pathname === '/v3/user/alert-contacts') {
      return send(200, [{ id: 501, friendlyName: 'owner', type: 'Email' }]);
    }
    if (request.method === 'GET' && url.pathname === '/v3/psps') return send(200, { data: pages, nextLink: null });
    if (request.method === 'POST' && url.pathname === '/v3/psps') {
      const spec = (await body(request)) as { friendlyName: string; customDomain?: string; monitorIds: number[] };
      if (spec.customDomain && refuseCustomDomain) return send(403, { message: 'Custom domains need a paid plan' });
      const page = { id: 70 + pages.length, friendlyName: spec.friendlyName, customDomain: spec.customDomain ?? null, urlKey: 'AbC123', monitorIds: spec.monitorIds };
      pages.push(page);
      return send(201, page);
    }
    if (request.method === 'POST' && url.pathname === '/v3/monitors') {
      const spec = (await body(request)) as Record<string, unknown>;
      if (spec.type === 'HEARTBEAT' && refuseHeartbeat) return send(403, { message: 'Heartbeat monitors are not available on your plan' });
      created.push(spec);
      const monitor = {
        id: 900 + created.length,
        friendlyName: spec.friendlyName as string,
        heartbeatUrl: spec.type === 'HEARTBEAT' ? HEARTBEAT : null,
      };
      monitors.push(monitor);
      return send(201, monitor);
    }
    return send(404, { message: 'Not found' });
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
  monitors = [];
  created = [];
  refuseHeartbeat = false;
  refuseCustomDomain = false;
  pages = [];
});

/** A gh that records each call's arguments and stdin. */
function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), 'slotlock-uptime-'));
  scratch.push(dir);
  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    `#!${process.execPath}\nconst fs = require('node:fs');\nlet input = '';\nprocess.stdin.on('data', (d) => (input += d)).on('end', () => {\n  fs.appendFileSync(${JSON.stringify(join(dir, 'calls.log'))}, JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');\n});\n`,
    { mode: 0o755 },
  );
  const calls = () =>
    readFileSync(join(dir, 'calls.log'), { encoding: 'utf8', flag: 'a+' })
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; input: string });
  return { gh, calls };
}

function run(args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH ?? '', SLOTLOCK_UPTIMEROBOT_API: `${base}/v3`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
  return new Promise<{ code: number | null; output: string }>((resolve) => child.on('close', (code) => resolve({ code, output })));
}

describe('configure-uptime.mjs', () => {
  it('creates the four monitors, alerting the account, and stores the heartbeat URL without printing it', async () => {
    const { gh, calls } = fakeGh();
    const result = await run([], { UPTIMEROBOT_API_KEY: KEY, SLOTLOCK_GH: gh });
    expect(result.code, result.output).toBe(0);
    expect(created.map((spec) => spec.friendlyName)).toEqual(['Slotlock API', 'Slotlock dashboard', 'Slotlock site', 'Slotlock status Worker']);
    expect(created[0]).toMatchObject({
      type: 'KEYWORD',
      url: 'https://slotlock-api.pylota.io/healthz',
      httpMethodType: 'GET',
      keywordType: 'ALERT_NOT_EXISTS',
      keywordValue: '"status":"ready"',
      interval: 300,
    });
    expect(created[3]).toMatchObject({ type: 'HEARTBEAT', interval: 300, gracePeriod: 300 });
    for (const spec of created) expect(spec.assignedAlertContacts).toEqual([{ alertContactId: 501, threshold: 0, recurrence: 0 }]);
    // The heartbeat URL goes to gh on stdin only, and the Worker's workflow is started.
    expect(calls()).toEqual([
      { args: ['secret', 'set', 'SLOTLOCK_STATUS_HEARTBEAT_URL', '--env', 'site', '--repo', 'PILOTAAI/slotlock'], input: HEARTBEAT },
      { args: ['workflow', 'run', 'status-worker.yml', '--ref', 'main', '--repo', 'PILOTAAI/slotlock'], input: '' },
    ]);
    expect(result.output).not.toContain(HEARTBEAT);
    expect(result.output).not.toContain(KEY);
    // The public status page shows the three service monitors, at the custom domain.
    expect(pages).toEqual([
      { id: 70, friendlyName: 'Slotlock status', customDomain: 'status.slotlock.pylota.io', urlKey: 'AbC123', monitorIds: [901, 902, 903] },
    ]);
    expect(result.output).toContain('created: Slotlock status (status page 70): https://status.slotlock.pylota.io');
    expect(result.output).toContain('status.slotlock.pylota.io CNAME stats.uptimerobot.com, DNS only');
  });

  it('keeps the monitors that exist on a second run, and stores the heartbeat again', async () => {
    const { gh, calls } = fakeGh();
    await run([], { UPTIMEROBOT_API_KEY: KEY, SLOTLOCK_GH: gh });
    created = [];
    const again = await run([], { UPTIMEROBOT_API_KEY: KEY, SLOTLOCK_GH: gh });
    expect(again.code, again.output).toBe(0);
    expect(created).toEqual([]);
    expect(again.output).toContain('kept:    Slotlock API (monitor 901)');
    expect(again.output).toContain('kept:    Slotlock status: https://status.slotlock.pylota.io');
    expect(pages).toHaveLength(1);
    expect(calls().filter((call) => call.args[0] === 'secret')).toHaveLength(2);
  });

  it('goes on without the heartbeat when the plan refuses it', async () => {
    refuseHeartbeat = true;
    const { gh, calls } = fakeGh();
    const result = await run([], { UPTIMEROBOT_API_KEY: KEY, SLOTLOCK_GH: gh });
    expect(result.code, result.output).toBe(0);
    expect(created).toHaveLength(3);
    expect(result.output).toContain('skipped: Slotlock status Worker: UptimeRobot answered 403');
    expect(calls()).toEqual([]);
  });

  it('publishes the status page at UptimeRobot\'s own address when the plan refuses a custom domain', async () => {
    refuseCustomDomain = true;
    const { gh } = fakeGh();
    const result = await run([], { UPTIMEROBOT_API_KEY: KEY, SLOTLOCK_GH: gh });
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('note:    UptimeRobot answered 403 to the custom domain');
    expect(result.output).toContain('created: Slotlock status (status page 70): https://stats.uptimerobot.com/AbC123');
    expect(result.output).not.toContain('CNAME');
    expect(pages[0]).toMatchObject({ customDomain: null, monitorIds: [901, 902, 903] });
  });

  it('changes nothing on --dry-run, and refuses to start without a key or with a wrong one', async () => {
    const { gh, calls } = fakeGh();
    const dry = await run(['--dry-run'], { UPTIMEROBOT_API_KEY: KEY, SLOTLOCK_GH: gh });
    expect(dry.code, dry.output).toBe(0);
    expect(dry.output).toContain('would create: Slotlock API (KEYWORD https://slotlock-api.pylota.io/healthz), every 5 minutes');
    expect(dry.output).toContain('would create: Slotlock status, a public status page of the API, the dashboard and the site, at https://status.slotlock.pylota.io');
    expect(dry.output).toContain('Nothing was changed.');
    expect(created).toEqual([]);
    expect(pages).toEqual([]);
    expect(calls()).toEqual([]);
    expect((await run([], { SLOTLOCK_GH: gh })).code).toBe(2);
    const wrong = await run([], { UPTIMEROBOT_API_KEY: 'not-the-key', SLOTLOCK_GH: gh });
    expect(wrong.code).toBe(1);
    expect(wrong.output).toContain('UptimeRobot refused the API key');
  });
});
