import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { operatorFromRequest } from './platform.guard.js';

describe('operatorFromRequest', () => {
  it('returns the operator PlatformGuard attached', () => {
    const operator = { sessionId: 's', userId: 'u', fullName: 'Ops' };

    expect(operatorFromRequest({ headers: {}, operator })).toBe(operator);
  });

  it('refuses a request without one', () => {
    expect(() => operatorFromRequest({ headers: {} })).toThrow(UnauthorizedException);
  });
});
