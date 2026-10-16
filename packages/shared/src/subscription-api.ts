import type { BillingInterval, PaidPlanKey, PlanKey } from './plans.js';
import type {
  PaymentGatewayName,
  PlanBlocker,
  PlanChangeSource,
  PlanUsage,
  SubscriptionCharge,
  SubscriptionStatus,
} from './subscriptions.js';

/** GET /subscription/status: what every member's app needs to warn or hold back. */
export interface SubscriptionStatusView {
  readonly plan: PlanKey;
  readonly status: SubscriptionStatus;
  readonly readOnly: boolean;
  readonly trialEndsAt: string | null;
  readonly trialDaysLeft: number | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly graceEndsAt: string | null;
}

/** A plan the owner can move to, priced for the business's stores. */
export interface PlanOffer {
  readonly plan: PaidPlanKey;
  readonly name: string;
  readonly maxStores: number | null;
  readonly maxMembers: number | null;
  readonly charges: Readonly<Record<BillingInterval, SubscriptionCharge>>;
  /** Usage over this plan's limits: it cannot be chosen until they are cleared. */
  readonly blockers: readonly PlanBlocker[];
}

export interface PlanChangeView {
  readonly id: string;
  readonly fromPlan: PlanKey | null;
  readonly toPlan: PlanKey;
  readonly interval: BillingInterval | null;
  readonly source: PlanChangeSource;
  /** The member who made it, for owner changes; null otherwise. */
  readonly changedBy: string | null;
  readonly at: string;
}

/** GET /subscription: the owner's Billing page. */
export interface SubscriptionView extends SubscriptionStatusView {
  readonly planName: string;
  readonly limits: { readonly maxStores: number | null; readonly maxMembers: number | null };
  readonly usage: PlanUsage;
  readonly interval: BillingInterval | null;
  /** Stores billed each period. */
  readonly quantity: number | null;
  readonly currentPeriodStart: string | null;
  readonly pastDueSince: string | null;
  /** Null for a trial or a plan the platform set by hand. */
  readonly gateway: PaymentGatewayName | null;
  readonly offers: readonly PlanOffer[];
  readonly history: readonly PlanChangeView[];
}

export type CheckoutStatus = 'open' | 'paid';

/** A payment started at the gateway for a new paid plan. */
export interface CheckoutView {
  readonly id: string;
  readonly plan: PaidPlanKey;
  readonly interval: BillingInterval;
  readonly quantity: number;
  readonly totalPaise: number;
  readonly gateway: PaymentGatewayName;
  /** The gateway's payment page; the fake gateway's is a page of the app. */
  readonly checkoutUrl: string;
  readonly status: CheckoutStatus;
  readonly createdAt: string;
}

/** POST /subscription/change: changed in place, or a checkout to pay first. */
export type PlanChangeResult =
  | { readonly kind: 'changed'; readonly subscription: SubscriptionView }
  | { readonly kind: 'checkout'; readonly checkout: CheckoutView };

/** One of our GST invoices to the business (GET /subscription/invoices). */
export interface SubscriptionInvoiceView {
  readonly id: string;
  readonly number: string;
  readonly issuedOn: string;
  readonly plan: PaidPlanKey;
  readonly interval: BillingInterval;
  readonly quantity: number;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly taxablePaise: number;
  readonly taxPaise: number;
  readonly totalPaise: number;
}

/** The subscription as the platform console shows it beside each business. */
export interface TenantSubscriptionView {
  readonly status: SubscriptionStatus;
  readonly readOnly: boolean;
  readonly trialEndsAt: string | null;
  readonly currentPeriodEnd: string | null;
  readonly interval: BillingInterval | null;
  readonly gateway: PaymentGatewayName | null;
}
