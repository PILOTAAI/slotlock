// Metrics in the Prometheus text format (0.0.4), for `slotlock serve`'s `/metrics`: what the server
// reports to its hooks, counted. Labels are operations, protocols and outcome codes, all from closed
// sets the server defines, never a tenant, a key, a client or an argument, so a scrape reveals no
// one and its size stays bounded.
import type { SlotlockAgentServerEvent } from './agent-server.js';
import type { SlotlockMaintenanceResult } from './maintenance.js';
import type { SlotlockRefusalCounts, SlotlockRefusalReason } from './rate-limit.js';
import type { SlotlockWebhookPassResult } from './webhooks.js';

/** Call duration buckets, in seconds. */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
const REFUSAL_REASONS: readonly SlotlockRefusalReason[] = [
  'auth_refused',
  'rate_limited',
  'lookup_overflow',
  'series_writes_busy',
  'maintenance_busy',
  'request_too_large',
];
const MAINTENANCE_COUNTS = [
  'extended',
  'conflicts',
  'refused',
  'pruned',
  'zoneShifts',
  'staleSources',
  'noShows',
  'waitlistOffers',
] as const;
/** A label value: an operation, protocol or outcome code. Anything else is counted as `other`. */
const LABEL = /^[a-z0-9_.]{1,64}$/;

type Labels = Readonly<Record<string, string>>;

export interface SlotlockMetrics {
  /** Count what the agent server reports (its `onEvent`). */
  event(event: SlotlockAgentServerEvent): void;
  /** Count the request limits' refusals (their `onRefusals`). */
  refusals(counts: SlotlockRefusalCounts): void;
  /** Count a maintenance pass (its `onPass`). */
  maintenance(result: SlotlockMaintenanceResult): void;
  /** Count a webhook delivery pass (its `onPass`). */
  webhooks(result: SlotlockWebhookPassResult): void;
  /** Everything counted so far, as a scrape answers it. */
  render(): string;
}

const label = (value: string) => (LABEL.test(value) ? value : 'other');
const key = (labels: Labels) => JSON.stringify(Object.entries(labels));

function formatLabels(labels: Labels): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  // Label values are from LABEL's set or the version strings below: escaped anyway.
  const escaped = entries.map(
    ([name, value]) =>
      `${name}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n')}"`,
  );
  return `{${escaped.join(',')}}`;
}

class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  add(labels: Labels, amount = 1): void {
    const id = key(labels);
    const current = this.values.get(id) ?? { labels, value: 0 };
    current.value += amount;
    this.values.set(id, current);
  }
  render(type = 'counter'): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} ${type}`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${formatLabels(labels)} ${value}`);
    }
    return lines;
  }
}

class Histogram {
  private readonly series = new Map<
    string,
    { labels: Labels; buckets: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}
  observe(labels: Labels, seconds: number): void {
    const id = key(labels);
    const current = this.series.get(id) ?? {
      labels,
      buckets: BUCKETS.map(() => 0),
      sum: 0,
      count: 0,
    };
    BUCKETS.forEach((bound, index) => {
      if (seconds <= bound) current.buckets[index] = (current.buckets[index] ?? 0) + 1;
    });
    current.sum += seconds;
    current.count += 1;
    this.series.set(id, current);
  }
  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, buckets, sum, count } of this.series.values()) {
      BUCKETS.forEach((bound, index) => {
        lines.push(
          `${this.name}_bucket${formatLabels({ ...labels, le: String(bound) })} ${buckets[index]}`,
        );
      });
      lines.push(`${this.name}_bucket${formatLabels({ ...labels, le: '+Inf' })} ${count}`);
      lines.push(`${this.name}_sum${formatLabels(labels)} ${sum}`);
      lines.push(`${this.name}_count${formatLabels(labels)} ${count}`);
    }
    return lines;
  }
}

/** Counters for one server process, reset when it restarts (`slotlock_start_time_seconds`). */
export function createSlotlockMetrics(info: {
  version: string;
  tzdata?: string;
  now?: () => number;
}): SlotlockMetrics {
  const started = (info.now ?? Date.now)() / 1000;
  const calls = new Counter(
    'slotlock_calls_total',
    'Agent and REST calls by protocol, operation and outcome (ok, a refusal code, or an HTTP status).',
  );
  const duration = new Histogram(
    'slotlock_call_duration_seconds',
    'How long agent and REST calls took, by protocol and operation.',
  );
  const confirmations = new Counter(
    'slotlock_confirmations_total',
    'Write confirmations asked of a person, by operation and outcome.',
  );
  const subscriptions = new Counter(
    'slotlock_subscriptions_total',
    'MCP subscriptions opened and closed, by outcome and the reason one closed.',
  );
  let open = 0;
  const refused = new Counter(
    'slotlock_refusals_total',
    'Requests refused before they ran, by reason.',
  );
  const passes = new Counter('slotlock_maintenance_passes_total', 'Maintenance passes, by whether one was capped.');
  const upkeep = new Counter(
    'slotlock_maintenance_items_total',
    'What maintenance did, by kind: series extended, holds pruned, no-shows released, waitlist offers made, and so on.',
  );
  const deliveries = new Counter(
    'slotlock_webhook_deliveries_total',
    'Webhook changes delivered, and deliveries that failed and will be retried.',
  );

  return {
    event(event) {
      if (event.type === 'call' || event.type === 'rest') {
        const protocol = event.type === 'rest' ? 'rest' : event.protocol;
        const operation = label(event.operation);
        const outcome = event.type === 'rest' ? String(event.status) : label(event.outcome);
        calls.add({ protocol, operation, outcome });
        duration.observe({ protocol, operation }, Math.max(0, event.durationMs) / 1000);
      } else if (event.type === 'confirmation') {
        confirmations.add({ operation: label(event.operation), outcome: event.outcome });
      } else if (event.type === 'subscription') {
        subscriptions.add({ outcome: event.outcome, reason: event.reason ?? 'none' });
        open = Math.max(0, open + (event.outcome === 'opened' ? 1 : -1));
      }
    },
    refusals(counts) {
      for (const reason of REFUSAL_REASONS) {
        const amount = counts[reason];
        if (amount > 0) refused.add({ reason }, amount);
      }
    },
    maintenance(result) {
      passes.add({ capped: String(result.capped) });
      for (const kind of MAINTENANCE_COUNTS) {
        if (result[kind] > 0) upkeep.add({ kind }, result[kind]);
      }
    },
    webhooks(result) {
      if (result.delivered > 0) deliveries.add({ result: 'delivered' }, result.delivered);
      if (result.failed > 0) deliveries.add({ result: 'failed' }, result.failed);
    },
    render() {
      const lines = [
        '# HELP slotlock_build_info The Slotlock version and tz database the server runs.',
        '# TYPE slotlock_build_info gauge',
        `slotlock_build_info${formatLabels({ version: info.version, tzdata: info.tzdata ?? 'unknown' })} 1`,
        '# HELP slotlock_start_time_seconds When the server started, in seconds since the epoch.',
        '# TYPE slotlock_start_time_seconds gauge',
        `slotlock_start_time_seconds ${started}`,
        '# HELP slotlock_subscriptions_open MCP subscriptions open now.',
        '# TYPE slotlock_subscriptions_open gauge',
        `slotlock_subscriptions_open ${open}`,
        ...calls.render(),
        ...duration.render(),
        ...confirmations.render(),
        ...subscriptions.render(),
        ...refused.render(),
        ...passes.render(),
        ...upkeep.render(),
        ...deliveries.render(),
      ];
      return `${lines.join('\n')}\n`;
    },
  };
}
