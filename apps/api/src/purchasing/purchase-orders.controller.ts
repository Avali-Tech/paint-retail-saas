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
  createPurchaseOrderSchema,
  fromLowStockSchema,
  listPurchaseOrdersSchema,
  reasonSchema,
  type CreatePurchaseOrderInput,
  type FromLowStockInput,
  type ListPurchaseOrdersQuery,
} from './purchasing.schemas.js';
import {
  PurchaseOrdersService,
  type PurchaseOrderPage,
  type PurchaseOrderView,
} from './purchase-orders.service.js';

const id = () => new ParseUUIDPipe();

@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(@Inject(PurchaseOrdersService) private readonly orders: PurchaseOrdersService) {}

  @Post()
  @RequirePermissions('purchasing:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createPurchaseOrderSchema)) body: CreatePurchaseOrderInput,
  ): Promise<PurchaseOrderView> {
    return this.orders.create(auth, body);
  }

  @Post('from-low-stock')
  @RequirePermissions('purchasing:manage')
  fromLowStock(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(fromLowStockSchema)) body: FromLowStockInput,
  ): Promise<PurchaseOrderView> {
    return this.orders.fromLowStock(auth, body);
  }

  @Get()
  @RequirePermissions('purchasing:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listPurchaseOrdersSchema)) query: ListPurchaseOrdersQuery,
  ): Promise<PurchaseOrderPage> {
    return this.orders.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('purchasing:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
  ): Promise<PurchaseOrderView> {
    return this.orders.get(auth, orderId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('purchasing:manage')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<PurchaseOrderView> {
    return this.orders.cancel(auth, orderId, body.reason);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermissions('purchasing:manage')
  close(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(reasonSchema)) body: { reason: string },
  ): Promise<PurchaseOrderView> {
    return this.orders.close(auth, orderId, body.reason);
  }
}
