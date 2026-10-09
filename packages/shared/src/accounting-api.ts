import type { PaymentModeKind } from './billing-api.js';
import type { SupplyType, TaxNature } from './gst/types.js';
import type { TallyProblem } from './tally/errors.js';
import type { TallyGroup, TallyLedgerPurpose } from './tally/ledgers.js';
import type { TallyExport } from './tally/vouchers.js';
import { tallyWorkbook } from './tally/workbook.js';
import { tallyLedgersXml, tallyVouchersXml } from './tally/xml.js';
import { zip } from './tally/zip.js';

/**
 * The books (MVP 2, Sell & Bill, round 4c; spec §6.1): ledger-mapping settings
 * and the accounting export, as the API takes and returns them. Amounts are
 * integer paise and dates India-time `YYYY-MM-DD`, as everywhere.
 */

// Ledger mappings -------------------------------------------------------------

/** What a mapping names a ledger for (`ledger_mappings.purpose`), in the order a screen lists them. */
export const TALLY_LEDGER_PURPOSES = [
  'sales',
  'composition_sales',
  'output_cgst',
  'output_sgst',
  'output_igst',
  'output_cess',
  'round_off',
  'party',
  'walk_in',
  'payment_mode',
  'bounce_charges',
] as const satisfies readonly TallyLedgerPurpose[];

/** Tally's predefined groups a ledger may be created under. */
export const TALLY_GROUPS = [
  'Sales Accounts',
  'Duties & Taxes',
  'Indirect Expenses',
  'Sundry Debtors',
  'Cash-in-Hand',
  'Bank Accounts',
  'Current Assets',
] as const satisfies readonly TallyGroup[];

export const TAX_NATURES = [
  'taxable',
  'nil_rated',
  'exempt',
  'non_gst',
] as const satisfies readonly TaxNature[];
export const SUPPLY_TYPES = ['intra_state', 'inter_state'] as const satisfies readonly SupplyType[];

/** A fact a mapping can match on; unset means "any". */
export type LedgerMatchField =
  'rateBasisPoints' | 'nature' | 'supplyType' | 'storeId' | 'modeKind' | 'modeId' | 'partyId';

/**
 * The facts each purpose's amounts carry (the Tally mapper's needs), so a rule
 * can only set keys that can ever match. Every purpose can be per store.
 */
export const LEDGER_MATCH_FIELDS: Readonly<
  Record<TallyLedgerPurpose, readonly LedgerMatchField[]>
> = {
  sales: ['rateBasisPoints', 'nature', 'supplyType', 'storeId'],
  composition_sales: ['storeId'],
  output_cgst: ['rateBasisPoints', 'storeId'],
  output_sgst: ['rateBasisPoints', 'storeId'],
  output_igst: ['rateBasisPoints', 'storeId'],
  output_cess: ['rateBasisPoints', 'storeId'],
  round_off: ['storeId'],
  party: ['partyId', 'storeId'],
  walk_in: ['storeId'],
  payment_mode: ['modeKind', 'modeId', 'storeId'],
  bounce_charges: ['storeId'],
};

/** POST /ledger-mappings and PUT /ledger-mappings/:id: one override of a default ledger name. */
export interface LedgerMappingRequest {
  readonly purpose: TallyLedgerPurpose;
  /** Sales: the full GST rate; tax heads: the head's own rate (CGST 9% is 900). */
  readonly rateBasisPoints?: number;
  readonly nature?: TaxNature;
  readonly supplyType?: SupplyType;
  readonly storeId?: string;
  readonly modeKind?: PaymentModeKind;
  readonly modeId?: string;
  readonly partyId?: string;
  /** The ledger's name in TallyPrime, exactly as it is there. */
  readonly ledgerName: string;
  /** The group to create it under, when not the purpose's usual one. */
  readonly group?: TallyGroup;
  /** Lower first: wins a tie between equally specific rules. */
  readonly position?: number;
}

export interface LedgerMappingView {
  readonly id: string;
  readonly purpose: TallyLedgerPurpose;
  readonly rateBasisPoints: number | null;
  readonly nature: TaxNature | null;
  readonly supplyType: SupplyType | null;
  readonly storeId: string | null;
  readonly modeKind: PaymentModeKind | null;
  readonly modeId: string | null;
  readonly partyId: string | null;
  /** The party's name, for a party override. */
  readonly partyName: string | null;
  readonly ledgerName: string;
  readonly group: TallyGroup | null;
  readonly position: number;
  readonly updatedAt: string;
}

// Accounting export -----------------------------------------------------------

export const ACCOUNTING_EXPORT_FORMATS = ['tally_xml', 'xlsx'] as const;
export type AccountingExportFormat = (typeof ACCOUNTING_EXPORT_FORMATS)[number];

/** Voucher kinds an export can hold (`accounting_exports.kinds`). */
export const ACCOUNTING_EXPORT_KINDS = ['sales', 'credit_note', 'debit_note', 'receipt'] as const;
export type AccountingExportKind = (typeof ACCOUNTING_EXPORT_KINDS)[number];

/** GET /accounting-exports/preview: the period and what to include. */
export interface AccountingExportQuery {
  readonly from: string;
  readonly to: string;
  readonly kinds: readonly AccountingExportKind[];
}

/** POST /accounting-exports: answers the file itself (Tally XML in a .zip, or .xlsx). */
export interface AccountingExportRequest extends AccountingExportQuery {
  readonly format: AccountingExportFormat;
  /** The company's name in TallyPrime; the business's legal name when left out. */
  readonly companyName?: string;
}

/** What an export of the period would hold, and what stops it. */
export interface AccountingExportPreview {
  readonly from: string;
  readonly to: string;
  /** The name the import is addressed to unless another is given. */
  readonly companyName: string;
  /** Vouchers by kind (cancelled invoices count: they keep their number). */
  readonly counts: Readonly<Record<AccountingExportKind, number>>;
  /** Every problem at once: unmapped ledgers, clashing names, bad data. Empty when it can export. */
  readonly problems: readonly TallyProblem[];
  /** Money out the export leaves for the accountant to enter: refunds and bounced cheques. */
  readonly manual: { readonly refunds: number; readonly bouncedCheques: number };
}

/** One past export, newest first in GET /accounting-exports. */
export interface AccountingExportView {
  readonly id: string;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly kinds: readonly AccountingExportKind[];
  readonly format: AccountingExportFormat;
  /** The stored file (GET /documents/:id/download); null when file storage was unavailable. */
  readonly documentId: string | null;
  readonly voucherCount: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface AccountingExportPage {
  readonly items: AccountingExportView[];
  readonly total: number;
}

/** An export's file: what is downloaded and filed. */
export interface AccountingExportFile {
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

const encoder = new TextEncoder();

/**
 * The file for an export. Tally XML is a .zip of two import files: the ledger
 * masters (import first: Import → Masters) and the vouchers (Import →
 * Transactions). The .xlsx is for accountants who key vouchers in by hand.
 */
export function accountingExportFile(
  data: TallyExport,
  format: AccountingExportFormat,
): AccountingExportFile {
  const name = `tally-${data.from}-to-${data.to}`;
  if (format === 'xlsx') {
    return {
      fileName: `${name}.xlsx`,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      bytes: tallyWorkbook(data),
    };
  }
  return {
    fileName: `${name}.zip`,
    contentType: 'application/zip',
    bytes: zip([
      { path: '1-masters.xml', data: encoder.encode(tallyLedgersXml(data, [])) },
      { path: '2-vouchers.xml', data: encoder.encode(tallyVouchersXml(data)) },
    ]),
  };
}
