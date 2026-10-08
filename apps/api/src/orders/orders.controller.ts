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
  DispatchView,
  GoLivePreview,
  GoLiveResult,
  InvoiceDispatchesView,
  OrderAvailabilityView,
  OrderCreditView,
  QuotationPage,
  QuotationView,
  SalesOrderPage,
  SalesOrderView,
  StaleReservationPage,
  TaxDocumentView,
} from '@paint/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, RequirePermissions } from '../auth/decorators.js';
import { idempotencyKeySchema } from '../billing/billing.schemas.js';
import { IdempotencyKey } from '../billing/idempotency.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DispatchesService } from './dispatches.service.js';
import { GoLiveService } from './go-live.service.js';
import {
  billOrderSchema,
  cancelLineSchema,
  cancelOrderSchema,
  confirmOrderSchema,
  convertQuotationSchema,
  dispatchSchema,
  goLiveSchema,
  listOrdersSchema,
  listQuotationsSchema,
  quotationSchema,
  releaseOrderSchema,
  reserveOrderSchema,
  salesOrderSchema,
  staleReservationsSchema,
  type BillOrderInput,
  type CancelLineInput,
  type CancelOrderInput,
  type ConfirmOrderInput,
  type ConvertQuotationInput,
  type DispatchInput,
  type GoLiveInput,
  type ListOrdersQuery,
  type ListQuotationsQuery,
  type QuotationInput,
  type ReleaseOrderInput,
  type ReserveOrderInput,
  type SalesOrderInput,
  type StaleReservationsQuery,
} from './orders.schemas.js';
import { QuotationsService } from './quotations.service.js';
import { SalesOrdersService } from './sales-orders.service.js';

const id = () => new ParseUUIDPipe();
const key = () => new ZodValidationPipe(idempotencyKeySchema);

/** Quotations and their versions (spec §5.1, §5.3). */
@Controller('quotations')
export class QuotationsController {
  constructor(@Inject(QuotationsService) private readonly quotations: QuotationsService) {}

  @Post()
  @RequirePermissions('sales:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(quotationSchema)) body: QuotationInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<QuotationView> {
    return this.quotations.create(auth, body, idempotencyKey);
  }

  @Get()
  @RequirePermissions('sales:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listQuotationsSchema)) query: ListQuotationsQuery,
  ): Promise<QuotationPage> {
    return this.quotations.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('sales:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) quotationId: string,
  ): Promise<QuotationView> {
    return this.quotations.get(auth, quotationId);
  }

  @Put(':id')
  @RequirePermissions('sales:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) quotationId: string,
    @Body(new ZodValidationPipe(quotationSchema)) body: QuotationInput,
  ): Promise<QuotationView> {
    return this.quotations.update(auth, quotationId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('sales:manage')
  remove(@CurrentAuth() auth: AuthContext, @Param('id', id()) quotationId: string): Promise<void> {
    return this.quotations.remove(auth, quotationId);
  }

  @Post(':id/send')
  @HttpCode(200)
  @RequirePermissions('sales:manage')
  send(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) quotationId: string,
  ): Promise<QuotationView> {
    return this.quotations.send(auth, quotationId);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @RequirePermissions('sales:manage')
  accept(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) quotationId: string,
  ): Promise<QuotationView> {
    return this.quotations.accept(auth, quotationId);
  }

  @Post(':id/revise')
  @RequirePermissions('sales:manage')
  revise(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) quotationId: string,
  ): Promise<QuotationView> {
    return this.quotations.revise(auth, quotationId);
  }

  @Post(':id/convert')
  @RequirePermissions('sales:manage')
  convert(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) quotationId: string,
    @Body(new ZodValidationPipe(convertQuotationSchema)) body: ConvertQuotationInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<SalesOrderView> {
    return this.quotations.convert(auth, quotationId, body, idempotencyKey);
  }
}

/** Sales orders: confirm with credit check, reservations, billing (spec §4.1–4.4, §5.1). */
@Controller('sales-orders')
export class SalesOrdersController {
  constructor(@Inject(SalesOrdersService) private readonly orders: SalesOrdersService) {}

  @Post()
  @RequirePermissions('sales:manage')
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(salesOrderSchema)) body: SalesOrderInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<SalesOrderView> {
    return this.orders.create(auth, body, idempotencyKey);
  }

  @Get()
  @RequirePermissions('sales:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listOrdersSchema)) query: ListOrdersQuery,
  ): Promise<SalesOrderPage> {
    return this.orders.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions('sales:read')
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
  ): Promise<SalesOrderView> {
    return this.orders.get(auth, orderId);
  }

  @Put(':id')
  @RequirePermissions('sales:manage')
  update(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(salesOrderSchema)) body: SalesOrderInput,
  ): Promise<SalesOrderView> {
    return this.orders.update(auth, orderId, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('sales:manage')
  remove(@CurrentAuth() auth: AuthContext, @Param('id', id()) orderId: string): Promise<void> {
    return this.orders.remove(auth, orderId);
  }

  @Get(':id/credit-check')
  @RequirePermissions('sales:read')
  creditCheck(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
  ): Promise<OrderCreditView> {
    return this.orders.creditCheck(auth, orderId);
  }

  @Get(':id/availability')
  @RequirePermissions('sales:read')
  availability(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
  ): Promise<OrderAvailabilityView> {
    return this.orders.availability(auth, orderId);
  }

  @Post(':id/confirm')
  @HttpCode(200)
  @RequirePermissions('sales:manage')
  confirm(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(confirmOrderSchema)) body: ConfirmOrderInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<SalesOrderView> {
    return this.orders.confirm(auth, orderId, body, idempotencyKey);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions('sales:manage')
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(cancelOrderSchema)) body: CancelOrderInput,
  ): Promise<SalesOrderView> {
    return this.orders.cancel(auth, orderId, body);
  }

  @Post(':id/lines/:lineId/cancel')
  @HttpCode(200)
  @RequirePermissions('sales:manage')
  cancelLine(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
    @Param('lineId', id()) lineId: string,
    @Body(new ZodValidationPipe(cancelLineSchema)) body: CancelLineInput,
  ): Promise<SalesOrderView> {
    return this.orders.cancelLine(auth, orderId, lineId, body);
  }

  @Post(':id/reserve')
  @HttpCode(200)
  @RequirePermissions('sales:manage')
  reserve(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(reserveOrderSchema)) body: ReserveOrderInput,
  ): Promise<SalesOrderView> {
    return this.orders.reserve(auth, orderId, body);
  }

  @Post(':id/release')
  @HttpCode(200)
  @RequirePermissions('sales:manage')
  release(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(releaseOrderSchema)) body: ReleaseOrderInput,
  ): Promise<SalesOrderView> {
    return this.orders.release(auth, orderId, body);
  }

  @Post(':id/invoices')
  @RequirePermissions('billing:issue')
  bill(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) orderId: string,
    @Body(new ZodValidationPipe(billOrderSchema)) body: BillOrderInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<TaxDocumentView> {
    return this.orders.bill(auth, orderId, body, idempotencyKey);
  }
}

/** Reservations listed for release (spec §4.3). */
@Controller('stock-reservations')
export class StockReservationsController {
  constructor(@Inject(SalesOrdersService) private readonly orders: SalesOrdersService) {}

  @Get('stale')
  @RequirePermissions('sales:read')
  stale(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(staleReservationsSchema)) query: StaleReservationsQuery,
  ): Promise<StaleReservationPage> {
    return this.orders.staleReservations(auth, query);
  }
}

/** Goods leaving for an invoice (spec §4.2, §5.1). */
@Controller('invoices/:id/dispatches')
export class DispatchesController {
  constructor(@Inject(DispatchesService) private readonly dispatches: DispatchesService) {}

  @Post()
  @RequirePermissions('billing:issue')
  create(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) invoiceId: string,
    @Body(new ZodValidationPipe(dispatchSchema)) body: DispatchInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<DispatchView> {
    return this.dispatches.create(auth, invoiceId, body, idempotencyKey);
  }

  @Get()
  @RequirePermissions('sales:read')
  list(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) invoiceId: string,
  ): Promise<InvoiceDispatchesView> {
    return this.dispatches.list(auth, invoiceId);
  }
}

/** The billing go-live cut-over (spec §4.7). */
@Controller('sales/go-live')
export class GoLiveController {
  constructor(@Inject(GoLiveService) private readonly goLive: GoLiveService) {}

  @Get()
  @RequirePermissions('organization:manage')
  preview(@CurrentAuth() auth: AuthContext): Promise<GoLivePreview> {
    return this.goLive.preview(auth);
  }

  @Post()
  @HttpCode(200)
  @RequirePermissions('organization:manage')
  run(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(goLiveSchema)) body: GoLiveInput,
    @IdempotencyKey(key()) idempotencyKey: string | undefined,
  ): Promise<GoLiveResult> {
    return this.goLive.goLive(auth, body, idempotencyKey);
  }
}
