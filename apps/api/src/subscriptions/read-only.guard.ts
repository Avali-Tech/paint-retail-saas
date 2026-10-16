import 'reflect-metadata';
import {
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../auth/auth-context.js';
import { SubscriptionsService } from './subscriptions.service.js';

export const ALLOW_WHEN_READ_ONLY = 'subscriptions:allowWhenReadOnly';

/** A route a read-only business may still use to change things: paying, signing in and out. */
export const AllowWhenReadOnly = () => SetMetadata(ALLOW_WHEN_READ_ONLY, true);

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * A business whose trial ended, whose subscription ended, or whose payment is past
 * its grace period is read-only: members still see everything and the owner can
 * pay, but no new sales, invoices or any other change. Runs after AuthGuard.
 */
@Injectable()
export class ReadOnlyGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest & { method: string }>();
    const { auth } = request;
    // Public and platform routes have no member; support sessions are read-only anyway.
    if (READS.has(request.method) || !auth || auth.supportGrantId !== undefined) return true;
    const allowed = this.reflector.getAllAndOverride<boolean | undefined>(ALLOW_WHEN_READ_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (allowed) return true;
    const state = await this.subscriptions.accessState(auth.organization.id);
    if (!state.readOnly) return true;
    throw new ForbiddenException({
      statusCode: 403,
      code: 'subscription_read_only',
      status: state.status,
      message: SubscriptionsService.readOnlyMessage(state),
    });
  }
}
