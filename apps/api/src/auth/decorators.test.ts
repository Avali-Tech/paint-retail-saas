import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { sampleAuth } from '../test-support/sample-auth.js';
import {
  IS_PUBLIC,
  Public,
  REQUIRED_PERMISSIONS,
  RequirePermissions,
  currentAuth,
} from './decorators.js';

const httpContext = (request: object) =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

describe('Public', () => {
  it('marks a controller as public', () => {
    class Example {}
    Public()(Example);

    expect(Reflect.getMetadata(IS_PUBLIC, Example)).toBe(true);
  });
});

describe('RequirePermissions', () => {
  it('records the required permissions', () => {
    class Example {}
    RequirePermissions('stores:read', 'stores:manage')(Example);

    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, Example)).toEqual([
      'stores:read',
      'stores:manage',
    ]);
  });
});

describe('currentAuth', () => {
  it('reads the signed-in user from the request', () => {
    expect(currentAuth(undefined, httpContext({ auth: sampleAuth }))).toBe(sampleAuth);
  });

  it('throws on a request without a signed-in user', () => {
    expect(() => currentAuth(undefined, httpContext({}))).toThrow();
  });
});
