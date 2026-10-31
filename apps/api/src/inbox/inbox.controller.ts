import 'reflect-metadata';
import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { InboxCount, InboxView } from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { inboxQuerySchema, type InboxQueryInput } from './inbox.schemas.js';
import { InboxService } from './inbox.service.js';

/**
 * The "Needs action" inbox. Every member has one (their follow-ups at least);
 * each queue in it checks its own permissions.
 */
@Controller('inbox')
export class InboxController {
  constructor(@Inject(InboxService) private readonly inbox: InboxService) {}

  @Get()
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(inboxQuerySchema)) query: InboxQueryInput,
  ): Promise<InboxView> {
    return this.inbox.inbox(auth, query);
  }

  @Get('count')
  count(@CurrentAuth() auth: AuthContext): Promise<InboxCount> {
    return this.inbox.count(auth);
  }
}
