import 'reflect-metadata';
import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { runAsMember } from '@paint/db';
import { Observable } from 'rxjs';
import type { AuthenticatedRequest } from '../auth/auth-context.js';

/**
 * Runs each signed-in request on behalf of its member, so database audit
 * triggers record who made every change.
 */
@Injectable()
export class ActorInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const { auth } = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!auth) return next.handle();
    return new Observable((subscriber) =>
      runAsMember(auth.memberId, () => next.handle().subscribe(subscriber)),
    );
  }
}
