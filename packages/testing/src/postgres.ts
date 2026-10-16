import { PostgreSqlContainer } from '@testcontainers/postgresql';

/** Same major version we run in production (Amazon RDS for PostgreSQL 17). */
export const POSTGRES_IMAGE = 'postgres:17-alpine';

/**
 * Lock slots per connection. PostgreSQL's shared lock table holds this many times
 * max_connections (100) locks for every session together. Migrations run in one
 * transaction and lock each table, index and TOAST relation they create (roughly 800–1,000 at
 * migration 0087, growing every round), and the integration suite migrates a fresh
 * database per test file, several at once: at the default 64 (6,400 slots) a handful of
 * parallel migrations or bulk seeds failed with "out of shared memory, You might need to
 * increase max_locks_per_transaction". 256 gives 25,600 slots (a few MB of memory).
 */
export const MAX_LOCKS_PER_TRANSACTION = 256;

export interface TestDatabase {
  /** postgres:// URL for connecting to the throwaway database. */
  readonly connectionString: string;
  /** Stops and removes the container. */
  stop(): Promise<void>;
}

/** Starts a throwaway PostgreSQL in Docker for integration tests. */
export async function startTestDatabase(image: string = POSTGRES_IMAGE): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(image)
    .withCommand([
      'postgres',
      '-c',
      `max_locks_per_transaction=${String(MAX_LOCKS_PER_TRANSACTION)}`,
    ])
    .start();
  return {
    connectionString: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
