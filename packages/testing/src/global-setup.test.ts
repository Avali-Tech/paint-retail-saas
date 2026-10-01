import { describe, expect, it, vi } from 'vitest';
import globalSetup from './global-setup.js';

const service = <T extends object>(details: T) => {
  const stop = vi.fn(() => Promise.resolve());
  return { stop, start: vi.fn(() => Promise.resolve({ ...details, stop })) };
};

const services = () => ({
  database: service({ connectionString: 'postgres://test@localhost:5432/test' }),
  storage: service({ endpoint: 'http://localhost:8333' }),
  scanner: service({ host: 'localhost', port: 3310 }),
  mail: service({ smtpUrl: 'smtp://localhost:1025', apiUrl: 'http://localhost:8025' }),
});

describe('globalSetup', () => {
  it('provides each service’s address to tests and returns a teardown that stops them all', async () => {
    const { database, storage, scanner, mail } = services();
    const provide = vi.fn();

    const teardown = await globalSetup(
      { provide },
      {
        database: database.start,
        objectStorage: storage.start,
        virusScanner: scanner.start,
        mailServer: mail.start,
      },
    );

    expect(provide.mock.calls).toEqual([
      ['databaseUrl', 'postgres://test@localhost:5432/test'],
      ['objectStorageEndpoint', 'http://localhost:8333'],
      ['virusScannerAddress', 'localhost:3310'],
      ['mailSmtpUrl', 'smtp://localhost:1025'],
      ['mailApiUrl', 'http://localhost:8025'],
    ]);
    expect(database.stop).not.toHaveBeenCalled();

    await teardown();

    for (const started of [database, storage, scanner, mail]) {
      expect(started.stop).toHaveBeenCalledOnce();
    }
  });

  it('fails without providing anything when a service cannot start', async () => {
    const { database, scanner, mail } = services();
    const provide = vi.fn();

    await expect(
      globalSetup(
        { provide },
        {
          database: database.start,
          objectStorage: () => Promise.reject(new Error('Docker is not running')),
          virusScanner: scanner.start,
          mailServer: mail.start,
        },
      ),
    ).rejects.toThrow('Docker is not running');
    expect(provide).not.toHaveBeenCalled();
  });
});
