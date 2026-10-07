import { describe, expect, it } from 'vitest';
import {
  GST_STATES,
  gstState,
  isGstStateCode,
  stateCodeFromGstin,
  stateTaxLabel,
} from '../index.js';

describe('GST state codes', () => {
  it('lists 01 to 38 and 97 once each', () => {
    const codes = GST_STATES.map(({ code }) => code);
    const expected = [
      ...Array.from({ length: 38 }, (_, index) => String(index + 1).padStart(2, '0')),
      '97',
    ];
    expect(codes).toEqual(expected);
  });

  it('looks up a state, a UT and the legacy codes', () => {
    expect(gstState('36')).toEqual({ code: '36', name: 'Telangana', kind: 'state', legacy: false });
    expect(gstState('07')).toMatchObject({ name: 'Delhi', kind: 'ut_with_legislature' });
    expect(gstState('97')).toMatchObject({ name: 'Other Territory', kind: 'ut' });
    expect(gstState('25')).toMatchObject({ legacy: true });
    expect(gstState('28')).toMatchObject({ legacy: true, kind: 'state' });
    expect(gstState('37')).toMatchObject({ name: 'Andhra Pradesh', legacy: false });
  });

  it('refuses an unknown code', () => {
    expect(() => gstState('39')).toThrow('Unknown GST state code "39"');
    expect(() => gstState('00')).toThrow(expect.objectContaining({ code: 'invalid_state_code' }));
    expect(isGstStateCode('38')).toBe(true);
    expect(isGstStateCode('99')).toBe(false);
  });

  it('labels the state half SGST, or UTGST in a UT without a legislature', () => {
    expect(stateTaxLabel('36')).toBe('SGST');
    expect(stateTaxLabel('07')).toBe('SGST');
    expect(stateTaxLabel('34')).toBe('SGST');
    expect(stateTaxLabel('04')).toBe('UTGST');
    expect(stateTaxLabel('38')).toBe('UTGST');
  });
});

describe('stateCodeFromGstin', () => {
  it('reads the state from a valid GSTIN', () => {
    expect(stateCodeFromGstin('27AAFCR5678K1ZP')).toBe('27');
    expect(stateCodeFromGstin('36AAACT9876Q1Z9')).toBe('36');
  });

  it('refuses an invalid GSTIN or one with an unknown state', () => {
    expect(() => stateCodeFromGstin('27AAFCR5678K1ZQ')).toThrow(
      expect.objectContaining({ code: 'invalid_gstin' }),
    );
    // Check character valid, but 99 is not a state.
    expect(() => stateCodeFromGstin('99AAFCR5678K1ZE')).toThrow('Unknown GST state code "99"');
  });
});
