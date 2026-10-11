import type {
  AccountingExportKind,
  LedgerMappingView,
  SupplyType,
  TallyAllocation,
  TallyChequeBounce,
  TallyGroup,
  TallyLedgerRule,
  TallyParty,
  TallyPaymentMode,
  TallyReceipt,
  TallyRefund,
  TallySalesDocument,
  TallySalesKind,
  TallyTaxLine,
  TaxNature,
} from '@paint/shared';

/**
 * Turns the stored rows of a period into the Tally mapper's input (round 2c,
 * packages/shared/src/tally): pure, so every rule is unit-tested. The service
 * reads the rows; this file only reshapes them.
 */

/** An issued or cancelled GST document of the period, with its store's code. */
export interface DocumentRow {
  readonly id: string;
  readonly kind: 'invoice' | 'bill_of_supply' | 'credit_note' | 'debit_note';
  readonly status: 'issued' | 'cancelled';
  readonly number: string;
  readonly issuedOn: string;
  readonly storeCode: string;
  readonly supplierGstin: string;
  readonly supplierStateCode: string;
  readonly partyId: string | null;
  readonly buyerName: string | null;
  readonly buyerGstin: string | null;
  readonly buyerStateCode: string | null;
  readonly placeOfSupplyCode: string;
  readonly supplyType: SupplyType;
  readonly roundOffPaise: number;
  readonly totalPaise: number;
  readonly reason: string | null;
}

/** A document line: the tax category's key decides exempt from nil-rated at 0%. */
export interface LineRow {
  readonly documentId: string;
  readonly hsnCode: string | null;
  readonly rateBps: number | null;
  readonly cessBps: number | null;
  readonly categoryKey: string | null;
  readonly taxablePaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly cessPaise: number;
}

/** A note's invoice (`note_of`). */
export interface OriginalRow {
  readonly noteId: string;
  readonly number: string;
  readonly issuedOn: string;
}

/** A live allocation of a receipt or credit note to one of our bills. */
export interface AllocationRow {
  readonly sourceId: string;
  readonly documentNumber: string;
  readonly amountPaise: number;
}

/** The party and mode of a payment, as every money row carries them. */
interface MoneyRow {
  readonly id: string;
  readonly storeCode: string;
  readonly partyId: string;
  readonly partyName: string;
  readonly partyGstin: string | null;
  readonly partyStateCode: string | null;
  readonly modeKind: TallyPaymentMode['kind'];
  readonly modeName: string;
  readonly amountPaise: number;
  readonly reference: string | null;
}

/** Money in from a party in the period, bounced cheques included. */
export interface ReceiptRow extends MoneyRow {
  readonly number: string;
  readonly voucherNumber: string | null;
  readonly receivedOn: string;
  readonly note: string | null;
}

/** The receipt a refund repays or a bounce reverses, as it was exported. */
interface ReceiptOfRow {
  readonly receiptNumber: string;
  readonly receiptVoucherNumber: string | null;
  readonly receivedOn: string;
}

/** Money paid back in the period, with the receipt it repays. */
export interface RefundRow extends MoneyRow, ReceiptOfRow {
  readonly number: string;
  readonly voucherNumber: string | null;
  readonly paidOn: string;
  readonly note: string | null;
}

/** A cheque that bounced in the period, and the charge the bounce added. */
export interface BounceRow extends MoneyRow, ReceiptOfRow {
  readonly bouncedOn: string;
  readonly reason: string;
  readonly chargePaise: number;
}

/** The export kind a document kind falls under. */
export const EXPORT_KIND_OF: Readonly<Record<DocumentRow['kind'], AccountingExportKind>> = {
  invoice: 'sales',
  bill_of_supply: 'sales',
  credit_note: 'credit_note',
  debit_note: 'debit_note',
};

const SALES_KIND: Readonly<Record<DocumentRow['kind'], TallySalesKind>> = {
  invoice: 'tax_invoice',
  bill_of_supply: 'bill_of_supply',
  credit_note: 'credit_note',
  debit_note: 'debit_note',
};

/** A line's GST nature, as issue decides it: 0% is exempt for the Exempt category, else nil-rated. */
export function natureOf(rateBps: number, categoryKey: string | null): TaxNature {
  if (rateBps > 0) return 'taxable';
  return categoryKey === 'exempt' ? 'exempt' : 'nil_rated';
}

/** Lines of one HSN, rate and nature added up, in first-seen order. */
export function taxLinesOf(lines: readonly LineRow[]): TallyTaxLine[] {
  const merged = new Map<string, TallyTaxLine>();
  for (const line of lines) {
    const rate = line.rateBps ?? 0;
    const cess = line.cessBps ?? 0;
    const hsnCode = line.hsnCode ?? '';
    const nature = natureOf(rate, line.categoryKey);
    const key = [hsnCode, rate, cess, nature].join('|');
    const before = merged.get(key);
    merged.set(key, {
      hsnCode,
      nature,
      rateBasisPoints: rate,
      cessBasisPoints: cess,
      taxablePaise: (before?.taxablePaise ?? 0) + line.taxablePaise,
      cgstPaise: (before?.cgstPaise ?? 0) + line.cgstPaise,
      sgstPaise: (before?.sgstPaise ?? 0) + line.sgstPaise,
      igstPaise: (before?.igstPaise ?? 0) + line.igstPaise,
      cessPaise: (before?.cessPaise ?? 0) + line.cessPaise,
    });
  }
  return [...merged.values()];
}

const group = <T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const row of rows) groups.set(key(row), [...(groups.get(key(row)) ?? []), row]);
  return groups;
};

const allocationsOf = (rows: readonly AllocationRow[] | undefined): TallyAllocation[] =>
  (rows ?? []).map((row) => ({ documentNumber: row.documentNumber, amountPaise: row.amountPaise }));

/** The buyer of a document: the walk-in party (or none) posts to "Cash Sales". */
export function documentParty(doc: DocumentRow, walkInPartyId: string | null): TallyParty {
  return {
    id: doc.partyId ?? doc.id,
    name: doc.buyerName ?? '',
    gstin: doc.buyerGstin,
    stateCode: doc.buyerStateCode,
    walkIn: doc.partyId === null || doc.partyId === walkInPartyId,
  };
}

export function salesDocumentsOf(
  documents: readonly DocumentRow[],
  lines: readonly LineRow[],
  originals: readonly OriginalRow[],
  allocations: readonly AllocationRow[],
  walkInPartyId: string | null,
): TallySalesDocument[] {
  const linesBy = group(lines, (line) => line.documentId);
  const originalsBy = group(originals, (row) => row.noteId);
  const allocationsBy = group(allocations, (row) => row.sourceId);
  return documents.map((doc) => ({
    id: doc.id,
    kind: SALES_KIND[doc.kind],
    number: doc.number,
    issuedOn: doc.issuedOn,
    cancelled: doc.status === 'cancelled',
    storeCode: doc.storeCode,
    supplierGstin: doc.supplierGstin,
    supplierStateCode: doc.supplierStateCode,
    party: documentParty(doc, walkInPartyId),
    placeOfSupplyCode: doc.placeOfSupplyCode,
    supplyType: doc.supplyType,
    lines: taxLinesOf(linesBy.get(doc.id) ?? []),
    roundOffPaise: doc.roundOffPaise,
    totalPaise: doc.totalPaise,
    originals: (originalsBy.get(doc.id) ?? []).map(({ number, issuedOn }) => ({
      number,
      issuedOn,
    })),
    allocations: doc.kind === 'credit_note' ? allocationsOf(allocationsBy.get(doc.id)) : [],
    note: doc.reason,
  }));
}

const partyOf = (row: MoneyRow, walkInPartyId: string | null): TallyParty => ({
  id: row.partyId,
  name: row.partyName,
  gstin: row.partyGstin,
  stateCode: row.partyStateCode,
  walkIn: row.partyId === walkInPartyId,
});

const receiptOf = (row: ReceiptOfRow) => ({
  number: row.receiptVoucherNumber ?? row.receiptNumber,
  receivedOn: row.receivedOn,
  advance: row.receiptVoucherNumber !== null,
});

/** Refunds: numbered by the refund voucher when they repay an advance (Rule 51). */
export function refundsOf(rows: readonly RefundRow[], walkInPartyId: string | null): TallyRefund[] {
  return rows.map((row) => ({
    id: row.id,
    number: row.voucherNumber ?? row.number,
    paidOn: row.paidOn,
    storeCode: row.storeCode,
    party: partyOf(row, walkInPartyId),
    mode: { kind: row.modeKind, name: row.modeName },
    amountPaise: row.amountPaise,
    reference: row.reference,
    receipt: receiptOf(row),
    note: row.note,
  }));
}

/** Bounces, each with the bills it opened again (`reopened`, by payment id). */
export function bouncesOf(
  rows: readonly BounceRow[],
  reopened: readonly AllocationRow[],
  walkInPartyId: string | null,
): TallyChequeBounce[] {
  const reopenedBy = group(reopened, (row) => row.sourceId);
  return rows.map((row) => ({
    paymentId: row.id,
    bouncedOn: row.bouncedOn,
    storeCode: row.storeCode,
    party: partyOf(row, walkInPartyId),
    mode: { kind: row.modeKind, name: row.modeName },
    amountPaise: row.amountPaise,
    reference: row.reference,
    receipt: receiptOf(row),
    reopened: allocationsOf(reopenedBy.get(row.id)),
    chargePaise: row.chargePaise,
    reason: row.reason,
  }));
}

/** Receipts: numbered by the receipt voucher when it is an advance. */
export function receiptsOf(
  receipts: readonly ReceiptRow[],
  allocations: readonly AllocationRow[],
  walkInPartyId: string | null,
): TallyReceipt[] {
  const allocationsBy = group(allocations, (row) => row.sourceId);
  return receipts.map((receipt) => ({
    id: receipt.id,
    number: receipt.voucherNumber ?? receipt.number,
    receivedOn: receipt.receivedOn,
    storeCode: receipt.storeCode,
    party: partyOf(receipt, walkInPartyId),
    mode: { kind: receipt.modeKind, name: receipt.modeName },
    amountPaise: receipt.amountPaise,
    reference: receipt.reference,
    advance: receipt.voucherNumber !== null,
    allocations: allocationsOf(allocationsBy.get(receipt.id)),
    note: receipt.note,
  }));
}

/**
 * A mapping row as the mapper's rule: stores match by code and payment modes
 * by name (what the mapper knows), the rest as they are.
 */
export function ledgerRuleOf(
  mapping: LedgerMappingView,
  storeCodes: ReadonlyMap<string, string>,
  modeNames: ReadonlyMap<string, string>,
): TallyLedgerRule {
  const optional = <K extends string, V>(key: K, value: V | null | undefined) =>
    (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;
  return {
    purpose: mapping.purpose,
    ledgerName: mapping.ledgerName,
    ...optional<'group', TallyGroup>('group', mapping.group),
    ...optional('rateBasisPoints', mapping.rateBasisPoints),
    ...optional('nature', mapping.nature),
    ...optional('supplyType', mapping.supplyType),
    ...optional('modeKind', mapping.modeKind),
    ...optional('partyId', mapping.partyId),
    ...optional('storeCode', mapping.storeId === null ? null : storeCodes.get(mapping.storeId)),
    ...optional('modeName', mapping.modeId === null ? null : modeNames.get(mapping.modeId)),
  };
}
