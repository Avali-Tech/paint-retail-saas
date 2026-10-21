import type { DatabaseConnection } from '@paint/db';
import { describe, expect, it } from 'vitest';
import { sampleAuth } from '../test-support/sample-auth.js';
import { MembersService } from './members.service.js';

const failingConnection = (error: unknown) =>
  ({
    db: { transaction: () => Promise.reject(error) },
    close: () => Promise.resolve(),
  }) as unknown as DatabaseConnection;

describe('MembersService.create', () => {
  it('passes unexpected database errors through unchanged', async () => {
    const outage = new Error('connection lost');

    await expect(
      new MembersService(failingConnection(outage)).create(sampleAuth, {
        fullName: 'New Hire',
        phone: '+919800000001',
        roleId: '0b6f8f1e-6a2b-4c1d-9e3f-1a2b3c4d5e6f',
        allStores: false,
        storeIds: [],
        exceptions: { granted: [], denied: [] },
      }),
    ).rejects.toBe(outage);
  });
});
