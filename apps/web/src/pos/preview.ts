import {
  DEFAULT_GST_OPTIONS,
  computeInvoice,
  priceLine,
  stateCodeFromGstin,
  type GstError,
  type GstErrorCode,
  type GstRate,
  type Invoice,
  type TaxCategoryOptions,
} from '@paint/shared';
import { buyerGstin, type Bill } from './bill.js';

// The bill's total on the counter, worked out locally with the shared GST engine
// (no round trip per line, spec §5.2). The server works it out again on issue.

/**
 * Today's rate of every active tax category, as engine rows (the API's issue does
 * the same): a 0% category is exempt when it is the Exempt default, else nil-rated.
 */
export function ratesFrom(options: TaxCategoryOptions, today: string): GstRate[] {
  return options.categories.flatMap((category) =>
    category.currentRateBps === null
      ? []
      : [
          {
            categoryCode: category.id,
            nature:
              category.currentRateBps > 0
                ? 'taxable'
                : category.key === 'exempt'
                  ? 'exempt'
                  : 'nil_rated',
            rateBasisPoints: category.currentRateBps,
            cessBasisPoints: 0,
            effectiveFrom: today,
            effectiveTo: null,
          },
        ],
  );
}

export interface PreviewContext {
  /** The store's GSTIN; null for a store not registered for GST (it cannot bill). */
  readonly storeGstin: string | null;
  readonly rates: readonly GstRate[];
  /** India today, YYYY-MM-DD. */
  readonly today: string;
}

export type Preview =
  | { readonly ok: true; readonly invoice: Invoice; readonly payablePaise: number }
  | {
      readonly ok: false;
      /** Why there is no tax breakup: the store is unregistered, or the engine refused. */
      readonly reason: 'empty' | 'unregistered' | GstErrorCode;
      /** The lines' value after discounts, so the counter still sees a total. */
      readonly payablePaise: number;
    };

/** The bill as the engine prices it; an empty bill is ₹0. */
export function previewBill(bill: Bill, context: PreviewContext): Preview {
  const lines = bill.lines.map((line) => ({
    categoryCode: line.taxCategoryId ?? '',
    quantity: line.quantity,
    unitPricePaise: line.unitPricePaise,
    discount: line.discount,
  }));
  const netPaise = lines.reduce((sum, line) => sum + priceLine(line).netPaise, 0);
  if (context.storeGstin === null)
    return { ok: false, reason: 'unregistered', payablePaise: netPaise };
  if (lines.length === 0) return { ok: false, reason: 'empty', payablePaise: 0 };
  const supplierStateCode = stateCodeFromGstin(context.storeGstin);
  try {
    const invoice = computeInvoice({
      invoiceDate: context.today,
      registration: bill.kind === 'bill_of_supply' ? 'composition' : 'regular',
      parties: {
        supplierStateCode,
        buyerGstin: buyerGstin(bill.buyer),
        deliveryStateCode: null,
        storeStateCode: supplierStateCode,
      },
      pricesIncludeTax: bill.priceMode !== 'exclusive',
      lines,
      invoiceDiscount: null,
      rates: context.rates,
      options: DEFAULT_GST_OPTIONS,
    });
    return { ok: true, invoice, payablePaise: invoice.totals.payablePaise };
  } catch (error) {
    // The engine refuses with a GstError only (a product without a rate, an inter-state composition sale).
    return { ok: false, reason: (error as GstError).code, payablePaise: netPaise };
  }
}
