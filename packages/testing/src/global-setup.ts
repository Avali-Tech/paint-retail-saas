import { startTestObjectStorage, type TestObjectStorage } from './object-storage.js';
import { startTestDatabase, type TestDatabase } from './postgres.js';
import { startTestVirusScanner, type TestVirusScanner } from './virus-scanner.js';

/** The part of Vitest's TestProject that global setup uses. */
export interface ProvideTarget {
  provide(
    key: 'databaseUrl' | 'objectStorageEndpoint' | 'virusScannerAddress',
    value: string,
  ): void;
}

export interface Starters {
  database: () => Promise<TestDatabase>;
  objectStorage: () => Promise<TestObjectStorage>;
  virusScanner: () => Promise<TestVirusScanner>;
}

const defaultStarters: Starters = {
  database: startTestDatabase,
  objectStorage: startTestObjectStorage,
  virusScanner: startTestVirusScanner,
};

/**
 * Vitest global setup for the integration suite: starts PostgreSQL, object
 * storage and ClamAV once for the whole run (in parallel), hands their
 * addresses to tests via `inject(...)`, and returns the teardown that stops them.
 */
export default async function globalSetup(
  project: ProvideTarget,
  starters: Starters = defaultStarters,
): Promise<() => Promise<void>> {
  const [database, objectStorage, virusScanner] = await Promise.all([
    starters.database(),
    starters.objectStorage(),
    starters.virusScanner(),
  ]);
  project.provide('databaseUrl', database.connectionString);
  project.provide('objectStorageEndpoint', objectStorage.endpoint);
  project.provide('virusScannerAddress', `${virusScanner.host}:${String(virusScanner.port)}`);
  return async () => {
    await Promise.all([database.stop(), objectStorage.stop(), virusScanner.stop()]);
  };
}
