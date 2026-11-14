// The hosted dashboard Worker deploys from main once CI passes, but its database is migrated only
// when the server's release is deployed. A call to a function that database lacks broke the
// dashboard on 14 November 2026: through Hyperdrive, even a caught failure cost the request its
// connection. So every slotlock function the Worker's code calls must be in the latest release's
// schema (workers/dashboard/released-schema-functions.json, written by scripts/prepare-release.sh),
// or be asked about first (src/schema-functions.ts SLOTLOCK_OPTIONAL_SCHEMA_FUNCTIONS).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RELEASED_SCHEMA_FUNCTIONS,
  isSchemaSource,
  releasedFunctions,
  schemaFunctionNames,
} from '../../scripts/schema-functions.mjs';
import { SLOTLOCK_OPTIONAL_SCHEMA_FUNCTIONS } from '../schema-functions.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Functions only `slotlock serve` calls, though their module is in the Worker's bundle: serve's
 * release migrates its schema before it serves. Each says where serve calls it.
 */
const SERVE_ONLY: Readonly<Record<string, string>> = {
  note_maintenance_failure: 'createSlotlockMaintenanceRecord, which only self-host.ts uses',
  note_maintenance_recovered: 'createSlotlockMaintenanceRecord, which only self-host.ts uses',
  note_maintenance_round: 'createSlotlockMaintenanceRecord, which only self-host.ts uses',
};

/** The Worker's sources: worker.ts and every file it imports, type-only imports aside. */
function workerSources(): string[] {
  const seen = new Set<string>();
  const queue = [resolve(root, 'workers/dashboard/worker.ts')];
  const importsOf = /^\s*(?:import|export)(?!\s+type\b)[^;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm;
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, 'utf8').matchAll(importsOf)) {
      const target = resolve(dirname(file), (match[1] ?? match[2] ?? match[3]) as string).replace(/\.js$/, '.ts');
      if (existsSync(target)) queue.push(target);
    }
  }
  return [...seen].map((file) => relative(root, file).split('\\').join('/')).sort();
}

/** Each slotlock function the sources call, outside the schema sources, with where. */
function callsIn(sources: string[], functions: ReadonlySet<string>): Map<string, string[]> {
  const calls = new Map<string, string[]>();
  for (const source of sources.filter((path) => !isSchemaSource(path))) {
    for (const match of readFileSync(resolve(root, source), 'utf8').matchAll(/\bslotlock\.([a-z_0-9]+)\s*\(/g)) {
      const name = match[1] as string;
      // A table's column list reads the same: only the schema's functions count.
      if (!functions.has(name)) continue;
      calls.set(name, [...new Set([...(calls.get(name) ?? []), source])]);
    }
  }
  return calls;
}

const released = JSON.parse(readFileSync(resolve(root, RELEASED_SCHEMA_FUNCTIONS), 'utf8')) as {
  release: string;
  functions: string[];
};
const current = new Set(releasedFunctions(root));
const optional = new Set(SLOTLOCK_OPTIONAL_SCHEMA_FUNCTIONS.map((signature) => signature.replace(/^slotlock\.|\(.*$/g, '')));
const sources = workerSources();
const calls = callsIn(sources, current);

describe('the dashboard Worker on its release-behind database', () => {
  it('calls no function the latest release lacks, unless it asks first', () => {
    const behind = [...calls]
      .filter(([name]) => !released.functions.includes(name) && !optional.has(name) && !(name in SERVE_ONLY))
      .map(([name, files]) => `slotlock.${name} (${files.join(', ')})`);
    expect(
      behind,
      `The dashboard Worker deploys before ${released.release}'s successor migrates its database, so these ` +
        'calls would fail there, and through Hyperdrive take the request with them. Ask first: list the ' +
        'signature in SLOTLOCK_OPTIONAL_SCHEMA_FUNCTIONS (src/schema-functions.ts) and call it only when ' +
        'createSlotlockSchemaFunctions says it is there.',
    ).toEqual([]);
  });

  it('reads the Worker and its calls', () => {
    // So a broken scan cannot pass the check above by finding nothing.
    expect(sources).toEqual(expect.arrayContaining(['workers/dashboard/worker.ts', 'src/workspaces.ts', 'src/billing.ts']));
    expect(sources).not.toContain('src/self-host.ts');
    expect(calls.get('tenant_dashboard_notices')).toEqual(expect.arrayContaining(['src/workspaces.ts']));
    expect(calls.size).toBeGreaterThan(50);
  });

  it('asks only about functions the schema defines', () => {
    for (const name of optional) expect(current, name).toContain(name);
  });

  it('keeps serve-only functions out of the Worker', () => {
    for (const [name, where] of Object.entries(SERVE_ONLY)) {
      expect(calls.get(name), `${name}: ${where}`).toEqual(['src/maintenance.ts']);
    }
    const record = sources.filter(
      (path) => path !== 'src/maintenance.ts' && readFileSync(resolve(root, path), 'utf8').includes('createSlotlockMaintenanceRecord('),
    );
    expect(record).toEqual([]);
  });

  it('holds a release, and the functions that release defines', () => {
    expect(readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8')).toContain(`\n## ${released.release} - `);
    expect(released.functions).toEqual([...new Set(released.functions)].sort());
    expect(released.functions.length).toBeGreaterThan(100);
  });

  it('finds a schema source and the functions it creates', () => {
    expect(isSchemaSource('src/ddl.ts')).toBe(true);
    expect(isSchemaSource('src/ddl-sso.ts')).toBe(true);
    expect(isSchemaSource('src/staff-ddl.ts')).toBe(true);
    expect(isSchemaSource('src/store.ts')).toBe(false);
    expect(isSchemaSource('src/__tests__/ddl.unit.test.ts')).toBe(false);
    expect([
      ...schemaFunctionNames(
        'CREATE OR REPLACE FUNCTION slotlock.one(text)\nCREATE FUNCTION slotlock.two ()\nDROP FUNCTION slotlock.three(text)\nGRANT EXECUTE ON FUNCTION slotlock.four()',
      ),
    ]).toEqual(['one', 'two']);
  });
});
