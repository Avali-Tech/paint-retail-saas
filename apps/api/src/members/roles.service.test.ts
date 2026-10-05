import type { DatabaseConnection } from '@paint/db';
import { describe, expect, it } from 'vitest';
import { sampleAuth } from '../test-support/sample-auth.js';
import { RolesService } from './roles.service.js';

const failingConnection = (error: unknown) =>
  ({
    db: { transaction: () => Promise.reject(error) },
    close: () => Promise.resolve(),
  }) as unknown as DatabaseConnection;

const auth = {
  ...sampleAuth,
  organization: { id: '0b6f8f1e-6a2b-4c1d-9e3f-1a2b3c4d5e6f', name: 'ABC' },
};
const input = { name: 'Cashier', permissions: ['stores:read' as const] };

describe('RolesService.create', () => {
  it('asks to try again in the unlikely case the generated key is taken', async () => {
    const clash = { code: '23505', constraint: 'roles_organization_key_unique' };

    await expect(new RolesService(failingConnection(clash)).create(auth, input)).rejects.toThrow(
      /try again/,
    );
  });

  it('passes unexpected database errors through unchanged', async () => {
    const outage = new Error('connection lost');

    await expect(new RolesService(failingConnection(outage)).create(auth, input)).rejects.toBe(
      outage,
    );
  });
});
