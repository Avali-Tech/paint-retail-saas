import { NotFoundException } from '@nestjs/common';
import { schema, type Transaction } from '@paint/db';
import {
  amountInWords,
  canAccessStore,
  type AllocationView,
  type PaymentView,
  type ReceiptView,
} from '@paint/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import type { PaymentRow } from './posting.js';

const {
  allocations,
  organizationMembers,
  parties,
  partyBalances,
  partyLedger,
  paymentModes,
  payments,
  stores,
  taxDocuments,
  users,
} = schema;

const refund = alias(payments, 'refund');
const source = alias(payments, 'source');
const reversal = alias(allocations, 'reversal');

/**
 * The payment, locked for the rest of the transaction when `lock` is set. A
 * payment at a store the member does not work at is "not found".
 */
export async function loadPayment(
  tx: Transaction,
  auth: AuthContext,
  id: string,
  lock = false,
): Promise<PaymentRow> {
  const query = tx.select().from(payments).where(eq(payments.id, id));
  const [payment] = lock ? await query.for('update') : await query;
  if (!payment || !canAccessStore(auth, payment.storeId)) {
    throw new NotFoundException('Payment not found');
  }
  return payment;
}

/** Rows that moved this payment's money: from it (money in) or into it (a refund). */
async function allocationsOf(tx: Transaction, payment: PaymentRow): Promise<AllocationView[]> {
  const rows = await tx
    .select({
      id: allocations.id,
      paymentId: allocations.paymentId,
      creditNoteId: allocations.creditNoteId,
      documentId: allocations.documentId,
      partyLedgerId: allocations.partyLedgerId,
      refundPaymentId: allocations.refundPaymentId,
      // Money in: the bill or refund it went to. A refund: the payment it came from.
      targetNumber:
        payment.direction === 'in'
          ? sql<
              string | null
            >`coalesce(${taxDocuments.number}, ${refund.number}, ${partyLedger.note})`
          : sql<string | null>`${source.number}`,
      amountPaise: allocations.amountPaise,
      reversesAllocationId: allocations.reversesAllocationId,
      reversalReason: allocations.reversalReason,
      reversed: sql<boolean>`${reversal.id} is not null`,
      createdAt: allocations.createdAt,
    })
    .from(allocations)
    .leftJoin(taxDocuments, eq(taxDocuments.id, allocations.documentId))
    .leftJoin(refund, eq(refund.id, allocations.refundPaymentId))
    .leftJoin(source, eq(source.id, allocations.paymentId))
    .leftJoin(partyLedger, eq(partyLedger.id, allocations.partyLedgerId))
    .leftJoin(reversal, eq(reversal.reversesAllocationId, allocations.id))
    .where(
      payment.direction === 'in'
        ? eq(allocations.paymentId, payment.id)
        : eq(allocations.refundPaymentId, payment.id),
    )
    .orderBy(asc(allocations.createdAt), asc(allocations.id));
  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

/** The payment as the API returns it, with its mode, party and allocations. */
export async function paymentView(tx: Transaction, payment: PaymentRow): Promise<PaymentView> {
  const [details] = (await tx
    .select({ modeName: paymentModes.name, partyName: parties.displayName })
    .from(paymentModes)
    .innerJoin(parties, eq(parties.id, payment.partyId))
    .where(eq(paymentModes.id, payment.modeId))) as [{ modeName: string; partyName: string }];
  const rows = await allocationsOf(tx, payment);
  const allocated = rows.reduce((sum, row) => sum + row.amountPaise, 0);
  return {
    id: payment.id,
    number: payment.number,
    voucherNumber: payment.voucherNumber,
    direction: payment.direction,
    storeId: payment.storeId,
    partyId: payment.partyId,
    partyName: details.partyName,
    mode: { id: payment.modeId, kind: payment.modeKind, name: details.modeName },
    amountPaise: payment.amountPaise,
    tenderedPaise: payment.tenderedPaise,
    changePaise:
      payment.tenderedPaise === null ? null : payment.tenderedPaise - payment.amountPaise,
    receivedOn: payment.receivedOn,
    reference: payment.reference,
    chequeDate: payment.chequeDate,
    chequeStatus: payment.chequeStatus,
    chequeClearedOn: payment.chequeClearedOn,
    chequeBouncedOn: payment.chequeBouncedOn,
    bounceReason: payment.bounceReason,
    registerSessionId: payment.registerSessionId,
    gatewayReference: payment.gatewayReference,
    note: payment.note,
    unallocatedPaise:
      payment.direction === 'in' && payment.chequeStatus !== 'bounced'
        ? payment.amountPaise - allocated
        : 0,
    allocations: rows,
    createdByMemberId: payment.createdByMemberId,
    paymentLinkId: payment.paymentLinkId,
    createdAt: payment.createdAt.toISOString(),
  };
}

const RECEIPT_TITLES = {
  in: ['Payment receipt', 'Receipt voucher'],
  out: ['Refund', 'Refund voucher'],
} as const;

/** What a printed receipt or refund slip shows (2b renders it). */
export async function receiptView(tx: Transaction, payment: PaymentRow): Promise<ReceiptView> {
  const view = await paymentView(tx, payment);
  const [context] = (await tx
    .select({
      code: stores.code,
      storeName: stores.name,
      legalName: stores.legalName,
      tradeName: stores.tradeName,
      gstin: sql<
        string | null
      >`case when ${stores.registrationType} <> 'unregistered' then ${stores.gstin} end`,
      address: sql<
        string | null
      >`nullif(concat_ws(', ', ${stores.addressLine}, ${stores.city}, ${stores.state}, ${stores.pincode}), '')`,
      partyPhone: parties.phone,
      partyGstin: parties.gstin,
      balancePaise: sql<number>`coalesce(${partyBalances.balancePaise}, 0)`.mapWith(Number),
      // Null for money a gateway reported: no member took it.
      receivedBy: users.fullName,
    })
    .from(stores)
    .innerJoin(parties, eq(parties.id, payment.partyId))
    .leftJoin(partyBalances, eq(partyBalances.partyId, payment.partyId))
    .leftJoin(
      organizationMembers,
      sql`${organizationMembers.id} = ${payment.createdByMemberId}::uuid`,
    )
    .leftJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(stores.id, payment.storeId))) as [
    {
      code: string;
      storeName: string;
      legalName: string | null;
      tradeName: string | null;
      gstin: string | null;
      address: string | null;
      partyPhone: string | null;
      partyGstin: string | null;
      balancePaise: number;
      receivedBy: string | null;
    },
  ];
  return {
    title: RECEIPT_TITLES[payment.direction][payment.voucherNumber === null ? 0 : 1],
    number: payment.number,
    voucherNumber: payment.voucherNumber,
    direction: payment.direction,
    date: payment.receivedOn,
    store: {
      code: context.code,
      name: context.storeName,
      legalName: context.legalName,
      tradeName: context.tradeName,
      gstin: context.gstin,
      address: context.address,
    },
    party: {
      id: payment.partyId,
      name: view.partyName,
      phone: context.partyPhone,
      gstin: context.partyGstin,
    },
    mode: { kind: view.mode.kind, name: view.mode.name },
    amountPaise: payment.amountPaise,
    amountInWords: amountInWords(payment.amountPaise),
    tenderedPaise: view.tenderedPaise,
    changePaise: view.changePaise,
    reference: payment.reference,
    chequeDate: payment.chequeDate,
    chequeStatus: payment.chequeStatus,
    settled: view.allocations
      .filter((row) => payment.direction === 'in' && row.amountPaise > 0 && !row.reversed)
      .map((row) => ({ number: row.targetNumber, amountPaise: row.amountPaise })),
    unallocatedPaise: view.unallocatedPaise,
    partyBalancePaise: context.balancePaise,
    receivedBy: context.receivedBy,
    note: payment.note,
  };
}
