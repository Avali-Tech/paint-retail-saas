import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

/** The handle passed to work inside `db.transaction(...)`. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseConnection {
  readonly db: Database;
  /** Closes every pooled connection. Call once when the app shuts down. */
  readonly close: () => Promise<void>;
}

export interface DatabaseOptions {
  /** How long to wait for a new connection before failing. Default 5 seconds. */
  readonly connectionTimeoutMillis?: number;
}

/** Opens a pooled connection to PostgreSQL. */
export function createDatabase(
  connectionString: string,
  { connectionTimeoutMillis = 5_000 }: DatabaseOptions = {},
): DatabaseConnection {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis });
  return {
    db: drizzle({ client: pool, schema }),
    close: () => pool.end(),
  };
}
