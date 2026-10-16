import 'reflect-metadata';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import {
  PAYMENT_LINK_MANAGE_PERMISSION,
  PAYMENT_LINK_READ_PERMISSION,
  PAYMENT_LINK_SETTINGS_PERMISSION,
  type GatewayAccountView,
  type GatewayTestResult,
  type LogCheckoutView,
  type LogWebhook,
  type PaymentLinkCreated,
  type PaymentLinkPage,
  type PaymentLinkSettings,
  type PaymentLinkView,
} from '@paint/shared';
import type { FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth, Public, RequirePermissions } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { GatewayAccountsService } from './gateway-accounts.service.js';
import {
  connectGatewaySchema,
  createPaymentLinkSchema,
  listPaymentLinksSchema,
  logPaySchema,
  updateLinkSettingsSchema,
  type ConnectGatewayInput,
  type CreatePaymentLinkInput,
  type ListPaymentLinksQuery,
  type LogPayInput,
  type UpdateLinkSettingsInput,
} from './payment-links.schemas.js';
import { PaymentLinksService } from './payment-links.service.js';

const id = () => new ParseUUIDPipe();

/** UPI payment links (P2-M32): ask a customer for money by link, see and cancel links. */
@Controller('payment-links')
export class PaymentLinksController {
  constructor(
    @Inject(PaymentLinksService) private readonly links: PaymentLinksService,
    @Inject(GatewayAccountsService) private readonly accounts: GatewayAccountsService,
  ) {}

  /** Whether links can be made here (the screens show their buttons only then), and the rules. */
  @Get('settings')
  settings(@CurrentAuth() auth: AuthContext): Promise<PaymentLinkSettings> {
    return this.links.status(auth);
  }

  @Put('settings')
  @RequirePermissions(PAYMENT_LINK_SETTINGS_PERMISSION)
  updateSettings(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(updateLinkSettingsSchema)) body: UpdateLinkSettingsInput,
  ): Promise<PaymentLinkSettings> {
    return this.links.updateSettings(auth, body);
  }

  /** The business's own Razorpay account, never with a secret ([PO-40]). */
  @Get('gateway-account')
  @RequirePermissions(PAYMENT_LINK_SETTINGS_PERMISSION)
  gatewayAccount(@CurrentAuth() auth: AuthContext): Promise<GatewayAccountView | null> {
    return this.accounts.view(auth);
  }

  @Put('gateway-account')
  @RequirePermissions(PAYMENT_LINK_SETTINGS_PERMISSION)
  connect(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(connectGatewaySchema)) body: ConnectGatewayInput,
  ): Promise<GatewayAccountView> {
    return this.accounts.connect(auth, body);
  }

  @Post('gateway-account/test')
  @HttpCode(200)
  @RequirePermissions(PAYMENT_LINK_SETTINGS_PERMISSION)
  testGateway(@CurrentAuth() auth: AuthContext): Promise<GatewayTestResult> {
    return this.accounts.test(auth);
  }

  @Delete('gateway-account')
  @RequirePermissions(PAYMENT_LINK_SETTINGS_PERMISSION)
  disconnect(@CurrentAuth() auth: AuthContext): Promise<GatewayAccountView> {
    return this.accounts.disconnect(auth);
  }

  @Post()
  @RequirePermissions(PAYMENT_LINK_MANAGE_PERMISSION)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(createPaymentLinkSchema)) body: CreatePaymentLinkInput,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<PaymentLinkCreated> {
    return this.links.create(auth, body, idempotencyKey);
  }

  @Get()
  @RequirePermissions(PAYMENT_LINK_READ_PERMISSION)
  list(
    @CurrentAuth() auth: AuthContext,
    @Query(new ZodValidationPipe(listPaymentLinksSchema)) query: ListPaymentLinksQuery,
  ): Promise<PaymentLinkPage> {
    return this.links.list(auth, query);
  }

  @Get(':id')
  @RequirePermissions(PAYMENT_LINK_READ_PERMISSION)
  get(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) linkId: string,
  ): Promise<PaymentLinkView> {
    return this.links.get(auth, linkId);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions(PAYMENT_LINK_MANAGE_PERMISSION)
  cancel(
    @CurrentAuth() auth: AuthContext,
    @Param('id', id()) linkId: string,
  ): Promise<PaymentLinkView> {
    return this.links.cancel(auth, linkId);
  }
}

/**
 * A payment-link gateway's webhooks: `/webhooks/payment-links/log`, and
 * `/webhooks/payment-links/razorpay/<business>` for each business's own Razorpay account
 * (its webhook secret checks the signature). Public, but nothing is believed until the
 * signature over the raw body checks out; each event is applied once. Only the
 * configured provider has routes.
 */
@Public()
@Controller('webhooks/payment-links')
export class PaymentLinkWebhooksController {
  constructor(@Inject(PaymentLinksService) private readonly links: PaymentLinksService) {}

  @Post(':provider')
  @HttpCode(200)
  receive(
    @Param('provider') provider: string,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<{ received: string }> {
    return this.deliver(provider, undefined, request);
  }

  @Post(':provider/:business')
  @HttpCode(200)
  receiveForBusiness(
    @Param('provider') provider: string,
    @Param('business') business: string,
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<{ received: string }> {
    return this.deliver(provider, business, request);
  }

  private async deliver(
    provider: string,
    business: string | undefined,
    request: RawBodyRequest<FastifyRequest>,
  ): Promise<{ received: string }> {
    const outcome = await this.links.receiveWebhook(
      provider,
      business,
      request.rawBody ?? Buffer.alloc(0),
      request.headers,
    );
    if (outcome === null) throw new BadRequestException('Invalid signature');
    return { received: outcome };
  }
}

/**
 * The `log` provider's pretend checkout page (development, tests and demos; the
 * provider is refused in production). 404 with any other provider.
 */
@Public()
@Controller('public/payment-links/log')
export class LogCheckoutController {
  constructor(@Inject(PaymentLinksService) private readonly links: PaymentLinksService) {}

  @Get(':reference')
  checkout(@Param('reference') reference: string): Promise<LogCheckoutView> {
    return this.links.logCheckout(reference);
  }

  @Post(':reference/pay')
  @HttpCode(200)
  pay(
    @Param('reference') reference: string,
    @Body(new ZodValidationPipe(logPaySchema)) body: LogPayInput,
  ): Promise<LogWebhook> {
    return this.links.logPay(reference, body);
  }
}
