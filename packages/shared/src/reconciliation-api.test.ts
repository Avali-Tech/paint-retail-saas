import { describe, expect, it } from 'vitest';
import { RECONCILIATION_KINDS, isStockFinding } from './index.js';

describe('isStockFinding', () => {
  it('tells stock quantities from paise', () => {
    expect(RECONCILIATION_KINDS.filter(isStockFinding)).toEqual([
      'stock_on_hand',
      'stock_reserved',
    ]);
  });
});
