import 'reflect-metadata';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { GatewayAccountsService } from './gateway-accounts.service.js';
import { PAYMENT_LINK_GATEWAYS, type PaymentLinkGateways } from './payment-link-gateways.js';
import {
  LogCheckoutController,
  PaymentLinksController,
  PaymentLinkWebhooksController,
} from './payment-links.controller.js';
import { PaymentLinksService } from './payment-links.service.js';

/**
 * Release 2.1, P2-M32 (payment-link half): UPI payment links and their webhooks.
 * Global so statements and the collections run can put links on their messages.
 */
@Global()
@Module({})
export class PaymentLinksModule {
  static forRoot(gateways: PaymentLinkGateways): DynamicModule {
    return {
      module: PaymentLinksModule,
      controllers: [PaymentLinksController, PaymentLinkWebhooksController, LogCheckoutController],
      providers: [
        PaymentLinksService,
        GatewayAccountsService,
        { provide: PAYMENT_LINK_GATEWAYS, useValue: gateways },
      ],
      exports: [PAYMENT_LINK_GATEWAYS],
    };
  }
}
