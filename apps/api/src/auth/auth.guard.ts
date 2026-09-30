import 'reflect-metadata';
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from './auth-context.js';
import { AuthService } from './auth.service.js';
import { IS_PUBLIC } from './decorators.js';

/** Extracts the token from an "Authorization: Bearer <token>" header. */
export function bearerToken(header: unknown): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Runs on every request: routes are private unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuthService) private readonly authService: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<AuthenticatedRequest & { headers: Record<string, unknown> }>();
    const token = bearerToken(request.headers.authorization);
    const auth = token ? await this.authService.authenticate(token) : null;
    if (!auth) throw new UnauthorizedException('Sign in to continue');

    request.auth = auth;
    return true;
  }
}
