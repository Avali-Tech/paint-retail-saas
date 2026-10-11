import { describe, expect, it } from 'vitest';
import {
  addressLines,
  formatAmount,
  formatFormula,
  formatPrintDate,
  formatQuantity,
  formatRate,
  formatShade,
  formatTint,
  stateLabel,
} from './format.js';

describe('print formats', () => {
  it('writes amounts in rupees with Indian grouping and no sign', () => {
    expect(formatAmount(1_23_456_78)).toBe('1,23,456.78');
    expect(formatAmount(0)).toBe('0.00');
    expect(formatAmount(-40)).toBe('-0.40');
  });

  it('writes quantities with up to three decimals', () => {
    expect(formatQuantity(2000)).toBe('2');
    expect(formatQuantity(2500)).toBe('2.5');
    expect(formatQuantity(125)).toBe('0.125');
    expect(formatQuantity(1_00_000_000)).toBe('1,00,000');
  });

  it('writes the rate, or the nature of an untaxed line', () => {
    expect(formatRate('taxable', 1800)).toBe('18%');
    expect(formatRate('taxable', 250)).toBe('2.5%');
    expect(formatRate('exempt', 0)).toBe('Exempt');
    expect(formatRate('nil_rated', 0)).toBe('Nil rated');
    expect(formatRate('non_gst', 0)).toBe('Non-GST');
  });

  it('writes dates unambiguously and refuses anything but YYYY-MM-DD', () => {
    expect(formatPrintDate('2026-10-07')).toBe('07 Oct 2026');
    expect(formatPrintDate('2027-01-31')).toBe('31 Jan 2027');
    expect(() => formatPrintDate('2026-13-01')).toThrow('Invalid date "2026-13-01"');
    expect(() => formatPrintDate('07/10/2026')).toThrow(RangeError);
  });

  it('names the state with its code', () => {
    expect(stateLabel('36')).toBe('Telangana (36)');
    expect(stateLabel('04')).toBe('Chandigarh (04)');
  });

  it('lists the street lines, then city and PIN code, leaving out blanks', () => {
    expect(
      addressLines({
        lines: ['8-3-214', ' '],
        city: 'Hyderabad',
        pincode: '500016',
        stateCode: '36',
      }),
    ).toEqual(['8-3-214', 'Hyderabad 500016']);
    expect(addressLines({ lines: [], city: null, pincode: '500016', stateCode: '36' })).toEqual([
      '500016',
    ]);
    expect(
      addressLines({ lines: ['Ameerpet'], city: null, pincode: null, stateCode: '36' }),
    ).toEqual(['Ameerpet']);
  });
});

describe('tint formats', () => {
  it('writes a shade with its name, or the code alone', () => {
    expect(formatShade('X 132', 'Ivory')).toBe('X 132 · Ivory');
    expect(formatShade('X 132', null)).toBe('X 132');
  });

  it('writes a formula colorant by colorant, in its own units or the caller’s', () => {
    const formula = [
      { colorant: 'XY', amount: 12.5, unit: 'ml' },
      { colorant: 'R', amount: 3, unit: 'shot' },
      { colorant: 'B', amount: 2, unit: 'y' },
      { colorant: 'W', amount: 1, unit: 'g' },
    ] as const;
    expect(formatFormula(formula)).toBe('XY 12.5 ml, R 3 shot, B 2 Y, W 1 g');
    expect(formatFormula(formula.slice(0, 1), (unit) => unit.toUpperCase())).toBe('XY 12.5 ML');
    expect(formatFormula([])).toBeNull();
  });

  it('prints a tint as shade, base and formula', () => {
    expect(formatTint({ shadeCode: 'X 1', shadeName: null, base: null, formula: [] })).toEqual({
      shade: 'X 1',
      base: null,
      formula: null,
    });
  });
});
