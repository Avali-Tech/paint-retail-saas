/**
 * "Getting started" (docs/mvp-3/navigation-ux.md §6 step 3): a new business's first
 * steps, in the order to do them, each ticked off from its real data (GET /onboarding).
 */
export const SETUP_STEP_KEYS = [
  /** Every store saved with its GST state (and registration, when it has one). */
  'stores_gst',
  /** Products in the catalogue, usually by the products import. */
  'products',
  /** Customers, contractors or painters, usually by the parties import. */
  'customers',
  /** Opening stock posted at a store. */
  'opening_stock',
  /** Someone besides the owner invited. */
  'team',
  /** The credit rules saved once (the limits and the hold after overdue days). */
  'credit_rules',
  /** Billing went live: opening balances posted. */
  'billing_live',
  /** Bank details, terms or a logo for the printed invoice. */
  'invoice_print',
  /** A payment gateway connected for UPI payment links. */
  'payment_links',
] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export interface SetupStepView {
  readonly key: SetupStepKey;
  readonly done: boolean;
  /** What there is so far: stores with GST, products, customers, members… */
  readonly count: number;
}

/** GET /onboarding: the same for every member of the business. */
export interface SetupChecklistView {
  readonly steps: readonly SetupStepView[];
  readonly completed: number;
  readonly total: number;
}
