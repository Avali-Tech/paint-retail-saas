import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common';
import type {
  CheckoutView,
  PlanChangeResult,
  SubscriptionInvoiceView,
  SubscriptionStatusView,
  SubscriptionView,
} from '@paint/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, Public } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { attachmentHeader } from '../documents/file-checks.js';
import { FakeGateway } from './fake-gateway.js';
import { PAYMENT_GATEWAY, type PaymentGateway } from './payment-gateway.js';
import { AllowWhenReadOnly } from './read-only.guard.js';
import { changePlanSchema, type ChangePlanInput } from './subscriptions.schemas.js';
import { SubscriptionsService } from './subscriptions.service.js';

const id = () => new ParseUUIDPipe();

/**
 * The business's subscription (roadmap P2-M08). Every member sees its status;
 * everything else is for the owner only. Usable while read-only, so they can pay.
 */
@AllowWhenReadOnly()
@Controller('subscription')
export class SubscriptionsController {
  constructor(
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGateway,
  ) {}

  @Get('status')
  status(@CurrentAuth() auth: AuthContext): Promise<SubscriptionStatusView> {
    return this.subscriptions.status(auth);
  }

  @Get()
  view(@CurrentAuth() auth: AuthContext): Promise<SubscriptionView> {
    return this.subscriptions.view(auth);
  }

  @Post('change')
  @HttpCode(200)
  change(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(changePlanSchema)) body: ChangePlanInput,
  ): Promise<PlanChangeResult> {
    return this.subscriptions.change(auth, body);
  }

  @Post('cancel')
  @HttpCode(200)
  cancel(@CurrentAuth() auth: AuthContext): Promise<SubscriptionView> {
    return this.subscriptions.cancel(auth);
  }

  @Get('checkouts/:id')
  checkout(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) checkoutId: string,
  ): Promise<CheckoutView> {
    return this.subscriptions.checkout(auth, checkoutId);
  }

  /** The fake gateway's payment page "pays"; there is no such route with a real gateway. */
  @Post('checkouts/:id/fake-pay')
  @HttpCode(200)
  fakePay(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) checkoutId: string,
  ): Promise<CheckoutView> {
    if (!(this.gateway instanceof FakeGateway)) throw new NotFoundException();
    return this.subscriptions.fakePay(auth, checkoutId, this.gateway);
  }

  @Get('invoices')
  invoices(@CurrentAuth() auth: AuthContext): Promise<SubscriptionInvoiceView[]> {
    return this.subscriptions.invoices(auth);
  }

  @Get('invoices/:id/pdf')
  async invoicePdf(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) invoiceId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Buffer> {
    const { number, pdf } = await this.subscriptions.invoicePdf(auth, invoiceId);
    void reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', attachmentHeader(`${number.replaceAll('/', '-')}.pdf`))
      .header('cache-control', 'private, no-store');
    return pdf;
  }
}

/**
 * The payment gateway's webhooks. Public, but nothing is believed until the
 * signature over the raw body checks out; each event is applied once.
 */
@Public()
@Controller('subscription/webhooks')
export class SubscriptionWebhooksController {
  constructor(@Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService) {}

  @Post()
  @HttpCode(200)
  async receive(@Req() request: RawBodyRequest<FastifyRequest>): Promise<{ received: string }> {
    const outcome = await this.subscriptions.receiveWebhook(
      request.rawBody ?? Buffer.alloc(0),
      request.headers,
    );
    if (outcome === null) throw new BadRequestException('Invalid signature');
    return { received: outcome };
  }
}
