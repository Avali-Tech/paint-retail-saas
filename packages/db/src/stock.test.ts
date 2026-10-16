import { describe, expect, it } from 'vitest';
import { nextAverageCost } from './stock.js';

describe('nextAverageCost', () => {
  it('takes the receipt’s cost when there was no cost or no stock', () => {
    expect(nextAverageCost(5_000n, null, 2_000n, 700n)).toBe(700n);
    expect(nextAverageCost(0n, 500n, 2_000n, 700n)).toBe(700n);
    expect(nextAverageCost(-1_000n, 500n, 2_000n, 700n)).toBe(700n);
  });

  it('weighs the stock on hand and the receipt, rounding half up', () => {
    // 10 at ₹5 and 10 at ₹7: ₹6.
    expect(nextAverageCost(10_000n, 500n, 10_000n, 700n)).toBe(600n);
    // 2 at 100 and 1 at 101: 100.33 → 100; 1 at 100 and 1 at 101: 100.5 → 101.
    expect(nextAverageCost(2_000n, 100n, 1_000n, 101n)).toBe(100n);
    expect(nextAverageCost(1_000n, 100n, 1_000n, 101n)).toBe(101n);
  });
});
