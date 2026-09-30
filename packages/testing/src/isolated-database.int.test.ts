import pg from 'pg';
import { describe, expect, inject, it } from 'vitest';
import { createIsolatedDatabase, withPgClient } from './index.js';

const currentDatabase = (url: string) =>
  withPgClient(url, async (client) => {
    const result = await client.query<{ name: string }>('SELECT current_database() AS name');
    return result.rows[0]?.name;
  });

describe('createIsolatedDatabase', () => {
  it('creates a separate, empty database and drops it on stop', async () => {
    const serverUrl = inject('databaseUrl');
    const database = await createIsolatedDatabase(serverUrl);

    const name = await currentDatabase(database.connectionString);
    expect(name).toMatch(/^test_[0-9a-f]{32}$/);
    expect(name).not.toBe(await currentDatabase(serverUrl));

    const tables = await withPgClient(database.connectionString, async (client) => {
      const result = await client.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'",
      );
      return result.rowCount;
    });
    expect(tables).toBe(0);

    await database.stop();

    await expect(currentDatabase(database.connectionString)).rejects.toThrow(/does not exist/);
  });

  it('keeps data written in one isolated database out of another', async () => {
    const serverUrl = inject('databaseUrl');
    const first = await createIsolatedDatabase(serverUrl);
    const second = await createIsolatedDatabase(serverUrl);
    try {
      await withPgClient(first.connectionString, (client) =>
        client.query('CREATE TABLE only_in_first (id int)'),
      );

      await expect(
        withPgClient(second.connectionString, (client) =>
          client.query('SELECT * FROM only_in_first'),
        ),
      ).rejects.toThrow(/does not exist/);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it('drops the database even while a connection is still open', async () => {
    const database = await createIsolatedDatabase(inject('databaseUrl'));
    const openClient = new pg.Client({ connectionString: database.connectionString });
    const terminated = new Promise<Error>((resolve) => {
      openClient.on('error', resolve);
    });
    await openClient.connect();

    await database.stop();

    expect((await terminated).message).toMatch(/terminat/);
    await expect(currentDatabase(database.connectionString)).rejects.toThrow(/does not exist/);
  });
});
