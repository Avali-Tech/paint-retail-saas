import { describe, expect, it } from 'vitest';
import { date } from './import-cells.js';

describe('date cells', () => {
  it.each([
    ['2026-04-01', '2026-04-01'],
    ['01-04-2026', '2026-04-01'],
    ['1/4/2026', '2026-04-01'],
    ['29-02-2028', '2028-02-29'],
  ])('reads %s as %s', (cell, iso) => {
    expect(date.parse(cell)).toBe(iso);
  });

  it.each(['soon', '2026-13-01', '2026-02-30', '31/04/2026', '04/2026'])('refuses %s', (cell) => {
    expect(date.safeParse(cell).error?.issues[0]?.message).toBe(
      'Enter a date such as 2026-04-01 or 01-04-2026',
    );
  });
});
