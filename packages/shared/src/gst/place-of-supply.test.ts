import { describe, expect, it } from 'vitest';
import { placeOfSupply, supplyTypeFor, type Parties } from '../index.js';
import { SCENARIO_GSTINS } from './scenarios.js';

const counter: Parties = {
  supplierStateCode: '36',
  buyerGstin: null,
  deliveryStateCode: null,
  storeStateCode: '36',
};

describe('placeOfSupply', () => {
  it('B2B: the buyer GSTIN state decides, whatever the delivery state', () => {
    expect(placeOfSupply({ ...counter, buyerGstin: SCENARIO_GSTINS.maharashtraBuyer })).toEqual({
      buyerType: 'b2b',
      placeOfSupply: '27',
      supplyType: 'inter_state',
    });
    expect(
      placeOfSupply({
        ...counter,
        buyerGstin: SCENARIO_GSTINS.telanganaBuyer,
        deliveryStateCode: '27',
      }),
    ).toEqual({ buyerType: 'b2b', placeOfSupply: '36', supplyType: 'intra_state' });
  });

  it('B2C: the delivery state, else the store state', () => {
    expect(placeOfSupply(counter)).toEqual({
      buyerType: 'b2c',
      placeOfSupply: '36',
      supplyType: 'intra_state',
    });
    expect(placeOfSupply({ ...counter, deliveryStateCode: '29' })).toEqual({
      buyerType: 'b2c',
      placeOfSupply: '29',
      supplyType: 'inter_state',
    });
  });

  it('refuses an invalid buyer GSTIN or unknown state codes', () => {
    expect(() => placeOfSupply({ ...counter, buyerGstin: '36AAACT9876Q1Z8' })).toThrow(
      expect.objectContaining({ code: 'invalid_gstin' }),
    );
    expect(() => placeOfSupply({ ...counter, deliveryStateCode: '40' })).toThrow(
      'Unknown GST state code "40"',
    );
    expect(() => placeOfSupply({ ...counter, supplierStateCode: '3' })).toThrow(
      expect.objectContaining({ code: 'invalid_state_code' }),
    );
  });
});

describe('supplyTypeFor', () => {
  it('is intra-state only within one state', () => {
    expect(supplyTypeFor('36', '36')).toBe('intra_state');
    expect(supplyTypeFor('36', '37')).toBe('inter_state');
  });
});
