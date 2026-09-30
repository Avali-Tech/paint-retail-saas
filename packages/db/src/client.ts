import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseConnection {
  readonly db: Database;
  /** Closes every pooled connection. Call once when the app shuts down. */
  readonly close: () => Promise<void>;
}

/** Opens a pooled connection to PostgreSQL. */
export function createDatabase(connectionString: string): DatabaseConnection {
  const pool = new pg.Pool({ connectionString });
  return {
    db: drizzle({ client: pool, schema }),
    close: () => pool.end(),
  };
}
