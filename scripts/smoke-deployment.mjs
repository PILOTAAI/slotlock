#!/usr/bin/env node
// Check a running Slotlock server end to end after a deployment: health and discovery, MCP (2025 and
// 2026 revisions), A2A, the application API's holds and reservations, and its refusals (401, 409,
// 413, 415). It works in the key's own tenant, on one resource it names `slotlock-smoke`, books only
// at least 400 days ahead and cancels what it books; holds expire within two minutes.
//
//   SLOTLOCK_URL=https://slotlock-api.example.com SLOTLOCK_ADMIN_KEY=… node scripts/smoke-deployment.mjs
//
// The key needs read, write and admin (`slotlock key create smoke --scope read,write,admin`, or
// "Full" in the dashboard); revoke it afterwards. It is sent only as a bearer token and never printed.
import { randomUUID } from 'node:crypto';

const base = (process.env.SLOTLOCK_URL ?? '').replace(/\/+$/, '');
const key = process.env.SLOTLOCK_ADMIN_KEY ?? '';
if (!base || !key) {
  console.error('Set SLOTLOCK_URL and SLOTLOCK_ADMIN_KEY (a key with read, write and admin).');
  process.exit(2);
}
const target = new URL(base);
const local = ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
if (target.protocol !== 'https:' && !(target.protocol === 'http:' && local)) {
  console.error(
    'SLOTLOCK_URL must be https (plain http only to this machine): the key would travel in clear.',
  );
  process.exit(2);
}

let failures = 0;
async function check(name, run) {
  try {
    const detail = await run();
    console.log(`✓ ${name}${detail ? `: ${detail}` : ''}`);
  } catch (error) {
    failures += 1;
    console.log(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function call(method, path, { body, auth = true, headers = {}, raw } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Accept: 'application/json, text/event-stream',
      ...(auth ? { Authorization: `Bearer ${key}` } : {}),
      ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(raw !== undefined ? { body: raw, duplex: 'half' } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, headers: response.headers };
}
const code = (result) => result.json?.error?.code;

const resourceRef = 'slotlock-smoke';
let resourceId;
// A day at least 400 days ahead, and an hour of it no earlier run of this check is likely to hold.
const day = new Date(Date.UTC(new Date().getUTCFullYear() + 2, 0, 1));
day.setUTCDate(day.getUTCDate() + Math.floor(Math.random() * 300));
const at = (hours) =>
  new Date(day.getTime() + hours * 3_600_000).toISOString().replace('.000Z', 'Z');
const hour = Math.floor(Math.random() * 20);

await check('health', async () => {
  const health = await call('GET', '/healthz', { auth: false });
  expect(health.status === 200, `HTTP ${health.status}`);
  expect(health.json?.status === 'ready', `status ${health.json?.status}`);
  return `version ${health.json?.version ?? 'unknown'}`;
});

await check('A2A agent card', async () => {
  const card = await call('GET', '/.well-known/agent-card.json', { auth: false });
  expect(card.status === 200, `HTTP ${card.status}`);
  const skills = (card.json?.skills ?? []).map((skill) => skill.id);
  expect(skills.includes('slotlock_list_resources'), `skills: ${skills.join(', ')}`);
  return `${skills.length} skills`;
});

await check('OpenAPI document', async () => {
  const document = await call('GET', '/openapi.json', { auth: false });
  expect(document.status === 200, `HTTP ${document.status}`);
  expect(
    document.json?.servers?.[0]?.url === base,
    `servers[0].url is ${document.json?.servers?.[0]?.url}`,
  );
  const paths = Object.keys(document.json?.paths ?? {});
  expect(paths.includes('/v1/holds'), 'no application API (/v1/holds)');
  return `${paths.length} paths`;
});

await check('a call without a key, or with a wrong one, is 401', async () => {
  const none = await call('GET', '/v1/resources', { auth: false });
  expect(none.status === 401, `no key: HTTP ${none.status}`);
  const wrong = await call('GET', '/v1/resources', {
    auth: false,
    headers: { Authorization: `Bearer slk_${'0'.repeat(46)}` },
  });
  expect(wrong.status === 401, `wrong key: HTTP ${wrong.status}`);
});

await check('MCP 2025-11-25 tools/list and tools/call', async () => {
  const headers = { 'MCP-Protocol-Version': '2025-11-25' };
  const list = await call('POST', '/mcp', {
    headers,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  expect(list.status === 200, `tools/list HTTP ${list.status}`);
  const tools = (list.json?.result?.tools ?? []).map((tool) => tool.name);
  expect(tools.includes('slotlock_find_next_available'), `tools: ${tools.join(', ')}`);
  const listed = await call('POST', '/mcp', {
    headers,
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'slotlock_list_resources', arguments: { limit: 1 } },
    },
  });
  expect(
    listed.status === 200 && listed.json?.result?.isError !== true,
    `tools/call HTTP ${listed.status}`,
  );
  return `${tools.length} tools`;
});

await check('MCP 2026-07-28 server/discover', async () => {
  const discover = await call('POST', '/mcp', {
    headers: { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'server/discover' },
    body: {
      jsonrpc: '2.0',
      id: 'discover',
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'slotlock-smoke', version: '1.0.0' },
        },
      },
    },
  });
  expect(discover.status === 200, `HTTP ${discover.status}`);
  const versions = discover.json?.result?.supportedVersions ?? [];
  expect(versions.includes('2026-07-28'), `versions: ${versions.join(', ')}`);
  return versions.join(', ');
});

await check('A2A SendMessage', async () => {
  const sent = await call('POST', '/a2a', {
    headers: { 'A2A-Version': '1.0' },
    body: {
      jsonrpc: '2.0',
      id: 'smoke',
      method: 'SendMessage',
      params: {
        message: {
          messageId: randomUUID(),
          role: 'ROLE_USER',
          parts: [
            {
              data: { skill: 'slotlock_list_resources', arguments: { limit: 1 } },
              mediaType: 'application/json',
            },
          ],
        },
      },
    },
  });
  expect(sent.status === 200, `HTTP ${sent.status}`);
  expect(
    sent.json?.result?.message?.role === 'ROLE_AGENT',
    `answer: ${JSON.stringify(sent.json?.error ?? null)}`,
  );
});

await check('application API: the smoke resource and its hours', async () => {
  const created = await call('POST', '/v1/resources', {
    body: { external_ref: resourceRef, timezone: 'UTC' },
  });
  expect(created.status === 200, `create: HTTP ${created.status} ${code(created) ?? ''}`);
  resourceId = created.json?.resource?.id;
  expect(typeof resourceId === 'string', 'no resource id');
  const hours = await call('PUT', `/v1/resources/${resourceId}/availability`, {
    body: {
      rules: [
        {
          rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU',
          start_minutes: 0,
          duration_minutes: 1440,
        },
      ],
    },
  });
  expect(hours.status === 200, `hours: HTTP ${hours.status} ${code(hours) ?? ''}`);
});

await check('holds: a second hold on the same time is refused (409 overlap)', async () => {
  expect(resourceId, 'no smoke resource');
  const window = { resource_id: resourceId, start: at(hour), end: at(hour + 1) };
  const hold = await call('POST', '/v1/holds', { body: { ...window, ttl_seconds: 120 } });
  expect(hold.status === 200, `hold: HTTP ${hold.status} ${code(hold) ?? ''}`);
  const second = await call('POST', '/v1/holds', { body: { ...window, ttl_seconds: 60 } });
  expect(
    second.status === 409 && code(second) === 'overlap',
    `second hold: HTTP ${second.status} ${code(second) ?? ''}`,
  );
  const released = await call('DELETE', `/v1/holds/${hold.json?.hold?.id}`);
  expect(released.status === 200, `release: HTTP ${released.status} ${code(released) ?? ''}`);
});

await check('reservations: book, replay, free/busy, cancel', async () => {
  expect(resourceId, 'no smoke resource');
  const ref = encodeURIComponent(`smoke/${randomUUID()}`);
  const booking = { resource_id: resourceId, start: at(hour + 2), end: at(hour + 3), revision: 1 };
  const put = await call('PUT', `/v1/reservations/${ref}`, { body: booking });
  expect(
    put.status === 200 && put.json?.replayed === false,
    `book: HTTP ${put.status} ${code(put) ?? ''}`,
  );
  const again = await call('PUT', `/v1/reservations/${ref}`, { body: booking });
  expect(again.status === 200 && again.json?.replayed === true, `replay: HTTP ${again.status}`);
  const query = new URLSearchParams({
    resource_ids: resourceId,
    start: at(hour + 2),
    end: at(hour + 3),
  });
  const freeBusy = await call('GET', `/v1/free-busy?${query}`);
  const busy = freeBusy.json?.resources?.[0]?.busy ?? [];
  expect(busy.length === 1, `free/busy: HTTP ${freeBusy.status}, ${busy.length} busy intervals`);
  const cancelled = await call('DELETE', `/v1/reservations/${ref}?revision=2`);
  expect(
    cancelled.status === 200 && cancelled.json?.cancelled === true,
    `cancel: HTTP ${cancelled.status}`,
  );
});

await check('a body that is not JSON is 415', async () => {
  const response = await call('POST', '/v1/holds', {
    headers: { 'Content-Type': 'text/plain' },
    raw: 'hello',
  });
  expect(response.status === 415, `HTTP ${response.status}`);
});

await check('a chunked body past the limit is 413 before it is all sent', async () => {
  // 16 MB, far past the default 256 KB limit, sent slowly enough for the answer to come first.
  const total = 16 * 1024 * 1024;
  let sent = 0;
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  const body = new ReadableStream({
    async pull(controller) {
      if (sent >= total) return controller.close();
      await new Promise((resolve) => setTimeout(resolve, 2));
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
  });
  const response = await fetch(`${base}/v1/holds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body,
    duplex: 'half',
    signal: AbortSignal.timeout(60_000),
  });
  const sentAtAnswer = sent;
  await response.body?.cancel();
  expect(response.status === 413, `HTTP ${response.status}`);
  expect(sentAtAnswer < total, 'answered only after the whole body was sent');
  return `answered after ${Math.round(sentAtAnswer / 1024)} KB of ${total / 1024}`;
});

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
