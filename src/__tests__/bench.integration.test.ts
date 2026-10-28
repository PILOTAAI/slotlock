// The benchmark script runs every workload against both designs and cleans up after itself.
// Skipped without DATABASE_URL or pgbench.
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const url = process.env.DATABASE_URL?.trim();
const pgbench = spawnSync('pgbench', ['--version']).status === 0;

describe.skipIf(!url || !pgbench)('the benchmark (real Postgres, pgbench)', () => {
  it('measures every workload on ranges and slot rows, and leaves no schema behind', () => {
    const output = execFileSync('node', ['scripts/bench.mjs', '--seconds', '1', '--clients', '2', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url },
    });
    const report = JSON.parse(output) as {
      postgres: string;
      cpus: number;
      clients: number;
      seconds: number;
      results: { workload: string; range: number; slots: number }[];
    };
    expect(report).toMatchObject({ clients: 2, seconds: 1 });
    expect(report.postgres).toMatch(/^\d+\.\d+/);
    expect(report.cpus).toBeGreaterThan(0);
    const { results } = report;
    expect(results.map(({ workload }) => workload)).toEqual([
      'nonoverlap-one',
      'nonoverlap-many',
      'saturated-one',
      'contended-many',
      'nonoverlap-one-async',
      'freebusy-many',
    ]);
    for (const row of results) {
      expect(row.range).toBeGreaterThan(0);
      expect(row.slots).toBeGreaterThan(0);
    }
    const left = execFileSync(
      'psql',
      ['-X', '-At', '-c', "SELECT count(*) FROM pg_namespace WHERE nspname = 'slotlock_bench'", url as string],
      { encoding: 'utf8' },
    );
    expect(left.trim()).toBe('0');
  }, 60_000);
});
