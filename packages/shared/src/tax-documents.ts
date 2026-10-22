/**
 * Sales tax documents (MVP 2, Sell & Bill): numbering under Rule 46(b), the
 * GSTR-1 class of a sale and the shapes the API returns. The tax itself comes
 * from the GST engine (./gst).
 */
import type { TaxNature } from './gst/types.js';
import type { PrintBankDetails } from './invoice-print/types.js';
import type { ListPageInfo } from './list-page.js';
import type { LineTintView } from './paint-api.js';
import type { SlowMoverWindow } from './slow-movers.js';

/** Every kind of GST document; each has its own number series (Rule 46(b), 49(b), 50(b), 53). */
export const TAX_DOCUMENT_KINDS = [
  'invoice',
  'bill_of_supply',
  'credit_note',
  'debit_note',
  'receipt_voucher',
  'refund_voucher',
] as const;
export type TaxDocumentKind = (typeof TAX_DOCUMENT_KINDS)[number];

export const TAX_DOCUMENT_STATUSES = ['draft', 'issued', 'cancelled'] as const;
export type TaxDocumentStatus = (typeof TAX_DOCUMENT_STATUSES)[number];

export const PRICE_MODES = ['inclusive', 'exclusive'] as const;
export type PriceMode = (typeof PRICE_MODES)[number];

export const STOCK_POST_ON = ['invoice', 'dispatch'] as const;
export type StockPostOn = (typeof STOCK_POST_ON)[number];

export const AATO_BANDS = ['up_to_5cr', 'above_5cr'] as const;
export type AatoBand = (typeof AATO_BANDS)[number];

/** A turnover just above ₹5 crore: how the `above_5cr` band reads for the HSN digits rule (§2.7). */
const ABOVE_5_CRORE_PAISE = 5_00_00_000_00 + 1;

/** The aggregate turnover a band stands for, as requiredHsnDigits reads it. */
export function aatoTurnoverPaise(band: AatoBand): number {
  return band === 'above_5cr' ? ABOVE_5_CRORE_PAISE : 0;
}

export type GstClass = 'b2b' | 'b2cl' | 'b2cs';

/** Rule 46(b): a document number is at most 16 characters. */
export const MAX_DOCUMENT_NUMBER_LENGTH = 16;
/** "/26-27/" between the prefix and the serial. */
const FY_PART_LENGTH = 7;
/** Rule 46(e): from this taxable value an unregistered buyer's details are mandatory. */
export const BUYER_DETAILS_THRESHOLD_PAISE = 50_000_00;
/** Rule 59(4)(a)(ii): an inter-state B2C invoice above this is B2C large. */
export const B2CL_THRESHOLD_PAISE = 1_00_000_00;

const KIND_SUFFIX: Record<TaxDocumentKind, string> = {
  invoice: '',
  bill_of_supply: 'B',
  credit_note: 'C',
  debit_note: 'D',
  receipt_voucher: 'A',
  refund_voucher: 'R',
};

/** The Indian financial year of an ISO date: 2026-04-01 → "2026-27", 2027-03-31 → "2026-27". */
export function financialYear(date: string): string {
  const year = Number(date.slice(0, 4));
  const start = Number(date.slice(5, 7)) >= 4 ? year : year - 1;
  return `${String(start)}-${String(start + 1).slice(2)}`;
}

/** True when `prefix` and `digits` make numbers of at most 16 characters of A–Z and 0–9. */
export function isValidSeriesPrefix(prefix: string, digits: number): boolean {
  return (
    /^[A-Z0-9]+$/.test(prefix) &&
    Number.isSafeInteger(digits) &&
    digits >= 1 &&
    prefix.length + FY_PART_LENGTH + digits <= MAX_DOCUMENT_NUMBER_LENGTH
  );
}

/** A series a store gets for `kind` when none is set up: its code, a kind letter, up to 6 digits. */
export function defaultSeries(
  storeCode: string,
  kind: TaxDocumentKind,
): { prefix: string; digits: number } | null {
  const prefix = `${storeCode.toUpperCase().replace(/[^A-Z0-9]/g, '')}${KIND_SUFFIX[kind]}`;
  const digits = Math.min(6, MAX_DOCUMENT_NUMBER_LENGTH - FY_PART_LENGTH - prefix.length);
  return digits >= 3 && isValidSeriesPrefix(prefix, digits) ? { prefix, digits } : null;
}

/** e.g. ("AMP", "2026-27", 123, 6) → "AMP/26-27/000123". */
export function formatTaxDocumentNumber(
  prefix: string,
  fy: string,
  value: number,
  digits: number,
): string {
  const serial = String(value);
  if (!Number.isSafeInteger(value) || value < 1 || serial.length > digits) {
    throw new RangeError(`Serial ${serial} does not fit ${String(digits)} digits`);
  }
  return `${prefix}/${fy.slice(2)}/${serial.padStart(digits, '0')}`;
}

/** The GSTR-1 class of a sale (Rule 59(4)). */
export function gstClassFor(
  buyerGstin: string | null,
  interState: boolean,
  invoiceValuePaise: number,
): GstClass {
  if (buyerGstin !== null) return 'b2b';
  return interState && invoiceValuePaise > B2CL_THRESHOLD_PAISE ? 'b2cl' : 'b2cs';
}

/** Unique quantity codes (UQC) GSTN uses for our units of measure. */
const UQC: Record<string, string> = {
  ml: 'MLT',
  l: 'LTR',
  g: 'GMS',
  kg: 'KGS',
  piece: 'PCS',
  set: 'SET',
  m: 'MTR',
};

/** The UQC for a unit of measure; "OTH" (others) for anything unmapped. */
export function uqcFor(unit: string): string {
  return UQC[unit] ?? 'OTH';
}

export interface TaxDocumentParty {
  readonly partyId: string | null;
  readonly name: string | null;
  readonly gstin: string | null;
  readonly address: string | null;
  readonly stateCode: string | null;
}

export interface TaxDocumentLineView {
  readonly id: string;
  readonly lineNo: number;
  readonly variantId: string;
  readonly description: string | null;
  readonly hsnCode: string | null;
  readonly uqc: string | null;
  readonly quantity: number;
  readonly unitPricePaise: number;
  readonly discountBps: number | null;
  readonly discountPaise: number | null;
  readonly grossPaise: number;
  readonly taxablePaise: number;
  readonly taxCategoryId: string | null;
  readonly rateBps: number | null;
  /** The rate's nature as issued (0% exempt or nil-rated); null exactly when the rate is. */
  readonly taxNature: TaxNature | null;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
  readonly totalPaise: number;
  /** Its tint (round 5a, invoice and bill-of-supply lines); absent when untinted. */
  readonly tint?: LineTintView;
}

export interface TaxDocumentTaxRowView {
  readonly hsnCode: string;
  readonly rateBps: number;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
}

/** A tax invoice or bill of supply, draft or issued. */
export interface TaxDocumentView {
  readonly id: string;
  readonly kind: TaxDocumentKind;
  readonly status: TaxDocumentStatus;
  readonly storeId: string;
  /** Null while a draft. */
  readonly number: string | null;
  readonly fy: string | null;
  readonly issuedOn: string | null;
  readonly issuedAt: string | null;
  readonly supplier: {
    readonly gstin: string | null;
    readonly stateCode: string | null;
    readonly legalName: string | null;
    readonly tradeName: string | null;
    readonly address: string | null;
  };
  readonly buyer: TaxDocumentParty;
  readonly shipTo: {
    readonly name: string | null;
    readonly address: string | null;
    readonly stateCode: string | null;
  };
  readonly placeOfSupplyCode: string | null;
  readonly supplyType: 'intra_state' | 'inter_state' | null;
  readonly gstClass: GstClass | null;
  readonly priceMode: PriceMode;
  readonly reverseCharge: boolean;
  readonly billDiscountBps: number | null;
  readonly billDiscountPaise: number | null;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
  readonly roundOffPaise: number;
  readonly totalPaise: number;
  readonly dueOn: string | null;
  readonly projectId: string | null;
  readonly influencerPartyId: string | null;
  readonly note: string | null;
  readonly irn: string | null;
  readonly ackNo: string | null;
  readonly cancelReason: string | null;
  readonly cancelledAt: string | null;
  readonly lines: TaxDocumentLineView[];
  readonly taxRows: TaxDocumentTaxRowView[];
}

export interface TaxDocumentSummary {
  readonly id: string;
  readonly kind: TaxDocumentKind;
  readonly status: TaxDocumentStatus;
  readonly storeId: string;
  readonly number: string | null;
  readonly issuedOn: string | null;
  readonly buyerName: string | null;
  readonly totalPaise: number;
}

/** GET /invoices: newest first, keyset-paged (round 6c). */
export interface TaxDocumentPage extends ListPageInfo {
  readonly items: TaxDocumentSummary[];
}

export interface DocumentSeriesView {
  readonly id: string;
  readonly storeId: string;
  readonly kind: TaxDocumentKind;
  readonly prefix: string;
  readonly digits: number;
  readonly isActive: boolean;
  /** What the first number of this financial year looks like. */
  readonly sample: string;
}

export interface SalesSettingsView {
  readonly stockPostOn: StockPostOn;
  readonly walkInPartyId: string | null;
  readonly quoteValidityDays: number;
  readonly partialMinAdvancePct: number;
  readonly defaultPriceMode: PriceMode;
  readonly billingLiveOn: string | null;
  /** Cash is taken only into an open register session ([PO-11]). */
  readonly cashNeedsRegister: boolean;
  /** A register closing further off than this (paise) tells the branch managers. */
  readonly registerVarianceAlertPaise: number;
  /** ml in one shot and one Y of the tinting machine (round 8a); null when not set. */
  readonly tintShotMl: number | null;
  readonly tintYMl: number | null;
  /** Days idle before stock is announced as slow (Settings → Stock alerts); null: no alert. */
  readonly slowMoverAlertDays: SlowMoverWindow | null;
  /** Printed on the A4 invoice (spec §5.4); null when not given. */
  readonly invoiceBank: PrintBankDetails | null;
  /** Terms and conditions printed on every invoice, in order (at most INVOICE_TERMS_MAX). */
  readonly invoiceTerms: readonly string[];
}

/** At most this many terms, each at most INVOICE_TERM_MAX_LENGTH characters. */
export const INVOICE_TERMS_MAX = 10;
export const INVOICE_TERM_MAX_LENGTH = 200;

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const BANK_ACCOUNT = /^[0-9]{9,18}$/;
const UPI_ID = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z][a-zA-Z0-9]{1,63}$/;

/** An Indian Financial System Code: 4 letters, 0, then 6 letters or digits ("HDFC0001234"). */
export const isValidIfsc = (ifsc: string): boolean => IFSC.test(ifsc);
/** A bank account number as Indian banks issue them: 9 to 18 digits. */
export const isValidBankAccount = (account: string): boolean => BANK_ACCOUNT.test(account);
/** A UPI ID (virtual payment address), e.g. "sharmapaints@okhdfc". */
export const isValidUpiId = (upiId: string): boolean => UPI_ID.test(upiId);

export interface GstinProfileView {
  readonly gstin: string;
  readonly stateCode: string;
  readonly aatoBand: AatoBand;
  readonly einvoiceRequiredFrom: string | null;
  readonly ewayThresholdPaise: number;
}
