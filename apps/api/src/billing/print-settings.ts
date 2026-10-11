import { schema, type Transaction } from '@paint/db';
import {
  aatoTurnoverPaise,
  type AatoBand,
  type InvoicePrintSettings,
  type PrintBankDetails,
} from '@paint/shared';

const { salesSettings } = schema;

/** The sales-settings columns printed on an invoice (spec §5.4). */
export const printFields = {
  bankName: salesSettings.bankName,
  bankAccountName: salesSettings.bankAccountName,
  bankAccountNumber: salesSettings.bankAccountNumber,
  bankIfsc: salesSettings.bankIfsc,
  upiId: salesSettings.upiId,
  invoiceTerms: salesSettings.invoiceTerms,
};

type BankRow = Pick<
  typeof salesSettings.$inferSelect,
  'bankName' | 'bankAccountName' | 'bankAccountNumber' | 'bankIfsc' | 'upiId'
>;

/** The bank details of a settings row; the four bank fields are set together or not at all. */
export function bankOf(row: BankRow): PrintBankDetails | null {
  if (row.bankName === null) return null;
  return {
    bankName: row.bankName,
    accountName: String(row.bankAccountName),
    accountNumber: String(row.bankAccountNumber),
    ifsc: String(row.bankIfsc),
    upiId: row.upiId,
  };
}

/** What printing an invoice of a GSTIN in `aatoBand` needs from the settings (none: the defaults). */
export async function invoicePrintSettings(
  tx: Transaction,
  aatoBand: AatoBand | null,
): Promise<InvoicePrintSettings> {
  const [row] = await tx.select(printFields).from(salesSettings);
  return {
    bank: row ? bankOf(row) : null,
    terms: row?.invoiceTerms ?? [],
    aggregateTurnoverPaise: aatoTurnoverPaise(aatoBand ?? 'up_to_5cr'),
  };
}
