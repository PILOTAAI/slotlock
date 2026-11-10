// OpenTelemetry trace export for `slotlock serve` (RFC 0002 P2-5, RFC 0003 Later): one SERVER span
// per agent and REST call, sent to an OTLP/HTTP collector as JSON (OTEL_EXPORTER_OTLP_ENDPOINT).
// A call that carried a valid `traceparent` joins the caller's trace by its trace id. It is not
// made a child of the caller's span: the server never keeps that id (server-events tests hold it).
//
// What a span says is what /metrics and the logs already say: the protocol, the operation, the
// outcome or HTTP status, and how long it took. Never a tenant, a key, an argument or an address.
// Spans wait in a bounded queue and go in batches; a collector that is down or slow costs dropped
// spans, counted, never a request.
import { randomBytes } from 'node:crypto';
import type { SlotlockAgentServerEvent } from './agent-server.js';

export interface SlotlockOtlpConfig {
  /** Where spans are POSTed: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, or OTEL_EXPORTER_OTLP_ENDPOINT + /v1/traces. */
  tracesUrl: string;
  /** Sent with each export (OTEL_EXPORTER_OTLP_HEADERS), such as a collector's API key. */
  headers: Readonly<Record<string, string>>;
  /** service.name (OTEL_SERVICE_NAME), `slotlock` by default. */
  serviceName: string;
}

export interface SlotlockTraceExporter {
  /** Turn an agent server event into a span, if it is a call. */
  record(event: SlotlockAgentServerEvent): void;
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
export function slotlockCallSpan(event: SlotlockAgentServerEvent, endedAtMs: number): Span | null {
  if (event.type !== 'call' && event.type !== 'rest') return null;
  const protocol = event.type === 'rest' ? 'rest' : event.protocol;
  const failed = event.type === 'rest' ? event.status >= 500 : SERVER_FAILURES.has(event.outcome);
  const traceId = event.traceId !== undefined && HEX_TRACE.test(event.traceId) ? event.traceId : randomBytes(16).toString('hex');
  return {
    traceId,
    spanId: randomBytes(8).toString('hex'),
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
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  const headerList = env.OTEL_EXPORTER_OTLP_HEADERS ?? '';
  const service = env.OTEL_SERVICE_NAME?.trim();
  if (!traces && !base) return undefined;
  // Trailing slashes trimmed by hand: a regular expression for it backtracks on a long run of them.
  let trimmed = base ?? '';
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  const tracesUrl = traces || `${trimmed}/v1/traces`;
  let parsed: URL;
  try {
    parsed = new URL(tracesUrl);
  } catch {
    throw Object.assign(new Error('OTEL_EXPORTER_OTLP_ENDPOINT must be an http or https URL'), { code: 'invalid_otlp_endpoint' });
  }
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password) {
    throw Object.assign(new Error('OTEL_EXPORTER_OTLP_ENDPOINT must be an http or https URL without credentials'), {
      code: 'invalid_otlp_endpoint',
    });
  }
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
  return { tracesUrl: parsed.href, headers, serviceName };
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
    record(event) {
      const span = slotlockCallSpan(event, now());
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
