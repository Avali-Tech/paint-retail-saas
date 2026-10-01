import { describe, expect, it, vi } from 'vitest';
import globalSetup from './global-setup.js';

const service = <T extends object>(details: T) => {
  const stop = vi.fn(() => Promise.resolve());
  return { stop, start: vi.fn(() => Promise.resolve({ ...details, stop })) };
};

describe('globalSetup', () => {
  it('provides each service’s address to tests and returns a teardown that stops them all', async () => {
    const database = service({ connectionString: 'postgres://test@localhost:5432/test' });
    const storage = service({ endpoint: 'http://localhost:8333' });
    const scanner = service({ host: 'localhost', port: 3310 });
    const provide = vi.fn();

    const teardown = await globalSetup(
      { provide },
      { database: database.start, objectStorage: storage.start, virusScanner: scanner.start },
    );

    expect(provide.mock.calls).toEqual([
      ['databaseUrl', 'postgres://test@localhost:5432/test'],
      ['objectStorageEndpoint', 'http://localhost:8333'],
      ['virusScannerAddress', 'localhost:3310'],
    ]);
    expect(database.stop).not.toHaveBeenCalled();

    await teardown();

    for (const started of [database, storage, scanner]) expect(started.stop).toHaveBeenCalledOnce();
  });

  it('fails without providing anything when a service cannot start', async () => {
    const database = service({ connectionString: 'postgres://x' });
    const scanner = service({ host: 'localhost', port: 3310 });
    const provide = vi.fn();

    await expect(
      globalSetup(
        { provide },
        {
          database: database.start,
          objectStorage: () => Promise.reject(new Error('Docker is not running')),
          virusScanner: scanner.start,
        },
      ),
    ).rejects.toThrow('Docker is not running');
    expect(provide).not.toHaveBeenCalled();
  });
});
