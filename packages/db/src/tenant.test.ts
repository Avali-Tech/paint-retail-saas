import { describe, expect, it, vi } from 'vitest';
import type { Database } from './client.js';
import { assertOrganizationId, withTenant } from './tenant.js';

describe('assertOrganizationId', () => {
  it.each(['0b6f8f1e-6a2b-4c1d-9e3f-1a2b3c4d5e6f', '0B6F8F1E-6A2B-4C1D-9E3F-1A2B3C4D5E6F'])(
    'accepts %s',
    (id) => {
      expect(() => {
        assertOrganizationId(id);
      }).not.toThrow();
    },
  );

  it.each([
    '',
    'not-a-uuid',
    '0b6f8f1e6a2b4c1d9e3f1a2b3c4d5e6f',
    "0b6f8f1e-6a2b-4c1d-9e3f-1a2b3c4d5e6f'; DROP TABLE stores; --",
  ])('rejects "%s"', (id) => {
    expect(() => {
      assertOrganizationId(id);
    }).toThrow(TypeError);
  });
});

describe('withTenant', () => {
  it('rejects an invalid organisation id before opening a transaction', async () => {
    const transaction = vi.fn();
    const db = { transaction } as unknown as Database;

    await expect(withTenant(db, 'not-a-uuid', () => Promise.resolve())).rejects.toThrow(TypeError);
    expect(transaction).not.toHaveBeenCalled();
  });
});
