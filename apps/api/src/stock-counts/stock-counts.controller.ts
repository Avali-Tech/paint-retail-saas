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
  Query,
} from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  approveCountSchema,
  cancelCountSchema,
  listCountsSchema,
  recordCountsSchema,
  startCountSchema,
  submitCountSchema,
  type ApproveCountInput,
  type ListCountsQuery,
  type RecordCountsInput,
  type StartCountInput,
} from './stock-counts.schemas.js';
import {
  StockCountsService,
  type CountListItem,
  type CountView,
  type StoreAccuracy,
} from './stock-counts.service.js';

const id = () => new ParseUUIDPipe();

@Controller('stock-counts')
export class StockCountsController {
  constructor(@Inject(StockCountsService) private readonly counts: StockCountsService) {}

  @Post()
  @RequirePermissions('inventory:manage')
  start(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(startCountSchema)) body: StartCountInput,
  ): Promise<CountView> {
    return this.counts.start(auth, body);
  }

  @Get()
  @RequirePermissions('inventory:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listCountsSchema)) query: ListCountsQuery,
  ): Promise<{ items: CountListItem[]; total: number }> {
    return this.counts.list(auth, query);
  }

  @Get('accuracy')
  @RequirePermissions('inventory:read')
  accuracy(@CurrentAuth() auth: AuthContext): Promise<StoreAccuracy[]> {
    return this.counts.accuracy(auth);
  }

  @Get(':id')
  @RequirePermissions('inventory:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', id()) countId: string): Promise<CountView> {
    return this.counts.get(auth, countId);
  }

  @Post(':id/counts')
  @HttpCode(200)
  @RequirePermissions('inventory:manage')
  record(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) countId: string,
    @Body(new ZodValidationPipe(recordCountsSchema)) body: RecordCountsInput,
  ): Promise<CountView> {
    return this.counts.record(auth, countId, body);
  }

  @Post(':id/submit')
  @HttpCode(200)
  @RequirePermissions('inventory:manage')
  submit(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) countId: string,
    @Body(new ZodValidationPipe(submitCountSchema)) body: { uncountedAsZero: boolean },
  ): Promise<CountView> {
    return this.counts.submit(auth, countId, body.uncountedAsZero);
  }

  @Post(':id/reopen')
  @HttpCode(200)
  @RequirePermissions('inventory:manage')
  reopen(@CurrentAuth() auth: AuthContext, @Param('id', id()) countId: string): Promise<CountView> {
    return this.counts.reopen(auth, countId);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermissions('inventory:manage')
  approve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) countId: string,
    @Body(new ZodValidationPipe(approveCountSchema)) body: ApproveCountInput,
  ): Promise<CountView> {
    return this.counts.approve(auth, countId, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('inventory:manage')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) countId: string,
    @Body(new ZodValidationPipe(cancelCountSchema)) body: { reason: string },
  ): Promise<CountView> {
    return this.counts.cancel(auth, countId, body.reason);
  }
}
