// OpenTelemetry trace export for `slotlock serve` (RFC 0002 P2-5, RFC 0003 Later): one SERVER span
// per agent and REST call, sent to an OTLP/HTTP collector as JSON (OTEL_EXPORTER_OTLP_ENDPOINT).
// A call that carried a valid `traceparent` joins the caller's trace as a child of the caller's
// span, which reaches the exporter through the agent server's onCallTrace alone, never its events
// or logs.
//
// What a span says is what /metrics and the logs already say: the protocol, the operation, the
// outcome or HTTP status, and how long it took. Never a tenant, a key, an argument or an address.
// Spans wait in a bounded queue and go in batches; a collector that is down or slow costs dropped
// spans, counted, never a request.
import { randomBytes } from 'node:crypto';
import type { SlotlockAgentServerEvent } from './agent-server.js';
import type { SlotlockMetrics } from './metrics.js';

export interface SlotlockOtlpConfig {
  /** Where spans are POSTed: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, or OTEL_EXPORTER_OTLP_ENDPOINT + /v1/traces. */
  tracesUrl: string;
  /** Sent with each export (OTEL_EXPORTER_OTLP_HEADERS), such as a collector's API key. */
  headers: Readonly<Record<string, string>>;
  /** service.name (OTEL_SERVICE_NAME), `slotlock` by default. */
  serviceName: string;
  /**
   * Where metrics are POSTed: OTEL_EXPORTER_OTLP_METRICS_ENDPOINT, or OTEL_EXPORTER_OTLP_ENDPOINT +
   * /v1/metrics; none with only a traces endpoint.
   */
  metricsUrl?: string;
}

export interface SlotlockTraceExporter {
  /** Turn an agent server event into a span, if it is a call; a child of `parentSpanId` when given. */
  record(event: SlotlockAgentServerEvent, parentSpanId?: string): void;
  /** Send what is queued now. */
  flush(): Promise<void>;
  /** Stop the timer and send what is left. */
  shutdown(): Promise<void>;
  /** Spans dropped because the queue was full or the collector refused or did not answer. */
  readonly dropped: number;
}

interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 2;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue: string } | { intValue: string } }[];
  status: { code: 1 | 2 };
}

const HEX_TRACE = /^[0-9a-f]{32}$/;
/** Outcomes that are the server's failure, not the caller's: the span is an error. */
const SERVER_FAILURES = new Set(['internal_error', 'unavailable']);

const nanos = (ms: number) => (BigInt(Math.round(ms * 1_000)) * 1_000n).toString();

/** The span a call event makes, or null for any other event. */
export function slotlockCallSpan(
  event: SlotlockAgentServerEvent,
  endedAtMs: number,
  /** The caller's span from its traceparent: the call's span is its child. */
  parentSpanId?: string,
): Span | null {
  if (event.type !== 'call' && event.type !== 'rest') return null;
  const protocol = event.type === 'rest' ? 'rest' : event.protocol;
  const failed = event.type === 'rest' ? event.status >= 500 : SERVER_FAILURES.has(event.outcome);
  const traceId = event.traceId !== undefined && HEX_TRACE.test(event.traceId) ? event.traceId : randomBytes(16).toString('hex');
  const parent = event.traceId !== undefined && parentSpanId !== undefined && /^[0-9a-f]{16}$/.test(parentSpanId) && parentSpanId !== '0'.repeat(16)
    ? parentSpanId
    : undefined;
  return {
    traceId,
    spanId: randomBytes(8).toString('hex'),
    ...(parent ? { parentSpanId: parent } : {}),
    name: `${protocol} ${event.operation}`,
    kind: 2,
    startTimeUnixNano: nanos(endedAtMs - Math.max(0, event.durationMs)),
    endTimeUnixNano: nanos(endedAtMs),
    attributes: [
      { key: 'slotlock.protocol', value: { stringValue: protocol } },
      { key: 'slotlock.operation', value: { stringValue: event.operation } },
      event.type === 'rest'
        ? { key: 'http.response.status_code', value: { intValue: String(event.status) } }
        : { key: 'slotlock.outcome', value: { stringValue: event.outcome } },
    ],
    status: { code: failed ? 2 : 1 },
  };
}

/** Read the standard OTEL_* variables; undefined when no endpoint is set. */
export function readSlotlockOtlpConfig(env: Readonly<Record<string, string | undefined>>): SlotlockOtlpConfig | undefined {
  // Each read whether or not export is on, so `slotlock --help` lists exactly what is read.
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  const metrics = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim();
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const headerList = env.OTEL_EXPORTER_OTLP_HEADERS ?? '';
  const service = env.OTEL_SERVICE_NAME?.trim();
  if (!traces && !base && !metrics) return undefined;
  // Trailing slashes trimmed by hand: a regular expression for it backtracks on a long run of them.
  let trimmed = base ?? '';
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  const checked = (url: string) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw Object.assign(new Error('OTEL_EXPORTER_OTLP_ENDPOINT must be an http or https URL'), { code: 'invalid_otlp_endpoint' });
    }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
      throw Object.assign(new Error('OTEL_EXPORTER_OTLP_ENDPOINT must be an http or https URL without credentials'), {
        code: 'invalid_otlp_endpoint',
      });
    }
    return parsed.href;
  };
  const tracesUrl = traces ? checked(traces) : base ? checked(`${trimmed}/v1/traces`) : '';
  const metricsUrl = metrics ? checked(metrics) : base ? checked(`${trimmed}/v1/metrics`) : undefined;
  const headers: Record<string, string> = {};
  for (const part of headerList.split(',')) {
    if (part.trim() === '') continue;
    const at = part.indexOf('=');
    const name = at > 0 ? part.slice(0, at).trim() : '';
    let value = '';
    try {
      value = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      value = '';
    }
    if (!/^[A-Za-z0-9-]{1,100}$/.test(name) || value === '' || /[\r\n]/.test(value)) {
      throw Object.assign(new Error('OTEL_EXPORTER_OTLP_HEADERS must be comma-separated name=value pairs'), {
        code: 'invalid_otlp_headers',
      });
    }
    headers[name.toLowerCase()] = value;
  }
  const serviceName = service || 'slotlock';
  if (!/^[\x21-\x7e]{1,100}$/.test(serviceName)) {
    throw Object.assign(new Error('OTEL_SERVICE_NAME must be 1-100 printable characters'), { code: 'invalid_otlp_service' });
  }
  return { tracesUrl, headers, serviceName, ...(metricsUrl ? { metricsUrl } : {}) };
}

/** Batch spans to an OTLP/HTTP collector as JSON. */
export function createSlotlockOtlpExporter(
  config: SlotlockOtlpConfig,
  /**
   * The service's version is not sent: the deployed one is on /healthz and /metrics, and an export
   * carries nothing read from a file.
   */
  options: {
    fetch?: typeof fetch;
    now?: () => number;
    intervalMs?: number;
    maxBatch?: number;
    maxQueue?: number;
    timeoutMs?: number;
    /** Told when an export fails: its HTTP status, or that the collector did not answer. Never a header. */
    onError?: (reason: string) => void;
  },
): SlotlockTraceExporter {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const maxBatch = options.maxBatch ?? 256;
  const maxQueue = options.maxQueue ?? 4_096;
  const queue: Span[] = [];
  let dropped = 0;
  let sending: Promise<void> = Promise.resolve();
  const resource = {
    attributes: [
      { key: 'service.name', value: { stringValue: config.serviceName } },
      { key: 'telemetry.sdk.name', value: { stringValue: 'slotlock' } },
    ],
  };

  async function exportBatch(spans: Span[]): Promise<void> {
    try {
      const response = await send(config.tracesUrl, {
        method: 'POST',
        headers: { ...config.headers, 'content-type': 'application/json' },
        body: JSON.stringify({
          resourceSpans: [{ resource, scopeSpans: [{ scope: { name: 'slotlock' }, spans }] }],
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      });
      if (!response.ok) {
        dropped += spans.length;
        options.onError?.(`collector answered HTTP ${response.status}`);
      }
      await response.body?.cancel().catch(() => undefined);
    } catch {
      dropped += spans.length;
      options.onError?.('collector did not answer');
    }
  }

  function flush(): Promise<void> {
    // One export at a time, in order.
    sending = sending.then(async () => {
      while (queue.length > 0) await exportBatch(queue.splice(0, maxBatch));
    });
    return sending;
  }

  const timer = setInterval(() => void flush(), options.intervalMs ?? 5_000);
  timer.unref?.();

  return {
    record(event, parentSpanId) {
      const span = slotlockCallSpan(event, now(), parentSpanId);
      if (!span) return;
      if (queue.length >= maxQueue) {
        dropped += 1;
        return;
      }
      queue.push(span);
      if (queue.length >= maxBatch) void flush();
    },
    flush,
    async shutdown() {
      clearInterval(timer);
      await flush();
    },
    get dropped() {
      return dropped;
    },
  };
}

/** The snapshot of a server's metrics as an OTLP/HTTP JSON body: cumulative sums, histograms, gauges. */
export function slotlockOtlpMetricsBody(metrics: ReturnType<SlotlockMetrics['collect']>, serviceName: string, nowMs: number): string {
  const start = nanos(metrics.startedAtMs);
  const time = nanos(nowMs);
  const attributes = (labels: Readonly<Record<string, string>>) =>
    Object.entries(labels).map(([key, value]) => ({ key, value: { stringValue: value } }));
  return JSON.stringify({
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: serviceName } }] },
        scopeMetrics: [
          {
            scope: { name: 'slotlock' },
            metrics: [
              ...metrics.counters.map((counter) => ({
                name: counter.name,
                description: counter.help,
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: counter.points.map((point) => ({
                    attributes: attributes(point.labels),
                    startTimeUnixNano: start,
                    timeUnixNano: time,
                    asDouble: point.value,
                  })),
                },
              })),
              ...metrics.histograms.map((histogram) => ({
                name: histogram.name,
                description: histogram.help,
                unit: 's',
                histogram: {
                  aggregationTemporality: 2,
                  dataPoints: histogram.points.map((point) => ({
                    attributes: attributes(point.labels),
                    startTimeUnixNano: start,
                    timeUnixNano: time,
                    count: String(point.count),
                    sum: point.sum,
                    explicitBounds: [...histogram.bounds],
                    // OTLP counts each bucket on its own; the scrape's are cumulative.
                    bucketCounts: [...point.cumulative.map((count, index) => count - (index === 0 ? 0 : (point.cumulative[index - 1] ?? 0))), point.count - (point.cumulative.at(-1) ?? 0)].map(String),
                  })),
                },
              })),
              ...metrics.gauges.map((gauge) => ({
                name: gauge.name,
                description: gauge.help,
                gauge: {
                  dataPoints: gauge.points.map((point) => ({ attributes: attributes(point.labels), timeUnixNano: time, asDouble: point.value })),
                },
              })),
            ],
          },
        ],
      },
    ],
  });
}

/**
 * Send a server's metrics to an OTLP/HTTP collector every `intervalMs` (60 seconds), cumulative
 * since the server started, as the scrape at /metrics counts them; a collector that is down costs
 * that export, never a request.
 */
export function createSlotlockOtlpMetricsExporter(
  config: SlotlockOtlpConfig & { metricsUrl: string },
  metrics: SlotlockMetrics,
  options: { fetch?: typeof fetch; now?: () => number; intervalMs?: number; onError?: (reason: string) => void } = {},
): { flush(): Promise<void>; shutdown(): Promise<void> } {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  let sending: Promise<void> = Promise.resolve();
  const flush = () => {
    sending = sending.then(async () => {
      try {
        const response = await send(config.metricsUrl, {
          method: 'POST',
          headers: { ...config.headers, 'content-type': 'application/json' },
          body: slotlockOtlpMetricsBody(metrics.collect(), config.serviceName, now()),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) options.onError?.(`collector answered HTTP ${response.status}`);
        await response.body?.cancel().catch(() => undefined);
      } catch {
        options.onError?.('collector did not answer');
      }
    });
    return sending;
  };
  const timer = setInterval(() => void flush(), options.intervalMs ?? 60_000);
  timer.unref?.();
  return {
    flush,
    async shutdown() {
      clearInterval(timer);
      await flush();
    },
  };
}
