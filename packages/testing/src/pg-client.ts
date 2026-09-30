import pg from 'pg';

/**
 * Opens a connection, runs `work` with it, and always closes the connection,
 * even when `work` throws.
 */
export async function withPgClient<T>(
  connectionString: string,
  work: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
