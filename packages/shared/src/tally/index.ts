/**
 * Tally export (roadmap P2-M07, spec §6.1): a pure library that turns a
 * period's GST documents and receipts into TallyPrime import XML (vouchers and
 * ledger masters) and an .xlsx of the same vouchers. No database, no network.
 *
 * - Mode: accounting vouchers (ledger lines, no stock items), per §6.1 / PO-8.
 * - Signs: a debit is AMOUNT < 0 with ISDEEMEDPOSITIVE Yes, a credit AMOUNT > 0
 *   with ISDEEMEDPOSITIVE No (docs/mvp-2/tally.md cites Tally's documentation).
 * - Ledgers: every amount resolves to a ledger by the business's mapping rules,
 *   else a default name; anything unmapped is reported, all at once.
 * - Identity: each voucher carries REMOTEID `paint-<document id>` and the tag
 *   `[paint:<document id>]` in its narration, so a re-import is detected.
 */
export { TallyError, type TallyProblem, type TallyProblemCode } from './errors.js';
export {
  percentLabel,
  resolveLedger,
  type TallyDutyHead,
  type TallyGroup,
  type TallyLedger,
  type TallyLedgerMatch,
  type TallyLedgerPurpose,
  type TallyLedgerRule,
} from './ledgers.js';
export type {
  TallyAllocation,
  TallyDocumentRef,
  TallyParty,
  TallyPaymentMode,
  TallyPeriod,
  TallyReceipt,
  TallySalesDocument,
  TallySalesKind,
  TallyTaxLine,
} from './types.js';
export {
  DEFAULT_TALLY_VOUCHER_TYPES,
  buildTallyExport,
  checkTallyExport,
  type TallyBill,
  type TallyBillType,
  type TallyEntry,
  type TallyExport,
  type TallyExportOptions,
  type TallyVoucher,
  type TallyVoucherGst,
  type TallyVoucherKind,
  type TallyVoucherTypes,
} from './vouchers.js';
export { tallyLedgerTotals, tallyWorkbook, type TallyLedgerTotal } from './workbook.js';
export { tallyLedgersXml, tallyVouchersXml } from './xml.js';
