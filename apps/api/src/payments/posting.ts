import {
  ConflictException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  adjustPartyAdvance,
  nextDocumentNumber,
  postPartyLedger,
  schema,
  type Transaction,
} from '@paint/db';
import {
  canAccessStore,
  formatDocumentNumber,
  formatINR,
  type AllocationRequest,
  type PaymentModeKind,
  type TaxDocumentKind,
} from '@paint/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { takeDocumentNumber } from '../billing/series.js';
import { fieldError } from '../tax/tax-lookups.js';

/**
 * The money-moving steps shared by payments, refunds and issue-with-payments
 * (spec §4.4, §4.6). Each runs inside the caller's transaction.
 *
 * Locking: every flow that touches a party's payments first locks the party's
 * balance row (lockParty), so money for one party moves one transaction at a
 * time and two allocations can never take the same outstanding amount.
 */

const {
  allocations,
  parties,
  partyBalances,
  partyLedger,
  paymentModes,
  payments,
  registerSessions,
  salesSettings,
  stores,
  taxDocuments,
} = schema;

export type PaymentRow = typeof payments.$inferSelect;

/**
 * Who records money: a member, or a gateway's webhook for a payment link (no member;
 * P2-M32). An AuthContext is one.
 */
export interface Poster {
  readonly organization: { readonly id: string };
  readonly memberId: string | null;
}

/** A refusal naming the field at fault, shaped like the validation pipe's answers. */
export const refusal = (path: string, message: string) =>
  new UnprocessableEntityException({
    statusCode: 422,
    message: 'Cannot record the payment',
    issues: [{ path, message }],
  });

/** Today's calendar date in India, from the database clock (never the Node clock). */
export const indiaToday = sql<string>`((now() at time zone 'Asia/Kolkata')::date)::text`;

/** Locks the party's balance row (created at zero if new) for the rest of the transaction. */
export async function lockParty(
  tx: Transaction,
  organizationId: string,
  partyId: string,
): Promise<void> {
  await tx.insert(partyBalances).values({ organizationId, partyId }).onConflictDoNothing();
  await tx
    .select({ partyId: partyBalances.partyId })
    .from(partyBalances)
    .where(eq(partyBalances.partyId, partyId))
    .for('update');
}

/** An active, unmerged party, or a 400 naming `path`. */
export async function activeParty(
  tx: Transaction,
  partyId: string,
  path: string,
): Promise<{ id: string; name: string }> {
  const [party] = await tx
    .select({ id: parties.id, name: parties.displayName })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.isActive, true), isNull(parties.mergedIntoId)));
  if (!party) throw fieldError(path, 'Unknown customer');
  return party;
}

/** The organisation's walk-in party, or null before the first walk-in bill. */
export async function walkInPartyId(tx: Transaction): Promise<string | null> {
  const [settings] = await tx
    .select({ walkInPartyId: salesSettings.walkInPartyId })
    .from(salesSettings);
  return settings?.walkInPartyId ?? null;
}

export interface PaymentStore {
  readonly id: string;
  readonly code: string;
  /** Null when the store is not registered for GST: it issues no vouchers. */
  readonly gstin: string | null;
}

/** An active store the member works at. */
export async function paymentStore(
  tx: Transaction,
  auth: AuthContext,
  storeId: string,
  path: string,
): Promise<PaymentStore> {
  const [store] = await tx
    .select({
      id: stores.id,
      code: stores.code,
      gstin: sql<
        string | null
      >`case when ${stores.registrationType} <> 'unregistered' then ${stores.gstin} end`,
    })
    .from(stores)
    .where(and(eq(stores.id, storeId), eq(stores.isActive, true)));
  if (!store) throw fieldError(path, 'Unknown store');
  if (!canAccessStore(auth, storeId)) {
    throw new ForbiddenException('You can take payments only at a store you work at');
  }
  return store;
}

export interface PaymentMode {
  readonly id: string;
  readonly kind: PaymentModeKind;
  readonly name: string;
}

/** An active payment mode of the business a member may take money by. */
export async function activeMode(
  tx: Transaction,
  modeId: string,
  path: string,
): Promise<PaymentMode> {
  const [mode] = await tx
    .select({ id: paymentModes.id, kind: paymentModes.kind, name: paymentModes.name })
    .from(paymentModes)
    .where(and(eq(paymentModes.id, modeId), eq(paymentModes.isActive, true)));
  if (!mode) throw fieldError(path, 'Choose an active payment mode');
  // Only a gateway's webhook records a payment link's money (P2-M32).
  if (mode.kind === 'upi_link') {
    throw fieldError(path, 'Payments by UPI link are recorded when the customer pays the link');
  }
  return mode;
}

/** How money moved, as a request gives it. */
export interface MoneyDetails {
  readonly amountPaise: number;
  readonly reference?: string;
  readonly chequeDate?: string;
  readonly tenderedPaise?: number;
  readonly registerSessionId?: string;
  readonly gatewayReference?: string;
  readonly note?: string;
}

/** The details a mode needs: a cheque's number and date; cash handed over only for cash. */
export function checkDetails(mode: PaymentMode, details: MoneyDetails, prefix: string): void {
  if (mode.kind === 'cheque') {
    if (details.reference === undefined || details.chequeDate === undefined) {
      throw refusal(`${prefix}reference`, 'Enter the cheque number and the date on it');
    }
  } else if (details.chequeDate !== undefined) {
    throw refusal(`${prefix}chequeDate`, 'Only a cheque has a cheque date');
  }
  if (
    details.tenderedPaise !== undefined &&
    (mode.kind !== 'cash' || details.tenderedPaise < details.amountPaise)
  ) {
    throw refusal(`${prefix}tenderedPaise`, 'Cash handed over must be cash, and cover the amount');
  }
}

/**
 * The register session cash goes into ([PO-11]: a session must be open for
 * cash; other modes may name one). Without a requested session, cash goes to
 * the store's only open one. The session stays share-locked, so it cannot
 * close before this payment counts in it.
 */
export async function registerSessionFor(
  tx: Transaction,
  storeId: string,
  modeKind: PaymentModeKind,
  requested: string | undefined,
  path: string,
): Promise<string | null> {
  if (requested !== undefined) {
    const [session] = await tx
      .select({ storeId: registerSessions.storeId, status: registerSessions.status })
      .from(registerSessions)
      .where(eq(registerSessions.id, requested))
      .for('share');
    if (session?.storeId !== storeId) {
      throw fieldError(path, 'Unknown register session at this store');
    }
    if (session.status !== 'open') throw new ConflictException('This register session is closed');
    return requested;
  }
  if (modeKind !== 'cash') return null;
  const [settings] = await tx
    .select({ cashNeedsRegister: salesSettings.cashNeedsRegister })
    .from(salesSettings);
  if (settings?.cashNeedsRegister === false) return null;
  const open = await tx
    .select({ id: registerSessions.id })
    .from(registerSessions)
    .where(and(eq(registerSessions.storeId, storeId), eq(registerSessions.status, 'open')))
    .for('share');
  const [only] = open;
  if (only === undefined) {
    throw new ConflictException('Open the register at this store before taking cash');
  }
  if (open.length > 1) throw fieldError(path, 'Several registers are open here: choose one');
  return only.id;
}

/** Something the party still owes, oldest first. */
export interface OpenTarget {
  readonly documentId: string | null;
  readonly partyLedgerId: string | null;
  readonly kind: TaxDocumentKind | 'opening' | 'charge';
  readonly number: string | null;
  readonly issuedOn: string;
  readonly dueOn: string | null;
  readonly totalPaise: number;
  readonly allocatedPaise: number;
  readonly outstandingPaise: number;
}

/** The party's issued invoices, debit notes, opening balance and charges with money still due. */
export async function openTargets(tx: Transaction, partyId: string): Promise<OpenTarget[]> {
  const result = await tx.execute<{
    document_id: string | null;
    party_ledger_id: string | null;
    kind: OpenTarget['kind'];
    number: string | null;
    issued_on: string;
    due_on: string | null;
    total: string;
    allocated: string;
  }>(sql`
    select t.document_id, t.party_ledger_id, t.kind, t.number, t.issued_on, t.due_on, t.total, t.allocated
    from (
      select d.id as document_id, null::uuid as party_ledger_id, d.kind::text as kind,
        d.number, d.issued_on::text as issued_on, d.due_on::text as due_on,
        d.total_paise as total, d.issued_at as at,
        coalesce((select sum(a.amount_paise) from ${allocations} a where a.document_id = d.id), 0) as allocated
      from ${taxDocuments} d
      where d.party_id = ${partyId} and d.status = 'issued'
        and d.kind in ('invoice', 'bill_of_supply', 'debit_note')
      union all
      select null::uuid, l.id, case l.entry_type when 'opening' then 'opening' else 'charge' end,
        null, l.entry_on::text, null, l.amount_paise, l.created_at,
        coalesce((select sum(a.amount_paise) from ${allocations} a where a.party_ledger_id = l.id), 0)
      from ${partyLedger} l
      where l.party_id = ${partyId} and l.entry_type in ('opening', 'adjustment') and l.amount_paise > 0
    ) t
    where t.total > t.allocated
    order by t.issued_on, t.at, coalesce(t.document_id, t.party_ledger_id)
  `);
  return result.rows.map((row) => ({
    documentId: row.document_id,
    partyLedgerId: row.party_ledger_id,
    kind: row.kind,
    number: row.number,
    issuedOn: row.issued_on,
    dueOn: row.due_on,
    totalPaise: Number(row.total),
    allocatedPaise: Number(row.allocated),
    outstandingPaise: Number(row.total) - Number(row.allocated),
  }));
}

/** One allocation to make. */
export interface PlannedAllocation {
  readonly documentId: string | null;
  readonly partyLedgerId: string | null;
  readonly amountPaise: number;
}

/**
 * Where `available` paise go: the requested bills, each within what is due on
 * it, or (none requested) the oldest open bills first. Whatever is left is
 * an advance.
 */
export async function planAllocations(
  tx: Transaction,
  partyId: string,
  available: number,
  requested: readonly AllocationRequest[] | undefined,
  path: string,
): Promise<PlannedAllocation[]> {
  const open = await openTargets(tx, partyId);
  if (requested === undefined) {
    const plan: PlannedAllocation[] = [];
    let left = available;
    for (const target of open) {
      if (left === 0) break;
      const amountPaise = Math.min(left, target.outstandingPaise);
      plan.push({
        documentId: target.documentId,
        partyLedgerId: target.partyLedgerId,
        amountPaise,
      });
      left -= amountPaise;
    }
    return plan;
  }
  const seen = new Set<string>();
  let total = 0;
  return requested.map((item, index) => {
    const at = `${path}.${String(index)}`;
    const key = String(item.documentId ?? item.partyLedgerId);
    const target = open.find(
      (candidate) => candidate.documentId === key || candidate.partyLedgerId === key,
    );
    if (!target) throw refusal(at, 'Not a bill of this customer with money due');
    if (seen.has(key)) throw refusal(at, 'This bill is listed twice');
    seen.add(key);
    if (item.amountPaise > target.outstandingPaise) {
      throw refusal(
        `${at}.amountPaise`,
        `Only ${formatINR(target.outstandingPaise)} is due on this bill`,
      );
    }
    total += item.amountPaise;
    if (total > available) {
      throw refusal(`${at}.amountPaise`, 'More than this payment has left to allocate');
    }
    return {
      documentId: target.documentId,
      partyLedgerId: target.partyLedgerId,
      amountPaise: item.amountPaise,
    };
  });
}

/** Writes the allocations from a payment; returns how much they took. */
export async function insertAllocations(
  tx: Transaction,
  auth: Poster,
  partyId: string,
  paymentId: string,
  plan: readonly PlannedAllocation[],
): Promise<number> {
  if (plan.length === 0) return 0;
  await tx.insert(allocations).values(
    plan.map((item) => ({
      organizationId: auth.organization.id,
      partyId,
      paymentId,
      documentId: item.documentId,
      partyLedgerId: item.partyLedgerId,
      amountPaise: item.amountPaise,
      createdByMemberId: auth.memberId,
    })),
  );
  return plan.reduce((sum, item) => sum + item.amountPaise, 0);
}

/** Money in or out, ready to write. */
export interface NewPayment {
  readonly store: PaymentStore;
  readonly partyId: string;
  readonly mode: PaymentMode;
  readonly direction: 'in' | 'out';
  readonly details: MoneyDetails;
  readonly receivedOn: string;
  readonly registerSessionId: string | null;
  /** Take a GST voucher number of this kind (an advance's receipt voucher, its refund voucher). */
  readonly voucherKind: 'receipt_voucher' | 'refund_voucher' | null;
  /** The payment link it pays, when a gateway reported it. */
  readonly paymentLinkId?: string;
}

/**
 * Writes a payment with its number (and voucher number) and its party ledger
 * entry: money in lowers the balance, a refund raises it. Allocations and the
 * advance are the caller's.
 */
export async function insertPayment(
  tx: Transaction,
  auth: Poster,
  payment: NewPayment,
): Promise<PaymentRow> {
  const organizationId = auth.organization.id;
  const { store, details, direction } = payment;
  const serial = await nextDocumentNumber(
    tx,
    organizationId,
    direction === 'in' ? 'payment_receipt' : 'payment_refund',
  );
  const number = formatDocumentNumber(direction === 'in' ? 'RC' : 'RF', serial);
  const voucher =
    payment.voucherKind !== null && store.gstin !== null
      ? {
          ...(await takeDocumentNumber(
            tx,
            organizationId,
            { id: store.id, code: store.code, gstin: store.gstin },
            payment.voucherKind,
            payment.receivedOn,
          )),
          gstin: store.gstin,
        }
      : null;
  const cheque = payment.mode.kind === 'cheque' && direction === 'in';
  const [row] = (await tx
    .insert(payments)
    .values({
      organizationId,
      storeId: store.id,
      number,
      direction,
      partyId: payment.partyId,
      modeId: payment.mode.id,
      modeKind: payment.mode.kind,
      amountPaise: details.amountPaise,
      tenderedPaise: details.tenderedPaise,
      receivedOn: payment.receivedOn,
      reference: details.reference,
      chequeDate: details.chequeDate,
      chequeStatus: cheque ? 'pending' : null,
      registerSessionId: payment.registerSessionId,
      gatewayReference: details.gatewayReference,
      paymentLinkId: payment.paymentLinkId,
      note: details.note,
      voucherNumber: voucher?.number,
      voucherFy: voucher?.fy,
      voucherSeriesId: voucher?.seriesId,
      supplierGstin: voucher?.gstin,
      createdByMemberId: auth.memberId,
    })
    .returning()) as [PaymentRow];
  await postPartyLedger(tx, [
    {
      organizationId,
      partyId: payment.partyId,
      storeId: store.id,
      entryOn: payment.receivedOn,
      entryType: direction === 'in' ? 'payment_in' : 'refund_out',
      amountPaise: direction === 'in' ? -details.amountPaise : details.amountPaise,
      referenceType: 'payment',
      referenceId: row.id,
      note: number,
      ...(auth.memberId === null ? {} : { createdByMemberId: auth.memberId }),
    },
  ]);
  return row;
}

/**
 * Money received: the payment, its ledger entry, its allocations and the
 * party's advance for what is left. What is left at a registered store gets
 * a GST receipt voucher number (Rule 50).
 */
export async function receivePayment(
  tx: Transaction,
  auth: Poster,
  payment: Omit<NewPayment, 'direction' | 'voucherKind'>,
  plan: readonly PlannedAllocation[],
): Promise<PaymentRow> {
  const planned = plan.reduce((sum, item) => sum + item.amountPaise, 0);
  const advance = payment.details.amountPaise - planned;
  const row = await insertPayment(tx, auth, {
    ...payment,
    direction: 'in',
    voucherKind: advance > 0 ? 'receipt_voucher' : null,
  });
  await insertAllocations(tx, auth, payment.partyId, row.id, plan);
  await adjustPartyAdvance(tx, payment.partyId, advance);
  return row;
}

/** What is left of a payment received: its amount less its allocations. */
export async function unallocatedOf(tx: Transaction, payment: PaymentRow): Promise<number> {
  const [row] = (await tx
    .select({ used: sql<string>`coalesce(sum(${allocations.amountPaise}), 0)` })
    .from(allocations)
    .where(eq(allocations.paymentId, payment.id))) as [{ used: string }];
  return payment.amountPaise - Number(row.used);
}
