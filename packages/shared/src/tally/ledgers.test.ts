import { describe, expect, it } from 'vitest';
import {
  compositionSalesNeed,
  partyNeed,
  paymentModeNeed,
  percentLabel,
  resolveLedger,
  roundOffNeed,
  salesNeed,
  taxNeed,
  type TallyLedgerRule,
} from './ledgers.js';
import { BUYER, WALK_IN } from './test-support/builders.js';

describe('percentLabel', () => {
  it.each([
    [1800, '18'],
    [900, '9'],
    [250, '2.5'],
    [25, '0.25'],
    [12.5, '0.125'],
    [0, '0'],
  ])('%i basis points reads %s', (bps, label) => {
    expect(percentLabel(bps)).toBe(label);
  });
});

describe('default ledger names (spec §6.1)', () => {
  const name = (need: Parameters<typeof resolveLedger>[0]) => resolveLedger(need, []).name;

  it('names sales ledgers by nature, rate and supply type', () => {
    expect(name(salesNeed('taxable', 1800, 'intra_state', 'AMP'))).toBe('Sales GST 18% Local');
    expect(name(salesNeed('taxable', 1800, 'inter_state', 'AMP'))).toBe('Sales GST 18% Interstate');
    expect(name(salesNeed('exempt', 0, 'intra_state', 'AMP'))).toBe('Sales Exempt Local');
    expect(name(salesNeed('nil_rated', 0, 'inter_state', 'AMP'))).toBe(
      'Sales Nil Rated Interstate',
    );
    expect(name(salesNeed('non_gst', 0, 'intra_state', 'AMP'))).toBe('Sales Non-GST Local');
    expect(name(compositionSalesNeed('AMP'))).toBe('Sales - Composition');
  });

  it('names output tax ledgers by head and the head’s own rate', () => {
    expect(name(taxNeed('CGST', 900, 'AMP'))).toBe('Output CGST 9%');
    expect(name(taxNeed('UTGST', 250, 'AMP'))).toBe('Output UTGST 2.5%');
    expect(name(taxNeed('IGST', 1800, 'AMP'))).toBe('Output IGST 18%');
    expect(name(taxNeed('Cess', 100, 'AMP'))).toBe('Output Cess 1%');
    expect(taxNeed('UTGST', 900, 'AMP').purpose).toBe('output_sgst');
    expect(taxNeed('SGST', 900, 'AMP').master.duty).toEqual({ head: 'SGST', rateBasisPoints: 900 });
  });

  it('names parties after themselves, the walk-in party "Cash Sales"', () => {
    expect(name(partyNeed({ ...BUYER, name: ' Sri Sai ' }, 'AMP'))).toBe('Sri Sai');
    expect(partyNeed(BUYER, 'AMP').master).toMatchObject({
      group: 'Sundry Debtors',
      billWise: true,
      gstin: BUYER.gstin,
      stateCode: '36',
    });
    expect(name(partyNeed(WALK_IN, 'AMP'))).toBe('Cash Sales');
    expect(partyNeed(WALK_IN, 'AMP').master.billWise).toBe(false);
    expect(name(roundOffNeed('AMP'))).toBe('Round Off');
  });

  it('has defaults for cash, UPI, card and cheque but not for a bank or "other"', () => {
    const mode = (kind: Parameters<typeof paymentModeNeed>[0]['kind']) =>
      resolveLedger(paymentModeNeed({ kind, name: kind }, 'AMP'), []);
    expect(mode('cash')).toEqual({ name: 'Cash', group: 'Cash-in-Hand' });
    expect(mode('upi')).toEqual({ name: 'UPI Clearing', group: 'Current Assets' });
    expect(mode('card')).toEqual({ name: 'Card Clearing', group: 'Current Assets' });
    expect(mode('cheque')).toEqual({ name: 'Cheques in Hand', group: 'Current Assets' });
    expect(mode('bank_transfer')).toEqual({ name: null, group: 'Bank Accounts' });
    expect(mode('other')).toEqual({ name: null, group: 'Current Assets' });
  });
});

describe('resolveLedger with overrides', () => {
  const need = salesNeed('taxable', 1800, 'intra_state', 'KKP');

  it('ignores rules of another purpose or with a key that does not match', () => {
    const rules: TallyLedgerRule[] = [
      { purpose: 'round_off', ledgerName: 'Rounding' },
      { purpose: 'sales', rateBasisPoints: 500, ledgerName: 'Sales 5%' },
      { purpose: 'sales', storeCode: 'AMP', ledgerName: 'Sales Ameerpet' },
    ];
    expect(resolveLedger(need, rules).name).toBe('Sales GST 18% Local');
  });

  it('takes the most specific matching rule, the earlier one on a tie', () => {
    const rules: TallyLedgerRule[] = [
      { purpose: 'sales', ledgerName: 'Sales' },
      { purpose: 'sales', rateBasisPoints: 1800, ledgerName: 'Sales 18%' },
      { purpose: 'sales', storeCode: 'KKP', ledgerName: 'Sales Kukatpally' },
      { purpose: 'sales', rateBasisPoints: 1800, storeCode: 'KKP', ledgerName: 'Sales 18% KKP' },
      { purpose: 'sales', supplyType: 'intra_state', storeCode: 'KKP', ledgerName: 'Later tie' },
    ];
    expect(resolveLedger(need, rules)).toEqual({ name: 'Sales 18% KKP', group: 'Sales Accounts' });
    expect(resolveLedger(need, rules.slice(0, 3)).name).toBe('Sales 18%');
  });

  it('maps a payment mode by name or kind, optionally into another group', () => {
    const upi = paymentModeNeed({ kind: 'upi', name: 'PhonePe' }, 'AMP');
    const rules: TallyLedgerRule[] = [
      { purpose: 'payment_mode', modeKind: 'upi', ledgerName: 'HDFC Bank', group: 'Bank Accounts' },
      { purpose: 'payment_mode', modeName: 'Bajaj Finance', ledgerName: 'Bajaj Finance Ltd' },
    ];
    expect(resolveLedger(upi, rules)).toEqual({ name: 'HDFC Bank', group: 'Bank Accounts' });
    const finance = paymentModeNeed({ kind: 'other', name: 'Bajaj Finance' }, 'AMP');
    expect(resolveLedger(finance, rules)).toEqual({
      name: 'Bajaj Finance Ltd',
      group: 'Current Assets',
    });
  });

  it('overrides one party by id', () => {
    const rules: TallyLedgerRule[] = [
      { purpose: 'party', partyId: BUYER.id, ledgerName: 'Sri Sai Constructions (Kukatpally)' },
    ];
    expect(resolveLedger(partyNeed(BUYER, 'AMP'), rules).name).toBe(
      'Sri Sai Constructions (Kukatpally)',
    );
    expect(resolveLedger(partyNeed({ ...BUYER, id: 'other' }, 'AMP'), rules).name).toBe(
      'Sri Sai Constructions',
    );
  });
});
