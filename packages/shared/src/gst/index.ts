/**
 * GST tax engine (roadmap P2-M01): a pure library, all money in integer paise
 * and all rate arithmetic in BigInt, with no database or network access.
 *
 * Rules chosen (each covered by tests and by `scenarios.ts`):
 * - Rounding is half up to the paisa. Tax is rounded per line and summed by
 *   default (`taxRounding: 'line'`); `'invoice'` rounds once per rate on the
 *   summed taxable value and spreads it back over the lines (tax-exclusive only).
 * - CGST and SGST are each half the rate, rounded independently by the same
 *   formula, so they are always equal; their sum can differ by one paisa from the
 *   full rate rounded once (₹0.25 at 18%: 2 + 2 paise, not 5).
 * - Tax-inclusive prices: taxable = round(price × 10000 / (10000 + rate + cess));
 *   the heads are taken on that, then the taxable value becomes price − tax, so
 *   the customer pays the shelf price exactly and the odd paisa stays in taxable.
 * - Discounts: a line discount comes off the line's gross; an invoice discount is
 *   spread over the lines in proportion to their net, largest remainder first,
 *   the earlier line winning a tie. Both reduce the taxable value (s.15(3)(a)).
 * - Round-off: the grand total to the nearest rupee, 50 paise rounding up, shown
 *   as its own line (−49 to +50 paise); it can be switched off.
 * - Returns reverse each amount in proportion to units returned, cumulatively, so
 *   a full return (in one note or several) reverses exactly the original tax.
 * - Value notes (discount, overcharge, undercharge) tax the value at the original
 *   line's rate and supply type, never today's.
 *
 * Assumptions a CA must confirm:
 * 1. Half-up rounding to the paisa per head, per line (not the s.170 rupee
 *    rounding, which we read as applying to tax payable in returns, not invoices).
 * 2. CGST = SGST rounded independently, accepting a one-paisa difference from
 *    rounding the full rate once.
 * 3. For inclusive prices the taxable value absorbs the odd paisa so the price
 *    paid never changes.
 * 4. An invoice discount given on the invoice itself reduces the taxable value of
 *    every line pro rata, including lines at different rates.
 * 5. Place of supply for B2B is always the buyer's GSTIN state (bill-to-ship-to
 *    under s.10(1)(b)); for B2C it is the delivery state, else the store's state.
 *    SEZ supplies, exports and supplies to Other Territory (97) need their own
 *    handling and are not special-cased.
 * 6. UTs without a legislature (Chandigarh, Ladakh, Lakshadweep, Andaman and
 *    Nicobar, Dadra and Nagar Haveli and Daman and Diu, Other Territory) label
 *    the state half UTGST; Delhi, Puducherry and Jammu and Kashmir use SGST.
 * 7. A composition dealer issues a bill of supply with no tax shown and cannot
 *    make inter-state supplies (s.10(2)(c)), so the engine refuses one.
 * 8. A regular dealer's invoice is always a tax invoice, even when every line is
 *    nil-rated or exempt (Rule 49 would allow a bill of supply there).
 * 9. Cess is ad valorem only (zero for paints); specific-rate cess is not modelled.
 * 10. HSN digits default to Notification 78/2020: up to ₹5 crore AATO, 4 digits
 *    on B2B and optional on B2C; above, 6 digits on every invoice.
 * 11. Partial credit notes, each rounded off to the rupee, may together differ
 *    from the invoice's own round-off by under a rupee; tax always reverses exactly.
 */
export { computeAdjustment, type AdjustmentLineInput } from './adjustments.js';
export { allocateProportionally } from './arith.js';
export { GstError, type GstErrorCode } from './errors.js';
export {
  DEFAULT_HSN_DIGIT_BANDS,
  hsnMeetsRequirement,
  requiredHsnDigits,
  type HsnDigitBand,
} from './hsn.js';
export {
  computeInvoice,
  type Invoice,
  type InvoiceInput,
  type InvoiceLine,
  type InvoiceTotals,
} from './invoice.js';
export { discountAmount, priceLine, taxOnAmount, type LineInput, type PricedLine } from './line.js';
export {
  placeOfSupply,
  supplyTypeFor,
  type Parties,
  type PlaceOfSupply,
} from './place-of-supply.js';
export { rateOn } from './rates.js';
export {
  computeReturn,
  type CreditNote,
  type CreditNoteLine,
  type NoteSource,
  type ReturnLineInput,
} from './returns.js';
export {
  GST_STATES,
  gstState,
  isGstStateCode,
  stateCodeFromGstin,
  stateTaxLabel,
  type GstState,
  type StateKind,
} from './states.js';
export type { DocumentTotals, TaxSummaryRow } from './summary.js';
export {
  DEFAULT_GST_OPTIONS,
  type AppliedRate,
  type BuyerType,
  type Discount,
  type DocumentType,
  type GstOptions,
  type GstRate,
  type RegistrationType,
  type SupplyType,
  type TaxHeads,
  type TaxNature,
  type TaxRounding,
} from './types.js';
export { amountInWords } from './words.js';
