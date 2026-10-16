import {
  planBlockers,
  subscriptionCharge,
  PAID_PLAN_KEYS,
  PLANS,
  type CheckoutView,
  type PaymentInstructions,
  type PlanRequestView,
  type PlanUsage,
  type SubscriptionInvoiceView,
  type SubscriptionStatusView,
  type SubscriptionView,
} from '@paint/shared';

// Subscription data for component tests, shaped like apps/api/src/subscriptions answers.

/** A paid subscription in good standing: no banner. */
export const FINE_SUBSCRIPTION: SubscriptionStatusView = {
  plan: 'standard',
  status: 'active',
  readOnly: false,
  trialEndsAt: null,
  trialDaysLeft: null,
  currentPeriodEnd: '2026-11-16T04:30:00.000Z',
  cancelAtPeriodEnd: false,
  graceEndsAt: null,
};

export function subscriptionStatus(
  overrides: Partial<SubscriptionStatusView> = {},
): SubscriptionStatusView {
  return { ...FINE_SUBSCRIPTION, ...overrides };
}

const USAGE: PlanUsage = { stores: 3, members: 13 };

/** A business on its trial with 3 stores and 13 people: Starter is too small. */
export function subscriptionView(overrides: Partial<SubscriptionView> = {}): SubscriptionView {
  const usage = overrides.usage ?? USAGE;
  const plan = overrides.plan ?? 'trial';
  return {
    plan,
    status: 'trialing',
    readOnly: false,
    trialEndsAt: '2026-10-26T04:30:00.000Z',
    trialDaysLeft: 10,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    graceEndsAt: null,
    planName: PLANS[plan].name,
    limits: { maxStores: PLANS[plan].maxStores, maxMembers: PLANS[plan].maxMembers },
    usage,
    interval: null,
    quantity: null,
    currentPeriodStart: null,
    pastDueSince: null,
    gateway: null,
    collection: 'fake',
    paymentInstructions: null,
    planRequest: null,
    offers: PAID_PLAN_KEYS.map((key) => ({
      plan: key,
      name: PLANS[key].name,
      maxStores: PLANS[key].maxStores,
      maxMembers: PLANS[key].maxMembers,
      charges: {
        monthly: subscriptionCharge(key, 'monthly', usage.stores),
        annual: subscriptionCharge(key, 'annual', usage.stores),
      },
      blockers: planBlockers(key, usage),
    })),
    history: [
      {
        id: 'change-1',
        fromPlan: null,
        toPlan: 'trial',
        interval: null,
        source: 'signup',
        changedBy: null,
        at: '2026-10-12T04:30:00.000Z',
      },
    ],
    ...overrides,
  };
}

/** The same business paying for Standard, monthly, online. */
export const PAID_VIEW = subscriptionView({
  plan: 'standard',
  planName: 'Standard',
  status: 'active',
  limits: { maxStores: 10, maxMembers: 50 },
  trialEndsAt: null,
  trialDaysLeft: null,
  interval: 'monthly',
  quantity: 3,
  currentPeriodStart: '2026-10-16T04:30:00.000Z',
  currentPeriodEnd: '2026-11-16T04:30:00.000Z',
  gateway: 'fake',
  history: [
    {
      id: 'change-2',
      fromPlan: 'trial',
      toPlan: 'standard',
      interval: 'monthly',
      source: 'owner',
      changedBy: 'Anil Kumar',
      at: '2026-10-16T04:30:00.000Z',
    },
    {
      id: 'change-1',
      fromPlan: null,
      toPlan: 'trial',
      interval: null,
      source: 'signup',
      changedBy: null,
      at: '2026-10-12T04:30:00.000Z',
    },
  ],
});

export const CHECKOUT: CheckoutView = {
  id: '00000000-0000-4000-8000-0000000000c1',
  plan: 'standard',
  interval: 'monthly',
  quantity: 3,
  totalPaise: 5_306_46,
  gateway: 'fake',
  checkoutUrl: 'http://app.test/billing/checkout/00000000-0000-4000-8000-0000000000c1',
  status: 'open',
  createdAt: '2026-10-16T04:30:00.000Z',
};

export const INVOICE: SubscriptionInvoiceView = {
  id: '00000000-0000-4000-8000-0000000000d1',
  number: 'PRS/26-27/000001',
  issuedOn: '2026-10-16',
  plan: 'standard',
  interval: 'monthly',
  quantity: 3,
  periodStart: '2026-10-16',
  periodEnd: '2026-11-15',
  taxablePaise: 4_497_00,
  taxPaise: 809_46,
  totalPaise: 5_306_46,
  dueOn: '2026-10-16',
  payment: {
    mode: 'online',
    amountPaise: 5_306_46,
    paidOn: '2026-10-16',
    reference: 'pay_fake_1',
  },
};

/** The platform's bank account, as manual invoicing shows it. */
export const BANK: PaymentInstructions = {
  accountName: 'Avali Tech Private Limited',
  bankName: 'HDFC Bank, Banjara Hills',
  accountNumber: '50200012345678',
  ifsc: 'HDFC0000123',
  upiId: 'avalitech@hdfcbank',
};

/** Manual invoicing: our invoice waiting for a bank transfer. */
export const UNPAID_INVOICE: SubscriptionInvoiceView = {
  ...INVOICE,
  id: '00000000-0000-4000-8000-0000000000d2',
  number: 'PRS/26-27/000002',
  payment: null,
};

export const PLAN_REQUEST: PlanRequestView = {
  id: '00000000-0000-4000-8000-0000000000e1',
  plan: 'standard',
  interval: 'monthly',
  status: 'open',
  requestedBy: 'Anil Kumar',
  createdAt: '2026-10-16T04:30:00.000Z',
  decidedAt: null,
};

/** The trial business with manual invoicing (the default): requests, no checkout. */
export function manualView(overrides: Partial<SubscriptionView> = {}): SubscriptionView {
  return subscriptionView({ collection: 'manual', paymentInstructions: BANK, ...overrides });
}
