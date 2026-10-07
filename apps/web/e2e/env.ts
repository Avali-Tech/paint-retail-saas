import { join } from 'node:path';

// Where the end-to-end stack listens. Fixed ports (overridable) so the
// Playwright config, the global setup and the tests agree without passing state.
/** True on the CI runner. */
export const CI = process.env.CI !== undefined && process.env.CI !== '';
export const API_PORT = Number(process.env.E2E_API_PORT ?? 3999);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4999);
export const API_URL = `http://127.0.0.1:${String(API_PORT)}`;
export const WEB_URL = `http://localhost:${String(WEB_PORT)}`;
/** The update test serves one build after another here, apart from the shared web app. */
export const UPDATE_WEB_PORT = Number(process.env.E2E_UPDATE_PORT ?? WEB_PORT + 1);

/** E2E_CLAMAV=1 runs real storage and ClamAV, so documents can be uploaded (see global-setup.ts). */
export const SCANNER_ON = process.env.E2E_CLAMAV === '1';

/** The API's console output; one-time sign-in codes are read from it (SMS_PROVIDER=log). */
export const API_LOG = join(import.meta.dirname, '..', 'test-results', 'api.log');

/** The API's one-time secret for creating the first platform operator (tests only). */
export const PLATFORM_BOOTSTRAP_TOKEN = 'end-to-end-platform-bootstrap-token-0000';

/** The platform operator the console tests use; created once by the global setup. */
export const PLATFORM_OPERATOR = {
  fullName: 'Asha Operator',
  email: 'operator@e2e.paint.test',
  password: 'Operator@2026',
} as const;

/** The authenticator app the console sign-in test adds, kept across retries. */
export const PLATFORM_AUTHENTICATOR_FILE = join(
  import.meta.dirname,
  '..',
  'test-results',
  'platform-authenticator.json',
);
