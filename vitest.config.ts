import { defineConfig } from 'vitest/config';

export default defineConfig({
  // One tsconfig for every file the tests compile, the repository's own. Without it Vite takes the
  // nearest one, and site/tsconfig.json extends astro/tsconfigs/strict, which exists only once
  // site/ has its own node_modules: the tests that import site/src/lib/post-format.ts would fail on
  // a clean checkout.
  tsconfig: './tsconfig.json',
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'packages/*/src/**/*.test.ts'],
    // Both integration suites intentionally exercise one package-owned schema, including upgrade
    // from/drop of legacy fixtures. Serial files keep those real-DDL probes deterministic.
    fileParallelism: false,
  },
});
