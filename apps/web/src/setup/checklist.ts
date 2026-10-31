import type { SetupStepKey } from '@paint/shared';

// "Getting started" (docs/mvp-3/navigation-ux.md §6 step 3): where each step is done,
// and hiding the checklist on Home on this device.

/** The screen that does each step. */
export const STEP_PATHS: Readonly<Record<SetupStepKey, string>> = {
  stores_gst: '/settings/stores',
  products: '/imports',
  customers: '/imports',
  opening_stock: '/imports',
  team: '/team',
  credit_rules: '/settings/credit',
  billing_live: '/settings/go-live',
  invoice_print: '/settings/invoice-print',
  payment_links: '/settings/payment-links',
};

export const GETTING_STARTED_PATH = '/settings/getting-started';

const dismissedKey = (organizationId: string) => `paint.gettingStarted.hidden.${organizationId}`;

/** True when the checklist was hidden from Home on this device (false if storage fails). */
export function isDismissed(storage: Storage, organizationId: string): boolean {
  try {
    return storage.getItem(dismissedKey(organizationId)) === '1';
  } catch {
    return false;
  }
}

/** Hides the checklist from Home on this device; it stays under Settings. */
export function dismiss(storage: Storage, organizationId: string): void {
  try {
    storage.setItem(dismissedKey(organizationId), '1');
  } catch {
    // Storage is off (a private window): the card hides until the page reloads.
  }
}
