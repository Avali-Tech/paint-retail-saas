import { startTestDatabase, type TestDatabase } from './postgres.js';

/** The part of Vitest's TestProject that global setup uses. */
export interface ProvideTarget {
  provide(key: 'databaseUrl', value: string): void;
}

/**
 * Vitest global setup for the integration suite: starts one PostgreSQL for the
 * whole run, hands its URL to tests via `inject('databaseUrl')`, and returns
 * the teardown that stops it.
 */
export default async function globalSetup(
  project: ProvideTarget,
  start: () => Promise<TestDatabase> = startTestDatabase,
): Promise<() => Promise<void>> {
  const database = await start();
  project.provide('databaseUrl', database.connectionString);
  return () => database.stop();
}
