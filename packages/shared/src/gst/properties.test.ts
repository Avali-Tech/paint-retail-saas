import { describe, expect, it } from 'vitest';
import {
  computeInvoice,
  computeReturn,
  type GstOptions,
  type Invoice,
  type InvoiceInput,
  type LineInput,
  type ReturnLineInput,
} from '../index.js';
import { SCENARIO_RATES } from './scenarios.js';

/** mulberry32: a tiny seeded generator, so every run checks the same invoices. */
function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (max: number) => Math.floor(next() * (max + 1));
  const pick = <T>(items: readonly T[]): T => items[int(items.length - 1)] as T;
  return { int, pick };
}

const CATEGORIES = ['paint', 'tools', 'cess-demo', 'exempt'] as const;

function randomInvoice(seed: number): InvoiceInput {
  const { int, pick } = generator(seed);
  const pricesIncludeTax = int(1) === 1;
  const options: GstOptions = {
    taxRounding: pricesIncludeTax || int(1) === 0 ? 'line' : 'invoice',
    roundOff: int(1) === 1,
  };
  const lines = Array.from({ length: 1 + int(5) }, (): LineInput => {
    // Whole units, or up to 3 decimals for loose goods.
    const quantity = int(3) === 0 ? (1 + int(9_999)) / 1000 : 1 + int(20);
    const discountKind = int(2);
    const unitPricePaise = int(3) === 0 ? int(200) : int(5_00_000);
    return {
      categoryCode: pick(CATEGORIES),
      quantity,
      unitPricePaise,
      discount:
        discountKind === 0
          ? null
          : discountKind === 1
            ? { kind: 'percent', basisPoints: int(10_000) }
            : // An amount off is at most one unit's price, and loose lines can be under one unit.
              { kind: 'amount', paise: quantity >= 1 ? int(unitPricePaise) : 0 },
    };
  });
  return {
    invoiceDate: pick(['2018-07-26', '2018-07-27', '2025-09-21', '2025-09-22']),
    registration: int(9) === 0 ? 'composition' : 'regular',
    parties: {
      supplierStateCode: '36',
      buyerGstin: null,
      deliveryStateCode: int(1) === 0 ? null : pick(['36', '27', '29']),
      storeStateCode: '36',
    },
    pricesIncludeTax,
    lines,
    invoiceDiscount: int(2) === 0 ? { kind: 'percent', basisPoints: int(2_000) } : null,
    rates: SCENARIO_RATES,
    options,
  };
}

/** Builds the invoice, skipping composition dealers asked to sell inter-state (refused by law). */
function build(seed: number): { input: InvoiceInput; invoice: Invoice } | null {
  const input = randomInvoice(seed);
  try {
    return { input, invoice: computeInvoice(input) };
  } catch (error) {
    expect(error).toMatchObject({ code: 'composition_inter_state' });
    return null;
  }
}

const RUNS = 3000;
const built = Array.from({ length: RUNS }, (_, seed) => build(seed)).filter(
  (entry) => entry !== null,
);

describe('GST engine properties over generated invoices', () => {
  it('generates mostly valid invoices of every kind', () => {
    expect(built.length).toBeGreaterThan(RUNS * 0.9);
    const kinds = new Set(
      built.map(
        ({ input, invoice }) =>
          `${invoice.supplyType}/${String(input.pricesIncludeTax)}/${input.options.taxRounding}`,
      ),
    );
    expect(kinds.size).toBe(6);
  });

  it('CGST equals SGST on every line, and only one of CGST/IGST is charged', () => {
    for (const { invoice } of built) {
      for (const line of invoice.lines) {
        expect(line.cgstPaise).toBe(line.sgstPaise);
        if (invoice.supplyType === 'inter_state') expect(line.cgstPaise).toBe(0);
        else expect(line.igstPaise).toBe(0);
      }
      expect(invoice.totals.cgstPaise).toBe(invoice.totals.sgstPaise);
    }
  });

  it('taxable + tax equals the line amount: exactly when inclusive, within half a paisa per head when exclusive', () => {
    for (const { input, invoice } of built) {
      for (const line of invoice.lines) {
        const amount = line.grossPaise - line.lineDiscountPaise - line.invoiceDiscountPaise;
        expect(line.taxablePaise + line.taxPaise).toBe(line.totalPaise);
        if (input.pricesIncludeTax || input.registration === 'composition') {
          expect(line.totalPaise).toBe(amount);
        } else {
          expect(line.taxablePaise).toBe(amount);
        }
        if (input.options.taxRounding === 'line' && !input.pricesIncludeTax && line.rate) {
          // 2 × |head × 20000 − taxable × rate| ≤ 20000, in integers.
          const exact = BigInt(line.taxablePaise) * BigInt(line.rate.rateBasisPoints);
          const charged = BigInt(line.cgstPaise + line.sgstPaise + line.igstPaise) * 10_000n;
          const slack = invoice.supplyType === 'intra_state' ? 10_000n : 5_000n;
          expect(charged - exact <= slack && exact - charged <= slack).toBe(true);
        }
      }
    }
  });

  it('totals add up and round-off lands on a whole rupee within −49 to +50 paise', () => {
    for (const { input, invoice } of built) {
      const { totals } = invoice;
      expect(totals.grossPaise - totals.lineDiscountPaise - totals.invoiceDiscountPaise).toBe(
        input.pricesIncludeTax || input.registration === 'composition'
          ? totals.totalPaise
          : totals.taxablePaise,
      );
      expect(invoice.lines.reduce((sum, line) => sum + line.invoiceDiscountPaise, 0)).toBe(
        totals.invoiceDiscountPaise,
      );
      const summaryTax = invoice.taxSummary.reduce((sum, row) => sum + row.taxPaise, 0);
      expect(summaryTax).toBe(totals.taxPaise);
      expect(totals.payablePaise).toBe(totals.totalPaise + totals.roundOffPaise);
      if (input.options.roundOff) {
        expect(totals.payablePaise % 100).toBe(0);
        expect(totals.roundOffPaise).toBeGreaterThanOrEqual(-49);
        expect(totals.roundOffPaise).toBeLessThanOrEqual(50);
      } else {
        expect(totals.roundOffPaise).toBe(0);
      }
      if (input.registration === 'composition') {
        expect(totals.taxPaise).toBe(0);
        expect(invoice.documentType).toBe('bill_of_supply');
      }
    }
  });

  it('a full return, in one note or split into several, reverses exactly the original tax', () => {
    for (const [run, { invoice }] of built.entries()) {
      const { int } = generator(run + 1_000_000);
      const all: ReturnLineInput[] = invoice.lines.map((line) => ({
        lineIndex: line.index,
        quantity: line.quantityMilli / 1000,
        previouslyReturnedQuantity: 0,
      }));
      const whole = computeReturn(invoice, all, false).totals;
      const keys = [
        'taxablePaise',
        'cgstPaise',
        'sgstPaise',
        'igstPaise',
        'cessPaise',
        'totalPaise',
      ] as const;
      for (const key of keys) expect(whole[key]).toBe(invoice.totals[key]);

      // The same, one line at a time in random thousandth-unit slices.
      const sums = Object.fromEntries(keys.map((key) => [key, 0])) as Record<
        (typeof keys)[number],
        number
      >;
      for (const line of invoice.lines) {
        let returned = 0;
        while (returned < line.quantityMilli) {
          const slice = Math.min(line.quantityMilli - returned, 1 + int(line.quantityMilli));
          const note = computeReturn(
            invoice,
            [
              {
                lineIndex: line.index,
                quantity: slice / 1000,
                previouslyReturnedQuantity: returned / 1000,
              },
            ],
            false,
          );
          for (const key of keys) sums[key] += note.totals[key];
          expect(note.totals.cgstPaise).toBe(note.totals.sgstPaise);
          returned += slice;
        }
      }
      for (const key of keys) expect(sums[key]).toBe(invoice.totals[key]);
    }
  });
});
