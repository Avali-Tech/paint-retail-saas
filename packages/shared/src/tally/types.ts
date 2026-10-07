import type { SupplyType, TaxNature } from '../gst/types.js';

/**
 * The input contract of the Tally export: the documents of one period, as plain
 * data. Every amount is integer paise and every date ISO `YYYY-MM-DD` (India
 * time). Nothing here reads a database; round 2a's `tax_documents` and round
 * 3a's `payments` / `allocations` map onto these shapes field for field.
 */

/** The buyer, as snapshotted on the document (spec §3.3 "buyer snapshot"). */
export interface TallyParty {
  /** Our party id; ledger overrides match on it. */
  readonly id: string;
  /** Display name, the default Tally ledger name. */
  readonly name: string;
  /** Null for an unregistered buyer. */
  readonly gstin: string | null;
  /** Two-digit GST state code of the buyer, when known (from the GSTIN for B2B). */
  readonly stateCode: string | null;
  /** The organisation's walk-in party (`sales_settings.walk_in_party_id`): posts to "Cash Sales". */
  readonly walkIn: boolean;
}

/**
 * One taxed row of a document: a `tax_document_tax_rows` row (rate × HSN), or a
 * `tax_document_lines` row. Several rows may share a rate; the export adds them up.
 */
export interface TallyTaxLine {
  readonly hsnCode: string;
  readonly nature: TaxNature;
  /** Combined GST rate: 1800 is 18%. Zero for exempt, nil-rated and non-GST rows. */
  readonly rateBasisPoints: number;
  readonly cessBasisPoints: number;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  /** SGST, or UTGST when the supplier is in a UT without a legislature. */
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
}

/** An earlier document a note adjusts (`tax_document_links`, kind `note_of`). */
export interface TallyDocumentRef {
  readonly number: string;
  readonly issuedOn: string;
}

/** Part of a receipt or credit note settled against one of our bills (`allocations`). */
export interface TallyAllocation {
  /** Our invoice or debit note number: the Tally bill reference. */
  readonly documentNumber: string;
  readonly amountPaise: number;
}

export type TallySalesKind = 'tax_invoice' | 'bill_of_supply' | 'credit_note' | 'debit_note';

/** A sales-side GST document: a `tax_documents` row with its tax rows and links. */
export interface TallySalesDocument {
  /** Our document id, written into the narration so a re-import can be spotted. */
  readonly id: string;
  readonly kind: TallySalesKind;
  /** Our document number, which becomes the Tally voucher number. */
  readonly number: string;
  readonly issuedOn: string;
  /** A cancelled document is exported as a cancelled voucher that keeps its number (§2.4). */
  readonly cancelled: boolean;
  /** The selling store's code (`AMP`); store-specific ledger overrides match on it. */
  readonly storeCode: string;
  /** Supplier snapshot: the selling GSTIN and its state code. */
  readonly supplierGstin: string;
  readonly supplierStateCode: string;
  readonly party: TallyParty;
  readonly placeOfSupplyCode: string;
  readonly supplyType: SupplyType;
  /** Empty only on a cancelled document. A bill of supply has rows with no tax. */
  readonly lines: readonly TallyTaxLine[];
  /** Whole-rupee adjustment, −49 to +50 paise. */
  readonly roundOffPaise: number;
  /** What the buyer pays: taxable + tax + cess + round-off. */
  readonly totalPaise: number;
  /** Notes only: the invoices they adjust, at least one. Empty for invoices. */
  readonly originals: readonly TallyDocumentRef[];
  /** Credit notes only: the part set off against open bills; the rest stays on account. */
  readonly allocations: readonly TallyAllocation[];
  /** Free text appended to the narration (a note's reason, an order number). */
  readonly note: string | null;
}

/** How money came in (`payment_modes`): ledgers resolve by `name`, then by `kind`. */
export interface TallyPaymentMode {
  readonly kind: 'cash' | 'upi' | 'card' | 'bank_transfer' | 'cheque' | 'other';
  readonly name: string;
}

/** Money received from a party: a `payments` row with direction `in`, and its allocations. */
export interface TallyReceipt {
  readonly id: string;
  /** Receipt number (`RC-000123`) or, for an advance, the receipt voucher number. */
  readonly number: string;
  readonly receivedOn: string;
  readonly storeCode: string;
  readonly party: TallyParty;
  readonly mode: TallyPaymentMode;
  readonly amountPaise: number;
  /** UTR, card slip or cheque number. */
  readonly reference: string | null;
  /** True for a GST receipt voucher (an advance before the invoice): the bill type is Advance. */
  readonly advance: boolean;
  /** Bills this receipt settles; any remainder is an advance or on account. */
  readonly allocations: readonly TallyAllocation[];
  readonly note: string | null;
}

/** Everything one export covers. */
export interface TallyPeriod {
  /** The company name in TallyPrime; the import is addressed to it. */
  readonly companyName: string;
  readonly from: string;
  readonly to: string;
  readonly documents: readonly TallySalesDocument[];
  readonly receipts: readonly TallyReceipt[];
}
