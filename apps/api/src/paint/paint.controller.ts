import 'reflect-metadata';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type {
  EstimatePage,
  EstimateView,
  QuotationView,
  TintRecordPage,
  TintRecordView,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { idempotencyKeySchema } from '../billing/billing.schemas.js';
import { IdempotencyKey } from '../billing/idempotency.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { EstimatesService } from './estimates.service.js';
import {
  convertEstimateSchema,
  estimateSchema,
  listEstimatesSchema,
  listTintRecordsSchema,
  tintRecordSchema,
  type ConvertEstimateInput,
  type EstimateInput,
  type ListEstimatesQuery,
  type ListTintRecordsQuery,
  type TintRecordInput,
} from './paint.schemas.js';
import { TintRecordsService } from './tint-records.service.js';

const id = () => new ParseUUIDPipe();
const key = () => new ZodValidationPipe(idempotencyKeySchema);

/**
 * Tint records and the shade history (spec §5.1, §6.3). Writing needs
 * `sales:manage` for quotation and order lines and `billing:issue` for
 * invoice lines (TINT_PERMISSION), checked by the service from the line kind.
 */
@Controller('tint-records')
export class TintRecordsController {
  constructor(@Inject(TintRecordsService) private readonly tints: TintRecordsService) {}

  @Post()
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(tintRecordSchema)) body: TintRecordInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<TintRecordView> {
    return this.tints.create(auth, body, idempotencyKey);
  }

  @Get()
  @RequirePermissions('sales:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listTintRecordsSchema)) query: ListTintRecordsQuery,
  ): Promise<TintRecordPage> {
    return this.tints.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('sales:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) tintId: string,
  ): Promise<TintRecordView> {
    return this.tints.get(auth, tintId);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', id()) tintId: string): Promise<void> {
    return this.tints.remove(auth, tintId);
  }
}

/** Paint estimates (spec §5.1, §6.2), the estimator that prices them and their conversion into a quotation. */
@Controller('estimates')
export class EstimatesController {
  constructor(@Inject(EstimatesService) private readonly estimates: EstimatesService) {}

  @Post()
  @RequirePermissions('sales:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(estimateSchema)) body: EstimateInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<EstimateView> {
    return this.estimates.create(auth, body, idempotencyKey);
  }

  @Get()
  @RequirePermissions('sales:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listEstimatesSchema)) query: ListEstimatesQuery,
  ): Promise<EstimatePage> {
    return this.estimates.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('sales:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) estimateId: string,
  ): Promise<EstimateView> {
    return this.estimates.get(auth, estimateId);
  }

  @Put(':id')
  @RequirePermissions('sales:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) estimateId: string,
    @Body(new ZodValidationPipe(estimateSchema)) body: EstimateInput,
  ): Promise<EstimateView> {
    return this.estimates.update(auth, estimateId, body);
  }

  /** Runs the estimator for every option of a draft and stores the results (round 5b). */
  @Post(':id/compute')
  @HttpCode(200)
  @RequirePermissions('sales:manage')
  compute(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) estimateId: string,
  ): Promise<EstimateView> {
    return this.estimates.compute(auth, estimateId);
  }

  /** The chosen tier's computed lines become a draft quotation (round 5b). */
  @Post(':id/convert')
  @RequirePermissions('sales:manage')
  convert(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) estimateId: string,
    @Body(new ZodValidationPipe(convertEstimateSchema)) body: ConvertEstimateInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<QuotationView> {
    return this.estimates.convert(auth, estimateId, body, idempotencyKey);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('sales:manage')
  remove(@CurrentAuth() auth: AuthContext, @Param('id', id()) estimateId: string): Promise<void> {
    return this.estimates.remove(auth, estimateId);
  }
}
