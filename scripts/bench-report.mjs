// The benchmark's result format and its Markdown table, shared by scripts/bench.mjs (which writes
// bench.json and bench.md, the assets release.yml attaches to each GitHub release) and the site
// (site/scripts/sync-content.mjs, which reads the latest release's bench.json into
// /docs/benchmarks/). bench/baseline.json is RFC 0002's run in the same format.

/** Every workload, in table order: its bench/<id>-{range,slots}.sql pair and how it runs. */
export const WORKLOADS = [
  { id: 'nonoverlap-one', label: 'Non-overlapping, 1 resource', durable: true },
  { id: 'nonoverlap-many', label: 'Non-overlapping, 1,000 resources', durable: true },
  { id: 'saturated-one', label: 'Saturated single resource (mostly refused)', durable: true },
  { id: 'contended-many', label: 'Contended, 1,000 resources', durable: true },
  // The same files as nonoverlap-one, with synchronous_commit off: what the design costs without
  // the wait for the WAL flush.
  { id: 'nonoverlap-one-async', files: 'nonoverlap-one', label: 'Non-overlapping, 1 resource', durable: false },
  // Reads, not writes: one resource's busy times over a day, from 50,000 bookings (bench/freebusy-seed.sql).
  { id: 'freebusy-many', label: 'Free/busy reads, 1,000 resources', durable: true, seed: 'freebusy-seed.sql' },
];

export const FORMAT = 1;

const BY_ID = new Map(WORKLOADS.map((workload) => [workload.id, workload]));

/** Only characters a version, a date or a SHA needs, so a value cannot add Markdown. */
const plain = (value) => String(value).replace(/[^\w .:+()-]/g, '');

function fail(message) {
  throw new TypeError(`bench result: ${message}`);
}

/**
 * Check a parsed bench.json. Returns it unchanged, or throws naming the first problem, so a site
 * build never renders a malformed or foreign file.
 */
export function validateReport(report) {
  if (typeof report !== 'object' || report === null) fail('not an object');
  if (report.format !== FORMAT) fail(`format ${report.format} is not ${FORMAT}`);
  if (typeof report.postgres !== 'string' || !report.postgres) fail('no postgres version');
  for (const key of ['cpus', 'clients', 'seconds']) {
    if (!Number.isSafeInteger(report[key]) || report[key] < 1) fail(`${key} is not a positive integer`);
  }
  for (const key of ['slotlock', 'date', 'commit']) {
    if (report[key] !== undefined && report[key] !== null && typeof report[key] !== 'string') {
      fail(`${key} is not a string`);
    }
  }
  if (!Array.isArray(report.results) || report.results.length === 0) fail('no results');
  for (const row of report.results) {
    if (!BY_ID.has(row?.workload)) fail(`unknown workload ${row?.workload}`);
    for (const key of ['range', 'slots']) {
      if (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] <= 0) {
        fail(`${row.workload}.${key} is not a positive number`);
      }
    }
  }
  return report;
}

const count = (value) => Math.round(value).toLocaleString('en');

/** The run's conditions in one line, then the table, as the docs and the release assets show it. */
export function renderMarkdown(report) {
  validateReport(report);
  const conditions = [
    report.slotlock ? `Slotlock ${plain(report.slotlock)}` : null,
    `PostgreSQL ${plain(report.postgres.split(' ')[0])}`,
    `${report.cpus} ${report.cpus === 1 ? 'CPU' : 'CPUs'}`,
    `${report.clients} ${report.clients === 1 ? 'client' : 'clients'}`,
    `${report.seconds} s a run`,
    report.date ? plain(report.date.slice(0, 10)) : null,
  ].filter(Boolean);
  const lines = [
    `${conditions.join(', ')}. Transactions a second:`,
    '',
    '| Workload | Durable commits | Range constraint | Slot rows | Slots ÷ range |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of report.results) {
    const workload = BY_ID.get(row.workload);
    lines.push(
      `| ${workload.label} | ${workload.durable ? 'on' : 'off'} | ${count(row.range)} | ${count(row.slots)} | ${(row.slots / row.range).toFixed(2)}× |`,
    );
  }
  return `${lines.join('\n')}\n`;
}
