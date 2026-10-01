import { join } from 'node:path';

// Where the end-to-end stack listens. Fixed ports (overridable) so the
// Playwright config, the global setup and the tests agree without passing state.
/** True on the CI runner. */
export const CI = process.env.CI !== undefined && process.env.CI !== '';
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3999);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4999);
export const API_URL = `http://127.0.0.1:${String(API_PORT)}`;
export const WEB_URL = `http://localhost:${String(WEB_PORT)}`;

/** The API's console output; one-time sign-in codes are read from it (SMS_PROVIDER=log). */
export const API_LOG = join(import.meta.dirname, '..', 'test-results', 'api.log');
