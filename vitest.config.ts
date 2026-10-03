import { defineConfig } from 'vitest/config';

// Test layout (applies to every app and package):
//   src/**/*.test.ts      -> unit tests: pure logic, no network, no database
//   src/**/*.int.test.ts  -> integration tests: real PostgreSQL in Docker (Testcontainers)
//   apps/web, packages/ui -> component tests (*.test.ts, *.test.tsx) in a browser-like DOM (jsdom)
//   apps/web/e2e          -> end-to-end tests with Playwright against the real API (pnpm test:e2e)
//   src/**/*.docker.test.ts -> container image tests (pnpm test:docker, vitest.docker.config.ts)
// Coverage is measured across the suites and must stay at 100%.
const DOM_PACKAGES = ['apps/web/src/**', 'packages/ui/src/**'];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
          exclude: [
            '**/*.int.test.ts',
            // Container image tests run on their own: vitest.docker.config.ts.
            '**/*.docker.test.ts',
            '**/node_modules/**',
            ...DOM_PACKAGES,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: 'web',
          include: DOM_PACKAGES.map((folder) => `${folder}/*.test.{ts,tsx}`),
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'jsdom',
          setupFiles: ['./vitest.dom-setup.ts'],
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
      include: ['{apps,packages}/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        // Fixtures and helpers used only by tests.
        '**/test-support/**',
        // Entry shims: they only call tested code and run outside the coverage process.
        'packages/testing/src/vitest-global-setup.ts',
        'apps/api/src/main.ts',
        'apps/web/src/main.tsx',
        'packages/ops/src/restore-drill-cli.ts',
        'packages/ops/src/migrate-cli.ts',
      ],
      reporter: ['text', 'html', 'lcov'],
      thresholds: {
        100: true,
      },
    },
  },
});
