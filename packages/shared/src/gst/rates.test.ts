import { describe, expect, it } from 'vitest';
import { rateOn, type GstRate } from '../index.js';
import { SCENARIO_RATES } from './scenarios.js';

const paint = (overrides: Partial<GstRate>): GstRate => ({
  categoryCode: 'paint',
  nature: 'taxable',
  rateBasisPoints: 1800,
  cessBasisPoints: 0,
  effectiveFrom: '2018-07-27',
  effectiveTo: null,
  ...overrides,
});

describe('rateOn', () => {
  it('picks the row in force, both ends inclusive', () => {
    const on = (date: string) => rateOn(SCENARIO_RATES, 'paint', date).rateBasisPoints;
    expect(on('2017-07-01')).toBe(2800);
    expect(on('2018-07-26')).toBe(2800);
    expect(on('2018-07-27')).toBe(1800);
    expect(on('2099-12-31')).toBe(1800);
    expect(rateOn(SCENARIO_RATES, 'cess-demo', '2025-01-01')).toEqual({
      nature: 'taxable',
      rateBasisPoints: 1800,
      cessBasisPoints: 100,
    });
  });

  it('refuses a date before the first row, or an unknown category', () => {
    expect(() => rateOn(SCENARIO_RATES, 'paint', '2017-06-30')).toThrow(
      'No GST rate for paint on 2017-06-30',
    );
    expect(() => rateOn(SCENARIO_RATES, 'glue', '2025-01-01')).toThrow(
      expect.objectContaining({ code: 'no_rate' }),
    );
  });

  it('refuses overlapping rows rather than guessing', () => {
    const rates = [paint({}), paint({ rateBasisPoints: 500, effectiveFrom: '2025-01-01' })];
    expect(() => rateOn(rates, 'paint', '2025-06-01')).toThrow(
      '2 GST rates for paint on 2025-06-01',
    );
    expect(rateOn(rates, 'paint', '2024-12-31').rateBasisPoints).toBe(1800);
  });

  it('refuses malformed dates', () => {
    expect(() => rateOn([paint({})], 'paint', '2025-1-01')).toThrow(
      'Invoice date must be YYYY-MM-DD, got "2025-1-01"',
    );
    expect(() => rateOn([paint({ effectiveFrom: '2018-13-01' })], 'paint', '2019-01-01')).toThrow(
      expect.objectContaining({ code: 'invalid_date' }),
    );
    expect(() => rateOn([paint({ effectiveTo: '2030-02-32' })], 'paint', '2019-01-01')).toThrow(
      'effectiveTo must be YYYY-MM-DD',
    );
  });

  it('refuses a row that ends before it starts, even when another row matches', () => {
    const rates = [paint({}), paint({ effectiveFrom: '2017-07-01', effectiveTo: '2017-06-30' })];
    expect(() => rateOn(rates, 'paint', '2025-01-01')).toThrow(
      'Rate for paint ends before it starts',
    );
  });

  it('ignores other categories when validating', () => {
    const rates = [paint({}), paint({ categoryCode: 'glue', rateBasisPoints: -5 })];
    expect(rateOn(rates, 'paint', '2025-01-01').rateBasisPoints).toBe(1800);
  });

  it('refuses invalid rates', () => {
    for (const bad of [
      paint({ rateBasisPoints: -1 }),
      paint({ rateBasisPoints: 10_001 }),
      paint({ rateBasisPoints: 18.5 }),
      paint({ cessBasisPoints: -100 }),
    ]) {
      expect(() => rateOn([bad], 'paint', '2025-01-01')).toThrow('Invalid rate for paint');
    }
    expect(
      rateOn([paint({ rateBasisPoints: 10_000 })], 'paint', '2025-01-01').rateBasisPoints,
    ).toBe(10_000);
  });

  it('refuses a rate on a nil-rated, exempt or non-GST category', () => {
    expect(() =>
      rateOn([paint({ nature: 'exempt', rateBasisPoints: 500 })], 'paint', '2025-01-01'),
    ).toThrow('A exempt category cannot carry a rate');
    expect(() =>
      rateOn(
        [paint({ nature: 'non_gst', rateBasisPoints: 0, cessBasisPoints: 1 })],
        'paint',
        '2025-01-01',
      ),
    ).toThrow(expect.objectContaining({ code: 'invalid_rate' }));
    expect(
      rateOn([paint({ nature: 'nil_rated', rateBasisPoints: 0 })], 'paint', '2025-01-01'),
    ).toEqual({
      nature: 'nil_rated',
      rateBasisPoints: 0,
      cessBasisPoints: 0,
    });
  });
});
