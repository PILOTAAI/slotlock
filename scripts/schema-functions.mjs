#!/usr/bin/env node
// The functions a release's schema defines, for the check that the hosted dashboard Worker calls
// none its database may lack (src/__tests__/dashboard-schema.unit.test.ts).
//
// The dashboard Worker deploys from main once CI passes, but its database is migrated only when the
// server's release is deployed. So the Worker can run code ahead of its schema, and a call to a
// function the schema lacks breaks it: through Hyperdrive even a caught failure costs the request
// its connection (the outage of 14 November 2026). The check holds every function the Worker's code
// calls to this file, the latest release's functions, unless the code asks first
// (src/schema-functions.ts).
//
// Run from the checkout's root:
//   node scripts/schema-functions.mjs --write          from the schema sources in the working tree,
//                                                      at package.json's version (prepare-release.sh)
//   node scripts/schema-functions.mjs --write <ref>    from the schema sources at a git ref, such as
//                                                      a release tag
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RELEASED_SCHEMA_FUNCTIONS = 'workers/dashboard/released-schema-functions.json';

/** A schema source: src/ddl.ts, src/ddl-*.ts or src/*-ddl.ts. */
export function isSchemaSource(path) {
  return /^src\/(?:ddl(?:-[a-z0-9-]+)?|[a-z0-9-]+-ddl)\.ts$/.test(path);
}

/** The names of the slotlock functions a schema source creates. */
export function schemaFunctionNames(text) {
  const names = new Set();
  for (const match of text.matchAll(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+slotlock\.([a-z_0-9]+)\s*\(/gi)) {
    names.add(match[1].toLowerCase());
  }
  return names;
}

/** Every function the schema sources at `ref` (the working tree when null) create, sorted. */
export function releasedFunctions(root, ref = null) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
  const paths = ref
    ? git('ls-tree', '-r', '--name-only', ref, '--', 'src').split('\n')
    : readdirSync(join(root, 'src')).map((name) => `src/${name}`);
  const names = new Set();
  for (const path of paths.filter(isSchemaSource)) {
    const text = ref ? git('show', `${ref}:${path}`) : readFileSync(join(root, path), 'utf8');
    for (const name of schemaFunctionNames(text)) names.add(name);
  }
  return [...names].sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [flag, ref = null, extra] = process.argv.slice(2);
  if (flag !== '--write' || extra !== undefined) {
    console.error('usage: node scripts/schema-functions.mjs --write [<git ref>]');
    process.exit(2);
  }
  // The checkout being released, as for the rest of scripts/prepare-release.sh.
  const root = process.cwd();
  const manifest = ref
    ? JSON.parse(execFileSync('git', ['show', `${ref}:package.json`], { cwd: root, encoding: 'utf8' }))
    : JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const functions = releasedFunctions(root, ref);
  if (functions.length === 0) {
    console.error(`no schema functions found${ref ? ` at ${ref}` : ''}`);
    process.exit(1);
  }
  writeFileSync(
    join(root, RELEASED_SCHEMA_FUNCTIONS),
    `${JSON.stringify({ release: manifest.version, functions }, null, 2)}\n`,
  );
  console.log(`${RELEASED_SCHEMA_FUNCTIONS}: ${functions.length} functions of ${manifest.version}.`);
}
