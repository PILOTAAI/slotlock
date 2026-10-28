// The benchmark's result format and the Markdown table the release assets and the docs show.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// A plain ES module, shared with the site.
const { renderMarkdown, validateReport, WORKLOADS } = (await import(
  pathToFileURL(join(root, 'scripts/bench-report.mjs')).href
)) as {
  renderMarkdown(report: unknown): string;
  validateReport<T>(report: T): T;
  WORKLOADS: { id: string; files?: string; seed?: string }[];
};
const report = {
  format: 1,
  slotlock: '0.6.0',
  commit: '3e05c72',
  date: '2026-10-28T18:00:00.000Z',
  postgres: '16.15 (Debian 16.15-1.pgdg120+1)',
  cpus: 4,
  clients: 8,
  seconds: 8,
  results: [
    { workload: 'nonoverlap-one', range: 6694.4, slots: 9718.2 },
    { workload: 'nonoverlap-one-async', range: 12113, slots: 40084 },
    { workload: 'freebusy-many', range: 64392.6, slots: 57430 },
  ],
};

describe('the benchmark report', () => {
  it('renders the conditions, then one row a workload with counts rounded and the ratio', () => {
    expect(renderMarkdown(report)).toBe(
      [
        'Slotlock 0.6.0, PostgreSQL 16.15, 4 CPUs, 8 clients, 8 s a run, 2026-10-28. Transactions a second:',
        '',
        '| Workload | Durable commits | Range constraint | Slot rows | Slots ÷ range |',
        '| --- | --- | --- | --- | --- |',
        '| Non-overlapping, 1 resource | on | 6,694 | 9,718 | 1.45× |',
        '| Non-overlapping, 1 resource | off | 12,113 | 40,084 | 3.31× |',
        '| Free/busy reads, 1,000 resources | on | 64,393 | 57,430 | 0.89× |',
        '',
      ].join('\n'),
    );
  });

  it('leaves out what a run does not record, and keeps values from adding Markdown', () => {
    const { slotlock: _s, date: _d, ...rest } = report;
    const first = renderMarkdown({ ...rest, cpus: 1, clients: 1 }).split('\n')[0];
    expect(first).toBe('PostgreSQL 16.15, 1 CPU, 1 client, 8 s a run. Transactions a second:');
    expect(renderMarkdown({ ...report, slotlock: '1.0.0|<b>[x](y)' }).split('\n')[0]).toMatch(
      /^Slotlock 1\.0\.0bx\(y\), /,
    );
  });

  it('refuses a malformed or foreign result', () => {
    const bad: [string, unknown][] = [
      ['not an object', null],
      ['format 2 is not 1', { ...report, format: 2 }],
      ['cpus is not a positive integer', { ...report, cpus: 0 }],
      ['no results', { ...report, results: [] }],
      ['unknown workload drop-table', { ...report, results: [{ workload: 'drop-table', range: 1, slots: 1 }] }],
      ['nonoverlap-one.slots is not a positive number', { ...report, results: [{ workload: 'nonoverlap-one', range: 1, slots: Number.NaN }] }],
    ];
    for (const [message, value] of bad) expect(() => validateReport(value), message).toThrow(message);
  });

  it("holds RFC 0002's run as the baseline the docs show before a release has results", () => {
    const baseline = validateReport(JSON.parse(readFileSync(join(root, 'bench/baseline.json'), 'utf8')));
    expect(renderMarkdown(baseline)).toContain('| Saturated single resource (mostly refused) | on | 3,237 | 7,511 | 2.32× |');
  });

  it('has both SQL files for every workload, and a seed file where it names one', () => {
    for (const workload of WORKLOADS) {
      for (const design of ['range', 'slots']) {
        expect(() => readFileSync(join(root, 'bench', `${workload.files ?? workload.id}-${design}.sql`))).not.toThrow();
      }
      if (workload.seed) expect(() => readFileSync(join(root, 'bench', workload.seed ?? ''))).not.toThrow();
    }
  });
});
