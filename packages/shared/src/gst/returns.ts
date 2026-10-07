import { quantityToMilli, roundDiv, toPaise } from './arith.js';
import { GstError } from './errors.js';
import type { Invoice } from './invoice.js';
import {
  documentTotals,
  summarize,
  taxOf,
  type DocumentTotals,
  type TaxSummaryRow,
  type TaxedLine,
} from './summary.js';
import type { SupplyType } from './types.js';
import { amountInWords } from './words.js';

/** Units of one original invoice line coming back on this credit note. */
export interface ReturnLineInput {
  /** The line's `index` on the original invoice. */
  readonly lineIndex: number;
  readonly quantity: number;
  /** Units of this line already returned on earlier credit notes (0 when none). */
  readonly previouslyReturnedQuantity: number;
}

export interface CreditNoteLine extends TaxedLine {
  readonly lineIndex: number;
  readonly categoryCode: string;
  readonly quantityMilli: number;
  readonly taxPaise: number;
  readonly totalPaise: number;
}

export interface CreditNote {
  readonly supplyType: SupplyType;
  readonly placeOfSupply: string;
  readonly stateTaxLabel: 'SGST' | 'UTGST';
  readonly lines: readonly CreditNoteLine[];
  readonly taxSummary: readonly TaxSummaryRow[];
  readonly totals: DocumentTotals;
  readonly amountInWords: string;
}

/**
 * The tax reversed by returning goods from `invoice`. Every amount on a line is
 * reversed in proportion to the units returned, cumulatively: this note reverses
 * f(previous + now) − f(previous), where f(q) = round(original × q / sold), half
 * up. So the notes for a line always add up to exactly the original once every
 * unit is back, however the returns were split, and CGST still equals SGST.
 *
 * `roundOff` rounds this note's total to the rupee. A full return in one note
 * then refunds exactly what was paid; several partial notes, each rounded,
 * can differ from the invoice's round-off by under a rupee in all.
 */
export function computeReturn(
  invoice: Invoice,
  returned: readonly ReturnLineInput[],
  roundOff: boolean,
): CreditNote {
  if (returned.length === 0) throw new GstError('invalid_return', 'Nothing is being returned');
  const seen = new Set<number>();
  const lines = returned.map((item): CreditNoteLine => {
    if (seen.has(item.lineIndex)) {
      throw new GstError('invalid_return', `Line ${String(item.lineIndex)} is listed twice`);
    }
    seen.add(item.lineIndex);
    const original = invoice.lines.find((line) => line.index === item.lineIndex);
    if (!original) {
      throw new GstError('invalid_return', `The invoice has no line ${String(item.lineIndex)}`);
    }
    const now = quantityToMilli(item.quantity);
    const before =
      item.previouslyReturnedQuantity === 0 ? 0n : quantityToMilli(item.previouslyReturnedQuantity);
    const sold = BigInt(original.quantityMilli);
    if (before + now > sold) {
      throw new GstError(
        'invalid_return',
        `More of line ${String(item.lineIndex)} returned than sold`,
      );
    }
    const share = (paise: number, quantity: bigint) => roundDiv(BigInt(paise) * quantity, sold);
    const reverse = (paise: number) => toPaise(share(paise, before + now) - share(paise, before));
    const heads = {
      taxablePaise: reverse(original.taxablePaise),
      cgstPaise: reverse(original.cgstPaise),
      sgstPaise: reverse(original.sgstPaise),
      igstPaise: reverse(original.igstPaise),
      cessPaise: reverse(original.cessPaise),
    };
    const taxPaise = taxOf(heads);
    return {
      lineIndex: original.index,
      categoryCode: original.categoryCode,
      quantityMilli: Number(now),
      rate: original.rate,
      ...heads,
      taxPaise,
      totalPaise: heads.taxablePaise + taxPaise,
    };
  });
  const totals = documentTotals(lines, roundOff);
  return {
    supplyType: invoice.supplyType,
    placeOfSupply: invoice.placeOfSupply,
    stateTaxLabel: invoice.stateTaxLabel,
    lines,
    taxSummary: summarize(lines),
    totals,
    amountInWords: amountInWords(totals.payablePaise),
  };
}
