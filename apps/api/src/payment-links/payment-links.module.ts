import 'reflect-metadata';
import { Global, Module, type DynamicModule } from '@nestjs/common';
import { PAYMENT_LINK_SETTINGS, type PaymentLinkSettings } from './links.js';
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
  static forRoot(settings: PaymentLinkSettings): DynamicModule {
    return {
      module: PaymentLinksModule,
      controllers: [PaymentLinksController, PaymentLinkWebhooksController, LogCheckoutController],
      providers: [PaymentLinksService, { provide: PAYMENT_LINK_SETTINGS, useValue: settings }],
      exports: [PAYMENT_LINK_SETTINGS],
    };
  }
}
