import { describe, expect, it } from 'vitest';
import {
  checkOrderLines,
  checkReceiptLines,
  effectiveCost,
  lineValue,
  parseCost,
  parseQuantity,
  type ReceiptLineDraft,
} from './drafts.js';
import { parseDays } from './SupplierDetailPage.js';

const receipt = (changes: Partial<ReceiptLineDraft>): ReceiptLineDraft => ({
  variantId: 'v1',
  sku: 'A-1',
  name: 'Apex',
  pending: null,
  orderCostPaise: null,
  quantity: '1',
  free: '0',
  unitCost: '',
  ...changes,
});

describe('purchase line drafts', () => {
  it('reads quantities of zero or more with up to three decimals', () => {
    expect(parseQuantity(' 2.125 ')).toBe(2.125);
    expect(parseQuantity('0')).toBe(0);
    expect(parseQuantity('-1')).toBeNull();
    expect(parseQuantity('1.2345')).toBeNull();
    expect(parseQuantity('two')).toBeNull();
  });

  it('reads costs in rupees, blank meaning "use the last cost"', () => {
    expect(parseCost('')).toBeNull();
    expect(parseCost('1,250.50')).toBe(125_050);
    expect(parseCost('-5')).toBeUndefined();
    expect(parseCost('abc')).toBeUndefined();
    expect(effectiveCost('', 400)).toBe(400);
    expect(effectiveCost('x', null)).toBeNull();
    expect(effectiveCost('5', 400)).toBe(500);
    expect(lineValue(1.5, 333)).toBe(500);
    expect(lineValue(2, null)).toBeNull();
  });

  it('checks order lines', () => {
    expect(checkOrderLines([])).toEqual({ lines: 'workflow.noLines' });
    expect(
      checkOrderLines([
        { variantId: 'a', sku: 'A', name: 'A', quantity: '0', unitCost: 'x' },
        { variantId: 'b', sku: 'B', name: 'B', quantity: '2', unitCost: '' },
      ]),
    ).toEqual({
      'qty-a': 'purchasing.line.orderQuantityInvalid',
      'cost-a': 'purchasing.line.costInvalid',
    });
  });

  it('checks receipt lines: quantities, what is still due, free units and costs', () => {
    expect(checkReceiptLines([])).toEqual({ lines: 'workflow.noLines' });
    expect(checkReceiptLines([receipt({})])).toEqual({});
    expect(checkReceiptLines([receipt({ quantity: 'x', free: 'y', unitCost: 'z' })])).toEqual({
      'qty-v1': 'purchasing.line.quantityInvalid',
      'free-v1': 'purchasing.line.quantityInvalid',
      'cost-v1': 'purchasing.line.costInvalid',
    });
    expect(checkReceiptLines([receipt({ pending: 2, quantity: '3' })])).toEqual({
      'qty-v1': 'purchasing.line.tooMany',
    });
    expect(checkReceiptLines([receipt({ quantity: '0', free: '0' })])).toEqual({
      'qty-v1': 'purchasing.line.nothing',
    });
    expect(checkReceiptLines([receipt({ pending: 5, quantity: '0', free: '2' })])).toEqual({});
  });

  it('reads days of credit and lead times', () => {
    expect(parseDays('')).toBeNull();
    expect(parseDays(' 30 ')).toBe(30);
    expect(parseDays('366')).toBeUndefined();
    expect(parseDays('1.5')).toBeUndefined();
  });
});
