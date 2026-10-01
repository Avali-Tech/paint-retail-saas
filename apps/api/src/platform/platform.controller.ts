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

  @Post('login')
  @HttpCode(200)
  login(
    @Body(new ZodValidationPipe(platformLoginSchema)) body: PlatformLoginInput,
  ): Promise<PlatformSession> {
    return this.platformAuth.login(body);
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
  ): Promise<TenantDetail> {
    return this.tenants.update(tenantId, body);
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
