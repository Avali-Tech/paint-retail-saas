import type { BillingInterval, PaidPlanKey, PlanKey } from './plans.js';
import type {
  PaymentGatewayName,
  PlanBlocker,
  PlanChangeSource,
  PlanRequestStatus,
  PlanUsage,
  SubscriptionCharge,
  SubscriptionPaymentMode,
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
  /** How the platform collects: `manual` = requests, our invoices and bank transfer or UPI. */
  readonly collection: PaymentGatewayName;
  /** Where to send money for our invoices; only with manual invoicing. */
  readonly paymentInstructions: PaymentInstructions | null;
  /** The plan the owner asked for, waiting for the platform (manual invoicing). */
  readonly planRequest: PlanRequestView | null;
  readonly offers: readonly PlanOffer[];
  readonly history: readonly PlanChangeView[];
}

/** The platform's bank account and UPI id, printed on manual invoices. */
export interface PaymentInstructions {
  readonly accountName: string;
  readonly bankName: string;
  readonly accountNumber: string;
  readonly ifsc: string;
  readonly upiId: string | null;
}

/** A plan the owner asked for under manual invoicing. */
export interface PlanRequestView {
  readonly id: string;
  readonly plan: PaidPlanKey;
  readonly interval: BillingInterval;
  readonly status: PlanRequestStatus;
  /** The owner who asked. */
  readonly requestedBy: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
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

/**
 * POST /subscription/change: changed in place, a checkout to pay first (a gateway),
 * or, with manual invoicing, a request for the platform to apply.
 */
export type PlanChangeResult =
  | { readonly kind: 'changed'; readonly subscription: SubscriptionView }
  | { readonly kind: 'checkout'; readonly checkout: CheckoutView }
  | { readonly kind: 'requested'; readonly request: PlanRequestView };

/** A payment against one of our invoices: at the gateway, or recorded by an operator. */
export interface SubscriptionPaymentView {
  /** `online` when the gateway took it. */
  readonly mode: SubscriptionPaymentMode | 'online';
  readonly amountPaise: number;
  readonly paidOn: string;
  readonly reference: string;
}

/** POST /platform/subscription-invoices/:id/payments: money that arrived for a manual invoice. */
export interface RecordSubscriptionPaymentRequest {
  readonly amountPaise: number;
  readonly paidOn: string;
  readonly mode: SubscriptionPaymentMode;
  readonly reference: string;
}

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
  /** India date it is payable by. */
  readonly dueOn: string;
  /** Null while unpaid. */
  readonly payment: SubscriptionPaymentView | null;
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

/** GET /platform/tenants/:id/billing: what the operator needs to invoice a business by hand. */
export interface TenantBillingView {
  readonly collection: PaymentGatewayName;
  /** The owner's open request, if any. */
  readonly planRequest: PlanRequestView | null;
  /** The latest requests, newest first, decided or not. */
  readonly requests: readonly PlanRequestView[];
  /** Our invoices to the business, newest first. */
  readonly invoices: readonly SubscriptionInvoiceView[];
}
