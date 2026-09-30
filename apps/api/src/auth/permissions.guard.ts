import 'reflect-metadata';
import {
  ForbiddenException,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Permission } from '@paint/shared';
import type { AuthenticatedRequest } from './auth-context.js';
import { REQUIRED_PERMISSIONS } from './decorators.js';

/** Enforces @RequirePermissions(...). Runs after AuthGuard. */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];
    if (required.length === 0) return true;

    const { auth } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (auth && required.every((permission) => can(auth, permission))) return true;
    throw new ForbiddenException('You do not have permission to do this');
  }
}
