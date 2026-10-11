/** The GST nature of a tax category, which decides where it lands in GSTR-1. */
export type TaxNature = 'taxable' | 'nil_rated' | 'exempt' | 'non_gst';

/**
 * One row of the rate table: a tax category's rate for a date range. The table
 * is data the caller passes in (from the database), never fetched here.
 * Dates are ISO `YYYY-MM-DD`, both ends inclusive; `effectiveTo` null means open.
 */
export interface GstRate {
  readonly categoryCode: string;
  readonly nature: TaxNature;
  /** Combined GST rate in basis points: 18% is 1800. Halved for CGST and SGST. */
  readonly rateBasisPoints: number;
  /** Compensation cess, ad valorem, in basis points. Zero for paints; the hook stays. */
  readonly cessBasisPoints: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
}

/** The rate applied to a line, as found in the table on the invoice date. */
export interface AppliedRate {
  readonly nature: TaxNature;
  readonly rateBasisPoints: number;
  readonly cessBasisPoints: number;
}

export type SupplyType = 'intra_state' | 'inter_state';
export type RegistrationType = 'regular' | 'composition';
export type BuyerType = 'b2b' | 'b2c';
/** A regular dealer issues a tax invoice; a composition dealer a bill of supply. */
export type DocumentType = 'tax_invoice' | 'bill_of_supply';

/** A discount off a line or an invoice: a percentage in basis points or an amount in paise. */
export type Discount =
  | { readonly kind: 'percent'; readonly basisPoints: number }
  | { readonly kind: 'amount'; readonly paise: number };

/**
 * `line`: tax is rounded on every line and the lines are summed (the default;
 * what POS software and e-invoices do). `invoice`: tax is rounded once per rate
 * on the summed taxable value (as Tally does) and spread back over the lines.
 */
export type TaxRounding = 'line' | 'invoice';

export interface GstOptions {
  readonly taxRounding: TaxRounding;
  /** Round the grand total to the nearest rupee, shown as a separate round-off line. */
  readonly roundOff: boolean;
}

export const DEFAULT_GST_OPTIONS: GstOptions = { taxRounding: 'line', roundOff: true };

/** The tax heads on an amount, all in paise. The state half is SGST or UTGST by state. */
export interface TaxHeads {
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
}
