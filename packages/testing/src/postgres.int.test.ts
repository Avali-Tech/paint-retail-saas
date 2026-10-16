import { describe, expect, inject, it } from 'vitest';
import {
  MAX_LOCKS_PER_TRANSACTION,
  POSTGRES_IMAGE,
  startTestDatabase,
  withPgClient,
} from './index.js';

describe('startTestDatabase', () => {
  it('starts a PostgreSQL 17 container that accepts queries, and stops it', async () => {
    const database = await startTestDatabase();
    try {
      expect(database.connectionString).toMatch(/^postgres(ql)?:\/\//);

      const version = await withPgClient(database.connectionString, async (client) => {
        const result = await client.query<{ server_version: string }>('SHOW server_version');
        return result.rows[0]?.server_version;
      });

      expect(POSTGRES_IMAGE).toBe('postgres:17-alpine');
      expect(version).toMatch(/^17\./);
    } finally {
      await database.stop();
    }

    await expect(
      withPgClient(database.connectionString, (client) => client.query('SELECT 1')),
    ).rejects.toThrow();
  });
});

describe('shared integration database', () => {
  it('is provided to every integration test by global setup', async () => {
    const answer = await withPgClient(inject('databaseUrl'), async (client) => {
      const result = await client.query<{ answer: number }>('SELECT 42 AS answer');
      return result.rows[0]?.answer;
    });

    expect(answer).toBe(42);
  });

  it('has room in the lock table for parallel migrations and bulk seeds', async () => {
    const setting = await withPgClient(inject('databaseUrl'), async (client) => {
      const result = await client.query<{ max_locks_per_transaction: string }>(
        'SHOW max_locks_per_transaction',
      );
      return result.rows[0]?.max_locks_per_transaction;
    });

    expect(setting).toBe(String(MAX_LOCKS_PER_TRANSACTION));
  });
});

describe('withPgClient', () => {
  it('returns the result of the work', async () => {
    const result = await withPgClient(inject('databaseUrl'), () => Promise.resolve('done'));

    expect(result).toBe('done');
  });

  it('closes the connection even when the work throws', async () => {
    let usedClient: { query: (sql: string) => Promise<unknown> } | undefined;

    await expect(
      withPgClient(inject('databaseUrl'), (client) => {
        usedClient = client;
        return Promise.reject(new Error('boom'));
      }),
    ).rejects.toThrow('boom');

    await expect(usedClient?.query('SELECT 1')).rejects.toThrow();
  });
});
