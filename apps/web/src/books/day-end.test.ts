import { describe, expect, it } from 'vitest';
import { VARIANCE_TONE, readCounts, varianceKind } from './day-end.js';

describe('readCounts', () => {
  it('keeps the notes and coins counted, and names the ones that are not whole numbers', () => {
    expect(
      readCounts({
        '50000': ' 6 ',
        '20000': '',
        '100': '10',
        '500': '0',
        '200': '2.5',
        '1000': 'x',
      }),
    ).toEqual({ counts: { '50000': 6, '100': 10 }, invalid: ['1000', '200'] });
    expect(readCounts({ '50000': '100001' }).invalid).toEqual(['50000']);
    expect(readCounts({})).toEqual({ counts: {}, invalid: [] });
  });
});

describe('varianceKind', () => {
  it('reads a shortfall, an excess or a balanced drawer', () => {
    expect(varianceKind(-2_000)).toBe('short');
    expect(varianceKind(500)).toBe('over');
    expect(varianceKind(0)).toBe('balanced');
    expect(VARIANCE_TONE.short).toBe('danger');
  });
});
