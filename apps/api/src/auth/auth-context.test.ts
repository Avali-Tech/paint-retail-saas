import { describe, expect, it } from 'vitest';
import { sampleAuth } from '../test-support/sample-auth.js';
import { authFromRequest, toProfile } from './auth-context.js';

describe('toProfile', () => {
  it('turns the auth context into a JSON-friendly profile with sorted lists', () => {
    expect(toProfile(sampleAuth)).toEqual({
      user: sampleAuth.user,
      organization: sampleAuth.organization,
      role: sampleAuth.role,
      permissions: ['members:read', 'stores:read'],
      allStores: false,
      storeIds: ['store-a', 'store-b'],
    });
  });

  it('does not expose the session or member ids', () => {
    expect(JSON.stringify(toProfile(sampleAuth))).not.toMatch(/session-1|member-1/);
  });
});

describe('authFromRequest', () => {
  it('returns the context attached by the guard', () => {
    expect(authFromRequest({ auth: sampleAuth })).toBe(sampleAuth);
  });

  it('fails loudly when used on a route without a signed-in user', () => {
    expect(() => authFromRequest({})).toThrow(/@Public/);
  });
});
