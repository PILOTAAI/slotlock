#!/usr/bin/env node
// The benchmark in RFC 0002: Slotlock's range exclusion constraint against one row per 15-minute
// slot, under the four workloads of bench/*.sql, with pgbench. It creates a schema of its own,
// slotlock_bench, and drops it at the end: point it at a scratch database, never production.
//
//   DATABASE_URL=postgresql://… node scripts/bench.mjs [--clients 8] [--seconds 8] [--json]
//
// Prints a Markdown table of attempts a second (pgbench's tps, each attempt one booking that
// either lands or is refused) and the ratio of slots to ranges.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH = join(dirname(fileURLToPath(import.meta.url)), '..', 'bench');
const WORKLOADS = [
  ['nonoverlap-one', 'Non-overlapping, 1 resource'],
  ['nonoverlap-many', 'Non-overlapping, 1,000 resources'],
  ['saturated-one', 'Saturated single resource (mostly refused)'],
  ['contended-many', 'Contended, 1,000 resources'],
];

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1 || value > 600) {
    throw new RangeError(`--${name} must be a whole number from 1 to 600`);
  }
  return value;
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('bench: set DATABASE_URL to a scratch database');
  process.exit(2);
}
const clients = option('clients', 8);
const seconds = option('seconds', 8);
const psql = (args) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args, url], { encoding: 'utf8' });

function tps(file) {
  // Both designs start empty for every run, so a workload never inherits the last one's rows.
  psql(['-c', 'TRUNCATE slotlock_bench.ranges, slotlock_bench.slots']);
  const output = execFileSync(
    'pgbench',
    ['-n', '-M', 'prepared', '-c', String(clients), '-j', String(Math.min(clients, 4)), '-T', String(seconds), '-f', join(BENCH, file), url],
    { encoding: 'utf8' },
  );
  const match = /tps = ([0-9.]+)/.exec(output);
  if (!match) throw new Error(`bench: pgbench printed no tps for ${file}`);
  return Number(match[1]);
}

psql(['-f', join(BENCH, 'setup.sql')]);
const results = [];
try {
  for (const [name, label] of WORKLOADS) {
    const range = tps(`${name}-range.sql`);
    const slots = tps(`${name}-slots.sql`);
    results.push({ workload: name, label, range, slots, ratio: slots / range });
  }
} finally {
  psql(['-c', 'DROP SCHEMA IF EXISTS slotlock_bench CASCADE']);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ clients, seconds, results }, null, 2));
} else {
  const server = psql(['-At', '-c', 'SHOW server_version']).trim();
  console.log(`PostgreSQL ${server}, ${clients} clients, ${seconds} s a run. Attempts a second:\n`);
  console.log('| Workload | Range constraint | Slot rows | Slots ÷ range |');
  console.log('| --- | --- | --- | --- |');
  for (const row of results) {
    console.log(`| ${row.label} | ${Math.round(row.range).toLocaleString('en')} | ${Math.round(row.slots).toLocaleString('en')} | ${row.ratio.toFixed(2)}× |`);
  }
}
