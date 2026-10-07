import { describe, expect, it } from 'vitest';
import {
  CURRENT_GST_STATES,
  gstStateName,
  isCurrentGstStateCode,
  taxRateOn,
  type TaxRateView,
} from './gst-master.js';

describe('GST states in use', () => {
  it('knows Telangana and Andhra Pradesh by code', () => {
    expect(gstStateName('36')).toBe('Telangana');
    expect(gstStateName('37')).toBe('Andhra Pradesh');
    expect(isCurrentGstStateCode('36')).toBe(true);
  });

  it('names legacy codes, but takes them for no new registration', () => {
    expect(gstStateName('28')).toBe('Andhra Pradesh (before division)');
    expect(isCurrentGstStateCode('28')).toBe(false);
    expect(isCurrentGstStateCode('25')).toBe(false);
    expect(CURRENT_GST_STATES.map((state) => state.code)).not.toContain('25');
  });

  it.each(['00', '99', '3', 'AB'])('refuses %s', (code) => {
    expect(isCurrentGstStateCode(code)).toBe(false);
    expect(gstStateName(code)).toBeUndefined();
  });
});

describe('taxRateOn', () => {
  const rates: TaxRateView[] = [
    { id: 'a', rateBps: 2800, effectiveFrom: '2017-07-01', effectiveTo: '2018-07-26' },
    { id: 'b', rateBps: 1800, effectiveFrom: '2018-07-27', effectiveTo: null },
  ];

  it.each([
    ['2017-07-01', 2800],
    ['2018-07-26', 2800],
    ['2018-07-27', 1800],
    ['2030-01-01', 1800],
    ['2017-06-30', null],
  ])('on %s is %s', (date, expected) => {
    expect(taxRateOn(rates, date)).toBe(expected);
  });
});
