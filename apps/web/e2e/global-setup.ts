import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startTestDatabase } from '@paint/testing';
import { API_LOG, API_PORT, API_URL, WEB_PORT, WEB_URL } from './env.js';

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

  const database = await startTestDatabase();
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
    await database.stop();
  };
  try {
    await waitFor(`${API_URL}/health/ready`, 'API', api);
    await waitFor(`${WEB_URL}/api/health`, 'web app', web);
  } catch (error) {
    await teardown();
    throw error;
  }
  return teardown;
}
