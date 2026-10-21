/**
 * Paint data (MVP 2, Sell & Bill, round 5a; spec §3.3, §3.5, §6.2, §6.3): the
 * paint fields of a product, tint records and the shade history, and paint
 * estimates with their surfaces and good / better / best options — the request
 * and response shapes of the API and the rules both the API and the screens
 * apply. Every amount is integer paise, every quantity a number with at most 3
 * decimals, every area and length a number with at most 2 decimals, every
 * date an India-time `YYYY-MM-DD` and every instant an ISO timestamp.
 *
 * Paint fields are optional: hardware (brushes, hinges, tape) has no coverage,
 * no coats and is never tinted.
 *
 * Validation limits the API enforces are exported as constants so the screens
 * can check the same thing before sending (the API keeps its own zod schemas).
 */
import type { ListPageInfo } from './list-page.js';
import type { NamedRef, PartyRef, QuotationStatus, SalesOrderStatus } from './orders-api.js';
import type { Permission } from './permissions.js';
import type { TaxDocumentStatus } from './tax-documents.js';

// Product paint fields (spec §3.5) ---------------------------------------------

/** Brand data sheets quote coverage in m² per litre; one m² is this many sq ft. */
export const SQFT_PER_SQM = 10.7639;
/** `products.coverage_sqft_per_litre` is numeric(6,2): more than 0, at most this. */
export const MAX_COVERAGE_SQFT_PER_LITRE = 9999.99;
/** Coats (a product's default, or a surface's): whole numbers in this range. */
export const MIN_COATS = 1;
export const MAX_COATS = 5;
/** Coats used when neither the surface nor the product says. */
export const FALLBACK_COATS = 2;

/** The product types that usually carry coverage and coats (the form's hint; never enforced). */
export const PAINT_PRODUCT_TYPES = [
  'interior_paint',
  'exterior_paint',
  'primer',
  'enamel',
  'wood_finish',
  'waterproofing',
  'texture',
] as const;

/**
 * A product's paint fields, on every product the API returns (GET /products,
 * GET /products/:id, lookup). All null / false for hardware.
 */
export interface ProductPaintFields {
  /** Square feet one litre covers in one coat; null when not paint (or not yet known). */
  readonly coverageSqftPerLitre: number | null;
  /** Coats the estimator uses when a surface does not say; null = FALLBACK_COATS. */
  readonly defaultCoats: number | null;
  /** Its packs are bases a shade is tinted into at the counter (spec §6.3). */
  readonly isTintable: boolean;
}

/**
 * POST /products takes these (all optional: null / false when left out);
 * PATCH /products/:id takes any of them, null clearing a number. Needs
 * `catalog:manage`.
 */
export interface ProductPaintChanges {
  readonly coverageSqftPerLitre?: number | null;
  readonly defaultCoats?: number | null;
  readonly isTintable?: boolean;
}

/** m² per litre (as data sheets print it) → sq ft per litre, to 2 decimals. */
export function coverageSqftFromSqm(sqmPerLitre: number): number {
  return Math.round(sqmPerLitre * SQFT_PER_SQM * 100) / 100;
}

/** True when `value` has at most 2 decimals (as `numeric(_,2)` stores it). */
export function hasAtMostTwoDecimals(value: number): boolean {
  return Math.abs(Math.round(value * 100) - value * 100) < 1e-6;
}

// Tint records (spec §6.3) -------------------------------------------------------

/** The kind of line a tint record is on: a quotation, sales order or invoice line. */
export const TINT_LINE_KINDS = ['quotation_line', 'sales_order_line', 'invoice_line'] as const;
export type TintLineKind = (typeof TINT_LINE_KINDS)[number];

/**
 * Who may tint a line: quotation and order lines are `sales:manage`, invoice
 * lines (bills of supply too) `billing:issue`. Reading the history needs `sales:read`.
 */
export const TINT_PERMISSION: Readonly<Record<TintLineKind, Permission>> = {
  quotation_line: 'sales:manage',
  sales_order_line: 'sales:manage',
  invoice_line: 'billing:issue',
};
export const TINT_READ_PERMISSION: Permission = 'sales:read';

/** Units a tinting machine doses colorant in. */
export const COLORANT_UNITS = ['ml', 'shot', 'y', 'g'] as const;
export type ColorantUnit = (typeof COLORANT_UNITS)[number];

/** Text and list limits. */
export const SHADE_CODE_MAX_LENGTH = 40;
export const SHADE_NAME_MAX_LENGTH = 80;
export const TINT_MACHINE_MAX_LENGTH = 80;
export const TINT_NOTE_MAX_LENGTH = 500;
export const COLORANT_MAX_LENGTH = 40;
export const MAX_FORMULA_COMPONENTS = 16;

/**
 * A shade code as stored and matched: trimmed, inner spaces collapsed, upper
 * case ("x 132 " → "X 132"). Returns null when blank or too long.
 */
export function normalizeShadeCode(input: string): string | null {
  const code = input.trim().replace(/\s+/g, ' ').toUpperCase();
  return code === '' || code.length > SHADE_CODE_MAX_LENGTH ? null : code;
}

/** One colorant of a shade's formula, per pack, as the machine doses it. */
export interface TintFormulaComponent {
  /** The colorant's code or name on the machine, e.g. "XY" or "Fast Red". */
  readonly colorant: string;
  /** More than 0, at most 3 decimals. */
  readonly amount: number;
  readonly unit: ColorantUnit;
  /**
   * The colorant product (stocked loose, by the ml or g) this dose comes out of
   * when the pack leaves the store (round 8a); absent: recorded, not deducted.
   */
  readonly colorantVariantId?: string;
}

/**
 * POST /tint-records (`Idempotency-Key` header): the shade a line's base is
 * tinted to. The line's document must be a draft (a quotation, sales order or
 * invoice / bill of supply not yet sent, confirmed or issued), its product
 * `isTintable`, and the member able to write it (TINT_PERMISSION) at its
 * store. One tint record per line: tint again by deleting it first.
 *
 * The store, party, site and base variant are the line's (the party and site
 * are its document's bill-to and project). This adds a tint to a line already
 * saved; a line can also carry its tint in the document's own payload
 * (LineTintRequest on POST/PUT of a quotation, order or invoice draft), which
 * is how a re-saved draft keeps its shades. Converting a quotation, revising
 * it, and billing an order carry a line's tint record to the new line.
 *
 * Pricing is not changed here: the line's unit price is the base price plus
 * the tinting charge (spec §6.3), which the screen sends with the line.
 */
export interface TintRecordRequest {
  readonly lineKind: TintLineKind;
  readonly lineId: string;
  /** Normalised by normalizeShadeCode; 1 to SHADE_CODE_MAX_LENGTH characters. */
  readonly shadeCode: string;
  readonly shadeName?: string;
  /** The shade card's brand; defaults to the base product's brand. */
  readonly brandId?: string;
  /** Packs tinted: more than 0, at most the line's quantity (its default). */
  readonly packQuantity?: number;
  /** What the colorant cost per pack, kept for margin only (never billed). */
  readonly colorantCostPaise?: number;
  /** The tinting charge per pack, included in the line's unit price. Defaults to 0. */
  readonly tintChargePaise?: number;
  /** Free text until machines are integrated (Release 2.4). */
  readonly machine?: string;
  /** Up to MAX_FORMULA_COMPONENTS colorants. */
  readonly formula?: readonly TintFormulaComponent[];
  readonly note?: string;
}

/** The document a tinted line belongs to. */
export type TintDocumentKind = 'quotation' | 'sales_order' | 'invoice';

export interface TintDocumentRef {
  readonly kind: TintDocumentKind;
  readonly id: string;
  /** QT-…, SO-…, or the invoice number (null while an invoice is a draft). */
  readonly number: string | null;
  /** The document's own status (a quotation's as stored, not effectiveQuotationStatus). */
  readonly status: QuotationStatus | SalesOrderStatus | TaxDocumentStatus;
  /** The invoice's issue date, else the day the document was created (India time). */
  readonly date: string;
}

/** A tint record (GET /tint-records/:id, and the items of GET /tint-records). */
export interface TintRecordView {
  readonly id: string;
  readonly lineKind: TintLineKind;
  readonly lineId: string;
  readonly document: TintDocumentRef;
  /** Where it was tinted. */
  readonly store: NamedRef;
  /** The bill-to; null on a walk-in bill with no party. */
  readonly party: (PartyRef & { readonly phone: string | null }) | null;
  /** The site. */
  readonly project: NamedRef | null;
  readonly brand: NamedRef;
  readonly shadeCode: string;
  readonly shadeName: string | null;
  /** The base: the line's variant ("Apex Ultima Pastel Base 4 l"). */
  readonly baseVariant: {
    readonly id: string;
    readonly productId: string;
    readonly sku: string;
    readonly description: string;
    readonly isActive: boolean;
  };
  readonly packQuantity: number;
  readonly colorantCostPaise: number | null;
  readonly tintChargePaise: number;
  readonly machine: string | null;
  readonly formula: readonly TintFormulaComponent[];
  readonly note: string | null;
  readonly createdByMemberId: string;
  readonly createdAt: string;
}

/**
 * A line's tint sent with the line itself: the optional `tint` of each line of
 * POST/PUT /quotations, POST/PUT /sales-orders and POST/PUT /invoices (drafts).
 * The server writes it in the same transaction as the lines, with the rules of
 * POST /tint-records (tintable base, packs at most the line's quantity, known
 * brand); an invalid tint refuses the whole save (400, path
 * `lines.<n>.tint.<field>`). A PUT replaces every line, so a line re-sent
 * without `tint` is untinted: resend the tint of each line to keep it.
 */
export type LineTintRequest = Omit<TintRecordRequest, 'lineKind' | 'lineId'>;

/**
 * A line's tint as read with the line (the `tint` of SalesLineView and
 * TaxDocumentLineView; absent when the line is untinted).
 */
export type LineTintView = Pick<
  TintRecordView,
  | 'id'
  | 'brand'
  | 'shadeCode'
  | 'shadeName'
  | 'packQuantity'
  | 'colorantCostPaise'
  | 'tintChargePaise'
  | 'machine'
  | 'formula'
  | 'note'
  | 'createdAt'
>;

/** The tint read with a line, as it is sent back on re-save (resume a held bill, edit a draft). */
export function lineTintRequest(view: LineTintView): LineTintRequest {
  return {
    shadeCode: view.shadeCode,
    brandId: view.brand.id,
    packQuantity: view.packQuantity,
    tintChargePaise: view.tintChargePaise,
    formula: view.formula,
    ...(view.shadeName === null ? {} : { shadeName: view.shadeName }),
    ...(view.colorantCostPaise === null ? {} : { colorantCostPaise: view.colorantCostPaise }),
    ...(view.machine === null ? {} : { machine: view.machine }),
    ...(view.note === null ? {} : { note: view.note }),
  };
}

/**
 * GET /tint-records?partyId&projectId&shadeCode&q&storeId&billed&documentKind&documentId&limit&offset
 * (`sales:read`), newest first: the shade history of the WHOLE business, every
 * store — a repeat order at Kukatpally finds the shade billed at Ameerpet. A
 * branch member sees other stores' records too (the shade and where it was
 * tinted); the documents themselves stay limited to their stores.
 *
 * - `partyId` also finds records of parties merged into it.
 * - `shadeCode` matches exactly (after normalizeShadeCode).
 * - `q` matches part of the shade code or name, the party's name, or the
 *   party's mobile (any 10-digit Indian mobile or E.164 number matches exactly).
 * - `billed=true` keeps records on issued invoices only ("billed last time").
 * - `documentKind` + `documentId` (both or neither) list one document's tints,
 *   e.g. to show them on a quotation, order or invoice's lines.
 */
export interface TintRecordQuery {
  readonly partyId?: string;
  readonly projectId?: string;
  readonly shadeCode?: string;
  readonly q?: string;
  readonly storeId?: string;
  readonly billed?: boolean;
  readonly documentKind?: TintDocumentKind;
  readonly documentId?: string;
  /** 1 to 200, default 50. */
  readonly limit?: number;
  readonly offset?: number;
}

export interface TintRecordPage {
  readonly items: readonly TintRecordView[];
  readonly total: number;
}

// Estimates (spec §6.2) ----------------------------------------------------------

/** `draft` is edited and computed; `converted` became a quotation and is final. */
export const ESTIMATE_STATUSES = ['draft', 'converted'] as const;
export type EstimateStatus = (typeof ESTIMATE_STATUSES)[number];

export const SURFACE_KINDS = ['interior_wall', 'ceiling', 'exterior', 'wood', 'metal'] as const;
export type SurfaceKind = (typeof SURFACE_KINDS)[number];

export const SURFACE_CONDITIONS = ['new', 'repaint', 'damaged'] as const;
export type SurfaceCondition = (typeof SURFACE_CONDITIONS)[number];

export const ESTIMATE_TIERS = ['good', 'better', 'best'] as const;
export type EstimateTier = (typeof ESTIMATE_TIERS)[number];

/** What an option line is for. */
export const ESTIMATE_LINE_PURPOSES = ['paint', 'primer', 'putty'] as const;
export type EstimateLinePurpose = (typeof ESTIMATE_LINE_PURPOSES)[number];

/** Who may write estimates; reading needs `sales:read`. */
export const ESTIMATES_PERMISSION: Permission = 'sales:manage';
/** Number prefix: `ES-000007`. */
export const ESTIMATE_NUMBER_PREFIX = 'ES';
/** Wastage added to litres (spec §6.2: a setting, default 5 %), in basis points. */
export const DEFAULT_WASTAGE_BPS = 500;
export const MAX_WASTAGE_BPS = 5000;
/** Limits. */
export const MAX_ESTIMATE_SURFACES = 100;
export const ESTIMATE_TITLE_MAX_LENGTH = 120;
export const ROOM_MAX_LENGTH = 60;
export const ESTIMATE_NOTE_MAX_LENGTH = 500;
/** A length or height: more than 0, at most this many feet, at most 2 decimals. */
export const MAX_SURFACE_DIMENSION_FT = 1000;
/** An area (or the openings): at most this many sq ft, at most 2 decimals. */
export const MAX_SURFACE_AREA_SQFT = 1_000_000;

/** Area in hundredths of a sq ft, so 2-decimal areas add and multiply exactly. */
const centi = (value: number) => Math.round(value * 100);

/** One surface's size: an area, or a length × height. */
export interface SurfaceSize {
  readonly areaSqft?: number | null;
  readonly lengthFt?: number | null;
  readonly heightFt?: number | null;
  readonly openingsSqft?: number | null;
}

/** Gross area in sq ft: the area given, else length × height (2 decimals, rounded half up). */
export function surfaceGrossAreaSqft(size: SurfaceSize): number {
  if (size.areaSqft != null) return centi(size.areaSqft) / 100;
  const product = centi(size.lengthFt ?? 0) * centi(size.heightFt ?? 0);
  return Math.round(product / 100) / 100;
}

/** Net area in sq ft: gross − openings, never below 0. */
export function surfaceNetAreaSqft(size: SurfaceSize): number {
  return Math.max(0, centi(surfaceGrossAreaSqft(size)) - centi(size.openingsSqft ?? 0)) / 100;
}

/**
 * The primer and putty a surface gets when the request does not say (spec
 * §6.2): primer on new or damaged surfaces; putty on new or damaged interior
 * walls and ceilings.
 */
export function defaultSurfaceTreatment(
  kind: SurfaceKind,
  condition: SurfaceCondition,
): { readonly primer: boolean; readonly putty: boolean } {
  const fresh = condition !== 'repaint';
  return { primer: fresh, putty: fresh && (kind === 'interior_wall' || kind === 'ceiling') };
}

/** The coats a surface gets: its own, else the product's default, else FALLBACK_COATS. */
export function coatsFor(surfaceCoats: number | null, productDefaultCoats: number | null): number {
  return surfaceCoats ?? productDefaultCoats ?? FALLBACK_COATS;
}

/**
 * One surface of an estimate: either `areaSqft`, or `lengthFt` and `heightFt`
 * (not both). Openings (doors, windows) are deducted, never more than the
 * gross area.
 */
export interface EstimateSurfaceRequest {
  /** e.g. "Living room", 1 to ROOM_MAX_LENGTH characters. */
  readonly room: string;
  readonly kind: SurfaceKind;
  readonly areaSqft?: number;
  readonly lengthFt?: number;
  readonly heightFt?: number;
  /** Defaults to 0. */
  readonly openingsSqft?: number;
  readonly condition: SurfaceCondition;
  /** MIN_COATS to MAX_COATS; left out = the product's default (see coatsFor). */
  readonly coats?: number;
  /** Left out = defaultSurfaceTreatment. */
  readonly primer?: boolean;
  readonly putty?: boolean;
}

/**
 * One tier's product choices. The paint (and primer) product must be active
 * and have `coverageSqftPerLitre`; the putty product must be active.
 */
export interface EstimateOptionRequest {
  readonly tier: EstimateTier;
  readonly productId: string;
  readonly primerProductId?: string;
  readonly puttyProductId?: string;
}

/**
 * POST /estimates (`Idempotency-Key` header) and PUT /estimates/:id (draft
 * only; header, surfaces and options all replaced, which clears every
 * option's computed result). Needs ESTIMATES_PERMISSION at the store.
 */
export interface EstimateRequest {
  readonly storeId: string;
  /** The customer; needed by the time it is converted into a quotation. */
  readonly partyId?: string;
  /** The site. */
  readonly projectId?: string;
  readonly title?: string;
  /** 0 to MAX_WASTAGE_BPS; defaults to DEFAULT_WASTAGE_BPS. */
  readonly wastageBps?: number;
  readonly note?: string;
  /** 1 to MAX_ESTIMATE_SURFACES surfaces, kept in this order. */
  readonly surfaces: readonly EstimateSurfaceRequest[];
  /** 0 to 3 options, one per tier. */
  readonly options?: readonly EstimateOptionRequest[];
}

export interface EstimateSurfaceView {
  readonly id: string;
  /** 1, 2, 3… in the order sent. */
  readonly position: number;
  readonly room: string;
  readonly kind: SurfaceKind;
  readonly areaSqft: number | null;
  readonly lengthFt: number | null;
  readonly heightFt: number | null;
  readonly openingsSqft: number;
  readonly condition: SurfaceCondition;
  /** As saved; null = the product's default. */
  readonly coats: number | null;
  readonly primer: boolean;
  readonly putty: boolean;
  /** surfaceGrossAreaSqft / surfaceNetAreaSqft. */
  readonly grossAreaSqft: number;
  readonly netAreaSqft: number;
}

/** A product an option uses, with what the estimator needs of it. */
export interface EstimateProductRef extends NamedRef {
  readonly brandName: string;
  readonly coverageSqftPerLitre: number | null;
  readonly defaultCoats: number | null;
  readonly isActive: boolean;
}

/** One line of an option's pack mix, as the estimator priced it. */
export interface EstimateOptionLine {
  readonly purpose: EstimateLinePurpose;
  readonly variantId: string;
  readonly sku: string;
  readonly description: string;
  /** Packs; a whole number. */
  readonly quantity: number;
  readonly unitPricePaise: number;
  /** quantity × unitPricePaise. */
  readonly totalPaise: number;
}

/** What POST /estimates/:id/compute (built after 5a) stores for an option. */
export interface EstimateOptionResult {
  /** Paint litres needed (with wastage), 3 decimals. */
  readonly litres: number;
  readonly lines: readonly EstimateOptionLine[];
  /** Σ line totals (selling prices, tax inclusive as the quotation will price them). */
  readonly totalPaise: number;
  readonly computedAt: string;
}

export interface EstimateOptionView {
  readonly id: string;
  readonly tier: EstimateTier;
  readonly product: EstimateProductRef;
  readonly primerProduct: EstimateProductRef | null;
  readonly puttyProduct: EstimateProductRef | null;
  /** Null until computed, and again after any change to the estimate. */
  readonly result: EstimateOptionResult | null;
}

/** An estimate (POST, PUT, GET /estimates/:id). */
export interface EstimateView {
  readonly id: string;
  /** e.g. `ES-000007`. */
  readonly number: string;
  readonly status: EstimateStatus;
  readonly storeId: string;
  readonly party: (PartyRef & { readonly phone: string | null }) | null;
  readonly project: NamedRef | null;
  readonly title: string | null;
  readonly wastageBps: number;
  readonly note: string | null;
  /** Σ net area of every surface. */
  readonly totalNetAreaSqft: number;
  readonly surfaces: readonly EstimateSurfaceView[];
  /** In tier order (good, better, best). */
  readonly options: readonly EstimateOptionView[];
  /** Set when converted. */
  readonly quotationId: string | null;
  readonly quotationNumber: string | null;
  readonly convertedTier: EstimateTier | null;
  readonly convertedAt: string | null;
  readonly createdByMemberId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EstimateSummary {
  readonly id: string;
  readonly number: string;
  readonly status: EstimateStatus;
  readonly storeId: string;
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly projectId: string | null;
  readonly title: string | null;
  readonly totalNetAreaSqft: number;
  readonly quotationId: string | null;
  readonly createdAt: string;
}

/**
 * GET /estimates?storeId&partyId&projectId&status&q&limit&offset (`sales:read`),
 * newest first, at the stores the member works at. `q` matches the number, the
 * title or the party's name. DELETE /estimates/:id removes a draft (204).
 */
export interface EstimatePage extends ListPageInfo {
  readonly items: readonly EstimateSummary[];
}

/**
 * Contract only, built after round 5a (5a ships the tables and CRUD, not these
 * endpoints): POST /estimates/:id/compute runs the estimator for every option
 * of a draft and stores each EstimateOptionResult (returns EstimateView). POST
 * /estimates/:id/convert (`Idempotency-Key`) copies the chosen tier's computed
 * lines into a new draft quotation for the estimate's party and site, and marks
 * the estimate `converted` with `quotationId`, `convertedTier` and
 * `convertedAt` (returns QuotationView).
 */
export interface ConvertEstimateRequest {
  readonly tier: EstimateTier;
  /** Defaults to the quotation default (today + quoteValidityDays). */
  readonly validUntil?: string;
  readonly note?: string;
}
