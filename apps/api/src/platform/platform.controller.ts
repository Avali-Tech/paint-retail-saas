import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  PlatformAuthService,
  type Operator,
  type PlatformSession,
  type PlatformPending,
} from './platform-auth.service.js';
import { CurrentOperator, PlatformGuard } from './platform.guard.js';
import {
  bootstrapSchema,
  createTenantSchema,
  listTenantsSchema,
  platformLoginSchema,
  reasonSchema,
  updateTenantSchema,
  type BootstrapInput,
  type CreateTenantInput,
  type ListTenantsQuery,
  type PlatformLoginInput,
  type UpdateTenantInput,
} from './platform.schemas.js';
import { TenantsService, type TenantDetail, type TenantView } from './tenants.service.js';
import { pendingCodeSchema, pendingSchema } from '../auth/two-factor.schemas.js';
import {
  extendTrialSchema,
  type ExtendTrialInput,
} from '../subscriptions/subscriptions.schemas.js';
import type { Enrolment } from '../auth/two-factor.service.js';

const id = () => new ParseUUIDPipe();

/** Sign-in to the platform console; not for businesses. */
@Public()
@Controller('platform')
export class PlatformAuthController {
  constructor(@Inject(PlatformAuthService) private readonly platformAuth: PlatformAuthService) {}

  /** Creates the first operator with the server's bootstrap token. */
  @Post('bootstrap')
  bootstrap(
    @Body(new ZodValidationPipe(bootstrapSchema)) body: BootstrapInput,
  ): Promise<PlatformSession> {
    return this.platformAuth.bootstrap(body);
  }

  /** The password; answers a two-factor challenge (operators always use an authenticator app). */
  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(platformLoginSchema)) body: PlatformLoginInput,
  ): Promise<PlatformPending> {
    return this.platformAuth.login(body);
  }

  /** First sign-in: adds the authenticator app (scan the URI as a QR code). */
  @Post('login/2fa/setup')
  @HttpCode(200)
  setUpTwoFactor(
    @Body(new ZodValidationPipe(pendingSchema)) body: { pendingToken: string },
  ): Promise<Enrolment> {
    return this.platformAuth.setUpTwoFactor(body.pendingToken);
  }

  @Post('login/2fa')
  @HttpCode(200)
  completeTwoFactor(
    @Body(new ZodValidationPipe(pendingCodeSchema)) body: { pendingToken: string; code: string },
  ): Promise<PlatformSession & { recoveryCodes?: string[] }> {
    return this.platformAuth.completeTwoFactor(body.pendingToken, body.code);
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(PlatformGuard)
  logout(@CurrentOperator() operator: Operator): Promise<void> {
    return this.platformAuth.logout(operator.sessionId);
  }
}

/** The SaaS operator's console: businesses, plans, features, suspension. */
@Public()
@UseGuards(PlatformGuard)
@Controller('platform/tenants')
export class TenantsController {
  constructor(@Inject(TenantsService) private readonly tenants: TenantsService) {}

  @Get()
  list(
    @Query(new ZodValidationPipe(listTenantsSchema)) query: ListTenantsQuery,
  ): Promise<{ items: TenantView[]; total: number }> {
    return this.tenants.list(query);
  }

  @Post()
  create(
    @Body(new ZodValidationPipe(createTenantSchema)) body: CreateTenantInput,
  ): Promise<TenantDetail> {
    return this.tenants.create(body);
  }

  @Get(':id')
  get(@Param('id', id()) tenantId: string): Promise<TenantDetail> {
    return this.tenants.get(tenantId);
  }

  @Patch(':id')
  update(
    @Param('id', id()) tenantId: string,
    @Body(new ZodValidationPipe(updateTenantSchema)) body: UpdateTenantInput,
    @CurrentOperator() operator: Operator,
  ): Promise<TenantDetail> {
    return this.tenants.update(tenantId, body, operator.userId);
  }

  @Post(':id/extend-trial')
  @HttpCode(200)
  extendTrial(
    @Param('id', id()) tenantId: string,
    @Body(new ZodValidationPipe(extendTrialSchema)) body: ExtendTrialInput,
  ): Promise<TenantDetail> {
    return this.tenants.extendTrial(tenantId, body.days);
  }

  @Post(':id/suspend')
  @HttpCode(200)
  suspend(
    @Param('id', id()) tenantId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<TenantDetail> {
    return this.tenants.suspend(tenantId, body.reason);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  reactivate(@Param('id', id()) tenantId: string): Promise<TenantDetail> {
    return this.tenants.reactivate(tenantId);
  }
}
