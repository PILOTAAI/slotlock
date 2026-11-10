// OpenTelemetry trace export: a span per call, sent to an OTLP/HTTP collector as JSON in batches,
// joining the caller's trace by its id, and saying nothing /metrics does not.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createSlotlockMetrics } from '../metrics.js';
import { createSlotlockOtlpExporter, readSlotlockOtlpConfig, slotlockCallSpan } from '../otel.js';

const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const END = Date.UTC(2026, 10, 10, 12);

describe('call spans', () => {
  it('makes a SERVER span of a REST call, in the caller trace, an error only for a 5xx', () => {
    const span = slotlockCallSpan({ type: 'rest', operation: 'slotlock_list_resources', status: 200, durationMs: 12.5, traceId: TRACE }, END);
    expect(span).toMatchObject({
      traceId: TRACE,
      spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
      name: 'rest slotlock_list_resources',
      kind: 2,
      startTimeUnixNano: String((END - 12.5) * 1e6),
      endTimeUnixNano: String(END * 1e6),
      status: { code: 1 },
    });
    expect(span?.attributes).toContainEqual({ key: 'http.response.status_code', value: { intValue: '200' } });
    expect(slotlockCallSpan({ type: 'rest', operation: 'slotlock_list_resources', status: 503, durationMs: 1 }, END)?.status).toEqual({ code: 2 });
    expect(slotlockCallSpan({ type: 'rest', operation: 'slotlock_list_resources', status: 409, durationMs: 1 }, END)?.status).toEqual({ code: 1 });
  });

  it('makes one of an MCP or A2A call, a new trace without one, and nothing of any other event', () => {
    const span = slotlockCallSpan({ type: 'call', protocol: 'mcp', operation: 'slotlock_hold_slots', outcome: 'internal_error', durationMs: 3 }, END);
    expect(span?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span?.traceId).not.toBe(TRACE);
    expect(span?.status).toEqual({ code: 2 });
    expect(span?.attributes).toContainEqual({ key: 'slotlock.outcome', value: { stringValue: 'internal_error' } });
    expect(slotlockCallSpan({ type: 'call', protocol: 'a2a', operation: 'slotlock_hold_slots', outcome: 'overlap', durationMs: 3 }, END)?.status).toEqual({ code: 1 });
    expect(slotlockCallSpan({ type: 'confirmation', operation: 'slotlock_hold_slots', outcome: 'accepted' }, END)).toBeNull();
  });
});

describe('the OTLP exporter', () => {
  const config = { tracesUrl: 'https://collector.example.com/v1/traces', headers: { 'x-api-key': 'secret-value' }, serviceName: 'slotlock' };

  it('sends batches as OTLP JSON with the configured headers, and drops what it cannot send', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fetch = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
      sent.push({ url: String(url), init });
      return new Response(null, { status });
    });
    const errors: string[] = [];
    const exporter = createSlotlockOtlpExporter(config, {
      fetch: fetch as typeof globalThis.fetch,
      now: () => END,
      maxBatch: 2,
      maxQueue: 3,
      onError: (reason) => errors.push(reason),
    });
    const call = { type: 'rest' as const, operation: 'slotlock_list_resources' as const, status: 200, durationMs: 1 };
    exporter.record(call);
    exporter.record(call); // a full batch goes at once
    await exporter.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(config.tracesUrl);
    expect(new Headers(sent[0]?.init.headers).get('x-api-key')).toBe('secret-value');
    const body = JSON.parse(String(sent[0]?.init.body));
    expect(body.resourceSpans[0].resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'slotlock' } });
    expect(JSON.stringify(body)).not.toContain('service.version');
    expect(body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    // A collector that refuses costs those spans, never the caller, and says so without its headers.
    status = 500;
    exporter.record(call);
    await exporter.shutdown();
    expect(exporter.dropped).toBe(1);
    expect(errors).toEqual(['collector answered HTTP 500']);
    expect(errors.join(' ')).not.toContain('secret-value');
    // Past the queue's bound, spans are dropped as they come.
    const quiet = createSlotlockOtlpExporter(config, { fetch: (async () => new Response(null)) as typeof globalThis.fetch, maxBatch: 100, maxQueue: 2 });
    for (let i = 0; i < 5; i += 1) quiet.record(call);
    expect(quiet.dropped).toBe(3);
    await quiet.shutdown();
  });
});

describe('the OTEL_* variables', () => {
  it('reads the standard ones, and refuses what would not work', () => {
    expect(readSlotlockOtlpConfig({})).toBeUndefined();
    expect(readSlotlockOtlpConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318///' })).toEqual({
      tracesUrl: 'http://collector:4318/v1/traces',
      headers: {},
      serviceName: 'slotlock',
    });
    expect(
      readSlotlockOtlpConfig({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://api.honeycomb.io/v1/traces',
        OTEL_EXPORTER_OTLP_HEADERS: 'x-honeycomb-team=abc%3D123, x-other=2',
        OTEL_SERVICE_NAME: 'slotlock-cloud',
      }),
    ).toEqual({
      tracesUrl: 'https://api.honeycomb.io/v1/traces',
      headers: { 'x-honeycomb-team': 'abc=123', 'x-other': '2' },
      serviceName: 'slotlock-cloud',
    });
    for (const env of [
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'grpc://collector:4317' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:pass@collector.example.com' },
      { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_EXPORTER_OTLP_HEADERS: 'no-value' },
    ]) {
      expect(() => readSlotlockOtlpConfig(env), JSON.stringify(env)).toThrow(/OTEL_/);
    }
  });
});

describe('the published objectives', () => {
  it('are computed only from metrics Slotlock exports', () => {
    const rules = readFileSync(new URL('../../docs/hosted/slo-rules.yml', import.meta.url), 'utf8');
    const metrics = createSlotlockMetrics({ version: '1', now: () => 0 });
    metrics.event({ type: 'rest', operation: 'slotlock_list_resources', status: 200, durationMs: 5 });
    const scrape = metrics.render();
    const named = new Set([...rules.matchAll(/\b(slotlock_[a-z_]+)\{?/g)].map(([, name]) => name as string));
    expect(named.size).toBeGreaterThan(0);
    for (const name of named) expect(scrape, name).toMatch(new RegExp(`^${name}[{ ]`, 'm'));
    // Every alert reads a recording rule the file defines.
    const recorded = new Set([...rules.matchAll(/record: (\S+)/g)].map(([, name]) => name as string));
    for (const [, used] of rules.matchAll(/(slotlock:[a-z_:0-9]+)/g)) expect(recorded, used).toContain(used);
  });
});
