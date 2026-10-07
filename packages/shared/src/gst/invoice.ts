import { allocateProportionally, at } from './arith.js';
import { GstError } from './errors.js';
import { discountAmount, priceLine, taxOnAmount, type LineInput } from './line.js';
import { placeOfSupply, type Parties } from './place-of-supply.js';
import { rateOn } from './rates.js';
import { stateTaxLabel } from './states.js';
import {
  documentTotals,
  summarize,
  taxOf,
  type DocumentTotals,
  type TaxSummaryRow,
  type TaxedLine,
} from './summary.js';
import type {
  AppliedRate,
  BuyerType,
  Discount,
  DocumentType,
  GstOptions,
  GstRate,
  RegistrationType,
  SupplyType,
  TaxHeads,
} from './types.js';
import { amountInWords } from './words.js';

export interface InvoiceInput {
  /** ISO `YYYY-MM-DD`; picks the rate in force that day. */
  readonly invoiceDate: string;
  readonly registration: RegistrationType;
  readonly parties: Parties;
  /** True when unit prices include GST (the usual counter price), false when tax is added. */
  readonly pricesIncludeTax: boolean;
  readonly lines: readonly LineInput[];
  /** A discount on the whole bill, spread over the lines in proportion to their net. */
  readonly invoiceDiscount: Discount | null;
  readonly rates: readonly GstRate[];
  readonly options: GstOptions;
}

export interface InvoiceLine extends TaxedLine {
  readonly index: number;
  readonly categoryCode: string;
  readonly quantityMilli: number;
  readonly unitPricePaise: number;
  readonly grossPaise: number;
  readonly lineDiscountPaise: number;
  /** This line's share of the invoice discount. */
  readonly invoiceDiscountPaise: number;
  readonly taxPaise: number;
  /** Taxable value plus tax. */
  readonly totalPaise: number;
}

export interface InvoiceTotals extends DocumentTotals {
  readonly grossPaise: number;
  readonly lineDiscountPaise: number;
  readonly invoiceDiscountPaise: number;
}

export interface Invoice {
  readonly documentType: DocumentType;
  readonly buyerType: BuyerType;
  readonly placeOfSupply: string;
  readonly supplyType: SupplyType;
  /** The supplier state's label for the state half: SGST, or UTGST in a UT without a legislature. */
  readonly stateTaxLabel: 'SGST' | 'UTGST';
  readonly pricesIncludeTax: boolean;
  readonly lines: readonly InvoiceLine[];
  /** Totals per nature and rate, for the tax summary block and GSTR-1. Empty on a bill of supply. */
  readonly taxSummary: readonly TaxSummaryRow[];
  readonly totals: InvoiceTotals;
  readonly amountInWords: string;
}

const NO_TAX = { cgstPaise: 0, sgstPaise: 0, igstPaise: 0, cessPaise: 0 };

/**
 * Invoice-level rounding (tax-exclusive only): tax is rounded once per rate on
 * the group's summed taxable value, then each head is spread over the group's
 * lines in proportion to their taxable value (largest remainder), so the group
 * equals one line of the summed value and CGST still equals SGST on every line.
 */
function taxPerGroup(
  amounts: readonly number[],
  rates: readonly AppliedRate[],
  supplyType: SupplyType,
): TaxHeads[] {
  const result: TaxHeads[] = amounts.map((amount) => ({ taxablePaise: amount, ...NO_TAX }));
  const groups = new Map<string, number[]>();
  rates.forEach((rate, index) => {
    const key = `${rate.nature}|${String(rate.rateBasisPoints)}|${String(rate.cessBasisPoints)}`;
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  for (const members of groups.values()) {
    const weights = members.map((index) => at(amounts, index));
    const total = weights.reduce((sum, amount) => sum + amount, 0);
    const group = taxOnAmount(total, at(rates, at(members, 0)), supplyType, false);
    const spread = (head: number) => allocateProportionally(head, weights);
    const [cgst, sgst, igst, cess] = [
      spread(group.cgstPaise),
      spread(group.sgstPaise),
      spread(group.igstPaise),
      spread(group.cessPaise),
    ];
    members.forEach((lineIndex, k) => {
      result[lineIndex] = {
        taxablePaise: at(amounts, lineIndex),
        cgstPaise: at(cgst, k),
        sgstPaise: at(sgst, k),
        igstPaise: at(igst, k),
        cessPaise: at(cess, k),
      };
    });
  }
  return result;
}

/** Computes a GST tax invoice, or a bill of supply for a composition dealer. */
export function computeInvoice(input: InvoiceInput): Invoice {
  const where = placeOfSupply(input.parties);
  const composition = input.registration === 'composition';
  if (composition && where.supplyType === 'inter_state') {
    throw new GstError(
      'composition_inter_state',
      'A composition dealer cannot make an inter-state supply',
    );
  }
  if (input.options.taxRounding === 'invoice' && input.pricesIncludeTax) {
    // An inclusive price fixes each line's total, so its tax can only be worked per line.
    throw new GstError('unsupported_rounding', 'Invoice-level rounding needs tax-exclusive prices');
  }
  if (input.lines.length === 0) {
    throw new GstError('invalid_quantity', 'An invoice needs at least one line');
  }
  const priced = input.lines.map(priceLine);
  const nets = priced.map((line) => line.netPaise);
  const invoiceDiscountPaise = discountAmount(
    nets.reduce((sum, net) => sum + net, 0),
    input.invoiceDiscount,
  );
  const shares = allocateProportionally(invoiceDiscountPaise, nets);
  const amounts = nets.map((net, index) => net - at(shares, index));

  let rates: (AppliedRate | null)[];
  let heads: TaxHeads[];
  if (composition) {
    rates = amounts.map(() => null);
    heads = amounts.map((amount) => ({ taxablePaise: amount, ...NO_TAX }));
  } else {
    const applied = input.lines.map((line) =>
      rateOn(input.rates, line.categoryCode, input.invoiceDate),
    );
    rates = applied;
    heads =
      input.options.taxRounding === 'line'
        ? amounts.map((amount, index) =>
            taxOnAmount(amount, at(applied, index), where.supplyType, input.pricesIncludeTax),
          )
        : taxPerGroup(amounts, applied, where.supplyType);
  }

  const lines = input.lines.map((line, index): InvoiceLine => {
    const lineHeads = at(heads, index);
    const pricedLine = at(priced, index);
    const taxPaise = taxOf(lineHeads);
    return {
      index,
      categoryCode: line.categoryCode,
      quantityMilli: pricedLine.quantityMilli,
      unitPricePaise: line.unitPricePaise,
      grossPaise: pricedLine.grossPaise,
      lineDiscountPaise: pricedLine.lineDiscountPaise,
      invoiceDiscountPaise: at(shares, index),
      rate: at(rates, index),
      ...lineHeads,
      taxPaise,
      totalPaise: lineHeads.taxablePaise + taxPaise,
    };
  });
  const totals = documentTotals(lines, input.options.roundOff);
  return {
    documentType: composition ? 'bill_of_supply' : 'tax_invoice',
    ...where,
    stateTaxLabel: stateTaxLabel(input.parties.supplierStateCode),
    pricesIncludeTax: input.pricesIncludeTax,
    lines,
    taxSummary: summarize(lines),
    totals: {
      ...totals,
      grossPaise: priced.reduce((sum, line) => sum + line.grossPaise, 0),
      lineDiscountPaise: priced.reduce((sum, line) => sum + line.lineDiscountPaise, 0),
      invoiceDiscountPaise,
    },
    amountInWords: amountInWords(totals.payablePaise),
  };
}
