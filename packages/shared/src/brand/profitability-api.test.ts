import { describe, expect, it } from 'vitest';
import { previousQuarter } from './profitability-api.js';

describe('previousQuarter', () => {
  it('is the quarter before today’s, in India’s financial-year quarters', () => {
    expect(previousQuarter('2026-10-16')).toEqual({ from: '2026-07-01', to: '2026-09-30' });
    expect(previousQuarter('2026-07-01')).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(previousQuarter('2026-06-30')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(previousQuarter('2026-04-15')).toEqual({ from: '2026-01-01', to: '2026-03-31' });
  });

  it('reaches back into last year from January to March', () => {
    expect(previousQuarter('2027-02-28')).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(previousQuarter('2028-03-31')).toEqual({ from: '2027-10-01', to: '2027-12-31' });
  });

  it('refuses a day that is not a date', () => {
    expect(() => previousQuarter('2026-13-01')).toThrow(RangeError);
  });
});
