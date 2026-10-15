import type { DatabaseConnection } from '@paint/db';
import { describe, expect, it } from 'vitest';
import { AuthService } from './auth.service.js';
import { authSettingsFrom } from './auth.tokens.js';
import { DisabledSmsSender } from './sms.js';
import { TwoFactorService } from './two-factor.service.js';

const failingConnection = (error: unknown) =>
  ({
    db: { transaction: () => Promise.reject(error) },
    close: () => Promise.resolve(),
  }) as unknown as DatabaseConnection;

const settings = authSettingsFrom({
  authSecret: 's'.repeat(32),
  sessionTtlDays: 30,
  signupPlan: 'trial',
  subscriptions: { trialDays: 14 },
});
const service = (connection: DatabaseConnection) =>
  new AuthService(
    connection,
    new DisabledSmsSender(),
    settings,
    new TwoFactorService(connection, settings),
  );

const signupInput = {
  organizationName: 'ABC Paints',
  fullName: 'Kamal Singh',
  phone: '+919800000001',
  password: 'Rangoli@2026',
};

describe('AuthService.signup', () => {
  it('passes unexpected database errors through unchanged (a 500, not a misleading 409)', async () => {
    const outage = new Error('connection lost');

    await expect(service(failingConnection(outage)).signup(signupInput)).rejects.toBe(outage);
  });

  it('does not mistake other unique violations for a duplicate account', async () => {
    const other = { code: '23505', constraint: 'roles_organization_key_unique' };

    await expect(service(failingConnection(other)).signup(signupInput)).rejects.toBe(other);
  });
});
