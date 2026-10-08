import { checkPaise } from './arith.js';
import { GstError } from './errors.js';
import { taxOnAmount } from './line.js';
import type { CreditNote, CreditNoteLine, NoteSource } from './returns.js';
import { documentTotals, summarize, taxOf } from './summary.js';
import { amountInWords } from './words.js';

/** A change in the value of one original invoice line, without goods moving. */
export interface AdjustmentLineInput {
  /** The line's `index` on the original invoice. */
  readonly lineIndex: number;
  /** The value reduced (credit note) or added (debit note), in paise. */
  readonly valuePaise: number;
}

/**
 * The tax on a credit note for a discount or an overcharge, or on a debit note
 * for an undercharge (s.34): each value is taxed **at the rate the original
 * line was charged at**, never today's rate ([CA-6]), and with the original
 * supply type. `valueIncludesTax` says whether a value is the amount the buyer
 * pays (tax backed out) or the taxable value. A line billed without tax (a bill
 * of supply) carries none. The note rounds to the rupee when `roundOff` is set.
 */
export function computeAdjustment(
  source: NoteSource,
  adjusted: readonly AdjustmentLineInput[],
  valueIncludesTax: boolean,
  roundOff: boolean,
): CreditNote {
  if (adjusted.length === 0) {
    throw new GstError('invalid_adjustment', 'Nothing is being adjusted');
  }
  const seen = new Set<number>();
  const lines = adjusted.map((item): CreditNoteLine => {
    if (seen.has(item.lineIndex)) {
      throw new GstError('invalid_adjustment', `Line ${String(item.lineIndex)} is listed twice`);
    }
    seen.add(item.lineIndex);
    const original = source.lines.find((line) => line.index === item.lineIndex);
    if (!original) {
      throw new GstError('invalid_adjustment', `The invoice has no line ${String(item.lineIndex)}`);
    }
    if (checkPaise(item.valuePaise, 'Value') === 0n) {
      throw new GstError('invalid_adjustment', 'A value must be more than zero');
    }
    const heads =
      original.rate === null
        ? { taxablePaise: item.valuePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0 }
        : taxOnAmount(item.valuePaise, original.rate, source.supplyType, valueIncludesTax);
    const taxPaise = taxOf(heads);
    return {
      lineIndex: original.index,
      categoryCode: original.categoryCode,
      quantityMilli: original.quantityMilli,
      rate: original.rate,
      ...heads,
      taxPaise,
      totalPaise: heads.taxablePaise + taxPaise,
    };
  });
  const totals = documentTotals(lines, roundOff);
  return {
    supplyType: source.supplyType,
    placeOfSupply: source.placeOfSupply,
    stateTaxLabel: source.stateTaxLabel,
    lines,
    taxSummary: summarize(lines),
    totals,
    amountInWords: amountInWords(totals.payablePaise),
  };
}
