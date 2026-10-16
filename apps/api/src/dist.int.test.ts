import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

// Builds the production bundle and runs it exactly as a server would:
// `node dist/server/main.js`. Proves the bundle starts, finds its migrations,
// serves requests and shuts down cleanly on SIGTERM.

const appDir = fileURLToPath(new URL('..', import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  return typeof address === 'object' && address ? address.port : 0;
}

async function waitForReady(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`Server not ready at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

let database: TestDatabase;
let server: ChildProcess;
let baseUrl: string;

beforeAll(async () => {
  await promisify(execFile)('pnpm', ['build'], { cwd: appDir });
  database = await createIsolatedDatabase(inject('databaseUrl'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${String(port)}`;
  server = spawn(process.execPath, ['--enable-source-maps', 'dist/server/main.js'], {
    cwd: appDir,
    env: {
      ...process.env,
      DATABASE_URL: database.connectionString,
      HOST: '127.0.0.1',
      PORT: String(port),
      NODE_ENV: 'production',
      LOG_LEVEL: 'error',
      RUN_MIGRATIONS: 'true',
      AUTH_SECRET: 'dist-test-secret-of-at-least-32-characters',
      // Production invoices by hand (the default) and refuses placeholder GST and bank
      // details; it needs no Razorpay keys.
      PLATFORM_BANK_NAME: 'Test Bank, Hyderabad',
      PLATFORM_BANK_ACCOUNT_NAME: 'Platform Test Private Limited',
      PLATFORM_BANK_ACCOUNT_NUMBER: '123456789012',
      PLATFORM_BANK_IFSC: 'SBIN0020345',
      PLATFORM_LEGAL_NAME: 'Platform Test Private Limited',
      PLATFORM_GSTIN: '36AAACP0000P1ZP',
      PLATFORM_ADDRESS: '1 Test Road',
      PLATFORM_CITY: 'Hyderabad',
      PLATFORM_PINCODE: '500001',
      STORAGE_BUCKET: 'dist-test-documents',
      STORAGE_ENDPOINT: inject('objectStorageEndpoint'),
      CLAMAV_HOST: inject('virusScannerAddress').split(':')[0],
      CLAMAV_PORT: inject('virusScannerAddress').split(':')[1],
    },
    stdio: 'ignore',
  });
}, 120_000);

afterAll(async () => {
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  await database.stop();
});

describe('built server (dist/server/main.js)', () => {
  it('starts, applies the bundled migrations and reports ready', async () => {
    const response = await waitForReady(`${baseUrl}/health/ready`, 30_000);

    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'up' } });
    const applied = await withPgClient(database.connectionString, async (client) => {
      const result = await client.query('SELECT 1 FROM drizzle.__drizzle_migrations');
      return result.rowCount;
    });
    const bundled = readdirSync(`${appDir}/dist/migrations`).filter((file) =>
      file.endsWith('.sql'),
    );
    expect(bundled.length).toBeGreaterThan(0);
    expect(applied).toBe(bundled.length);
  });

  it('shuts down cleanly on SIGTERM, as during a deploy', async () => {
    const exited = once(server, 'exit');

    server.kill('SIGTERM');
    const [code, signal] = (await exited) as [number | null, NodeJS.Signals | null];

    expect(code === 0 || signal === 'SIGTERM').toBe(true);
  });
});
