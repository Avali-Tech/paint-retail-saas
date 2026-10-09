import { stateTaxLabel } from '../gst/states.js';
import { TallyError, type TallyProblem } from './errors.js';
import { paiseToRupees } from '../money.js';
import {
  bounceChargesNeed,
  compositionSalesNeed,
  partyNeed,
  paymentModeNeed,
  resolveLedger,
  roundOffNeed,
  salesNeed,
  taxNeed,
  type TallyDutyHead,
  type TallyLedger,
  type TallyLedgerNeed,
  type TallyLedgerRule,
} from './ledgers.js';
import type {
  TallyAllocation,
  TallyChequeBounce,
  TallyDocumentRef,
  TallyParty,
  TallyPeriod,
  TallyReceipt,
  TallyReceiptRef,
  TallyRefund,
  TallySalesDocument,
  TallySalesKind,
} from './types.js';
import { checkPeriod } from './validate.js';

/** Tally's bill types for bill-wise details. */
export type TallyBillType = 'New Ref' | 'Agst Ref' | 'Advance' | 'On Account';

/** One bill-wise line under a party entry; it takes the entry's side. */
export interface TallyBill {
  readonly type: TallyBillType;
  /** The bill reference: our invoice number, or the receipt number for an advance. */
  readonly name: string;
  readonly paise: number;
}

/**
 * One ledger line of a voucher, in plain accounting terms: a positive amount on
 * the debit or credit side. The XML writer turns it into Tally's signed form.
 */
export interface TallyEntry {
  readonly ledger: string;
  readonly side: 'debit' | 'credit';
  readonly paise: number;
  /** Party entries on a bill-wise ledger; empty otherwise. */
  readonly bills: readonly TallyBill[];
  /** Sales entries: the HSN codes whose taxable value it carries. */
  readonly hsnCodes: readonly string[];
  /** Sales and tax entries: the rate it carries (the head's rate for tax), else null. */
  readonly rateBasisPoints: number | null;
}

export type TallyVoucherKind =
  'sales' | 'credit_note' | 'debit_note' | 'receipt' | 'payment' | 'journal';

/** What a voucher was made from: a GST document kind, or a money event. */
export type TallyVoucherSource = TallySalesKind | 'receipt' | 'refund' | 'cheque_bounce';

/** The Tally voucher type names to import into. */
export type TallyVoucherTypes = Readonly<Record<TallyVoucherSource, string>>;

/**
 * TallyPrime's predefined voucher types. A bill of supply goes to Sales too;
 * a business that keeps a separate voucher type (or class) for it overrides it.
 * A refund is money paid out (Payment); a bounced cheque moves no money, it
 * undoes a receipt, so it is a Journal (docs/mvp-2/tally.md says why).
 */
export const DEFAULT_TALLY_VOUCHER_TYPES: TallyVoucherTypes = {
  tax_invoice: 'Sales',
  bill_of_supply: 'Sales',
  credit_note: 'Credit Note',
  debit_note: 'Debit Note',
  receipt: 'Receipt',
  refund: 'Payment',
  cheque_bounce: 'Journal',
};

export interface TallyVoucherGst {
  readonly supplierGstin: string;
  readonly placeOfSupplyCode: string;
}

export interface TallyVoucher {
  readonly kind: TallyVoucherKind;
  /** Our document kind, or the money event. */
  readonly source: TallyVoucherSource;
  readonly documentId: string;
  readonly voucherType: string;
  readonly number: string;
  readonly date: string;
  readonly cancelled: boolean;
  readonly partyLedger: string;
  readonly party: TallyParty;
  /** GST documents only: our GSTIN and the place of supply. Null on money vouchers. */
  readonly gst: TallyVoucherGst | null;
  /** Notes: the invoices adjusted. Refunds and bounces: the receipt. Empty otherwise. */
  readonly originals: readonly TallyDocumentRef[];
  readonly narration: string;
  /** Debits first in the order Tally shows them; empty for a cancelled voucher. */
  readonly entries: readonly TallyEntry[];
}

export interface TallyExport {
  readonly companyName: string;
  readonly from: string;
  readonly to: string;
  /** In date order; on one date sales, debit notes, credit notes, receipts, payments, journals. */
  readonly vouchers: readonly TallyVoucher[];
  /** Every ledger the vouchers use, by name. */
  readonly ledgers: readonly TallyLedger[];
}

export interface TallyExportOptions {
  readonly ledgerRules: readonly TallyLedgerRule[];
  readonly voucherTypes: TallyVoucherTypes;
}

const DOCUMENT_LABEL: Record<TallySalesKind, string> = {
  tax_invoice: 'Tax invoice',
  bill_of_supply: 'Bill of supply',
  credit_note: 'Credit note',
  debit_note: 'Debit note',
};

const VOUCHER_KIND: Record<TallySalesKind, TallyVoucherKind> = {
  tax_invoice: 'sales',
  bill_of_supply: 'sales',
  credit_note: 'credit_note',
  debit_note: 'debit_note',
};

const ORDER: Record<TallyVoucherKind, number> = {
  sales: 0,
  debit_note: 1,
  credit_note: 2,
  receipt: 3,
  payment: 4,
  journal: 5,
};

/** `2026-09-05` → `05-09-2026`, the way Indian invoices print dates. */
const indianDate = (iso: string) => iso.split('-').reverse().join('-');

/** Our id in a fixed tag, so a later import can find vouchers it already brought in. */
export const narrationTag = (documentId: string) => `[paint:${documentId}]`;

/** A ledger line before its ledger name is resolved. */
interface Pending {
  readonly need: TallyLedgerNeed;
  readonly side: 'debit' | 'credit';
  readonly paise: number;
  readonly bills: readonly TallyBill[];
  readonly hsnCodes: readonly string[];
  readonly rateBasisPoints: number | null;
}

function billsFor(
  party: TallyParty,
  total: number,
  allocations: readonly TallyAllocation[],
  rest: { readonly type: TallyBillType; readonly name: string },
): TallyBill[] {
  if (party.walkIn) return [];
  const bills: TallyBill[] = allocations.map((allocation) => ({
    type: 'Agst Ref',
    name: allocation.documentNumber,
    paise: allocation.amountPaise,
  }));
  const left = total - bills.reduce((sum, bill) => sum + bill.paise, 0);
  if (left > 0) bills.push({ ...rest, paise: left });
  return bills;
}

const ON_ACCOUNT = { type: 'On Account', name: '' } as const;

function documentLines(doc: TallySalesDocument): Pending[] {
  const sale = doc.kind !== 'credit_note';
  const towardsParty = sale ? 'debit' : 'credit';
  const away = sale ? 'credit' : 'debit';
  const pending: Pending[] = [];
  // A sale opens a bill under its own number; a credit note settles bills or sits on account.
  const rest = sale ? { type: 'New Ref' as const, name: doc.number } : ON_ACCOUNT;
  pending.push({
    need: partyNeed(doc.party, doc.storeCode),
    side: towardsParty,
    paise: doc.totalPaise,
    bills: billsFor(doc.party, doc.totalPaise, sale ? [] : doc.allocations, rest),
    hsnCodes: [],
    rateBasisPoints: null,
  });
  if (doc.roundOffPaise < 0) {
    pending.push({
      need: roundOffNeed(doc.storeCode),
      side: towardsParty,
      paise: -doc.roundOffPaise,
      bills: [],
      hsnCodes: [],
      rateBasisPoints: null,
    });
  }
  const label = stateTaxLabel(doc.supplierStateCode);
  for (const line of doc.lines) {
    pending.push({
      need:
        doc.kind === 'bill_of_supply'
          ? compositionSalesNeed(doc.storeCode)
          : salesNeed(line.nature, line.rateBasisPoints, doc.supplyType, doc.storeCode),
      side: away,
      paise: line.taxablePaise,
      bills: [],
      hsnCodes: [line.hsnCode],
      rateBasisPoints: line.rateBasisPoints,
    });
  }
  for (const line of doc.lines) {
    const half = line.rateBasisPoints / 2;
    const heads: readonly [TallyDutyHead, number, number][] = [
      ['CGST', line.cgstPaise, half],
      [label, line.sgstPaise, half],
      ['IGST', line.igstPaise, line.rateBasisPoints],
      ['Cess', line.cessPaise, line.cessBasisPoints],
    ];
    for (const [head, paise, rate] of heads) {
      if (paise === 0) continue;
      pending.push({
        need: taxNeed(head, rate, doc.storeCode),
        side: away,
        paise,
        bills: [],
        hsnCodes: [],
        rateBasisPoints: rate,
      });
    }
  }
  if (doc.roundOffPaise > 0) {
    pending.push({
      need: roundOffNeed(doc.storeCode),
      side: away,
      paise: doc.roundOffPaise,
      bills: [],
      hsnCodes: [],
      rateBasisPoints: null,
    });
  }
  return pending;
}

function receiptLines(receipt: TallyReceipt): Pending[] {
  const rest = receipt.advance ? { type: 'Advance' as const, name: receipt.number } : ON_ACCOUNT;
  return [
    {
      need: paymentModeNeed(receipt.mode, receipt.storeCode),
      side: 'debit',
      paise: receipt.amountPaise,
      bills: [],
      hsnCodes: [],
      rateBasisPoints: null,
    },
    {
      need: partyNeed(receipt.party, receipt.storeCode),
      side: 'credit',
      paise: receipt.amountPaise,
      bills: billsFor(receipt.party, receipt.amountPaise, receipt.allocations, rest),
      hsnCodes: [],
      rateBasisPoints: null,
    },
  ];
}

/** Money going back against a receipt: its Advance bill, or on account. */
const againstReceipt = (receipt: TallyReceiptRef) =>
  receipt.advance ? { type: 'Agst Ref' as const, name: receipt.number } : ON_ACCOUNT;

/** A refund: Dr party (against the receipt's advance, or on account), Cr the mode's ledger. */
function refundLines(refund: TallyRefund): Pending[] {
  return [
    {
      need: partyNeed(refund.party, refund.storeCode),
      side: 'debit',
      paise: refund.amountPaise,
      bills: billsFor(refund.party, refund.amountPaise, [], againstReceipt(refund.receipt)),
      hsnCodes: [],
      rateBasisPoints: null,
    },
    {
      need: paymentModeNeed(refund.mode, refund.storeCode),
      side: 'credit',
      paise: refund.amountPaise,
      bills: [],
      hsnCodes: [],
      rateBasisPoints: null,
    },
  ];
}

/** The bounce's voucher number: the receipt's, marked, so the two sit together. */
export const bounceNumber = (bounce: TallyChequeBounce) => `${bounce.receipt.number}/BOUNCE`;

/**
 * A bounce: the receipt turned round. Dr party, reopening the bills it settled
 * (the rest against its advance, or on account), Cr the ledger the cheque
 * went into. A bounce charge is a new bill on the party, Cr bounce charges.
 */
function bounceLines(bounce: TallyChequeBounce): Pending[] {
  const party = partyNeed(bounce.party, bounce.storeCode);
  const lines: Pending[] = [
    {
      need: party,
      side: 'debit',
      paise: bounce.amountPaise,
      bills: billsFor(
        bounce.party,
        bounce.amountPaise,
        bounce.reopened,
        againstReceipt(bounce.receipt),
      ),
      hsnCodes: [],
      rateBasisPoints: null,
    },
    {
      need: paymentModeNeed(bounce.mode, bounce.storeCode),
      side: 'credit',
      paise: bounce.amountPaise,
      bills: [],
      hsnCodes: [],
      rateBasisPoints: null,
    },
  ];
  if (bounce.chargePaise === 0) return lines;
  return [
    ...lines,
    {
      need: party,
      side: 'debit',
      paise: bounce.chargePaise,
      bills: billsFor(bounce.party, bounce.chargePaise, [], {
        type: 'New Ref',
        name: bounceNumber(bounce),
      }),
      hsnCodes: [],
      rateBasisPoints: null,
    },
    {
      need: bounceChargesNeed(bounce.storeCode),
      side: 'credit',
      paise: bounce.chargePaise,
      bills: [],
      hsnCodes: [],
      rateBasisPoints: null,
    },
  ];
}

interface Draft {
  readonly kind: TallyVoucherKind;
  readonly source: TallyVoucherSource;
  readonly documentId: string;
  readonly number: string;
  readonly date: string;
  readonly cancelled: boolean;
  readonly party: TallyParty;
  readonly partyNeed: TallyLedgerNeed;
  readonly gst: TallyVoucherGst | null;
  readonly originals: readonly TallyDocumentRef[];
  readonly narration: string;
  readonly lines: readonly Pending[];
}

function documentDraft(doc: TallySalesDocument): Draft {
  const against = doc.originals.map((ref) => `${ref.number} dated ${indianDate(ref.issuedOn)}`);
  const narration = [
    `${DOCUMENT_LABEL[doc.kind]} ${doc.number}`,
    ...(against.length > 0 ? [`against ${against.join(', ')}`] : []),
    ...(doc.cancelled ? ['CANCELLED'] : []),
    ...(doc.note === null ? [] : [doc.note]),
    narrationTag(doc.id),
  ].join('; ');
  return {
    kind: VOUCHER_KIND[doc.kind],
    source: doc.kind,
    documentId: doc.id,
    number: doc.number,
    date: doc.issuedOn,
    cancelled: doc.cancelled,
    party: doc.party,
    partyNeed: partyNeed(doc.party, doc.storeCode),
    gst: { supplierGstin: doc.supplierGstin, placeOfSupplyCode: doc.placeOfSupplyCode },
    originals: doc.originals,
    narration,
    lines: doc.cancelled ? [] : documentLines(doc),
  };
}

function receiptDraft(receipt: TallyReceipt): Draft {
  const narration = [
    `${receipt.advance ? 'Advance receipt' : 'Receipt'} ${receipt.number} by ${receipt.mode.name}`,
    ...(receipt.reference === null ? [] : [`ref ${receipt.reference}`]),
    ...(receipt.note === null ? [] : [receipt.note]),
    narrationTag(receipt.id),
  ].join('; ');
  return {
    kind: 'receipt',
    source: 'receipt',
    documentId: receipt.id,
    number: receipt.number,
    date: receipt.receivedOn,
    cancelled: false,
    party: receipt.party,
    partyNeed: partyNeed(receipt.party, receipt.storeCode),
    gst: null,
    originals: [],
    narration,
    lines: receiptLines(receipt),
  };
}

const receiptRef = (receipt: TallyReceiptRef): TallyDocumentRef => ({
  number: receipt.number,
  issuedOn: receipt.receivedOn,
});

function refundDraft(refund: TallyRefund): Draft {
  const narration = [
    `Refund ${refund.number} by ${refund.mode.name}`,
    `against receipt ${refund.receipt.number} dated ${indianDate(refund.receipt.receivedOn)}`,
    ...(refund.reference === null ? [] : [`ref ${refund.reference}`]),
    ...(refund.note === null ? [] : [refund.note]),
    narrationTag(refund.id),
  ].join('; ');
  return {
    kind: 'payment',
    source: 'refund',
    documentId: refund.id,
    number: refund.number,
    date: refund.paidOn,
    cancelled: false,
    party: refund.party,
    partyNeed: partyNeed(refund.party, refund.storeCode),
    gst: null,
    originals: [receiptRef(refund.receipt)],
    narration,
    lines: refundLines(refund),
  };
}

/** The bounce's own id: one payment is both a receipt and, later, its bounce. */
export const bounceId = (bounce: TallyChequeBounce) => `${bounce.paymentId}-bounce`;

function bounceDraft(bounce: TallyChequeBounce): Draft {
  const narration = [
    `Cheque bounced: receipt ${bounce.receipt.number} dated ${indianDate(bounce.receipt.receivedOn)} by ${bounce.mode.name}`,
    ...(bounce.reference === null ? [] : [`ref ${bounce.reference}`]),
    bounce.reason,
    ...(bounce.chargePaise === 0 ? [] : [`bounce charge Rs ${paiseToRupees(bounce.chargePaise)}`]),
    narrationTag(bounceId(bounce)),
  ].join('; ');
  return {
    kind: 'journal',
    source: 'cheque_bounce',
    documentId: bounceId(bounce),
    number: bounceNumber(bounce),
    date: bounce.bouncedOn,
    cancelled: false,
    party: bounce.party,
    partyNeed: partyNeed(bounce.party, bounce.storeCode),
    gst: null,
    originals: [receiptRef(bounce.receipt)],
    narration,
    lines: bounceLines(bounce),
  };
}

/** Adds up lines that land on the same ledger and side, keeping first-seen order. */
function merge(lines: readonly (Pending & { readonly ledger: string })[]): TallyEntry[] {
  const entries = new Map<string, TallyEntry>();
  for (const line of lines) {
    const key = `${line.side}|${line.ledger}`;
    const before = entries.get(key);
    entries.set(key, {
      ledger: line.ledger,
      side: line.side,
      paise: (before?.paise ?? 0) + line.paise,
      bills: [...(before?.bills ?? []), ...line.bills],
      hsnCodes: [...new Set([...(before?.hsnCodes ?? []), ...line.hsnCodes])],
      rateBasisPoints: line.rateBasisPoints,
    });
  }
  const merged = [...entries.values()].filter((entry) => entry.paise !== 0);
  return [
    ...merged.filter((entry) => entry.side === 'debit'),
    ...merged.filter((entry) => entry.side === 'credit'),
  ];
}

function drafts(period: TallyPeriod): Draft[] {
  return [
    ...period.documents.map(documentDraft),
    ...period.receipts.map(receiptDraft),
    ...period.refunds.map(refundDraft),
    ...period.bounces.map(bounceDraft),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      ORDER[a.kind] - ORDER[b.kind] ||
      (a.number < b.number ? -1 : a.number > b.number ? 1 : 0),
  );
}

/**
 * Resolves every ledger the period needs into vouchers and ledger masters, and
 * reports what cannot be resolved: needs with no mapping, blank names, and one
 * name standing for two different things (two parties, or CGST and SGST).
 * With problems, the vouchers hold blank names and must not be used.
 */
function resolveAll(
  period: TallyPeriod,
  options: TallyExportOptions,
): { problems: TallyProblem[]; vouchers: TallyVoucher[]; ledgers: TallyLedger[] } {
  const problems: TallyProblem[] = [];
  const reported = new Set<string>();
  const report = (problem: TallyProblem) => {
    if (reported.has(problem.message)) return;
    reported.add(problem.message);
    problems.push(problem);
  };
  const masters = new Map<string, { ledger: TallyLedger; identity: string; description: string }>();
  const nameOf = (need: TallyLedgerNeed): string => {
    const { name, group } = resolveLedger(need, options.ledgerRules);
    if (name === null) {
      report({
        code: 'unmapped_ledger',
        document: null,
        message: `No Tally ledger is mapped for ${need.description}; add a ${need.purpose} mapping`,
      });
      return '';
    }
    if (name.trim() === '' || name !== name.trim()) {
      report({
        code: 'invalid_ledger_name',
        document: null,
        message: `The ledger name "${name}" for ${need.description} is blank or has outer spaces`,
      });
      return '';
    }
    const ledger: TallyLedger = { name, ...need.master, group };
    const existing = masters.get(name);
    if (existing === undefined) {
      masters.set(name, { ledger, identity: need.identity, description: need.description });
    } else if (
      existing.identity !== need.identity ||
      JSON.stringify(existing.ledger) !== JSON.stringify(ledger)
    ) {
      report({
        code: 'ledger_conflict',
        document: null,
        message: `The ledger "${name}" is mapped for both ${existing.description} and ${need.description}`,
      });
    }
    return name;
  };
  const vouchers = drafts(period).map((draft): TallyVoucher => ({
    kind: draft.kind,
    source: draft.source,
    documentId: draft.documentId,
    voucherType: options.voucherTypes[draft.source],
    number: draft.number,
    date: draft.date,
    cancelled: draft.cancelled,
    partyLedger: nameOf(draft.partyNeed),
    party: draft.party,
    gst: draft.gst,
    originals: draft.originals,
    narration: draft.narration,
    entries: merge(draft.lines.map((line) => ({ ...line, ledger: nameOf(line.need) }))),
  }));
  const ledgers = [...masters.values()]
    .map((entry) => entry.ledger)
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return { problems, vouchers, ledgers };
}

/** Every problem that would stop `buildTallyExport`: bad input first, then ledger mapping. */
export function checkTallyExport(period: TallyPeriod, options: TallyExportOptions): TallyProblem[] {
  const problems = checkPeriod(period);
  return problems.length > 0 ? problems : resolveAll(period, options).problems;
}

/**
 * Maps a period's documents onto Tally vouchers (accounting-voucher mode, spec
 * §6.1) and the ledgers they use. Throws a `TallyError` listing every problem
 * when the input does not balance or a ledger is not mapped.
 */
export function buildTallyExport(period: TallyPeriod, options: TallyExportOptions): TallyExport {
  const problems = checkTallyExport(period, options);
  if (problems.length > 0) throw new TallyError(problems);
  const { vouchers, ledgers } = resolveAll(period, options);
  return { companyName: period.companyName, from: period.from, to: period.to, vouchers, ledgers };
}
