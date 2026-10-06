import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { startTestDatabase, startTestObjectStorage, startTestVirusScanner } from '@paint/testing';
import {
  API_LOG,
  API_PORT,
  API_URL,
  PLATFORM_BOOTSTRAP_TOKEN,
  PLATFORM_OPERATOR,
  SCANNER_ON,
  WEB_PORT,
  WEB_URL,
} from './env.js';

const webDir = join(import.meta.dirname, '..');
const apiServer = join(webDir, '..', 'api', 'dist', 'server', 'main.js');

async function waitFor(url: string, name: string, child: ChildProcess, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`${name} exited with code ${String(child.exitCode)}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${name} did not start at ${url} within ${String(timeoutMs / 1000)} s`);
}

function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/** A local port nothing listens on. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * Document uploads. By default the virus scanner is "off" (nothing listens on its
 * port), as in `pnpm demo` without --clamav, so every upload is refused with 503
 * and the tests check the message people see. E2E_CLAMAV=1 starts real S3-compatible
 * storage and ClamAV (heavy: about 1.5 GB and a minute or two) for the full flow.
 */
async function documentServices(): Promise<{
  env: Record<string, string>;
  stop: () => Promise<void>;
}> {
  const bucket = 'paint-e2e-documents';
  if (!SCANNER_ON) {
    return {
      env: {
        STORAGE_BUCKET: bucket,
        // Never reached: the scan fails first.
        STORAGE_ENDPOINT: 'http://127.0.0.1:9',
        STORAGE_ACCESS_KEY_ID: 'e2e',
        STORAGE_SECRET_ACCESS_KEY: 'e2e',
        CLAMAV_HOST: '127.0.0.1',
        CLAMAV_PORT: String(await closedPort()),
      },
      stop: () => Promise.resolve(),
    };
  }
  const [storage, scanner] = await Promise.all([startTestObjectStorage(), startTestVirusScanner()]);
  // SeaweedFS accepts unsigned requests, like `pnpm demo` creates its bucket.
  const created = await fetch(`${storage.endpoint}/${bucket}`, { method: 'PUT' });
  if (!created.ok)
    throw new Error(`Could not create the ${bucket} bucket: ${String(created.status)}`);
  return {
    env: {
      STORAGE_BUCKET: bucket,
      STORAGE_ENDPOINT: storage.endpoint,
      STORAGE_ACCESS_KEY_ID: 'e2e',
      STORAGE_SECRET_ACCESS_KEY: 'e2e',
      CLAMAV_HOST: scanner.host,
      CLAMAV_PORT: String(scanner.port),
    },
    stop: async () => {
      await Promise.all([storage.stop(), scanner.stop()]);
    },
  };
}

/**
 * Creates the platform's only operator (bootstrap works once), without an
 * authenticator app yet: the sign-in test adds one through the console. Its
 * session reaches the tests through the environment, so the other console tests
 * start signed in instead of each needing a fresh authenticator code.
 */
async function bootstrapOperator(): Promise<void> {
  const response = await fetch(`${API_URL}/platform/bootstrap`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: PLATFORM_BOOTSTRAP_TOKEN, ...PLATFORM_OPERATOR }),
  });
  if (!response.ok) {
    throw new Error(
      `Platform bootstrap failed: ${String(response.status)} ${await response.text()}`,
    );
  }
  process.env.E2E_PLATFORM_SESSION = await response.text();
}

/**
 * Starts the real stack once for the whole run: a throwaway PostgreSQL in
 * Docker, the built API (migrating that database on start) and the built web
 * app served by `vite preview`, which proxies /api to the API like production.
 * Build both first (pnpm test:e2e does).
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  if (!existsSync(apiServer)) {
    throw new Error(
      'Build the API first: pnpm --filter @paint/api build (pnpm test:e2e does this)',
    );
  }
  if (!existsSync(join(webDir, 'dist', 'index.html'))) {
    throw new Error('Build the web app first: pnpm --filter @paint/web build');
  }

  const [database, documents] = await Promise.all([startTestDatabase(), documentServices()]);
  mkdirSync(dirname(API_LOG), { recursive: true });
  const log = createWriteStream(API_LOG);

  const api = spawn(process.execPath, ['--enable-source-maps', apiServer], {
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: String(API_PORT),
      DATABASE_URL: database.connectionString,
      RUN_MIGRATIONS: 'true',
      AUTH_SECRET: 'end-to-end-test-secret-of-at-least-32-characters',
      // Prints one-time codes to the log, where the OTP test reads them.
      SMS_PROVIDER: 'log',
      LOG_LEVEL: 'log',
      WORKER_INTERVAL_SECONDS: '0',
      SIGNUP_PLAN: 'enterprise',
      APP_URL: WEB_URL,
      // Lets the setup below create the platform operator the console tests sign in as.
      PLATFORM_BOOTSTRAP_TOKEN,
      ...documents.env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  api.stdout.pipe(log);
  api.stderr.pipe(log);

  const web = spawn(
    process.execPath,
    [join(webDir, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB_PORT)],
    {
      cwd: webDir,
      env: { ...process.env, API_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  web.stdout.pipe(log);
  web.stderr.pipe(log);

  const teardown = async () => {
    await Promise.all([stop(web), stop(api)]);
    log.end();
    await Promise.all([database.stop(), documents.stop()]);
  };
  try {
    await waitFor(`${API_URL}/health/ready`, 'API', api);
    await waitFor(`${WEB_URL}/api/health`, 'web app', web);
    await bootstrapOperator();
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
