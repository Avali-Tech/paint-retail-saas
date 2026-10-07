import { gstinCheckCharacter } from '../../tax-ids.js';
import type {
  TallyParty,
  TallyPeriod,
  TallyReceipt,
  TallySalesDocument,
  TallyTaxLine,
} from '../types.js';
import { DEFAULT_TALLY_VOUCHER_TYPES, type TallyExportOptions } from '../vouchers.js';

/** Small hand-made documents for unit tests; every amount is easy to check by eye. */

export const gstin = (first14: string) => `${first14}${gstinCheckCharacter(first14)}`;

export const SUPPLIER_GSTIN = gstin('36AAKFS4821M1Z');

export const WALK_IN: TallyParty = {
  id: 'walkin',
  name: 'Cash customer',
  gstin: null,
  stateCode: null,
  walkIn: true,
};

export const BUYER: TallyParty = {
  id: 'b1',
  name: 'Sri Sai Constructions',
  gstin: gstin('36AAMFS7310K1Z'),
  stateCode: '36',
  walkIn: false,
};

/** ₹1,000 at 18% within Telangana: ₹90 CGST + ₹90 SGST. */
export const LINE: TallyTaxLine = {
  hsnCode: '32091090',
  nature: 'taxable',
  rateBasisPoints: 1800,
  cessBasisPoints: 0,
  taxablePaise: 100000,
  cgstPaise: 9000,
  sgstPaise: 9000,
  igstPaise: 0,
  cessPaise: 0,
};

export function invoice(overrides: Partial<TallySalesDocument> = {}): TallySalesDocument {
  return {
    id: 'd1',
    kind: 'tax_invoice',
    number: 'AMP/26-27/000001',
    issuedOn: '2026-09-10',
    cancelled: false,
    storeCode: 'AMP',
    supplierGstin: SUPPLIER_GSTIN,
    supplierStateCode: '36',
    party: BUYER,
    placeOfSupplyCode: '36',
    supplyType: 'intra_state',
    lines: [LINE],
    roundOffPaise: 0,
    totalPaise: 118000,
    originals: [],
    allocations: [],
    note: null,
    ...overrides,
  };
}

export function receipt(overrides: Partial<TallyReceipt> = {}): TallyReceipt {
  return {
    id: 'r1',
    number: 'RC-000001',
    receivedOn: '2026-09-12',
    storeCode: 'AMP',
    party: BUYER,
    mode: { kind: 'cash', name: 'Cash' },
    amountPaise: 118000,
    reference: null,
    advance: false,
    allocations: [],
    note: null,
    ...overrides,
  };
}

export function period(overrides: Partial<TallyPeriod> = {}): TallyPeriod {
  return {
    companyName: 'Sharma Paints & Hardware',
    from: '2026-09-01',
    to: '2026-09-30',
    documents: [invoice()],
    receipts: [],
    ...overrides,
  };
}

export const OPTIONS: TallyExportOptions = {
  ledgerRules: [],
  voucherTypes: DEFAULT_TALLY_VOUCHER_TYPES,
};
