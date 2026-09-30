import type { DatabaseConnection } from '@paint/db';
import { describe, expect, it } from 'vitest';
import { sampleAuth } from '../test-support/sample-auth.js';
import { StoresService } from './stores.service.js';

const failingConnection = (error: unknown) =>
  ({
    db: { transaction: () => Promise.reject(error) },
    close: () => Promise.resolve(),
  }) as unknown as DatabaseConnection;

describe('StoresService.create', () => {
  it('passes unexpected database errors through unchanged', async () => {
    const outage = new Error('connection lost');
    const stores = new StoresService(failingConnection(outage));

    await expect(
      stores.create(
        {
          ...sampleAuth,
          organization: { id: '0b6f8f1e-6a2b-4c1d-9e3f-1a2b3c4d5e6f', name: 'ABC' },
        },
        { name: 'Hyderabad', code: 'HYD', type: 'store' },
      ),
    ).rejects.toBe(outage);
  });
});
