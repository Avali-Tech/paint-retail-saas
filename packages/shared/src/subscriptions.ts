import { taxOnAmount } from './gst/line.js';
import { PLAN_KEYS, PLANS, type BillingInterval, type PaidPlanKey, type PlanKey } from './plans.js';

/**
 * SaaS subscriptions (roadmap P2-M08): what a business pays us for the product.
 * Pure rules shared by the API and the web app; every moment is passed in (from
 * the database clock), never read here.
 */

/** Where a subscription stands. `past_due`: a renewal failed; `expired`: a trial ran out. */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'cancelled',
  'expired',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Who changed a business's plan. */
export const PLAN_CHANGE_SOURCES = ['signup', 'owner', 'operator', 'gateway'] as const;
export type PlanChangeSource = (typeof PLAN_CHANGE_SOURCES)[number];

/**
 * How the platform collects subscriptions (SUBSCRIPTION_GATEWAY). `manual`, the
 * default: our GST invoices, paid by bank transfer or UPI and recorded by a
 * platform operator. `razorpay`: Razorpay Subscriptions. `fake`: a gateway that
 * takes no money, for tests.
 */
export const SUBSCRIPTION_GATEWAYS = ['manual', 'fake', 'razorpay'] as const;
export type SubscriptionGatewayName = (typeof SUBSCRIPTION_GATEWAYS)[number];

/**
 * Every gateway the database knows (`payment_gateway`): the subscription gateways and
 * `log`, the payment-link provider of development and demos (P2-M32), which takes no
 * money and is refused in production.
 */
export const PAYMENT_GATEWAYS = [...SUBSCRIPTION_GATEWAYS, 'log'] as const;
export type PaymentGatewayName = (typeof PAYMENT_GATEWAYS)[number];

/** How a business paid one of our manual invoices. */
export const SUBSCRIPTION_PAYMENT_MODES = ['bank_transfer', 'upi', 'cheque', 'other'] as const;
export type SubscriptionPaymentMode = (typeof SUBSCRIPTION_PAYMENT_MODES)[number];

/** A plan an owner asked for under manual invoicing: open until an operator decides. */
export const PLAN_REQUEST_STATUSES = ['open', 'applied', 'cancelled'] as const;
export type PlanRequestStatus = (typeof PLAN_REQUEST_STATUSES)[number];

/** Manual invoicing raises the next period's invoice this many days before it starts. */
export const RENEWAL_INVOICE_LEAD_DAYS = 7;

/** GST on software as a service: 18% (basis points). */
export const SAAS_GST_RATE_BPS = 1800;

const DAY_MS = 24 * 60 * 60 * 1000;

/** True for a plan with more room than `from` (later in the catalogue). */
export function isUpgrade(from: PlanKey, to: PlanKey): boolean {
  return PLAN_KEYS.indexOf(to) > PLAN_KEYS.indexOf(from);
}

/** What one period of a paid plan costs for `stores` stores (at least one), GST at 18%. */
export interface SubscriptionCharge {
  /** Stores billed: the business's active stores, at least one. */
  readonly quantity: number;
  /** Per store, before GST. */
  readonly unitPricePaise: number;
  readonly taxablePaise: number;
  readonly gstPaise: number;
  /** What the gateway collects each period. */
  readonly totalPaise: number;
}

export function subscriptionCharge(
  plan: PaidPlanKey,
  interval: BillingInterval,
  stores: number,
): SubscriptionCharge {
  const quantity = Math.max(1, stores);
  const unitPricePaise = PLANS[plan].prices[interval];
  const taxablePaise = unitPricePaise * quantity;
  const heads = taxOnAmount(
    taxablePaise,
    { nature: 'taxable', rateBasisPoints: SAAS_GST_RATE_BPS, cessBasisPoints: 0 },
    'inter_state',
    false,
  );
  return {
    quantity,
    unitPricePaise,
    taxablePaise,
    gstPaise: heads.igstPaise,
    totalPaise: taxablePaise + heads.igstPaise,
  };
}

/** The business's active stores and team members, counted as the plan limits count them. */
export interface PlanUsage {
  readonly stores: number;
  readonly members: number;
}

/** Something the business uses beyond a plan's limit. */
export interface PlanBlocker {
  readonly what: 'stores' | 'members';
  readonly used: number;
  readonly limit: number;
}

/** Why the business cannot move to `plan` now: its usage over the plan's limits (none = it can). */
export function planBlockers(plan: PlanKey, usage: PlanUsage): PlanBlocker[] {
  const { maxStores, maxMembers } = PLANS[plan];
  const blockers: PlanBlocker[] = [];
  if (maxStores !== null && usage.stores > maxStores) {
    blockers.push({ what: 'stores', used: usage.stores, limit: maxStores });
  }
  if (maxMembers !== null && usage.members > maxMembers) {
    blockers.push({ what: 'members', used: usage.members, limit: maxMembers });
  }
  return blockers;
}

/** A subscription as stored; moments are ISO strings. */
export interface SubscriptionRecord {
  readonly status: SubscriptionStatus;
  /** Null for a trial or a plan the platform set by hand (invoiced outside the product). */
  readonly gateway: PaymentGatewayName | null;
  readonly trialEndsAt: string | null;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pastDueSince: string | null;
}

/** Where a subscription stands at a moment, and what the business may do. */
export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  /** Whole days of trial left (rounded up); null when not trialing. */
  readonly trialDaysLeft: number | null;
  /** When an unpaid renewal turns the business read-only; null unless past due. */
  readonly graceEndsAt: string | null;
  /** No new sales or invoices: reading and paying still work. */
  readonly readOnly: boolean;
}

/**
 * Where `record` stands at `now`. Time moves a subscription on without anyone
 * writing to it: a trial past its end has expired; a paid period that ended
 * without a renewal is past due from its end (or cancelled, if so asked). A
 * past-due business keeps working for `graceDays`, then becomes read-only, as
 * expired and cancelled ones are at once. Plans set by the platform never lapse.
 */
export function subscriptionState(
  record: SubscriptionRecord,
  now: Date,
  graceDays: number,
): SubscriptionState {
  const at = (iso: string) => new Date(iso).getTime();
  const lapsed = (iso: string | null) => iso !== null && at(iso) <= now.getTime();
  let status = record.status;
  let pastDueSince = record.pastDueSince;
  if (status === 'trialing' && lapsed(record.trialEndsAt)) status = 'expired';
  if (status === 'active' && record.gateway !== null && lapsed(record.currentPeriodEnd)) {
    status = record.cancelAtPeriodEnd ? 'cancelled' : 'past_due';
    pastDueSince = record.currentPeriodEnd;
  }
  if (status === 'trialing') {
    const left = at(String(record.trialEndsAt)) - now.getTime();
    return { status, trialDaysLeft: Math.ceil(left / DAY_MS), graceEndsAt: null, readOnly: false };
  }
  if (status === 'past_due') {
    // A past-due row always carries the moment it fell due.
    const graceEnds = at(String(pastDueSince)) + graceDays * DAY_MS;
    return {
      status,
      trialDaysLeft: null,
      graceEndsAt: new Date(graceEnds).toISOString(),
      readOnly: graceEnds <= now.getTime(),
    };
  }
  return {
    status,
    trialDaysLeft: null,
    graceEndsAt: null,
    readOnly: status === 'cancelled' || status === 'expired',
  };
}
