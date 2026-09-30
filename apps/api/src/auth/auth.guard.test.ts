import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { sampleAuth } from '../test-support/sample-auth.js';
import type { AuthContext } from './auth-context.js';
import { AuthGuard, bearerToken } from './auth.guard.js';
import type { AuthService } from './auth.service.js';

describe('bearerToken', () => {
  it.each([
    ['Bearer abc123', 'abc123'],
    ['bearer abc123', 'abc123'],
    ['  Bearer   abc123  ', 'abc123'],
  ])('reads "%s"', (header, token) => {
    expect(bearerToken(header)).toBe(token);
  });

  it.each([undefined, 123, ['Bearer abc'], '', 'Bearer', 'Basic abc123', 'Bearer a b', 'abc123'])(
    'ignores %o',
    (header) => {
      expect(bearerToken(header)).toBeNull();
    },
  );
});

function setup({
  isPublic = false,
  auth = sampleAuth,
}: { isPublic?: boolean; auth?: AuthContext | null } = {}) {
  const reflector = { getAllAndOverride: vi.fn(() => isPublic) } as unknown as Reflector;
  const authenticate = vi.fn(() => Promise.resolve(auth));
  const guard = new AuthGuard(reflector, { authenticate } as unknown as AuthService);
  const context = (headers: Record<string, unknown>) => {
    const request: Record<string, unknown> = { headers };
    const executionContext = {
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { request, executionContext };
  };
  return { guard, authenticate, context };
}

describe('AuthGuard', () => {
  it('lets public routes through without looking for a token', async () => {
    const { guard, authenticate, context } = setup({ isPublic: true });

    await expect(guard.canActivate(context({}).executionContext)).resolves.toBe(true);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('attaches the signed-in member for a valid token', async () => {
    const { guard, authenticate, context } = setup();
    const { request, executionContext } = context({ authorization: 'Bearer good-token' });

    await expect(guard.canActivate(executionContext)).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledWith('good-token');
    expect(request.auth).toBe(sampleAuth);
  });

  it('answers 401 without a token, without asking the database', async () => {
    const { guard, authenticate, context } = setup();

    await expect(guard.canActivate(context({}).executionContext)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('answers 401 for a token that is not valid', async () => {
    const { guard, context } = setup({ auth: null });

    await expect(
      guard.canActivate(context({ authorization: 'Bearer expired' }).executionContext),
    ).rejects.toThrow(UnauthorizedException);
  });
});
