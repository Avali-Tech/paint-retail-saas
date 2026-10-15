/** How often a paid plan is billed. */
export const BILLING_INTERVALS = ['monthly', 'annual'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

/** A paid plan's price per store for each interval, in paise, before GST. */
export type PlanPrices = Readonly<Record<BillingInterval, number>>;

/**
 * Subscription plans (roadmap P1-M23, P2-M08), in order from smallest to largest.
 * Limits are null when unlimited; prices are null for the free trial. The catalogue
 * stays in code: each price must match a plan set up at the payment gateway
 * (RAZORPAY_PLAN_IDS), and it ships with the limits and features it sells.
 * Prices are placeholders until the business sets them (annual = 10 months).
 */
export const PLANS = {
  trial: { name: 'Trial', maxStores: 5, maxMembers: 25, prices: null },
  starter: {
    name: 'Starter',
    maxStores: 1,
    maxMembers: 5,
    prices: { monthly: 799_00, annual: 7_990_00 },
  },
  standard: {
    name: 'Standard',
    maxStores: 10,
    maxMembers: 50,
    prices: { monthly: 1_499_00, annual: 14_990_00 },
  },
  enterprise: {
    name: 'Enterprise',
    maxStores: null,
    maxMembers: null,
    prices: { monthly: 2_999_00, annual: 29_990_00 },
  },
} as const satisfies Record<
  string,
  {
    name: string;
    maxStores: number | null;
    maxMembers: number | null;
    prices: PlanPrices | null;
  }
>;
export type PlanKey = keyof typeof PLANS;
export const PLAN_KEYS = Object.keys(PLANS) as [PlanKey, ...PlanKey[]];
/** Plans a business can buy (every plan but the trial). */
export type PaidPlanKey = Exclude<PlanKey, 'trial'>;
export const PAID_PLAN_KEYS = PLAN_KEYS.filter((key) => key !== 'trial') as [
  PaidPlanKey,
  ...PaidPlanKey[],
];

/**
 * Features the platform can turn on per business. Most belong to later
 * releases; the flags let them be piloted with chosen dealers first.
 */
export const FEATURE_FLAGS = {
  whatsapp_notifications: 'WhatsApp notifications',
  credit_control: 'Credit limits and approvals',
  loyalty: 'Loyalty points for contractors and painters',
  gst_einvoicing: 'GST e-invoices and e-way bills',
  advanced_reports: 'Advanced reports',
} as const;
export type FeatureFlag = keyof typeof FEATURE_FLAGS;
export const FEATURE_FLAG_KEYS = Object.keys(FEATURE_FLAGS) as [FeatureFlag, ...FeatureFlag[]];

/** What each plan turns on before any per-business override. */
const PLAN_FEATURES: Record<PlanKey, readonly FeatureFlag[]> = {
  trial: [],
  starter: [],
  standard: ['advanced_reports'],
  enterprise: FEATURE_FLAG_KEYS,
};

/** Every flag for a business: its plan's defaults, then the platform's overrides. */
export function resolveFeatures(
  plan: PlanKey,
  overrides: Partial<Record<FeatureFlag, boolean>>,
): Record<FeatureFlag, boolean> {
  return Object.fromEntries(
    FEATURE_FLAG_KEYS.map((flag) => [flag, overrides[flag] ?? PLAN_FEATURES[plan].includes(flag)]),
  ) as Record<FeatureFlag, boolean>;
}
