// Metrics in the Prometheus text format: what the server's hooks report, counted by labels from
// closed sets, never a tenant or an argument.
import { describe, expect, it } from 'vitest';
import { createSlotlockMetrics } from '../metrics.js';

describe('slotlock metrics', () => {
  it('counts calls by protocol, operation and outcome, with their duration', () => {
    const metrics = createSlotlockMetrics({ version: '0.4.1', tzdata: '2026e', now: () => 1_700_000_000_000 });
    metrics.event({ type: 'call', protocol: 'mcp', operation: 'slotlock_create_event', outcome: 'ok', durationMs: 12 });
    metrics.event({ type: 'call', protocol: 'mcp', operation: 'slotlock_create_event', outcome: 'overlap', durationMs: 300 });
    metrics.event({ type: 'rest', operation: 'slotlock_list_resources', status: 200, durationMs: 4 });
    const text = metrics.render();
    expect(text).toContain('slotlock_build_info{version="0.4.1",tzdata="2026e"} 1');
    expect(text).toContain('slotlock_start_time_seconds 1700000000');
    expect(text).toContain('slotlock_calls_total{protocol="mcp",operation="slotlock_create_event",outcome="ok"} 1');
    expect(text).toContain('slotlock_calls_total{protocol="mcp",operation="slotlock_create_event",outcome="overlap"} 1');
    expect(text).toContain('slotlock_calls_total{protocol="rest",operation="slotlock_list_resources",outcome="200"} 1');
    expect(text).toContain('slotlock_call_duration_seconds_bucket{protocol="mcp",operation="slotlock_create_event",le="0.025"} 1');
    expect(text).toContain('slotlock_call_duration_seconds_bucket{protocol="mcp",operation="slotlock_create_event",le="0.5"} 2');
    expect(text).toContain('slotlock_call_duration_seconds_count{protocol="mcp",operation="slotlock_create_event"} 2');
    expect(text).toContain('slotlock_call_duration_seconds_sum{protocol="mcp",operation="slotlock_create_event"} 0.312');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('counts subscriptions, confirmations, refusals, maintenance and webhooks', () => {
    const metrics = createSlotlockMetrics({ version: '0.4.1' });
    metrics.event({ type: 'subscription', outcome: 'opened', resources: 2 });
    metrics.event({ type: 'subscription', outcome: 'opened', resources: 1 });
    metrics.event({ type: 'subscription', outcome: 'closed', reason: 'client', resources: 1 });
    metrics.event({ type: 'confirmation', operation: 'slotlock_create_event', outcome: 'accepted' });
    metrics.refusals({
      window_seconds: 60,
      auth_refused: 3,
      rate_limited: 0,
      lookup_overflow: 0,
      series_writes_busy: 0,
      maintenance_busy: 0,
      request_too_large: 1,
      clients: [{ client: 'pseudonym', refusals: 4 }],
    });
    metrics.maintenance({
      extended: 0,
      conflicts: 0,
      refused: 0,
      pruned: 5,
      zoneShifts: 0,
      staleSources: 1,
      noShows: 2,
      waitlistOffers: 1,
      capped: false,
      rollPending: false,
    });
    metrics.webhooks({ delivered: 7, failed: 1 });
    const text = metrics.render();
    expect(text).toContain('slotlock_subscriptions_open 1');
    expect(text).toContain('slotlock_subscriptions_total{outcome="closed",reason="client"} 1');
    expect(text).toContain('slotlock_confirmations_total{operation="slotlock_create_event",outcome="accepted"} 1');
    expect(text).toContain('slotlock_refusals_total{reason="auth_refused"} 3');
    expect(text).toContain('slotlock_refusals_total{reason="request_too_large"} 1');
    expect(text).not.toContain('reason="rate_limited"');
    expect(text).not.toContain('pseudonym');
    expect(text).toContain('slotlock_maintenance_passes_total{capped="false"} 1');
    expect(text).toContain('slotlock_maintenance_items_total{kind="noShows"} 2');
    expect(text).toContain('slotlock_webhook_deliveries_total{result="delivered"} 7');
    expect(text).toContain('slotlock_webhook_deliveries_total{result="failed"} 1');
  });

  it('counts an outcome outside its known shape as other, so a label cannot carry text', () => {
    const metrics = createSlotlockMetrics({ version: '0.4.1' });
    metrics.event({ type: 'call', protocol: 'a2a', operation: 'slotlock_get_event', outcome: 'tenant "x"\nleak', durationMs: 1 });
    const text = metrics.render();
    expect(text).toContain('outcome="other"} 1');
    expect(text).not.toContain('leak');
  });
});
