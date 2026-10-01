/** Subscription plans (roadmap P1-M23). Limits are null when unlimited. */
export const PLANS = {
  trial: { name: 'Trial', maxStores: 5, maxMembers: 25 },
  standard: { name: 'Standard', maxStores: 10, maxMembers: 50 },
  enterprise: { name: 'Enterprise', maxStores: null, maxMembers: null },
} as const satisfies Record<
  string,
  { name: string; maxStores: number | null; maxMembers: number | null }
>;
export type PlanKey = keyof typeof PLANS;
export const PLAN_KEYS = Object.keys(PLANS) as [PlanKey, ...PlanKey[]];

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
