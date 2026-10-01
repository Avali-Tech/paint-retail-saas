import { defineConfig, devices } from '@playwright/test';
import { CI, WEB_URL } from './e2e/env.js';

// End-to-end tests: a real browser against the built web app, the built API and
// a real PostgreSQL (see e2e/global-setup.ts). Run with `pnpm test:e2e`.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : 4,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grepInvert: /@phone/ },
    // Counter staff on low-end Android phones.
    { name: 'phone', use: { ...devices['Pixel 5'] }, grep: /@phone/ },
  ],
});
