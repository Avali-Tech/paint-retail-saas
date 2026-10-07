import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HSN_DIGIT_BANDS,
  hsnMeetsRequirement,
  requiredHsnDigits,
  type HsnDigitBand,
} from '../index.js';

const FIVE_CRORE = 5_00_00_000_00;

describe('requiredHsnDigits with the default bands', () => {
  it('needs 4 digits on B2B and none on B2C up to ₹5 crore, inclusive', () => {
    expect(requiredHsnDigits(0, 'b2b')).toBe(4);
    expect(requiredHsnDigits(FIVE_CRORE, 'b2b')).toBe(4);
    expect(requiredHsnDigits(FIVE_CRORE, 'b2c')).toBe(0);
  });

  it('needs 6 digits on every invoice above ₹5 crore', () => {
    expect(requiredHsnDigits(FIVE_CRORE + 1, 'b2b')).toBe(6);
    expect(requiredHsnDigits(FIVE_CRORE + 1, 'b2c')).toBe(6);
  });

  it('is the documented default', () => {
    expect(DEFAULT_HSN_DIGIT_BANDS).toEqual([
      { upToTurnoverPaise: FIVE_CRORE, b2bDigits: 4, b2cDigits: 0 },
      { upToTurnoverPaise: null, b2bDigits: 6, b2cDigits: 6 },
    ]);
  });
});

describe('requiredHsnDigits with custom bands', () => {
  // The pre-April-2021 rule: none up to ₹1.5 crore, 2 (shown as 4 here) up to ₹5 crore, then 4.
  const bands: HsnDigitBand[] = [
    { upToTurnoverPaise: 1_50_00_000_00, b2bDigits: 0, b2cDigits: 0 },
    { upToTurnoverPaise: FIVE_CRORE, b2bDigits: 4, b2cDigits: 4 },
    { upToTurnoverPaise: null, b2bDigits: 8, b2cDigits: 8 },
  ];

  it('uses the bands passed in', () => {
    expect(requiredHsnDigits(1_00_00_000_00, 'b2b', bands)).toBe(0);
    expect(requiredHsnDigits(2_00_00_000_00, 'b2c', bands)).toBe(4);
    expect(requiredHsnDigits(FIVE_CRORE * 2, 'b2b', bands)).toBe(8);
  });

  it('refuses bands without an open top band, or a bad turnover', () => {
    expect(() => requiredHsnDigits(FIVE_CRORE * 2, 'b2b', bands.slice(0, 2))).toThrow(
      'HSN digit bands must end with an open top band',
    );
    expect(() => requiredHsnDigits(-1, 'b2b')).toThrow(
      expect.objectContaining({ code: 'invalid_amount' }),
    );
  });
});

describe('hsnMeetsRequirement', () => {
  it('accepts anything valid, or nothing, when optional', () => {
    expect(hsnMeetsRequirement('', 0)).toBe(true);
    expect(hsnMeetsRequirement('3209', 0)).toBe(true);
    expect(hsnMeetsRequirement('320', 0)).toBe(false);
  });

  it('needs a valid code of at least the required digits', () => {
    expect(hsnMeetsRequirement('3209', 4)).toBe(true);
    expect(hsnMeetsRequirement('32091090', 6)).toBe(true);
    expect(hsnMeetsRequirement('3209', 6)).toBe(false);
    expect(hsnMeetsRequirement('', 4)).toBe(false);
    expect(hsnMeetsRequirement('32a9', 4)).toBe(false);
    expect(hsnMeetsRequirement('32091', 4)).toBe(false);
  });
});
