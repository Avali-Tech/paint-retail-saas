/**
 * Quotations, sales orders, stock reservations, dispatches and the billing
 * go-live cut-over (MVP 2, Sell & Bill, round 4a; spec §3.3, §4.1–§4.4, §4.7,
 * §5.1, §5.3, §6.4): the request and response shapes of the API and the rules
 * both the API and the screens apply. Every amount is integer paise, every
 * quantity a number with at most 3 decimals, every date an India-time
 * `YYYY-MM-DD` and every instant an ISO timestamp.
 *
 * Validation limits the API enforces are exported as constants so the screens
 * can check the same thing before sending (the API keeps its own zod schemas).
 */
import type { ListPageInfo } from './list-page.js';
import type { CreditCheck, CreditDecision, CreditStatus } from './credit.js';
import type { Discount } from './gst/types.js';
import type { LineTintRequest, LineTintView } from './paint-api.js';
import type { Permission } from './permissions.js';
import type { PriceMode, StockPostOn, TaxDocumentStatus } from './tax-documents.js';

// Statuses and settings -------------------------------------------------------

/**
 * A quotation version's life. Only `draft` is editable; `revise` makes a new
 * version (a draft) and marks this one `superseded`. A sent or accepted quote
 * past its `validUntil` reads as `expired` (computed, no job).
 */
export const QUOTATION_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'expired',
  'superseded',
  'converted',
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

/**
 * A sales order's life (spec §4.1): `confirmed` reserves stock;
 * `partly_fulfilled` once something is invoiced; `fulfilled` when every unit
 * is invoiced or cancelled; `cancelled` when cancelled before any billing;
 * `closed` when cancelled after part of it was billed.
 */
export const SALES_ORDER_STATUSES = [
  'draft',
  'confirmed',
  'partly_fulfilled',
  'fulfilled',
  'cancelled',
  'closed',
] as const;
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number];

/** Statuses in which an order still holds or may take stock and may be billed. */
export const OPEN_ORDER_STATUSES: readonly SalesOrderStatus[] = ['confirmed', 'partly_fulfilled'];

/**
 * How an order is paid (spec §4.4): `prepaid` — every invoice is paid in full
 * when issued; `partial` — an advance of at least `partial_min_advance_pct` is
 * on account at confirm; `postpaid` — on credit, checked at confirm.
 */
export const PAYMENT_TERMS = ['prepaid', 'partial', 'postpaid'] as const;
export type PaymentTerms = (typeof PAYMENT_TERMS)[number];

/** `open` holds stock (counts in `stock_balances.reserved`); the others are history. */
export const STOCK_RESERVATION_STATUSES = ['open', 'consumed', 'released'] as const;
export type StockReservationStatus = (typeof STOCK_RESERVATION_STATUSES)[number];

/** Who may write quotations and orders (spec §3.5). Reading needs `sales:read`. */
export const ORDERS_PERMISSION: Permission = 'sales:manage';
/** Who may confirm an order past the credit rules (spec §4.4). */
export const CREDIT_OVERRIDE_PERMISSION: Permission = 'credit:approve';
/** Who may run the go-live cut-over (spec §4.7). */
export const GO_LIVE_PERMISSION: Permission = 'organization:manage';

/** At most this many lines on a quotation or order. */
export const MAX_SALES_LINES = 200;
/** A quantity: more than 0, at most this, at most 3 decimals. */
export const MAX_LINE_QUANTITY = 1_000_000;
/** Reservations older than this many days are listed for release (spec §4.3); none is automatic. */
export const STALE_RESERVATION_DAYS = 14;
/** Number prefixes (spec §3.4): `QT-000042`, `SO-000017`, `DS-000003`. */
export const QUOTATION_NUMBER_PREFIX = 'QT';
export const SALES_ORDER_NUMBER_PREFIX = 'SO';
export const DISPATCH_NUMBER_PREFIX = 'DS';
/** Text limits. */
export const SALES_NOTE_MAX_LENGTH = 500;
export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 500;
export const VEHICLE_NO_MAX_LENGTH = 20;
/** An e-way bill number is 12 digits (Rule 138). */
export const EWAY_BILL_NO_PATTERN = /^[0-9]{12}$/;

// Rules -----------------------------------------------------------------------

/** Quantities in thousandths, so at most 3 decimals add and subtract exactly. */
const milli = (quantity: number) => Math.round(quantity * 1000);

/** True when `quantity` has at most 3 decimals (as `numeric(14,3)` stores it). */
export function hasAtMostThreeDecimals(quantity: number): boolean {
  return Math.abs(milli(quantity) - quantity * 1000) < 1e-6;
}

/** What is left of an order line to bill or cancel: quantity − invoiced − cancelled. */
export function openQuantity(line: {
  readonly quantity: number;
  readonly quantityInvoiced: number;
  readonly quantityCancelled: number;
}): number {
  return (
    (milli(line.quantity) - milli(line.quantityInvoiced) - milli(line.quantityCancelled)) / 1000
  );
}

/**
 * Where an order stands from its lines once confirmed: `fulfilled` when
 * nothing is open and something was billed, `cancelled` when nothing is open
 * and nothing was billed, else `partly_fulfilled` or `confirmed`.
 */
export function orderStatusFor(
  lines: readonly {
    readonly quantity: number;
    readonly quantityInvoiced: number;
    readonly quantityCancelled: number;
  }[],
): Extract<SalesOrderStatus, 'confirmed' | 'partly_fulfilled' | 'fulfilled' | 'cancelled'> {
  const billed = lines.some((line) => line.quantityInvoiced > 0);
  const open = lines.some((line) => openQuantity(line) > 0);
  if (open) return billed ? 'partly_fulfilled' : 'confirmed';
  return billed ? 'fulfilled' : 'cancelled';
}

/** The smallest advance a `partial` order needs: `pct` % of the total, rounded up to the paisa. */
export function minimumAdvancePaise(totalPaise: number, pct: number): number {
  return Number((BigInt(totalPaise) * BigInt(pct) + 99n) / 100n);
}

/**
 * A quotation's status as people see it on `today`: a sent or accepted quote
 * past its validity is `expired`; every other status is as stored.
 */
export function effectiveQuotationStatus(
  status: QuotationStatus,
  validUntil: string,
  today: string,
): QuotationStatus {
  return (status === 'sent' || status === 'accepted') && validUntil < today ? 'expired' : status;
}

/** What it takes to confirm a postpaid order past `checkCredit` (spec §4.4). */
export type CreditApproval = 'none' | 'manager' | 'owner' | 'blocked';

export function creditApprovalFor(decision: CreditDecision): CreditApproval {
  switch (decision) {
    case 'allowed':
      return 'none';
    case 'manager_approval':
      return 'manager';
    case 'owner_approval':
      return 'owner';
    case 'blocked':
      return 'blocked';
  }
}

/**
 * Whether a member may confirm past the credit rules in the same dialog: a
 * manager approval needs `credit:approve`; an owner approval also needs the
 * Owner role; a blocked party is never overridden (put the party on credit
 * or release the hold instead).
 */
export function canOverrideCredit(
  approval: CreditApproval,
  member: { readonly permissions: ReadonlySet<Permission>; readonly roleKey: string },
): boolean {
  if (approval === 'none') return true;
  if (approval === 'blocked' || !member.permissions.has(CREDIT_OVERRIDE_PERMISSION)) return false;
  return approval === 'manager' || member.roleKey === 'owner';
}

/** Rule 138(1): an e-way bill is needed when the consignment value (with tax) exceeds the threshold. */
export function ewayBillRequired(valuePaise: number, thresholdPaise: number): boolean {
  return valuePaise > thresholdPaise;
}

// Shared pieces ---------------------------------------------------------------

/** Where the goods go; its state is the place of supply for an unregistered buyer (spec §2.5). */
export interface ShipToRequest {
  readonly name?: string;
  readonly address?: string;
  readonly stateCode: string;
}

/** A quotation or order line. */
export interface SalesLineRequest {
  readonly variantId: string;
  readonly quantity: number;
  /** Defaults to the variant's selling price. */
  readonly unitPricePaise?: number;
  readonly discount?: Discount;
  /** The shade it is tinted to, written with the line (round 5a); left out = untinted. */
  readonly tint?: LineTintRequest;
}

/** A party, site or store by id and name. */
export interface NamedRef {
  readonly id: string;
  readonly name: string;
}
export type PartyRef = NamedRef;

export interface BillToView extends PartyRef {
  readonly gstin: string | null;
  readonly phone: string | null;
}

export interface ShipToView {
  readonly name: string | null;
  readonly address: string | null;
  readonly stateCode: string | null;
}

/** A priced line: the GST engine's figures at the document's date (spec §3.3). */
export interface SalesLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly variantId: string;
  readonly sku: string;
  /** Product and pack, e.g. "Apex Ultima 20 L". */
  readonly description: string;
  readonly hsnCode: string | null;
  readonly quantity: number;
  readonly unitPricePaise: number;
  readonly discountBps: number | null;
  readonly discountPaise: number | null;
  readonly taxablePaise: number;
  /** Null on a composition store's (untaxed) document. */
  readonly rateBps: number | null;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
  readonly totalPaise: number;
  /** Its tint (round 5a); absent when untinted. */
  readonly tint?: LineTintView;
}

/** The header figures of a priced quotation or order. */
export interface SalesTotalsView {
  readonly priceMode: PriceMode;
  readonly billDiscountBps: number | null;
  readonly billDiscountPaise: number | null;
  readonly placeOfSupplyCode: string;
  readonly supplyType: 'intra_state' | 'inter_state';
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
  readonly roundOffPaise: number;
  readonly totalPaise: number;
}

// Quotations ------------------------------------------------------------------

/**
 * POST /quotations (`Idempotency-Key` header), PUT /quotations/:id (draft
 * only: header and every line replaced). Priced by the GST engine at today's
 * rates; the store must be GST-registered.
 */
export interface QuotationRequest {
  readonly storeId: string;
  /** Who pays and owes (spec §6.4). */
  readonly billToPartyId: string;
  /** A painter, contractor or architect who brought the sale. */
  readonly influencerPartyId?: string;
  /** The site; its address pre-fills ship-to when ship-to is left out. */
  readonly projectId?: string;
  readonly shipTo?: ShipToRequest;
  /** Defaults to the business's sales setting. */
  readonly priceMode?: PriceMode;
  readonly billDiscount?: Discount;
  /** Defaults to today + `quoteValidityDays`; never before today. */
  readonly validUntil?: string;
  readonly note?: string;
  /** 1 to MAX_SALES_LINES lines. */
  readonly lines: readonly SalesLineRequest[];
}

/**
 * POST /quotations/:id/convert (`Idempotency-Key` header): a sent or accepted,
 * unexpired quote becomes a draft sales order, re-priced at today's rates; the
 * quote becomes `converted`.
 */
export interface ConvertQuotationRequest {
  readonly paymentTerms: PaymentTerms;
  /** Every line's fulfil store; defaults to the quote's store. */
  readonly fulfilStoreId?: string;
  readonly note?: string;
}

/** One version of a quote, for the version switcher. */
export interface QuotationVersionView {
  readonly id: string;
  readonly version: number;
  readonly status: QuotationStatus;
  readonly totalPaise: number;
  readonly createdAt: string;
}

/**
 * A quotation version. POST /quotations/:id/revise returns the new version;
 * /send (draft → sent) and /accept (sent → accepted) return this one.
 */
export interface QuotationView extends SalesTotalsView {
  readonly id: string;
  /** Shared by every version, e.g. `QT-000042`. */
  readonly number: string;
  readonly version: number;
  readonly rootQuotationId: string;
  /** As people see it today (see effectiveQuotationStatus). */
  readonly status: QuotationStatus;
  readonly storeId: string;
  readonly billTo: BillToView;
  readonly influencer: PartyRef | null;
  readonly project: NamedRef | null;
  readonly shipTo: ShipToView;
  readonly validUntil: string;
  /** The date it was priced (today for a draft, the day it was last saved otherwise). */
  readonly pricedOn: string;
  readonly note: string | null;
  readonly sentAt: string | null;
  readonly acceptedAt: string | null;
  /** The order it was converted into. */
  readonly salesOrderId: string | null;
  readonly createdByMemberId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly SalesLineView[];
  /** Every version, oldest first. */
  readonly versions: readonly QuotationVersionView[];
}

export interface QuotationSummary {
  readonly id: string;
  readonly number: string;
  readonly version: number;
  readonly status: QuotationStatus;
  readonly storeId: string;
  readonly billToPartyId: string;
  readonly billToName: string;
  readonly projectId: string | null;
  readonly validUntil: string;
  readonly totalPaise: number;
  readonly createdAt: string;
}

/**
 * GET /quotations?storeId&partyId&projectId&status&q&allVersions&limit&offset:
 * newest first; only each quote's latest version unless `allVersions=true`.
 * `q` matches the number or the bill-to name.
 */
export interface QuotationPage extends ListPageInfo {
  readonly items: readonly QuotationSummary[];
}

// Sales orders ----------------------------------------------------------------

export interface SalesOrderLineRequest extends SalesLineRequest {
  /** The store the goods come from and are reserved at; defaults to the order's store. */
  readonly fulfilStoreId?: string;
}

/** POST /sales-orders (`Idempotency-Key` header), PUT /sales-orders/:id (draft only). */
export interface SalesOrderRequest {
  readonly storeId: string;
  readonly billToPartyId: string;
  readonly influencerPartyId?: string;
  readonly projectId?: string;
  readonly shipTo?: ShipToRequest;
  readonly priceMode?: PriceMode;
  readonly billDiscount?: Discount;
  readonly paymentTerms: PaymentTerms;
  readonly note?: string;
  readonly lines: readonly SalesOrderLineRequest[];
}

/**
 * POST /sales-orders/:id/confirm (`Idempotency-Key` header): runs the credit
 * check (postpaid), checks the advance (partial), and reserves every line at
 * its fulfil store, or does none of it. Refusals: 409 with a
 * CreditApprovalRefusal, InsufficientStockRefusal or AdvanceRequiredRefusal
 * body.
 */
export interface ConfirmSalesOrderRequest {
  /**
   * Confirm past the credit rules (manager or owner approval), recorded on
   * the order and in the audit log. Refused for a blocked party.
   */
  readonly creditOverride?: { readonly reason: string };
}

/** POST /sales-orders/:id/cancel: releases every open reservation. */
export interface CancelSalesOrderRequest {
  readonly reason: string;
}

/** POST /sales-orders/:id/lines/:lineId/cancel: cancels part or all of what is open on a line. */
export interface CancelOrderLineRequest {
  /** Defaults to everything open on the line. */
  readonly quantity?: number;
  readonly reason: string;
}

/**
 * POST /sales-orders/:id/reserve: reserves what is open but not reserved on
 * the lines (all lines by default), optionally moving a line to another fulfil
 * store first (spec §4.3: cancel + re-reserve).
 */
export interface ReserveOrderRequest {
  readonly lines?: readonly { readonly lineId: string; readonly fulfilStoreId?: string }[];
}

/** POST /sales-orders/:id/release: gives back held stock without cancelling (stale reservations). */
export interface ReleaseOrderRequest {
  /** Defaults to every line. */
  readonly lineIds?: readonly string[];
}

/**
 * POST /sales-orders/:id/invoices (`Idempotency-Key` header): a draft invoice
 * (TaxDocumentView) for open quantities at one fulfil store, which then issues
 * through POST /invoices/:id/issue like any other draft. A prepaid order's
 * invoice must be paid in full at issue (use `allocateAdvances` and payments).
 */
export interface BillOrderRequest {
  /** The fulfil store billing; defaults to the store of the lines given, else the order's store. */
  readonly storeId?: string;
  /** Defaults to everything open on the lines at that store. */
  readonly lines?: readonly { readonly orderLineId: string; readonly quantity: number }[];
  readonly note?: string;
}

export interface SalesOrderLineView extends SalesLineView {
  readonly fulfilStoreId: string;
  readonly quantityInvoiced: number;
  readonly quantityCancelled: number;
  /** Held now (open reservations). */
  readonly quantityReserved: number;
  /** quantity − invoiced − cancelled. */
  readonly quantityOpen: number;
}

export interface StockReservationView {
  readonly id: string;
  readonly orderLineId: string;
  readonly storeId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly status: StockReservationStatus;
  /** The invoice or dispatch that consumed it. */
  readonly consumedByType: 'tax_document' | 'dispatch' | null;
  readonly consumedById: string | null;
  readonly createdAt: string;
  readonly closedAt: string | null;
}

/** Where a party stands for an order on credit (spec §4.4, §4.7). */
export interface OrderCreditView {
  /** Only postpaid orders are checked. */
  readonly required: boolean;
  /** Before go-live, exposure is the hand-entered figure; after, the ledger plus open postpaid orders. */
  readonly exposureSource: 'manual' | 'ledger';
  readonly position: {
    readonly status: CreditStatus;
    readonly limitPaise: number;
    readonly exposurePaise: number;
    readonly overdueDays: number;
  };
  /** checkCredit(rules, position, order total); null when not required. */
  readonly check: CreditCheck | null;
  readonly approval: CreditApproval;
}

/** The override recorded at confirm (also in the audit log). */
export interface CreditOverrideView {
  readonly approval: Exclude<CreditApproval, 'none' | 'blocked'>;
  readonly memberId: string;
  readonly memberName: string;
  readonly reason: string;
  readonly at: string;
}

/** An invoice raised from the order. */
export interface OrderInvoiceView {
  readonly id: string;
  readonly number: string | null;
  readonly status: TaxDocumentStatus;
  readonly storeId: string;
  readonly issuedOn: string | null;
  readonly totalPaise: number;
}

export interface SalesOrderView extends SalesTotalsView {
  readonly id: string;
  /** e.g. `SO-000017`. */
  readonly number: string;
  readonly status: SalesOrderStatus;
  readonly storeId: string;
  readonly paymentTerms: PaymentTerms;
  /** A partial order's minimum advance, set at confirm. */
  readonly advanceRequiredPaise: number | null;
  readonly billTo: BillToView;
  readonly influencer: PartyRef | null;
  readonly project: NamedRef | null;
  readonly shipTo: ShipToView;
  readonly quotationId: string | null;
  readonly quotationNumber: string | null;
  readonly note: string | null;
  /** The credit check as it stood at confirm; null before, and for prepaid / partial orders. */
  readonly creditCheck: CreditCheck | null;
  readonly creditOverride: CreditOverrideView | null;
  readonly confirmedAt: string | null;
  readonly confirmedByMemberId: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  /** Totals of the issued invoices raised from it. */
  readonly invoicedPaise: number;
  readonly createdByMemberId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly SalesOrderLineView[];
  /** Every reservation, open ones first. */
  readonly reservations: readonly StockReservationView[];
  readonly invoices: readonly OrderInvoiceView[];
}

export interface SalesOrderSummary {
  readonly id: string;
  readonly number: string;
  readonly status: SalesOrderStatus;
  readonly storeId: string;
  readonly paymentTerms: PaymentTerms;
  readonly billToPartyId: string;
  readonly billToName: string;
  readonly projectId: string | null;
  readonly totalPaise: number;
  readonly invoicedPaise: number;
  readonly createdAt: string;
}

/**
 * GET /sales-orders?storeId&partyId&projectId&status&q&limit&offset, newest
 * first. A member sees orders of their stores, by order store or fulfil store.
 */
export interface SalesOrderPage extends ListPageInfo {
  readonly items: readonly SalesOrderSummary[];
}

/** GET /sales-orders/:id/credit-check: the confirm dialog's figures before confirming. */
export type SalesOrderCreditCheckView = OrderCreditView;

/** GET /sales-orders/:id/availability: stock per line per store the member can see (spec §5.3). */
export interface OrderAvailabilityView {
  readonly lines: readonly {
    readonly lineId: string;
    readonly variantId: string;
    readonly sku: string;
    readonly fulfilStoreId: string;
    readonly quantityOpen: number;
    readonly quantityReserved: number;
    readonly stores: readonly {
      readonly storeId: string;
      readonly storeName: string;
      readonly onHand: number;
      readonly reserved: number;
      /** onHand − reserved. */
      readonly available: number;
    }[];
  }[];
}

/** 409 body when confirm needs a credit approval the request did not carry, or the party is blocked. */
export interface CreditApprovalRefusal {
  readonly statusCode: 409;
  readonly code: 'credit_approval_required' | 'credit_blocked' | 'credit_override_not_allowed';
  readonly message: string;
  readonly credit: OrderCreditView;
}

/** 409 body when a store does not have the stock to reserve (spec §4.3: line by line). */
export interface InsufficientStockRefusal {
  readonly statusCode: 409;
  readonly code: 'insufficient_stock';
  readonly message: string;
  readonly lines: readonly {
    readonly lineId: string;
    readonly lineNo: number;
    readonly storeId: string;
    readonly wantedQuantity: number;
    readonly availableQuantity: number;
  }[];
}

/** 409 body when a partial order's advance on account is below the minimum (spec §4.4). */
export interface AdvanceRequiredRefusal {
  readonly statusCode: 409;
  readonly code: 'advance_required';
  readonly message: string;
  readonly advanceRequiredPaise: number;
  /** The party's unallocated money now. */
  readonly advancePaise: number;
}

/** One open reservation older than the threshold (spec §4.3). */
export interface StaleReservationView {
  readonly id: string;
  readonly orderId: string;
  readonly orderNumber: string;
  readonly orderLineId: string;
  readonly storeId: string;
  readonly variantId: string;
  readonly sku: string;
  readonly quantity: number;
  readonly reservedAt: string;
  readonly ageDays: number;
}

/** GET /stock-reservations/stale?storeId&olderThanDays (default STALE_RESERVATION_DAYS)&limit&offset. */
export interface StaleReservationPage {
  readonly items: readonly StaleReservationView[];
  readonly total: number;
}

// Dispatch --------------------------------------------------------------------

/**
 * POST /invoices/:id/dispatches (`Idempotency-Key` header): goods leave for
 * an issued invoice. When the invoice posts stock on dispatch (spec §4.2) this
 * consumes the reservation and takes the stock out; otherwise it is a record.
 * The e-way bill number is required above the GSTIN's threshold (spec §2.10).
 */
export interface DispatchRequest {
  /** Defaults to everything not yet dispatched. */
  readonly lines?: readonly { readonly invoiceLineId: string; readonly quantity: number }[];
  readonly vehicleNo?: string;
  readonly ewayBillNo?: string;
  readonly ewayValidUntil?: string;
  readonly note?: string;
}

export interface DispatchView {
  readonly id: string;
  /** e.g. `DS-000003`. */
  readonly number: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly storeId: string;
  readonly dispatchedAt: string;
  readonly vehicleNo: string | null;
  readonly ewayBillNo: string | null;
  readonly ewayValidUntil: string | null;
  /** The consignment value with tax (spec §2.10). */
  readonly valuePaise: number;
  /** True when this dispatch took the stock out (post-on-dispatch invoices). */
  readonly stockPosted: boolean;
  readonly note: string | null;
  readonly createdByMemberId: string;
  readonly lines: readonly {
    readonly id: string;
    readonly invoiceLineId: string;
    readonly variantId: string;
    readonly description: string | null;
    readonly quantity: number;
    readonly valuePaise: number;
  }[];
}

/** GET /invoices/:id/dispatches: what has gone and what is waiting. */
export interface InvoiceDispatchesView {
  readonly invoiceId: string;
  /** `on_dispatch`: stock leaves with each dispatch; `on_issue`: it left at issue. */
  readonly stockPosting: 'on_issue' | 'on_dispatch' | 'none';
  readonly ewayThresholdPaise: number;
  readonly lines: readonly {
    readonly invoiceLineId: string;
    readonly lineNo: number;
    readonly variantId: string;
    readonly description: string | null;
    readonly quantity: number;
    readonly dispatchedQuantity: number;
    readonly pendingQuantity: number;
  }[];
  readonly dispatches: readonly DispatchView[];
}

// Go-live (spec §4.7) -----------------------------------------------------------

/** One party's opening balance at go-live. */
export interface GoLiveOpeningView {
  readonly partyId: string;
  readonly partyName: string;
  /** The MVP 1 figures. */
  readonly manualExposurePaise: number;
  readonly overdueDays: number;
  /** What the opening ledger entry will be. */
  readonly amountPaise: number;
  /** liveOn − overdueDays when overdue; overdue days are counted from it after go-live. */
  readonly overdueSince: string | null;
  /**
   * Where the amount comes from ([PO-5]): an imported opening balance
   * (POST /imports/opening-balances), else the hand-entered exposure.
   */
  readonly source: 'import' | 'manual';
}

/** GET /sales/go-live: the cut-over preview, or what it did. */
export interface GoLivePreview {
  readonly billingLiveOn: string | null;
  readonly live: boolean;
  readonly stockPostOn: StockPostOn;
  /** Parties with an imported opening balance or a hand-entered exposure (empty once live). */
  readonly openings: readonly GoLiveOpeningView[];
  /** Loyalty accounts whose manual purchase entry switches off. */
  readonly loyaltyAccounts: number;
}

/**
 * POST /sales/go-live (`Idempotency-Key` header), once per business, in one
 * transaction: one `opening` party-ledger entry per party (its manual
 * exposure, or the amount given here — [PO-5]: an imported balance), the
 * overdue days kept as an "overdue since" date, `billing_live_on` set. After
 * it: exposure comes from the ledger, the manual credit figures are read-only,
 * invoices earn loyalty points and manual purchase entry is off.
 */
export interface GoLiveRequest {
  /** Defaults to today; never in the future. */
  readonly liveOn?: string;
  /** Replaces the manual exposure for these parties (0 = no opening entry). */
  readonly openings?: readonly {
    readonly partyId: string;
    readonly amountPaise: number;
    readonly overdueSince?: string;
  }[];
}

export interface GoLiveResult {
  readonly billingLiveOn: string;
  readonly openingEntries: number;
  readonly openingTotalPaise: number;
}
