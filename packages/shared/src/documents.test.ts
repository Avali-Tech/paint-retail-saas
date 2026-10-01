import { describe, expect, it } from 'vitest';
import { formatDocumentNumber } from './index.js';

describe('formatDocumentNumber', () => {
  it('pads the number after the prefix', () => {
    expect(formatDocumentNumber('TR', 42)).toBe('TR-000042');
    expect(formatDocumentNumber('INV', 7, 4)).toBe('INV-0007');
  });

  it('keeps numbers longer than the padding', () => {
    expect(formatDocumentNumber('TR', 1_234_567)).toBe('TR-1234567');
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects %s', (value) => {
    expect(() => formatDocumentNumber('TR', value)).toThrow(RangeError);
  });
});
