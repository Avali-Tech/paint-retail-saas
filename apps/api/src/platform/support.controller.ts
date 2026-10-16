import 'reflect-metadata';
import { AllowWhenReadOnly } from '../subscriptions/read-only.guard.js';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, Public, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import type { Operator } from './platform-auth.service.js';
import { CurrentOperator, PlatformGuard } from './platform.guard.js';
import {
  listGrantsSchema,
  supportRequestSchema,
  type SupportRequestInput,
} from './platform.schemas.js';
import { SupportService, type AccessLogEntry, type GrantView } from './support.service.js';

const id = () => new ParseUUIDPipe();

/** The platform side of support access. */
@Public()
@UseGuards(PlatformGuard)
@Controller('platform')
export class PlatformSupportController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Post('tenants/:id/support-requests')
  request(
    @CurrentOperator() operator: Operator,
    @Param('id', id()) tenantId: string,
    @Body(new ZodValidationPipe(supportRequestSchema)) body: SupportRequestInput,
  ): Promise<GrantView> {
    return this.support.request(operator, tenantId, body);
  }

  @Get('support-grants')
  list(
    @Query(new ZodValidationPipe(listGrantsSchema)) query: { tenantId?: string },
  ): Promise<GrantView[]> {
    return this.support.listForPlatform(query.tenantId);
  }

  /** Signs the operator into the business, read-only, until the grant ends. */
  @Post('support-grants/:id/session')
  session(
    @CurrentOperator() operator: Operator,
    @Param('id', id()) grantId: string,
  ): ReturnType<SupportService['startSession']> {
    return this.support.startSession(operator, grantId);
  }

  @Post('support-grants/:id/end')
  @HttpCode(200)
  end(@Param('id', id()) grantId: string): Promise<GrantView> {
    return this.support.endForPlatform(grantId);
  }
}

/** The business side: decide, end and review support access. */
// A read-only business can still let platform support look in, to help it.
@AllowWhenReadOnly()
@Controller('support-requests')
export class SupportRequestsController {
  constructor(@Inject(SupportService) private readonly support: SupportService) {}

  @Get()
  @RequirePermissions('organization:manage')
  list(@CurrentAuth() auth: AuthContext): Promise<GrantView[]> {
    return this.support.listForBusiness(auth);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('organization:manage')
  approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) grantId: string,
  ): Promise<GrantView> {
    return this.support.approve(auth, grantId);
  }

  @Post(':id/decline')
  @HttpCode(200)
  @RequirePermissions('organization:manage')
  decline(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) grantId: string,
  ): Promise<GrantView> {
    return this.support.decline(auth, grantId);
  }

  @Post(':id/end')
  @HttpCode(200)
  @RequirePermissions('organization:manage')
  end(@CurrentAuth() auth: AuthContext, @Param('id', id()) grantId: string): Promise<GrantView> {
    return this.support.endForBusiness(auth, grantId);
  }

  /** Every request support made with this access. */
  @Get(':id/activity')
  @RequirePermissions('organization:manage')
  activity(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) grantId: string,
  ): Promise<AccessLogEntry[]> {
    return this.support.activity(auth, grantId);
  }
}
