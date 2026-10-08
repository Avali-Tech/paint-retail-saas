import { describe, expect, it } from 'vitest';
import { WALK_IN, billReducer, buyerGstin, draftInput, newBill, type Bill } from './bill.js';
import { discountText, parseDiscount, parseScan } from './entry.js';
import { previewBill, ratesFrom } from './preview.js';
import { nextMode, settle } from './tender.js';
import { AP_GSTIN, MODES, OPTIONS, TS_GSTIN, item } from './test-support/pos-fixtures.js';

const TODAY = '2026-10-08';
const RATES = ratesFrom(OPTIONS, TODAY);
const context = { storeGstin: TS_GSTIN, rates: RATES, today: TODAY };

const withLines = (...actions: Parameters<typeof billReducer>[1][]): Bill =>
  actions.reduce(billReducer, newBill('bill-1'));

describe('the bill', () => {
  it('adds lines, merges a pack scanned again and selects the last change', () => {
    const bill = withLines(
      { type: 'add', item: item(), quantity: 1 },
      { type: 'add', item: item({ variantId: 'v2', sku: 'B' }), quantity: 2 },
      { type: 'add', item: item(), quantity: 1.5 },
    );
    expect(bill.lines.map((line) => [line.variantId, line.quantity])).toEqual([
      ['v-apex-20', 2.5],
      ['v2', 2],
    ]);
    expect(bill.selected).toBe(0);
    expect(bill.version).toBe(3);
  });

  it('changes quantity, steps (never below one), discounts, selects and removes', () => {
    let bill = withLines(
      { type: 'add', item: item(), quantity: 1 },
      { type: 'add', item: item({ variantId: 'v2' }), quantity: 1 },
    );
    bill = billReducer(bill, { type: 'quantity', index: 0, quantity: 3 });
    bill = billReducer(bill, { type: 'step', index: 0, by: 1 });
    bill = billReducer(bill, { type: 'step', index: 1, by: -1 });
    bill = billReducer(bill, {
      type: 'discount',
      index: 0,
      discount: { kind: 'percent', basisPoints: 500 },
    });
    expect(bill.lines.map((line) => line.quantity)).toEqual([4, 1]);
    expect(bill.lines[0]?.discount).toEqual({ kind: 'percent', basisPoints: 500 });
    const version = bill.version;
    bill = billReducer(bill, { type: 'select', index: 1 });
    expect([bill.selected, bill.version]).toEqual([1, version]);
    bill = billReducer(bill, { type: 'remove', index: 1 });
    expect([bill.lines.length, bill.selected]).toEqual([1, 0]);
    bill = billReducer(bill, { type: 'remove', index: 0 });
    expect([bill.lines.length, bill.selected]).toEqual([0, null]);
  });

  it('takes the saved draft only for the same bill, and resets and loads', () => {
    let bill = withLines({ type: 'buyer', buyer: { name: 'Ravi' } });
    bill = billReducer(bill, { type: 'saved', key: 'other', draftId: 'd0' });
    expect(bill.draftId).toBeNull();
    bill = billReducer(bill, {
      type: 'saved',
      key: 'bill-1',
      draftId: 'd1',
      kind: 'bill_of_supply',
      priceMode: 'exclusive',
    });
    bill = billReducer(bill, { type: 'saved', key: 'bill-1', draftId: 'd1' });
    expect([bill.draftId, bill.kind, bill.priceMode, bill.buyer.name]).toEqual([
      'd1',
      'bill_of_supply',
      'exclusive',
      'Ravi',
    ]);
    expect(billReducer(bill, { type: 'reset', key: 'next' })).toEqual(newBill('next'));
    expect(billReducer(bill, { type: 'load', bill: newBill('x') }).key).toBe('x');
  });

  it('makes the draft, leaving out blanks and a GSTIN still being typed', () => {
    const bill = withLines(
      { type: 'add', item: item(), quantity: 2 },
      { type: 'discount', index: 0, discount: { kind: 'amount', paise: 100 } },
      { type: 'add', item: item({ variantId: 'v2', unitPricePaise: 500 }), quantity: 1 },
      { type: 'buyer', buyer: { gstin: '36AAB', name: ' Ravi ', address: '  ' } },
    );
    expect(draftInput(bill, 'store-1')).toEqual({
      storeId: 'store-1',
      buyer: { name: 'Ravi' },
      lines: [
        {
          variantId: 'v-apex-20',
          quantity: 2,
          unitPricePaise: 1_045_000,
          discount: { kind: 'amount', paise: 100 },
        },
        { variantId: 'v2', quantity: 1, unitPricePaise: 500 },
      ],
    });
    const b2b = billReducer(bill, {
      type: 'buyer',
      buyer: { partyId: 'p1', gstin: ` ${AP_GSTIN.toLowerCase()} `, stateCode: '37' },
    });
    expect(draftInput(b2b, 'store-1')).toMatchObject({
      partyId: 'p1',
      buyer: { name: 'Ravi', gstin: AP_GSTIN, stateCode: '37' },
    });
    expect(buyerGstin(WALK_IN)).toBeNull();
  });
});

describe('what the cashier types', () => {
  it('reads a quantity before the scan', () => {
    expect(parseScan(' 3*8901000000017 ')).toEqual({ quantity: 3, code: '8901000000017' });
    expect(parseScan('2.5* apex')).toEqual({ quantity: 2.5, code: 'apex' });
    expect(parseScan('5*')).toEqual({ quantity: 5, code: '' });
    expect(parseScan('apex')).toEqual({ quantity: 1, code: 'apex' });
    expect(parseScan('0*apex')).toEqual({ quantity: 1, code: '0*apex' });
  });

  it('reads a discount as a percentage or rupees, within the line', () => {
    expect(parseDiscount('', 1000)).toEqual({ discount: null });
    expect(parseDiscount('12.5 %', 1000)).toEqual({
      discount: { kind: 'percent', basisPoints: 1250 },
    });
    expect(parseDiscount('101%', 1000)).toBeNull();
    expect(parseDiscount('5%%', 1000)).toBeNull();
    expect(parseDiscount('7.5', 1000)).toEqual({ discount: { kind: 'amount', paise: 750 } });
    expect(parseDiscount('11', 1000)).toBeNull();
    expect(parseDiscount('-1', 1000)).toBeNull();
    expect(parseDiscount('ten', 1000)).toBeNull();
    expect(discountText(null)).toBe('');
    expect(discountText({ kind: 'percent', basisPoints: 1250 })).toBe('12.5%');
    expect(discountText({ kind: 'amount', paise: 750 })).toBe('7.50');
  });
});

describe('the local preview', () => {
  it('turns today’s tax categories into engine rates', () => {
    expect(RATES.map((rate) => [rate.categoryCode, rate.nature, rate.rateBasisPoints])).toEqual([
      ['tax-paints', 'taxable', 1800],
      ['tax-tools', 'taxable', 1200],
      ['tax-exempt', 'exempt', 0],
      ['tax-nil', 'nil_rated', 0],
    ]);
  });

  it('prices an inclusive counter sale like the shelf price, intra-state', () => {
    const bill = withLines({ type: 'add', item: item(), quantity: 1 });
    const preview = previewBill(bill, context);
    expect(preview.payablePaise).toBe(1_045_000);
    if (!preview.ok) throw new Error('expected a preview');
    expect(preview.invoice.supplyType).toBe('intra_state');
    expect(preview.invoice.totals.cgstPaise).toBe(preview.invoice.totals.sgstPaise);
  });

  it('adds GST to exclusive prices, and goes inter-state for another state’s GSTIN', () => {
    const bill = {
      ...withLines(
        { type: 'add', item: item({ unitPricePaise: 10_000 }), quantity: 1 },
        { type: 'buyer', buyer: { gstin: AP_GSTIN } },
      ),
      priceMode: 'exclusive' as const,
    };
    const preview = previewBill(bill, context);
    if (!preview.ok) throw new Error('expected a preview');
    expect([preview.invoice.supplyType, preview.invoice.totals.igstPaise]).toEqual([
      'inter_state',
      1800,
    ]);
    expect(preview.payablePaise).toBe(11_800);
  });

  it('shows a bill of supply for a composition store', () => {
    const bill = {
      ...withLines({ type: 'add', item: item(), quantity: 1 }),
      kind: 'bill_of_supply' as const,
    };
    const preview = previewBill(bill, context);
    expect(preview.ok && preview.invoice.documentType).toBe('bill_of_supply');
  });

  it('still totals the lines when it cannot work out the tax', () => {
    const lines = withLines(
      { type: 'add', item: item({ taxCategoryId: null, unitPricePaise: 1000 }), quantity: 2 },
      { type: 'discount', index: 0, discount: { kind: 'amount', paise: 500 } },
    );
    expect(previewBill(lines, context)).toEqual({
      ok: false,
      reason: 'no_rate',
      payablePaise: 1500,
    });
    expect(previewBill(lines, { ...context, storeGstin: null })).toEqual({
      ok: false,
      reason: 'unregistered',
      payablePaise: 1500,
    });
    expect(previewBill(newBill('x'), context)).toEqual({
      ok: false,
      reason: 'empty',
      payablePaise: 0,
    });
  });
});

describe('taking the money', () => {
  it('gives change from cash only, recording cash net of it', () => {
    expect(
      settle(
        10_000,
        [
          { modeId: 'mode-upi', amountPaise: 4000 },
          { modeId: 'mode-cash', amountPaise: 5000 },
          { modeId: 'mode-cash', amountPaise: 2000 },
        ],
        MODES,
        'rs1',
      ),
    ).toEqual({
      tenderedPaise: 11_000,
      shortPaise: 0,
      changePaise: 1000,
      payments: [
        { modeId: 'mode-upi', amountPaise: 4000 },
        { modeId: 'mode-cash', amountPaise: 5000, registerSessionId: 'rs1' },
        { modeId: 'mode-cash', amountPaise: 1000, tenderedPaise: 2000, registerSessionId: 'rs1' },
      ],
      overpaid: false,
    });
  });

  it('flags card or UPI above the bill, and what is still owed', () => {
    expect(settle(1000, [{ modeId: 'mode-upi', amountPaise: 1500 }], MODES, null)).toMatchObject({
      changePaise: 0,
      overpaid: true,
    });
    expect(
      settle(
        1000,
        [
          { modeId: 'mode-cash', amountPaise: 400 },
          { modeId: 'mode-upi', amountPaise: 0 },
        ],
        MODES,
        null,
      ),
    ).toMatchObject({ shortPaise: 600, payments: [{ modeId: 'mode-cash', amountPaise: 400 }] });
  });

  it('offers cash, then UPI, then card, then the rest by name', () => {
    expect(nextMode(MODES, [])).toBe('mode-cash');
    expect(nextMode(MODES, ['mode-cash'])).toBe('mode-upi');
    expect(nextMode(MODES, ['mode-cash', 'mode-upi'])).toBe('mode-card');
    expect(
      nextMode(
        MODES,
        MODES.map((mode) => mode.id),
      ),
    ).toBe('mode-cash');
    expect(
      nextMode(
        [
          { id: 'b', kind: 'other', name: 'Wallet', isActive: true },
          { id: 'a', kind: 'cheque', name: 'Cheque', isActive: true },
        ],
        [],
      ),
    ).toBe('a');
    expect(nextMode([], [])).toBeNull();
  });
});
