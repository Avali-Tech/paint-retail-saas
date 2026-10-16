import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import type { SubscriptionsConfig } from '../config.js';
import { FakeGateway } from './fake-gateway.js';
import { ManualBillingService } from './manual-billing.js';
import { ManualGateway } from './manual-gateway.js';
import { SUBSCRIPTION_GATEWAY, type SubscriptionGateway } from './subscription-gateway.js';
import { RazorpayGateway } from './razorpay-gateway.js';
import {
  SubscriptionsController,
  SubscriptionWebhooksController,
} from './subscriptions.controller.js';
import { SubscriptionsService } from './subscriptions.service.js';
import { SUBSCRIPTION_SETTINGS } from './subscriptions.tokens.js';

/** The gateway the configuration names. */
export function gatewayFor(config: SubscriptionsConfig): SubscriptionGateway {
  switch (config.gateway.name) {
    case 'razorpay':
      return new RazorpayGateway(config.gateway);
    case 'fake':
      return new FakeGateway(config.appUrl);
    default:
      return new ManualGateway();
  }
}

/**
 * SaaS subscriptions (roadmap P2-M08). Global: the read-only guard (AuthModule),
 * the platform console and the background worker (renewal invoices) use it too.
 */
@Module({})
export class SubscriptionsModule {
  static forRoot(config: SubscriptionsConfig): DynamicModule {
    return {
      module: SubscriptionsModule,
      global: true,
      controllers: [SubscriptionsController, SubscriptionWebhooksController],
      providers: [
        SubscriptionsService,
        ManualBillingService,
        { provide: SUBSCRIPTION_SETTINGS, useValue: config },
        { provide: SUBSCRIPTION_GATEWAY, useValue: gatewayFor(config) },
      ],
      exports: [
        SubscriptionsService,
        ManualBillingService,
        SUBSCRIPTION_SETTINGS,
        SUBSCRIPTION_GATEWAY,
      ],
    };
  }
}
