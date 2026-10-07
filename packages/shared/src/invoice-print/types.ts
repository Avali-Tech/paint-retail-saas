import type { BuyerType, DocumentType, SupplyType } from '../gst/types.js';
import type { InvoiceLabels, PrintLabel, SecondLanguage } from './labels.js';

/**
 * What a printed invoice needs besides the engine's `Invoice`: who sells, who buys,
 * the number and date, and the shop's own texts. Round 2a's `tax_documents` row maps
 * onto it one to one (supplier snapshot, buyer snapshot, ship-to snapshot, lines),
 * plus `sales_settings` for notes, terms, bank details and the second language.
 */
export interface InvoiceDocumentInput {
  /** Must match the engine's `documentType` (regular dealer: tax invoice; composition: bill of supply). */
  readonly kind: DocumentType;
  /** Rule 46(b): up to 16 characters, A–Z, 0–9, "-" and "/" (e.g. "AMP/26-27/00123"). */
  readonly number: string;
  /** India date of issue, `YYYY-MM-DD`. */
  readonly issuedOn: string;
  /** Rule 48 copy mark; null prints none (e.g. a counter receipt, [CA-2]). */
  readonly copy: CopyMark | null;
  readonly supplier: PrintSupplier;
  readonly buyer: PrintBuyer;
  /** Delivery address when it differs from the buyer's (Rule 46(o)); null when the same or none. */
  readonly shipTo: PrintAddress | null;
  /** One per engine line, in the same order: what the engine does not know. */
  readonly lines: readonly PrintLineDetail[];
  /** The registration's aggregate turnover in the previous FY, for the HSN digits (§2.7). */
  readonly aggregateTurnoverPaise: number;
  /** Always false for our sales (§2.2 (p)); printed "No" on a tax invoice. */
  readonly reverseCharge: boolean;
  /** The business's logo (white-label); null prints the name only. */
  readonly logoUrl: string | null;
  readonly notes: readonly string[];
  readonly terms: readonly string[];
  readonly bank: PrintBankDetails | null;
  /** Who signs; null leaves the name blank above "Authorised signatory". */
  readonly signatoryName: string | null;
  /** Hindi or Telugu printed under the English labels; null for English only. */
  readonly secondLanguage: SecondLanguage | null;
}

export type CopyMark = 'original' | 'duplicate' | 'triplicate';

export interface PrintAddress {
  /** Street lines as entered. */
  readonly lines: readonly string[];
  readonly city: string | null;
  readonly pincode: string | null;
  /** Two-digit GST state code; the state name is looked up. */
  readonly stateCode: string;
}

export interface PrintSupplier {
  readonly legalName: string;
  /** The shop's trading name (the white-label business name); null when it is the legal name. */
  readonly tradeName: string | null;
  readonly gstin: string;
  readonly address: PrintAddress;
  readonly phone: string | null;
  readonly email: string | null;
}

export interface PrintBuyer {
  readonly name: string | null;
  /** Null for an unregistered buyer (B2C); must agree with the engine's buyer type. */
  readonly gstin: string | null;
  readonly address: PrintAddress | null;
  readonly phone: string | null;
}

export interface PrintLineDetail {
  /** Product title, e.g. "Asian Paints Apex Ultima" or "Asian Paints Brush". */
  readonly description: string;
  /** Pack size or hardware size label, as `variantName` writes it ("10 l", "4 inch"); null when none. */
  readonly variant: string | null;
  /** As stored on the product (4, 6 or 8 digits); "" when none. */
  readonly hsnCode: string;
  /** Unit quantity code: NOS, LTR, KGS… */
  readonly uqc: string;
}

export interface PrintBankDetails {
  readonly bankName: string;
  readonly accountName: string;
  readonly accountNumber: string;
  readonly ifsc: string;
  readonly upiId: string | null;
}

/** A Rule 46 / 49 field the invoice lacks, for the issuing screen to ask for. */
export interface PrintIssue {
  readonly code:
    | 'number_format'
    | 'buyer_name'
    | 'buyer_address'
    | 'buyer_state'
    | 'delivery_address'
    | 'hsn_digits';
  /** The clause that asks for it, e.g. "46(e)". */
  readonly clause: string;
  /** For `hsn_digits`: the line's index. */
  readonly line: number | null;
}

/** Which Rule 46 fields this invoice must carry (§2.2, §2.6, §2.7). */
export interface PrintRequirements {
  /** B2B: buyer name, address and GSTIN (46(d)). */
  readonly buyerGstin: boolean;
  /** B2B, or unregistered with taxable value ≥ ₹50,000 (46(e)): name, address, state. */
  readonly buyerDetails: boolean;
  /** Unregistered and ≥ ₹50,000: the delivery address too (46(e)). */
  readonly deliveryAddress: boolean;
  /** HSN digits each line needs; 0 when optional (Notification 78/2020). */
  readonly hsnDigits: number;
  /** Inter-state supplies must name the place of supply (46(n)); we print it always. */
  readonly placeOfSupply: boolean;
  /** Tax invoices say whether tax is payable on reverse charge (46(p)). */
  readonly reverseChargeLine: boolean;
  /** Bills of supply carry the composition notice (Rule 5(1)(f)). */
  readonly compositionNotice: boolean;
}

export type GstClass = 'b2b' | 'b2cl' | 'b2cs';
export type TaxColumnKey = 'cgst' | 'sgst' | 'igst' | 'cess';

/** A party block as printed: every value already a string. */
export interface PartyView {
  readonly name: string;
  readonly gstin: string | null;
  readonly addressLines: readonly string[];
  /** "Telangana (36)"; null when no state is known. */
  readonly state: string | null;
  readonly phone: string | null;
}

export interface LineView {
  readonly serial: number;
  readonly description: string;
  readonly variant: string | null;
  readonly hsn: string;
  readonly quantity: string;
  readonly uqc: string;
  readonly price: string;
  /** Line and invoice discount together; null when none. */
  readonly discount: string | null;
  readonly taxable: string;
  /** "18%"; null on a bill of supply. */
  readonly rate: string | null;
  readonly taxes: Readonly<Partial<Record<TaxColumnKey, string>>>;
  readonly amount: string;
}

export interface TaxSummaryView {
  readonly rate: string;
  readonly taxable: string;
  readonly taxes: Readonly<Partial<Record<TaxColumnKey, string>>>;
  readonly totalTax: string;
}

export interface TotalRow {
  readonly key: 'subtotal' | 'discount' | TaxColumnKey | 'roundOff' | 'grandTotal';
  readonly label: PrintLabel;
  readonly amount: string;
}

/** A print-ready invoice: every amount, date and label already formatted. */
export interface InvoiceView {
  readonly kind: DocumentType;
  readonly title: PrintLabel;
  readonly compositionNotice: string | null;
  readonly copyMark: string | null;
  readonly secondLanguage: SecondLanguage | null;
  readonly labels: InvoiceLabels;
  /** The white-label header: trade name (or legal name) and logo. */
  readonly business: { readonly name: string; readonly logoUrl: string | null };
  readonly supplier: PartyView & {
    readonly gstin: string;
    readonly state: string;
    readonly legalName: string;
    readonly email: string | null;
  };
  /** "Walk-in customer" when an unregistered buyer gave no name. */
  readonly buyer: PartyView & { readonly registered: boolean };
  readonly shipTo: { readonly addressLines: readonly string[]; readonly state: string } | null;
  readonly number: string;
  readonly date: string;
  readonly placeOfSupply: string;
  readonly supplyType: SupplyType;
  readonly buyerType: BuyerType;
  readonly gstClass: GstClass;
  /** "No" or "Yes" on a tax invoice; null on a bill of supply. */
  readonly reverseCharge: string | null;
  readonly pricesIncludeTax: boolean;
  /** Tax columns in print order, with their labels (SGST or UTGST); empty on a bill of supply. */
  readonly taxColumns: readonly { readonly key: TaxColumnKey; readonly label: string }[];
  readonly lines: readonly LineView[];
  readonly taxSummary: readonly TaxSummaryView[];
  readonly totals: readonly TotalRow[];
  /** The amount payable, formatted with the rupee sign. */
  readonly grandTotal: string;
  readonly amountInWords: string;
  readonly notes: readonly string[];
  readonly terms: readonly string[];
  readonly bank: PrintBankDetails | null;
  readonly signatory: { readonly forLine: string; readonly name: string | null };
  readonly requirements: PrintRequirements;
  readonly issues: readonly PrintIssue[];
}
