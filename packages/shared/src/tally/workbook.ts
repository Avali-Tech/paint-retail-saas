import { at } from '../gst/arith.js';
import { gstState } from '../gst/states.js';
import { paiseToRupees } from '../money.js';
import { percentLabel } from './ledgers.js';
import type { TallyExport, TallyVoucher, TallyVoucherKind } from './vouchers.js';
import { writeXlsx, type XlsxCell, type XlsxSheet } from './xlsx.js';

/** What a ledger was debited and credited with over the export, cancelled vouchers aside. */
export interface TallyLedgerTotal {
  readonly ledger: string;
  readonly debitPaise: number;
  readonly creditPaise: number;
}

/** Debit and credit totals per ledger, in the order of the export's ledgers. */
export function tallyLedgerTotals(data: TallyExport): TallyLedgerTotal[] {
  const entries = data.vouchers.flatMap((voucher) => voucher.entries);
  const sum = (ledger: string, side: 'debit' | 'credit') =>
    entries
      .filter((entry) => entry.ledger === ledger && entry.side === side)
      .reduce((total, entry) => total + entry.paise, 0);
  return data.ledgers.map(({ name }) => ({
    ledger: name,
    debitPaise: sum(name, 'debit'),
    creditPaise: sum(name, 'credit'),
  }));
}

const SHEETS: readonly { kind: TallyVoucherKind; name: string }[] = [
  { kind: 'sales', name: 'Sales' },
  { kind: 'credit_note', name: 'Credit Note' },
  { kind: 'debit_note', name: 'Debit Note' },
  { kind: 'receipt', name: 'Receipt' },
  { kind: 'payment', name: 'Payment' },
  { kind: 'journal', name: 'Journal' },
];

const VOUCHER_COLUMNS = [
  { header: 'Date', width: 12 },
  { header: 'Voucher Type', width: 13 },
  { header: 'Voucher No', width: 18 },
  { header: 'Cancelled', width: 10 },
  { header: 'Party Ledger', width: 28 },
  { header: 'Party GSTIN', width: 17 },
  { header: 'Place of Supply', width: 16 },
  { header: 'Against', width: 30 },
  { header: 'Ledger', width: 28 },
  { header: 'HSN', width: 18 },
  { header: 'Rate %', width: 7 },
  { header: 'Debit', width: 13 },
  { header: 'Credit', width: 13 },
  { header: 'Bills', width: 40 },
  { header: 'Narration', width: 60 },
] as const;

const txt = (value: string): XlsxCell => (value === '' ? null : { kind: 'text', value });

function voucherRows(voucher: TallyVoucher): XlsxCell[][] {
  const head: XlsxCell[] = [
    { kind: 'date', iso: voucher.date },
    txt(voucher.voucherType),
    txt(voucher.number),
    txt(voucher.cancelled ? 'Yes' : 'No'),
    txt(voucher.partyLedger),
    txt(voucher.party.gstin ?? ''),
    txt(voucher.gst === null ? '' : gstState(voucher.gst.placeOfSupplyCode).name),
    txt(voucher.originals.map((ref) => `${ref.number} (${ref.issuedOn})`).join(', ')),
  ];
  const tail = [txt(voucher.narration)];
  if (voucher.entries.length === 0) return [[...head, null, null, null, null, null, null, ...tail]];
  return voucher.entries.map((entry) => [
    ...head,
    txt(entry.ledger),
    txt(entry.hsnCodes.join(', ')),
    txt(entry.rateBasisPoints === null ? '' : percentLabel(entry.rateBasisPoints)),
    entry.side === 'debit' ? { kind: 'amount', paise: entry.paise } : null,
    entry.side === 'credit' ? { kind: 'amount', paise: entry.paise } : null,
    txt(
      entry.bills
        .map((bill) => [bill.type, bill.name, paiseToRupees(bill.paise)].filter(Boolean).join(' '))
        .join('; '),
    ),
    ...tail,
  ]);
}

/** The export as sheets: one per voucher type (one row per ledger line), then the ledgers. */
export function tallySheets(data: TallyExport): XlsxSheet[] {
  const totals = tallyLedgerTotals(data);
  const ledgerSheet: XlsxSheet = {
    name: 'Ledgers',
    columns: [
      { header: 'Ledger', width: 28 },
      { header: 'Group', width: 18 },
      { header: 'Bill-wise', width: 9 },
      { header: 'GSTIN', width: 17 },
      { header: 'State', width: 16 },
      { header: 'Tax Head', width: 10 },
      { header: 'Rate %', width: 7 },
      { header: 'Total Debit', width: 14 },
      { header: 'Total Credit', width: 14 },
    ],
    rows: data.ledgers.map((ledger, index) => {
      const total = at(totals, index);
      return [
        txt(ledger.name),
        txt(ledger.group),
        txt(ledger.billWise ? 'Yes' : 'No'),
        txt(ledger.gstin ?? ''),
        txt(ledger.stateCode === null ? '' : gstState(ledger.stateCode).name),
        txt(ledger.duty?.head ?? ''),
        txt(ledger.duty === null ? '' : percentLabel(ledger.duty.rateBasisPoints)),
        { kind: 'amount', paise: total.debitPaise },
        { kind: 'amount', paise: total.creditPaise },
      ];
    }),
  };
  return [
    ...SHEETS.map(({ kind, name }): XlsxSheet => ({
      name,
      columns: VOUCHER_COLUMNS,
      rows: data.vouchers.filter((voucher) => voucher.kind === kind).flatMap(voucherRows),
    })),
    ledgerSheet,
  ];
}

/** The export as an .xlsx workbook, for accountants who key vouchers in by hand. */
export function tallyWorkbook(data: TallyExport): Uint8Array {
  return writeXlsx(tallySheets(data));
}
