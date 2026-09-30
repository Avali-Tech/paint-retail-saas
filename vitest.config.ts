import { defineConfig } from 'vitest/config';

// Test layout (applies to every app and package):
//   src/**/*.test.ts      -> unit tests: pure logic, no network, no database
//   src/**/*.int.test.ts  -> integration tests: real PostgreSQL in Docker (Testcontainers)
// Coverage is measured across both suites and must stay at 100%.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['{apps,packages}/*/src/**/*.int.test.ts'],
          globalSetup: ['./packages/testing/src/vitest-global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 180_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['{apps,packages}/*/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        // Fixtures and helpers used only by tests.
        '**/test-support/**',
        // Entry shims: they only call tested code and run outside the coverage process.
        'packages/testing/src/vitest-global-setup.ts',
        'apps/api/src/main.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        100: true,
      },
    },
  },
});
