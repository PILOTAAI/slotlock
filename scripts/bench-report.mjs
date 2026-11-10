// The benchmark's result format and Markdown table, shared by scripts/bench.mjs (writes bench.json
// and bench.md for each release) and site/scripts/sync-content.mjs (reads the latest release's
// bench.json). bench/baseline.json is RFC 0002's run in the same format.

/**
 * Every workload, in table order: its bench/<id>-{range,slots}.sql pair and how it runs. `real`
 * ones also run as bench/<id>-real.sql on Slotlock's own schema (RFC 0004 A7) where it is applied.
 */
export const WORKLOADS = [
  { id: 'nonoverlap-one', label: 'Non-overlapping, 1 resource', durable: true },
  { id: 'nonoverlap-many', label: 'Non-overlapping, 1,000 resources', durable: true, real: true },
  { id: 'saturated-one', label: 'Saturated single resource (mostly refused)', durable: true, real: true },
  { id: 'contended-many', label: 'Contended, 1,000 resources', durable: true, real: true },
  // nonoverlap-one with synchronous_commit off: the design's cost without the WAL flush wait.
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
    // Slotlock's own schema, where the run had it (RFC 0004 A7); older runs have none.
    if (row.real !== undefined && (typeof row.real !== 'number' || !Number.isFinite(row.real) || row.real <= 0)) {
      fail(`${row.workload}.real is not a positive number`);
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
  const real = report.results.some((row) => row.real !== undefined);
  const lines = [
    `${conditions.join(', ')}. Transactions a second:`,
    '',
    real
      ? '| Workload | Durable commits | Range constraint | Slot rows | Slots ÷ range | Slotlock schema |'
      : '| Workload | Durable commits | Range constraint | Slot rows | Slots ÷ range |',
    real ? '| --- | --- | --- | --- | --- | --- |' : '| --- | --- | --- | --- | --- |',
  ];
  for (const row of report.results) {
    const workload = BY_ID.get(row.workload);
    const cells = `| ${workload.label} | ${workload.durable ? 'on' : 'off'} | ${count(row.range)} | ${count(row.slots)} | ${(row.slots / row.range).toFixed(2)}× |`;
    lines.push(real ? `${cells} ${row.real !== undefined ? count(row.real) : '—'} |` : cells);
  }
  if (real) {
    lines.push(
      '',
      'Slotlock schema: the same bookings into Slotlock’s own reservations table, with its exclusion constraint, triggers (occupied time, composite claims, the change feed) and indexes.',
    );
  }
  return `${lines.join('\n')}\n`;
}
