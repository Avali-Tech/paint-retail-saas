import { createIsolatedDatabase, withPgClient, type TestDatabase } from '@paint/testing';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { bootstrap } from './bootstrap.js';
import { ConfigError } from './config.js';
import { TEST_AUTH_SECRET } from './test-support/test-app.js';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function freshDatabase(): Promise<TestDatabase> {
  const database = await createIsolatedDatabase(inject('databaseUrl'));
  cleanups.push(() => database.stop());
  return database;
}

const tablesIn = (url: string) =>
  withPgClient(url, async (client) => {
    const result = await client.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    return result.rows.map((row) => row.table_name);
  });

const env = (databaseUrl: string, extra: Record<string, string> = {}) => ({
  DATABASE_URL: databaseUrl,
  HOST: '127.0.0.1',
  PORT: '0',
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  AUTH_SECRET: TEST_AUTH_SECRET,
  ...extra,
});

describe('bootstrap', () => {
  it('applies migrations when asked, then serves real HTTP requests', async () => {
    const database = await freshDatabase();

    const app = await bootstrap(env(database.connectionString, { RUN_MIGRATIONS: 'true' }));
    cleanups.push(() => app.close());

    expect(await tablesIn(database.connectionString)).toEqual(
      expect.arrayContaining(['organizations', 'stores', 'users']),
    );
    const response = await fetch(`${await app.getUrl()}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { database: 'up' } });
  });

  it('leaves the schema alone when migrations are not requested', async () => {
    const database = await freshDatabase();

    const app = await bootstrap(env(database.connectionString));
    cleanups.push(() => app.close());

    expect(await tablesIn(database.connectionString)).toEqual([]);
    expect((await fetch(`${await app.getUrl()}/health`)).status).toBe(200);
  });

  it('refuses to start with invalid configuration', async () => {
    await expect(bootstrap({ PORT: 'abc' })).rejects.toThrow(ConfigError);
  });
});
