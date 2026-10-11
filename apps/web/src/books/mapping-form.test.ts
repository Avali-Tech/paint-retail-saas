import { describe, expect, it } from 'vitest';
import { EMPTY_MAPPING, formOf, mappingRequest, percentToBps } from './mapping-form.js';
import { BANK_MAPPING, PARTY_MAPPING, SALES_MAPPING } from './test-support/books-fixtures.js';

describe('percentToBps', () => {
  it('reads a percentage in hundredths', () => {
    expect(percentToBps('18')).toBe(1800);
    expect(percentToBps(' 2.5 ')).toBe(250);
    expect(percentToBps('0')).toBe(0);
    expect(percentToBps('0.125')).toBeNull();
    expect(percentToBps('101')).toBeNull();
    expect(percentToBps('-1')).toBeNull();
    expect(percentToBps('ten')).toBeNull();
  });
});

describe('formOf', () => {
  it('puts a saved mapping back in the form', () => {
    expect(formOf(SALES_MAPPING)).toMatchObject({
      purpose: 'sales',
      rate: '18',
      nature: 'taxable',
      supplyType: 'intra_state',
      storeId: SALES_MAPPING.storeId,
      party: null,
      group: '',
    });
    expect(formOf(BANK_MAPPING)).toMatchObject({
      rate: '',
      modeKind: 'bank_transfer',
      modeId: 'mode-bank',
      group: 'Bank Accounts',
    });
    expect(formOf(PARTY_MAPPING).party).toEqual({ id: 'party-1', name: 'Deccan Contractors' });
    expect(formOf({ ...PARTY_MAPPING, partyName: null }).party).toEqual({
      id: 'party-1',
      name: 'party-1',
    });
  });
});

describe('mappingRequest', () => {
  it('sends only the keys the purpose can match on', () => {
    expect(
      mappingRequest({
        ...EMPTY_MAPPING,
        purpose: 'payment_mode',
        rate: '18',
        nature: 'taxable',
        modeKind: 'bank_transfer',
        modeId: 'mode-bank',
        storeId: 'store-amp',
        ledgerName: ' HDFC Bank ',
        group: 'Bank Accounts',
        position: '2',
      }),
    ).toEqual({
      request: {
        purpose: 'payment_mode',
        modeKind: 'bank_transfer',
        modeId: 'mode-bank',
        storeId: 'store-amp',
        ledgerName: 'HDFC Bank',
        group: 'Bank Accounts',
        position: 2,
      },
    });
    expect(mappingRequest({ ...EMPTY_MAPPING, rate: '18', ledgerName: 'Sales 18%' })).toEqual({
      request: { purpose: 'sales', rateBasisPoints: 1800, ledgerName: 'Sales 18%', position: 0 },
    });
    expect(
      mappingRequest({
        ...EMPTY_MAPPING,
        purpose: 'party',
        party: { id: 'party-1', name: 'Deccan' },
        ledgerName: 'Deccan',
      }),
    ).toEqual({
      request: { purpose: 'party', partyId: 'party-1', ledgerName: 'Deccan', position: 0 },
    });
  });

  it('says what is wrong', () => {
    expect(
      mappingRequest({ ...EMPTY_MAPPING, purpose: 'party', rate: 'x', position: '1.5' }),
    ).toEqual({ problems: ['party', 'ledgerName', 'position'] });
    expect(
      mappingRequest({ ...EMPTY_MAPPING, rate: '200', ledgerName: 'S', position: 'x' }),
    ).toEqual({
      problems: ['rate', 'position'],
    });
    expect(mappingRequest({ ...EMPTY_MAPPING, ledgerName: 'S', position: '10001' })).toEqual({
      problems: ['position'],
    });
    expect(mappingRequest({ ...EMPTY_MAPPING, ledgerName: 'S', position: '-1' })).toEqual({
      problems: ['position'],
    });
  });
});
