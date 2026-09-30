import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { Permission } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import { sampleAuth } from '../test-support/sample-auth.js';
import { PermissionsGuard } from './permissions.guard.js';

function check(required: Permission[] | undefined, request: object): boolean {
  const reflector = { getAllAndOverride: () => required } as unknown as Reflector;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return new PermissionsGuard(reflector).canActivate(context);
}

describe('PermissionsGuard', () => {
  it('allows routes that require nothing', () => {
    expect(check(undefined, {})).toBe(true);
    expect(check([], {})).toBe(true);
  });

  it('allows a member holding every required permission', () => {
    expect(check(['stores:read', 'members:read'], { auth: sampleAuth })).toBe(true);
  });

  it('answers 403 when any required permission is missing', () => {
    expect(() => check(['stores:read', 'stores:manage'], { auth: sampleAuth })).toThrow(
      ForbiddenException,
    );
  });

  it('answers 403 when there is no signed-in member', () => {
    expect(() => check(['stores:read'], {})).toThrow(ForbiddenException);
  });
});
