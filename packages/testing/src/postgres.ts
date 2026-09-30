import { PostgreSqlContainer } from '@testcontainers/postgresql';

/** Same major version we run in production (Amazon RDS for PostgreSQL 17). */
export const POSTGRES_IMAGE = 'postgres:17-alpine';

export interface TestDatabase {
  /** postgres:// URL for connecting to the throwaway database. */
  readonly connectionString: string;
  /** Stops and removes the container. */
  stop(): Promise<void>;
}

/** Starts a throwaway PostgreSQL in Docker for integration tests. */
export async function startTestDatabase(image: string = POSTGRES_IMAGE): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(image).start();
  return {
    connectionString: container.getConnectionUri(),
    stop: async () => {
      await container.stop();
    },
  };
}
