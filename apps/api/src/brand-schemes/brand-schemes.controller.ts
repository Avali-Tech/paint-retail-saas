import 'reflect-metadata';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { withTenant, type DatabaseConnection } from '@paint/db';
import type {
  BenefitReceiptView,
  BrandClaimView,
  PriceHikePlanView,
  SchemeClaimsReport,
  SchemeDetail,
  SchemeSummary,
  SchemesOverview,
  SchemeView,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { idempotencyKeySchema } from '../billing/billing.schemas.js';
import { IdempotencyKey } from '../billing/idempotency.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE } from '../database/database.module.js';
import {
  asOfSchema,
  claimSchema,
  claimStatusSchema,
  endSchemeSchema,
  listSchemesSchema,
  priceHikeSchema,
  receiptSchema,
  schemeSchema,
  type AsOfQuery,
  type ClaimBody,
  type ClaimStatusBody,
  type EndSchemeBody,
  type ListSchemesQuery,
  type PriceHikeBody,
  type ReceiptBody,
  type SchemeBody,
} from './brand-schemes.schemas.js';
import { BrandSchemesService } from './brand-schemes.service.js';
import { planPriceHike } from './price-hike.js';

const id = () => new ParseUUIDPipe();

/**
 * Brand schemes, targets and rebates (P2-M33): anyone who may see purchasing sees
 * schemes, their progress and claims; owners and admins (`schemes:manage`) enter
 * schemes, record what the brand issued and follow claims up.
 */
@Controller('brand-schemes')
export class BrandSchemesController {
  constructor(
    @Inject(BrandSchemesService) private readonly schemes: BrandSchemesService,
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
  ) {}

  @Get()
  @RequirePermissions('purchasing:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listSchemesSchema)) query: ListSchemesQuery,
  ): Promise<SchemeSummary[]> {
    return this.schemes.list(auth, query);
  }

  @Get('overview')
  @RequirePermissions('purchasing:read')
  overview(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(asOfSchema)) query: AsOfQuery,
  ): Promise<SchemesOverview> {
    return this.schemes.overview(auth, query.asOf);
  }

  @Get('claims')
  @RequirePermissions('purchasing:read')
  claims(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(asOfSchema)) query: AsOfQuery,
  ): Promise<SchemeClaimsReport> {
    return this.schemes.claims(auth, query);
  }

  @Post('price-hike-plan')
  @HttpCode(200)
  @RequirePermissions('purchasing:read', 'costs:read')
  plan(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(priceHikeSchema)) body: PriceHikeBody,
  ): Promise<PriceHikePlanView> {
    return withTenant(this.connection.db, auth.organization.id, (tx) =>
      planPriceHike(tx, auth, body),
    );
  }

  @Post('claims/:claimId/status')
  @HttpCode(200)
  @RequirePermissions('schemes:manage')
  claimStatus(
    @CurrentAuth() auth: AuthContext,
    @Param('claimId', id()) claimId: string,
    @Body(new ZodValidationPipe(claimStatusSchema)) body: ClaimStatusBody,
  ): Promise<BrandClaimView> {
    return this.schemes.setClaimStatus(auth, claimId, body);
  }

  @Get(':id')
  @RequirePermissions('purchasing:read')
  detail(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) schemeId: string,
    @Query(new ZodValidationPipe(asOfSchema)) query: AsOfQuery,
  ): Promise<SchemeDetail> {
    return this.schemes.detail(auth, schemeId, query.asOf);
  }

  @Post()
  @RequirePermissions('schemes:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(schemeSchema)) body: SchemeBody,
  ): Promise<SchemeView> {
    return this.schemes.create(auth, body);
  }

  @Put(':id')
  @RequirePermissions('schemes:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) schemeId: string,
    @Body(new ZodValidationPipe(schemeSchema)) body: SchemeBody,
  ): Promise<SchemeView> {
    return this.schemes.update(auth, schemeId, body);
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermissions('schemes:manage')
  activate(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) schemeId: string,
  ): Promise<SchemeView> {
    return this.schemes.activate(auth, schemeId);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('schemes:manage')
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) schemeId: string,
    @Body(new ZodValidationPipe(endSchemeSchema)) body: EndSchemeBody,
  ): Promise<SchemeView> {
    return this.schemes.end(auth, schemeId, 'closed', body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('schemes:manage')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) schemeId: string,
    @Body(new ZodValidationPipe(endSchemeSchema)) body: EndSchemeBody,
  ): Promise<SchemeView> {
    return this.schemes.end(auth, schemeId, 'cancelled', body);
  }

  @Post(':id/receipts')
  @RequirePermissions('schemes:manage')
  recordReceipt(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) schemeId: string,
    @Body(new ZodValidationPipe(receiptSchema)) body: ReceiptBody,
    @IdempotencyKey(new ZodValidationPipe(idempotencyKeySchema)) idempotencyKey: string | undefined,
  ): Promise<BenefitReceiptView> {
    return this.schemes.recordReceipt(auth, schemeId, body, idempotencyKey);
  }

  @Post(':id/claims')
  @RequirePermissions('schemes:manage')
  fileClaim(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) schemeId: string,
    @Body(new ZodValidationPipe(claimSchema)) body: ClaimBody,
  ): Promise<BrandClaimView> {
    return this.schemes.fileClaim(auth, schemeId, body);
  }
}
