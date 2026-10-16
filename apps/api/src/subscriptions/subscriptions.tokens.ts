import type { SubscriptionsConfig } from '../config.js';

/** Injection token for the SubscriptionsConfig (trial and grace days, the platform's GST details). */
export const SUBSCRIPTION_SETTINGS = Symbol('SUBSCRIPTION_SETTINGS');
export type SubscriptionSettings = SubscriptionsConfig;
