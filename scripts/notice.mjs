// NOTICE, written from package.json and package-lock.json so a dependency bump never needs a hand
// edit. The repository's NOTICE names each direct runtime dependency and its licence: a bump that
// moves a version, a repository URL or what a dependency pulls in leaves it as it is, and only a
// dependency that changes its licence asks for --write. The NOTICE packed into each release
// (scripts/prepare-package.mjs) also names the exact version it was built with, where each comes from
// and the packages each pulls in, and scripts/verify-package.mjs checks that one with checkNotice.
//
//   node scripts/notice.mjs --write     rewrite the repository's NOTICE
//   node scripts/notice.mjs --check     exit 1 when the repository's NOTICE is not what --write writes
//
// A licence is printed by name only once it is in LICENSE_NAMES below, so a dependency that arrives
// under a licence nobody has read, however deep, stops the build and --check instead of shipping
// quietly.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SPDX identifiers whose terms have been read for this project, and how NOTICE names them. */
const LICENSE_NAMES = {
  '0BSD': 'BSD Zero Clause License (0BSD)',
  'Apache-2.0': 'Apache License 2.0',
  'BSD-2-Clause': 'BSD 2-Clause License',
  'BSD-3-Clause': 'BSD 3-Clause License',
  ISC: 'ISC License',
  MIT: 'MIT License',
  'MPL-2.0': 'Mozilla Public License 2.0',
  Unlicense: 'The Unlicense',
};

const COPYRIGHT_YEAR = 2026;

/** The repository URL a package.json declares, as an https URL with no .git suffix. */
function repositoryUrl(manifest) {
  const repository = manifest.repository;
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (!raw) return manifest.homepage ?? `https://www.npmjs.com/package/${manifest.name}`;
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) return `https://github.com/${raw}`;
  return raw
    .replace(/^github:/, 'https://github.com/')
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/\.git$/, '');
}

/**
 * Where npm installs DEPENDENCY for the package at PARENT (a lockfile key such as
 * node_modules/rrule): the nearest node_modules on the way up, as Node resolves it.
 */
function resolveLocked(lock, parent, dependency) {
  for (let at = parent; ; ) {
    const key = `${at ? `${at}/` : ''}node_modules/${dependency}`;
    if (lock.packages[key]) return key;
    if (!at) return undefined;
    const cut = at.lastIndexOf('/node_modules/');
    at = cut < 0 ? '' : at.slice(0, cut);
  }
}

/**
 * The runtime dependencies npm installs with Slotlock: each direct dependency, then the packages it
 * pulls in, read from the lockfile and from each package's own package.json.
 */
export function runtimeDependencies(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const describe = (key, name) => {
    const entry = lock.packages[key];
    const license = entry.license;
    const licenseName = LICENSE_NAMES[license];
    if (!licenseName) {
      throw new Error(
        `${name} is under ${license ?? 'no declared licence'}, which NOTICE does not name yet: read its terms, then add it to LICENSE_NAMES in scripts/notice.mjs`,
      );
    }
    const installed = JSON.parse(readFileSync(join(root, key, 'package.json'), 'utf8'));
    return { name, version: entry.version, licenseName, url: repositoryUrl(installed) };
  };
  const seen = new Set();
  const walk = (parentKey, parentName) => {
    const children = [];
    for (const name of Object.keys(lock.packages[parentKey]?.dependencies ?? {}).sort()) {
      const key = resolveLocked(lock, parentKey, name);
      if (!key) throw new Error(`package-lock.json does not install ${name} for ${parentName}`);
      if (seen.has(key)) continue;
      seen.add(key);
      children.push({ ...describe(key, name), via: parentName, dependencies: walk(key, name) });
    }
    return children;
  };
  const direct = Object.keys(manifest.dependencies ?? {})
    .sort()
    .map((name) => {
      const key = `node_modules/${name}`;
      if (!lock.packages[key]) throw new Error(`package-lock.json does not install ${name}`);
      seen.add(key);
      return { ...describe(key, name), dependencies: walk(key, name) };
    });
  const peers = Object.entries(manifest.peerDependencies ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, range]) => ({ ...describe(`node_modules/${name}`, name), range }));
  return { direct, peers };
}

/**
 * NOTICE for the repository (versions: false), with each direct dependency and its licence, or for
 * a packed release (versions: true), where each direct dependency carries the exact version it was
 * built with, its URL and the packages it pulls in.
 */
export function renderNotice(root, { versions }) {
  const { direct, peers } = runtimeDependencies(root);
  const lines = [];
  const list = (dependency, depth) => {
    const indent = '  '.repeat(depth);
    const label =
      depth === 0
        ? `${dependency.name} ${dependency.version}`
        : `${dependency.name} (via ${dependency.via})`;
    lines.push(`${indent}- ${label}, ${dependency.licenseName}, ${dependency.url}`);
    for (const child of dependency.dependencies) list(child, depth + 1);
  };
  for (const dependency of direct) {
    if (versions) list(dependency, 0);
    else lines.push(`- ${dependency.name}, ${dependency.licenseName}`);
  }
  const peerLine = (peer) =>
    `- ${peer.name} ${peer.range}, ${peer.licenseName}${versions ? `, ${peer.url}` : ''}`;
  const versionNote = versions
    ? 'each retains its own license. This release was built with these versions:'
    : 'each retains its own license. The NOTICE in each published package lists them with the exact\nversions it was built with, where each comes from, and the packages each pulls in:';
  return `Slotlock
Copyright ${COPYRIGHT_YEAR} TREFT LTD

This product includes software developed by TREFT LTD and the Slotlock contributors, distributed
under the Apache License 2.0.

Runtime dependencies are not bundled into the Slotlock artifact; npm installs them alongside it and
${versionNote}

${lines.join('\n')}

Peer dependency, installed and versioned by the application that embeds Slotlock:

${peers.map(peerLine).join('\n')}

If Slotlock distributes a modified MPL-covered ical.js file in the future, that file and its source
must remain available under MPL-2.0. Slotlock currently imports the unmodified external dependency.
`;
}

/**
 * What is wrong with a packed NOTICE for the packed MANIFEST: every dependency at its exact version
 * and every peer dependency at its range. An empty list means nothing.
 */
export function checkNotice(notice, manifest) {
  const problems = [];
  if (!/^Copyright \d{4} TREFT LTD$/m.test(notice))
    problems.push('NOTICE must name the copyright holder');
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!notice.includes(`- ${name} ${version},`))
      problems.push(`NOTICE must list ${name} ${version}`);
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!notice.includes(`- ${name} ${range},`))
      problems.push(`NOTICE must list peer ${name} ${range}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const mode = process.argv[2];
  const expected = renderNotice(root, { versions: false });
  if (mode === '--write') {
    writeFileSync(join(root, 'NOTICE'), expected);
  } else if (mode === '--check') {
    if (readFileSync(join(root, 'NOTICE'), 'utf8') !== expected) {
      console.error(
        'NOTICE is not what scripts/notice.mjs writes: run node scripts/notice.mjs --write',
      );
      process.exit(1);
    }
  } else {
    console.error('usage: node scripts/notice.mjs --write | --check');
    process.exit(2);
  }
}
