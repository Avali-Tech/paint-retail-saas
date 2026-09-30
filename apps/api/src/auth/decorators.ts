import 'reflect-metadata';
import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission } from '@paint/shared';
import { authFromRequest, type AuthenticatedRequest } from './auth-context.js';

export const IS_PUBLIC = 'auth:isPublic';
export const REQUIRED_PERMISSIONS = 'auth:requiredPermissions';

/** Route or controller reachable without signing in (health checks, sign-in itself). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Route requires every listed permission (403 otherwise). Store-level checks happen in services. */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Reads the signed-in user's AuthContext from the current request. */
export function currentAuth(_data: unknown, context: ExecutionContext) {
  return authFromRequest(context.switchToHttp().getRequest<AuthenticatedRequest>());
}

/** Injects the signed-in user's AuthContext into a route handler parameter. */
export const CurrentAuth = createParamDecorator(currentAuth);
