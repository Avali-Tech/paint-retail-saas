import 'reflect-metadata';
import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import {
  GoodsReceiptsService,
  type GoodsReceiptPage,
  type GoodsReceiptView,
} from './goods-receipts.service.js';
import {
  createGoodsReceiptSchema,
  listGoodsReceiptsSchema,
  type CreateGoodsReceiptInput,
  type ListGoodsReceiptsQuery,
} from './purchasing.schemas.js';

@Controller('goods-receipts')
export class GoodsReceiptsController {
  constructor(@Inject(GoodsReceiptsService) private readonly receipts: GoodsReceiptsService) {}

  @Post()
  @RequirePermissions('purchasing:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createGoodsReceiptSchema)) body: CreateGoodsReceiptInput,
  ): Promise<GoodsReceiptView> {
    return this.receipts.create(auth, body);
  }

  @Get()
  @RequirePermissions('purchasing:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listGoodsReceiptsSchema)) query: ListGoodsReceiptsQuery,
  ): Promise<GoodsReceiptPage> {
    return this.receipts.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('purchasing:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) receiptId: string,
  ): Promise<GoodsReceiptView> {
    return this.receipts.get(auth, receiptId);
  }
}
