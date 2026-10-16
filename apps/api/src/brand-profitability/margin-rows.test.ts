import { describe, expect, it } from 'vitest';
import {
  averageCosts,
  marginRows,
  outstandingSpans,
  spread,
  type CostedMove,
  type CreditBill,
  type MarginInputs,
  type PeriodLine,
  type StoredEarnRule,
} from './margin-rows.js';

const S1 = 'store-1';
const S2 = 'store-2';
const V1 = 'variant-1';
const V2 = 'variant-2';

const move = (over: Partial<CostedMove>): CostedMove => ({
  storeId: S1,
  variantId: V1,
  at: 100n,
  quantity: 10,
  unitCostPaise: 500,
  onHandBefore: 0,
  ...over,
});

const line = (over: Partial<PeriodLine>): PeriodLine => ({
  documentId: 'inv-1',
  kind: 'invoice',
  cancelled: false,
  storeId: S1,
  issuedOn: '2026-07-10',
  issuedAt: 1_000n,
  lineId: 'line-1',
  variantId: V1,
  productId: 'apex',
  brandId: 'asian',
  taxablePaise: 100_000,
  totalPaise: 118_000,
  quantity: 2,
  packSize: 10,
  unit: 'l',
  sourceIssuedOn: null,
  ...over,
});

const bill = (over: Partial<CreditBill>): CreditBill => ({
  id: 'inv-1',
  storeId: S1,
  raisedOn: '2026-07-01',
  totalPaise: 1_000,
  cancelledOn: null,
  allocations: [],
  lines: [{ productId: 'apex', brandId: 'asian', totalPaise: 1_000 }],
  ...over,
});

const rule = (over: Partial<StoredEarnRule>): StoredEarnRule => ({
  id: 'rule-1',
  basis: 'value',
  points: 1,
  perPaise: 10_000,
  perMillilitres: null,
  brandId: null,
  multiplierBps: 10_000,
  isActive: true,
  validFrom: null,
  validUntil: null,
  ...over,
});

const none: MarginInputs = {
  lines: [],
  restocks: [],
  costedMoves: [],
  bills: [],
  points: [],
  rules: [],
};
const period = { from: '2026-07-01', to: '2026-09-30', pointValuePaise: 100 };

describe('averageCosts', () => {
  it('replays the weighted average after each receipt, and answers for any moment', () => {
    const costs = averageCosts([
      move({ at: 100n, quantity: 10, unitCostPaise: 500, onHandBefore: 0 }),
      // 10 left at ₹5, 10 more at ₹7: ₹6.
      move({ at: 200n, quantity: 10, unitCostPaise: 700, onHandBefore: 10 }),
      // Sold out, then bought again: the new cost.
      move({ at: 300n, quantity: 5, unitCostPaise: 900, onHandBefore: 0 }),
      move({ storeId: S2, at: 150n, unitCostPaise: 400 }),
    ]);
    expect(costs.at(S1, V1, 99n)).toBeNull();
    expect(costs.at(S1, V1, 100n)).toBe(500n);
    expect(costs.at(S1, V1, 199n)).toBe(500n);
    expect(costs.at(S1, V1, 250n)).toBe(600n);
    expect(costs.at(S1, V1, 10_000n)).toBe(900n);
    expect(costs.at(S2, V1, 150n)).toBe(400n);
    expect(costs.at(S2, V2, 150n)).toBeNull();
  });
});

describe('outstandingSpans', () => {
  it('is the whole bill from the day it was raised while nothing is paid', () => {
    expect(outstandingSpans(bill({}))).toEqual([
      { amountPaise: 1_000, fromOn: '2026-07-01', paidOn: null },
    ]);
  });

  it('steps down on each day money was set against it, and ends when paid', () => {
    expect(
      outstandingSpans(
        bill({
          allocations: [
            { on: '2026-07-11', amountPaise: 300 },
            { on: '2026-07-21', amountPaise: 200 },
            { on: '2026-07-21', amountPaise: 500 },
          ],
        }),
      ),
    ).toEqual([
      { amountPaise: 1_000, fromOn: '2026-07-01', paidOn: '2026-07-11' },
      { amountPaise: 700, fromOn: '2026-07-11', paidOn: '2026-07-21' },
    ]);
  });

  it('owes nothing for a bill paid the day it was raised', () => {
    expect(
      outstandingSpans(bill({ allocations: [{ on: '2026-07-01', amountPaise: 1_000 }] })),
    ).toEqual([]);
  });

  it('owes again from the day a payment is undone (a bounced cheque)', () => {
    expect(
      outstandingSpans(
        bill({
          allocations: [
            { on: '2026-07-05', amountPaise: 1_000 },
            { on: '2026-07-15', amountPaise: -1_000 },
          ],
        }),
      ),
    ).toEqual([
      { amountPaise: 1_000, fromOn: '2026-07-01', paidOn: '2026-07-05' },
      { amountPaise: 1_000, fromOn: '2026-07-15', paidOn: null },
    ]);
  });

  it('stops on the day a bill was cancelled', () => {
    expect(
      outstandingSpans(
        bill({
          cancelledOn: '2026-07-03',
          allocations: [{ on: '2026-07-04', amountPaise: 1_000 }],
        }),
      ),
    ).toEqual([{ amountPaise: 1_000, fromOn: '2026-07-01', paidOn: '2026-07-03' }]);
  });
});

describe('spread', () => {
  it('splits by weight, the largest remainder first, keeping the sign', () => {
    expect(spread(10, [1n, 2n])).toEqual([3, 7]);
    expect(spread(-10, [1n, 2n])).toEqual([-3, -7]);
  });

  it('splits evenly when nothing weighs anything', () => {
    expect(spread(3, [0n, 0n])).toEqual([2, 1]);
  });

  it('scales weights too large for a number', () => {
    const huge = BigInt(Number.MAX_SAFE_INTEGER) * 8n;
    expect(spread(100, [huge, huge * 3n])).toEqual([25, 75]);
  });
});

describe('marginRows', () => {
  it('counts sales, debit notes and credit notes by taxable value, and nothing cancelled', () => {
    const rows = marginRows(
      {
        ...none,
        lines: [
          line({}),
          line({ documentId: 'bos-1', kind: 'bill_of_supply', lineId: 'l2', taxablePaise: 5_000 }),
          line({ documentId: 'dn-1', kind: 'debit_note', lineId: 'l3', taxablePaise: 700 }),
          line({ documentId: 'cn-1', kind: 'credit_note', lineId: 'l4', taxablePaise: 20_000 }),
          line({ documentId: 'x-1', cancelled: true, lineId: 'l5', taxablePaise: 99_999 }),
        ],
      },
      period,
    );
    expect(rows).toEqual([
      {
        brandId: 'asian',
        productId: 'apex',
        storeId: S1,
        invoicedPaise: 105_700,
        creditNotePaise: 20_000,
        costOfSalesPaise: 0,
        costReturnedPaise: 0,
        creditPaiseDays: 0,
        loyaltyPaise: 0,
        painterPointsPaise: 0,
        uncostedLines: 2,
      },
    ]);
  });

  it('costs units invoiced at the average cost when issued, and counts the uncosted', () => {
    const rows = marginRows(
      {
        ...none,
        costedMoves: [
          move({ at: 500n, quantity: 10, unitCostPaise: 3_333 }),
          move({ at: 2_000n, quantity: 10, unitCostPaise: 9_999, onHandBefore: 8 }),
        ],
        lines: [
          // 2.5 units at ₹33.33: ₹83.325 → ₹83.33 (half up, once per row).
          line({ quantity: 2.5 }),
          line({ documentId: 'inv-2', lineId: 'l2', quantity: 1, issuedAt: 400n }),
          line({ documentId: 'inv-3', lineId: 'l3', brandId: 'nerolac', productId: 'beauty' }),
        ],
      },
      period,
    );
    expect(rows.map((row) => [row.brandId, row.costOfSalesPaise, row.uncostedLines])).toEqual([
      ['asian', 8_333, 1],
      ['nerolac', 6_666, 0],
    ]);
  });

  it('takes off the units a note put back on the shelf, at the cost on the note’s day', () => {
    const rows = marginRows(
      {
        ...none,
        costedMoves: [
          move({ at: 500n, unitCostPaise: 400 }),
          move({ at: 1_500n, unitCostPaise: 800, onHandBefore: 10 }),
        ],
        lines: [
          line({ documentId: 'cn-1', kind: 'credit_note', issuedAt: 2_000n, quantity: 3 }),
          line({ documentId: 'cn-2', kind: 'credit_note', lineId: 'l2', issuedAt: 2_000n }),
          line({ documentId: 'cn-3', kind: 'credit_note', lineId: 'l3', issuedAt: 100n }),
        ],
        restocks: [
          // Three back, one of them written off: two on the shelf at ₹6.
          { documentId: 'cn-1', variantId: V1, quantity: 2 },
          // All written off.
          { documentId: 'cn-2', variantId: V1, quantity: 0 },
          // Back before any costed stock: at no cost.
          { documentId: 'cn-3', variantId: V1, quantity: 1 },
          // Not a line of the note (another product's movement).
          { documentId: 'cn-1', variantId: V2, quantity: 5 },
          { documentId: 'unknown', variantId: V1, quantity: 5 },
        ],
      },
      period,
    );
    expect(rows[0]?.costReturnedPaise).toBe(1_200);
  });

  it('spreads each bill’s paise-days in the period over its lines by line total', () => {
    const rows = marginRows(
      {
        ...none,
        bills: [
          bill({
            raisedOn: '2026-06-21',
            totalPaise: 3_000,
            allocations: [{ on: '2026-07-11', amountPaise: 3_000 }],
            lines: [
              { productId: 'apex', brandId: 'asian', totalPaise: 1_000 },
              { productId: 'beauty', brandId: 'nerolac', totalPaise: 2_000 },
            ],
          }),
          // Owed only before the period.
          bill({
            id: 'old',
            raisedOn: '2026-05-01',
            allocations: [{ on: '2026-06-01', amountPaise: 1_000 }],
          }),
          bill({ id: 'no-lines', lines: [] }),
          // Still owed at the period's end, at another store.
          bill({ id: 'open', storeId: S2, raisedOn: '2026-09-21', totalPaise: 100 }),
        ],
      },
      period,
    );
    // ₹30 owed 1–10 July: 30,000 paise-days, a third to Apex.
    expect(rows.map((row) => [row.productId, row.storeId, row.creditPaiseDays])).toEqual([
      ['apex', S1, 10_000],
      ['beauty', S1, 20_000],
      ['apex', S2, 1_000],
    ]);
  });

  it('values points and spreads them: the bill-to by taxable value, the painter by earnings', () => {
    const invoice = [
      line({ lineId: 'a', taxablePaise: 30_000 }),
      line({ lineId: 'b', taxablePaise: 10_000, brandId: 'nerolac', productId: 'beauty' }),
    ];
    const rows = marginRows(
      {
        ...none,
        lines: [
          ...invoice,
          // A note on the invoice: weighed by the rules of the invoice's day.
          line({
            documentId: 'cn-1',
            kind: 'credit_note',
            lineId: 'c',
            issuedOn: '2026-08-01',
            sourceIssuedOn: '2026-07-10',
            taxablePaise: 10_000,
            brandId: 'nerolac',
            productId: 'beauty',
          }),
        ],
        rules: [
          rule({}),
          // Double points on Nerolac, in force on the invoice's day only.
          rule({
            id: 'rule-2',
            brandId: 'nerolac',
            multiplierBps: 20_000,
            validUntil: '2026-07-31',
          }),
          rule({ id: 'off', points: 50, isActive: false }),
        ],
        points: [
          { documentId: 'inv-1', holder: 'customer', points: 4 },
          { documentId: 'inv-1', holder: 'painter', points: 5 },
          { documentId: 'cn-1', holder: 'painter', points: -1 },
          { documentId: 'cn-1', holder: 'customer', points: 0 },
          { documentId: 'elsewhere', holder: 'customer', points: 9 },
        ],
      },
      period,
    );
    const figures = Object.fromEntries(
      rows.map((row) => [row.productId, [row.loyaltyPaise, row.painterPointsPaise]]),
    );
    // Bill-to ₹4 by 3:1; painter ₹5 by 3:2 (Nerolac earns double); the note takes ₹1 back.
    expect(figures).toEqual({ apex: [300, 300], beauty: [100, 100] });
  });

  it('counts a slice that took back more points than it earned in the period as none', () => {
    const rows = marginRows(
      {
        ...none,
        lines: [line({ documentId: 'cn-1', kind: 'credit_note' })],
        rules: [rule({ basis: 'litre', perPaise: null, perMillilitres: 1_000 })],
        points: [
          { documentId: 'cn-1', holder: 'customer', points: -3 },
          { documentId: 'cn-1', holder: 'painter', points: -2 },
        ],
      },
      period,
    );
    expect([rows[0]?.loyaltyPaise, rows[0]?.painterPointsPaise]).toEqual([0, 0]);
  });
});
