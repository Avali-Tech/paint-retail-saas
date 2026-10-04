import { defineConfig } from 'vitest/config';

// Container image tests (*.docker.test.ts): build the production images and run
// them against real services. Slow, so they are not part of `pnpm verify`; they run
// with `pnpm test:docker` and in CI's "docker" job when Dockerfiles or sources change.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.docker.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 1_800_000,
  },
});
