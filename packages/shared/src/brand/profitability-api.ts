import type { Permission } from '../permissions.js';
import { addDays, dayNumber } from '../receivables/dates.js';
import type { MarginFigures } from './margin.js';

// The brand profitability API (roadmap P2-M35, MVP 3 spec §6.3). Amounts in paise.

/**
 * Who sees brand profitability: it shows cost, margin and receivables together,
 * so it is the business's books. No permission guards margins yet, and a new one
 * needs a migration granting it ([PO-80]), so it reuses the books export's, held
 * by owners and organisation admins.
 */
export const BRAND_PROFITABILITY_PERMISSION = 'accounting:export' as const satisfies Permission;

/** How the table splits each brand: not at all, by product or by store. */
export const PROFITABILITY_GROUPS = ['brand', 'product', 'store'] as const;
export type ProfitabilityGroup = (typeof PROFITABILITY_GROUPS)[number];

/** What one loyalty or painter point costs the business by default, in paise ([PO-81]): ₹1. */
export const DEFAULT_POINT_VALUE_PAISE = 100;

/** The longest period one report covers, in days (a financial year). */
export const PROFITABILITY_MAX_DAYS = 366;

/** GET /reports/brand-profitability. */
export interface BrandProfitabilityQuery {
  /** First day (India date); with `to`, or both left out for the last quarter. */
  readonly from?: string;
  readonly to?: string;
  readonly storeId?: string;
  readonly brandId?: string;
  readonly productId?: string;
  readonly groupBy?: ProfitabilityGroup;
  /** The cost of money a year in basis points; the business's setting ([PO-5]) when left out. */
  readonly costOfMoneyBps?: number;
  /** Paise per point; the business's setting when left out. */
  readonly pointValuePaise?: number;
}

/** One product or store of a brand, with its figures. */
export interface ProfitabilitySliceView extends MarginFigures {
  /** The product (product grouping); null for scheme money with no sales to spread over. */
  readonly productId: string | null;
  readonly productName: string | null;
  /** The store (store grouping); null as for products. */
  readonly storeId: string | null;
  readonly storeCode: string | null;
  readonly storeName: string | null;
}

export interface BrandProfitabilityRow {
  readonly brandId: string;
  readonly brandName: string;
  readonly figures: MarginFigures;
  /** Invoice lines whose product had no average cost when sold (counted at zero cost). */
  readonly uncostedLines: number;
  /** Its products or stores, most contribution first; empty when grouped by brand. */
  readonly slices: readonly ProfitabilitySliceView[];
}

export interface BrandProfitabilityView {
  readonly from: string;
  readonly to: string;
  readonly groupBy: ProfitabilityGroup;
  /** The cost of money and point value used: the request's, else the business's settings. */
  readonly costOfMoneyBps: number;
  readonly pointValuePaise: number;
  /** The business's stored settings. */
  readonly settings: ProfitabilitySettings;
  /** False while scheme money is not counted yet (the schemes module is not connected). */
  readonly schemesCounted: boolean;
  /** Brands, most contribution first. */
  readonly brands: readonly BrandProfitabilityRow[];
  readonly total: MarginFigures;
  readonly uncostedLines: number;
}

/** The calendar quarter before the one `today` (YYYY-MM-DD) falls in: India's FY quarters. */
export function previousQuarter(today: string): { from: string; to: string } {
  dayNumber(today);
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const quarterStart = Math.floor((month - 1) / 3) * 3 + 1;
  const thisQuarter = `${String(year)}-${String(quarterStart).padStart(2, '0')}-01`;
  const startMonth = quarterStart === 1 ? 10 : quarterStart - 3;
  const startYear = quarterStart === 1 ? year - 1 : year;
  return {
    from: `${String(startYear)}-${String(startMonth).padStart(2, '0')}-01`,
    to: addDays(thisQuarter, -1),
  };
}

/** The calendar quarter `today` falls in, from its first day to today. */
export function currentQuarter(today: string): { from: string; to: string } {
  dayNumber(today);
  const month = Number(today.slice(5, 7));
  const quarterStart = Math.floor((month - 1) / 3) * 3 + 1;
  return { from: `${today.slice(0, 4)}-${String(quarterStart).padStart(2, '0')}-01`, to: today };
}

/** Who changes the business's profitability settings: owners and admins, as other business settings. */
export const PROFITABILITY_SETTINGS_PERMISSION =
  'organization:manage' as const satisfies Permission;

/**
 * The business's own figures for brand profitability (migration 0086): its cost of
 * money ([PO-5], `sales_settings`) and what a point costs it (`loyalty_settings`).
 * A request may override either.
 */
export interface ProfitabilitySettings {
  readonly costOfMoneyBps: number;
  readonly pointValuePaise: number;
}

/** PUT /reports/brand-profitability/settings: either or both. */
export type ProfitabilitySettingsInput = Partial<ProfitabilitySettings>;
