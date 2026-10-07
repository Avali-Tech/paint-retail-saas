import { paiseToRupees } from '../money.js';
import { gstState } from '../gst/states.js';
import type { TallyDutyHead, TallyLedger } from './ledgers.js';
import type { TallyEntry, TallyExport, TallyVoucher } from './vouchers.js';

/**
 * TallyPrime XML import files (docs/mvp-2/tally.md has the sources).
 *
 * Signs: Tally stores a debit as a negative AMOUNT with ISDEEMEDPOSITIVE Yes,
 * and a credit as a positive AMOUNT with ISDEEMEDPOSITIVE No; bill allocations
 * take their entry's sign. Dates are YYYYMMDD; amounts are rupees with two
 * decimals and no grouping.
 */

// XML 1.0 forbids these control characters even when escaped, so they are dropped.
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

/** Escapes text for an XML element or attribute value. */
export function escapeXml(text: string): string {
  return text
    .replace(INVALID_XML, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** `2026-09-05` → `20260905`. */
export const tallyDate = (iso: string) => iso.replaceAll('-', '');

/** A signed Tally amount: debits negative, credits positive. */
export const tallyAmount = (side: 'debit' | 'credit', paise: number) =>
  paiseToRupees(side === 'debit' ? -paise : paise);

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

const tag = (name: string, value: string) => `<${name}>${escapeXml(value)}</${name}>`;

function indent(lines: readonly string[], depth: number): string[] {
  return lines.map((line) => `${' '.repeat(depth)}${line}`);
}

function envelope(companyName: string, reportName: string, messages: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    ' <HEADER>',
    '  <TALLYREQUEST>Import Data</TALLYREQUEST>',
    ' </HEADER>',
    ' <BODY>',
    '  <IMPORTDATA>',
    '   <REQUESTDESC>',
    `    ${tag('REPORTNAME', reportName)}`,
    '    <STATICVARIABLES>',
    `     ${tag('SVCURRENTCOMPANY', companyName)}`,
    '    </STATICVARIABLES>',
    '   </REQUESTDESC>',
    '   <REQUESTDATA>',
    ...indent(messages, 4),
    '   </REQUESTDATA>',
    '  </IMPORTDATA>',
    ' </BODY>',
    '</ENVELOPE>',
    '',
  ].join('\n');
}

function entryXml(entry: TallyEntry, party: boolean): string[] {
  const deemedPositive = entry.side === 'debit';
  return [
    '<ALLLEDGERENTRIES.LIST>',
    ` ${tag('LEDGERNAME', entry.ledger)}`,
    ` ${tag('ISDEEMEDPOSITIVE', yesNo(deemedPositive))}`,
    ` ${tag('ISPARTYLEDGER', yesNo(party))}`,
    ` ${tag('AMOUNT', tallyAmount(entry.side, entry.paise))}`,
    ...entry.bills.flatMap((bill) => [
      ' <BILLALLOCATIONS.LIST>',
      `  ${tag('NAME', bill.name)}`,
      `  ${tag('BILLTYPE', bill.type)}`,
      `  ${tag('AMOUNT', tallyAmount(entry.side, bill.paise))}`,
      ' </BILLALLOCATIONS.LIST>',
    ]),
    '</ALLLEDGERENTRIES.LIST>',
  ];
}

/** The GST header of a sales-side voucher: who bought, where, and from which GSTIN. */
function gstXml(voucher: TallyVoucher): string[] {
  const { gst, party } = voucher;
  if (gst === null) return [];
  const partyState = party.stateCode ?? gst.placeOfSupplyCode;
  return [
    tag('PARTYNAME', party.name),
    tag('GSTREGISTRATIONTYPE', party.gstin === null ? 'Unregistered/Consumer' : 'Regular'),
    ...(party.gstin === null ? [] : [tag('PARTYGSTIN', party.gstin)]),
    tag('STATENAME', gstState(partyState).name),
    tag('COUNTRYOFRESIDENCE', 'India'),
    tag('PLACEOFSUPPLY', gstState(gst.placeOfSupplyCode).name),
    tag('CMPGSTIN', gst.supplierGstin),
  ];
}

/** Our id as Tally's REMOTEID: importing the same document again overwrites, never duplicates. */
export const remoteId = (documentId: string) => `paint-${documentId}`;

function voucherXml(voucher: TallyVoucher): string[] {
  const original = voucher.originals[0];
  return [
    `<VOUCHER REMOTEID="${escapeXml(remoteId(voucher.documentId))}" VCHTYPE="${escapeXml(voucher.voucherType)}" ACTION="Create" OBJVIEW="Accounting Voucher View">`,
    ...indent(
      [
        tag('DATE', tallyDate(voucher.date)),
        tag('VOUCHERTYPENAME', voucher.voucherType),
        tag('VOUCHERNUMBER', voucher.number),
        ...(original === undefined
          ? []
          : [
              tag('REFERENCE', original.number),
              tag('REFERENCEDATE', tallyDate(original.issuedOn)),
            ]),
        tag('PARTYLEDGERNAME', voucher.partyLedger),
        ...gstXml(voucher),
        tag('PERSISTEDVIEW', 'Accounting Voucher View'),
        tag('ISINVOICE', 'No'),
        tag('ISCANCELLED', yesNo(voucher.cancelled)),
        tag('NARRATION', voucher.narration),
        ...voucher.entries.flatMap((entry) =>
          entryXml(entry, entry.ledger === voucher.partyLedger),
        ),
      ],
      1,
    ),
    '</VOUCHER>',
  ];
}

/** One `Vouchers` import file holding every voucher of the export, in order. */
export function tallyVouchersXml(data: TallyExport): string {
  const messages = data.vouchers.flatMap((voucher) => [
    '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
    ...indent(voucherXml(voucher), 1),
    '</TALLYMESSAGE>',
  ]);
  return envelope(data.companyName, 'Vouchers', messages);
}

/** GSTDUTYHEAD as TallyPrime 7 writes it; older releases may differ (see tally.md). */
const DUTY_HEAD: Record<TallyDutyHead, string> = {
  CGST: 'CGST',
  SGST: 'SGST/UTGST',
  UTGST: 'SGST/UTGST',
  IGST: 'IGST',
  Cess: 'Cess',
};

function ledgerXml(ledger: TallyLedger): string[] {
  const gst =
    ledger.purpose === 'party'
      ? [
          tag('GSTREGISTRATIONTYPE', ledger.gstin === null ? 'Unregistered/Consumer' : 'Regular'),
          ...(ledger.gstin === null ? [] : [tag('PARTYGSTIN', ledger.gstin)]),
          ...(ledger.stateCode === null
            ? []
            : [tag('LEDSTATENAME', gstState(ledger.stateCode).name)]),
          tag('COUNTRYNAME', 'India'),
        ]
      : [];
  const duty =
    ledger.duty === null
      ? []
      : [
          tag('TAXTYPE', 'GST'),
          tag('GSTDUTYHEAD', DUTY_HEAD[ledger.duty.head]),
          tag('RATEOFTAXCALCULATION', paiseToRupees(ledger.duty.rateBasisPoints)),
        ];
  return [
    `<LEDGER NAME="${escapeXml(ledger.name)}" ACTION="Create">`,
    ...indent(
      [
        '<NAME.LIST>',
        ` ${tag('NAME', ledger.name)}`,
        '</NAME.LIST>',
        tag('PARENT', ledger.group),
        tag('ISBILLWISEON', yesNo(ledger.billWise)),
        tag('AFFECTSSTOCK', 'No'),
        ...gst,
        ...duty,
      ],
      1,
    ),
    '</LEDGER>',
  ];
}

/**
 * An `All Masters` import file creating the export's ledgers, to import before
 * the vouchers. Ledgers already in the company (`existing`, matched without
 * regard to case, as Tally does) are left out.
 */
export function tallyLedgersXml(data: TallyExport, existing: readonly string[]): string {
  const known = new Set(existing.map((name) => name.toLowerCase()));
  const messages = data.ledgers
    .filter((ledger) => !known.has(ledger.name.toLowerCase()))
    .flatMap((ledger) => [
      '<TALLYMESSAGE xmlns:UDF="TallyUDF">',
      ...indent(ledgerXml(ledger), 1),
      '</TALLYMESSAGE>',
    ]);
  return envelope(data.companyName, 'All Masters', messages);
}
