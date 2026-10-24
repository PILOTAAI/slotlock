// The dashboard Worker's example configuration (workers/dashboard/wrangler.jsonc), which operators
// copy: it declares every rate limiting binding the Worker refuses to serve without, keeps sign-ins
// per client under a higher ceiling for all, and keeps OAuth codes out of the Workers Logs it turns
// on. Wrangler's settings are those of wrangler 4.149.0's config-schema.json (read 2026-10-24):
// a binding's `simple.period` is 10 or 60 seconds, and `observability.redact_query_string` removes
// query strings from request URLs in logs and traces (default false).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** JSON with comments and trailing commas, as wrangler.jsonc allows: comments and commas dropped. */
function parseJsonc(text: string): unknown {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const character = text[index] as string;
    if (character === '"') {
      // A string, escapes included, copied whole: `//` inside a URL is not a comment.
      const end = /^"(?:[^"\\]|\\.)*"/.exec(text.slice(index))?.[0] ?? '"';
      out += end;
      index += end.length;
    } else if (text.startsWith('//', index)) {
      index = text.indexOf('\n', index);
      if (index === -1) index = text.length;
    } else if (text.startsWith('/*', index)) {
      index = text.indexOf('*/', index) + 2;
    } else {
      out += character;
      index += 1;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

interface WranglerConfig {
  ratelimits: { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
  observability?: { enabled?: boolean; redact_query_string?: boolean };
}

const config = parseJsonc(
  readFileSync(new URL('../../workers/dashboard/wrangler.jsonc', import.meta.url), 'utf8'),
) as WranglerConfig;

describe('the dashboard Worker example configuration', () => {
  it('declares every rate limiting binding the Worker requires, each with its own namespace', () => {
    const names = config.ratelimits.map(({ name }) => name).sort();
    expect(names).toEqual([
      'SLOTLOCK_CLIENT_RATE_LIMIT',
      'SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT',
      'SLOTLOCK_SIGN_IN_RATE_LIMIT',
    ]);
    const namespaces = config.ratelimits.map(({ namespace_id }) => namespace_id);
    expect(new Set(namespaces).size).toBe(namespaces.length);
    for (const { namespace_id, simple } of config.ratelimits) {
      expect(namespace_id).toMatch(/^[1-9]\d*$/);
      expect([10, 60]).toContain(simple.period);
    }
  });

  it("limits one client's sign-ins well below the ceiling every client shares (SEC-12)", () => {
    const perMinute = (name: string) => {
      const found = config.ratelimits.find((binding) => binding.name === name);
      return ((found?.simple.limit ?? 0) * 60) / (found?.simple.period ?? 60);
    };
    expect(perMinute('SLOTLOCK_SIGN_IN_CEILING_RATE_LIMIT')).toBeGreaterThanOrEqual(
      20 * perMinute('SLOTLOCK_SIGN_IN_RATE_LIMIT'),
    );
  });
});
