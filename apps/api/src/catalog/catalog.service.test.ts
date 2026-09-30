import type { DatabaseConnection } from '@paint/db';
import { describe, expect, it } from 'vitest';
import { sampleAuth } from '../test-support/sample-auth.js';
import { CatalogService } from './catalog.service.js';

const failingConnection = (error: unknown) =>
  ({
    db: { transaction: () => Promise.reject(error) },
    close: () => Promise.resolve(),
  }) as unknown as DatabaseConnection;

const auth = {
  ...sampleAuth,
  organization: { id: '0b6f8f1e-6a2b-4c1d-9e3f-1a2b3c4d5e6f', name: 'ABC' },
};

describe('CatalogService', () => {
  it('passes unexpected database errors through unchanged', async () => {
    const outage = new Error('connection lost');

    await expect(new CatalogService(failingConnection(outage)).listBrands(auth)).rejects.toBe(
      outage,
    );
  });

  it('passes through unique violations it has no message for', async () => {
    const unknown = { code: '23505', constraint: 'some_future_unique' };

    await expect(new CatalogService(failingConnection(unknown)).listBrands(auth)).rejects.toBe(
      unknown,
    );
  });
});
