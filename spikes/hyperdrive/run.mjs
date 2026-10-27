// RFC 0001's spike driver: deploys Slotlock's schema as the owner, then asks the spike Worker
// (worker.ts) checks 1-5 and judges each answer. Prints a Markdown table to paste into the RFC and
// prints every raw answer as JSON with SPIKE_RAW=1. README.md says how to run it.
//
//   SPIKE_URL            the Worker, e.g. https://slotlock-hyperdrive-spike.<you>.workers.dev
//   SPIKE_TOKEN          the Worker's SPIKE_TOKEN secret
//   SPIKE_OWNER_URL      a direct connection as the schema's owner
//   SPIKE_APP_URL        a direct connection as slotlock_app, the role Hyperdrive connects as
//   SPIKE_STREAM_SECONDS how long check 4 keeps its stream open (default 600)
//   SPIKE_DEPLOY=0       skip deploying the schema (to run against a database left as it is)
//   SPIKE_RAW=1          print every raw answer as JSON instead of the table
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createSlotlockStore } from '../../dist/store.js';

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} is required (README.md)`);
  return value;
};
const workerUrl = env('SPIKE_URL').replace(/\/$/, '');
const token = env('SPIKE_TOKEN');
const ownerUrl = env('SPIKE_OWNER_URL');
const appUrl = env('SPIKE_APP_URL');
const streamSeconds = Number(env('SPIKE_STREAM_SECONDS', '600'));

const run = randomUUID().slice(0, 8);
const raw = {};
const rows = [];
const observations = [];

function record(check, pass, evidence) {
  rows.push({ check, pass, evidence });
  // Progress goes to stderr, so stdout holds only the table, or the raw JSON with SPIKE_RAW=1.
  console.error(`${pass ? 'PASS' : 'FAIL'}  ${check}: ${evidence}`);
}

async function call(path, params = {}) {
  const url = new URL(`${workerUrl}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, status: response.status, body: text.slice(0, 500) };
  }
}

const ms = (a, b) => Date.parse(b) - Date.parse(a);

async function deploy() {
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    const store = createSlotlockStore(sql);
    await store.applySchema();
    await store.applyTenantRls();
    await store.grantApplicationRole('slotlock_app');
  } finally {
    await sql.end();
  }
}

/** Advisory locks still held on this run's keys (worker.ts lockKey), however old the database. */
async function advisoryLocksHeld(names) {
  const keys = names.map((name) => `slotlock-spike:${name}`);
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    // A bigint advisory key is stored as its high and low 32 bits in classid and objid.
    const [row] = await sql`
      SELECT count(*)::int AS held FROM pg_locks
       WHERE locktype = 'advisory' AND objsubid = 1
         AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
         AND ((classid::bigint << 32) | objid::bigint) IN (
               SELECT hashtextextended(key, 0) FROM unnest(${keys}::text[]) AS key)`;
    return row.held;
  } finally {
    await sql.end();
  }
}

async function check1() {
  const exclusive = await Promise.all([
    call('/lock', { key: `x-${run}`, hold: 3000 }),
    call('/lock', { key: `x-${run}`, hold: 3000 }),
  ]);
  raw.exclusive = exclusive;
  const [first, second] = [...exclusive].sort((a, b) => Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt));
  record(
    '1a exclusive locks wait for each other',
    exclusive.every((r) => r.ok) && ms(first.releasedAt, second.acquiredAt) >= 0,
    `second acquired ${ms(first.releasedAt, second.acquiredAt)} ms after the first released; backends ${first.backend}, ${second.backend}`,
  );

  const shared = await Promise.all([
    call('/lock', { key: `s-${run}`, mode: 'shared', hold: 3000 }),
    call('/lock', { key: `s-${run}`, mode: 'shared', hold: 3000 }),
  ]);
  raw.shared = shared;
  const [s1, s2] = [...shared].sort((a, b) => Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt));
  record(
    '1b shared locks are held together',
    shared.every((r) => r.ok) && ms(s2.acquiredAt, s1.releasedAt) > 0,
    `held together for ${ms(s2.acquiredAt, s1.releasedAt)} ms`,
  );

  // Shared against exclusive, as withTenant (shared) against suspension and erasure (exclusive):
  // whichever asks second waits for the first transaction to end, in both orders.
  const later = (ms, path, params) =>
    new Promise((resolve) => setTimeout(resolve, ms)).then(() => call(path, params));
  for (const [firstMode, secondMode] of [['shared', 'exclusive'], ['exclusive', 'shared']]) {
    const key = `m-${firstMode}-${run}`;
    const [held, waited] = await Promise.all([
      call('/lock', { key, mode: firstMode, hold: 3000 }),
      later(500, '/lock', { key, mode: secondMode, hold: 0 }),
    ]);
    raw[`mixed-${firstMode}`] = { held, waited };
    record(
      `1e ${secondMode} waits for ${firstMode}`,
      held.ok && waited.ok && ms(waited.askedAt, held.releasedAt) > 0 && ms(held.releasedAt, waited.acquiredAt) >= 0,
      `asked ${ms(held.acquiredAt, waited.askedAt)} ms into the ${firstMode} hold, acquired ${ms(held.releasedAt, waited.acquiredAt)} ms after its release`,
    );
  }

  const rolledBack = await call('/lock', { key: `r-${run}`, hold: 1000, fail: 1 });
  const after = await call('/lock', { key: `r-${run}` });
  raw.rollback = { rolledBack, after };
  record(
    '1c a rolled-back transaction gives its lock up',
    rolledBack.rolledBack === true && after.ok && ms(after.askedAt, after.acquiredAt) < 500,
    `next request waited ${ms(after.askedAt, after.acquiredAt)} ms`,
  );

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const held = await advisoryLocksHeld([`x-${run}`, `s-${run}`, `r-${run}`, `m-shared-${run}`, `m-exclusive-${run}`]);
  record('1d no advisory lock outlives its transaction', held === 0, `${held} advisory locks held`);

  // The control, reported rather than judged: a session lock (maintenance.ts today) taken and
  // never released. Held afterwards means the connection outlived the request, so a pooler keeps
  // session state between clients and the RFC's lease is required.
  const session = await call('/lock', { key: `c-${run}`, session: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const leaked = await advisoryLocksHeld([`c-${run}`]);
  raw.sessionControl = { session, leaked };
  observations.push(
    `Control: a session advisory lock taken and never released is ${leaked > 0 ? `**still held** after its request ended (${leaked})` : 'gone after its request ended'}.`,
  );
}

async function check2() {
  const a = `spike-a-${run}`;
  const b = `spike-b-${run}`;
  const ra = await call('/store', { tenant: a, op: 'resource', ref: 'a-1' });
  const rb = await call('/store', { tenant: b, op: 'resource', ref: 'b-1' });
  const seenA = await call('/context', { tenant: a });
  const seenB = await call('/context', { tenant: b });
  raw.tenants = { ra, rb, seenA, seenB };
  const refs = (seen) => JSON.stringify(seen.unfiltered?.map((row) => row.ref));
  record(
    '2a each tenant sees only its own rows, with no filter but RLS',
    ra.ok && rb.ok &&
      JSON.stringify(seenA.inside) === '["a-1"]' && JSON.stringify(seenB.inside) === '["b-1"]' &&
      refs(seenA) === '["a-1"]' && refs(seenB) === '["b-1"]',
    `unfiltered: ${a} reads ${refs(seenA)}, ${b} reads ${refs(seenB)}; store: ${JSON.stringify(seenA.inside)}, ${JSON.stringify(seenB.inside)}`,
  );

  // Interleave tenant transactions with bare requests: a pooled connection that kept a tenant's
  // setting would show it, or show that tenant's rows, to the bare request that reuses it.
  const bare = [];
  for (let round = 0; round < 10; round++) {
    const answers = await Promise.all([
      call('/context', { tenant: round % 2 ? a : b }),
      call('/context'),
      call('/context'),
    ]);
    bare.push(answers[1], answers[2]);
  }
  raw.bare = bare;
  const leaks = bare.filter((r) => !r.ok || (r.outside.setting ?? '') !== '' || r.outside.visible !== 0);
  record(
    '2b nothing of a tenant leaks to the next request',
    leaks.length === 0,
    `${bare.length} bare requests as ${bare[0]?.outside?.role}; ${leaks.length} saw a tenant setting or rows`,
  );
  return { tenant: a, resourceId: ra.result?.resourceId };
}

async function check3({ tenant, resourceId }) {
  const start = '2030-01-07T09:00:00Z';
  const end = '2030-01-07T10:00:00Z';
  const first = await call('/store', { tenant, op: 'book', resource: resourceId, ref: `e1-${run}`, start, end });
  const second = await call('/store', { tenant, op: 'book', resource: resourceId, ref: `e2-${run}`, start, end });

  const sql = postgres(appUrl, { max: 2, onnotice: () => {} });
  let direct;
  try {
    const store = createSlotlockStore(sql);
    direct = await store.withTenant(tenant, (t) =>
      t.putCalendarEvent({
        tenantRef: tenant,
        externalRef: `e3-${run}`,
        idempotencyKey: `e3-${run}`,
        expectedRevision: 0,
        resourceId,
        start: new Date(start),
        end: new Date(end),
        timezone: 'UTC',
        summary: 'Spike',
      }),
    );
  } finally {
    await sql.end();
  }
  const through = second.result ?? second;
  raw.overlap = { first, second, direct };
  record(
    '3a an overlap is refused as on a direct connection',
    first.ok && first.result?.ok === true && through.ok === false && direct.ok === false && through.code === direct.code,
    `through Hyperdrive ${JSON.stringify({ ok: through.ok, code: through.code })}, direct ${JSON.stringify({ ok: direct.ok, code: direct.code })}`,
  );

  const day = '2030-01-08';
  const racers = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      call('/store', { tenant, op: 'book', resource: resourceId, ref: `race-${i}-${run}`, start: `${day}T09:00:00Z`, end: `${day}T10:00:00Z` }),
    ),
  );
  raw.race = racers;
  const won = racers.filter((r) => r.ok && r.result?.ok === true).length;
  const lost = racers.filter((r) => r.ok && r.result?.ok === false && r.result.code === 'overlap').length;
  record(
    '3b ten requests race for one slot: one wins',
    won === 1 && lost === 9,
    `${won} booked, ${lost} refused as overlap, ${10 - won - lost} other`,
  );
}

async function check4({ tenant, resourceId }) {
  const start = '2030-02-04T00:00:00Z';
  const end = '2030-02-05T00:00:00Z';
  const every = Math.min(15, Math.max(1, Math.floor(streamSeconds / 4)));
  const url = new URL(`${workerUrl}/stream`);
  for (const [k, v] of Object.entries({ tenant, resource: resourceId, seconds: streamSeconds, every, start, end })) {
    url.searchParams.set(k, String(v));
  }
  const events = [];
  const opened = Date.now();
  const booking = new Promise((resolve) => setTimeout(resolve, (streamSeconds * 1000) / 2)).then(() =>
    call('/store', { tenant, op: 'book', resource: resourceId, ref: `live-${run}`, start: '2030-02-04T09:00:00Z', end: '2030-02-04T10:00:00Z' }),
  );
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let cut;
    while ((cut = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      events.push({ event, at: Math.round((Date.now() - opened) / 1000), data: data ? JSON.parse(data) : null });
    }
  }
  const booked = await booking;
  raw.stream = { events, booked };
  const polls = events.filter((e) => e.event === 'poll');
  const busyCounts = polls.map((e) => e.data.busy.busy.length);
  const ended = events.find((e) => e.event === 'end');
  const failed = events.find((e) => e.event === 'error');
  record(
    `4 a ${streamSeconds} s stream keeps its client and sees a write`,
    !failed && ended !== undefined && ended.data.elapsed >= streamSeconds - every && busyCounts[0] === 0 && busyCounts.at(-1) === 1,
    `${polls.length} polls over ${ended?.data.elapsed ?? '?'} s, busy ${busyCounts.join(',')}${failed ? `; error ${JSON.stringify(failed.data)}` : ''}`,
  );
}

async function check5() {
  const answer = await call('/connections', { n: 8, hold: 2000 });
  raw.connections = answer;
  const results = answer.results ?? [];
  const okCount = results.filter((r) => r.ok).length;
  const slowest = Math.max(...results.map((r) => r.ms));
  record(
    '5 eight clients at once in one request',
    okCount === 8,
    `${okCount}/8 answered, slowest after ${slowest} ms (queued past the sixth if well over 2 s)${results.find((r) => !r.ok) ? `; first error ${JSON.stringify(results.find((r) => !r.ok).error)}` : ''}`,
  );
}

if (process.env.SPIKE_DEPLOY !== '0') await deploy();
await check1();
const scope = await check2();
await check3(scope);
await check5();
await check4(scope);

// The raw answers go to stdout, for the run's record (SPIKE_RAW=1 node run.mjs > raw.json); the driver
// writes no file of what the Worker sent.
// exitCode, never exit(): a pipe may still hold output, and exit() would cut the JSON off.
if (process.env.SPIKE_RAW === '1') {
  console.log(JSON.stringify({ run, workerUrl, rows, observations, raw }, null, 2));
} else {
  console.log('\n| Check | Result | Evidence |\n| --- | --- | --- |');
  for (const row of rows) console.log(`| ${row.check} | ${row.pass ? 'pass' : '**fail**'} | ${row.evidence} |`);
  for (const line of observations) console.log(`\n${line}`);
}
process.exitCode = rows.every((row) => row.pass) ? 0 : 1;
