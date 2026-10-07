import { describe, expect, it } from 'vitest';
import {
  addressLines,
  formatAmount,
  formatPrintDate,
  formatQuantity,
  formatRate,
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
