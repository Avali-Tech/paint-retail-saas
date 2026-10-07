import type { DatabaseConnection } from '@paint/db';
import { describe, expect, it } from 'vitest';
import type { AuthContext } from '../auth/auth-context.js';
import { IdentityService } from './identity.service.js';

describe('IdentityService', () => {
  it('passes on database failures other than a taken slug', async () => {
    const down = new Error('connection lost');
    const connection = {
      db: { transaction: () => Promise.reject(down) },
      close: () => Promise.resolve(),
    } as unknown as DatabaseConnection;
    const auth = {
      organization: { id: '00000000-0000-4000-8000-000000000001', name: 'Sharma Paints' },
    } as AuthContext;

    await expect(new IdentityService(connection, null).setSlug(auth, 'sharma-paints')).rejects.toBe(
      down,
    );
  });
});
