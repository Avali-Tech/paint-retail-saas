import {
  adjustPartyAdvance,
  enterTenantScope,
  schema,
  withTenant,
  type Database,
  type Transaction,
} from '@paint/db';
import {
  formatINR,
  refundRetryMinutes,
  type LinkRefundReason,
  type PaymentLinkRefundView,
} from '@paint/shared';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Notifier } from '../notifications/notifier.js';
import type { GatewayEventContext } from '../payments-gateway/gateway-events.js';
import { GatewayError } from '../payments-gateway/payment-gateway.js';
import {
  indiaToday,
  insertPayment,
  lockParty,
  receivePayment,
  unallocatedOf,
  type PaymentRow,
} from '../payments/posting.js';
import { linkStore, upiLinkMode } from './link-books.js';
import type { PaymentLinkGateways } from './payment-link-gateways.js';
import type { PaymentLinkEvent, PaymentLinkProvider } from './payment-link-provider.js';

const { allocations, parties, paymentLinkRefunds, paymentLinks, payments } = schema;

/*
 * Refunds through the gateway of money a link took that nothing was owed for (spec
 * §6.2 PL-15 – PL-18, [PO-44]). The payment is recorded first, as any link payment, its
 * unallocated part an advance; a refund row waits beside it. Each try asks the gateway
 * with the row's id as the receipt, so a try repeated after a crash never refunds twice;
 * once the gateway takes it, the refund is booked as MVP 2 refunds are (a refund payment
 * out of the link payment, its party ledger entry, a refund voucher where the advance
 * had a receipt voucher). A failed try leaves the money an advance, tells staff once and
 * is tried again later; after the last try it stays an advance for staff to refund by
 * hand or allocate. Money staff allocate or refund meanwhile drops the refund.
 */

type RefundRow = typeof paymentLinkRefunds.$inferSelect;
type LinkRow = typeof paymentLinks.$inferSelect;

/** What a refund try came to. */
export type RefundOutcome = 'refunded' | 'retrying' | 'failed' | 'dropped' | 'skipped';

/** Writes the refund a link payment needs, to be tried at once and again until it is done. */
export async function queueLinkRefund(
  tx: Transaction,
  refund: {
    readonly link: LinkRow;
    readonly paymentId: string;
    readonly gatewayPaymentId: string;
    readonly amountPaise: number;
    readonly reason: LinkRefundReason;
  },
): Promise<void> {
  await tx.insert(paymentLinkRefunds).values({
    organizationId: refund.link.organizationId,
    linkId: refund.link.id,
    partyId: refund.link.partyId,
    paymentId: refund.paymentId,
    gatewayPaymentId: refund.gatewayPaymentId,
    amountPaise: refund.amountPaise,
    reason: refund.reason,
    provider: refund.link.provider,
  });
}

/** The refund-staff notice (`payment_link_refund`) to who takes payments at the link's store. */
async function tellStaff(
  tx: Transaction,
  notifier: Notifier,
  link: LinkRow,
  title: string,
  body: string,
  paymentId: string,
): Promise<void> {
  const [party] = (await tx
    .select({ name: parties.displayName })
    .from(parties)
    .where(eq(parties.id, link.partyId))) as [{ name: string }];
  await notifier.notify(tx, {
    organizationId: link.organizationId,
    event: 'payment_link_refund',
    to: { storeId: link.storeId, permission: 'payments:manage' },
    title: `${title}: ${party.name}`,
    body,
    link: `/payments/${paymentId}`,
  });
}

const WHY: Readonly<Record<LinkRefundReason, string>> = {
  settled: 'its bills were already settled',
  overpaid: 'it was more than the bills owed',
};

/** The code of a failed try, safe to keep: the gateway's error code, never its text. */
const failureCode = (error: unknown) =>
  error instanceof GatewayError ? error.code.slice(0, 200) : 'error';

/**
 * One try of a waiting refund, in the business's tenant transaction, the party then the
 * refund locked (two servers never try one refund at once). `provider` is the business's
 * gateway now, or null when it is not connected (a failed try).
 */
export async function attemptLinkRefund(
  tx: Transaction,
  refundId: string,
  provider: PaymentLinkProvider | null,
  notifier: Notifier,
): Promise<RefundOutcome> {
  const [found] = await tx
    .select({
      partyId: paymentLinkRefunds.partyId,
      organizationId: paymentLinkRefunds.organizationId,
    })
    .from(paymentLinkRefunds)
    .where(eq(paymentLinkRefunds.id, refundId));
  if (!found) return 'skipped';
  await lockParty(tx, found.organizationId, found.partyId);
  const [refund] = (await tx
    .select()
    .from(paymentLinkRefunds)
    .where(eq(paymentLinkRefunds.id, refundId))
    .for('update')) as [RefundRow];
  if (refund.status !== 'pending') return 'skipped';
  const [link] = (await tx
    .select()
    .from(paymentLinks)
    .where(eq(paymentLinks.id, refund.linkId))) as [LinkRow];
  const [source] = (await tx.select().from(payments).where(eq(payments.id, refund.paymentId))) as [
    PaymentRow,
  ];

  // Staff allocated or refunded the money meanwhile: it is theirs to handle now.
  if ((await unallocatedOf(tx, source)) < refund.amountPaise) {
    await tx
      .update(paymentLinkRefunds)
      .set({ status: 'dropped', lastError: 'used_meanwhile', updatedAt: sql`now()` })
      .where(eq(paymentLinkRefunds.id, refund.id));
    return 'dropped';
  }

  let taken: { gatewayRefundId: string; status: string };
  try {
    if (provider?.name !== refund.provider) {
      throw new GatewayError('The gateway account is not connected', {
        code: 'gateway_not_connected',
      });
    }
    taken = await provider.refundPayment({
      gatewayPaymentId: refund.gatewayPaymentId,
      amountPaise: refund.amountPaise,
      receipt: refund.id,
      notes: { link: link.number, reason: refund.reason },
    });
  } catch (error) {
    return failedTry(tx, notifier, link, refund, failureCode(error));
  }

  const row = await insertPayment(
    tx,
    { organization: { id: refund.organizationId }, memberId: null },
    {
      store: await linkStore(tx, link.storeId),
      partyId: refund.partyId,
      mode: await upiLinkMode(tx, refund.organizationId),
      direction: 'out',
      details: {
        amountPaise: refund.amountPaise,
        reference: taken.gatewayRefundId.slice(0, 100),
        gatewayReference: taken.gatewayRefundId,
        note: `Refunded through the gateway for UPI link ${link.number}`,
      },
      receivedOn: await today(tx),
      registerSessionId: null,
      // Paying back an advance that had a receipt voucher needs a refund voucher (Rule 51).
      voucherKind: source.voucherNumber === null ? null : 'refund_voucher',
      paymentLinkId: link.id,
    },
  );
  await tx.insert(allocations).values({
    organizationId: refund.organizationId,
    partyId: refund.partyId,
    paymentId: source.id,
    refundPaymentId: row.id,
    amountPaise: refund.amountPaise,
    createdByMemberId: null,
  });
  await adjustPartyAdvance(tx, refund.partyId, -refund.amountPaise);
  await tx
    .update(paymentLinkRefunds)
    .set({
      status: 'refunded',
      gatewayRefundId: taken.gatewayRefundId,
      gatewayStatus: taken.status.slice(0, 40),
      refundPaymentId: row.id,
      refundedAt: sql`now()`,
      lastError: null,
      updatedAt: sql`now()`,
    })
    .where(eq(paymentLinkRefunds.id, refund.id));
  await tellStaff(
    tx,
    notifier,
    link,
    'Refunded through the gateway',
    `${formatINR(refund.amountPaise)} paid by ${link.number} went back to the customer, as ${WHY[refund.reason]}: ${row.number}.`,
    row.id,
  );
  return 'refunded';
}

async function today(tx: Transaction): Promise<string> {
  const [row] = (await tx.execute<{ day: string }>(sql`select ${indiaToday} as day`)).rows as [
    { day: string },
  ];
  return row.day;
}

/**
 * A try that failed (rule PL-16): the money stays an advance; staff are told the first
 * time, and again when the tries are used up and the refund is given up.
 */
async function failedTry(
  tx: Transaction,
  notifier: Notifier,
  link: LinkRow,
  refund: RefundRow,
  code: string,
): Promise<RefundOutcome> {
  const attempts = refund.attempts + 1;
  const retryIn = refundRetryMinutes(attempts);
  await tx
    .update(paymentLinkRefunds)
    .set({
      attempts,
      lastError: code,
      status: retryIn === null ? 'failed' : 'pending',
      ...(retryIn === null
        ? {}
        : { nextAttemptAt: sql`now() + make_interval(mins => ${retryIn})` }),
      ...(refund.flaggedAt === null ? { flaggedAt: sql`now()` } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(paymentLinkRefunds.id, refund.id));
  const amount = formatINR(refund.amountPaise);
  if (retryIn === null) {
    await tellStaff(
      tx,
      notifier,
      link,
      'Refund given up, kept as an advance',
      `${amount} paid by ${link.number} could not be refunded after ${String(attempts)} tries (${code}). It stays an advance: refund it by hand or allocate it.`,
      refund.paymentId,
    );
    return 'failed';
  }
  if (refund.flaggedAt === null) {
    await tellStaff(
      tx,
      notifier,
      link,
      'Refund failed, kept as an advance',
      `${amount} paid by ${link.number} could not be refunded yet (${code}). It is kept as an advance and tried again.`,
      refund.paymentId,
    );
  }
  return 'retrying';
}

/**
 * Tries every refund that is due (all businesses, or one), each in its own tenant
 * transaction with the business's gateway of the moment. Safe on several servers: a
 * refund another server is trying is skipped. Answers how many were refunded.
 */
export async function runDueLinkRefunds(
  db: Database,
  gateways: PaymentLinkGateways,
  notifier: Notifier,
  only: { readonly organizationId?: string } = {},
): Promise<number> {
  const due = await db
    .select({ id: paymentLinkRefunds.id, organizationId: paymentLinkRefunds.organizationId })
    .from(paymentLinkRefunds)
    .where(
      and(
        eq(paymentLinkRefunds.status, 'pending'),
        lte(paymentLinkRefunds.nextAttemptAt, sql`now()`),
        only.organizationId === undefined
          ? undefined
          : eq(paymentLinkRefunds.organizationId, only.organizationId),
      ),
    )
    .orderBy(asc(paymentLinkRefunds.nextAttemptAt), asc(paymentLinkRefunds.id))
    .limit(50);
  let refunded = 0;
  for (const refund of due) {
    const outcome = await withTenant(db, refund.organizationId, async (tx) =>
      attemptLinkRefund(
        tx,
        refund.id,
        await gateways.forBusiness(tx, refund.organizationId),
        notifier,
      ),
    );
    if (outcome === 'refunded') refunded += 1;
  }
  return refunded;
}

/**
 * The gateway's news of a refund it took (rule PL-17): processed is noted; failed sends
 * the money back into the books as an advance (money in, by the UPI link mode) and a
 * new refund tries again, unless the tries are used up. A refund the books do not have
 * yet (its try is still being written) is ignored: that try books it.
 */
export async function applyRefundEvent(
  tx: Transaction,
  event: Extract<PaymentLinkEvent, { kind: 'refund_processed' | 'refund_failed' }>,
  context: GatewayEventContext,
  deps: {
    readonly provider: PaymentLinkProvider;
    readonly notifier: Notifier;
    readonly organizationId: string | null;
  },
): Promise<'applied' | 'ignored'> {
  const [found] = await tx
    .select({ id: paymentLinkRefunds.id, organizationId: paymentLinkRefunds.organizationId })
    .from(paymentLinkRefunds)
    .where(
      and(
        eq(paymentLinkRefunds.provider, deps.provider.name),
        eq(paymentLinkRefunds.gatewayRefundId, event.refund.id),
      ),
    );
  if (!found || (deps.organizationId !== null && found.organizationId !== deps.organizationId)) {
    return 'ignored';
  }
  await context.attach(found.organizationId);
  await enterTenantScope(tx, found.organizationId);
  const [{ partyId }] = (await tx
    .select({ partyId: paymentLinkRefunds.partyId })
    .from(paymentLinkRefunds)
    .where(eq(paymentLinkRefunds.id, found.id))) as [{ partyId: string }];
  await lockParty(tx, found.organizationId, partyId);
  const [refund] = (await tx
    .select()
    .from(paymentLinkRefunds)
    .where(eq(paymentLinkRefunds.id, found.id))
    .for('update')) as [RefundRow];
  if (refund.status !== 'refunded') return 'ignored';
  if (event.kind === 'refund_processed') {
    if (refund.gatewayStatus === 'processed') return 'ignored';
    await tx
      .update(paymentLinkRefunds)
      .set({ gatewayStatus: 'processed', updatedAt: sql`now()` })
      .where(eq(paymentLinkRefunds.id, refund.id));
    return 'applied';
  }
  await returnRefund(tx, deps.notifier, refund);
  return 'applied';
}

/** A refund the gateway failed after taking it: the money is back, an advance once more. */
async function returnRefund(tx: Transaction, notifier: Notifier, refund: RefundRow): Promise<void> {
  const [link] = (await tx
    .select()
    .from(paymentLinks)
    .where(eq(paymentLinks.id, refund.linkId))) as [LinkRow];
  const [refundPayment] = (await tx
    .select({ number: payments.number })
    .from(payments)
    .where(eq(payments.id, String(refund.refundPaymentId)))) as [{ number: string }];
  const back = await receivePayment(
    tx,
    { organization: { id: refund.organizationId }, memberId: null },
    {
      store: await linkStore(tx, link.storeId),
      partyId: refund.partyId,
      mode: await upiLinkMode(tx, refund.organizationId),
      details: {
        amountPaise: refund.amountPaise,
        reference: String(refund.gatewayRefundId).slice(0, 100),
        gatewayReference: `${String(refund.gatewayRefundId)}/returned`,
        note: `Refund ${refundPayment.number} for UPI link ${link.number} failed at the gateway`,
      },
      receivedOn: await today(tx),
      registerSessionId: null,
      paymentLinkId: link.id,
    },
    [],
  );
  await tx
    .update(paymentLinkRefunds)
    .set({
      status: 'returned',
      gatewayStatus: 'failed',
      returnedPaymentId: back.id,
      updatedAt: sql`now()`,
    })
    .where(eq(paymentLinkRefunds.id, refund.id));
  // Another try of the same refund, counting this failure among its tries.
  const attempts = refund.attempts + 1;
  const retryIn = refundRetryMinutes(attempts);
  await tx.insert(paymentLinkRefunds).values({
    organizationId: refund.organizationId,
    linkId: refund.linkId,
    partyId: refund.partyId,
    paymentId: back.id,
    gatewayPaymentId: refund.gatewayPaymentId,
    amountPaise: refund.amountPaise,
    reason: refund.reason,
    provider: refund.provider,
    status: retryIn === null ? 'failed' : 'pending',
    retryOfId: refund.id,
    attempts,
    lastError: 'refund_failed',
    flaggedAt: sql`now()`,
    ...(retryIn === null ? {} : { nextAttemptAt: sql`now() + make_interval(mins => ${retryIn})` }),
  });
  await tellStaff(
    tx,
    notifier,
    link,
    'Refund failed at the gateway, kept as an advance',
    `${formatINR(refund.amountPaise)} refunded by ${refundPayment.number} for ${link.number} came back: ${back.number} keeps it as an advance.${retryIn === null ? ' Refund it by hand or allocate it.' : ' It is tried again.'}`,
    back.id,
  );
}

/** The refund columns of a link summary: refunded, still to refund, and whether one failed. */
export const refundSummaryColumns = {
  refundedPaise: sql<number>`coalesce((select sum(r.amount_paise) from payment_link_refunds r
    where r.link_id = ${paymentLinks.id} and r.status = 'refunded'), 0)`.mapWith(Number),
  refundPendingPaise: sql<number>`coalesce((select sum(r.amount_paise) from payment_link_refunds r
    where r.link_id = ${paymentLinks.id} and r.status in ('pending', 'failed')), 0)`.mapWith(
    Number,
  ),
  refundFailed: sql<boolean>`exists (select 1 from payment_link_refunds r
    where r.link_id = ${paymentLinks.id} and r.status in ('pending', 'failed') and r.flagged_at is not null)`,
};

/** A link's refunds, oldest first. */
export async function refundViews(
  tx: Transaction,
  linkId: string,
): Promise<PaymentLinkRefundView[]> {
  const rows = await tx
    .select({
      id: paymentLinkRefunds.id,
      amountPaise: paymentLinkRefunds.amountPaise,
      reason: paymentLinkRefunds.reason,
      status: paymentLinkRefunds.status,
      refundPaymentId: paymentLinkRefunds.refundPaymentId,
      refundPaymentNumber: payments.number,
      gatewayRefundId: paymentLinkRefunds.gatewayRefundId,
      gatewayStatus: paymentLinkRefunds.gatewayStatus,
      attempts: paymentLinkRefunds.attempts,
      lastError: paymentLinkRefunds.lastError,
      createdAt: paymentLinkRefunds.createdAt,
      refundedAt: paymentLinkRefunds.refundedAt,
    })
    .from(paymentLinkRefunds)
    .leftJoin(payments, eq(payments.id, paymentLinkRefunds.refundPaymentId))
    .where(eq(paymentLinkRefunds.linkId, linkId))
    .orderBy(asc(paymentLinkRefunds.createdAt), asc(paymentLinkRefunds.id));
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    refundedAt: row.refundedAt?.toISOString() ?? null,
  }));
}
