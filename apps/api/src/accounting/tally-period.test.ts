import type { LedgerMappingView } from '@paint/shared';
import { describe, expect, it } from 'vitest';
import {
  documentParty,
  ledgerRuleOf,
  natureOf,
  receiptsOf,
  salesDocumentsOf,
  taxLinesOf,
  type DocumentRow,
  type LineRow,
  type ReceiptRow,
} from './tally-period.js';

const doc = (overrides: Partial<DocumentRow> = {}): DocumentRow => ({
  id: 'doc-1',
  kind: 'invoice',
  status: 'issued',
  number: 'AMP/26-27/000001',
  issuedOn: '2026-09-10',
  storeCode: 'AMP',
  supplierGstin: '36AABCS1429B1ZB',
  supplierStateCode: '36',
  partyId: 'party-1',
  buyerName: 'Deccan Contractors',
  buyerGstin: null,
  buyerStateCode: '36',
  placeOfSupplyCode: '36',
  supplyType: 'intra_state',
  roundOffPaise: 0,
  totalPaise: 11_800,
  reason: null,
  ...overrides,
});

const line = (overrides: Partial<LineRow> = {}): LineRow => ({
  documentId: 'doc-1',
  hsnCode: '32091090',
  rateBps: 1800,
  cessBps: 0,
  categoryKey: 'paints',
  taxablePaise: 10_000,
  cgstPaise: 900,
  sgstPaise: 900,
  igstPaise: 0,
  cessPaise: 0,
  ...overrides,
});

describe('natureOf', () => {
  it('reads 0% as exempt for the Exempt category and nil-rated otherwise', () => {
    expect(natureOf(1800, 'exempt')).toBe('taxable');
    expect(natureOf(0, 'exempt')).toBe('exempt');
    expect(natureOf(0, 'paints')).toBe('nil_rated');
    expect(natureOf(0, null)).toBe('nil_rated');
  });
});

describe('taxLinesOf', () => {
  it('adds up lines of one HSN, rate and nature, keeping first-seen order', () => {
    expect(
      taxLinesOf([
        line(),
        line({ hsnCode: '96034020', rateBps: 1200, cgstPaise: 600, sgstPaise: 600 }),
        line({ taxablePaise: 5_000, cgstPaise: 450, sgstPaise: 450 }),
        line({ hsnCode: null, rateBps: null, cessBps: null, cgstPaise: 0, sgstPaise: 0 }),
      ]),
    ).toEqual([
      {
        hsnCode: '32091090',
        nature: 'taxable',
        rateBasisPoints: 1800,
        cessBasisPoints: 0,
        taxablePaise: 15_000,
        cgstPaise: 1_350,
        sgstPaise: 1_350,
        igstPaise: 0,
        cessPaise: 0,
      },
      {
        hsnCode: '96034020',
        nature: 'taxable',
        rateBasisPoints: 1200,
        cessBasisPoints: 0,
        taxablePaise: 10_000,
        cgstPaise: 600,
        sgstPaise: 600,
        igstPaise: 0,
        cessPaise: 0,
      },
      {
        hsnCode: '',
        nature: 'nil_rated',
        rateBasisPoints: 0,
        cessBasisPoints: 0,
        taxablePaise: 10_000,
        cgstPaise: 0,
        sgstPaise: 0,
        igstPaise: 0,
        cessPaise: 0,
      },
    ]);
  });
});

describe('documentParty', () => {
  it('posts the walk-in party, and a bill with no party, to Cash Sales', () => {
    expect(documentParty(doc(), 'walk-in')).toEqual({
      id: 'party-1',
      name: 'Deccan Contractors',
      gstin: null,
      stateCode: '36',
      walkIn: false,
    });
    expect(documentParty(doc({ partyId: 'walk-in' }), 'walk-in').walkIn).toBe(true);
    expect(documentParty(doc({ partyId: null, buyerName: null }), null)).toMatchObject({
      id: 'doc-1',
      name: '',
      walkIn: true,
    });
  });
});

describe('salesDocumentsOf', () => {
  it('maps invoices and notes with their lines, originals and credit-note allocations', () => {
    const documents = salesDocumentsOf(
      [
        doc(),
        doc({ id: 'bos', kind: 'bill_of_supply', status: 'cancelled', number: 'B/1' }),
        doc({ id: 'cn', kind: 'credit_note', number: 'CN/1', reason: 'Damaged tin' }),
        doc({ id: 'dn', kind: 'debit_note', number: 'DN/1' }),
      ],
      [line(), line({ documentId: 'cn', taxablePaise: 1_000, cgstPaise: 90, sgstPaise: 90 })],
      [
        { noteId: 'cn', number: 'AMP/26-27/000001', issuedOn: '2026-09-10' },
        { noteId: 'dn', number: 'AMP/26-27/000001', issuedOn: '2026-09-10' },
      ],
      [
        { sourceId: 'cn', documentNumber: 'AMP/26-27/000001', amountPaise: 1_180 },
        // A receipt's allocation never lands on an invoice of the same id.
        { sourceId: 'doc-1', documentNumber: 'X', amountPaise: 1 },
      ],
      null,
    );
    expect(documents.map((d) => [d.kind, d.cancelled, d.lines.length])).toEqual([
      ['tax_invoice', false, 1],
      ['bill_of_supply', true, 0],
      ['credit_note', false, 1],
      ['debit_note', false, 0],
    ]);
    expect(documents[0]).toMatchObject({ originals: [], allocations: [], note: null });
    expect(documents[2]).toMatchObject({
      originals: [{ number: 'AMP/26-27/000001', issuedOn: '2026-09-10' }],
      allocations: [{ documentNumber: 'AMP/26-27/000001', amountPaise: 1_180 }],
      note: 'Damaged tin',
    });
    expect(documents[3]?.allocations).toEqual([]);
  });
});

describe('receiptsOf', () => {
  const receipt = (overrides: Partial<ReceiptRow> = {}): ReceiptRow => ({
    id: 'pay-1',
    number: 'RC-000001',
    voucherNumber: null,
    receivedOn: '2026-09-12',
    storeCode: 'AMP',
    partyId: 'party-1',
    partyName: 'Deccan Contractors',
    partyGstin: null,
    partyStateCode: null,
    modeKind: 'upi',
    modeName: 'UPI',
    amountPaise: 5_000,
    reference: 'UTR1',
    note: null,
    ...overrides,
  });

  it('numbers an advance by its receipt voucher and keeps its allocations', () => {
    const [plain, advance] = receiptsOf(
      [receipt(), receipt({ id: 'pay-2', voucherNumber: 'RV/1', partyId: 'walk-in' })],
      [{ sourceId: 'pay-1', documentNumber: 'AMP/26-27/000001', amountPaise: 5_000 }],
      'walk-in',
    );
    expect(plain).toMatchObject({
      number: 'RC-000001',
      advance: false,
      mode: { kind: 'upi', name: 'UPI' },
      party: { id: 'party-1', walkIn: false },
      allocations: [{ documentNumber: 'AMP/26-27/000001', amountPaise: 5_000 }],
    });
    expect(advance).toMatchObject({
      number: 'RV/1',
      advance: true,
      party: { walkIn: true },
      allocations: [],
    });
  });
});

describe('ledgerRuleOf', () => {
  const mapping = (overrides: Partial<LedgerMappingView> = {}): LedgerMappingView => ({
    id: 'm1',
    purpose: 'sales',
    rateBasisPoints: null,
    nature: null,
    supplyType: null,
    storeId: null,
    modeKind: null,
    modeId: null,
    partyId: null,
    partyName: null,
    ledgerName: 'Sales 18%',
    group: null,
    position: 0,
    updatedAt: '2026-10-08T00:00:00.000Z',
    ...overrides,
  });
  const stores = new Map([['store-1', 'AMP']]);
  const modes = new Map([['mode-1', 'HDFC NEFT']]);

  it('sets only the keys a mapping matches on', () => {
    expect(ledgerRuleOf(mapping(), stores, modes)).toEqual({
      purpose: 'sales',
      ledgerName: 'Sales 18%',
    });
  });

  it('matches stores by code and payment modes by name', () => {
    expect(
      ledgerRuleOf(
        mapping({
          purpose: 'payment_mode',
          modeKind: 'bank_transfer',
          modeId: 'mode-1',
          storeId: 'store-1',
          group: 'Bank Accounts',
          ledgerName: 'HDFC Bank',
        }),
        stores,
        modes,
      ),
    ).toEqual({
      purpose: 'payment_mode',
      ledgerName: 'HDFC Bank',
      group: 'Bank Accounts',
      modeKind: 'bank_transfer',
      storeCode: 'AMP',
      modeName: 'HDFC NEFT',
    });
    expect(
      ledgerRuleOf(
        mapping({ rateBasisPoints: 1800, nature: 'taxable', supplyType: 'inter_state' }),
        stores,
        modes,
      ),
    ).toEqual({
      purpose: 'sales',
      ledgerName: 'Sales 18%',
      rateBasisPoints: 1800,
      nature: 'taxable',
      supplyType: 'inter_state',
    });
    expect(ledgerRuleOf(mapping({ purpose: 'party', partyId: 'p1' }), stores, modes)).toEqual({
      purpose: 'party',
      ledgerName: 'Sales 18%',
      partyId: 'p1',
    });
  });
});
