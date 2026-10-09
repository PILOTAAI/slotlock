import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRoot = join(packageRoot, 'dist');
const sourceManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));

const artifactManifest = {
  name: sourceManifest.name,
  version: sourceManifest.version,
  type: sourceManifest.type,
  description: sourceManifest.description,
  license: sourceManifest.license,
  author: sourceManifest.author,
  sideEffects: sourceManifest.sideEffects,
  main: './index.js',
  types: './index.d.ts',
  exports: {
    '.': {
      types: './index.d.ts',
      import: './index.js',
      default: './index.js',
    },
    './node-server': {
      types: './node-server.d.ts',
      import: './node-server.js',
      default: './node-server.js',
    },
    './manifest': './slotlock.manifest.json',
    './manifest.schema': './slotlock-manifest.schema.json',
    './package.json': './package.json',
  },
  // The root manifest names the built executable (`./dist/cli.js`); in the artifact it sits at the
  // root, spelled the way npm normalizes a bin path so packing changes nothing.
  bin: Object.fromEntries(
    Object.entries(sourceManifest.bin).map(([name, path]) => [name, path.replace(/^\.\/dist\//, '')]),
  ),
  repository: sourceManifest.repository,
  homepage: sourceManifest.homepage,
  bugs: sourceManifest.bugs,
  keywords: sourceManifest.keywords,
  engines: sourceManifest.engines,
  publishConfig: sourceManifest.publishConfig,
  dependencies: sourceManifest.dependencies,
  // The embedder's own `postgres` client is passed in, so its version (and types) must be the one
  // Slotlock resolves: a peer, never a nested copy.
  peerDependencies: sourceManifest.peerDependencies,
};

writeFileSync(join(artifactRoot, 'package.json'), `${JSON.stringify(artifactManifest, null, 2)}\n`);

for (const file of [
  'README.md',
  'LICENSE',
  'NOTICE',
  'SECURITY.md',
  'SPEC.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'CODE_OF_CONDUCT.md',
  'GOVERNANCE.md',
  'MAINTAINERS.md',
  'slotlock.manifest.json',
  'slotlock-manifest.schema.json',
]) {
  cpSync(join(packageRoot, file), join(artifactRoot, file));
}
