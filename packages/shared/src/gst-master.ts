import { GST_STATES, gstState, isGstStateCode, type GstState } from './gst/index.js';

/**
 * GST master data shared by the API and the web app: state codes, registration
 * types and the shapes of the Tax & GST settings. The tax calculation itself lives
 * elsewhere (packages/shared/src/gst); this file only describes who is registered
 * where and which rate a tax category carries on a given day.
 */

/**
 * State codes a new registration or place of supply may use: the engine's table
 * (./gst/states.ts) without the legacy codes 25 (Daman and Diu, merged into 26) and
 * 28 (undivided Andhra Pradesh), which only old GSTINs and invoices carry.
 */
export const CURRENT_GST_STATES: readonly GstState[] = GST_STATES.filter((state) => !state.legacy);

/** True for a state code in use today, e.g. "36" (Telangana). */
export function isCurrentGstStateCode(code: string): boolean {
  return isGstStateCode(code) && !gstState(code).legacy;
}

/** The state's name for a code (legacy ones too), or undefined for an unknown code. */
export function gstStateName(code: string): string | undefined {
  return isGstStateCode(code) ? gstState(code).name : undefined;
}

/** How a store is registered under GST. */
export const GST_REGISTRATION_TYPES = ['regular', 'composition', 'unregistered'] as const;
export type GstRegistrationType = (typeof GST_REGISTRATION_TYPES)[number];

/** One period of a tax category's rate; `effectiveTo` null = still in force. */
export interface TaxRateView {
  readonly id: string;
  readonly rateBps: number;
  /** India-time calendar dates, YYYY-MM-DD, both inclusive. */
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** A tax category with its full rate history, oldest first. */
export interface TaxCategoryView {
  readonly id: string;
  readonly key: string | null;
  readonly name: string;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  /** The rate in force today (India time), or null before the first rate starts. */
  readonly currentRateBps: number | null;
  readonly rates: TaxRateView[];
}

/** An active tax category for pickers (product forms). */
export interface TaxCategoryOption {
  readonly id: string;
  /** Set on the categories every business starts with, e.g. "paints". */
  readonly key: string | null;
  readonly name: string;
  readonly isDefault: boolean;
  readonly currentRateBps: number | null;
}

/** What the product form needs: the choices, and whether one must be picked. */
export interface TaxCategoryOptions {
  /** True once any store has a GST registration: new products then need a tax category. */
  readonly gstRegistered: boolean;
  readonly categories: TaxCategoryOption[];
}

/** A store's GST registration. */
export interface StoreGstRegistration {
  readonly storeId: string;
  readonly code: string;
  readonly name: string;
  readonly registrationType: GstRegistrationType;
  readonly stateCode: string | null;
  readonly gstin: string | null;
  readonly legalName: string | null;
  readonly tradeName: string | null;
  readonly addressLine: string | null;
  readonly city: string | null;
  readonly pincode: string | null;
}

/** The business's GST profile: its defaults and every store's registration. */
export interface GstRegistrations {
  readonly legalName: string | null;
  /** Derived from the stores' GSTINs (all share one PAN); null until one is registered. */
  readonly pan: string | null;
  readonly stores: StoreGstRegistration[];
}

/**
 * The rate in force on `date` (YYYY-MM-DD), or null when none is. Dates compare
 * as strings because they are zero-padded ISO dates.
 */
export function taxRateOn(rates: readonly TaxRateView[], date: string): number | null {
  const rate = rates.find(
    (candidate) =>
      candidate.effectiveFrom <= date &&
      (candidate.effectiveTo === null || date <= candidate.effectiveTo),
  );
  return rate ? rate.rateBps : null;
}
