import { randomUUID } from 'node:crypto';
import { withPgClient } from './pg-client.js';
import type { TestDatabase } from './postgres.js';

/**
 * Creates a new, empty database on the server at `serverUrl`, so a test file
 * can run migrations and write data without affecting other test files.
 * `stop()` drops the database, disconnecting anything still connected.
 */
export async function createIsolatedDatabase(serverUrl: string): Promise<TestDatabase> {
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await withPgClient(serverUrl, (client) => client.query(`CREATE DATABASE "${name}"`));

  const url = new URL(serverUrl);
  url.pathname = `/${name}`;

  return {
    connectionString: url.toString(),
    stop: async () => {
      await withPgClient(serverUrl, (client) =>
        client.query(`DROP DATABASE "${name}" WITH (FORCE)`),
      );
    },
  };
}
