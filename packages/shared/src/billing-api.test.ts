import { describe, expect, it } from 'vitest';
import {
  CASH_DENOMINATIONS_PAISE,
  DEFAULT_PAYMENT_MODES,
  PAYMENT_MODE_KINDS,
  countedCash,
  tallyReceiptOf,
  type PaymentView,
} from './index.js';

describe('payment modes', () => {
  it('starts every business with cash, UPI, card, bank transfer and cheque', () => {
    expect(DEFAULT_PAYMENT_MODES.map((mode) => mode.kind)).toEqual(
      PAYMENT_MODE_KINDS.filter((kind) => kind !== 'other'),
    );
  });
});

describe('countedCash', () => {
  it('adds up notes and coins counted by denomination, in paise', () => {
    expect(countedCash({ '50000': 3, '2000': 2, '100': 7 })).toBe(1_54_700);
    expect(countedCash({})).toBe(0);
  });

  it('knows the notes and coins from ₹500 down to ₹1, largest first', () => {
    expect(CASH_DENOMINATIONS_PAISE[0]).toBe(50_000);
    expect(CASH_DENOMINATIONS_PAISE.at(-1)).toBe(100);
    expect([...CASH_DENOMINATIONS_PAISE].sort((a, b) => b - a)).toEqual([
      ...CASH_DENOMINATIONS_PAISE,
    ]);
  });
});

describe('tallyReceiptOf', () => {
  const allocation = {
    paymentId: 'p1',
    creditNoteId: null,
    partyLedgerId: null,
    refundPaymentId: null,
    reversesAllocationId: null,
    reversed: false,
    createdAt: '2026-10-08T05:00:00.000Z',
  };
  const payment: PaymentView = {
    id: 'p1',
    number: 'RC-000007',
    voucherNumber: null,
    direction: 'in',
    storeId: 's1',
    partyId: 'party1',
    partyName: 'Deccan Contractors',
    mode: { id: 'm1', kind: 'upi', name: 'UPI' },
    amountPaise: 30_000,
    tenderedPaise: null,
    changePaise: null,
    receivedOn: '2026-10-08',
    reference: 'UTR1',
    chequeDate: null,
    chequeStatus: null,
    chequeClearedOn: null,
    chequeBouncedOn: null,
    bounceReason: null,
    registerSessionId: null,
    gatewayReference: null,
    note: null,
    unallocatedPaise: 0,
    allocations: [
      {
        ...allocation,
        id: 'a1',
        documentId: 'd1',
        targetNumber: 'AMP/26-27/000001',
        amountPaise: 10_000,
        reversed: true,
      },
      {
        ...allocation,
        id: 'a2',
        documentId: 'd1',
        targetNumber: 'AMP/26-27/000001',
        amountPaise: -10_000,
        reversesAllocationId: 'a1',
      },
      {
        ...allocation,
        id: 'a3',
        documentId: 'd2',
        targetNumber: 'AMP/26-27/000002',
        amountPaise: 30_000,
      },
    ],
    createdByMemberId: 'member1',
    createdAt: '2026-10-08T05:00:00.000Z',
  };
  const party = {
    id: 'party1',
    name: 'Deccan Contractors',
    gstin: null,
    stateCode: '36',
    walkIn: false,
  };

  it('maps a receipt onto the Tally voucher with the bills it still settles', () => {
    expect(tallyReceiptOf(payment, 'AMP', party)).toEqual({
      id: 'p1',
      number: 'RC-000007',
      receivedOn: '2026-10-08',
      storeCode: 'AMP',
      party,
      mode: { kind: 'upi', name: 'UPI' },
      amountPaise: 30_000,
      reference: 'UTR1',
      advance: false,
      allocations: [{ documentNumber: 'AMP/26-27/000002', amountPaise: 30_000 }],
      note: null,
    });
  });

  it('numbers an advance by its receipt voucher', () => {
    const advance = { ...payment, voucherNumber: 'AMPA/26-27/00001', allocations: [] };
    expect(tallyReceiptOf(advance, 'AMP', party)).toMatchObject({
      number: 'AMPA/26-27/00001',
      advance: true,
      allocations: [],
    });
  });
});
