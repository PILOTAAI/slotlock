#!/usr/bin/env node
// The RFC 0002 benchmark: Slotlock's range exclusion constraint against one row per 15-minute slot,
// under bench/*.sql workloads, with pgbench. It creates and drops its own schema, slotlock_bench:
// point it at a scratch database, never production.
//
//   DATABASE_URL=postgresql://… node scripts/bench.mjs [--clients 8] [--seconds 8] [--json] [--out DIR]
//
// Prints a Markdown table of pgbench tps (each write one booking attempt, each read one resource's
// busy times over a day) and the slots-to-ranges ratio; --json prints JSON instead. --out DIR
// writes DIR/bench.json and DIR/bench.md, which release.yml attaches and the site reads (format:
// scripts/bench-report.mjs).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORMAT, renderMarkdown, WORKLOADS } from './bench-report.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BENCH = join(ROOT, 'bench');

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
const outIndex = process.argv.indexOf('--out');
const out = outIndex < 0 ? null : process.argv[outIndex + 1];
if (outIndex >= 0 && !out) throw new RangeError('--out needs a directory');
const psql = (args) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', ...args, url], { encoding: 'utf8' });

function tps(workload, design) {
  // Both designs start empty for every run, so a workload never inherits the last one's rows.
  psql(['-c', 'TRUNCATE slotlock_bench.ranges, slotlock_bench.slots']);
  if (workload.seed) psql(['-f', join(BENCH, workload.seed)]);
  const file = `${workload.files ?? workload.id}-${design}.sql`;
  const env = { ...process.env };
  // libpq hands PGOPTIONS to every pgbench connection.
  if (!workload.durable) env.PGOPTIONS = `${env.PGOPTIONS ?? ''} -c synchronous_commit=off`.trim();
  const output = execFileSync(
    'pgbench',
    ['-n', '-M', 'prepared', '-c', String(clients), '-j', String(Math.min(clients, 4)), '-T', String(seconds), '-f', join(BENCH, file), url],
    { encoding: 'utf8', env },
  );
  const match = /tps = ([0-9.]+)/.exec(output);
  if (!match) throw new Error(`bench: pgbench printed no tps for ${file}`);
  return Number(match[1]);
}

for (const workload of WORKLOADS) {
  for (const design of ['range', 'slots']) {
    const file = join(BENCH, `${workload.files ?? workload.id}-${design}.sql`);
    if (!existsSync(file)) throw new Error(`bench: ${file} is missing`);
  }
}

psql(['-f', join(BENCH, 'setup.sql')]);
const results = [];
try {
  for (const workload of WORKLOADS) {
    results.push({ workload: workload.id, range: tps(workload, 'range'), slots: tps(workload, 'slots') });
  }
} finally {
  psql(['-c', 'DROP SCHEMA IF EXISTS slotlock_bench CASCADE']);
}

const report = {
  format: FORMAT,
  slotlock: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version,
  ...(process.env.GITHUB_SHA ? { commit: process.env.GITHUB_SHA } : {}),
  date: new Date().toISOString(),
  postgres: psql(['-At', '-c', 'SHOW server_version']).trim(),
  // pgbench's host; the release job runs PostgreSQL on the same runner.
  cpus: availableParallelism(),
  clients,
  seconds,
  results,
};
const json = `${JSON.stringify(report, null, 2)}\n`;
const markdown = renderMarkdown(report);
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'bench.json'), json);
  writeFileSync(join(out, 'bench.md'), markdown);
}
process.stdout.write(process.argv.includes('--json') ? json : markdown);
