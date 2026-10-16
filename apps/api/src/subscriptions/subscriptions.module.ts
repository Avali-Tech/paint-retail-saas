import 'reflect-metadata';
import { Module, type DynamicModule } from '@nestjs/common';
import type { SubscriptionsConfig } from '../config.js';
import { FakeGateway } from './fake-gateway.js';
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
  return config.gateway.name === 'razorpay'
    ? new RazorpayGateway(config.gateway)
    : new FakeGateway(config.appUrl);
}

/**
 * SaaS subscriptions (roadmap P2-M08). Global: the read-only guard (AuthModule)
 * and the platform console use the service too.
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
        { provide: SUBSCRIPTION_SETTINGS, useValue: config },
        { provide: SUBSCRIPTION_GATEWAY, useValue: gatewayFor(config) },
      ],
      exports: [SubscriptionsService, SUBSCRIPTION_SETTINGS, SUBSCRIPTION_GATEWAY],
    };
  }
}
