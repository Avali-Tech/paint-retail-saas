import { describe, expect, it } from 'vitest';
import { authSettingsFrom } from './auth.tokens.js';

describe('authSettingsFrom', () => {
  it('turns config into auth settings with safe OTP limits', () => {
    expect(authSettingsFrom({ authSecret: 's'.repeat(32), sessionTtlDays: 30 })).toEqual({
      secret: 's'.repeat(32),
      sessionTtlMs: 30 * 86_400_000,
      otpTtlMs: 300_000,
      otpMaxAttempts: 5,
      otpResendCooldownMs: 30_000,
      otpMaxPerHour: 5,
    });
  });
});
