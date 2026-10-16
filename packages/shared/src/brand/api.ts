import type { ClaimsAgeingRow, SchemeClaim } from './claims.js';
import type { StockUpPlan } from './price-hike.js';
import type { SchemeProgress } from './progress.js';
import type { SlabBenefit, SlabMeasure, SlabMode } from './scheme.js';

/**
 * Brand schemes as the API answers and the screens read them (P2-M33, round 5a;
 * docs/mvp-3/credit-and-receivables.md §6.3). Money in paise, paint in millilitres,
 * dates India-time `YYYY-MM-DD`.
 */

export const SCHEME_STATUSES = ['draft', 'active', 'closed', 'cancelled'] as const;
/** `draft` is not counted; `active` counts; `closed` expects nothing more; `cancelled` withdrawn. */
export type SchemeStatus = (typeof SCHEME_STATUSES)[number];

export const SCHEME_DATE_BASES = ['grn_date', 'invoice_date'] as const;
/** Which day puts a GRN in a scheme's period ([CA-21]); invoice date falls back to the GRN's. */
export type SchemeDateBasis = (typeof SCHEME_DATE_BASES)[number];

export const BRAND_CLAIM_STATUSES = [
  'filed',
  'acknowledged',
  'settled',
  'rejected',
  'withdrawn',
] as const;
export type BrandClaimStatus = (typeof BRAND_CLAIM_STATUSES)[number];

export const BENEFIT_MONEY_FORMS = ['credit_note', 'payment'] as const;
/** How scheme money came ([CA-6]). */
export type BenefitMoneyForm = (typeof BENEFIT_MONEY_FORMS)[number];

interface Named {
  readonly id: string;
  readonly name: string;
}

/** POST /brand-schemes and PUT /brand-schemes/:id: the whole scheme, slabs included. */
export interface SchemeInput {
  readonly brandId: string;
  readonly name: string;
  readonly brandReference: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly measure: SlabMeasure;
  readonly mode: SlabMode;
  /** Null for 45 days ([PO-32]). */
  readonly settlementDays: number | null;
  readonly dateBasis: SchemeDateBasis;
  readonly note: string | null;
  /** Both empty: every product of the brand. */
  readonly productIds: readonly string[];
  readonly categoryIds: readonly string[];
  /** Rising targets, paise (value) or millilitres (litres). */
  readonly slabs: readonly { readonly target: number; readonly benefits: readonly SlabBenefit[] }[];
}

/** A slab benefit; free goods name their pack. */
export type SchemeBenefitView = SlabBenefit & { readonly variantTitle?: string };

export interface SchemeSlabView {
  readonly id: string;
  readonly position: number;
  readonly target: number;
  readonly benefits: readonly SchemeBenefitView[];
}

export interface SchemeView {
  readonly id: string;
  readonly brand: Named;
  readonly name: string;
  readonly brandReference: string | null;
  readonly startsOn: string;
  readonly endsOn: string;
  readonly measure: SlabMeasure;
  readonly mode: SlabMode;
  readonly settlementDays: number | null;
  readonly dateBasis: SchemeDateBasis;
  readonly status: SchemeStatus;
  readonly note: string | null;
  readonly products: readonly Named[];
  readonly categories: readonly Named[];
  readonly slabs: readonly SchemeSlabView[];
  readonly endedAt: string | null;
  readonly endNote: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A scheme in the list, with where it stands today. */
export interface SchemeSummary {
  readonly scheme: SchemeView;
  readonly progress: SchemeProgress;
  readonly claim: SchemeClaim;
}

/** A GRN line (or a purchase return, negative) a scheme counts. */
export interface SchemeGrnLineView {
  readonly kind: 'receipt' | 'return';
  /** The GRN, or for a return the stock movement. */
  readonly sourceId: string;
  readonly number: string;
  readonly receivedOn: string;
  readonly supplierInvoiceDate: string | null;
  /** The day the scheme counts it on (its date basis). */
  readonly countedOn: string;
  readonly store: { readonly id: string; readonly code: string };
  readonly supplierName: string | null;
  readonly variantId: string;
  readonly sku: string;
  readonly productName: string;
  readonly quantity: number;
  /** Scheme-free units: litres only, no value [CA-4]. */
  readonly freeQuantity: number;
  readonly unitCostPaise: number | null;
  readonly valuePaise: number;
  readonly millilitres: number;
  readonly freeMillilitres: number;
}

export interface BenefitReceiptView {
  readonly id: string;
  readonly kind: 'money' | 'free_goods' | 'points';
  readonly receivedOn: string;
  readonly amountPaise: number | null;
  readonly moneyForm: BenefitMoneyForm | null;
  readonly variant: { readonly id: string; readonly title: string } | null;
  readonly units: number | null;
  readonly goodsReceipt: { readonly id: string; readonly number: string } | null;
  readonly label: string | null;
  readonly points: number | null;
  readonly reference: string | null;
  readonly note: string | null;
  readonly claim: { readonly id: string; readonly number: string } | null;
  readonly recordedBy: string;
  readonly createdAt: string;
}

/** POST /brand-schemes/:id/receipts. */
export type BenefitReceiptInput =
  | {
      readonly kind: 'money';
      readonly receivedOn: string;
      readonly amountPaise: number;
      readonly moneyForm: BenefitMoneyForm;
      readonly reference: string | null;
      readonly note: string | null;
      readonly claimId: string | null;
    }
  | {
      readonly kind: 'free_goods';
      readonly receivedOn: string;
      readonly variantId: string;
      readonly units: number;
      readonly goodsReceiptId: string | null;
      readonly reference: string | null;
      readonly note: string | null;
      readonly claimId: string | null;
    }
  | {
      readonly kind: 'points';
      readonly receivedOn: string;
      readonly label: string;
      readonly points: number;
      readonly reference: string | null;
      readonly note: string | null;
      readonly claimId: string | null;
    };

export interface BrandClaimView {
  readonly id: string;
  readonly number: string;
  readonly schemeId: string;
  readonly filedOn: string;
  readonly claimedPaise: number;
  readonly brandReference: string | null;
  readonly note: string | null;
  readonly status: BrandClaimStatus;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
  readonly filedBy: string;
}

/** GET /brand-schemes/:id: the scheme, its progress, what it counted and what came. */
export interface SchemeDetail extends SchemeSummary {
  readonly grnLines: readonly SchemeGrnLineView[];
  readonly receipts: readonly BenefitReceiptView[];
  readonly claims: readonly BrandClaimView[];
}

/** A scheme's claim in the claims list. */
export interface SchemeClaimRow {
  readonly scheme: {
    readonly id: string;
    readonly name: string;
    readonly brand: Named;
    readonly status: SchemeStatus;
    readonly startsOn: string;
    readonly endsOn: string;
  };
  readonly claim: SchemeClaim;
  /** The latest claim filed with the brand, if any. */
  readonly filed: BrandClaimView | null;
}

/** GET /brand-schemes/claims: expected vs received per scheme, with ageing. */
export interface SchemeClaimsReport {
  readonly asOf: string;
  readonly ageing: readonly ClaimsAgeingRow[];
  readonly rows: readonly SchemeClaimRow[];
}

/** GET /brand-schemes/overview: the dashboard tile. */
export interface SchemesOverview {
  readonly asOf: string;
  readonly activeSchemes: number;
  /** The running scheme closest to its next slab, measured in days of buying left. */
  readonly nearest: {
    readonly schemeId: string;
    readonly schemeName: string;
    readonly brandName: string;
    readonly measure: SlabMeasure;
    readonly distance: number;
    readonly perDayNeeded: number | null;
    readonly remainingDays: number;
  } | null;
  /** Money still owed by brands on active and closed-period schemes (not below 0 each). */
  readonly outstandingPaise: number;
  readonly openClaims: number;
  readonly overdueClaims: number;
}

/** POST /brand-schemes/price-hike-plan. */
export interface PriceHikePlanInput {
  readonly brandId: string;
  readonly hikeBasisPoints: number;
  readonly effectiveOn: string;
  /** Only these products or categories; both empty for the whole brand. */
  readonly productIds: readonly string[];
  readonly categoryIds: readonly string[];
  /** One store's stock and sales; null for the whole business. */
  readonly storeId: string | null;
  /** Days of sales the rate is taken over (default 90). */
  readonly salesWindowDays: number;
  readonly holdingCostBps: number;
  readonly costOfMoneyBps: number;
  readonly deadStockRiskBps: number;
  readonly maxCoverDays: number;
}

export interface PriceHikePlanView {
  readonly asOf: string;
  readonly brand: Named;
  readonly plan: StockUpPlan;
  /** Per line of the plan, in its order: what the SKU is and what fed the plan. */
  readonly skus: readonly {
    readonly variantId: string;
    readonly sku: string;
    readonly productName: string;
    readonly unitCostPaise: number;
    readonly stockUnits: number;
    readonly soldUnits: number;
  }[];
  /** Packs left out: no cost known to plan with. */
  readonly withoutCost: number;
}
