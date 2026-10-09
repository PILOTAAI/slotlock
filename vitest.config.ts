import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Both integration suites intentionally exercise one package-owned schema, including upgrade
    // from/drop of legacy fixtures. Serial files keep those real-DDL probes deterministic.
    fileParallelism: false,
  },
});
